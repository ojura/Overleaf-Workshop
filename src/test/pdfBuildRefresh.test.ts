/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' exports and Overleaf's fields */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { Build, BuildsHost, CompileSettings, LatestAnswer } from '../core/projectBuilds';
import { loadWithVscode, strict } from './standIn';

/** Finish promise continuations from an observed UI event, without advancing elapsed time. */
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
const disposable = { dispose() {} };
const MAIN: CompileSettings = { rootResourcePath: 'main.tex', draft: false, stopOnFirstError: false };

class Clock {
    private now = 0;
    private readonly jobs = new Set<{ at: number, callback: () => void }>();
    after(ms: number, callback: () => void) {
        const job = { at: this.now + ms, callback };
        this.jobs.add(job);
        return () => { this.jobs.delete(job); };
    }
    get pending() { return this.jobs.size; }
    async advance(ms: number) {
        const end = this.now + ms;
        for (;;) {
            const next = [...this.jobs].sort((a, b) => a.at - b.at)[0];
            if (!next || next.at > end) { break; }
            this.now = next.at;
            this.jobs.delete(next);
            next.callback();
            await settled();
        }
        this.now = end;
        await settled();
    }
}

class Emitter<T> {
    static activeListeners = 0;
    private readonly listeners = new Set<(event: T) => void>();
    event = (listener: (event: T) => void) => {
        if (!this.listeners.has(listener)) { Emitter.activeListeners++; }
        this.listeners.add(listener);
        return { dispose: () => { if (this.listeners.delete(listener)) { Emitter.activeListeners--; } } };
    };
    fire(event: T) { [...this.listeners].forEach(listener => listener(event)); }
    dispose() { Emitter.activeListeners -= this.listeners.size; this.listeners.clear(); }
}

class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '') {}
    get fsPath() { return this.path; }
    with(change: { path?: string }) { return new Uri(this.scheme, this.authority, change.path ?? this.path, this.query); }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`; }
    static file(value: string) { return new Uri('file', '', value); }
    static joinPath(base: Uri, ...parts: string[]) { return base.with({ path: path.posix.join(base.path, ...parts) }); }
}

class Host implements BuildsHost {
    answer: LatestAnswer = { kind: 'none', said: 'Overleaf answers 410' };
    checks = 0;
    compiles = 0;
    async latest() { this.checks++; return this.answer; }
    settings() { return MAIN; }
    joined() { return true; }
    log() {}
    async compile() { this.compiles++; return { kind: 'unavailable' as const }; }
}

function build(seconds: number): Build {
    const id = `${(Date.parse('2026-11-04T14:00:00Z') + seconds * 1000).toString(16)}-0123456789abcdef`;
    return {
        id, editorId: 'external-editor', settings: MAIN,
        record: { rootResourcePath: 'main.tex', response: {
            status: 'success', fromCache: true, compileGroup: 'priority', enableHybridPdfDownload: true,
            stats: { 'latexmk-errors': 0, 'pdf-size': 1000, 'latex-runs': 1, 'latex-runs-with-errors': 0, 'latex-runs-0': 0, 'latex-runs-with-error-0s': 0 },
            timings: { sync: 0, compile: 1, output: 0, compileE2E: 1 },
            outputFiles: [{ _id: 'overleaf-workshop-outputs', name: 'output.pdf', path: 'output.pdf', type: 'pdf', build: id, size: 1000, url: `https://dl/project/p1/build/${id}/output.pdf` }],
        } },
    };
}

const world = {
    state: { focused: true },
    windowEvents: new Emitter<{ focused: boolean }>(),
    vfs: undefined as any,
    viewerPageMissing: false,
};
const vscode = strict('vscode', {
    Uri,
    EventEmitter: Emitter,
    Disposable: class { constructor(private readonly close?: () => void) {} dispose() { this.close?.(); } },
    TreeItem: class {},
    QuickPickItem: class {},
    l10n: strict('vscode.l10n', { t: (message: string) => message }),
    window: strict('vscode.window', {
        get state() { return world.state; },
        onDidChangeWindowState: (listener: (event: { focused: boolean }) => void) => world.windowEvents.event(listener),
        registerCustomEditorProvider: () => disposable,
        showErrorMessage: (message: string) => { throw new Error(message); },
    }),
    commands: strict('vscode.commands', {
        executeCommand: async (name: string) => {
            assert.strictEqual(name, 'remoteFileSystem.prefetch');
            return world.vfs;
        },
    }),
    workspace: strict('vscode.workspace', {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        onDidChangeConfiguration: () => disposable,
        fs: strict('vscode.workspace.fs', {
            delete: async () => undefined,
            readFile: async (uri: Uri) => {
                assert.ok(uri.path.includes('/views/pdf-viewer/dist/'), 'build refresh must not read the PDF body');
                if (world.viewerPageMissing) { throw new Error('viewer HTML is missing'); }
                return Buffer.from('<html><head><!--viewer-config--></head></html>');
            },
        }),
    }),
});

