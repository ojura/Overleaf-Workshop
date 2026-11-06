import type { RobotVehicle } from './prefetch-robots';
import { robotStructure, robotSupport, robotSupportMechanism, ROBOT_STRUCTURE_POLICY,
    type RobotSupportRole, type RobotAttachment } from './robot-structure';

export const ROBOT_OPERATION_POLICY = Object.freeze({
    maxMembers: 12, maxPhases: 12, maxLoadsPerPhase: 12,
    cargoAreaCss: 240 * 180, cargoSpanCss: 320, preferredCargoCrew: 3,
    volunteerChance: 1 / 6,
    shortageMotive: 1 / 8, shortageStrainExponent: 1.5,
    opportunityMotive: 1 / 512, opportunityStrainExponent: 2,
    extraordinaryFulfillment: 0.5, cleanStrainScale: 16, cleanGivenFulfillment: 0.35,
    disablingStrain: 4, maximumFailedProgress: 0.25,
    maxDecisionRecords: 512,
});

export type RobotOperationGoal = 'delivery' | 'removal' | 'relocation' | 'return';
export interface RobotCargoWorkload { mass: number; span: number; preferredCrew: number }
export interface RobotCommitment { key: string; role: RobotSupportRole; load: number; attachment?: RobotAttachment }
/** Complete committed-load state until this fraction of the assessed operation's work interval. */
export interface RobotCommitmentWindow { until: number; commitments: readonly RobotCommitment[] }
export interface RobotOperationMember {
    id: number;
    vehicle: RobotVehicle;
    /** Remaining physical condition before current commitments, in [0, 1]. */
    condition?: number;
    commitments?: readonly RobotCommitment[];
    commitmentWindows?: readonly RobotCommitmentWindow[];
}
export interface RobotPhaseLoad {
    id: string;
    role: RobotSupportRole;
    attachment?: RobotAttachment;
    cargo: number;
    bodies?: readonly RobotVehicle[];
    supporters: readonly number[];
}
export interface RobotOperationPhase {
    id: string;
    /** End of this phase on the operation's work clock, in (0, 1]. */
    until: number;
    loads: readonly RobotPhaseLoad[];
}
export interface RobotOperationSpec {
    key: string;
    goal: RobotOperationGoal;
    /** The handling preference is separate from each phase's actual role/attachment requirements. */
    preferredCrew: number;
    phases: readonly RobotOperationPhase[];
}
export type RobotOperationReason = 'invalid-operation' | 'invalid-member' | 'invalid-load' | 'missing-supporter'
    | 'attachment-unavailable' | 'role-unavailable' | 'committed-capacity' | 'overstrain' | 'crew-preference' | 'willingness';
export interface RobotSupportAssessment {
    member: number;
    vehicle: RobotVehicle;
    role: RobotSupportRole;
    attachment?: RobotAttachment;
    support: number;
    effectiveSupport: number;
    committedEffort: number;
    assignedLoad: number;
    strain: number;
}
export interface RobotLoadAssessment {
    id: string;
    demand: number;
    support: number;
    members: readonly RobotSupportAssessment[];
}
export interface RobotPhaseAssessment {
    id: string;
    until: number;
    loads: readonly RobotLoadAssessment[];
    peakStrain: number;
}
export interface RobotOperationAssessment {
    compatible: boolean;
    normalAdmissible: boolean;
    preferredCrewMet: boolean;
    demand: number;
    aggregateSupport: number;
    peakStrain: number;
    members: readonly number[];
    phases: readonly RobotPhaseAssessment[];
    reasons: readonly RobotOperationReason[];
}
export interface RobotOperationProbabilities {
    attempt: number;
    need: number;
    opportunity: number;
    fulfillment: number;
    cleanGivenFulfillment: number;
}
export interface RobotOperationOutcome {
    family: 'valiant-failure' | 'expensive-success' | 'clean-triumph';
    completion: 'fulfilled' | 'partial' | 'failed';
    aftermath: 'none' | 'strained' | 'smoke' | 'disabled';
    affectedActors: readonly number[];
    recovery: 'self' | 'assisted' | 'release';
    progress: number;
}
export interface RobotActivityTiming { startedAt: number; workEnd: number; aftermathEnd: number; deadline: number }
export interface RobotOperationDecisionRecord { key: string; volunteer: number; willingness: number; fulfillment: number; aftermath: number }
export interface RobotOperationPlan extends RobotOperationSpec {
    operatingMode: 'normal' | 'volunteer' | 'overreach';
    effort: RobotOperationAssessment;
    outcome: RobotOperationOutcome;
    probabilities: RobotOperationProbabilities;
    timing: RobotActivityTiming;
    decision: Readonly<RobotOperationDecisionRecord>;
}
export interface RobotOperationDecision {
    accepted: boolean;
    reason?: RobotOperationReason;
    assessment: RobotOperationAssessment;
    probabilities: RobotOperationProbabilities;
    plan?: RobotOperationPlan;
}

