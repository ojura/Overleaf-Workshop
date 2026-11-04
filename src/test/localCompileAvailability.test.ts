/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as path from 'path';
import { loadWithVscode, strict } from './standIn';

class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '') {}
    get fsPath() { return this.path; }
    with(change: { path?: string }) { return new Uri(this.scheme, this.authority, change.path ?? this.path, this.query); }
    toString() { return this.scheme + '://' + this.authority + this.path + (this.query ? '?' + this.query : ''); }
    static file(file: string) { return new Uri('file', '', file); }
    static joinPath(base: Uri, ...parts: string[]) { return base.with({ path: path.posix.join(base.path, ...parts) }); }
    static parse(value: string) {
        const match = /^([^:]+):\/\/([^/]*)([^?]*)(?:\?(.*))?$/.exec(value);
        if (!match) { throw new Error('Invalid URI'); }
        return new Uri(match[1], match[2], decodeURIComponent(match[3]), decodeURIComponent(match[4] ?? ''));
    }
}

class Signal<T> {
    resolve!: (value: T) => void;
    reject!: (error: Error) => void;
    readonly promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
}

class Listeners<T> {
    readonly handlers = new Set<(event: T) => unknown>();
    readonly event = (handler: (event: T) => unknown) => {
        this.handlers.add(handler);
        return { dispose: () => this.handlers.delete(handler) };
    };
    async fire(event: T) { await Promise.all([...this.handlers].map(handler => handler(event))); }
}

const ROOT = Uri.file('/workspace/Book');
const PROJECT = Uri.parse('overleaf-workshop://www.overleaf.com/Book?user=u&project=p');
const SOURCE = Uri.joinPath(ROOT, 'chapters', 'chapter.tex');
const CONTEXT = 'overleaf-workshop.activateCompile';
const DEBUG_SETTING = 'overleaf-workshop.debug.disableLocalReplicaCompilePreview';

