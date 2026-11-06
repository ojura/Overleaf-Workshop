import { ROBOT_AIRLIFT_ATTACHMENT, type RobotVehicle } from './prefetch-robots';
import { planRobotRescue, ROBOT_RESCUE_CAPABILITIES, ROBOT_RESCUE_POLICY, type RobotRescuePlan } from './robot-rescue';
import { GROUND_ROUTE_MAX_SLOPE } from './robot-cargo-routes';
import { robotActivityPhase, type RobotCommitment } from './robot-operations';

/** Activity-owned lines share the renderer's existing readable caption owner and finite clock. */
export const ROBOT_OPERATION_DIALOGUE = Object.freeze({ effort: 'Hiyaaaa!', triumph: 'Uspjelo je!',
    expensive: 'Uspjelo je. Samo malo dima…', failure: 'Dobar pokušaj. Ekipa, oporavak!' });

/** Rare document-traffic episodes. The renderer owns time, motion and all scheduling. */
export const ROBOT_ENCOUNTER_POLICY = Object.freeze({
    trafficChance: 0.22,
    successChance: 0.24,
    rescueChance: 0.06,
    rescueAttemptIntervalMs: 12000,
    attemptIntervalMs: 3500,
    cooldownMs: 8500,
    lookaheadMs: 240,
    maxSampleGapMs: 200,
    minSpeed: 0.025,
    maxSpeed: 3,
    nearRadius: 1.65,
    rearmRadius: 3.8,
    minDurationMs: 560,
    maxDurationMs: 1550,
    endMarginMs: 40,
    captionBaseMs: 1200,
    captionCharacterMs: 45,
    captionMinMs: 1800,
    captionMaxMs: 4000,
    maxCaptionActors: 3,
    gestureSteps: 12,
});

