/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names and Overleaf's fields */
import * as assert from 'assert';
import Module = require('module');

// ---- the 'vscode' stand-in, and stand-ins for what a joined project sets up
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

class FakeUri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query: string) {}
    with(change: { path?: string }) { return new FakeUri(this.scheme, this.authority, change.path ?? this.path, this.query); }
    toString() { return `${this.scheme}://${this.authority}${this.path}?${this.query}`; }
}
const notices: string[] = [];
const vscodeMock = withStubs({
    Disposable: class { constructor(private readonly f?: () => void) {} dispose() { this.f?.(); } },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    ProgressLocation: { Notification: 15 },
    Uri: { joinPath: (base: FakeUri, ...parts: string[]) => base.with({ path: [base.path, ...parts].join('/').replace(/\/+/g, '/') }) },
    l10n: { t: (message: string, args?: any) => message.replace(/\{(\w+)\}/g, (_m, k) => String(args?.[k] ?? `{${k}}`)) },
    window: withStubs({
        withProgress: (_options: any, task: any) => { notices.push('progress'); return Promise.resolve(task({ report() {} })); },
        setStatusBarMessage: (message: string) => { notices.push(message); return { dispose() {} }; },
        showErrorMessage: async (message: string) => { notices.push(message); return undefined; },
    }),
    commands: withStubs({ executeCommand: async () => undefined }),
    workspace: withStubs({ textDocuments: [], workspaceFolders: undefined, getConfiguration: () => ({ get: (_k: string, v: any) => v }) }),
});
const created = { scm: 0 };
class FakeSCMCollection { triggers = []; constructor() { created.scm += 1; } }
class FakeClientManager { triggers = []; }

const moduleAny = Module as any;
const originalLoad = moduleAny._load;
const ownModules = () => Object.keys(require.cache).filter(key => /[\\/]out[\\/](?!test[\\/])/.test(key));
ownModules().forEach(key => delete require.cache[key]);
moduleAny._load = function (request: string, ...rest: any[]) {
    if (request === 'vscode') { return vscodeMock; }
    if (/scmCollectionProvider$/.test(request)) { return { SCMCollectionProvider: FakeSCMCollection }; }
    if (/clientManager$/.test(request)) { return { ClientManager: FakeClientManager }; }
    return originalLoad.call(this, request, ...rest);
};
const { VirtualFileSystem } = require('../core/remoteFileSystemProvider');
const { SocketIOAPI } = require('../api/socketio');
const { BaseAPI } = require('../api/base');
moduleAny._load = originalLoad;
// The modules just loaded hold this file's stand-ins: keep them out of other tests.
ownModules().forEach(key => delete require.cache[key]);

// ---- socket.io connections to a fake Overleaf

/** One socket.io connection as the extension sees it: emits go to the server, `fire` delivers events. */
class FakeConnection {
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    /** answers emits; false once the connection is dead */
    alive = true;
    closed = false;
    /** the server accepted the connection; socket.io holds emits back until then */
    connected = false;
    private held: Array<[string, any[], ((...a: any[]) => void) | undefined]> = [];
    constructor(readonly query: string | undefined, private readonly server: FakeServer) {}
    on(event: string, fn: (...args: any[]) => void) {
        if (!this.handlers.has(event)) { this.handlers.set(event, []); }
        this.handlers.get(event)!.push(fn);
        return this;
    }
    removeAllListeners() { this.handlers.clear(); }
    disconnect() { this.closed = true; }
    emit = (event: string, ...args: any[]) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
        if (!this.connected) { this.held.push([event, args, ack]); return; }
        if (this.alive && !this.closed) { this.server.answer(event, args, ack); }
    };
    accepted() {
        this.connected = true;
        this.held.splice(0).forEach(([event, args, ack]) => this.emit(event, ...args, ...(ack ? [ack] : [])));
    }
    fire(event: string, ...args: any[]) {
        for (const fn of [...(this.handlers.get(event) ?? [])]) { fn(...args); }
    }
}

class FakeServer {
    connections: FakeConnection[] = [];
    attempts: number[] = [];
    /** whether a new connection can be made */
    reachable = true;
    docs = new Map([['doc1', 'hello']]);
    version = 1;
    get current() { return this.connections[this.connections.length - 1]; }
    tree() {
        return {
            _id: 'p1', name: 'Book', rootDoc_id: 'doc1', compiler: 'pdflatex', imageName: 'texlive-full:2025.1',
            rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [{ _id: 'doc1', name: 'main.tex' }], fileRefs: [], folders: [] }],
            owner: { _id: 'u1' }, members: [], invites: [], publicAccesLevel: 'private',
        };
    }
    /** what overleaf.com does when a connection is made */
    connect(connection: FakeConnection) {
        if (!connection.query?.includes('projectId=')) {
            connection.fire('connectionRejected', { message: 'missing/bad ?projectId=... query flag on handshake' });
            return;
        }
        if (!this.reachable) {
            connection.fire('error', 'getaddrinfo EAI_AGAIN www.overleaf.com');
            return;
        }
        connection.accepted();
        connection.fire('connect');
        connection.fire('joinProjectResponse', { publicId: `pub${this.connections.length}`, project: this.tree(), permissionsLevel: 'owner', protocolVersion: 2 });
    }
    answer(event: string, args: any[], ack?: (...a: any[]) => void) {
        if (event === 'joinDoc') {
            ack?.(null, this.docs.get(args[0])!.split('\n'), this.version, [], {});
        } else if (event === 'clientTracking.getConnectedUsers') {
            ack?.(null, []);
        } else {
            ack?.(null);
        }
    }
    /** the network drops: the connection stops answering, and `noticed` says whether socket.io sees it */
    drop(noticed: boolean) {
        this.reachable = false;
        this.current.alive = false;
        if (noticed) { this.current.fire('disconnect'); }
    }
}

