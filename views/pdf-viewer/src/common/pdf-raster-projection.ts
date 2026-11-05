/** A rectangle in the coordinate system documented by its containing field. */
export interface PdfProjectionRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** Canvas affine order: x' = ax + cy + e, y' = bx + dy + f. */
export type PdfProjectionTransform = readonly [number, number, number, number, number, number];

export interface PdfRasterProjection {
    /** Actual backing dimensions, in integer pixels. Resampling changes these independently. */
    readonly width: number;
    readonly height: number;
    /** Current normalized logical page -> backing pixels, including retained raster rotation. */
    readonly pageToRaster: PdfProjectionTransform;
}

export interface PdfPageProjection {
    /** The entire logical page, in page-local CSS pixels, before the native backing clips it. */
    readonly content: PdfProjectionRect;
    /** Visible inner page rectangle in the same CSS coordinates; excludes page borders. */
    readonly clip: PdfProjectionRect;
}

export interface PdfRasterCrop {
    /** Requested logical photo intersected with the page and available source pixels. */
    readonly logical: PdfProjectionRect;
    /** Exact fractional source rectangle, in backing pixels. */
    readonly source: PdfProjectionRect;
    /** Integer read rectangle: floor both starts, ceil both ends, clipped to the backing. */
    readonly pixels: PdfProjectionRect;
    /** Logical footprint of pixels, including the outward sample's fractional edge coverage. */
    readonly sampled: PdfProjectionRect;
}

const UNIT_PAGE: PdfProjectionRect = { x: 0, y: 0, width: 1, height: 1 };
const validRect = (rect: PdfProjectionRect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0;

function positive(value: number): void {
    if (!Number.isFinite(value) || value <= 0) { throw new RangeError('Invalid PDF projection extent'); }
}

function raster(width: number, height: number, pageToRaster: PdfProjectionTransform): PdfRasterProjection {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        throw new RangeError('Invalid PDF raster dimensions');
    }
    return Object.freeze({ width, height, pageToRaster: Object.freeze(pageToRaster) });
}

/** A after B. All public producers retain axis-aligned geometry, with optional quarter-turns. */
function compose(a: PdfProjectionTransform, b: PdfProjectionTransform): PdfProjectionTransform {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function inverse(m: PdfProjectionTransform): PdfProjectionTransform {
    const determinant = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(determinant) || determinant === 0) { throw new RangeError('Invalid PDF raster transform'); }
    return [m[3] / determinant, -m[1] / determinant, -m[2] / determinant, m[0] / determinant,
        (m[2] * m[5] - m[3] * m[4]) / determinant, (m[1] * m[4] - m[0] * m[5]) / determinant];
}

function bounds(m: PdfProjectionTransform, rect: PdfProjectionRect): PdfProjectionRect {
    const xs = [rect.x, rect.x + rect.width], ys = [rect.y, rect.y + rect.height];
    const points = xs.flatMap(x => ys.map(y => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]));
    const left = Math.min(...points.map(point => point[0])), top = Math.min(...points.map(point => point[1]));
    return { x: left, y: top, width: Math.max(...points.map(point => point[0])) - left,
        height: Math.max(...points.map(point => point[1])) - top };
}

