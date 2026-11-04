import { installPrefetchRobots, type RobotLab } from './prefetch-robots';

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

    constructor(private readonly now: () => number = () => performance.now()) {
        this.startedAt = now();
    }

    get pendingFetchCount(): number { return this.activeFetches.size; }

    /** Constant-time admission signal; reading this does not copy diagnostic history. */
    get oldestFetchMs(): number { return this.ageOfOldestFetch(this.now()); }

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
        };
    }

    reset(): void {
        this.events.clear();
        this.transfers.clear();
        this.activeFetches.clear();
        this.eventCount = this.fetchBytes = this.fetchCount = this.fetchDurationMs = this.fetchLastDurationMs = 0;
        this.firstFetchAt = Infinity;
        this.startedAt = this.now();
        this.notifyFetchChange();
    }
}

export const pdfPerformance = new PdfPerformance();

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
    starved?: boolean;
    visibleMissing?: readonly number[];
    fetchBackpressure?: boolean;
    performance?: ReturnType<PdfPerformance['snapshot']>;
}

interface TraceSample {
    at: number;
    velocity: number;
    buffer: number | null;
    delay: number;
}

/**
 * Ctrl+Alt+Shift+R opens the motion lab. The normal viewer creates neither dashboard DOM nor
 * a sampling timer. Closing it or hiding the document stops its timer.
 */
