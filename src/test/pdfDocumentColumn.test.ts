import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
interface Rect { x: number; y: number; width: number; height: number }
interface Panel { visible: boolean; dock: 'left' | 'right' | 'float'; rect: Rect; reason: string }
interface Motion { id: number; fromX: number; toX: number; startedAt: number; durationMs: number; bounds?: Rect; holdAtEnd?: boolean }
interface Column {
    readonly offsetX: number;
    readonly transition: Motion | undefined;
    readonly pending: boolean;
    readonly ready: boolean;
    readonly readyAt: number;
    setPanel(panel: Panel): void;
    update(layoutChanged?: boolean): void;
    registerLayer(layer: any): () => void;
    dispose(): void;
}

class Events {
    readonly listeners = new Map<string, Set<() => void>>();
    addEventListener(name: string, listener: () => void) {
        if (!this.listeners.has(name)) { this.listeners.set(name, new Set()); }
        this.listeners.get(name)!.add(listener);
    }
    removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
    emit(name: string) { for (const listener of [...this.listeners.get(name) ?? []]) { listener(); } }
    get count() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

class Style {
    readonly values = new Map<string, { value: string; priority: string }>();
    getPropertyValue(name: string) { return this.values.get(name)?.value ?? ''; }
    getPropertyPriority(name: string) { return this.values.get(name)?.priority ?? ''; }
    setProperty(name: string, value: string, priority = '') { this.values.set(name, { value, priority }); }
    removeProperty(name: string) { const previous = this.getPropertyValue(name); this.values.delete(name); return previous; }
}

class Element {
    readonly style = new Style();
    readonly dataset: Record<string, string | undefined> = {};
    parent?: Element;
    isConnected = true;
    clientLeft = 0;
    clientTop = 0;
    scrollLeft = 17;
    scrollTop = 83;
    clientWidth: number;
    clientHeight: number;
    measurementNoise = 0;
    reader?: Element;
    constructor(readonly ownerDocument: any, readonly box: Rect, readonly property: string) {
        this.clientWidth = box.width; this.clientHeight = box.height;
    }
    contains(other: Element): boolean {
        for (let parent: Element | undefined = other; parent; parent = parent.parent) { if (parent === this) { return true; } }
        return false;
    }
    getBoundingClientRect() {
        const translated = this.style.getPropertyValue('translate').includes('var(' + this.property);
        const offset = translated ? parseFloat(this.reader?.style.getPropertyValue(this.property) ?? '') || 0 : 0;
        const x = this.box.x + offset + this.measurementNoise;
        return { x, y: this.box.y, left: x, right: x + this.box.width, top: this.box.y,
            bottom: this.box.y + this.box.height, width: this.box.width, height: this.box.height };
    }
}

describe('PDF document column beside Motion Lab', function () {
    this.timeout(30_000);
    let dir: string;
    let plan: (viewport: Rect, pages: Rect[], panel?: Panel, appliedX?: number) => { offsetX: number; bounds?: Rect };
    let install: (container: any, options: any) => Column;
    let policy: { durationMs: number; inputSettleMs: number; offsetProperty: string };
    const viewport: Rect = { x: 0, y: 0, width: 1200, height: 800 };
    const page: Rect = { x: 300, y: 0, width: 600, height: 1000 };
    const panel = (dock: Panel['dock'] = 'right', overrides: Partial<Panel> = {}): Panel => ({
        visible: true, dock, reason: 'open', rect: { x: dock === 'left' ? 0 : 800, y: 0, width: 400, height: 800 }, ...overrides,
    });

    before(async () => {
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-document-column-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/pdf-document-column.ts')],
                outfile: path.join(dir, 'column.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
        } finally { await esbuild.stop(); }
        const module = await importModule(path.join(dir, 'column.mjs'));
        plan = module.planPdfDocumentColumn;
        install = module.installPdfDocumentColumn;
        policy = module.PDF_DOCUMENT_COLUMN_POLICY;
    });
    after(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); } });

    function fixture(reduced = false, notification?: () => void) {
        const clock = { now: 0, next: 0, timerStarts: 0 };
        const frames = new Map<number, (at: number) => void>();
        const timers = new Map<number, { at: number; callback(): void }>();
        const transitions: Array<Motion | undefined> = [];
        const media = Object.assign(new Events(), { matches: reduced });
        const visual = Object.assign(new Events(), { offsetLeft: 0, offsetTop: 0, width: 1400, height: 1000 });
        const errors: unknown[] = [];
        const document = Object.assign(new Events(), { hidden: false, defaultView: undefined as any });
        const observers: Array<{ watched: Set<Element>; trigger(): void }> = [];
        const observerConstructor = class {
            readonly watched = new Set<Element>();
            constructor(readonly callback: () => void) { observers.push(this); }
            observe(element: Element) { this.watched.add(element); }
            unobserve(element: Element) { this.watched.delete(element); }
            disconnect() { this.watched.clear(); }
            trigger() { this.callback(); }
        };
        const window = Object.assign(new Events(), {
            innerWidth: 1400, innerHeight: 1000,
            visualViewport: visual,
            console: { error: (message: string, error: unknown) => errors.push({ message, error }) },
            matchMedia: () => media,
            getComputedStyle: (element: Element) => ({ translate: element.style.getPropertyValue('translate') || 'none' }),
            setTimeout(callback: () => void, delay: number) {
                const id = ++clock.next; clock.timerStarts++;
                timers.set(id, { at: clock.now + delay, callback }); return id;
            },
            clearTimeout(id: number) { timers.delete(id); },
        });
        Object.defineProperty(window, 'ResizeObserver', { value: observerConstructor });
        document.defaultView = window;
        const container = new Element(document, { ...viewport }, policy.offsetProperty);
        const viewer = new Element(document, { ...viewport }, policy.offsetProperty);
        viewer.parent = container; viewer.reader = container;
        const makePage = (box = page) => {
            const element = new Element(document, { ...box }, policy.offsetProperty);
            element.parent = viewer; element.reader = container; return element;
        };
        const pages = [makePage()];
        const transit = new Element(document, { x: 0, y: 0, width: 0, height: 0 }, policy.offsetProperty);
        transit.parent = container; transit.reader = container;
        const api = install(container, {
            pages: () => pages, now: () => clock.now,
            requestFrame(callback: (at: number) => void) { const id = ++clock.next; frames.set(id, callback); return id; },
            cancelFrame(id: number) { frames.delete(id); },
            onTransition(motion: Motion | undefined) { transitions.push(motion); notification?.(); },
        });
        const releaseTransit = api.registerLayer(transit);
        const advance = (at: number) => {
            clock.now = at;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= at && timers.delete(id)) { timer.callback(); }
            }
        };
        const frame = (at: number) => {
            advance(at);
            for (const [id, callback] of [...frames]) { if (frames.delete(id)) { callback(at); } }
        };
        return { api, pages, container, viewer, transit, media, visual, document, window, frames, timers, clock,
            transitions, observers, errors, makePage, releaseTransit, advance, frame,
            finish() {
                for (let step = 0; step < 8 && (frames.size || timers.size); step++) {
                    const motion = api.transition;
                    const at = Math.min(...[...timers.values()].map(timer => timer.at),
                        frames.size && motion ? motion.startedAt + motion.durationMs : Infinity);
                    assert.ok(Number.isFinite(at), 'each owned callback has a finite scene or settling deadline');
                    frame(Math.max(clock.now, at));
                }
                assert.strictEqual(frames.size + timers.size, 0, 'the latest finite arrangement converges');
                assert.strictEqual(api.ready, true);
            } };
    }

    it('clears a right dock only as far as the existing opposite margin permits', () => {
        assert.strictEqual(plan(viewport, [page], panel()).offsetX, -116);
        assert.strictEqual(plan(viewport, [{ ...page, x: 100, width: 1000 }], panel()).offsetX, -100);
    });

    it('uses the symmetric rule for a left dock', () => {
        assert.strictEqual(plan(viewport, [page], panel('left')).offsetX, 116);
        assert.strictEqual(plan(viewport, [{ ...page, x: 100, width: 1000 }], panel('left')).offsetX, 100);
    });

    it('leaves viewport-wide and horizontally clipped wide pages in place', () => {
        for (const x of [-100, 0, 100]) {
            for (const side of ['left', 'right'] as const) {
                assert.strictEqual(plan(viewport, [{ ...page, x, width: viewport.width }], panel(side)).offsetX, 0);
            }
        }
    });

    it('leaves a column still when the panel fits in its existing blank margin or is outside the visible pages', () => {
        assert.strictEqual(plan(viewport, [page], panel('right', { rect: { x: 950, y: 0, width: 250, height: 800 } })).offsetX, 0);
        assert.strictEqual(plan(viewport, [page], panel('float', { rect: { x: 950, y: 0, width: 250, height: 800 } })).offsetX, 0);
        assert.strictEqual(plan(viewport, [page], panel('right', { visible: false })).offsetX, 0);
        assert.strictEqual(plan(viewport, [page], panel('right', { rect: { x: 800, y: 900, width: 400, height: 100 } })).offsetX, 0);
    });

    it('clears a floating panel to either side only when the complete page and gap fit', () => {
        assert.strictEqual(plan(viewport, [page], panel('float')).offsetX, -116);
        assert.strictEqual(plan(viewport, [page], panel('float', { rect: { x: 0, y: 0, width: 400, height: 800 } })).offsetX, 116);
        for (const [rect, expected] of [
            [{ x: 616, y: 0, width: 584, height: 800 }, -300],
            [{ x: 615.99, y: 0, width: 584, height: 800 }, 0],
            [{ x: 0, y: 0, width: 584, height: 800 }, 300],
            [{ x: 0, y: 0, width: 584.01, height: 800 }, 0],
            [{ x: 500, y: 0, width: 200, height: 800 }, 0],
        ] as const) {
            assert.strictEqual(plan(viewport, [page], panel('float', { rect })).offsetX, expected);
        }
    });

    it('keeps the complete visible spread together when selecting a floating-panel side', () => {
        const spread = [{ ...page, x: 200, width: 390 }, { ...page, x: 610, width: 390 }];
        assert.strictEqual(plan(viewport, spread, panel('float', { rect: { x: 900, y: 0, width: 300, height: 800 } })).offsetX, -116);
        assert.strictEqual(plan(viewport, spread, panel('float')).offsetX, 0,
            'space for either individual page does not suffice for the spread');
    });

    it('returns on the nearest feasible floating side and keeps that side through subpixel drag changes', () => {
        const narrow = { ...page, x: 400, width: 400 };
        const floating = panel('float', { rect: { x: 500, y: 0, width: 200, height: 800 } });
        assert.strictEqual(plan(viewport, [narrow], floating).offsetX, -316, 'an initial tie has a stable left choice');
        for (const applied of [-316, -60, 60, 316]) {
            const expected = applied < 0 ? -316 : 316;
            assert.strictEqual(plan(viewport, [{ ...narrow, x: narrow.x + applied }], floating, applied).offsetX, expected);
        }
        let applied = 316;
        for (const x of [499.9, 500, 500.1, 500, 499.9, 500.1]) {
            applied = plan(viewport, [{ ...narrow, x: narrow.x + applied }],
                panel('float', { rect: { ...floating.rect, x } }), applied).offsetX;
            assert.ok(applied >= 315.9 && applied <= 316.1, 'a cleared right side must not oscillate across the panel');
            assert.ok(Math.abs(applied - (x + floating.rect.width + 16 - narrow.x)) < 1e-9,
                'the chosen side uses only the displacement needed for clearance');
            assert.ok(narrow.x + applied >= x + floating.rect.width + 16 - 1e-9);
            assert.ok(narrow.x + narrow.width + applied <= viewport.width);
        }
    });

    it('returns toward center inside the current floating side when both sides fit', () => {
        const narrow = { ...page, x: 450, width: 100 };
        for (const [applied, panelX, expected] of [[-200, 466, -100], [200, 486, 100]]) {
            const result = plan(viewport, [{ ...narrow, x: narrow.x + applied }],
                panel('float', { rect: { x: panelX, y: 0, width: 48, height: 800 } }), applied);
            assert.strictEqual(result.offsetX, expected,
                'return within the current side instead of retaining excess shift or crossing to the smaller opposite offset');
            assert.ok(narrow.x + result.offsetX >= viewport.x);
            assert.ok(narrow.x + narrow.width + result.offsetX <= viewport.width);
        }
    });

    it('recenters when the unshifted page fully clears the floating panel', () => {
        for (const applied of [-116, 116]) {
            for (const x of [0, 950]) {
                assert.strictEqual(plan(viewport, [{ ...page, x: page.x + applied }],
                    panel('float', { rect: { x, y: 0, width: 250, height: 800 } }), applied).offsetX, 0);
            }
        }
        const clippedView = { ...viewport, x: 200, width: 1000 };
        const clippedOffsets = [[150, 900], [650, 220]].map(([pageX, panelX]) =>
            plan(clippedView, [{ ...page, x: pageX }],
                panel('float', { rect: { x: panelX, y: 0, width: 280, height: 800 } })).offsetX);
        assert.deepStrictEqual(clippedOffsets, [0, 0],
            'an already-clear float must not reposition a horizontally clipped base page');
    });

    it('measures the visible spread and excludes pages outside the viewport', () => {
        const spread = [{ ...page, x: 200, width: 390 }, { ...page, x: 610, width: 390 }, { ...page, x: 0, y: 2000, width: 1200 }];
        const result = plan(viewport, spread, panel('right', { rect: { x: 900, y: 0, width: 300, height: 800 } }));
        assert.strictEqual(result.offsetX, -116);
        assert.deepStrictEqual(result.bounds, { x: 200, y: 0, width: 800, height: 1000 });
    });

    it('removes the currently applied shift before computing a new target', () => {
        for (const applied of [0, -40, -116]) {
            assert.strictEqual(plan(viewport, [{ ...page, x: page.x + applied }], panel(), applied).offsetX, -116);
        }
        assert.strictEqual(plan({ x: 200, y: 0, width: 1000, height: 800 },
            [{ ...page, x: 350 }], panel()).offsetX, -150, 'sidebar geometry changes the available left margin');
        assert.strictEqual(plan(viewport, [{ ...page, width: NaN }], panel()).offsetX, 0);
    });

    it('does no geometry or computed-style work while the unshifted lab is absent or closed', () => {
        for (const state of [undefined, panel('right', { visible: false })]) {
            const f = fixture();
            let reads = 0;
            const rect = f.container.getBoundingClientRect.bind(f.container);
            const pageRect = f.pages[0].getBoundingClientRect.bind(f.pages[0]);
            const computed = f.window.getComputedStyle;
            f.container.getBoundingClientRect = () => { reads++; return rect(); };
            f.pages[0].getBoundingClientRect = () => { reads++; return pageRect(); };
            f.window.getComputedStyle = element => { reads++; return computed(element); };
            try {
                if (state) { f.api.setPanel(state); }
                for (let step = 0; step < 12; step++) {
                    f.api.update();
                    f.observers[0].trigger();
                    f.window.emit('resize');
                    f.visual.emit('resize');
                    f.visual.emit('scroll');
                }
                assert.strictEqual(reads, 0, 'an inactive column must not flush layout during reader refreshes');
                assert.strictEqual(f.frames.size, 0);
                assert.strictEqual(f.transitions.length, 0);
                assert.strictEqual(f.observers[0].watched.size, 0);
                assert.strictEqual(f.container.style.values.size, 0);
                assert.strictEqual(f.pages[0].style.values.size, 0);
            } finally { f.api.dispose(); }
        }
    });

    it('settles drag, resize and viewport input before moving the column through one finite scene', () => {
        for (const reason of ['drag', 'resize', 'viewport']) {
            const f = fixture();
            try {
                f.api.setPanel(panel('float', { rect: { x: 950, y: 0, width: 250, height: 800 } }));
                if (reason === 'viewport') {
                    f.pages[0].box.x = 400;
                    f.window.emit('resize');
                } else { f.api.setPanel(panel('float', { reason })); }
                assert.strictEqual(f.api.offsetX, 0, reason + ' must wait for settled input instead of applying synchronously');
                assert.strictEqual(f.api.transition, undefined);
                assert.strictEqual(f.frames.size, 0);
                assert.strictEqual(f.timers.size, 1);
                assert.strictEqual(f.api.ready, false);
                assert.strictEqual(f.api.readyAt, 300 + policy.durationMs);
                assert.strictEqual(f.container.dataset.pdfColumnMoving, 'true');
                f.advance(299); assert.strictEqual(f.api.transition, undefined);
                f.advance(300);
                const motion = f.api.transition as Motion | undefined;
                assert.ok(motion, 'the settled wake starts the finite column scene');
                assert.strictEqual(motion.startedAt, 300);
                assert.strictEqual(motion.toX, reason === 'viewport' ? -66 : -116);
                assert.strictEqual(f.timers.size, 0);
                f.frame(300 + policy.durationMs);
                assert.strictEqual(f.api.offsetX, reason === 'viewport' ? -66 : -116);
                assert.strictEqual(f.api.ready, true);
                assert.strictEqual(f.frames.size + f.timers.size, 0);
                assert.strictEqual(f.container.dataset.pdfColumnMoving, undefined);
                assert.deepStrictEqual([f.container.scrollLeft, f.container.scrollTop], [17, 83]);
            } finally { f.api.dispose(); }
        }
    });

    it('coalesces a drag burst into the latest destination using one owned settling wake', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel('float', { reason: 'drag' }));
            f.advance(100);
            f.api.setPanel(panel('float', { reason: 'drag', rect: { x: 780, y: 0, width: 420, height: 800 } }));
            f.advance(200);
            f.api.setPanel(panel('float', { reason: 'resize', rect: { x: 750, y: 0, width: 450, height: 800 } }));
            assert.strictEqual(f.api.offsetX, 0);
            assert.strictEqual(f.transitions.length, 0, 'pointer samples do not allocate actor jobs');
            assert.strictEqual(f.clock.timerStarts, 1, 'later samples update the one owned wake');
            assert.strictEqual(f.api.readyAt, 500 + policy.durationMs);
            f.advance(300);
            assert.strictEqual(f.timers.size, 1);
            assert.strictEqual(f.clock.timerStarts, 2, 'an early wake waits only for the remaining quiet interval');
            f.advance(400); f.api.update(false); f.api.update();
            assert.strictEqual(f.api.readyAt, 500 + policy.durationMs, 'unchanged reader plans do not postpone input settling');
            f.advance(500);
            assert.strictEqual(f.transitions.length, 1);
            assert.strictEqual(f.api.transition?.toX, -166);
            f.frame(500 + policy.durationMs);
            assert.strictEqual(f.api.offsetX, -166);
            assert.strictEqual(f.api.ready, true);
            assert.strictEqual(f.frames.size + f.timers.size, 0);
        } finally { f.api.dispose(); }
    });

    it('finishes an engaged leg before taking one latest settled continuation', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel()); f.frame(1000);
            const original = f.api.transition!, from = f.api.offsetX;
            f.api.setPanel(panel('left', { reason: 'drag' }));
            f.advance(1100);
            f.api.setPanel(panel('left', { reason: 'resize', rect: { x: 0, y: 0, width: 450, height: 800 } }));
            assert.strictEqual(f.api.offsetX, from);
            assert.strictEqual(f.api.transition?.id, original.id);
            assert.strictEqual(f.api.transition?.startedAt, original.startedAt);
            assert.strictEqual(f.api.transition?.toX, original.toX);
            assert.strictEqual(f.api.transition?.holdAtEnd, true);
            assert.strictEqual(f.api.readyAt, policy.durationMs * 2);
            f.advance(1400);
            const stale = [...f.frames.values()][0];
            f.frame(policy.durationMs);
            const next = f.api.transition!;
            assert.ok(next.id > original.id);
            assert.strictEqual(next.fromX, original.toX);
            assert.strictEqual(next.toX, 166);
            assert.strictEqual(next.startedAt, policy.durationMs);
            assert.ok(f.transitions.every(value => value), 'the actor stays owned between legs');
            const offset = f.api.offsetX;
            stale(10000);
            assert.strictEqual(f.api.transition, next);
            assert.strictEqual(f.api.offsetX, offset);
            f.frame(policy.durationMs * 2);
            assert.strictEqual(f.api.offsetX, 166);
            assert.strictEqual(f.api.ready, true);
            assert.strictEqual(f.transitions.filter(value => !value).length, 1);
            assert.strictEqual(f.frames.size + f.timers.size, 0);
        } finally { f.api.dispose(); }
    });

    it('parks at the completed edge without frames while the latest input is still settling', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel()); f.frame(2400);
            f.api.setPanel(panel('left', { reason: 'drag' }));
            const original = f.api.transition!;
            f.frame(2500);
            assert.strictEqual(f.api.offsetX, -116);
            assert.strictEqual(f.api.transition?.id, original.id);
            assert.strictEqual(f.api.transition?.holdAtEnd, true);
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.timers.size, 1);
            assert.strictEqual(f.api.ready, false);
            assert.strictEqual(f.api.readyAt, 2700 + policy.durationMs);
            f.advance(2600);
            f.api.setPanel(panel('left', { reason: 'drag', rect: { x: 0, y: 0, width: 450, height: 800 } }));
            assert.strictEqual(f.api.readyAt, 2900 + policy.durationMs);
            f.advance(2700);
            assert.strictEqual(f.frames.size, 0);
            f.advance(2900);
            assert.ok(f.api.transition!.id > original.id);
            assert.strictEqual(f.api.transition?.fromX, -116);
            assert.strictEqual(f.api.transition?.toX, 166);
            f.frame(2900 + policy.durationMs);
            assert.strictEqual(f.api.ready, true);
            assert.strictEqual(f.frames.size + f.timers.size, 0);
        } finally { f.api.dispose(); }
    });

    it('cancels the owned pending wake on lifecycle exits and rejects its late callback', () => {
        for (const engaged of [false, true]) {
            for (const boundary of ['hidden', 'reduced', 'dispose']) {
                const f = fixture();
                try {
                    if (engaged) { f.api.setPanel(panel()); f.frame(1000); }
                    f.api.setPanel(panel('left', { reason: 'drag' }));
                    assert.strictEqual(f.timers.size, 1);
                    const late = [...f.timers.values()][0].callback;
                    if (boundary === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
                    else if (boundary === 'reduced') { f.media.matches = true; f.media.emit('change'); }
                    else { f.api.dispose(); }
                    const offset = f.api.offsetX;
                    late();
                    assert.strictEqual(f.api.offsetX, offset);
                    assert.strictEqual(offset, boundary === 'dispose' ? 0 : 116);
                    assert.strictEqual(f.api.ready, true);
                    assert.strictEqual(f.api.transition, undefined);
                    assert.strictEqual(f.frames.size + f.timers.size, 0);
                    assert.strictEqual(f.container.dataset.pdfColumnMoving, undefined);
                } finally { f.api.dispose(); }
            }
        }
    });

    it('observes floating-panel geometry and updates a cleared column during drag, resize and page changes', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel('float')); f.frame(policy.durationMs);
            assert.strictEqual(f.api.offsetX, -116);
            assert.ok(f.observers[0].watched.has(f.container));
            assert.ok(f.observers[0].watched.has(f.pages[0]));
            f.api.setPanel(panel('float', { reason: 'drag', rect: { x: 850, y: 0, width: 350, height: 800 } }));
            assert.strictEqual(f.api.offsetX, -116, 'the applied placement waits for the panel input to settle');
            assert.strictEqual(f.frames.size, 0);
            f.finish();
            assert.strictEqual(f.api.offsetX, -66, 'space freed by the panel returns the column toward center');
            f.api.setPanel(panel('float', { reason: 'drag', rect: { x: 750, y: 0, width: 450, height: 800 } }));
            f.finish();
            assert.strictEqual(f.api.offsetX, -166);
            f.api.setPanel(panel('float', { reason: 'drag', rect: { x: 950, y: 0, width: 250, height: 800 } }));
            f.finish();
            assert.strictEqual(f.api.offsetX, 0, 'dragging into the original blank margin restores centering');
            f.api.setPanel(panel('float', { reason: 'drag', rect: { x: 750, y: 0, width: 450, height: 800 } }));
            f.finish();
            assert.strictEqual(f.api.offsetX, -166);
            const previous = f.pages[0], next = f.makePage({ ...page, x: 350 });
            f.pages.splice(0, 1, next); f.api.update(false); f.finish();
            assert.strictEqual(f.api.offsetX, -216);
            assert.strictEqual(previous.style.getPropertyValue('translate'), '');
            assert.ok(f.observers[0].watched.has(next));
            next.box.width = 800; f.observers[0].trigger(); f.finish();
            assert.strictEqual(f.api.offsetX, 0, 'a wider page must not be clipped to clear the float');
            next.box.width = 600; f.observers[0].trigger(); f.finish();
            assert.strictEqual(f.api.offsetX, -216);
            next.box.y = -1100; f.api.update(false); f.finish();
            assert.strictEqual(f.api.offsetX, 0, 'vertical scrolling out of the panel overlap restores the column');
            assert.strictEqual(f.frames.size, 0);
            assert.deepStrictEqual([f.container.scrollLeft, f.container.scrollTop], [17, 83]);
        } finally { f.api.dispose(); }
        assert.strictEqual(f.observers[0].watched.size, 0);
        assert.strictEqual(f.document.count + f.window.count + f.visual.count + f.media.count, 0);
    });

    it('settles partial panel shrink before a finite return and recenters after vertical collapse', () => {
        for (const side of ['left', 'right'] as const) {
            for (const dock of ['float', side] as const) {
                const f = fixture(), sign = side === 'left' ? 1 : -1;
                const initial = { x: side === 'left' ? 0 : 800, y: 0, width: 400, height: 800 };
                const smaller = { ...initial, x: side === 'left' ? 0 : 850, width: 350 };
                try {
                    f.pages[0].box.y = 300; f.pages[0].box.height = 400;
                    f.api.setPanel(panel(dock, { rect: initial })); f.frame(policy.durationMs);
                    assert.strictEqual(f.api.offsetX, sign * 116);
                    f.api.setPanel(panel(dock, { reason: 'resize', rect: smaller }));
                    assert.strictEqual(f.api.offsetX, sign * 116);
                    assert.strictEqual(f.api.pending, true, dock + ' shrink must retain a return destination');
                    assert.strictEqual(f.timers.size, 1);
                    assert.strictEqual(f.frames.size, 0);
                    f.advance(policy.durationMs + policy.inputSettleMs - 1);
                    assert.strictEqual(f.api.transition, undefined);
                    f.advance(policy.durationMs + policy.inputSettleMs);
                    const motion = f.api.transition as Motion | undefined;
                    assert.ok(motion);
                    assert.deepStrictEqual([motion.fromX, motion.toX], [sign * 116, sign * 66]);
                    f.frame(motion.startedAt + motion.durationMs);
                    assert.strictEqual(f.api.offsetX, sign * 66);
                    assert.strictEqual(f.api.ready, true);
                    f.api.setPanel(panel(dock, { reason: 'resize', rect: { ...smaller, height: 200 } }));
                    assert.strictEqual(f.api.offsetX, sign * 66, 'vertical collapse also waits for a finite return');
                    assert.strictEqual(f.api.pending, true);
                    f.advance(f.clock.now + policy.inputSettleMs);
                    const returnMotion = f.api.transition as Motion | undefined;
                    assert.ok(returnMotion);
                    assert.strictEqual(returnMotion.toX, 0, 'the collapsed panel is above the entire visible page');
                    f.finish();
                    assert.strictEqual(f.api.offsetX, 0);
                    assert.strictEqual(f.api.ready, true);
                    assert.strictEqual(f.frames.size + f.timers.size, 0);
                    assert.strictEqual(f.container.dataset.pdfColumnMoving, undefined);
                    assert.strictEqual(f.pages[0].style.getPropertyValue('translate'), '');
                    assert.strictEqual(f.transit.style.getPropertyValue('translate'), '');
                    assert.deepStrictEqual([f.container.scrollLeft, f.container.scrollTop], [17, 83]);
                } finally { f.api.dispose(); }
            }
        }
    });

    it('keeps an engaged haul clock while shrink requests one return continuation', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel('float')); f.frame(1000);
            const original = f.api.transition!, applied = f.api.offsetX;
            f.api.setPanel(panel('float', { reason: 'resize', rect: { x: 850, y: 0, width: 350, height: 800 } }));
            f.advance(1100);
            f.api.setPanel(panel('float', { reason: 'resize', rect: { x: 875, y: 0, width: 325, height: 800 } }));
            assert.strictEqual(f.api.offsetX, applied);
            assert.strictEqual(f.api.transition?.id, original.id);
            assert.strictEqual(f.api.transition?.startedAt, original.startedAt);
            assert.strictEqual(f.api.transition?.toX, original.toX);
            assert.strictEqual(f.api.transition?.holdAtEnd, true);
            assert.strictEqual(f.timers.size, 1);
            f.advance(1400); f.frame(policy.durationMs);
            const next = f.api.transition!;
            assert.ok(next && next.id > original.id, 'the completed haul retains the latest return instead of discarding it');
            assert.deepStrictEqual([next.fromX, next.toX, next.startedAt], [-116, -41, policy.durationMs]);
            assert.ok(f.transitions.every(value => value), 'the continuation does not release the existing actor');
            f.frame(policy.durationMs * 2);
            assert.strictEqual(f.api.offsetX, -41);
            assert.strictEqual(f.api.ready, true);
            assert.strictEqual(f.transitions.filter(value => !value).length, 1);
            assert.strictEqual(f.frames.size + f.timers.size, 0);
        } finally { f.api.dispose(); }
    });

    it('calmly returns when viewport contraction reduces overlap with a still-visible float', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel('float', { rect: { x: 800, y: 0, width: 250, height: 800 } }));
            f.frame(policy.durationMs);
            assert.strictEqual(f.api.offsetX, -116);
            f.container.box.width = f.container.clientWidth = 1100;
            f.window.innerWidth = f.visual.width = 1100;
            f.pages[0].box.x = 250;
            f.window.emit('resize');
            assert.strictEqual(f.api.offsetX, -116);
            assert.strictEqual(f.api.pending, true, 'the old feasible shift must not remain sticky');
            assert.strictEqual(f.frames.size, 0);
            f.advance(policy.durationMs + policy.inputSettleMs);
            const motion = f.api.transition!;
            assert.deepStrictEqual([motion.fromX, motion.toX], [-116, -66]);
            f.frame(motion.startedAt + motion.durationMs);
            assert.strictEqual(f.api.offsetX, -66);
            assert.strictEqual(f.api.ready, true);
            assert.strictEqual(f.frames.size + f.timers.size, 0);
            assert.deepStrictEqual([f.container.scrollLeft, f.container.scrollTop], [17, 83]);
        } finally { f.api.dispose(); }
    });

    it('rechecks floating full-fit placement after the visual viewport changes and closes through one finite return', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel('float')); f.frame(policy.durationMs);
            f.visual.offsetLeft = 200; f.visual.width = 800; f.visual.emit('resize'); f.finish();
            assert.strictEqual(f.api.offsetX, 0, 'the remaining left side is narrower than the full page plus gap');
            f.visual.offsetLeft = 0; f.visual.width = 1400; f.visual.emit('scroll'); f.finish();
            assert.strictEqual(f.api.offsetX, -116);
            f.api.setPanel(panel('float', { visible: false, reason: 'close' }));
            assert.strictEqual(f.frames.size, 1);
            assert.strictEqual(f.container.dataset.pdfColumnMoving, 'true');
            f.finish();
            assert.strictEqual(f.api.offsetX, 0);
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.container.dataset.pdfColumnMoving, undefined);
            assert.strictEqual(f.observers[0].watched.size, 0);
            assert.strictEqual(f.pages[0].style.getPropertyValue('translate'), '');
            assert.strictEqual(f.transit.style.getPropertyValue('translate'), '');
        } finally { f.api.dispose(); }
    });

    it('keeps the full approach, haul and settle sequence observable without extending its deadline', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel('float'));
            assert.strictEqual(policy.durationMs, 2500);
            assert.strictEqual(f.container.dataset.pdfColumnMoving, 'true');
            f.frame(499); assert.strictEqual(f.api.offsetX, 0);
            f.frame(500); assert.strictEqual(f.api.offsetX, 0);
            f.frame(1400); assert.strictEqual(f.api.offsetX, -58);
            f.frame(2300); assert.strictEqual(f.api.offsetX, -116);
            assert.ok(f.api.transition, 'arrival of the page still leaves the finite settle phase');
            assert.strictEqual(f.container.dataset.pdfColumnMoving, 'true');
            f.frame(2499); assert.ok(f.api.transition);
            f.frame(2500);
            assert.strictEqual(f.api.transition, undefined);
            assert.strictEqual(f.container.dataset.pdfColumnMoving, undefined);
            assert.strictEqual(f.frames.size, 0);
        } finally { f.api.dispose(); }
    });

    it('publishes a settled dock continuation without ending its actor and rejects the old callback', () => {
        const f = fixture();
        try {
            const retargetAt = policy.durationMs / 2;
            f.api.setPanel(panel()); f.frame(retargetAt);
            const previous = f.api.transition!, stale = [...f.frames.values()][0], from = f.api.offsetX;
            f.api.setPanel(panel('left', { reason: 'dock' }));
            assert.strictEqual(f.api.transition?.id, previous.id);
            assert.strictEqual(f.api.offsetX, from);
            f.frame(policy.durationMs);
            const next = f.api.transition!;
            assert.ok(next.id > previous.id);
            assert.ok(f.transitions.every(value => value), 'continuation must not signal an intermediate actor release');
            assert.strictEqual(next.fromX, previous.toX);
            stale(10000);
            assert.strictEqual(f.api.transition, next);
            assert.strictEqual(f.api.offsetX, previous.toX);
            assert.strictEqual(f.container.dataset.pdfColumnMoving, 'true');
            f.frame(policy.durationMs * 2);
            assert.strictEqual(f.transitions.filter(value => !value).length, 1);
            assert.strictEqual(f.container.dataset.pdfColumnMoving, undefined);
            assert.strictEqual(f.frames.size, 0);
        } finally { f.api.dispose(); }
    });

    it('keeps the selected floating side on a tied retarget before the first frame', () => {
        const f = fixture();
        try {
            f.pages[0].box.x = 400; f.pages[0].box.width = 400;
            f.api.setPanel(panel('float', { rect: { x: 490, y: 0, width: 200, height: 800 } }));
            assert.strictEqual(f.api.offsetX, 0);
            assert.strictEqual(f.api.transition?.toX, 306);
            f.api.setPanel(panel('float', { reason: 'dock', rect: { x: 500, y: 0, width: 200, height: 800 } }));
            assert.strictEqual(f.api.offsetX, 0);
            assert.strictEqual(f.api.transition?.toX, 306, 'the committed approach keeps its chosen edge');
            f.api.update(false);
            assert.strictEqual(f.api.transition?.toX, 306);
            assert.ok(f.transitions.every(value => value));
            f.frame(policy.durationMs);
            assert.strictEqual(f.api.transition?.toX, 316, 'the settled destination keeps the same side');
            f.finish();
            assert.strictEqual(f.api.offsetX, 316);
            assert.strictEqual(f.frames.size, 0);
        } finally { f.api.dispose(); }
    });

    it('ends active and pending motion exactly once on reduced motion, hide or disposal', () => {
        for (const boundary of ['reduced', 'hidden', 'dispose']) {
            const f = fixture();
            try {
                f.container.dataset.pdfColumnMoving = 'existing';
                f.api.setPanel(panel()); f.frame(policy.durationMs / 2);
                f.api.setPanel(panel('left', { reason: 'dock' }));
                const stale = [...f.frames.values()][0];
                if (boundary === 'reduced') { f.media.matches = true; f.media.emit('change'); }
                else if (boundary === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
                else { f.api.dispose(); }
                const offset = f.api.offsetX;
                stale(10000);
                assert.strictEqual(f.api.offsetX, offset);
                assert.strictEqual(f.api.transition, undefined);
                assert.strictEqual(f.frames.size, 0);
                assert.strictEqual(f.container.dataset.pdfColumnMoving, 'existing');
                assert.strictEqual(f.transitions.filter(value => !value).length, 1, boundary);
            } finally { f.api.dispose(); }
        }
    });

    it('finishes close cleanup before taking the inactive path and measures changed pages when reopened', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel()); f.frame(policy.durationMs);
            assert.strictEqual(f.api.offsetX, -116);
            f.api.setPanel(panel('right', { visible: false, reason: 'close' }));
            assert.strictEqual(f.frames.size, 1, 'closing an applied shift keeps its finite return');
            f.frame(policy.durationMs * 2);
            assert.strictEqual(f.api.offsetX, 0);
            assert.strictEqual(f.pages[0].style.getPropertyValue('translate'), '');
            assert.strictEqual(f.transit.style.getPropertyValue('translate'), '');
            assert.strictEqual(f.container.style.getPropertyValue(policy.offsetProperty), '');
            assert.strictEqual(f.observers[0].watched.size, 0);

            const next = f.makePage({ ...page, x: 350 });
            f.pages.splice(0, 1, next);
            f.container.box.x = 200; f.container.box.width = f.container.clientWidth = 1000;
            let reads = 0;
            const rect = f.container.getBoundingClientRect.bind(f.container);
            const pageRect = next.getBoundingClientRect.bind(next);
            f.container.getBoundingClientRect = () => { reads++; return rect(); };
            next.getBoundingClientRect = () => { reads++; return pageRect(); };
            f.api.update(); f.window.emit('resize'); f.visual.emit('scroll');
            assert.strictEqual(reads, 0, 'closed reader changes need no layout measurement');
            f.api.setPanel(panel());
            assert.ok(reads > 0, 'opening uses current page and viewport geometry');
            assert.strictEqual(f.api.transition?.toX, -150);
            f.frame(policy.durationMs * 3);
            assert.strictEqual(f.api.offsetX, -150);
            assert.ok(f.observers[0].watched.has(next));
            assert.strictEqual(f.frames.size, 0);
        } finally { f.api.dispose(); }
    });

    it('reuses a viewport-wide zero-shift proof only for unchanged page elements during routine scroll updates', () => {
        const f = fixture();
        try {
            f.pages[0].box.x = -100; f.pages[0].box.width = 1600;
            f.api.setPanel(panel());
            assert.strictEqual(f.api.offsetX, 0);
            let reads = 0;
            const rect = f.container.getBoundingClientRect.bind(f.container);
            const pageRect = f.pages[0].getBoundingClientRect.bind(f.pages[0]);
            f.container.getBoundingClientRect = () => { reads++; return rect(); };
            f.pages[0].getBoundingClientRect = () => { reads++; return pageRect(); };
            for (let step = 0; step < 30; step++) {
                f.container.scrollLeft += 3; f.container.scrollTop += 7;
                f.pages[0].box.x -= 3; f.pages[0].box.y -= 7;
                f.api.update(false);
            }
            assert.strictEqual(reads, 0, 'scrolling cannot create horizontal margin beside a viewport-wide page');
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.transitions.length, 0);
            const narrow = f.makePage();
            f.pages.splice(0, 1, narrow);
            f.api.update(false);
            assert.ok(reads > 0, 'a different visible page invalidates the width proof');
            f.finish();
            assert.strictEqual(f.api.offsetX, -116);
            assert.ok(f.observers[0].watched.has(narrow));
        } finally { f.api.dispose(); }
    });

    it('invalidates a wide-page zero-shift proof on layout, observed size, browser viewport and panel changes', () => {
        for (const change of ['layout', 'observer', 'window', 'visual-resize', 'visual-scroll', 'panel']) {
            const f = fixture();
            try {
                f.pages[0].box.x = -100; f.pages[0].box.width = 1600;
                f.api.setPanel(panel());
                f.api.update(false);
                f.pages[0].box.x = 300; f.pages[0].box.width = 600;
                if (change === 'layout') { f.api.update(true); }
                else if (change === 'observer') { f.observers[0].trigger(); }
                else if (change === 'window') { f.window.emit('resize'); }
                else if (change === 'visual-resize') { f.visual.emit('resize'); }
                else if (change === 'visual-scroll') { f.visual.emit('scroll'); }
                else { f.api.setPanel(panel('right', { reason: 'resize' })); }
                assert.strictEqual(f.api.pending, true, change + ' must plan the new margin');
                f.finish();
                assert.strictEqual(f.api.offsetX, -116, change + ' must measure the new margin');
                assert.strictEqual(f.frames.size, 0);
            } finally { f.api.dispose(); }
        }
    });

    it('moves pages and transit by one applied value without changing native scroll or transforms', () => {
        const f = fixture();
        f.pages[0].style.setProperty('transform', 'rotate(0.1deg)');
        try {
            f.api.setPanel(panel());
            assert.strictEqual(f.frames.size, 1);
            assert.strictEqual(f.api.transition?.toX, -116);
            assert.strictEqual(f.transitions.length, 1);
            f.frame(policy.durationMs / 2);
            assert.ok(f.api.offsetX < 0 && f.api.offsetX > -116);
            assert.ok(Math.abs(f.pages[0].getBoundingClientRect().left - page.x - f.api.offsetX) < 1e-9);
            assert.strictEqual(f.transit.getBoundingClientRect().left, f.api.offsetX);
            const origin = f.container.box.x + f.container.clientLeft - f.container.scrollLeft + f.api.offsetX;
            assert.ok(Math.abs(f.pages[0].getBoundingClientRect().left - origin - page.x - f.container.scrollLeft) < 1e-9,
                'subtracting the shared scene origin applies column motion exactly once');
            assert.strictEqual(f.pages[0].style.getPropertyValue('transform'), 'rotate(0.1deg)');
            assert.deepStrictEqual([f.container.scrollLeft, f.container.scrollTop], [17, 83]);
            assert.strictEqual(f.viewer.style.getPropertyValue('translate'), '', 'the full-width viewer keeps its scrollable extent');
            f.frame(policy.durationMs);
            assert.strictEqual(f.api.offsetX, -116);
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.api.transition, undefined);
            assert.deepStrictEqual(f.transitions.map(value => value?.toX), [-116, undefined]);
            f.api.update();
            assert.strictEqual(f.frames.size, 0);
        } finally { f.api.dispose(); }
    });

    it('keeps the original deadline across unchanged measurements and subpixel rounding', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel());
            const original = f.api.transition;
            f.frame(100);
            f.api.update();
            f.pages[0].measurementNoise = 0.01;
            f.api.update();
            assert.strictEqual(f.api.transition, original);
            assert.strictEqual(f.transitions.length, 1);
            assert.strictEqual(f.frames.size, 1);
            f.frame(policy.durationMs);
            assert.strictEqual(f.frames.size, 0);
        } finally { f.api.dispose(); }
    });

    it('registers newly visible pages at the applied value and restores pages that leave', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel());
            f.frame(100);
            const original = f.api.transition;
            const previous = f.pages[0], next = f.makePage();
            f.pages.splice(0, 1, next);
            f.api.update();
            assert.strictEqual(f.api.transition, original);
            assert.strictEqual(previous.style.getPropertyValue('translate'), '');
            assert.strictEqual(next.getBoundingClientRect().left, page.x + f.api.offsetX);
            assert.strictEqual(f.frames.size, 1);
        } finally { f.api.dispose(); }
    });

    it('arranges sidebar and zoom changes after the committed leg and ignores its consumed callback', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel());
            f.frame(100);
            const stale = [...f.frames.values()][0];
            f.container.box.x = 200; f.container.box.width = f.container.clientWidth = 1000;
            f.pages[0].box.x = 350;
            f.observers[0].trigger();
            assert.strictEqual(f.api.offsetX, 0, 'layout changes do not snap the applied column');
            f.finish();
            assert.strictEqual(f.api.offsetX, -150);
            assert.strictEqual(f.frames.size, 0);
            stale(300);
            assert.strictEqual(f.api.offsetX, -150);
            f.pages[0].box.x = 200; f.pages[0].box.width = 1000;
            f.api.update();
            f.finish();
            assert.strictEqual(f.api.offsetX, 0);
            assert.strictEqual(f.pages[0].style.getPropertyValue('translate'), '');
        } finally { f.api.dispose(); }
    });

    it('starts a changed dock from the completed leg and rejects its old callback', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel()); f.frame(100);
            const from = f.api.offsetX, first = f.api.transition!, stale = [...f.frames.values()][0];
            f.api.setPanel(panel('left', { reason: 'dock' }));
            assert.strictEqual(f.api.offsetX, from);
            assert.strictEqual(f.api.transition?.id, first.id);
            f.frame(policy.durationMs);
            assert.strictEqual(f.api.transition?.fromX, first.toX);
            assert.strictEqual(f.api.transition?.toX, 116);
            assert.ok(f.api.transition!.id > first.id);
            stale(1000);
            assert.strictEqual(f.api.offsetX, first.toX);
            assert.strictEqual(f.frames.size, 1);
            f.frame(policy.durationMs * 2);
            assert.strictEqual(f.api.offsetX, 116);
            assert.strictEqual(f.frames.size, 0);
        } finally { f.api.dispose(); }
    });

    it('clamps against the visible browser viewport and responds to its offset changes', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel()); f.frame(policy.durationMs);
            f.visual.offsetLeft = 200; f.visual.width = 800;
            f.visual.emit('resize'); f.finish();
            assert.strictEqual(f.api.offsetX, -100, 'only the visible opposite margin is available');
            assert.strictEqual(f.frames.size, 0);
            f.visual.offsetLeft = 0; f.visual.width = 1400;
            f.visual.emit('scroll'); f.finish();
            assert.strictEqual(f.api.offsetX, -116);
            assert.strictEqual(f.frames.size, 0);
        } finally { f.api.dispose(); }
    });

    it('completes column motion and cleanup when optional actor notifications fail', () => {
        const f = fixture(false, () => { throw new Error('fixture actor allocation failed'); });
        try {
            f.api.setPanel(panel());
            assert.strictEqual(f.frames.size, 1);
            f.frame(policy.durationMs);
            assert.strictEqual(f.api.offsetX, -116);
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.errors.length, 2, 'both notification failures are reported');
        } finally { f.api.dispose(); }
        assert.strictEqual(f.api.offsetX, 0);
        assert.strictEqual(f.pages[0].style.getPropertyValue('translate'), '');
    });

    it('keeps disposal complete when the interrupted-motion notification closes the reader', () => {
        let disposeOnNotification = false;
        const f = fixture(false, () => { if (disposeOnNotification) { f.api.dispose(); } });
        f.api.setPanel(panel());
        f.frame(100);
        disposeOnNotification = true;
        f.api.setPanel(panel('left', { reason: 'dock' }));
        assert.strictEqual(f.api.offsetX, 0);
        assert.strictEqual(f.api.transition, undefined);
        assert.strictEqual(f.frames.size, 0);
        assert.strictEqual(f.pages[0].style.getPropertyValue('translate'), '');
        assert.strictEqual(f.transit.style.getPropertyValue('translate'), '');
        assert.strictEqual(f.container.style.getPropertyValue(policy.offsetProperty), '');
        assert.strictEqual(f.observers[0].watched.size, 0);
        assert.strictEqual(f.document.count + f.window.count + f.visual.count + f.media.count, 0);
    });

    it('restores translate values, priorities and the inherited property when closed', () => {
        const f = fixture();
        const original = 'calc(25% - 3px) 7px';
        f.pages[0].style.setProperty('translate', original, 'important');
        f.container.style.setProperty(policy.offsetProperty, '11px', 'important');
        try {
            f.api.setPanel(panel()); f.frame(policy.durationMs);
            assert.ok(f.pages[0].style.getPropertyValue('translate').includes('calc(calc(25% - 3px) + var('));
            f.api.setPanel(panel('right', { visible: false, reason: 'close' }));
            f.frame(policy.durationMs * 2);
            assert.strictEqual(f.api.offsetX, 0);
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.pages[0].style.getPropertyValue('translate'), original);
            assert.strictEqual(f.pages[0].style.getPropertyPriority('translate'), 'important');
            assert.strictEqual(f.container.style.getPropertyValue(policy.offsetProperty), '11px');
            assert.strictEqual(f.container.style.getPropertyPriority(policy.offsetProperty), 'important');
            assert.strictEqual(f.observers[0].watched.size, 0);
        } finally { f.api.dispose(); }
    });

    it('applies reduced motion immediately and finishes an active move when hidden', () => {
        for (const dock of ['right', 'float'] as const) {
            const reduced = fixture(true);
            try {
                reduced.api.setPanel(panel(dock));
                assert.strictEqual(reduced.api.offsetX, -116);
                assert.strictEqual(reduced.frames.size, 0);
                assert.strictEqual(reduced.transitions.length, 0);
                assert.strictEqual(reduced.container.dataset.pdfColumnMoving, undefined);
            } finally { reduced.api.dispose(); }
            for (const boundary of ['hidden', 'reduced']) {
                const f = fixture();
                try {
                    f.api.setPanel(panel(dock)); f.frame(100);
                    if (boundary === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
                    else { f.media.matches = true; f.media.emit('change'); }
                    assert.strictEqual(f.api.offsetX, -116);
                    assert.strictEqual(f.frames.size, 0);
                    assert.strictEqual(f.api.transition, undefined);
                    assert.strictEqual(f.container.dataset.pdfColumnMoving, undefined);
                } finally { f.api.dispose(); }
            }
        }
    });

    it('restores a released transit and rejects nested registrations that would translate twice', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel()); f.frame(100);
            assert.throws(() => f.api.registerLayer(f.viewer), /disjoint/);
            assert.throws(() => f.api.registerLayer(f.container), /disjoint/);
            f.releaseTransit(); f.releaseTransit();
            assert.strictEqual(f.transit.style.getPropertyValue('translate'), '');
            f.api.registerLayer(f.transit);
            assert.strictEqual(f.transit.getBoundingClientRect().left, f.api.offsetX);
        } finally { f.api.dispose(); }
    });

    it('disposes finite motion, restores styles and listeners, and ignores late work', () => {
        const f = fixture();
        f.api.setPanel(panel()); f.frame(100);
        const stale = [...f.frames.values()][0];
        f.api.dispose(); f.api.dispose();
        stale(1000); f.api.setPanel(panel()); f.api.update();
        assert.strictEqual(f.api.offsetX, 0);
        assert.strictEqual(f.frames.size, 0);
        assert.strictEqual(f.pages[0].style.getPropertyValue('translate'), '');
        assert.strictEqual(f.transit.style.getPropertyValue('translate'), '');
        assert.strictEqual(f.container.style.getPropertyValue(policy.offsetProperty), '');
        assert.strictEqual(f.observers[0].watched.size, 0);
        assert.strictEqual(f.document.count + f.window.count + f.visual.count + f.media.count, 0);
        assert.deepStrictEqual([f.container.scrollLeft, f.container.scrollTop], [17, 83]);
    });
});