/** The extension host's events, settings and network answer, controlled by each test. */
function scenario() {
    const editorChanged = new Listeners<unknown>();
    const foldersChanged = new Listeners<unknown>();
    const configChanged = new Listeners<{ affectsConfiguration(section: string): boolean }>();
    const saved = new Listeners<unknown>();
    const joined = new Signal<void>();
    const joinStarted = new Signal<void>();
    const errorReported = new Signal<string>();
    const startupRejected = new Signal<Error>();
    const settingsContinuations: Promise<unknown>[] = [];
    const subscriptions: Array<{ dispose(): void }> = [];
    const closeViewers: Array<() => Promise<void>> = [];
    const contexts = new Map<string, unknown>();
    const commands = new Map<string, (...args: any[]) => unknown>();
    const opened: Uri[] = [];
    const errors: string[] = [];
    const configurationReads: Array<{ section: string, resource?: Uri, key: string }> = [];
    const world = {
        settings: { uri: PROJECT.toString(), enableCompileNPreview: false } as any,
        folders: [{ uri: ROOT }] as Array<{ uri: Uri }> | undefined,
        editor: { document: { uri: SOURCE } } as any,
        disableLocalCompile: false,
        compileOnSave: true,
        joins: 0,
    };
    const vfs = {
        init: () => { world.joins++; joinStarted.resolve(); return joined.promise; },
        isInvisibleMode: false,
        getRootDocName: () => '/main.tex',
        getCompiler: () => ({ name: 'pdfLaTeX' }),
    };
    class EmptyProvider { readonly triggers: Array<{ dispose(): void }> = []; }
    class RemoteProvider extends EmptyProvider {
        async prefetch() { return vfs; }
    }
    class Replica {
        static readSettings() {
            const setting = world.folders?.length === 1 && world.folders[0].uri.scheme === 'file' ? world.settings : undefined;
            // Observe the startup continuation that the original activate() discarded, so its
            // rejected join can be asserted and cleaned up without an unhandled test rejection.
            return {
                then(fulfilled: (value: any) => unknown, rejected?: (error: unknown) => unknown) {
                    const continued = Promise.resolve(setting).then(fulfilled, rejected);
                    settingsContinuations.push(continued);
                    void continued.catch(error => startupRejected.resolve(error));
                    return continued;
                },
            };
        }
        static async flushAll() {}
        static async syncNowCommand() {}
    }
    const disposable = { dispose() {} };
    const vscode = strict('vscode', {
        Uri,
        Disposable: class { dispose() {} },
        EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
        TreeItem: class {},
        QuickPickItem: class {},
        MarkdownString: class { appendMarkdown() { return this; } },
        ThemeColor: class {},
        StatusBarAlignment: { Left: 1, Right: 2 },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        ViewColumn: { Beside: -2 },
        l10n: strict('vscode.l10n', {
            t: (message: string, args?: Record<string, unknown>) =>
                message.replace(/\{(\w+)\}/g, (match, key) => String(args?.[key] ?? match)),
        }),
        languages: strict('vscode.languages', {
            createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }),
        }),
        window: strict('vscode.window', {
            get activeTextEditor() { return world.editor; },
            onDidChangeActiveTextEditor: editorChanged.event,
            createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
            showErrorMessage: async (message: string) => { errors.push(message); errorReported.resolve(message); },
            showWarningMessage: async (message: string) => { errors.push(message); errorReported.resolve(message); },
        }),
        workspace: strict('vscode.workspace', {
            get workspaceFolders() { return world.folders; },
            onDidChangeWorkspaceFolders: foldersChanged.event,
            onDidChangeConfiguration: configChanged.event,
            onDidSaveTextDocument: saved.event,
            saveAll: async () => true,
            getConfiguration: (section: string, resource?: Uri) => ({
                get: (key: string, fallback: unknown) => {
                    configurationReads.push({ section, resource, key });
                    if (section === 'overleaf-workshop.debug' && key === 'disableLocalReplicaCompilePreview') {
                        return world.disableLocalCompile;
                    }
                    if (section === 'overleaf-workshop.compileOnSave' && key === 'enabled') { return world.compileOnSave; }
                    return fallback;
                },
            }),
        }),
        commands: strict('vscode.commands', {
            registerCommand: (name: string, handler: (...args: any[]) => unknown) => {
                commands.set(name, handler);
                return { dispose: () => commands.delete(name) };
            },
            executeCommand: async (name: string, ...args: any[]) => {
                if (name === 'setContext') { contexts.set(args[0], args[1]); return; }
                if (name === 'remoteFileSystem.prefetch') { return vfs; }
                if (name === 'vscode.openWith') { opened.push(args[0]); return; }
                throw new Error('Unexpected command: ' + name);
            },
        }),
    });
    const loaded = loadWithVscode(vscode, () => ({
        ...require('../extension'),
        ...require('../compile/compileManager'),
        ...require('../utils/eventBus'),
    }), {
        './core/remoteFileSystemProvider': { RemoteFileSystemProvider: RemoteProvider },
        '../core/remoteFileSystemProvider': {
            parseUri: (uri: Uri) => ({
                identifier: uri.authority + '?' + uri.query,
                pathParts: uri.path.split('/').slice(2),
                projectId: new URLSearchParams(uri.query).get('project'),
            }),
        },
        './core/projectManagerProvider': { ProjectManagerProvider: EmptyProvider },
        './core/pdfViewEditorProvider': { PdfViewEditorProvider: EmptyProvider },
        './intellisense': { LangIntellisenseProvider: EmptyProvider },
        './scm/localReplicaSCM': { LocalReplicaSCMProvider: Replica },
        '../scm/localReplicaSCM': { LocalReplicaSCMProvider: Replica },
    });
    return {
        world, contexts, commands, opened, errors, configurationReads, joined, joinStarted, errorReported, startupRejected,
        editorChanged, foldersChanged, configChanged, saved,
        check: (uri?: Uri) => loaded.CompileManager.check(uri),
        activate: () => loaded.activate({ subscriptions }),
        manager: () => {
            const manager = new loaded.CompileManager(new RemoteProvider());
            subscriptions.push(...manager.triggers);
            return manager;
        },
        openViewer: (uri: Uri) => {
            const closing = new Listeners<void>();
            const panel = { active: true, visible: true, onDidDispose: closing.event };
            loaded.EventBus.fire('pdfWillOpenEvent', { uri, doc: { uri }, webviewPanel: panel });
            const close = () => closing.fire();
            closeViewers.push(close);
            return { panel, close };
        },
        async dispose() {
            joined.resolve();
            await Promise.allSettled(settingsContinuations);
            await Promise.all(closeViewers.map(close => close()));
            subscriptions.forEach(subscription => subscription.dispose());
        },
    };
}

