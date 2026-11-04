import * as assert from 'assert';
import { createHash } from 'crypto';
import { fork, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { PdfCacheCompletionError, PdfDiskCache, PDF_DISK_POLICY, PdfFillRequest } from '../core/pdfDiskCache';
import { PdfFetchBridge, outputsOf } from '../core/pdfFetchBridge';
import type { BridgeResponse, PdfOutput } from '../core/viewerProtocol';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const content = (size: number, salt = 0) => Uint8Array.from({ length: size }, (_, i) => (i * 131 + (i >>> 8) + (i >>> 16) + salt) & 255);
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function output(size: number, build = 'build-a', ranges: PdfOutput['file']['ranges'] = []): PdfOutput {
    const domain = 'http://127.0.0.1:1/zone/d';
    const file = { path: 'output.pdf', type: 'pdf', size, build,
        url: '/project/project-a/user/user-a/build/' + build + '/output/output.pdf',
        editorId: 'editor-a', contentId: 'content-a', ranges };
    return { url: domain + file.url, downloadDomain: domain, projectId: 'project-a', file };
}

function response(bytes: Uint8Array, start: number, end: number, etag = '"edition-a"'): BridgeResponse {
    return { id: 0, status: 206, statusText: 'Partial Content',
        headers: [['content-range', 'bytes ' + start + '-' + (end - 1) + '/' + bytes.length], ['etag', etag]],
        body: bytes.slice(start, end) };
}

function multipartParts(reply: BridgeResponse): Array<{ range: string, body: Uint8Array }> {
    const type = reply.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    const boundary = /^multipart\/byteranges; boundary=(.+)$/.exec(type ?? '')?.[1];
    assert.ok(boundary);
    const parts = Buffer.from(reply.body).toString('latin1').split('--' + boundary);
    assert.strictEqual(parts.shift(), '');
    assert.strictEqual(parts.pop(), '--\r\n');
    return parts.map(part => {
        const headerEnd = part.indexOf('\r\n\r\n');
        assert.ok(headerEnd >= 0 && part.endsWith('\r\n'));
        const range = /\r\nContent-Range: ([^\r\n]+)/.exec(part.slice(0, headerEnd))?.[1];
        assert.ok(range);
        return { range, body: new Uint8Array(Buffer.from(part.slice(headerEnd + 4, -2), 'latin1')) };
    });
}

class Timers {
    now = 0;
    next = 0;
    tasks = new Map<number, { callback: () => void, due: number }>();
    set = (callback: () => void, ms: number) => {
        const id = ++this.next; this.tasks.set(id, { callback, due: this.now + ms }); return id;
    };
    clear = (timer: unknown) => { this.tasks.delete(timer as number); };
    fire(): boolean {
        const next = [...this.tasks].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) { return false; }
        this.now = next[1].due; this.tasks.delete(next[0]); next[1].callback(); return true;
    }
}

function diskBytes(dir: string): number {
    return fs.readdirSync(dir).filter(name => /^(?:[a-f0-9]{64}|(?:build|object)-[a-f0-9]{64}\.json)(?:\..*\.tmp)?$/.test(name))
        .reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function liveToken() {
    const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8');
    return process.pid + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] + ':test-owner';
}

