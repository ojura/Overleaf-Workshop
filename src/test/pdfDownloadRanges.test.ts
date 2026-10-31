/* eslint-disable @typescript-eslint/naming-convention -- HTTP header names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { downloadInRanges } from '../core/pdfFetchBridge';

describe('downloadInRanges', () => {
    const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    let server: http.Server;
    let url: string;
    let folder: string;
    let requests: string[];
    /** how many times to answer 500 for a range, by its start */
    let failures: Map<number, number>;

    beforeEach(async () => {
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-ranges-'));
        requests = [];
        failures = new Map();
        server = http.createServer((req, res) => {
            const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!;
            const [start, end] = [Number(m[1]), Number(m[2])];
            requests.push(`${start}-${end}`);
            const left = failures.get(start) ?? 0;
            if (left > 0) { failures.set(start, left - 1); res.writeHead(500); res.end(); return; }
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

    it('fails when a range keeps failing, stops the others, and leaves no part file', async () => {
        failures.set(0, 5);
        const file = path.join(folder, 'build.pdf');
        await assert.rejects(downloadInRanges(url, file, body.byteLength, undefined, { chunk: 128, parallel: 2, attempts: 2 }), /bytes 0-127: 500/);
        assert.deepStrictEqual(fs.readdirSync(folder), []);
        assert.ok(requests.length < 8, `the other ranges stopped: ${requests.join(', ')}`);
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
