import * as assert from 'assert';
import * as path from 'path';
import * as vm from 'vm';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('shared PDF page operation lifetime', () => {
    let source: string;
    before(async () => {
        const esbuild = await importModule('esbuild');
        try {
            const result = await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/document-lifecycle.ts')],
                bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2020', logLevel: 'silent' });
            source = result.outputFiles[0].text;
        } finally { await esbuild.stop(); }
    });

    function fixture() {
        let id = 0;
        const timers = new Map<number, { callback: () => void, delay: number }>();
        const module = { exports: {} as any };
        vm.runInNewContext(source, { module, exports: module.exports,
            setTimeout(callback: () => void, delay: number) { timers.set(++id, { callback, delay }); return id; },
            clearTimeout(key: number) { timers.delete(key); },
        });
        return { ...module.exports, timers, expire() {
            assert.strictEqual(timers.size, 1);
            const [key, value] = [...timers][0]; timers.delete(key); value.callback();
        } };
    }

    it('clears its destruction bound on success and on synchronous or asynchronous failure', async () => {
        const f = fixture(), failure = new Error('destroy failed');
        await f.waitForDocumentOperation(() => Promise.resolve());
        assert.strictEqual(f.timers.size, 0);
        await assert.rejects(f.waitForDocumentOperation(() => { throw failure; }), (error: unknown) => error === failure);
        assert.strictEqual(f.timers.size, 0);
        await assert.rejects(f.waitForDocumentOperation(() => Promise.reject(failure)), (error: unknown) => error === failure);
        assert.strictEqual(f.timers.size, 0);
    });

    it('uses one last-resort bound for an unresponsive worker and consumes a late rejection', async () => {
        const f = fixture();
        let reject!: (error: unknown) => void;
        const pending = new Promise((_resolve, no) => { reject = no; });
        const close = f.waitForDocumentOperation(() => pending);
        assert.strictEqual([...f.timers.values()][0].delay, 10_000);
        f.expire(); await close;
        reject(new Error('late worker reply')); await Promise.resolve();
        assert.strictEqual(f.timers.size, 0);
    });

    it('releases abort listeners on fulfillment, cancellation and late failure', async () => {
        const f = fixture(), controller = new AbortController(), signal = controller.signal;
        const listeners = new Set<any>(), add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
        signal.addEventListener = ((name: string, listener: any, options: any) => { listeners.add(listener); add(name, listener, options); }) as any;
        signal.removeEventListener = ((name: string, listener: any) => { listeners.delete(listener); remove(name, listener); }) as any;
        assert.strictEqual(await f.untilAborted(signal, Promise.resolve(7)), 7);
        assert.strictEqual(listeners.size, 0);
        let reject!: (error: unknown) => void;
        const pending = f.untilAborted(signal, new Promise((_resolve, no) => { reject = no; }));
        assert.strictEqual(listeners.size, 1);
        controller.abort();
        assert.strictEqual(await pending, undefined);
        reject(new Error('late work rejection')); await Promise.resolve();
        assert.strictEqual(listeners.size, 0);
        assert.strictEqual(await f.untilAborted(signal, Promise.resolve(9)), undefined);
        assert.strictEqual(listeners.size, 0);
    });
});
