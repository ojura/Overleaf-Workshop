// Stands in for Overleaf's features/pdf-preview/util/pdf-js, which loads pdfjs-dist through
// webpack, starts the worker from Overleaf's server and sets the URLs of pdf.js's resources there.
// In the extension's viewers pdf.js is the page's own (globalThis.pdfjsLib, from the vendor
// build/pdf.mjs that the page loads first), the worker is the page's (common/worker.ts), and the
// URLs are the webview's (common/config.ts).
import { config } from '../common/config';

/** The page's pdf.js; read when used, since the page loads it as a module. */
export const PDFJS: any = new Proxy({}, {
    get: (_target, key) => (globalThis as any).pdfjsLib[key],
});

export const imageResourcesPath = config.pdfjs.imageResourcesPath;

/** The parameters for getDocument: Overleaf's (pdf-js.ts:13-38), with the webview's URLs. */
export const documentParams = (): Record<string, unknown> => ({
    cMapUrl: config.pdfjs.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: config.pdfjs.standardFontDataUrl,
    wasmUrl: config.pdfjs.wasmUrl,
    iccUrl: config.pdfjs.iccUrl,
    // the page fetches these resources, not the worker
    useWorkerFetch: false,
    disableAutoFetch: true, // only fetch the data needed for the displayed pages
    disableStream: true,
    isEvalSupported: false,
    enableXfa: false,
});

/**
 * Every loading task that loadPdfDocumentFromUrl made. PDFJSWrapper drops a load that a newer
 * one overtook without destroying its document; the page destroys it from here, and then deletes
 * the task.
 */
export const loadingTasks = new Set<any>();

export const loadPdfDocumentFromUrl = (url: string, options: Record<string, unknown> = {}) => {
    const task = PDFJS.getDocument({ url, ...documentParams(), ...options });
    loadingTasks.add(task);
    return task;
};
