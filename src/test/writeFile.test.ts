/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' and class export names */
import * as assert from 'assert';
import { EventEmitter } from 'events';
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
class FileSystemError extends Error {
    constructor(message: string, public readonly code: string) { super(message); }
    static FileNotFound(message?: any) { return new FileSystemError(String(message), 'FileNotFound'); }
    static FileIsADirectory(message?: any) { return new FileSystemError(String(message), 'FileIsADirectory'); }
    static Unavailable(message?: any) { return new FileSystemError(String(message), 'Unavailable'); }
}
const vscodeMock = withStubs({
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FileSystemError,
    workspace: withStubs({ textDocuments: [] }),
    l10n: { t: (message: string) => message },
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { VirtualFileSystem } = require('../core/remoteFileSystemProvider');
const { SocketIOAPI } = require('../api/socketio');
moduleAny._load = originalLoad;

type Op = {p: number, i?: string, d?: string};

/**
 * A fake of Overleaf's real-time and document-updater services for one doc, as they behave in
 * overleaf/overleaf at e039ad2:
 * - joinDoc gives the connection access to the doc; an update over a connection without that
 *   access is refused (real-time's AuthorizationManager).
 * - The emit's callback means that the update is queued. Once it is applied, the connection that
 *   sent it gets an op-less otUpdateApplied {doc, v}, and the other connections the update with
 *   its ops (DocumentUpdaterController).
 * - An update that fails gives otUpdateError for the doc to the connections that joined it, and
 *   real-time disconnects them.
 * - An update at an older version is transformed against the ops since (inserts only here), and
 *   one with dupIfSource naming the source of one of those ops is answered as applied at that
 *   op's version, without being applied again (ShareJS's model.applyOp).
 * Events reach the file system after the call that caused them returns, as over the network.
 */
function setup(initialContent: string) {
    const server = {
        content: initialContent, v: 10, history: [] as {op: Op[], source: string}[],
        /** the publicId of our connection; undefined while we are disconnected */
        connection: 'conn1' as string | undefined,
        /** the connections that joined the doc */
        joined: new Set<string>(),
        /** whether what Overleaf sends reaches us */
        listening: true,
        joins: 0, emitted: [] as any[],
        /** when set, runs as the next update arrives */
        beforeNextApply: undefined as undefined | (() => void),
        /** when set, the next update is applied but its callback is lost; this runs instead */
        loseNextCallback: undefined as undefined | (() => void),
        /** updates are queued and then neither applied nor answered */
        neverApply: false,
        /** the next update is applied, and then the connection drops before the answer reaches us */
        dropAfterApply: false,
        /** this many of the next updates fail after they are queued */
        failNext: 0,
        failure: 'Delete component does not match',
        /** answers to us are held back while set, until releaseHeld */
        holdAnswers: false,
        held: [] as any[],
        /** resolved as the next update is queued: its callback is on the way */
        queuedWaiters: [] as Array<() => void>,
        nextQueued: () => new Promise<void>(resolve => { server.queuedWaiters.push(resolve); }),
        releaseHeld: () => { server.held.splice(0).forEach(message => send(() => handlers.onFileChanged(message))); },
    };
    const handlers: any = {};
    /** run `event` after the current call returns; resolves once it ran */
    const send = (event: () => void) => new Promise<void>(resolve => setImmediate(() => { event(); resolve(); }));
    const apply = (op: Op[], source: string) => {
        for (const c of op) {
            server.content = c.i !== undefined
                ? server.content.slice(0, c.p) + c.i + server.content.slice(c.p)
                : server.content.slice(0, c.p) + server.content.slice(c.p + c.d!.length);
        }
        server.history.push({op, source});
        server.v += 1;
    };
    /** the op-less otUpdateApplied for the connection that sent the update */
    const answer = (source: string, message: any) => {
        if (source !== server.connection || !server.listening) { return; }
        if (server.holdAnswers) { server.held.push(message); return; }
        send(() => handlers.onFileChanged(message));
    };
    /** the update with its ops, for the connections that did not send it; resolves once we got it */
    const broadcast = (source: string, message: any): Promise<void> => {
        if (server.connection === undefined || source === server.connection || !server.listening) { return Promise.resolve(); }
        return send(() => handlers.onFileChanged(message));
    };
    /** real-time drops our connection */
    const disconnect = () => {
        server.connection = undefined;
        return send(() => handlers.onDisconnected());
    };
    const process = (update: any, source: string) => {
        if (server.neverApply) { return; }
        if (server.failNext > 0) {
            server.failNext -= 1;
            server.connection = undefined;
            // otUpdateError, and then the disconnect, which real-time sends right after it
            send(() => { handlers.onUpdateError?.('doc1', server.failure); handlers.onDisconnected(); });
            return;
        }
        let op: Op[] = update.op;
        for (let v = update.v; v < server.v; v++) {
            const old = server.history[v - 10];
            if (update.dupIfSource?.includes(old.source)) {
                answer(source, {doc: 'doc1', v});
                return;
            }
            // transform against an earlier insert (the only kind these tests transform against)
            op = op.map(c => ({...c, p: old.op[0].p <= c.p ? c.p + old.op[0].i!.length : c.p}));
        }
        const at = server.v;
        apply(op, source);
        if (server.dropAfterApply) {
            server.dropAfterApply = false;
            disconnect();
            return;
        }
        answer(source, {doc: 'doc1', v: at});
        broadcast(source, {doc: 'doc1', v: at, op});
    };
    const socket = {
        isUsingAlternativeConnectionScheme: false,
        updateEventHandlers(h: any) { Object.assign(handlers, h); },
        async joinDoc() {
            server.joins += 1;
            if (server.connection === undefined) { throw new Error(`'joinDoc' timed out`); }
            server.joined.add(server.connection);
            return { docLines: server.content.split('\n'), version: server.v };
        },
        async applyOtUpdate(docId: string, update: any) {
            server.emitted.push(update);
            const before = server.beforeNextApply;
            server.beforeNextApply = undefined;
            before?.();
            if (server.connection === undefined) { throw new Error(`'applyOtUpdate' timed out`); }
            if (!server.joined.has(server.connection)) { throw new Error(`'applyOtUpdate' rejected: not authorized`); }
            const lost = server.loseNextCallback;
            server.loseNextCallback = undefined;
            process(update, server.connection);
            if (lost) {
                lost();
                throw new Error(`'applyOtUpdate' timed out`);
            }
            server.queuedWaiters.splice(0).forEach(resolve => resolve());
        },
    };

    /** another client (e.g. the web editor) inserts `text` at `p`; resolves once it reached us */
    const collaborator = (p: number, text: string) => {
        const v = server.v;
        apply([{p, i: text}], 'web');
        return broadcast('web', {doc: 'doc1', v, op: [{p, i: text}]});
    };
    /** another client deletes `text` at `p`; resolves once it reached us */
    const collaboratorDeletes = (p: number, text: string) => {
        assert.strictEqual(server.content.slice(p, p + text.length), text);
        const v = server.v;
        apply([{p, d: text}], 'web');
        return broadcast('web', {doc: 'doc1', v, op: [{p, d: text}]});
    };

    const doc: any = { _id: 'doc1', name: 'main.tex' };
    const uri: any = { path: '/test/main.tex', toString: () => 'overleaf-workshop://test/main.tex' };
    const editor = { isDirty: false, uri };
    vscodeMock.workspace.textDocuments = [editor];
    const vfs = Object.create(VirtualFileSystem.prototype);
    vfs.socket = socket;
    vfs.notify = () => {};
    vfs.root = { rootFolder: [{ _id: 'root', name: 'test', docs: [doc], fileRefs: [], folders: [] }] };
    vfs._resolveUri = async () => ({ fileType: 'doc', fileEntity: doc });
    vfs._resolveById = () => ({ path: '/main.tex', fileEntity: doc });
    vfs.pathToUri = () => uri;
    vfs.connections = [];
    vfs.remoteWatch();
    handlers.onConnectionAccepted(server.connection);

    return {
        server, doc, editor, vfs, handlers, uri,
        open: async () => new TextDecoder().decode(await vfs.openFile(uri)),
        save: (text: string) => vfs.writeFile(uri, new TextEncoder().encode(text), false, true),
        collaborator, collaboratorDeletes,
        /** the connection drops */
        disconnect: () => {
            server.connection = undefined;
            handlers.onDisconnected();
        },
        /** a new connection is accepted; it has not joined the doc */
        reconnect: (publicId: string) => {
            server.connection = publicId;
            handlers.onConnectionAccepted(publicId);
        },
    };
}

/** settled() rejected, naming main.tex for a reason that matches `reason` */
const namesMainTex = (reason: RegExp) => (error: any) => {
    assert.deepStrictEqual(error.documents?.map((d: any) => d.path), ['/main.tex'], String(error));
    assert.match(error.documents[0].reason, reason);
    return true;
};

describe('VirtualFileSystem.writeFile', () => {
    it('keeps saving when the ack of its own update arrives after the callback', async () => {
        const t = setup('hello');
        await t.open();
        for (const text of ['hello a', 'hello a b', 'hello a b c']) {
            await t.save(text);
            assert.strictEqual(t.server.content, text);
        }
        assert.strictEqual(t.doc.version, 13);
        assert.strictEqual(t.server.joins, 1);
    });

    it('joins the doc on a new connection before it sends an update over it', async () => {
        const t = setup('hello');
        await t.open();
        t.disconnect();
        t.reconnect('conn2');
        await t.save('hello a');
        assert.strictEqual(t.server.content, 'hello a');
        assert.strictEqual(t.server.joins, 2);
        assert.ok(t.server.joined.has('conn2'));
    });

    it('keeps an op from others that was applied just before its own', async () => {
        const t = setup('B:\nA:');
        await t.open();
        const saving = t.save('B:\nA: a1');
        t.collaborator(2, '[b1]');                // lands before our update
        await saving;
        assert.strictEqual(t.server.content, 'B:[b1]\nA: a1');
        await t.save('B:\nA: a1 a2');             // the editor has not reloaded [b1] yet
        assert.strictEqual(t.server.content, 'B:[b1]\nA: a1 a2');
    });

    it('keeps an op from others that the editor has not reloaded yet', async () => {
        const t = setup('B:\nA:');
        await t.open();
        await t.collaborator(2, '[b1]');
        t.editor.isDirty = true;                  // typed before VS Code got to reload
        await t.save('B:\nA: a1');
        assert.strictEqual(t.server.content, 'B:[b1]\nA: a1');
    });

    it('does not apply an update twice when only its callback was lost', async () => {
        const t = setup('hello');
        await t.open();
        t.server.loseNextCallback = () => t.collaborator(0, '# ');
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        await t.vfs.documentUpdatesSettled();     // sent again: Overleaf recognises it
        assert.strictEqual(t.server.content, '# hello a');
        assert.deepStrictEqual(t.server.emitted[1].dupIfSource, ['conn1']);
    });

    it('recognises its update when it went out over a later connection', async () => {
        const t = setup('hello');
        await t.open();
        // emitted while reconnecting: socket.io sends it over the next connection, here one
        // that has the doc joined
        t.server.beforeNextApply = () => { t.reconnect('conn2'); t.server.joined.add('conn2'); };
        t.server.loseNextCallback = () => {};
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        await t.vfs.documentUpdatesSettled();
        assert.strictEqual(t.server.content, 'hello a');
        assert.deepStrictEqual(t.server.emitted[1].dupIfSource, ['conn1', 'conn2']);
    });

    it('fetches the doc again instead of skipping a write after a missed op', async () => {
        const t = setup('hello');
        await t.open();
        t.server.listening = false;
        t.collaborator(0, '> ');                  // never reaches us
        t.server.listening = true;
        await t.collaborator(0, '# ');            // reaches us, one version ahead
        await t.save('hello a');
        assert.strictEqual(t.server.content, '# > hello a');
    });

    it('runs the writes of a doc one after the other', async () => {
        const t = setup('hello');
        await t.open();
        await Promise.all([t.save('hello a'), t.save('hello a b')]);
        assert.strictEqual(t.server.content, 'hello a b');
        assert.deepStrictEqual(t.server.emitted.map(u => u.v), [10, 11]);
    });
});

describe('VirtualFileSystem: updates that Overleaf does not confirm', () => {
    it('does not report an update as saved while Overleaf has not applied it, and settled() names its document', async () => {
        const t = setup('hello');
        await t.open();
        t.server.neverApply = true;               // takes every update and applies none
        const saving = t.save('hello a');
        await t.server.nextQueued();              // the callback is on the way: Overleaf queued it
        const settling = t.vfs.documentUpdatesSettled();
        t.disconnect();                           // the connection drops before any answer
        await assert.rejects(saving, /has not confirmed the update \(the connection was lost/);
        await assert.rejects(settling, namesMainTex(/the connection was lost/));
        assert.strictEqual(t.server.content, 'hello');
        assert.strictEqual(t.server.emitted.length, 1);
    });

    it('fails a write on otUpdateError for its document, and sends it again once reconnected', async () => {
        const t = setup('hello');
        await t.open();
        t.server.failNext = 1;                    // queued, then Overleaf cannot apply it
        await assert.rejects(t.save('hello a'), /Delete component does not match/);
        assert.strictEqual(t.server.content, 'hello');
        // disconnected by Overleaf: named, and not sent again yet
        await assert.rejects(t.vfs.documentUpdatesSettled(), namesMainTex(/Delete component does not match/));
        assert.strictEqual(t.server.emitted.length, 1);
        t.reconnect('conn2');
        await t.vfs.documentUpdatesSettled();     // joins the doc on conn2 and sends it again
        assert.strictEqual(t.server.content, 'hello a');
        assert.deepStrictEqual(t.server.emitted.map(u => u.dupIfSource), [undefined, ['conn1', 'conn2']]);
        assert.strictEqual(t.doc.unconfirmed, undefined);
    });

    it('drops an update that Overleaf reports an error for twice, and the next save sends the edit again', async () => {
        const t = setup('hello');
        await t.open();
        t.server.failNext = 2;
        await assert.rejects(t.save('hello a'), /Delete component does not match/);
        t.reconnect('conn2');
        await assert.rejects(t.vfs.documentUpdatesSettled(), namesMainTex(/could not apply the update/));
        assert.strictEqual(t.doc.unconfirmed, undefined);
        assert.strictEqual(t.server.content, 'hello');
        t.reconnect('conn3');                     // Overleaf disconnected us again
        await t.save('hello a');                  // made against Overleaf's text as it is now
        assert.strictEqual(t.server.content, 'hello a');
        assert.strictEqual(t.server.emitted[2].dupIfSource, undefined);
    });

    it('confirms over the new connection a write that a reconnect left unconfirmed, and Overleaf applies it once', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;           // applied, but the answer is lost with the connection
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        assert.strictEqual(t.server.content, 'hello a');
        await assert.rejects(t.vfs.documentUpdatesSettled(), namesMainTex(/the connection was lost/));
        t.reconnect('conn2');
        await t.vfs.documentUpdatesSettled();     // Overleaf recognises the copy it applied
        assert.strictEqual(t.server.content, 'hello a');
        assert.deepStrictEqual(t.server.emitted[1].dupIfSource, ['conn1', 'conn2']);
        assert.strictEqual(t.server.history.length, 1);
        await t.save('hello a b');                // based on the confirmed write
        assert.strictEqual(t.server.content, 'hello a b');
    });

    it('takes a late answer to an earlier update for no answer to a later one', async () => {
        const t = setup('hello');
        await t.open();
        t.server.holdAnswers = true;              // the answer to the first update comes late
        t.server.loseNextCallback = () => {};
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.server.holdAnswers = false;
        // the second save sends the first update again, then its own; as its own goes out,
        // the late answer {v: 10} arrives, and Overleaf cannot apply the new update
        t.server.beforeNextApply = () => {
            t.server.beforeNextApply = () => { t.server.releaseHeld(); t.server.failNext = 1; };
        };
        await assert.rejects(t.save('hello a b'), /Delete component does not match/);
        assert.strictEqual(t.server.content, 'hello a');
        assert.strictEqual(t.doc.unconfirmed?.content, 'hello a b');
    });

    it('stops waiting for an answer at the last-resort limit, and keeps the write to send again', async () => {
        const limit = VirtualFileSystem.updateAnswerLimitMs;
        try {
            VirtualFileSystem.updateAnswerLimitMs = 1;
            const t = setup('hello');
            await t.open();
            t.server.neverApply = true;           // dropped without a word, as with the rest of a failed batch
            await assert.rejects(t.save('hello a'), /did not answer within/);
            VirtualFileSystem.updateAnswerLimitMs = limit;
            t.server.neverApply = false;
            await t.vfs.documentUpdatesSettled();
            assert.strictEqual(t.server.content, 'hello a');
        } finally {
            VirtualFileSystem.updateAnswerLimitMs = limit;
        }
    });
});

describe('VirtualFileSystem: the ops of others, as Overleaf sends them', () => {
    it('applies inserts and deletes as text: Overleaf packs only joinDoc\'s lines', async () => {
        for (const text of ['\u00dc\u00a0', '\u00ec\u00a9\u00b0', '\u00c3\u00a9', '\u010d', '\u0107\u017e']) {
            const t = setup('ab');
            await t.open();
            await t.collaborator(1, text);
            assert.strictEqual(t.doc.remoteCache, t.server.content, `after inserting ${JSON.stringify(text)}`);
            await t.collaboratorDeletes(1, text);
            assert.strictEqual(t.doc.remoteCache, 'ab', `after deleting ${JSON.stringify(text)}`);
            await t.save('ab c');                 // the editor's base is still 'ab'
            assert.strictEqual(t.server.content, 'ab c', `the next write after ${JSON.stringify(text)}`);
        }
    });
});

describe('VirtualFileSystem.writeDoc', () => {
    it('rejects with FileNotFound when the path holds no document, and sends nothing', async () => {
        const t = setup('hello');
        await t.open();
        const content = new TextEncoder().encode('hello a');
        const fileNotFound = (error: any) => error.code === 'FileNotFound';
        t.vfs._resolveUri = async () => ({});     // deleted on Overleaf
        await assert.rejects(t.vfs.writeDoc(t.uri, content), fileNotFound);
        t.vfs._resolveUri = async () => ({ fileType: 'file', fileEntity: { _id: 'f1', name: 'main.tex' } });
        await assert.rejects(t.vfs.writeDoc(t.uri, content), fileNotFound);
        // writeFile without `create`, as the FileSystemProvider interface says
        t.vfs._resolveUri = async () => ({});
        await assert.rejects(t.vfs.writeFile(t.uri, content, false, true), fileNotFound);
        assert.strictEqual(t.server.emitted.length, 0);
        assert.strictEqual(t.server.content, 'hello');
    });
});

describe('VirtualFileSystem.writeFile: the placement of edits', () => {
    it('places a deleted line as Overleaf does, from its start to the next line\'s start', async () => {
        const t = setup('L09 x.\nL10 y.\nL11 z.\n');
        await t.open();
        await t.save('L09 x.\nL11 z.\n');
        assert.deepStrictEqual(t.server.emitted[0].op, [{ p: 7, d: 'L10 y.\n' }]);
        assert.strictEqual(t.server.content, 'L09 x.\nL11 z.\n');
    });
});

describe('VirtualFileSystem.writeFile: line endings', () => {
    it('sends "\\r\\n" line endings as "\\n", as Overleaf stores them', async () => {
        const t = setup('hello\n');
        await t.open();
        await t.save('hello\r\nworld\r\n');
        assert.ok(t.server.emitted.every(u => u.op.every((c: any) => !(c.i ?? c.d).includes('\r'))), JSON.stringify(t.server.emitted.map(u => u.op)));
        assert.strictEqual(t.server.content, 'hello\nworld\n');
        assert.strictEqual(await t.open(), 'hello\nworld\n');
    });

    it('sends nothing when only the line endings differ', async () => {
        const t = setup('a\nb\n');
        await t.open();
        await t.save('a\r\nb\r');
        assert.strictEqual(t.server.emitted.length, 0);
        assert.strictEqual(t.server.content, 'a\nb\n');
    });
});

describe('VirtualFileSystem.writeFile: tracked changes', () => {
    const user = (t: ReturnType<typeof setup>, trackChangesState: any) => {
        t.vfs.userId = 'u1';
        t.vfs.root.trackChangesState = trackChangesState;
    };

    it('sends its edits untracked while track changes is off', async () => {
        const t = setup('hello');
        user(t, false);
        await t.open();
        await t.save('hello a');
        assert.strictEqual(t.server.content, 'hello a');
        assert.strictEqual(t.server.emitted[0].meta, undefined);
    });

    it('marks its updates for tracking when track changes is on for its user, as the editor does', async () => {
        const t = setup('hello');
        user(t, { u1: true });
        await t.open();
        await t.save('hello a');
        assert.deepStrictEqual(Object.keys(t.server.emitted[0].meta), ['tc']);
        assert.match(t.server.emitted[0].meta.tc, /^[0-9a-f]{18}$/);
    });

    it('does not track its edits when track changes is on only for others', async () => {
        const t = setup('hello');
        user(t, { u2: true });
        await t.open();
        await t.save('hello a');
        assert.strictEqual(t.server.emitted[0].meta, undefined);
    });

    it('follows toggle-track-changes from the server', async () => {
        const t = setup('hello');
        user(t, false);
        await t.open();
        t.handlers.onTrackChangesToggled({ u1: true });
        await t.save('hello a');
        assert.match(t.server.emitted[0].meta.tc, /^[0-9a-f]{18}$/);
        t.handlers.onTrackChangesToggled(false);
        await t.save('hello a b');
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

describe('SocketIOAPI: otUpdateError', () => {
    it('hands the error to the handler, with the document it names', () => {
        const api = Object.create(SocketIOAPI.prototype);
        api.socket = new EventEmitter();
        api._handlers = [];
        api._eventBusCleanups = [];
        const got: any[] = [];
        api.updateEventHandlers({ onUpdateError: (docId: string, error: string) => got.push([docId, error]) });
        // as real-time sends it: the error, and the message from document-updater
        api.socket.emit('otUpdateError', 'Delete component does not match', { project_id: 'p1', doc_id: 'doc1', error: 'Delete component does not match' });
        assert.deepStrictEqual(got, [['doc1', 'Delete component does not match']]);
    });
});
