import { pdfCachePolicy, ScrollPrefetchDynamics, type PdfCachePolicy } from './scroll-prefetch';
import { installPrefetchDiagnostics, pdfPerformance, type DecodedImageSnapshot } from './prefetch-performance';
import { PdfPreviewCache } from './pdf-preview-cache';
import { installPdfDocumentRobots } from './pdf-document-robots';
import type { RobotDispatchPort } from './prefetch-robots';
import './prefetch.css';

// Both engines pin PDF.js 5.1.91. Keep the small viewer/queue integration here, rather than
// importing a second copy of pdf_viewer.mjs into the full viewer application.
const FINISHED = 3;
const RUNNING = 1;
const PAUSED = 2;
const RGBA_BYTES = 4;
const RANGE_SAMPLE_MS = 1000;
const RANGE_PRESSURE_CHECK_MS = 250;
const MAX_IMAGE_SCAN_ITEMS = 512;

interface Options {
    cachePolicy?: PdfCachePolicy;
    onIdleChange?: (idle: boolean) => void;
    diagnosticsToolbar?: HTMLElement;
    diagnosticsToolbarBefore?: HTMLElement;
    diagnosticsMenu?: HTMLElement;
    onDiagnosticsOpen?: () => void;
    diagnosticsEnabled?: boolean;
    robotsEnabled?: boolean;
    createDocumentRobots?: typeof installPdfDocumentRobots;
    now?: () => number;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (id: number) => void;
    createCanvas?: () => HTMLCanvasElement;
}

interface Preparation {
    id: number;
    generation: number;
    cancelled: boolean;
    retired?: boolean;
    task?: { promise: Promise<unknown>; cancel: () => void; onContinue?: (resume: () => void) => void };
    canvas?: HTMLCanvasElement;
    page?: any;
}

