/** Screen presentation only. Callers retain device classification and allocation budgets. */
export interface RobotScreenInput {
    width: number;
    height: number;
    devicePixelRatio?: number;
}

export interface RobotScreenMetrics {
    devicePixelRatio: number;
    /** Multiply an existing CSS sprite scale by this factor exactly once. */
    cssScale: number;
    /** Available space in partially compensated units, for desktop presentation choices. */
    availableWidth: number;
    availableHeight: number;
}

export interface RobotCaptionInput {
    /** Accepted with screen inputs; caption CSS sizes stay constant across density. */
    devicePixelRatio?: number;
    /** CSS pixels per drawing unit, including canvas fitting and local artwork transforms. */
    displayScale?: number;
}

export interface RobotCaptionMetrics {
    /** Effective CSS pixels per drawing unit; unusable input falls back to one. */
    displayScale: number;
    /** CSS pixel sizes. DOM captions use these without a sprite or canvas scale. */
    fontSize: number;
    lineHeight: number;
    paddingX: number;
    paddingY: number;
    /** Drawing-unit sizes. The supplied displayScale brings these back to the CSS sizes. */
    localFontSize: number;
    localLineHeight: number;
    localPaddingX: number;
    localPaddingY: number;
}

export const ROBOT_CAPTION_STYLE = Object.freeze({
    background: '#f5f7fa',
    color: '#17212b',
    borderColor: '#405466',
    fontWeight: 600,
});

/** The Motion Lab is an explicitly dark surface, independent of PDF page recoloring. */
export const ROBOT_LAB_CAPTION_STYLE = Object.freeze({
    background: '#101c2b',
    color: '#e8f0fa',
    borderColor: '#43566b',
    fontWeight: 600,
});

function normalizedDpr(value = 1): number {
    return Number.isFinite(value) && value > 0 ? Math.max(0.5, Math.min(4, value)) : 1;
}

/**
 * Within DPR 0.5–4, physical sprite size grows as sqrt(DPR) instead of DPR.
 * This is independent of canvas backing resolution and never changes a memory limit.
 */
export function robotScreenMetrics(input: RobotScreenInput): RobotScreenMetrics {
    const devicePixelRatio = normalizedDpr(input.devicePixelRatio);
    const cssScale = 1 / Math.sqrt(devicePixelRatio);
    const available = (edge: number) => Number.isFinite(edge) && edge > 0
        ? Math.min(Number.MAX_SAFE_INTEGER, edge / cssScale) : 0;
    return { devicePixelRatio, cssScale, availableWidth: available(input.width), availableHeight: available(input.height) };
}

/**
 * Compact captions keep a 12 CSS px size independently of sprite compensation.
 * Pass the complete CSS-pixels-per-drawing-unit transform for canvas text. Do not include
 * the canvas backing DPR: it changes raster density, not the displayed text dimensions.
 */
export function robotCaptionMetrics(input: RobotCaptionInput = {}): RobotCaptionMetrics {
    const fontSize = 12, lineHeight = 16, paddingX = 6, paddingY = 3;
    const requested = input.displayScale ?? 1;
    const displayScale = Number.isFinite(requested) && requested > 0 && Number.isFinite(lineHeight / requested) ? requested : 1;
    return {
        displayScale, fontSize, lineHeight, paddingX, paddingY,
        localFontSize: fontSize / displayScale, localLineHeight: lineHeight / displayScale,
        localPaddingX: paddingX / displayScale, localPaddingY: paddingY / displayScale,
    };
}
