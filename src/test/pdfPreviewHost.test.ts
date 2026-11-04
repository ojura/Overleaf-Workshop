/* eslint-disable @typescript-eslint/naming-convention -- mirrors the VS Code API */
import * as assert from 'assert';
import * as path from 'path';
import { PdfPreviewExportError, PdfPreviewStore } from '../core/pdfPreviewStore';
import type { PdfPreviewIdentity } from '../core/viewerProtocol';
import { loadWithVscode, strict } from './standIn';

const disposable = { dispose() {} };
class Emitter<T> {
    private readonly listeners = new Set<(event: T) => void>();
    event = (listener: (event: T) => void) => { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; };
    fire(value: T) { for (const listener of [...this.listeners]) { listener(value); } }
    dispose() { this.listeners.clear(); }
}
class Uri {
    readonly scheme = 'file';
    constructor(readonly path: string) {}
    get fsPath() { return this.path; }
    toString() { return 'file://' + this.path; }
    static file(value: string) { return new Uri(value); }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.posix.join(base.path, ...parts)); }
}
class FakeCache {
    static invalid = false;
    previewIdentity(output: any) { return { key: FakeCache.invalid ? '../outside' : output.file.build.repeat(64), size: output.file.size }; }
    onChange() { return () => {}; }
    async snapshot() { return { covered: 0, total: 1024, bytes: 0, maxBytes: 4096, filling: false, complete: false }; }
    dispose() {}
}
class FakePreviews extends PdfPreviewStore {
    static current: FakePreviews;
    readonly watched: Array<{ identity: PdfPreviewIdentity, callback: () => void, stopped: boolean }> = [];
    wasDisposed = false;
    constructor(root: string) { super(root); FakePreviews.current = this; }
    override watch(identity: PdfPreviewIdentity, callback: () => void) {
        this.directory(identity);
        const record = { identity, callback, stopped: false }; this.watched.push(record);
        return () => { record.stopped = true; };
    }
    override dispose() { this.wasDisposed = true; super.dispose(); }
}
const world = {
    engine: 'pdfjs',
    commands: new Map<string, (...args: any[]) => any>(),
    settings: new Emitter<{ affectsConfiguration: (key: string) => boolean }>(),
};
const vscode = strict('preview host vscode', {
    Uri, EventEmitter: Emitter,
    window: strict('preview host window', {
        state: { focused: true }, onDidChangeWindowState: () => disposable, registerCustomEditorProvider: () => disposable,
    }),
    commands: strict('preview host commands', {
        registerCommand: (name: string, callback: (...args: any[]) => any) => {
            world.commands.set(name, callback); return { dispose: () => { world.commands.delete(name); } };
        },
    }),
    workspace: strict('preview host workspace', {
        getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'engine' ? world.engine : fallback }),
        onDidChangeConfiguration: (listener: (event: { affectsConfiguration: (key: string) => boolean }) => void) => world.settings.event(listener),
        fs: { delete: async () => {}, readFile: async () => Buffer.from('<html>viewer</html>') },
    }),
});
const { PdfViewEditorProvider } = loadWithVscode(vscode, () => require('../core/pdfViewEditorProvider'), {
    './remoteFileSystemProvider': { parseUri: () => ({ pathParts: [] }) },
    '../utils/eventBus': { EventBus: { fire() {} } },
    '../utils/globalStateManager': { GlobalStateManager: { getPdfViewPersist: () => ({}), updatePdfViewPersist() {} } },
    './pdfViewerPages': { completeViewerPage: (_template: string, options: any) => '<html>' + options.page + '</html>', isBuildPath: () => false },
    './pdfPreviewStore': { PdfPreviewStore: FakePreviews, PdfPreviewExportError },
    './pdfFetchBridge': {
        PieceCache: FakeCache, outputsOf: () => () => true,
        PdfFetchBridge: class { static fetchRange() {} setOutput() {} setActivity() {} dispose() {} },
    },
});

class Panel {
    active = true;
    visible = true;
    readonly posted: any[] = [];
    readonly changes = new Emitter<{ webviewPanel: Panel }>();
    readonly closing = new Emitter<void>();
    readonly pages = new Emitter<void>();
    private receive: (message: any) => void = () => {};
    private html = '';
    readonly webview = {
        options: {} as any,
        asWebviewUri: (uri: Uri) => ({ toString: () => 'https://webview.test' + uri.path }),
        postMessage: async (message: any) => { this.posted.push(message); return true; },
        onDidReceiveMessage: (callback: (message: any) => void) => { this.receive = callback; return disposable; },
        get html() { return ''; },
        set html(_value: string) {},
    };
    constructor() {
        Object.defineProperty(this.webview, 'html', { get: () => this.html, set: value => { this.html = value; this.pages.fire(); } });
    }
    onDidDispose = this.closing.event;
    onDidChangeViewState = this.changes.event;
    send(message: any) { this.receive(message); }
    close() { this.closing.fire(); }
    nextPage() { return new Promise<void>(resolve => { const stop = this.pages.event(() => { stop.dispose(); resolve(); }); }); }
}

