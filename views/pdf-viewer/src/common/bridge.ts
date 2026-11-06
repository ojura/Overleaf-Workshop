import { installBridgeFetch } from './bridge-fetch';
import { config } from './config';
import { onMessage, post } from './host';
import type { PdfOutput } from './protocol';
import { pdfPerformance } from './prefetch-performance';

/**
 * The outputs of the project that the page loads from: those requests go through the extension
 * host, which checks again that each one is an output of that project (src/core/pdfFetchBridge.ts).
 */
let current: { origin: string, prefix: string, build?: string } | undefined;
let installed: ReturnType<typeof installBridgeFetch> | undefined;

/** Send the requests for `output`'s project on its download domain through the extension host. */
export function bridgeOutputsOf(output: PdfOutput) {
    const base = new URL(`${output.downloadDomain.replace(/\/+$/, '')}/project/${output.projectId}/`);
    if (current?.build !== output.file.build) { pdfPerformance.setDiskCache(); }
    current = { origin: base.origin, prefix: base.pathname, build: output.file.build };
    ensureBridge();
}

function ensureBridge() {
    if (!installed) {
        window.addEventListener('message', (event: MessageEvent) => {
            if (event.data?.type !== 'update') { return; }
            // A whole-data fallback has no disk build report. Keep routing the old document's
            // foreground requests while that replacement loads, but reject its late progress.
            if (current) { current.build = undefined; }
            pdfPerformance.setDiskCache();
        });
        onMessage('cacheProgress', message => {
            if (message.page === config.page && message.build === current?.build) { pdfPerformance.setDiskCache(message); }
        });
        installed = installBridgeFetch(post, (url) => current !== undefined && url.origin === current.origin && url.pathname.startsWith(current.prefix), config.page);
    }
    return installed;
}

/** Local webview resources do not provide ranges; the host reads this registered chunk. */
export function readReadingImage(manifestRevision: string, imageId: string, chunkIndex: number, signal: AbortSignal): Promise<Response> {
    return ensureBridge().readImage({ manifestRevision, imageId, chunkIndex }, signal);
}
