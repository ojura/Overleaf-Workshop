/** Geometry and memory adapted from Chase Scope's src/labels.js. */
export interface PlacementPoint { x: number; y: number }
export interface PlacementRect extends PlacementPoint { width: number; height: number }

/** Center, preferred cost, and the attachment-side base of a candidate, in caller coordinates. */
export interface LabelCandidate extends PlacementPoint {
    base: PlacementPoint;
    cost?: number;
}

export interface LabelPlacementInput {
    id: string;
    anchor: PlacementPoint;
    width: number;
    height: number;
    priority?: number;
    radius?: number;
    clearance?: number;
    /** Defaults to 24 positions around the anchor. */
    candidates?: readonly LabelCandidate[];
    /** Actual speaker positions; the placement anchor may be their midpoint. Defaults to [anchor]. */
    leaderAnchors?: readonly PlacementPoint[];
}

export interface PlacementLeader { from: PlacementPoint; to: PlacementPoint }
export interface LabelPlacement extends PlacementRect {
    id: string;
    opacity: number;
    /** Immediate geometry and budget admission, independent of opacity or the caller clock. */
    blocked: boolean;
    leaders: readonly PlacementLeader[];
}

export interface LabelPlacementFrame {
    /** Caller clock in milliseconds. All geometry uses one caller-owned coordinate space. */
    now: number;
    bounds: PlacementRect;
    labels: readonly LabelPlacementInput[];
    obstacles?: readonly PlacementRect[];
    /** Admit at most this many fitting labels, in priority then stable-ID order. */
    maxVisible?: number;
}

export const LABEL_PLACEMENT_LIMITS = Object.freeze({ labels: 32, obstacles: 64, candidates: 24, leaderAnchors: 3 });

const ringOffsets = [0, 16, 34];
const directions = [90, 45, 135, 0, 180, 315, 225, 270];
const ringCost = 1000;
const directionCost = 30;
const stayDistance = 8;
const movementCost = 4;
const edgeSlack = 2;
const improvementHold = 0.3;
const offsetEase = 0.09;
const fadeIn = 0.15;
const fadeOut = 0.04;
const leaderGap = 16;
const overlapTolerance = 4;

interface Memory {
    base: PlacementPoint;
    center: PlacementPoint;
    offset: PlacementPoint;
    wait: number;
    opacity: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function finite(value: number, name: string) {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Invalid label placement ' + name + '.');
    }
}

function nonnegative(value: number, name: string) {
    finite(value, name);
    if (value < 0) { throw new RangeError('Invalid label placement ' + name + '.'); }
}

function point(value: PlacementPoint, name: string) {
    finite(value.x, name + ' x');
    finite(value.y, name + ' y');
}

function rectangle(value: PlacementRect, name: string) {
    point(value, name);
    finite(value.width, name + ' width');
    finite(value.height, name + ' height');
    if (value.width <= 0 || value.height <= 0) { throw new RangeError('Invalid label placement ' + name + ' size.'); }
}

function overlap(a: PlacementRect, b: PlacementRect): number {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
}

function expanded(rect: PlacementRect, amount: number): PlacementRect {
    return { x: rect.x - amount, y: rect.y - amount, width: rect.width + 2 * amount, height: rect.height + 2 * amount };
}

function atCenter(candidate: PlacementPoint, label: LabelPlacementInput): PlacementRect {
    return { x: candidate.x - label.width / 2, y: candidate.y - label.height / 2, width: label.width, height: label.height };
}

function covered(rect: PlacementRect, bounds: PlacementRect, placed: readonly PlacementRect[]): boolean {
    let area = Math.max(0, rect.width * rect.height - overlap(rect, bounds));
    for (const other of placed) { area += overlap(rect, other); }
    return area > overlapTolerance;
}

/** Liang-Barsky clipping returns only the part of a leader that crosses a rectangle. */
function segmentInside(from: PlacementPoint, to: PlacementPoint, rect: PlacementRect): number {
    const dx = to.x - from.x, dy = to.y - from.y;
    let first = 0, last = 1;
    for (let side = 0; side < 4; side++) {
        const p = side === 0 ? -dx : side === 1 ? dx : side === 2 ? -dy : dy;
        const q = side === 0 ? from.x - rect.x : side === 1 ? rect.x + rect.width - from.x
            : side === 2 ? from.y - rect.y : rect.y + rect.height - from.y;
        if (p === 0) { if (q < 0) { return 0; } continue; }
        const ratio = q / p;
        if (p < 0) {
            if (ratio > last) { return 0; }
            first = Math.max(first, ratio);
        } else {
            if (ratio < first) { return 0; }
            last = Math.min(last, ratio);
        }
    }
    return (last - first) * Math.hypot(dx, dy);
}

