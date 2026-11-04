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
        } finally {
            await esbuild.stop();
        }
    });

    after(() => {
        if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
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
        const layouts: any[] = [];
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
            readonly handlers = new Map<string, Set<() => void>>();
            shadow: any;
            append(...nodes: Node[]) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
            replaceChildren(...nodes: Node[]) { for (const node of [...this.children]) { node.remove(); } this.append(...nodes); }
            remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
            setAttribute() {}
            addEventListener(name: string, listener: () => void) {
                if (!this.handlers.has(name)) { this.handlers.set(name, new Set()); }
                this.handlers.get(name)!.add(listener);
            }
            removeEventListener(name: string, listener: () => void) { this.handlers.get(name)?.delete(listener); }
            emit(name: string) { for (const listener of [...this.handlers.get(name) ?? []]) { listener(); } }
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
                return this.shadow = { innerHTML: '', querySelectorAll: () => fields, querySelector: lookup };
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
            { onPanelLayout: (layout: any) => layouts.push(layout) });
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
            host.shadow.querySelector('[data-panel-dock="left"]').emit('click');
            assert.strictEqual(layouts.at(-1).dock, 'left');
            assert.strictEqual(layouts.at(-1).reason, 'dock');
            assert.strictEqual(layouts.at(-1).rect.x, 8);
            diagnostics.setEnabled(false);
            assert.strictEqual(host.hidden, true);
            assert.strictEqual(layouts.at(-1).visible, false);
            diagnostics.setEnabled(true);
            assert.strictEqual(document.body.children.filter((node: Node) => node.id === host.id).length, 1);
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
