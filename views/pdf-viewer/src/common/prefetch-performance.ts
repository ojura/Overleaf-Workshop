import { installPrefetchRobots, type RobotDispatchPort, type RobotLab } from './prefetch-robots';
import { installMotionLabPanel, type MotionLabPanelLayout } from './motion-lab-panel';

/** Bounded measurements shared by both PDF viewers and their fetch bridge. */
export const PERFORMANCE_LIMITS = Object.freeze({
    eventCapacity: 512,
    fetchSampleCapacity: 2048,
    fetchWindowMs: 5000,
    refreshMs: 250,
    traceWindowMs: 10000,
    eventFields: 16,
    eventTextLength: 96,
});

type Measurement = number | string | boolean | null;
type EventData = Record<string, Measurement>;
export interface PerformanceEvent {
    sequence: number;
    at: number;
    type: string;
    data: EventData;
}
interface FetchSample { at: number; start: number; bytes: number }

export interface DiskCacheSnapshot {
    storedBytes: number;
    totalBytes: number;
    diskBytes: number;
    budgetBytes: number;
    filling: boolean;
    complete: boolean;
}

/** Fixed storage also bounds diagnostics when a viewer stays open for days. */
class Ring<T> {
    private entries: (T | undefined)[];
    private next = 0;
    private size = 0;

    constructor(private readonly capacity: number) {
        this.entries = new Array(capacity);
    }

    push(value: T): void {
        this.entries[this.next] = value;
        this.next = (this.next + 1) % this.capacity;
        this.size = Math.min(this.capacity, this.size + 1);
    }

    values(): T[] {
        const result: T[] = [];
        const first = (this.next - this.size + this.capacity) % this.capacity;
        for (let index = 0; index < this.size; index++) {
            result.push(this.entries[(first + index) % this.capacity]!);
        }
        return result;
    }

    clear(): void {
        this.entries.fill(undefined);
        this.next = this.size = 0;
    }
}

export class PdfPerformance {
    private readonly events = new Ring<PerformanceEvent>(PERFORMANCE_LIMITS.eventCapacity);
    private readonly transfers = new Ring<FetchSample>(PERFORMANCE_LIMITS.fetchSampleCapacity);
    private readonly activeFetches = new Map<number, number>();
    private readonly fetchListeners = new Set<() => void>();
    private nextFetchId = 0;
    private eventCount = 0;
    private fetchBytes = 0;
    private fetchCount = 0;
    private fetchDurationMs = 0;
    private fetchLastDurationMs = 0;
    private firstFetchAt = Infinity;
    private startedAt = 0;
    private diskCache?: DiskCacheSnapshot;

    constructor(private readonly now: () => number = () => performance.now()) {
        this.startedAt = now();
    }

    get pendingFetchCount(): number { return this.activeFetches.size; }

    /** Constant-time admission signal; reading this does not copy diagnostic history. */
    get oldestFetchMs(): number { return this.ageOfOldestFetch(this.now()); }

    /** Keep one numeric host-cache report; URLs, document text and build identifiers stay out. */
    setDiskCache(value?: DiskCacheSnapshot): void {
        if (!value) { this.diskCache = undefined; return; }
        const { storedBytes, totalBytes, diskBytes, budgetBytes, filling, complete } = value;
        if (![storedBytes, totalBytes, diskBytes, budgetBytes].every(bytes => Number.isSafeInteger(bytes) && bytes >= 0)) { return; }
        this.diskCache = { storedBytes, totalBytes, diskBytes, budgetBytes, filling: !!filling, complete: !!complete };
    }

    private ageOfOldestFetch(at: number): number {
        const first = this.activeFetches.values().next();
        return first.done ? 0 : Math.max(0, at - first.value);
    }

    /** Pair every admitted request with its returned cleanup, normally from a finally block. */
    beginFetch(): () => void {
        const id = ++this.nextFetchId;
        this.activeFetches.set(id, this.now());
        this.notifyFetchChange();
        let ended = false;
        return () => {
            if (ended) { return; }
            ended = true;
            // IDs remain unique across reset, so an old document cannot finish a newer request.
            if (this.activeFetches.delete(id)) { this.notifyFetchChange(); }
        };
    }

    /** Synchronous notifications allow the controller to coalesce its own scheduling work. */
    onFetchChange(listener: () => void): () => void {
        const subscription = () => listener();
        this.fetchListeners.add(subscription);
        return () => { this.fetchListeners.delete(subscription); };
    }

