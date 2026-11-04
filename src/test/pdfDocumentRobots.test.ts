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
    scrollLeft = 0;
    scrollTop = 0;
    constructor(readonly ownerDocument: any) {}
    get isConnected(): boolean { return this === this.ownerDocument.body || !!this.parentNode?.isConnected; }
    get clientWidth() { return this.rect.width; }
    get clientHeight() { return this.rect.height; }
    get firstElementChild() { return this.children[0] ?? null; }
    getBoundingClientRect() {
        const parent = this.parentNode;
        const rect = this.style.position === 'fixed' && this.style.inset === '0'
            ? { left: 0, top: 0, width: this.ownerDocument.defaultView.innerWidth, height: this.ownerDocument.defaultView.innerHeight }
            : this.className === 'pdfDocumentRobotTransit' && this.style.position === 'absolute' && parent
                ? { left: parent.rect.left - parent.scrollLeft, top: parent.rect.top - parent.scrollTop, width: 0, height: 0 }
                : this.rect;
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
    private pixelWidth = 0;
    zeroWrites = 0;
    get width() { return this.pixelWidth; }
    set width(value: number) { if (value === 0) { this.zeroWrites++; } this.pixelWidth = value; }
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
        Object.assign(this.container.style, { position: 'absolute', overflow: 'auto' });
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
        this.tick(34);
    }
    tick(milliseconds: number) {
        this.now += milliseconds;
        const pending = [...this.callbacks.values()];
        this.callbacks.clear();
        for (const callback of pending) { callback(this.now); }
    }
    scroll(x: number, y: number) {
        this.container.scrollLeft += x; this.container.scrollTop += y;
        for (const page of this.container.children.filter(child => child.dataset.pageNumber)) {
            page.rect.left -= x; page.rect.top -= y;
        }
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

    function cooperative(mode?: string, helpers = 2, useLab = false) {
        const f = fixture({ maxActors: helpers });
        f.desktop();
        if (useLab) { f.api.setDispatchOrigin(f.openLab().lab.dispatch); }
        for (let id = 1; id <= 12; id++) {
            const page = f.page(id);
            page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
            f.api.setVisiblePages([id]);
            f.api.offer(page);
            const payload = f.api.snapshot().pages[0]?.payloads?.find((candidate: any) => candidate.helpers.length === helpers
                && (!mode || candidate.mode === mode));
            if (payload) { return { f, page, payload }; }
            f.finish();
        }
        assert.fail('a varied delivery sequence includes a real shared payload for ' + helpers + ' helpers' + (mode ? ' in ' + mode : ''));
    }

    function point(canvas: Canvas) {
        const match = canvas.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)!;
        let transit: Element | null = canvas;
        while (transit && transit.className !== 'pdfDocumentRobotTransit') { transit = transit.parentNode; }
        const origin = transit?.getBoundingClientRect() ?? { left: 0, top: 0 };
        return { x: Number(match[1]) + parseFloat(canvas.style.width) / 2 + origin.left,
            y: Number(match[2]) + parseFloat(canvas.style.height) / 2 + origin.top };
    }

    function work(pages: ReturnType<Fixture['page']>[], states = pages.map(() => 'waiting'), key = pages.map(page => page.pageNumber).join(':')) {
        return { key, pages: pages.map((page, index) => ({ pageNumber: page.pageNumber, pageElement: page.pageElement,
            label: String(page.pageNumber - 11), state: states[index] })) };
    }

    it('lets compositor scrolling carry real cargo and couriers between document paints', () => {
        const f = fixture();
        f.container.scrollLeft = 25; f.container.scrollTop = 900;
        const page = f.page();
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer(page), 'started');
        f.frame();
        const images = f.owned.filter(canvas => canvas.width && canvas.style.transform
            && ['pdfDocumentRobotCargo', 'pdfDocumentRobotVehicle'].includes(canvas.className));
        assert.ok(images.some(canvas => canvas.className === 'pdfDocumentRobotCargo')
            && images.some(canvas => canvas.className === 'pdfDocumentRobotVehicle'));
        const before = images.map(point), transforms = images.map(canvas => canvas.style.transform);
        const frames = f.api.snapshot().frames, allocated = f.owned.length;
        f.scroll(11, 26);
        images.forEach((canvas, index) => {
            const moved = point(canvas);
            assert.ok(Math.abs(moved.x - before[index].x + 11) < 0.02, 'horizontal scrolling carries the actor without a paint');
            assert.ok(Math.abs(moved.y - before[index].y + 26) < 0.02, 'vertical scrolling carries the actor without a paint');
            assert.strictEqual(canvas.style.transform, transforms[index], 'no scripted transform update is needed');
        });
        assert.strictEqual(f.api.snapshot().frames, frames);
        assert.strictEqual(f.owned.length, allocated);
        assert.deepStrictEqual(page.pageElement.children, [page.canvas, page.text]);
    });

    it('carries a parked advance crew with the document and promotes its actual scrolled position', () => {
        const f = fixture(); f.desktop();
        const pages = [f.page(99), f.page(100)]; pages[1].pageElement.rect.left = 540;
        f.api.setVisibleWork([work(pages)]); f.finish();
        const ids = f.api.snapshot().advance[0].actors.map((actor: any) => actor.id);
        const sprites = f.owned.filter(canvas => ids.includes(Number(canvas.dataset.courier)));
        const before = sprites.map(point), frames = f.api.snapshot().frames;
        f.scroll(8, 40);
        const moved = sprites.map(point);
        moved.forEach((location, index) => assert.ok(Math.hypot(location.x - before[index].x + 8,
            location.y - before[index].y + 40) < 0.02, 'parked bodies scroll without an idle RAF'));
        assert.strictEqual(f.api.snapshot().frames, frames);
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(f.api.offer(pages[0]), 'started');
        const promoted = f.api.snapshot().pages[0].actors;
        assert.ok(promoted.some((actor: any) => ids.includes(actor.id)), 'at least one staged actor is actually promoted');
        sprites.forEach((sprite, index) => {
            if (!promoted.some((actor: any) => actor.id === Number(sprite.dataset.courier))) { return; }
            const start = point(sprite);
            assert.ok(Math.hypot(start.x - moved[index].x, start.y - moved[index].y) < 1, 'promotion starts at the composited position');
        });
    });

    it('keeps a parked crew page-relative after an ordinary refresh crosses the viewport edge', () => {
        const f = fixture(); f.desktop();
        const page = f.page();
        f.api.setVisibleWork([work([page])]); f.finish();
        const ids = f.api.snapshot().advance[0].actors.map((actor: any) => actor.id);
        const sprites = f.owned.filter(canvas => ids.includes(Number(canvas.dataset.courier)));
        assert.ok(sprites.length > 0);
        const original = sprites.map(point);
        f.scroll(100, 100);
        const composited = sprites.map(point);
        composited.forEach((location, index) => assert.ok(Math.hypot(location.x - original[index].x + 100,
            location.y - original[index].y + 100) < 0.02));
        f.api.setVisibleWork([work([page])]);
        f.finish();
        sprites.forEach((sprite, index) => {
            const refreshed = point(sprite);
            assert.ok(Math.hypot(refreshed.x - composited[index].x, refreshed.y - composited[index].y) < 0.02,
                'clipping the visible page slice must not move an already parked crew');
        });
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(f.api.snapshot().advance[0].phase, 'parked');
    });

    it('keeps a captured lab launch attached to the document on later paints during scrolling', () => {
        const fixtures = [fixture({ maxActors: 1 }), fixture({ maxActors: 1 })];
        for (const f of fixtures) {
            f.api.setDispatchOrigin({ reserve: () => ({ x: 700, y: 110, scale: 0.5 }),
                destination: () => ({ x: 700, y: 110, scale: 0.5 }), release() {} });
            const page = f.page(); f.api.setVisiblePages([1]); f.api.offer(page); f.frame();
        }
        fixtures[1].scroll(17, 31);
        fixtures.forEach(f => f.frame());
        const positions = fixtures.map(f => point(f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width)!));
        assert.ok(Math.abs(positions[1].x - positions[0].x + 17) < 0.02);
        assert.ok(Math.abs(positions[1].y - positions[0].y + 31) < 0.02, 'the next paint preserves the compositor displacement of a launched actor');
    });

    it('keeps the 30 Hz document paint budget without accumulating 50 ms cadence gaps', () => {
        const f = fixture();
        const page = f.page(); f.api.setVisiblePages([1]); f.api.offer(page);
        const started = f.api.snapshot().frames;
        const paints: number[] = [];
        for (let tick = 0; tick < 60; tick++) {
            const before = f.api.snapshot().frames;
            f.tick(1000 / 60);
            if (f.api.snapshot().frames > before) { paints.push(f.now); }
        }
        assert.ok(f.api.snapshot().frames - started >= 29, 'fractional frame time is retained between capped paints');
        assert.ok(f.api.snapshot().frames - started <= 30, 'the cap is not bypassed');
        assert.ok(paints.slice(1).every((time, index) => time - paints[index] <= 34), 'regular 60 Hz input does not become 20 Hz motion');
    });

    it('coalesces rapid visible-work updates through the same paint cap and keeps the final state', () => {
        const f = fixture(); f.desktop();
        const page = f.page(); f.api.setVisibleWork([work([page])]); f.finish();
        const ids = f.api.snapshot().advance[0].actors.map((actor: any) => actor.id);
        const sprites = f.owned.filter(canvas => ids.includes(Number(canvas.dataset.courier)));
        const mean = () => sprites.map(point).reduce((sum, value) => ({ x: sum.x + value.x / sprites.length,
            y: sum.y + value.y / sprites.length }), { x: 0, y: 0 });
        const original = mean(), originalPage = { ...page.pageElement.rect };
        const frames = f.api.snapshot().frames, allocated = f.owned.length;
        for (let tick = 0; tick < 60; tick++) {
            f.tick(1000 / 60);
            f.scroll(0.1, 0.5);
            for (let update = 0; update < 4; update++) {
                f.api.setVisibleWork([work([page], [(tick + update) % 2 ? 'waiting' : 'preparing'])]);
            }
        }
        assert.ok(f.api.snapshot().frames - frames <= module.DOCUMENT_ROBOT_LIMITS.maxFps,
            'synchronous visible-work refreshes cannot bypass the animation paint budget');
        page.pageElement.rect.width = 500; page.pageElement.rect.height = 650;
        const final = work([page], ['preparing']); final.pages[0].label = 'final';
        f.api.setVisibleWork([final]); f.finish();
        const finished = f.api.snapshot();
        assert.ok(finished.advance[0].message.includes('Preparing page final'));
        assert.strictEqual(finished.advance[0].phase, 'parked');
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(f.owned.length, allocated);
        const actual = mean();
        assert.ok(Math.abs(actual.x - (page.pageElement.rect.left + (original.x - originalPage.left) / originalPage.width * 500)) < 0.02);
        assert.ok(Math.abs(actual.y - (page.pageElement.rect.top + (original.y - originalPage.top) / originalPage.height * 650)) < 0.02);
    });

    it('gives parked geometry one deferred paint and accepts capacity-driven cargo during that paint', () => {
        const parked = fixture(); parked.desktop();
        const page = parked.page(); parked.api.setVisibleWork([work([page])]); parked.finish();
        const frames = parked.api.snapshot().frames;
        page.pageElement.rect.width += 10;
        for (let update = 0; update < 20; update++) { parked.api.setVisibleWork([work([page])]); }
        assert.strictEqual(parked.api.snapshot().frames, frames, 'a parked refresh inside the current frame interval is coalesced');
        assert.strictEqual(parked.callbacks.size, 1);
        parked.finish();
        assert.strictEqual(parked.api.snapshot().frames, frames + 1);
        assert.strictEqual(parked.callbacks.size, 0);

        let f: Fixture, second: ReturnType<Fixture['page']>, wakes = 0, admitted: string | undefined;
        f = fixture({ maxActors: 1, onCapacityAvailable() { wakes++; admitted = f.api.offer(second); } });
        const first = f.page(1); second = f.page(2);
        f.api.setVisiblePages([1, 2]);
        assert.strictEqual(f.api.offer(first), 'started');
        assert.strictEqual(f.api.offer(second), 'busy');
        f.finish(); f.finish();
        assert.strictEqual(wakes, 1);
        assert.strictEqual(admitted, 'started', 'the completion callback can enqueue a new episode while painting');
        assert.strictEqual(f.api.hasHandled(2), true);
        assert.strictEqual(f.api.snapshot().deliveredFragments, 2);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('keeps a newly admitted ground mast hidden until its first gated geometry paint', () => {
        const f = fixture({ maxActors: 1 }); f.desktop();
        const first = f.page(1), second = f.page(2);
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer(first), 'started');
        const frames = f.api.snapshot().frames;
        f.api.setVisiblePages([2]);
        assert.strictEqual(f.api.offer({ ...second,
            imageRegions: [{ id: 'lower-photo', x: 0.3, y: 0.68, width: 0.4, height: 0.2 }] }), 'started');
        const transit = f.container.children.find(child => child.className === 'pdfDocumentRobotTransit')!;
        const mast = transit.children.flatMap(child => child.children).find(child => child.className === 'pdfDocumentRobotMast')!;
        assert.ok(mast?.isConnected, 'the deferred delivery includes its ground mast');
        assert.strictEqual(f.api.snapshot().frames, frames, 'admission stays inside the shared paint gate');
        assert.strictEqual(mast.style.opacity, '0', 'unpositioned scene nodes remain hidden until their first paint');
        f.frame();
        assert.strictEqual(f.api.snapshot().frames, frames + 1);
        assert.ok(Number.isFinite(parseFloat(mast.style.left)) && Number.isFinite(parseFloat(mast.style.top)));
        assert.ok(Number(mast.style.opacity) > 0, 'the positioned mast becomes visible on its first paint');
        f.finish();
        assert.strictEqual(mast.parentNode, null);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('initializes every deferred visual node as hidden and inert before geometry is available', () => {
        const f = fixture({ maxActors: 1 }); f.desktop();
        const first = f.page(1), second = f.page(2), third = f.page(3);
        f.api.setVisiblePages([1]); f.api.offer(first);
        const frames = f.api.snapshot().frames;
        f.api.setVisiblePages([2]);
        assert.strictEqual(f.api.offer({ ...second,
            imageRegions: [{ id: 'lower-photo', x: 0.3, y: 0.68, width: 0.4, height: 0.2 }] }), 'started');
        const transit = f.container.children.find(child => child.className === 'pdfDocumentRobotTransit')!;
        const nodes = transit.children.flatMap(child => child.children).filter(child =>
            ['pdfDocumentRobotCargo', 'pdfDocumentRobotVehicle', 'pdfDocumentRobotMast'].includes(child.className));
        assert.strictEqual(nodes.length, 3, 'the delivery has cargo, a vehicle, and its mast');
        f.api.setVisibleWork([work([third])]);
        const label = transit.children.flatMap(child => child.children).find(child => child.className === 'pdfDocumentRobotWorkStatus')!;
        assert.ok(label?.isConnected);
        for (const node of [...nodes, label]) {
            assert.strictEqual(node.style.opacity, '0', node.className + ' stays hidden until geometry is written');
            assert.strictEqual(node.style.position, 'absolute');
            assert.strictEqual(node.style.pointerEvents, 'none');
            assert.strictEqual(node.attributes.get('aria-hidden'), 'true', node.className + ' is decorative');
        }
        assert.strictEqual(f.api.snapshot().frames, frames, 'initialization does not bypass the paint gate');
        f.frame();
        assert.ok(Number(label.style.opacity) > 0);
        f.finish();
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('aligns the external mast and real cargo with the shared forklift artwork attachments', () => {
        const attachment = module.ROBOT_FORKLIFT_ATTACHMENT;
        assert.ok(attachment, 'forklift attachment geometry has a documented artwork owner');
        const strokes: Array<{ points: number[][]; color: string; width: number }> = [];
        const scales: number[][] = [], translations: number[][] = [];
        let points: number[][] = [];
        const context = new Proxy({
            beginPath: () => { points = []; },
            moveTo: (...point: number[]) => points.push(point),
            lineTo: (...point: number[]) => points.push(point),
            scale: (...scale: number[]) => scales.push(scale),
            translate: (...translation: number[]) => translations.push(translation),
            stroke() { strokes.push({ points: points.map(point => [...point]), color: this.strokeStyle, width: this.lineWidth }); },
        } as Record<string, any>, {
            get(target, key: string) {
                if (key in target) { return target[key]; }
                if (key === 'createLinearGradient') { return () => ({ addColorStop() {} }); }
                return () => {};
            },
            set(target, key: string, value) { target[key] = value; return true; },
        });
        module.paintRobotVehicle(context, { vehicle: 'forklift', x: 0, y: 0, vx: 0, vy: 0,
            activity: 'deliver', job: 'delivery', temperament: 1, phase: 0, distance: 0, needsHelp: false,
            carrying: true, cargo: { kind: 'preview', page: 1, count: 1, bytes: 0 }, progress: 0, look: 1, notice: null }, 0, 'dispatch', true);
        const scale = scales[0][0];
        const rails = strokes.filter(stroke => stroke.color === '#c2d0d6');
        const front = strokes.find(stroke => stroke.color === '#7ea7df')!;
        const rear = strokes.find(stroke => stroke.color === '#a3bed8')!;
        const parcel = translations.at(-1)!;
        assert.strictEqual(scale, attachment.scale);
        assert.deepStrictEqual(rails.map(rail => rail.points), [attachment.mast.left, attachment.mast.right].map(x =>
            [[x, attachment.mast.top], [x, attachment.mast.bottom]]));
        assert.deepStrictEqual(front.points, [[attachment.frontFork.left, attachment.frontFork.y - attachment.carryLift],
            [attachment.frontFork.right, attachment.frontFork.y - attachment.carryLift]]);
        assert.deepStrictEqual(rear.points, [[attachment.rearFork.left, attachment.rearFork.y - attachment.carryLift],
            [attachment.rearFork.right, attachment.rearFork.y - attachment.carryLift]]);
        assert.strictEqual(rails[0].width, attachment.mast.strokeWidth);
        assert.strictEqual(front.width, attachment.frontFork.strokeWidth);
        assert.strictEqual(rear.width, attachment.rearFork.strokeWidth);
        assert.deepStrictEqual(parcel, [attachment.cargo.x, attachment.cargo.y]);

        for (const desktop of [false, true]) {
            const f = fixture({ maxActors: 1 }); if (desktop) { f.desktop(2); }
            const page = f.page();
            f.api.setVisiblePages([1]);
            assert.strictEqual(f.api.offer({ ...page,
                imageRegions: [{ id: 'lower-photo', x: 0.36, y: 0.67, width: 0.34, height: 0.23 }] }), 'started');
            for (let tick = 0; tick < 100 && f.api.snapshot().pages[0].payloads[0].progress < 0.25; tick++) { f.frame(); }
            const payload = f.api.snapshot().pages[0].payloads[0];
            assert.strictEqual(payload.stage, 'carry', 'alignment is checked while the lower fork supports the photo');
            const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle')!;
            const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo')!;
            const transit = f.container.children.find(child => child.className === 'pdfDocumentRobotTransit')!;
            const mast = transit.children.flatMap(child => child.children).find(child => child.className === 'pdfDocumentRobotMast')!;
            const fork = mast.firstElementChild!;
            const robot = point(sprite), carried = point(cargo), origin = transit.getBoundingClientRect();
            const displayScale = parseFloat(sprite.style.width) / module.ROBOT_ARTWORK_SIZE.width;
            const cargoBottom = carried.y + parseFloat(cargo.style.height) / 2;
            const close = (actual: number, expected: number, detail: string) => assert.ok(Math.abs(actual - expected) < 0.03,
                detail + ': ' + actual + ' versus ' + expected);
            close(carried.x - robot.x, Math.round(parcel[0] * scale * 10) / 10 * displayScale, 'photo center follows the artwork cargo anchor');
            close(cargoBottom - robot.y, front.points[0][1] * scale * displayScale, 'the photo bottom sits on the carrying fork');
            close(parseFloat(mast.style.left) + origin.left - robot.x, Math.round(rails[0].points[0][0] * scale) * displayScale,
                'the external mast starts on the drawn rail');
            close(parseFloat(mast.style.width), Math.round((rails[1].points[0][0] - rails[0].points[0][0]) * scale) * displayScale,
                'the mast rail spacing comes from the artwork');
            close(parseFloat(mast.style.top) + origin.top - robot.y, Math.round(rails[0].points[0][1] * scale) * displayScale,
                'the external mast begins at the drawn rail top');
            close(parseFloat(mast.style.top) + origin.top + parseFloat(mast.style.height) - robot.y,
                Math.round(rails[0].points[1][1] * scale) * displayScale, 'the mast ends at the drawn rail bottom');
            close(parseFloat(mast.style.borderWidth.split(' ')[1]), Math.round(rails[0].width * scale) * displayScale, 'rail thickness');
            close(parseFloat(fork.style.width), Math.ceil((front.points[1][0] - front.points[0][0]) * scale) * displayScale, 'fork length');
            close(parseFloat(fork.style.height), Math.round(rear.width * scale) * displayScale, 'fork thickness');
            close(parseFloat(mast.style.top) + origin.top + parseFloat(fork.style.top), cargoBottom, 'the external fork carries the real photo');
        }
    });

    it('gives Navines a lower photograph, a level page-base approach and a mast lift to its exact source', () => {
        const f = fixture({ maxActors: 1 }); f.desktop();
        const page = f.page();
        const lower = { id: 'lower-photo', x: 0.36, y: 0.67, width: 0.34, height: 0.23 };
        const images = [{ id: 'upper-photo', x: 0.12, y: 0.08, width: 0.55, height: 0.37 }, lower];
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: images }), 'started');
        const episode = f.api.snapshot().pages[0], actor = episode.actors[0], payload = episode.payloads[0];
        assert.strictEqual(actor.vehicle, 'forklift', 'a lower cargo opportunity receives the ground carrier');
        assert.strictEqual(payload.imageId, lower.id, 'the lower photograph takes priority over the larger upper image');
        for (const key of ['x', 'y', 'width', 'height'] as const) { assert.ok(Math.abs(payload.target[key] - lower[key]) < 1e-9); }
        const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(actor.id))!;
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo')!;
        const positions: Array<{ robot: { x: number; y: number }; cargo: { x: number; y: number }; stage: string }> = [];
        for (let tick = 0; tick < 100; tick++) {
            f.frame();
            const current = f.api.snapshot().pages[0]?.payloads[0];
            if (!current) { break; }
            if (current.progress > 0.20 && current.progress < 0.61) { positions.push({ robot: point(sprite), cargo: point(cargo), stage: current.stage }); }
            if (current.deposited) { break; }
        }
        const travel = positions.filter(value => value.stage === 'carry');
        const lift = positions.filter(value => value.stage === 'lift');
        assert.ok(travel.length >= 2 && lift.length >= 2, 'the ground approach precedes a visible lift interval');
        assert.ok(Math.max(...positions.map(value => value.robot.y)) - Math.min(...positions.map(value => value.robot.y)) < 0.1,
            'Navines stays on the page base while the photograph rises');
        assert.ok(660 - travel[0].robot.y > 0 && 660 - travel[0].robot.y < 70, 'wheel height is tied to the real page lower edge');
        assert.ok(Math.abs(travel[0].robot.x - travel.at(-1)!.robot.x) > 20, 'the forklift actually drives along the base');
        assert.ok(lift[0].cargo.y - lift.at(-1)!.cargo.y > 10, 'the payload rises while the vehicle stays grounded');
        const delivered = point(cargo);
        assert.ok(Math.abs(delivered.x - (40 + (lower.x + lower.width / 2) * 400)) < 0.02);
        assert.ok(Math.abs(delivered.y - (60 + (lower.y + lower.height / 2) * 600)) < 0.02);
        f.finish();
        assert.strictEqual(f.api.snapshot().deliveredFragments, 1);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('keeps a ground delivery alongside cooperative real cargo within the same desktop actor and byte caps', () => {
        const f = fixture({ maxActors: 3 }); f.desktop();
        const page = f.page(); page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
        const images = [{ id: 'upper-photo', x: 0.1, y: 0.08, width: 0.6, height: 0.4 },
            { id: 'lower-photo', x: 0.3, y: 0.7, width: 0.38, height: 0.25 }];
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: images }), 'started');
        const snapshot = f.api.snapshot(), episode = snapshot.pages[0];
        const forklift = episode.actors.find((actor: any) => actor.vehicle === 'forklift');
        assert.ok(forklift, 'a substantial page has a base delivery as well as the upper crew');
        assert.strictEqual(episode.payloads.find((payload: any) => payload.id === forklift.payloadId).imageId, 'lower-photo');
        assert.ok(episode.payloads.some((payload: any) => payload.helpers.length === 2 && payload.imageId === 'upper-photo'));
        assert.strictEqual(snapshot.activeActors, 3);
        assert.strictEqual(snapshot.activePayloads, 2);
        assert.ok(snapshot.cargoBytes <= snapshot.maxCargoBytes && snapshot.spriteBytes <= snapshot.maxSpriteBytes);
        f.finish();
        assert.strictEqual(f.api.snapshot().deliveredFragments, 2);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('reserves Navines for a visible ground route instead of flying it across an upper page crop', () => {
        const f = fixture({ maxActors: 3 }); f.desktop();
        for (let id = 1; id <= 12; id++) {
            const page = f.page(id); page.pageElement.rect = { left: 40, top: -800, width: 465, height: 2600 };
            f.api.setVisiblePages([id]);
            assert.strictEqual(f.api.offer({ ...page, imageRegions: [{ id: 'middle-photo', x: 0.12, y: 0.4, width: 0.6, height: 0.3 }] }), 'started');
            assert.ok(f.api.snapshot().pages[0].actors.every((actor: any) => actor.vehicle !== 'forklift'),
                'an offscreen page base is not a forklift departure or destination');
            f.finish();
        }
    });

    it('removes a ground mast and its one real payload on every cancellation boundary', () => {
        for (const ending of ['hide', 'offscreen', 'reset', 'disable', 'dispose']) {
            const f = fixture({ maxActors: 1 }); f.desktop();
            const page = f.page(); f.api.setVisiblePages([1]);
            f.api.offer({ ...page, imageRegions: [{ id: 'lower-photo', x: 0.3, y: 0.68, width: 0.4, height: 0.2 }] });
            const transit = f.container.children.find(child => child.className === 'pdfDocumentRobotTransit')!;
            const mast = transit.children.flatMap(child => child.children).find(child => child.className === 'pdfDocumentRobotMast')!;
            const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo')!;
            assert.ok(mast.isConnected);
            if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            else if (ending === 'reset') { f.api.reset(); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else { f.api.dispose(); }
            assert.strictEqual(mast.parentNode, null);
            assert.strictEqual(cargo.zeroWrites, 1);
            assert.strictEqual(f.api.snapshot().retainedBytes, 0);
            assert.strictEqual(f.callbacks.size, 0);
        }
    });

    it('stages one duplex advance crew without cargo, then parks without idle frames or repeated allocations', () => {
        const f = fixture(); f.desktop();
        const pages = [f.page(99), f.page(100)];
        pages[1].pageElement.rect.left = 540;
        assert.strictEqual(typeof f.api.setVisibleWork, 'function', 'visible blank spreads can request a bounded advance crew');
        f.api.setVisibleWork([work(pages)]);
        const began = f.api.snapshot();
        assert.strictEqual(began.advance.length, 1);
        assert.strictEqual(began.advance[0].key, '99:100');
        assert.strictEqual(began.advance[0].actors.length, 2);
        assert.ok(began.advance[0].message.includes('88') && began.advance[0].message.includes('89'));
        assert.strictEqual(began.activePayloads, 0);
        assert.strictEqual(began.cargoBytes, 0);
        assert.strictEqual(f.owned.flatMap(canvas => canvas.copies).filter(args => args.length === 9).length, 0);
        assert.strictEqual(f.api.hasHandled(99), false);
        assert.strictEqual(f.api.hasHandled(100), false);
        f.finish();
        assert.strictEqual(f.api.snapshot().advance[0].phase, 'parked');
        assert.strictEqual(f.callbacks.size, 0, 'a waiting crew has no perpetual loading animation');
        const allocated = f.owned.length, frames = f.api.snapshot().frames;
        for (let i = 0; i < 50; i++) { f.api.setVisibleWork([work(pages)]); }
        assert.strictEqual(f.owned.length, allocated);
        assert.strictEqual(f.api.snapshot().frames, frames);
        assert.strictEqual(f.callbacks.size, 0);
        f.api.setVisibleWork([work(pages, ['preparing', 'preparing'])]);
        assert.strictEqual(f.callbacks.size, 1, 'a real work transition can trigger one short coordination gesture');
        f.finish();
        const coordinated = f.api.snapshot().frames;
        for (let i = 0; i < 20; i++) { f.api.setVisibleWork([work(pages, ['preparing', 'preparing'])]); }
        assert.strictEqual(f.api.snapshot().frames, coordinated);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('promotes staged lab actors into real pixels while the other duplex half is still preparing', () => {
        const f = fixture(); f.desktop();
        const held = new Set<string>(), released: string[] = [];
        const port = { reserve: (vehicle: string) => {
            if (held.has(vehicle)) { return; } held.add(vehicle); return { x: 700, y: 110, scale: 0.5 };
        }, destination: () => ({ x: 700, y: 110, scale: 0.5 }), release: (vehicle: string) => { held.delete(vehicle); released.push(vehicle); } };
        f.api.setDispatchOrigin(port);
        const pages = [f.page(99), f.page(100)]; pages[1].pageElement.rect.left = 540;
        assert.strictEqual(typeof f.api.setVisibleWork, 'function');
        f.api.setVisibleWork([work(pages, ['preparing', 'preparing'])]); f.finish();
        const stage = f.api.snapshot().advance[0];
        const stagedIds = stage.actors.map((actor: any) => actor.id);
        const sprites = f.owned.filter(canvas => stagedIds.includes(Number(canvas.dataset.courier)));
        const parked = sprites.map(point);
        f.api.setVisibleWork([work(pages, ['ready', 'preparing'])]);
        assert.strictEqual(f.api.offer(pages[0]), 'started');
        const first = f.api.snapshot();
        assert.ok(first.pages[0].actors.some((actor: any) => stagedIds.includes(actor.id)), 'a real delivery reuses its waiting actors');
        for (let index = 0; index < sprites.length; index++) {
            if (!first.pages[0].actors.some((actor: any) => actor.id === Number(sprites[index].dataset.courier))) { continue; }
            const location = point(sprites[index]);
            assert.ok(Math.hypot(location.x - parked[index].x, location.y - parked[index].y) < 1, 'the promoted robot starts from its parked position');
        }
        assert.ok(first.advance[0].message.includes('89'));
        assert.strictEqual(f.api.hasHandled(99), true);
        assert.strictEqual(f.api.hasHandled(100), false);
        assert.ok(f.owned.flatMap(canvas => canvas.copies).filter(args => args.length === 9).every(args => args[0] === pages[0].canvas));
        f.finish();
        f.api.setVisibleWork([work(pages, ['ready', 'ready'])]);
        assert.strictEqual(f.api.offer(pages[1]), 'started');
        assert.strictEqual(f.api.offer(pages[0]), 'skipped');
        f.finish();
        assert.strictEqual(f.api.snapshot().advance.length, 0);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(held.size, 0);
        assert.ok(released.length >= stagedIds.length);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('keeps advance crews inside the shared actor budget and gives ready cargo priority', () => {
        const f = fixture({ maxActors: 2 }); f.desktop();
        const a = f.page(99), b = f.page(100), ready = f.page(101);
        b.pageElement.rect.left = 540; ready.pageElement.rect = { left: 40, top: 760, width: 465, height: 600 };
        assert.strictEqual(typeof f.api.setVisibleWork, 'function');
        f.api.setVisibleWork([work([a, b]), work([ready], ['ready'])]);
        assert.ok(f.api.snapshot().activeActors <= 1, 'staging leaves capacity for real payloads');
        assert.strictEqual(f.api.offer(ready), 'started');
        assert.ok(f.api.snapshot().activeActors <= 2);
        f.api.setVisibleWork([work([ready], ['ready'])]);
        assert.ok(f.api.snapshot().advance.every((group: any) => group.pages.every((id: number) => id === 101)));
        f.finish();
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('releases advance reservations once on every lifecycle exit and ignores old animation callbacks', () => {
        for (const ending of ['offscreen', 'hidden', 'disabled', 'reset', 'dispose', 'failed', 'reduced']) {
            const f = fixture();
            const reservations: string[] = [], returns: string[] = [];
            f.api.setDispatchOrigin({ reserve: (vehicle: string) => { reservations.push(vehicle); return { x: 650, y: 90, scale: 0.4 }; },
                destination: () => ({ x: 650, y: 90, scale: 0.4 }), release: (vehicle: string) => returns.push(vehicle) });
            const page = f.page(99);
            assert.strictEqual(typeof f.api.setVisibleWork, 'function');
            f.api.setVisibleWork([work([page])]);
            const pending = [...f.callbacks.values()];
            if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            if (ending === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            if (ending === 'disabled') { f.api.setEnabled(false); }
            if (ending === 'reset') { f.api.reset(); }
            if (ending === 'dispose') { f.api.dispose(); }
            if (ending === 'failed') { f.api.setVisibleWork([work([page], ['failed'])]); f.finish(); }
            if (ending === 'reduced') { f.media.matches = true; f.media.emit('change'); }
            for (const callback of pending) { callback(f.now + 10000); }
            assert.strictEqual(f.api.snapshot().retainedBytes, 0, ending);
            assert.strictEqual(f.callbacks.size, 0, ending);
            assert.deepStrictEqual(returns.sort(), reservations.sort(), ending + ' returns each borrowed actor exactly once');
            assert.strictEqual(f.api.hasHandled(99), false, 'waiting does not spend the real delivery episode');
        }
    });

    it('uses static waiting status for reduced motion and defers clipped advance crews without marking history', () => {
        const f = fixture();
        const page = f.page(99);
        assert.strictEqual(typeof f.api.setVisibleWork, 'function');
        f.media.matches = true;
        f.api.setVisibleWork([work([page], ['preparing'])]);
        assert.ok(f.api.snapshot().advance[0].message.includes('88'));
        assert.strictEqual(f.api.snapshot().activeActors, 0);
        assert.strictEqual(f.owned.length, 0);
        assert.strictEqual(f.callbacks.size, 0);
        f.api.setVisiblePages([]); f.media.matches = false;
        page.pageElement.rect.top = 695;
        f.api.setVisibleWork([work([page])]);
        assert.strictEqual(f.api.snapshot().activeActors, 0);
        assert.strictEqual(f.owned.length, 0);
        page.pageElement.rect.top = 60;
        f.api.setVisibleWork([work([page])]);
        assert.strictEqual(f.api.snapshot().activeActors, 1);
        assert.strictEqual(f.api.hasHandled(99), false);
    });

    it('does not retry failed advance artwork on every refresh and still accepts later real pixels', () => {
        const f = fixture();
        const page = f.page(99), original = Canvas.prototype.getContext;
        assert.strictEqual(typeof f.api.setVisibleWork, 'function');
        Canvas.prototype.getContext = function () { return null; };
        try {
            f.api.setVisibleWork([work([page])]);
            const allocations = f.owned.length;
            for (let i = 0; i < 20; i++) { f.api.setVisibleWork([work([page])]); }
            assert.strictEqual(f.owned.length, allocations);
            assert.strictEqual(f.api.snapshot().retainedBytes, 0);
            assert.strictEqual(f.callbacks.size, 0);
        } finally { Canvas.prototype.getContext = original; }
        f.api.setVisibleWork([work([page], ['ready'])]);
        assert.strictEqual(f.api.offer(page), 'started');
        f.finish();
    });

    it('rolls back advance sprites and lab reservations if their layer cannot accept a body', () => {
        const f = fixture();
        const page = f.page(99), held = new Set<string>();
        f.api.setDispatchOrigin({ reserve: (vehicle: string) => { held.add(vehicle); return { x: 600, y: 100 }; },
            destination: () => ({ x: 600, y: 100 }), release: (vehicle: string) => held.delete(vehicle) });
        const original = Element.prototype.append;
        Element.prototype.append = function (...children: Element[]) {
            if (this.className === 'pdfDocumentRobotAdvance' && children.some(child => child instanceof Canvas)) { throw new Error('sprite attachment failed'); }
            original.apply(this, children);
        };
        try {
            assert.doesNotThrow(() => f.api.setVisibleWork([work([page])]));
            const allocations = f.owned.length;
            for (let i = 0; i < 10; i++) { f.api.setVisibleWork([work([page])]); }
            assert.strictEqual(f.owned.length, allocations);
            assert.strictEqual(f.api.snapshot().retainedBytes, 0);
            assert.strictEqual(held.size, 0);
            assert.strictEqual(f.callbacks.size, 0);
        } finally { Element.prototype.append = original; }
        f.api.setVisibleWork([work([page], ['ready'])]);
        assert.strictEqual(f.api.offer(page), 'started');
        f.finish();
    });

    it('prefers an actual image placement and carries its exact rendered crop cooperatively', () => {
        const f = fixture({ maxActors: 2 }); f.desktop();
        const page = f.page(99);
        page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
        f.api.setVisiblePages([99]);
        const image = { id: 'photo-499-placement-1', x: 0.125, y: 0.25, width: 0.625, height: 0.5 };
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [image] }), 'started');
        const payload = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(payload.imageId, image.id, 'trusted PDF placement metadata selects recognizable image cargo');
        assert.deepStrictEqual(payload.target, { x: image.x, y: image.y, width: image.width, height: image.height });
        assert.strictEqual(payload.helpers.length, 2, 'a substantial photograph uses one shared raster and two carriers');
        const copies = f.owned.flatMap(canvas => canvas.copies).filter(args => args.length === 9);
        assert.strictEqual(copies.length, 1);
        assert.deepStrictEqual(copies[0].slice(1, 5), [540, 1620, 2700, 3240]);
        assert.ok(f.api.snapshot().cargoBytes <= f.api.snapshot().maxCargoBytes);
        assert.ok(f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotCargo')
            .every(canvas => Math.max(canvas.width, canvas.height) <= 384));
    });

    it('copies real bounded fragments into a transparent scroll-local transit layer and finishes without idle frames', () => {
        const f = fixture();
        const page = f.page();
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.deliver(page), true);
        const began = f.api.snapshot();
        assert.ok(began.activeActors >= 2 && began.activeActors <= began.maxActors);
        const copies = f.owned.flatMap(canvas => canvas.copies).filter(args => args.length === 9);
        assert.strictEqual(copies.length, began.activePayloads, 'each payload copies its ready pixels once, including shared cargo');
        assert.ok(copies.every(args => args[0] === page.canvas && args[3] < page.canvas.width && args[4] < page.canvas.height));
        assert.ok(f.owned.every(canvas => Math.max(canvas.width, canvas.height) <= module.DOCUMENT_ROBOT_LIMITS.fragmentDimension * module.DOCUMENT_ROBOT_LIMITS.cooperative.rasterScale));
        const transit = f.container.children.find((child: Element) => child.className === 'pdfDocumentRobotTransit')!;
        assert.strictEqual(transit.style.position, 'absolute');
        assert.strictEqual(transit.style.contain, 'layout size', 'visible ink cannot enlarge PDF scroll overflow');
        assert.strictEqual(transit.style.width, '0');
        assert.strictEqual(transit.style.height, '0');
        assert.strictEqual(transit.style.zIndex, '2147483647');
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
        assert.strictEqual(ended.deliveredFragments, began.activePayloads);
        assert.strictEqual(ended.activeEpisodes + ended.activeActors + ended.retainedBytes, 0);
        assert.strictEqual(ended.scheduled, false);
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(transit.parentNode, null);
        assert.deepStrictEqual([page.canvas.width, page.canvas.height], [4320, 6480]);
    });

    it('copies one substantial real fragment for a cooperative pair and a cooperative trio', () => {
        for (const helpers of [2, 3]) {
            const { f, page, payload } = cooperative('formation', helpers);
            const state = f.api.snapshot();
            const actors = state.pages[0].actors.filter((actor: any) => actor.payloadId === payload.id);
            assert.strictEqual(actors.length, helpers);
            assert.strictEqual(new Set(actors.map((actor: any) => actor.vehicle)).size, helpers);
            const cargo = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.dataset.payload === String(payload.id));
            assert.strictEqual(cargo.length, 1, 'helpers share one retained raster');
            assert.strictEqual(cargo[0].copies.filter(args => args.length === 9).length, 1);
            assert.strictEqual(cargo[0].copies[0][0], page.canvas);
            assert.ok(payload.target.width * 465 > 220 && payload.target.height * 661 > 160, 'a team receives a visibly larger content fragment');
            assert.strictEqual(state.activePayloads, 1);
            assert.strictEqual(state.cargoBytes, cargo[0].width * cargo[0].height * 4);
            page.canvas.width = page.canvas.height = 0;
            f.frame();
            assert.ok(cargo[0].width > 0, 'helpers do not depend on a retained source canvas');
        }
    });

    it('keeps cooperative helpers in formation and deposits their shared fragment exactly once', () => {
        const { f, payload } = cooperative('formation');
        const baseline = f.api.snapshot().deliveredFragments;
        let current: any;
        for (let step = 0; step < 120; step++) {
            f.frame();
            current = f.api.snapshot().pages[0]?.payloads.find((candidate: any) => candidate.id === payload.id);
            if (current?.progress >= 0.4) { break; }
        }
        assert.strictEqual(current.stage, 'carry');
        const sprites = payload.helpers.map((id: number) => f.owned.find(canvas => canvas.dataset.courier === String(id) && canvas.className === 'pdfDocumentRobotVehicle')) as Canvas[];
        const before = sprites.map(point);
        f.frame();
        const after = sprites.map(point);
        assert.ok(Math.abs((before[1].x - before[0].x) - (after[1].x - after[0].x)) < 0.05);
        assert.ok(Math.abs((before[1].y - before[0].y) - (after[1].y - after[0].y)) < 0.05);
        for (let step = 0; step < 120; step++) {
            f.frame();
            const actors = f.api.snapshot().pages[0]?.actors.filter((actor: any) => actor.payloadId === payload.id);
            if (actors?.some((actor: any) => actor.deposited)) {
                assert.ok(actors.every((actor: any) => actor.deposited), 'the common payload controls every helper deposit');
                break;
            }
        }
        assert.strictEqual(f.api.snapshot().deliveredFragments, baseline + 1);
        const cargo = f.owned.find(canvas => canvas.dataset.payload === String(payload.id))!;
        f.finish();
        assert.strictEqual(cargo.zeroWrites, 1, 'shared cargo is released once after deposit');
        assert.strictEqual(f.api.snapshot().deliveredFragments, baseline + 1);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('coordinates an aerial-to-ground handoff before the ground carrier transports the shared payload', () => {
        const { f, payload } = cooperative('handoff');
        const actors = f.api.snapshot().pages[0].actors;
        assert.ok(actors.some((actor: any) => actor.role === 'aerial'));
        assert.ok(actors.some((actor: any) => actor.role === 'ground'));
        let current: any;
        for (let step = 0; step < 120; step++) {
            f.frame();
            current = f.api.snapshot().pages[0]?.payloads.find((candidate: any) => candidate.id === payload.id);
            if (current?.stage === 'handoff') { break; }
        }
        assert.strictEqual(current.stage, 'handoff');
        assert.strictEqual(current.handedOff, false);
        assert.strictEqual(current.carrier, 'aerial');
        const ground = actors.find((actor: any) => actor.role === 'ground');
        const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(ground.id))!;
        const rendezvous = point(sprite);
        f.frame();
        assert.deepStrictEqual(point(sprite), rendezvous, 'the ground vehicle waits while the aerial helper lowers the parcel');
        for (let step = 0; step < 120; step++) {
            f.frame();
            current = f.api.snapshot().pages[0]?.payloads.find((candidate: any) => candidate.id === payload.id);
            if (current?.stage === 'carry') { break; }
        }
        assert.strictEqual(current.handedOff, true);
        assert.strictEqual(current.carrier, 'ground');
        assert.strictEqual(current.deposited, false);
        f.finish();
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
    });

    it('releases cooperative cargo once and returns every borrowed helper on each lifecycle ending', () => {
        for (const ending of ['finish', 'offscreen', 'reset', 'hide', 'disable', 'dispose']) {
            const { f, payload } = cooperative('formation', 2, true);
            const cargo = f.owned.find(canvas => canvas.dataset.payload === String(payload.id))!;
            const pending = [...f.callbacks.values()];
            const outside = f.lab.snapshot().actors.filter((actor: any) => actor.outside);
            assert.strictEqual(outside.length, 2);
            if (ending === 'finish') { f.finish(); }
            else if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            else if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else { f.api[ending](); }
            for (const callback of pending) { callback(f.now + 10000); }
            assert.strictEqual(cargo.zeroWrites, 1, ending + ' releases the shared bitmap exactly once');
            assert.ok(f.lab.snapshot().actors.every((actor: any) => !actor.outside));
            assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
            assert.strictEqual(f.callbacks.size, 0);
        }
    });

    it('mixes solo and cooperative deliveries within the existing mobile and desktop resource caps', () => {
        const modes = new Set<string>();
        for (const device of ['mobile', 'desktop']) {
            const f = fixture({ device });
            f.desktop(3);
            for (let id = 1; id <= 15; id++) {
                const page = f.page(id);
                page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
                f.api.setVisiblePages([id]); f.api.offer(page);
                const state = f.api.snapshot();
                for (const payload of state.pages[0]?.payloads ?? []) { modes.add(payload.mode); }
                assert.ok(state.activeActors <= state.maxActors && state.cargoBytes <= state.maxCargoBytes && state.spriteBytes <= state.maxSpriteBytes);
                assert.strictEqual(state.retainedBytes, f.owned.reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0));
                f.finish();
            }
        }
        assert.deepStrictEqual([...modes].sort(), ['formation', 'handoff', 'solo']);
    });

    it('falls back to solo fragments when a larger cooperative raster cannot fit the existing byte cap', () => {
        const shared = cooperative('formation');
        const larger = shared.f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.dataset.payload === String(shared.payload.id))!;
        assert.ok(larger.width * larger.height * 4 > 180000, 'the control scene needs more bytes than the constrained cache allows');
        const f = fixture({ device: 'mobile', maxActors: 3, maxCargoBytes: 180000 });
        f.desktop();
        for (let id = 1; id <= 12; id++) {
            const page = f.page(id);
            page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
            f.api.setVisiblePages([id]);
            assert.strictEqual(f.api.offer(page), 'started');
            const state = f.api.snapshot();
            assert.ok(state.pages[0].payloads.every((payload: any) => payload.mode === 'solo' && payload.helpers.length === 1));
            assert.ok(state.cargoBytes <= 180000);
            assert.strictEqual(state.cargoBytes, f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotCargo')
                .reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0));
            f.finish();
            assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        }
        assert.ok(f.owned.flatMap(canvas => canvas.copies).filter(args => args.length === 9)
            .every(args => args[7] <= module.DOCUMENT_ROBOT_LIMITS.fragmentDimension), 'over-budget team rasters are rejected before copying');
    });

    it('rolls back a partially reserved cooperative crew without leaking its shared raster or lab actor', () => {
        const f = fixture({ maxActors: 3 });
        f.desktop();
        const held = new Set<string>();
        let availableVehicle: string | undefined, reservations = 0, releases = 0;
        const origin = { x: 550, y: 80, scale: 0.4 };
        f.api.setDispatchOrigin({
            reserve(vehicle: string) {
                availableVehicle ??= vehicle;
                if (vehicle !== availableVehicle || held.has(vehicle)) { return; }
                held.add(vehicle); reservations++; return origin;
            },
            destination: (vehicle: string) => held.has(vehicle) ? origin : undefined,
            release(vehicle: string) { assert.ok(held.delete(vehicle), 'each borrowed helper is returned once'); releases++; },
        });
        let rolledBack = 0;
        for (let id = 1; id <= 12; id++) {
            const page = f.page(id);
            page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
            f.api.setVisiblePages([id]); f.api.offer(page);
            const state = f.api.snapshot();
            if (state.pages[0]?.payloads) {
                assert.ok(state.pages[0].payloads.every((payload: any) => payload.mode === 'solo' && payload.helpers.length === 1));
            }
            assert.strictEqual(held.size, state.activeActors);
            f.finish();
            assert.strictEqual(held.size, 0);
            assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        }
        for (const canvas of f.owned) {
            if (canvas.copies.some(args => args.length === 9 && args[7] > module.DOCUMENT_ROBOT_LIMITS.desktop.fragmentDimension)) {
                rolledBack++; assert.strictEqual(canvas.zeroWrites, 1, 'a failed team releases its one copied raster once');
            }
        }
        assert.ok(rolledBack > 0, 'the test exercises a cooperative allocation before a later helper reservation fails');
        assert.strictEqual(reservations, releases);
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
        const transit = f.container.children.find((child: Element) => child.className === 'pdfDocumentRobotTransit')!;
        assert.strictEqual(transit.parentNode, f.container, 'the native viewer clip keeps cargo below toolbar controls');
        assert.strictEqual(f.container.style.overflow, 'auto');
        assert.strictEqual(transit.getBoundingClientRect().top, 120);
        assert.ok(f.api.snapshot().pages[0].actors.every((actor: any) => actor.fromLab), 'clipping keeps the real lab departure');

        f.window.visualViewport = { offsetLeft: 100, offsetTop: 80, width: 500, height: 470 };
        f.frame();
        assert.strictEqual(transit.style.clipPath, undefined, 'visual viewport clipping is supplied by the browser without sampled clip writes');
        f.container.rect.top = 180;
        f.window.visualViewport = { offsetLeft: 130, offsetTop: 160, width: 420, height: 360 };
        f.frame();
        assert.strictEqual(transit.getBoundingClientRect().top, 180, 'the containing block follows the viewer without a fixed overlay');
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
        assert.strictEqual(f.api.snapshot().frames, 1, 'same-tick admissions share one document paint');
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

    it('releases copied fragments and borrowed lab actors if the scroll-local transit layer cannot be attached', () => {
        const f = fixture();
        const { lab } = f.openLab();
        f.api.setDispatchOrigin(lab.dispatch);
        const page = f.page();
        f.api.setVisiblePages([1]);
        const body = f.container;
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
