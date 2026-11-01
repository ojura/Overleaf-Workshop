/* eslint-disable @typescript-eslint/naming-convention -- HTTP header names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { DownloadError, downloadInRanges, PdfFetchBridge, retryAfterMs } from '../core/pdfFetchBridge';

describe('downloadInRanges', () => {
    const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    let server: http.Server;
    let url: string;
    let folder: string;
    let requests: string[];
    /** how many times to answer 500 for a range, by its start */
    let failures: Map<number, number>;
    /** the ranges, by their start, that the server does not have: it answers 404 */
    let missing: Set<number>;
    /** how many times to send a range cut off, by its start */
    let cutOff: Map<number, number>;
    /** how many times to answer 429 for a range, by its start, with the Retry-After header to send */
    let limited: Map<number, { times: number, retryAfter?: string }>;

    beforeEach(async () => {
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-ranges-'));
        requests = [];
        failures = new Map();
        missing = new Set();
        cutOff = new Map();
        limited = new Map();
        server = http.createServer((req, res) => {
            const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!;
            const [start, end] = [Number(m[1]), Number(m[2])];
            requests.push(`${start}-${end}`);
            const left = failures.get(start) ?? 0;
            if (left > 0) { failures.set(start, left - 1); res.writeHead(500); res.end(); return; }
            if (missing.has(start)) { res.writeHead(404); res.end(); return; }
            const limit = limited.get(start);
            if (limit && limit.times > 0) {
                limit.times -= 1;
                res.writeHead(429, limit.retryAfter === undefined ? {} : { 'retry-after': limit.retryAfter });
                res.end();
                return;
            }
            const short = cutOff.get(start) ?? 0;
            if (short > 0) {
                cutOff.set(start, short - 1);
                const part = body.subarray(start, end);
                res.writeHead(206, { 'content-length': part.byteLength, 'content-range': `bytes ${start}-${end}/${body.byteLength}` });
                res.end(part);
                return;
            }
            const part = body.subarray(start, end + 1);
            res.writeHead(206, { 'content-length': part.byteLength, 'content-range': `bytes ${start}-${end}/${body.byteLength}` });
            // later ranges answer sooner, so they arrive out of order
            setTimeout(() => res.end(part), Math.max(0, 40 - start / 25));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        url = `http://127.0.0.1:${(server.address() as any).port}/output.pdf`;
    });
    afterEach(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(folder, { recursive: true, force: true });
    });

    it('puts ranges that arrive out of order in their places', async () => {
        const file = path.join(folder, 'build.pdf');
        await downloadInRanges(url, file, body.byteLength, undefined, { chunk: 128, parallel: 3 });
        assert.deepStrictEqual(fs.readFileSync(file), body);
        assert.strictEqual(requests.length, 8);
        assert.deepStrictEqual(fs.readdirSync(folder), ['build.pdf']);
    });

    it('asks again for a range that failed', async () => {
        failures.set(256, 2);
        const file = path.join(folder, 'build.pdf');
        await downloadInRanges(url, file, body.byteLength, undefined, { chunk: 128, parallel: 2, attempts: 3 });
        assert.deepStrictEqual(fs.readFileSync(file), body);
        assert.strictEqual(requests.filter(r => r === '256-383').length, 3);
    });

    it('does not ask again for a range that the server does not have, and says so with the status', async () => {
        missing.add(128);
        const file = path.join(folder, 'build.pdf');
        await assert.rejects(downloadInRanges(url, file, body.byteLength, undefined, { chunk: 128, parallel: 1, attempts: 3 }),
            (error: unknown) => error instanceof DownloadError && error.status === 404);
        assert.strictEqual(requests.filter(r => r === '128-255').length, 1);
        assert.deepStrictEqual(fs.readdirSync(folder), []);
    });

    it('asks again for a range answered 429 after the time that the answer names (Retry-After)', async () => {
        limited.set(128, { times: 1, retryAfter: '2' });
        const waits: number[] = [];
        const file = path.join(folder, 'build.pdf');
        await downloadInRanges(url, file, body.byteLength, undefined, { chunk: 128, parallel: 1, attempts: 3, wait: async (ms) => { waits.push(ms); } });
        assert.deepStrictEqual(fs.readFileSync(file), body);
        assert.strictEqual(requests.filter(r => r === '128-255').length, 2);
        assert.deepStrictEqual(waits, [2000]);
    });

    it('fails with the server\'s time when it asks to wait longer than the window waits for a server', async () => {
        const seconds = PdfFetchBridge.idleTimeoutMs / 1000 + 1;
        limited.set(128, { times: 1, retryAfter: String(seconds) });
        const waits: number[] = [];
        const file = path.join(folder, 'build.pdf');
        await assert.rejects(downloadInRanges(url, file, body.byteLength, undefined, { chunk: 128, parallel: 1, attempts: 3, wait: async (ms) => { waits.push(ms); } }),
            (error: unknown) => error instanceof DownloadError && error.status === 429
                && error.message.includes(`asks to wait ${seconds} s before it is asked again, longer than the ${PdfFetchBridge.idleTimeoutMs / 1000} s`));
        assert.deepStrictEqual(waits, []);
        assert.strictEqual(requests.filter(r => r === '128-255').length, 1);
        assert.deepStrictEqual(fs.readdirSync(folder), []);
    });

    it('does not ask again for a range answered 429 without a time to ask again, and says so with the status', async () => {
        limited.set(128, { times: 1 });
        const file = path.join(folder, 'build.pdf');
        await assert.rejects(downloadInRanges(url, file, body.byteLength, undefined, { chunk: 128, parallel: 1, attempts: 3 }),
            (error: unknown) => error instanceof DownloadError && error.status === 429);
        assert.strictEqual(requests.filter(r => r === '128-255').length, 1);
        assert.deepStrictEqual(fs.readdirSync(folder), []);
    });

    it('stops waiting to ask again when the caller aborts, with the answer\'s error', async () => {
        limited.set(0, { times: 1, retryAfter: '60' });
        const abort = new AbortController();
        const file = path.join(folder, 'build.pdf');
        // the wait that the answer asks for begins: the caller aborts during it
        const wait = (_ms: number, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            abort.abort();
        });
        await assert.rejects(downloadInRanges(url, file, body.byteLength, abort.signal, { chunk: 128, parallel: 1, wait }),
            (error: unknown) => error instanceof DownloadError && error.status === 429);
        assert.strictEqual(requests.filter(r => r === '0-127').length, 1);
        assert.deepStrictEqual(fs.readdirSync(folder), []);
    });

    it('reads the time to ask again from Retry-After, in seconds or as a date', () => {
        const now = Date.parse('2026-11-01T05:00:00Z');
        assert.strictEqual(retryAfterMs('120', now), 120_000);
        assert.strictEqual(retryAfterMs(' 0 ', now), 0);
        assert.strictEqual(retryAfterMs('Sun, 01 Nov 2026 05:00:30 GMT', now), 30_000);
        // a date that has passed: ask again at once
        assert.strictEqual(retryAfterMs('Sun, 01 Nov 2026 04:59:00 GMT', now), 0);
        assert.strictEqual(retryAfterMs('soon', now), undefined);
        assert.strictEqual(retryAfterMs('-5', now), undefined);
        assert.strictEqual(retryAfterMs(null, now), undefined);
    });

    it('asks again for a range that came cut off', async () => {
        cutOff.set(0, 1);
        const file = path.join(folder, 'build.pdf');
        await downloadInRanges(url, file, body.byteLength, undefined, { chunk: 128, parallel: 1, attempts: 3 });
        assert.deepStrictEqual(fs.readFileSync(file), body);
        assert.strictEqual(requests.filter(r => r === '0-127').length, 2);
    });

    it('fails when a range keeps failing, stops the others, and leaves no part file', async () => {
        failures.set(0, 5);
        const file = path.join(folder, 'build.pdf');
        await assert.rejects(downloadInRanges(url, file, body.byteLength, undefined, { chunk: 128, parallel: 2, attempts: 2 }), /bytes 0-127: 500/);
        assert.deepStrictEqual(fs.readdirSync(folder), []);
        assert.ok(requests.length < 8, `the other ranges stopped: ${requests.join(', ')}`);
    });

    it('reports the bytes written after each range, and leaves an earlier file as it was when the download fails', async () => {
        const file = path.join(folder, 'build.pdf');
        const seen: number[] = [];
        await downloadInRanges(url, file, body.byteLength, undefined, { chunk: 256, parallel: 2, onProgress: (received) => seen.push(received) });
        assert.strictEqual(seen.length, 4);
        assert.strictEqual(seen.at(-1), body.byteLength);
        assert.ok(seen.every((received, i) => i === 0 || received > seen[i - 1]), seen.join(', '));
        fs.writeFileSync(file, 'the earlier copy');
        failures.set(0, 5);
        await assert.rejects(downloadInRanges(url, file, body.byteLength, undefined, { chunk: 256, parallel: 2, attempts: 2 }));
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'the earlier copy');
        assert.deepStrictEqual(fs.readdirSync(folder), ['build.pdf']);
    });

    it('stops when the caller aborts', async () => {
        const abort = new AbortController();
        const file = path.join(folder, 'build.pdf');
        const download = downloadInRanges(url, file, body.byteLength, abort.signal, { chunk: 64, parallel: 1 });
        setTimeout(() => abort.abort(), 60);
        await assert.rejects(download);
        assert.deepStrictEqual(fs.readdirSync(folder), []);
    });
});
