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
    get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value: string) {
        for (const child of [...this.children]) { child.remove(); }
        this.text = value; this.textWrites++;
    }
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
                    ?? 16 + (this.style.display === 'grid' ? Math.max(...this.children.map(child => child.textContent.split('\n').length))
                        : this.textContent.split('\n').length) * parseFloat(this.style.lineHeight)
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
    set width(value: number) { if (value === 0) { this.beforeRelease?.(); this.zeroWrites++; } this.pixelWidth = value; }
    height = 0;
    readonly copies: any[][] = [];
    readonly copyTargets: number[][] = [];
    readonly contextOptions: any[] = [];
    readonly transforms: number[][] = [];
    failCopy = false;
    noContext = false;
    beforeCopy?: (args: any[]) => void;
    beforeRelease?: () => void;
    readonly context = new Proxy({
        setTransform: (...values: number[]) => this.transforms.push(values),
        measureText: (text: string) => ({ width: text.length * 6 }),
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
    onCanvasCreated?: (canvas: Canvas) => void;
    readonly observers: Array<{ disconnected: boolean; targets: Set<Element>; emit(target: Element, width: number, height: number, safari?: boolean): void }> = [];
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
                targets = new Set<Element>();
                constructor(readonly callback: (entries: any[]) => void) { fixture.observers.push(this); }
                observe(target: Element) { this.targets.add(target); }
                emit(target: Element, width: number, height: number, safari = false) {
                    const size = { inlineSize: width, blockSize: height };
                    this.callback([{ target, borderBoxSize: safari ? size : [size], contentRect: { width: width - 14, height: height - 8 } }]);
                }
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
            createCanvas: () => { const image = new Canvas(this.document); this.owned.push(image); this.onCanvasCreated?.(image); return image; },
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
            await esbuild.build({ ...bundleOptions, entryPoints: [path.join(viewerRoot, 'src/common/motion-lab-choreography.ts')], outfile: path.join(directory, 'choreography.mjs') });
            module = { ...await importModule(path.join(directory, 'document.mjs')), ...await importModule(path.join(directory, 'artwork.mjs')),
                ...await importModule(path.join(directory, 'choreography.mjs')) };
        } finally { await esbuild.stop(); }
    });
    afterEach(() => { for (const fixture of fixtures.splice(0)) { fixture.dispose(); } });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });
    function fixture(options: Record<string, unknown> = {}) {
        const result = new Fixture(module, options);
        fixtures.push(result);
        return result;
    }

    function publication(f: Fixture, page = f.page()) {
        const candidate: any = { document: {}, page: {}, pageNumber: page.pageNumber, appearance: 'plain', attempt: {}, successful: true,
            canvas: page.canvas, revision: 1, coverage: { kind: 'complete-page' },
            projection: { width: page.canvas.width, height: page.canvas.height,
                pageToRaster: [page.canvas.width, 0, 0, page.canvas.height, 0, 0] } };
        const encounter: any = { pageElement: page.pageElement, moving: false, axis: 'y', imageRegionsComplete: true,
            imageRegions: [{ id: 'photo', x: .1, y: .1, width: .4, height: .3, resourceId: 'x5' }],
            pageProjection: { content: { x: 0, y: 0, width: 400, height: 600 }, clip: { x: 0, y: 0, width: 400, height: 600 } } };
        return { page, candidate, encounter };
    }

    it('protects prefetched publication without cargo, retains queued covers across canonical reset, and adopts that cover on entry', () => {
        const f = fixture(); const p = publication(f);
        p.page.pageElement.rect.top = 2000;
        const before = f.owned.length;
        const transaction = f.api.preparePublication(p.candidate, p.encounter);
        const cover = sceneNodes(p.page.pageElement).find(node => node.className === 'pdfDocumentRobotArrival')!;
        assert.ok(cover, 'protection precedes publication');
        const queuedPlan = f.api.snapshot().deliveryPlans[0];
        assert.strictEqual(cover.dataset.deliveryPlan, String(queuedPlan.id));
        assert.strictEqual(cover.dataset.deliveryCrop, String(queuedPlan.crops[0].id));
        assert.strictEqual(cover.dataset.payload, undefined);

        assert.strictEqual(f.owned.length, before, 'queued protection allocates no canvas');
        transaction.commit();
        assert.strictEqual(f.api.snapshot().activeActors, 0);
        cover.remove(); f.api.restoreArrivals(p.page.pageNumber, p.page.pageElement);
        assert.strictEqual(cover.parentNode, p.page.pageElement, 'canonical reset restores the same queued owner');
        p.page.pageElement.rect.top = 60; f.api.setVisiblePages([p.page.pageNumber]);
        f.api.reconcileEncounter(p.candidate.page, p.encounter, p.candidate);
        assert.ok(f.api.snapshot().activeActors > 0);
        assert.strictEqual(sceneNodes(p.page.pageElement).find(node => node.className === 'pdfDocumentRobotArrival'), cover);
        const payload = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(cover.dataset.deliveryPlan, undefined, 'handoff removes plan ownership');
        assert.strictEqual(cover.dataset.deliveryCrop, undefined, 'handoff removes crop ownership');
        assert.strictEqual(cover.dataset.payload, String(payload.id));
        assert.strictEqual(f.api.snapshot().queuedDeliveryCovers, 0);
        const identity = [payload.id, payload.deadline, payload.helpers, payload.target];
        p.page.pageElement.rect.width *= 1.1; p.encounter.pageProjection.content.width *= 1.1;
        p.candidate.revision++;
        f.api.preparePublication(p.candidate, p.encounter).commit();
        const refined = f.api.snapshot().pages[0].payloads[0];
        assert.deepStrictEqual([refined.id, refined.deadline, refined.helpers, refined.target], identity);
        f.finish();
        assert.strictEqual(f.api.snapshot().deliveryPlans[0].crops[0].state, 'delivered');
        assert.strictEqual(cover.parentNode, null);
    });

    function finalPublication(p: ReturnType<typeof publication>) {
        const canvas = new Canvas(p.page.canvas.ownerDocument); canvas.width = 800; canvas.height = 1200;
        return { ...p.candidate, canvas, revision: p.candidate.revision + 1, projection: {
            width: 800, height: 1200, pageToRaster: [800, 0, 0, 1200, 0, 0] },
            coverage: { kind: 'native', intent: {}, discovered: true, untrackedImageOperations: false,
                resources: [{ objectId: 'instance', imageId: 'x5', covered: true, final: true, failed: false }] } };
    }

    function qualityPhoto(options: Record<string, unknown> = {}) {
        const f = fixture({ maxActors: 4, ...options }); f.desktop(); const p = publication(f);
        p.candidate.canvas.width = 135; p.candidate.canvas.height = 192;
        p.candidate.projection = { width: 135, height: 192, pageToRaster: [135, 0, 0, 192, 0, 0] };
        f.api.setVisiblePages([p.page.pageNumber]); f.api.preparePublication(p.candidate, p.encounter).commit();
        let current = p.candidate, revision = 1;
        const publish = (final = true) => {
            const next = finalPublication(p); next.revision = ++revision;
            next.coverage.resources[0].final = final;
            const transaction = f.api.preparePublication(next, p.encounter, current);
            current.canvas.replaceWith(next.canvas); transaction.commit(); current = next; return next;
        };
        return { f, p, publish, current: () => current };
    }

    it('reserves a late source-quality wipe before publication after the delivery has already retired', () => {
        const f = fixture({ maxActors: 4 }); f.desktop(); const p = publication(f);
        p.candidate.canvas.width = 135; p.candidate.canvas.height = 192;
        p.candidate.projection = { width: 135, height: 192, pageToRaster: [135, 0, 0, 192, 0, 0] };
        f.api.setVisiblePages([p.page.pageNumber]); f.api.preparePublication(p.candidate, p.encounter).commit(); f.finish();
        assert.strictEqual(f.api.snapshot().pages.length, 0, 'the original delivery is finished before final pixels arrive');
        const sharp = finalPublication(p), before = f.api.snapshot().cargoBytes;
        const transaction = f.api.preparePublication(sharp, p.encounter, p.candidate);
        const prepared = sceneNodes(f.container).filter(node => node.className.startsWith('pdfDocumentRobotQuality'));
        assert.ok(prepared.some(node => node.className === 'pdfDocumentRobotQualityCoarse' && node.isConnected),
            'coarse pixel ownership is connected before the final native publication');
        assert.strictEqual(f.api.snapshot().qualityReactions.length, 0, 'provisional scenes are not reported as committed');
        transaction.commit(); const began = f.api.snapshot(), scene = began.qualityReactions[0];
        assert.ok(scene && scene.location === 'page'); assert.ok(began.cargoBytes > before);
        assert.strictEqual(began.retainedBytes, began.cargoBytes + began.spriteBytes);
        for (const node of prepared.filter(node => node.dataset.quality)) {
            assert.strictEqual(node.dataset.quality, String(scene.id)); assert.strictEqual(node.dataset.payload, undefined);
            assert.strictEqual(node.dataset.deliveryPlan, undefined); assert.strictEqual(node.dataset.deliveryCrop, undefined);
        }
        f.tick(200); const progressing = f.api.snapshot().qualityReactions[0];
        assert.ok(progressing.phase > 0 && progressing.phase < 1);
        const overlay = prepared.find(node => node.className === 'pdfDocumentRobotQualityCoarse')!;
        assert.ok(overlay.style.clipPath.startsWith('inset(0 0 0 '));
        assert.strictEqual(progressing.sharpKind, 'native-page');
        assert.strictEqual(progressing.sharpBytes + progressing.sharpWidth + progressing.sharpHeight, 0,
            'the wipe reveals actual native pixels rather than a cargo-resolution sharp copy');
        f.finish(); const ended = f.api.snapshot(); assert.strictEqual(ended.qualityReactions.length, 0);
        assert.strictEqual(ended.qualityOutcomes.at(-1).outcome, 'completed');
        assert.strictEqual(ended.activeActors + ended.retainedBytes, 0);
        f.api.preparePublication(sharp, p.encounter, sharp).commit();
        assert.strictEqual(f.api.snapshot().qualityReactions.length, 0, 'a repeated final raster cannot replay the reaction');
    });

    it('aborts provisional quality copies without spending the later successful publication opportunity', () => {
        const f = fixture({ maxActors: 4 }); f.desktop(); const p = publication(f);
        p.candidate.canvas.width = 135; p.candidate.canvas.height = 192;
        p.candidate.projection = { width: 135, height: 192, pageToRaster: [135, 0, 0, 192, 0, 0] };
        f.api.setVisiblePages([p.page.pageNumber]);
        f.api.preparePublication(p.candidate, p.encounter).commit(); f.finish();
        const sharp = finalPublication(p), before = f.api.snapshot();
        f.api.preparePublication(sharp, p.encounter, p.candidate).abort();
        const aborted = f.api.snapshot(); assert.strictEqual(aborted.cargoBytes, before.cargoBytes);
        assert.strictEqual(aborted.spriteBytes, before.spriteBytes); assert.strictEqual(aborted.activeActors, before.activeActors);
        assert.strictEqual(aborted.qualityReactions.length, 0);
        f.api.preparePublication(sharp, p.encounter, p.candidate).commit();
        assert.strictEqual(f.api.snapshot().qualityReactions.length, 1); f.finish();
        assert.strictEqual(f.api.snapshot().qualityOutcomes.at(-1).outcome, 'completed');
    });

    it('continues the same visible quality scene across cargo deposit without changing its delivery deadline', () => {
        const f = fixture({ maxActors: 4 }); f.desktop(); const p = publication(f);
        p.candidate.canvas.width = 135; p.candidate.canvas.height = 192;
        p.candidate.projection = { width: 135, height: 192, pageToRaster: [135, 0, 0, 192, 0, 0] };
        f.api.setVisiblePages([p.page.pageNumber]); f.api.preparePublication(p.candidate, p.encounter).commit();
        const before = f.api.snapshot().pages[0].payloads[0];
        f.tick(before.deadline * 0.55);
        const sharp = finalPublication(p); f.api.preparePublication(sharp, p.encounter, p.candidate).commit();
        const first = f.api.snapshot().qualityReactions[0]; assert.ok(first && first.location === 'cargo');
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deadline, before.deadline);
        f.tick(before.deadline * 0.1);
        const handed = f.api.snapshot().qualityReactions[0]; assert.ok(handed && handed.location === 'page');
        for (const key of ['id', 'actorId', 'sourcePage', 'planId', 'cropId', 'associatedPayloadId', 'deadline', 'startedAt']) {
            assert.strictEqual(handed[key], first[key], key + ' survives the handoff');
        }
        const retired = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(retired.rasterWidth + retired.rasterHeight, 0);
        assert.strictEqual(handed.sharpKind, 'native-page'); assert.strictEqual(handed.sharpBytes, 0);
        const next = f.page(2); f.api.setVisiblePages([p.page.pageNumber, 2]); f.api.offer(next);
        assert.strictEqual(f.api.snapshot().qualityReactions[0].id, first.id, 'ready delivery does not preempt an admitted wipe');
        f.finish(); const end = f.api.snapshot(); assert.strictEqual(end.qualityReactions.length, 0);
        assert.strictEqual(end.qualityOutcomes.find((value: any) => value.id === first.id).outcome, 'completed');
    });

    it('does not reserve quality capacity for offscreen previews and cancels prepared source ownership before late commit', () => {
        const f = fixture({ maxActors: 4 }); f.desktop(); const p = publication(f);
        p.page.pageElement.rect.top = 2000;
        f.api.preparePublication(p.candidate, p.encounter).commit();
        assert.strictEqual(f.api.snapshot().qualityDecisions.pending, 0);
        p.page.pageElement.rect.top = 60; f.api.setVisiblePages([p.page.pageNumber]);
        f.api.reconcileEncounter(p.candidate.page, p.encounter, p.candidate); f.finish();
        const tx = f.api.preparePublication(finalPublication(p), p.encounter, p.candidate);
        f.api.removePage(p.candidate.page, 'removed'); tx.commit(); tx.abort();
        const state = f.api.snapshot(); assert.strictEqual(state.qualityReactions.length, 0);
        assert.strictEqual(state.qualityDecisions.active + state.qualityDecisions.pending, 0);
        assert.strictEqual(state.retainedBytes, 0);
    });

    it('cancels independent quality ownership when cargo loses its cover instead of covering the exposed page', () => {
        const f = fixture({ maxActors: 4 }); f.desktop(); const p = publication(f);
        p.candidate.canvas.width = 135; p.candidate.canvas.height = 192;
        p.candidate.projection = { width: 135, height: 192, pageToRaster: [135, 0, 0, 192, 0, 0] };
        f.api.setVisiblePages([p.page.pageNumber]); f.api.preparePublication(p.candidate, p.encounter).commit(); f.tick(300);
        f.api.preparePublication(finalPublication(p), p.encounter, p.candidate).commit();
        const scene = f.api.snapshot().qualityReactions[0]; assert.ok(scene);
        for (const node of sceneNodes(p.page.pageElement).filter(node => node.className === 'pdfDocumentRobotArrival')) { node.remove(); }
        f.frame(); const state = f.api.snapshot(); assert.strictEqual(state.qualityReactions.length, 0);
        const outcome = state.qualityOutcomes.find((value: any) => value.id === scene.id);
        assert.strictEqual(outcome.outcome, 'cancelled'); assert.strictEqual(outcome.reason, 'cargo-cancelled');
        assert.ok(!sceneNodes(f.container).some(node => node.className === 'pdfDocumentRobotQualityCoarse' && node.isConnected));
    });

    it('aligns the page quality overlay with the bordered and panned content origin', () => {
        const f = fixture({ maxActors: 4 }); f.desktop(); const p = publication(f);
        p.candidate.canvas.width = 135; p.candidate.canvas.height = 192;
        p.candidate.projection = { width: 135, height: 192, pageToRaster: [135, 0, 0, 192, 0, 0] };
        Object.assign(p.page.pageElement, { clientLeft: 5, clientTop: 7 });
        p.encounter.pageProjection.content.x = 12; p.encounter.pageProjection.content.y = -9;
        f.api.setVisiblePages([p.page.pageNumber]); f.api.preparePublication(p.candidate, p.encounter).commit(); f.finish();
        f.api.preparePublication(finalPublication(p), p.encounter, p.candidate).commit();
        const scene = f.api.snapshot().qualityReactions[0]; assert.ok(scene);
        const coarse = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotQualityCoarse')!;
        const x = 40 + 5 + 12 + scene.target.x * 400;
        const y = 60 + 7 - 9 + scene.target.y * 600 - f.container.rect.top;
        assert.ok(coarse.style.transform.startsWith('translate(' + x + 'px,' + y + 'px)'), coarse.style.transform);
        assert.strictEqual(scene.sharpKind, 'native-page');
        assert.ok(!sceneNodes(f.container).some(node => node.className === 'pdfDocumentRobotQualitySharp' && node.isConnected));
        f.finish();
    });

    it('keeps useful single-slot delivery and records a direct-sharp reason when its cleaner cannot fit', () => {
        const { f, publish } = qualityPhoto({ maxActors: 1 });
        assert.strictEqual(f.api.snapshot().activeActors, 1); f.tick(300); publish();
        assert.strictEqual(f.api.snapshot().qualityReactions.length, 0);
        assert.strictEqual(f.api.snapshot().qualityDecisions.lastDecision.reason, 'actor-limit');
        f.finish(); assert.strictEqual(f.api.snapshot().deliveredFragments, 1);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
    });

    it('does not replace a displayed high-resolution coarse crop with a cargo-sized page overlay', () => {
        const f = fixture({ maxActors: 4 }); f.desktop(); const p = publication(f);
        f.api.setVisiblePages([p.page.pageNumber]); f.api.preparePublication(p.candidate, p.encounter).commit(); f.finish();
        const next = finalPublication(p); f.api.preparePublication(next, p.encounter, p.candidate).commit();
        assert.strictEqual(f.api.snapshot().qualityReactions.length, 0);
        assert.strictEqual(f.api.snapshot().qualityDecisions.lastDecision.reason, 'cargo-limit');
        assert.ok(!sceneNodes(f.container).some(node => node.className === 'pdfDocumentRobotQualityCoarse'));
    });

    it('preserves the complete banked cargo pose on its independent coarse/sharp/ASAP layers', () => {
        const { f, publish } = qualityPhoto(); const before = f.api.snapshot().pages[0].payloads[0];
        f.tick(before.deadline * 0.3); publish(); f.frame();
        const scene = f.api.snapshot().qualityReactions[0]; assert.ok(scene && scene.location === 'cargo');
        const layers = f.owned.filter(canvas => canvas.dataset.quality === String(scene.id));
        const coarse = layers.find(canvas => canvas.className === 'pdfDocumentRobotQualityCoarse')!;
        const sharp = layers.find(canvas => canvas.className === 'pdfDocumentRobotQualitySharp')!;
        const actor = layers.find(canvas => canvas.className === 'pdfDocumentRobotQualityCleaner')!;
        assert.strictEqual(coarse.style.transform, sharp.style.transform);
        const angle = (canvas: Canvas) => Number(canvas.style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1] ?? 0);
        assert.ok(Math.abs(angle(coarse)) > 0.1, 'the actual aerial route is banked');
        assert.strictEqual(angle(actor), angle(coarse), 'ASAP follows the same rotated picture');
        f.finish(); assert.strictEqual(f.api.snapshot().retainedBytes, 0);
    });

    it('reveals the actual final native page through the coarse mask without allocating a sharp page copy', () => {
        const { f, publish, current, p } = qualityPhoto(); f.finish();
        const previous = current(), next = publish();
        assert.strictEqual(previous.canvas.isConnected, false); assert.strictEqual(next.canvas.isConnected, true);
        const scene = f.api.snapshot().qualityReactions[0]; assert.ok(scene && scene.sharpKind === 'native-page');
        const coarse = f.owned.find(canvas => canvas.dataset.quality === String(scene.id)
            && canvas.className === 'pdfDocumentRobotQualityCoarse')!;
        assert.strictEqual(coarse.copies[0][0], previous.canvas, 'the covered pixels come from the real preceding raster');
        f.tick(300); assert.ok(coarse.style.clipPath.startsWith('inset(0 0 0 50.000%'));
        assert.ok(p.page.pageElement.children.includes(next.canvas));
        assert.ok(!sceneNodes(f.container).some(node => node.className === 'pdfDocumentRobotQualitySharp' && node.isConnected));
        f.finish(); assert.strictEqual(next.canvas.isConnected, true);
    });

    it('reserves feasible quality capacity during ordinary multi-photo work and finishes the admitted wipe', () => {
        const f = fixture({ maxActors: 4, device: 'mobile', encounterRandom: () => 0.99 }); const p = publication(f);
        p.candidate.canvas.width = 135; p.candidate.canvas.height = 192;
        p.candidate.projection = { width: 135, height: 192, pageToRaster: [135, 0, 0, 192, 0, 0] };
        p.encounter.imageRegions = [0, 1, 2].map(index => ({ id: 'photo' + index, resourceId: 'x' + (5 + index),
            x: .1, y: .08 + index * .3, width: .7, height: .16 }));
        f.api.setVisiblePages([p.page.pageNumber]); f.api.preparePublication(p.candidate, p.encounter).commit();
        assert.ok(f.api.snapshot().activeActors > 0 && f.api.snapshot().activeActors < 4,
            'useful deliveries coexist with one feasible reserved quality slot');
        f.tick(500); const next = finalPublication(p);
        next.coverage.resources = [0, 1, 2].map(index => ({ objectId: 'object' + index, imageId: 'x' + (5 + index),
            covered: true, final: true, failed: false }));
        const transaction = f.api.preparePublication(next, p.encounter, p.candidate);
        p.candidate.canvas.replaceWith(next.canvas); transaction.commit();
        const began = f.api.snapshot(); assert.strictEqual(began.qualityReactions.length, 1);
        assert.ok(began.activeActors <= 4); const id = began.qualityReactions[0].id;
        f.finish(); assert.strictEqual(f.api.snapshot().qualityOutcomes.find((value: any) => value.id === id).outcome, 'completed');
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
    });

    it('does not admit a late first visible wipe beyond its immutable deadline', () => {
        let visibility = 0;
        const { f, publish } = qualityPhoto({ createTraffic: () => ({ update: (_at: number, groups: Array<{ id: number }>) =>
            new Map(groups.map(group => [group.id, { x: 0, y: 0, visibility }])), reset() {} }) });
        f.tick(300); publish(); const scene = f.api.snapshot().qualityReactions[0];
        assert.ok(scene && scene.startedAt === undefined);
        visibility = 1; f.now = scene.deadline - module.DOCUMENT_ROBOT_LIMITS.cleaner.durationMs + 1; f.frame();
        const state = f.api.snapshot(); assert.strictEqual(state.qualityReactions.length, 0);
        const outcome = state.qualityOutcomes.find((value: any) => value.id === scene.id);
        assert.strictEqual(outcome.outcome, 'cancelled'); assert.strictEqual(outcome.reason, 'visible-admission-expired');
        f.finish(); assert.strictEqual(f.api.snapshot().retainedBytes, 0);
    });

    it('recognizes a real final source upgrade when both rasters exceed the cargo backing cap', () => {
        const { f, publish, current, p } = qualityPhoto(); f.finish(); publish(); f.finish();
        const previous = current(), canvas = new Canvas(f.document); canvas.width = 1600; canvas.height = 2400;
        const next = { ...previous, canvas, revision: previous.revision + 1,
            projection: { width: 1600, height: 2400, pageToRaster: [1600, 0, 0, 2400, 0, 0] } };
        const tx = f.api.preparePublication(next, p.encounter, previous); previous.canvas.replaceWith(canvas); tx.commit();
        const scene = f.api.snapshot().qualityReactions[0]; assert.ok(scene);
        assert.ok(scene.coarseWidth > module.DOCUMENT_ROBOT_LIMITS.desktop.fragmentDimension);
        assert.strictEqual(scene.sharpKind, 'native-page'); f.finish();
        assert.strictEqual(f.api.snapshot().qualityDecisions.completed, 2);
    });

    it('keeps a settled quality reservation closed across stale partial reconciliation', () => {
        const { f, p, publish } = qualityPhoto();
        assert.ok(f.api.snapshot().qualityDecisions.pending > 0);
        f.api.updateSource(p.candidate.page, { kind: 'native', intent: {}, discovered: true,
            resources: [{ objectId: 'failed', imageId: 'x5', covered: false, final: true, failed: true }] });
        assert.strictEqual(f.api.snapshot().qualityDecisions.pending, 0);
        f.api.reconcileEncounter(p.candidate.page, p.encounter, p.candidate);
        assert.strictEqual(f.api.snapshot().qualityDecisions.pending, 0);
        publish(false); assert.ok(f.api.snapshot().qualityDecisions.pending > 0);
        f.finish(); assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0,
            'partial metadata alone cannot keep an idle animation loop running');
    });

    it('rolls back publication covers and treats an unexpectedly lost queued cover as terminal exposure', () => {
        const f = fixture(); const p = publication(f); p.page.pageElement.rect.top = 2000;
        f.api.preparePublication(p.candidate, p.encounter).abort();
        assert.ok(!sceneNodes(p.page.pageElement).some(node => node.className === 'pdfDocumentRobotArrival'));
        f.api.preparePublication(p.candidate, p.encounter).commit();
        const cover = sceneNodes(p.page.pageElement).find(node => node.className === 'pdfDocumentRobotArrival')!;
        cover.remove(); p.page.pageElement.rect.top = 60;
        f.api.reconcileEncounter(p.candidate.page, p.encounter, p.candidate);
        assert.strictEqual(f.api.snapshot().deliveryPlans[0].crops[0].state, 'cancelled');
        f.api.preparePublication(p.candidate, p.encounter).commit();
        assert.ok(!sceneNodes(p.page.pageElement).some(node => node.className === 'pdfDocumentRobotArrival'));
        assert.strictEqual(f.api.snapshot().activeActors, 0);
    });

    it('never adds a late cover after incomplete unknown-image publication and reveals capacity failures immediately', () => {
        const f = fixture(); const p = publication(f);
        p.encounter.imageRegions = undefined; p.encounter.imageRegionsComplete = false;
        p.candidate.coverage = { kind: 'native', intent: {}, discovered: false, resources: [] };
        f.api.preparePublication(p.candidate, p.encounter).commit();
        p.encounter.imageRegions = [{ id: 'photo', x: .1, y: .1, width: .4, height: .3, resourceId: 'x5' }];
        p.encounter.imageRegionsComplete = true; p.candidate.coverage = { kind: 'complete-page' };
        f.api.preparePublication(p.candidate, p.encounter).commit();
        assert.ok(!sceneNodes(p.page.pageElement).some(node => node.className === 'pdfDocumentRobotArrival'));
        const g = fixture({ maxActors: 0 }); const q = publication(g);
        g.api.preparePublication(q.candidate, q.encounter).commit();
        assert.strictEqual(g.api.snapshot().deliveryPlans[0].crops[0].state, 'skipped');
        assert.ok(!sceneNodes(q.page.pageElement).some(node => node.className === 'pdfDocumentRobotArrival'));
    });

    it('restores coarse-raster protection geometry when a sharper publication aborts', () => {
        const f = fixture(); const p = publication(f); p.page.pageElement.rect.top = 2000;
        p.page.canvas.width = 192; p.page.canvas.height = 288;
        p.candidate.projection = { width: 192, height: 288, pageToRaster: [192, 0, 0, 288, 0, 0] };
        f.api.preparePublication(p.candidate, p.encounter).commit();
        const cover = sceneNodes(p.page.pageElement).find(node => node.className === 'pdfDocumentRobotArrival')!;
        const before = [cover.style.left, cover.style.top, cover.style.width, cover.style.height];
        const sharper = f.page(88).canvas;
        const candidate = { ...p.candidate, canvas: sharper, projection: { width: sharper.width, height: sharper.height,
            pageToRaster: [sharper.width, 0, 0, sharper.height, 0, 0] } };
        f.api.preparePublication(candidate, p.encounter).abort();
        assert.deepStrictEqual([cover.style.left, cover.style.top, cover.style.width, cover.style.height], before,
            'aborted publication preserves the preceding raster guard fringe');
    });

    it('keeps an active payload when compatible publication replaces its DOM page element', () => {
        const f = fixture(); const p = publication(f); f.api.setVisiblePages([p.page.pageNumber]);
        f.api.preparePublication(p.candidate, p.encounter).commit();
        const payload = f.api.snapshot().pages[0].payloads[0];
        const replacement = f.page(89); const encounter = { ...p.encounter, pageElement: replacement.pageElement };
        const transaction = f.api.preparePublication(p.candidate, encounter);
        p.page.pageElement.remove(); transaction.commit(); f.frame();
        const after = f.api.snapshot().pages[0]?.payloads[0];
        assert.ok(after, 'the current episode follows the committed DOM owner');
        assert.strictEqual(after.id, payload.id); assert.strictEqual(after.deadline, payload.deadline);
        assert.ok(f.api.snapshot().activeActors > 0);
        assert.strictEqual(f.api.snapshot().deliveryPlans[0].crops[0].state, 'active');
    });

    it('releases advance-only appearance ownership without resetting unrelated document history', () => {
        const f = fixture(); f.desktop(); const page = f.page();
        f.api.setVisibleWork([work([page])]); f.finish();
        assert.ok(f.api.snapshot().advance.length > 0);
        const generation = f.api.snapshot().operationDecisionRecords;
        f.api.removePage({}, 'appearance', false, page.pageElement);
        assert.strictEqual(f.api.snapshot().advance.length, 0);
        assert.strictEqual(f.api.snapshot().activeActors, 0);
        assert.strictEqual(f.api.snapshot().operationDecisionRecords, generation);
        f.api.removePage({}, 'appearance', false, page.pageElement);
        assert.strictEqual(f.api.snapshot().advance.length, 0);
    });

    it('retains committed bounded selection when unselected photos were exposed before detached eviction', () => {
        const f = fixture(); const p = publication(f); p.page.pageElement.rect.top = 2000;
        p.encounter.imageRegions = Array.from({ length: 20 }, (_, index) => ({ id: 'photo' + index,
            resourceId: 'x' + (index + 1), x: index % 2 ? .55 : .05, y: Math.floor(index / 2) * .095 + .01,
            width: .35, height: .06 }));
        f.api.preparePublication(p.candidate, p.encounter).commit();
        const original = f.api.snapshot().deliveryPlans[0];
        assert.ok(original.crops.length > 0 && original.crops.length < 20, 'representative selection remains bounded');
        const selected = original.crops.map((crop: any) => crop.geometry.imageId);
        p.page.pageElement.remove(); f.api.removePage(p.candidate.page, 'eviction', true);
        f.container.append(p.page.pageElement); p.page.pageElement.rect.top = -420;
        f.api.setVisiblePages([p.page.pageNumber]);
        f.api.preparePublication(p.candidate, p.encounter).commit();
        const after = f.api.snapshot().deliveryPlans[0];
        assert.strictEqual(after.id, original.id, 'connected publication keeps its committed selection history');
        assert.deepStrictEqual(after.crops.map((crop: any) => crop.geometry.imageId), selected);
        assert.ok(after.crops.every((crop: any) => crop.state === 'cancelled'));
        assert.ok(!sceneNodes(p.page.pageElement).some(node => node.className === 'pdfDocumentRobotArrival'),
            'a lower clip cannot add covers to previously unselected exposed photographs');
        assert.strictEqual(f.api.snapshot().activeActors, 0);
    });

    function cooperative(mode?: string, helpers = 2, useLab = false, options: Record<string, unknown> = {}, coarse = false) {
        const f = fixture({ maxActors: helpers, ...options });
        f.desktop();
        if (mode === 'airlift') {
            f.desktop(1, 1280, 1100);
            const held = new Set<string>(); let preparing = true;
            let groundDock = { x: 1100, y: 400, scale: 0.7 };
            const airDock = { x: 950, y: 80, scale: 0.7 }, dock = (vehicle: string) => vehicle === 'lugv' ? groundDock : airDock;
            f.api.setDispatchOrigin({ reserve(vehicle: string) {
                if (held.has(vehicle) || vehicle !== 'lugv' && (vehicle !== 'heavyquad' || preparing)) { return; }
                held.add(vehicle); return dock(vehicle);
            }, destination: dock, release(vehicle: string) { assert.ok(held.delete(vehicle)); } });
            const page = f.page(); page.pageElement.rect = { left: 40, top: 60, width: 640, height: 900 };
            if (coarse) { page.canvas.width = 135; page.canvas.height = 192; }
            f.api.setVisibleWork([work([page])]); f.finish();
            const staged = f.api.snapshot().advance[0].actors[0];
            assert.strictEqual(staged.vehicle, 'lugv');
            const at = point(f.owned.find(canvas => canvas.dataset.courier === String(staged.id))!);
            const bodyScale = staged.spriteScale / module.DOCUMENT_ROBOT_LIMITS.spriteScale;
            const center = { x: at.x + 29 * bodyScale, y: at.y + 180 - 25 * bodyScale };
            preparing = false;
            assert.strictEqual(f.api.offer({ ...page, imageRegions: [{ id: 'actual-steep-body-transport',
                x: (center.x - 40 - 100) / 640, y: (center.y - 60 - 80) / 900, width: 200 / 640, height: 160 / 900 }] }), 'started');
            const payload = f.api.snapshot().pages[0].payloads[0];
            assert.strictEqual(payload.mode, 'airlift', 'an actual staged body receives transport for its measured steep route');
            assert.ok(payload.helpers.includes(staged.id));
            return { f, page, payload, held, airDock, setGroundDock: (point: typeof groundDock) => { groundDock = point; } };
        }
        if (useLab) { f.api.setDispatchOrigin(f.openLab().lab.dispatch); }
        else if (mode === 'handoff') {
            const held = new Set<string>();
            const dock = (vehicle: string) => vehicle === 'heavyquad' ? { x: 900, y: 80, scale: 0.5 } : { x: 0, y: 460, scale: 0.5 };
            f.api.setDispatchOrigin({ reserve(vehicle: string) {
                if (!['heavyquad', 'hexapod'].includes(vehicle) || held.has(vehicle)) { return; }
                held.add(vehicle); return dock(vehicle);
            }, destination: dock, release(vehicle: string) { assert.ok(held.delete(vehicle)); } });
        }
        for (let id = 1; id <= 12; id++) {
            const page = f.page(id);
            if (coarse) { page.canvas.width = 135; page.canvas.height = 192; }
            page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
            f.api.setVisiblePages([id]);
            f.api.offer({ ...page, imageRegions: [
                { id: 'qualified-team-photo', x: 0.1, y: 0.2, width: (helpers === 3 ? 320 : 240) / 465,
                    height: (helpers === 3 ? 300 : 270) / 661 },
            ] });
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
    const exclusiveRegions = (payloads: any[], context: string) => {
        for (let first = 0; first < payloads.length; first++) {
            for (const second of payloads.slice(first + 1)) {
                const a = payloads[first].target, b = second.target;
                const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
                const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                assert.ok(width <= 1e-12 || height <= 1e-12,
                    context + ' has two owners: ' + JSON.stringify([a, b]));
            }
        }
    };
    function textStripFixture(options: Record<string, unknown> = {}): Fixture {
        let f: Fixture;
        f = fixture({ ...options, createCanvas: () => {
            const canvas = new Canvas(f.document); f.owned.push(canvas);
            canvas.context.getImageData = (_x: number, _y: number, width: number, height: number) => {
                const data = new Uint8ClampedArray(width * height * 4).fill(255);
                for (let y = 2; y < height; y++) {
                    if (y % 5 >= 3) { continue; }
                    for (let x = 2; x < width; x++) {
                        const at = (y * width + x) * 4, ink = x < width / 3 ? 0 : 180;
                        data[at] = data[at + 1] = data[at + 2] = ink;
                    }
                }
                return { data };
            };
            return canvas;
        } });
        return f;
    }
    const nearMissOptions = () => {
        const draws = [0.99, 0.1, 0.5, 0];
        return { seed: 16, encounterRandom: () => draws.shift() ?? 0.99 };
    };
    const successOptions = () => ({ seed: 58, maxActors: 1, encounterRandom: () => 0.15 });

    function coarsePhoto(options: Record<string, unknown> = {}, pageSize = { width: 465, height: 661 }) {
        const f = fixture({ maxActors: 2, seed: options.maxActors === 1 ? 10 : 13, ...options }); f.desktop();
        const page = f.page(99); page.canvas.width = 135; page.canvas.height = 192;
        page.pageElement.rect = { left: 40, top: 60, ...pageSize };
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

    function morusCrew(crew = 1, dpr = 1, compact = false, spare = 0) {
        const f = fixture({ seed: crew === 3 ? 2 : 1, maxActors: crew + spare, device: compact ? 'mobile' : 'desktop', encounterRandom: () => 0.99 });
        f.desktop(dpr, 1600, 2200);
        const leased = new Set<string>(), released: string[] = [];
        const vehicles = ['heavyquad', 'quad', 'tiltwing'].slice(0, crew);
        const origin = (vehicle: string) => ({ x: 250 + vehicles.indexOf(vehicle) * 100, y: 160,
            scale: vehicle === 'heavyquad' ? 0.625 : 0.25 });
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!vehicles.includes(vehicle) || leased.has(vehicle)) { return; }
            leased.add(vehicle); return origin(vehicle);
        }, destination: origin, release(vehicle: string) { assert.ok(leased.delete(vehicle)); released.push(vehicle); } });
        const page = f.page(99), width = crew === 1 ? 640 : 1280, height = crew === 1 ? 900 : 1800;
        page.pageElement.rect = { left: 40, top: 60, width, height };
        page.canvas.width = 135; page.canvas.height = 192;
        const cropWidth = crew === 1 ? 80 : crew === 2 ? 280 : 320, cropHeight = crew === 1 ? 80 : crew === 2 ? 200 : 300;
        const delivery = { ...page, kind: 'preview', imageRegions: [
            { id: 'morus-load', x: 0.35, y: 0.25, width: cropWidth / width, height: cropHeight / height },
        ] };
        f.api.setVisiblePages([99]);
        return { f, page, delivery, leased, released };
    }

    it('keeps MORUS document size and its ordinary character cue under the same finite cargo owner', () => {
        const { f, delivery, leased } = morusCrew();
        assert.strictEqual(f.api.offer(delivery), 'started');
        f.tick(600);
        const before = f.api.snapshot().pages[0].payloads[0];
        const actor = f.api.snapshot().pages[0].actors[0];
        assert.strictEqual(actor.vehicle, 'heavyquad');
        assert.ok(Math.abs(actor.spriteScale - 1.92 * 2.5) < 1e-10, 'document scale includes the authored MORUS factor once');
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id))!;
        assert.ok(Math.abs(parseFloat(sprite.style.width) - 128 * actor.spriteScale) < 0.02);
        pointer(f, 'pointermove', point(sprite)); f.frame();
        assert.strictEqual(f.api.snapshot().interaction.hovered, actor.id);
        assert.match(f.api.snapshot().caption?.text ?? '', /benzinska motora/i);
        const after = f.api.snapshot().pages[0].payloads[0];
        for (const key of ['id', 'helpers', 'target', 'deadline']) { assert.deepStrictEqual(after[key], before[key]); }
        assert.deepStrictEqual(after.operation.decision, before.operation.decision);
        f.tick(before.deadline - f.now + 4000);
        assert.strictEqual(leased.size, 0);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('funds the complete enlarged MORUS crew at compact DPR1 and DPR3 without changing logical jobs', () => {
        for (const dpr of [1, 3]) {
            for (const crew of [2, 3]) {
                const { f, delivery, leased } = morusCrew(crew, dpr, true);
                assert.strictEqual(f.api.offer(delivery), 'started');
                const state = f.api.snapshot(), before = state.pages[0].payloads[0];
                assert.strictEqual(before.helpers.length, crew, 'complete qualified crew survives bounded raster adaptation at ' + dpr + '/' + crew);
                assert.strictEqual(leased.size, crew);
                assert.strictEqual(state.maxSpriteBytes, 204800);
                assert.ok(state.spriteBytes <= state.maxSpriteBytes);
                for (const actor of state.pages[0].actors) {
                    const factor = actor.vehicle === 'heavyquad' ? 2.5 : 1;
                    const scale = 0.64 * 1.35 / Math.sqrt(dpr) * factor;
                    assert.ok(Math.abs(actor.spriteScale - scale) < 1e-10, 'only backing density adapts');
                    assert.ok(actor.spriteDensity > 0 && actor.spriteDensity <= dpr);
                    const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id))!;
                    const minimum = Math.min(1, Math.max(scale, actor.vehicle === 'heavyquad' ? 0.625 : 0.25) * dpr);
                    assert.ok(sprite.width >= Math.ceil(128 * minimum) && sprite.height >= Math.ceil(100 * minimum));
                }
                const widths = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle').map(canvas => [canvas.width, canvas.height]);
                f.tick(200);
                const sharper = new Canvas(f.document); sharper.width = 541; sharper.height = 768;
                assert.ok(f.api.refine({ ...delivery, canvas: sharper }) > 0);
                const after = f.api.snapshot().pages[0].payloads[0];
                for (const key of ['id', 'helpers', 'target', 'deadline']) { assert.deepStrictEqual(after[key], before[key]); }
                assert.deepStrictEqual(after.operation.decision, before.operation.decision);
                assert.deepStrictEqual(f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle').map(canvas => [canvas.width, canvas.height]), widths,
                    'ordinary frames and pixel refinement retain the admitted backing plan');
                f.tick(before.deadline - f.now + 4000);
                assert.strictEqual(leased.size, 0);
                assert.strictEqual(f.api.snapshot().retainedBytes, 0);
                assert.strictEqual(f.callbacks.size, 0);
            }
        }
    });

    it('returns the complete enlarged crew after a failed cargo copy and preserves its canonical retry', () => {
        const { f, delivery, leased, released } = morusCrew(2, 3, true);
        let fail = true;
        f.onCanvasCreated = canvas => { canvas.beforeCopy = args => { if (fail && args.length === 9) { throw new Error('bounded failed copy'); } }; };
        assert.strictEqual(f.api.offer(delivery), 'deferred');
        const rejected = f.api.snapshot();
        assert.ok(released.includes('heavyquad') && released.includes('quad'), 'the joint reservation included both actual members');
        assert.strictEqual(leased.size + rejected.retainedBytes + rejected.activeActors + f.callbacks.size, 0);
        assert.ok(f.owned.every(canvas => canvas.width === 0 && canvas.height === 0));
        fail = false;
        assert.strictEqual(f.api.offer(delivery), 'started');
        const accepted = f.api.snapshot().pages[0].payloads[0];
        assert.deepStrictEqual(accepted.operation.decision, rejected.lastOperationDecision.decision);
        f.tick(accepted.deadline - f.now + 4000);
        assert.strictEqual(leased.size + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    it('banks an all-air crop and its actual attachment offsets together, then levels before deposit', () => {
        const angle = (canvas: Canvas) => Number(canvas.style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1] ?? 0);
        for (const crew of [1, 2]) {
            const { f, delivery, leased } = morusCrew(crew, 1, false, 1);
            assert.strictEqual(f.api.offer(delivery), 'started');
            const before = f.api.snapshot().pages[0].payloads[0];
            assert.strictEqual(before.helpers.length, crew);
            const clock = before.operation.timing;
            f.tick(clock.startedAt + (clock.workEnd - clock.startedAt) * 0.6 - f.now);
            let cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
            const bank = angle(cargo);
            assert.ok(Math.abs(bank) > 1 && Math.abs(bank) <= 4, 'the actual aerial crop has a modest flight bank');
            const radians = bank * Math.PI / 180, center = point(cargo);
            const width = parseFloat(cargo.style.width), height = parseFloat(cargo.style.height);
            for (const [slot, id] of before.helpers.entries()) {
                const actor = f.api.snapshot().pages[0].actors.find((value: any) => value.id === id);
                assert.strictEqual(actor.locomotion, 'air');
                const sprite = f.owned.find(canvas => canvas.dataset.courier === String(id)
                    && canvas.className === 'pdfDocumentRobotVehicle')!;
                const scale = actor.spriteScale / module.DOCUMENT_ROBOT_LIMITS.spriteScale;
                const local = crew === 1 ? { x: 0, y: -34 * scale }
                    : { x: (slot === 0 ? -1 : 1) * (width * 0.42 + 10 * scale), y: -(height * 0.35 + 14 * scale) };
                const expected = { x: center.x + local.x * Math.cos(radians) - local.y * Math.sin(radians),
                    y: center.y + local.x * Math.sin(radians) + local.y * Math.cos(radians) };
                assert.ok(Math.hypot(point(sprite).x - expected.x, point(sprite).y - expected.y) < 0.07,
                    'the admitted helper remains rigidly attached to the banked cargo');
                assert.ok(Math.abs(angle(sprite) - bank) < 0.02, 'the body and its cargo share the flight pose');
            }
            const cover = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotArrival');
            assert.ok(cover, 'the source region has its actual owned arrival cover');
            const coverTransform = cover.style.transform;
            const sharp = new Canvas(f.document); sharp.width = 1082; sharp.height = 1536;
            assert.ok(f.api.refine({ ...delivery, canvas: sharp }) > 0);
            f.frame();
            const layers = f.owned.filter(canvas => ['pdfDocumentRobotCargo'].includes(canvas.className) && canvas.width);
            assert.strictEqual(layers.length, 1, 'generic pixel replacement retains exactly one cargo backing');
            assert.ok(Math.abs(angle(layers[0]) - bank) < 1, 'refined cargo continues the existing banked flight');
            assert.strictEqual(cover.style.transform, coverTransform, 'the source mask stays in the fixed page region');
            for (const caption of captions(f)) { assert.ok(!caption.style.transform?.includes('rotate'), 'readable labels stay level'); }
            const current = f.api.snapshot().pages[0].payloads[0];
            for (const key of ['id', 'helpers', 'target', 'deadline']) { assert.deepStrictEqual(current[key], before[key]); }
            assert.deepStrictEqual(current.operation.decision, before.operation.decision);
            f.tick(clock.workEnd - 0.01 - f.now);
            cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
            assert.ok(Math.abs(angle(cargo)) < 0.001, 'landing reaches a level logical page crop');
            f.tick(34);
            assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deposited, true);
            for (const id of before.helpers) {
                const sprite = f.owned.find(canvas => canvas.dataset.courier === String(id) && canvas.className === 'pdfDocumentRobotVehicle')!;
                assert.strictEqual(angle(sprite), 0, 'the landed crew is level before its separate empty return');
            }
            f.tick(before.deadline - f.now + 4000);
            assert.strictEqual(leased.size + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        }
    });

    it('keeps mixed, handoff and carried-ground cargo level on their existing route', () => {
        const ground = stagedLugv('unavailable');
        assert.strictEqual(ground.f.api.offer(ground.delivery(80)), 'started');
        const cases = [ground, cooperative('handoff'), cooperative('airlift')];
        for (const { f } of cases) {
            const before = f.api.snapshot().pages[0].payloads[0], clock = before.operation.timing;
            f.tick(clock.startedAt + (clock.workEnd - clock.startedAt) * 0.6 - f.now);
            assert.ok(f.api.snapshot().pages[0].actors.some((actor: any) => actor.locomotion === 'ground'));
            const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
            assert.strictEqual(Number(cargo.style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1] ?? 0), 0);
            assert.deepStrictEqual(f.api.snapshot().pages[0].payloads[0].operation.decision, before.operation.decision);
            f.tick(before.deadline - f.now + 4000);
            assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        }
    });

    it('promotes a fully staged crew at the exact sprite cap without requesting fresh raster bytes', () => {
        const f = fixture({ seed: 1, maxActors: 2, device: 'mobile', encounterRandom: () => 1 }); f.desktop(3, 1200, 1000);
        const vehicles = ['quad'], held = new Set<string>();
        const origin = { x: 200, y: 150, scale: 1 };
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!vehicles.includes(vehicle) || held.has(vehicle)) { return; }
            held.add(vehicle); return origin;
        }, destination: () => origin, release(vehicle: string) { assert.ok(held.delete(vehicle)); } });
        const pages = [1].map(id => { const page = f.page(id);
            page.pageElement.rect = { left: 40, top: 60, width: 300, height: 420 }; return page; });
        f.api.setVisibleWork(pages.map(page => work([page]))); f.finish();
        const state = f.api.snapshot();
        assert.strictEqual(state.spriteBytes, 204800);
        assert.strictEqual(held.size, 1);
        const actor = state.advance[0].actors[0], sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id))!;
        const size = [sprite.width, sprite.height], allocations = f.owned.length;
        assert.strictEqual(f.api.offer({ ...pages[0], imageRegions: [{ id: 'staged-small', x: 0.3, y: 0.25, width: 0.15, height: 0.1 }] }), 'started');
        assert.ok(f.api.snapshot().pages[0].actors.some((value: any) => value.id === actor.id));
        assert.deepStrictEqual([sprite.width, sprite.height], size);
        assert.strictEqual(f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle').length, 1);
        assert.ok(f.owned.length > allocations, 'only the real cargo obtains a fresh backing');
        f.api.reset();
        assert.strictEqual(held.size + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    function stagedLugv(carrier: 'owned' | 'new' | 'unavailable' | 'overbudget' = 'owned') {
        const f = fixture({ maxActors: 4, device: carrier === 'overbudget' ? 'mobile' : undefined, encounterRandom: () => 0.99 });
        f.desktop(carrier === 'overbudget' ? 3 : 1, 1280, 1000);
        const held = new Set<string>(), releases: string[] = [], reservations: string[] = [];
        let staging = true;
        const groundDock = { x: 1200, y: 280, scale: carrier === 'overbudget' ? 1 : 0.7 }, airDock = { x: 1100, y: 90, scale: 0.7 };
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (held.has(vehicle) || vehicle !== 'lugv' && (vehicle !== 'heavyquad' || carrier === 'unavailable' || staging && carrier !== 'owned')) { return; }
            held.add(vehicle); reservations.push(vehicle);
            return vehicle === 'lugv' ? groundDock : airDock;
        }, destination: (vehicle: string) => vehicle === 'lugv' ? groundDock : airDock,
        release(vehicle: string) { assert.ok(held.delete(vehicle), 'one owner releases ' + vehicle); releases.push(vehicle); } });
        const page = f.page(99); page.pageElement.rect = { left: 40, top: 60, width: 1000, height: 800 };
        f.api.setVisibleWork([work([page], ['preparing'])]); f.tick(1600);
        const actor = f.api.snapshot().advance[0].actors.find((value: any) => value.vehicle === 'lugv');
        assert.ok(actor, 'the real advance crew has the L-UGV body');
        if (carrier === 'overbudget') { assert.strictEqual(f.api.snapshot().spriteBytes, 204800, 'the existing staged owner consumes the real joint cap'); }
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id))!;
        const start = point(sprite);
        staging = false;
        const delivery = (dx: number) => {
            const bodyScale = actor.spriteScale / module.DOCUMENT_ROBOT_LIMITS.spriteScale;
            const center = { x: start.x + dx + 29 * bodyScale, y: start.y - 25 * bodyScale };
            return { ...page, imageRegions: [{ id: 'lugv-photo', x: (center.x - 40) / 1000 - 0.1,
                y: (center.y - 60) / 800 - 0.08, width: 0.2, height: 0.16 }] };
        };
        return { f, page, actor, sprite, start, delivery, held, releases, reservations };
    }

    it('acknowledges hover and a click during a loaded delivery without changing its cargo or deadline', () => {
        const { f } = coarsePhoto({ encounterRandom: () => 0.99 }); f.tick(200);
        const before = f.api.snapshot().pages[0].payloads[0];
        const actor = f.api.snapshot().pages[0].actors.find((value: any) => value.payloadId === before.id);
        const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(actor.id))!;
        const copies = f.owned.reduce((sum, canvas) => sum + canvas.copies.filter(args => args.length === 9).length, 0);
        pointer(f, 'pointermove', point(sprite)); f.tick(34);
        assert.strictEqual(f.api.snapshot().interaction.hovered, actor.id);
        assert.strictEqual(f.api.snapshot().caption.opportunity, 'carrying', 'the moving courier reports its actual loaded work');
        assert.ok(f.api.snapshot().caption.meaningIds.length > 0);
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

    it('keeps a readable hover caption when the moving courier leaves a stationary pointer', () => {
        const { f } = coarsePhoto({ maxActors: 1, encounterRandom: () => 0.99 }); f.tick(200);
        const actor = f.api.snapshot().pages[0].actors[0];
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id) && canvas.className === 'pdfDocumentRobotVehicle')!;
        pointer(f, 'pointermove', point(sprite)); f.frame();
        const bubble = captions(f)[0], before = f.api.snapshot().caption;
        assert.strictEqual(bubble.style.opacity, '1');
        for (let step = 0; step < 30 && f.api.snapshot().interaction.hovered !== undefined; step++) { f.frame(); }
        assert.strictEqual(f.api.snapshot().interaction.hovered, undefined, 'actual motion recomputes the stationary-pointer hit');
        assert.ok(f.now < before.until);
        assert.ok(bubble.isConnected && bubble.style.opacity === '1', 'hover ownership ends without shortening readable text');
        assert.strictEqual(f.api.snapshot().caption.until, before.until);
        assert.strictEqual(f.timers.size, 1);
        assert.ok(sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotCaptionLeader').every(node => !node.isConnected));
        f.tick(before.until - f.now + 1);
        assert.strictEqual(bubble.isConnected, false);
        f.finish();
    });

    it('keeps the greeting text after its gesture ends under a stationary hover', () => {
        const f = fixture({ encounterRandom: () => 0.99 }); f.desktop();
        const page = f.page(99); f.api.setVisibleWork([work([page])]); f.finish();
        const actor = f.api.snapshot().advance[0].actors[0];
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id) && canvas.className === 'pdfDocumentRobotVehicle')!;
        const at = point(sprite); pointer(f, 'pointermove', at); f.frame();
        pointer(f, 'pointerdown', at); pointer(f, 'pointerup', at); pointer(f, 'click', at);
        f.frame();
        for (let step = 0; step < 8 && captions(f)[0]?.style.opacity !== '1'; step++) { f.frame(); }
        const bubble = captions(f)[0], text = bubble.textContent, until = f.api.snapshot().caption.until;
        assert.ok(f.api.snapshot().interaction.greeting !== undefined && !text.includes('Čekam novu stranicu.'));
        f.tick(900);
        assert.strictEqual(f.api.snapshot().interaction.greeting, undefined);
        assert.ok(bubble.isConnected && bubble.style.opacity === '1', 'the 850 ms gesture does not own the longer greeting caption');
        assert.strictEqual(bubble.textContent, text); assert.strictEqual(f.api.snapshot().caption.until, until);
        assert.strictEqual(f.callbacks.size, 0);
        const frames = f.api.snapshot().frames;
        f.tick(until - f.now - 1); assert.ok(bubble.isConnected);
        f.tick(2); assert.strictEqual(bubble.isConnected, false);
        assert.strictEqual(f.api.snapshot().frames, frames);
        assert.strictEqual(f.callbacks.size + f.timers.size, 0);
    });

    it('invalidates a shown caption before changed geometry can hide its retained reading time', () => {
        const f = fixture({ maxActors: 2, encounterRandom: () => 0.99 });
        const page = f.page(); f.api.setVisibleWork([work([page])]); f.finish();
        const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width)!;
        const position = point(sprite);
        pointer(f, 'pointerdown', position); pointer(f, 'pointerup', position); pointer(f, 'click', position);
        for (let step = 0; step < 8 && captions(f)[0]?.style.opacity !== '1'; step++) { f.frame(); }
        const bubble = captions(f)[0];
        assert.ok(bubble?.isConnected && bubble.style.opacity === '1');
        assert.strictEqual(f.timers.size, 1);
        f.container.rect.width = 220; f.document.captionHeight = 10000;
        f.frame();
        assert.strictEqual(bubble.isConnected, false, 'a changed width invalidates the old placement before hiding it');
        assert.strictEqual(f.api.snapshot().caption, undefined);
        assert.strictEqual(f.timers.size, 0, 'an invisible old bubble cannot keep a readable-caption expiry');
        f.api.reset();
    });

    it('starts readable caption time at its first visible placement and bounds an unseen caption', () => {
        const f = fixture({ encounterRandom: () => 0.99 }); f.desktop();
        const page = f.page(99); f.api.setVisibleWork([work([page])]); f.finish();
        const actor = f.api.snapshot().advance[0].actors[0];
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id) && canvas.className === 'pdfDocumentRobotVehicle')!;
        const at = point(sprite); pointer(f, 'pointerdown', at); pointer(f, 'pointerup', at); pointer(f, 'click', at); f.frame();
        const bubble = captions(f)[0], pending = f.api.snapshot().caption, remaining = pending.until - f.now;
        assert.strictEqual(bubble.style.opacity, '0', 'the real placement solver has not admitted the first paint');
        f.tick(200);
        assert.strictEqual(bubble.style.opacity, '1');
        assert.ok(Math.abs(f.api.snapshot().caption.until - f.now - remaining) < 0.01,
            'hidden placement time cannot consume the readable interval');
        assert.strictEqual(f.timers.size, 1);
        f.finish(); f.tick(4001); assert.strictEqual(f.timers.size + f.callbacks.size, 0);

        const blocked = fixture({ encounterRandom: () => 0.99 }); blocked.desktop();
        const other = blocked.page(99); blocked.api.setVisibleWork([work([other])]); blocked.finish();
        blocked.document.captionHeight = 10000;
        const body = blocked.api.snapshot().advance[0].actors[0];
        const image = blocked.owned.find(canvas => canvas.dataset.courier === String(body.id) && canvas.className === 'pdfDocumentRobotVehicle')!;
        pointer(blocked, 'pointermove', point(image)); blocked.frame();
        assert.strictEqual(blocked.api.snapshot().encounters.dialogue.shown, 0, 'intrinsically oversized authored cues never consume readable coverage');
        for (let step = 0; step < 100 && blocked.callbacks.size; step++) { blocked.frame(); }
        blocked.tick(4001);
        assert.ok(captions(blocked).every(node => !node.isConnected || node.style.opacity !== '1'));
        assert.strictEqual(blocked.timers.size + blocked.callbacks.size, 0);
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
        while (shifted.f.callbacks.size && shifted.f.now <= shifted.payload.deadline) {
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
                    // Ground routes keep their admitted carrying offset while a borrowed
                    // body changes size; aerial solo offsets follow the displayed size.
                    const scale = actor.vehicle === 'lugv' ? actor.spriteScale / 1.92 : parseFloat(sprite.style.width) / 128 / 1.92;
                    const bank = Number(cargo.style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1] ?? 0) * Math.PI / 180;
                    const local = { x: (actor.vehicle === 'lugv' ? 87 : 0) * scale,
                        y: (actor.vehicle === 'lugv' ? -75 : 102) * scale };
                    assert.ok(Math.abs(c.x - a.x - (local.x * Math.cos(bank) - local.y * Math.sin(bank))) < 0.08,
                        JSON.stringify({ vehicle: actor.vehicle, cargo: c, body: a, scale, spriteScale: actor.spriteScale, phase: payload.progress }));
                    assert.ok(Math.abs(c.y - a.y - (local.x * Math.sin(bank) + local.y * Math.cos(bank))) < 0.08,
                        'each cargo offset stays with its delivery group while one loaded robot assists the other');
                }
            }
            if (actors.some((actor: any) => actor.vehicle === 'lugv' && actor.carried)) {
                const points = actors.map((actor: any) => ({ actor, point: point(f.owned.find(canvas => canvas.dataset.courier === String(actor.id)
                    && canvas.className === 'pdfDocumentRobotVehicle')!) }));
                const g = points.find((value: any) => value.actor.vehicle === 'lugv')!.point;
                const a = points.find((value: any) => value.actor.vehicle === 'quad')!.point;
                const groundActor = actors.find((actor: any) => actor.vehicle === 'lugv')!;
                const groundSprite = f.owned.find(canvas => canvas.dataset.courier === String(groundActor.id)
                    && canvas.className === 'pdfDocumentRobotVehicle')!;
                const scale = parseFloat(groundSprite.style.width) / 128;
                assert.ok(Math.abs(a.x - g.x) < 0.08 && Math.abs(a.y - g.y + 38.6 * scale) < 0.08,
                    'spacing preserves the shared rescue attachment');
            }
        }
        assert.ok(seen && carried && smoke, 'the real delivery plays malfunction, assistance and a carried-robot phase');
        assert.strictEqual(f.api.snapshot().deliveredFragments, 2);
        assert.strictEqual(f.api.snapshot().activeArrivalCovers + f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(leased.size + f.callbacks.size, 0);
    });

    it('resolves elapsed rescue work before renderer expiry releases its participants', () => {
        const f = fixture({ maxActors: 2, encounterRandom: () => 0 }); f.desktop();
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
            assert.strictEqual(f.api.offer({ ...pages[index], imageRegions: [{ id: 'expiry-' + index,
                x: 0.3, y: 0.35, width: 0.18, height: 0.14 }] }), 'started');
        }
        const deadline = Math.max(...f.api.snapshot().pages.flatMap((page: any) => page.payloads.map((payload: any) => payload.deadline)));
        for (let step = 0; step < 40 && !f.api.snapshot().encounters.active?.rescue; step++) { f.frame(); }
        const rescue = f.api.snapshot().encounters.active?.rescue;
        assert.ok(rescue?.operation, 'the real loaded delivery has a committed rescue before expiry');
        assert.ok(f.now < rescue.operation.timing.workEnd && rescue.operation.timing.deadline < deadline);
        // paintPayload drops expired couriers before paintBodies calls encounters.update.
        f.tick(deadline + 1 - f.now);
        const final = f.api.snapshot();
        assert.strictEqual(final.encounters.lastRescue.completion, rescue.operation.outcome.completion);
        assert.strictEqual(final.encounters.lastRescue.at, rescue.operation.timing.workEnd);
        assert.deepStrictEqual(final.encounters.lastRescue.position, {
            x: rescue.goal.from.x + (rescue.goal.target.x - rescue.goal.from.x) * rescue.operation.outcome.progress,
            y: rescue.goal.from.y + (rescue.goal.target.y - rescue.goal.from.y) * rescue.operation.outcome.progress });
        assert.strictEqual(final.encounters.lastRescue.complete, true);
        assert.strictEqual(final.encounters.active, undefined);
        assert.strictEqual(final.activeActors + final.retainedBytes + final.activeArrivalCovers + leased.size + f.callbacks.size, 0);
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
        let faded = false, fixedYield = false;
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
                    faded = true;
                    fixedYield ||= payload.deposited && !actor.departing;
                    assert.strictEqual(payload.arrivalCovered, !payload.deposited, 'reversible traffic yielding does not retire an undelivered photo');
                }
                if (payload.deposited) { assert.strictEqual(payload.arrivalCovered, false, 'real deposit is terminal'); }
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

    it('captures one page size for a column actor without scaling it by the visible spread union', () => {
        let documentSize = { width: 640, height: 900 };
        const f = fixture({ maxActors: 1, documentSize: () => documentSize }); f.desktop();
        const page = f.page(); f.api.setVisiblePages([1]);
        const motion = { id: 1, fromX: 0, toX: -120, startedAt: f.now, durationMs: 2500,
            reason: 'dock', dock: 'right', bounds: { x: 40, y: 60, width: 1280, height: 1800 } };
        f.api.setColumnTransition(motion); f.tick(500);
        const before = f.api.snapshot().columnPull;
        assert.deepStrictEqual(before.documentSize, documentSize);
        assert.ok(Math.abs(before.spriteScale - 1.92) < 1e-12, 'a second visible row does not enlarge this forklift');
        documentSize = { width: 2560, height: 3600 };
        f.api.setColumnTransition({ ...motion, bounds: { ...motion.bounds, width: 1500 } }); f.tick(400);
        const after = f.api.snapshot().columnPull;
        assert.strictEqual(after.actor, before.actor);
        assert.strictEqual(after.startedAt, before.startedAt);
        assert.strictEqual(after.deadline, before.deadline);
        assert.strictEqual(after.spriteScale, before.spriteScale, 'same-leg contact updates retain the admitted page factor');
        assert.deepStrictEqual(after.documentSize, before.documentSize);
        f.api.setColumnTransition(undefined); f.finish();
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
        assert.deepStrictEqual([page.canvas.width, page.canvas.height], [4320, 6480]);
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
                const handX = point(sprite).x + target.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * f.api.snapshot().columnPull.spriteScale;
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
        const handX = point(sprite).x + hand.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * current.columnPull.spriteScale;
        assert.ok(Math.abs(handX - 130) < 0.05, 'the return starts at the final translated edge, not the preceding paint');
        assert.strictEqual(current.columnPull.phase, 'return');
        assert.strictEqual(current.columnPull.deadline, actor.deadline, 'deferring paint preserves the original finish deadline');
        f.finish();
        assert.strictEqual(f.api.snapshot().columnPull, undefined);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    it('approaches for the shared interval and remains attached through the leisurely haul and settle', () => {
        const timing = module.MOTION_LAB_CHOREOGRAPHY;
        for (const toX of [-120, 120]) {
            let offset = 0, transit: Element | undefined;
            const f = fixture({ maxActors: 1, documentOffset: () => offset,
                registerDocumentLayer: (layer: Element) => { transit = layer; return () => {}; } }); f.desktop();
            const page = f.page(99); page.pageElement.rect.left = 250; f.api.setVisiblePages([99]);
            const motion = { id: 1, fromX: 0, toX, startedAt: f.now, durationMs: timing.columnDurationMs,
                reason: 'dock', dock: toX < 0 ? 'right' : 'left', bounds: { x: 250, y: 60, width: 400, height: 600 } };
            f.api.setColumnTransition(motion);
            const initial = f.api.snapshot(), actor = initial.columnPull;
            assert.ok(actor, 'the renderer admits the complete shared column duration');
            const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.actor))!;
            const start = point(sprite), hand = module.ROBOT_FORKLIFT_ATTACHMENT.pull[toX < 0 ? 'right' : 'left'];
            const edge = toX < 0 ? 250 : 650;
            const attachment = hand.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * initial.columnPull.spriteScale;
            let previous = 0;
            for (const elapsed of [250, 450, timing.approachMs, 900, 1400,
                timing.approachMs + timing.haulMs, timing.columnDurationMs - 50, timing.columnDurationMs]) {
                offset = toX * module.motionLabColumnProgress(elapsed);
                transit!.style.translate = offset + 'px'; page.pageElement.rect.left = 250 + offset;
                f.tick(elapsed - previous); previous = elapsed;
                const state = f.api.snapshot();
                assert.strictEqual(state.columnPull.actor, actor.actor);
                assert.strictEqual(state.columnPull.deadline, actor.deadline);
                const current = point(sprite);
                if (elapsed < timing.approachMs) {
                    assert.strictEqual(Math.abs(offset), 0, 'the page waits for contact');
                    assert.strictEqual(state.columnPull.phase, 'approach');
                    const amount = module.motionLabEase(elapsed / timing.approachMs);
                    assert.ok(Math.abs(current.x - (start.x + (edge - attachment - start.x) * amount)) < 0.05,
                        'approach consumes the same smooth phase as the scene timeline');
                } else {
                    assert.strictEqual(state.columnPull.phase, elapsed < timing.columnDurationMs ? 'pull' : 'return');
                    assert.ok(Math.abs(current.x + attachment - edge - offset) < 0.05,
                        'the manipulator stays on the actual page edge through haul and stationary settle');
                }
                assert.strictEqual(state.activeActors, 1);
                assert.strictEqual(state.cargoBytes + state.activePayloads, 0);
            }
            f.api.setColumnTransition(undefined); f.finish();
            assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
            assert.strictEqual(sprite.zeroWrites, 1);
            assert.strictEqual(f.owned.flatMap(canvas => canvas.copies).length, 0);
        }
    });

    it('retargets the same column actor from its displayed pose without releasing its reservation', () => {
        for (const elapsed of [40, 200, 450]) {
            let offset = 0, transit: Element | undefined, reserved = 0, released = 0;
            const f = fixture({ maxActors: 1, documentOffset: () => offset,
                registerDocumentLayer: (layer: Element) => { transit = layer; return () => {}; } }); f.desktop();
            const page = f.page(99); page.pageElement.rect.left = 250; f.api.setVisiblePages([99]);
            const borrowed = elapsed !== 450;
            const dock = { x: 100, y: 300, scale: 1 };
            if (borrowed) { f.api.setDispatchOrigin({ reserve: () => { reserved++; return dock; },
                destination: () => dock, release: () => { released++; } }); }
            const motion = { id: 1, fromX: 0, toX: -120, startedAt: f.now, durationMs: 400,
                reason: 'dock', dock: 'right', bounds: { x: 250, y: 60, width: 400, height: 600 } };
            f.api.setColumnTransition(motion);
            const actor = f.api.snapshot().columnPull.actor;
            const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor))!;
            offset = -120 * module.motionLabColumnProgress(elapsed, motion.durationMs);
            transit!.style.translate = offset + 'px'; page.pageElement.rect.left = 250 + offset;
            f.tick(elapsed);
            // The shared compositor can move after the actor's last 30 Hz paint.
            offset -= 17; transit!.style.translate = offset + 'px'; page.pageElement.rect.left = 250 + offset;
            const displayed = point(sprite), opacity = Number(sprite.style.opacity);
            f.now += 1;
            const next = { ...motion, id: 2, fromX: offset, toX: offset - 70, startedAt: f.now };
            f.api.setColumnTransition(next);
            assert.strictEqual(f.api.snapshot().columnPull.actor, actor, 'retarget keeps one actor and one sprite');
            assert.strictEqual(reserved, Number(borrowed));
            assert.strictEqual(released, 0);
            assert.deepStrictEqual(point(sprite), displayed, 'retarget starts at the current displayed pose');
            assert.strictEqual(Number(sprite.style.opacity), opacity, 'retarget preserves current visibility');
            f.tick(34);
            const hand = module.ROBOT_FORKLIFT_ATTACHMENT.pull.right;
            const target = 250 + offset - hand.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * f.api.snapshot().columnPull.spriteScale;
            const amount = module.motionLabEase(module.motionLabColumnElapsed(34, next.durationMs)
                / module.MOTION_LAB_CHOREOGRAPHY.approachMs);
            assert.ok(Math.abs(point(sprite).x - (displayed.x + (target - displayed.x) * amount)) < 0.05,
                'the new approach includes compositor movement since the prior paint');
            offset = next.toX; transit!.style.translate = offset + 'px'; page.pageElement.rect.left = 250 + offset;
            f.tick(next.durationMs - 34); f.api.setColumnTransition(undefined); f.finish();
            assert.strictEqual(reserved, Number(borrowed));
            assert.strictEqual(released, Number(borrowed));
            assert.strictEqual(sprite.zeroWrites, 1);
            assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        }
    });

    it('parks the owned column actor without frames and continues after the latest input settles', () => {
        let offset = 0, transit: Element | undefined, reserved = 0, released = 0;
        const f = fixture({ maxActors: 1, documentOffset: () => offset,
            registerDocumentLayer: (layer: Element) => { transit = layer; return () => {}; } }); f.desktop();
        const page = f.page(99); page.pageElement.rect.left = 250; f.api.setVisiblePages([99]);
        const dock = { x: 100, y: 300, scale: 1 };
        f.api.setDispatchOrigin({ reserve: () => { reserved++; return dock; },
            destination: () => dock, release: () => { released++; } });
        const motion = { id: 1, fromX: 0, toX: -120, startedAt: f.now, durationMs: 400, holdAtEnd: true,
            reason: 'drag', dock: 'float', bounds: { x: 250, y: 60, width: 400, height: 600 } };
        f.api.setColumnTransition(motion);
        const actor = f.api.snapshot().columnPull.actor;
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor))!;
        offset = -120; transit!.style.translate = offset + 'px'; page.pageElement.rect.left = 250 + offset;
        f.tick(400);
        assert.strictEqual(f.api.snapshot().columnPull.phase, 'waiting');
        assert.strictEqual(f.callbacks.size, 0, 'the parked actor does not animate while input settles');
        const frames = f.api.snapshot().frames;
        f.tick(10000);
        assert.strictEqual(f.api.snapshot().frames, frames);
        assert.strictEqual(f.api.snapshot().columnPull.actor, actor);
        assert.deepStrictEqual([reserved, released], [1, 0]);

        const contact = { ...motion, bounds: { ...motion.bounds, x: 290 } };
        page.pageElement.rect.left += 40;
        f.api.setColumnTransition(contact); f.frame();
        const hand = module.ROBOT_FORKLIFT_ATTACHMENT.pull.right;
        const attachment = hand.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * f.api.snapshot().columnPull.spriteScale;
        assert.ok(Math.abs(point(sprite).x + attachment - (290 + offset)) < 0.05,
            'same-ID geometry keeps the parked manipulator at the actual page edge');
        assert.strictEqual(f.api.snapshot().columnPull.startedAt, motion.startedAt);
        assert.strictEqual(f.callbacks.size, 0);

        f.api.setColumnTransition({ ...contact, id: 2, fromX: offset, toX: -180, startedAt: f.now, holdAtEnd: false });
        assert.strictEqual(f.api.snapshot().columnPull.actor, actor);
        offset = -180; transit!.style.translate = offset + 'px'; page.pageElement.rect.left = 290 + offset;
        f.tick(400); f.api.setColumnTransition(undefined); f.finish();
        assert.deepStrictEqual([reserved, released], [1, 1]);
        assert.strictEqual(sprite.zeroWrites, 1);
        assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    it('updates same-ID column contact during a haul without restarting its approach or clock', () => {
        let offset = 0, transit: Element | undefined;
        const f = fixture({ maxActors: 1, documentOffset: () => offset,
            registerDocumentLayer: (layer: Element) => { transit = layer; return () => {}; } }); f.desktop();
        const page = f.page(99); page.pageElement.rect.left = 250; f.api.setVisiblePages([99]);
        const motion = { id: 1, fromX: 0, toX: -120, startedAt: f.now, durationMs: 400,
            reason: 'viewport', dock: 'right', bounds: { x: 250, y: 60, width: 400, height: 600 } };
        f.api.setColumnTransition(motion);
        offset = -70; transit!.style.translate = offset + 'px'; page.pageElement.rect.left = 180;
        f.tick(200);
        const initial = f.api.snapshot().columnPull;
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(initial.actor))!;
        f.api.setColumnTransition({ ...motion, bounds: { ...motion.bounds, x: 290 }, holdAtEnd: true });
        f.frame();
        const current = f.api.snapshot(), hand = module.ROBOT_FORKLIFT_ATTACHMENT.pull.right;
        assert.deepStrictEqual([current.columnPull.actor, current.columnPull.startedAt, current.columnPull.phase],
            [initial.actor, initial.startedAt, 'pull']);
        assert.ok(Math.abs(point(sprite).x + hand.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * current.columnPull.spriteScale - 220) < 0.05,
            'viewport contact updates are used by the existing haul');
        f.api.cancelColumnMotion();
        assert.strictEqual(sprite.zeroWrites, 1);
        assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    it('returns or cancels a parked column actor once on each ownership boundary', () => {
        for (const ending of ['complete', 'ready', 'offscreen', 'hide', 'reduce', 'disable', 'reset', 'dispose', 'cancel']) {
            let reserved = 0, released = 0;
            const f = fixture({ maxActors: 1 }); f.desktop();
            const page = f.page(99); page.pageElement.rect.left = 250; f.api.setVisiblePages([99]);
            const dock = { x: 100, y: 300, scale: 1 };
            f.api.setDispatchOrigin({ reserve: () => { reserved++; return dock; },
                destination: () => dock, release: () => { released++; } });
            f.api.setColumnTransition({ id: 1, fromX: 0, toX: -120, startedAt: f.now, durationMs: 400, holdAtEnd: true,
                reason: 'resize', dock: 'float', bounds: { x: 250, y: 60, width: 400, height: 600 } });
            const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width)!;
            f.tick(400); f.tick(1000);
            assert.strictEqual(f.api.snapshot().columnPull.phase, 'waiting');
            assert.strictEqual(f.callbacks.size, 0);
            if (ending === 'complete') { f.api.setColumnTransition(undefined); f.frame();
                assert.strictEqual(f.api.snapshot().columnPull.phase, 'return'); f.finish(); }
            else if (ending === 'ready') { assert.strictEqual(f.api.offer(page), 'started'); f.finish(); }
            else if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            else if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'reduce') { f.media.matches = true; f.media.emit('change'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else if (ending === 'cancel') { f.api.cancelColumnMotion(); }
            else { f.api[ending](); }
            assert.strictEqual(f.api.snapshot().columnPull, undefined, ending);
            assert.strictEqual(sprite.zeroWrites, 1, ending);
            assert.strictEqual(released, reserved, ending);
            assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0, ending);
        }
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
        assert.ok(Math.abs(point(sprite).x + target.x * module.ROBOT_FORKLIFT_ATTACHMENT.scale * state.columnPull.spriteScale - 210) < 0.05,
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
        assert.strictEqual(f.api.snapshot().qualityReactions.length, 0, 'generic pixel refinement does not invent a quality reaction');
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

    it('refines equal-size progressive photo content once per revision without changing the frozen job', () => {
        const { f, source } = coarsePhoto(); f.tick(100);
        const before = f.api.snapshot().pages[0].payloads[0];
        const next = { ...source(135, 192), contentRevision: 1 };
        assert.strictEqual(f.api.refine(next), 1);
        const after = f.api.snapshot().pages[0].payloads[0];
        assert.deepStrictEqual([after.id, after.target, after.deadline, after.helpers, after.operation],
            [before.id, before.target, before.deadline, before.helpers, before.operation]);
        assert.deepStrictEqual([after.rasterWidth, after.rasterHeight], [before.rasterWidth, before.rasterHeight]);
        assert.strictEqual(after.contentRevision, 1);
        const allocated = f.owned.length;
        assert.strictEqual(f.api.refine(next), 0, 'the same scan cannot allocate or restart a cleaner');
        assert.strictEqual(f.api.refine({ ...source(), contentRevision: 0 }), 0, 'older content cannot replace a newer scan');
        assert.strictEqual(f.owned.length, allocated);
        assert.strictEqual(f.api.refine({ ...next, contentRevision: 2 }), 1);
        f.finish();
        assert.strictEqual(f.api.refine({ ...next, contentRevision: 3 }), 0, 'late scans cannot resurrect a retired payload');
        assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
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
        const { f, source } = coarsePhoto({ device: 'mobile', maxActors: 1, maxCargoBytes: 110000 }, { width: 320, height: 450 });
        const old = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        assert.deepStrictEqual([old.width, old.height], [81, 77]);
        assert.ok(160 * 152 * 4 < 110000 && 160 * 152 * 4 + old.width * old.height * 4 > 110000);
        const allocated = f.owned.length, before = f.api.snapshot();
        assert.strictEqual(f.api.refine(source()), 0);
        assert.strictEqual(f.owned.length, allocated, 'peak budget is checked before any new bitmap allocation');
        assert.strictEqual(f.api.snapshot().cargoBytes, before.cargoBytes);
        assert.strictEqual(old.zeroWrites, 0);
    });

    it('keeps the quality reaction available through intermediate cargo revisions until final source pixels arrive', () => {
        const { f, publish } = qualityPhoto(); f.tick(300);
        publish(false); const intermediate = f.api.snapshot();
        assert.strictEqual((intermediate.qualityReactions ?? (intermediate.cleaner ? [intermediate.cleaner] : [])).length, 0,
            'intermediate pixels do not consume the final-quality reaction');
        f.frame(); publish(true);
        assert.strictEqual(f.api.snapshot().qualityReactions.length, 1);
        f.finish(); assert.strictEqual(f.api.snapshot().qualityOutcomes.at(-1).outcome, 'completed');
    });

    it('a real sharper publication admits one finite ASAP wipe with every copied byte charged and an idle finish', () => {
        const { f, publish, p } = qualityPhoto(); f.tick(300);
        const before = f.api.snapshot(), original = before.pages[0].payloads[0]; publish();
        const began = f.api.snapshot(), scene = began.qualityReactions[0]; assert.ok(scene);
        assert.strictEqual(began.activeActors, before.activeActors + 1);
        assert.ok(began.activeActors <= began.maxActors && began.spriteBytes <= began.maxSpriteBytes);
        assert.strictEqual(began.pages[0].payloads[0].deadline, original.deadline);
        const quality = f.owned.filter(canvas => canvas.dataset.quality === String(scene.id) && canvas.width > 0);
        assert.strictEqual(quality.length, 3);
        const old = quality.find(canvas => canvas.className === 'pdfDocumentRobotQualityCoarse')!;
        const sharp = quality.find(canvas => canvas.className === 'pdfDocumentRobotQualitySharp')!;
        const actor = quality.find(canvas => canvas.className === 'pdfDocumentRobotQualityCleaner')!;
        const cargo = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width > 0);
        assert.strictEqual(began.cargoBytes, [...cargo, old, sharp].reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0));
        f.tick(120); assert.ok(Number(actor.style.opacity) > 0);
        assert.ok(f.api.snapshot().qualityReactions[0].phase > 0);
        assert.ok(sharp.style.clipPath.startsWith('inset('));
        const current = f.api.snapshot().qualityReactions[0]; publish();
        assert.strictEqual(f.api.snapshot().qualityReactions[0].id, current.id, 'later final revisions do not restart the wipe');
        f.finish(); assert.strictEqual(f.api.snapshot().qualityReactions.length, 0);
        assert.ok(quality.every(canvas => canvas.zeroWrites === 1));
        assert.strictEqual(f.api.snapshot().deliveryPlans[0].crops[0].state, 'delivered');
        assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        const frames = f.api.snapshot().frames; f.tick(20000); assert.strictEqual(f.api.snapshot().frames, frames);
        void p;
    });

    it('preserves an admitted wipe for ready deliveries and releases it exactly once on hard lifecycle exits', () => {
        for (const ending of ['ready', 'offscreen', 'hide', 'reduce', 'disable', 'reset', 'replacement', 'dispose']) {
            const { f, publish, p } = qualityPhoto(); f.tick(300); publish();
            const before = f.api.snapshot().qualityReactions[0]; assert.ok(before);
            const owned = f.owned.filter(canvas => canvas.dataset.quality === String(before.id));
            const late = [...f.callbacks.values()];
            if (ending === 'ready') { const next = f.page(2); f.api.setVisiblePages([p.page.pageNumber, 2]); f.api.offer(next); }
            else if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            else if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'reduce') { f.media.matches = true; f.media.emit('change'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else if (ending === 'reset') { f.api.reset(); }
            else if (ending === 'replacement') { f.api.retireDocument([p.page], 'new-edition'); }
            else { f.api.dispose(); }
            if (ending === 'ready') {
                assert.strictEqual(f.api.snapshot().qualityReactions[0].id, before.id); f.finish();
                assert.strictEqual(f.api.snapshot().qualityOutcomes.at(-1).outcome, 'completed');
            } else { assert.strictEqual(f.api.snapshot().qualityReactions.length, 0, ending); }
            assert.ok(owned.every(canvas => canvas.zeroWrites === 1), ending);
            const allocated = f.owned.length;
            if (ending !== 'ready') { for (const callback of late) { callback(f.now + 40); } }
            assert.strictEqual(f.owned.length, allocated); assert.ok(f.api.snapshot().activeActors <= f.api.snapshot().maxActors);
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
        assert.strictEqual(state.qualityReactions.length, 0);
        assert.strictEqual(coarse.zeroWrites, 1);
        assert.strictEqual(after.id, before.id); assert.strictEqual(after.deadline, before.deadline);
        assert.deepStrictEqual(after.helpers, before.helpers);
        f.finish();
        assert.strictEqual(coarse.zeroWrites, 1, 'the later deposit and return cannot release pixels twice');
        assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('keeps photo ownership through reversible traffic fading, refinement and recovery', () => {
        let visibility = 1;
        const { f, page, source } = coarsePhoto({ maxActors: 4, encounterRandom: () => 0.99,
            createTraffic: () => ({ update: (_at: number, groups: Array<{ id: number }>) =>
                new Map(groups.map(group => [group.id, { x: 12, y: 0, visibility }])), reset() {} }) });
        f.tick(200);
        const before = f.api.snapshot().pages[0].payloads[0];
        const cover = page.pageElement.children.find(node => node.className === 'pdfDocumentRobotArrival')!;
        const coarse = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        visibility = 0.6; f.frame();
        assert.strictEqual(coarse.zeroWrites, 0, 'a reversible fade cannot destroy the photo raster');
        assert.ok(cover.isConnected); assert.strictEqual(cover.style.opacity, '1');
        assert.strictEqual(f.api.refine(source()), 1, 'real sharper pixels may replace a still-owned faded crop');
        f.frame();
        const sharp = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        assert.ok(sharp !== coarse && coarse.width === 0, 'generic pixel refinement retires the replaced bitmap');
        assert.ok(Number(sharp.style.opacity) > 0 && Number(sharp.style.opacity) <= 0.6);
        visibility = 1; f.frame();
        const after = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(after.visibility, 1);
        f.tick(before.deadline * 0.30 - f.now);
        assert.strictEqual(Number(sharp.style.opacity), 1, 'normal presentation returns without another admission or source copy');
        assert.strictEqual(after.id, before.id); assert.strictEqual(after.deadline, before.deadline);
        assert.deepStrictEqual(after.helpers, before.helpers); assert.deepStrictEqual(after.target, before.target);
        assert.strictEqual(after.arrivalCovered, true); assert.strictEqual(after.deposited, false);
        assert.strictEqual(sharp.copies.length, 1);
        f.finish();
        assert.strictEqual(f.api.snapshot().deliveredFragments, 1);
        assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes + f.api.snapshot().activeArrivalCovers, 0);
    });

    it('derives an empty courier pose and delivery outcome from terminal raster ownership', () => {
        const { f, page, source } = coarsePhoto({ maxActors: 1, encounterRandom: () => 0.99 }); f.tick(200);
        const before = f.api.snapshot().pages[0].payloads[0];
        const actor = f.api.snapshot().pages[0].actors[0];
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id) && canvas.className === 'pdfDocumentRobotVehicle')!;
        page.pageElement.replaceChildren(page.canvas, page.text);
        assert.strictEqual(f.api.refine(source()), 0, 'losing the authorized cover is a real terminal cancellation');
        f.frame(); pointer(f, 'pointermove', point(sprite)); f.frame();
        assert.ok(f.api.snapshot().caption && !f.api.snapshot().caption.text.includes('Nosim fotografiju.'),
            'the empty helper must not claim to carry the released photo');
        const state = f.api.snapshot().pages[0];
        assert.strictEqual(state.actors[0].carrying, false);
        assert.strictEqual(state.actors[0].activity, 'navigate');
        assert.strictEqual(state.payloads[0].id, before.id); assert.strictEqual(state.payloads[0].deadline, before.deadline);
        f.finish();
        assert.strictEqual(f.api.snapshot().deliveredFragments, 0, 'an empty route cannot report a later photo deposit');
        assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('keeps an independent robot airlift after terminal photo release', () => {
        const { f, payload } = cooperative('airlift', 2, false, { encounterRandom: () => 0.99 });
        for (let step = 0; step < 100 && !f.api.snapshot().pages[0].payloads[0].routeState?.groundCarried; step++) { f.frame(); }
        const before = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(before.routeState.groundCarried, true);
        f.api.revealArrivals(); f.frame();
        const state = f.api.snapshot().pages[0], ground = state.actors.find((actor: any) => actor.role === 'ground');
        const air = state.actors.find((actor: any) => actor.role === 'aerial');
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(air.id) && canvas.className === 'pdfDocumentRobotVehicle')!;
        pointer(f, 'pointermove', point(sprite)); f.frame();
        assert.ok(f.api.snapshot().caption && !f.api.snapshot().caption.text.includes('Nosim fotografiju.'),
            'carrying another robot is independent from owning photo pixels');
        assert.strictEqual(ground.carried, true); assert.strictEqual(ground.carrying, false);
        assert.strictEqual(air.carrying, true); assert.strictEqual(air.activity, 'assist');
        assert.strictEqual(state.payloads[0].deadline, payload.deadline);
        assert.deepStrictEqual(state.payloads[0].helpers, payload.helpers);
        f.finish(); assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('records a due deposit once when refinement reaches its deadline before the queued paint', () => {
        const { f, source } = coarsePhoto({ maxActors: 2, encounterRandom: () => 0 });
        const before = f.api.snapshot().pages[0].payloads[0];
        f.now = before.deadline * 0.63;
        assert.strictEqual(f.api.refine(source()), 0);
        assert.strictEqual(f.api.snapshot().deliveredFragments, 1, 'the asynchronous due-deposit transition records the real owned photo');
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deposited, true);
        f.tick(0); f.frame();
        assert.strictEqual(f.api.snapshot().deliveredFragments, 1);
        assert.strictEqual(f.api.snapshot().activePayloads + f.api.snapshot().activeArrivalCovers, 0);
        f.finish(); assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    for (const ending of ['explicit reveal', 'deposit', 'detached cover', 'detached cover before paint']) {
        it('terminally retires revealed cargo after ' + ending + ' while preserving its finite return owner', () => {
            let visibility = 1;
            const { f, page, delivery, source } = coarsePhoto({ maxActors: 4,
                createTraffic: () => ({ update: (_at: number, groups: Array<{ id: number }>) =>
                    new Map(groups.map(group => [group.id, { x: 0, y: 0, visibility }])), reset() {} }) });
            f.tick(100); assert.strictEqual(f.api.refine(source()), 1);
            const before = f.api.snapshot().pages[0].payloads[0];
            const rasters = f.owned.filter(canvas => ['pdfDocumentRobotCargo'].includes(canvas.className) && canvas.width);
            assert.strictEqual(rasters.length, 1);
            assert.strictEqual(f.api.snapshot().qualityReactions.length, 0, 'generic refine does not invent a quality transition');
            if (ending === 'explicit reveal') { f.api.revealArrivals(); }
            else if (ending === 'deposit') { f.tick(before.deadline * 0.63 - f.now); }
            else {
                page.pageElement.replaceChildren(page.canvas, page.text);
                if (ending === 'detached cover') {
                    assert.strictEqual(f.api.refine(source(1080, 1536)), 0, 'a detached cover cannot authorize a fresh raster');
                } else { f.frame(); }
            }
            const state = f.api.snapshot(), after = state.pages[0].payloads[0];
            assert.strictEqual(state.activePayloads + state.activeArrivalCovers + state.cargoBytes, 0);
            assert.strictEqual(state.qualityReactions.length, 0);
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

    it('fades only the landing shadow on the existing settle clock after releasing the photo raster', () => {
        const { f, page } = coarsePhoto({ maxActors: 1, encounterRandom: () => 0.99 });
        f.tick(200);
        const before = f.api.snapshot().pages[0].payloads[0];
        const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
        const allocated = f.owned.length;
        const landedAt = before.deadline * 0.62, fadeMs = module.MOTION_LAB_CHOREOGRAPHY.settleMs;
        f.scroll(70, 200);
        f.tick(landedAt + 1 - f.now);
        const shadow = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotLandingShadow')!;
        assert.ok(shadow, 'the landed photo keeps only its brief shadow');
        assert.strictEqual(shadow instanceof Canvas, false);
        assert.strictEqual(shadow.style.boxShadow, cargo.style.boxShadow);
        assert.strictEqual(shadow.style.pointerEvents, 'none');
        assert.strictEqual(shadow.attributes.get('aria-hidden'), 'true');
        assert.ok(Number(shadow.style.opacity) > 0.99);
        assert.deepStrictEqual([shadow.style.width, shadow.style.height].map(parseFloat), [0.6 * 465, 0.4 * 661]);
        const shown = point(shadow as Canvas);
        assert.ok(Math.abs(shown.x - (page.pageElement.rect.left + 0.4 * 465)) < 1e-4,
            'the landed shadow uses the actual CSS page origin after horizontal clipping');
        assert.ok(Math.abs(shown.y - (page.pageElement.rect.top + 0.4 * 661)) < 1e-4,
            'scrolling cannot replace the CSS page origin with a normalized visible fraction');
        const after = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(after.deadline, before.deadline); assert.deepStrictEqual(after.helpers, before.helpers);
        assert.strictEqual(after.deposited, true);
        assert.strictEqual(f.api.snapshot().cargoBytes + f.api.snapshot().activePayloads + f.api.snapshot().activeArrivalCovers, 0);
        assert.strictEqual(cargo.zeroWrites, 1); assert.strictEqual(f.owned.length, allocated);
        assert.deepStrictEqual([page.canvas.width, page.canvas.height, page.canvas.copies.length], [135, 192, 0]);
        assert.strictEqual(page.canvas.style.opacity, undefined, 'the native photograph remains opaque');
        f.tick(landedAt + fadeMs / 2 - f.now);
        assert.ok(Math.abs(Number(shadow.style.opacity) - 0.5) < 1e-8, 'the shadow fades while the photograph stays sharp');
        f.tick(landedAt + fadeMs - f.now);
        assert.strictEqual(shadow.parentNode, null);
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deadline, before.deadline);
        f.finish();
        assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(cargo.zeroWrites, 1);
    });

    it('removes a landing shadow immediately on every hard cancellation or reader reveal', () => {
        for (const ending of ['input', 'offscreen', 'hide', 'reduce', 'disable', 'reset', 'replacement', 'dispose']) {
            const { f, page, source } = coarsePhoto({ maxActors: 1, encounterRandom: () => 0.99 });
            f.tick(200);
            const before = f.api.snapshot().pages[0].payloads[0];
            f.tick(before.deadline * 0.62 + 1 - f.now);
            const shadow = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotLandingShadow')!;
            assert.ok(shadow, ending + ' starts with a landed shadow');
            if (ending === 'input') { f.api.revealArrivals(); }
            else if (ending === 'offscreen') { f.api.setVisiblePages([]); }
            else if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            else if (ending === 'reduce') { f.media.matches = true; f.media.emit('change'); }
            else if (ending === 'disable') { f.api.setEnabled(false); }
            else if (ending === 'replacement') { f.api.retireDocument([page], 'new-edition'); }
            else { f.api[ending](); }
            assert.strictEqual(shadow.parentNode, null, ending);
            assert.strictEqual(f.api.refine(source()), 0, 'a retired photo cannot recreate its shadow');
            f.finish();
            assert.strictEqual(sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotLandingShadow').length, 0);
        }
    });

    it('does not extend a landing shadow when asynchronous refinement reaches a delayed deposit', () => {
        for (const lateMs of [100, 201]) {
            const { f, source } = coarsePhoto({ maxActors: 1, encounterRandom: () => 0.99 });
            f.tick(200);
            const before = f.api.snapshot().pages[0].payloads[0], landedAt = before.deadline * 0.62;
            f.now = landedAt + lateMs;
            assert.strictEqual(f.api.refine(source()), 0);
            const shadow = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotLandingShadow');
            assert.strictEqual(!!shadow, lateMs < module.MOTION_LAB_CHOREOGRAPHY.settleMs);
            f.tick(101);
            assert.strictEqual(shadow?.parentNode ?? null, null, 'the original deposit clock owns expiry');
            assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deadline, before.deadline);
            f.finish();
            assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
        }
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
        while (f.callbacks.size && f.now <= payload.operation.timing.deadline) {
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
            assert.strictEqual(f.callbacks.size, 0, ending);
            if (f.api.snapshot().caption) { f.tick(Math.max(0, f.api.snapshot().caption.until - f.now) + 1); }
            assert.strictEqual(f.timers.size, 0, ending);
            assert.strictEqual(finished.filter(identity => identity === 'edition-b').length, 1, ending + ' reports one terminal transition');
        }
    });

    for (const ending of ['cancel', 'preempt', 'failed-piece', 'finish']) {
        it('gives a retiring caption an explicit ' + ending + ' outcome independent of its actor release', () => {
            const f = fixture({ maxActors: 1, encounterRandom: () => 0.99 });
            const page = f.page(99); f.api.retireDocument([page], 'edition-b'); f.tick(450);
            const actor = f.api.snapshot().replacement.actors[0];
            const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle'
                && canvas.dataset.courier === String(actor.id))!;
            const position = point(sprite);
            pointer(f, 'pointermove', position);
            assert.strictEqual(f.api.snapshot().interaction.hovered, actor.id, 'the retiring actor has a live hit at its displayed center');
            pointer(f, 'pointerdown', position); pointer(f, 'pointerup', position); pointer(f, 'click', position);
            for (let step = 0; step < 12 && captions(f)[0]?.style.opacity !== '1'; step++) {
                f.frame();
            }
            const bubble = captions(f)[0], until = f.api.snapshot().caption?.until;
            assert.ok(bubble?.isConnected && bubble.style.opacity === '1', JSON.stringify({ point: point(sprite),
                interaction: f.api.snapshot().interaction, caption: f.api.snapshot().caption, style: sprite.style }));
            if (ending === 'cancel') { f.api.cancelReplacement('edition-b'); }
            else if (ending === 'preempt') {
                const current = f.page(99); f.api.setVisiblePages([99]);
                assert.strictEqual(f.api.offer(current), 'started');
            } else if (ending === 'failed-piece') { sprite.noContext = true; f.window.devicePixelRatio = 2; f.frame(); }
            else { f.finish(); }
            assert.strictEqual(f.api.snapshot().replacement, undefined);
            if (ending === 'finish') {
                assert.ok(bubble.isConnected && bubble.style.opacity === '1');
                assert.strictEqual(f.api.snapshot().caption.until, until);
                assert.strictEqual(f.callbacks.size + f.api.snapshot().retainedBytes, 0);
                assert.strictEqual(f.timers.size, 1);
                f.tick(until - f.now + 1);
            } else {
                assert.strictEqual(bubble.isConnected, false, 'real old-scene cancellation clears only its owned speech');
                assert.strictEqual(f.timers.size, 0);
            }
            f.api.reset();
            assert.strictEqual(f.callbacks.size + f.timers.size + f.api.snapshot().retainedBytes, 0);
        });
    }

    it('replacement returns every provisional helper when an old-pixel copy fails', () => {
        let f: Fixture;
        const finished: string[] = [];
        f = fixture({ onReplacementComplete: (identity: string) => finished.push(identity), createCanvas() {
            const canvas = new Canvas(f.document); canvas.failCopy = true; f.owned.push(canvas); return canvas;
        } });
        let reserves = 0, releases = 0;
        const held = new Set<string>();
        f.api.setDispatchOrigin({ reserve: (vehicle: string) => {
            if (held.has(vehicle)) { return; }
            held.add(vehicle); reserves++; return { x: 500, y: 70, scale: 0.4 };
        }, destination: () => undefined, release: (vehicle: string) => { assert.ok(held.delete(vehicle)); releases++; } });
        const page = f.page(99);
        f.api.retireDocument([page], 'edition-b');
        assert.strictEqual(f.api.snapshot().replacement, undefined);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.ok(reserves > 0, 'the actual qualified crew is reserved before its crop copy');
        assert.strictEqual(reserves, releases); assert.strictEqual(held.size, 0);
        assert.ok(f.owned.every(canvas => canvas.width === 0 && canvas.zeroWrites === 1));
        assert.deepStrictEqual(finished, ['edition-b']);
        assert.strictEqual(f.callbacks.size, 0);
        assert.strictEqual(page.canvas.width, 4320, 'failed effects leave PDF.js pixels untouched');
    });

    it('holds the longest exact Croatian success line after ordinary motion without another animation frame', () => {
        const f = fixture({ ...successOptions(), seed: 11 }); const page = f.page();
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
            const f = fixture(successOptions()); const page = f.page();
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
        const f = fixture(successOptions());
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

    it('retains readable dialogue through an ordinary advance return without retaining its actors', () => {
        const f = fixture(nearMissOptions()); f.desktop();
        const page = f.page(); let reserved = 0;
        f.api.setDispatchOrigin({ reserve: () => ({ x: reserved++ ? 80 : 600, y: 220, scale: 1.92 }),
            destination: () => ({ x: 600, y: 220, scale: 1.92 }), release() {} });
        f.api.setVisibleWork([work([page])]);
        for (let step = 0; step < 40 && captions(f)[0]?.style.opacity !== '1'; step++) { f.frame(); }
        const bubble = captions(f)[0], until = f.api.snapshot().caption.until;
        assert.strictEqual(bubble.style.opacity, '1');
        f.api.setVisibleWork([work([page], ['ready'])]); f.finish();
        assert.ok(f.now < until);
        assert.ok(bubble.isConnected && bubble.style.opacity === '1');
        assert.strictEqual(f.api.snapshot().caption.until, until);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        assert.strictEqual(f.timers.size, 1);
        f.tick(until - f.now + 1); assert.strictEqual(f.timers.size + f.callbacks.size, 0);
    });

    it('retains a readable column-helper caption after the finite pull and return complete', () => {
        const f = fixture({ maxActors: 1, encounterRandom: () => 0.99 }); f.desktop();
        const page = f.page(99); page.pageElement.rect.left = 250; f.api.setVisiblePages([99]);
        f.api.setColumnTransition({ id: 1, fromX: 0, toX: -120, startedAt: f.now, durationMs: 400,
            reason: 'dock', dock: 'right', bounds: { x: 250, y: 60, width: 400, height: 600 } });
        f.tick(100);
        const actor = f.api.snapshot().columnPull.actor;
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor) && canvas.className === 'pdfDocumentRobotVehicle')!;
        pointer(f, 'pointermove', point(sprite)); f.frame();
        const bubble = captions(f)[0], until = f.api.snapshot().caption.until;
        assert.strictEqual(bubble.style.opacity, '1');
        f.finish();
        assert.ok(bubble.isConnected && bubble.style.opacity === '1');
        assert.strictEqual(f.api.snapshot().caption.until, until);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        f.tick(until - f.now + 1); assert.strictEqual(f.timers.size + f.callbacks.size, 0);
    });

    it('uses a real approaching advance pair for a near miss and promotes its reacted pose into unchanged cargo work', () => {
        const f = fixture(nearMissOptions()); f.desktop();
        const page = f.page();
        let reserved = 0, released = 0, available: Set<string> | undefined;
        f.api.setDispatchOrigin({
            reserve: (vehicle: string) => available && !available.has(vehicle) ? undefined
                : ({ x: reserved++ ? 80 : 600, y: 220, scale: 1.92 }),
            destination: () => ({ x: 600, y: 220, scale: 1.92 }),
            release: () => released++,
        });
        f.api.setVisibleWork([work([page])]);
        let state = f.api.snapshot();
        for (let step = 0; step < 40 && !state.encounters?.active; step++) { f.frame(); state = f.api.snapshot(); }
        assert.strictEqual(state.encounters?.active?.kind, 'near-miss', 'actual computed approach geometry admits the seeded encounter');
        assert.ok(state.advance[0].actors.some((actor: any) => actor.reaction === 'drowsy'));
        const ids = state.encounters.active.ids;
        available = new Set(state.advance[0].actors.filter((actor: any) => ids.includes(actor.id)).map((actor: any) => actor.vehicle));
        const sprites = f.owned.filter(canvas => ids.includes(Number(canvas.dataset.courier)));
        const redraws = sprites.map(canvas => canvas.transforms.length);
        f.tick(136);
        assert.ok(sprites.some((canvas, index) => canvas.transforms.length > redraws[index]), 'cached artwork redraws a changed finite gesture pose');
        const bubble = captions(f)[0], until = f.api.snapshot().caption.until;
        assert.strictEqual(bubble.style.opacity, '1');
        const before = sprites.map(point);
        assert.strictEqual(f.api.offer(page), 'started');
        const promoted = f.api.snapshot().pages[0].actors.filter((actor: any) => ids.includes(actor.id));
        assert.ok(promoted.length > 0, 'a reacting advance actor is actually promoted');
        assert.strictEqual(f.api.snapshot().encounters.active, undefined, 'cargo promotion cancels traffic ownership');
        assert.strictEqual(f.timers.size, 1, 'the readable text has its own finite expiry after actor promotion');
        assert.ok(bubble.isConnected && bubble.style.opacity === '1');
        assert.strictEqual(f.api.snapshot().caption.until, until);
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
            const f = fixture(successOptions()); const page = f.page();
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
        assert.ok(Math.abs(actual.x - (page.pageElement.rect.left + (original.x - originalPage.left) / originalPage.width * 500)) < 0.02,
            JSON.stringify({ original, actual, page: page.pageElement.rect, actors: finished.advance[0].actors,
                sprites: sprites.map(sprite => ({ point: point(sprite), width: sprite.style.width })) }));
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

    it('clamps the enlarged waiting crew as one formation and preserves its page translation', () => {
        const f = fixture({ maxActors: 4, encounterRandom: () => 0.99 }); f.desktop();
        const held = new Set<string>();
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!['heavyquad', 'quad'].includes(vehicle) || held.has(vehicle)) { return; }
            held.add(vehicle); return { x: 900, y: 120, scale: vehicle === 'heavyquad' ? 1 : 0.4 };
        }, destination: () => ({ x: 900, y: 120, scale: 0.4 }), release(vehicle: string) { assert.ok(held.delete(vehicle)); } });
        const page = f.page(); page.pageElement.rect.left = -200;
        f.api.setVisibleWork([work([page])]); f.finish();
        const actors = f.api.snapshot().advance[0].actors;
        assert.strictEqual(actors.length, 2);
        const sprites = actors.map((actor: any) => f.owned.find(canvas => canvas.dataset.courier === String(actor.id))!);
        const before = sprites.map(point);
        const bounds = actors.map((actor: any, index: number) => {
            const ink = module.robotArtworkGeometry(actor.vehicle, actor.spriteScale);
            return { left: before[index].x + ink.left, right: before[index].x + ink.right };
        }).sort((a: any, b: any) => a.left - b.left);
        assert.ok(bounds[0].left >= -0.02 && bounds[1].right <= f.window.innerWidth + 0.02);
        assert.ok(bounds[1].left - bounds[0].right >= 11.98, 'edge clearance translates the complete formation without crushing its body gap');
        f.scroll(13, 29); f.api.setVisibleWork([work([page])]); f.finish();
        sprites.forEach((sprite: Canvas, index: number) => {
            const after = point(sprite);
            assert.ok(Math.abs(after.x - before[index].x + 13) < 0.02);
            assert.ok(Math.abs(after.y - before[index].y + 29) < 0.02);
        });
        assert.deepStrictEqual(f.api.snapshot().advance[0].actors.map((actor: any) => actor.id), actors.map((actor: any) => actor.id));
        assert.strictEqual(f.callbacks.size, 0);
        f.api.reset(); assert.strictEqual(held.size + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    // An intact 300 x 300 CSS crop requests three helpers. This seed volunteers a qualified fork on pages 1 and 2.
    const forkWorkSeed = 9;
    const lowerForkPhoto = Object.freeze({ id: 'lower-photo', x: 0.125, y: 0.36, width: 0.75, height: 0.5 });

    it('keeps a newly admitted ground mast hidden until its first gated geometry paint', () => {
        const f = fixture({ maxActors: 1, seed: forkWorkSeed }); f.desktop();
        const first = f.page(1), second = f.page(2);
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer({ ...first, imageRegions: [lowerForkPhoto] }), 'started');
        const frames = f.api.snapshot().frames;
        f.api.setVisiblePages([2]);
        assert.strictEqual(f.api.offer({ ...second, imageRegions: [lowerForkPhoto] }), 'started');
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
        const f = fixture({ maxActors: 1, seed: forkWorkSeed }); f.desktop();
        const first = f.page(1), second = f.page(2), third = f.page(3);
        f.api.setVisiblePages([1]); f.api.offer({ ...first, imageRegions: [lowerForkPhoto] });
        const frames = f.api.snapshot().frames;
        f.api.setVisiblePages([2]);
        assert.strictEqual(f.api.offer({ ...second, imageRegions: [lowerForkPhoto] }), 'started');
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
            measureText: (text: string) => ({ width: text.length * 6 }),
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
            const f = fixture({ maxActors: 1, seed: forkWorkSeed }); if (desktop) { f.desktop(2); }
            const held = new Set<string>();
            if (!desktop) {
                const dock = { x: 0, y: 630, scale: 0.5 };
                f.api.setDispatchOrigin({ reserve: (vehicle: string) => {
                    if (vehicle !== 'forklift' || held.has(vehicle)) { return; }
                    held.add(vehicle); return dock;
                }, destination: () => dock, release: (vehicle: string) => held.delete(vehicle) });
            }
            const page = f.page();
            f.api.setVisiblePages([1]);
            assert.strictEqual(f.api.offer({ ...page, imageRegions: [lowerForkPhoto] }), 'started');
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
            f.finish(); assert.strictEqual(held.size, 0, 'the available compact-lab fork returns its lease');
        }
    });

    it('gives Navines a lower photograph, a level page-base approach and a mast lift to its exact source', () => {
        const f = fixture({ maxActors: 1, seed: 1 }); f.desktop();
        const page = f.page(); page.pageElement.rect.height = 800;
        const lower = { id: 'lower-photo', x: 0.125, y: 0.5, width: 0.75, height: 0.375 };
        const images = [{ id: 'upper-photo', x: 0.1, y: 0.05, width: 0.8, height: 0.4 }, lower];
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: images }), 'started');
        const episode = f.api.snapshot().pages[0], actor = episode.actors[0], payload = episode.payloads[0];
        assert.strictEqual(actor.vehicle, 'forklift', 'a lower cargo opportunity receives the ground carrier');
        assert.strictEqual(payload.operation.operatingMode, 'volunteer', 'substantial work admits a physically qualified solo fork');
        assert.ok(payload.operation.workload.mass > 2 && payload.operation.peakStrain < 1,
            'the intact page chunk requests a crew but fits the fork carrying and lifting phases');
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
        const pageBottom = page.pageElement.rect.top + page.pageElement.rect.height;
        assert.ok(pageBottom - travel[0].robot.y > 0 && pageBottom - travel[0].robot.y < 70, 'wheel height is tied to the real page lower edge');
        assert.ok(Math.abs(travel[0].robot.x - travel.at(-1)!.robot.x) > 20, 'the forklift actually drives along the base');
        assert.ok(lift[0].cargo.y - lift.at(-1)!.cargo.y > 10, 'the payload rises while the vehicle stays grounded');
        f.tick(beforeDeposit - f.now);
        assert.ok(cargo.isConnected && cover.isConnected);
        assert.strictEqual(f.api.snapshot().pages[0].payloads[0].deposited, false);
        const delivered = point(cargo);
        assert.ok(Math.abs(delivered.x - (40 + (lower.x + lower.width / 2) * 400)) < 0.02);
        assert.ok(Math.abs(delivered.y - (60 + (lower.y + lower.height / 2) * 800)) < 0.02);
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
        const f = fixture({ maxActors: 3, seed: forkWorkSeed }); f.desktop();
        const held = new Set<string>();
        const docks: Record<string, { x: number; y: number; scale: number }> = {
            forklift: { x: 0, y: 600, scale: 0.5 }, quad: { x: 40, y: 100, scale: 0.5 }, lugv: { x: 0, y: 270, scale: 0.5 },
        };
        f.api.setDispatchOrigin({ reserve: (vehicle: string) => {
            if (!docks[vehicle] || held.has(vehicle)) { return; }
            held.add(vehicle); return docks[vehicle];
        }, destination: (vehicle: string) => docks[vehicle], release: (vehicle: string) => held.delete(vehicle) });
        const page = f.page();
        const images = [{ id: 'upper-photo', x: 0.1, y: 0, width: 0.6, height: 0.35 },
            lowerForkPhoto];
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
        assert.strictEqual(held.size, 0, 'both jobs return their actual distinct fleet leases');
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
            const f = fixture({ maxActors: 1, seed: forkWorkSeed }); f.desktop();
            const page = f.page(); f.api.setVisiblePages([1]);
            f.api.offer({ ...page, imageRegions: [lowerForkPhoto] });
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
        assert.strictEqual(f.callbacks.size, 1, 'a work-state label change can request one repaint');
        assert.strictEqual(f.api.snapshot().advance[0].phase, 'parked', 'waiting to preparing does not restart coordination');
        f.finish();
        const coordinated = f.api.snapshot().frames;
        for (let i = 0; i < 20; i++) { f.api.setVisibleWork([work(pages, ['preparing', 'preparing'])]); }
        assert.strictEqual(f.api.snapshot().frames, coordinated);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('reconciles a continuing physical spread atomically across disjoint visible halves', () => {
        for (const reduced of [false, true]) {
            const f = fixture(); f.desktop(); f.media.matches = reduced;
            const pages = [f.page(99), f.page(100)];
            const layoutPages = pages.map(page => ({ pageNumber: page.pageNumber, label: String(page.pageNumber - 11) }));
            const group = (index: number) => ({ ...work([pages[index]]), key: '99,100', layoutPages });
            f.api.setVisibleWork([group(1)]); f.finish();
            const label = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotWorkStatus')!;
            const layer = label.parentNode;
            const actors = f.api.snapshot().advance[0].actors.map((actor: any) => actor.id);
            const allocated = f.owned.length;
            for (const index of [0, 1, 0]) {
                f.api.setVisibleWork([group(index)]);
                assert.ok(label.isConnected, 'a retained group owns its existing status even with no old visible page in common');
                assert.strictEqual(label.parentNode, layer);
                assert.deepStrictEqual(f.api.snapshot().advance[0].actors.map((actor: any) => actor.id), actors,
                    'visibility changes do not release and recreate the continuing crew');
                assert.strictEqual(f.owned.length, allocated);
                assert.deepStrictEqual(f.api.snapshot().advance[0].pages, [pages[index].pageNumber]);
                f.finish();
            }
            if (!reduced) {
                const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle'
                    && canvas.dataset.courier === String(actors[0]))!;
                const before = point(sprite);
                pages[1].pageElement.rect.left -= 1500;
                f.api.setVisibleWork([group(0)]); f.finish();
                const after = point(sprite);
                assert.ok(Math.abs(after.x - before.x) < 1,
                    'the handed-over crew no longer follows its obsolete offscreen page anchor');
                assert.ok(Number.isFinite(after.y));
                assert.ok(label.isConnected);
            }
            f.api.setVisibleWork([]);
            assert.strictEqual(label.isConnected, false, 'an omitted group still releases its real ownership');
            assert.strictEqual(f.api.snapshot().advance.length, 0);
        }
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

    it('reserves all automatic work text before status, crew and pending membership change', () => {
        const f = fixture(); f.desktop(); f.media.matches = true;
        const pages = [f.page(99), f.page(100)];
        const group = work(pages, ['waiting', 'waiting']);
        f.api.setVisibleWork([group]);
        const status = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotWorkStatus')!;
        assert.ok(status.children.length > 1, 'real alternative spans reserve the complete episode before the first paint');
        const live = status.children.find(node => node.attributes.get('aria-hidden') !== 'true')!;
        const reserved = status.children.filter(node => node !== live);
        assert.ok(reserved.some(node => node.textContent.includes('Delivery crew assembling')));
        assert.ok(reserved.some(node => node.textContent.includes('Coordinating the handoff')));
        assert.ok(reserved.some(node => node.textContent.includes('Crew in position')));
        for (const node of reserved) {
            assert.strictEqual(node.attributes.get('aria-hidden'), 'true');
            assert.strictEqual(node.style.visibility, 'hidden');
            assert.strictEqual(node.style.userSelect, 'none');
            assert.strictEqual(node.style.pointerEvents, 'none');
        }
        const measured = status.layoutReads, height = status.style.height;
        f.api.setVisibleWork([work(pages, ['preparing', 'waiting'])]);
        assert.ok(live.textContent.startsWith('Preparing pages'));
        f.api.setVisibleWork([work(pages, ['ready', 'preparing'])]);
        assert.ok(live.textContent.startsWith('Preparing page 89'));
        assert.strictEqual(status.layoutReads, measured, 'state and pending membership do not remeasure the envelope');
        assert.strictEqual(status.style.height, height);
        f.api.setVisibleWork([work(pages, ['ready', 'ready'])]);
        assert.strictEqual(status.isConnected, false, 'completion removes an actorless loading episode');
    });

    it('reserves a clipped spread member before it becomes visible and recalculates for available width', () => {
        const f = fixture(); f.desktop(); f.media.matches = true;
        const pages = [f.page(99), f.page(100)];
        const layoutPages = [{ pageNumber: 99, label: '88' }, { pageNumber: 100, label: 'a long printed page label' }];
        const first = { ...work([pages[0]]), key: '99,100', layoutPages };
        f.api.setVisibleWork([first]);
        const status = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotWorkStatus')!;
        const reservations = status.children.filter(node => node.attributes.get('aria-hidden') === 'true');
        assert.ok(reservations.some(node => node.textContent.includes('a long printed page label')));
        const reads = status.layoutReads, height = status.style.height;
        const both = { ...work(pages), key: first.key, layoutPages };
        both.pages[1].label = layoutPages[1].label;
        f.api.setVisibleWork([both]);
        assert.strictEqual(status.layoutReads, reads, 'newly visible membership uses the already reserved full domain');
        assert.strictEqual(status.style.height, height);
        f.window.innerWidth = 180; f.container.rect.width = 180;
        f.api.setVisibleWork([both]);
        assert.ok(status.layoutReads > reads, 'a genuine viewport width change recalculates wrapping');
        assert.ok(parseFloat(status.style.maxWidth) <= 164);
        f.api.setVisiblePages([]);
        assert.strictEqual(status.isConnected, false);
        assert.strictEqual(status.children.length, 0, 'episode disposal releases every reservation and the live span');
    });

    it('updates a changed complete text domain atomically even when the visible signature is unchanged', () => {
        for (const reduced of [false, true]) {
            const f = fixture(); f.desktop(); f.media.matches = reduced;
            const page = f.page(99);
            const layoutPages = [{ pageNumber: 99, label: '88' }, { pageNumber: 100, label: '89' }];
            const group = { ...work([page]), key: '99,100', layoutPages };
            f.api.setVisibleWork([group]); f.finish();
            const status = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotWorkStatus')!;
            const live = status.children.find(node => node.attributes.get('aria-hidden') !== 'true')!;
            const text = live.textContent, reads = status.layoutReads;
            const changedDomain = { ...group, layoutPages: [layoutPages[0], { ...layoutPages[1], label: 'clipped member changed' }] };
            f.api.setVisibleWork([changedDomain]);
            assert.strictEqual(live.textContent, text, 'a domain-only update cannot blank the valid live message');
            f.finish();
            assert.ok(status.layoutReads > reads, 'a changed clipped-member reservation independently wakes placement');
            const changedVisible = { ...changedDomain, pages: group.pages.map(value => ({ ...value, label: 'visible member changed' })),
                layoutPages: [{ ...layoutPages[0], label: 'visible member changed' }, changedDomain.layoutPages[1]] };
            f.api.setVisibleWork([changedVisible]);
            assert.ok(live.textContent.includes('visible member changed'), 'current content updates synchronously before any capped paint');
            assert.ok(live.textContent.length > 0);
            f.finish();
        }
    });

    it('observes natural reserved text geometry without waking unchanged or retired work', () => {
        for (const reduced of [false, true]) {
            const f = fixture(); f.desktop(); f.media.matches = reduced;
            const page = f.page(99), group = work([page]);
            f.api.setVisibleWork([group]); f.finish();
            const status = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotWorkStatus')!;
            const observer = f.observers.find(value => value.targets.has(status));
            assert.ok(observer, 'the live loading episode owns a border-box observer');
            assert.strictEqual(status.style.height, 'auto', 'the reserved grid keeps natural wrapping height');
            const reads = status.layoutReads, frames = f.api.snapshot().frames;
            const initial = status.getBoundingClientRect();
            observer.emit(status, initial.width, initial.height);
            assert.strictEqual(f.api.snapshot().frames, frames, 'initial unchanged observer delivery does not schedule a paint');
            f.document.workStatusHeight = 128;
            observer.emit(status, initial.width, 128, reduced);
            f.finish();
            assert.strictEqual(status.style.height, 'auto');
            assert.strictEqual(status.layoutReads, reads + 1, 'the observer supplies border-box dimensions without another synchronous label read');
            assert.strictEqual(status.style.opacity, '1');
            const changedFrames = f.api.snapshot().frames;
            for (let repeat = 0; repeat < 10; repeat++) { observer.emit(status, initial.width, 128); }
            assert.strictEqual(f.api.snapshot().frames, changedFrames);
            assert.strictEqual(f.callbacks.size, 0, 'an unchanged reserved box adds no idle animation');
            f.api.setVisibleWork([]);
            assert.strictEqual(observer.disconnected, true);
            observer.emit(status, initial.width, 200);
            assert.strictEqual(f.callbacks.size, 0, 'a queued old callback cannot wake a removed group');
            f.api.setVisibleWork([group]); f.finish();
            const replacementFrames = f.api.snapshot().frames;
            observer.emit(status, initial.width, 240);
            assert.strictEqual(f.api.snapshot().frames, replacementFrames, 'an old callback cannot paint a replacement with the same key');
            assert.strictEqual(f.callbacks.size, 0);
        }
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
        assert.ok(selected.children.find(node => node.attributes.get('aria-hidden') !== 'true')!.textContent.startsWith('Preparing page 89'), 'active preparation takes priority over ambient waiting statuses');
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

    it('chooses collage, whole-image and portion cargo from document zoom independently of DPR', () => {
        const images = [
            { id: 'photo-left', x: 0.04, y: 0.2, width: 0.44, height: 0.35 },
            { id: 'photo-right', x: 0.50, y: 0.2, width: 0.44, height: 0.35 },
        ];
        const selected = new Map<number, unknown>();
        for (const zoom of [0.5, 1, 1.5, 2, 3, 4]) {
            for (const dpr of [1, 1.2, 2, 3]) {
                const f = fixture({ maxActors: 6 }); f.desktop(dpr, 4000, 4000);
                const page = f.page(99);
                page.pageElement.rect = { left: 40, top: 60, width: 640 * zoom, height: 900 * zoom };
                f.api.setVisiblePages([99]);
                assert.strictEqual(f.api.offer({ ...page, imageRegions: images }), 'started');
                const payloads = f.api.snapshot().pages[0].payloads;
                if (zoom === 0.5) {
                    assert.strictEqual(payloads.length, 1, 'a small tight collage has one raster owner rather than repeated members');
                    for (const [key, expected] of Object.entries({ x: 0.04, y: 0.2, width: 0.90, height: 0.35 })) {
                        assert.ok(Math.abs(payloads[0].target[key] - expected) < 1e-12);
                    }
                } else if (zoom <= 1.5) {
                    assert.deepStrictEqual(payloads.map((value: any) => value.imageId).sort(), ['photo-left', 'photo-right']);
                    for (const payload of payloads) {
                        assert.deepStrictEqual(payload.target, { x: images.find(image => image.id === payload.imageId)!.x,
                            y: 0.2, width: 0.44, height: 0.35 });
                    }
                } else {
                    const edge = 400 * 1.35;
                    assert.ok(payloads.length > 0);
                    assert.ok(payloads.every((value: any) => value.target.width * 640 * zoom <= edge + 1e-8
                        && value.target.height * 900 * zoom <= edge + 1e-8), 'magnified photos have bounded page-anchored portions');
                }
                const identity = payloads.map((value: any) => ({ imageId: value.imageId, target: value.target }));
                if (dpr === 1) { selected.set(zoom, identity); }
                else { assert.deepStrictEqual(identity, selected.get(zoom), 'DPR cannot repartition the same logical cargo'); }
                assert.ok(f.api.snapshot().cargoBytes <= f.api.snapshot().maxCargoBytes);
                f.finish();
                assert.strictEqual(f.api.snapshot().retainedBytes, 0);
                assert.strictEqual(f.callbacks.size, 0);
            }
        }
    });

    it('scales document bodies modestly with page size and applies screen density once', () => {
        for (const zoom of [0.5, 1, 1.5, 2, 3, 4]) {
            for (const dpr of [1, 1.2, 2, 3]) {
                const f = fixture({ seed: 19, maxActors: 1 }); f.desktop(dpr, 4000, 4000);
                const page = f.page();
                page.pageElement.rect = { left: 40, top: 60, width: 640 * zoom, height: 900 * zoom };
                f.api.setVisiblePages([1]);
                assert.strictEqual(f.api.offer({ ...page, imageRegions: [
                    { id: 'small-photo', x: 0.1, y: 0.1, width: 0.15, height: 0.1 },
                ] }), 'started');
                f.tick(400);
                const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width)!;
                const factor = Math.max(0.8, Math.min(1.35, Math.sqrt(zoom)));
                const expected = 128 * 1.92 * factor / Math.sqrt(dpr);
                assert.ok(Math.abs(parseFloat(sprite.style.width) - expected) < 0.02,
                    `zoom ${zoom} at DPR ${dpr} displays ${sprite.style.width}, expected ${expected}`);
                assert.ok(sprite.width >= Math.ceil(expected * dpr - 1e-8), 'document growth retains adequate sprite pixels');
                f.finish();
                assert.strictEqual(f.callbacks.size, 0);
            }
        }
    });

    it('allocates compact physical sprite pixels within the existing joint byte limit', () => {
        const f = fixture({ maxActors: 1, device: 'mobile' }); f.desktop(3, 700, 1000);
        const page = f.page();
        page.pageElement.rect = { left: 0, top: 32, width: 1280, height: 1800 };
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [
            { id: 'phone-photo', x: 0.05, y: 0.05, width: 0.12, height: 0.12 },
        ] }), 'started');
        f.tick(400);
        const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width)!;
        assert.ok(sprite.width >= Math.ceil(parseFloat(sprite.style.width) * 3 - 0.02),
            'compact backing must cover the admitted physical artwork size');
        assert.ok(sprite.height >= Math.ceil(parseFloat(sprite.style.height) * 3 - 0.02));
        const state = f.api.snapshot();
        assert.strictEqual(state.maxSpriteBytes, 4 * 128 * 100 * 4);
        assert.ok(state.spriteBytes <= state.maxSpriteBytes);
        f.finish();
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
    });

    it('adapts compact crew backing detail within the shared sprite budget while keeping the committed job', () => {
        const leased = new Set<string>();
        const f = fixture({ device: 'mobile' }); f.desktop(3, 4000, 4000);
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (leased.has(vehicle)) { return; }
            leased.add(vehicle); return { x: 40, y: 100, scale: 0.2 };
        }, destination: () => ({ x: 40, y: 100, scale: 0.2 }), release: (vehicle: string) => leased.delete(vehicle) });
        const page = f.page(99);
        page.pageElement.rect = { left: 40, top: 60, width: 2560, height: 3600 };
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [
            { id: 'large-phone-photo', x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
        ] }), 'started');
        const state = f.api.snapshot();
        assert.strictEqual(state.maxActors, 4);
        assert.ok(state.activeActors >= 2 && state.activeActors <= state.maxActors, 'the larger logical job keeps its qualified crew');
        assert.strictEqual(leased.size, state.activeActors, 'every committed member has one actual reservation');
        assert.ok(state.spriteBytes <= state.maxSpriteBytes);
        f.tick(600);
        const actors = f.api.snapshot().pages[0].actors;
        for (const actor of actors) {
            const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(actor.id))!;
            const minimum = Math.min(1, actor.spriteScale * 3);
            assert.ok(sprite.width >= Math.ceil(128 * minimum) && sprite.height >= Math.ceil(100 * minimum));
            assert.deepStrictEqual([sprite.width, sprite.height], [Math.ceil(128 * actor.spriteScale * actor.spriteDensity),
                Math.ceil(100 * actor.spriteScale * actor.spriteDensity)]);
        }
        assert.ok(actors.some((actor: any) => actor.spriteDensity < 3), 'only raster quality adapts to the bounded joint allocation');
        f.finish();
        assert.strictEqual(leased.size, 0);
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('keeps a partly visible giant photo portion and its owners stable through refinement and zoom cancellation', () => {
        const f = fixture({ maxActors: 4 }); f.desktop(1.2);
        const page = f.page(99);
        page.pageElement.rect = { left: -700, top: -600, width: 2560, height: 3600 };
        page.canvas.width = 160; page.canvas.height = 225;
        const imageRegions = [{ id: 'giant-photo', x: 0.05, y: 0.05, width: 0.9, height: 0.9 }];
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer({ ...page, kind: 'preview', imageRegions }), 'started');
        const before = f.api.snapshot().pages[0].payloads;
        assert.ok(before.every((value: any) => value.target.width * 2560 <= 540 + 1e-8
            && value.target.height * 3600 <= 540 + 1e-8), 'a visible sliver cannot select the whole giant source');
        f.tick(100);
        const sharp = new Canvas(f.document); sharp.width = 640; sharp.height = 900;
        assert.ok(f.api.refine({ ...page, canvas: sharp, imageRegions }) > 0);
        const after = f.api.snapshot().pages[0].payloads;
        for (let index = 0; index < before.length; index++) {
            for (const key of ['id', 'imageId', 'target', 'helpers', 'deadline']) {
                assert.deepStrictEqual(after[index][key], before[index][key], key + ' survives sharper pixels');
            }
            assert.ok(after[index].rasterWidth >= before[index].rasterWidth && after[index].rasterHeight >= before[index].rasterHeight);
        }
        assert.ok(f.api.snapshot().peakCargoBytes <= f.api.snapshot().maxCargoBytes);
        f.api.setVisiblePages([]);
        page.pageElement.rect = { left: 40, top: 60, width: 640, height: 900 };
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions }), 'skipped', 'zoom cannot replay handled cargo');
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.api.snapshot().activeArrivalCovers, 0);
        assert.strictEqual(f.callbacks.size, 0);
    });

    it('prefers an actual image placement and carries its exact rendered crop cooperatively', () => {
        const f = fixture({ maxActors: 3 }); f.desktop();
        const page = f.page(99);
        page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
        f.api.setVisiblePages([99]);
        const image = { id: 'photo-499-placement-1', x: 0.125, y: 0.25, width: 0.625, height: 0.5 };
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [image] }), 'started');
        const payload = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(payload.imageId, image.id, 'trusted PDF placement metadata selects recognizable image cargo');
        assert.deepStrictEqual(payload.target, { x: image.x, y: image.y, width: image.width, height: image.height });
        assert.strictEqual(payload.helpers.length, 3, 'the displayed footprint uses one shared raster and its preferred three-person crew');
        assert.ok(payload.operation.peakStrain <= 1);
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

    it('qualifies the actual available crew for the whole displayed heavy region before publishing it', () => {
        const f = fixture({ seed: 1, maxActors: 3 }); f.desktop();
        const held = new Set<string>();
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (vehicle !== 'quad' || held.has(vehicle)) { return; }
            held.add(vehicle); return { x: 0, y: 400, scale: 1 };
        }, destination: () => ({ x: 0, y: 400, scale: 1 }), release: (vehicle: string) => held.delete(vehicle) });
        const page = f.page(1); page.pageElement.rect = { left: 40, top: 40, width: 640, height: 900 };
        f.api.setVisiblePages([1]);
        f.api.offer({ ...page, imageRegions: [{ id: 'heavy-whole', x: 0.1, y: 0.1, width: 0.6, height: 0.4 }] });
        const state = f.api.snapshot();
        for (const payload of state.pages.flatMap((value: any) => value.payloads)) {
            assert.strictEqual(payload.operation?.operatingMode, 'overreach',
                'an undersized available carrier requires an explicit committed effort plan for the same heavy region');
            assert.ok(payload.operation.peakStrain > 1);
            assert.deepStrictEqual(payload.target, { x: 0.1, y: 0.1, width: 0.6, height: 0.4 });
        }
        f.finish();
        assert.strictEqual(held.size + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    function operationCargo(seed: number, vehicles: readonly string[], options: Record<string, unknown> = {}) {
        const f = fixture({ seed, maxActors: 3, encounterRandom: () => 1, ...options }); f.desktop();
        const held = new Set<string>(), released: string[] = [], reservations: string[] = [];
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            reservations.push(vehicle);
            if (!vehicles.includes(vehicle) || held.has(vehicle)) { return; }
            held.add(vehicle); return { x: 0, y: 400, scale: 1 };
        }, destination: () => ({ x: 0, y: 400, scale: 1 }), release(vehicle: string) {
            assert.ok(held.delete(vehicle), 'a returned helper has one live lease'); released.push(vehicle);
        } });
        const page = f.page(1); page.pageElement.rect = { left: 40, top: 40, width: 640, height: 900 };
        const delivery = { ...page, imageRegions: [{ id: 'heavy-whole', x: 0.1, y: 0.1, width: 0.6, height: 0.4 }] };
        f.api.setVisiblePages([1]);
        return { f, page, delivery, held, released, reservations };
    }

    function failedPairedCargo(seed: number, mode: string) {
        const f = fixture({ seed, maxActors: 2, encounterRandom: () => 1,
            createTraffic: () => ({ update: (_at: number, input: any[]) => new Map(input.map(value => [value.id, { x: 0, y: 0 }])), reset() {} }) });
        f.desktop();
        const held = new Set<string>(), dock = (vehicle: string) => vehicle === 'lugv'
            ? { x: 10, y: 460, scale: 0.55 } : { x: 850, y: 120, scale: 0.55 };
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!['quad', 'lugv'].includes(vehicle) || held.has(vehicle)) { return; }
            held.add(vehicle); return dock(vehicle);
        }, destination: dock, release(vehicle: string) { assert.ok(held.delete(vehicle)); } });
        const page = f.page(1); page.pageElement.rect = { left: 40, top: 40, width: 640, height: 900 };
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [{ id: 'paired-heavy', x: 0.1, y: 0.1, width: 0.6, height: 0.4 }] }), 'started');
        const payload = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(payload.mode, mode); assert.strictEqual(payload.helpers.length, 2);
        assert.strictEqual(payload.operation.operatingMode, 'overreach');
        assert.strictEqual(payload.operation.outcome.family, 'valiant-failure');
        const sprites = payload.helpers.map((id: number) => f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle'
            && canvas.dataset.courier === String(id))!);
        return { f, payload, sprites: sprites as Canvas[], held };
    }

    it('keeps failed paired work roles and cargo growth at the actual capped progress', () => {
        for (const [seed, mode] of [[22, 'airlift'], [666, 'handoff']] as const) {
            const { f, payload, held } = failedPairedCargo(seed, mode);
            f.tick(payload.deadline * 0.15);
            const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
            const before = { width: cargo.style.width, height: cargo.style.height, point: point(cargo) };
            f.tick(payload.deadline * 0.30);
            assert.strictEqual(cargo.style.width, before.width, 'failed work does not grow its cargo after motion has stopped');
            assert.strictEqual(cargo.style.height, before.height); assert.deepStrictEqual(point(cargo), before.point);
            const current = f.api.snapshot().pages[0];
            if (mode === 'handoff') {
                assert.strictEqual(current.payloads[0].handedOff, false, 'elapsed clock time does not transfer a load that never reached rendezvous');
                assert.strictEqual(current.actors.find((actor: any) => actor.vehicle === 'lugv').carrying, false);
            }
            f.tick(payload.deadline + 1 - f.now);
            assert.strictEqual(held.size + f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        }
    });

    it('returns each failed handoff and airlift member continuously from its capped work pose', () => {
        for (const [seed, mode] of [[22, 'airlift'], [666, 'handoff']] as const) {
            const observed = failedPairedCargo(seed, mode), skipped = failedPairedCargo(seed, mode);
            const { f, payload, sprites } = observed;
            const poses = (values: Canvas[]) => values.map(sprite => ({ ...point(sprite), width: parseFloat(sprite.style.width) }));
            f.tick(payload.deadline * 0.74);
            const before = poses(sprites);
            f.tick(payload.deadline * (0.76001 - 0.74));
            for (const [index, value] of poses(sprites).entries()) {
                assert.ok(Math.hypot(value.x - before[index].x, value.y - before[index].y) < 0.06,
                    mode + ' member ' + index + ' teleported at recovery: ' + JSON.stringify({ before: before[index], after: value }));
                assert.ok(Math.abs(value.width - before[index].width) < 0.02, 'return starts at the actual displayed scale');
            }
            f.tick(payload.deadline * (0.79 - 0.76001));
            skipped.f.tick(skipped.payload.deadline * 0.79);
            assert.deepStrictEqual(poses(sprites), poses(skipped.sprites), 'a skipped recovery boundary derives the same owned starting pose');
            const current = f.api.snapshot().pages[0].payloads[0];
            assert.deepStrictEqual(current.helpers, payload.helpers); assert.strictEqual(current.deadline, payload.deadline);
            assert.strictEqual(current.operation.resolution, 'partial'); assert.strictEqual(current.deposited, false);
            for (const value of [observed, skipped]) {
                value.f.tick(value.payload.deadline + 1 - value.f.now);
                const final = value.f.api.snapshot();
                assert.strictEqual(final.deliveredFragments, 0);
                assert.strictEqual(final.activeActors + final.retainedBytes + final.activeArrivalCovers + value.held.size + value.f.callbacks.size, 0);
            }
        }
    });

    it('commits a real three-member heavy crew and consumes the same plan through refinement and frames', () => {
        const { f, page, delivery, held } = operationCargo(1, ['quad', 'heavyquad', 'tiltwing']);
        page.canvas.width = 144; page.canvas.height = 216;
        assert.strictEqual(f.api.offer(delivery), 'started');
        const began = f.api.snapshot(), payload = began.pages[0].payloads[0];
        assert.strictEqual(payload.operation.operatingMode, 'normal');
        assert.strictEqual(payload.helpers.length, 3);
        assert.deepStrictEqual(payload.operation.memberIds, payload.helpers);
        assert.strictEqual(payload.operation.workload.preferredCrew, 3);
        assert.ok(payload.operation.peakStrain <= 1);
        assert.strictEqual(f.owned.flatMap(canvas => canvas.copies).filter(args => args.length === 9).length, 1);
        const frozen = (value: any) => { const { state: _state, resolution: _resolution, ...plan } = value; return plan; };
        const counters = (value: any) => [value.operationAdmissions, value.operationCandidates,
            value.operationCommitChecks, value.operationNarrativeRecords, value.operationAdmissionTotalMs, value.operationAdmissionMaxMs];
        f.tick(200);
        page.canvas.width = 4320; page.canvas.height = 6480;
        assert.strictEqual(f.api.refine(delivery), 1);
        f.frame();
        const refined = f.api.snapshot(), next = refined.pages[0].payloads[0];
        assert.deepStrictEqual(frozen(next.operation), frozen(payload.operation));
        assert.deepStrictEqual(counters(refined), counters(began), 'refinement and frames use the committed plan without candidate or narrative work');
        assert.deepStrictEqual(next.helpers, payload.helpers);
        assert.strictEqual(next.deadline, payload.deadline);
        f.tick(payload.operation.timing.workEnd - f.now + 34);
        assert.strictEqual(f.api.snapshot().deliveredFragments, 1);
        f.tick(payload.deadline - f.now + 34);
        assert.strictEqual(held.size + f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    it('resolves fixed heroic delivery outcomes at semantic deposit, including refinement and skipped frames', () => {
        for (const [seed, family] of [[22, 'valiant-failure'], [41, 'expensive-success'], [268, 'clean-triumph']] as const) {
            const { f, delivery, held } = operationCargo(seed, ['quad'], { encounterRandom: () => 0 });
            assert.strictEqual(f.api.offer(delivery), 'started', 'a compatible underdog can own its deliberate attempt: ' + seed);
            const payload = f.api.snapshot().pages[0].payloads[0], plan = payload.operation;
            assert.strictEqual(plan.operatingMode, 'overreach');
            assert.strictEqual(plan.outcome.family, family);
            assert.strictEqual(payload.helpers.length, 1);
            assert.ok(plan.peakStrain > 1);
            const initialIds = [...payload.helpers], deadline = payload.deadline;
            f.tick(200);
            assert.ok(f.api.snapshot().pages[0].actors.every((actor: any) => actor.malfunction === null), 'effort has no premature smoke');
            f.now = plan.timing.workEnd + 2;
            assert.strictEqual(f.api.refine(delivery), 0, 'a late refinement resolves work rather than resurrecting its pixels');
            f.frame();
            const resolved = f.api.snapshot(), current = resolved.pages[0].payloads[0];
            assert.strictEqual(current.operation.resolution, family === 'valiant-failure' ? 'partial' : 'fulfilled');
            assert.strictEqual(resolved.deliveredFragments, family === 'valiant-failure' ? 0 : 1);
            assert.strictEqual(current.rasterWidth + current.rasterHeight + resolved.activeArrivalCovers + resolved.activeRefinements, 0);
            assert.deepStrictEqual(current.helpers, initialIds); assert.strictEqual(current.deadline, deadline);
            assert.strictEqual(resolved.pages[0].actors[0].malfunction, family === 'expensive-success' ? 'smoke' : null,
                'the owned aftermath takes precedence over an incidental successful-deposit reaction');
            f.tick(deadline - f.now + 34);
            assert.strictEqual(held.size + f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        }
    });

    it('retains one canonical job decision across lower/shared retries, a failed copy and changed available crew', () => {
        let f: Fixture, failCopy = false, failedCopies = 0;
        f = fixture({ seed: 61, maxActors: 4, encounterRandom: () => 1, createCanvas: () => {
            const canvas = new Canvas(f.document); f.owned.push(canvas);
            canvas.beforeCopy = args => {
                if (failCopy && args.length === 9) { failedCopies++; throw new Error('controlled final crop copy failure'); }
            };
            return canvas;
        } });
        f.desktop();
        const available = new Set(['heavyquad']), held = new Set<string>(), releases: string[] = [];
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!available.has(vehicle) || held.has(vehicle)) { return; }
            held.add(vehicle); return { x: 0, y: 400, scale: 1 };
        }, destination: () => ({ x: 0, y: 400, scale: 1 }), release(vehicle: string) {
            assert.ok(held.delete(vehicle), 'each rollback returns only its own reservation'); releases.push(vehicle);
        } });
        const anchor = f.page(2), page = f.page(1);
        for (const value of [anchor, page]) { value.pageElement.rect = { left: 40, top: 40, width: 640, height: 900 }; }
        f.api.setVisiblePages([1, 2]);
        assert.strictEqual(f.api.offer({ ...anchor, imageRegions: [{ id: 'anchor', x: 0.1, y: 0.1, width: 0.1, height: 0.1 }] }), 'started');
        const retained = f.api.snapshot(), anchorId = retained.pages[0].payloads[0].id;
        const image = { id: 'lower-whole', x: 0.1, y: 0.55, width: 0.6, height: 0.4 }, delivery = { ...page, imageRegions: [image] };
        available.clear(); available.add('quad'); failCopy = true;
        assert.strictEqual(f.api.offer(delivery), 'deferred');
        const failed = f.api.snapshot(), decision = failed.lastOperationDecision;
        assert.strictEqual(failedCopies, 1, 'lower/shared/ordinary proposals share the same physical failure boundary');
        assert.strictEqual(failed.operationNarrativeRecords, retained.operationNarrativeRecords + 1);
        assert.strictEqual(failed.pages.length, 1); assert.strictEqual(failed.pages[0].payloads[0].id, anchorId);
        assert.strictEqual(failed.retainedBytes, retained.retainedBytes);
        assert.strictEqual(failed.activeArrivalCovers, retained.activeArrivalCovers);
        assert.deepStrictEqual([...held], ['heavyquad']);
        assert.ok(releases.includes('quad'), 'the failed crop returns its already-reserved actor');
        failCopy = false; available.add('tiltwing');
        assert.strictEqual(f.api.offer(delivery), 'started');
        const accepted = f.api.snapshot(), payload = accepted.pages.find((value: any) => value.page === 1).payloads[0];
        assert.deepStrictEqual(payload.operation.decision, decision.decision);
        assert.strictEqual(payload.operation.key, decision.key);
        assert.strictEqual(accepted.operationNarrativeRecords, failed.operationNarrativeRecords, 'changed availability retains the same four purpose draws');
        assert.strictEqual(accepted.operationDecisionRecords, failed.operationDecisionRecords);
        assert.deepStrictEqual(payload.target, { x: image.x, y: image.y, width: image.width, height: image.height });
        assert.strictEqual(accepted.pages.find((value: any) => value.page === 1).payloads.length, 1);
        const deadline = Math.max(...accepted.pages.flatMap((value: any) => value.payloads.map((value: any) => value.deadline)));
        f.tick(deadline - f.now + 34);
        assert.strictEqual(held.size + f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        f.api.reset(); assert.strictEqual(f.api.snapshot().operationDecisionRecords, 0);
    });

    it('cancels an admitted heroic consequence with its cargo and keeps every terminal boundary finite', () => {
        for (const cancel of ['arrival', 'hide', 'disable', 'reset']) {
            const { f, delivery, held } = operationCargo(41, ['quad']);
            assert.strictEqual(f.api.offer(delivery), 'started');
            const payload = f.api.snapshot().pages[0].payloads[0];
            if (cancel === 'arrival') { f.api.revealArrivals(); }
            if (cancel === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
            if (cancel === 'disable') { f.api.setEnabled(false); }
            if (cancel === 'reset') { f.api.reset(); }
            f.tick(payload.deadline + 34);
            assert.strictEqual(f.api.snapshot().deliveredFragments, 0);
            assert.strictEqual(held.size + f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
            assert.ok(f.api.snapshot().pages.flatMap((page: any) => page.actors).every((actor: any) => actor.malfunction === null));
        }
    });

    it('gives removal the same committed effort policy and resolves its own removal clock', () => {
        for (const [seed, family] of [[10, 'expensive-success'], [55, 'valiant-failure'], [221, 'clean-triumph']] as const) {
            const { f, delivery, held } = operationCargo(seed, ['quad']);
            f.api.retireDocument([delivery], 'edition-old');
            const payload = f.api.snapshot().replacement?.payloads[0];
            assert.ok(payload, 'an owned compatible removal attempt is reachable');
            assert.strictEqual(payload.operation.goal, 'removal');
            assert.strictEqual(payload.operation.outcome.family, family);
            f.tick(payload.operation.timing.workEnd + 34);
            const snapshot = f.api.snapshot();
            assert.strictEqual(snapshot.removedFragments, family === 'valiant-failure' ? 0 : 1);
            assert.strictEqual(snapshot.deliveredFragments, 0);
            assert.strictEqual(snapshot.replacement.payloads[0].operation.resolution, family === 'valiant-failure' ? 'partial' : 'fulfilled');
            f.tick(payload.operation.timing.deadline - f.now + 34);
            assert.strictEqual(held.size + f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        }
    });

    it('resolves fulfilled and partial removal before cleanup when a frame skips the entire activity', () => {
        for (const [seed, completion] of [[10, 'fulfilled'], [55, 'partial']] as const) {
            const { f, delivery, held } = operationCargo(seed, ['quad']);
            f.api.retireDocument([delivery], 'skipped-old');
            const payload = f.api.snapshot().replacement.payloads[0];
            assert.strictEqual(payload.operation.outcome.completion, completion);
            const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
            const released: unknown[] = [];
            cargo.beforeRelease = () => released.push(f.api.snapshot().replacement?.payloads.find((value: any) => value.id === payload.id)?.operation.resolution);
            f.tick(payload.operation.timing.deadline + 34);
            assert.deepStrictEqual(released, [completion], 'semantic work resolves before the retiring owner and its pixels disappear');
            assert.strictEqual(f.api.snapshot().removedFragments, completion === 'fulfilled' ? 1 : 0);
            assert.strictEqual(f.api.snapshot().deliveredFragments, 0);
            assert.strictEqual(f.api.snapshot().replacement, undefined);
            assert.strictEqual(held.size + f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
            assert.strictEqual(cargo.zeroWrites, 1);
        }
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

    it('promotes the staged L-UGV into a shallow turn lift without changing its crop owner or clock', () => {
        for (const dx of [80, -80]) {
            const { f, actor, sprite, start, delivery, held, reservations } = stagedLugv();
            pointer(f, 'pointermove', { x: start.x - 10, y: start.y }); f.frame();
            const reserved = reservations.length;
            assert.strictEqual(f.api.offer(delivery(dx)), 'started');
            const before = f.api.snapshot().pages[0].payloads[0], duration = before.deadline - f.now;
            assert.ok(before.helpers.includes(actor.id), 'promotion keeps the actual staged body');
            f.tick(duration * 0.62 * 0.2);
            if (dx > 0) {
                const stopped = point(sprite);
                assert.ok(Math.hypot(stopped.x - start.x, stopped.y - start.y) < 0.04, 'L-UGV does not reverse before recruitment');
            }
            f.tick(duration * 0.62 * 0.4);
            const current = f.api.snapshot().pages[0].payloads[0];
            if (dx > 0) {
                assert.strictEqual(current.mode, 'airlift');
                assert.strictEqual(current.routeState.requiresAir, true, 'committed travel, not gaze, determines a turn');
                assert.strictEqual(current.routeState.groundCarried, true);
                assert.strictEqual(current.routeState.reason, 'turn');
                const groundPoint = point(sprite), route = current.routeState;
                assert.ok(Math.hypot(groundPoint.x - route.ground.x, groundPoint.y - route.ground.y) < 0.04);
                const cargo = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotCargo' && canvas.width)!;
                const pixels = point(cargo);
                assert.ok(Math.hypot(pixels.x - route.cargo.x, pixels.y - route.cargo.y) < 0.04, 'the same photograph stays attached to the carried chassis');
            } else {
                assert.strictEqual(current.mode, 'solo', 'a forward trip with a small photograph uses its fitting staged courier');
                assert.deepStrictEqual(current.helpers, [actor.id]);
                assert.strictEqual(current.routeState, undefined);
            }
            assert.strictEqual(current.deadline, before.deadline); assert.deepStrictEqual(current.helpers, before.helpers);
            assert.deepStrictEqual(current.target, before.target); assert.strictEqual(current.id, before.id);
            assert.strictEqual(reservations.length, reserved, 'the owned staged aircraft is reused first');
            let reverseReturn = false;
            while (f.callbacks.size && f.now <= before.deadline) {
                f.frame();
                const returning = f.api.snapshot().pages[0]?.payloads[0];
                if (returning?.stage !== 'return') { continue; }
                assert.strictEqual(returning.routeState.reason, 'turn', 'the same companion carries a committed reverse return');
                reverseReturn ||= returning.routeState.groundCarried;
                if (dx > 0) { assert.deepStrictEqual(returning.helpers, before.helpers); }
                else { assert.ok(returning.helpers.includes(actor.id), 'the empty return retains its original body when a carrier joins'); }
                assert.strictEqual(returning.deadline, before.deadline);
            }
            assert.ok(reverseReturn);
            assert.strictEqual(held.size + f.callbacks.size + f.api.snapshot().retainedBytes, 0, 'the committed return deadline releases every owner');
            f.finish();
            assert.strictEqual(held.size + f.callbacks.size + f.api.snapshot().retainedBytes, 0);
        }
    });

    it('retains the same staged L-UGV when a turn carrier is unavailable or exceeds the backing budget', () => {
        for (const carrier of ['unavailable', 'overbudget'] as const) {
            const { f, actor, delivery, held, reservations, releases } = stagedLugv(carrier);
            assert.strictEqual(f.api.offer(delivery(80)), 'started');
            const before = f.api.snapshot().pages[0].payloads[0];
            assert.deepStrictEqual(before.helpers, [actor.id], 'failed assistance keeps the already-owned ground route');
            assert.strictEqual(before.mode, 'solo');
            if (carrier === 'overbudget') {
                assert.ok(reservations.includes('heavyquad'));
                assert.strictEqual(releases.filter(value => value === 'heavyquad').length, 1, 'failed physical allocation returns its lease');
            }
            const reserved = reservations.length;
            while (f.callbacks.size && f.now < before.deadline * 0.75) { f.frame(); }
            assert.strictEqual(reservations.length, reserved, 'a failed outbound preference is not retried per paint');
            f.finish();
            assert.strictEqual(held.size + f.callbacks.size + f.api.snapshot().retainedBytes, 0);
        }
    });

    it('keeps staged bodies provisional through a failed cargo copy and transfers them to a distinct job', () => {
        const { f, actor, sprite, delivery, held, releases, reservations } = stagedLugv('unavailable');
        const first = delivery(80), region = first.imageRegions[0];
        const before = { payload: sprite.dataset.payload, point: point(sprite), bytes: sprite.width * sprite.height, reservations: reservations.length };
        const observed: Array<{ payload?: string; bytes: number; released: boolean }> = [];
        let copies = 0;
        f.onCanvasCreated = canvas => { canvas.beforeCopy = args => {
            if (args.length !== 9 || args[0] !== first.canvas) { return; }
            observed.push({ payload: sprite.dataset.payload, bytes: sprite.width * sprite.height, released: releases.includes('lugv') });
            if (++copies === 1) { throw new Error('first logical job copy failed'); }
        }; };
        assert.strictEqual(f.api.offer({ ...first, imageRegions: [region,
            { ...region, id: 'second-independent-photo', x: region.x - 0.25, width: 0.12 }] }), 'started');
        assert.ok(observed.length >= 2, 'a failed proposal leaves a separate logical job eligible');
        assert.ok(observed.every(value => value.payload === before.payload && value.bytes === before.bytes && !value.released),
            JSON.stringify(observed));
        const payload = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(payload.imageId, 'second-independent-photo');
        assert.deepStrictEqual(payload.helpers, [actor.id], 'the same actual staged body, sprite and lease transfer only on commitment');
        assert.strictEqual(reservations.length, before.reservations, 'proposal fallback does not reserve a replacement for a viable staged actor');
        assert.strictEqual(sprite.dataset.payload, String(payload.id));
        f.tick(payload.deadline + 1 - f.now);
        assert.strictEqual(held.size + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        assert.strictEqual(releases.filter(value => value === 'lugv').length, 1);
    });

    it('lets an empty staged L-UGV recruit its owned aircraft for a finite reverse return', () => {
        const { f, page, actor, sprite, start, held, reservations } = stagedLugv();
        const reserved = reservations.length;
        f.api.setVisibleWork([work([page], ['ready'])]);
        f.tick(module.DOCUMENT_ROBOT_LIMITS.advance.returnMs * 0.2);
        const stopped = point(sprite);
        assert.ok(Math.hypot(stopped.x - start.x, stopped.y - start.y) < 0.04, 'empty L-UGV waits for its actual carrier');
        f.tick(module.DOCUMENT_ROBOT_LIMITS.advance.returnMs * 0.4);
        const state = f.api.snapshot().advance[0];
        assert.strictEqual(state.returnCarry.ground, actor.id);
        assert.strictEqual(state.returnCarry.reason, 'turn');
        assert.strictEqual(state.returnCarry.route.groundCarried, true);
        assert.strictEqual(reservations.length, reserved);
        f.finish();
        assert.strictEqual(held.size + f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('reserves one real helper for an ordinary L-UGV reverse return without recreating delivered cargo', () => {
        const f = fixture({ maxActors: 2, encounterRandom: () => 0.99 }); f.desktop(1, 1280, 1000);
        const held = new Set<string>(), releases: string[] = [];
        let airAvailable = false, airReservations = 0;
        const groundDock = { x: 1100, y: 340, scale: 0.7 }, airDock = { x: 1100, y: 90, scale: 0.7 };
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (held.has(vehicle) || vehicle !== 'lugv' && (vehicle !== 'quad' || !airAvailable)) { return; }
            held.add(vehicle); if (vehicle === 'quad') { airReservations++; }
            return vehicle === 'lugv' ? groundDock : airDock;
        }, destination: (vehicle: string) => vehicle === 'lugv' ? groundDock : airDock,
        release(vehicle: string) { assert.ok(held.delete(vehicle)); releases.push(vehicle); } });
        const page = f.page(99); page.pageElement.rect = { left: 40, top: 60, width: 1000, height: 800 };
        f.api.setVisiblePages([99]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [{ id: 'solo-lugv', x: 0.4, y: 0.15, width: 0.2, height: 0.2 }] }), 'started');
        const before = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(before.mode, 'solo'); assert.strictEqual(before.helpers.length, 1);
        const copies = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotCargo').length;
        f.tick(before.deadline * 0.70); airAvailable = true;
        let carried = false;
        while (f.callbacks.size && f.now <= before.deadline) {
            f.frame();
            const state = f.api.snapshot(), current = state.pages[0]?.payloads[0];
            if (current?.stage !== 'return') { continue; }
            assert.strictEqual(current.id, before.id); assert.strictEqual(current.deadline, before.deadline);
            assert.deepStrictEqual(current.target, before.target); assert.strictEqual(current.helpers[0], before.helpers[0]);
            assert.strictEqual(current.helpers.length, 2, 'one real helper joins the same finite owner');
            assert.strictEqual(current.routeState.reason, 'turn');
            carried ||= current.routeState.groundCarried;
            if (current.routeState.groundCarried) {
                for (const actor of state.pages[0].actors) {
                    const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(actor.id))!;
                    const position = point(sprite), target = actor.vehicle === 'lugv' ? current.routeState.ground : current.routeState.air;
                    assert.ok(Math.hypot(position.x - target.x, position.y - target.y) < 0.04, 'both real bodies keep the rigid carry attachment');
                    assert.ok(sprite.width >= Math.floor(parseFloat(sprite.style.width)), 'the recruited body retains its physical raster quality');
                }
            }
            assert.strictEqual(state.cargoBytes + state.activePayloads + state.activeArrivalCovers, 0);
            assert.ok(state.activeActors <= state.maxActors && state.spriteBytes <= state.maxSpriteBytes);
        }
        assert.ok(carried); assert.strictEqual(airReservations, 1);
        assert.strictEqual(releases.filter(value => value === 'quad').length, 1);
        assert.strictEqual(f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotCargo').length, copies);
        assert.strictEqual(held.size + f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('releases every L-UGV carry helper and sling on hard termination without reviving a stale frame', () => {
        for (const kind of ['payload', 'advance']) {
            for (const ending of ['offscreen', 'hide', 'reduce', 'disable', 'reset', 'dispose']) {
                const { f, page, delivery, held } = stagedLugv();
                if (kind === 'payload') {
                    assert.strictEqual(f.api.offer(delivery(80)), 'started');
                    const payload = f.api.snapshot().pages[0].payloads[0];
                    f.tick((payload.deadline - f.now) * 0.86);
                    assert.strictEqual(f.api.snapshot().pages[0].payloads[0].routeState.groundCarried, true);
                } else {
                    f.api.setVisibleWork([work([page], ['ready'])]);
                    f.tick(module.DOCUMENT_ROBOT_LIMITS.advance.returnMs * 0.5);
                    assert.strictEqual(f.api.snapshot().advance[0].returnCarry.route.groundCarried, true);
                }
                const slings = sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotSling');
                assert.strictEqual(slings.length, 1);
                const late = [...f.callbacks.values()], allocated = f.owned.length;
                if (ending === 'offscreen') { f.api.setVisiblePages([]); }
                else if (ending === 'hide') { f.document.hidden = true; f.document.emit('visibilitychange'); }
                else if (ending === 'reduce') { f.media.matches = true; f.media.emit('change'); }
                else if (ending === 'disable') { f.api.setEnabled(false); }
                else { f.api[ending](); }
                for (const callback of late) { callback(f.now + 40); }
                assert.strictEqual(f.owned.length, allocated);
                assert.ok(slings.every(sling => !sling.parentNode));
                assert.strictEqual(held.size + f.callbacks.size + f.api.snapshot().retainedBytes, 0, kind + ':' + ending);
            }
        }
    });

    it('transfers an interrupted empty carry to ready pixels without leaving its old sling owner', () => {
        const { f, page, delivery, held } = stagedLugv();
        f.api.setVisibleWork([work([page], ['ready'])]);
        f.tick(module.DOCUMENT_ROBOT_LIMITS.advance.returnMs * 0.5);
        const previous = f.api.snapshot().advance[0].returnCarry;
        const sling = sceneNodes(f.container).find(node => node.className === 'pdfDocumentRobotSling')!;
        assert.ok(previous && sling);
        f.api.setVisibleWork([work([page], ['preparing'])]);
        assert.strictEqual(f.api.offer(delivery(80)), 'started');
        assert.ok(!sling.parentNode, 'the former empty-return owner drops its hardware on promotion');
        assert.ok(f.api.snapshot().advance.every((value: any) => !value.returnCarry));
        const helpers = f.api.snapshot().pages[0].payloads.flatMap((value: any) => value.helpers);
        assert.ok(helpers.includes(previous.ground));
        f.finish();
        assert.strictEqual(held.size + f.callbacks.size + f.api.snapshot().retainedBytes, 0);
    });

    it('ends an empty L-UGV carry as one owner if either body cannot be painted', () => {
        for (const vehicle of ['lugv', 'heavyquad']) {
            const { f, page, held } = stagedLugv();
            f.api.setVisibleWork([work([page], ['ready'])]);
            f.tick(module.DOCUMENT_ROBOT_LIMITS.advance.returnMs * 0.5);
            const current = f.api.snapshot().advance[0];
            assert.strictEqual(current.returnCarry.route.groundCarried, true);
            const body = current.actors.find((actor: any) => actor.vehicle === vehicle);
            const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle'
                && canvas.dataset.courier === String(body.id))!;
            sprite.context.clearRect = () => { throw new Error('owned artwork failed'); };
            pointer(f, 'pointermove', point(sprite)); f.frame();
            assert.ok(f.api.snapshot().rejected > 0, 'the actual artwork paint reached its failure boundary');
            assert.strictEqual(held.size + f.api.snapshot().retainedBytes, 0, 'the pair and its hardware retire together');
            assert.strictEqual(sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotSling').length, 0);
            f.frame();
            assert.strictEqual(f.callbacks.size, 0, 'the existing dirty paint settles without a return loop');
        }
    });

    it('reuses a handoff aircraft from its completed pose for the L-UGV reverse return', () => {
        const f = fixture({ seed: 132112, maxActors: 2, encounterRandom: () => 0.99 }); f.desktop(1, 1280, 1000);
        const held = new Set<string>();
        const groundDock = { x: 1000, y: 380, scale: 0.7 }, airDock = { x: 1000, y: 90, scale: 0.7 };
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!['lugv', 'quad'].includes(vehicle) || held.has(vehicle)) { return; }
            held.add(vehicle); return vehicle === 'lugv' ? groundDock : airDock;
        }, destination: (vehicle: string) => vehicle === 'lugv' ? groundDock : airDock,
        release(vehicle: string) { assert.ok(held.delete(vehicle)); } });
        const page = f.page(1); page.pageElement.rect = { left: 40, top: 60, width: 1000, height: 800 };
        f.api.setVisiblePages([1]); const started = f.now;
        f.api.offer({ ...page, imageRegions: [{ id: 'handoff-1', x: 0.4, y: 0.15, width: 0.24, height: 0.25 }] });
        const payload = f.api.snapshot().pages[0]?.payloads.find((value: any) => value.mode === 'handoff');
        assert.ok(payload, 'the fixed canonical opportunity admits a real L-UGV handoff');
        assert.strictEqual(payload.operation.operatingMode, 'overreach');
        assert.strictEqual(payload.operation.outcome.family, 'clean-triumph');
        const duration = payload.deadline - started;
        f.tick(started + duration * 0.70 - f.now);
        const air = f.api.snapshot().pages[0].actors.find((value: any) => value.vehicle === 'quad');
        const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(air.id))!;
        const before = point(sprite);
        f.tick(started + duration * 0.76 - f.now);
        const after = point(sprite);
        assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 0.04, 'a completed handoff cannot jump back to its initial aerial offset');
        const current = f.api.snapshot().pages[0].payloads[0];
        assert.strictEqual(current.routeState.reason, 'turn');
        assert.strictEqual(current.deadline, payload.deadline); assert.deepStrictEqual(current.helpers, payload.helpers);
        f.finish(); assert.strictEqual(held.size + f.callbacks.size + f.api.snapshot().retainedBytes, 0);
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
        const dock = { x: 0, y: 440, scale: 1.92 }, airDock = { x: 900, y: 80, scale: 1.92 };
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!['hexapod', 'heavyquad'].includes(vehicle) || held.has(vehicle)) { return; }
            held.add(vehicle); return vehicle === 'hexapod' ? dock : airDock;
        }, destination: (vehicle: string) => vehicle === 'hexapod' ? dock : airDock,
        release: (vehicle: string) => held.delete(vehicle) });
        let payload: any;
        for (let id = 1; id <= 16; id++) {
            const page = f.page(id);
            page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
            f.api.setVisiblePages([id]);
            f.api.offer({ ...page, imageRegions: [{ id: 'sloped-handoff', x: 0.3, y: 0.2, width: 240 / 465, height: 270 / 661 }] });
            payload = f.api.snapshot().pages[0]?.payloads.find((value: any) => value.mode === 'handoff');
            if (payload) { break; } f.finish();
        }
        assert.ok(payload, 'a ground dock at a different height can join a gentle cooperative handoff');
        const actor = f.api.snapshot().pages[0].actors.find((value: any) => value.vehicle === 'hexapod');
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id))!;
        let previous = point(sprite), handoff: { x: number; y: number } | undefined;
        assert.ok(Math.hypot(previous.x - dock.x, previous.y - dock.y) < 0.03, 'the real borrowed body does not teleport');
        let climbed = false, returned = false, last = previous;
        const delivered = f.api.snapshot().deliveredFragments;
        while (f.callbacks.size && f.now <= payload.deadline) {
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
        const scene = cooperative('airlift');
        assert.ok('setGroundDock' in scene);
        const { f, payload, held, airDock } = scene;
        while (f.now <= payload.deadline && !f.api.snapshot().pages[0]?.payloads[0].deposited) { f.frame(); }
        assert.ok(f.api.snapshot().pages[0]?.payloads[0].deposited, 'the qualified fixture reaches the semantic deposit boundary');
        const state = f.api.snapshot().pages[0], route = state.payloads[0].routeState;
        const ground = state.actors.find((value: any) => value.vehicle === 'lugv');
        scene.setGroundDock!({ x: route.ground.x + 80 * (ground.drivingDirection ?? 1), y: route.ground.y, scale: 0.5 });
        const air = state.actors.find((actor: any) => actor.vehicle === 'heavyquad');
        const sprite = f.owned.find(canvas => canvas.dataset.courier === String(air.id))!;
        const distances: number[] = [];
        while (f.callbacks.size && f.now <= payload.deadline) {
            f.frame(); const current = f.api.snapshot().pages[0]?.payloads[0];
            if (current?.stage !== 'return') { continue; }
            assert.strictEqual(current.routeState.requiresAir, false);
            const currentPoint = point(sprite);
            distances.push(Math.hypot(currentPoint.x - airDock!.x, currentPoint.y - airDock!.y));
        }
        assert.ok(distances.length > 3);
        assert.ok(distances.at(-1)! < distances[0] * 0.1, 'the aircraft reaches its dock before its lease is released');
        assert.strictEqual(held!.size, 0);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
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

    it('mixes proportionate solo and formation deliveries within the existing mobile and desktop resource caps', () => {
        const modes = new Set<string>();
        for (const device of ['mobile', 'desktop']) {
            const f = fixture({ device });
            f.desktop(3);
            for (let id = 1; id <= 15; id++) {
                const page = f.page(id);
                page.pageElement.rect = { left: 40, top: 60, width: 465, height: 661 };
                f.api.setVisiblePages([id]); f.api.offer(page);
                const state = f.api.snapshot();
                for (const payload of state.pages[0]?.payloads ?? []) {
                    modes.add(payload.mode);
                    if (payload.operation.operatingMode !== 'overreach') {
                        assert.ok(payload.helpers.length <= payload.operation.workload.preferredCrew, 'ordinary photo-only work uses its fitting crew');
                    }
                }
                assert.ok(state.activeActors <= state.maxActors && state.cargoBytes <= state.maxCargoBytes && state.spriteBytes <= state.maxSpriteBytes);
                assert.strictEqual(state.retainedBytes, f.owned.reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0));
                f.finish();
            }
        }
        assert.deepStrictEqual([...modes].sort(), ['formation', 'solo']);
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
        const f = fixture({ maxActors: 3, seed: 1 });
        f.desktop();
        const held = new Set<string>();
        let reservations = 0, releases = 0;
        const origin = { x: 1300, y: 620, scale: 0.4 };
        f.api.setDispatchOrigin({
            reserve(vehicle: string) {
                if (vehicle !== 'lugv' || held.has(vehicle)) { return; }
                held.add(vehicle); reservations++; return origin;
            },
            destination: (vehicle: string) => held.has(vehicle) ? origin : undefined,
            release(vehicle: string) { assert.ok(held.delete(vehicle), 'each borrowed helper is returned once'); releases++; },
        });
        const page = f.page();
        page.pageElement.rect = { left: 40, top: 60, width: 640, height: 900 };
        const light = { id: 'independent-light-photo', x: 0.1, y: 0.52, width: 0.1, height: 0.1 };
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer({ ...page, imageRegions: [
            { id: 'heavy-photo', x: 0.1, y: 0.1, width: 0.6, height: 0.4 }, light,
        ] }), 'started');
        const state = f.api.snapshot(), payload = state.pages[0].payloads[0];
        assert.strictEqual(state.pages[0].payloads.length, 1);
        assert.deepStrictEqual(payload.target, { x: light.x, y: light.y, width: light.width, height: light.height });
        assert.strictEqual(payload.operation.operatingMode, 'normal');
        assert.strictEqual(payload.helpers.length, 1);
        assert.ok(reservations > 1 && releases > 0, 'a heavy proposal returns its partial crew before the separate light job');
        assert.strictEqual(held.size, 1);
        assert.strictEqual(f.owned.flatMap(canvas => canvas.copies).filter(args => args.length === 9).length, 1,
            'only the qualified light job copies pixels after its actual crew is complete');
        f.tick(payload.deadline - f.now + 1);
        assert.strictEqual(held.size, 0);
        assert.strictEqual(f.api.snapshot().activeActors + f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotArrival').length, 0);
        assert.strictEqual(f.callbacks.size, 0);
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
        const settled = f.api.snapshot();
        assert.strictEqual(settled.activeActors + settled.retainedBytes, 0);
        if (settled.caption) { f.tick(Math.max(0, settled.caption.until - f.now + 1)); }
        assert.strictEqual(f.api.snapshot().frames, settled.frames, 'the readable static caption expires without another frame');
        assert.ok(transit.parentNode === null, 'retained transit state: ' + JSON.stringify({
            children: transit.children.map(child => child.className), caption: f.api.snapshot().caption,
            actors: f.api.snapshot().activeActors, bytes: f.api.snapshot().retainedBytes, now: f.now }));

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
            const actors = state.pages.flatMap((page: any) => page.actors);
            assert.strictEqual(new Set(actors.map((actor: any) => actor.id)).size, 12, 'every body has an independent owner');
            assert.ok(new Set(actors.map((actor: any) => actor.vehicle)).size < actors.length,
                'the non-Lab fleet can create another body of an existing structural type');
            assert.strictEqual(state.maxCargoBytes, 3 * 1024 * 1024);
            assert.strictEqual(state.maxSpriteBytes, 24 * 1024 * 1024);
            assert.ok(state.cargoBytes <= state.maxCargoBytes && state.spriteBytes <= state.maxSpriteBytes);
            for (let i = 0; i < 12; i++) { f.frame(); }
            const sprites = f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width);
            assert.strictEqual(sprites.length, 12);
            const documentScale = (465 * 661 / (640 * 900)) ** 0.25;
            const scale = 1.92 * documentScale / Math.sqrt(dpr);
            for (const sprite of sprites) {
                const actor = actors.find((value: any) => String(value.id) === sprite.dataset.courier), factor = actor.vehicle === 'heavyquad' ? 2.5 : 1;
                const effective = scale * factor;
                assert.ok(Math.abs(parseFloat(sprite.style.width) - 128 * effective) < 0.02, 'CSS size receives document, character and DPI scale exactly once');
                assert.deepStrictEqual([sprite.width, sprite.height], [Math.ceil(128 * effective * dpr), Math.ceil(100 * effective * dpr)]);
                assert.ok(sprite.transforms.some(values => values[0] >= effective * dpr && values[3] >= effective * dpr), 'artwork is redrawn into display-resolution backing');
            }
            assert.strictEqual(f.api.snapshot().spriteBytes, sprites.reduce((bytes, sprite) => bytes + sprite.width * sprite.height * 4, 0));
            assert.strictEqual(f.api.snapshot().retainedBytes, f.owned.reduce((bytes, canvas) => bytes + canvas.width * canvas.height * 4, 0));
            if (dpr === 1) {
                const before = f.api.snapshot().spriteBytes;
                f.window.innerWidth = f.container.rect.width = 860;
                f.frame();
                assert.ok(f.api.snapshot().spriteBytes < before, 'an active resize redraws smaller backing instead of leaving oversized sprites');
                assert.ok(sprites.every(sprite => parseFloat(sprite.style.width) < 210
                    * (actors.find((value: any) => String(value.id) === sprite.dataset.courier).vehicle === 'heavyquad' ? 2.5 : 1)));
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
            f.frame();
            const actors = f.api.snapshot().pages.flatMap((page: any) => page.actors);
            assert.ok(f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.width).every(canvas => {
                const actor = actors.find((value: any) => String(value.id) === canvas.dataset.courier)!;
                const minimum = Math.min(1, actor.spriteScale * 3);
                return canvas.width >= Math.ceil(128 * minimum) && canvas.height >= Math.ceil(100 * minimum)
                    && actor.spriteDensity > 0 && actor.spriteDensity <= 3;
            }), 'even staggered, not-yet-painted actors retain their admitted local-art detail floor');
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

    it('defers moving entry strips on either axis before spending their page opportunity', () => {
        for (const axis of ['x', 'y'] as const) {
            for (const edge of ['start', 'end']) {
                const f = fixture(); f.desktop();
                const page = f.page();
                const start = axis === 'x' ? 0 : 32, end = axis === 'x' ? 1076 : 1459;
                const extent = axis === 'x' ? 400 : 600, visible = axis === 'x' ? 160 : 120;
                const key = axis === 'x' ? 'left' : 'top';
                page.pageElement.rect[key] = edge === 'start' ? start - extent + visible : end - visible;
                f.api.setVisiblePages([1]);
                const before = f.api.snapshot();
                assert.strictEqual(f.api.offer(page, { moving: true, axis }), 'deferred', axis + ':' + edge);
                assert.strictEqual(f.api.hasHandled(1), false);
                assert.strictEqual(f.owned.length, 0, 'no selection bitmap, cargo or courier is allocated for an entering strip');
                assert.strictEqual(f.callbacks.size, 0);
                assert.strictEqual(f.api.snapshot().operationAdmissions, before.operationAdmissions);
                page.pageElement.rect[key] = (start + end) / 2 - visible / 2;
                assert.strictEqual(f.api.offer(page, { moving: true, axis }), 'started', 'midpoint coverage admits once');
                assert.strictEqual(f.api.hasHandled(1), true);
                const payload = f.api.snapshot().pages[0].payloads[0];
                const allocations = f.owned.length;
                assert.strictEqual(f.api.offer(page, { moving: true, axis }), 'skipped');
                assert.strictEqual(f.owned.length, allocations);
                assert.deepStrictEqual(f.api.snapshot().pages[0].payloads[0].target, payload.target);
                f.finish();
                assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
            }
        }
    });

    it('admits a settled partial page without changing its measured geometry', () => {
        const f = fixture(); f.desktop();
        const page = f.page(); page.pageElement.rect.top = 1339;
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer(page, { moving: true, axis: 'y' }), 'deferred');
        assert.strictEqual(f.api.offer(page, { moving: false, axis: 'y' }), 'started');
        assert.strictEqual(f.api.hasHandled(1), true);
        f.finish();
        assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
    });

    it('uses the supplied inner clip for moving admission and accepts large centers and complete small pages', () => {
        for (const axis of ['x', 'y'] as const) {
            const f = fixture(); f.desktop();
            const page = f.page();
            page.pageElement.rect = { left: -500, top: -500, width: 4000, height: 6000 };
            const projection = { content: { x: 0, y: 0, width: 4000, height: 6000 },
                clip: axis === 'x' ? { x: 1416, y: 560, width: 400, height: 600 }
                    : { x: 540, y: 1839, width: 400, height: 600 } };
            f.api.setVisiblePages([1]);
            assert.strictEqual(f.api.offer({ ...page, pageProjection: projection }, { moving: true, axis }), 'deferred',
                'a large CSS content rectangle cannot stand in for its entering visible clip');
            assert.strictEqual(f.owned.length, 0);
            assert.strictEqual(f.api.offer(page, { moving: true, axis }), 'started', 'a giant page covering the midpoint is eligible');
            f.finish();
            const small = f.page(2); small.pageElement.rect = { left: 40, top: 60, width: 200, height: 200 };
            f.api.setVisiblePages([2]);
            assert.strictEqual(f.api.offer(small, { moving: true, axis }), 'started', 'a fully visible off-center page is eligible');
            f.finish();
            assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        }
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
        const factor = (sprite: Canvas) => actors.find((actor: any) => String(actor.id) === sprite.dataset.courier).vehicle === 'heavyquad' ? 2.5 : 1;
        assert.ok(sprites.every(sprite => Math.abs(parseFloat(sprite.style.width) - 128 * 86 / 250 / Math.sqrt(2) * factor(sprite)) < 0.02));
        f.now += 700; f.frame();
        const documentScale = (465 * 661 / (640 * 900)) ** 0.25;
        assert.ok(sprites.every(sprite => Math.abs(parseFloat(sprite.style.width) - 128 * 1.92 * documentScale / Math.sqrt(2) * factor(sprite)) < 0.02));
        f.finish();
        assert.ok(lab.snapshot().actors.every((actor: any) => !actor.outside));
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
    });

    it('assigns exclusive fallback jobs in a 600 by 240 visible text strip before copying pixels', () => {
        let multiple = false;
        for (const seed of [1, 13]) {
            const f = textStripFixture({ seed }); f.desktop(1, 1200, 900);
            const page = f.page();
            page.pageElement.rect = { left: 40, top: 660, width: 600, height: 900 };
            f.api.setVisiblePages([1]);
            assert.strictEqual(f.api.offer(page), 'started');
            const payloads = f.api.snapshot().pages[0].payloads;
            multiple ||= payloads.length > 1;
            exclusiveRegions(payloads, '600 by 240 strip, seed ' + seed);
            const copies = f.owned.flatMap(canvas => canvas.copies.filter(args => args.length === 9 && args[0] === page.canvas));
            assert.strictEqual(copies.length, payloads.length, 'rejected overlap allocates no duplicate raster');
            f.finish();
            assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        }
        assert.ok(multiple, 'separate available text regions still receive separate jobs');
    });

    it('claims cooperative enlargement against ground and solo jobs before allocating another crop', () => {
        const f = fixture({ maxActors: 8 }); f.desktop(1, 1280, 1000);
        let shared = false, distinct = false;
        for (let id = 1; id <= 12; id++) {
            const page = f.page(id);
            page.pageElement.rect = id % 2 ? { left: 40, top: -600, width: 1000, height: 1000 }
                : { left: 40, top: 300, width: 1000, height: 1600 };
            f.api.setVisiblePages([id]); assert.strictEqual(f.api.offer(page), 'started');
            const payloads = f.api.snapshot().pages[0].payloads;
            shared ||= payloads.some((payload: any) => payload.helpers.length > 1);
            distinct ||= payloads.length > 1;
            exclusiveRegions(payloads, 'enlarged/shared page ' + id);
            const copies = f.owned.flatMap(canvas => canvas.copies.filter(args => args.length === 9 && args[0] === page.canvas));
            assert.strictEqual(copies.length, payloads.length, 'one copied raster belongs to each job regardless of its helper count');
            assert.strictEqual(page.pageElement.children.filter(node => node.className === 'pdfDocumentRobotArrival').length, payloads.length);
            f.finish();
        }
        assert.ok(shared && distinct, 'cooperative jobs and distinct work remain available');
    });

    it('selects whole-photo and collage work before a smaller overlapping lower route', () => {
        const whole = { id: 'whole-photo', x: 0.1, y: 0.45, width: 0.5, height: 0.3 };
        const collage = [{ id: 'left-photo', x: 0.1, y: 0.55, width: 0.2, height: 0.18 },
            { id: 'right-photo', x: 0.306, y: 0.55, width: 0.2, height: 0.18 }];
        for (const [kind, regions, target] of [
            ['image', [whole, { id: 'lower-inset', x: 0.35, y: 0.65, width: 0.12, height: 0.12 }],
                { x: whole.x, y: whole.y, width: whole.width, height: whole.height }],
            ['collage', [...collage, { id: 'lower-inset', x: 0.2, y: 0.68, width: 0.08, height: 0.08 }],
                { x: 0.1, y: 0.55, width: 0.406, height: 0.18 }],
        ] as const) {
            const f = fixture({ maxActors: 6 }); f.desktop(1, 1200, 1100);
            const page = f.page(); page.pageElement.rect = { left: 40, top: 60, width: 640, height: 900 };
            f.api.setVisiblePages([1]); assert.strictEqual(f.api.offer({ ...page, imageRegions: regions }), 'started');
            const payloads = f.api.snapshot().pages[0].payloads;
            const job = payloads.find((payload: any) => payload.cropKind === kind && payload.imageId !== 'lower-inset');
            assert.ok(job, 'route choice retains the preferred ' + kind + ' unit');
            for (const key of ['x', 'y', 'width', 'height'] as const) { assert.ok(Math.abs(job.target[key] - target[key]) < 1e-12); }
            assert.ok(payloads.every((payload: any) => payload.imageId !== 'lower-inset'), 'a smaller lower proposal cannot claim the semantic unit first');
            exclusiveRegions(payloads, kind); f.finish();
        }
    });

    it('keeps separate same-image placements and exclusive jobs through zoom, DPR and refinement', () => {
        const first = { id: 'reused-photo', x: 0.1, y: 0.1, width: 0.18, height: 0.12 };
        const second = { ...first, x: 0.65 };
        for (const zoom of [0.5, 1, 1.5, 2, 3, 4]) {
            for (const dpr of [1, 1.2, 2, 3]) {
                const width = 640 * zoom, height = 900 * zoom;
                const f = fixture({ maxActors: 6 }); f.desktop(dpr, Math.max(1200, width + 80), Math.max(1100, height + 100));
                const page = f.page(); page.pageElement.rect = { left: 40, top: 60, width, height };
                page.canvas.width = 160; page.canvas.height = 225;
                const delivery = { ...page, kind: 'preview' as const, imageRegions: [first, second,
                    { ...first, id: 'overlapping-layer', width: first.width - 0.02, x: first.x + 0.02 }] };
                f.api.setVisiblePages([1]); assert.strictEqual(f.api.offer(delivery), 'started');
                const before = f.api.snapshot().pages[0].payloads;
                assert.strictEqual(before.length, 2, 'separate placements remain distinct jobs at ' + zoom + '/' + dpr);
                assert.deepStrictEqual(before.map((job: any) => job.target.x).sort(), [first.x, second.x]);
                exclusiveRegions(before, zoom + '/' + dpr);
                const source = new Canvas(f.document); source.width = 640; source.height = 900;
                assert.strictEqual(f.api.refine({ ...delivery, canvas: source, kind: 'page' }), 2);
                const after = f.api.snapshot().pages[0].payloads;
                for (let index = 0; index < before.length; index++) {
                    for (const key of ['id', 'imageId', 'target', 'helpers', 'deadline']) { assert.deepStrictEqual(after[index][key], before[index][key]); }
                }
                assert.strictEqual(f.api.offer(delivery), 'skipped');
                f.finish();
                assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
            }
        }
    });

    it('leaves a failed region proposal available after canvas or helper reservation rollback', () => {
        for (const failure of ['copy', 'helper']) {
            let f: Fixture, failCopy = failure === 'copy', failReservation = failure === 'helper', notifications = 0;
            f = fixture({ maxActors: 3, onCapacityAvailable: () => notifications++, createCanvas: () => {
                const canvas = new Canvas(f.document); f.owned.push(canvas);
                canvas.beforeCopy = args => {
                    if (failCopy && args.length === 9) { failCopy = false; throw new Error('first region copy failed'); }
                };
                return canvas;
            } });
            f.desktop(1, 1200, 1100);
            const held = new Set<string>(); let borrowed = 0, released = 0;
            if (failure === 'helper') {
                const origin = { x: 1300, y: 450, scale: 0.4 };
                f.api.setDispatchOrigin({ reserve(vehicle: string) {
                    if (!['lugv', 'quad'].includes(vehicle) || held.has(vehicle)) { return; }
                    if (failReservation && held.size) { failReservation = false; throw new Error('second crew reservation failed'); }
                    held.add(vehicle); borrowed++; return origin;
                }, destination: () => origin, release(vehicle: string) { assert.ok(held.delete(vehicle)); released++; } });
            }
            const page = f.page(); page.pageElement.rect = { left: 40, top: 60, width: 640, height: 900 };
            const image = { id: 'single-job', x: 0.2, y: 0.2,
                width: failure === 'helper' ? 240 / 640 : 0.3, height: failure === 'helper' ? 270 / 900 : 0.2 };
            const delivery = { ...page, imageRegions: [image] };
            f.api.setVisiblePages([1]);
            {
                assert.strictEqual(f.api.offer(delivery), 'deferred', 'a physical copy or reservation failure keeps its canonical job eligible');
                const rejected = f.api.snapshot();
                assert.strictEqual(f.api.hasHandled(1), false);
                assert.strictEqual(rejected.activeActors + rejected.retainedBytes + rejected.activeArrivalCovers + f.callbacks.size + notifications, 0);
                f.tick(10000);
                assert.strictEqual(f.api.snapshot().operationAdmissions, rejected.operationAdmissions, 'rollback does not retry itself');
                assert.strictEqual(f.api.offer(delivery), 'started', 'a later explicit offer retries the same unclaimed region');
                assert.deepStrictEqual(f.api.snapshot().pages[0].payloads[0].operation.decision, rejected.lastOperationDecision.decision);
                assert.strictEqual(f.api.snapshot().operationNarrativeRecords, rejected.operationNarrativeRecords);
            }
            const jobs = f.api.snapshot().pages[0].payloads;
            assert.strictEqual(jobs.length, 1);
            if (failure === 'helper') { assert.strictEqual(jobs[0].helpers.length, 2); }
            assert.deepStrictEqual(jobs[0].target, { x: image.x, y: image.y, width: image.width, height: image.height });
            if (failure === 'copy') { assert.ok(f.owned.some(canvas => canvas.zeroWrites === 1), 'failed construction releases its temporary owner'); }
            else { assert.strictEqual(f.owned.filter(canvas => canvas.className === 'pdfDocumentRobotVehicle').length, jobs[0].helpers.length,
                'a missing crew member rejects the provisional leases before allocating any body backing'); }
            if (failure === 'helper') { assert.ok(borrowed >= 3 && released >= 1, 'the failed crew returned its real lease before the explicit retry committed its full pair'); }
            f.finish(); assert.strictEqual(held.size + f.api.snapshot().retainedBytes + f.callbacks.size, 0);
            assert.strictEqual(borrowed, released);
        }
    });

    it('keeps retiring region jobs exclusive per page without claiming the incoming document', () => {
        const f = textStripFixture({ maxActors: 8 }); f.desktop(1, 1280, 1000);
        const pages = [f.page(1), f.page(2)];
        pages.forEach((page, index) => { page.pageElement.rect = { left: 40 + index * 610, top: 760, width: 600, height: 900 }; });
        f.api.retireDocument(pages, 'old-edition');
        const retiring = f.api.snapshot().replacement.payloads;
        for (const page of pages) {
            const jobs = retiring.filter((job: any) => job.page === page.pageNumber);
            assert.ok(jobs.length > 1, 'each old page receives distinct available work');
            exclusiveRegions(jobs, 'retirement page ' + page.pageNumber);
        }
        f.api.setVisiblePages([1]); assert.strictEqual(f.api.offer(pages[0]), 'started', 'old edition claims cannot suppress incoming pixels');
        exclusiveRegions(f.api.snapshot().pages[0].payloads, 'incoming document');
        f.api.reset();
        assert.strictEqual(f.api.snapshot().retainedBytes + f.callbacks.size, 0);
        assert.strictEqual(f.api.snapshot().replacement, undefined);
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
        const allocations = f.owned.length, quality = f.api.snapshot().qualityReactions;
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
        assert.deepStrictEqual(f.api.snapshot().qualityReactions, quality, 'repeated pixel revisions do not create quality ownership');
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

    it('varies fitting vehicle combinations and arrival routes for repeated small work', () => {
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
        assert.ok(vehicles.size >= 4, 'repeated small work still visits several fitting structural carriers');
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
                assert.ok(Math.abs(parseFloat(sprite.style.width) - module.ROBOT_ARTWORK_SIZE.width * 86 / 250
                    * (actor.vehicle === 'heavyquad' ? 2.5 : 1)) < 0.02,
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

    for (const activity of ['cargo', 'waiting'] as const) {
        it('reconciles reduced motion observed by an owned frame before the change event for ' + activity, () => {
            const f = fixture({ maxActors: 2 });
            const held = new Set<string>(), reserved: string[] = [], returned: string[] = [];
            const dock = { x: 650, y: 90, scale: 0.4 };
            f.api.setDispatchOrigin({ reserve(vehicle: string) {
                if (held.has(vehicle)) { return; }
                held.add(vehicle); reserved.push(vehicle); return dock;
            }, destination: () => dock, release(vehicle: string) {
                assert.ok(held.delete(vehicle), 'each borrowed actor has one release owner'); returned.push(vehicle);
            } });
            const page = f.page(99);
            if (activity === 'cargo') {
                f.api.setVisiblePages([99]);
                assert.strictEqual(f.api.offer(page), 'started');
                assert.ok(f.api.snapshot().pages[0].payloads.some((payload: any) => payload.arrivalCovered));
            } else { f.api.setVisibleWork([work([page], ['preparing'])]); }
            const before = f.api.snapshot();
            assert.ok(before.activeActors > 0 && before.retainedBytes > 0);
            assert.strictEqual(f.callbacks.size, 1, 'an owned animation frame is pending');
            const pending = [...f.callbacks.values()];
            const bitmaps = f.owned.filter(canvas => canvas.width * canvas.height > 0)
                .map(canvas => ({ canvas, zeroWrites: canvas.zeroWrites }));

            f.media.matches = true;
            f.frame();
            const cancelled = f.api.snapshot();
            assert.strictEqual(cancelled.activeActors, 0, 'the observed policy releases moving actors before event delivery');
            assert.strictEqual(cancelled.activeEpisodes, 0);
            assert.strictEqual(cancelled.retainedBytes, 0);
            assert.strictEqual(cancelled.scheduled, false);
            assert.strictEqual(f.callbacks.size, 0);
            assert.ok(bitmaps.every(({ canvas, zeroWrites }) => canvas.width * canvas.height === 0
                && canvas.zeroWrites === zeroWrites + 1), 'every retained raster and sprite is released once');
            assert.deepStrictEqual([...returned].sort(), [...reserved].sort());
            assert.strictEqual(held.size, 0);
            const statusText = () => sceneNodes(f.container).filter(node => node.className === 'pdfDocumentRobotWorkStatus'
                && node.style.opacity === '1').map(node => node.children.find(child => child.attributes.get('aria-hidden') !== 'true')!.textContent);
            if (activity === 'waiting') {
                assert.ok(statusText().some(text => text.includes('Preparing page 88')), 'static preparation status survives cancellation');
                assert.strictEqual(f.api.hasHandled(99), false);
            }
            const text = statusText();
            f.media.emit('change');
            for (const callback of pending) { callback(f.now + 10000); }
            const settled = f.api.snapshot();
            assert.strictEqual(settled.cancelledEpisodes, cancelled.cancelledEpisodes);
            assert.strictEqual(settled.retainedBytes, 0);
            assert.deepStrictEqual([...returned].sort(), [...reserved].sort());
            assert.ok(bitmaps.every(({ canvas, zeroWrites }) => canvas.zeroWrites === zeroWrites + 1));
            assert.deepStrictEqual(statusText(), text);
            f.frame();
            assert.strictEqual(f.api.snapshot().frames, settled.frames, 'the later event and stale frame leave no animation loop');
            assert.strictEqual(f.callbacks.size + f.timers.size, 0);
        });
    }

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
            const context = original.call(this);
            if (context && f.owned.includes(this)) {
                context.clearRect = () => { throw new Error('artwork raster unavailable'); };
            }
            return context;
        };
        try { assert.strictEqual(f.api.deliver(page), false); }
        finally { Canvas.prototype.getContext = original; }
        assert.ok(lab.snapshot().actors.every((actor: any) => !actor.outside));
        assert.strictEqual(f.api.snapshot().retainedBytes, 0);
        assert.strictEqual(f.callbacks.size, 0);
        assert.ok(f.owned.every(canvas => canvas.width * canvas.height === 0));
    });
    for (const maxActors of [1, 4]) {
        it(`shows reachable authored dialogue during ordinary ${maxActors === 1 ? 'solo' : 'multi-photo'} work without requiring a rare incident`, () => {
            const f = fixture({ seed: 10, maxActors, encounterRandom: () => 0.99 }); f.desktop();
            const displayed = new Set<string>(); let admitted = 0;
            for (let number = 1; number <= 12; number++) {
                const page = f.page(number); page.canvas.width = 135; page.canvas.height = 192;
                const regions = maxActors === 1 ? [{ id: 'photo-' + number, x: 0.1, y: 0.2, width: 0.2, height: 0.15 }]
                    : [0.05, 0.55].map((x, index) => ({ id: 'photo-' + number + '-' + index, x, y: index ? 0.55 : 0.1, width: 0.4, height: 0.3 }));
                f.api.setVisiblePages([number]);
                if (f.api.offer({ ...page, kind: 'preview', imageRegions: regions }) === 'started') { admitted++; }
                for (let frame = 0; frame < 160; frame++) {
                    f.frame();
                    for (const bubble of captions(f)) {
                        if (bubble.isConnected && bubble.style.opacity === '1' && bubble.textContent.trim()) {
                            displayed.add(bubble.textContent.replace(/^[^:]+: /gm, ''));
                        }
                    }
                }
            }
            assert.ok(admitted >= 8, 'the scenario must actually perform ordinary photo work: admitted=' + admitted);
            assert.ok(displayed.size >= 4, 'ordinary reading must expose multiple authored meanings, not merely a large unreachable catalogue: ' + JSON.stringify([...displayed]));
        });
    }

    it('uses the authored work repertoire in actual loaded-attention captions rather than one carrying fallback', () => {
        const f = fixture({ seed: 10, maxActors: 1, encounterRandom: () => 0.99 }); f.desktop();
        const shown: string[] = [];
        for (let number = 1; number <= 10; number++) {
            const page = f.page(number); page.canvas.width = 135; page.canvas.height = 192;
            f.api.setVisiblePages([number]);
            assert.strictEqual(f.api.offer({ ...page, kind: 'preview', imageRegions: [{ id: 'attention-' + number, x: 0.1, y: 0.2, width: 0.2, height: 0.15 }] }), 'started');
            for (let frame = 0; frame < 80; frame++) {
                f.frame();
                const snapshot = f.api.snapshot();
                const payload = snapshot.pages.flatMap((value: any) => value.payloads).find((value: any) => value.progress > 0.25 && value.progress < 0.6 && !value.deposited);
                const actor = payload && snapshot.pages.flatMap((value: any) => value.actors).find((value: any) => value.payloadId === payload.id);
                if (!actor) { continue; }
                const sprite = f.owned.find(canvas => canvas.className === 'pdfDocumentRobotVehicle' && canvas.dataset.courier === String(actor.id))!;
                pointer(f, 'pointermove', point(sprite)); f.tick(34);
                const bubble = captions(f).find(node => node.isConnected && node.style.opacity === '1');
                if (bubble) {
                    const evidence = f.api.snapshot();
                    assert.ok(evidence.caption.id.startsWith('hover:'), 'the readable bubble must own the actual attention opportunity');
                    assert.ok(evidence.caption.meaningIds?.length && evidence.caption.shownAt !== undefined);
                    assert.ok(evidence.caption.meaningIds.every((id: string) => evidence.encounters.dialogue.coverage.some((entry: any) => entry.id === id && entry.count > 0)));
                    shown.push(bubble.textContent.replace(/^[^:]+: /gm, ''));
                }
                pointer(f, 'pointerleave', point(sprite));
                break;
            }
            for (let frame = 0; frame < 180; frame++) { f.frame(); }
        }
        assert.ok(shown.length >= 8, 'actual loaded attention must be readable in the scenario: ' + JSON.stringify(shown));
        assert.ok(new Set(shown).size >= 4, 'ordinary attention must reach authored meanings: ' + JSON.stringify(shown));
        assert.ok(shown.filter(line => line === 'Nosim fotografiju.').length <= shown.length / 4,
            'one generic carrying status must not dominate the employed work repertoire');
    });

    it('admits authored completion only after actual deposit and new-book lines only during retirement', () => {
        const f = fixture({ seed: 10, encounterRandom: () => 0.99 }); f.desktop();
        const page = f.page(101);
        let completion = false, carrySeen = false, depositDuringRead = false;
        for (let number = 99; number <= 100; number++) {
            const page = number === 99 ? f.page(99) : f.page(100); f.api.setVisiblePages([number]);
            f.api.offer({ ...page, kind: 'preview', imageRegions: [{ id: 'semantic-photo', x: 0.1, y: 0.2, width: 0.2, height: 0.15 }] });
            let deposited = false;
            let carrying: { node: Element; until: number } | undefined;
            for (let index = 0; index < 180; index++) {
                f.frame(); const snapshot = f.api.snapshot();
                if (!carrying && snapshot.caption?.opportunity === 'carrying' && snapshot.caption.shownAt !== undefined) {
                    carrySeen = true;
                    carrying = { node: captions(f).find(node => node.isConnected && node.style.opacity === '1')!, until: snapshot.caption.until };
                }
                if (carrying && f.now < carrying.until) { assert.ok(carrying.node.isConnected && carrying.node.style.opacity === '1', 'readable carry text survives real deposit until its owned deadline'); }
                deposited ||= snapshot.pages.some((value: any) => value.payloads.some((payload: any) => payload.deposited));
                if (deposited && carrying && f.now < carrying.until) { depositDuringRead = true; }
                if (snapshot.caption?.id.endsWith(':deposit') && snapshot.caption.shownAt !== undefined) {
                    assert.ok(deposited, 'completion wording follows actual deposited pixels'); completion = true;
                }
                assert.ok(!snapshot.caption?.id.endsWith(':new-book'));
            }
        }
        assert.ok(carrySeen && depositDuringRead, 'the actual deposit crosses an already readable carrying interval');
        assert.ok(completion, 'ordinary actual deposit reaches authored completion without a rare incident');
        f.api.retireDocument([page], 'semantic-new-edition');
        let retirement = false;
        for (let index = 0; index < 180; index++) {
            f.frame(); const snapshot = f.api.snapshot();
            if (snapshot.caption?.id.endsWith(':new-book') && snapshot.caption.shownAt !== undefined) { retirement = true; }
        }
        assert.ok(retirement, 'actual new-edition retirement reaches its authored repertoire');
    });

    it('keeps one readable authored cue while actual cargo obstacles move and leave at unchanged viewport metrics', () => {
        const f = fixture({ seed: 11, maxActors: 12, encounterRandom: () => 0.99 }); f.desktop(1, 400, 400);
        f.document.captionHeight = 300;
        const photo = f.page(1); photo.pageElement.rect = { left: 0, top: 32, width: 400, height: 360 };
        photo.canvas.width = 135; photo.canvas.height = 192;
        f.api.setVisiblePages([1]);
        assert.strictEqual(f.api.offer({ ...photo, kind: 'preview', imageRegions: [{ id: 'moving-obstacle', x: 0, y: 0, width: 1, height: 1 }] }), 'started');
        let bubble: Element | undefined, evidence: any, payloadId: number | undefined, sprite: Canvas | undefined;
        for (let frame = 0; frame < 65 && !bubble; frame++) {
            f.frame(); const snapshot = f.api.snapshot();
            const payload = snapshot.pages.flatMap((page: any) => page.payloads).find((payload: any) => payload.progress > 0.5 && payload.progress < 0.65 && !payload.deposited);
            const actor = payload && snapshot.pages.flatMap((page: any) => page.actors).find((actor: any) => actor.payloadId === payload.id);
            if (!actor) { continue; }
            sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id) && canvas.className === 'pdfDocumentRobotVehicle')!;
            pointer(f, 'pointermove', point(sprite)); f.frame();
            bubble = captions(f).find(node => node.isConnected && node.style.opacity === '1');
            if (bubble) { evidence = f.api.snapshot(); payloadId = payload.id; }
        }
        assert.ok(bubble && evidence.caption?.shownAt !== undefined, 'the actual loaded actor owns a readable authored cue');
        const cargo = f.owned.find(canvas => canvas.dataset.payload === String(payloadId) && canvas.className === 'pdfDocumentRobotCargo')!;
        assert.ok(cargo.isConnected && cargo.width > 0);
        const initialTransform = cargo.style.transform, placements = new Set<string>();
        const initialCounts = evidence.encounters.dialogue.coverage;
        for (let frame = 0; frame < 65 && cargo.width > 0; frame++) {
            if (sprite?.isConnected) { pointer(f, 'pointermove', point(sprite)); }
            f.frame(); const snapshot = f.api.snapshot();
            assert.ok(bubble.isConnected && bubble.style.opacity === '1');
            assert.strictEqual(snapshot.caption.id, evidence.caption.id);
            assert.deepStrictEqual(snapshot.caption.meaningIds, evidence.caption.meaningIds);
            assert.strictEqual(snapshot.caption.until, evidence.caption.until);
            if (snapshot.caption.placement) { placements.add(snapshot.caption.placement.x + ':' + snapshot.caption.placement.y); }
        }
        assert.notStrictEqual(cargo.style.transform, initialTransform, 'the real obstacle moved before actual deposit');
        assert.strictEqual(cargo.width * cargo.height, 0, 'actual deposit removes its copied photo obstacle');
        assert.ok(placements.size > 1, 'the real solver repositions the same readable cue as geometry changes');
        assert.deepStrictEqual(f.api.snapshot().encounters.dialogue.coverage, initialCounts, 'motion/obstacle removal cannot count another authored exposure');
        assert.strictEqual(f.api.snapshot().encounters.dialogue.blocked, 0, 'soft obstacles never enter intrinsic text-fit rejection history');
        f.finish(); f.tick(Math.max(0, evidence.caption.until - f.now) + 1);
        assert.strictEqual(f.callbacks.size + f.timers.size, 0);
    });

    for (const staged of [false, true]) {
        it(`funds real compact DPR3 photo quality together with ${staged ? 'unchanged staged' : 'fresh'} live delivery sprites`, () => {
            const f = fixture({ maxActors: 4, device: 'mobile', encounterRandom: () => 0.99 });
            Object.assign(f.window, { devicePixelRatio: 3, innerWidth: 414, innerHeight: 896 });
            f.container.rect = { left: 0, top: 32, width: 414, height: 864 };
            const leased = new Set<string>();
            const origin = { x: 200, y: 130, scale: 0.64 };
            f.api.setDispatchOrigin({ reserve(vehicle: string) {
                if (!['quad', 'tiltwing'].includes(vehicle) || leased.has(vehicle)) { return; }
                leased.add(vehicle); return origin;
            }, destination: () => origin, release(vehicle: string) { assert.ok(leased.delete(vehicle)); } });
            const p = publication(f); p.page.pageElement.rect = { left: 7.5, top: 100, width: 399, height: 566 };
            p.encounter.pageProjection = { content: { x: 0, y: 0, width: 399, height: 566 }, clip: { x: 0, y: 0, width: 399, height: 566 } };
            p.candidate.canvas.width = 135; p.candidate.canvas.height = 192;
            p.candidate.projection = { width: 135, height: 192, pageToRaster: [135, 0, 0, 192, 0, 0] };
            p.encounter.imageRegions = [0, 1, 2].map(index => ({ id: 'compact-photo-' + index, resourceId: 'x' + (5 + index),
                x: index === 1 ? .12179443341006087 : .5081779361128561,
                y: index === 0 ? .6572468658656471 : .34033928353341597, width: .3695460698597801, height: .14647176372281367 }));
            let stagedIds: number[] = [];
            if (staged) {
                f.api.setVisibleWork([work([p.page])]); f.finish();
                stagedIds = f.api.snapshot().advance.flatMap((value: any) => value.actors.map((actor: any) => actor.id));
                assert.ok(stagedIds.length > 0);
            }
            f.api.setVisiblePages([p.page.pageNumber]); f.api.preparePublication(p.candidate, p.encounter).commit(); f.tick(300);
            const before = f.api.snapshot();
            assert.strictEqual(before.maxSpriteBytes, 204800); assert.strictEqual(before.maxCargoBytes, 524288);
            assert.ok(before.activeActors > 0 && before.activeActors < 4, 'real delivery leaves an actor for quality');
            assert.ok(before.pages.some((page: any) => page.payloads.some((payload: any) => payload.rasterWidth > 0)));
            if (staged) { assert.ok(before.pages.flatMap((page: any) => page.actors).some((actor: any) => stagedIds.includes(actor.id)), 'staged body identity is reused: ' + JSON.stringify({ stagedIds, actors: before.pages.flatMap((page: any) => page.actors).map((actor: any) => ({ id: actor.id, vehicle: actor.vehicle })) })); }
            const payloads = before.pages.flatMap((page: any) => page.payloads).map((payload: any) => ({ id: payload.id, deadline: payload.deadline, helpers: payload.helpers }));
            const next = finalPublication(p);
            next.coverage.resources = [0, 1, 2].map(index => ({ objectId: 'compact-object-' + index, imageId: 'x' + (5 + index), covered: true, final: true, failed: false }));
            const transaction = f.api.preparePublication(next, p.encounter, p.candidate);
            p.candidate.canvas.replaceWith(next.canvas); transaction.commit();
            const began = f.api.snapshot();
            assert.strictEqual(began.qualityReactions.length, 1, 'feasible joint allocation: ' + JSON.stringify({ beforeActors: before.activeActors,
                beforeSpriteBytes: before.spriteBytes, cap: before.maxSpriteBytes, actors: before.pages.flatMap((page: any) => page.actors).map((actor: any) => ({ id: actor.id, vehicle: actor.vehicle, density: actor.spriteDensity })), decisions: began.qualityDecisions.history }));
            assert.ok(began.spriteBytes <= began.maxSpriteBytes && began.activeActors <= 4);
            for (const retained of payloads) {
                const current = began.pages.flatMap((page: any) => page.payloads).find((payload: any) => payload.id === retained.id);
                assert.ok(current); assert.strictEqual(current.deadline, retained.deadline); assert.deepStrictEqual(current.helpers, retained.helpers);
            }
            const id = began.qualityReactions[0].id;
            assert.strictEqual(began.qualityReactions[0].spriteBytes, 30184, 'the measured compact cleaner keeps its full natural DPR backing');
            for (const actor of began.pages.flatMap((page: any) => page.actors)) {
                const sprite = f.owned.find(canvas => canvas.dataset.courier === String(actor.id))!;
                const detail = Math.min(1, Math.max(actor.spriteScale, origin.scale) * 3);
                assert.ok(sprite.width >= Math.ceil(module.ROBOT_ARTWORK_SIZE.width * detail)
                    && sprite.height >= Math.ceil(module.ROBOT_ARTWORK_SIZE.height * detail), 'crew artwork retains the existing minimum detail');
            }
            const actualSpriteBytes = f.owned.filter(canvas => canvas.isConnected && (canvas.className === 'pdfDocumentRobotVehicle' || canvas.className === 'pdfDocumentRobotQualityCleaner'))
                .reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0);
            assert.strictEqual(began.spriteBytes, actualSpriteBytes, 'accounting charges actual rounded sprite allocations');
            f.finish(); const done = f.api.snapshot();
            assert.strictEqual(done.qualityOutcomes.find((value: any) => value.id === id).outcome, 'completed');
            assert.strictEqual(done.activeActors + done.retainedBytes, 0); assert.strictEqual(f.callbacks.size, 0); assert.strictEqual(leased.size, 0);
        });
    }

    it('retires a failed existing redraw once and preserves an unrelated live owner during late quality rebalancing', () => {
        const f = fixture({ device: 'mobile', maxActors: 4, encounterRandom: () => .99 });
        Object.assign(f.window, { devicePixelRatio: 3, innerWidth: 414, innerHeight: 896 });
        f.container.rect = { left: 0, top: 32, width: 414, height: 864 };
        const held = new Map<string, number>(), released: number[] = []; let leaseSerial = 0;
        const origin = (vehicle: string) => ({ x: 200, y: 130, scale: vehicle === 'quad' ? .5 : .6 });
        f.api.setDispatchOrigin({ reserve(vehicle: string) {
            if (!['quad', 'tiltwing'].includes(vehicle) || held.has(vehicle) || !held.size && vehicle !== 'quad') { return; }
            held.set(vehicle, ++leaseSerial); return origin(vehicle);
        }, destination: origin, release(vehicle: string) { const lease = held.get(vehicle); assert.ok(lease); assert.ok(held.delete(vehicle)); released.push(lease); } });
        const p = publication(f), other = f.page(2);
        p.page.pageElement.rect = other.pageElement.rect = { left: 7.5, top: 100, width: 399, height: 566 };
        p.encounter.pageProjection = { content: { x: 0, y: 0, width: 399, height: 566 }, clip: { x: 0, y: 0, width: 399, height: 566 } };
        p.encounter.imageRegions = [{ id: 'photo', resourceId: 'x5', x: .1, y: .1, width: .2, height: .15 }];
        for (const canvas of [p.candidate.canvas, other.canvas]) { canvas.width = 135; canvas.height = 192; }
        p.candidate.projection = { width: 135, height: 192, pageToRaster: [135, 0, 0, 192, 0, 0] };
        f.api.setVisiblePages([1, 2]);
        assert.strictEqual(f.api.offer({ ...p.page, kind: 'preview', imageRegions: p.encounter.imageRegions }), 'started');
        assert.strictEqual(f.api.offer({ ...other, kind: 'preview', imageRegions: [{ id: 'other-photo', x: .1, y: .1, width: .2, height: .15 }] }), 'started');
        f.tick(300); const before = f.api.snapshot();
        assert.strictEqual(before.activeActors, 2); assert.strictEqual(before.qualityDecisions.pending, 0);
        const failedActor = before.pages.find((page: any) => page.page === 1).actors[0], failedId = failedActor.id;
        const failedLease = held.get(failedActor.vehicle);
        const healthy = before.pages.find((page: any) => page.page === 2), healthyPayload = healthy.payloads[0];
        const healthyLease = held.get(healthy.actors[0].vehicle);
        const failed = f.owned.find(canvas => canvas.dataset.courier === String(failedId))!;
        const kept = f.owned.find(canvas => canvas.dataset.courier === String(healthy.actors[0].id))!;
        assert.ok(failed.getContext('2d'), 'the existing body passes the context precheck');
        failed.context.clearRect = () => { throw new Error('intentional existing body redraw failure'); };
        const next = finalPublication(p), transaction = f.api.preparePublication(next, p.encounter, p.candidate);
        p.candidate.canvas.replaceWith(next.canvas); transaction.commit();
        const after = f.api.snapshot(), retained = after.pages.find((page: any) => page.page === 2);
        assert.ok(kept.isConnected && kept.width > 0 && kept.height > 0, 'later healthy body is redrawn despite the earlier failure');
        assert.ok(retained); assert.strictEqual(retained.payloads[0].id, healthyPayload.id);
        assert.strictEqual(retained.payloads[0].deadline, healthyPayload.deadline);
        assert.deepStrictEqual(retained.payloads[0].helpers, healthyPayload.helpers);
        assert.strictEqual(failed.isConnected, false); assert.strictEqual(failed.width * failed.height, 0);
        assert.strictEqual(released.filter(lease => lease === failedLease).length, 1);
        assert.strictEqual(held.get(healthy.actors[0].vehicle), healthyLease);
        assert.ok(after.pages.flatMap((page: any) => page.actors).every((actor: any) => actor.id !== failedId));
        assert.strictEqual(held.size, after.activeActors, 'any newly admitted owner has its own actual lease');
        assert.strictEqual(after.spriteBytes, f.owned.filter(canvas => canvas.isConnected && canvas.className === 'pdfDocumentRobotVehicle')
            .reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0));
        assert.strictEqual(after.qualityReactions.length, 0);
        assert.ok(after.qualityDecisions.history.some((decision: any) => decision.reason === 'allocation-failed'));
        f.finish(); assert.strictEqual(f.api.snapshot().retainedBytes, 0); assert.strictEqual(held.size, 0);
    });

});
