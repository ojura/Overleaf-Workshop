import type { RobotVehicle } from './prefetch-robots';
import { ROBOT_CAPABILITIES, robotCapabilities, robotStructure, type RobotCapabilities } from './robot-structure';
import { assessRobotOperation, commitRobotOperation, ROBOT_OPERATION_POLICY, type RobotCommitment, type RobotOperationSpec,
    type RobotOperationPlan } from './robot-operations';

export type RescueVehicle = RobotVehicle | 'ekokomvoz';
type Capability = RobotCapabilities;
/** Compatibility view of the shared, descriptor-derived capabilities. */
export const ROBOT_RESCUE_CAPABILITIES = ROBOT_CAPABILITIES;

export const ROBOT_RESCUE_POLICY = Object.freeze({
    maxHelpers: 2,
    maxCandidates: 12,
    maxCarriedGroup: 12,
    minDurationMs: 900,
    maxDurationMs: 2400,
    endMarginMs: 40,
    maxSparks: 6,
    maxSmokePuffs: 4,
});
export const ROBOT_RESCUE_PHASES = Object.freeze({ sputterEnd: 0.18, rendezvousEnd: 0.42, assistEnd: 0.84 });

export interface RobotRescueActor {
    id: number;
    vehicle: RescueVehicle;
    x: number;
    y: number;
    condition?: number;
    commitments?: readonly RobotCommitment[];
    /** Complete committed-load states with absolute end times, prepared by their existing activity owner. */
    commitmentTimeline?: readonly { until: number; commitments: readonly RobotCommitment[] }[];
}
export interface RobotRescueOptions {
    maxHelpers: number;
    /** All participants must remain owned for this entire interval. */
    remainingMs: number;
    /** Complete rigid casualty group, including the disabled member. The caller excludes its members from helpers. */
    carriedGroup?: readonly RescueVehicle[];
    /** Distinct attached jobs; repeated references from a cooperative casualty crew are charged once. */
    carriedCargo?: readonly { key: string; mass: number }[];
    operationKey?: string;
    seed?: number;
    startedAt?: number;
    allowExceptional?: boolean;
    target?: { x: number; y: number };
}
export interface RobotRescuePlan {
    kind: 'airlift' | 'tow' | 'repair';
    disabled: number;
    helpers: readonly number[];
    participantIds: readonly number[];
    durationMs: number;
    phases: typeof ROBOT_RESCUE_PHASES;
    mass: number;
    capacity: number;
    enjoysAirlift: boolean;
    operation?: RobotOperationPlan;
    goal: { from: { x: number; y: number }; target: { x: number; y: number } };
}

function capability(vehicle: RescueVehicle): Readonly<Capability> | undefined {
    return robotCapabilities(vehicle);
}

/** Shared by ordinary transport and rescue, so a scene cannot bypass the carrying hierarchy. */
export function canCarryRobot(carrier: RescueVehicle, cargo: RescueVehicle, attachedCargo = 0,
    commitments: readonly RobotCommitment[] = []): boolean {
    return assessRobotOperation({ key: 'body-transport:' + carrier + ':' + cargo, goal: 'relocation', preferredCrew: 1,
        phases: [{ id: 'lift', until: 1, loads: [{ id: 'body-and-cargo', role: 'lift', cargo: attachedCargo,
            bodies: [cargo], supporters: [0] }] }] }, [{ id: 0, vehicle: carrier, commitments }]).normalAdmissible;
}

function valid(actor: RobotRescueActor): boolean {
    return !!actor && Number.isSafeInteger(actor.id) && actor.id >= 0 && !!capability(actor.vehicle)
        && Number.isFinite(actor.x) && Number.isFinite(actor.y)
        && (actor.commitmentTimeline === undefined || Array.isArray(actor.commitmentTimeline)
            && actor.commitmentTimeline.length <= ROBOT_OPERATION_POLICY.maxPhases && actor.commitmentTimeline.every((window, index, values) => !!window
                && Number.isFinite(window.until) && (!index || window.until > values[index - 1].until) && Array.isArray(window.commitments)))
        && Math.abs(actor.x) <= Number.MAX_SAFE_INTEGER && Math.abs(actor.y) <= Number.MAX_SAFE_INTEGER;
}