    private notifyFetchChange(): void {
        for (const listener of Array.from(this.fetchListeners)) {
            if (!this.fetchListeners.has(listener)) { continue; }
            try {
                listener();
            } catch {
                // Observer failures must not strand a request before its cleanup can be returned.
                this.event('fetch-observer-error');
            }
        }
    }

    /** Callers supply measurements and constant labels, without URLs or document text. */
    event(type: string, data: EventData = {}): void {
        const copy: EventData = {};
        for (const [key, value] of Object.entries(data).slice(0, PERFORMANCE_LIMITS.eventFields)) {
            if (typeof value === 'string') {
                copy[key.slice(0, PERFORMANCE_LIMITS.eventTextLength)] = value.slice(0, PERFORMANCE_LIMITS.eventTextLength);
            } else if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
                copy[key.slice(0, PERFORMANCE_LIMITS.eventTextLength)] = value;
            }
        }
        this.events.push({
            sequence: ++this.eventCount,
            at: this.now(),
            type: type.slice(0, PERFORMANCE_LIMITS.eventTextLength),
            data: copy,
        });
    }

    /**
     * Measure completed byte delivery, including bridge cache hits. Durations include waiting.
     * The rolling rate distributes each transfer's bytes over its measured interval, so parallel
     * requests share a time denominator and a long request does not produce a completion spike.
     */
    fetch(bytes: number, durationMs: number): void {
        if (!(bytes > 0) || !Number.isFinite(bytes) || !(durationMs >= 0) || !Number.isFinite(durationMs)) { return; }
        const at = this.now();
        const start = at - Math.max(1, durationMs);
        this.transfers.push({ at, start, bytes });
        this.firstFetchAt = Math.min(this.firstFetchAt, start);
        this.fetchBytes += bytes;
        this.fetchCount++;
        this.fetchDurationMs += durationMs;
        this.fetchLastDurationMs = durationMs;
        this.event('fetch', { bytes, durationMs });
    }

    snapshot() {
        const at = this.now();
        const start = Math.max(at - PERFORMANCE_LIMITS.fetchWindowMs, this.firstFetchAt);
        let bytes = 0;
        for (const transfer of this.transfers.values()) {
            const overlap = Math.max(0, Math.min(at, transfer.at) - Math.max(start, transfer.start));
            bytes += transfer.bytes * overlap / (transfer.at - transfer.start);
        }
        const windowMs = this.fetchCount ? Math.max(1, at - start) : 0;
        return {
            at,
            elapsedMs: Math.max(0, at - this.startedAt),
            events: this.events.values().map(event => ({ ...event, data: { ...event.data } })),
            eventCount: this.eventCount,
            droppedEvents: Math.max(0, this.eventCount - PERFORMANCE_LIMITS.eventCapacity),
            fetchBytes: this.fetchBytes,
            fetchCount: this.fetchCount,
            pendingFetchCount: this.pendingFetchCount,
            oldestFetchMs: this.ageOfOldestFetch(at),
            fetchMiBPerSecond: windowMs ? bytes * 1000 / windowMs / (1024 * 1024) : 0,
            fetchWindowMs: windowMs,
            fetchLastDurationMs: this.fetchLastDurationMs,
            fetchAverageDurationMs: this.fetchCount ? this.fetchDurationMs / this.fetchCount : 0,
            diskCache: this.diskCache ? { ...this.diskCache } : undefined,
        };
    }

    reset(): void {
        this.events.clear();
        this.transfers.clear();
        this.activeFetches.clear();
        this.eventCount = this.fetchBytes = this.fetchCount = this.fetchDurationMs = this.fetchLastDurationMs = 0;
        this.firstFetchAt = Infinity;
        this.startedAt = this.now();
        this.diskCache = undefined;
        this.notifyFetchChange();
    }
}

export const pdfPerformance = new PdfPerformance();

export interface DecodedImageSnapshot {
    pageBytes: number;
    sharedBytes: number;
    dataBytes: number;
    bitmapBytes: number;
    images: number;
    supported: boolean;
    truncated: boolean;
}

