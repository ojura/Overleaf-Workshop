/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' and class export names */
import * as assert from 'assert';
import Module = require('module');

// The modules under test import 'vscode', which only exists inside the extension host.
// Serve a minimal stand-in so the save path can be driven from plain Node.
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
const vscodeMock = withStubs({
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    workspace: withStubs({ textDocuments: [] }),
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { VirtualFileSystem } = require('../core/remoteFileSystemProvider');
const { SocketIOAPI } = require('../api/socketio');
moduleAny._load = originalLoad;

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i++) { await tick(); } };

type Op = {p: number, i?: string, d?: string};

/**
 * A fake of Overleaf's real-time + document-updater services for one doc. As on the real
 * server, the emit callback fires once the update is taken, and only then does the author
 * get its op-less `otUpdateApplied {v}` ack -- and only while it is in the doc's room.
 * Updates at an older version are transformed against the ops since (inserts only here),
 * and `dupIfSource` marks a re-sent update as already applied.
 */
function setup(initialContent: string) {
    const server = {
        content: initialContent, v: 10, history: [] as {op: Op[], source: string}[],
        inRoom: false, joins: 0, publicId: 'conn1', emitted: [] as any[],
        /** when set, runs as the next update arrives */
        beforeNextApply: undefined as undefined | (() => void),
        /** when set, the next update is applied but its callback is lost; this runs instead */
        loseNextCallback: undefined as undefined | (() => void),
    };
    const handlers: any = {};
    const deliver = (msg: any) => setImmediate(() => handlers.onFileChanged(msg));
    const apply = (op: Op[], source: string) => {
        for (const c of op) {
            server.content = c.i !== undefined
                ? server.content.slice(0, c.p) + c.i + server.content.slice(c.p)
                : server.content.slice(0, c.p) + server.content.slice(c.p + c.d!.length);
        }
        server.history.push({op, source});
        server.v += 1;
    };
    const socket = {
        isUsingAlternativeConnectionScheme: false,
        updateEventHandlers(h: any) { Object.assign(handlers, h); },
        async joinDoc() {
            server.joins += 1;
            server.inRoom = true;
            return { docLines: server.content.split('\n'), version: server.v };
        },
        async applyOtUpdate(docId: string, update: any) {
            server.emitted.push(update);
            const before = server.beforeNextApply;
            server.beforeNextApply = undefined;
            before?.();
            let op: Op[] = update.op;
            for (let v = update.v; v < server.v; v++) {
                const old = server.history[v - 10];
                if (update.dupIfSource?.includes(old.source)) {
                    if (server.inRoom) { deliver({doc: docId, v}); }
                    return;
                }
                // transform against an earlier insert (the only kind these tests make)
                op = op.map(c => ({...c, p: old.op[0].p <= c.p ? c.p + old.op[0].i!.length : c.p}));
            }
            const at = server.v;
            apply(op, server.publicId);
            const lost = server.loseNextCallback;
            if (lost) {
                server.loseNextCallback = undefined;
                lost();
                throw new Error(`'applyOtUpdate' timed out`);
            }
            if (server.inRoom) { deliver({doc: docId, v: at}); }
        },
    };

    const collaborator = (p: number, text: string) => {
        const v = server.v;
        apply([{p, i: text}], 'web');
        if (server.inRoom) { deliver({doc: 'doc1', v, op: [{p, i: text}]}); }
    };

    const doc: any = { _id: 'doc1', name: 'main.tex' };
    const uri: any = { toString: () => 'overleaf-workshop://test/main.tex' };
    const editor = { isDirty: false, uri };
    vscodeMock.workspace.textDocuments = [editor];
    const vfs = Object.create(VirtualFileSystem.prototype);
    vfs.socket = socket;
    vfs.notify = () => {};
    vfs._resolveUri = async () => ({ fileType: 'doc', fileEntity: doc });
    vfs._resolveById = () => ({ path: '/main.tex', fileEntity: doc });
    vfs.pathToUri = () => uri;
    vfs.connections = [];
    vfs.remoteWatch();
    handlers.onConnectionAccepted(server.publicId);

    return {
        server, doc, editor, vfs, handlers,
        open: async () => new TextDecoder().decode(await vfs.openFile(uri)),
        save: (text: string) => vfs.writeFile(uri, new TextEncoder().encode(text), false, true),
        /** another client (e.g. the web editor) inserts `text` at `p` */
        collaborator,
        /** socket.io reconnected: a new connection, not in the doc's room */
        reconnect: (publicId: string) => {
            server.publicId = publicId;
            server.inRoom = false;
            handlers.onConnectionAccepted(publicId);
        },
    };
}

