import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PdfFetchBridge } from '../core/pdfFetchBridge';

// tsc turns import() into require(), which cannot load ES modules
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

/**
 * The viewers' requests through the extension host (views/pdf-viewer/src/common/bridge-fetch.ts),
 * bundled as the viewers bundle it, and run in Node with the page globals that it reads.
 */
describe('the viewer\'s requests through the extension host (bridge-fetch.ts)', function () {
    this.timeout(30 * 1000);
    const names = ['window', 'location', 'fetch'];
    const saved: Record<string, PropertyDescriptor | undefined> = {};
    let dir: string;
    let bridge: any;
    let client: any;
    /** the page's window, where the host's answers arrive as message events */
    let page: EventTarget;
    const posted: any[] = [];
    // Node's MessageEvent, which the extension's TypeScript library does not declare
    const deliver = (data: unknown) => page.dispatchEvent(new (globalThis as any).MessageEvent('message', { data }));

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-bridge-fetch-'));
        const entry = path.join(dir, 'entry.ts');
        fs.writeFileSync(entry, `export { installBridgeFetch } from ${JSON.stringify(path.join(viewerRoot, 'src', 'common', 'bridge-fetch.ts'))};
export { createBridgeResponse, readPdfResponse } from ${JSON.stringify(path.join(viewerRoot, 'src', 'common', 'bridge-response.ts'))};
export { pdfPerformance } from ${JSON.stringify(path.join(viewerRoot, 'src', 'common', 'prefetch-performance.ts'))};`);
        await esbuild.build({ ...bundleOptions, entryPoints: [entry], outfile: path.join(dir, 'bridge-fetch.mjs') });
        // esbuild's service process is not needed any more; another build starts it again
        await esbuild.stop();
        bridge = await importModule(path.join(dir, 'bridge-fetch.mjs'));
    });

    beforeEach(() => {
        for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); }
        page = new EventTarget();
        Object.defineProperty(globalThis, 'window', { value: page, configurable: true, writable: true });
        Object.defineProperty(globalThis, 'location', { value: new URL('https://webview.test/index.html'), configurable: true, writable: true });
        posted.length = 0;
        bridge.pdfPerformance.reset();
        // the page's ID, which the host wrote into its configuration
        client = bridge.installBridgeFetch((message: unknown) => posted.push(message), () => true, 'page-2');
    });

    afterEach(() => {
        for (const name of names) {
            if (saved[name]) { Object.defineProperty(globalThis, name, saved[name]!); } else { delete (globalThis as any)[name]; }
        }
    });

    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('names its page in each request, and takes only the answers to its page', async () => {
        const answered = (globalThis as any).fetch('https://dl.test/project/p1/output.pdf', { headers: { range: 'bytes=0-1' } });
        assert.deepStrictEqual(posted.map(m => [m.type, m.page, m.id]), [['fetch', 'page-2', 1]]);
        // the answer to the request that the panel's earlier page numbered 1, as it may still arrive
        deliver({ type: 'fetchResponse', page: 'page-1', id: 1, status: 206, statusText: 'Partial Content', headers: [], body: new Uint8Array([1, 1]) });
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 1);
        deliver({ type: 'fetchResponse', page: 'page-2', id: 1, status: 206, statusText: 'Partial Content', headers: [], body: new Uint8Array([2, 2]) });
        const response = await answered;
        assert.deepStrictEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([2, 2]));
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 0);
    });

    it('shares request identity and cancellation for registered image reads without double counting loader measurements', async () => {
        const abort = new AbortController(), revision = 'a'.repeat(64);
        const image = client.readImage({ manifestRevision: revision, imageId: 'x1', chunkIndex: 2 }, abort.signal);
        const original = (globalThis as any).fetch('https://dl.test/project/p1/output.pdf');
        assert.deepStrictEqual(posted.map(message => [message.type, message.page, message.id]),
            [['readingFetch', 'page-2', 1], ['fetch', 'page-2', 2]]);
        assert.deepStrictEqual(posted[0], { type: 'readingFetch', page: 'page-2', id: 1,
            manifestRevision: revision, imageId: 'x1', chunkIndex: 2 });
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 1, 'the reading loader owns its own request metric');
        deliver({ type: 'fetchResponse', page: 'old-page', id: 1, status: 206, headers: [], body: new Uint8Array([99]) });
        deliver({ type: 'fetchResponse', page: 'page-2', id: 1, status: 206,
            headers: [['content-range', 'bytes 6-7/12']], body: new Uint8Array([7, 8]) });
        assert.deepStrictEqual(new Uint8Array(await (await image).arrayBuffer()), new Uint8Array([7, 8]));
        assert.strictEqual(bridge.pdfPerformance.snapshot().fetchBytes, 0);
        deliver({ type: 'fetchResponse', page: 'page-2', id: 2, status: 200, headers: [], body: new Uint8Array([3]) });
        await original;
        assert.strictEqual(bridge.pdfPerformance.snapshot().fetchBytes, 1);
        const cancelled = client.readImage({ manifestRevision: revision, imageId: 'x1', chunkIndex: 0 }, abort.signal);
        const rejected = assert.rejects(cancelled, { name: 'AbortError' });
        abort.abort(); await rejected;
        assert.deepStrictEqual(posted.at(-1), { type: 'fetchAbort', page: 'page-2', id: 3 });
        deliver({ type: 'fetchResponse', page: 'page-2', id: 3, status: 206, headers: [], body: new Uint8Array([9]) });
        assert.strictEqual(bridge.pdfPerformance.snapshot().fetchBytes, 1);
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 0);
    });

    it('waits for actual host disk ownership after immediate browser cancellation', async () => {
        const host = new PdfFetchBridge(() => false), revision = 'a'.repeat(64);
        const reads: Array<{ signal: AbortSignal; resolve(value: { body: Uint8Array; offset: number; total: number }): void }> = [];
        const replies: Promise<void>[] = [];
        let nextStarted!: () => void;
        const started = new Promise<void>(resolve => { nextStarted = resolve; });
        host.setReading(revision, (_id, _chunk, signal) => new Promise(resolve => {
            reads.push({ signal, resolve }); if (reads.length === 5) { nextStarted(); }
        }));
        client = bridge.installBridgeFetch((message: any) => {
            if (message.type === 'fetchAbort') { host.abort(message.id); return; }
            replies.push(host.handleReading(message).then(
                response => { deliver({ type: 'fetchResponse', page: message.page, ...response, body: response.body.slice() }); },
                error => { deliver({ type: 'fetchError', page: message.page, id: message.id, message: error.message }); },
            ));
        }, () => false, 'page-2');
        const request = (signal: AbortSignal): Promise<any> => client.readImage({ manifestRevision: revision, imageId: 'x1', chunkIndex: 0 }, signal);
        const value = { body: new Uint8Array([7, 8]), offset: 0, total: 2 };
        let healthy: Promise<any> | undefined;
        try {
            for (let index = 0; index < 4; index++) {
                const controller = new AbortController();
                const rejected = assert.rejects(request(controller.signal), { name: 'AbortError' });
                controller.abort(); await rejected;
            }
            assert.strictEqual(reads.length, 4);
            assert.ok(reads.every(read => read.signal.aborted));
            let settled = false, failed: Error | undefined;
            healthy = request(new AbortController().signal);
            void healthy.then(() => { settled = true; }, (error: Error) => { settled = true; failed = error; });
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(failed, undefined, 'a healthy replacement must wait instead of receiving a capacity error');
            assert.strictEqual(settled, false, 'cancelled reads still own all four disk slots');
            assert.strictEqual(reads.length, 4);
            reads[0].resolve(value); await started;
            assert.strictEqual(reads.length, 5);
            reads[4].resolve(value);
            assert.deepStrictEqual(new Uint8Array(await (await healthy).arrayBuffer()), value.body);
            assert.strictEqual(bridge.pdfPerformance.snapshot().fetchBytes, 0, 'image transfer accounting remains with the reading loader');
        } finally {
            host.dispose();
            for (const read of reads) { read.resolve(value); }
            await Promise.all(replies); await healthy?.catch(() => {});
        }
    });

    it('exposes already-delivered host bytes as a native stream without copying the binary payload', async () => {
        const bytes = new Uint8Array(1024 * 1024);
        bytes[0] = 17; bytes[bytes.length - 1] = 93;
        const length = bytes.length;
        const original = bytes.buffer;
        const answered = (globalThis as any).fetch('https://dl.test/project/p1/output.pdf', {
            headers: { range: 'bytes=0-' + (bytes.length - 1) },
        });
        deliver({ type: 'fetchResponse', page: 'page-2', id: 1, status: 206, statusText: 'Partial Content',
            headers: [['content-range', 'bytes 0-' + (bytes.length - 1) + '/2000000'], ['content-length', String(bytes.length)]], body: bytes });
        const response = await answered;
        assert.ok(response instanceof (globalThis as any).Response);
        assert.strictEqual(response.status, 206);
        assert.strictEqual(response.headers.get('content-range'), 'bytes 0-' + (length - 1) + '/2000000');
        assert.strictEqual(original.byteLength, 0, 'native byte-stream enqueue transfers ownership instead of copying the payload');
        assert.strictEqual(response.bodyUsed, false);
        const reader = response.body.getReader();
        try {
            const first = await reader.read();
            assert.strictEqual(first.value.byteOffset, 0);
            assert.strictEqual(first.value.byteLength, length);
            assert.strictEqual(first.value[0], 17);
            assert.strictEqual(first.value[length - 1], 93);
            assert.strictEqual((await reader.read()).done, true);
            assert.strictEqual(response.bodyUsed, true);
        } finally { reader.releaseLock(); }
        assert.strictEqual(bridge.pdfPerformance.snapshot().fetchBytes, length);
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 0);
    });

    it('consumes an owned response through EOF without native arrayBuffer materialization', async () => {
        const bytes = new Uint8Array(1024 * 1024).fill(23);
        const response = bridge.createBridgeResponse(bytes, { status: 206, statusText: 'Partial Content' });
        let materializations = 0;
        const original = response.arrayBuffer;
        response.arrayBuffer = () => { materializations++; return original.call(response); };
        const result = await bridge.readPdfResponse(response);
        assert.strictEqual(result.byteLength, 1024 * 1024);
        assert.strictEqual(new Uint8Array(result)[0], 23);
        assert.strictEqual(materializations, 0);
        assert.strictEqual(response.bodyUsed, true);
        assert.strictEqual(response.body.locked, false, 'the real stream reader is released after EOF');
        await assert.rejects(bridge.readPdfResponse(response), TypeError);
        assert.throws(() => response.clone(), TypeError);
    });

    it('returns only a sliced host view and never the neighbouring bytes of its backing buffer', async () => {
        const bytes = new Uint8Array([91, 92, 4, 5, 6, 93, 94]);
        const response = bridge.createBridgeResponse(bytes.subarray(2, 5), { status: 206 });
        const result = await bridge.readPdfResponse(response);
        assert.deepStrictEqual(new Uint8Array(result), new Uint8Array([4, 5, 6]));
        assert.strictEqual(result.byteLength, 3);
        assert.strictEqual(response.bodyUsed, true);
        assert.strictEqual(response.body.locked, false);
    });

    it('preserves native clone stream identity and independent raw reader bytes', async () => {
        const response = bridge.createBridgeResponse(new Uint8Array([7, 8, 9]), { status: 206 });
        const originalStream = response.body;
        const clone = response.clone();
        assert.notStrictEqual(response.body, originalStream, 'cloning replaces the marked stream with an unmarked tee branch');
        const first = response.body.getReader(), second = clone.body.getReader();
        try {
            const one = await first.read();
            one.value[0] = 99;
            const two = await second.read();
            assert.deepStrictEqual(two.value, new Uint8Array([7, 8, 9]), 'byte-stream tee isolates raw branch mutations');
            assert.strictEqual((await first.read()).done, true);
            assert.strictEqual((await second.read()).done, true);
        } finally { first.releaseLock(); second.releaseLock(); }
    });

    it('uses ordinary body consumption for both cloned branches', async () => {
        const response = bridge.createBridgeResponse(new Uint8Array([7, 8, 9]), { status: 206 });
        const clone = response.clone();
        let materializations = 0;
        for (const branch of [response, clone]) {
            const original = branch.arrayBuffer;
            branch.arrayBuffer = () => { materializations++; return original.call(branch); };
        }
        const first = await bridge.readPdfResponse(response);
        new Uint8Array(first)[0] = 99;
        assert.deepStrictEqual(new Uint8Array(await bridge.readPdfResponse(clone)), new Uint8Array([7, 8, 9]));
        assert.strictEqual(materializations, 2);
    });

    it('preserves native locked, used and cancelled body errors', async () => {
        const response = bridge.createBridgeResponse(new Uint8Array([3, 4]), { status: 206 });
        const reader = response.body.getReader();
        await assert.rejects(bridge.readPdfResponse(response), TypeError);
        reader.releaseLock();
        assert.deepStrictEqual(new Uint8Array(await bridge.readPdfResponse(response)), new Uint8Array([3, 4]));
        const used = bridge.createBridgeResponse(new Uint8Array([65]), { status: 200 });
        assert.strictEqual(await used.text(), 'A');
        await assert.rejects(bridge.readPdfResponse(used), TypeError);
        const cancelled = bridge.createBridgeResponse(new Uint8Array([66]), { status: 200 });
        await cancelled.body.cancel();
        await assert.rejects(bridge.readPdfResponse(cancelled), TypeError);
    });

    it('keeps native empty, null, unmarked and errored-stream responses on their ordinary paths', async () => {
        const empty = bridge.createBridgeResponse(new Uint8Array(), { status: 200 });
        assert.strictEqual((await bridge.readPdfResponse(empty)).byteLength, 0);
        assert.strictEqual(empty.bodyUsed, true);
        assert.strictEqual(empty.body.locked, false);
        const absent = bridge.createBridgeResponse(null, { status: 204 });
        assert.strictEqual(absent.body, null);
        assert.strictEqual((await bridge.readPdfResponse(absent)).byteLength, 0);
        const native = new (globalThis as any).Response(new Uint8Array([5, 6]));
        assert.deepStrictEqual(new Uint8Array(await bridge.readPdfResponse(native)), new Uint8Array([5, 6]));
        const failure = new Error('body failed');
        const stream = new (globalThis as any).ReadableStream({ start(controller: any) { controller.error(failure); } });
        await assert.rejects(bridge.readPdfResponse(new (globalThis as any).Response(stream)), error => error === failure);
    });

    it('rejects detached or shared host buffers without stranding fetch pressure', async () => {
        const bytes = new Uint8Array([1]);
        bridge.createBridgeResponse(bytes, { status: 200 });
        assert.throws(() => bridge.createBridgeResponse(bytes, { status: 200 }), TypeError);
        const answered = (globalThis as any).fetch('https://dl.test/project/p1/output.pdf');
        const rejected = assert.rejects(answered, TypeError);
        deliver({ type: 'fetchResponse', page: 'page-2', id: 1, status: 200, headers: [],
            body: new Uint8Array(new SharedArrayBuffer(4)) });
        await rejected;
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 0);
    });

    it('names its page when it stops a request', async () => {
        const abort = new AbortController();
        const answered = (globalThis as any).fetch('https://dl.test/project/p1/output.pdf', { signal: abort.signal });
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 1);
        abort.abort();
        await assert.rejects(answered, { name: 'AbortError' });
        assert.deepStrictEqual(posted.map(m => [m.type, m.page, m.id]), [['fetch', 'page-2', 1], ['fetchAbort', 'page-2', 1]]);
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 0);
        deliver({ type: 'fetchResponse', page: 'page-2', id: 1, status: 200, headers: [], body: new Uint8Array([9]) });
        assert.strictEqual(bridge.pdfPerformance.snapshot().fetchBytes, 0);
    });

    it('releases fetch pressure after a host error while another request remains active', async () => {
        const first = (globalThis as any).fetch('https://dl.test/project/p1/output.pdf');
        const second = (globalThis as any).fetch('https://dl.test/project/p1/output.pdf');
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 2);
        const rejected = assert.rejects(first, /network unavailable/);
        deliver({ type: 'fetchError', page: 'page-2', id: 1, message: 'network unavailable' });
        await rejected;
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 1);
        deliver({ type: 'fetchResponse', page: 'page-2', id: 2, status: 204, headers: [], body: new Uint8Array() });
        await second;
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 0);
    });

    it('does not leave fetch pressure behind when dispatch throws or the signal is already aborted', async () => {
        const abort = new AbortController();
        abort.abort();
        await assert.rejects((globalThis as any).fetch('https://dl.test/project/p1/output.pdf', { signal: abort.signal }), { name: 'AbortError' });
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 0);
        assert.strictEqual(posted.length, 0);
        bridge.installBridgeFetch(() => { throw new Error('host disconnected'); }, () => true, 'page-2');
        await assert.rejects((globalThis as any).fetch('https://dl.test/project/p1/output.pdf'), /host disconnected/);
        assert.strictEqual(bridge.pdfPerformance.pendingFetchCount, 0);
    });
});
