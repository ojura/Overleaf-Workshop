/**
 * What the extension host writes into a viewer page's #viewer-config element
 * (src/core/pdfViewerPages.ts): which viewer the page is, the page's ID, and the webview URLs of
 * pdf.js's files (ViewerConfig).
 */
import type { ViewerConfig } from './protocol';


function read(): ViewerConfig {
    const text = document.getElementById('viewer-config')?.textContent;
    if (!text) {
        throw new Error('the viewer page has no #viewer-config element');
    }
    return JSON.parse(text);
}

/** Read when this module is first imported; module scripts run after the page is parsed. */
export const config: ViewerConfig = read();
