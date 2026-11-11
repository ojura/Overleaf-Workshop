import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

class RobotEvents {
    readonly listeners = new Map<string, Set<() => void>>();
    addEventListener(name: string, listener: () => void) {
        if (!this.listeners.has(name)) { this.listeners.set(name, new Set()); }
        this.listeners.get(name)!.add(listener);
    }
    removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
    emit(name: string) { for (const listener of this.listeners.get(name) ?? []) { listener(); } }
    get count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

class RobotElement {
    private rasterWidth = 0;
    private rasterHeight = 0;
    rasterWrites = 0;
    get width() { return this.rasterWidth; }
    set width(value: number) { this.rasterWidth = value; this.rasterWrites++; this.ownerDocument.trackRaster?.(); }
    get height() { return this.rasterHeight; }
    set height(value: number) { this.rasterHeight = value; this.rasterWrites++; this.ownerDocument.trackRaster?.(); }
    className = '';
    textContent = '';
    readonly dataset: Record<string, string> = {};
    styleWrites = 0;
    readonly style = new Proxy({} as Record<string, string>, {
        set: (target, key: string, value: string) => { this.styleWrites++; target[key] = value; return true; },
    });
    readonly children: RobotElement[] = [];
    readonly attributes = new Map<string, string>();
    rect = { left: 0, top: 0, width: 480, height: 250 };
    rectReads = 0;
    isConnected = true;
    readonly texts: Array<{ text: string; x: number; y: number; font: string; color: string }> = [];
    readonly scales: number[][] = [];
    readonly context = new Proxy({ fillText: (text: string, x: number, y: number) => {
        this.texts.push({ text, x, y, font: this.context.font, color: this.context.fillStyle });
    }, scale: (...values: number[]) => this.scales.push(values) } as Record<string, any>, {
        get(target, key: string) {
            if (key in target) { return target[key]; }
            if (key === 'createLinearGradient' || key === 'createRadialGradient') { return () => ({ addColorStop() {} }); }
            return () => {};
        },
        set(target, key: string, value) { target[key] = value; return true; },
    });
    constructor(readonly ownerDocument: any) {}
    getContext() { return this.context; }
    getBoundingClientRect() { this.rectReads++; return { ...this.rect }; }
    parent?: RobotElement;
    append(...elements: RobotElement[]) {
        for (const element of elements) { element.parent = this; this.children.push(element); }
    }
    remove() {
        if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; }
    }
    replaceChildren(...elements: RobotElement[]) { this.children.splice(0, this.children.length, ...elements); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}

class RobotRuntime {
    now = 0;
    peakRasterBytes = 0;
    readonly callbacks = new Map<number, (at: number) => void>();
    readonly canvases: RobotElement[] = [];
    readonly observers: Array<{ kind: string, callback: (entries: any[]) => void, disconnected: boolean, targets: unknown[] }> = [];
    readonly window = new RobotEvents() as RobotEvents & Record<string, any>;
    readonly document = new RobotEvents() as RobotEvents & Record<string, any>;
    readonly media = new RobotEvents() as RobotEvents & { matches: boolean };
    readonly queries = new Map<string, RobotEvents & { matches: boolean }>();
    readonly visualViewport = new RobotEvents();
    readonly canvasStyle = { objectFit: 'contain', objectPosition: '50% 50%' };
    styleReads = 0;
    readonly stage: RobotElement;
    readonly lab: any;
    private frameId = 0;
    constructor(module: any, reduced = false, seed = 13) {
        this.media.matches = reduced;
        const runtime = this;
        Object.assign(this.window, {
            devicePixelRatio: 1,
            visualViewport: this.visualViewport,
            getComputedStyle: () => { this.styleReads++; return this.canvasStyle; },
            performance: { now: () => this.now },
            crypto: { getRandomValues: (values: Uint32Array) => { values[0] = seed; return values; } },
            matchMedia: (query: string) => {
                if (query === '(prefers-reduced-motion: reduce)') { return this.media; }
                if (!this.queries.has(query)) { this.queries.set(query, Object.assign(new RobotEvents(), { matches: true })); }
                return this.queries.get(query)!;
            },
            requestAnimationFrame: (callback: (at: number) => void) => { this.callbacks.set(++this.frameId, callback); return this.frameId; },
            cancelAnimationFrame: (id: number) => this.callbacks.delete(id),
            ['IntersectionObserver']: class {
                readonly state;
                constructor(callback: (entries: any[]) => void) {
                    this.state = { kind: 'intersection', callback, disconnected: false, targets: [] as unknown[] };
                    runtime.observers.push(this.state);
                }
                observe(target: unknown) { this.state.targets.push(target); }
                disconnect() { this.state.disconnected = true; }
            },
            ['ResizeObserver']: class {
                readonly state;
                constructor(callback: (entries: any[]) => void) {
                    this.state = { kind: 'resize', callback, disconnected: false, targets: [] as unknown[] };
                    runtime.observers.push(this.state);
                }
                observe(target: unknown) { this.state.targets.push(target); }
                disconnect() { this.state.disconnected = true; }
            },
        });
        Object.assign(this.document, {
            hidden: false, defaultView: this.window,
            trackRaster: () => { this.peakRasterBytes = Math.max(this.peakRasterBytes,
                this.canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0)); },
            createElement: (tag: string) => {
                const element = new RobotElement(this.document);
                if (tag === 'canvas') { this.canvases.push(element); }
                return element;
            },
        });
        this.stage = new RobotElement(this.document);
        this.lab = module.installPrefetchRobots(this.stage);
    }
    frame() {
        this.now += 1000 / 30;
        const pending = [...this.callbacks.values()];
        this.callbacks.clear();
        for (const callback of pending) { callback(this.now); }
    }
    tick(milliseconds: number) { this.now += milliseconds; }
    resize() {
        for (const observer of this.observers) {
            if (observer.kind === 'resize' && !observer.disconnected) { observer.callback([]); }
        }
    }
    dispose() {
        this.lab.dispose();
        assert.strictEqual(this.callbacks.size, 0);
        assert.strictEqual(this.document.count + this.media.count + this.window.count + this.visualViewport.count
            + [...this.queries.values()].reduce((sum, query) => sum + query.count, 0), 0);
        assert.ok(this.observers.every(observer => observer.disconnected));
        assert.ok(this.canvases.every(canvas => canvas.width * canvas.height === 0));
    }
}


