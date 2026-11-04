/**
 * The page script of the pdfjs viewer: pdf.js's own viewer app (web/viewer.mjs of the pdf.js
 * release that package.json pins as pdfjs-dist, with its toolbar, sidebar, find and page modes) showing
 * a build that Overleaf's loader fetches in ranges, as Overleaf's web editor does.
 *
 * The page loads this script before viewer.mjs, so that it can set the app's options when the
 * app starts. The app's own way of opening a document, open(), clears the view before the next
 * document loads; this script loads the document itself and only then hands it to the app,
 * keeping the old pages on screen meanwhile, as Overleaf's PDFJSWrapper does. The reading
 * position and the zoom come back after each new build, through PDFJSWrapper's own methods
 * applied to the app's page viewer.
 */
// keep this import first: it sets Overleaf's caching flags before the loader's modules run
import { generatePdfCachingTransportFactory } from '../common/transport';
import PDFJSWrapper from '@/features/pdf-preview/util/pdf-js-wrapper';
import { bridgeOutputsOf } from '../common/bridge';
import { config } from '../common/config';
import { documentShown, showBuildState, showLoadError, showState } from '../common/banner';
import { errorMessage } from '../common/errorMessage';
import { onMessage, post, ready, savedState, saveState } from '../common/host';
import type { InitState } from '../common/host';
import { toPdfFile } from '../common/output';
import type { PdfOutput, Position, SyncBox } from '../common/protocol';
import { goToCode, listenForDoubleClick, showHighlights } from '../common/synctex';
import { applyTheme, themesFrom } from '../common/theme';
import type { Theme } from '../common/theme';
import { createWorkerPort } from '../common/worker';
import { installPdfPrefetch } from '../common/pdf-prefetch';
import { documentParams, PDFJS } from '../shims/pdf-js';
import '../common/icons.css';
import './viewer.css';

const CHUNK_SIZE = 128 * 1024; // PDFJSWrapper's
/** the zoom step of Overleaf's zoom buttons and keys (pdf-js-viewer.tsx); pdf.js's own is about 1.1 */
const ZOOM_STEP = 1.25;
const ScrollMode: Record<string, number> = { vertical: 0, horizontal: 1, wrapped: 2, page: 3 };
const SpreadMode: Record<string, number> = { none: 0, odd: 1, even: 2 };

const app = (): any => (window as any).PDFViewerApplication;

forwardKeysToVsCode();
setOptionsWhenTheAppStarts();

/** what the zoom keys with Ctrl/Cmd do to the page viewer, as in Overleaf's viewer */
function zoomKey(event: KeyboardEvent): ((viewer: any) => void) | undefined {
    switch (event.code || event.key) {
        case 'Equal': case 'NumpadAdd': case '=': case '+':
            return () => app().zoomIn();
        case 'Minus': case 'NumpadSubtract': case '-':
            return () => app().zoomOut();
        // pdf.js's own reset goes to 'auto'; this viewer starts at the page width
        case 'Digit0': case 'Numpad0': case '0':
            return (viewer) => { viewer.currentScaleValue = 'page-width'; };
        case 'Digit9': case 'Numpad9': case '9':
            return (viewer) => { viewer.currentScaleValue = 'page-height'; };
    }
    return undefined;
}

/**
 * Keys that the viewer and VS Code both act on, with Ctrl/Cmd. This listener comes first, as the
 * page runs this script before pdf.js's app.
 * - The zoom keys stay with the viewer: VS Code would zoom its own window as well.
 * - P (Quick Open, and with Shift the Command Palette), S and O go to VS Code. pdf.js's app takes
 *   them for printing, saving and opening a file, and its print listener stops the key press
 *   before VS Code's listener on this window sees it. This listener stops the key press from
 *   reaching pdf.js and sends VS Code a copy of it. The copy has no keyCode, which pdf.js's
 *   listeners check and VS Code does not: VS Code finds keybindings by `code`.
 */