const bounded = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const positive = (value: number) => Number.isFinite(value) && value > 0;
const role = (value: string): value is RobotSupportRole => value === 'carry' || value === 'lift' || value === 'tow';
const validId = (value: number) => Number.isSafeInteger(value) && value >= 0;
type Mechanism = ReturnType<typeof robotSupportMechanism>;
const mechanisms: readonly Mechanism[] = ['bearing', 'lifting', 'traction'];

/** All content kinds use their admitted CSS area/span. Raster quality and display density are separate inputs elsewhere. */
export function robotCargoWorkload(size: { width: number; height: number }): RobotCargoWorkload | undefined {
    if (!positive(size.width) || !positive(size.height) || !Number.isFinite(size.width * size.height)) { return; }
    const span = Math.max(size.width, size.height);
    const mass = Math.max(size.width * size.height / ROBOT_OPERATION_POLICY.cargoAreaCss,
        span / ROBOT_OPERATION_POLICY.cargoSpanCss);
    return { mass, span, preferredCrew: Math.min(ROBOT_OPERATION_POLICY.preferredCargoCrew, Math.max(1, Math.ceil(mass - 1e-12))) };
}

export function robotOperationKey(generation: number, page: number, goal: RobotOperationGoal,
    crop: { x: number; y: number; width: number; height: number }): string {
    return [generation, page, goal, crop.x, crop.y, crop.width, crop.height].join(':');
}

/** Independent purpose channels use semantic ownership and structural contenders, rather than allocation counters. */
export function robotOperationRandom(seed: number, key: string, purpose: string, contender = ''): number {
    let hash = (2166136261 ^ seed) >>> 0;
    for (const character of key + '\0' + purpose + '\0' + contender) {
        hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
    }
    hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15; hash = Math.imul(hash, 0x846ca68b);
    return ((hash ^ hash >>> 16) >>> 0) / 4294967296;
}

function committedEffort(member: RobotOperationMember, mechanism: Mechanism, phaseEnd: number): number {
    let effort = 0;
    const commitments = member.commitmentWindows?.find(window => phaseEnd <= window.until)?.commitments ?? member.commitments ?? [];
    for (const commitment of commitments) {
        const support = robotSupport(member.vehicle, commitment.role, commitment.attachment);
        if (!support && commitment.load) { return 1; }
        const shared = robotSupportMechanism(member.vehicle, commitment.role) === mechanism
            ? 1 : ROBOT_STRUCTURE_POLICY.crossMechanismEffort;
        effort += support ? commitment.load / support * shared : 0;
    }
    return effort;
}

