/* eslint-disable @typescript-eslint/naming-convention -- pdf.js's export names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// tsc turns import() into require(), which cannot load ES modules
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

/**
 * The Overleaf viewer's documents (views/pdf-viewer/src/overleaf/documents.ts), bundled as the
 * viewer bundles them and run in Node, with stand-ins for pdf.js, its worker and PDFJSWrapper.
 */
describe('the Overleaf viewer\'s documents', function () {
    this.timeout(30 * 1000);
    const saved: Record<string, PropertyDescriptor | undefined> = {};
    const globals: Record<string, unknown> = {};
    let dir: string;
    let viewer: any;

    /** a loading task as pdf.js makes one; destroy() notes whether the task's range requests were aborted by then */
    interface FakeTask { promise: Promise<any>, destroy(): Promise<void>, requests?: AbortController, abortedAtDestroy?: boolean }
    const tasks: FakeTask[] = [];
    function fakeTask(): FakeTask {
        const task: FakeTask = {
            promise: Promise.resolve(undefined),
            destroy() {
                task.abortedAtDestroy = task.requests?.signal.aborted;
                return Promise.resolve();
            },
        };
        task.promise = Promise.resolve({ loadingTask: task });
        tasks.push(task);
        return task;
    }
    class FakeWorker {
        static made: FakeWorker[] = [];
        terminated = false;
        private onTerminated!: () => void;
        /** settles when the page stops this worker */
        readonly stopped = new Promise<void>(resolve => { this.onTerminated = resolve; });
        constructor() { FakeWorker.made.push(this); }
        terminate() { this.terminated = true; this.onTerminated(); }
    }

    before(async () => {
        const config = { engine: 'overleaf', pdfjs: { build: 'https://webview.test/b/', cMapUrl: '', standardFontDataUrl: '', wasmUrl: '', iccUrl: '', imageResourcesPath: '' } };
        Object.assign(globals, {
            window: { addEventListener() {} },
            location: new URL('https://webview.test/index.html'),
            document: { getElementById: (id: string) => id === 'viewer-config' ? { textContent: JSON.stringify(config) } : null },
            acquireVsCodeApi: () => ({ postMessage() {}, getState() { return undefined; }, setState() {} }),
            Worker: FakeWorker,
            // pdf.worker.mjs, which the page starts from a blob
            fetch: async () => new (globalThis as any).Response('// pdf.worker.mjs'),
            // a PDF read whole
            pdfjsLib: { GlobalWorkerOptions: {}, getDocument: () => fakeTask() },
        });
        for (const [name, value] of Object.entries(globals)) {
            saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }

        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-documents-'));
        const entry = path.join(dir, 'entry.ts');
        fs.writeFileSync(entry, [
            `export { Documents } from ${JSON.stringify(path.join(viewerRoot, 'src', 'overleaf', 'documents.ts'))};`,
            `export { loadingTasks } from ${JSON.stringify(path.join(viewerRoot, 'src', 'shims', 'pdf-js.ts'))};`,
        ].join('\n'));
        await esbuild.build({ ...bundleOptions, entryPoints: [entry], outfile: path.join(dir, 'documents.mjs') });
        // esbuild's service process is not needed any more; another build starts it again
        await esbuild.stop();
        viewer = await importModule(path.join(dir, 'documents.mjs'));
    });

    after(() => {
        for (const name of Object.keys(globals)) {
            if (saved[name]) { Object.defineProperty(globalThis, name, saved[name]!); } else { delete (globalThis as any)[name]; }
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('aborts the range requests of a document it replaces before pdf.js destroys it', async () => {
        const pdfViewer = { getBoundingClientRect: () => ({ height: 0 }), style: {} };
        const wrapper = {
            container: { querySelector: () => pdfViewer },
            viewer: { setDocument() {}, linkService: { setDocument() {} } },
            eventBus: { on() {}, off() {} },
            // as PDFJSWrapper.loadDocument: a task whose range transport stops its requests with abortController
            loadDocument: ({ abortController }: { abortController: AbortController }) => {
                const task = fakeTask();
                task.requests = abortController;
                viewer.loadingTasks.add(task);
                return task.promise;
            },
        };
        const errors: unknown[] = [];
        let shown: (() => void) | undefined;
        const hooks = { beforeLoad() {}, loaded: () => shown?.(), failed: (error: unknown) => errors.push(error), fetchFailed: (error: unknown) => errors.push(error) };
        const next = () => new Promise<void>(resolve => { shown = resolve; });
        const documents = new viewer.Documents(wrapper, hooks);

        let loaded = next();
        documents.load({
            url: 'https://dl.test/zone/d/project/p1/user/u1/build/b1-x/output/output.pdf?enable_pdf_caching=true',
            downloadDomain: 'https://dl.test/zone/d',
            projectId: 'p1',
            file: { path: 'output.pdf', url: '/project/p1/user/u1/build/b1-x/output/output.pdf', type: 'pdf', build: 'b1-x', size: 1000 },
        });
        await loaded;
        const inRanges = tasks.at(-1)!;
        // the load is over; the document shown keeps its requests, which pdf.js makes as it reads on
        await documents.settled;
        assert.strictEqual(documents.loading, false);
        assert.strictEqual(inRanges.requests?.signal.aborted, false);

        // the host sends a PDF whole, which replaces the build in ranges
        loaded = next();
        documents.loadData(new ArrayBuffer(8));
        await loaded;
        assert.strictEqual(inRanges.abortedAtDestroy, true, 'its range requests were aborted before its task was destroyed');
        // its worker stops once its destroy has settled
        await FakeWorker.made[0].stopped;
        assert.deepStrictEqual(FakeWorker.made.map(w => w.terminated), [true, false], 'its worker is stopped, the new document\'s runs');
        assert.deepStrictEqual(errors, []);
    });
});
