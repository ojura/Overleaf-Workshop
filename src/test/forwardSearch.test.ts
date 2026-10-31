/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as path from 'path';
import { loadWithVscode, strict } from './standIn';

class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '') {}
    get fsPath() { return this.path; }
    with(change: { path?: string }) { return new Uri(this.scheme, this.authority, change.path ?? this.path, this.query); }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`; }
    static joinPath(base: Uri, ...parts: string[]) { return base.with({ path: path.posix.join(base.path, ...parts) }); }
    static parse(value: string) {
        const m = /^([^:]+):\/\/([^/]*)([^?]*)(?:\?(.*))?$/.exec(value)!;
        return new Uri(m[1], m[2], decodeURIComponent(m[3]), decodeURIComponent(m[4] ?? ''));
    }
}

const disposable = { dispose() {} };
/** What the jump meets: the active editor, the messages shown, and what vscode.openWith does. */
const world = {
    activeTextEditor: undefined as unknown,
    warnings: [] as string[],
    /** the files that vscode.openWith was asked to open */
    opened: [] as string[],
    /** what VS Code does when it opens the PDF: settles when it has opened its viewer, or did not */
    openWith: async (_uri: Uri) => {},
};
const vscodeStandIn = strict('vscode', {
    Uri,
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    // classes that the extension's modules extend when they load
    TreeItem: class {},
    QuickPickItem: class {},
    MarkdownString: class { appendMarkdown() { return this; } },
    ThemeColor: class {},
    StatusBarAlignment: { Left: 1, Right: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    ViewColumn: { Beside: -2 },
    l10n: strict('vscode.l10n', {
        t: (message: string, args?: Record<string, unknown>) => message.replace(/\{(\w+)\}/g, (_m, key) => String(args?.[key] ?? `{${key}}`)),
    }),
    languages: strict('vscode.languages', { createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }) }),
    window: strict('vscode.window', {
        get activeTextEditor() { return world.activeTextEditor; },
        showWarningMessage: async (message: string) => { world.warnings.push(message); return undefined; },
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    }),
    workspace: strict('vscode.workspace', {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: (_key: string, value: unknown) => value }),
        onDidSaveTextDocument: () => disposable,
    }),
    commands: strict('vscode.commands', {
        registerCommand: () => disposable,
        executeCommand: async (command: string, uri: Uri) => {
            if (command !== 'vscode.openWith') { throw new Error(`the test has no command ${command}`); }
            world.opened.push(uri.path);
            await world.openWith(uri);
        },
    }),
});
const { CompileManager, EventBus } = loadWithVscode(vscodeStandIn, () => ({
    ...require('../compile/compileManager'),
    ...require('../utils/eventBus'),
}));

/** A PDF viewer's panel: what is posted to it, and its closing. */
class Panel {
    readonly posted: unknown[] = [];
    private readonly closing: Array<() => void> = [];
    readonly webview = { postMessage: async (message: unknown) => { this.posted.push(message); return true; } };
    onDidDispose(listener: () => void) { this.closing.push(listener); return disposable; }
    dispose() { this.closing.forEach(listener => listener()); }
}

const projectUri = Uri.parse('overleaf-workshop://www.overleaf.com/Book?user%3Du1%26project%3Dp1');
const buildUri = Uri.joinPath(projectUri, '.output/output.pdf');
/** SyncTeX's answer for the line */
const boxes = [{ page: 3, h: 72, v: 100, width: 10, height: 10 }];
/** VS Code opens the build's viewer `panel` (PdfViewEditorProvider.resolveCustomEditor) */
const viewerOpens = (panel: Panel) => EventBus.fire('pdfWillOpenEvent', { uri: buildUri, doc: {}, webviewPanel: panel });

describe('the jump from a line of the source to the PDF', () => {
    let triggers: Array<{ dispose(): void }> = [];
    let manager: any;
    beforeEach(() => {
        world.warnings = [];
        world.opened = [];
        world.openWith = async () => {};
        world.activeTextEditor = { document: { uri: Uri.joinPath(projectUri, 'main.tex') }, selection: { start: { line: 4, character: 0 } } };
        manager = new CompileManager({ prefetch: async () => ({ syncCode: async () => boxes }) });
        triggers = manager.triggers;
    });
    afterEach(() => { triggers.forEach(trigger => trigger.dispose()); });

    it('jumps in the viewer that is open', async () => {
        const panel = new Panel();
        viewerOpens(panel);
        await manager.syncCode();
        assert.deepStrictEqual(panel.posted, [{ type: 'syncCode', content: boxes }]);
        assert.deepStrictEqual(world.opened, []);
    });

    it('opens the PDF again when its viewer was closed, and jumps in the new viewer', async () => {
        const closed = new Panel();
        viewerOpens(closed);
        closed.dispose();
        const reopened = new Panel();
        world.openWith = async () => { viewerOpens(reopened); };
        await manager.syncCode();
        assert.deepStrictEqual(closed.posted, []);
        assert.deepStrictEqual(reopened.posted, [{ type: 'syncCode', content: boxes }]);
        assert.deepStrictEqual(world.opened, [buildUri.path]);
    });

    it('says at once that the jump was not made when VS Code did not open the viewer', async () => {
        // vscode.openWith settled without a viewer, as when another open overtook it
        await manager.syncCode();
        assert.deepStrictEqual(world.opened, [buildUri.path]);
        assert.deepStrictEqual(world.warnings, ['The PDF did not open, so the jump to it was not made.']);
    });

    it('says why when VS Code cannot open the PDF', async () => {
        world.openWith = async () => { throw new Error('no editor for the file'); };
        await manager.syncCode();
        assert.deepStrictEqual(world.warnings, ['The PDF could not be opened for the jump: no editor for the file']);
    });
});
