/**
 * The pages of the PDF viewers, which load a build in ranges (setting
 * overleaf-workshop.pdfViewer.engine). scripts/build-pdf-viewer.mjs writes each one to
 * views/pdf-viewer/dist/<engine>.html with the placeholder <!--viewer-config-->, which the provider
 * replaces with the page's base URL and its configuration (views/pdf-viewer/src/common/config.ts).
 */

import type { PdfViewerEngine, ViewerConfig } from './viewerProtocol';

/** pdf.js 5.1.91's release in views/pdf-viewer/, the pdf.js version of Overleaf's viewer */
export const PDFJS_RELEASE = 'vendor/pdfjs-5.1.91';

/** where a viewer page takes its configuration (completeViewerPage) */
export const PLACEHOLDER = '<!--viewer-config-->';

/**
 * What a page reads from its #viewer-config element; `base` is the webview URL of views/pdf-viewer/,
 * and `page` names this page among the pages that the panel has shown, for its requests to the
 * extension host (src/core/pdfFetchBridge.ts).
 */
export function viewerConfig(engine: PdfViewerEngine, base: string, page: string): ViewerConfig {
    const release = `${base}${PDFJS_RELEASE}/`;
    return {
        engine,
        page,
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
export function completeViewerPage(template: string, engine: PdfViewerEngine, base: string, page: string): string {
    if (!base.endsWith('/')) {
        base = `${base}/`;
    }
    if (!template.includes(PLACEHOLDER)) {
        throw new Error(`the ${engine} viewer page has no ${PLACEHOLDER}`);
    }
    // '<' escaped, so the JSON cannot end the script element
    const json = JSON.stringify(viewerConfig(engine, base, page)).replace(/</g, '\\u003c');
    return template.replace(PLACEHOLDER, `<base href="${attribute(base)}"><script id="viewer-config" type="application/json">${json}</script>`);
}

/** Whether a path in a project (the parts below the project's folder) is the build's PDF. */
export function isBuildPath(pathParts: string[], outputFolder: string): boolean {
    return pathParts.length === 2 && pathParts[0] === outputFolder && pathParts[1] === 'output.pdf';
}
