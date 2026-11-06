import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { Agent, fetch } from 'undici';
import { cachedDownloadDomainUrl } from '../api/downloadDomain';
import { PdfDiskCache, PdfCacheViewer, PdfFillRequest } from './pdfDiskCache';
import type { BridgeRequest, BridgeResponse, PdfOutput, ReadingImageRequest } from './viewerProtocol';
import { PDF_READING_REQUEST_LIMITS } from './viewerProtocol';
import { PDF_READING_LIMITS } from './pdfReadingManifest';

// The old public name remains for the harness and callers that only use content pieces.
export { PdfDiskCache as PieceCache } from './pdfDiskCache';

const PIECE = /\/content\/[^/]+\/([0-9a-f]{64})$/;
const FORWARDED_HEADERS = new Set(['range', 'accept', 'if-range']);

export function outputsOf(downloadDomain: string, projectId: string): (url: URL) => boolean {
    const base = new URL(downloadDomain.replace(/\/+$/, '') + '/project/' + projectId + '/');
    return url => url.protocol === base.protocol && url.origin === base.origin && url.pathname.startsWith(base.pathname);
}

export interface BridgeOptions {
    buildSize?: () => number | undefined;
    output?: PdfOutput;
}

function cacheUrl(output: PdfOutput): string | undefined {
    if (!output.file.editorId || !output.clsiCacheShard) { return undefined; }
    return cachedDownloadDomainUrl(output.downloadDomain, output.file.url, output.file.build,
        output.file.editorId, output.clsiCacheShard, new URL(output.url).searchParams.get('compileGroup') ?? undefined);
}

function outputRequest(url: URL, output: PdfOutput | undefined): output is PdfOutput {
    if (!output) { return false; }
    return [output.url, cacheUrl(output)].some(candidate => {
        if (!candidate) { return false; }
        const expected = new URL(candidate);
        const actual = new URL(url.href);
        expected.searchParams.sort(); actual.searchParams.sort();
        return expected.href === actual.href;
    });
}

function requestedRanges(value: string | undefined, size: number): Array<{ start: number, end: number }> | undefined {
    if (!value?.startsWith('bytes=')) { return undefined; }
    const ranges = value.slice(6).split(',').map(text => {
        const match = /^(\d+)-(\d+)$/.exec(text.trim());
        return match && { start: Number(match[1]), end: Number(match[2]) + 1 };
    });
    if (!ranges.length || ranges.length > 128 || ranges.some(r => !r ||
        !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > size)) { return undefined; }
    return ranges as Array<{ start: number, end: number }>;
}

/** Never let a range server's ignored Range turn into a book-sized arrayBuffer. */
async function boundedBody(response: Awaited<ReturnType<typeof fetch>>, limit?: number): Promise<Uint8Array> {
    if (limit === undefined) { return new Uint8Array(await response.arrayBuffer()); }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for await (const chunk of response.body ?? []) {
            size += chunk.length;
            if (size > limit) { throw new Error('PDF response exceeds the requested byte ranges'); }
            chunks.push(chunk);
        }
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return new Uint8Array(Buffer.concat(chunks, size));
}

/** The shared host transport and persistent cache for both PDF viewer engines. */
export class PdfFetchBridge {
    static idleTimeoutMs = 60 * 1000;
    static readonly wholeFileLimit = 2 * 128 * 1024;
    private static agent?: { timeoutMs: number, agent: Agent };
    private readonly running = new Map<number, AbortController>();
    private readonly viewer?: PdfCacheViewer;
    private output?: PdfOutput;
    private readonly outputs: PdfOutput[] = [];
    private readonly readings = new Map<string, (id: string, chunk: number, signal: AbortSignal, count?: number) => Promise<{ body: Uint8Array; offset: number; total: number }>>();
    private readonly readingRequests = new Set<AbortController>();
    private readonly readingQueue: Array<{ start(): void; cancel(): void }> = [];
    private disposed = false;

    constructor(private readonly allowed: (url: URL) => boolean, private readonly cache?: PdfDiskCache, private readonly options: BridgeOptions = {}) {
        this.output = options.output;
        if (this.output) { this.outputs.push(this.output); }
        this.viewer = cache?.createViewer();
        this.viewer?.setOutput(this.output);
    }

