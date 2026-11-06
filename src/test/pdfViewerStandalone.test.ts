/* eslint-disable @typescript-eslint/naming-convention -- HTTP headers, PDF.js exports and esbuild extension keys */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const browser = globalThis as any;

describe('the standalone PDF range source', function () {
    this.timeout(30_000);
    let dir: string;
    let rangeModule: any;
    let configModule: any;

    class FakeTransport {
        ranges: { begin: number; bytes: Uint8Array }[] = [];
        progress: number[] = [];
        delivered?: () => void;
        constructor(readonly length: number, readonly initialData: Uint8Array, readonly progressiveDone: boolean, readonly filename: string) {}
        onDataRange(begin: number, bytes: Uint8Array) { this.ranges.push({ begin, bytes }); this.delivered?.(); }
        onDataProgress(loaded: number) { this.progress.push(loaded); }
    }
    const pdfjs = { PDFDataRangeTransport: FakeTransport };

    function metrics() {
        const state = { pending: 0, ended: 0, bytes: 0, events: [] as string[] };
        return {
            state,
            beginFetch() { state.pending++; return () => { state.pending--; state.ended++; }; },
            fetch(bytes: number) { state.bytes += bytes; },
            event(type: string) { state.events.push(type); },
        };
    }

    function response(begin: number, end: number, total: number, headers: Record<string, string> = {}) {
        const bytes = new Uint8Array(end - begin).fill(7);
        return new browser.Response(bytes, { status: 206, headers: {
            'Content-Range': `bytes ${begin}-${end - 1}/${total}`,
            'Content-Length': String(bytes.length),
            'ETag': '"book-a"',
            ...headers,
        } });
    }

    before(async () => {
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-standalone-'));
        await esbuild.build({
            entryPoints: [
                path.join(repo, 'views/pdf-viewer/src/standalone/http-range.ts'),
                path.join(repo, 'views/pdf-viewer/src/standalone/config.ts'),
            ],
            outdir: dir, bundle: true, format: 'esm', platform: 'node', target: 'es2022',
            outExtension: { '.js': '.mjs' }, logLevel: 'silent',
        });
        await esbuild.stop();
        rangeModule = await importModule(path.join(dir, 'http-range.mjs'));
        configModule = await importModule(path.join(dir, 'config.mjs'));
    });

    after(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); } });

    it('reads only the initial chunk and the exact ranges requested by PDF.js', async () => {
        const requests: any[] = [];
        const measured = metrics();
        const total = 1_608_644_855;
        const fetch = async (_url: string, options: any) => {
            requests.push(options);
            const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range)!;
            return response(Number(first), Number(last) + 1, total);
        };
        const source = await rangeModule.openHttpPdfRange(pdfjs, 'https://reader.test/spomenar/book.pdf', {
            fetch, metrics: measured, filename: 'book.pdf', onError: assert.fail,
        });
        try {
            assert.strictEqual(requests.length, 1);
            assert.ok(source.transport.initialData.length < total / 1000);
            assert.strictEqual(source.documentParams.disableAutoFetch, true);
            assert.strictEqual(source.documentParams.disableStream, true);
            assert.strictEqual(source.documentParams.range, source.transport);
            const delivered = new Promise<void>(resolve => { source.transport.delivered = resolve; });
            source.transport.requestDataRange(262144, 393216);
            await delivered;
            await source.settled;
            assert.strictEqual(requests[1].headers.Range, 'bytes=262144-393215');
            assert.strictEqual(requests[1].headers['If-Range'], '"book-a"');
            assert.strictEqual(requests[1].credentials, 'same-origin');
            assert.strictEqual(requests[1].redirect, 'error');
            assert.strictEqual(source.transport.ranges[0].begin, 262144);
            assert.strictEqual(measured.state.pending, 0);
            assert.strictEqual(measured.state.ended, 2);
            assert.strictEqual(measured.state.bytes, source.transport.initialData.length + 131072);
        } finally { source.abort(); }
    });

    it('cancels a whole-file response before reading its body', async () => {
        let cancelled = false;
        const measured = metrics();
        await assert.rejects(rangeModule.openHttpPdfRange(pdfjs, 'https://reader.test/book.pdf', {
            fetch: async () => ({ status: 200, body: { cancel: async () => { cancelled = true; } } }),
            metrics: measured, onError: assert.fail,
        }), /206|range/i);
        assert.strictEqual(cancelled, true);
        assert.strictEqual(measured.state.pending, 0);
        assert.strictEqual(measured.state.ended, 1);
        assert.strictEqual(measured.state.bytes, 0);
    });

    it('rejects mismatched or encoded ranges before accepting PDF bytes', async () => {
        const invalidHeaders: Record<string, string>[] = [
            { 'Content-Range': 'bytes 1-7/8' },
            { 'Content-Range': 'bytes 0-7/*' },
            { 'Content-Length': '99' },
            { 'Content-Encoding': 'gzip' },
        ];
        for (const headers of invalidHeaders) {
            await assert.rejects(rangeModule.openHttpPdfRange(pdfjs, 'https://reader.test/book.pdf', {
                fetch: async () => response(0, 8, 8, headers), metrics: metrics(), onError: assert.fail,
            }), /range|length|encoding/i);
        }
    });

    it('rejects truncated and oversized range bodies', async () => {
        for (const size of [7, 9]) {
            await assert.rejects(rangeModule.openHttpPdfRange(pdfjs, 'https://reader.test/book.pdf', {
                fetch: async () => new browser.Response(new Uint8Array(size), { status: 206, headers: { 'Content-Range': 'bytes 0-7/8' } }),
                metrics: metrics(), onError: assert.fail,
            }), /length|bytes/i);
        }
    });

    it('reports a changed document once and stops subsequent range admission', async () => {
        let calls = 0;
        const errors: Error[] = [];
        let report!: () => void;
        const failed = new Promise<void>(resolve => { report = resolve; });
        const measured = metrics();
        const source = await rangeModule.openHttpPdfRange(pdfjs, 'https://reader.test/book.pdf', {
            fetch: async () => ++calls === 1 ? response(0, 131072, 500000) : response(131072, 262144, 500000, { ETag: '"book-b"' }),
            metrics: measured, onError: (error: Error) => { errors.push(error); report(); },
        });
        source.transport.requestDataRange(131072, 262144);
        await failed;
        await source.settled;
        source.transport.requestDataRange(262144, 393216);
        assert.strictEqual(calls, 2);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0].message, /changed/i);
        assert.strictEqual(source.transport.ranges.length, 0);
        assert.strictEqual(measured.state.pending, 0);
    });

    it('aborts active requests and their telemetry exactly once on destruction', async () => {
        let calls = 0;
        let admitted!: () => void;
        const pending = new Promise<void>(resolve => { admitted = resolve; });
        const measured = metrics();
        const errors: Error[] = [];
        const source = await rangeModule.openHttpPdfRange(pdfjs, 'https://reader.test/book.pdf', {
            fetch: async (_url: string, options: any) => {
                if (++calls === 1) { return response(0, 131072, 500000); }
                admitted();
                return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
            },
            metrics: measured, onError: (error: Error) => errors.push(error),
        });
        source.transport.requestDataRange(131072, 262144);
        await pending;
        assert.strictEqual(measured.state.pending, 1);
        source.transport.abort();
        source.abort();
        await source.settled;
        assert.strictEqual(measured.state.pending, 0);
        assert.strictEqual(measured.state.ended, 2);
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(source.transport.ranges.length, 0);
    });

    it('accepts a short final chunk and Last-Modified when an ETag is weak', async () => {
        const requests: any[] = [];
        const date = 'Wed, 04 Nov 2026 10:00:00 GMT';
        const source = await rangeModule.openHttpPdfRange(pdfjs, 'https://reader.test/book.pdf', {
            fetch: async (_url: string, options: any) => {
                requests.push(options);
                return requests.length === 1
                    ? response(0, 131072, 131077, { ETag: 'W/"book"', 'Last-Modified': date })
                    : response(131072, 131077, 131077, { ETag: 'W/"book"', 'Last-Modified': date });
            }, metrics: metrics(), onError: assert.fail,
        });
        try {
            const delivered = new Promise<void>(resolve => { source.transport.delivered = resolve; });
            source.transport.requestDataRange(131072, 131077);
            await delivered;
            await source.settled;
            assert.strictEqual(requests[1].headers['If-Range'], date);
            assert.strictEqual(source.transport.ranges[0].bytes.length, 5);
        } finally { source.abort(); }
    });

    it('resolves a configurable same-origin PDF without accepting arbitrary origins or credentials', () => {
        const base = 'https://cloud.larics.fer.hr/spomenar/';
        const config = configModule.readSiteConfig({ pdfUrl: './book.pdf', title: 'Spomenar', filename: 'book.pdf' }, base);
        assert.strictEqual(config.pdfUrl, `${base}book.pdf`);
        for (const pdfUrl of ['https://elsewhere.test/book.pdf', 'javascript:alert(1)', 'https://user:pass@cloud.larics.fer.hr/book.pdf']) {
            assert.throws(() => configModule.readSiteConfig({ pdfUrl, title: 'Spomenar', filename: 'book.pdf' }, base), /same.origin|origin|credentials|HTTP/i);
        }
        assert.throws(() => configModule.readSiteConfig({}, base), /pdfUrl/);
    });

    it('uses the viewer supplied PDF-open parameters in a shareable website URL', () => {
        const result = configModule.pageLink('https://cloud.larics.fer.hr/spomenar/?file=old.pdf#page=1', '#page=60&zoom=125,0,320');
        assert.strictEqual(result, 'https://cloud.larics.fer.hr/spomenar/#page=60&zoom=125,0,320');
    });

    it('exposes the actual first PDF response validator for content-bound previews', async () => {
        const source = await rangeModule.openHttpPdfRange(pdfjs, 'https://reader.test/book.pdf', {
            fetch: async () => response(0, 8, 8), metrics: metrics(), onError: assert.fail,
        });
        try {
            assert.deepStrictEqual(source.validator, { header: 'ETag', value: '"book-a"' });
            source.validator.value = 'mutated';
            assert.strictEqual(source.validator.value, '"book-a"', 'callers cannot mutate the transport validator');
        } finally { source.abort(); }
    });

    it('binds optional site previews to the exact observed PDF size and HTTP validator', () => {
        const base = 'https://reader.test/book/';
        const sha256 = 'a'.repeat(64);
        const settings = { pdfUrl: './book.pdf', title: 'Book', filename: 'book.pdf', previews: {
            manifestUrl: './previews/manifest.json', size: 5000, sha256,
            validator: { header: 'ETag', value: '"book-a"' },
        } };
        const config = configModule.readSiteConfig(settings, base);
        assert.strictEqual(config.previews?.manifestUrl, base + 'previews/manifest.json');
        const observed = { length: 5000, validator: { header: 'ETag', value: '"book-a"' } };
        assert.deepStrictEqual(configModule.sitePreviewDescriptor(config, observed), {
            identity: { key: 'sha256:' + sha256, size: 5000, sha256 }, manifestUrl: base + 'previews/manifest.json',
        });
        for (const wrong of [
            { ...observed, length: 5001 },
            { length: 5000 },
            { ...observed, validator: { header: 'ETag', value: '"book-b"' } },
            { ...observed, validator: { header: 'Last-Modified', value: '"book-a"' } },
        ]) { assert.strictEqual(configModule.sitePreviewDescriptor(config, wrong), undefined); }
        for (const previews of [
            { ...settings.previews, manifestUrl: 'https://elsewhere.test/manifest.json' },
            { ...settings.previews, sha256: 'wrong' },
            { ...settings.previews, validator: { header: 'ETag', value: 'W/"book-a"' } },
            { ...settings.previews, size: -1 },
        ]) {
            const invalid = configModule.readSiteConfig({ ...settings, previews }, base);
            assert.strictEqual(invalid.previews, undefined, 'invalid optional preview settings leave the PDF usable');
            assert.strictEqual(invalid.pdfUrl, base + 'book.pdf');
        }
    });

    it('binds an optional structural reading source without changing the original download URL', () => {
        const base = 'https://reader.test/book/', sha256 = 'a'.repeat(64), revision = 'b'.repeat(64);
        const reading = { manifestUrl: './previews/a/reading.json', manifestRevision: revision, size: 5000, sha256,
            validator: { header: 'ETag', value: '"book-a"' } };
        const config = configModule.readSiteConfig({ pdfUrl: './book.pdf', title: 'Book', filename: 'book.pdf', reading }, base);
        assert.strictEqual(config.reading?.manifestUrl, base + 'previews/a/reading.json');
        assert.strictEqual(config.pdfUrl, base + 'book.pdf');
        assert.deepStrictEqual(configModule.siteReadingDescriptor(config, { length: 5000, validator: reading.validator }), {
            identity: { sha256, size: 5000 }, manifestUrl: base + 'previews/a/reading.json', manifestRevision: revision,
        });
        assert.strictEqual(configModule.siteReadingDescriptor(config, { length: 5000,
            validator: { header: 'ETag', value: '"changed"' } }), undefined);
        assert.strictEqual(configModule.readSiteConfig({ pdfUrl: './book.pdf', title: 'Book', filename: 'book.pdf',
            reading: { ...reading, manifestRevision: 'unverified' } }, base).reading, undefined);
    });
});

describe('the standalone website export', function () {
    this.timeout(30_000);
    it('keeps the upstream viewer controls and uses only relative website assets', async () => {
        const build = await importModule(path.join(repo, 'scripts/build-spomenar.mjs'));
        const html = build.standalonePage();
        for (const id of ['viewerContainer', 'viewFindButton', 'viewOutline', 'downloadButton', 'spomenarActions']) {
            assert.ok(html.includes(`id="${id}"`), id);
        }
        assert.ok(html.includes('viewport-fit=cover'));
        assert.ok(!html.includes('maximum-scale=1'));
        assert.ok(!html.includes('acquireVsCodeApi'));
        assert.ok(!html.includes('<!--viewer-config-->'));
        assert.ok(html.indexOf('assets/spomenar.mjs') < html.indexOf('assets/pdfjs/web/viewer.mjs'));
        for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
            if (/\.(?:mjs|css|json)(?:\?|$)/.test(url)) { assert.ok(!/^(?:\/|https?:)/.test(url), url); }
        }
    });
});
