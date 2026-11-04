/**
 * The motion lab's crew keep their own jobs, destinations and patience. Scenarios give them
 * goals; steering, yielding, assistance and delivery completion follow from the simulation.
 * The model has no DOM dependency, so long outages and busy traffic can be tested directly.
 */
export const ROBOT_VEHICLES = [
    { id: 'quad', name: 'X-UFO', color: '#70e7d3', air: true, speed: 78, radius: 21 },
    { id: 'heavyquad', name: 'MORUS', color: '#ffbd70', air: true, speed: 62, radius: 26 },
    { id: 'tiltwing', name: 'MetaMorpher', color: '#aab7ff', air: true, speed: 92, radius: 27 },
    { id: 'rover', name: 'VIV', color: '#f17c75', air: false, speed: 46, radius: 20 },
    { id: 'mecanum', name: 'XENA', color: '#72cfed', air: false, speed: 55, radius: 20 },
    { id: 'forklift', name: 'VMAC', color: '#ffd36b', air: false, speed: 40, radius: 22 },
    { id: 'hexapod', name: 'ALKA', color: '#c5a1ef', air: false, speed: 38, radius: 24 },
    { id: 'walker', name: 'DynaRobin', color: '#a8db8b', air: false, speed: 64, radius: 19 },
] as const;
export type RobotVehicle = typeof ROBOT_VEHICLES[number]['id'];

// Fixed artwork and animated propellers use the same airframe geometry.
const ROTOR_LAYOUT: Partial<Record<RobotVehicle, readonly (readonly [number, number])[]>> = {
    quad: [[-25, -10], [25, -10], [-25, 11], [25, 11]],
    heavyquad: [[-32, -13], [32, -13], [-32, 13], [32, 13]],
    tiltwing: [[-34, 0], [34, 0]],
};

export const ROBOT_SCENES = [
    { id: 'covariance', title: 'The covariance ellipse has become a lifestyle.', durationMs: 7200 },
    { id: 'replan', title: 'Plan B has requested a Plan C.', durationMs: 6800 },
    { id: 'rescue', title: 'MORUS airlift. Ground crew: remain approximately calm.', durationMs: 9500 },
    { id: 'traffic', title: 'VMAC dispatch invokes the Banker’s algorithm.', durationMs: 8000 },
    { id: 'repair', title: 'XENA has selected the large diagnostic spanner.', durationMs: 7800 },
    { id: 'calibration', title: 'X-UFO gyro calibration. Again, with feeling.', durationMs: 7300 },
    { id: 'deadlock', title: 'Three robots have reserved the same loading dock.', durationMs: 7600 },
    { id: 'battery', title: 'AERIAL-CORE pit stop. Emergency electrons inbound.', durationMs: 8000 },
    { id: 'antenna', title: 'Raising the antenna improves crew morale.', durationMs: 7000 },
    { id: 'traction', title: 'VIV requests one more floor of traction.', durationMs: 7500 },
    { id: 'juggle', title: 'Page stacking: underactuated edition.', durationMs: 7200 },
    { id: 'bridge', title: 'ALKA has found a route with five useful legs.', durationMs: 8500 },
    { id: 'frame', title: 'MetaMorpher would like to clarify the coordinate frame.', durationMs: 7400 },
    { id: 'cable', title: 'The spare cable was filed under “future work”.', durationMs: 7500 },
] as const;

export const ROBOT_QUIET_DETAILS = [
    'A flour buffer now separates the yeast from the salt.',
    'The crew has assembled a pizza maintenance station.',
    'ASSISIbf bee consultants have joined the meeting.',
    'aMussels remember. aFish fetch.',
    'DynaRobin has offered a reassuring handshake.',
    'The safety cones have been sorted by eigenvalue.',
    'Someone has produced volume II of the manual.',
    'The tiny cactus has passed its sensor check.',
    'The spare antenna has acquired a smaller spare antenna.',
    'A paper crane is conducting an independent flight review.',
    'The coffee has achieved steady state.',
    'The crew is waiting with you.',
] as const;

export const ROBOT_LIMITS = Object.freeze({
    width: 480,
    height: 250,
    maxActors: ROBOT_VEHICLES.length,
    maxQueuedCargo: 24,
    maxDeliveryActors: 4,
    maxParticles: 48,
    maxFps: 30,
    maxStepMs: 100,
    outageConfirmMs: 180,
    readinessConfirmMs: 700,
    recoveryMs: 2600,
    quietDetailMs: 22000,
});

export interface RobotEvent {
    sequence: number;
    at: number;
    type: string;
    data: Record<string, number | string | boolean | null>;
}
export interface RobotTelemetry {
    starved?: boolean;
    visibleMissing?: readonly number[];
    visible?: readonly number[];
    pending?: readonly number[];
    safetySeconds?: number | null;
    velocityPxPerMs?: number;
    direction?: number;
    previewPages?: number;
    performance?: { events?: readonly RobotEvent[] };
}
type Point = { x: number; y: number };
type Mode = 'dispatch' | 'outage' | 'quiet' | 'recovery';
type Activity = 'park' | 'navigate' | 'load' | 'deliver' | 'unload' | 'inspect' | 'scan' | 'signal'
    | 'lift' | 'weld' | 'calibrate' | 'balance' | 'yield' | 'replan' | 'assist' | 'stranded'
    | 'charge' | 'read' | 'sleep' | 'celebrate';
export interface RobotCargo {
    kind: 'bytes' | 'preview' | 'page';
    bytes: number;
    page?: number;
    count: number;
}
interface TaskStep extends Point { activity: Activity; holdMs: number }
interface Task {
    kind: 'delivery' | 'scene' | 'help' | 'idle';
    steps: TaskStep[];
    index: number;
    arrivedAt: number | null;
    cargo?: RobotCargo;
    partner?: number;
}
interface Actor {
    id: number;
    vehicle: RobotVehicle;
    x: number; y: number; vx: number; vy: number;
    home: Point;
    goal: Point;
    activity: Activity;
    task: Task | null;
    carrying: boolean;
    temperament: number;
    patience: number;
    patienceLimit: number;
    blockedMs: number;
    yieldTo: number | null;
    detour: Point | null;
    needsHelp: boolean;
    partner: number | null;
    battery: number;
    distance: number;
    idleUntil: number;
    phase: number;
    look: number;
    rng: Random;
}
interface Particle extends Point { vx: number; vy: number; life: number; age: number; color: string; kind: 'dust' | 'spark' | 'confetti' }
interface SceneProp extends Point { kind: string; angle?: number; label?: string }
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const vehicleOf = (actor: { vehicle: RobotVehicle }) => ROBOT_VEHICLES.find(vehicle => vehicle.id === actor.vehicle)!;

function lastWhere<T>(values: readonly T[], predicate: (value: T) => boolean): T | undefined {
    for (let index = values.length - 1; index >= 0; index--) {
        if (predicate(values[index])) { return values[index]; }
    }
    return undefined;
}

class Random {
    constructor(private seed: number) { this.seed = seed >>> 0 || 0x1a41c5; }
    next(): number {
        let value = this.seed;
        value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
        this.seed = value >>> 0;
        return this.seed / 4294967296;
    }
    range(low: number, high: number): number { return low + this.next() * (high - low); }
    shuffle<T>(values: readonly T[]): T[] {
        const result = [...values];
        for (let index = result.length - 1; index > 0; index--) {
            const other = Math.floor(this.next() * (index + 1));
            [result[index], result[other]] = [result[other], result[index]];
        }
        return result;
    }
}

function counters() {
    return { acceptedCargo: 0, deliveredCargo: 0, fetchBytes: 0, yields: 0, replans: 0, assists: 0, cargoReroutes: 0, recoveries: 0 };
}
function step(x: number, y: number, activity: Activity = 'inspect', holdMs = 700): TaskStep {
    return { x, y, activity, holdMs };
}

/** Optional scene order is useful for replaying a particular incident in the motion lab. */
export class RobotChoreographer {
    private readonly rng: Random;
    private readonly actors: Actor[];
    private readonly preferredOrder: readonly string[];
    private input: RobotTelemetry = {};
    private mode: Mode = 'dispatch';
    private now = 0;
    private lastAt: number | null = null;
    private nextTransitionAt = Infinity;
    private sceneStartedAt = 0;
    private sceneIndex = 0;
    private sceneOrder: typeof ROBOT_SCENES[number][] = [];
    private sceneId = 'dispatch';
    private previousFirst = '';
    private episode = 0;
    private opening = 0;
    private riskSince: number | null = null;
    private readySince: number | null = null;
    private props: SceneProp[] = [];
    private quietDetails: number[] = [];
    private quietOrder: number[] = [];
    private nextQuietAt = Infinity;
    private queue: RobotCargo[] = [];
    private particles: Particle[] = [];
    private vehicleOrder: number[] = [];
    private lastVehicle = -1;
    private lastSequence = -1;
    private lastDocumentAt = -Infinity;
    private stats = counters();
    private emitAt = 0;

    constructor(seed = 0x1a41c5, options: { sceneOrder?: readonly string[] } = {}) {
        this.rng = new Random(seed);
        this.preferredOrder = options.sceneOrder ?? [];
        const homes = [
            { x: 80, y: 54 }, { x: 386, y: 62 }, { x: 244, y: 44 },
            { x: 72, y: 202 }, { x: 155, y: 219 }, { x: 239, y: 200 },
            { x: 327, y: 219 }, { x: 408, y: 204 },
        ];
        this.actors = ROBOT_VEHICLES.map((vehicle, id) => {
            const rng = new Random(Math.floor(this.rng.next() * 0xffffffff));
            const temperament = rng.range(0.65, 1.45);
            const patienceLimit = rng.range(650, 1800);
            return {
                id, vehicle: vehicle.id, ...homes[id], home: { ...homes[id] }, goal: { ...homes[id] },
                vx: 0, vy: 0, activity: 'park', task: null, carrying: false,
                temperament, patience: patienceLimit, patienceLimit, blockedMs: 0, yieldTo: null,
                detour: null, needsHelp: false, partner: null, battery: rng.range(0.55, 1),
                distance: 0, idleUntil: rng.range(1000, 6000), phase: rng.range(0, Math.PI * 2), look: 0, rng,
            };
        });
    }

