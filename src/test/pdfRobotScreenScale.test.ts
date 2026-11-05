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
                entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/robot-screen-scale.ts')],
                outfile: path.join(directory, 'scale.mjs'), bundle: true, format: 'esm',
                platform: 'node', target: 'es2022', logLevel: 'silent',
            });
        } finally { await esbuild.stop(); }
        api = await importModule(path.join(directory, 'scale.mjs'));
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
