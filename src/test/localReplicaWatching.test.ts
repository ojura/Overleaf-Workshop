/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');

/** Stands in for anything else: callable, constructible, and every member is one again. */
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
    constructor(public readonly scheme: string, public readonly path: string, public readonly authority = '', public readonly query = '') {}
    get fsPath() { return this.path; }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`; }
    static file(p: string) { return new Uri('file', p); }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(base.scheme, path.posix.join(base.path, ...parts), base.authority, base.query); }
}

class Emitter<T> {
    private listeners: ((value: T) => void)[] = [];
    event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(value: T) { this.listeners.forEach(listener => listener(value)); }
    dispose() { this.listeners = []; }
}

const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 };

/** One extension host: the local folder on disk, a project in memory, the IDE's watchers recorded. */
function world(folder: string, syncOnFileChange: boolean) {
    const w = {
        remote: new Map<string, string>(),
        remoteWrites: [] as string[],
        ideWatchers: [] as any[],
    };
    const fsApi = {
        stat: async (uri: Uri) => {
            const stat = await fs.promises.stat(uri.fsPath);
            return { type: stat.isDirectory() ? FileType.Directory : FileType.File, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
        },
        readFile: async (uri: Uri) => new Uint8Array(await fs.promises.readFile(uri.fsPath)),
        // the IDE's writeFile creates the parent folders
        writeFile: async (uri: Uri, content: Uint8Array) => {
            await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
            await fs.promises.writeFile(uri.fsPath, content);
        },
        readDirectory: async (uri: Uri) => (await fs.promises.readdir(uri.fsPath, { withFileTypes: true }))
            .map(e => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]),
        createDirectory: async (uri: Uri) => { await fs.promises.mkdir(uri.fsPath, { recursive: true }); },
        delete: async (uri: Uri) => { await fs.promises.rm(uri.fsPath, { recursive: true, force: true }); },
        rename: async (from: Uri, to: Uri) => { await fs.promises.rename(from.fsPath, to.fsPath); },
    };
    const mock = withStubs({
        Uri,
        Disposable: class { dispose() {} },
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        TreeItem: class {},
        ThemeIcon: class { constructor(public id: string) {} },
        RelativePattern: class { constructor(public base: any, public pattern: string) {} },
        FileType,
        FileChangeType,
        ProgressLocation: { Notification: 15 },
        l10n: { t: (message: string, args?: any) => message.replace(/\{(\w+)\}/g, (_m, k) => String(args?.[k])) },
        window: withStubs({
            withProgress: (_options: any, task: any) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() {} }),
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            setStatusBarMessage: () => ({ dispose() {} }),
        }),
        workspace: withStubs({
            fs: fsApi,
            getConfiguration: (section: string) => ({
                get: (key: string, value: any) => section === 'overleaf-workshop.localReplica.syncOnFileChange' && key === 'enabled' ? syncOnFileChange : value,
            }),
            createFileSystemWatcher: (pattern: any) => {
                w.ideWatchers.push(pattern);
                return { onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };
            },
            onDidSaveTextDocument: () => ({ dispose() {} }),
            textDocuments: [],
        }),
    });

    // the project: documents only, enough for the replica's Overleaf side
    // the project's files, addressed as the extension addresses them
    const origin = new Uri('overleaf-workshop', '/project', 'www.overleaf.com', 'user=u&project=p');
    const changes = new Emitter<{ type: number, uri: Uri }[]>();
    const rel = (uri: Uri) => uri.path.slice(origin.path.length);
    const vfs = {
        origin, serverName: 'www.overleaf.com', projectName: 'project', projectId: 'p', connected: true,
        onDidChangeFiles: changes.event,
        pathToUri: (...parts: string[]) => Uri.joinPath(origin, ...parts),
        getProjectSCMPersist: () => ({ settings: {} }),
        setProjectSCMPersist: () => {},
        init: async () => ({ rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [...w.remote.keys()].map(p => ({ _id: p, name: p.slice(1) })), fileRefs: [], folders: [] }] }),
        _resolveUri: async (uri: Uri) => w.remote.has(rel(uri)) ? { fileType: 'doc', fileEntity: {} } : { fileType: undefined, fileEntity: undefined },
        openFile: async (uri: Uri) => new TextEncoder().encode(w.remote.get(rel(uri)) ?? ''),
        writeFile: async (uri: Uri, content: Uint8Array) => { w.remote.set(rel(uri), new TextDecoder().decode(content)); w.remoteWrites.push(rel(uri)); },
        createFile: async (uri: Uri, content: Uint8Array) => {
            w.remote.set(rel(uri), new TextDecoder().decode(content));
            w.remoteWrites.push(rel(uri));
            return { _type: 'doc', _id: rel(uri), name: path.posix.basename(uri.path) };
        },
        remove: async (uri: Uri) => { w.remote.delete(rel(uri)); },
        documentUpdatesSettled: async () => {},
    };
    /** a change on Overleaf, as the project reports it */
    const remoteChange = (p: string, text: string) => {
        w.remote.set(p, text);
        changes.fire([{ type: FileChangeType.Changed, uri: Uri.joinPath(origin, p) }]);
    };
    return { w, mock, vfs, remoteChange };
}

function load(mock: any) {
    const moduleAny = Module as any;
    const originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, ...rest: any[]) {
        return request === 'vscode' ? mock : originalLoad.call(this, request, ...rest);
    };
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.includes(`${path.sep}out${path.sep}`) && !key.includes(`${path.sep}test${path.sep}`)) { delete require.cache[key]; }
        }
        require('../scm/localFolderWatcher').LocalFolderWatcher.quietMs = 50;
        return {
            LocalReplicaSCMProvider: require('../scm/localReplicaSCM').LocalReplicaSCMProvider,
            requestReplica: require('../scm/replicaControl').requestReplica,
        };
    } finally {
        moduleAny._load = originalLoad;
    }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 4000) {
    for (const end = Date.now() + ms; Date.now() < end; await wait(25)) {
        if (condition()) { return; }
    }
    assert.fail('timed out waiting');
}

describe('a local replica that watches its folder itself', () => {
    let folder: string;
    let runtime: string;
    let savedRuntime: string | undefined;
    let triggers: { dispose(): void }[] = [];

    beforeEach(() => {
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-replica-watch-'));
        runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-runtime-'));
        fs.chmodSync(runtime, 0o700);
        savedRuntime = process.env.XDG_RUNTIME_DIR;
        process.env.XDG_RUNTIME_DIR = runtime;
    });
    afterEach(async () => {
        triggers.forEach(trigger => trigger.dispose());
        triggers = [];
        await wait(50);
        if (savedRuntime === undefined) { delete process.env.XDG_RUNTIME_DIR; } else { process.env.XDG_RUNTIME_DIR = savedRuntime; }
        fs.rmSync(folder, { recursive: true, force: true });
        fs.rmSync(runtime, { recursive: true, force: true });
    });

    async function start(syncOnFileChange: boolean) {
        const t = world(folder, syncOnFileChange);
        t.w.remote.set('/main.tex', 'v1\n');
        const { LocalReplicaSCMProvider, requestReplica } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        triggers = await scm.triggers;
        await until(() => fs.existsSync(path.join(folder, 'main.tex'))); // the first sync downloads it
        await wait(200);
        t.w.remoteWrites.length = 0;
        return { ...t, scm, requestReplica };
    }

    it('uploads a file another program writes, without the IDE\'s file events', async () => {
        const t = await start(true);
        assert.deepStrictEqual(t.w.ideWatchers, [], 'no IDE watcher, for the folder or for the project');
        fs.writeFileSync(path.join(folder, 'main.tex'), 'v2, written by another program\n');
        await until(() => t.w.remote.get('/main.tex') === 'v2, written by another program\n');
        fs.writeFileSync(path.join(folder, 'chapter.tex'), 'new\n');
        await until(() => t.w.remote.get('/chapter.tex') === 'new\n');
    });

    it('follows changes on Overleaf that the project reports to it directly', async () => {
        const t = await start(true);
        t.remoteChange('/main.tex', 'v2, edited on Overleaf\n');
        await until(() => fs.readFileSync(path.join(folder, 'main.tex'), 'utf8') === 'v2, edited on Overleaf\n');
        await wait(300);
        assert.deepStrictEqual(t.w.remoteWrites, [], 'its own write does not come back as an upload');
    });

    it('answers a tool\'s request once the file the tool wrote is on Overleaf', async () => {
        const t = await start(true);
        fs.writeFileSync(path.join(folder, 'main.tex'), 'v2, written by a script\n');
        const answer = await t.requestReplica(folder, { op: 'sync' }, 10000);
        assert.strictEqual(answer.ok, true, JSON.stringify(answer));
        assert.strictEqual(t.w.remote.get('/main.tex'), 'v2, written by a script\n');
        assert.strictEqual(answer.watcher, 'node');
        assert.strictEqual(answer.connected, true);
        const status = await t.requestReplica(folder, { op: 'status' }, 10000);
        assert.ok(status.recent.some((r: any) => r.path === '/main.tex' && r.what === 'uploaded'), JSON.stringify(status.recent));
    });

    it('without syncOnFileChange, uploads only new and removed files, unless a tool asks for a sync', async () => {
        const t = await start(false);
        fs.writeFileSync(path.join(folder, 'main.tex'), 'v2, written by another program\n');
        fs.writeFileSync(path.join(folder, 'chapter.tex'), 'new\n');
        await until(() => t.w.remote.get('/chapter.tex') === 'new\n');
        await wait(300);
        assert.strictEqual(t.w.remote.get('/main.tex'), 'v1\n', 'a changed file waits');
        const answer = await t.requestReplica(folder, { op: 'sync' }, 10000);
        assert.strictEqual(answer.ok, true, JSON.stringify(answer));
        assert.deepStrictEqual(answer.summary.uploaded, ['/main.tex']);
        assert.strictEqual(t.w.remote.get('/main.tex'), 'v2, written by another program\n');
    });
});
