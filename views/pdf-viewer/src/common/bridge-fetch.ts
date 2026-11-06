/**
 * Overleaf's PDF loader fetches from Overleaf's download domain, which sends no CORS headers,
 * so the webview cannot fetch from it. For those URLs this fetch asks the extension host,
 * which sends the request and posts the response back (src/core/pdfFetchBridge.ts); every
 * other URL, e.g. pdf.js's own resources, goes to the webview's fetch as before.
 */
import type { BridgeRequest, HostMessage, ReadingImageRequest, ViewerMessage } from './protocol';
import { pdfPerformance } from './prefetch-performance';
import { createBridgeResponse } from './bridge-response';

interface Pending { resolve: (response: Response) => void, reject: (error: unknown) => void, started: number, measured: boolean, cleanup: () => void }

const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * `page` is this page's ID (config.ts): the requests carry it, and only answers that carry it are
 * taken, since the page numbers its requests from 1 and the panel may have shown another page before.
 */
export function installBridgeFetch(post: (message: ViewerMessage) => void, bridged: (url: URL) => boolean, page: string) {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const pending = new Map<number, Pending>();
    let next = 1;

    window.addEventListener('message', (event: MessageEvent) => {
        const message = event.data as HostMessage | undefined;
        if ((message?.type !== 'fetchResponse' && message?.type !== 'fetchError') || message.page !== page) { return; }
        const waiting = pending.get(message.id);
        if (!waiting) { return; }
        pending.delete(message.id);
        waiting.cleanup();
        if (message.type === 'fetchResponse') {
            if (waiting.measured) { pdfPerformance.fetch(message.body?.byteLength ?? 0, performance.now() - waiting.started); }
            try {
                waiting.resolve(createBridgeResponse(NULL_BODY.has(message.status) ? null : message.body, {
                    status: message.status, statusText: message.statusText, headers: message.headers,
                }));
            } catch (error) { waiting.reject(error); }
        } else {
            if (waiting.measured) { pdfPerformance.event('fetch-error'); }
            waiting.reject(new TypeError(message.message)); // as fetch rejects on network errors
        }
    });

    const send = (request: Omit<BridgeRequest, 'id'> | Omit<ReadingImageRequest, 'id'>, signal?: AbortSignal | null, measured = true) => {
        const id = next++;
        return new Promise<Response>((resolve, reject) => {
            const aborted = () => signal?.reason ?? new DOMException('The request was aborted.', 'AbortError');
            if (signal?.aborted) { reject(aborted()); return; }
            const endFetch = measured ? pdfPerformance.beginFetch() : () => {};
            const onAbort = () => {
                const waiting = pending.get(id);
                if (waiting && pending.delete(id)) {
                    waiting.cleanup();
                    if (measured) { pdfPerformance.event('fetch-abort'); }
                    post({ type: 'fetchAbort', page, id });
                    reject(aborted());
                }
            };
            const cleanup = () => {
                signal?.removeEventListener('abort', onAbort);
                endFetch();
            };
            pending.set(id, { resolve, reject, started: performance.now(), measured, cleanup });
            signal?.addEventListener('abort', onAbort, { once: true });
            try {
                if ('url' in request) { post({ type: 'fetch', page, id, ...request }); }
                else { post({ type: 'readingFetch', page, id, ...request }); }
            } catch (error) {
                pending.delete(id);
                cleanup();
                reject(error);
            }
        });
    };
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(href, location.href);
        if (!bridged(url)) { return nativeFetch(input, init); }
        const headers = [...new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries()];
        return send({ url: url.href, method: init?.method ?? 'GET', headers },
            init?.signal ?? (input instanceof Request ? input.signal : undefined));
    };
    // The verified reading loader measures its own delivered bytes and request lifetime.
    return { readImage: (request: Omit<ReadingImageRequest, 'id'>, signal: AbortSignal) => send(request, signal, false) };
}
