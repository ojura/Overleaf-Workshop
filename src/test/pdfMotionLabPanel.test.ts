import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const viewport = { x: 0, y: 0, width: 1000, height: 800 };
const initial = { x: 300, y: 200, width: 340, height: 300 };

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

    function fixture(onLayout?: (layout: any) => void) {
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
        const win: any = Object.assign(new Events(), {
            innerWidth: 1000, innerHeight: 800, visualViewport: visual,
            requestAnimationFrame() { assert.fail('panel controls must not schedule animation frames'); },
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
            setAttribute(name: string, value: string) { this.attributes.set(name, value); }
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
        const host = new Node(), surface = new Node(), drag = new Node(), resize = new Node();
        const buttons = { left: new Node(), right: new Node(), float: new Node() };
        const layouts: any[] = [];
        const panel = api.installMotionLabPanel(host, { surface, dragHandle: drag, resizeHandle: resize, dockButtons: buttons,
            onLayout(layout: any) { layouts.push(layout); onLayout?.(layout); } });
        const pointer = (x: number, y: number, id = 1) => ({ button: 0, isPrimary: true, pointerId: id, clientX: x, clientY: y,
            preventDefault() {}, stopPropagation() {} });
        const key = (value: string, shiftKey = false) => ({ key: value, shiftKey, preventDefault() {}, stopPropagation() {} });
        return { host, surface, drag, resize, buttons, visual, win, document, observers, layouts, panel, pointer, key,
            measure(rect?: typeof initial) { measured = rect; } };
    }

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
        f.resize.emit('pointerdown', f.pointer(rect.x, rect.y + rect.height));
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
        for (const node of [f.drag, f.resize, ...Object.values(f.buttons)]) { assert.strictEqual(node.count(), 0); }
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
});
