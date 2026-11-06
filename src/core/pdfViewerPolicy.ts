/** Policies used by both extension viewers and the host that persists their state. */
export const PDF_VIEWER_POLICY = Object.freeze({
    /** Overleaf's button and keyboard zoom factor; wheel and pinch retain continuous zoom. */
    zoomStep: 1.25,
    /** Last resort when a document's worker never acknowledges destruction. */
    destroyTimeoutMs: 10_000,
    /** Capture is immediate; only durable host storage is coalesced. */
    stateWriteDelayMs: 500,
});