describe('host preview binding lifecycle', () => {
    let provider: any, panel: Panel, doc: any, changes: Emitter<void>, triggers: Array<{ dispose(): void }>;
    beforeEach(async () => {
        world.engine = 'pdfjs'; world.commands.clear(); world.settings = new Emitter(); FakeCache.invalid = false;
        provider = new PdfViewEditorProvider({ globalStorageUri: Uri.file('/preview-test-storage'), extensionUri: Uri.file('/extension'),
            extension: { packageJSON: { devDependencies: { 'pdfjs-dist': '5.1.91' } } } });
        triggers = provider.triggers;
        changes = new Emitter();
        doc = { uri: Uri.file('/paper.pdf'), isProjectFile: false, engine: 'pdfjs', cache: new Uint8Array(),
            output: { file: { build: 'a', size: 1024 } }, onDidChange: changes.event,
            async setEngine(engine: string) { const changed = this.engine !== engine; this.engine = engine; return changed; } };
        panel = new Panel();
        await provider.resolveCustomEditor(doc, panel);
    });
    afterEach(() => { panel.close(); triggers.forEach(trigger => trigger.dispose()); changes.dispose(); world.settings.dispose(); });

    it('binds descriptors and notifications to the exact output and current engine page', async () => {
        const previews = FakePreviews.current;
        panel.send({ type: 'ready' });
        const load = panel.posted.find(message => message.type === 'load');
        assert.deepStrictEqual(load.preview.identity, { key: 'a'.repeat(64), size: 1024 });
        assert.strictEqual(load.preview.manifestUrl, 'https://webview.test/preview-test-storage/pdf-previews/' + 'a'.repeat(64) + '/manifest.json');
        assert.deepStrictEqual(panel.webview.options.localResourceRoots.map((uri: Uri) => uri.path), ['/extension', '/preview-test-storage/pdf-previews']);
        assert.ok(world.commands.has('overleaf-workshop.pdfViewer.exportPreviewSource'));
        const first = previews.watched[0]; first.callback();
        const firstMessage = panel.posted.find(message => message.type === 'previewChanged');
        assert.strictEqual(firstMessage.key, 'a'.repeat(64));
        doc.output = { file: { build: 'b', size: 2048 } }; changes.fire();
        assert.strictEqual(first.stopped, true);
        const count = () => panel.posted.filter(message => message.type === 'previewChanged').length;
        first.callback(); assert.strictEqual(count(), 1, 'a delayed old-build callback is fenced');
        const second = previews.watched[1]; second.callback(); assert.strictEqual(count(), 2);
        const page = panel.nextPage(); world.engine = 'overleaf';
        world.settings.fire({ affectsConfiguration: key => key === 'overleaf-workshop.pdfViewer.engine' });
        await page;
        assert.strictEqual(second.stopped, true);
        second.callback(); assert.strictEqual(count(), 2, 'the retired webview cannot receive publication updates');
        panel.send({ type: 'ready' });
        previews.watched[2].callback();
        const last = panel.posted.filter(message => message.type === 'previewChanged').at(-1);
        assert.notStrictEqual(last.page, firstMessage.page);
        assert.strictEqual(last.key, 'b'.repeat(64));
    });

    it('withdraws watches on a repeated load, whole-data fallback and disposal', () => {
        const previews = FakePreviews.current;
        panel.send({ type: 'ready' }); const first = previews.watched[0];
        panel.send({ type: 'ready' }); const second = previews.watched[1];
        assert.strictEqual(first.stopped, true);
        first.callback();
        assert.strictEqual(panel.posted.some(message => message.type === 'previewChanged'), false);
        doc.output = undefined; doc.cache = new Uint8Array([1, 2]); changes.fire();
        assert.strictEqual(second.stopped, true);
        second.callback();
        assert.strictEqual(panel.posted.at(-1).type, 'update');
        doc.output = { file: { build: 'b', size: 2048 } }; changes.fire();
        const third = previews.watched[2]; panel.close(); third.callback();
        assert.strictEqual(third.stopped, true);
        assert.strictEqual(panel.posted.some(message => message.type === 'previewChanged'), false);
        triggers[0].dispose();
        assert.strictEqual(previews.wasDisposed, true);
    });

    it('does not expose a descriptor for a path outside the canonical key namespace', () => {
        FakeCache.invalid = true;
        panel.send({ type: 'ready' });
        assert.strictEqual(panel.posted.find(message => message.type === 'load').preview, undefined);
        assert.strictEqual(FakePreviews.current.watched.length, 0);
    });
});