function forwardKeysToVsCode() {
    window.addEventListener('keydown', (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) { return; }
        const zoom = zoomKey(event);
        if (zoom) {
            event.stopImmediatePropagation();
            event.preventDefault();
            if (app()?.pdfViewer) { zoom(app().pdfViewer); }
            return;
        }
        // the copies sent below are not trusted
        if (!event.isTrusted || !['KeyP', 'KeyS', 'KeyO'].includes(event.code)) { return; }
        event.stopImmediatePropagation();
        event.preventDefault();
        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
            altKey: event.altKey, repeat: event.repeat, bubbles: true, cancelable: true,
        }));
    }, true);
}

/**
 * pdf.js's app reads its options when it starts, right after it dispatches 'webviewerloaded'.
 * The event goes to the parent frame's document when the page may reach it, as in a VS Code
 * webview, and to this page's document otherwise.
 */
function setOptionsWhenTheAppStarts() {
    let done = false;
    const onLoaded = (event: Event) => {
        if (done || (event as CustomEvent).detail?.source !== window) { return; }
        done = true;
        // The extension host saves the PDF, since the viewer may have only parts of it. The app
        // binds its handlers when it starts, so the method changes now.
        app().downloadOrSave = async () => post({ type: 'download' });
        // The zoom buttons, the app's zoom keys and the ones above step by Overleaf's factor. The
        // wheel and pinch zoom call updateZoom themselves, so they keep pdf.js's own steps.
        app().zoomIn = () => app().updateZoom(null, ZOOM_STEP);
        app().zoomOut = () => app().updateZoom(null, 1 / ZOOM_STEP);
        const options = (window as any).PDFViewerApplicationOptions;
        const set = (values: Record<string, unknown>) => Object.entries(values).forEach(([name, value]) => options.set(name, value));
        set({
            // the settings in this page's local storage would override the ones below
            disablePreferences: true,
            // pdf.js's sample PDF
            defaultUrl: '',
            // this script restores the view; the app's view history and the PDF's own initial
            // view would undo that
            viewOnLoad: 1,
            defaultZoomValue: '',
            sidebarViewOnLoad: 0,
            enableScripting: false,
            // PDFJSWrapper's: annotations without forms, no annotation editing, large canvases
            annotationMode: 1,
            annotationEditorMode: -1,
            maxCanvasPixels: 8192 * 8192,
            imageResourcesPath: config.pdfjs.imageResourcesPath,
            workerSrc: `${config.pdfjs.build}pdf.worker.mjs`,
            ...documentParams(),
        });
    };
    document.addEventListener('webviewerloaded', onLoaded);
    try {
        parent.document.addEventListener('webviewerloaded', onLoaded);
    } catch {
        // the parent frame is another origin's
    }
}

/**
 * PDFJSWrapper's position methods on the app's page viewer; the wrapper's constructor would make
 * a page viewer of its own. The wrapper's container is the element that scrolls, which is the
 * page viewer's `container` (the app's appConfig.mainContainer).
 */
function wrapperOf(a: any): PDFJSWrapper {
    return Object.assign(Object.create(PDFJSWrapper.prototype), { viewer: a.pdfViewer, container: a.pdfViewer.container });
}

/** for tests and debugging in the page's console */
(window as any).pdfjsViewer = { get wrapper() { return wrapperOf(app()); } };

const factory = generatePdfCachingTransportFactory();

let initState: InitState | undefined;
let themes: Theme[] = [];
/** where the next document's view starts: set before a document goes to the app, used at its pagesinit */
let restore: { position?: Position, scale?: string } | undefined;
/** the build in view, when it was loaded in ranges */
let rangeLoaded: PdfOutput | undefined;
let findAllowed = false;
/** a forward search that came while a document was loading: drawn once its pages are set up */
let pendingBoxes: SyncBox[] | undefined;

const initialized = new Promise<void>((resolve) => {
    const wait = () => app()?.initializedPromise ? app().initializedPromise.then(resolve) : setTimeout(wait, 10);
    wait();
});

/**
 * A load of a document. Each document gets a worker of its own, which stops once the document is
 * destroyed: with one shared worker, pdf.js refuses a load while a destroy is still running
 * (PDFWorker.fromPort), and one destroy that never finishes would block every later load.
 */
interface Job {
    abort: AbortController;
    task?: any;
    worker?: Worker;
}

