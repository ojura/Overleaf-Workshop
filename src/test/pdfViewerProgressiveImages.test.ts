/* eslint-disable @typescript-eslint/naming-convention -- pinned PDF.js classes and JPEG metadata */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ReadableStream } from 'stream/web';
import { createHash } from 'crypto';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'src/test/fixtures/progressive-jpeg.json'), 'utf8'));
const progressive = new Uint8Array(Buffer.from(fixture.progressive, 'base64'));
const original = new Uint8Array(Buffer.from(fixture.original, 'base64'));

function encodedRange(request: { chunkIndex: number; chunkCount?: number }, bytes = progressive, chunks = fixture.chunks) {
    const first = chunks[request.chunkIndex];
    const last = chunks[request.chunkIndex + (request.chunkCount ?? 1) - 1];
    return bytes.slice(first.offset, last.offset + last.bytes);
}

function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe('production progressive JPEG decoding', function () {
    this.timeout(10_000);
    let directory: string;
    let worker: any;
    const saved = new Map<string, PropertyDescriptor | undefined>();

    before(async () => {
        const { pdfjsRelease } = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-progressive-images-'));
        fs.writeFileSync(path.join(directory, 'pdf.worker.mjs'), fs.readFileSync(path.join(pdfjsRelease, 'build/pdf.worker.mjs'), 'utf8')
            + '\nexport { JpegImage };\nexport const ProgressiveJpeg = typeof IncrementalJpegImage === "undefined" ? undefined : IncrementalJpegImage;\nexport const ExternalImages = typeof ExternalImageManager === "undefined" ? undefined : ExternalImageManager;\n');
        for (const name of ['pdfjsWorker']) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); }
        worker = await importModule(pathToFileURL(path.join(directory, 'pdf.worker.mjs')).href);
    });
    after(() => {
        for (const [name, descriptor] of saved) {
            if (descriptor) { Object.defineProperty(globalThis, name, descriptor); }
            else { delete (globalThis as any)[name]; }
        }
        if (directory) { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    function decoder(options: Record<string, unknown> = {}) {
        assert.strictEqual(typeof worker.ProgressiveJpeg, 'function', 'the production worker must own progressive scan decoding');
        return new worker.ProgressiveJpeg({ encodedBytes: progressive.length, ...options });
    }
    function reference(bytes: Uint8Array, width: number, height: number, options: Record<string, unknown> = {}) {
        const image = new worker.JpegImage(options);
        image.parse(bytes);
        return image.getData({ width, height, forceRGB: true, isSourcePDF: true });
    }
    function scans(image: any, onScan: (event: any) => void = () => {}) {
        for (const chunk of fixture.chunks) {
            image.push(progressive.slice(chunk.offset, chunk.offset + chunk.bytes), { final: chunk.offset + chunk.bytes === progressive.length });
            for (;;) {
                const event = image.next();
                if (event.type === 'need' || event.type === 'done') { break; }
                assert.strictEqual(event.type, 'scan');
                onScan(event);
            }
        }
    }

    it('publishes the first verified scan before the remaining bytes and keeps exact final pixels at different output sizes', () => {
        const image = decoder();
        let count = 0;
        try {
            scans(image, event => {
                count++;
                const prefix = new Uint8Array(event.boundary + 2);
                prefix.set(progressive.subarray(0, event.boundary));
                prefix.set([255, 217], event.boundary);
                assert.deepStrictEqual(image.render({ width: 37, height: 25 }), reference(prefix, 37, 25), `scan ${event.scan} differs from the pinned decoder`);
                if (count === 1) { assert.ok(image.receivedBytes < progressive.length / 3, 'useful pixels arrive before the remaining photo bytes'); }
            });
            assert.strictEqual(count, fixture.chunks.length);
            assert.strictEqual(image.entropyCalls, count, 'each entropy scan is decoded once');
            for (const [width, height] of [[17, 11], [61, 40], [96, 64]]) {
                assert.deepStrictEqual(image.render({ width, height }), reference(original, width, height));
            }
        } finally { image.cancel(); }
        assert.strictEqual(image.coefficientBytes, 0);
        assert.strictEqual(image.inputCapacity, 0);
    });

    it('uses row scratch without mutating or cloning retained coefficients during adaptive IDCT', () => {
        const image = decoder();
        try {
            const first = fixture.chunks[0];
            image.push(progressive.slice(0, first.bytes));
            assert.strictEqual(image.next().type, 'scan');
            const before = image._frame.components.map((component: any) => component.blockData.slice());
            const retained = image.coefficientBytes;
            image.render({ width: 31, height: 21 });
            image.render({ width: 79, height: 53 });
            image._frame.components.forEach((component: any, index: number) => assert.deepStrictEqual(component.blockData, before[index]));
            assert.ok(image.peakScratchBytes > 0);
            assert.ok(image.peakScratchBytes < retained / 4, `row scratch ${image.peakScratchBytes} must remain smaller than retained coefficients ${retained}`);
            assert.strictEqual(image.coefficientBytes, retained);
        } finally { image.cancel(); }
    });

    it('retains the first DC scan compactly while another image gets coverage, then resumes without replaying entropy', () => {
        const image = decoder();
        try {
            const first = fixture.chunks[0];
            image.push(progressive.slice(0, first.bytes));
            assert.strictEqual(image.next().type, 'scan');
            const firstPixels = image.render({ width: 37, height: 25 });
            const expandedBytes = image.coefficientBytes;
            assert.strictEqual(image.compact(), true);
            assert.strictEqual(image.coefficientBytes * 64, expandedBytes, 'only exact nonzero DC entries remain owned');
            assert.strictEqual(image.entropyCalls, 1);
            image.expand();
            assert.strictEqual(image.coefficientBytes, expandedBytes);
            assert.deepStrictEqual(image.render({ width: 37, height: 25 }), firstPixels);
            for (const chunk of fixture.chunks.slice(1)) {
                image.push(progressive.slice(chunk.offset, chunk.offset + chunk.bytes), { final: chunk.offset + chunk.bytes === progressive.length });
                for (;;) {
                    const event = image.next();
                    if (event.type === 'need' || event.type === 'done') { break; }
                }
            }
            assert.strictEqual(image.entropyCalls, fixture.chunks.length);
            assert.deepStrictEqual(image.render({ width: 61, height: 40 }), reference(original, 61, 40));
        } finally { image.cancel(); }
        assert.strictEqual(image.coefficientBytes, 0);
        assert.strictEqual(image.inputCapacity, 0);
    });

    it('preserves non-default PDF color conversion and signed decode transforms', () => {
        const image = decoder();
        try {
            scans(image);
            for (const options of [
                { colorTransform: 0 },
                { colorTransform: 1, decodeTransform: new Int32Array([-256, 255, 256, 0, -256, 255]) },
            ]) {
                assert.deepStrictEqual(image.render({ width: 43, height: 29, ...options }), reference(original, 43, 29, options));
            }
        } finally { image.cancel(); }
    });

    it('resumes exact DC state at Al0 and Al4 across YCbCr and Adobe RGB scan sequences', () => {
        assert.deepStrictEqual(fixture.variants.map((value: any) => [value.initialAl, value.chunks.length]), [[4, 13], [0, 9], [4, 17]]);
        for (const variant of fixture.variants) {
            const input = new Uint8Array(Buffer.from(variant.progressive, 'base64'));
            const source = new Uint8Array(Buffer.from(variant.original, 'base64'));
            const image = decoder({ encodedBytes: input.length });
            try {
                for (const chunk of variant.chunks) {
                    image.push(input.slice(chunk.offset, chunk.offset + chunk.bytes), { final: chunk.offset + chunk.bytes === input.length });
                    for (;;) {
                        const event = image.next();
                        if (event.type !== 'scan') { break; }
                        const prefix = new Uint8Array(event.boundary + 2);
                        prefix.set(input.subarray(0, event.boundary));
                        prefix.set([255, 217], event.boundary);
                        assert.deepStrictEqual(image.render({ width: 29, height: 19 }), reference(prefix, 29, 19), `${variant.name} scan ${event.scan}`);
                        if (event.scan === 1) {
                            const retained = image.coefficientBytes;
                            assert.strictEqual(image.compact(), true);
                            assert.strictEqual(image.coefficientBytes * 64, retained);
                            image.expand();
                            assert.strictEqual(image.entropyCalls, 1);
                        }
                    }
                }
                assert.strictEqual(image.entropyCalls, variant.chunks.length);
                assert.deepStrictEqual(image.render({ width: 48, height: 32 }), reference(source, 48, 32));
            } finally { image.cancel(); }
        }
    });

    it('waits for a split entropy marker and cancels retained state without another decode', () => {
        const controller = new AbortController();
        const image = decoder({ signal: controller.signal });
        const end = fixture.chunks[0].bytes;
        image.push(progressive.slice(0, end - 1));
        assert.strictEqual(image.next().type, 'need');
        assert.strictEqual(image.entropyCalls, 0);
        image.push(progressive.slice(end - 1, end));
        assert.strictEqual(image.next().type, 'scan');
        controller.abort();
        assert.strictEqual(image.coefficientBytes, 0);
        assert.strictEqual(image.inputCapacity, 0);
        assert.throws(() => image.next(), { name: 'AbortError' });
        assert.strictEqual(image.entropyCalls, 1);
    });

    it('rejects oversized or truncated input before leaving owned state behind', () => {
        const capped = decoder({ maxCoefficientBytes: 1 });
        capped.push(progressive.slice(0, fixture.chunks[0].bytes));
        assert.throws(() => capped.next(), /coefficient limit/);
        assert.strictEqual(capped.coefficientBytes, 0);
        assert.strictEqual(capped.inputCapacity, 0);
        const truncated = decoder();
        truncated.push(progressive.slice(0, fixture.chunks[0].bytes - 1), { final: true });
        assert.throws(() => truncated.next(), /Truncated/);
        assert.strictEqual(truncated.coefficientBytes, 0);
        assert.strictEqual(truncated.inputCapacity, 0);
    });

    it('gives each visible image verified first-scan coverage before retaining its later refinement work', async () => {
        assert.strictEqual(typeof worker.ExternalImages, 'function');
        const probe = decoder();
        probe.push(progressive.slice(0, fixture.chunks[0].bytes));
        probe.next();
        const coefficientBytes = probe.coefficientBytes;
        probe.cancel();
        const reads: string[] = [];
        const revisions: any[] = [];
        const finished = deferred<void>();
        const manager = new worker.ExternalImages({
            metadata: ['x1', 'x2'].map(id => ({ ...fixture, original: undefined, progressive: undefined,
                id, bytes: progressive.length, width: 96, height: 64, components: 3,
                coefficientBytes, encoding: 'progressive-jpeg' })),
            budget: { maxActiveBytes: 1 << 20, maxEncodedBytes: 1 << 20, maxCoefficientBytes: 1 << 20, maxOutputPixels: 6144 },
            queue: { limit: 1, run: (run: () => Promise<void>) => Promise.resolve().then(run) },
            handler: {
                send() {},
                sendWithStream(_name: string, request: { id: string; chunkIndex: number; chunkCount?: number }) {
                    reads.push(`${request.id}:${request.chunkIndex}`);
                    return new ReadableStream({ start(controller) {
                        controller.enqueue(encodedRange(request));
                        controller.close();
                    } });
                },
                async sendWithPromise(_name: string, revision: any) {
                    revisions.push(revision);
                    if (revision.failed) { finished.reject(new Error(revision.message)); }
                    if (revisions.filter(value => value.final).length === 2) { finished.resolve(); }
                    return true;
                },
            },
        });
        try {
            for (const id of ['x1', 'x2']) {
                manager.add({ id, objId: id, pageIndex: 0, epoch: 1, cacheKey: 'display',
                    width: 96, height: 64, outputPixels: 37 * 25, progressive: true, print: false,
                    render: async ({ decoder: state, bytes, final }: any) => ({
                        width: 37, height: 25, kind: 2,
                        data: final ? reference(bytes, 37, 25) : state.render({ width: 37, height: 25 }),
                    }),
                });
            }
            assert.deepStrictEqual(reads, [], 'the native text/placeholder pass precedes image transfer');
            manager.startPage(0, 1);
            await finished.promise;
            assert.deepStrictEqual(reads.slice(0, 2), ['x1:0', 'x2:0']);
            assert.strictEqual(reads.length, 4, 'each image reads its first scan and one contiguous verified tail');
            for (const value of revisions.filter(value => value.final)) {
                assert.deepStrictEqual(value.image.data, reference(original, 37, 25));
            }
        } finally { await manager.close(); }
        assert.strictEqual(manager.stats().externalImageCoefficientBytes, 0);
        assert.strictEqual(manager.stats().externalImageEncodedBytes, 0);
        assert.strictEqual(manager.stats().externalImageReservedBytes, 0);
        assert.strictEqual(manager.stats().externalImageEntropyCalls, 2,
            'complete authenticated tails use the native final decoder without repeating their entropy work');
    });

    it('batches later scans after every ready image has first coverage with full input space reserved', async () => {
        const comment = new Uint8Array(65_537);
        comment.set([255, 254, 255, 255]);
        const bytes = new Uint8Array(progressive.length + comment.length * 2);
        bytes.set(progressive.subarray(0, -2));
        bytes.set(comment, progressive.length - 2);
        bytes.set(comment, progressive.length - 2 + comment.length);
        bytes.set([255, 217], bytes.length - 2);
        const chunks = fixture.chunks.map((chunk: any) => ({ ...chunk }));
        const last = chunks[chunks.length - 1];
        last.bytes = bytes.length - last.offset;
        last.sha256 = createHash('sha256').update(bytes.subarray(last.offset)).digest('hex');
        const firstCovered = deferred(), lateCovered = deferred(), secondRead = deferred(), releaseSecond = deferred(), finished = deferred();
        void finished.promise.catch(() => {});
        const reads: { id: string; chunkIndex: number; chunkCount: number }[] = [];
        const installed = new Map<string, number>();
        let completed = 0;
        const manager = new worker.ExternalImages({
            metadata: ['x1', 'x2'].map(id => ({ id, sha256: createHash('sha256').update(bytes).digest('hex'),
                originalSha256: fixture.originalSha256, bytes: bytes.length, width: 96, height: 64, components: 3,
                coefficientBytes: 20_480, encoding: 'progressive-jpeg', chunks })),
            budget: { maxActiveBytes: 2 << 20, maxEncodedBytes: 1 << 20, maxCoefficientBytes: 1 << 20, maxOutputPixels: 6144 },
            queue: { limit: 2, run: (run: () => Promise<void>) => Promise.resolve().then(run) },
            handler: {
                send() {},
                sendWithStream(_name: string, request: { id: string; chunkIndex: number; chunkCount?: number }) {
                    reads.push({ ...request, chunkCount: request.chunkCount ?? 1 });
                    if (request.chunkIndex) {
                        assert.strictEqual(manager.groups.get(request.id).decoder.inputCapacity, bytes.length,
                            'the complete input allocation precedes receipt of the later-scan buffer');
                        assert.strictEqual(manager.groups.get(request.id).decoder.coefficientBytes, 20_480 / 64,
                            'the incomplete first-scan state remains compact while the complete tail is fetched');
                    }
                    return new ReadableStream({ async start(controller) {
                        if (request.id === 'x2' && !request.chunkIndex) { secondRead.resolve(); await releaseSecond.promise; }
                        controller.enqueue(encodedRange(request, bytes, chunks)); controller.close();
                    } });
                },
                async sendWithPromise(_name: string, revision: any) {
                    if (revision.failed) { finished.reject(new Error(revision.message)); }
                    const prior = installed.get(revision.id);
                    if (prior !== undefined) { manager.releaseRasters([prior]); }
                    installed.set(revision.id, revision.rasterId);
                    if (!revision.final && revision.id === 'x1') { firstCovered.resolve(); }
                    if (!revision.final && revision.id === 'x1-late') { lateCovered.resolve(); }
                    if (revision.final) {
                        assert.deepStrictEqual(revision.image.data, reference(original, 37, 25));
                        if (++completed === 3) { finished.resolve(); }
                    }
                    return true;
                },
            },
        });
        try {
            const enlist = (id: string, objId = id) =>
                manager.add({ id, objId, pageIndex: 0, epoch: 1, cacheKey: 'display', width: 96, height: 64,
                    outputPixels: 37 * 25, progressive: true,
                    render: async ({ decoder: state, bytes: input, final }: any) => ({ width: 37, height: 25, kind: 2,
                        data: final ? reference(input, 37, 25) : state.render({ width: 37, height: 25 }) }),
                });
            for (const id of ['x1', 'x2']) { enlist(id); }
            manager.startPage(0, 1);
            const firstTask = manager.groups.get('x1').task;
            await Promise.all([firstCovered.promise, secondRead.promise, firstTask]);
            assert.deepStrictEqual(reads, [{ id: 'x1', chunkIndex: 0, chunkCount: 1 }, { id: 'x2', chunkIndex: 0, chunkCount: 1 }],
                'a free decode slot waits for the remaining first scan instead of starting a large tail');
            const late = enlist('x1', 'x1-late');
            await Promise.all([lateCovered.promise, late.task]);
            assert.strictEqual(reads.length, 2, 'a late subscriber receives retained coarse pixels without starting a tail ahead of another first scan');
            releaseSecond.resolve();
            await finished.promise;
            await Promise.allSettled(manager.tasks);
            assert.strictEqual(reads.length, 4);
            assert.deepStrictEqual(reads.slice(2).map(value => value.chunkCount), [chunks.length - 1, chunks.length - 1]);
            assert.strictEqual(manager.stats().externalImageEntropyCalls, 2);
            assert.strictEqual(manager.stats().externalImageFinalDecodes, 3);
            assert.strictEqual(manager.stats().externalImageBytesReceived, bytes.length * 2);
            assert.ok(manager.stats().externalImagePeakReservedBytes <= manager.stats().externalImageBudgetBytes);
        } finally { releaseSecond.resolve(); await manager.close(); }
        for (const field of ['externalImageEncodedBytes', 'externalImageCoefficientBytes', 'externalImageReservedBytes',
            'externalImagePartialRasterBytes', 'externalImageNativeRasterBytes']) { assert.strictEqual(manager.stats()[field], 0, field); }
    });

    it('verifies every member of a combined scan tail before consuming its entropy', async () => {
        const failed = deferred();
        const reads: number[] = [];
        const manager = new worker.ExternalImages({
            metadata: [{ id: 'x1', sha256: fixture.sha256, originalSha256: fixture.originalSha256, bytes: progressive.length,
                width: 96, height: 64, components: 3, coefficientBytes: 20_480, encoding: 'progressive-jpeg', chunks: fixture.chunks }],
            budget: { maxActiveBytes: 1 << 20, maxEncodedBytes: 1 << 20, maxCoefficientBytes: 1 << 20, maxOutputPixels: 6144 },
            queue: { limit: 1, run: (run: () => Promise<void>) => Promise.resolve().then(run) },
            handler: {
                send() {},
                sendWithStream(_name: string, request: { chunkIndex: number; chunkCount?: number }) {
                    reads.push(request.chunkCount ?? 1);
                    const data = encodedRange(request);
                    const corrupt = fixture.chunks[2].offset - fixture.chunks[request.chunkIndex].offset;
                    if (corrupt >= 0 && corrupt < data.length) { data[corrupt] ^= 1; }
                    return new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } });
                },
                async sendWithPromise(_name: string, revision: any) {
                    if (revision.failed) { assert.match(revision.message, /digest differs/); failed.resolve(); }
                    return true;
                },
            },
        });
        try {
            manager.add({ id: 'x1', objId: 'x1', pageIndex: 0, epoch: 1, cacheKey: 'display', width: 96, height: 64,
                outputPixels: 37 * 25, progressive: true,
                render: async ({ decoder: state }: any) => ({ width: 37, height: 25, kind: 2, data: state.render({ width: 37, height: 25 }) }),
            });
            manager.startPage(0, 1);
            await failed.promise;
            await Promise.allSettled(manager.tasks);
            assert.deepStrictEqual(reads, [1, fixture.chunks.length - 1]);
            assert.strictEqual(manager.stats().externalImageEntropyCalls, 1, 'a corrupt tail never advances the verified first-scan state');
            assert.strictEqual(manager.stats().externalImageCompleted, 0);
            assert.strictEqual(manager.stats().externalImageFailed, 1);
        } finally { await manager.close(); }
    });

    it('releases a transferred final raster when cancellation precedes its acknowledgement', async () => {
        const transferred = deferred<void>(), acknowledge = deferred<boolean>();
        let publications = 0;
        const manager = new worker.ExternalImages({
            metadata: [{ id: 'x1', sha256: fixture.sha256, originalSha256: fixture.originalSha256,
                bytes: progressive.length, width: 96, height: 64, components: 3,
                coefficientBytes: 20_480, encoding: 'progressive-jpeg', chunks: fixture.chunks }],
            budget: { maxActiveBytes: 1 << 20, maxEncodedBytes: 1 << 20, maxCoefficientBytes: 1 << 20, maxOutputPixels: 6144 },
            queue: { limit: 1, run: (run: () => Promise<void>) => Promise.resolve().then(run) },
            handler: {
                send() {},
                sendWithStream(_name: string, request: { chunkIndex: number; chunkCount?: number }) {
                    return new ReadableStream({ start(controller) {
                        controller.enqueue(encodedRange(request)); controller.close();
                    } });
                },
                async sendWithPromise(_name: string, revision: any) {
                    assert.strictEqual(revision.failed, false);
                    assert.strictEqual(revision.final, publications === 1);
                    if (++publications === 2) { transferred.resolve(); return acknowledge.promise; }
                    return true;
                },
            },
        });
        try {
            manager.add({ id: 'x1', objId: 'image1', pageIndex: 0, epoch: 1, cacheKey: 'display',
                width: 96, height: 64, outputPixels: 37 * 25, progressive: true,
                render: async ({ decoder: state, bytes, final }: any) => ({ width: 37, height: 25, kind: 2,
                    data: final ? reference(bytes, 37, 25) : state.render({ width: 37, height: 25 }) }),
            });
            manager.startPage(0, 1);
            await transferred.promise;
            assert.strictEqual(manager.stats().externalImagePartialRasterBytes, 37 * 25 * 3,
                'the installed partial raster remains owned');
            assert.strictEqual(manager.stats().externalImageNativeRasterBytes, 37 * 25 * 3,
                'the unacknowledged native final transfer remains owned');
            let released = false;
            const cancellation = manager.cancelPage(0, 1).then(() => { released = true; });
            await Promise.resolve();
            assert.strictEqual(released, false, 'the cancellation barrier retains the pending transfer owner');
            assert.strictEqual(manager.stats().externalImagePartialRasterBytes, 0);
            acknowledge.resolve(true);
            await cancellation;
            await manager.cancelPage(0, 1);
            assert.strictEqual(publications, 2);
            assert.strictEqual(manager.outputs.size, 0, 'a late accepted response cannot re-create released raster ownership');
            for (const field of ['externalImagePartialRasterBytes', 'externalImageNativeRasterBytes',
                'externalImageReservedBytes', 'externalImageNativeInputBytes', 'externalImageEncodedBytes',
                'externalImageCoefficientBytes', 'externalImageActive', 'externalImageQueued']) {
                assert.strictEqual(manager.stats()[field], 0, field);
            }
        } finally { acknowledge.resolve(true); await manager.close(); }
    });

    it('keeps a common image through page release and clears its final raster at document cleanup', async () => {
        const completed = deferred<void>();
        const manager = new worker.ExternalImages({
            metadata: [{ id: 'x1', sha256: fixture.sha256, originalSha256: fixture.originalSha256,
                bytes: progressive.length, width: 96, height: 64, components: 3,
                coefficientBytes: 20_480, encoding: 'progressive-jpeg', chunks: fixture.chunks }],
            budget: { maxActiveBytes: 1 << 20, maxEncodedBytes: 1 << 20, maxCoefficientBytes: 1 << 20, maxOutputPixels: 6144 },
            queue: { limit: 1, run: (run: () => Promise<void>) => Promise.resolve().then(run) },
            handler: {
                send() {},
                sendWithStream(_name: string, request: { chunkIndex: number; chunkCount?: number }) {
                    return new ReadableStream({ start(controller) {
                        controller.enqueue(encodedRange(request)); controller.close();
                    } });
                },
                async sendWithPromise(_name: string, revision: any) {
                    if (revision.failed) { completed.reject(new Error(revision.message)); }
                    if (revision.final) { completed.resolve(); }
                    return true;
                },
            },
        });
        try {
            manager.add({ id: 'x1', objId: 'common-image', pageIndex: 0, epoch: 1, cacheKey: 'display',
                width: 96, height: 64, outputPixels: 6144, progressive: false, common: true,
                render: async ({ bytes }: any) => ({ width: 96, height: 64, kind: 2, data: reference(bytes, 96, 64) }),
            });
            await completed.promise;
            await Promise.allSettled(manager.tasks);
            await manager.cancelPage(0, 1);
            assert.strictEqual(manager.stats().externalImageNativeRasterBytes, 96 * 64 * 3, 'common objects belong to the document');
            await manager.clear();
            assert.strictEqual(manager.stats().externalImageNativeRasterBytes, 0);
            assert.strictEqual(manager.stats().externalImagePartialRasterBytes, 0);
            assert.strictEqual(manager.outputs.size, 0);
            assert.strictEqual(manager.closed, false, 'document cleanup permits a later native render');
        } finally { await manager.close(); }
    });

    it('finishes a page whose final native rasters exceed the partial-state budget and releases each raster owner once', async () => {
        const finished = deferred<void>();
        const ids = Array.from({ length: 10 }, (_, index) => `x${index + 1}`);
        const installed = new Map<string, number>();
        let complete = 0;
        const manager = new worker.ExternalImages({
            metadata: ids.map(id => ({ id, sha256: fixture.sha256, originalSha256: fixture.originalSha256,
                bytes: progressive.length, width: 96, height: 64, components: 3,
                coefficientBytes: 20_480, encoding: 'progressive-jpeg', chunks: fixture.chunks })),
            budget: { maxActiveBytes: 128 << 10, maxEncodedBytes: 1 << 20, maxCoefficientBytes: 1 << 20, maxOutputPixels: 6144 },
            queue: { limit: 1, run: (run: () => Promise<void>) => Promise.resolve().then(run) },
            handler: {
                send() {},
                sendWithStream(_name: string, request: { chunkIndex: number; chunkCount?: number }) {
                    return new ReadableStream({ start(controller) {
                        controller.enqueue(encodedRange(request)); controller.close();
                    } });
                },
                async sendWithPromise(_name: string, revision: any) {
                    if (revision.failed) { finished.reject(new Error(revision.message)); }
                    const previous = installed.get(revision.id);
                    installed.set(revision.id, revision.rasterId);
                    if (previous !== undefined) { manager.releaseRasters([previous]); }
                    if (revision.final && ++complete === ids.length) { finished.resolve(); }
                    return true;
                },
            },
        });
        try {
            for (const id of ids) {
                manager.add({ id, objId: id, pageIndex: 0, epoch: 1, cacheKey: 'display', width: 96, height: 64,
                    outputPixels: 37 * 25, progressive: true,
                    render: async ({ decoder: state, bytes, final }: any) => ({ width: final ? 96 : 37, height: final ? 64 : 25, kind: 2,
                        data: final ? reference(bytes, 96, 64) : state.render({ width: 37, height: 25 }) }),
                });
            }
            manager.startPage(0, 1);
            await finished.promise;
            await Promise.allSettled(manager.tasks);
            const stats = manager.stats();
            assert.strictEqual(complete, 10);
            assert.strictEqual(stats.externalImageFailed, 0);
            assert.strictEqual(stats.externalImageNativeRasterBytes, 10 * 96 * 64 * 3);
            assert.ok(stats.externalImageNativeRasterBytes > stats.externalImageBudgetBytes);
            assert.ok(stats.externalImagePeakReservedBytes <= stats.externalImageBudgetBytes);
            assert.strictEqual(stats.externalImagePartialRasterBytes, 0);
            assert.strictEqual(stats.externalImageReservedBytes, 0);
            await manager.cancelPage(0, 1);
            await manager.cancelPage(0, 1);
            assert.strictEqual(manager.stats().externalImageNativeRasterBytes, 0);
            assert.strictEqual(manager.outputs.size, 0);
        } finally { await manager.close(); }
    });
});