// Byte transport and its disk cache are separate from build metadata discovery. These tests
// record the provider's load messages without fetching a PDF or opening anything on disk.
const { PdfViewEditorProvider, ProjectBuilds } = loadWithVscode(vscode, () => ({
    ...require('../core/pdfViewEditorProvider'),
    ...require('../core/projectBuilds'),
}), {
    '../utils/globalStateManager': { GlobalStateManager: { getPdfViewPersist: () => undefined } },
    './pdfFetchBridge': {
        PieceCache: class {
            onChange() { return () => {}; }
            async dispose() {}
        },
        PdfFetchBridge: class {
            setActivity() {}
            setOutput() {}
            dispose() {}
        },
        outputsOf: () => () => true,
    },
});
const packageJSON = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
const buildUri = new Uri('overleaf-workshop', 'www.overleaf.com', '/Book/.output/output.pdf', 'user=u1&project=p1');

class Panel {
    active = true;
    readonly posted: any[] = [];
    private readonly viewEvents = new Emitter<{ webviewPanel: Panel }>();
    private readonly closeEvents = new Emitter<void>();
    constructor(public visible = true) {}
    readonly webview = {
        options: {}, html: '',
        asWebviewUri: (uri: Uri) => uri,
        postMessage: async (message: unknown) => { this.posted.push(message); return true; },
        onDidReceiveMessage: () => disposable,
    };
    onDidChangeViewState = this.viewEvents.event;
    onDidDispose = this.closeEvents.event;
    setVisible(visible: boolean) { this.visible = visible; this.viewEvents.fire({ webviewPanel: this }); }
    close() { this.closeEvents.fire(); this.closeEvents.dispose(); this.viewEvents.dispose(); }
    get loadedBuilds() { return this.posted.filter(message => message.type === 'load').map(message => message.output.file.build); }
}