/** how long a document may take to be destroyed before its worker is stopped anyway */
const DESTROY_TIMEOUT_MS = 10_000;
let queue: Promise<void> = Promise.resolve();
let inFlight: Job | undefined;
/** the document that the app shows */
let shown: { task: any, worker: Worker } | undefined;

function destroy(task: any, worker?: Worker) {
    const timeout = new Promise(resolve => setTimeout(resolve, DESTROY_TIMEOUT_MS));
    Promise.race([task.destroy(), timeout])
        .catch(error => console.warn('pdf viewer: destroying a document:', error))
        .finally(() => worker?.terminate());
}

/**
 * Stop a load that a newer one overtook. Its task's promise is not awaited: once its transport is
 * set up, destroying the task leaves that promise pending for good.
 */
function stop(job: Job) {
    job.abort.abort();
    if (job.task) {
        destroy(job.task, job.worker);
    } else {
        job.worker?.terminate();
    }
}

/** Resolves with what `promise` gives, or with undefined once the job is stopped. */
function untilStopped<T>(job: Job, promise: Promise<T>): Promise<T | undefined> {
    return Promise.race([
        promise,
        new Promise<undefined>(resolve => job.abort.signal.addEventListener('abort', () => resolve(undefined), { once: true })),
    ]);
}

/**
 * Show a document; a newer one overtakes one that is still loading. The extension host sends a
 * build again when the PDF's tab becomes active, and a build that is in view already stays as it
 * is, as in the Overleaf viewer.
 */
function show(source: { output?: PdfOutput, data?: ArrayBuffer }) {
    if (source.output && !inFlight && app()?.pdfDocument && rangeLoaded?.file.build === source.output.file.build) { return; }
    if (inFlight) { stop(inFlight); }
    const job: Job = { abort: new AbortController() };
    inFlight = job;
    queue = queue
        .then(() => load(source, job))
        .catch((error) => console.error('pdf viewer:', error))
        .finally(() => { if (inFlight === job) { inFlight = undefined; } });
}

async function load(source: { output?: PdfOutput, data?: ArrayBuffer }, job: Job) {
    if (job.abort.signal.aborted) { return; }
    await initialized;
    const a = app();
    const worker = await createWorkerPort();
    if (job.abort.signal.aborted) {
        worker.terminate();
        return;
    }
    job.worker = worker;

    let params: Record<string, unknown>;
    let url: string | undefined;
    let isShown = false;
    if (source.output) {
        bridgeOutputsOf(source.output);
        const file = toPdfFile(source.output);
        url = file.url;
        const range = factory({
            url, pdfFile: file.pdfFile, abortController: job.abort,
            handleFetchError: (error) => {
                if (job.abort.signal.aborted) { return; }
                showLoadError(error, source.output?.file.build);
                // before the document is shown, pdf.js would wait for the missing data for good
                if (!isShown) { stop(job); }
            },
        });
        // as PDFJSWrapper.loadDocument: one chunk for a small PDF
        const size = file.pdfFile.size;
        params = { url, range, rangeChunkSize: size < 2 * CHUNK_SIZE ? size : CHUNK_SIZE };
    } else {
        params = { data: new Uint8Array(source.data!) };
    }

    // the view to come back to: where the reader is now, or what was saved for the document
    const view = a.pdfDocument
        ? { position: positionOf(a), scale: a.pdfViewer.currentScaleValue }
        : { position: savedState().position, scale: savedState().scale };

    // getDocument reads the worker from here
    PDFJS.GlobalWorkerOptions.workerPort = worker;
    const task = PDFJS.getDocument({ ...documentParams(), ...params });
    job.task = task;
    let doc: any;
    try {
        doc = await untilStopped(job, task.promise);
    } catch (error: any) {
        destroy(task, worker);
        if (!job.abort.signal.aborted) { showLoadError(error, source.output?.file.build); }
        return;
    }
    if (!doc) { return; }
    isShown = true;
    // from here on a newer load waits for this one and then replaces it, rather than stopping it
    if (inFlight === job) { inFlight = undefined; }
    documentShown(source.output?.file.build);
    findAllowed = false;
    rangeLoaded = source.output;

    // Hold the page viewer's height while the old pages go, so the scroll position stays until the
    // new pages are there (PDFJSWrapper.loadDocument); pagesinit releases it.
    const pages = a.pdfViewer.viewer as HTMLElement;
    const height = pages.getBoundingClientRect().height;
    if (height > 0) { pages.style.minHeight = `${height}px`; }
    restore = view;
    setModesForNextLoad();

    // the app destroys the old document; then its worker stops
    const old = shown;
    await Promise.race([a.close(), new Promise(resolve => setTimeout(resolve, DESTROY_TIMEOUT_MS))]);
    old?.worker.terminate();
    a.pdfLoadingTask = task;
    shown = { task, worker };
    if (url) { a.setTitleUsingUrl(url, url); }
    a.load(doc);
}

