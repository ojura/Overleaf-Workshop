/* eslint-disable @typescript-eslint/naming-convention -- executes the module's CommonJS export names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as vm from 'vm';
import type { PdfViewState } from '../core/pdfViewState';
import type { SavedState } from '../core/viewerProtocol';
import { PDF_VIEWER_POLICY } from '../core/pdfViewerPolicy';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const viewState = (page: number, scale = '1'): SavedState => ({
    position: { page, offset: { top: 12, left: 5 }, pageSize: { width: 600, height: 800 } }, scale,
});

function fixture() {
    let timerId = 0;
    const timers = new Map<number, { callback: () => void; delay: number }>();
    const module = { exports: {} as { PdfViewState: typeof PdfViewState } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../core/pdfViewState'), 'utf8'), {
        module, exports: module.exports,
        require(id: string) { assert.strictEqual(id, './pdfViewerPolicy'); return { PDF_VIEWER_POLICY }; },
        setTimeout(callback: () => void, delay: number) {
            const id = ++timerId; timers.set(id, { callback, delay });
            return { id, unref() {} };
        },
        clearTimeout(timer: { id: number }) { timers.delete(timer.id); },
    });
    const durable = new Map<string, SavedState>(), failures: unknown[] = [];
    const writes: { uri: string; state: SavedState; finish(): void; fail(error: unknown): void }[] = [];
    const waiting: (() => void)[] = [];
    const owner = new module.exports.PdfViewState({
        read: uri => durable.get(uri),
        write(uri, state) {
            return new Promise<void>((resolve, reject) => {
                const saved = copy(state);
                writes.push({ uri, state: saved, finish() { durable.set(uri, saved); resolve(); }, fail: reject });
                waiting.splice(0).forEach(ready => ready());
            });
        },
        failed: error => { failures.push(error); },
    });
    return { owner, timers, durable, writes, failures,
        nextWrite: () => new Promise<void>(resolve => waiting.push(resolve)),
        expire() {
            assert.strictEqual(timers.size, 1);
            const [id, timer] = [...timers][0]; timers.delete(id); timer.callback();
        },
    };
}

describe('durable PDF reading state', () => {
    it('coalesces received state and orders a final disposal write after pending storage', async () => {
        const f = fixture(), uri = 'file:///reading.pdf';
        f.owner.save(uri, viewState(1));
        f.owner.save(uri, viewState(3, '2'));
        assert.strictEqual(f.timers.size, 1);
        assert.strictEqual([...f.timers.values()][0].delay, PDF_VIEWER_POLICY.stateWriteDelayMs);
        const firstStarted = f.nextWrite(); f.expire(); await firstStarted;
        assert.deepStrictEqual(f.writes[0].state, viewState(3, '2'));
        const final = viewState(8, '3');
        f.owner.save(uri, final);
        const disposed = f.owner.dispose();
        assert.strictEqual(f.timers.size, 0);
        f.owner.save(uri, viewState(99));
        assert.deepStrictEqual(copy(f.owner.read(uri)), final);
        assert.strictEqual(f.writes.length, 1);
        const finalStarted = f.nextWrite(); f.writes[0].finish(); await finalStarted;
        assert.deepStrictEqual(copy(f.owner.read(uri)), final);
        f.writes[1].finish(); await disposed;
        assert.deepStrictEqual(f.durable.get(uri), final);
        assert.strictEqual(f.timers.size, 0);
    });

    it('retains a rejected final state for an explicit retry without an idle retry timer', async () => {
        const f = fixture(), uri = 'file:///failure.pdf', final = viewState(6, '1.5');
        f.owner.save(uri, final);
        const started = f.nextWrite(), disposed = f.owner.dispose(); await started;
        const failure = new Error('storage unavailable'); f.writes[0].fail(failure); await disposed;
        assert.deepStrictEqual(f.failures, [failure]);
        assert.deepStrictEqual(copy(f.owner.read(uri)), final);
        assert.strictEqual(f.timers.size, 0);
        assert.strictEqual(f.writes.length, 1);
        const retryStarted = f.nextWrite(), retry = f.owner.flush(); await retryStarted;
        f.writes[1].finish(); await retry;
        assert.deepStrictEqual(f.durable.get(uri), final);
        assert.strictEqual(f.timers.size, 0);
    });

    it('keeps a newer snapshot when an older write fails and copies mutable position fields', async () => {
        const f = fixture(), uri = 'file:///newer.pdf';
        const first = { position: { page: 2, offset: { top: 10, left: 4 }, pageSize: { width: 100, height: 200 } } };
        f.owner.save(uri, first);
        first.position.offset.top = 99; first.position.pageSize.width = 999;
        const firstStarted = f.nextWrite(), firstFlush = f.owner.flush(); await firstStarted;
        assert.strictEqual(f.writes[0].state.position!.offset!.top, 10);
        assert.strictEqual(f.writes[0].state.position!.pageSize!.width, 100);
        const final = viewState(7); f.owner.save(uri, final);
        const finalFlush = f.owner.dispose(), finalStarted = f.nextWrite();
        f.writes[0].fail(new Error('older update failed')); await firstFlush; await finalStarted;
        assert.deepStrictEqual(copy(f.owner.read(uri)), final);
        f.writes[1].finish(); await finalFlush;
        await f.owner.flush();
        assert.strictEqual(f.writes.length, 2, 'failure must not enqueue the obsolete snapshot again');
        assert.deepStrictEqual(f.durable.get(uri), final);
        assert.strictEqual(f.timers.size, 0);
    });
});
