import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { Agent, fetch } from 'undici';
import type { BridgeRequest, BridgeResponse } from './viewerProtocol';

/**
 * The PDF viewer loads compiled PDFs with Overleaf's loader, which fetches byte ranges and
 * the content-addressed pieces of Overleaf's PDF caching from the download domain. That
 * server sends no CORS headers, so the webview cannot fetch from it; it sends each request
 * here instead, and the extension host fetches it.
 */

/** A request of the viewer's loader. */
/** A piece of Overleaf's PDF caching: /content/<contentId>/<SHA-256 of the piece> */
const PIECE = /\/content\/[^/]+\/([0-9a-f]{64})$/;
/** the request headers the loader needs; others are not sent on */
const FORWARDED_HEADERS = new Set(['range', 'accept']);

const sha256 = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');

/**
 * Pieces of compiled PDFs kept on disk, by the SHA-256 that Overleaf's compile server
 * computes over the same bytes. The web viewer keeps them in the browser's HTTP cache; here
 * they survive a reload and serve every later build that contains the same piece, e.g. the
 * images of a book after a change to its text. A piece is stored only when it matches its
 * hash, and the least recently used ones go when the cache outgrows `maxBytes`.
 */
export class PieceCache {
    private bytes?: number;

    constructor(readonly dir: string, readonly maxBytes: number) {}

    async get(hash: string): Promise<Uint8Array | undefined> {
        if (!/^[0-9a-f]{64}$/.test(hash)) { return undefined; }
        const file = path.join(this.dir, hash);
        try {
            const content = new Uint8Array(await fs.promises.readFile(file));
            const now = new Date();
            await fs.promises.utimes(file, now, now).catch(() => {});
            return content;
        } catch {
            return undefined;
        }
    }

    /** Store `content` as `hash`; false when it does not match the hash or the cache is off. */
    async put(hash: string, content: Uint8Array): Promise<boolean> {
        if (this.maxBytes <= 0 || content.byteLength > this.maxBytes || sha256(content) !== hash) { return false; }
        await fs.promises.mkdir(this.dir, { recursive: true });
        const file = path.join(this.dir, hash);
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, content);
        await fs.promises.rename(tmp, file);
        this.bytes = (this.bytes ?? await this.measure()) + content.byteLength;
        if (this.bytes > this.maxBytes) { await this.evict(); }
        return true;
    }

    private async entries() {
        let names: string[] = [];
        try { names = await fs.promises.readdir(this.dir); } catch { return []; }
        const entries = await Promise.all(names.filter(name => /^[0-9a-f]{64}$/.test(name)).map(async name => {
            const stat = await fs.promises.stat(path.join(this.dir, name)).catch(() => undefined);
            return stat && { name, size: stat.size, used: stat.mtimeMs };
        }));
        return entries.filter((entry): entry is { name: string, size: number, used: number } => entry !== undefined);
    }

    private async measure() {
        return (await this.entries()).reduce((total, entry) => total + entry.size, 0);
    }

    /** Remove the least recently used pieces until the cache holds at most 80% of `maxBytes`. */
    private async evict() {
        const entries = (await this.entries()).sort((a, b) => a.used - b.used);
        let total = entries.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of entries) {
            if (total <= this.maxBytes * 0.8) { break; }
            await fs.promises.unlink(path.join(this.dir, entry.name)).catch(() => {});
            total -= entry.size;
        }
        this.bytes = total;
    }
}

/** Whether `url` is an output of `projectId` on `downloadDomain`, e.g. https://compiles.overleafusercontent.com/zone/d */
export function outputsOf(downloadDomain: string, projectId: string): (url: URL) => boolean {
    const base = new URL(`${downloadDomain.replace(/\/+$/, '')}/project/${projectId}/`);
    return (url: URL) => url.protocol === base.protocol && url.origin === base.origin && url.pathname.startsWith(base.pathname);
}

export interface BridgeOptions {
    /** the size of the build's output.pdf, from the compile response */
    buildSize?: () => number | undefined;
}

export class PdfFetchBridge {
    /** a response stalls for at most this long between two pieces of data */
    static idleTimeoutMs = 60 * 1000;
    /**
     * Overleaf's loader asks for output.pdf whole, without a Range header, only when the PDF is
     * smaller than two of pdf.js's 128 KB chunks (pdf-js-wrapper.ts:71-76 with
     * pdf-caching.ts:497-503). For a larger build such a request comes from pdf.js itself, which
     * starts with the whole file when it has no range transport; this bridge answers only once it
     * has read the whole response, so it refuses those requests.
     */
    static readonly wholeFileLimit = 2 * 128 * 1024;
    private static agent?: { timeoutMs: number, agent: Agent };
    private readonly running = new Map<number, AbortController>();

    constructor(private readonly allowed: (url: URL) => boolean, private readonly cache?: PieceCache, private readonly options: BridgeOptions = {}) {}

    static get dispatcher() {
        const timeoutMs = PdfFetchBridge.idleTimeoutMs;
        if (PdfFetchBridge.agent?.timeoutMs !== timeoutMs) {
            PdfFetchBridge.agent = { timeoutMs, agent: new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }) };
        }
        return PdfFetchBridge.agent.agent;
    }

    /** Stop the request `id`, which the viewer no longer needs. */
    abort(id: number) {
        this.running.get(id)?.abort();
    }

    /** Stop every running request: the page that asked for them is gone. */
    abortAll() {
        this.running.forEach(controller => controller.abort());
    }

    async handle(request: BridgeRequest): Promise<BridgeResponse> {
        const url = new URL(request.url);
        if (!this.allowed(url)) {
            throw new Error(`not fetched: ${url.origin}${url.pathname} is not an output of this project`);
        }
        const method = (request.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            throw new Error(`not fetched: ${method} requests are not sent`);
        }
        const headers = (request.headers ?? []).filter(([name]) => FORWARDED_HEADERS.has(name.toLowerCase()));
        const whole = method === 'GET' && !headers.some(([name]) => name.toLowerCase() === 'range');
        if (whole && url.pathname.endsWith('/output.pdf')) {
            const size = this.options.buildSize?.();
            if (size === undefined || size > PdfFetchBridge.wholeFileLimit) {
                throw new Error(`not fetched: output.pdf is fetched whole only up to ${PdfFetchBridge.wholeFileLimit} bytes, and this build has ${size ?? 'an unknown number of'} bytes`);
            }
        }
        const piece = whole ? PIECE.exec(url.pathname)?.[1] : undefined;
        if (piece && this.cache) {
            const cached = await this.cache.get(piece);
            if (cached) {
                return {
                    id: request.id, status: 200, statusText: 'OK',
                    headers: [['content-type', 'application/octet-stream'], ['content-length', String(cached.byteLength)]],
                    body: cached,
                };
            }
        }
        const controller = new AbortController();
        this.running.set(request.id, controller);
        try {
            const res = await fetch(url, { method, headers, signal: controller.signal, dispatcher: PdfFetchBridge.dispatcher });
            const body = new Uint8Array(await res.arrayBuffer());
            if (piece && this.cache && res.status === 200) {
                await this.cache.put(piece, body).catch(() => false);
            }
            return { id: request.id, status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body };
        } finally {
            this.running.delete(request.id);
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
 * download stops (timers/promises' setTimeout).
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
