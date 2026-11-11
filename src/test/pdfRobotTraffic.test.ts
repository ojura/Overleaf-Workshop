import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
interface Point { x: number; y: number; visibility?: number }
interface Group extends Point {
    id: number; radius: number; ground: boolean; weight: number; remainingMs: number;
    fixed?: boolean; offsetScale?: number; canFade?: boolean;
}
const group = (id: number, x = 0, y = 0, options: Partial<Group> = {}): Group =>
    ({ id, x, y, radius: 20, ground: false, weight: 1, remainingMs: 2000, ...options });
const entries = (value: Map<number, Point>) => [...value].sort((a, b) => a[0] - b[0]);
const length = (point: Point) => Math.hypot(point.x, point.y);

describe('Payload-level robot traffic spacing', function () {
    this.timeout(30_000);
    let directory: string, api: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-robot-traffic-'));
        const entry = path.join(directory, 'entry.ts');
        fs.writeFileSync(entry, [
            `export { RobotTraffic } from ${JSON.stringify(path.join(repo, 'views/pdf-viewer/src/common/robot-traffic.ts'))};`,
            `export { computeCargoRoute } from ${JSON.stringify(path.join(repo, 'views/pdf-viewer/src/common/robot-cargo-routes.ts'))};`,
        ].join('\n'));
        try {
            await esbuild.build({ entryPoints: [entry],
                outfile: path.join(directory, 'traffic.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
        } finally { await esbuild.stop(); }
        api = await importModule(path.join(directory, 'traffic.mjs'));
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    function settle(traffic: any, groups: readonly Group[], end = 960): Map<number, Point> {
        let result = new Map<number, Point>();
        for (let at = 0; at <= end; at += 16) { result = traffic.update(at, groups); }
        return result;
    }

    it('separates loaded crossing groups before contact while preserving the higher-weight path', () => {
        const traffic = new api.RobotTraffic();
        let predicted = false, closest = Infinity;
        for (let at = 0; at <= 480; at += 16) {
            const a = group(1, -120 + at * 0.5, 0, { weight: 8 });
            const b = group(2, 120 - at * 0.5, 0, { weight: 2 });
            const offsets = traffic.update(at, [a, b]) as Map<number, Point>;
            assert.deepStrictEqual(offsets.get(1), { x: 0, y: 0 });
            const yielding = offsets.get(2)!;
            if (Math.abs(a.x - b.x) > a.radius + b.radius && length(yielding) > 1) { predicted = true; }
            closest = Math.min(closest, Math.hypot(b.x + yielding.x - a.x, yielding.y));
        }
        assert.strictEqual(predicted, true, 'avoidance begins before the loaded bodies touch');
        assert.ok(closest >= 40, 'the crossing maintains both body radii, closest=' + closest);
    });

    it('spaces stationary groups sharing a destination without a random encounter', () => {
        const traffic = new api.RobotTraffic();
        const offsets = settle(traffic, [group(1, 0, 0, { weight: 9 }), group(2, 0, 0, { weight: 3 }), group(3)]);
        assert.deepStrictEqual(offsets.get(1), { x: 0, y: 0 });
        for (const [a, b] of [[1, 2], [1, 3], [2, 3]]) {
            assert.ok(Math.hypot(offsets.get(a)!.x - offsets.get(b)!.x, offsets.get(a)!.y - offsets.get(b)!.y) >= 51.9);
        }
    });

    it('uses available vertical space when four airborne groups share one destination', () => {
        const traffic = new api.RobotTraffic();
        const offsets = settle(traffic, [group(1), group(2), group(3), group(4)]);
        assert.deepStrictEqual(offsets.get(1), { x: 0, y: 0 });
        for (let a = 1; a <= 4; a++) {
            for (let b = a + 1; b <= 4; b++) {
                assert.ok(Math.hypot(offsets.get(a)!.x - offsets.get(b)!.x, offsets.get(a)!.y - offsets.get(b)!.y) >= 51.9,
                    'groups ' + a + ' and ' + b + ' remain overlapped');
            }
        }
        assert.ok([...offsets.values()].some(offset => Math.abs(offset.y) > 20));
    });

    it('keeps every ground displacement horizontal under diagonal crowding', () => {
        const traffic = new api.RobotTraffic();
        const groups = [group(-1, 0, 0, { fixed: true, radius: 30 }), group(2, 5, 25, { ground: true })];
        let offset: Point = { x: 0, y: 0 };
        for (let at = 0; at <= 640; at += 16) {
            offset = traffic.update(at, groups).get(2);
            assert.strictEqual(offset.y, 0);
        }
        assert.ok(offset.x > 40);
        assert.ok(Math.hypot(5 + offset.x, 25) >= 50);
    });

    it('moves high-weight traffic around a signed fixed anchor with no deadline', () => {
        const traffic = new api.RobotTraffic();
        const groups = [group(5, 10, 0, { weight: 100 }), group(-19, 0, 0, { fixed: true, weight: 0, radius: 30, remainingMs: 0 })];
        const offsets = settle(traffic, groups);
        assert.deepStrictEqual(offsets.get(-19), { x: 0, y: 0 });
        assert.ok(10 + offsets.get(5)!.x >= 61.9);
    });

    it('leaves overlapping fixed groups exactly unchanged', () => {
        const offsets = settle(new api.RobotTraffic(), [group(-8, 0, 0, { fixed: true }), group(3, 0, 0, { fixed: true, weight: 40 })]);
        assert.deepStrictEqual(entries(offsets), [[-8, { x: 0, y: 0 }], [3, { x: 0, y: 0 }]]);
    });

    it('removes a formerly movable offset immediately when that group becomes fixed', () => {
        const traffic = new api.RobotTraffic(), groups = [group(-1, 0, 0, { fixed: true }), group(2)];
        const moved = settle(traffic, groups, 320);
        assert.ok(length(moved.get(2)!) > 20);
        const fixed = traffic.update(320, [groups[0], { ...groups[1], fixed: true }]);
        assert.deepStrictEqual(fixed.get(2), { x: 0, y: 0 }, 'no elapsed frame is needed to pin a group');
        assert.deepStrictEqual(traffic.update(NaN, [groups[0], { ...groups[1], fixed: true }]).get(2), { x: 0, y: 0 });
    });

    it('is stable under input reordering and accepts safe signed ID priorities', () => {
        const first = new api.RobotTraffic(), second = new api.RobotTraffic();
        for (let at = 0; at <= 480; at += 16) {
            const groups = [group(7, 8, 3), group(-5, 0, 0), group(2, 20 + at / 30, 9, { weight: 0 })];
            const a = first.update(at, groups), b = second.update(at, [...groups].reverse());
            assert.deepStrictEqual(entries(a), entries(b));
            assert.deepStrictEqual(a.get(-5), { x: 0, y: 0 }, 'lower signed ID wins an equal-weight tie');
        }
    });

    it('prunes missing IDs and clears all prior spacing on empty input or reset', () => {
        const traffic = new api.RobotTraffic(), groups = [group(-1), group(2)];
        assert.ok(length(settle(traffic, groups, 320).get(2)!) > 20);
        assert.strictEqual(traffic.update(336, [groups[0]]).has(2), false);
        assert.deepStrictEqual(traffic.update(352, [groups[0], group(2, 500, 500)]).get(2), { x: 0, y: 0 });
        assert.strictEqual(traffic.update(368, []).size, 0);
        const fresh = new api.RobotTraffic();
        assert.deepStrictEqual(entries(traffic.update(500, groups)), entries(fresh.update(500, groups)));
        assert.deepStrictEqual(entries(traffic.update(516, groups)), entries(fresh.update(516, groups)));
        traffic.reset();
        assert.deepStrictEqual(entries(traffic.update(0, groups)), entries(new api.RobotTraffic().update(0, groups)));
    });

    it('eases an unblocked group back to exact zero without extending its caller deadline', () => {
        const traffic = new api.RobotTraffic(), groups = [group(-1, 0, 0, { fixed: true }), group(2)];
        let before = settle(traffic, groups, 320).get(2)!;
        for (let at = 336; at <= 1500; at += 16) {
            const next = traffic.update(at, [groups[1]]).get(2) as Point;
            assert.ok(length(next) <= length(before));
            assert.ok(Math.hypot(next.x - before.x, next.y - before.y) <= 12.8 + 1e-9);
            before = next;
        }
        assert.deepStrictEqual(before, { x: 0, y: 0 });
        assert.strictEqual(traffic.update(1504, [{ ...groups[1], remainingMs: 0 }]).size, 0);
        assert.strictEqual(traffic.update(1520, [{ ...groups[1], remainingMs: -1 }]).size, 0);
    });

    it('bounds group count, displacement and frame movement under saturated crowding', () => {
        const traffic = new api.RobotTraffic();
        const groups = Array.from({ length: 20 }, (_, index) => group(index - 10, 0, 0, { radius: 512, weight: index }));
        let previous = traffic.update(0, groups) as Map<number, Point>;
        assert.strictEqual(previous.size, 12);
        assert.deepStrictEqual([...previous.keys()].sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index - 2));
        for (let at = 16; at <= 480; at += 16) {
            const result = traffic.update(at, [...groups].reverse()) as Map<number, Point>;
            for (const [id, offset] of result) {
                assert.ok(Number.isFinite(offset.x) && Number.isFinite(offset.y));
                assert.ok(length(offset) <= 96 + 1e-9);
                assert.ok(Math.hypot(offset.x - previous.get(id)!.x, offset.y - previous.get(id)!.y) <= 12.8 + 1e-9);
            }
            previous = result;
        }
    });

    it('ignores malformed geometry and unsafe IDs while keeping extreme finite inputs bounded', () => {
        const traffic = new api.RobotTraffic();
        const malformed = [group(NaN), group(Infinity), group(Number.MAX_SAFE_INTEGER + 1), group(4, Infinity),
            group(5, 0, NaN), group(6, 0, 0, { radius: -1 }), group(7, 0, 0, { radius: Infinity }),
            group(8, 0, 0, { remainingMs: NaN }), group(9, 0, 0, { remainingMs: Infinity })];
        const valid = [group(Number.MIN_SAFE_INTEGER, Number.MAX_VALUE, Number.MAX_VALUE, { radius: Number.MAX_VALUE, weight: Number.MAX_VALUE }),
            group(Number.MAX_SAFE_INTEGER, -Number.MAX_VALUE, -Number.MAX_VALUE, { weight: NaN })];
        const result = settle(traffic, [...malformed, ...valid]);
        assert.deepStrictEqual([...result.keys()].sort((a, b) => a - b), [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
        assert.ok([...result.values()].every(value => Number.isFinite(value.x) && Number.isFinite(value.y) && length(value) <= 96));
    });

    it('freezes offsets on nonfinite/backward time and bounds a long scheduling gap', () => {
        const traffic = new api.RobotTraffic(), groups = [group(-1, 0, 0, { fixed: true }), group(2)];
        let previous = settle(traffic, groups, 160);
        for (const at of [NaN, Infinity, -Infinity, -100, 0, 160]) {
            const result = traffic.update(at, groups);
            assert.deepStrictEqual(entries(result), entries(previous));
            previous = result;
        }
        const after = traffic.update(Number.MAX_VALUE, groups) as Map<number, Point>;
        assert.ok(Math.hypot(after.get(2)!.x - previous.get(2)!.x, after.get(2)!.y - previous.get(2)!.y) <= 0.8 * 64 + 1e-9);
        assert.deepStrictEqual(entries(traffic.update(0, groups)), entries(after));
    });

    it('preserves immutable caller input and does not expose its stored offsets', () => {
        const groups = Object.freeze([Object.freeze(group(-1)), Object.freeze(group(2))]);
        const traffic = new api.RobotTraffic(), control = new api.RobotTraffic();
        traffic.update(0, groups); control.update(0, groups);
        const result = traffic.update(16, groups);
        control.update(16, groups);
        result.get(2).x = NaN;
        result.clear();
        assert.deepStrictEqual(entries(traffic.update(32, groups)), entries(control.update(32, groups)));
        assert.strictEqual(groups[1].x, 0); assert.strictEqual(groups[1].remainingMs, 2000);
    });

    function opposingGround(at: number): Group[] {
        return [1, 2].map(id => {
            const side = id === 1 ? -1 : 1;
            const route = api.computeCargoRoute({ progress: at / 1800,
                from: { x: side * 180, y: 100 }, to: { x: -side * 180, y: 100 }, airFrom: { x: 0, y: 0 },
                cargoOffset: { x: 24, y: -18 }, airOffset: { x: 0, y: -50 } });
            return group(id, route.ground.x, route.ground.y, { ground: true, radius: 30, weight: 2, remainingMs: 1800 - at });
        });
    }

    it('fades the yielding payload through an opposing same-row cargo route and restores it afterward', () => {
        const traffic = new api.RobotTraffic();
        let faded = false, overlapSamples = 0, lastVisibility = 1;
        for (let at = 0; at < 1800; at += 16) {
            const groups = opposingGround(at), offsets = traffic.update(at, groups) as Map<number, Point>;
            const a = offsets.get(1)!, b = offsets.get(2)!, visibility = b.visibility ?? 1;
            assert.strictEqual(a.visibility ?? 1, 1);
            assert.strictEqual(a.y, 0); assert.strictEqual(b.y, 0);
            assert.ok(visibility >= 0 && visibility <= 1);
            assert.ok(Math.abs(visibility - lastVisibility) <= 16 / 160 + 1e-9);
            if (visibility < 1) { faded = true; }
            if (Math.abs(groups[1].x + b.x - groups[0].x - a.x) < 60) {
                overlapSamples++;
                assert.ok(visibility <= 0.02, 'inseparable ground crossing is still visible at ' + at + ' ms');
            }
            lastVisibility = visibility;
        }
        assert.strictEqual(faded, true); assert.ok(overlapSamples > 0);
        assert.strictEqual(lastVisibility, 1);
        assert.strictEqual(traffic.update(1800, opposingGround(1800)).size, 0);
    });

    it('keeps a stationary inseparable group tracked and hidden until clearance crosses the recovery margin', () => {
        const traffic = new api.RobotTraffic(), anchor = group(-1, 0, 0, { fixed: true, radius: 60 });
        const moving = group(2, 0, 0, { ground: true, radius: 60 });
        let result = settle(traffic, [anchor, moving], 320);
        assert.strictEqual(result.get(2)!.visibility, 0);
        for (let at = 336; at <= 640; at += 16) {
            result = traffic.update(at, [anchor, moving]);
            assert.strictEqual(result.size, 2, 'visibility must not remove an obstacle from the solver');
            assert.strictEqual(result.get(2)!.visibility, 0);
            assert.ok(result.get(2)!.x > 80);
        }
        for (let at = 656; at <= 960; at += 16) {
            result = traffic.update(at, [anchor, { ...moving, x: at % 32 ? 138 : 139 }]);
            assert.strictEqual(result.get(2)!.visibility, 0, 'small clearance changes must not flicker');
        }
        let visibility = 0;
        for (let at = 976; at <= 1248; at += 16) {
            result = traffic.update(at, [anchor, { ...moving, x: 220 }]);
            const next = result.get(2)!.visibility ?? 1;
            assert.ok(next >= visibility && next - visibility <= 16 / 240 + 1e-9);
            visibility = next;
        }
        assert.strictEqual(visibility, 1);
    });

    it('pins a formerly hidden group fully visible immediately and clears fallback state on reset or omission', () => {
        const traffic = new api.RobotTraffic(), anchor = group(-7, 0, 0, { fixed: true, radius: 60 });
        const moving = group(2, 0, 0, { ground: true, radius: 60 });
        assert.strictEqual(settle(traffic, [anchor, moving], 320).get(2)!.visibility, 0);
        const pinned = traffic.update(320, [anchor, { ...moving, fixed: true }]).get(2) as Point;
        assert.deepStrictEqual(pinned, { x: 0, y: 0 });
        assert.strictEqual(pinned.visibility ?? 1, 1);
        traffic.reset();
        settle(traffic, [anchor, moving], 320);
        traffic.update(336, [anchor]);
        assert.strictEqual(traffic.update(352, [anchor, { ...moving, x: 500 }]).get(2).visibility ?? 1, 1);
        traffic.reset();
        assert.deepStrictEqual(entries(traffic.update(0, [anchor, moving])), entries(new api.RobotTraffic().update(0, [anchor, moving])));
    });

    it('keeps ground fallback deterministic under input reordering without opacity feedback', () => {
        const first = new api.RobotTraffic(), second = new api.RobotTraffic();
        let hiddenSamples = 0;
        for (let at = 0; at < 1800; at += 16) {
            const groups = opposingGround(at), a = first.update(at, groups), b = second.update(at, [...groups].reverse());
            assert.deepStrictEqual(entries(a), entries(b));
            assert.strictEqual(a.size, 2);
            if (a.get(2).visibility === 0) { hiddenSamples++; }
        }
        assert.ok(hiddenSamples > 4);
    });

    it('keeps a faded payload continuous when it becomes fixed at deposit 0.62 through the opaque 0.76 interval', () => {
        const traffic = new api.RobotTraffic();
        let position = 0, visibility = 1;
        for (let at = 0; at < 1800 * 0.62; at += 16) {
            const groups = opposingGround(at), result = traffic.update(at, groups);
            position = groups[1].x + result.get(2).x;
            visibility = result.get(2).visibility ?? 1;
        }
        assert.strictEqual(visibility, 0);
        const depositAt = 1800 * 0.62;
        const fixed = { ...opposingGround(depositAt)[1], x: position, fixed: true, canFade: true, offsetScale: 0 };
        const deposited = traffic.update(depositAt, [opposingGround(depositAt)[0], fixed]).get(2) as Point;
        assert.strictEqual(deposited.x, 0); assert.strictEqual(deposited.y, 0);
        assert.strictEqual(deposited.visibility, 0, 'position fixation must not reset payload visibility');
        for (let at = depositAt + 16; at <= 1800 * 0.76; at += 16) {
            const winner = opposingGround(at)[0];
            const result = traffic.update(at, [winner, { ...fixed, remainingMs: 1800 - at }]).get(2) as Point;
            const next = result.visibility ?? 1;
            assert.ok(Math.abs(next - visibility) <= 16 / 160 + 1e-9);
            if (Math.abs(position - winner.x) < 60) { assert.ok(next <= 0.02); }
            visibility = next;
        }
    });

    it('tests fade clearance at the actual endpoint-scaled positions and scales output only once', () => {
        const anchor = group(-1, 0, 0, { fixed: true });
        const moving = group(2, 10, 0, { ground: true, canFade: true });
        const normal = settle(new api.RobotTraffic(), [anchor, moving]).get(2)!;
        const endpoint = settle(new api.RobotTraffic(), [anchor, { ...moving, offsetScale: 0.25 }]).get(2)!;
        assert.ok(Math.abs(endpoint.x - normal.x * 0.25) < 1e-9);
        assert.strictEqual(endpoint.y, 0);
        assert.ok(10 + endpoint.x < 40, 'the displayed endpoint cannot clear both body radii');
        assert.strictEqual(endpoint.visibility, 0, 'unscaled planned clearance must not reveal the displayed overlap');
        const exact = settle(new api.RobotTraffic(), [anchor, { ...moving, offsetScale: 0 }]).get(2)!;
        assert.strictEqual(exact.x, 0); assert.strictEqual(exact.y, 0); assert.strictEqual(exact.visibility, 0);
    });

    it('gives nonfadeable hardware priority over a heavier fixed fadeable payload', () => {
        const hardware = group(20, 0, 0, { fixed: true, canFade: false, weight: 0 });
        const payload = group(-3, 0, 0, { fixed: true, canFade: true, weight: 100, ground: false });
        const result = settle(new api.RobotTraffic(), [payload, hardware]);
        assert.deepStrictEqual(result.get(20), { x: 0, y: 0 });
        assert.deepStrictEqual(result.get(-3), { x: 0, y: 0, visibility: 0 });
    });

    it('clamps the endpoint scale, handles unusable values and obeys explicit fade permission', () => {
        const anchor = group(-1, 0, 0, { fixed: true });
        const moving = group(2, 10, 0, { ground: true });
        const normal = settle(new api.RobotTraffic(), [anchor, moving]).get(2)!;
        for (const [scale, expected] of [[-2, 0], [0, 0], [0.5, 0.5], [1, 1], [2, 1], [Infinity, 1], [-Infinity, 0], [NaN, 1]]) {
            const result = settle(new api.RobotTraffic(), [anchor, { ...moving, offsetScale: scale }]).get(2)!;
            assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y));
            assert.ok(Math.abs(result.x - normal.x * expected) < 1e-9);
        }
        const prohibited = settle(new api.RobotTraffic(), [anchor, { ...moving, offsetScale: 0, canFade: false }]).get(2)!;
        assert.deepStrictEqual(prohibited, { x: 0, y: 0 });
    });
    it('reports one stable moving-peer passage and excludes stationary, fixed and residual spacing', () => {
        const traffic = new api.RobotTraffic(); const ids = new Set<number>();
        for (let at = 0; at <= 480; at += 16) {
            traffic.update(at, [group(1, -120 + at * .5, 0), group(2, 120 - at * .5, 0)]);
            for (const passage of traffic.passages()) {
                assert.deepStrictEqual([passage.winner, passage.yielding], [1, 2]); ids.add(passage.id);
            }
        }
        assert.strictEqual(ids.size, 1, 'the actual coordinated crossing has one logical identity');
        const id = [...ids][0]; assert.ok(traffic.hasPassage(id));
        traffic.update(496, [group(1, 120, 0), group(2, -120, 0)]);
        traffic.update(512, [group(1, 120, 0), group(2, -120, 0)]);
        assert.deepStrictEqual(traffic.passages(), [], 'residual easing is not another passage');
        assert.ok(traffic.hasPassage(id), 'temporary constraint absence retains the same separation context');
        traffic.update(528, [group(1, 1000, 0), group(2, -1000, 0)]);
        assert.strictEqual(traffic.hasPassage(id), false, 'real separation retires its speech identity');
        traffic.reset(); settle(traffic, [group(1), group(2)]);
        assert.deepStrictEqual(traffic.passages(), [], 'stationary destination crowding is not passing');
        traffic.reset();
        for (let at = 0; at <= 160; at += 16) {
            traffic.update(at, [group(1, 0, 0, { fixed: true }), group(2, 80 - at * .5, 0)]);
            assert.deepStrictEqual(traffic.passages(), [], 'fixed obstacles do not speak as coordinated peers');
        }
        traffic.reset(); assert.deepStrictEqual(traffic.passages(), []);
    });

});