export type RobotEncounterKind = 'bump' | 'near-miss' | 'reunion' | 'success' | 'rescue';
export type RobotExpression = 'drowsy' | 'startled' | 'annoyed' | 'sheepish' | 'pleased';
export const ROBOT_BOOK_CHARACTERS = Object.freeze({
    pioneer: Object.freeze({ model: 'Pioneer', names: Object.freeze(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']),
        source: 'User-supplied historic Pioneer fleet names' }),
    scoutMini: Object.freeze({ model: 'Agilex Scout Mini', source: '30 godina LARICS-a/main.tex:9336–9350' }),
    aircraft: Object.freeze({
        families: Object.freeze(['Eagle', 'Hawk', 'Falcon', 'Duck', 'Tukan']),
        colors: Object.freeze(['Red', 'Yellow', 'Blue', 'Green', 'Orange', 'Purple']),
        otherFamilyColors: Object.freeze(['Black', 'Silver']),
        veteran: 'EagleRed', source: 'User-supplied history from Flaf: EagleRed was the first; Eagle had no Black/Silver variants',
    }),
});
export const ROBOT_INTERACTION_REACTIONS = Object.freeze({
    gestureMs: 850, captionMs: 2800, hoverMs: 2200,
    greetings: Object.freeze(['Bok, kolega!', 'Vidim te. Fotka stiže.', 'Radimo, radimo!', 'Daj pet, čim spustim ovo.']),
    carrying: 'Nosim fotografiju.', preparing: 'Pripremam dostavu.', returning: 'Vraćam se ekipi.', waiting: 'Čekam novu stranicu.',
});
interface Dialogue {
    id: string;
    kind: RobotEncounterKind;
    lines: readonly string[];
    source?: string;
}

// Book-inspired satire is dialogue, not a claim about a different vehicle's biography.
// Keep the user's wording here intact; the rendering code owns no reaction text.
export const ROBOT_ENCOUNTER_DIALOGUE: readonly Dialogue[] = Object.freeze([
    { id: 'bump-sorry', kind: 'bump', lines: ['Opa!', 'Moja greška.'] },
    { id: 'bump-collision', kind: 'bump', lines: ['Kolizije su uključene?!', 'Sad znamo.'] },
    { id: 'bump-brothers', kind: 'bump', lines: ['Bratski zagrljaj?', 'Bez branika, molim.'] },
    { id: 'bump-frkalica', kind: 'bump', lines: ['Oprosti, nisam znao da igramo Frkalicu.', 'Bez revanša, molim.'],
        source: 'Book-inspired dialogue: Frkalica, main.tex:1858–1874' },
    { id: 'bump-scout', kind: 'bump', lines: ['Scout Mini kaže: „Samo sam pet centimetara širi.“', 'Ne mjeri me, nisam u javnoj nabavi.'],
        source: '30 godina LARICS-a/main.tex:9336–9350; Scout Mini procurement story, book-inspired satire' },
    { id: 'miss-watch', kind: 'near-miss', lines: ['Pazi kuda ideš!', 'Samo sam razmišljao…'] },
    { id: 'miss-simulation', kind: 'near-miss', lines: ['Budan?', 'U simulaciji jesam.'] },
    { id: 'miss-thread', kind: 'near-miss', lines: ['Hej! Putanja!', 'Misli su mi odlutale.'] },
    { id: 'miss-coffee', kind: 'near-miss', lines: ['Kava. Odmah.', 'Prihvaćam korekciju.'] },
    { id: 'miss-fuzzy', kind: 'near-miss', lines: ['Mir, kolega. Danas nema Fightboticsa.', 'Budnost mi je malo neizrazita…'],
        source: 'Book-inspired dialogue: Erić main.tex:2781; Kovačić main.tex:2589' },
    { id: 'miss-kalman', kind: 'near-miss', lines: ['Origami manevar, bez gužvanja fotke.', 'Kalman filtrira. Ja malo drijemam.'],
        source: 'Book-inspired dialogue: Car main.tex:2709; Petrinec main.tex:3112' },
    { id: 'miss-dream', kind: 'near-miss', lines: ['Putanja, kolega!', 'Sanjam električne knjige.'],
        source: 'Book-inspired dialogue: electric dreams, main.tex:6317' },
    { id: 'miss-rest', kind: 'near-miss', lines: ['Budan?', 'Ne spavam. Obnavljam organizam.'],
        source: 'Book-inspired dialogue: skiing rest, main.tex:2116' },
    { id: 'miss-caves', kind: 'near-miss', lines: ['Hej! Putanja!', 'Samo mali đir do Baraćevih špilja.'],
        source: 'Book-inspired dialogue: spontaneous cave detour, main.tex:2444' },
    { id: 'reunion-wave', kind: 'reunion', lines: ['Kolega!', 'Daj pet!'] },
    { id: 'reunion-beer', kind: 'reunion', lines: ['Pivo poslije smjene?', 'Kad parkiramo.'] },
    { id: 'reunion-team', kind: 'reunion', lines: ['Dobra ekipa.', 'Ista putanja kući?'] },
    { id: 'reunion-marker', kind: 'reunion', lines: ['Prijatelja prepoznajem i bez markera.', 'Magnetski te vuče dobro društvo.'],
        source: 'Book-inspired dialogue: Vasiljević main.tex:3233; Martinović main.tex:2967' },
    { id: 'reunion-round', kind: 'reunion', lines: ['Petlja zatvorena. Runda otvorena.', 'Prvo fotka, onda pivo.'],
        source: 'Book-inspired dialogue: Oršulić main.tex:3049; Peti main.tex:3092' },
    { id: 'reunion-resource', kind: 'reunion', lines: ["Resurs 'zagrljaj' dodijeljen.", 'Uštimani. Kao ROBOBAND.'],
        source: 'Book-inspired dialogue: Petrović main.tex:3122; ROBOBAND main.tex:6412' },
    { id: 'reunion-lift', kind: 'reunion', lines: ['Vidi koga nosi lift!', 'Zrak i zemlja. Najbolji frendovi.'],
        source: 'Book-inspired dialogue: main.tex:1737, 8908' },
    { id: 'reunion-break', kind: 'reunion', lines: ['Još ova fotka, pa treće poluvrijeme.', 'Još ova fotka, pa na Robijevu svirku.'],
        source: 'Book-inspired dialogue: football and Jolly Rogers, main.tex:1737-1756, 6635-6644' },
    { id: 'reunion-pioneers', kind: 'reunion', lines: ['Pioneeri kažu: „still got it. barem nismo završili kao VIV.“'],
        source: 'User-supplied Pioneer/VIV callback; the current vehicle keeps its own identity' },
    { id: 'success-nailed', kind: 'success', lines: ['Nailed it.', 'Like a glove.'] },
    { id: 'success-fit', kind: 'success', lines: ['Na milimetar.', 'Timski rad.'] },
    { id: 'success-maric', kind: 'success', lines: ['ovako fino ne bi ni Marić izbrusio'],
        source: 'User-supplied dialogue; ENDORSE grinding by demonstration, main.tex:4583–4589' },
    { id: 'success-sofia', kind: 'success', lines: ['zgrabio sam ga kao SofIA'],
        source: 'User-supplied dialogue; SofIA main.tex:6862–6871' },
    { id: 'success-mbzirc', kind: 'success', lines: ['bolje prošlo nego MBZIRC'],
        source: 'User-supplied dialogue; mixed MBZIRC 2020 story main.tex:6774, distinct from the 2023 victory at 6813–6815' },
    { id: 'success-handoff', kind: 'success', lines: ['Držiš?', 'Držim. Sad možeš pustiti.'],
        source: 'Book-inspired dialogue: Marić main.tex:2927' },
    { id: 'success-map', kind: 'success', lines: ['Ti mapiraj. Ja čuvam leđa.', 'Bzz… imamo konsenzus!'],
        source: 'Book-inspired dialogue: Milas main.tex:2987; Griparić main.tex:2833' },
    { id: 'success-gentle', kind: 'success', lines: ['Nježno, kao s malinom.', 'Gripsters petica! Ni piksel ogreben.'],
        source: 'Book-inspired dialogue: Pevec main.tex:3132; Wachtler main.tex:3288' },
    { id: 'success-memories', kind: 'success', lines: ['Radionica sreće: dostava uspjela!', 'Fotka po fotka, zid uspomena.'],
        source: 'Book-inspired dialogue: Kovačević main.tex:2886; Križmančić main.tex:2907' },
    { id: 'success-precision', kind: 'success', lines: ['U sridu!', 'Prvo precizno. Onda Guinness.'],
        source: 'Book-inspired dialogue: main.tex:4041–4046, 965–967' },
    { id: 'success-care', kind: 'success', lines: ['Precizno: parizer na 0,7 milimetara.', 'Nježno, po Jeleninoj školi.'],
        source: 'Book-inspired dialogue: mock menu and compliant manipulation, main.tex:2357, 3272-3278' },
    { id: 'success-guitar', kind: 'success', lines: ['Predaja u ritmu. Sad jedan akord!'],
        source: 'Book-inspired dialogue: Spudić guitar school, main.tex:3182' },
    { id: 'success-matko', kind: 'success', lines: ['možda mi Matko nešto fino skuha'],
        source: 'Exact user-supplied reward line and cooking lore' },
    { id: 'success-caca', kind: 'success', lines: ['možda mi Ćaća nešto fino skuha'],
        source: 'User-supplied occasional nickname for Matko and cooking lore' },
    { id: 'rescue-smoke', kind: 'rescue', lines: ['Pobjegao mi je čarobni dim.', 'Drži se. Imamo ekipu.'] },
    { id: 'rescue-field', kind: 'rescue', lines: ['Terenski rad. Doslovno.', 'Prvo kolega, onda procedura.'] },
    { id: 'rescue-lugv', kind: 'rescue', lines: ['Opet me nosiš? Kakav divan kvar!', 'Samo ovaj put, kolega.'] },
]);

type Point = { x: number; y: number };
export interface RobotEncounterActor extends Point {
    id: number;
    radius: number;
    group?: number;
    phase: 'advance' | 'return' | 'deposit' | 'cargo' | 'parked';
    remainingMs: number;
    opacity: number;
    vehicle?: RobotVehicle;
    scale?: number;
    operationKey?: string;
    commitments?: readonly RobotCommitment[];
    commitmentTimeline?: readonly { until: number; commitments: readonly RobotCommitment[] }[];
    cargo?: { key: string; mass: number };
    /** A committed participant has this interval available again after its owned activity completes. */
    activity?: { key: string; until: number };
}
export interface RobotEncounterReaction {
    x: number;
    y: number;
    tilt: number;
    expression: RobotExpression;
    activity?: 'sleep' | 'signal' | 'celebrate' | 'assist' | 'stranded';
    badge: string | null;
    caption: string;
    captionId: string;
    captionUntil: number;
    gesturePhase: number;
    look?: number;
    carried?: boolean;
    malfunction?: 'sparks' | 'smoke';
}
interface Sample extends Point { at: number }
interface Incident {
    kind: RobotEncounterKind;
    ids: number[];
    origins: Point[];
    normal: Point;
    started: number;
    ends: number;
    armedUntil?: number;
    dialogue: Dialogue;
    captionId: string;
    captionUntil: number;
    rescue?: RobotRescuePlan;
    resolution?: { completion: 'fulfilled' | 'partial' | 'failed' | 'cancelled'; at: number; position: Point };
    activityPhase?: 'work' | 'aftermath' | 'recovery' | 'complete';
}
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const traffic = (actor: RobotEncounterActor) => actor.phase === 'advance' || actor.phase === 'return' || actor.phase === 'cargo';
const key = (a: number, b: number) => a < b ? a + ':' + b : b + ':' + a;
const squared = (point: Point) => point.x * point.x + point.y * point.y;
const closest = (start: Point, movement: Point) => {
    const amount = clamp(-(start.x * movement.x + start.y * movement.y) / Math.max(0.0001, squared(movement)), 0, 1);
    return Math.hypot(start.x + movement.x * amount, start.y + movement.y * amount);
};

/** At most one finite encounter and O(actor-cap²) approach latches, with no timer or history log. */
export class RobotEncounters {
    private readonly previous = new Map<number, Sample>();
    private readonly approaches = new Map<string, readonly [number, number]>();
    private incident?: Incident;
    private trafficAfter = -Infinity;
    private successAfter = -Infinity;
    private rescueAfter = -Infinity;
    private readonly rescueTried = new Set<number>();
    private rescueAttempts = 0;
    private rescues = 0;
    private cooldownUntil = -Infinity;
    private attempts = 0;
    private counts = { bump: 0, nearMiss: 0, reunion: 0, success: 0 };
    private lastAt = 0;
    private lastRescue?: { key: string; completion: 'fulfilled' | 'partial' | 'failed' | 'cancelled'; at: number;
        position: Point; target: Point; recovery: 'self' | 'assisted' | 'release'; complete: boolean };

    constructor(private readonly random: () => number, private readonly maxActors: number, private readonly operationSeed = 0) {}

    private dialogue(kind: RobotEncounterKind): Dialogue | undefined {
        const candidates = ROBOT_ENCOUNTER_DIALOGUE.filter(value => value.kind === kind);
        return candidates[Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))];
    }

    private captionDuration(dialogue: Dialogue): number {
        const policy = ROBOT_ENCOUNTER_POLICY;
        return clamp(policy.captionBaseMs + dialogue.lines.reduce((count, line) => count + line.length, 0)
            * policy.captionCharacterMs, policy.captionMinMs, policy.captionMaxMs);
    }

    private begin(kind: Exclude<RobotEncounterKind, 'rescue'>, actors: RobotEncounterActor[], at: number, normal: Point, armed = false): void {
        const duration = Math.min(ROBOT_ENCOUNTER_POLICY.maxDurationMs,
            ...actors.map(actor => actor.remainingMs - ROBOT_ENCOUNTER_POLICY.endMarginMs));
        if (duration < ROBOT_ENCOUNTER_POLICY.minDurationMs) { return; }
        const dialogue = this.dialogue(kind);
        if (!dialogue) { return; }
        this.incident = { kind, ids: actors.map(actor => actor.id), origins: actors.map(({ x, y }) => ({ x, y })),
            normal, started: at, ends: at + duration, dialogue,
            captionId: dialogue.id + ':' + at + ':' + actors.map(actor => actor.id).join(','),
            captionUntil: at + this.captionDuration(dialogue),
            armedUntil: armed ? at + ROBOT_ENCOUNTER_POLICY.lookaheadMs + 50 : undefined };
        if (!armed) { this.counts[kind === 'near-miss' ? 'nearMiss' : kind]++; }
        this.cooldownUntil = at + ROBOT_ENCOUNTER_POLICY.cooldownMs;
    }

    private tryRescue(at: number, actors: readonly RobotEncounterActor[], velocities: ReadonlyMap<number, Point>,
        ownership: readonly RobotEncounterActor[]): void {
        const policy = ROBOT_ENCOUNTER_POLICY;
        if (this.incident || at < this.cooldownUntil || at < this.rescueAfter || at < this.trafficAfter) { return; }
        const groupSizes = new Map<number, number>();
        for (const actor of ownership) { if (actor.group !== undefined) { groupSizes.set(actor.group, (groupSizes.get(actor.group) ?? 0) + 1); } }
        const eligible = actors.filter(actor => actor.vehicle && (actor.phase === 'advance' || actor.phase === 'cargo')
            && (!actor.activity || at >= actor.activity.until)
            && actor.remainingMs >= ROBOT_RESCUE_POLICY.minDurationMs + ROBOT_RESCUE_POLICY.endMarginMs
            && velocities.has(actor.id) && Math.hypot(velocities.get(actor.id)!.x, velocities.get(actor.id)!.y) >= policy.minSpeed);
        const disabled = eligible.find(actor => !this.rescueTried.has(actor.id));
        if (!disabled || eligible.length < 2) { return; }
        const carriedGroup = disabled.group === undefined ? [disabled] : ownership.filter(actor => actor.group === disabled.group);
        if (carriedGroup.some(actor => !eligible.includes(actor))) { return; }
        const candidates = eligible.filter(actor => actor.id !== disabled.id && !carriedGroup.includes(actor)
            && (actor.group === undefined || groupSizes.get(actor.group) === 1)
            && (ROBOT_RESCUE_CAPABILITIES[actor.vehicle!].mobility === 'air'
                || Math.abs(actor.y - disabled.y) <= Math.abs(actor.x - disabled.x) * GROUND_ROUTE_MAX_SLOPE));
        const plan = planRobotRescue({ ...disabled, vehicle: disabled.vehicle! },
            candidates.map(actor => ({ ...actor, vehicle: actor.vehicle! })), {
                maxHelpers: ROBOT_RESCUE_POLICY.maxHelpers,
                remainingMs: Math.min(...carriedGroup.map(actor => actor.remainingMs), ...candidates.map(actor => actor.remainingMs)),
                carriedGroup: carriedGroup.map(actor => actor.vehicle!),
                carriedCargo: carriedGroup.flatMap(actor => actor.cargo ? [actor.cargo] : []),
                operationKey: (disabled.operationKey ?? 'scene:' + disabled.vehicle) + ':relocation:'
                    + carriedGroup.map(actor => actor.vehicle).sort().join(','),
                seed: this.operationSeed, startedAt: at, allowExceptional: true,
                target: { x: disabled.x + Math.sign(velocities.get(disabled.id)!.x || 1) * disabled.radius * 2, y: disabled.y },
            });
        if (!plan) { return; }
        for (const actor of eligible) { this.rescueTried.add(actor.id); }
        this.rescueAttempts++; this.rescueAfter = at + policy.rescueAttemptIntervalMs;
        if (plan.operation?.operatingMode !== 'overreach' && this.random() >= policy.rescueChance) { return; }
        const participantIds = [...plan.participantIds, ...carriedGroup.filter(actor => actor.id !== disabled.id).map(actor => actor.id)];
        const selected = participantIds.map(id => actors.find(actor => actor.id === id)!);
        const dialogue = plan.enjoysAirlift ? ROBOT_ENCOUNTER_DIALOGUE.find(value => value.id === 'rescue-lugv')!
            : ROBOT_ENCOUNTER_DIALOGUE.filter(value => value.kind === 'rescue' && value.id !== 'rescue-lugv')[this.random() < 0.5 ? 0 : 1];
        this.incident = { kind: 'rescue', ids: participantIds, origins: selected.map(({ x, y }) => ({ x, y })),
            normal: { x: 0, y: 0 }, started: at, ends: at + plan.durationMs, rescue: { ...plan, participantIds }, dialogue,
            captionId: dialogue.id + ':' + at + ':' + plan.participantIds.join(','),
            captionUntil: at + this.captionDuration(dialogue) };
        this.rescues++; this.cooldownUntil = at + policy.cooldownMs;
    }

    private resolveRescue(active: Incident, at: number, cancelled = false): void {
        const plan = active.rescue;
        if (!plan) { return; }
        const workEnd = plan.operation?.timing.workEnd ?? active.started + plan.durationMs * plan.phases.assistEnd;
        const elapsed = at >= workEnd;
        if (!active.resolution && (cancelled || elapsed)) {
            const completion = elapsed ? plan.operation?.outcome.completion ?? 'fulfilled' : 'cancelled';
            const progress = elapsed ? plan.operation?.outcome.progress ?? 1 : 0;
            active.resolution = { completion, at: elapsed ? workEnd : at, position: {
                x: plan.goal.from.x + (plan.goal.target.x - plan.goal.from.x) * progress,
                y: plan.goal.from.y + (plan.goal.target.y - plan.goal.from.y) * progress } };
            this.lastRescue = { key: plan.operation?.key ?? active.captionId, ...active.resolution,
                target: { ...plan.goal.target }, recovery: plan.operation?.outcome.recovery ?? 'self', complete: false };
        }
        active.activityPhase = plan.operation ? robotActivityPhase(plan.operation, at, !!active.resolution)
            : at >= active.ends ? 'complete' : at >= workEnd ? 'recovery' : 'work';
        if (active.resolution && this.lastRescue && (cancelled || active.activityPhase === 'complete')) {
            // Work earns its recorded outcome before an owning event ends the remaining recovery.
            if (cancelled && at < active.ends) { this.lastRescue.recovery = 'release'; }
            active.activityPhase = 'complete'; this.lastRescue.complete = true;
        }
    }

    update(at: number, input: readonly RobotEncounterActor[], successfulDeposits: readonly (readonly number[])[] = []): Map<number, RobotEncounterReaction> {
        this.lastAt = at;
        const policy = ROBOT_ENCOUNTER_POLICY;
        const ownership = input.slice(0, this.maxActors).filter(actor => Number.isFinite(actor.x + actor.y + actor.radius) && actor.radius > 0);
        const actors = ownership.filter(actor => actor.opacity > 0.2);
        const current = new Map(actors.map(actor => [actor.id, actor]));
        for (const id of this.rescueTried) { if (!current.has(id)) { this.rescueTried.delete(id); } }
        const velocities = new Map<number, Point>();
        for (const actor of actors) {
            const before = this.previous.get(actor.id), elapsed = before ? at - before.at : 0;
            if (before && elapsed > 0 && elapsed <= policy.maxSampleGapMs) {
                const velocity = { x: (actor.x - before.x) / elapsed, y: (actor.y - before.y) / elapsed };
                if (Math.hypot(velocity.x, velocity.y) <= policy.maxSpeed) { velocities.set(actor.id, velocity); }
            }
        }
        const contact = (a: RobotEncounterActor, b: RobotEncounterActor) => {
            const distance = Math.hypot(a.x - b.x, a.y - b.y), radius = a.radius + b.radius;
            const pa = this.previous.get(a.id), pb = this.previous.get(b.id);
            if (distance <= radius) { return true; }
            return !!pa && !!pb && velocities.has(a.id) && velocities.has(b.id)
                && closest({ x: pa.x - pb.x, y: pa.y - pb.y },
                    { x: a.x - b.x - pa.x + pb.x, y: a.y - b.y - pa.y + pb.y }) <= radius;
        };
        for (const [pair, ids] of this.approaches) {
            const a = current.get(ids[0]), b = current.get(ids[1]);
            if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > (a.radius + b.radius) * policy.rearmRadius) { this.approaches.delete(pair); }
        }
        let active = this.incident;
        const interrupted = active && active.ids.some(id => {
            const actor = current.get(id);
            return !actor || (active!.kind === 'success' ? actor.phase !== 'deposit' && actor.phase !== 'return'
                : active!.kind === 'rescue' ? actor.phase !== 'advance' && actor.phase !== 'cargo' : !traffic(actor));
        });
        if (active) { this.resolveRescue(active, at, !!interrupted && at < active.ends); }
        if (active && (at >= active.ends || interrupted)) { this.incident = active = undefined; }
        if (active?.armedUntil !== undefined) {
            const a = current.get(active.ids[0])!, b = current.get(active.ids[1])!;
            if (at > active.armedUntil) { this.incident = active = undefined; }
            else if (contact(a, b) && active.ends - at >= policy.minDurationMs) {
                active.started = at; active.armedUntil = undefined; this.counts.bump++;
                active.captionUntil = at + this.captionDuration(active.dialogue);
            }
        }
        if (!active && at >= this.cooldownUntil && at >= this.successAfter && successfulDeposits.length) {
            const deposit = successfulDeposits.map(ids => ids.map(id => current.get(id)).filter((actor): actor is RobotEncounterActor => !!actor
                && actor.phase === 'deposit' && actor.remainingMs >= policy.minDurationMs + policy.endMarginMs)).find(group => group.length);
            if (deposit) {
                this.attempts++; this.successAfter = at + policy.attemptIntervalMs;
                if (this.random() < policy.successChance) { this.begin('success', deposit.slice(0, policy.maxCaptionActors), at, { x: 0, y: 0 }); }
            }
        }
        if (!this.incident) {
            const candidates: Array<{ a: RobotEncounterActor; b: RobotEncounterActor; distance: number; normal: Point; touching: boolean }> = [];
            for (let i = 0; i < actors.length; i++) {
                const a = actors[i], va = velocities.get(a.id);
                if (!traffic(a) || !va || a.remainingMs < policy.minDurationMs + policy.endMarginMs) { continue; }
                for (let j = i + 1; j < actors.length; j++) {
                    const b = actors[j], vb = velocities.get(b.id), pair = key(a.id, b.id);
                    if (!traffic(b) || !vb || a.group !== undefined && a.group === b.group
                        || b.remainingMs < policy.minDurationMs + policy.endMarginMs) { continue; }
                    const relative = { x: a.x - b.x, y: a.y - b.y }, speed = { x: va.x - vb.x, y: va.y - vb.y };
                    const radius = a.radius + b.radius, distance = Math.hypot(relative.x, relative.y);
                    const magnitude = Math.hypot(speed.x, speed.y);
                    const touching = contact(a, b);
                    if (magnitude < policy.minSpeed || distance > radius * policy.rearmRadius
                        || !touching && (relative.x * speed.x + relative.y * speed.y >= 0
                            || closest(relative, { x: speed.x * policy.lookaheadMs, y: speed.y * policy.lookaheadMs }) > radius * policy.nearRadius)) { continue; }
                    if (this.approaches.has(pair)) { continue; }
                    this.approaches.set(pair, [a.id, b.id]);
                    candidates.push({ a, b, distance, touching, normal: { x: -speed.y / magnitude, y: speed.x / magnitude } });
                }
            }
            if (candidates.length && at >= this.cooldownUntil && at >= this.trafficAfter) {
                this.attempts++; this.trafficAfter = at + policy.attemptIntervalMs;
                if (this.random() < policy.trafficChance) {
                    const candidate = candidates.sort((a, b) => a.distance - b.distance)[0];
                    const choice = this.random();
                    const kind = choice < 0.3 ? 'bump' : choice < 0.75 ? 'near-miss' : 'reunion';
                    const pair = kind === 'near-miss' && choice > 0.55 ? [candidate.b, candidate.a] : [candidate.a, candidate.b];
                    const separation = Math.max(1, candidate.distance);
                    const normal = kind === 'bump' ? { x: (candidate.a.x - candidate.b.x) / separation,
                        y: (candidate.a.y - candidate.b.y) / separation } : candidate.normal;
                    this.begin(kind, pair, at, normal, kind === 'bump' && !candidate.touching);
                }
            }
        }
        this.tryRescue(at, actors, velocities, ownership);
        this.previous.clear();
        for (const actor of actors) { this.previous.set(actor.id, { x: actor.x, y: actor.y, at }); }
        const result = new Map<number, RobotEncounterReaction>();
        active = this.incident;
        if (!active || active.armedUntil !== undefined) { return result; }
        const progress = clamp((at - active.started) / (active.ends - active.started), 0, 1);
        const envelope = Math.sin(progress * Math.PI);
        for (let index = 0; index < active.ids.length; index++) {
            const actor = current.get(active.ids[index])!;
            const other = current.get(active.ids[1 - index]);
            const direction = index % 2 ? -1 : 1;
            let x = 0, y = 0, tilt = 0;
            let expression: RobotExpression = 'pleased';
            let activity: RobotEncounterReaction['activity'];
            let badge: string | null = null;
            let carried = false;
            let malfunction: RobotEncounterReaction['malfunction'];
            if (active.rescue) {
                const plan = active.rescue, phase = plan.phases;
                const casualty = current.get(plan.disabled)!, origin = active.origins[0];
                const workEnd = plan.operation ? (plan.operation.timing.workEnd - active.started) / plan.durationMs : phase.assistEnd;
                const lift = plan.kind === 'airlift' && progress >= phase.rendezvousEnd && progress < phase.assistEnd;
                const helping = clamp((progress - phase.rendezvousEnd) / (workEnd - phase.rendezvousEnd), 0, 1);
                const travel = helping * helping * (3 - 2 * helping) * (plan.operation?.outcome.progress ?? 1);
                const direction = active.origins[1].x >= origin.x ? 1 : -1;
                const ground = { x: plan.goal.from.x + (plan.goal.target.x - plan.goal.from.x) * travel,
                    y: plan.goal.from.y + (plan.goal.target.y - plan.goal.from.y) * travel
                        - (lift ? Math.sin(helping * Math.PI) * casualty.radius * 1.6 : 0) };
                let target = ground;
                const helper = plan.helpers.includes(actor.id);
                if (helper) {
                    const air = ROBOT_RESCUE_CAPABILITIES[actor.vehicle!].mobility === 'air';
                    const grab = ROBOT_AIRLIFT_ATTACHMENT;
                    const rendezvous = plan.kind === 'airlift' ? {
                        x: ground.x + grab.groundGrab.x * grab.groundScale * (casualty.scale ?? 1)
                            - grab.airGrab.x * grab.airScale * (actor.scale ?? 1),
                        y: ground.y + grab.groundGrab.y * grab.groundScale * (casualty.scale ?? 1)
                            - grab.airGrab.y * grab.airScale * (actor.scale ?? 1),
                    } : { x: ground.x + direction * (casualty.radius + actor.radius) * (index === 1 ? 1.1 : -1.1),
                        y: air ? ground.y - actor.radius * 1.6 : ground.y };
                    const amount = clamp((progress - phase.sputterEnd) / (phase.rendezvousEnd - phase.sputterEnd), 0, 1);
                    const eased = amount * amount * (3 - 2 * amount);
                    target = { x: active.origins[index].x + (rendezvous.x - active.origins[index].x) * eased,
                        y: active.origins[index].y + (rendezvous.y - active.origins[index].y) * eased };
                } else if (index > 0) {
                    target = { x: ground.x + actor.x - casualty.x, y: ground.y + actor.y - casualty.y };
                }
                if (progress >= phase.assistEnd) {
                    const amount = (progress - phase.assistEnd) / (1 - phase.assistEnd);
                    const eased = amount * amount * (3 - 2 * amount);
                    target = { x: target.x + (actor.x - target.x) * eased, y: target.y + (actor.y - target.y) * eased };
                }
                x = target.x - actor.x; y = target.y - actor.y;
                carried = !helper && lift;
                expression = !helper && progress < phase.rendezvousEnd ? 'startled'
                    : plan.enjoysAirlift || progress >= phase.assistEnd ? 'pleased' : 'sheepish';
                activity = !helper && progress < phase.rendezvousEnd ? 'stranded' : 'assist';
                if (index === 0) {
                    badge = progress < phase.rendezvousEnd ? 'SOS' : null;
                    malfunction = progress < phase.sputterEnd * 0.55 ? 'sparks' : progress < phase.rendezvousEnd ? 'smoke' : undefined;
                }
                if (plan.operation?.operatingMode === 'overreach' && plan.operation.outcome.affectedActors.includes(actor.id)) {
                    const consequence = progress >= workEnd && progress < phase.assistEnd;
                    if (consequence) {
                        expression = plan.operation.outcome.aftermath === 'none' ? 'pleased' : 'sheepish';
                        activity = plan.operation.outcome.aftermath === 'none' ? 'celebrate' : 'stranded';
                        malfunction = ['smoke', 'disabled'].includes(plan.operation.outcome.aftermath) ? 'smoke' : undefined;
                    } else if (progress >= phase.assistEnd) { malfunction = undefined; activity = 'assist'; }
                }
            } else if (active.kind === 'near-miss') {
                if (index === 1) {
                    const doze = progress < 0.24 ? 1 : clamp((0.5 - progress) / 0.26, 0, 1);
                    x = clamp(active.origins[index].x - actor.x, -actor.radius * 2, actor.radius * 2) * doze;
                    y = clamp(active.origins[index].y - actor.y, -actor.radius * 2, actor.radius * 2) * doze;
                    tilt = 13 * doze;
                    expression = progress < 0.24 ? 'drowsy' : progress < 0.55 ? 'startled' : 'sheepish';
                    activity = progress < 0.24 ? 'sleep' : 'signal'; badge = progress < 0.24 ? 'Zzz' : '!';
                } else {
                    x = active.normal.x * actor.radius * 2.2 * envelope; y = active.normal.y * actor.radius * 2.2 * envelope;
                    tilt = -18 * envelope; expression = 'annoyed'; activity = 'signal'; badge = '!';
                }
            } else if (active.kind === 'bump') {
                x = active.normal.x * actor.radius * 0.85 * envelope * direction;
                y = active.normal.y * actor.radius * 0.85 * envelope * direction;
                tilt = 12 * envelope * direction; expression = index ? 'sheepish' : 'annoyed'; activity = 'signal'; badge = '!';
            } else {
                if (active.kind === 'reunion') {
                    x = active.normal.x * actor.radius * 0.3 * envelope * direction;
                    y = active.normal.y * actor.radius * 0.3 * envelope * direction;
                }
                tilt = actor.phase === 'deposit' ? 0 : 5 * envelope * direction;
                // A satisfied face may accompany the deposit; its handling pose stays intact until return.
                if (actor.phase !== 'deposit') { activity = 'celebrate'; }
            }
            const heroic = active.rescue?.operation?.operatingMode === 'overreach' && active.rescue.helpers[0] === actor.id;
            const operation = active.rescue?.operation;
            const heroicLine = operation && at >= operation.timing.workEnd
                ? operation.outcome.family === 'valiant-failure' ? ROBOT_OPERATION_DIALOGUE.failure
                    : operation.outcome.family === 'expensive-success' ? ROBOT_OPERATION_DIALOGUE.expensive : ROBOT_OPERATION_DIALOGUE.triumph
                : ROBOT_OPERATION_DIALOGUE.effort;
            result.set(actor.id, { x, y, tilt, expression, activity, badge, carried, malfunction,
                caption: heroic ? heroicLine : active.dialogue.lines[index] ?? '',
                captionId: heroic ? active.captionId + ':' + (at >= operation!.timing.workEnd ? 'result' : 'effort') : active.captionId,
                captionUntil: heroic ? operation!.timing.deadline : active.captionUntil,
                gesturePhase: Math.floor(progress * policy.gestureSteps),
                look: other ? other.x < actor.x ? -1 : 1 : undefined });
        }
        return result;
    }

    forget(id: number, at = this.lastAt): void {
        this.lastAt = Math.max(this.lastAt, at);
        this.previous.delete(id);
        this.rescueTried.delete(id);
        for (const [pair, ids] of this.approaches) { if (ids.includes(id)) { this.approaches.delete(pair); } }
        if (this.incident?.ids.includes(id)) { this.resolveRescue(this.incident, this.lastAt, true); this.incident = undefined; }
    }
    clear(at = this.lastAt): void {
        this.lastAt = Math.max(this.lastAt, at);
        if (this.incident) { this.resolveRescue(this.incident, this.lastAt, true); }
        this.previous.clear(); this.approaches.clear(); this.rescueTried.clear(); this.incident = undefined;
    }
    reset(at = this.lastAt): void {
        this.clear(at); this.attempts = 0; this.counts = { bump: 0, nearMiss: 0, reunion: 0, success: 0 };
        this.trafficAfter = this.successAfter = this.rescueAfter = this.cooldownUntil = -Infinity;
        this.rescueAttempts = this.rescues = 0;
        this.lastRescue = undefined;
    }
    snapshot() {
        const active = this.incident;
        return { attempts: this.attempts, counts: { ...this.counts }, rescueAttempts: this.rescueAttempts, rescues: this.rescues,
            lastRescue: this.lastRescue ? { ...this.lastRescue, position: { ...this.lastRescue.position }, target: { ...this.lastRescue.target } } : undefined,
            trackedRescueActors: this.rescueTried.size, trackedActors: this.previous.size, trackedPairs: this.approaches.size,
            active: active ? { kind: active.kind, ids: [...active.ids], dialogue: active.dialogue.id,
                started: active.started, ends: active.ends, confirmed: active.armedUntil === undefined,
                rescue: active.rescue ? { ...active.rescue, helpers: [...active.rescue.helpers], participantIds: [...active.rescue.participantIds],
                    state: active.activityPhase ?? 'work', resolution: active.resolution ? { ...active.resolution, position: { ...active.resolution.position } } : undefined } : undefined } : undefined };
    }
}