function positionOf(a: any): Position | undefined {
    try {
        return wrapperOf(a).currentPosition;
    } catch {
        return undefined;
    }
}

/** The scroll, spread and sidebar view that the app sets once the first page is drawn. */
function setModesForNextLoad() {
    const state = savedState();
    const defaults = initState?.defaults;
    const options = (window as any).PDFViewerApplicationOptions;
    options.set('scrollModeOnLoad', state.scrollMode ?? ScrollMode[defaults?.scrollMode?.toLowerCase() ?? ''] ?? 0);
    options.set('spreadModeOnLoad', state.spreadMode ?? SpreadMode[defaults?.spreadMode?.toLowerCase() ?? ''] ?? 0);
    options.set('sidebarViewOnLoad', state.sidebarView ?? 0);
}

/** When a document's pages are set up: the modes, the zoom and the position to start at. */
function onPagesInit() {
    const a = app();
    const view = restore;
    restore = undefined;
    (a.pdfViewer.viewer as HTMLElement).style.minHeight = '';
    const options = (window as any).PDFViewerApplicationOptions;
    // the same modes as the app sets later, so that it then changes nothing
    a.pdfViewer.scrollMode = options.get('scrollModeOnLoad');
    a.pdfViewer.spreadMode = options.get('spreadModeOnLoad');
    // Overleaf's viewer starts at the page width
    a.pdfViewer.currentScaleValue = view?.scale ?? 'page-width';
    if (view?.position) {
        try {
            wrapperOf(a).scrollToPosition(view.position);
        } catch {
            // a position past the end of a shorter build
        }
    }
    if (pendingBoxes) {
        showHighlights(a.pdfViewer, pendingBoxes);
        pendingBoxes = undefined;
    }
}

let saveTimer: number | undefined;
function saveViewSoon() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        const a = app();
        if (!a.pdfDocument || restore) { return; }
        saveState({ position: positionOf(a), scale: a.pdfViewer.currentScaleValue });
    }, 500);
}

/**
 * Find extracts the text of every page, and pdf.js loads a page's fonts and images in full for
 * that, so on a build loaded in ranges it downloads most of the file. It asks before it does.
 */
function askBeforeFind(a: any) {
    const dispatch = a.eventBus.dispatch.bind(a.eventBus);
    let asking = false;
    a.eventBus.dispatch = (name: string, data: any) => {
        if (name !== 'find' || !rangeLoaded || findAllowed) { return dispatch(name, data); }
        if (asking) { return; }
        asking = true;
        const megabytes = Math.round((rangeLoaded.file.size ?? 0) / 1e6);
        const bar = Object.assign(document.createElement('div'), { id: 'findConsent', role: 'alert' });
        const text = Object.assign(document.createElement('span'), {
            textContent: `Searching this PDF downloads most of it (${megabytes} MB), since find reads the text of every page, and pdf.js loads a page's images to read its text.`,
        });
        const go = Object.assign(document.createElement('button'), { textContent: 'Search' });
        const cancel = Object.assign(document.createElement('button'), { textContent: 'Cancel' });
        const close = () => { bar.remove(); asking = false; };
        go.addEventListener('click', () => { findAllowed = true; close(); dispatch(name, data); });
        cancel.addEventListener('click', () => { close(); a.findBar?.close(); });
        bar.append(text, go, cancel);
        document.body.append(bar);
    };
}

