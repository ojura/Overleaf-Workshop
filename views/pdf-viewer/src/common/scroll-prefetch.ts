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
    trailPreviewMaxDimension: 768,
    maxPreviewBytes: 64 * 1024 * 1024,
    maxPreviewPages: 128,
});

/** A small resident working set for phones; disk accumulation belongs to the extension host. */
const MOBILE_PREFETCH_LIMITS = Object.freeze({
    ...PREFETCH_LIMITS,
    maxPreparedPages: 6,
    maxConcurrentPrepares: 2,
    maxPendingFetches: 6,
    slowPendingFetches: 3,
    maxRenderedPages: 3,
    maxCanvasBytes: 48 * 1024 * 1024,
    previewMaxDimension: 512,
    trailPreviewMaxDimension: 192,
    maxPreviewBytes: 8 * 1024 * 1024,
    maxPreviewPages: 128,
});

export interface PdfCachePolicy {
    readonly name: 'desktop' | 'mobile';
    readonly limits: Readonly<{ [Key in keyof typeof PREFETCH_LIMITS]: number }>;
    readonly rangeCacheBytes: number;
    readonly pruneOffscreen: boolean;
    readonly adaptiveImageDecoding: boolean;
    readonly imageDecodeConcurrency: number;
}

export interface ReaderDevice {
    userAgent?: string;
    maxTouchPoints?: number;
    userAgentData?: { mobile?: boolean };
}

const DESKTOP_POLICY: PdfCachePolicy = Object.freeze({
    name: 'desktop', limits: PREFETCH_LIMITS, rangeCacheBytes: 128 * 1024 * 1024, pruneOffscreen: false,
    adaptiveImageDecoding: false, imageDecodeConcurrency: 0,
});
const MOBILE_POLICY: PdfCachePolicy = Object.freeze({
    name: 'mobile', limits: MOBILE_PREFETCH_LIMITS, rangeCacheBytes: 32 * 1024 * 1024, pruneOffscreen: true,
    adaptiveImageDecoding: true, imageDecodeConcurrency: 1,
});

/** iPad's desktop UA still reports several touch points; a Windows touch laptop stays desktop. */
export function pdfCachePolicy(device: ReaderDevice = typeof navigator === 'undefined' ? {} : navigator): PdfCachePolicy {
    const agent = device.userAgent ?? '';
    return device.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(agent)
        || /Macintosh/i.test(agent) && (device.maxTouchPoints ?? 0) > 1 ? MOBILE_POLICY : DESKTOP_POLICY;
}

/** Pass the same device policy to every PDF.js document-loading entry point. */
export function pdfDocumentCacheOptions(device?: ReaderDevice) {
    const { rangeCacheBytes, adaptiveImageDecoding, imageDecodeConcurrency } = pdfCachePolicy(device);
    return { rangeCacheBytes, adaptiveImageDecoding, imageDecodeConcurrency };
}

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
