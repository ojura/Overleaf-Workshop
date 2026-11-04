import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('mass-aware finite robot rescues', function () {
    this.timeout(30_000);
    let directory: string, rescue: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-robot-rescue-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/robot-rescue.ts')],
                outfile: path.join(directory, 'rescue.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022' });
            rescue = await importModule(path.join(directory, 'rescue.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });
    const actor = (id: number, vehicle: string, x = id * 20, y = 0) => ({ id, vehicle, x, y });
    const plan = (disabled: any, available: any[], options: { maxHelpers: number; remainingMs: number; carriedGroup?: readonly string[] } =
        { maxHelpers: 2, remainingMs: 3000 }) =>
        rescue.planRobotRescue(disabled, available, options);

    it('keeps VIV and EKO-KOMVOZ above all other ground masses and outside every aircraft lift capacity', () => {
        const capabilities = rescue.ROBOT_RESCUE_CAPABILITIES;
        for (const heavy of ['rover', 'ekokomvoz']) {
            for (const [name, capability] of Object.entries(capabilities) as [string, any][]) {
                if (capability.mobility === 'air') { assert.strictEqual(rescue.canCarryRobot(name, heavy), false); }
                if (capability.mobility === 'ground' && !['rover', 'ekokomvoz'].includes(name)) {
                    assert.ok(capabilities[heavy].mass > capability.mass);
                }
            }
        }
        assert.strictEqual(rescue.canCarryRobot('quad', 'lugv'), true);
        assert.strictEqual(rescue.canCarryRobot('quad', 'mecanum'), false);
        assert.strictEqual(rescue.canCarryRobot('heavyquad', 'mecanum'), true);
        assert.strictEqual(rescue.canCarryRobot('lugv', 'quad'), false);
    });

    it('lets L-UGV choose a qualified aircraft over a nearer ground rescue and enjoy the flight', () => {
        const result = plan(actor(0, 'lugv', 0), [actor(1, 'forklift', 1), actor(2, 'quad', 80)]);
        assert.strictEqual(result.kind, 'airlift'); assert.deepStrictEqual(result.helpers, [2]);
        assert.strictEqual(result.enjoysAirlift, true); assert.ok(result.capacity >= result.mass);
        assert.deepStrictEqual(result.participantIds, [0, 2]);
    });

    it('rejects a closer undersized aircraft and selects the capable carrier', () => {
        const result = plan(actor(0, 'mecanum', 0), [actor(1, 'quad', 1), actor(2, 'heavyquad', 100)]);
        assert.strictEqual(result.kind, 'airlift'); assert.deepStrictEqual(result.helpers, [2]);
        assert.strictEqual(result.enjoysAirlift, false);
    });

    it('assigns a substantial single tow or a sufficient two-vehicle team to bulky casualties', () => {
        const single = plan(actor(0, 'ekokomvoz', 0), [actor(1, 'rover', 50), actor(2, 'forklift', 1)]);
        assert.strictEqual(single.kind, 'tow'); assert.deepStrictEqual(single.helpers, [1]);
        const team = plan(actor(0, 'rover', 0), [actor(1, 'forklift', 50), actor(2, 'mecanum', 10)]);
        assert.strictEqual(team.kind, 'tow'); assert.deepStrictEqual(team.helpers, [2, 1]);
        assert.ok(team.capacity >= team.mass); assert.strictEqual(new Set(team.participantIds).size, 3);
    });

    it('accounts for every member of a loaded casualty group before choosing a rescue', () => {
        const options = { maxHelpers: 2, remainingMs: 3000, carriedGroup: ['lugv', 'rover'] };
        const heavy = plan(actor(0, 'lugv', 0), [actor(1, 'heavyquad', 1), actor(2, 'forklift', 2)], options);
        assert.strictEqual(heavy.kind, 'repair', 'a light member cannot authorize lifting or towing its heavy team');
        assert.strictEqual(heavy.mass, 10); assert.strictEqual(heavy.capacity, 0);
        const tow = plan(actor(0, 'lugv', 0), [actor(1, 'heavyquad', 1), actor(2, 'forklift', 2), actor(3, 'mecanum', 3)], options);
        assert.strictEqual(tow.kind, 'tow'); assert.deepStrictEqual(tow.helpers, [2, 3]);
        assert.ok(tow.capacity >= tow.mass);
        const bulky = plan(actor(0, 'ekokomvoz', 0), [actor(1, 'rover', 1), actor(2, 'forklift', 2)],
            { maxHelpers: 2, remainingMs: 3000, carriedGroup: ['ekokomvoz', 'rover'] });
        assert.strictEqual(bulky.kind, 'repair'); assert.strictEqual(bulky.mass, 19);
    });

    it('permits a sufficient group airlift only when every carried member is grounded', () => {
        const group = Object.freeze(['lugv', 'hexapod']);
        const options = Object.freeze({ maxHelpers: 2, remainingMs: 3000, carriedGroup: group });
        const result = plan(actor(0, 'lugv', 0), [actor(1, 'quad', 1), actor(2, 'heavyquad', 2)], options);
        assert.strictEqual(result.kind, 'airlift'); assert.deepStrictEqual(result.helpers, [2]);
        assert.strictEqual(result.mass, 3); assert.strictEqual(result.capacity, 3); assert.strictEqual(result.enjoysAirlift, true);
        assert.deepStrictEqual(group, ['lugv', 'hexapod']);
        const airborne = plan(actor(0, 'lugv', 0), [actor(1, 'heavyquad', 1)],
            { maxHelpers: 2, remainingMs: 3000, carriedGroup: ['lugv', 'quad'] });
        assert.strictEqual(airborne.kind, 'repair', 'a rigid group containing an aircraft is not carried as a ground vehicle');
        assert.strictEqual(airborne.mass, 2);
    });

    it('rejects incomplete, malformed or oversized casualty groups instead of undercounting them', () => {
        const sparse = Array(2); sparse[0] = 'lugv';
        for (const group of [[], ['rover'], ['lugv', 'unknown'], sparse,
            Array(13).fill('lugv'), 'lugv', null]) {
            assert.strictEqual(plan(actor(0, 'lugv'), [actor(1, 'heavyquad')],
                { maxHelpers: 2, remainingMs: 3000, carriedGroup: group as any }), undefined);
        }
        const largest = plan(actor(0, 'lugv'), [actor(1, 'heavyquad')],
            { maxHelpers: 2, remainingMs: 3000, carriedGroup: Array(12).fill('lugv') });
        assert.strictEqual(largest.kind, 'repair'); assert.strictEqual(largest.mass, 12);
        const singleton = plan(actor(0, 'lugv'), [actor(1, 'quad')],
            { maxHelpers: 2, remainingMs: 3000, carriedGroup: ['lugv'] });
        assert.deepStrictEqual(singleton, plan(actor(0, 'lugv'), [actor(1, 'quad')]));
    });

    it('repairs in place when helper capacity or the actor budget cannot support transport', () => {
        const small = plan(actor(0, 'ekokomvoz', 0), [actor(1, 'quad', 1), actor(2, 'lugv', 2)]);
        assert.strictEqual(small.kind, 'repair'); assert.deepStrictEqual(small.helpers, [1, 2]);
        assert.strictEqual(small.capacity, 0); assert.strictEqual(small.enjoysAirlift, false);
        const compact = plan(actor(0, 'rover', 0), [actor(1, 'forklift', 1), actor(2, 'mecanum', 2)],
            { maxHelpers: 1, remainingMs: 2000 });
        assert.strictEqual(compact.kind, 'repair'); assert.deepStrictEqual(compact.helpers, [1]);
    });

    it('chooses the nearest sufficient tow team with stable tie ordering and no duplicate owners', () => {
        const available = [actor(1, 'forklift', 200), actor(2, 'mecanum', 20), actor(3, 'forklift', 30),
            actor(3, 'forklift', 0), actor(0, 'rover', 0), actor(4, 'mecanum', 20)];
        const result = plan(actor(0, 'rover', 0), available);
        assert.strictEqual(result.kind, 'tow'); assert.deepStrictEqual(result.helpers, [2, 3]);
        assert.deepStrictEqual(plan(actor(0, 'rover', 0), available).helpers, result.helpers);
    });

    it('never exceeds helper, candidate or lifetime bounds and does not schedule work for an empty crew', () => {
        const policy = rescue.ROBOT_RESCUE_POLICY;
        assert.strictEqual(plan(actor(0, 'lugv'), []), undefined);
        assert.strictEqual(plan(actor(0, 'lugv'), [actor(1, 'quad')], { maxHelpers: 0, remainingMs: 3000 }), undefined);
        assert.strictEqual(plan(actor(0, 'lugv'), [actor(1, 'quad')],
            { maxHelpers: 1, remainingMs: policy.minDurationMs + policy.endMarginMs - 1 }), undefined);
        const exact = plan(actor(0, 'lugv'), [actor(1, 'quad')],
            { maxHelpers: 1, remainingMs: policy.minDurationMs + policy.endMarginMs });
        assert.strictEqual(exact.durationMs, policy.minDurationMs);
        const full = plan(actor(0, 'ekokomvoz'), [actor(1, 'quad'), actor(2, 'quad'), actor(3, 'quad')],
            { maxHelpers: 999, remainingMs: 100_000 });
        assert.strictEqual(full.durationMs, policy.maxDurationMs); assert.strictEqual(full.helpers.length, policy.maxHelpers);
        const bounded = Array.from({ length: policy.maxCandidates }, (_, index) => actor(index + 1, 'quad'));
        bounded.push(actor(99, 'rover', 0));
        assert.strictEqual(plan(actor(0, 'ekokomvoz'), bounded).kind, 'repair', 'selection never scans beyond its cap');
        const fractions = Object.values(exact.phases) as number[];
        assert.ok(fractions.every((value, index) => value > (fractions[index - 1] ?? 0) && value < 1));
    });

    it('ignores invalid candidates and refuses invalid disabled geometry or non-finite time', () => {
        assert.strictEqual(plan(actor(0, 'lugv', NaN), [actor(1, 'quad')]), undefined);
        assert.strictEqual(plan(actor(0, 'lugv'), [actor(1, 'quad')], { maxHelpers: 1, remainingMs: Infinity }), undefined);
        assert.strictEqual(plan(actor(0, 'lugv'), [actor(1, 'quad')], { maxHelpers: 1.5, remainingMs: 2000 }), undefined);
        const result = plan(actor(0, 'lugv'), [actor(1, 'unknown'), actor(2, 'quad', Infinity), actor(3, 'quad')]);
        assert.deepStrictEqual(result.helpers, [3]);
        assert.strictEqual(rescue.canCarryRobot('constructor', 'lugv'), false);
        assert.strictEqual(rescue.canCarryRobot('quad', '__proto__'), false);
    });

    it('does not mutate input actors or return references to their ownership arrays', () => {
        const disabled = Object.freeze(actor(0, 'lugv'));
        const helper = Object.freeze(actor(1, 'quad'));
        const available = Object.freeze([helper]);
        const result = rescue.planRobotRescue(disabled, available, Object.freeze({ maxHelpers: 2, remainingMs: 3000 }));
        result.helpers[0] = 42;
        assert.strictEqual(helper.id, 1); assert.deepStrictEqual(result.participantIds, [0, 1]);
        assert.ok(Object.isFrozen(rescue.ROBOT_RESCUE_CAPABILITIES));
        assert.ok(Object.values(rescue.ROBOT_RESCUE_CAPABILITIES).every(Object.isFrozen));
    });
});