describe('external build refresh through the PDF editor', () => {
    let clock: Clock;
    let host: Host;
    let builds: any;
    let provider: any;
    let triggers: Array<{ dispose(): void }>;
    let editors: Array<{ doc: any, panel: Panel }>;
    const oldBuild = build(1);
    const newBuild = build(2);

    beforeEach(async () => {
        world.state = { focused: true };
        world.windowEvents = new Emitter();
        world.viewerPageMissing = false;
        clock = new Clock();
        host = new Host();
        // The old one-argument constructor ignores this extra argument. Baseline failures
        // therefore exercise public provider behavior, not a missing helper or method.
        builds = new ProjectBuilds(host, clock);
        host.answer = { kind: 'build', build: oldBuild };
        await builds.check();
        host.answer = { kind: 'none', said: 'Overleaf answers 410' };
        world.vfs = {
            builds,
            pdfOutput: () => builds.build ? {
                url: `https://dl/project/p1/build/${builds.build.id}/output.pdf`,
                downloadDomain: 'https://dl', projectId: 'p1',
                file: { path: 'output.pdf', build: builds.build.id, size: 1000 },
            } : undefined,
        };
        provider = new PdfViewEditorProvider({ extensionUri: Uri.file('/extension'), globalStorageUri: Uri.file('/storage'), extension: { packageJSON } });
        triggers = provider.triggers;
        editors = [];
    });

    afterEach(async () => {
        editors.forEach(({ doc, panel }) => { panel.close(); doc.dispose(); });
        triggers.forEach(trigger => trigger.dispose());
        // Cleanup also works while the baseline has no owner-disposal method.
        builds.dispose?.();
        world.windowEvents.dispose();
        await settled();
        assert.strictEqual(clock.pending, 0, 'closing the editor leaves no scheduled build check');
    });

    async function open(visible = true) {
        const doc = await provider.openCustomDocument(buildUri);
        const panel = new Panel(visible);
        editors.push({ doc, panel });
        await provider.resolveCustomEditor(doc, panel);
        await settled();
        return { doc, panel };
    }

    async function focus(focused: boolean) {
        world.state = { focused };
        world.windowEvents.fire(world.state);
        await settled();
    }

    it('adopts an external build after a 410 without a focus or visibility event', async () => {
        const { doc, panel } = await open();
        assert.strictEqual(doc.output.file.build, oldBuild.id);
        const checked = host.checks;
        await clock.advance(4999);
        assert.strictEqual(host.checks, checked);
        host.answer = { kind: 'build', build: newBuild };
        await clock.advance(1);
        assert.strictEqual(doc.output.file.build, newBuild.id, 'the visible document follows the externally completed compile');
        assert.deepStrictEqual(panel.loadedBuilds, [newBuild.id]);
        assert.strictEqual(host.compiles, 0);
    });

    it('stops while the window is blurred and checks immediately when focus returns', async () => {
        const { doc } = await open();
        assert.strictEqual(clock.pending, 1);
        await focus(false);
        assert.strictEqual(clock.pending, 0);
        const checked = host.checks;
        host.answer = { kind: 'build', build: newBuild };
        await clock.advance(20000);
        assert.strictEqual(host.checks, checked);
        await focus(true);
        assert.strictEqual(doc.output.file.build, newBuild.id);
        assert.strictEqual(clock.pending, 1);
        assert.strictEqual(host.compiles, 0);
    });

    it('stops while the PDF is hidden and checks immediately when it is shown', async () => {
        const { doc, panel } = await open();
        panel.setVisible(false);
        await settled();
        assert.strictEqual(clock.pending, 0);
        const checked = host.checks;
        host.answer = { kind: 'build', build: newBuild };
        await clock.advance(20000);
        assert.strictEqual(host.checks, checked);
        panel.setVisible(true);
        await settled();
        assert.strictEqual(doc.output.file.build, newBuild.id);
        assert.strictEqual(clock.pending, 1);
        assert.strictEqual(host.compiles, 0);
    });

    it('shares a single recurring check across panels and stops after the last panel closes', async () => {
        const first = await open();
        const second = await open();
        assert.strictEqual(clock.pending, 1);
        const checked = host.checks;
        host.answer = { kind: 'build', build: newBuild };
        await clock.advance(5000);
        assert.strictEqual(host.checks, checked + 1);
        assert.strictEqual(first.doc.output.file.build, newBuild.id);
        assert.strictEqual(second.doc.output.file.build, newBuild.id);
        first.panel.close();
        assert.strictEqual(clock.pending, 1);
        second.panel.close();
        assert.strictEqual(clock.pending, 0);
        await clock.advance(20000);
        assert.strictEqual(host.checks, checked + 1);
    });

    it('cleans up the refresh loop when the provider is disposed with a panel open', async () => {
        await open();
        assert.strictEqual(clock.pending, 1);
        const checked = host.checks;
        triggers.forEach(trigger => trigger.dispose());
        triggers = [];
        assert.strictEqual(clock.pending, 0);
        await clock.advance(20000);
        assert.strictEqual(host.checks, checked);
    });

    it('does not schedule checks for a PDF opened in an unfocused window until focus returns', async () => {
        await focus(false);
        const { doc } = await open();
        assert.strictEqual(clock.pending, 0);
        const checked = host.checks;
        host.answer = { kind: 'build', build: newBuild };
        await clock.advance(20000);
        assert.strictEqual(host.checks, checked);
        await focus(true);
        assert.strictEqual(doc.output.file.build, newBuild.id);
        assert.strictEqual(clock.pending, 1);
    });

    it('releases refresh ownership and listeners when the viewer page fails to open', async () => {
        const listeners = Emitter.activeListeners;
        world.viewerPageMissing = true;
        await assert.rejects(open(), /PDF viewer is not built/);
        await settled();
        assert.strictEqual(clock.pending, 0, 'a failed viewer cannot retain the recurring check');
        assert.strictEqual(Emitter.activeListeners, listeners, 'the failed panel and document have no provider subscriptions');
        const panel = editors.at(-1)!.panel;
        const posted = panel.posted.length;
        // A later missing-build event must neither address the failed panel nor treat it as
        // a visible viewer that needs an automatic compile.
        await builds.reportGone(oldBuild.id);
        assert.strictEqual(panel.posted.length, posted);
        assert.strictEqual(host.compiles, 0);
        const checked = host.checks;
        await clock.advance(20000);
        assert.strictEqual(host.checks, checked);
    });
});
