import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

class Events {
    readonly listeners = new Map<string, Set<() => void>>();
    addEventListener(name: string, listener: () => void) {
        if (!this.listeners.has(name)) { this.listeners.set(name, new Set()); }
        this.listeners.get(name)!.add(listener);
    }
    removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
    emit(name: string) { for (const listener of this.listeners.get(name) ?? []) { listener(); } }
    get count() { return [...this.listeners.values()].reduce((sum, value) => sum + value.size, 0); }
}
class Element {
    readonly style: Record<string, string> = {};
    readonly dataset: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
    readonly children: Element[] = [];
    parentNode: Element | null = null;
    className = '';
    textContent = '';
    rect = { left: 0, top: 0, width: 800, height: 700 };
    objectFit = 'fill';
    constructor(readonly ownerDocument: any) {}
    get isConnected(): boolean { return this === this.ownerDocument.body || !!this.parentNode?.isConnected; }
    get clientWidth() { return this.rect.width; }
    get clientHeight() { return this.rect.height; }
    getBoundingClientRect() {
        const rect = this.style.position === 'fixed' && this.style.inset === '0'
            ? { left: 0, top: 0, width: this.ownerDocument.defaultView.innerWidth, height: this.ownerDocument.defaultView.innerHeight } : this.rect;
        return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height };
    }
    append(...children: Element[]) {
        for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); }
    }
    remove() {
        if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    }
    replaceChildren(...children: Element[]) { for (const child of [...this.children]) { child.remove(); } this.append(...children); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}
class Canvas extends Element {
    width = 0;
    height = 0;
    readonly copies: any[][] = [];
    readonly contextOptions: any[] = [];
    readonly transforms: number[][] = [];
    failCopy = false;
    noContext = false;
    readonly context = new Proxy({
        setTransform: (...values: number[]) => this.transforms.push(values),
        drawImage: (...args: any[]) => {
            if (this.failCopy && args.length === 9) { throw new Error('copy failed'); }
            this.copies.push(args);
        },
        getImageData: (_x: number, _y: number, width: number, height: number) => {
            const data = new Uint8ClampedArray(width * height * 4).fill(255);
            for (let y = 2; y < height; y++) {
                for (let x = 2; x < width; x++) {
                    const at = (y * width + x) * 4;
                    data[at] = (x * 17 + y * 31) % 200;
                    data[at + 1] = (x * 29) % 200;
                    data[at + 2] = (y * 13) % 200;
                }
            }
            return { data };
        },
    } as Record<string, any>, {
        get(target, key: string) {
            if (key in target) { return target[key]; }
            if (key === 'createLinearGradient' || key === 'createRadialGradient') { return () => ({ addColorStop() {} }); }
            return () => {};
        },
        set(target, key: string, value) { target[key] = value; return true; },
    });
    getContext(_kind?: string, options?: any) { this.contextOptions.push(options); return this.noContext ? null : this.context; }
}