/** Deterministic, bounded selection only. The caller owns leases, chance, movement and time. */
export function planRobotRescue(disabled: RobotRescueActor, available: readonly RobotRescueActor[],
    options: RobotRescueOptions): RobotRescuePlan | undefined {
    if (!valid(disabled) || !Number.isFinite(options.remainingMs) || !Number.isSafeInteger(options.maxHelpers)
        || options.maxHelpers <= 0) { return; }
    if (options.target && (!Number.isFinite(options.target.x) || !Number.isFinite(options.target.y))) { return; }
    const durationMs = Math.min(ROBOT_RESCUE_POLICY.maxDurationMs, options.remainingMs - ROBOT_RESCUE_POLICY.endMarginMs);
    if (durationMs < ROBOT_RESCUE_POLICY.minDurationMs) { return; }
    const group = options.carriedGroup === undefined ? [disabled.vehicle] : options.carriedGroup;
    if (!Array.isArray(group) || group.length < 1 || group.length > ROBOT_RESCUE_POLICY.maxCarriedGroup
        || !group.includes(disabled.vehicle)) { return; }
    const loads: Readonly<Capability>[] = [];
    for (const vehicle of group) {
        const load = capability(vehicle);
        if (!load) { return; }
        loads.push(load);
    }
    const cargo = new Map<string, number>();
    if (!Array.isArray(options.carriedCargo ?? []) || (options.carriedCargo?.length ?? 0) > ROBOT_RESCUE_POLICY.maxCarriedGroup) { return; }
    for (const value of options.carriedCargo ?? []) {
        if (!value?.key || !Number.isFinite(value.mass) || value.mass < 0 || cargo.has(value.key) && cargo.get(value.key) !== value.mass) { return; }
        cargo.set(value.key, value.mass);
    }
    const attachedCargo = [...cargo.values()].reduce((total, mass) => total + mass, 0);
    const mass = loads.reduce((total, load) => total + load.mass, attachedCargo);
    const maxHelpers = Math.min(options.maxHelpers, ROBOT_RESCUE_POLICY.maxHelpers);
    const seen = new Set([disabled.id]);
    const candidates = available.slice(0, ROBOT_RESCUE_POLICY.maxCandidates).filter(actor => {
        if (!valid(actor) || seen.has(actor.id)) { return false; }
        seen.add(actor.id); return true;
    }).map(actor => ({ actor, distance: Math.hypot(actor.x - disabled.x, actor.y - disabled.y),
        capability: capability(actor.vehicle)! }))
        .sort((a, b) => a.distance - b.distance || a.actor.id - b.actor.id);
    if (!candidates.length) { return; }
    const plan = (kind: RobotRescuePlan['kind'], helpers: readonly number[], capacity: number): RobotRescuePlan => ({
        kind, disabled: disabled.id, helpers: [...helpers], participantIds: [disabled.id, ...helpers],
        durationMs, phases: ROBOT_RESCUE_PHASES, mass, capacity,
        enjoysAirlift: kind === 'airlift' && (robotStructure(disabled.vehicle)?.personality.carrierAffinity ?? 0) > 0,
        goal: { from: { x: disabled.x, y: disabled.y }, target: kind === 'repair' ? { x: disabled.x, y: disabled.y }
            : options.target ? { ...options.target } : { x: disabled.x + 40, y: disabled.y } },
    });

    const startedAt = options.startedAt ?? 0;
    if (!Number.isFinite(startedAt)) { return; }
    const proposals: Array<{ kind: 'airlift' | 'tow'; members: Array<RobotRescueActor & { commitmentWindows?: readonly { until: number; commitments: readonly RobotCommitment[] }[] }>;
        spec: RobotOperationSpec;
        assessment: ReturnType<typeof assessRobotOperation>; distance: number }> = [];
    const add = (kind: 'airlift' | 'tow', members: RobotRescueActor[]) => {
        const assessed = members.map(member => {
            if (!member.commitmentTimeline) { return member; }
            const windows: Array<{ until: number; commitments: readonly RobotCommitment[] }> = [];
            for (const window of member.commitmentTimeline) {
                if (window.until <= startedAt) { continue; }
                const until = Math.min(1, (window.until - startedAt) / (durationMs * 0.70));
                windows.push({ until, commitments: window.commitments });
                if (until === 1) { break; }
            }
            if (windows.at(-1)?.until !== 1) { windows.push({ until: 1, commitments: [] }); }
            return { ...member, commitments: undefined, commitmentWindows: windows };
        });
        const spec: RobotOperationSpec = { key: options.operationKey ?? 'relocation:' + disabled.vehicle + ':' + group.join(','),
            goal: 'relocation', preferredCrew: 1, phases: [{ id: kind, until: 1, loads: [{ id: 'casualty',
                role: kind === 'airlift' ? 'lift' : 'tow', attachment: kind === 'airlift' ? 'sling' : 'towline',
                cargo: attachedCargo, bodies: group, supporters: members.map(member => member.id) }] }] };
        const assessment = assessRobotOperation(spec, assessed);
        if (assessment.compatible) { proposals.push({ kind, members: assessed, spec, assessment,
            distance: members.reduce((total, member) => total + Math.hypot(member.x - disabled.x, member.y - disabled.y), 0) }); }
    };
    if (loads.every(load => load.mobility === 'ground')) {
        for (const value of candidates.filter(value => value.capability.mobility === 'air')) { add('airlift', [value.actor]); }
    }
    const ground = candidates.filter(value => value.capability.mobility === 'ground' && value.capability.tow > 0);
    for (const value of ground) { add('tow', [value.actor]); }
    if (maxHelpers >= 2) {
        for (let a = 0; a < ground.length; a++) {
            for (let b = a + 1; b < ground.length; b++) { add('tow', [ground[a].actor, ground[b].actor]); }
        }
    }
    const normal = proposals.filter(value => value.assessment.normalAdmissible)
        .sort((a, b) => Number(b.kind === 'airlift') - Number(a.kind === 'airlift')
            || a.members.length - b.members.length || a.distance - b.distance);
    const extraordinary = proposals.filter(value => !value.assessment.normalAdmissible)
        .sort((a, b) => a.assessment.peakStrain - b.assessment.peakStrain || a.distance - b.distance);
    const commit = (value: typeof proposals[number], shortage: boolean) => {
        const decision = commitRobotOperation(value.spec, value.members, { seed: options.seed ?? 0, shortage,
            allowExceptional: options.allowExceptional === true,
            decisionKey: options.operationKey,
            timing: { startedAt, workEnd: startedAt + durationMs * 0.70,
                aftermathEnd: startedAt + durationMs * ROBOT_RESCUE_PHASES.assistEnd, deadline: startedAt + durationMs } });
        return decision.plan ? { ...plan(value.kind, value.members.map(member => member.id), value.assessment.aggregateSupport),
            operation: decision.plan } : undefined;
    };
    // A transport goal evaluates deliberate effort before its repair fallback. Normal crews ordinarily win.
    const exceptional = extraordinary[0] && options.allowExceptional === true ? commit(extraordinary[0], !normal.length) : undefined;
    if (exceptional) { return exceptional; }
    if (normal[0]) { return commit(normal[0], false); }

    // A small crew can repair a bulky robot without pretending it can lift or tow it.
    return plan('repair', candidates.slice(0, maxHelpers).map(value => value.actor.id), 0);
}
