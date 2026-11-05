const phases = Object.freeze({ approachMs: 500, haulMs: 1800, settleMs: 200, dockMs: 1200, inputSettleMs: 300 });

/** A finite scene: engage the stationary page edge, haul, release, then dock the Lab. */
export const MOTION_LAB_CHOREOGRAPHY = Object.freeze({
    ...phases,
    columnDurationMs: phases.approachMs + phases.haulMs + phases.settleMs,
});

/** Zero velocity and acceleration at either end keep the cargo and its carrier together. */
export function motionLabEase(progress: number): number {
    const t = Math.max(0, Math.min(1, progress));
    return t * t * t * (10 + t * (-15 + t * 6));
}

export function motionLabColumnElapsed(elapsedMs: number, durationMs = MOTION_LAB_CHOREOGRAPHY.columnDurationMs): number {
    return elapsedMs * MOTION_LAB_CHOREOGRAPHY.columnDurationMs / durationMs;
}

export function motionLabColumnProgress(elapsedMs: number, durationMs = MOTION_LAB_CHOREOGRAPHY.columnDurationMs): number {
    return motionLabEase((motionLabColumnElapsed(elapsedMs, durationMs) - MOTION_LAB_CHOREOGRAPHY.approachMs)
        / MOTION_LAB_CHOREOGRAPHY.haulMs);
}
