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
    constructor(readonly path: string, readonly scheme = 'file') {}
    get fsPath() { return this.path; }
    toString() { return this.scheme + '://' + this.path; }
    static file(value: string) { return new Uri(value); }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.posix.join(base.path, ...parts), base.scheme); }
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
    static exporter: ((...args: Parameters<PdfPreviewStore['exportSource']>) => ReturnType<PdfPreviewStore['exportSource']>) | undefined;
    readonly watched: Array<{ identity: PdfPreviewIdentity, callback: () => void, stopped: boolean }> = [];
    wasDisposed = false;
    constructor(root: string) { super(root); FakePreviews.current = this; }
    override watch(identity: PdfPreviewIdentity, callback: () => void) {
        this.directory(identity);
        const record = { identity, callback, stopped: false }; this.watched.push(record);
        return () => { record.stopped = true; };
    }
    override dispose() { this.wasDisposed = true; super.dispose(); }
    override exportSource(...args: Parameters<PdfPreviewStore['exportSource']>) {
        if (!FakePreviews.exporter) { throw new Error('The test did not configure an export.'); }
        return FakePreviews.exporter(...args);
    }
}
const world = {
    engine: 'pdfjs',
    commands: new Map<string, (...args: any[]) => any>(),
    settings: new Emitter<{ affectsConfiguration: (key: string) => boolean }>(),
    cancellation: new Emitter<void>(),
    progress: [] as Array<{ message?: string, increment?: number }>,
    notifications: [] as string[],
    errors: [] as string[],
};
const vscode = strict('preview host vscode', {
    Uri, EventEmitter: Emitter, ProgressLocation: { Notification: 15 },
    l10n: { t: (message: string, ...values: unknown[]) => message.replace(/\{(\d+)\}/g, (_all, index) => String(values[Number(index)])) },
    window: strict('preview host window', {
        state: { focused: true }, onDidChangeWindowState: () => disposable, registerCustomEditorProvider: () => disposable,
        showSaveDialog: async () => Uri.file('/chosen/source.pdf'),
        showInformationMessage: async (message: string) => { world.notifications.push(message); },
        showErrorMessage: async (message: string) => { world.errors.push(message); },
        withProgress: async (_options: unknown, action: (progress: any, token: any) => Promise<unknown>) =>
            action({ report: (value: any) => world.progress.push(value) }, { onCancellationRequested: world.cancellation.event }),
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
        workspaceFolders: [],
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
    readonly resources: Uri[] = [];
    readonly changes = new Emitter<{ webviewPanel: Panel }>();
    readonly closing = new Emitter<void>();
    readonly pages = new Emitter<void>();
    private receive: (message: any) => void = () => {};
    private html = '';
    readonly webview = {
        options: {} as any,
        asWebviewUri: (uri: Uri) => { this.resources.push(uri); return { toString: () => 'https://webview.test' + uri.path }; },
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
        world.cancellation = new Emitter(); world.progress = []; world.notifications = []; world.errors = []; FakePreviews.exporter = undefined;
        // Desktop profiles expose vscode-userdata storage URIs; the Node preview store serves file URIs.
        provider = new PdfViewEditorProvider({ globalStorageUri: new Uri('/preview-test-storage', 'vscode-userdata'), extensionUri: Uri.file('/extension'),
            extension: { packageJSON: { devDependencies: { 'pdfjs-dist': '5.1.91' } } } });
        triggers = provider.triggers;
        changes = new Emitter();
        doc = { uri: Uri.file('/paper.pdf'), isProjectFile: false, engine: 'pdfjs', cache: new Uint8Array(),
            output: { file: { build: 'a', size: 1024 } }, onDidChange: changes.event,
            async setEngine(engine: string) { const changed = this.engine !== engine; this.engine = engine; return changed; } };
        panel = new Panel();
        await provider.resolveCustomEditor(doc, panel);
    });
    afterEach(() => { panel.close(); triggers.forEach(trigger => trigger.dispose()); changes.dispose(); world.settings.dispose(); world.cancellation.dispose(); });

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

    it('authorizes file preview requests from virtual storage without widening the allowed roots', () => {
        panel.send({ type: 'ready' });
        const request = panel.resources.find(uri => uri.path.endsWith('/manifest.json'))!;
        assert.strictEqual(request.scheme, 'file');
        const roots = panel.webview.options.localResourceRoots as Uri[];
        // The installed workbench returns 401 unless both the scheme and directory prefix match.
        const allowed = roots.filter(root => root.scheme === request.scheme && request.fsPath.startsWith(root.fsPath + '/'));
        assert.strictEqual(allowed.length, 1, 'the actual file request must match its exact preview root');
        assert.strictEqual(allowed[0].fsPath, '/preview-test-storage/pdf-previews');
        assert.deepStrictEqual(roots.map(root => root.fsPath), ['/extension', '/preview-test-storage/pdf-previews']);
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

    it('reports missing-byte completion and file writing as distinct export phases', async () => {
        const captured = doc.output;
        FakePreviews.exporter = async (_cache, source, target, current, signal, progress) => {
            assert.strictEqual(source, captured); assert.strictEqual(current(), true); assert.strictEqual(signal?.aborted, false);
            for (const value of [{ phase: 'fetching' as const, completedBytes: 512 }, { phase: 'fetching' as const, completedBytes: 515 },
                { phase: 'fetching' as const, completedBytes: 1024 }, { phase: 'writing' as const, completedBytes: 0 }, { phase: 'writing' as const, completedBytes: 1024 }]) {
                progress?.({ ...value, totalBytes: 1024 });
            }
            return { pdfPath: target, receiptPath: target + '.preview-source.json',
                receipt: { version: 1, document: { key: 'a'.repeat(64), size: 1024, sha256: 'b'.repeat(64) }, pdf: 'source.pdf', outputDirectory: '/preview-test-storage/pdf-previews/' + 'a'.repeat(64) } };
        };
        await world.commands.get('overleaf-workshop.pdfViewer.exportPreviewSource')!(doc.uri);
        assert.deepStrictEqual(world.progress, [
            { message: 'Downloading missing PDF bytes: 50% cached' }, { message: 'Downloading missing PDF bytes: 100% cached' },
            { message: 'Writing PDF: 0%' }, { message: 'Writing PDF: 100%' },
        ]);
        assert.strictEqual(world.errors.length, 0);
        assert.strictEqual(world.notifications.length, 1);
    });

    for (const operation of ['replacement', 'close', 'cancel']) {
        it('aborts the captured export when the host receives ' + operation, async () => {
            let entered!: () => void, release!: () => void;
            const fetching = new Promise<void>(resolve => { entered = resolve; }), stopped = new Promise<void>(resolve => { release = resolve; });
            let requestSignal: AbortSignal | undefined, capturedCurrent: (() => boolean) | undefined;
            FakePreviews.exporter = async (_cache, _source, _target, current, signal) => {
                requestSignal = signal; capturedCurrent = current; entered(); await stopped;
                throw new PdfPreviewExportError(operation === 'replacement' ? 'superseded' : 'cancelled', 'Export stopped.');
            };
            const exporting = world.commands.get('overleaf-workshop.pdfViewer.exportPreviewSource')!(doc.uri);
            try {
                await fetching;
                if (operation === 'replacement') { doc.output = { file: { build: 'b', size: 1024 } }; changes.fire(); }
                if (operation === 'close') { panel.close(); }
                if (operation === 'cancel') { world.cancellation.fire(); }
                assert.strictEqual(requestSignal?.aborted, true);
                if (operation !== 'cancel') { assert.strictEqual(capturedCurrent?.(), false); }
                release(); await exporting;
                assert.strictEqual(world.errors.length, 0);
                assert.strictEqual(world.notifications.length, 1);
            } finally { release(); await exporting; }
        });
    }
});
