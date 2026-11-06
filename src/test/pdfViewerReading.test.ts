/* eslint-disable @typescript-eslint/naming-convention -- mirrors PDF.js and browser exports */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class Events {
    readonly listeners = new Map<string, Set<(event: any) => void>>();
    addEventListener(name: string, listener: (event: any) => void) {
        const group = this.listeners.get(name) ?? new Set();
        group.add(listener); this.listeners.set(name, group);
    }
    removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
    dispatch(name: string, event: any = {}) { for (const listener of [...(this.listeners.get(name) ?? [])]) { listener(event); } }
    on = this.addEventListener.bind(this);
    off = this.removeEventListener.bind(this);
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}

describe('reading state in both PDF viewer entry points', function () {
    this.timeout(30_000);
    let dir: string, sequence = 0;
    const entries = new Map<string, string>();
    const saved = new Map<string, PropertyDescriptor | undefined>();
    let current: any;
    const globals = ['window', 'parent', 'document', 'ResizeObserver', 'acquireVsCodeApi', '__readingFixture', 'setTimeout', 'clearTimeout'];

    before(async () => {
        for (const name of globals) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); }
        const esbuild = await importModule('esbuild');
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts/build-pdf-viewer.mjs'));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-reading-entry-'));
        try {
            for (const engine of ['pdfjs', 'overleaf']) {
                const main = path.join(viewerRoot, 'src', engine, 'main.ts');
                const modules: Record<string, string> = {
                    '../common/transport': 'export const generatePdfCachingTransportFactory = () => () => undefined;',
                    '@/features/pdf-preview/util/pdf-js-wrapper': 'export default globalThis.__readingFixture.Wrapper;',
                    '../common/bridge': 'export const bridgeOutputsOf = () => {};',
                    '../common/banner': 'export const documentShown = () => {}, showLoadError = () => {}, showBuildState = () => {}, showState = () => {};',
                    '../common/worker': 'export const createWorkerPort = async () => globalThis.__readingFixture.worker();',
                    '../shims/pdf-js': 'export const documentParams = () => ({}), PDFJS = { GlobalWorkerOptions: {}, getDocument: () => globalThis.__readingFixture.task() };',
                    '../common/pdf-prefetch': 'export const installPdfPrefetch = () => globalThis.__readingFixture.prefetch;',
                    '../common/pdf-preview-bridge': 'export const hostPdfPreviewSource = value => value;',
                    '../common/pdf-preview-binding': 'export const createPdfPreviewBinding = () => ({set() {}, clear() {}, dispose() {}});',
                    '../common/synctex': 'export const goToCode = () => {}, listenForDoubleClick = () => {}, showHighlights = () => {};',
                    '../common/theme': 'export const applyTheme = () => {}, themesFrom = () => { globalThis.__readingFixture.booted.resolve(); return [{name:"Paper"}]; };',
                    './outline': 'export class Outline { open = false; setOpen(value) { this.open = value; } render() {} }',
                    './toolbar': 'export class Toolbar { constructor(actions) { globalThis.__readingFixture.actions = actions; } setTheme() {} setPage() {} setPagesCount() {} setScale() {} setOutlineOpen() {} }',
                    './zoom': 'export const listenForZoomKeys = () => {}, listenForWheelZoom = () => {};',
                    './documents': 'export class Documents { loading = false; constructor(wrapper,hooks) { this.wrapper=wrapper; this.hooks=hooks; } loadData() {} load() {} dispose() {} }',
                };
                const environment = { name: 'reading-entry-environment', setup(build: any) {
                    build.onResolve({ filter: /.*/ }, (args: any) => args.importer === main && modules[args.path]
                        ? { path: args.path, namespace: 'reading-entry' } : undefined);
                    build.onLoad({ filter: /.*/, namespace: 'reading-entry' }, (args: any) => ({ contents: modules[args.path], loader: 'js' }));
                } };
                const outfile = path.join(dir, engine + '.mjs');
                await esbuild.build({ ...bundleOptions, plugins: [environment, ...bundleOptions.plugins], entryPoints: [main], outfile });
                entries.set(engine, outfile);
            }
        } finally { await esbuild.stop(); }
    });

    afterEach(() => {
        current?.window.dispatch('pagehide', { persisted: false });
        current?.timers.clear();
        current = undefined;
        for (const name of globals) {
            const descriptor = saved.get(name);
            if (descriptor) { Object.defineProperty(globalThis, name, descriptor); } else { delete (globalThis as any)[name]; }
        }
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    async function fixture(engine: string, delayed = false, initialPosition?: any) {
        const window = new Events() as any, document = new Events() as any, parentDocument = new Events();
        const container = new Events() as any, bus = new Events(), booted = deferred(), initialized = deferred(), shown = deferred();
        const posts: any[] = [], writes: any[] = [], timers = new Map<number, { callback: () => void, delay: number }>();
        let timerId = 0;
        const initial = { position: initialPosition ?? { page: 2, offset: { left: 9, top: 35 }, pageSize: { width: 600, height: 800 } }, scale: '1.5', motionLabMeasurementsOpen: true };
        const pages = { style: {}, classList: { add() {} }, getBoundingClientRect: () => ({ height: 800 }) };
        container.querySelectorAll = () => [];
        container.querySelector = () => pages;
        const view: any = {
            position: copy(initial.position), currentScaleValue: initial.scale, currentScale: 1.5, currentPageNumber: 3,
            pagesCount: 12, pdfDocument: undefined as any, container, viewer: pages, linkService: {}, update() {},
        };
        const f: any = { window, document, parentDocument, container, bus, view, posts, writes, timers, initial, booted, initialized,
            workers: 0, resizeCalls: 0, resizeDisconnected: 0,
            task: () => ({ promise: Promise.resolve({ numPages: 12 }), destroy: async () => {} }),
            worker: () => { f.workers++; return { terminate() {} }; },
            prefetch: { dispose() {}, setPreviewSource() {}, prepareReplacement() {} },
        };
        view.scrollPageIntoView = ({ pageNumber, destArray, allowNegativeOffset = false }: any) => {
            view.position = { page: pageNumber - 1, offset: { left: destArray[2], top: destArray[3] }, pageSize: copy(initial.position.pageSize) };
            if (f.marginGeometry) {
                const left = destArray[2], top = 800 - destArray[3];
                container.scrollLeft = 20 + (allowNegativeOffset ? left : Math.max(0, left));
                container.scrollTop = 8 + (allowNegativeOffset ? top : Math.max(0, top));
            }
            container.dispatch('scroll');
        };
        const application: any = {
            pdfViewer: view, eventBus: bus, initializedPromise: initialized.promise, pdfDocument: undefined,
            updateZoom() {}, setTitleUsingUrl() {}, secondaryToolbar: { close() {} },
            async close() { application.pdfDocument = view.pdfDocument = undefined; },
            load(doc: any) { application.pdfDocument = view.pdfDocument = doc; bus.dispatch('pagesinit'); shown.resolve(); },
        };
        class Wrapper {
            viewer = view; container = container; eventBus = bus;
            get currentPosition() { return this.viewer.position; }
            isVisible() { return container.offsetParent !== null; }
            scrollToPosition(position: any) {
                view.scrollPageIntoView({ pageNumber: position.page + 1, destArray: [null, { name: 'XYZ' }, position.offset.left, position.offset.top, null] });
                // The upstream wrapper snaps the first page's entire margin band to zero.
                if (f.marginGeometry && container.scrollTop <= 8) { container.scrollTop = 0; }
            }
            updateOnResize() { f.resizeCalls++; }
        }
        f.Wrapper = Wrapper; f.application = application;
        window.setTimeout = (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
        window.clearTimeout = (id: number) => timers.delete(id);
        window.PDFViewerApplicationOptions = { get: () => 0, set() {} };
        if (!delayed) { window.PDFViewerApplication = application; initialized.resolve(); }
        document.visibilityState = 'visible';
        document.documentElement = { style: {} };
        document.getElementById = (id: string) => id === 'viewer-config'
            ? { textContent: JSON.stringify({ page: 'reading-page', engine, pdfjs: {} }) }
            : id === 'viewerContainer' ? container : null;
        document.querySelectorAll = () => [];
        document.querySelector = () => null;
        const values: Record<string, unknown> = {
            window, parent: { document: parentDocument }, document, __readingFixture: f,
            setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
            ResizeObserver: class { observe() {} disconnect() { f.resizeDisconnected++; } },
            acquireVsCodeApi: () => ({ getState: () => undefined,
                setState: (value: any) => writes.push(copy(value)),
                postMessage: (message: any) => {
                    posts.push(copy(message));
                    if (message.type === 'ready') { queueMicrotask(() => window.dispatch('message', { data: { type: 'initState', page: 'reading-page', content: initial } })); }
                },
            }),
        };
        for (const [name, value] of Object.entries(values)) { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); }
        current = f;
        await importModule(entries.get(engine)! + '?reading=' + (++sequence));
        if (!delayed) { await booted.promise; }
        f.loaded = () => { application.pdfDocument = view.pdfDocument = { numPages: 12 }; bus.dispatch('pagesinit'); };
        f.load = async () => {
            if (engine === 'overleaf') { f.loaded(); }
            else { window.dispatch('message', { data: { type: 'update', content: new ArrayBuffer(1) } }); await shown.promise; }
        };
        return f;
    }

    for (const engine of ['pdfjs', 'overleaf']) {
        it(engine + ' restores exact offsets within the first page margin and below it', async () => {
            for (const top of [8, 4, 0, 12]) {
                const left = 7;
                const position = { page: 0, offset: { left: left - 20, top: 800 - (top - 8) }, pageSize: { width: 600, height: 800 } };
                const f = await fixture(engine, false, position);
                try {
                    f.marginGeometry = true;
                    f.container.scrollTop = 0; f.container.scrollLeft = 0;
                    f.container.getBoundingClientRect = () => ({ left: 0, top: 0 });
                    f.view._getVisiblePages = () => ({ first: { id: 1, view: {
                        div: { getBoundingClientRect: () => ({ left: 20 - f.container.scrollLeft, top: 8 - f.container.scrollTop }) },
                        viewport: { viewBox: [0, 0, 600, 800], convertToPdfPoint: (x: number, y: number) => [x, 800 - y] },
                    } } });
                    await f.load();
                    assert.strictEqual(f.container.scrollTop, top, 'restoration must preserve the saved offset inside the page margin');
                    assert.strictEqual(f.container.scrollLeft, left, 'the measured negative PDF offset preserves horizontal position');
                    assert.deepStrictEqual(f.writes.at(-1)?.position, position, 'the restored view must publish the same PDF position');
                } finally { f.window.dispatch('pagehide', { persisted: false }); f.timers.clear(); }
            }
        });

        it(engine + ' publishes the final scroll before a quick close without waiting for a timer', async () => {
            const f = await fixture(engine); f.loaded();
            const position = { page: 8, offset: { left: 17, top: 260 }, pageSize: { width: 600, height: 800 } };
            f.view.position = position;
            f.view.currentScaleValue = '2.5';
            f.container.dispatch('scroll');
            const latest = f.posts.filter((message: any) => message.type === 'saveState').at(-1);
            assert.deepStrictEqual(latest?.content.position, position, 'the host must receive the visible position before page disposal');
            assert.strictEqual(latest?.content.scale, '2.5');
            assert.deepStrictEqual(f.writes.at(-1)?.position, position);
            assert.strictEqual(latest?.page, 'reading-page');
            const callbacks = [...(f.container.listeners.get('scroll') ?? [])] as ((event: any) => void)[];
            f.window.dispatch('pagehide', { persisted: false });
            const count = f.posts.length;
            f.view.position = { ...position, page: 10 };
            for (const callback of callbacks) { callback({}); }
            f.bus.dispatch('updateviewarea');
            assert.strictEqual(f.posts.length, count, 'callbacks retained by another owner cannot write after page disposal');
            assert.ok(![...f.timers.values()].some((timer: any) => timer.delay === 500));
        });

        it(engine + ' captures the viewer update in the same turn and keeps a hidden-page snapshot intact', async () => {
            const f = await fixture(engine); f.loaded();
            const position = { page: 5, offset: { left: 21, top: 90 }, pageSize: { width: 600, height: 800 } };
            f.view.position = position;
            f.bus.dispatch('updateviewarea');
            assert.deepStrictEqual(f.posts.filter((message: any) => message.type === 'saveState').at(-1)?.content.position, position);
            f.document.visibilityState = 'hidden'; f.document.dispatch('visibilitychange');
            assert.deepStrictEqual(f.writes.at(-1)?.position, position);
            f.container.offsetParent = null;
            f.view.position = { ...position, page: 0 };
            f.bus.dispatch('updateviewarea');
            f.document.dispatch('visibilitychange');
            assert.deepStrictEqual(f.writes.at(-1)?.position, position, 'hidden layout cannot replace the last visible reading state');
        });

        it(engine + ' captures a raw-scroll jump before currentPageNumber has caught up', async () => {
            const f = await fixture(engine); f.loaded();
            f.view.currentPageNumber = 3;
            f.container.getBoundingClientRect = () => ({ left: 100, top: 50 });
            f.view._getVisiblePages = () => ({ first: { id: 9, view: {
                div: { getBoundingClientRect: () => ({ left: 80, top: -210 }) },
                viewport: { viewBox: [0, 0, 600, 800], convertToPdfPoint: (x: number, y: number) => [x / 2, 800 - y / 2] },
            } } });
            f.container.dispatch('scroll');
            const state = f.posts.filter((message: any) => message.type === 'saveState').at(-1)?.content;
            assert.deepStrictEqual(state.position, { page: 8, offset: { left: 10, top: 670 }, pageSize: { width: 600, height: 800 } });
            assert.strictEqual(f.view.currentPageNumber, 3, 'capturing state does not change the viewer selection');
        });
    }

    it('Overleaf cancels a queued resize and ignores its retained callback after page closure', async () => {
        const f = await fixture('overleaf'); f.loaded();
        f.window.dispatch('resize');
        assert.strictEqual(f.timers.size, 1);
        const callback = [...f.timers.values()][0].callback;
        f.window.dispatch('pagehide', { persisted: false });
        assert.strictEqual(f.resizeDisconnected, 1);
        assert.strictEqual(f.timers.size, 0);
        callback();
        f.window.dispatch('resize');
        assert.strictEqual(f.resizeCalls, 0);
        assert.strictEqual(f.timers.size, 0);
    });

    it('PDF.js waits for its own startup event without a polling timer and cancels an unopened page', async () => {
        const f = await fixture('pdfjs', true);
        assert.strictEqual(f.timers.size, 0, 'waiting for webviewerloaded must own listeners, not a timer');
        const callbacks = [...(f.parentDocument.listeners.get('webviewerloaded') ?? [])] as ((event: any) => void)[];
        f.window.dispatch('pagehide', { persisted: false });
        f.window.PDFViewerApplication = f.application;
        for (const callback of callbacks) { callback({ detail: { source: f.window } }); }
        f.initialized.resolve();
        await Promise.resolve(); await Promise.resolve();
        assert.strictEqual(f.posts.length, 0);
        assert.strictEqual(f.workers, 0);
        assert.strictEqual(f.parentDocument.listeners.get('webviewerloaded')?.size ?? 0, 0);
        assert.strictEqual(f.document.listeners.get('webviewerloaded')?.size ?? 0, 0);
    });

    it('PDF.js configures its own startup once and waits for actual initialization', async () => {
        const f = await fixture('pdfjs', true);
        f.window.PDFViewerApplication = f.application;
        f.parentDocument.dispatch('webviewerloaded', { detail: { source: {} } });
        assert.strictEqual(f.posts.length, 0);
        const callbacks = [...(f.parentDocument.listeners.get('webviewerloaded') ?? [])] as ((event: any) => void)[];
        f.parentDocument.dispatch('webviewerloaded', { detail: { source: f.window } });
        assert.strictEqual(typeof f.application.zoomIn, 'function', 'options are installed before PDF.js run starts');
        assert.strictEqual(f.posts.length, 0, 'ready waits for initializedPromise');
        f.initialized.resolve(); await f.booted.promise;
        for (const callback of callbacks) { callback({ detail: { source: f.window } }); }
        assert.strictEqual(f.posts.filter((message: any) => message.type === 'ready').length, 1);
        assert.strictEqual(f.timers.size, 0);
        assert.strictEqual(f.parentDocument.listeners.get('webviewerloaded')?.size ?? 0, 0);
    });
});
