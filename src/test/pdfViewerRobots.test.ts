import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('the procedural PDF robot fleet', function () {
    this.timeout(30 * 1000);
    let dir: string;
    let robots: any;
    const ready = { starved: false, visibleMissing: [], safetySeconds: 1.5, pending: [], visible: [12], performance: { events: [] } };
    const outage = { ...ready, starved: true, visibleMissing: [12], safetySeconds: -0.4, pending: [12, 13] };

    function startOutage(fleet: any, at = 0, input = outage): any {
        fleet.step(at, input);
        return fleet.step(at + robots.ROBOT_LIMITS.outageConfirmMs + 1, input);
    }

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-robots-'));
        try {
            await esbuild.build({
                ...bundleOptions,
                entryPoints: [path.join(viewerRoot, 'src', 'common', 'prefetch-robots.ts')],
                outfile: path.join(dir, 'robots.mjs'),
            });
            robots = await importModule(path.join(dir, 'robots.mjs'));
        } finally {
            await esbuild.stop();
        }
    });

    after(() => {
        if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('uses every outage scenario once before settling, without starting another loop', () => {
        const fleet = new robots.RobotChoreographer(42);
        let frame = startOutage(fleet);
        const seen = new Set<string>();
        assert.ok(robots.ROBOT_SCENES.length >= 12);
        while (frame.mode === 'outage') {
            assert.ok(!seen.has(frame.scene), `repeated ${frame.scene} in one outage`);
            seen.add(frame.scene);
            frame = fleet.step(frame.nextTransitionAt + 1, outage);
        }
        assert.strictEqual(seen.size, robots.ROBOT_SCENES.length);
        assert.strictEqual(frame.mode, 'quiet');
        const episode = frame.episode;
        for (const at of [5 * 60 * 1000, 20 * 60 * 1000, 60 * 60 * 1000]) {
            frame = fleet.step(at, outage);
            assert.strictEqual(frame.mode, 'quiet');
            assert.strictEqual(frame.scene, 'waiting');
            assert.strictEqual(frame.episode, episode);
            assert.ok(frame.quietDetails.length <= robots.ROBOT_QUIET_DETAILS.length);
            assert.strictEqual(new Set(frame.quietDetails).size, frame.quietDetails.length);
        }
    });

    it('ends an outage on actual readiness and changes the next opening', () => {
        const fleet = new robots.RobotChoreographer(5);
        const first = startOutage(fleet);
        fleet.step(1000, ready);
        const recovered = fleet.step(1000 + robots.ROBOT_LIMITS.readinessConfirmMs, ready);
        assert.strictEqual(recovered.mode, 'recovery');
        assert.strictEqual(recovered.stats.recoveries, 1);
        assert.strictEqual(fleet.step(recovered.nextTransitionAt + 1, ready).mode, 'dispatch');
        const next = startOutage(fleet, recovered.nextTransitionAt + 2);
        assert.notStrictEqual(next.scene, first.scene);
        assert.strictEqual(next.episode, first.episode + 1);
        fleet.open(20000, outage);
        const reopened = fleet.step(20000 + robots.ROBOT_LIMITS.outageConfirmMs + 1, outage);
        assert.notStrictEqual(reopened.scene, next.scene);
    });

    it('detects missing visible pages even after scrolling has stopped', () => {
        const fleet = new robots.RobotChoreographer(7);
        const sample = { ...outage, safetySeconds: null, velocityPxPerMs: 0 };
        fleet.step(0, sample);
        const frame = fleet.step(robots.ROBOT_LIMITS.outageConfirmMs + 1, sample);
        assert.strictEqual(frame.mode, 'outage');
        assert.strictEqual(frame.missingPage, 12);
    });

    it('ignores a single missing sample and keeps one episode through brief readiness flicker', () => {
        const fleet = new robots.RobotChoreographer(29);
        fleet.step(0, outage);
        assert.strictEqual(fleet.step(220).mode, 'dispatch', 'animation time alone cannot confirm an outage');
        assert.strictEqual(fleet.step(250, ready).mode, 'dispatch');
        const began = startOutage(fleet, 500);
        const episode = began.episode;
        const scene = began.scene;
        for (let at = 1000; at < 3000; at += 250) {
            const frame = fleet.step(at, at % 500 === 0 ? ready : outage);
            assert.strictEqual(frame.mode, 'outage');
            assert.strictEqual(frame.episode, episode);
            assert.strictEqual(frame.scene, scene);
        }
        fleet.step(3000, ready);
        assert.strictEqual(fleet.step(3000 + robots.ROBOT_LIMITS.readinessConfirmMs, ready).mode, 'recovery');
    });

    it('replays the same input and seed deterministically while retaining individual robots', () => {
        const a = new robots.RobotChoreographer(19);
        const b = new robots.RobotChoreographer(19);
        let last: any;
        for (let frame = 0; frame < 900; frame++) {
            const at = frame * 1000 / 30;
            last = a.step(at, frame < 600 ? outage : ready);
            assert.deepStrictEqual(last, b.step(at, frame < 600 ? outage : ready));
        }
        assert.strictEqual(last.actors.length, robots.ROBOT_VEHICLES.length);
        assert.ok(new Set(last.actors.map((actor: any) => actor.temperament)).size > 1);
        assert.ok(last.actors.some((actor: any) => actor.distance > 10));
    });

    it('uses each new completed fetch and page event once as real cargo', () => {
        const fleet = new robots.RobotChoreographer(11);
        fleet.step(0, ready);
        const events = [
            { sequence: 1, at: 10, type: 'fetch', data: { bytes: 1048576, durationMs: 40 } },
            { sequence: 2, at: 10, type: 'preview-ready', data: { page: 13, ms: 80 } },
            { sequence: 3, at: 10, type: 'page-render', data: { page: 12, ms: 50, error: false } },
            { sequence: 4, at: 10, type: 'page-render', data: { page: 14, error: true } },
        ];
        let frame = fleet.step(10, { ...ready, performance: { events } });
        assert.strictEqual(frame.stats.acceptedCargo, 3);
        assert.strictEqual(frame.stats.fetchBytes, 1048576);
        const cargo = [...frame.queuedCargo, ...frame.actors.map((actor: any) => actor.cargo).filter(Boolean)];
        assert.deepStrictEqual(cargo.filter((item: any) => item.page).map((item: any) => item.page).sort(), [12, 13]);
        frame = fleet.step(20, { ...ready, performance: { events } });
        assert.strictEqual(frame.stats.acceptedCargo, 3);
        assert.strictEqual(frame.stats.fetchBytes, 1048576);
        for (let at = 50; at <= 30000; at += 1000 / 30) { frame = fleet.step(at); }
        assert.ok(frame.stats.deliveredCargo >= 3);
    });

    it('bounds the delivery queue and actors during a burst while accounting for all bytes', () => {
        const fleet = new robots.RobotChoreographer(13);
        fleet.step(0, ready);
        const events = Array.from({ length: 500 }, (_, index) => ({
            sequence: index + 1, at: 10, type: 'fetch', data: { bytes: 4096, durationMs: 8 },
        }));
        let frame = fleet.step(10, { ...outage, performance: { events } });
        assert.strictEqual(frame.stats.acceptedCargo, 500);
        assert.strictEqual(frame.stats.fetchBytes, 500 * 4096);
        assert.ok(frame.queuedCargo.length <= robots.ROBOT_LIMITS.maxQueuedCargo);
        assert.strictEqual(frame.actors.length, robots.ROBOT_LIMITS.maxActors);
        frame = fleet.step(10 + robots.ROBOT_LIMITS.outageConfirmMs + 1, { ...outage, performance: { events } });
        for (let index = 0; index < 1800; index++) {
            frame = fleet.step(10 + index * 1000 / 30);
            assert.ok(frame.particles.length <= robots.ROBOT_LIMITS.maxParticles);
            for (const actor of frame.actors) {
                for (const value of [actor.x, actor.y, actor.vx, actor.vy, actor.patience, actor.battery]) {
                    assert.ok(Number.isFinite(value));
                }
                assert.ok(actor.x >= 18 && actor.x <= robots.ROBOT_LIMITS.width - 18);
                assert.ok(actor.y >= 28 && actor.y <= robots.ROBOT_LIMITS.height - 20);
            }
        }
        assert.ok(frame.stats.yields > 0, 'neighbors change one another\'s motion');
        assert.ok(frame.stats.replans > 0, 'impatient blocked robots choose a detour');
    });

    it('lets an available robot help a stranded neighbor and preserves the robot identities', () => {
        const fleet = new robots.RobotChoreographer(17, { sceneOrder: ['rescue'] });
        let frame = startOutage(fleet);
        const ids = frame.actors.map((actor: any) => actor.id);
        assert.ok(frame.actors.some((actor: any) => actor.needsHelp));
        for (let index = 1; index < 240; index++) { frame = fleet.step(index * 1000 / 30, outage); }
        assert.ok(frame.stats.assists > 0, 'a helper reaches and services the stranded robot');
        assert.deepStrictEqual(frame.actors.map((actor: any) => actor.id), ids);
    });

    it('keeps byte and page cargo distinct when a burst introduces another kind at queue capacity', () => {
        const fleet = new robots.RobotChoreographer(31);
        fleet.step(0, ready);
        const events = [
            { sequence: 1, at: 1, type: 'fetch', data: { bytes: 4096 } },
            ...Array.from({ length: robots.ROBOT_LIMITS.maxQueuedCargo - 1 }, (_, index) => ({
                sequence: index + 2, at: 1, type: 'preview-ready', data: { page: index + 1 },
            })),
            { sequence: robots.ROBOT_LIMITS.maxQueuedCargo + 1, at: 1, type: 'page-render', data: { page: 42 } },
        ];
        const frame = fleet.step(1, { ...ready, performance: { events } });
        const cargo = [...frame.queuedCargo, ...frame.actors.map((actor: any) => actor.cargo).filter(Boolean)];
        assert.strictEqual(cargo.reduce((sum: number, item: any) => sum + item.count, 0), events.length);
        assert.strictEqual(cargo.filter((item: any) => item.kind === 'bytes').reduce((sum: number, item: any) => sum + item.bytes, 0), 4096);
        assert.ok(cargo.some((item: any) => item.kind === 'page' && item.page === 42));
        assert.ok(cargo.filter((item: any) => item.kind !== 'bytes').every((item: any) => item.bytes === 0));
    });

    it('does not replay old deliveries when the performance sequence resets for a new PDF', () => {
        const fleet = new robots.RobotChoreographer(23);
        fleet.step(0, ready);
        fleet.step(10, { ...ready, performance: { events: [
            { sequence: 40, at: 10, type: 'fetch', data: { bytes: 4096 } },
        ] } });
        const frame = fleet.step(20, { ...ready, performance: { events: [
            { sequence: 1, at: 20, type: 'document', data: { pages: 90 } },
            { sequence: 2, at: 20, type: 'fetch', data: { bytes: 2048 } },
        ] } });
        assert.strictEqual(frame.stats.acceptedCargo, 1);
        assert.strictEqual(frame.stats.fetchBytes, 2048);
    });
});
