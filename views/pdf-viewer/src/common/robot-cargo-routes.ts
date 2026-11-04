export interface CargoRoutePoint { x: number; y: number }

/** Maximum vertical travel per horizontal pixel while a ground vehicle drives itself. */
export const GROUND_ROUTE_MAX_SLOPE = 0.25;

/** Fractions of the caller's existing transport leg, without an additional clock. */
export const CARGO_ROUTE_POLICY = Object.freeze({
    driveEnd: 0.12,
    recruitEnd: 0.24,
    rendezvousEnd: 0.36,
    liftEnd: 0.48,
    carryEnd: 0.70,
    setDownEnd: 0.84,
    defaultGroundRun: 48,
    minimumLiftClearance: 12,
});

export type CargoRoutePhase = 'drive' | 'recruit' | 'rendezvous' | 'lift' | 'carry' | 'set-down' | 'final-drive' | 'arrived';
export interface CargoRouteOptions {
    progress: number;
    /** Ground body centers in CSS pixels, with positive Y pointing down. */
    from: CargoRoutePoint;
    to: CargoRoutePoint;
    airFrom: CargoRoutePoint;
    /** Actual artwork attachment offsets, after the caller applies sprite scale. */
    cargoOffset: CargoRoutePoint;
    airOffset: CargoRoutePoint;
    /** Pickup and set-down body centers stay within these horizontal bounds. */
    bounds?: { left: number; right: number };
    groundRun?: number;
    maxSlope?: number;
}
export interface CargoRouteState {
    phase: CargoRoutePhase;
    ground: CargoRoutePoint;
    air: CargoRoutePoint;
    cargo: CargoRoutePoint;
    groundCarried: boolean;
    requiresAir: boolean;
}

function finite(value: number, name: string) {
    if (!Number.isFinite(value)) { throw new RangeError('Cargo route ' + name + ' must be finite.'); }
}
function point(value: CargoRoutePoint, name: string) {
    if (!value) { throw new RangeError('Cargo route ' + name + ' must be a point.'); }
    finite(value.x, name + '.x'); finite(value.y, name + '.y');
}
function nonnegative(value: number, name: string) {
    finite(value, name);
    if (value < 0) { throw new RangeError('Cargo route ' + name + ' must not be negative.'); }
}
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const add = (a: CargoRoutePoint, b: CargoRoutePoint): CargoRoutePoint => ({ x: a.x + b.x, y: a.y + b.y });
const copy = (value: CargoRoutePoint): CargoRoutePoint => ({ x: value.x, y: value.y });
function interpolate(from: CargoRoutePoint, to: CargoRoutePoint, amount: number): CargoRoutePoint {
    const t = amount * amount * (3 - 2 * amount);
    return { x: from.x * (1 - t) + to.x * t, y: from.y * (1 - t) + to.y * t };
}

export function needsCargoAirlift(from: CargoRoutePoint, to: CargoRoutePoint, maxSlope = GROUND_ROUTE_MAX_SLOPE): boolean {
    point(from, 'from'); point(to, 'to'); nonnegative(maxSlope, 'maxSlope');
    const width = Math.abs(to.x - from.x), height = Math.abs(to.y - from.y);
    finite(width, 'horizontal distance'); finite(height, 'vertical distance');
    return height > width * maxSlope;
}

/**
 * Ground approaches and departures remain shallow. A steep leg starts with a stop and
 * rendezvous, then the aircraft carries the ground body through lift, crossing and landing.
 * The photo always has one owner: its position is the ground body plus cargoOffset.
 */
export function computeCargoRoute(options: CargoRouteOptions): CargoRouteState {
    const { from, to, airFrom, cargoOffset, airOffset, bounds } = options;
    finite(options.progress, 'progress');
    point(airFrom, 'airFrom'); point(cargoOffset, 'cargoOffset'); point(airOffset, 'airOffset');
    const desiredRun = options.groundRun ?? CARGO_ROUTE_POLICY.defaultGroundRun;
    nonnegative(desiredRun, 'groundRun');
    if (bounds !== undefined) {
        if (!bounds) { throw new RangeError('Cargo route bounds must contain left and right.'); }
        finite(bounds.left, 'bounds.left'); finite(bounds.right, 'bounds.right');
        finite(bounds.right - bounds.left, 'bounds width');
        if (bounds.left > bounds.right) { throw new RangeError('Cargo route bounds are reversed.'); }
    }
    const requiresAir = needsCargoAirlift(from, to, options.maxSlope);
    const progress = clamp(options.progress, 0, 1);
    function state(phase: CargoRoutePhase, ground: CargoRoutePoint, air: CargoRoutePoint, groundCarried = false): CargoRouteState {
        const cargo = add(ground, cargoOffset);
        point(ground, 'ground position'); point(air, 'air position'); point(cargo, 'cargo position');
        return { phase, ground, air, cargo, groundCarried, requiresAir };
    }
    if (!requiresAir) {
        return state(progress === 1 ? 'arrived' : 'drive', interpolate(from, to, progress), copy(airFrom));
    }

    const horizontal = to.x - from.x;
    const boundedX = (x: number) => bounds ? clamp(x, bounds.left, bounds.right) : x;
    let direction = Math.sign(horizontal);
    if (!direction) {
        direction = Math.sign(airFrom.x - from.x) || (bounds && from.x > bounds.left + (bounds.right - bounds.left) / 2 ? -1 : 1);
    }
    const run = horizontal ? Math.min(desiredRun, Math.abs(horizontal) / 3) : desiredRun;
    const pickup = { x: boundedX(from.x + direction * run), y: from.y };
    // A vertical journey uses one short side lane for both approach and final drive.
    const landing = { x: horizontal ? boundedX(to.x - direction * run) : pickup.x, y: to.y };
    const clearance = Math.max(CARGO_ROUTE_POLICY.minimumLiftClearance, run / 2, Math.abs(airOffset.y) / 2);
    const cruiseY = Math.min(pickup.y, landing.y) - clearance;
    const lifted = { x: pickup.x, y: cruiseY }, crossed = { x: landing.x, y: cruiseY };
    const attachedAtPickup = add(pickup, airOffset), releasedAtLanding = add(landing, airOffset);
    const phase = CARGO_ROUTE_POLICY;
    const during = (start: number, end: number) => clamp((progress - start) / (end - start), 0, 1);

    if (progress < phase.driveEnd) {
        return state('drive', interpolate(from, pickup, during(0, phase.driveEnd)), copy(airFrom));
    }
    if (progress < phase.recruitEnd) { return state('recruit', copy(pickup), copy(airFrom)); }
    if (progress < phase.rendezvousEnd) {
        return state('rendezvous', copy(pickup), interpolate(airFrom, attachedAtPickup, during(phase.recruitEnd, phase.rendezvousEnd)));
    }
    if (progress < phase.liftEnd) {
        const ground = interpolate(pickup, lifted, during(phase.rendezvousEnd, phase.liftEnd));
        return state('lift', ground, add(ground, airOffset), true);
    }
    if (progress < phase.carryEnd) {
        const ground = interpolate(lifted, crossed, during(phase.liftEnd, phase.carryEnd));
        return state('carry', ground, add(ground, airOffset), true);
    }
    if (progress < phase.setDownEnd) {
        const ground = interpolate(crossed, landing, during(phase.carryEnd, phase.setDownEnd));
        return state('set-down', ground, add(ground, airOffset), true);
    }
    return state(progress === 1 ? 'arrived' : 'final-drive',
        interpolate(landing, to, during(phase.setDownEnd, 1)), releasedAtLanding);
}
