/**
 * The pages of the PDF viewers, which load a build in ranges (setting
 * overleaf-workshop.pdfViewer.engine). scripts/build-pdf-viewer.mjs writes each one to
 * views/pdf-viewer/dist/<engine>.html with the placeholder <!--viewer-config-->, which the provider
 * replaces with the page's base URL and its configuration (views/pdf-viewer/src/common/config.ts).
 */

import type { PdfViewerEngine, ViewerConfig } from './viewerProtocol';

/** A viewer page as the provider shows it in a panel. */
export interface PageOptions {
    engine: PdfViewerEngine;
    /** the webview URL of views/pdf-viewer/ */
    base: string;
    /** the page's ID among the pages that the panel has shown, for its requests to the extension host (src/core/pdfFetchBridge.ts) */
    page: string;
    /** the folder of pdf.js's release in views/pdf-viewer/ (pdfjsReleaseOf) */
    pdfjsRelease: string;
}

/** where a viewer page takes its configuration (completeViewerPage) */
export const PLACEHOLDER = '<!--viewer-config-->';

/** What a page reads from its #viewer-config element; `base` ends in '/'. */
export function viewerConfig({ engine, base, page, pdfjsRelease }: PageOptions): ViewerConfig {
    const release = `${base}${pdfjsRelease}/`;
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
export function completeViewerPage(template: string, options: PageOptions): string {
    const base = options.base.endsWith('/') ? options.base : `${options.base}/`;
    if (!template.includes(PLACEHOLDER)) {
        throw new Error(`the ${options.engine} viewer page has no ${PLACEHOLDER}`);
    }
    // '<' escaped, so the JSON cannot end the script element
    const json = JSON.stringify(viewerConfig({ ...options, base })).replace(/</g, '\\u003c');
    return template.replace(PLACEHOLDER, `<base href="${attribute(base)}"><script id="viewer-config" type="application/json">${json}</script>`);
}

/** Whether a path in a project (the parts below the project's folder) is the build's PDF. */
export function isBuildPath(pathParts: string[], outputFolder: string): boolean {
    return pathParts.length === 2 && pathParts[0] === outputFolder && pathParts[1] === 'output.pdf';
}
