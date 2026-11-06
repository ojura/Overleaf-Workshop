import type { SiteConfig } from './config';

export interface SitePublicationChange {
    kind: 'document' | 'reading' | 'previews' | 'metadata';
    newEdition: boolean;
}

/** A larger atlas for the same PDF must not close the reader or replay its page deliveries. */
export function sitePublicationChange(previous: SiteConfig, next: SiteConfig): SitePublicationChange | undefined {
    const before = previous.reading ?? previous.previews, after = next.reading ?? next.previews;
    const changedBytes = !!before && !!after && (before.sha256 !== after.sha256 || before.size !== after.size);
    const changedValidator = !!before && !!after && (before.validator.header !== after.validator.header
        || before.validator.value !== after.validator.value);
    if (previous.pdfUrl !== next.pdfUrl || changedBytes || changedValidator) {
        return { kind: 'document', newEdition: changedBytes || !before || !after };
    }
    if (JSON.stringify(previous.reading) !== JSON.stringify(next.reading)) { return { kind: 'reading', newEdition: false }; }
    if (JSON.stringify(previous.previews) !== JSON.stringify(next.previews)) { return { kind: 'previews', newEdition: false }; }
    if (previous.title !== next.title || previous.filename !== next.filename || previous.sourceUrl !== next.sourceUrl) {
        return { kind: 'metadata', newEdition: false };
    }
}

interface PublicationWatchOptions {
    current(): SiteConfig;
    read(signal: AbortSignal): Promise<SiteConfig>;
    apply(config: SiteConfig, change: SitePublicationChange): boolean | void | Promise<boolean | void>;
    canApply?(): boolean;
    onError?(error: unknown): void;
    document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
    clock?: Pick<Window, 'setTimeout' | 'clearTimeout'>;
    intervalMs?: number;
}

/** Small configuration reads, only while visible and between user interactions. */
export function watchSitePublication(options: PublicationWatchOptions) {
    const doc = options.document ?? document;
    const clock = options.clock ?? window;
    const interval = options.intervalMs ?? 15_000;
    let timer: number | undefined, deadline: number | undefined;
    let flight: AbortController | undefined;
    let disposed = false, running = false, rerun = false, generation = 0, failures = 0;
    const counts = { polls: 0, applied: 0, errors: 0 };
    const visible = () => doc.visibilityState !== 'hidden';
    const clearTimer = () => { if (timer !== undefined) { clock.clearTimeout(timer); timer = undefined; } };
    const clearDeadline = () => { if (deadline !== undefined) { clock.clearTimeout(deadline); deadline = undefined; } };

    function schedule(delay: number) {
        clearTimer();
        if (disposed || !visible()) { return; }
        timer = clock.setTimeout(() => { timer = undefined; void check(); }, delay);
    }

    async function check() {
        if (disposed || !visible()) { return; }
        if (running) { rerun = true; return; }
        if (options.canApply && !options.canApply()) { schedule(1000); return; }
        running = true;
        rerun = false;
        const epoch = generation, controller = new AbortController();
        flight = controller;
        deadline = clock.setTimeout(() => controller.abort(), 8000);
        try {
            counts.polls++;
            const next = await options.read(controller.signal);
            clearDeadline();
            flight = undefined;
            if (disposed || epoch !== generation || controller.signal.aborted || !visible()) { return; }
            failures = 0;
            // Input arriving during the request wins; the next quiet check reads the newest edition.
            if (options.canApply && !options.canApply()) { rerun = true; return; }
            const change = sitePublicationChange(options.current(), next);
            if (change && await options.apply(next, change) !== false) { counts.applied++; }
        } catch (error) {
            if (!disposed && epoch === generation && visible()) {
                failures++;
                counts.errors++;
                try { options.onError?.(error); } catch { /* Reporting must not stop future checks. */ }
            }
        } finally {
            clearDeadline();
            if (flight === controller) { flight = undefined; }
            running = false;
            schedule(rerun ? 1000 : Math.min(120_000, interval * 2 ** Math.min(failures, 3)));
        }
    }

    function visibilityChanged() {
        if (!visible()) {
            generation++;
            clearTimer();
            clearDeadline();
            flight?.abort();
        } else {
            rerun = true;
            schedule(0);
        }
    }
    doc.addEventListener('visibilitychange', visibilityChanged);
    schedule(interval);
    return {
        refresh() { rerun = true; schedule(0); },
        snapshot() { return { ...counts, running, scheduled: timer !== undefined, failures }; },
        dispose() {
            if (disposed) { return; }
            disposed = true; generation++;
            clearTimer(); clearDeadline(); flight?.abort();
            doc.removeEventListener('visibilitychange', visibilityChanged);
        },
    };
}
