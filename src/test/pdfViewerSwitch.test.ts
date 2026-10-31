/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as path from 'path';
import Module = require('module');

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
    configListeners: [] as ((e: { affectsConfiguration(section: string): boolean }) => void)[],
};
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
    window: withStubs({ registerCustomEditorProvider: () => ({ dispose() {} }) }),
    workspace: withStubs({
        getConfiguration: () => ({
            get: (key: string, value: unknown) => (key in world.settings ? world.settings[key] : value),
            update: async (key: string, value: unknown, target: unknown) => {
                world.updates.push([key, value, target]);
                world.settings[key] = value;
                const section = `overleaf-workshop.pdfViewer.${key}`;
                world.configListeners.forEach(listener => listener({ affectsConfiguration: (s: string) => section === s || section.startsWith(`${s}.`) }));
            },
        }),
        onDidChangeConfiguration: (listener: any) => { world.configListeners.push(listener); return { dispose() {} }; },
        fs: withStubs({
            stat: async () => ({ type: 1 }),
            readFile: async (uri: Uri) => {
                // the extension host's readFile gives a Buffer, which the provider turns into text
                const page = /\/dist\/(\w+)\.html$/.exec(uri.path);
                return Buffer.from(page ? `<html><head><!--viewer-config--></head><body>the ${page[1]} viewer</body></html>` : '%PDF-1.7 whole');
            },
        }),
    }),
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { PdfViewEditorProvider } = require('../core/pdfViewEditorProvider');
moduleAny._load = originalLoad;
for (const key of Object.keys(require.cache)) {
    if (/[\\/]out[\\/](?!test[\\/])/.test(key)) { delete require.cache[key]; }
}

/** a webview panel that records its pages, and through which the test sends the page's messages */
function panel() {
    const pages: string[] = [];
    let onMessage: (message: any) => void = () => {};
    let onDispose: () => void = () => {};
    const webview = {
        options: {},
        set html(value: string) { pages.push(value); },
        get html() { return pages.at(-1) ?? ''; },
        asWebviewUri: (uri: Uri) => uri,
        postMessage: async () => true,
        onDidReceiveMessage: (listener: (message: any) => void) => { onMessage = listener; return { dispose() {} }; },
    };
    return {
        pages,
        send: (message: any) => onMessage(message),
        dispose: () => onDispose(),
        webviewPanel: { webview, onDidDispose: (listener: () => void) => { onDispose = listener; }, onDidChangeViewState: () => ({ dispose() {} }) },
    };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 10));
const viewerOf = (page: string | undefined) => /the (\w+) viewer/.exec(page ?? '')?.[1];

describe('the button that switches between the pdfjs and the overleaf viewer', () => {
    let provider: any;
    beforeEach(() => {
        world.settings = { engine: 'pdfjs' };
        world.updates = [];
        world.configListeners = [];
        provider = new PdfViewEditorProvider({ extensionUri: Uri.file('/ext'), globalStorageUri: Uri.file('/storage') });
        void provider.triggers;
    });

    it('sets the viewer as a user setting, and the open PDF reloads in that viewer', async () => {
        const doc = await provider.openCustomDocument(Uri.file('/home/u/paper.pdf'));
        const editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        assert.strictEqual(viewerOf(editor.webviewPanel.webview.html), 'pdfjs');

        editor.send({ type: 'switchViewer', engine: 'overleaf' });
        await settled();
        assert.deepStrictEqual(world.updates, [['engine', 'overleaf', 1]]);
        assert.strictEqual(doc.engine, 'overleaf');
        assert.strictEqual(viewerOf(editor.webviewPanel.webview.html), 'overleaf');

        editor.send({ type: 'switchViewer', engine: 'pdfjs' });
        await settled();
        assert.strictEqual(viewerOf(editor.webviewPanel.webview.html), 'pdfjs');
        assert.strictEqual(editor.pages.length, 3);
    });

    it('takes only the two viewers that load in ranges', async () => {
        const doc = await provider.openCustomDocument(Uri.file('/home/u/paper.pdf'));
        const editor = panel();
        await provider.resolveCustomEditor(doc, editor.webviewPanel);
        editor.send({ type: 'switchViewer', engine: 'legacy' });
        editor.send({ type: 'switchViewer', engine: '../../evil' });
        await settled();
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

        first.send({ type: 'switchViewer', engine: 'overleaf' });
        await settled();
        assert.strictEqual(viewerOf(first.webviewPanel.webview.html), 'overleaf');
        assert.strictEqual(second.pages.length, 1);
        assert.strictEqual(viewerOf(second.webviewPanel.webview.html), 'pdfjs');
    });
});