    static get dispatcher() {
        const timeoutMs = PdfFetchBridge.idleTimeoutMs;
        if (PdfFetchBridge.agent?.timeoutMs !== timeoutMs) {
            PdfFetchBridge.agent = { timeoutMs, agent: new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }) };
        }
        return PdfFetchBridge.agent.agent;
    }

    /** The background adapter uses the same bounded transport and cached-build fallback. */
    static async fetchRange(request: PdfFillRequest): Promise<BridgeResponse> {
        const headers: Array<[string, string]> = [
            ['range', 'bytes=' + request.start + '-' + (request.end - 1)],
            ['accept-encoding', 'identity'],
        ];
        if (request.validator) { headers.push(['if-range', request.validator.value]); }
        let response = await fetch(request.url, { headers, signal: request.signal, dispatcher: PdfFetchBridge.dispatcher });
        const fallback = cacheUrl(request.output);
        if (response.status === 404 && fallback && fallback !== request.url) {
            await response.body?.cancel();
            response = await fetch(fallback, { headers, signal: request.signal, dispatcher: PdfFetchBridge.dispatcher });
        }
        // A 200 answer to a range can be the whole 1.6 GB book. Inspect status before reading.
        const body = response.status === 206
            ? await boundedBody(response, request.end - request.start)
            : (await response.body?.cancel(), new Uint8Array());
        return { id: 0, status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body };
    }

    setOutput(output: PdfOutput | undefined) {
        if (output === this.output) { return; }
        // Both engines retain the old rendered document while its replacement loads. Its
        // foreground fetches stay valid until their loader aborts them or this page is disposed.
        this.output = output;
        if (output) {
            this.outputs.unshift(output);
            this.outputs.splice(4);
        }
        this.viewer?.setOutput(output);
    }

    setActivity(visible: boolean, idle: boolean) { this.viewer?.setActivity(visible, idle); }

    abort(id: number) { this.running.get(id)?.abort(); }

    abortAll() { this.running.forEach(controller => controller.abort()); }

    dispose() {
        this.disposed = true;
        this.abortAll();
        this.viewer?.dispose();
        this.readings.clear();
    }

    /** Old displayed documents remain authorized while a prepared replacement is loading. */
    setReading(revision: string, read: (id: string, chunk: number, signal: AbortSignal, count?: number) => Promise<{ body: Uint8Array; offset: number; total: number }>): void {
        if (this.disposed) { return; }
        this.readings.delete(revision);
        this.readings.set(revision, read);
        while (this.readings.size > 4) { this.readings.delete(this.readings.keys().next().value!); }
    }

    /** Browser cancellation is immediate, but an in-flight filesystem read retains
     * its slot until it settles. Bounded replacements wait here instead of losing an image. */
    private waitForReadingSlot(controller: AbortController): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.disposed || controller.signal.aborted) { reject(new Error('Reading image request stopped')); return; }
            if (this.readingQueue.length >= PDF_READING_REQUEST_LIMITS.queued) { reject(new Error('Reading image request queue is full')); return; }
            const job = {
                start: () => {
                    controller.signal.removeEventListener('abort', job.cancel);
                    if (this.disposed || controller.signal.aborted) { reject(new Error('Reading image request stopped')); return; }
                    this.readingRequests.add(controller);
                    resolve();
                },
                cancel: () => {
                    const index = this.readingQueue.indexOf(job);
                    if (index >= 0) { this.readingQueue.splice(index, 1); }
                    controller.signal.removeEventListener('abort', job.cancel);
                    reject(new Error('Reading image request stopped'));
                },
            };
            controller.signal.addEventListener('abort', job.cancel, { once: true });
            this.readingQueue.push(job);
        });
    }

    private releaseReadingSlot(controller: AbortController) {
        if (!this.readingRequests.delete(controller)) { return; }
        while (!this.disposed && this.readingRequests.size < PDF_READING_REQUEST_LIMITS.active && this.readingQueue.length) {
            this.readingQueue.shift()!.start();
        }
    }

    async handleReading(request: ReadingImageRequest): Promise<BridgeResponse> {
        const read = this.readings.get(request.manifestRevision);
        if (this.disposed || !read || !Number.isSafeInteger(request.id) || request.id < 1
            || typeof request.imageId !== 'string' || !Number.isSafeInteger(request.chunkIndex) || request.chunkIndex < 0
            || request.chunkCount !== undefined && (!Number.isSafeInteger(request.chunkCount)
                || request.chunkCount < 1 || request.chunkCount > PDF_READING_LIMITS.chunks)) {
            throw new Error('Reading image request is not registered for this viewer');
        }
        const controller = new AbortController();
        this.running.get(request.id)?.abort();
        this.running.set(request.id, controller);
        try {
            if (this.readingRequests.size >= PDF_READING_REQUEST_LIMITS.active) { await this.waitForReadingSlot(controller); }
            else { this.readingRequests.add(controller); }
            if (controller.signal.aborted || this.disposed) { throw new Error('Reading image request stopped'); }
            const value = await read(request.imageId, request.chunkIndex, controller.signal, request.chunkCount);
            if (controller.signal.aborted || this.disposed) { throw new Error('Reading image request stopped'); }
            const partial = value.offset !== 0 || value.body.byteLength !== value.total;
            return { id: request.id, status: partial ? 206 : 200, statusText: partial ? 'Partial Content' : 'OK', body: value.body,
                headers: [['content-type', 'application/octet-stream'], ['content-length', String(value.body.byteLength)],
                    ['content-encoding', 'identity'], ...(partial ? [['content-range',
                        'bytes ' + value.offset + '-' + (value.offset + value.body.byteLength - 1) + '/' + value.total] as [string, string]] : [])] };
        } finally {
            if (this.running.get(request.id) === controller) { this.running.delete(request.id); }
            this.releaseReadingSlot(controller);
        }
    }

    private async cachedRanges(request: BridgeRequest, output: PdfOutput, ranges: Array<{ start: number, end: number }>): Promise<BridgeResponse | undefined> {
        if (!this.cache) { return undefined; }
        const cached = await this.cache.readRanges(output, ranges).catch(() => undefined);
        if (!cached) { return undefined; }
        const { parts, validator } = cached;
        const headers: Array<[string, string]> = [['accept-ranges', 'bytes']];
        if (validator) { headers.push([validator.name, validator.value]); }
        if (parts.length === 1) {
            const part = parts[0];
            headers.push(['content-type', 'application/pdf'], ['content-length', String(part.body.length)],
                ['content-range', 'bytes ' + part.start + '-' + (part.end - 1) + '/' + output.file.size]);
            return { id: request.id, status: 206, statusText: 'Partial Content', headers, body: part.body };
        }
        const boundary = 'slipstream-' + randomUUID();
        const body = Buffer.concat(parts.flatMap(part => [
            Buffer.from('--' + boundary + '\r\nContent-Type: application/pdf\r\nContent-Range: bytes ' +
                part.start + '-' + (part.end - 1) + '/' + output.file.size + '\r\n\r\n'),
            part.body, Buffer.from('\r\n'),
        ]).concat([Buffer.from('--' + boundary + '--\r\n')]));
        headers.push(['content-type', 'multipart/byteranges; boundary=' + boundary], ['content-length', String(body.length)]);
        return { id: request.id, status: 206, statusText: 'Partial Content', headers, body };
    }

    async handle(request: BridgeRequest): Promise<BridgeResponse> {
        const url = new URL(request.url);
        if (!this.allowed(url)) { throw new Error('not fetched: ' + url.origin + url.pathname + ' is not an output of this project'); }
        const method = (request.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') { throw new Error('not fetched: ' + method + ' requests are not sent'); }
        const headers = (request.headers ?? []).filter(([name]) => FORWARDED_HEADERS.has(name.toLowerCase()));
        const rangeHeader = headers.find(([name]) => name.toLowerCase() === 'range')?.[1];
        const whole = method === 'GET' && !rangeHeader;
        const output = this.outputs.find(candidate => outputRequest(url, candidate));
        if (whole && url.pathname.endsWith('/output.pdf')) {
            const size = output?.file.size ?? this.options.buildSize?.();
            if (size === undefined || size > PdfFetchBridge.wholeFileLimit) {
                throw new Error('not fetched: output.pdf is fetched whole only up to ' + PdfFetchBridge.wholeFileLimit +
                    ' bytes, and this build has ' + (size ?? 'an unknown number of') + ' bytes');
            }
        }
        const piece = whole ? PIECE.exec(url.pathname)?.[1] : undefined;
        const ranges = method === 'GET' && url.pathname.endsWith('/output.pdf')
            ? requestedRanges(rangeHeader, output?.file.size ?? Number.MAX_SAFE_INTEGER) : undefined;
        const controller = new AbortController();
        const current = () => {
            if (controller.signal.aborted || this.disposed) { throw new Error('PDF request aborted'); }
        };
        this.running.get(request.id)?.abort();
        this.running.set(request.id, controller);
        const endForeground = this.cache?.beginForeground();
        try {
            current();
            if (piece && this.cache) {
                const body = await this.cache.get(piece).catch(() => undefined);
                current();
                if (body) {
                    return { id: request.id, status: 200, statusText: 'OK',
                        headers: [['content-type', 'application/octet-stream'], ['content-length', String(body.length)]], body };
                }
            }
            // Let the origin evaluate If-Range, including strong validators and HTTP dates:
            // https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5
            if (ranges && output && !headers.some(([name]) => name.toLowerCase() === 'if-range')) {
                const cached = await this.cachedRanges(request, output, ranges);
                current();
                if (cached) { return cached; }
            }
            const response = await fetch(url, { method, headers, signal: controller.signal, dispatcher: PdfFetchBridge.dispatcher });
            if (ranges && response.status === 200) {
                await response.body?.cancel();
                throw new Error('PDF server ignored the requested byte ranges');
            }
            const limit = ranges ? ranges.reduce((sum, range) => sum + range.end - range.start, 0) + 128 * 1024
                : whole && url.pathname.endsWith('/output.pdf') ? PdfFetchBridge.wholeFileLimit : undefined;
            const body = await boundedBody(response, limit);
            current();
            const result: BridgeResponse = { id: request.id, status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body };
            if (piece && this.cache && response.status === 200) { await this.cache.put(piece, body, controller.signal).catch(() => false); }
            if (ranges?.length === 1 && output && this.cache) {
                await this.cache.storeRange(output, ranges[0].start, ranges[0].end, result, controller.signal).catch(() => false);
            }
            current();
            return result;
        } finally {
            if (this.running.get(request.id) === controller) { this.running.delete(request.id); }
            endForeground?.();
        }
    }
}

