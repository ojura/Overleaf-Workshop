/** Shared budgets for preparation, full-resolution canvases, and lightweight previews. */
export const PREFETCH_LIMITS = Object.freeze({
    gestureGapMs: 250,
    maxPreparedPages: 16,
    maxConcurrentPrepares: 3,
    // Rendering cancellation does not cancel PDF.js's shared image/range fetches. Stop
    // admitting cold pages while those transfers accumulate or become slow.
    maxPendingFetches: 12,
    slowPendingFetches: 6,
    fetchBackpressureMs: 1500,
    // Visible pages count toward this budget. Keep it below PDFViewer's default ten-view buffer.
    maxRenderedPages: 8,
    maxCanvasBytes: 192 * 1024 * 1024,
    previewMaxDimension: 768,
    maxPreviewBytes: 64 * 1024 * 1024,
    maxPreviewPages: 128,
});

export type ScrollDirection = -1 | 0 | 1;

export interface ScrollPrefetchSnapshot {
    /** Conservative speed magnitude; direction carries its sign. */
    velocityPxPerMs: number;
    /** Smoothed derivative of signed input speed, for diagnostics. */
    accelerationPxPerMs2: number;
    pageLatencyMs: number;
    preloadPx: number;
    direction: ScrollDirection;
}

const INITIAL_PAGE_LATENCY_MS = 32;

/**
 * CoS TimelineScrollDynamics' fast-reacting, slowly decaying preload policy.
 * Owns no reads, timers, or DOM. Callers supply user movement separately from
 * layout compensation, and keep page preparation behind visible rendering.
 */
export class ScrollPrefetchDynamics {
    private lastInputAt = -Infinity;
    private lastDelta = 0;
    private velocity = 0;
    private signedSampleVelocity = 0;
    private acceleration = 0;
    private latency = INITIAL_PAGE_LATENCY_MS;

    get direction(): ScrollDirection {
        return Math.sign(this.lastDelta) as ScrollDirection;
    }

    input(delta: number, now: number): void {
        if (!Number.isFinite(delta) || !delta || !Number.isFinite(now)) { return; }
        const elapsed = now - this.lastInputAt;
        const continuing = elapsed >= 0 && elapsed <= PREFETCH_LIMITS.gestureGapMs;
        const interval = Math.max(16, continuing ? elapsed : 32);
        const speed = Math.abs(delta) / interval;
        const signedSpeed = delta / interval;

        // Reversal starts a new acceleration sample while retaining the cautious
        // speed envelope. Idle gaps also discard the previous derivative.
        this.acceleration = continuing && Math.sign(delta) === this.direction
            ? this.acceleration * 0.5 + ((signedSpeed - this.signedSampleVelocity) / interval) * 0.5
            : 0;
        this.signedSampleVelocity = signedSpeed;
        this.velocity = continuing ? Math.max(speed, this.velocity * 0.75) : speed;
        this.lastInputAt = now;
        this.lastDelta = delta;
    }

    /** Supply elapsed time through readiness, including preparation and rendering. */
    page(milliseconds: number): void {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) { return; }
        // One slow page should grow the lead immediately; one cached page should
        // not erase the time needed for the next uncached page.
        this.latency = Math.max(milliseconds, this.latency * 0.8);
    }

    preload(viewport: number): number {
        if (!(viewport > 0) || !Number.isFinite(viewport)) { return 0; }
        const base = Math.max(480, viewport * 2);
        const limit = Math.max(base, Math.min(12_000, viewport * 12));
        return Math.ceil(Math.min(limit, base + Math.abs(this.lastDelta) * 2 +
            this.velocity * (350 + Math.min(5_000, this.latency) * 4)));
    }

    /** End the gesture while retaining the current document's preparation cost. */
    stop(): void {
        this.lastInputAt = -Infinity;
        this.lastDelta = 0;
        this.velocity = 0;
        this.signedSampleVelocity = 0;
        this.acceleration = 0;
    }

    /** A new document starts without the previous document's latency estimate. */
    reset(): void {
        this.stop();
        this.latency = INITIAL_PAGE_LATENCY_MS;
    }

    snapshot(viewport: number): ScrollPrefetchSnapshot {
        return {
            velocityPxPerMs: Math.round(this.velocity * 100) / 100,
            accelerationPxPerMs2: Math.round(this.acceleration * 1_000_000) / 1_000_000,
            pageLatencyMs: Math.round(this.latency),
            preloadPx: this.preload(viewport),
            direction: this.direction,
        };
    }
}
