import type { RobotVehicle } from './prefetch-robots';

export type RescueVehicle = RobotVehicle | 'ekokomvoz';
interface Capability {
    mobility: 'air' | 'ground';
    mass: number;
    lift: number;
    tow: number;
}

/** Relative scene capabilities, deliberately without physical mass or payload units. */
export const ROBOT_RESCUE_CAPABILITIES: Readonly<Record<RescueVehicle, Readonly<Capability>>> = Object.freeze({
    quad: Object.freeze({ mobility: 'air', mass: 1, lift: 1, tow: 0 }),
    heavyquad: Object.freeze({ mobility: 'air', mass: 3, lift: 3, tow: 0 }),
    tiltwing: Object.freeze({ mobility: 'air', mass: 2, lift: 1, tow: 0 }),
    rover: Object.freeze({ mobility: 'ground', mass: 9, lift: 0, tow: 10 }),
    mecanum: Object.freeze({ mobility: 'ground', mass: 3, lift: 0, tow: 3 }),
    forklift: Object.freeze({ mobility: 'ground', mass: 5, lift: 3, tow: 8 }),
    hexapod: Object.freeze({ mobility: 'ground', mass: 2, lift: 0, tow: 2 }),
    walker: Object.freeze({ mobility: 'ground', mass: 2, lift: 0, tow: 1 }),
    lugv: Object.freeze({ mobility: 'ground', mass: 1, lift: 0, tow: 1 }),
    ekokomvoz: Object.freeze({ mobility: 'ground', mass: 10, lift: 0, tow: 10 }),
});

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
}
export interface RobotRescueOptions {
    maxHelpers: number;
    /** All participants must remain owned for this entire interval. */
    remainingMs: number;
    /** Complete rigid casualty group, including the disabled member. The caller excludes its members from helpers. */
    carriedGroup?: readonly RescueVehicle[];
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
}

function capability(vehicle: RescueVehicle): Readonly<Capability> | undefined {
    return Object.prototype.hasOwnProperty.call(ROBOT_RESCUE_CAPABILITIES, vehicle)
        ? ROBOT_RESCUE_CAPABILITIES[vehicle] : undefined;
}

/** Shared by ordinary transport and rescue, so a scene cannot bypass the carrying hierarchy. */
export function canCarryRobot(carrier: RescueVehicle, cargo: RescueVehicle): boolean {
    const capacity = capability(carrier), load = capability(cargo);
    return !!capacity && !!load && capacity.lift > 0 && capacity.lift >= load.mass;
}

function valid(actor: RobotRescueActor): boolean {
    return !!actor && Number.isSafeInteger(actor.id) && actor.id >= 0 && !!capability(actor.vehicle)
        && Number.isFinite(actor.x) && Number.isFinite(actor.y)
        && Math.abs(actor.x) <= Number.MAX_SAFE_INTEGER && Math.abs(actor.y) <= Number.MAX_SAFE_INTEGER;
}

/** Deterministic, bounded selection only. The caller owns leases, chance, movement and time. */
export function planRobotRescue(disabled: RobotRescueActor, available: readonly RobotRescueActor[],
    options: RobotRescueOptions): RobotRescuePlan | undefined {
    if (!valid(disabled) || !Number.isFinite(options.remainingMs) || !Number.isSafeInteger(options.maxHelpers)
        || options.maxHelpers <= 0) { return; }
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
    const mass = loads.reduce((total, load) => total + load.mass, 0);
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
        enjoysAirlift: kind === 'airlift' && disabled.vehicle === 'lugv',
    });

    // Every rigidly carried member must be grounded and fit the same aircraft's capacity.
    if (loads.every(load => load.mobility === 'ground')) {
        const aircraft = candidates.find(value => value.capability.mobility === 'air'
            && value.capability.lift >= mass);
        if (aircraft) { return plan('airlift', [aircraft.actor.id], aircraft.capability.lift); }
    }

    const ground = candidates.filter(value => value.capability.mobility === 'ground' && value.capability.tow > 0);
    const single = ground.find(value => value.capability.tow >= mass);
    if (single) { return plan('tow', [single.actor.id], single.capability.tow); }
    if (maxHelpers >= 2) {
        let best: { ids: number[]; capacity: number; distance: number } | undefined;
        for (let first = 0; first < ground.length; first++) {
            for (let second = first + 1; second < ground.length; second++) {
                const a = ground[first], b = ground[second], capacity = a.capability.tow + b.capability.tow;
                if (capacity < mass) { continue; }
                const distance = a.distance + b.distance;
                if (!best || distance < best.distance) { best = { ids: [a.actor.id, b.actor.id], capacity, distance }; }
            }
        }
        if (best) { return plan('tow', best.ids, best.capacity); }
    }

    // A small crew can repair a bulky robot without pretending it can lift or tow it.
    return plan('repair', candidates.slice(0, maxHelpers).map(value => value.actor.id), 0);
}