export function labelPlacementLeaders(rect: PlacementRect, anchors: readonly PlacementPoint[]): PlacementLeader[] {
    const result: PlacementLeader[] = [];
    for (const anchor of anchors) {
        const to = { x: clamp(anchor.x, rect.x, rect.x + rect.width), y: clamp(anchor.y, rect.y, rect.y + rect.height) };
        if (Math.hypot(anchor.x - to.x, anchor.y - to.y) > leaderGap) {
            result.push({ from: { ...anchor }, to });
        }
    }
    return result;
}

function ringCandidates(label: LabelPlacementInput, bounds: PlacementRect): LabelCandidate[] {
    const result: LabelCandidate[] = [];
    ringOffsets.forEach((ring, ringIndex) => {
        directions.forEach((direction, directionIndex) => {
            const angle = direction * Math.PI / 180, ux = Math.cos(angle), uy = Math.sin(angle);
            const base = (label.radius ?? 0) + 4 + ring;
            const distance = base + 0.5 * (label.width * Math.abs(ux) + label.height * Math.abs(uy));
            // A fitting rectangle must have a candidate inside the available bounds even
            // when the anchor is near an edge or the label occupies the complete width.
            const x = label.anchor.x + ux * distance, y = label.anchor.y + uy * distance;
            result.push({ x: label.width <= bounds.width ? clamp(x, bounds.x + label.width / 2, bounds.x + bounds.width - label.width / 2) : x,
                y: label.height <= bounds.height ? clamp(y, bounds.y + label.height / 2, bounds.y + bounds.height - label.height / 2) : y,
                base: { x: label.anchor.x + ux * base, y: label.anchor.y + uy * base },
                cost: ringIndex * ringCost + directionIndex * directionCost });
        });
    });
    return result;
}

function validate(frame: LabelPlacementFrame) {
    finite(frame.now, 'clock');
    rectangle(frame.bounds, 'bounds');
    if (frame.maxVisible !== undefined && (!Number.isInteger(frame.maxVisible)
        || frame.maxVisible < 0 || frame.maxVisible > LABEL_PLACEMENT_LIMITS.labels)) {
        throw new RangeError('Invalid label placement visibility budget.');
    }
    if (frame.labels.length > LABEL_PLACEMENT_LIMITS.labels || (frame.obstacles?.length ?? 0) > LABEL_PLACEMENT_LIMITS.obstacles) {
        throw new RangeError('Too many label placement labels or obstacles.');
    }
    const ids = new Set<string>();
    for (const label of frame.labels) {
        if (typeof label.id !== 'string' || !label.id || ids.has(label.id)) { throw new TypeError('Label placement IDs must be unique and nonempty.'); }
        ids.add(label.id);
        rectangle({ ...label.anchor, width: label.width, height: label.height }, 'label');
        finite(label.priority ?? 0, 'priority');
        nonnegative(label.radius ?? 0, 'radius');
        nonnegative(label.clearance ?? 0, 'clearance');
        if (label.candidates) {
            if (!label.candidates.length || label.candidates.length > LABEL_PLACEMENT_LIMITS.candidates) {
                throw new RangeError('Invalid label placement candidate count.');
            }
            for (const candidate of label.candidates) {
                point(candidate, 'candidate');
                point(candidate.base, 'candidate base');
                finite(candidate.cost ?? 0, 'candidate cost');
            }
        }
        if ((label.leaderAnchors?.length ?? 0) > LABEL_PLACEMENT_LIMITS.leaderAnchors) { throw new RangeError('Too many label placement leaders.'); }
        for (const anchor of label.leaderAnchors ?? []) { point(anchor, 'leader anchor'); }
    }
    for (const obstacle of frame.obstacles ?? []) { rectangle(obstacle, 'obstacle'); }
}

/**
 * Synchronous placement for cached, measured rectangles. layout() returns top-left positions in
 * input order. The caller owns rendering and time; this class does not schedule work or measure DOM.
 * Keep one instance while labels live. Omitted IDs are forgotten; reset() also clears the clock.
 */
export class LabelPlacementSolver {
    private readonly memory = new Map<string, Memory>();
    private previousNow: number | undefined;

    reset(): void {
        this.memory.clear();
        this.previousNow = undefined;
    }