describe('manual compile and preview for a local replica', () => {
    let host: ReturnType<typeof scenario>;
    beforeEach(() => { host = scenario(); });
    afterEach(async () => host.dispose());

    for (const legacy of [false, undefined]) {
        it('accepts a replica whose legacy compile flag is ' + String(legacy), async () => {
            host.world.settings = legacy === undefined ? { uri: PROJECT.toString() } : { uri: PROJECT.toString(), enableCompileNPreview: legacy };
            assert.strictEqual((await host.check(SOURCE))?.toString(), PROJECT.toString());
        });
    }

    it('uses the workspace project when a PDF webview has left the text editor inactive', async () => {
        host.world.editor = undefined;
        assert.strictEqual((await host.check())?.toString(), PROJECT.toString());
    });

    it('rejects unrelated local files, a sibling folder and the replica own folders', async () => {
        host.world.settings.enableCompileNPreview = true;
        for (const file of ['/elsewhere/main.tex', '/workspace/Book-backup/main.tex', '/workspace/Book/.overleaf/scratch.tex', '/workspace/Book/.git/message.tex']) {
            assert.strictEqual(await host.check(Uri.file(file)), undefined, file);
        }
    });

    it('rejects non-project URI schemes even when a local replica is open', async () => {
        host.world.settings.enableCompileNPreview = true;
        assert.strictEqual(await host.check(new Uri('untitled', '', '/new.tex')), undefined);
        assert.strictEqual(await host.check(new Uri('git', '', SOURCE.path)), undefined);
    });

    it('keeps direct remote project resources available without a local workspace', async () => {
        host.world.folders = undefined;
        const remote = Uri.joinPath(PROJECT, 'main.tex');
        assert.strictEqual(await host.check(remote), remote);
    });

    it('does not recognize a plain folder or a multi-folder workspace as one replica', async () => {
        host.world.settings = undefined;
        assert.strictEqual(await host.check(SOURCE), undefined);
        host.world.settings = { uri: PROJECT.toString(), enableCompileNPreview: true };
        host.world.folders = [{ uri: ROOT }, { uri: Uri.file('/elsewhere') }];
        assert.strictEqual(await host.check(SOURCE), undefined);
    });

    it('does not use a malformed or non-Overleaf project URI from replica settings', async () => {
        for (const uri of ['not a URI', 'https://example.test/project']) {
            host.world.settings = { uri, enableCompileNPreview: true };
            assert.strictEqual(await host.check(SOURCE), undefined);
        }
    });

    it('uses the advanced debug option for the local replica, while remote resources remain available', async () => {
        host.world.settings.enableCompileNPreview = true;
        host.world.disableLocalCompile = true;
        assert.strictEqual(await host.check(SOURCE), undefined);
        host.world.editor = undefined;
        assert.strictEqual(await host.check(), undefined);
        const remote = Uri.joinPath(PROJECT, 'main.tex');
        assert.strictEqual(await host.check(remote), remote);
        const reads = host.configurationReads.filter(read => read.key === 'disableLocalReplicaCompilePreview');
        assert.ok(reads.length > 0);
        assert.ok(reads.every(read => read.resource?.toString() === ROOT.toString()));
    });

    it('opens the PDF for the editor-title command target even when another project has the active editor', async () => {
        host.world.settings.enableCompileNPreview = true;
        host.world.editor = { document: { uri: Uri.parse('overleaf-workshop://www.overleaf.com/Other/main.tex?user=u&project=other') } };
        host.manager();
        await host.commands.get('overleaf-workshop.compileManager.viewPdf')!(SOURCE);
        assert.deepStrictEqual(host.opened.map(uri => uri.toString()), [Uri.joinPath(PROJECT, '.output', 'output.pdf').toString()]);
    });

    for (const command of ['compile', 'recompileFromScratch']) {
        it(command + ' uses the active PDF project when no editor-title target is provided', async () => {
            host.world.editor = { document: { uri: Uri.file('/unrelated/main.tex') } };
            host.world.folders = [{ uri: Uri.file('/unrelated') }];
            host.world.settings = undefined;
            const manager = host.manager();
            const pdf = Uri.joinPath(PROJECT, '.output', 'output.pdf');
            const viewer = host.openViewer(pdf);
            const calls: unknown[][] = [];
            manager.compile = async (...args: unknown[]) => { calls.push(args); };
            const run = host.commands.get('overleaf-workshop.compileManager.' + command)!;
            await run();
            assert.deepStrictEqual(calls.pop(), [true, command === 'recompileFromScratch', pdf]);
            viewer.panel.active = false;
            await run();
            assert.deepStrictEqual(calls.pop(), [true, command === 'recompileFromScratch', undefined], 'an inactive viewer does not redirect a command');
            viewer.panel.active = true;
            await viewer.close();
            await run();
            assert.deepStrictEqual(calls.pop(), [true, command === 'recompileFromScratch', undefined], 'a closed viewer does not redirect a command');
        });

        it(command + ' keeps an explicit command target ahead of the active PDF', async () => {
            const manager = host.manager();
            host.openViewer(Uri.joinPath(PROJECT, '.output', 'output.pdf'));
            const explicit = Uri.parse('overleaf-workshop://www.overleaf.com/Other/main.tex?user=u&project=other');
            const calls: unknown[][] = [];
            manager.compile = async (...args: unknown[]) => { calls.push(args); };
            await host.commands.get('overleaf-workshop.compileManager.' + command)!(explicit);
            assert.deepStrictEqual(calls, [[true, command === 'recompileFromScratch', explicit]]);
        });
    }

    it('continues to obey the separate compile-on-save preference', async () => {
        const manager = host.manager();
        const compiles: Uri[] = [];
        manager.compile = async (_force: boolean, _fromScratch: boolean, target: Uri) => { compiles.push(target); };
        host.world.compileOnSave = false;
        const document = { uri: SOURCE, fileName: SOURCE.fsPath };
        await host.saved.fire(document);
        assert.strictEqual(compiles.length, 0);
        assert.strictEqual((await host.check(SOURCE))?.toString(), PROJECT.toString(), 'manual commands remain available');
        host.world.compileOnSave = true;
        host.world.editor = { document: { uri: Uri.parse('overleaf-workshop://www.overleaf.com/Other/main.tex?user=u&project=other') } };
        await host.saved.fire(document);
        assert.deepStrictEqual(compiles.map(uri => uri.toString()), [PROJECT.toString()], 'the saved document determines the project');
        await host.saved.fire({ uri: Uri.file('/elsewhere/main.tex'), fileName: '/elsewhere/main.tex' });
        assert.strictEqual(compiles.length, 1, 'saving an unrelated document does not compile this project');
    });
});

