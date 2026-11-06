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
    let fullAppEntry: string, fullAppSequence = 0;
    const planned: FakeTask[] = [];
    const rangeRequests = new Map<string, AbortController>();
    const transitionResults: Promise<void>[] = [];
    const destroyTimers = new Set<ReturnType<typeof setTimeout>>();
    const nativeTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    let savedWarn: typeof console.warn, savedError: typeof console.error;
    let readingEnvironment: any;

    function deferred<T>() {
        let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
        const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
        return { promise, resolve, reject };
    }
    // A native view-transition callback runs in a later turn, after proxy continuations have drained.
    const endTurn = () => new Promise<void>(resolve => setImmediate(resolve));

    /** a loading task as pdf.js makes one; destroy() notes whether the task's range requests were aborted by then */
    interface FakeTask {
        promise: Promise<any>; doc: any; resolve(): void; reject(reason: unknown): void;
        started: ReturnType<typeof deferred<void>>;
        destroy(): Promise<void>; destroys: number; destroyed: boolean; requests?: AbortController; abortedAtDestroy?: boolean; params?: any;
    }
    const tasks: FakeTask[] = [];
    function fakeTask(pending = false, name = 'task-' + tasks.length): FakeTask {
        const result = deferred<any>();
        const task: FakeTask = {
            promise: result.promise, doc: undefined, started: deferred<void>(), destroys: 0, destroyed: false,
            resolve() { result.resolve(task.doc); }, reject: result.reject,
            destroy() {
                task.destroys++;
                task.destroyed = true;
                task.abortedAtDestroy = task.requests?.signal.aborted;
                return Promise.resolve();
            },
        };
        task.doc = { loadingTask: task, name, numPages: 3, fingerprints: [name] };
        if (!pending) { task.resolve(); }
        tasks.push(task);
        return task;
    }
    class FakeWorker {
        static made: FakeWorker[] = [];
        terminated = false;
        private onTerminated!: () => void;
        /** settles when the page stops this worker */
        readonly stopped = new Promise<void>(resolve => { this.onTerminated = resolve; });
        constructor(url?: string) {
            if (url?.startsWith('blob:')) { URL.revokeObjectURL(url); }
            FakeWorker.made.push(this);
        }
        terminate() { this.terminated = true; this.onTerminated(); }
    }

    before(async () => {
        const config = { engine: 'overleaf', pdfjs: { build: 'https://webview.test/b/', cMapUrl: '', standardFontDataUrl: '', wasmUrl: '', iccUrl: '', imageResourcesPath: '' } };
        Object.assign(globals, {
            window: { addEventListener() {}, location: new URL('https://webview.test/index.html') },
            location: new URL('https://webview.test/index.html'),
            document: { visibilityState: 'visible', documentElement: { style: {} },
                getElementById: (id: string) => id === 'viewer-config' ? { textContent: JSON.stringify(config) } : null },
            acquireVsCodeApi: () => ({ postMessage() {}, getState() { return undefined; }, setState() {} }),
            Worker: FakeWorker,
            __pdfDocumentFixture: undefined,
            __pdfReadingFixture: undefined,
            // pdf.worker.mjs, which the page starts from a blob
            fetch: async () => new (globalThis as any).Response('// pdf.worker.mjs'),
            // a PDF read whole
            pdfjsLib: { GlobalWorkerOptions: {}, ResponseException: class extends Error {}, getDocument: (params: any) => {
                const task = planned.shift() ?? fakeTask();
                task.params = params;
                task.requests = rangeRequests.get(params.url);
                task.started.resolve();
                return task;
            } },
            setTimeout: (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
                const timer = nativeTimeout(callback, delay, ...args);
                if (delay === 10_000) { destroyTimers.add(timer); }
                return timer;
            },
            clearTimeout: (timer: ReturnType<typeof setTimeout>) => { destroyTimers.delete(timer); nativeClearTimeout(timer); },
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
            `export { default as PDFJSWrapper } from ${JSON.stringify(path.join(viewerRoot, 'overleaf', 'services', 'web', 'frontend', 'js', 'features', 'pdf-preview', 'util', 'pdf-js-wrapper.ts'))};`,
        ].join('\n'));
        const components = { name: 'document-test-components', setup(build: any) {
            build.onResolve({ filter: /^pdfjs-dist\/web\/pdf_viewer\.(mjs|css)$/ }, (args: any) => ({ path: args.path, namespace: 'document-components' }));
            build.onLoad({ filter: /.*/, namespace: 'document-components' }, (args: any) => args.path.endsWith('.css')
                ? { contents: '', loader: 'css' }
                : { contents: 'export const PDFViewer = undefined, EventBus = undefined, PDFLinkService = undefined, LinkTarget = {};', loader: 'js' });
        } };
        const readingInputs = { name: 'reading-document-inputs', setup(build: any) {
            build.onResolve({ filter: /^\.\.\/common\/pdf-reading-(source|upgrade)$/ }, (args: any) =>
                ({ path: args.path, namespace: 'reading-document-inputs' }));
            build.onLoad({ filter: /.*/, namespace: 'reading-document-inputs' }, (args: any) => ({ loader: 'js',
                contents: args.path.endsWith('source')
                    ? 'export const openPdfReadingSource = (descriptor, options) => globalThis.__pdfReadingFixture.open(descriptor, options);'
                    : 'export const preparePdfReadingUpgrade = (candidate, viewer, signal) => globalThis.__pdfReadingFixture.prepare(candidate, viewer, signal);',
            }));
        } };
        await esbuild.build({ ...bundleOptions, plugins: [readingInputs, ...bundleOptions.plugins, components], entryPoints: [entry], outfile: path.join(dir, 'documents.mjs') });
        // Run the complete full-engine entry point and real host messages. Its app, artwork,
        // and browser-only controls are stand-ins; none replace its load/close control flow.
        const main = path.join(viewerRoot, 'src', 'pdfjs', 'main.ts');
        const entryModules: Record<string, string> = {
            '../common/transport': 'export const generatePdfCachingTransportFactory = () => () => undefined;',
            '@/features/pdf-preview/util/pdf-js-wrapper': 'export default class { get currentPosition() { return this.viewer.position; } scrollToPosition(value) { this.viewer.restored = value; } }',
            '../common/bridge': 'export function bridgeOutputsOf() {} export function readReadingImage() { throw new Error("unexpected image read"); }',
            '../common/banner': 'const f = globalThis.__pdfDocumentFixture; export const documentShown = build => f.shown(build), showLoadError = error => f.errors.push(error), showBuildState = () => {}, showState = (_state, detail) => f.errors.push(detail);',
            '../common/worker': 'export const createWorkerPort = async () => globalThis.__pdfDocumentFixture.worker();',
            '../common/pdf-prefetch': 'export const installPdfPrefetch = () => globalThis.__pdfDocumentFixture.prefetch;',
            '../common/pdf-preview-bridge': 'export const hostPdfPreviewSource = preview => preview;',
            '../common/synctex': 'export const goToCode = () => {}, listenForDoubleClick = () => {}, showHighlights = () => {};',
            '../common/theme': 'export const applyTheme = () => {}, themesFrom = () => [];',
        };
        const appEnvironment = { name: 'full-document-test-environment', setup(build: any) {
            build.onResolve({ filter: /.*/ }, (args: any) => args.importer === main && entryModules[args.path]
                ? { path: args.path, namespace: 'full-document-environment' } : undefined);
            build.onLoad({ filter: /.*/, namespace: 'full-document-environment' }, (args: any) => ({ contents: entryModules[args.path], loader: 'js' }));
        } };
        fullAppEntry = path.join(dir, 'full-app.mjs');
        await esbuild.build({ ...bundleOptions, plugins: [appEnvironment, readingInputs, ...bundleOptions.plugins], entryPoints: [main], outfile: fullAppEntry });
        // esbuild's service process is not needed any more; another build starts it again
        await esbuild.stop();
        viewer = await importModule(path.join(dir, 'documents.mjs'));
    });

    beforeEach(() => {
        savedWarn = console.warn; savedError = console.error;
        console.warn = console.error = () => {};
        readingEnvironment = { sources: new Map<string, any>(),
            open: async (descriptor: any) => readingEnvironment.sources.get(descriptor.manifestRevision),
            prepare: async (candidate: any, pdfViewer: any, signal: AbortSignal) => readingEnvironment.preparing?.(candidate, pdfViewer, signal),
        };
        (globalThis as any).__pdfReadingFixture = readingEnvironment;
    });

    afterEach(async () => {
        // The baseline leaves these native promises unhandled; consume them after each
        // assertion so a failing regression cannot leak a rejection into another case.
        for (const result of transitionResults) { void result.catch(() => {}); }
        transitionResults.length = 0;
        for (const task of tasks) { task.requests?.abort(); await task.destroy(); }
        for (const worker of FakeWorker.made) { worker.terminate(); }
        await endTurn();
        for (const timer of destroyTimers) { clearTimeout(timer); }
        destroyTimers.clear(); tasks.length = 0; planned.length = 0; FakeWorker.made.length = 0;
        rangeRequests.clear(); viewer.loadingTasks.clear();
        console.warn = savedWarn; console.error = savedError;
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
            viewer: { pdfDocument: undefined as any, setDocument(doc: any) { this.pdfDocument = doc; }, linkService: { setDocument() {} } },
            eventBus: { on() {}, off() {} },
            // as PDFJSWrapper.loadDocument: a task whose range transport stops its requests with abortController
            loadDocument: ({ abortController }: { abortController: AbortController }) => {
                const task = fakeTask();
                task.requests = abortController;
                viewer.loadingTasks.add(task);
                return task.promise.then(doc => { wrapper.viewer.setDocument(doc); return doc; });
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
        assert.strictEqual(destroyTimers.size, 0, 'successful destruction releases its ten-second fallback timer');
    });

    function nativeFixture(options: { height?: number, beforeSwap?: false | ((doc: any, build: string | undefined, signal: AbortSignal, fixture: any) => (() => void) | undefined) } = {}) {
        const events: string[] = [], loaded: any[] = [], failed: any[] = [];
        const transitions: { commit(): Promise<void>, readonly callbackHandled: boolean }[] = [];
        const returns: ReturnType<typeof deferred<any>>[] = [];
        let fixture: any;
        const linkService = { pdfDocument: undefined as any, setDocument(doc: any) {
            events.push('link:' + doc.name); this.pdfDocument = doc;
        } };
        const pdfViewer = { pdfDocument: undefined as any, linkService, position: 0,
            setDocument(doc: any) {
                assert.strictEqual(this, pdfViewer, 'the original setter receives the real page viewer');
                events.push('setter:' + doc.name);
                if (fixture.setterFailure?.doc === doc) { throw fixture.setterFailure.error; }
                this.pdfDocument = doc;
            },
        };
        const pageListeners = new Set<() => void>();
        const element = { getBoundingClientRect: () => ({ height: options.height ?? 0 }), style: { minHeight: '' } };
        const wrapper = Object.assign(Object.create(viewer.PDFJSWrapper.prototype), {
            viewer: pdfViewer, linkService, eventBus: {
                on(name: string, callback: () => void) { if (name === 'pagesinit') { pageListeners.add(callback); } },
                off(name: string, callback: () => void) { if (name === 'pagesinit') { pageListeners.delete(callback); } },
            },
            container: {
                querySelector: () => element,
                startViewTransition(callback: () => void) {
                    const ready = deferred<void>(), callbackDone = deferred<void>();
                    let callbackHandled = false;
                    const then = callbackDone.promise.then.bind(callbackDone.promise);
                    Object.defineProperty(callbackDone.promise, 'then', { value(onFulfilled: any, onRejected: any) {
                        if (typeof onRejected === 'function') { callbackHandled = true; }
                        return then(onFulfilled, onRejected);
                    } });
                    transitionResults.push(callbackDone.promise);
                    transitions.push({ get callbackHandled() { return callbackHandled; }, commit() {
                        const commit = Promise.resolve().then(callback);
                        commit.then(() => { ready.resolve(); callbackDone.resolve(); }, error => { ready.reject(error); callbackDone.reject(error); });
                        return commit;
                    } });
                    return { ready: ready.promise, updateCallbackDone: callbackDone.promise };
                },
            },
            pdfCachingTransportFactory({ url, abortController }: any) { rangeRequests.set(url, abortController); return undefined; },
            loadDocument(input: any) {
                const returned = returns.shift()!;
                const loading = viewer.PDFJSWrapper.prototype.loadDocument.call(this, input);
                loading.then(returned.resolve, returned.reject);
                return loading;
            },
        });
        const hooks: any = {
            beforeLoad() { events.push('prepare'); },
            loaded(doc: any, build: string, preview: any) { events.push('loaded:' + doc.name); loaded.push({ doc, build, preview }); },
            failed(error: unknown, aborted: boolean, build: string) { failed.push({ error, aborted, build }); },
            fetchFailed(error: unknown, build: string) { failed.push({ error, build }); },
        };
        if (options.beforeSwap !== false) {
            hooks.beforeSwap = (doc: any, build: string | undefined, signal: AbortSignal) => {
                events.push('scene:' + doc.name);
                return options.beforeSwap ? options.beforeSwap(doc, build, signal, fixture)
                    : () => events.push('cancel:' + doc.name);
            };
        }
        const documents = new viewer.Documents(wrapper, hooks);
        fixture = { documents, wrapper, pdfViewer, linkService, events, transitions, loaded, failed, element, pageListeners, hooks,
            pagesInit() { [...pageListeners].forEach(callback => callback()); },
            load(build: string, pending = false, preview?: any, reading?: any) {
                const task = fakeTask(pending, build), returned = deferred<any>();
                planned.push(task); if (!reading) { returns.push(returned); }
                documents.load({
                    url: `https://dl.test/zone/d/project/p1/user/u1/build/${build}/output/output.pdf?enable_pdf_caching=true`,
                    downloadDomain: 'https://dl.test/zone/d', projectId: 'p1',
                    file: { path: 'output.pdf', url: `/project/p1/user/u1/build/${build}/output/output.pdf`, type: 'pdf', build, size: 1000 },
                }, false, preview, reading);
                return { task, async prepared() { const doc = await returned.promise; await endTurn(); return doc; } };
            },
        };
        return fixture;
    }

    async function initial(fixture: any, build = 'old') {
        const load = fixture.load(build);
        await load.prepared();
        await fixture.transitions.shift()!.commit();
        await fixture.documents.settled;
        fixture.pagesInit();
        return load.task as FakeTask;
    }

    it('announces a first validated proxy only after the deferred setter, without arming a replacement', async () => {
        const fixture = nativeFixture();
        const load = fixture.load('first');
        await load.prepared();
        assert.strictEqual(fixture.documents.loading, true);
        assert.strictEqual(fixture.loaded.length, 0);
        assert.deepStrictEqual(fixture.events, ['prepare']);
        await fixture.transitions.shift()!.commit();
        await fixture.documents.settled;
        assert.strictEqual(fixture.pdfViewer.pdfDocument, load.task.doc);
        assert.deepStrictEqual(fixture.events, ['prepare', 'setter:first', 'link:first', 'loaded:first']);
    });

    it('waits for actual adoption even when the optional scene hook is absent', async () => {
        const fixture = nativeFixture({ beforeSwap: false });
        await initial(fixture);
        const old = fixture.pdfViewer.pdfDocument;
        const next = fixture.load('next');
        await next.prepared();
        assert.strictEqual(old.loadingTask.destroys, 0);
        assert.strictEqual(fixture.loaded.length, 1);
        await fixture.transitions.shift()!.commit();
        await fixture.documents.settled;
        assert.strictEqual(fixture.pdfViewer.pdfDocument, next.task.doc);
        assert.strictEqual(old.loadingTask.abortedAtDestroy, true);
    });

    it('prepares the replacement immediately before the real setter while the old document remains live', async () => {
        let previous: FakeTask | undefined, capturedPosition: number | undefined;
        const fixture = nativeFixture({ beforeSwap(doc, build, signal, current) {
            assert.strictEqual(current.pdfViewer.pdfDocument, previous!.doc);
            assert.strictEqual(previous!.destroys, 0);
            assert.strictEqual(previous!.requests?.signal.aborted, false);
            assert.strictEqual(signal.aborted, false);
            assert.strictEqual(build, 'next');
            capturedPosition = current.pdfViewer.position;
            return () => current.events.push('cancel:' + doc.name);
        } });
        previous = await initial(fixture);
        fixture.events.length = 0;
        const preview = { identity: { key: 'next', size: 1000 }, manifestUrl: 'https://viewer.test/previews.json' };
        const next = fixture.load('next', false, preview);
        await next.prepared();
        assert.strictEqual(previous.destroys, 0, 'a validated candidate must not destroy the document still being viewed');
        assert.strictEqual(FakeWorker.made[0].terminated, false);
        assert.strictEqual(fixture.loaded.length, 1);
        fixture.pdfViewer.position = 42;
        await fixture.transitions.shift()!.commit();
        await fixture.documents.settled;
        assert.strictEqual(capturedPosition, 42);
        assert.deepStrictEqual(fixture.events, ['prepare', 'scene:next', 'setter:next', 'link:next', 'loaded:next']);
        assert.strictEqual(fixture.loaded[1].doc, next.task.doc);
        assert.strictEqual(fixture.loaded[1].preview, preview);
        assert.strictEqual(previous.abortedAtDestroy, true);
        await FakeWorker.made[0].stopped;
    });

    it('keeps the shown document when candidate validation fails and does not arm a replacement', async () => {
        const fixture = nativeFixture();
        const previous = await initial(fixture);
        fixture.events.length = 0;
        const next = fixture.load('failed', true);
        const failure = new Error('candidate validation failed');
        const rejected = assert.rejects(next.prepared(), error => error === failure);
        await next.task.started.promise;
        next.task.reject(failure);
        await rejected;
        await fixture.documents.settled;
        assert.strictEqual(fixture.pdfViewer.pdfDocument, previous.doc);
        assert.strictEqual(previous.destroys, 0);
        assert.deepStrictEqual(fixture.events, ['prepare']);
        assert.strictEqual(fixture.failed[0].error, failure);
        assert.strictEqual(next.task.destroys, 1);
    });

    it('rejects a cancelled late transition before either the viewer or the link service can adopt it', async () => {
        const fixture = nativeFixture({ height: 600 });
        await initial(fixture);
        fixture.events.length = 0;
        const cancelled = fixture.load('cancelled');
        await cancelled.prepared();
        const late = fixture.transitions.shift()!;
        const replacement = fixture.load('replacement');
        await replacement.prepared();
        await fixture.transitions.shift()!.commit();
        await fixture.documents.settled;
        const count = fixture.loaded.length;
        await assert.rejects(late.commit(), { name: 'AbortError' });
        assert.strictEqual(late.callbackHandled, true, 'the separate native updateCallbackDone rejection is handled');
        assert.strictEqual(fixture.element.style.minHeight, '600px', 'the retired callback does not clear the replacement hold');
        assert.strictEqual(fixture.pageListeners.size, 1);
        assert.strictEqual(fixture.pdfViewer.pdfDocument, replacement.task.doc);
        assert.strictEqual(fixture.linkService.pdfDocument, replacement.task.doc);
        assert.strictEqual(fixture.loaded.length, count);
        assert.ok(!fixture.events.includes('scene:cancelled'));
        assert.ok(!fixture.events.includes('setter:cancelled'));
        assert.ok(!fixture.events.includes('link:cancelled'));
        assert.strictEqual(cancelled.task.requests?.signal.aborted, true);
    });

    it('adopts a useful document when optional scene preparation throws', async () => {
        const fixture = nativeFixture({ beforeSwap() { throw new Error('optional scene failed'); } });
        const previous = await initial(fixture);
        const next = fixture.load('next');
        await next.prepared();
        await fixture.transitions.shift()!.commit();
        await fixture.documents.settled;
        assert.strictEqual(fixture.pdfViewer.pdfDocument, next.task.doc);
        assert.strictEqual(fixture.linkService.pdfDocument, next.task.doc);
        assert.strictEqual(fixture.loaded.at(-1).doc, next.task.doc);
        assert.strictEqual(previous.destroys, 1);
        assert.deepStrictEqual(fixture.failed, []);
    });

    it('cancels prepared artwork and retains the old document when the actual deferred setter fails', async () => {
        const fixture = nativeFixture({ height: 600 });
        const previous = await initial(fixture);
        fixture.events.length = 0;
        const next = fixture.load('next');
        await next.prepared();
        const failure = new Error('page viewer rejected the document');
        fixture.setterFailure = { doc: next.task.doc, error: failure };
        const transition = fixture.transitions.shift()!;
        await assert.rejects(transition.commit(), error => error === failure);
        await fixture.documents.settled;
        assert.deepStrictEqual(fixture.events, ['prepare', 'scene:next', 'setter:next', 'cancel:next']);
        assert.strictEqual(fixture.pdfViewer.pdfDocument, previous.doc);
        assert.strictEqual(fixture.linkService.pdfDocument, previous.doc);
        assert.strictEqual(previous.destroys, 0);
        assert.strictEqual(next.task.destroys, 1);
        assert.strictEqual(fixture.loaded.length, 1);
        assert.strictEqual(fixture.failed[0].error, failure);
        assert.strictEqual(fixture.element.style.minHeight, '');
        assert.strictEqual(fixture.pageListeners.size, 0);
        assert.strictEqual(transition.callbackHandled, true);
    });

    it('keeps one current height hold when an inline document replaces a range document before pagesinit', async () => {
        const fixture = nativeFixture({ height: 600 });
        await initial(fixture);
        const ranges = fixture.load('ranges'); await ranges.prepared();
        await fixture.transitions.shift()!.commit(); await fixture.documents.settled;
        assert.strictEqual(fixture.pageListeners.size, 1);
        const inline = fakeTask(false, 'inline'); planned.push(inline);
        fixture.documents.loadData(new ArrayBuffer(8));
        await inline.started.promise; await fixture.documents.settled;
        assert.strictEqual(fixture.pageListeners.size, 1, 'retiring the range task releases only its old listener');
        assert.strictEqual(fixture.element.style.minHeight, '600px');
        fixture.pagesInit();
        assert.strictEqual(fixture.pageListeners.size, 0);
        assert.strictEqual(fixture.element.style.minHeight, '');
    });

    function readingSource(letter = 'a', pageCount = 3) {
        const descriptor = { identity: { sha256: 'a'.repeat(64), size: 1000 },
            manifestUrl: 'https://webview.test/reading.json', manifestRevision: letter.repeat(64) };
        const source = { data: new Uint8Array([1, 2, 3]), manifest: { source: { pageCount } },
            externalImageSource: { images: [], read: async () => new Uint8Array() }, disposed: false,
            dispose() { this.disposed = true; } };
        readingEnvironment.sources.set(descriptor.manifestRevision, source);
        return { descriptor, source };
    }

    it('upgrades the same Overleaf build only after acknowledged coverage and captures its current position without an edition scene', async () => {
        const f = nativeFixture(), old = await initial(f, 'same');
        const { descriptor, source } = readingSource();
        const entered = deferred<void>(), covered = deferred<void>();
        let suspended = false, resumes = 0;
        f.hooks.pauseRefinement = async () => { suspended = true; return () => { resumes++; }; };
        readingEnvironment.preparing = async (_candidate: any, current: any, signal: AbortSignal) => {
            assert.strictEqual(suspended, true); assert.strictEqual(current.pdfDocument, old.doc);
            assert.strictEqual(signal.aborted, false); entered.resolve(); await covered.promise;
        };
        const captured: number[] = [];
        f.hooks.beforeLoad = () => captured.push(f.pdfViewer.position);
        f.events.length = 0;
        const next = f.load('same', false, undefined, descriptor);
        await entered.promise;
        assert.strictEqual(f.pdfViewer.pdfDocument, old.doc); assert.strictEqual(old.destroys, 0);
        assert.strictEqual(next.task.params.externalImageSource, source.externalImageSource);
        assert.strictEqual(next.task.params.data, source.data);
        f.pdfViewer.position = 57; covered.resolve(); await f.documents.settled;
        assert.strictEqual(captured.at(-1), 57); assert.strictEqual(resumes, 1);
        assert.strictEqual(f.pdfViewer.pdfDocument, next.task.doc); assert.strictEqual(old.destroys, 1);
        assert.ok(!f.events.some((event: string) => event.startsWith('scene:')));
        assert.strictEqual(source.disposed, false);
        await f.documents.dispose(); assert.strictEqual(source.disposed, true);
    });

    it('releases the temporary page height and listener when an inline-data setter fails', async () => {
        const fixture = nativeFixture({ height: 600 });
        const previous = await initial(fixture);
        const task = fakeTask(false, 'inline-failed'), failure = new Error('inline setter failed');
        planned.push(task); fixture.setterFailure = { doc: task.doc, error: failure };
        fixture.documents.loadData(new ArrayBuffer(8));
        await task.started.promise; await fixture.documents.settled;
        assert.strictEqual(fixture.element.style.minHeight, '');
        assert.strictEqual(fixture.pageListeners.size, 0);
        assert.strictEqual(fixture.pdfViewer.pdfDocument, previous.doc);
        assert.strictEqual(previous.destroys, 0);
        assert.strictEqual(task.destroys, 1);
        assert.strictEqual(fixture.failed[0].error, failure);
    });

    describe('the full PDF.js page entry point', () => {
        async function fixture() {
            const events: string[] = [], errors: unknown[] = [], announcements: any[] = [], previews: any[] = [];
            const listeners = new Map<string, ((event: any) => void)[]>();
            const bus = new Map<string, ((event: any) => void)[]>();
            const options = new Map<string, unknown>();
            const pdfViewer = {
                pdfDocument: undefined as any, position: { page: 1, offset: { left: 0, top: 0 } }, restored: undefined as any,
                restoreNegativeOffset: false,
                currentScaleValue: '1.25', container: { addEventListener() {}, removeEventListener() {} },
                viewer: { style: { minHeight: '' }, classList: { add() {} }, getBoundingClientRect: () => ({ height: f?.height ?? 0 }) },
                scrollPageIntoView({ pageNumber, destArray, allowNegativeOffset }: any) {
                    this.restored = { page: pageNumber - 1, offset: { left: destArray[2], top: destArray[3] } };
                    this.restoreNegativeOffset = allowNegativeOffset;
                },
            };
            let f: any;
            const application: any = {
                initializedPromise: Promise.resolve(), pdfDocument: undefined, pdfLoadingTask: undefined, pdfViewer,
                eventBus: {
                    on(name: string, callback: (event: any) => void) { bus.set(name, [...(bus.get(name) ?? []), callback]); },
                    off(name: string, callback: (event: any) => void) { bus.set(name, (bus.get(name) ?? []).filter(value => value !== callback)); },
                    dispatch(name: string, event: any) { bus.get(name)?.forEach(callback => callback(event)); },
                },
                async close() {
                    assert.strictEqual(this, application);
                    events.push('close:' + (this.pdfDocument?.name ?? 'empty'));
                    if (f.closeFailure) { throw f.closeFailure; }
                    const old = this.pdfLoadingTask;
                    this.pdfDocument = pdfViewer.pdfDocument = undefined;
                    this.pdfLoadingTask = undefined;
                    if (old) { await old.destroy(); }
                    f.closeStarted?.();
                    if (f.closeGate) { await f.closeGate.promise; }
                },
                load(doc: any) {
                    assert.strictEqual(this, application);
                    events.push('setter:' + doc.name);
                    // Pinned app.load assigns pdfDocument before calling PDFViewer.setDocument.
                    this.pdfDocument = doc;
                    if (f.setterFailure?.doc === doc) { throw f.setterFailure.error; }
                    this.pdfDocument = pdfViewer.pdfDocument = doc;
                    this.eventBus.dispatch('pagesinit', {});
                },
                setTitleUsingUrl() {},
            };
            f = { events, errors, announcements, previews, application, pdfViewer,
                hide() { for (const callback of [...(listeners.get('pagehide') ?? [])]) { callback({ persisted: false }); } },
                worker: () => new FakeWorker(),
                shown(build: string) { events.push('shown:' + build); announcements.push({ build, doc: application.pdfDocument }); },
                prefetch: {
                    dispose() {},
                    async pauseImageRefinement() { f.pauses = (f.pauses ?? 0) + 1; return () => { f.resumes = (f.resumes ?? 0) + 1; }; },
                    prepareReplacement(build: string, signal: AbortSignal) {
                        events.push('scene:' + build);
                        f.preparing?.(build, signal);
                        if (f.sceneFailure) { throw f.sceneFailure; }
                        return () => events.push('cancel:' + build);
                    },
                    setPreviewSource(preview: any, doc: any) { events.push('preview:' + doc.name); previews.push({ preview, doc }); },
                },
                load(build: string, pending = false, preview?: any, reading?: any) {
                    const task = fakeTask(pending, build);
                    planned.push(task);
                    const data = { type: 'load', preview, reading, output: {
                        url: `https://dl.test/zone/d/project/p1/user/u1/build/${build}/output/output.pdf?enable_pdf_caching=true`,
                        downloadDomain: 'https://dl.test/zone/d', projectId: 'p1',
                        file: { path: 'output.pdf', url: `/project/p1/user/u1/build/${build}/output/output.pdf`, type: 'pdf', build, size: 1000 },
                    } };
                    listeners.get('message')!.forEach(callback => callback({ data }));
                    return { task, async settled() { await task.started.promise; await endTurn(); } };
                },
            };
            (globalThis as any).__pdfDocumentFixture = f;
            (globalThis as any).window = {
                PDFViewerApplication: application,
                PDFViewerApplicationOptions: { set: (key: string, value: unknown) => options.set(key, value), get: (key: string) => options.get(key) },
                addEventListener(name: string, callback: (event: any) => void) { listeners.set(name, [...(listeners.get(name) ?? []), callback]); },
                removeEventListener(name: string, callback: (event: any) => void) { listeners.set(name, (listeners.get(name) ?? []).filter(value => value !== callback)); },
            };
            (globalThis as any).document = { ...(globals.document as object), addEventListener() {}, removeEventListener() {} };
            await importModule(fullAppEntry + '?fixture=' + (++fullAppSequence));
            await endTurn();
            return f;
        }

        it('announces first-load ownership after the app setter and does not arm a replacement', async () => {
            const f = await fixture(), first = f.load('first');
            await first.settled();
            assert.deepStrictEqual(f.events, ['close:empty', 'setter:first', 'shown:first', 'preview:first']);
            assert.strictEqual(f.announcements[0].doc, first.task.doc);
        });

        it('captures the reader position after candidate validation and prepares immediately before closing the live old app', async () => {
            const f = await fixture(), old = f.load('old');
            await old.settled();
            f.events.length = 0;
            const next = f.load('next', true);
            await next.task.started.promise;
            const position = { page: 3, offset: { left: 12, top: 345 } };
            f.pdfViewer.position = position; f.pdfViewer.currentScaleValue = '2.5';
            let captured = false;
            f.preparing = (build: string, signal: AbortSignal) => {
                captured = true;
                assert.strictEqual(build, 'next'); assert.strictEqual(signal.aborted, false);
                assert.strictEqual(f.application.pdfDocument, old.task.doc);
                assert.strictEqual(old.task.destroys, 0);
            };
            next.task.resolve(); await next.settled();
            assert.strictEqual(captured, true);
            assert.deepStrictEqual(f.pdfViewer.restored, position);
            assert.strictEqual(f.pdfViewer.restoreNegativeOffset, true);
            assert.strictEqual(f.pdfViewer.currentScaleValue, '2.5');
            assert.deepStrictEqual(f.events, ['scene:next', 'close:old', 'setter:next', 'shown:next', 'preview:next']);
            assert.strictEqual(FakeWorker.made[0].terminated, true);
        });

        it('keeps the full viewer on the old build until same-edition coverage and restores the latest reading state', async () => {
            const f = await fixture(), old = f.load('same'); await old.settled(); f.events.length = 0;
            const { descriptor, source } = readingSource();
            const entered = deferred<void>(), covered = deferred<void>();
            readingEnvironment.preparing = async (_candidate: any, current: any) => {
                assert.strictEqual(f.pauses, 1); assert.strictEqual(current.pdfDocument, old.task.doc);
                entered.resolve(); await covered.promise;
            };
            const next = f.load('same', false, undefined, descriptor); await entered.promise;
            assert.strictEqual(old.task.destroys, 0); assert.strictEqual(f.application.pdfDocument, old.task.doc);
            const position = { page: 2, offset: { left: 19, top: 241 } };
            f.pdfViewer.position = position; f.pdfViewer.currentScaleValue = '1.6';
            covered.resolve(); await next.settled();
            assert.strictEqual(next.task.params.externalImageSource, source.externalImageSource);
            assert.strictEqual(f.application.pdfDocument, next.task.doc); assert.strictEqual(f.resumes, 1);
            assert.deepStrictEqual(f.pdfViewer.restored, position); assert.strictEqual(f.pdfViewer.currentScaleValue, '1.6');
            assert.ok(!f.events.some((event: string) => event.startsWith('scene:')));
            assert.strictEqual(source.disposed, false); f.hide(); await endTurn(); assert.strictEqual(source.disposed, true);
        });

        it('disposes a reading source rejected after partial native adoption and rejects page-count mismatches before adoption', async () => {
            for (const wrongPages of [false, true]) {
                const f = await fixture(), old = f.load('old'); await old.settled();
                const { descriptor, source } = readingSource(wrongPages ? 'b' : 'a', wrongPages ? 4 : 3);
                const next = f.load('next', true, undefined, descriptor);
                await next.task.started.promise;
                if (!wrongPages) { f.setterFailure = { doc: next.task.doc, error: new Error('native adoption rejected') }; }
                next.task.resolve(); await next.settled();
                assert.strictEqual(source.disposed, true); assert.strictEqual(next.task.destroys, 1);
                assert.notStrictEqual(f.application.pdfDocument, next.task.doc);
                if (wrongPages) { assert.strictEqual(f.application.pdfDocument, old.task.doc); assert.strictEqual(old.task.destroys, 0); }
                f.hide(); await endTurn();
            }
        });

        it('does not prepare a scene for a rejected or superseded candidate', async () => {
            const f = await fixture(), old = f.load('old'); await old.settled();
            f.events.length = 0;
            const failed = f.load('failed', true), failure = new Error('invalid PDF');
            await failed.task.started.promise; failed.task.reject(failure); await failed.settled();
            assert.deepStrictEqual(f.events, []); assert.deepStrictEqual(f.errors, [failure]);
            assert.strictEqual(old.task.destroys, 0);
            const cancelled = f.load('cancelled', true); await cancelled.task.started.promise;
            const replacement = f.load('replacement'); await replacement.settled();
            assert.strictEqual(cancelled.task.destroys, 1);
            assert.ok(!f.events.includes('scene:cancelled'));
            assert.strictEqual(f.application.pdfDocument, replacement.task.doc);
        });

        it('adopts the candidate when optional scene preparation throws', async () => {
            const f = await fixture(), old = f.load('old'); await old.settled();
            f.events.length = 0; f.sceneFailure = new Error('optional artwork unavailable');
            const preview = { manifestUrl: 'https://viewer.test/previews.json' };
            const next = f.load('next', false, preview); await next.settled();
            assert.strictEqual(f.application.pdfDocument, next.task.doc);
            assert.strictEqual(f.previews.at(-1).preview, preview);
            assert.strictEqual(old.task.destroys, 1);
            assert.strictEqual(FakeWorker.made[0].terminated, true);
            assert.deepStrictEqual(f.errors, []);
        });

        it('releases the detached old worker when its task destruction rejects during close', async () => {
            const f = await fixture(), old = f.load('old'); await old.settled();
            f.events.length = 0;
            const failure = new Error('old transport destruction failed');
            const destroy = old.task.destroy.bind(old.task);
            let rejectOnce = true;
            old.task.destroy = async () => {
                await destroy();
                if (rejectOnce) { rejectOnce = false; throw failure; }
            };
            const next = f.load('next'); await next.settled();
            assert.deepStrictEqual(f.events, ['scene:next', 'close:old', 'cancel:next']);
            assert.strictEqual(f.application.pdfDocument, undefined);
            assert.strictEqual(f.application.pdfLoadingTask, undefined);
            assert.strictEqual(old.task.destroys, 1);
            assert.strictEqual(next.task.destroys, 1);
            assert.deepStrictEqual(FakeWorker.made.map(worker => worker.terminated), [true, true]);
            assert.deepStrictEqual(f.errors, [failure]);
        });

        it('keeps the old worker when close fails before detaching its live document', async () => {
            const f = await fixture(), old = f.load('old'); await old.settled();
            const failure = new Error('close failed before detachment');
            f.closeFailure = failure;
            const next = f.load('next'); await next.settled();
            assert.strictEqual(f.application.pdfDocument, old.task.doc);
            assert.strictEqual(f.application.pdfLoadingTask, old.task);
            assert.strictEqual(old.task.destroys, 0);
            assert.strictEqual(next.task.destroys, 1);
            assert.deepStrictEqual(FakeWorker.made.map(worker => worker.terminated), [false, true]);
            assert.deepStrictEqual(f.errors, [failure]);
        });

        it('cancels prepared artwork and disposes a candidate rejected by the app setter', async () => {
            const f = await fixture(), old = f.load('old'); await old.settled();
            f.events.length = 0;
            const next = f.load('next', true), failure = new Error('app setter failed');
            await next.task.started.promise;
            f.height = 600;
            f.setterFailure = { doc: next.task.doc, error: failure };
            next.task.resolve(); await next.settled();
            assert.deepStrictEqual(f.events, ['scene:next', 'close:old', 'setter:next', 'cancel:next', 'close:next']);
            assert.strictEqual(next.task.destroys, 1);
            assert.strictEqual(FakeWorker.made[1].terminated, true);
            assert.strictEqual(f.application.pdfDocument, undefined);
            assert.strictEqual(f.application.pdfLoadingTask, undefined);
            assert.strictEqual(f.pdfViewer.viewer.style.minHeight, '');
            assert.strictEqual(f.announcements.length, 1); assert.strictEqual(f.previews.length, 1);
            assert.deepStrictEqual(f.errors, [failure]);
        });

        it('closes a candidate whose adoption is waiting for the old app close', async () => {
            const f = await fixture(), old = f.load('old'); await old.settled();
            const closing = deferred<void>(), gate = deferred<void>();
            f.closeStarted = closing.resolve; f.closeGate = gate;
            const next = f.load('next');
            await closing.promise;
            try {
                f.hide();
                assert.strictEqual(next.task.destroys, 1, 'the page owns the prepared candidate throughout app.close');
            } finally { gate.resolve(); await next.settled(); }
            assert.ok(!f.events.includes('setter:next'));
            assert.strictEqual(old.task.destroys, 1, 'the app-owned destruction is not repeated at page close');
            await Promise.all(FakeWorker.made.map(worker => worker.stopped));
            assert.ok(FakeWorker.made.every(worker => worker.terminated));
            assert.strictEqual(destroyTimers.size, 0);
        });
    });
});
