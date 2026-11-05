import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
interface Rect { x: number; y: number; width: number; height: number }
type Matrix = readonly [number, number, number, number, number, number];
interface Raster { width: number; height: number; pageToRaster: Matrix }
interface Page { content: Rect; clip: Rect }
interface Crop { logical: Rect; source: Rect; pixels: Rect; sampled: Rect }
interface Projection {
    createPdfRasterProjection(width: number, height: number, contentWidth?: number, contentHeight?: number): Raster;
    resizePdfRasterProjection(raster: Raster, width: number, height: number): Raster;
    rotatePdfRasterProjection(raster: Raster, degrees: number): Raster;
    reorientPdfRasterProjection(raster: Raster, degrees: number): Raster;
    projectPdfRasterCrop(raster: Raster, logical: Rect, pixelMargin?: number): Crop | undefined;
    pdfRasterCropSize(raster: Raster, logical: Rect): { width: number; height: number };
    pdfRasterToCrop(raster: Raster, logical: Rect, width: number, height: number): Matrix;
    projectPdfPageRect(page: Page, logical: Rect): Rect;
    clipPdfPageRect(page: Page, css: Rect): Rect | undefined;
    pdfRasterToCss(raster: Raster, page: Page): Matrix;
    pdfRasterPageClip(raster: Raster, page: Page): Rect | undefined;
    pdfPageFromRaster(raster: Raster, displayed: Rect, clip: Rect): Page;
}

