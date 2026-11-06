import type { RobotVehicle } from './prefetch-robots';
import { CARGO_ROUTE_POLICY } from './robot-cargo-routes';
import { robotStructure } from './robot-structure';
import { assessRobotOperation, robotOperationRandom, type RobotCargoWorkload, type RobotOperationMember,
    type RobotOperationSpec, type RobotOperationGoal, type RobotOperationAssessment, type RobotPhaseLoad } from './robot-operations';

/** One work clock is shared by phase assessment, deposited pixels and the existing finite return. */
export const ROBOT_DELIVERY_PHASES = Object.freeze({ rendezvousEnd: 0.18, handoffStart: 0.22,
    handoffEnd: 0.36, deposit: 0.62, return: 0.76, forkLiftStart: 0.44, removalAftermathEnd: 0.9 });
export type RobotCargoMode = 'solo' | 'formation' | 'handoff' | 'airlift';
export interface RobotCargoJob { key: string; goal: RobotOperationGoal; workload: Readonly<RobotCargoWorkload> }
/** Comparable equipment shares a class; each further doubling of mobilized size costs one class. */
export const ROBOT_CARGO_SELECTION_POLICY = Object.freeze({ comparableWorkMultiplier: 2 });
export interface RobotCargoFit {
    transportDifference: number;
    helperDifference: number;
    mobilizedMass: number;
    visualPresence: number;
    sizeClass: number;
}
export interface RobotCargoCandidate {
    mode: RobotCargoMode;
    ground: boolean;
    vehicles: readonly RobotVehicle[];
    spec: RobotOperationSpec;
    assessment: RobotOperationAssessment;
    fit: Readonly<RobotCargoFit>;
    repeatedTypes: number;
    rank: number;
}

/** Workload fit precedes variety and optional stories, including already staged heavy equipment. */
export function compareRobotCargoCandidates(a: RobotCargoCandidate, b: RobotCargoCandidate): number {
    return a.fit.transportDifference - b.fit.transportDifference || a.fit.helperDifference - b.fit.helperDifference || a.fit.sizeClass - b.fit.sizeClass
        || a.repeatedTypes - b.repeatedTypes || a.rank - b.rank || a.mode.localeCompare(b.mode)
        || a.vehicles.join(',').localeCompare(b.vehicles.join(','));
}

/** Describe the members who actually support the load in each phase, including bodies carried with it. */
export function robotCargoOperation(job: RobotCargoJob, mode: RobotCargoMode, members: readonly RobotOperationMember[],
    ground = false): RobotOperationSpec {
    const ids = members.map(member => member.id), cargo = job.workload.mass;
    const carry = (supporters: readonly number[]): RobotPhaseLoad => ({ id: 'cargo', role: 'carry', cargo, supporters });
    const spec: RobotOperationSpec = { key: job.key, goal: job.goal, preferredCrew: job.workload.preferredCrew, phases: [] };
    if (ground) {
        spec.phases = [
            { id: 'drive', until: ROBOT_DELIVERY_PHASES.forkLiftStart / ROBOT_DELIVERY_PHASES.deposit, loads: [carry(ids)] },
            { id: 'raise', until: 1, loads: [carry(ids), { id: 'fork', role: 'lift', attachment: 'fork', cargo, supporters: ids }] },
        ];
    } else if (mode === 'handoff' && members.length === 2) {
        spec.phases = [
            { id: 'incoming', until: (ROBOT_DELIVERY_PHASES.handoffStart + ROBOT_DELIVERY_PHASES.handoffEnd) / 2
                / ROBOT_DELIVERY_PHASES.deposit, loads: [carry([ids[0]])] },
            { id: 'outgoing', until: 1, loads: [carry([ids[1]])] },
        ];
    } else if (mode === 'airlift' && members.length === 2) {
        const bearing = carry([ids[0]]);
        spec.phases = [
            { id: 'ground-approach', until: CARGO_ROUTE_POLICY.rendezvousEnd, loads: [bearing] },
            { id: 'body-and-cargo', until: CARGO_ROUTE_POLICY.setDownEnd, loads: [bearing,
                { id: 'sling', role: 'lift', attachment: 'sling', cargo, bodies: [members[0].vehicle], supporters: [ids[1]] }] },
            { id: 'ground-arrival', until: 1, loads: [bearing] },
        ];
    } else { spec.phases = [{ id: 'carry', until: 1, loads: [carry(ids)] }]; }
    return spec;
}

