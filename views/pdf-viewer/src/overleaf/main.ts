// Overleaf's caching flags must be set before its loader modules run: keep this import first.
import '../common/transport';
import PDFJSWrapper from '@/features/pdf-preview/util/pdf-js-wrapper';
import { onMessage, post, ready, savedState, saveState } from '../common/host';
import type { Position, SyncBox } from '../common/protocol';
import { documentShown, showBuildState, showLoadError } from '../common/banner';
import { goToCode, listenForDoubleClick, showHighlights } from '../common/synctex';
import { applyTheme, themesFrom, type Theme } from '../common/theme';
import { installPdfPrefetch } from '../common/pdf-prefetch';
import { hostPdfPreviewSource } from '../common/pdf-preview-bridge';
import { createPdfPreviewBinding } from '../common/pdf-preview-binding';
import { config } from '../common/config';
import { Documents } from './documents';
import { Outline } from './outline';
import { Toolbar } from './toolbar';
import { listenForWheelZoom, listenForZoomKeys } from './zoom';
import '../common/icons.css';
import './viewer.css';

/**
 * The viewer of a build with Overleaf's PDF viewer core: PDFJSWrapper, unmodified, with the
 * behavior that Overleaf's pdf-js-viewer.tsx adds around it, and the extension's toolbar.
 */

/** pdf.js's SidebarView values, which the saved state shares with the other viewers */
const SIDEBAR_NONE = 0;
const SIDEBAR_OUTLINE = 2;

const container = document.getElementById('viewerContainer') as HTMLDivElement;
const wrapper = new PDFJSWrapper(container);
let shownBuild: string | undefined;
const prefetch = installPdfPrefetch(wrapper.viewer, {
    diagnosticsToolbar: document.getElementById('toolbar')!,
    onIdleChange: idle => { if (shownBuild) { post({ type: 'cacheActivity', page: config.page, build: shownBuild, idle }); } },
});
const previewBinding = createPdfPreviewBinding(wrapper.viewer, (source, doc) => prefetch.setPreviewSource(source, doc));
window.addEventListener('pagehide', event => { if (!event.persisted) { previewBinding.dispose(); } });

/** the zoom, kept per document; Overleaf's default is the page width (pdf-js-viewer.tsx:34-37) */
let scale = 'page-width';
let themes: Theme[] = [];
let theme: Theme | undefined;
/** whether the shown document's pages are set up ('initialised' in pdf-js-viewer.tsx) */
let initialised = false;
/** a position to restore once the page is visible again */
let restorePending = false;
/**
 * A forward search that came while the pages were not ready: before the first document's pages
 * are set up, or during a load, whose swap would clear highlights drawn on the old document. It is
 * drawn when the next document's pages are set up, if that happens soon.
 */
let pendingHighlights: { boxes: SyncBox[], at: number } | undefined;
const PENDING_HIGHLIGHTS_MS = 30_000;

function currentPosition(): Position | undefined {
    if (!initialised || !wrapper.isVisible()) { return undefined; }
    try {
        return wrapper.currentPosition;
    } catch {
        return undefined;
    }
}

function storePosition() {
    const position = currentPosition();
    if (position) { saveState({ position }); }
}

/** the saved position, at the saved zoom (pdf-js-viewer.tsx:299-315) */
function restorePosition() {
    if (!wrapper.isVisible()) {
        restorePending = true;
        return;
    }
    restorePending = false;
    const position = savedState().position;
    if (position && position.page < wrapper.viewer.pagesCount) {
        wrapper.scrollToPosition(position, scale as any);
    } else {
        wrapper.viewer.currentScaleValue = scale;
    }
}

/** the zoom actions of pdf-js-viewer.tsx:396-420 */
function zoom(value: string) {
    if (!initialised) { return; }
    switch (value) {
        case 'zoom-in':
            value = `${Math.min(wrapper.viewer.currentScale * 1.25, 9.99)}`;
            break;
        case 'zoom-out':
            value = `${Math.max(wrapper.viewer.currentScale / 1.25, 0.1)}`;
            break;
    }
    scale = value;
    wrapper.viewer.currentScaleValue = value;
    saveState({ scale: value });
}

function setTheme(next: Theme | undefined) {
    theme = next;
    toolbar.setTheme(theme?.name, themes.length > 1);
    if (theme) { applyTheme(wrapper.viewer, theme); }
}

