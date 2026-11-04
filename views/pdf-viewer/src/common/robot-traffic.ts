/** Unshifted group centers/radii in document CSS pixels; time and remainingMs are milliseconds. */
export interface RobotTrafficGroup {
    /** Signed safe integer: payloads and standalone actors can use separate ID ranges. */
    id: number;
    x: number;
    y: number;
    radius: number;
    ground: boolean;
    weight: number;
    remainingMs: number;
    /** A present fixed group is an obstacle and always receives exact zero translation. */
    fixed?: boolean;
    /** Endpoint envelope, clamped to 0..1; defaults to 1. Output already includes it. */
    offsetScale?: number;
    /** Defaults to !fixed. Payloads can retain their fade through a fixed handoff. */
    canFade?: boolean;
}

export interface RobotTrafficOffset {
    x: number;
    y: number;
    /** Omitted means 1. Apply to the whole group without removing it from future input. */
    visibility?: number;
}

const LIMITS = Object.freeze({ groups: 12, offset: 96, clearance: 12, lookaheadMs: 240,
    sampleGapMs: 200, stepMs: 64, easingMs: 120, offsetSpeed: 0.8, measuredSpeed: 3, passes: 3,
    fadeOutMs: 160, fadeInMs: 240, recoveryClearance: 12, overlapTolerance: 0.5 });
type Group = RobotTrafficGroup & { fixed: boolean; offsetScale: number; canFade: boolean };
interface Sample {
    x: number; y: number; at: number; offset: RobotTrafficOffset;
    visibility: number; yielding: boolean;
}
interface Axis extends RobotTrafficOffset { ground: boolean }
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const zero = (): RobotTrafficOffset => ({ x: 0, y: 0 });
const order = (a: Group, b: Group) => Number(b.fixed && !b.canFade) - Number(a.fixed && !a.canFade)
    || (a.weight === b.weight ? 0 : a.weight > b.weight ? -1 : 1)
    || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1);

function bounded(point: RobotTrafficOffset, maximum: number): RobotTrafficOffset {
    const length = Math.hypot(point.x, point.y);
    const amount = length > maximum ? maximum / length : 1;
    return { x: point.x * amount, y: point.y * amount };
}

/**
 * Deterministic spacing, independent of comic encounters. Nonfadeable fixed anchors
 * take priority, then higher weight, then lower ID. Three passes inspect at most 66 pairs each.
 * Translation is capped at 96 CSS px and eases over 120 ms, at most 0.8 px/ms.
 * Inseparable ground groups fade out in 160 ms and recover in 240 ms after an
 * additional 12 px clearance. Fixed groups never translate; canFade preserves payload
 * visibility through fixation while actual hardware remains fully visible.
 * Apply the returned offset to the entire group without another endpoint multiplier.
 */
export class RobotTraffic {
    private readonly previous = new Map<number, Sample>();
    private readonly axes = new Map<string, Axis>();
    private at?: number;