    open(now: number, input: RobotTelemetry): void {
        this.opening++;
        this.mode = 'dispatch';
        this.sceneId = 'dispatch';
        this.nextTransitionAt = Infinity;
        this.lastAt = null;
        this.riskSince = this.readySince = null;
        this.queue.length = this.particles.length = 0;
        this.lastSequence = -1;
        for (const actor of this.actors) { this.release(actor); }
        this.update(now, input);
    }

    update(now: number, input: RobotTelemetry): void {
        this.now = Math.max(this.now, Number.isFinite(now) ? now : this.now);
        this.input = input;
        this.acceptEvents(input.performance?.events ?? []);
        const risk = !!input.starved || !!input.visibleMissing?.length
            || typeof input.safetySeconds === 'number' && input.safetySeconds < 0;
        if (risk) {
            this.riskSince ??= this.now;
            this.readySince = null;
        } else {
            this.readySince ??= this.now;
            this.riskSince = null;
        }
        // Only fresh telemetry updates confirm a transition; animation frames do not vote.
        if (risk && this.now - this.riskSince! >= ROBOT_LIMITS.outageConfirmMs && this.mode !== 'outage' && this.mode !== 'quiet') {
            this.startOutage();
        } else if (!risk && this.now - this.readySince! >= ROBOT_LIMITS.readinessConfirmMs && (this.mode === 'outage' || this.mode === 'quiet')) {
            this.mode = 'recovery';
            this.sceneId = 'recovery';
            this.sceneStartedAt = this.now;
            this.nextTransitionAt = this.now + ROBOT_LIMITS.recoveryMs;
            this.props = [];
            this.stats.recoveries++;
            for (const actor of this.actors) {
                actor.needsHelp = false;
                if (actor.task?.kind !== 'delivery') {
                    this.assign(actor, 'scene', [step(actor.x, actor.y, 'celebrate', ROBOT_LIMITS.recoveryMs)]);
                }
            }
            for (let index = 0; index < 18; index++) {
                this.emit({ x: 240, y: 70 }, 'confetti', ['#70e7d3', '#ffd36b', '#aab7ff'][index % 3]);
            }
        }
    }

    step(now: number, input?: RobotTelemetry) {
        if (input) { this.update(now, input); }
        this.now = Math.max(this.now, Number.isFinite(now) ? now : this.now);
        this.advanceScene();
        const elapsed = this.lastAt === null ? 0 : clamp(this.now - this.lastAt, 0, ROBOT_LIMITS.maxStepMs);
        this.lastAt = this.now;
        this.dispatchCargo();
        // Small substeps keep the avoidance and braking stable on a delayed browser frame.
        let remaining = elapsed / 1000;
        while (remaining > 0) {
            const dt = Math.min(remaining, 1 / 60);
            this.simulate(dt);
            remaining -= dt;
        }
        return this.snapshot();
    }

    snapshot() {
        const scene = ROBOT_SCENES.find(entry => entry.id === this.sceneId);
        return {
            at: this.now, mode: this.mode, scene: this.sceneId,
            caption: this.mode === 'quiet'
                ? this.quietDetails.length ? ROBOT_QUIET_DETAILS[this.quietDetails.at(-1)!] : 'The crew is standing by. The rescue repertoire is resting.'
                : this.mode === 'recovery' ? 'Buffer restored. Everybody act like that was planned.'
                    : scene?.title ?? 'LARICS dispatch · every parcel is a completed fetch or page.',
            episode: this.episode, opening: this.opening, sceneIndex: this.sceneIndex,
            nextTransitionAt: this.nextTransitionAt, sceneStartedAt: this.sceneStartedAt,
            missingPage: this.input.visibleMissing?.[0] ?? null,
            pendingPages: [...(this.input.pending ?? [])].slice(0, ROBOT_LIMITS.maxQueuedCargo),
            previewPages: this.input.previewPages ?? 0,
            pending: this.input.pending?.length ?? 0,
            quietDetails: [...this.quietDetails],
            props: this.props.map(prop => ({ ...prop })),
            actors: this.actors.map(actor => ({
                id: actor.id, vehicle: actor.vehicle, x: actor.x, y: actor.y, vx: actor.vx, vy: actor.vy,
                goal: { ...actor.goal }, activity: actor.activity,
                job: actor.task?.kind ?? 'idle', carrying: actor.carrying,
                cargo: actor.task?.cargo ? { ...actor.task.cargo } : null,
                temperament: actor.temperament, patience: actor.patience, needsHelp: actor.needsHelp,
                partner: actor.partner, yieldTo: actor.yieldTo, battery: actor.battery,
                distance: actor.distance, phase: actor.phase, look: actor.look,
                progress: actor.task?.arrivedAt === null || !actor.task ? 0
                    : clamp((this.now - actor.task.arrivedAt) / Math.max(1, actor.task.steps[actor.task.index]?.holdMs ?? 1), 0, 1),
            })),
            queuedCargo: this.queue.map(cargo => ({ ...cargo })),
            particles: this.particles.map(particle => ({ ...particle })),
            stats: { ...this.stats },
        };
    }

    private startOutage(): void {
        this.mode = 'outage';
        this.episode++;
        const preferred = this.preferredOrder.map(id => ROBOT_SCENES.find(scene => scene.id === id)).filter(Boolean) as typeof ROBOT_SCENES[number][];
        const rest = this.rng.shuffle(ROBOT_SCENES.filter(scene => !preferred.includes(scene)));
        this.sceneOrder = [...new Set([...preferred, ...rest])];
        if (this.sceneOrder[0].id === this.previousFirst) {
            [this.sceneOrder[0], this.sceneOrder[1]] = [this.sceneOrder[1], this.sceneOrder[0]];
        }
        this.previousFirst = this.sceneOrder[0].id;
        this.sceneIndex = 0;
        this.sceneStartedAt = this.now;
        this.quietDetails = [];
        this.quietOrder = this.rng.shuffle(ROBOT_QUIET_DETAILS.map((_, index) => index));
        this.enterScene();
    }

    private advanceScene(): void {
        while (this.mode === 'outage' && this.now >= this.nextTransitionAt) {
            this.sceneStartedAt = this.nextTransitionAt;
            this.sceneIndex++;
            if (this.sceneIndex < this.sceneOrder.length) {
                this.enterScene();
            } else {
                this.mode = 'quiet';
                this.sceneId = 'waiting';
                this.nextTransitionAt = Infinity;
                this.nextQuietAt = this.sceneStartedAt + ROBOT_LIMITS.quietDetailMs;
                this.props = [{ kind: 'bench', x: 215, y: 206 }, { kind: 'waiting-sign', x: 318, y: 176 }];
                for (const actor of this.actors) {
                    actor.needsHelp = false;
                    if (actor.task?.kind !== 'delivery') {
                        this.assign(actor, 'idle', [step(actor.home.x, actor.home.y, 'sleep', Infinity)]);
                    }
                }
            }
        }
        if (this.mode === 'recovery' && this.now >= this.nextTransitionAt) {
            this.mode = 'dispatch';
            this.sceneId = 'dispatch';
            this.nextTransitionAt = Infinity;
            for (const actor of this.actors) {
                if (actor.task?.kind === 'scene') { this.release(actor); }
            }
        }
        while (this.mode === 'quiet' && this.now >= this.nextQuietAt && this.quietDetails.length < this.quietOrder.length) {
            this.quietDetails.push(this.quietOrder[this.quietDetails.length]);
            this.nextQuietAt += ROBOT_LIMITS.quietDetailMs + this.rng.range(1000, 12000);
        }
    }

