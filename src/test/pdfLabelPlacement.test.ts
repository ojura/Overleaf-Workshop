import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const bounds = { x: 0, y: 0, width: 400, height: 400 };
const candidate = (x: number, y: number, cost = 0, baseX = x, baseY = y) => ({ x, y, cost, base: { x: baseX, y: baseY } });
const label = (id = 'a', extra: Record<string, unknown> = {}) => ({
    id, anchor: { x: 100, y: 100 }, width: 20, height: 16, ...extra,
});
const center = (placed: any) => ({ x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} differs from ${expected}`);
const frame = (solver: any, now: number, labels: any[], obstacles: any[] = [], viewport = bounds): any[] =>
    solver.layout({ now, bounds: viewport, labels, obstacles });

/** The first four stability cases adapt Chase Scope's test/labels.test.js to measured rectangles. */
describe('measured robot caption placement', function () {
    this.timeout(30_000);
    let directory: string, api: any;

    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-label-placement-'));
        try {
            await esbuild.build({
                entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/label-placement.ts')],
                outfile: path.join(directory, 'placement.mjs'), bundle: true, format: 'esm',
                platform: 'node', target: 'es2022', logLevel: 'silent',
            });
        } finally { await esbuild.stop(); }
        api = await importModule(path.join(directory, 'placement.mjs'));
    });

    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    it('admits a full-width label at an off-center anchor while retaining collision suppression', () => {
        const solver = new api.LabelPlacementSolver();
        const viewport = { x: 8, y: 8, width: 148, height: 300 };
        const full = label('work', { anchor: { x: 120, y: 100 }, width: 148, height: 64, leaderAnchors: [] });
        let placed = frame(solver, 0, [full], [], viewport)[0];
        placed = frame(solver, 100, [full], [], viewport)[0];
        assert.strictEqual(placed.blocked, false);
        close(placed.x, viewport.x);
        assert.ok(placed.opacity > 0);
        const covered = frame(new api.LabelPlacementSolver(), 0,
            [full, { ...full, id: 'second' }], [], { ...viewport, height: 64 });
        assert.strictEqual(covered.filter(value => !value.blocked).length, 1);
    });

    it('remembers a nearby attachment base when candidates change order', () => {
        const solver = new api.LabelPlacementSolver();
        const original = label('a', { candidates: [candidate(100, 50), candidate(100, 150)] });
        frame(solver, 0, [original]);
        frame(solver, 100, [original]);
        const changed = [candidate(100, 150), candidate(101, 52), candidate(300, 300)];
        for (let index = 1; index <= 60; index++) {
            const candidates = index % 2 ? changed : [...changed].reverse();
            const [placed] = frame(solver, 100 + index * 20, [label('a', { candidates })]);
            close(center(placed).x, 101);
            close(center(placed).y, 52);
        }
    });

    it('holds small improvements and waits 300 milliseconds before changing to a clearly better slot', () => {
        const solver = new api.LabelPlacementSolver();
        const input = (cost: number) => label('a', { candidates: [candidate(100, 50, cost), candidate(100, 150)] });
        frame(solver, 0, [input(0)]);
        for (let now = 20; now <= 400; now += 20) { close(center(frame(solver, now, [input(500)])[0]).y, 50); }
        let firstMove = -1;
        for (let elapsed = 20; elapsed <= 400; elapsed += 20) {
            const [placed] = frame(solver, 400 + elapsed, [input(3000)]);
            if (center(placed).y > 50 + 1e-7) { firstMove = elapsed; break; }
        }
        assert.ok(firstMove >= 300 && firstMove <= 320, `the slot changed after ${firstMove} ms`);
    });

    it('ignores a transient obstacle, moves for a persistent one, and returns when its preferred slot stays free', () => {
        const solver = new api.LabelPlacementSolver();
        const input = label('a', { width: 60, height: 24, candidates: [candidate(100, 50), candidate(100, 150, 1500)] });
        const obstacle = { x: 70, y: 38, width: 60, height: 24 };
        frame(solver, 0, [input]);
        let now = 0;
        for (let index = 0; index < 7; index++) {
            now += 20;
            close(center(frame(solver, now, [input], [obstacle])[0]).y, 50);
        }
        now += 20;
        close(center(frame(solver, now, [input])[0]).y, 50);
        const start = now;
        let firstMove = -1;
        for (let index = 0; index < 45; index++) {
            now += 20;
            const y = center(frame(solver, now, [input], [obstacle])[0]).y;
            if (y > 50 + 1e-7 && firstMove < 0) { firstMove = now - start; }
        }
        assert.ok(firstMove >= 300 && firstMove <= 320, `the persistent obstacle moved the caption after ${firstMove} ms`);
        for (let index = 0; index < 10; index++) {
            now += 20;
            assert.ok(center(frame(solver, now, [input])[0]).y > 149);
        }
        for (let index = 0; index < 30; index++) { now += 20; frame(solver, now, [input]); }
        assert.ok(center(frame(solver, now + 20, [input])[0]).y < 51);
    });

    it('escapes a newly occupied slot immediately while returning results in caller order', () => {
        const solver = new api.LabelPlacementSolver();
        const lower = label('b', { candidates: [candidate(100, 50), candidate(100, 150, 2000)] });
        frame(solver, 0, [lower]);
        frame(solver, 100, [lower]);
        const higher = label('a', { priority: 2, candidates: [candidate(102, 52)] });
        const placed = frame(solver, 120, [lower, higher]);
        assert.deepStrictEqual(placed.map(item => item.id), ['b', 'a']);
        assert.ok(center(placed[0]).y > 60, 'collision escape begins before the ordinary improvement hold');
        assert.ok(placed[0].y >= placed[1].y + placed[1].height, 'the measured captions have separated');
    });

    it('follows anchor translation even when the caller clock has not advanced', () => {
        const solver = new api.LabelPlacementSolver();
        const viewport = { x: 0, y: 0, width: 1000, height: 1000 };
        const original = label('a', { anchor: { x: 300, y: 300 }, width: 100, height: 56, radius: 20 });
        const [first] = frame(solver, 0, [original], [], viewport);
        const [moved] = frame(solver, 0, [{ ...original, anchor: { x: 420, y: 220 } }], [], viewport);
        close(moved.x - first.x, 120);
        close(moved.y - first.y, -80);
    });

    it('eases only the changed slot offset with a 90 millisecond time constant', () => {
        const solver = new api.LabelPlacementSolver();
        frame(solver, 0, [label('a', { candidates: [candidate(100, 50)] })]);
        const [changed] = frame(solver, 90, [label('a', { candidates: [candidate(100, 150)] })]);
        close(center(changed).y, 150 - 100 / Math.E);
        const [moved] = frame(solver, 90, [label('a', { anchor: { x: 140, y: 170 }, candidates: [candidate(140, 220)] })]);
        close(moved.x - changed.x, 40);
        close(moved.y - changed.y, 70);
    });

    it('keeps the attachment-side edge fixed when measured text becomes wider and taller', () => {
        const solver = new api.LabelPlacementSolver();
        const [first] = frame(solver, 0, [label('a', {
            width: 80, height: 24, candidates: [candidate(180, 100, 0, 140, 100)],
        })]);
        const [changed] = frame(solver, 20, [label('a', {
            width: 160, height: 64, candidates: [candidate(220, 100, 0, 140, 100)],
        })]);
        close(first.x, 140);
        close(changed.x, first.x);
        close(center(changed).y, 100);
        assert.strictEqual(changed.width, 160);
        assert.strictEqual(changed.height, 64);
    });

    it('places measured multiline rectangles inside offset viewport bounds near each corner', () => {
        const viewport = { x: 30, y: 20, width: 340, height: 260 };
        for (const anchor of [{ x: 35, y: 25 }, { x: 365, y: 25 }, { x: 35, y: 275 }, { x: 365, y: 275 }]) {
            const solver = new api.LabelPlacementSolver();
            const [placed] = frame(solver, 0, [label('a', { anchor, width: 96, height: 54, radius: 12 })], [], viewport);
            assert.ok(placed.x >= viewport.x && placed.y >= viewport.y, JSON.stringify(placed));
            assert.ok(placed.x + placed.width <= viewport.x + viewport.width, JSON.stringify(placed));
            assert.ok(placed.y + placed.height <= viewport.y + viewport.height, JSON.stringify(placed));
        }
    });

    it('scores body and cargo rectangles before selecting a caption position', () => {
        const solver = new api.LabelPlacementSolver();
        const [placed] = frame(solver, 0, [label('a', {
            width: 60, height: 20, candidates: [candidate(100, 100), candidate(100, 200, 1000)],
        })], [{ x: 70, y: 90, width: 60, height: 20 }]);
        close(center(placed).y, 200);
    });

    it('avoids a leader crossing an earlier caption when another candidate is available', () => {
        const solver = new api.LabelPlacementSolver();
        const blocking = label('first', { priority: 10, width: 40, height: 40, leaderAnchors: [], candidates: [candidate(100, 100)] });
        const speaking = label('second', { anchor: { x: 100, y: 20 }, width: 20, height: 20,
            candidates: [candidate(100, 180), candidate(180, 100, 100)] });
        const placed = frame(solver, 0, [blocking, speaking]);
        assert.deepStrictEqual(center(placed[1]), { x: 180, y: 100 });
        assert.deepStrictEqual(placed[1].leaders, [{ from: { x: 100, y: 20 }, to: { x: 170, y: 90 } }]);
    });

    it('returns up to three actual speaker leaders separately from the midpoint placement anchor', () => {
        const solver = new api.LabelPlacementSolver();
        const anchors = [{ x: 200, y: 100 }, { x: 300, y: 100 }, { x: 350, y: 220 }];
        const [placed] = frame(solver, 0, [label('exchange', { anchor: { x: 250, y: 120 }, width: 100, height: 60,
            leaderAnchors: anchors, candidates: [candidate(250, 200)] })]);
        assert.deepStrictEqual(placed.leaders, [
            { from: { x: 200, y: 100 }, to: { x: 200, y: 170 } },
            { from: { x: 300, y: 100 }, to: { x: 300, y: 170 } },
            { from: { x: 350, y: 220 }, to: { x: 300, y: 220 } },
        ]);
        anchors[0].x = 999;
        assert.strictEqual(placed.leaders[0].from.x, 200);
    });

    it('reports immediate admission before opacity advances on a single static paint', () => {
        const solver = new api.LabelPlacementSolver();
        const upper = label('upper', { priority: 10, width: 120, height: 56, candidates: [candidate(200, 100)] });
        const lower = label('lower', { width: 120, height: 56, candidates: [candidate(200, 100)] });
        const placed = frame(solver, 0, [lower, upper]);
        assert.deepStrictEqual(placed.map(item => item.id), ['lower', 'upper']);
        assert.deepStrictEqual(placed.map(item => item.opacity), [0, 0]);
        assert.deepStrictEqual(placed.map(item => item.blocked), [true, false]);
        const [released] = frame(solver, 0, [lower]);
        assert.strictEqual(released.opacity, 0);
        assert.strictEqual(released.blocked, false, 'static callers can show the newly admitted label without another frame');
    });

    it('keeps a crowded lower-priority caption hidden until space becomes available', () => {
        const solver = new api.LabelPlacementSolver();
        const upper = label('upper', { priority: 10, width: 120, height: 56, candidates: [candidate(200, 100)] });
        const lower = label('lower', { width: 120, height: 56, candidates: [candidate(200, 100)] });
        let placed = frame(solver, 0, [upper, lower]);
        for (let now = 20; now <= 200; now += 20) { placed = frame(solver, now, [upper, lower]); }
        assert.strictEqual(placed[0].opacity, 1);
        assert.strictEqual(placed[1].opacity, 0);
        const [free] = frame(solver, 220, [lower]);
        assert.ok(free.opacity > 0 && free.opacity < 1);
        for (let now = 240; now <= 400; now += 20) { placed = frame(solver, now, [lower]); }
        assert.strictEqual(placed[0].opacity, 1);
    });

    it('admits a stable priority and ID budget without waiting for opacity or caller time', () => {
        const solver = new api.LabelPlacementSolver();
        const inputs = [
            label('ambient-b', { candidates: [candidate(100, 100)] }),
            label('notice', { priority: 2, candidates: [candidate(200, 200)] }),
            label('ambient-a', { candidates: [candidate(300, 300)] }),
        ];
        const layout = (labels: any[], maxVisible: number) => solver.layout({ now: 0, bounds, labels, maxVisible });
        const first = layout(inputs, 2);
        assert.deepStrictEqual(first.map((placed: any) => [placed.id, placed.blocked]),
            [['ambient-b', true], ['notice', false], ['ambient-a', false]]);
        assert.ok(first.every((placed: any) => placed.opacity === 0));
        assert.deepStrictEqual(layout([...inputs].reverse(), 2).filter((placed: any) => !placed.blocked).map((placed: any) => placed.id).sort(),
            ['ambient-a', 'notice']);
        assert.ok(layout(inputs, 0).every((placed: any) => placed.blocked && placed.opacity === 0 && placed.leaders.length === 0));
        const [readmitted] = layout([inputs[0]], 1);
        assert.strictEqual(readmitted.blocked, false, 'an omitted or budget-hidden name is immediately eligible on a later static paint');
    });

    it('spends the visibility budget only on labels that fit', () => {
        const solver = new api.LabelPlacementSolver();
        const placed = solver.layout({ now: 0, bounds, maxVisible: 1, labels: [
            label('notice', { priority: 2, width: 500, height: 500, candidates: [candidate(200, 200)] }),
            label('fitting', { candidates: [candidate(100, 100)] }),
            label('later', { candidates: [candidate(300, 300)] }),
        ] });
        assert.deepStrictEqual(placed.map((value: any) => value.blocked), [true, false, true]);
    });

    it('forgets omitted IDs and resets both placement history and the caller clock', () => {
        const solver = new api.LabelPlacementSolver();
        const forced = label('a', { candidates: [candidate(100, 50, 3000), candidate(100, 150)] });
        const equal = label('a', { candidates: [candidate(100, 50), candidate(100, 150)] });
        frame(solver, 0, [forced]);
        close(center(frame(solver, 100, [equal])[0]).y, 150);
        assert.deepStrictEqual(frame(solver, 120, []), []);
        close(center(frame(solver, 140, [equal])[0]).y, 50);
        solver.reset();
        frame(solver, 160, [forced]);
        close(center(frame(solver, 180, [equal])[0]).y, 150);
        solver.reset();
        const [fresh] = frame(solver, 1000, [equal]);
        close(center(fresh).y, 50);
        assert.strictEqual(fresh.opacity, 0, 'reset clears the previous timestamp as well as label memory');
    });

    it('rejects excess work and invalid geometry before changing placement history', () => {
        const solver = new api.LabelPlacementSolver();
        const input = label('a', { candidates: [candidate(100, 150), candidate(100, 50)] });
        frame(solver, 0, [input]);
        const limits = api.LABEL_PLACEMENT_LIMITS;
        const manyLabels = Array.from({ length: limits.labels + 1 }, (_, index) => label(String(index)));
        const manyObstacles = Array.from({ length: limits.obstacles + 1 }, () => ({ x: 0, y: 0, width: 1, height: 1 }));
        const manyCandidates = Array.from({ length: limits.candidates + 1 }, () => candidate(100, 50));
        const manyLeaders = Array.from({ length: limits.leaderAnchors + 1 }, () => ({ x: 100, y: 100 }));
        for (const bad of [
            { labels: manyLabels }, { labels: [input], obstacles: manyObstacles },
            { labels: [label('a', { candidates: manyCandidates })] }, { labels: [label('a', { leaderAnchors: manyLeaders })] },
            { labels: [label('a', { height: Number.NaN })] }, { labels: [label('a', { height: 0 })] },
            { labels: [input, input] }, { labels: [label('a', { candidates: [] })] },
            ...[-1, 0.5, NaN, Infinity, limits.labels + 1].map(maxVisible => ({ labels: [input], maxVisible })),
        ]) {
            assert.throws(() => solver.layout({ now: 1000, bounds, ...bad }), /label placement|Label placement/);
        }
        const [retained] = frame(solver, 20, [input]);
        close(center(retained).y, 150);
        close(retained.opacity, 0.02 / 0.15);
    });
});
