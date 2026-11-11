import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

// tsc turns import() into require(), which cannot load ES modules.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
// Completing an explicit fake request schedules promise continuations. One event-loop turn
// lets those continuations run before the next simulated animation frame.
const promisesSettled = () => new Promise<void>(resolve => setImmediate(resolve));

class Events {
    readonly listeners = new Map<string, Set<(event: any) => void>>();
    readonly captures = new Map<string, Map<(event: any) => void, boolean>>();
    addEventListener(name: string, listener: (event: any) => void, options?: { capture?: boolean } | boolean) {
        if (!this.listeners.has(name)) { this.listeners.set(name, new Set()); }
        this.listeners.get(name)!.add(listener);
        if (!this.captures.has(name)) { this.captures.set(name, new Map()); }
        this.captures.get(name)!.set(listener, typeof options === 'boolean' ? options : options?.capture === true);
    }
    removeEventListener(name: string, listener: (event: any) => void, options?: { capture?: boolean } | boolean) {
        if (this.captures.get(name)?.get(listener) !== (typeof options === 'boolean' ? options : options?.capture === true)) { return; }
        this.listeners.get(name)?.delete(listener);
        this.captures.get(name)?.delete(listener);
    }
    dispatch(name: string, detail: Record<string, unknown>) { this.emit(name, detail); }
    on(name: string, listener: (event: any) => void) { this.addEventListener(name, listener); }
    off(name: string, listener: (event: any) => void) { this.removeEventListener(name, listener); }
    emit(name: string, detail: Record<string, unknown> = {}) {
        const event = { type: name, target: this, currentTarget: this, ...detail };
        for (const listener of [...(this.listeners.get(name) ?? [])]) {
            if (!detail.stoppedAtTarget || this.captures.get(name)?.get(listener)) { listener(event); }
        }
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
    clientLeft = 0;
    clientTop = 0;
    scrollTop = 0;
    scrollLeft = 0;
    connectedRoot = false;
    get isConnected(): boolean { return this.connectedRoot || !!this.parentNode?.isConnected; }
    contains(node: Element): boolean { return node === this || this.children.some(child => child.contains(node)); }
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
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    closest(selector: string): Element | null {
        if (selector === '.spread' && this.className.split(' ').includes('spread')) { return this; }
        return this.parentNode?.closest(selector) ?? null;
    }
    getBoundingClientRect() {
        return { x: 0, y: 0, left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
    }
}

class Canvas extends Element {
    width = 0;
    height = 0;
    copies = 0;
    source?: Canvas;
    readonly context = { canvas: this, drawImage: (source?: Canvas) => { this.copies++; this.source = source; } };
    getContext(kind: string) { assert.strictEqual(kind, '2d'); return this.context; }
}

interface RobotDelivery {
    pageNumber: number;
    pageElement: Element;
    canvas: Canvas;
    kind: 'preview' | 'page';
    imageRegions?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
    rasterProjection?: { width: number; height: number; pageToRaster: readonly number[] };
    displayRasterProjection?: RobotDelivery['rasterProjection'];
    pageProjection?: { content: { x: number; y: number; width: number; height: number }; clip: { x: number; y: number; width: number; height: number } };
}

interface RobotAdmission { moving: boolean; axis: 'x' | 'y' }

class DocumentRobots {
    enabled = true;
    readonly deliveries: RobotDelivery[] = [];
    readonly refinements: RobotDelivery[] = [];
    readonly offers: number[] = [];
    readonly admissions: Array<{ pageNumber: number; admission?: RobotAdmission }> = [];
    readonly visibleCalls: number[][] = [];
    readonly workCalls: Array<Array<{ key: string; pages: Array<{ pageNumber: number; pageElement: Element; label?: string; state: string }>; layoutPages?: readonly { pageNumber: number; label?: string }[] }>> = [];
    readonly enabledCalls: boolean[] = [];
    readonly active = new Set<number>();
    readonly handled = new Set<number>();
    readonly deferred = new Set<number>();
    readonly retirements: Array<{ identity: string; pages: RobotDelivery[]; sizes: number[][] }> = [];
    replacement?: string;
    replacementCancels = 0;
    readonly columnMotions: any[] = [];
    columnCancels = 0;
    maxActive = Infinity;
    onCapacityAvailable?: () => void;
    onReplacementComplete?: (identity: string) => void;
    private blocked = false;
    resetCalls = 0;
    disposeCalls = 0;
    setEnabled(value: boolean) {
        this.enabled = value;
        this.enabledCalls.push(value);
        if (!value) { this.blocked = false; this.active.clear(); }
    }
    setVisiblePages(ids: readonly number[]) {
        this.visibleCalls.push([...ids]);
        const previous = this.active.size;
        if (!ids.length) { this.blocked = false; }
        for (const id of this.active) { if (!ids.includes(id)) { this.active.delete(id); } }
        if (this.active.size < previous) { this.capacityAvailable(); }
    }
    setVisibleWork(groups: DocumentRobots['workCalls'][number]) {
        this.workCalls.push(groups.map(group => ({ ...group, pages: group.pages.map(page => ({ ...page })) })));
        this.setVisiblePages(groups.flatMap(group => group.pages.map(page => page.pageNumber)));
    }
    hasHandled(id: number) { return this.handled.has(id); }
    offer(value: RobotDelivery, admission?: RobotAdmission) {
        this.offers.push(value.pageNumber);
        this.admissions.push({ pageNumber: value.pageNumber, admission: admission && { ...admission } });
        if (!this.enabled || this.hasHandled(value.pageNumber)) { return 'skipped' as const; }
        if (this.deferred.has(value.pageNumber)) { return 'deferred' as const; }
        if (this.active.size >= this.maxActive) { this.blocked = true; return 'busy' as const; }
        this.handled.add(value.pageNumber);
        this.deliveries.push(value);
        this.active.add(value.pageNumber);
        return 'started' as const;
    }
    deliver(value: RobotDelivery) { return this.offer(value) === 'started'; }
    refine(value: RobotDelivery) {
        if (!this.enabled || !this.active.has(value.pageNumber)) { return 0; }
        this.refinements.push(value); return 1;
    }
    complete(id: number) { if (this.active.delete(id)) { this.capacityAvailable(); } }
    private capacityAvailable() {
        if (!this.blocked) { return; }
        this.blocked = false;
        this.onCapacityAvailable?.();
    }
    retireDocument(pages: RobotDelivery[], identity: string) {
        this.reset(); this.replacement = identity;
        this.retirements.push({ identity, pages: [...pages], sizes: pages.map(page => [page.canvas.width, page.canvas.height]) });
    }
    cancelReplacement(identity?: string) {
        if (this.replacement === undefined || identity !== undefined && identity !== this.replacement) { return; }
        const retired = this.replacement;
        this.replacement = undefined; this.replacementCancels++;
        this.onReplacementComplete?.(retired);
    }
    reset() { this.resetCalls++; this.blocked = false; this.active.clear(); this.handled.clear(); this.replacement = undefined; }
    snapshot() { return { enabled: this.enabled, activeEpisodes: this.active.size }; }
    setDispatchOrigin() {}
    setColumnTransition(motion: any) { this.columnMotions.push(motion); }
    cancelColumnMotion() { this.columnCancels++; }
    revealedArrivals = 0;
    revealArrivals() { this.revealedArrivals++; }
    readonly restoredArrivals: Array<{ pageNumber: number; pageElement: Element }> = [];
    restoreArrivals(pageNumber: number, pageElement: Element) { this.restoredArrivals.push({ pageNumber, pageElement }); }
    dispose() { this.disposeCalls++; this.enabled = false; this.blocked = false; this.active.clear(); }
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
    viewport: { width: number; height: number; scale: number; rotation: number };
    outputScale?: { sx: number; sy: number };
    resetCalls = 0;
    destroyCalls = 0;
    readonly maxCanvasPixels = 16_777_216;
    get renderingId() { return 'page' + this.id; }
    constructor(readonly id: number, readonly width: number, readonly height: number, readonly fixture: Fixture) {
        this.viewport = { width, height, scale: 1, rotation: 0 };
        this.div.ownerDocument = fixture.owner;
        fixture.container.prepend(this.div);
        this.div.clientWidth = width;
        this.div.clientHeight = height;
        this.div.setAttribute('data-page-number', String(id));
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

interface FixtureOptions { startPage?: number, pages?: number, width?: number, height?: number, autoPages?: boolean, mobile?: boolean, initialNative?: boolean }

class Fixture {
    readonly visualViewport = Object.assign(new Events(), { offsetLeft: 0, offsetTop: 0, width: 800, height: 1000 });
    readonly owner = Object.assign(new Events(), { visibilityState: 'visible', defaultView: { devicePixelRatio: 1,
        navigator: { userAgent: 'desktop test reader', maxTouchPoints: 0 }, visualViewport: this.visualViewport } });
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
    columnSettings: any;
    readonly column = {
        offsetX: 0, transition: undefined as any, updates: 0, disposed: false,
        ready: true, readyAt: 0,
        panels: [] as any[], layers: [] as Element[], releases: 0,
        setPanel(value: any) { this.panels.push(value); },
        update() { this.updates++; },
        registerLayer(layer: Element) { this.layers.push(layer); return () => { this.releases++; }; },
        dispose() { this.disposed = true; },
    };

    constructor(options: FixtureOptions = {}) {
        if (options.mobile) { this.owner.defaultView.navigator = { userAgent: 'iPhone', maxTouchPoints: 5 }; }
        const count = options.pages ?? 100;
        const width = options.width ?? 800;
        const height = options.height ?? 1000;
        this.pdf = new PdfDocument(width, height, options.autoPages ?? true);
        this.container.ownerDocument = this.owner;
        this.container.connectedRoot = true;
        this.container.clientWidth = width;
        this.container.clientHeight = height;
        this.visualViewport.width = width;
        this.visualViewport.height = height;
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
        const initialPage = this.visible().first.id;
        if (options.initialNative !== false) { this.cachePage(initialPage); }
        else { this.pages[initialPage - 1].pdfPage = this.pdf.page(initialPage); }
    }

    install(module: any, overrides: Record<string, unknown> = {}) {
        this.controller = module.installPdfPrefetch(this.viewer, {
            robotsEnabled: false,
            createDocumentColumn: (_container: Element, settings: any) => { this.columnSettings = settings; return this.column; },
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
        // Native draw creates its backing and final outputScale before pagerender.
        // The controller is installed before that main draw in both real engines.
        for (const page of [...this.cached]) { this.cachePage(page.id); }
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

    cachePage(id: number, elapsed = 0) {
        const page = this.pages[id - 1];
        page.pdfPage = this.pdf.page(id);
        page.pdfPage.retainDisplayIntent();
        const precedingCanvas = page.canvas;
        page.canvas = new Canvas();
        page.canvas.width = Math.ceil(page.width);
        page.canvas.height = Math.ceil(page.height);
        page.outputScale = { sx: page.canvas.width / page.div.clientWidth, sy: page.canvas.height / page.div.clientHeight };
        page.canvas.ownerDocument = this.owner;
        page.canvas.getBoundingClientRect = () => {
            const box = page.div.getBoundingClientRect();
            const left = box.left + page.div.clientLeft, top = box.top + page.div.clientTop;
            return { x: left, y: top, left, top, right: left + page.div.clientWidth, bottom: top + page.div.clientHeight,
                width: page.div.clientWidth, height: page.div.clientHeight };
        };
        page.renderingState = 1;
        if (this.controller) { this.eventBus.emit('pagerender', { pageNumber: id, source: page }); }
        this.time += elapsed;
        const managed = page as any;
        if (managed.publishImageCandidate) {
            const native = page.canvas!;
            const accepted = managed.publishImageCandidate({ canvas: native, status: (() => {
                    const status = managed.imagePassStatus ?? managed.paintedImageStatus;
                    if (!status || status.resources) { return status; }
                    return { ...status, untrackedImageOperations: false, resources: Array.from({ length: status.total }, (_, index) => ({
                        objectId: 'fixture-image-' + index, imageId: 'x' + (index + 5), covered: index < status.covered,
                        final: index < status.completed, failed: index >= status.total - status.failed })) };
                })(),
                intent: managed.imagePassStatus?.intent ?? managed.pdfPage?.imageStatus?.intent ?? (managed.fixtureImageIntent ??= {}), appearance: managed.imageAppearance, geometry: 'fixture-' + native.width + 'x' + native.height },
            () => { precedingCanvas?.remove(); if (precedingCanvas) { precedingCanvas.width = precedingCanvas.height = 0; } page.div.prepend(native); });
            if (!accepted) { native.remove(); native.width = native.height = 0; page.canvas = precedingCanvas?.parentNode ? precedingCanvas : null; }
            else if (managed.imagePassStatus) { managed.paintedImageStatus = managed.imagePassStatus; managed.paintedImageRevision = managed.imagePassRevision; }
        } else { page.div.prepend(page.canvas!); }
        page.renderingState = 3;
        this.cached.delete(page);
        this.cached.add(page);
        // The scheduler's full-resolution plan must fit a finite native page buffer.
        while (this.cached.size > 8) {
            const visible = this.visible().ids;
            const oldest = [...this.cached].find(candidate => !visible.has(candidate.id))!;
            this.cached.delete(oldest);
            oldest.destroy();
        }
        if (this.controller) { this.eventBus.emit('pagerendered', { pageNumber: id, source: page, error: null, cssTransform: false }); }
    }

    finishNative(id: number) {
        this.cachePage(id, 12);
    }

    replaceDocument() {
        this.eventBus.emit('pagesdestroy');
        this.pdf = new PdfDocument(this.pdf.width, this.pdf.height);
        this.viewer.pdfDocument = this.pdf;
        this.pages = this.pages.map(page => new PageView(page.id, page.width, page.height, this));
        this.cached.clear();
        this.eventBus.emit('pagesinit');
        this.cachePage(this.visible().first.id);
    }

    get listenerCount() { return this.owner.listenerCount + this.container.listenerCount + this.eventBus.listenerCount + this.visualViewport.listenerCount; }
    dispose() { this.controller?.dispose(); }
}

describe('the PDF viewers\' shared prefetch controller', function () {
    this.timeout(30 * 1000);
    let directory: string | undefined;
    let module: any;
    let pdfCachePolicy: (device?: Record<string, unknown>) => any;
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
                            container.diagnosticsOptions = options;
                            const host = container.diagnosticsHost = {};
                            let enabled = options.enabled === true;
                            return {
                                get enabled() { return enabled; },
                                toggle() { enabled = !enabled; },
                                setEnabled(value) { enabled = value; },
                                setRobotsEnabled(value) { options.robots?.setEnabled(value); },
                                get robotsEnabled() { return options.robots?.enabled ?? false; },
                                labSnapshot() { return undefined; },
                                ownsEvent(event) { return enabled && (event.target === host || event.composedPath?.().includes(host)); },
                                dispose() {},
                            };
                        }`,
                    loader: 'js',
                }));
            },
        };
        try {
            await esbuild.build({
                ...bundleOptions, plugins: [diagnostics, ...bundleOptions.plugins],
                entryPoints: {
                    prefetch: path.join(viewerRoot, 'src', 'common', 'pdf-prefetch.ts'),
                    policy: path.join(viewerRoot, 'src', 'common', 'scroll-prefetch.ts'),
                },
                outdir: directory,
                // eslint-disable-next-line @typescript-eslint/naming-convention -- esbuild's extension map uses literal file extensions
                outExtension: { '.js': '.mjs' },
            });
        } finally { await esbuild.stop(); }
        const previous = Object.getOwnPropertyDescriptor(globalThis, '__pdfPrefetchTestPerformance');
        Object.defineProperty(globalThis, '__pdfPrefetchTestPerformance', { configurable: true, value: fetches });
        try { module = await importModule(output); }
        finally {
            if (previous) { Object.defineProperty(globalThis, '__pdfPrefetchTestPerformance', previous); }
            else { delete (globalThis as any).__pdfPrefetchTestPerformance; }
        }
        ({ pdfCachePolicy } = await importModule(path.join(directory, 'policy.mjs')));
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

    function externalImages(f: Fixture, id = 1) {
        (f.pdf as any).hasExternalImages = true;
        const page = f.pdf.page(id) as any, view = f.pages[id - 1] as any;
        view.pdfPage = page;
        const listeners = new Set<() => void>();
        let redraws = 0, cancellations = 0;
        let cancellation: Promise<void> | undefined;
        page.imageRevision = 0;
        page.imageStatus = { intent: {}, revision: 0, pending: 2, completed: 0, failed: 0, covered: 0, total: 2, final: false, discovered: true };
        page.onImageRevision = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
        page.cancelImageRefinement = () => { cancellations++; return cancellation ?? Promise.resolve(); };
        view.redrawImages = () => { redraws++; view.renderingState = 0; };
        const update = (revision: number, covered: number, final = false) => {
            page.imageRevision = revision;
            page.imageStatus = { intent: page.imageStatus.intent, revision, pending: final ? 0 : 2, completed: final ? 2 : 0, failed: 0, covered, total: 2, final, discovered: true };
        };
        return { page, view, listeners,
            get redraws() { return redraws; }, get cancellations() { return cancellations; },
            holdCancellation(value: Promise<void>) { cancellation = value; },
            emit(revision: number, covered: number, final = false) { update(revision, covered, final); for (const listener of listeners) { listener(); } },
            paint(revision: number, covered: number, final = false) {
                update(revision, covered, final);
                view.imagePassRevision = revision;
                view.imagePassStatus = { ...page.imageStatus };
                f.cachePage(id);
            },
        };
    }

    it('keeps logical native appearance through scale changes and retires detached raster authority', async () => {
        const f = fixture({ startPage: 1, pages: 40, initialNative: false, autoPages: false, mobile: true });
        const images = externalImages(f); await f.frame();
        const view = images.view;
        const publish = (scale: number, intent: object, full: boolean) => {
            view.viewport = { ...view.viewport, width: 800 * scale, height: 1000 * scale, scale,
                transform: [scale, 0, 0, -scale, 0, 1000 * scale] };
            view.outputScale = { sx: 1, sy: 1 };
            f.queue.renderView(view);
            const image = new Canvas(); image.width = 800 * scale; image.height = 1000 * scale; view.canvas = image;
            const status = { revision: full ? 2 : 3, discovered: true, final: full, covered: full ? 2 : 1, total: 2,
                pending: full ? 0 : 1, completed: full ? 2 : 0, failed: 0, untrackedImageOperations: false,
                resources: ['x5', 'x6'].map((imageId, index) => ({ objectId: imageId, imageId, covered: full || index === 0, final: full, failed: false })) };
            images.page.imageStatus = status; images.page.imageRevision = status.revision;
            const accepted = view.publishImageCandidate({ canvas: image, status, intent,
                appearance: view.imageAppearance, geometry: 'scale-' + scale }, () => view.div.prepend(image));
            return { accepted, appearance: view.imageAppearance, image };
        };
        const first = publish(1, {}, true);
        assert.strictEqual(first.accepted, true);
        const zoom = publish(1.25, {}, true);
        assert.strictEqual(zoom.accepted, true);
        assert.strictEqual(zoom.appearance, first.appearance, 'scale and raster transforms are independent of logical appearance');
        view.destroy();
        const returned = publish(1.25, {}, false);
        assert.strictEqual(returned.accepted, true, 'a removed predecessor cannot reject useful partial return pixels');
        assert.strictEqual(returned.image.parentNode, view.div);
        publish(1.25, {}, true);
        view.renderingState = 3; f.cached.add(view);
        f.createCanvas = () => { const image = new Canvas(); image.getContext = () => null as any; return image; };
        const destroyed = view.destroyCalls;
        f.scrollBy(20_000); await f.frame();
        assert.ok(view.destroyCalls > destroyed, 'mobile offscreen policy destroys the old native view when preview allocation fails');
        assert.strictEqual(f.controller.snapshot().previewPages, 0);
        f.scrollBy(-20_000); await f.frame();
        assert.strictEqual(publish(1.25, {}, false).accepted, true, 'controller eviction cannot retain authority over detached predecessor pixels');
    });

    for (const engine of ['pdfjs', 'overleaf']) {
        it(`${engine} retains the accepted preview through repeated rejected native return passes`, async () => {
            const f = fixture({ startPage: 1, pages: 40, initialNative: false, autoPages: false, mobile: true });
            const images = externalImages(f); await f.frame();
            const view = images.view;
            f.queue.renderView(view);
            const complete = { revision: 55, discovered: true, covered: 2, total: 2, pending: 0, completed: 2, failed: 0, final: true,
                resources: ['x5', 'x6'].map(imageId => ({ objectId: imageId, imageId, covered: true, final: true, failed: false })) };
            const original = new Canvas(); original.width = 800; original.height = 1000; view.canvas = original; view.outputScale = { sx: 1, sy: 1 };
            view.publishImageCandidate({ canvas: original, status: complete, intent: {}, appearance: view.imageAppearance, geometry: 'old' }, () => view.div.prepend(original));
            view.paintedImageStatus = complete; view.paintedImageRevision = 55; view.renderingState = 3;
            images.page.imageStatus = complete; images.page.imageRevision = 55; f.cached.add(view);
            f.scrollBy(20_000); await f.frame();
            f.scrollBy(-20_000); view.renderingState = 0; await f.frame();
            const preview = view.div.children.find((node: Element) => node.className === 'pdfPrefetchPreview');
            assert.ok(preview, 'return attaches the accepted cached preview');
            let previewRemovals = 0; const removePreview = preview.remove.bind(preview);
            preview.remove = () => { previewRemovals++; removePreview(); };
            const { pdfjsRelease } = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
            const { imageRevisionViewer } = await importModule(path.join(repo, 'scripts/pdfjs-image-revisions.mjs'));
            const file = engine === 'pdfjs' ? path.join(pdfjsRelease, 'web/viewer.mjs') : path.join(repo, 'node_modules/pdfjs-dist/web/pdf_viewer.mjs');
            const parsed = ts.createSourceFile(file, imageRevisionViewer(fs.readFileSync(file, 'utf8'), file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const base = parsed.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'BasePDFPageView')!;
            const nativeView = new Function('RenderingStates', 'RenderingCancelledException', 'document', base.getText(parsed) + '\nreturn BasePDFPageView;')(
                Object.fromEntries([['INITIAL', 0], ['RUNNING', 1], ['PAUSED', 2], ['FINISHED', 3]]), class extends Error {}, { createElement: () => new Canvas() });
            const native = new nativeView({ id: 1, eventBus: { dispatch() {} } }); native.div = view.div; native.div.classList = { add() {}, remove() {} };
            native.paintedImageStatus = complete; native.paintedImageRevision = 55;
            native.publishImageCandidate = (pass: any, commit: () => void) => view.publishImageCandidate({ ...pass, appearance: view.imageAppearance }, commit);
            for (const revision of [56, 57, 58, 72]) {
                const status = { ...complete, revision, covered: revision === 72 ? 2 : 1, pending: revision === 72 ? 0 : 1, final: revision === 72,
                    resources: complete.resources.map((resource, index) => ({ ...resource, covered: revision === 72 || index === 0, final: revision === 72 })) };
                native.renderingState = view.renderingState = 1;
                const { ctx } = native._createCanvas((canvas: Canvas) => view.div.prepend(canvas));
                native.canvas.width = 800; native.canvas.height = 1000; view.canvas = native.canvas;
                native.pdfPage = { render: () => ({ promise: Promise.resolve(), imageRevision: revision, imageStatus: status, imageIntent: {} }) };
                await native._drawCanvas({ canvasContext: ctx, viewport: { width: 800, height: 1000, transform: [1, 0, 0, -1, 0, 1000] }, transform: [1, 0, 0, 1, 0, 0] }, () => {}, () => {});
                view.canvas = native.canvas; view.imagePassRevision = native.imagePassRevision; view.imagePassStatus = native.imagePassStatus; view.renderingState = 3;
                images.page.imageStatus = status; images.page.imageRevision = revision;
                f.eventBus.emit('pagerendered', { pageNumber: 1, source: view, error: null });
                assert.strictEqual(preview.parentNode, revision === 72 ? null : view.div, 'only accepted complete native replaces the preview');
                await f.frame();
                if (revision === 72) { assert.ok(previewRemovals >= 1 && view.canvas?.parentNode === view.div, 'accepted native publication replaces preview before cache disposal'); }
                else { assert.strictEqual(previewRemovals, 0, 'rejected passes never remove the preview'); }
                assert.deepStrictEqual(f.controller.snapshot().visibleMissing, []);
            }
        });
    }

    it('retires displayed authority for detached and wrong-page wrapper rasters while retaining cache availability', async () => {
        const f = fixture({ startPage: 1, pages: 4, initialNative: false, autoPages: false });
        const images = externalImages(f); await f.frame(); images.paint(1, 2, true); await f.frame();
        const native = images.view.canvas;
        assert.ok(native && native.parentNode === images.view.div);
        const wrapper = new Element(); wrapper.prepend(native!);
        assert.strictEqual(native!.isConnected, false);
        assert.deepStrictEqual(f.controller.snapshot().visibleMissing, [1], 'parentNode in a detached or foreign wrapper is not display authority');
        images.view.div.prepend(wrapper);
        Object.defineProperty(native, 'isConnected', { configurable: true, value: false });
        assert.deepStrictEqual(f.controller.snapshot().visibleMissing, [1], 'an otherwise contained disconnected subtree is not displayed');
    });

    it('keeps semantic loading continuous through image passes and resolves without another draw', async () => {
        const f = fixture({ startPage: 1, pages: 1, initialNative: false, autoPages: false });
        const images = externalImages(f); await f.frame();
        const loading = () => (f.viewer as any).getPageLoadingState(1);
        assert.strictEqual(loading(), true, 'initial render remains pending even if old resource status was final');
        images.paint(0, 0); await f.frame(); assert.strictEqual(loading(), true);
        images.emit(1, 1); await f.frame(); images.paint(1, 1); await f.frame(); assert.strictEqual(loading(), true);
        images.emit(2, 2, true); await f.frame(); assert.strictEqual(loading(), true, 'resource completion still needs its final replay');
        images.paint(2, 2, true); await f.frame(); assert.strictEqual(loading(), false);
        const semantic: boolean[] = []; f.eventBus.on('pageloadingstatechanged', () => semantic.push(loading()));
        images.page.imageStatus = { ...images.page.imageStatus, pending: 1, completed: 1, final: false };
        for (const listener of images.listeners) { listener(); } await f.frame();
        assert.strictEqual(loading(), true);
        const draws = f.nativeRenders.length;
        images.page.imageStatus = { ...images.page.imageStatus, pending: 0, failed: 1, completed: 1, final: false };
        for (const listener of images.listeners) { listener(); } await f.frame();
        assert.strictEqual(loading(), false, 'settled terminal failure does not create phantom work');
        assert.deepStrictEqual(semantic, [true, false], 'source settlement notifies toolbar without a new native pass');
        assert.strictEqual(f.nativeRenders.length, draws);
        f.controller.dispose(); assert.strictEqual((f.viewer as any).getPageLoadingState, undefined);
    });

    it('keeps one canonical page history from early atlas pixels through later native proxy installation', async () => {
        const robots: any = new DocumentRobots();
        const histories = new Map<object, number>(), owners: object[] = [], appearances: string[] = [];
        robots.preparePublication = (candidate: any) => {
            owners.push(candidate.page); appearances.push(candidate.appearance);
            if (!histories.has(candidate.page)) { histories.set(candidate.page, histories.size + 1); }
            return { commit() {}, abort() {} };
        };
        robots.reconcileEncounter = () => {};
        const h = previewFixture({ startPage: 1, pages: 1, initialNative: false, autoPages: false }, robots), f = h.f;
        delete f.pages[0].pdfPage;
        const loader = h.bind(); await f.frame();
        assert.strictEqual(f.pages[0].pdfPage, undefined);
        const atlas = h.publish(loader, 1); assert.strictEqual(atlas.accepted, true);
        assert.deepStrictEqual(f.controller.snapshot().visibleMissing, []);
        f.finishNative(1);
        assert.ok(f.pages[0].pdfPage);
        assert.ok(owners.length >= 2);
        assert.strictEqual(new Set(owners).size, 1, 'proxy installation cannot restart the physical page history');
        assert.strictEqual(histories.size, 1);
        assert.strictEqual(new Set(appearances).size, 1, 'proxy installation cannot change logical appearance');
        const view: any = f.pages[0]; view.pdfPage = {};
        const foreign = new Canvas(); foreign.width = 800; foreign.height = 1000; view.canvas = foreign;
        assert.strictEqual(view.publishImageCandidate({ canvas: foreign, appearance: view.imageAppearance }, () => assert.fail('foreign proxy cannot publish')), false);
    });

    it('supplies the connected coarse predecessor before a sharper publication can release its pixels', async () => {
        const robots: any = new DocumentRobots(), publications: any[] = [];
        robots.preparePublication = (candidate: any, _encounter: any, previous: any) => {
            publications.push({ candidate, previous, priorConnected: previous?.canvas.isConnected,
                priorWidth: previous?.canvas.width, nextConnected: candidate.canvas.isConnected });
            return { commit() {}, abort() {} };
        };
        robots.reconcileEncounter = () => {};
        const f = fixture({ startPage: 1, pages: 1, initialNative: false, autoPages: false },
            { robotsEnabled: true, createDocumentRobots: () => robots });
        const images = externalImages(f);
        await f.frame(); images.paint(1, 1);
        const coarse = images.view.canvas;
        publications.length = 0;
        images.paint(2, 2, true);
        const replacement = publications.find(value => value.candidate.canvas === images.view.canvas);
        assert.ok(replacement?.previous, 'quality preparation receives the actual preceding raster');
        assert.strictEqual(replacement.previous.canvas, coarse);
        assert.strictEqual(replacement.priorConnected, true);
        assert.ok(replacement.priorWidth > 0, 'coarse pixels can be copied before replacement destroys their backing');
        assert.strictEqual(replacement.nextConnected, false, 'the final raster is not exposed before preparation');
        assert.strictEqual(coarse.width, 0, 'ordinary native cleanup still releases the predecessor after commit');
        images.view.div.remove(); publications.length = 0;
        images.paint(3, 2, true);
        assert.ok(publications.length > 0);
        assert.strictEqual(publications.at(-1)?.previous, undefined, 'a raster in a disconnected page cannot authorize a page wipe');
        f.controller.dispose();
    });

    it('publishes consecutive partial passes in one image epoch while retaining the predecessor across a new epoch', async () => {
        const f = fixture({ startPage: 1, pages: 1, initialNative: false, autoPages: false });
        const images = externalImages(f); await f.frame();
        images.paint(1, 1); const first = images.view.canvas;
        images.paint(2, 1); const second = images.view.canvas;
        assert.notStrictEqual(second, first, 'a same-epoch second partial pass must actually publish');
        assert.strictEqual(first.width, 0);
        const oldIntent = images.page.imageStatus.intent;
        images.page.imageStatus.intent = {};
        images.paint(3, 1);
        assert.strictEqual(images.view.canvas, second, 'a new incomplete intent cannot discard previously displayed photo pixels');
        images.paint(4, 2, true);
        assert.notStrictEqual(images.view.canvas, second, 'complete coverage permits the new image epoch to replace its predecessor');
        assert.notStrictEqual(images.page.imageStatus.intent, oldIntent);
    });

    it('starts structural text passes directly while photograph requests are pending', async () => {
        const f = fixture({ startPage: 1, pages: 2, initialNative: false });
        externalImages(f);
        const transfers = Array.from({ length: 12 }, () => fetches.begin());
        await f.frame();
        assert.strictEqual(f.choose(), f.pages[0], 'photo backpressure does not block small native text/layout');
        assert.strictEqual(f.queue.renderView(f.pages[0]), true);
        assert.strictEqual(f.pdf.renders.length, 0, 'no speculative raster pass starts the photographs ahead of text');
        transfers.forEach(id => fetches.end(id));
    });

    it('ends terminal external-image loading while allowing other pending resources to finish', async () => {
        const robots = new DocumentRobots();
        const f = fixture({ startPage: 1, pages: 2, initialNative: false, autoPages: false },
            { robotsEnabled: true, createDocumentRobots: () => robots });
        const images = externalImages(f);
        images.paint(0, 0); await f.frame();
        const publish = async (revision: number, pending: number, covered: number, completed: number) => {
            images.page.imageRevision = revision;
            images.page.imageStatus = { revision, pending, completed, failed: 1, covered, total: 2, final: false, discovered: true };
            for (const listener of images.listeners) { listener(); }
            await f.frame();
            images.view.imagePassRevision = images.view.paintedImageRevision = revision;
            images.view.imagePassStatus = images.view.paintedImageStatus = { ...images.page.imageStatus };
            f.cachePage(1); await f.frame();
        };
        await publish(1, 1, 0, 0);
        assert.strictEqual(images.page.cleanupCalls, 0, 'one failure cannot release resources needed by the independent pending image');
        assert.ok(['waiting', 'preparing'].includes(robots.workCalls.at(-1)![0].pages[0].state),
            'one failed resource cannot terminate the still-pending independent resource');
        await publish(2, 0, 1, 1);
        assert.strictEqual(images.view.paintedImageStatus.covered, 1);
        assert.strictEqual(robots.workCalls.at(-1)![0].pages[0].state, 'failed',
            'settled failed work cannot remain a phantom waiting or parked preparation episode');
        const redraws = images.redraws;
        await f.frame();
        assert.strictEqual(images.redraws, redraws, 'settled terminal facts do not restart the failed attempt');
        assert.deepStrictEqual(f.controller.snapshot().visibleMissing, []);
        assert.strictEqual(f.controller.snapshot().starved, false);
        assert.ok(f.controller.snapshot().failed.includes(1));
        assert.strictEqual(f.controller.snapshot().idle, true);
    });

    it('coalesces native image revisions and keeps resources until final painted quality', async () => {
        const f = fixture({ startPage: 1, pages: 2, initialNative: false, mobile: true });
        const images = externalImages(f);
        images.paint(0, 0); await f.frame();
        assert.strictEqual(images.page.cleanupCalls, 0, 'a FINISHED text pass still owns pending image resources');
        assert.strictEqual(f.controller.snapshot().previewPages, 0, 'placeholder photos cannot replace useful cached pixels');
        images.emit(1, 1); images.emit(2, 2);
        assert.strictEqual(f.callbacks.size, 1, 'all installed scans share the existing scheduled frame');
        await f.frame();
        assert.strictEqual(images.redraws, 1);
        images.paint(2, 2); await f.frame();
        assert.strictEqual(images.page.cleanupCalls, 0);
        const covered = f.controller.snapshot().imagePages[0];
        assert.strictEqual(covered.paintedStatus.covered, 2);
        assert.ok(Number.isFinite(covered.firstCoverageAt));
        images.emit(3, 2, true); await f.frame();
        assert.strictEqual(images.redraws, 2);
        images.paint(3, 2, true); await f.frame();
        assert.ok(images.page.cleanupCalls > 0, 'the normal cleanup owner releases final native resources');
        assert.strictEqual(f.controller.snapshot().imagePages[0].paintedStatus.final, true);
        const resume = await f.controller.pauseImageRefinement();
        resume(); await f.frame();
        assert.strictEqual(images.cancellations, 0, 'finished image objects do not become restart work during a representation pause');
        assert.strictEqual(images.redraws, 2);
        await f.frame();
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(f.controller.snapshot().idle, true);
    });

    it('measures ready-photo latency through first painted coverage without erasing it on later scans', async () => {
        const f = fixture({ startPage: 1, pages: 1, initialNative: false });
        const images = externalImages(f);
        images.paint(0, 0); await f.frame();
        assert.deepStrictEqual(f.controller.snapshot().visibleMissing, [1], 'sharp text alone does not advertise photo coverage ahead');
        f.time += 2400;
        images.emit(1, 2); await f.frame(); images.paint(1, 2); await f.frame();
        const ready = f.controller.snapshot();
        assert.deepStrictEqual(ready.visibleMissing, []);
        assert.ok(ready.pageLatencyMs >= 2400, 'network and scan preparation belong to the readiness estimate');
        assert.ok(ready.imagePages[0].coverageLatencyMs >= 2400);
        images.emit(2, 2, true); await f.frame(); images.paint(2, 2, true); await f.frame();
        assert.strictEqual(f.controller.snapshot().pageLatencyMs, ready.pageLatencyMs, 'short repaint passes do not erase the measured delivery horizon');
    });

    it('does not replay an already attempted partial pass behind a retained painted canvas', async () => {
        const f = fixture({ startPage: 1, pages: 1, initialNative: false });
        const images = externalImages(f);
        images.paint(1, 2); await f.frame();
        images.emit(2, 1);
        images.view.imagePassRevision = 2;
        images.view.imagePassStatus = { ...images.page.imageStatus };
        await f.frame();
        assert.strictEqual(images.redraws, 0, 'displayed and attempted revisions have different authority');
        assert.strictEqual(images.view.paintedImageRevision, 1);
        images.emit(3, 2); await f.frame();
        assert.strictEqual(images.redraws, 1);
    });

    it('keeps an existing whole-page preview through a placeholder pass until painted photo coverage', async () => {
        const f = fixture({ startPage: 1, pages: 1 });
        await f.frame();
        f.pages[0].reset(); await f.frame();
        const images = externalImages(f);
        images.paint(0, 0); await f.frame();
        const preview = f.pages[0].div.children.find(child => child.className === 'pdfPrefetchPreview');
        assert.ok(preview, 'a FINISHED placeholder pass must not remove the old useful preview');
        images.paint(1, 2); await f.frame();
        assert.strictEqual(f.pages[0].div.children.some(child => child.className === 'pdfPrefetchPreview'), false);
        assert.ok(f.controller.snapshot().previewPages > 0, 'detached coarse coverage stays within the existing cache');
    });

    it('waits for old image-state cancellation before releasing an upgrade suspension lease', async () => {
        const f = fixture({ startPage: 1, pages: 1, initialNative: false });
        const images = externalImages(f);
        images.paint(0, 0); await f.frame();
        const canvas = images.view.canvas, ack = new Deferred<void>();
        images.holdCancellation(ack.promise);
        let released = false;
        const waiting = f.controller.pauseImageRefinement().then((resume: () => void) => { released = true; return resume; });
        await promisesSettled();
        assert.strictEqual(images.cancellations, 1);
        assert.strictEqual(released, false);
        assert.strictEqual(f.choose(), null);
        assert.strictEqual(images.view.canvas, canvas, 'the reader keeps its displayed backing');
        ack.resolve();
        const resume = await waiting;
        resume(); resume(); await f.frame();
        assert.strictEqual(images.redraws, 1, 'resume rebuilds a cancelled intent through the native queue');
        assert.strictEqual(images.view.canvas, canvas);
    });

    it('cancels offscreen image work and rejects obsolete subscriptions after document replacement', async () => {
        const f = fixture({ startPage: 1, pages: 2, initialNative: false });
        const images = externalImages(f);
        images.paint(0, 0); await f.frame();
        const stale = [...images.listeners][0];
        f.scrollBy(1000); await f.frame();
        assert.strictEqual(images.cancellations, 1);
        assert.strictEqual(images.listeners.size, 0);
        f.scrollBy(-1000); await f.frame();
        assert.strictEqual(images.redraws, 1, 'returning to a retained partial page restarts its cancelled intent');
        f.replaceDocument(); await f.frame();
        const callbacks = f.callbacks.size;
        stale();
        assert.strictEqual(f.callbacks.size, callbacks, 'a previous document cannot schedule a new revision');
    });

    it('returns to idle when an offscreen image cancellation acknowledgment releases the last owner', async () => {
        const f = fixture({ startPage: 1, pages: 2, initialNative: false });
        const leaving = externalImages(f), ready = externalImages(f, 2);
        ready.paint(1, 2, true); leaving.paint(0, 0); await f.frame();
        const ack = new Deferred<void>(); leaving.holdCancellation(ack.promise);
        f.visibleIds = [2]; f.eventBus.emit('updateviewarea'); await f.frame();
        assert.strictEqual(leaving.cancellations, 1);
        assert.strictEqual(f.controller.snapshot().idle, false);
        ack.resolve(); await promisesSettled();
        assert.strictEqual(f.controller.snapshot().idle, true, 'the acknowledgment is the completion event; another user scroll is not required');
        assert.strictEqual(f.callbacks.size, 0, 'a completed offscreen owner does not need a paint');
    });

    it('supplies the current page content size without measuring a spread or rereading layout', async () => {
        let settings: any;
        const fleet = new DocumentRobots();
        const f = fixture({ initialNative: false, width: 640, height: 900 }, {
            robotsEnabled: true, createDocumentRobots: (_container: Element, value: any) => { settings = value; return fleet; },
        });
        await f.frame();
        f.visibleIds = [20, 21];
        f.pages[20].viewport = { width: 900, height: 640, scale: 1, rotation: 90 };
        f.eventBus.emit('updateviewarea'); await f.frame();
        let reads = 0;
        for (const view of f.pages) {
            const original = view.div.getBoundingClientRect.bind(view.div);
            view.div.getBoundingClientRect = () => { reads++; return original(); };
        }
        for (let sample = 0; sample < 20; sample++) {
            assert.deepStrictEqual(settings.documentSize(), { width: 640, height: 900 });
        }
        assert.strictEqual(reads, 0, 'the admitted column size comes from numeric content geometry');
        f.visibleIds = [21]; f.eventBus.emit('updateviewarea'); await f.frame();
        reads = 0;
        assert.deepStrictEqual(settings.documentSize(), { width: 900, height: 640 });
        assert.strictEqual(reads, 0);
    });

    it('shares docked column geometry with the document renderer and cancels retired editions before a pull', async () => {
        const fleet = new DocumentRobots(); let settings: any;
        const f = fixture({}, { robotsEnabled: true, createDocumentRobots: (_container: Element, value: any) => {
            settings = value; fleet.onReplacementComplete = value.onReplacementComplete; return fleet;
        } });
        await f.frame();
        assert.ok(f.columnSettings, 'the shared controller installs the column owner once');
        assert.deepStrictEqual(f.columnSettings.pages(), [f.pages[19].div]);
        f.column.offsetX = -80;
        assert.strictEqual(settings.documentOffset(), -80, 'the renderer reads the actual applied translation');
        const layer = new Element();
        const unregister = settings.registerDocumentLayer(layer);
        assert.deepStrictEqual(f.column.layers, [layer]);
        unregister(); assert.strictEqual(f.column.releases, 1);
        const panel = { visible: true, dock: 'right', rect: { x: 650, y: 40, width: 350, height: 500 }, reason: 'dock' };
        assert.strictEqual((f.container as any).diagnosticsOptions.onPanelLayout(panel), undefined,
            'a stationary column does not delay panel docking');
        assert.deepStrictEqual(f.column.panels, [panel]);
        f.controller.prepareReplacement('next-edition'); f.eventBus.emit('pagesdestroy');
        assert.strictEqual(fleet.replacement, 'next-edition');
        const motion = { id: 1, fromX: 0, toX: -80, startedAt: f.time, durationMs: 400, reason: 'dock', dock: 'right' };
        f.columnSettings.onTransition(motion);
        assert.strictEqual(fleet.replacement, undefined, 'a fresh docking scene cancels the captured retirement first');
        assert.strictEqual(fleet.columnMotions.at(-1), motion);
        f.column.transition = motion;
        f.column.ready = false; f.column.readyAt = motion.startedAt + motion.durationMs;
        const preparation = (f.container as any).diagnosticsOptions.onPanelLayout(panel);
        assert.strictEqual(preparation.readyAt, motion.startedAt + motion.durationMs, 'docking follows the owned column scene deadline');
        assert.strictEqual(preparation.isReady(), false);
        f.column.transition = undefined;
        f.column.ready = true;
        assert.strictEqual((f.container as any).diagnosticsOptions.onPanelLayout(panel), undefined,
            'a finished or cancelled column leaves no stale docking delay');
        f.columnSettings.onTransition(undefined);
        assert.strictEqual(fleet.columnMotions.at(-1), undefined);
        f.container.emit('pointerdown', { isTrusted: false });
        assert.strictEqual(fleet.revealedArrivals, 0);
        f.container.emit('pointerdown', { isTrusted: true, stoppedAtTarget: true });
        assert.ok(fleet.columnCancels > 0, 'trusted navigation can end the optional pull immediately');
        assert.strictEqual(fleet.revealedArrivals, 0, 'trusted annotation input does not retire the active photo delivery');
        f.dispose();
        assert.strictEqual(f.column.disposed, true);
        const calls = fleet.columnMotions.length;
        f.columnSettings.onTransition(motion);
        assert.strictEqual(fleet.columnMotions.length, calls, 'late column completion cannot recreate scene work');
    });

    it('keeps docking preparation live while calm column work is pending or continues into another leg', async () => {
        const f = fixture(); await f.frame();
        f.column.ready = false; f.column.readyAt = f.time + 2800;
        const panel = { visible: true, dock: 'left', rect: { x: 8, y: 8, width: 300, height: 700 }, reason: 'dock' };
        const preparation = (f.container as any).diagnosticsOptions.onPanelLayout(panel);
        assert.ok(preparation, 'a quiet-period destination delays docking even before a transition starts');
        assert.strictEqual(preparation.isReady(), false);
        assert.strictEqual(preparation.readyAt, f.time + 2800);
        f.column.readyAt += 2500;
        assert.strictEqual(preparation.readyAt, f.time + 5300, 'an already-returned preparation reads the continued deadline');
        f.column.ready = true;
        assert.strictEqual(preparation.isReady(), true, 'actual completion releases the panel without waiting for the robot return');
        f.column.ready = false; f.dispose();
        assert.strictEqual(preparation.isReady(), true, 'disposed owners cannot retain a pending panel scene');
    });

    it('keeps forklift ownership during Lab keyboard gestures while genuine reader input still preempts it', async () => {
        const fleet = new DocumentRobots();
        const f = fixture({}, { robotsEnabled: true, createDocumentRobots: (_container: Element, options: any) => {
            fleet.onReplacementComplete = options.onReplacementComplete; return fleet;
        } });
        await f.frame(); f.controller.setDiagnosticsEnabled(true);
        f.controller.prepareReplacement('next-edition'); f.eventBus.emit('pagesdestroy');
        const host = (f.container as any).diagnosticsHost;
        f.owner.emit('keydown', { key: 'ArrowRight', isTrusted: true, target: host, stoppedAtTarget: true });
        f.owner.emit('keydown', { key: 'ArrowLeft', isTrusted: true, target: {}, stoppedAtTarget: true,
            composedPath: () => [{}, host, f.owner] });
        assert.strictEqual(fleet.columnCancels, 0, 'document capture does not cancel the owned Lab gesture before its handler');
        assert.strictEqual(fleet.replacement, 'next-edition');
        f.owner.emit('keydown', { key: 'ArrowDown', isTrusted: true, target: { id: 'pdf-prefetch-diagnostics' },
            composedPath: () => [f.container, f.owner] });
        assert.strictEqual(fleet.columnCancels, 1, 'only the actual diagnostics host is excluded');
        assert.strictEqual(fleet.replacement, undefined);
    });

    for (const input of ['wheel', 'pointerdown', 'touchstart', 'keydown']) {
        it('preserves active photo ownership on trusted ' + input + ' while cancelling replacement and column motion', async () => {
            const fleet = new DocumentRobots();
            const f = fixture({}, { robotsEnabled: true, createDocumentRobots: (_container: Element, options: any) => {
                fleet.onReplacementComplete = options.onReplacementComplete; return fleet;
            } });
            await f.frame();
            f.controller.prepareReplacement('next-edition'); f.eventBus.emit('pagesdestroy');
            assert.strictEqual(fleet.replacement, 'next-edition');
            const target = input === 'keydown' ? f.owner : f.container;
            target.emit(input, { isTrusted: true, deltaY: 1, deltaX: 0, deltaMode: 0 });
            assert.strictEqual(fleet.replacement, undefined);
            assert.ok(fleet.columnCancels > 0);
            assert.strictEqual(fleet.revealedArrivals, 0, 'ordinary input leaves the copied raster and destination cover owned by the delivery');
            f.dispose();
        });
    }

    it('updates the translated page set after viewport changes without changing PDF scale or scroll', async () => {
        const f = fixture(); await f.frame();
        const before = { scale: f.viewer.currentScale, top: f.container.scrollTop, left: f.container.scrollLeft };
        const updates = f.column.updates;
        f.visibleIds = [20, 21]; f.eventBus.emit('updateviewarea'); await f.frame();
        assert.ok(f.column.updates > updates);
        assert.deepStrictEqual(f.columnSettings.pages(), [f.pages[19].div, f.pages[20].div]);
        assert.deepStrictEqual({ scale: f.viewer.currentScale, top: f.container.scrollTop, left: f.container.scrollLeft }, before);
    });

    it('render timing omits native completions spanning hide, layout or document replacement', async () => {
        for (const ending of ['hide', 'layout', 'replace', 'dispose']) {
            const f = fixture({ pages: 1, startPage: 1 }); await f.frame();
            const initialLatency = f.controller.snapshot().pageLatencyMs;
            f.pages[0].renderingState = 1;
            f.eventBus.emit('pagerender', { pageNumber: 1 });
            f.time += 40;
            if (ending === 'hide') { f.owner.visibilityState = 'hidden'; f.owner.emit('visibilitychange'); }
            else if (ending === 'layout') { f.eventBus.emit('scalechanging'); }
            else if (ending === 'replace') { f.replaceDocument(); }
            else { f.dispose(); }
            const afterExitLatency = f.controller.snapshot().pageLatencyMs;
            if (ending === 'hide' || ending === 'layout') { assert.strictEqual(afterExitLatency, initialLatency); }
            assert.strictEqual([...timers.values()].filter(timer => timer.delay === 1000).length, 0, ending + ' stops the active timing probe');
            f.time += 43000;
            f.pages[0].renderingState = 3;
            f.eventBus.emit('pagerendered', { pageNumber: 1, error: null, cssTransform: false });
            assert.strictEqual(f.controller.snapshot().pageLatencyMs, afterExitLatency, ending + ' cannot teach the predictor a paused render duration');
        }
    });

    it('render timing omits a frame-suspended native sample while the document remains visible', async () => {
        const f = fixture({ pages: 1, startPage: 1 }); await f.frame();
        const initialLatency = f.controller.snapshot().pageLatencyMs;
        f.pages[0].renderingState = 1;
        f.eventBus.emit('pagerender', { pageNumber: 1 });
        const probe = [...timers].find(([, timer]) => timer.delay === 1000);
        assert.ok(probe, 'only active native work creates a frame-availability probe');
        f.time += 1000; timers.delete(probe[0]); probe[1].callback();
        f.time += 42000;
        f.pages[0].renderingState = 3;
        f.eventBus.emit('pagerendered', { pageNumber: 1, error: null, cssTransform: false });
        assert.strictEqual(f.owner.visibilityState, 'visible');
        assert.strictEqual(f.controller.snapshot().pageLatencyMs, initialLatency);
        assert.strictEqual([...timers.values()].filter(timer => timer.delay === 1000).length, 0);
        f.pages[0].renderingState = 1;
        f.eventBus.emit('pagerender', { pageNumber: 1 });
        f.time += 37; f.pages[0].renderingState = 3;
        f.eventBus.emit('pagerendered', { pageNumber: 1, error: null, cssTransform: false });
        assert.strictEqual(f.controller.snapshot().pageLatencyMs, 37, 'later active work resumes ordinary estimation');
    });

    it('render timing preserves a genuinely blocked foreground native duration', async () => {
        const f = fixture({ pages: 1, startPage: 1 }); await f.frame();
        f.pages[0].renderingState = 1;
        f.eventBus.emit('pagerender', { pageNumber: 1 });
        // Neither frame nor timer callbacks run during one blocking task.
        f.time += 60000; f.pages[0].renderingState = 3;
        f.eventBus.emit('pagerendered', { pageNumber: 1, error: null, cssTransform: false });
        assert.strictEqual(f.controller.snapshot().pageLatencyMs, 60000, 'a real slow render is not capped or recast as suspension');
        assert.strictEqual([...timers.values()].filter(timer => timer.delay === 1000).length, 0);
    });

    it('render timing omits a suspended preparation and releases its observation before cold-slot trimming', async () => {
        const f = fixture({ pages: 2, startPage: 1 }); await f.frame();
        const initialLatency = f.controller.snapshot().pageLatencyMs;
        const render = f.pdf.activeRenders.find(value => value.id === 2);
        assert.ok(render);
        const probe = [...timers].find(([, timer]) => timer.delay === 1000);
        assert.ok(probe);
        f.time += 1000; timers.delete(probe[0]); probe[1].callback();
        f.time += 42000; render.task.finish(); await promisesSettled();
        assert.strictEqual(f.controller.snapshot().pageLatencyMs, initialLatency);
        assert.strictEqual([...timers.values()].filter(timer => timer.delay === 1000).length, 0, 'settled preparation never leaves an idle timing heartbeat');
    });

    function robotFixture(enabled = true, options: FixtureOptions = {}) {
        const robots = new DocumentRobots();
        const factories: Element[] = [];
        const f = fixture(options, {
            robotsEnabled: enabled,
            createDocumentRobots: (container: Element, options?: { onCapacityAvailable?: () => void; onReplacementComplete?: (identity: string) => void }) => {
                factories.push(container);
                robots.onCapacityAvailable = options?.onCapacityAvailable;
                robots.onReplacementComplete = options?.onReplacementComplete;
                return robots;
            },
        });
        return { f, robots, factories };
    }

    it('replacement captures old visible pixels only at an armed successful document commit', async () => {
        const { f, robots } = robotFixture(); await f.frame();
        const old = f.pages[19], canvas = old.canvas, resets = robots.resetCalls;
        const cancel = f.controller.prepareReplacement('edition-b');
        assert.strictEqual(robots.retirements.length, 0, 'preflight alone cannot copy or dismantle the active edition');
        assert.strictEqual(robots.resetCalls, resets);
        f.replaceDocument();
        assert.strictEqual(robots.retirements.length, 1);
        assert.strictEqual(robots.retirements[0].identity, 'edition-b');
        assert.strictEqual(robots.retirements[0].pages[0].canvas, canvas);
        assert.strictEqual(robots.retirements[0].pages[0].pageElement, old.div);
        assert.deepStrictEqual(robots.retirements[0].sizes[0], [800, 1000]);
        assert.strictEqual(robots.resetCalls, resets + 1, 'pagesinit must not reset the separately owned retiring scene again');
        f.eventBus.emit('scalechanging'); f.eventBus.emit('spreadmodechanged');
        assert.strictEqual(robots.replacement, 'edition-b', 'automatic initial-view restoration preserves only the viewport-frozen teardown');
        await f.frame();
        assert.strictEqual(robots.replacement, 'edition-b');
        assert.strictEqual(robots.deliveries[robots.deliveries.length - 1].pageElement, f.pages[19].div);
        cancel();
        assert.strictEqual(robots.replacement, undefined);
        assert.ok(robots.hasHandled(20), 'late cancellation removes only teardown, not the new document episode history');
    });

    it('replacement cancellation and superseded preflights leave the current edition untouched', async () => {
        const { f, robots } = robotFixture(); await f.frame();
        const resets = robots.resetCalls, abort = new AbortController();
        const canceled = f.controller.prepareReplacement('edition-failed', abort.signal);
        abort.abort(); canceled();
        assert.strictEqual(robots.resetCalls, resets);
        assert.strictEqual(robots.retirements.length, 0);
        const oldCancel = f.controller.prepareReplacement('edition-old');
        const nextCancel = f.controller.prepareReplacement('edition-current');
        oldCancel();
        f.replaceDocument();
        assert.deepStrictEqual(robots.retirements.map(value => value.identity), ['edition-current']);
        nextCancel();
        assert.strictEqual(robots.replacementCancels, 1);
        f.replaceDocument();
        assert.strictEqual(robots.retirements.length, 1, 'an unarmed later load cannot replay the consumed capture');
    });

    it('replacement teardown is canceled by lifecycle exits and real reader navigation', async () => {
        for (const ending of ['hide', 'reader-layout', 'wheel', 'pointer', 'dispose']) {
            const { f, robots } = robotFixture(); await f.frame();
            f.controller.prepareReplacement('edition-b'); f.replaceDocument();
            assert.strictEqual(robots.replacement, 'edition-b');
            if (ending === 'hide') { f.owner.visibilityState = 'hidden'; f.owner.emit('visibilitychange'); }
            else if (ending === 'reader-layout') { f.owner.emit('keydown', { isTrusted: true }); f.eventBus.emit('scalechanging'); }
            else if (ending === 'wheel') { f.container.emit('wheel', { deltaY: 30, deltaMode: 0, isTrusted: true }); }
            else if (ending === 'pointer') { f.container.emit('pointerdown', { isTrusted: true }); }
            else { f.dispose(); }
            assert.strictEqual(robots.replacement, undefined, ending);
            assert.strictEqual(robots.replacementCancels, 1, ending + ' cancels the finite teardown once');
        }
    });

    function previewFixture(options: FixtureOptions = {}, robots?: DocumentRobots, installOverrides: Record<string, unknown> = {}) {
        const loaders: Array<any> = [];
        const source = { identity: { key: 'exact-output', size: 1000 }, loadManifest: async () => null,
            loadAsset: async () => new Uint8Array() };
        const f = fixture(options, {
            ...installOverrides,
            robotsEnabled: !!robots,
            ...(robots ? { createDocumentRobots: (_container: Element, settings: any) => {
                robots.onCapacityAvailable = settings.onCapacityAvailable; return robots;
            } } : {}),
            createPreviewSourceLoader: (_source: any, settings: any) => {
                const loader: any = { settings, disposed: false, active: false, state: 'ready', pending: new Set<number>(),
                    metadata: new Map<number, any>(), updates: [] as any[],
                    page(id: number) { return this.metadata.get(id); },
                    isPending(id: number) { return this.pending.has(id); },
                    update(requests: any[], active: boolean) { this.active = active; this.updates.push({ requests, active }); },
                    snapshot() { return { state: this.state, pending: this.pending.size }; },
                    dispose() { this.disposed = true; this.active = false; },
                };
                loaders.push(loader); return loader;
            },
        });
        function bind() { f.controller.setPreviewSource(source, f.pdf); return loaders[loaders.length - 1]; }
        function metadata(id: number) {
            return { pageNumber: id, width: f.pdf.width, height: f.pdf.height, rotation: 0, assets: [],
                imageRegions: [{ id: 'photo-' + id, x: 0.125, y: 0.25, width: 0.5, height: 0.25 }] };
        }
        function publish(loader: any, id: number, width = 160, height = 200) {
            const page = loader.metadata.get(id) ?? metadata(id); loader.metadata.set(id, page);
            const canvas = new Canvas(); canvas.width = width; canvas.height = height;
            const projection = { width, height, pageToRaster: [width, 0, 0, height, 0, 0] };
            return { canvas, accepted: loader.settings.onPreview(page, canvas, projection) };
        }
        return { f, source, loaders, bind, metadata, publish };
    }

    function coveredMobileMotion(options: FixtureOptions = {}) {
        const h = previewFixture({ mobile: true, pages: 1, startPage: 1, initialNative: false, ...options });
        const loader = h.bind();
        const preview = h.publish(loader, 1).canvas;
        h.f.container.emit('wheel', { deltaY: 600, deltaMode: 0 });
        return { ...h, preview };
    }

    function endGesture(f: Fixture) {
        const timer = [...timers].find(([, value]) => value.delay === 250);
        assert.ok(timer, 'the existing gesture settle event is scheduled');
        timers.delete(timer[0]);
        f.time += timer[1].delay;
        timer[1].callback();
    }

    it('defers covered mobile cold work through both native selection and preparation until the existing gesture settles', async () => {
        const h = coveredMobileMotion(), f = h.f, view = f.pages[0];
        await f.frame();
        assert.strictEqual(h.preview.parentNode, view.div, 'useful preview pixels are attached before admission');
        assert.strictEqual(f.pdf.requests.length, 0, 'pump does not start a cold page underneath displayed pixels during motion');
        assert.strictEqual(f.choose(), null, 'native priority respects the same cold-page admission');
        assert.strictEqual(f.queue.renderView(view), false, 'a previously selected native page cannot bypass the fence');
        for (let i = 0; i < 3; i++) { f.eventBus.emit('updateviewarea'); await f.frame(); }
        assert.strictEqual(f.pdf.requests.length, 0);
        assert.strictEqual(f.callbacks.size, 0, 'covered motion does not create an animation loop');
        assert.deepStrictEqual([...timers.values()].map(timer => timer.delay), [250], 'only the existing gesture timer remains');
        endGesture(f);
        assert.strictEqual(f.callbacks.size, 1, 'settling requests one existing refresh');
        await f.frame();
        assert.deepStrictEqual(f.pdf.requests.map(request => request.id), [1]);
        assert.strictEqual(f.pdf.activeRenders.length, 1);
        await f.frame();
        assert.strictEqual(f.pdf.requests.length, 1, 'native selection and pump share one preparation');
        f.pdf.activeRenders[0].task.finish(); await promisesSettled(); f.finishNative(1);
        await f.frame(); await f.frame();
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(timers.size, 0, 'completed refinement has no admission polling');
    });

    it('rechecks covered mobile motion after a late getPage without starting or retaining a cold render', async () => {
        const h = previewFixture({ mobile: true, pages: 1, startPage: 1, initialNative: false, autoPages: false }), f = h.f;
        const loader = h.bind(); await f.frame();
        assert.strictEqual(f.pdf.requests.length, 1);
        const preview = h.publish(loader, 1).canvas;
        assert.strictEqual(preview.parentNode, f.pages[0].div);
        f.container.emit('wheel', { deltaY: 600, deltaMode: 0 });
        f.pdf.requests[0].result.resolve(f.pdf.page(1)); await promisesSettled(); await f.frame();
        assert.strictEqual(f.pdf.renders.length, 0, 'late page metadata cannot start obsolete cold decoding');
        assert.deepStrictEqual(f.controller.snapshot().pending, [], 'the unstarted job releases its admission slot');
        assert.strictEqual(f.choose(), null);
        endGesture(f); await f.frame();
        assert.strictEqual(f.pdf.requests.length, 2, 'the current settled page gets one fresh attempt');
        f.pdf.answerAll(); await promisesSettled();
        assert.strictEqual(f.pdf.activeRenders.length, 1);
    });

    for (const ending of ['reverse', 'zoom'] as const) {
        it('refines the covered mobile page after ' + ending + ' without a stale motion hold', async () => {
            const { f } = coveredMobileMotion(); await f.frame();
            assert.strictEqual(f.pdf.requests.length, 0);
            if (ending === 'reverse') {
                f.container.emit('wheel', { deltaY: -600, deltaMode: 0 }); await f.frame();
                assert.strictEqual(f.pdf.requests.length, 0, 'reversal retains useful pixels while motion continues');
                endGesture(f);
            } else {
                f.pages[0].viewport = { ...f.pages[0].viewport, width: 1200, height: 1500, scale: 1.5 };
                f.eventBus.emit('scalechanging');
            }
            await f.frame();
            assert.strictEqual(f.pdf.activeRenders.length, 1);
            assert.strictEqual(f.pdf.requests.length, 1);
            if (ending === 'zoom') {
                assert.ok(f.pdf.activeRenders[0].parameters.imageDecodeScale >= 1.5, 'refinement uses the new native geometry');
            }
        });
    }

    it('preserves warm, running and already-finished native pixels during covered mobile motion', async () => {
        const h = previewFixture({ mobile: true, pages: 1, startPage: 1, initialNative: false }), f = h.f;
        const loader = h.bind(); await f.frame();
        const task = f.pdf.activeRenders[0].task;
        h.publish(loader, 1); f.container.emit('wheel', { deltaY: 600, deltaMode: 0 });
        assert.strictEqual(f.queue.renderView(f.pages[0]), true, 'an already-admitted preparation is allowed to finish');
        task.finish(); await promisesSettled();
        assert.strictEqual(f.choose(), f.pages[0], 'warm decoded resources keep native priority');
        for (const state of [1, 2]) {
            f.pages[0].renderingState = state;
            assert.strictEqual(f.queue.renderView(f.pages[0]), true);
        }
        f.finishNative(1);
        const canvas = f.pages[0].canvas; await f.frame();
        assert.strictEqual(f.pages[0].canvas, canvas);
        assert.ok(canvas!.width > 0 && canvas!.height > 0);
        assert.strictEqual(f.pdf.requests.length, 1);
        assert.strictEqual(task.cancellationCalls, 0, 'motion does not cancel useful in-flight native work');
    });

    for (const coverage of ['missing', 'unusable-geometry', 'empty-backing'] as const) {
        it('starts mobile native fallback during motion when preview coverage is ' + coverage, async () => {
            const h = previewFixture({ mobile: true, pages: 1, startPage: 1, initialNative: false }), f = h.f;
            if (coverage !== 'missing') {
                const preview = h.publish(h.bind(), 1).canvas;
                if (coverage === 'unusable-geometry') { f.pages[0].viewport = { ...f.pages[0].viewport, width: 0 }; }
                else { preview.width = 0; }
            }
            f.container.emit('wheel', { deltaY: 600, deltaMode: 0 }); await f.frame();
            assert.strictEqual(f.pdf.activeRenders.length, 1, 'a cached allocation without usable pixels cannot block fallback');
            assert.strictEqual(f.choose(), f.pages[0]);
            assert.strictEqual(f.queue.renderView(f.pages[0]), true);
        });
    }

    it('keeps a detached cached preview from blocking native selection and leaves desktop admission unchanged', async () => {
        const h = coveredMobileMotion(), f = h.f; await f.frame();
        assert.strictEqual(f.pdf.requests.length, 0);
        h.preview.remove();
        assert.strictEqual(f.choose(), f.pages[0], 'a reset page with detached pixels retains native fallback');
        f.queue.renderView(f.pages[0]); await promisesSettled();
        assert.strictEqual(f.pdf.activeRenders.length, 1);
        const desktop = coveredMobileMotion({ mobile: false }).f; await desktop.frame();
        assert.strictEqual(desktop.pdf.activeRenders.length, 1);
    });

    function measuredNative(f: Fixture, displayed = () => true) {
        const view = f.pages[0], canvas = new Canvas();
        view.div.clientWidth = 330; view.div.clientHeight = 470;
        view.viewport = { width: 332.59866666666665, height: 472.4406666666667, scale: 0.5, rotation: 0 };
        view.outputScale = { sx: 1.2, sy: 1.2 };
        view.pdfPage = f.pdf.page(1);
        canvas.width = 396; canvas.height = 564;
        canvas.getBoundingClientRect = () => {
            if (!displayed()) { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
            const box = view.div.getBoundingClientRect(), left = box.left + view.div.clientLeft, top = box.top + view.div.clientTop;
            return { x: left, y: top, left, top, right: left + view.div.clientWidth, bottom: top + view.div.clientHeight,
                width: view.div.clientWidth, height: view.div.clientHeight };
        };
        view.canvas = canvas; view.renderingState = 1;
        f.eventBus.emit('pagerender', { pageNumber: 1, source: view });
        return { view, canvas, publish() {
            const managed = view as any;
            assert.strictEqual(managed.publishImageCandidate({ canvas, appearance: managed.imageAppearance, geometry: 'measured', intent: {} },
                () => view.div.prepend(canvas)), true);
        } };
    }

    function near(actual: number, expected: number, reason: string) {
        assert.ok(Math.abs(actual - expected) < 1e-8, reason + ': ' + actual + ' versus ' + expected);
    }

    function previewMatrix(canvas: Canvas) {
        assert.match(canvas.style.transform ?? '', /^matrix\(/, 'the retained preview uses its raster-to-page transform');
        return canvas.style.transform.slice(7, -1).split(',').map(Number);
    }

    it('projects a complete atlas onto the captured fractional native page instead of squeezing it into the clipped backing', async () => {
        const robots = new DocumentRobots();
        const h = previewFixture({ pages: 1, startPage: 1, width: 332.59866666666665, height: 472.4406666666667,
            initialNative: false, autoPages: false }, robots), f = h.f;
        const { view, canvas: native, publish } = measuredNative(f), loader = h.bind();
        await f.frame();
        const preview = h.publish(loader, 1, 541, 768).canvas;
        const matrix = previewMatrix(preview);
        near(matrix[0] * 330, view.viewport.width, 'full atlas horizontal extent');
        near(matrix[3] * 470, view.viewport.height, 'full atlas vertical extent');
        assert.strictEqual(preview.style.width, '330px', 'the untransformed CSS box remains bounded by the page');
        assert.strictEqual(preview.style.height, '470px');
        assert.match(preview.style.clipPath, /^inset\(/, 'the preview itself clips at the native inner page');
        const delivered = robots.deliveries[0];
        near(delivered.pageProjection!.content.width, view.viewport.width, 'delivery uses the logical page width');
        assert.deepStrictEqual(delivered.pageProjection!.clip, { x: 0, y: 0, width: 330, height: 470 });
        assert.deepStrictEqual(delivered.rasterProjection, { width: 541, height: 768, pageToRaster: [541, 0, 0, 768, 0, 0] });
        assert.strictEqual(delivered.displayRasterProjection, delivered.rasterProjection, 'the visible atlas supplies the current display grid');
        publish(); view.renderingState = 3;
        f.eventBus.emit('pagerendered', { pageNumber: 1, source: view, error: null, cssTransform: false });
        const refined = robots.refinements.at(-1)!;
        assert.strictEqual(refined.canvas, native);
        near(refined.rasterProjection!.pageToRaster[0], 399.1184, 'native source retains clipped horizontal coverage');
        near(refined.rasterProjection!.pageToRaster[3], 566.9288, 'native source retains clipped vertical coverage');
        assert.deepStrictEqual(refined.pageProjection, delivered.pageProjection, 'atlas-to-native refinement keeps the same photo targets');
    });

    it('keeps ready preview pixels while a captured native canvas has no display box and measures its attachment', async () => {
        const robots = new DocumentRobots();
        const h = previewFixture({ pages: 1, startPage: 1, width: 332.59866666666665, height: 472.4406666666667,
            initialNative: false, autoPages: false }, robots), f = h.f;
        const loader = h.bind(); await f.frame();
        const preview = h.publish(loader, 1, 541, 768).canvas;
        assert.strictEqual(preview.parentNode, f.pages[0].div);
        let displayed = false, measurements = 0;
        const { view, canvas, publish } = measuredNative(f, () => { measurements++; return displayed; });
        assert.strictEqual(preview.parentNode, view.div, 'native draw preparation cannot remove already useful preview pixels');
        const matrix = previewMatrix(preview);
        near(matrix[0] * 330, view.viewport.width, 'provisional horizontal logical extent');
        near(matrix[3] * 470, view.viewport.height, 'provisional vertical logical extent');
        assert.deepStrictEqual(f.controller.snapshot().visibleMissing, []);
        const beforeAttachment = measurements;
        displayed = true;
        f.eventBus.emit('updateviewarea'); await f.frame();
        assert.ok(measurements > beforeAttachment, 'the same native canvas is measured after attachment without a viewport or layout change');
        assert.strictEqual(preview.parentNode, view.div, 'the preview stays until the native draw finishes');
        const afterAttachment = measurements;
        f.eventBus.emit('updateviewarea'); await f.frame();
        assert.strictEqual(measurements, afterAttachment, 'real attached geometry can then be cached');
        publish(); view.renderingState = 3;
        f.eventBus.emit('pagerendered', { pageNumber: 1, source: view, error: null, cssTransform: false });
        assert.strictEqual(robots.refinements.at(-1)!.canvas, canvas);
        await f.frame();
        assert.strictEqual(preview.parentNode, null, 'finished native pixels replace the preview normally');
        assert.ok(preview.width > 0, 'native completion keeps the reusable preview raster');
    });

    it('preserves independent preview ceil padding without compressing its logical page', async () => {
        const robots = new DocumentRobots();
        const f = fixture({ pages: 1, startPage: 1, width: 333.3, height: 472.44, initialNative: false },
            { robotsEnabled: true, createDocumentRobots: () => robots });
        f.pages[0].div.clientWidth = 330; f.pages[0].div.clientHeight = 470;
        await f.frame();
        const render = f.pdf.activeRenders.find(value => value.id === 1)!;
        assert.ok(render);
        render.task.finish(); await promisesSettled();
        const delivered = robots.deliveries[0], preview = delivered.canvas;
        assert.deepStrictEqual([preview.width, preview.height], [334, 473]);
        assert.deepStrictEqual(delivered.rasterProjection, { width: 334, height: 473, pageToRaster: [333.3, 0, 0, 472.44, 0, 0] });
        const matrix = previewMatrix(preview);
        near(matrix[0] * 330 / 334, 1, 'ceil-padded preview horizontal scale');
        near(matrix[3] * 470 / 473, 1, 'ceil-padded preview vertical scale');
        assert.strictEqual(preview.parentNode, f.pages[0].div);
    });

    for (const angle of [90, 270]) {
        it('retains native clipping through CSS-only zoom, ' + angle + '-degree rotation and a copied preview', async () => {
            const robots = new DocumentRobots();
            robots.refine = value => { robots.refinements.push(value); return 0; };
            const f = fixture({ pages: 1, startPage: 1, width: 332.59866666666665, height: 472.4406666666667,
                initialNative: false, autoPages: false }, { robotsEnabled: true, createDocumentRobots: () => robots });
            const { view, canvas, publish } = measuredNative(f);
            let nativeMeasurements = 0;
            const rect = canvas.getBoundingClientRect;
            canvas.getBoundingClientRect = () => { nativeMeasurements++; return rect(); };
            await f.frame(); publish(); view.renderingState = 3;
            f.eventBus.emit('pagerendered', { pageNumber: 1, source: view, error: null, cssTransform: false });
            view.viewport = { width: 944.8813333333334, height: 665.1973333333333, scale: 1, rotation: angle };
            view.div.clientWidth = 940; view.div.clientHeight = 660;
            view.outputScale = { sx: 7, sy: 9 };
            canvas.style.transform = 'rotate(' + angle + 'deg)';
            f.viewer.pagesRotation = angle; f.eventBus.emit('rotationchanging');
            f.eventBus.emit('pagerendered', { pageNumber: 1, source: view, error: null, cssTransform: true });
            const projection = robots.refinements.at(-1)!.rasterProjection!;
            const expected = angle === 90 ? [0, -566.9288, 399.1184, 0, 0, 566.9288] : [0, 566.9288, -399.1184, 0, 399.1184, 0];
            projection.pageToRaster.forEach((value, index) => near(value, expected[index], 'retained affine component ' + index));
            const page = robots.refinements.at(-1)!.pageProjection!;
            near(page.content.width, view.viewport.width, 'retained zoom width');
            near(page.content.height, view.viewport.height, 'retained zoom height');
            near(page.content.x, angle === 90 ? 940 - page.content.width : 0, 'rotated leading horizontal clip');
            near(page.content.y, angle === 270 ? 660 - page.content.height : 0, 'rotated leading vertical clip');
            const measurements = nativeMeasurements;
            for (let index = 0; index < 3; index++) { f.eventBus.emit('updateviewarea'); await f.frame(); }
            assert.strictEqual(nativeMeasurements, measurements, 'unchanged scroll refreshes reuse local geometry');
            view.reset(); f.eventBus.emit('updateviewarea'); await f.frame();
            const preview = view.div.children.find(child => child.className === 'pdfPrefetchPreview') as Canvas;
            assert.ok(preview, 'the copied clipped raster remains available after native eviction');
            assert.deepStrictEqual([preview.width, preview.height], [396, 564], 'rotation does not allocate a second full-page backing');
            const matrix = previewMatrix(preview);
            near(matrix[0], 0, 'quarter-turn X basis'); near(matrix[3], 0, 'quarter-turn Y basis');
            assert.ok(matrix[1] !== 0 && matrix[2] !== 0, 'CSS preserves the retained raster orientation');
        });
    }

    it('waits for actual native draw provenance before copying an already-finished unknown backing', async () => {
        const robots = new DocumentRobots();
        const f = fixture({ pages: 1, startPage: 1, initialNative: false, autoPages: false },
            { robotsEnabled: true, createDocumentRobots: () => robots });
        const view = f.pages[0];
        view.canvas = new Canvas(); view.canvas.width = 800; view.canvas.height = 1000; view.renderingState = 3;
        await f.frame();
        assert.strictEqual(f.canvases.length, 0, 'unknown native coverage is not mislabeled as a complete page');
        assert.strictEqual(robots.deliveries.length, 0);
        f.finishNative(1);
        assert.strictEqual(robots.deliveries.length, 1, 'the real draw supplies usable source geometry');
        assert.ok(robots.deliveries[0].rasterProjection);
    });

    it('keeps a known cached preview without claiming it is displayed over an unknown finished native backing', async () => {
        const robots = new DocumentRobots();
        const h = previewFixture({ pages: 1, startPage: 1, initialNative: false, autoPages: false }, robots), f = h.f;
        const loader = h.bind(); await f.frame();
        const preview = h.publish(loader, 1).canvas;
        assert.strictEqual(robots.deliveries.length, 1);
        const before = robots.refinements.length, view = f.pages[0];
        view.canvas = new Canvas(); view.canvas.width = 800; view.canvas.height = 1000; view.renderingState = 3;
        for (const child of [...view.div.children]) { child.remove(); }
        view.div.prepend(view.canvas);
        f.eventBus.emit('pagerendered', { pageNumber: 1, source: view, error: null, cssTransform: true });
        await f.frame();
        assert.strictEqual(robots.refinements.length, before, 'a cached but detached preview cannot supply the unknown visible raster grid');
        assert.strictEqual(preview.parentNode, null);
        assert.ok(preview.width > 0 && preview.height > 0, 'the known preview remains cached for later use');
        f.finishNative(1);
        assert.strictEqual(robots.refinements.at(-1)!.canvas, view.canvas, 'an observed main draw resumes precise publication');
    });

    it('refinement reaches an existing handled delivery when a sharper sidecar or native canvas arrives', async () => {
        const robots = new DocumentRobots();
        const h = previewFixture({ startPage: 99, pages: 100, autoPages: false, initialNative: false }, robots), f = h.f;
        f.pages[98].reset();
        const loader = h.bind(); await f.frame();
        const coarse = h.publish(loader, 99, 135, 192);
        assert.strictEqual(coarse.accepted, true);
        assert.strictEqual(robots.deliveries.length, 1);
        assert.ok(robots.hasHandled(99));
        const sharp = h.publish(loader, 99, 541, 768);
        assert.strictEqual(sharp.accepted, true);
        assert.strictEqual(sharp.canvas.parentNode, f.pages[98].div, 'new useful PDF pixels attach immediately');
        assert.strictEqual(robots.refinements[robots.refinements.length - 1]?.canvas, sharp.canvas);
        assert.strictEqual(robots.deliveries.length, 1, 'a finer tier does not replay the page episode');
        f.finishNative(99);
        assert.strictEqual(robots.refinements[robots.refinements.length - 1]?.canvas, f.pages[98].canvas);
        assert.strictEqual(robots.deliveries.length, 1);
    });

    it('publishes visible prepared pixels before an unresolved worker trim releases the cold slot', async () => {
        const { f, robots } = robotFixture(true, { initialNative: false });
        f.pages[19].reset();
        const trim = new Deferred<Record<string, number>>();
        (f.pdf as any).getRangeCacheStats = async () => byteStats(1024);
        (f.pdf as any).trimRangeCache = () => trim.promise;
        await f.frame();
        const render = f.pdf.activeRenders.find(value => value.id === 20)!;
        assert.ok(render);
        render.task.finish(); await promisesSettled();
        const canvas = render.parameters.canvasContext.canvas;
        assert.strictEqual(canvas.parentNode, f.pages[19].div, 'visible coverage is published before the trim promise');
        assert.ok(f.controller.snapshot().pending.includes(20), 'the cold admission slot remains held while trimming');
        assert.strictEqual(trim.settled, false);
        assert.strictEqual(robots.deliveries[0]?.canvas, canvas, 'optional cargo uses the already attached useful pixels');
        trim.resolve(byteStats(1024)); await promisesSettled();
    });

    it('binds preview sources only to the exact document and fences replacement and stale publication', async () => {
        const h = previewFixture({ autoPages: false });
        const { f } = h;
        await f.frame();
        f.controller.setPreviewSource(h.source, {});
        assert.strictEqual(h.loaders.length, 0);
        const oldDocument = f.pdf, old = h.bind();
        h.bind(); assert.strictEqual(h.loaders.length, 1, 'the same source does not restart a loader');
        await f.frame();
        f.replaceDocument();
        assert.strictEqual(old.disposed, true);
        const late = h.publish(old, 21);
        assert.strictEqual(late.accepted, false); assert.strictEqual(late.canvas.width * late.canvas.height, 0);
        f.controller.setPreviewSource(h.source, oldDocument);
        assert.strictEqual(h.loaders.length, 1);
        const next = h.bind();
        assert.notStrictEqual(next, old);
        await f.frame();
        const before = f.callbacks.size;
        old.settings.onChange();
        assert.strictEqual(f.callbacks.size, before, 'the previous source cannot wake the replacement document');
        f.controller.setPreviewSource(undefined, f.pdf);
        assert.strictEqual(next.disposed, true);
        assert.strictEqual(f.controller.snapshot().previewSource, undefined);
    });

    it('passes a 512-pixel mobile source decode ceiling while preserving bounded desktop refinement', async () => {
        for (const mobile of [true, false]) {
            const h = previewFixture({ mobile, startPage: 1, pages: 1 });
            const loader = h.bind(); await h.f.frame();
            assert.strictEqual(loader.settings.decodeConcurrency, mobile ? 1 : 2);
            assert.strictEqual(loader.settings.maxDecodeDimension, mobile ? 512 : 1536);
            assert.strictEqual(loader.settings.maxDecodePixels, mobile ? 1_048_576 : 2_359_296);
            assert.ok(loader.updates[loader.updates.length - 1].requests.every((request: any) => request.maxDimension === (mobile ? 512 : 768)));
        }
    });

    it('uses explicit sidecar decode policy independently of its display name and worker image settings', async () => {
        const base = pdfCachePolicy({ userAgent: 'iPhone' });
        const custom = {
            ...base, name: 'desktop', imageDecodeConcurrency: 2,
            limits: { ...base.limits, previewMaxDimension: 640, maxPreviewBytes: 1024 * 1024 },
            sidecarDecode: { concurrency: 1, maxInputEdgeScale: 1.5 },
        };
        const h = previewFixture({ startPage: 1, pages: 1 }, undefined, { cachePolicy: custom });
        const loader = h.bind(); await h.f.frame();
        assert.strictEqual(loader.settings.decodeConcurrency, 1);
        assert.strictEqual(loader.settings.maxDecodeDimension, 960);
        assert.strictEqual(loader.settings.maxDecodePixels, 256 * 1024, 'decoded pixels also fit the selected raster byte budget');
        assert.ok(loader.updates.at(-1).requests.every((request: any) => request.maxDimension === 640));
    });

    it('preserves legacy custom sidecar policies while deriving their input edge from the selected preview size', async () => {
        for (const mobile of [true, false]) {
            const base = pdfCachePolicy({ userAgent: mobile ? 'iPhone' : 'desktop' });
            const custom = { ...base, sidecarDecode: undefined, imageDecodeConcurrency: 7,
                limits: { ...base.limits, previewMaxDimension: 400 } };
            const h = previewFixture({ startPage: 1, pages: 1 }, undefined, { cachePolicy: custom });
            const loader = h.bind(); await h.f.frame();
            assert.strictEqual(loader.settings.decodeConcurrency, mobile ? 1 : 2);
            assert.strictEqual(loader.settings.maxDecodeDimension, mobile ? 400 : 800);
            assert.strictEqual(loader.settings.maxDecodePixels, 640_000, 'the legacy area allowance remains independent of the edge ceiling');
        }
    });

    it('preserves a source attached before pagesinit for the exact incoming document', async () => {
        const h = previewFixture({ autoPages: false });
        const { f } = h;
        f.eventBus.emit('pagesdestroy');
        f.pdf = new PdfDocument(800, 1000, false); f.viewer.pdfDocument = f.pdf;
        h.bind();
        assert.strictEqual(h.loaders.length, 0, 'construction waits for document installation');
        f.eventBus.emit('pagesinit');
        assert.strictEqual(h.loaders.length, 1);
        await f.frame();
        assert.strictEqual(h.loaders[0].active, true);
        assert.ok(h.loaders[0].updates.at(-1).requests.some((request: any) => request.pageNumber === 20 && request.visible));
    });

    it('groups actual spread members independently from printed labels and preserves a single visible half', async () => {
        const robots = new DocumentRobots();
        const h = previewFixture({ startPage: 99, pages: 120, autoPages: false, initialNative: false }, robots);
        const { f } = h;
        const spread = new Element(); spread.className = 'spread'; f.container.prepend(spread);
        for (const id of [99, 100]) { spread.prepend(f.pages[id - 1].div); f.pages[id - 1].reset(); }
        (f.pages[98] as any).pageLabel = '88'; (f.pages[99] as any).pageLabel = '89';
        f.visibleIds = [99, 100];
        const loader = h.bind(); await f.frame();
        const initial = robots.workCalls.find(groups => groups.some(group => group.key === '99,100' && group.pages.every(page => page.state === 'waiting')));
        assert.ok(initial, 'the real physical spread arrives before preparation starts');
        const group = robots.workCalls[robots.workCalls.length - 1][0];
        assert.strictEqual(group.key, '99,100');
        assert.deepStrictEqual(group.pages.map(page => [page.pageNumber, page.label, page.state]), [[99, '88', 'preparing'], [100, '89', 'preparing']]);
        const ready = h.publish(loader, 99);
        assert.strictEqual(ready.accepted, true);
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [99], 'one ready half delivers without waiting for its partner');
        loader.settings.onChange(); await f.frame();
        assert.deepStrictEqual(robots.workCalls[robots.workCalls.length - 1][0].pages.map(page => page.state), ['ready', 'preparing']);
        f.visibleIds = [100]; f.container.emit('scroll'); await f.frame();
        const half = robots.workCalls[robots.workCalls.length - 1][0];
        assert.strictEqual(half.key, '99,100');
        assert.deepStrictEqual(half.pages.map(page => page.pageNumber), [100]);
        assert.deepStrictEqual(half.layoutPages, [{ pageNumber: 99, label: '88' }, { pageNumber: 100, label: '89' }],
            'clipping a spread half retains both labels in the layout domain');
    });

    it('uses retained sidecar pixels as real cargo and rotates its image placements with the viewer', async () => {
        const robots = new DocumentRobots();
        const h = previewFixture({ startPage: 21, autoPages: false, initialNative: false }, robots);
        const { f } = h;
        f.pages[20].reset(); f.viewer.pagesRotation = 90;
        const loader = h.bind(); await f.frame();
        const result = h.publish(loader, 21, 200, 160);
        assert.strictEqual(result.accepted, true);
        assert.strictEqual(result.canvas.parentNode, f.pages[20].div);
        const delivery = robots.deliveries[0];
        assert.strictEqual(delivery.canvas, result.canvas);
        assert.strictEqual(delivery.kind, 'preview');
        assert.deepStrictEqual(delivery.imageRegions, [{ id: 'photo-21', x: 0.5, y: 0.125, width: 0.25, height: 0.5 }]);
        assert.deepStrictEqual(f.controller.snapshot().visibleMissing, []);
        f.finishNative(21); await f.frame();
        assert.strictEqual(robots.deliveries.length, 1, 'native promotion does not replay a handled page');
        assert.strictEqual(loader.settings.quality(21), Infinity);
    });

    it('accepts a verified atlas after the first native task fails without an accepted display', async () => {
        const h = previewFixture({ startPage: 1, pages: 1, initialNative: false, autoPages: false }), f = h.f;
        const loader = h.bind(); await f.frame();
        const view = f.pages[0]; view.renderingState = 3; view.canvas = null;
        f.eventBus.emit('pagerendered', { pageNumber: 1, source: view, error: new Error('native first pass failed') });
        assert.notStrictEqual(loader.settings.quality(1), Infinity, 'failed FINISHED state cannot suppress atlas fallback');
        const atlas = h.publish(loader, 1);
        assert.strictEqual(atlas.accepted, true);
        assert.strictEqual(atlas.canvas.parentNode, view.div);
        assert.deepStrictEqual(f.controller.snapshot().visibleMissing, []);
        f.finishNative(1);
        view.renderingState = 1;
        assert.strictEqual(loader.settings.quality(1), Infinity, 'accepted complete native remains sufficient during another pass');
        assert.strictEqual(h.publish(loader, 1).accepted, false);
    });

    it('attaches sidecar image placements to an already finished native page without downloading a raster', async () => {
        const robots = new DocumentRobots();
        const h = previewFixture({ startPage: 21, autoPages: false }, robots);
        const loader = h.bind(); loader.metadata.set(21, h.metadata(21));
        await h.f.frame();
        assert.strictEqual(robots.deliveries[0].canvas, h.f.pages[20].canvas);
        assert.strictEqual(robots.deliveries[0].kind, 'page');
        assert.deepStrictEqual(robots.deliveries[0].imageRegions, h.metadata(21).imageRegions);
        assert.strictEqual(loader.settings.quality(21), Infinity);
    });

    it('cancels incompatible sidecars synchronously on layout, hidden state and layer changes', async () => {
        const h = previewFixture({ startPage: 21, autoPages: false, initialNative: false });
        const { f } = h;
        f.pages[20].reset();
        const loader = h.bind(); await f.frame();
        f.viewer.pagesRotation = 90; f.eventBus.emit('rotationchanging');
        assert.strictEqual(loader.active, false);
        assert.strictEqual(h.publish(loader, 21).accepted, false, 'a completion before the layout frame cannot publish the old orientation');
        await f.frame();
        assert.strictEqual(loader.active, true);
        assert.strictEqual(loader.updates.at(-1).requests.find((request: any) => request.pageNumber === 21).rotation, 90);
        f.owner.visibilityState = 'hidden'; f.owner.emit('visibilitychange');
        assert.strictEqual(loader.active, false);
        const hidden = h.publish(loader, 21);
        assert.strictEqual(hidden.accepted, false); assert.strictEqual(hidden.canvas.width, 0);
        f.owner.visibilityState = 'visible'; f.owner.emit('visibilitychange'); await f.frame();
        f.eventBus.emit('optionalcontentconfigchanged'); await f.frame();
        assert.strictEqual(loader.active, false);
        assert.strictEqual(h.publish(loader, 21).accepted, false, 'default-layer sidecars stay disabled after user layer changes');
    });

    it('ignores mismatched placement geometry while preserving a finished native page delivery', async () => {
        const robots = new DocumentRobots();
        const h = previewFixture({ startPage: 21, autoPages: false }, robots);
        const loader = h.bind(); loader.metadata.set(21, { ...h.metadata(21), width: 1600 });
        await h.f.frame();
        assert.strictEqual(robots.deliveries[0].canvas, h.f.pages[20].canvas);
        assert.strictEqual(robots.deliveries[0].imageRegions, undefined);
    });

    it('honors the extension theme global and restores sidecars only after plain colors return', async () => {
        const h = previewFixture({ startPage: 21, autoPages: false, initialNative: false });
        const { f } = h;
        f.pages[20].reset();
        const loader = h.bind(); await f.frame();
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'pdfjsViewerColorTheme');
        try {
            Object.defineProperty(globalThis, 'pdfjsViewerColorTheme', { configurable: true, writable: true,
                value: { fontColor: '#ffffff', bgColor: '#222222' } });
            f.eventBus.emit('prefetchthemechanged'); await f.frame();
            assert.strictEqual(loader.active, false);
            assert.strictEqual(h.publish(loader, 21).accepted, false);
            (globalThis as any).pdfjsViewerColorTheme = null;
            f.eventBus.emit('prefetchthemechanged'); await f.frame();
            assert.strictEqual(loader.active, true);
        } finally {
            if (previous) { Object.defineProperty(globalThis, 'pdfjsViewerColorTheme', previous); }
            else { delete (globalThis as any).pdfjsViewerColorTheme; }
        }
    });

    it('rejects sidecar pixels whose page geometry disagrees with the installed PDF page', async () => {
        const h = previewFixture({ startPage: 21, autoPages: false, initialNative: false });
        const { f } = h;
        f.pages[20].reset();
        const loader = h.bind(); await f.frame();
        loader.metadata.set(21, { ...h.metadata(21), width: 1600 });
        const result = h.publish(loader, 21);
        assert.strictEqual(result.accepted, false);
        assert.strictEqual(result.canvas.width * result.canvas.height, 0);
        assert.ok(f.controller.snapshot().visibleMissing.includes(21));
    });

    it('keeps sidecar requests in the idle decision and removes source callbacks on disposal', async () => {
        const h = previewFixture({ pages: 1, startPage: 1, autoPages: false });
        const loader = h.bind();
        loader.pending.add(1); await h.f.frame();
        assert.strictEqual(h.f.controller.snapshot().idle, false);
        loader.pending.clear(); loader.settings.onChange(); await h.f.frame();
        assert.strictEqual(h.f.controller.snapshot().idle, true);
        assert.strictEqual(h.f.callbacks.size, 0);
        for (let i = 0; i < 5; i++) { await h.f.frame(); }
        assert.strictEqual(h.f.pdf.requests.length, 0, 'finished native pixels and settled sidecars never rewarm at idle');
        loader.state = 'loading'; loader.settings.onChange();
        assert.strictEqual(h.f.controller.snapshot().idle, false, 'new manifest work revokes idle before the next animation frame');
        h.f.controller.setPreviewSource(undefined, h.f.pdf); await h.f.frame();
        assert.strictEqual(h.f.controller.snapshot().idle, true, 'withdrawing the optional source restores idle without another reader event');
        h.f.dispose(); assert.strictEqual(loader.disposed, true);
        loader.settings.onChange();
        assert.strictEqual(h.f.callbacks.size, 0);
    });


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
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20, 21], 'each first visible page starts one delivery');
        const delivery = robots.deliveries[1];
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
        assert.strictEqual(robots.deliveries.length, 2, 'native replacement of a delivered preview does not replay the episode');
    });

    it('offers ready pages on first visible entry and keeps offscreen prefetch completions quiet', async () => {
        const { f, robots, factories } = robotFixture();
        await f.frame();
        assert.deepStrictEqual(factories, [f.container]);
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20], 'the initially finished page gets a delivery');
        assert.strictEqual(robots.deliveries[0].canvas, f.pages[19].canvas, 'ready native pixels are offered directly');
        const render = f.pdf.activeRenders.find(candidate => candidate.id === 21)!;
        render.task.finish();
        await promisesSettled();
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20], 'offscreen preparation does not create an animation');
        f.scrollBy(1000);
        await f.frame();
        assert.strictEqual(render.parameters.canvasContext.canvas.parentNode, f.pages[20].div);
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20, 21], 'the warmed page gets its first episode on entry');
        assert.strictEqual(robots.deliveries[1].canvas, render.parameters.canvasContext.canvas);
        f.finishNative(21);
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20, 21], 'the native replacement does not replay the episode');
    });

    it('delivers a newly finished visible native page to document robots when no preview covered it', async () => {
        const { f, robots } = robotFixture();
        await f.frame();
        f.scrollBy(1000);
        await f.frame();
        assert.ok(f.controller.snapshot().visibleMissing.includes(21));
        f.finishNative(21);
        await f.frame();
        assert.strictEqual(robots.deliveries.length, 2);
        assert.strictEqual(robots.deliveries[1].kind, 'page');
        assert.strictEqual(robots.deliveries[1].pageElement, f.pages[20].div);
        assert.strictEqual(robots.deliveries[1].canvas, f.pages[20].canvas, 'native cargo uses the completed page canvas');
        const render = f.pdf.activeRenders.find(candidate => candidate.id === 21)!;
        render.task.finish();
        await promisesSettled();
        await f.frame();
        assert.strictEqual(robots.deliveries.length, 2, 'a later auxiliary completion cannot replay native delivery');
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
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20, 21], 'the replacement document gets its own first visible episode');
        assert.ok(robots.deliveries.every(delivery => delivery.pageElement !== oldElement), 'the old document completion must never reach the robot module');
        assert.strictEqual(stale.parameters.canvasContext.canvas.width, 0);
        const fresh = f.pdf.activeRenders.find(candidate => candidate.id === 22)!;
        assert.ok(fresh);
        f.scrollBy(1000);
        await f.frame();
        fresh.task.finish();
        await promisesSettled();
        await f.frame();
        assert.strictEqual(robots.deliveries.length, 3);
        assert.strictEqual(robots.deliveries[2].pageNumber, 22);
        assert.strictEqual(robots.deliveries[2].pageElement, f.pages[21].div);
        assert.notStrictEqual(robots.deliveries[2].pageElement, oldElement);
    });

    it('waits for courier capacity once and drains ready visible pages without idle polling', async () => {
        const { f, robots } = robotFixture(true, { initialNative: false });
        robots.maxActive = 1;
        f.visibleIds = [20, 21, 22];
        f.pages[19].reset();
        await f.frame();
        for (const id of f.visibleIds) { f.finishNative(id); }
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20]);
        assert.deepStrictEqual(robots.offers, [20, 21], 'the first busy result stops further allocation attempts');
        for (let index = 0; index < 5; index++) { f.eventBus.emit('updateviewarea'); await f.frame(); }
        assert.deepStrictEqual(robots.offers, [20, 21], 'ordinary refreshes do not retry a saturated fleet');
        assert.strictEqual(f.callbacks.size, 0, 'waiting for a courier does not keep animation frames running');
        assert.ok(f.pdf.activeRenders.length > 0, 'the fixture still has independent PDF preparation work');
        assert.strictEqual([...timers.values()].filter(timer => timer.delay !== 1000).length, 0, 'courier capacity does not create a polling timer');
        robots.complete(20);
        assert.strictEqual(f.callbacks.size, 1, 'completion requests one coalesced refresh');
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20, 21]);
        assert.strictEqual(robots.deliveries[1].canvas, f.pages[20].canvas, 'a deferred offer reads the current native canvas');
        robots.complete(21);
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20, 21, 22]);
        robots.complete(22);
        assert.strictEqual(f.callbacks.size, 0, 'the final courier does not wake an empty waiting list');
    });

    it('drops offscreen pending deliveries and resumes only the currently visible queue on cancellation', async () => {
        const { f, robots } = robotFixture();
        robots.maxActive = 1;
        f.visibleIds = [20, 21, 22];
        for (const id of f.visibleIds) { f.cachePage(id); }
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20]);
        assert.deepStrictEqual(robots.offers, [20, 21]);
        f.visibleIds = [22, 23];
        f.cachePage(23);
        f.eventBus.emit('updateviewarea');
        await f.frame();
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20, 22], 'cancelling an offscreen courier releases capacity for a visible page');
        assert.ok(!robots.hasHandled(21), 'the offscreen waiting page keeps its future first-entry opportunity');
        robots.complete(22);
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20, 22, 23]);
        assert.ok(!robots.deliveries.some(delivery => delivery.pageNumber === 21));
        f.visibleIds = [21];
        f.eventBus.emit('updateviewarea');
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20, 22, 23, 21], 'the unhandled page can run when it is visible again');
    });

    it('defers a visible sliver without spending its episode and retries after real geometry changes', async () => {
        const { f, robots } = robotFixture();
        robots.deferred.add(20);
        await f.frame();
        assert.deepStrictEqual(robots.offers, [20]);
        assert.strictEqual(robots.hasHandled(20), false);
        assert.strictEqual(robots.deliveries.length, 0);
        for (let index = 0; index < 4; index++) { f.eventBus.emit('updateviewarea'); await f.frame(); }
        assert.deepStrictEqual(robots.offers, [20], 'an unchanged sliver does not repeatedly sample or allocate');
        robots.deferred.delete(20);
        f.visibleIds = [20];
        f.container.scrollTop += 10;
        f.container.emit('scroll');
        await f.frame();
        assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20], 'a larger intersection gets the original first-entry episode');
        assert.strictEqual(robots.hasHandled(20), true);
    });

    it('supplies the current motion and scroll axis for document entry admission', async () => {
        for (const mode of ['vertical', 'horizontal', 'horizontal-rtl'] as const) {
            const robots = new DocumentRobots();
            const h = previewFixture({ pages: 1, startPage: 1, initialNative: false, autoPages: false }, robots);
            const { f } = h, horizontal = mode !== 'vertical';
            f.viewer.scrollMode = horizontal ? 1 : 0;
            f.viewer._isContainerRtl = mode === 'horizontal-rtl';
            const loader = h.bind();
            await f.frame();
            f.container.emit('wheel', { deltaY: horizontal ? 0 : 40, deltaX: horizontal ? 40 : 0, deltaMode: 0 });
            assert.strictEqual(h.publish(loader, 1).accepted, true);
            assert.deepStrictEqual(robots.admissions, [{ pageNumber: 1, admission: { moving: true, axis: horizontal ? 'x' : 'y' } }], mode);
            f.dispose();
        }
    });

    it('retries deferred document entry admission once when unchanged geometry settles', async () => {
        const { f, robots } = robotFixture(true, { pages: 1, startPage: 1, initialNative: false, autoPages: false });
        robots.deferred.add(1);
        await f.frame();
        f.container.emit('wheel', { deltaY: 120, deltaMode: 0 });
        f.finishNative(1);
        await f.frame();
        assert.deepStrictEqual(robots.offers, [1]);
        assert.strictEqual(robots.hasHandled(1), false);
        for (let index = 0; index < 3; index++) { f.eventBus.emit('updateviewarea'); await f.frame(); }
        assert.deepStrictEqual(robots.offers, [1], 'unchanged moving geometry does not repeat admission work');
        const geometry = [f.container.scrollTop, f.container.scrollLeft, f.container.clientWidth, f.container.clientHeight];
        robots.deferred.delete(1);
        endGesture(f);
        assert.strictEqual(f.callbacks.size, 1, 'the existing settle event requests one refresh');
        await f.frame(0);
        assert.deepStrictEqual(robots.deliveries.map(value => value.pageNumber), [1], 'a settled partial view receives its first episode');
        assert.deepStrictEqual(robots.admissions[robots.admissions.length - 1].admission, { moving: false, axis: 'y' });
        assert.deepStrictEqual([f.container.scrollTop, f.container.scrollLeft, f.container.clientWidth, f.container.clientHeight], geometry);
        assert.strictEqual(f.callbacks.size, 0, 'settled admission does not own an idle frame');
        f.eventBus.emit('updateviewarea'); await f.frame();
        assert.deepStrictEqual(robots.offers, [1, 1], 'the accepted page is not admitted again');
    });

    it('recognizes pending scroll position before the listener for document entry admission', async () => {
        for (const horizontal of [false, true]) {
            const robots = new DocumentRobots();
            const h = previewFixture({ pages: 1, startPage: 1, initialNative: false, autoPages: false }, robots);
            const { f } = h;
            f.viewer.scrollMode = horizontal ? 1 : 0;
            const loader = h.bind();
            await f.frame();
            if (horizontal) { f.container.scrollLeft += 120; }
            else { f.container.scrollTop += 120; }
            f.eventBus.emit('updateviewarea');
            await f.frame();
            assert.strictEqual(f.controller.snapshot().direction, 0, 'the scroll listener has not sampled this movement yet');
            assert.strictEqual(h.publish(loader, 1).accepted, true);
            assert.deepStrictEqual(robots.admissions, [{ pageNumber: 1, admission: { moving: true, axis: horizontal ? 'x' : 'y' } }]);
            f.container.emit('scroll');
            assert.strictEqual(f.controller.snapshot().direction, 1, 'admission preserves the listener baseline');
            f.dispose();
        }
    });

    it('excludes layout compensation from document entry admission motion before its refresh', async () => {
        const { f, robots } = robotFixture(true, { pages: 1, startPage: 1, initialNative: false, autoPages: false });
        await f.frame();
        f.container.emit('wheel', { deltaY: 120, deltaMode: 0 });
        f.eventBus.emit('scalechanging');
        f.container.scrollTop += 120;
        f.finishNative(1);
        assert.deepStrictEqual(robots.admissions, [{ pageNumber: 1, admission: { moving: false, axis: 'y' } }],
            'pixels ready during the pending layout use the new stationary view');
        assert.strictEqual(f.controller.snapshot().direction, 0);
        await f.frame();
        assert.deepStrictEqual(robots.offers, [1]);
    });

    for (const event of ['scroll', 'resize'] as const) {
        it('retries deferred document pixels after a visual-viewport-only ' + event, async () => {
            const { f, robots } = robotFixture();
            robots.deferred.add(20);
            await f.frame();
            assert.deepStrictEqual(robots.offers, [20]);
            await f.frame(); // Deliver the one active-render observation frame before measuring viewport wakeups.
            assert.strictEqual(f.callbacks.size, 0);
            const containerGeometry = [f.container.scrollLeft, f.container.scrollTop, f.container.clientWidth, f.container.clientHeight];
            robots.deferred.delete(20);
            if (event === 'scroll') { f.visualViewport.offsetTop += 30; }
            else { f.visualViewport.width -= 40; }
            f.visualViewport.emit(event);
            f.visualViewport.emit(event);
            assert.strictEqual(f.callbacks.size, 1, 'visual viewport changes request one coalesced refresh');
            await f.frame();
            assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20], 'changed visual clipping reconsiders the deferred page');
            assert.deepStrictEqual([f.container.scrollLeft, f.container.scrollTop, f.container.clientWidth, f.container.clientHeight], containerGeometry);
            assert.strictEqual(f.callbacks.size, 0, 'viewport handling leaves an idle reader asleep');
            f.dispose();
            assert.strictEqual(f.visualViewport.listenerCount, 0, 'both visual viewport listeners are removed on disposal');
            f.visualViewport.emit(event);
            assert.strictEqual(f.callbacks.size, 0);
        });
    }

    it('uses robot-owned page history across refresh, zoom, hide and toggles', async () => {
        const { f, robots } = robotFixture();
        await f.frame();
        assert.deepStrictEqual(robots.offers, [20]);
        for (let index = 0; index < 3; index++) { f.eventBus.emit('updateviewarea'); await f.frame(); }
        f.eventBus.emit('scalechanging');
        await f.frame();
        f.owner.visibilityState = 'hidden';
        f.owner.emit('visibilitychange');
        f.owner.visibilityState = 'visible';
        f.owner.emit('visibilitychange');
        await f.frame();
        f.controller.setRobotsEnabled(false);
        f.controller.setRobotsEnabled(true);
        await f.frame();
        assert.deepStrictEqual(robots.offers, [20], 'handled IDs are rejected before another robot offer');
        assert.strictEqual(robots.deliveries.length, 1);
        f.replaceDocument();
        await f.frame();
        assert.deepStrictEqual(robots.offers, [20, 20], 'only a new document clears the authoritative history');
        assert.strictEqual(robots.deliveries.length, 2);
    });

    for (const lifecycle of ['hide', 'disable', 'dispose'] as const) {
        it('ignores an obsolete courier-capacity callback after ' + lifecycle, async () => {
            const { f, robots } = robotFixture();
            robots.maxActive = 1;
            f.visibleIds = [20, 21];
            f.cachePage(21);
            await f.frame();
            assert.deepStrictEqual(robots.offers, [20, 21]);
            const callback = robots.onCapacityAvailable;
            assert.ok(callback);
            if (lifecycle === 'hide') { f.owner.visibilityState = 'hidden'; f.owner.emit('visibilitychange'); }
            else if (lifecycle === 'disable') { f.controller.setRobotsEnabled(false); }
            else { f.dispose(); }
            await promisesSettled();
            await f.frame();
            callback();
            assert.strictEqual(f.callbacks.size, 0, 'a late capacity notification cannot restart hidden, disabled or disposed work');
            assert.deepStrictEqual(robots.deliveries.map(delivery => delivery.pageNumber), [20]);
        });
    }

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
        const f = fixture({ initialNative: false });
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
        assert.strictEqual(f.pdf.renders.filter(render => render.id === farId).length, 1, 'covered motion keeps its decoded resources released');
        endGesture(f);
        for (const render of [...f.pdf.activeRenders]) { render.task.finish(); }
        await promisesSettled(); await f.frame();
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

    for (const [mobile, nativeFirst] of [[false, true], [false, false], [true, true], [true, false]]) {
        it('releases finished ' + (mobile ? 'mobile' : 'desktop') + ' native resolution tiers after ' + (nativeFirst ? 'its auxiliary render finishes' : 'native rendering follows auxiliary completion'), async () => {
            const f = fixture({ mobile });
            await f.frame();
            const preparation = f.pdf.activeRenders.find(render => render.id === 21)!;
            const view = f.pages[20];
            view.pdfPage = preparation.page;
            view.renderingState = 1;
            preparation.page._intentStates.set('display-low-density', {});
            preparation.page._intentStates.set('display-high-density', {});
            preparation.page.objs.set('photo', { width: 100, height: 100, data: new Uint8Array(40_000) });
            preparation.page.objs.set('photo-low-density', { width: 50, height: 50, data: new Uint8Array(10_000) });
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
            assert.strictEqual(preparation.page._intentStates.size, 0, 'finished pixels release every retained display-density tier');
            assert.strictEqual(preparation.page.objs.size, 0);
            await f.frame();
            assert.strictEqual(view.canvas, canvas);
            assert.strictEqual(f.pdf.renders.filter(render => render.id === view.id).length, 1, 'the completed canvas stays ready without another decode');

            f.scrollBy(1000);
            view.renderingState = 0;
            f.eventBus.emit('scalechanging');
            await promisesSettled();
            await f.frame();
            assert.ok(canvas?.isConnected && view.div.contains(canvas), 'the accepted native keeps raster coverage while resources return');
            view.reset(); f.eventBus.emit('updateviewarea'); await f.frame();
            assert.ok(view.div.children.some(child => child.className === 'pdfPrefetchPreview'), 'actual native reset reattaches the cached preview');
            assert.strictEqual(f.pdf.renders.filter(render => render.id === view.id).length, 2, 'a later native redraw prepares fresh resources');
        });
    }

    for (const mobile of [false, true]) {
        it('defers finished ' + (mobile ? 'mobile' : 'desktop') + ' page cleanup while another PDF.js render still uses its resources', async () => {
            const f = fixture({ mobile, startPage: 1, pages: 1 });
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
    }

    for (const mobile of [false, true]) {
        it('prepares ' + (mobile ? 'mobile' : 'desktop') + ' images for native pixel density and invalidates warm admission on larger zoom', async () => {
            const f = fixture({ mobile });
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
            const transfers = Array.from({ length: f.controller.snapshot().cacheLimits.maxPendingFetches }, () => fetches.begin());
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
    }

    it('releases desktop raster-only resolution tiers without idle rewarming beyond the native window', async () => {
        const f = fixture();
        f.container.clientHeight = 2000;
        await f.frame();
        const state = f.controller.snapshot();
        const farId = state.prepared.find((id: number) => !state.visible.includes(id) && !state.renderAhead.includes(id));
        assert.ok(farId, 'the preparation plan extends beyond the finite native window');
        for (let step = 0; step < 8; step++) {
            for (const render of [...f.pdf.activeRenders]) {
                render.page._intentStates.set('display-previous-density', {});
                render.page.objs.set('old-photo', { width: 80, height: 60, data: new Uint8Array(19_200) });
                render.task.finish();
            }
            await promisesSettled();
            await f.frame();
        }
        const first = f.pdf.renders.find(render => render.id === farId)!;
        assert.ok(first);
        const raster: Canvas = first.parameters.canvasContext.canvas;
        assert.ok(raster.width > 0, 'the completed preview is retained');
        assert.strictEqual(first.page._intentStates.size, 0, 'a raster-only prepared page releases all decoded tiers');
        assert.strictEqual(first.page.objs.size, 0);
        assert.strictEqual(f.pdf.renders.filter(render => render.id === farId).length, 1);
        const renders = f.pdf.renders.length;
        for (let step = 0; step < 4; step++) { f.eventBus.emit('updateviewarea'); await f.frame(30_000); }
        assert.strictEqual(f.pdf.renders.length, renders, 'retained previews do not restart work after resource cleanup');
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(timers.size, 0);
        f.scrollBy((farId - 20) * 1000);
        await f.frame();
        assert.strictEqual(raster.parentNode, f.pages[farId - 1].div, 'the existing pixels cover native resource preparation');
        assert.strictEqual(f.pdf.renders.filter(render => render.id === farId).length, 2);
    });

    it('preserves desktop offscreen canvases while releasing their decoded resolution tiers', async () => {
        const f = fixture();
        await f.frame();
        const page = f.pdf.page(17);
        page._intentStates.set('display-old-density', {});
        page.objs.set('photo', { width: 80, height: 60, data: new Uint8Array(19_200) });
        f.finishNative(17);
        const canvas = f.pages[16].canvas;
        await f.frame();
        assert.ok(canvas && canvas.width > 0);
        assert.strictEqual(f.pages[16].canvas, canvas, 'desktop canvas retention remains independent of decoded cleanup');
        assert.strictEqual(f.pages[16].destroyCalls, 0);
        assert.strictEqual(page._intentStates.size, 0);
        assert.strictEqual(page.objs.size, 0);
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
        assert.deepStrictEqual([...timers.values()].map(timer => timer.delay).sort((a, b) => a - b), [250, 1000]);
        f.pages[0].reset();
        fireMemoryTimer();
        await promisesSettled();
        assert.strictEqual([...timers.values()].filter(timer => timer.delay === 250).length, 0, 'canceled native work stops byte polling immediately');
        const probe = [...timers].find(([, timer]) => timer.delay === 1000)!;
        f.time += 1000; timers.delete(probe[0]); probe[1].callback();
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
        assert.ok(visible.canvas?.isConnected);
        visible.reset(); f.eventBus.emit('updateviewarea');
        await f.frame();
        assert.ok(visible.div.children.some(canvas => canvas.className === 'pdfPrefetchPreview'), 'visible preview survives LRU eviction');
    });

    for (const [width, height] of [[800, 1000], [1000, 800]]) {
        it(`reuses a full-quality sidecar across native rounding and zoom for ${width}x${height} geometry`, async () => {
            const h = previewFixture({ width, height, startPage: 99, pages: 100, autoPages: false, initialNative: false }), f = h.f;
            f.pages[98].reset();
            const loader = h.bind(); await f.frame();
            const scale = 768 / Math.max(width, height);
            const sidecar = h.publish(loader, 99, Math.round(width * scale), Math.round(height * scale));
            assert.strictEqual(sidecar.accepted, true, 'the exact document/page geometry admits the sidecar');
            const allocations = f.canvases.length;
            f.finishNative(99);
            assert.strictEqual(f.canvases.length, allocations, 'native completion must not copy for rounding alone');
            assert.ok(sidecar.canvas.width > 0, 'the retained full-quality preview keeps its bitmap');
            const native = f.pages[98].canvas!;
            native.width = width * 3; native.height = height * 3;
            f.eventBus.emit('pagerendered', { pageNumber: 99, error: null, cssTransform: false });
            for (let step = 0; step < 3; step++) {
                f.eventBus.emit('updateviewarea');
                await f.frame();
            }
            assert.strictEqual(f.canvases.length, allocations, 'a larger native canvas and refreshes reuse the same preview tier');
            assert.ok(sidecar.canvas.width > 0);
        });
    }

    it('still upgrades a sidecar below the requested longest-edge quality', async () => {
        const h = previewFixture({ startPage: 99, pages: 100, autoPages: false, initialNative: false }), f = h.f;
        f.pages[98].reset();
        const loader = h.bind(); await f.frame();
        const sidecar = h.publish(loader, 99, 614, 767);
        assert.strictEqual(sidecar.accepted, true);
        const allocations = f.canvases.length;
        f.finishNative(99);
        assert.strictEqual(f.canvases.length, allocations + 1, 'axis tolerance must not lower the requested quality tier');
        assert.strictEqual(Math.max(f.canvases.at(-1)!.width, f.canvases.at(-1)!.height), 768);
        assert.strictEqual(f.canvases.at(-1)!.copies, 1);
        assert.strictEqual(sidecar.canvas.width, 0, 'the lower-quality bitmap is released after replacement');
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
        assert.ok(view.canvas?.isConnected && view.div.contains(view.canvas), 'accepted native displays while copied preview stays cached');
        const replacement = f.canvases.find(canvas => canvas.source === view.canvas)!;
        assert.ok(replacement && replacement !== trail);
        assert.strictEqual(replacement.parentNode, null);
        view.reset(); f.eventBus.emit('updateviewarea'); await f.frame();
        assert.strictEqual(replacement.parentNode, view.div, 'native eviction reattaches the upgraded cache without decoding');
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
            assert.strictEqual(trail.parentNode, null, 'successful native publication replaces the preview even if its cache copy fails');
            assert.ok(view.canvas?.isConnected && view.div.contains(view.canvas));
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
        const existingTimers = new Set(timers.keys());
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
        const gestureTimers = [...timers].filter(([id]) => !existingTimers.has(id));
        assert.strictEqual(gestureTimers.length, 1, 'scrollend replaces the existing gesture timer');
        const [timerId, timer] = gestureTimers[0];
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

    it('uses the selected gesture gap for both motion continuity and idle settlement', async () => {
        const base = pdfCachePolicy({ userAgent: 'desktop' });
        const f = fixture({}, { cachePolicy: { ...base, limits: { ...base.limits, gestureGapMs: 1000 } } });
        await f.frame();
        const idleLead = f.controller.snapshot().preloadPx;
        const existingTimers = new Set(timers.keys());
        f.container.emit('wheel', { deltaY: 320, deltaMode: 0 });
        f.time += 16;
        f.container.emit('wheel', { deltaY: 640, deltaMode: 0 });
        const moving = f.controller.snapshot();
        f.time += 300;
        f.container.emit('wheel', { deltaY: 16, deltaMode: 0 });
        const continuing = f.controller.snapshot();
        assert.ok(continuing.velocityPxPerMs > moving.velocityPxPerMs / 2, '300ms remains inside the selected gesture');
        assert.ok(continuing.accelerationPxPerMs2 > 0);
        f.container.emit('scrollend');
        const gestureTimers = [...timers].filter(([id]) => !existingTimers.has(id));
        assert.strictEqual(gestureTimers.length, 1);
        const [id, timer] = gestureTimers[0];
        assert.strictEqual(timer.delay, 1000);
        await f.frame(999);
        assert.strictEqual(f.controller.snapshot().velocityPxPerMs, continuing.velocityPxPerMs);
        f.time += 1;
        timers.delete(id);
        timer.callback();
        await f.frame(0);
        const settled = f.controller.snapshot();
        assert.strictEqual(settled.velocityPxPerMs, 0);
        assert.strictEqual(settled.accelerationPxPerMs2, 0);
        assert.strictEqual(settled.preloadPx, idleLead);
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

    it('allows active desktop native work under fetch pressure but readmits a cleaned redraw as cold', async () => {
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
        assert.strictEqual(f.choose(), null, 'a completed canvas releases its decoded resources before a later redraw');
        assert.strictEqual(f.queue.renderView(visible), false);
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
        oldView.renderingState = 1;
        assert.strictEqual(f.queue.renderView(oldView), false);
        assert.strictEqual(f.nativeRenders.length, 0, 'a resolved native getPage must not revive obsolete render work');
        const current = f.pages[f.visible().first.id - 1];
        current.renderingState = 1;
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
        old.renderingState = 1;
        assert.strictEqual(f.queue.renderView(old), false);
        assert.strictEqual(f.nativeRenders.length, 0, 'the old view has the same page number but belongs to the old document');
        const current = f.pages[19];
        current.renderingState = 1;
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

    it('restores authorized robot covers synchronously before the reset page preview reappears', async () => {
        const robots = new DocumentRobots();
        const h = previewFixture({ startPage: 99, pages: 100, autoPages: false, initialNative: false }, robots), f = h.f;
        const view = f.pages[98]; view.reset();
        const loader = h.bind(); await f.frame();
        const preview = h.publish(loader, 99);
        assert.strictEqual(preview.canvas.parentNode, view.div);
        view.setPdfPage(f.pdf.page(99)); view.renderingState = 1;
        assert.strictEqual(preview.canvas.parentNode, null);
        const workCalls = robots.workCalls.length;
        const record = robots.restoreArrivals.bind(robots);
        robots.restoreArrivals = (pageNumber, pageElement) => {
            assert.strictEqual(preview.canvas.parentNode, null, 'restore the cover before attaching visible pixels');
            assert.strictEqual(robots.workCalls.length, workCalls, 'restore before work refresh can retire a detached cover');
            record(pageNumber, pageElement);
        };
        f.eventBus.emit('pagerender', { pageNumber: 99 });
        assert.deepStrictEqual(robots.restoredArrivals, [{ pageNumber: 99, pageElement: view.div }]);
        assert.strictEqual(preview.canvas.parentNode, view.div);
        f.eventBus.emit('pagerender', { pageNumber: 99, isDetailView: true });
        f.viewer.pdfDocument = {};
        f.eventBus.emit('pagerender', { pageNumber: 99 });
        assert.strictEqual(robots.restoredArrivals.length, 1, 'detail and stale-document events cannot restore a cover');
        f.viewer.pdfDocument = f.pdf;
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
        assert.ok(f.pages[0].canvas?.isConnected);
        f.pages[0].reset();
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
    function visibilityFixture(options: { storage?: Map<string, string>; preference?: any; initial?: boolean; failRenderer?: boolean; storageFails?: boolean } = {}) {
        const f = new Fixture({ pages: 1, startPage: 1 }); fixtures.push(f);
        const storage = options.storage ?? new Map<string, string>(), writes: Array<[string, string]> = [];
        Object.defineProperty(f.owner.defaultView, 'localStorage', { get() {
            if (options.storageFails) { throw new Error('storage denied'); }
            return { getItem: (key: string) => storage.get(key) ?? null,
                setItem(key: string, value: string) { writes.push([key, value]); storage.set(key, value); } };
        } });
        const robots = new DocumentRobots(), factories: Element[] = [];
        f.install(module, { robotsEnabled: options.initial, robotsPreference: options.preference,
            createDocumentRobots: (container: Element) => {
                factories.push(container); if (options.failRenderer) { throw new Error('renderer unavailable'); } return robots;
            } });
        return { f, robots, factories, storage, writes };
    }

    it('persists document visibility OFF and ON through standalone controller recreation without opening the Lab', () => {
        const first = visibilityFixture(); assert.strictEqual(first.f.controller.robotsEnabled, true);
        assert.deepStrictEqual(first.writes, [], 'default initialization is not a preference write');
        first.f.controller.setRobotsEnabled(false); first.f.dispose();
        const second = visibilityFixture({ storage: first.storage });
        assert.strictEqual(second.factories.length, 0, 'saved OFF prevents robot construction on reload');
        assert.strictEqual(second.f.controller.robotsEnabled, false);
        second.f.controller.setRobotsEnabled(true); second.f.dispose();
        const third = visibilityFixture({ storage: first.storage });
        assert.strictEqual(third.f.controller.robotsEnabled, true);
        assert.strictEqual(third.f.controller.diagnosticsEnabled, false);
        assert.deepStrictEqual(third.writes, [], 'restoring ON does not rewrite it');
    });

    it('waits for visibility preference readiness before construction and fences newer toggles and disposal', async () => {
        for (const action of ['restore', 'off', 'on', 'dispose'] as const) {
            let finish!: () => void, stored = action === 'off'; const writes: boolean[] = [];
            const ready = new Promise<void>(resolve => { finish = resolve; });
            const fixture = visibilityFixture({ preference: { whenReady: () => ready, read: () => stored,
                write(value: boolean) { writes.push(value); stored = value; } } });
            assert.strictEqual(fixture.factories.length, 0, 'no startup before saved OFF is known');
            if (action === 'off') { fixture.f.controller.setRobotsEnabled(false); }
            if (action === 'on') { fixture.f.controller.setRobotsEnabled(true); }
            if (action === 'dispose') { fixture.f.dispose(); }
            assert.deepStrictEqual(writes, [], 'pending host writes wait for state merge');
            finish(); await ready; await promisesSettled();
            assert.strictEqual(fixture.factories.length, action === 'on' ? 1 : 0, 'late readiness cannot override a newer action or disposal');
            assert.deepStrictEqual(writes, action === 'off' ? [false] : action === 'on' ? [true] : []);
            if (action !== 'dispose') { assert.strictEqual(fixture.f.controller.robotsEnabled, action === 'on'); }
        }
    });

    it('keeps visibility overrides and storage failures usable and persists requested ON even if allocation fails', () => {
        const saved = new Map([['pdf-document-robots-enabled', 'true']]);
        const override = visibilityFixture({ storage: saved, initial: false });
        assert.strictEqual(override.factories.length, 0); assert.deepStrictEqual(override.writes, []);
        const denied = visibilityFixture({ storageFails: true });
        denied.f.controller.setRobotsEnabled(false); assert.strictEqual(denied.f.controller.robotsEnabled, false);
        denied.f.controller.setRobotsEnabled(true); assert.strictEqual(denied.f.controller.robotsEnabled, true);
        const storage = new Map([['pdf-document-robots-enabled', 'false']]);
        const failed = visibilityFixture({ storage, failRenderer: true });
        failed.f.controller.setRobotsEnabled(true);
        assert.strictEqual(failed.f.controller.robotsEnabled, false);
        assert.strictEqual(storage.get('pdf-document-robots-enabled'), 'true', 'persist the request, not failed effective allocation');
        failed.f.dispose();
        const next = visibilityFixture({ storage });
        assert.strictEqual(next.f.controller.robotsEnabled, true, 'requested ON survives transient allocation failure');
    });

    it('strictly decodes visibility storage and defaults safely when asynchronous preference loading fails', async () => {
        for (const value of ['false', 'true', 'FALSE', '0', 'null', '']) {
            const f = visibilityFixture({ storage: new Map([['pdf-document-robots-enabled', value]]) });
            assert.strictEqual(f.f.controller.robotsEnabled, value !== 'false');
            assert.deepStrictEqual(f.writes, [], 'malformed and missing preferences do not create writes');
        }
        const f = visibilityFixture({ preference: { whenReady: () => Promise.reject(new Error('host unavailable')),
            read() { throw new Error('read unavailable'); }, write() { throw new Error('write unavailable'); } } });
        assert.strictEqual(f.factories.length, 0);
        await promisesSettled(); assert.strictEqual(f.f.controller.robotsEnabled, true);
        f.f.controller.setRobotsEnabled(false); await promisesSettled();
        assert.strictEqual(f.f.controller.robotsEnabled, false, 'failed persistence cannot disable the current control');
    });

});
