import { pdfCachePolicy, pdfSidecarDecodeOptions, ScrollPrefetchDynamics, type PdfCachePolicy } from './scroll-prefetch';
import { installPrefetchDiagnostics, pdfPerformance, type DecodedImageSnapshot, type MotionLabMeasurementsPreference, type ViewerBooleanPreference } from './prefetch-performance';
import { PdfPreviewCache } from './pdf-preview-cache';
import { PdfPagePresentation, type PdfPagePresentationCandidate } from './pdf-page-presentation';
import { installPdfDocumentRobots, documentRobotWorkMembers, type DocumentRobotDelivery, type DocumentRobotWorkGroup } from './pdf-document-robots';
import { createPdfPreviewSourceLoader, rotatePdfPreviewImageRegions, type PdfPreviewSource } from './pdf-preview-source';
import type { RobotDispatchPort } from './prefetch-robots';
import { createPdfRenderTimings, type PdfRenderMeasurement } from './pdf-render-timing';
import { nativePdfImageContext, type PdfImageDecodeHints as ImageDecodeHints } from './pdf-image-hints';
import { installPdfDocumentColumn, type PdfDocumentColumnTransition } from './pdf-document-column';
import { createPdfRasterProjection, pdfPageFromRaster, pdfRasterPageClip, pdfRasterToCss,
    reorientPdfRasterProjection, resizePdfRasterProjection, type PdfPageProjection, type PdfRasterProjection } from './pdf-raster-projection';
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
const ROBOTS_PREFERENCE_KEY = 'pdf-document-robots-enabled';

interface Options {
    cachePolicy?: PdfCachePolicy;
    onIdleChange?: (idle: boolean) => void;
    diagnosticsToolbar?: HTMLElement;
    diagnosticsToolbarBefore?: HTMLElement;
    diagnosticsMenu?: HTMLElement;
    measurementsPreference?: MotionLabMeasurementsPreference;
    onDiagnosticsOpen?: () => void;
    diagnosticsEnabled?: boolean;
    robotsEnabled?: boolean;
    robotsPreference?: ViewerBooleanPreference;
    createDocumentRobots?: typeof installPdfDocumentRobots;
    createDocumentColumn?: typeof installPdfDocumentColumn;
    now?: () => number;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (id: number) => void;
    createCanvas?: () => HTMLCanvasElement;
    previewSource?: PdfPreviewSource;
    createPreviewSourceLoader?: typeof createPdfPreviewSourceLoader;
}

interface Preparation {
    id: number;
    generation: number;
    cancelled: boolean;
    retired?: boolean;
    task?: { promise: Promise<unknown>; cancel: () => void; onContinue?: (resume: () => void) => void };
    canvas?: HTMLCanvasElement;
    page?: any;
    measurement?: PdfRenderMeasurement;
}