let server = new FakeServer();
BaseAPI.prototype._initSocketV0 = function (_identity: any, query?: string) {
    const connection = new FakeConnection(query, server);
    server.connections.push(connection);
    server.attempts.push(Date.now());
    setImmediate(() => server.connect(connection));
    return connection;
};
BaseAPI.prototype.getProjectSettings = async () => ({ type: 'success', settings: { learnedWords: [], languages: [], compilers: [] } });

const identity = { cookies: 'overleaf_session2=s', csrfToken: 't' };
const servers = { 'www.overleaf.com': { name: 'www.overleaf.com', url: 'https://www.overleaf.com/', login: { userId: 'u1', username: 'me', identity, projects: [] } } };
const context = { globalState: { get: (key: string, value: any) => (key === 'overleaf-servers' ? servers : value), update: async () => {} }, subscriptions: [] };
const vfsUri = new FakeUri('overleaf-workshop', 'www.overleaf.com', '/Book', 'user=u1&project=p1');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(condition: () => boolean, what: string, ms = 3000) {
    const until = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > until) { throw new Error(`gave up waiting for ${what}`); }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

describe('a lost connection to Overleaf', () => {
    const saved = {
        emit: SocketIOAPI.emitTimeoutMs, join: SocketIOAPI.joinTimeoutMs, wait: VirtualFileSystem.reconnectWaitMs,
        base: VirtualFileSystem.reconnectBaseDelayMs, max: VirtualFileSystem.reconnectMaxDelayMs, first: VirtualFileSystem.connectRetryBaseMs,
    };
    let vfss: any[] = [];
    before(() => {
        SocketIOAPI.emitTimeoutMs = 100;
        SocketIOAPI.joinTimeoutMs = 200;
        VirtualFileSystem.reconnectWaitMs = 300;
        VirtualFileSystem.reconnectBaseDelayMs = 10;
        VirtualFileSystem.reconnectMaxDelayMs = 80;
        VirtualFileSystem.connectRetryBaseMs = 5;
    });
    after(() => {
        SocketIOAPI.emitTimeoutMs = saved.emit;
        SocketIOAPI.joinTimeoutMs = saved.join;
        VirtualFileSystem.reconnectWaitMs = saved.wait;
        VirtualFileSystem.reconnectBaseDelayMs = saved.base;
        VirtualFileSystem.reconnectMaxDelayMs = saved.max;
        VirtualFileSystem.connectRetryBaseMs = saved.first;
    });
    afterEach(async () => {
        vfss.forEach(vfs => vfs.dispose());
        vfss = [];
        // let the loops of the disposed file systems run out before the next test
        await new Promise(resolve => setTimeout(resolve, 400));
    });

    /** a file system that has joined the project: overleaf.com rejects the v1 scheme, then v2 joins */
    async function start() {
        server = new FakeServer();
        created.scm = 0;
        const notified: Array<{ type: number, uri: FakeUri }> = [];
        const vfs = new VirtualFileSystem(context, vfsUri, (events: any[]) => notified.push(...events));
        vfss.push(vfs);
        await vfs.init();
        assert.strictEqual(created.scm, 1);
        return { vfs, notified, rootUri: vfs.pathToUri(), docUri: vfs.pathToUri('main.tex') };
    }

    it('is made again in the background, with growing pauses, without giving up and without a file operation', async () => {
        const { vfs } = await start();
        const before = server.connections.length;
        server.drop(true);
        // more failed attempts than the 5 after which the VFS used to wait for the next file operation
        await waitFor(() => server.connections.length >= before + 7, 'seven attempts');
        const times = server.attempts.slice(before);
        const pauses = times.slice(1).map((t, i) => t - times[i]);
        assert.ok(pauses[4] >= pauses[0], `the pauses grow: ${pauses.join(', ')} ms`);
        assert.ok(pauses.every(p => p < 80 + 60), `and stay below the longest one: ${pauses.join(', ')} ms`);
        assert.strictEqual(vfs.root, undefined);
        server.reachable = true;
        await waitFor(() => created.scm === 2, 'the project joined again');
        assert.ok(vfs.root, 'the tree is back');
        assert.ok(notices.includes('progress'));
    });

    it('is noticed when an emit gets no answer, although socket.io reports nothing', async () => {
        const { vfs, docUri } = await start();
        server.current.alive = false; // dead, without a disconnect event
        await assert.rejects(vfs.openFile(docUri), /'joinDoc' timed out/);
        await waitFor(() => created.scm === 2, 'the project joined again');
        assert.strictEqual(new TextDecoder().decode(await vfs.openFile(docUri)), 'hello');
    });

    it('is noticed when socket.io gives up reconnecting', async () => {
        await start();
        server.current.alive = false;
        server.current.fire('reconnect_failed');
        await waitFor(() => created.scm === 2, 'the project joined again');
    });

    it('makes file operations wait for it, and fail with a clear message when it takes too long', async () => {
        const { vfs, rootUri } = await start();
        server.drop(true);
        await assert.rejects(vfs.list(rootUri), /Not connected to www\.overleaf\.com; reconnecting in the background/);
        const waiting = vfs.list(rootUri);
        setTimeout(() => { server.reachable = true; }, 50);
        assert.deepStrictEqual((await waiting).map((entry: [string, number]) => entry[0]), ['main.tex']);
    });

    it('keeps the documents\' editing state, and reads their content from the server again', async () => {
        const { vfs, notified, docUri } = await start();
        assert.strictEqual(new TextDecoder().decode(await vfs.openFile(docUri)), 'hello');
        const doc = vfs.root.rootFolder[0].docs[0];
        assert.strictEqual(doc.localCache, 'hello');
        server.drop(true);
        server.docs.set('doc1', 'hello, edited while we were away');
        server.reachable = true;
        await waitFor(() => created.scm === 2, 'the project joined again');
        assert.strictEqual(vfs.root.rootFolder[0].docs[0], doc, 'the same document object');
        assert.strictEqual(doc.localCache, 'hello', 'the editor\'s merge base is kept');
        assert.strictEqual(doc.remoteCache, undefined, 'the server\'s copy is read again');
        assert.ok(notified.some(event => event.type === 1 && event.uri.path === '/Book/main.tex'));
        assert.strictEqual(new TextDecoder().decode(await vfs.openFile(docUri)), 'hello, edited while we were away');
    });

    it('takes the event handlers over to a new socket instead of registering them twice', async () => {
        await start(); // the v1 scheme was rejected, so the v2 socket is a new one
        assert.strictEqual(server.current.handlers.get('reciveNewFile')?.length, 1);
    });
});

