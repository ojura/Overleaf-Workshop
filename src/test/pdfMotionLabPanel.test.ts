import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const viewport = { x: 0, y: 0, width: 1000, height: 800 };
const initial = { x: 300, y: 200, width: 340, height: 300 };
const directions = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
type ResizeDirection = typeof directions[number];

describe('Motion Lab panel geometry and controls', function () {
    this.timeout(30_000);
    let directory: string, api: any;

    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-motion-lab-panel-'));
        try {
            await esbuild.build({
                entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/motion-lab-panel.ts')],
                outfile: path.join(directory, 'panel.mjs'), bundle: true, format: 'esm',
                platform: 'node', target: 'es2022', logLevel: 'silent',
            });
        } finally { await esbuild.stop(); }
        api = await importModule(path.join(directory, 'panel.mjs'));
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    function inside(rect: any, view = viewport) {
        assert.ok(rect.x >= view.x && rect.y >= view.y);
        assert.ok(rect.x + rect.width <= view.x + view.width);
        assert.ok(rect.y + rect.height <= view.y + view.height);
        assert.ok(rect.width > 0 && rect.height > 0);
    }

    it('docks on either side without losing the floating rectangle', () => {
        const model = new api.MotionLabPanelGeometry(viewport, initial);
        model.setDock('left');
        assert.deepStrictEqual(model.snapshot(), { dock: 'left', rect: { x: 8, y: 8, width: 340, height: 784 } });
        model.resizeTo(420, 200);
        model.setDock('right');
        assert.deepStrictEqual(model.snapshot(), { dock: 'right', rect: { x: 572, y: 8, width: 420, height: 784 } });
        model.setDock('float');
        assert.deepStrictEqual(model.snapshot(), { dock: 'float', rect: initial });
    });

    it('clamps dragging and resizing, including a viewport smaller than the usual minimum', () => {
        const model = new api.MotionLabPanelGeometry(viewport, initial);
        model.moveTo(-10000, 10000);
        assert.deepStrictEqual(model.snapshot().rect, { x: 8, y: 492, width: 340, height: 300 });
        model.resizeTo(10000, -10000);
        assert.deepStrictEqual(model.snapshot().rect, { x: 8, y: 492, width: 984, height: 160 });
        model.setViewport({ x: 31, y: 27, width: 180, height: 120 });
        assert.deepStrictEqual(model.snapshot().rect, { x: 39, y: 35, width: 164, height: 104 });
        model.setViewport({ x: 5, y: 7, width: 1, height: 1 });
        assert.deepStrictEqual(model.snapshot().rect, { x: 5, y: 7, width: 1, height: 1 });
    });

    it('uses visual viewport offsets and restores the saved size after a temporary viewport contraction', () => {
        const model = new api.MotionLabPanelGeometry(viewport, initial);
        const smaller = { x: 100, y: 80, width: 300, height: 250 };
        model.setViewport(smaller);
        inside(model.snapshot().rect, smaller);
        model.setViewport(viewport);
        assert.deepStrictEqual(model.snapshot().rect, initial);
        model.setDock('right');
        model.setViewport(smaller);
        assert.deepStrictEqual(model.snapshot().rect, { x: 108, y: 88, width: 284, height: 234 });
        model.setViewport(viewport);
        assert.strictEqual(model.snapshot().rect.width, 340);
    });

    it('returns independent snapshots and rejects invalid geometry before changing state', () => {
        const model = new api.MotionLabPanelGeometry(viewport, initial);
        const saved = model.snapshot();
        saved.rect.x = 9999;
        assert.deepStrictEqual(model.snapshot().rect, initial);
        for (const operation of [
            () => model.moveTo(NaN, 20), () => model.resizeTo(200, Infinity),
            () => model.setViewport({ ...viewport, width: 0 }), () => model.setDock('bottom'),
        ]) {
            assert.throws(operation, /Motion Lab/);
            assert.deepStrictEqual(model.snapshot(), { dock: 'float', rect: initial });
        }
    });

    function fixture(onLayout?: (layout: any) => { readyAt: number; isReady?(): boolean } | void, motion = false,
        measureContentHeight?: (width: number) => number | undefined) {
        class Events {
            readonly listeners = new Map<string, Set<(event: any) => void>>();
            addEventListener(name: string, listener: (event: any) => void) {
                if (!this.listeners.has(name)) { this.listeners.set(name, new Set()); }
                this.listeners.get(name)!.add(listener);
            }
            removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
            emit(name: string, event: any = {}) { for (const listener of [...this.listeners.get(name) ?? []]) { listener(event); } }
            count(name?: string) { return name ? this.listeners.get(name)?.size ?? 0 : [...this.listeners.values()].reduce((sum, group) => sum + group.size, 0); }
        }
        const visual = Object.assign(new Events(), { offsetLeft: 10, offsetTop: 20, width: 900, height: 700 });
        const observers: Observer[] = [];
        class Observer {
            disconnected = false;
            constructor(readonly callback: () => void) { observers.push(this); }
            observe() { this.disconnected = false; }
            disconnect() { this.disconnected = true; }
        }
        let now = 0, nextFrame = 0;
        const frames = new Map<number, (at: number) => void>();
        const media = Object.assign(new Events(), { matches: !motion });
        const win: any = Object.assign(new Events(), {
            innerWidth: 1000, innerHeight: 800, visualViewport: visual,
            performance: { now: () => now }, matchMedia: () => media,
            requestAnimationFrame(callback: (at: number) => void) {
                assert.ok(motion, 'reduced-motion controls must not schedule animation frames');
                const id = ++nextFrame; frames.set(id, callback); return id;
            },
            cancelAnimationFrame(id: number) { frames.delete(id); },
            setInterval() { assert.fail('panel controls must not poll'); },
            setTimeout() { assert.fail('panel controls must not schedule delayed work'); },
        });
        win.ResizeObserver = Observer;
        const document: any = Object.assign(new Events(), { hidden: false, defaultView: win, activeElement: null,
            documentElement: { clientWidth: 1000, clientHeight: 800 } });
        class Node extends Events {
            ownerDocument = document;
            readonly style: Record<string, string> = {};
            readonly dataset: Record<string, string> = {};
            readonly attributes = new Map<string, string>();
            readonly captured = new Set<number>();
            hidden = false;
            tabIndex = 0;
            setAttribute(name: string, value: string) { this.attributes.set(name, value); }
            getAttribute(name: string) { return this.attributes.get(name) ?? null; }
            removeAttribute(name: string) { this.attributes.delete(name); }
            focus() { document.activeElement = this; }
            setPointerCapture(id: number) { this.captured.add(id); }
            releasePointerCapture(id: number) { this.captured.delete(id); }
            getBoundingClientRect() {
                const rect = measured ?? { x: parseFloat(host.style.left) || initial.x,
                    y: parseFloat(host.style.top) || initial.y, width: parseFloat(host.style.width) || initial.width,
                    height: parseFloat(host.style.height) || initial.height };
                return { ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
            }
        }
        let measured: typeof initial | undefined;
        const host = new Node(), surface = new Node(), drag = new Node();
        const resizes = Object.fromEntries(directions.map(direction => {
            const handle = new Node(); handle.dataset.panelResize = direction; return [direction, handle];
        })) as Record<ResizeDirection, Node>;
        const resize = resizes.se;
        const buttons = { left: new Node(), right: new Node(), float: new Node() };
        const layouts: any[] = [], painted: any[] = [];
        const panel = api.installMotionLabPanel(host, { surface, dragHandle: drag, resizeHandles: resizes, dockButtons: buttons,
            measureContentHeight,
            onLayout(layout: any) { layouts.push(layout); return onLayout?.(layout); },
            onGeometryChange() { painted.push(surface.getBoundingClientRect()); } });
        const pointer = (x: number, y: number, id = 1) => ({ button: 0, isPrimary: true, pointerId: id, clientX: x, clientY: y,
            preventDefault() {}, stopPropagation() {} });
        const key = (value: string, shiftKey = false) => ({ key: value, shiftKey, preventDefault() {}, stopPropagation() {} });
        return { host, surface, drag, resize, resizes, buttons, visual, win, document, observers, layouts, painted, panel, pointer, key,
            frames, media,
            advance(at: number) {
                now = at;
                const pending = [...frames.values()]; frames.clear();
                for (const callback of pending) { callback(at); }
            },
            measure(rect?: typeof initial) { measured = rect; } };
    }

    it('caps floating and docked height to useful content while retaining passive size preference', () => {
        const model = new api.MotionLabPanelGeometry(viewport, initial);
        model.setContentHeight(120);
        assert.deepStrictEqual(model.snapshot().rect, { ...initial, height: 120 });
        for (const dock of ['left', 'right']) {
            model.setDock(dock);
            assert.deepStrictEqual(model.snapshot().rect, { x: dock === 'left' ? 8 : 652, y: 8, width: 340, height: 120 });
        }
        model.setDock('float');
        model.setContentHeight(600);
        assert.deepStrictEqual(model.snapshot().rect, initial, 'passive growth restores the remembered user height');
        model.setViewport({ x: 31, y: 27, width: 180, height: 120 });
        assert.strictEqual(model.snapshot().rect.height, 104);
        model.setViewport(viewport);
        assert.deepStrictEqual(model.snapshot().rect, initial);
        for (const height of [0, -1, NaN, Infinity]) {
            assert.throws(() => model.setContentHeight(height), /Motion Lab/);
            assert.deepStrictEqual(model.snapshot().rect, initial);
        }
    });

    it('fits the first disclosure expansion and later collapse without retaining a blank lower region', () => {
        let natural = 120, measurements = 0;
        const f = fixture(undefined, false, () => { measurements++; return natural; });
        try {
            f.panel.setVisible(true);
            assert.deepStrictEqual(f.panel.snapshot().rect, { ...initial, height: 120 });
            assert.strictEqual(f.observers.length, 0, 'intrinsic content observation replaces the forced-surface observer');
            natural = 480;
            f.panel.refreshContent({ fit: true });
            assert.deepStrictEqual(f.panel.snapshot().rect, { ...initial, height: 480 });
            f.resizes.s.emit('keydown', f.key('ArrowUp', true));
            assert.strictEqual(f.panel.snapshot().rect.height, 440);
            natural = 470;
            f.panel.refreshContent();
            assert.strictEqual(f.panel.snapshot().rect.height, 440, 'passive content changes preserve a deliberate smaller size');
            for (let i = 0; i < 7; i++) { f.resizes.s.emit('keydown', f.key('ArrowUp', true)); }
            natural = 300; f.panel.refreshContent({ fit: false });
            assert.strictEqual(f.panel.snapshot().rect.height, 160, 'closing cannot enlarge a deliberately short expanded panel');
            natural = 130;
            f.panel.refreshContent({ fit: false });
            assert.deepStrictEqual(f.panel.snapshot().rect, { ...initial, height: 130 });
            const before = measurements, layouts = f.layouts.length;
            f.drag.emit('keydown', f.key('ArrowRight'));
            assert.strictEqual(measurements, before, 'moving the panel does not remeasure unchanged content');
            f.panel.refreshContent();
            assert.strictEqual(f.layouts.length, layouts + 1, 'the same content height does not emit another layout');
            assert.strictEqual(f.frames.size, 0);
        } finally { f.panel.dispose(); }
    });

    it('invalidates intrinsic geometry once even when the outer content height stays capped', () => {
        let natural = 500, measurements = 0;
        const notifiedAtLayout: number[] = [];
        let f: ReturnType<typeof fixture>;
        f = fixture(() => { notifiedAtLayout.push(f.painted.length); }, false,
            () => { measurements++; return natural; });
        try {
            f.panel.setVisible(true);
            const before = f.painted.length, layouts = f.layouts.length;
            natural = 600; f.panel.refreshContent();
            assert.strictEqual(f.painted.length, before + 1, 'the robot stage can move inside an unchanged capped rectangle');
            assert.strictEqual(f.layouts.length, layouts);
            natural = 240; f.panel.refreshContent();
            assert.strictEqual(f.painted.length, before + 2, 'a changed outer rectangle uses the same one invalidation');
            assert.strictEqual(notifiedAtLayout.at(-1), before + 2, 'the geometry invalidation precedes downstream layout');
            assert.strictEqual(measurements, 3, 'opening and each explicit content change measure once');
            assert.strictEqual(f.frames.size, 0);
        } finally { f.panel.dispose(); }
    });

    it('retains a taller requested height through horizontal pointer resizing while content caps the displayed height', () => {
        for (const direction of ['e', 'w'] as ResizeDirection[]) {
            let natural = 300;
            const f = fixture(undefined, false, () => natural);
            try {
                f.measure({ ...initial, height: 440 });
                f.panel.setVisible(true); f.measure();
                const before = f.panel.snapshot().rect;
                assert.strictEqual(before.height, 300);
                f.resizes[direction].emit('pointerdown', f.pointer(400, 300));
                assert.deepStrictEqual(f.panel.snapshot().rect, before, 'zero-delta admission keeps the displayed pose');
                const dx = direction === 'w' ? -40 : 40;
                f.win.emit('pointermove', f.pointer(400 + dx, 300));
                f.win.emit('pointerup', f.pointer(400 + dx, 300));
                const resized = f.panel.snapshot().rect;
                assert.strictEqual(resized.height, 300);
                assert.strictEqual(resized.y, before.y);
                assert.strictEqual(direction === 'w' ? resized.x + resized.width : resized.x,
                    direction === 'w' ? before.x + before.width : before.x, 'the opposite horizontal edge stays fixed');
                natural = 600; f.panel.refreshContent();
                assert.deepStrictEqual(f.panel.snapshot().rect, { ...resized, height: 440 },
                    'passive content growth restores the requested height rather than the temporary cap');
                assert.strictEqual(f.frames.size, 0);
            } finally { f.panel.dispose(); }
        }
    });

    it('measures the proposed width before capping north and corner resizing at the anchored bottom', () => {
        for (const direction of ['n', 'nw', 'ne'] as ResizeDirection[]) {
            const widths: number[] = [];
            const f = fixture(undefined, false, width => { widths.push(width); return width > 400 ? 210 : 350; });
            try {
                f.panel.setVisible(true);
                const dx = direction === 'nw' ? -100 : direction === 'ne' ? 100 : 0;
                f.resizes[direction].emit('pointerdown', f.pointer(400, 200));
                f.win.emit('pointermove', f.pointer(400 + dx, 100));
                const rect = f.panel.snapshot().rect, expectedHeight = direction === 'n' ? 350 : 210;
                assert.strictEqual(rect.width, 340 + Math.abs(dx));
                assert.strictEqual(rect.height, expectedHeight);
                assert.strictEqual(rect.y + rect.height, initial.y + initial.height, direction + ' keeps its bottom anchor');
                assert.strictEqual(widths.at(-1), rect.width, 'the cap belongs to the resized width');
                if (direction !== 'n') {
                    const sign = direction === 'nw' ? -1 : 1;
                    f.win.emit('pointermove', f.pointer(400 + sign * 120, 90));
                    const second = f.panel.snapshot().rect;
                    assert.strictEqual(second.y + second.height, initial.y + initial.height, 'a changed ceiling cannot rebase the gesture');
                    f.win.emit('pointermove', f.pointer(400 + sign * 20, 140));
                    const reversed = f.panel.snapshot().rect;
                    assert.strictEqual(reversed.width, 360);
                    assert.strictEqual(reversed.height, 350);
                    assert.strictEqual(reversed.y + reversed.height, initial.y + initial.height, 'width reversal retains the same bottom anchor');
                }
                f.win.emit('pointerup', f.pointer(400 + dx, 100));
                assert.strictEqual(f.frames.size, 0);
            } finally { f.panel.dispose(); }
        }
    });

    it('releases a completed north pointer anchor before automatic disclosure collapse', () => {
        for (const direction of ['n', 'nw', 'ne'] as ResizeDirection[]) {
            let natural = 800;
            const f = fixture(undefined, false, () => natural);
            try {
                f.panel.setVisible(true);
                const dx = direction === 'nw' ? -40 : direction === 'ne' ? 40 : 0;
                f.resizes[direction].emit('pointerdown', f.pointer(400, 200));
                f.win.emit('pointermove', f.pointer(400 + dx, 120));
                const resized = f.panel.snapshot().rect;
                assert.strictEqual(resized.y + resized.height, initial.y + initial.height);
                f.win.emit('pointerup', f.pointer(400 + dx, 120));
                natural = 210; f.panel.refreshContent({ fit: false });
                assert.deepStrictEqual(f.panel.snapshot().rect, { ...resized, height: 210 },
                    'collapse preserves the completed panel top rather than the old resize anchor');
                natural = 800; f.panel.refreshContent();
                assert.deepStrictEqual(f.panel.snapshot().rect, resized, 'the requested height remains available');
            } finally { f.panel.dispose(); }
        }
    });

    it('releases each north keyboard resize anchor before automatic disclosure collapse', () => {
        for (const direction of ['n', 'nw', 'ne'] as ResizeDirection[]) {
            let natural = 800;
            const f = fixture(undefined, false, () => natural);
            try {
                f.panel.setVisible(true);
                f.resizes[direction].emit('keydown', f.key('ArrowUp', true));
                const resized = f.panel.snapshot().rect;
                assert.strictEqual(resized.y + resized.height, initial.y + initial.height);
                natural = 210; f.panel.refreshContent({ fit: false });
                assert.deepStrictEqual(f.panel.snapshot().rect, { ...resized, height: 210 });
                natural = 800; f.panel.refreshContent();
                assert.deepStrictEqual(f.panel.snapshot().rect, resized);
                assert.strictEqual(f.frames.size, 0);
            } finally { f.panel.dispose(); }
        }
    });

    it('uses short content at both docks and grows it after viewport recovery without losing width', () => {
        let natural = 190;
        const f = fixture(undefined, false, width => natural + (width - 340) / 2);
        try {
            f.panel.setVisible(true);
            for (const dock of ['left', 'right'] as const) {
                f.panel.setDock(dock);
                const before = f.panel.snapshot().rect;
                assert.strictEqual(before.height, 190);
                const handle = f.resizes[dock === 'left' ? 'e' : 'w'];
                handle.emit('keydown', f.key(dock === 'left' ? 'ArrowRight' : 'ArrowLeft', true));
                assert.strictEqual(f.panel.snapshot().dock, dock);
                assert.strictEqual(f.panel.snapshot().rect.height, 210);
                assert.strictEqual(f.panel.snapshot().rect.y, before.y);
                f.panel.setDock('float');
            }
            f.panel.setDock('right');
            natural = 900; f.panel.refreshContent({ fit: true });
            assert.strictEqual(f.panel.snapshot().rect.height, 684);
            f.visual.height = 200; f.visual.emit('resize');
            assert.strictEqual(f.panel.snapshot().rect.height, 184);
            f.visual.height = 700; f.visual.emit('resize');
            assert.strictEqual(f.panel.snapshot().rect.height, 684);
            assert.strictEqual(f.panel.snapshot().rect.width, 340);
        } finally { f.panel.dispose(); }
    });

    it('defers passive content observations during a dock glide and rechecks once at completion', () => {
        let measurements = 0;
        const f = fixture(layout => layout.reason === 'dock' ? { readyAt: 2500 } : undefined, true,
            () => { measurements++; return 420; });
        try {
            f.panel.setVisible(true); f.panel.setDock('left');
            const before = measurements, layouts = f.layouts.length;
            f.advance(500); f.panel.refreshContent();
            f.advance(2500); f.panel.refreshContent();
            f.advance(3100); f.panel.refreshContent();
            assert.strictEqual(measurements, before, 'intermediate painted widths do not remeasure or replan the destination');
            assert.strictEqual(f.layouts.length, layouts);
            f.advance(3700);
            assert.strictEqual(measurements, before + 1);
            assert.strictEqual(f.panel.snapshot().rect.height, 420);
            assert.strictEqual(f.layouts.length, layouts);
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.host.dataset.panelMoving, undefined);
        } finally { f.panel.dispose(); }
    });

    it('retargets a genuine disclosure change from the displayed pose and fences hidden content callbacks', () => {
        let natural = 420, measurements = 0;
        const f = fixture(layout => layout.reason !== 'open' ? { readyAt: 2500 } : undefined, true,
            () => { measurements++; return natural; });
        try {
            f.panel.setVisible(true); f.panel.setDock('right'); f.advance(500);
            const before = f.panel.snapshot().rect, stale = [...f.frames.values()][0];
            natural = 140; f.panel.refreshContent({ fit: false });
            assert.deepStrictEqual(f.panel.snapshot().rect, before, 'a disclosure retarget does not teleport the dock');
            assert.strictEqual(f.layouts.at(-1).rect.height, 140);
            stale(10000);
            assert.deepStrictEqual(f.panel.snapshot().rect, before);
            f.advance(2500); f.advance(3700);
            assert.strictEqual(f.panel.snapshot().rect.height, 140);
            assert.strictEqual(f.frames.size, 0);
            f.document.hidden = true; f.document.emit('visibilitychange');
            const hiddenReads = measurements;
            natural = 500; f.panel.refreshContent({ fit: true });
            assert.strictEqual(measurements, hiddenReads);
            f.document.hidden = false; f.document.emit('visibilitychange');
            assert.strictEqual(f.panel.snapshot().rect.height, 500);
            f.panel.setVisible(false);
            const closedReads = measurements;
            f.panel.refreshContent();
            assert.strictEqual(measurements, closedReads);
        } finally { f.panel.dispose(); }
        const disposedReads = measurements;
        f.panel.refreshContent({ fit: true });
        assert.strictEqual(measurements, disposedReads);
        assert.strictEqual(f.frames.size, 0);
    });

    it('resizes from all eight floating window handles with the opposite edges anchored', () => {
        for (const direction of directions) {
            const f = fixture();
            try {
                f.panel.setVisible(true);
                const dx = direction.includes('w') ? -50 : direction.includes('e') ? 50 : 0;
                const dy = direction.includes('n') ? -40 : direction.includes('s') ? 40 : 0;
                const handle = f.resizes[direction];
                handle.emit('pointerdown', f.pointer(400, 300));
                assert.ok(handle.captured.has(1), direction + ' captures its resize');
                f.win.emit('pointermove', f.pointer(400 + dx, 300 + dy));
                assert.deepStrictEqual(f.panel.snapshot().rect, {
                    x: initial.x + Math.min(0, dx), y: initial.y + Math.min(0, dy),
                    width: initial.width + Math.abs(dx), height: initial.height + Math.abs(dy),
                }, direction);
                assert.strictEqual(f.frames.size, 0);
                f.win.emit('pointerup', f.pointer(400 + dx, 300 + dy));
                assert.strictEqual(handle.captured.size, 0);
            } finally { f.panel.dispose(); }
        }
    });

    it('clamps the moved edges at minimum size and viewport boundaries without moving their opposite corner', () => {
        const cases: Array<[ResizeDirection, number, number, typeof initial]> = [
            ['se', 10000, 10000, { x: 300, y: 200, width: 602, height: 512 }],
            ['nw', -10000, -10000, { x: 18, y: 28, width: 622, height: 472 }],
            ['ne', 10000, -10000, { x: 300, y: 28, width: 602, height: 472 }],
            ['sw', -10000, 10000, { x: 18, y: 200, width: 622, height: 512 }],
            ['se', -10000, -10000, { x: 300, y: 200, width: 240, height: 160 }],
            ['nw', 10000, 10000, { x: 400, y: 340, width: 240, height: 160 }],
        ];
        for (const [direction, dx, dy, expected] of cases) {
            const f = fixture();
            try {
                f.panel.setVisible(true);
                f.resizes[direction].emit('pointerdown', f.pointer(400, 300));
                f.win.emit('pointermove', f.pointer(400 + dx, 300 + dy));
                assert.deepStrictEqual(f.panel.snapshot().rect, expected, direction + ':' + dx + ',' + dy);
                f.win.emit('pointerup', f.pointer(400 + dx, 300 + dy));
                f.visual.offsetLeft = 200; f.visual.offsetTop = 100; f.visual.width = 180; f.visual.height = 120;
                f.visual.emit('resize');
                const contracted = f.panel.snapshot().rect;
                f.resizes[direction].emit('pointerdown', f.pointer(250, 150));
                f.win.emit('pointermove', f.pointer(250 + dx, 150 + dy));
                assert.deepStrictEqual(f.panel.snapshot().rect, contracted, 'a smaller viewport is already at its effective minimum');
            } finally { f.panel.dispose(); }
        }
    });

    it('can expand upward and leftward from the initial bottom-right panel position', () => {
        const f = fixture();
        try {
            const corner = { x: 562, y: 412, width: 340, height: 300 };
            f.measure(corner); f.panel.setVisible(true); f.measure();
            f.resizes.nw.emit('pointerdown', f.pointer(corner.x, corner.y));
            f.win.emit('pointermove', f.pointer(corner.x - 100, corner.y - 100));
            assert.deepStrictEqual(f.panel.snapshot().rect, { x: 462, y: 312, width: 440, height: 400 });
            assert.strictEqual(f.panel.snapshot().rect.x + f.panel.snapshot().rect.width, 902);
            assert.strictEqual(f.panel.snapshot().rect.y + f.panel.snapshot().rect.height, 712);
        } finally { f.panel.dispose(); }
    });

    it('keeps all eight window handles operable at either dock', () => {
        const f = fixture(undefined, true);
        try {
            f.panel.setVisible(true);
            for (const dock of ['float', 'left', 'right'] as const) {
                f.panel.setDock(dock);
                for (const direction of directions) {
                    const handle = f.resizes[direction];
                    assert.strictEqual(handle.count('pointerdown'), 1, dock + '/' + direction);
                    assert.strictEqual(handle.count('keydown'), 1);
                    assert.strictEqual(handle.hidden, false);
                    assert.strictEqual(handle.attributes.has('disabled'), false);
                    assert.strictEqual(handle.tabIndex, 0);
                    assert.ok(handle.attributes.get('aria-label')?.includes('arrow keys'));
                }
            }
            assert.deepStrictEqual(Object.keys(api.MOTION_LAB_RESIZE_HANDLES), [...directions]);
        } finally { f.panel.dispose(); }
    });

    it('resizes the inner dock edge by width only while keeping its dock and full-height edge fixed', () => {
        for (const dock of ['left', 'right'] as const) {
            for (const direction of (dock === 'left' ? ['e'] : ['w']) as ResizeDirection[]) {
                const f = fixture();
                try {
                    f.panel.setVisible(true); f.panel.setDock(dock);
                    const before = f.panel.snapshot().rect, dx = dock === 'left' ? 60 : -60;
                    f.resizes[direction].emit('pointerdown', f.pointer(400, 300));
                    f.win.emit('pointermove', f.pointer(400 + dx, 10000));
                    const after = f.panel.snapshot();
                    assert.strictEqual(after.dock, dock);
                    assert.deepStrictEqual(after.rect, { ...before,
                        x: before.x + (dock === 'right' ? -60 : 0), width: before.width + 60 });
                    f.win.emit('pointerup', f.pointer(400 + dx, 10000));
                    f.panel.setDock('float');
                    assert.deepStrictEqual(f.panel.snapshot().rect, initial, 'dock resizing preserves the remembered floating rectangle');
                } finally { f.panel.dispose(); }
            }
        }
    });

    it('undocks every corner and other dock edge at the displayed rectangle before anchored resizing', () => {
        for (const dock of ['left', 'right'] as const) {
            for (const direction of directions.filter(value => value !== (dock === 'left' ? 'e' : 'w'))) {
                const f = fixture();
                try {
                    f.panel.setVisible(true); f.panel.setDock(dock);
                    const before = f.panel.snapshot().rect;
                    const dx = direction.includes('w') ? 40 : direction.includes('e') ? -40 : 0;
                    const dy = direction.includes('n') ? 30 : direction.includes('s') ? -30 : 0;
                    f.resizes[direction].emit('pointerdown', f.pointer(400, 300));
                    assert.deepStrictEqual(f.panel.snapshot().rect, before, 'taking a dock corner does not move it');
                    assert.strictEqual(f.panel.snapshot().dock, 'float');
                    f.win.emit('pointermove', f.pointer(400 + dx, 300 + dy));
                    const expected = { x: before.x + Math.max(0, dx), y: before.y + Math.max(0, dy),
                        width: before.width - Math.abs(dx), height: before.height - Math.abs(dy) };
                    assert.deepStrictEqual(f.panel.snapshot().rect, expected, dock + '/' + direction);
                    f.win.emit('pointerup', f.pointer(400 + dx, 300 + dy));
                    f.panel.setDock(dock); f.panel.setDock('float');
                    assert.deepStrictEqual(f.panel.snapshot().rect, expected, 'intentional undocking remembers the resized floating rectangle');
                } finally { f.panel.dispose(); }
            }
        }
    });

    it('uses the selected edges for keyboard resizing and keeps only the inner width edge docked', () => {
        const f = fixture();
        try {
            f.panel.setVisible(true);
            f.resizes.n.emit('keydown', f.key('ArrowUp', true));
            f.resizes.w.emit('keydown', f.key('ArrowLeft'));
            assert.deepStrictEqual(f.panel.snapshot().rect, { x: 290, y: 160, width: 350, height: 340 });
            f.panel.setDock('right');
            const before = f.panel.snapshot().rect;
            f.resizes.w.emit('keydown', f.key('ArrowLeft', true));
            f.resizes.w.emit('keydown', f.key('ArrowUp', true));
            assert.deepStrictEqual(f.panel.snapshot().rect, { ...before, x: before.x - 40, width: before.width + 40 });
            assert.strictEqual(f.frames.size, 0);
            assert.ok(f.resizes.w.attributes.get('aria-label')!.includes('390 by 684'));
            f.resizes.nw.emit('keydown', f.key('ArrowDown'));
            assert.strictEqual(f.panel.snapshot().dock, 'float');
            assert.deepStrictEqual(f.panel.snapshot().rect, { ...before, x: before.x - 40, y: before.y + 10,
                width: before.width + 40, height: before.height - 10 });
        } finally { f.panel.dispose(); }
    });

    it('takes over a docking corner at its displayed rectangle and keeps the opposite corner fixed', () => {
        const f = fixture(undefined, true);
        try {
            f.panel.setVisible(true); f.panel.setDock('right'); f.advance(600);
            const displayed = f.panel.snapshot().rect, stale = [...f.frames.values()][0];
            f.resizes.nw.emit('pointerdown', f.pointer(displayed.x, displayed.y));
            assert.deepStrictEqual(f.panel.snapshot().rect, displayed);
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.host.dataset.dock, 'right');
            f.win.emit('pointermove', f.pointer(displayed.x - 30, displayed.y - 20));
            const resized = { ...displayed, x: displayed.x - 30, y: displayed.y - 20,
                width: displayed.width + 30, height: displayed.height + 20 };
            assert.deepStrictEqual(f.panel.snapshot().rect, resized);
            stale(10000);
            assert.deepStrictEqual(f.panel.snapshot().rect, resized);
            f.win.emit('pointerup', f.pointer(displayed.x - 30, displayed.y - 20));
            assert.strictEqual(f.panel.snapshot().dock, 'float');
            assert.strictEqual(f.host.dataset.dock, 'float');
        } finally { f.panel.dispose(); }
    });

    it('releases capture and all directional handle listeners on every resize cleanup path', () => {
        for (const stop of ['cancel', 'lost', 'blur', 'close', 'hidden', 'viewport', 'dispose']) {
            const f = fixture();
            try {
                f.panel.setVisible(true);
                const handle = f.resizes.nw;
                handle.emit('pointerdown', f.pointer(300, 200));
                assert.ok(handle.captured.has(1));
                const late = [...f.win.listeners.get('pointermove')!][0];
                if (stop === 'cancel') { f.win.emit('pointercancel', f.pointer(300, 200)); }
                else if (stop === 'lost') { handle.emit('lostpointercapture'); }
                else if (stop === 'blur') { f.win.emit('blur'); }
                else if (stop === 'close') { f.panel.setVisible(false); }
                else if (stop === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
                else if (stop === 'viewport') { f.visual.width = 600; f.visual.emit('resize'); }
                else { f.panel.dispose(); }
                const settled = f.panel.snapshot();
                late(f.pointer(200, 100));
                assert.deepStrictEqual(f.panel.snapshot(), settled, stop);
                assert.strictEqual(handle.captured.size, 0);
                assert.strictEqual(f.win.count('pointermove'), 0);
            } finally { f.panel.dispose(); }
            for (const handle of Object.values(f.resizes)) { assert.strictEqual(handle.count(), 0); }
        }
    });

    it('adds no observers or global work while closed and reports only changed layouts', () => {
        const f = fixture();
        assert.strictEqual(f.observers.length, 0);
        assert.strictEqual(f.win.count(), 0);
        assert.strictEqual(f.visual.count(), 0);
        assert.strictEqual(f.document.count(), 0);
        assert.strictEqual(f.layouts.length, 0);
        f.panel.setVisible(true);
        assert.strictEqual(f.layouts.length, 1);
        assert.strictEqual(f.layouts[0].reason, 'open');
        assert.strictEqual(f.layouts[0].visible, true);
        assert.strictEqual(f.observers.length, 1);
        assert.strictEqual(f.buttons.float.attributes.get('aria-pressed'), 'true');
        f.panel.setVisible(true);
        f.panel.setDock('float');
        f.win.emit('resize');
        f.visual.emit('resize');
        assert.strictEqual(f.layouts.length, 1, 'no-op input and observer notifications do not send duplicate callbacks');
        f.panel.setVisible(false);
        assert.strictEqual(f.layouts.at(-1).reason, 'close');
        assert.strictEqual(f.layouts.at(-1).visible, false);
        assert.strictEqual(f.win.count(), 0);
        assert.strictEqual(f.visual.count(), 0);
        assert.strictEqual(f.document.count(), 0);
        assert.ok(f.observers.every(observer => observer.disconnected));
        const count = f.layouts.length;
        f.panel.dispose();
        assert.strictEqual(f.layouts.length, count, 'disposal after close reports no duplicate state');
    });

    it('drags with pointer capture, ignores another pointer and releases gesture listeners on cancel or blur', () => {
        const f = fixture();
        f.panel.setVisible(true);
        f.drag.emit('pointerdown', f.pointer(320, 220));
        assert.ok(f.drag.captured.has(1));
        f.win.emit('pointermove', f.pointer(900, 700, 2));
        assert.deepStrictEqual(f.panel.snapshot().rect, initial);
        f.win.emit('pointermove', f.pointer(380, 260));
        assert.deepStrictEqual(f.panel.snapshot().rect, { ...initial, x: 360, y: 240 });
        assert.strictEqual(f.layouts.at(-1).reason, 'drag');
        const late = [...f.win.listeners.get('pointermove')!][0];
        f.win.emit('pointercancel', f.pointer(380, 260));
        assert.strictEqual(f.drag.captured.size, 0);
        assert.strictEqual(f.win.count('pointermove'), 0);
        const rect = f.panel.snapshot().rect;
        late(f.pointer(-1000, -1000));
        assert.deepStrictEqual(f.panel.snapshot().rect, rect);
        f.drag.emit('pointerdown', f.pointer(380, 260));
        f.win.emit('blur');
        assert.strictEqual(f.drag.captured.size, 0);
        assert.strictEqual(f.win.count('pointermove'), 0);
        f.panel.dispose();
    });

    it('undocks by the grabbed title point and resizes the inner edge of a right dock', () => {
        const f = fixture();
        f.panel.setVisible(true);
        f.buttons.right.emit('click');
        let rect = f.panel.snapshot().rect;
        assert.strictEqual(f.panel.snapshot().dock, 'right');
        assert.strictEqual(f.buttons.right.attributes.get('aria-pressed'), 'true');
        f.resizes.w.emit('pointerdown', f.pointer(rect.x, rect.y + rect.height));
        f.win.emit('pointermove', f.pointer(rect.x - 60, rect.y + rect.height - 200));
        assert.strictEqual(f.panel.snapshot().rect.width, rect.width + 60);
        assert.strictEqual(f.panel.snapshot().rect.height, rect.height);
        f.win.emit('pointerup', f.pointer(rect.x - 60, rect.y + rect.height - 200));
        rect = f.panel.snapshot().rect;
        const x = rect.x + rect.width / 2, y = rect.y + 22;
        f.drag.emit('pointerdown', f.pointer(x, y));
        assert.strictEqual(f.panel.snapshot().dock, 'float');
        assert.strictEqual(f.panel.snapshot().rect.height, initial.height);
        assert.strictEqual(f.panel.snapshot().rect.x + initial.width / 2, x);
        assert.strictEqual(f.panel.snapshot().rect.y + 22, y);
        f.drag.emit('lostpointercapture');
        assert.strictEqual(f.win.count('pointermove'), 0);
        f.panel.dispose();
    });

    it('supports keyboard movement, resizing and all three native button controls', () => {
        const f = fixture();
        f.panel.setVisible(true);
        f.drag.emit('keydown', f.key('ArrowLeft'));
        f.drag.emit('keydown', f.key('ArrowDown', true));
        assert.deepStrictEqual(f.panel.snapshot().rect, { ...initial, x: 290, y: 240 });
        f.resize.emit('keydown', f.key('ArrowRight', true));
        f.resize.emit('keydown', f.key('ArrowUp'));
        assert.deepStrictEqual(f.panel.snapshot().rect, { x: 290, y: 240, width: 380, height: 290 });
        assert.ok(f.resize.attributes.get('aria-label')!.includes('380 by 290'));
        f.buttons.left.emit('click');
        assert.strictEqual(f.panel.snapshot().dock, 'left');
        assert.strictEqual(f.panel.snapshot().rect.width, 380, 'docking keeps the resized floating width');
        f.buttons.right.emit('click');
        assert.strictEqual(f.panel.snapshot().dock, 'right');
        assert.strictEqual(f.panel.snapshot().rect.width, 380, 'changing dock sides keeps the dock width');
        f.buttons.float.emit('click');
        assert.deepStrictEqual(f.panel.snapshot().rect, { x: 290, y: 240, width: 380, height: 290 });
        f.buttons.left.emit('click');
        f.drag.emit('keydown', f.key('ArrowRight'));
        assert.strictEqual(f.panel.snapshot().dock, 'float');
        inside(f.panel.snapshot().rect);
        f.panel.dispose();
    });

    it('clamps to viewport changes and disconnects observers and pointer capture while the document is hidden', () => {
        const f = fixture();
        f.panel.setVisible(true);
        f.visual.offsetLeft = 200; f.visual.offsetTop = 100; f.visual.width = 280; f.visual.height = 240;
        f.visual.emit('resize');
        assert.deepStrictEqual(f.panel.snapshot().rect, { x: 208, y: 108, width: 264, height: 224 });
        assert.strictEqual(f.layouts.at(-1).reason, 'viewport');
        f.drag.emit('pointerdown', f.pointer(230, 130));
        f.document.hidden = true;
        f.document.emit('visibilitychange');
        assert.strictEqual(f.win.count(), 0);
        assert.strictEqual(f.visual.count(), 0);
        assert.strictEqual(f.drag.captured.size, 0);
        assert.ok(f.observers.every(observer => observer.disconnected));
        assert.strictEqual(f.document.count('visibilitychange'), 1, 'only reopening the visible document is observed');
        const count = f.layouts.length;
        f.document.hidden = false;
        f.document.emit('visibilitychange');
        assert.strictEqual(f.observers.filter(observer => !observer.disconnected).length, 1);
        assert.strictEqual(f.layouts.length, count, 'visibility alone does not change the open panel layout');
        f.panel.dispose();
        assert.strictEqual(f.document.count(), 0);
        assert.strictEqual(f.visual.count(), 0);
        assert.strictEqual(f.win.count(), 0);
        assert.ok(f.observers.every(observer => observer.disconnected));
    });

    it('accepts observed size changes once and fences late callbacks after close or disposal', () => {
        const f = fixture();
        f.panel.setVisible(true);
        const observer = f.observers[0];
        f.measure({ ...initial, width: 410, height: 330 });
        observer.callback();
        assert.strictEqual(f.panel.snapshot().rect.width, 410);
        assert.strictEqual(f.layouts.at(-1).reason, 'resize');
        const count = f.layouts.length;
        observer.callback();
        assert.strictEqual(f.layouts.length, count);
        f.panel.setVisible(false);
        f.measure({ ...initial, width: 500, height: 400 });
        observer.callback();
        assert.strictEqual(f.panel.snapshot().rect.width, 410);
        f.panel.setVisible(true);
        f.drag.emit('pointerdown', f.pointer(320, 220));
        f.panel.dispose();
        const final = f.panel.snapshot();
        observer.callback();
        f.panel.setVisible(true);
        f.buttons.left.emit('click');
        assert.deepStrictEqual(f.panel.snapshot(), final);
        assert.strictEqual(f.layouts.at(-1).visible, false);
        for (const node of [f.drag, ...Object.values(f.resizes), ...Object.values(f.buttons)]) { assert.strictEqual(node.count(), 0); }
        assert.strictEqual(f.win.count(), 0);
    });

    it('does not reattach gesture or viewport work after a layout consumer closes or disposes synchronously', () => {
        let first: ReturnType<typeof fixture>;
        first = fixture(layout => { if (layout.reason === 'drag') { first.panel.setVisible(false); } });
        first.panel.setVisible(true);
        first.buttons.right.emit('click');
        const rect = first.panel.snapshot().rect;
        first.drag.emit('pointerdown', first.pointer(rect.x + 30, rect.y + 20));
        assert.strictEqual(first.panel.snapshot().visible, false);
        assert.strictEqual(first.drag.captured.size, 0);
        assert.strictEqual(first.win.count(), 0);
        first.panel.dispose();

        let second: ReturnType<typeof fixture>;
        second = fixture(layout => { if (layout.reason === 'viewport') { second.panel.dispose(); } });
        second.panel.setVisible(true);
        second.document.hidden = true;
        second.document.emit('visibilitychange');
        second.visual.width = 280;
        second.document.hidden = false;
        second.document.emit('visibilitychange');
        assert.strictEqual(second.panel.snapshot().visible, false);
        assert.strictEqual(second.win.count(), 0);
        assert.strictEqual(second.visual.count(), 0);
        assert.strictEqual(second.document.count(), 0);
        assert.ok(second.observers.every(observer => observer.disconnected));
    });

    it('isolates layout consumer mutation and failure from panel cleanup', () => {
        const f = fixture(layout => { layout.rect.width = 1; throw new Error('consumer failed'); });
        assert.doesNotThrow(() => f.panel.setVisible(true));
        assert.strictEqual(f.panel.snapshot().rect.width, initial.width);
        const count = f.layouts.length;
        f.win.emit('resize');
        assert.strictEqual(f.layouts.length, count);
        assert.doesNotThrow(() => f.panel.dispose());
        assert.strictEqual(f.layouts.at(-1).visible, false);
        assert.strictEqual(f.document.count(), 0);
        assert.strictEqual(f.win.count(), 0);
    });

    it('holds one docking destination while the column clears, then paints a finite glide without resize feedback', () => {
        const f = fixture(layout => layout.reason === 'dock' ? { readyAt: 2500 } : undefined, true);
        try {
            f.panel.setVisible(true);
            f.panel.setDock('left');
            const target = { x: 18, y: 28, width: 340, height: 684 };
            assert.deepStrictEqual(f.layouts.at(-1).rect, target);
            assert.deepStrictEqual(f.panel.snapshot().rect, initial, 'the displayed panel waits for the column');
            assert.strictEqual(f.host.dataset.panelMoving, 'true');
            assert.strictEqual(f.frames.size, 1);
            f.advance(500); f.advance(2500);
            assert.deepStrictEqual(f.panel.snapshot().rect, initial);
            f.advance(3100);
            assert.deepStrictEqual(f.panel.snapshot().rect, { x: 159, y: 114, width: 340, height: 492 });
            const count = f.layouts.length;
            f.observers[0].callback();
            assert.strictEqual(f.layouts.length, count, 'an intermediate measured size cannot overwrite the destination');
            assert.deepStrictEqual(f.layouts.at(-1).rect, target);
            assert.ok(f.painted.some(rect => rect.x === 159), 'courier geometry is invalidated for the actual painted position');
            f.advance(3700);
            assert.deepStrictEqual(f.panel.snapshot().rect, target);
            assert.strictEqual(f.host.dataset.panelMoving, undefined);
            assert.strictEqual(f.frames.size, 0);
            f.advance(10_000);
            assert.strictEqual(f.layouts.length, count, 'animation frames do not replan the column');
        } finally { f.panel.dispose(); }
    });

    it('waits for actual column clearance across a continuation and starts the glide only once', () => {
        let readyAt = 2500, ready = false, reads = 0;
        const preparation = { get readyAt() { return readyAt; }, isReady() { reads++; return ready; } };
        const f = fixture(layout => layout.reason === 'dock' ? preparation : undefined, true);
        try {
            f.panel.setVisible(true); f.panel.setDock('left');
            const layouts = f.layouts.length, paints = f.painted.length;
            f.advance(2500);
            readyAt = 5000;
            f.advance(3700); f.advance(5000);
            assert.deepStrictEqual(f.panel.snapshot().rect, initial, 'the old deadline cannot begin the glide before clearance');
            assert.strictEqual(f.painted.length, paints, 'a pending clearance does not repaint the stationary panel');
            assert.strictEqual(f.layouts.length, layouts);
            assert.strictEqual(f.frames.size, 1);
            ready = true; f.advance(5100);
            const settledReads = reads;
            assert.deepStrictEqual(f.panel.snapshot().rect, initial);
            ready = false; readyAt = 10000;
            f.advance(5700);
            assert.deepStrictEqual(f.panel.snapshot().rect, { x: 159, y: 114, width: 340, height: 492 });
            f.advance(6300);
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.host.dataset.panelMoving, undefined);
            assert.strictEqual(reads, settledReads, 'the started glide no longer consults the earlier preparation');
        } finally { f.panel.dispose(); }
    });

    it('honors a readyAt-only preparation beyond one column leg', () => {
        const f = fixture(layout => layout.reason === 'dock' ? { readyAt: 5000 } : undefined, true);
        try {
            f.panel.setVisible(true); f.panel.setDock('left');
            f.advance(4000);
            assert.deepStrictEqual(f.panel.snapshot().rect, initial);
            f.advance(5000); f.advance(5600);
            assert.deepStrictEqual(f.panel.snapshot().rect, { x: 159, y: 114, width: 340, height: 492 });
            f.advance(6200);
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.host.dataset.panelMoving, undefined);
        } finally { f.panel.dispose(); }
    });

    it('retargets and hands a moving panel to the pointer at its displayed rectangle', () => {
        const f = fixture(undefined, true);
        try {
            f.panel.setVisible(true); f.panel.setDock('left'); f.advance(600);
            const first = f.panel.snapshot().rect, stale = [...f.frames.values()][0];
            f.panel.setDock('right');
            assert.deepStrictEqual(f.panel.snapshot().rect, first, 'retargeting has no visual jump');
            stale(10_000);
            assert.deepStrictEqual(f.panel.snapshot().rect, first, 'the old frame cannot move its successor');
            f.advance(1200);
            const displayed = f.panel.snapshot().rect;
            f.drag.emit('pointerdown', f.pointer(displayed.x + 40, displayed.y + 20));
            assert.deepStrictEqual(f.panel.snapshot().rect, displayed, 'taking the title keeps its grabbed point');
            assert.strictEqual(f.panel.snapshot().dock, 'float');
            assert.strictEqual(f.frames.size, 0);
            assert.strictEqual(f.host.dataset.panelMoving, undefined);
            f.win.emit('pointermove', f.pointer(displayed.x + 60, displayed.y + 30));
            assert.deepStrictEqual(f.panel.snapshot().rect, { ...displayed, x: displayed.x + 20, y: displayed.y + 10 });
            f.win.emit('pointerup', f.pointer(displayed.x + 60, displayed.y + 30));
            assert.strictEqual(f.frames.size, 0);
        } finally { f.panel.dispose(); }
    });

    it('keeps the right resize edge anchored and keyboard movement immediate during docking', () => {
        const f = fixture(undefined, true);
        try {
            f.panel.setVisible(true); f.panel.setDock('right'); f.advance(600);
            const displayed = f.panel.snapshot().rect;
            const point = { x: displayed.x, y: displayed.y + displayed.height };
            f.resizes.w.emit('pointerdown', f.pointer(point.x, point.y));
            assert.deepStrictEqual(f.panel.snapshot().rect, displayed);
            assert.strictEqual(f.host.dataset.dock, 'right', 'the captured resize handle stays on the inner edge');
            f.win.emit('pointermove', f.pointer(point.x - 30, point.y));
            assert.deepStrictEqual(f.panel.snapshot().rect, { ...displayed, x: displayed.x - 30, width: displayed.width + 30 });
            f.win.emit('pointerup', f.pointer(point.x - 30, point.y));
            assert.strictEqual(f.host.dataset.dock, 'float');
            assert.strictEqual(f.frames.size, 0);
            f.panel.setDock('left'); f.advance(1200);
            const moving = f.panel.snapshot().rect, stale = [...f.frames.values()][0];
            f.drag.emit('keydown', f.key('ArrowRight', true));
            assert.deepStrictEqual(f.panel.snapshot().rect, { ...moving, x: moving.x + 40 });
            assert.strictEqual(f.frames.size, 0);
            const controlled = f.panel.snapshot();
            stale(10_000);
            assert.deepStrictEqual(f.panel.snapshot(), controlled);
        } finally { f.panel.dispose(); }
    });

    it('cancels every docking frame on lifecycle changes and ignores callbacks owned by the old scene', () => {
        for (const waiting of [false, true]) {
            for (const stop of ['close', 'hidden', 'viewport', 'reduced', 'pointer', 'keyboard', 'dispose'] as const) {
                let reads = 0;
                const f = fixture(waiting ? () => ({ readyAt: 5000, isReady() { reads++; return false; } }) : undefined, true);
                try {
                    f.panel.setVisible(true); f.panel.setDock('left'); f.advance(300);
                    const stale = [...f.frames.values()][0];
                    if (stop === 'close') { f.panel.setVisible(false); }
                    else if (stop === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
                    else if (stop === 'viewport') { f.visual.width = 280; f.visual.emit('resize'); }
                    else if (stop === 'reduced') { f.media.matches = true; f.media.emit('change'); }
                    else if (stop === 'pointer') { f.resizes.nw.emit('pointerdown', f.pointer(300, 200)); }
                    else if (stop === 'keyboard') { f.resizes.nw.emit('keydown', f.key('ArrowDown')); }
                    else { f.panel.dispose(); }
                    const settled = f.panel.snapshot(), stoppedReads = reads;
                    assert.strictEqual(f.frames.size, 0, stop);
                    assert.strictEqual(f.host.dataset.panelMoving, undefined, stop);
                    stale(10_000);
                    assert.deepStrictEqual(f.panel.snapshot(), settled, stop);
                    assert.strictEqual(f.frames.size, 0, stop);
                    assert.strictEqual(reads, stoppedReads, 'cancelled preparation is not consulted again');
                } finally { f.panel.dispose(); }
            }
        }
    });

    it('does not schedule a superseded docking scene after a layout consumer closes or retargets it', () => {
        let f: ReturnType<typeof fixture>, retarget = false;
        f = fixture(layout => {
            if (layout.reason !== 'dock') { return; }
            if (!retarget) { f.panel.setVisible(false); }
            else if (layout.dock === 'left') { f.panel.setDock('right'); }
        }, true);
        try {
            f.panel.setVisible(true); f.panel.setDock('left');
            assert.strictEqual(f.frames.size, 0);
            retarget = true;
            f.panel.setDock('float'); f.panel.setVisible(true); f.panel.setDock('left');
            assert.strictEqual(f.panel.snapshot().dock, 'right');
            assert.strictEqual(f.frames.size, 1);
            f.advance(1200);
            assert.strictEqual(f.panel.snapshot().rect.x, 562);
            assert.strictEqual(f.frames.size, 0);
        } finally { f.panel.dispose(); }
    });
});
