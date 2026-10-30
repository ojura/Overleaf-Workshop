/**
 * Overleaf's PDF loader fetches from Overleaf's download domain, which sends no CORS headers,
 * so the webview cannot fetch from it. For those URLs this fetch asks the extension host,
 * which sends the request and posts the response back (src/core/pdfFetchBridge.ts); every
 * other URL, e.g. pdf.js's own resources, goes to the webview's fetch as before.
 */
interface Pending { resolve: (response: Response) => void, reject: (error: unknown) => void }

const NULL_BODY = new Set([101, 204, 205, 304]);

export function installBridgeFetch(post: (message: unknown) => void, bridged: (url: URL) => boolean) {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const pending = new Map<number, Pending>();
    let next = 1;

    window.addEventListener('message', (event: MessageEvent) => {
        const message = event.data;
        const waiting = typeof message?.id === 'number' ? pending.get(message.id) : undefined;
        if (!waiting) { return; }
        if (message.type === 'fetchResponse') {
            pending.delete(message.id);
            waiting.resolve(new Response(NULL_BODY.has(message.status) ? null : message.body, {
                status: message.status, statusText: message.statusText, headers: message.headers,
            }));
        } else if (message.type === 'fetchError') {
            pending.delete(message.id);
            waiting.reject(new TypeError(message.message)); // as fetch rejects on network errors
        }
    });

    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(href, location.href);
        if (!bridged(url)) { return nativeFetch(input, init); }
        const id = next++;
        const headers = [...new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries()];
        return new Promise<Response>((resolve, reject) => {
            const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            const aborted = () => signal?.reason ?? new DOMException('The request was aborted.', 'AbortError');
            if (signal?.aborted) { reject(aborted()); return; }
            pending.set(id, { resolve, reject });
            signal?.addEventListener('abort', () => {
                if (pending.delete(id)) {
                    post({ type: 'fetchAbort', id });
                    reject(aborted());
                }
            }, { once: true });
            post({ type: 'fetch', id, url: url.href, method: init?.method ?? 'GET', headers });
        });
    };
}
