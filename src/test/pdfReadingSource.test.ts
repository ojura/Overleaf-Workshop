/* eslint-disable @typescript-eslint/naming-convention -- HTTP and PDF fixture names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { PDF_READING_LIMITS, validatePdfReadingManifest } from '../core/pdfReadingManifest';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const browser = globalThis as any;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const repo = path.resolve(__dirname, '..', '..');

function fixture(chunkBytes = 6) {
    const pdf = new Uint8Array(Buffer.from('%PDF-1.7 reading fixture'));
    const raw = new Uint8Array([21, 22, 23, 24]);
    const progressive = new Uint8Array([255, 216, 3, 4, 5, 6, 7, 8, 9, 10, 255, 217]);
    const manifest = { version: 1, source: { sha256: 'a'.repeat(64), size: 5000, pageCount: 2 },
        pdf: { path: 'reading/document.pdf', bytes: pdf.length, sha256: sha(pdf) },
        images: [
            { id: 'x1', path: 'reading/x1.bin', bytes: raw.length, sha256: sha(raw), originalSha256: sha(raw),
                width: 2, height: 2, encoding: 'original' },
            { id: 'x2', path: 'reading/x2.jpg', bytes: progressive.length, sha256: sha(progressive),
                originalSha256: 'b'.repeat(64), width: 8, height: 8, components: 3, encoding: 'progressive-jpeg',
                coefficientBytes: 768, chunks: Array.from({ length: progressive.length / chunkBytes }, (_, index) => ({
                    offset: index * chunkBytes, bytes: chunkBytes,
                    sha256: sha(progressive.subarray(index * chunkBytes, (index + 1) * chunkBytes)), scan: index + 1,
                })) },
        ] };
    const manifestBytes = JSON.stringify(manifest);
    const descriptor = { identity: { sha256: manifest.source.sha256, size: manifest.source.size },
        manifestUrl: 'https://reader.test/source/reading.json', manifestRevision: sha(manifestBytes) };
    const resources = new Map([['reading.json', new Uint8Array(Buffer.from(manifestBytes))],
        ['reading/document.pdf', pdf], ['reading/x1.bin', raw], ['reading/x2.jpg', progressive]]);
    const calls: Array<{ url: string; signal: AbortSignal; headers: Record<string, string>; cache?: string }> = [];
    const metrics = { active: 0, ended: 0, bytes: 0, events: [] as any[],
        beginFetch() { this.active++; return () => { this.active--; this.ended++; }; },
        fetch(bytes: number) { this.bytes += bytes; },
        event(type: string, data: any) { this.events.push({ type, data }); } };
    const request = async (url: string, options: any) => {
        calls.push({ url, signal: options.signal, headers: options.headers, cache: options.cache });
        const bytes = resources.get(url.replace('https://reader.test/source/', ''))!;
        assert.ok(bytes, url);
        const range = options.headers.Range && /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
        if (range) {
            const begin = Number(range[1]), end = Number(range[2]) + 1;
            return new browser.Response(bytes.slice(begin, end), { status: 206,
                headers: { 'Content-Range': 'bytes ' + begin + '-' + (end - 1) + '/' + bytes.length, 'Content-Length': String(end - begin) } });
        }
        return new browser.Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
    };
    const controller = new AbortController();
    return { pdf, raw, progressive, manifest, descriptor, resources, calls, metrics, request, controller };
}

describe('source-bound structural reading manifests', () => {
    const shared = JSON.parse(fs.readFileSync(path.join(repo, 'src/test/fixtures/pdfReadingManifest.json'), 'utf8'));
    for (const example of shared.cases) {
        it('matches the shared producer fixture: ' + example.name, () => {
            assert.strictEqual(Boolean(validatePdfReadingManifest(example.manifest, shared.identity)), example.valid);
        });
    }

    it('keeps original filter metadata authoritative and preserves exact progressive scan partitions', () => {
        const f = fixture();
        const result = validatePdfReadingManifest(f.manifest, f.descriptor.identity)!;
        assert.ok(result);
        assert.strictEqual(result.images[0].components, undefined);
        assert.strictEqual(result.images[1].chunks?.[1].offset, 6);
        f.manifest.images[1].chunks![0].bytes = 99;
        assert.strictEqual(result.images[1].chunks?.[0].bytes, 6, 'validated metadata is copied');
    });

    it('rejects source mismatch, duplicate IDs, escaping paths and contradictory raw encodings', () => {
        const f = fixture();
        const edits: Array<(value: any) => void> = [
            m => { m.source.sha256 = 'c'.repeat(64); }, m => { m.source.size++; },
            m => { m.source.pageCount = 0; }, m => { m.images[1].id = 'x1'; },
            m => { m.images[0].path = '../x1.bin'; }, m => { m.images[0].path = 'reading/%2e%2e/x1.bin'; },
            m => { m.images[0].sha256 = 'c'.repeat(64); }, m => { m.images[0].chunks = []; },
            m => { m.images[0].width = 65_536; }, m => { m.pdf.bytes = PDF_READING_LIMITS.pdfBytes + 1; },
        ];
        for (const edit of edits) { const value = copy(f.manifest); edit(value); assert.strictEqual(validatePdfReadingManifest(value, f.descriptor.identity), undefined); }
    });

    it('rejects gaps, overlaps, repeated scans and incomplete progressive coverage', () => {
        const f = fixture();
        const edits: Array<(value: any) => void> = [
            m => { m.images[1].chunks[0].offset = 1; }, m => { m.images[1].chunks[1].offset = 5; },
            m => { m.images[1].chunks[1].bytes = 5; }, m => { m.images[1].chunks[1].scan = 1; },
            m => { m.images[1].components = 4; }, m => { m.images[1].coefficientBytes = 767; },
            m => { m.images[1].width = 8192; m.images[1].height = 8192; },
        ];
        for (const edit of edits) { const value = copy(f.manifest); edit(value); assert.strictEqual(validatePdfReadingManifest(value, f.descriptor.identity), undefined); }
    });
});

describe('bounded structural reading resources', function () {
    this.timeout(30_000);
    let directory: string, api: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-reading-source-'));
        try {
            const entry = path.join(directory, 'entry.ts');
            fs.writeFileSync(entry, `export { openPdfReadingSource } from ${JSON.stringify(path.join(repo, 'views/pdf-viewer/src/common/pdf-reading-source.ts'))};
export { PdfPerformance } from ${JSON.stringify(path.join(repo, 'views/pdf-viewer/src/common/prefetch-performance.ts'))};`);
            await esbuild.build({ entryPoints: [entry],
                outfile: path.join(directory, 'source.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
            api = await importModule(path.join(directory, 'source.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    async function open(f: ReturnType<typeof fixture>, extra: any = {}) {
        return api.openPdfReadingSource(f.descriptor, { signal: f.controller.signal, fetch: f.request, metrics: f.metrics, ...extra });
    }

    it('loads only manifest and structural PDF before a worker requests exact image chunks', async () => {
        const f = fixture(), source = await open(f);
        try {
            assert.deepStrictEqual(source.data, f.pdf);
            assert.strictEqual(f.calls.length, 2);
            assert.ok(source.externalImageSource.images.every((item: any) => item.path === undefined));
            const signal = new AbortController().signal;
            assert.deepStrictEqual(await source.externalImageSource.read({ id: 'x2', chunkIndex: 0, signal }), f.progressive.slice(0, 6));
            assert.deepStrictEqual(await source.externalImageSource.read({ id: 'x2', chunkIndex: 1, signal }), f.progressive.slice(6));
            assert.deepStrictEqual(await source.externalImageSource.read({ id: 'x1', chunkIndex: 0, signal }), f.raw);
            assert.strictEqual(f.calls[2].headers.Range, 'bytes=0-5');
            assert.strictEqual(f.calls[3].headers.Range, 'bytes=6-11');
            assert.strictEqual(f.calls[4].headers.Range, undefined);
            assert.strictEqual(f.calls[0].cache, 'no-cache', 'same-URL manifest revisions must be revalidated');
            assert.ok(f.calls.slice(1).every(call => call.cache === 'default'), 'immutable assets retain normal caching');
            assert.strictEqual(f.metrics.bytes, Buffer.byteLength(JSON.stringify(f.manifest)) + f.pdf.length + f.progressive.length + f.raw.length);
            assert.strictEqual(f.metrics.active, 0);
        } finally { source.dispose(); }
    });

    it('verifies host chunk responses and feeds the existing bandwidth and admission measurements once', async () => {
        const f = fixture(4), metrics = new api.PdfPerformance();
        let release!: (value: any) => void, asked: any;
        const source = await open(f, { metrics, readImage: (value: any) => {
            asked = value; return new Promise(resolve => { release = resolve; });
        } });
        const before = metrics.snapshot();
        try {
            const pending = source.externalImageSource.read({ id: 'x2', chunkIndex: 1, chunkCount: 2, signal: new AbortController().signal });
            assert.deepStrictEqual([asked.id, asked.chunkIndex, asked.chunkCount, asked.signal.aborted], ['x2', 1, 2, false]);
            assert.strictEqual(metrics.pendingFetchCount, 1);
            assert.strictEqual(f.calls.length, 2, 'image bytes use the registered host channel, not webview fetch');
            release(new browser.Response(f.progressive.slice(4), { status: 206,
                headers: { 'Content-Range': 'bytes 4-11/12', 'Content-Length': '8' } }));
            assert.deepStrictEqual(await pending, f.progressive.slice(4));
            const after = metrics.snapshot();
            assert.strictEqual(after.fetchBytes - before.fetchBytes, 8);
            assert.strictEqual(after.fetchCount - before.fetchCount, 1);
            assert.strictEqual(after.reading.imageBytes, 8);
            assert.strictEqual(after.reading.imageTransfers, 1);
            assert.ok(after.fetchLastDurationMs > 0);
            assert.ok(after.fetchMiBPerSecond > 0);
            assert.strictEqual(after.pendingFetchCount, 0);
            const wrong = source.externalImageSource.read({ id: 'x2', chunkIndex: 0, signal: new AbortController().signal });
            const rejected = assert.rejects(wrong, /different byte range/);
            release(new browser.Response(f.progressive, { status: 200 }));
            await rejected;
            assert.strictEqual(metrics.snapshot().reading.failedTransfers, 1);
            assert.strictEqual(metrics.pendingFetchCount, 0);
        } finally { source.dispose(); }
    });

    it('batches a verified scan tail into one exact transfer with one bandwidth measurement', async () => {
        const f = fixture(4), metrics = new api.PdfPerformance(), source = await open(f, { metrics });
        const signal = new AbortController().signal;
        try {
            await source.externalImageSource.read({ id: 'x2', chunkIndex: 0, signal });
            const before = metrics.snapshot();
            const tail = await source.externalImageSource.read({ id: 'x2', chunkIndex: 1, chunkCount: 2, signal });
            assert.deepStrictEqual(tail, f.progressive.slice(4));
            assert.deepStrictEqual(f.calls.slice(2).map(call => call.headers.Range), ['bytes=0-3', 'bytes=4-11']);
            const after = metrics.snapshot();
            assert.strictEqual(after.fetchBytes - before.fetchBytes, 8);
            assert.strictEqual(after.fetchCount - before.fetchCount, 1);
            assert.strictEqual(after.reading.imageTransfers - before.reading.imageTransfers, 1);
            assert.strictEqual(after.pendingFetchCount, 0);
            const transfer = after.events.filter((event: any) => event.type === 'reading-transfer').at(-1).data;
            assert.deepStrictEqual([transfer.chunk, transfer.chunkCount, transfer.scan, transfer.lastScan], [1, 2, 2, 3]);
        } finally { source.dispose(); }
    });

    it('rejects invalid batch counts and raw-image batching before transport admission', async () => {
        const f = fixture(4), source = await open(f), signal = new AbortController().signal;
        try {
            for (const value of [
                { id: 'x2', chunkIndex: 1, chunkCount: 0 }, { id: 'x2', chunkIndex: 1, chunkCount: -1 },
                { id: 'x2', chunkIndex: 1, chunkCount: 1.5 }, { id: 'x2', chunkIndex: 1, chunkCount: '2' },
                { id: 'x2', chunkIndex: 1, chunkCount: null }, { id: 'x2', chunkIndex: 2, chunkCount: 2 },
                { id: 'x2', chunkIndex: 0, chunkCount: Number.MAX_SAFE_INTEGER },
                { id: 'x1', chunkIndex: 0, chunkCount: 2 },
            ]) { await assert.rejects(source.externalImageSource.read({ ...value, signal }), /Unknown/); }
            assert.strictEqual(f.calls.length, 2);
            assert.strictEqual(f.metrics.active, 0);
        } finally { source.dispose(); }
    });

    it('verifies every constituent scan in a combined tail before exposing any bytes', async () => {
        const f = fixture(4), source = await open(f), signal = new AbortController().signal;
        try {
            const damaged = f.progressive.slice(); damaged[9] ^= 1;
            f.resources.set('reading/x2.jpg', damaged);
            await assert.rejects(source.externalImageSource.read({ id: 'x2', chunkIndex: 1, chunkCount: 2, signal }), /digest/);
            assert.strictEqual(f.calls.at(-1)?.headers.Range, 'bytes=4-11');
            assert.strictEqual(f.metrics.bytes, Buffer.byteLength(JSON.stringify(f.manifest)) + f.pdf.length + 8);
            assert.strictEqual(f.metrics.events.filter(event => event.type === 'reading-transfer' && event.data.kind === 'image').length, 0);
            assert.strictEqual(f.metrics.active, 0);
        } finally { source.dispose(); }
    });

    it('rejects unknown IDs and chunks before an HTTP request', async () => {
        const f = fixture(), source = await open(f), signal = new AbortController().signal;
        try {
            for (const value of [{ id: 'x3', chunkIndex: 0 }, { id: 'x1', chunkIndex: 1 }, { id: 'x2', chunkIndex: 2 }]) {
                await assert.rejects(source.externalImageSource.read({ ...value, signal }), /Unknown/);
            }
            assert.strictEqual(f.calls.length, 2);
        } finally { source.dispose(); }
    });

    it('rejects manifest and derived PDF corruption before exposing a native source', async () => {
        for (const resource of ['reading.json', 'reading/document.pdf']) {
            const f = fixture(), damaged = f.resources.get(resource)!.slice();
            damaged[damaged.length - 1] ^= 1; f.resources.set(resource, damaged);
            await assert.rejects(open(f), /digest/);
            assert.strictEqual(f.calls.length, resource === 'reading.json' ? 1 : 2);
            assert.strictEqual(f.metrics.active, 0);
        }
    });

    it('cancels an ignored Range response before reading its full image body', async () => {
        const f = fixture(); let bodyReads = 0, cancelled = 0;
        const source = await open(f, { fetch: async (url: string, options: any) => {
            if (!url.endsWith('x2.jpg')) { return f.request(url, options); }
            return { status: 200, headers: new browser.Headers(), body: {
                getReader() { bodyReads++; throw new Error('must not read'); }, async cancel() { cancelled++; },
            } };
        } });
        try {
            await assert.rejects(source.externalImageSource.read({ id: 'x2', chunkIndex: 0, signal: new AbortController().signal }), /byte range/);
            assert.strictEqual(bodyReads, 0); assert.strictEqual(cancelled, 1); assert.strictEqual(f.metrics.active, 0);
        } finally { source.dispose(); }
    });

    it('checks exact range length and digest before returning a progressive chunk', async () => {
        for (const mode of ['offset', 'short', 'digest']) {
            const f = fixture();
            const source = await open(f, { fetch: async (url: string, options: any) => {
                if (!url.endsWith('x2.jpg')) { return f.request(url, options); }
                const bytes = f.progressive.slice(0, mode === 'short' ? 5 : 6);
                if (mode === 'digest') { bytes[2] ^= 1; }
                return new browser.Response(bytes, { status: 206,
                    headers: { 'Content-Range': mode === 'offset' ? 'bytes 1-6/12' : 'bytes 0-5/12' } });
            } });
            try {
                await assert.rejects(source.externalImageSource.read({ id: 'x2', chunkIndex: 0, signal: new AbortController().signal }), /range|length|digest/);
                assert.strictEqual(f.metrics.active, 0);
            } finally { source.dispose(); }
        }
    });

    it('keeps an aborted batch transfer slot until its response settles and never starts its cancelled successor', async () => {
        const f = fixture(4); let release!: (value: any) => void, imageCalls = 0, firstSignal: AbortSignal | undefined;
        const source = await open(f, { concurrency: 1, fetch: async (url: string, options: any) => {
            if (!url.includes('/reading/x')) { return f.request(url, options); }
            imageCalls++; firstSignal = options.signal;
            return new Promise(resolve => { release = resolve; });
        } });
        const first = new AbortController(), second = new AbortController();
        const p1 = source.externalImageSource.read({ id: 'x2', chunkIndex: 1, chunkCount: 2, signal: first.signal });
        const p2 = source.externalImageSource.read({ id: 'x2', chunkIndex: 0, signal: second.signal });
        const rejected1 = assert.rejects(p1, { name: 'AbortError' }), rejected2 = assert.rejects(p2, { name: 'AbortError' });
        first.abort(); second.abort();
        assert.strictEqual(firstSignal?.aborted, true); assert.strictEqual(imageCalls, 1);
        release(new browser.Response(f.progressive.slice(4), { status: 206,
            headers: { 'Content-Range': 'bytes 4-11/12', 'Content-Length': '8' } }));
        await Promise.all([rejected1, rejected2]);
        assert.strictEqual(imageCalls, 1); assert.strictEqual(f.metrics.active, 0);
        source.dispose();
    });

    it('releases queued work on document disposal and rejects late bytes without publication', async () => {
        const f = fixture(); let release!: (value: any) => void;
        const source = await open(f, { concurrency: 1, fetch: async (url: string, options: any) => {
            if (!url.includes('/reading/x')) { return f.request(url, options); }
            return new Promise(resolve => { release = resolve; });
        } });
        const signal = new AbortController().signal;
        const p1 = source.externalImageSource.read({ id: 'x1', chunkIndex: 0, signal });
        const p2 = source.externalImageSource.read({ id: 'x2', chunkIndex: 0, signal });
        const assertions = [assert.rejects(p1, { name: 'AbortError' }), assert.rejects(p2, { name: 'AbortError' })];
        source.dispose(); source.dispose();
        release(new browser.Response(f.raw));
        await Promise.all(assertions);
        await assert.rejects(source.externalImageSource.read({ id: 'x1', chunkIndex: 0, signal }), { name: 'AbortError' });
        assert.strictEqual(f.metrics.active, 0);
        assert.strictEqual(f.metrics.events.filter(event => event.type === 'reading-transfer' && event.data.kind === 'image').length, 0);
    });
});
