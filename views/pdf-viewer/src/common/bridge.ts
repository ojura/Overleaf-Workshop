import { installBridgeFetch } from './bridge-fetch';
import { config } from './config';
import { post } from './host';
import type { PdfOutput } from './protocol';

/**
 * The outputs of the project that the page loads from: those requests go through the extension
 * host, which checks again that each one is an output of that project (src/core/pdfFetchBridge.ts).
 */
let current: { origin: string, prefix: string } | undefined;
let installed = false;

/** Send the requests for `output`'s project on its download domain through the extension host. */
export function bridgeOutputsOf(output: PdfOutput) {
    const base = new URL(`${output.downloadDomain.replace(/\/+$/, '')}/project/${output.projectId}/`);
    current = { origin: base.origin, prefix: base.pathname };
    if (!installed) {
        installed = true;
        installBridgeFetch(post, (url) => current !== undefined && url.origin === current.origin && url.pathname.startsWith(current.prefix), config.page);
    }
}