class Fixture {
    now = 0;
    readonly callbacks = new Map<number, (at: number) => void>();
    readonly owned: Canvas[] = [];
    readonly observers: Array<{ disconnected: boolean }> = [];
    readonly document = new Events() as Events & Record<string, any>;
    readonly window = new Events() as Events & Record<string, any>;
    readonly media = new Events() as Events & { matches: boolean };
    readonly container: Element;
    readonly api: any;
    lab: any;
    private serial = 0;
    constructor(readonly module: any, options: Record<string, unknown> = {}) {
        this.media.matches = false;
        const fixture = this;
        Object.assign(this.window, {
            innerWidth: 800, innerHeight: 700, devicePixelRatio: 1,
            navigator: { userAgent: 'iPhone', maxTouchPoints: 5 },
            performance: { now: () => this.now },
            crypto: { getRandomValues: (values: Uint32Array) => { values[0] = 13; return values; } },
            getComputedStyle: (element: Element) => ({ objectFit: element.objectFit, objectPosition: '50% 50%' }),
            matchMedia: () => this.media,
            requestAnimationFrame: (callback: (at: number) => void) => { this.callbacks.set(++this.serial, callback); return this.serial; },
            cancelAnimationFrame: (id: number) => this.callbacks.delete(id),
        });
        for (const name of ['IntersectionObserver', 'ResizeObserver']) {
            this.window[name] = class {
                disconnected = false;
                constructor(_callback: unknown) { fixture.observers.push(this); }
                observe() {}
                disconnect() { this.disconnected = true; }
            };
        }
        Object.assign(this.document, {
            hidden: false, visibilityState: 'visible', defaultView: this.window,
            createElement: (tag: string) => tag === 'canvas' ? new Canvas(this.document) : new Element(this.document),
        });
        this.document.body = new Element(this.document);
        this.container = new Element(this.document);
        this.document.body.append(this.container);
        this.api = module.installPdfDocumentRobots(this.container, {
            seed: 13, now: () => this.now,
            createCanvas: () => { const image = new Canvas(this.document); this.owned.push(image); return image; },
            ...options,
        });
    }
    page(number = 1) {
        const element = new Element(this.document);
        element.dataset.pageNumber = String(number);
        element.rect = { left: 40, top: 60, width: 400, height: 600 };
        const source = new Canvas(this.document);
        source.width = 4320; source.height = 6480;
        const text = new Element(this.document);
        text.className = 'textLayer';
        element.append(source, text);
        this.container.append(element);
        return { pageNumber: number, pageElement: element, canvas: source, kind: 'page' as const, text };
    }
    desktop(dpr = 1, width = 1076, height = 1459) {
        Object.assign(this.window, { innerWidth: width, innerHeight: height, devicePixelRatio: dpr,
            navigator: { userAgent: 'Linux x86_64', maxTouchPoints: 0 } });
        this.container.rect = { left: 0, top: 32, width, height: height - 32 };
    }
    spread() {
        return [21, 22, 23, 24].map((number, index) => {
            const page = this.page(number);
            page.pageElement.rect = { left: index % 2 ? 520 : 40, top: index < 2 ? 32 : 708, width: 465, height: 661 };
            return page;
        });
    }
    frame() {
        // Cross the 30 Hz draw boundary explicitly instead of relying on floating equality.
        this.now += 34;
        const pending = [...this.callbacks.values()];
        this.callbacks.clear();
        for (const callback of pending) { callback(this.now); }
    }
    finish() { for (let step = 0; step < 150 && this.callbacks.size; step++) { this.frame(); } }
    openLab() {
        const stage = new Element(this.document);
        this.document.body.append(stage);
        this.lab = this.module.installPrefetchRobots(stage);
        this.lab.setActive(true);
        const canvas = stage.children[0] as Canvas;
        canvas.rect = { left: 500, top: 40, width: 300, height: 86 };
        canvas.objectFit = 'contain';
        return { stage, canvas, lab: this.lab };
    }
    dispose() {
        this.api.dispose();
        this.lab?.dispose();
        assert.strictEqual(this.callbacks.size, 0);
        assert.strictEqual(this.document.count + this.window.count + this.media.count, 0);
        assert.ok(this.observers.every(observer => observer.disconnected));
        assert.ok(this.owned.every(canvas => canvas.width * canvas.height === 0), 'every temporary, cargo and sprite bitmap is released');
    }
}

