import { PREFETCH_LIMITS, ScrollPrefetchDynamics } from './scroll-prefetch';
import { installPrefetchDiagnostics, pdfPerformance } from './prefetch-performance';
import './prefetch.css';

// Both engines pin PDF.js 5.1.91. Keep the small viewer/queue integration here, rather than
// importing a second copy of pdf_viewer.mjs into the full viewer application.
const FINISHED = 3;
const RUNNING = 1;
const PAUSED = 2;
const RGBA_BYTES = 4;

interface Options {
    now?: () => number;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (id: number) => void;
    createCanvas?: () => HTMLCanvasElement;
}

interface Preview { canvas: HTMLCanvasElement; bytes: number }
interface Preparation {
    id: number;
    generation: number;
    cancelled: boolean;
    retired?: boolean;
    task?: { promise: Promise<unknown>; cancel: () => void; onContinue?: (resume: () => void) => void };
    canvas?: HTMLCanvasElement;
    page?: any;
}

/**
 * One scheduler for both PDF.js engines. Visible pages retain PDF.js's rendering priority.
 * Its native canvas cache is the expensive tier; small raster previews and warmed PDF page
 * resources form the two cheaper tiers above the existing range/piece cache.
 *
 * Preview renders use the same display intent as native renders. PDF.js therefore shares
 * their operator list and decoded resources, and each speculative render can be cancelled.
 */