interface ImageDecodeHints { imageDecodeScale: number; imageDecodeMaxDimension: number }

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
    const visualViewport = win?.visualViewport;
    const policy = options.cachePolicy ?? pdfCachePolicy(win?.navigator);
    const limits = policy.limits;
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
    const warm = new Map<number, { page: any; native: boolean } & Partial<ImageDecodeHints>>();
    const previews = new PdfPreviewCache({
        maxBytes: limits.maxPreviewBytes, maxPages: limits.maxPreviewPages,
        trailMaxDimension: limits.trailPreviewMaxDimension, createCanvas,
    });
    const declinedPreviews = new Set<number>();
    const failed = new Set<number>();
    const renderStarts = new Map<number, number>();
    const pendingRobotPages = new Set<number>();
    const deferredRobotPages = new Set<number>();
    let robotCapacityBlocked = false;
    let robotGeometry = '';
    let documentRobots: ReturnType<typeof installPdfDocumentRobots> | undefined;
    let diagnostics: ReturnType<typeof installPrefetchDiagnostics> | undefined;
    let dispatchOrigin: RobotDispatchPort | undefined;
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
    let idle: boolean | undefined;
    let rangeCache: Record<string, number> | undefined;
    let rangeSampleAt = -Infinity;
    let rangeEpoch = 0;
    let rangeFreshRequired = false;
    let rangeTimer: ReturnType<typeof setTimeout> | undefined;
    let rangeRead: { document: any; epoch: number; trim: boolean; promise: Promise<void> } | undefined;

    const pageView = (id: number) => viewer.getPageView(id - 1);
    const horizontal = () => viewer.scrollMode === 1;
    const rtl = () => horizontal() && (viewer._isContainerRtl ?? container.dir === 'rtl');
    const viewportSize = () => horizontal() ? container.clientWidth : container.clientHeight;
    const position = () => horizontal() ? container.scrollLeft * (rtl() ? -1 : 1) : container.scrollTop;
    const isReady = (id: number) => pageView(id)?.renderingState === FINISHED || previews.has(id);
    const hidden = () => owner.visibilityState === 'hidden';
    const nativeTarget = (id: number) => nativePages.includes(id) || renderAhead.includes(id);
    const retainResources = (id: number) => policy.pruneOffscreen
        ? nativeTarget(id) && pageView(id)?.renderingState !== FINISHED : prepared.includes(id);

    function clearRobotPending(): void {
        pendingRobotPages.clear();
        deferredRobotPages.clear();
        robotCapacityBlocked = false;
        robotGeometry = '';
    }

    function updateRobotPages(): void {
        if (!documentRobots?.enabled) { return; }
        const geometry = [container.scrollLeft, container.scrollTop, container.clientWidth, container.clientHeight,
            visualViewport?.offsetLeft ?? 0, visualViewport?.offsetTop ?? 0,
            visualViewport?.width ?? win?.innerWidth, visualViewport?.height ?? win?.innerHeight, ...visible].join(',');
        if (geometry !== robotGeometry) { deferredRobotPages.clear(); robotGeometry = geometry; }
        for (const id of pendingRobotPages) {
            if (!visible.includes(id) || documentRobots.hasHandled(id) || failed.has(id)) {
                pendingRobotPages.delete(id);
                deferredRobotPages.delete(id);
            }
        }
        for (const id of visible) {
            if (!documentRobots.hasHandled(id) && !failed.has(id)) { pendingRobotPages.add(id); }
        }
        // Removing an offscreen courier can release capacity synchronously. Update the
        // waiting IDs first so its notification cannot retain an obsolete page.
        documentRobots.setVisiblePages(visible);
    }

    function onRobotCapacityAvailable(): void {
        robotCapacityBlocked = false;
        scheduleRobotUpdate();
    }

    function scheduleRobotUpdate(): void {
        if (!disposed && documentRobots?.enabled && !hidden() && document && document === viewer.pdfDocument
            && pendingRobotPages.size > 0) { schedule(); }
    }

    function setDocumentRobotsEnabled(enabled: boolean): void {
        if (disposed) { return; }
        if (enabled && !documentRobots) {
            try {
                documentRobots = (options.createDocumentRobots ?? installPdfDocumentRobots)(container, {
                    device: policy.name,
                    onCapacityAvailable: onRobotCapacityAvailable,
                });
            }
            catch { pdfPerformance.event('document-robots-unavailable'); }
        }
        if (!enabled) { clearRobotPending(); }
        documentRobots?.setEnabled(enabled);
        if (enabled && documentRobots) {
            documentRobots.setDispatchOrigin(dispatchOrigin);
            updateRobotPages();
            if (document) { schedule(); }
        }
    }

    /** Each page can deliver its real pixels on first useful entry, including a ready cache hit. */
    function deliverPixels(id: number): void {
        if (!documentRobots?.enabled || !pendingRobotPages.has(id) || !visible.includes(id)
            || robotCapacityBlocked || deferredRobotPages.has(id)
            || hidden() || !document || document !== viewer.pdfDocument) { return; }
        if (documentRobots.hasHandled(id)) { pendingRobotPages.delete(id); return; }
        const view = pageView(id);
        const native = view?.renderingState === FINISHED && view.canvas?.width && view.canvas?.height ? view.canvas : undefined;
        const canvas = native ?? previews.get(id)?.canvas;
        if (!canvas?.width || !canvas?.height || !view?.div) { return; }
        try {
            const result = documentRobots.offer({ pageNumber: id, pageElement: view.div, canvas, kind: native ? 'page' : 'preview' });
            if (result === 'busy') { robotCapacityBlocked = true; }
            else if (result === 'deferred') { deferredRobotPages.add(id); }
            else { pendingRobotPages.delete(id); }
        } catch {
            deferredRobotPages.add(id);
            pdfPerformance.event('document-robot-delivery-failed', { page: id });
        }
    }

    function setIdle(next: boolean) {
        if (idle === next) { return; }
        idle = next;
        options.onIdleChange?.(next);
    }

    function updateIdle() {
        setIdle(!disposed && !!document && document === viewer.pdfDocument && !hidden()
            && !memoryAdmissionBlocked() && !workerBytesBusy()
            && dynamics.direction === 0 && jobs.size === 0 && pdfPerformance.pendingFetchCount === 0
            && visible.length > 0 && visible.every(isReady)
            && [...nativePages, ...renderAhead].every(id => ![RUNNING, PAUSED].includes(pageView(id)?.renderingState)));
    }

    function memoryBackpressure() {
        return (rangeCache?.residentBytes ?? 0) > policy.rangeCacheBytes;
    }

    function memoryAdmissionBlocked() {
        return memoryBackpressure() || rangeFreshRequired || !!rangeRead?.trim;
    }

    function workerBytesBusy() {
        return (rangeCache?.activeOperations ?? 0) > 0 || (rangeCache?.pendingRequests ?? 0) > 0;
    }

    function stopRangeChecks() {
        clearTimeout(rangeTimer);
        rangeTimer = undefined;
        rangeRead = undefined;
        rangeEpoch++;
        rangeSampleAt = -Infinity;
    }

    function maintainRangeChecks() {
        const nativeWorking = [...renderStarts.keys()].some(id => [RUNNING, PAUSED].includes(pageView(id)?.renderingState));
        const needed = !disposed && !hidden() && document === viewer.pdfDocument && !!document?.getRangeCacheStats
            && (memoryBackpressure() || workerBytesBusy() || jobs.size > 0 || nativeWorking);
        if (!needed) { clearTimeout(rangeTimer); rangeTimer = undefined; return; }
        if (rangeTimer !== undefined || rangeRead) { return; }
        // Detached decoding can finish without a canvas event or another animation frame.
        // Poll only this unsettled interval; a quiescent result removes the timer entirely.
        rangeTimer = setTimeout(() => {
            rangeTimer = undefined;
            void sampleRangeCache(true, true);
        }, RANGE_PRESSURE_CHECK_MS);
    }

    function sampleRangeCache(trim = false, force = false): Promise<void> {
        const doc = document;
        const epoch = rangeEpoch;
        if (disposed || hidden() || doc !== viewer.pdfDocument || !doc?.getRangeCacheStats) { return Promise.resolve(); }
        if (rangeRead) {
            // A cold completion needs a fresh trim after an older stats-only RPC. Concurrent
            // completions then share that one trim while retaining their admission slots.
            if (trim && !rangeRead.trim) {
                return rangeRead.promise.then(() => {
                    if (!disposed && !hidden() && document === doc && rangeEpoch === epoch) {
                        return sampleRangeCache(true, true);
                    }
                });
            }
            return rangeRead.promise;
        }
        if (!force && now() - rangeSampleAt < RANGE_SAMPLE_MS) { return Promise.resolve(); }
        clearTimeout(rangeTimer);
        rangeTimer = undefined;
        rangeSampleAt = now();
        const read = { document: doc, epoch, trim, promise: Promise.resolve() };
        rangeRead = read;
        let wasBlocked = false;
        const live = () => !disposed && !hidden() && document === doc && rangeEpoch === epoch;
        read.promise = Promise.resolve().then(() => {
            if (live()) { return trim && doc.trimRangeCache ? doc.trimRangeCache() : doc.getRangeCacheStats(); }
        }).then(stats => {
            if (!live()) { return; }
            wasBlocked = memoryAdmissionBlocked();
            rangeCache = stats ?? undefined;
            rangeFreshRequired = false;
        }, () => {
            if (!live()) { return; }
            wasBlocked = memoryAdmissionBlocked();
            rangeCache = undefined;
            rangeFreshRequired = false;
        }).finally(() => {
            if (rangeRead !== read || !live()) { return; }
            wasBlocked ||= memoryAdmissionBlocked();
            rangeRead = undefined;
            if (wasBlocked && !memoryAdmissionBlocked()) { schedule(); }
            maintainRangeChecks();
            updateIdle();
        });
        return read.promise;
    }

    function fetchBackpressure() {
        return pdfPerformance.pendingFetchCount >= limits.maxPendingFetches
            || pdfPerformance.pendingFetchCount >= limits.slowPendingFetches
                && pdfPerformance.oldestFetchMs >= limits.fetchBackpressureMs;
    }

    function canRender(view: any) {
        // Resuming an admitted render or using fully prepared resources adds no cold page.
        // A cancelled RenderTask can leave its worker's image requests running, so the
        // bridge's actual outstanding transfers, not render promises, govern admission.
        const job = jobs.get(view?.id);
        return view?.renderingState === RUNNING || view?.renderingState === PAUSED
            || resourcesWarm(view?.id) || !!job?.task && !job.cancelled
            || jobs.size < limits.maxConcurrentPrepares && !fetchBackpressure() && !memoryAdmissionBlocked();
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
        const hints = nativeImageHints(id, entry.page);
        if (hints && ((entry.imageDecodeScale ?? 0) < hints.imageDecodeScale
            || (entry.imageDecodeMaxDimension ?? 0) < hints.imageDecodeMaxDimension)) {
            warm.delete(id);
            return false;
        }
        return true;
    }

    function nativeImageHints(id: number, page: any): ImageDecodeHints | undefined {
        if (!policy.adaptiveImageDecoding) { return; }
        const view = pageView(id);
        const rotation = ((page.rotate || 0) + (viewer.pagesRotation || 0)) % 360;
        const natural = page.getViewport({ scale: 1, rotation });
        const viewport = view?.viewport ?? page.getViewport({ scale: (view?.width || natural.width) / natural.width, rotation });
        const ratio = win?.devicePixelRatio || 1;
        let sx = view?.outputScale?.sx || ratio;
        let sy = view?.outputScale?.sy || ratio;
        if (!view?.outputScale) {
            if (view?.maxCanvasPixels === 0 && view.scale > 0) { sx /= view.scale; sy /= view.scale; }
            const maximum = Math.min(
                view?.maxCanvasPixels > 0 ? Math.sqrt(view.maxCanvasPixels / (viewport.width * viewport.height)) : Infinity,
                view?.maxCanvasDim > 0 ? view.maxCanvasDim / viewport.width : Infinity,
                view?.maxCanvasDim > 0 ? view.maxCanvasDim / viewport.height : Infinity,
            );
            sx = Math.min(sx, maximum);
            sy = Math.min(sy, maximum);
        }
        const transform = [sx, 0, 0, sy, 0, 0];
        return page.getImageDecodeHints?.({ viewport, transform }) ?? {
            imageDecodeScale: viewport.scale * Math.max(sx, sy),
            imageDecodeMaxDimension: Math.max(viewport.width * sx, viewport.height * sy),
        };
    }

    function markWarm(id: number, page: any, hints?: ImageDecodeHints) {
        if (page._intentStates?.size !== 0) {
            const view = pageView(id);
            const native = view?.pdfPage === page;
            if (policy.pruneOffscreen && native && view.renderingState === FINISHED && !jobs.has(id)) {
                // PDF.js defers this until every render task and operator list is finished.
                // The completed native canvas and our saved raster remain available.
                page.cleanup();
                warm.delete(id);
                return;
            }
            warm.set(id, { page, native, ...(hints ?? nativeImageHints(id, page)) });
        } else {
            warm.delete(id);
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
        setIdle(false);
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
        settleTimer = setTimeout(stop, limits.gestureGapMs);
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

    function clearPreviews() {
        previews.clear();
        declinedPreviews.clear();
    }

    function touchPreview(id: number) {
        previews.touch(id);
    }

    function retainPreview(id: number, canvas: HTMLCanvasElement) {
        const retained = previews.retain(id, canvas, new Set([...visible, ...prepared]));
        if (retained) { declinedPreviews.delete(id); deliverPixels(id); }
        else { declinedPreviews.add(id); }
        return retained;
    }

    function copyRendered(id: number) {
        const view = pageView(id);
        const source = view?.canvas;
        if (view?.renderingState !== FINISHED) { return; }
        if (view.pdfPage) { markWarm(id, view.pdfPage); }
        if (declinedPreviews.has(id) || !source?.width || !source?.height) { return; }
        const ratio = Math.min(1, limits.previewMaxDimension / Math.max(source.width, source.height));
        const width = Math.max(1, Math.ceil(source.width * ratio));
        const height = Math.max(1, Math.ceil(source.height * ratio));
        const previous = previews.get(id)?.canvas;
        if (previous && (previous.width >= width && previous.height >= height
            || !nativeTarget(id) && !visible.includes(id))) { return; }
        let canvas: HTMLCanvasElement | undefined;
        try {
            canvas = createCanvas();
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) { throw new Error('Preview copy context is unavailable'); }
            context.drawImage(source, 0, 0, canvas.width, canvas.height);
        } catch {
            if (canvas) { canvas.remove(); canvas.width = canvas.height = 0; }
            // Canvas memory pressure must leave the previous placeholder usable and must
            // not allocate the same failed copy again on every idle viewer refresh.
            declinedPreviews.add(id);
            return;
        }
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
        for (const id of visible) { deliverPixels(id); }
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

    function decodedImages(): DecodedImageSnapshot {
        const result: DecodedImageSnapshot = {
            pageBytes: 0, sharedBytes: 0, dataBytes: 0, bitmapBytes: 0, images: 0, supported: true, truncated: false,
        };
        const pages = new Set<any>();
        for (const entry of warm.values()) { pages.add(entry.page); }
        for (const job of jobs.values()) { if (job.page) { pages.add(job.page); } }
        const pageCount = Math.min(viewer.pagesCount, MAX_IMAGE_SCAN_ITEMS);
        for (let id = 1; id <= pageCount; id++) {
            const page = pageView(id)?.pdfPage;
            if (page) { pages.add(page); }
        }
        if (viewer.pagesCount > pageCount) { result.truncated = true; }
        const stores = new Set<any>();
        const objects = new Set<object>();
        const allocations = new Set<object>();
        let inspected = 0;
        const scan = (store: any, shared: boolean) => {
            if (!store || typeof store[Symbol.iterator] !== 'function') { result.supported = false; return; }
            if (stores.has(store)) { return; }
            stores.add(store);
            try {
                for (const [, value] of store) {
                    if (inspected++ >= MAX_IMAGE_SCAN_ITEMS) { result.truncated = true; return; }
                    if (!value || typeof value !== 'object' || objects.has(value)) { continue; }
                    objects.add(value);
                    if (!(value.width > 0 && value.height > 0)) { continue; }
                    let bytes = 0;
                    const buffer = ArrayBuffer.isView(value.data) ? value.data.buffer
                        : value.data instanceof ArrayBuffer ? value.data : undefined;
                    if (buffer && !allocations.has(buffer)) {
                        allocations.add(buffer);
                        bytes += buffer.byteLength;
                        result.dataBytes += buffer.byteLength;
                    }
                    const bitmap = value.bitmap;
                    if (bitmap && typeof bitmap === 'object' && !allocations.has(bitmap)) {
                        const size = (bitmap.width ?? bitmap.displayWidth) * (bitmap.height ?? bitmap.displayHeight) * RGBA_BYTES;
                        if (Number.isSafeInteger(size) && size > 0) {
                            allocations.add(bitmap);
                            bytes += size;
                            result.bitmapBytes += size;
                        }
                    }
                    if (bytes) {
                        result[shared ? 'sharedBytes' : 'pageBytes'] += bytes;
                        result.images++;
                    }
                }
            } catch { result.supported = false; }
        };
        // A shared image can also appear in a page store. Attribute its backing allocation
        // to the shared tier once, before inspecting page-local aliases and subarray views.
        const sharedStores = new Set([...pages].map(page => page.commonObjs));
        if (document?._transport?.commonObjs) { sharedStores.add(document._transport.commonObjs); }
        for (const store of sharedStores) { if (inspected <= MAX_IMAGE_SCAN_ITEMS) { scan(store, true); } }
        for (const page of pages) { if (inspected <= MAX_IMAGE_SCAN_ITEMS) { scan(page.objs, false); } }
        return result;
    }

    function plan(visiblePages: any) {
        visible = (visiblePages?.views ?? []).map((entry: any) => entry.id).sort((a: number, b: number) => a - b);
        // Native spread/wrapped layouts may render holes between visible IDs. They consume
        // the same LRU slots as visible pages, so reserve their slots before adding lookahead.
        nativePages = visible.length ? Array.from({ length: visible[visible.length - 1] - visible[0] + 1 }, (_, i) => visible[0] + i) : [];
        renderAhead = [];
        prepared = [...nativePages];
        bounds = new Map();
        const nextSignature = visible.join(',');
        if (signature !== nextSignature) { declinedPreviews.clear(); }
        signature = nextSignature;
        updateRobotPages();
        if (!visible.length) { return; }
        const box = container.getBoundingClientRect();
        const viewport = viewportSize();
        const lead = dynamics.preload(viewport);
        const direction = dynamics.direction || lastDirection;
        const first = visible[0];
        const last = visible[visible.length - 1];
        const candidates: number[] = [];
        const add = (start: number, step: number, distance: number) => {
            for (let id = start; id >= 1 && id <= viewer.pagesCount && candidates.length + nativePages.length < limits.maxPreparedPages; id += step) {
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
            if (gap > 2 * viewport || nativePages.length + renderAhead.length >= limits.maxRenderedPages || bytes + nextBytes > limits.maxCanvasBytes) { continue; }
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
    // make that selection obsolete while the request is in flight. Check the completion too.
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
                // be reused for another cold page until this preparation finishes.
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
            const view = pageView(id);
            if (retainResources(id) || jobs.has(id)
                || cached.has(view) && !(policy.pruneOffscreen && view.renderingState === FINISHED)) { continue; }
            entry.page.cleanup();
            warm.delete(id);
        }
        const keep = new Set([...nativePages, ...renderAhead]);
        let bytes = canvasBytes();
        for (const view of cached) {
            if (keep.has(view.id) || jobs.has(view.id)) { continue; }
            if (view.renderingState === RUNNING || view.renderingState === PAUSED) {
                view.reset();
            }
            if (bytes > limits.maxCanvasBytes || policy.pruneOffscreen && (view.canvas || view.pdfPage?._intentStates?.size)) {
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
        setIdle(false);
        const job: Preparation = { id, generation, cancelled: false };
        const doc = document;
        const started = now();
        jobs.set(id, job);
        maintainRangeChecks();
        try {
            const page = knownPage ?? await doc.getPage(id);
            if (!current(job)) { return; }
            job.page = page;
            if (!prepared.includes(id)) { return; }
            if (pageView(id)?.renderingState === FINISHED
                || policy.pruneOffscreen && previews.has(id) && !nativeTarget(id)) { return; }
            if (!visible.includes(id) && visibleUncovered()) { return; }
            if (!resourcesWarm(id) && (fetchBackpressure() || memoryAdmissionBlocked())) { return; }
            const rotation = ((page.rotate || 0) + (viewer.pagesRotation || 0)) % 360;
            const natural = page.getViewport({ scale: 1, rotation });
            const scale = Math.min(1, limits.previewMaxDimension / Math.max(natural.width, natural.height));
            const viewport = page.getViewport({ scale, rotation });
            const canvas = job.canvas = createCanvas();
            canvas.width = Math.max(1, Math.ceil(viewport.width));
            canvas.height = Math.max(1, Math.ceil(viewport.height));
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) { throw new Error('Preview canvas is unavailable'); }
            const imageHints = nativeImageHints(id, page);
            const task = job.task = page.render({
                canvasContext: context, viewport, annotationMode: 1,
                optionalContentConfigPromise: viewer.optionalContentConfigPromise,
                ...imageHints,
            });
            task.onContinue = (resume: () => void) => {
                if (!current(job)) { task.cancel(); }
                else { resume(); }
            };
            await task.promise;
            if (!current(job)) { return; }
            markWarm(id, page, imageHints);
            const retained = retainPreview(id, canvas);
            job.canvas = undefined;
            dynamics.page(now() - started);
            if (retained) { pdfPerformance.event('preview-ready', { page: id, ms: now() - started }); }
        } catch (error) {
            if (current(job) && (error as Error)?.name !== 'RenderingCancelledException') {
                failed.add(id);
                pdfPerformance.event('prepare-failed', { page: id });
            }
        } finally {
            if (job.canvas) { job.canvas.width = job.canvas.height = 0; }
            if (job.page && doc === document && !retainResources(id)
                && (policy.pruneOffscreen || !(viewer.getCachedPageViews?.() ?? new Set()).has(pageView(id)))) {
                job.page.cleanup();
                warm.delete(id);
            }
            if (!disposed && !hidden() && doc === document && job.generation === generation) {
                // Keep the cold slot until the worker has reported or trimmed its resident
                // bytes. Releasing it first would replenish continuous overlapping jobs and
                // deny the sparse store the quiescent interval required for safe eviction.
                await sampleRangeCache(true, true);
            }
            if (jobs.get(id) === job) { jobs.delete(id); }
            if (!disposed && job.generation === generation) { maintainRangeChecks(); schedule(); }
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
            if (view?.renderingState === FINISHED || jobs.has(id) || failed.has(id) || declinedPreviews.has(id)
                || view?.renderingState === RUNNING || view?.renderingState === PAUSED
                || previews.has(id) && (resourcesWarm(id) || policy.pruneOffscreen && !nativeTarget(id))) { continue; }
            // render() begins worker-side operator/image processing before onContinue. Keep
            // that CPU and fetch capacity for an uncovered viewport; covered motion can fill
            // the speculative horizon continuously while native resolution catches up.
            if (!visible.includes(id) && visibleUncovered()) { continue; }
            if (!resourcesWarm(id) && (fetchBackpressure() || memoryAdmissionBlocked())) { continue; }
            if (jobs.size >= limits.maxConcurrentPrepares) { break; }
            void prepare(id);
        }
    }

    function refresh() {
        if (disposed || !document || document !== viewer.pdfDocument || hidden()) { return; }
        void sampleRangeCache();
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
        updateIdle();
    }

    function clearDocument() {
        setIdle(false);
        clearRobotPending();
        documentRobots?.reset();
        stopRangeChecks();
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
        rangeCache = undefined;
        rangeSampleAt = -Infinity;
        rangeFreshRequired = false;
    }

    function activate() {
        clearDocument();
        document = viewer.pdfDocument;
        rangeFreshRequired = !!document?.getRangeCacheStats;
        void sampleRangeCache(false, true);
        lastPosition = position();
        pdfPerformance.event('document', { pages: viewer.pagesCount });
        schedule();
    }

    function layout(invalidate = false) {
        stop();
        clearRobotPending();
        documentRobots?.setVisiblePages([]);
        layoutPending = true;
        signature = '';
        lastPosition = position();
        for (const job of jobs.values()) { cancel(job); }
        if (invalidate) { clearPreviews(); }
        failed.clear();
        schedule();
    }

    function snapshot() {
        void sampleRangeCache();
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
            ...sample, cachePolicy: policy.name, cacheLimits: limits, idle: !!idle,
            rangeCache: rangeCache ? { ...rangeCache } : undefined,
            decodedImages: decodedImages(),
            robots: documentRobots?.snapshot(),
            labRobots: diagnostics?.labSnapshot(),
            visible: [...visible], renderAhead: [...renderAhead], prepared: [...prepared],
            pending: [...jobs.values()].filter(job => !job.cancelled).map(job => job.id), failed: [...failed],
            retiring: [...jobs.values()].filter(job => job.retired && !job.cancelled).map(job => job.id),
            previewPages: previews.size, previewBytes: previews.bytes, canvasBytes: canvasBytes(), readyDistancePx,
            bufferSeconds, safetySeconds: bufferSeconds === null ? null : bufferSeconds - sample.pageLatencyMs / 1000,
            visibleMissing, starved: visibleMissing.length > 0,
            fetchBackpressure: fetchBackpressure(),
            memoryBackpressure: memoryBackpressure(),
            performance: pdfPerformance.snapshot(),
        };
    }

    bus('pagesinit', activate);
    bus('pagesdestroy', clearDocument);
    bus('updateviewarea', () => { if (!refreshing) { schedule(); } });
    for (const name of ['scalechanging', 'scrollmodechanged', 'spreadmodechanged']) { bus(name, () => layout()); }
    for (const name of ['rotationchanging', 'prefetchthemechanged', 'optionalcontentconfigchanged']) { bus(name, () => layout(true)); }
    bus('pagerender', ({ pageNumber }: { pageNumber: number }) => {
        setIdle(false);
        renderStarts.set(pageNumber, now());
        maintainRangeChecks();
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
            deliverPixels(pageNumber);
        }
        pdfPerformance.event('page-render', { page: pageNumber, ms: start === undefined ? 0 : now() - start, error: !!error });
        void sampleRangeCache(true, true);
        maintainRangeChecks();
        schedule();
    });
    listen(container, 'scroll', onScroll);
    listen(container, 'wheel', onWheel as EventListener);
    listen(container, 'scrollend', settle);
    if (visualViewport) {
        listen(visualViewport, 'scroll', scheduleRobotUpdate);
        listen(visualViewport, 'resize', scheduleRobotUpdate);
    }
    listen(owner, 'visibilitychange', () => {
        if (hidden()) {
            setIdle(false);
            clearRobotPending();
            documentRobots?.setVisiblePages([]);
            stopRangeChecks();
            rangeFreshRequired = !!document?.getRangeCacheStats;
            for (const job of jobs.values()) { cancel(job); }
            stop();
        } else {
            lastPosition = position();
            void sampleRangeCache(true, true);
            schedule();
        }
    });
    listeners.push(pdfPerformance.onFetchChange(() => {
        if (pdfPerformance.pendingFetchCount > 0) { setIdle(false); }
        schedule();
    }));
    setDocumentRobotsEnabled(options.robotsEnabled !== false);
    diagnostics = installPrefetchDiagnostics(container, snapshot, {
        toolbar: options.diagnosticsToolbar,
        toolbarBefore: options.diagnosticsToolbarBefore,
        measurementsMenu: options.diagnosticsMenu,
        onOpen: options.onDiagnosticsOpen,
        enabled: options.diagnosticsEnabled,
        robots: {
            get enabled() { return documentRobots?.enabled ?? false; },
            setEnabled: setDocumentRobotsEnabled,
            setDispatchOrigin(port) { dispatchOrigin = port; documentRobots?.setDispatchOrigin(port); },
        },
    });
    if (viewer.pdfDocument) { activate(); }

    return {
        snapshot,
        toggleDiagnostics: () => diagnostics!.toggle(),
        setDiagnosticsEnabled: (enabled: boolean) => diagnostics!.setEnabled(enabled),
        get diagnosticsEnabled() { return diagnostics!.enabled; },
        setRobotsEnabled: (enabled: boolean) => diagnostics!.setRobotsEnabled(enabled),
        get robotsEnabled() { return documentRobots?.enabled ?? false; },
        dispose() {
            if (disposed) { return; }
            disposed = true;
            clearDocument();
            if (frame !== undefined) { cancelFrame(frame); }
            listeners.forEach(remove => remove());
            diagnostics!.dispose();
            documentRobots?.dispose();
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
