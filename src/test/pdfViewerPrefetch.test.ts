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
    private cleanupPending = false;
    constructor(readonly document: PdfDocument, readonly pageNumber: number) {}
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
        this.cleanupPending = false;
        return true;
    }
}

class PdfDocument {
    readonly requests: Array<{ id: number, result: Deferred<PdfPage> }> = [];
    readonly renders: Array<{ id: number, page: PdfPage, task: RenderTask, parameters: any }> = [];
    readonly pages = new Map<number, PdfPage>();
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

interface FixtureOptions { startPage?: number, pages?: number, width?: number, height?: number, autoPages?: boolean }

class Fixture {
    readonly owner = Object.assign(new Events(), { visibilityState: 'visible', defaultView: { devicePixelRatio: 1 } });
    readonly container = new Element();
    readonly eventBus = new Events();
    readonly callbacks = new Map<number, (timestamp: number) => void>();
    readonly canvases: Canvas[] = [];
    readonly cached = new Set<PageView>();
    readonly nativeRenders: any[] = [];
    readonly nativeFencePages: number[][] = [];
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

    install(module: any) {
        this.controller = module.installPdfPrefetch(this.viewer, {
            now: () => this.time,
            requestFrame: (callback: (timestamp: number) => void) => {
                const id = this.nextFrame++;
                this.callbacks.set(id, callback);
                return id;
            },
            cancelFrame: (id: number) => this.callbacks.delete(id),
            createCanvas: () => {
                const canvas = new Canvas();
                canvas.ownerDocument = this.owner;
                this.canvases.push(canvas);
                return canvas;
            },
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
                    contents: 'export const pdfPerformance = globalThis.__pdfPrefetchTestPerformance; export function installPrefetchDiagnostics() { return { toggle() {}, dispose() {} }; }',
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

    function fixture(options: FixtureOptions = {}) {
        const result = new Fixture(options);
        fixtures.push(result);
        fetches.now = () => result.time;
        result.install(module);
        return result;
    }

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