    private enterScene(): void {
        const scene = this.sceneOrder[this.sceneIndex];
        this.sceneId = scene.id;
        this.nextTransitionAt = this.sceneStartedAt + scene.durationMs;
        this.props = [];
        for (const actor of this.actors) {
            if (actor.task?.kind !== 'delivery') { this.release(actor); }
            actor.needsHelp = false;
        }
        const used = new Set<number>();
        const actorFor = (vehicle: RobotVehicle) => {
            const preferred = this.actors.find(actor => actor.vehicle === vehicle && actor.task?.kind !== 'delivery');
            const actor = preferred && !used.has(preferred.id) ? preferred
                : this.actors.find(candidate => !used.has(candidate.id) && candidate.task?.kind !== 'delivery'
                    && vehicleOf(candidate).air === ROBOT_VEHICLES.find(spec => spec.id === vehicle)!.air);
            if (actor) { used.add(actor.id); }
            return actor;
        };
        const task = (vehicle: RobotVehicle, steps: TaskStep[], stranded = false) => {
            const actor = actorFor(vehicle);
            if (actor) {
                this.assign(actor, 'scene', steps);
                actor.needsHelp = stranded;
            }
            return actor;
        };
        const prop = (kind: string, x: number, y: number, label?: string) => this.props.push({ kind, x, y, label });
        const offset = this.rng.range(-16, 16);
        switch (scene.id) {
        case 'covariance':
            task('rover', [step(188, 165, 'scan', 900), step(265, 178, 'inspect', 600), step(211, 205, 'scan', 1400)]);
            task('quad', [step(214, 80, 'scan', 1000), step(292, 94, 'calibrate', 1000)]);
            prop('covariance', 234, 175, 'P → ?');
            break;
        case 'replan':
            task('mecanum', [step(202, 174, 'inspect', 700), step(153, 211, 'replan', 500), step(294, 215, 'signal', 700)]);
            task('walker', [step(304, 177, 'inspect', 1000), step(220, 208, 'read', 1500)]);
            prop('cones', 240, 186); prop('map', 303, 156, 'PLAN C');
            break;
        case 'rescue': {
            const stranded = task('rover', [step(235, 187, 'stranded', Infinity)], true);
            if (stranded) { stranded.task!.steps[0] = step(stranded.x, stranded.y, 'stranded', Infinity); }
            task('heavyquad', [step(240, 68, 'scan', 500), step(230, 98, 'lift', 1500)]);
            prop('rescue', 235, 188, 'MORUS');
            break;
        }
        case 'traffic':
            task('forklift', [step(285, 193, 'signal', 1200), step(155, 193, 'inspect', 600)]);
            task('mecanum', [step(196, 193, 'signal', 1200), step(320, 193, 'inspect', 600)]);
            task('walker', [step(239, 171, 'signal', 1800)]);
            prop('traffic', 240, 150, 'BANKER');
            break;
        case 'repair': {
            const broken = task('mecanum', [step(245, 187, 'stranded', Infinity)], true);
            if (broken) { broken.task!.steps[0] = step(broken.x, broken.y, 'stranded', Infinity); }
            task('hexapod', [step(212, 196, 'weld', 2400), step(265, 202, 'inspect', 500)]);
            prop('tools', 230, 205, 'XENA');
            break;
        }
        case 'calibration':
            task('quad', [step(231, 87, 'calibrate', 850), step(291, 62, 'calibrate', 700), step(219, 117, 'inspect', 900)]);
            task('rover', [step(260, 190, 'scan', 2100)]);
            prop('helipad', 225, 198, 'X-UFO');
            break;
        case 'deadlock':
            task('forklift', [step(230, 188, 'load', 1400)]);
            task('mecanum', [step(247, 188, 'load', 1400)]);
            task('hexapod', [step(238, 204, 'inspect', 1800)]);
            prop('parcel-pile', 239, 180, 'RESERVED');
            break;
        case 'battery': {
            const flat = task('quad', [step(190, 98, 'stranded', Infinity)], true);
            if (flat) { flat.battery = 0.06; flat.task!.steps[0] = step(flat.x, flat.y, 'stranded', Infinity); }
            task('mecanum', [step(195, 195, 'lift', 1400), step(260, 198, 'charge', 800)]);
            prop('battery', 210, 180, 'AERIAL-CORE');
            break;
        }
        case 'antenna':
            task('rover', [step(220, 188, 'scan', 2400)]);
            task('heavyquad', [step(268, 62, 'scan', 1400), step(185, 74, 'signal', 900)]);
            prop('dish', 255, 161); prop('radio', 255, 104);
            break;
        case 'traction':
            task('rover', [step(290, 177, 'replan', 1100), step(204, 208, 'inspect', 700)]);
            task('forklift', [step(249, 203, 'lift', 1400)]);
            prop('stairs', 262, 196, 'XI'); prop('traction', 223, 208);
            break;
        case 'juggle':
            task('mecanum', [step(230, 186, 'balance', 3000)]);
            task('quad', [step(270, 101, 'lift', 1300), step(211, 89, 'balance', 1300)]);
            prop('juggle', 248, 150, 'p.' + (this.input.visibleMissing?.[0] ?? '?'));
            break;
        case 'bridge':
            task('hexapod', [step(180, 195, 'inspect', 700), step(282, 186, 'signal', 1200)]);
            task('walker', [step(210, 177, 'inspect', 700), step(300, 196, 'celebrate', 700)]);
            prop('bridge', 243, 203, 'ALKA');
            break;
        case 'frame':
            task('tiltwing', [step(175, 82, 'calibrate', 900), step(295, 106, 'inspect', 900), step(235, 64, 'scan', 500)]);
            task('mecanum', [step(229, 195, 'read', 1700), step(280, 200, 'signal', 700)]);
            prop('axes', 240, 133, 'ENU? NED?');
            break;
        case 'cable':
            task('forklift', [step(194, 200, 'load', 650), step(296, 190, 'lift', 1100)]);
            task('hexapod', [step(310, 212, 'inspect', 900), step(240, 211, 'weld', 1100)]);
            prop('cable', 242 + offset, 207, 'CAT ∞');
            break;
        }
    }

    private acceptEvents(events: readonly RobotEvent[]): void {
        const newest = events.at(-1)?.sequence ?? 0;
        const document = lastWhere(events, event => event.type === 'document');
        const changed = document && document.at !== this.lastDocumentAt && this.lastSequence >= 0;
        if (changed || newest < this.lastSequence) {
            this.stats = counters();
            this.queue.length = this.particles.length = 0;
            this.mode = 'dispatch';
            this.sceneId = 'dispatch';
            this.riskSince = this.readySince = null;
            for (const actor of this.actors) { this.release(actor); }
            this.lastSequence = 0;
        }
        if (document) { this.lastDocumentAt = document.at; }
        // Opening the panel observes the current history; it does not fly in old deliveries.
        if (this.lastSequence < 0) { this.lastSequence = newest; return; }
        for (const event of events) {
            if (event.sequence <= this.lastSequence) { continue; }
            this.lastSequence = event.sequence;
            let cargo: RobotCargo | undefined;
            if (event.type === 'fetch' && typeof event.data.bytes === 'number' && Number.isFinite(event.data.bytes) && event.data.bytes > 0) {
                cargo = { kind: 'bytes', bytes: event.data.bytes, count: 1 };
                this.stats.fetchBytes += cargo.bytes;
            } else if ((event.type === 'preview-ready' || event.type === 'page-render' && !event.data.error)
                && typeof event.data.page === 'number' && Number.isSafeInteger(event.data.page) && event.data.page > 0) {
                cargo = { kind: event.type === 'preview-ready' ? 'preview' : 'page', bytes: 0, page: event.data.page, count: 1 };
            }
            if (!cargo) { continue; }
            this.stats.acceptedCargo++;
            if (this.queue.length < ROBOT_LIMITS.maxQueuedCargo) {
                this.queue.push(cargo);
            } else {
                const aggregate = lastWhere(this.queue, item => item.kind === cargo!.kind);
                if (aggregate) {
                    aggregate.bytes += cargo.bytes;
                    aggregate.count += cargo.count;
                    if (cargo.page !== undefined) { aggregate.page = cargo.page; }
                } else {
                    // At capacity, two existing parcels share a kind because there are only three.
                    // Combining those makes room for the new kind without labelling bytes as a page.
                    const seen = new Map<RobotCargo['kind'], number>();
                    let firstIndex = 0, index = 0;
                    for (let position = 0; position < this.queue.length; position++) {
                        const prior = seen.get(this.queue[position].kind);
                        if (prior !== undefined) { firstIndex = prior; index = position; break; }
                        seen.set(this.queue[position].kind, position);
                    }
                    const first = this.queue[firstIndex];
                    const other = this.queue[index];
                    first.bytes += other.bytes; first.count += other.count;
                    if (other.page !== undefined) { first.page = other.page; }
                    this.queue.splice(index, 1);
                    this.queue.push(cargo);
                }
            }
        }
    }

    private dispatchCargo(): void {
        let active = this.actors.filter(actor => actor.task?.kind === 'delivery').length;
        while (this.queue.length && active < ROBOT_LIMITS.maxDeliveryActors) {
            if (!this.vehicleOrder.length) {
                this.vehicleOrder = this.rng.shuffle(this.actors.map(actor => actor.id));
                if (this.vehicleOrder[0] === this.lastVehicle) {
                    [this.vehicleOrder[0], this.vehicleOrder[1]] = [this.vehicleOrder[1], this.vehicleOrder[0]];
                }
            }
            const index = this.vehicleOrder.findIndex(id => !this.actors[id].needsHelp && this.actors[id].task?.kind !== 'delivery' && this.actors[id].task?.kind !== 'help');
            if (index < 0) { this.vehicleOrder = []; break; }
            const actor = this.actors[this.vehicleOrder.splice(index, 1)[0]];
            this.lastVehicle = actor.id;
            const cargo = this.queue.shift()!;
            this.delivery(actor, cargo);
            active++;
        }
    }

    private delivery(actor: Actor, cargo: RobotCargo, origin?: Point): void {
        const air = vehicleOf(actor).air;
        const source = origin ?? { x: 42, y: air ? 105 : 191 };
        const level = cargo.kind === 'bytes' ? 177 : cargo.kind === 'preview' ? 143 : 111;
        this.assign(actor, 'delivery', [
            step(source.x, source.y, 'load', 350),
            step(428, air ? level : 193, 'unload', 500),
            step(actor.home.x, actor.home.y, 'park', 100),
        ]);
        actor.task!.cargo = cargo;
    }

    private release(actor: Actor): void {
        actor.task = null;
        actor.carrying = actor.needsHelp = false;
        actor.partner = actor.yieldTo = null;
        actor.detour = null;
        actor.goal = { ...actor.home };
        actor.activity = 'park';
        actor.patience = actor.patienceLimit;
        actor.blockedMs = 0;
        actor.idleUntil = this.now + actor.rng.range(1000, 5000);
    }

    private assign(actor: Actor, kind: Task['kind'], steps: TaskStep[], partner?: number): void {
        actor.task = { kind, steps, index: 0, arrivedAt: null, partner };
        actor.goal = { x: steps[0].x, y: steps[0].y };
        actor.activity = 'navigate';
        actor.detour = null;
        actor.carrying = false;
        actor.partner = partner ?? null;
        actor.blockedMs = 0;
        actor.patience = actor.patienceLimit;
    }

    private think(actor: Actor): void {
        if (actor.needsHelp) { actor.activity = 'stranded'; return; }
        if (actor.task?.kind === 'help') {
            const partner = this.actors[actor.task.partner!];
            if (!partner?.needsHelp) { this.release(actor); }
        }
        if (!actor.task || actor.task.kind === 'idle') {
            const stranded = this.actors.filter(other => other.needsHelp && other.id !== actor.id
                && !this.actors.some(helper => helper.task?.kind === 'help' && helper.partner === other.id))
                .sort((a, b) => distance(actor, a) - distance(actor, b))[0];
            if (stranded) {
                const air = vehicleOf(actor).air;
                this.assign(actor, 'help', [step(clamp(stranded.x - 31, 25, 450), air ? Math.max(45, stranded.y - 45) : clamp(stranded.y + 15, 155, 221), 'assist', 800)], stranded.id);
                return;
            }
        }
        if (actor.task || this.now < actor.idleUntil) { return; }
        if (this.mode === 'quiet') {
            this.assign(actor, 'idle', [step(actor.home.x, actor.home.y, 'sleep', Infinity)]);
        } else if (actor.battery < 0.25) {
            this.assign(actor, 'idle', [step(83, vehicleOf(actor).air ? 124 : 216, 'charge', 2500)]);
        } else {
            const air = vehicleOf(actor).air;
            const activity: Activity = actor.rng.next() < 0.5 ? 'scan' : 'read';
            this.assign(actor, 'idle', [step(
                clamp(actor.home.x + actor.rng.range(-22, 22), 35, 440),
                clamp(actor.home.y + actor.rng.range(-9, 9), air ? 40 : 175, air ? 115 : 225),
                activity, actor.rng.range(1500, 4000),
            )]);
        }
    }