export interface PrefetchDiagnosticSample {
    direction: number;
    velocityPxPerMs: number;
    accelerationPxPerMs2: number;
    pageLatencyMs: number;
    preloadPx: number;
    readyDistancePx: number;
    safetySeconds: number | null;
    bufferSeconds: number | null;
    visible: readonly number[];
    renderAhead: readonly number[];
    prepared: readonly number[];
    pending: readonly number[];
    failed: readonly number[];
    previewPages: number;
    previewBytes: number;
    canvasBytes: number;
    cachePolicy?: string;
    rangeCache?: Record<string, number>;
    decodedImages?: DecodedImageSnapshot;
    starved?: boolean;
    visibleMissing?: readonly number[];
    fetchBackpressure?: boolean;
    memoryBackpressure?: boolean;
    robots?: {
        frames: number;
        paintTotalMs: number;
        paintMaxMs: number;
        paintLastMs: number;
        activeActors?: number;
    };
    performance?: ReturnType<PdfPerformance['snapshot']>;
}

interface TraceSample {
    at: number;
    velocity: number;
    buffer: number | null;
    delay: number;
}

interface DiagnosticsOptions {
    toolbar?: HTMLElement;
    toolbarBefore?: HTMLElement;
    measurementsMenu?: HTMLElement;
    onOpen?: () => void;
    onPanelLayout?: (layout: MotionLabPanelLayout) => void;
    enabled?: boolean;
    robots?: {
        readonly enabled: boolean;
        setEnabled(enabled: boolean): void;
        setDispatchOrigin?(port: RobotDispatchPort | undefined): void;
    };
}

const ROBOT_ICON = `<svg class="robot-icon" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4M7 11H4v10h20V11h-3M9 7h10v14H9zM11 24h6"/><path d="M12 12v2m4-2v2m-4 4h4"/></g><circle cx="14" cy="3" r="1.5" fill="currentColor"/></svg>`;
const MEASUREMENTS_ICON = `<svg class="robot-icon" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5v18h19M8 18l5-8 5 5 6-9"/><circle cx="13" cy="10" r="1.5"/><circle cx="18" cy="15" r="1.5"/></g></svg>`;

/**
 * Document deliveries and the optional motion lab have independent controls. The lab remains
 * closed until requested, so an enabled document effect adds no measurement sampling timer.
 */
