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
});
