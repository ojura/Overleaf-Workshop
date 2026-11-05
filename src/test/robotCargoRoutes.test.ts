import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('ground cargo routes and cooperative airlifts', function () {
    this.timeout(30_000);
    let directory: string, routes: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-cargo-routes-test-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/robot-cargo-routes.ts')],
                outfile: path.join(directory, 'routes.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
            routes = await importModule(path.join(directory, 'routes.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    const input = (overrides: Record<string, any> = {}) => ({
        from: { x: 80, y: 640 }, to: { x: 420, y: 180 }, airFrom: { x: 40, y: 300 },
        cargoOffset: { x: 25, y: -35 }, airOffset: { x: 0, y: -96 }, progress: 0,
        ...overrides,
    });
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' differs from ' + expected);
    function sharedCargo(value: any, options: any) {
        near(value.cargo.x, value.ground.x + options.cargoOffset.x);
        near(value.cargo.y, value.ground.y + options.cargoOffset.y);
        if (value.groundCarried) {
            near(value.air.x, value.ground.x + options.airOffset.x);
            near(value.air.y, value.ground.y + options.airOffset.y);
        }
    }

    it('uses the declared tangent threshold, including stationary, vertical and mirrored routes', () => {
        assert.strictEqual(routes.GROUND_ROUTE_MAX_SLOPE, 0.25);
        for (const sign of [-1, 1]) {
            assert.strictEqual(routes.needsCargoAirlift({ x: 0, y: 0 }, { x: 100 * sign, y: 25 }), false);
            assert.strictEqual(routes.needsCargoAirlift({ x: 0, y: 0 }, { x: 100 * sign, y: 25.01 }), true);
        }
        assert.strictEqual(routes.needsCargoAirlift({ x: 3, y: 8 }, { x: 3, y: 8 }), false);
        assert.strictEqual(routes.needsCargoAirlift({ x: 3, y: 8 }, { x: 3, y: -8 }), true);
        assert.strictEqual(routes.needsCargoAirlift({ x: 0, y: 0 }, { x: 100, y: 40 }, 0.5), false);
    });

    it('drives a shallow leg directly without recruiting or carrying the ground body', () => {
        const options = input({ to: { x: 480, y: 700 } });
        for (let index = 0; index <= 100; index++) {
            const value = routes.computeCargoRoute({ ...options, progress: index / 100 });
            assert.strictEqual(value.requiresAir, false); assert.strictEqual(value.groundCarried, false);
            assert.strictEqual(value.phase, index === 100 ? 'arrived' : 'drive');
            assert.deepStrictEqual(value.air, options.airFrom); sharedCargo(value, options);
        }
        assert.deepStrictEqual(routes.computeCargoRoute(options).ground, options.from);
        assert.deepStrictEqual(routes.computeCargoRoute({ ...options, progress: 1 }).ground, options.to);
    });

    it('preserves authored gentle climbs and descents while bounding steep side-entry heights', () => {
        const anchor = Object.freeze({ x: 200, y: 300 });
        for (const direction of [-1, 1]) {
            for (const vertical of [-1, 1]) {
                const shallow = Object.freeze({ x: anchor.x + direction * 100, y: anchor.y + vertical * 20 });
                const retained = routes.clampGroundRoutePoint(anchor, shallow);
                assert.deepStrictEqual(retained, shallow);
                assert.notStrictEqual(retained, shallow);
                const clipped = routes.clampGroundRoutePoint(anchor, { x: shallow.x, y: anchor.y + vertical * 90 });
                assert.deepStrictEqual(clipped, { x: shallow.x, y: anchor.y + vertical * 25 });
                assert.strictEqual(routes.needsCargoAirlift(anchor, clipped), false);
            }
        }
        assert.deepStrictEqual(routes.clampGroundRoutePoint(anchor, { x: 200, y: 500 }), anchor);
        assert.deepStrictEqual(routes.clampGroundRoutePoint(anchor, { x: 300, y: 500 }, 0.1), { x: 300, y: 310 });
        for (const requested of [{ x: NaN, y: 0 }, { x: 0, y: Infinity }]) {
            assert.throws(() => routes.clampGroundRoutePoint(anchor, requested), RangeError);
        }
        assert.throws(() => routes.clampGroundRoutePoint(anchor, anchor, -1), RangeError);
    });

    it('stops and recruits, rendezvouses, carries the robot, sets it down and finishes by driving', () => {
        const options = input(), phases: string[] = [];
        for (let index = 0; index <= 1000; index++) {
            const value = routes.computeCargoRoute({ ...options, progress: index / 1000 });
            if (phases[phases.length - 1] !== value.phase) { phases.push(value.phase); }
            assert.strictEqual(value.requiresAir, true); sharedCargo(value, options);
        }
        assert.deepStrictEqual(phases, ['drive', 'recruit', 'rendezvous', 'lift', 'carry', 'set-down', 'final-drive', 'arrived']);
        const policy = routes.CARGO_ROUTE_POLICY;
        const stopped = routes.computeCargoRoute({ ...options, progress: policy.driveEnd });
        const recruited = routes.computeCargoRoute({ ...options, progress: (policy.driveEnd + policy.recruitEnd) / 2 });
        assert.deepStrictEqual(recruited.ground, stopped.ground); assert.deepStrictEqual(recruited.air, options.airFrom);
        const rendezvous = routes.computeCargoRoute({ ...options, progress: (policy.recruitEnd + policy.rendezvousEnd) / 2 });
        assert.deepStrictEqual(rendezvous.ground, stopped.ground);
        assert.ok(distance(rendezvous.air, options.airFrom) > 1);
    });

    it('keeps every uncarried ground tangent within its climb limit for both directions and vertical trips', () => {
        for (const options of [input(), input({ from: { x: 420, y: 180 }, to: { x: 80, y: 640 } }),
            input({ to: { x: 80, y: 180 } }), input({ to: { x: 480, y: 700 } })]) {
            let previous = routes.computeCargoRoute(options);
            for (let index = 1; index <= 1000; index++) {
                const next = routes.computeCargoRoute({ ...options, progress: index / 1000 });
                if (!previous.groundCarried && !next.groundCarried) {
                    const dx = Math.abs(next.ground.x - previous.ground.x), dy = Math.abs(next.ground.y - previous.ground.y);
                    assert.ok(dy <= dx * routes.GROUND_ROUTE_MAX_SLOPE + 1e-8, 'uncarried body climbed ' + dy + ' over ' + dx);
                }
                previous = next;
            }
        }
    });

    it('preserves the actual body and photo attachment offsets throughout lift, crossing and lowering', () => {
        const options = input({ airOffset: { x: -17, y: -133 }, cargoOffset: { x: 41, y: -57 } });
        const policy = routes.CARGO_ROUTE_POLICY;
        for (let index = 0; index < 200; index++) {
            const progress = policy.rendezvousEnd + (policy.setDownEnd - policy.rendezvousEnd) * index / 200;
            const value = routes.computeCargoRoute({ ...options, progress });
            assert.strictEqual(value.groundCarried, true); sharedCargo(value, options);
        }
        const released = routes.computeCargoRoute({ ...options, progress: policy.setDownEnd });
        const arrived = routes.computeCargoRoute({ ...options, progress: 1 });
        assert.strictEqual(released.groundCarried, false); assert.deepStrictEqual(arrived.air, released.air);
        assert.ok(distance(arrived.ground, released.ground) > 1); assert.strictEqual(arrived.ground.y, released.ground.y);
        assert.deepStrictEqual(arrived.ground, options.to); sharedCargo(arrived, options);
    });

    it('keeps bodies and cargo continuous across every phase boundary and reaches exact endpoints', () => {
        const policy = routes.CARGO_ROUTE_POLICY;
        const boundaries = [policy.driveEnd, policy.recruitEnd, policy.rendezvousEnd, policy.liftEnd, policy.carryEnd, policy.setDownEnd];
        for (const options of [input(), input({ from: { x: 420, y: 180 }, to: { x: 80, y: 640 } }),
            input({ to: { x: 80, y: 180 }, bounds: { left: 20, right: 120 } })]) {
            for (const boundary of boundaries) {
                const before = routes.computeCargoRoute({ ...options, progress: boundary - 1e-7 });
                const after = routes.computeCargoRoute({ ...options, progress: boundary + 1e-7 });
                for (const key of ['ground', 'air', 'cargo']) { assert.ok(distance(before[key], after[key]) < 0.001, key + ' jumped at ' + boundary); }
            }
            assert.deepStrictEqual(routes.computeCargoRoute({ ...options, progress: -2 }).ground, options.from);
            const done = routes.computeCargoRoute({ ...options, progress: 3 });
            assert.strictEqual(done.phase, 'arrived'); assert.deepStrictEqual(done.ground, options.to); sharedCargo(done, options);
        }
    });

    it('constrains pickup and set-down to the available width, including a single shared X coordinate', () => {
        for (const bounds of [{ left: 0, right: 500 }, { left: 50, right: 50 }]) {
            const options = input({ from: { x: -120, y: 640 }, to: { x: 620, y: 180 }, groundRun: 80, bounds });
            for (const progress of [routes.CARGO_ROUTE_POLICY.driveEnd, routes.CARGO_ROUTE_POLICY.setDownEnd]) {
                const value = routes.computeCargoRoute({ ...options, progress });
                assert.ok(value.ground.x >= bounds.left && value.ground.x <= bounds.right);
                assert.ok([value.ground.x, value.ground.y, value.air.x, value.air.y, value.cargo.x, value.cargo.y].every(Number.isFinite));
            }
            assert.deepStrictEqual(routes.computeCargoRoute({ ...options, progress: 1 }).ground, options.to);
        }
    });

    it('keeps its inputs unchanged and does not return the caller’s mutable point objects', () => {
        const options = input({ bounds: { left: 20, right: 500 } });
        for (const value of Object.values(options)) { if (value && typeof value === 'object') { Object.freeze(value); } }
        Object.freeze(options);
        const before = JSON.stringify(options), value = routes.computeCargoRoute(options);
        assert.strictEqual(JSON.stringify(options), before);
        assert.notStrictEqual(value.ground, options.from); assert.notStrictEqual(value.air, options.airFrom);
        value.ground.x = 900; assert.strictEqual(options.from.x, 80);
    });

    it('rejects non-finite geometry and invalid route constraints instead of emitting NaN positions', () => {
        for (const overrides of [
            { progress: NaN }, { progress: Infinity }, { from: { x: NaN, y: 0 } }, { to: { x: 1, y: Infinity } },
            { airFrom: { x: Infinity, y: 1 } }, { cargoOffset: { x: 1, y: NaN } }, { airOffset: { x: 0, y: Infinity } },
            { groundRun: -1 }, { groundRun: Infinity }, { maxSlope: -0.1 }, { maxSlope: NaN },
            { bounds: { left: 4, right: 2 } }, { bounds: { left: 0, right: Infinity } },
            { from: { x: Number.MAX_VALUE, y: 0 }, to: { x: -Number.MAX_VALUE, y: 1 } },
        ]) { assert.throws(() => routes.computeCargoRoute(input(overrides)), RangeError); }
    });
});
