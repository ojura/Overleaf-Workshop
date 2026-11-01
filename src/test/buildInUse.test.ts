/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names and Overleaf's fields */
import * as assert from 'assert';
import { EventEmitter as NodeEventEmitter, once } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { loadWithVscode, strict } from './standIn';

/**
 * The project's build in use, from Overleaf to what the window shows: a VirtualFileSystem whose
 * BaseAPI talks to a stand-in for Overleaf's web server and download domain on this machine, the
 * PDF provider with a stand-in webview, and the compile manager. One part for each kind of state
 * that came from the window's own last compile before: 1 SyncTeX, 2 the output folder and the
 * Problems view, 3 Save PDF, 4 opening output.pdf after a reload, 5 the replica's .overleaf/output.
 */

/** another client's editor ID */
const WEB_EDITOR = '5a4c2c1e-0f3b-4c1d-9e2a-7b6d8c9e0f1a';
const identity = { cookies: 'overleaf_session2=s', csrfToken: 't' };
const PDF = Buffer.from(`%PDF-1.7 ${'x'.repeat(3000)}`);
/** a log with one LaTeX error in main.tex, line 1 */
const LOG = [
    'This is pdfTeX, Version 3.141592653-2.6-1.40.26',
    '(./main.tex',
    '! Undefined control sequence.',
    'l.1 \\foo',
    '',
    ')',
].join('\n');

interface Recorded { method: string, path: string, query: URLSearchParams, cookie?: string, range?: string, body?: any }

/** Overleaf's web server and download domain (below /cdn), as far as the build in use needs them. */
class Overleaf {
    readonly requests: Recorded[] = [];
    /** the answer for the latest compile in Overleaf's cache: its status, and for 200 the compile */
    latest: { status: number, body?: unknown } = { status: 404 };
    /** what the next compile requests answer, first to last */
    readonly compiles: unknown[] = [];
    /** what the servers send, by path */
    readonly files = new Map<string, Buffer>();
    /**
     * 'held' when a request of a held path arrives (hold), and 'closed' when the asker closes the
     * connection of a held request before its answer
     */
    readonly events = new NodeEventEmitter();
    /** the paths whose answers wait for release(path), with the answers waiting */
    private readonly holding = new Map<string, Array<() => void>>();
    base = '';
    private readonly server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => this.answer(req, Buffer.concat(chunks).toString(), res));
    });

    async start() {
        await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
        this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
    }

    close() {
        this.server.closeAllConnections();
        this.server.close();
    }

    get downloadDomain() {
        return `${this.base}cdn`;
    }

    /** the requests to paths that start with `prefix` */
    to(prefix: string) {
        return this.requests.filter(r => r.path.startsWith(prefix));
    }

    /** Hold the answers to `path` until release(path). */
    hold(path: string) {
        this.holding.set(path, []);
    }

    release(path: string) {
        const waiting = this.holding.get(path) ?? [];
        this.holding.delete(path);
        waiting.forEach(answer => answer());
    }

    private answer(req: http.IncomingMessage, body: string, res: http.ServerResponse) {
        const url = new URL(req.url!, 'http://x');
        this.requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, cookie: req.headers.cookie, range: req.headers.range, body: body ? JSON.parse(body) : undefined });
        const json = (status: number, value: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(value));
        };
        if (url.pathname === '/project/p1/output/cached/output.overleaf.json') {
            if (this.latest.body === undefined) {
                res.writeHead(this.latest.status);
                res.end();
            } else {
                json(this.latest.status, this.latest.body);
            }
            return;
        }
        if (url.pathname === '/project/p1/compile') {
            const next = this.compiles.shift();
            json(next === undefined ? 500 : 200, next ?? { message: 'the test gave no compile answer' });
            return;
        }
        if (url.pathname === '/project/p1/sync/code') {
            json(200, { pdf: [{ page: 3, h: 72, v: 100, width: 10, height: 10 }] });
            return;
        }
        if (url.pathname === '/project/p1/sync/pdf') {
            json(200, { code: [{ file: 'main.tex', line: 7, column: 0 }] });
            return;
        }
        const waiting = this.holding.get(url.pathname);
        if (waiting) {
            res.on('close', () => { if (!res.writableFinished) { this.events.emit('closed', url.pathname); } });
            waiting.push(() => this.send(req, res, url));
            this.events.emit('held', url.pathname);
            return;
        }
        this.send(req, res, url);
    }

    /** Send the file at `url`'s path, whole or the range asked for; 404 when there is none. */
    private send(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
        const content = this.files.get(url.pathname);
        if (!content) {
            res.writeHead(404);
            res.end();
            return;
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
        if (range) {
            const start = Number(range[1]);
            const end = Math.min(Number(range[2]), content.length - 1);
            res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': end - start + 1 });
            res.end(content.subarray(start, end + 1));
            return;
        }
        res.writeHead(200, { 'Content-Length': content.length });
        res.end(content);
    }
}