describe('local replica command context during extension activation', () => {
    let host: ReturnType<typeof scenario>;
    beforeEach(() => { host = scenario(); });
    afterEach(async () => host.dispose());

    for (const legacy of [false, undefined]) {
        it('shows compile and preview before the network answers with legacy flag ' + String(legacy), async () => {
            host.world.settings = legacy === undefined ? { uri: PROJECT.toString() } : { uri: PROJECT.toString(), enableCompileNPreview: legacy };
            void host.activate();
            await host.joinStarted.promise;
            assert.strictEqual(host.contexts.get('overleaf-workshop.activate'), true);
            assert.strictEqual(host.contexts.get(CONTEXT), true);
        });
    }

    it('reports a failed project initialization while keeping recognized replica commands available', async () => {
        void host.activate();
        await host.joinStarted.promise;
        const result = Promise.race([
            host.errorReported.promise.then(message => ({ kind: 'reported', message })),
            host.startupRejected.promise.then(error => ({ kind: 'rejected', message: error.message })),
        ]);
        host.joined.reject(new Error('the project join was refused'));
        const outcome = await result;
        assert.strictEqual(outcome.kind, 'reported');
        assert.match(outcome.message, /the project join was refused/);
        assert.strictEqual(host.contexts.get(CONTEXT), true);
        assert.strictEqual(host.world.joins, 1);
    });

    it('updates local availability when the debug option changes without waiting for the project join', async () => {
        void host.activate();
        await host.joinStarted.promise;
        assert.strictEqual(host.contexts.get(CONTEXT), true);
        host.world.disableLocalCompile = true;
        await host.configChanged.fire({ affectsConfiguration: section => section === DEBUG_SETTING });
        assert.strictEqual(host.contexts.get(CONTEXT), false);
        assert.strictEqual(host.contexts.get('overleaf-workshop.activate'), true);
        host.world.disableLocalCompile = false;
        await host.configChanged.fire({ affectsConfiguration: section => section === DEBUG_SETTING });
        assert.strictEqual(host.contexts.get(CONTEXT), true);
        assert.strictEqual(host.world.joins, 1);
    });

    it('updates the toolbar for the active editor and returns to the replica when its PDF has focus', async () => {
        void host.activate();
        await host.joinStarted.promise;
        host.world.editor = { document: { uri: Uri.file('/elsewhere/main.tex') } };
        await host.editorChanged.fire(host.world.editor);
        assert.strictEqual(host.contexts.get(CONTEXT), false);
        const remote = Uri.joinPath(PROJECT, 'main.tex');
        host.world.editor = { document: { uri: remote } };
        await host.editorChanged.fire(host.world.editor);
        assert.strictEqual(host.contexts.get(CONTEXT), false, 'remote editors use their resource-scheme menu condition');
        assert.strictEqual(await host.check(remote), remote);
        host.world.editor = undefined;
        await host.editorChanged.fire(undefined);
        assert.strictEqual(host.contexts.get(CONTEXT), true);
        assert.strictEqual(host.world.joins, 1);
    });
});