    update(now: number, input: readonly RobotTrafficGroup[]): Map<number, RobotTrafficOffset> {
        const groups: Group[] = [];
        for (const value of input) {
            if (!value || !Number.isSafeInteger(value.id) || !Number.isFinite(value.x)
                || !Number.isFinite(value.y) || !Number.isFinite(value.radius) || value.radius <= 0) { continue; }
            const fixed = value.fixed === true;
            const canFade = typeof value.canFade === 'boolean' ? value.canFade : !fixed;
            const offsetScale = typeof value.offsetScale === 'number' && !Number.isNaN(value.offsetScale)
                ? clamp(value.offsetScale, 0, 1) : 1;
            const remainingMs = Number.isFinite(value.remainingMs) ? Math.max(0, value.remainingMs) : 0;
            if (!fixed && !remainingMs) { continue; }
            const group: Group = { id: value.id, x: clamp(value.x, -1e9, 1e9), y: clamp(value.y, -1e9, 1e9),
                radius: Math.min(512, value.radius), ground: value.ground === true, fixed, canFade, offsetScale,
                weight: Number.isFinite(value.weight) ? Math.max(0, value.weight) : 0, remainingMs };
            const duplicate = groups.findIndex(candidate => candidate.id === group.id);
            if (duplicate >= 0) {
                const before = groups[duplicate];
                if (order(before, group) < 0 || order(before, group) === 0
                    && (before.x < group.x || before.x === group.x && before.y <= group.y)) { continue; }
                groups.splice(duplicate, 1);
            }
            groups.push(group); groups.sort(order);
            if (groups.length > LIMITS.groups) { groups.pop(); }
        }
        if (!groups.length) { this.reset(); return new Map(); }
        const at = Math.max(this.at ?? 0, Number.isFinite(now) ? now : this.at ?? 0);
        const step = this.at === undefined ? 0 : clamp(at - this.at, 0, LIMITS.stepMs);
        this.at = at;
        const current = new Set(groups.map(group => group.id));
        for (const id of this.previous.keys()) { if (!current.has(id)) { this.previous.delete(id); } }
        const velocities = new Map<number, RobotTrafficOffset>();
        const targets = new Map(groups.map(group => [group.id, zero()]));
        for (const group of groups) {
            const sample = this.previous.get(group.id), elapsed = sample ? at - sample.at : 0;
            velocities.set(group.id, sample && elapsed > 0 && elapsed <= LIMITS.sampleGapMs
                ? bounded({ x: (group.x - sample.x) / Math.max(1, elapsed), y: (group.y - sample.y) / Math.max(1, elapsed) }, LIMITS.measuredSpeed)
                : zero());
        }
        const used = new Set<string>();
        for (let pass = 0; pass < LIMITS.passes; pass++) {
            for (let i = 0; i < groups.length; i++) {
                const winner = groups[i], a = targets.get(winner.id)!, va = velocities.get(winner.id)!;
                for (let j = i + 1; j < groups.length; j++) {
                    const yielding = groups[j];
                    if (yielding.fixed) { continue; }
                    const b = targets.get(yielding.id)!, vb = velocities.get(yielding.id)!;
                    const key = winner.id + ':' + yielding.id;
                    const radius = winner.radius + yielding.radius + LIMITS.clearance;
                    const dx = yielding.x + b.x - winner.x - a.x, dy = yielding.y + b.y - winner.y - a.y;
                    const vx = vb.x - va.x, vy = vb.y - va.y, speedSquared = vx * vx + vy * vy;
                    const horizon = Math.min(LIMITS.lookaheadMs, yielding.remainingMs,
                        winner.fixed ? LIMITS.lookaheadMs : winner.remainingMs);
                    const ahead = speedSquared > 1e-8 ? clamp(-(dx * vx + dy * vy) / speedSquared, 0, horizon) : 0;
                    const x = dx + vx * ahead, y = dy + vy * ahead;
                    if (Math.hypot(dx, dy) < radius + LIMITS.offset * 2) { used.add(key); }
                    if (Math.hypot(x, y) >= radius) { continue; }
                    used.add(key);
                    let axis = this.axes.get(key);
                    if (!axis || axis.ground !== yielding.ground) {
                        const sign = (winner.id ^ yielding.id) & 1 ? 1 : -1;
                        if (yielding.ground) {
                            axis = { x: Math.abs(dx) > 0.01 ? Math.sign(dx) : sign, y: 0, ground: true };
                        } else if (speedSquared > 1e-8) {
                            const speed = Math.sqrt(speedSquared), nx = -vy / speed, ny = vx / speed;
                            const side = dx * nx + dy * ny;
                            const direction = Math.abs(side) > 0.01 ? Math.sign(side) : sign;
                            axis = { x: nx * direction, y: ny * direction, ground: false };
                        } else {
                            const distance = Math.hypot(dx, dy);
                            const displaced = Math.hypot(b.x, b.y);
                            // A prior constraint already chose this lane. At another
                            // coincident body, take its perpendicular instead of undoing it.
                            const fallback = displaced > 0.01
                                ? { x: -b.y / displaced, y: b.x / displaced } : { x: sign, y: 0 };
                            axis = distance > 0.01 ? { x: dx / distance, y: dy / distance, ground: false }
                                : { ...fallback, ground: false };
                        }
                        this.axes.set(key, axis);
                    }
                    const along = x * axis.x + y * axis.y;
                    const acrossSquared = Math.max(0, x * x + y * y - along * along);
                    const movement = Math.sqrt(Math.max(0, radius * radius - acrossSquared)) - along;
                    if (movement > 0) {
                        const next = bounded({ x: b.x + axis.x * movement, y: yielding.ground ? 0 : b.y + axis.y * movement }, LIMITS.offset);
                        b.x = next.x; b.y = next.y;
                    }
                }
            }
        }
        for (const key of this.axes.keys()) { if (!used.has(key)) { this.axes.delete(key); } }
        const displayed = (group: Group, offset: RobotTrafficOffset): RobotTrafficOffset => group.fixed || !group.offsetScale
            ? zero() : { x: offset.x * group.offsetScale, y: offset.y * group.offsetScale };
        const result = new Map<number, RobotTrafficOffset>();
        const amount = 1 - Math.exp(-step / LIMITS.easingMs);
        for (const group of groups) {
            const sample = this.previous.get(group.id);
            const before = sample?.offset ?? zero(), target = targets.get(group.id)!;
            const base = group.fixed ? zero() : { x: before.x, y: group.ground ? 0 : before.y };
            const delta = bounded({ x: (target.x - base.x) * amount, y: (target.y - base.y) * amount }, LIMITS.offsetSpeed * step);
            const offset = group.fixed ? zero() : bounded({ x: base.x + delta.x, y: group.ground ? 0 : base.y + delta.y }, LIMITS.offset);
            if (!target.x && !target.y && Math.hypot(offset.x, offset.y) < 0.01
                && Math.hypot(offset.x, offset.y) <= LIMITS.offsetSpeed * step) { offset.x = offset.y = 0; }
            this.previous.set(group.id, { x: group.x, y: group.y, at, offset,
                visibility: group.canFade ? sample?.visibility ?? 1 : 1, yielding: group.canFade && (sample?.yielding ?? false) });
            result.set(group.id, displayed(group, offset));
        }
        const clearance = (winner: Group, yielding: Group, a: RobotTrafficOffset, b: RobotTrafficOffset) => {
            const va = velocities.get(winner.id)!, vb = velocities.get(yielding.id)!;
            const dx = yielding.x + b.x - winner.x - a.x, dy = yielding.y + b.y - winner.y - a.y;
            const vx = vb.x - va.x, vy = vb.y - va.y, speedSquared = vx * vx + vy * vy;
            const horizon = Math.min(LIMITS.lookaheadMs, yielding.remainingMs,
                winner.fixed ? LIMITS.lookaheadMs : winner.remainingMs);
            const ahead = speedSquared > 1e-8 ? clamp(-(dx * vx + dy * vy) / speedSquared, 0, horizon) : 0;
            return Math.hypot(dx + vx * ahead, dy + vy * ahead) - winner.radius - yielding.radius - LIMITS.clearance;
        };
        // Visibility never participates in admission, prediction, or obstacle selection.
        for (let j = 0; j < groups.length; j++) {
            const group = groups[j], sample = this.previous.get(group.id)!;
            if (!group.canFade) { continue; }
            let blocked = false, recovered = true;
            if (group.ground || group.fixed) {
                for (let i = 0; i < j; i++) {
                    const winner = groups[i];
                    const targetGap = clearance(winner, group,
                        displayed(winner, targets.get(winner.id)!), displayed(group, targets.get(group.id)!));
                    const actualGap = clearance(winner, group, result.get(winner.id)!, result.get(group.id)!);
                    if (targetGap < -LIMITS.overlapTolerance) { blocked = true; }
                    if (targetGap < LIMITS.recoveryClearance || actualGap < LIMITS.recoveryClearance) { recovered = false; }
                }
            }
            sample.yielding = blocked || sample.yielding && !recovered;
            const visibility = clamp(sample.visibility + (sample.yielding ? -step / LIMITS.fadeOutMs : step / LIMITS.fadeInMs), 0, 1);
            sample.visibility = visibility < 1e-9 ? 0 : visibility > 1 - 1e-9 ? 1 : visibility;
            if (sample.visibility < 1) { result.get(group.id)!.visibility = sample.visibility; }
        }
        return result;
    }

    reset(): void { this.previous.clear(); this.axes.clear(); this.at = undefined; }
}