    private arrive(actor: Actor): void {
        const task = actor.task;
        if (!task) { return; }
        const target = task.steps[task.index];
        if (!target) { this.release(actor); return; }
        if (task.arrivedAt === null) { task.arrivedAt = this.now; }
        actor.activity = target.activity;
        if (this.now - task.arrivedAt < target.holdMs) { return; }
        if (task.kind === 'help') {
            const partner = this.actors[task.partner!];
            if (partner?.needsHelp) {
                partner.needsHelp = false;
                partner.battery = Math.max(0.55, partner.battery);
                this.release(partner);
                this.stats.assists++;
                this.emit(partner, 'spark', '#70e7d3');
            }
        }
        if (task.kind === 'delivery') {
            if (task.index === 0) { actor.carrying = true; }
            if (task.index === 1) {
                actor.carrying = false;
                this.stats.deliveredCargo += task.cargo!.count;
                this.emit(actor, 'spark', '#70e7d3');
            }
        }
        task.index++;
        task.arrivedAt = null;
        if (task.index >= task.steps.length) {
            this.release(actor);
        } else {
            actor.goal = { x: task.steps[task.index].x, y: task.steps[task.index].y };
        }
    }

    private simulate(dt: number): void {
        for (const actor of this.actors) { this.think(actor); }
        for (const actor of this.actors) {
            const spec = vehicleOf(actor);
            const target = actor.detour ?? actor.goal;
            const dx = target.x - actor.x, dy = target.y - actor.y;
            const gap = Math.hypot(dx, dy);
            let speed = spec.speed * actor.temperament * (this.mode === 'outage' ? 1.12 : 1);
            if (actor.needsHelp || actor.task?.arrivedAt !== null && actor.task) { speed = 0; }
            speed *= clamp(gap / 28, 0, 1);
            let desiredX = gap > 0.1 ? dx / gap * speed : 0;
            let desiredY = gap > 0.1 ? dy / gap * speed : 0;
            let yielding: Actor | undefined;
            for (const other of this.actors) {
                if (actor === other || spec.air !== vehicleOf(other).air || actor.partner === other.id || other.partner === actor.id) { continue; }
                const separation = distance(actor, other);
                const reach = (spec.radius + vehicleOf(other).radius) * 0.82;
                if (separation < reach + 15 && separation > 0.01) {
                    const priority = (actor.carrying ? 20 : actor.task?.kind === 'delivery' ? 10 : 0) - actor.id / 10;
                    const otherPriority = (other.carrying ? 20 : other.task?.kind === 'delivery' ? 10 : 0) - other.id / 10;
                    const toward = dx * (other.x - actor.x) + dy * (other.y - actor.y);
                    if (!actor.detour && toward > 0 && priority < otherPriority && speed > 1) { yielding = other; }
                    const push = Math.max(0, reach - separation) * 3.2;
                    desiredX += (actor.x - other.x) / separation * push;
                    desiredY += (actor.y - other.y) / separation * push;
                }
            }
            if (yielding) {
                if (actor.yieldTo !== yielding.id) { this.stats.yields++; }
                actor.yieldTo = yielding.id;
                actor.activity = 'yield';
                desiredX *= 0.18; desiredY *= 0.18;
                actor.patience -= dt * 1000;
                actor.blockedMs += dt * 1000;
                actor.look = Math.sign(yielding.x - actor.x);
                if (actor.patience <= 0) {
                    const side = actor.id % 2 ? 1 : -1;
                    actor.detour = {
                        x: clamp(actor.x + Math.sign(dx || side) * 44, 28, 450),
                        y: clamp(actor.y + side * 37, spec.air ? 35 : 152, spec.air ? 130 : 225),
                    };
                    actor.activity = 'replan';
                    actor.patience = actor.patienceLimit;
                    actor.yieldTo = null;
                    this.stats.replans++;
                }
            } else {
                actor.yieldTo = null;
                actor.patience = Math.min(actor.patienceLimit, actor.patience + dt * 400);
                if (actor.task?.arrivedAt === null && !actor.needsHelp) {
                    actor.activity = actor.detour ? 'replan' : actor.carrying ? 'deliver' : 'navigate';
                }
            }
            if (actor.blockedMs > 3400 && actor.carrying && actor.task?.kind === 'delivery' && !spec.air) {
                const courier = this.actors.find(candidate => vehicleOf(candidate).air && !candidate.needsHelp
                    && (!candidate.task || candidate.task.kind === 'idle'));
                if (courier) {
                    const cargo = actor.task.cargo!;
                    this.delivery(courier, cargo, { x: actor.x, y: Math.max(100, actor.y - 65) });
                    this.release(actor);
                    this.stats.cargoReroutes++;
                }
            }
            const response = 1 - Math.exp(-dt * 7);
            actor.vx += (desiredX - actor.vx) * response;
            actor.vy += (desiredY - actor.vy) * response;
            const maxSpeed = spec.speed * 1.8;
            const magnitude = Math.hypot(actor.vx, actor.vy);
            if (magnitude > maxSpeed) { actor.vx *= maxSpeed / magnitude; actor.vy *= maxSpeed / magnitude; }
            actor.x = clamp(actor.x + actor.vx * dt, 18, ROBOT_LIMITS.width - 18);
            actor.y = clamp(actor.y + actor.vy * dt, 28, ROBOT_LIMITS.height - 20);
            actor.distance += Math.hypot(actor.vx, actor.vy) * dt;
            actor.battery = clamp(actor.battery - Math.hypot(actor.vx, actor.vy) * dt / 25000, 0.04, 1);
            if (actor.activity === 'charge') { actor.battery = Math.min(1, actor.battery + dt * 0.3); }
            if (!yielding) { actor.look += (Math.sign(dx) - actor.look) * response; }
            if (gap < 5) {
                if (actor.detour) { actor.detour = null; actor.blockedMs = 0; }
                else { this.arrive(actor); }
            }
        }
        if (this.now >= this.emitAt) {
            this.emitAt = this.now + 100;
            for (const actor of this.actors) {
                if (actor.activity === 'weld' || actor.activity === 'assist') {
                    this.emit({ x: actor.x + 22, y: actor.y - 13 }, 'spark', '#ffcf7e');
                } else if (!vehicleOf(actor).air && Math.hypot(actor.vx, actor.vy) > 30 && this.mode !== 'quiet') {
                    this.emit({ x: actor.x - Math.sign(actor.vx) * 17, y: actor.y + 13 }, 'dust', '#7c92ae');
                }
            }
        }
        for (let index = this.particles.length - 1; index >= 0; index--) {
            const particle = this.particles[index];
            particle.age += dt;
            if (particle.age >= particle.life) { this.particles.splice(index, 1); continue; }
            particle.x += particle.vx * dt;
            particle.y += particle.vy * dt;
            particle.vy += dt * (particle.kind === 'confetti' ? 45 : 20);
        }
    }

    private emit(at: Point, kind: Particle['kind'], color: string): void {
        if (this.particles.length >= ROBOT_LIMITS.maxParticles) { return; }
        this.particles.push({
            ...at, kind, color, vx: this.rng.range(-35, 35),
            vy: this.rng.range(kind === 'confetti' ? -70 : -28, -5),
            life: this.rng.range(0.35, kind === 'confetti' ? 1.6 : 0.75), age: 0,
        });
    }
}
export type RobotFrame = ReturnType<RobotChoreographer['snapshot']>;

const LAB_INK = '#0a1728';
const LAB_STEEL = '#647b95';
const LAB_LIGHT = '#e6f4ff';
const TAU = Math.PI * 2;
type Paint = CanvasRenderingContext2D;

