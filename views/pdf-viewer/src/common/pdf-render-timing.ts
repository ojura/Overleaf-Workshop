export const PDF_RENDER_TIMING_POLICY = Object.freeze({
    // A one-second probe also works when a background renderer coarsens its timers.
    // A late timer can indicate blocked foreground work, so only a prompt timer
    // with a withheld animation frame invalidates the measurement.
    probeIntervalMs: 1000,
    maxTimerDriftMs: 100,
});

export interface PdfRenderMeasurement {
    /** Consume a valid elapsed duration; cancelled or suspended measurements are omitted. */
    finish(): number | undefined;
    cancel(): void;
}

type Timer = ReturnType<typeof setTimeout>;

export interface PdfRenderTimingsOptions {
    now(): number;
    requestFrame(callback: FrameRequestCallback): number;
    cancelFrame(id: number): void;
    setTimer?(callback: () => void, milliseconds: number): Timer;
    clearTimer?(id: Timer): void;
}

interface Measurement {
    started: number;
    isActive?: () => boolean;
}

const omitted: PdfRenderMeasurement = Object.freeze({ finish: () => undefined, cancel() {} });

/** Measure useful render durations without learning time when frame delivery was suspended. */
export function createPdfRenderTimings(options: PdfRenderTimingsOptions) {
    const active = new Set<Measurement>();
    const setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    const clearTimer = options.clearTimer ?? (id => clearTimeout(id));
    let frame: number | undefined, timer: Timer | undefined;
    let epoch = 0, disposed = false;

    function stopProbe(): void {
        epoch++;
        if (frame !== undefined) { options.cancelFrame(frame); frame = undefined; }
        if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    }

    function remove(measurement: Measurement): void {
        active.delete(measurement);
        measurement.isActive = undefined;
        if (!active.size) { stopProbe(); }
    }

    function invalidate(): void {
        for (const measurement of active) { measurement.isActive = undefined; }
        active.clear();
        stopProbe();
    }

    function isActive(measurement: Measurement): boolean {
        try { return measurement.isActive?.() !== false; }
        catch { return false; }
    }

    function probe(): void {
        if (disposed || !active.size || timer !== undefined) { return; }
        const currentEpoch = ++epoch, started = options.now();
        let delivered = false;
        try {
            frame = options.requestFrame(() => {
                if (currentEpoch !== epoch || disposed) { return; }
                frame = undefined;
                delivered = true;
            });
            timer = setTimer(() => {
                if (currentEpoch !== epoch || disposed) { return; }
                timer = undefined;
                for (const measurement of active) {
                    if (!isActive(measurement)) { remove(measurement); }
                }
                if (!active.size) { return; }
                const elapsed = options.now() - started;
                const drift = elapsed - PDF_RENDER_TIMING_POLICY.probeIntervalMs;
                if (!Number.isFinite(elapsed) || elapsed < 0
                    || !delivered && Math.abs(drift) <= PDF_RENDER_TIMING_POLICY.maxTimerDriftMs) {
                    invalidate();
                    return;
                }
                stopProbe();
                probe();
            }, PDF_RENDER_TIMING_POLICY.probeIntervalMs);
        } catch {
            // Timing observation must not prevent PDF rendering when its window is retiring.
            invalidate();
        }
    }

    return {
        start(stillActive?: () => boolean): PdfRenderMeasurement {
            if (disposed) { return omitted; }
            const measurement: Measurement = { started: options.now(), isActive: stillActive };
            if (!Number.isFinite(measurement.started) || !isActive(measurement)) { return omitted; }
            active.add(measurement);
            probe();
            return {
                finish() {
                    if (!active.has(measurement)) { return; }
                    const elapsed = options.now() - measurement.started;
                    remove(measurement);
                    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
                },
                cancel() { remove(measurement); },
            };
        },
        invalidate,
        dispose(): void {
            if (disposed) { return; }
            disposed = true;
            invalidate();
        },
    };
}
