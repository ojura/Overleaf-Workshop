import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

class Events {
    readonly listeners = new Map<string, Set<(event?: any) => void>>();
    addEventListener(name: string, listener: (event?: any) => void) {
        if (!this.listeners.has(name)) { this.listeners.set(name, new Set()); }
        this.listeners.get(name)!.add(listener);
    }
    removeEventListener(name: string, listener: (event?: any) => void) { this.listeners.get(name)?.delete(listener); }
    emit(name: string, event?: any) { for (const listener of this.listeners.get(name) ?? []) { listener(event); } }
    get count() { return [...this.listeners.values()].reduce((sum, value) => sum + value.size, 0); }
}
class Element extends Events {
    readonly style: Record<string, string> = {};
    readonly dataset: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
    readonly children: Element[] = [];
    parentNode: Element | null = null;
    className = '';
    private text = '';
    textWrites = 0;
    layoutReads = 0;
    get textContent() { return this.text; }
    set textContent(value: string) { this.text = value; this.textWrites++; }
    rect = { left: 0, top: 0, width: 800, height: 700 };
    objectFit = 'fill';
    scrollLeft = 0;
    scrollTop = 0;
    constructor(readonly ownerDocument: any) { super(); }
    get isConnected(): boolean { return this === this.ownerDocument.body || !!this.parentNode?.isConnected; }
    get clientWidth() { return this.rect.width; }
    get clientHeight() { return this.rect.height; }
    get firstElementChild() { return this.children[0] ?? null; }
    get parentElement() { return this.parentNode; }
    getBoundingClientRect() {
        this.layoutReads++;
        if (this.className === 'pdfDocumentRobotCaption' || this.className === 'pdfDocumentRobotWorkStatus') {
            const width = parseFloat(this.style.width) || parseFloat(this.style.maxWidth) || 0;
            const height = this.style.height === 'auto'
                ? (this.className === 'pdfDocumentRobotCaption' ? this.ownerDocument.captionHeight : this.ownerDocument.workStatusHeight)
                    ?? 16 + this.textContent.split('\n').length * parseFloat(this.style.lineHeight)
                : parseFloat(this.style.height) || 0;
            return { left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height };
        }
        const parent = this.parentNode;
        const rect = this.style.position === 'fixed' && this.style.inset === '0'
            ? { left: 0, top: 0, width: this.ownerDocument.defaultView.innerWidth, height: this.ownerDocument.defaultView.innerHeight }
            : this.className === 'pdfDocumentRobotTransit' && this.style.position === 'absolute' && parent
                ? { left: parent.rect.left - parent.scrollLeft + (parseFloat(this.style.translate) || 0), top: parent.rect.top - parent.scrollTop, width: 0, height: 0 }
                : this.rect;
        return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height };
    }
    append(...children: Element[]) {
        for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); }
    }
    appendChild(child: Element) { this.append(child); return child; }
    remove() {
        if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    }
    replaceWith(next: Element) {
        const parent = this.parentNode;
        if (!parent) { return; }
        const index = parent.children.indexOf(this);
        next.remove(); parent.children[index] = next; next.parentNode = parent; this.parentNode = null;
    }
    before(previous: Element) {
        const parent = this.parentNode;
        if (!parent) { return; }
        previous.remove(); parent.children.splice(parent.children.indexOf(this), 0, previous); previous.parentNode = parent;
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
    readonly copyTargets: number[][] = [];
    readonly contextOptions: any[] = [];
    readonly transforms: number[][] = [];
    failCopy = false;
    noContext = false;
    beforeCopy?: (args: any[]) => void;
    readonly context = new Proxy({
        setTransform: (...values: number[]) => this.transforms.push(values),
        drawImage: (...args: any[]) => {
            this.beforeCopy?.(args);
            if (this.failCopy && args.length === 9) { throw new Error('copy failed'); }
            this.copies.push(args);
            this.copyTargets.push([this.width, this.height]);
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
    readonly timers = new Map<number, { at: number; callback: () => void }>();
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
            setTimeout: (callback: () => void, delay: number) => { this.timers.set(++this.serial, { at: this.now + delay, callback }); return this.serial; },
            clearTimeout: (id: number) => this.timers.delete(id),
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
            getSelection: () => ({ isCollapsed: true }),
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
        for (const [id, timer] of [...this.timers]) {
            if (timer.at <= this.now) { this.timers.delete(id); timer.callback(); }
        }
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
        const canvas = stage.children[0] as Canvas;
        canvas.rect = { left: 500, top: 40, width: 300, height: 86 };
        canvas.objectFit = 'contain';
        this.lab.setActive(true);
        return { stage, canvas, lab: this.lab };
    }
    dispose() {
        this.api.dispose();
        this.lab?.dispose();
        assert.strictEqual(this.callbacks.size, 0);
        assert.strictEqual(this.timers.size, 0);
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

    function cooperative(mode?: string, helpers = 2, useLab = false, options: Record<string, unknown> = {}, coarse = false) {
        const f = fixture({ maxActors: helpers, ...options });
        f.desktop();
        if (useLab) { f.api.setDispatchOrigin(f.openLab().lab.dispatch); }
        for (let id = 1; id <= 12; id++) {
            const page = f.page(id);
            if (coarse) { page.canvas.width = 135; page.canvas.height = 192; }
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
        const translation = (canvas.style.translate ?? '').split(/\s+/).map(value => parseFloat(value) || 0);
        return { x: Number(match[1]) + parseFloat(canvas.style.width) / 2 + origin.left + (translation[0] ?? 0),
            y: Number(match[2]) + parseFloat(canvas.style.height) / 2 + origin.top + (translation[1] ?? 0) };
    }

    function work(pages: ReturnType<Fixture['page']>[], states = pages.map(() => 'waiting'), key = pages.map(page => page.pageNumber).join(':')) {
        return { key, pages: pages.map((page, index) => ({ pageNumber: page.pageNumber, pageElement: page.pageElement,
            label: String(page.pageNumber - 11), state: states[index] })) };
    }

    const sceneNodes = (node: Element): Element[] => [node, ...node.children.flatMap(sceneNodes)];
    const captions = (f: Fixture) => sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotCaption');
    const nearMissOptions = () => {
        const draws = [0.99, 0.1, 0.5, 0];
        return { seed: 16, encounterRandom: () => draws.shift() ?? 0.99 };
    };

    function coarsePhoto(options: Record<string, unknown> = {}) {
        const f = fixture({ maxActors: 2, ...options }); f.desktop();
        const page = f.page(99); page.canvas.width = 135; page.canvas.height = 192;
        page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
        const delivery = { ...page, kind: 'preview' as const,
            imageRegions: [{ id: 'p99-photo', x: 0.1, y: 0.2, width: 0.6, height: 0.4 }] };
        f.api.setVisiblePages([99]); assert.strictEqual(f.api.offer(delivery), 'started');
        const source = (width = 541, height = 768) => {
            const canvas = new Canvas(f.document); canvas.width = width; canvas.height = height;
            return { ...delivery, canvas };
        };
        return { f, page, delivery, source };
    }

    function pointer(f: Fixture, type: string, point: { x: number; y: number }) {
        const event = { clientX: point.x, clientY: point.y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
            button: 0, buttons: 0, detail: 1, defaultPrevented: false,
            composedPath: () => [f.container], preventDefault() { assert.fail('robot interaction must not consume PDF input'); },
            stopPropagation() { assert.fail('robot interaction must not consume PDF input'); } };
        (type === 'pointerup' ? f.window : f.container).emit(type, event);
    }

    it('acknowledges hover and a click during a loaded delivery without changing its cargo or deadline', () => {
        const { f } = coarsePhoto({ encounterRandom: () => 0.99 }); f.tick(200);
        const before = f.api.snapshot().pages[0].payloads[0];
        const actor = f.api.snapshot().pages[0].actors.find((value: any) => value.payloadId === before.id);
        const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(actor.id))!;
        const copies = f.owned.reduce((sum, canvas) => sum + canvas.copies.filter(args => args.length === 9).length, 0);
        pointer(f, 'pointermove', point(sprite)); f.tick(34);
        assert.strictEqual(f.api.snapshot().interaction.hovered, actor.id);
        assert.ok(f.api.snapshot().caption.text.includes('fotografiju'), 'the moving courier reports its actual loaded work');
        const at = point(sprite);
        pointer(f, 'pointerdown', at); pointer(f, 'pointerup', at); pointer(f, 'click', at); f.tick(34);
        assert.strictEqual(f.api.snapshot().interaction.greeting, actor.id);
        assert.ok(f.api.snapshot().pages[0].actors.find((value: any) => value.id === actor.id).reaction);
        const after = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(after.id, before.id); assert.strictEqual(after.deadline, before.deadline);
        assert.deepStrictEqual(after.helpers, before.helpers); assert.deepStrictEqual(after.target, before.target);
        assert.ok(after.progress > before.progress, 'delivery continues while the expression responds');
        assert.strictEqual(f.owned.reduce((sum, canvas) => sum + canvas.copies.filter(args => args.length === 9).length, 0), copies);
        f.finish();
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().interaction.hitActors, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('uses one dirty hover frame and a finite greeting for a parked crew, then removes interaction on disposal', () => {
        const f = fixture({ encounterRandom: () => 0.99 }); f.desktop();
        const page = f.page(99); f.api.setVisibleWork([work([page])]); f.finish();
        const actor = f.api.snapshot().advance[0].actors[0];
        const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(actor.id))!;
        const before = f.api.snapshot().frames;
        pointer(f, 'pointermove', point(sprite)); f.tick(34);
        assert.ok(f.api.snapshot().frames <= before + 1);
        assert.strictEqual(captions(f)[0]?.style.opacity, '1', 'an admitted parked hover is visible on its only dirty paint');
        assert.strictEqual(f.callbacks.size, 0, 'hover does not create an idle heartbeat');
        f.tick(7);
        const at = point(sprite); pointer(f, 'pointerdown', at); pointer(f, 'pointerup', at); pointer(f, 'click', at);
        pointer(f, 'pointerleave', at);
        f.finish();
        assert.strictEqual(f.api.snapshot().interaction.greeting, undefined);
        assert.strictEqual(f.api.snapshot().advance[0].actors.find((value: any) => value.id === actor.id).reaction, null);
        assert.strictEqual(f.callbacks.size, 0, 'the acknowledgement returns to a parked pose');
        f.dispose();
        assert.strictEqual(f.container.count + f.document.count + f.window.count, 0);
        pointer(f, 'pointermove', at); pointer(f, 'click', at);
        assert.strictEqual(f.callbacks.size + f.timers.size, 0, 'late input cannot recreate the scene');
    });

    it('applies one spacing displacement to shared cargo, every helper and a sharper replacement', () => {
        const shifted = cooperative('formation', 2, false, { encounterRandom: () => 0.99,
            createTraffic: () => ({ update: (_at: number, groups: any[]) => new Map(groups.map(group => [group.id,
                { x: group.fixed ? 0 : 35 * (group.offsetScale ?? 1), y: 0 }])), reset() {} }) }, true);
        const plain = cooperative('formation', 2, false, { encounterRandom: () => 0.99,
            createTraffic: () => ({ update: () => new Map(), reset() {} }) }, true);
        shifted.f.tick(350); plain.f.tick(350);
        const left = shifted.f.api.snapshot().pages[0], right = plain.f.api.snapshot().pages[0];
        assert.deepStrictEqual(left.payloads[0].motion, { x: 35, y: 0 });
        const nodes = (f: Fixture, payload: any) => f.owned.filter(canvas => canvas.width && canvas.dataset.payload === String(payload.id));
        const a = nodes(shifted.f, shifted.payload), b = nodes(plain.f, plain.payload);
        assert.strictEqual(a.length, b.length);
        for (let index = 0; index < a.length; index++) {
            assert.ok(Math.abs(point(a[index]).x - point(b[index]).x - 35) < 0.05);
            assert.ok(Math.abs(point(a[index]).y - point(b[index]).y) < 0.05);
        }
        const source = new Canvas(shifted.f.document); source.width = 1080; source.height = 1536;
        assert.ok(shifted.f.api.refine({ ...shifted.page, canvas: source }) > 0);
        const sharp = shifted.f.owned.find(canvas => canvas.width && canvas.className === 'pdfDocumentRobotCargo')!;
        assert.strictEqual(sharp.style.translate, '35.000px 0.000px', 'new sharp pixels inherit the current group offset before a paint');
        assert.strictEqual(left.payloads[0].deadline, right.payloads[0].deadline);
        let faded = false, deposited = false;
        while (shifted.f.callbacks.size) {
            shifted.f.frame();
            const current = shifted.f.api.snapshot().pages[0]?.payloads.find((value: any) => value.id === shifted.payload.id);
            if (!current) { continue; }
            if (current.progress > 0.55 && !current.deposited) {
                faded ||= current.motion.x > 0 && current.motion.x < 35;
            }
            if (current.deposited) {
                deposited = true;
                assert.deepStrictEqual(current.motion, { x: 0, y: 0 }, 'deposit reaches the exact source rectangle');
                break;
            }
        }
        assert.ok(faded && deposited, 'the entire group eases out its avoidance before deposit instead of jumping at arrival');
        shifted.f.finish(); plain.f.finish();
        assert.strictEqual(shifted.f.api.snapshot().retainedBytes + shifted.f.callbacks.size, 0);
    });

    it('rescues a malfunctioning loaded L-UGV while both real payloads keep their owners and deposit deadlines', () => {
        const groups: any[][] = [];
        const f = fixture({ maxActors: 2, encounterRandom: () => 0,
            createTraffic: () => ({ update: (_at: number, input: any[]) => {
                groups.push(input.map(value => ({ ...value })));
                return new Map(input.map(value => [value.id, { x: value.fixed ? 0 : value.id * 7, y: 0 }]));
            }, reset() {} }) }); f.desktop();
        let allowed = 'lugv'; const leased = new Set<string>();
        const ground = { x: 10, y: 387, scale: 1.92 }, aircraft = { x: 850, y: 120, scale: 1.92 };
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (vehicle !== allowed || leased.has(vehicle)) { return; }
            leased.add(vehicle); return vehicle === 'lugv' ? ground : aircraft;
        }, destination: (vehicle: string) => vehicle === 'lugv' ? ground : aircraft,
        release: (vehicle: string) => leased.delete(vehicle) });
        const pages = [f.page(1), f.page(2)]; pages[1].pageElement.rect.left = 540;
        f.api.setVisiblePages([1, 2]);
        for (let index = 0; index < pages.length; index++) {
            allowed = index ? 'quad' : 'lugv';
            assert.strictEqual(f.api.offer({ ...pages[index], imageRegions: [{ id: 'loaded-' + index,
                x: 0.3, y: 0.35, width: 0.18, height: 0.14 }] }), 'started');
        }
        const initial = f.api.snapshot().pages.map((page: any) => page.payloads[0]);
        assert.ok(initial.every((payload: any) => payload.helpers.length === 1));
        let seen = false, carried = false, smoke = false;
        for (let step = 0; step < 120 && f.callbacks.size; step++) {
            f.frame(); const state = f.api.snapshot();
            if (state.encounters.active?.kind !== 'rescue') { continue; }
            seen = true;
            assert.strictEqual(state.encounters.active.rescue.kind, 'airlift');
            assert.strictEqual(groups.at(-1)!.length, 1, 'the coupled rescue is one spacing cohort');
            const actors = state.pages.flatMap((page: any) => page.actors);
            smoke ||= actors.some((actor: any) => actor.malfunction === 'sparks' || actor.malfunction === 'smoke');
            carried ||= actors.some((actor: any) => actor.vehicle === 'lugv' && actor.carried);
            for (const page of state.pages) {
                const payload = page.payloads[0], original = initial.find((item: any) => item.id === payload.id);
                assert.strictEqual(payload.deadline, original.deadline);
                assert.deepStrictEqual(payload.helpers, original.helpers);
                assert.deepStrictEqual(payload.target, original.target);
                const actor = page.actors[0], sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id)
                    && canvas.className === 'pdfDocumentRobotVehicle')!;
                const cargo = f.owned.find(canvas => canvas.dataset.payload === String(payload.id)
                    && canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
                if (cargo) {
                    const a = point(sprite), c = point(cargo);
                    assert.ok(Math.abs(c.x - a.x - (actor.vehicle === 'lugv' ? 87 : 0)) < 0.08);
                    assert.ok(Math.abs(c.y - a.y - (actor.vehicle === 'lugv' ? -75 : 102)) < 0.08,
                        'each actual photo stays attached while one loaded robot assists the other');
                }
            }
            if (actors.some((actor: any) => actor.vehicle === 'lugv' && actor.carried)) {
                const points = actors.map((actor: any) => ({ actor, point: point(f.owned.find(canvas => canvas.dataset.courier === String(actor.id)
                    && canvas.className === 'pdfDocumentRobotVehicle')!) }));
                const g = points.find((value: any) => value.actor.vehicle === 'lugv')!.point;
                const a = points.find((value: any) => value.actor.vehicle === 'quad')!.point;
                assert.ok(Math.abs(a.x - g.x) < 0.08 && Math.abs(a.y - g.y + 38.6 * 1.92) < 0.08,
                    'spacing preserves the shared rescue attachment');
            }
        }
        assert.ok(seen && carried && smoke, 'the real delivery plays malfunction, assistance and a carried-robot phase');
        assert.strictEqual(f.api.snapshot().deliveredFragments, 2);
        assert.strictEqual(f.api.snapshot().activeArrivalCovers + f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(leased.size + f.callbacks.size, 0);
    });

    it('yields an unavoidable ground crossing as one finite group through nearby fixed deposits', () => {
        const f = fixture({ maxActors: 2, encounterRandom: () => 0.99 }); f.desktop();
        const leased = new Map<string, { x: number; y: number; scale: number }>();
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!['rover', 'mecanum'].includes(vehicle) || leased.has(vehicle)) { return; }
            const origin = { x: leased.size ? 10 : 500, y: 405, scale: 1.92 };
            leased.set(vehicle, origin); return origin;
        }, destination: (vehicle: string) => leased.get(vehicle), release: (vehicle: string) => leased.delete(vehicle) });
        const page = f.page(99);
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [
            { id: 'left-photo', x: 0.25, y: 0.4, width: 0.1, height: 0.1 },
            { id: 'right-photo', x: 0.45, y: 0.4, width: 0.1, height: 0.1 },
        ] }), 'started');
        const original = f.api.snapshot().pages[0].payloads;
        assert.strictEqual(original.length, 2);
        assert.ok(original.every((payload: any) => payload.helpers.length === 1));
        const revealed = new Set<number>(); let faded = false, fixedYield = false;
        for (let frame = 0; frame < 150 && f.callbacks.size; frame++) {
            f.frame(); const state = f.api.snapshot(), current = state.pages[0];
            if (!current) { continue; }
            const visible: Array<{ point: { x: number; y: number }; radius: number }> = [];
            for (const payload of current.payloads) {
                const before = original.find((value: any) => value.id === payload.id);
                assert.strictEqual(payload.deadline, before.deadline); assert.deepStrictEqual(payload.helpers, before.helpers);
                assert.deepStrictEqual(payload.target, before.target);
                const actor = current.actors.find((value: any) => value.payloadId === payload.id);
                const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id) && canvas.className === 'pdfDocumentRobotVehicle')!;
                if (payload.visibility < 1) {
                    faded = true; revealed.add(payload.id);
                    fixedYield ||= payload.deposited && !actor.departing;
                    assert.strictEqual(payload.arrivalCovered, false, 'yielding immediately exposes useful destination pixels');
                }
                if (revealed.has(payload.id)) { assert.strictEqual(payload.arrivalCovered, false, 'recovery never remasks a photograph'); }
                if (actor.opacity > 0.2) {
                    visible.push({ point: point(sprite), radius: module.ROBOT_VEHICLES.find((vehicle: any) => vehicle.id === actor.vehicle).radius
                        * parseFloat(sprite.style.width) / module.ROBOT_ARTWORK_SIZE.width });
                }
                const cargo = f.owned.find(canvas => canvas.width && canvas.dataset.payload === String(payload.id) && canvas.className === 'pdfDocumentRobotCargo');
                if (cargo && !payload.deposited && payload.progress > 0.08) {
                    assert.ok(Math.abs(Number(cargo.style.opacity) - actor.opacity) < 1e-9, 'loaded cargo and its vehicle share the yielding factor');
                }
            }
            if (visible.length === 2) {
                const [a, b] = visible;
                assert.ok(Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) >= a.radius + b.radius - 0.1,
                    'visible ground couriers do not pass through each other: ' + JSON.stringify({ frame, actors: current.actors, payloads: current.payloads }));
            }
            assert.strictEqual(state.encounters.active, undefined, 'spacing does not require a comic event');
        }
        assert.ok(faded && fixedYield, 'the yielding owner persists through the positional deposit constraint');
        assert.strictEqual(f.api.snapshot().deliveredFragments, 2);
        assert.strictEqual(f.api.snapshot().activeArrivalCovers + f.api.snapshot().retainedBytes + f.callbacks.size + leased.size, 0);
        assert.deepStrictEqual([page.canvas.width, page.canvas.height], [4320, 6480]);
    });

    it('uses the same column translation for pages and transit without double-shifting cargo', () => {
        let offset = 0, registered: Element | undefined, released = 0;
        const f = fixture({ documentOffset: () => offset, registerDocumentLayer: (layer: Element) => {
            registered = layer; return () => { released++; };
        } }); f.desktop();
        const control = fixture(); control.desktop();
        const page = f.page(99);
        const controlPage = control.page(99);
        control.api.setVisiblePages([99]); control.api.offer(controlPage); control.tick(500);
        f.api.setVisiblePages([99]); f.api.offer(page); f.tick(500);
        assert.ok(registered, 'the renderer registers only its one transit root');
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        const before = point(cargo);
        offset = -60; registered!.style.translate = '-60px'; page.pageElement.rect.left -= 60;
        assert.ok(Math.abs(point(cargo).x - before.x + 60) < 0.02, 'the compositor moves cargo before a renderer frame');
        f.api.setVisiblePages([99]); f.tick(34); control.tick(34);
        const state = f.api.snapshot();
        assert.strictEqual(state.documentOffset, -60);
        const current = point(cargo), source = state.pages[0].payloads.find((item: any) => item.id === Number(cargo.dataset.payload));
        const reference = point(control.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!);
        assert.ok(source && Math.abs(current.x - reference.x + 60) < 0.03 && Math.abs(current.y - reference.y) < 0.03,
            'a normal paint applies the column translation exactly once');
        f.dispose(); assert.strictEqual(released, 1);
    });

    it('lets Navines pull the shifting document edge with one finite actor and no cargo copy', () => {
        let offset = 0, transit: Element | undefined;
        const f = fixture({ maxActors: 1, documentOffset: () => offset,
            registerDocumentLayer: (layer: Element) => { transit = layer; return () => {}; } }); f.desktop();
        const page = f.page(99); page.pageElement.rect.left = 250;
        f.api.setVisiblePages([99]);
        const motion = { id: 1, fromX: 0, toX: -120, startedAt: f.now, durationMs: 400,
            reason: 'dock', dock: 'right', bounds: { x: 250, y: 60, width: 400, height: 600 } };
        assert.strictEqual(typeof f.api.setColumnTransition, 'function');
        f.api.setColumnTransition(motion);
        assert.strictEqual(f.api.snapshot().activeActors, 1);
        assert.strictEqual(f.api.snapshot().activePayloads, 0);
        assert.strictEqual(f.api.snapshot().cargoBytes, 0);
        assert.strictEqual(f.owned.flatMap(canvas => canvas.copies).length, 0);
        const actor = f.api.snapshot().columnPull;
        assert.strictEqual(actor.vehicle, 'forklift');
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.actor))!;
        for (let step = 0; step < 10; step++) {
            const elapsed = (step + 1) * 40;
            offset = -120 * (1 - (1 - elapsed / 400) ** 3);
            transit!.style.translate = offset + 'px'; page.pageElement.rect.left = 250 + offset;
            f.tick(40);
            const state = f.api.snapshot().columnPull;
            assert.ok(state);
            if (state.phase === 'pull') {
                const target = module.ROBOT_FORKLIFT_ATTACHMENT.pull.right;
                const handX = point(sprite).x + target.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * f.api.snapshot().spriteScale;
                assert.ok(Math.abs(handX - (250 + offset)) < 0.05, 'the manipulator follows the actual moving page edge');
            }
        }
        f.api.setColumnTransition(undefined);
        f.finish();
        assert.strictEqual(f.api.snapshot().columnPull, undefined);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
        assert.deepStrictEqual([page.canvas.width, page.canvas.height], [4320, 6480]);
    });

    it('defers column completion geometry to the queued paint and returns from the final edge', () => {
        let offset = 0, transit: Element | undefined;
        const f = fixture({ maxActors: 1, documentOffset: () => offset,
            registerDocumentLayer: (layer: Element) => { transit = layer; return () => {}; } }); f.desktop();
        const page = f.page(99); page.pageElement.rect.left = 250;
        f.api.setVisiblePages([99]);
        const motion = { id: 1, fromX: 0, toX: -120, startedAt: f.now, durationMs: 400,
            reason: 'dock', dock: 'right', bounds: { x: 250, y: 60, width: 400, height: 600 } };
        f.api.setColumnTransition(motion);
        offset = -70; transit!.style.translate = '-70px'; page.pageElement.rect.left = 180;
        f.tick(160);
        const before = f.api.snapshot(), actor = before.columnPull;
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.actor))!;
        const reads = () => sceneNodes(f.document.body).reduce((total, element) => total + element.layoutReads, 0);
        const previousReads = reads();

        // The column finishes its style write before the renderer's next frame.
        f.now = motion.startedAt + motion.durationMs;
        offset = -120; transit!.style.translate = '-120px'; page.pageElement.rect.left = 130;
        f.api.setColumnTransition(undefined);
        assert.strictEqual(reads(), previousReads, 'completion does not read layout after the column style write');
        assert.strictEqual(f.api.snapshot().frames, before.frames, 'completion only marks the existing frame dirty');
        assert.strictEqual(f.callbacks.size, 1, 'the finite return shares the already queued frame');

        f.tick(0);
        const current = f.api.snapshot();
        const hand = module.ROBOT_FORKLIFT_ATTACHMENT.pull.right;
        const handX = point(sprite).x + hand.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * current.spriteScale;
        assert.ok(Math.abs(handX - 130) < 0.05, 'the return starts at the final translated edge, not the preceding paint');
        assert.strictEqual(current.columnPull.phase, 'return');
        assert.strictEqual(current.columnPull.deadline, actor.deadline, 'deferring paint preserves the original finish deadline');
        f.finish();
        assert.strictEqual(f.api.snapshot().columnPull, undefined);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    it('preempts the document pull for ready cargo and cancels it on hard lifecycle boundaries', () => {
        for (const ending of ['ready', 'offscreen', 'hide', 'reduce', 'disable', 'reset', 'replacement', 'dispose', 'cancel']) {
            const f = fixture({ maxActors: 1 }); f.desktop();
            const page = f.page(99); page.pageElement.rect.left = 250; f.api.setVisiblePages([99]);
            f.api.setColumnTransition({ id: 1, fromX: 0, toX: -120, startedAt: f.now, durationMs: 400,
                reason: 'dock', dock: 'right', bounds: { x: 250, y: 60, width: 400, height: 600 } });
            const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width)!;
            assert.ok(sprite, ending);
            if (ending === 'ready') { assert.strictEqual(f.api.offer(page), 'started'); }
            else if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            else if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'reduce') { f.media.matches = true; f.media.emit('change'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else if (ending === 'replacement') { f.api.retireDocument([page], 'edition-b'); }
            else if (ending === 'cancel') { f.api.cancelColumnMotion(); }
            else { f.api[ending](); }
            assert.strictEqual(f.api.snapshot().columnPull, undefined, ending);
            assert.strictEqual(sprite.zeroWrites, 1, ending);
            assert.ok(f.api.snapshot().activeActors <= 1);
        }
    });

    it('keeps the pulling manipulator fixed while nearby loaded traffic receives its own spacing', () => {
        let latest: any[] = [], offset = 0, transit: Element | undefined;
        const f = fixture({ maxActors: 3, encounterRandom: () => 0.99, documentOffset: () => offset,
            registerDocumentLayer: (layer: Element) => { transit = layer; return () => {}; },
            createTraffic: () => ({ update: (_at: number, groups: any[]) => {
                latest = groups; return new Map(groups.map(group => [group.id, { x: group.fixed ? 0 : 45, y: 0 }]));
            }, reset() {} }) }); f.desktop();
        const page = f.page(99); page.pageElement.rect.left = 250;
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [{ id: 'upper-photo', x: 0.45, y: 0.2, width: 0.15, height: 0.1 }] }), 'started');
        f.tick(100);
        f.api.setColumnTransition({ id: 1, fromX: 0, toX: -80, startedAt: f.now, durationMs: 400,
            reason: 'dock', dock: 'right', bounds: { x: 250, y: 60, width: 400, height: 600 } });
        offset = -40; transit!.style.translate = '-40px'; page.pageElement.rect.left -= 40;
        f.tick(160);
        const state = f.api.snapshot(), pull = state.columnPull;
        assert.ok(pull && latest.length >= 2, 'the constrained actor and actual cargo coexist');
        assert.ok(latest.find(group => group.id === -(pull.actor + 1))?.fixed, 'the pull remains a present fixed obstacle');
        assert.ok(state.pages[0].payloads.some((payload: any) => payload.motion.x > 0), 'ordinary loaded traffic still receives spacing');
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(pull.actor))!;
        const target = module.ROBOT_FORKLIFT_ATTACHMENT.pull.right;
        assert.ok(Math.abs(point(sprite).x + target.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * state.spriteScale - 210) < 0.05,
            'spacing never detaches the manipulator from the moving page edge');
        f.finish(); assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('refinement replaces an active real photo in place without changing its team, route or deadline', () => {
        const { f, source } = coarsePhoto(); f.tick(100);
        const before = f.api.snapshot().pages[0].payloads[0];
        const old = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.dataset.payload === String(before.id))!;
        const originalParent = old.parentNode;
        assert.strictEqual(f.api.refine(source()), 1);
        const after = f.api.snapshot().pages[0].payloads[0];
        assert.ok(Number.isFinite(before.deadline));
        for (const key of ['id', 'mode', 'ground', 'imageId', 'deadline', 'progress', 'stage', 'deposited', 'handedOff']) {
            assert.strictEqual(after[key], before[key], key + ' belongs to the original delivery');
        }
        assert.deepStrictEqual(after.helpers, before.helpers);
        assert.deepStrictEqual(after.target, before.target);
        assert.strictEqual(after.refinements, 1);
        assert.strictEqual(f.api.snapshot().cleaner, undefined, 'a full delivery team keeps its actor slots');
        const sharp = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo'
            && canvas.dataset.payload === String(before.id) && canvas.width > 0)!;
        assert.notStrictEqual(sharp, old);
        assert.strictEqual(sharp.parentNode, originalParent);
        assert.strictEqual(old.zeroWrites, 1);
        assert.ok(sharp.width > 81 && sharp.height > 77);
        const high = source(1080, 1536);
        assert.strictEqual(f.api.refine(high), 1);
        high.canvas.width = high.canvas.height = 0;
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].refinements, 2);
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deadline, before.deadline);
        assert.strictEqual(sharp.zeroWrites, 1);
        f.finish();
        const allocated = f.owned.length;
        assert.strictEqual(f.api.refine(source(2160, 3072)), 0, 'released cargo cannot be revived by a later native render');
        assert.strictEqual(f.owned.length, allocated);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
    });

    it('refinement charges old and new rasters together and rolls back a failed copy without repeated allocations', () => {
        const { f, source } = coarsePhoto();
        const payload = f.api.snapshot().pages[0].payloads[0];
        const old = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.dataset.payload === String(payload.id))!;
        const bytes = f.api.snapshot().cargoBytes;
        // The fixture factory is fixed at install; fail just the next created copy through its prototype.
        const descriptor = Object.getOwnPropertyDescriptor(Canvas.prototype, 'getContext')!;
        const original = Canvas.prototype.getContext;
        let attempts = 0;
        Canvas.prototype.getContext = function (kind?: string, options?: any) {
            if (!this.className && this.width > 64) {
                this.failCopy = true;
                this.beforeCopy = args => {
                    if (args.length !== 9) { return; }
                    attempts++;
                    assert.strictEqual(f.api.snapshot().cargoBytes, bytes + this.width * this.height * 4, 'temporary replacement bytes are charged before copying');
                    assert.ok(f.api.snapshot().cargoBytes <= f.api.snapshot().maxCargoBytes);
                };
            }
            return original.call(this, kind, options);
        };
        try {
            assert.strictEqual(f.api.refine(source()), 0);
            const allocated = f.owned.length;
            assert.strictEqual(f.api.refine(source()), 0);
            assert.strictEqual(f.owned.length, allocated, 'the same failed quality tier is not reallocated on every refresh');
            assert.strictEqual(attempts, 1);
            assert.strictEqual(f.api.snapshot().cargoBytes, bytes);
            assert.strictEqual(old.zeroWrites, 0);
            assert.ok(old.isConnected);
        } finally { Object.defineProperty(Canvas.prototype, 'getContext', descriptor); }
    });

    it('refinement refuses an over-budget copy even when replacing the old raster would fit afterward', () => {
        const { f, source } = coarsePhoto({ device: 'mobile', maxCargoBytes: 230000 });
        const old = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        assert.deepStrictEqual([old.width, old.height], [81, 77]);
        assert.ok(240 * 227 * 4 < 230000 && 240 * 227 * 4 + old.width * old.height * 4 > 230000);
        const allocated = f.owned.length, before = f.api.snapshot();
        assert.strictEqual(f.api.refine(source()), 0);
        assert.strictEqual(f.owned.length, allocated, 'peak budget is checked before any new bitmap allocation');
        assert.strictEqual(f.api.snapshot().cargoBytes, before.cargoBytes);
        assert.strictEqual(old.zeroWrites, 0);
    });

    it('a real sharper crop admits one finite ASAP wipe without restarting its delivery or allocating an idle loop', () => {
        const { f, source } = coarsePhoto({ maxActors: 4 });
        const before = f.api.snapshot();
        assert.strictEqual(before.cleaner, undefined, 'the coarse raster alone cannot claim a quality improvement');
        assert.ok(before.activeActors < before.maxActors);
        const coarse = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        f.tick(100);
        assert.strictEqual(f.api.refine(source()), 1);
        const began = f.api.snapshot(), cleaner = began.cleaner;
        assert.ok(cleaner && cleaner.duration > 0);
        assert.strictEqual(began.activeActors, before.activeActors + 1);
        assert.ok(began.activeActors <= began.maxActors && began.spriteBytes <= began.maxSpriteBytes);
        assert.strictEqual(began.pages[0].payloads[0].deadline, before.pages[0].payloads[0].deadline);
        assert.ok(coarse.width > 0 && coarse.isConnected, 'coarse pixels remain underneath until the finite wipe reveals sharp pixels');
        assert.strictEqual(coarse.className, 'pdfDocumentRobotCargoUnderlay');
        assert.strictEqual(began.pages[0].payloads[0].refinementPending, true);
        assert.strictEqual(began.cargoBytes, f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotCargo'
            || canvas.className === 'pdfDocumentRobotCargoUnderlay').reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0));
        const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCleaner' && canvas.width)!;
        assert.ok(sprite);
        f.tick(120);
        assert.ok(Number(sprite.style.opacity) > 0, 'the finite cleaner appears only after its geometry is painted');
        const progress = f.api.snapshot().pages[0].payloads[0].refinementProgress;
        assert.ok(progress > 0 && progress < 1);
        const sharp = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        assert.ok(sharp.style.clipPath.startsWith('inset('), 'only the already wiped part of the sharper crop is visible');
        assert.strictEqual(f.api.refine(source(1080, 1536)), 1);
        assert.strictEqual(f.api.snapshot().cleaner.started, cleaner.started, 'a finer tier does not restart the wipe');
        assert.strictEqual(f.api.snapshot().cleaner.id, cleaner.id);
        assert.strictEqual(coarse.zeroWrites, 0, 'the same coarse underlay survives a second sharper tier');
        assert.strictEqual(sharp.zeroWrites, 1, 'only the superseded sharp overlay is released');
        f.tick(cleaner.duration);
        assert.strictEqual(f.api.snapshot().cleaner, undefined);
        assert.strictEqual(sprite.zeroWrites, 1);
        assert.strictEqual(coarse.zeroWrites, 1);
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].refinementPending, false);
        assert.strictEqual(f.api.snapshot().activeActors, before.activeActors);
        f.finish();
        assert.strictEqual(f.callbacks.size, 0);
        const frames = f.api.snapshot().frames;
        f.tick(20000);
        assert.strictEqual(f.api.snapshot().frames, frames, 'the wipe has no idle scheduler');
    });

    it('the cleaner yields to ready delivery and releases once on every hard scene cancellation', () => {
        for (const ending of ['ready', 'offscreen', 'hide', 'reduce', 'disable', 'reset', 'replacement', 'dispose']) {
            const { f, source, page } = coarsePhoto({ maxActors: 4 });
            f.tick(100); assert.strictEqual(f.api.refine(source()), 1);
            const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCleaner' && canvas.width)!;
            assert.ok(sprite, ending);
            const underlay = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargoUnderlay' && canvas.width)!;
            assert.ok(underlay, ending);
            const late = [...f.callbacks.values()];
            if (ending === 'ready') {
                const next = f.page(100);
                f.api.setVisiblePages([99, 100]);
                assert.strictEqual(f.api.offer(next), 'started');
            } else if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            else if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'reduce') { f.media.matches = true; f.media.emit('change'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else if (ending === 'reset') { f.api.reset(); }
            else if (ending === 'replacement') { f.api.retireDocument([page], 'new-edition'); }
            else { f.api.dispose(); }
            assert.strictEqual(f.api.snapshot().cleaner, undefined, ending);
            assert.strictEqual(sprite.zeroWrites, 1, ending + ' has one cleanup owner');
            assert.strictEqual(underlay.zeroWrites, 1, ending + ' releases the retained coarse crop once');
            const allocated = f.owned.length;
            if (ending !== 'ready') { for (const callback of late) { callback(f.now + 40); } }
            assert.strictEqual(f.owned.length, allocated, 'an obsolete frame cannot allocate a replacement cleaner');
            assert.ok(f.api.snapshot().activeActors <= f.api.snapshot().maxActors);
        }
    });

    it('retires expired arrival pixels before refining ahead of a delayed paint', () => {
        const { f, source } = coarsePhoto({ maxActors: 4 });
        const before = f.api.snapshot().pages[0].payloads[0];
        const coarse = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        const allocated = f.owned.length;
        assert.ok(f.callbacks.size > 0, 'the deposit paint is still queued');
        // Move the clock past deposit without delivering that queued animation frame.
        f.now = before.deadline * 0.63;
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deposited, false);
        assert.strictEqual(f.api.refine(source()), 0, 'expired pixels cannot authorize a late refinement');
        assert.strictEqual(f.owned.length, allocated, 'no replacement crop or cleaner is allocated');
        const state = f.api.snapshot(), after = state.pages[0].payloads[0];
        assert.strictEqual(state.activePayloads + state.activeArrivalCovers + state.cargoBytes, 0);
        assert.strictEqual(state.cleaner, undefined);
        assert.strictEqual(coarse.zeroWrites, 1);
        assert.strictEqual(after.id, before.id); assert.strictEqual(after.deadline, before.deadline);
        assert.deepStrictEqual(after.helpers, before.helpers);
        f.finish();
        assert.strictEqual(coarse.zeroWrites, 1, 'the later deposit and return cannot release pixels twice');
        assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    for (const ending of ['reader input', 'traffic fade', 'deposit', 'detached cover', 'detached cover before paint']) {
        it('terminally retires revealed cargo after ' + ending + ' while preserving its finite return owner', () => {
            let visibility = 1;
            const { f, page, delivery, source } = coarsePhoto({ maxActors: 4,
                createTraffic: () => ({ update: (_at: number, groups: Array<{ id: number }>) =>
                    new Map(groups.map(group => [group.id, { x: 0, y: 0, visibility }])), reset() {} }) });
            f.tick(100); assert.strictEqual(f.api.refine(source()), 1);
            const before = f.api.snapshot().pages[0].payloads[0];
            const rasters = f.owned.filter(canvas => ['pdfDocumentRobotCargo', 'pdfDocumentRobotCargoUnderlay'].includes(canvas.className) && canvas.width);
            assert.strictEqual(rasters.length, 2);
            assert.ok(f.api.snapshot().cleaner);
            if (ending === 'reader input') { f.api.revealArrivals(); }
            else if (ending === 'traffic fade') { visibility = 0.5; f.frame(); }
            else if (ending === 'deposit') { f.tick(before.deadline * 0.63 - f.now); }
            else {
                page.pageElement.replaceChildren(page.canvas, page.text);
                if (ending === 'detached cover') {
                    assert.strictEqual(f.api.refine(source(1080, 1536)), 0, 'a detached cover cannot authorize a fresh raster');
                } else { f.frame(); }
            }
            const state = f.api.snapshot(), after = state.pages[0].payloads[0];
            assert.strictEqual(state.activePayloads + state.activeArrivalCovers + state.cargoBytes, 0);
            assert.strictEqual(state.cleaner, undefined);
            assert.ok(rasters.every(canvas => canvas.zeroWrites === 1 && !canvas.parentNode));
            assert.strictEqual(after.id, before.id); assert.strictEqual(after.deadline, before.deadline);
            assert.deepStrictEqual(after.helpers, before.helpers);
            visibility = 1; f.frame();
            assert.strictEqual(f.api.offer(delivery), 'skipped');
            assert.strictEqual(f.api.refine(source(1080, 1536)), 0, 'revealed cargo cannot be revived by later quality');
            assert.strictEqual(f.api.snapshot().activePayloads + f.api.snapshot().activeArrivalCovers, 0);
            f.finish();
            assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
        });
    }

    it('reattaches only the same authorized cover to its current page before native rendering resumes', () => {
        const { f, page, source } = coarsePhoto({ maxActors: 4 });
        f.tick(100); assert.strictEqual(f.api.refine(source()), 1);
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
        const before = f.api.snapshot(), allocated = f.owned.length;
        page.pageElement.replaceChildren(page.canvas, page.text);
        const foreign = f.page(99);
        f.api.restoreArrivals(99, foreign.pageElement);
        assert.strictEqual(cover.parentNode, null, 'the same page number does not authorize a different page element');
        f.api.restoreArrivals(99, page.pageElement);
        assert.strictEqual(cover.parentNode, page.pageElement);
        assert.strictEqual(f.owned.length, allocated, 'restoration reuses the exact cover and rasters');
        f.frame();
        assert.strictEqual(f.api.snapshot().activeArrivalCovers, 1);
        assert.strictEqual(f.api.snapshot().cargoBytes, before.cargoBytes);
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].id, before.pages[0].payloads[0].id);
        f.api.revealArrivals(); f.api.restoreArrivals(99, page.pageElement);
        assert.strictEqual(f.api.snapshot().activeArrivalCovers + f.api.snapshot().activePayloads, 0);
        f.api.reset(); f.api.setVisiblePages([99]); f.api.restoreArrivals(99, page.pageElement);
        assert.strictEqual(cover.parentNode, null, 'a document reset retires the old cover identity');
    });

    it('copies both fractional photo endpoints outward without losing the last source pixel', () => {
        const f = fixture({ maxActors: 1 }); f.desktop();
        const page = f.page(99);
        page.canvas.width = 1000; page.canvas.height = 1000;
        const image = { id: 'fractional-photo', x: 0.1009, y: 0.2009, width: 0.3002, height: 0.2002 };
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [image] }), 'started');
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        const copy = cargo.copies.find(args => args[0] === page.canvas)!;
        assert.ok(copy, 'the real source image supplies the carried pixels');
        assert.strictEqual(copy[1], Math.floor(image.x * page.canvas.width));
        assert.strictEqual(copy[2], Math.floor(image.y * page.canvas.height));
        assert.strictEqual(copy[1] + copy[3], Math.ceil((image.x + image.width) * page.canvas.width),
            'the outward right edge must include the pixel touched by the fractional endpoint');
        assert.strictEqual(copy[2] + copy[4], Math.ceil((image.y + image.height) * page.canvas.height),
            'the outward bottom edge must include the pixel touched by the fractional endpoint');
        const payload = f.api.snapshot().pages[0].payloads[0];
        for (const key of ['x', 'y', 'width', 'height'] as const) {
            assert.ok(Math.abs(payload.target[key] - image[key]) < 1e-12, 'pixel rounding preserves the logical ' + key);
        }
        f.finish();
        assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('aligns atlas cargo and outward arrival coverage with the rounded native page clip', () => {
        const f = fixture({ maxActors: 1 }); f.desktop(1.2);
        const page = f.page(99);
        page.pageElement.rect = { left: 40, top: 60, width: 330, height: 470 };
        page.canvas.width = 541; page.canvas.height = 768;
        const logicalWidth = 332.5986666666667, logicalHeight = 472.4406666666667;
        const image = { id: 'rounded-native-photo', x: 0.1, y: 0.2, width: 0.6, height: 0.4 };
        const delivery = { ...page, kind: 'preview' as const, imageRegions: [image],
            rasterProjection: { width: 541, height: 768, pageToRaster: [541, 0, 0, 768, 0, 0] },
            pageProjection: { content: { x: 0, y: 0, width: logicalWidth, height: logicalHeight },
                clip: { x: 0, y: 0, width: 330, height: 470 } },
            displayRasterProjection: { width: 396, height: 564,
                pageToRaster: [logicalWidth * 1.2, 0, 0, logicalHeight * 1.2, 0, 0] } };
        f.api.setVisiblePages([99]); assert.strictEqual(f.api.offer(delivery), 'started');
        const payload = f.api.snapshot().pages[0].payloads[0];
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
        const css = (property: string, extent: number) => parseFloat(cover.style[property])
            * (cover.style[property].endsWith('%') ? extent / 100 : 1);
        const left = css('left', 330), top = css('top', 470);
        const right = left + css('width', 330), bottom = top + css('height', 470);
        assert.ok(Math.abs(left - (Math.floor(image.x * logicalWidth * 1.2) - 2) / 1.2) < 1e-9,
            'the mask guards the native pixel footprint, not the squeezed atlas percentage');
        assert.ok(Math.abs(top - (Math.floor(image.y * logicalHeight * 1.2) - 2) / 1.2) < 1e-9);
        assert.ok(Math.abs(right - (Math.ceil((image.x + image.width) * logicalWidth * 1.2) + 2) / 1.2) < 1e-9);
        assert.ok(Math.abs(bottom - (Math.ceil((image.y + image.height) * logicalHeight * 1.2) + 2) / 1.2) < 1e-9);
        f.tick(payload.deadline * 0.6199);
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        assert.ok(Math.abs(parseFloat(cargo.style.width) - image.width * logicalWidth) < 0.01);
        assert.ok(Math.abs(parseFloat(cargo.style.height) - image.height * logicalHeight) < 0.01);
        const center = point(cargo);
        assert.ok(Math.abs(center.x - (40 + (image.x + image.width / 2) * logicalWidth)) < 0.05);
        assert.ok(Math.abs(center.y - (60 + (image.y + image.height / 2) * logicalHeight)) < 0.05);
        f.finish();
        assert.strictEqual(cover.parentNode, null);
        assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('guards the measured fractional atlas arrival edge by one source and one display pixel without changing cargo', () => {
        const f = fixture({ maxActors: 1 }); f.desktop(1.2);
        const page = f.page(100);
        page.pageElement.rect = { left: 40, top: 60, width: 332, height: 472 };
        page.canvas.width = 541; page.canvas.height = 768;
        const width = 332.5986666666667, height = 472.4406666666667;
        const image = { id: 'p100-i6', x: 0.12780968981318078, y: 0.4236102175389567,
            width: 0.24214563775508643, height: 0.1132769577584542 };
        const raster = { width: 541, height: 768, pageToRaster: [541, 0, 0, 768, 0, 0] };
        f.api.setVisiblePages([100]);
        assert.strictEqual(f.api.offer({ ...page, kind: 'preview', imageRegions: [image], rasterProjection: raster,
            displayRasterProjection: raster,
            pageProjection: { content: { x: 0, y: 0, width, height }, clip: { x: 0, y: 0, width: 332, height: 472 } } }), 'started');
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        const payload = f.api.snapshot().pages[0].payloads[0];
        const left = parseFloat(cover.style.left), top = parseFloat(cover.style.top);
        const right = left + parseFloat(cover.style.width), bottom = top + parseFloat(cover.style.height);
        const sampled = { left: (Math.floor(image.x * 541) - 1) * width / 541,
            top: (Math.floor(image.y * 768) - 1) * height / 768,
            right: (Math.ceil((image.x + image.width) * 541) + 1) * width / 541,
            bottom: (Math.ceil((image.y + image.height) * 768) + 1) * height / 768 };
        for (const expansion of [sampled.left - left, sampled.top - top, right - sampled.right, bottom - sampled.bottom]) {
            assert.ok(Math.abs(expansion * 1.2 - 1) < 1e-9,
                'the compositor guard remains exactly one physical pixel beyond the source-texel margin');
        }
        assert.ok(right < (image.x + image.width) * width + 4.3, 'the saved neighbouring photo gutter remains open');
        assert.deepStrictEqual([cargo.width, cargo.height], [132, 87], 'cover guard does not enlarge or recopy cargo');
        assert.strictEqual(cargo.copies.length, 1);
        for (const key of ['x', 'y', 'width', 'height'] as const) { assert.strictEqual(payload.target[key], image[key]); }
        f.finish();
        assert.strictEqual(cover.parentNode, null);
        assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    for (const photo of [
        { id: 'p99-i0', y: 0.14090420630897255, height: 0.12505938486751272, firstRow: 72,
            physicalBounds: [246.0333333333333, 530.9168391227722, 597.9666666666667, 734.7820253372192], neighbour: 608 },
        { id: 'p99-i8', y: 0.689918490716582, height: 0.1250593633356536, firstRow: 353,
            physicalBounds: [246.0333333333333, 1377.5454559326172, 597.9666666666667, 1581.4106421470642], neighbour: 609 },
    ]) {
        it(`covers the magnified outside texel of ${photo.id} on the measured DPR 3 phone`, () => {
            const f = fixture({ maxActors: 1, device: 'mobile' });
            Object.assign(f.window, { innerWidth: 402, innerHeight: 654, devicePixelRatio: 3 });
            f.container.rect = { left: 0, top: 106, width: 402, height: 548 };
            const page = f.page(99); page.pageElement.rect = { left: 20, top: 106, width: 362, height: 514 };
            page.canvas.width = 360; page.canvas.height = 512;
            const width = 362, height = 514.203857421875;
            const image = { id: photo.id, x: 0.1755328669326745, y: photo.y, width: 0.315806107087826, height: photo.height };
            const raster = { width: 360, height: 512, pageToRaster: [360, 0, 0, 512, 0, 0] };
            f.api.setVisiblePages([99]);
            assert.strictEqual(f.api.offer({ ...page, kind: 'preview', imageRegions: [image], rasterProjection: raster,
                displayRasterProjection: raster,
                pageProjection: { content: { x: 0, y: 0, width, height }, clip: { x: 0, y: 0, width, height: 514 } } }), 'started');
            const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
            const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
            const before = f.api.snapshot().pages[0].payloads[0];
            const left = parseFloat(cover.style.left), top = parseFloat(cover.style.top);
            const right = left + parseFloat(cover.style.width), bottom = top + parseFloat(cover.style.height);
            const physical = [(20 + left) * 3, (106 + top) * 3, (20 + right) * 3, (106 + bottom) * 3];
            physical.forEach((value, index) => assert.ok(Math.abs(value - photo.physicalBounds[index]) < 1e-8,
                'the mask includes the first outside source texel and the separate physical-pixel margin'));
            assert.ok(right >= 178 * width / 360, 'the complete dark outside column 177 is hidden');
            assert.ok(photo.neighbour - physical[2] >= 10, 'the measured neighbouring photo remains outside the cover');
            if (photo.id === 'p99-i8') { assert.ok(1602 - physical[3] >= 20, 'the first measured caption glyph remains clear'); }
            assert.deepStrictEqual([cargo.width, cargo.height], [114, 65]);
            assert.deepStrictEqual(cargo.copies[0].slice(1), [63, photo.firstRow, 114, 65, 63, photo.firstRow, 114, 65],
                'the coverage margin does not change source pixels copied into the exact photo cargo');
            assert.strictEqual(cargo.copies.length, 1);
            for (const key of ['x', 'y', 'width', 'height'] as const) { assert.strictEqual(before.target[key], image[key]); }
            f.frame();
            const after = f.api.snapshot().pages[0].payloads[0];
            assert.strictEqual(after.id, before.id); assert.strictEqual(after.deadline, before.deadline);
            assert.strictEqual(cargo.copies.length, 1);
            f.finish();
            assert.strictEqual(cover.parentNode, null);
            assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
        });
    }

    it('preserves a clipped retained quarter-turn through atlas refinement and terminal release', () => {
        const f = fixture({ maxActors: 1 }); f.desktop(1.2);
        const page = f.page(99);
        page.pageElement.rect = { left: 40, top: 60, width: 470, height: 330 };
        page.canvas.width = 396; page.canvas.height = 564;
        const originalWidth = 332.5986666666667, originalHeight = 472.4406666666667;
        const fullWidth = originalWidth * 1.2, fullHeight = originalHeight * 1.2;
        const image = { id: 'quarter-turn-photo', x: 0.002, y: 0.89, width: 0.2, height: 0.1 };
        const rasterProjection = { width: 396, height: 564, pageToRaster: [0, -fullHeight, fullWidth, 0, 0, fullHeight] };
        const delivery = { ...page, imageRegions: [image], rasterProjection,
            displayRasterProjection: rasterProjection,
            pageProjection: { content: { x: 470 - originalHeight, y: 0, width: originalHeight, height: originalWidth },
                clip: { x: 0, y: 0, width: 470, height: 330 } } };
        f.api.setVisiblePages([99]); assert.strictEqual(f.api.offer(delivery), 'started');
        const before = f.api.snapshot().pages[0].payloads[0];
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        const copy = cargo.copies.find(args => args[0] === page.canvas)!;
        assert.ok(copy[1] >= 0 && copy[2] >= 0 && copy[1] + copy[3] <= 396 && copy[2] + copy[4] <= 564,
            'read bounds exclude clipped pixels and ceil padding');
        assert.deepStrictEqual([cargo.width, cargo.height], [Math.ceil(fullHeight * image.width), Math.ceil(fullWidth * image.height)],
            'the retained backing rotation must not swap the logical cargo axes');
        const transform = cargo.transforms[0];
        const map = (x: number, y: number) => ({ x: transform[0] * x + transform[2] * y + transform[4],
            y: transform[1] * x + transform[3] * y + transform[5] });
        const corner = map(fullWidth * image.y, fullHeight * (1 - image.x));
        const center = map(fullWidth * (image.y + image.height / 2), fullHeight * (1 - image.x - image.width / 2));
        assert.ok(Math.abs(corner.x) + Math.abs(corner.y) < 1e-9, 'the exact logical corner stays at the cargo origin');
        assert.ok(Math.abs(center.x - cargo.width / 2) + Math.abs(center.y - cargo.height / 2) < 1e-9,
            'a clipped read is not stretched over the unchanged target');
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
        assert.ok(Math.abs(parseFloat(cover.style.left)) < 1e-9, 'native leading-edge clipping also clips the mask');
        assert.ok(parseFloat(cover.style.top) + parseFloat(cover.style.height) <= 330);
        const mask = ['left', 'top', 'width', 'height'].map(key => cover.style[key]);
        f.tick(100);
        const atlas = new Canvas(f.document); atlas.width = 768; atlas.height = 541;
        assert.strictEqual(f.api.refine({ ...delivery, canvas: atlas, kind: 'preview',
            rasterProjection: { width: 768, height: 541, pageToRaster: [768, 0, 0, 541, 0, 0] } }), 1);
        const after = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(after.id, before.id); assert.strictEqual(after.deadline, before.deadline);
        assert.deepStrictEqual(after.helpers, before.helpers); assert.deepStrictEqual(after.target, before.target);
        assert.deepStrictEqual(['left', 'top', 'width', 'height'].map(key => cover.style[key]), mask,
            'atlas refinement must not move the native-grid destination cover');
        f.api.revealArrivals();
        assert.strictEqual(f.api.refine({ ...delivery, canvas: atlas }), 0);
        assert.strictEqual(f.api.snapshot().activePayloads + f.api.snapshot().activeArrivalCovers, 0);
        f.finish(); assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('covers high-density phone edge pixels without extending onto neighbouring caption space', () => {
        const f = fixture({ maxActors: 1, device: 'mobile' });
        Object.assign(f.window, { innerWidth: 402, innerHeight: 654, devicePixelRatio: 3 });
        f.container.rect = { left: 0, top: 32, width: 402, height: 622 };
        const page = f.page(99);
        page.pageElement.rect = { left: 11, top: 45, width: 380, height: 540 };
        page.canvas.width = 1140; page.canvas.height = 1620;
        const width = 380.8, height = 540.3;
        const image = { id: 'phone-edge-photo', x: 0.81, y: 0.67, width: 0.19, height: 0.3 };
        const rasterProjection = { width: 1140, height: 1620, pageToRaster: [width * 3, 0, 0, height * 3, 0, 0] };
        page.text.textContent = 'The adjacent caption remains readable.';
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [image], rasterProjection, displayRasterProjection: rasterProjection,
            pageProjection: { content: { x: 0, y: 0, width, height }, clip: { x: 0, y: 0, width: 380, height: 540 } } }), 'started');
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
        const left = parseFloat(cover.style.left), top = parseFloat(cover.style.top);
        const right = left + parseFloat(cover.style.width), bottom = top + parseFloat(cover.style.height);
        assert.ok(Math.abs(left - (Math.floor(image.x * width * 3) - 2) / 3) < 1e-9);
        assert.ok(Math.abs(top - (Math.floor(image.y * height * 3) - 2) / 3) < 1e-9);
        assert.ok(Math.abs(right - 380) < 1e-9, 'the right edge stops at the native page clip');
        assert.ok(bottom >= (image.y + image.height) * height - 1e-9);
        assert.ok(bottom <= (image.y + image.height) * height + 1 + 1e-9,
            'outward coverage adds the touched pixel, one source texel and one physical display pixel');
        assert.strictEqual(cover.style.borderRadius, '0');
        assert.strictEqual(cover.style.pointerEvents, 'none');
        assert.strictEqual(page.text.textContent, 'The adjacent caption remains readable.');
        assert.strictEqual(page.canvas.copies.length, 0);
        f.finish(); assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('keeps a pinch-scaled phone arrival guard at one display pixel inside the page and caption boundary', () => {
        const f = fixture({ maxActors: 1, device: 'mobile' });
        Object.assign(f.window, { innerWidth: 402, innerHeight: 654, devicePixelRatio: 3 });
        f.window.visualViewport = Object.assign(new Events(), { offsetLeft: 0, offsetTop: 0, width: 402, height: 654, scale: 1 });
        f.container.rect = { left: 0, top: 32, width: 402, height: 622 };
        const page = f.page(99);
        page.pageElement.rect = { left: 11, top: 45, width: 380, height: 540 };
        page.canvas.width = 1140; page.canvas.height = 1620;
        const width = 380.8, height = 540.3;
        const image = { id: 'phone-edge-photo', x: 0.81, y: 0.67, width: 0.19, height: 0.3 };
        const raster = { width: 1140, height: 1620, pageToRaster: [width * 3, 0, 0, height * 3, 0, 0] };
        page.text.textContent = 'The adjacent caption remains readable.';
        page.text.rect = { left: 11, top: 45 + 525, width: 380, height: 15 };
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [image], rasterProjection: raster, displayRasterProjection: raster,
            pageProjection: { content: { x: 0, y: 0, width, height }, clip: { x: 0, y: 0, width: 380, height: 540 } } }), 'started');
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        const before = f.api.snapshot().pages[0].payloads[0];
        const dimensions = [cargo.width, cargo.height], copies = cargo.copies.length;
        const sampledLeft = (Math.floor(image.x * width * 3) - 1) / 3;
        const sampledTop = (Math.floor(image.y * height * 3) - 1) / 3;
        const sampledBottom = (Math.ceil((image.y + image.height) * height * 3) + 1) / 3;
        for (const scale of [1, 2, 1.25]) {
            f.window.visualViewport.scale = scale;
            f.frame();
            const left = parseFloat(cover.style.left), top = parseFloat(cover.style.top);
            const right = left + parseFloat(cover.style.width), bottom = top + parseFloat(cover.style.height);
            for (const expansion of [sampledLeft - left, sampledTop - top, bottom - sampledBottom]) {
                assert.ok(Math.abs(expansion * 3 * scale - 1) < 1e-9, 'pinch changes CSS guard size, not its physical-pixel coverage');
            }
            assert.ok(left >= 0 && top >= 0 && right <= 380 + 1e-9 && bottom <= 540,
                'the extra coverage remains clipped to the page inner box');
            assert.ok(Math.abs(right - 380) < 1e-9, 'outward expansion cannot escape the clipped right edge');
            assert.ok(bottom <= page.text.rect.top - page.pageElement.rect.top + 1e-9, 'the adjacent caption is outside the guarded mask');
            assert.deepStrictEqual([cargo.width, cargo.height], dimensions);
            assert.strictEqual(cargo.copies.length, copies);
            const after = f.api.snapshot().pages[0].payloads[0];
            assert.strictEqual(after.id, before.id); assert.strictEqual(after.deadline, before.deadline);
            assert.deepStrictEqual(after.target, before.target);
        }
        assert.strictEqual(cover.style.borderRadius, '0');
        assert.strictEqual(cover.style.pointerEvents, 'none');
        assert.strictEqual(page.text.textContent, 'The adjacent caption remains readable.');
        assert.strictEqual(page.canvas.copies.length, 0);
        f.finish();
        assert.strictEqual(cover.parentNode, null);
        assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('masks each admitted fallback rectangle until its cargo is atomically revealed or cancelled', () => {
        const f = fixture(), page = f.page();
        f.api.setVisiblePages([1]); assert.strictEqual(f.api.offer(page), 'started');
        const payloads = f.api.snapshot().pages[0].payloads;
        const covers = page.pageElement.children.filter(node => node.className === 'pdfDocumentRobotArrival');
        assert.strictEqual(covers.length, payloads.length);
        assert.ok(covers.length > 0);
        for (const payload of payloads) {
            const cover = covers.find(node => node.dataset.payload === String(payload.id))!;
            const left = parseFloat(cover.style.left), top = parseFloat(cover.style.top);
            const right = left + parseFloat(cover.style.width), bottom = top + parseFloat(cover.style.height);
            const exact = { left: payload.target.x * page.pageElement.clientWidth, top: payload.target.y * page.pageElement.clientHeight,
                right: (payload.target.x + payload.target.width) * page.pageElement.clientWidth,
                bottom: (payload.target.y + payload.target.height) * page.pageElement.clientHeight };
            assert.ok(left <= exact.left + 1e-9 && exact.left - left < 3 + 1e-9);
            assert.ok(top <= exact.top + 1e-9 && exact.top - top < 3 + 1e-9);
            assert.ok(right >= exact.right - 1e-9 && right - exact.right < 3 + 1e-9);
            assert.ok(bottom >= exact.bottom - 1e-9 && bottom - exact.bottom < 3 + 1e-9);
            assert.strictEqual(cover.style.opacity, '1');
            assert.strictEqual(cover.style.pointerEvents, 'none');
        }
        f.api.revealArrivals();
        assert.strictEqual(f.api.snapshot().activeArrivalCovers + f.api.snapshot().activePayloads, 0);
        assert.ok(covers.every(cover => !cover.parentNode));
        assert.deepStrictEqual([page.canvas.width, page.canvas.height], [4320, 6480]);
        f.finish(); assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('reveals the exact atlas photograph at its actual deposit while leaving native page pixels intact', () => {
        const { f, page } = coarsePhoto();
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
        assert.ok(cover, 'admitted real photo cargo owns a small destination gap');
        assert.strictEqual(cover.dataset.imageId, 'p99-photo');
        assert.strictEqual(cover.style.pointerEvents, 'none');
        assert.strictEqual(cover.attributes.get('aria-hidden'), 'true');
        assert.strictEqual(cover.style.opacity, '1', 'complete cover geometry is opaque before the next gated paint');
        assert.deepStrictEqual([cover.style.left, cover.style.top, cover.style.width, cover.style.height].map(parseFloat),
            [44, 130, 284, 269], 'the exact photo is covered through one source-pixel margin and one physical-pixel guard');
        assert.strictEqual(cover.style.borderRadius, '0');
        assert.strictEqual(f.api.snapshot().activeArrivalCovers, 1);
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].arrivalCovered, true);
        let deposited = false;
        for (let step = 0; step < 120; step++) {
            f.frame();
            const payload = f.api.snapshot().pages[0]?.payloads[0];
            if (payload?.deposited) { deposited = true; break; }
            assert.ok(cover.isConnected, 'travel has not yet revealed the destination photo');
        }
        assert.ok(deposited);
        assert.strictEqual(cover.parentNode, null);
        assert.strictEqual(f.api.snapshot().activeArrivalCovers, 0);
        assert.deepStrictEqual([page.canvas.width, page.canvas.height], [135, 192]);
        assert.strictEqual(page.canvas.copies.length, 0, 'the PDF-owned source is never erased or repainted');
        f.finish();
    });

    it('removes destination gaps on cancellation and never masks a rejected admission', () => {
        for (const ending of ['offscreen', 'hide', 'reduce', 'disable', 'reset', 'replacement', 'dispose']) {
            const { f, page } = coarsePhoto();
            const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
            assert.ok(cover, ending);
            const late = [...f.callbacks.values()];
            if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            else if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'reduce') { f.media.matches = true; f.media.emit('change'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else if (ending === 'replacement') { f.api.retireDocument([page], 'new-edition'); }
            else { f.api[ending](); }
            for (const callback of late) { callback(f.now + 34); }
            assert.strictEqual(cover.parentNode, null, ending);
            assert.strictEqual(f.api.snapshot().activeArrivalCovers, 0, ending);
        }
        const f = fixture({ maxActors: 0 }), page = f.page();
        f.api.setVisiblePages([1]); f.api.offer(page);
        assert.strictEqual(page.pageElement.children.filter(node => node.className === 'pdfDocumentRobotArrival').length, 0,
            'rejected work leaves the underlying page visible');
    });

    it('reveals destination pixels immediately on reader input while preserving the finite actor return', () => {
        const { f, page, delivery } = coarsePhoto();
        const before = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(f.api.snapshot().activeArrivalCovers, 1);
        f.api.revealArrivals();
        assert.strictEqual(f.api.snapshot().activeArrivalCovers, 0);
        assert.strictEqual(f.api.snapshot().activePayloads, 0);
        assert.deepStrictEqual(f.api.snapshot().pages[0].payloads[0].helpers, before.helpers);
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deadline, before.deadline);
        f.api.setVisiblePages([99]); f.frame();
        assert.strictEqual(f.api.offer(delivery), 'skipped');
        assert.strictEqual(f.api.snapshot().activeArrivalCovers, 0, 'a refresh cannot recreate an input-dismissed gap');
        assert.strictEqual(page.canvas.width, 135);
    });

    it('replacement carries bounded old pixels away without retaining old page nodes or spending the new edition history', () => {
        const f = fixture({ maxActors: 1 });
        const old = f.page(99);
        f.api.setVisiblePages([99]); f.api.offer(old); f.finish();
        const previousIds = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle').map(canvas => Number(canvas.dataset.courier));
        f.api.retireDocument([old], 'edition-b');
        const began = f.api.snapshot();
        assert.strictEqual(began.replacement.identity, 'edition-b');
        assert.ok(began.replacement.payloads.length > 0);
        assert.ok(began.activeActors <= began.maxActors && began.cargoBytes <= began.maxCargoBytes);
        const id = began.replacement.payloads[0].id;
        const cargo = f.owned.find(canvas => canvas.dataset.payload === String(id) && canvas.className === 'pdfDocumentRobotCargo')!;
        assert.strictEqual(cargo.copies.length, 1);
        assert.strictEqual(cargo.copies[0][0], old.canvas);
        assert.ok(began.replacement.actors.every((actor: any) => actor.id > Math.max(...previousIds)), 'actor identity remains monotonic across editions');
        old.canvas.width = old.canvas.height = 0; old.pageElement.remove();
        f.frame();
        assert.ok(cargo.width > 0 && cargo.isConnected, 'only the copied fragment is needed after old PDF teardown');
        const fresh = f.page(99);
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer(fresh), 'started', 'same physical page number in the new edition has an independent episode');
        assert.strictEqual(cargo.zeroWrites, 1, 'new ready work preempts the old cargo once when capacity is needed');
        assert.strictEqual(f.api.snapshot().replacement, undefined);
        assert.ok(f.api.snapshot().activeActors <= 1);
        f.finish();
        assert.ok(f.api.snapshot().deliveredFragments > 0);
    });

    it('replacement keeps frozen viewport geometry across deep-page reset and restoration', () => {
        const scenes = [fixture({ seed: 31 }), fixture({ seed: 31 })];
        for (const f of scenes) {
            f.container.scrollTop = 424000;
            const page = f.page(425);
            f.api.retireDocument([page], 'edition-b');
            assert.ok(f.api.snapshot().activeActors > 0, 'the geometry comparison contains actual retiring actors');
            page.pageElement.remove(); page.canvas.width = page.canvas.height = 0;
        }
        const actors = () => scenes.map(f => f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width).map(point));
        const samePositions = (message: string) => {
            const [expected, actual] = actors();
            assert.strictEqual(actual.length, expected.length, message);
            for (let index = 0; index < actual.length; index++) {
                // Large scroll-origin subtraction can leave sub-nanopixel arithmetic residue.
                assert.ok(Math.hypot(actual[index].x - expected[index].x, actual[index].y - expected[index].y) < 1e-8, message);
            }
        };
        scenes[1].container.scrollTop = 0;
        scenes[1].api.setVisiblePages([], { preserveReplacement: true });
        scenes.forEach(f => f.frame());
        samePositions('PDF.js reset cannot pin old cargo to page 425 content coordinates');
        scenes[1].container.scrollTop = 424000;
        scenes.forEach(f => f.frame());
        samePositions('restoring reader position cannot shift the finite outbound scene');
        for (const f of scenes) {
            f.finish();
            assert.strictEqual(f.api.snapshot().replacement, undefined);
            assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
            assert.strictEqual(f.callbacks.size, 0);
        }
    });

    it('removes old fragments along a gentle ground diagonal with the body and cargo still attached', () => {
        const f = fixture({ maxActors: 1, encounterRandom: () => 0.99 }); f.desktop();
        let actor: any, payload: any;
        for (let id = 1; id <= 12; id++) {
            const page = f.page(id); f.api.retireDocument([page], 'edition-' + id);
            const scene = f.api.snapshot().replacement;
            actor = scene?.actors.find((value: any) => value.vehicle !== 'forklift'
                && !module.ROBOT_VEHICLES.find((spec: any) => spec.id === value.vehicle).air);
            if (actor) { payload = scene.payloads.find((value: any) => value.helpers.includes(actor.id)); break; }
            f.finish();
        }
        assert.ok(actor && payload, 'the extraction fixture contains a self-propelled ground carrier');
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id))!;
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.dataset.payload === String(payload.id))!;
        const samples: Array<{ body: { x: number; y: number }; cargo: { x: number; y: number } }> = [];
        while (f.callbacks.size) {
            f.frame();
            const current = f.api.snapshot().replacement?.payloads.find((value: any) => value.id === payload.id);
            if (current?.stage === 'carry') { samples.push({ body: point(sprite), cargo: point(cargo) }); }
        }
        assert.ok(samples.length > 3);
        const first = samples[0], last = samples.at(-1)!;
        assert.ok(Math.abs(last.body.y - first.body.y) > 5, 'the old pixels take a visibly diagonal side exit');
        for (let index = 1; index < samples.length; index++) {
            const a = samples[index - 1], b = samples[index];
            assert.ok(Math.abs(b.body.y - a.body.y) <= Math.abs(b.body.x - a.body.x) * 0.25 + 0.03);
            assert.ok(Math.abs((b.body.x - b.cargo.x) - (first.body.x - first.cargo.x)) < 0.03);
            assert.ok(Math.abs((b.body.y - b.cargo.y) - (first.body.y - first.cargo.y)) < 0.03);
        }
        assert.strictEqual(cargo.zeroWrites, 1);
        assert.strictEqual(f.api.snapshot().replacement, undefined);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('replacement releases every shared bitmap and borrowed actor once on completion or cancellation', () => {
        for (const ending of ['finish', 'offscreen', 'hide', 'reduce', 'disable', 'reset', 'dispose', 'supersede']) {
            const finished: string[] = [];
            const f = fixture({ onReplacementComplete: (identity: string) => finished.push(identity) });
            const held = new Set<string>(); let reserved = 0, released = 0;
            const dock = { x: 600, y: 80, scale: 0.4 };
            f.api.setDispatchOrigin({ reserve(vehicle: string) {
                if (held.has(vehicle)) { return; }
                held.add(vehicle); reserved++; return dock;
            }, destination: () => dock, release(vehicle: string) {
                assert.ok(held.delete(vehicle), 'a borrowed body has only one release owner'); released++;
            } });
            const page = f.page(99);
            f.api.retireDocument([page], 'edition-b');
            assert.ok(reserved > 0);
            const cargo = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width);
            const late = [...f.callbacks.values()];
            if (ending === 'finish') { f.finish(); }
            else if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            else if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'reduce') { f.media.matches = true; f.media.emit('change'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else if (ending === 'supersede') { f.api.retireDocument([page], 'edition-c'); f.api.cancelReplacement('edition-c'); }
            else { f.api[ending](); }
            for (const callback of late) { callback(f.now + 10000); }
            assert.ok(cargo.every(canvas => canvas.zeroWrites === 1), ending + ' releases each copied raster once');
            assert.strictEqual(held.size, 0, ending);
            assert.strictEqual(released, reserved, ending);
            assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0, ending);
            assert.strictEqual(f.callbacks.size + f.timers.size, 0, ending);
            assert.strictEqual(finished.filter(identity => identity === 'edition-b').length, 1, ending + ' reports one terminal transition');
        }
    });

    it('replacement rolls back an unavailable old-pixel copy before borrowing any actor', () => {
        let f: Fixture;
        const finished: string[] = [];
        f = fixture({ onReplacementComplete: (identity: string) => finished.push(identity), createCanvas() {
            const canvas = new Canvas(f.document); canvas.failCopy = true; f.owned.push(canvas); return canvas;
        } });
        let reserves = 0;
        f.api.setDispatchOrigin({ reserve: () => { reserves++; return { x: 500, y: 70, scale: 0.4 }; },
            destination: () => undefined, release: () => {} });
        const page = f.page(99);
        f.api.retireDocument([page], 'edition-b');
        assert.strictEqual(f.api.snapshot().replacement, undefined);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(reserves, 0);
        assert.ok(f.owned.every(canvas => canvas.width === 0 && canvas.zeroWrites === 1));
        assert.deepStrictEqual(finished, ['edition-b']);
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(page.canvas.width, 4320, 'failed effects leave PDF.js pixels untouched');
    });

    it('holds the longest exact Croatian success line after ordinary motion without another animation frame', () => {
        const f = fixture({ seed: 58 }); const page = f.page();
        f.api.setVisiblePages([1]); f.api.offer(page);
        const line = 'ovako fino ne bi ni Marić izbrusio';
        let bubble: Element | undefined;
        for (let step = 0; step < 100 && !bubble; step++) {
            f.frame(); bubble = captions(f).find(node => node.textContent.includes(line));
        }
        assert.ok(bubble, 'the seeded real deposit selects the exact requested long line');
        const began = f.now, writes = bubble.textWrites;
        f.finish();
        assert.strictEqual(f.api.snapshot().activeActors, 0);
        assert.strictEqual(f.callbacks.size, 0);
        assert.ok(bubble.isConnected, 'ordinary actor cleanup leaves only the readable DOM bubble');
        assert.strictEqual(bubble.style.opacity, '1', 'the actor fade does not shorten reading time');
        assert.strictEqual(bubble.textWrites, writes, 'ordinary paints do not replace unchanged caption text');
        assert.strictEqual(f.timers.size, 1, 'one expiry owns the static bubble');
        const frames = f.api.snapshot().frames;
        f.tick(Math.max(0, 2500 - (f.now - began)));
        assert.ok(bubble.isConnected, 'the long line remains readable for at least 2.5 seconds');
        f.tick(1501);
        assert.strictEqual(bubble.isConnected, false);
        assert.strictEqual(f.api.snapshot().frames, frames);
        assert.strictEqual(f.timers.size + f.callbacks.size, 0);
    });

    it('groups a close top-edge exchange into one bounded bubble without repeated text writes', () => {
        const f = fixture(nearMissOptions()); f.desktop();
        const page = f.page(); page.pageElement.rect.top = 32;
        let reserved = 0;
        f.api.setDispatchOrigin({ reserve: () => ({ x: reserved++ ? 80 : 600, y: 50, scale: 1.92 }),
            destination: () => ({ x: 600, y: 50, scale: 1.92 }), release: () => {} });
        f.api.setVisibleWork([work([page])]);
        for (let step = 0; step < 40 && !f.api.snapshot().encounters?.active; step++) { f.frame(); }
        assert.strictEqual(f.api.snapshot().encounters?.active?.kind, 'near-miss');
        assert.strictEqual(f.api.snapshot().encounters.active.ids.length, 2);
        assert.strictEqual(captions(f).length, 1, 'close partners cannot cover one another with opaque bubbles');
        const bubble = captions(f)[0], bounds = f.container.getBoundingClientRect();
        assert.strictEqual(bubble.textContent.split('\n').length, 2, 'each speaker has its own labeled line');
        const width = parseFloat(bubble.style.width), height = parseFloat(bubble.style.height);
        const left = parseFloat(bubble.style.left) + bounds.left;
        const top = parseFloat(bubble.style.top) + bounds.top;
        assert.ok(left >= bounds.left && top >= bounds.top, 'top and left edges remain inside the reader');
        assert.ok(left + width <= bounds.right && top + height <= bounds.bottom, 'right and bottom edges remain inside the reader');
        const writes = bubble.textWrites;
        for (let step = 0; step < 12; step++) { f.frame(); }
        assert.strictEqual(bubble.textWrites, writes, 'cached text remains untouched while gesture poses advance');
        const statuses = sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotWorkStatus' && node.style.opacity === '1');
        assert.strictEqual(statuses.length, 1, 'one work status remains readable alongside the exchange');
        const status = statuses[0], statusRect = status.getBoundingClientRect();
        const statusLeft = parseFloat(status.style.left), statusTop = parseFloat(status.style.top);
        const bubbleLeft = parseFloat(bubble.style.left), bubbleTop = parseFloat(bubble.style.top);
        const overlapWidth = Math.min(statusLeft + statusRect.width, bubbleLeft + width) - Math.max(statusLeft, bubbleLeft);
        const overlapHeight = Math.min(statusTop + statusRect.height, bubbleTop + height) - Math.max(statusTop, bubbleTop);
        assert.ok(Math.max(0, overlapWidth) * Math.max(0, overlapHeight) <= 4, 'solver admission keeps the opaque status out of the grouped speech bubble');
    });

    it('places the measured multiline caption and reuses its dimensions while the exchange moves', () => {
        const f = fixture(nearMissOptions()); f.desktop();
        f.document.captionHeight = 142;
        const page = f.page(); let reserved = 0;
        f.api.setDispatchOrigin({ reserve: () => ({ x: reserved++ ? 80 : 600, y: 220, scale: 1.92 }),
            destination: () => ({ x: 600, y: 220, scale: 1.92 }), release: () => {} });
        f.api.setVisibleWork([work([page])]);
        for (let step = 0; step < 40 && !f.api.snapshot().encounters?.active; step++) { f.frame(); }
        assert.strictEqual(f.api.snapshot().encounters?.active?.kind, 'near-miss');
        const bubble = captions(f)[0];
        assert.ok(bubble);
        assert.strictEqual(parseFloat(bubble.style.height), 142, 'placement uses the actual wrapped DOM height');
        assert.strictEqual(bubble.layoutReads, 1, 'the first geometry pass measures the multiline bubble once');
        const placement = f.api.snapshot().caption.placement;
        assert.strictEqual(placement.height, 142);
        assert.strictEqual(placement.leaders.length, 2, 'each actual speaker has an explicit leader endpoint');
        const leaders = sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotCaptionLeader');
        assert.strictEqual(leaders.length, 2);
        placement.leaders.forEach((line: any, index: number) => {
            assert.strictEqual(parseFloat(leaders[index].style.left), line.from.x);
            assert.strictEqual(parseFloat(leaders[index].style.top), line.from.y);
            assert.ok(Math.abs(parseFloat(leaders[index].style.width) - Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y)) < 1e-6);
            assert.strictEqual(leaders[index].style.pointerEvents, 'none');
        });
        const writes = bubble.textWrites;
        for (let step = 0; step < 12; step++) { f.frame(); }
        assert.strictEqual(bubble.layoutReads, 1, 'unchanged text, width and font do not force layout during motion');
        assert.strictEqual(bubble.textWrites, writes);
        f.api.setVisiblePages([]);
        assert.ok(leaders.every(leader => !leader.isConnected), 'caption cancellation releases every leader with the bubble');
    });

    it('cancels a lingering static caption and its one expiry at every lifecycle boundary', () => {
        const endings: Array<(f: Fixture) => void> = [
            f => f.api.setVisiblePages([]), f => f.api.reset(), f => f.api.setEnabled(false),
            f => { f.document.hidden = true; f.document.emit('visibilitychange'); },
            f => { f.media.matches = true; f.media.emit('change'); }, f => f.api.dispose(),
        ];
        for (const end of endings) {
            const f = fixture({ seed: 58 }); const page = f.page();
            f.api.setVisiblePages([1]); f.api.offer(page); f.finish();
            assert.strictEqual(f.api.snapshot().activeActors, 0);
            assert.strictEqual(captions(f).length, 1, 'each boundary starts with an ordinary-completion caption');
            assert.strictEqual(f.timers.size, 1);
            const late = [...f.timers.values()][0].callback;
            end(f);
            assert.strictEqual(captions(f).length, 0);
            assert.strictEqual(f.timers.size + f.callbacks.size, 0);
            assert.strictEqual(f.api.snapshot().caption, undefined);
            late();
            assert.strictEqual(f.timers.size + f.callbacks.size, 0, 'a canceled expiry cannot wake animation or recreate content');
        }
    });

    it('reacts to a successful real deposit with a readable finite caption and no extra lifetime', () => {
        const f = fixture();
        const page = f.page();
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer(page), 'started');
        let observed = false, visibleDialogue = false;
        const nodes = (node: Element): Element[] => [node, ...node.children.flatMap(nodes)];
        for (let step = 0; step < 115 && f.callbacks.size; step++) {
            f.frame();
            const state = f.api.snapshot();
            if (state.encounters?.active?.kind !== 'success') { continue; }
            observed = true;
            assert.ok(state.deliveredFragments > 0, 'satisfaction follows an actual deposit');
            const captions = nodes(f.container).filter(node => node.className === 'pdfDocumentRobotCaption');
            visibleDialogue ||= captions.some(node => node.style.opacity === '1');
            assert.ok(captions.length > 0 && captions.every(node => node.textContent.length > 0));
            assert.ok(captions.every(node => node.style.pointerEvents === 'none'
                && node.attributes.get('aria-hidden') === 'true' && node.style.whiteSpace === 'pre-line'));
            assert.ok(captions.every(node => node.style.fontSize === '12px' && node.style.lineHeight === '16px'
                && node.style.background === '#f5f7fa' && node.style.color === '#17212b' && ['0', '1'].includes(node.style.opacity)),
                'dialogue stays compact and opaque throughout its hold');
        }
        assert.ok(observed, 'the seeded successful delivery has a finite satisfied reaction');
        assert.ok(visibleDialogue, 'the readable bubble actually appears during the finite successful reaction');
        assert.strictEqual(f.callbacks.size, 0, 'reactions do not extend the existing delivery lifetime');
        assert.strictEqual(f.api.snapshot().activeActors, 0);
        assert.ok(f.timers.size <= 1, 'only a bounded static-caption expiry may remain');
        f.tick(4001);
        assert.strictEqual(nodes(f.container).filter(node => node.className === 'pdfDocumentRobotCaption').length, 0);
        assert.strictEqual(page.canvas.width, 4320, 'the original rendered page remains owned by PDF.js');
    });

    it('uses a real approaching advance pair for a near miss and promotes its reacted pose into unchanged cargo work', () => {
        const f = fixture(nearMissOptions()); f.desktop();
        const page = f.page();
        let reserved = 0, released = 0;
        f.api.setDispatchOrigin({
            reserve: () => ({ x: reserved++ ? 80 : 600, y: 220, scale: 1.92 }),
            destination: () => ({ x: 600, y: 220, scale: 1.92 }),
            release: () => released++,
        });
        f.api.setVisibleWork([work([page])]);
        let state = f.api.snapshot();
        for (let step = 0; step < 40 && !state.encounters?.active; step++) { f.frame(); state = f.api.snapshot(); }
        assert.strictEqual(state.encounters?.active?.kind, 'near-miss', 'actual computed approach geometry admits the seeded encounter');
        assert.ok(state.advance[0].actors.some((actor: any) => actor.reaction === 'drowsy'));
        const ids = state.encounters.active.ids;
        const sprites = f.owned.filter(canvas => ids.includes(Number(canvas.dataset.courier)));
        const redraws = sprites.map(canvas => canvas.transforms.length);
        f.tick(136);
        assert.ok(sprites.some((canvas, index) => canvas.transforms.length > redraws[index]), 'cached artwork redraws a changed finite gesture pose');
        const before = sprites.map(point);
        assert.strictEqual(f.api.offer(page), 'started');
        const promoted = f.api.snapshot().pages[0].actors.filter((actor: any) => ids.includes(actor.id));
        assert.ok(promoted.length > 0, 'a reacting advance actor is actually promoted');
        assert.strictEqual(f.api.snapshot().encounters.active, undefined, 'cargo promotion cancels traffic ownership');
        assert.strictEqual(f.timers.size, 0, 'promotion cancels the old dialogue expiry immediately');
        assert.strictEqual(captions(f).length, 0);
        for (const actor of promoted) {
            const index = sprites.findIndex(canvas => Number(canvas.dataset.courier) === actor.id);
            assert.ok(Math.hypot(point(sprites[index]).x - before[index].x, point(sprites[index]).y - before[index].y) < 1);
            assert.strictEqual(actor.reaction, null);
        }
        f.finish();
        assert.strictEqual(f.api.snapshot().activeActors, 0);
        assert.strictEqual(released, reserved, 'every borrowed actor returns exactly once');
        assert.strictEqual(page.canvas.width, 4320);
    });

    it('clears active dialogue and encounter state at every renderer lifecycle exit', () => {
        const endings: Array<(f: Fixture) => void> = [
            f => f.api.setVisiblePages([]), f => f.api.reset(), f => f.api.setEnabled(false),
            f => { f.document.hidden = true; f.document.emit('visibilitychange'); },
            f => { f.media.matches = true; f.media.emit('change'); }, f => f.api.dispose(),
        ];
        for (const end of endings) {
            const f = fixture(); const page = f.page();
            f.api.setVisiblePages([1]); f.api.offer(page);
            for (let step = 0; step < 90 && !f.api.snapshot().encounters?.active; step++) { f.frame(); }
            assert.ok(f.api.snapshot().encounters?.active, 'each boundary starts with a real active reaction');
            const late = [...f.callbacks.values()];
            end(f);
            const state = f.api.snapshot();
            assert.strictEqual(state.encounters.active, undefined);
            assert.strictEqual(state.encounters.trackedActors, 0);
            assert.strictEqual(state.activeActors, 0);
            assert.strictEqual(f.callbacks.size, 0);
            const allocated = f.owned.length;
            for (const callback of late) { callback(f.now + 100); }
            assert.strictEqual(f.owned.length, allocated, 'a canceled callback cannot allocate captions or sprites');
        }
    });

    it('ends a distracted advance scene at readiness and returns from its actual pose without an added offset', () => {
        const f = fixture(nearMissOptions()); f.desktop();
        const page = f.page(); let reserved = 0;
        f.api.setDispatchOrigin({ reserve: () => ({ x: reserved++ ? 80 : 600, y: 220, scale: 1.92 }),
            destination: () => ({ x: 600, y: 220, scale: 1.92 }), release: () => {} });
        f.api.setVisibleWork([work([page])]);
        for (let step = 0; step < 40 && !f.api.snapshot().encounters?.active; step++) { f.frame(); }
        assert.strictEqual(f.api.snapshot().encounters?.active?.kind, 'near-miss');
        f.tick(136);
        const sprites = f.owned.filter(canvas => canvas.width && canvas.className === 'pdfDocumentRobotVehicle');
        const before = sprites.map(point);
        f.api.setVisibleWork([work([page], ['ready'])]);
        assert.strictEqual(f.api.snapshot().encounters.active, undefined, 'a new return route takes over the last reacted pose');
        sprites.forEach((sprite, index) => assert.ok(Math.hypot(point(sprite).x - before[index].x, point(sprite).y - before[index].y) < 1));
        f.finish();
        assert.strictEqual(f.api.snapshot().activeActors, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

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
        const payloads = f.api.snapshot().pages[0].payloads;
        assert.deepStrictEqual(page.pageElement.children.map(node => node === page.canvas ? 'canvas'
            : node === page.text ? 'text' : node.className + ':' + node.dataset.payload),
            ['canvas', 'text', ...payloads.filter((payload: any) => payload.rasterWidth > 0)
                .map((payload: any) => 'pdfDocumentRobotArrival:' + payload.id)]);
        assert.ok(page.pageElement.children.slice(2).every(node => node.style.pointerEvents === 'none'
            && node.attributes.get('aria-hidden') === 'true'));
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
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival'
            && node.dataset.payload === String(payload.id))!;
        const beforeDeposit = payload.deadline * 0.62 - 0.001;
        const positions: Array<{ robot: { x: number; y: number }; cargo: { x: number; y: number }; stage: string }> = [];
        for (let tick = 0; tick < 100; tick++) {
            // Leave a full paint interval for the exact loaded endpoint sample.
            if (f.now + 68 >= beforeDeposit) { break; }
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
        f.tick(beforeDeposit - f.now);
        assert.ok(cargo.isConnected && cover.isConnected);
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deposited, false);
        const delivered = point(cargo);
        assert.ok(Math.abs(delivered.x - (40 + (lower.x + lower.width / 2) * 400)) < 0.02);
        assert.ok(Math.abs(delivered.y - (60 + (lower.y + lower.height / 2) * 600)) < 0.02);
        f.frame();
        const deposited = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(deposited.deposited, true);
        assert.strictEqual(cargo.parentNode, null); assert.strictEqual(cargo.zeroWrites, 1);
        assert.strictEqual(cover.parentNode, null);
        assert.deepStrictEqual(deposited.helpers, payload.helpers); assert.strictEqual(deposited.deadline, payload.deadline);
        assert.ok(sprite.isConnected, 'the original actor still owns its finite return');
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
        const covers = page.pageElement.children.filter(node => node.className === 'pdfDocumentRobotArrival');
        assert.strictEqual(covers.length, 2);
        assert.ok(covers.every(cover => cover.style.opacity === '1'), 'a delayed second payload never reveals then hides its photograph');
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
        const status = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotWorkStatus')!;
        assert.ok(status.style.fontSize === '12px' && status.style.lineHeight === '16px' && status.style.background === '#f5f7fa'
            && status.style.color === '#17212b' && status.style.opacity === '1');
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

    it('admits one stable measured work status on a static paint and suppresses a clipped label', () => {
        const f = fixture(); f.desktop(); f.media.matches = true;
        const pages = [f.page(99), f.page(100), f.page(101)];
        const groups = [work([pages[0]], ['waiting'], 'a'), work([pages[1]], ['preparing'], 'b'), work([pages[2]], ['waiting'], 'c')];
        f.api.setVisibleWork(groups);
        const statuses = () => sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotWorkStatus');
        const shown = () => statuses().filter(node => node.style.opacity === '1');
        assert.strictEqual(statuses().length, 3);
        assert.strictEqual(shown().length, 1);
        const selected = shown()[0];
        assert.ok(selected.textContent.startsWith('Preparing page 89'), 'active preparation takes priority over ambient waiting statuses');
        assert.strictEqual(selected.layoutReads, 1);
        f.api.setVisibleWork([...groups].reverse());
        assert.strictEqual(shown()[0], selected, 'input order does not cycle the admitted status');
        assert.strictEqual(selected.layoutReads, 1, 'unchanged text metrics are cached');
        f.document.workStatusHeight = 2000;
        f.api.setVisibleWork(groups.map(group => ({ ...group, pages: group.pages.map(page => ({ ...page, label: page.label + ' updated' })) })));
        assert.strictEqual(shown().length, 0, 'a measured rectangle that cannot fit is hidden on the same static paint');
        assert.strictEqual(f.callbacks.size + f.timers.size, 0);
        f.api.setVisiblePages([]);
        assert.strictEqual(statuses().length, 0);
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
        assert.deepStrictEqual(page.pageElement.children.map(node => node === page.canvas ? 'canvas'
            : node === page.text ? 'text' : node.className + ':' + node.dataset.payload),
            ['canvas', 'text', ...began.pages[0].payloads.map((payload: any) => 'pdfDocumentRobotArrival:' + payload.id)],
            'the original canvas/text stay in order and only their owned arrival covers are added');
        assert.ok(page.pageElement.children.slice(2).every(node => node.style.pointerEvents === 'none'
            && node.attributes.get('aria-hidden') === 'true'));
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
        assert.ok(transit.children.every(child => child.className === 'pdfDocumentRobotCaption'), 'only static dialogue may outlive the released bitmaps');
        assert.ok(f.timers.size <= 1);
        f.tick(4001);
        assert.strictEqual(f.api.snapshot().frames, ended.frames, 'caption expiry does not request another paint');
        assert.strictEqual(f.timers.size, 0);
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

    it('recruits an aircraft to carry the L-UGV itself through a steep leg before its final ground drive', () => {
        const { f, page, payload } = cooperative('airlift');
        const episode = f.api.snapshot().pages[0];
        const ground = episode.actors.find((actor: any) => actor.vehicle === 'lugv');
        const air = episode.actors.find((actor: any) => actor.locomotion === 'air');
        assert.ok(ground && air && ground.payloadId === air.payloadId);
        const sprites = [ground, air].map(actor => f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle'
            && canvas.dataset.courier === String(actor.id))!);
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.dataset.payload === String(payload.id))!;
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival'
            && node.dataset.payload === String(payload.id))!;
        const samples: any[] = [];
        const baseline = f.api.snapshot().deliveredFragments;
        let deposited = false;
        for (let step = 0; step < 120; step++) {
            f.frame();
            const state = f.api.snapshot().pages[0]?.payloads.find((item: any) => item.id === payload.id);
            if (!state || state.stage === 'return') { break; }
            if (state.deposited) {
                deposited = true;
                assert.strictEqual(cargo.parentNode, null); assert.strictEqual(cargo.zeroWrites, 1);
                assert.strictEqual(cover.parentNode, null, 'deposit reveals the source and retires its copy together');
                assert.deepStrictEqual(state.helpers, payload.helpers);
                assert.strictEqual(state.deadline, payload.deadline);
                assert.ok(sprites.every(sprite => sprite.isConnected), 'the original helpers remain for their finite return');
                break;
            }
            const route = state.routeState;
            assert.ok(route);
            const positions = sprites.map(point), photo = point(cargo);
            assert.ok(Math.hypot(positions[0].x - route.ground.x, positions[0].y - route.ground.y) < 0.03);
            assert.ok(Math.hypot(positions[1].x - route.air.x, positions[1].y - route.air.y) < 0.03);
            assert.ok(Math.hypot(photo.x - route.cargo.x, photo.y - route.cargo.y) < 0.03);
            samples.push({ ...route, phase: route.phase, ground: positions[0], air: positions[1], cargo: photo });
        }
        assert.strictEqual(deposited, true);
        for (const phase of ['drive', 'recruit', 'rendezvous', 'lift', 'carry', 'set-down', 'final-drive']) {
            assert.ok(samples.some(sample => sample.phase === phase), phase + ' is visible within the original delivery deadline');
        }
        const carried = samples.filter(sample => sample.groundCarried);
        assert.ok(carried.length > 3 && Math.max(...carried.map(sample => sample.ground.y)) - Math.min(...carried.map(sample => sample.ground.y)) > 50);
        const offset = { x: carried[0].air.x - carried[0].ground.x, y: carried[0].air.y - carried[0].ground.y };
        for (const sample of carried) {
            assert.ok(Math.abs(sample.air.x - sample.ground.x - offset.x) < 0.05);
            assert.ok(Math.abs(sample.air.y - sample.ground.y - offset.y) < 0.05, 'the aircraft carries the ground chassis, not a second photo');
        }
        for (let index = 1; index < samples.length; index++) {
            const a = samples[index - 1], b = samples[index];
            if (!a.groundCarried && !b.groundCarried && a.phase === b.phase) {
                assert.ok(Math.abs(b.ground.y - a.ground.y) <= Math.abs(b.ground.x - a.ground.x) * 0.25 + 0.03);
            }
        }
        assert.strictEqual(cargo.copies.filter(args => args.length === 9).length, 1);
        assert.strictEqual(f.api.snapshot().deliveredFragments, baseline + 1);
        f.finish();
        assert.strictEqual(cargo.zeroWrites, 1);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('keeps self-propelled ground deliveries and their returns shallow while aircraft retain aerial paths', () => {
        const f = fixture({ maxActors: 3 }); f.desktop();
        let groundSegments = 0, airSegments = 0;
        const diagonals = { approachUp: 0, approachDown: 0, returnUp: 0, returnDown: 0 };
        for (let id = 1; id <= 10; id++) {
            const page = f.page(id);
            page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
            f.api.setVisiblePages([id]); f.api.offer(page);
            const previous = new Map<number, any>();
            for (let step = 0; step < 130 && f.callbacks.size; step++) {
                f.frame();
                for (const actor of f.api.snapshot().pages[0]?.actors ?? []) {
                    const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(actor.id))!;
                    if (!sprite.style.transform) { continue; }
                    const locomotion = module.ROBOT_VEHICLES.find((spec: any) => spec.id === actor.vehicle).air ? 'air' : 'ground';
                    const payload = f.api.snapshot().pages[0]?.payloads.find((value: any) => value.id === actor.payloadId);
                    const current = { ...actor, point: point(sprite), motion: payload?.motion ?? { x: 0, y: 0 } }, last = previous.get(actor.id);
                    if (last && !actor.carried && !last.carried && actor.departing === last.departing
                        && actor.routePhase === last.routePhase && Number(sprite.style.opacity) > 0.2) {
                        const dx = current.point.x - last.point.x, dy = current.point.y - last.point.y;
                        if (locomotion === 'air') { if (Math.abs(dy) > 1) { airSegments++; } }
                        else {
                            // Encounters and traffic apply a shared horizontal nudge to cargo and
                            // helpers. Check the authored tangent independently of that yielding.
                            const routeDx = dx - (current.motion.x - last.motion.x);
                            const routeDy = dy - (current.motion.y - last.motion.y);
                            assert.ok(Math.abs(routeDy) <= Math.abs(routeDx) * 0.25 + 0.08,
                                actor.vehicle + ' must drive shallowly or be visibly carried: ' + routeDx + ',' + routeDy);
                            if (Math.abs(dx) > 1) { groundSegments++; }
                            if (Math.abs(dx) > 1 && Math.abs(dy) > 0.1) {
                                diagonals[actor.departing ? dy < 0 ? 'returnUp' : 'returnDown'
                                    : dy < 0 ? 'approachUp' : 'approachDown']++;
                            }
                        }
                    }
                    previous.set(actor.id, current);
                }
            }
        }
        assert.ok(groundSegments > 10 && airSegments > 10, 'the regression exercises both distinct locomotion classes');
        assert.ok(Object.values(diagonals).every(count => count > 3),
            'ordinary ground approaches and returns visibly climb and descend: ' + JSON.stringify(diagonals));
    });

    it('keeps a sloped lab handoff continuous from the real dock through deposit and return', () => {
        const f = fixture({ maxActors: 2, encounterRandom: () => 0.99 }); f.desktop();
        const held = new Set<string>();
        const dock = { x: 0, y: 460, scale: 1.92 }, airDock = { x: 900, y: 80, scale: 1.92 };
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!['rover', 'quad'].includes(vehicle) || held.has(vehicle)) { return; }
            held.add(vehicle); return vehicle === 'rover' ? dock : airDock;
        }, destination: (vehicle: string) => vehicle === 'rover' ? dock : airDock,
        release: (vehicle: string) => held.delete(vehicle) });
        let payload: any;
        for (let id = 1; id <= 16; id++) {
            const page = f.page(id);
            page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
            f.api.setVisiblePages([id]);
            f.api.offer({ ...page, imageRegions: [{ id: 'sloped-handoff', x: 0.3, y: 0.32, width: 0.45, height: 0.3 }] });
            payload = f.api.snapshot().pages[0]?.payloads.find((value: any) => value.mode === 'handoff');
            if (payload) { break; } f.finish();
        }
        assert.ok(payload, 'a ground dock at a different height can join a gentle cooperative handoff');
        const actor = f.api.snapshot().pages[0].actors.find((value: any) => value.vehicle === 'rover');
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id))!;
        let previous = point(sprite), handoff: { x: number; y: number } | undefined;
        assert.ok(Math.hypot(previous.x - dock.x, previous.y - dock.y) < 0.03, 'the real borrowed body does not teleport');
        let climbed = false, returned = false, last = previous;
        const delivered = f.api.snapshot().deliveredFragments;
        while (f.callbacks.size) {
            f.frame();
            const current = f.api.snapshot().pages[0]?.payloads.find((value: any) => value.id === payload.id);
            if (!current) { break; }
            const position = point(sprite), dx = position.x - previous.x, dy = position.y - previous.y;
            assert.ok(Math.abs(dy) <= Math.abs(dx) * 0.25 + 0.03, 'one shared crew follows the actual shallow tangent');
            if (current.stage === 'handoff') {
                if (handoff) { assert.deepStrictEqual(position, handoff, 'the ground body waits at the exact handoff'); }
                handoff = position;
            }
            if (current.stage === 'carry' && Math.abs(dy) > 0.1) { climbed = true; }
            if (current.stage === 'return' && Math.abs(dy) > 0.1) { returned = true; }
            previous = position; last = position;
        }
        assert.ok(climbed && returned && handoff, 'both the loaded drive and empty return change height');
        assert.ok(Math.hypot(last.x - dock.x, last.y - dock.y) < 2, 'the finite return reaches the actual lab dock');
        assert.strictEqual(f.api.snapshot().deliveredFragments, delivered + 1);
        assert.strictEqual(held.size, 0);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('returns the aircraft independently when its carried ground partner has a shallow route home', () => {
        const f = fixture({ maxActors: 2 }); f.desktop();
        const held = new Set<string>();
        let groundDock = { x: 100, y: 620, scale: 0.5 };
        const airDock = { x: 980, y: 90, scale: 0.5 };
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!['lugv', 'quad'].includes(vehicle) || held.has(vehicle)) { return; }
            held.add(vehicle); return vehicle === 'lugv' ? groundDock : airDock;
        }, destination: (vehicle: string) => vehicle === 'lugv' ? groundDock : airDock,
        release: (vehicle: string) => held.delete(vehicle) });
        let payload: any;
        for (let id = 1; id <= 16; id++) {
            const page = f.page(id); f.api.setVisiblePages([id]); f.api.offer(page);
            payload = f.api.snapshot().pages[0]?.payloads.find((value: any) => value.mode === 'airlift');
            if (payload) { break; } f.finish();
        }
        assert.ok(payload);
        while (!f.api.snapshot().pages[0].payloads[0].deposited) { f.frame(); }
        const state = f.api.snapshot().pages[0], route = state.payloads[0].routeState;
        groundDock = { x: route.ground.x + 80, y: route.ground.y, scale: 0.5 };
        const air = state.actors.find((actor: any) => actor.vehicle === 'quad');
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(air.id))!;
        const distances: number[] = [];
        while (f.callbacks.size) {
            f.frame(); const current = f.api.snapshot().pages[0]?.payloads[0];
            if (current?.stage !== 'return') { continue; }
            assert.strictEqual(current.routeState.requiresAir, false);
            const currentPoint = point(sprite);
            distances.push(Math.hypot(currentPoint.x - airDock.x, currentPoint.y - airDock.y));
        }
        assert.ok(distances.length > 3);
        assert.ok(distances.at(-1)! < distances[0] * 0.1, 'the aircraft reaches its dock before its lease is released');
        assert.strictEqual(held.size, 0);
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
        assert.deepStrictEqual([...modes].sort(), ['airlift', 'formation', 'handoff', 'solo']);
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
        assert.ok(f.owned.flatMap(canvas => canvas.copies.map((args, index) => ({ args, target: canvas.copyTargets[index] })))
            .filter(copy => copy.args.length === 9).every(copy => copy.target[0] <= module.DOCUMENT_ROBOT_LIMITS.fragmentDimension),
        'over-budget team backing allocations are rejected before copying');
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

        f.window.visualViewport = Object.assign(new Events(), { offsetLeft: 100, offsetTop: 80, width: 500, height: 470 });
        f.frame();
        assert.strictEqual(transit.style.clipPath, undefined, 'visual viewport clipping is supplied by the browser without sampled clip writes');
        f.container.rect.top = 180;
        Object.assign(f.window.visualViewport, { offsetLeft: 130, offsetTop: 160, width: 420, height: 360 });
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
            const scale = 1.92 / Math.sqrt(dpr);
            for (const sprite of sprites) {
                assert.ok(Math.abs(parseFloat(sprite.style.width) - 128 * scale) < 0.02, 'CSS size receives partial DPI compensation exactly once');
                assert.deepStrictEqual([sprite.width, sprite.height], [Math.ceil(128 * scale * dpr), Math.ceil(100 * scale * dpr)]);
                assert.ok(sprite.transforms.some(values => values[0] >= scale * dpr && values[3] >= scale * dpr), 'artwork is redrawn into display-resolution backing');
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
        const narrowDesktop = fixture(); narrowDesktop.desktop(3, 600, 900);
        narrowDesktop.window.navigator = { userAgent: 'Windows NT 10.0', maxTouchPoints: 10 };
        assert.strictEqual(narrowDesktop.api.snapshot().presentation, 'desktop', 'normalized available width controls desktop eligibility');
        assert.strictEqual(narrowDesktop.api.snapshot().maxActors, 6, 'the actor budget still uses actual CSS area');
        assert.ok(Math.abs(narrowDesktop.api.snapshot().spriteScale - 1.4 / Math.sqrt(3)) < 1e-9,
            'the CSS base scale is not normalized a second time');
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
        assert.ok(actors.length >= 2 && actors.length <= module.ROBOT_VEHICLES.length,
            'the compatible airborne and shallow-ground departures share the finite lab fleet');
        assert.strictEqual(new Set(actors.map((actor: any) => actor.vehicle)).size, actors.length);
        assert.strictEqual(lab.snapshot().actors.filter((actor: any) => actor.outside).length, actors.length);
        const sprites = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width);
        assert.ok(sprites.every(sprite => Math.abs(parseFloat(sprite.style.width) - 128 * 86 / 250 / Math.sqrt(2)) < 0.02));
        f.now += 700; f.frame();
        assert.ok(sprites.every(sprite => Math.abs(parseFloat(sprite.style.width) - 128 * 1.92 / Math.sqrt(2)) < 0.02));
        f.finish();
        assert.ok(lab.snapshot().actors.every((actor: any) => !actor.outside));
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
    });

    it('admits each sampled source rectangle once in a useful thin visible page slice', () => {
        for (const visibleHeight of [120, 140, 159]) {
            const f = fixture(); f.desktop();
            const page = f.page();
            page.pageElement.rect = { left: 40, top: f.window.innerHeight - visibleHeight, width: 1000, height: 600 };
            f.api.setVisiblePages([1]);
            assert.strictEqual(f.api.offer(page), 'started');
            const copies = f.owned.flatMap(canvas => canvas.copies.filter(args => args.length === 9 && args[0] === page.canvas));
            assert.ok(copies.length >= 2, 'the useful slice admits more than one distinct cargo');
            const rectangles = copies.map(args => args.slice(1, 5).join(':'));
            assert.strictEqual(new Set(rectangles).size, rectangles.length,
                visibleHeight + ' CSS px slice must not allocate repeated clamped rows');
        }
    });

    it('deduplicates identical photo geometry under different placement IDs while retaining distinct destinations', () => {
        const f = fixture({ maxActors: 6 }); f.desktop();
        const page = f.page();
        page.pageElement.rect = { left: 40, top: 60, width: 1000, height: 1000 };
        const first = { id: 'photo-layer-a', x: 0.2, y: 0.1, width: 0.08, height: 0.08 };
        const other = { id: 'other-placement', x: 0.6, y: 0.1, width: 0.08, height: 0.08 };
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [first, { ...first, id: 'photo-layer-b' }, other] }), 'started');
        const state = f.api.snapshot(), payloads = state.pages[0].payloads;
        assert.strictEqual(payloads.length, 2, 'placement aliases share one cargo allocation');
        assert.deepStrictEqual(payloads.map((payload: any) => payload.target.x).sort(), [first.x, other.x]);
        assert.strictEqual(page.pageElement.children.filter(node => node.className === 'pdfDocumentRobotArrival').length, 2);
        const copies = f.owned.flatMap(canvas => canvas.copies.filter(args => args.length === 9 && args[0] === page.canvas));
        assert.strictEqual(copies.length, 2);
        assert.strictEqual(new Set(copies.map(args => args.slice(1, 5).join(':'))).size, 2);
    });

    it('repeated preview and native publication refines existing cargo without restarting its identity or deadline', () => {
        const { f, delivery, source } = coarsePhoto({ maxActors: 4 });
        f.tick(100);
        const before = f.api.snapshot().pages[0].payloads[0];
        const sharper = { ...source(), kind: 'page' as const };
        assert.strictEqual(f.api.refine(sharper), 1);
        const allocations = f.owned.length, cleaner = f.api.snapshot().cleaner;
        for (const repeated of [delivery, sharper, { ...sharper, kind: 'preview' as const }, sharper]) {
            assert.strictEqual(f.api.offer(repeated), 'skipped');
            assert.strictEqual(f.api.refine(repeated), 0);
        }
        assert.strictEqual(f.owned.length, allocations, 'same or lower quality does not allocate another copy');
        const after = f.api.snapshot().pages[0].payloads[0];
        for (const key of ['id', 'deadline', 'mode', 'imageId']) { assert.strictEqual(after[key], before[key]); }
        assert.deepStrictEqual(after.helpers, before.helpers);
        assert.deepStrictEqual(after.target, before.target);
        assert.strictEqual(after.refinements, 1);
        assert.deepStrictEqual(f.api.snapshot().cleaner, cleaner, 'repeated quality does not restart the finite cleaner');
        f.finish();
        assert.strictEqual(f.api.offer(sharper), 'skipped');
        assert.strictEqual(f.api.refine(source(1080, 1536)), 0);
        assert.strictEqual(f.api.snapshot().episodes, 1);
        assert.strictEqual(f.api.snapshot().activePayloads + f.api.snapshot().retainedBytes, 0);
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
        const payload = f.api.snapshot().pages[0].payloads.find((candidate: any) => candidate.id === first.payloadId);
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival'
            && node.dataset.payload === String(payload.id))!;
        f.tick(100);
        page.pageElement.rect = { left: 75, top: 20, width: 500, height: 650 };
        // Inspect the loaded endpoint immediately before the atomic deposit retires its raster.
        f.tick(payload.deadline * 0.62 - f.now - 0.001);
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.dataset.courier === String(first.id))!;
        assert.ok(cargo.isConnected && cover.isConnected);
        assert.strictEqual(f.api.snapshot().pages[0].payloads.find((candidate: any) => candidate.id === payload.id).deposited, false);
        const match = cargo.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)!;
        assert.ok(Math.abs(Number(match[1]) - (75 + first.target.x * 500)) < 0.02);
        assert.ok(Math.abs(Number(match[2]) - (20 + first.target.y * 650)) < 0.02);
        assert.ok(Math.abs(parseFloat(cargo.style.width) - first.target.width * 500) < 0.02);
        assert.ok(Math.abs(parseFloat(cargo.style.height) - first.target.height * 650) < 0.02);
        f.frame();
        assert.strictEqual(cargo.parentNode, null); assert.strictEqual(cargo.zeroWrites, 1);
        assert.strictEqual(cover.parentNode, null);
        const deposited = f.api.snapshot().pages[0].payloads.find((candidate: any) => candidate.id === payload.id);
        assert.strictEqual(deposited.deposited, true); assert.strictEqual(deposited.deadline, payload.deadline);
        f.finish(); assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
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
        const copiedBodies = canvas.copies.filter(args => args.length > 3).map(args => args[0]);
        assert.strictEqual(new Set(copiedBodies).size, module.ROBOT_VEHICLES.filter((vehicle: any) => vehicle.id !== 'quad' && vehicle.id !== 'ekokomvoz').length,
            'the lab redraw excludes the borrowed body; the sweeper is painted procedurally');
        canvas.rect.left += 50;
        lab.invalidateGeometry();
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