function rounded(ctx: Paint, x: number, y: number, width: number, height: number, radius: number, fill: string | CanvasGradient, stroke = LAB_INK): void {
    ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.3; ctx.stroke(); }
}
function line(ctx: Paint, points: number[][], color = LAB_STEEL, width = 1.5): void {
    ctx.beginPath();
    points.forEach(([x, y], index) => { if (index) { ctx.lineTo(x, y); } else { ctx.moveTo(x, y); } });
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
}
function ellipse(ctx: Paint, x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient, stroke = ''): void {
    ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, TAU);
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
}
function label(ctx: Paint, text: string, x: number, y: number, color = '#bfd1e4', size = 8, align: CanvasTextAlign = 'center'): void {
    ctx.fillStyle = color; ctx.font = '600 ' + size + 'px ui-monospace, monospace'; ctx.textAlign = align; ctx.fillText(text, x, y);
}
function bodyArtwork(ctx: Paint, vehicle: typeof ROBOT_VEHICLES[number]): void {
    const color = vehicle.color;
    const panel = ctx.createLinearGradient(0, -25, 0, 19);
    panel.addColorStop(0, LAB_LIGHT); panel.addColorStop(0.18, color); panel.addColorStop(1, '#324b62');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (vehicle.air) {
        const motors = ROTOR_LAYOUT[vehicle.id]!;
        if (vehicle.id === 'tiltwing') {
            ctx.beginPath(); ctx.moveTo(-42, 2); ctx.lineTo(-28, -8); ctx.lineTo(34, -4); ctx.lineTo(44, 7);
            ctx.lineTo(8, 9); ctx.lineTo(3, 18); ctx.lineTo(-6, 18); ctx.lineTo(-10, 8); ctx.closePath();
            ctx.fillStyle = panel; ctx.fill(); ctx.strokeStyle = LAB_INK; ctx.stroke();
            line(ctx, [[-32, -3], [25, 2]], '#d9dcff', 1);
        }
        for (const [x, y] of motors) {
            line(ctx, [[0, 0], [x, y]], LAB_INK, 5);
            line(ctx, [[0, -1], [x, y - 1]], LAB_STEEL, 2.4);
            ellipse(ctx, x, y, 5, 3.5, '#33485f', '#8da9bf');
            ellipse(ctx, x, y - 1, 2.1, 1.4, color);
        }
        rounded(ctx, -13, -13, 26, 27, 9, panel);
        rounded(ctx, -10, -8, 20, 12, 5, LAB_INK, '#8aa7ba');
        for (const sign of [-1, 1]) {
            line(ctx, [[sign * 8, 9], [sign * 15, 23], [sign * 22, 23]], '#7e9db3', 2);
            ellipse(ctx, sign * 7, 8, 1.4, 1.4, LAB_LIGHT);
        }
        if (vehicle.id === 'heavyquad') {
            rounded(ctx, -7, 13, 14, 6, 2, '#3d5366');
            ellipse(ctx, 0, 16, 3, 3, '#cf9a50', LAB_INK);
        }
        if (vehicle.id === 'quad') {
            line(ctx, [[-17, -15], [-11, -18], [11, -18], [17, -15]], '#b4fff0', 1.2);
        }
    } else {
        if (vehicle.id === 'forklift') {
            rounded(ctx, -25, -6, 41, 22, 5, panel);
            rounded(ctx, -13, -25, 24, 25, 3, '#1a3149', '#ecbc5f');
            line(ctx, [[-15, -27], [14, -27], [17, 7]], '#ffe4a0', 3);
            rounded(ctx, -10, -20, 18, 10, 2, '#10243c');
            rounded(ctx, -23, -12, 11, 8, 2, '#d99641');
            line(ctx, [[22, -30], [22, 17], [29, 17]], LAB_INK, 5);
            line(ctx, [[22, -28], [22, 15]], '#f1be5b', 2);
            for (let y = -24; y < 14; y += 6) { line(ctx, [[21, y], [24, y + 2]], '#2d4055', 1); }
            rounded(ctx, -7, -31, 8, 4, 2, '#ff906e');
        } else if (vehicle.id === 'rover') {
            rounded(ctx, -25, -9, 48, 23, 5, panel);
            rounded(ctx, -17, -19, 34, 15, 4, '#28465c', '#efb5a2');
            rounded(ctx, -10, -15, 21, 9, 3, LAB_INK);
            line(ctx, [[-19, -6], [-19, 2], [-5, 2]], '#f8ddd1', 2);
            rounded(ctx, 14, -3, 8, 9, 2, '#f17c75');
            line(ctx, [[-20, -18], [-20, -29]], '#b1bac5', 1.8);
            ellipse(ctx, -20, -30, 4, 2, '#7d9cb3');
            line(ctx, [[-25, 8], [-31, 8], [-31, 12]], LAB_STEEL, 2);
            label(ctx, 'VIV', 10, 9, '#ffe2d2', 6);
        } else if (vehicle.id === 'mecanum') {
            rounded(ctx, -24, -5, 48, 18, 5, panel);
            rounded(ctx, -17, -13, 34, 11, 3, '#1e4053', '#b9ebff');
            rounded(ctx, 7, -10, 13, 8, 2, LAB_INK);
            ellipse(ctx, -9, -9, 7, 4, '#9ab7c6', LAB_INK);
            for (const x of [-19, 19]) {
                for (const y of [7, 13]) { line(ctx, [[x - 4, y - 2], [x + 2, y + 2]], '#a1c3d7', 2); }
            }
            line(ctx, [[19, -13], [19, -24]], '#7fb0c6', 1.5);
            ellipse(ctx, 19, -25, 3, 2, '#7dddfa');
        } else if (vehicle.id === 'hexapod') {
            ellipse(ctx, 0, 0, 22, 13, panel, LAB_INK);
            rounded(ctx, -12, -15, 24, 13, 5, '#3f355c', '#dbc3fa');
            rounded(ctx, -9, -11, 18, 7, 3, LAB_INK);
            ellipse(ctx, 0, 4, 8, 6, '#8b79a8', '#c5b4e0');
            line(ctx, [[12, -12], [26, -25], [38, -28]], '#e1cbf6', 1.5);
            ellipse(ctx, 11, 2, 2, 2, '#f2d5ff');
        } else {
            rounded(ctx, -24, -11, 41, 20, 6, panel);
            rounded(ctx, 10, -19, 19, 16, 6, '#355343', '#c1e9b1');
            rounded(ctx, 15, -15, 12, 7, 3, LAB_INK);
            line(ctx, [[-24, -6], [-32, -15], [-36, -12]], color, 3);
            rounded(ctx, -14, -16, 18, 7, 3, '#769d70');
            ellipse(ctx, -13, 0, 3, 3, '#d2efbc', LAB_INK);
            ellipse(ctx, 11, 0, 3, 3, '#d2efbc', LAB_INK);
        }
        if (vehicle.id !== 'walker' && vehicle.id !== 'hexapod') {
            const wheels = vehicle.id === 'rover' ? [-20, 0, 20] : [-17, 16];
            for (const x of wheels) {
                ellipse(ctx, x, 14, 7.4, 7.4, '#0c1826', '#40576c');
                ellipse(ctx, x, 14, 4.3, 4.3, '#637b8a');
                ellipse(ctx, x, 14, 1.5, 1.5, '#cbdde7');
            }
        }
    }
    for (const x of [-8, 8]) { ellipse(ctx, x, 10, 1, 1, '#dbe8ed'); }
}

/** Two-link inverse kinematics keeps grasping and repair tools attached to their targets. */
function drawArm(ctx: Paint, base: Point, target: Point, color: string, open = 3): Point {
    const upper = 18, lower = 17;
    const dx = target.x - base.x, dy = target.y - base.y;
    const reach = clamp(Math.hypot(dx, dy), 1, upper + lower - 0.2);
    const direction = Math.atan2(dy, dx);
    const elbowAngle = Math.acos(clamp((upper * upper + reach * reach - lower * lower) / (2 * upper * reach), -1, 1));
    const joint = { x: base.x + Math.cos(direction - elbowAngle) * upper, y: base.y + Math.sin(direction - elbowAngle) * upper };
    const tip = { x: base.x + Math.cos(direction) * reach, y: base.y + Math.sin(direction) * reach };
    const points = [[base.x, base.y], [joint.x, joint.y], [tip.x, tip.y]];
    line(ctx, points, LAB_INK, 6); line(ctx, points, color, 3.5);
    for (const point of [base, joint]) { ellipse(ctx, point.x, point.y, 3.3, 3.3, '#c6d4df', '#304559'); }
    line(ctx, [[tip.x - 4, tip.y - open], [tip.x + 2, tip.y - open], [tip.x + 4, tip.y - open + 2]], color, 1.8);
    line(ctx, [[tip.x - 4, tip.y + open], [tip.x + 2, tip.y + open], [tip.x + 4, tip.y + open - 2]], color, 1.8);
    return tip;
}

function cargoLabel(cargo: RobotCargo): string {
    if (cargo.page !== undefined) { return (cargo.kind === 'preview' ? 'preview ' : 'p.') + cargo.page + (cargo.count > 1 ? ' +' + (cargo.count - 1) : ''); }
    if (cargo.kind !== 'bytes') { return cargo.kind; }
    const amount = cargo.bytes >= 1024 * 1024 ? (cargo.bytes / (1024 * 1024)).toFixed(1) + 'M' : Math.round(cargo.bytes / 1024) + 'K';
    return amount + (cargo.count > 1 ? ' ×' + cargo.count : '');
}
function parcel(ctx: Paint, x: number, y: number, cargo: RobotCargo, angle = 0): void {
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    const size = cargo.kind === 'bytes' ? clamp(12 + Math.log2(Math.max(1, cargo.bytes / 4096)), 12, 24) : 17;
    const color = cargo.kind === 'bytes' ? '#d99d5a' : cargo.kind === 'preview' ? '#9acfe8' : '#eaf2e2';
    rounded(ctx, -size / 2, -10, size, 19, 2, color, '#445466');
    if (cargo.kind === 'bytes') {
        rounded(ctx, -2, -10, 4, 19, 0, '#f5d28c', '');
        for (let index = 0; index < 5; index++) { line(ctx, [[-size / 2 + 3 + index * 1.5, 2], [-size / 2 + 3 + index * 1.5, 6]], '#695946', 0.7); }
    } else {
        rounded(ctx, -5, -6, 10, 5, 1, cargo.kind === 'preview' ? '#537fa6' : '#8cb5a2', '');
        line(ctx, [[-5, 2], [5, 2]], '#667789', 1);
        line(ctx, [[-5, 5], [2, 5]], '#667789', 1);
    }
    label(ctx, cargoLabel(cargo), 0, 21, '#e4edf8', 7);
    ctx.restore();
}

class RobotStagePainter {
    private readonly context: Paint;
    private readonly background: HTMLCanvasElement;
    private readonly bodies = new Map<RobotVehicle, HTMLCanvasElement>();
    private readonly ratio: number;
    constructor(private readonly canvas: HTMLCanvasElement) {
        const doc = canvas.ownerDocument;
        this.ratio = Math.min(2, doc.defaultView?.devicePixelRatio || 1);
        canvas.width = Math.ceil(ROBOT_LIMITS.width * this.ratio);
        canvas.height = Math.ceil(ROBOT_LIMITS.height * this.ratio);
        this.context = canvas.getContext('2d', { alpha: false })!;
        this.background = doc.createElement('canvas');
        this.background.width = canvas.width; this.background.height = canvas.height;
        const bg = this.background.getContext('2d')!;
        bg.scale(this.ratio, this.ratio);
        this.paintBackground(bg);
        for (const vehicle of ROBOT_VEHICLES) {
            const image = doc.createElement('canvas');
            image.width = Math.ceil(128 * this.ratio); image.height = Math.ceil(100 * this.ratio);
            const ctx = image.getContext('2d')!;
            ctx.scale(this.ratio, this.ratio); ctx.translate(64, 50);
            bodyArtwork(ctx, vehicle);
            this.bodies.set(vehicle.id, image);
        }
    }