/** Assess simultaneous supports inside each phase and retain the limiting phase/member explicitly. */
export function assessRobotOperation(spec: RobotOperationSpec, members: readonly RobotOperationMember[]): RobotOperationAssessment {
    const reasons = new Set<RobotOperationReason>(), byId = new Map<number, RobotOperationMember>();
    const phases: RobotPhaseAssessment[] = [], participating = new Set<number>();
    let compatible = true, demand = 0, aggregateSupport = 0, peakStrain = 0;
    const fail = (reason: RobotOperationReason) => { reasons.add(reason); compatible = false; };
    if (!spec || !spec.key || !Number.isSafeInteger(spec.preferredCrew) || spec.preferredCrew < 1
        || !Array.isArray(spec.phases) || !spec.phases.length || spec.phases.length > ROBOT_OPERATION_POLICY.maxPhases
        || !Array.isArray(members) || !members.length || members.length > ROBOT_OPERATION_POLICY.maxMembers) {
        fail('invalid-operation');
    }
    for (const member of (Array.isArray(members) ? members : []).slice(0, ROBOT_OPERATION_POLICY.maxMembers)) {
        if (!member || !validId(member.id) || byId.has(member.id) || !robotStructure(member.vehicle)
            || !Number.isFinite(member.condition ?? 1) || (member.condition ?? 1) < 0 || (member.condition ?? 1) > 1
            || !Array.isArray(member.commitments ?? []) || (member.commitments?.length ?? 0) > ROBOT_OPERATION_POLICY.maxLoadsPerPhase) {
            fail('invalid-member'); continue;
        }
        const validate = (values: readonly RobotCommitment[]) => {
            if (!Array.isArray(values) || values.length > ROBOT_OPERATION_POLICY.maxLoadsPerPhase) { fail('invalid-member'); return; }
            const keys = new Set<string>();
            for (const commitment of values) {
                const key = commitment?.key + ':' + commitment?.role + ':' + (commitment?.attachment ?? '');
                if (!commitment?.key || keys.has(key) || !role(commitment.role)
                    || !Number.isFinite(commitment.load) || commitment.load < 0) { fail('invalid-member'); }
                keys.add(key);
            }
        };
        validate(member.commitments ?? []);
        if (member.commitmentWindows) {
            if (!Array.isArray(member.commitmentWindows) || !member.commitmentWindows.length
                || member.commitmentWindows.length > ROBOT_OPERATION_POLICY.maxPhases) { fail('invalid-member'); continue; }
            let end = 0;
            for (const window of member.commitmentWindows) {
                if (!window || !Number.isFinite(window.until) || window.until <= end || window.until > 1) { fail('invalid-member'); continue; }
                end = window.until; validate(window.commitments);
            }
            if (end !== 1) { fail('invalid-member'); }
        }
        byId.set(member.id, member);
    }
    const requested = (Array.isArray(spec?.phases) ? spec.phases : []).slice(0, ROBOT_OPERATION_POLICY.maxPhases);
    let requestedEnd = 0;
    for (const phase of requested) {
        if (!phase || !Number.isFinite(phase.until) || phase.until <= requestedEnd || phase.until > 1) { fail('invalid-operation'); }
        requestedEnd = phase?.until ?? requestedEnd;
    }
    const endpoints = [...new Set([...requested.map(phase => phase?.until),
        ...[...byId.values()].flatMap(member => member.commitmentWindows?.map(window => window.until) ?? [])])]
        .filter(value => Number.isFinite(value) && value > 0 && value <= 1).sort((a, b) => a - b);
    if (endpoints.length > ROBOT_OPERATION_POLICY.maxPhases) { fail('invalid-operation'); }
    let previousEnd = 0;
    for (const endpoint of endpoints.slice(0, ROBOT_OPERATION_POLICY.maxPhases)) {
        const original = requested.find(phase => phase && endpoint <= phase.until);
        if (!original) { fail('invalid-operation'); continue; }
        const phase = { ...original, id: original.id + (original.until === endpoint ? '' : '@' + endpoint), until: endpoint };
        if (!phase?.id || !Number.isFinite(phase.until) || phase.until <= previousEnd || phase.until > 1
            || !Array.isArray(phase.loads) || !phase.loads.length || phase.loads.length > ROBOT_OPERATION_POLICY.maxLoadsPerPhase) {
            fail('invalid-operation'); continue;
        }
        previousEnd = phase.until;
        const loads: RobotLoadAssessment[] = [], assigned = new Map<string, number>();
        for (const load of phase.loads) {
            if (!load?.id || !role(load.role) || !Number.isFinite(load.cargo) || load.cargo < 0
                || !Array.isArray(load.bodies ?? []) || (load.bodies?.length ?? 0) > ROBOT_OPERATION_POLICY.maxMembers
                || !Array.isArray(load.supporters) || !load.supporters.length
                || load.supporters.length > ROBOT_OPERATION_POLICY.maxMembers || new Set(load.supporters).size !== load.supporters.length) {
                fail('invalid-load'); continue;
            }
            let mass = load.cargo;
            for (const vehicle of load.bodies ?? []) {
                const structure = robotStructure(vehicle);
                if (!structure) { fail('invalid-load'); } else { mass += structure.mass; }
            }
            if (!Number.isFinite(mass)) { fail('invalid-load'); continue; }
            const supports: RobotSupportAssessment[] = [];
            for (const id of load.supporters) {
                const member = byId.get(id);
                if (!member) { fail('missing-supporter'); continue; }
                participating.add(id);
                const structure = robotStructure(member.vehicle)!;
                if (load.attachment && !structure.attachments.includes(load.attachment)) { fail('attachment-unavailable'); }
                const support = robotSupport(member.vehicle, load.role, load.attachment);
                if (!support) { fail('role-unavailable'); }
                const mechanism = robotSupportMechanism(member.vehicle, load.role);
                const committed = committedEffort(member, mechanism, phase.until);
                const effectiveSupport = support * Math.max(0, (member.condition ?? 1) - committed);
                if (support > 0 && effectiveSupport <= 0) { fail('committed-capacity'); }
                supports.push({ member: id, vehicle: member.vehicle, role: load.role, attachment: load.attachment,
                    support, effectiveSupport, committedEffort: committed, assignedLoad: 0, strain: 0 });
            }
            const total = supports.reduce((sum, value) => sum + value.effectiveSupport, 0);
            if (mass > 0 && total <= 0) { fail('committed-capacity'); }
            for (const value of supports) {
                value.assignedLoad = total > 0 ? mass * value.effectiveSupport / total : 0;
                const mechanism = robotSupportMechanism(value.vehicle, value.role), key = value.member + ':' + mechanism;
                assigned.set(key, (assigned.get(key) ?? 0) + (value.support ? value.assignedLoad / value.support : 0));
            }
            loads.push({ id: load.id, demand: mass, support: total, members: supports });
        }
        let phasePeak = 0;
        for (const load of loads) {
            for (const value of load.members) {
                const member = byId.get(value.member)!, mechanism = robotSupportMechanism(value.vehicle, value.role);
                const reserve = Math.max(0, (member.condition ?? 1) - value.committedEffort);
                const usage = mechanisms.reduce((sum, other) => sum + (assigned.get(value.member + ':' + other) ?? 0)
                    * (other === mechanism ? 1 : ROBOT_STRUCTURE_POLICY.crossMechanismEffort), 0);
                value.strain = reserve > 0 ? usage / reserve : load.demand ? Number.MAX_SAFE_INTEGER : 0;
                if (value.strain >= peakStrain) { demand = load.demand; aggregateSupport = load.support; }
                phasePeak = Math.max(phasePeak, value.strain); peakStrain = Math.max(peakStrain, value.strain);
            }
        }
        phases.push({ id: phase.id, until: phase.until, loads, peakStrain: phasePeak });
    }
    if (previousEnd !== 1) { fail('invalid-operation'); }
    if (peakStrain > 1 + 1e-12) { reasons.add('overstrain'); }
    const preferredCrewMet = participating.size >= (spec?.preferredCrew ?? 1);
    if (!preferredCrewMet) { reasons.add('crew-preference'); }
    return { compatible, normalAdmissible: compatible && peakStrain <= 1 + 1e-12, preferredCrewMet,
        demand, aggregateSupport, peakStrain, members: [...participating], phases, reasons: [...reasons] };
}