export function installPrefetchDiagnostics(container: HTMLElement, sample: () => PrefetchDiagnosticSample) {
    const doc = container.ownerDocument;
    const win = doc?.defaultView;
    let host: HTMLDivElement | undefined;
    let root: ShadowRoot | undefined;
    let timer: number | undefined;
    let robots: RobotLab | undefined;
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
        field('cache', `${state.previewPages} previews · ${format(state.previewBytes / (1024 * 1024), 1)} MiB preview · ${format(state.canvasBytes / (1024 * 1024), 1)} MiB canvas`);
        field('work', `${state.pending.length} preparing · ${state.prepared.length} preview targets · ${state.renderAhead.length} render targets · ${state.failed.length} failed`);
        field('total', `${format(metrics.fetchBytes / (1024 * 1024), 1)} MiB received · ${format(metrics.fetchCount)} fetches`);
        field('transport', `${metrics.pendingFetchCount} fetches in flight · oldest ${format(metrics.oldestFetchMs)} ms${state.fetchBackpressure ? ' · cold-page admission paused' : ''}`);
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
            timer = win.setInterval(tick, PERFORMANCE_LIMITS.refreshMs);
        }
    }

    async function copySnapshot(): Promise<void> {
        const { performance: measured, ...viewer } = sample();
        const text = JSON.stringify({ viewer, performance: measured ?? pdfPerformance.snapshot(), robots: robots?.snapshot() }, null, 2);
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
:host { all:initial; position:fixed; right:14px; bottom:14px; z-index:2147483647; display:block; color:#e8f0fa; font:12px/1.4 system-ui,sans-serif; color-scheme:dark; }
:host([hidden]) { display:none !important; }
* { box-sizing:border-box; }
section { width:456px; max-width:calc(100vw - 28px); max-height:calc(100vh - 28px); overflow:auto; padding:14px; border:1px solid #43566b; border-radius:12px; background:#101c2b; box-shadow:0 8px 36px #0007; }
header { display:flex; align-items:center; gap:9px; }
.robot { flex:none; width:25px; height:25px; color:#66e5cf; }
h2 { flex:1; margin:0; font-size:14px; font-weight:650; letter-spacing:.02em; }
button { border:1px solid #4b6178; border-radius:5px; color:inherit; background:#203248; padding:5px 8px; cursor:pointer; font:inherit; }
button:hover { background:#30485f; } button:focus-visible { outline:2px solid #66e5cf; outline-offset:2px; }
.close { padding:0 6px; font-size:19px; }
.meta { display:flex; justify-content:space-between; align-items:center; gap:6px; margin-top:9px; font-size:10px; color:#b2c0cf; }
.status { color:#66e5cf; font-size:11px; } .status[data-state="idle"] { color:#b2c0cf; } .status[data-state="late"] { color:#ffb68c; }
.robot-stage { margin-top:11px; border:1px solid #345069; border-radius:8px; overflow:hidden; background:#0b1424; contain:layout paint; pointer-events:none; }
.robot-canvas { display:block; width:100%; aspect-ratio:480 / 250; }
.robot-caption { min-height:32px; padding:7px 10px 1px; color:#d0e2f0; font-size:11px; line-height:1.4; }
.robot-activity { padding:3px 10px 8px; color:#849eb5; font:9px/1.3 ui-monospace,monospace; }
dl { display:grid; grid-template-columns:1fr 1fr; gap:9px 14px; margin:13px 0; }
dt { color:#b2c0cf; font-size:10px; } dd { margin:1px 0 0; font:600 15px/1.3 ui-monospace,monospace; white-space:nowrap; }
.margin { color:#66e5cf; } p { margin:5px 0; } .explanation,.storage,.foot { color:#b2c0cf; font-size:10px; }
.graph { border-top:1px solid #304359; margin-top:10px; padding-top:7px; }
.legend { display:flex; justify-content:space-between; gap:5px; color:#b2c0cf; font-size:10px; }
svg.chart { display:block; width:100%; height:62px; overflow:visible; }
.axis { stroke:#34455b; stroke-width:1; } .curve { fill:none; stroke-width:1.7; stroke-linejoin:round; stroke-linecap:round; }
.velocity { stroke:#acb8ff; } .buffer { stroke:#66e5cf; } .delay { stroke:#ffba7a; } .green { color:#66e5cf; } .orange { color:#ffba7a; }
details { margin-top:9px; border-top:1px solid #304359; padding-top:7px; }
summary { cursor:pointer; font-size:10px; color:#b2c0cf; }
pre { font:9px/1.5 ui-monospace,monospace; margin:6px 0 0; max-height:78px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
footer { display:flex; align-items:center; gap:8px; margin-top:10px; }
footer span { font-size:10px; color:#b2c0cf; }
</style>
<section role="region" aria-label="PDF motion diagnostics">
<header>
<svg class="robot" viewBox="0 0 28 28" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3v4M7 11H4v10h20V11h-3M9 7h10v14H9zM11 24h6"/><path d="M12 12v2m4-2v2m-4 4h4"/></g><circle cx="14" cy="3" r="1.5" fill="currentColor"/></svg>
<h2>LARICS motion lab</h2><button class="close" type="button" aria-label="Close motion diagnostics">×</button>
</header>
<div class="meta"><span class="status" data-field="status">Motion stopped</span><span>Ctrl+Alt+Shift+R</span></div>
<div class="robot-stage" data-robot-stage></div>
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
<p class="storage" data-field="cache"></p><p class="storage" data-field="work"></p><p class="storage" data-field="transport"></p><p class="storage" data-field="total"></p>
<div class="graph">
<div class="legend"><span>Velocity · last 10 s</span><span data-field="speed-scale"></span></div>
<svg class="chart" viewBox="0 0 312 62" role="img" aria-label="Estimated scrolling velocity over the last ten seconds"><path class="axis" d="M4 31H308"/><path class="curve velocity" data-trace="velocity"/></svg>
<div class="legend"><span><span class="green">Buffered time</span> · <span class="orange">load delay</span></span><span data-field="time-scale"></span></div>
<svg class="chart" viewBox="0 0 312 62" role="img" aria-label="Buffered time and measured loading delay over the last ten seconds"><path class="axis" d="M4 58H308"/><path class="curve buffer" data-trace="buffer"/><path class="curve delay" data-trace="delay"/></svg>
</div>
<details><summary>Event buffer · <span data-field="event-count"></span></summary><pre data-field="events"></pre></details>
<footer><button type="button" class="copy">Copy measurements</button><span role="status" data-field="copy-status"></span></footer>
</section>`;
        for (const element of root.querySelectorAll<HTMLElement>('[data-field]')) {
            fields.set(element.dataset.field!, element);
        }
        root.querySelector('.close')!.addEventListener('click', toggle);
        root.querySelector('.copy')!.addEventListener('click', () => { void copySnapshot(); });
        (doc.body ?? doc.documentElement).append(host);
        robots = installPrefetchRobots(root.querySelector<HTMLElement>('[data-robot-stage]')!);
    }

    function toggle(): void {
        if (disposed || !win || !doc.createElement) { return; }
        shown = !shown;
        if (shown) {
            previousFocus = doc.activeElement;
            if (!host) { createPanel(); }
            host!.hidden = false;
            startTimer();
        } else {
            stopTimer();
            host!.hidden = true;
            history.length = 0;
            if (doc.activeElement === host) { (previousFocus as HTMLElement | null)?.focus?.({ preventScroll: true }); }
        }
    }

    function keydown(event: KeyboardEvent): void {
        if (!event.repeat && !event.isComposing && event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey && (event.code === 'KeyR' || event.key.toLowerCase() === 'r')) {
            event.preventDefault();
            event.stopPropagation();
            toggle();
        } else if (shown && event.key === 'Escape' && event.composedPath().includes(host!)) {
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
    return {
        toggle,
        dispose(): void {
            if (disposed) { return; }
            disposed = true;
            stopTimer();
            doc?.removeEventListener?.('keydown', keydown, true);
            doc?.removeEventListener?.('visibilitychange', visibility);
            robots?.dispose();
            robots = undefined;
            host?.remove();
            host = root = undefined;
            fields.clear();
            history.length = 0;
        },
    };
}
