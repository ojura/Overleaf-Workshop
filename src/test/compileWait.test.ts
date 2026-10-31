/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import { loadWithVscode, strict } from './standIn';

const warnings: string[] = [];
const disposable = { dispose() {} };
const vscodeStandIn = strict('vscode', {
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    // classes that the extension's modules extend when they load
    TreeItem: class {},
    QuickPickItem: class {},
    MarkdownString: class { appendMarkdown() { return this; } },
    ThemeColor: class {},
    StatusBarAlignment: { Left: 1, Right: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Uri: { parse: (value: string) => ({ scheme: 'overleaf-workshop', path: '/project', query: 'user=u&project=p', toString: () => value }) },
    l10n: strict('vscode.l10n', { t: (message: string) => message }),
    languages: strict('vscode.languages', { createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }) }),
    window: strict('vscode.window', {
        activeTextEditor: undefined,
        showWarningMessage: async (message: string) => { warnings.push(message); return undefined; },
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    }),
    workspace: strict('vscode.workspace', {
        workspaceFolders: undefined,
        saveAll: async () => true,
        getConfiguration: () => ({ get: (_key: string, value: unknown) => value }),
    }),
    commands: strict('vscode.commands', {
        // the compile of a project from a folder, which reads no log
        executeCommand: async (command: string) => { throw new Error(`the test has no command ${command}`); },
    }),
});
const { CompileManager, LocalReplicaSCMProvider, EventBus } = loadWithVscode(vscodeStandIn, () => ({
    ...require('../compile/compileManager'),
    ...require('../scm/localReplicaSCM'),
    ...require('../utils/eventBus'),
}));

/** The end of the next compile in the window. */
const compileEnd = () => new Promise<any>(resolve => {
    const listener = EventBus.on('compileEndedEvent', (event: any) => { listener.dispose(); resolve(event); });
});

describe('CompileManager with a local replica', () => {
    const flushAll = LocalReplicaSCMProvider.flushAll;
    const readSettings = LocalReplicaSCMProvider.readSettings;
    const waitMs = CompileManager.uploadWaitMs;
    afterEach(() => {
        LocalReplicaSCMProvider.flushAll = flushAll;
        LocalReplicaSCMProvider.readSettings = readSettings;
        CompileManager.uploadWaitMs = waitMs;
        warnings.length = 0;
    });

    function setup(flush: () => Promise<void>, { replica = true } = {}) {
        const events: string[] = [];
        LocalReplicaSCMProvider.readSettings = async () => (replica ? { uri: 'overleaf-workshop://server/project?user=u&project=p', enableCompileNPreview: true } : undefined);
        LocalReplicaSCMProvider.flushAll = async () => { events.push('flush started'); await flush(); events.push('flush done'); };
        const vfs = {
            getRootDocName: () => '/main.tex',
            getCompiler: () => ({ name: 'pdfLaTeX' }),
            _resolveUri: async () => ({ fileType: 'folder', fileId: 'root' }),
            // nothing changed since the last compile: no log to read
            compile: async (_force: boolean, _draft: boolean, _stop: boolean, _root: string, fromScratch?: boolean) => {
                events.push(fromScratch ? 'compile from scratch' : 'compile');
                return undefined;
            },
        };
        const manager = new CompileManager({ prefetch: async () => vfs });
        return { events, manager };
    }

    it('compiles only after the local changes have been uploaded', async () => {
        let release!: () => void;
        let flushing!: () => void;
        const flushStarted = new Promise<void>(resolve => { flushing = resolve; });
        const { events, manager } = setup(() => { flushing(); return new Promise<void>(resolve => { release = resolve; }); });
        const ended = compileEnd();
        assert.strictEqual(await manager.compile(true), 'started');
        await flushStarted;
        assert.deepStrictEqual(events, ['flush started'], 'the compile waits for the uploads');
        release();
        await ended;
        assert.deepStrictEqual(events, ['flush started', 'flush done', 'compile']);
    });

    it('clears the compile output on Overleaf only for Recompile from Scratch', async () => {
        const { events, manager } = setup(async () => {});
        let ended = compileEnd();
        await manager.compile(true);
        await ended;
        ended = compileEnd();
        await manager.compile(true, true);
        await ended;
        assert.deepStrictEqual(events.filter(e => e.startsWith('compile')), ['compile', 'compile from scratch']);
    });

    it('compiles anyway when the uploads take too long, and says so', async () => {
        CompileManager.uploadWaitMs = 20;
        const { events, manager } = setup(() => new Promise<void>(() => {}));
        const ended = compileEnd();
        await manager.compile(true);
        assert.deepStrictEqual((await ended).outcome, { result: 'skipped' });
        assert.deepStrictEqual(events, ['flush started', 'compile']);
        assert.strictEqual(warnings.length, 1);
    });

    it('answers that it is busy while a compile runs, and reports the end once', async () => {
        let release!: () => void;
        const { manager } = setup(() => new Promise<void>(resolve => { release = resolve; }));
        const ended = compileEnd();
        assert.strictEqual(await manager.compile(true), 'started');
        assert.strictEqual(await manager.compile(true), 'busy');
        release();
        await ended;
        assert.strictEqual(manager.inCompiling, false);
    });

    it('answers that no compile is available without a project to compile', async () => {
        const { manager } = setup(async () => {}, { replica: false });
        assert.strictEqual(await manager.compile(true), 'unavailable');
        assert.strictEqual(manager.inCompiling, false);
    });
});
