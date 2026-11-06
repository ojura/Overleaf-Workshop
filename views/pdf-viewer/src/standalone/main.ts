import { installPdfPrefetch } from '../common/pdf-prefetch';
import { pdfCachePolicy, pdfDocumentCacheOptions } from '../common/scroll-prefetch';
import { pageLink, readSiteConfig, sitePreviewDescriptor, type SiteConfig } from './config';
import { captureSiteView, prepareSiteDocument } from './document-load';
import { preparePdfReadingUpgrade } from '../common/pdf-reading-upgrade';
import { createSiteDocumentLifecycle } from './document-lifecycle';
import { watchSitePublication } from './publication';
import { httpPdfPreviewSource } from '../common/pdf-preview-http';
import { pdfPerformance } from '../common/prefetch-performance';
import './viewer.css';

const elements = {
    title: document.getElementById('spomenarTitle')!,
    source: document.getElementById('spomenarSource') as HTMLAnchorElement,
    download: document.getElementById('spomenarDownload') as HTMLAnchorElement,
    share: document.getElementById('spomenarShare') as HTMLButtonElement,
    shareDialog: document.getElementById('spomenarShareDialog') as HTMLDialogElement,
    shareUrl: document.getElementById('spomenarShareUrl') as HTMLInputElement,
    copy: document.getElementById('spomenarCopy') as HTMLButtonElement,
    copyStatus: document.getElementById('spomenarCopyStatus')!,
    notice: document.getElementById('spomenarNotice')!,
    noticeText: document.getElementById('spomenarNoticeText')!,
    retry: document.getElementById('spomenarRetry') as HTMLButtonElement,
};
let settings: SiteConfig | undefined;
let currentLink = location.href;
let noticeTimer: number | undefined;

/** The website always opens its configured document, including URLs copied from other viewers. */
if (new URL(location.href).searchParams.has('file')) {
    history.replaceState(history.state, '', pageLink(location.href, location.hash));
}

function notice(message?: string, error = false, edition = false) {
    window.clearTimeout(noticeTimer);
    noticeTimer = undefined;
    elements.notice.hidden = !message;
    elements.noticeText.textContent = message ?? '';
    elements.notice.toggleAttribute('data-error', error);
    elements.notice.toggleAttribute('data-edition', edition);
    elements.retry.hidden = !error;
    if (edition) { noticeTimer = window.setTimeout(() => notice(), 4000); }
}

function errorText(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

const viewerReady = new Promise<any>((resolve) => {
    const loaded = (event: Event) => {
        if ((event as CustomEvent).detail?.source !== window) { return; }
        document.removeEventListener('webviewerloaded', loaded);
        try { parent.document.removeEventListener('webviewerloaded', loaded); } catch { /* Cross-origin embedding. */ }
        const app = (window as any).PDFViewerApplication;
        const assets = new URL('./pdfjs/', import.meta.url).href;
        (window as any).PDFViewerApplicationOptions.setAll({
            disablePreferences: true,
            defaultUrl: '',
            viewOnLoad: 0,
            defaultZoomValue: '',
            historyUpdateUrl: true,
            enableScripting: false,
            isEvalSupported: false,
            annotationMode: 1,
            annotationEditorMode: -1,
            disableAutoFetch: true,
            disableStream: true,
            workerSrc: assets + 'build/pdf.worker.mjs',
            cMapUrl: assets + 'web/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: assets + 'web/standard_fonts/',
            wasmUrl: assets + 'web/wasm/',
            iccUrl: assets + 'web/iccs/',
            imageResourcesPath: assets + 'web/images/',
        });
        // Keep PDF.js's view history, named destinations and back/forward handling. A first
        // desktop visit opens at 150%; mobile fits the column and keeps the outline out of the way.
        const initialView = app.setInitialView;
        app.setInitialView = function (hash: string | undefined, options: Record<string, unknown> = {}) {
            const mobile = pdfCachePolicy().name === 'mobile';
            const defaultZoom = mobile ? 'page-width' : 150;
            const explicitSidebar = new URLSearchParams(this.initialBookmark ?? '').has('pagemode');
            const firstMobileView = mobile && !hash && !explicitSidebar;
            // PDF.js supplies a hash for a saved view. Its stored sidebar choice takes priority.
            const initialOptions = firstMobileView ? { ...options, sidebarView: 0 } : options;
            if (!this.pdfViewer.currentScaleValue) { this.pdfViewer.currentScaleValue = mobile ? defaultZoom : Number(defaultZoom) / 100; }
            return initialView.call(this, hash || 'zoom=' + defaultZoom, initialOptions);
        };
        // A browser download streams to its download manager. PDF.js's default calls
        // getData(), which would first assemble the entire gigabyte book in JavaScript.
        app.download = app.downloadOrSave = async () => { elements.download.click(); };
        app.setTitle = () => { if (settings) { document.title = settings.title; } };
        resolve(app);
    };
    document.addEventListener('webviewerloaded', loaded);
    try { if (parent !== window) { parent.document.addEventListener('webviewerloaded', loaded); } } catch { /* Cross-origin embedding. */ }
});

async function readSettings(signal?: AbortSignal): Promise<SiteConfig> {
    const response = await fetch(new URL('../config.json', import.meta.url), { cache: 'no-cache', credentials: 'same-origin', signal });
    if (!response.ok) { throw new Error('Konfiguracija nije dostupna (HTTP ' + response.status + ').'); }
    return readSiteConfig(await response.json(), new URL('../', import.meta.url).href);
}

function installSharing(app: any) {
    const updateLink = ({ location: view }: { location: { pdfOpenParams: string } }) => {
        currentLink = pageLink(location.href, view.pdfOpenParams);
        elements.share.disabled = false;
    };
    app.eventBus.on('updateviewarea', updateLink);
    elements.share.addEventListener('click', async () => {
        if (typeof navigator.share === 'function') {
            try {
                await navigator.share({ title: settings!.title, url: currentLink });
                return;
            } catch (error) {
                if ((error as Error).name === 'AbortError') { return; }
            }
        }
        elements.shareUrl.value = currentLink;
        elements.copyStatus.textContent = '';
        elements.shareDialog.showModal();
        elements.shareUrl.focus();
        elements.shareUrl.select();
    });
    elements.copy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(elements.shareUrl.value);
            elements.copyStatus.textContent = 'Poveznica je kopirana.';
        } catch {
            elements.shareUrl.focus();
            elements.shareUrl.select();
            elements.copyStatus.textContent = 'Kopirajte označenu poveznicu.';
        }
    });
}

