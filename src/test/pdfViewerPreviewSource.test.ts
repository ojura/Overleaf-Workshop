import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(test: () => boolean) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) { if (test()) { return; } await new Promise<void>(resolve => setTimeout(resolve, 1)); }
    assert.ok(test(), 'bounded asynchronous work reached its expected state');
}
class Deferred<T> {
    readonly promise: Promise<T>;
    resolve!: (value: T) => void;
    reject!: (reason: unknown) => void;
    constructor() { this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
}
class Canvas {
    width = 0;
    height = 0;
    removed = 0;
    rotations: number[] = [];
    translations: number[][] = [];
    draws = 0;
    remove() { this.removed++; }
    getContext() {
        return { translate: (x: number, y: number) => this.translations.push([x, y]),
            rotate: (angle: number) => this.rotations.push(angle), drawImage: () => this.draws++ };
    }
}
function jpeg(width: number, height: number) {
    // A bounded SOF header is sufficient for the injected decoder. The production path
    // independently invokes the browser decoder and verifies its resulting dimensions.
    const bytes = Uint8Array.from([255, 216, 255, 192, 0, 17, 8, height >>> 8, height & 255,
        width >>> 8, width & 255, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]);
    return bytes;
}
function raster(mime: string, width: number, height: number) {
    if (mime === 'image/jpeg') { return jpeg(width, height); }
    const bytes = new Uint8Array(mime === 'image/png' ? 33 : 30);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, value: string) => [...value].forEach((char, i) => { bytes[offset + i] = char.charCodeAt(0); });
    if (mime === 'image/png') {
        bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); ascii(12, 'IHDR');
        view.setUint32(16, width); view.setUint32(20, height);
    } else {
        ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WEBP'); ascii(12, 'VP8X'); view.setUint32(16, 10, true);
        for (let i = 0; i < 3; i++) { bytes[24 + i] = (width - 1) >>> (8 * i); bytes[27 + i] = (height - 1) >>> (8 * i); }
    }
    return bytes;
}
const digest = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = { key: 'sha256:' + 'a'.repeat(64), size: 1_608_644_855, sha256: 'a'.repeat(64) };
function manifest(ids = [1, 2], levels = [100, 400], mime = 'image/jpeg') {
    const data = new Map<string, Uint8Array>();
    const value: any = { version: 1, document: { ...identity, pageCount: 100 }, pages: ids.map(pageNumber => ({
        pageNumber, width: 800, height: 1000, rotation: 0,
        assets: levels.map(height => {
            const width = Math.round(height * 0.8);
            const bytes = raster(mime, width, height), assetPath = pageNumber + '/' + height + '.image';
            data.set(assetPath, bytes);
            return { path: assetPath, width, height, bytes: bytes.length, sha256: digest(bytes), mime };
        }),
        imageRegions: [{ id: 'photo-' + pageNumber, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
    })) };
    return { value, data };
}

describe('exact-document page preview sources', function () {
    this.timeout(30_000);
    let module: any, directory: string;
    const loaders: any[] = [];
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-preview-source-'));
        const output = path.join(directory, 'source.mjs');
        try {
            await esbuild.build({ bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
                entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/pdf-preview-source.ts')], outfile: output });
        } finally { await esbuild.stop(); }
        module = await importModule(output);
    });
    afterEach(() => { for (const loader of loaders.splice(0)) { loader.dispose(); } });
    after(() => { fs.rmSync(directory, { recursive: true, force: true }); });

    function setup(spec = manifest(), overrides: Record<string, any> = {}) {
        const calls: Array<{ asset: any; signal: AbortSignal; result: Deferred<Uint8Array> }> = [];
        const changes = new Set<() => void>(), canvases: Canvas[] = [], decoded: Array<{ closed: number }> = [];
        const paints: Array<{ page: any; canvas: Canvas; projection: any }> = [], qualities = new Map<number, number>();
        let manifestCalls = 0, notifications = 0;
        const source = { identity, loadManifest: async () => { manifestCalls++; return spec.value; },
            loadAsset: (asset: any, signal: AbortSignal) => {
                const call = { asset, signal, result: new Deferred<Uint8Array>() }; calls.push(call); return call.result.promise;
            },
            onChange: (listener: () => void) => { changes.add(listener); return () => changes.delete(listener); },
            ...overrides.source };
        const options = { pageCount: 100, decodeConcurrency: 1, maxDecodePixels: 1_000_000,
            createCanvas: () => { const canvas = new Canvas(); canvases.push(canvas); return canvas; },
            quality: (id: number) => qualities.get(id) ?? 0,
            onPreview: (page: any, canvas: Canvas, projection: any) => { paints.push({ page, canvas, projection }); qualities.set(page.pageNumber, Math.max(canvas.width, canvas.height)); return true; },
            onChange: () => { notifications++; },
            decode: async (_bytes: Uint8Array, asset: any) => {
                const item = { closed: 0 }; decoded.push(item);
                return { width: asset.width, height: asset.height, image: {}, close() { item.closed++; } };
            }, ...overrides.options };
        const loader = module.createPdfPreviewSourceLoader(source, options); loaders.push(loader);
        const plan = (ids: number[], dimension = 400, rotation = 0, visible = true) =>
            ids.map(pageNumber => ({ pageNumber, visible, maxDimension: dimension, rotation }));
        return { loader, source, options, calls, changes, canvases, decoded, paints, qualities, plan,
            get manifestCalls() { return manifestCalls; }, get notifications() { return notifications; },
            resolve(index: number, bytes?: Uint8Array) { const call = calls[index]; call.result.resolve(bytes ?? spec.data.get(call.asset.path)!); },
            announce() { for (const listener of changes) { listener(); } } };
    }

    it('binds exact identity, byte length, digest and physical page count', () => {
        const { value } = manifest();
        const valid = module.validatePdfPreviewManifest(value, identity, 100);
        assert.strictEqual(valid.document.key, identity.key);
        assert.ok(Object.isFrozen(valid.pages[0].assets));
        for (const bad of [
            { ...value, document: { ...value.document, key: 'other-build' } },
            { ...value, document: { ...value.document, size: identity.size - 1 } },
            { ...value, document: { ...value.document, sha256: 'b'.repeat(64) } },
            { ...value, document: { ...value.document, pageCount: 99 } },
            { ...value, pages: [value.pages[0], value.pages[0]] },
        ]) { assert.throws(() => module.validatePdfPreviewManifest(bad, identity, 100)); }
    });

    it('rejects unbounded or escaping assets but discards malformed optional placements', () => {
        const { value } = manifest([1]);
        for (const change of [{ path: '../escape.jpg' }, { path: 'https://elsewhere/image.jpg' },
            { width: 100_000 }, { bytes: module.PDF_PREVIEW_LIMITS.assetBytes + 1 }, { sha256: 'bad' }, { height: 42 }]) {
            const bad = structuredClone(value); Object.assign(bad.pages[0].assets[0], change);
            assert.throws(() => module.validatePdfPreviewManifest(bad, identity, 100));
        }
        value.pages[0].imageRegions.push({ id: 'outside', x: -1, y: 0, width: 1, height: 1 },
            { id: 'nan', x: NaN, y: 0, width: 1, height: 1 }, value.pages[0].imageRegions[0]);
        const valid = module.validatePdfPreviewManifest(value, identity, 100);
        assert.strictEqual(valid.pages[0].assets.length, 2);
        assert.deepStrictEqual(valid.pages[0].imageRegions.map((region: any) => region.id), ['photo-1']);
        assert.strictEqual(module.PDF_PREVIEW_LIMITS.manifestBytes, 4 * 1024 * 1024);
    });

    it('rotates normalized placements into the current rendered page orientation', () => {
        const input = [{ id: 'photo', x: 0.125, y: 0.25, width: 0.5, height: 0.25 }];
        assert.deepStrictEqual(module.rotatePdfPreviewImageRegions(input, 90), [{ id: 'photo', x: 0.5, y: 0.125, width: 0.25, height: 0.5 }]);
        assert.deepStrictEqual(module.rotatePdfPreviewImageRegions(input, 180), [{ id: 'photo', x: 0.375, y: 0.5, width: 0.5, height: 0.25 }]);
        assert.deepStrictEqual(module.rotatePdfPreviewImageRegions(input, -90), [{ id: 'photo', x: 0.25, y: 0.375, width: 0.25, height: 0.5 }]);
        assert.deepStrictEqual(module.rotatePdfPreviewImageRegions(input, 45), []);
    });

    it('covers both visible halves before refinement and paints the faster half immediately', async () => {
        const f = setup();
        f.loader.update(f.plan([1, 2]));
        await until(() => f.calls.length === 2);
        assert.deepStrictEqual(f.calls.map(call => call.asset.path), ['1/100.image', '2/100.image']);
        f.resolve(0); await until(() => f.paints.length === 1);
        assert.strictEqual(f.paints[0].page.pageNumber, 1);
        assert.strictEqual(f.calls.length, 2, 'the ready half cannot consume the other half\'s coverage slot');
        f.resolve(1); await until(() => f.calls.length === 4);
        assert.deepStrictEqual(f.calls.slice(2).map(call => call.asset.path), ['1/400.image', '2/400.image']);
        f.resolve(2); f.resolve(3); await until(() => f.loader.snapshot().pending === 0);
        assert.strictEqual(f.loader.snapshot().completed, 4);
        assert.deepStrictEqual(f.decoded.map(item => item.closed), [1, 1, 1, 1]);
        const total = f.calls.length;
        for (let i = 0; i < 10; i++) { f.loader.update(f.plan([1, 2])); await turn(); }
        assert.strictEqual(f.calls.length, total, 'settled plans do not fetch or decode again');
    });

    it('retains canceled transfer slots until they settle and prioritizes the replacement viewport', async () => {
        const f = setup(manifest([1, 2, 3, 4], [100]));
        f.loader.update(f.plan([1, 2])); await until(() => f.calls.length === 2);
        f.loader.update(f.plan([3, 4]));
        assert.ok(f.calls.every(call => call.signal.aborted));
        assert.strictEqual(f.calls.length, 2);
        f.resolve(0); await until(() => f.calls.length === 3);
        assert.strictEqual(f.calls[2].asset.path, '3/100.image');
        f.resolve(1); await until(() => f.calls.length === 4);
        f.resolve(2); f.resolve(3); await until(() => f.loader.snapshot().pending === 0);
        assert.deepStrictEqual(f.paints.map(item => item.page.pageNumber).sort(), [3, 4]);
        assert.strictEqual(f.decoded.length, 2, 'obsolete bytes never enter decoding');
    });

    it('serializes phone decoding while two fetches occupy the bounded pipeline', async () => {
        const pending: Array<{ asset: any; result: Deferred<any> }> = [];
        const f = setup(manifest([1, 2], [100]), { options: {
            decode: (_bytes: Uint8Array, asset: any) => {
                const job = { asset, result: new Deferred<any>() }; pending.push(job); return job.result.promise;
            },
        } });
        f.loader.update(f.plan([1, 2])); await until(() => f.calls.length === 2);
        f.resolve(0); f.resolve(1); await until(() => f.loader.snapshot().queuedDecodes === 1);
        assert.strictEqual(pending.length, 1);
        assert.strictEqual(f.loader.snapshot().decoding, 1);
        pending[0].result.resolve({ ...pending[0].asset, image: {}, close() {} });
        await until(() => pending.length === 2);
        pending[1].result.resolve({ ...pending[1].asset, image: {}, close() {} });
        await until(() => f.loader.snapshot().pending === 0);
        assert.strictEqual(f.paints.length, 2);
    });

    it('uses only explicit availability events after a missing manifest and unsubscribes on disposal', async () => {
        let available = false, reads = 0;
        const spec = manifest([1], [100]);
        const f = setup(spec, { source: { loadManifest: async () => { reads++; return available ? spec.value : null; } } });
        f.loader.update(f.plan([1]));
        assert.strictEqual(f.notifications, 1, 'starting a manifest read immediately revokes idle admission');
        await until(() => f.loader.snapshot().state === 'missing');
        for (let i = 0; i < 20; i++) { f.loader.update(f.plan([1])); await turn(); }
        assert.strictEqual(reads, 1);
        available = true; f.announce(); await until(() => f.calls.length === 1);
        f.resolve(0); await until(() => f.paints.length === 1);
        f.loader.dispose(); assert.strictEqual(f.changes.size, 0);
        f.announce(); assert.strictEqual(reads, 2);
    });

    it('does not decode corrupt bytes, oversized encoded dimensions or mismatched actual bitmap dimensions', async () => {
        for (const defect of ['length', 'hash', 'encoded', 'decoded']) {
            const spec = manifest([1], [100]);
            if (defect === 'encoded') {
                const asset = spec.value.pages[0].assets[0], bytes = jpeg(8000, 10000);
                asset.bytes = bytes.length; asset.sha256 = digest(bytes); spec.data.set(asset.path, bytes);
            }
            let closed = 0, decodes = 0;
            const f = setup(spec, { options: { decode: async (_bytes: Uint8Array, asset: any) => {
                decodes++; return { width: asset.width + (defect === 'decoded' ? 1 : 0), height: asset.height, image: {}, close() { closed++; } };
            } } });
            f.loader.update(f.plan([1])); await until(() => f.calls.length === 1);
            const actual = spec.data.get(f.calls[0].asset.path)!;
            f.resolve(0, defect === 'length' ? actual.slice(1) : defect === 'hash' ? new Uint8Array(actual.length) : actual);
            await until(() => f.loader.snapshot().pending === 0);
            assert.strictEqual(f.paints.length, 0, defect);
            assert.strictEqual(f.loader.snapshot().rejected, 1, defect);
            assert.strictEqual(decodes, defect === 'decoded' ? 1 : 0, defect);
            assert.strictEqual(closed, defect === 'decoded' ? 1 : 0, defect);
            f.loader.update(f.plan([1])); await turn();
            assert.strictEqual(f.calls.length, 1, 'failed assets are not retried at idle');
        }
    });

    for (const mime of ['image/png', 'image/webp']) {
        it('validates encoded ' + mime + ' dimensions before publishing rotated bounded pixels', async () => {
            const f = setup(manifest([1], [400], mime));
            f.loader.update(f.plan([1], 200, 90)); await until(() => f.calls.length === 1);
            f.resolve(0); await until(() => f.paints.length === 1);
            const canvas = f.paints[0].canvas;
            assert.deepStrictEqual([canvas.width, canvas.height], [200, 160]);
            assert.deepStrictEqual(canvas.translations, [[200, 0]]);
            assert.deepStrictEqual(canvas.rotations, [Math.PI / 2]);
            assert.strictEqual(canvas.draws, 1);
        });
    }

    it('publishes complete logical-page projection after every physical preview quarter-turn', async () => {
        for (const angle of [0, 90, 180, 270]) {
            const f = setup(manifest([1], [100]));
            f.loader.update(f.plan([1], 83, angle)); await until(() => f.calls.length === 1);
            f.resolve(0); await until(() => f.paints.length === 1);
            const { canvas, projection } = f.paints[0];
            const width = angle % 180 ? 83 : 66, height = angle % 180 ? 66 : 83;
            assert.deepStrictEqual([canvas.width, canvas.height], [width, height]);
            assert.deepStrictEqual(projection, { width, height, pageToRaster: [width, 0, 0, height, 0, 0] });
            assert.strictEqual(f.decoded[0].closed, 1, 'projection metadata does not retain the decoded bitmap');
        }
    });

    it('closes late decode results on hide and on disposal without publishing or allocating canvases', async () => {
        for (const operation of ['hide', 'dispose']) {
            const result = new Deferred<any>(); let closed = 0, started = false;
            const f = setup(manifest([1], [100]), { options: { decode: () => { started = true; return result.promise; } } });
            f.loader.update(f.plan([1])); await until(() => f.calls.length === 1);
            f.resolve(0); await until(() => started);
            if (operation === 'hide') { f.loader.update([], false); } else { f.loader.dispose(); }
            result.resolve({ width: 80, height: 100, image: {}, close() { closed++; } });
            await until(() => f.loader.snapshot().pending === 0);
            assert.strictEqual(closed, 1); assert.strictEqual(f.paints.length, 0); assert.strictEqual(f.canvases.length, 0);
        }
    });

    it('memoizes rejected cache admission without blocking another visible page\'s refinement', async () => {
        const f = setup();
        const retain = f.options.onPreview;
        f.options.onPreview = (page: any, canvas: Canvas, projection: any) => {
            if (page.pageNumber === 1) { canvas.width = canvas.height = 0; return false; }
            return retain(page, canvas, projection);
        };
        f.loader.update(f.plan([1, 2])); await until(() => f.calls.length === 2);
        f.resolve(0); f.resolve(1); await until(() => f.calls.length === 3);
        assert.strictEqual(f.calls[2].asset.path, '2/400.image');
        f.resolve(2); await until(() => f.loader.snapshot().pending === 0);
        for (let i = 0; i < 10; i++) { f.loader.update(f.plan([1, 2])); await turn(); }
        assert.strictEqual(f.calls.length, 3);
        assert.strictEqual(f.loader.snapshot().completed, 2);
    });

    it('releases a temporary canvas and bitmap when drawing or admission fails', async () => {
        for (const defect of ['context', 'draw', 'admission']) {
            const canvas = new Canvas();
            if (defect === 'context') { canvas.getContext = () => null as any; }
            if (defect === 'draw') { canvas.getContext = () => ({ drawImage() { throw new Error('allocation failed'); } } as any); }
            const f = setup(manifest([1], [100]), { options: { createCanvas: () => canvas,
                ...(defect === 'admission' ? { onPreview() { throw new Error('cache failed'); } } : {}) } });
            f.loader.update(f.plan([1])); await until(() => f.calls.length === 1);
            f.resolve(0); await until(() => f.loader.snapshot().pending === 0);
            assert.strictEqual(canvas.width * canvas.height, 0, defect);
            assert.strictEqual(canvas.removed, 1, defect);
            assert.strictEqual(f.decoded[0].closed, 1, defect);
        }
    });

    it('ignores assets above the decode budget and skips finished native canvases', async () => {
        const f = setup(manifest([1, 2], [100, 400]), { options: { maxDecodePixels: 10_000 } });
        f.qualities.set(1, Infinity);
        f.loader.update(f.plan([1, 2])); await until(() => f.calls.length === 1);
        assert.strictEqual(f.calls[0].asset.path, '2/100.image');
        f.resolve(0); await until(() => f.loader.snapshot().pending === 0);
        assert.strictEqual(f.calls.length, 1);
        assert.strictEqual(f.paints[0].canvas.height, 100);
    });

    it('enforces the mobile decode edge ceiling even when a 4096 tier fits the pixel-area budget', async () => {
        const spec = manifest([1], [100]);
        const page = spec.value.pages[0], asset = page.assets[0], bytes = jpeg(4096, 128);
        page.width = 32000; page.height = 1000;
        Object.assign(asset, { width: 4096, height: 128, bytes: bytes.length, sha256: digest(bytes) });
        spec.data.set(asset.path, bytes);
        const f = setup(spec, { options: { maxDecodeDimension: 512, maxDecodePixels: 1_048_576 } });
        f.loader.update(f.plan([1], 512)); await until(() => f.loader.snapshot().state === 'ready');
        assert.strictEqual(f.calls.length, 0, 'a long narrow oversized tier must not be fetched just because its area fits');
        assert.strictEqual(f.decoded.length, 0);
        assert.strictEqual(f.loader.snapshot().pending, 0);
    });

    it('uses the 192 then 512 mobile path and leaves the 4096 tier untouched', async () => {
        const f = setup(manifest([1, 2], [192, 512, 4096]), { options: { maxDecodeDimension: 512, maxDecodePixels: 1_048_576 } });
        f.loader.update(f.plan([1, 2], 512)); await until(() => f.calls.length === 2);
        assert.deepStrictEqual(f.calls.map(call => call.asset.path), ['1/192.image', '2/192.image']);
        f.resolve(0); f.resolve(1); await until(() => f.calls.length === 4);
        assert.deepStrictEqual(f.calls.slice(2).map(call => call.asset.path), ['1/512.image', '2/512.image']);
        f.resolve(2); f.resolve(3); await until(() => f.loader.snapshot().pending === 0);
        assert.ok(f.calls.every(call => Math.max(call.asset.width, call.asset.height) <= 512));
        assert.ok(f.paints.every(paint => Math.max(paint.canvas.width, paint.canvas.height) <= 512));
    });
});
