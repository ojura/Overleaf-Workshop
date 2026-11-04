import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

type Listener = NonNullable<Parameters<EventTarget['addEventListener']>[1]>;
type AddOptions = Parameters<EventTarget['addEventListener']>[2];
type RemoveOptions = Parameters<EventTarget['removeEventListener']>[2];

class Surface extends EventTarget {
    readonly listeners = new Map<string, Set<Listener>>();
    readonly registrations: Exclude<AddOptions, boolean | undefined>[] = [];
    override addEventListener(name: string, listener: Listener | null, options?: AddOptions) {
        if (!listener) { return; }
        const config = typeof options === 'boolean' ? { capture: options } : options ?? {};
        const key = name + ':' + !!config.capture;
        if (!this.listeners.has(key)) { this.listeners.set(key, new Set()); }
        this.listeners.get(key)!.add(listener); this.registrations.push(config);
        super.addEventListener(name, listener, options);
    }
    override removeEventListener(name: string, listener: Listener | null, options?: RemoveOptions) {
        if (listener) {
            this.listeners.get(name + ':' + !!(typeof options === 'boolean' ? options : options?.capture))?.delete(listener);
            super.removeEventListener(name, listener, options);
        }
    }
    get listenerCount() { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
}

function element(selector = '', contentEditable = false) {
    return { isContentEditable: contentEditable, matches: (query: string) => !!selector && query.split(',').includes(selector) };
}

describe('native-preserving robot interactions', function () {
    this.timeout(30_000);
    let directory: string, interaction: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-interaction-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/robot-interaction.ts')],
                outfile: path.join(directory, 'interaction.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
            interaction = await importModule(path.join(directory, 'interaction.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    function fixture() {
        const win = new Surface(), doc = new Surface(), container = new Surface();
        const clock = { time: 0 }, selection = { isCollapsed: true };
        Object.assign(win, { performance: { now: () => clock.time },
            requestAnimationFrame: assert.fail, setTimeout: assert.fail, setInterval: assert.fail });
        Object.assign(doc, { defaultView: win, hidden: false, getSelection: () => selection });
        Object.assign(container, { ownerDocument: doc, matches: () => false });
        const actors = [{ id: 1, x: 10, y: 10, width: 100, height: 100 }, { id: 2, x: 130, y: 10, width: 100, height: 100 }];
        const hovered: Array<{ id: number | undefined; point?: { x: number; y: number } }> = [], greeted: number[] = [];
        let hitTests = 0;
        const handle = interaction.installRobotInteraction(container, {
            hitTest(point: { x: number; y: number }) {
                hitTests++;
                return actors.find(actor => point.x >= actor.x && point.y >= actor.y
                    && point.x < actor.x + actor.width && point.y < actor.y + actor.height);
            },
            onHover(id: number | undefined, point?: { x: number; y: number }) { hovered.push({ id, point }); },
            onGreet(id: number) { greeted.push(id); },
        });
        function fire(type: string, values: Record<string, any> = {}) {
            const { route = [element(), container, doc, win], prevented = false, ...properties } = values;
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, Object.fromEntries(Object.entries({ pointerId: 1, pointerType: 'mouse', isPrimary: true,
                button: 0, buttons: type === 'pointerdown' ? 1 : 0, detail: type === 'click' ? 1 : 0,
                clientX: 40, clientY: 40, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...properties })
                .map(([name, value]) => [name, { value, configurable: true }])));
            Object.defineProperty(event, 'composedPath', { value: () => route });
            if (prevented) { event.preventDefault(); }
            if (type === 'pointerdown') {
                win.dispatchEvent(event);
                if (route.includes(container)) { container.dispatchEvent(event); }
            } else if (['pointerup', 'pointercancel', 'blur'].includes(type)) { win.dispatchEvent(event); }
            else if (['scroll', 'selectionchange', 'visibilitychange'].includes(type)) { doc.dispatchEvent(event); }
            else { container.dispatchEvent(event); }
            return event;
        }
        const click = (values: Record<string, any> = {}) => { fire('pointerdown', values); fire('pointerup', values); return fire('click', values); };
        return { win, doc, container, clock, selection, actors, hovered, greeted, handle, fire, click, hitTests: () => hitTests,
            listenerCount: () => win.listenerCount + doc.listenerCount + container.listenerCount };
    }

    it('reevaluates cached hit boxes on caller updates and coalesces unchanged hover without scheduling work', () => {
        const f = fixture();
        try {
            f.fire('pointermove');
            assert.deepStrictEqual(f.hovered, [{ id: 1, point: { x: 40, y: 40 } }]);
            f.handle.update(); f.fire('pointermove');
            assert.strictEqual(f.hovered.length, 1);
            f.actors[0].id = 7; f.handle.update();
            assert.strictEqual(f.hovered.at(-1)!.id, 7);
            f.fire('pointermove', { clientX: 300 });
            assert.deepStrictEqual(f.hovered.at(-1), { id: undefined, point: undefined });
            f.fire('pointermove');
            f.fire('pointerleave');
            const count = f.hitTests(); f.handle.update();
            assert.strictEqual(f.hitTests(), count, 'a departed pointer does not query the scene again');
            assert.deepStrictEqual(f.hovered.map(value => value.id), [1, 7, undefined, 7, undefined]);
        } finally { f.handle.dispose(); }
    });

    it('greets the same clicked robot once while native click propagation and defaults remain available', () => {
        const f = fixture();
        let nativeClicks = 0;
        const native = () => { nativeClicks++; };
        f.container.addEventListener('click', native);
        try {
            const event = f.click();
            assert.deepStrictEqual(f.greeted, [1]);
            assert.strictEqual(event.defaultPrevented, false);
            assert.strictEqual(nativeClicks, 1);
            f.fire('click');
            assert.deepStrictEqual(f.greeted, [1], 'a click without a new pointer gesture cannot replay a greeting');
            assert.ok([...f.win.registrations, ...f.doc.registrations, ...f.container.registrations.slice(0, -1)]
                .every(value => value.passive), 'observation does not take native input ownership');
        } finally { f.container.removeEventListener('click', native); f.handle.dispose(); }
    });

    it('accepts a touch tap after pointerleave and the native compatibility-click delay without touch hover', () => {
        const f = fixture(), touch = { pointerType: 'touch', pointerId: 9 };
        try {
            f.fire('pointerdown', touch); f.fire('pointerup', touch); f.fire('pointerleave', touch);
            f.clock.time = 300;
            f.fire('click', touch);
            assert.deepStrictEqual(f.greeted, [1]);
            assert.deepStrictEqual(f.hovered, []);
        } finally { f.handle.dispose(); }
    });

    it('cancels a moved gesture even when it returns to the same robot before release', () => {
        const f = fixture();
        try {
            f.fire('pointerdown');
            f.fire('pointermove', { clientX: 60, buttons: 1 });
            f.fire('pointermove', { clientX: 40, buttons: 1 });
            f.fire('pointerup'); f.fire('click');
            assert.deepStrictEqual(f.greeted, []);
            f.click({ clientX: 43 });
            assert.deepStrictEqual(f.greeted, [1], 'a later clean click still works');
        } finally { f.handle.dispose(); }
    });

    it('requires the same robot at release and click and rejects late or keyboard-only clicks', () => {
        const f = fixture();
        try {
            f.fire('pointerdown'); f.actors[0].id = 3; f.fire('pointerup'); f.fire('click');
            assert.deepStrictEqual(f.greeted, []);
            f.fire('pointerdown'); f.fire('pointerup');
            f.actors[0].id = 4; f.fire('click');
            assert.deepStrictEqual(f.greeted, []);
            f.fire('pointerdown'); f.fire('pointerup');
            f.clock.time += 801; f.fire('click');
            assert.deepStrictEqual(f.greeted, []);
            f.fire('pointerdown'); f.fire('pointerup'); f.fire('click', { detail: 0 });
            assert.deepStrictEqual(f.greeted, []);
        } finally { f.handle.dispose(); }
    });

    it('cancels scrolling, context menus, leaving, pointer cancellation, blur and multi-touch gestures', () => {
        for (const type of ['scroll', 'wheel', 'contextmenu', 'pointerleave', 'pointercancel', 'blur', 'second-touch']) {
            const f = fixture();
            try {
                f.fire('pointerdown', { pointerType: 'touch' });
                if (type === 'second-touch') { f.fire('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false }); }
                else { f.fire(type); }
                f.fire('pointerup'); f.fire('click');
                assert.deepStrictEqual(f.greeted, [], type);
            } finally { f.handle.dispose(); }
        }
    });

    it('leaves links, native controls, annotations and composed-path editable/role targets alone', () => {
        for (const selector of ['a[href]', 'area[href]', 'button', 'input', 'select', 'textarea', 'label', 'summary',
            '[role="button"]', '[role="link"]', '[role="slider"]', '.annotationLayer', '.annotationEditorLayer', 'editable']) {
            const f = fixture();
            try {
                const ancestor = element(selector === 'editable' ? '' : selector, selector === 'editable');
                const route = [element(), {}, ancestor, f.container, f.doc, f.win];
                f.fire('pointermove', { route });
                const event = f.click({ route });
                assert.deepStrictEqual(f.hovered, [], selector);
                assert.deepStrictEqual(f.greeted, [], selector);
                assert.strictEqual(event.defaultPrevented, false, selector);
            } finally { f.handle.dispose(); }
        }
    });

    it('preserves text selections, modified clicks and clicks already consumed by native PDF handlers', () => {
        const f = fixture();
        try {
            f.fire('pointermove');
            f.selection.isCollapsed = false; f.fire('selectionchange');
            assert.strictEqual(f.hovered.at(-1)!.id, undefined);
            f.click(); assert.deepStrictEqual(f.greeted, []);
            f.selection.isCollapsed = true;
            f.fire('pointerdown'); f.fire('pointerup');
            f.selection.isCollapsed = false; f.fire('click');
            assert.deepStrictEqual(f.greeted, []);
            f.selection.isCollapsed = true;
            for (const name of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
                f.click({ [name]: true });
                f.fire('pointerdown'); f.fire('pointerup'); f.fire('click', { [name]: true });
            }
            f.fire('pointerdown'); f.fire('pointerup'); f.fire('click', { prevented: true });
            assert.deepStrictEqual(f.greeted, []);
            assert.strictEqual(f.selection.isCollapsed, true);
        } finally { f.handle.dispose(); }
    });

    it('clears pending input and hover on disable/hide and removes every listener on disposal', () => {
        const f = fixture();
        try {
            assert.ok(f.listenerCount() > 0);
            f.fire('pointermove'); f.fire('pointerdown');
            f.handle.setEnabled(false); f.fire('pointerup'); f.fire('click'); f.handle.update();
            assert.deepStrictEqual(f.greeted, []);
            assert.strictEqual(f.hovered.at(-1)!.id, undefined);
            f.handle.setEnabled(true); f.click();
            assert.deepStrictEqual(f.greeted, [1]);
            f.fire('pointermove'); f.fire('pointerdown');
            Object.assign(f.doc, { hidden: true }); f.fire('visibilitychange');
            Object.assign(f.doc, { hidden: false }); f.fire('visibilitychange');
            f.fire('pointerup'); f.fire('click'); f.handle.update();
            assert.deepStrictEqual(f.greeted, [1]);
            f.fire('pointermove'); f.handle.dispose(); f.handle.dispose();
            const hoverCount = f.hovered.length;
            assert.strictEqual(f.listenerCount(), 0, 'no idle observer remains');
            f.handle.setEnabled(true); f.handle.update(); f.click(); f.fire('pointermove');
            assert.strictEqual(f.hovered.length, hoverCount);
            assert.deepStrictEqual(f.greeted, [1]);
        } finally { f.handle.dispose(); }
    });
});