describe('VirtualFileSystem.writeFile', () => {
    const ackTimeout = VirtualFileSystem.ownUpdateAckTimeoutMs;
    before(() => { VirtualFileSystem.ownUpdateAckTimeoutMs = 20; });
    after(() => { VirtualFileSystem.ownUpdateAckTimeoutMs = ackTimeout; });

    it('keeps saving when the ack of its own update arrives after the callback', async () => {
        const t = setup('hello');
        await t.open();
        for (const text of ['hello a', 'hello a b', 'hello a b c']) {
            await t.save(text);
            await settle();
            assert.strictEqual(t.server.content, text);
        }
        assert.strictEqual(t.doc.version, 13);
        assert.strictEqual(t.server.joins, 1);
    });

    it('re-joins the doc when no ack arrives, e.g. after a reconnect', async () => {
        const t = setup('hello');
        await t.open();
        t.server.inRoom = false;                  // reconnected, the doc was not re-joined
        await t.save('hello a');
        await t.save('hello a b');                // waits for the first write to be settled
        await settle();
        assert.strictEqual(t.server.content, 'hello a b');
        assert.strictEqual(t.server.joins, 2);
        assert.strictEqual(t.server.inRoom, true);
    });

    it('keeps an op from others that was applied just before its own', async () => {
        const t = setup('B:\nA:');
        await t.open();
        const saving = t.save('B:\nA: a1');
        t.collaborator(2, '[b1]');                // lands before our update
        await saving;
        await settle();
        assert.strictEqual(t.server.content, 'B:[b1]\nA: a1');
        await t.save('B:\nA: a1 a2');             // the editor has not reloaded [b1] yet
        await settle();
        assert.strictEqual(t.server.content, 'B:[b1]\nA: a1 a2');
    });

    it('keeps an op from others that the editor has not reloaded yet', async () => {
        const t = setup('B:\nA:');
        await t.open();
        t.collaborator(2, '[b1]');
        await settle();
        t.editor.isDirty = true;                  // typed before VS Code got to reload
        await t.save('B:\nA: a1');
        await settle();
        assert.strictEqual(t.server.content, 'B:[b1]\nA: a1');
    });

    it('does not apply an update twice when only its callback was lost', async () => {
        const t = setup('hello');
        await t.open();
        t.server.loseNextCallback = () => t.collaborator(0, '# ');
        await t.save('hello a');
        await settle();
        assert.strictEqual(t.server.content, '# hello a');
        assert.deepStrictEqual(t.server.emitted[1].dupIfSource, ['conn1']);
    });

    it('recognises its update when it went out over a later connection', async () => {
        const t = setup('hello');
        await t.open();
        // emitted while reconnecting: socket.io sends it over the next connection
        t.server.beforeNextApply = () => t.reconnect('conn2');
        t.server.loseNextCallback = () => {};
        await t.save('hello a');
        await settle();
        assert.strictEqual(t.server.content, 'hello a');
        assert.deepStrictEqual(t.server.emitted[1].dupIfSource, ['conn1', 'conn2']);
    });

    it('fetches the doc again instead of skipping a write after a missed op', async () => {
        const t = setup('hello');
        await t.open();
        t.server.inRoom = false;
        t.collaborator(0, '> ');                  // never reaches us
        t.server.inRoom = true;
        t.collaborator(0, '# ');                  // reaches us, one version ahead
        await settle();
        await t.save('hello a');
        await settle();
        assert.strictEqual(t.server.content, '# > hello a');
    });
});

describe('VirtualFileSystem.writeFile: the placement of edits', () => {
    const ackTimeout = VirtualFileSystem.ownUpdateAckTimeoutMs;
    before(() => { VirtualFileSystem.ownUpdateAckTimeoutMs = 20; });
    after(() => { VirtualFileSystem.ownUpdateAckTimeoutMs = ackTimeout; });

    it('places a deleted line as Overleaf does, from its start to the next line\'s start', async () => {
        const t = setup('L09 x.\nL10 y.\nL11 z.\n');
        await t.open();
        await t.save('L09 x.\nL11 z.\n');
        await settle();
        assert.deepStrictEqual(t.server.emitted[0].op, [{ p: 7, d: 'L10 y.\n' }]);
        assert.strictEqual(t.server.content, 'L09 x.\nL11 z.\n');
    });
});

