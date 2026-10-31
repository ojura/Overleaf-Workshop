/**
 * What the extension host and the PDF viewer pages (views/pdf-viewer) say to each other, defined
 * once for both: the host's TypeScript build and the pages' bundles import this module. It imports
 * nothing, so that the pages can bundle it.
 */

/**
 * The viewers that load a build in ranges, of which the setting overleaf-workshop.pdfViewer.engine
 * picks one. package.json lists them for the setting too, which pdfViewerPages.test.ts compares.
 */
export const PDF_VIEWER_ENGINES = ['pdfjs', 'overleaf'] as const;
export type PdfViewerEngine = typeof PDF_VIEWER_ENGINES[number];
/** the viewer when the setting names none of these, as it can after an older version's 'legacy' */
export const DEFAULT_PDF_VIEWER_ENGINE: PdfViewerEngine = 'pdfjs';

export function isPdfViewerEngine(value: unknown): value is PdfViewerEngine {
    return (PDF_VIEWER_ENGINES as readonly unknown[]).includes(value);
}

/** Absolute webview URLs of pdf.js's files, each ending in '/'. */
export interface PdfjsResources {
    /** the folder of pdf.mjs and pdf.worker.mjs */
    build: string;
    cMapUrl: string;
    standardFontDataUrl: string;
    wasmUrl: string;
    iccUrl: string;
    imageResourcesPath: string;
}

/** What the host writes into a page's #viewer-config element (src/core/pdfViewerPages.ts). */
export interface ViewerConfig {
    engine: PdfViewerEngine;
    /** this page's ID, which its requests to the host carry (views/pdf-viewer/src/common/bridge-fetch.ts) */
    page: string;
    pdfjs: PdfjsResources;
}

/** A build's output.pdf, as Overleaf's compile answer lists it, as far as the viewers read it. */
export interface PdfOutputFile {
    path: string;
    /** the file's path on Overleaf's servers, e.g. /project/<project>/user/<user>/build/<build>/output/output.pdf */
    url: string;
    /** the file's type, its extension */
    type: string;
    /** the build's ID */
    build: string;
    /**
     * when the compile asked for PDF caching: the PDF's size, and the pieces of the PDF that the
     * download domain serves by their SHA-256 under /content/<contentId>/
     */
    size?: number;
    ranges?: Array<{ start: number, end: number, hash: string, objectId?: string }>;
    contentId?: string;
    createdAt?: string;
    /** where pdf.js finds the cross-reference table, when the answer says */
    startXRefTable?: number;
    /** the editor whose compile made the build; with the build ID it names the build in Overleaf's cache of compile outputs */
    editorId?: string;
}

/** A build's output.pdf, which the viewers load in ranges from the download domain, as Overleaf's viewer does. */
export interface PdfOutput {
    /** output.pdf on the download domain, with the query Overleaf's viewer uses */
    url: string;
    downloadDomain: string;
    projectId: string;
    file: PdfOutputFile;
    /** the shard of Overleaf's cache of compile outputs that keeps the build, for when the compile server has deleted it */
    clsiCacheShard?: string;
}

/**
 * What happens to the project's build (src/core/projectBuilds.ts), as the viewers' line about it
 * shows it (views/pdf-viewer/src/common/banner.ts has the texts):
 *   ready                the build in use, with nothing to report
 *   none                 no build to show; a compile starts when a viewer of the build is visible
 *   gone                 the build in use is gone from Overleaf's servers, the same
 *   checking             no build to show while the window asks Overleaf for the latest compile
 *   compiling            no build to show while a compile runs that makes one
 *   check-failed         asking Overleaf for the latest compile failed; `detail` says why
 *   compile-failed       the compile ended without a build; `detail` says why
 *   compile-unavailable  the compile did not start; `detail` says why
 */
export type BuildState = 'ready' | 'none' | 'gone' | 'checking' | 'compiling' | 'check-failed' | 'compile-failed' | 'compile-unavailable';

export interface BuildStatus {
    state: BuildState;
    detail?: string;
}

/** A box of the PDF that a source position maps to (SyncTeX); page counts from 1, PDF points from the top left. */
export interface SyncBox {
    page: number;
    h: number;
    v: number;
    width: number;
    height: number;
}

/** A position in the document as PDFJSWrapper.currentPosition gives it. */
export interface Position {
    /** counts from 0 */
    page: number;
    offset: { top: number, left: number };
    pageSize: { height: number, width: number };
}

/** The viewer state of one document, which both viewers share and the host keeps for the document. */
export interface SavedState {
    colorTheme?: string;
    scale?: string;
    position?: Position;
    scrollMode?: number;
    spreadMode?: number;
    sidebarView?: number;
    [other: string]: unknown;
}

/** The colors of a theme of the setting overleaf-workshop.pdfViewer.themes. */
export interface ThemeColors {
    fontColor: string;
    bgColor: string;
}

/** A page's request, which the host sends to Overleaf's download domain (src/core/pdfFetchBridge.ts). */
export interface BridgeRequest {
    /** the request's number on its page, from 1 */
    id: number;
    url: string;
    method?: string;
    headers?: [string, string][];
}

export interface BridgeResponse {
    id: number;
    status: number;
    statusText: string;
    headers: [string, string][];
    body: Uint8Array;
}

/**
 * The host's messages to a page:
 *   initState     the document's saved viewer state, the color themes and the default modes; the
 *                 answer to 'ready'
 *   load          a build, to load in ranges
 *   update        a PDF read whole, as an ArrayBuffer
 *   buildState    what happens to the project's build
 *   syncCode      SyncTeX from the source to the PDF
 *   fetchResponse, fetchError   answers to the page's requests, for the page that `page` names
 */
export type HostMessage =
    | { type: 'initState', content?: SavedState, colorThemes?: Record<string, ThemeColors>, defaults?: { scrollMode?: string, spreadMode?: string } }
    | { type: 'load', output: PdfOutput }
    | { type: 'update', content: ArrayBuffer }
    | ({ type: 'buildState' } & BuildStatus)
    | { type: 'syncCode', content: SyncBox[] }
    | ({ type: 'fetchResponse', page: string } & BridgeResponse)
    | { type: 'fetchError', page: string, id: number, message: string };

/**
 * A page's messages to the host:
 *   ready         the page can take the document; the host answers with 'initState', then
 *                 'load' or 'update', and 'buildState'
 *   saveState     the document's viewer state, kept per document
 *   syncPdf       SyncTeX from the PDF to the source; page counts from 1, h and v are PDF points
 *                 from the top left
 *   recompile     compile the project again
 *   buildGone     the files of build `build` are gone from Overleaf's servers and its cache
 *   download      save the PDF to a file the user picks
 *   switchViewer  show the PDFs in the viewer `engine`: the host sets the setting, and the open
 *                 viewers reload with that viewer's page
 *   fetch, fetchAbort   the page's requests to Overleaf's download domain (bridge-fetch.ts)
 */
export type ViewerMessage =
    | { type: 'ready' }
    | { type: 'saveState', content: SavedState }
    | { type: 'syncPdf', content: { page: number, h: number, v: number, identifier: string } }
    | { type: 'recompile' }
    | { type: 'buildGone', build: string }
    | { type: 'download' }
    | { type: 'switchViewer', engine: PdfViewerEngine }
    | ({ type: 'fetch', page: string } & BridgeRequest)
    | { type: 'fetchAbort', page: string, id: number };