function intersection(a: PdfProjectionRect, b: PdfProjectionRect): PdfProjectionRect | undefined {
    if (!validRect(a) || !validRect(b)) { return undefined; }
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function turn(degrees: number): number {
    if (!Number.isFinite(degrees) || degrees % 90 !== 0) { throw new RangeError('PDF raster rotation must be a quarter-turn'); }
    return ((degrees % 360) + 360) % 360;
}

function rotation(degrees: number, width: number, height: number): PdfProjectionTransform {
    switch (turn(degrees)) {
        case 90: return [0, 1, -1, 0, height, 0];
        case 180: return [-1, 0, 0, -1, width, height];
        case 270: return [0, -1, 1, 0, 0, width];
        default: return [1, 0, 0, 1, 0, 0];
    }
}

/**
 * A full atlas uses the default content extent. A directly rendered preview supplies its
 * unrounded viewport extent, inside its ceil-sized backing. A native PDF.js 5.1.91 capture
 * supplies original viewport * actual outputScale: draw() rounds the backing, then renders
 * with that unchanged viewport, so content can extend beyond the available right/bottom edge.
 * Capture native values at the main pagerender event; CSS-only updates overwrite public
 * viewport/outputScale while retaining the old canvas. DPR is not the actual outputScale.
 */
export function createPdfRasterProjection(width: number, height: number,
    contentWidth = width, contentHeight = height): PdfRasterProjection {
    positive(contentWidth); positive(contentHeight);
    return raster(width, height, [contentWidth, 0, 0, contentHeight, 0, 0]);
}

/** Resample the whole backing, preserving clipped coverage and padding on both axes. */
export function resizePdfRasterProjection(projection: PdfRasterProjection, width: number, height: number): PdfRasterProjection {
    return raster(width, height, compose([width / projection.width, 0, 0, height / projection.height, 0, 0], projection.pageToRaster));
}

/** Physically rotate pixels clockwise; the current logical page basis does not change. */
export function rotatePdfRasterProjection(projection: PdfRasterProjection, degrees: number): PdfRasterProjection {
    const angle = turn(degrees), swap = angle === 90 || angle === 270;
    return raster(swap ? projection.height : projection.width, swap ? projection.width : projection.height,
        compose(rotation(angle, projection.width, projection.height), projection.pageToRaster));
}

/** Rotate the logical page clockwise while retaining the backing pixels in their old orientation. */
export function reorientPdfRasterProjection(projection: PdfRasterProjection, degrees: number): PdfRasterProjection {
    return raster(projection.width, projection.height, compose(projection.pageToRaster, rotation(-degrees, 1, 1)));
}

// Products and inverse transforms can put an integral boundary a few machine ulps away
// from that integer. Remove only that arithmetic noise, never a visible pixel allowance.
function integralEdge(value: number): number {
    const nearest = Math.round(value);
    return Math.abs(value - nearest) <= 8 * Number.EPSILON * Math.max(1, Math.abs(value)) ? nearest : value;
}

export function projectPdfRasterCrop(projection: PdfRasterProjection, logicalRect: PdfProjectionRect): PdfRasterCrop | undefined {
    const requested = intersection(logicalRect, UNIT_PAGE);
    if (!requested) { return undefined; }
    const source = intersection(bounds(projection.pageToRaster, requested), { x: 0, y: 0, width: projection.width, height: projection.height });
    if (!source) { return undefined; }
    const x = Math.max(0, Math.floor(integralEdge(source.x))), y = Math.max(0, Math.floor(integralEdge(source.y)));
    const right = Math.min(projection.width, Math.ceil(integralEdge(source.x + source.width)));
    const bottom = Math.min(projection.height, Math.ceil(integralEdge(source.y + source.height)));
    const pixels = { x, y, width: right - x, height: bottom - y };
    if (!validRect(pixels)) { return undefined; }
    const toPage = inverse(projection.pageToRaster);
    const logical = intersection(requested, bounds(toPage, source));
    return logical ? { logical, source, pixels, sampled: bounds(toPage, pixels) } : undefined;
}

/** Unrounded source-pixel lengths along the logical target axes, even for a retained rotated raster. */
export function pdfRasterCropSize(projection: PdfRasterProjection, logicalTarget: PdfProjectionRect): { width: number; height: number } {
    const m = projection.pageToRaster;
    return { width: Math.hypot(m[0], m[1]) * logicalTarget.width, height: Math.hypot(m[2], m[3]) * logicalTarget.height };
}

/**
 * Draw backing pixels into a bounded cargo canvas while preserving the exact logical target.
 * Set this transform, then draw crop.pixels at the same source/destination backing coordinates;
 * the output canvas clips the outward read. Never stretch crop.pixels to the target rectangle.
 */
export function pdfRasterToCrop(projection: PdfRasterProjection, logicalTarget: PdfProjectionRect,
    outputWidth: number, outputHeight: number): PdfProjectionTransform {
    if (!validRect(logicalTarget)) { throw new RangeError('Invalid PDF crop target'); }
    positive(outputWidth); positive(outputHeight);
    const sx = outputWidth / logicalTarget.width, sy = outputHeight / logicalTarget.height;
    return compose([sx, 0, 0, sy, -logicalTarget.x * sx, -logicalTarget.y * sy], inverse(projection.pageToRaster));
}

/** Exact target in CSS pixels. Clipping and outward sampling are deliberately separate. */
export function projectPdfPageRect(page: PdfPageProjection, logicalRect: PdfProjectionRect): PdfProjectionRect {
    return { x: page.content.x + logicalRect.x * page.content.width, y: page.content.y + logicalRect.y * page.content.height,
        width: logicalRect.width * page.content.width, height: logicalRect.height * page.content.height };
}

export function clipPdfPageRect(page: PdfPageProjection, cssRect: PdfProjectionRect): PdfProjectionRect | undefined {
    return intersection(page.clip, cssRect);
}

/** Backing pixel coordinates -> page-local CSS pixels, including retained raster rotation. */
export function pdfRasterToCss(projection: PdfRasterProjection, page: PdfPageProjection): PdfProjectionTransform {
    return compose([page.content.width, 0, 0, page.content.height, page.content.x, page.content.y], inverse(projection.pageToRaster));
}

/** Fractional backing rectangle to retain when a direct-child preview needs its own CSS clip. */
export function pdfRasterPageClip(projection: PdfRasterProjection, page: PdfPageProjection): PdfProjectionRect | undefined {
    if (!validRect(page.clip) || !validRect(page.content)) { return undefined; }
    return intersection(bounds(inverse(pdfRasterToCss(projection, page)), page.clip),
        { x: 0, y: 0, width: projection.width, height: projection.height });
}

/**
 * Reconstruct logical CSS content from an already displayed native backing. displayedRasterRect
 * is its post-rotation bounding box, in the same page-local CSS coordinates as the inner clip.
 * This also handles CSS-only zoom: the old captured coverage is stretched into the new box,
 * even though PDF.js has already replaced the public viewport and outputScale values.
 */
export function pdfPageFromRaster(projection: PdfRasterProjection, displayedRasterRect: PdfProjectionRect,
    clip: PdfProjectionRect): PdfPageProjection {
    if (!validRect(displayedRasterRect) || !validRect(clip)) { throw new RangeError('Invalid displayed PDF raster rectangle'); }
    const coverage = bounds(inverse(projection.pageToRaster), { x: 0, y: 0, width: projection.width, height: projection.height });
    const width = displayedRasterRect.width / coverage.width, height = displayedRasterRect.height / coverage.height;
    return { content: { x: displayedRasterRect.x - coverage.x * width, y: displayedRasterRect.y - coverage.y * height, width, height }, clip };
}
