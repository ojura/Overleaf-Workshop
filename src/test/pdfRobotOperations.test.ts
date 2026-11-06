import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('structural robot teams and owned operations', function () {
    this.timeout(30_000);
    let directory: string, api: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-robot-operations-'));
        try {
            await esbuild.build({ entryPoints: ['robot-structure', 'robot-operations', 'robot-cargo-operations'].map(name =>
                path.join(repo, 'views/pdf-viewer/src/common/' + name + '.ts')), outdir: directory,
            outExtension: Object.fromEntries([['.js', '.mjs']]), bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
            api = { ...await importModule(path.join(directory, 'robot-structure.mjs')),
                ...await importModule(path.join(directory, 'robot-operations.mjs')),
                ...await importModule(path.join(directory, 'robot-cargo-operations.mjs')) };
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });
    const member = (id: number, vehicle = 'quad', commitments: any[] = []) => ({ id, vehicle, commitments });
    const load = (cargo: number, supporters = [1], role = 'carry', extra: any = {}) => ({ id: 'cargo', cargo, supporters, role, ...extra });
    const operation = (loads: any[], extra: any = {}) => ({ key: '1:9:delivery:0.1:0.2:0.3:0.4', goal: 'delivery', preferredCrew: 1,
        phases: [{ id: 'transport', until: 1, loads }], ...extra });
    const timing = { startedAt: 100, workEnd: 1000, aftermathEnd: 1400, deadline: 1900 };
    const commit = (spec: any, members: any[], seed = 1, shortage = true) =>
        api.commitRobotOperation(spec, members, { seed, shortage, timing });
    const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

    it('derives correlated carrying, traction and lifting from the shared structures', () => {
        for (const [vehicle, value] of Object.entries(api.ROBOT_STRUCTURES) as [string, any][]) {
            const capability = api.robotCapabilities(vehicle);
            near(capability.mass, value.mass);
            near(capability.tow, value.mass * api.ROBOT_STRUCTURE_POLICY.traction[value.traction]);
            near(capability.lift, value.mass * api.ROBOT_STRUCTURE_POLICY.lifting[value.liftMechanism]);
            near(capability.carry, value.mobility === 'air' ? capability.lift : value.mass);
            assert.ok(Object.isFrozen(value) && Object.isFrozen(value.personality) && Object.isFrozen(value.attachments));
        }
        assert.strictEqual(api.robotSupport('ekokomvoz', 'carry'), 10);
        assert.strictEqual(api.robotSupport('ekokomvoz', 'lift', 'fork'), 0);
        assert.strictEqual(api.robotSupport('forklift', 'lift', 'fork'), 3);
        assert.strictEqual(api.robotSupport('rover', 'tow'), 10);
        assert.strictEqual(api.robotSupport('quad', 'tow'), 0);
        assert.strictEqual(api.robotStructure('constructor'), undefined);
        assert.strictEqual(api.robotCapabilities('__proto__'), undefined);
    });

    it('owns propulsion energy and servicing alongside the shared robot structure', () => {
        assert.deepStrictEqual(api.robotStructure('heavyquad').energy, { source: 'petrol', service: 'refuel', serviceLabel: 'Refuelling' });
        assert.deepStrictEqual(api.robotStructure('quad').energy, { source: 'battery', service: 'charge', serviceLabel: 'Charging' });
        assert.ok(Object.values(api.ROBOT_STRUCTURES).every((value: any) => Object.isFrozen(value.energy)));
        assert.strictEqual(api.robotCapabilities('heavyquad').lift, 3);
        assert.strictEqual(api.robotCapabilities('heavyquad').carry, 3);
    });

    it('authors one relative MORUS presentation scale independently of its operation capabilities', () => {
        assert.strictEqual(api.robotPresentationScale('heavyquad'), 2.5);
        assert.strictEqual(api.robotPresentationScale('quad'), 1);
        assert.strictEqual(api.robotPresentationScale('constructor'), 1);
        const rotorSpanRatio = (64 + 26) / (50 + 26) * api.robotPresentationScale('heavyquad') / api.robotPresentationScale('quad');
        assert.ok(rotorSpanRatio > 2.95 && rotorSpanRatio < 3, 'the authored visual factor represents the remembered relative presence');
        assert.strictEqual(api.robotCapabilities('heavyquad').mass, 3);
        assert.strictEqual(api.robotCapabilities('heavyquad').lift, 3);
    });

    it('expresses reverse aversion and carrier affinity as personality affordances', () => {
        const lugv = api.robotStructure('lugv').personality;
        assert.ok(lugv.reverseAversion > 0 && lugv.carrierAffinity > 0);
        assert.strictEqual(api.robotStructure('mecanum').personality.reverseAversion, 0);
        assert.ok(Object.values(api.ROBOT_STRUCTURES).every((value: any) => value.personality.emergencyBoldness > 0));
    });

    it('uses the same CSS workload for images, collages, portions and mixed fragments across density and rotation', () => {
        for (const zoom of [0.5, 1, 1.5, 2, 3, 4]) {
            const size = { width: 240 * zoom, height: 180 * zoom };
            const expected = api.robotCargoWorkload(size);
            for (const dpr of [1, 1.2, 2, 3]) {
                for (const kind of ['image', 'collage', 'portion', 'fragment']) {
                    assert.deepStrictEqual(api.robotCargoWorkload({ ...size, dpr, kind }), expected);
                }
            }
            assert.deepStrictEqual(api.robotCargoWorkload({ width: size.height, height: size.width }), expected);
            assert.strictEqual(expected.preferredCrew, Math.min(3, Math.max(1, Math.ceil(expected.mass))));
        }
        assert.strictEqual(api.robotCargoWorkload({ width: 0, height: 200 }), undefined);
        assert.strictEqual(api.robotCargoWorkload({ width: Infinity, height: 200 }), undefined);
    });

    it('aggregates simultaneous formation support while assessing each handoff carrier separately', () => {
        const members = [member(1), member(2)];
        const formation = api.assessRobotOperation(operation([load(1.5, [1, 2])], { preferredCrew: 2 }), members);
        assert.ok(formation.normalAdmissible); near(formation.aggregateSupport, 2); near(formation.peakStrain, 0.75);
        const handoff = api.assessRobotOperation(operation([], { preferredCrew: 2, phases: [
            { id: 'incoming', until: 0.5, loads: [load(1.5, [1])] },
            { id: 'outgoing', until: 1, loads: [load(1.5, [2])] },
        ] }), members);
        assert.ok(handoff.compatible && !handoff.normalAdmissible && handoff.preferredCrewMet);
        near(handoff.peakStrain, 1.5); near(handoff.aggregateSupport, 1);
    });

    it('assesses the chassis and active fork mechanism for the same load', () => {
        const result = api.assessRobotOperation(operation([], { phases: [
            { id: 'drive', until: 0.6, loads: [load(4)] },
            { id: 'lift', until: 1, loads: [load(4, [1], 'lift', { attachment: 'fork' })] },
        ] }), [member(1, 'forklift')]);
        assert.ok(result.compatible && !result.normalAdmissible);
        near(result.phases[0].peakStrain, 0.8); near(result.phases[1].peakStrain, 4 / 3);
        const truck = api.assessRobotOperation(operation([load(1, [1], 'lift', { attachment: 'fork' })]), [member(1, 'ekokomvoz')]);
        assert.ok(!truck.compatible && truck.reasons.includes('attachment-unavailable'));
    });

    it('charges the body and its attached photograph to an airlift while checking ground bearing', () => {
        const request = operation([load(2, [1]), load(2, [2], 'lift', { id: 'carried-body', bodies: ['lugv'], attachment: 'sling' })]);
        const result = api.assessRobotOperation(request, [member(1, 'lugv'), member(2, 'heavyquad')]);
        near(result.phases[0].loads[1].demand, 3); near(result.phases[0].loads[1].support, 3);
        assert.ok(!result.normalAdmissible, 'the ground member still bears its own attached photograph');
        near(result.peakStrain, 2);
        const bigger = api.assessRobotOperation(operation([load(0.5, [1], 'lift', { bodies: ['mecanum'] })]), [member(1, 'heavyquad')]);
        near(bigger.demand, 3.5); assert.ok(!bigger.normalAdmissible);
    });

    it('debits the actual assigned existing cargo before a helper takes another role', () => {
        const spec = operation([load(1, [1], 'lift')]);
        const empty = api.assessRobotOperation(spec, [member(1, 'heavyquad')]);
        const loaded = api.assessRobotOperation(spec, [member(1, 'heavyquad', [{ key: 'owned-photo', role: 'carry', load: 2.5 }])]);
        assert.ok(empty.normalAdmissible); near(empty.peakStrain, 1 / 3);
        assert.ok(loaded.compatible && !loaded.normalAdmissible); near(loaded.aggregateSupport, 0.5); near(loaded.peakStrain, 2);
        const towing = api.assessRobotOperation(operation([load(9, [1], 'tow')]),
            [member(1, 'rover', [{ key: 'owned-photo', role: 'carry', load: 4.5 }])]);
        near(towing.aggregateSupport, 8.75); assert.ok(!towing.normalAdmissible);
    });

    it('accounts for two simultaneous loads using the same mechanism together', () => {
        const result = api.assessRobotOperation(operation([load(2, [1]), load(2, [1], 'lift', { id: 'second' })]), [member(1, 'heavyquad')]);
        assert.ok(result.compatible && !result.normalAdmissible); near(result.peakStrain, 4 / 3);
    });

    it('assesses the whole supporting interval when an existing handoff changes its assigned load', () => {
        const spec = operation([load(1, [1], 'lift')]);
        const helper = member(1, 'heavyquad');
        const empty = api.assessRobotOperation(spec, [helper]);
        assert.ok(empty.normalAdmissible);
        const windows = [{ until: 0.3, commitments: [] },
            { until: 0.8, commitments: [{ key: 'handoff-photo', role: 'carry', load: 2.5 }] },
            { until: 1, commitments: [] }];
        const occupied = api.assessRobotOperation(spec, [{ ...helper, commitmentWindows: windows }]);
        assert.ok(occupied.compatible && !occupied.normalAdmissible, 'a currently free helper still owes its later handoff load');
        assert.deepStrictEqual(occupied.phases.map((phase: any) => phase.until), [0.3, 0.8, 1]);
        near(occupied.phases[0].peakStrain, 1 / 3);
        near(occupied.phases[1].peakStrain, 2);
        near(occupied.phases[2].peakStrain, 1 / 3);
        near(commit(spec, [{ ...helper, commitmentWindows: windows }], 1).assessment.peakStrain, 2);
        for (const invalid of [[], [{ until: 0.8, commitments: [] }],
            [{ until: 0.8, commitments: [] }, { until: 0.4, commitments: [] }]]) {
            assert.ok(!api.assessRobotOperation(spec, [{ ...helper, commitmentWindows: invalid }]).compatible);
        }
    });

    it('applies shared effort coupling to simultaneous new roles as well as existing commitments', () => {
        const result = api.assessRobotOperation(operation([load(5), load(3, [1], 'lift', { id: 'fork', attachment: 'fork' })]),
            [member(1, 'forklift')]);
        assert.ok(result.compatible && !result.normalAdmissible);
        near(result.peakStrain, 1.25);
    });

    it('requires positive remaining support from each nominated crew member', () => {
        for (const first of [{ ...member(1), condition: 0 }, member(1, 'quad', [{ key: 'occupied', role: 'carry', load: 1 }])]) {
            const spec = operation([load(2, [1, 2])], { preferredCrew: 2 });
            const result = api.assessRobotOperation(spec, [first, member(2, 'heavyquad')]);
            assert.ok(!result.compatible && result.reasons.includes('committed-capacity'));
            assert.strictEqual(commit(spec, [first, member(2, 'heavyquad')], 246).accepted, false);
        }
    });

    it('keeps desired crew distinct from a qualified volunteer and its attachment requirements', () => {
        const spec = operation([load(6, [1])], { preferredCrew: 3 });
        const members = [member(1, 'ekokomvoz')];
        const assessment = api.assessRobotOperation(spec, members);
        assert.ok(assessment.normalAdmissible && !assessment.preferredCrewMet);
        const decisions = Array.from({ length: 100 }, (_, seed) => commit(spec, members, seed));
        assert.ok(decisions.some(value => value.accepted && value.plan.operatingMode === 'volunteer'));
        assert.ok(decisions.some(value => value.reason === 'crew-preference'));
        assert.ok(decisions.filter(value => value.accepted).every(value => value.plan.outcome.family === 'clean-triumph'));
    });

    it('retains the checked joint story rates and a positive extreme success tail', () => {
        const expected = [[2, 0.04466087588772172, 0.5], [5, 0.01125759142344529, 0.5],
            [10, 0.0039723011211659776, 0.5]];
        for (const [rho, attempt, fulfillment] of expected) {
            const result = api.robotOperationProbabilities(rho, true);
            near(result.attempt, attempt); near(result.fulfillment, fulfillment);
            assert.ok(result.cleanGivenFulfillment > 0 && result.cleanGivenFulfillment < 1);
            assert.ok(api.robotOperationProbabilities(rho, false).attempt > 0, 'opportunity remains an available motive');
        }
        const extreme = api.robotOperationProbabilities(1e12, true);
        assert.ok(extreme.attempt > 0 && extreme.fulfillment > 0 && extreme.cleanGivenFulfillment > 0);
        assert.deepStrictEqual(api.robotOperationProbabilities(1, true),
            { attempt: 0, need: 0, opportunity: 0, fulfillment: 1, cleanGivenFulfillment: 1 });
    });

    it('reaches all three extreme tow outcomes through fixed semantic decision seeds', () => {
        const spec = operation([], { key: '3:9:relocation:0.1:0.2:0.3:0.4', goal: 'relocation',
            phases: [{ id: 'tow', until: 1, loads: [load(0, [1], 'tow', { id: 'casualty', bodies: ['ekokomvoz'] })] }] });
        for (const [seed, family] of [[967, 'valiant-failure'], [246, 'expensive-success'], [2850, 'clean-triumph']] as const) {
            const decision = commit(spec, [member(1, 'lugv')], seed);
            assert.ok(decision.accepted); assert.strictEqual(decision.plan.operatingMode, 'overreach');
            assert.strictEqual(decision.plan.effort.peakStrain, 10);
            assert.strictEqual(decision.plan.outcome.family, family);
            assert.strictEqual(decision.plan.timing.deadline, timing.deadline);
            if (family === 'valiant-failure') {
                assert.ok(decision.plan.outcome.progress > 0 && decision.plan.outcome.progress < 0.1);
                assert.strictEqual(decision.plan.outcome.completion, 'partial');
            } else { assert.strictEqual(decision.plan.outcome.completion, 'fulfilled'); }
            assert.strictEqual(decision.plan.outcome.aftermath === 'none', family === 'clean-triumph');
        }
    });

    it('admits the much smaller opportunity motive with its own stable decision', () => {
        const spec = operation([], { key: '3:9:delivery:0.1:0.2:0.3:0.4',
            phases: [{ id: 'carry', until: 1, loads: [load(2)] }] });
        const decision = commit(spec, [member(1, 'lugv')], 1267, false);
        assert.ok(decision.accepted); assert.strictEqual(decision.plan.operatingMode, 'overreach');
        assert.strictEqual(decision.probabilities.need, 0);
        assert.strictEqual(decision.probabilities.attempt, decision.probabilities.opportunity);
        assert.strictEqual(decision.plan.outcome.family, 'expensive-success');
    });

    it('uses independent semantic channels across retries and allocation IDs', () => {
        const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
        const key = api.robotOperationKey(2, 9, 'delivery', crop);
        assert.strictEqual(key, api.robotOperationKey(2, 9, 'delivery', { ...crop }));
        assert.notStrictEqual(key, api.robotOperationKey(3, 9, 'delivery', crop));
        assert.notStrictEqual(key, api.robotOperationKey(2, 9, 'removal', crop));
        assert.notStrictEqual(api.robotOperationRandom(8, key, 'willingness'), api.robotOperationRandom(8, key, 'fulfillment'));
        for (let seed = 0; seed < 100; seed++) {
            const first = commit(operation([load(2)], { key }), [member(1)], seed);
            const next = commit(operation([load(2, [91])], { key }), [member(91)], seed);
            assert.strictEqual(next.accepted, first.accepted);
            assert.strictEqual(next.plan?.outcome.family, first.plan?.outcome.family);
            assert.deepStrictEqual(commit(operation([load(2)], { key }), [member(1)], seed), first);
        }
    });

    it('keeps a shared-role contender stable when its supporters are enumerated in another order', () => {
        const members = [member(1), member(2, 'heavyquad')];
        for (let seed = 0; seed < 128; seed++) {
            const first = commit(operation([load(6, [1, 2])], { preferredCrew: 2 }), members, seed);
            const reordered = commit(operation([load(6, [2, 1])], { preferredCrew: 2 }), [...members].reverse(), seed);
            assert.strictEqual(reordered.accepted, first.accepted, 'crew iteration order preserves willingness for seed ' + seed);
            assert.deepStrictEqual(reordered.plan?.outcome, first.plan?.outcome);
        }
    });

    it('reuses the same canonical narrative record after changing crew, phase and shortage evidence', () => {
        const key = '2:99:delivery:0.1:0.1:0.6:0.4';
        const record = api.robotOperationDecisionRecord(246, key);
        assert.ok(Object.isFrozen(record));
        for (const seed of [0, 1, 246, 999]) {
            for (const shortage of [false, true]) {
                for (const members of [[member(3, 'quad')], [member(71, 'heavyquad')], [member(8, 'rover'), member(16, 'lugv')]]) {
                    const spec = operation([load(3.2, members.map(value => value.id))], { key, preferredCrew: 3 });
                    const result = api.commitRobotOperation(spec, members, { seed, shortage, timing, decision: record });
                    if (result.plan) { assert.strictEqual(result.plan.decision, record); }
                }
            }
        }
        assert.deepStrictEqual(api.robotOperationDecisionRecord(246, key), record, 'bounded-record eviction regenerates the same purpose draws');
        const wrong = api.commitRobotOperation(operation([load(0.5)]), [member(1)], { seed: 1, shortage: false, timing, decision: record });
        assert.strictEqual(wrong.accepted, false);
    });

    it('plans actual active supports for cargo modes rather than adding waiting members', () => {
        const job = { key: 'cargo:shared', goal: 'delivery', workload: { mass: 1.5, span: 240, preferredCrew: 2 } };
        const members = [member(1, 'quad'), member(2, 'lugv')];
        const formation = api.assessRobotOperation(api.robotCargoOperation(job, 'formation', members), members);
        assert.ok(formation.normalAdmissible); near(formation.peakStrain, 0.75);
        const handoff = api.assessRobotOperation(api.robotCargoOperation(job, 'handoff', members), members);
        assert.ok(!handoff.normalAdmissible); near(handoff.peakStrain, 1.5);
        const lifted = [member(1, 'lugv'), member(2, 'heavyquad')];
        const airlift = api.assessRobotOperation(api.robotCargoOperation(job, 'airlift', lifted), lifted);
        const sling = airlift.phases[1].loads.find((value: any) => value.id === 'sling');
        near(sling.demand, 2.5); assert.deepStrictEqual(sling.members.map((value: any) => value.member), [2]);
        assert.ok(!airlift.normalAdmissible, 'the lifted ground body still bears its own photograph');
    });

    it('keeps a fork proposal and ordinary qualified teams in the same canonical transaction', () => {
        const job = { key: 'cargo:lower', goal: 'delivery', workload: { mass: 3.2, span: 384, preferredCrew: 3 } };
        const values = api.robotCargoCandidates(job, ['forklift', 'quad', 'heavyquad', 'tiltwing'].map(vehicle => ({ vehicle })),
            { seed: 1, preferredMode: 'solo', preferredHelpers: 1, maxHelpers: 3, ground: true });
        assert.ok(values.some((value: any) => value.ground && !value.assessment.normalAdmissible));
        const team = values.find((value: any) => value.mode === 'formation' && value.vehicles.length === 3);
        assert.ok(team.assessment.normalAdmissible && team.assessment.preferredCrewMet);
        assert.ok(values.every((value: any) => value.spec.key === job.key));
    });

    it('keeps small photograph crews proportional before optional stories and staged heavy equipment', () => {
        const workload = api.robotCargoWorkload({ width: 160, height: 120 });
        assert.strictEqual(workload.mass, 0.5);
        assert.strictEqual(workload.preferredCrew, 1);
        const available = Object.entries(api.ROBOT_STRUCTURES).map(([vehicle, value]: [string, any]) =>
            ({ vehicle, staged: value.mass > 2, inUse: value.mass <= 2 }));
        const preferences = [['formation', 2], ['formation', 3], ['handoff', 2], ['airlift', 2]] as const;
        for (let seed = 0; seed < 16; seed++) {
            for (const [preferredMode, preferredHelpers] of preferences) {
                const candidates = api.robotCargoCandidates({ key: 'portrait:small', goal: 'delivery', workload }, available,
                    { seed, preferredMode, preferredHelpers, maxHelpers: 3 });
                const selected = candidates.find((value: any) => value.assessment.normalAdmissible && value.assessment.preferredCrewMet);
                assert.ok(selected, 'a normally capable crew is available');
                assert.strictEqual(selected.vehicles.length, 1, preferredMode + ' must not add helpers to a one-person photograph');
                const structure = api.robotStructure(selected.vehicles[0]);
                assert.ok(structure.mass <= 2 && structure.presentationScale === 1,
                    'small work uses comparably small equipment despite heavy staging and fresh-type preference');
            }
        }
    });

    it('uses structural variety within fitting crews without letting it promote an oversized vehicle', () => {
        const job = { key: 'portrait:variety', goal: 'delivery', workload: api.robotCargoWorkload({ width: 160, height: 120 }) };
        const options = { preferredMode: 'solo', preferredHelpers: 1, maxHelpers: 3 };
        for (let seed = 0; seed < 32; seed++) {
            const comparable = api.robotCargoCandidates(job,
                [{ vehicle: 'quad', inUse: true }, { vehicle: 'hexapod', inUse: false }], { ...options, seed });
            const fresh = comparable.find((value: any) => value.assessment.normalAdmissible && value.assessment.preferredCrewMet);
            assert.deepStrictEqual(fresh.vehicles, ['hexapod'], 'an unused comparable worker keeps the fleet varied');
            const oversized = api.robotCargoCandidates(job,
                [{ vehicle: 'quad', inUse: true }, { vehicle: 'ekokomvoz', staged: true }], { ...options, seed });
            const fitting = oversized.find((value: any) => value.assessment.normalAdmissible && value.assessment.preferredCrewMet);
            assert.deepStrictEqual(fitting.vehicles, ['quad'], 'a fresh structural type or staged body cannot override the workload fit');
        }
    });

    it('scales the same fleet from a small portrait to a large page chunk and retains actual availability fallback', () => {
        const available = [{ vehicle: 'ekokomvoz', staged: true }, { vehicle: 'quad' }, { vehicle: 'lugv' }];
        const options = { seed: 11, preferredMode: 'handoff', preferredHelpers: 2, maxHelpers: 3 };
        const propose = (width: number, height: number, pool = available) => api.robotCargoCandidates({
            key: 'cargo:proportional', goal: 'delivery', workload: api.robotCargoWorkload({ width, height }),
        }, pool, options);
        const ordinary = (values: any[]) => values.find(value => value.assessment.normalAdmissible && value.assessment.preferredCrewMet);
        assert.strictEqual(ordinary(propose(160, 120)).vehicles.length, 1);
        const large = propose(480, 540), selected = ordinary(large);
        assert.deepStrictEqual([...selected.vehicles].sort(), ['ekokomvoz', 'lugv', 'quad']);
        assert.strictEqual(selected.mode, 'formation');
        assert.ok(large.some((value: any) => value.vehicles.length === 1 && value.vehicles[0] === 'ekokomvoz'
            && value.assessment.normalAdmissible && !value.assessment.preferredCrewMet), 'the qualified solo volunteer remains available');
        assert.deepStrictEqual(ordinary(propose(160, 120, [available[0]])).vehicles, ['ekokomvoz'],
            'the same generic policy still works when only the larger machine is available');
        assert.deepStrictEqual(propose(480, 540), propose(480, 540, [...available].reverse()),
            'input roster order does not change the ranked proposals');
    });

    it('applies the same workload and exceptional opportunity to removal without inventing a handoff phase', () => {
        const workload = { mass: 2, span: 320, preferredCrew: 2 };
        const values = api.robotCargoCandidates({ key: 'removal:one', goal: 'removal', workload }, [{ vehicle: 'quad' }],
            { seed: 1, preferredMode: 'solo', preferredHelpers: 1, maxHelpers: 1 });
        assert.strictEqual(values.length, 1);
        assert.strictEqual(values[0].assessment.peakStrain, 2);
        assert.strictEqual(values[0].spec.goal, 'removal');
        assert.ok(!values.some((value: any) => value.mode === 'handoff' || value.mode === 'airlift'));
    });

    it('owns an immutable phase plan and its assigned shares through completion', () => {
        const spec = operation([load(1.5, [1, 2])], { preferredCrew: 2 });
        const decision = commit(spec, [member(1), member(2)]);
        assert.ok(decision.accepted && Object.isFrozen(decision.plan) && Object.isFrozen(decision.plan.phases[0].loads[0]));
        spec.phases[0].loads[0].supporters.pop();
        assert.deepStrictEqual(decision.plan.phases[0].loads[0].supporters, [1, 2]);
        assert.strictEqual(api.robotOperationCommitments(decision.plan, 1, 0.4)[0].load, 0.75);
        assert.strictEqual(api.robotActivityPhase(decision.plan, 999, false), 'work');
        assert.strictEqual(api.robotActivityPhase(decision.plan, 1300, true), 'aftermath');
        assert.strictEqual(api.robotActivityPhase(decision.plan, 1800, true), 'recovery');
        assert.strictEqual(api.robotActivityPhase(decision.plan, 2200, true), 'complete');
        assert.strictEqual(decision.plan.timing.deadline, 1900);
    });

    it('distinguishes a requested body transport from an optional two-person cargo story', () => {
        const job = { key: 'body-transport:small-photo', goal: 'delivery', workload: api.robotCargoWorkload({ width: 140, height: 100 }) };
        const available = [{ vehicle: 'lugv', staged: true }, { vehicle: 'heavyquad', staged: true }, { vehicle: 'quad' }];
        const options = { seed: 13, preferredMode: 'airlift', preferredHelpers: 2, maxHelpers: 3 };
        const qualified = (values: any[]) => values.filter(value => value.assessment.normalAdmissible && value.assessment.preferredCrewMet);
        const ordinary = qualified(api.robotCargoCandidates(job, available, options))[0];
        assert.strictEqual(ordinary.mode, 'solo', 'an optional story still uses the fitting small courier');
        const transport = qualified(api.robotCargoCandidates(job, available, { ...options, bodyTransport: 'lugv' }))[0];
        assert.strictEqual(transport.mode, 'airlift', 'the committed body move supplies an actual second role');
        assert.strictEqual(transport.vehicles[0], 'lugv');
        assert.strictEqual(transport.fit.transportDifference, 0);
        assert.ok(transport.spec.phases.some((phase: any) => phase.loads.some((load: any) => load.bodies?.includes('lugv'))));
        const fallback = qualified(api.robotCargoCandidates(job, [available[0]], { ...options, bodyTransport: 'lugv' }))[0];
        assert.strictEqual(fallback.mode, 'solo');
        assert.strictEqual(fallback.fit.transportDifference, 1, 'an unavailable carrier retains a valid self-driven fallback');
    });

    it('returns structured compatibility reasons for unavailable roles, duplicates and occupied support', () => {
        assert.ok(!api.assessRobotOperation(operation([load(1, [1], 'lift')]), [member(1, 'lugv')]).compatible);
        assert.ok(!api.assessRobotOperation(operation([load(1, [1, 1])]), [member(1)]).compatible);
        assert.ok(!api.assessRobotOperation(operation([load(1)]), [member(1), member(1)]).compatible);
        const occupied = api.assessRobotOperation(operation([load(1)]), [member(1, 'quad', [{ key: 'owned', role: 'carry', load: 1 }])]);
        assert.ok(!occupied.compatible && occupied.reasons.includes('committed-capacity'));
        const rejected = commit(operation([load(1, [1], 'tow')]), [member(1, 'quad')]);
        assert.strictEqual(rejected.accepted, false); assert.strictEqual(rejected.reason, 'role-unavailable');
    });
});
