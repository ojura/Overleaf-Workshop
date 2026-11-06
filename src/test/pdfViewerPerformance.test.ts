import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// tsc turns import() into require(), which cannot load ES modules.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('PDF prefetch performance measurements', function () {
    this.timeout(30 * 1000);
    let dir: string;
    let performanceModule: any;
    let contentModule: any;

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-performance-'));
        try {
            await esbuild.build({
                ...bundleOptions,
                entryPoints: [path.join(viewerRoot, 'src', 'common', 'prefetch-performance.ts')],
                outfile: path.join(dir, 'performance.mjs'),
            });
            performanceModule = await importModule(path.join(dir, 'performance.mjs'));
            await esbuild.build({
                ...bundleOptions,
                entryPoints: [path.join(viewerRoot, 'src', 'common', 'prefetch-performance.ts')],
                outfile: path.join(dir, 'content.mjs'),
                plugins: [{ name: 'diagnostic-content-boundary', setup(build: any) {
                    build.onResolve({ filter: /^\.\/(prefetch-robots|motion-lab-panel)$/ }, (args: any) =>
                        ({ path: args.path, namespace: 'diagnostic-content-boundary' }));
                    build.onLoad({ filter: /.*/, namespace: 'diagnostic-content-boundary' }, (args: any) => ({
                        contents: args.path.endsWith('prefetch-robots')
                            ? 'export function installPrefetchRobots() { return globalThis.__motionDiagnosticsHarness.lab; }'
                            : 'export { MOTION_LAB_RESIZE_HANDLES } from '
                                + JSON.stringify(path.join(viewerRoot, 'src', 'common', 'motion-lab-panel.ts')) + ';'
                                + 'export function installMotionLabPanel(host, options) {'
                                + ' return globalThis.__motionDiagnosticsHarness.installPanel(host, options); }',
                        loader: 'js',
                        resolveDir: repo,
                    }));
                } }],
            });
            contentModule = await importModule(path.join(dir, 'content.mjs'));
        } finally {
            await esbuild.stop();
        }
    });

    after(() => {
        if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    function contentFixture(options: { storage?: Map<string, string>; storageFails?: boolean;
        preference?: { whenReady?(): Promise<void>; read(): boolean | undefined; write(open: boolean): void | Promise<void> };
        visible?: boolean; onOpen?: () => void; rangeCache?: Record<string, number> } = {}) {
        const listeners = new Map<string, Set<() => void>>();
        const timers = new Map<number, () => void>();
        const storage = options.storage ?? new Map<string, string>();
        const reads: string[] = [], writes: Array<[string, string]> = [];
        const refreshes: any[] = [], heights: Array<number | undefined> = [];
        const observers: Observer[] = [];
        const document: any = { hidden: !options.visible, activeElement: null,
            addEventListener(name: string, listener: () => void) {
                if (!listeners.has(name)) { listeners.set(name, new Set()); } listeners.get(name)!.add(listener);
            },
            removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); },
        };
        let panelOptions: any, host: ElementNode, rectangleReads = 0, invalidations = 0;
        let currentWidth = 456, forcedHeight = 700, extraHeight = 0, failMeasurement = false;
        class ElementNode {
            ownerDocument = document;
            id = ''; hidden = false; open = false; scrollTop = 0; scrollLeft = 0; textContent = '';
            style: Record<string, string> = {};
            dataset: Record<string, string> = {};
            attributes = new Map<string, string>();
            handlers = new Map<string, Set<() => void>>();
            children: ElementNode[] = [];
            shadow: any;
            constructor(readonly selector = '') {}
            append(...children: ElementNode[]) { this.children.push(...children); }
            remove() {}
            setAttribute(name: string, value: string) { this.attributes.set(name, value); }
            getAttribute(name: string) { return this.attributes.get(name) ?? null; }
            addEventListener(name: string, callback: () => void) {
                if (!this.handlers.has(name)) { this.handlers.set(name, new Set()); } this.handlers.get(name)!.add(callback);
            }
            removeEventListener(name: string, callback: () => void) { this.handlers.get(name)?.delete(callback); }
            emit(name: string) { for (const callback of [...this.handlers.get(name) ?? []]) { callback(); } }
            getBoundingClientRect() {
                rectangleReads++;
                const section = host.shadow.querySelector('section');
                const width = section.style.width?.endsWith('px') ? parseFloat(section.style.width) : currentWidth;
                const content = host.shadow.querySelector('.panel-content');
                const measurements = host.shadow.querySelector('.measurements');
                let top = 100, height = forcedHeight;
                if (this.selector === '.panel-content-flow') {
                    if (failMeasurement) { throw new Error('detached layout'); }
                    // The actual flow remains intrinsic when its scroll viewport is shorter or taller.
                    top += 15 + 28 + 9 + (width < 360 ? 72 : 36) - content.scrollTop;
                    height = (measurements.open ? 620 : 240) + (width < 400 ? 60 : 0) + extraHeight + 0.25;
                }
                return { x: 500, y: top, left: 500, top, right: 500 + width, bottom: top + height, width, height };
            }
            attachShadow() {
                const nodes = new Map<string, ElementNode>();
                const lookup = (selector: string) => {
                    if (!nodes.has(selector)) { nodes.set(selector, new ElementNode(selector)); }
                    return nodes.get(selector)!;
                };
                const fields = ['margin', 'status', 'reading-images'].map(name => {
                    const node = lookup('[data-field="' + name + '"]'); node.dataset.field = name; return node;
                });
                return this.shadow = { innerHTML: '', querySelector: lookup, querySelectorAll: () => fields };
            }
        }
        class Observer {
            targets = new Set<ElementNode>();
            disconnected = false;
            constructor(readonly callback: (entries: any[]) => void) { observers.push(this); }
            observe(target: ElementNode) { this.targets.add(target); this.disconnected = false; }
            disconnect() { this.targets.clear(); this.disconnected = true; }
            fire() { this.callback([...this.targets].map(target => ({ target,
                contentRect: { width: currentWidth, height: extraHeight + 240 } }))); }
        }
        const panel = {
            setVisible(visible: boolean) { if (visible) { heights.push(panelOptions.measureContentHeight?.(currentWidth)); } },
            refreshContent(value?: any) { refreshes.push(value); panelOptions.onGeometryChange();
                heights.push(panelOptions.measureContentHeight?.(currentWidth)); },
            dispose() {},
        };
        (globalThis as any).__motionDiagnosticsHarness = {
            lab: { invalidateGeometry() { invalidations++; }, setActive() {}, update() {}, dispose() {}, snapshot: () => ({}) },
            installPanel(createdHost: ElementNode, value: any) { host = createdHost; panelOptions = value; return panel; },
        };
        document.body = new ElementNode();
        document.createElement = () => new ElementNode();
        document.defaultView = {
            matchMedia: () => ({ matches: true }),
            getComputedStyle: (element: ElementNode) => ({
                paddingBottom: element.selector === 'section' ? '14px' : '0px',
                borderBottomWidth: element.selector === 'section' ? '1px' : '0px',
            }),
            get localStorage() {
                if (options.storageFails) { throw new Error('Storage is disabled'); }
                return { getItem(key: string) { reads.push(key); return storage.get(key) ?? null; },
                    setItem(key: string, value: string) { writes.push([key, value]); storage.set(key, value); } };
            },
            setInterval(callback: () => void) { const id = timers.size + 1; timers.set(id, callback); return id; },
            clearInterval(id: number) { timers.delete(id); },
        };
        document.defaultView['ResizeObserver'] = Observer;
        const diagnostics = contentModule.installPrefetchDiagnostics(new ElementNode(), () => ({
            direction: 0, velocityPxPerMs: 0, accelerationPxPerMs2: 0, pageLatencyMs: 0,
            preloadPx: 0, readyDistancePx: 0, safetySeconds: null, bufferSeconds: null,
            visible: [], renderAhead: [], prepared: [], pending: [], failed: [],
            previewPages: 0, previewBytes: 0, canvasBytes: 0, rangeCache: options.rangeCache,
        }), { measurementsPreference: options.preference, onOpen: options.onOpen });
        return { diagnostics, storage, reads, writes, refreshes, heights, observers, timers,
            get host() { return host; }, get panelOptions() { return panelOptions; },
            get rectangleReads() { return rectangleReads; }, get invalidations() { return invalidations; },
            node: (selector: string) => host.shadow.querySelector(selector) as ElementNode,
            setWidth(value: number) { currentWidth = value; }, setForcedHeight(value: number) { forcedHeight = value; },
            setHidden(value: boolean) { document.hidden = value; for (const listener of listeners.get('visibilitychange') ?? []) { listener(); } },
            grow(value: number) { extraHeight = value; }, failMeasurement(value: boolean) { failMeasurement = value; },
            dispose() { diagnostics.dispose(); delete (globalThis as any).__motionDiagnosticsHarness; },
        };
    }

    it('defaults the native measurements disclosure to collapsed and persists only subsequent changes', () => {
        const fixture = contentFixture();
        let key = '';
        try {
            assert.deepStrictEqual(fixture.reads, [], 'closed diagnostics do not access storage');
            fixture.diagnostics.setEnabled(true);
            const details = fixture.node('.measurements');
            assert.strictEqual(details.open, false, 'desktop creation also defaults collapsed');
            assert.strictEqual(fixture.heights[0], 344, 'the preference is applied before the first content measurement');
            assert.strictEqual(fixture.reads.length, 1); key = fixture.reads[0];
            details.emit('toggle');
            assert.deepStrictEqual(fixture.writes, [], 'initialization is not a preference change');
            details.open = true; details.emit('toggle');
            assert.deepStrictEqual(fixture.writes, [[key, 'true']]);
            assert.deepStrictEqual(fixture.refreshes, [{ fit: true }]);
            assert.strictEqual(fixture.heights.at(-1), 724);
            assert.match(fixture.host.shadow.innerHTML, /<details class="measurements"><summary>/,
                'the disclosure keeps native details and summary semantics');
            assert.match(fixture.host.shadow.innerHTML, /Expand/);
            assert.match(fixture.host.shadow.innerHTML, /Collapse/);
        } finally { fixture.dispose(); }
        const recreated = contentFixture({ storage: fixture.storage });
        try {
            recreated.diagnostics.setEnabled(true);
            const details = recreated.node('.measurements');
            assert.strictEqual(details.open, true);
            assert.strictEqual(recreated.heights[0], 724);
            details.emit('toggle');
            assert.deepStrictEqual(recreated.writes, []);
            details.open = false; details.emit('toggle');
            assert.deepStrictEqual(recreated.writes, [[key, 'false']]);
            assert.deepStrictEqual(recreated.refreshes, [{ fit: false }], 'closing does not request growth to fit');
            assert.strictEqual(recreated.heights.at(-1), 344);
        } finally { recreated.dispose(); }
    });

    it('reads an injected preference lazily and keeps disclosure controls usable when storage fails', async () => {
        let saved: boolean | undefined;
        let reads = 0;
        const writes: boolean[] = [];
        const fixture = contentFixture({ storageFails: true, preference: {
            read() { reads++; return saved; }, write(value) { writes.push(value); },
        } });
        try {
            assert.strictEqual(reads, 0);
            saved = true;
            fixture.diagnostics.setEnabled(true);
            assert.strictEqual(reads, 1);
            assert.strictEqual(fixture.node('.measurements').open, true);
            fixture.node('.measurements').emit('toggle');
            assert.deepStrictEqual(writes, []);
            fixture.node('.measurements').open = false; fixture.node('.measurements').emit('toggle');
            assert.deepStrictEqual(writes, [false]);
            assert.deepStrictEqual(fixture.reads, []);
        } finally { fixture.dispose(); }
        for (const preference of [undefined, { read(): boolean { throw new Error('read unavailable'); },
            write() { throw new Error('write unavailable'); } }, { read: () => false,
            write: () => Promise.reject(new Error('asynchronous write unavailable')) }]) {
            const denied = contentFixture({ storageFails: true, preference });
            try {
                assert.doesNotThrow(() => denied.diagnostics.setEnabled(true));
                const details = denied.node('.measurements');
                assert.strictEqual(details.open, false);
                details.open = true;
                assert.doesNotThrow(() => details.emit('toggle'));
                assert.deepStrictEqual(denied.refreshes, [{ fit: true }]);
                await new Promise<void>(resolve => setImmediate(resolve));
            } finally { denied.dispose(); }
        }
    });

    it('waits for late host preferences before first measurement and fences cancelled open requests', async () => {
        for (const cancel of [undefined, 'close', 'dispose'] as const) {
            let ready!: () => void, opened!: () => void, saved: boolean | undefined;
            let reads = 0;
            const waiting = new Promise<void>(resolve => { ready = resolve; });
            const visible = new Promise<void>(resolve => { opened = resolve; });
            const fixture = contentFixture({ preference: {
                whenReady: () => waiting,
                read() { reads++; return saved; },
                write() { assert.fail('initial saved state must not be written back'); },
            }, onOpen: opened });
            try {
                fixture.diagnostics.setEnabled(true);
                await Promise.resolve();
                assert.strictEqual(fixture.host, undefined, 'no collapsed panel flashes before saved state arrives');
                assert.strictEqual(reads, 0);
                fixture.setHidden(false);
                assert.strictEqual(fixture.timers.size, 0, 'visibility cannot start sampling before the pending panel exists');
                if (cancel === 'close') { fixture.diagnostics.setEnabled(false); }
                if (cancel === 'dispose') { fixture.diagnostics.dispose(); }
                saved = true; ready();
                if (!cancel) {
                    await visible;
                    assert.strictEqual(fixture.node('.measurements').open, true);
                    assert.strictEqual(fixture.heights[0], 724);
                    assert.strictEqual(reads, 1);
                } else {
                    await new Promise<void>(resolve => setImmediate(resolve));
                    assert.strictEqual(fixture.host, undefined);
                    assert.strictEqual(fixture.diagnostics.enabled, false);
                    assert.strictEqual(reads, 0);
                    assert.strictEqual(fixture.timers.size, 0);
                }
            } finally { fixture.dispose(); }
        }
        let opened!: () => void;
        const visible = new Promise<void>(resolve => { opened = resolve; });
        const failed = contentFixture({ preference: {
            whenReady: () => Promise.reject(new Error('host unavailable')),
            read() { assert.fail('failed readiness uses the chosen collapsed default'); },
            write() { assert.fail('fallback must not overwrite the unavailable saved state'); },
        }, onOpen: opened });
        try {
            failed.diagnostics.setEnabled(true);
            await visible;
            assert.strictEqual(failed.node('.measurements').open, false);
            assert.strictEqual(failed.heights[0], 344);
        } finally { failed.dispose(); }
    });

    it('measures natural height at the proposed width without forced-height or scroll feedback', () => {
        const fixture = contentFixture();
        try {
            fixture.diagnostics.setEnabled(true);
            const surface = fixture.node('section'), content = fixture.node('.panel-content');
            Object.assign(surface.style, { width: '100%', maxWidth: 'none', height: '100%' });
            content.style.overflow = 'auto'; content.scrollTop = 73; content.scrollLeft = 9;
            const styles = { ...surface.style }, contentStyles = { ...content.style };
            const measure = fixture.panelOptions.measureContentHeight;
            assert.strictEqual(typeof measure, 'function');
            assert.strictEqual(measure(456), 344);
            assert.strictEqual(measure(300), 440, 'narrow positioning controls and content wrap naturally');
            fixture.setForcedHeight(180);
            assert.strictEqual(measure(456), 344, 'short scroll viewport cannot cap intrinsic content');
            fixture.setForcedHeight(900);
            assert.strictEqual(measure(456), 344, 'a tall forced window cannot manufacture useful content');
            assert.deepStrictEqual(surface.style, styles);
            assert.deepStrictEqual(content.style, contentStyles);
            assert.strictEqual(content.scrollTop, 73); assert.strictEqual(content.scrollLeft, 9);
            fixture.failMeasurement(true);
            assert.strictEqual(measure(300), undefined, 'detached/unavailable layout leaves the controller usable');
            assert.deepStrictEqual(surface.style, styles);
            assert.deepStrictEqual(content.style, contentStyles);
            assert.strictEqual(content.scrollTop, 73); assert.strictEqual(content.scrollLeft, 9);
        } finally { fixture.dispose(); }
    });

    it('refreshes from intrinsic changes rather than metric ticks and fences closed/disposed observers', () => {
        const fixture = contentFixture({ visible: true });
        try {
            fixture.diagnostics.setEnabled(true);
            assert.strictEqual(fixture.observers.length, 1);
            const observer = fixture.observers[0];
            assert.deepStrictEqual([...observer.targets].map(target => target.selector).sort(),
                ['.panel-content-flow', '.panel-position', 'header'].sort());
            const beforeTickReads = fixture.rectangleReads;
            for (let index = 0; index < 5; index++) { for (const callback of fixture.timers.values()) { callback(); } }
            assert.strictEqual(fixture.rectangleReads, beforeTickReads, 'sampling does not read content geometry');
            fixture.grow(40); observer.fire();
            assert.deepStrictEqual(fixture.refreshes, [undefined]);
            assert.strictEqual(fixture.heights.at(-1), 384);
            const refreshCount = fixture.refreshes.length;
            fixture.diagnostics.setEnabled(false);
            assert.ok(observer.disconnected);
            observer.fire();
            assert.strictEqual(fixture.refreshes.length, refreshCount);
            fixture.diagnostics.setEnabled(true);
            assert.ok(!observer.disconnected);
            fixture.dispose();
            observer.fire();
            assert.strictEqual(fixture.refreshes.length, refreshCount);
            assert.ok(observer.disconnected);
            assert.strictEqual(fixture.timers.size, 0);
            assert.strictEqual(fixture.node('.measurements').handlers.get('toggle')?.size, 0);
        } finally { fixture.dispose(); }
    });

    it('keeps the newest bounded event history in chronological order', () => {
        let now = 0;
        const recorder = new performanceModule.PdfPerformance(() => now);
        const capacity = performanceModule.PERFORMANCE_LIMITS.eventCapacity;
        for (let index = 0; index < capacity + 7; index++) {
            now = index;
            recorder.event('prepare', { page: index + 1 });
        }
        const snapshot = recorder.snapshot();
        assert.strictEqual(snapshot.events.length, capacity);
        assert.strictEqual(snapshot.eventCount, capacity + 7);
        assert.strictEqual(snapshot.droppedEvents, 7);
        assert.strictEqual(snapshot.events[0].data.page, 8);
        assert.strictEqual(snapshot.events.at(-1).data.page, capacity + 7);
        assert.ok(snapshot.events.every((event: any, index: number, events: any[]) =>
            index === 0 || event.sequence > events[index - 1].sequence));
    });

    it('shows partial-state and final-native ownership from the existing worker snapshot', () => {
        const mib = 1024 * 1024;
        const rangeCache = { externalImageBudgetBytes: 64 * mib, externalImageReservedBytes: 6 * mib,
            externalImagePartialRasterBytes: mib, externalImageNativeRasterBytes: 7 * mib,
            externalImageActive: 1, externalImageQueued: 3, externalImagePaused: 2 };
        const fixture = contentFixture({ visible: true, rangeCache });
        try {
            fixture.diagnostics.setEnabled(true);
            const text = fixture.node('[data-field="reading-images"]').textContent;
            assert.match(text, /1 active; 3 queued; 2 paused/);
            assert.match(text, /64 MiB incremental state/);
            assert.match(text, /MiB partial pixels/);
            assert.match(text, /MiB final native pixels/);
            assert.strictEqual(fixture.timers.size, 1, 'the existing visible-panel timer owns all diagnostics');
            fixture.diagnostics.setEnabled(false);
            assert.strictEqual(fixture.timers.size, 0);
        } finally { fixture.dispose(); }
    });

    it('retains reading bytes and native pass costs across event-ring rollover and clears them on reset', () => {
        const recorder = new performanceModule.PdfPerformance(() => 10);
        recorder.event('reading-transfer', { kind: 'manifest', bytes: 100 });
        recorder.event('reading-transfer', { kind: 'pdf', bytes: 300 });
        recorder.event('reading-transfer', { kind: 'image', bytes: 500 });
        recorder.event('reading-transfer-error', { kind: 'image', bytes: 200, cancelled: true });
        recorder.event('image-pass', { ms: 3, firstCoverage: true, firstFinal: false });
        recorder.event('image-pass', { ms: 5, firstCoverage: false, firstFinal: true });
        for (let i = 0; i < performanceModule.PERFORMANCE_LIMITS.eventCapacity; i++) { recorder.event('frame'); }
        const value = recorder.snapshot().reading;
        assert.deepStrictEqual(value, { manifestBytes: 100, pdfBytes: 300, imageBytes: 700,
            imageTransfers: 2, failedTransfers: 1, passes: 2, coveredPages: 1, finalPages: 1, passTotalMs: 8, passMaxMs: 5 });
        value.imageBytes = 0;
        assert.strictEqual(recorder.snapshot().reading.imageBytes, 700);
        assert.ok(recorder.snapshot().events.every((event: any) => event.type === 'frame'));
        recorder.reset();
        assert.ok(Object.values(recorder.snapshot().reading).every(value => value === 0));
    });

    it('copies event data so callers cannot rewrite recorded measurements', () => {
        const recorder = new performanceModule.PdfPerformance(() => 10);
        const data = { page: 2, elapsedMs: 7 };
        recorder.event('preview-ready', data);
        data.page = 9;
        const snapshot = recorder.snapshot();
        assert.strictEqual(snapshot.events[0].data.page, 2);
        snapshot.events[0].data.page = 20;
        snapshot.events[0].type = 'changed';
        assert.strictEqual(recorder.snapshot().events[0].data.page, 2);
        assert.strictEqual(recorder.snapshot().events[0].type, 'preview-ready');
    });

    it('keeps one copy-safe numeric disk-cache report and clears it with the document', () => {
        const recorder = new performanceModule.PdfPerformance(() => 10);
        const progress = { storedBytes: 256, totalBytes: 1024, diskBytes: 512, budgetBytes: 4096, filling: true, complete: false, url: 'not telemetry' };
        recorder.setDiskCache(progress);
        progress.storedBytes = 999;
        const saved = recorder.snapshot().diskCache;
        assert.deepStrictEqual(saved, { storedBytes: 256, totalBytes: 1024, diskBytes: 512, budgetBytes: 4096, filling: true, complete: false });
        saved.storedBytes = 777;
        assert.strictEqual(recorder.snapshot().diskCache.storedBytes, 256);
        recorder.setDiskCache({ ...progress, totalBytes: NaN });
        assert.strictEqual(recorder.snapshot().diskCache.totalBytes, 1024);
        recorder.reset();
        assert.strictEqual(recorder.snapshot().diskCache, undefined);
    });

    it('measures overlapping transfers over their shared elapsed time and ages them out', () => {
        let now = 2000;
        const recorder = new performanceModule.PdfPerformance(() => now);
        const mib = 1024 * 1024;
        recorder.fetch(mib, 1000);
        recorder.fetch(mib, 1000);
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 2);

        now = 3000;
        recorder.fetch(2 * mib, 2000);
        const snapshot = recorder.snapshot();
        assert.strictEqual(snapshot.fetchMiBPerSecond, 2);
        assert.strictEqual(snapshot.fetchBytes, 4 * mib);
        assert.strictEqual(snapshot.fetchCount, 3);

        now = 7000;
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 0.2);
        now = 8000;
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 0);
        assert.strictEqual(recorder.snapshot().fetchBytes, 4 * mib);
    });

    it('uses a long transfer\'s measured duration instead of reporting all its bytes in the last window', () => {
        const recorder = new performanceModule.PdfPerformance(() => 20000);
        recorder.fetch(20 * 1024 * 1024, 20000);
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 1);
    });

    it('rejects invalid transfer samples and keeps instantaneous completions finite', () => {
        const recorder = new performanceModule.PdfPerformance(() => 0);
        for (const [bytes, elapsed] of [[NaN, 1], [Infinity, 1], [-1, 1], [0, 1], [1, -1], [1, NaN], [1, Infinity]]) {
            recorder.fetch(bytes, elapsed);
        }
        assert.strictEqual(recorder.snapshot().fetchCount, 0);
        recorder.fetch(1024, 0);
        const snapshot = recorder.snapshot();
        assert.strictEqual(snapshot.fetchBytes, 1024);
        assert.strictEqual(snapshot.fetchCount, 1);
        assert.ok(Number.isFinite(snapshot.fetchMiBPerSecond));
        assert.ok(snapshot.fetchMiBPerSecond > 0);
    });

    it('tracks concurrent fetch ages and cleans up each request exactly once', () => {
        let now = 100;
        const recorder = new performanceModule.PdfPerformance(() => now);
        const changes: number[][] = [];
        recorder.onFetchChange(() => {
            const snapshot = recorder.snapshot();
            assert.strictEqual(snapshot.pendingFetchCount, recorder.pendingFetchCount);
            assert.strictEqual(snapshot.oldestFetchMs, recorder.oldestFetchMs);
            changes.push([recorder.pendingFetchCount, recorder.oldestFetchMs]);
        });
        assert.deepStrictEqual(changes, []);
        assert.strictEqual(recorder.oldestFetchMs, 0);

        const first = recorder.beginFetch();
        now = 140;
        const second = recorder.beginFetch();
        assert.strictEqual(recorder.snapshot().fetchCount, 0);
        assert.strictEqual(recorder.snapshot().fetchBytes, 0);
        now = 180;
        first();
        first();
        second();
        second();
        assert.deepStrictEqual(changes, [[1, 0], [2, 40], [1, 40], [0, 0]]);
        assert.strictEqual(recorder.pendingFetchCount, 0);
        assert.strictEqual(recorder.oldestFetchMs, 0);
    });

    it('unsubscribes fetch observers independently and preserves subscriptions across reset', () => {
        const recorder = new performanceModule.PdfPerformance(() => 10);
        const firstChanges: number[] = [];
        const secondChanges: number[] = [];
        const stopFirst = recorder.onFetchChange(() => firstChanges.push(recorder.pendingFetchCount));
        const stopSecond = recorder.onFetchChange(() => secondChanges.push(recorder.pendingFetchCount));
        const staleEnd = recorder.beginFetch();
        stopFirst();
        stopFirst();
        recorder.reset();
        staleEnd();
        const end = recorder.beginFetch();
        end();
        stopSecond();
        recorder.beginFetch()();
        recorder.reset();
        assert.deepStrictEqual(firstChanges, [1]);
        assert.deepStrictEqual(secondChanges, [1, 0, 1, 0]);
    });

    it('notifies reset after clearing all metrics and fences stale completions from the next document', () => {
        let now = 10;
        const recorder = new performanceModule.PdfPerformance(() => now);
        const snapshots: any[] = [];
        recorder.onFetchChange(() => snapshots.push(recorder.snapshot()));
        const staleEnd = recorder.beginFetch();
        recorder.fetch(2048, 5);
        now = 50;
        recorder.reset();
        const reset = snapshots.at(-1);
        assert.strictEqual(reset.pendingFetchCount, 0);
        assert.strictEqual(reset.oldestFetchMs, 0);
        assert.strictEqual(reset.fetchBytes, 0);
        assert.strictEqual(reset.elapsedMs, 0);
        assert.deepStrictEqual(reset.events, []);

        now = 60;
        const currentEnd = recorder.beginFetch();
        now = 80;
        staleEnd();
        assert.strictEqual(recorder.pendingFetchCount, 1);
        assert.strictEqual(recorder.oldestFetchMs, 20);
        assert.strictEqual(snapshots.length, 3);
        currentEnd();
        staleEnd();
        assert.strictEqual(recorder.pendingFetchCount, 0);
        assert.strictEqual(snapshots.length, 4);
    });

    it('keeps cleanup and other observers working when a fetch observer throws', () => {
        const recorder = new performanceModule.PdfPerformance(() => 10);
        const changes: number[] = [];
        recorder.onFetchChange(() => { throw new Error('observer failure'); });
        recorder.onFetchChange(() => changes.push(recorder.pendingFetchCount));
        let end = () => {};
        assert.doesNotThrow(() => { end = recorder.beginFetch(); });
        assert.strictEqual(recorder.pendingFetchCount, 1);
        assert.doesNotThrow(() => end());
        assert.strictEqual(recorder.pendingFetchCount, 0);
        assert.deepStrictEqual(changes, [1, 0]);
        assert.deepStrictEqual(recorder.snapshot().events.map((event: any) => event.type),
            ['fetch-observer-error', 'fetch-observer-error']);
    });

    it('starts fresh for a new document, including the measurement window and ring cursors', () => {
        let now = 1000;
        const recorder = new performanceModule.PdfPerformance(() => now);
        recorder.event('page-ready', { page: 1 });
        recorder.fetch(1024 * 1024, 1000);
        now = 9000;
        recorder.reset();
        const reset = recorder.snapshot();
        assert.deepStrictEqual(reset.events, []);
        assert.strictEqual(reset.eventCount, 0);
        assert.strictEqual(reset.droppedEvents, 0);
        assert.strictEqual(reset.fetchBytes, 0);
        assert.strictEqual(reset.fetchCount, 0);
        assert.strictEqual(reset.fetchMiBPerSecond, 0);
        now = 10000;
        recorder.fetch(1024 * 1024, 500);
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 2);
    });

    it('keeps document robots enabled while measurements stay closed and toggles them independently', () => {
        class Button {
            id = '';
            readonly attributes = new Map<string, string>();
            readonly listeners = new Map<string, () => void>();
            removed = false;
            setAttribute(name: string, value: string) { this.attributes.set(name, value); }
            addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
            removeEventListener(name: string, listener: () => void) {
                assert.strictEqual(this.listeners.get(name), listener);
                this.listeners.delete(name);
            }
            remove() { this.removed = true; }
        }
        const buttons: Button[] = [];
        const listeners = new Map<string, unknown>();
        let enabled = true;
        let timers = 0;
        let samples = 0;
        const document = {
            defaultView: { setInterval() { timers++; }, clearInterval() {} },
            createElement(tag: string) {
                assert.strictEqual(tag, 'button', 'closed measurements do not allocate a panel or a lab stage');
                return new Button();
            },
            addEventListener(name: string, listener: unknown) { listeners.set(name, listener); },
            removeEventListener(name: string, listener: unknown) {
                assert.strictEqual(listeners.get(name), listener);
                listeners.delete(name);
            },
        };
        const controls = performanceModule.installPrefetchDiagnostics({ id: 'viewerContainer', ownerDocument: document },
            () => { samples++; }, {
                enabled: false,
                toolbar: { append(button: Button) { buttons.push(button); } },
                robots: { get enabled() { return enabled; }, setEnabled(value: boolean) { enabled = value; } },
            });
        const robot = buttons.find(button => button.id === 'pdf-prefetch-toggle')!;
        const measurements = buttons.find(button => button.id === 'pdf-prefetch-measurements')!;
        assert.strictEqual(robot.attributes.get('aria-pressed'), 'true');
        assert.ok(measurements, 'numeric measurements have their own header control');
        assert.strictEqual(measurements.attributes.get('aria-expanded'), 'false');
        assert.strictEqual(controls.enabled, false);
        robot.listeners.get('click')!();
        assert.strictEqual(enabled, false);
        assert.strictEqual(robot.attributes.get('aria-pressed'), 'false');
        controls.setRobotsEnabled(true);
        assert.strictEqual(enabled, true);
        assert.strictEqual(robot.attributes.get('aria-pressed'), 'true');
        assert.strictEqual(controls.enabled, false);
        assert.strictEqual(timers, 0);
        assert.strictEqual(samples, 0);
        controls.dispose();
        assert.ok(buttons.every(button => button.removed && button.listeners.size === 0));
        assert.strictEqual(listeners.size, 0);
    });

    it('keeps the tools launcher last and places the lab in the supplied labeled menu', () => {
        const launcher = { id: 'secondaryToolbarToggle' };
        const toolbar: any[] = [launcher];
        const menu: any[] = [];
        const document = {
            defaultView: {},
            createElement() {
                return { id: '', innerHTML: '', attributes: new Map<string, string>(),
                    setAttribute(name: string, value: string) { this.attributes.set(name, value); },
                    addEventListener() {}, removeEventListener() {}, remove() {} };
            },
            addEventListener() {}, removeEventListener() {},
        };
        const controls = performanceModule.installPrefetchDiagnostics({ id: 'viewerContainer', ownerDocument: document },
            () => { throw new Error('A closed lab must not sample'); }, {
                toolbar: { append(button: any) { toolbar.push(button); }, insertBefore(button: any, before: any) { toolbar.splice(toolbar.indexOf(before), 0, button); } },
                toolbarBefore: launcher,
                measurementsMenu: { append(button: any) { menu.push(button); } },
                robots: { enabled: true, setEnabled() {} },
            });
        assert.deepStrictEqual(toolbar.map(button => button.id), ['pdf-prefetch-toggle', 'secondaryToolbarToggle']);
        assert.deepStrictEqual(menu.map(button => button.id), ['pdf-prefetch-measurements']);
        assert.ok(menu[0].innerHTML.includes('LARICS Motion Lab'), 'the menu item has a readable label');
        assert.strictEqual(menu[0].attributes.get('aria-expanded'), 'false');
        controls.dispose();
    });

    it('keeps the fixed lab outside viewer input handlers while allowing couriers above it', () => {
        const listeners = new Map<string, Set<unknown>>();
        const add = (name: string, listener: unknown) => {
            if (!listeners.has(name)) { listeners.set(name, new Set()); }
            listeners.get(name)!.add(listener);
        };
        const remove = (name: string, listener: unknown) => { listeners.get(name)?.delete(listener); };
        const canvases: Node[] = [], observers: Array<{ disconnected: boolean }> = [];
        const resizeDirections = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
        const layouts: any[] = [];
        const layoutInvalidations: number[] = [];
        let invalidations = 0;
        const timers = new Map<number, () => void>(), frames = new Map<number, (time: number) => void>();
        let scheduleId = 0;
        const document: any = { hidden: true, addEventListener: add, removeEventListener: remove };
        const context = new Proxy({} as Record<string, unknown>, {
            get(target, key: string) {
                if (key in target) { return target[key]; }
                if (key === 'createLinearGradient' || key === 'createRadialGradient') { return () => ({ addColorStop() {} }); }
                return () => {};
            },
        });
        class Node {
            id = ''; hidden = false; width = 0; height = 0;
            ownerDocument = document;
            parentNode: Node | null = null;
            readonly children: Node[] = [];
            readonly style: Record<string, string> = {};
            readonly dataset: Record<string, string> = {};
            readonly handlers = new Map<string, Set<(event?: any) => void>>();
            readonly attributes = new Map<string, string>();
            shadow: any;
            append(...nodes: Node[]) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
            replaceChildren(...nodes: Node[]) { for (const node of [...this.children]) { node.remove(); } this.append(...nodes); }
            remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
            setAttribute(name: string, value: string) { this.attributes.set(name, value); }
            getAttribute(name: string) { return this.attributes.get(name) ?? null; }
            addEventListener(name: string, listener: (event?: any) => void) {
                if (!this.handlers.has(name)) { this.handlers.set(name, new Set()); }
                this.handlers.get(name)!.add(listener);
            }
            removeEventListener(name: string, listener: (event?: any) => void) { this.handlers.get(name)?.delete(listener); }
            emit(name: string, event?: any) { for (const listener of [...this.handlers.get(name) ?? []]) { listener(event); } }
            focus() { document.activeElement = this; }
            getBoundingClientRect() { return { x: 500, y: 100, left: 500, top: 100, right: 956, bottom: 600, width: 456, height: 500 }; }
            getContext() { return context; }
            attachShadow() {
                const nodes = new Map<string, Node>();
                const lookup = (selector: string) => {
                    if (!nodes.has(selector)) { nodes.set(selector, new Node()); }
                    return nodes.get(selector)!;
                };
                const fields = ['margin', 'status'].map(name => { const node = lookup('[data-field="' + name + '"]'); node.dataset.field = name; return node; });
                let html = '';
                return this.shadow = {
                    get innerHTML() { return html; },
                    set innerHTML(value: string) {
                        html = value;
                        const buttons = [...value.matchAll(/<button\b[^>]*\bdata-panel-resize="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)];
                        assert.deepStrictEqual(buttons.map(match => match[1]), resizeDirections, 'the actual markup must provide all eight semantic resize buttons');
                        const labels = new Set<string>();
                        for (const button of buttons) {
                            const node = lookup('[data-panel-resize="' + button[1] + '"]');
                            node.dataset.panelResize = button[1];
                            for (const attribute of button[0].matchAll(/([\w-]+)="([^"]*)"/g)) {
                                node.setAttribute(attribute[1], attribute[2]);
                            }
                            assert.strictEqual(node.getAttribute('type'), 'button');
                            const label = node.getAttribute('aria-label');
                            assert.ok(label?.startsWith('Resize Motion Lab from the '));
                            labels.add(label!);
                            assert.ok(button.index! > value.indexOf('</section>'), 'resize zones are outside the clipped section');
                        }
                        assert.strictEqual(labels.size, 8, 'each focusable resize control identifies its edge or corner');
                    },
                    querySelectorAll: () => fields, querySelector: lookup,
                };
            }
        }
        class Observer {
            disconnected = false;
            constructor() { observers.push(this); }
            observe() {}
            disconnect() { this.disconnected = true; }
        }
        document.body = new Node();
        document.createElement = (tag: string) => { const node = new Node(); if (tag === 'canvas') { canvases.push(node); } return node; };
        document.defaultView = {
            innerWidth: 1024, innerHeight: 768, addEventListener: add, removeEventListener: remove,
            devicePixelRatio: 1, performance: { now: () => 0 },
            getComputedStyle: () => ({ objectFit: 'contain', objectPosition: '50% 50%' }),
            crypto: { getRandomValues: (values: Uint32Array) => { values[0] = 13; return values; } },
            matchMedia: () => ({ matches: false, addEventListener: add, removeEventListener: remove }),
            setInterval(callback: () => void) {
                assert.ok(!document.hidden, 'a hidden lab does not poll');
                const id = ++scheduleId; timers.set(id, callback); return id;
            },
            clearInterval(id: number) { timers.delete(id); },
            requestAnimationFrame(callback: (time: number) => void) {
                assert.ok(!document.hidden, 'a hidden lab does not animate');
                const id = ++scheduleId; frames.set(id, callback); return id;
            },
            cancelAnimationFrame(id: number) { frames.delete(id); },
        };
        for (const name of ['ResizeObserver', 'IntersectionObserver']) { document.defaultView[name] = Observer; }
        const container = new Node(), transit = new Node(); transit.id = 'document-transit';
        document.body.append(container); container.append(transit);
        const diagnostics = performanceModule.installPrefetchDiagnostics(container, () => { assert.fail('a hidden document does not sample'); },
            { onPanelLayout: (layout: any) => { layouts.push(layout); layoutInvalidations.push(invalidations); } });
        assert.strictEqual(diagnostics.ownsEvent({ target: container, composedPath: () => [container] }), false, 'an uncreated lab owns no event');
        try {
            diagnostics.setEnabled(true);
            const host = [...container.children, ...document.body.children].find(node => node.id === 'pdf-prefetch-diagnostics')!;
            assert.ok(host);
            assert.strictEqual(host.parentNode, document.body, 'lab controls stay outside PDF scroll, wheel and capture handlers');
            assert.ok(host.shadow.innerHTML.includes('position:fixed'), 'the lab keeps its viewport position when its sibling scrolls');
            const layer = host.shadow.innerHTML.match(/:host\s*\{[^}]*z-index:(\d+)/)!;
            assert.ok(Number(layer[1]) < 2147483647, 'the real courier may paint above the lab during departure and return');
            assert.deepStrictEqual(layouts.map(layout => [layout.visible, layout.reason]), [[true, 'open']]);
            assert.ok(host.shadow.innerHTML.includes('class="panel-drag" tabindex="0"'), 'the title has keyboard movement access');
            const resizeHandles = resizeDirections.map(direction => host.shadow.querySelector('[data-panel-resize="' + direction + '"]'));
            assert.strictEqual(new Set(resizeHandles).size, 8);
            for (const handle of resizeHandles) {
                assert.strictEqual(handle.tabIndex, 0);
                assert.strictEqual(handle.handlers.get('pointerdown')?.size, 1);
                assert.strictEqual(handle.handlers.get('keydown')?.size, 1);
                assert.match(handle.getAttribute('aria-label'), /with arrow keys; \d+ by \d+ pixels/);
            }
            assert.strictEqual(diagnostics.ownsEvent({ target: host }), true, 'a shallow retargeted event belongs to this host');
            assert.strictEqual(diagnostics.ownsEvent({ target: resizeHandles[0], composedPath: () => [resizeHandles[0], host, document.body] }), true);
            const lookalike = new Node(); lookalike.id = host.id;
            assert.strictEqual(diagnostics.ownsEvent({ target: lookalike, composedPath: () => [lookalike, document.body] }), false);
            assert.strictEqual(diagnostics.ownsEvent({ target: container, composedPath: () => [container, document.body] }), false);
            host.hidden = true;
            assert.strictEqual(diagnostics.ownsEvent({ target: host, composedPath: () => [host] }), false);
            host.hidden = false;
            const lab = (host.shadow.querySelector('[data-robot-stage]') as any).robotLab;
            lab.invalidateGeometry = () => { invalidations++; };
            host.shadow.querySelector('[data-panel-dock="left"]').emit('click');
            assert.strictEqual(layouts.at(-1).dock, 'left');
            assert.strictEqual(layouts.at(-1).reason, 'dock');
            assert.strictEqual(layouts.at(-1).rect.x, 8);
            assert.strictEqual(invalidations, 1, 'a panel layout invalidates the lab before downstream courier movement');
            assert.strictEqual(layoutInvalidations.at(-1), 1);
            host.shadow.querySelector('.panel-content').emit('scroll');
            document.hidden = false;
            host.shadow.querySelector('.measurements').open = true;
            host.shadow.querySelector('.measurements').emit('toggle');
            assert.strictEqual(invalidations, 3, 'internal scrolling and compact-details changes invalidate the same snapshot');
            document.hidden = true;
            const content = host.shadow.querySelector('.panel-content'), measurements = host.shadow.querySelector('.measurements');
            host.shadow.querySelector('[data-panel-dock="float"]').emit('click');
            document.hidden = false;
            const keys = ['ArrowUp', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowLeft', 'ArrowUp'];
            for (const [index, handle] of resizeHandles.entries()) {
                const before = { ...layouts.at(-1).rect };
                let prevented = false;
                handle.emit('keydown', { key: keys[index], preventDefault() { prevented = true; }, stopPropagation() {} });
                assert.ok(prevented, resizeDirections[index] + ' keyboard input is wired to its declared axes');
                assert.notDeepStrictEqual(layouts.at(-1).rect, before);
            }
            document.hidden = true;
            diagnostics.setEnabled(false);
            assert.strictEqual(host.hidden, true);
            assert.strictEqual(diagnostics.ownsEvent({ target: host, composedPath: () => [host] }), false);
            assert.strictEqual(layouts.at(-1).visible, false);
            diagnostics.setEnabled(true);
            assert.strictEqual(document.body.children.filter((node: Node) => node.id === host.id).length, 1);
            diagnostics.dispose();
            assert.strictEqual(content.handlers.get('scroll')?.size, 0);
            assert.strictEqual(measurements.handlers.get('toggle')?.size, 0);
            assert.strictEqual(diagnostics.ownsEvent({ target: host, composedPath: () => [host] }), false);
            for (const handle of resizeHandles) {
                assert.strictEqual(handle.handlers.get('pointerdown')?.size, 0);
                assert.strictEqual(handle.handlers.get('keydown')?.size, 0);
            }
        } finally { diagnostics.dispose(); }
        assert.deepStrictEqual(container.children, [transit]);
        assert.deepStrictEqual(document.body.children, [container]);
        assert.strictEqual(layouts.at(-1).visible, false, 'disposal reports the final closed layout');
        assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
        assert.ok(observers.every(observer => observer.disconnected));
        assert.ok([...listeners.values()].every(group => group.size === 0));

        document.hidden = false;
        for (const when of ['open', 'close']) {
            let controls: any, opened = 0;
            const reports: any[] = [];
            controls = performanceModule.installPrefetchDiagnostics(container, () => ({
                direction: 0, velocityPxPerMs: 0, accelerationPxPerMs2: 0, pageLatencyMs: 0,
                preloadPx: 0, readyDistancePx: 0, safetySeconds: null, bufferSeconds: null,
                visible: [], renderAhead: [], prepared: [], pending: [], failed: [],
                previewPages: 0, previewBytes: 0, canvasBytes: 0,
            }), {
                measurementsMenu: new Node(),
                onOpen: () => { opened++; },
                onPanelLayout: (layout: any) => {
                    reports.push(layout);
                    if (layout.visible === (when === 'open')) { controls.dispose(); }
                },
            });
            try {
                assert.doesNotThrow(() => controls.setEnabled(true), 'a callback can dispose while opening with a measurements menu');
                if (when === 'close') {
                    assert.strictEqual(timers.size, 1, 'the ordinary open panel starts its sampling interval');
                    assert.doesNotThrow(() => controls.setEnabled(false), 'a callback can dispose during close');
                }
                assert.strictEqual(opened, when === 'open' ? 0 : 1, 'disposed opening does not continue into onOpen or focus');
                assert.strictEqual(controls.enabled, false);
                assert.deepStrictEqual(reports.map(report => report.visible), [true, false]);
                assert.deepStrictEqual(document.body.children, [container]);
                assert.strictEqual(timers.size, 0);
                assert.strictEqual(frames.size, 0);
                assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
                assert.ok(observers.every(observer => observer.disconnected));
                assert.ok([...listeners.values()].every(group => group.size === 0));
            } finally { controls.dispose(); }
        }
    });

    it('supports an explicit diagnostics opt-out and removes its handlers on disposal', () => {
        const listeners = new Map<string, (event: unknown) => void>();
        let timers = 0;
        let elements = 0;
        let samples = 0;
        const document = {
            defaultView: { setInterval() { timers++; }, clearInterval() {} },
            createElement() { elements++; throw new Error('The hidden dashboard must not create DOM'); },
            addEventListener(name: string, listener: (event: unknown) => void) { listeners.set(name, listener); },
            removeEventListener(name: string, listener: (event: unknown) => void) {
                assert.strictEqual(listeners.get(name), listener);
                listeners.delete(name);
            },
        };
        const diagnostics = performanceModule.installPrefetchDiagnostics({ ownerDocument: document }, () => { samples++; }, { enabled: false });
        assert.strictEqual(listeners.size, 2);
        listeners.get('keydown')!({ key: 'r', code: 'KeyR', ctrlKey: true, altKey: true, shiftKey: true });
        assert.strictEqual(diagnostics.enabled, false);
        assert.strictEqual(timers, 0);
        assert.strictEqual(elements, 0);
        assert.strictEqual(samples, 0);
        diagnostics.dispose();
        assert.strictEqual(listeners.size, 0);
        diagnostics.dispose();
        diagnostics.toggle();
        assert.strictEqual(timers, 0);
        assert.strictEqual(elements, 0);
    });
});
