/* eslint-disable @typescript-eslint/naming-convention -- execute pinned PDF.js application methods */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

class Clock {
    time = 0;
    id = 0;
    jobs = new Map<number, { at: number; callback(): void }>();
    setTimeout = (callback: () => void, delay: number) => {
        const id = ++this.id;
        this.jobs.set(id, { at: this.time + delay, callback });
        return id;
    };
    clearTimeout = (id: number) => { this.jobs.delete(id); };
    advance(milliseconds: number) {
        const end = this.time + milliseconds;
        for (;;) {
            const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) { break; }
            this.time = next[1].at; this.jobs.delete(next[0]); next[1].callback();
        }
        this.time = end;
    }
}

describe('pinned PDF.js publication handoff', function () {
    this.timeout(30_000);
    let directory: string, lifecycle: any;
    const methods = new Map<string, string>();
    before(async () => {
        const { pdfjsRelease } = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
        const text = fs.readFileSync(path.join(pdfjsRelease, 'web/viewer.mjs'), 'utf8');
        const source = ts.createSourceFile('viewer.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        function visit(node: ts.Node) {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PDFViewerApplication') {
                assert.ok(node.initializer && ts.isObjectLiteralExpression(node.initializer));
                for (const property of node.initializer.properties) {
                    if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name)) {
                        methods.set(property.name.text, property.getText(source));
                    }
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
        for (const name of ['load', 'close', '_initializePdfHistory', 'setInitialView']) { assert.ok(methods.has(name), name); }
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-lifecycle-test-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/standalone/document-lifecycle.ts')],
                outfile: path.join(directory, 'lifecycle.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
            lifecycle = await importModule(path.join(directory, 'lifecycle.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    function fixture({ delayedFirstPage = false } = {}) {
        const clock = new Clock(), upstreamClock = new Clock();
        const hashes: string[] = [], historyCalls: string[] = [], events: string[] = [];
        const eventSources: unknown[] = [];
        const waits = new Map<string, { resolve(): void }>();
        const documents = new Map<any, ReturnType<typeof document>>();
        const state = { focus: 'reader', focuses: 0, input: 0, hash: '#page=4&zoom=90,12,350', closes: 0, releases: 0, updates: 0 };
        function document(id = 'edition') {
            const metadata = deferred<any>(), pages = deferred(), update = deferred(), download = deferred<{ length: number }>();
            const firstPage = deferred<any>();
            const doc = { numPages: 4, fingerprints: [id], annotationStorage: { size: 0 },
                getDownloadInfo: () => download.promise,
                getPageLayout: () => metadata.promise, getPageMode: async () => null, getOpenAction: async () => null };
            const result = { doc, metadata, pages, update, download, firstPage };
            documents.set(doc, result);
            return result;
        }
        class Viewer {
            #valid = true;
            pdfDocument: any;
            currentPageNumber = 1;
            currentScale = 1;
            scaleValue: string | number = '';
            pagesRotation = 0;
            scrollMode = 0;
            spreadMode = 0;
            container = { scrollLeft: 0, scrollTop: 0 };
            firstPagePromise: Promise<any> = Promise.resolve({});
            onePageRendered = new Promise(() => {});
            pagesPromise = Promise.resolve();
            get currentScaleValue() { assert.ok(this.#valid); return this.scaleValue; }
            set currentScaleValue(value) { assert.ok(this.#valid); this.scaleValue = value; }
            get hasEqualPageSizes() { assert.ok(this.#valid); return false; }
            setDocument(value: any) {
                assert.ok(this.#valid);
                this.pdfDocument = value;
                this.currentPageNumber = 1; this.currentScaleValue = '';
                this.pagesPromise = value ? documents.get(value)!.pages.promise : Promise.resolve();
                this.firstPagePromise = value && delayedFirstPage ? documents.get(value)!.firstPage.promise : Promise.resolve({});
            }
            focus() { assert.ok(this.#valid); state.focus = 'reader'; state.focuses++; }
            update() { assert.ok(this.#valid); state.updates++; documents.get(this.pdfDocument)?.update.resolve(); }
        }
        const viewer = new Viewer();
        const environment: Record<string, unknown> = {
            ViewHistory: class { async getMultiple() { return {}; } },
            AppOptions: { get: (key: string) => ({ viewOnLoad: 0, sidebarViewOnLoad: -1, scrollModeOnLoad: -1,
                spreadModeOnLoad: -1, historyUpdateUrl: true } as Record<string, unknown>)[key] },
            SidebarView: { UNKNOWN: -1 }, ScrollMode: { UNKNOWN: -1 }, SpreadMode: { UNKNOWN: -1 },
            ViewOnLoad: { INITIAL: 1, UNKNOWN: -1 }, DEFAULT_SCALE_VALUE: 'auto',
            animationStarted: Promise.resolve(0), FORCE_PAGES_LOADED_TIMEOUT: 10_000,
            setTimeout: upstreamClock.setTimeout,
            isValidRotation: (value: unknown) => typeof value === 'number' && value % 90 === 0,
            isValidScrollMode: (value: unknown) => typeof value === 'number' && value >= 0 && value <= 3,
            isValidSpreadMode: (value: unknown) => typeof value === 'number' && value >= 0 && value <= 2,
            apiPageModeToSidebarView: () => 0, apiPageLayoutToViewerModes: () => ({ spreadMode: 0 }),
        };
        const method = (name: string) => new Function(...Object.keys(environment), 'return ({' + methods.get(name) + '}).' + name)(...Object.values(environment));
        const app: any = {
            pdfDocument: null, pdfLoadingTask: null, pdfViewer: viewer, initialBookmark: null, initialRotation: null,
            appConfig: { viewerContainer: {} }, isInitialViewSet: false, initialViewHistory: {},
            pdfSidebar: { visibleView: 0, setInitialView(value: number) { this.visibleView = value; }, reset() {} },
            pdfHistory: {
                initialBookmark: undefined as string | undefined, initialRotation: 0,
                initialize({ fingerprint }: { fingerprint: string }) {
                    historyCalls.push(fingerprint);
                    this.initialBookmark = 'page=2&zoom=30,0,0'; this.initialRotation = 180;
                },
                reset() {},
            },
            pdfLinkService: {
                externalLinkEnabled: true, setDocument() {},
                setHash(hash: string) {
                    hashes.push(hash);
                    const params = new URLSearchParams(hash), zoom = params.get('zoom')!.split(',');
                    viewer.currentPageNumber = Number(params.get('page')); viewer.currentScale = Number(zoom[0]) / 100;
                    viewer.currentScaleValue = String(viewer.currentScale); state.hash = '#' + hash;
                },
            },
            eventBus: { dispatch(name: string, data: { source?: unknown }) {
                events.push(name); eventSources.push(data?.source); waits.get(name)?.resolve();
            } },
            pdfScriptingManager: { destroyPromise: Promise.resolve() }, passwordPrompt: { close: async () => {} },
            _unblockDocumentLoadEvent() {}, _hideViewBookmark() {}, setTitle() {},
            _initializeAnnotationStorageCallbacks() {}, _initializePageLabels() {}, _initializeMetadata() {}, _initializeAutoPrint() {},
            externalServices: { reportTelemetry() {} }, _documentError(error: unknown) { throw error; },
        };
        Object.defineProperty(app, 'isViewerEmbedded', { get() { assert.strictEqual(this, app); return false; } });
        for (const name of ['load', '_initializePdfHistory', 'setInitialView']) { app[name] = method(name); }
        const close = method('close');
        app.close = function () { state.closes++; return close.call(this); };
        const handle = lifecycle.createSiteDocumentLifecycle(app, { clock, viewHash: () => state.hash, inputVersion: () => state.input });
        const view = { hash: 'page=4&zoom=90%2C12%2C350', rotation: 90, sidebarView: 2, scrollMode: 1, spreadMode: 2 };
        function nextEvent(name: string) { const ready = deferred(); waits.set(name, ready); return ready.promise; }
        function oldBook(saving = false) {
            const old = document('old'), shutdown = deferred(), saved = deferred();
            old.doc.annotationStorage.size = saving ? 1 : 0;
            app.pdfDocument = old.doc; viewer.setDocument(old.doc);
            app.pdfLoadingTask = { destroy: () => shutdown.promise };
            app._annotationStorageModified = saving;
            app.save = () => saved.promise;
            const previous = { destroy() { state.releases++; } };
            return { ...old, shutdown, saved, previous, task: app.pdfLoadingTask };
        }
        const dispose = () => { handle.dispose(); clock.jobs.clear(); upstreamClock.jobs.clear(); };
        function readyFirstPage(value: ReturnType<typeof document>) {
            assert.strictEqual(viewer.pdfDocument, value.doc);
            // setDocument constructs the first page and emits pagesinit before load's
            // firstPagePromise continuation. Its initial update replaces the old hash.
            viewer.currentPageNumber = 1; viewer.currentScale = 1; viewer.currentScaleValue = '';
            viewer.container.scrollLeft = 0; viewer.container.scrollTop = 0;
            state.hash = '#page=1&zoom=100,0,0';
            app.eventBus.dispatch('pagesinit', { source: viewer });
            value.firstPage.resolve({});
        }
        return { app, viewer, handle, clock, upstreamClock, hashes, historyCalls, events, eventSources, state, view,
            document, nextEvent, oldBook, readyFirstPage, dispose };
    }

    it('preserves captured coordinates and modes through history and both unequal-page initial-view passes', async () => {
        const f = fixture(), next = f.document();
        try {
            f.handle.load(next.doc, { view: f.view, automatic: true });
            const initialized = f.nextEvent('documentinit');
            next.metadata.resolve(null); await initialized;
            next.pages.resolve(); await next.update.promise;
            assert.deepStrictEqual(f.historyCalls, ['edition'], 'normal history initialization still runs');
            assert.deepStrictEqual(f.hashes, [f.view.hash, f.view.hash]);
            assert.ok(f.eventSources.length > 0);
            assert.ok(f.eventSources.every(source => source === f.app), 'application events retain their real source instance');
            assert.strictEqual(f.viewer.currentPageNumber, 4); assert.strictEqual(f.viewer.currentScale, 0.9);
            assert.strictEqual(f.viewer.pagesRotation, 90); assert.strictEqual(f.viewer.scrollMode, 1); assert.strictEqual(f.viewer.spreadMode, 2);
            assert.strictEqual(f.app.pdfSidebar.visibleView, 2);
        } finally { f.dispose(); }
    });

    it('keeps explicit focus usable and does not steal newly started input after delayed metadata', async () => {
        for (const inputBeforeFirstPage of [true, false]) {
            const f = fixture({ delayedFirstPage: true }), next = f.document();
            try {
                f.handle.load(next.doc, { view: f.view, automatic: true });
                f.app.pdfViewer.focus();
                assert.strictEqual(f.state.focuses, 1, 'the real viewer still handles an explicit focus call');
                if (inputBeforeFirstPage) { f.state.focus = 'search-input'; f.state.input++; }
                f.readyFirstPage(next); await flush();
                if (!inputBeforeFirstPage) { f.state.focus = 'search-input'; f.state.input++; }
                const initialized = f.nextEvent('documentinit');
                next.metadata.resolve(null); await initialized;
                assert.strictEqual(f.state.focus, 'search-input'); assert.strictEqual(f.state.focuses, 1);
                next.pages.resolve(); await next.update.promise;
                assert.deepStrictEqual(f.hashes, [f.view.hash, f.view.hash], 'search focus does not adopt temporary page 1');
            } finally { f.dispose(); }
        }
    });

    it('keeps actual navigation entered after first-page setup but before delayed metadata through both passes', async () => {
        const f = fixture({ delayedFirstPage: true }), next = f.document();
        try {
            f.handle.load(next.doc, { view: f.view, automatic: true });
            f.readyFirstPage(next); await flush();
            assert.deepStrictEqual(f.hashes, [], 'metadata has not applied any initial view');
            f.viewer.currentPageNumber = 3; f.viewer.currentScale = 1.2; f.viewer.currentScaleValue = '1.2';
            f.viewer.pagesRotation = 270; f.viewer.scrollMode = 0; f.viewer.spreadMode = 1;
            f.viewer.container.scrollLeft = 24; f.viewer.container.scrollTop = 180;
            f.state.hash = '#page=3&zoom=120,24,180'; f.state.input++;
            const initialized = f.nextEvent('documentinit');
            next.metadata.resolve(null); await initialized;
            next.pages.resolve(); await next.update.promise;
            assert.strictEqual(f.viewer.currentPageNumber, 3); assert.strictEqual(f.viewer.currentScale, 1.2);
            assert.strictEqual(f.viewer.pagesRotation, 270); assert.strictEqual(f.viewer.spreadMode, 1);
            assert.deepStrictEqual(f.hashes.map(hash => new URLSearchParams(hash).get('zoom')), ['120,24,180', '120,24,180']);
            assert.ok(f.hashes.every(hash => new URLSearchParams(hash).get('page') === '3'));
        } finally { f.dispose(); }
    });

    it('keeps navigation entered after the first pass when mixed page sizes finish initializing', async () => {
        const f = fixture(), next = f.document();
        try {
            f.handle.load(next.doc, { view: f.view, automatic: true });
            const initialized = f.nextEvent('documentinit');
            next.metadata.resolve(null); await initialized;
            f.viewer.currentPageNumber = 3; f.viewer.currentScale = 1.2; f.viewer.currentScaleValue = '1.2';
            f.viewer.pagesRotation = 270; f.viewer.scrollMode = 0; f.viewer.spreadMode = 1;
            f.state.hash = '#page=3&zoom=120,24,180'; f.state.input++;
            next.pages.resolve(); await next.update.promise;
            assert.strictEqual(f.viewer.currentPageNumber, 3); assert.strictEqual(f.viewer.currentScale, 1.2);
            assert.strictEqual(f.viewer.pagesRotation, 270); assert.strictEqual(f.viewer.spreadMode, 1);
            assert.strictEqual(new URLSearchParams(f.hashes.at(-1)).get('zoom'), '120,24,180');
        } finally { f.dispose(); }
    });

    it('rejects delayed callbacks from a replaced or disposed load without changing the current viewer', async () => {
        const f = fixture(), old = f.document('old'), next = f.document('next');
        try {
            f.handle.load(old.doc, { view: f.view, automatic: true });
            f.handle.load(next.doc, { view: f.view, automatic: true });
            old.metadata.resolve(null); old.pages.resolve(); await flush();
            assert.deepStrictEqual(f.hashes, []); assert.deepStrictEqual(f.historyCalls, []);
            assert.deepStrictEqual(f.events, []); assert.strictEqual(f.state.updates, 0);
            f.handle.dispose(); next.metadata.resolve(null); next.pages.resolve(); await flush();
            assert.deepStrictEqual(f.hashes, []); assert.strictEqual(f.state.focuses, 0);
        } finally { f.dispose(); }
    });

    it('allows the explicit initial load to focus the real viewer', async () => {
        const f = fixture(), next = f.document();
        try {
            f.handle.load(next.doc, { automatic: false });
            const initialized = f.nextEvent('documentinit');
            next.metadata.resolve(null); await initialized;
            assert.strictEqual(f.state.focuses, 1);
            next.pages.resolve(); await next.update.promise;
        } finally { f.dispose(); }
    });

    it('fences delayed application property writes against an independently changed document', async () => {
        const f = fixture(), old = f.document('old'), next = f.document('external');
        try {
            f.handle.load(old.doc, { view: f.view, automatic: true });
            f.app.pdfDocument = next.doc; f.app._contentLength = 123;
            old.download.resolve({ length: 999 }); old.metadata.resolve(null); old.pages.resolve();
            await flush();
            assert.strictEqual(f.app._contentLength, 123);
            assert.deepStrictEqual(f.events, []); assert.deepStrictEqual(f.hashes, []);
        } finally { f.dispose(); }
    });

    it('bounds a detached worker close, releases only its old owner, and ignores late completion after adoption', async () => {
        const f = fixture(), old = f.oldBook();
        try {
            let settled = false;
            const closing = f.handle.close(old.previous).then(() => { settled = true; });
            assert.strictEqual(f.app.pdfDocument, null);
            f.clock.advance(lifecycle.SITE_DOCUMENT_DESTROY_TIMEOUT_MS); await flush();
            assert.strictEqual(settled, true); assert.strictEqual(f.state.releases, 1); assert.strictEqual(f.clock.jobs.size, 0);
            await closing;
            const next = f.document('next'); f.app.pdfLoadingTask = { next: true };
            f.handle.load(next.doc, { view: f.view, automatic: true });
            old.shutdown.resolve(); await flush();
            assert.strictEqual(f.app.pdfDocument, next.doc); assert.deepStrictEqual(f.app.pdfLoadingTask, { next: true });
            assert.strictEqual(f.state.releases, 1);
        } finally { f.dispose(); }
    });

    it('cancels a pending close promptly on pagehide or request abort and clears its timer', async () => {
        for (const dispose of [false, true]) {
            const f = fixture(), old = f.oldBook(), controller = new AbortController();
            try {
                let result: unknown;
                const closing = f.handle.close(old.previous, controller.signal).catch((error: unknown) => { result = error; });
                if (dispose) { f.handle.dispose(); } else { controller.abort(); }
                await flush();
                assert.strictEqual((result as Error)?.name, 'AbortError');
                assert.strictEqual(f.clock.jobs.size, 0); assert.strictEqual(f.state.releases, 1);
                old.shutdown.resolve(); await closing;
            } finally { f.dispose(); }
        }
    });

    it('keeps one pre-detach close and reports a retryable timeout before a later save can finish', async () => {
        const f = fixture(), old = f.oldBook(true);
        try {
            let failure: unknown;
            const first = f.handle.close(old.previous).catch((error: unknown) => { failure = error; });
            f.clock.advance(lifecycle.SITE_DOCUMENT_DESTROY_TIMEOUT_MS); await flush();
            assert.ok(failure instanceof Error); assert.strictEqual(f.state.closes, 1);
            assert.strictEqual(f.app.pdfDocument, old.doc); assert.strictEqual(f.state.releases, 0);
            await first;
            const second = f.handle.close(old.previous);
            assert.strictEqual(f.state.closes, 1, 'a retry joins the same old close');
            old.saved.resolve(); old.shutdown.resolve(); await second;
            assert.strictEqual(f.app.pdfDocument, null); assert.strictEqual(f.state.releases, 1); assert.strictEqual(f.clock.jobs.size, 0);
        } finally { f.dispose(); }
    });

    it('does not close a healthy old document for an already canceled commit', async () => {
        const f = fixture(), old = f.oldBook(), controller = new AbortController();
        try {
            controller.abort();
            let failure: unknown;
            const result = f.handle.close(old.previous, controller.signal).catch((error: unknown) => { failure = error; });
            await flush();
            assert.strictEqual((failure as Error)?.name, 'AbortError');
            assert.strictEqual(f.state.closes, 0); assert.strictEqual(f.app.pdfDocument, old.doc);
            old.shutdown.resolve(); await result;
        } finally { f.dispose(); }
    });
});