export function installPrefetchDiagnostics(container: HTMLElement, sample: () => PrefetchDiagnosticSample, options: DiagnosticsOptions = {}) {
    const doc = container.ownerDocument;
    const win = doc?.defaultView;
    let host: HTMLDivElement | undefined;
    let root: ShadowRoot | undefined;
    let timer: number | undefined;
    let robots: RobotLab | undefined;
    let panel: ReturnType<typeof installMotionLabPanel> | undefined;
    let button: HTMLButtonElement | undefined;
    let measurementsButton: HTMLButtonElement | undefined;
    let shown = false;
    let disposed = false;
    let previousFocus: Element | null = null;
    const history: TraceSample[] = [];
    const fields = new Map<string, HTMLElement>();

    function field(name: string, text: string): void {
        const element = fields.get(name);
        if (element) { element.textContent = text; }
    }

    function format(value: number, digits = 0): string {
        return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '?';
    }

    function seconds(value: number | null, signed = false): string {
        return value === null || !Number.isFinite(value) ? 'idle' : `${signed && value > 0 ? '+' : ''}${format(value, 2)} s`;
    }

    function trace(name: keyof Omit<TraceSample, 'at'>, min: number, max: number, at: number): string {
        let drawing = false;
        let result = '';
        const width = 304;
        const height = 54;
        for (const point of history) {
            const value = point[name];
            if (value === null || !Number.isFinite(value)) { drawing = false; continue; }
            const x = 4 + width * Math.max(0, (point.at - at + PERFORMANCE_LIMITS.traceWindowMs) / PERFORMANCE_LIMITS.traceWindowMs);
            const y = 4 + height * (1 - (value - min) / Math.max(0.001, max - min));
            result += `${drawing ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
            drawing = true;
        }
        return result;
    }

    function tick(): void {
        if (!shown || disposed || doc.hidden || !root) { return; }
        const state = sample();
        const metrics = state.performance ?? pdfPerformance.snapshot();
        robots?.update({ ...state, performance: metrics });
        const velocity = state.direction * Math.abs(state.velocityPxPerMs) * 1000;
        const delay = state.pageLatencyMs / 1000;
        history.push({ at: metrics.at, velocity, buffer: state.bufferSeconds, delay });
        const traceCapacity = Math.ceil(PERFORMANCE_LIMITS.traceWindowMs / PERFORMANCE_LIMITS.refreshMs) + 1;
        while (history.length > traceCapacity || history.length && history[0].at < metrics.at - PERFORMANCE_LIMITS.traceWindowMs) { history.shift(); }
        field('velocity', `${format(velocity)} px/s`);
        field('acceleration', `${format(state.accelerationPxPerMs2 * 1e6)} px/s²`);
        field('throughput', `${format(metrics.fetchMiBPerSecond, 2)} MiB/s`);
        field('delay', `${format(state.pageLatencyMs)} ms`);
        field('distance', `${format(state.readyDistancePx)} px`);
        field('target', `${format(state.preloadPx)} px`);
        field('buffer', seconds(state.bufferSeconds));
        field('margin', seconds(state.safetySeconds, true));
        const fleet = state.robots;
        field('document-paint', fleet ? `Document fleet paint: last ${format(fleet.paintLastMs, 2)} ms; mean ${format(fleet.frames ? fleet.paintTotalMs / fleet.frames : 0, 2)} ms; max ${format(fleet.paintMaxMs, 2)} ms; ${format(fleet.frames)} paints${fleet.activeActors === undefined ? '' : `; ${format(fleet.activeActors)} active actors`}.` : '');
        field('cache', `${state.previewPages} previews; ${format(state.previewBytes / (1024 * 1024), 1)} MiB preview; ${format(state.canvasBytes / (1024 * 1024), 1)} MiB canvas`);
        const bytes = state.rangeCache;
        field('byte-cache', bytes ? `${state.cachePolicy ?? 'reader'}; ${format(bytes.residentBytes / (1024 * 1024), 1)} / ${format(bytes.maxBytes / (1024 * 1024))} MiB ranges; ${format(bytes.evictedBytes / (1024 * 1024), 1)} MiB evicted` : '');
        const decoded = state.decodedImages;
        field('decoded-images', !decoded ? '' : !decoded.supported ? 'Decoded image accounting unavailable'
            : `Decoded images${decoded.truncated ? ' (partial scan)' : ''}: ${format(decoded.pageBytes / (1024 * 1024), 1)} MiB page; ${format(decoded.sharedBytes / (1024 * 1024), 1)} MiB shared${decoded.bitmapBytes ? ' (RGBA bitmap estimate)' : ''}`);
        const imageStats = bytes && bytes.imageDecodeConcurrency > 0 ? bytes : undefined;
        field('image-work', imageStats ? `Image decoding: ${format(imageStats.imageDecodeActive)} / ${format(imageStats.imageDecodeConcurrency)} active; ${format(imageStats.imageDecodeQueued)} queued; peak ${format(imageStats.imageDecodePeakActive)} active. ${format(imageStats.imageDecodeCompletedNative)} native; ${format(imageStats.imageDecodeCompletedFallback)} fallback.` : '');
        field('image-pixels', imageStats && imageStats.imageDecodeOriginalPixels > 0 ? `Decoded pixels, cumulative: ${format(imageStats.imageDecodeOutputPixels / 1e6, 1)} MP output / ${format(imageStats.imageDecodeOriginalPixels / 1e6, 1)} MP original.` : '');
        const disk = metrics.diskCache;
        field('disk-cache', disk ? `Disk: ${format(disk.storedBytes / (1024 * 1024), 1)} / ${format(disk.totalBytes / (1024 * 1024), 1)} MiB of this build. ${disk.complete ? 'Complete' : disk.filling ? 'Filling' : 'Paused'}. All builds: ${format(disk.diskBytes / (1024 * 1024), 1)} / ${format(disk.budgetBytes / (1024 * 1024))} MiB.` : '');
        field('work', `${state.pending.length} preparing; ${state.prepared.length} preview targets; ${state.renderAhead.length} render targets; ${state.failed.length} failed`);
        field('total', `${format(metrics.fetchBytes / (1024 * 1024), 1)} MiB received; ${format(metrics.fetchCount)} fetches`);
        field('transport', `${metrics.pendingFetchCount} fetches in flight; oldest ${format(metrics.oldestFetchMs)} ms${state.fetchBackpressure ? '; cold-page admission paused' : ''}${state.memoryBackpressure ? '; waiting for byte-cache cleanup' : ''}`);
        const margin = state.safetySeconds;
        fields.get('margin')!.style.color = margin !== null && margin < 0 ? '#ffb68c' : '#66e5cf';
        const status = fields.get('status')!;
        const starved = !!state.starved || !!state.visibleMissing?.length;
        status.dataset.state = starved ? 'late' : margin === null ? 'idle' : margin >= 0 ? 'ready' : 'late';
        status.textContent = starved ? 'Waiting for visible pages' : margin === null ? 'Motion stopped' : margin >= 0 ? 'Buffered ahead' : 'Preparing to catch up';

        const speedMax = Math.max(1, ...history.map(point => Math.abs(point.velocity)));
        const timeMax = Math.max(0.1, ...history.flatMap(point => [point.delay, point.buffer ?? 0]));
        root.querySelector('[data-trace="velocity"]')!.setAttribute('d', trace('velocity', -speedMax, speedMax, metrics.at));
        root.querySelector('[data-trace="buffer"]')!.setAttribute('d', trace('buffer', 0, timeMax, metrics.at));
        root.querySelector('[data-trace="delay"]')!.setAttribute('d', trace('delay', 0, timeMax, metrics.at));
        field('speed-scale', `±${format(speedMax)} px/s`);
        field('time-scale', `${format(timeMax, 2)} s`);
        field('events', metrics.events.slice(-5).map(event => {
            const values = Object.entries(event.data).map(([key, value]) => `${key}=${typeof value === 'number' ? format(value, 1) : value}`).join(' ');
            return `${(event.at / 1000).toFixed(2)} ${event.type}${values ? ' ' + values : ''}`;
        }).join('\n') || 'Waiting for measurements');
        field('event-count', `${metrics.events.length} recent / ${format(metrics.eventCount)} total`);
    }

    function stopTimer(): void {
        options.robots?.setDispatchOrigin?.(undefined);
        robots?.setActive(false);
        if (timer !== undefined) {
            win!.clearInterval(timer);
            timer = undefined;
        }
    }

    function startTimer(): void {
        stopTimer();
        if (shown && !doc.hidden && win) {
            tick();
            robots?.setActive(true);
            options.robots?.setDispatchOrigin?.(robots?.dispatch);
            timer = win.setInterval(tick, PERFORMANCE_LIMITS.refreshMs);
        }
    }

    async function copySnapshot(): Promise<void> {
        const { performance: measured, ...viewer } = sample();
        const text = JSON.stringify({ viewer, performance: measured ?? pdfPerformance.snapshot(), labRobots: robots?.snapshot() }, null, 2);
        try {
            if (win?.navigator.clipboard?.writeText) {
                await win.navigator.clipboard.writeText(text);
            } else {
                const textarea = doc.createElement('textarea');
                textarea.value = text;
                textarea.style.cssText = 'position:fixed;left:-9999px;top:0';
                root!.append(textarea);
                try {
                    textarea.select();
                    if (!doc.execCommand('copy')) { throw new Error('Clipboard unavailable'); }
                } finally {
                    textarea.remove();
                }
            }
            field('copy-status', 'Measurements copied');
        } catch {
            field('copy-status', 'Clipboard unavailable in this viewer');
        }
    }

    function createPanel(): void {
        host = doc.createElement('div');
        host.id = 'pdf-prefetch-diagnostics';
        root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
<style>
:host { all:initial; position:fixed; right:max(14px,env(safe-area-inset-right)); bottom:max(14px,env(safe-area-inset-bottom)); z-index:2147483646; display:block; color:#e8f0fa; font:12px/1.4 system-ui,sans-serif; color-scheme:dark; }
:host([hidden]) { display:none !important; }
* { box-sizing:border-box; }
section { position:relative; display:flex; flex-direction:column; width:456px; max-width:calc(100vw - 28px); max-height:calc(100vh - 70px); max-height:calc(100dvh - 70px); overflow:hidden; padding:14px; border:1px solid #43566b; border-radius:12px; background:#101c2b; box-shadow:0 8px 36px #0007; }
header { display:flex; align-items:center; gap:9px; }
.panel-content { min-height:0; overflow:auto; overscroll-behavior:contain; }
.panel-drag { cursor:move; touch-action:none; user-select:none; border-radius:3px; }
.panel-drag:focus-visible { outline:2px solid #66e5cf; outline-offset:3px; }
.panel-position { flex:none; display:flex; flex-wrap:wrap; gap:5px; margin:7px 0 2px; }
.panel-position button { font-size:10px; padding:4px 7px; }
.panel-position button[aria-pressed="true"] { border-color:#66e5cf; color:#66e5cf; }
.panel-resize { position:absolute; right:0; bottom:0; width:26px; height:26px; padding:0; border:0; border-radius:8px 0; cursor:nwse-resize; touch-action:none; z-index:1; }
:host([data-dock="left"]) .panel-resize { cursor:ew-resize; }
:host([data-dock="right"]) .panel-resize { left:0; right:auto; cursor:ew-resize; border-radius:0 8px; }
.robot-icon { flex:none; width:25px; height:25px; color:#66e5cf; }
h2 { flex:1; margin:0; font-size:14px; font-weight:600; }
button { border:1px solid #4b6178; border-radius:5px; color:inherit; background:#203248; padding:5px 8px; cursor:pointer; font:inherit; }
button:hover { background:#30485f; } button:focus-visible { outline:2px solid #66e5cf; outline-offset:2px; }
.close { min-width:28px; min-height:28px; padding:0 6px; font-size:19px; }
.meta { display:flex; justify-content:space-between; align-items:center; gap:6px; margin-top:9px; font-size:10px; color:#b2c0cf; }
.status { color:#66e5cf; font-size:11px; } .status[data-state="idle"] { color:#b2c0cf; } .status[data-state="late"] { color:#ffb68c; }
.robot-stage { margin-top:11px; border:1px solid #345069; border-radius:8px; overflow:hidden; background:#0b1424; contain:layout paint; pointer-events:none; }
.robot-canvas { display:block; width:100%; aspect-ratio:480 / 250; }
.robot-caption { min-height:32px; padding:7px 10px 1px; color:#d0e2f0; font-size:11px; line-height:1.4; }
.robot-activity { padding:3px 10px 8px; color:#849eb5; font-size:10px; line-height:1.3; font-variant-numeric:tabular-nums; }
dl { display:grid; grid-template-columns:1fr 1fr; gap:9px 14px; margin:13px 0; }
dt { color:#b2c0cf; font-size:10px; } dd { margin:1px 0 0; font:500 15px/1.3 system-ui,sans-serif; font-variant-numeric:tabular-nums; white-space:nowrap; }
.margin { color:#66e5cf; } p { margin:5px 0; } .explanation,.storage,.foot { color:#b2c0cf; font-size:10px; }
.graph { border-top:1px solid #304359; margin-top:10px; padding-top:7px; }
.legend { display:flex; justify-content:space-between; gap:5px; color:#b2c0cf; font-size:10px; }
svg.chart { display:block; width:100%; height:62px; overflow:visible; }
.axis { stroke:#34455b; stroke-width:1; } .curve { fill:none; stroke-width:1.7; stroke-linejoin:round; stroke-linecap:round; }
.velocity { stroke:#acb8ff; } .buffer { stroke:#66e5cf; } .delay { stroke:#ffba7a; } .green { color:#66e5cf; } .orange { color:#ffba7a; }
details { margin-top:9px; border-top:1px solid #304359; padding-top:7px; }
summary { cursor:pointer; font-size:10px; color:#b2c0cf; }
.measurements > summary { padding:4px 0; font-size:12px; color:#d0e2f0; }
pre { font:9px/1.5 ui-monospace,monospace; margin:6px 0 0; max-height:78px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
footer { display:flex; align-items:center; gap:8px; margin-top:10px; }
footer span { font-size:10px; color:#b2c0cf; }
@media (max-width:700px), (pointer:coarse) {
    :host { right:max(8px,env(safe-area-inset-right)); bottom:max(8px,env(safe-area-inset-bottom)); }
    section { width:340px; max-width:calc(100vw - 16px); max-height:calc(100vh - 100px); max-height:calc(100dvh - 100px); padding:6px 8px; }
    section:has(.measurements[open]) { max-height:calc(100vh - 100px); max-height:calc(100dvh - 100px); }
    h2 { font-size:13px; }
    .close { min-width:44px; min-height:44px; }
    .meta { margin-top:3px; }
    .robot-stage { margin-top:6px; }
    .robot-caption { min-height:0; padding:5px 8px; font-size:10px; }
    .robot-activity { display:none; }
    section:not(:has(.measurements[open])) .meta,
    section:not(:has(.measurements[open])) .robot-caption { display:none; }
    section:not(:has(.measurements[open])) .robot-canvas { height:86px; aspect-ratio:auto; object-fit:contain; }
    section:not(:has(.measurements[open])) .measurements { margin-top:4px; padding-top:0; }
    .measurements > summary { min-height:44px; padding:12px 0; }
    .copy { min-height:44px; }
    .panel-position button { min-height:36px; }
    .panel-resize { width:36px; height:36px; }
}
</style>
<section role="region" aria-label="PDF motion diagnostics">
<header>
${ROBOT_ICON}
<h2 class="panel-drag" tabindex="0" title="Drag to move; arrow keys move the panel" aria-label="LARICS Motion Lab; use arrow keys to move">LARICS Motion Lab</h2><button class="close" type="button" aria-label="Close motion diagnostics">×</button>
</header>
<div class="panel-position" role="group" aria-label="Motion Lab position"><button type="button" data-panel-dock="left" aria-pressed="false">Dock left</button><button type="button" data-panel-dock="right" aria-pressed="false">Dock right</button><button type="button" data-panel-dock="float" aria-pressed="true">Float</button></div>
<div class="panel-content">
<div class="meta"><span class="status" data-field="status">Motion stopped</span></div>
<div class="robot-stage" data-robot-stage></div>
<details class="measurements"><summary>Motion and buffer measurements</summary>
<dl>
<div><dt>Velocity v̂</dt><dd data-field="velocity"></dd></div>
<div><dt>Acceleration â</dt><dd data-field="acceleration"></dd></div>
<div><dt>Viewer fetch throughput</dt><dd data-field="throughput"></dd></div>
<div><dt>Measured load delay</dt><dd data-field="delay"></dd></div>
<div><dt>Ready distance</dt><dd data-field="distance"></dd></div>
<div><dt>Desired preload distance</dt><dd data-field="target"></dd></div>
<div><dt>Buffered time</dt><dd data-field="buffer"></dd></div>
<div><dt>Time margin</dt><dd class="margin" data-field="margin"></dd></div>
</dl>
<p class="explanation">Buffered time = ready distance / speed.<br>Time margin = buffered time − measured load delay.</p>
<p class="storage" data-field="document-paint"></p>
<p class="storage" data-field="cache"></p><p class="storage" data-field="byte-cache"></p><p class="storage" data-field="decoded-images"></p><p class="storage" data-field="image-work"></p><p class="storage" data-field="image-pixels"></p><p class="storage" data-field="disk-cache"></p><p class="storage" data-field="work"></p><p class="storage" data-field="transport"></p><p class="storage" data-field="total"></p>
<div class="graph">
<div class="legend"><span>Velocity; last 10 s</span><span data-field="speed-scale"></span></div>
<svg class="chart" viewBox="0 0 312 62" role="img" aria-label="Estimated scrolling velocity over the last ten seconds"><path class="axis" d="M4 31H308"/><path class="curve velocity" data-trace="velocity"/></svg>
<div class="legend"><span><span class="green">Buffered time</span>; <span class="orange">load delay</span></span><span data-field="time-scale"></span></div>
<svg class="chart" viewBox="0 0 312 62" role="img" aria-label="Buffered time and measured loading delay over the last ten seconds"><path class="axis" d="M4 58H308"/><path class="curve buffer" data-trace="buffer"/><path class="curve delay" data-trace="delay"/></svg>
</div>
<details><summary>Event buffer; <span data-field="event-count"></span></summary><pre data-field="events"></pre></details>
<footer><button type="button" class="copy">Copy measurements</button><span role="status" data-field="copy-status"></span></footer>
</details>
</div>
<button type="button" class="panel-resize" aria-label="Resize Motion Lab with arrow keys" title="Drag to resize; arrow keys change size">↘</button>
</section>`;
        root.querySelector<HTMLDetailsElement>('.measurements')!.open = !!win?.matchMedia('(min-width:701px) and (pointer:fine)').matches;
        for (const element of root.querySelectorAll<HTMLElement>('[data-field]')) {
            fields.set(element.dataset.field!, element);
        }
        root.querySelector('.close')!.addEventListener('click', toggle);
        root.querySelector('.copy')!.addEventListener('click', () => { void copySnapshot(); });
        (doc.body ?? doc.documentElement).append(host);
        robots = installPrefetchRobots(root.querySelector<HTMLElement>('[data-robot-stage]')!);
        panel = installMotionLabPanel(host, {
            surface: root.querySelector<HTMLElement>('section')!,
            dragHandle: root.querySelector<HTMLElement>('.panel-drag')!,
            resizeHandle: root.querySelector<HTMLElement>('.panel-resize')!,
            dockButtons: {
                left: root.querySelector<HTMLButtonElement>('[data-panel-dock="left"]')!,
                right: root.querySelector<HTMLButtonElement>('[data-panel-dock="right"]')!,
                float: root.querySelector<HTMLButtonElement>('[data-panel-dock="float"]')!,
            },
            onLayout: options.onPanelLayout,
        });
    }

    function setEnabled(enabled: boolean): void {
        if (disposed || !win || !doc.createElement) { return; }
        if (shown === enabled) { return; }
        shown = enabled;
        measurementsButton?.setAttribute('aria-expanded', String(shown));
        if (shown) {
            previousFocus = doc.activeElement;
            if (!host) { createPanel(); }
            host!.hidden = false;
            panel?.setVisible(true);
            if (disposed || !shown) { return; }
            startTimer();
            options.onOpen?.();
            if (disposed || !shown) { return; }
            if (options.measurementsMenu) { root!.querySelector<HTMLButtonElement>('.close')?.focus({ preventScroll: true }); }
        } else {
            const restoreFocus = doc.activeElement === host;
            stopTimer();
            panel?.setVisible(false);
            if (disposed || shown) { return; }
            host!.hidden = true;
            history.length = 0;
            if (restoreFocus) {
                const focus = measurementsButton?.getClientRects().length ? measurementsButton
                    : doc.getElementById('toolbarMoreToggle') ?? doc.getElementById('secondaryToolbarToggleButton') ?? previousFocus as HTMLElement | null;
                focus?.focus?.({ preventScroll: true });
            }
        }
    }

    function toggle(): void { setEnabled(!shown); }

    function setRobotsEnabled(enabled: boolean): void {
        if (disposed) { return; }
        options.robots?.setEnabled(enabled);
        const active = options.robots?.enabled ?? false;
        button?.setAttribute('aria-pressed', String(active));
        if (button) { button.title = active ? 'Turn off document robots' : 'Turn on document robots'; }
    }

    function toggleRobots(): void { setRobotsEnabled(!options.robots?.enabled); }

    function keydown(event: KeyboardEvent): void {
        if (shown && event.key === 'Escape' && event.composedPath().includes(host!)) {
            event.preventDefault();
            toggle();
        }
    }

    function visibility(): void {
        if (doc.hidden) {
            stopTimer();
            history.length = 0;
        } else {
            startTimer();
        }
    }

    doc?.addEventListener?.('keydown', keydown, true);
    doc?.addEventListener?.('visibilitychange', visibility);
    if (options.toolbar) {
        button = doc.createElement('button');
        button.id = 'pdf-prefetch-toggle';
        button.type = 'button';
        button.className = 'pdf-prefetch-toggle toolbarButton';
        button.title = options.robots?.enabled ? 'Turn off document robots' : 'Turn on document robots';
        button.setAttribute('aria-label', 'Document robots');
        button.setAttribute('aria-controls', container.id || 'viewerContainer');
        button.setAttribute('aria-pressed', String(options.robots?.enabled ?? false));
        button.innerHTML = ROBOT_ICON;
        button.addEventListener('click', toggleRobots);
        if (options.toolbarBefore) { options.toolbar.insertBefore(button, options.toolbarBefore); }
        else { options.toolbar.append(button); }

        measurementsButton = doc.createElement('button');
        measurementsButton.id = 'pdf-prefetch-measurements';
        measurementsButton.type = 'button';
        measurementsButton.className = 'pdf-prefetch-toggle toolbarButton' + (options.measurementsMenu ? ' labeled' : '');
        measurementsButton.title = 'Open LARICS Motion Lab';
        measurementsButton.setAttribute('aria-label', 'LARICS Motion Lab');
        measurementsButton.setAttribute('aria-controls', 'pdf-prefetch-diagnostics');
        measurementsButton.setAttribute('aria-expanded', 'false');
        measurementsButton.innerHTML = MEASUREMENTS_ICON + (options.measurementsMenu ? '<span>LARICS Motion Lab</span>' : '');
        measurementsButton.addEventListener('click', toggle);
        (options.measurementsMenu ?? options.toolbar).append(measurementsButton);
    }
    if (options.enabled === true) { setEnabled(true); }
    return {
        toggle,
        setEnabled,
        get enabled() { return shown; },
        setRobotsEnabled,
        get robotsEnabled() { return options.robots?.enabled ?? false; },
        labSnapshot: () => robots?.snapshot(),
        dispose(): void {
            if (disposed) { return; }
            disposed = true;
            stopTimer();
            panel?.dispose();
            panel = undefined;
            doc?.removeEventListener?.('keydown', keydown, true);
            doc?.removeEventListener?.('visibilitychange', visibility);
            robots?.dispose();
            robots = undefined;
            host?.remove();
            button?.removeEventListener('click', toggleRobots);
            button?.remove();
            button = undefined;
            measurementsButton?.removeEventListener('click', toggle);
            measurementsButton?.remove();
            measurementsButton = undefined;
            shown = false;
            host = root = undefined;
            fields.clear();
            history.length = 0;
        },
    };
}
