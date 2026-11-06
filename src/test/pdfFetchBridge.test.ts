/* eslint-disable @typescript-eslint/naming-convention -- HTTP header names */
import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { outputsOf, PdfFetchBridge, PieceCache } from '../core/pdfFetchBridge';
import { PDF_READING_REQUEST_LIMITS } from '../core/viewerProtocol';

const sha256 = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
const pdf = new TextEncoder().encode('%PDF-1.7 ' + 'x'.repeat(5000));
const piece = new TextEncoder().encode('a stream of a PDF object');
const pieceHash = sha256(piece);

/** The download domain: output.pdf with Range support, and pieces under /content/. */
async function serve(delayMs = 0) {
    const requests: Array<{ url: string, range?: string, cookie?: string }> = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url!, range: req.headers.range, cookie: req.headers.cookie });
        setTimeout(() => {
            if (req.url!.includes('/content/')) {
                res.writeHead(200);
                res.end(req.url!.endsWith(pieceHash) ? piece : new TextEncoder().encode('not what the hash says'));
                return;
            }
            const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
            if (m) {
                const [start, end] = [Number(m[1]), Number(m[2])];
                res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${pdf.byteLength}` });
                res.end(pdf.subarray(start, end + 1));
            } else {
                res.writeHead(200);
                res.end(pdf);
            }
        }, delayMs);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const domain = `http://127.0.0.1:${(server.address() as AddressInfo).port}/zone/d`;
    return { domain, requests, close: () => { server.closeAllConnections(); server.close(); } };
}

describe('the PDF viewer\'s fetches through the extension', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-pieces-test-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('fetches only the outputs of this project on the download domain', async () => {
        const allowed = outputsOf('https://compiles.overleafusercontent.com/zone/d', 'p1');
        const ok = (u: string) => allowed(new URL(u));
        assert.strictEqual(ok('https://compiles.overleafusercontent.com/zone/d/project/p1/user/u1/build/b1/output/output.pdf'), true);
        assert.strictEqual(ok('https://compiles.overleafusercontent.com/zone/d/project/p2/user/u1/build/b1/output/output.pdf'), false);
        assert.strictEqual(ok('https://compiles.overleafusercontent.com/zone/d/project/p1/../p2/output.pdf'), false);
        assert.strictEqual(ok('https://www.overleaf.com/zone/d/project/p1/output.pdf'), false);
        assert.strictEqual(ok('http://compiles.overleafusercontent.com/zone/d/project/p1/output.pdf'), false);
        const bridge = new PdfFetchBridge(allowed);
        await assert.rejects(bridge.handle({ id: 1, url: 'https://www.overleaf.com/project/p1/settings' }), /not an output of this project/);
        await assert.rejects(bridge.handle({ id: 2, url: 'https://compiles.overleafusercontent.com/zone/d/project/p1/x', method: 'POST' }), /POST requests are not sent/);
    });

    it('passes a range request on, with the range and without other headers', async () => {
        const server = await serve();
        try {
            const bridge = new PdfFetchBridge(outputsOf(server.domain, 'p1'));
            const res = await bridge.handle({ id: 1, url: `${server.domain}/project/p1/user/u1/build/b1/output/output.pdf`, headers: [['Range', 'bytes=0-8'], ['Cookie', 'overleaf_session2=secret']] });
            assert.strictEqual(res.status, 206);
            assert.strictEqual(new TextDecoder().decode(res.body), '%PDF-1.7 ');
            assert.ok(res.headers.some(([name, value]) => name === 'content-range' && value === `bytes 0-8/${pdf.byteLength}`));
            assert.deepStrictEqual(server.requests.map(r => [r.range, r.cookie]), [['bytes=0-8', undefined]]);
        } finally { server.close(); }
    });

    it('keeps a piece that matches its hash, and serves it again without a request', async () => {
        const server = await serve();
        try {
            const bridge = new PdfFetchBridge(outputsOf(server.domain, 'p1'), new PieceCache(dir, 1024 * 1024));
            const url = `${server.domain}/project/p1/user/u1/content/c1/${pieceHash}`;
            const first = await bridge.handle({ id: 1, url });
            const second = await bridge.handle({ id: 2, url: url.replace('/c1/', '/c2/') }); // a later build with the same piece
            assert.deepStrictEqual([first.status, second.status], [200, 200]);
            assert.deepStrictEqual(second.body, piece);
            assert.strictEqual(server.requests.length, 1);
            // bytes that do not match the hash in their URL are passed on but not kept
            const wrong = `${server.domain}/project/p1/user/u1/content/c1/${'0'.repeat(64)}`;
            await bridge.handle({ id: 3, url: wrong });
            await bridge.handle({ id: 4, url: wrong });
            assert.strictEqual(server.requests.length, 3);
        } finally { server.close(); }
    });

    it('drops the least recently used pieces when the cache outgrows its size', async () => {
        const cache = new PieceCache(dir, 100);
        const pieces = ['a', 'b', 'c'].map(c => new TextEncoder().encode(c.repeat(40)));
        for (const [i, p] of pieces.entries()) {
            assert.strictEqual(await cache.put(sha256(p), p), true);
            const t = new Date(Date.now() - (10 - i) * 1000);
            fs.utimesSync(path.join(dir, sha256(p)), t, t);
        }
        assert.strictEqual(await cache.get(sha256(pieces[0])), undefined, 'the oldest is gone');
        assert.deepStrictEqual(await cache.get(sha256(pieces[2])), pieces[2]);
        assert.strictEqual(await cache.put(sha256(pieces[0]), pieces[1]), false, 'content that does not match its hash');
    });

    it('fetches output.pdf whole only when it is small enough that Overleaf\'s loader asks for it whole', async () => {
        const server = await serve();
        try {
            const url = `${server.domain}/project/p1/user/u1/build/b1/output/output.pdf`;
            let size = 885_484_347;
            const bridge = new PdfFetchBridge(outputsOf(server.domain, 'p1'), undefined, { buildSize: () => size });
            // pdf.js's own first request without a range transport
            await assert.rejects(bridge.handle({ id: 1, url }), /fetched whole only up to 262144 bytes, and this build has 885484347 bytes/);
            assert.strictEqual(server.requests.length, 0);
            // ranges of a large build, and its pieces, still go through
            assert.strictEqual((await bridge.handle({ id: 2, url, headers: [['Range', 'bytes=0-8']] })).status, 206);
            assert.strictEqual((await bridge.handle({ id: 3, url: `${server.domain}/project/p1/user/u1/content/c1/${pieceHash}` })).status, 200);
            // PDFJSWrapper sets the chunk size to the file's size below 256 KB, and the loader then omits the Range header
            size = 2 * 128 * 1024;
            const whole = await bridge.handle({ id: 4, url });
            assert.deepStrictEqual([whole.status, whole.body.byteLength], [200, pdf.byteLength]);
            const unknown = new PdfFetchBridge(outputsOf(server.domain, 'p1'));
            await assert.rejects(unknown.handle({ id: 5, url }), /an unknown number of bytes/);
        } finally { server.close(); }
    });

    it('serves only revision-authorized image chunks with exact range response metadata', async () => {
        const bridge = new PdfFetchBridge(() => false), revision = 'a'.repeat(64);
        const asked: Array<[string, number, number | undefined]> = [];
        bridge.setReading(revision, async (id, index, _signal, count) => {
            asked.push([id, index, count]);
            return { body: new Uint8Array([7, 8, 9]), offset: 6, total: 12 };
        });
        try {
            const response = await bridge.handleReading({ id: 1, manifestRevision: revision, imageId: 'x1', chunkIndex: 1, chunkCount: 2 });
            assert.deepStrictEqual(asked, [['x1', 1, 2]]);
            assert.deepStrictEqual([response.status, response.body], [206, new Uint8Array([7, 8, 9])]);
            assert.deepStrictEqual(Object.fromEntries(response.headers), { 'content-type': 'application/octet-stream',
                'content-length': '3', 'content-encoding': 'identity', 'content-range': 'bytes 6-8/12' });
            await assert.rejects(bridge.handleReading({ id: 2, manifestRevision: 'b'.repeat(64), imageId: 'x1', chunkIndex: 1 }), /not registered/);
            for (const chunkCount of [0, -1, 1.5, 257, '2', null]) {
                await assert.rejects(bridge.handleReading({ id: 2, manifestRevision: revision, imageId: 'x1', chunkIndex: 1,
                    chunkCount: chunkCount as number }), /not registered/);
            }
            assert.strictEqual(asked.length, 1);
            bridge.setReading(revision, async () => ({ body: new Uint8Array([1, 2]), offset: 0, total: 2 }));
            const whole = await bridge.handleReading({ id: 3, manifestRevision: revision, imageId: 'x2', chunkIndex: 0 });
            assert.strictEqual(whole.status, 200);
            assert.strictEqual(whole.headers.some(([name]) => name === 'content-range'), false);
        } finally { bridge.dispose(); }
    });

    it('retains cancelled image admission until its read settles and then admits the waiting replacement', async () => {
        const bridge = new PdfFetchBridge(() => false), revision = 'a'.repeat(64);
        const reads: Array<{ signal: AbortSignal; resolve(value: { body: Uint8Array; offset: number; total: number }): void }> = [];
        bridge.setReading(revision, (_id, _index, signal) => new Promise(resolve => reads.push({ signal, resolve })));
        const request = (id: number) => bridge.handleReading({ id, manifestRevision: revision, imageId: 'x1', chunkIndex: 0 });
        const pending = [1, 2, 3, 4].map(request);
        const rejected = assert.rejects(pending[0], /stopped/);
        const next = request(5);
        const stopping = [...pending.slice(1), next].map(value => assert.rejects(value, /stopped/));
        try {
            assert.strictEqual(reads.length, 4);
            bridge.abort(1);
            assert.strictEqual(reads[0].signal.aborted, true);
            assert.strictEqual(reads.length, 4, 'an aborted but unfinished disk read still occupies its slot');
            reads[0].resolve({ body: new Uint8Array([1]), offset: 0, total: 1 }); await rejected;
            assert.strictEqual(reads.length, 5);
            bridge.dispose();
            assert.ok(reads.every(read => read.signal.aborted));
            for (const read of reads.slice(1)) { read.resolve({ body: new Uint8Array([1]), offset: 0, total: 1 }); }
            await Promise.all(stopping);
            await assert.rejects(request(6), /not registered/);
        } finally {
            bridge.dispose();
            for (const read of reads) { read.resolve({ body: new Uint8Array([1]), offset: 0, total: 1 }); }
            await Promise.allSettled([...pending, next, rejected, ...stopping]);
        }
    });

    it('bounds waiting image admission and cancels queued reads without opening files', async () => {
        const bridge = new PdfFetchBridge(() => false), revision = 'a'.repeat(64);
        const reads: Array<{ id: string; resolve(value: { body: Uint8Array; offset: number; total: number }): void }> = [];
        bridge.setReading(revision, (id) => new Promise(resolve => reads.push({ id, resolve })));
        const request = (id: number) => bridge.handleReading({ id, manifestRevision: revision, imageId: 'x' + id, chunkIndex: 0 });
        const { active, queued } = PDF_READING_REQUEST_LIMITS;
        const running = Array.from({ length: active }, (_, index) => request(index + 1));
        const waiting = Array.from({ length: queued }, (_, index) => request(active + index + 1));
        const stopped = [...running, ...waiting].map(value => assert.rejects(value, /stopped/));
        const replacements: Promise<unknown>[] = [];
        try {
            await assert.rejects(request(active + queued + 1), /queue is full/);
            assert.strictEqual(reads.length, active);
            bridge.abort(active + 1);
            await stopped[active];
            const replacement = request(active + queued + 1);
            replacements.push(assert.rejects(replacement, /stopped/));
            await assert.rejects(request(active + queued + 2), /queue is full/, 'a cancelled queue entry frees exactly one place');
            // Reusing an ID cancels its old queued request without cancelling the new owner.
            const sameId = request(active + 2);
            replacements.push(assert.rejects(sameId, /stopped/));
            await stopped[active + 1];
            bridge.dispose();
            for (const read of reads) { read.resolve({ body: new Uint8Array([1]), offset: 0, total: 1 }); }
            await Promise.all([...stopped, ...replacements]);
            assert.strictEqual(reads.length, active, 'queued, cancelled and disposed work never reaches the registered file reader');
        } finally {
            bridge.dispose();
            for (const read of reads) { read.resolve({ body: new Uint8Array([1]), offset: 0, total: 1 }); }
            await Promise.allSettled([...running, ...waiting, ...stopped, ...replacements]);
        }
    });

    it('stops a request that the viewer no longer needs', async () => {
        const server = await serve(2000);
        try {
            const bridge = new PdfFetchBridge(outputsOf(server.domain, 'p1'));
            const pending = bridge.handle({ id: 7, url: `${server.domain}/project/p1/user/u1/build/b1/output/output.pdf`, headers: [['Range', 'bytes=0-8']] });
            setTimeout(() => bridge.abort(7), 50);
            await assert.rejects(pending, /abort/i);
        } finally { server.close(); }
    });
});
