import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// tsc turns import() into require(), which cannot load ES modules.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
// Completing an explicit fake request schedules promise continuations. One event-loop turn
// lets those continuations run before the next simulated animation frame.
const promisesSettled = () => new Promise<void>(resolve => setImmediate(resolve));

class Events {
    readonly listeners = new Map<string, Set<(event: any) => void>>();
    addEventListener(name: string, listener: (event: any) => void) {
        if (!this.listeners.has(name)) { this.listeners.set(name, new Set()); }
        this.listeners.get(name)!.add(listener);
    }
    removeEventListener(name: string, listener: (event: any) => void) {
        this.listeners.get(name)?.delete(listener);
    }
    on(name: string, listener: (event: any) => void) { this.addEventListener(name, listener); }
    off(name: string, listener: (event: any) => void) { this.removeEventListener(name, listener); }
    emit(name: string, detail: Record<string, unknown> = {}) {
        const event = { type: name, target: this, currentTarget: this, ...detail };
        for (const listener of [...(this.listeners.get(name) ?? [])]) { listener(event); }
    }
    get listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

class Element extends Events {
    readonly style: Record<string, string> = {};
    readonly children: Element[] = [];
    readonly attributes = new Map<string, string>();
    parentNode: Element | null = null;
    className = '';
    ownerDocument: any;
    dir = '';
    clientWidth = 800;
    clientHeight = 1000;
    scrollTop = 0;
    scrollLeft = 0;
    prepend(child: Element) {
        child.remove();
        child.parentNode = this;
        this.children.unshift(child);
    }
    remove() {
        if (this.parentNode) {
            this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
            this.parentNode = null;
        }
    }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    getBoundingClientRect() {
        return { x: 0, y: 0, left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
    }
}

class Canvas extends Element {
    width = 0;
    height = 0;
    copies = 0;
    readonly context = { canvas: this, drawImage: () => { this.copies++; } };
    getContext(kind: string) { assert.strictEqual(kind, '2d'); return this.context; }
}

interface RobotDelivery {
    pageNumber: number;
    pageElement: Element;
    canvas: Canvas;
    kind: 'preview' | 'page';
}

class DocumentRobots {
    enabled = true;
    readonly deliveries: RobotDelivery[] = [];
    readonly visibleCalls: number[][] = [];
    readonly enabledCalls: boolean[] = [];
    readonly active = new Set<number>();
    resetCalls = 0;
    disposeCalls = 0;
    setEnabled(value: boolean) {
        this.enabled = value;
        this.enabledCalls.push(value);
        if (!value) { this.active.clear(); }
    }
    setVisiblePages(ids: readonly number[]) {
        this.visibleCalls.push([...ids]);
        for (const id of this.active) { if (!ids.includes(id)) { this.active.delete(id); } }
    }
    deliver(value: RobotDelivery) {
        // Deliberately do not deduplicate: the controller must emit one real delivery,
        // rather than relying on the animation module to reject repeated callbacks.
        this.deliveries.push(value);
        this.active.add(value.pageNumber);
        return true;
    }
    reset() { this.resetCalls++; this.active.clear(); }
    snapshot() { return { enabled: this.enabled, activeEpisodes: this.active.size }; }
    setDispatchOrigin() {}
    dispose() { this.disposeCalls++; this.enabled = false; this.active.clear(); }
}

class Deferred<T> {
    readonly promise: Promise<T>;
    settled = false;
    private answer!: (value: T) => void;
    private fail!: (error: unknown) => void;
    constructor() {
        this.promise = new Promise<T>((resolve, reject) => { this.answer = resolve; this.fail = reject; });
    }
    resolve(value: T) { if (!this.settled) { this.settled = true; this.answer(value); } }
    reject(error: unknown) { if (!this.settled) { this.settled = true; this.fail(error); } }
}

class Fetches {
    readonly pending = new Map<number, number>();
    readonly listeners = new Set<() => void>();
    now: () => number = () => 0;
    private next = 0;
    get pendingFetchCount() { return this.pending.size; }
    get oldestFetchMs() { return this.pending.size ? Math.max(0, this.now() - Math.min(...this.pending.values())) : 0; }
    begin(start = this.now()) {
        const id = ++this.next;
        this.pending.set(id, start);
        for (const listener of this.listeners) { listener(); }
        return id;
    }
    end(id: number) {
        if (!this.pending.delete(id)) { return; }
        for (const listener of this.listeners) { listener(); }
    }
    onFetchChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    event() {}
    snapshot() { return { pendingFetchCount: this.pendingFetchCount, oldestFetchMs: this.oldestFetchMs }; }
    reset() { this.pending.clear(); this.next = 0; this.now = () => 0; }
}

class RenderTask {
    readonly completion = new Deferred<void>();
    readonly promise = this.completion.promise;
    onContinue?: (resume: () => void) => void;
    cancellationCalls = 0;
    // Used to deliver a completion that was already queued when cancellation happened.
    completeAfterCancellation = false;
    cancel() {
        this.cancellationCalls++;
        if (!this.completeAfterCancellation) {
            const error = new Error('render cancelled');
            error.name = 'RenderingCancelledException';
            this.completion.reject(error);
        }
    }
    finish() { this.completion.resolve(); }
}

class PdfPage {
    cleanupCalls = 0;
    readonly _intentStates = new Map<string, object>();
    readonly objs = new Map<string, any>();
    private cleanupPending = false;
    constructor(readonly document: PdfDocument, readonly pageNumber: number) {}
    get commonObjs() { return this.document.commonObjs; }
    getViewport({ scale, rotation }: { scale: number, rotation: number }) {
        return { width: this.document.width * scale, height: this.document.height * scale, scale, rotation };
    }
    render(parameters: any) {
        this.retainDisplayIntent();
        const task = new RenderTask();
        this.document.renders.push({ id: this.pageNumber, page: this, task, parameters });
        this.document.maxActive = Math.max(this.document.maxActive, this.document.activeRenders.length);
        void task.promise.then(() => this.tryCleanup(), () => this.tryCleanup());
        return task;
    }
    retainDisplayIntent() { this.cleanupPending = false; this._intentStates.set('display', {}); }
    cleanup() { this.cleanupCalls++; this.cleanupPending = true; return this.tryCleanup(); }
    private tryCleanup() {
        if (!this.cleanupPending || this.document.activeRenders.some(render => render.page === this)) { return false; }
        this._intentStates.clear();
        this.objs.clear();
        this.cleanupPending = false;
        return true;
    }
}

class PdfDocument {
    readonly requests: Array<{ id: number, result: Deferred<PdfPage> }> = [];
    readonly renders: Array<{ id: number, page: PdfPage, task: RenderTask, parameters: any }> = [];
    readonly pages = new Map<number, PdfPage>();
    readonly commonObjs = new Map<string, any>();
    maxActive = 0;
    constructor(readonly width = 800, readonly height = 1000, readonly autoPages = true) {}
    page(id: number) {
        if (!this.pages.has(id)) { this.pages.set(id, new PdfPage(this, id)); }
        return this.pages.get(id)!;
    }
    getPage(id: number) {
        const result = new Deferred<PdfPage>();
        this.requests.push({ id, result });
        if (this.autoPages) { result.resolve(this.page(id)); }
        return result.promise;
    }
    answerAll() {
        for (const request of this.requests) { request.result.resolve(this.page(request.id)); }
    }
    get activeRenders() { return this.renders.filter(render => !render.task.completion.settled); }
}

class PageView {
    readonly div = new Element();
    readonly installed: PdfPage[] = [];
    renderingState = 0;
    canvas: Canvas | null = null;
    pdfPage?: PdfPage;
    resetCalls = 0;
    destroyCalls = 0;
    readonly maxCanvasPixels = 16_777_216;
    get renderingId() { return 'page' + this.id; }
    constructor(readonly id: number, readonly width: number, readonly height: number, readonly fixture: Fixture) {
        this.div.ownerDocument = fixture.owner;
        this.div.getBoundingClientRect = () => {
            const top = (id - 1) * height - fixture.container.scrollTop;
            return { x: 0, y: top, left: 0, top, right: width, bottom: top + height, width, height };
        };
    }
    setPdfPage(page: PdfPage) { this.pdfPage = page; this.installed.push(page); this.reset(); }
    reset() {
        this.resetCalls++;
        this.renderingState = 0;
        this.canvas = null;
        for (const child of [...this.div.children]) { child.remove(); }
    }
    destroy() { this.destroyCalls++; this.reset(); this.pdfPage?.cleanup(); }
}

interface FixtureOptions { startPage?: number, pages?: number, width?: number, height?: number, autoPages?: boolean, mobile?: boolean }

class Fixture {
    readonly owner = Object.assign(new Events(), { visibilityState: 'visible', defaultView: { devicePixelRatio: 1, navigator: { userAgent: 'desktop test reader', maxTouchPoints: 0 } } });
    readonly container = new Element();
    readonly eventBus = new Events();
    readonly callbacks = new Map<number, (timestamp: number) => void>();
    readonly canvases: Canvas[] = [];
    createCanvas = () => new Canvas();
    readonly cached = new Set<PageView>();
    readonly nativeRenders: any[] = [];
    readonly nativeFencePages: number[][] = [];
    readonly idleChanges: boolean[] = [];
    pages: PageView[];
    visibleIds?: number[];
    pdf: PdfDocument;
    time = 1000;
    nextFrame = 1;
    updates = 0;
    renderRequests = 0;
    readonly queue: any;
    readonly viewer: any;
    readonly originalPriority: (...args: any[]) => any;
    readonly originalRenderView: (...args: any[]) => any;
    controller: any;

