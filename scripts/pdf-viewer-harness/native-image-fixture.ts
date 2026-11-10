import { EventBus, PDFViewer, PDFLinkService } from '../../node_modules/pdfjs-dist/web/pdf_viewer.mjs';
import '../../node_modules/pdfjs-dist/web/pdf_viewer.css';
import { installPdfPrefetch } from '../../views/pdf-viewer/src/common/pdf-prefetch';
import { pdfDocumentCacheOptions } from '../../views/pdf-viewer/src/common/scroll-prefetch';

const pdfjs = (globalThis as any).pdfjsLib;
const data = await (await fetch('/ext/native-image-data.json')).json();
const encoded = Uint8Array.from(atob(data.progressive), char => char.charCodeAt(0));
const structural = new Uint8Array(await (await fetch('/ext/native-image.pdf')).arrayBuffer());
const container = document.querySelector<HTMLElement>('#viewerContainer')!;
const bus = new EventBus(), link = new PDFLinkService({ eventBus: bus });
const viewer = new PDFViewer({ container, viewer: document.querySelector('#viewer'), eventBus: bus,
    linkService: link, textLayerMode: 1, annotationMode: 1, enableDetailCanvas: false });
link.setViewer(viewer);
// The real application chooses its initial scale during initial-view setup, before the
// rendering queue paints. A post-first-draw scale setter would create a genuine new intent.
bus.on('pagesinit', () => { viewer.currentScale = 1; });
const gates = new Map<string, ReturnType<typeof deferred>>();
let task: any, controller: ReturnType<typeof installPdfPrefetch> | undefined;
let samples: any[] = [], paints: any[] = [], reads: any[] = [], errors: string[] = [];
let observing = false, step = '', branch = '', paintWaiters: { after: number; resolve(value: any): void }[] = [];
let armedFailure = false;
let renderRecords: any[] = [], tokenSerial = 1;
let controls: any[] = [];
const tokens = new WeakMap<object, number>();
function token(value: object | undefined) { if (!value) return null; if (!tokens.has(value)) tokens.set(value, tokenSerial++); return tokens.get(value); }
function deferred() {
    let resolve!: () => void, reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    return { promise, resolve, reject };
}
function gate(id: string, tail: boolean) {
    const key = id + (tail ? ':tail' : ':first');
    if (!gates.has(key)) gates.set(key, deferred());
    return gates.get(key)!;
}
async function waitGate(value: ReturnType<typeof deferred>, signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Fixture resource cancelled', 'AbortError');
    let abort!: () => void;
    try {
        await Promise.race([value.promise, new Promise<never>((_, reject) => {
            abort = () => reject(new DOMException('Fixture resource cancelled', 'AbortError'));
            signal.addEventListener('abort', abort, { once: true });
        })]);
    } finally { signal.removeEventListener('abort', abort); }
}
function visibility(node: Element) {
    let opacity = 1;
    for (let p: Element | null = node; p && p !== container; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility !== 'visible') return 0;
        opacity *= Number(s.opacity);
    }
    return opacity;
}
function capture() {
    const view = viewer.getPageView(0), page = view?.pdfPage;
    if (!view?.div) return { step, at: performance.now(), missingPage: true };
    // The native page border is outside PDF content. The real canvas wrapper owns the
    // physical content box, including CSS sizing and any genuine viewport scale change.
    const bounds = (view.div.querySelector('.canvasWrapper') ?? view.div).getBoundingClientRect();
    const layers = [...view.div.querySelectorAll<HTMLCanvasElement>('.canvasWrapper canvas, :scope > canvas.pdfPrefetchPreview')]
        .filter(node => node.isConnected && node.width > 0 && node.height > 0)
        .map((node, order) => ({ node, order, rect: node.getBoundingClientRect(), opacity: visibility(node), z: Number(getComputedStyle(node).zIndex) || 0 }))
        .sort((a, b) => a.z - b.z || a.order - b.order);
    const covers = [...container.querySelectorAll<HTMLElement>('.pdfDocumentRobotArrival')].map(node => ({
        rect: node.getBoundingClientRect(), opacity: visibility(node), color: getComputedStyle(node).backgroundColor,
    }));
    const photos = data.regions.map((region: any) => {
        const rect = { x: bounds.x + region.x / data.page.width * bounds.width,
            y: bounds.y + (data.page.height - region.y - region.height) / data.page.height * bounds.height,
            width: region.width / data.page.width * bounds.width, height: region.height / data.page.height * bounds.height };
        const pixels: number[][] = [];
        for (const [u, v] of [[0.23, 0.23], [0.55, 0.5], [0.81, 0.77]]) {
            const x = rect.x + u * rect.width, y = rect.y + v * rect.height;
            let color = [255, 255, 255];
            for (const layer of layers) {
                const r = layer.rect;
                if (!layer.opacity || x < r.x || y < r.y || x >= r.right || y >= r.bottom || !r.width || !r.height) continue;
                const rgba = layer.node.getContext('2d')!.getImageData(Math.min(layer.node.width - 1, Math.floor((x - r.x) / r.width * layer.node.width)),
                    Math.min(layer.node.height - 1, Math.floor((y - r.y) / r.height * layer.node.height)), 1, 1).data;
                const alpha = rgba[3] / 255 * layer.opacity;
                color = color.map((before, i) => Math.round(rgba[i] * alpha + before * (1 - alpha)));
            }
            pixels.push(color);
        }
        const displayedPixels = pixels.map((color, index) => {
            const [u, v] = [[0.23, 0.23], [0.55, 0.5], [0.81, 0.77]][index];
            const x = rect.x + u * rect.width, y = rect.y + v * rect.height;
            for (const cover of covers) {
                if (!cover.opacity || x < cover.rect.x || x >= cover.rect.right || y < cover.rect.y || y >= cover.rect.bottom) continue;
                const rgb = cover.color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
                const alpha = cover.opacity * (rgb[3] ?? 1);
                color = color.map((before, i) => Math.round(rgb[i] * alpha + before * (1 - alpha)));
            }
            return color;
        });
        return { id: region.id, resource: region.resource, rect, pixels, displayedPixels,
            visiblePhoto: pixels.some(color => Math.min(...color) < 220),
            displayedPhoto: displayedPixels.some(color => Math.min(...color) < 220),
            covers: covers.filter(c => c.opacity > 0 && c.rect.x < rect.x + rect.width && c.rect.right > rect.x && c.rect.y < rect.y + rect.height && c.rect.bottom > rect.y)
                .map(c => ({ x: c.rect.x, y: c.rect.y, width: c.rect.width, height: c.rect.height, opacity: c.opacity, color: c.color })) };
    });
    const state = controller?.snapshot();
    return { at: performance.now(), branch, step, photos,
        layers: layers.map(l => ({ id: l.node.dataset.fixtureRaster ??= String(rasterSerial++), width: l.node.width, height: l.node.height,
            opacity: l.opacity, preview: l.node.classList.contains('pdfPrefetchPreview'), rect: { x: l.rect.x, y: l.rect.y, width: l.rect.width, height: l.rect.height } })),
        revision: page?.imageRevision, status: page?.imageStatus, paintedRevision: view.paintedImageRevision,
        paintedStatus: view.paintedImageStatus, passStatus: view.imagePassStatus, renderState: view.renderingState,
        sameIntent: view._imagePassIntent === view._paintedImageIntent,
        sameGeometry: view._imagePassGeometry === view._paintedImageGeometry,
        passGeometry: view._imagePassGeometry, paintedGeometry: view._paintedImageGeometry,
        pageClasses: view.div.className, icons: view.div.querySelectorAll('.loadingIcon').length,
        previewSource: state?.previewSource,
        logical: state && { visibleMissing: state.visibleMissing, starved: state.starved, failed: state.failed, idle: state.idle },
        environment: { hidden: document.hidden, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches },
        robots: state?.robots && { deliveryPlans: state.robots.deliveryPlans, queuedDeliveryCovers: state.robots.queuedDeliveryCovers, advance: state.robots.advance, pages: state.robots.pages, activeActors: state.robots.activeActors,
            activeArrivalCovers: state.robots.activeArrivalCovers, activePayloads: state.robots.activePayloads } };
}
let rasterSerial = 1;
function observe() { if (!observing) return; samples.push(capture()); requestAnimationFrame(observe); }
bus.on('pagerendered', (event: any) => {
    paints.push({ at: performance.now(), error: event.error?.message, imageStatus: event.imageStatus,
        imagePassStatus: event.imagePassStatus, imageRevision: event.imageRevision, pass: event.imagePassRevision, snapshot: capture() });
    for (const waiter of paintWaiters.splice(0)) {
        if (paints.length > waiter.after) waiter.resolve(paints.at(-1)); else paintWaiters.push(waiter);
    }
});
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
async function close() {
    observing = false;
    controller?.dispose(); controller = undefined;
    viewer.setDocument(null); link.setDocument(null);
    const previous = task; task = undefined;
    try { await previous?.destroy(); } finally { gates.forEach(g => g.resolve()); gates.clear(); }
}
async function open(name = 'normal') {
    await close(); branch = name; samples = []; paints = []; reads = []; errors = []; renderRecords = []; controls = []; rasterSerial = 1; step = 'initial';
    for (const id of ['x5', 'x6', 'x7', 'x8']) { gate(id, false); gate(id, true); }
    task = pdfjs.getDocument({ ...pdfDocumentCacheOptions(), data: structural.slice(), externalImageSource: {
        images: ['x5', 'x6', 'x7', 'x8'].map(id => ({ id, sha256: data.sha256, originalSha256: data.originalSha256,
            bytes: encoded.length, width: 96, height: 64, components: 3, coefficientBytes: 20480, encoding: 'progressive-jpeg', chunks: data.chunks })),
        async read(request: any) {
            const record: any = { at: performance.now(), id: request.id, chunkIndex: request.chunkIndex, chunkCount: request.chunkCount };
            reads.push(record);
            try { await waitGate(gate(request.id, request.chunkIndex > 0), request.signal); }
            catch (error) { record.error = String(error); record.ended = performance.now(); throw error; }
            record.returned = performance.now();
            const first = data.chunks[request.chunkIndex], last = data.chunks[request.chunkIndex + (request.chunkCount ?? 1) - 1];
            return encoded.slice(first.offset, last.offset + last.bytes);
        },
    }, isImageDecoderSupported: false,
        isEvalSupported: false, standardFontDataUrl: '/ext/site/assets/pdfjs/web/standard_fonts/' });
    const doc = await task.promise;
    const page = await doc.getPage(1), render = page.render.bind(page);
    page.render = (options: any) => {
        const view = viewer.getPageView(0), ctx = options.canvasContext;
        if (armedFailure && ctx?.canvas === view?.canvas) {
            armedFailure = false; let calls = 0; const draw = ctx.drawImage.bind(ctx);
            ctx.drawImage = (...args: any[]) => { if (++calls === 2) throw new Error('Fixture replacement photo draw failure'); return draw(...args); };
        }
        const result = render(options), current = page._externalImages?.current;
        const record: any = { at: performance.now(), controllerInstalled: !!controller,
            main: !!view && ctx?.canvas === view.canvas, annotationMode: options.annotationMode,
            viewport: { width: options.viewport.width, height: options.viewport.height, scale: options.viewport.scale, transform: options.viewport.transform },
            transform: options.transform, imageDecodeScale: options.imageDecodeScale, imageDecodeMaxDimension: options.imageDecodeMaxDimension,
            derivedHints: page.getImageDecodeHints(options), epoch: current?.externalImageEpoch, key: current?.externalImageCacheKey,
            currentToken: token(current?.externalImageToken) };
        renderRecords.push(record);
        result.promise.then(() => { record.completed = performance.now(); record.token = token(result.imageIntent); record.status = result.imageStatus; },
            (error: any) => { record.error = String(error); record.token = token(result.imageIntent); record.status = result.imageStatus; });
        return result;
    };
    const metadata = { version: 1, document: { key: 'fixture-native-images', size: structural.length, pageCount: 1 },
        pages: [{ pageNumber: 1, width: 560, height: 400, rotation: 0, assets: [], imageRegionsComplete: true, imageRegions: data.regions.map((r: any) => ({
            id: r.id, resourceId: r.resource, x: r.x / 560, y: (400 - r.y - r.height) / 400, width: r.width / 560, height: r.height / 400 })) }] };
    const previewSource = { identity: { key: 'fixture-native-images', size: structural.length }, loadManifest: async () => { controls.push({ at: performance.now(), action: 'manifest-return' }); return metadata; },
        loadAsset: async () => { throw new Error('No raster asset in native fixture'); } };
    controller = installPdfPrefetch(viewer, { robotsEnabled: true });
    link.setDocument(doc); viewer.setDocument(doc);
    await viewer.firstPagePromise; await viewer.pagesPromise;
    controls.push({ at: performance.now(), action: 'bind-preview-source' });
    controller.setPreviewSource(previewSource, doc);
    observing = true; requestAnimationFrame(observe);
    viewer.update();
    return { ready: true, photos: data.regions, initial: capture() };
}
async function frames(count = 3) { for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); return capture(); }
async function failedPaint() {
    const view = viewer.getPageView(0), before = capture(); armedFailure = true; step = 'failed-replacement';
    const finished = new Promise(resolve => {
        const done = (event: any) => { bus.off('pagerendered', done); resolve({ before, after: capture(), error: event.error?.message }); };
        bus.on('pagerendered', done);
    });
    view.redrawImages(); viewer.renderingQueue.renderView(view);
    return finished;
}
(window as any).nativeImages = {
    open, close, capture, frames,
    release(id: string, tail = false) { controls.push({ at: performance.now(), id, tail, action: 'release' }); gate(id, tail).resolve(); step = id + (tail ? '-tail' : '-first'); },
    reject(id: string, tail = false) { controls.push({ at: performance.now(), id, tail, action: 'reject' }); gate(id, tail).reject(new Error('Fixture terminal image failure ' + id)); step = id + '-rejected'; },
    nextPaint(after = paints.length) { return paints.length > after ? Promise.resolve(paints.at(-1)) : new Promise(resolve => paintWaiters.push({ after, resolve })); },
    paints: () => paints, reads: () => reads,
    async pauseResume() { step = 'cancel-restart'; const resume = await controller!.pauseImageRefinement(); const stopped = capture(); resume(); return { stopped, after: await frames() }; },
    async scale(value: number) { step = 'scale'; viewer.currentScale = value; viewer.update(); return frames(); },
    async releaseAndPaint(id: string, tail = false) {
        const page = viewer.getPageView(0).pdfPage, before = page.imageRevision;
        const painted = new Promise(resolve => {
            const done = () => { const view = viewer.getPageView(0); if ((view.imagePassRevision ?? -1) > before) { bus.off('pagerendered', done); resolve(capture()); } };
            bus.on('pagerendered', done);
        });
        controls.push({ at: performance.now(), id, tail, action: 'release' }); gate(id, tail).resolve(); step = id + (tail ? '-tail' : '-first');
        return painted;
    },
    async finishImages() { await viewer.getPageView(0).pdfPage.waitForImages({ final: true }); return frames(6); },
    async waitImages(minimum: Record<string, number | boolean>) {
        const page = viewer.getPageView(0).pdfPage;
        await new Promise<void>(resolve => {
            let unsubscribe = () => {};
            const check = () => {
                const status = page.imageStatus;
                if (Object.entries(minimum).every(([key, value]) => typeof value === 'boolean' ? status[key] === value : status[key] >= value)) {
                    unsubscribe(); resolve();
                }
            };
            unsubscribe = page.onImageRevision(check); check();
        });
        return frames(6);
    },
    async settleScene() {
        await new Promise<void>(resolve => {
            const check = () => {
                const state = controller!.snapshot();
                if (state.idle && !state.robots?.activeActors && !state.robots?.activePayloads && !state.robots?.advance.length) resolve();
                else requestAnimationFrame(check);
            }; check();
        });
        return capture();
    },
    async terminalImages() {
        const page = viewer.getPageView(0).pdfPage;
        await new Promise<void>(resolve => {
            let unsubscribe = () => {};
            const check = () => { const status = page.imageStatus; if (status.discovered && status.pending === 0) { unsubscribe(); resolve(); } };
            unsubscribe = page.onImageRevision(check); check();
        });
        await new Promise<void>(resolve => {
            const check = () => {
                const advance = controller!.snapshot().robots?.advance ?? [];
                if (!advance.length || advance.every((work: any) => work.phase === 'parked')) resolve();
                else requestAnimationFrame(check);
            }; check();
        });
        return frames(3);
    },
    failedPaint,
    snapshot() { return { samples, paints, reads, renderRecords, controls, errors, latest: capture() }; },
};
