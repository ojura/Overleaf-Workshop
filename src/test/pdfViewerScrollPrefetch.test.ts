import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// tsc emits CommonJS; the viewer bundle is an ES module.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

interface Snapshot {
    velocityPxPerMs: number;
    accelerationPxPerMs2: number;
    pageLatencyMs: number;
    preloadPx: number;
    direction: -1 | 0 | 1;
}
interface Dynamics {
    input(delta: number, now: number): void;
    page(milliseconds: number): void;
    stop(): void;
    reset(): void;
    preload(viewport: number): number;
    readonly direction: -1 | 0 | 1;
    snapshot(viewport: number): Snapshot;
}

describe('shared PDF scroll prefetch policy', function () {
    this.timeout(30 * 1000);
    let dir: string | undefined;
    let policy: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- name of the module's public export
        ScrollPrefetchDynamics: new (gestureGapMs?: number) => Dynamics;
        // eslint-disable-next-line @typescript-eslint/naming-convention -- name of the module's public export
        PREFETCH_LIMITS: Readonly<Record<string, number>>;
        pdfCachePolicy: (device?: Record<string, unknown>) => { name: string; rangeCacheBytes: number; pruneOffscreen: boolean; limits: Readonly<Record<string, number>> };
        pdfDocumentCacheOptions: (device?: Record<string, unknown>) => { rangeCacheBytes: number; adaptiveImageDecoding: boolean; imageDecodeConcurrency: number };
    };

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-scroll-prefetch-'));
        const outfile = path.join(dir, 'scroll-prefetch.mjs');
        try {
            await esbuild.build({
                ...bundleOptions,
                entryPoints: [path.join(viewerRoot, 'src', 'common', 'scroll-prefetch.ts')],
                outfile,
            });
        } finally {
            await esbuild.stop();
        }
        policy = await importModule(outfile);
    });

    after(() => {
        if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('keeps two viewports ready at rest with a useful minimum on short panes', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        assert.strictEqual(motion.preload(700), 1400);
        assert.strictEqual(motion.preload(100), 480);
        assert.deepStrictEqual(motion.snapshot(700), {
            velocityPxPerMs: 0, accelerationPxPerMs2: 0, pageLatencyMs: 32, preloadPx: 1400, direction: 0,
        });
        for (const viewport of [0, -1, NaN, Infinity, -Infinity]) {
            assert.strictEqual(motion.preload(viewport), 0);
        }
    });

    it('expands ahead immediately for fast gestures and caps speculative distance', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        const idle = motion.preload(700);
        motion.input(100, 1000);
        const slow = motion.preload(700);
        assert.ok(slow > idle);
        motion.input(400, 1016);
        const fast = motion.preload(700);
        assert.ok(fast > slow);
        motion.page(800);
        assert.ok(motion.preload(700) >= fast);
        assert.strictEqual(motion.preload(700), 8400);
        assert.strictEqual(motion.preload(2000), 12000);
        assert.strictEqual(motion.preload(9000), 18000, 'a large viewport retains its two-viewport baseline');
        motion.input(2, 5000);
        assert.ok(motion.preload(700) < fast, 'a new slow gesture discards the previous peak speed');
    });

    it('keeps recent peak speed through short pauses and resets it after the gesture gap', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        motion.input(320, 1000);
        assert.strictEqual(motion.snapshot(700).velocityPxPerMs, 10);
        motion.input(16, 1016);
        assert.strictEqual(motion.snapshot(700).velocityPxPerMs, 7.5);
        motion.input(16, 1032);
        assert.strictEqual(motion.snapshot(700).velocityPxPerMs, 5.63);
        motion.input(16, 1282);
        assert.ok(motion.snapshot(700).velocityPxPerMs > 4, '250ms still belongs to this gesture');
        motion.input(16, 1533);
        assert.strictEqual(motion.snapshot(700).velocityPxPerMs, 0.5, '251ms starts a new gesture');
        assert.strictEqual(motion.snapshot(700).accelerationPxPerMs2, 0);
    });

    it('bounds the sample interval when input events arrive within one frame', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        motion.input(320, 1000);
        motion.input(320, 1001);
        assert.strictEqual(motion.snapshot(700).velocityPxPerMs, 20);
        motion.input(320, 1001);
        assert.strictEqual(motion.snapshot(700).velocityPxPerMs, 20);
        assert.ok(Number.isFinite(motion.snapshot(700).accelerationPxPerMs2));
    });

    it('keeps motion across pauses within the configured gesture gap and resets beyond it', () => {
        const motion = new policy.ScrollPrefetchDynamics(1000);
        motion.input(320, 1000);
        motion.input(640, 1016);
        const moving = motion.snapshot(700);
        motion.input(16, 1316);
        const continuing = motion.snapshot(700);
        assert.ok(continuing.velocityPxPerMs > moving.velocityPxPerMs / 2, 'a 300ms pause preserves the recent speed');
        assert.ok(continuing.accelerationPxPerMs2 > 0, 'the same gesture retains its acceleration history');
        motion.input(16, 2317);
        assert.strictEqual(motion.snapshot(700).velocityPxPerMs, 0.5, 'a 1001ms pause starts a fresh gesture');
        assert.strictEqual(motion.snapshot(700).accelerationPxPerMs2, 0);
    });

    it('changes direction immediately without carrying acceleration through a reversal', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        motion.input(400, 1000);
        motion.input(800, 1016);
        assert.ok(motion.snapshot(700).accelerationPxPerMs2 > 0);
        motion.input(-16, 1032);
        assert.strictEqual(motion.direction, -1);
        assert.strictEqual(motion.snapshot(700).direction, -1);
        assert.strictEqual(motion.snapshot(700).velocityPxPerMs, 37.5, 'the conservative speed lead survives a reversal');
        assert.strictEqual(motion.snapshot(700).accelerationPxPerMs2, 0);
        motion.input(-32, 1048);
        assert.ok(motion.snapshot(700).accelerationPxPerMs2 < 0, 'acceleration follows signed motion');
        motion.input(-16, 1064);
        assert.ok(motion.snapshot(700).accelerationPxPerMs2 > 0, 'slowing upward motion has positive acceleration');
    });

    it('smooths signed acceleration and resets its sample after an idle gap', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        motion.input(32, 1000);
        assert.strictEqual(motion.snapshot(700).accelerationPxPerMs2, 0);
        motion.input(64, 1016);
        const accelerating = motion.snapshot(700).accelerationPxPerMs2;
        assert.ok(accelerating > 0 && accelerating < 3 / 16);
        motion.input(64, 1032);
        assert.ok(motion.snapshot(700).accelerationPxPerMs2 > 0);
        assert.ok(motion.snapshot(700).accelerationPxPerMs2 < accelerating);
        motion.input(64, 1300);
        assert.strictEqual(motion.snapshot(700).accelerationPxPerMs2, 0);
    });

    it('learns a slow preparation immediately and reduces that latency gradually', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        motion.input(40, 1000);
        const initial = motion.preload(700);
        motion.page(200);
        const slowRead = motion.preload(700);
        assert.ok(slowRead > initial);
        assert.strictEqual(motion.snapshot(700).pageLatencyMs, 200);
        motion.page(20);
        assert.strictEqual(motion.snapshot(700).pageLatencyMs, 160);
        assert.ok(motion.preload(700) > initial);
        assert.ok(motion.preload(700) < slowRead);
    });

    it('bounds the contribution of extremely slow reads independently from viewport size', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        motion.input(2, 1000);
        motion.page(5000);
        const lead = motion.preload(700);
        assert.ok(lead < 8400);
        motion.page(60_000);
        assert.strictEqual(motion.preload(700), lead);
        assert.strictEqual(motion.snapshot(700).pageLatencyMs, 60_000);
    });

    it('ignores invalid measurements and never infers motion from completed page work', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        motion.page(24);
        motion.page(30);
        const before = motion.snapshot(700);
        for (const [delta, now] of [[NaN, 1], [Infinity, 1], [-Infinity, 1], [0, 1], [10, NaN], [10, Infinity]]) {
            motion.input(delta, now);
        }
        for (const latency of [NaN, Infinity, -Infinity, -1]) { motion.page(latency); }
        assert.deepStrictEqual(motion.snapshot(700), before);
        assert.strictEqual(before.velocityPxPerMs, 0);
        assert.strictEqual(before.accelerationPxPerMs2, 0);
        assert.strictEqual(before.direction, 0);
        assert.strictEqual(before.preloadPx, 1400);
    });

    it('stops motion while preserving latency, then resets all learning for a new document', () => {
        const motion = new policy.ScrollPrefetchDynamics();
        motion.page(400);
        motion.input(80, 1000);
        motion.input(160, 1016);
        motion.stop();
        assert.deepStrictEqual(motion.snapshot(700), {
            velocityPxPerMs: 0, accelerationPxPerMs2: 0, pageLatencyMs: 400, preloadPx: 1400, direction: 0,
        });
        motion.input(40, 1020);
        const fresh = new policy.ScrollPrefetchDynamics();
        fresh.input(40, 1020);
        assert.ok(motion.preload(700) > fresh.preload(700), 'stopping keeps the learned preparation cost');
        assert.strictEqual(motion.snapshot(700).accelerationPxPerMs2, 0);
        motion.reset();
        assert.deepStrictEqual(motion.snapshot(700), new policy.ScrollPrefetchDynamics().snapshot(700));
    });

    it('exports immutable finite budgets that fit the native cache and a preview raster', () => {
        const limits = policy.PREFETCH_LIMITS;
        assert.ok(Object.isFrozen(limits));
        for (const [name, value] of Object.entries(limits)) {
            assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive finite integer`);
        }
        assert.ok(limits.maxRenderedPages < 10, 'render targets must fit below PDF.js\'s ten-view buffer');
        assert.ok(limits.maxPreparedPages >= limits.maxRenderedPages, 'preparation includes the native render window');
        assert.ok(limits.maxConcurrentPrepares <= limits.maxPreparedPages, 'concurrent preparation fits within the plan');
        assert.ok(limits.maxPreviewBytes >= limits.previewMaxDimension ** 2 * 4, 'the preview cache can retain one maximum-sized RGBA raster');
    });

    it('selects bounded mobile caches for phones and desktop-mode iPads', () => {
        const desktop = policy.pdfCachePolicy({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 10 });
        assert.strictEqual(desktop.name, 'desktop', 'a touchscreen laptop keeps the desktop policy');
        assert.strictEqual(desktop.rangeCacheBytes, 128 * 1024 * 1024);
        assert.strictEqual(desktop.pruneOffscreen, false);
        assert.deepStrictEqual(policy.pdfDocumentCacheOptions({ userAgent: 'desktop' }), {
            rangeCacheBytes: 128 * 1024 * 1024, adaptiveImageDecoding: true, imageDecodeConcurrency: 2,
        });
        assert.deepStrictEqual([
            desktop.limits.maxConcurrentPrepares, desktop.limits.maxPreparedPages, desktop.limits.maxRenderedPages,
            desktop.limits.maxCanvasBytes, desktop.limits.maxPreviewBytes,
        ], [3, 16, 8, 192 * 1024 * 1024, 64 * 1024 * 1024], 'image decoding keeps the desktop preparation and raster budgets');
        for (const device of [
            { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X)', maxTouchPoints: 5 },
            { userAgent: 'Mozilla/5.0 (Linux; Android 16)', maxTouchPoints: 5 },
            { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 5 },
            { userAgent: 'future browser', userAgentData: { mobile: true } },
        ]) {
            const mobile = policy.pdfCachePolicy(device);
            assert.strictEqual(mobile.name, 'mobile');
            assert.strictEqual(mobile.rangeCacheBytes, 32 * 1024 * 1024);
            assert.strictEqual(mobile.pruneOffscreen, true);
            assert.deepStrictEqual(policy.pdfDocumentCacheOptions(device), {
                rangeCacheBytes: 32 * 1024 * 1024, adaptiveImageDecoding: true, imageDecodeConcurrency: 1,
            });
            assert.ok(Object.isFrozen(mobile) && Object.isFrozen(mobile.limits));
            for (const name of ['maxPreparedPages', 'maxConcurrentPrepares', 'maxRenderedPages', 'maxCanvasBytes', 'maxPreviewBytes', 'previewMaxDimension', 'trailPreviewMaxDimension']) {
                assert.ok(mobile.limits[name] < desktop.limits[name], name + ' shrinks on mobile');
            }
            assert.strictEqual(mobile.limits.maxPreviewPages, 128, 'small trail rasters retain a useful revisit history');
            assert.strictEqual(mobile.limits.trailPreviewMaxDimension, 192);
        }
        assert.strictEqual(policy.pdfCachePolicy({ userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 }).name, 'desktop');
    });
});
