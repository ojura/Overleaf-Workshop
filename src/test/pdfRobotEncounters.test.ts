import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('finite document robot encounters', function () {
    this.timeout(30 * 1000);
    let directory: string, module: any;
    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts/build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-robot-encounters-'));
        try {
            await esbuild.build({ ...bundleOptions, entryPoints: [path.join(viewerRoot, 'src/common/robot-encounters.ts')], outfile: path.join(directory, 'encounters.mjs') });
            module = await importModule(path.join(directory, 'encounters.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    function owner(values: number[] = [0.1, 0.5, 0]) {
        let calls = 0;
        const model = new module.RobotEncounters(() => values[calls++] ?? 0.99, 12);
        return { model, calls: () => calls };
    }
    function actor(id: number, x: number, y = 0, overrides: Record<string, unknown> = {}) {
        return { id, x, y, radius: 10, phase: 'advance', remainingMs: 1500, opacity: 1, ...overrides };
    }
    function approach(model: any) {
        model.update(0, [actor(1, 0), actor(2, 110)]);
        return model.update(40, [actor(1, 30), actor(2, 80)]);
    }

    it('plays a finite doze, evasive correction and startled apology from a real approaching pair', () => {
        const { model } = owner();
        const start = approach(model);
        assert.strictEqual(model.snapshot().active.kind, 'near-miss');
        assert.strictEqual(start.get(2).expression, 'drowsy');
        assert.strictEqual(start.get(2).activity, 'sleep');
        const midway = model.update(300, [actor(1, 55), actor(2, 60)]);
        assert.ok(Math.abs(midway.get(1).y) > 10, 'the correction is larger than the vehicle radius');
        const startled = model.update(520, [actor(1, 68), actor(2, 48)]);
        assert.strictEqual(startled.get(2).expression, 'startled');
        assert.ok(startled.get(1).caption && startled.get(2).caption, 'both sides have distinct reactions');
        assert.ok(Math.abs(model.update(800, [actor(1, 80), actor(2, 35)]).get(1).y) > 20, 'the full evasive arc exceeds two body radii');
        const end = model.snapshot().active.ends;
        assert.ok(end < 1540, 'the scene fits the supplied existing motion lifetime');
        assert.strictEqual(model.update(end, [actor(1, 95), actor(2, 20)]).size, 0);
        assert.strictEqual(model.snapshot().active, undefined);
        assert.strictEqual(model.snapshot().counts.nearMiss, 1);
    });

    it('confirms geometric contact before a bump, and abandons a missed contact without a fake recoil', () => {
        const { model } = owner([0.1, 0.1, 0]);
        assert.strictEqual(approach(model).size, 0, 'an armed bump has no reaction before contact');
        assert.strictEqual(model.snapshot().counts.bump, 0);
        assert.strictEqual(model.snapshot().active.confirmed, false);
        model.update(70, [actor(1, 50), actor(2, 60)]);
        assert.strictEqual(model.snapshot().active.confirmed, true);
        assert.strictEqual(model.snapshot().counts.bump, 1);
        const recoil = model.update(170, [actor(1, 65), actor(2, 45)]);
        assert.ok(Math.abs(recoil.get(1).x) + Math.abs(recoil.get(1).y) > 0);
        assert.strictEqual(recoil.get(1).expression, 'annoyed');
        assert.strictEqual(recoil.get(2).expression, 'sheepish');
        const missed = owner([0.1, 0.1, 0]).model;
        approach(missed);
        missed.update(180, [actor(1, 30, -45), actor(2, 80, 45)]);
        assert.strictEqual(missed.update(340, [actor(1, 20, -60), actor(2, 90, 60)]).size, 0);
        assert.strictEqual(missed.snapshot().active, undefined);
        assert.strictEqual(missed.snapshot().counts.bump, 0);
        const paused = owner([0.1, 0.1, 0]).model;
        approach(paused);
        assert.strictEqual(paused.update(600, [actor(1, 50), actor(2, 60)]).size, 0, 'a long frame pause cannot confirm an expired predicted bump');
        assert.strictEqual(paused.snapshot().counts.bump, 0);
    });

    it('allows recognition and a paired celebratory departure instead of making every encounter adversarial', () => {
        const { model } = owner([0.1, 0.9, 0.5]);
        const first = approach(model);
        assert.strictEqual(model.snapshot().active.kind, 'reunion');
        assert.strictEqual(first.get(1).activity, 'celebrate');
        assert.strictEqual(first.get(1).expression, 'pleased');
        assert.ok(first.get(1).caption && first.get(2).caption, 'recognition has two distinct lines');
        const next = model.update(200, [actor(1, 48), actor(2, 64)]);
        assert.strictEqual(next.get(1).gesturePhase, next.get(2).gesturePhase, 'their finite gestures share one phase');
        assert.strictEqual(next.get(1).y, -next.get(2).y, 'formation offsets are complementary');
    });

    it('rolls once per approach and keeps failure rare across repeated frames and new pairs', () => {
        const { model, calls } = owner([0.99, 0.1, 0.5, 0]);
        approach(model);
        for (let frame = 1; frame <= 100; frame++) {
            model.update(40 + frame * 16, [actor(1, 30 + frame * 0.01), actor(2, 80 - frame * 0.01)]);
        }
        assert.strictEqual(model.snapshot().attempts, 1);
        assert.strictEqual(calls(), 1, 'repeated frames never accumulate another chance');
        model.update(2000, [actor(3, 0), actor(4, 110)]);
        model.update(2040, [actor(3, 30), actor(4, 80)]);
        assert.strictEqual(calls(), 1, 'a new pair does not bypass the failed-attempt cadence');
        model.update(5000, [actor(5, 0), actor(6, 110)]);
        model.update(5040, [actor(5, 30), actor(6, 80)]);
        assert.strictEqual(model.snapshot().attempts, 2);
        assert.strictEqual(model.snapshot().active.kind, 'near-miss');
    });

    it('requires separation to rearm a pair and honors the encounter cooldown', () => {
        const { model } = owner(Array(30).fill(0));
        approach(model);
        model.update(70, [actor(1, 50), actor(2, 60)]);
        model.update(2000, [actor(1, -100), actor(2, 200)]);
        model.update(2040, [actor(1, 0), actor(2, 110)]);
        model.update(2080, [actor(1, 30), actor(2, 80)]);
        assert.strictEqual(model.snapshot().attempts, 1, 'separation cannot bypass the global scene cooldown');
        model.update(9000, [actor(1, -100), actor(2, 200)]);
        model.update(9040, [actor(1, 0), actor(2, 110)]);
        model.update(9080, [actor(1, 30), actor(2, 80)]);
        assert.strictEqual(model.snapshot().attempts, 2);
    });

    it('keeps cooperative partners, stationary crews and late returns out of traffic incidents', () => {
        for (const overrides of [{ phase: 'parked' }, { group: 9 }, { remainingMs: 300 }]) {
            const { model, calls } = owner();
            model.update(0, [actor(1, 0, 0, overrides), actor(2, 110, 0, overrides)]);
            model.update(40, [actor(1, 30, 0, overrides), actor(2, 80, 0, overrides)]);
            assert.strictEqual(calls(), 0, JSON.stringify(overrides));
            assert.strictEqual(model.snapshot().active, undefined);
        }
        const { model, calls } = owner();
        model.update(0, [actor(1, 10), actor(2, 20)]);
        model.update(40, [actor(1, 10), actor(2, 20)]);
        assert.strictEqual(calls(), 0, 'overlap without movement is not an encounter');
    });

    it('celebrates cooperative success only on the actual deposit edge and preserves its handling pose', () => {
        const { model } = owner([0.1, 0]);
        const group = [actor(1, 40, 0, { phase: 'deposit', group: 2 }), actor(2, 70, 0, { phase: 'deposit', group: 2 })];
        assert.strictEqual(model.update(0, group).size, 0, 'a deposited-looking pose alone is insufficient');
        const success = model.update(40, group, [[1, 2]]);
        assert.strictEqual(model.snapshot().counts.success, 1);
        assert.strictEqual(success.get(1).activity, undefined, 'the mast/unload pose is unchanged');
        assert.strictEqual(success.get(1).x + success.get(1).y, 0, 'the cargo attachment does not move');
        assert.strictEqual(success.get(1).caption, 'Nailed it.');
        const held = model.update(160, group);
        assert.strictEqual(held.get(1).tilt, 0, 'satisfaction does not tilt a mast away from its deposited cargo');
        const returning = model.update(300, group.map(value => ({ ...value, phase: 'return' })));
        assert.strictEqual(returning.get(1).activity, 'celebrate');
        assert.strictEqual(returning.get(2).activity, 'celebrate');
        model.update(340, group, [[1, 2]]);
        assert.strictEqual(model.snapshot().counts.success, 1);
    });

    it('drops reaction ownership on promotion/removal and bounds retained actor/pair state', () => {
        const { model } = owner();
        approach(model);
        assert.ok(model.snapshot().active);
        model.forget(1);
        assert.strictEqual(model.snapshot().active, undefined);
        assert.strictEqual(model.snapshot().trackedActors, 1);
        model.update(80, Array.from({ length: 50 }, (_, index) => actor(index + 1, index * 2)));
        assert.strictEqual(model.snapshot().trackedActors, 12);
        assert.ok(model.snapshot().trackedPairs <= 66);
        model.clear();
        assert.deepStrictEqual([model.snapshot().trackedActors, model.snapshot().trackedPairs], [0, 0]);
        model.reset();
        assert.strictEqual(model.snapshot().attempts, 0);
        assert.deepStrictEqual(Object.values(model.snapshot().counts), [0, 0, 0, 0]);
    });

    it('keeps the requested Croatian phrases and historic model identities in one collection', () => {
        const lines = module.ROBOT_ENCOUNTER_DIALOGUE.flatMap((dialogue: any) => dialogue.lines);
        for (const line of ['ovako fino ne bi ni Marić izbrusio', 'zgrabio sam ga kao SofIA', 'bolje prošlo nego MBZIRC',
            'možda mi Matko nešto fino skuha', 'možda mi Ćaća nešto fino skuha']) {
            assert.ok(lines.includes(line));
        }
        assert.deepStrictEqual(module.ROBOT_BOOK_CHARACTERS.pioneer.names, ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']);
        assert.strictEqual(module.ROBOT_BOOK_CHARACTERS.scoutMini.model, 'Agilex Scout Mini');
        assert.strictEqual(module.ROBOT_BOOK_CHARACTERS.aircraft.veteran, 'EagleRed');
        assert.deepStrictEqual(module.ROBOT_BOOK_CHARACTERS.aircraft.colors, ['Red', 'Yellow', 'Blue', 'Green', 'Orange', 'Purple']);
        const scout = module.ROBOT_ENCOUNTER_DIALOGUE.find((dialogue: any) => dialogue.id === 'bump-scout');
        assert.ok(scout.lines[0].includes('Scout Mini') && scout.source.includes('9336'));
        assert.ok(module.ROBOT_ENCOUNTER_DIALOGUE.every((dialogue: any) => dialogue.lines.every((line: string) => line.length <= 120)));
        assert.ok(lines.includes('Pivo poslije smjene?'));
    });

    it('rescues a light advance robot within its existing deadline and keeps the aircraft attached', () => {
        const { model } = owner([0, 0]);
        const crew = [actor(1, 0, 100, { vehicle: 'lugv', scale: 1, remainingMs: 1450 }),
            actor(2, 180, 40, { vehicle: 'quad', scale: 1, remainingMs: 1450 })];
        model.update(0, crew);
        model.update(40, crew.map(value => ({ ...value, x: value.x + 2, remainingMs: 1410 })));
        const incident = model.snapshot().active;
        assert.strictEqual(incident?.kind, 'rescue');
        assert.strictEqual(incident.rescue.kind, 'airlift');
        assert.strictEqual(incident.rescue.enjoysAirlift, true);
        assert.ok(incident.ends <= 1450, 'rescue fits the existing advance lifetime');
        const at = incident.started + (incident.ends - incident.started) * 0.6;
        const pose = model.update(at, crew);
        assert.strictEqual(pose.get(1).carried, true);
        assert.strictEqual(pose.get(1).expression, 'pleased');
        const ground = { x: crew[0].x + pose.get(1).x, y: crew[0].y + pose.get(1).y };
        const air = { x: crew[1].x + pose.get(2).x, y: crew[1].y + pose.get(2).y };
        assert.ok(Math.abs(air.x - ground.x) < 1e-8);
        assert.ok(Math.abs(air.y - ground.y + 38.6) < 1e-8, 'actual artwork grab points stay aligned');
        assert.strictEqual(model.update(incident.ends, crew.map(value => ({ ...value, phase: 'parked' }))).size, 0);
        assert.strictEqual(model.snapshot().active, undefined);
    });

    it('rolls once for a rescue cohort and never borrows cargo, late returns, or an undersized carrier', () => {
        const no = owner([0.99]);
        const crew = [actor(1, 0, 100, { vehicle: 'lugv', scale: 1 }), actor(2, 180, 40, { vehicle: 'quad', scale: 1 })];
        no.model.update(0, crew);
        for (let frame = 1; frame <= 100; frame++) { no.model.update(frame * 40, crew.map(value => ({ ...value, x: value.x + frame }))); }
        assert.strictEqual(no.calls(), 1, 'repeated movement does not accumulate rescue chance');
        for (const override of [{ phase: 'deposit' }, { phase: 'return' }, { phase: 'parked' }, { remainingMs: 800 }]) {
            const f = owner([0]); const blocked = crew.map(value => ({ ...value, ...override }));
            f.model.update(0, blocked); f.model.update(40, blocked.map(value => ({ ...value, x: value.x + 2 })));
            assert.strictEqual(f.model.snapshot().active, undefined, JSON.stringify(override));
        }
        const heavy = owner([0, 0]);
        const pair = [actor(1, 0, 100, { vehicle: 'rover', scale: 1 }), actor(2, 180, 40, { vehicle: 'quad', scale: 1 })];
        heavy.model.update(0, pair); heavy.model.update(40, pair.map(value => ({ ...value, x: value.x + 2 })));
        assert.strictEqual(heavy.model.snapshot().active?.rescue.kind, 'repair', 'EagleRed cannot lift VIV');
        heavy.model.forget(1);
        assert.strictEqual(heavy.model.snapshot().active, undefined, 'promotion or cancellation drops the whole rescue');
        heavy.model.clear();
        assert.strictEqual(heavy.model.snapshot().trackedRescueActors, 0);
    });

    it('lets distinct loaded couriers react while keeping one cooperative team out of self-collision', () => {
        const { model } = owner([0.1, 0.5, 0]);
        const first = [actor(1, 0, 0, { phase: 'cargo', group: 10 }), actor(2, 110, 0, { phase: 'cargo', group: 20 })];
        model.update(0, first);
        const reaction = model.update(40, [{ ...first[0], x: 30 }, { ...first[1], x: 80 }]);
        assert.strictEqual(model.snapshot().active.kind, 'near-miss');
        assert.strictEqual(reaction.size, 2, 'delivery ownership does not suppress conversation or avoidance');
        const team = owner([0]);
        team.model.update(0, first.map(actor => ({ ...actor, group: 10 })));
        assert.strictEqual(team.model.update(40, first.map(actor => ({ ...actor, x: 50, group: 10 }))).size, 0);
    });

    it('admits a loaded light-robot rescue before deposit but never lifts a mixed heavy formation', () => {
        const { model } = owner([0, 0]);
        const crew = [actor(1, 0, 100, { phase: 'cargo', group: 10, vehicle: 'lugv', scale: 1 }),
            actor(2, 180, 40, { phase: 'cargo', group: 20, vehicle: 'quad', scale: 1 })];
        model.update(0, crew); model.update(40, crew.map(actor => ({ ...actor, x: actor.x + 2 })));
        assert.strictEqual(model.snapshot().active?.rescue.kind, 'airlift');
        const mixed = owner([0, 0]);
        const all = [...crew, actor(3, -30, 100, { phase: 'cargo', group: 10, vehicle: 'rover', scale: 1 })];
        mixed.model.update(0, all); mixed.model.update(40, all.map(actor => ({ ...actor, x: actor.x + 2 })));
        assert.notStrictEqual(mixed.model.snapshot().active?.rescue?.kind, 'airlift', 'VIV cannot be lifted through another group member');
        const clipped = owner([0, 0]);
        const offscreen = all.map(actor => actor.id === 3 ? { ...actor, opacity: 0 } : actor);
        clipped.model.update(0, offscreen); clipped.model.update(40, offscreen.map(actor => ({ ...actor, x: actor.x + 2 })));
        assert.notStrictEqual(clipped.model.snapshot().active?.rescue?.kind, 'airlift',
            'offscreen members still belong to the same rigid load and cannot disappear from capability accounting');
    });
});
