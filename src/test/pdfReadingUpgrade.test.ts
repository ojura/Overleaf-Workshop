import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
};

describe('source-bound reading representation preparation', function () {
    this.timeout(10_000);
    let directory: string, prepare: (candidate: any, viewer: any, signal: AbortSignal) => Promise<void>;
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-reading-upgrade-'));
        const output = path.join(directory, 'upgrade.mjs');
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/pdf-reading-upgrade.ts')],
                outfile: output, bundle: true, format: 'esm', platform: 'browser' });
        } finally { await esbuild.stop(); }
        prepare = (await importModule(output)).preparePdfReadingUpgrade;
    });
    after(() => {
        if (saved) { Object.defineProperty(globalThis, 'document', saved); } else { delete (globalThis as any).document; }
        fs.rmSync(directory, { recursive: true, force: true });
    });

    function fixture(ids = [1]) {
        const listeners = new Map<string, Set<(event: any) => void>>();
        const canvases: any[] = [], started: number[] = [];
        const pages = new Map<number, any>();
        const document: any = { hidden: false,
            addEventListener(name: string, listener: (event: any) => void) {
                if (!listeners.has(name)) { listeners.set(name, new Set()); } listeners.get(name)!.add(listener);
            },
            removeEventListener(name: string, listener: (event: any) => void) { listeners.get(name)?.delete(listener); },
            createElement(name: string) {
                assert.strictEqual(name, 'canvas');
                const canvas = { width: 0, height: 0, getContext: () => ({}) }; canvases.push(canvas); return canvas;
            },
        };
        Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
        const old = { original: true };
        const originalContent = Promise.resolve({ original: true });
        const view = { viewport: { width: 1600, height: 1200, scale: 2, rotation: 90 }, outputScale: { sx: 1.5, sy: 1.5 },
            _getRenderingContext(canvasContext: any, transform: any) { return { canvasContext, transform, viewport: this.viewport,
                annotationMode: 2, isEditing: true, optionalContentConfigPromise: originalContent, annotationCanvasMap: new Map(),
                pageColors: { foreground: '#000', background: '#fff' } }; } };
        const viewer = { pdfDocument: old, currentPageNumber: 1, pagesRotation: 90,
            _getVisiblePages: () => ({ views: ids.map(id => ({ id })) }), getPageView: () => view };
        const candidate = { hasExternalImages: true, numPages: 3, async getPage(id: number) {
            started.push(id);
            if (!pages.has(id)) {
                const coverage = deferred<void>(), waiting = deferred<void>();
                const page: any = { coverage, waiting, renders: [], renderFinished: false, cancels: 0, cleanups: 0, taskCancels: 0,
                    getViewport({ scale, rotation }: any) { assert.strictEqual(rotation, 90); return { width: 800 * scale, height: 600 * scale, scale, rotation }; },
                    render(parameters: any) {
                        page.renders.push(parameters);
                        return { promise: Promise.resolve().then(() => { page.renderFinished = true; }), cancel() { page.taskCancels++; } };
                    },
                    waitForImages({ final, signal }: any) {
                        assert.strictEqual(page.renderFinished, true); assert.strictEqual(final, false); assert.strictEqual(signal.aborted, false);
                        waiting.resolve(); return coverage.promise;
                    },
                    cancelImageRefinement() { page.cancels++; return page.cancelGate?.promise ?? Promise.resolve(); },
                    cleanup() { page.cleanups++; },
                };
                pages.set(id, page);
            }
            return pages.get(id);
        } };
        const abort = new AbortController();
        const running = prepare(candidate, viewer, abort.signal);
        const pageReady = async (id: number) => {
            // getPage installs its object synchronously before its promise continuation.
            const page = pages.get(id);
            if (page) { await page.waiting.promise; return page; }
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.ok(pages.has(id), 'the expected native page preparation began');
            await pages.get(id).waiting.promise; return pages.get(id);
        };
        return { viewer, view, old, candidate, abort, running, pages, started, canvases, document, listeners, pageReady,
            visible(next: number[]) { ids = next; },
            emit(name: string, value: any = {}) { for (const listener of [...listeners.get(name) ?? []]) { listener(value); } },
            assertReleased() { assert.ok([...listeners.values()].every(set => set.size === 0));
                assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)); },
        };
    }

    it('keeps the old reader through every visible page coverage boundary without retaining preparation bitmaps', async () => {
        const f = fixture([1, 2]);
        const first = await f.pageReady(1);
        assert.strictEqual(f.viewer.pdfDocument, f.old);
        assert.deepStrictEqual(f.started, [1]);
        first.coverage.resolve();
        const second = await f.pageReady(2);
        assert.strictEqual(f.viewer.pdfDocument, f.old);
        second.coverage.resolve();
        await f.running;
        assert.deepStrictEqual(f.started, [1, 2]);
        assert.strictEqual(first.cancels + second.cancels, 0, 'ready candidate images transfer to the actual document owner');
        f.assertReleased();
    });

    it('prepares the adopting viewport, density and annotation intent on a clipped tiny canvas', async () => {
        const f = fixture(), first = await f.pageReady(1);
        try {
            const input = first.renders[0];
            assert.deepStrictEqual(input.viewport, f.view.viewport);
            assert.deepStrictEqual(input.transform, [1.5, 0, 0, 1.5, 0, 0]);
            assert.strictEqual(input.imageDecodeScale, 3);
            assert.strictEqual(input.imageDecodeMaxDimension, 2400);
            assert.strictEqual(input.annotationMode, 2);
            assert.strictEqual(input.isEditing, true);
            assert.strictEqual(input.optionalContentConfigPromise, undefined, 'candidate defaults cannot use another document\'s configuration owner');
            assert.strictEqual(input.annotationCanvasMap, undefined, 'offscreen preparation cannot repaint the old annotation canvases');
            assert.deepStrictEqual(f.canvases.map(canvas => [canvas.width, canvas.height]), [[2, 2]]);
        } finally { first.coverage.resolve(); await f.running; f.assertReleased(); }
    });

    it('rechecks the same visible page intent after coverage and awaits the superseded intent release', async () => {
        const f = fixture(), first = await f.pageReady(1);
        first.cancelGate = deferred<void>();
        f.view.viewport = { width: 2400, height: 1800, scale: 3, rotation: 90 };
        first.coverage.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        try {
            assert.strictEqual(first.cancels, 1, 'the old density cannot authorize adoption at the new zoom');
            assert.strictEqual(first.renders.length, 1, 'the replacement waits for the worker cancellation acknowledgment');
        } finally { first.cancelGate.resolve(); await f.running; }
        assert.strictEqual(first.renders.length, 2);
        assert.strictEqual(first.renders[1].imageDecodeScale, 4.5);
        assert.strictEqual(first.renders[1].imageDecodeMaxDimension, 3600);
        assert.strictEqual(f.viewer.pdfDocument, f.old);
        f.assertReleased();
    });

    it('awaits cancellation of an obsolete prepared page before admitting the new visible page', async () => {
        const f = fixture();
        const first = await f.pageReady(1);
        first.cancelGate = deferred<void>();
        f.visible([2]); first.coverage.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepStrictEqual(f.started, [1]); assert.strictEqual(first.cancels, 1);
        first.cancelGate.resolve();
        const second = await f.pageReady(2); second.coverage.resolve(); await f.running;
        assert.deepStrictEqual(f.started, [1, 2]); assert.strictEqual(first.cleanups, 1);
        f.assertReleased();
    });

    it('releases the candidate and listeners on parent cancellation, trusted input and hiding while preserving the old reader', async () => {
        for (const reason of ['abort', 'input', 'hidden']) {
            const f = fixture(), page = await f.pageReady(1);
            const stopped = assert.rejects(f.running, { name: 'AbortError' });
            if (reason === 'abort') { f.abort.abort(); }
            if (reason === 'input') { f.emit('wheel', { isTrusted: false }); assert.strictEqual(page.taskCancels, 0); f.emit('wheel', { isTrusted: true }); }
            if (reason === 'hidden') { f.document.hidden = true; f.emit('visibilitychange'); }
            await stopped;
            assert.strictEqual(f.viewer.pdfDocument, f.old);
            assert.strictEqual(page.cancels, 1); assert.strictEqual(page.cleanups, 1);
            f.assertReleased();
        }
    });
});
