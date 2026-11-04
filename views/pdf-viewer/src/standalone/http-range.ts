import { pdfPerformance } from '../common/prefetch-performance';

/** The same 128 KiB range granularity used by the extension's PDF.js viewers. */
export const HTTP_PDF_RANGE_CHUNK_SIZE = 128 * 1024;

interface Metrics {
    beginFetch(): () => void;
    fetch(bytes: number, durationMs: number): void;
    event(type: string, data?: Record<string, number | string | boolean | null>): void;
}

interface Options {
    filename?: string;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    metrics?: Metrics;
    onError: (error: Error) => void;
}

interface ByteRange { begin: number; end: number; total: number }
interface Validator { header: string; value: string }

function contentRange(response: Response, begin: number, end: number, total?: number): ByteRange {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
    if (!match) { throw new Error('The PDF server returned an invalid Content-Range.'); }
    const range = { begin: Number(match[1]), end: Number(match[2]) + 1, total: Number(match[3]) };
    if (![range.begin, range.end, range.total].every(Number.isSafeInteger)
        || range.total <= 0 || range.begin !== begin || range.end !== Math.min(end, range.total)
        || range.end <= range.begin) {
        throw new Error('The PDF server returned a different byte range than requested.');
    }
    if (total !== undefined && range.total !== total) {
        throw new Error('The PDF changed while reading. Reload it to continue.');
    }
    const encoding = response.headers.get('Content-Encoding');
    if (encoding && encoding !== 'identity') {
        throw new Error('The PDF range response uses content encoding; serve PDF byte ranges without compression.');
    }
    const length = response.headers.get('Content-Length');
    if (length !== null && Number(length) !== range.end - range.begin) {
        throw new Error('The PDF range Content-Length does not match Content-Range.');
    }
    return range;
}

function responseValidator(response: Response): Validator | undefined {
    const etag = response.headers.get('ETag');
    if (etag && !etag.startsWith('W/')) { return { header: 'ETag', value: etag }; }
    const modified = response.headers.get('Last-Modified');
    return modified ? { header: 'Last-Modified', value: modified } : undefined;
}

async function discard(response: Response) {
    try { await response.body?.cancel(); } catch { /* The request may already be aborted. */ }
}

/**
 * Direct HTTP ranges for the standard PDF.js viewer. A 200 response is cancelled before its
 * body is read, so a missing nginx range configuration cannot turn opening a book into a
 * whole-file download. PDF.js owns the received range cache; the shared controller decides
 * which pages to prepare.
 */
export async function openHttpPdfRange(pdfjs: any, url: string, options: Options) {
    const controller = new AbortController();
    const request = options.fetch ?? globalThis.fetch.bind(globalThis);
    const metrics = options.metrics ?? pdfPerformance;
    const pending = new Set<Promise<void>>();
    let validator: Validator | undefined;
    let total: number | undefined;
    let delivered = 0;

    function abort() {
        controller.abort();
        options.signal?.removeEventListener('abort', abort);
    }
    if (options.signal?.aborted) { abort(); }
    options.signal?.addEventListener('abort', abort, { once: true });

    async function read(begin: number, end: number) {
        if (controller.signal.aborted) { throw new DOMException('PDF load stopped.', 'AbortError'); }
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin
            || total !== undefined && end > total) {
            throw new Error('PDF.js requested an invalid byte range.');
        }
        const started = performance.now();
        const finish = metrics.beginFetch();
        let received = 0;
        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP field name
            const headers: Record<string, string> = { Range: 'bytes=' + begin + '-' + (end - 1) };
            if (validator) { headers['If-Range'] = validator.value; }
            response = await request(url, {
                headers, signal: controller.signal, credentials: 'same-origin',
                redirect: 'error', cache: 'no-store',
            });
            if (response.status !== 206) {
                throw new Error('The PDF server must support byte ranges (HTTP 206); it returned HTTP ' + response.status + '.');
            }
            const range = contentRange(response, begin, end, total);
            if (validator) {
                const current = response.headers.get(validator.header);
                if (current !== null && current !== validator.value) {
                    throw new Error('The PDF changed while reading. Reload it to continue.');
                }
            }
            if (!response.body) { throw new Error('The PDF range response has no body.'); }
            const bytes = new Uint8Array(range.end - range.begin);
            reader = response.body.getReader();
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) { break; }
                if (received + chunk.value.length > bytes.length) {
                    throw new Error('The PDF server sent more bytes than its range length.');
                }
                bytes.set(chunk.value, received);
                received += chunk.value.length;
            }
            if (received !== bytes.length) { throw new Error('The PDF range ended before its declared length.'); }
            if (controller.signal.aborted) { throw new DOMException('PDF load stopped.', 'AbortError'); }
            if (total === undefined) {
                total = range.total;
                validator = responseValidator(response);
            }
            delivered += received;
            return bytes;
        } catch (error) {
            if (reader) {
                try { await reader.cancel(); } catch { /* Destruction can close the stream first. */ }
            } else if (response) {
                await discard(response);
            }
            throw error;
        } finally {
            reader?.releaseLock();
            if (received) { metrics.fetch(received, performance.now() - started); }
            finish();
        }
    }

    try {
        const initialData = await read(0, HTTP_PDF_RANGE_CHUNK_SIZE);
        const transport = new pdfjs.PDFDataRangeTransport(total!, initialData, true, options.filename ?? null);
        transport.abort = abort;
        transport.requestDataRange = (begin: number, end: number) => {
            if (controller.signal.aborted) { return; }
            const job = read(begin, end).then(bytes => {
                if (controller.signal.aborted) { return; }
                transport.onDataRange(begin, bytes);
                transport.onDataProgress(Math.min(total!, delivered), total);
            }).catch(reason => {
                if (controller.signal.aborted) { return; }
                const error = reason instanceof Error ? reason : new Error(String(reason));
                metrics.event('range-error', { message: error.message });
                abort();
                options.onError(error);
            }).finally(() => { pending.delete(job); });
            pending.add(job);
        };
        return {
            length: total!,
            transport,
            documentParams: {
                url, range: transport, length: total,
                rangeChunkSize: HTTP_PDF_RANGE_CHUNK_SIZE,
                disableRange: false, disableStream: true, disableAutoFetch: true,
            },
            abort,
            get settled(): Promise<void> { return Promise.all([...pending]).then(() => undefined); },
        };
    } catch (error) {
        abort();
        throw error;
    }
}