/** Rates describe one operation decision. The outcome families share this admission probability. */
export function robotOperationProbabilities(strain: number, shortage: boolean, boldness = 1, independence = 1): RobotOperationProbabilities {
    if (!positive(strain) || strain <= 1) { return { attempt: 0, need: 0, opportunity: 0, fulfillment: 1, cleanGivenFulfillment: 1 }; }
    const policy = ROBOT_OPERATION_POLICY, x = strain - 1;
    const need = bounded((shortage ? policy.shortageMotive : 0) * bounded(boldness, 0, 4) / strain ** policy.shortageStrainExponent);
    const opportunity = bounded(policy.opportunityMotive * bounded(boldness, 0, 4) * bounded(independence, 0, 4)
        / strain ** policy.opportunityStrainExponent);
    return { need, opportunity, attempt: need + opportunity - need * opportunity,
        fulfillment: policy.extraordinaryFulfillment,
        cleanGivenFulfillment: policy.cleanGivenFulfillment / (1 + x * x / policy.cleanStrainScale) };
}

function contender(spec: RobotOperationSpec, members: readonly RobotOperationMember[]): string {
    const vehicles = new Map(members.map(member => [member.id, member.vehicle]));
    return spec.phases.map(phase => phase.id + ':' + phase.loads.map(load => load.id + ':' + load.role + ':'
        + (load.attachment ?? '') + ':' + load.supporters.map(id => vehicles.get(id)).sort().join(',')).sort().join('|')).join('/');
}

