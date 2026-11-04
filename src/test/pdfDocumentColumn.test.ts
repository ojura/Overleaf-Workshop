import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
interface Rect { x: number; y: number; width: number; height: number }
interface Panel { visible: boolean; dock: 'left' | 'right' | 'float'; rect: Rect; reason: string }
interface Motion { id: number; fromX: number; toX: number; startedAt: number; durationMs: number; bounds?: Rect }
interface Column {
    readonly offsetX: number;
    readonly transition: Motion | undefined;
    setPanel(panel: Panel): void;
    update(): void;
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

describe('PDF document column beside a docked Motion Lab', function () {
    this.timeout(30_000);
    let dir: string;
    let plan: (viewport: Rect, pages: Rect[], panel?: Panel, appliedX?: number) => { offsetX: number; bounds?: Rect };
    let install: (container: any, options: any) => Column;
    let policy: { durationMs: number; offsetProperty: string };
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
        const clock = { now: 0, next: 0 };
        const frames = new Map<number, (at: number) => void>();
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
        return { api, pages, container, viewer, transit, media, visual, document, window, frames, transitions, observers, errors, makePage, releaseTransit,
            frame(at: number) {
                clock.now = at;
                for (const [id, callback] of [...frames]) { if (frames.delete(id)) { callback(at); } }
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

    it('leaves a column still when the dock fits in its existing blank margin or floats', () => {
        assert.strictEqual(plan(viewport, [page], panel('right', { rect: { x: 950, y: 0, width: 250, height: 800 } })).offsetX, 0);
        assert.strictEqual(plan(viewport, [page], panel('float')).offsetX, 0);
        assert.strictEqual(plan(viewport, [page], panel('right', { visible: false })).offsetX, 0);
        assert.strictEqual(plan(viewport, [page], panel('right', { rect: { x: 800, y: 900, width: 400, height: 100 } })).offsetX, 0);
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
            assert.strictEqual(f.pages[0].getBoundingClientRect().left - page.x, f.api.offsetX);
            assert.strictEqual(f.transit.getBoundingClientRect().left, f.api.offsetX);
            const origin = f.container.box.x + f.container.clientLeft - f.container.scrollLeft + f.api.offsetX;
            assert.strictEqual(f.pages[0].getBoundingClientRect().left - origin, page.x + f.container.scrollLeft,
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

    it('applies sidebar and zoom changes immediately and cancels the superseded frame', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel());
            f.frame(100);
            const stale = [...f.frames.values()][0];
            f.container.box.x = 200; f.container.box.width = f.container.clientWidth = 1000;
            f.pages[0].box.x = 350;
            f.observers[0].trigger();
            assert.strictEqual(f.api.offsetX, -150);
            assert.strictEqual(f.frames.size, 0);
            stale(300);
            assert.strictEqual(f.api.offsetX, -150);
            f.pages[0].box.x = 200; f.pages[0].box.width = 1000;
            f.api.update();
            assert.strictEqual(f.api.offsetX, 0);
            assert.strictEqual(f.pages[0].style.getPropertyValue('translate'), '');
        } finally { f.api.dispose(); }
    });

    it('starts a changed dock from the applied position and rejects an old callback', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel()); f.frame(100);
            const from = f.api.offsetX, first = f.api.transition!, stale = [...f.frames.values()][0];
            f.api.setPanel(panel('left', { reason: 'dock' }));
            assert.strictEqual(f.api.transition?.fromX, from);
            assert.strictEqual(f.api.transition?.toX, 116);
            assert.ok(f.api.transition!.id > first.id);
            stale(1000);
            assert.strictEqual(f.api.offsetX, from);
            assert.strictEqual(f.frames.size, 1);
            f.frame(100 + policy.durationMs);
            assert.strictEqual(f.api.offsetX, 116);
            assert.strictEqual(f.frames.size, 0);
        } finally { f.api.dispose(); }
    });

    it('clamps against the visible browser viewport and responds to its offset changes', () => {
        const f = fixture();
        try {
            f.api.setPanel(panel()); f.frame(policy.durationMs);
            f.visual.offsetLeft = 200; f.visual.width = 800;
            f.visual.emit('resize');
            assert.strictEqual(f.api.offsetX, -100, 'only the visible opposite margin is available');
            assert.strictEqual(f.frames.size, 0);
            f.visual.offsetLeft = 0; f.visual.width = 1400;
            f.visual.emit('scroll');
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
        const reduced = fixture(true);
        try {
            reduced.api.setPanel(panel());
            assert.strictEqual(reduced.api.offsetX, -116);
            assert.strictEqual(reduced.frames.size, 0);
            assert.strictEqual(reduced.transitions.length, 0);
        } finally { reduced.api.dispose(); }
        for (const boundary of ['hidden', 'reduced']) {
            const f = fixture();
            try {
                f.api.setPanel(panel()); f.frame(100);
                if (boundary === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
                else { f.media.matches = true; f.media.emit('change'); }
                assert.strictEqual(f.api.offsetX, -116);
                assert.strictEqual(f.frames.size, 0);
                assert.strictEqual(f.api.transition, undefined);
            } finally { f.api.dispose(); }
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
