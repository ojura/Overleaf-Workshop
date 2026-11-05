/* eslint-disable @typescript-eslint/naming-convention -- pinned PDF.js public and internal class names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('PDF.js sparse range cache', function () {
    this.timeout(30_000);
    let dir: string;
    let worker: any;
    let pdfjs: any;
    const saved = new Map<string, PropertyDescriptor | undefined>();

    before(async () => {
        const { pdfjsRelease } = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-sparse-cache-'));
        // Execute the actual patched classes and both proxy layers, with private classes
        // exported only from this temporary test copy of the pinned distribution.
        fs.writeFileSync(path.join(dir, 'pdf.worker.mjs'), fs.readFileSync(path.join(pdfjsRelease, 'build/pdf.worker.mjs'), 'utf8')
            + '\nexport { SparseChunkedStream, ChunkedStreamManager, NetworkPdfManager, MissingDataException, PDFImage, PartialEvaluator, Dict, Name, Stream, GlobalColorSpaceCache, LocalColorSpaceCache };\n');
        fs.writeFileSync(path.join(dir, 'pdf.mjs'), fs.readFileSync(path.join(pdfjsRelease, 'build/pdf.mjs'), 'utf8')
            + '\nexport { PDFDataTransportStream, PDFFetchStream, PDFNodeStream };\n');
        for (const name of ['DOMMatrix', 'pdfjsLib', 'pdfjsWorker']) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); }
        if (!(globalThis as any).DOMMatrix) {
            Object.defineProperty(globalThis, 'DOMMatrix', { value: class {}, writable: true, configurable: true });
        }
        worker = await importModule(pathToFileURL(path.join(dir, 'pdf.worker.mjs')).href);
        pdfjs = await importModule(pathToFileURL(path.join(dir, 'pdf.mjs')).href);
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, 'pdf.worker.mjs')).href;
    });

    after(() => {
        for (const [name, descriptor] of saved) {
            if (descriptor) { Object.defineProperty(globalThis, name, descriptor); }
            else { delete (globalThis as any)[name]; }
        }
        if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    const bytes = (length: number) => Uint8Array.from({ length }, (_, index) => index % 251);

    function network(data: Uint8Array, delayed = false) {
        const requests: { begin: number; end: number }[] = [];
        const gates: { resolve(): void; reject(error: Error): void }[] = [];
        const active = new Set<any>();
        return {
            requests, active,
            getRangeReader(begin: number, end: number) {
                requests.push({ begin, end });
                let consumed = false;
                const ready = delayed ? new Promise<void>((resolve, reject) => gates.push({ resolve, reject })) : Promise.resolve();
                const reader = {
                    isStreamingSupported: false,
                    async read() {
                        await ready;
                        if (consumed) { return { done: true }; }
                        consumed = true;
                        return { done: false, value: data.slice(begin, end).buffer };
                    },
                };
                active.add(reader);
                return reader;
            },
            removeRangeReader(reader: any) { active.delete(reader); },
            deliver() { for (const gate of gates.splice(0)) { gate.resolve(); } },
            fail(error: Error) { for (const gate of gates.splice(0)) { gate.reject(error); } },
            cancelAllRequests(error: Error) { this.fail(error); },
        };
    }

    function manager(data: Uint8Array, maxBytes = 8, delayed = false) {
        const source = network(data, delayed);
        const cache = new worker.ChunkedStreamManager(source, {
            length: data.length, rangeChunkSize: 4, rangeCacheBytes: maxBytes,
            disableAutoFetch: true, msgHandler: { send() {} },
        });
        return { cache, source, stream: cache.stream };
    }

    it('reserves no full-file array for the 1.6 GB book', () => {
        const stream = new worker.SparseChunkedStream(1_608_644_855, 131072, null, 32 * 1024 * 1024);
        assert.strictEqual(stream.bytes.byteLength, 0);
        assert.strictEqual(stream.getRangeCacheStats().residentBytes, 0);
        assert.strictEqual(stream.getRangeCacheStats().length, 1_608_644_855);
    });

    it('reads across chunks and inherited substreams without sharing a full-file buffer', () => {
        const stream = new worker.SparseChunkedStream(19, 4, null, 8);
        const data = bytes(19);
        stream.onReceiveData(0, data);
        stream.pos = 2;
        assert.deepStrictEqual(Array.from(stream.getBytes(9)), Array.from(data.slice(2, 11)));
        assert.strictEqual(stream.pos, 11);
        const sub = stream.makeSubStream(5, 9, { test: true });
        assert.deepStrictEqual(Array.from(sub.getBytes()), Array.from(data.slice(5, 14)));
        assert.strictEqual(sub.pos, 5, 'lengthless reads retain Stream cursor semantics');
        assert.deepStrictEqual(Array.from(sub.getByteRange(7, 12)), Array.from(data.slice(7, 12)));
        assert.deepStrictEqual(Array.from(sub.getBytes(3)), Array.from(data.slice(5, 8)));
        assert.strictEqual(stream.pos, 11);
        assert.strictEqual(stream.getRangeCacheStats().residentBytes, 19);
    });

    it('evicts least recently used chunks, invalidates substream fast paths, and preserves issued byte views', () => {
        const stream = new worker.SparseChunkedStream(16, 4, null, 8);
        stream.onReceiveData(0, bytes(16));
        const sub = stream.makeSubStream(0, 4);
        const held = sub.getBytes(4);
        stream.getByteRange(8, 12);
        stream.getByteRange(12, 16);
        stream.trimRangeCache();
        assert.strictEqual(stream.getRangeCacheStats().residentBytes, 8);
        assert.strictEqual(stream.getRangeCacheStats().evictedBytes, 8);
        assert.deepStrictEqual(Array.from(held), [0, 1, 2, 3]);
        sub.reset();
        assert.throws(() => sub.getByte(), worker.MissingDataException);
        stream.onReceiveData(0, bytes(4));
        assert.strictEqual(sub.getByte(), 0);
        assert.strictEqual(stream.getRangeCacheStats().peakBytes, 16);
    });

    it('handles partial progressive chunks and reloads an evicted progressive prefix', () => {
        const stream = new worker.SparseChunkedStream(14, 4, null, 4);
        stream.onReceiveProgressiveData(bytes(6));
        assert.deepStrictEqual(Array.from(stream.getByteRange(0, 6)), [0, 1, 2, 3, 4, 5]);
        stream.trimRangeCache();
        assert.throws(() => stream.getByteRange(0, 1), worker.MissingDataException);
        assert.throws(() => stream.makeSubStream(0, 2), worker.MissingDataException);
        assert.deepStrictEqual(Array.from(stream.getByteRange(4, 6)), [4, 5]);
        stream.onReceiveProgressiveData(bytes(14).slice(6));
        assert.deepStrictEqual(Array.from(stream.getByteRange(4, 14)), Array.from(bytes(14).slice(4)));
        stream.onReceiveData(0, bytes(4));
        assert.deepStrictEqual(Array.from(stream.getByteRange(0, 14)), Array.from(bytes(14)));
    });

    it('allows a large active operation then trims only after the last hold is released', async () => {
        const { cache, source, stream } = manager(bytes(32));
        const release = cache.holdRangeCache();
        const second = cache.holdRangeCache();
        try {
            await cache.requestRange(0, 32);
            assert.strictEqual(cache.trimRangeCache().residentBytes, 32);
            assert.deepStrictEqual(Array.from(stream.makeSubStream(0, 32).getBytes()), Array.from(bytes(32)));
            release();
            assert.strictEqual(cache.trimRangeCache().residentBytes, 32);
            second();
            assert.strictEqual(cache.trimRangeCache().residentBytes, 8);
            assert.strictEqual(cache.getRangeCacheStats().peakBytes, 32);
            assert.strictEqual(source.active.size, 0);
        } finally { release(); second(); cache.abort(new Error('test complete')); }
    });

    it('keeps pending range replies resident until requests settle and cleans every request map', async () => {
        const { cache, source } = manager(bytes(32), 8, true);
        try {
            const first = cache.requestRange(0, 16);
            const second = cache.requestRange(4, 20);
            assert.strictEqual(source.requests.length, 2, 'overlapping ranges share their pending chunks');
            source.deliver();
            await Promise.all([first, second]);
            assert.strictEqual(cache._chunksNeededByRequest.size, 0);
            assert.strictEqual(cache._requestsByChunk.size, 0);
            assert.strictEqual(cache._promisesByRequest.size, 0);
            assert.strictEqual(source.active.size, 0);
            assert.strictEqual(cache.trimRangeCache().residentBytes, 8);
            await cache.requestRange(16, 20);
            assert.strictEqual(cache._chunksNeededByRequest.size, 0, 'already-resident reads do not leak empty request records');
        } finally { cache.abort(new Error('test complete')); }
    });

    it('rejects all waiters of a failed shared request and releases bookkeeping', async () => {
        const { cache, source } = manager(bytes(16), 8, true);
        try {
            const first = cache.requestRange(0, 8);
            const second = cache.requestRange(0, 8);
            const results = Promise.allSettled([first, second]);
            source.fail(new Error('network failed'));
            assert.deepStrictEqual((await results).map(value => value.status), ['rejected', 'rejected']);
            assert.strictEqual(cache._chunksNeededByRequest.size, 0);
            assert.strictEqual(cache._requestsByChunk.size, 0);
            assert.strictEqual(cache._promisesByRequest.size, 0);
            assert.strictEqual(source.active.size, 0);
        } finally { cache.abort(new Error('test complete')); }
    });

    it('pins asynchronous ensure calls and missing-data retries until the operation really settles', async () => {
        const { cache, stream } = manager(bytes(32));
        const pdfManager = Object.create(worker.NetworkPdfManager.prototype);
        pdfManager.streamManager = cache;
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        const target = { async read() { await pending; return stream.getByteRange(0, 32); } };
        try {
            await cache.requestRange(0, 32);
            const operation = pdfManager.ensure(target, 'read', []);
            assert.strictEqual(cache.getRangeCacheStats().activeOperations, 1);
            assert.strictEqual(cache.trimRangeCache().residentBytes, 32);
            finish();
            assert.deepStrictEqual(Array.from(await operation), Array.from(bytes(32)));
            assert.strictEqual(cache.getRangeCacheStats().activeOperations, 0);
            assert.strictEqual(cache.trimRangeCache().residentBytes, 8);
            const result = await pdfManager.ensure({ read: () => stream.getByteRange(0, 16) }, 'read', []);
            assert.deepStrictEqual(Array.from(result), Array.from(bytes(16)));
            assert.strictEqual(cache.getRangeCacheStats().activeOperations, 0);
        } finally { finish(); cache.abort(new Error('test complete')); }
    });

    it('clears pending shared requests when a document is aborted', async () => {
        const { cache, source } = manager(bytes(16), 8, true);
        const requests = Promise.allSettled([cache.requestRange(0, 8), cache.requestRange(0, 12)]);
        cache.abort(new Error('document closed'));
        assert.deepStrictEqual((await requests).map(value => value.status), ['rejected', 'rejected']);
        assert.strictEqual(cache._chunksNeededByRequest.size, 0);
        assert.strictEqual(cache._requestsByChunk.size, 0);
        assert.strictEqual(cache._promisesByRequest.size, 0);
        assert.strictEqual(source.active.size, 0);
        const count = source.requests.length;
        await assert.rejects(cache.requestRange(0, 8), /transport is closed/);
        assert.strictEqual(source.requests.length, count, 'an aborted ensure cannot restart network requests');
    });

    it('retries a missing sparse range thrown after an asynchronous decode boundary', async () => {
        const { cache, source, stream } = manager(bytes(32));
        const pdfManager = Object.create(worker.NetworkPdfManager.prototype);
        pdfManager.streamManager = cache;
        const target = { async read() { await Promise.resolve(); return stream.getByteRange(4, 20); } };
        try {
            const result = await pdfManager.ensure(target, 'read', []);
            assert.deepStrictEqual(Array.from(result), Array.from(bytes(32).slice(4, 20)));
            assert.deepStrictEqual(source.requests, [{ begin: 4, end: 20 }]);
            assert.strictEqual(cache.getRangeCacheStats().activeOperations, 0);
            assert.ok(cache.trimRangeCache().residentBytes <= 8);
        } finally { cache.abort(new Error('test complete')); }
    });

    it('restarts a queued JPEG 2000 header when sparse data is missing after its size marker', async () => {
        const data = new Uint8Array(44);
        data.set([0xff, 0x4f, 0xff, 0x51]);
        const header = new DataView(data.buffer);
        header.setUint32(8, 128);
        header.setUint32(12, 96);
        header.setUint16(40, 3);
        const { cache, source, stream } = manager(data);
        const pdfManager = Object.create(worker.NetworkPdfManager.prototype);
        pdfManager.streamManager = cache;
        const dict = new worker.Dict();
        dict.set('Filter', worker.Name.get('JPXDecode'));
        dict.set('Width', 128); dict.set('Height', 96);
        dict.set('ColorSpace', worker.Name.get('DeviceRGB'));
        const image = { stream, dict };
        const target = { async read() {
            return worker.PDFImage.buildImage({
                image, xref: { fetchIfRef: (value: any) => value }, res: worker.Dict.empty,
                globalColorSpaceCache: new worker.GlobalColorSpaceCache(),
                localColorSpaceCache: new worker.LocalColorSpaceCache(),
            });
        } };
        try {
            await cache.requestRange(0, 4);
            const decoded = await pdfManager.ensure(target, 'read', []);
            assert.deepStrictEqual([decoded.width, decoded.height, decoded.numComps, decoded.bpc], [128, 96, 3, 8]);
            assert.ok(source.requests.length > 2, 'the size fields are read across separately refetched chunks');
            assert.strictEqual(stream.pos, stream.start, 'every parse outcome returns the encoded stream to its start');
            assert.strictEqual(cache.getRangeCacheStats().activeOperations, 0);
            assert.ok(cache.trimRangeCache().residentBytes <= 8);
        } finally { cache.abort(new Error('test complete')); }
    });

    it('reloads all missing bytes after an earlier complete load has been pruned', async () => {
        const { cache, source, stream } = manager(bytes(20));
        try {
            await cache.requestAllChunks();
            assert.deepStrictEqual(Array.from(stream.getByteRange(0, 20)), Array.from(bytes(20)));
            cache.trimRangeCache();
            assert.strictEqual(stream.isDataLoaded, false);
            const before = source.requests.length;
            await cache.requestAllChunks();
            assert.ok(source.requests.length > before);
            assert.deepStrictEqual(Array.from(stream.getByteRange(0, 20)), Array.from(bytes(20)));
        } finally { cache.abort(new Error('test complete')); }
    });

    it('permits a main-thread range transport to refetch its evicted initial prefix', async () => {
        const make = (bounded: boolean) => {
            const transport = new pdfjs.PDFDataRangeTransport(16, bytes(8), true);
            transport.requestDataRange = (begin: number, end: number) => {
                queueMicrotask(() => transport.onDataRange(begin, bytes(16).slice(begin, end)));
            };
            return new pdfjs.PDFDataTransportStream(transport, {
                disableRange: false, disableStream: true, rangeCacheBytes: bounded ? 4 : 0,
            });
        };
        const legacy = make(false);
        assert.strictEqual(legacy.getFullReader().contentLength, 16);
        assert.strictEqual(legacy.getRangeReader(0, 4), null);
        const bounded = make(true);
        bounded.getFullReader();
        const reader = bounded.getRangeReader(0, 4);
        assert.ok(reader);
        assert.deepStrictEqual(Array.from(new Uint8Array((await reader.read()).value)), [0, 1, 2, 3]);
        bounded.cancelAllRequests(new Error('test complete'));
        legacy.cancelAllRequests(new Error('test complete'));
    });

    it('releases native fetch range readers on completion, rejection, and cancellation', async () => {
        const globals = globalThis as any;
        const previousFetch = globals.fetch;
        const url = 'https://example.invalid/book.pdf';
        const signals: any[] = [];
        let fail = false;
        globals.fetch = async (_url: string, options: any) => {
            signals.push(options.signal);
            if (fail) { throw new Error('failed range'); }
            return { url, status: 206, body: { getReader() {
                let done = false;
                return {
                    async read() {
                        if (done) { return { done: true }; }
                        done = true;
                        return { value: bytes(4), done: false };
                    },
                    cancel() {},
                };
            } } };
        };
        const source = new pdfjs.PDFFetchStream({ url, rangeCacheBytes: 4, disableStream: true });
        source._responseOrigin = 'https://example.invalid';
        source._fullRequestReader = { _loaded: 16, cancel() {} };
        try {
            const completed = source.getRangeReader(0, 4);
            assert.strictEqual(source._rangeRequestReaders.length, 1);
            assert.deepStrictEqual(Array.from(new Uint8Array((await completed.read()).value)), [0, 1, 2, 3]);
            assert.strictEqual((await completed.read()).done, true);
            assert.strictEqual(source._rangeRequestReaders.length, 0);
            fail = true;
            await assert.rejects(source.getRangeReader(0, 4).read(), /failed range/);
            assert.strictEqual(source._rangeRequestReaders.length, 0);
            fail = false;
            const canceled = source.getRangeReader(0, 4);
            canceled.cancel(new Error('test complete'));
            assert.strictEqual(source._rangeRequestReaders.length, 0);
            const concurrent = Array.from({ length: 3 }, () => source.getRangeReader(0, 4));
            await Promise.all(concurrent.map(reader => reader.read()));
            assert.strictEqual(source._rangeRequestReaders.length, 3);
            source.cancelAllRequests(new Error('document closed'));
            assert.strictEqual(source._rangeRequestReaders.length, 0, 'removing readers during cancellation cannot skip another reader');
            assert.ok(signals.slice(-3).every(signal => signal.aborted));
        } finally { globals.fetch = previousFetch; }
    });

    it('releases native file range readers after repeated prefix refetches', async () => {
        const file = path.join(dir, 'ranges.bin');
        fs.writeFileSync(file, bytes(16));
        const source = new pdfjs.PDFNodeStream({ url: file, rangeCacheBytes: 4, disableStream: true });
        source._fullRequestReader = { _loaded: 16, cancel() {} };
        for (let iteration = 0; iteration < 3; iteration++) {
            const reader = source.getRangeReader(0, 4);
            const parts: number[] = [];
            for (;;) {
                const result = await reader.read();
                if (result.done) { break; }
                parts.push(...new Uint8Array(result.value));
            }
            assert.deepStrictEqual(parts, [0, 1, 2, 3]);
            assert.strictEqual(source._rangeRequestReaders.length, 0);
        }
        const concurrent = Array.from({ length: 3 }, () => source.getRangeReader(0, 4));
        await Promise.all(concurrent.map(reader => reader.read()));
        source.cancelAllRequests(new Error('document closed'));
        assert.strictEqual(source._rangeRequestReaders.length, 0);
        assert.ok(concurrent.every(reader => reader._readableStream.destroyed));
    });

    it('hashes a sparse ToUnicode stream using only its requested font range', () => {
        const data = bytes(32);
        const sparse = new worker.SparseChunkedStream(32, 4, null, 8);
        sparse.onReceiveData(8, data.slice(8, 16));
        const font = (stream: any) => {
            const dict = new worker.Dict();
            dict.set('Subtype', worker.Name.get('Type1'));
            dict.set('FontDescriptor', new worker.Dict());
            dict.set('ToUnicode', stream);
            return worker.PartialEvaluator.prototype.preEvaluateFont.call({}, dict).hash;
        };
        const expected = font(new worker.Stream(data.slice(8, 16)));
        assert.strictEqual(font(sparse.makeSubStream(8, 8)), expected);
        assert.strictEqual(sparse.getRangeCacheStats().residentBytes, 8);
        assert.strictEqual(sparse.bytes.byteLength, 0);
    });

    function lzwLiterals(pixels: string) {
        const codes: number[] = [];
        // Clear before the nine-bit dictionary grows; literal codes independently encode the fixture.
        for (let start = 0; start < pixels.length; start += 200) {
            codes.push(256);
            for (let i = start; i < Math.min(start + 200, pixels.length); i++) { codes.push(pixels.charCodeAt(i)); }
        }
        codes.push(257);
        const encoded = Buffer.alloc(Math.ceil(codes.length * 9 / 8));
        let bit = 0;
        for (const code of codes) {
            for (let shift = 8; shift >= 0; shift--, bit++) { encoded[bit >> 3] |= (code >> shift & 1) << (7 - (bit & 7)); }
        }
        return encoded.toString('latin1');
    }

    function fixture(withImage = false, imageCount = 1, lzw = false) {
        const objects: string[] = [];
        const pages = 4;
        objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        objects[2] = '<< /Type /Pages /Kids [' + Array.from({ length: pages }, (_, i) => (3 + i * 2) + ' 0 R').join(' ') + '] /Count ' + pages + ' >>';
        for (let i = 0; i < pages; i++) {
            const page = 3 + i * 2;
            const images = Array.from({ length: imageCount }, (_, index) => index);
            const resources = withImage ? ' /XObject << ' + images.map(index => '/Image' + index + ' ' + (11 + index) + ' 0 R').join(' ') + ' >> ' : '';
            objects[page] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources <<' + resources + '>> /Contents ' + (page + 1) + ' 0 R >>';
            const content = '% ' + 'padding '.repeat(lzw ? 32 : 12288) + '\nq 0 0 1 rg 20 20 50 50 re f Q\n' + (withImage ? images.map(index => 'q 128 0 0 128 0 0 cm /Image' + index + ' Do Q\n').join('') : '');
            objects[page + 1] = '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + 'endstream';
        }
        if (withImage) {
            for (let index = 0; index < imageCount; index++) {
                const pixels = String.fromCharCode(97 + index).repeat(128 * 128 * 3);
                const encoded = lzw ? lzwLiterals(pixels) : pixels;
                objects[11 + index] = '<< /Type /XObject /Subtype /Image /Width 128 /Height 128 /ColorSpace /DeviceRGB /BitsPerComponent 8'
                    + (lzw ? ' /Filter /LZWDecode' : '') + ' /Length ' + encoded.length + ' >>\nstream\n' + encoded + '\nendstream';
            }
        }
        let text = '%PDF-1.7\n';
        const offsets = [0];
        for (let i = 1; i < objects.length; i++) {
            offsets[i] = Buffer.byteLength(text, 'latin1');
            text += i + ' 0 obj\n' + objects[i] + '\nendobj\n';
        }
        const xref = Buffer.byteLength(text, 'latin1');
        text += 'xref\n0 ' + objects.length + '\n0000000000 65535 f \n';
        for (let i = 1; i < objects.length; i++) { text += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'; }
        text += 'trailer\n<< /Size ' + objects.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
        return new Uint8Array(Buffer.from(text, 'latin1'));
    }

    it('round-trips stats/trim through the real document and worker proxies and materializes only explicit getData', async () => {
        const data = fixture();
        const requests: { begin: number; end: number }[] = [];
        const chunk = 16384;
        const transport = new pdfjs.PDFDataRangeTransport(data.length, data.slice(0, chunk), true);
        transport.requestDataRange = (begin: number, end: number) => {
            requests.push({ begin, end });
            queueMicrotask(() => transport.onDataRange(begin, data.slice(begin, end)));
        };
        const task = pdfjs.getDocument({
            range: transport, rangeChunkSize: chunk, rangeCacheBytes: chunk * 2,
            disableAutoFetch: true, disableStream: true, isEvalSupported: false,
            isOffscreenCanvasSupported: false, useSystemFonts: true,
        });
        try {
            const document = await task.promise;
            assert.strictEqual(document.numPages, 4);
            const first = await document.getPage(1);
            const operations = await first.getOperatorList();
            assert.ok(operations.fnArray.length > 0);
            const before = await document.getRangeCacheStats();
            assert.strictEqual(before.length, data.length);
            assert.ok(before.peakBytes > before.maxBytes, 'a large active content stream may exceed the idle budget');
            const trimmed = await document.trimRangeCache();
            assert.ok(trimmed.residentBytes <= chunk * 2);
            const prefixRequests = requests.filter(range => range.begin === 0).length;
            await document.cleanup();
            first.cleanup();
            await first.getOperatorList();
            assert.ok(requests.filter(range => range.begin === 0).length > prefixRequests, 'the initial prefix can be fetched again');
            const full = await document.getData();
            assert.deepStrictEqual(Array.from(full), Array.from(data));
            const after = await document.trimRangeCache();
            assert.ok(after.residentBytes <= chunk * 2);
            const saved = await document.saveDocument();
            assert.deepStrictEqual(Array.from(saved), Array.from(data));
            assert.ok((await document.trimRangeCache()).residentBytes <= chunk * 2);
        } finally { await task.destroy(); }
    });

    it('pins a detached image decoder after its operator-list task has finished', async () => {
        const data = fixture(true);
        const chunk = 16384;
        const transport = new pdfjs.PDFDataRangeTransport(data.length, data.slice(0, chunk), true);
        transport.requestDataRange = (begin: number, end: number) => {
            queueMicrotask(() => transport.onDataRange(begin, data.slice(begin, end)));
        };
        let releaseImage!: () => void;
        let imageStarted!: () => void;
        const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
        const started = new Promise<void>(resolve => { imageStarted = resolve; });
        const createImageData = worker.PDFImage.prototype.createImageData;
        worker.PDFImage.prototype.createImageData = async function (...args: any[]) {
            imageStarted();
            await imageGate;
            return createImageData.apply(this, args);
        };
        const task = pdfjs.getDocument({
            range: transport, rangeChunkSize: chunk, rangeCacheBytes: chunk * 2,
            disableAutoFetch: true, disableStream: true, isEvalSupported: false,
            isOffscreenCanvasSupported: false, useSystemFonts: true,
        });
        try {
            const document = await task.promise;
            const first = await document.getPage(1);
            const operations = await first.getOperatorList();
            await started;
            const pending = await document.trimRangeCache();
            assert.ok(pending.activeOperations > 0);
            assert.ok(pending.residentBytes > pending.maxBytes, 'unfinished image work retains its oversized resource set');
            const imageIndex = operations.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
            assert.ok(imageIndex >= 0);
            const decoded = new Promise<any>(resolve => first.objs.get(operations.argsArray[imageIndex][0], resolve));
            releaseImage();
            const image = await decoded;
            assert.strictEqual(image.width, 128);
            assert.strictEqual(image.height, 128);
            assert.strictEqual(image.data[0], 97);
            const finished = await document.trimRangeCache();
            assert.strictEqual(finished.activeOperations, 0);
            assert.ok(finished.residentBytes <= finished.maxBytes);
        } finally {
            releaseImage();
            worker.PDFImage.prototype.createImageData = createImageData;
            await task.destroy();
        }
    });

    it('pins only the active image and refetches evicted queued images between decode slots', async () => {
        const data = fixture(true, 3);
        const chunk = 16384;
        const transport = new pdfjs.PDFDataRangeTransport(data.length, data.slice(0, chunk), true);
        const requests: Array<{ begin: number; end: number }> = [];
        transport.requestDataRange = (begin: number, end: number) => {
            requests.push({ begin, end });
            queueMicrotask(() => transport.onDataRange(begin, data.slice(begin, end)));
        };
        const gate = () => {
            let resolve!: () => void;
            const promise = new Promise<void>(finish => { resolve = finish; });
            return { promise, resolve };
        };
        const started = Array.from({ length: 3 }, gate);
        const finished = Array.from({ length: 3 }, gate);
        const seen = new WeakMap<object, number>();
        let next = 0;
        const createImageData = worker.PDFImage.prototype.createImageData;
        worker.PDFImage.prototype.createImageData = async function (...args: any[]) {
            let index = seen.get(this.image);
            if (index === undefined) { index = next++; seen.set(this.image, index); }
            assert.ok(index < 3, 'missing-range retries reuse their original image stream');
            started[index].resolve();
            await finished[index].promise;
            return createImageData.apply(this, args);
        };
        const task = pdfjs.getDocument({
            range: transport, rangeChunkSize: chunk, rangeCacheBytes: chunk * 2,
            imageDecodeConcurrency: 1, disableAutoFetch: true, disableStream: true,
            isEvalSupported: false, isOffscreenCanvasSupported: false, useSystemFonts: true,
        });
        try {
            const document = await task.promise;
            const page = await document.getPage(1);
            const operations = await page.getOperatorList();
            await started[0].promise;
            const before = await document.getRangeCacheStats();
            assert.strictEqual(before.imageDecodeActive, 1);
            assert.strictEqual(before.imageDecodeQueued, 2);
            assert.strictEqual(before.activeOperations, 1, 'waiting image jobs do not pin all sparse ranges');
            const initialRequests = requests.length;
            const ids = operations.fnArray.flatMap((fn: number, index: number) => fn === pdfjs.OPS.paintImageXObject ? [operations.argsArray[index][0]] : []);
            const decoded = Promise.all(ids.map((id: string) => new Promise<any>(resolve => page.objs.get(id, resolve))));
            finished[0].resolve();
            await started[1].promise;
            const between = await document.getRangeCacheStats();
            assert.ok(between.evictedBytes > before.evictedBytes, 'completed work lets the idle budget trim before the next decode');
            assert.strictEqual(between.activeOperations, 1);
            finished[1].resolve();
            await started[2].promise;
            finished[2].resolve();
            const images = await decoded;
            assert.deepStrictEqual(images.map(image => image?.data[0]), [97, 98, 99], 'all queued images retain their actual pixels after eviction');
            assert.ok(requests.length > initialRequests, 'an evicted queued stream is requested again when admitted');
            const after = await document.trimRangeCache();
            assert.strictEqual(after.activeOperations, 0);
            assert.ok(after.residentBytes <= after.maxBytes);
            assert.strictEqual(after.imageDecodePeakActive, 1);
        } finally {
            for (const item of finished) { item.resolve(); }
            worker.PDFImage.prototype.createImageData = createImageData;
            await task.destroy();
        }
    });

    it('decodes every LZW pixel after an evicted middle chunk is refetched in its queue slot', async () => {
        const data = fixture(true, 3, true);
        const chunk = 16384;
        const transport = new pdfjs.PDFDataRangeTransport(data.length, data.slice(0, chunk), true);
        const requests: Array<{ begin: number; end: number }> = [];
        transport.requestDataRange = (begin: number, end: number) => {
            requests.push({ begin, end });
            queueMicrotask(() => transport.onDataRange(begin, data.slice(begin, end)));
        };
        let releaseFirst!: () => void;
        let firstStarted!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        const started = new Promise<void>(resolve => { firstStarted = resolve; });
        let first = true;
        const createImageData = worker.PDFImage.prototype.createImageData;
        worker.PDFImage.prototype.createImageData = async function (...args: any[]) {
            if (first) { first = false; firstStarted(); await firstGate; }
            return createImageData.apply(this, args);
        };
        const missing: number[] = [];
        const buildImage = worker.PDFImage.buildImage;
        worker.PDFImage.buildImage = async function (options: any) {
            for (const base of options.image.getBaseStreams() || []) {
                const middle = Math.floor((base.start + base.end) / 2 / chunk);
                if (!base.hasChunk(middle)) {
                    missing.push(middle * chunk);
                    assert.strictEqual(options.xref.pdfManager.imageDecodeQueue.active, 1);
                    assert.strictEqual(options.xref.pdfManager.streamManager.getRangeCacheStats().activeOperations, 1);
                }
            }
            return buildImage.call(this, options);
        };
        const task = pdfjs.getDocument({
            range: transport, rangeChunkSize: chunk, rangeCacheBytes: chunk * 2,
            imageDecodeConcurrency: 1, disableAutoFetch: true, disableStream: true,
            isEvalSupported: false, isOffscreenCanvasSupported: false, useSystemFonts: true,
        });
        try {
            const document = await task.promise;
            const page = await document.getPage(1);
            const operations = await page.getOperatorList();
            await started;
            const before = await document.getRangeCacheStats();
            assert.strictEqual(before.imageDecodeActive, 1);
            assert.strictEqual(before.imageDecodeQueued, 2);
            assert.strictEqual(before.activeOperations, 1);
            const initialRequests = requests.length;
            const ids = operations.fnArray.flatMap((fn: number, index: number) => fn === pdfjs.OPS.paintImageXObject ? [operations.argsArray[index][0]] : []);
            assert.strictEqual(ids.length, 3);
            const decoded = Promise.all(ids.map((id: string) => new Promise<any>(resolve => page.objs.get(id, resolve))));
            releaseFirst();
            const images = await decoded;
            assert.ok(missing.length, 'a queued LZW image enters its active slot with an evicted middle chunk');
            assert.ok(missing.some(begin => requests.slice(initialRequests).some(range => range.begin <= begin && range.end >= begin + chunk)), 'the missing middle chunk is requested again');
            for (const [index, image] of images.entries()) {
                assert.ok(image, 'the incremental decoder must produce an image');
                assert.deepStrictEqual([image.width, image.height, image.data.length], [128, 128, 128 * 128 * 3]);
                assert.ok(image.data.every((value: number) => value === 97 + index), 'every image byte survives the refetch, including bytes beyond the missing chunk');
            }
            const after = await document.trimRangeCache();
            assert.strictEqual(after.activeOperations, 0);
            assert.strictEqual(after.imageDecodePeakActive, 1);
            assert.ok(after.residentBytes <= after.maxBytes);
        } finally {
            releaseFirst();
            worker.PDFImage.prototype.createImageData = createImageData;
            worker.PDFImage.buildImage = buildImage;
            await task.destroy();
        }
    });
});
