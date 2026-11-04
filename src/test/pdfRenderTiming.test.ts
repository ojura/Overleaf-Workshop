import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

interface Measurement { finish(): number | undefined; cancel(): void }
interface Timings { start(active?: () => boolean): Measurement; invalidate(): void; dispose(): void }

class Clock {
    now = 0;
    next = 0;
    readonly frames = new Map<number, (at: number) => void>();
    readonly timers = new Map<number, { at: number; callback(): void }>();
    readonly options = {
        now: () => this.now,
        requestFrame: (callback: (at: number) => void) => { const id = ++this.next; this.frames.set(id, callback); return id; },
        cancelFrame: (id: number) => { this.frames.delete(id); },
        setTimer: (callback: () => void, milliseconds: number) => {
            const id = ++this.next;
            this.timers.set(id, { at: this.now + milliseconds, callback });
            return id;
        },
        clearTimer: (id: number) => { this.timers.delete(id); },
    };
    frame() {
        const pending = [...this.frames];
        for (const [id, callback] of pending) { if (this.frames.delete(id)) { callback(this.now); } }
    }
    timer(lateness = 0) {
        const [id, timer] = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
        assert.ok(timer, 'an active measurement has one pending probe');
        this.timers.delete(id);
        this.now = timer.at + lateness;
        timer.callback();
    }
    quiet() {
        assert.strictEqual(this.frames.size, 0, 'the last measurement releases its frame');
        assert.strictEqual(this.timers.size, 0, 'the last measurement releases its timer');
    }
}

describe('PDF render timing across callback suspension', function () {
    this.timeout(30_000);
    let dir: string;
    let create: (options: Clock['options']) => Timings;
    let policy: { probeIntervalMs: number; maxTimerDriftMs: number };

    before(async () => {
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-render-timing-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/pdf-render-timing.ts')],
                outfile: path.join(dir, 'timing.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
        } finally { await esbuild.stop(); }
        const module = await importModule(path.join(dir, 'timing.mjs'));
        create = module.createPdfRenderTimings;
        policy = module.PDF_RENDER_TIMING_POLICY;
    });
    after(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); } });

    it('shares one active probe and becomes completely quiet after the last completion', () => {
        const clock = new Clock(), timings = create(clock.options);
        try {
            clock.quiet();
            const first = timings.start();
            clock.now = 10;
            const second = timings.start();
            assert.strictEqual(clock.frames.size, 1);
            assert.strictEqual(clock.timers.size, 1);
            clock.now = 40;
            assert.strictEqual(first.finish(), 40);
            assert.strictEqual(first.finish(), undefined, 'each measurement is consumed once');
            assert.strictEqual(clock.timers.size, 1, 'the other measurement still needs observation');
            clock.now = 70;
            assert.strictEqual(second.finish(), 60);
            clock.quiet();
        } finally { timings.dispose(); }
    });

    it('omits a render spanning frame-only suspension and accepts the next active render', () => {
        const clock = new Clock(), timings = create(clock.options);
        try {
            const suspended = timings.start();
            clock.now = 16; clock.frame();
            clock.timer();
            clock.timer(); // The next probe timer runs, but its requested frame never does.
            const pendingAfterSuspension = { frames: clock.frames.size, timers: clock.timers.size };
            clock.now += 162_000;
            assert.strictEqual(suspended.finish(), undefined, 'a delayed callback must not teach a page cost of 162s');
            assert.deepStrictEqual(pendingAfterSuspension, { frames: 0, timers: 0 }, 'suspension stops observation before the late completion');
            clock.quiet();
            const active = timings.start();
            clock.now += 16; clock.frame();
            clock.now += 84;
            assert.strictEqual(active.finish(), 100);
            clock.quiet();
        } finally { timings.dispose(); }
    });

    it('retains the full duration of a genuinely slow foreground read with continuing frames', () => {
        const clock = new Clock(), timings = create(clock.options);
        try {
            const slow = timings.start();
            for (let elapsed = 0; elapsed < 60_000; elapsed += policy.probeIntervalMs) {
                clock.now += 16; clock.frame(); clock.timer();
            }
            assert.strictEqual(slow.finish(), 60_000);
            clock.quiet();
        } finally { timings.dispose(); }
    });

    it('retains main-thread work that delays both the timer and animation frame', () => {
        const clock = new Clock(), timings = create(clock.options);
        try {
            const blocked = timings.start();
            clock.timer(5000 - policy.probeIntervalMs);
            assert.strictEqual(blocked.finish(), 5000, 'a late timer is not evidence of frame-only suspension');
            clock.quiet();
        } finally { timings.dispose(); }
    });

    it('uses the timer drift boundary without imposing an elapsed-duration cap', () => {
        for (const drift of [policy.maxTimerDriftMs, policy.maxTimerDriftMs + 1]) {
            const clock = new Clock(), timings = create(clock.options);
            try {
                const sample = timings.start();
                clock.timer(drift);
                assert.strictEqual(sample.finish(), drift <= policy.maxTimerDriftMs ? undefined : policy.probeIntervalMs + drift);
                clock.quiet();
            } finally { timings.dispose(); }
        }
    });

    it('invalidates on hidden or replaced documents and fences late callbacks without waking idle work', () => {
        const clock = new Clock(), timings = create(clock.options);
        try {
            const old = timings.start();
            const oldFrame = [...clock.frames.values()][0], oldTimer = [...clock.timers.values()][0].callback;
            timings.invalidate(); clock.quiet();
            clock.now = 30_000;
            oldFrame(clock.now); oldTimer();
            assert.strictEqual(old.finish(), undefined);
            clock.quiet();
            const next = timings.start();
            oldFrame(clock.now); oldTimer();
            assert.strictEqual(clock.frames.size, 1, 'late callbacks cannot consume the new generation\'s frame');
            clock.now += 55;
            assert.strictEqual(next.finish(), 55);
            clock.quiet();
        } finally { timings.dispose(); }
    });

    it('removes cancelled and internally retired native work without keeping an idle probe', () => {
        const clock = new Clock(), timings = create(clock.options);
        try {
            const cancelled = timings.start();
            let running = true;
            const native = timings.start(() => running);
            cancelled.cancel(); cancelled.cancel();
            assert.strictEqual(cancelled.finish(), undefined);
            assert.strictEqual(clock.timers.size, 1);
            running = false;
            clock.timer();
            assert.strictEqual(native.finish(), undefined);
            clock.quiet();
            assert.strictEqual(timings.start(() => false).finish(), undefined);
            clock.quiet();
        } finally { timings.dispose(); }
    });

    it('disposes active measurements and rejects later starts and queued callbacks', () => {
        const clock = new Clock(), timings = create(clock.options);
        const sample = timings.start();
        const frame = [...clock.frames.values()][0], timer = [...clock.timers.values()][0].callback;
        timings.dispose(); timings.dispose();
        clock.now = 60_000; frame(clock.now); timer();
        assert.strictEqual(sample.finish(), undefined);
        assert.strictEqual(timings.start().finish(), undefined);
        clock.quiet();
    });
});
