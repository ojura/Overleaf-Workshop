import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('Robot screen scale and readable captions', function () {
    this.timeout(30_000);
    let directory: string, api: any;

    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-robot-screen-scale-'));
        try {
            await esbuild.build({
                entryPoints: { scale: path.join(repo, 'views/pdf-viewer/src/common/robot-screen-scale.ts'),
                    raster: path.join(repo, 'views/pdf-viewer/src/common/robot-raster-sizing.ts') },
                outdir: directory, outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', // eslint-disable-line @typescript-eslint/naming-convention
                platform: 'node', target: 'es2022', logLevel: 'silent',
            });
        } finally { await esbuild.stop(); }
        api = { ...await importModule(path.join(directory, 'scale.mjs')), ...await importModule(path.join(directory, 'raster.mjs')) };
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    function near(actual: number, expected: number): void {
        assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${actual} differs from ${expected}`);
    }

    function screen(devicePixelRatio = 1, width = 1000, height = 800): any {
        return api.robotScreenMetrics({ width, height, devicePixelRatio });
    }

    it('grows a fixed artwork size by the square root of DPR in physical pixels', () => {
        const one = screen(1), two = screen(2), four = screen(4);
        near(100 * one.cssScale, 100);
        near(100 * two.cssScale * 2, 141.4213562373095);
        near(100 * four.cssScale * 4, 200);
        assert.ok(two.cssScale < one.cssScale);
        assert.ok(100 * two.cssScale * 2 < 100 * 2);
    });

    it('funds unequal logical bodies together under a constrained sprite budget', () => {
        for (const dpr of [1, 1.2, 2, 3]) {
            const scale = 0.64 * 1.35 * screen(dpr).cssScale;
            const shapes = Object.freeze([Object.freeze({ width: 128, height: 100, scale: scale * 2.5 }),
                Object.freeze({ width: 128, height: 100, scale })]);
            const plan = api.robotSpriteRasterPlan(shapes, dpr, 204800);
            assert.ok(plan, 'the complete two-member crew fits through backing density');
            assert.strictEqual(plan.sprites.length, 2);
            assert.ok(plan.density > 0 && plan.density <= dpr);
            assert.strictEqual(plan.bytes, plan.sprites.reduce((sum: number, value: any) => sum + value.width * value.height * 4, 0));
            assert.ok(plan.bytes <= 204800);
            for (const [index, value] of plan.sprites.entries()) {
                assert.strictEqual(value.width, Math.ceil(shapes[index].width * value.detail));
                assert.strictEqual(value.height, Math.ceil(shapes[index].height * value.detail));
                near(value.density, value.detail / shapes[index].scale);
                assert.ok(value.detail >= Math.min(1, shapes[index].scale * dpr));
            }
            near(shapes[0].scale / shapes[1].scale, 2.5);
            if (dpr === 1) { assert.ok(plan.density < 1, 'logical size survives low-DPR byte pressure too'); }
            if (dpr === 3) {
                near(plan.density, 1.2);
                assert.strictEqual(plan.bytes, 166400, 'ceil-rounded crew bytes preserve the companion detail floor');
            }
        }
    });

    it('uses the actual remaining bytes and rejects a rounded crew below the authored detail floor', () => {
        const shapes = [{ width: 100.1, height: 80.1, scale: 2.5 }, { width: 40.1, height: 30.1, scale: 1 }];
        const detail = api.ROBOT_RASTER_LIMITS.minSpriteDetail;
        assert.strictEqual(detail, 1);
        const minimum = shapes.reduce((sum, value) => sum + Math.ceil(value.width * detail) * Math.ceil(value.height * detail) * 4, 0);
        const plan = api.robotSpriteRasterPlan(shapes, 3, minimum);
        assert.ok(plan);
        assert.strictEqual(plan.bytes, minimum);
        assert.ok(plan.sprites.every((value: any) => value.detail === detail));
        assert.strictEqual(api.robotSpriteRasterPlan(shapes, 3, minimum - 1), undefined);
        const available = 204800 - 160000;
        const shared = api.robotSpriteRasterPlan(shapes, 3, available);
        assert.ok(shared && shared.bytes <= available);
        const reversed = api.robotSpriteRasterPlan([...shapes].reverse(), 3, available);
        assert.strictEqual(reversed.density, shared.density, 'member order does not buy a different joint allocation');
        assert.deepStrictEqual(reversed.sprites, [...shared.sprites].reverse());
    });

    it('keeps requested raster density when it fits and validates every bounded backing input', () => {
        const shape = [{ width: 17.3, height: 11.7, scale: 1 }];
        const plan = api.robotSpriteRasterPlan(shape, 1.25, 204800);
        assert.strictEqual(plan.density, 1.25);
        assert.strictEqual(plan.limited, false);
        for (const value of [0, -1, NaN, Infinity]) {
            assert.strictEqual(api.robotSpriteRasterPlan([{ width: value, height: 10, scale: 1 }], 1, 204800), undefined);
            assert.strictEqual(api.robotSpriteRasterPlan([{ width: 10, height: 10, scale: value }], 1, 204800), undefined);
            assert.strictEqual(api.robotSpriteRasterPlan(shape, value, 204800), undefined);
            assert.strictEqual(api.robotSpriteRasterPlan(shape, 1, value), undefined);
        }
        assert.strictEqual(api.robotSpriteRasterPlan([{ width: 100000, height: 10, scale: 1 }], 3, 100000000), undefined);
    });

    it('reaches every member detail floor together without upsampling naturally small full-resolution bodies', () => {
        const shapes = [120, 2.5, 1, 0.5].map(scale => ({ width: 128, height: 100, scale }));
        const plan = api.robotSpriteRasterPlan(shapes, 3, 204800);
        assert.ok(plan);
        assert.strictEqual(plan.bytes, 204800);
        assert.strictEqual(plan.density, 0, 'the exact terminal floor remains reachable between quantized density steps');
        assert.ok(plan.sprites.every((value: any) => value.width === 128 && value.height === 100 && value.detail === 1));
        assert.strictEqual(api.robotSpriteRasterPlan(shapes, 3, 204799), undefined, 'one existing owner can exhaust the complete crew floor');
        const small = api.robotSpriteRasterPlan([{ width: 128, height: 100, scale: 0.3 }], 3, 51200);
        assert.deepStrictEqual([small.sprites[0].width, small.sprites[0].height], [116, 90]);
        assert.ok(small.sprites[0].detail < 1 && small.density === 3, 'naturally smaller full-DPR detail remains sufficient');
    });

    it('accounts for each ordered Lab body cache without enlarging the ordinary bodies', () => {
        const shape = Object.freeze({ width: 480, height: 250, bodyWidth: 128, bodyHeight: 100, bodyCount: 3,
            bodyScales: Object.freeze([1, 2.5, 1]) });
        const input = { width: 480, height: 250, devicePixelRatio: 2, bodyScale: 1 };
        const plan = api.robotRasterPlan(shape, input);
        assert.strictEqual(plan.bytes, 5529600, 'the larger individual backing belongs in the joint allocation');
        assert.deepStrictEqual(plan.bodyRasters, [
            { width: 256, height: 200, density: 2 },
            { width: 640, height: 500, density: 5 },
            { width: 256, height: 200, density: 2 },
        ]);
        assert.deepStrictEqual([plan.bodyWidth, plan.bodyHeight, plan.bodyDensity], [256, 200, 2]);
        const uniform = api.robotRasterPlan({ ...shape, bodyScales: undefined }, input);
        assert.strictEqual(uniform.bytes, 4454400, 'the legacy uniform allocation is unchanged');
        assert.deepStrictEqual(uniform.bodyRasters, Array(3).fill({ width: 256, height: 200, density: 2 }));
        const sparse = api.robotRasterPlan({ ...shape, bodyScales: [2.5] }, input);
        assert.deepStrictEqual(sparse.bodyRasters, [plan.bodyRasters[1], plan.bodyRasters[0], plan.bodyRasters[2]]);
    });

    it('bounds the mixed Lab raster cohort using actual rounded backing bytes', () => {
        const shape = { width: 480, height: 250, bodyWidth: 128, bodyHeight: 100, bodyCount: 10,
            bodyScales: [1, 2.5, ...Array(8).fill(1)] };
        const plan = api.robotRasterPlan(shape, { width: 3840, height: 2000, devicePixelRatio: 4, bodyScale: 1 });
        near(plan.density, 6.2);
        assert.strictEqual(plan.bytes, 67085760, 'the enlarged rounded cache lowers the affordable stage density');
        assert.strictEqual(plan.limited, true);
        assert.deepStrictEqual([plan.width, plan.height], [2976, 1550]);
        assert.deepStrictEqual(plan.bodyRasters[1], { width: 1997, height: 1560, density: 15.6 });
        const actual = (2 * plan.width * plan.height
            + plan.bodyRasters.reduce((sum: number, body: any) => sum + body.width * body.height, 0)) * 4;
        assert.strictEqual(plan.bytes, actual);
        assert.ok(actual <= api.ROBOT_RASTER_LIMITS.maxBytes);
        for (const body of [plan, ...plan.bodyRasters]) {
            assert.ok(body.width <= api.ROBOT_RASTER_LIMITS.maxDimension && body.height <= api.ROBOT_RASTER_LIMITS.maxDimension);
        }
    });

    it('retains sufficient Lab cache sizes only while every ordered member remains valid', () => {
        const base = { width: 480, height: 250, bodyWidth: 128, bodyHeight: 100, bodyCount: 3 };
        const input = { width: 1920, height: 1000, devicePixelRatio: 1, bodyScale: 1 };
        const uniform = api.robotRasterPlan(base, input);
        const shape = { ...base, bodyScales: [1, 2.5, 1] };
        const grown = api.robotRasterPlan(shape, input, uniform);
        assert.ok(grown.bytes > uniform.bytes, 'an enlarged individual cache cannot reuse the old uniform accounting');
        assert.deepStrictEqual(grown.bodyRasters[1], { width: 1280, height: 1000, density: 10 });
        const gentle = api.robotRasterPlan(shape, { ...input, width: 1680, height: 875 }, grown);
        assert.deepStrictEqual(gentle, grown, 'a small sufficient shrink keeps the complete existing cohort');
        const reordered = { ...base, bodyScales: [2.5, 1, 1] };
        const moved = api.robotRasterPlan(reordered, input, gentle);
        assert.deepStrictEqual(moved.bodyRasters.map((body: any) => body.width), [1280, 512, 512],
            'equal total bytes do not permit reusing the wrong member dimensions');
        const added = api.robotRasterPlan({ ...reordered, bodyCount: 4 }, input, moved);
        assert.strictEqual(added.bodyRasters.length, 4);
        assert.strictEqual(added.bytes, moved.bytes + 512 * 400 * 4);
        const shrunk = api.robotRasterPlan(reordered, { ...input, width: 960, height: 500 }, moved);
        assert.strictEqual(shrunk.width, 960);
        assert.deepStrictEqual(shrunk.bodyRasters.map((body: any) => body.width), [640, 256, 256]);
        assert.ok(shrunk.bytes < moved.bytes, 'a large shrink releases every oversized cache in the next plan');
    });

    it('handles fractional density and zoom without integer-sized jumps', () => {
        near(screen(1.25).cssScale, 0.8944271909999159);
        near(screen(1.5).cssScale, 0.8164965809277261);
        near(screen(0.5).cssScale, 1.414213562373095);
        assert.ok(screen(1.499).cssScale > screen(1.5).cssScale);
        assert.ok(screen(1.501).cssScale < screen(1.5).cssScale);
    });

    it('exposes available desktop space without selecting a device or allocating budgets', () => {
        const lowDensity = screen(1, 500, 400), highDensity = screen(2, 500, 400);
        assert.ok(lowDensity.availableWidth < 700 && lowDensity.availableHeight < 480);
        assert.ok(highDensity.availableWidth >= 700 && highDensity.availableHeight >= 480);
        assert.ok(screen(2, 300, 250).availableWidth < 700);
        near(highDensity.availableWidth * highDensity.cssScale, 500);
        near(highDensity.availableHeight * highDensity.cssScale, 400);
        assert.deepStrictEqual(Object.keys(highDensity).sort(), ['availableHeight', 'availableWidth', 'cssScale', 'devicePixelRatio']);
    });

    it('bounds density compensation and uses DPR one for unusable input', () => {
        for (const value of [0, -2, NaN, Infinity, -Infinity]) {
            assert.deepStrictEqual(screen(value), screen(1));
        }
        assert.deepStrictEqual(screen(0.01), screen(0.5));
        assert.deepStrictEqual(screen(100), screen(4));
        assert.deepStrictEqual(api.robotScreenMetrics({ width: 1000, height: 800 }), screen(1));
    });

    it('keeps unavailable and extreme viewport geometry finite without mutating inputs', () => {
        for (const edge of [0, -1, NaN, Infinity, -Infinity]) {
            const value = screen(2, edge, edge);
            assert.strictEqual(value.availableWidth, 0);
            assert.strictEqual(value.availableHeight, 0);
        }
        const input = Object.freeze({ width: Number.MAX_VALUE, height: 320, devicePixelRatio: 4 });
        const value = api.robotScreenMetrics(input);
        assert.strictEqual(value.availableWidth, Number.MAX_SAFE_INTEGER);
        assert.strictEqual(value.availableHeight, 640);
        assert.strictEqual(input.width, Number.MAX_VALUE);
    });

    it('keeps compact twelve-pixel CSS captions independent of sprite density compensation', () => {
        const one = api.robotCaptionMetrics({ devicePixelRatio: 1 });
        assert.strictEqual(one.fontSize, 12);
        assert.strictEqual(one.lineHeight, 16);
        assert.strictEqual(one.paddingX, 6);
        assert.strictEqual(one.paddingY, 3);
        for (const devicePixelRatio of [0.5, 1.2, 1.25, 1.5, 2, 3, 4, 100]) {
            const value = api.robotCaptionMetrics({ devicePixelRatio });
            assert.deepStrictEqual(value, one);
        }
    });

    it('preserves readable canvas text and padding after canvas fit and artwork transforms', () => {
        for (const devicePixelRatio of [1, 1.5, 2, 3, 4]) {
            for (const displayScale of [0.18, 0.5, 320 / 480 * 0.86, 1, 2.5]) {
                const value = api.robotCaptionMetrics({ devicePixelRatio, displayScale });
                near(value.localFontSize * displayScale, value.fontSize);
                near(value.localLineHeight * displayScale, value.lineHeight);
                near(value.localPaddingX * displayScale, 6);
                near(value.localPaddingY * displayScale, 3);
                near(value.localFontSize * displayScale, 12);
            }
        }
    });

    it('does not let drawing-unit conversion alter the CSS caption dimensions', () => {
        const small = api.robotCaptionMetrics({ devicePixelRatio: 2, displayScale: 0.25 });
        const large = api.robotCaptionMetrics({ devicePixelRatio: 2, displayScale: 2 });
        for (const field of ['fontSize', 'lineHeight', 'paddingX', 'paddingY']) {
            assert.strictEqual(small[field], large[field]);
        }
        near(small.localFontSize / large.localFontSize, 8);
    });

    it('uses a safe unit transform for invalid or numerically unusable display scales', () => {
        const baseline = api.robotCaptionMetrics();
        for (const displayScale of [0, -1, NaN, Infinity, -Infinity, Number.MIN_VALUE]) {
            assert.deepStrictEqual(api.robotCaptionMetrics({ displayScale }), baseline);
        }
        for (const devicePixelRatio of [0, -1, NaN, Infinity]) {
            assert.deepStrictEqual(api.robotCaptionMetrics({ devicePixelRatio }), baseline);
        }
        const large = api.robotCaptionMetrics({ displayScale: Number.MAX_VALUE });
        assert.ok(Object.values(large).every(value => typeof value === 'number' && Number.isFinite(value) && value > 0));
    });

    it('provides opaque neutral palettes for light documents and the dark lab', () => {
        const style = api.ROBOT_CAPTION_STYLE;
        function luminance(hex: string): number {
            assert.match(hex, /^#[0-9a-f]{6}$/i);
            const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
                .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        }
        assert.ok((luminance(style.background) + 0.05) / (luminance(style.color) + 0.05) > 12);
        assert.ok((luminance(style.background) + 0.05) / (luminance(style.borderColor) + 0.05) > 4.5);
        assert.strictEqual(style.fontWeight, 600);
        assert.ok(Object.isFrozen(style));
        const lab = api.ROBOT_LAB_CAPTION_STYLE;
        assert.ok((luminance(lab.color) + 0.05) / (luminance(lab.background) + 0.05) > 12);
        assert.deepStrictEqual(lab, { background: '#101c2b', color: '#e8f0fa', borderColor: '#43566b', fontWeight: 600 });
        assert.strictEqual(style.background, '#f5f7fa');
        assert.ok(Object.isFrozen(lab));
    });
});
