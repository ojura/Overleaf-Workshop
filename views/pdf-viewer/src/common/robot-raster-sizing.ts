/** One budget covers the visible fleet canvas, background and every cached robot body. */
export const ROBOT_RASTER_LIMITS = Object.freeze({
    maxBytes: 64 * 1024 * 1024,
    maxDimension: 8192,
    densitySteps: 5,
    /** Preserve local face/outline detail, capped by each body's natural full-resolution backing. */
    minSpriteDetail: 1,
    shrinkRatio: 0.75,
});

export interface RobotSpriteRaster {
    width: number;
    height: number;
    bytes: number;
    detail: number;
    density: number;
}
export interface RobotSpriteRasterPlan {
    density: number;
    sprites: readonly RobotSpriteRaster[];
    bytes: number;
    limited: boolean;
}

/** Fund the whole requested crew before allocating any member; logical dimensions stay fixed. */
export function robotSpriteRasterPlan(shapes: readonly Readonly<{ width: number; height: number; scale: number }>[],
    requestedDensity: number, availableBytes: number): RobotSpriteRasterPlan | undefined {
    const { densitySteps, minSpriteDetail, maxDimension } = ROBOT_RASTER_LIMITS;
    if (!Number.isFinite(requestedDensity) || requestedDensity <= 0
        || !Number.isFinite(availableBytes) || availableBytes <= 0
        || shapes.some(shape => ![shape.width, shape.height, shape.scale].every(value => Number.isFinite(value) && value > 0)
            || !Number.isFinite(Math.max(shape.width, shape.height) * shape.scale * requestedDensity))) { return; }
    const make = (density: number): RobotSpriteRasterPlan => {
        const sprites = shapes.map(shape => {
            const requested = shape.scale * requestedDensity;
            const detail = Math.min(requested, Math.max(Math.min(requested, minSpriteDetail), shape.scale * density));
            const width = Math.ceil(shape.width * detail), height = Math.ceil(shape.height * detail);
            return { width, height, bytes: width * height * 4, detail, density: detail / shape.scale };
        });
        return { density, sprites, bytes: sprites.reduce((sum, sprite) => sum + sprite.bytes, 0), limited: density < requestedDensity };
    };
    const fits = (plan: RobotSpriteRasterPlan) => Number.isSafeInteger(plan.bytes) && plan.bytes <= availableBytes
        && plan.sprites.every(sprite => sprite.width <= maxDimension && sprite.height <= maxDimension);
    const wanted = make(requestedDensity);
    if (fits(wanted)) { return wanted; }
    let low = 0, high = Math.floor(requestedDensity * densitySteps);
    const minimum = make(0);
    if (!fits(minimum)) { return; }
    // The largest dimension bounds the search even for an extreme requested DPR.
    const largest = Math.max(1, ...shapes.map(shape => Math.max(shape.width, shape.height) * shape.scale));
    high = Math.min(high, Math.floor(maxDimension / largest * densitySteps));
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(make(middle / densitySteps))) { low = middle; } else { high = middle - 1; }
    }
    return make(low / densitySteps);
}

export interface RobotRasterShape {
    width: number;
    height: number;
    bodyWidth: number;
    bodyHeight: number;
    bodyCount: number;
    /** Presentation factors in cache order; missing entries retain the uniform size. */
    bodyScales?: readonly number[];
}

export interface RobotBodyRaster {
    width: number;
    height: number;
    density: number;
}

export interface RobotRasterPlan {
    width: number;
    height: number;
    bodyWidth: number;
    bodyHeight: number;
    density: number;
    bodyDensity: number;
    bodyRasters: readonly RobotBodyRaster[];
    bytes: number;
    limited: boolean;
}

/**
 * CSS fitting, backing density and sprite presentation are separate transforms. Quantizing
 * the 480 × 250 scene in fifths preserves its intrinsic aspect ratio exactly. A small shrink
 * keeps the previous sufficient backing so a hand wavering around a size boundary is cheap.
 */
export function robotRasterPlan(shape: RobotRasterShape, input: {
    width: number; height: number; devicePixelRatio: number; bodyScale: number;
}, previous?: RobotRasterPlan): RobotRasterPlan {
    const { maxBytes, maxDimension, densitySteps, minSpriteDetail, shrinkRatio } = ROBOT_RASTER_LIMITS;
    const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 1;
    const fit = Math.max(positive(input.width) / shape.width, positive(input.height) / shape.height);
    const requested = fit * positive(input.devicePixelRatio);
    const bodyScale = positive(input.bodyScale);
    const bodyScales = Array.from({ length: shape.bodyCount }, (_, index) => positive(shape.bodyScales?.[index] ?? 1));
    const largest = Math.max(shape.width, shape.height);
    const maximumUnits = Math.max(1, Math.floor(maxDimension / largest * densitySteps));
    const desiredUnits = Math.max(1, Math.min(maximumUnits, Math.ceil(requested * densitySteps - 1e-8)));
    const make = (units: number): RobotRasterPlan => {
        const density = units / densitySteps;
        const bodyRaster = (scale: number): RobotBodyRaster => {
            const detail = Math.max(minSpriteDetail, Math.ceil(density * bodyScale * scale * densitySteps - 1e-8) / densitySteps);
            return { width: Math.ceil(shape.bodyWidth * detail), height: Math.ceil(shape.bodyHeight * detail), density: detail };
        };
        const uniform = bodyRaster(1), bodyRasters = bodyScales.map(bodyRaster);
        const width = Math.round(shape.width * density), height = Math.round(shape.height * density);
        return { width, height, bodyWidth: uniform.width, bodyHeight: uniform.height, density, bodyDensity: uniform.density, bodyRasters,
            bytes: (2 * width * height + bodyRasters.reduce((sum, body) => sum + body.width * body.height, 0)) * 4,
            limited: density + 1e-8 < requested };
    };
    const fits = (plan: RobotRasterPlan) => Number.isSafeInteger(plan.bytes) && plan.bytes <= maxBytes
        && plan.width <= maxDimension && plan.height <= maxDimension
        && plan.bodyRasters.every(body => body.width <= maxDimension && body.height <= maxDimension);
    let low = 1, high = desiredUnits;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2), candidate = make(middle);
        if (fits(candidate)) { low = middle; }
        else { high = middle - 1; }
    }
    const next = make(low);
    if (previous && previous.bodyRasters?.length === next.bodyRasters.length && fits(previous)
        && previous.width >= next.width && previous.height >= next.height
        && previous.density >= next.density && next.density >= previous.density * shrinkRatio
        && previous.bodyWidth >= next.bodyWidth && previous.bodyHeight >= next.bodyHeight
        && previous.bodyDensity >= next.bodyDensity && next.bodyDensity >= previous.bodyDensity * shrinkRatio
        && next.bodyRasters.every((body, index) => {
            const retained = previous.bodyRasters[index];
            return retained.width >= body.width && retained.height >= body.height
                && retained.density >= body.density && body.density >= retained.density * shrinkRatio;
        })) {
        return { ...previous, limited: previous.density + 1e-8 < requested };
    }
    return next;
}
