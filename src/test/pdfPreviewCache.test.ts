import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Browser sources are bundled as ES modules, while the extension test runner uses CommonJS.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const MIB = 1024 * 1024;

class Parent {
    readonly children: Canvas[] = [];
    onRemove?: (canvas: Canvas) => void;
    prepend(canvas: Canvas) {
        canvas.remove();
        canvas.parentNode = this;
        this.children.unshift(canvas);
    }
}

class Canvas {
    width: number;
    height: number;
    className = '';
    readonly style = { cssText: '' };
    readonly attributes: Array<{ name: string, value: string }> = [];
    parentNode: Parent | null = null;
    removed = 0;
    failure: 'context' | 'draw' | undefined;
    readonly copies: Array<{ source: Canvas, width: number, height: number }> = [];
    readonly context = {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        drawImage: (source: Canvas, x: number, y: number, width: number, height: number) => {
            assert.ok(source.width > 0 && source.height > 0, 'copy before releasing the source bitmap');
            assert.strictEqual(x, 0);
            assert.strictEqual(y, 0);
            if (this.failure === 'draw') { throw new Error('drawImage failed'); }
            this.copies.push({ source, width, height });
        },
    };
    constructor(width = 0, height = 0) { this.width = width; this.height = height; }
    getContext(kind: string) {
        assert.strictEqual(kind, '2d');
        return this.failure === 'context' ? null : this.context;
    }
    setAttribute(name: string, value: string) {
        const existing = this.attributes.find(attribute => attribute.name === name);
        if (existing) { existing.value = value; } else { this.attributes.push({ name, value }); }
        if (name === 'width') { this.width = Number(value); }
        if (name === 'height') { this.height = Number(value); }
    }
    remove() {
        this.removed++;
        if (!this.parentNode) { return; }
        const parent = this.parentNode;
        parent.children.splice(parent.children.indexOf(this), 1);
        this.parentNode = null;
        parent.onRemove?.(this);
    }
}

