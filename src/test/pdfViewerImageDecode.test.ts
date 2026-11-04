/* eslint-disable @typescript-eslint/naming-convention -- pinned PDF.js class and operator names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
// A generated, solid-color 128x96 JPEG; no book content is stored in the test fixture.
const jpeg = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCABgAIADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooor6s+aCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//9k=', 'base64'));

describe('PDF.js adaptive image decoding', function () {
    this.timeout(30_000);
    let directory: string;
    let worker: any;
    let pdfjs: any;
    const saved = new Map<string, PropertyDescriptor | undefined>();
    let bitmapDescriptor: PropertyDescriptor | undefined;

    before(async () => {
        const { pdfjsRelease } = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-adaptive-images-'));
        fs.writeFileSync(path.join(directory, 'pdf.worker.mjs'), fs.readFileSync(path.join(pdfjsRelease, 'build/pdf.worker.mjs'), 'utf8')
            + '\nexport { PDFImage, JpegStream, Stream, Dict, Name, GlobalColorSpaceCache, LocalColorSpaceCache };\nexport const TestImageDecodeQueue = typeof ImageDecodeQueue === "undefined" ? undefined : ImageDecodeQueue;\nexport const testImageDecodeSize = typeof imageDecodeSize === "undefined" ? undefined : imageDecodeSize;\n');
        fs.writeFileSync(path.join(directory, 'pdf.mjs'), fs.readFileSync(path.join(pdfjsRelease, 'build/pdf.mjs'), 'utf8') + '\nexport { PDFPageProxy as TestPageProxy };\n');
        for (const name of ['DOMMatrix', 'pdfjsLib', 'pdfjsWorker']) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); }
        if (!(globalThis as any).DOMMatrix) { Object.defineProperty(globalThis, 'DOMMatrix', { value: class {}, writable: true, configurable: true }); }
        worker = await importModule(pathToFileURL(path.join(directory, 'pdf.worker.mjs')).href);
        pdfjs = await importModule(pathToFileURL(path.join(directory, 'pdf.mjs')).href);
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(directory, 'pdf.worker.mjs')).href;
    });
    beforeEach(() => { bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap'); });
    afterEach(() => {
        if (bitmapDescriptor) { Object.defineProperty(globalThis, 'createImageBitmap', bitmapDescriptor); }
        else { delete (globalThis as any).createImageBitmap; }
    });
    after(() => {
        for (const [name, descriptor] of saved) {
            if (descriptor) { Object.defineProperty(globalThis, name, descriptor); }
            else { delete (globalThis as any)[name]; }
        }
        if (directory) { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    function image(options: { decode?: number[], colorTransform?: number, bytes?: Uint8Array } = {}) {
        const encoded = options.bytes ?? jpeg;
        const stream = new worker.Stream(encoded.slice());
        stream.dict = new worker.Dict();
        stream.dict.set('Width', 128);
        stream.dict.set('Height', 96);
        stream.dict.set('BitsPerComponent', 8);
        stream.dict.set('ColorSpace', worker.Name.get('DeviceRGB'));
        stream.dict.set('Filter', worker.Name.get('DCTDecode'));
        if (options.decode) { stream.dict.set('Decode', options.decode); }
        const parameters = new worker.Dict();
        if (options.colorTransform !== undefined) { parameters.set('ColorTransform', options.colorTransform); }
        const source = new worker.JpegStream(stream, encoded.length, parameters);
        return new worker.PDFImage({
            image: source, xref: { fetchIfRef: (value: any) => value }, res: worker.Dict.empty,
            globalColorSpaceCache: new worker.GlobalColorSpaceCache(), localColorSpaceCache: new worker.LocalColorSpaceCache(),
        });
    }
    const resolution = (width: number, height: number) => ({ scale: 1, maxDimension: 1024, transform: [width, 0, 0, height, 0, 0] });
    function setBitmap(factory: (...args: any[]) => any) { Object.defineProperty(globalThis, 'createImageBitmap', { value: factory, writable: true, configurable: true }); }

    it('decodes a JPEG directly to its displayed pixel size with explicit color and orientation semantics', async () => {
        const calls: any[] = [];
        setBitmap(async (blob: Blob, options: any) => {
            calls.push({ blob, options });
            return { width: options.resizeWidth, height: options.resizeHeight, close() {} };
        });
        const result = await image().createImageData(false, false, resolution(32, 24));
        assert.strictEqual(result.width, 32);
        assert.strictEqual(result.height, 24);
        assert.strictEqual(result.data, null);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].blob.type, 'image/jpeg');
        assert.deepStrictEqual(calls[0].options, {
            resizeWidth: 32, resizeHeight: 24, resizeQuality: 'high', imageOrientation: 'none',
            colorSpaceConversion: 'none', premultiplyAlpha: 'premultiply',
        });
    });

    it('falls back to fresh scaled JPEG output and increases detail on the same source stream', async () => {
        setBitmap(async () => { throw new Error('native JPEG decoder unavailable'); });
        const source = image();
        const low = await source.createImageData(false, false, resolution(32, 24));
        assert.deepStrictEqual([low.width, low.height, low.data.length], [32, 24, 32 * 24 * 4]);
        const high = await source.createImageData(false, false, resolution(128, 96));
        assert.deepStrictEqual([high.width, high.height, high.data.length], [128, 96, 128 * 96 * 4]);
        assert.notStrictEqual(low.data.buffer, high.data.buffer);
        assert.ok(Math.abs(high.data[0] - 80) <= 3 && Math.abs(high.data[1] - 120) <= 3 && Math.abs(high.data[2] - 160) <= 3);
        assert.strictEqual(high.data[3], 255);
    });

    it('closes a native bitmap that ignored its requested dimensions before using the scaled fallback', async () => {
        let closed = 0;
        setBitmap(async () => ({ width: 128, height: 96, close() { closed++; } }));
        const result = await image().createImageData(false, false, resolution(32, 24));
        assert.strictEqual(closed, 1);
        assert.deepStrictEqual([result.width, result.height, result.data.length], [32, 24, 3072]);
    });

    it('preserves JPEG decode/color transforms and strips EXIF before native decoding', async () => {
        let calls = 0;
        let nativeBytes: Uint8Array | undefined;
        setBitmap(async (blob: Blob, options: any) => {
            calls++;
            nativeBytes = new Uint8Array(await blob.arrayBuffer());
            return { width: options.resizeWidth, height: options.resizeHeight, close() {} };
        });
        const transformed = await image({ colorTransform: 0 }).createImageData(false, false, resolution(32, 24));
        assert.strictEqual(calls, 0, 'PDF ColorTransform=0 stays on PDF.js color handling');
        assert.strictEqual(transformed.width, 32);
        const decoded = await image({ decode: [1, 0, 1, 0, 1, 0] }).createImageData(false, false, resolution(32, 24));
        assert.strictEqual(calls, 0, 'a PDF Decode array is not bypassed by browser JPEG decoding');
        assert.strictEqual(decoded.width, 128, 'unsupported image semantics keep the existing full-quality path');
        const exif = new Uint8Array([255, 225, 0, 18, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 0, 0]);
        const encoded = new Uint8Array(jpeg.length + exif.length);
        encoded.set(jpeg.subarray(0, 2)); encoded.set(exif, 2); encoded.set(jpeg.subarray(2), 2 + exif.length);
        await image({ bytes: encoded }).createImageData(false, false, resolution(32, 24));
        assert.strictEqual(calls, 1);
        assert.ok(nativeBytes!.subarray(12, 22).every(value => value === 0), 'the EXIF orientation payload is removed');
        assert.strictEqual(encoded[12], 73, 'the original compressed bytes remain intact');
    });

    it('uses rotation and shear magnitudes for placement sizing and preserves detail at deep zoom', () => {
        const size = worker.testImageDecodeSize;
        assert.deepStrictEqual(size(4000, 3000, { scale: 2, maxDimension: 2048, transform: [0, 200, -150, 0, 0, 0] }), { width: 416, height: 312 });
        const shear = size(4000, 3000, { scale: 1, maxDimension: 2048, transform: [200, 0, 200, 150, 0, 0] });
        assert.ok(shear.width >= 333 && shear.height >= 250, 'both transformed image axes receive enough pixels');
        assert.deepStrictEqual(size(4000, 3000, { scale: 0, maxDimension: 1024, transform: null }), { width: 1024, height: 768 });
        assert.deepStrictEqual(size(4000, 3000, { scale: 20, maxDimension: 1024, transform: [300, 0, 0, 225, 0, 0] }), { width: 4000, height: 3000 }, 'the fallback bound cannot cap a known high-resolution placement');
    });

    it('serializes image jobs and releases its slot after rejection', async () => {
        const queue = new worker.TestImageDecodeQueue(1);
        const starts: number[] = [];
        const gates: Array<{ resolve(value: any): void, reject(reason: Error): void }> = [];
        const results = [1, 2, 3].map(id => queue.run(() => {
            starts.push(id);
            return new Promise((resolve, reject) => gates.push({ resolve, reject }));
        }));
        const completed = Promise.allSettled(results);
        await settled();
        assert.deepStrictEqual(starts, [1]);
        assert.strictEqual(queue.stats().imageDecodeQueued, 2);
        gates[0].resolve({});
        await settled();
        assert.deepStrictEqual(starts, [1, 2]);
        gates[1].reject(new Error('image failure'));
        await settled();
        assert.deepStrictEqual(starts, [1, 2, 3]);
        gates[2].resolve({});
        const outcomes = await completed;
        await settled();
        assert.deepStrictEqual(outcomes.map(item => item.status), ['fulfilled', 'rejected', 'fulfilled']);
        assert.strictEqual(queue.stats().imageDecodeActive, 0);
        assert.strictEqual(queue.stats().imageDecodePeakActive, 1);
    });

    it('rejects queued image jobs on termination and closes a late native bitmap', async () => {
        const queue = new worker.TestImageDecodeQueue(1);
        let finish!: (value: any) => void;
        let queuedStarted = false;
        let closed = 0;
        const active = queue.run(() => new Promise(resolve => { finish = resolve; }));
        const queued = queue.run(() => { queuedStarted = true; return {}; });
        const outcomes = Promise.allSettled([active, queued]);
        await settled();
        queue.abort(new Error('document replaced'));
        finish({ bitmap: { close() { closed++; } } });
        assert.ok((await outcomes).every(result => result.status === 'rejected'));
        await settled();
        assert.strictEqual(queuedStarted, false);
        assert.strictEqual(closed, 1);
        assert.strictEqual(queue.stats().imageDecodeActive, 0);
        assert.strictEqual(queue.stats().imageDecodeQueued, 0);
        await assert.rejects(queue.run(() => ({})), /document replaced/);
    });

    it('selects a compatible image intent and requests higher detail for a larger zoom', () => {
        const page = new pdfjs.TestPageProxy(0, { view: [0, 0, 128, 96], rotate: 0, userUnit: 1 }, {
            commonObjs: {}, _params: { adaptiveImageDecoding: true },
            getRenderingIntent: (intent: string) => ({ renderingIntent: intent === 'print' ? 4 : 2, cacheKey: intent === 'print' ? 'print' : 'display' }),
        });
        const intercepted = new Error('stop before canvas rendering');
        let selected = '';
        page._intentStates.get = (key: string) => { selected = key; throw intercepted; };
        const select = (scale: number, intent = 'display') => {
            assert.throws(() => page.render({ viewport: page.getViewport({ scale }), canvasContext: {}, intent, optionalContentConfigPromise: Promise.resolve({}) }), error => error === intercepted);
            return selected;
        };
        const low = select(1);
        assert.ok(low.includes('_image_'));
        page._intentStates.set('prepared detail', { imageDecodeBaseKey: 'display', imageDecodeScale: 2, imageDecodeMaxDimension: 256 });
        assert.strictEqual(select(1), 'prepared detail', 'higher-quality prepared images also satisfy a smaller native canvas');
        assert.notStrictEqual(select(4), 'prepared detail', 'a larger zoom gets a different operator-list/image identity');
        assert.strictEqual(select(1, 'print'), 'print', 'printing keeps original-resolution semantics');
    });

    function pdf(content: string, form = false, pattern = false) {
        const resources = '/XObject << /Image 5 0 R' + (form || pattern ? ' /Form 6 0 R' : '') + ' >>'
            + (pattern ? ' /Pattern << /Pattern 7 0 R >>' : '');
        const objects = [
            '', '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 128 96] /Resources << ' + resources + ' >> /Contents 4 0 R >>',
            '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
            '<< /Type /XObject /Subtype /Image /Width 128 /Height 96 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n' + Buffer.from(jpeg).toString('latin1') + '\nendstream',
        ];
        if (form || pattern) {
            const commands = 'q 16 0 0 12 0 0 cm /Image Do Q';
            objects.push('<< /Type /XObject /Subtype /Form /BBox [0 0 32 24] /Matrix [0 3 -3 0 0 0] /Resources << /XObject << /Image 5 0 R >> >> /Length ' + commands.length + ' >>\nstream\n' + commands + '\nendstream');
        }
        if (pattern) {
            const commands = 'q 1 0 0 1 0 0 cm /Image Do Q';
            objects.push('<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << /XObject << /Image 5 0 R >> >> /Length ' + commands.length + ' >>\nstream\n' + commands + '\nendstream');
        }
        let text = '%PDF-1.7\n';
        const offsets = [0];
        for (let id = 1; id < objects.length; id++) {
            offsets[id] = Buffer.byteLength(text, 'latin1');
            text += id + ' 0 obj\n' + objects[id] + '\nendobj\n';
        }
        const start = Buffer.byteLength(text, 'latin1');
        text += 'xref\n0 ' + objects.length + '\n0000000000 65535 f \n';
        for (let id = 1; id < objects.length; id++) { text += String(offsets[id]).padStart(10, '0') + ' 00000 n \n'; }
        text += 'trailer\n<< /Root 1 0 R /Size ' + objects.length + ' >>\nstartxref\n' + start + '\n%%EOF\n';
        return new Uint8Array(Buffer.from(text, 'latin1'));
    }

    async function operations(page: any, scale: number, bound: number, key: string) {
        let finish!: () => void;
        const ready = new Promise<void>(resolve => { finish = resolve; });
        const state: any = {
            operatorList: { fnArray: [], argsArray: [], lastChunk: false },
            displayReadyCapability: { resolve() {} },
            renderTasks: new Set([{ operatorListChanged() { if (state.operatorList.lastChunk) { finish(); } } }]),
        };
        page._intentStates.set(key, state);
        page._pumpOperatorList({ ...page._transport.getRenderingIntent('display'), cacheKey: key, imageDecodeScale: scale, imageDecodeMaxDimension: bound });
        await ready;
        state.renderTasks.clear();
        const ids = new Set<string>();
        state.operatorList.fnArray.forEach((fn: number, index: number) => {
            if (fn === pdfjs.OPS.dependency) { for (const id of state.operatorList.argsArray[index]) { ids.add(id); } }
        });
        const images = await Promise.all([...ids].map(id => new Promise<any>(resolve => page.objs.get(id, resolve))));
        return { images, state };
    }

    async function document(data: Uint8Array) {
        const task = pdfjs.getDocument({ data, adaptiveImageDecoding: true, imageDecodeConcurrency: 1, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, isEvalSupported: false, useSystemFonts: true });
        return { task, document: await task.promise };
    }

    it('keeps repeated XObjects at distinct placement resolutions and restores detail after cleanup through both proxies', async () => {
        delete (globalThis as any).createImageBitmap;
        const { task, document: doc } = await document(pdf('q 32 0 0 24 0 0 cm /Image Do Q q 96 0 0 72 0 0 cm /Image Do Q'));
        try {
            const page = await doc.getPage(1);
            const first = await operations(page, 1, 128, 'small');
            assert.deepStrictEqual(first.images.map(image => [image.width, image.height]).sort((a, b) => a[0] - b[0]), [[32, 24], [96, 72]]);
            assert.strictEqual(page.cleanup(), true);
            const zoomed = await operations(page, 4, 512, 'large');
            assert.deepStrictEqual(zoomed.images.map(image => [image.width, image.height]), [[128, 96]], 'full-size repeated placements reuse the same adequate variant');
            await settled();
            const stats = await doc.getRangeCacheStats();
            assert.strictEqual(stats.imageDecodeConcurrency, 1);
            assert.strictEqual(stats.imageDecodePeakActive, 1);
            assert.strictEqual(stats.imageDecodeActive, 0);
            assert.strictEqual(stats.imageDecodeQueued, 0);
            assert.strictEqual(stats.imageDecodeCompletedFallback, 3);
            assert.strictEqual(stats.imageDecodeCompletedNative, 0);
            assert.strictEqual(stats.imageDecodeOriginalPixels, 128 * 96 * 3);
            assert.strictEqual(stats.imageDecodeOutputPixels, 32 * 24 + 96 * 72 + 128 * 96);
        } finally { await task.destroy(); }
    });

    it('includes nested Form matrices and uses the page-sized bound for tiling patterns', async () => {
        delete (globalThis as any).createImageBitmap;
        const form = await document(pdf('q 2 0 0 2 0 0 cm /Form Do Q', true));
        try {
            const rendered = await operations(await form.document.getPage(1), 1, 128, 'form');
            assert.deepStrictEqual(rendered.images.map(image => [image.width, image.height]), [[96, 72]], 'outer scale, Form rotation/scale, and local image placement compose');
        } finally { await form.task.destroy(); }
        const pattern = await document(pdf('/Pattern cs /Pattern scn 0 0 128 96 re f', true, true));
        try {
            const rendered = await operations(await pattern.document.getPage(1), 1, 64, 'pattern');
            assert.deepStrictEqual(rendered.images.map(image => [image.width, image.height]), [[64, 48]], 'a reusable tiling pattern uses a conservative page bound');
        } finally { await pattern.task.destroy(); }
    });
});