    constructor(options: FixtureOptions = {}) {
        if (options.mobile) { this.owner.defaultView.navigator = { userAgent: 'iPhone', maxTouchPoints: 5 }; }
        const count = options.pages ?? 100;
        const width = options.width ?? 800;
        const height = options.height ?? 1000;
        this.pdf = new PdfDocument(width, height, options.autoPages ?? true);
        this.container.ownerDocument = this.owner;
        this.container.clientWidth = width;
        this.container.clientHeight = height;
        this.container.scrollTop = ((options.startPage ?? 20) - 1) * height;
        this.pages = Array.from({ length: count }, (_, index) => new PageView(index + 1, width, height, this));
        this.queue = {
            isViewFinished: (view: PageView) => view.renderingState === 3,
            getHighestPriority: function (this: any, visible: any, views: PageView[], down: boolean) {
                for (const entry of visible.views) { if (!this.isViewFinished(entry.view)) { return entry.view; } }
                for (let id = visible.first.id + 1; id < visible.last.id; id++) {
                    if (!visible.ids.has(id) && !this.isViewFinished(views[id - 1])) { return views[id - 1]; }
                }
                const next = down ? visible.last.id : visible.first.id - 2;
                return views[next] && !this.isViewFinished(views[next]) ? views[next] : null;
            },
            renderView: (view: any) => {
                this.nativeFencePages.push(this.pdf.activeRenders.map(render => render.id));
                this.nativeRenders.push(view);
                return true;
            },
            renderHighestPriority: () => { this.renderRequests++; },
        };
        this.originalPriority = this.queue.getHighestPriority;
        this.originalRenderView = this.queue.renderView;
        this.viewer = {
            container: this.container, eventBus: this.eventBus, renderingQueue: this.queue,
            pdfDocument: this.pdf, pagesCount: count, pagesRotation: 0, scrollMode: 0, spreadMode: 0,
            scroll: { down: true },
            getPageView: (index: number) => this.pages[index],
            getCachedPageViews: () => this.cached,
            _getVisiblePages: () => this.visible(),
            update: () => {
                this.updates++;
                this.eventBus.emit('updateviewarea', { source: this.viewer });
                this.queue.renderHighestPriority(this.visible());
            },
        };
        Object.defineProperty(this.viewer, 'currentPageNumber', { get: () => this.visible().first.id });
        this.cachePage(this.visible().first.id);
    }

    install(module: any, overrides: Record<string, unknown> = {}) {
        this.controller = module.installPdfPrefetch(this.viewer, {
            robotsEnabled: false,
            onIdleChange: (idle: boolean) => this.idleChanges.push(idle),
            now: () => this.time,
            requestFrame: (callback: (timestamp: number) => void) => {
                const id = this.nextFrame++;
                this.callbacks.set(id, callback);
                return id;
            },
            cancelFrame: (id: number) => this.callbacks.delete(id),
            createCanvas: () => {
                const canvas = this.createCanvas();
                canvas.ownerDocument = this.owner;
                this.canvases.push(canvas);
                return canvas;
            },
            ...overrides,
        });
    }

    visible() {
        const top = this.container.scrollTop;
        const bottom = top + this.container.clientHeight;
        const pages = this.visibleIds ? this.visibleIds.map(id => this.pages[id - 1])
            : this.pages.filter(page => page.id * page.height > top && (page.id - 1) * page.height < bottom);
        const views = pages
            .map(view => ({ id: view.id, view, percent: 100, widthPercent: 100, x: 0, y: (view.id - 1) * view.height }));
        return { first: views[0], last: views[views.length - 1], views, ids: new Set(views.map(view => view.id)) };
    }

    async frame(milliseconds = 16) {
        this.time += milliseconds;
        const callbacks = [...this.callbacks.values()];
        this.callbacks.clear();
        for (const callback of callbacks) { callback(this.time); }
        await promisesSettled();
    }

    scrollBy(delta: number) {
        this.time += 16;
        this.container.emit('wheel', { deltaY: delta, deltaX: 0, deltaMode: 0, ctrlKey: false, metaKey: false });
        this.container.scrollTop = Math.max(0, Math.min((this.pages.length - 1) * this.pdf.height, this.container.scrollTop + delta));
        this.viewer.scroll.down = delta > 0;
        this.container.emit('scroll');
    }

    choose() { return this.queue.getHighestPriority(this.visible(), this.pages, this.viewer.scroll.down); }

    cachePage(id: number) {
        const page = this.pages[id - 1];
        page.renderingState = 3;
        page.pdfPage = this.pdf.page(id);
        page.pdfPage.retainDisplayIntent();
        page.canvas = new Canvas();
        page.canvas.width = page.width;
        page.canvas.height = page.height;
        this.cached.delete(page);
        this.cached.add(page);
        // The scheduler's full-resolution plan must fit a finite native page buffer.
        while (this.cached.size > 8) {
            const visible = this.visible().ids;
            const oldest = [...this.cached].find(candidate => !visible.has(candidate.id))!;
            this.cached.delete(oldest);
            oldest.destroy();
        }
    }

    finishNative(id: number) {
        this.eventBus.emit('pagerender', { pageNumber: id });
        this.time += 12;
        this.cachePage(id);
        this.eventBus.emit('pagerendered', { pageNumber: id, error: null, cssTransform: false });
    }

    replaceDocument() {
        this.eventBus.emit('pagesdestroy');
        this.pdf = new PdfDocument(this.pdf.width, this.pdf.height);
        this.viewer.pdfDocument = this.pdf;
        this.pages = this.pages.map(page => new PageView(page.id, page.width, page.height, this));
        this.cached.clear();
        this.cachePage(this.visible().first.id);
        this.eventBus.emit('pagesinit');
    }

    get listenerCount() { return this.owner.listenerCount + this.container.listenerCount + this.eventBus.listenerCount; }
    dispose() { this.controller?.dispose(); }
}

describe('the PDF viewers\' shared prefetch controller', function () {
    this.timeout(30 * 1000);
    let directory: string | undefined;
    let module: any;
    const fixtures: Fixture[] = [];
    const fetches = new Fetches();
    const timers = new Map<number, { callback: () => void, delay: number }>();
    let timerId = 0;
    let savedSetTimeout: PropertyDescriptor | undefined;
    let savedClearTimeout: PropertyDescriptor | undefined;

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-prefetch-'));
        const output = path.join(directory, 'prefetch.mjs');
        // Diagnostics has its own DOM and timers. The shared controller uses a deterministic
        // fetch source here so canvas cancellation cannot silently finish a network request.
        const diagnostics = {
            name: 'prefetch-test-diagnostics',
            setup(build: any) {
                build.onResolve({ filter: /^\.\/prefetch-performance$/ }, () => ({ path: 'diagnostics', namespace: 'prefetch-test' }));
                build.onLoad({ filter: /.*/, namespace: 'prefetch-test' }, () => ({
                    contents: `export const pdfPerformance = globalThis.__pdfPrefetchTestPerformance;
                        export function installPrefetchDiagnostics(container, sample, options = {}) {
                            let enabled = options.enabled === true;
                            return {
                                get enabled() { return enabled; },
                                toggle() { enabled = !enabled; },
                                setEnabled(value) { enabled = value; },
                                setRobotsEnabled(value) { options.robots?.setEnabled(value); },
                                get robotsEnabled() { return options.robots?.enabled ?? false; },
                                labSnapshot() { return undefined; },
                                dispose() {},
                            };
                        }`,
                    loader: 'js',
                }));
            },
        };
        try {
            await esbuild.build({ ...bundleOptions, plugins: [diagnostics, ...bundleOptions.plugins], entryPoints: [path.join(viewerRoot, 'src', 'common', 'pdf-prefetch.ts')], outfile: output });
        } finally { await esbuild.stop(); }
        const previous = Object.getOwnPropertyDescriptor(globalThis, '__pdfPrefetchTestPerformance');
        Object.defineProperty(globalThis, '__pdfPrefetchTestPerformance', { configurable: true, value: fetches });
        try { module = await importModule(output); }
        finally {
            if (previous) { Object.defineProperty(globalThis, '__pdfPrefetchTestPerformance', previous); }
            else { delete (globalThis as any).__pdfPrefetchTestPerformance; }
        }
    });