describe('the procedural PDF robot fleet', function () {
    this.timeout(30 * 1000);
    let dir: string;
    let robots: any;
    const ready = { starved: false, visibleMissing: [], safetySeconds: 1.5, pending: [], visible: [12], performance: { events: [] } };
    const outage = { ...ready, starved: true, visibleMissing: [12], safetySeconds: -0.4, pending: [12, 13] };

    function startOutage(fleet: any, at = 0, input = outage): any {
        fleet.step(at, input);
        return fleet.step(at + robots.ROBOT_LIMITS.outageConfirmMs + 1, input);
    }

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-robots-'));
        try {
            await esbuild.build({
                ...bundleOptions,
                entryPoints: [path.join(viewerRoot, 'src', 'common', 'prefetch-robots.ts')],
                outfile: path.join(dir, 'robots.mjs'),
            });
            robots = await importModule(path.join(dir, 'robots.mjs'));
        } finally {
            await esbuild.stop();
        }
    });

    after(() => {
        if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    });


    it('reserves the complete caption domain before animation and keeps full activity values in stable rows', () => {
        const runtime = new RobotRuntime(robots);
        try {
            const caption = runtime.stage.children.find(node => node.className === 'robot-caption')!;
            const content = caption.children[0];
            assert.ok(content, 'automatic captions reserve geometry before the first frame');
            const reservations = content.children.filter(node => node.attributes.get('aria-hidden') === 'true');
            assert.deepStrictEqual(reservations.map(node => node.textContent), [...new Set(robots.ROBOT_CAPTION_VARIANTS)]);
            const nodes = [...content.children];
            const activity = runtime.stage.children.find(node => node.className === 'robot-activity')!;
            const rows = activity.children.find(node => node.className === 'robot-activity-rows')!;
            assert.strictEqual(rows.children.length, 4);
            runtime.lab.update(outage); runtime.lab.setActive(true);
            for (let frame = 0; frame < 100; frame++) { runtime.frame(); }
            assert.deepStrictEqual(content.children, nodes, 'caption transitions retain the original reservation nodes');
            const live = content.children.find(node => node.attributes.get('aria-hidden') !== 'true')!;
            assert.strictEqual(live.textContent, runtime.lab.snapshot().caption);
            const state = runtime.lab.snapshot();
            assert.deepStrictEqual(rows.children.map(row => row.children[1].textContent),
                [state.actors.filter((actor: any) => actor.job === 'delivery').length, state.stats.yields, state.stats.assists, state.stats.replans].map(String));
            for (const row of rows.children) {
                assert.ok(parseInt(row.children[1].style.width) >= String(Number.MAX_VALUE).length);
            }
        } finally { runtime.dispose(); }
    });

    it('stops idle animation frames and ignores unchanged telemetry while the fleet stays visible', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.lab.update(ready);
            runtime.lab.setActive(true);
            const opened = runtime.lab.snapshot();
            assert.strictEqual(opened.renderer.active, true);
            assert.strictEqual(runtime.stage.children.length, 3);
            const caption = runtime.stage.children.find(node => node.className === 'robot-caption')!;
            assert.ok(caption.style.fontSize === '12px' && caption.style.lineHeight === '16px'
                && caption.style.background === '#101c2b' && caption.style.color === '#e8f0fa' && caption.style.opacity === '1');
            assert.strictEqual(caption.style.padding, '3px 6px');
            assert.strictEqual(caption.style.border, '0', 'the scene summary stays a quiet compact block');
            assert.strictEqual(runtime.callbacks.size, 0, 'a parked fleet needs no animation frame');
            const frames = opened.renderer.frames;
            for (let sample = 0; sample < 240; sample++) {
                runtime.tick(250);
                runtime.lab.update({ ...ready, visible: [12], pending: [] });
            }
            assert.strictEqual(runtime.lab.snapshot().renderer.frames, frames, 'identical quarter-second diagnostics do not repaint a settled canvas');
            assert.strictEqual(runtime.callbacks.size, 0);
        } finally { runtime.dispose(); }
    });

    it('shares one stable geometry read across lab paints and multiple courier destinations', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.lab.update(ready); runtime.lab.setActive(true);
            const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
            assert.ok(runtime.lab.dispatch.reserve('quad'));
            assert.ok(runtime.lab.dispatch.reserve('mecanum'));
            const frames = runtime.lab.snapshot().renderer.frames;
            for (let index = 0; index < 30; index++) {
                runtime.document.emit('pointerdown');
                assert.ok(runtime.lab.dispatch.destination('quad'));
                assert.ok(runtime.lab.dispatch.destination('mecanum'));
            }
            assert.strictEqual(runtime.lab.snapshot().renderer.frames, frames + 30);
            assert.strictEqual(canvas.rectReads, 1, 'unchanged paint and dispatch consumers share the measured canvas');
            assert.strictEqual(runtime.styleReads, 1, 'object fitting is not recomputed from DOM styles per actor');
            assert.strictEqual(runtime.callbacks.size, 0, 'geometry reuse does not start an idle frame loop');
        } finally { runtime.dispose(); }
    });

    it('keeps static caption styles out of repeated lab paints', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.lab.update(ready); runtime.lab.setActive(true);
            const caption = runtime.stage.children.find(node => node.className === 'robot-caption')!;
            const writes = caption.styleWrites;
            assert.ok(writes > 0);
            for (let index = 0; index < 30; index++) { runtime.document.emit('pointerdown'); }
            assert.strictEqual(caption.styleWrites, writes, 'stable styling must not invalidate layout before the next geometry read');
        } finally { runtime.dispose(); }
    });

    it('rebuilds sharp fleet and body rasters at the displayed density through one coalesced resize frame', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.lab.update(ready); runtime.lab.setActive(true);
            const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
            assert.ok(runtime.lab.dispatch.reserve('quad'));
            const state = runtime.lab.snapshot();
            const allocations = runtime.canvases.length;
            const initial = { width: canvas.width, height: canvas.height, frames: state.renderer.frames, reads: canvas.rectReads };
            runtime.window.devicePixelRatio = 2;
            for (let index = 0; index < 60; index++) {
                canvas.rect.width = 500 + index * 10; canvas.rect.height = canvas.rect.width * 250 / 480;
                runtime.resize();
            }
            canvas.rect.width = 960; canvas.rect.height = 500; runtime.resize();
            assert.strictEqual(runtime.lab.snapshot().renderer.frames, initial.frames, 'pointer-rate size delivery does not repaint synchronously');
            assert.strictEqual(canvas.rectReads, initial.reads, 'the burst does not measure each intermediate size');
            assert.strictEqual(runtime.callbacks.size, 1, 'one owned frame consumes the final geometry');
            runtime.frame();
            assert.strictEqual(canvas.width, 1920); assert.strictEqual(canvas.height, 1000);
            assert.strictEqual(runtime.lab.snapshot().renderer.frames, initial.frames + 1);
            assert.strictEqual(runtime.callbacks.size, 0, 'a resized parked fleet returns to sleep');
            assert.strictEqual(runtime.canvases.length, allocations, 'backing surfaces are reused');
            assert.ok(runtime.canvases.slice(2).every(body => body.width >= Math.ceil(128 * 4 / Math.sqrt(2))));
            const ownership = (actors: any[]) => actors.map(({ x: _x, y: _y, goal: _goal, ...actor }) => actor);
            assert.deepStrictEqual(ownership(runtime.lab.snapshot().actors), ownership(state.actors),
                'geometry updates preserve actor identity, activity and the external lease');
            for (const actor of runtime.lab.snapshot().actors) {
                const factor = actor.vehicle === 'heavyquad' ? 2.5 : 1;
                const ink = robots.robotArtworkGeometry(actor.vehicle, factor / Math.sqrt(2));
                assert.ok(actor.x + ink.left >= 0 && actor.x + ink.right <= 480);
                assert.ok(actor.y + ink.top >= 0 && actor.y + ink.bottom <= 250);
            }
            const writes = runtime.canvases.map(surface => surface.rasterWrites);
            canvas.rect.left += 70; canvas.rect.top -= 30; runtime.resize(); runtime.frame();
            assert.deepStrictEqual(runtime.canvases.map(surface => surface.rasterWrites), writes, 'position-only changes reuse every backing store');
            canvas.rect.width = 950; canvas.rect.height = 950 * 250 / 480; runtime.resize(); runtime.frame();
            assert.deepStrictEqual(runtime.canvases.map(surface => surface.rasterWrites), writes, 'small shrink oscillations do not rebuild the caches');
        } finally { runtime.dispose(); }
    });

    it('uses the fitted compact image and current DPR for sharpness without allocating the letterbox', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.lab.update(ready); runtime.lab.setActive(true);
            const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
            canvas.rect.width = 960; canvas.rect.height = 86;
            runtime.window.devicePixelRatio = 2;
            runtime.queries.get('(resolution: 1dppx)')!.emit('change'); runtime.frame();
            assert.ok(canvas.width >= 480 * 86 / 250 * 2 && canvas.width < 960,
                'contain fitting uses the actual 165 CSS px image rather than its 960 CSS px element');
            assert.ok(canvas.height >= 86 * 2);
            const densityTwoWidth = canvas.width;
            runtime.window.devicePixelRatio = 4;
            runtime.queries.get('(resolution: 2dppx)')!.emit('change'); runtime.frame();
            assert.ok(canvas.width > densityTwoWidth && canvas.width >= 480 * 86 / 250 * 4,
                'DPR changes rebuild a sharp backing instead of stretching the initial bitmap');
            assert.strictEqual(canvas.width / canvas.height, 480 / 250, 'intrinsic aspect ratio stays equal to the logical scene');
            assert.strictEqual(runtime.callbacks.size, 0);
        } finally { runtime.dispose(); }
    });

    it('shares the MORUS logical scale between actual Lab paint, cached detail and dispatch origins', () => {
        for (const dpr of [1, 3]) {
            const runtime = new RobotRuntime(robots);
            try {
                runtime.window.devicePixelRatio = dpr;
                runtime.lab.update(ready); runtime.lab.setActive(true);
                const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
                const quad = runtime.lab.dispatch.reserve('quad'), morus = runtime.lab.dispatch.reserve('heavyquad');
                assert.ok(quad && morus);
                assert.ok(Math.abs(morus.scale / quad.scale - 2.5) < 1e-10, 'borrowed bodies preserve their actual relative presence');
                assert.ok(canvas.scales.some(value => Math.abs(value[0] - 2.5 / Math.sqrt(dpr)) < 1e-10
                    && value[0] === value[1]), 'actual body painting applies the descriptor factor once');
                const bodies = runtime.lab.snapshot().renderer.raster.bodies;
                const body = bodies.find((value: any) => value.vehicle === 'heavyquad');
                const small = bodies.find((value: any) => value.vehicle === 'quad');
                const requested = Math.sqrt(dpr);
                assert.ok(body.width >= Math.ceil(128 * requested * 2.5 - 1e-8)
                    && body.height >= Math.ceil(100 * requested * 2.5 - 1e-8)
                    && small.width >= Math.ceil(128 * requested - 1e-8),
                'each cache covers its own requested detail despite independent density quantization');
                const actor = runtime.lab.snapshot().actors.find((value: any) => value.vehicle === 'heavyquad');
                const bounds = robots.robotArtworkGeometry('heavyquad', 2.5 / Math.sqrt(dpr));
                assert.ok(actor.x + bounds.left >= 0 && actor.x + bounds.right <= 480);
                assert.ok(actor.y + bounds.top >= 0 && actor.y + bounds.bottom <= 250);
                runtime.lab.dispatch.release('quad'); runtime.lab.dispatch.release('heavyquad');
                assert.strictEqual(runtime.callbacks.size, 0);
            } finally { runtime.dispose(); }
        }
    });

    it('keeps enlarged MORUS goals reachable and finishes edge work at both Lab frame cadences', () => {
        for (const fps of [30, 60]) {
            const fleet = new robots.RobotChoreographer(13);
            fleet.step(0, ready);
            const actor = fleet.actors.find((value: any) => value.vehicle === 'heavyquad');
            for (const other of fleet.actors) { if (other !== actor) { fleet.reserveVehicle(other.vehicle, 0); } }
            fleet.assign(actor, 'scene', [
                { x: -1000, y: -1000, activity: 'signal', holdMs: 200 },
                { x: 1000, y: 1000, activity: 'signal', holdMs: 200 },
            ]);
            const contained = (point: any) => point.x >= 100 && point.x <= 380 && point.y >= 62.5 && point.y <= 160;
            assert.ok(actor.task.steps.every(contained), 'the owned goals use the real body envelope, not unclamped unreachable points');
            let at = 0;
            for (let frame = 0; frame < fps * 40 && fleet.needsAnimation(); frame++) {
                fleet.step(at += 1000 / fps);
                assert.ok(contained(actor), 'every physics step keeps the enlarged body in its stage');
            }
            assert.strictEqual(fleet.needsAnimation(), false);
            fleet.delivery(actor, { kind: 'preview', bytes: 0, page: 2, count: 1 });
            assert.ok(actor.task.steps.every(contained), 'loading and unloading goals use the same envelope');
            for (let frame = 0; frame < fps * 40 && fleet.needsAnimation(); frame++) { fleet.step(at += 1000 / fps); }
            assert.strictEqual(fleet.snapshot().stats.deliveredCargo, 1);
            assert.strictEqual(fleet.needsAnimation(), false);
        }
    });

    it('returns the geometry-adjusted MORUS centre through the same borrowed Lab lease', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.window.devicePixelRatio = 3;
            runtime.lab.update(ready); runtime.lab.setActive(true);
            const origin = runtime.lab.dispatch.reserve('heavyquad'); assert.ok(origin);
            const id = runtime.lab.snapshot().actors.find((actor: any) => actor.vehicle === 'heavyquad').id;
            runtime.window.devicePixelRatio = 1; runtime.resize();
            const destination = runtime.lab.dispatch.destination('heavyquad');
            const actor = runtime.lab.snapshot().actors.find((value: any) => value.id === id);
            assert.strictEqual(destination.x, actor.x, 'the pending geometry update precedes the copied return centre');
            assert.strictEqual(destination.y, actor.y);
            assert.strictEqual(destination.scale, 2.5);
            assert.ok(destination.x <= 380 && destination.y >= 62.5);
            assert.strictEqual(actor.outside, true, 'geometry keeps the original borrowed owner');
            runtime.lab.dispatch.release('heavyquad');
            for (let frame = 0; frame < 600 && runtime.callbacks.size; frame++) { runtime.frame(); }
            assert.strictEqual(runtime.callbacks.size, 0);
        } finally { runtime.dispose(); }
    });

    it('bounds every fleet backing and cache together even during resize replacement, then releases all pixels', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.lab.update(ready); runtime.lab.setActive(true);
            const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
            const budget = 64 * 1024 * 1024;
            for (const [width, height, dpr] of [[8000, 5000, 4], [6400, 3600, 1], [9000, 6000, 3], [480, 250, 1]]) {
                canvas.rect.width = width; canvas.rect.height = height; runtime.window.devicePixelRatio = dpr;
                runtime.resize(); runtime.frame();
                const bytes = runtime.canvases.reduce((sum, surface) => sum + surface.width * surface.height * 4, 0);
                assert.strictEqual(runtime.lab.snapshot().renderer.raster.bytes, bytes, 'telemetry counts the stage, background and every body cache');
                assert.ok(bytes <= budget && runtime.peakRasterBytes <= budget, 'old and new owned backing stores never overlap beyond the joint budget');
                assert.ok(runtime.canvases.every(surface => surface.width <= 8192 && surface.height <= 8192));
            }
            assert.strictEqual(runtime.lab.snapshot().renderer.raster.limited, false);
            runtime.document.hidden = true; runtime.document.emit('visibilitychange');
            const writes = runtime.canvases.map(surface => surface.rasterWrites);
            canvas.rect.width = 1200; canvas.rect.height = 625; runtime.resize();
            assert.strictEqual(runtime.callbacks.size, 0);
            assert.deepStrictEqual(runtime.canvases.map(surface => surface.rasterWrites), writes, 'hidden resize work is deferred');
            runtime.document.hidden = false; runtime.document.emit('visibilitychange');
            assert.ok(canvas.width >= 1200);
            runtime.lab.dispose();
            assert.strictEqual(runtime.lab.snapshot().renderer.raster.bytes, 0);
        } finally { runtime.dispose(); }
    });

    it('invalidates shared geometry for real size, viewport, density and lifecycle changes without polling', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.lab.update(ready); runtime.lab.setActive(true);
            const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
            runtime.lab.dispatch.reserve('quad');
            const point = () => runtime.lab.dispatch.destination('quad');
            const first = point();
            const checkReadOnce = (previous: number) => {
                const result = point();
                assert.deepStrictEqual(point(), result);
                assert.strictEqual(canvas.rectReads, previous + 1);
                runtime.frame();
                assert.strictEqual(canvas.rectReads, previous + 1, 'the deferred paint shares the already-measured geometry');
                assert.strictEqual(runtime.callbacks.size, 0);
                return result;
            };
            let reads = canvas.rectReads;
            canvas.rect.left += 70; canvas.rect.top -= 40;
            runtime.lab.invalidateGeometry();
            assert.strictEqual(canvas.rectReads, reads, 'a panel move invalidates lazily');
            let moved = checkReadOnce(reads);
            assert.strictEqual(moved.x - first.x, 70); assert.strictEqual(moved.y - first.y, -40);

            reads = canvas.rectReads;
            canvas.rect.width = 300; canvas.rect.height = 86;
            runtime.canvasStyle.objectPosition = '25% 75%';
            const resize = runtime.observers.find(observer => observer.kind === 'resize' && observer.targets.includes(canvas))!;
            assert.ok(resize, 'the actual canvas is observed even if the surrounding stage keeps its dimensions');
            resize.callback([{ target: canvas }]);
            moved = checkReadOnce(reads);
            const actor = runtime.lab.snapshot().actors.find((candidate: any) => candidate.vehicle === 'quad');
            assert.ok(Math.abs(moved.x - (canvas.rect.left + (300 - 480 * 86 / 250) / 4 + actor.x * 86 / 250)) < 1e-8);
            assert.ok(Math.abs(moved.y - (canvas.rect.top + actor.y * 86 / 250)) < 1e-8);

            for (const [target, event] of [[runtime.window, 'resize'], [runtime.visualViewport, 'resize'], [runtime.visualViewport, 'scroll']] as const) {
                reads = canvas.rectReads; canvas.rect.left += 5;
                target.emit(event); checkReadOnce(reads);
            }
            reads = canvas.rectReads;
            const oldScale = point().scale;
            const oldDensity = runtime.queries.get('(resolution: 1dppx)')!;
            assert.ok(oldDensity);
            runtime.window.devicePixelRatio = 4; oldDensity.emit('change');
            assert.strictEqual(checkReadOnce(reads).scale, oldScale / 2);
            assert.strictEqual(oldDensity.count, 0, 'the obsolete density query is released');
            assert.strictEqual(runtime.queries.get('(resolution: 4dppx)')!.count, 1);

            reads = canvas.rectReads; runtime.document.hidden = true; runtime.document.emit('visibilitychange');
            canvas.rect.top += 20;
            assert.strictEqual(point(), undefined);
            assert.strictEqual(canvas.rectReads, reads);
            runtime.document.hidden = false; runtime.document.emit('visibilitychange'); checkReadOnce(reads);
            reads = canvas.rectReads; runtime.lab.setActive(false); canvas.rect.left += 20;
            runtime.lab.setActive(true); checkReadOnce(reads);
            const callbacks = runtime.observers.map(observer => observer.callback);
            runtime.lab.dispose();
            reads = canvas.rectReads;
            for (const callback of callbacks) { callback([{ isIntersecting: true, target: canvas }]); }
            oldDensity.emit('change'); runtime.lab.invalidateGeometry();
            assert.strictEqual(canvas.rectReads, reads, 'late observer delivery cannot measure a disposed stage');
            assert.strictEqual(runtime.callbacks.size, 0);
        } finally { runtime.dispose(); }
    });

    it('does not cache an unusable canvas or reserve a courier from a disconnected stage', () => {
        const runtime = new RobotRuntime(robots);
        try {
            const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
            canvas.rect.width = canvas.rect.height = 0;
            runtime.lab.update(ready); runtime.lab.setActive(true);
            assert.strictEqual(runtime.lab.dispatch.reserve('quad'), undefined, 'zero-size placement is not a dispatch origin');
            assert.strictEqual(runtime.callbacks.size, 0);
            canvas.rect = { left: 70, top: 40, width: 480, height: 250 };
            assert.ok(runtime.lab.dispatch.reserve('quad'), 'the first real placement is measured even before a resize observer arrives');
            const placed = runtime.lab.dispatch.destination('quad');
            canvas.isConnected = false;
            assert.strictEqual(runtime.lab.dispatch.destination('quad'), undefined);
            assert.strictEqual(runtime.lab.dispatch.reserve('mecanum'), undefined);
            canvas.rect.left += 30; canvas.isConnected = true;
            assert.strictEqual(runtime.lab.dispatch.destination('quad').x, placed.x + 30, 'reconnection cannot reuse the old viewport position');
            assert.strictEqual(runtime.callbacks.size, 0);
        } finally { runtime.dispose(); }
    });

    it('finishes real deliveries, returns and readable notices before sleeping, then wakes on new work and user events', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.lab.update(ready);
            runtime.lab.setActive(true);
            const events = Array.from({ length: 15 }, (_, index) => ({
                sequence: index + 1, at: 10, type: 'fetch', data: { bytes: 131072 },
            }));
            runtime.tick(10);
            runtime.lab.update({ ...ready, performance: { events } });
            assert.strictEqual(runtime.callbacks.size, 1, 'completed PDF work wakes the crew');
            for (let frame = 0; frame < 6000 && runtime.callbacks.size; frame++) { runtime.frame(); }
            const settled = runtime.lab.snapshot();
            assert.strictEqual(settled.stats.deliveredCargo, 15);
            assert.strictEqual(settled.queuedCargo.length, 0);
            assert.ok(settled.actors.every((actor: any) => actor.job === 'idle' && !actor.carrying && actor.notice === null
                && Math.hypot(actor.x - actor.goal.x, actor.y - actor.goal.y) <= 1 && Math.hypot(actor.vx, actor.vy) <= 2),
            'all return travel, docking and readable notice transitions finish before sleep: ' + JSON.stringify(settled.actors));
            assert.strictEqual(runtime.callbacks.size, 0);
            const frames = settled.renderer.frames;
            for (let sample = 0; sample < 240; sample++) {
                runtime.tick(250);
                runtime.lab.update({ ...ready, performance: { events } });
            }
            assert.strictEqual(runtime.lab.snapshot().renderer.frames, frames);
            runtime.document.emit('pointerdown');
            assert.strictEqual(runtime.lab.snapshot().renderer.frames, frames + 1, 'an input event refreshes the visible settled stage once');
            runtime.resize();
            runtime.frame();
            assert.strictEqual(runtime.lab.snapshot().renderer.frames, frames + 2, 'a resized stage repaints once');
            assert.strictEqual(runtime.callbacks.size, 0);
            runtime.document.hidden = true;
            runtime.document.emit('visibilitychange');
            const next = [...events, { sequence: 16, at: runtime.now, type: 'fetch', data: { bytes: 2048 } }];
            runtime.lab.update({ ...ready, performance: { events: next } });
            assert.strictEqual(runtime.callbacks.size, 0);
            runtime.document.hidden = false;
            runtime.document.emit('visibilitychange');
            assert.strictEqual(runtime.lab.snapshot().stats.acceptedCargo, 16, 'new work observed while hidden is accepted on return');
            assert.strictEqual(runtime.callbacks.size, 1);
            for (let frame = 0; frame < 3000 && runtime.callbacks.size; frame++) { runtime.frame(); }
            assert.strictEqual(runtime.lab.snapshot().stats.deliveredCargo, 16);
            assert.strictEqual(runtime.callbacks.size, 0, JSON.stringify(runtime.lab.snapshot().actors));
        } finally { runtime.dispose(); }
    });

    it('places readable compact labels on one coalesced resize paint without continuing idle frames', () => {
        const runtime = new RobotRuntime(robots);
        try {
            runtime.lab.update(ready); runtime.lab.setActive(true);
            const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
            canvas.texts.length = 0;
            canvas.rect.width = 300; canvas.rect.height = 86;
            const before = runtime.lab.snapshot().renderer.frames;
            runtime.resize();
            runtime.frame();
            const names = new Set(robots.ROBOT_VEHICLES.map((vehicle: any) => vehicle.name));
            const labels = canvas.texts.filter(value => names.has(value.text));
            assert.ok(labels.length > 0 && labels.length <= 3, 'a static compact stage admits no more than three fitting names');
            assert.ok(labels.every(value => Math.abs(parseFloat(value.font.split(' ')[1]) * (86 / 250) - 12) < 1e-8), 'drawing sizes compensate the fitted canvas');
            assert.ok(labels.every(value => value.color === '#e8f0fa'));
            assert.strictEqual(runtime.lab.snapshot().renderer.frames, before + 1);
            assert.strictEqual(runtime.callbacks.size, 0, 'label placement does not need a fade-in animation');
        } finally { runtime.dispose(); }
    });

    it('keeps lab label admission stable at the measured panel size and favors active notices', () => {
        const runtime = new RobotRuntime(robots);
        try {
            const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
            canvas.rect.width = 455.79; canvas.rect.height = 237.38;
            runtime.window.devicePixelRatio = 1.2;
            runtime.lab.update(ready); runtime.lab.setActive(true);
            const names = new Set(robots.ROBOT_VEHICLES.map((vehicle: any) => vehicle.name));
            const shownNames = () => canvas.texts.filter(value => names.has(value.text));
            const initial = shownNames().map(value => value.text).sort();
            assert.ok(initial.length > 0 && initial.length <= 3);
            canvas.texts.length = 0; runtime.resize(); runtime.frame();
            assert.deepStrictEqual(shownNames().map(value => value.text).sort(), initial, 'one deferred resize paint does not rotate ambient names');
            const events = Array.from({ length: 15 }, (_, index) => ({ sequence: index + 1, at: 10, type: 'fetch', data: { bytes: 4096 } }));
            runtime.tick(10); runtime.lab.update({ ...ready, performance: { events } });
            let sawNotice = false;
            for (let frame = 0; frame < 180 && !sawNotice; frame++) {
                canvas.texts.length = 0; runtime.frame();
                const shown = shownNames();
                assert.ok(shown.length <= 3);
                const notices = runtime.lab.snapshot().actors.filter((actor: any) => actor.notice);
                sawNotice = notices.some((actor: any) => shown.some(value => value.text === robots.ROBOT_VEHICLES.find((vehicle: any) => vehicle.id === actor.vehicle).name)
                    && canvas.texts.some(value => value.text === actor.notice));
            }
            assert.ok(sawNotice, 'traffic notices receive a readable slot within the same three-group budget');
        } finally { runtime.dispose(); }
    });

    it('keeps reduced-motion updates event-driven and resumes an observed outage without a permanent frame loop', () => {
        const runtime = new RobotRuntime(robots, true);
        try {
            runtime.lab.update(ready);
            runtime.lab.setActive(true);
            const frames = runtime.lab.snapshot().renderer.frames;
            for (let sample = 0; sample < 8; sample++) {
                runtime.tick(250);
                runtime.lab.update({ ...ready });
            }
            assert.strictEqual(runtime.lab.snapshot().renderer.frames, frames, 'unchanged reduced-motion samples do not repaint');
            runtime.lab.update(outage);
            runtime.tick(robots.ROBOT_LIMITS.outageConfirmMs + 1);
            runtime.lab.update(outage);
            assert.strictEqual(runtime.lab.snapshot().mode, 'outage');
            assert.ok(runtime.lab.snapshot().renderer.frames > frames);
            assert.strictEqual(runtime.callbacks.size, 0, 'reduced motion never starts a physics frame loop');
            runtime.media.matches = false;
            runtime.media.emit('change');
            assert.strictEqual(runtime.callbacks.size, 1, 'returning to full motion resumes a real outage');
            runtime.lab.setActive(false);
            assert.strictEqual(runtime.callbacks.size, 0);
        } finally { runtime.dispose(); }
    });

    it('uses every outage scenario once before settling, without starting another loop', () => {
        const fleet = new robots.RobotChoreographer(42);
        let frame = startOutage(fleet);
        const seen = new Set<string>();
        assert.ok(robots.ROBOT_SCENES.length >= 12);
        while (frame.mode === 'outage') {
            assert.ok(!seen.has(frame.scene), `repeated ${frame.scene} in one outage`);
            seen.add(frame.scene);
            frame = fleet.step(frame.nextTransitionAt + 1, outage);
        }
        assert.strictEqual(seen.size, robots.ROBOT_SCENES.length);
        assert.strictEqual(frame.mode, 'quiet');
        const episode = frame.episode;
        for (const at of [5 * 60 * 1000, 20 * 60 * 1000, 60 * 60 * 1000]) {
            frame = fleet.step(at, outage);
            assert.strictEqual(frame.mode, 'quiet');
            assert.strictEqual(frame.scene, 'waiting');
            assert.strictEqual(frame.episode, episode);
            assert.ok(frame.quietDetails.length <= robots.ROBOT_QUIET_DETAILS.length);
            assert.strictEqual(new Set(frame.quietDetails).size, frame.quietDetails.length);
        }
    });

    it('ends an outage on actual readiness and changes the next opening', () => {
        const fleet = new robots.RobotChoreographer(5);
        const first = startOutage(fleet);
        fleet.step(1000, ready);
        const recovered = fleet.step(1000 + robots.ROBOT_LIMITS.readinessConfirmMs, ready);
        assert.strictEqual(recovered.mode, 'recovery');
        assert.strictEqual(recovered.stats.recoveries, 1);
        assert.strictEqual(fleet.step(recovered.nextTransitionAt + 1, ready).mode, 'dispatch');
        const next = startOutage(fleet, recovered.nextTransitionAt + 2);
        assert.notStrictEqual(next.scene, first.scene);
        assert.strictEqual(next.episode, first.episode + 1);
        fleet.open(20000, outage);
        const reopened = fleet.step(20000 + robots.ROBOT_LIMITS.outageConfirmMs + 1, outage);
        assert.notStrictEqual(reopened.scene, next.scene);
    });

    it('detects missing visible pages even after scrolling has stopped', () => {
        const fleet = new robots.RobotChoreographer(7);
        const sample = { ...outage, safetySeconds: null, velocityPxPerMs: 0 };
        fleet.step(0, sample);
        const frame = fleet.step(robots.ROBOT_LIMITS.outageConfirmMs + 1, sample);
        assert.strictEqual(frame.mode, 'outage');
        assert.strictEqual(frame.missingPage, 12);
    });

    it('ignores a single missing sample and keeps one episode through brief readiness flicker', () => {
        const fleet = new robots.RobotChoreographer(29);
        fleet.step(0, outage);
        assert.strictEqual(fleet.step(220).mode, 'dispatch', 'animation time alone cannot confirm an outage');
        assert.strictEqual(fleet.step(250, ready).mode, 'dispatch');
        const began = startOutage(fleet, 500);
        const episode = began.episode;
        const scene = began.scene;
        for (let at = 1000; at < 3000; at += 250) {
            const frame = fleet.step(at, at % 500 === 0 ? ready : outage);
            assert.strictEqual(frame.mode, 'outage');
            assert.strictEqual(frame.episode, episode);
            assert.strictEqual(frame.scene, scene);
        }
        fleet.step(3000, ready);
        assert.strictEqual(fleet.step(3000 + robots.ROBOT_LIMITS.readinessConfirmMs, ready).mode, 'recovery');
    });

    it('replays the same input and seed deterministically while retaining individual robots', () => {
        const a = new robots.RobotChoreographer(19);
        const b = new robots.RobotChoreographer(19);
        let last: any;
        for (let frame = 0; frame < 900; frame++) {
            const at = frame * 1000 / 30;
            last = a.step(at, frame < 600 ? outage : ready);
            assert.deepStrictEqual(last, b.step(at, frame < 600 ? outage : ready));
        }
        assert.strictEqual(last.actors.length, robots.ROBOT_VEHICLES.length);
        assert.ok(new Set(last.actors.map((actor: any) => actor.temperament)).size > 1);
        assert.ok(last.actors.some((actor: any) => actor.distance > 10));
    });

    it('uses each new completed fetch and page event once as real cargo', () => {
        const fleet = new robots.RobotChoreographer(11);
        fleet.step(0, ready);
        const events = [
            { sequence: 1, at: 10, type: 'fetch', data: { bytes: 1048576, durationMs: 40 } },
            { sequence: 2, at: 10, type: 'preview-ready', data: { page: 13, ms: 80 } },
            { sequence: 3, at: 10, type: 'page-render', data: { page: 12, ms: 50, error: false } },
            { sequence: 4, at: 10, type: 'page-render', data: { page: 14, error: true } },
        ];
        let frame = fleet.step(10, { ...ready, performance: { events } });
        assert.strictEqual(frame.stats.acceptedCargo, 3);
        assert.strictEqual(frame.stats.fetchBytes, 1048576);
        const cargo = [...frame.queuedCargo, ...frame.actors.map((actor: any) => actor.cargo).filter(Boolean)];
        assert.deepStrictEqual(cargo.filter((item: any) => item.page).map((item: any) => item.page).sort(), [12, 13]);
        frame = fleet.step(20, { ...ready, performance: { events } });
        assert.strictEqual(frame.stats.acceptedCargo, 3);
        assert.strictEqual(frame.stats.fetchBytes, 1048576);
        for (let at = 50; at <= 30000; at += 1000 / 30) { frame = fleet.step(at); }
        assert.ok(frame.stats.deliveredCargo >= 3);
    });

    it('paints the structural service while its owner works and clears it after borrowing or completion', () => {
        for (const [vehicle, service, text, otherText] of [
            ['heavyquad', 'refuel', 'Refuelling', 'Charging'], ['quad', 'charge', 'Charging', 'Refuelling'],
        ]) {
            const prototype = robots.RobotChoreographer.prototype;
            const snapshot = prototype.snapshot;
            let fleet: any;
            let runtime: RobotRuntime;
            prototype.snapshot = function (this: any) { fleet = this; return snapshot.call(this); };
            try { runtime = new RobotRuntime(robots); }
            finally { prototype.snapshot = snapshot; }
            try {
                runtime.lab.update(ready); runtime.lab.setActive(true);
                const canvas = runtime.stage.children.find(node => node.className === 'robot-canvas')!;
                const actor = fleet.actors.find((candidate: any) => candidate.vehicle === vehicle);
                const courier = fleet.actors.find((candidate: any) => candidate.vehicle === 'rover');
                for (const other of fleet.actors) { if (other !== actor && other !== courier) { fleet.reserveVehicle(other.vehicle, 0); } }
                Object.assign(actor, { energy: 0.1, x: Math.max(83, -actor.footprint.left), y: 124, vx: 0, vy: 0, idleUntil: 0 });
                fleet.delivery(courier, { kind: 'preview', bytes: 0, page: 2, count: 1 });
                canvas.texts.length = 0;
                runtime.tick(34); runtime.document.emit('pointerdown');
                assert.strictEqual(runtime.lab.snapshot().actors[actor.id].activity, service);
                assert.ok(canvas.texts.some(value => value.text === text), vehicle + ' paints its actual service');
                assert.ok(!canvas.texts.some(value => value.text === otherText));
                canvas.texts.length = 0;
                assert.ok(runtime.lab.dispatch.reserve(vehicle));
                assert.ok(!canvas.texts.some(value => value.text === text), 'a borrowed actor has no local service label');
                runtime.tick(500); canvas.texts.length = 0;
                runtime.lab.dispatch.release(vehicle);
                assert.ok(canvas.texts.some(value => value.text === text), 'return resumes the same service presentation');
                for (let frame = 0; frame < 1800 && runtime.callbacks.size; frame++) { runtime.frame(); }
                assert.strictEqual(runtime.callbacks.size, 0, 'service presentation creates no extra idle frames');
                assert.strictEqual(runtime.lab.snapshot().stats.deliveredCargo, 1);
                assert.notStrictEqual(runtime.lab.snapshot().actors[actor.id].activity, service);
                canvas.texts.length = 0; runtime.document.emit('pointerdown');
                assert.ok(!canvas.texts.some(value => value.text === text), 'the finished service leaves no caption');
                assert.strictEqual(runtime.callbacks.size, 0);
            } finally { runtime.dispose(); }
        }
    });

    it('refuels petrol actors and charges battery actors through their existing finite service owner', () => {
        for (const [vehicle, source, service] of [['heavyquad', 'petrol', 'refuel'], ['quad', 'battery', 'charge']]) {
            const fleet = new robots.RobotChoreographer(13);
            fleet.step(0, ready);
            const actor = fleet.actors.find((candidate: any) => candidate.vehicle === vehicle);
            const courier = fleet.actors.find((candidate: any) => candidate.vehicle === 'rover');
            for (const other of fleet.actors) { if (other !== actor && other !== courier) { fleet.reserveVehicle(other.vehicle, 0); } }
            // Seed the depleted service state, including the old field for the pre-correction control.
            Object.assign(actor, { energy: 0.1, battery: 0.1, x: Math.max(83, -actor.footprint.left), y: 124, vx: 0, vy: 0, idleUntil: 0 });
            fleet.delivery(courier, { kind: 'preview', bytes: 0, page: 2, count: 1 });
            let frame = fleet.step(34);
            assert.strictEqual(frame.actors[actor.id].activity, service, vehicle + ' uses its structural service');
            assert.strictEqual(frame.actors[actor.id].energySource, source);
            assert.strictEqual(frame.actors[actor.id].energyService, service);
            const task = actor.task, energy = frame.actors[actor.id].energy;
            fleet.reserveVehicle(vehicle, 34);
            frame = fleet.step(1034);
            assert.strictEqual(frame.actors[actor.id].energy, energy, 'a borrowed actor keeps its service state frozen');
            fleet.returnVehicle(vehicle, 1034);
            assert.strictEqual(actor.task, task, 'the original owned task resumes');
            for (let at = 1068; at <= 4034; at += 34) { frame = fleet.step(at); }
            assert.ok(frame.actors[actor.id].energy > 0.55, 'the actual service replenishes its energy');
            assert.ok(actor.task !== task, 'service completion releases the original task');
            assert.strictEqual(frame.actors[actor.id].battery, frame.actors[actor.id].energy, 'legacy diagnostics keep a numeric alias');
            assert.strictEqual(frame.actors[actor.id].fuel, source === 'petrol' ? frame.actors[actor.id].energy : null);
            for (let at = 4068; at <= 60000 && fleet.needsAnimation(); at += 34) { frame = fleet.step(at); }
            assert.strictEqual(frame.stats.deliveredCargo, 1);
            assert.strictEqual(fleet.needsAnimation(), false, 'service, delivery and return all settle');
            assert.ok(frame.actors.every((value: any) => Number.isFinite(value.energy) && value.energy >= 0 && value.energy <= 1));
        }
    });

    it('restores the same fuel or battery reserve through actual finite assistance', () => {
        for (const vehicle of ['heavyquad', 'quad']) {
            const fleet = new robots.RobotChoreographer(17);
            fleet.step(0, ready);
            const actor = fleet.actors.find((candidate: any) => candidate.vehicle === vehicle);
            const helper = fleet.actors.find((candidate: any) => candidate.vehicle === 'mecanum');
            for (const other of fleet.actors) { if (other !== actor && other !== helper) { fleet.reserveVehicle(other.vehicle, 0); } }
            fleet.assign(actor, 'scene', [{ x: 200, y: 100, activity: 'stranded', holdMs: Infinity }]);
            Object.assign(actor, { energy: 0.04, battery: 0.04, x: 200, y: 100, needsHelp: true });
            const ids = fleet.snapshot().actors.map((value: any) => value.id);
            let frame = fleet.snapshot();
            for (let at = 34; at <= 30000 && fleet.needsAnimation(); at += 34) { frame = fleet.step(at); }
            assert.strictEqual(frame.stats.assists, 1);
            assert.ok(frame.actors[actor.id].energy >= 0.5, 'assistance replenishes the correct energy store before the return');
            assert.strictEqual(frame.actors[actor.id].energySource, vehicle === 'heavyquad' ? 'petrol' : 'battery');
            assert.strictEqual(frame.actors[actor.id].battery, frame.actors[actor.id].energy);
            assert.strictEqual(frame.actors[actor.id].needsHelp, false);
            assert.deepStrictEqual(frame.actors.map((value: any) => value.id), ids);
            assert.strictEqual(fleet.needsAnimation(), false);
        }
    });

    it('keeps depleted parked fuel and battery actors asleep until actual work arrives', () => {
        const fleet = new robots.RobotChoreographer(13);
        fleet.step(0, ready);
        for (const actor of fleet.actors) { actor.energy = actor.battery = 0.1; actor.idleUntil = 0; }
        for (let at = 250; at <= 60000; at += 250) {
            const frame = fleet.step(at, ready);
            assert.strictEqual(fleet.needsAnimation(), false);
            assert.ok(frame.actors.every((actor: any) => actor.activity === 'park' && actor.job === 'idle'));
            assert.ok(frame.actors.every((actor: any) => actor.energy === 0.1 && actor.battery === actor.energy));
        }
    });

    it('finishes a dock service even when avoidance has displaced an already-arrived courier', () => {
        const fleet = new robots.RobotChoreographer(13);
        fleet.step(0, ready);
        const actor = fleet.actors.find((candidate: any) => candidate.vehicle === 'mecanum');
        fleet.delivery(actor, { kind: 'preview', bytes: 0, page: 2, count: 1 });
        actor.task.index = actor.task.steps.findIndex((target: any) => target.activity === 'unload');
        actor.task.arrivedAt = 500;
        actor.goal = { x: 428, y: 193 };
        actor.x = 462;
        actor.y = 185;
        actor.vx = actor.vy = 0;
        actor.carrying = true;
        actor.activity = 'unload';
        const frame = fleet.step(2000, ready);
        assert.strictEqual(frame.stats.deliveredCargo, 1, 'a completed service cannot wait forever for the old arrival radius');
        assert.strictEqual(frame.actors[actor.id].carrying, false);
    });

    it('finishes a stationary fifteen-parcel burst and clears every courier from the shared dock', () => {
        const events = Array.from({ length: 15 }, (_, index) => ({
            sequence: index + 1, at: 10,
            type: index < 8 ? 'fetch' : index < 13 ? 'preview-ready' : 'page-render',
            data: index < 8 ? { bytes: 131072 } : { page: index - 7 },
        }));
        for (const seed of [11, 13, 42]) {
            const fleet = new robots.RobotChoreographer(seed);
            fleet.step(0, ready);
            let frame = fleet.step(10, { ...ready, performance: { events } });
            for (let at = 50; at <= 120000; at += 1000 / 30) { frame = fleet.step(at); }
            assert.strictEqual(frame.stats.deliveredCargo, 15, 'seed ' + seed + ' must finish its finite stationary backlog');
            assert.strictEqual(frame.queuedCargo.length, 0);
            assert.ok(frame.actors.every((actor: any) => actor.job !== 'delivery'));
        }
    });

    for (const fps of [30, 60]) {
        it('finishes the seed13 fifteen-parcel burst and sleeps at exact ' + fps + ' Hz', () => {
            const fleet = new robots.RobotChoreographer(13);
            fleet.open(0, ready);
            fleet.step(0);
            const events = Array.from({ length: 15 }, (_, index) => ({
                sequence: index + 1, at: 10, type: 'fetch', data: { bytes: 131072 },
            }));
            fleet.update(10, { ...ready, performance: { events } });
            let at = 10, frame = fleet.snapshot();
            for (let count = 0; count < fps * 200 && fleet.needsAnimation(); count++) {
                at += 1000 / fps;
                frame = fleet.step(at);
            }
            assert.strictEqual(frame.stats.deliveredCargo, 15);
            assert.strictEqual(frame.queuedCargo.length, 0);
            const unfinished = frame.actors.filter((actor: any) => actor.job !== 'idle' || actor.carrying || actor.notice !== null
                || Math.hypot(actor.x - actor.goal.x, actor.y - actor.goal.y) > 1 || Math.hypot(actor.vx, actor.vy) > 2);
            assert.strictEqual(unfinished.length, 0, 'finite trips and their notices must settle: ' + JSON.stringify(unfinished));
            assert.strictEqual(fleet.needsAnimation(), false);
            fleet.update(at + 250, { ...ready, performance: { events } });
            assert.strictEqual(fleet.needsAnimation(), false, 'identical telemetry cannot restart the completed burst');
        });
    }

    it('keeps detour right of way through its waypoint and releases it at the trip and lifecycle boundaries', () => {
        const blocked = () => {
            const fleet = new robots.RobotChoreographer(13);
            fleet.open(0, ready); fleet.step(0);
            const actor = fleet.actors.find((candidate: any) => candidate.vehicle === 'mecanum');
            const obstacle = fleet.actors.find((candidate: any) => candidate.vehicle === 'ekokomvoz');
            for (const other of fleet.actors) {
                if (other !== actor && other !== obstacle) { fleet.reserveVehicle(other.vehicle, 0); }
            }
            actor.x = 205; actor.y = 200; actor.patience = 0;
            obstacle.x = 180; obstacle.y = 205;
            fleet.assign(obstacle, 'delivery', [{ x: obstacle.x, y: obstacle.y, activity: 'load', holdMs: Infinity }]);
            obstacle.task.arrivedAt = 0;
            let at = 1000 / 30;
            fleet.step(at);
            assert.ok(actor.detour, 'the blocked return actually selects an avoidance waypoint');
            assert.strictEqual(actor.detourGoal, actor.goal, 'the priority belongs to this underlying trip');
            fleet.reserveVehicle(obstacle.vehicle, at);
            return { fleet, actor, advance() {
                const before = { x: actor.x, y: actor.y };
                at += 1000 / 30; fleet.step(at);
                const vehicle = robots.ROBOT_VEHICLES.find((entry: any) => entry.id === actor.vehicle);
                assert.ok(Math.hypot(actor.x - before.x, actor.y - before.y) <= vehicle.speed * 1.8 / 30 + 1e-8,
                    'right of way preserves bounded physical motion');
            } };
        };
        const returning = blocked();
        for (let index = 0; index < 600 && returning.actor.detour; index++) { returning.advance(); }
        assert.strictEqual(returning.actor.detour, null);
        assert.ok(Math.hypot(returning.actor.x - returning.actor.goal.x, returning.actor.y - returning.actor.goal.y) > 5);
        assert.strictEqual(returning.actor.detourGoal, returning.actor.goal, 'the waypoint cannot surrender priority before the actual destination');
        for (let index = 0; index < 600 && returning.fleet.needsAnimation(); index++) { returning.advance(); }
        assert.strictEqual(returning.fleet.needsAnimation(), false);
        assert.strictEqual(returning.actor.detourGoal, null);
        assert.strictEqual(returning.actor.activity, 'park');
        assert.strictEqual(returning.actor.notice, null);
        for (const change of ['assign', 'release', 'open'] as const) {
            const { fleet, actor } = blocked();
            if (change === 'assign') { fleet.assign(actor, 'idle', [{ x: 300, y: 190, activity: 'inspect', holdMs: 200 }]); }
            else if (change === 'release') { fleet.release(actor); }
            else { fleet.open(100, ready); }
            assert.strictEqual(actor.detour, null, change);
            assert.strictEqual(actor.detourGoal, null, change + ' releases the previous trip priority');
        }
    });

    it('keeps traffic labels readable through brief yield/replan changes while still showing actual trouble', () => {
        const fleet = new robots.RobotChoreographer(13);
        fleet.step(0, ready);
        const events = Array.from({ length: 40 }, (_, index) => ({
            sequence: index + 1, at: 10, type: 'fetch', data: { bytes: 4096 },
        }));
        fleet.step(10, { ...ready, performance: { events } });
        const shown = new Map<number, { label: string | null, since: number }>();
        let labels = 0;
        for (let at = 50; at < 60000; at += 1000 / 30) {
            const frame = fleet.step(at);
            for (const actor of frame.actors) {
                const previous = shown.get(actor.id);
                if (previous && previous.label && previous.label !== actor.notice && actor.notice !== 'SOS') {
                    assert.ok(at - previous.since >= robots.ROBOT_LIMITS.noticeHoldMs - 1,
                        'a shown traffic label should survive long enough to read');
                }
                if (!previous || previous.label !== actor.notice) {
                    shown.set(actor.id, { label: actor.notice, since: at });
                    if (actor.notice) { labels++; }
                }
            }
        }
        assert.ok(labels > 0, 'persistent traffic conditions still produce labels');
        const rescue = new robots.RobotChoreographer(17, { sceneOrder: ['rescue'] });
        const distressed = startOutage(rescue).actors.filter((actor: any) => actor.needsHelp);
        assert.ok(distressed.length > 0);
        assert.ok(distressed.every((actor: any) => actor.notice === 'SOS'), 'a stranded robot announces distress immediately');
    });

    it('publishes distress labels for reduced-motion telemetry updates without physics frames', () => {
        const fleet = new robots.RobotChoreographer(17, { sceneOrder: ['rescue'] });
        fleet.update(0, outage);
        fleet.update(robots.ROBOT_LIMITS.outageConfirmMs + 1, outage);
        const distressed = fleet.snapshot().actors.filter((actor: any) => actor.needsHelp);
        assert.ok(distressed.length > 0);
        assert.ok(distressed.every((actor: any) => actor.notice === 'SOS'));
    });

    it('bounds the delivery queue and actors during a burst while accounting for all bytes', () => {
        const fleet = new robots.RobotChoreographer(13);
        fleet.step(0, ready);
        const events = Array.from({ length: 500 }, (_, index) => ({
            sequence: index + 1, at: 10, type: 'fetch', data: { bytes: 4096, durationMs: 8 },
        }));
        let frame = fleet.step(10, { ...outage, performance: { events } });
        assert.strictEqual(frame.stats.acceptedCargo, 500);
        assert.strictEqual(frame.stats.fetchBytes, 500 * 4096);
        assert.ok(frame.queuedCargo.length <= robots.ROBOT_LIMITS.maxQueuedCargo);
        assert.strictEqual(frame.actors.length, robots.ROBOT_LIMITS.maxActors);
        frame = fleet.step(10 + robots.ROBOT_LIMITS.outageConfirmMs + 1, { ...outage, performance: { events } });
        for (let index = 0; index < 1800; index++) {
            frame = fleet.step(10 + index * 1000 / 30);
            assert.ok(frame.particles.length <= robots.ROBOT_LIMITS.maxParticles);
            for (const actor of frame.actors) {
                for (const value of [actor.x, actor.y, actor.vx, actor.vy, actor.patience, actor.battery]) {
                    assert.ok(Number.isFinite(value));
                }
                const ink = robots.robotArtworkGeometry(actor.vehicle, actor.vehicle === 'heavyquad' ? 2.5 : 1);
                assert.ok(actor.x + ink.left >= 0 && actor.x + ink.right <= robots.ROBOT_LIMITS.width);
                assert.ok(actor.y + ink.top >= 0 && actor.y + ink.bottom <= robots.ROBOT_LIMITS.height);
            }
        }
        assert.ok(frame.stats.yields > 0, 'neighbors change one another\'s motion');
        assert.ok(frame.stats.replans > 0, 'impatient blocked robots choose a detour');
    });

    it('lets an available robot help a stranded neighbor and preserves the robot identities', () => {
        const fleet = new robots.RobotChoreographer(17, { sceneOrder: ['rescue'] });
        let frame = startOutage(fleet);
        const ids = frame.actors.map((actor: any) => actor.id);
        assert.ok(frame.actors.some((actor: any) => actor.needsHelp));
        for (let index = 1; index < 240; index++) { frame = fleet.step(index * 1000 / 30, outage); }
        assert.ok(frame.stats.assists > 0, 'a helper reaches and services the stranded robot');
        assert.deepStrictEqual(frame.actors.map((actor: any) => actor.id), ids);
    });

    it('keeps byte and page cargo distinct when a burst introduces another kind at queue capacity', () => {
        const fleet = new robots.RobotChoreographer(31);
        fleet.step(0, ready);
        const events = [
            { sequence: 1, at: 1, type: 'fetch', data: { bytes: 4096 } },
            ...Array.from({ length: robots.ROBOT_LIMITS.maxQueuedCargo - 1 }, (_, index) => ({
                sequence: index + 2, at: 1, type: 'preview-ready', data: { page: index + 1 },
            })),
            { sequence: robots.ROBOT_LIMITS.maxQueuedCargo + 1, at: 1, type: 'page-render', data: { page: 42 } },
        ];
        const frame = fleet.step(1, { ...ready, performance: { events } });
        const cargo = [...frame.queuedCargo, ...frame.actors.map((actor: any) => actor.cargo).filter(Boolean)];
        assert.strictEqual(cargo.reduce((sum: number, item: any) => sum + item.count, 0), events.length);
        assert.strictEqual(cargo.filter((item: any) => item.kind === 'bytes').reduce((sum: number, item: any) => sum + item.bytes, 0), 4096);
        assert.ok(cargo.some((item: any) => item.kind === 'page' && item.page === 42));
        assert.ok(cargo.filter((item: any) => item.kind !== 'bytes').every((item: any) => item.bytes === 0));
    });

    it('does not replay old deliveries when the performance sequence resets for a new PDF', () => {
        const fleet = new robots.RobotChoreographer(23);
        fleet.step(0, ready);
        fleet.step(10, { ...ready, performance: { events: [
            { sequence: 40, at: 10, type: 'fetch', data: { bytes: 4096 } },
        ] } });
        const frame = fleet.step(20, { ...ready, performance: { events: [
            { sequence: 1, at: 20, type: 'document', data: { pages: 90 } },
            { sequence: 2, at: 20, type: 'fetch', data: { bytes: 2048 } },
        ] } });
        assert.strictEqual(frame.stats.acceptedCargo, 1);
        assert.strictEqual(frame.stats.fetchBytes, 2048);
    });
    it('does not name an unavailable Lab character when the actual scene uses a substitute', () => {
        const fleet = new robots.RobotChoreographer(42, { sceneOrder: ['rescue'] });
        fleet.step(0, outage); assert.ok(fleet.reserveVehicle('heavyquad', 0));
        const frame = fleet.step(robots.ROBOT_LIMITS.outageConfirmMs + 1, outage);
        assert.strictEqual(frame.scene, 'rescue');
        assert.ok(frame.actors.some((actor: any) => actor.vehicle !== 'heavyquad' && !actor.outside && actor.job === 'scene'));
        assert.ok(!frame.caption.includes('MORUS'), 'caption follows real cast rather than the unavailable requested model');
        assert.ok(robots.ROBOT_CAPTION_VARIANTS.includes(frame.caption), 'the substitute title is in the finite reserved domain');
        const exact = new robots.RobotChoreographer(42, { sceneOrder: ['rescue'] }); const original = startOutage(exact);
        assert.ok(original.caption.includes('MORUS'), 'a correctly cast named scene keeps its authored title');
        assert.deepStrictEqual(frame.actors.filter((actor: any) => actor.outside).map((actor: any) => actor.vehicle), ['heavyquad']);
        const reassigned = new robots.RobotChoreographer(42, { sceneOrder: ['rescue'] });
        const cast = startOutage(reassigned);
        for (const actor of cast.actors) { if (actor.vehicle !== 'heavyquad') { reassigned.reserveVehicle(actor.vehicle, cast.at); } }
        const dispatch = reassigned.step(cast.at + 1, { ...outage, performance: { events: [
            { sequence: 1, at: cast.at + 1, type: 'fetch', data: { bytes: 2048, durationMs: 1 } },
        ] } });
        const courier = dispatch.actors.find((actor: any) => actor.vehicle === 'heavyquad');
        assert.strictEqual(courier.job, 'delivery'); assert.strictEqual(courier.outside, false);
        assert.strictEqual(dispatch.stats.acceptedCargo, 1, 'a real completed-fetch event reassigns the original cast member');
        assert.ok(!dispatch.caption.includes('MORUS'), 'a scene actor reassigned to delivery has left the current cast');
        reassigned.release(reassigned.actors.find((actor: any) => actor.vehicle === 'heavyquad'));
        assert.ok(!reassigned.snapshot().caption.includes('MORUS'), 'ending unrelated delivery cannot resume the discarded scene role');
        const borrowed = exact.reserveVehicle('heavyquad', original.at); assert.ok(borrowed);
        assert.ok(!exact.snapshot().caption.includes('MORUS'), 'borrowing the named actor also changes current narration');
        for (const actor of exact.snapshot().actors) { if (!actor.outside) { exact.reserveVehicle(actor.vehicle, original.at); } }
        const unavailable = exact.snapshot();
        assert.ok(robots.ROBOT_CAPTION_VARIANTS.includes(unavailable.caption));
        assert.ok(unavailable.caption.includes('busy elsewhere'), 'an empty scene cannot name or impersonate an absent crew');
    });

});