const unit: Rect = { x: 0, y: 0, width: 1, height: 1 };
const point = (m: Matrix, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function close(actual: number, expected: number, label = '') {
    assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
}
function rectClose(actual: Rect, expected: Rect) {
    for (const key of ['x', 'y', 'width', 'height'] as const) { close(actual[key], expected[key], key); }
}
function pointClose(actual: number[], expected: number[]) {
    close(actual[0], expected[0], 'x'); close(actual[1], expected[1], 'y');
}

describe('PDF raster and logical page projection', function () {
    this.timeout(30_000);
    let dir: string, api: Projection;
    const logicalWidth = 332.59866666666665, logicalHeight = 472.44066666666663;
    const clip: Rect = { x: 0, y: 0, width: 330, height: 470 };
    const page: Page = { content: { x: 0, y: 0, width: logicalWidth, height: logicalHeight }, clip };
    const native = () => api.createPdfRasterProjection(396, 564, logicalWidth * 1.2, logicalHeight * 1.2);

    before(async () => {
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-raster-projection-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/pdf-raster-projection.ts')],
                outfile: path.join(dir, 'projection.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
        } finally { await esbuild.stop(); }
        api = await importModule(path.join(dir, 'projection.mjs'));
    });
    after(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); } });

    it('maps the saved DPR 1.2 native clip and full atlas to the same logical photo coordinates', () => {
        const captured = native(), atlas = api.createPdfRasterProjection(541, 768);
        const nativeCss = api.pdfRasterToCss(captured, page), atlasCss = api.pdfRasterToCss(atlas, page);
        pointClose(point(nativeCss, 396, 564), [330, 470]);
        pointClose(point(atlasCss, 541, 768), [logicalWidth, logicalHeight]);
        const location = [0.8, 0.6];
        const nativePixel = point(captured.pageToRaster, location[0], location[1]);
        const atlasPixel = point(atlas.pageToRaster, location[0], location[1]);
        pointClose(point(nativeCss, nativePixel[0], nativePixel[1]), point(atlasCss, atlasPixel[0], atlasPixel[1]));
        assert.ok(Math.abs(location[0] * clip.width - location[0] * logicalWidth) > 2, 'old 100% sizing would shift this photo');
    });

    it('keeps full atlas, ceil-padded direct preview, and clipped native coverage distinct', () => {
        const atlas = api.projectPdfRasterCrop(api.createPdfRasterProjection(541, 768), unit)!;
        const preview = api.projectPdfRasterCrop(api.createPdfRasterProjection(333, 473, logicalWidth, logicalHeight), unit)!;
        const captured = api.projectPdfRasterCrop(native(), unit)!;
        rectClose(atlas.sampled, unit);
        assert.ok(preview.sampled.width > 1 && preview.sampled.height > 1);
        assert.ok(captured.logical.width < 1 && captured.logical.height < 1);
        close(captured.logical.width, 330 / logicalWidth);
        close(captured.logical.height, 470 / logicalHeight);
        rectClose(captured.pixels, { x: 0, y: 0, width: 396, height: 564 });
    });

    it('preserves the native clipped footprint through independently rounded cache axes', () => {
        const original = native(), resized = api.resizePdfRasterProjection(original, 135, 192);
        rectClose(api.projectPdfRasterCrop(resized, unit)!.logical, api.projectPdfRasterCrop(original, unit)!.logical);
        const transform = api.pdfRasterToCss(resized, page);
        pointClose(point(transform, 135, 192), [330, 470]);
        assert.notStrictEqual(135 / 396, 192 / 564, 'fixture exercises unequal per-axis resampling');
        assert.deepStrictEqual([original.width, original.height], [396, 564]);
    });

    it('preserves ceil padding through cache demotion without reclassifying it as full-page content', () => {
        const original = api.createPdfRasterProjection(136, 193, 135.2, 192.001);
        const reduced = api.resizePdfRasterProjection(original, 67, 96);
        const originalSize = api.pdfRasterCropSize(original, unit), reducedSize = api.pdfRasterCropSize(reduced, unit);
        close(reducedSize.width, originalSize.width * 67 / 136);
        close(reducedSize.height, originalSize.height * 96 / 193);
        assert.ok(reducedSize.width < reduced.width && reducedSize.height < reduced.height);
    });

    it('rounds crop endpoints outward instead of separately rounding an origin and extent', () => {
        const raster = api.createPdfRasterProjection(100, 200);
        const crop = api.projectPdfRasterCrop(raster, { x: 0.109, y: 0.204, width: 0.012, height: 0.012 })!;
        rectClose(crop.source, { x: 10.9, y: 40.8, width: 1.2, height: 2.4 });
        assert.deepStrictEqual(crop.pixels, { x: 10, y: 40, width: 3, height: 4 });
        rectClose(crop.sampled, { x: 0.1, y: 0.2, width: 0.03, height: 0.02 });
    });

    it('does not read an extra pixel for floating arithmetic noise at an integral edge', () => {
        const crop = api.projectPdfRasterCrop(api.createPdfRasterProjection(10, 10), { x: 0.1 + 0.2, y: 0.1, width: 0.1, height: 0.2 })!;
        assert.deepStrictEqual(crop.pixels, { x: 3, y: 1, width: 1, height: 2 });
        const fractional = api.projectPdfRasterCrop(api.createPdfRasterProjection(10, 10), { x: 0.3, y: 0.1, width: 0.10000001, height: 0.2 })!;
        assert.strictEqual(fractional.pixels.width, 2, 'a real fractional edge still requires the next sample');
    });

    it('includes the measured outside atlas texel without changing the exact photo or ordinary cargo read', () => {
        const raster = api.createPdfRasterProjection(360, 512);
        for (const y of [0.14090420630897255, 0.689918490716582]) {
            const photo = { x: 0.1755328669326745, y, width: 0.315806107087826, height: 0.1250593633356536 };
            const cargo = api.projectPdfRasterCrop(raster, photo)!;
            const cover = api.projectPdfRasterCrop(raster, photo, 1)!;
            assert.strictEqual(cargo.pixels.x + cargo.pixels.width, 177);
            assert.strictEqual(cover.pixels.x + cover.pixels.width, 178,
                'atlas column 177 contains the dark fringe visible at phone screen column 595');
            assert.strictEqual(cover.pixels.x, 62);
            assert.strictEqual(cover.pixels.y, cargo.pixels.y - 1);
            assert.strictEqual(cover.pixels.height, cargo.pixels.height + 2);
            rectClose(cover.logical, cargo.logical); rectClose(cover.source, cargo.source);
            assert.deepStrictEqual(api.projectPdfRasterCrop(raster, photo), cargo,
                'the optional cover footprint does not alter an ordinary source read');
        }
    });

    it('maps the source-texel margin through lower and higher tiers and retained quarter-turns', () => {
        const photo = { x: 0.1755328669326745, y: 0.689918490716582,
            width: 0.315806107087826, height: 0.1250593633356536 };
        for (const [width, height] of [[135, 192], [360, 512], [541, 768], [1081, 1536]]) {
            const original = api.createPdfRasterProjection(width, height);
            for (const degrees of [0, 90, 180, 270]) {
                const target = degrees === 90 ? { x: 1 - photo.y - photo.height, y: photo.x, width: photo.height, height: photo.width }
                    : degrees === 180 ? { x: 1 - photo.x - photo.width, y: 1 - photo.y - photo.height, width: photo.width, height: photo.height }
                        : degrees === 270 ? { x: photo.y, y: 1 - photo.x - photo.width, width: photo.height, height: photo.width } : photo;
                const raster = api.reorientPdfRasterProjection(original, degrees);
                const cargo = api.projectPdfRasterCrop(raster, target)!, cover = api.projectPdfRasterCrop(raster, target, 1)!;
                rectClose(cover.source, cargo.source); rectClose(cover.logical, cargo.logical);
                const horizontal = 1 / (degrees % 180 ? height : width), vertical = 1 / (degrees % 180 ? width : height);
                close(cargo.sampled.x - cover.sampled.x, horizontal);
                close(cargo.sampled.y - cover.sampled.y, vertical);
                close(cover.sampled.width - cargo.sampled.width, horizontal * 2);
                close(cover.sampled.height - cargo.sampled.height, vertical * 2);
            }
        }
    });

    it('clips a margin to available backing pixels before mapping native leading-edge coverage', () => {
        const original = api.createPdfRasterProjection(100, 200, 100.5, 200.75);
        const raster = api.reorientPdfRasterProjection(original, 90);
        const target = { x: 0.004, y: 0, width: 0.2, height: 0.2 };
        const cargo = api.projectPdfRasterCrop(raster, target)!, cover = api.projectPdfRasterCrop(raster, target, 1)!;
        assert.strictEqual(cover.pixels.x, 0);
        assert.strictEqual(cover.pixels.y + cover.pixels.height, 200);
        assert.strictEqual(cover.pixels.width, cargo.pixels.width + 1);
        rectClose(cover.logical, cargo.logical); rectClose(cover.source, cargo.source);
        const displayed = { x: 0, y: 0, width: 200, height: 100 };
        const page = api.pdfPageFromRaster(raster, displayed, displayed);
        const mask = api.clipPdfPageRect(page, api.projectPdfPageRect(page, cover.sampled))!;
        assert.ok(mask.x >= 0 && mask.y >= 0 && mask.x + mask.width <= 200 && mask.y + mask.height <= 100);
        assert.strictEqual(api.projectPdfRasterCrop(original, { x: 0.999, y: 0.999, width: 0.001, height: 0.001 }, 1), undefined,
            'a margin cannot create photo coverage where the native backing has no pixels');
    });

    it('keeps an edge-clipped native crop at its actual footprint instead of stretching it to the target', () => {
        const raster = native(), target = { x: 0.98, y: 0.98, width: 0.02, height: 0.02 };
        const crop = api.projectPdfRasterCrop(raster, target)!;
        const transform = api.pdfRasterToCrop(raster, target, 100, 100);
        pointClose(point(transform, crop.source.x, crop.source.y), [0, 0]);
        const end = point(transform, 396, 564);
        assert.ok(end[0] > 0 && end[0] < 100 && end[1] > 0 && end[1] < 100);
        close(end[0], crop.logical.width / target.width * 100);
        close(end[1], crop.logical.height / target.height * 100);
        assert.strictEqual(crop.pixels.x + crop.pixels.width, 396);
        assert.strictEqual(crop.pixels.y + crop.pixels.height, 564);
    });

    it('keeps exact crop geometry across coarse and sharp source sampling', () => {
        const target = { x: 0.107, y: 0.213, width: 0.317, height: 0.249 };
        for (const raster of [api.createPdfRasterProjection(135, 192), api.createPdfRasterProjection(541, 768), native()]) {
            const crop = api.projectPdfRasterCrop(raster, target)!;
            const transform = api.pdfRasterToCrop(raster, target, 211, 127);
            pointClose(point(transform, crop.source.x, crop.source.y), [0, 0]);
            pointClose(point(transform, crop.source.x + crop.source.width, crop.source.y + crop.source.height), [211, 127]);
            const outwardStart = point(transform, crop.pixels.x, crop.pixels.y);
            assert.ok(outwardStart[0] <= 1e-9 && outwardStart[1] <= 1e-9);
        }
    });

    it('rounds a cover on the displayed native pixel grid and clips it to the inner page', () => {
        const target = { x: 0.249, y: 0.201, width: 0.7, height: 0.8 };
        const exact = api.projectPdfPageRect(page, target);
        const sampled = api.projectPdfRasterCrop(native(), target)!;
        const cover = api.clipPdfPageRect(page, api.projectPdfPageRect(page, sampled.sampled))!;
        assert.ok(cover.x <= exact.x && cover.y <= exact.y);
        close(cover.x * 1.2, sampled.pixels.x);
        close(cover.y * 1.2, sampled.pixels.y);
        close(cover.y + cover.height, 470);
        assert.ok(cover.x + cover.width >= exact.x + exact.width);
    });

    it('reconstructs unrounded native CSS content from the saved backing display rectangle', () => {
        const reconstructed = api.pdfPageFromRaster(native(), clip, clip);
        rectClose(reconstructed.content, page.content);
        rectClose(reconstructed.clip, page.clip);
    });

    it('retains original backing coverage through CSS-only zoom instead of using a new viewport', () => {
        const resizedClip = { x: 9, y: 9, width: 672, height: 954 };
        const reconstructed = api.pdfPageFromRaster(native(), resizedClip, resizedClip);
        close(reconstructed.content.x, 9); close(reconstructed.content.y, 9);
        close(reconstructed.content.width, logicalWidth * 672 / 330);
        close(reconstructed.content.height, logicalHeight * 954 / 470);
        pointClose(point(api.pdfRasterToCss(native(), reconstructed), 396, 564), [681, 963]);
    });

    it('clips only the direct-child atlas, preserving native clipping and excluding a page border', () => {
        const bordered: Page = { content: { ...page.content, x: 9, y: 9 }, clip: { ...clip, x: 9, y: 9 } };
        const atlas = api.createPdfRasterProjection(541, 768);
        const atlasClip = api.pdfRasterPageClip(atlas, bordered)!;
        rectClose(atlasClip, { x: 0, y: 0, width: 541 * 330 / logicalWidth, height: 768 * 470 / logicalHeight });
        rectClose(api.pdfRasterPageClip(native(), bordered)!, { x: 0, y: 0, width: 396, height: 564 });
        pointClose(point(api.pdfRasterToCss(atlas, bordered), 0, 0), [9, 9]);
    });

    for (const degrees of [90, 180, 270]) {
        it(`moves native clipped coverage to the correct edge after ${degrees} degree physical and logical rotation`, () => {
            const original = api.createPdfRasterProjection(100, 200, 100.5, 200.75);
            const rotated = api.reorientPdfRasterProjection(api.rotatePdfRasterProjection(original, degrees), degrees);
            const crop = api.projectPdfRasterCrop(rotated, unit)!;
            const left = degrees === 90 || degrees === 180;
            const top = degrees === 180 || degrees === 270;
            close(crop.logical.x, left ? (degrees === 90 ? 0.75 / 200.75 : 0.5 / 100.5) : 0);
            close(crop.logical.y, top ? (degrees === 180 ? 0.75 / 200.75 : 0.5 / 100.5) : 0);
            assert.strictEqual(crop.pixels.width, rotated.width);
            assert.strictEqual(crop.pixels.height, rotated.height);
            const smaller = api.resizePdfRasterProjection(rotated, Math.ceil(rotated.width / 3), Math.ceil(rotated.height / 3));
            rectClose(api.projectPdfRasterCrop(smaller, unit)!.logical, crop.logical);
        });
    }

    it('moves ceil padding to the leading edge rather than treating it as image content', () => {
        const padded = api.createPdfRasterProjection(101, 201, 100.5, 200.75);
        const rotated = api.reorientPdfRasterProjection(api.rotatePdfRasterProjection(padded, 90), 90);
        const crop = api.projectPdfRasterCrop(rotated, unit)!;
        close(crop.source.x, 0.25);
        close(crop.source.y, 0);
        rectClose(crop.logical, unit);
        assert.ok(crop.sampled.x < 0, 'outward integer read retains fractional leading coverage');
        const aligned = api.pdfRasterToCrop(rotated, unit, 400, 200);
        pointClose(point(aligned, 0.25, 0), [0, 0]);
    });

    it('samples a CSS-rotated retained native raster without rotating a second full-page canvas', () => {
        const retained = api.reorientPdfRasterProjection(api.createPdfRasterProjection(100, 200, 100.5, 200.75), 90);
        const target = { x: 0.2, y: 0.3, width: 0.4, height: 0.2 };
        const size = api.pdfRasterCropSize(retained, target);
        close(size.width, 200.75 * 0.4); close(size.height, 100.5 * 0.2);
        const transform = api.pdfRasterToCrop(retained, target, 160, 40);
        for (const [u, v, x, y] of [[0.2, 0.3, 0, 0], [0.6, 0.3, 160, 0], [0.2, 0.5, 0, 40], [0.6, 0.5, 160, 40]]) {
            const source = point(retained.pageToRaster, u, v);
            pointClose(point(transform, source[0], source[1]), [x, y]);
        }
        const displayed = { x: 0, y: 0, width: 200, height: 100 };
        const reconstructed = api.pdfPageFromRaster(retained, displayed, displayed);
        close(reconstructed.content.x, -0.75);
        close(reconstructed.content.y, 0);
        close(reconstructed.content.width, 200.75);
        close(reconstructed.content.height, 100.5);
        rectClose(api.pdfRasterPageClip(retained, reconstructed)!, { x: 0, y: 0, width: 100, height: 200 });
    });

    it('returns to the same projection after four quarter-turns and accepts equivalent signed turns', () => {
        const original = native();
        let rotated = original;
        for (let index = 0; index < 4; index++) {
            rotated = api.reorientPdfRasterProjection(api.rotatePdfRasterProjection(rotated, 90), 90);
        }
        rotated.pageToRaster.forEach((value, index) => close(value, original.pageToRaster[index]));
        const negative = api.rotatePdfRasterProjection(original, -90), positive = api.rotatePdfRasterProjection(original, 270);
        assert.deepStrictEqual(negative, positive);
    });

    it('rejects empty or unavailable crops and invalid producer geometry', () => {
        const raster = native();
        assert.strictEqual(api.projectPdfRasterCrop(raster, { x: 0.999, y: 0.999, width: 0.001, height: 0.001 }), undefined);
        assert.strictEqual(api.projectPdfRasterCrop(raster, { x: -1, y: 0, width: 0.1, height: 0.1 }), undefined);
        assert.strictEqual(api.projectPdfRasterCrop(raster, { x: 0, y: 0, width: NaN, height: 0.1 }), undefined);
        assert.strictEqual(api.clipPdfPageRect(page, { x: 400, y: 0, width: 1, height: 1 }), undefined);
        assert.throws(() => api.createPdfRasterProjection(0, 1), RangeError);
        assert.throws(() => api.createPdfRasterProjection(1.5, 1), RangeError);
        assert.throws(() => api.createPdfRasterProjection(1, 1, Infinity, 1), RangeError);
        assert.throws(() => api.rotatePdfRasterProjection(raster, 45), RangeError);
    });
});