    private paintBackground(ctx: Paint): void {
        const sky = ctx.createLinearGradient(0, 0, 0, ROBOT_LIMITS.height);
        sky.addColorStop(0, '#0b1424'); sky.addColorStop(0.65, '#172b42'); sky.addColorStop(1, '#1c3448');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, ROBOT_LIMITS.width, ROBOT_LIMITS.height);
        ctx.strokeStyle = '#263b50'; ctx.lineWidth = 0.6;
        for (let x = -120; x < 620; x += 40) { line(ctx, [[240 + (x - 240) * 0.45, 153], [x, 250]], '#294054', 0.6); }
        for (const y of [158, 170, 187, 211, 243]) { line(ctx, [[0, y], [480, y]], '#294054', 0.6); }
        rounded(ctx, 12, 113, 49, 93, 5, '#152439', '#38536c');
        for (let y = 125; y < 193; y += 15) {
            rounded(ctx, 20, y, 32, 9, 2, '#20374e', '#4a5e72');
            ellipse(ctx, 25, y + 4, 1.3, 1.3, '#79dbc9');
        }
        label(ctx, 'FETCH', 37, 104, '#91b4ce', 9);
        rounded(ctx, 401, 92, 66, 114, 4, '#162839', '#50677c');
        for (let index = 0; index < 3; index++) {
            const y = 111 + index * 34;
            line(ctx, [[404, y + 17], [464, y + 17]], '#657d8e', 2);
            label(ctx, ['PAGES', 'PREVIEWS', 'BYTES'][index], 434, y - 8, '#91b4ce', 7);
            for (let sheet = 0; sheet < 4; sheet++) {
                rounded(ctx, 412 + sheet * 10, y - 2, 7, 15, 1, ['#a2cfb3', '#78a6c5', '#ba9563'][index], '#385367');
            }
        }
        ctx.setLineDash([3, 6]); line(ctx, [[70, 223], [395, 223]], '#467183', 1); ctx.setLineDash([]);
        label(ctx, 'L A R I C S   /   F L E E T   D I S P A T C H', 18, 21, '#7698b4', 7, 'left');
        for (const [x, y] of [[112, 41], [359, 33], [298, 119], [79, 82]]) {
            line(ctx, [[x - 3, y], [x + 3, y]], '#354f69', 0.8);
            line(ctx, [[x, y - 3], [x, y + 3]], '#354f69', 0.8);
        }
    }

    draw(frame: RobotFrame, reduced = false): void {
        const ctx = this.context;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.background, 0, 0);
        ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
        const time = reduced ? 0 : frame.at / 1000;
        const panic = frame.mode === 'outage';
        ellipse(ctx, 457, 20, 3, 3, panic ? '#ff9a7d' : frame.mode === 'quiet' ? '#b5a7df' : '#70e7d3');
        label(ctx, frame.missingPage === null ? 'viewport supplied' : 'waiting for p.' + frame.missingPage, 454, 36, panic ? '#ffbaa0' : '#96afc5', 7, 'right');
        label(ctx, frame.queuedCargo.length + ' queued · ' + frame.pending + ' preparing', 20, 240, '#8aa8be', 7, 'left');
        label(ctx, frame.stats.deliveredCargo + ' arrivals', 458, 240, '#8aa8be', 7, 'right');
        for (const prop of frame.props) { this.paintProp(ctx, prop, time, frame); }
        if (frame.mode === 'quiet') { this.paintQuiet(ctx, frame); }
        for (const actor of frame.actors) {
            if (actor.partner === null || actor.job !== 'help') { continue; }
            const other = frame.actors.find(candidate => candidate.id === actor.partner);
            if (!other) { continue; }
            ctx.setLineDash([2, 3]);
            line(ctx, [[actor.x, actor.y + 10], [other.x, other.y - 10]], '#6cddcc', 1.2);
            ctx.setLineDash([]);
        }
        const ordered = [...frame.actors].sort((a, b) => a.y - b.y);
        for (const actor of ordered) { this.paintActor(ctx, actor, frame, time, reduced); }
        if (!reduced) {
            for (const particle of frame.particles) {
                ctx.globalAlpha = Math.sin(Math.PI * particle.age / particle.life) * 0.8;
                if (particle.kind === 'confetti') {
                    ctx.save(); ctx.translate(particle.x, particle.y); ctx.rotate(particle.age * 4);
                    rounded(ctx, -1.5, -3, 3, 6, 0.5, particle.color, ''); ctx.restore();
                } else {
                    ellipse(ctx, particle.x, particle.y, particle.kind === 'spark' ? 1.3 : 2.2, 1, particle.color);
                }
            }
            ctx.globalAlpha = 1;
        }
    }

    private paintActor(ctx: Paint, actor: RobotFrame['actors'][number], frame: RobotFrame, time: number, reduced: boolean): void {
        const spec = vehicleOf(actor);
        const moving = Math.hypot(actor.vx, actor.vy);
        const panicking = frame.mode === 'outage' && (actor.needsHelp || actor.activity === 'yield' || actor.activity === 'replan' || actor.activity === 'balance');
        const scale = spec.air ? 0.83 : 0.86;
        const quiet = reduced || frame.mode === 'quiet' && actor.job !== 'delivery' && actor.job !== 'help' && moving < 2;
        const bob = spec.air && !quiet ? Math.sin(time * (1.9 + actor.temperament) + actor.phase) * 1.2 : 0;
        const bank = spec.air && !quiet ? clamp(actor.vx / 450 + actor.vy / 350, -0.2, 0.2) : 0;
        ellipse(ctx, actor.x, spec.air ? 222 - (222 - actor.y) * 0.07 : actor.y + 17,
            spec.air ? 15 : 22, spec.air ? 3 : 4, spec.air ? '#05111c35' : '#06132080');
        ctx.save(); ctx.translate(actor.x, actor.y + bob); ctx.rotate(bank);
        ctx.scale(scale, scale);
        const gait = quiet ? actor.phase : actor.distance / 11;
        if (actor.vehicle === 'walker' || actor.vehicle === 'hexapod') {
            const feet = actor.vehicle === 'walker' ? [-17, -10, 11, 18] : [-19, -11, -3, 5, 13, 21];
            feet.forEach((hip, index) => {
                const phase = gait + (index % 2) * Math.PI;
                const stride = moving > 2 && !quiet ? Math.sin(phase) * 7 : 0;
                const lift = moving > 2 && !quiet ? Math.max(0, Math.cos(phase)) * 6 : 0;
                const foot = { x: hip + stride + (index % 2 ? 4 : -4), y: 23 - lift };
                const knee = { x: hip + 6 * (index % 2 ? 1 : -1) + stride * 0.4, y: 10 };
                line(ctx, [[hip, 2], [knee.x, knee.y], [foot.x, foot.y]], LAB_INK, 5);
                line(ctx, [[hip, 2], [knee.x, knee.y], [foot.x, foot.y]], index % 2 ? spec.color : '#677c95', 2.7);
                ellipse(ctx, knee.x, knee.y, 2.1, 2.1, '#d4d9e6');
                rounded(ctx, foot.x - 3, foot.y - 1, 7, 3, 1, '#20303e', '');
            });
        }
        ctx.drawImage(this.bodies.get(actor.vehicle)!, -64, -50, 128, 100);
        if (!spec.air && actor.vehicle !== 'walker' && actor.vehicle !== 'hexapod') {
            const wheels = actor.vehicle === 'rover' ? [-20, 0, 20] : [-17, 16];
            for (const x of wheels) {
                const angle = quiet ? 0 : actor.distance / 7;
                line(ctx, [[x - Math.cos(angle) * 3.7, 14 - Math.sin(angle) * 3.7], [x + Math.cos(angle) * 3.7, 14 + Math.sin(angle) * 3.7]], '#d4e0e5', 1);
            }
        }
        if (spec.air) {
            const motors = ROTOR_LAYOUT[actor.vehicle]!;
            motors.forEach(([x, y], index) => {
                const phase = quiet ? index : time * (38 + actor.temperament * 5) + index;
                ctx.save(); ctx.translate(x, y - 3); ctx.scale(1, 0.32);
                ctx.rotate(phase);
                ellipse(ctx, 0, 0, 13, 2, quiet ? '#8ba6b966' : '#c1e8ec80');
                ellipse(ctx, 0, 0, 2, 13, quiet ? '#6f879966' : '#8ec6d280');
                ctx.restore();
            });
        }
        let faceX = 0, faceY = -5;
        if (actor.vehicle === 'rover') { faceY = -11; }
        if (actor.vehicle === 'mecanum') { faceX = 13; faceY = -6; }
        if (actor.vehicle === 'forklift') { faceX = -1; faceY = -15; }
        if (actor.vehicle === 'hexapod') { faceY = -8; }
        if (actor.vehicle === 'walker') { faceX = 21; faceY = -11; }
        const sleeping = actor.activity === 'sleep' || frame.mode === 'quiet' && actor.job !== 'delivery';
        const blink = sleeping || !quiet && Math.sin(time * 1.4 + actor.phase) > 0.995;
        for (const side of [-1, 1]) {
            const ex = faceX + side * (actor.vehicle === 'walker' || actor.vehicle === 'mecanum' ? 2.6 : 4);
            if (blink) { line(ctx, [[ex - 2, faceY], [ex + 2, faceY]], '#9adbcf', 1.2); }
            else {
                ellipse(ctx, ex, faceY, panicking ? 2.9 : 2, panicking ? 3.3 : 2.5, panicking ? '#fff4dc' : '#a2eddd');
                ellipse(ctx, ex + actor.look * 0.8, faceY + (panicking ? 0.6 : 0), 0.8, 1.2, LAB_INK);
            }
        }
        if (panicking) {
            line(ctx, [[faceX - 6, faceY - 5], [faceX - 2, faceY - 6]], '#fff0c5', 1);
            line(ctx, [[faceX + 2, faceY - 6], [faceX + 6, faceY - 4]], '#fff0c5', 1);
            const sway = quiet ? 0 : Math.sin(time * 8 + actor.phase) * 1.5;
            ctx.beginPath(); ctx.moveTo(faceX + 11, faceY - 7 + sway);
            ctx.quadraticCurveTo(faceX + 17, faceY - 1 + sway, faceX + 12, faceY + 1 + sway);
            ctx.quadraticCurveTo(faceX + 8, faceY - 1 + sway, faceX + 11, faceY - 7 + sway);
            ctx.fillStyle = '#8addf5'; ctx.fill();
        }
        const gesturing = ['weld', 'assist', 'signal', 'calibrate', 'balance', 'read', 'celebrate'].includes(actor.activity);
        if (actor.vehicle === 'mecanum' || actor.vehicle === 'rover') {
            const reach = actor.carrying ? { x: 24, y: -20 }
                : actor.activity === 'celebrate' ? { x: 8 + Math.sin(time * 5) * 12, y: -43 }
                    : gesturing ? { x: 25, y: -16 + Math.sin(time * 3 + actor.phase) * 5 } : { x: -12, y: -28 };
            drawArm(ctx, { x: -9, y: -10 }, reach, spec.color, actor.activity === 'load' ? 6 : 2.5);
        }
        if (actor.vehicle === 'heavyquad' && (gesturing || actor.carrying)) {
            drawArm(ctx, { x: 0, y: 14 }, { x: actor.carrying ? 2 : 25, y: actor.carrying ? 37 : 30 }, spec.color, actor.carrying ? 2 : 5);
        }
        if (actor.vehicle === 'forklift') {
            const lift = actor.carrying ? actor.activity === 'unload' ? 10 + actor.progress * 25 : 12
                : actor.activity === 'lift' ? 8 + Math.sin(time * 2) * 12 : 0;
            line(ctx, [[21, 12 - lift], [39, 12 - lift]], '#e6c37b', 3);
            line(ctx, [[21, 16 - lift], [38, 16 - lift]], '#809aaa', 1);
        }
        if (actor.carrying && actor.cargo) {
            if (spec.air) {
                line(ctx, [[-7, 14], [-7, 33], [0, 38], [7, 33], [7, 14]], '#9cbdc6', 1);
                parcel(ctx, 0, 36, actor.cargo, quiet ? 0 : -bank * 0.8 + Math.sin(time * 2 + actor.phase) * 0.07);
            } else {
                const lift = actor.vehicle === 'forklift' && actor.activity === 'unload' ? actor.progress * 24 : 0;
                parcel(ctx, actor.vehicle === 'forklift' ? 33 : 19, -18 - lift, actor.cargo);
            }
        }
        if (actor.needsHelp || actor.yieldTo !== null || actor.activity === 'replan') {
            const text = actor.needsHelp ? 'SOS' : actor.yieldTo !== null ? 'after you?' : 'REPLAN';
            const width = text.length * 4.2 + 8;
            rounded(ctx, -width / 2, -45, width, 13, 4, '#ffebc9', '#bb8755');
            label(ctx, text, 0, -36, '#62412d', 6);
        }
        label(ctx, spec.name, 0, spec.air ? -27 : 37, '#9fb7c9', 6);
        ctx.restore();
    }

    private paintProp(ctx: Paint, prop: SceneProp, time: number, frame: RobotFrame): void {
        ctx.save(); ctx.translate(prop.x, prop.y);
        const wave = Math.sin(time * 2);
        switch (prop.kind) {
        case 'covariance':
            ctx.save(); ctx.rotate(-0.2);
            for (let index = 0; index < 3; index++) {
                ctx.beginPath(); ctx.ellipse(0, 0, 33 + index * 14 + wave * 4, 13 + index * 5, 0, 0, TAU);
                ctx.strokeStyle = ['#c6a2f590', '#c6a2f560', '#c6a2f530'][index]; ctx.lineWidth = 1; ctx.stroke();
            }
            ctx.restore(); label(ctx, prop.label!, 0, -32, '#d8baf8', 10); break;
        case 'cones':
            for (const x of [-29, 0, 29]) {
                ctx.beginPath(); ctx.moveTo(x, -14); ctx.lineTo(x - 7, 4); ctx.lineTo(x + 7, 4); ctx.closePath();
                ctx.fillStyle = '#f3a66c'; ctx.fill(); line(ctx, [[x - 5, -2], [x + 5, -2]], '#ffe1bd', 2);
                rounded(ctx, x - 9, 4, 18, 3, 1, '#604f49', '');
            } break;
        case 'map':
            rounded(ctx, -23, -19, 46, 33, 3, '#d2dcb8', '#607b75');
            line(ctx, [[-17, 7], [-8, -9], [4, 3], [16, -12]], '#608c78', 1.3);
            ctx.setLineDash([2, 2]); line(ctx, [[-17, 7], [5, 8], [16, -12]], '#b7745e', 1); ctx.setLineDash([]);
            label(ctx, prop.label!, 0, 26, '#dce3b4', 7); break;
        case 'rescue':
            ctx.setLineDash([4, 3]); ellipse(ctx, 0, 4, 29, 8, '#ff9b6a0d', '#ba8a67'); ctx.setLineDash([]);
            label(ctx, 'RETRIEVAL ZONE', 0, 18, '#d0ab84', 6); break;
        case 'traffic':
            rounded(ctx, -7, -25, 14, 29, 3, '#182638', '#9bb0b6');
            ellipse(ctx, 0, -18, 3, 3, time % 4 < 2 ? '#ff9a7d' : '#49382d');
            ellipse(ctx, 0, -8, 3, 3, time % 4 >= 2 ? '#8de0b4' : '#2f4a41');
            line(ctx, [[0, 4], [0, 26]], '#8da3ac', 2); label(ctx, prop.label!, 0, -33, '#d3c18b', 6); break;
        case 'tools':
            rounded(ctx, -15, -8, 30, 17, 3, '#bd7360', '#e1ae8d');
            line(ctx, [[-7, -8], [-7, -13], [7, -13], [7, -8]], '#d5c0aa', 2);
            line(ctx, [[-6, 1], [7, 1]], '#342c2a', 2); break;
        case 'helipad':
            ellipse(ctx, 0, 0, 30, 8, '#1a4255', '#6cbcb9');
            line(ctx, [[-8, -4], [-8, 4]], '#a4ddd0', 2); line(ctx, [[8, -4], [8, 4]], '#a4ddd0', 2);
            line(ctx, [[-8, 0], [8, 0]], '#a4ddd0', 2); break;
        case 'parcel-pile':
            for (let index = 0; index < 3; index++) { parcel(ctx, (index % 2 ? 9 : -9), -index * 11, { kind: 'page', page: frame.pendingPages[index] ?? frame.missingPage ?? undefined, bytes: 0, count: 1 }, index * 0.04); }
            break;
        case 'battery':
            rounded(ctx, -15, -15, 30, 22, 3, '#6fc3a1', '#c2f1cf');
            rounded(ctx, -7, -19, 14, 4, 1, '#c4e8cf', '');
            ctx.beginPath(); ctx.moveTo(2, -12); ctx.lineTo(-5, -2); ctx.lineTo(1, -2); ctx.lineTo(-2, 5); ctx.lineTo(7, -6); ctx.lineTo(1, -6);
            ctx.fillStyle = '#f1efbb'; ctx.fill(); label(ctx, prop.label!, 0, 20, '#9ed5bc', 6); break;
        case 'dish':
            line(ctx, [[0, 14], [0, -13], [18, -30]], '#829ab0', 3);
            ctx.beginPath(); ctx.arc(12, -27, 17, -0.6, 2.6); ctx.closePath(); ctx.fillStyle = '#a5bbc9'; ctx.fill();
            line(ctx, [[12, -27], [25, -38]], '#e5eff2', 1.2); break;
        case 'radio':
            for (let index = 0; index < 3; index++) {
                ctx.beginPath(); ctx.arc(0, 0, 12 + index * 9 + wave * 2, -2.4, -0.6);
                ctx.strokeStyle = '#7dcfcb' + ['aa', '66', '33'][index]; ctx.lineWidth = 1; ctx.stroke();
            } break;
        case 'stairs':
            for (let index = 0; index < 4; index++) {
                rounded(ctx, -25 + index * 12, -index * 5, 13, index * 5 + 7, 1, '#607b8b', '#a6b3b4');
            }
            label(ctx, prop.label!, 21, -27, '#b8c8d2', 9); break;
        case 'traction':
            for (let index = 0; index < 3; index++) {
                ctx.save(); ctx.rotate(-0.18); rounded(ctx, -24, -index * 5, 47, 4, 1, '#b3895e', '#d4ae76'); ctx.restore();
            } break;
        case 'juggle':
            for (let index = 0; index < 3; index++) {
                const angle = time * 1.1 + index * TAU / 3;
                parcel(ctx, Math.cos(angle) * 22, -Math.abs(Math.sin(angle)) * 30, { kind: 'preview', page: frame.pendingPages[index] ?? frame.missingPage ?? undefined, bytes: 0, count: 1 }, Math.sin(angle) * 0.22);
            } break;
        case 'bridge':
            rounded(ctx, -37, -1, 74, 9, 2, '#132439', '');
            for (let index = 0; index < 6; index++) {
                line(ctx, [[-33 + index * 11, -3], [-22 + index * 11, 8]], '#b69d77', 1.4);
                line(ctx, [[-33 + index * 11, 8], [-22 + index * 11, -3]], '#7599a9', 1.4);
            }
            line(ctx, [[-38, -4], [38, -4]], '#c2b18f', 2); break;
        case 'axes':
            for (const [angle, color, text] of [[0, '#e6938b', 'x'], [-Math.PI / 2, '#9ed3ad', 'z'], [2.4, '#99bcf5', 'y']] as const) {
                ctx.save(); ctx.rotate(angle + wave * 0.07);
                line(ctx, [[0, 0], [27, 0], [22, -3], [27, 0], [22, 3]], color, 1.5);
                label(ctx, text, 34, 3, color, 9); ctx.restore();
            }
            label(ctx, prop.label!, 0, -38, '#b7c4d8', 7); break;
        case 'cable':
            ctx.beginPath(); ctx.moveTo(-52, -4); ctx.bezierCurveTo(-14, 24, 22, -25, 54, -5);
            ctx.strokeStyle = '#d6a162'; ctx.lineWidth = 3; ctx.stroke();
            for (const x of [-53, 53]) { rounded(ctx, x - 4, -9, 9, 8, 1, '#c7bc8e', '#675b44'); }
            label(ctx, prop.label!, 0, 20, '#c8b18e', 6); break;
        case 'bench':
            rounded(ctx, -37, -10, 74, 7, 2, '#8f775c', '#bc9e74');
            line(ctx, [[-29, -3], [-29, 13]], '#718494', 3); line(ctx, [[29, -3], [29, 13]], '#718494', 3); break;
        case 'waiting-sign':
            line(ctx, [[0, -2], [0, 25]], '#9a9b85', 2);
            rounded(ctx, -32, -23, 64, 24, 2, '#c5b68d', '#e4d5a8');
            label(ctx, 'FETCHING…', 0, -8, '#5b503d', 7); break;
        }
        ctx.restore();
    }

    private paintQuiet(ctx: Paint, frame: RobotFrame): void {
        const details = new Set(frame.quietDetails);
        if (details.has(0) || details.has(1)) {
            ellipse(ctx, 218, 211, 23, 6, '#775b42');
            ellipse(ctx, 218, 208, 22, 6, '#d7ac69');
            ellipse(ctx, 218, 207, 18, 4, '#c56f58');
            for (const [x, y] of [[207, 206], [219, 205], [229, 208]]) { ellipse(ctx, x, y, 2, 1.5, '#a9bf72'); }
            rounded(ctx, 180, 193, 10, 19, 1, '#d9d4bf', '#b7b29b'); label(ctx, 'FLOUR', 185, 205, '#7b7965', 4);
        }
        if (details.has(2)) {
            for (let index = 0; index < 3; index++) {
                const x = 121 + index * 12, y = 146 + (index % 2) * 7;
                ellipse(ctx, x, y - 3, 4, 2, '#d5e8ed99'); ellipse(ctx, x, y, 4, 2.5, '#ddbb65');
                line(ctx, [[x, y - 2], [x, y + 2]], '#483d2b', 1.2);
            }
        }
        if (details.has(3)) {
            ctx.save(); ctx.translate(365, 144);
            ellipse(ctx, 0, 0, 10, 4, '#78c9c5'); line(ctx, [[-9, 0], [-15, -4], [-15, 4], [-9, 0]], '#78c9c5', 1.5);
            ellipse(ctx, 5, -1, 1, 1, '#15383a'); ctx.restore();
        }
        if (details.has(5)) {
            for (let index = 0; index < 3; index++) { rounded(ctx, 293, 212 - index * 4, 13, 3, 1, '#e5a775', ''); }
        }
        if (details.has(6)) {
            rounded(ctx, 252, 195, 14, 16, 1, '#a7b9cf', '#d1d6df'); label(ctx, 'II', 259, 207, '#4c5877', 7);
        }
        if (details.has(7)) {
            rounded(ctx, 348, 204, 12, 10, 2, '#c18e6d', '');
            line(ctx, [[354, 205], [354, 190]], '#8ebd8b', 5); line(ctx, [[354, 198], [347, 198], [347, 194]], '#8ebd8b', 3);
        }
        if (details.has(8)) {
            line(ctx, [[318, 160], [318, 140], [325, 135]], '#b4c9d4', 1); ellipse(ctx, 325, 135, 1.5, 1.5, '#b4c9d4');
        }
        if (details.has(9)) {
            ctx.beginPath(); ctx.moveTo(289, 126); ctx.lineTo(277, 117); ctx.lineTo(286, 131); ctx.lineTo(301, 125); ctx.lineTo(290, 128); ctx.closePath();
            ctx.fillStyle = '#c5d8df'; ctx.fill();
        }
        if (details.has(10)) {
            rounded(ctx, 234, 196, 9, 11, 2, '#b5d1d0', '#d4e7e4');
            ctx.beginPath(); ctx.arc(245, 201, 3, -1.4, 1.4); ctx.strokeStyle = '#b5d1d0'; ctx.lineWidth = 1.5; ctx.stroke();
        }
    }

    dispose(): void {
        this.canvas.width = this.canvas.height = 0;
        this.background.width = this.background.height = 0;
        for (const body of this.bodies.values()) { body.width = body.height = 0; }
        this.bodies.clear();
    }
}


