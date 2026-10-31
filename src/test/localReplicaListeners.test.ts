/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
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
const withStubs = (target: any): any => new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : stub()),
});

class Uri {
    constructor(public readonly scheme: string, public readonly path: string) {}
    get fsPath() { return this.path; }
    toString() { return `${this.scheme}://${this.path}`; }
    static file(p: string) { return new Uri('file', p); }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(base.scheme, path.posix.join(base.path, ...parts)); }
}

interface Watcher { pattern: any, handlers: {[event: string]: ((uri: Uri) => any)[]} }

/** One extension-host world: a local folder, a project that cannot be listed, and the UI. */
function world() {
    const w = {
        localFiles: new Map<string, Uint8Array>(),
        remoteWrites: [] as string[],
        warnings: [] as string[],
        watchers: [] as Watcher[],
    };
    const fs = {
        stat: async (uri: Uri) => {
            if (uri.path.endsWith('settings.json') || w.localFiles.has(uri.path)) { return { type: 1 }; }
            throw new Error(`ENOENT ${uri.path}`);
        },
        readFile: async (uri: Uri) => {
            const content = w.localFiles.get(uri.path);
            if (content===undefined) { throw new Error(`ENOENT ${uri.path}`); }
            return content;
        },
        writeFile: async (uri: Uri, content: Uint8Array) => {
            if (uri.scheme==='overleaf-workshop') { w.remoteWrites.push(uri.path); } else { w.localFiles.set(uri.path, content); }
        },
        readDirectory: async (uri: Uri) => {
            if (uri.scheme==='overleaf-workshop') { throw new Error('getaddrinfo EAI_AGAIN www.overleaf.com'); }
            return [];
        },
        createDirectory: async () => {},
        delete: async () => {},
        rename: async (from: Uri, to: Uri) => {
            const content = w.localFiles.get(from.path);
            if (content!==undefined) { w.localFiles.delete(from.path); w.localFiles.set(to.path, content); }
        },
    };
    const mock = withStubs({
        Uri,
        Disposable: class { dispose() {} },
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        TreeItem: class {},
        ThemeIcon: class { constructor(public id: string) {} },
        RelativePattern: class { constructor(public base: any, public pattern: string) {} },
        FileType: { File: 1, Directory: 2 },
        ProgressLocation: { Notification: 15 },
        l10n: { t: (message: string, args?: any) => message.replace(/\{(\w+)\}/g, (_m, k) => String(args?.[k])) },
        window: withStubs({
            withProgress: (_options: any, task: any) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() {} }),
            showWarningMessage: async (message: string) => { w.warnings.push(message); return undefined; },
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
        }),
        workspace: withStubs({
            fs,
            getConfiguration: () => ({ get: (_key: string, value: any) => value }),
            createFileSystemWatcher: (pattern: any) => {
                const watcher: Watcher = { pattern, handlers: {} };
                w.watchers.push(watcher);
                const on = (event: string) => (handler: (uri: Uri) => any) => {
                    (watcher.handlers[event] ??= []).push(handler);
                    return { dispose() {} };
                };
                return { onDidChange: on('change'), onDidCreate: on('create'), onDidDelete: on('delete'), dispose() {} };
            },
            onDidSaveTextDocument: () => ({ dispose() {} }),
            textDocuments: [],
        }),
    });
    return { w, mock };
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
        return require('../scm/localReplicaSCM').LocalReplicaSCMProvider;
    } finally {
        moduleAny._load = originalLoad;
    }
}

const settle = async () => { for (let i = 0; i < 50; i++) { await new Promise(resolve => setImmediate(resolve)); } };

// the replicas below start a control socket (src/scm/replicaControl.ts): keep it out of the
// user's runtime folder
let savedRuntime: string | undefined;
let runtime: string;
beforeEach(() => {
    savedRuntime = process.env.XDG_RUNTIME_DIR;
    runtime = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'ow-runtime-'));
    require('fs').chmodSync(runtime, 0o700);
    process.env.XDG_RUNTIME_DIR = runtime;
});
afterEach(() => {
    if (savedRuntime === undefined) { delete process.env.XDG_RUNTIME_DIR; } else { process.env.XDG_RUNTIME_DIR = savedRuntime; }
    require('fs').rmSync(runtime, { recursive: true, force: true });
});