function frozen<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) { frozen(child); }
        Object.freeze(value);
    }
    return value;
}

/** A canonical operation keeps the same purpose draws through resource retries and crew reassessment. */
export function robotOperationDecisionRecord(seed: number, key: string, channel = key): Readonly<RobotOperationDecisionRecord> {
    return Object.freeze({ key, volunteer: robotOperationRandom(seed, key, 'volunteer', channel),
        willingness: robotOperationRandom(seed, key, 'willingness', channel),
        fulfillment: robotOperationRandom(seed, key, 'fulfillment', channel), aftermath: robotOperationRandom(seed, key, 'aftermath', channel) });
}

export function commitRobotOperation(spec: RobotOperationSpec, members: readonly RobotOperationMember[],
    context: { seed: number; shortage: boolean; timing: RobotActivityTiming; allowExceptional?: boolean;
        decisionKey?: string; decision?: Readonly<RobotOperationDecisionRecord> }): RobotOperationDecision {
    const assessment = assessRobotOperation(spec, members);
    const participants = members.filter(member => assessment.members.includes(member.id));
    const mean = (trait: 'emergencyBoldness' | 'independence' | 'teamPreference') => participants.length
        ? participants.reduce((sum, member) => sum + robotStructure(member.vehicle)!.personality[trait], 0) / participants.length : 1;
    const probabilities = robotOperationProbabilities(assessment.peakStrain, context.shortage, mean('emergencyBoldness'), mean('independence'));
    const reject = (reason: RobotOperationReason): RobotOperationDecision => ({ accepted: false, reason, assessment, probabilities });
    const timing = context.timing;
    if (![timing.startedAt, timing.workEnd, timing.aftermathEnd, timing.deadline].every(Number.isFinite)
        || timing.startedAt > timing.workEnd || timing.workEnd > timing.aftermathEnd || timing.aftermathEnd > timing.deadline) {
        return reject('invalid-operation');
    }
    if (!assessment.compatible) { return reject(assessment.reasons.find(reason => reason !== 'crew-preference' && reason !== 'overstrain') ?? 'invalid-operation'); }
    const identity = context.decisionKey ?? contender(spec, members), draw = (purpose: string, actor = '') =>
        robotOperationRandom(context.seed, spec.key, purpose, identity + (actor ? '/' + actor : ''));
    const decision = context.decision ?? robotOperationDecisionRecord(context.seed, spec.key, identity);
    if (decision.key !== spec.key || ![decision.volunteer, decision.willingness, decision.fulfillment, decision.aftermath]
        .every(value => Number.isFinite(value) && value >= 0 && value < 1)) { return reject('invalid-operation'); }
    let operatingMode: RobotOperationPlan['operatingMode'] = 'normal';
    if (assessment.normalAdmissible) {
        if (!assessment.preferredCrewMet) {
            if (decision.volunteer >= bounded(ROBOT_OPERATION_POLICY.volunteerChance * mean('independence') / Math.max(0.25, mean('teamPreference')))) {
                return reject('crew-preference');
            }
            operatingMode = 'volunteer';
        }
    } else {
        if (context.allowExceptional === false || decision.willingness >= probabilities.attempt) { return reject('willingness'); }
        operatingMode = 'overreach';
    }
    const fulfilled = operatingMode !== 'overreach' || decision.fulfillment < probabilities.fulfillment;
    const clean = operatingMode !== 'overreach' || fulfilled && decision.aftermath < probabilities.cleanGivenFulfillment;
    const affected = [...participants].sort((a, b) => draw('affected', a.vehicle) - draw('affected', b.vehicle) || a.vehicle.localeCompare(b.vehicle));
    const severe = assessment.peakStrain >= ROBOT_OPERATION_POLICY.disablingStrain;
    const outcome: RobotOperationOutcome = {
        family: !fulfilled ? 'valiant-failure' : clean ? 'clean-triumph' : 'expensive-success',
        completion: fulfilled ? 'fulfilled' : 'partial',
        aftermath: clean ? 'none' : severe ? 'disabled' : fulfilled ? 'smoke' : 'strained',
        affectedActors: clean ? [] : affected.slice(0, 1).map(member => member.id),
        recovery: clean ? 'self' : participants.length > 1 ? 'assisted' : 'self',
        progress: fulfilled ? 1 : ROBOT_OPERATION_POLICY.maximumFailedProgress / (1 + Math.max(0, assessment.peakStrain - 1) / 4),
    };
    const phases = spec.phases.map(phase => ({ ...phase, loads: phase.loads.map(load => ({ ...load,
        bodies: load.bodies ? [...load.bodies] : undefined, supporters: [...load.supporters] })) }));
    const plan = frozen({ ...spec, phases, operatingMode, effort: assessment, outcome,
        probabilities, timing: { ...timing }, decision });
    return { accepted: true, assessment, probabilities, plan };
}

/** Current assigned shares are the reserve charged to a member helping another activity. */
export function robotOperationCommitments(plan: RobotOperationPlan, member: number, workProgress: number): RobotCommitment[] {
    const phase = plan.effort.phases.find(value => workProgress < value.until) ?? plan.effort.phases.at(-1);
    if (!phase) { return []; }
    return phase.loads.flatMap(load => load.members.filter(value => value.member === member && value.assignedLoad > 0)
        .map(value => ({ key: plan.key + ':' + phase.id + ':' + load.id, role: value.role, attachment: value.attachment, load: value.assignedLoad })));
}

export function robotActivityPhase(plan: RobotOperationPlan, at: number, workResolved: boolean): 'work' | 'aftermath' | 'recovery' | 'complete' {
    if (at >= plan.timing.deadline) { return 'complete'; }
    if (!workResolved) { return 'work'; }
    return at < plan.timing.aftermathEnd ? 'aftermath' : 'recovery';
}
