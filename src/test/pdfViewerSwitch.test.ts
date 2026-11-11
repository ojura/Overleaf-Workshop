/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { loadWithVscode } from './standIn';

/** the extension's package.json, as VS Code gives it to the extension (ExtensionContext.extension.packageJSON) */
const packageJSON = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));

function stub(): any {
    const f: any = function () { return stub(); };
    return new Proxy(f, {
        get(target, key) {
            if (key === 'then') { return undefined; }
            if (!(key in target)) { target[key] = stub(); }
            return target[key];
        },
        construct() { return stub(); },
    });
}
const withStubs = (target: any): any => new Proxy(target, { get: (t, key) => (key in t ? t[key] : stub()) });

class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '') {}
    get fsPath() { return this.path; }
    with(change: { path?: string }) { return new Uri(this.scheme, this.authority, change.path ?? this.path, this.query); }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`; }
    static file(p: string) { return new Uri('file', '', p); }
    static joinPath(base: Uri, ...parts: string[]) { return base.with({ path: path.posix.join(base.path, ...parts) }); }
}

/** the user settings of overleaf-workshop.pdfViewer, and who listens to their changes */
const world = {
    settings: {} as Record<string, unknown>,
    updates: [] as unknown[][],
    deleted: [] as string[],
    updateGate: undefined as Promise<void> | undefined,
    configListeners: [] as ((e: { affectsConfiguration(section: string): boolean }) => void)[],
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class Storage {
    readonly values = new Map<string, any>();
    readonly writes: { value: any, finish: () => void, settled: Promise<void> }[] = [];
    readonly waiting: (() => void)[] = [];
    blocked = false;
    get(key: string, fallback: any) { return copy(this.values.get(key) ?? fallback); }
    update(key: string, value: any) {
        let finish!: () => void;
        const saved = copy(value);
        const settled = new Promise<void>(resolve => { finish = () => { this.values.set(key, saved); resolve(); }; });
        this.writes.push({ value: saved, finish, settled });
        this.waiting.splice(0).forEach(resolve => resolve());
        if (!this.blocked) { finish(); }
        return settled;
    }
    nextWrite() { return new Promise<void>(resolve => this.waiting.push(resolve)); }
}
const vscodeMock = withStubs({
    Uri,
    Disposable: class { dispose() {} },
    EventEmitter: class {
        private listeners: ((e: unknown) => void)[] = [];
        event = (listener: (e: unknown) => void) => { this.listeners.push(listener); return { dispose() {} }; };
        fire(e: unknown) { this.listeners.forEach(listener => listener(e)); }
        dispose() {}
    },
    TreeItem: class {},
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    l10n: { t: (message: string) => message },
    window: withStubs({ state: { focused: true }, registerCustomEditorProvider: () => ({ dispose() {} }) }),
    workspace: withStubs({
        getConfiguration: () => ({
            get: (key: string, value: unknown) => (key in world.settings ? world.settings[key] : value),
            update: async (key: string, value: unknown, target: unknown) => {
                world.updates.push([key, value, target]);
                await world.updateGate;
                world.settings[key] = value;
                const section = `overleaf-workshop.pdfViewer.${key}`;
                world.configListeners.forEach(listener => listener({ affectsConfiguration: (s: string) => section === s || section.startsWith(`${s}.`) }));
            },
        }),
        onDidChangeConfiguration: (listener: any) => { world.configListeners.push(listener); return { dispose() {} }; },
        fs: withStubs({
            stat: async () => ({ type: 1 }),
            delete: async (uri: Uri, options: { recursive?: boolean }) => { world.deleted.push(`${uri.path}${options?.recursive ? ' (recursive)' : ''}`); },
            readFile: async (uri: Uri) => {
                // the extension host's readFile gives a Buffer, which the provider turns into text
                const page = /\/dist\/(\w+)\.html$/.exec(uri.path);
                return Buffer.from(page ? `<html><head><!--viewer-config--></head><body>the ${page[1]} viewer</body></html>` : '%PDF-1.7 whole');
            },
        }),
    }),
});
const [{ PdfViewEditorProvider }] = loadWithVscode(vscodeMock, () => [require('../core/pdfViewEditorProvider')]);

/**
 * a webview panel that records its pages, through which the test sends the page's messages;
 * nextPage() settles when the panel gets its next page, as when the provider reloads the viewer
 */
function panel() {
    const pages: string[] = [];
    const received: any[] = [];
    const pageWaiters: Array<() => void> = [];
    let onMessage: (message: any) => void = () => {};
    let onDispose: () => void = () => {};
    let onViewState: (event: any) => void = () => {};
    const webview = {
        options: {},
        set html(value: string) { pages.push(value); pageWaiters.splice(0).forEach(resolve => resolve()); },
        get html() { return pages.at(-1) ?? ''; },
        asWebviewUri: (uri: Uri) => uri,
        postMessage: async (message: any) => { received.push(copy(message)); return true; },
        onDidReceiveMessage: (listener: (message: any) => void) => { onMessage = listener; return { dispose() {} }; },
    };
    return {
        pages, received,
        page: () => JSON.parse(/<script[^>]*id="viewer-config"[^>]*>(.*?)<\/script>/.exec(webview.html)![1]).page,
        nextPage: () => new Promise<void>(resolve => pageWaiters.push(resolve)),
        send: (message: any) => onMessage(message),
        dispose: () => onDispose(),
        hide: () => onViewState({ webviewPanel: { active: false, visible: false } }),
        webviewPanel: { webview, onDidDispose: (listener: () => void) => { onDispose = listener; return { dispose() {} }; },
            onDidChangeViewState: (listener: (event: any) => void) => { onViewState = listener; return { dispose() {} }; } },
    };
}
const viewerOf = (page: string | undefined) => /the (\w+) viewer/.exec(page ?? '')?.[1];

describe('the button that switches between the pdfjs and the overleaf viewer', () => {
    let provider: any;
    let storage: Storage, triggers: { dispose(): void }[];
    beforeEach(() => {
        world.settings = { engine: 'pdfjs' };
        world.updates = [];
        world.updateGate = undefined;
        world.configListeners = [];
        world.deleted = [];
        storage = new Storage();
        provider = new PdfViewEditorProvider({ extensionUri: Uri.file('/ext'), globalStorageUri: Uri.file('/storage'), extension: { packageJSON }, globalState: storage });
        triggers = provider.triggers;
    });
    afterEach(async () => {
        storage.blocked = false;
        for (const write of storage.writes) { write.finish(); }
        triggers.forEach(trigger => trigger.dispose());
        await provider.viewState?.settled;
        await provider.previews.settled();
        await provider.pieces.dispose();
    });

    it('shares visibility across documents and engines without changing their reading state', async () => {
        world.settings.robotsEnabled = false;
        const first = panel(), second = panel();
        const firstDoc = await provider.openCustomDocument(Uri.file('/home/u/one.pdf'));
        const secondDoc = await provider.openCustomDocument(Uri.file('/home/u/two.pdf'));
        await secondDoc.setEngine('overleaf');
        await provider.resolveCustomEditor(firstDoc, first.webviewPanel);
        await provider.resolveCustomEditor(secondDoc, second.webviewPanel);
        const firstState = { scale: '2', documentRobotsEnabled: true, position: { page: 7 } };
        const secondState = { scale: '3', documentRobotsEnabled: false, sidebarView: 2 };
        first.send({ type: 'saveState', page: first.page(), content: firstState });
        second.send({ type: 'saveState', page: second.page(), content: secondState });
        for (const editor of [first, second]) {
            editor.send({ type: 'ready', page: editor.page() });
            assert.strictEqual(editor.received.find(message => message.type === 'initState')?.robotsEnabled, false);
        }
        first.send({ type: 'setRobotsEnabled', page: first.page(), enabled: true });
        await provider.robotPreferenceWrites;
        assert.deepStrictEqual(world.updates, [['robotsEnabled', true, 1]]);
        for (const editor of [first, second]) {
            assert.deepStrictEqual(editor.received.at(-1), { type: 'robotsEnabledChanged', page: editor.page(), enabled: true });
            assert.strictEqual(editor.pages.length, 1, 'visibility does not reload the reader');
        }
        assert.deepStrictEqual(provider.viewState.read(firstDoc.uri.toString()), firstState);
        assert.deepStrictEqual(provider.viewState.read(secondDoc.uri.toString()), secondState);
        const retired = first.page(); await [...provider.editors][0].render();
        first.send({ type: 'setRobotsEnabled', page: retired, enabled: false });
        second.dispose(); second.send({ type: 'setRobotsEnabled', page: second.page(), enabled: false });
        await provider.robotPreferenceWrites;
        assert.strictEqual(world.updates.length, 1);
        world.settings.robotsEnabled = false;
        world.configListeners.forEach(listener => listener({ affectsConfiguration: section => section === 'overleaf-workshop.pdfViewer.robotsEnabled' }));
        assert.strictEqual(first.received.at(-1).enabled, false);
        assert.strictEqual(second.received.at(-1).enabled, true, 'closed panels receive no notification');
    });

    it('serializes rapid global toggles and drops a queued retired-page request', async () => {
        const editor = panel(), doc = await provider.openCustomDocument(Uri.file('/home/u/ordered-robots.pdf'));
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        let release!: () => void;
        world.updateGate = new Promise<void>(resolve => { release = resolve; });
        editor.send({ type: 'setRobotsEnabled', page: editor.page(), enabled: false });
        await Promise.resolve();
        editor.send({ type: 'setRobotsEnabled', page: editor.page(), enabled: true });
        assert.deepStrictEqual(world.updates, [['robotsEnabled', false, 1]]);
        release(); await provider.robotPreferenceWrites;
        assert.deepStrictEqual(world.updates, [['robotsEnabled', false, 1], ['robotsEnabled', true, 1]]);
        assert.strictEqual(world.settings.robotsEnabled, true);
        world.updateGate = new Promise<void>(resolve => { release = resolve; });
        editor.send({ type: 'setRobotsEnabled', page: editor.page(), enabled: false });
        await Promise.resolve();
        editor.send({ type: 'setRobotsEnabled', page: editor.page(), enabled: true });
        await [...provider.editors][0].render();
        release(); await provider.robotPreferenceWrites;
        assert.strictEqual(world.updates.length, 3, 'queued requests lose authority when their page retires');
        assert.strictEqual(world.settings.robotsEnabled, false);
        const setting = packageJSON.contributes.configuration.properties['overleaf-workshop.pdfViewer.robotsEnabled'];
        assert.strictEqual(setting.scope, 'application'); assert.strictEqual(setting.default, true);
    });

    it('flushes the already-received final reading state when the panel closes', async () => {
        const uri = Uri.file('/home/u/close.pdf'), doc = await provider.openCustomDocument(uri), editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        const state = { position: { page: 7, offset: { top: 41, left: 8 } }, scale: '2', motionLabMeasurementsOpen: true };
        editor.send({ type: 'saveState', page: editor.page(), content: state });
        assert.strictEqual(storage.writes.length, 0, 'durable writes are coalesced by the host while capture is immediate');
        const started = storage.nextWrite();
        editor.dispose();
        await started;
        await storage.writes.at(-1)!.settled;
        assert.deepStrictEqual(storage.values.get('overleaf-pdf-viewers')[uri.toString()].state, state);
    });

    it('keeps the newest state available during navigation and rejects messages from the old page', async () => {
        const uri = Uri.file('/home/u/switch.pdf'), doc = await provider.openCustomDocument(uri), editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        storage.blocked = true;
        const oldPage = editor.page(), state = { position: { page: 9 }, scale: '3' };
        editor.send({ type: 'saveState', page: oldPage, content: state });
        const reloaded = editor.nextPage();
        editor.send({ type: 'switchViewer', engine: 'overleaf' });
        await reloaded;
        assert.notStrictEqual(editor.page(), oldPage);
        editor.send({ type: 'saveState', page: oldPage, content: { position: { page: 1 }, scale: '1' } });
        editor.send({ type: 'ready', page: oldPage });
        assert.strictEqual(editor.received.filter(message => message.type === 'initState').length, 0);
        editor.send({ type: 'ready', page: editor.page() });
        assert.deepStrictEqual(editor.received.find(message => message.type === 'initState')?.content, state);
        editor.dispose();
        for (const write of storage.writes) { write.finish(); }
    });

    it('accepts the displayed page state until its replacement HTML is committed', async () => {
        const uri = Uri.file('/home/u/pending-template.pdf'), doc = await provider.openCustomDocument(uri), editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        storage.blocked = true;
        const oldPage = editor.page(), first = { position: { page: 1 }, scale: '1' };
        const firstStarted = storage.nextWrite();
        editor.send({ type: 'saveState', page: oldPage, content: first });
        editor.hide(); await firstStarted;
        const owned = [...provider.editors][0] as any, original = provider.getViewerPage.bind(provider);
        let release!: () => void;
        const template = new Promise<void>(resolve => { release = resolve; });
        provider.getViewerPage = async (...args: any[]) => { const html = await original(...args); await template; return html; };
        const rendering = owned.render();
        const final = { position: { page: 6, offset: { top: 73, left: 9 } }, scale: '2.5' };
        try {
            assert.strictEqual(editor.page(), oldPage, 'the old viewer is still displayed while its replacement loads');
            editor.send({ type: 'saveState', page: oldPage, content: final });
        } finally { release(); }
        await rendering;
        assert.notStrictEqual(editor.page(), oldPage);
        editor.send({ type: 'ready', page: editor.page() });
        assert.deepStrictEqual(editor.received.find(message => message.type === 'initState')?.content, final,
            'replacement reads the last displayed state while durable storage is still pending');
        assert.strictEqual(storage.writes.length, 1);
        editor.send({ type: 'saveState', page: oldPage, content: first });
        editor.send({ type: 'ready', page: oldPage });
        assert.strictEqual(editor.received.filter(message => message.type === 'initState').length, 1);
        assert.deepStrictEqual(provider.viewState.read(uri.toString()), final);
    });

    it('serializes a final close write behind an older pending storage update', async () => {
        const uri = Uri.file('/home/u/ordered.pdf'), doc = await provider.openCustomDocument(uri), editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        storage.blocked = true;
        const firstStarted = storage.nextWrite();
        editor.send({ type: 'saveState', page: editor.page(), content: { position: { page: 1 } } });
        editor.hide();
        await firstStarted;
        const final = { position: { page: 8 }, scale: '2.5' };
        editor.send({ type: 'saveState', page: editor.page(), content: final });
        editor.dispose();
        assert.strictEqual(storage.writes.length, 1, 'the second durable update must wait for the first to settle');
        const secondStarted = storage.nextWrite();
        storage.writes[0].finish();
        await secondStarted;
        storage.writes[1].finish();
        await storage.writes[1].settled;
        assert.deepStrictEqual(storage.values.get('overleaf-pdf-viewers')[uri.toString()].state, final);
    });

    it('keeps a newer viewer page when an older page template finishes later', async () => {
        const doc = await provider.openCustomDocument(Uri.file('/home/u/navigation.pdf')), editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        const owned = [...provider.editors][0] as any;
        const original = provider.getViewerPage.bind(provider), gates: (() => void)[] = [];
        provider.getViewerPage = async (...args: any[]) => {
            let release!: () => void;
            const wait = new Promise<void>(resolve => { release = resolve; }); gates.push(release);
            const html = await original(...args); await wait; return html;
        };
        await doc.setEngine('overleaf');
        const first = owned.render();
        await doc.setEngine('pdfjs');
        const second = owned.render();
        gates[1](); await second;
        const current = editor.page();
        gates[0](); await first;
        assert.strictEqual(editor.page(), current);
        assert.strictEqual(viewerOf(editor.webviewPanel.webview.html), 'pdfjs');
        assert.strictEqual(editor.pages.length, 2, 'a superseded template is never assigned to the live webview');
    });

    it('keeps the latest engine setting across two editors when an older render finishes last', async () => {
        const first = panel(), second = panel();
        const firstDoc = await provider.openCustomDocument(Uri.file('/home/u/first.pdf'));
        const secondDoc = await provider.openCustomDocument(Uri.file('/home/u/second.pdf'));
        await provider.resolveCustomEditor(firstDoc, first.webviewPanel);
        await provider.resolveCustomEditor(secondDoc, second.webviewPanel);
        const original = provider.getViewerPage.bind(provider);
        let requested!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { requested = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        provider.getViewerPage = async (...args: any[]) => {
            const html = await original(...args);
            if (args[0] === first.webviewPanel.webview && args[1] === 'overleaf') { requested(); await held; }
            return html;
        };
        world.settings.engine = 'overleaf';
        const older = provider.applyEngine();
        await started;
        try {
            world.settings.engine = 'pdfjs';
            await provider.applyEngine();
        } finally { release(); }
        await older;
        assert.strictEqual(firstDoc.engine, 'pdfjs');
        assert.strictEqual(secondDoc.engine, 'pdfjs');
        assert.strictEqual(viewerOf(first.webviewPanel.webview.html), 'pdfjs');
        assert.strictEqual(viewerOf(second.webviewPanel.webview.html), 'pdfjs');
        assert.strictEqual(second.pages.length, 1, 'the obsolete configuration loop never replaces the second page');
    });

    it('sets the viewer as a user setting, and the open PDF reloads in that viewer', async () => {
        const doc = await provider.openCustomDocument(Uri.file('/home/u/paper.pdf'));
        const editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        assert.strictEqual(viewerOf(editor.webviewPanel.webview.html), 'pdfjs');

        let reloaded = editor.nextPage();
        editor.send({ type: 'switchViewer', engine: 'overleaf' });
        await reloaded;
        assert.deepStrictEqual(world.updates, [['engine', 'overleaf', 1]]);
        assert.strictEqual(doc.engine, 'overleaf');
        assert.strictEqual(viewerOf(editor.webviewPanel.webview.html), 'overleaf');

        reloaded = editor.nextPage();
        editor.send({ type: 'switchViewer', engine: 'pdfjs' });
        await reloaded;
        assert.strictEqual(viewerOf(editor.webviewPanel.webview.html), 'pdfjs');
        assert.strictEqual(editor.pages.length, 3);
    });

    it('deletes the builds that the PDF viewer of earlier versions downloaded', () => {
        // the provider's constructor asks for the delete
        assert.deepStrictEqual(world.deleted, ['/storage/legacy-viewer-builds (recursive)']);
    });

    it('opens the pdfjs viewer for a setting saved by an earlier version, such as legacy', async () => {
        world.settings = { engine: 'legacy' };
        const doc = await provider.openCustomDocument(Uri.file('/home/u/paper.pdf'));
        const editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        assert.strictEqual(doc.engine, 'pdfjs');
        assert.strictEqual(viewerOf(editor.webviewPanel.webview.html), 'pdfjs');
    });

    it('takes only the two viewers that load in ranges', async () => {
        const doc = await provider.openCustomDocument(Uri.file('/home/u/paper.pdf'));
        const editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        // switchViewer turns these away before its first await, so the handler is done when send returns
        editor.send({ type: 'switchViewer', engine: 'legacy' });
        editor.send({ type: 'switchViewer', engine: '../../evil' });
        assert.deepStrictEqual(world.updates, []);
        assert.strictEqual(editor.pages.length, 1);
    });

    it('reloads every open PDF when the setting changes, and leaves closed ones alone', async () => {
        const first = panel();
        const second = panel();
        const firstDoc = await provider.openCustomDocument(Uri.file('/home/u/a.pdf'));
        await provider.resolveCustomEditor(firstDoc, first.webviewPanel);
        const secondDoc = await provider.openCustomDocument(Uri.file('/home/u/b.pdf'));
        await provider.resolveCustomEditor(secondDoc, second.webviewPanel);
        second.dispose();

        const reloaded = first.nextPage();
        first.send({ type: 'switchViewer', engine: 'overleaf' });
        // applyEngine renders the open viewers one after another; the closed one is not among them
        await reloaded;
        assert.strictEqual(viewerOf(first.webviewPanel.webview.html), 'overleaf');
        assert.strictEqual(second.pages.length, 1);
        assert.strictEqual(viewerOf(second.webviewPanel.webview.html), 'pdfjs');
    });
});