describe('SocketIOAPI', () => {
    const saved = { emit: SocketIOAPI.emitTimeoutMs, join: SocketIOAPI.joinTimeoutMs };
    before(() => { SocketIOAPI.emitTimeoutMs = 100; SocketIOAPI.joinTimeoutMs = 200; });
    after(() => { SocketIOAPI.emitTimeoutMs = saved.emit; SocketIOAPI.joinTimeoutMs = saved.join; });

    async function joined() {
        server = new FakeServer();
        const socket = new SocketIOAPI('https://www.overleaf.com/', new BaseAPI('https://www.overleaf.com/'), identity, 'p1');
        await assert.rejects(socket.joinProject('p1')); // v1 rejected: on to v2
        socket.init();
        const project = await socket.joinProject('p1');
        return { socket, project };
    }

    it('answers a join after a disconnect with the next connection\'s project, not the first one\'s', async () => {
        const { socket, project } = await joined();
        assert.strictEqual(project.name, 'Book');
        const connection = server.current;
        connection.fire('disconnect');
        let settled = false;
        const again = socket.joinProject('p1').then((p: any) => { settled = true; return p; });
        for (let i = 0; i < 5; i++) { await tick(); }
        assert.strictEqual(settled, false, 'it waits for a connection');
        connection.fire('joinProjectResponse', { publicId: 'pub-again', project: { ...server.tree(), name: 'Book, as now' } });
        assert.strictEqual((await again).name, 'Book, as now');
    });

    it('fails a join at once when the connection cannot be made', async () => {
        const { socket } = await joined();
        server.reachable = false;
        socket.init();
        const started = Date.now();
        await assert.rejects(socket.joinProject('p1'), /EAI_AGAIN/);
        assert.ok(Date.now() - started < 150, 'before the timeout');
    });

    it('reports an emit without an answer as a connection problem, on the current socket only', async () => {
        const { socket } = await joined();
        const problems: string[] = [];
        socket.onConnectionProblem = (reason: string) => problems.push(reason);
        server.current.alive = false;
        const stale = socket.getConnectedUsers();
        socket.init(); // replaced before the answer was due
        await assert.rejects(stale, /timed out/);
        assert.deepStrictEqual(problems, []);
        await waitFor(() => server.current.handlers.has('joinProjectResponse'), 'the new socket');
        server.current.alive = false;
        await assert.rejects(socket.getConnectedUsers(), /timed out/);
        assert.deepStrictEqual(problems, ['\'clientTracking.getConnectedUsers\' got no answer within 100 ms']);
    });
});
