/**
 * The pages of the PDF viewers that load a build in ranges (setting
 * overleaf-workshop.pdfViewer.engine). scripts/build-pdf-viewer.mjs writes each one to
 * views/pdf-viewer/dist/<engine>.html with the placeholder <!--viewer-config-->, which the provider
 * replaces with the page's base URL and its configuration (views/pdf-viewer/src/common/config.ts).
 */

export type PdfViewerEngine = 'legacy' | 'pdfjs' | 'overleaf';
export const PDF_VIEWER_ENGINES: readonly PdfViewerEngine[] = ['legacy', 'pdfjs', 'overleaf'];

/** pdf.js 5.1.91's release in views/pdf-viewer/, the pdf.js version of Overleaf's viewer */
export const PDFJS_RELEASE = 'vendor/pdfjs-5.1.91';

const PLACEHOLDER = '<!--viewer-config-->';

/** What a page reads from its #viewer-config element; `base` is the webview URL of views/pdf-viewer/. */
export function viewerConfig(engine: Exclude<PdfViewerEngine, 'legacy'>, base: string) {
    const release = `${base}${PDFJS_RELEASE}/`;
    return {
        engine,
        pdfjs: {
            build: `${release}build/`,
            cMapUrl: `${release}web/cmaps/`,
            standardFontDataUrl: `${release}web/standard_fonts/`,
            wasmUrl: `${release}web/wasm/`,
            iccUrl: `${release}web/iccs/`,
            imageResourcesPath: `${release}web/images/`,
        },
    };
}

const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Complete a viewer page: its relative URLs then resolve against views/pdf-viewer/, and the page
 * script finds pdf.js's files by their absolute URLs, which pdf.js needs for its worker.
 */
export function completeViewerPage(template: string, engine: Exclude<PdfViewerEngine, 'legacy'>, base: string): string {
    if (!base.endsWith('/')) {
        base = `${base}/`;
    }
    if (!template.includes(PLACEHOLDER)) {
        throw new Error(`the ${engine} viewer page has no ${PLACEHOLDER}`);
    }
    // '<' escaped, so the JSON cannot end the script element
    const json = JSON.stringify(viewerConfig(engine, base)).replace(/</g, '\\u003c');
    return template.replace(PLACEHOLDER, `<base href="${attribute(base)}"><script id="viewer-config" type="application/json">${json}</script>`);
}

/** Whether a path in a project (the parts below the project's folder) is the build's PDF. */
export function isBuildPath(pathParts: string[], outputFolder: string): boolean {
    return pathParts.length === 2 && pathParts[0] === outputFolder && pathParts[1] === 'output.pdf';
}