/** this window's compile answer, a build of compile server clsi-vm-2 */
function ownAnswer(overleaf: Overleaf, build: string) {
    return {
        status: 'success', compileGroup: 'priority', clsiServerId: 'clsi-vm-2', clsiCacheShard: 'cache-1', pdfDownloadDomain: overleaf.downloadDomain,
        outputFiles: [
            { path: 'output.pdf', url: `/project/p1/user/u1/build/${build}/output/output.pdf`, type: 'pdf', build, size: PDF.length },
            { path: 'output.log', url: `/project/p1/user/u1/build/${build}/output/output.log`, type: 'log', build },
        ],
    };
}

/** Overleaf's answer for the latest compile in its cache: another client's, a build of compile server clsi-vm-1 (ClsiCacheManager.getLatestCompileResult) */
function cachedAnswer(overleaf: Overleaf, build: string) {
    const stored = `${WEB_EDITOR}-${build}`;
    return {
        fromCache: true, status: 'success', compileGroup: 'priority', clsiServerId: 'clsi-vm-1', clsiCacheShard: 'cache-1', pdfDownloadDomain: overleaf.downloadDomain,
        outputFiles: [
            { path: 'output.pdf', url: `/project/p1/user/u1/build/${build}/output/output.pdf`, downloadURL: `/download/project/p1/build/${stored}/output/cached/output.pdf`, build, type: 'pdf', size: PDF.length, editorId: WEB_EDITOR },
            { path: 'output.log', url: `/project/p1/user/u1/build/${stored}/output/output.log`, downloadURL: `/download/project/p1/build/${stored}/output/cached/output.log`, build, type: 'log' },
        ],
        options: { rootResourcePath: 'main.tex', draft: false, stopOnFirstError: false, compiler: 'pdflatex', imageName: 'texlive-full:2025.1' },
    };
}

// ---- the 'vscode' stand-in