export function installPdfPrefetch(viewer: any, options: Options = {}) {
    const container: HTMLElement = viewer.container;
    const owner = container.ownerDocument;
    const win = owner.defaultView;
    const now = options.now ?? (() => performance.now());
    const requestFrame = options.requestFrame ?? ((callback) => win!.requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame ?? ((id) => win!.cancelAnimationFrame(id));
    const createCanvas = options.createCanvas ?? (() => owner.createElement('canvas'));
    const dynamics = new ScrollPrefetchDynamics();
    const queue = viewer.renderingQueue;
    const originalPriority = queue.getHighestPriority;
    const originalDescriptor = Object.getOwnPropertyDescriptor(queue, 'getHighestPriority');
    const originalRender = queue.renderView;
    const originalRenderDescriptor = Object.getOwnPropertyDescriptor(queue, 'renderView');
    const listeners: (() => void)[] = [];
    const jobs = new Map<number, Preparation>();
    const warm = new Map<number, { page: any; native: boolean }>();
    const previews = new Map<number, Preview>();
    const failed = new Set<number>();
    const renderStarts = new Map<number, number>();
    let previewBytes = 0;
    let generation = 0;
    let document: any;
    let disposed = false;
    let refreshing = false;
    let layoutPending = false;
    let frame: number | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let visible: number[] = [];
    let nativePages: number[] = [];
    let renderAhead: number[] = [];
    let prepared: number[] = [];
    let lastDirection = 1;
    let lastPosition = 0;
    let lastWheelAt = -Infinity;
    let signature = '';
    let bounds = new Map<number, { start: number; end: number }>();

    const pageView = (id: number) => viewer.getPageView(id - 1);
    const horizontal = () => viewer.scrollMode === 1;
    const rtl = () => horizontal() && (viewer._isContainerRtl ?? container.dir === 'rtl');
    const viewportSize = () => horizontal() ? container.clientWidth : container.clientHeight;
    const position = () => horizontal() ? container.scrollLeft * (rtl() ? -1 : 1) : container.scrollTop;
    const isReady = (id: number) => pageView(id)?.renderingState === FINISHED || previews.has(id);
    const hidden = () => owner.visibilityState === 'hidden';

    function fetchBackpressure() {
        return pdfPerformance.pendingFetchCount >= PREFETCH_LIMITS.maxPendingFetches
            || pdfPerformance.pendingFetchCount >= PREFETCH_LIMITS.slowPendingFetches
                && pdfPerformance.oldestFetchMs >= PREFETCH_LIMITS.fetchBackpressureMs;
    }

    function canRender(view: any) {
        // Resuming an admitted render or using fully prepared resources adds no cold page.
        // A cancelled RenderTask can leave its worker's image requests running, so the
        // bridge's actual outstanding transfers, not render promises, govern admission.
        const job = jobs.get(view?.id);
        return view?.renderingState === RUNNING || view?.renderingState === PAUSED
            || resourcesWarm(view?.id) || !!job?.task && !job.cancelled
            || jobs.size < PREFETCH_LIMITS.maxConcurrentPrepares && !fetchBackpressure();
    }

    function resourcesWarm(id: number): boolean {
        const entry = warm.get(id);
        if (!entry) { return false; }
        // PDFViewer can clean up the same proxy after it leaves the native LRU, including
        // just before a detached render resolves. An empty intent map means its resources
        // were released. This check never treats an unfinished operator list as readiness.
        if (entry.page._intentStates?.size === 0 || entry.native && pageView(id)?.pdfPage !== entry.page) {
            warm.delete(id);
            return false;
        }
        return true;
    }

    function markWarm(id: number, page: any) {
        if (page._intentStates?.size !== 0) {
            warm.set(id, { page, native: pageView(id)?.pdfPage === page });
        }
    }

    function schedule() {
        if (disposed || frame !== undefined) { return; }
        frame = requestFrame(() => { frame = undefined; refresh(); });
    }

    function bus(name: string, handler: (...args: any[]) => void) {
        viewer.eventBus.on(name, handler);
        listeners.push(() => viewer.eventBus.off(name, handler));
    }

    function listen(target: EventTarget, name: string, handler: EventListener, passive = true) {
        target.addEventListener(name, handler, { passive });
        listeners.push(() => target.removeEventListener(name, handler));
    }

    function motion(delta: number) {
        if (!Number.isFinite(delta) || delta === 0) { return; }
        const previous = dynamics.direction;
        dynamics.input(delta, now());
        lastDirection = dynamics.direction || lastDirection;
        if (previous && dynamics.direction !== previous) {
            pdfPerformance.event('reverse', { direction: dynamics.direction });
        }
        settle();
        schedule();
    }

    function settle() {
        // Chromium emits scrollend after each instantaneous programmatic step, including
        // repeated keyboard/navigation motion. Preserve CoS's short gesture gap instead of
        // clearing velocity between adjacent frames.
        clearTimeout(settleTimer);
        settleTimer = setTimeout(stop, PREFETCH_LIMITS.gestureGapMs);
    }

    function stop() {
        clearTimeout(settleTimer);
        settleTimer = undefined;
        dynamics.stop();
        schedule();
    }

    function onScroll() {
        const next = position();
        const delta = next - lastPosition;
        lastPosition = next;
        // A scale/rotation/layout correction is not reader motion. Wheel input predicts one
        // frame earlier; don't then count the same movement again as a scroll sample.
        if (!layoutPending && now() - lastWheelAt > 48) { motion(delta); }
        schedule();
    }

    function onWheel(event: WheelEvent) {
        if (event.ctrlKey || event.metaKey || hidden()) { return; }
        const raw = horizontal() ? (event.deltaX || event.deltaY) * (rtl() ? -1 : 1) : event.deltaY;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportSize() : 1;
        lastWheelAt = now();
        motion(raw * unit);
    }

    function cancel(job: Preparation) {
        if (job.cancelled) { return; }
        job.cancelled = true;
        job.task?.cancel();
        pdfPerformance.event('prepare-cancel', { page: job.id });
    }

    function removePreview(id: number) {
        const entry = previews.get(id);
        if (!entry) { return; }
        previews.delete(id);
        previewBytes -= entry.bytes;
        entry.canvas.remove();
        entry.canvas.width = entry.canvas.height = 0;
    }

    function clearPreviews() {
        for (const id of previews.keys()) { removePreview(id); }
    }

    function touchPreview(id: number) {
        const entry = previews.get(id);
        if (!entry) { return; }
        previews.delete(id);
        previews.set(id, entry);
    }

    function retainPreview(id: number, canvas: HTMLCanvasElement) {
        removePreview(id);
        const bytes = canvas.width * canvas.height * RGBA_BYTES;
        previews.set(id, { canvas, bytes });
        previewBytes += bytes;
        while (previews.size > PREFETCH_LIMITS.maxPreviewPages || previewBytes > PREFETCH_LIMITS.maxPreviewBytes) {
            const oldest = [...previews.keys()].find(candidate => !visible.includes(candidate));
            if (oldest === undefined) { break; }
            removePreview(oldest);
        }
    }

    function copyRendered(id: number) {
        const view = pageView(id);
        const source = view?.canvas;
        if (view?.renderingState !== FINISHED) { return; }
        if (view.pdfPage) { warm.set(id, { page: view.pdfPage, native: true }); }
        if (previews.has(id) || !source?.width || !source?.height) { return; }
        const ratio = Math.min(1, PREFETCH_LIMITS.previewMaxDimension / Math.max(source.width, source.height));
        const canvas = createCanvas();
        canvas.width = Math.max(1, Math.ceil(source.width * ratio));
        canvas.height = Math.max(1, Math.ceil(source.height * ratio));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) { return; }
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        retainPreview(id, canvas);
    }

    function showPreviews() {
        for (const [id, entry] of previews) {
            const view = pageView(id);
            if (!visible.includes(id) || view?.renderingState === FINISHED) {
                entry.canvas.remove();
                continue;
            }
            const canvas = entry.canvas;
            if (canvas.parentNode !== view.div) {
                canvas.className = 'pdfPrefetchPreview';
                canvas.setAttribute('aria-hidden', 'true');
                Object.assign(canvas.style, {
                    position: 'absolute', inset: '0', width: '100%', height: '100%',
                    pointerEvents: 'none', zIndex: '0',
                });
                view.div.prepend(canvas);
            }
        }
    }

    function pageBounds(id: number, box: DOMRect): { start: number; end: number } {
        const cached = bounds.get(id);
        if (cached) { return cached; }
        const view = pageView(id);
        const rect = view.div.getBoundingClientRect();
        let start = horizontal() ? (rtl() ? box.right - rect.right : rect.left - box.left) : rect.top - box.top;
        let extent = horizontal() ? rect.width : rect.height;
        // Page scroll mode detaches nonvisible pages; estimate their distance in page units.
        if (!(extent > 0)) {
            extent = (horizontal() ? view.width : view.height) || viewportSize();
            start = (id - (visible[0] ?? viewer.currentPageNumber ?? 1)) * extent;
        }
        const result = { start, end: start + extent };
        bounds.set(id, result);
        return result;
    }

    function estimateCanvasBytes(view: any) {
        const ratio = win?.devicePixelRatio || 1;
        const pixels = Math.ceil(view.width * ratio) * Math.ceil(view.height * ratio);
        const max = view.maxCanvasPixels > 0 ? view.maxCanvasPixels : Infinity;
        return Math.min(pixels, max) * RGBA_BYTES;
    }

    function canvasBytes() {
        let bytes = 0;
        for (const view of viewer.getCachedPageViews?.() ?? []) {
            bytes += (view.canvas?.width || 0) * (view.canvas?.height || 0) * RGBA_BYTES;
        }
        return bytes;
    }

    function plan(visiblePages: any) {
        visible = (visiblePages?.views ?? []).map((entry: any) => entry.id).sort((a: number, b: number) => a - b);
        // Native spread/wrapped layouts may render holes between visible IDs. They consume
        // the same LRU slots as visible pages, so reserve their slots before adding lookahead.
        nativePages = visible.length ? Array.from({ length: visible[visible.length - 1] - visible[0] + 1 }, (_, i) => visible[0] + i) : [];
        renderAhead = [];
        prepared = [...nativePages];
        bounds = new Map();
        signature = visible.join(',');
        if (!visible.length) { return; }
        const box = container.getBoundingClientRect();
        const viewport = viewportSize();
        const lead = dynamics.preload(viewport);
        const direction = dynamics.direction || lastDirection;
        const first = visible[0];
        const last = visible[visible.length - 1];
        const candidates: number[] = [];
        const add = (start: number, step: number, distance: number) => {
            for (let id = start; id >= 1 && id <= viewer.pagesCount && candidates.length + nativePages.length < PREFETCH_LIMITS.maxPreparedPages; id += step) {
                const area = pageBounds(id, box);
                const gap = step > 0 ? area.start - viewport : -area.end;
                if (gap > distance && candidates.length) { break; }
                candidates.push(id);
            }
        };
        add(direction > 0 ? last + 1 : first - 1, direction, lead);
        // Keep a short trail for reversals, but spend most of the preparation budget ahead.
        add(direction > 0 ? first - 1 : last + 1, -direction, viewport);
        prepared.push(...candidates);
        let bytes = nativePages.reduce((sum, id) => sum + estimateCanvasBytes(pageView(id)), 0);
        for (const id of candidates) {
            const area = pageBounds(id, box);
            const gap = Math.max(0, area.start - viewport, -area.end);
            const nextBytes = estimateCanvasBytes(pageView(id));
            if (gap > 2 * viewport || nativePages.length + renderAhead.length >= PREFETCH_LIMITS.maxRenderedPages || bytes + nextBytes > PREFETCH_LIMITS.maxCanvasBytes) { continue; }
            renderAhead.push(id);
            bytes += nextBytes;
        }
    }

    function priority(visiblePages: any, views: any[], ...args: any[]) {
        if (disposed || !document || views[0] !== viewer.getPageView(0)) {
            return originalPriority.call(queue, visiblePages, views, ...args);
        }
        const ids = (visiblePages?.views ?? []).map((entry: any) => entry.id).sort((a: number, b: number) => a - b).join(',');
        if (ids !== signature) { plan(visiblePages); }
        const native = originalPriority.call(queue, visiblePages, views, ...args);
        // Preserve PDF.js's visible, detail and spread-hole ordering, including its paused work.
        if (native && visible.length && native.id >= visible[0] && native.id <= visible[visible.length - 1]) {
            if (canRender(native)) { return native; }
            // Another visible page may already have everything it needs while this one
            // waits for stale transfers to drain. Keep useful visible work moving.
            for (const id of nativePages) {
                const view = pageView(id);
                if (view?.renderingState !== FINISHED && canRender(view)) { return view; }
            }
            return null;
        }
        for (const id of renderAhead) {
            const view = pageView(id);
            if (!failed.has(id) && view?.renderingState !== FINISHED && canRender(view)) { return view; }
        }
        return null;
    }
    queue.getHighestPriority = priority;

    // forceRendering awaits getPage before calling renderView. A scroll or document swap can
    // make that selection obsolete while the request is in flight. Fence the completion too.
    function render(view: any) {
        const currentView = pageView(view.id);
        const isPage = view === currentView || /^page\d+$/.test(view.renderingId ?? '');
        const isDetail = /^detail\d+$/.test(view.renderingId ?? '');
        if (isPage || isDetail) {
            const visiblePages = viewer._getVisiblePages();
            const ids = (visiblePages?.views ?? []).map((entry: any) => entry.id).sort((a: number, b: number) => a - b).join(',');
            if (ids !== signature) { plan(visiblePages); }
            const belongs = isPage ? view === currentView : view.pageView === currentView;
            if (!document || document !== viewer.pdfDocument || !belongs || !(nativePages.includes(view.id) || (!isDetail && renderAhead.includes(view.id)))) {
                schedule();
                return false;
            }
            if (!canRender(isDetail ? currentView : view)) { return false; }
            if (isPage && view.renderingState !== RUNNING && view.renderingState !== PAUSED
                && !resourcesWarm(view.id)) {
                // Keep one small display render alive through resource readiness. Cancelling
                // the native canvas alone leaves worker decoding alive, so its slot must not
                // be reused for another cold page until this completion fence finishes.
                if (!jobs.has(view.id)) { void prepare(view.id, view.pdfPage); }
                const job = jobs.get(view.id);
                if (!job?.task || job.cancelled) { return false; }
            }
        }
        return originalRender.call(queue, view);
    }
    queue.renderView = render;

    function visibleUncovered() {
        return visible.some(id => !isReady(id) && !failed.has(id));
    }

    function releaseColdPages() {
        const cached = viewer.getCachedPageViews?.() ?? new Set();
        for (const [id, entry] of warm) {
            if (entry.native && pageView(id)?.pdfPage !== entry.page) { warm.delete(id); continue; }
            if (prepared.includes(id) || jobs.has(id) || cached.has(pageView(id))) { continue; }
            entry.page.cleanup();
            warm.delete(id);
        }
        const keep = new Set([...nativePages, ...renderAhead]);
        let bytes = canvasBytes();
        for (const view of cached) {
            if (keep.has(view.id)) { continue; }
            if (view.renderingState === RUNNING || view.renderingState === PAUSED) {
                view.reset();
            }
            if (bytes > PREFETCH_LIMITS.maxCanvasBytes) {
                copyRendered(view.id);
                const released = (view.canvas?.width || 0) * (view.canvas?.height || 0) * RGBA_BYTES;
                view.destroy();
                warm.delete(view.id);
                bytes -= released;
                pdfPerformance.event('canvas-evict', { page: view.id, bytes: released });
            }
        }
    }

    function current(job: Preparation) {
        return !disposed && !job.cancelled && job.generation === generation && document === viewer.pdfDocument;
    }

    async function prepare(id: number, knownPage?: any) {
        const job: Preparation = { id, generation, cancelled: false };
        const doc = document;
        const started = now();
        jobs.set(id, job);
        try {
            const page = knownPage ?? await doc.getPage(id);
            if (!current(job)) { return; }
            job.page = page;
            if (!prepared.includes(id)) { return; }
            if (!visible.includes(id) && visibleUncovered()) { return; }
            if (!resourcesWarm(id) && fetchBackpressure()) { return; }
            const rotation = ((page.rotate || 0) + (viewer.pagesRotation || 0)) % 360;
            const natural = page.getViewport({ scale: 1, rotation });
            const scale = Math.min(1, PREFETCH_LIMITS.previewMaxDimension / Math.max(natural.width, natural.height));
            const viewport = page.getViewport({ scale, rotation });
            const canvas = job.canvas = createCanvas();
            canvas.width = Math.max(1, Math.ceil(viewport.width));
            canvas.height = Math.max(1, Math.ceil(viewport.height));
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) { throw new Error('Preview canvas is unavailable'); }
            const task = job.task = page.render({
                canvasContext: context, viewport, annotationMode: 1,
                optionalContentConfigPromise: viewer.optionalContentConfigPromise,
            });
            task.onContinue = (resume) => {
                if (!current(job)) { task.cancel(); }
                else { resume(); }
            };
            await task.promise;
            if (!current(job)) { return; }
            markWarm(id, page);
            retainPreview(id, canvas);
            job.canvas = undefined;
            dynamics.page(now() - started);
            pdfPerformance.event('preview-ready', { page: id, ms: now() - started });
        } catch (error) {
            if (current(job) && (error as Error)?.name !== 'RenderingCancelledException') {
                failed.add(id);
                pdfPerformance.event('prepare-failed', { page: id });
            }
        } finally {
            if (job.canvas) { job.canvas.width = job.canvas.height = 0; }
            if (job.page && doc === document && !prepared.includes(id) && !(viewer.getCachedPageViews?.() ?? new Set()).has(pageView(id))) {
                job.page.cleanup();
                warm.delete(id);
            }
            if (jobs.get(id) === job) { jobs.delete(id); }
            if (!disposed && job.generation === generation) { schedule(); }
        }
    }

    function pump() {
        if (!document || hidden()) { return; }
        for (const [id, job] of jobs) {
            if (!prepared.includes(id)) {
                if (!job.task) { cancel(job); }
                else if (!job.retired) {
                    job.retired = true;
                    pdfPerformance.event('prepare-retire', { page: id });
                }
            } else {
                job.retired = false;
            }
        }
        for (const id of prepared) {
            if (previews.has(id)) { touchPreview(id); }
            copyRendered(id);
            const view = pageView(id);
            if ((previews.has(id) && resourcesWarm(id)) || jobs.has(id) || failed.has(id) || view?.renderingState === RUNNING || view?.renderingState === PAUSED) { continue; }
            // render() begins worker-side operator/image processing before onContinue. Keep
            // that CPU and fetch capacity for an uncovered viewport; covered motion can fill
            // the speculative horizon continuously while native resolution catches up.
            if (!visible.includes(id) && visibleUncovered()) { continue; }
            if (!resourcesWarm(id) && fetchBackpressure()) { continue; }
            if (jobs.size >= PREFETCH_LIMITS.maxConcurrentPrepares) { break; }
            void prepare(id);
        }
    }

    function refresh() {
        if (disposed || !document || document !== viewer.pdfDocument || hidden()) { return; }
        plan(viewer._getVisiblePages());
        // updateviewarea can schedule this frame before the scroll event arrives. Only a
        // layout correction may reset the baseline; otherwise that would erase real motion.
        if (layoutPending) { lastPosition = position(); }
        layoutPending = false;
        releaseColdPages();
        showPreviews();
        // update() protects visible pages in PDF.js's private LRU before it picks more work.
        // Ignore its synchronous updateviewarea notification to avoid a self-sustaining RAF.
        refreshing = true;
        try { viewer.update(); } finally { refreshing = false; }
        pump();
    }

    function clearDocument() {
        generation++;
        document = undefined;
        for (const job of jobs.values()) { cancel(job); }
        jobs.clear();
        warm.clear();
        clearPreviews();
        failed.clear();
        renderStarts.clear();
        visible = nativePages = renderAhead = prepared = [];
        signature = '';
        dynamics.reset();
        clearTimeout(settleTimer);
        lastWheelAt = -Infinity;
        lastDirection = 1;
    }

    function activate() {
        clearDocument();
        document = viewer.pdfDocument;
        lastPosition = position();
        pdfPerformance.event('document', { pages: viewer.pagesCount });
        schedule();
    }

    function layout(invalidate = false) {
        stop();
        layoutPending = true;
        signature = '';
        lastPosition = position();
        for (const job of jobs.values()) { cancel(job); }
        if (invalidate) { clearPreviews(); }
        failed.clear();
        schedule();
    }

    function snapshot() {
        const sample = dynamics.snapshot(viewportSize());
        const direction = sample.direction || lastDirection;
        let readyDistancePx = 0;
        if (visible.length && visible.every(isReady)) {
            const box = container.getBoundingClientRect();
            let id = direction > 0 ? visible[visible.length - 1] : visible[0];
            while (id >= 1 && id <= viewer.pagesCount && isReady(id)) {
                const area = pageBounds(id, box);
                readyDistancePx = Math.max(readyDistancePx, direction > 0 ? area.end - viewportSize() : -area.start);
                id += direction;
            }
        }
        const bufferSeconds = sample.velocityPxPerMs > 0 ? readyDistancePx / sample.velocityPxPerMs / 1000 : null;
        const visibleMissing = visible.filter(id => !isReady(id));
        return {
            ...sample, visible: [...visible], renderAhead: [...renderAhead], prepared: [...prepared],
            pending: [...jobs.values()].filter(job => !job.cancelled).map(job => job.id), failed: [...failed],
            retiring: [...jobs.values()].filter(job => job.retired && !job.cancelled).map(job => job.id),
            previewPages: previews.size, previewBytes, canvasBytes: canvasBytes(), readyDistancePx,
            bufferSeconds, safetySeconds: bufferSeconds === null ? null : bufferSeconds - sample.pageLatencyMs / 1000,
            visibleMissing, starved: visibleMissing.length > 0,
            fetchBackpressure: fetchBackpressure(),
            performance: pdfPerformance.snapshot(),
        };
    }

    bus('pagesinit', activate);
    bus('pagesdestroy', clearDocument);
    bus('updateviewarea', () => { if (!refreshing) { schedule(); } });
    for (const name of ['scalechanging', 'scrollmodechanged', 'spreadmodechanged']) { bus(name, () => layout()); }
    for (const name of ['rotationchanging', 'prefetchthemechanged', 'optionalcontentconfigchanged']) { bus(name, () => layout(true)); }
    bus('pagerender', ({ pageNumber }: { pageNumber: number }) => {
        renderStarts.set(pageNumber, now());
        // setPdfPage/reset removed our earlier child; restore it before the first native paint.
        showPreviews();
    });
    bus('pagerendered', ({ pageNumber, error, cssTransform, isDetailView }: any) => {
        if (!document || isDetailView) { return; }
        const start = renderStarts.get(pageNumber);
        renderStarts.delete(pageNumber);
        if (error) { failed.add(pageNumber); }
        else {
            if (!cssTransform && start !== undefined) { dynamics.page(now() - start); }
            const page = pageView(pageNumber)?.pdfPage;
            if (page) { markWarm(pageNumber, page); }
            copyRendered(pageNumber);
        }
        pdfPerformance.event('page-render', { page: pageNumber, ms: start === undefined ? 0 : now() - start, error: !!error });
        schedule();
    });
    listen(container, 'scroll', onScroll);
    listen(container, 'wheel', onWheel as EventListener);
    listen(container, 'scrollend', settle);
    listen(owner, 'visibilitychange', () => {
        if (hidden()) { for (const job of jobs.values()) { cancel(job); } stop(); }
        else { lastPosition = position(); schedule(); }
    });
    listeners.push(pdfPerformance.onFetchChange(schedule));
    const diagnostics = installPrefetchDiagnostics(container, snapshot);
    if (viewer.pdfDocument) { activate(); }

    return {
        snapshot,
        toggleDiagnostics: () => diagnostics.toggle(),
        dispose() {
            if (disposed) { return; }
            disposed = true;
            clearDocument();
            if (frame !== undefined) { cancelFrame(frame); }
            listeners.forEach(remove => remove());
            diagnostics.dispose();
            if (queue.getHighestPriority === priority) {
                if (originalDescriptor) { Object.defineProperty(queue, 'getHighestPriority', originalDescriptor); }
                else { delete queue.getHighestPriority; }
            }
            if (queue.renderView === render) {
                if (originalRenderDescriptor) { Object.defineProperty(queue, 'renderView', originalRenderDescriptor); }
                else { delete queue.renderView; }
            }
        },
    };
}