/**
 * The extension's buttons (index.html): go to the source of the top of the view, the next color
 * theme, and the switch to the Overleaf viewer. Each is in the toolbar and, for panes too narrow
 * for it, in pdf.js's tools menu; a click on a menu entry closes the menu, as pdf.js's own do.
 */
function addToolbarButtons(a: any) {
    const buttons = (ids: string[]) => ids.map(id => document.getElementById(id)).filter((b): b is HTMLElement => b !== null);
    const onClick = (ids: string[], action: () => void) => buttons(ids).forEach(button => button.addEventListener('click', () => {
        a.secondaryToolbar?.close?.();
        action();
    }));

    onClick(['goToCodeButton', 'secondaryGoToCode'], () => {
        const position = positionOf(a);
        if (position) { goToCode(position); }
    });

    const themeButtons = buttons(['themeButton', 'secondaryTheme']);
    let index = Math.max(0, themes.findIndex(t => t.name === savedState().colorTheme));
    const showTheme = () => {
        const current = themes[index];
        for (const button of themeButtons) {
            button.title = `Color theme: ${current.name}; click for the next one`;
            button.dataset.theme = current.name;
            button.hidden = themes.length < 2;
            const label = button.querySelector('span');
            if (label) { label.textContent = `Color theme: ${current.name}`; }
        }
        applyTheme(a.pdfViewer, current);
    };
    onClick(['themeButton', 'secondaryTheme'], () => {
        index = (index + 1) % themes.length;
        showTheme();
        saveState({ colorTheme: themes[index].name });
    });

    // shows the PDF in the Overleaf viewer, at the same place: the host sets the viewer setting
    // and reloads the page with the other viewer, which starts from the saved view
    onClick(['switchViewerButton', 'secondarySwitchViewer'], () => {
        if (a.pdfDocument) { saveState({ position: positionOf(a), scale: a.pdfViewer.currentScaleValue }); }
        post({ type: 'switchViewer', engine: 'overleaf' });
    });
    showTheme();
}

async function start() {
    onMessage('load', (message: { output: PdfOutput }) => show({ output: message.output }));
    onMessage('update', (message: { content: ArrayBuffer }) => show({ data: message.content }));
    onMessage('buildState', (message) => showBuildState(message));
    onMessage('syncCode', (message: { content: SyncBox[] }) => {
        // compiling and then jumping to the PDF is the usual order: the search comes while the
        // new build loads, and its pages are not there yet
        if (inFlight || restore || !app()?.pdfDocument) {
            pendingBoxes = message.content;
        } else {
            showHighlights(app().pdfViewer, message.content);
        }
    });

    await initialized;
    const a = app();
    const prefetch = installPdfPrefetch(a.pdfViewer);
    (window as any).pdfjsViewer.prefetch = prefetch;
    (window as any).pdfPrefetch = prefetch;
    // pdf.js's pages have a transparent 9 px border. PDFJSWrapper's currentPosition measures from
    // the page's outer edge, and scrollPageIntoView places PDF points inside the border, so a
    // position would come back 9 px off after each new build. Overleaf's viewer draws pages without
    // the border too (pdf.scss); this is pdf.js's own class for that.
    (a.pdfViewer.viewer as HTMLElement).classList.add('removePageBorders');
    const wrapper = () => wrapperOf(a);
    listenForDoubleClick(a.eventBus, (event, canvas, page) => wrapper().clickPosition(event, canvas, page));
    a.eventBus.on('pagesinit', onPagesInit);
    a.pdfViewer.container.addEventListener('scroll', saveViewSoon);
    a.eventBus.on('scalechanging', saveViewSoon);
    a.eventBus.on('scrollmodechanged', ({ mode }: { mode: number }) => saveState({ scrollMode: mode }));
    a.eventBus.on('spreadmodechanged', ({ mode }: { mode: number }) => saveState({ spreadMode: mode }));
    a.eventBus.on('sidebarviewchanged', ({ view }: { view: number }) => saveState({ sidebarView: view }));
    a.eventBus.on('documenterror', ({ message }: { message: string }) => showState('failed', message));
    askBeforeFind(a);

    initState = await ready();
    themes = themesFrom(initState);
    addToolbarButtons(a);
}

start().catch((error) => {
    console.error('pdf viewer:', error);
    showState('failed', errorMessage(error));
});