describe('VirtualFileSystem.writeFile: line endings', () => {
    const ackTimeout = VirtualFileSystem.ownUpdateAckTimeoutMs;
    before(() => { VirtualFileSystem.ownUpdateAckTimeoutMs = 20; });
    after(() => { VirtualFileSystem.ownUpdateAckTimeoutMs = ackTimeout; });

    it('sends "\\r\\n" line endings as "\\n", as Overleaf stores them', async () => {
        const t = setup('hello\n');
        await t.open();
        await t.save('hello\r\nworld\r\n');
        await settle();
        assert.ok(t.server.emitted.every(u => u.op.every((c: any) => !(c.i ?? c.d).includes('\r'))), JSON.stringify(t.server.emitted.map(u => u.op)));
        assert.strictEqual(t.server.content, 'hello\nworld\n');
        assert.strictEqual(await t.open(), 'hello\nworld\n');
    });

    it('sends nothing when only the line endings differ', async () => {
        const t = setup('a\nb\n');
        await t.open();
        await t.save('a\r\nb\r');
        await settle();
        assert.strictEqual(t.server.emitted.length, 0);
        assert.strictEqual(t.server.content, 'a\nb\n');
    });
});

describe('VirtualFileSystem.writeFile: tracked changes', () => {
    const ackTimeout = VirtualFileSystem.ownUpdateAckTimeoutMs;
    before(() => { VirtualFileSystem.ownUpdateAckTimeoutMs = 20; });
    after(() => { VirtualFileSystem.ownUpdateAckTimeoutMs = ackTimeout; });

    const user = (t: ReturnType<typeof setup>, trackChangesState: any) => {
        t.vfs.userId = 'u1';
        t.vfs.root = { trackChangesState };
    };

    it('sends its edits untracked while track changes is off', async () => {
        const t = setup('hello');
        user(t, false);
        await t.open();
        await t.save('hello a');
        await settle();
        assert.strictEqual(t.server.content, 'hello a');
        assert.strictEqual(t.server.emitted[0].meta, undefined);
    });

    it('marks its updates for tracking when track changes is on for its user, as the editor does', async () => {
        const t = setup('hello');
        user(t, { u1: true });
        await t.open();
        await t.save('hello a');
        await settle();
        assert.deepStrictEqual(Object.keys(t.server.emitted[0].meta), ['tc']);
        assert.match(t.server.emitted[0].meta.tc, /^[0-9a-f]{18}$/);
    });

    it('does not track its edits when track changes is on only for others', async () => {
        const t = setup('hello');
        user(t, { u2: true });
        await t.open();
        await t.save('hello a');
        await settle();
        assert.strictEqual(t.server.emitted[0].meta, undefined);
    });

    it('follows toggle-track-changes from the server', async () => {
        const t = setup('hello');
        user(t, false);
        await t.open();
        t.handlers.onTrackChangesToggled({ u1: true });
        await t.save('hello a');
        await settle();
        assert.match(t.server.emitted[0].meta.tc, /^[0-9a-f]{18}$/);
        t.handlers.onTrackChangesToggled(false);
        await t.save('hello a b');
        await settle();
        assert.strictEqual(t.server.emitted[1].meta, undefined);
        assert.strictEqual(t.server.content, 'hello a b');
    });
});

describe('SocketIOAPI.applyOtUpdate', () => {
    it('does not emit an update that carries no ops', async () => {
        const emitted: any[] = [];
        const api = Object.create(SocketIOAPI.prototype);
        api.emit = async (...args: any[]) => { emitted.push(args); return []; };

        await api.applyOtUpdate('doc1', { doc: 'doc1', v: 1, op: [] });
        assert.strictEqual(emitted.length, 0);

        await api.applyOtUpdate('doc1', { doc: 'doc1', v: 1, op: [{ p: 0, i: 'x' }] });
        assert.strictEqual(emitted.length, 1);
    });

    it('refuses an update with a "\\r", which overleaf.com takes without applying it and then disconnects', async () => {
        const emitted: any[] = [];
        const api = Object.create(SocketIOAPI.prototype);
        api.emit = async (...args: any[]) => { emitted.push(args); return []; };
        await assert.rejects(api.applyOtUpdate('doc1', { doc: 'doc1', v: 1, op: [{ p: 5, i: '\r' }] }), /"\\r"/);
        await assert.rejects(api.applyOtUpdate('doc1', { doc: 'doc1', v: 1, op: [{ p: 0, d: 'a\r\n' }] }), /"\\r"/);
        assert.strictEqual(emitted.length, 0);
    });
});
