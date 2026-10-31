/**
 * What the extension host writes into a viewer page's #viewer-config element
 * (src/core/pdfViewerPages.ts): which viewer the page is, and the webview URLs of pdf.js's files.
 */

/** Absolute webview URLs, each ending in '/'. */
export interface PdfjsResources {
    /** the folder of pdf.mjs and pdf.worker.mjs */
    build: string;
    cMapUrl: string;
    standardFontDataUrl: string;
    wasmUrl: string;
    iccUrl: string;
    imageResourcesPath: string;
}

export interface ViewerConfig {
    engine: 'pdfjs' | 'overleaf';
    /** this page's ID, which its requests to the extension host carry (bridge-fetch.ts) */
    page: string;
    pdfjs: PdfjsResources;
}

function read(): ViewerConfig {
    const text = document.getElementById('viewer-config')?.textContent;
    if (!text) {
        throw new Error('the viewer page has no #viewer-config element');
    }
    return JSON.parse(text);
}

/** Read when this module is first imported; module scripts run after the page is parsed. */
export const config: ViewerConfig = read();