class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '') {}
    get fsPath() { return this.path; }
    with(change: { path?: string }) { return new Uri(this.scheme, this.authority, change.path ?? this.path, this.query); }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`; }
    static file(p: string) { return new Uri('file', '', p); }
    static joinPath(base: Uri, ...parts: string[]) { return base.with({ path: path.posix.join(base.path, ...parts) }); }
    static parse(value: string) {
        const m = /^([^:]+):\/\/([^/]*)([^?]*)(?:\?(.*))?$/.exec(value)!;
        return new Uri(m[1], m[2], decodeURIComponent(m[3]), decodeURIComponent(m[4] ?? ''));
    }
}

class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    };
    fire(value: T) { [...this.listeners].forEach(listener => listener(value)); }
    dispose() { this.listeners.clear(); }
}

const disposable = { dispose() {} };
const fileError = (code: string) => (what?: unknown) => Object.assign(new Error(`${code}: ${String(what)}`), { code });

/** What a test watches: messages shown, files written, commands run, and the next save target. */
const world = {
    shown: [] as Array<{ kind: string, message: string }>,
    written: [] as string[],
    commands: new Map<string, (...args: any[]) => any>(),
    saveTarget: undefined as Uri | undefined,
    /** the save of the editors before a compile (vscode.workspace.saveAll) */
    saveAll: async () => true as boolean,
    /** the settings that the test sets, by name, e.g. 'engine' */
    settings: {} as Record<string, unknown>,
    /** the project's file system, for 'remoteFileSystem.prefetch' and the workspace's reads */
    vfs: undefined as any,
    overleaf: undefined as unknown as Overleaf,
};
const show = (kind: string) => async (message: string) => { world.shown.push({ kind, message }); return undefined; };

const vscodeStandIn = strict('vscode', {
    Uri,
    EventEmitter,
    Disposable: class { constructor(private readonly f?: () => void) {} dispose() { this.f?.(); } },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FileType: { File: 1, Directory: 2 },
    FilePermission: { Readonly: 1 },
    FileSystemError: { FileNotFound: fileError('FileNotFound'), FileIsADirectory: fileError('FileIsADirectory'), Unavailable: fileError('Unavailable'), FileExists: fileError('FileExists') },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class { constructor(readonly id: string) {} },
    MarkdownString: class { value = ''; appendMarkdown(text: string) { this.value += text; return this; } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Diagnostic: class { source?: string; constructor(readonly range: unknown, readonly message: string, readonly severity: number) {} },
    Position: class { constructor(readonly line: number, readonly character: number) {} },
    Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
    QuickPickItemKind: { Separator: -1 },
    l10n: strict('vscode.l10n', {
        t: (message: string, ...args: any[]) => message.replace(/\{(\w+)\}/g, (_m, key) => {
            const value = /^\d+$/.test(key) ? args[Number(key)] : args[0]?.[key];
            return value === undefined ? `{${key}}` : String(value);
        }),
    }),
    languages: strict('vscode.languages', {
        createDiagnosticCollection: () => {
            const diagnostics = new Map<string, unknown[]>();
            (world as any).diagnostics = diagnostics;
            return { clear: () => diagnostics.clear(), set: (uri: Uri, list: unknown[]) => diagnostics.set(uri.path, list), dispose() {} };
        },
    }),
    window: strict('vscode.window', {
        activeTextEditor: undefined,
        visibleTextEditors: [],
        showInformationMessage: show('information'),
        showWarningMessage: show('warning'),
        showErrorMessage: show('error'),
        showSaveDialog: async () => world.saveTarget,
        withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
            task({ report() {} }, { onCancellationRequested: () => disposable }),
        createStatusBarItem: () => ({ text: '', tooltip: undefined, command: undefined, backgroundColor: undefined, show() {}, hide() {}, dispose() {} }),
        onDidChangeWindowState: () => disposable,
        registerCustomEditorProvider: () => disposable,
    }),
    commands: strict('vscode.commands', {
        registerCommand: (id: string, handler: (...args: any[]) => any) => { world.commands.set(id, handler); return disposable; },
        executeCommand: async (id: string, ...args: any[]) => {
            if (id === 'remoteFileSystem.prefetch') { return world.vfs; }
            if (id === 'setContext') { return undefined; }
            const handler = world.commands.get(id);
            if (!handler) { throw new Error(`the test has no command ${id}`); }
            return handler(...args);
        },
    }),
    workspace: strict('vscode.workspace', {
        workspaceFolders: undefined,
        textDocuments: [],
        saveAll: () => world.saveAll(),
        onDidSaveTextDocument: () => disposable,
        onDidChangeConfiguration: () => disposable,
        getConfiguration: () => ({ get: (key: string, value: unknown) => world.settings[key] ?? value }),
        // main.tex, whose first line the log's error names
        openTextDocument: async () => ({ getText: () => '\\foo', lineCount: 1 }),
        fs: strict('vscode.workspace.fs', {
            readFile: async (uri: Uri) => {
                // a Buffer, as VS Code's extension host gives one for a file, which the provider decodes with toString()
                if (uri.path.includes('/views/pdf-viewer/dist/')) { return Buffer.from(`<html>${PLACEHOLDER}</html>`); }
                return world.vfs.openFile(uri);
            },
            writeFile: async (uri: Uri, content: Uint8Array) => { world.written.push(uri.path); fs.writeFileSync(uri.fsPath, content); },
            // the provider removes an earlier version's folder of downloaded builds
            delete: async () => undefined,
        }),
    }),
});

const { VirtualFileSystem, PdfDocument, PdfViewEditorProvider, CompileManager, LocalReplicaSCMProvider, EventBus, EDITOR_ID, BaseAPI, downloadDomainUrl, PLACEHOLDER, pdfjsReleaseOf } = loadWithVscode(vscodeStandIn, () => ({
    ...require('../utils/eventBus'),
    ...require('../core/remoteFileSystemProvider'),
    ...require('../core/pdfViewEditorProvider'),
    ...require('../compile/compileManager'),
    ...require('../scm/localReplicaSCM'),
    ...require('../api/base'),
    ...require('../core/pdfViewerPages'),
    ...require('../core/viewerProtocol'),
}), {
    // the login and the API of this test's Overleaf, without a socket.io connection
    '../utils/globalStateManager': {
        GlobalStateManager: {
            authenticate: async () => identity,
            initSocketIOAPI: () => ({ api: new BaseAPI(world.overleaf.base), socket: {} }),
            getPdfViewPersist: () => undefined,
            updatePdfViewPersist: () => {},
        },
    },
    '../collaboration/clientManager': { ClientManager: class { triggers = []; } },
    '../scm/scmCollectionProvider': { SCMCollectionProvider: class { triggers = []; } },
});

/** the extension's package.json, as VS Code gives it to the extension (ExtensionContext.extension.packageJSON) */
const packageJSON = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
const projectUri = Uri.parse('overleaf-workshop://www.overleaf.com/Book?user%3Du1%26project%3Dp1');
const inProject = (file: string) => Uri.joinPath(projectUri, file);
const buildUri = inProject('.output/output.pdf');
const tree = () => ({
    _id: 'p1', name: 'Book', rootDoc_id: 'doc-main', compiler: 'pdflatex',
    settings: { compilers: [{ code: 'pdflatex', name: 'pdfLaTeX' }], learnedWords: [], languages: [] },
    rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'doc-main', name: 'main.tex' }], fileRefs: [], folders: [] }],
});

/** A webview panel: what the provider posts to it, and what its page sends. */
class Panel {
    visible = true;
    active = true;
    readonly posted: any[] = [];
    private receive?: (message: any) => void;
    private viewState?: (event: unknown) => void;
    private readonly closing: Array<() => void> = [];
    private readonly waiting: Array<{ type: string, resolve: (message: any) => void }> = [];
    readonly webview = {
        options: {},
        html: '',
        asWebviewUri: (uri: Uri) => uri,
        postMessage: async (message: any) => {
            this.posted.push(message);
            const waiter = this.waiting.findIndex(w => w.type === message.type);
            if (waiter >= 0) { this.waiting.splice(waiter, 1)[0].resolve(message); }
            return true;
        },
        onDidReceiveMessage: (listener: (message: any) => void) => { this.receive = listener; return disposable; },
    };
    onDidChangeViewState(listener: (event: unknown) => void) { this.viewState = listener; return disposable; }
    onDidDispose(listener: () => void) { this.closing.push(listener); return disposable; }
    /** the page sends `message` */
    send(message: any) { this.receive!(message); }
    setVisible(visible: boolean) { this.visible = visible; this.viewState!({ webviewPanel: this }); }
    close() { this.closing.forEach(listener => listener()); }
    /** the first message of `type` that the provider posted, or posts */
    first(type: string): Promise<any> {
        const posted = this.posted.find(message => message.type === type);
        return posted ? Promise.resolve(posted) : new Promise(resolve => this.waiting.push({ type, resolve }));
    }
    /** the types of the messages posted so far */
    get types() { return this.posted.map(message => message.type); }
}

describe('the build in use, from Overleaf to the window', function () {
    let overleaf: Overleaf;
    let vfs: any;
    let manager: any;
    let managerTriggers: Array<{ dispose(): void }>;
    let provider: any;
    let scratch: string;
    const flushAll = LocalReplicaSCMProvider.flushAll;
    const readSettings = LocalReplicaSCMProvider.readSettings;
    const pathToUri = LocalReplicaSCMProvider.pathToUri;

    beforeEach(async () => {
        overleaf = new Overleaf();
        await overleaf.start();
        world.overleaf = overleaf;
        world.shown = [];
        world.written = [];
        world.commands.clear();
        world.saveTarget = undefined;
        world.saveAll = async () => true;
        world.settings = {};
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'build-in-use-'));
        vfs = new VirtualFileSystem({ globalState: { get: (_key: string, value: unknown) => value } }, projectUri, () => {});
        vfs.root = tree();
        world.vfs = vfs;
        LocalReplicaSCMProvider.flushAll = async () => {};
        LocalReplicaSCMProvider.readSettings = async () => undefined;
        manager = new CompileManager({ prefetch: async () => vfs });
        managerTriggers = manager.triggers;
        provider = new PdfViewEditorProvider({ globalStorageUri: Uri.file(path.join(scratch, 'storage')), extensionUri: Uri.file('/extension'), extension: { packageJSON } });
    });

    afterEach(async () => {
        // the Problems view and the replica's logs of a build from the cache, which may still be read
        await manager.cachedBuildShown;
        managerTriggers.forEach(trigger => trigger.dispose());
        vfs.dispose();
        overleaf.close();
        LocalReplicaSCMProvider.flushAll = flushAll;
        LocalReplicaSCMProvider.readSettings = readSettings;
        LocalReplicaSCMProvider.pathToUri = pathToUri;
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    /** The end of the next compile in the window. */
    function compileEnd(): Promise<any> {
        return new Promise(resolve => {
            const listener = EventBus.on('compileEndedEvent', (event: any) => { listener.dispose(); resolve(event); });
        });
    }

    /** Open the build's PDF as VS Code does, and let its page say it is ready. */
    async function open() {
        const doc = await provider.openCustomDocument(buildUri);
        const panel = new Panel();
        await provider.resolveCustomEditor(doc, panel);
        panel.send({ type: 'ready' });
        return { doc, panel };
    }

    describe('1. SyncTeX', () => {
        it('asks in both directions about the build in use, with its compile server and its editor, also for another client\'s build', async () => {
            // build IDs of Overleaf's form: the other client's compile began after the window's
            const own = '19a3e9d4000-0123456789abcdef';
            const web = '19a3e9d4010-fedcba9876543210';
            overleaf.compiles.push(ownAnswer(overleaf, own));
            assert.strictEqual(await vfs.compile(true), true);
            await vfs.syncCode('main.tex', 7, 0);
            await vfs.syncPdf(3, 72, 100);
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, web) };
            await vfs.builds.check();
            await vfs.syncCode('main.tex', 7, 0);
            await vfs.syncPdf(3, 72, 100);
            const asked = overleaf.to('/project/p1/sync/').map(r => [r.path, r.query.get('buildId'), r.query.get('editorId'), r.query.get('clsiserverid')]);
            assert.deepStrictEqual(asked, [
                ['/project/p1/sync/code', own, EDITOR_ID, 'clsi-vm-2'],
                ['/project/p1/sync/pdf', own, EDITOR_ID, 'clsi-vm-2'],
                ['/project/p1/sync/code', web, WEB_EDITOR, 'clsi-vm-1'],
                ['/project/p1/sync/pdf', web, WEB_EDITOR, 'clsi-vm-1'],
            ]);
        });

        it('says that there is no build yet, and asks Overleaf nothing, before any build', async () => {
            assert.strictEqual(await vfs.syncCode('main.tex', 7, 0), undefined);
            assert.deepStrictEqual(overleaf.to('/project/p1/sync/'), []);
            assert.strictEqual(world.shown.length, 1);
        });
    });
    describe('2. the output folder and the Problems view', () => {
        it('list another client\'s build before any compile of this window, from where Overleaf\'s cache keeps its files', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            overleaf.files.set(`/download/project/p1/build/${WEB_EDITOR}-b-web/output/cached/output.log`, Buffer.from(LOG));
            await vfs.builds.check();
            await manager.cachedBuildShown;
            assert.deepStrictEqual((await vfs.list(inProject('.output'))).map(([name]: [string]) => name), ['output.pdf', 'output.log']);
            assert.strictEqual(new TextDecoder().decode(await vfs.openFile(inProject('.output/output.log'))), LOG);
            // through the web server, with the login, at the file's downloadURL
            assert.ok(overleaf.to('/download/').every(r => r.cookie === identity.cookies && r.path.endsWith('/output/cached/output.log')));
            // the Problems view shows that build's errors
            assert.deepStrictEqual([...(world as any).diagnostics.keys()], ['/Book/main.tex']);
            assert.deepStrictEqual(overleaf.to('/project/p1/compile'), []);
        });

        it('read this window\'s build from the download domain with its compile server, else from the web server with this window\'s editor', async () => {
            overleaf.compiles.push(ownAnswer(overleaf, 'b-own'));
            // the download domain does not have the log: the web server sends it
            overleaf.files.set('/project/p1/user/u1/build/b-own/output/output.log', Buffer.from(LOG));
            assert.strictEqual(await vfs.compile(true), true);
            assert.strictEqual(new TextDecoder().decode(await vfs.openFile(inProject('.output/output.log'))), LOG);
            const cdn = overleaf.to('/cdn/project/p1/user/u1/build/b-own/output/output.log');
            assert.deepStrictEqual(cdn.map(r => [r.query.get('clsiserverid'), r.query.get('compileGroup'), r.cookie]), [['clsi-vm-2', 'priority', undefined]]);
            const web = overleaf.to('/project/p1/user/u1/build/b-own/output/output.log');
            assert.deepStrictEqual(web.map(r => [r.query.get('clsiserverid'), r.query.get('editorId'), r.cookie]), [['clsi-vm-2', EDITOR_ID, identity.cookies]]);
            // the compile named the main document by ID and the window's editor
            const [request] = overleaf.to('/project/p1/compile');
            assert.strictEqual(request.body.rootDoc_id, 'doc-main');
            assert.strictEqual(request.body.rootResourcePath, 'main.tex');
            assert.strictEqual(request.body.editorId, EDITOR_ID);
        });

        it('keep the folder when the project is joined again, as after a lost connection', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            await vfs.builds.check();
            await manager.cachedBuildShown;
            // a reconnect: the window compiled when it first joined the project
            vfs.compileStarted = true;
            await vfs.joined(tree());
            assert.deepStrictEqual((await vfs.list(inProject('.output'))).map(([name]: [string]) => name), ['output.pdf', 'output.log']);
        });

        it('throw when an output file cannot be read, instead of giving an empty file', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            await vfs.builds.check();
            await manager.cachedBuildShown;
            await assert.rejects(vfs.openFile(inProject('.output/output.log')), (error: any) => error.code === 'Unavailable');
        });
    });

    describe('3. Save PDF', () => {
        const target = () => path.join(scratch, 'saved.pdf');
        const partFiles = () => fs.readdirSync(scratch).filter(name => name.endsWith('.part'));
        beforeEach(() => { world.saveTarget = Uri.file(target()); });

        it('saves the build in use from the download domain, in ranges', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            overleaf.files.set('/cdn/project/p1/user/u1/build/b-web/output/output.pdf', PDF);
            const { doc, panel } = await open();
            await panel.first('load');
            await provider.download(doc);
            assert.deepStrictEqual(fs.readFileSync(target()), PDF);
            const ranges = overleaf.to('/cdn/project/p1/user/u1/build/b-web/output/output.pdf');
            assert.ok(ranges.length > 0 && ranges.every(r => r.range !== undefined && r.query.get('clsiserverid') === 'clsi-vm-1'));
            assert.deepStrictEqual(partFiles(), []);
        });

        it('saves another client\'s build whole from Overleaf\'s cache when the compile server has deleted it', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            overleaf.files.set(`/download/project/p1/build/${WEB_EDITOR}-b-web/output/cached/output.pdf`, PDF);
            const { doc, panel } = await open();
            await panel.first('load');
            await provider.download(doc);
            assert.deepStrictEqual(fs.readFileSync(target()), PDF);
            const whole = overleaf.to('/download/project/p1/build/').filter(r => r.path.endsWith('/output.pdf'));
            assert.deepStrictEqual(whole.map(r => [r.path, r.range, r.cookie]), [[`/download/project/p1/build/${WEB_EDITOR}-b-web/output/cached/output.pdf`, undefined, identity.cookies]]);
            assert.deepStrictEqual(partFiles(), []);
        });

        it('saves this window\'s build through the web server, with the window\'s editor, when the compile server has deleted it', async () => {
            overleaf.latest = { status: 404 };
            overleaf.compiles.push(ownAnswer(overleaf, 'b-own'));
            overleaf.files.set('/project/p1/user/u1/build/b-own/output/output.pdf', PDF);
            const ended = compileEnd();
            const { doc, panel } = await open();
            await panel.first('load');
            await ended;
            await provider.download(doc);
            assert.deepStrictEqual(fs.readFileSync(target()), PDF);
            const web = overleaf.to('/project/p1/user/u1/build/b-own/output/output.pdf');
            assert.deepStrictEqual(web.map(r => [r.query.get('clsiserverid'), r.query.get('editorId'), r.cookie]), [['clsi-vm-2', EDITOR_ID, identity.cookies]]);
        });

        it('leaves the user\'s file as it was, and no part file, when the PDF cannot be downloaded', async () => {
            fs.writeFileSync(target(), 'the user\'s file');
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            const { doc, panel } = await open();
            await panel.first('load');
            await provider.download(doc);
            assert.strictEqual(fs.readFileSync(target(), 'utf8'), 'the user\'s file');
            assert.deepStrictEqual(partFiles(), []);
            assert.strictEqual(world.shown.filter(shown => shown.kind === 'error').length, 1);
        });

        it('does not save a PDF that is not loaded', async () => {
            fs.writeFileSync(target(), 'the user\'s file');
            const doc = new PdfDocument(inProject('figure.pdf'), 'pdfjs');
            await provider.download(doc);
            assert.strictEqual(fs.readFileSync(target(), 'utf8'), 'the user\'s file');
            assert.deepStrictEqual(world.written, []);
            assert.strictEqual(world.shown.filter(shown => shown.kind === 'error').length, 1);
        });
    });

    describe('4. opening output.pdf after a reload, before any compile', () => {
        it('loads the latest compile from Overleaf\'s cache without compiling', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            const { panel } = await open();
            const load = await panel.first('load');
            assert.strictEqual(load.output.file.build, 'b-web');
            assert.strictEqual(load.output.file.editorId, WEB_EDITOR);
            // the address that Overleaf's viewer uses: the compile server that made the build, as the answer names it
            assert.strictEqual(load.output.url, downloadDomainUrl(overleaf.downloadDomain, '/project/p1/user/u1/build/b-web/output/output.pdf', 'clsi-vm-1', 'priority'));
            assert.strictEqual(load.output.clsiCacheShard, 'cache-1');
            assert.deepStrictEqual(overleaf.to('/project/p1/compile'), []);
            assert.ok(!panel.types.includes('update'));
        });

        for (const status of [404, 410]) {
            it(`compiles once when Overleaf answers ${status}, and loads that build; it never shows an empty document`, async () => {
                overleaf.latest = { status };
                overleaf.compiles.push(ownAnswer(overleaf, 'b-new'));
                overleaf.files.set('/cdn/project/p1/user/u1/build/b-new/output/output.log', Buffer.from(LOG));
                const ended = compileEnd();
                const { panel } = await open();
                const load = await panel.first('load');
                assert.strictEqual(load.output.file.build, 'b-new');
                assert.deepStrictEqual((await ended).outcome, { result: 'success' });
                assert.strictEqual(overleaf.to('/project/p1/compile').length, 1);
                assert.ok(!panel.types.includes('update'));
                const states = panel.posted.filter(message => message.type === 'buildState').map(message => message.state);
                assert.deepStrictEqual(states.slice(states.indexOf('compiling')), ['compiling', 'ready']);
            });
        }

        it('compiles once when the viewer reports its build gone and Overleaf has no newer one', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            const { panel } = await open();
            await panel.first('load');
            overleaf.latest = { status: 410 };
            overleaf.compiles.push(ownAnswer(overleaf, 'b-new'));
            const ended = compileEnd();
            panel.send({ type: 'buildGone', build: 'b-web' });
            panel.send({ type: 'buildGone', build: 'b-web' });
            await ended;
            assert.strictEqual(overleaf.to('/project/p1/compile').length, 1);
            assert.strictEqual(panel.posted.filter(message => message.type === 'load').pop().output.file.build, 'b-new');
        });

        it('says why there is no PDF when the compile fails, and offers no second compile on its own', async () => {
            overleaf.latest = { status: 404 };
            overleaf.compiles.push({ status: 'failure', compileGroup: 'priority', clsiServerId: 'clsi-vm-2', outputFiles: [] });
            const ended = compileEnd();
            const { panel } = await open();
            await ended;
            assert.deepStrictEqual(vfs.builds.status, { state: 'compile-failed', detail: 'Overleaf\'s status is "failure"' });
            assert.deepStrictEqual(panel.posted.filter(message => message.type === 'buildState').pop(), { type: 'buildState', state: 'compile-failed', detail: 'Overleaf\'s status is "failure"' });
            panel.setVisible(true);
            await vfs.builds.check();
            assert.strictEqual(overleaf.to('/project/p1/compile').length, 1);
        });

        it('compiles the project\'s main document when the user clicks Recompile, while the window knows no build', async () => {
            overleaf.latest = { status: 404 };
            overleaf.compiles.push({ status: 'failure', compileGroup: 'priority', clsiServerId: 'clsi-vm-2', outputFiles: [] }, ownAnswer(overleaf, 'b-new'));
            let ended = compileEnd();
            const { panel } = await open();
            await ended;
            assert.strictEqual(vfs.builds.status.state, 'compile-failed');
            // the line about the build offers Recompile
            ended = compileEnd();
            panel.send({ type: 'recompile' });
            assert.deepStrictEqual((await ended).outcome, { result: 'success' });
            assert.deepStrictEqual(overleaf.to('/project/p1/compile').map(r => [r.body.rootDoc_id, r.body.rootResourcePath]), [['doc-main', 'main.tex'], ['doc-main', 'main.tex']]);
            assert.strictEqual((await panel.first('load')).output.file.build, 'b-new');
            assert.deepStrictEqual(vfs.builds.status, { state: 'ready' });
        });

        it('compiles once the compile that kept it from starting has ended, also one that found no project to compile', async () => {
            // the user compiles a file outside any Overleaf project, which waits while the editors are saved
            let saved!: () => void;
            world.saveAll = () => new Promise<boolean>(resolve => { saved = () => resolve(true); });
            const other = manager.compile(true, false, Uri.file('/elsewhere/notes.tex'));
            world.saveAll = async () => true;
            overleaf.latest = { status: 404 };
            overleaf.compiles.push(ownAnswer(overleaf, 'b-new'));
            const ended = compileEnd();
            const { panel } = await open();
            // a check after the opening's one, which asked for the compile and found the window busy
            await vfs.builds.check();
            assert.deepStrictEqual(vfs.builds.status, { state: 'compiling' });
            assert.deepStrictEqual(overleaf.to('/project/p1/compile'), []);
            saved();
            await other;
            assert.deepStrictEqual((await ended).outcome, { result: 'success' });
            assert.strictEqual((await panel.first('load')).output.file.build, 'b-new');
            assert.deepStrictEqual(vfs.builds.status, { state: 'ready' });
            assert.strictEqual(overleaf.to('/project/p1/compile').length, 1);
        });

        it('says why it does not compile when the compile command\'s answer has lost the end of the running compile', async () => {
            // 'busy' as a copy of the answer would bring it, without its promise
            world.commands.set('overleaf-workshop.compileManager.compile', async () => ({ kind: 'busy', ended: {} }));
            overleaf.latest = { status: 404 };
            const unavailable = new Promise<any>(resolve => {
                const stop = vfs.builds.onDidChangeStatus((status: any) => {
                    if (status.state === 'compile-unavailable') { stop(); resolve(status); }
                });
            });
            const { panel } = await open();
            const detail = 'the compile command answered {"kind":"busy","ended":{}}, not how the compile started';
            assert.deepStrictEqual(await unavailable, { state: 'compile-unavailable', detail });
            assert.deepStrictEqual(panel.posted.filter(message => message.type === 'buildState').pop(), { type: 'buildState', state: 'compile-unavailable', detail });
        });
    });

    describe('the viewer\'s requests through the extension host', () => {
        const pdfPath = '/cdn/project/p1/user/u1/build/b-web/output/output.pdf';
        const pdfUrl = () => `${overleaf.downloadDomain}/project/p1/user/u1/build/b-web/output/output.pdf`;
        /** the configuration of the page that the panel shows now */
        const configOf = (panel: Panel) => JSON.parse(/<script id="viewer-config" type="application\/json">(.*?)<\/script>/.exec(panel.webview.html)![1]);
        const pageOf = (panel: Panel) => configOf(panel).page;

        it('stop the requests of a page that a new page replaced, and are answered only to the page that asked', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            overleaf.files.set(pdfPath, PDF);
            const { panel } = await open();
            await panel.first('load');
            const first = pageOf(panel);
            overleaf.hold(pdfPath);
            const held = once(overleaf.events, 'held');
            const closed = once(overleaf.events, 'closed');
            panel.send({ type: 'fetch', page: first, id: 1, url: pdfUrl(), headers: [['range', 'bytes=0-99']] });
            await held;
            // the other viewer: the panel shows a new page, which numbers its requests from 1 again
            world.settings.engine = 'overleaf';
            await provider.applyEngine();
            await closed;
            const second = pageOf(panel);
            assert.notStrictEqual(second, first);
            // pdf.js's files come from the release that the extension's package.json pins
            assert.ok(configOf(panel).pdfjs.build.endsWith(`/views/pdf-viewer/${pdfjsReleaseOf(packageJSON)}/build/`), configOf(panel).pdfjs.build);
            overleaf.release(pdfPath);
            // a request that the replaced page sent late is not sent on
            panel.send({ type: 'fetch', page: first, id: 2, url: pdfUrl(), headers: [['range', 'bytes=0-99']] });
            panel.send({ type: 'fetch', page: second, id: 1, url: pdfUrl(), headers: [['range', 'bytes=0-99']] });
            const answer = await panel.first('fetchResponse');
            assert.deepStrictEqual([answer.page, answer.id, answer.status], [second, 1, 206]);
            assert.deepStrictEqual(panel.posted.filter(message => message.page === first), []);
            assert.strictEqual(overleaf.to(pdfPath).length, 2, 'the stopped request and the new page\'s');
        });

        it('stop when the panel closes', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            overleaf.files.set(pdfPath, PDF);
            const { panel } = await open();
            await panel.first('load');
            overleaf.hold(pdfPath);
            const held = once(overleaf.events, 'held');
            const closed = once(overleaf.events, 'closed');
            panel.send({ type: 'fetch', page: pageOf(panel), id: 1, url: pdfUrl(), headers: [['range', 'bytes=0-99']] });
            await held;
            panel.close();
            await closed;
            assert.deepStrictEqual(panel.posted.filter(message => message.type === 'fetchResponse'), []);
        });
    });

    describe('opening the project', () => {
        it('shows the latest compile from Overleaf\'s cache when it is current, and compiles nothing', async () => {
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            await vfs.joined(tree());
            await vfs.builds.opened();
            assert.strictEqual(vfs.builds.build.id, 'b-web');
            assert.deepStrictEqual(overleaf.to('/project/p1/compile'), []);
        });

        it('compiles when the project changed after Overleaf\'s latest compile (410)', async () => {
            overleaf.latest = { status: 410 };
            overleaf.compiles.push(ownAnswer(overleaf, 'b-new'));
            const ended = compileEnd();
            await vfs.joined(tree());
            await vfs.builds.opened();
            assert.deepStrictEqual((await ended).outcome, { result: 'success' });
            assert.strictEqual(vfs.builds.build.id, 'b-new');
            assert.strictEqual(overleaf.to('/project/p1/compile').length, 1);
        });
    });

    describe('5. the replica\'s .overleaf/output', () => {
        it('follows the build in use, also another client\'s from Overleaf\'s cache', async () => {
            const replica = path.join(scratch, 'replica');
            LocalReplicaSCMProvider.readSettings = async () => ({ uri: projectUri.toString(), enableCompileNPreview: true });
            LocalReplicaSCMProvider.pathToUri = async (p: string) => Uri.file(path.join(replica, p));
            overleaf.latest = { status: 200, body: cachedAnswer(overleaf, 'b-web') };
            overleaf.files.set(`/download/project/p1/build/${WEB_EDITOR}-b-web/output/cached/output.log`, Buffer.from(LOG));
            await vfs.builds.check();
            await manager.cachedBuildShown;
            const folder = path.join(replica, '.overleaf', 'output');
            assert.strictEqual(fs.readFileSync(path.join(folder, 'output.log'), 'utf8'), LOG);
            const summary = JSON.parse(fs.readFileSync(path.join(folder, 'compile.json'), 'utf8'));
            assert.strictEqual(summary.buildId, 'b-web');
            assert.strictEqual(summary.fromCache, true);
            assert.ok(summary.answeredAt);
            // Overleaf's answer says nothing of when the compile ran
            assert.strictEqual(summary.startedAt, undefined);
            assert.strictEqual(summary.requestMs, undefined);
        });
    });
});
