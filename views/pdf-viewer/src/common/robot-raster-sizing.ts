/** One budget covers the visible fleet canvas, background and every cached robot body. */
export const ROBOT_RASTER_LIMITS = Object.freeze({
    maxBytes: 64 * 1024 * 1024,
    maxDimension: 8192,
    densitySteps: 5,
    shrinkRatio: 0.75,
});

export interface RobotRasterShape {
    width: number;
    height: number;
    bodyWidth: number;
    bodyHeight: number;
    bodyCount: number;
}

export interface RobotRasterPlan {
    width: number;
    height: number;
    bodyWidth: number;
    bodyHeight: number;
    density: number;
    bodyDensity: number;
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
    const { maxBytes, maxDimension, densitySteps, shrinkRatio } = ROBOT_RASTER_LIMITS;
    const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 1;
    const fit = Math.max(positive(input.width) / shape.width, positive(input.height) / shape.height);
    const requested = fit * positive(input.devicePixelRatio);
    const bodyScale = positive(input.bodyScale);
    const largest = Math.max(shape.width, shape.height);
    const maximumUnits = Math.max(1, Math.floor(maxDimension / largest * densitySteps));
    const desiredUnits = Math.max(1, Math.min(maximumUnits, Math.ceil(requested * densitySteps - 1e-8)));
    const make = (units: number): RobotRasterPlan => {
        const density = units / densitySteps;
        const bodyDensity = Math.max(1, Math.ceil(density * bodyScale * densitySteps - 1e-8) / densitySteps);
        const width = Math.round(shape.width * density), height = Math.round(shape.height * density);
        const bodyWidth = Math.ceil(shape.bodyWidth * bodyDensity), bodyHeight = Math.ceil(shape.bodyHeight * bodyDensity);
        return { width, height, bodyWidth, bodyHeight, density, bodyDensity,
            bytes: (2 * width * height + shape.bodyCount * bodyWidth * bodyHeight) * 4,
            limited: density + 1e-8 < requested };
    };
    let low = 1, high = desiredUnits;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2), candidate = make(middle);
        if (candidate.bytes <= maxBytes && Math.max(candidate.bodyWidth, candidate.bodyHeight) <= maxDimension) { low = middle; }
        else { high = middle - 1; }
    }
    const next = make(low);
    if (previous && previous.density >= next.density && next.density >= previous.density * shrinkRatio
        && previous.bodyDensity >= next.bodyDensity && next.bodyDensity >= previous.bodyDensity * shrinkRatio) {
        return { ...previous, limited: previous.density + 1e-8 < requested };
    }
    return next;
}