const toolbar = new Toolbar({
    goToPage(page) {
        if (initialised && page >= 1 && page <= wrapper.viewer.pagesCount) {
            wrapper.viewer.currentPageNumber = page;
        } else {
            toolbar.setPage(wrapper.viewer.currentPageNumber);
        }
    },
    zoom,
    toggleOutline() {
        outline.setOpen(!outline.open);
        toolbar.setOutlineOpen(outline.open);
        saveState({ sidebarView: outline.open ? SIDEBAR_OUTLINE : SIDEBAR_NONE });
    },
    nextTheme() {
        if (themes.length < 2) { return; }
        const index = themes.findIndex(t => t.name === theme?.name);
        setTheme(themes[(index + 1) % themes.length]);
        saveState({ colorTheme: theme!.name });
    },
    goToCode() {
        const position = currentPosition();
        if (position) { goToCode(position); }
    },
    download() {
        post({ type: 'download' });
    },
    // shows the PDF in the pdf.js viewer, at the same place: the host sets the viewer setting
    // and reloads the page with the other viewer, which starts from the saved view
    switchViewer() {
        if (initialised) {
            storePosition();
            saveState({ scale });
        }
        post({ type: 'switchViewer', engine: 'pdfjs' });
    },
});

const outline = new Outline(wrapper.viewer.linkService);

const documents = new Documents(wrapper, {
    beforeLoad() {
        previewBinding.clear();
        // the position to restore in the new build: where the reader is now
        storePosition();
    },
    loaded(doc, build, preview) {
        shownBuild = build;
        documentShown(build);
        previewBinding.set(hostPdfPreviewSource(preview), doc);
        toolbar.setPagesCount(doc.numPages);
        void outline.render(doc);
    },
    failed(error, aborted, build) {
        if (aborted) { return; }
        console.error('pdf viewer:', error);
        showLoadError(error, build);
    },
    fetchFailed(error, build) {
        // as pdf-js-viewer.tsx:181-189: a missing output means the build is gone from Overleaf
        showLoadError(error, build);
    },
});

// pdf-js-viewer.tsx:88-171, without the latency metrics
wrapper.eventBus.on('pagesdestroy', () => { initialised = false; });
wrapper.eventBus.on('pagesinit', () => {
    // set the zoom at once, so the pages do not show for a frame at pdf.js's default 133%
    wrapper.viewer.currentScaleValue = scale;
    initialised = true;
    if (theme) { applyTheme(wrapper.viewer, theme); }
    // one landmark per page clutters screen readers' landmark navigation (pdf-js-viewer.tsx:492-505)
    container.querySelectorAll('div[data-page-number][role="region"]').forEach(page => page.removeAttribute('role'));
    restorePosition();
    toolbar.setPage(wrapper.viewer.currentPageNumber);
    // after the restore, so that the highlight's own scrolling wins
    if (pendingHighlights && Date.now() - pendingHighlights.at < PENDING_HIGHLIGHTS_MS) {
        showHighlights(wrapper.viewer, pendingHighlights.boxes);
    }
    pendingHighlights = undefined;
});
wrapper.eventBus.on('scalechanging', ({ scale: value }: { scale: number }) => {
    toolbar.setScale(wrapper.viewer.currentScaleValue ?? String(value), value);
});
wrapper.eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => toolbar.setPage(pageNumber));

// the position for "go to source" and for the next build (pdf-js-viewer.tsx:208-247)
let storeTimer: ReturnType<typeof setTimeout> | undefined;
container.addEventListener('scroll', () => {
    if (storeTimer) { clearTimeout(storeTimer); }
    storeTimer = setTimeout(storePosition, 500);
}, { passive: true });

// refit 'page-width' and the like when the pane changes size (pdf-js-viewer.tsx:422-439)
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
const onResize = () => {
    if (resizeTimer) { return; }
    resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        wrapper.updateOnResize();
        if (restorePending && initialised) { restorePosition(); }
    }, 250);
};
new ResizeObserver(onResize).observe(container);
window.addEventListener('resize', onResize);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && restorePending && initialised) { restorePosition(); }
});

listenForZoomKeys(zoom, () => initialised);
listenForWheelZoom(wrapper, (value) => {
    scale = value;
    saveState({ scale: value });
});
listenForDoubleClick(wrapper.eventBus, (event, canvas, page) => wrapper.clickPosition(event, canvas, page));

(window as any).overleafViewer = { wrapper, documents, prefetch };
(window as any).pdfPrefetch = prefetch;

const init = await ready();
const saved = savedState();
scale = saved.scale ?? scale;
themes = themesFrom(init);
setTheme(themes.find(t => t.name === saved.colorTheme) ?? themes[0]);
outline.setOpen(saved.sidebarView === SIDEBAR_OUTLINE);
toolbar.setOutlineOpen(outline.open);

// the host sends these after 'initState'; host.ts keeps them until a handler is set
onMessage('load', message => documents.load(message.output, false, message.preview));
onMessage('update', (message) => documents.loadData(message.content));
onMessage('buildState', (message) => showBuildState(message));
onMessage('syncCode', (message) => {
    if (initialised && !documents.loading) {
        showHighlights(wrapper.viewer, message.content);
    } else {
        pendingHighlights = { boxes: message.content, at: Date.now() };
    }
});