/** numbers the downloads of this process, so that two downloads of one file do not share a part file */
let downloads = 0;

/** the temporary file next to `file` that a download writes until it is complete */
function partFile(file: string): string {
    return `${file}.${process.pid}-${++downloads}.part`;
}

/**
 * A download that the server refused, with the HTTP status of its answer, and the time in ms that
 * the answer asked the client to wait before it asks again (Retry-After), when it named one.
 */
export class DownloadError extends Error {
    constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
        super(message);
    }
}

/**
 * The time in ms that a Retry-After header asks a client to wait before it asks again: a number
 * of seconds, or a date, which has passed for 0 (RFC 9110, section 10.2.3); undefined without the
 * header or for a value of another form.
 */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
    const text = value?.trim();
    if (!text) {
        return undefined;
    }
    if (/^\d+$/.test(text)) {
        return Number(text) * 1000;
    }
    // an HTTP date names its weekday and month, as in "Sun, 01 Nov 2026 05:00:30 GMT"
    const date = /[a-z]/i.test(text) ? Date.parse(text) : NaN;
    return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Download `url`, a file of `size` bytes, to `file` in ranges, a few at a time, retrying each
 * range. One long response of a large build was cut off: the download domain ended the 885 MB
 * book's response after 81 s in the IDE (undici: "terminated", 2026-10-31), while Overleaf's
 * viewer and the PDF viewers here ask for ranges. Holds at most `parallel` ranges in memory. The
 * ranges go to a temporary file next to `file`, which then takes `file`'s name, so a failed
 * download leaves `file` as it was. `onProgress` gets the bytes written so far after each range.
 * `wait` waits the time that an answer asks for before the range is asked again, until the
 * download stops (timers/promises' setTimeout). A Retry-After longer than the existing
 * PdfFetchBridge.idleTimeoutMs server-wait budget fails immediately with the server's time.
 */
export async function downloadInRanges(url: string, file: string, size: number, signal?: AbortSignal,
    { chunk = 8 * 1024 * 1024, parallel = 4, attempts = 3, onProgress = undefined as ((received: number) => void) | undefined,
        wait = (ms: number, stopped: AbortSignal): Promise<void> => sleep(ms, undefined, { signal: stopped }) } = {}) {
    const tmp = partFile(file);
    // stops every range when one fails for good or the caller aborts
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) { stop.abort(); }
    const out = await fs.promises.open(tmp, 'w');
    let received = 0;
    /** The bytes `start` to `end` from the server; throws a DownloadError for an answer other than 206. */
    const fetchBytes = async (start: number, end: number): Promise<Uint8Array> => {
        const res = await fetch(url, { signal: stop.signal, dispatcher: PdfFetchBridge.dispatcher, headers: { range: `bytes=${start}-${end}` } });
        if (res.status !== 206) {
            await res.body?.cancel();
            throw new DownloadError(`the download of ${path.basename(file)} failed: bytes ${start}-${end}: ${res.status} ${res.statusText}`,
                res.status, retryAfterMs(res.headers.get('retry-after')));
        }
        const body = new Uint8Array(await res.arrayBuffer());
        if (body.byteLength !== end - start + 1) {
            throw new Error(`the download of ${path.basename(file)} failed: bytes ${start}-${end} came as ${body.byteLength} bytes`);
        }
        return body;
    };
    const fetchRange = async (start: number) => {
        const end = Math.min(start + chunk, size) - 1;
        for (let attempt = 1; ; attempt++) {
            let body: Uint8Array;
            try {
                body = await fetchBytes(start, end);
            } catch (error) {
                // A network error, a range that came cut off, a 5xx answer and a 429 answer that
                // names a time to ask again can pass; any other answer, such as 404 for a build
                // that is gone, comes again the same way. An answer that names a time to ask
                // again (Retry-After) is asked again after it.
                const answer = error instanceof DownloadError ? error : undefined;
                const passing = answer === undefined || answer.status >= 500 || (answer.status === 429 && answer.retryAfterMs !== undefined);
                if (stop.signal.aborted || attempt >= attempts || !passing) { throw error; }
                if (answer?.retryAfterMs !== undefined) {
                    if (answer.retryAfterMs > PdfFetchBridge.idleTimeoutMs) {
                        throw new DownloadError(`${answer.message}; the server asks to wait ${Math.ceil(answer.retryAfterMs / 1000)} s before it is asked again, `
                            + `longer than the ${PdfFetchBridge.idleTimeoutMs / 1000} s that the window waits for a server`, answer.status, answer.retryAfterMs);
                    }
                    // a stop during the wait ends the range with the answer's error
                    await wait(answer.retryAfterMs, stop.signal).catch(() => { throw error; });
                }
                continue;
            }
            // a failure to write the file is not the server's, and is not asked again
            await out.write(body, 0, body.byteLength, start);
            received += body.byteLength;
            onProgress?.(received);
            return;
        }
    };
    try {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(parallel, Math.ceil(size / chunk)) }, async () => {
            try {
                while (next < size && !stop.signal.aborted) {
                    const start = next;
                    next += chunk;
                    await fetchRange(start);
                }
            } catch (error) {
                stop.abort();
                throw error;
            }
        }));
        if (signal?.aborted) { throw new Error(`the download of ${path.basename(file)} was stopped`); }
        await out.close();
        await fs.promises.rename(tmp, file);
    } catch (error) {
        await out.close().catch(() => {});
        await fs.promises.unlink(tmp).catch(() => {});
        throw error;
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * Download `url`, a file of `size` bytes, to `file` in one response, sending `headers`. The
 * response goes to a temporary file next to `file`, which takes `file`'s name once all `size`
 * bytes have come, so a failed download leaves `file` as it was, as with downloadInRanges.
 * `onProgress` gets the bytes written so far.
 */
export async function downloadWhole(url: string, file: string,
    { headers = {}, size, signal, onProgress }: { headers?: Record<string, string>, size: number, signal?: AbortSignal, onProgress?: (received: number) => void }) {
    const tmp = partFile(file);
    const out = await fs.promises.open(tmp, 'w');
    let body: { cancel(): Promise<void> } | undefined;
    try {
        const res = await fetch(url, { signal, headers, dispatcher: PdfFetchBridge.dispatcher });
        body = res.body ?? undefined;
        if (res.status !== 200 || !res.body) {
            throw new DownloadError(`the download of ${path.basename(file)} failed: ${res.status} ${res.statusText}`, res.status);
        }
        let received = 0;
        for await (const chunk of res.body) {
            await out.write(chunk);
            received += chunk.byteLength;
            onProgress?.(received);
        }
        if (received !== size) {
            throw new Error(`the download of ${path.basename(file)} failed: ${received} of its ${size} bytes came`);
        }
        await out.close();
        await fs.promises.rename(tmp, file);
    } catch (error) {
        // the first error is the one to report; these only clean up after it
        await body?.cancel().catch(() => {});
        await out.close().catch(() => {});
        await fs.promises.unlink(tmp).catch(() => {});
        throw error;
    }
}