describe('the shared graduated PDF preview cache', function () {
    this.timeout(30 * 1000);
    let directory: string | undefined;
    let module: any;
    const caches: any[] = [];
    const canvases: Canvas[] = [];

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-preview-cache-'));
        const output = path.join(directory, 'cache.mjs');
        try {
            await esbuild.build({ ...bundleOptions, entryPoints: [path.join(viewerRoot, 'src', 'common', 'pdf-preview-cache.ts')], outfile: output });
        } finally { await esbuild.stop(); }
        module = await importModule(output);
    });

    afterEach(() => {
        for (const cache of caches.splice(0)) {
            cache.clear();
            cache.clear();
            assert.strictEqual(cache.size, 0);
            assert.strictEqual(cache.bytes, 0);
        }
        for (const canvas of canvases.splice(0)) {
            assert.strictEqual(canvas.width * canvas.height, 0, 'every owned canvas releases its bitmap on clear, eviction or failed admission');
            assert.strictEqual(canvas.parentNode, null);
        }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    function canvas(width = 384, height = 512) {
        const result = new Canvas(width, height);
        canvases.push(result);
        return result;
    }

    function cache(options: Record<string, unknown> = {}) {
        const result = new module.PdfPreviewCache({
            maxBytes: 8 * MIB, maxPages: 128, trailMaxDimension: 192,
            createCanvas: () => canvas(0, 0), ...options,
        });
        caches.push(result);
        return result;
    }

    function balanced(value: any, maximum: number) {
        assert.strictEqual(value.bytes, [...value].reduce((sum: number, [, entry]: [number, any]) => sum + entry.canvas.width * entry.canvas.height * 4, 0));
        assert.ok(value.bytes <= maximum, 'retained bytes stay within the configured budget');
    }

    it('preserves clipped and rotated raster coverage through trail downsizing and rejected replacement', () => {
        for (const matrix of [[399.1184, 0, 0, 566.9288, 0, 0], [0, -566.9288, 399.1184, 0, 0, 566.9288]]) {
            const value = cache({ maxBytes: MIB });
            const original = canvas(396, 564);
            const projection = { width: 396, height: 564, pageToRaster: matrix };
            assert.strictEqual(value.retain(1, original, new Set(), projection, 7), true);
            assert.deepStrictEqual(value.get(1).projection, projection, 'retention keeps the producer mapping');
            assert.strictEqual(value.retain(2, canvas(), new Set([2])), true);
            const trail = value.get(1);
            assert.strictEqual(trail.contentRevision, 7, 'trail resampling preserves the native content revision');
            assert.deepStrictEqual([trail.canvas.width, trail.canvas.height], [135, 192]);
            assert.deepStrictEqual(trail.projection.pageToRaster, matrix.map((component, index) =>
                component * (index % 2 === 0 ? 135 / 396 : 192 / 564)));
            assert.deepStrictEqual([trail.projection.width, trail.projection.height], [135, 192]);
            assert.strictEqual(original.width, 0, 'the former backing is released after its mapping is rescaled');
            const retained = trail.projection;
            assert.strictEqual(value.retain(1, canvas(512, 512), new Set([1, 2]),
                { width: 512, height: 512, pageToRaster: [512, 0, 0, 512, 0, 0] }), false);
            assert.strictEqual(value.get(1).projection, retained, 'failed replacement preserves the previous projection');
            assert.strictEqual(value.get(1).contentRevision, 7);
            balanced(value, MIB);
        }
    });

    it('retains the 60 to 90 page trail for a revisit while six prepared pages keep full quality under 8 MiB', () => {
        const value = cache();
        const originals = new Map<number, Canvas>();
        for (let page = 60; page <= 90; page++) {
            const protectedIds = new Set<number>();
            for (let id = Math.max(60, page - 5); id <= page; id++) { protectedIds.add(id); }
            const image = canvas();
            originals.set(page, image);
            assert.strictEqual(value.retain(page, image, protectedIds), true);
            balanced(value, 8 * MIB);
            for (const id of protectedIds) { assert.strictEqual(value.get(id).canvas.height, 512); }
        }
        assert.strictEqual(value.size, 31, 'a thirty-page return trip keeps every visited placeholder');
        assert.deepStrictEqual([...value.keys()], Array.from({ length: 31 }, (_, index) => 60 + index));
        const old65 = value.get(65).canvas as Canvas;
        assert.deepStrictEqual([old65.width, old65.height], [144, 192]);
        assert.strictEqual(originals.get(65)!.width, 0, 'downsampling releases the large old bitmap');
        assert.deepStrictEqual(old65.copies.map(copy => [copy.width, copy.height]), [[144, 192]]);
        value.touch(65);
        const upgrade = canvas();
        assert.strictEqual(value.retain(65, upgrade, new Set([65, 66, 67, 68, 69, 70])), true);
        assert.strictEqual(value.get(65).canvas, upgrade);
        assert.strictEqual(old65.width, 0);
        assert.strictEqual(value.size, 31);
        balanced(value, 8 * MIB);
    });

    it('keeps attached and prepared rasters intact while reducing older detached pages', () => {
        const maximum = 4 * 384 * 512 * 4;
        const value = cache({ maxBytes: maximum });
        const source = [canvas(), canvas(), canvas(), canvas()];
        source.forEach((image, index) => assert.strictEqual(value.retain(index + 1, image, new Set()), true));
        const parent = new Parent();
        parent.prepend(source[0]);
        assert.strictEqual(value.retain(5, canvas(), new Set([2])), true);
        assert.strictEqual(value.size, 5);
        assert.strictEqual(value.get(1).canvas, source[0], 'attachment protects a visible raster even if its ID is omitted');
        assert.strictEqual(source[0].parentNode, parent);
        assert.strictEqual(value.get(2).canvas, source[1]);
        assert.strictEqual(source[1].height, 512);
        assert.strictEqual(value.get(3).canvas.height, 192);
        assert.strictEqual(value.get(4).canvas.height, 192);
        assert.strictEqual(source[2].width + source[3].width, 0);
        balanced(value, maximum);
    });

    it('replaces an attached preview without losing coverage or copying old bitmap dimensions', () => {
        const value = cache();
        const old = canvas(144, 192);
        old.className = 'pdfPrefetchPreview';
        old.style.cssText = 'position:absolute;inset:0';
        old.setAttribute('aria-hidden', 'true');
        old.setAttribute('width', '144');
        old.setAttribute('height', '192');
        value.retain(65, old, new Set([65]));
        const parent = new Parent();
        parent.prepend(old);
        const replacement = canvas();
        let checkedCoverage = false;
        parent.onRemove = removed => {
            if (removed !== old) { return; }
            checkedCoverage = true;
            assert.ok(parent.children.includes(replacement), 'the new raster is attached before the previous node is removed');
            assert.ok(replacement.width > 0 && replacement.height > 0);
        };
        assert.strictEqual(value.retain(65, replacement, new Set([65])), true);
        assert.strictEqual(checkedCoverage, true);
        assert.deepStrictEqual(parent.children, [replacement]);
        assert.deepStrictEqual([replacement.width, replacement.height], [384, 512]);
        assert.strictEqual(replacement.className, old.className);
        assert.strictEqual(replacement.style.cssText, old.style.cssText);
        assert.deepStrictEqual(replacement.attributes, [{ name: 'aria-hidden', value: 'true' }]);
        assert.strictEqual(old.width * old.height, 0);
        balanced(value, 8 * MIB);
        value.clear();
        assert.strictEqual(parent.children.length, 0);
    });

    it('rejects an impossible protected replacement without damaging its previous attached placeholder', () => {
        let reductions = 0;
        const value = cache({ maxBytes: MIB, createCanvas: () => { reductions++; return canvas(0, 0); } });
        const old = canvas(144, 192);
        value.retain(1, old, new Set());
        value.retain(2, canvas(), new Set());
        const parent = new Parent();
        parent.prepend(old);
        const incoming = canvas();
        assert.strictEqual(value.retain(1, incoming, new Set([1, 2])), false);
        assert.strictEqual(incoming.width * incoming.height, 0);
        assert.strictEqual(value.get(1).canvas, old);
        assert.strictEqual(old.parentNode, parent);
        assert.strictEqual(old.height, 192);
        assert.strictEqual(value.get(2).canvas.height, 512);
        assert.strictEqual(value.size, 2);
        assert.strictEqual(reductions, 0);
        balanced(value, MIB);
    });

    it('enforces the page cap using visit order after a touched preview is revisited', () => {
        const value = cache({ maxPages: 3 });
        const images = [canvas(), canvas(), canvas()];
        images.forEach((image, index) => value.retain(index + 1, image, new Set()));
        value.touch(1);
        value.retain(4, canvas(), new Set());
        assert.deepStrictEqual([...value.keys()], [3, 1, 4]);
        assert.strictEqual(images[1].width, 0);
        assert.strictEqual(images[0].height, 512);
        assert.strictEqual(value.has(2), false);
        value.remove(3);
        assert.strictEqual(images[2].width, 0);
        balanced(value, 8 * MIB);
    });

    it('preserves desktop raster quality and evicts at its byte cap without creating smaller canvases', () => {
        const rasterBytes = 768 * 768 * 4;
        let reductions = 0;
        const value = cache({ maxBytes: 2 * rasterBytes, trailMaxDimension: 768, createCanvas: () => { reductions++; return canvas(0, 0); } });
        const images = [canvas(768, 768), canvas(768, 768), canvas(768, 768)];
        images.forEach((image, index) => value.retain(index + 1, image, new Set()));
        assert.deepStrictEqual([...value.keys()], [2, 3]);
        assert.strictEqual(value.bytes, 2 * rasterBytes);
        assert.strictEqual(images[0].width, 0);
        assert.strictEqual(images[1].height, 768);
        assert.strictEqual(images[2].height, 768);
        assert.strictEqual(reductions, 0);
    });

    it('releases failed downsample canvases and still enforces the byte budget by eviction', () => {
        for (const failure of ['context', 'draw'] as const) {
            const maximum = 384 * 512 * 4;
            let failed: Canvas | undefined;
            const value = cache({
                maxBytes: maximum,
                createCanvas: () => { failed = canvas(0, 0); failed.failure = failure; return failed; },
            });
            const old = canvas();
            value.retain(1, old, new Set());
            const next = canvas();
            assert.strictEqual(value.retain(2, next, new Set()), true);
            assert.strictEqual(failed!.width * failed!.height, 0);
            assert.strictEqual(old.width, 0);
            assert.strictEqual(value.get(2).canvas, next);
            assert.strictEqual(value.size, 1);
            balanced(value, maximum);
        }
    });
});
