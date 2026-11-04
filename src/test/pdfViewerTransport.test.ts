/* eslint-disable @typescript-eslint/naming-convention -- pdf.js's export names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// tsc turns import() into require(), which cannot load ES modules
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

/**
 * The viewers' range transport factory (views/pdf-viewer/src/common/transport.ts) bundled as
 * the viewers bundle it, around Overleaf's unmodified loader, and run in Node with the few page
 * globals that the loader reads.
 */
describe('the PDF viewers\' range transport', function () {
    this.timeout(30 * 1000);
    const saved: Record<string, PropertyDescriptor | undefined> = {};
    const globals: Record<string, unknown> = {};
    let dir: string;
    let loader: any;
    const requests: Array<{ url: string, range: string | null }> = [];
    /** the download domain's answer to a request; by default it fails every request */
    let respond = (_url: string): Promise<any> => Promise.resolve(new (globalThis as any).Response('unavailable', { status: 500, statusText: 'Internal Server Error' }));

    before(async () => {
        class PDFDataRangeTransport {
            constructor(readonly length: number, readonly initialData: Uint8Array) {}
            onDataRange(_begin: number, _chunk: Uint8Array | null) {}
        }
        class ResponseException extends Error {
            constructor(message: string | undefined, readonly status: number, readonly missing: boolean) { super(message); }
        }
        const config = { engine: 'overleaf', pdfjs: { build: 'https://webview.test/b/', cMapUrl: '', standardFontDataUrl: '', wasmUrl: '', iccUrl: '', imageResourcesPath: '' } };
        Object.assign(globals, {
            window: globalThis,
            location: new URL('https://webview.test/index.html'),
            document: { getElementById: (id: string) => id === 'viewer-config' ? { textContent: JSON.stringify(config) } : null },
            pdfjsLib: { PDFDataRangeTransport, ResponseException },
            fetch: async (url: string, init?: { headers?: { get(name: string): string | null } }) => {
                requests.push({ url, range: init?.headers?.get('Range') ?? null });
                return respond(url);
            },
        });
        for (const [name, value] of Object.entries(globals)) {
            saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }

        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-transport-'));
        const entry = path.join(dir, 'entry.ts');
        fs.writeFileSync(entry, [
            `export { generatePdfCachingTransportFactory } from ${JSON.stringify(path.join(viewerRoot, 'src', 'common', 'transport.ts'))};`,
            `export { createBridgeResponse } from ${JSON.stringify(path.join(viewerRoot, 'src', 'common', 'bridge-response.ts'))};`,
            `export { fallbackRequest } from ${JSON.stringify(path.join(viewerRoot, 'overleaf', 'services', 'web', 'frontend', 'js', 'features', 'pdf-preview', 'util', 'pdf-caching.ts'))};`,
            `export { getPdfCachingMetrics } from ${JSON.stringify(path.join(viewerRoot, 'overleaf', 'services', 'web', 'frontend', 'js', 'features', 'pdf-preview', 'util', 'metrics.ts'))};`,
        ].join('\n'));
        await esbuild.build({ ...bundleOptions, entryPoints: [entry], outfile: path.join(dir, 'transport.mjs') });
        // esbuild's service process is not needed any more; another build starts it again
        await esbuild.stop();
        // Overleaf's debugConsole keeps the console functions of when it is loaded; these stay quiet
        const quiet = { warn: console.warn, error: console.error };
        console.warn = console.error = () => {};
        try {
            loader = await importModule(path.join(dir, 'transport.mjs'));
        } finally { Object.assign(console, quiet); }
    });

    after(() => {
        for (const name of Object.keys(globals)) {
            if (saved[name]) { Object.defineProperty(globalThis, name, saved[name]!); } else { delete (globalThis as any)[name]; }
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** a load whose failures go to `onError` (the page's handleFetchError) */
    const load = (onError: (error: unknown) => void) => ({
        url: 'https://dl.test/zone/d/project/p1/user/u1/build/b1-x/output/output.pdf?compileGroup=standard&clsiserverid=c1&enable_pdf_caching=true',
        pdfFile: { path: 'output.pdf', url: '/project/p1/user/u1/build/b1-x/output/output.pdf', type: 'pdf', build: 'b1-x', size: 1_000_000, ranges: [], contentId: 'c1', editorId: '', clsiCacheShard: '' },
        abortController: new AbortController(),
        handleFetchError: onError,
    });

    it('makes a range transport for every load, also after a request failed', async () => {
        const factory = loader.generatePdfCachingTransportFactory();
        const errors: unknown[] = [];
        let reported!: () => void;
        const failed = new Promise<void>(resolve => { reported = resolve; });
        const first = factory(load((error) => { errors.push(error); reported(); }));
        assert.ok(first instanceof (globalThis as any).pdfjsLib.PDFDataRangeTransport, 'the flags turn Overleaf\'s caching on');
        assert.strictEqual(first.length, 1_000_000);

        const quiet = { warn: console.warn, error: console.error };
        console.warn = console.error = () => {}; // the error reporter's stand-in warns
        try {
            first.requestDataRange(0, 131072);
            // the range request fails, then Overleaf's fallback request; the failure reaches the page once
            await failed;
        } finally { Object.assign(console, quiet); }
        assert.strictEqual(errors.length, 1, 'the failure reaches the page');
        // the range request, then Overleaf's fallback request for the same range
        assert.deepStrictEqual(requests.map(r => r.range), ['bytes=0-131071', 'bytes=0-131071']);
        // with this flag set, Overleaf's factory returns undefined for every later load (pdf-caching-transport.ts:304-308)
        assert.strictEqual(loader.getPdfCachingMetrics().failedOnce, true);

        const second = factory(load((error) => errors.push(error)));
        assert.ok(second instanceof (globalThis as any).pdfjsLib.PDFDataRangeTransport);
        assert.strictEqual(loader.getPdfCachingMetrics().failedOnce, false);
    });

    it('does not ask Overleaf\'s cache for a build whose compile named no shard of it', async () => {
        const build = '19a0b1c2d3e-fedcba9876543210';
        // the compile server deleted the build, and the compile answer named no shard of the cache
        respond = async () => new (globalThis as any).Response('not found', { status: 404, statusText: 'Not Found' });
        requests.length = 0;
        const factory = loader.generatePdfCachingTransportFactory();
        let reported!: () => void;
        const failed = new Promise<void>(resolve => { reported = resolve; });
        const transport = factory({
            url: `https://dl.test/zone/d/project/p1/user/u1/build/${build}/output/output.pdf?compileGroup=standard&clsiserverid=clsi-vm-7&enable_pdf_caching=true`,
            pdfFile: { path: 'output.pdf', url: `/project/p1/user/u1/build/${build}/output/output.pdf`, type: 'pdf', build, size: 1_000_000, ranges: [], contentId: 'c1', editorId: '', clsiCacheShard: '' },
            abortController: new AbortController(),
            handleFetchError: () => reported(),
        });
        const quiet = { warn: console.warn, error: console.error };
        console.warn = console.error = () => {};
        try {
            transport.requestDataRange(0, 1024);
            // the failure reaches the page, which reports the build gone
            await failed;
        } finally { Object.assign(console, quiet); }
        const servers = requests.map(r => new URL(r.url).searchParams.get('clsiserverid'));
        assert.ok(servers.length > 0 && servers.every(server => server === 'clsi-vm-7'), JSON.stringify(servers));
    });

    it('decides the fallback to Overleaf\'s cache by each load\'s own build, also for a request that fails after a newer load began', async () => {
        // the older build's compile named no shard of the cache, the newer build's named one
        const older = '19a0b1c2d3e-0000000000000001';
        const newer = '19a0b1c2d4e-0000000000000002';
        const notFound = () => new (globalThis as any).Response('not found', { status: 404, statusText: 'Not Found' });
        // the older load's request waits until the newer load has begun, then the compile server answers 404
        let answerOlder!: () => void;
        const olderAnswer = new Promise<any>(resolve => { answerOlder = () => resolve(notFound()); });
        respond = async (url: string) => new URL(url).pathname.includes(`/build/${older}/`) ? olderAnswer : notFound();
        requests.length = 0;
        const factory = loader.generatePdfCachingTransportFactory();
        let reported!: () => void;
        const failed = new Promise<void>(resolve => { reported = resolve; });
        const olderLoad = factory({
            url: `https://dl.test/zone/d/project/p1/user/u1/build/${older}/output/output.pdf?compileGroup=standard&clsiserverid=clsi-vm-7&enable_pdf_caching=true`,
            pdfFile: { path: 'output.pdf', url: `/project/p1/user/u1/build/${older}/output/output.pdf`, type: 'pdf', build: older, size: 1_000_000, ranges: [], contentId: 'c1', editorId: '', clsiCacheShard: '' },
            abortController: new AbortController(),
            handleFetchError: () => reported(),
        });
        const quiet = { warn: console.warn, error: console.error };
        console.warn = console.error = () => {};
        try {
            olderLoad.requestDataRange(0, 1024);
            factory({
                url: `https://dl.test/zone/d/project/p1/user/u1/build/${newer}/output/output.pdf?compileGroup=priority&clsiserverid=clsi-vm-8&enable_pdf_caching=true`,
                pdfFile: { path: 'output.pdf', url: `/project/p1/user/u1/build/${newer}/output/output.pdf`, type: 'pdf', build: newer, size: 1_000_000, ranges: [], contentId: 'c2', editorId: '0d9c1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f', clsiCacheShard: 'clsi-cache-shard-1' },
                abortController: new AbortController(),
                handleFetchError: () => {},
            });
            answerOlder();
            await failed;
        } finally { Object.assign(console, quiet); }
        // the older load asks only the compile server: its build names no shard to ask
        const servers = requests.map(r => new URL(r.url).searchParams.get('clsiserverid'));
        assert.ok(servers.length > 0 && servers.every(server => server === 'clsi-vm-7'), JSON.stringify(servers));
    });

    it('fetches a range from Overleaf\'s cache of compile outputs when the compile server has deleted the build', async () => {
        const editorId = '0d9c1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
        const build = '19a0b1c2d3e-0123456789abcdef';
        const bytes = new Uint8Array(1024).fill(7);
        // the compile server deleted the build; the cache's shard has it under /build/<editor>-<build>/
        respond = async (url: string) => {
            const u = new URL(url);
            if (u.searchParams.get('clsiserverid') === 'clsi-cache-shard-1' && u.pathname.includes(`/build/${editorId}-${build}/`)) {
                return new (globalThis as any).Response(bytes, { status: 206, headers: { 'Content-Range': `bytes 0-1023/1000000`, 'Content-Length': '1024' } });
            }
            return new (globalThis as any).Response('not found', { status: 404, statusText: 'Not Found' });
        };
        requests.length = 0;
        const factory = loader.generatePdfCachingTransportFactory();
        // the range's outcome: its data, or the failure that reaches the page
        let settle!: (outcome: { begin: number, length: number } | { error: unknown }) => void;
        const outcome = new Promise<{ begin: number, length: number } | { error: unknown }>(resolve => { settle = resolve; });
        const transport = factory({
            url: `https://dl.test/zone/d/project/p1/user/u1/build/${build}/output/output.pdf?compileGroup=priority&clsiserverid=clsi-vm-7&enable_pdf_caching=true`,
            pdfFile: { path: 'output.pdf', url: `/project/p1/user/u1/build/${build}/output/output.pdf`, type: 'pdf', build, size: 1_000_000, ranges: [], contentId: 'c1', editorId, clsiCacheShard: 'clsi-cache-shard-1' },
            abortController: new AbortController(),
            handleFetchError: (error: unknown) => settle({ error }),
        });
        transport.onDataRange = (begin: number, chunk: Uint8Array | null) => settle({ begin, length: chunk?.byteLength ?? 0 });
        const quiet = { warn: console.warn, error: console.error };
        console.warn = console.error = () => {};
        try {
            transport.requestDataRange(0, 1024);
            assert.deepStrictEqual(await outcome, { begin: 0, length: 1024 });
        } finally { Object.assign(console, quiet); }
        const urls = requests.map(r => new URL(r.url));
        assert.strictEqual(urls[0].searchParams.get('clsiserverid'), 'clsi-vm-7', 'first the compile server');
        assert.strictEqual(urls.at(-1)!.searchParams.get('clsiserverid'), 'clsi-cache-shard-1', 'then the cache');
        assert.ok(urls.at(-1)!.pathname.endsWith(`/build/${editorId}-${build}/output/output.pdf`), urls.at(-1)!.pathname);
    });

    it('consumes owned bridge streams in the pinned range assembler and fallback without body materialization', async () => {
        requests.length = 0;
        let materializations = 0;
        const responses: any[] = [];
        respond = async () => {
            const response = loader.createBridgeResponse(new Uint8Array(1024).fill(37), {
                status: 206, headers: { 'Content-Range': 'bytes 4096-5119/1000000', 'Content-Length': '1024' },
            });
            const original = response.arrayBuffer;
            response.arrayBuffer = () => { materializations++; return original.call(response); };
            responses.push(response);
            return response;
        };
        let resolve!: (value: { begin: number, chunk: Uint8Array | null }) => void;
        let reject!: (error: unknown) => void;
        const result = new Promise<{ begin: number, chunk: Uint8Array | null }>((yes, no) => { resolve = yes; reject = no; });
        const input = load(reject);
        const transport = loader.generatePdfCachingTransportFactory()(input);
        transport.onDataRange = (begin: number, chunk: Uint8Array | null) => resolve({ begin, chunk });
        transport.requestDataRange(4096, 5120);
        const received = await result;
        assert.strictEqual(received.begin, 4096);
        assert.deepStrictEqual(received.chunk, new Uint8Array(1024).fill(37));
        const fallback = await loader.fallbackRequest({ file: transport.pdfFile, url: input.url,
            start: 4096, end: 5120, abortSignal: input.abortController.signal });
        assert.deepStrictEqual(new Uint8Array(fallback), new Uint8Array(1024).fill(37));
        assert.deepStrictEqual(requests.map(request => request.range), ['bytes=4096-5119', 'bytes=4096-5119']);
        assert.strictEqual(materializations, 0, 'both pinned response consumers must use the owned-stream path');
        assert.strictEqual(responses.length, 2);
        assert.ok(responses.every(response => response.bodyUsed && !response.body.locked));
    });

    it('keeps prefetched chunk bytes reusable after the delivered range is transferred to the worker', async () => {
        requests.length = 0;
        const prefix = new TextEncoder().encode('7 0 obj\n');
        const expected = new Uint8Array(4096).fill(53);
        expected.set(prefix);
        respond = async () => loader.createBridgeResponse(new Uint8Array(4096 - prefix.length).fill(53), {
            status: 200, headers: { 'Content-Length': String(4096 - prefix.length) },
        });
        let fail!: (error: unknown) => void;
        const input = load(error => fail(error));
        // The content-addressed piece extends beyond both PDF.js requests. The pinned loader
        // adds its object prefix and keeps the complete piece in file.prefetched for later use.
        const transport = loader.generatePdfCachingTransportFactory()({ ...input,
            pdfFile: { ...input.pdfFile, ranges: [{ start: 4096 + prefix.length, end: 8192,
                hash: 'a'.repeat(40), objectId: '7 0 obj\n' }] },
        });
        const deliver = (start: number, end: number) => new Promise<Uint8Array>((resolve, reject) => {
            fail = reject;
            transport.onDataRange = (begin: number, chunk: Uint8Array | null) => {
                try {
                    assert.strictEqual(begin, start);
                    assert.ok(chunk);
                    // PDFDataTransportStream transfers the final full-span buffer to its worker.
                    const workerBytes = structuredClone(chunk, { transfer: [chunk.buffer] });
                    assert.strictEqual(chunk.byteLength, 0);
                    resolve(workerBytes);
                } catch (error) { reject(error); }
            };
            transport.requestDataRange(start, end);
        });
        assert.deepStrictEqual(await deliver(4096, 5120), expected.subarray(0, 1024));
        assert.strictEqual(transport.pdfFile.prefetched.length, 1);
        const retained: Uint8Array = transport.pdfFile.prefetched[0].buffer;
        const retainedSlice = retained.subarray(2048, 3072);
        assert.deepStrictEqual(retained, expected, 'the first worker transfer must preserve the retained whole piece');
        assert.deepStrictEqual(await deliver(6144, 7168), expected.subarray(2048, 3072));
        assert.strictEqual(requests.length, 1, 'the later range must reuse the retained piece without another response');
        assert.strictEqual(retained.buffer.byteLength, 4096);
        assert.deepStrictEqual(retained, expected);
        assert.deepStrictEqual(retainedSlice, expected.subarray(2048, 3072), 'pre-existing subarrays also remain usable');
    });
});
