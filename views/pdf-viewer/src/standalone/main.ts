import { installPdfPrefetch } from '../common/pdf-prefetch';
import { pdfCachePolicy, pdfDocumentCacheOptions } from '../common/scroll-prefetch';
import { openHttpPdfRange } from './http-range';
import { pageLink, readSiteConfig, type SiteConfig } from './config';
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

/** The website always opens its configured document, including URLs copied from other viewers. */
if (new URL(location.href).searchParams.has('file')) {
    history.replaceState(history.state, '', pageLink(location.href, location.hash));
}

function notice(message?: string, error = false) {
    elements.notice.hidden = !message;
    elements.noticeText.textContent = message ?? '';
    elements.notice.toggleAttribute('data-error', error);
    elements.retry.hidden = !error;
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
        // mobile visit fits the reading column and keeps the document's outline out of the way.
        const initialView = app.setInitialView;
        app.setInitialView = function (hash: string | undefined, options: Record<string, unknown> = {}) {
            const explicitSidebar = new URLSearchParams(this.initialBookmark ?? '').has('pagemode');
            const firstMobileView = pdfCachePolicy().name === 'mobile' && !hash && !explicitSidebar;
            // PDF.js supplies a hash for a saved view. Its stored sidebar choice takes priority.
            const initialOptions = firstMobileView ? { ...options, sidebarView: 0 } : options;
            if (!this.pdfViewer.currentScaleValue) { this.pdfViewer.currentScaleValue = 'page-width'; }
            return initialView.call(this, hash || 'zoom=page-width', initialOptions);
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

async function readSettings(): Promise<SiteConfig> {
    const response = await fetch(new URL('../config.json', import.meta.url), { cache: 'no-cache', credentials: 'same-origin' });
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
    settings = config;
    document.title = config.title;
    elements.title.textContent = config.title;
    elements.download.href = config.pdfUrl;
    elements.download.download = config.filename;
    if (config.sourceUrl) {
        elements.source.href = config.sourceUrl;
        elements.source.title = 'Izvorna knjiga na Nextcloudu';
    }
    await app.initializedPromise;
    const prefetch = installPdfPrefetch(app.pdfViewer, {
        diagnosticsToolbar: document.getElementById('spomenarActions')!,
    });
    (window as any).pdfPrefetch = prefetch;
    app.pdfViewer.viewer.classList.add('removePageBorders');
    installSharing(app);

    let source: Awaited<ReturnType<typeof openHttpPdfRange>> | undefined;
    let attempt = 0;
    let loading: AbortController | undefined;
    const resize = new ResizeObserver(() => app.eventBus.dispatch('resize', { source: window }));
    resize.observe(document.getElementById('outerContainer')!);

    app.eventBus.on('pagerendered', ({ error }: { error?: Error }) => {
        if (!error && !elements.notice.hasAttribute('data-error')) { notice(); }
    });
    app.eventBus.on('documenterror', ({ message }: { message: string }) => {
        notice('PDF se nije učitao. ' + message, true);
    });

    async function openBook() {
        const current = ++attempt;
        loading?.abort();
        source?.abort();
        loading = new AbortController();
        const signal = loading.signal;
        elements.share.disabled = true;
        notice('Učitavam spomenar…');
        try {
            await app.close();
            if (signal.aborted) { return; }
            // On retry the upstream history restores the last page and zoom.
            app.initialBookmark = location.hash.slice(1);
            const next = await openHttpPdfRange((window as any).pdfjsLib, config.pdfUrl, {
                filename: config.filename,
                signal,
                onError(error) {
                    if (current !== attempt) { return; }
                    loading?.abort();
                    notice('Veza s knjigom je prekinuta. ' + error.message, true);
                    void app.close().catch((reason: unknown) => console.error('spomenar: close', reason));
                },
            });
            if (signal.aborted || current !== attempt) { next.abort(); return; }
            source = next;
            elements.download.title = 'Preuzmi cijeli PDF (' + (next.length / 1e9).toLocaleString('hr', { maximumFractionDigits: 2 }) + ' GB)';
            await app.open({ ...next.documentParams, ...pdfDocumentCacheOptions() });
        } catch (error) {
            if (signal.aborted || current !== attempt) { return; }
            source?.abort();
            notice('PDF se nije učitao. ' + errorText(error), true);
        }
    }

    elements.retry.addEventListener('click', () => { void openBook(); });
    window.addEventListener('pagehide', (event) => {
        if (event.persisted) { return; }
        ++attempt;
        loading?.abort();
        source?.abort();
        resize.disconnect();
        prefetch.dispose();
        void app.close().catch(() => {});
    });
    await openBook();
}

start().catch(error => {
    console.error('spomenar:', error);
    notice('Spomenar se nije pokrenuo. ' + errorText(error), true);
    elements.retry.addEventListener('click', () => location.reload(), { once: true });
});