describe('LocalReplicaSCMProvider when the first sync fails', () => {
    it('keeps its listeners, reports the failure and uploads later changes', async () => {
        const { w, mock } = world();
        const LocalReplicaSCMProvider = load(mock);
        const origin = new Uri('overleaf-workshop', '/project');
        // listing the project fails as a DNS lookup does when the network drops
        const vfs = {
            origin, serverName: 'www.overleaf.com', projectName: 'project', projectId: 'p',
            pathToUri: (...parts: string[]) => Uri.joinPath(origin, ...parts),
            onDidChangeFiles: () => ({ dispose() {} }),
            getProjectSCMPersist: () => ({ settings: {} }),
            setProjectSCMPersist: () => {},
            init: async () => { throw new Error('getaddrinfo EAI_AGAIN www.overleaf.com'); },
            _resolveUri: async () => ({ fileType: undefined, fileEntity: undefined }),
            createFile: async (uri: Uri) => { w.remoteWrites.push(uri.path); return { _type: 'doc', _id: 'd', name: 'new.tex' }; },
            documentUpdatesSettled: async () => {},
        };
        const scm = new LocalReplicaSCMProvider(vfs, Uri.file('/home/user/project'));

        const triggers = await scm.triggers;
        await settle();
        assert.ok(triggers.length > 2, 'the listeners are registered');
        assert.strictEqual(w.warnings.length, 1, 'the failure is reported');
        assert.match(w.warnings[0], /EAI_AGAIN/);

        // a file created afterwards is still uploaded
        const local = w.watchers.find(watcher => watcher.pattern.base==='/home/user/project')!;
        w.localFiles.set('/home/user/project/new.tex', new TextEncoder().encode('new'));
        for (const handler of local.handlers.create ?? []) { await handler(Uri.file('/home/user/project/new.tex')); }
        await settle();
        assert.deepStrictEqual(w.remoteWrites, ['/project/new.tex']);
    });
});

describe('LocalReplicaSCMProvider when a live sync fails', () => {
    it('says why, offers Sync Now, and keeps one such notice open at a time', async () => {
        const { w, mock } = world();
        const offered: string[][] = [];
        const answers: Array<(choice?: string) => void> = [];
        mock.window.showWarningMessage = (message: string, ...items: string[]) => {
            w.warnings.push(message);
            offered.push(items);
            return new Promise(resolve => answers.push(resolve));
        };
        const LocalReplicaSCMProvider = load(mock);
        const origin = new Uri('overleaf-workshop', '/project');
        // the project is empty and reachable at first; then the connection is gone
        const vfs = {
            origin, serverName: 'www.overleaf.com', projectName: 'project', projectId: 'p',
            pathToUri: (...parts: string[]) => Uri.joinPath(origin, ...parts),
            onDidChangeFiles: () => ({ dispose() {} }),
            getProjectSCMPersist: () => ({ settings: {} }),
            setProjectSCMPersist: () => {},
            init: async () => ({ rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [], fileRefs: [], folders: [] }] }),
            _resolveUri: async () => ({ fileType: undefined, fileEntity: undefined }),
            createFile: async () => { throw new Error('Not connected to www.overleaf.com; reconnecting in the background.'); },
            documentUpdatesSettled: async () => {},
        };
        const scm = new LocalReplicaSCMProvider(vfs, Uri.file('/home/user/project'));
        await scm.triggers;
        await settle();
        assert.deepStrictEqual(w.warnings, []);

        const local = w.watchers.find(watcher => watcher.pattern.base==='/home/user/project')!;
        const create = async (name: string) => {
            w.localFiles.set(`/home/user/project/${name}`, new TextEncoder().encode(name));
            for (const handler of local.handlers.create ?? []) { await handler(Uri.file(`/home/user/project/${name}`)); }
            await settle();
        };
        await create('INDEXING.md');
        assert.strictEqual(w.warnings.length, 1);
        assert.match(w.warnings[0], /\/INDEXING\.md \(Not connected to www\.overleaf\.com; reconnecting in the background\.\)/);
        assert.ok(offered[0].includes('Sync Now'));

        // while that notice is open, more failures only go to the log
        await create('index-terms.txt');
        assert.strictEqual(w.warnings.length, 1);

        // once it is closed, the next failure opens a new one
        answers[0](undefined);
        await settle();
        await create('latexmkrc');
        assert.strictEqual(w.warnings.length, 2);
    });
});