describe('actual PDF fragments delivered by the document robot fleet', function () {
    this.timeout(30 * 1000);
    let directory: string;
    let module: any;
    const fixtures: Fixture[] = [];
    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts/build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-document-robots-'));
        try {
            await esbuild.build({ ...bundleOptions, entryPoints: [path.join(viewerRoot, 'src/common/pdf-document-robots.ts')], outfile: path.join(directory, 'document.mjs') });
            await esbuild.build({ ...bundleOptions, entryPoints: [path.join(viewerRoot, 'src/common/prefetch-robots.ts')], outfile: path.join(directory, 'artwork.mjs') });
            module = { ...await importModule(path.join(directory, 'document.mjs')), ...await importModule(path.join(directory, 'artwork.mjs')) };
        } finally { await esbuild.stop(); }
    });
    afterEach(() => { for (const fixture of fixtures.splice(0)) { fixture.dispose(); } });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });
    function fixture(options: Record<string, unknown> = {}) {
        const result = new Fixture(module, options);
        fixtures.push(result);
        return result;
    }

    it('copies real bounded fragments into a transparent viewport transit layer and finishes without idle frames', () => {
        const f = fixture();
        const page = f.page();
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.deliver(page), true);
        const began = f.api.snapshot();
        assert.ok(began.activeActors >= 2 && began.activeActors <= began.maxActors);
        const copies = f.owned.flatMap(canvas => canvas.copies).filter(args => args.length === 9);
        assert.strictEqual(copies.length, began.activeActors, 'each courier carries actual pixels copied from the ready canvas');
        assert.ok(copies.every(args => args[0] === page.canvas && args[3] < page.canvas.width && args[4] < page.canvas.height));
        assert.ok(f.owned.every(canvas => Math.max(canvas.width, canvas.height) <= module.DOCUMENT_ROBOT_LIMITS.fragmentDimension));
        const transit = f.document.body.children.find((child: Element) => child.className === 'pdfDocumentRobotTransit')!;
        assert.strictEqual(transit.style.position, 'fixed');
        assert.strictEqual(transit.style.zIndex, '2147483647', 'departing actors stay visible above the optional lab');
        assert.strictEqual(transit.style.pointerEvents, 'none');
        assert.strictEqual(transit.attributes.get('aria-hidden'), 'true');
        assert.ok(f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotCargo').every(canvas => canvas.contextOptions[0]?.alpha === true),
            'copied PDF fragments preserve source alpha');
        assert.deepStrictEqual(page.pageElement.children, [page.canvas, page.text], 'the real canvas and selectable text remain untouched');
        for (const episode of transit.children) {
            assert.strictEqual(episode.style.pointerEvents, 'none');
            assert.ok(episode.children.every((child: Element) => child.style.pointerEvents === 'none'));
        }
        f.finish();
        const ended = f.api.snapshot();
        assert.strictEqual(ended.deliveredFragments, began.activeActors);
        assert.strictEqual(ended.activeEpisodes + ended.activeActors + ended.retainedBytes, 0);
        assert.strictEqual(ended.scheduled, false);
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(transit.parentNode, null);
        assert.deepStrictEqual([page.canvas.width, page.canvas.height], [4320, 6480]);
    });

    it('clips couriers and cargo below the toolbar and follows the visible viewer during an active lab departure', () => {
        const f = fixture();
        f.container.rect = { left: 40, top: 120, width: 640, height: 520 };
        const { lab, canvas } = f.openLab();
        canvas.rect = { left: 450, top: 200, width: 140, height: 70 };
        f.api.setDispatchOrigin(lab.dispatch);
        const page = f.page();
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.deliver(page), true);
        const transit = f.document.body.children.find((child: Element) => child.className === 'pdfDocumentRobotTransit')!;
        assert.strictEqual(transit.style.clipPath, 'inset(120px 120px 60px 40px)', 'the entire fixed overlay is clipped away from toolbar controls');
        assert.ok(f.api.snapshot().pages[0].actors.every((actor: any) => actor.fromLab), 'clipping keeps the real lab departure');

        f.window.visualViewport = { offsetLeft: 100, offsetTop: 80, width: 500, height: 470 };
        f.frame();
        assert.strictEqual(transit.style.clipPath, 'inset(120px 200px 150px 100px)', 'pinch and browser chrome restrict the clip to the visual viewport');
        f.container.rect.top = 180;
        f.window.visualViewport = { offsetLeft: 130, offsetTop: 160, width: 420, height: 360 };
        f.frame();
        assert.strictEqual(transit.style.clipPath, 'inset(180px 250px 180px 130px)', 'active animation tracks viewer and viewport changes');
        f.finish();
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(transit.parentNode, null);

        const next = f.page(2);
        f.api.setVisiblePages([2]);
        assert.strictEqual(f.api.deliver(next), true);
        for (const actor of f.api.snapshot().pages[0].actors) {
            const crop = actor.target;
            assert.ok(40 + crop.x * 400 >= 130 - 1e-6 && 60 + crop.y * 600 >= 180 - 1e-6, 'source fragments start inside the visible PDF region');
            assert.ok(40 + (crop.x + crop.width) * 400 <= 550 + 1e-6 && 60 + (crop.y + crop.height) * 600 <= 520 + 1e-6,
                'source fragments finish inside the visible PDF region');
        }
    });

    it('fills the measured desktop spread with a large crisp crew and accounts every sprite backing byte', () => {
        for (const dpr of [1, 2, 3]) {
            const f = fixture();
            f.desktop(dpr);
            const pages = f.spread();
            f.api.setVisiblePages(pages.map(page => page.pageNumber));
            for (const page of pages) { assert.strictEqual(f.api.deliver(page), true); }
            const state = f.api.snapshot();
            assert.strictEqual(state.maxActors, 12);
            assert.strictEqual(state.activeActors, 12, 'four full 465 by 661 pages receive three couriers each');
            assert.strictEqual(state.maxCargoBytes, 3 * 1024 * 1024);
            assert.strictEqual(state.maxSpriteBytes, 24 * 1024 * 1024);
            assert.ok(state.cargoBytes <= state.maxCargoBytes && state.spriteBytes <= state.maxSpriteBytes);
            for (let i = 0; i < 12; i++) { f.frame(); }
            const sprites = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width);
            assert.strictEqual(sprites.length, 12);
            for (const sprite of sprites) {
                assert.ok(Math.abs(parseFloat(sprite.style.width) - 128 * 1.92) < 0.02, 'desktop bodies are three times the previous apparent size');
                assert.deepStrictEqual([sprite.width, sprite.height], [Math.ceil(128 * 1.92 * dpr), Math.ceil(100 * 1.92 * dpr)]);
                assert.ok(sprite.transforms.some(values => values[0] > 1.9 * dpr && values[3] > 1.9 * dpr), 'artwork is redrawn into display-resolution backing');
            }
            assert.strictEqual(f.api.snapshot().spriteBytes, sprites.reduce((bytes, sprite) => bytes + sprite.width * sprite.height * 4, 0));
            assert.strictEqual(f.api.snapshot().retainedBytes, f.owned.reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0));
            if (dpr === 1) {
                const before = f.api.snapshot().spriteBytes;
                f.window.innerWidth = f.container.rect.width = 860;
                f.frame();
                assert.ok(f.api.snapshot().spriteBytes < before, 'an active resize redraws smaller backing instead of leaving oversized sprites');
                assert.ok(sprites.every(sprite => parseFloat(sprite.style.width) < 210));
            }
            f.finish();
            assert.strictEqual(f.api.snapshot().retainedBytes, 0);
            assert.strictEqual(f.callbacks.size, 0);
        }
    });

    it('keeps rotated mobile and narrow views compact while sharing the cache device policy', () => {
        const profiles = [
            { device: undefined, agent: 'iPhone', touch: 5, width: 844, height: 390 },
            { device: undefined, agent: 'Macintosh', touch: 5, width: 1366, height: 1024 },
            { device: undefined, agent: 'Windows NT 10.0', touch: 10, width: 600, height: 900 },
            { device: 'mobile', agent: 'Windows NT 10.0', touch: 10, width: 1076, height: 1459 },
        ];
        for (const profile of profiles) {
            const f = fixture({ device: profile.device });
            f.desktop(3, profile.width, profile.height);
            f.window.navigator = { userAgent: profile.agent, maxTouchPoints: profile.touch };
            const pages = [1, 2, 3, 4].map(id => f.page(id));
            f.api.setVisiblePages([1, 2, 3, 4]);
            for (const page of pages) { f.api.deliver(page); }
            const state = f.api.snapshot();
            assert.strictEqual(state.maxActors, 4);
            assert.strictEqual(state.maxCargoBytes, 512 * 1024);
            assert.strictEqual(state.maxSpriteBytes, 4 * 128 * 100 * 4);
            assert.ok(state.activeActors <= 4 && state.cargoBytes <= 512 * 1024 && state.spriteBytes <= state.maxSpriteBytes);
            assert.ok(f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle').every(canvas => canvas.width === 128 && canvas.height === 100));
        }
        const touchscreenDesktop = fixture();
        touchscreenDesktop.desktop();
        touchscreenDesktop.window.navigator = { userAgent: 'Windows NT 10.0', maxTouchPoints: 10 };
        assert.strictEqual(touchscreenDesktop.api.snapshot().maxActors, 12, 'a touchscreen desktop uses the same desktop policy as the PDF cache');
    });

    it('defers edge slivers without spending the one-delivery budget or allocating fragments', () => {
        const f = fixture();
        f.desktop();
        const page = f.page();
        page.pageElement.rect = { left: 40, top: 1446, width: 465, height: 661 };
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer(page), 'deferred');
        assert.strictEqual(f.api.hasHandled(1), false);
        assert.strictEqual(f.owned.length, 0);
        assert.strictEqual(f.callbacks.size, 0);
        page.pageElement.rect.top = 400;
        assert.strictEqual(f.api.offer(page), 'started');
        assert.strictEqual(f.api.hasHandled(1), true);
        f.finish();
        const allocations = f.owned.length;
        assert.strictEqual(f.api.offer(page), 'skipped');
        assert.strictEqual(f.owned.length, allocations);
    });

    it('wakes a busy visible-page queue once after a release batch without idle polling', () => {
        let available = 0;
        const f = fixture({ maxActors: 2, onCapacityAvailable: () => available++ });
        const first = f.page(1), next = f.page(2);
        f.api.setVisiblePages([1, 2]);
        assert.strictEqual(f.api.offer(first), 'started');
        assert.strictEqual(f.api.offer(next), 'busy');
        assert.strictEqual(f.api.hasHandled(2), false);
        assert.strictEqual(available, 0);
        f.now += 5000; f.frame();
        assert.strictEqual(available, 1, 'multiple finishing couriers coalesce into one capacity notification');
        assert.strictEqual(f.callbacks.size, 0, 'the host callback, not an idle frame loop, admits the waiting page');
        assert.strictEqual(f.api.offer(next), 'started');
        f.finish();
        assert.strictEqual(available, 1, 'there is no notification without a blocked offer');
        const third = f.page(3), fourth = f.page(4);
        f.api.setVisiblePages([3, 4]);
        assert.strictEqual(f.api.offer(third), 'started');
        assert.strictEqual(f.api.offer(fourth), 'busy');
        f.api.setVisiblePages([4]);
        assert.strictEqual(available, 2, 'dropping an obsolete page also releases the queue');
    });

    it('suppresses queued capacity notifications after reset, hide, disable and disposal', () => {
        for (const ending of ['reset', 'hide', 'disable', 'dispose']) {
            let available = 0;
            const f = fixture({ maxActors: 2, onCapacityAvailable: () => available++ });
            const first = f.page(1), next = f.page(2);
            f.api.setVisiblePages([1, 2]);
            assert.strictEqual(f.api.offer(first), 'started');
            assert.strictEqual(f.api.offer(next), 'busy');
            const late = [...f.callbacks.values()];
            if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else { f.api[ending](); }
            for (const callback of late) { callback(f.now + 10000); }
            assert.strictEqual(available, 0, ending + ' cannot wake a retired controller');
            assert.strictEqual(f.api.snapshot().retainedBytes, 0);
            assert.strictEqual(f.callbacks.size, 0);
        }
    });

    it('resumes a saturated visible-page queue after reduced motion without waking retired documents', () => {
        for (const ending of ['resume', 'reset', 'hide', 'disable', 'dispose']) {
            let available = 0;
            const f = fixture({ maxActors: 2, onCapacityAvailable: () => available++ });
            const first = f.page(1), next = f.page(2);
            f.api.setVisiblePages([1, 2]);
            assert.strictEqual(f.api.offer(first), 'started');
            assert.strictEqual(f.api.offer(next), 'busy');
            f.media.matches = true;
            f.media.emit('change');
            assert.strictEqual(f.api.snapshot().retainedBytes, 0);
            assert.strictEqual(f.callbacks.size, 0);
            assert.strictEqual(available, 0, 'reduced motion starts no replacement episode');
            if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else if (ending !== 'resume') { f.api[ending](); }
            f.media.matches = false;
            f.media.emit('change');
            assert.strictEqual(available, ending === 'resume' ? 1 : 0, 'only the current visible queue wakes on motion resume');
            assert.strictEqual(f.callbacks.size, 0, 'motion resume needs no renderer polling loop');
            if (ending === 'resume') {
                assert.strictEqual(f.api.hasHandled(1), true);
                assert.strictEqual(f.api.hasHandled(2), false);
                assert.strictEqual(f.api.offer(next), 'started');
                f.finish();
                assert.strictEqual(available, 1);
            }
        }
    });

    it('enlarges desktop lab departures continuously while borrowing each actual actor only once', () => {
        const f = fixture();
        f.desktop(2);
        const { lab } = f.openLab();
        f.api.setDispatchOrigin(lab.dispatch);
        const pages = f.spread();
        f.api.setVisiblePages(pages.map(page => page.pageNumber));
        for (const page of pages) { f.api.offer(page); }
        const actors = f.api.snapshot().pages.flatMap((page: any) => page.actors);
        assert.strictEqual(actors.length, module.ROBOT_VEHICLES.length);
        assert.strictEqual(new Set(actors.map((actor: any) => actor.vehicle)).size, actors.length);
        assert.strictEqual(lab.snapshot().actors.filter((actor: any) => actor.outside).length, actors.length);
        const sprites = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width);
        assert.ok(sprites.every(sprite => Math.abs(parseFloat(sprite.style.width) - 128 * 86 / 250) < 0.02));
        f.now += 700; f.frame();
        assert.ok(sprites.every(sprite => Math.abs(parseFloat(sprite.style.width) - 128 * 1.92) < 0.02));
        f.finish();
        assert.ok(lab.snapshot().actors.every((actor: any) => !actor.outside));
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
    });

    it('coalesces preview and native readiness and never replays a delivered page on revisit or zoom', () => {
        const f = fixture();
        const page = f.page();
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.deliver({ ...page, kind: 'preview' }), true);
        const count = f.owned.length;
        assert.strictEqual(f.api.deliver(page), false);
        assert.strictEqual(f.owned.length, count, 'a native upgrade does not allocate a second episode');
        f.finish();
        f.api.setVisiblePages([]);
        page.pageElement.rect.width = 600;
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.deliver(page), false);
        f.api.reset();
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.deliver(page), true, 'a new document/build may deliver the same page number');
    });

    it('tracks resized page anchors and places the real cargo exactly over its source region', () => {
        const f = fixture();
        const page = f.page();
        f.api.setVisiblePages([1]);
        f.api.deliver(page);
        const first = f.api.snapshot().pages[0].actors[0];
        for (let frame = 0; frame < 120; frame++) {
            f.frame();
            const actor = f.api.snapshot().pages[0]?.actors.find((candidate: any) => candidate.id === first.id);
            if (actor?.deposited) { break; }
        }
        page.pageElement.rect = { left: 75, top: 20, width: 500, height: 650 };
        f.frame();
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.dataset.courier === String(first.id))!;
        const match = cargo.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)!;
        assert.ok(Math.abs(Number(match[1]) - (75 + first.target.x * 500)) < 0.02);
        assert.ok(Math.abs(Number(match[2]) - (20 + first.target.y * 650)) < 0.02);
        assert.ok(Math.abs(parseFloat(cargo.style.width) - first.target.width * 500) < 0.02);
        assert.ok(Math.abs(parseFloat(cargo.style.height) - first.target.height * 650) < 0.02);
    });

    it('bounds fast-traverse resources and fences old callbacks after visibility removal, replacement and disposal', () => {
        const f = fixture({ maxActors: 3, maxCargoBytes: 120000 });
        let stale: ((at: number) => void) | undefined;
        for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
            const page = f.page(pageNumber);
            f.api.setVisiblePages([pageNumber]);
            f.api.deliver(page);
            stale ??= [...f.callbacks.values()][0];
            const state = f.api.snapshot();
            assert.ok(state.activeActors <= 3);
            assert.ok(state.cargoBytes <= 120000);
            assert.ok(state.retainedBytes <= 120000 + 3 * module.ROBOT_ARTWORK_SIZE.width * module.ROBOT_ARTWORK_SIZE.height * 4);
        }
        const active = f.api.snapshot();
        stale!(f.now + 10000);
        assert.strictEqual(f.api.snapshot().activeActors, active.activeActors, 'an obsolete RAF cannot advance a newer episode');
        f.api.setVisiblePages([]);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
        f.api.reset();
        const page = f.page(1);
        f.api.setVisiblePages([1]); f.api.deliver(page);
        const pending = [...f.callbacks.values()];
        f.api.dispose();
        for (const callback of pending) { callback(f.now + 10000); }
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('varies vehicle combinations and arrival routes instead of replaying one full scene', () => {
        const f = fixture();
        const vehicles = new Set<string>(), routes = new Set<number>(), combinations = new Set<string>();
        for (let id = 1; id <= 12; id++) {
            const page = f.page(id);
            f.api.setVisiblePages([id]); f.api.deliver(page);
            const actors = f.api.snapshot().pages[0].actors;
            assert.strictEqual(new Set(actors.map((actor: any) => actor.vehicle)).size, actors.length);
            for (const actor of actors) { vehicles.add(actor.vehicle); routes.add(actor.route); }
            combinations.add(actors.map((actor: any) => actor.vehicle).join(','));
            f.finish();
        }
        assert.strictEqual(vehicles.size, module.ROBOT_VEHICLES.length);
        assert.strictEqual(routes.size, 4);
        assert.ok(combinations.size >= 6);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('reserves the actual lab actor once and maps its compact letterboxed canvas into viewport coordinates', () => {
        const f = fixture();
        const { lab, canvas } = f.openLab();
        canvas.copies.length = 0;
        const origin = lab.dispatch.reserve('quad');
        assert.ok(Math.abs(origin.x - (500 + (300 - 480 * 86 / 250) / 2 + 80 * 86 / 250)) < 0.0001);
        assert.ok(Math.abs(origin.y - (40 + 54 * 86 / 250)) < 0.0001);
        assert.ok(Math.abs(origin.scale - 86 / 250) < 0.0001);
        assert.strictEqual(lab.dispatch.reserve('quad'), undefined, 'the same vehicle cannot be loaned twice');
        assert.strictEqual(lab.snapshot().actors.find((actor: any) => actor.vehicle === 'quad').outside, true);
        assert.strictEqual(canvas.copies.length, module.ROBOT_VEHICLES.length, 'the lab redraw excludes the borrowed body but keeps its background');
        canvas.rect.left += 50;
        assert.ok(Math.abs(lab.dispatch.destination('quad').x - origin.x - 50) < 0.0001);
        lab.dispatch.release('quad');
        assert.strictEqual(lab.snapshot().actors.find((actor: any) => actor.vehicle === 'quad').outside, false);
    });

    it('loans distinct lab actors, returns them after delivery, and releases them on source close or page cancellation', () => {
        const f = fixture();
        const { lab } = f.openLab();
        f.api.setDispatchOrigin(lab.dispatch);
        for (const ending of ['return', 'source close', 'page cancelled']) {
            const page = f.page(ending === 'return' ? 1 : ending === 'source close' ? 2 : 3);
            f.api.setVisiblePages([page.pageNumber]);
            assert.strictEqual(f.api.deliver(page), true);
            const actors = f.api.snapshot().pages[0].actors;
            assert.ok(actors.every((actor: any) => actor.fromLab));
            for (const actor of actors) {
                const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(actor.id))!;
                assert.ok(Math.abs(parseFloat(sprite.style.width) - module.ROBOT_ARTWORK_SIZE.width * 86 / 250) < 0.02,
                    'every departing body begins at its visible compact-lab scale');
                assert.strictEqual(sprite.style.opacity, '1', 'every visible lab actor is replaced immediately without a staggered-launch gap');
            }
            assert.strictEqual(lab.snapshot().actors.filter((actor: any) => actor.outside).length, actors.length);
            if (ending === 'source close') { f.api.setDispatchOrigin(undefined); lab.setActive(false); }
            if (ending === 'page cancelled') { f.api.setVisiblePages([]); }
            f.finish();
            assert.ok(lab.snapshot().actors.every((actor: any) => !actor.outside));
            assert.strictEqual(f.api.snapshot().retainedBytes, 0);
            assert.strictEqual(f.callbacks.size, 0);
            if (ending === 'source close') { lab.setActive(true); f.api.setDispatchOrigin(lab.dispatch); }
        }
    });

    it('skips moving cargo for reduced motion and releases active effects immediately when hidden or disabled', () => {
        const f = fixture();
        const page = f.page();
        f.api.setVisiblePages([1]);
        f.media.matches = true;
        assert.strictEqual(f.api.deliver(page), false);
        assert.strictEqual(f.owned.length, 0);
        assert.strictEqual(f.callbacks.size, 0);
        f.media.matches = false;
        f.api.reset(); f.api.setVisiblePages([1]); f.api.deliver(page);
        f.document.hidden = true;
        f.document.emit('visibilitychange');
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
        f.document.hidden = false;
        f.api.reset(); f.api.setVisiblePages([1]); f.api.deliver(page);
        f.api.setEnabled(false);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('releases copied fragments and borrowed lab actors if the viewport transit layer cannot be attached', () => {
        const f = fixture();
        const { lab } = f.openLab();
        f.api.setDispatchOrigin(lab.dispatch);
        const page = f.page();
        f.api.setVisiblePages([1]);
        const body = f.document.body as Element;
        const original = body.append;
        body.append = (...children: Element[]) => {
            if (children.some(child => child.className === 'pdfDocumentRobotTransit')) { throw new Error('transit attachment failed'); }
            original.apply(body, children);
        };
        try { assert.strictEqual(f.api.deliver(page), false); }
        finally { body.append = original; }
        assert.ok(lab.snapshot().actors.every((actor: any) => !actor.outside));
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
        assert.ok(f.owned.every(canvas => canvas.width * canvas.height === 0));
    });

    it('releases a borrowed lab actor and every temporary bitmap when artwork allocation fails', () => {
        const f = fixture();
        const { lab } = f.openLab();
        f.api.setDispatchOrigin(lab.dispatch);
        const page = f.page();
        f.api.setVisiblePages([1]);
        const original = Canvas.prototype.getContext;
        Canvas.prototype.getContext = function () {
            return this.width === module.ROBOT_ARTWORK_SIZE.width && this.height === module.ROBOT_ARTWORK_SIZE.height
                ? null : original.call(this);
        };
        try { assert.strictEqual(f.api.deliver(page), false); }
        finally { Canvas.prototype.getContext = original; }
        assert.ok(lab.snapshot().actors.every((actor: any) => !actor.outside));
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
        assert.ok(f.owned.every(canvas => canvas.width * canvas.height === 0));
    });
});
