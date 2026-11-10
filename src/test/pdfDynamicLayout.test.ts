import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '../..');

describe('automatic chat notice layout', function () {
    let directory: string;
    let component: any;
    const chat = path.join(repo, 'views/chat-view');
    const vue = require(path.join(chat, 'node_modules/vue'));
    before(async () => {
        const compiler = require(path.join(chat, 'node_modules/@vue/compiler-sfc'));
        const filename = path.join(chat, 'src/components/NewMessageNotice.vue');
        const descriptor = compiler.parse(fs.readFileSync(filename, 'utf8')).descriptor;
        const script = compiler.compileScript(descriptor, { id: 'notice-test', inlineTemplate: true,
            templateOptions: { compilerOptions: { isCustomElement: (tag: string) => tag.startsWith('vscode-') || tag === 'inline' } } });
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-notice-'));
        try {
            await esbuild.build({ stdin: { contents: script.content, loader: 'ts', resolveDir: chat },
                outfile: path.join(directory, 'notice.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
                plugins: [{ name: 'shared-vue', setup(build: any) {
                    build.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve(path.join(chat, 'node_modules/vue')), external: true }));
                } }] });
            component = require(path.join(directory, 'notice.cjs')).default;
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    it('retains the unread row while removing empty pointer, keyboard and accessibility interaction', async () => {
        type Node = { type: string; children: Node[]; props: Record<string, any>; style: Record<string, string>; parent?: Node; text?: string };
        const node = (type: string): Node => ({ type, children: [], props: {}, style: {} });
        const renderer = vue.createRenderer({
            createElement: node, createText: (text: string) => ({ ...node('#text'), text }), createComment: node,
            setText: (element: Node, text: string) => { element.text = text; },
            setElementText: (element: Node, text: string) => { element.text = text; },
            patchProp: (element: Node, key: string, _old: any, value: any) => { element.props[key] = value; if (key === 'style') { Object.assign(element.style, value); } },
            insert: (element: Node, parent: Node) => { element.parent = parent; parent.children.push(element); },
            remove: (element: Node) => { if (element.parent) { element.parent.children.splice(element.parent.children.indexOf(element), 1); } },
            parentNode: (element: Node) => element.parent, nextSibling: () => null,
        });
        const unread = vue.ref(['message-1']);
        const opened: string[] = [];
        const app = renderer.createApp(component, { callback: (id: string) => opened.push(id) });
        app.provide('unreadRecord', unread);
        const root = node('root');
        try {
            app.mount(root);
            const button = root.children[0];
            assert.notStrictEqual(button.style.display, 'none');
            button.props.onClick();
            assert.deepStrictEqual(opened, ['message-1']);
            unread.value = [];
            await vue.nextTick();
            assert.strictEqual(root.children[0], button, 'the same row stays in its flex parent');
            assert.strictEqual(button.style.visibility, 'hidden');
            assert.strictEqual(button.props.inert, true, 'empty row cannot receive keyboard or pointer interaction');
            assert.strictEqual(button.props['aria-hidden'], true, 'hidden feedback is excluded from accessible text');
            button.props.onClick();
            assert.deepStrictEqual(opened, ['message-1'], 'a stale activation cannot open an undefined message');
            unread.value = ['message-2'];
            await vue.nextTick();
            assert.strictEqual(button.style.visibility, 'visible');
            assert.strictEqual(button.props.inert, false);
            assert.strictEqual(button.props['aria-hidden'], false);
            button.props.onClick();
            assert.deepStrictEqual(opened, ['message-1', 'message-2']);
            const descendants = (element: Node): Node[] => [element, ...element.children.flatMap(descendants)];
            const reservation = descendants(button).find(element => element.props.class === 'unread-count-reservation')!;
            assert.ok(reservation, 'the producer count domain is reserved before the live count grows');
            assert.strictEqual(reservation.text, String(2 ** 32 - 1));
            assert.strictEqual(reservation.props['aria-hidden'], 'true');
            const count = reservation.parent!.children.find(element => element !== reservation)!;
            unread.value.length = 1000;
            await vue.nextTick();
            assert.strictEqual(count.text, '1000');
            unread.value.length = 2 ** 32 - 1;
            await vue.nextTick();
            assert.strictEqual(count.text, '4294967295', 'the largest supported Array count stays exact');
            assert.strictEqual(reservation.parent!.children.length, 2, 'only one live count and one inaccessible reservation are present');
        } finally { app.unmount(); }
    });
});

describe('standalone notice viewport and keyboard ownership', function () {
    let directory: string, api: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-layout-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/standalone/notice-layout.ts')],
                outfile: path.join(directory, 'notice.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
            api = await importModule(path.join(directory, 'notice.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });
    function fixture() {
        const events = () => {
            const listeners = new Map<string, Set<any>>();
            return { listeners,
                addEventListener(type: string, callback: any) {
                    if (!listeners.has(type)) { listeners.set(type, new Set()); }
                    listeners.get(type)!.add(callback);
                },
                removeEventListener(type: string, callback: any) { listeners.get(type)?.delete(callback); },
                emit(type: string, event: any = {}) { for (const callback of listeners.get(type) ?? []) { callback(event); } },
            };
        };
        const viewport = { ...events(), offsetTop: 0, height: 100 };
        const values: Record<string, string> = {};
        const notice = { ...events(), error: true, hasAttribute() { return this.error; },
            style: { setProperty(key: string, value: string) { values[key] = value; }, removeProperty(key: string) { delete values[key]; } },
            querySelector: () => retry };
        const retry = { getBoundingClientRect: () => ({ height: 44 }) };
        const details = {};
        let resized: () => void = () => {}, disconnected = false;
        const win = { ...events(), visualViewport: viewport, innerHeight: 100,
            getComputedStyle: (element: any) => element === notice
                ? { paddingTop: '6px', paddingBottom: '6px', borderTopWidth: '0px', borderBottomWidth: '0px' } : { minHeight: '44px' },
            ['ResizeObserver']: class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() { disconnected = true; } },
        };
        const rect = { top: 0, bottom: 58 };
        const header = { ownerDocument: { defaultView: win }, getBoundingClientRect: () => rect };
        const owner = api.installNoticeLayout(header, notice, details);
        return { viewport, notice, retry, details, win, rect, owner, values, resized: () => resized(), disconnected: () => disconnected };
    }
    it('uses measured header and control chrome, retaining a viewport-bounded outer scroller on short and displaced views', () => {
        const f = fixture();
        try {
            assert.strictEqual(f.values['--notice-top'], '44px');
            assert.strictEqual(f.values['--notice-available-height'], '56px', 'measured 44px Retry plus actual 12px padding remain reachable');
            f.rect.bottom = 240; f.resized();
            assert.strictEqual(f.values['--notice-top'], '44px', 'a taller header cannot leave a zero-height notice');
            f.viewport.offsetTop = 200; f.viewport.height = 30; f.rect.top = 190; f.rect.bottom = 250;
            f.viewport.emit('scroll');
            assert.strictEqual(f.values['--notice-top'], '10px');
            assert.strictEqual(f.values['--notice-available-height'], '30px', 'outer overflow can scroll controls taller than the entire viewport');
            f.viewport.offsetTop = 0; f.viewport.height = 400; f.rect.top = 0; f.rect.bottom = 93;
            f.viewport.emit('resize');
            assert.strictEqual(f.values['--notice-top'], '93px', 'header wrapping supplies the anchor rather than a duplicate offset');
            assert.strictEqual(f.values['--notice-available-height'], '307px');
        } finally { f.owner.dispose(); }
        assert.ok(f.disconnected());
        assert.ok([...f.win.listeners.values(), ...f.viewport.listeners.values(), ...f.notice.listeners.values()].every(set => set.size === 0));
        assert.deepStrictEqual(f.values, {});
    });
    it('keeps native detail scrolling while passing Tab, Retry activation, modifiers and composing input to their owners', () => {
        const f = fixture();
        function key(key: string, target: any = f.details, extra: any = {}) {
            let stopped = false, prevented = false;
            f.notice.emit('keydown', { key, target, ...extra, stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
            return { stopped, prevented };
        }
        try {
            for (const value of ['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' ']) {
                assert.deepStrictEqual(key(value), { stopped: true, prevented: false });
            }
            assert.deepStrictEqual(key(' ', f.details, { shiftKey: true }), { stopped: true, prevented: false });
            for (const value of ['Tab', 'Enter', 'Escape']) { assert.strictEqual(key(value).stopped, false); }
            for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) {
                assert.strictEqual(key('PageDown', f.details, { [modifier]: true }).stopped, false);
            }
            assert.strictEqual(key(' ', f.retry).stopped, false);
            f.notice.error = false;
            assert.strictEqual(key('PageDown').stopped, false, 'ordinary reader handling returns when the error is dismissed');
        } finally { f.owner.dispose(); }
    });
});
