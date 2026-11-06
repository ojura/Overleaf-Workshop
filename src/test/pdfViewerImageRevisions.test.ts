/* eslint-disable @typescript-eslint/naming-convention -- exercise pinned PDF.js APIs and PDF dictionaries */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import { deflateSync } from 'zlib';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'src/test/fixtures/progressive-jpeg.json'), 'utf8'));
const progressive = new Uint8Array(Buffer.from(fixture.progressive, 'base64'));
const original = new Uint8Array(Buffer.from(fixture.original, 'base64'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe('native external-image PDF passes', function () {
    this.timeout(15_000);
    let directory: string, pdfjs: any, worker: any, canvas: any;
    const saved = new Map<string, PropertyDescriptor | undefined>();
    before(async () => {
        const { pdfjsRelease } = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-image-revisions-'));
        fs.writeFileSync(path.join(directory, 'pdf.worker.mjs'), fs.readFileSync(path.join(pdfjsRelease, 'build/pdf.worker.mjs'), 'utf8')
            + '\nexport { ExternalImageManager as TestExternalImages };\n');
        fs.writeFileSync(path.join(directory, 'pdf.mjs'), fs.readFileSync(path.join(pdfjsRelease, 'build/pdf.mjs'), 'utf8')
            + '\nexport { PageImageRevisions as TestImageRevisions, PDFObjects as TestObjects };\n');
        canvas = await importModule(path.join(repo, 'node_modules/@napi-rs/canvas/index.js'));
        for (const name of ['DOMMatrix', 'ImageData', 'Path2D', 'pdfjsLib', 'pdfjsWorker']) {
            saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
            if (canvas[name]) { Object.defineProperty(globalThis, name, { value: canvas[name], configurable: true, writable: true }); }
        }
        pdfjs = await importModule(pathToFileURL(path.join(directory, 'pdf.mjs')).href);
        worker = await importModule(pathToFileURL(path.join(directory, 'pdf.worker.mjs')).href);
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(directory, 'pdf.worker.mjs')).href;
    });
    after(() => {
        for (const [name, value] of saved) {
            if (value) { Object.defineProperty(globalThis, name, value); }
            else { delete (globalThis as any)[name]; }
        }
        if (directory) { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    function stream(dict: string, bytes: Uint8Array | string) {
        const data = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('latin1');
        return `<< ${dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;
    }
    function pdfBytes(objects: string[]) {
        let text = '%PDF-1.7\n';
        const offsets = [0];
        for (let id = 1; id < objects.length; id++) {
            offsets[id] = Buffer.byteLength(text, 'latin1');
            text += `${id} 0 obj\n${objects[id]}\nendobj\n`;
        }
        const start = Buffer.byteLength(text, 'latin1');
        text += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
        for (let id = 1; id < objects.length; id++) { text += String(offsets[id]).padStart(10, '0') + ' 00000 n \n'; }
        text += `trailer\n<< /Root 1 0 R /Size ${objects.length} >>\nstartxref\n${start}\n%%EOF\n`;
        return new Uint8Array(Buffer.from(text, 'latin1'));
    }
    function pdf(external: boolean, mask = false) {
        const commands = 'q 10 8 74 48 re W n 80 12 -8 50 12 8 cm /Photo Do Q\n0 0 1 rg 25 15 14 18 re f\nBT /F1 10 Tf 4 70 Td (Native text first) Tj ET';
        const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 110 85] /Resources << /XObject << /Photo 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>',
            stream('', commands),
            stream(`/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ${mask ? '/SMask 7 0 R' : ''} ${external ? '/MotionLabImage (x5)' : ''}`, external ? '' : original),
            '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
        if (mask) { objects.push(stream(`/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ${external ? '/MotionLabImage (x7)' : ''}`, external ? '' : deflateSync(new Uint8Array([0, 90, 180, 255])))); }
        return pdfBytes(objects);
    }
    function type3Pdf(external: boolean) {
        const page = (content: number) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 110 85] /Resources << /Font << /F1 5 0 R >> >> /Contents ${content} 0 R >>`;
        return pdfBytes(['', '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
            page(6), page(7),
            '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 96 64] /FontMatrix [0.01 0 0 0.01 0 0] /CharProcs << /A 8 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [100] /Resources << /XObject << /Photo 9 0 R >> >> >>',
            stream('', 'BT /F1 80 Tf 10 15 Td (A) Tj ET'), stream('', 'BT /F1 80 Tf 10 15 Td (A) Tj ET'),
            stream('', '100 0 d0 q 96 0 0 64 0 0 cm /Photo Do Q'),
            stream(`/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ${external ? '/MotionLabImage (x5)' : ''}`, external ? '' : original)]);
    }

    function metadata(mask = false) {
        // Exact padded coefficient allocation for the authored 96×64 4:2:0 JPEG.
        const images: any[] = [{ id: 'x5', sha256: fixture.sha256, originalSha256: fixture.originalSha256,
            bytes: progressive.length, width: 96, height: 64, components: 3,
            coefficientBytes: 20_480, encoding: 'progressive-jpeg', chunks: fixture.chunks }];
        if (mask) {
            const bytes = deflateSync(new Uint8Array([0, 90, 180, 255]));
            images.push({ id: 'x7', sha256: hash(bytes), originalSha256: hash(bytes), bytes: bytes.length,
                width: 2, height: 2, encoding: 'original' });
        }
        return images;
    }
    function encoded(id: string, chunkIndex: number) {
        if (id === 'x7') { return new Uint8Array(deflateSync(new Uint8Array([0, 90, 180, 255]))); }
        const chunk = fixture.chunks[chunkIndex];
        return progressive.slice(chunk.offset, chunk.offset + chunk.bytes);
    }
    class CanvasFactory {
        create(width: number, height: number) { const value = canvas.createCanvas(width, height); return { canvas: value, context: value.getContext('2d') }; }
        reset(value: any, width: number, height: number) { value.canvas.width = width; value.canvas.height = height; }
        destroy(value: any) { value.canvas.width = value.canvas.height = 0; value.canvas = value.context = null; }
    }
    async function open(read?: (request: any) => Promise<Uint8Array>, mask = false, sourceMetadata = metadata(mask), data = pdf(!!read, mask)) {
        const source = read ? { images: sourceMetadata, read } : undefined;
        const task = pdfjs.getDocument({ data, externalImageSource: source,
            externalImageBudget: { maxActiveBytes: 4 << 20, maxEncodedBytes: 1 << 20, maxCoefficientBytes: 1 << 20, maxOutputPixels: 6144 },
            adaptiveImageDecoding: true, imageDecodeConcurrency: 1, CanvasFactory,
            isOffscreenCanvasSupported: false, isImageDecoderSupported: false, isEvalSupported: false, useSystemFonts: false,
            standardFontDataUrl: path.join(repo, 'node_modules/pdfjs-dist/standard_fonts/') });
        const document = await task.promise;
        return { task, document, page: await document.getPage(1) };
    }
    function render(page: any, scale = 1, intent = 'display') {
        const viewport = page.getViewport({ scale });
        const image = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const task = page.render({ viewport, intent, canvasContext: image.getContext('2d') });
        return { image, task, pixels: () => image.getContext('2d').getImageData(0, 0, image.width, image.height).data };
    }

    it('paints native text and vector order before photo bytes, then refines the same clipped page to exact final pixels', async () => {
        const first = deferred(), rest = deferred();
        const reads: number[] = [];
        const value = await open(async ({ id, chunkIndex }) => { reads.push(chunkIndex); await (chunkIndex ? rest.promise : first.promise); return encoded(id, chunkIndex); });
        const originalDocument = await open();
        try {
            assert.strictEqual(value.document.hasExternalImages, true);
            const pass = render(value.page);
            await pass.task.promise;
            assert.strictEqual(pass.task.imageStatus.total, 1);
            assert.strictEqual(pass.task.imageStatus.covered, 0);
            assert.strictEqual(pass.task.imageStatus.final, false);
            const text = await value.page.getTextContent();
            assert.ok(text.items.some((item: any) => item.str === 'Native text first'));
            assert.ok(pass.pixels().some((n: number) => n < 200), 'text and vector operators paint during the first native pass');
            first.resolve();
            await value.page.waitForImages({ final: false });
            const coarse = render(value.page);
            await coarse.task.promise;
            assert.strictEqual(coarse.task.imageStatus.covered, 1);
            assert.strictEqual(coarse.task.imageStatus.final, false);
            assert.notDeepStrictEqual(coarse.pixels(), pass.pixels());
            rest.resolve();
            await value.page.waitForImages({ final: true });
            const final = render(value.page), reference = render(originalDocument.page);
            await Promise.all([final.task.promise, reference.task.promise]);
            assert.strictEqual(final.task.imageStatus.final, true);
            assert.deepStrictEqual(final.pixels(), reference.pixels(), 'the complete native operator list retains transform, clip, text and foreground vector order');
            assert.strictEqual(reads.length, fixture.chunks.length, 'the original image body is never fetched alongside progressive chunks');
            const stats = await value.document.getRangeCacheStats();
            assert.strictEqual(stats.externalImageEntropyCalls, fixture.chunks.length);
            assert.strictEqual(stats.externalImageFinalDecodes, 1);
            await value.page.cancelImageRefinement();
            const clean = await value.document.getRangeCacheStats();
            assert.strictEqual(clean.externalImageReservedBytes, 0);
        } finally { first.resolve(); rest.resolve(); await value.task.destroy(); await originalDocument.task.destroy(); }
    });

    it('reuses prepared coverage when a clipped candidate pass keeps the adopting viewport and output transform', async () => {
        const rest = deferred();
        const reads: number[] = [];
        const value = await open(async ({ id, chunkIndex }) => {
            reads.push(chunkIndex);
            if (chunkIndex) { await rest.promise; }
            return encoded(id, chunkIndex);
        });
        try {
            const viewport = value.page.getViewport({ scale: 2 });
            const transform = [2, 0, 0, 2, 0, 0];
            const clipped = canvas.createCanvas(2, 2);
            const prepared = value.page.render({ viewport, transform, canvasContext: clipped.getContext('2d') });
            await prepared.promise;
            await value.page.waitForImages({ final: false });
            const epoch = value.page._externalImages.current.externalImageEpoch;
            const displayed = canvas.createCanvas(Math.ceil(viewport.width * 2), Math.ceil(viewport.height * 2));
            const adopted = value.page.render({ viewport, transform, canvasContext: displayed.getContext('2d') });
            await adopted.promise;
            assert.strictEqual(value.page._externalImages.current.externalImageEpoch, epoch);
            assert.strictEqual(adopted.imageStatus.discovered, true);
            assert.strictEqual(adopted.imageStatus.covered, adopted.imageStatus.total);
            assert.strictEqual(adopted.imageStatus.final, false);
            assert.strictEqual(reads.filter(index => index === 0).length, 1, 'adoption consumes the prepared native objects');
            rest.resolve();
            await value.page.waitForImages({ final: true });
            await value.document.cleanup();
            const released = await value.document.getRangeCacheStats();
            assert.strictEqual(released.externalImageNativeRasterBytes, 0);
            assert.strictEqual(released.externalImagePartialRasterBytes, 0);
        } finally { rest.resolve(); await value.task.destroy(); }
    });

    it('keeps print unresolved until original-resolution native image completion', async () => {
        const ready = deferred(), release = deferred();
        const value = await open(async ({ id, chunkIndex }) => { ready.resolve(); await release.promise; return encoded(id, chunkIndex); });
        try {
            const printed = render(value.page, 1, 'print');
            let completed = false;
            void printed.task.promise.then(() => { completed = true; });
            await ready.promise;
            assert.strictEqual(completed, false);
            release.resolve();
            await printed.task.promise;
            assert.strictEqual(printed.task.imageStatus.final, true);
            assert.strictEqual(printed.task.imageStatus.covered, 1);
        } finally { release.resolve(); await value.task.destroy(); }
    });

    it('uses original filter and soft-mask semantics for unsupported incremental combinations', async () => {
        const value = await open(async ({ id, chunkIndex }) => encoded(id, chunkIndex), true);
        const reference = await open(undefined, true);
        try {
            const first = render(value.page); await first.task.promise;
            await value.page.waitForImages({ final: true });
            const result = render(value.page), expected = render(reference.page);
            await Promise.all([result.task.promise, expected.task.promise]);
            assert.deepStrictEqual(result.pixels(), expected.pixels());
            const stats = await value.document.getRangeCacheStats();
            assert.strictEqual(stats.externalImageEntropyCalls, 0);
            assert.strictEqual(stats.externalImageFinalDecodes, 1);
            assert.strictEqual(stats.externalImageFallbackReasons['native-color-or-print'], 1);
        } finally { await value.task.destroy(); await reference.task.destroy(); }
    });

    it('acknowledges cancellation only after stream ownership releases and can rebuild the same displayed page', async () => {
        const started = deferred();
        let held = true, aborted = 0;
        const value = await open(async ({ id, chunkIndex, signal }) => {
            if (!held) { return encoded(id, chunkIndex); }
            started.resolve();
            return new Promise<Uint8Array>((_resolve, reject) => {
                signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
            });
        });
        try {
            const initial = render(value.page); await initial.task.promise;
            await started.promise;
            await value.page.cancelImageRefinement();
            assert.strictEqual(aborted, 1);
            const empty = await value.document.getRangeCacheStats();
            assert.strictEqual(empty.externalImageReservedBytes, 0);
            assert.strictEqual(empty.externalImageEncodedBytes, 0);
            assert.strictEqual(empty.externalImageCoefficientBytes, 0);
            held = false;
            const next = render(value.page); await next.task.promise;
            await value.page.waitForImages({ final: true });
            const final = render(value.page); await final.task.promise;
            assert.strictEqual(final.task.imageStatus.final, true);
        } finally { await value.task.destroy(); }
    });

    it('rejects a corrupt verified scan without marking placeholder output final', async () => {
        const value = await open(async ({ id, chunkIndex }) => { const bytes = encoded(id, chunkIndex); bytes[bytes.length - 1] ^= 1; return bytes; });
        try {
            const first = render(value.page); await first.task.promise;
            await assert.rejects(value.page.waitForImages({ final: true }), /failed to decode/);
            assert.strictEqual(value.page.imageStatus.failed, 1);
            assert.strictEqual(value.page.imageStatus.covered, 0);
            assert.strictEqual(value.page.imageStatus.final, false);
            await value.page.cancelImageRefinement();
            const stats = await value.document.getRangeCacheStats();
            assert.strictEqual(stats.externalImageReservedBytes, 0);
        } finally { await value.task.destroy(); }
    });

    it('reports an unresolved structural image identifier without leaving an unresolved drawing dependency', async () => {
        let reads = 0;
        const value = await open(async ({ id, chunkIndex }) => { reads++; return encoded(id, chunkIndex); }, false, []);
        try {
            await value.page.getOperatorList();
            assert.strictEqual(value.page.imageStatus.failed, 1);
            assert.strictEqual(value.page.imageStatus.final, false);
            assert.strictEqual(reads, 0);
            for (const record of value.page._externalImages.records.values()) {
                assert.strictEqual(record.failed, true);
            }
            const pass = render(value.page); await pass.task.promise;
            assert.strictEqual(pass.task.imageStatus.failed, 1);
            await assert.rejects(value.page.waitForImages({ final: true }), /failed to decode/);
        } finally { await value.task.destroy(); }
    });

    for (const registration of ['before', 'after']) {
        it(`receives a common image registered ${registration} page cancellation until document cleanup`, async () => {
            const closed: string[] = [];
            const page: any = { _pageIndex: 0, _intentStates: new Map(), destroyed: false,
                objs: new pdfjs.TestObjects(), commonObjs: new pdfjs.TestObjects(),
                _transport: { messageHandler: { send() {}, sendWithPromise: () => Promise.resolve() } } };
            const owner = new pdfjs.TestImageRevisions(page);
            const state: any = { operatorList: { lastChunk: true }, renderTasks: new Set<any>() };
            page._intentStates.set('display', state);
            owner.newIntent(state, 'display', 2);
            state.externalImageDiscovered = true;
            owner.begin(state);
            const identity = { id: 'g_type3_image', imageId: 'x5', pageIndex: 0,
                epoch: state.externalImageEpoch, cacheKey: 'display', common: true, print: true };
            if (registration === 'before') { owner.register({ ...identity, image: null }); }
            const dependency = deferred<any>();
            page.commonObjs.get(identity.id, dependency.resolve);
            await owner.cancel();
            if (registration === 'after') { owner.register({ ...identity, image: null }); }
            let replay = 0;
            owner.subscribe(() => { replay++; });
            const image = { width: 1, height: 1, bitmap: { close: () => closed.push('installed') } };
            assert.strictEqual(owner.receive({ ...identity, image, final: true, failed: false, scan: 1 }), true);
            assert.strictEqual(await dependency.promise, image, 'a later font draw resolves the same document object');
            assert.strictEqual(page.commonObjs.get(identity.id), image);
            assert.strictEqual(owner.records.get(identity.id).state, null, 'the shared image does not retain a canceled operator list');
            assert.strictEqual(replay, 0, 'a canceled page does not schedule another image pass');
            assert.strictEqual(closed.length, 0);
            owner.clearCommon();
            page.commonObjs.clear();
            assert.strictEqual(owner.records.size, 0);
            assert.strictEqual(owner.receive({ ...identity, image: { width: 1, height: 1,
                bitmap: { close: () => closed.push('late') } }, final: true, failed: false }), false);
            assert.deepStrictEqual(closed, ['installed', 'late']);
        });
    }

    it('finishes a shared Type3 image after its first page cancels and reuses it on the next page', async () => {
        const started = deferred(), release = deferred(), received = deferred<boolean>();
        const reads: number[] = [];
        const value = await open(async ({ id, chunkIndex }) => {
            reads.push(chunkIndex); started.resolve(); await release.promise; return encoded(id, chunkIndex);
        }, false, metadata(), type3Pdf(true));
        const originalDocument = await open(undefined, false, metadata(), type3Pdf(false));
        const owner = value.page._externalImages, receive = owner.receive.bind(owner);
        owner.receive = (data: any) => {
            const accepted = receive(data);
            if (data.common && data.final) { received.resolve(accepted); }
            return accepted;
        };
        let second: ReturnType<typeof render> | undefined;
        try {
            const first = render(value.page);
            const firstResult = first.task.promise.catch((error: Error) => error);
            await started.promise;
            await value.page.getOperatorList();
            await value.page.cancelImageRefinement();
            assert.strictEqual((await firstResult).name, 'RenderingCancelledException');
            const laterPage = await value.document.getPage(2);
            second = render(laterPage);
            void second.task.promise.catch(() => {});
            release.resolve();
            assert.strictEqual(await received.promise, true, 'the document-owned Type3 result survives its originating page intent');
            await second.task.promise;
            const expected = render(await originalDocument.document.getPage(2));
            await expected.task.promise;
            assert.deepStrictEqual(second.pixels(), expected.pixels());
            assert.strictEqual(reads.filter(index => index === 0).length, 1, 'the cached font retains the same image dependency');
            await value.document.cleanup();
            assert.strictEqual(owner.records.size, 0);
            const stats = await value.document.getRangeCacheStats();
            assert.strictEqual(stats.externalImageNativeRasterBytes, 0);
            assert.strictEqual(stats.externalImageReservedBytes, 0);
        } finally {
            release.resolve(); second?.task.cancel();
            await value.task.destroy(); await originalDocument.task.destroy();
        }
    });

    for (const completion of ['finish', 'cancel']) {
        it(`charges both installed and pending rasters until a paused native pass can ${completion}`, async () => {
            const page: any = { _pageIndex: 0, _intentStates: new Map(), destroyed: false,
                objs: new pdfjs.TestObjects(), commonObjs: new pdfjs.TestObjects(), _transport: {} };
            const owner = new pdfjs.TestImageRevisions(page);
            const state: any = { operatorList: { lastChunk: true }, renderTasks: new Set<any>() };
            page._intentStates.set('display', state);
            owner.newIntent(state, 'display', 2);
            state.externalImageDiscovered = true;
            owner.begin(state);
            const messages: any[] = [], releases: number[] = [];
            const manager = new worker.TestExternalImages({ metadata: metadata().map(image => ({ ...image, id: 'x1' })),
                budget: { maxActiveBytes: 1 << 20, maxEncodedBytes: 1 << 20, maxCoefficientBytes: 1 << 20, maxOutputPixels: 6144 },
                queue: { limit: 1, run: (operation: () => Promise<void>) => Promise.resolve().then(operation) },
                handler: {
                    send(_name: string, data: any) { owner.register(data); },
                    async sendWithPromise(_name: string, data: any) { messages.push(data); return owner.receive(data); },
                },
            });
            page._transport.messageHandler = {
                send(name: string, data: any) {
                    if (name === 'ReleaseExternalImageRasters') { releases.push(...data.ids); manager.releaseRasters(data.ids); }
                },
                sendWithPromise(_name: string, data: any) { return manager.cancelPage(data.pageIndex, data.epoch); },
            };
            const subscriber = { id: 'x1', objId: 'image', pageIndex: 0, epoch: state.externalImageEpoch,
                cacheKey: 'display', width: 96, height: 64, outputPixels: 100, progressive: true };
            const group = manager.add(subscriber);
            const partial = { width: 10, height: 10, data: new Uint8Array(300), kind: 2 };
            const replacedFinal = { width: 96, height: 64, data: new Uint8Array(18_432), kind: 2 };
            const final = { width: 96, height: 64, data: new Uint8Array(18_432), kind: 2 };
            try {
                manager._reserve(group, 10_000);
                await manager._publish(group, subscriber, partial, false);
                const paused = { cancel() { state.renderTasks.delete(paused); } };
                state.renderTasks.add(paused);
                await manager._publish(group, subscriber, replacedFinal, true);
                await manager._publish(group, subscriber, final, true);
                group.finished = true;
                manager._release(group);
                assert.strictEqual(page.objs.get('image'), partial);
                assert.strictEqual(owner.pending.get('image').image, final);
                assert.strictEqual(manager.stats().externalImagePartialRasterBytes, 300);
                assert.strictEqual(manager.stats().externalImageReservedBytes, 300);
                assert.strictEqual(manager.stats().externalImageNativeRasterBytes, 18_432);
                assert.deepStrictEqual(releases, [messages[1].rasterId], 'only the replaced pending image has been released');
                if (completion === 'finish') {
                    state.renderTasks.clear(); owner.finish(state);
                    assert.strictEqual(page.objs.get('image'), final);
                    assert.strictEqual(manager.stats().externalImagePartialRasterBytes, 0);
                    assert.strictEqual(manager.stats().externalImageNativeRasterBytes, 18_432);
                }
                await owner.cancel();
                await owner.cancel();
                manager.releaseRasters(messages.map(message => message.rasterId));
                for (const field of ['externalImagePartialRasterBytes', 'externalImageNativeRasterBytes', 'externalImageReservedBytes']) {
                    assert.strictEqual(manager.stats()[field], 0, field);
                }
                let closed = 0;
                assert.strictEqual(owner.receive({ ...subscriber, id: subscriber.objId, image: { width: 1, height: 1,
                    bitmap: { close() { closed++; } } }, rasterId: 999, final: true }), false);
                assert.strictEqual(closed, 1);
                assert.strictEqual(manager.outputs.size, 0);
            } finally { state.renderTasks.clear(); await owner.cancel(); await manager.close(); }
        });
    }

    it('holds one pending bitmap between passes and retains a failed outcome while installing its last useful pixels', async () => {
        const release = deferred();
        const closed: string[] = [];
        const page: any = { _pageIndex: 0, _intentStates: new Map(), destroyed: false,
            objs: new pdfjs.TestObjects(), commonObjs: new pdfjs.TestObjects(),
            _transport: { messageHandler: { send() {}, sendWithPromise: () => release.promise } } };
        const owner = new pdfjs.TestImageRevisions(page);
        const state = { operatorList: { lastChunk: true }, renderTasks: new Set<any>() };
        page._intentStates.set('display', state);
        owner.newIntent(state, 'display', 2);
        (state as any).externalImageDiscovered = true;
        owner.begin(state);
        const item = (label: string) => ({ width: 1, height: 1, bitmap: { close: () => closed.push(label) } });
        const identity = { id: 'image', imageId: 'x5', pageIndex: 0, epoch: 1, cacheKey: 'display' };
        owner.register({ ...identity, image: item('placeholder') });
        state.renderTasks.add({});
        owner.receive({ ...identity, image: item('older'), final: false });
        owner.receive({ ...identity, image: item('newer'), final: false });
        assert.deepStrictEqual(closed, ['older']);
        assert.strictEqual(owner.status().covered, 0, 'an active native pass still uses its original bitmap');
        owner.receive({ ...identity, failed: true, message: 'later scan rejected' });
        state.renderTasks.clear();
        owner.finish(state);
        assert.deepStrictEqual(closed, ['older', 'placeholder']);
        assert.strictEqual(owner.status().covered, 1);
        assert.strictEqual(owner.status().failed, 1);
        assert.strictEqual(owner.status().pending, 0);
        assert.strictEqual(owner.status().final, false);
        let settled = false;
        const cancelled = owner.cancel().then(() => { settled = true; });
        await Promise.resolve();
        assert.strictEqual(settled, false, 'the release acknowledgement owns the suspension barrier');
        assert.strictEqual(owner.receive({ ...identity, image: item('late'), final: true }), false);
        assert.deepStrictEqual(closed, ['older', 'placeholder', 'newer', 'late']);
        release.resolve();
        await cancelled;
        assert.strictEqual(page._intentStates.size, 0);
        assert.strictEqual(owner.pending.size, 0);
        assert.strictEqual(owner.records.size, 0);
    });
});