interface ImageWatch {
    page: any;
    unsubscribe(): void;
}
interface NativeRaster {
    view: any;
    document: any;
    projection: PdfRasterProjection;
    rotation: number;
    currentProjection: PdfRasterProjection;
    currentRotation: number;
}
interface PageProjectionCache {
    hasCanvas: boolean;
    viewport: any;
    nativeProjection: PdfRasterProjection | undefined;
    transform: string | undefined;
    page: PdfPageProjection;
}
interface ReplacementIntent {
    identity: string;
    document?: any;
    generation: number;
    captured: boolean;
    signal?: AbortSignal;
    cancel(): void;
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
    const visualViewport = win?.visualViewport;
    const policy = options.cachePolicy ?? pdfCachePolicy(win?.navigator);
    const limits = policy.limits;
    const now = options.now ?? (() => performance.now());
    const requestFrame = options.requestFrame ?? ((callback) => win!.requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame ?? ((id) => win!.cancelAnimationFrame(id));
    const createCanvas = options.createCanvas ?? (() => owner.createElement('canvas'));
    const renderTimings = createPdfRenderTimings({ now, requestFrame, cancelFrame });
    const dynamics = new ScrollPrefetchDynamics(limits.gestureGapMs);
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
        publishAttached: (_id, candidate, commit) => !!candidate && presentCandidate(candidate, commit),
    });
    const declinedPreviews = new Set<number>();
    const failed = new Set<number>();
    let appearanceEpoch = 0;
    const presentations = new Map<number, PdfPagePresentation>();
    const sourcePages = new Map<number, { identity: object; proxy?: object }>();
    function sourceIdentity(id: number, proxy?: object): object | undefined {
        let source = sourcePages.get(id);
        if (!source) { source = { identity: {} }; sourcePages.set(id, source); }
        if (proxy) {
            if (source.proxy && source.proxy !== proxy) { return; }
            source.proxy = proxy;
        }
        return source.identity;
    }
    const presentationHooks = new Map<any, { previous: unknown; installed?: unknown; usefulPrevious?: unknown; usefulInstalled?: unknown }>();

    function presentation(id: number): PdfPagePresentation {
        let value = presentations.get(id);
        if (!value) { presentations.set(id, value = new PdfPagePresentation()); }
        return value;
    }

    function encounter(id: number) {
        const view = pageView(id), metadata = previewLoader?.page(id);
        return { pageElement: view.div, moving: !layoutPending && (dynamics.direction !== 0 || position() !== lastPosition),
            axis: horizontal() ? 'x' as const : 'y' as const, pageProjection: pageProjection(view),
            imageRegions: metadata && rotatePdfPreviewImageRegions(metadata.imageRegions, viewer.pagesRotation || 0),
            imageRegionsComplete: metadata?.imageRegionsComplete === true };
    }

    function presentCandidate(candidate: PdfPagePresentationCandidate, commit: () => void): boolean {
        retireMissingPresentation(candidate.pageNumber);
        const value = presentation(candidate.pageNumber);
        if (!value.accepts(candidate)) { return false; }
        const transaction = documentRobots?.enabled && documentRobots.preparePublication
            ? documentRobots.preparePublication(candidate, encounter(candidate.pageNumber), displayedCandidate(candidate.pageNumber)) : undefined;
        try {
            const accepted = value.present(candidate, commit);
            if (accepted) {
                pageView(candidate.pageNumber).hasUsefulPresentation = true;
                pageView(candidate.pageNumber).div.classList?.remove('loadingIcon', 'loading');
                transaction?.commit();
            } else { transaction?.abort(); }
            return accepted;
        } catch (error) { transaction?.abort(); throw error; }
    }

    function displayedCandidate(id: number): PdfPagePresentationCandidate | undefined {
        const candidate = presentations.get(id)?.current(), view = pageView(id);
        if (!candidate || !view || candidate.document !== document || candidate.page !== sourceIdentity(id, view.pdfPage)
            || !candidate.canvas.width || !candidate.canvas.height || !candidate.canvas.isConnected
            || !view.div?.contains(candidate.canvas)) { return; }
        return candidate;
    }

    function displayedProjection(id: number, candidate: PdfPagePresentationCandidate): PdfRasterProjection {
        const native = nativeRasters.get(candidate.canvas), view = pageView(id);
        if (native && native.view === view && native.document === document) {
            return reorientPdfRasterProjection(native.projection, (view.viewport?.rotation ?? native.rotation) - native.rotation);
        }
        return candidate.projection;
    }

    function displayedNativeCoverage(id: number): boolean {
        const candidate = displayedCandidate(id);
        return !!candidate && candidate.canvas !== previews.get(id)?.canvas && displayedCoverage(id);
    }

    function displayedCoverage(id: number): boolean {
        const candidate = displayedCandidate(id);
        if (!candidate) { return false; }
        const coverage = candidate.coverage;
        return coverage.kind === 'complete-page' || coverage.kind === 'native' && coverage.discovered
            && coverage.resources.every(resource => resource.covered);
    }

    function retireMissingPresentation(id: number): void {
        const value = presentations.get(id), current = value?.current();
        if (!current || displayedCandidate(id)) { return; }
        value!.reset();
        const view = pageView(id);
        if (view) { view.hasUsefulPresentation = false; }
        documentRobots?.removePage?.(current.page, 'raster-removed', true, view?.div);
    }

    function installPresentationHook(view: any): void {
        if (presentationHooks.has(view)) { return; }
        const hook = { previous: view.publishImageCandidate, installed: undefined as unknown, usefulPrevious: view.hasDisplayedPresentation, usefulInstalled: undefined as unknown };
        view.hasDisplayedPresentation = () => !!displayedCandidate(view.id);
        hook.usefulInstalled = view.hasDisplayedPresentation;
        presentationHooks.set(view, hook);
        view.publishImageCandidate = (pass: any, commit: () => void) => {
            if (disposed || !document || document !== viewer.pdfDocument || pageView(view.id) !== view) { return false; }
            captureNativeRaster(view);
            const projection = nativeProjection(view);
            if (!projection) { return false; }
            const identity = sourceIdentity(view.id, view.pdfPage);
            if (!identity) { return false; }
            const candidate: PdfPagePresentationCandidate = { document, page: identity, pageNumber: view.id,
                appearance: pass.appearance, rasterGeometry: pass.geometry, attempt: {}, successful: true, canvas: pass.canvas, projection,
                revision: pass.status?.revision ?? 0, coverage: Array.isArray(pass.status?.resources) && pass.intent
                    ? { kind: 'native', intent: pass.intent, discovered: !!pass.status.discovered, resources: pass.status.resources, untrackedImageOperations: pass.status.untrackedImageOperations }
                    : !document.hasExternalImages ? { kind: 'complete-page' } : { kind: 'unknown' } };
            return presentCandidate(candidate, () => {
                commit();
                previews.get(view.id)?.canvas.remove();
            });
        };
        hook.installed = view.publishImageCandidate;
    }
    const renderStarts = new Map<number, PdfRenderMeasurement>();
    const imageWatches = new Map<number, ImageWatch>();
    const imageRestarts = new Set<number>();
    const imageCancellations = new Map<any, Promise<void>>();
    const imageStarts = new Map<number, number>();
    let imagePaints = new WeakMap<object, { firstCoverageAt?: number; coverageLatencyMs?: number; finalAt?: number; passes: number }>();
    let imagePause = 0;
    let nativeRasters = new WeakMap<HTMLCanvasElement, NativeRaster>();
    let pageProjections = new WeakMap<object, PageProjectionCache>();
    const pendingRobotPages = new Set<number>();
    const deferredRobotPages = new Set<number>();
    let robotCapacityBlocked = false;
    let robotGeometry = '';
    let documentRobots: ReturnType<typeof installPdfDocumentRobots> | undefined;
    let documentColumn: ReturnType<typeof installPdfDocumentColumn> | undefined;
    let replacement: ReplacementIntent | undefined;
    let diagnostics: ReturnType<typeof installPrefetchDiagnostics> | undefined;
    let dispatchOrigin: RobotDispatchPort | undefined;
    let previewBinding: { source: PdfPreviewSource; document: any } | undefined;
    let previewLoader: ReturnType<typeof createPdfPreviewSourceLoader> | undefined;
    let previewAppearanceCompatible = true;
    let generation = 0;
    let document: any;
    let disposed = false;
    let robotPreferenceRevision = 0;
    let robotRestoreRevision = 0;
    const robotsPreference: ViewerBooleanPreference = options.robotsPreference ?? {
        read() {
            const value = win?.localStorage.getItem(ROBOTS_PREFERENCE_KEY);
            return value === 'true' ? true : value === 'false' ? false : undefined;
        },
        write(value) { win?.localStorage.setItem(ROBOTS_PREFERENCE_KEY, String(value)); },
    };
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
    const isReady = (id: number) => displayedCoverage(id) || !!previews.get(id)?.canvas.width && !!previews.get(id)?.canvas.height;
    const hidden = () => owner.visibilityState === 'hidden';
    const previewCompatible = () => previewAppearanceCompatible && !viewer.pageColors && !(globalThis as any).pdfjsViewerColorTheme;
    const nativeTarget = (id: number) => nativePages.includes(id) || renderAhead.includes(id);
    const imageCoverage = (status: any) => !status || status.discovered === true && status.covered === status.total && status.total >= 0;
    const paintedCoverage = (view: any) => !document?.hasExternalImages || !!view?.paintedImageStatus && imageCoverage(view.paintedImageStatus);
    const imagesPending = (view: any) => !!document?.hasExternalImages && !!view?.pdfPage?.imageStatus
        && (!view.pdfPage.imageStatus.discovered || view.pdfPage.imageStatus.pending > 0
            || (view.pdfPage.imageRevision ?? 0) > (view.imagePassRevision ?? view.paintedImageRevision ?? -1));
    const retainResources = (id: number) => policy.releaseRenderedResources
        ? nativeTarget(id) && (pageView(id)?.renderingState !== FINISHED || imagesPending(pageView(id))) : prepared.includes(id);

    function watchImages(id: number, page: any): void {
        if (!document?.hasExternalImages || !page?.onImageRevision) { return; }
        const previous = imageWatches.get(id);
        if (previous?.page === page) { return; }
        previous?.unsubscribe();
        const doc = document, epoch = generation;
        const entry: ImageWatch = { page, unsubscribe: () => {} };
        imageWatches.set(id, entry);
        entry.unsubscribe = page.onImageRevision(() => {
            if (disposed || document !== doc || generation !== epoch || imageWatches.get(id) !== entry) { return; }
            const status = page.imageStatus;
            if (status?.discovered && status.pending === 0 && status.failed > 0) { failed.add(id); }
            const identity = sourceIdentity(id, page);
            if (identity && documentRobots?.updateSource && Array.isArray(status?.resources) && status.intent) {
                documentRobots.updateSource(identity, { kind: 'native', intent: status.intent,
                    discovered: !!status.discovered, resources: status.resources, untrackedImageOperations: status.untrackedImageOperations });
            }
            pdfPerformance.event('image-progress', { page: id, revision: page.imageRevision ?? 0,
                covered: status?.covered ?? 0, total: status?.total ?? 0, pending: status?.pending ?? 0,
                failed: status?.failed ?? 0, final: !!status?.final, discovered: !!status?.discovered });
            if (!hidden() && !imagePause) { setIdle(false); schedule(); }
        });
    }

    function cancelImages(id: number, page: any): Promise<void> {
        imageStarts.delete(id);
        if (!document?.hasExternalImages || !page?.cancelImageRefinement
            || page.imageStatus?.final && pageView(id)?.paintedImageStatus?.final) { return Promise.resolve(); }
        imageRestarts.add(id);
        const previous = imageCancellations.get(page);
        if (previous) { return previous; }
        const epoch = generation;
        const stopped = Promise.resolve().then(() => page.cancelImageRefinement()).then(() => {}, error => {
            pdfPerformance.event('image-cancel-error', { page: id });
            throw error;
        }).finally(() => {
            if (imageCancellations.get(page) === stopped) { imageCancellations.delete(page); }
            if (!disposed && generation === epoch && !hidden()) {
                void sampleRangeCache(true, true);
                updateIdle();
                if (!imagePause && visible.includes(id)) { schedule(); }
            }
        });
        imageCancellations.set(page, stopped);
        return stopped;
    }

    function stopImages(): Promise<void> {
        const pages = new Map<number, any>();
        for (const [id, entry] of imageWatches) { pages.set(id, entry.page); }
        for (const id of new Set([...visible, ...prepared, ...warm.keys(), ...jobs.keys()])) {
            const page = pageView(id)?.pdfPage ?? warm.get(id)?.page ?? jobs.get(id)?.page;
            if (page) { pages.set(id, page); }
        }
        return Promise.all([...pages].map(([id, page]) => cancelImages(id, page))).then(() => {});
    }

    /** One admission lease for a prepared same-edition replacement, retaining displayed canvases. */
    async function pauseImageRefinement(): Promise<() => void> {
        const doc = document, epoch = generation;
        imagePause++;
        for (const job of jobs.values()) { cancel(job); }
        previewLoader?.update([], false);
        let released = false;
        const resume = () => {
            if (released) { return; }
            released = true;
            if (!disposed && document === doc && generation === epoch) { imagePause = Math.max(0, imagePause - 1); schedule(); }
        };
        try { await stopImages(); return resume; }
        catch (error) { resume(); throw error; }
    }

    function syncImages(): void {
        if (!document?.hasExternalImages) { return; }
        const keep = new Set(visible);
        for (const [id, entry] of imageWatches) {
            if (keep.has(id) && pageView(id)?.pdfPage === entry.page) { continue; }
            entry.unsubscribe(); imageWatches.delete(id);
            void cancelImages(id, entry.page).catch(() => {});
        }
        for (const id of visible) {
            const view = pageView(id), page = view?.pdfPage;
            watchImages(id, page);
            if (!page || imagePause || imageCancellations.has(page) || view.renderingState !== FINISHED) { continue; }
            if (imageRestarts.has(id) || (page.imageRevision ?? 0) > (view.imagePassRevision ?? view.paintedImageRevision ?? -1)) {
                view.redrawImages?.();
            }
        }
    }

    function recordImagePass(id: number, elapsed?: number): void {
        const view = pageView(id), status = view?.paintedImageStatus;
        if (!document?.hasExternalImages || !status) { return; }
        const previous = imagePaints.get(view) ?? { passes: 0 };
        const coverage = imageCoverage(status), firstCoverage = coverage && previous.firstCoverageAt === undefined;
        const firstFinal = !!status.final && previous.finalAt === undefined;
        if (firstCoverage) {
            previous.firstCoverageAt = now();
            const started = imageStarts.get(id);
            if (started !== undefined) {
                previous.coverageLatencyMs = Math.max(0, now() - started);
                dynamics.page(previous.coverageLatencyMs);
            }
            imageStarts.delete(id);
        }
        if (firstFinal) { previous.finalAt = now(); }
        previous.passes++;
        imagePaints.set(view, previous);
        pdfPerformance.event('image-pass', { page: id, revision: view.paintedImageRevision ?? 0,
            passRevision: view.imagePassRevision ?? view.paintedImageRevision ?? 0,
            covered: status.covered ?? 0, total: status.total ?? 0, pending: status.pending ?? 0,
            failed: status.failed ?? 0, final: !!status.final, firstCoverage, firstFinal, ms: elapsed ?? 0,
            coverageMs: previous.coverageLatencyMs ?? 0 });
    }

    function visibleRobotWork(): DocumentRobotWorkGroup[] {
        const groups = new Map<string, { key: string; pages: DocumentRobotWorkGroup['pages'][number][]; layoutPages: DocumentRobotWorkGroup['layoutPages'] }>();
        for (const id of visible) {
            const view = pageView(id);
            if (!view?.div) { continue; }
            const spread = view.div.closest?.('.spread') as HTMLElement | undefined;
            const members = spread ? [...spread.children].map(child => Number(child.getAttribute('data-page-number')))
                .filter(member => Number.isSafeInteger(member) && member > 0 && member <= viewer.pagesCount).sort((a, b) => a - b) : [];
            const key = (members.length ? members : [id]).join(',');
            let group = groups.get(key);
            if (!group) {
                // PDF.js owns one/two-page physical spreads; clipping either half must
                // not change the text domain of the loading episode for that spread.
                const layoutPages = documentRobotWorkMembers((members.length ? members : [id]).map(pageNumber => {
                    const member = pageView(pageNumber), label = member?.pageLabel ?? viewer._pageLabels?.[pageNumber - 1];
                    return { pageNumber, ...(typeof label === 'string' && label.length <= 128 ? { label } : {}) };
                }));
                groups.set(key, group = { key, pages: [], layoutPages });
            }
            const label = view.pageLabel ?? viewer._pageLabels?.[id - 1];
            group.pages.push({ pageNumber: id, pageElement: view.div,
                ...(typeof label === 'string' && label.length <= 128 ? { label } : {}),
                state: failed.has(id) || view.pdfPage?.imageStatus?.discovered && view.pdfPage.imageStatus.pending === 0
                    && view.pdfPage.imageStatus.failed > 0 ? 'failed' : displayedCoverage(id) ? 'ready'
                    : jobs.has(id) || previewLoader?.isPending(id) || [RUNNING, PAUSED].includes(view.renderingState) ? 'preparing' : 'waiting' });
        }
        return [...groups.values()];
    }

    function clearRobotPending(): void {
        pendingRobotPages.clear();
        deferredRobotPages.clear();
        robotCapacityBlocked = false;
        robotGeometry = '';
    }

    function updateRobotPages(): void {
        if (!documentRobots?.enabled) { return; }
        if (!visible.length && replacement?.captured) { return; }
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
        documentRobots.setVisibleWork(visibleRobotWork());
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
                    onReplacementComplete: finishReplacement,
                    documentOffset: () => documentColumn?.offsetX ?? 0,
                    documentSize: () => {
                        const current = viewer.currentPageNumber;
                        const id = visible.includes(current) ? current : visible[Math.floor(visible.length / 2)];
                        const view = pageView(id ?? current);
                        const content = cachedPageProjection(view)?.content ?? view?.viewport;
                        return content?.width > 0 && content.height > 0
                            ? { width: content.width, height: content.height } : undefined;
                    },
                    registerDocumentLayer: layer => documentColumn?.registerLayer(layer) ?? (() => {}),
                });
            }
            catch { pdfPerformance.event('document-robots-unavailable'); }
        }
        if (!enabled) { cancelReplacement(); clearRobotPending(); }
        documentRobots?.setEnabled(enabled);
        if (enabled && documentRobots) {
            documentRobots.setDispatchOrigin(dispatchOrigin);
            updateRobotPages();
            if (document) { schedule(); }
        }
    }

    function restoreDocumentRobotsPreference(): void {
        const revision = robotRestoreRevision;
        const apply = () => {
            if (disposed || revision !== robotRestoreRevision) { return; }
            let stored: boolean | undefined;
            try { stored = robotsPreference.read(); } catch { /* Storage may be unavailable. */ }
            setDocumentRobotsEnabled(options.robotsEnabled ?? (typeof stored === 'boolean' ? stored : true));
            diagnostics?.refreshRobotsEnabled?.();
        };
        if (robotsPreference.whenReady) {
            void Promise.resolve().then(() => robotsPreference.whenReady!()).then(apply, apply);
        } else { apply(); }
    }

    function setRequestedRobotsEnabled(enabled: boolean): void {
        if (disposed) { return; }
        ++robotRestoreRevision;
        const revision = ++robotPreferenceRevision;
        setDocumentRobotsEnabled(enabled);
        const write = () => {
            if (disposed || revision !== robotPreferenceRevision) { return; }
            try { void Promise.resolve(robotsPreference.write(enabled)).catch(() => {}); }
            catch { /* The current control remains usable without persistent storage. */ }
        };
        if (robotsPreference.whenReady) {
            void Promise.resolve().then(() => robotsPreference.whenReady!()).then(write, () => {});
        } else { write(); }
    }

    function captureNativeRaster(view: any): void {
        const canvas: HTMLCanvasElement | undefined = view?.canvas;
        const viewport = view?.viewport, output = view?.outputScale;
        if (!document || document !== viewer.pdfDocument || !canvas?.width || !canvas.height || !viewport || !output) { return; }
        try {
            const projection = createPdfRasterProjection(canvas.width, canvas.height, viewport.width * output.sx, viewport.height * output.sy);
            const rotation = viewport.rotation ?? 0;
            nativeRasters.set(canvas, { view, document, projection, rotation, currentProjection: projection, currentRotation: rotation });
            pageProjections.delete(view);
        } catch { /* A missing main-render extent must not relabel clipped pixels as a complete page. */ }
    }

    function nativeProjection(view: any): PdfRasterProjection | undefined {
        const canvas: HTMLCanvasElement | undefined = view?.canvas;
        const stored = canvas && nativeRasters.get(canvas);
        if (!stored || stored.view !== view || stored.document !== document
            || stored.projection.width !== canvas!.width || stored.projection.height !== canvas!.height) { return; }
        const rotation = view.viewport?.rotation ?? stored.rotation;
        if (rotation !== stored.currentRotation) {
            stored.currentProjection = reorientPdfRasterProjection(stored.projection, rotation - stored.rotation);
            stored.currentRotation = rotation;
        }
        return stored.currentProjection;
    }

    function cachedPageProjection(view: any, projection = nativeProjection(view)): PdfPageProjection | undefined {
        const cached = view && pageProjections.get(view);
        return cached && cached.hasCanvas === !!view.canvas && cached.viewport === view.viewport
            && cached.nativeProjection === projection && cached.transform === view.canvas?.style.transform ? cached.page : undefined;
    }

    function pageProjection(view: any): PdfPageProjection | undefined {
        if (!view?.div || !view.viewport) { return; }
        const canvas: HTMLCanvasElement | undefined = view.canvas ?? undefined;
        const projection = nativeProjection(view), viewport = view.viewport, transform = canvas?.style.transform;
        const cached = cachedPageProjection(view, projection);
        if (cached) { return cached; }
        const clip = { x: 0, y: 0, width: view.div.clientWidth, height: view.div.clientHeight };
        if (!(clip.width > 0 && clip.height > 0 && viewport.width > 0 && viewport.height > 0)) { return; }
        let page: PdfPageProjection = { content: { x: 0, y: 0, width: viewport.width, height: viewport.height }, clip };
        if (canvas && projection) {
            const box = view.div.getBoundingClientRect(), raster = canvas.getBoundingClientRect();
            // PDF.js can announce a main draw before attaching its backing. Keep the
            // ready preview, but leave this geometry uncached until the canvas is laid out.
            if (!(raster.width > 0 && raster.height > 0)) { return page; }
            // Absolute children start at the padding edge. Store local geometry so scrolling
            // and the shared document-column translation do not require another DOM read.
            page = pdfPageFromRaster(projection, {
                x: raster.left - box.left - view.div.clientLeft,
                y: raster.top - box.top - view.div.clientTop,
                width: raster.width, height: raster.height,
            }, clip);
        }
        pageProjections.set(view, { hasCanvas: !!canvas, viewport, nativeProjection: projection, transform, page });
        return page;
    }

    function pixels(id: number): DocumentRobotDelivery | undefined {
        const view = pageView(id);
        const displayed = displayedCandidate(id);
        if (!displayed) { return; }
        const preview = previews.get(id);
        const native = displayed.canvas !== preview?.canvas ? displayed.canvas : undefined;
        const canvas = displayed.canvas;
        const rasterProjection = displayedProjection(id, displayed);
        const displayedPage = pageProjection(view);
        if (!rasterProjection || !displayedPage) { return; }
        const page = previewLoader?.page(id);
        const imageRegions = page && previewCompatible() && previewGeometryMatches(page, view)
            ? rotatePdfPreviewImageRegions(page.imageRegions, viewer.pagesRotation || 0) : undefined;
        return { pageNumber: id, pageElement: view.div, canvas, kind: native ? 'page' : 'preview', imageRegions,
            contentRevision: displayed.revision,
            rasterProjection, pageProjection: displayedPage, displayRasterProjection: rasterProjection };
    }

    /** Each page can deliver its real pixels on first useful entry, including a ready cache hit. */
    function deliverPixels(id: number): void {
        retireMissingPresentation(id);
        const displayed = displayedCandidate(id);
        if (documentRobots?.reconcileEncounter && displayed) {
            const candidate = displayed;
            documentRobots.reconcileEncounter(candidate.page, encounter(id), candidate);
            return;
        }
        if (!documentRobots?.enabled || !pendingRobotPages.has(id) || !visible.includes(id)
            || robotCapacityBlocked || deferredRobotPages.has(id)
            || hidden() || !document || document !== viewer.pdfDocument) { return; }
        if (documentRobots.hasHandled(id)) { pendingRobotPages.delete(id); return; }
        try {
            const value = pixels(id);
            if (!value) { return; }
            // PDF.js can publish pixels before the scroll listener samples the new position.
            const result = documentRobots.offer(value, {
                moving: !layoutPending && (dynamics.direction !== 0 || position() !== lastPosition),
                axis: horizontal() ? 'x' : 'y',
            });
            if (result === 'busy') { robotCapacityBlocked = true; }
            else if (result === 'deferred') { deferredRobotPages.add(id); }
            else { pendingRobotPages.delete(id); }
        } catch {
            deferredRobotPages.add(id);
            pdfPerformance.event('document-robot-delivery-failed', { page: id });
        }
    }

    function publishPixels(id: number): void {
        retireMissingPresentation(id);
        const displayed = displayedCandidate(id);
        if (documentRobots?.updateSource && displayed) {
            const candidate = displayed;
            documentRobots.updateSource(candidate.page, candidate.coverage);
            if (visible.includes(id)) { documentRobots.reconcileEncounter(candidate.page, encounter(id), candidate); }
            return;
        }
        if (documentRobots?.enabled && visible.includes(id) && !hidden() && document && document === viewer.pdfDocument) {
            try {
                const value = pixels(id);
                if (value) {
                    const count = documentRobots.refine(value);
                    if (count) { pdfPerformance.event('document-robot-refine', { page: id, count }); }
                }
            } catch { pdfPerformance.event('document-robot-refinement-failed', { page: id }); }
        }
        deliverPixels(id);
    }

    function finishReplacement(identity: string): void {
        if (!replacement?.captured || replacement.identity !== identity) { return; }
        replacement.signal?.removeEventListener('abort', replacement.cancel);
        replacement = undefined;
    }

    function cancelReplacement(): void { replacement?.cancel(); }

    /** Arm a validated edition commit. No pixels or scene state change before pagesdestroy. */
    function prepareReplacement(identity: string, signal?: AbortSignal): () => void {
        cancelReplacement();
        if (disposed || !document || document !== viewer.pdfDocument || signal?.aborted
            || typeof identity !== 'string' || !identity || identity.length > 2048) { return () => {}; }
        const intent: ReplacementIntent = { identity, document, generation, captured: false, signal, cancel() {
            if (replacement !== intent) { return; }
            replacement = undefined;
            intent.signal?.removeEventListener('abort', intent.cancel);
            intent.document = undefined;
            if (intent.captured) { documentRobots?.cancelReplacement(intent.identity); }
        } };
        replacement = intent;
        signal?.addEventListener('abort', intent.cancel, { once: true });
        return intent.cancel;
    }

    function readerInteraction(event: Event): void {
        if (event.type === 'keydown' && diagnostics?.ownsEvent(event)) { return; }
        if (event.isTrusted) { cancelReplacement(); documentRobots?.cancelColumnMotion(); }
    }

    function columnTransition(motion: Readonly<PdfDocumentColumnTransition> | undefined): void {
        if (disposed) { return; }
        if (motion) { cancelReplacement(); }
        documentRobots?.setColumnTransition(motion);
    }

    function destroyDocument(): void {
        const intent = replacement;
        const capture = !!intent && !intent.captured && intent.document === document && intent.generation === generation
            && !intent.signal?.aborted && !disposed && !hidden();
        if (capture) {
            intent.captured = true;
            intent.document = undefined;
            try {
                const ids: number[] = viewer._getVisiblePages()?.views?.map((entry: any) => entry.id) ?? visible;
                const values = ids.map(pixels).filter((value): value is DocumentRobotDelivery => !!value);
                if (documentRobots?.enabled) { documentRobots.retireDocument(values, intent.identity); }
                else { finishReplacement(intent.identity); }
            } catch {
                cancelReplacement(); documentRobots?.reset();
                pdfPerformance.event('document-robot-replacement-failed');
            }
        }
        clearDocument(capture);
    }

    function setIdle(next: boolean) {
        if (idle === next) { return; }
        idle = next;
        options.onIdleChange?.(next);
    }

    const previousLoadingHook = viewer.getPageLoadingState;
    const previousLoadingDescriptor = Object.getOwnPropertyDescriptor(viewer, 'getPageLoadingState');
    const loadingStates = new Map<number, boolean>();
    const getPageLoadingState = (id: number): boolean | undefined => {
        if (disposed || !document || document !== viewer.pdfDocument) { return; }
        const view = pageView(id);
        if (!view || !Number.isInteger(id) || id < 1 || id > viewer.pagesCount) { return; }
        const status = view.pdfPage?.imageStatus;
        return jobs.has(id) || !!previewLoader?.isPending(id) || imageRestarts.has(id) || imageCancellations.has(view.pdfPage)
            || [0, RUNNING, PAUSED].includes(view.renderingState)
            || !!document.hasExternalImages && (!status?.discovered || status.pending > 0
                || (view.pdfPage?.imageRevision ?? 0) > (view.imagePassRevision ?? -1));
    };
    viewer.getPageLoadingState = getPageLoadingState;
    function publishLoadingStates() {
        for (const id of new Set([...loadingStates.keys(), ...nativePages])) {
            const next = getPageLoadingState(id);
            if (next === undefined) { loadingStates.delete(id); continue; }
            if (loadingStates.get(id) === next) { continue; }
            loadingStates.set(id, next);
            viewer.eventBus.dispatch?.('pageloadingstatechanged', { source: viewer, pageNumber: id });
        }
    }

    function updateIdle() {
        publishLoadingStates();
        setIdle(!disposed && !!document && document === viewer.pdfDocument && !hidden()
            && !memoryAdmissionBlocked() && !workerBytesBusy()
            && !previewLoader?.snapshot().pending && previewLoader?.snapshot().state !== 'loading'
            && dynamics.direction === 0 && jobs.size === 0 && pdfPerformance.pendingFetchCount === 0
            && !imagePause && !imageCancellations.size && visible.every(id => !imagesPending(pageView(id)))
            && visible.length > 0 && visible.every(id => displayedCoverage(id) || failed.has(id))
            && [...nativePages, ...renderAhead].every(id => ![RUNNING, PAUSED].includes(pageView(id)?.renderingState)));
    }

    function updatePreviewSource(): void {
        const active = !disposed && !hidden() && !imagePause && !!document && document === viewer.pdfDocument && previewCompatible();
        previewLoader?.update([...new Set([...nativePages, ...prepared])].map(pageNumber => ({
            pageNumber, visible: nativePages.includes(pageNumber), maxDimension: limits.previewMaxDimension, rotation: viewer.pagesRotation || 0,
        })), active);
    }

    function previewGeometryMatches(page: { width: number; height: number; rotation: number }, view: any): boolean {
        if (!view?.pdfPage) { return true; }
        const intrinsic = ((view.pdfPage.rotate || 0) % 360 + 360) % 360;
        const natural = view.pdfPage.getViewport({ scale: 1, rotation: intrinsic });
        return intrinsic === page.rotation && Math.abs(natural.width - page.width) <= 1 && Math.abs(natural.height - page.height) <= 1;
    }

    function attachPreviewSource(): void {
        previewLoader?.dispose();
        previewLoader = undefined;
        const binding = previewBinding;
        if (!binding || binding.document !== document || document !== viewer.pdfDocument || disposed) { return; }
        const current = () => !disposed && previewBinding === binding && document === binding.document && document === viewer.pdfDocument;
        try {
            previewLoader = (options.createPreviewSourceLoader ?? createPdfPreviewSourceLoader)(binding.source, {
                pageCount: viewer.pagesCount,
                ...pdfSidecarDecodeOptions(policy),
                createCanvas,
                quality: id => document?.hasExternalImages || displayedNativeCoverage(id) ? Infinity
                    : Math.max(previews.get(id)?.canvas.width ?? 0, previews.get(id)?.canvas.height ?? 0),
                onPreview(page, canvas, projection) {
                    const release = () => { canvas.remove(); canvas.width = canvas.height = 0; return false; };
                    if (!current() || hidden() || layoutPending || !previewCompatible()) { return release(); }
                    const view = pageView(page.pageNumber);
                    if (!view || displayedNativeCoverage(page.pageNumber)) { return release(); }
                    // A trusted identity still needs the same page geometry before pixels are attached.
                    if (!previewGeometryMatches(page, view)) { return release(); }
                    const retained = retainPreview(page.pageNumber, canvas, projection, 0, true);
                    if (retained) { pdfPerformance.event('preview-ready', { page: page.pageNumber, sidecar: true }); }
                    return retained;
                },
                onChange() {
                    if (current() && !hidden()) {
                        const state = previewLoader?.snapshot();
                        if (state?.pending || state?.state === 'loading') { setIdle(false); }
                        schedule();
                    }
                },
                onEvent(type, data) { if (current()) { pdfPerformance.event('sidecar-' + type, data); } },
            });
            updatePreviewSource();
            schedule();
        } catch { pdfPerformance.event('sidecar-unavailable'); }
    }

    /** Root adapters supply a trusted source only for the exact installed PDFDocumentProxy. */
    function setPreviewSource(source: PdfPreviewSource | undefined, pdfDocument: any): void {
        if (disposed || !pdfDocument || pdfDocument !== viewer.pdfDocument) { return; }
        if (previewBinding && previewBinding.source === source && previewBinding.document === pdfDocument) { return; }
        previewLoader?.dispose(); previewLoader = undefined;
        previewBinding = source ? { source, document: pdfDocument } : undefined;
        if (pdfDocument === document) { attachPreviewSource(); }
        schedule();
    }

    function memoryBackpressure() {
        return (rangeCache?.residentBytes ?? 0) > policy.rangeCacheBytes;
    }

    function memoryAdmissionBlocked() {
        return memoryBackpressure() || rangeFreshRequired || !!rangeRead?.trim;
    }

    function workerBytesBusy() {
        return (rangeCache?.activeOperations ?? 0) > 0 || (rangeCache?.pendingRequests ?? 0) > 0
            || (rangeCache?.externalImageActive ?? 0) > 0 || (rangeCache?.externalImageQueued ?? 0) > 0
            || (rangeCache?.externalImagePaused ?? 0) > 0;
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
            && (memoryBackpressure() || workerBytesBusy() || jobs.size > 0 || nativeWorking
                || visible.some(id => imagesPending(pageView(id))));
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

    function canStartColdPage(id: number): boolean {
        if (fetchBackpressure() || memoryAdmissionBlocked()) { return false; }
        if (policy.name === 'mobile' && dynamics.direction !== 0 && !layoutPending
            && previewCompatible() && visible.includes(id)) {
            const view = pageView(id), preview = previews.get(id)?.canvas;
            // showPreviews runs before native selection and pump. Only a preview already
            // placed on this visible page can defer its cold PDF decoding during motion.
            // Cached but detached pixels leave native fallback available. The existing
            // gesture settle or layout reset wakes refinement without another timer.
            if (preview && preview.width > 0 && preview.height > 0 && preview.parentNode === view?.div) { return false; }
        }
        return true;
    }

    function canRender(view: any) {
        if (imagePause || imageCancellations.has(view?.pdfPage)) { return false; }
        // Structural page commands and text are small; photograph admission belongs to the worker.
        // Start native display directly, and leave offscreen image work unstarted.
        if (document?.hasExternalImages) { return visible.includes(view?.id); }
        // Resuming an admitted render or using fully prepared resources adds no cold page.
        // A cancelled RenderTask can leave its worker's image requests running, so the
        // bridge's actual outstanding transfers, not render promises, govern admission.
        const job = jobs.get(view?.id);
        return view?.renderingState === RUNNING || view?.renderingState === PAUSED
            || resourcesWarm(view?.id) || !!job?.task && !job.cancelled
            || jobs.size < limits.maxConcurrentPrepares && canStartColdPage(view?.id);
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
        const { imageDecodeScale, imageDecodeMaxDimension } = nativePdfImageContext(page, pageView(id),
            viewer.pagesRotation || 0, win?.devicePixelRatio || 1);
        return { imageDecodeScale, imageDecodeMaxDimension };
    }

    function markWarm(id: number, page: any, hints?: ImageDecodeHints) {
        if (page._intentStates?.size !== 0) {
            const view = pageView(id);
            const native = view?.pdfPage === page;
            if (policy.releaseRenderedResources && native && view.renderingState === FINISHED && !jobs.has(id) && !imagesPending(view)) {
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

    function listen(target: EventTarget, name: string, handler: EventListener, passive = true, capture = false) {
        target.addEventListener(name, handler, { passive, capture });
        listeners.push(() => target.removeEventListener(name, handler, capture));
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
        // A stationary partial view can become eligible without changing geometry.
        deferredRobotPages.clear();
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
        readerInteraction(event);
        if (event.ctrlKey || event.metaKey || hidden()) { return; }
        const raw = horizontal() ? (event.deltaX || event.deltaY) * (rtl() ? -1 : 1) : event.deltaY;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportSize() : 1;
        lastWheelAt = now();
        motion(raw * unit);
    }

    function cancel(job: Preparation) {
        if (job.cancelled) { return; }
        job.cancelled = true;
        job.measurement?.cancel();
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

    function retainPreview(id: number, canvas: HTMLCanvasElement, projection: PdfRasterProjection, contentRevision = 0, verifiedAtlas = false, sourcePresentation?: PdfPagePresentationCandidate, sourcePage?: object) {
        const view = pageView(id), prior = presentations.get(id)?.current();
        const identity = view && sourceIdentity(id, sourcePage ?? view.pdfPage);
        const candidate: PdfPagePresentationCandidate | undefined = document && view && identity ? {
            document, page: identity, pageNumber: id, appearance: verifiedAtlas ? logicalAppearance(view) : prior?.appearance ?? logicalAppearance(view),
            attempt: {}, successful: true, canvas, projection, revision: contentRevision,
            coverage: sourcePresentation?.coverage ?? (prior && prior.canvas === view.canvas ? prior.coverage
                : verifiedAtlas || !document.hasExternalImages ? { kind: 'complete-page' } : { kind: 'unknown' }),
        } : undefined;
        const retained = previews.retain(id, canvas, new Set([...visible, ...prepared]), projection, contentRevision, candidate);
        if (retained) {
            declinedPreviews.delete(id);
            // Coverage is useful immediately, even while this job still holds its cold slot for worker trimming.
            if (!displayedCandidate(id) || displayedCandidate(id)?.canvas === canvas) { attachPreview(id); }
            publishPixels(id);
        }
        else { declinedPreviews.add(id); }
        return retained;
    }

    function copyRendered(id: number) {
        const view = pageView(id);
        const displayed = displayedCandidate(id);
        const source = displayed?.coverage.kind === 'native' || !document?.hasExternalImages ? displayed?.canvas : undefined;
        if (!source || !displayedCoverage(id)) { return; }
        if (view.pdfPage) { markWarm(id, view.pdfPage); }
        if (declinedPreviews.has(id) || !source?.width || !source?.height) { return; }
        // Both entries install before drawing. If an existing canvas predates installation,
        // its private original viewport is unknown; wait for a captured main draw or keep a known preview.
        const projection = displayedProjection(id, displayed!);
        const dimension = Math.min(limits.previewMaxDimension, Math.max(source.width, source.height));
        const ratio = dimension / Math.max(source.width, source.height);
        const width = Math.max(1, Math.ceil(source.width * ratio));
        const height = Math.max(1, Math.ceil(source.height * ratio));
        const entry = previews.get(id), previous = entry?.canvas;
        const contentRevision = displayed!.revision;
        // Same-page sidecars round their scaled axes; native snapshots ceil them. Keep
        // the requested longest-edge quality without copying again for that one pixel.
        if (previous && (Math.max(previous.width, previous.height) >= dimension && contentRevision <= (entry?.contentRevision ?? 0)
            && previous.width + 1 >= width && previous.height + 1 >= height
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
        return retainPreview(id, canvas, resizePdfRasterProjection(projection, canvas.width, canvas.height), contentRevision, false, displayed);
    }

    function attachPreview(id: number): void {
        const entry = previews.get(id);
        if (!entry) { return; }
        const view = pageView(id);
        if (!visible.includes(id) || !view) { entry.canvas.remove(); return; }
        const displayed = displayedCandidate(id);
        if (displayed && displayed.canvas !== entry.canvas) { return; }
        // A pre-install finished native backing has no verified raster projection. Do
        // not invent coverage or overlay it with a cached raster under another grid.
        if (!displayed && view.renderingState === FINISHED && view.canvas?.isConnected
            && view.div.contains(view.canvas) && view.canvas.width > 0 && view.canvas.height > 0) { return; }
        const canvas = entry.canvas;
        const page = pageProjection(view);
        const clip = page && pdfRasterPageClip(entry.projection, page);
        if (!page || !clip) { canvas.remove(); return; }
        const matrix = pdfRasterToCss(entry.projection, page);
        const sx = entry.projection.width / page.clip.width, sy = entry.projection.height / page.clip.height;
        const styles = {
            position: 'absolute', inset: 'auto', left: '0px', top: '0px', width: page.clip.width + 'px', height: page.clip.height + 'px',
            pointerEvents: 'none', zIndex: '0', transformOrigin: '0 0',
            // Keep the untransformed CSS box within the page even for high-DPR backings.
            transform: `matrix(${[matrix[0] * sx, matrix[1] * sx, matrix[2] * sy, matrix[3] * sy, matrix[4], matrix[5]].join(',')})`,
            clipPath: `inset(${Math.max(0, clip.y / entry.projection.height * 100)}% ${Math.max(0, (entry.projection.width - clip.x - clip.width) / entry.projection.width * 100)}% ${Math.max(0, (entry.projection.height - clip.y - clip.height) / entry.projection.height * 100)}% ${Math.max(0, clip.x / entry.projection.width * 100)}%)`,
        };
        for (const name of Object.keys(styles) as (keyof typeof styles)[]) {
            if (canvas.style[name] !== styles[name]) { canvas.style[name] = styles[name]; }
        }
        if (canvas.parentNode !== view.div) {
            canvas.className = 'pdfPrefetchPreview';
            canvas.setAttribute('aria-hidden', 'true');
            const commit = () => { view.div.prepend(canvas); };
            if (entry.candidate) { presentCandidate(entry.candidate, commit); }
            else if (!presentations.get(id)?.current()) { commit(); }
        }
    }

    function showPreviews() {
        for (const id of previews.keys()) { attachPreview(id); }
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
        documentColumn?.update(layoutPending);
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
    function logicalAppearance(view: any): string {
        return JSON.stringify([generation, appearanceEpoch, view.id, viewer.pagesRotation || 0, viewer.pageColors]);
    }

    function render(view: any) {
        if (view) { view.imageAppearance = logicalAppearance(view); }
        if (view?.id && view === pageView(view.id)) { installPresentationHook(view); }
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
            if (!document.hasExternalImages && isPage && view.renderingState !== RUNNING && view.renderingState !== PAUSED
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
        return visible.some(id => !displayedCoverage(id) && !failed.has(id));
    }

    function releaseColdPages() {
        const cached = viewer.getCachedPageViews?.() ?? new Set();
        for (const [id, entry] of warm) {
            if (entry.native && pageView(id)?.pdfPage !== entry.page) { warm.delete(id); continue; }
            const view = pageView(id);
            if (retainResources(id) || jobs.has(id)
                || cached.has(view) && !(policy.releaseRenderedResources && view.renderingState === FINISHED)) { continue; }
            entry.page.cleanup();
            warm.delete(id);
        }
        const keep = new Set([...nativePages, ...renderAhead]);
        let bytes = canvasBytes();
        for (const view of cached) {
            if (keep.has(view.id) || jobs.has(view.id)) { continue; }
            if (view.renderingState === RUNNING || view.renderingState === PAUSED) {
                renderStarts.get(view.id)?.cancel(); renderStarts.delete(view.id);
                view.reset();
            }
            if (bytes > limits.maxCanvasBytes || policy.pruneOffscreen && (view.canvas || view.pdfPage?._intentStates?.size)) {
                copyRendered(view.id);
                const released = (view.canvas?.width || 0) * (view.canvas?.height || 0) * RGBA_BYTES;
                view.destroy();
                retireMissingPresentation(view.id);
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
        jobs.set(id, job);
        job.measurement = renderTimings.start(() => current(job) && !hidden() && doc === document);
        maintainRangeChecks();
        try {
            const page = knownPage ?? await doc.getPage(id);
            if (!current(job)) { return; }
            job.page = page;
            if (!prepared.includes(id)) { return; }
            if (pageView(id)?.renderingState === FINISHED
                || policy.releaseRenderedResources && previews.has(id) && !nativeTarget(id)) { return; }
            if (!visible.includes(id) && visibleUncovered()) { return; }
            if (!resourcesWarm(id) && !canStartColdPage(id)) { return; }
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
            const elapsed = job.measurement.finish();
            const retained = retainPreview(id, canvas, createPdfRasterProjection(canvas.width, canvas.height, viewport.width, viewport.height), 0, false, undefined, page);
            job.canvas = undefined;
            if (elapsed !== undefined) { dynamics.page(elapsed); }
            if (retained) { pdfPerformance.event('preview-ready', { page: id, ms: elapsed ?? 0 }); }
        } catch (error) {
            if (current(job) && (error as Error)?.name !== 'RenderingCancelledException') {
                failed.add(id);
                pdfPerformance.event('prepare-failed', { page: id });
            }
        } finally {
            job.measurement?.cancel();
            if (job.canvas) { job.canvas.width = job.canvas.height = 0; }
            if (job.page && doc === document && !retainResources(id)
                && (policy.releaseRenderedResources || !(viewer.getCachedPageViews?.() ?? new Set()).has(pageView(id)))) {
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
        if (!document || hidden() || imagePause || document.hasExternalImages) { return; }
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
                || previews.has(id) && (resourcesWarm(id) || policy.releaseRenderedResources && !nativeTarget(id))) { continue; }
            // render() begins worker-side operator/image processing before onContinue. Keep
            // that CPU and fetch capacity for an uncovered viewport; covered motion can fill
            // the speculative horizon continuously while native resolution catches up.
            if (!visible.includes(id) && visibleUncovered()) { continue; }
            if (!resourcesWarm(id) && !canStartColdPage(id)) { continue; }
            if (jobs.size >= limits.maxConcurrentPrepares) { break; }
            void prepare(id);
        }
    }

    function refresh() {
        if (disposed || !document || document !== viewer.pdfDocument || hidden()) { return; }
        void sampleRangeCache();
        plan(viewer._getVisiblePages());
        for (const id of presentations.keys()) { retireMissingPresentation(id); }
        // updateviewarea can schedule this frame before the scroll event arrives. Only a
        // layout correction may reset the baseline; otherwise that would erase real motion.
        if (layoutPending) { lastPosition = position(); }
        layoutPending = false;
        updatePreviewSource();
        syncImages();
        releaseColdPages();
        showPreviews();
        // update() protects visible pages in PDF.js's private LRU before it picks more work.
        // Ignore its synchronous updateviewarea notification to avoid a self-sustaining RAF.
        refreshing = true;
        try { viewer.update(); } finally { refreshing = false; }
        pump();
        updateRobotPages();
        updateIdle();
    }

    function clearDocument(preserveReplacement = false) {
        for (const [view, hook] of presentationHooks) {
            if (view.hasDisplayedPresentation === hook.usefulInstalled) {
                if (hook.usefulPrevious === undefined) { delete view.hasDisplayedPresentation; }
                else { view.hasDisplayedPresentation = hook.usefulPrevious; }
            }
            if (view.publishImageCandidate === hook.installed) {
                if (hook.previous === undefined) { delete view.publishImageCandidate; }
                else { view.publishImageCandidate = hook.previous; }
            }
        }
        loadingStates.clear();
        presentationHooks.clear();
        presentations.clear();
        sourcePages.clear();
        setIdle(false);
        renderTimings.invalidate();
        clearRobotPending();
        if (!preserveReplacement) { cancelReplacement(); documentRobots?.reset(); }
        previewLoader?.dispose(); previewLoader = undefined; previewBinding = undefined;
        previewAppearanceCompatible = true;
        for (const entry of imageWatches.values()) { entry.unsubscribe(); }
        void stopImages().catch(() => {});
        imageWatches.clear(); imageRestarts.clear(); imageCancellations.clear();
        imageStarts.clear(); imagePaints = new WeakMap(); imagePause = 0;
        stopRangeChecks();
        generation++;
        document = undefined;
        for (const job of jobs.values()) { cancel(job); }
        jobs.clear();
        warm.clear();
        nativeRasters = new WeakMap();
        pageProjections = new WeakMap();
        clearPreviews();
        failed.clear();
        renderStarts.clear();
        visible = nativePages = renderAhead = prepared = [];
        documentColumn?.update();
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
        const binding = previewBinding?.document === viewer.pdfDocument ? previewBinding : undefined;
        clearDocument(!!replacement?.captured);
        document = viewer.pdfDocument;
        previewBinding = binding;
        if (binding) { attachPreviewSource(); }
        rangeFreshRequired = !!document?.getRangeCacheStats;
        void sampleRangeCache(false, true);
        lastPosition = position();
        pdfPerformance.event('document', { pages: viewer.pagesCount });
        schedule();
    }

    function layout(invalidate = false) {
        if (invalidate) {
            appearanceEpoch++;
            if (documentRobots?.removePage) {
                for (const id of visible) {
                    const page = sourcePages.get(id)?.identity;
                    if (page) { documentRobots.removePage(page, 'appearance', false, pageView(id)?.div); }
                }
            } else { documentRobots?.setVisiblePages([]); }
        }
        stop();
        pageProjections = new WeakMap();
        renderTimings.invalidate(); renderStarts.clear();
        previewLoader?.update([], false);
        clearRobotPending();
        // Layout changes retain source-page ownership; the next geometry reconciliation
        // updates normalized targets without pretending the pages were removed.
        layoutPending = true;
        signature = '';
        lastPosition = position();
        for (const job of jobs.values()) { cancel(job); }
        if (invalidate) { clearPreviews(); }
        void stopImages().catch(() => {});
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
        const visibleMissing = visible.filter(id => !displayedCoverage(id) && !failed.has(id));
        return {
            ...sample, cachePolicy: policy.name, cacheLimits: limits, idle: !!idle,
            rangeCache: rangeCache ? { ...rangeCache } : undefined,
            previewSource: previewLoader?.snapshot(),
            imagePages: document?.hasExternalImages ? visible.map(id => {
                const view = pageView(id);
                return { page: id, revision: view?.pdfPage?.imageRevision ?? 0, status: view?.pdfPage?.imageStatus,
                    paintedRevision: view?.paintedImageRevision ?? -1, paintedStatus: view?.paintedImageStatus,
                    passRevision: view?.imagePassRevision ?? -1, passStatus: view?.imagePassStatus,
                    ...imagePaints.get(view) };
            }) : undefined,
            decodedImages: decodedImages(),
            robots: documentRobots?.snapshot(),
            documentColumn: documentColumn ? { offsetX: documentColumn.offsetX, transition: documentColumn.transition } : undefined,
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
    bus('pagesdestroy', destroyDocument);
    bus('updateviewarea', () => { if (!refreshing) { schedule(); } });
    for (const name of ['scalechanging', 'scrollmodechanged', 'spreadmodechanged']) { bus(name, () => layout()); }
    for (const name of ['rotationchanging', 'prefetchthemechanged']) { bus(name, () => layout(true)); }
    bus('optionalcontentconfigchanged', () => { previewAppearanceCompatible = false; updatePreviewSource(); layout(true); });
    bus('pagerender', ({ pageNumber, isDetailView, source }: { pageNumber: number; isDetailView?: boolean; source?: any }) => {
        if (isDetailView) { return; }
        setIdle(false);
        renderStarts.get(pageNumber)?.cancel();
        const doc = document, view = pageView(pageNumber);
        watchImages(pageNumber, view?.pdfPage);
        if (doc?.hasExternalImages && imagePaints.get(view)?.firstCoverageAt === undefined && !imageStarts.has(pageNumber)) {
            imageStarts.set(pageNumber, now());
        }
        imageRestarts.delete(pageNumber);
        if (source === view) { view.imageAppearance = logicalAppearance(view); installPresentationHook(view); captureNativeRaster(view); }
        renderStarts.set(pageNumber, renderTimings.start(() => !disposed && !hidden()
            && !!doc && doc === document && doc === viewer.pdfDocument && view === pageView(pageNumber)
            && [RUNNING, PAUSED].includes(view?.renderingState)));
        if (doc && doc === viewer.pdfDocument && view?.div) {
            documentRobots?.restoreArrivals(pageNumber, view.div);
        }
        updateRobotPages();
        maintainRangeChecks();
        // setPdfPage/reset removed our earlier child; restore it before the first native paint.
        showPreviews();
    });
    bus('pagerendered', ({ pageNumber, error, cssTransform, isDetailView }: any) => {
        if (!document || isDetailView) { return; }
        const measurement = renderStarts.get(pageNumber);
        renderStarts.delete(pageNumber);
        let elapsed: number | undefined;
        if (error || cssTransform) { measurement?.cancel(); }
        else { elapsed = measurement?.finish(); }
        if (error) { failed.add(pageNumber); imageStarts.delete(pageNumber); }
        else {
            if (elapsed !== undefined && !document.hasExternalImages) { dynamics.page(elapsed); }
            const page = pageView(pageNumber)?.pdfPage;
            watchImages(pageNumber, page);
            if (!cssTransform) { recordImagePass(pageNumber, elapsed); }
            if (page) { markWarm(pageNumber, page); }
            if (!copyRendered(pageNumber)) { publishPixels(pageNumber); }
        }
        pdfPerformance.event('page-render', { page: pageNumber, ms: elapsed ?? 0, error: !!error });
        void sampleRangeCache(true, true);
        maintainRangeChecks();
        schedule();
    });
    listen(container, 'scroll', onScroll);
    listen(container, 'wheel', onWheel as EventListener, true, true);
    listen(container, 'pointerdown', readerInteraction, true, true);
    listen(container, 'touchstart', readerInteraction, true, true);
    listen(owner, 'keydown', readerInteraction, true, true);
    listen(container, 'scrollend', settle);
    if (visualViewport) {
        listen(visualViewport, 'scroll', scheduleRobotUpdate);
        listen(visualViewport, 'resize', scheduleRobotUpdate);
    }
    listen(owner, 'visibilitychange', () => {
        if (hidden()) {
            setIdle(false);
            cancelReplacement();
            renderTimings.invalidate(); renderStarts.clear();
            clearRobotPending();
            documentRobots?.setVisiblePages([]);
            previewLoader?.update([], false);
            stopRangeChecks();
            rangeFreshRequired = !!document?.getRangeCacheStats;
            for (const job of jobs.values()) { cancel(job); }
            void stopImages().catch(() => {});
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
    documentColumn = (options.createDocumentColumn ?? installPdfDocumentColumn)(container, {
        pages: () => visible.map(id => pageView(id)?.div).filter((page): page is HTMLElement => !!page),
        onTransition: columnTransition, now, requestFrame, cancelFrame,
    });
    diagnostics = installPrefetchDiagnostics(container, snapshot, {
        toolbar: options.diagnosticsToolbar,
        toolbarBefore: options.diagnosticsToolbarBefore,
        measurementsMenu: options.diagnosticsMenu,
        measurementsPreference: options.measurementsPreference,
        onOpen: options.onDiagnosticsOpen,
        onPanelLayout: layout => {
            if (disposed) { return; }
            documentColumn?.setPanel(layout);
            const column = documentColumn;
            if (column && !column.ready) {
                return {
                    get readyAt() { return disposed ? 0 : column.readyAt; },
                    isReady: () => disposed || column.ready,
                };
            }
        },
        enabled: options.diagnosticsEnabled,
        robots: {
            get enabled() { return documentRobots?.enabled ?? false; },
            setEnabled: setRequestedRobotsEnabled,
            setDispatchOrigin(port) { dispatchOrigin = port; documentRobots?.setDispatchOrigin(port); },
        },
    });
    const stopRobotPreference = robotsPreference.onDidChange?.(enabled => {
        if (disposed) { return; }
        ++robotRestoreRevision;
        setDocumentRobotsEnabled(enabled);
        diagnostics?.refreshRobotsEnabled?.();
    });
    restoreDocumentRobotsPreference();
    if (viewer.pdfDocument) { activate(); }
    if (options.previewSource && viewer.pdfDocument) { setPreviewSource(options.previewSource, viewer.pdfDocument); }

    return {
        snapshot,
        setPreviewSource,
        prepareReplacement,
        pauseImageRefinement,
        toggleDiagnostics: () => diagnostics!.toggle(),
        setDiagnosticsEnabled: (enabled: boolean) => diagnostics!.setEnabled(enabled),
        get diagnosticsEnabled() { return diagnostics!.enabled; },
        setRobotsEnabled: (enabled: boolean) => diagnostics!.setRobotsEnabled(enabled),
        get robotsEnabled() { return documentRobots?.enabled ?? false; },
        dispose() {
            if (disposed) { return; }
        if (viewer.getPageLoadingState === getPageLoadingState) {
            if (previousLoadingDescriptor) { Object.defineProperty(viewer, 'getPageLoadingState', previousLoadingDescriptor); }
            else if (previousLoadingHook === undefined) { delete viewer.getPageLoadingState; }
            else { viewer.getPageLoadingState = previousLoadingHook; }
        }
            disposed = true;
            stopRobotPreference?.();
            clearDocument();
            renderTimings.dispose();
            if (frame !== undefined) { cancelFrame(frame); }
            listeners.forEach(remove => remove());
            diagnostics!.dispose();
            documentRobots?.dispose();
            documentColumn?.dispose();
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