async function start() {
    const [app, config] = await Promise.all([viewerReady, readSettings()]);
    function applySettings(value: SiteConfig) {
        settings = value;
        document.title = value.title;
        elements.title.textContent = value.title;
        elements.download.href = value.pdfUrl;
        elements.download.download = value.filename;
        elements.source.hidden = !value.sourceUrl;
        if (value.sourceUrl) {
            elements.source.href = value.sourceUrl;
            elements.source.title = 'Izvorna knjiga na Nextcloudu';
        }
    }
    applySettings(config);
    await app.initializedPromise;
    const prefetch = installPdfPrefetch(app.pdfViewer, {
        diagnosticsToolbar: document.getElementById('spomenarActions')!,
    });
    (window as any).pdfPrefetch = prefetch;
    app.pdfViewer.viewer.classList.add('removePageBorders');
    installSharing(app);

    let book: Awaited<ReturnType<typeof prepareSiteDocument>> | undefined;
    let attempt = 0;
    let loading: AbortController | undefined;
    let automaticLoad = false;
    let disposed = false, lastInput = -Infinity, inputVersion = 0, pressed = false, printing = false;
    const interaction = (event: Event) => {
        if (!event.isTrusted) { return; }
        lastInput = performance.now();
        inputVersion++;
        if (event.type === 'pointerdown') { pressed = true; }
        if (event.type === 'pointerup' || event.type === 'pointercancel') { pressed = false; }
    };
    const inputEvents = ['pointerdown', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'touchstart', 'touchend'];
    for (const name of inputEvents) { document.addEventListener(name, interaction, { capture: true, passive: true }); }
    const beforePrint = () => { printing = true; };
    const afterPrint = () => { printing = false; lastInput = performance.now(); };
    const blur = () => { pressed = false; };
    const visibility = () => { if (document.hidden && automaticLoad) { loading?.abort(); } };
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    const canCommit = () => !disposed && !document.hidden && !pressed && !printing && !app.pdfPresentationMode?.active
        && !elements.shareDialog.open && performance.now() - lastInput >= 1800
        && !document.activeElement?.closest('input, textarea, [contenteditable="true"]')
        && window.getSelection()?.isCollapsed !== false;
    const documentLifecycle = createSiteDocumentLifecycle(app, {
        viewHash: () => new URL(currentLink).hash,
        inputVersion: () => inputVersion,
    });
    const resize = new ResizeObserver(() => app.eventBus.dispatch('resize', { source: window }));
    resize.observe(document.getElementById('outerContainer')!);

    app.eventBus.on('pagerendered', ({ error }: { error?: Error }) => {
        if (!error && !elements.notice.hasAttribute('data-error') && !elements.notice.hasAttribute('data-edition')) { notice(); }
    });
    app.eventBus.on('documenterror', ({ message }: { message: string }) => {
        notice('PDF se nije učitao. ' + message, true);
    });

    async function openBook(value: SiteConfig, newEdition = false, automatic = false, representationOnly = false) {
        const current = ++attempt;
        loading?.abort();
        loading = new AbortController();
        automaticLoad = automatic;
        const controller = loading, signal = controller.signal;
        let prepared: Awaited<ReturnType<typeof prepareSiteDocument>> | undefined;
        let cancelReplacement: (() => void) | undefined;
        let committed = false;
        let resume: (() => void) | undefined;
        const timeout = window.setTimeout(() => controller.abort(), 60_000);
        if (!automatic) { elements.share.disabled = true; notice('Učitavam spomenar…'); }
        try {
            const pdfjs = (window as any).pdfjsLib;
            const options = (window as any).PDFViewerApplicationOptions;
            // The pinned viewer uses OptionKind.WORKER=0x08 and API=0x04 in open().
            Object.assign(pdfjs.GlobalWorkerOptions, options.getAll(0x08));
            prepared = await prepareSiteDocument(pdfjs, value, {
                signal, requirePreviewIdentity: automatic,
                apiParams: { ...options.getAll(0x04), ...pdfDocumentCacheOptions() },
                onProgress: automatic ? undefined : ({ loaded, total }) => app.progress(loaded / total),
                onError(error) {
                    if (!prepared || book !== prepared || disposed) { return; }
                    notice('Veza s knjigom je prekinuta. ' + error.message, true);
                    void documentLifecycle.close(prepared).catch((reason: unknown) => console.error('spomenar: close', reason));
                },
            });
            if (representationOnly && prepared.reading && app.pdfDocument) {
                resume = await prefetch.pauseImageRefinement();
                await preparePdfReadingUpgrade(prepared.document, app.pdfViewer, signal);
            }
            if (signal.aborted || current !== attempt || automatic && !canCommit()) { return false; }
            const view = app.pdfDocument ? captureSiteView(app, new URL(currentLink).hash, prepared.document.numPages) : undefined;
            const previous = book;
            const preview = sitePreviewDescriptor(value, prepared.source);
            automaticLoad = false;
            window.clearTimeout(timeout);
            if (view && !representationOnly) {
                const identity = preview?.identity.key ?? JSON.stringify([value.pdfUrl, prepared.source.length,
                    prepared.source.validator, value.publicationGeneration ?? 0]);
                cancelReplacement = prefetch.prepareReplacement(identity, signal);
            }
            await documentLifecycle.close(previous, signal);
            if (signal.aborted || current !== attempt || disposed) { return false; }
            const next = prepared;
            app.initialBookmark = view?.hash ?? location.hash.slice(1);
            app.initialRotation = view?.rotation ?? null;
            app.pdfLoadingTask = next.task;
            app.setTitleUsingUrl(value.pdfUrl, value.pdfUrl);
            documentLifecycle.load(next.document, { view, automatic });
            book = next;
            applySettings(value);
            committed = true;
            elements.download.title = 'Preuzmi cijeli PDF (' + (next.source.length / 1e9).toLocaleString('hr', { maximumFractionDigits: 2 }) + ' GB)';
            prefetch.setPreviewSource(preview ? httpPdfPreviewSource(preview) : undefined, next.document);
            pdfPerformance.event('publication-open', { edition: newEdition, generation: value.publicationGeneration ?? 0,
                pages: next.document.numPages, bytes: next.source.length, representationOnly, reading: !!next.reading });
            if (newEdition) { notice('Nova knjiga je stigla. Ekipa, na posao!', false, true); }
            return true;
        } catch (error) {
            if (current !== attempt || disposed || signal.aborted && document.hidden) { return false; }
            if (automatic) { throw error; }
            notice('PDF se nije učitao. ' + (signal.aborted ? 'Veza je prespora. Pokušajte ponovno.' : errorText(error)), true);
            return false;
        } finally {
            window.clearTimeout(timeout);
            if (!committed) { cancelReplacement?.(); prepared?.destroy(); }
            resume?.();
            if (loading === controller) { loading = undefined; automaticLoad = false; }
        }
    }

    elements.retry.addEventListener('click', () => {
        void readSettings().then(value => openBook(value)).catch(error => notice(errorText(error), true));
    });
    const publication = watchSitePublication({
        current: () => settings!, read: readSettings, canApply: () => !loading && canCommit(),
        async apply(value, change) {
            if (change.kind === 'document') { return openBook(value, change.newEdition, true); }
            if (change.kind === 'reading') { return openBook(value, false, true, true); }
            if (change.kind === 'previews' && book) {
                const preview = sitePreviewDescriptor(value, book.source);
                prefetch.setPreviewSource(preview ? httpPdfPreviewSource(preview) : undefined, book.document);
                pdfPerformance.event('publication-previews', { generation: value.publicationGeneration ?? 0 });
            }
            applySettings(value);
        },
        onError: error => pdfPerformance.event('publication-check-error', { message: errorText(error) }),
    });
    window.addEventListener('pagehide', (event) => {
        if (event.persisted) { return; }
        disposed = true;
        ++attempt;
        loading?.abort();
        book?.destroy();
        documentLifecycle.dispose();
        publication.dispose();
        window.clearTimeout(noticeTimer);
        for (const name of inputEvents) { document.removeEventListener(name, interaction, true); }
        window.removeEventListener('beforeprint', beforePrint);
        window.removeEventListener('afterprint', afterPrint);
        window.removeEventListener('blur', blur);
        document.removeEventListener('visibilitychange', visibility);
        resize.disconnect();
        prefetch.dispose();
        void app.close().catch(() => {});
    });
    await openBook(config);
}

start().catch(error => {
    console.error('spomenar:', error);
    notice('Spomenar se nije pokrenuo. ' + errorText(error), true);
    elements.retry.addEventListener('click', () => location.reload(), { once: true });
});