describe('the shared persistent PDF disk budget', () => {
    let dir: string;
    const caches: PdfDiskCache[] = [];
    const cleanups: Array<() => void> = [];
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-disk-cache-')); });
    afterEach(async () => {
        cleanups.splice(0).forEach(cleanup => cleanup());
        for (const cache of caches.splice(0)) { await cache.dispose(); }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const make = (budget = 4 * 1024 * 1024, options: ConstructorParameters<typeof PdfDiskCache>[2] = {}) => {
        const cache = new PdfDiskCache(dir, budget, options); caches.push(cache); return cache;
    };

    it('allocates only arrived bytes for the 1.6 GB book, then resumes those bytes after restart', async () => {
        const book = output(1_608_644_855);
        const timers = new Timers();
        const requests: PdfFillRequest[] = [];
        const cache = make(PDF_DISK_POLICY.defaultMaxBytes, {
            now: () => timers.now, setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: async request => {
                requests.push(request);
                const body = content(request.end - request.start);
                return { id: 0, status: 206, statusText: 'Partial Content',
                    headers: [['content-range', 'bytes ' + request.start + '-' + (request.end - 1) + '/' + book.file.size], ['etag', '"book"']], body };
            },
        });
        const viewer = cache.createViewer();
        viewer.setOutput(book); viewer.setActivity(true, true);
        assert.strictEqual((await cache.snapshot(book)).bytes, 0, 'opening metadata does not reserve a PDF file');
        assert.strictEqual(timers.fire(), true);
        await cache.settled();
        assert.deepStrictEqual(requests.map(r => [r.start, r.end]), [[0, PDF_DISK_POLICY.chunkBytes]]);
        const stored = await cache.snapshot(book);
        assert.strictEqual(stored.covered, PDF_DISK_POLICY.chunkBytes);
        assert.ok(stored.bytes < PDF_DISK_POLICY.chunkBytes + 2048);
        assert.strictEqual(diskBytes(dir), stored.bytes);
        assert.ok(fs.readdirSync(dir).filter(n => n !== '.writer').every(n => fs.statSync(path.join(dir, n)).size <= PDF_DISK_POLICY.chunkBytes));
        viewer.dispose(); await cache.dispose();
        const reopened = make(PDF_DISK_POLICY.defaultMaxBytes);
        assert.deepStrictEqual((await reopened.readRange(book, 0, 37))?.body, content(37));
        assert.strictEqual((await reopened.snapshot(book)).covered, PDF_DISK_POLICY.chunkBytes);
    });

    it('fills one small range at a time only while visible and idle, and streams a complete cached export', async () => {
        const bytes = content(PDF_DISK_POLICY.chunkBytes * 2 + 71);
        const book = output(bytes.length);
        const timers = new Timers();
        const requests: PdfFillRequest[] = [];
        const cache = make(4 * 1024 * 1024, { setTimer: timers.set, clearTimer: timers.clear, now: () => timers.now,
            fetchRange: async request => { requests.push(request); return response(bytes, request.start, request.end); } });
        const viewer = cache.createViewer();
        viewer.setOutput(book);
        viewer.setActivity(false, true);
        assert.strictEqual(timers.fire(), false, 'hidden viewer starts no transfer');
        viewer.setActivity(true, false);
        assert.strictEqual(timers.fire(), false, 'active rendering starts no transfer');
        viewer.setActivity(true, true);
        for (let i = 0; i < 4; i++) { assert.strictEqual(timers.fire(), true); await cache.settled(); }
        assert.strictEqual(timers.fire(), false, 'complete files do not continue a fill loop');
        assert.strictEqual(requests.length, 3);
        assert.ok(requests.every(r => r.end - r.start <= PDF_DISK_POLICY.chunkBytes));
        assert.strictEqual((await cache.snapshot(book)).complete, true);
        viewer.dispose(); await cache.dispose();
        const reopened = make();
        const target = path.join(dir, 'saved.pdf');
        const progress: number[] = [];
        assert.strictEqual(await reopened.copyComplete(book, target, undefined, n => progress.push(n)), true);
        assert.deepStrictEqual(new Uint8Array(fs.readFileSync(target)), bytes);
        assert.strictEqual(progress.at(-1), bytes.length);
        assert.ok(progress.every((value, i) => value - (progress[i - 1] ?? 0) <= PDF_DISK_POLICY.chunkBytes));
    });

    it('completes only missing intervals with four bounded export workers and reuses a complete result', async () => {
        const chunk = PDF_DISK_POLICY.exportRangeBytes, bytes = content(6 * chunk + 73);
        const piece = bytes.subarray(chunk, 2 * chunk);
        const book = output(bytes.length, 'export', [{ start: chunk, end: 2 * chunk, hash: hash(piece) }]);
        const entered = deferred<void>(), releases: Array<ReturnType<typeof deferred<void>>> = [];
        const requests: PdfFillRequest[] = [], progress: number[] = [];
        let blocking = true, active = 0, peak = 0;
        const cache = make(16 * chunk, { fetchRange: async request => {
            requests.push(request); active++; peak = Math.max(peak, active);
            try {
                if (blocking) {
                    const release = deferred<void>(); releases.push(release);
                    if (releases.length === PDF_DISK_POLICY.exportConcurrency) { entered.resolve(); }
                    await release.promise;
                }
                return response(bytes, request.start, request.end);
            } finally { active--; }
        } });
        await cache.put(hash(piece), piece);
        await cache.storeRange(book, 0, 100, response(bytes, 0, 100));
        await cache.storeRange(book, bytes.length - 128, bytes.length, response(bytes, bytes.length - 128, bytes.length));
        const initial = (await cache.snapshot(book)).covered;
        const completing = cache.completeForExport(book, { onProgress: covered => progress.push(covered) });
        try {
            await entered.promise;
            assert.strictEqual(peak, 4);
            assert.strictEqual(fs.existsSync(path.join(dir, '.writer')), false, 'network waits do not hold the writer lease');
            assert.deepStrictEqual((await cache.readRange(book, 0, 100))?.body, bytes.slice(0, 100), 'foreground cached reads remain available');
            const extra = content(20, 91); assert.strictEqual(await cache.put(hash(extra), extra), true, 'foreground admission remains available');
            await assert.rejects(cache.completeForExport(book), error => error instanceof PdfCacheCompletionError && error.reason === 'busy');
            blocking = false; releases.forEach(release => release.resolve());
            await completing;
            const ordered = [...requests].sort((a, b) => a.start - b.start);
            assert.ok(ordered.every((request, index) => request.output === book && request.end - request.start <= chunk
                && request.start >= 100 && request.end <= bytes.length - 128
                && (request.end <= chunk || request.start >= 2 * chunk)
                && (!index || request.start >= ordered[index - 1].end)));
            assert.strictEqual(ordered.reduce((sum, request) => sum + request.end - request.start, 0), bytes.length - initial);
            assert.strictEqual((await cache.snapshot(book)).complete, true);
            assert.strictEqual(peak, 4, 'the four-worker limit holds through the complete operation');
            assert.strictEqual(progress[0], initial); assert.strictEqual(progress.at(-1), bytes.length);
            assert.ok(progress.every((value, index) => !index || value >= progress[index - 1]));
            const count = requests.length;
            await cache.completeForExport(book);
            assert.strictEqual(requests.length, count, 'a complete cache hit does not fetch again');
            const target = path.join(dir, 'export.pdf');
            assert.strictEqual(await cache.copyComplete(book, target), true);
            assert.deepStrictEqual(new Uint8Array(fs.readFileSync(target)), bytes);
        } finally { blocking = false; releases.forEach(release => release.resolve()); await completing.catch(() => {}); }
    });

    it('pins the first range validator before parallel export and drains every changed-validator reply', async () => {
        const chunk = PDF_DISK_POLICY.exportRangeBytes, bytes = content(6 * chunk);
        const book = output(bytes.length), first = deferred<void>(), parallel = deferred<void>(), cancelled = deferred<void>();
        const requests: Array<{ request: PdfFillRequest, reply: ReturnType<typeof deferred<BridgeResponse>> }> = [];
        const cache = make(16 * chunk, { fetchRange: request => {
            const reply = deferred<BridgeResponse>(); requests.push({ request, reply });
            request.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
            if (requests.length === 1) { first.resolve(); }
            if (requests.length === 5) { parallel.resolve(); }
            return reply.promise;
        } });
        const abort = new AbortController();
        const completing = cache.completeForExport(book, { signal: abort.signal });
        let settled = false; void completing.then(() => { settled = true; }, () => { settled = true; });
        try {
            await first.promise;
            await cache.snapshot(book);
            assert.strictEqual(requests.length, 1, 'the first validator must be known before concurrency starts');
            requests[0].reply.resolve(response(bytes, requests[0].request.start, requests[0].request.end));
            await parallel.promise;
            assert.ok(requests.slice(1).every(({ request }) => request.validator?.name === 'etag' && request.validator.value === '"edition-a"'));
            const changed = requests[1]; changed.reply.resolve(response(bytes, changed.request.start, changed.request.end, '"changed"'));
            await cancelled.promise;
            assert.ok(requests.every(({ request }) => request.signal.aborted));
            assert.strictEqual(settled, false, 'completion waits for the other aborted transports to settle');
            requests.slice(2).forEach(({ request, reply }) => reply.resolve(response(bytes, request.start, request.end)));
            await assert.rejects(completing, error => error instanceof PdfCacheCompletionError && error.reason === 'validator');
            assert.strictEqual((await cache.snapshot(book)).covered, chunk, 'late replies cannot replace the pinned representation');
        } finally {
            abort.abort();
            requests.forEach(({ request, reply }) => reply.resolve(response(bytes, request.start, request.end)));
            await completing.catch(() => {});
        }
    });

    it('rejects invalid explicit-export ranges without another request or cache admission', async () => {
        const bytes = content(2000), book = output(bytes.length);
        for (const defect of ['status', 'range', 'encoding', 'length', 'validator']) {
            let requests = 0;
            const cache = make(1024 * 1024, { fetchRange: async request => {
                requests++;
                const reply = response(bytes, request.start, request.end);
                if (defect === 'status') { reply.status = 200; }
                if (defect === 'range') { reply.headers[0][1] = 'bytes 1-2000/2000'; }
                if (defect === 'encoding') { reply.headers.push(['content-encoding', 'gzip']); }
                if (defect === 'length') { reply.body = reply.body.subarray(1); }
                if (defect === 'validator') { reply.headers = reply.headers.filter(([name]) => name !== 'etag'); }
                return reply;
            } });
            await assert.rejects(cache.completeForExport(book), error => error instanceof PdfCacheCompletionError && error.reason === 'response', defect);
            assert.strictEqual(requests, 1, defect);
            assert.strictEqual((await cache.snapshot(book)).covered, 0, defect);
            await cache.dispose();
        }
    });

    it('fails an export budget check before downloading and stops after failed admission', async () => {
        const bytes = content(2000), book = output(bytes.length);
        let requests = 0;
        const fetchRange = async (request: PdfFillRequest) => { requests++; return response(bytes, request.start, request.end); };
        const small = make(1000, { fetchRange });
        await assert.rejects(small.completeForExport(book), error => error instanceof PdfCacheCompletionError && error.reason === 'budget');
        assert.strictEqual(requests, 0);
        await small.dispose();
        const cache = make(1024 * 1024, { fetchRange });
        cache.storeRange = async () => false;
        await assert.rejects(cache.completeForExport(book), error => error instanceof PdfCacheCompletionError && error.reason === 'admission');
        assert.strictEqual(requests, 1);
    });

    for (const operation of ['abort', 'replacement', 'dispose']) {
        it('drains explicit-export workers on ' + operation + ' without publishing late replies', async () => {
            const chunk = PDF_DISK_POLICY.exportRangeBytes, bytes = content(5 * chunk), book = output(bytes.length);
            const entered = deferred<void>(), requests: Array<{ request: PdfFillRequest, reply: ReturnType<typeof deferred<BridgeResponse>> }> = [];
            const cache = make(16 * chunk, { fetchRange: request => {
                const reply = deferred<BridgeResponse>(); requests.push({ request, reply });
                if (requests.length === 4) { entered.resolve(); }
                return reply.promise;
            } });
            await cache.storeRange(book, 0, 100, response(bytes, 0, 100));
            const abort = new AbortController(); let current = true, settled = false;
            const completing = cache.completeForExport(book, { signal: abort.signal, current: () => current });
            void completing.then(() => { settled = true; }, () => { settled = true; });
            let disposal: Promise<void> | undefined;
            try {
                await entered.promise;
                if (operation === 'abort') { abort.abort(); }
                if (operation === 'dispose') { disposal = cache.dispose(); }
                if (operation === 'replacement') {
                    current = false;
                    const stopped = deferred<void>(); requests[0].request.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
                    requests[0].reply.resolve(response(bytes, requests[0].request.start, requests[0].request.end));
                    await stopped.promise;
                }
                assert.ok(requests.every(({ request }) => request.signal.aborted));
                assert.strictEqual(settled, false, 'retiring transfers hold the operation until their real replies settle');
                requests.forEach(({ request, reply }) => reply.resolve(response(bytes, request.start, request.end)));
                await assert.rejects(completing, error => error instanceof PdfCacheCompletionError && error.reason === 'cancelled');
                await disposal;
                assert.strictEqual((await cache.snapshot(book)).covered, 100);
            } finally {
                abort.abort(); requests.forEach(({ request, reply }) => reply.resolve(response(bytes, request.start, request.end)));
                await completing.catch(() => {}); await disposal;
            }
        });
    }

    it('drains the local background transfer before explicit export takes its network slots', async () => {
        const bytes = content(PDF_DISK_POLICY.exportRangeBytes * 2), book = output(bytes.length), timers = new Timers();
        const entered = deferred<void>(), release = deferred<void>(), requests: PdfFillRequest[] = [];
        const cache = make(8 * PDF_DISK_POLICY.exportRangeBytes, { setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: async request => {
                requests.push(request);
                if (requests.length === 1) { entered.resolve(); await release.promise; }
                return response(bytes, request.start, request.end);
            } });
        const viewer = cache.createViewer(); viewer.setOutput(book); viewer.setActivity(true, true); timers.fire();
        await entered.promise;
        const completing = cache.completeForExport(book);
        try {
            assert.strictEqual(requests[0].signal.aborted, true);
            await cache.snapshot(book);
            assert.strictEqual(requests.length, 1, 'an aborted background response still owns its transfer until settlement');
            release.resolve(); await completing;
            assert.strictEqual((await cache.snapshot(book)).complete, true);
            assert.strictEqual((await cache.snapshot()).foreground, 0);
        } finally { release.resolve(); await completing.catch(() => {}); viewer.dispose(); }
    });

    it('keeps reads available while export admission waits for a foreign writer and cancels that wait', async () => {
        const bytes = content(2000), book = output(bytes.length), cache = make(1024 * 1024, { fetchRange: async request => response(bytes, request.start, request.end) });
        await cache.storeRange(book, 0, 100, response(bytes, 0, 100));
        const entered = deferred<void>(), original = cache.storeRange.bind(cache);
        cache.storeRange = (...args) => { entered.resolve(); return original(...args); };
        fs.writeFileSync(path.join(dir, '.writer'), liveToken());
        const abort = new AbortController(), completing = cache.completeForExport(book, { signal: abort.signal });
        try {
            await entered.promise;
            assert.deepStrictEqual((await cache.readRange(book, 0, 100))?.body, bytes.slice(0, 100));
            abort.abort();
            await assert.rejects(completing, error => error instanceof PdfCacheCompletionError && error.reason === 'cancelled');
            assert.strictEqual((await cache.snapshot(book)).covered, 100);
        } finally { abort.abort(); fs.unlinkSync(path.join(dir, '.writer')); await completing.catch(() => {}); }
    });

    it('stops if an admitted export interval disappears instead of repeatedly downloading it', async () => {
        const bytes = content(2000), book = output(bytes.length); let requests = 0;
        const cache = make(1024 * 1024, { fetchRange: async request => { requests++; return response(bytes, request.start, request.end); } });
        const original = cache.storeRange.bind(cache);
        cache.storeRange = async (...args) => {
            const stored = await original(...args);
            const changed = deferred<void>(), stop = cache.onChange(() => changed.resolve());
            try { fs.unlinkSync(path.join(dir, hash(bytes))); await changed.promise; }
            finally { stop(); }
            return stored;
        };
        await assert.rejects(cache.completeForExport(book), error => error instanceof PdfCacheCompletionError && error.reason === 'evicted');
        assert.strictEqual(requests, 1);
    });

    it('does not admit ignored, shifted, compressed, truncated, or unvalidated range responses', async () => {
        const bytes = content(2000);
        const book = output(bytes.length);
        const cache = make();
        const good = response(bytes, 0, 100);
        const bad = [
            { ...good, status: 200 },
            { ...good, headers: [['content-range', 'bytes 1-100/2000'], ['etag', '"edition-a"']] as Array<[string, string]> },
            { ...good, headers: [...good.headers, ['content-encoding', 'gzip']] as Array<[string, string]> },
            { ...good, body: good.body.subarray(0, 99) },
            { ...good, headers: good.headers.filter(([name]) => name !== 'etag') },
            { ...good, headers: [['content-range', 'bytes 0-99/2000'], ['etag', 'W/"weak"']] as Array<[string, string]> },
        ];
        for (const reply of bad) { assert.strictEqual(await cache.storeRange(book, 0, 100, reply), false); }
        assert.strictEqual((await cache.snapshot(book)).bytes, 0);
        assert.strictEqual(await cache.storeRange(book, 0, 100, good), true);
        assert.deepStrictEqual((await cache.readRange(book, 0, 100))?.body, good.body);
        const newer = response(content(bytes.length, 7), 100, 200, '"edition-b"');
        assert.strictEqual(await cache.storeRange(book, 100, 200, newer), true);
        assert.strictEqual(await cache.readRange(book, 0, 200), undefined, 'a changed validator cannot combine two representations');
        assert.deepStrictEqual((await cache.readRange(book, 100, 200))?.body, newer.body);
    });

    it('reserves admission before concurrent writes and includes old piece files in the same total', async () => {
        const budget = 4096;
        const legacy = content(1200, 19);
        fs.writeFileSync(path.join(dir, hash(legacy)), legacy);
        const cache = make(budget);
        let peak = 0;
        const stop = cache.onChange(() => { peak = Math.max(peak, diskBytes(dir)); });
        await Promise.all(Array.from({ length: 30 }, (_, i) => {
            const bytes = content(400, i); return cache.put(hash(bytes), bytes);
        }));
        stop();
        const snapshot = await cache.snapshot();
        assert.ok(peak <= budget, 'no temporary or admitted-write peak exceeds the total budget');
        assert.ok(snapshot.bytes <= budget);
        assert.strictEqual(snapshot.reserved, 0);
        assert.strictEqual(snapshot.bytes, diskBytes(dir));
        assert.strictEqual(snapshot.maxBytes, budget);
        assert.ok(snapshot.files < 30, 'older unpinned data was evicted');
    });

    it('releases each admission and cleans interrupted data without removing live lock candidates', async () => {
        const bytes = content(400);
        const first = make();
        assert.strictEqual(await first.put(hash(bytes), bytes), true);
        const second = make();
        assert.strictEqual((await second.snapshot()).writer, false);
        assert.deepStrictEqual(await second.get(hash(bytes)), bytes);
        const different = content(400, 5);
        assert.strictEqual(await second.put(hash(different), different), true);
        await second.dispose();
        assert.strictEqual((await first.snapshot()).writer, false);
        assert.strictEqual(fs.existsSync(path.join(dir, '.writer')), false);
        await first.dispose();
        fs.writeFileSync(path.join(dir, hash(different) + '.crashed.tmp'), different);
        fs.writeFileSync(path.join(dir, 'build-' + 'a'.repeat(64) + '.json'), '{"version":');
        const liveCandidate = path.join(dir, '.lock-writer-' + 'a'.repeat(36));
        const deadCandidate = path.join(dir, '.lock-background-' + 'b'.repeat(36));
        fs.writeFileSync(liveCandidate, liveToken());
        fs.writeFileSync(deadCandidate, process.pid + ':0:dead-candidate');
        const restarted = make();
        assert.strictEqual((await restarted.snapshot()).writer, false);
        assert.strictEqual(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), true, 'snapshot performs no cleanup mutation');
        assert.strictEqual(await restarted.put(hash(different), different), true);
        assert.strictEqual(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
        assert.strictEqual(fs.existsSync(liveCandidate), true);
        assert.strictEqual(fs.existsSync(deadCandidate), false);
        assert.deepStrictEqual(await restarted.get(hash(bytes)), bytes);
        assert.ok((await restarted.snapshot()).bytes <= 4 * 1024 * 1024);
    });

    it('lets a restarted book accumulate while a live completed tiny document remains open', async () => {
        const tinyBytes = content(80), tiny = output(tinyBytes.length, 'tiny');
        const oldBookHost = make();
        assert.strictEqual(await oldBookHost.storeRange(tiny, 0, tinyBytes.length, response(tinyBytes, 0, tinyBytes.length)), true);
        const tinyHost = make();
        const tinyViewer = tinyHost.createViewer();
        tinyViewer.setOutput(tiny); tinyViewer.setActivity(true, true);
        assert.strictEqual((await tinyHost.snapshot(tiny)).complete, true);
        await oldBookHost.dispose();
        await tinyHost.snapshot(tiny);
        const timers = new Timers(), bytes = content(2000), book = output(bytes.length, 'book-restarted');
        let requests = 0;
        const bookHost = make(4 * 1024 * 1024, { setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: async request => { requests++; return response(bytes, request.start, request.end); } });
        const viewer = bookHost.createViewer();
        viewer.setOutput(book); viewer.setActivity(true, true);
        assert.strictEqual(timers.fire(), true);
        await bookHost.settled();
        assert.strictEqual(requests, 1, 'a completed live window cannot monopolize admission');
        assert.strictEqual((await bookHost.snapshot(book)).complete, true);
        assert.strictEqual((await tinyHost.snapshot(tiny)).complete, true);
    });

    it('merges cross-host range updates and reserves one shared budget for simultaneous admissions', async () => {
        const budget = 4096, bytes = content(300), book = output(bytes.length);
        const a = make(budget), b = make(budget);
        await Promise.all([a.snapshot(book), b.snapshot(book)]);
        let peak = 0;
        const original = fs.promises.writeFile;
        fs.promises.writeFile = (async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            // Data writes hold the admission lease; lock candidates do not. Sampling a
            // candidate can race another host's rename and throw into its acquisition.
            if (/^(?:[a-f0-9]{64}|(?:build|object)-[a-f0-9]{64}\.json)\..+\.tmp$/.test(path.basename(String(args[0])))) {
                peak = Math.max(peak, diskBytes(dir));
            }
            return result;
        }) as typeof original;
        cleanups.push(() => { fs.promises.writeFile = original; });
        assert.deepStrictEqual(await Promise.all([
            a.storeRange(book, 0, 150, response(bytes, 0, 150)),
            b.storeRange(book, 150, 300, response(bytes, 150, 300)),
        ]), [true, true]);
        assert.deepStrictEqual((await a.readRange(book, 0, 300))?.body, bytes, 'fresh manifests preserve both disjoint commits');
        const writes = Array.from({ length: 20 }, (_, index) => {
            const body = content(400, index + 1);
            return (index % 2 ? a : b).put(hash(body), body);
        });
        assert.ok((await Promise.all(writes)).every(Boolean));
        assert.ok(peak <= budget, 'temporary blobs and replacement maps stay inside the same total budget');
        const states = await Promise.all([a.snapshot(), b.snapshot()]);
        assert.ok(states.every(state => state.bytes === diskBytes(dir) && state.reserved === 0));
    });

    it('keeps cached reads available while a foreign writer blocks an abortable admission', async () => {
        for (const ending of ['abort', 'dispose']) {
            const bytes = content(200), existing = content(70, 3);
            fs.writeFileSync(path.join(dir, hash(existing)), existing);
            fs.writeFileSync(path.join(dir, '.writer'), liveToken());
            const waitTimers = new Timers(), attempted = deferred<void>();
            const cache = make(4096, { setWaitTimer: waitTimers.set, clearWaitTimer: waitTimers.clear });
            const original = fs.promises.readFile;
            fs.promises.readFile = (async (...args: Parameters<typeof original>) => {
                const result = await original(...args);
                if (String(args[0]) === path.join(dir, '.writer')) { attempted.resolve(); }
                return result;
            }) as typeof original;
            const controller = new AbortController();
            let settled = false;
            const pending = cache.put(hash(bytes), bytes, controller.signal).then(value => { settled = true; return value; });
            try {
                await attempted.promise;
                assert.deepStrictEqual(await cache.get(hash(existing)), existing, 'foreign contention does not park the local read queue');
                assert.strictEqual(settled, false, 'a busy writer waits for release instead of dropping received bytes');
                assert.strictEqual(waitTimers.tasks.size, 1, 'one active watchdog serves the waiting cache');
                if (ending === 'abort') { controller.abort(); } else { await cache.dispose(); }
                assert.strictEqual(await pending, false);
                assert.strictEqual(waitTimers.tasks.size, 0);
                fs.unlinkSync(path.join(dir, '.writer'));
                await turn();
                assert.strictEqual(fs.existsSync(path.join(dir, hash(bytes))), false, 'cancelled work cannot publish on a later release');
            } finally {
                controller.abort();
                fs.promises.readFile = original;
                await cache.dispose();
                fs.rmSync(path.join(dir, '.writer'), { force: true });
            }
        }
    });

    it('cancels a queued local admission promptly while the earlier write remains blocked', async () => {
        fs.writeFileSync(path.join(dir, '.writer'), liveToken());
        const attempted = deferred<void>(), cache = make(4096);
        const original = fs.promises.readFile;
        fs.promises.readFile = (async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (String(args[0]) === path.join(dir, '.writer')) { attempted.resolve(); }
            return result;
        }) as typeof original;
        const a = new AbortController(), b = new AbortController();
        const firstBytes = content(200), secondBytes = content(300, 7);
        let firstSettled = false, secondSettled = false;
        const first = cache.put(hash(firstBytes), firstBytes, a.signal).then(value => { firstSettled = true; return value; });
        let second: Promise<boolean> | undefined;
        try {
            await attempted.promise;
            await cache.snapshot();
            second = cache.put(hash(secondBytes), secondBytes, b.signal).then(value => { secondSettled = true; return value; });
            b.abort();
            await turn();
            assert.strictEqual(secondSettled, true, 'a cancelled queued caller does not wait behind another host\'s lock');
            assert.strictEqual(await second, false);
            assert.strictEqual(firstSettled, false, 'the earlier live request remains serialized and waiting');
            a.abort();
            assert.strictEqual(await first, false);
            fs.unlinkSync(path.join(dir, '.writer'));
            await cache.settled();
            assert.strictEqual(fs.existsSync(path.join(dir, hash(secondBytes))), false);
        } finally {
            a.abort(); b.abort(); fs.promises.readFile = original;
            fs.rmSync(path.join(dir, '.writer'), { force: true });
            await Promise.all([first, second]);
        }
    });

    it('performs no writer acquisition or watchdog polling for idle cache reads and snapshots', async () => {
        const bytes = content(200), seed = make();
        assert.strictEqual(await seed.put(hash(bytes), bytes), true);
        await seed.dispose();
        const timers = new Timers(), waitTimers = new Timers();
        const cache = make(4096, { setTimer: timers.set, clearTimer: timers.clear,
            setWaitTimer: waitTimers.set, clearWaitTimer: waitTimers.clear });
        const original = fs.promises.link;
        const originalReadDir = fs.promises.readdir;
        let claims = 0;
        let scans = 0;
        fs.promises.link = (async (source: fs.PathLike, target: fs.PathLike) => {
            if (['.writer', '.background'].includes(path.basename(String(target)))) { claims++; }
            return original(source, target);
        }) as typeof original;
        fs.promises.readdir = (async (...args: Parameters<typeof originalReadDir>) => {
            scans++; return originalReadDir(...args);
        }) as typeof originalReadDir;
        cleanups.push(() => { fs.promises.link = original; fs.promises.readdir = originalReadDir; });
        for (let i = 0; i < 5; i++) {
            assert.deepStrictEqual(await cache.get(hash(bytes)), bytes);
            assert.strictEqual((await cache.snapshot()).writer, false);
            await turn();
        }
        assert.strictEqual(claims, 0);
        assert.strictEqual(scans, 1, 'LRU timestamp updates do not rescan immutable cached data');
        assert.strictEqual(timers.tasks.size + waitTimers.tasks.size, 0);
        assert.strictEqual(fs.existsSync(path.join(dir, '.writer')), false);
    });

    it('recovers when an owner dies after a writer waiter is registered and stops its watchdog', async () => {
        const helper = path.join(dir, 'dying-owner.cjs');
        fs.writeFileSync(helper, [
            "const fs = require('fs'); const path = require('path');",
            "const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8');",
            "const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];",
            "fs.writeFileSync(path.join(process.argv[2], '.writer'), process.pid + ':' + start + ':test-owner');",
            "process.send('ready'); process.on('message', () => {});",
        ].join('\n'));
        const child = fork(helper, [dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const closed = new Promise<void>(resolve => child.once('exit', () => resolve()));
        const waitTimers = new Timers(), attempted = deferred<void>();
        const original = fs.promises.readFile;
        const cache = make(4096, { setWaitTimer: waitTimers.set, clearWaitTimer: waitTimers.clear });
        try {
            await new Promise<void>(resolve => child.once('message', () => resolve()));
            fs.promises.readFile = (async (...args: Parameters<typeof original>) => {
                const result = await original(...args);
                if (String(args[0]) === path.join(dir, '.writer')) { attempted.resolve(); }
                return result;
            }) as typeof original;
            const bytes = content(300);
            let settled = false;
            const pending = cache.put(hash(bytes), bytes).then(value => { settled = true; return value; });
            await attempted.promise;
            await cache.snapshot();
            assert.strictEqual(settled, false);
            assert.strictEqual(waitTimers.tasks.size, 1);
            child.kill('SIGKILL');
            await closed;
            assert.strictEqual(waitTimers.fire(), true, 'process death has no directory unlink event');
            assert.strictEqual(await pending, true);
            assert.strictEqual(waitTimers.tasks.size, 0);
            assert.deepStrictEqual(await cache.get(hash(bytes)), bytes);
        } finally {
            fs.promises.readFile = original;
            child.kill('SIGKILL');
            await closed;
            await cache.dispose();
        }
    });

    it('holds one global background transfer while leaving foreground admission free', async () => {
        const aTimers = new Timers(), bTimers = new Timers();
        const started = deferred<PdfFillRequest>(), reply = deferred<BridgeResponse>();
        cleanups.push(() => reply.resolve({ id: 0, status: 499, statusText: 'Cancelled', headers: [], body: new Uint8Array() }));
        const bytes = content(2000), book = output(bytes.length);
        let bRequests = 0;
        const a = make(4 * 1024 * 1024, { setTimer: aTimers.set, clearTimer: aTimers.clear,
            fetchRange: request => { started.resolve(request); return reply.promise; } });
        const b = make(4 * 1024 * 1024, { setTimer: bTimers.set, clearTimer: bTimers.clear,
            fetchRange: async request => { bRequests++; return response(bytes, request.start, request.end); } });
        const av = a.createViewer(), bv = b.createViewer();
        av.setOutput(book); av.setActivity(true, true);
        assert.strictEqual(aTimers.fire(), true);
        const request = await started.promise;
        assert.strictEqual(fs.existsSync(path.join(dir, '.writer')), false, 'network never holds the admission mutex');
        bv.setOutput(book); bv.setActivity(true, true);
        assert.strictEqual(bTimers.fire(), true);
        await b.snapshot(); await turn();
        assert.strictEqual(bRequests, 0);
        const foreground = content(90, 7);
        assert.strictEqual(await b.put(hash(foreground), foreground), true);
        const end = a.beginForeground();
        assert.strictEqual(request.signal.aborted, true);
        await turn();
        assert.strictEqual(bRequests, 0, 'an abort-ignoring transport retains the global slot until settlement');
        reply.resolve(response(bytes, request.start, request.end));
        await Promise.all([a.settled(), b.settled()]);
        assert.strictEqual(bRequests, 1);
        assert.strictEqual((await b.snapshot(book)).complete, true);
        end(); av.dispose(); bv.dispose();
    });

    it('rechecks a waiting host\'s gap after another host completes the global background transfer', async () => {
        const aTimers = new Timers(), bTimers = new Timers();
        const started = deferred<PdfFillRequest>(), reply = deferred<BridgeResponse>();
        cleanups.push(() => reply.resolve({ id: 0, status: 499, statusText: 'Cancelled', headers: [], body: new Uint8Array() }));
        const bytes = content(2000), book = output(bytes.length);
        let duplicateRequests = 0;
        const a = make(4 * 1024 * 1024, { setTimer: aTimers.set, clearTimer: aTimers.clear,
            fetchRange: request => { started.resolve(request); return reply.promise; } });
        const b = make(4 * 1024 * 1024, { setTimer: bTimers.set, clearTimer: bTimers.clear,
            fetchRange: async request => { duplicateRequests++; return response(bytes, request.start, request.end); } });
        const av = a.createViewer(), bv = b.createViewer();
        av.setOutput(book); av.setActivity(true, true);
        assert.strictEqual(aTimers.fire(), true);
        const request = await started.promise;
        bv.setOutput(book); bv.setActivity(true, true);
        assert.strictEqual(bTimers.fire(), true);
        await b.snapshot(); await turn();
        reply.resolve(response(bytes, request.start, request.end));
        await Promise.all([a.settled(), b.settled()]);
        assert.strictEqual(duplicateRequests, 0, 'winning the lease rechecks bytes published while this host waited');
        assert.strictEqual((await b.snapshot(book)).complete, true);
        assert.strictEqual(fs.existsSync(path.join(dir, '.background')), false);
    });

    it('reuses fully verified object shards in a new build without storing its object ID in the content hash', async () => {
        const piece = content(1024);
        const prefix = Buffer.from('12 0 obj\n');
        const bytes = new Uint8Array(Buffer.concat([Buffer.from('header\n'), prefix, piece, Buffer.from('\nendobj\n')]));
        const start = 7 + prefix.length;
        const book = output(bytes.length, 'old', [{ start, end: start + piece.length, hash: hash(piece), objectId: prefix.toString() }]);
        const cache = make();
        assert.strictEqual(await cache.storeRange(book, 0, bytes.length, response(bytes, 0, bytes.length)), true);
        assert.deepStrictEqual(await cache.get(hash(piece)), piece);
        const newPrefix = Buffer.from('34567 0 obj\n');
        const movedStart = 200 + newPrefix.length;
        const newer = output(4000, 'new', [{ start: movedStart, end: movedStart + piece.length, hash: hash(piece), objectId: newPrefix.toString() }]);
        const hit = await cache.readRange(newer, 200, movedStart + piece.length);
        assert.deepStrictEqual(hit?.body, new Uint8Array(Buffer.concat([newPrefix, piece])));
        assert.strictEqual(await cache.readRange(newer, 0, 200), undefined, 'unseen text of a new build remains a miss');
        await cache.dispose();
        const restarted = make();
        assert.deepStrictEqual(await restarted.get(hash(piece)), piece, 'the verified object map survives the process');
        assert.deepStrictEqual((await restarted.readRange(newer, 200, movedStart + piece.length))?.body, hit?.body);
    });

    it('keeps one background slot through rapid replacement and rejects an old generation that ignores abort', async () => {
        const timers = new Timers();
        const started = deferred<PdfFillRequest>();
        const firstReply = deferred<BridgeResponse>();
        cleanups.push(() => firstReply.resolve({ id: 0, status: 499, statusText: 'Cancelled', headers: [], body: new Uint8Array() }));
        const requests: PdfFillRequest[] = [];
        const cache = make(PDF_DISK_POLICY.defaultMaxBytes, { setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: request => {
                requests.push(request);
                if (requests.length === 1) { started.resolve(request); return firstReply.promise; }
                return Promise.resolve({ id: 0, status: 206, statusText: 'Partial Content', body: content(request.end - request.start, 9),
                    headers: [['content-range', 'bytes ' + request.start + '-' + (request.end - 1) + '/' + request.output.file.size], ['etag', '"new"']] });
            } });
        const viewer = cache.createViewer();
        const old = output(1_608_644_855, 'old');
        viewer.setOutput(old); viewer.setActivity(true, true);
        assert.strictEqual(timers.fire(), true);
        const inFlight = await started.promise;
        let latest = old;
        for (let i = 0; i < 25; i++) {
            latest = output(1_608_644_855, 'replacement-' + i);
            viewer.setOutput(latest); viewer.setActivity(true, true);
        }
        assert.strictEqual(inFlight.signal.aborted, true);
        assert.strictEqual(timers.fire(), false, 'no second job while old transport has not settled');
        assert.strictEqual((await cache.snapshot()).bytes, 0, 'build churn reserves no book-sized files');
        firstReply.resolve({ id: 0, status: 206, statusText: 'Partial Content', body: content(inFlight.end - inFlight.start),
            headers: [['content-range', 'bytes 0-' + (inFlight.end - 1) + '/' + old.file.size], ['etag', '"old"']] });
        await cache.settled();
        assert.strictEqual((await cache.snapshot(old)).covered, 0);
        assert.strictEqual(timers.fire(), true);
        await cache.settled();
        assert.strictEqual(requests.length, 2);
        assert.strictEqual(requests[1].output.file.build, latest.file.build);
        assert.strictEqual((await cache.snapshot(latest)).covered, PDF_DISK_POLICY.chunkBytes);
        assert.ok((await cache.snapshot()).bytes < PDF_DISK_POLICY.chunkBytes + 2048);
        viewer.dispose();
    });

    it('shares the fill lease across viewers and aborts it synchronously before foreground demand', async () => {
        const timers = new Timers();
        const started = deferred<PdfFillRequest>();
        const reply = deferred<BridgeResponse>();
        cleanups.push(() => reply.resolve({ id: 0, status: 499, statusText: 'Cancelled', headers: [], body: new Uint8Array() }));
        const bytes = content(1000);
        const book = output(bytes.length);
        let count = 0;
        const cache = make(1024 * 1024, { setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: request => { count++; started.resolve(request); return reply.promise; } });
        const a = cache.createViewer();
        const b = cache.createViewer();
        a.setOutput(book); b.setOutput(book);
        a.setActivity(true, true); b.setActivity(true, false);
        assert.strictEqual(timers.fire(), false, 'one busy visible viewer pauses all accumulation');
        b.setActivity(true, true);
        assert.strictEqual(timers.fire(), true);
        const request = await started.promise;
        assert.strictEqual(count, 1);
        const endForeground = cache.beginForeground();
        assert.strictEqual(request.signal.aborted, true);
        b.dispose();
        assert.strictEqual(timers.fire(), false, 'disposal cannot allocate a replacement slot before drain');
        reply.resolve(response(bytes, request.start, request.end));
        await cache.settled();
        assert.strictEqual((await cache.snapshot(book)).covered, 0);
        assert.strictEqual(timers.fire(), false, 'foreground work retains priority after background drains');
        endForeground();
        assert.strictEqual(timers.tasks.size, 1);
        a.setActivity(false, false);
        assert.strictEqual(timers.fire(), false);
        a.dispose();
        assert.strictEqual((await cache.snapshot()).viewers, 0);
    });

    it('serves both loaders single ranges, multipart dynamic gaps, and content URLs from the same stored bytes', async () => {
        const bytes = content(1000);
        const pieceStart = 50;
        const piece = bytes.subarray(pieceStart, 500);
        const book = output(bytes.length, 'shared', [{ start: pieceStart, end: 500, hash: hash(piece) }]);
        const cache = make();
        assert.strictEqual(await cache.storeRange(book, 0, bytes.length, response(bytes, 0, bytes.length)), true);
        const bridge = new PdfFetchBridge(outputsOf(book.downloadDomain, book.projectId), cache, { output: book });
        try {
            const single = await bridge.handle({ id: 1, url: book.url, headers: [['Range', 'bytes=10-20']] });
            assert.strictEqual(single.status, 206);
            assert.deepStrictEqual(single.body, bytes.slice(10, 21));
            const multi = await bridge.handle({ id: 2, url: book.url, headers: [['Range', 'bytes=990-999,0-8,4-11,0-8']] });
            assert.strictEqual(multi.status, 206);
            assert.deepStrictEqual(multipartParts(multi), [[990, 1000], [0, 9], [4, 12], [0, 9]].map(([start, end]) => ({
                range: 'bytes ' + start + '-' + (end - 1) + '/1000', body: bytes.slice(start, end),
            })), 'multipart order, overlaps and duplicate ranges retain their requested bytes');
            const pieceUrl = book.downloadDomain + '/project/project-a/user/user-a/content/another-build/' + hash(piece);
            const object = await bridge.handle({ id: 3, url: pieceUrl });
            assert.strictEqual(object.status, 200);
            assert.deepStrictEqual(object.body, piece);
            bridge.setOutput(output(bytes.length, 'new'));
            await assert.rejects(bridge.handle({ id: 4, url: output(bytes.length, 'new').url, headers: [['Range', 'bytes=0-8']] }), /fetch|connect/i);
        } finally { bridge.dispose(); }
    });

    for (const evictCaptured of [false, true]) {
        it(evictCaptured
            ? 'rejects the whole multipart cache hit if its captured representation is evicted after the first read'
            : 'keeps one multipart representation when another host changes the validator after its first part is read', async () => {
            const first = content(1000), second = content(1000, 19), book = output(first.length);
            const writer = make(), cache = make();
            assert.strictEqual(await writer.storeRange(book, 0, first.length, response(first, 0, first.length)), true);
            await cache.snapshot(book);
            const original = (cache as any).readPlan.bind(cache);
            let transition = false, plansRead = 0;
            (cache as any).readPlan = async function* (...args: any[]) {
                plansRead++;
                for await (const bytes of original(...args)) {
                    yield bytes;
                    if (!transition) {
                        transition = true;
                        const observed = deferred<void>(), stop = cache.onChange(() => observed.resolve());
                        try {
                            assert.strictEqual(await writer.storeRange(book, 0, second.length,
                                response(second, 0, second.length, '"edition-b"')), true);
                            await observed.promise;
                            if (evictCaptured) { fs.unlinkSync(path.join(dir, hash(first))); }
                        } finally { stop(); }
                    }
                }
            };
            const bridge = new PdfFetchBridge(outputsOf(book.downloadDomain, book.projectId), cache, { output: book });
            try {
                const pending = bridge.handle({ id: 1, url: book.url, headers: [['Range', 'bytes=0-8,990-999']] });
                let result: BridgeResponse | undefined;
                if (evictCaptured) {
                    // The fixture's origin is unavailable. A whole cache miss must reach it,
                    // instead of publishing the already-read prefix with a different suffix.
                    await assert.rejects(pending, /fetch|connect/i);
                } else { result = await pending; }
                assert.strictEqual(transition, true, 'the foreign write must occur while this response is being read');
                assert.strictEqual(plansRead, 2, 'both response parts must pass through the controlled read seam');
                assert.strictEqual((await writer.readRange(book, 990, 1000))?.validator?.value, '"edition-b"');
                if (!result) {
                    assert.strictEqual(fs.existsSync(path.join(dir, hash(first))), false, 'the captured blob was actually evicted');
                    return;
                }
                assert.strictEqual(result.headers.find(([name]) => name === 'etag')?.[1], '"edition-a"');
                assert.deepStrictEqual(multipartParts(result), [
                    { range: 'bytes 0-8/1000', body: first.slice(0, 9) },
                    { range: 'bytes 990-999/1000', body: first.slice(990) },
                ], 'immutable captured bytes cannot be relabelled or mixed with the new representation');
            } finally { bridge.dispose(); (cache as any).readPlan = original; }
        });
    }

    it('sends cached conditional ranges to the origin and cancels its full response when If-Range does not match', async () => {
        const first = content(1000), second = content(1000, 19);
        const requests: Array<{ range?: string, ifRange?: string | string[] }> = [];
        const cancelled = deferred<void>();
        const server = http.createServer((request, reply) => {
            requests.push({ range: request.headers.range, ifRange: request.headers['if-range'] });
            reply.setHeader('ETag', '"edition-b"');
            if (request.headers['if-range'] === '"edition-b"') {
                reply.setHeader('Content-Range', 'bytes 0-99/' + second.length);
                reply.writeHead(206); reply.end(second.subarray(0, 100));
            } else {
                // A false condition ignores Range. Do not send a body: the bridge must cancel
                // after the status rather than wait for or allocate the complete document.
                reply.setHeader('Content-Length', String(second.length));
                reply.on('close', () => cancelled.resolve());
                reply.writeHead(200); reply.flushHeaders();
            }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const domain = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        const book = output(first.length); book.downloadDomain = domain; book.url = domain + book.file.url;
        const cache = make();
        const bridge = new PdfFetchBridge(outputsOf(domain, book.projectId), cache, { output: book });
        try {
            assert.strictEqual(await cache.storeRange(book, 0, first.length, response(first, 0, first.length)), true);
            const result = await bridge.handle({ id: 1, url: book.url, headers: [['Range', 'bytes=0-99'], ['If-Range', '"edition-b"']] });
            assert.deepStrictEqual(requests, [{ range: 'bytes=0-99', ifRange: '"edition-b"' }], 'a cached 206 cannot decide the origin condition');
            assert.strictEqual(result.status, 206);
            assert.deepStrictEqual(result.body, second.slice(0, 100));
            assert.strictEqual(result.headers.find(([name]) => name === 'etag')?.[1], '"edition-b"');
            await assert.rejects(bridge.handle({ id: 2, url: book.url,
                headers: [['Range', 'bytes=0-99'], ['If-Range', '"edition-a"']] }), /ignored the requested byte ranges/);
            await cancelled.promise;
            assert.strictEqual(requests.length, 2);
            assert.strictEqual(requests[1].ifRange, '"edition-a"');
        } finally {
            bridge.dispose(); server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('refreshes another window and permits filling while both hosts remain open', async () => {
        const bytes = content(2000);
        const book = output(bytes.length);
        const first = make();
        const original = content(400);
        assert.strictEqual(await first.put(hash(original), original), true);
        const timers = new Timers();
        let requests = 0;
        const second = make(4 * 1024 * 1024, { setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: async request => { requests++; return response(bytes, request.start, request.end); } });
        assert.strictEqual((await second.snapshot()).writer, false);
        const observedChange = deferred<void>();
        const stop = second.onChange(() => observedChange.resolve());
        const later = content(400, 9);
        assert.strictEqual(await first.put(hash(later), later), true);
        await observedChange.promise;
        stop();
        assert.deepStrictEqual(await second.get(hash(later)), later, 'readonly window observes a newly published hash');
        const viewer = second.createViewer();
        viewer.setOutput(book); viewer.setActivity(true, true);
        assert.strictEqual(timers.fire(), true);
        await second.settled();
        assert.strictEqual(requests, 1);
        assert.strictEqual((await second.snapshot(book)).complete, true);
        assert.strictEqual((await first.snapshot(book)).complete, true);
        assert.strictEqual((await second.snapshot()).writer, false);
        viewer.dispose();
    });

    it('bounds transient build metadata and repairs a corrupt same-sized piece on verified admission', async () => {
        const bytes = content(500);
        fs.writeFileSync(path.join(dir, hash(bytes)), content(bytes.length, 7));
        const cache = make();
        assert.strictEqual(await cache.put(hash(bytes), bytes), true);
        assert.deepStrictEqual(await cache.get(hash(bytes)), bytes);
        for (let i = 0; i < PDF_DISK_POLICY.memoryManifests * 3; i++) {
            await cache.readRange(output(1_608_644_855, 'interrupted-' + i), 0, 10);
        }
        const state = await cache.snapshot();
        assert.ok(state.memoryManifests <= PDF_DISK_POLICY.memoryManifests * 2);
        assert.strictEqual(state.files, 1, 'unreceived generations create no persisted manifests');
        assert.strictEqual(state.bytes, bytes.length);
    });

    it('excludes a corrupt range on read and repairs valid incoming bytes under fresh ownership', async () => {
        const bytes = content(400), book = output(bytes.length), seed = make();
        assert.strictEqual(await seed.storeRange(book, 0, bytes.length, response(bytes, 0, bytes.length)), true);
        fs.writeFileSync(path.join(dir, hash(bytes)), content(bytes.length, 9));
        const reader = make();
        assert.strictEqual(await reader.readRange(book, 0, bytes.length), undefined);
        assert.strictEqual((await reader.snapshot(book)).covered, 0, 'known corrupt bytes cannot suppress incoming range repair');
        assert.strictEqual(await reader.storeRange(book, 0, bytes.length, response(bytes, 0, bytes.length)), true);
        assert.deepStrictEqual((await reader.readRange(book, 0, bytes.length))?.body, bytes);

        fs.writeFileSync(path.join(dir, hash(bytes)), content(bytes.length, 5));
        const delayedReader = make(), repairingHost = make();
        assert.strictEqual(await delayedReader.readRange(book, 0, bytes.length), undefined);
        assert.strictEqual(await repairingHost.put(hash(bytes), bytes), true);
        const other = content(70, 3);
        assert.strictEqual(await delayedReader.put(hash(other), other), true);
        assert.deepStrictEqual((await delayedReader.readRange(book, 0, bytes.length))?.body, bytes,
            'a delayed suspicion cannot delete another host\'s verified repair');
    });

    it('excludes a rejected aggregate object map from ranges and revalidates it before cleanup', async () => {
        const bytes = content(PDF_DISK_POLICY.chunkBytes * 2 + 71), pieceHash = hash(bytes);
        const book = output(bytes.length, 'source', [{ start: 0, end: bytes.length, hash: pieceHash }]);
        const seed = make();
        assert.strictEqual(await seed.storeRange(book, 0, bytes.length, response(bytes, 0, bytes.length)), true);
        const objectFile = path.join(dir, 'object-' + pieceHash + '.json');
        const corrupted = JSON.parse(fs.readFileSync(objectFile, 'utf8'));
        corrupted.parts[0].hash = corrupted.parts[1].hash;
        fs.writeFileSync(objectFile, JSON.stringify(corrupted));
        const reader = make();
        assert.strictEqual(await reader.get(pieceHash), undefined, 'valid component hashes cannot certify an incorrect combined object');
        const moved = output(bytes.length + 50, 'moved', [{ start: 50, end: bytes.length + 50, hash: pieceHash }]);
        assert.strictEqual(await reader.readRange(moved, 50, 150), undefined, 'a rejected cached map cannot serve range bytes');
        assert.strictEqual((await reader.snapshot(moved)).covered, 0);
        const other = content(100, 3);
        assert.strictEqual(await reader.put(hash(other), other), true);
        assert.strictEqual(fs.existsSync(objectFile), false, 'structurally valid metadata still needs its aggregate hash checked');
        assert.strictEqual(await reader.readRange(moved, 50, 150), undefined);
    });

    it('aborts queued content-piece admission when its foreground bridge request is cancelled', async () => {
        const bytes = content(300), attempted = deferred<void>();
        const server = http.createServer((_request, reply) => { reply.writeHead(200); reply.end(bytes); });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const domain = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        const book = output(bytes.length); book.downloadDomain = domain; book.url = domain + book.file.url;
        fs.writeFileSync(path.join(dir, '.writer'), liveToken());
        const cache = make(), bridge = new PdfFetchBridge(outputsOf(domain, book.projectId), cache, { output: book });
        const original = fs.promises.readFile;
        fs.promises.readFile = (async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (String(args[0]) === path.join(dir, '.writer')) { attempted.resolve(); }
            return result;
        }) as typeof original;
        const pending = bridge.handle({ id: 42, url: domain + '/project/project-a/user/user-a/content/build/' + hash(bytes) });
        const rejected = assert.rejects(pending, /aborted/i);
        try {
            await attempted.promise;
            bridge.abort(42);
            fs.unlinkSync(path.join(dir, '.writer'));
            await rejected;
            assert.strictEqual(fs.existsSync(path.join(dir, hash(bytes))), false, 'an aborted piece never publishes after a later lock release');
        } finally {
            bridge.dispose(); fs.promises.readFile = original;
            fs.rmSync(path.join(dir, '.writer'), { force: true });
            await pending.catch(() => {});
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('retains an old foreground response during replacement but does not reuse bytes for a changed output query', async () => {
        const bytes = content(1000);
        const arrived = deferred<void>();
        const release = deferred<void>();
        const requests: string[] = [];
        const server = http.createServer((request, reply) => {
            requests.push(request.url!);
            const send = () => {
                const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')!;
                const start = Number(range[1]), end = Number(range[2]) + 1;
                reply.setHeader('Content-Range', 'bytes ' + start + '-' + (end - 1) + '/' + bytes.length);
                reply.setHeader('ETag', '"http-edition"');
                reply.writeHead(206);
                reply.end(bytes.subarray(start, end));
            };
            if (requests.length === 1) { arrived.resolve(); void release.promise.then(send); } else { send(); }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const domain = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        const old = output(bytes.length, 'old');
        old.downloadDomain = domain;
        old.url = domain + old.file.url + '?compileGroup=group-a';
        const newer = { ...output(bytes.length, 'new'), downloadDomain: domain };
        newer.url = domain + newer.file.url;
        const cache = make();
        const bridge = new PdfFetchBridge(outputsOf(domain, 'project-a'), cache, { output: old });
        try {
            const pending = bridge.handle({ id: 1, url: old.url, headers: [['Range', 'bytes=0-99']] });
            await arrived.promise;
            bridge.setOutput(newer);
            release.resolve();
            assert.deepStrictEqual((await pending).body, bytes.slice(0, 100), 'old displayed PDF can finish its in-flight render');
            assert.deepStrictEqual((await cache.readRange(old, 0, 100))?.body, bytes.slice(0, 100));
            bridge.setOutput(old);
            const changed = old.url.replace('group-a', 'group-b');
            await bridge.handle({ id: 2, url: changed, headers: [['Range', 'bytes=0-99']] });
            assert.strictEqual(requests.length, 2, 'same pathname with different query is a network request');
            const different = { ...old, url: changed };
            assert.strictEqual(await cache.readRange(different, 0, 100), undefined, 'query identity is part of the persistent build key');
        } finally {
            release.resolve(); bridge.dispose();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('serializes two processes recovering a stale writer without unlinking the new transaction owner', async function () {
        this.timeout(10000);
        fs.writeFileSync(path.join(dir, '.writer'), process.pid + ':0:previous-process');
        const helper = path.join(dir, 'writer-race.cjs');
        fs.writeFileSync(helper, [
            "const fs = require('fs'), path = require('path'), crypto = require('crypto');",
            "const { PdfDiskCache } = require(process.argv[2]); const directory = process.argv[3];",
            "let go, read, remove, commit, close, holding=false, gateRead=true, gateUnlink=true;",
            "const started=new Promise(r=>go=r), readGate=new Promise(r=>read=r), unlinkGate=new Promise(r=>remove=r), commitGate=new Promise(r=>commit=r), shutdown=new Promise(r=>close=r);",
            "process.on('message',m=>{ if(m==='go')go(); if(m==='read')read(); if(m==='unlink')remove(); if(m==='commit')commit(); if(m==='status')process.send({phase:'status',holding}); if(m==='close'){read();remove();commit();close();} });",
            "const readFile=fs.promises.readFile.bind(fs.promises);",
            "fs.promises.readFile=async(...args)=>{const value=await readFile(...args); if(gateRead && args[0]===directory+'/.writer' && String(value).endsWith('previous-process')){gateRead=false;process.send({phase:'read-old'});await readGate;} return value;};",
            "const link=fs.promises.link.bind(fs.promises);",
            "fs.promises.link=async(source,target)=>{const value=await link(source,target);if(target===directory+'/.writer')gateUnlink=false;return value;};",
            "const unlink=fs.promises.unlink.bind(fs.promises);",
            "fs.promises.unlink=async file=>{if(gateUnlink && file===directory+'/.writer'){process.send({phase:'unlink'});await unlinkGate;const value=await unlink(file);process.send({phase:'unlink-done'});return value;}return unlink(file);};",
            "const writeFile=fs.promises.writeFile.bind(fs.promises);",
            "fs.promises.writeFile=async(...args)=>{const value=await writeFile(...args);if(/^[a-f0-9]{64}\\..*\\.tmp$/.test(path.basename(String(args[0])))){holding=true;process.send({phase:'holding'});await commitGate;holding=false;}return value;};",
            "(async()=>{process.send({phase:'ready'});await started;const cache=new PdfDiskCache(directory,4096);",
            "const bytes=Buffer.from('piece-'+process.pid), hash=crypto.createHash('sha256').update(bytes).digest('hex');",
            "const stored=await cache.put(hash,bytes);process.send({phase:'result',stored});await shutdown;await cache.dispose();process.disconnect();",
            "})().catch(e=>{process.send({phase:'failure',message:e.message});process.exitCode=1;process.disconnect();});",
        ].join('\n'));
        const children: ChildProcess[] = [];
        const events: Array<{ child: ChildProcess, message: any }> = [];
        const delayed = new Set<ChildProcess>();
        let wake = deferred<void>();
        const next = async () => {
            while (!events.length) { const waiting = wake; await waiting.promise; }
            const event = events.shift()!;
            if (event.message.phase === 'failure') { throw new Error(event.message.message); }
            if (event.message.phase === 'unlink') { delayed.add(event.child); }
            if (event.message.phase === 'unlink-done') { delayed.delete(event.child); }
            return event;
        };
        const exits: Promise<void>[] = [];
        for (let i = 0; i < 2; i++) {
            const child = fork(helper, [require.resolve('../core/pdfDiskCache'), dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            children.push(child);
            exits.push(new Promise<void>((resolve, reject) => {
                child.on('exit', code => code === 0 ? resolve() : reject(new Error('writer race helper exited ' + code)));
                child.on('error', reject);
            }));
            child.on('message', message => { events.push({ child, message }); const previous = wake; wake = deferred<void>(); previous.resolve(); });
        }
        try {
            for (let i = 0; i < 2; i++) { assert.strictEqual((await next()).message.phase, 'ready'); }
            children.forEach(child => child.send('go'));
            for (let i = 0; i < 2; i++) { assert.strictEqual((await next()).message.phase, 'read-old'); }
            children.forEach(child => child.send('read'));
            const removal = await next();
            assert.strictEqual(removal.message.phase, 'unlink');
            removal.child.send('unlink');
            let first: { child: ChildProcess, message: any };
            do { first = await next(); } while (first.message.phase !== 'holding');
            for (const child of [...delayed].filter(candidate => candidate !== first.child)) {
                child.send('unlink');
                let event;
                do { event = await next(); } while (event.child !== child || event.message.phase !== 'unlink-done');
            }
            assert.strictEqual(Number(fs.readFileSync(path.join(dir, '.writer'), 'utf8').split(':')[0]), first.child.pid,
                'a delayed stale recovery cannot remove the new transaction owner');
            const second = children.find(child => child !== first.child)!;
            second.send('status');
            let status;
            do { status = await next(); } while (status.child !== second || status.message.phase !== 'status');
            assert.strictEqual(status.message.holding, false, 'the other process cannot enter the critical section');
            first.child.send('commit');
            const results: boolean[] = [];
            while (results.length < 2) {
                const event = await next();
                if (event.message.phase === 'holding') { event.child.send('commit'); }
                if (event.message.phase === 'unlink') { event.child.send('unlink'); }
                if (event.message.phase === 'result') { results.push(event.message.stored); }
            }
            assert.deepStrictEqual(results, [true, true]);
            assert.strictEqual(fs.existsSync(path.join(dir, '.writer')), false);
            assert.strictEqual(fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 2);
        } finally {
            children.forEach(child => { if (child.connected) { child.send('close'); } });
            await Promise.all(exits);
        }
    });

    it('does not create a watcher when disposal races a delayed storage initialization', async () => {
        const cache = make(), entered = deferred<void>(), release = deferred<void>();
        const nativeFs = require('fs') as typeof fs;
        const originalMkdir = fs.promises.mkdir, originalWatch = nativeFs.watch;
        const open = new Set<fs.FSWatcher>();
        fs.promises.mkdir = (async (...args: Parameters<typeof originalMkdir>) => {
            const result = await originalMkdir(...args);
            if (String(args[0]) === dir) { entered.resolve(); await release.promise; }
            return result;
        }) as typeof originalMkdir;
        nativeFs.watch = ((...args: Parameters<typeof originalWatch>) => {
            const watcher = originalWatch(...args), close = watcher.close.bind(watcher);
            open.add(watcher);
            watcher.close = () => { open.delete(watcher); close(); };
            return watcher;
        }) as typeof originalWatch;
        try {
            const loading = cache.snapshot();
            await entered.promise;
            const closing = cache.dispose();
            release.resolve();
            await Promise.all([loading, closing]);
            assert.strictEqual(open.size, 0, 'shutdown cannot miss a watcher created after its initial close');
        } finally {
            release.resolve();
            fs.promises.mkdir = originalMkdir; nativeFs.watch = originalWatch;
            for (const watcher of open) { watcher.close(); }
        }
    });

    it('does not serve a corrupted persisted blob or create storage when caching is disabled', async () => {
        const bytes = content(200);
        const cache = make();
        assert.strictEqual(await cache.put(hash(bytes), bytes), true);
        await cache.dispose();
        fs.writeFileSync(path.join(dir, hash(bytes)), content(bytes.length, 1));
        const restarted = make();
        assert.strictEqual(await restarted.get(hash(bytes)), undefined);
        assert.strictEqual((await restarted.snapshot()).bytes, bytes.length, 'read detection retains physical-byte accounting until a mutation repairs it');
        assert.strictEqual(await restarted.put(hash(bytes), bytes), true);
        assert.deepStrictEqual(await restarted.get(hash(bytes)), bytes);
        const offDir = path.join(dir, 'disabled');
        const off = new PdfDiskCache(offDir, 0); caches.push(off);
        assert.strictEqual(await off.put(hash(bytes), bytes), false);
        assert.strictEqual(await off.get(hash(bytes)), undefined);
        assert.strictEqual(fs.existsSync(offDir), false);
        await restarted.dispose();
        fs.writeFileSync(path.join(dir, hash(bytes)), bytes);
        const disabledExisting = make(0);
        assert.strictEqual(await disabledExisting.put(hash(bytes), bytes), false);
        assert.strictEqual((await disabledExisting.snapshot()).bytes, 0, 'zero-budget admission removes previous files without creating new data');
        assert.strictEqual(fs.existsSync(path.join(dir, hash(bytes))), false);
    });
});
