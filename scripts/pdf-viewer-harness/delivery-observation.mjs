// Browser-side delivery measurements. This function is installed before application startup.
// It observes actual page canvases and text; it does not request PDF resources or render pages.
export function installDeliveryObservation(options) {
    if (location.origin !== options.origin) return;

    // A measurement tab must not overwrite the owner's saved reading position. Only PDF.js's
    // history key is isolated; the application and every other storage key retain normal behavior.
    const getItem = Storage.prototype.getItem, setItem = Storage.prototype.setItem;
    let history = null;
    Storage.prototype.getItem = function (key) {
        return this === localStorage && key === 'pdfjs.history' ? history : getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === 'pdfjs.history') history = String(value);
        else setItem.call(this, key, value);
    };

    const started = performance.now(), pages = new Map(options.pages.map(page => [page, { page, renders: [] }]));
    const errors = [], events = [], frameTimes = [];
    let app, frame, timer, lastFrame, lastProbe = -Infinity, finished, finishedAt, waiting, sampledAt = 0;
    const scratch = document.createElement('canvas');
    scratch.width = scratch.height = 48;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    const at = () => finishedAt ?? performance.now() - started;
    const mark = (type, page, data = {}) => {
        if (events.length < 2048) events.push({ type, page, at: at(), ...data });
    };
    const presented = (canvas, container) => {
        if (!canvas?.isConnected || !canvas.width || !canvas.height || !container) return false;
        for (let node = canvas; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        }
        const box = canvas.getBoundingClientRect(), clip = container.getBoundingClientRect();
        return Math.min(box.right, clip.right, innerWidth) > Math.max(box.left, clip.left, 0)
            && Math.min(box.bottom, clip.bottom, innerHeight) > Math.max(box.top, clip.top, 0);
    };
    const hasPixels = (canvas, container) => {
        if (!presented(canvas, container)) return false;
        const box = canvas.getBoundingClientRect(), clip = container.getBoundingClientRect();
        const left = Math.max(box.left, clip.left, 0), top = Math.max(box.top, clip.top, 0);
        const right = Math.min(box.right, clip.right, innerWidth), bottom = Math.min(box.bottom, clip.bottom, innerHeight);
        context.clearRect(0, 0, 48, 48);
        context.drawImage(canvas, (left - box.left) * canvas.width / box.width, (top - box.top) * canvas.height / box.height,
            (right - left) * canvas.width / box.width, (bottom - top) * canvas.height / box.height, 0, 0, 48, 48);
        const pixels = context.getImageData(0, 0, 48, 48).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] > 16 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 240 && ++ink >= 4) return true;
        }
        return false;
    };
    function observe() {
        if (!app?.pdfViewer) return;
        const viewer = app.pdfViewer;
        for (const [number, result] of pages) {
            const view = viewer.getPageView(number - 1);
            if (!view) continue;
            const preview = view.div.querySelector(':scope > canvas.pdfPrefetchPreview');
            const previewPixels = hasPixels(preview, viewer.container);
            const nativePixels = hasPixels(view.canvas, viewer.container);
            const imageStatus = view.paintedImageStatus;
            if (previewPixels && result.firstPreviewMs === undefined) {
                result.firstPreviewMs = at(); mark('preview-pixels', number);
            }
            if (nativePixels && result.firstNativePixelsMs === undefined) {
                result.firstNativePixelsMs = at(); mark('native-pixels', number);
            }
            if ((previewPixels || nativePixels) && result.firstPixelsMs === undefined) result.firstPixelsMs = at();
            if (nativePixels && imageStatus) {
                if (imageStatus.covered > 0 && result.firstImagePixelsMs === undefined) {
                    result.firstImagePixelsMs = at(); mark('image-pixels', number, { ...imageStatus });
                }
                if (imageStatus.discovered && imageStatus.total > 0 && imageStatus.covered === imageStatus.total && result.firstCompleteImageCoverageMs === undefined) {
                    result.firstCompleteImageCoverageMs = at(); mark('complete-image-coverage', number, { ...imageStatus });
                }
                if (imageStatus.final && imageStatus.failed === 0 && result.firstFinalQualityMs === undefined) {
                    result.firstFinalQualityMs = at(); mark('final-image-quality', number, { ...imageStatus });
                }
            }
            const spans = [...view.div.querySelectorAll('.textLayer span')].filter(node => node.textContent?.trim());
            const textCharacters = spans.reduce((sum, node) => sum + node.textContent.length, 0);
            if (result.firstSelectableTextMs === undefined && textCharacters > 0 && spans.some(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                const clip = viewer.container.getBoundingClientRect();
                return [...range.getClientRects()].some(rect => Math.min(rect.right, clip.right, innerWidth) > Math.max(rect.left, clip.left, 0)
                    && Math.min(rect.bottom, clip.bottom, innerHeight) > Math.max(rect.top, clip.top, 0));
            })) {
                result.firstSelectableTextMs = at(); mark('selectable-text', number, { textCharacters });
            }
            Object.assign(result, { textCharacters, renderingState: view.renderingState,
                nativePresented: presented(view.canvas, viewer.container), previewPresented: presented(preview, viewer.container),
                nativePixels, previewPixels, nativeWidth: view.canvas?.width ?? 0, nativeHeight: view.canvas?.height ?? 0,
                paintedImageRevision: view.paintedImageRevision ?? null, paintedImageStatus: imageStatus ? { ...imageStatus } : null });
        }
    }
    function sampleFrame(now) {
        if (finished) return;
        if (lastFrame !== undefined && frameTimes.length < 20000) frameTimes.push(now - lastFrame);
        lastFrame = now;
        if (now - lastProbe >= 100) {
            lastProbe = now;
            try { observe(); } catch (error) { errors.push({ at: at(), message: String(error) }); finish('observation-error'); return; }
        }
        frame = requestAnimationFrame(sampleFrame);
    }
    function snapshot() {
        const state = window.pdfPrefetch?.snapshot();
        const sorted = [...frameTimes].sort((a, b) => a - b);
        return { timeOrigin: performance.timeOrigin, started, elapsedMs: at(), finished,
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, robotsEnabled: window.pdfPrefetch?.robotsEnabled,
            pages: [...pages.values()].map(value => ({ ...value, renders: [...value.renders] })),
            events: [...events], errors: [...errors],
            frames: { count: sorted.length, p95Ms: sorted[Math.floor((sorted.length - 1) * .95)] ?? null,
                maxMs: sorted.at(-1) ?? null, over50Ms: sorted.filter(value => value > 50).length },
            reader: state ? { visible: state.visible, visibleMissing: state.visibleMissing, idle: state.idle,
                previewBytes: state.previewBytes, canvasBytes: state.canvasBytes, rangeCache: state.rangeCache,
                previewSource: state.previewSource, performance: state.performance } : null,
            document: { pages: app?.pdfDocument?.numPages ?? null, sourceUrl: app?.url ?? null,
                fingerprints: app?.pdfDocument?.fingerprints ?? null,
                nativeWorker: app?.pdfDocument?._transport?.messageHandler?.comObj instanceof Worker,
                notice: document.querySelector('#spomenarNotice[data-error]')?.textContent?.trim() ?? null } };
    }
    function finish(reason) {
        if (finished) return;
        finishedAt = at();
        finished = reason;
        cancelAnimationFrame(frame); clearTimeout(timer);
        try { observe(); } catch (error) { errors.push({ at: at(), message: String(error) }); }
        waiting?.();
    }
    document.addEventListener('webviewerloaded', event => {
        if (event.detail?.source !== window) return;
        app = window.PDFViewerApplication;
        app.initializedPromise.then(() => {
            app.eventBus.on('pagesinit', () => {
                if (options.pages.some(page => page > app.pdfDocument.numPages)) {
                    errors.push({ at: at(), message: 'A requested page is outside the loaded document' });
                    finish('page-range-error'); return;
                }
                app.pdfViewer.spreadMode = options.spread;
                app.pdfViewer.pagesRotation = 0;
                window.pdfPrefetch?.setRobotsEnabled(options.robots);
                mark('pages-init');
            });
            app.eventBus.on('textlayerrendered', event => {
                if (pages.has(event.pageNumber)) mark('text-layer-rendered', event.pageNumber, { error: event.error ? String(event.error) : null });
            });
            app.eventBus.on('pagerendered', event => {
                if (finished) return;
                const result = pages.get(event.pageNumber);
                if (!result) return;
                const render = { at: at(), cssTransform: !!event.cssTransform, error: event.error ? String(event.error) : null,
                    imageRevision: event.imageRevision ?? null, imageStatus: event.imageStatus ? { ...event.imageStatus } : null };
                if (result.renders.length < 256) result.renders.push(render);
                mark('page-rendered', event.pageNumber, render);
                observe();
                if (options.finishOnRender && [...pages.values()].every(page => page.renders.some(render => !render.cssTransform && !render.error))) {
                    requestAnimationFrame(() => requestAnimationFrame(() => finish('pages-rendered')));
                }
                if (options.finishOnFinal && [...pages.values()].every(page => page.renders.some(render => !render.cssTransform && !render.error
                    && (!app.pdfDocument.hasExternalImages || render.imageStatus?.final && render.imageStatus.failed === 0)))) {
                    requestAnimationFrame(() => requestAnimationFrame(() => finish('final-images-rendered')));
                }
            });
        }).catch(error => { errors.push({ at: at(), message: String(error) }); finish('initialization-error'); });
    });
    window.addEventListener('error', event => {
        if (errors.length < 128) errors.push({ at: at(), message: event.message });
    });
    window.addEventListener('unhandledrejection', event => {
        if (errors.length < 128) errors.push({ at: at(), message: String(event.reason) });
    });
    frame = requestAnimationFrame(sampleFrame);
    timer = setTimeout(() => finish('measurement-budget'), options.budgetMs);
    window.__pdfDeliveryObservation = {
        snapshot, finish,
        captureCanvases() {
            const captures = [];
            let pixels = 0;
            for (const number of pages.keys()) {
                const view = app?.pdfViewer?.getPageView(number - 1), canvas = view?.canvas;
                if (!canvas?.width || !canvas.height || view.renderingState !== 3) throw new Error('Page ' + number + ' has not completed a native pass');
                if (app.pdfDocument.hasExternalImages && (!view.paintedImageStatus?.final || view.paintedImageStatus.failed !== 0)) {
                    throw new Error('Page ' + number + ' has not painted final image quality');
                }
                pixels += canvas.width * canvas.height;
                if (pixels > 32 * 1024 * 1024) throw new Error('Native canvas capture exceeds the 32-megapixel measurement limit');
                captures.push({ page: number, width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL('image/png') });
            }
            return captures;
        },
        async next() {
            if (!finished) await new Promise(resolve => {
                const sample = setTimeout(resolve, 500);
                waiting = () => { clearTimeout(sample); resolve(); };
            });
            waiting = undefined;
            const result = snapshot();
            result.sampledAt = sampledAt; sampledAt = result.elapsedMs;
            return result;
        },
    };
}

export function deliveryRequestCategory(pathname) {
    if (/\/reading\.json$/.test(pathname)) return 'reading-manifest';
    if (/\/reading\/[^/]+\.pdf$/i.test(pathname)) return 'reading-layout';
    if (/\/reading\/[^/]+$/.test(pathname)) return 'reading-images';
    return /\.pdf$/i.test(pathname) ? 'pdf' : /previews\//.test(pathname) ? 'previews' : 'application';
}

export function summarizeDeliveryNetwork(requests) {
    const categories = {};
    for (const request of requests) {
        const bucket = categories[request.category] ??= { requests: 0, completed: 0, failed: 0,
            bodyBytes: 0, transferredBytes: 0, cached: 0 };
        bucket.requests++;
        bucket.completed += Number(request.completed === true);
        bucket.failed += Number(request.failed === true);
        bucket.cached += Number(request.cached === true);
        bucket.bodyBytes += request.bodyBytes;
        // loadingFinished includes response headers. An unfinished or cancelled request has
        // only its observed encoded body chunks, which are still real transferred bytes.
        bucket.transferredBytes += request.totalBytes ?? request.encodedBodyBytes;
    }
    return categories;
}