    beforeEach(() => {
        timerId = 0;
        timers.clear();
        fetches.reset();
        savedSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
        savedClearTimeout = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout');
        Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; } });
        Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, writable: true, value: (id: number) => timers.delete(id) });
    });

    afterEach(() => {
        try {
            for (const fixture of fixtures.splice(0)) { fixture.dispose(); }
            assert.strictEqual(timers.size, 0, 'disposal clears the idle timers');
            assert.strictEqual(fetches.listeners.size, 0, 'disposal removes fetch change subscriptions');
        } finally {
            Object.defineProperty(globalThis, 'setTimeout', savedSetTimeout!);
            Object.defineProperty(globalThis, 'clearTimeout', savedClearTimeout!);
        }
    });

    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    function fixture(options: FixtureOptions = {}, installOverrides: Record<string, unknown> = {}) {
        const result = new Fixture(options);
        fixtures.push(result);
        fetches.now = () => result.time;
        result.install(module, installOverrides);
        return result;
    }

    function robotFixture(enabled = true) {
        const robots = new DocumentRobots();
        const factories: Element[] = [];
        const f = fixture({}, {
            robotsEnabled: enabled,
            createDocumentRobots: (container: Element) => { factories.push(container); return robots; },
        });
        return { f, robots, factories };
    }

    async function visibleRobotPreview() {
        const state = robotFixture();
        const { f } = state;
        await f.frame();
        const render = f.pdf.activeRenders.find(candidate => candidate.id === 21)!;
        assert.ok(render, 'the real controller starts the next page preparation');
        f.scrollBy(1000);
        await f.frame();
        assert.ok(f.controller.snapshot().visibleMissing.includes(21));
        render.task.finish();
        await promisesSettled();
        await f.frame();
        return { ...state, render };
    }

    it('delivers the real retained visible preview to document robots once, including after native completion', async () => {
        const { f, robots, factories, render } = await visibleRobotPreview();
        assert.strictEqual(robots.deliveries.length, 1, 'the newly covered visible page starts one delivery');
        const delivery = robots.deliveries[0];
        const canvas = render.parameters.canvasContext.canvas;
        assert.deepStrictEqual(factories, [f.container], 'one lazy robot instance belongs to the PDF scroll container');
        assert.strictEqual(delivery.pageNumber, 21);
        assert.strictEqual(delivery.kind, 'preview');
        assert.strictEqual(delivery.canvas, canvas, 'cargo comes from the actual completed preparation');
        assert.strictEqual(delivery.pageElement, f.pages[20].div);
        assert.strictEqual(canvas.parentNode, f.pages[20].div, 'the same retained pixels cover the visible page');
        assert.ok(canvas.width > 0 && canvas.height > 0);
        assert.ok(robots.visibleCalls.some(ids => ids.includes(21)));
        f.finishNative(21);
        await f.frame();
        assert.strictEqual(robots.deliveries.length, 1, 'native replacement of a delivered preview does not replay the episode');
    });

    it('keeps document robots silent for already-covered pages and offscreen prefetch completions', async () => {
        const { f, robots, factories } = robotFixture();
        await f.frame();
        assert.deepStrictEqual(factories, [f.container]);
        assert.deepStrictEqual(robots.deliveries, [], 'the initially finished page is already covered');
        const render = f.pdf.activeRenders.find(candidate => candidate.id === 21)!;
        render.task.finish();
        await promisesSettled();
        await f.frame();
        assert.deepStrictEqual(robots.deliveries, [], 'offscreen preparation does not create an animation');
        f.scrollBy(1000);
        await f.frame();
        assert.strictEqual(render.parameters.canvasContext.canvas.parentNode, f.pages[20].div);
        f.finishNative(21);
        await f.frame();
        assert.deepStrictEqual(robots.deliveries, [], 'returning to ready pixels is immediately covered without an episode');
    });

    it('delivers a newly finished visible native page to document robots when no preview covered it', async () => {
        const { f, robots } = robotFixture();
        await f.frame();
        f.scrollBy(1000);
        await f.frame();
        assert.ok(f.controller.snapshot().visibleMissing.includes(21));
        f.finishNative(21);
        await f.frame();
        assert.strictEqual(robots.deliveries.length, 1);
        assert.strictEqual(robots.deliveries[0].kind, 'page');
        assert.strictEqual(robots.deliveries[0].pageElement, f.pages[20].div);
        assert.strictEqual(robots.deliveries[0].canvas, f.pages[20].canvas, 'native cargo uses the completed page canvas');
        const render = f.pdf.activeRenders.find(candidate => candidate.id === 21)!;
        render.task.finish();
        await promisesSettled();
        await f.frame();
        assert.strictEqual(robots.deliveries.length, 1, 'a later auxiliary completion cannot replay native delivery');
    });

    it('resets document robots on replacement and rejects a stale preview before delivering the new document', async () => {
        const { f, robots } = robotFixture();
        await f.frame();
        const stale = f.pdf.activeRenders.find(candidate => candidate.id === 21)!;
        stale.task.completeAfterCancellation = true;
        const oldElement = f.pages[20].div;
        f.scrollBy(1000);
        await f.frame();
        const resets = robots.resetCalls;
        f.replaceDocument();
        await f.frame();
        stale.task.finish();
        await promisesSettled();
        await f.frame();
        assert.ok(robots.resetCalls > resets, 'replacement clears the previous document episode history');
        assert.strictEqual(robots.deliveries.length, 0, 'the old document completion must never reach the robot module');
        assert.strictEqual(stale.parameters.canvasContext.canvas.width, 0);
        const fresh = f.pdf.activeRenders.find(candidate => candidate.id === 22)!;
        assert.ok(fresh);
        f.scrollBy(1000);
        await f.frame();
        fresh.task.finish();
        await promisesSettled();
        await f.frame();
        assert.strictEqual(robots.deliveries.length, 1);
        assert.strictEqual(robots.deliveries[0].pageNumber, 22);
        assert.strictEqual(robots.deliveries[0].pageElement, f.pages[21].div);
        assert.notStrictEqual(robots.deliveries[0].pageElement, oldElement);
    });

    for (const lifecycle of ['rotation', 'hide', 'dispose'] as const) {
        it('cancels document robots immediately on ' + lifecycle, async () => {
            const { f, robots } = await visibleRobotPreview();
            assert.deepStrictEqual([...robots.active], [21]);
            if (lifecycle === 'rotation') {
                f.viewer.pagesRotation = 90;
                f.eventBus.emit('rotationchanging');
            } else if (lifecycle === 'hide') {
                f.owner.visibilityState = 'hidden';
                f.owner.emit('visibilitychange');
            } else { f.dispose(); }
            assert.strictEqual(robots.active.size, 0, 'old geometry and hidden/disposed effects cannot remain active');
            if (lifecycle === 'dispose') {
                assert.strictEqual(robots.disposeCalls, 1);
                f.dispose();
                assert.strictEqual(robots.disposeCalls, 1, 'disposal stays idempotent');
            } else {
                assert.deepStrictEqual(robots.visibleCalls[robots.visibleCalls.length - 1], [], 'the controller clears effect visibility before another frame');
            }
        });
    }

    it('enables document robots lazily and independently of the closed Motion Lab', async () => {
        const { f, robots, factories } = robotFixture(false);
        await f.frame();
        assert.deepStrictEqual(factories, [], 'disabled effects do not create robot DOM');
        assert.strictEqual(f.controller.diagnosticsEnabled, false);
        f.controller.setRobotsEnabled(true);
        assert.deepStrictEqual(factories, [f.container]);
        assert.strictEqual(f.controller.robotsEnabled, true);
        assert.strictEqual(robots.enabled, true);
        assert.strictEqual(f.controller.diagnosticsEnabled, false);
        f.controller.setRobotsEnabled(false);
        assert.strictEqual(f.controller.robotsEnabled, false);
        assert.strictEqual(robots.enabled, false);
        assert.strictEqual(f.controller.diagnosticsEnabled, false);
        f.controller.setRobotsEnabled(true);
        assert.strictEqual(factories.length, 1, 're-enabling reuses the same lifecycle-owned instance');
        f.controller.setDiagnosticsEnabled(true);
        f.controller.setRobotsEnabled(false);
        assert.strictEqual(f.controller.diagnosticsEnabled, true, 'the robot toggle also leaves an open lab open');
    });

    it('gives unfinished visible pages priority over every speculative render', async () => {
        const f = fixture();
        const visible = f.pages[19];
        visible.renderingState = 0;
        await f.frame();
        assert.ok(f.controller.snapshot().renderAhead.length > 0);
        assert.ok(f.pdf.requests.every(request => request.id === visible.id), 'an uncovered visible page blocks admission of new offscreen preparations');
        assert.strictEqual(f.choose(), visible);
        visible.renderingState = 2;
        assert.strictEqual(f.choose(), visible, 'a paused visible page resumes before any page ahead');
        visible.renderingState = 3;
        const next = f.choose();
        assert.ok(next && f.controller.snapshot().renderAhead.includes(next.id));
    });

    it('prunes offscreen native canvases on mobile even below the byte limit', async () => {
        const f = fixture({ mobile: true });
        for (const id of [17, 18, 19, 21, 22, 23, 24]) { f.cachePage(id); }
        await f.frame();
        const state = f.controller.snapshot();
        assert.strictEqual(state.cachePolicy, 'mobile');
        assert.ok(state.prepared.length <= 6);
        assert.ok(state.renderAhead.length + state.visible.length <= 3);
        assert.ok(f.pdf.maxActive <= 2);
        const keep = new Set([...state.visible, ...state.renderAhead]);
        for (const view of f.cached) {
            if (keep.has(view.id)) { continue; }
            assert.strictEqual(view.canvas, null, 'offscreen canvas ' + view.id + ' is released without waiting for memory pressure');
        }
        assert.ok(f.pages[19].canvas, 'the visible page remains rendered');
    });

    it('settles mobile cached offscreen previews without an idle cleanup and preparation loop', async () => {
        const f = fixture({ mobile: true, startPage: 65 });
        f.container.clientHeight = 2000;
        for (const id of [66, 67, 68]) { f.cachePage(id); }
        for (let step = 0; step < 8; step++) {
            await f.frame();
            for (const render of [...f.pdf.activeRenders]) { render.task.finish(); }
            await promisesSettled();
        }
        await f.frame();
        const state = f.controller.snapshot();
        assert.ok(state.prepared.includes(68) && !state.renderAhead.includes(68));
        assert.strictEqual(f.pages[67].destroyCalls, 1, 'the old native page is pruned once');
        assert.strictEqual(f.pdf.renders.filter(render => render.id === 68).length, 0, 'its retained raster needs no new decode');
        assert.strictEqual(f.pdf.page(68)._intentStates.size, 0);
        assert.deepStrictEqual(state.pending, []);
        assert.strictEqual(f.callbacks.size, 0, 'finished raster preparation cannot sustain an idle animation loop');
        assert.strictEqual(timers.size, 0);

        // PDF.js's idle cleanup releases intent resources without clearing finished canvases.
        for (const page of f.pdf.pages.values()) { page.cleanup(); }
        const renders = f.pdf.renders.length;
        for (let step = 0; step < 4; step++) {
            f.eventBus.emit('updateviewarea');
            await f.frame(30_000);
        }
        assert.strictEqual(f.pdf.renders.length, renders, 'idle cleanup does not restart finished native or raster-only pages');
        assert.strictEqual(f.callbacks.size, 0);
        assert.ok(f.pages[64].canvas && f.pages[65].canvas, 'visible canvases survive resource cleanup');
    });

    it('releases mobile far-preview resources and warms them only when native rendering needs the page', async () => {
        const f = fixture({ mobile: true });
        await f.frame();
        const farId = f.controller.snapshot().prepared.find((id: number) => id !== 20 && !f.controller.snapshot().renderAhead.includes(id));
        assert.ok(farId);
        for (let step = 0; step < 6; step++) {
            for (const render of [...f.pdf.activeRenders]) { render.task.finish(); }
            await promisesSettled();
            await f.frame();
        }
        const first = f.pdf.renders.find(render => render.id === farId)!;
        assert.ok(first);
        const raster: Canvas = first.parameters.canvasContext.canvas;
        assert.ok(raster.width > 0);
        assert.strictEqual(first.page._intentStates.size, 0, 'a completed far raster releases decoded images and its operator list');
        assert.strictEqual(f.pdf.renders.filter(render => render.id === farId).length, 1);
        assert.strictEqual(f.callbacks.size, 0);
        f.scrollBy((farId - 20) * 1000);
        await f.frame();
        assert.strictEqual(raster.parentNode, f.pages[farId - 1].div, 'the retained raster immediately covers the returning page');
        assert.strictEqual(f.pdf.renders.filter(render => render.id === farId).length, 2, 'a native target receives exactly one new completion fence');
    });

    it('keeps a finished native canvas after its display resources were cleaned', async () => {
        for (const mobile of [false, true]) {
            const f = fixture({ mobile, pages: 1, startPage: 1 });
            await f.frame();
            const canvas = f.pages[0].canvas;
            f.pdf.page(1).cleanup();
            f.eventBus.emit('updateviewarea');
            await f.frame(30_000);
            assert.strictEqual(f.pdf.renders.length, 0, 'finished pixels do not require another preview render');
            assert.strictEqual(f.pages[0].canvas, canvas);
            assert.strictEqual(f.callbacks.size, 0);
        }
    });

    for (const nativeFirst of [true, false]) {
        it('releases finished mobile native resources after ' + (nativeFirst ? 'its auxiliary render finishes' : 'native rendering follows auxiliary completion'), async () => {
            const f = fixture({ mobile: true });
            await f.frame();
            const preparation = f.pdf.activeRenders.find(render => render.id === 21)!;
            const view = f.pages[20];
            view.pdfPage = preparation.page;
            view.renderingState = 1;
            preparation.page.objs.set('photo', { width: 100, height: 100, data: new Uint8Array(40_000) });
            if (nativeFirst) {
                f.finishNative(view.id);
                assert.ok(preparation.page._intentStates.size > 0, 'the auxiliary render still needs the shared resources');
                assert.ok(preparation.page.objs.size > 0);
                preparation.task.finish();
                await promisesSettled();
            } else {
                preparation.task.finish();
                await promisesSettled();
                assert.ok(preparation.page._intentStates.size > 0, 'the unfinished native canvas still needs the prepared resources');
                assert.ok(preparation.page.objs.size > 0);
                f.finishNative(view.id);
            }
            const canvas = view.canvas;
            assert.strictEqual(preparation.page._intentStates.size, 0, 'finished pixels no longer retain original photo bitmaps');
            assert.strictEqual(preparation.page.objs.size, 0);
            await f.frame();
            assert.strictEqual(view.canvas, canvas);
            assert.strictEqual(f.pdf.renders.filter(render => render.id === view.id).length, 1, 'the completed canvas stays ready without another decode');

            f.scrollBy(1000);
            view.renderingState = 0;
            f.eventBus.emit('scalechanging');
            await promisesSettled();
            await f.frame();
            assert.ok(view.div.children.some(child => child.className === 'pdfPrefetchPreview'), 'zoom keeps raster coverage while resources return');
            assert.strictEqual(f.pdf.renders.filter(render => render.id === view.id).length, 2, 'a later native redraw prepares fresh resources');
        });
    }

    it('defers finished mobile page cleanup while another PDF.js render still uses its resources', async () => {
        const f = fixture({ mobile: true, startPage: 1, pages: 1 });
        await f.frame();
        const page = f.pdf.page(1);
        const canvas = f.pages[0].canvas;
        const otherRender = page.render({ viewport: page.getViewport({ scale: 1, rotation: 0 }) });
        page.objs.set('photo', { width: 100, height: 100, data: new Uint8Array(40_000) });
        const cleanups = page.cleanupCalls;
        f.eventBus.emit('pagerendered', { pageNumber: 1, error: null, cssTransform: false });
        assert.ok(page.cleanupCalls > cleanups, 'the completed native page requests safe deferred cleanup');
        assert.ok(page.objs.size > 0, 'an additional active PDF.js render keeps its images until completion');
        otherRender.finish();
        await promisesSettled();
        assert.strictEqual(page.objs.size, 0);
        assert.strictEqual(page._intentStates.size, 0);
        assert.strictEqual(f.pages[0].canvas, canvas);
        await f.frame();
        assert.strictEqual(f.pdf.renders.length, 1, 'finished native pixels do not restart preparation');
    });

    it('prepares mobile images for native pixel density and invalidates warm admission on larger zoom', async () => {
        const f = fixture({ mobile: true });
        f.owner.defaultView.devicePixelRatio = 2;
        const view: any = f.pages[20];
        view.viewport = { width: 800, height: 1000, scale: 1 };
        await f.frame();
        const first = f.pdf.activeRenders.find(render => render.id === 21)!;
        assert.strictEqual(first.parameters.imageDecodeScale, 2, 'a small preview prepares the native display density');
        assert.strictEqual(first.parameters.imageDecodeMaxDimension, 2000);
        first.task.finish();
        await promisesSettled();
        view.viewport = { width: 1600, height: 2000, scale: 2 };
        const transfers = Array.from({ length: 6 }, () => fetches.begin());
        f.scrollBy(1000);
        f.eventBus.emit('scalechanging');
        await promisesSettled();
        await f.frame();
        assert.ok(first.page._intentStates.size > 0, 'old display resources still exist during the zoom transition');
        assert.strictEqual(f.queue.renderView(view), false, 'the old lower-resolution intent cannot bypass cold-work pressure');
        for (const transfer of transfers) { fetches.end(transfer); }
        await f.frame();
        const last = f.pdf.renders.filter(render => render.id === 21).at(-1)!;
        assert.notStrictEqual(last, first);
        assert.strictEqual(last.parameters.imageDecodeScale, 4);
        assert.strictEqual(last.parameters.imageDecodeMaxDimension, 4000);
    });

    it('accounts decoded image allocations once, classifying shared storage before page storage', async () => {
        const f = fixture({ pages: 1, startPage: 1 });
        await f.frame();
        const page = f.pdf.page(1);
        const sharedBytes = new Uint8Array(64);
        const bitmap = { width: 10, height: 20, close() {} };
        const sharedImage = { width: 4, height: 4, data: sharedBytes };
        f.pdf.commonObjs.set('font', { name: 'font without pixel storage' });
        f.pdf.commonObjs.set('image', sharedImage);
        f.pdf.commonObjs.set('bitmap', { width: 10, height: 20, bitmap });
        page.objs.set('shared image alias', sharedImage);
        page.objs.set('shared buffer view', { width: 2, height: 2, data: sharedBytes.subarray(0, 16) });
        page.objs.set('shared bitmap alias', { width: 10, height: 20, bitmap });
        page.objs.set('local image', { width: 3, height: 2, data: new Uint8Array(24) });
        assert.deepStrictEqual(f.controller.snapshot().decodedImages, {
            pageBytes: 24, sharedBytes: 864, dataBytes: 88, bitmapBytes: 800, images: 3, supported: true, truncated: false,
        });
        page.cleanup();
        assert.strictEqual(f.controller.snapshot().decodedImages.pageBytes, 0, 'accounting observes cleanup without retaining image objects');
    });

    it('accounts an open VideoFrame through display dimensions and drops its bytes after close', async () => {
        const f = fixture({ pages: 1, startPage: 1 });
        await f.frame();
        const bitmap = {
            displayWidth: 40, displayHeight: 30,
            close() { this.displayWidth = this.displayHeight = 0; },
        };
        f.pdf.page(1).objs.set('native JPEG frame', { width: 160, height: 120, bitmap });
        assert.deepStrictEqual(f.controller.snapshot().decodedImages, {
            pageBytes: 4800, sharedBytes: 0, dataBytes: 0, bitmapBytes: 4800, images: 1, supported: true, truncated: false,
        }, 'the live frame owns its resized pixels, not the source image dimensions');
        bitmap.close();
        assert.deepStrictEqual(f.controller.snapshot().decodedImages, {
            pageBytes: 0, sharedBytes: 0, dataBytes: 0, bitmapBytes: 0, images: 0, supported: true, truncated: false,
        }, 'closing the frame releases its pixels even while the image descriptor remains in the store');
    });

    it('bounds decoded-image inspection and reports unavailable object-store iteration', async () => {
        const f = fixture({ pages: 1, startPage: 1 });
        await f.frame();
        const page = f.pdf.page(1);
        let visited = 0;
        (page as any).objs = {
            *[Symbol.iterator]() {
                for (let id = 0; id < 10_000; id++) {
                    visited++;
                    yield [String(id), { width: 1, height: 1, data: new Uint8Array(4) }];
                }
            },
        };
        const bounded = f.controller.snapshot().decodedImages;
        assert.strictEqual(bounded.supported, true);
        assert.strictEqual(bounded.truncated, true);
        assert.ok(visited <= 513, 'a diagnostics sample must not traverse unbounded object stores');
        (page as any).objs = { get() {} };
        assert.strictEqual(f.controller.snapshot().decodedImages.supported, false);
    });

    it('grants the host an idle lease only after visible work and pauses on motion, fetches, hiding and disposal', async () => {
        const f = fixture({ pages: 1, startPage: 1 });
        await f.frame();
        assert.deepStrictEqual(f.idleChanges, [false, true]);
        f.container.emit('wheel', { deltaY: 10, deltaX: 0, deltaMode: 0 });
        assert.strictEqual(f.idleChanges.at(-1), false, 'input revokes the lease before another frame');
        for (const timer of [...timers.values()]) { timer.callback(); }
        await f.frame();
        assert.strictEqual(f.idleChanges.at(-1), true);
        const transfer = fetches.begin();
        assert.strictEqual(f.idleChanges.at(-1), false, 'a foreground transfer revokes it synchronously');
        fetches.end(transfer);
        await f.frame();
        assert.strictEqual(f.idleChanges.at(-1), true);
        f.pages[0].renderingState = 1;
        f.eventBus.emit('pagerender', { pageNumber: 1 });
        await f.frame();
        assert.strictEqual(f.idleChanges.at(-1), false);
        f.finishNative(1);
        await f.frame();
        assert.strictEqual(f.idleChanges.at(-1), true);
        f.owner.visibilityState = 'hidden';
        f.owner.emit('visibilitychange');
        assert.strictEqual(f.idleChanges.at(-1), false);
        f.owner.visibilityState = 'visible';
        f.owner.emit('visibilitychange');
        await f.frame();
        assert.strictEqual(f.idleChanges.at(-1), true);
        f.dispose();
        assert.strictEqual(f.idleChanges.at(-1), false);
    });

    it('samples byte-cache residency without duplicate RPCs or stale-document results', async () => {
        const f = fixture({ pages: 1, startPage: 1 });
        let calls = 0;
        const old = new Deferred<Record<string, number>>();
        (f.pdf as any).getRangeCacheStats = () => { calls++; return old.promise; };
        f.controller.snapshot();
        f.controller.snapshot();
        await promisesSettled();
        assert.strictEqual(calls, 1);
        f.replaceDocument();
        const current = { residentBytes: 1024, maxBytes: 4096, evictedBytes: 2048 };
        (f.pdf as any).getRangeCacheStats = async () => current;
        f.controller.snapshot();
        await promisesSettled();
        old.resolve({ residentBytes: 9999, maxBytes: 9999, evictedBytes: 0 });
        await promisesSettled();
        assert.deepStrictEqual(f.controller.snapshot().rangeCache, current, 'old document completion cannot replace current residency');
    });

    const mobileByteBudget = 32 * 1024 * 1024;
    const byteStats = (residentBytes: number, activeOperations = 0, pendingRequests = 0) => ({
        residentBytes, activeOperations, pendingRequests, maxBytes: mobileByteBudget,
        length: 1_608_644_855, residentChunks: Math.ceil(residentBytes / 131072),
        totalChunks: 12274, peakBytes: residentBytes, evictedBytes: 0,
    });

    function fireMemoryTimer() {
        const entry = [...timers].find(([, timer]) => timer.delay === 250);
        assert.ok(entry, 'active byte pressure has one coalesced wakeup');
        timers.delete(entry[0]);
        entry[1].callback();
    }

    it('drains overlapping cold jobs before admitting another page when mobile bytes exceed their budget', async () => {
        const f = fixture({ mobile: true });
        f.controller.setDiagnosticsEnabled(false);
        const trims: Deferred<Record<string, number>>[] = [];
        (f.pdf as any).getRangeCacheStats = async () => byteStats(mobileByteBudget);
        (f.pdf as any).trimRangeCache = () => {
            const trim = new Deferred<Record<string, number>>();
            trims.push(trim);
            return trim.promise;
        };
        await f.frame();
        assert.strictEqual(f.pdf.activeRenders.length, 2);
        const [first, second] = f.pdf.activeRenders;
        first.task.finish();
        await promisesSettled();
        assert.strictEqual(trims.length, 1, 'completion checks worker bytes before freeing its cold slot');
        assert.strictEqual(f.controller.snapshot().pending.length, 2);
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, 2, 'a pending trim cannot be bypassed by the next frame');
        trims[0].resolve(byteStats(mobileByteBudget + 131072, 1, 1));
        await promisesSettled();
        for (let step = 0; step < 3; step++) {
            f.container.emit('wheel', { deltaY: 400, deltaX: 0, deltaMode: 0 });
            await f.frame();
        }
        assert.strictEqual(f.controller.snapshot().memoryBackpressure, true);
        assert.strictEqual(f.pdf.requests.length, 2, 'continuous motion cannot replenish a pressured worker');
        assert.strictEqual(second.task.cancellationCalls, 0, 'admitted decoding drains normally');
        second.task.finish();
        await promisesSettled();
        assert.strictEqual(trims.length, 2);
        trims[1].resolve(byteStats(mobileByteBudget));
        await promisesSettled();
        assert.strictEqual(f.controller.snapshot().memoryBackpressure, false, 'exactly the target budget permits admission');
        assert.strictEqual(f.callbacks.size, 1, 'trim and completion coalesce into one render wakeup');
        await f.frame();
        assert.ok(f.pdf.requests.length > 2);
        assert.ok(f.pdf.maxActive <= 2);
        assert.strictEqual(f.controller.diagnosticsEnabled, false, 'memory control does not require the Motion Lab');
    });

    it('polls only unsettled byte pressure and wakes once when detached worker activity drains without frames', async () => {
        const f = fixture({ mobile: true, pages: 1, startPage: 1 });
        f.controller.setDiagnosticsEnabled(false);
        let stats = byteStats(mobileByteBudget + 131072, 1);
        let calls = 0;
        (f.pdf as any).getRangeCacheStats = async () => stats;
        (f.pdf as any).trimRangeCache = async () => { calls++; return stats; };
        await f.frame();
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(timers.size, 1);
        fireMemoryTimer();
        await promisesSettled();
        assert.strictEqual(calls, 1);
        assert.strictEqual(timers.size, 1, 'one busy result creates one successor wakeup');
        assert.strictEqual(f.callbacks.size, 0, 'still-busy sampling does not sustain animation frames');
        stats = byteStats(mobileByteBudget, 0);
        fireMemoryTimer();
        await promisesSettled();
        assert.strictEqual(calls, 2);
        assert.strictEqual(timers.size, 0, 'quiescent bytes do not leave a periodic idle timer');
        assert.strictEqual(f.callbacks.size, 1);
        await f.frame();
        await f.frame();
        assert.strictEqual(calls, 2);
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(timers.size, 0);
        assert.strictEqual(f.idleChanges.at(-1), true);
    });

    it('keeps warm and running visible work available while byte pressure blocks cold pages', async () => {
        const f = fixture({ mobile: true });
        await f.frame();
        const prepared = f.pdf.activeRenders.find(render => render.id === 21)!;
        prepared.task.finish();
        await promisesSettled();
        (f.pdf as any).getRangeCacheStats = async () => byteStats(mobileByteBudget + 131072, 1);
        (f.pdf as any).trimRangeCache = async () => byteStats(mobileByteBudget + 131072, 1);
        f.controller.snapshot();
        await promisesSettled();
        f.scrollBy(1000);
        await f.frame();
        const visible = f.pages[20];
        assert.strictEqual(f.choose(), visible, 'completed preview resources retain visible-first native priority');
        assert.strictEqual(f.queue.renderView(visible), true);
        for (const state of [1, 2]) {
            visible.renderingState = state;
            assert.strictEqual(f.choose(), visible);
            assert.strictEqual(f.queue.renderView(visible), true);
        }
        f.finishNative(visible.id);
        visible.renderingState = 0;
        assert.strictEqual(f.choose(), null, 'finished native resources are released, so a later redraw needs cold admission');
        assert.strictEqual(f.queue.renderView(visible), false);
        assert.strictEqual(f.queue.renderView(f.pages[22]), false);
    });

    it('removes a scheduled memory check on hide and samples fresh bytes before resuming admission', async () => {
        const f = fixture({ mobile: true, pages: 1, startPage: 1 });
        const reply = new Deferred<Record<string, number>>();
        let trims = 0;
        (f.pdf as any).getRangeCacheStats = async () => byteStats(mobileByteBudget + 131072, 1);
        (f.pdf as any).trimRangeCache = () => { trims++; return reply.promise; };
        await f.frame();
        assert.strictEqual(timers.size, 1);
        f.owner.visibilityState = 'hidden';
        f.owner.emit('visibilitychange');
        assert.strictEqual(timers.size, 0, 'hiding removes the timer before it fires');
        f.owner.visibilityState = 'visible';
        f.owner.emit('visibilitychange');
        await f.frame();
        assert.strictEqual(trims, 1, 'showing initiates one fresh worker trim');
        assert.strictEqual(f.controller.snapshot().memoryBackpressure, true);
        reply.resolve(byteStats(mobileByteBudget));
        await promisesSettled();
        assert.strictEqual(f.callbacks.size, 1);
        await f.frame();
        assert.strictEqual(f.controller.snapshot().memoryBackpressure, false);
        assert.strictEqual(timers.size, 0);
    });

    it('stops byte sampling when a native render is canceled without a pagerendered event', async () => {
        const f = fixture({ mobile: true, pages: 1, startPage: 1 });
        (f.pdf as any).getRangeCacheStats = async () => byteStats(1024);
        (f.pdf as any).trimRangeCache = async () => byteStats(1024);
        await f.frame();
        f.pages[0].renderingState = 1;
        f.eventBus.emit('pagerender', { pageNumber: 1 });
        assert.strictEqual(timers.size, 1);
        f.pages[0].reset();
        fireMemoryTimer();
        await promisesSettled();
        assert.strictEqual(timers.size, 0, 'a stale render-start timestamp cannot sustain idle polling');
    });

    for (const lifecycle of ['hide', 'replace', 'dispose'] as const) {
        it('cancels byte-pressure timers and ignores late trim replies on ' + lifecycle, async () => {
            const f = fixture({ mobile: true, pages: 1, startPage: 1 });
            const reply = new Deferred<Record<string, number>>();
            (f.pdf as any).getRangeCacheStats = async () => byteStats(mobileByteBudget + 131072, 1);
            (f.pdf as any).trimRangeCache = () => reply.promise;
            await f.frame();
            assert.strictEqual(timers.size, 1);
            fireMemoryTimer();
            await promisesSettled();
            if (lifecycle === 'hide') {
                f.owner.visibilityState = 'hidden';
                f.owner.emit('visibilitychange');
            } else if (lifecycle === 'replace') { f.replaceDocument(); }
            else { f.dispose(); }
            const callbacks = f.callbacks.size;
            assert.strictEqual(timers.size, 0);
            reply.resolve(byteStats(1024));
            await promisesSettled();
            assert.strictEqual(timers.size, 0);
            assert.strictEqual(f.callbacks.size, callbacks, 'the retired RPC cannot wake or mutate the current view');
            const state = f.controller.snapshot();
            if (lifecycle === 'hide') { assert.strictEqual(state.rangeCache.residentBytes, mobileByteBudget + 131072); }
            else { assert.strictEqual(state.rangeCache, undefined); }
        });
    }

    it('keeps a graduated mobile preview trail below 8 MiB and 128 pages during a long traverse', async () => {
        const f = fixture({ mobile: true, pages: 180, startPage: 1 });
        await f.frame();
        for (let id = 2; id <= 160; id++) { f.finishNative(id); }
        const state = f.controller.snapshot();
        assert.ok(state.previewBytes <= 8 * 1024 * 1024, 'mobile raster cache is bounded throughout traversal');
        assert.ok(state.previewPages > 24 && state.previewPages <= 128, 'smaller trail rasters retain more history under the same byte cap');
        assert.ok(f.canvases.filter(canvas => canvas.width > 0).every(canvas => Math.max(canvas.width, canvas.height) <= 512));
        assert.ok(f.canvases.some(canvas => Math.max(canvas.width, canvas.height) === 192), 'old detached previews become small trail rasters');
        const visible = f.pages[0];
        visible.renderingState = 0;
        await f.frame();
        assert.ok(visible.div.children.some(canvas => canvas.className === 'pdfPrefetchPreview'), 'visible preview survives LRU eviction');
    });

    it('upgrades a small mobile trail raster from a finished native canvas without decoding again', async () => {
        const f = fixture({ mobile: true, startPage: 1, pages: 80 });
        await f.frame();
        for (let id = 2; id <= 30; id++) { f.finishNative(id); }
        f.scrollBy(14_000);
        await f.frame();
        const view = f.pages[14];
        const trail = view.div.children.find(canvas => canvas.className === 'pdfPrefetchPreview') as Canvas;
        assert.ok(trail && Math.max(trail.width, trail.height) === 192, 'the old page is immediately covered by its small raster');
        const before = f.pdf.renders.filter(render => render.id === view.id).length;
        f.finishNative(view.id);
        const replacement = view.div.children.find(canvas => canvas.className === 'pdfPrefetchPreview') as Canvas;
        assert.ok(replacement && replacement !== trail);
        assert.strictEqual(Math.max(replacement.width, replacement.height), 512);
        assert.strictEqual(replacement.copies, 1, 'the native canvas supplies the higher-quality preview');
        assert.strictEqual(trail.width, 0);
        assert.strictEqual(f.pdf.renders.filter(render => render.id === view.id).length, before);
    });

    for (const fault of ['null context', 'draw failure']) {
        it('preserves a trail preview and releases its failed native copy after ' + fault, async () => {
            const f = fixture({ mobile: true, startPage: 1, pages: 80 });
            await f.frame();
            for (let id = 2; id <= 30; id++) { f.finishNative(id); }
            f.scrollBy(14_000);
            await f.frame();
            const view = f.pages[14];
            const trail = view.div.children.find(canvas => canvas.className === 'pdfPrefetchPreview') as Canvas;
            assert.strictEqual(Math.max(trail.width, trail.height), 192);
            const attempted: Canvas[] = [];
            f.createCanvas = () => {
                const canvas = new Canvas();
                attempted.push(canvas);
                if (fault === 'null context') { canvas.getContext = () => null as any; }
                else { canvas.context.drawImage = () => { throw new Error('canvas memory pressure'); }; }
                return canvas;
            };
            assert.doesNotThrow(() => f.finishNative(view.id), 'a preview copy failure must not escape PDF.js rendering events');
            assert.strictEqual(attempted.length, 1);
            assert.strictEqual(attempted[0].width * attempted[0].height, 0, 'the failed temporary raster releases its allocation');
            assert.strictEqual(trail.parentNode, view.div, 'the previous attached preview remains until the native view replaces it');
            assert.strictEqual(Math.max(trail.width, trail.height), 192);
            for (let step = 0; step < 3; step++) {
                f.eventBus.emit('updateviewarea');
                await f.frame();
            }
            assert.strictEqual(attempted.length, 1, 'the same failed copy is not allocated on every refresh');
            assert.deepStrictEqual(f.controller.snapshot().failed, [], 'copy pressure does not mark the PDF page as failed');
            f.createCanvas = () => new Canvas();
            const before = f.canvases.length;
            f.eventBus.emit('scalechanging');
            await f.frame();
            assert.ok(f.canvases.slice(before).some(canvas => Math.max(canvas.width, canvas.height) === 512), 'a changed layout permits a fresh native copy');
            assert.strictEqual(trail.width, 0, 'successful replacement releases the old trail raster');
        });
    }

    it('settles raster admission when zoomed-out visible pages exceed the mobile preview budget', async () => {
        const f = fixture({ mobile: true, startPage: 1, pages: 12 });
        f.visibleIds = Array.from({ length: 12 }, (_, id) => id + 1);
        f.container.clientHeight = 12_000;
        for (let step = 0; step < 16; step++) {
            await f.frame();
            for (const render of [...f.pdf.activeRenders]) { render.task.finish(); }
            await promisesSettled();
        }
        await f.frame();
        const state = f.controller.snapshot();
        assert.ok(state.previewBytes <= 8 * 1024 * 1024);
        assert.ok(state.previewPages < 12, 'the protected raster set cannot exceed its byte cap');
        assert.deepStrictEqual(state.failed, [], 'cache pressure is not a PDF page failure');
        assert.ok(f.pdf.renders.length <= 11, 'rejected rasters are not decoded repeatedly within the same plan');
        assert.deepStrictEqual(state.pending, []);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('finishes a finite idle render window without repeatedly redrawing evicted pages', async () => {
        const f = fixture();
        for (let id = 1; id <= 7; id++) { f.cachePage(id); }
        const drawn = new Set<number>();
        for (let step = 0; step < 12; step++) {
            await f.frame();
            const next = f.choose();
            if (!next) { break; }
            assert.ok(!drawn.has(next.id), 'page ' + next.id + ' was selected again after eviction');
            drawn.add(next.id);
            f.finishNative(next.id);
        }
        assert.ok(drawn.size > 0 && drawn.size < 8, 'the visible page and its finite render plan fit eight canvases');
        await f.frame();
        assert.strictEqual(f.choose(), null);
        const updates = f.updates;
        await f.frame();
        assert.strictEqual(f.updates, updates, 'the controller ignores the updateviewarea event from its own update');
        assert.strictEqual(f.callbacks.size, 0, 'idle rendering does not sustain another animation frame');
    });

    it('counts native spread holes toward the finite render and cache budget', async () => {
        const f = fixture({ startPage: 1 });
        f.visibleIds = [1, 3, 5, 7];
        f.container.clientHeight = 4000;
        // Four visible left-hand pages, with their right-hand spread partners clipped out.
        for (const page of f.pages) {
            page.div.getBoundingClientRect = () => {
                const top = Math.floor((page.id - 1) / 2) * page.height;
                const left = (page.id % 2 ? 0 : page.width);
                return { x: left, y: top, left, top, right: left + page.width, bottom: top + page.height, width: page.width, height: page.height };
            };
        }
        for (const id of f.visibleIds) { f.cachePage(id); }
        await f.frame();
        const snapshot = f.controller.snapshot();
        assert.deepStrictEqual(snapshot.visible, [1, 3, 5, 7]);
        assert.ok(7 + snapshot.renderAhead.length <= 8, 'the three native spread holes reserve their own canvas slots');
        const drawn = new Set<number>();
        for (let step = 0; step < 12; step++) {
            const next = f.choose();
            if (!next) { break; }
            assert.ok(!drawn.has(next.id), 'page ' + next.id + ' was redrawn after the native buffer evicted it');
            drawn.add(next.id);
            f.finishNative(next.id);
            await f.frame();
        }
        assert.ok([2, 4, 6].every(id => drawn.has(id)), 'native hole rendering keeps its priority');
        assert.strictEqual(f.choose(), null);
        assert.ok(f.cached.size <= 8);
    });

    it('retires obsolete forward work and requests the reverse direction when its slot drains', async () => {
        const f = fixture({ startPage: 40, pages: 140 });
        f.scrollBy(5000);
        f.cachePage(f.visible().first.id);
        await f.frame();
        assert.strictEqual(f.controller.snapshot().direction, 1);
        const forward = f.pdf.activeRenders.filter(render => render.id > f.visible().last.id);
        assert.ok(forward.length > 0);
        const requestedBefore = f.pdf.requests.length;
        f.scrollBy(-5000);
        await f.frame();
        await f.frame();
        assert.strictEqual(f.controller.snapshot().direction, -1);
        assert.ok(forward.every(render => render.task.cancellationCalls === 0), 'started decoding retains its completion fence through reversal');
        assert.ok(forward.every(render => f.controller.snapshot().retiring.includes(render.id)));
        assert.strictEqual(f.pdf.requests.length, requestedBefore, 'retiring work still occupies the three cold-page slots');
        forward[0].task.finish();
        await promisesSettled();
        await f.frame();
        const requested = f.pdf.requests.slice(requestedBefore);
        assert.ok(requested.length > 0);
        assert.ok(requested[0].id < f.visible().first.id, 'the next preparation starts behind the new viewport');
    });

    it('measures scroll movement when updateviewarea and its frame arrive before the scroll event', async () => {
        const f = fixture();
        await f.frame();
        const idleLead = f.controller.snapshot().preloadPx;
        f.container.scrollTop += 1000;
        f.eventBus.emit('updateviewarea', { source: f.viewer });
        await f.frame();
        // PDF.js can update its visible pages before the browser delivers the scroll event.
        // That refresh must keep the previous input position available to the scroll handler.
        f.container.emit('scroll');
        await f.frame();
        const moving = f.controller.snapshot();
        assert.ok(moving.velocityPxPerMs > 0, 'the scroll event still measures the position change');
        assert.ok(moving.preloadPx > idleLead, 'the measured movement expands the preloading distance');
    });

    it('preserves scroll velocity across adjacent scrollend events until the 250 ms gesture gap', async () => {
        const f = fixture();
        await f.frame();
        const idleLead = f.controller.snapshot().preloadPx;
        f.time += 16;
        f.container.scrollTop += 200;
        f.container.emit('scroll');
        const moving = f.controller.snapshot();
        assert.ok(moving.velocityPxPerMs > 0);
        assert.ok(moving.preloadPx > idleLead);
        // Chromium sends scrollend immediately after an instantaneous scrollTop step,
        // even when the next animation frame will continue the same movement.
        f.container.emit('scrollend');
        assert.strictEqual(f.controller.snapshot().velocityPxPerMs, moving.velocityPxPerMs);
        assert.strictEqual(timers.size, 1, 'scrollend replaces the existing gesture timer');
        const [timerId, timer] = [...timers][0];
        assert.strictEqual(timer.delay, 250);
        await f.frame(249);
        assert.strictEqual(f.controller.snapshot().velocityPxPerMs, moving.velocityPxPerMs);
        assert.ok(f.controller.snapshot().preloadPx > idleLead);
        f.time += 1;
        timers.delete(timerId);
        timer.callback();
        await f.frame(0);
        assert.strictEqual(f.controller.snapshot().velocityPxPerMs, 0);
        assert.strictEqual(f.controller.snapshot().preloadPx, idleLead);
    });

    it('keeps at most three previews in progress, including getPage requests', async () => {
        const f = fixture({ autoPages: false });
        f.scrollBy(5000);
        f.cachePage(f.visible().first.id);
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, 3);
        assert.strictEqual(f.controller.snapshot().pending.length, 3);
        assert.ok(f.controller.snapshot().prepared.length <= 16);
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, 3, 'unanswered getPage calls occupy their preparation slots');
        f.pdf.answerAll();
        await promisesSettled();
        assert.strictEqual(f.pdf.activeRenders.length, 3);
        f.pdf.activeRenders[0].task.finish();
        await promisesSettled();
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, 4, 'one completion releases one preparation slot');
        f.pdf.answerAll();
        await promisesSettled();
        assert.strictEqual(f.pdf.maxActive, 3);
        assert.ok(f.controller.snapshot().pending.length <= 3);
    });

    it('starts a small completion fence before native rendering and shares three cold slots', async () => {
        const f = fixture();
        const visible = f.pages[19];
        visible.renderingState = 0;
        assert.strictEqual(f.queue.renderView(visible), true);
        assert.deepStrictEqual(f.nativeFencePages[0], [visible.id], 'the known-page preview starts synchronously before native renderView');
        assert.deepStrictEqual(f.controller.snapshot().pending, [visible.id]);
        f.cachePage(visible.id);
        await f.frame();
        assert.strictEqual(f.pdf.activeRenders.length, 3);
        const shared = f.pages[20];
        shared.pdfPage = f.pdf.page(shared.id);
        assert.strictEqual(f.queue.renderView(shared), true, 'a native render can join the page already occupying a cold slot');
        assert.strictEqual(f.pdf.renders.filter(render => render.id === shared.id).length, 1, 'joining does not start a duplicate completion fence');
        const cold = f.pages[22];
        cold.pdfPage = f.pdf.page(cold.id);
        assert.ok(f.controller.snapshot().renderAhead.includes(cold.id));
        assert.strictEqual(f.queue.renderView(cold), false, 'a fourth cold page cannot bypass the shared native and preview budget');
        assert.strictEqual(f.controller.snapshot().pending.length, 3);
    });

    it('keeps retiring decode work within three slots even when every fetch has finished', async () => {
        const f = fixture();
        await f.frame();
        const old = [...f.pdf.activeRenders];
        const requested = f.pdf.requests.length;
        f.scrollBy(40_000);
        await f.frame();
        const visible = f.pages[f.visible().first.id - 1];
        visible.pdfPage = f.pdf.page(visible.id);
        assert.strictEqual(fetches.pendingFetchCount, 0);
        assert.deepStrictEqual(f.controller.snapshot().retiring, old.map(render => render.id));
        assert.strictEqual(f.pdf.requests.length, requested);
        assert.strictEqual(f.choose(), null);
        assert.strictEqual(f.queue.renderView(visible), false);
        let continued = 0;
        for (const render of old) {
            assert.strictEqual(render.task.cancellationCalls, 0);
            render.task.onContinue!(() => { continued++; });
        }
        assert.strictEqual(continued, 3, 'retiring tasks can finish while the new viewport is uncovered');
        old[0].task.finish();
        await promisesSettled();
        await f.frame();
        assert.strictEqual(f.pdf.requests[requested].id, visible.id, 'the newly available slot goes to the current visible page');
        assert.strictEqual(f.pdf.activeRenders.length, 3);
        assert.strictEqual(f.pdf.maxActive, 3);
        assert.strictEqual(f.queue.renderView(visible), true);
        assert.ok(f.nativeFencePages[f.nativeFencePages.length - 1].includes(visible.id));
    });

    it('rejects a delayed in-plan native selection if its cold completion fence cannot start', async () => {
        const f = fixture({ autoPages: false });
        // PDFViewer.update selects its native candidate before the controller pumps previews.
        const selected = f.choose();
        assert.ok(selected);
        await f.frame();
        f.scrollBy(-100);
        await f.frame();
        assert.ok(f.controller.snapshot().renderAhead.includes(selected.id), 'the old native selection still fits the short reversal trail');
        assert.ok(f.controller.snapshot().visibleMissing.length > 0);
        f.pdf.answerAll();
        await promisesSettled();
        selected.setPdfPage(f.pdf.page(selected.id));
        assert.strictEqual(f.pdf.renders.length, 0, 'the stale metadata answer did not admit offscreen decoding');
        assert.strictEqual(f.queue.renderView(selected), false, 'native drawing cannot bypass the rejected offscreen completion fence');
        assert.strictEqual(f.nativeRenders.length, 0);
        const visible = f.pages[f.visible().first.id - 1];
        visible.setPdfPage(f.pdf.page(visible.id));
        assert.strictEqual(f.queue.renderView(visible), true, 'the visible page can use the free cold slot immediately');
        assert.deepStrictEqual(f.nativeFencePages[0], [visible.id]);
    });

    it('blocks new cold page work while twelve real fetches remain pending after render cancellation', async () => {
        const f = fixture();
        await f.frame();
        const old = [...f.pdf.activeRenders];
        assert.strictEqual(old.length, 3);
        const transfers = Array.from({ length: 12 }, () => fetches.begin());
        const requests = f.pdf.requests.length;
        f.scrollBy(30_000);
        f.eventBus.emit('scalechanging');
        await f.frame();
        await f.frame();
        assert.ok(old.every(render => render.task.cancellationCalls > 0));
        assert.strictEqual(f.pdf.activeRenders.length, 0);
        assert.strictEqual(f.controller.snapshot().pending.length, 0, 'cancelled canvas promises release their preparation slots');
        assert.strictEqual(fetches.pendingFetchCount, 12, 'canvas cancellation leaves the actual transfers outstanding');
        assert.strictEqual(f.controller.snapshot().fetchBackpressure, true);
        assert.strictEqual(f.pdf.requests.length, requests, 'released canvas slots cannot admit another cold page');
        assert.strictEqual(f.choose(), null);
        assert.strictEqual(f.queue.renderView(f.pages[f.visible().first.id - 1]), false);
        const updates = f.updates;
        await f.frame();
        assert.strictEqual(f.updates, updates, 'a blocked queue waits for transfer changes rather than spinning');
        assert.strictEqual(f.callbacks.size, 0);
        for (const id of transfers) { fetches.end(id); }
        assert.strictEqual(f.callbacks.size, 1, 'several transfer completions coalesce into one wakeup');
        await f.frame();
        assert.ok(f.updates > updates, 'the completion wakeup asks the native viewer to render again');
        assert.ok(f.pdf.requests.length > requests, 'cold preparation resumes after the transfers drain');
        assert.strictEqual(f.choose(), f.pages[f.visible().first.id - 1]);
    });

    it('blocks a six-transfer backlog at 1500 ms while preserving overlap for fewer old transfers', async () => {
        const f = fixture();
        const visible = f.pages[19];
        visible.renderingState = 0;
        const oldTransfer = fetches.begin(f.time - 4000);
        assert.strictEqual(f.controller.snapshot().fetchBackpressure, false);
        assert.strictEqual(f.choose(), visible, 'one ordinary slow-link transfer does not close admission');
        fetches.end(oldTransfer);
        const transfers = Array.from({ length: 6 }, () => fetches.begin(f.time - 1499));
        assert.strictEqual(f.choose(), visible, 'a fresh six-transfer backlog permits useful overlap');
        f.time++;
        assert.strictEqual(fetches.oldestFetchMs, 1500);
        assert.strictEqual(f.choose(), null);
        assert.strictEqual(f.queue.renderView(visible), false);
        await f.frame(0);
        assert.strictEqual(f.controller.snapshot().fetchBackpressure, true);
        assert.strictEqual(f.pdf.requests.length, 0, 'the aged backlog also blocks preview admission');
        fetches.end(transfers[0]);
        assert.strictEqual(f.choose(), visible, 'draining below six transfers reopens native admission');
        await f.frame(0);
        assert.strictEqual(f.controller.snapshot().fetchBackpressure, false);
        assert.ok(f.pdf.renders.length > 0, 'preview preparation overlaps the remaining five aged transfers');
    });

    it('allows running, paused and completed-resource native rendering under fetch pressure', async () => {
        const f = fixture();
        const visible = f.pages[19];
        visible.renderingState = 1;
        for (let count = 0; count < 12; count++) { fetches.begin(); }
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, 0);
        for (const state of [1, 2]) {
            visible.renderingState = state;
            assert.strictEqual(f.choose(), visible, 'admitted native work remains the visible priority');
            assert.strictEqual(f.queue.renderView(visible), true, 'an active or paused render can continue draining its resources');
        }
        visible.renderingState = 0;
        assert.strictEqual(f.choose(), null, 'the unfinished page has not yet established resource readiness');
        f.finishNative(visible.id);
        visible.renderingState = 0;
        assert.strictEqual(f.choose(), visible, 'a completed native render certifies warm resources for a redraw');
        assert.strictEqual(f.queue.renderView(visible), true);
    });

    it('allows a completed preview to supply warm resources while pending fetches block cold pages', async () => {
        const f = fixture();
        await f.frame();
        const render = f.pdf.activeRenders.find(candidate => candidate.id === 21)!;
        render.task.finish();
        await promisesSettled();
        for (let count = 0; count < 12; count++) { fetches.begin(); }
        f.scrollBy(1000);
        await f.frame();
        const visible = f.pages[20];
        assert.strictEqual(visible.renderingState, 0);
        assert.strictEqual(f.controller.snapshot().fetchBackpressure, true);
        assert.strictEqual(f.choose(), visible);
        assert.strictEqual(f.queue.renderView(visible), true, 'the completed preview already resolved this page\'s display resources');
        assert.ok(f.controller.snapshot().renderAhead.includes(24));
        assert.strictEqual(f.queue.renderView(f.pages[23]), false, 'an in-plan cold page remains blocked');
    });

    it('rechecks fetch pressure after delayed preview and native getPage selections', async () => {
        const f = fixture({ autoPages: false });
        const selected = f.choose();
        assert.ok(selected);
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, 3);
        for (let count = 0; count < 12; count++) { fetches.begin(); }
        f.pdf.answerAll();
        await promisesSettled();
        assert.strictEqual(f.pdf.renders.length, 0, 'late preview metadata cannot bypass newly accumulated transfers');
        assert.strictEqual(f.queue.renderView(selected), false, 'the native selection is rechecked immediately before rendering');
        assert.strictEqual(f.nativeRenders.length, 0);
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, 3, 'the blocked preview completion does not create a retry loop');
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('rejects a delayed native render that falls outside the new scroll plan', async () => {
        const f = fixture({ startPage: 40, pages: 140 });
        f.scrollBy(5000);
        await f.frame();
        const oldId = f.controller.snapshot().renderAhead[0];
        const oldView = f.pages[oldId - 1];
        assert.ok(oldView);
        f.scrollBy(-5000);
        await f.frame();
        assert.ok(!f.controller.snapshot().renderAhead.includes(oldId));
        assert.strictEqual(f.queue.renderView(oldView), false);
        assert.strictEqual(f.nativeRenders.length, 0, 'a resolved native getPage must not revive obsolete render work');
        const current = f.pages[f.visible().first.id - 1];
        assert.strictEqual(f.queue.renderView(current), true);
        assert.deepStrictEqual(f.nativeRenders, [current]);
        const thumbnail = { id: current.id, renderingId: 'thumbnail' + current.id };
        assert.strictEqual(f.queue.renderView(thumbnail), true, 'the shared queue still serves thumbnail rendering');
    });

    it('rejects a native render of an old page-view object after document replacement', async () => {
        const f = fixture();
        await f.frame();
        const old = f.pages[19];
        f.replaceDocument();
        await f.frame();
        assert.strictEqual(f.queue.renderView(old), false);
        assert.strictEqual(f.nativeRenders.length, 0, 'the old view has the same page number but belongs to the old document');
        const current = f.pages[19];
        assert.strictEqual(f.queue.renderView(current), true);
        assert.deepStrictEqual(f.nativeRenders, [current]);
    });

    for (const replacement of [false, true]) {
        it('ignores a late getPage answer after ' + (replacement ? 'document replacement' : 'pagesdestroy'), async () => {
            const f = fixture({ autoPages: false });
            await f.frame();
            const old = f.pdf;
            assert.ok(old.requests.length > 0);
            if (replacement) { f.replaceDocument(); } else { f.eventBus.emit('pagesdestroy'); }
            await f.frame();
            const previewPages = f.controller.snapshot().previewPages;
            old.answerAll();
            await promisesSettled();
            await f.frame();
            assert.strictEqual(old.renders.length, 0, 'the obsolete page is never rendered for a preview');
            assert.strictEqual(f.controller.snapshot().previewPages, previewPages);
            assert.ok(f.pages.every(page => page.installed.every(pdfPage => pdfPage.document === f.pdf)));
        });
    }

    it('discards a preview that finishes after its document was replaced', async () => {
        const f = fixture();
        await f.frame();
        const old = f.pdf;
        const render = old.activeRenders[0];
        assert.ok(render);
        render.task.completeAfterCancellation = true;
        const canvas: Canvas = render.parameters.canvasContext.canvas;
        f.replaceDocument();
        await f.frame();
        const previewPages = f.controller.snapshot().previewPages;
        render.task.finish();
        await promisesSettled();
        await f.frame();
        assert.ok(render.task.cancellationCalls > 0);
        assert.strictEqual(f.controller.snapshot().previewPages, previewPages);
        assert.strictEqual(canvas.parentNode, null);
        assert.strictEqual(canvas.width * canvas.height, 0, 'the obsolete preview releases its bitmap');
        assert.ok(f.pages.every(page => page.installed.every(pdfPage => pdfPage.document === f.pdf)));
    });

    it('drains admitted small previews while an uncovered viewport blocks further offscreen work', async () => {
        const f = fixture();
        await f.frame();
        const render = f.pdf.activeRenders.find(candidate => candidate.id === 22)!;
        assert.ok(render);
        assert.ok(Math.max(render.parameters.viewport.width, render.parameters.viewport.height) <= 768);
        assert.strictEqual(render.parameters.annotationMode, 1);
        f.scrollBy(1000);
        await f.frame();
        const visible = f.pages[f.visible().first.id - 1];
        visible.renderingState = 1;
        assert.strictEqual(render.task.cancellationCalls, 0, 'admitted decoding retains its slot instead of being replaced');
        let continued = 0;
        render.task.onContinue!(() => { continued++; });
        assert.strictEqual(continued, 1, 'existing work drains even while the viewport needs a raster');
        const requests = f.pdf.requests.length;
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, requests, 'an uncovered viewport prevents further offscreen admission');
        f.finishNative(visible.id);
        render.task.finish();
        await promisesSettled();
        await f.frame();
        assert.ok(f.pdf.requests.length > requests);
        assert.strictEqual(f.pdf.renders.filter(candidate => candidate.id === render.id).length, 1, 'the completed preparation is retained instead of decoded again');
    });

    it('continues preparing ahead when a saved preview covers a visible page awaiting native rendering', async () => {
        const f = fixture();
        await f.frame();
        const visible = f.pages[f.visible().first.id - 1];
        visible.renderingState = 1;
        const pending = [...f.pdf.activeRenders];
        let continued = 0;
        pending[0].task.onContinue!(() => { continued++; });
        assert.strictEqual(continued, 1, 'the existing visible raster allows the offscreen task to continue');
        const requested = f.pdf.requests.length;
        for (const render of pending) { render.task.finish(); }
        await promisesSettled();
        await f.frame();
        assert.ok(f.pdf.requests.length > requested, 'coverage also permits admission of the next preparation');
    });

    it('continues an existing preview task when its page becomes visible', async () => {
        const f = fixture();
        await f.frame();
        const render = f.pdf.activeRenders.find(candidate => candidate.id === 21)!;
        assert.ok(render);
        f.scrollBy(1000);
        f.pages[20].renderingState = 1;
        await f.frame();
        let continued = 0;
        render.task.onContinue!(() => { continued++; });
        assert.strictEqual(continued, 1, 'the preview is now useful for the uncovered visible page');
    });

    it('revokes warm admission when native cleanup clears the same page proxy', async () => {
        const f = fixture();
        await f.frame();
        const first = f.pdf.activeRenders.find(render => render.id === 21)!;
        first.task.finish();
        await promisesSettled();
        await f.frame();
        const view = f.pages[20];
        view.pdfPage = first.page;
        assert.ok(first.page._intentStates.size > 0);
        view.destroy();
        assert.strictEqual(first.page._intentStates.size, 0);
        assert.strictEqual(view.pdfPage, first.page, 'cleanup keeps the same PDFPageProxy identity');
        f.scrollBy(1000);
        await f.frame();
        assert.ok(view.div.children.some(child => child.className === 'pdfPrefetchPreview'));
        assert.strictEqual(f.pdf.activeRenders.length, 3);
        assert.strictEqual(f.choose(), null, 'the retained raster does not certify cleaned resources as warm');
        assert.strictEqual(f.queue.renderView(view), false, 'the cleaned page needs a free cold slot');
        f.pdf.activeRenders[0].task.finish();
        await promisesSettled();
        await f.frame();
        assert.strictEqual(f.pdf.renders.filter(render => render.id === view.id).length, 2);
        assert.strictEqual(f.queue.renderView(view), true);
        assert.ok(f.nativeFencePages[f.nativeFencePages.length - 1].includes(view.id));
    });

    it('warms page resources again after cleanup while retaining its earlier raster preview', async () => {
        const f = fixture({ pages: 120 });
        await f.frame();
        const first = f.pdf.activeRenders.find(render => render.id === 21)!;
        assert.ok(first);
        first.task.finish();
        await promisesSettled();
        await f.frame();
        const raster: Canvas = first.parameters.canvasContext.canvas;
        f.scrollBy(40_000);
        await f.frame();
        await f.frame();
        assert.ok(first.page.cleanupCalls > 0, 'the old offscreen page resources were released');
        assert.ok(raster.width > 0, 'the raster remains in the bounded preview cache');
        f.scrollBy(-39_000);
        await f.frame();
        for (const pending of [...f.pdf.activeRenders]) { pending.task.finish(); }
        await promisesSettled();
        await f.frame();
        assert.strictEqual(raster.parentNode, f.pages[20].div, 'the saved raster is shown while the page returns');
        assert.strictEqual(f.pdf.renders.filter(render => render.id === 21).length, 2, 'the retained raster does not suppress warming the cleaned resources');
    });

    it('reattaches a saved preview after native setPdfPage clears the page div', async () => {
        const f = fixture();
        await f.frame();
        const first = f.pdf.activeRenders.find(render => render.id === 21)!;
        assert.ok(first);
        first.task.finish();
        await promisesSettled();
        await f.frame();
        f.scrollBy(1000);
        await f.frame();
        const canvas: Canvas = first.parameters.canvasContext.canvas;
        const view = f.pages[20];
        assert.strictEqual(canvas.parentNode, view.div);
        view.setPdfPage(f.pdf.page(21));
        assert.strictEqual(canvas.parentNode, null, 'PDFPageView.reset clears the existing preview DOM');
        view.renderingState = 1;
        f.eventBus.emit('pagerender', { pageNumber: 21 });
        assert.strictEqual(canvas.parentNode, view.div, 'the preview returns before the new native render completes');
    });

    it('retains at most 128 small previews while preserving the visible page', async () => {
        const f = fixture({ startPage: 1, pages: 150, width: 64, height: 64 });
        await f.frame();
        for (let id = 2; id <= 150; id++) { f.finishNative(id); }
        const snapshot = f.controller.snapshot();
        assert.strictEqual(snapshot.previewPages, 128);
        assert.strictEqual(snapshot.previewBytes, 128 * 64 * 64 * 4);
        // The oldest page is visible. Its preview should survive even when its full canvas
        // needs another render; the other oldest previews supply the eviction candidates.
        f.pages[0].renderingState = 0;
        f.eventBus.emit('updateviewarea');
        await f.frame();
        assert.ok(f.pages[0].div.children.some(child => child.className === 'pdfPrefetchPreview'));
        f.dispose();
        assert.strictEqual(f.controller.snapshot().previewBytes, 0);
        assert.strictEqual(f.pages[0].div.children.length, 0);
    });

    it('enforces the 64 MiB preview budget before reaching the page-count limit', async () => {
        const f = fixture({ startPage: 1, pages: 60, width: 1000, height: 1000 });
        await f.frame();
        for (let id = 2; id <= 60; id++) { f.finishNative(id); }
        const snapshot = f.controller.snapshot();
        const bytesPerPreview = 768 * 768 * 4;
        const capacity = Math.floor(64 * 1024 * 1024 / bytesPerPreview);
        assert.strictEqual(snapshot.previewPages, capacity);
        assert.strictEqual(snapshot.previewBytes, capacity * bytesPerPreview);
        assert.ok(snapshot.previewBytes <= 64 * 1024 * 1024);
        assert.ok(f.canvases.some(canvas => canvas.copies === 1 && canvas.width === 0), 'eviction releases the copied bitmap');
    });

    it('restores the queue and removes callbacks on disposal, including late getPage answers', async () => {
        const f = fixture({ autoPages: false });
        f.scrollBy(1000);
        await f.frame();
        assert.notStrictEqual(f.queue.getHighestPriority, f.originalPriority);
        assert.ok(f.listenerCount > 0);
        assert.ok(timers.size > 0);
        const requests = f.pdf.requests.length;
        f.dispose();
        assert.strictEqual(f.queue.getHighestPriority, f.originalPriority);
        assert.strictEqual(f.queue.renderView, f.originalRenderView);
        assert.strictEqual(f.listenerCount, 0);
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(timers.size, 0);
        assert.strictEqual(fetches.listeners.size, 0);
        const transfer = fetches.begin();
        fetches.end(transfer);
        assert.strictEqual(f.callbacks.size, 0, 'transfer activity cannot wake a disposed viewer');
        f.pdf.answerAll();
        await promisesSettled();
        f.eventBus.emit('pagesinit');
        f.container.emit('scroll');
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, requests);
        assert.strictEqual(f.pdf.renders.length, 0);
    });

    it('cancels active previews and blocks a late render continuation after disposal', async () => {
        const f = fixture();
        await f.frame();
        const render = f.pdf.activeRenders[0];
        assert.ok(render);
        render.task.completeAfterCancellation = true;
        f.dispose();
        let continued = 0;
        render.task.onContinue!(() => { continued++; });
        render.task.finish();
        await promisesSettled();
        assert.strictEqual(continued, 0);
        assert.ok(render.task.cancellationCalls > 0);
        assert.strictEqual(f.controller.snapshot().previewPages, 0);
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(f.listenerCount, 0);
        assert.strictEqual(render.parameters.canvasContext.canvas.width * render.parameters.canvasContext.canvas.height, 0);
    });
});
