import { openHttpPdfRange } from './http-range';
import { sitePreviewDescriptor, type SiteConfig } from './config';

interface PrepareOptions {
    signal: AbortSignal;
    apiParams: Record<string, unknown>;
    requirePreviewIdentity?: boolean;
    onError(error: Error): void;
    onProgress?(progress: { loaded: number; total: number }): void;
    openRange?: typeof openHttpPdfRange;
}

/** Prepare a replacement while the current viewer still owns its document and pixels. */
export async function prepareSiteDocument(pdfjs: any, config: SiteConfig, options: PrepareOptions) {
    let source: Awaited<ReturnType<typeof openHttpPdfRange>> | undefined;
    let task: any;
    let worker: any;
    let destroyed = false;
    let rejectLoad!: (error: Error) => void;
    // PDF.js can leave its load promise pending after transport destruction. Cancellation
    // races that promise explicitly, and the listener is owned by this prepared document.
    const stopped = new Promise<never>((_resolve, reject) => { rejectLoad = reject; });
    void stopped.catch(() => {});
    function destroy() {
        if (destroyed) { return; }
        destroyed = true;
        options.signal.removeEventListener('abort', abort);
        source?.abort();
        try { if (task) { void task.destroy().catch(() => {}); } }
        finally { worker?.destroy(); }
    }
    function abort() {
        rejectLoad(new DOMException('PDF load stopped.', 'AbortError'));
        destroy();
    }
    options.signal.addEventListener('abort', abort, { once: true });
    try {
        if (options.signal.aborted) { throw new DOMException('PDF load stopped.', 'AbortError'); }
        source = await (options.openRange ?? openHttpPdfRange)(pdfjs, config.pdfUrl, {
            filename: config.filename, signal: options.signal,
            onError(error) { rejectLoad(error); options.onError(error); },
        });
        if (options.signal.aborted) { source.abort(); throw new DOMException('PDF load stopped.', 'AbortError'); }
        if (options.requirePreviewIdentity && config.previews && !sitePreviewDescriptor(config, source)) {
            throw new Error('Objavljena knjiga ne odgovara svojoj konfiguraciji. Pokušat ću ponovno.');
        }
        // Explicit ownership lets cancellation and the bounded close fallback stop this
        // candidate's worker even if its transport never answers the destroy request.
        worker = new pdfjs.PDFWorker();
        task = pdfjs.getDocument({ ...options.apiParams, ...source.documentParams, worker });
        task.onProgress = options.onProgress;
        task.onPassword = () => rejectLoad(new Error('Objavljena knjiga traži lozinku.'));
        const document = await Promise.race([task.promise, stopped]);
        await Promise.race([document.getPage(1), stopped]);
        if (options.signal.aborted) { throw new DOMException('PDF load stopped.', 'AbortError'); }
        return { source, task, document, destroy };
    } catch (error) {
        destroy();
        throw error;
    }
}

export interface SiteView {
    hash: string;
    rotation: number;
    sidebarView: number;
    scrollMode: number;
    spreadMode: number;
}

/** Preserve the canonical PDF coordinates, including a page clamped to a shorter edition. */
export function captureSiteView(app: any, hash: string, nextPageCount: number): SiteView {
    const viewer = app.pdfViewer;
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    params.delete('nameddest');
    params.delete('pagemode');
    params.set('page', String(Math.max(1, Math.min(nextPageCount, viewer.currentPageNumber || 1))));
    if (!params.has('zoom')) {
        params.set('zoom', typeof viewer.currentScaleValue === 'string' && !/^\d/.test(viewer.currentScaleValue)
            ? viewer.currentScaleValue : String(viewer.currentScale * 100));
    }
    return { hash: params.toString(), rotation: viewer.pagesRotation || 0,
        sidebarView: app.pdfSidebar?.visibleView ?? 0, scrollMode: viewer.scrollMode, spreadMode: viewer.spreadMode };
}