/** Bounded proposals precede reservation. Availability and the final actual members remain the caller's authority. */
export function robotCargoCandidates(job: RobotCargoJob, available: readonly { vehicle: RobotVehicle; staged?: boolean; inUse?: boolean }[],
    options: { seed: number; preferredMode: RobotCargoMode; preferredHelpers: number; maxHelpers: number;
        ground?: boolean; bodyTransport?: RobotVehicle }): RobotCargoCandidate[] {
    const entries = [...new Map(available.map(value => [value.vehicle, value])).values()]
        .filter(value => !!robotStructure(value.vehicle)).sort((a, b) => a.vehicle.localeCompare(b.vehicle));
    const max = Math.max(0, Math.min(3, options.maxHelpers)), candidates: RobotCargoCandidate[] = [];
    const add = (mode: RobotCargoMode, crew: typeof entries, ground = false) => {
        if (!crew.length || crew.length > max) { return; }
        const members = crew.map((value, index) => ({ id: index + 1, vehicle: value.vehicle }));
        const spec = robotCargoOperation(job, mode, members, ground);
        const assessment = assessRobotOperation(spec, members);
        if (!assessment.compatible) { return; }
        const signature = mode + ':' + crew.map(value => value.vehicle).join(',');
        const staged = crew.filter(value => value.staged).length;
        const preferred = mode === options.preferredMode && crew.length === options.preferredHelpers && ground === !!options.ground;
        const teamwork = crew.reduce((sum, value) => sum + robotStructure(value.vehicle)!.personality.teamPreference, 0) / crew.length;
        const personality = mode === 'airlift' ? robotStructure(crew[0].vehicle)!.personality.carrierAffinity : 0;
        const mobilizedMass = crew.reduce((sum, value) => sum + robotStructure(value.vehicle)!.mass, 0);
        const visualPresence = crew.reduce((sum, value) => sum + robotStructure(value.vehicle)!.presentationScale ** 2, 0);
        const transportsBody = !!options.bodyTransport && mode === 'airlift' && crew[0].vehicle === options.bodyTransport;
        const comparableSize = ROBOT_CARGO_SELECTION_POLICY.comparableWorkMultiplier
            * Math.max(job.workload.mass, job.workload.preferredCrew);
        const fit = Object.freeze({ transportDifference: options.bodyTransport && !transportsBody ? 1 : 0,
            helperDifference: Math.abs(crew.length - Math.max(job.workload.preferredCrew, transportsBody ? 2 : 1)),
            mobilizedMass, visualPresence,
            sizeClass: Math.ceil(Math.log2(Math.max(1, Math.max(mobilizedMass, visualPresence) / comparableSize))) });
        candidates.push({ mode, ground, vehicles: crew.map(value => value.vehicle), spec, assessment,
            fit, repeatedTypes: crew.filter(value => !value.staged && value.inUse).length,
            rank: (preferred ? -4 : 0) - staged * 2 - personality
                - (crew.length > 1 ? teamwork * 0.1 : 0)
                + robotOperationRandom(options.seed, job.key, 'crew-rank', signature) });
    };
    if (options.ground) {
        for (const member of entries.filter(value => robotStructure(value.vehicle)!.liftMechanism === 'forks')) { add('solo', [member], true); }
    }
    {
        const ordinary = entries.filter(value => robotStructure(value.vehicle)!.liftMechanism !== 'forks');
        for (let a = 0; a < ordinary.length; a++) {
            add('solo', [ordinary[a]]);
            for (let b = a + 1; b < ordinary.length; b++) {
                add('formation', [ordinary[a], ordinary[b]]);
                for (let c = b + 1; c < ordinary.length; c++) { add('formation', [ordinary[a], ordinary[b], ordinary[c]]); }
            }
        }
        const air = ordinary.filter(value => robotStructure(value.vehicle)!.mobility === 'air');
        const ground = ordinary.filter(value => robotStructure(value.vehicle)!.mobility === 'ground');
        for (const flyer of job.goal === 'removal' ? [] : air) {
            for (const driver of ground) {
                add('handoff', [flyer, driver]);
                if (!options.bodyTransport || driver.vehicle === options.bodyTransport) { add('airlift', [driver, flyer]); }
            }
        }
    }
    return candidates.sort(compareRobotCargoCandidates);
}