export interface RobotLab {
    setActive(active: boolean): void;
    update(input: RobotTelemetry): void;
    snapshot(): RobotFrame & { renderer: { active: boolean; scheduled: boolean; reducedMotion: boolean; frames: number; meanDrawMs: number; maxDrawMs: number } };
    dispose(): void;
}

/** The diagnostics tick supplies data; animation frames reuse it without sampling the PDF. */
export function installPrefetchRobots(stage: HTMLElement): RobotLab {
    const doc = stage.ownerDocument;
    const win = doc.defaultView!;
    const seed = new Uint32Array(1);
    win.crypto.getRandomValues(seed);
    const model = new RobotChoreographer(seed[0]);
    const canvas = doc.createElement('canvas');
    const caption = doc.createElement('div');
    const activity = doc.createElement('div');
    canvas.className = 'robot-canvas';
    caption.className = 'robot-caption';
    activity.className = 'robot-activity';
    stage.append(canvas, caption, activity);
    stage.setAttribute('aria-hidden', 'true');
    stage.style.pointerEvents = 'none';
    const painter = new RobotStagePainter(canvas);
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    let input: RobotTelemetry = {};
    let active = false;
    let inView = true;
    let disposed = false;
    let raf: number | undefined;
    let lastDraw = -Infinity;
    let frames = 0, totalDrawMs = 0, maxDrawMs = 0;
    let latest = model.snapshot();

    function render(now: number): void {
        const started = win.performance.now();
        latest = media.matches ? model.snapshot() : model.step(now);
        painter.draw(latest, media.matches);
        if (caption.textContent !== latest.caption) { caption.textContent = latest.caption; }
        const working = latest.actors.filter(actor => actor.job === 'delivery').length;
        const text = latest.mode === 'quiet'
            ? 'Waiting tableau · the outage repertoire has finished'
            : working + ' couriers · ' + latest.stats.yields + ' yields · ' + latest.stats.assists + ' assists · ' + latest.stats.replans + ' replans';
        if (activity.textContent !== text) { activity.textContent = text; }
        stage.dataset.mode = latest.mode;
        stage.dataset.scene = latest.scene;
        const elapsed = win.performance.now() - started;
        totalDrawMs += elapsed;
        maxDrawMs = Math.max(maxDrawMs, elapsed);
        frames++;
    }

    function cancel(): void {
        if (raf !== undefined) { win.cancelAnimationFrame(raf); raf = undefined; }
    }

    function loop(now: number): void {
        raf = undefined;
        if (!active || disposed || doc.hidden || !inView || media.matches) { return; }
        const interval = 1000 / ROBOT_LIMITS.maxFps;
        const elapsed = now - lastDraw;
        if (!Number.isFinite(lastDraw) || elapsed >= interval) {
            lastDraw = Number.isFinite(lastDraw) ? now - elapsed % interval : now;
            render(now);
        }
        if (wantsAnimation()) { raf = win.requestAnimationFrame(loop); }
    }

    function wantsAnimation(): boolean {
        return latest.mode !== 'quiet' || latest.particles.length > 0 || latest.actors.some(actor =>
            actor.job === 'delivery' || actor.job === 'help' || Math.hypot(actor.vx, actor.vy) > 2);
    }

    function schedule(): void {
        cancel();
        if (!active || disposed || doc.hidden || !inView) { return; }
        render(win.performance.now());
        lastDraw = win.performance.now();
        if (!media.matches && wantsAnimation()) { raf = win.requestAnimationFrame(loop); }
    }

    function visibility(): void {
        if (doc.hidden) { cancel(); }
        else { schedule(); }
    }

    function motionChanged(): void { schedule(); }
    doc.addEventListener('visibilitychange', visibility);
    media.addEventListener('change', motionChanged);
    const observer = new win.IntersectionObserver(entries => {
        const entry = entries[entries.length - 1];
        inView = !!entry?.isIntersecting;
        if (inView) { schedule(); } else { cancel(); }
    });
    observer.observe(stage);

    const api: RobotLab = {
        setActive(value): void {
            if (disposed || active === value) { return; }
            active = value;
            if (active) {
                model.open(win.performance.now(), input);
                schedule();
            } else {
                cancel();
            }
        },
        update(value): void {
            input = value;
            if (!active || disposed || doc.hidden || !inView) { return; }
            model.update(win.performance.now(), value);
            if (media.matches) { render(win.performance.now()); }
            else if (raf === undefined) { schedule(); }
        },
        snapshot() {
            return {
                ...latest,
                renderer: {
                    active, scheduled: raf !== undefined, reducedMotion: media.matches,
                    frames, meanDrawMs: frames ? totalDrawMs / frames : 0, maxDrawMs,
                },
            };
        },
        dispose(): void {
            if (disposed) { return; }
            disposed = true;
            active = false;
            cancel();
            observer.disconnect();
            doc.removeEventListener('visibilitychange', visibility);
            media.removeEventListener('change', motionChanged);
            painter.dispose();
            stage.replaceChildren();
            delete (stage as HTMLElement & { robotLab?: RobotLab }).robotLab;
        },
    };
    (stage as HTMLElement & { robotLab?: RobotLab }).robotLab = api;
    return api;
}