    layout(frame: LabelPlacementFrame): readonly LabelPlacement[] {
        validate(frame);
        const dt = this.previousNow === undefined ? 0 : clamp((frame.now - this.previousNow) / 1000, 0, 0.1);
        this.previousNow = frame.now;
        const decay = Math.exp(-dt / offsetEase);
        const edge = expanded(frame.bounds, edgeSlack);
        const placed: PlacementRect[] = [];
        const result = new Map<string, LabelPlacement>();
        const order = [...frame.labels].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
            || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const label of order) {
            const remembered = this.memory.get(label.id);
            if (placed.length >= (frame.maxVisible ?? LABEL_PLACEMENT_LIMITS.labels)) {
                if (remembered) { remembered.opacity = 0; remembered.wait = 0; }
                const center = remembered ? { x: label.anchor.x + remembered.center.x + remembered.offset.x,
                    y: label.anchor.y + remembered.center.y + remembered.offset.y } : label.anchor;
                result.set(label.id, { id: label.id, ...atCenter(center, label), opacity: 0, blocked: true, leaders: [] });
                continue;
            }
            const candidates = label.candidates ?? ringCandidates(label, frame.bounds);
            const anchors = label.leaderAnchors ?? [label.anchor];
            const home = remembered ? { x: label.anchor.x + remembered.base.x, y: label.anchor.y + remembered.base.y } : undefined;
            const away = candidates.map(candidate => home ? Math.hypot(candidate.base.x - home.x, candidate.base.y - home.y) : 0);
            let stay = -1, nearest = stayDistance;
            if (remembered) {
                away.forEach((distance, index) => { if (distance < nearest || stay < 0 && distance <= nearest) { stay = index; nearest = distance; } });
            }
            const scores = candidates.map((candidate, index) => {
                const rect = atCenter(candidate, label), area = rect.width * rect.height;
                const outside = Math.max(0, area - overlap(rect, frame.bounds));
                let score = outside * (index === stay && area - overlap(rect, edge) <= 0 ? 40 : 400);
                for (const other of placed) { score += overlap(rect, other) * 400; }
                if (label.clearance) {
                    const room = expanded(rect, label.clearance);
                    for (const other of placed) { score += overlap(room, other) * 60; }
                }
                for (const obstacle of frame.obstacles ?? []) { score += overlap(rect, obstacle) * 4; }
                for (const leader of labelPlacementLeaders(rect, anchors)) {
                    for (const other of placed) { score += segmentInside(leader.from, leader.to, other) * 60; }
                }
                return score + (candidate.cost ?? 0) + movementCost * away[index];
            });
            const margin = 250 + 0.1 * label.width * label.height;
            let best = 0, bestScore = Infinity;
            scores.forEach((score, index) => {
                const adjusted = score + (remembered && index !== stay ? margin : 0);
                if (adjusted < bestScore) { best = index; bestScore = adjusted; }
            });
            if (remembered) {
                if (stay >= 0 && best !== stay) {
                    remembered.wait += dt;
                    if (covered(atCenter(candidates[best], label), frame.bounds, placed)
                        || !covered(atCenter(candidates[stay], label), edge, placed) && remembered.wait < improvementHold) {
                        best = stay;
                    } else { remembered.wait = 0; }
                } else { remembered.wait = 0; }
            }
            const candidate = candidates[best];
            const target = { x: candidate.x - label.anchor.x, y: candidate.y - label.anchor.y };
            const state = remembered ?? { base: { x: 0, y: 0 }, center: target, offset: { x: 0, y: 0 }, wait: 0, opacity: 0 };
            if (remembered && best !== stay) {
                state.offset.x += state.center.x - target.x;
                state.offset.y += state.center.y - target.y;
            }
            state.offset.x *= decay;
            state.offset.y *= decay;
            state.center = target;
            state.base = { x: candidate.base.x - label.anchor.x, y: candidate.base.y - label.anchor.y };
            const drawn = atCenter({ x: candidate.x + state.offset.x, y: candidate.y + state.offset.y }, label);
            const blocked = covered(drawn, edge, placed);
            state.opacity = blocked ? Math.max(0, state.opacity - dt / fadeOut) : Math.min(1, state.opacity + dt / fadeIn);
            this.memory.set(label.id, state);
            result.set(label.id, { id: label.id, ...drawn, opacity: state.opacity, blocked, leaders: labelPlacementLeaders(drawn, anchors) });
            if (!blocked) { placed.push(drawn); }
        }
        for (const id of this.memory.keys()) { if (!result.has(id)) { this.memory.delete(id); } }
        return frame.labels.map(label => result.get(label.id)!);
    }
}
