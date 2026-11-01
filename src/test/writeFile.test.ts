/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' and class export names */
import * as assert from 'assert';
import { EventEmitter } from 'events';
import { loadWithVscode } from './standIn';

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
// One load, so that the file system and the tests share socketio's classes (instanceof EmitRefusedError).
const { VirtualFileSystem, SocketIOAPI, EmitRefusedError, EmitTimeoutError, isMissingOpsRefusal } = loadWithVscode(vscodeMock, () => {
    const socketio = require('../api/socketio');
    return {
        VirtualFileSystem: require('../core/remoteFileSystemProvider').VirtualFileSystem,
        SocketIOAPI: socketio.SocketIOAPI,
        EmitRefusedError: socketio.EmitRefusedError,
        EmitTimeoutError: socketio.EmitTimeoutError,
        isMissingOpsRefusal: socketio.isMissingOpsRefusal,
    };
});

type Op = {p: number, i?: string, d?: string};

/** What the tests choose in the warnings the file system shows, and what it showed. */
const notices = { shown: [] as string[], choices: [] as string[][], told: [] as string[], choice: undefined as string | undefined };
vscodeMock.window = withStubs({
    showWarningMessage: (message: string, ...choices: string[]) => {
        notices.shown.push(message);
        notices.choices.push(choices);
        return Promise.resolve(notices.choice);
    },
    showInformationMessage: (message: string) => { notices.told.push(message); return Promise.resolve(undefined); },
});

/** Overleaf's refusal of a request, as SocketIOAPI's emit reports it (a stand-in before EmitRefusedError existed). */
const Refusal: any = EmitRefusedError ?? class extends Error {
    constructor(event: string, readonly answer: any) { super(`'${event}' rejected: ${answer?.message}`); }
};

/**
 * A fake of Overleaf's real-time and document-updater services for one doc, as they behave in
 * overleaf/overleaf at e039ad2:
 * - joinDoc gives the connection access to the doc; an update over a connection without that
 *   access is refused through the emit's callback (real-time's AuthorizationManager), and
 *   real-time disconnects a connection after it refuses an update that way.
 * - The emit's callback means that the update is queued. Once it is applied, the connection that
 *   sent it gets an op-less otUpdateApplied {doc, v}, and the other connections the update with
 *   its ops (DocumentUpdaterController).
 * - An update that fails gives otUpdateError for the doc to the connections that joined it,
 *   whichever client sent the failing update, and real-time disconnects them.
 * - Before it transforms an update, document-updater refuses one more than 80 versions behind
 *   ('Op too old') or one from a version when it no longer keeps the ops since (it keeps the
 *   last 100, and drops them in a flush). Then an update at an older version is transformed against the ops since
 *   (inserts only here), and one with dupIfSource naming the source of one of those ops is
 *   answered as applied at that op's version, without being applied again (ShareJS's model).
 * - joinDoc with fromVersion answers the ops since that version with their sources, after
 *   applying a batch of the project's queued updates (UpdateManager.lockUpdatesAndDo). It
 *   refuses when it no longer keeps them, and when an update of that batch fails.
 * Events reach the file system after the call that caused them returns, as over the network.
 */
function setup(initialContent: string) {
    const server = {
        content: initialContent, v: 10, history: [] as {op: Op[], source: string, v: number}[],
        /** the first version that Overleaf still keeps the ops from */
        keptFrom: 10,
        /** the publicId of our connection; undefined while we are disconnected */
        connection: 'conn1' as string | undefined,
        /** the connections that joined the doc */
        joined: new Set<string>(),
        /** whether what Overleaf sends reaches us */
        listening: true,
        joins: 0, emitted: [] as any[], historyReads: 0,
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
        /** the emit's callback refuses the next update, or every update, with this message */
        refuseNext: undefined as string | undefined,
        refuseAll: undefined as string | undefined,
        /** joinDoc with fromVersion is refused with this message */
        refuseHistory: undefined as string | undefined,
        /** resolved as real-time next disconnects us */
        disconnectWaiters: [] as Array<() => void>,
        nextDisconnect: () => new Promise<void>(resolve => { server.disconnectWaiters.push(resolve); }),
        /** queued updates wait, as behind more queued updates than one batch */
        holdQueue: false,
        queue: [] as {update: any, source: string}[],
        /** answers to us are held back while set, until releaseHeld */
        holdAnswers: false,
        held: [] as any[],
        /** resolved as the next update is queued: its callback is on the way */
        queuedWaiters: [] as Array<() => void>,
        nextQueued: () => new Promise<void>(resolve => { server.queuedWaiters.push(resolve); }),
        releaseHeld: () => { server.held.splice(0).forEach(message => send(() => handlers.onFileChanged(message))); },
        /** document-updater flushes the project and drops the doc's ops */
        flush: () => { server.keptFrom = server.v; },
        /** another client's update of the doc fails */
        otherFails: () => fail(server.failure),
        /** the queued updates are processed */
        release: () => { server.holdQueue = false; drain(Infinity); },
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
        server.history.push({op, source, v: server.v});
        server.v += 1;
        server.keptFrom = Math.max(server.keptFrom, server.v - 100);
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
        return send(() => { handlers.onDisconnected(); server.disconnectWaiters.splice(0).forEach(resolve => resolve()); });
    };
    /** an update of the doc fails: otUpdateError for the doc, then the disconnect, for us if we joined it */
    const fail = (error: string) => {
        if (server.connection === undefined || !server.joined.has(server.connection)) { return; }
        server.connection = undefined;
        send(() => {
            handlers.onUpdateError?.('doc1', error);
            handlers.onDisconnected();
            server.disconnectWaiters.splice(0).forEach(resolve => resolve());
        });
    };
    /** document-updater applies one update; false when it fails */
    const process = (update: any, source: string): boolean => {
        if (server.neverApply) { return true; }
        if (server.failNext > 0) {
            server.failNext -= 1;
            fail(server.failure);
            return false;
        }
        if (update.v + 80 < server.v) { fail('Op too old'); return false; }
        if (update.v < server.v && update.v < server.keptFrom) { fail('doc ops range is not loaded in redis'); return false; }
        let op: Op[] = update.op;
        for (const old of server.history.filter(h => h.v >= update.v)) {
            if (update.dupIfSource?.includes(old.source)) {
                answer(source, {doc: 'doc1', v: old.v});
                return true;
            }
            // transform against an earlier insert (the only kind these tests transform against)
            op = op.map(c => ({...c, p: old.op[0].p <= c.p ? c.p + old.op[0].i!.length : c.p}));
        }
        const at = server.v;
        apply(op, source);
        if (server.dropAfterApply) {
            server.dropAfterApply = false;
            disconnect();
            return true;
        }
        answer(source, {doc: 'doc1', v: at});
        broadcast(source, {doc: 'doc1', v: at, op});
        return true;
    };
    /** document-updater takes up to `count` queued updates, and stops at the first that fails; false then */
    const drain = (count: number): boolean => {
        for (let i = 0; i < count && server.queue.length > 0; i++) {
            const {update, source} = server.queue.shift()!;
            if (!process(update, source)) { return false; }
        }
        return true;
    };
    /** real-time refuses an update through the emit's callback, and disconnects us */
    const refuse = (message: string) => {
        disconnect();
        return new Refusal('applyOtUpdate', {message});
    };
    const socket = {
        isUsingAlternativeConnectionScheme: false,
        updateEventHandlers(h: any) { Object.assign(handlers, h); },
        async joinDoc(_docId: string, fromVersion?: number) {
            server.joins += 1;
            if (server.connection === undefined) { throw new Error(`'joinDoc' timed out`); }
            // document-updater answers 500 when an update of the batch fails: 'Something went wrong'
            if (!server.holdQueue && !drain(8)) { throw new Refusal('joinDoc', {message: 'Something went wrong in real-time service'}); }
            let updates: any[] = [];
            if (fromVersion !== undefined) {
                server.historyReads += 1;
                if (server.refuseHistory !== undefined) { throw new Refusal('joinDoc', {message: server.refuseHistory}); }
                if (fromVersion < server.v && fromVersion < server.keptFrom) {
                    throw new Refusal('joinDoc', {message: 'doc updater could not load requested ops'});
                }
                updates = server.history.filter(h => h.v >= fromVersion).map(h => ({op: h.op, v: h.v, meta: {source: h.source}}));
            }
            server.joined.add(server.connection);
            return { docLines: server.content.split('\n'), version: server.v, updates };
        },
        async applyOtUpdate(docId: string, update: any) {
            server.emitted.push(update);
            const before = server.beforeNextApply;
            server.beforeNextApply = undefined;
            before?.();
            if (server.connection === undefined) { throw new Error(`'applyOtUpdate' timed out`); }
            const refusal = server.refuseAll ?? server.refuseNext;
            server.refuseNext = undefined;
            if (refusal !== undefined) { throw refuse(refusal); }
            if (!server.joined.has(server.connection)) { throw refuse('not authorized'); }
            const lost = server.loseNextCallback;
            server.loseNextCallback = undefined;
            if (server.holdQueue) {
                server.queue.push({update, source: server.connection});
            } else {
                process(update, server.connection);
            }
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
    notices.shown = [];
    notices.choices = [];
    notices.told = [];
    notices.choice = undefined;
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

    const t = {
        server, doc, editor, vfs, handlers, uri,
        open: async () => new TextDecoder().decode(await vfs.openFile(uri)),
        /**
         * The save's promise, which the test awaits. A test that fails while a save waits leaves
         * it to the teardown, which ends the save (see harnesses).
         */
        save: (text: string) => {
            const saving = vfs.writeFile(uri, new TextEncoder().encode(text), false, true);
            saving.catch(() => undefined);
            return saving;
        },
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
        /** a reconnect has started: the tree is the one from before the loss (see connectionLost) */
        reconnecting: () => {
            vfs.previousRoot = vfs.root;
            vfs.root = undefined;
        },
    };
    harnesses.push(t);
    return t;
}

/** the file systems of the running test; the teardown ends their updates that still wait */
const harnesses: Array<{ vfs: any }> = [];
afterEach(() => {
    for (const t of harnesses.splice(0)) { t.vfs.answersLost?.('the test ended'); }
});

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
        await t.open();                           // a read by the dirty editor keeps its base
        await t.save('B:\nA: a1');
        assert.strictEqual(t.server.content, 'B:[b1]\nA: a1');
    });

    it('keeps a dirty editor\'s base when the doc is read from Overleaf again', async () => {
        const t = setup('B:\nA:');
        await t.open();
        t.server.listening = false;
        t.collaborator(2, '[b1]');                // never reaches us
        t.server.listening = true;
        await t.collaborator(0, '# ');            // reaches us, one version ahead: the copy is dropped
        t.editor.isDirty = true;
        assert.strictEqual(await t.open(), '# B:[b1]\nA:');
        await t.save('B:\nA: a1');                // the editor never loaded '# ' or [b1]
        assert.strictEqual(t.server.content, '# B:[b1]\nA: a1');
    });

    it('does not apply an update twice when only its callback was lost', async () => {
        const t = setup('hello');
        await t.open();
        t.server.loseNextCallback = () => t.collaborator(0, '# ');
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        await t.vfs.documentUpdatesSettled();     // Overleaf's history shows it applied
        assert.strictEqual(t.server.content, '# hello a');
        assert.strictEqual(t.server.emitted.length, 1);
        await t.save('hello a b');
        assert.strictEqual(t.server.content, '# hello a b');
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
        assert.strictEqual(t.server.emitted.length, 1);
        assert.deepStrictEqual(t.server.history.map(h => h.source), ['conn2']);
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
        t.server.neverApply = true;               // takes every update and does not apply it
        const saving = t.save('hello a');
        await t.server.nextQueued();              // the callback is on the way: Overleaf queued it
        const settling = t.vfs.documentUpdatesSettled();
        t.disconnect();                           // the connection drops before any answer
        await assert.rejects(saving, /has not confirmed the update \(the connection was lost/);
        await assert.rejects(settling, namesMainTex(/the connection was lost/));
        assert.strictEqual(t.server.content, 'hello');
        assert.strictEqual(t.server.emitted.length, 1);
    });

    it('names a document with an unconfirmed write while a reconnect runs, from the tree from before the loss', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.reconnecting();
        await assert.rejects(t.vfs.documentUpdatesSettled(), namesMainTex(/the connection was lost/));
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
        await t.vfs.documentUpdatesSettled();     // not in Overleaf's history: sent again over conn2
        assert.strictEqual(t.server.content, 'hello a');
        assert.deepStrictEqual(t.server.emitted.map(u => u.dupIfSource), [undefined, ['conn1', 'conn2']]);
        assert.strictEqual(t.doc.unconfirmed, undefined);
    });

    it('confirms from Overleaf\'s history a write that a reconnect left unconfirmed, without sending it again', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;           // applied, but the answer is lost with the connection
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        assert.strictEqual(t.server.content, 'hello a');
        await assert.rejects(t.vfs.documentUpdatesSettled(), namesMainTex(/the connection was lost/));
        t.reconnect('conn2');
        await t.vfs.documentUpdatesSettled();
        assert.strictEqual(t.server.content, 'hello a');
        assert.strictEqual(t.server.emitted.length, 1);
        await t.save('hello a b');                // based on the confirmed write
        assert.strictEqual(t.server.content, 'hello a b');
    });

    it('does not take a late answer to an earlier update as the answer to a later one', async () => {
        const t = setup('hello');
        await t.open();
        t.server.holdAnswers = true;              // the answer to the first update comes late
        t.server.loseNextCallback = () => {};
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.server.holdAnswers = false;
        // The second save finds the first update in Overleaf's history, then sends its own.
        // As its own goes out, the late answer {v: 10} arrives, and Overleaf cannot apply it.
        t.server.beforeNextApply = () => { t.server.releaseHeld(); t.server.failNext = 1; };
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

describe('VirtualFileSystem: deciding from Overleaf\'s history whether it applied an update', () => {
    it('finds an applied update in the history when a resend would be refused as too old (A)', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.reconnect('conn2');
        for (let i = 0; i < 81; i++) { await t.collaborator(0, 'x'); }
        await t.vfs.documentUpdatesSettled();     // conn1's op at version 10 is in the history
        assert.strictEqual(t.server.emitted.length, 1);
        t.editor.isDirty = true;
        await t.save('hello a b');
        assert.strictEqual(t.server.content, `${'x'.repeat(81)}hello a b`);
    });

    it('does not send again an update that Overleaf would now refuse as too old, and sends the edit with the next write', async () => {
        const t = setup('hello');
        await t.open();
        t.server.neverApply = true;
        const saving = t.save('hello a');
        await t.server.nextQueued();
        t.disconnect();
        await assert.rejects(saving, /has not confirmed/);
        t.server.neverApply = false;
        t.reconnect('conn2');
        for (let i = 0; i < 81; i++) { await t.collaborator(0, 'x'); }
        await t.vfs.documentUpdatesSettled();     // not in the history, and too old for Overleaf
        assert.strictEqual(t.server.emitted.length, 1);
        assert.strictEqual(t.doc.unconfirmed, undefined);
        t.editor.isDirty = true;
        await t.save('hello a b');
        assert.strictEqual(t.server.content, `${'x'.repeat(81)}hello a b`);
    });

    it('tells the user when Overleaf no longer has the history, does not send the update again, and lets the user decide', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.editor.isDirty = true;                  // the failed save leaves the editor with unsaved changes
        t.server.flush();                         // the last client left: the doc's ops are gone
        t.reconnect('conn2');
        await assert.rejects(t.vfs.documentUpdatesSettled(), namesMainTex(/cannot be determined \(Overleaf could not load the document or its updates since then/));
        assert.strictEqual(t.server.emitted.length, 1);
        assert.match(notices.shown[0], /main\.tex: Overleaf Workshop cannot tell whether Overleaf applied the update/);
        // Compare comes first, and the notice says what replacing Overleaf's text does
        assert.deepStrictEqual(notices.choices[0], ['Compare With Overleaf', 'Replace Overleaf\'s Text']);
        assert.match(notices.shown[0], /it deletes what others added or changed in main\.tex since this editor loaded it/);
        // a save does not merge the editor's text with Overleaf's
        notices.choice = 'Replace Overleaf\'s Text';
        await assert.rejects(t.save('hello a b'), /cannot tell whether Overleaf applied the update/);
        assert.strictEqual(t.server.content, 'hello a');
        await t.save('hello a b');                // after Replace Overleaf's Text: the editor's text is Overleaf's text
        assert.strictEqual(t.server.content, 'hello a b');
        assert.strictEqual(t.doc.undetermined, undefined);
        await t.vfs.documentUpdatesSettled();
    });

    it('lets a reader that takes Overleaf\'s text write again when the history is gone', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.server.flush();
        t.reconnect('conn2');
        assert.strictEqual(await t.open(), 'hello a');   // as the local replica reads before it merges
        await t.vfs.writeDoc(t.uri, new TextEncoder().encode('hello a b'));
        assert.strictEqual(t.server.content, 'hello a b');
        assert.strictEqual(t.server.emitted.length, 2);
    });

    it('does not drop a write when the errors come from other clients\' failing updates (C)', async () => {
        const t = setup('hello');
        await t.open();
        t.server.holdQueue = true;                // ours waits behind more queued updates than one batch
        const saving = t.save('hello a');
        await t.server.nextQueued();
        t.server.otherFails();
        await assert.rejects(saving, /Delete component does not match/);
        t.reconnect('conn2');
        const resent = t.server.nextQueued();
        const settling = t.vfs.documentUpdatesSettled();
        await resent;                             // not in the history yet: sent again, and that one waits too
        t.server.otherFails();
        await assert.rejects(settling, namesMainTex(/Delete component does not match/));
        t.reconnect('conn3');
        t.server.release();                       // ours is applied, its copy answered as a duplicate
        assert.strictEqual(t.server.content, 'hello a');
        await t.vfs.documentUpdatesSettled();     // found in the history
        t.editor.isDirty = true;
        await t.save('hello a b');
        assert.strictEqual(t.server.content, 'hello a b');
    });

    it('settles a write before a read of the doc, so that a reader gets the write\'s outcome (E)', async () => {
        const t = setup('hello');
        await t.open();
        t.server.neverApply = true;               // queued, and not applied
        const saving = t.save('hello a');
        await t.server.nextQueued();
        t.disconnect();
        await assert.rejects(saving, /has not confirmed/);
        t.server.neverApply = false;
        await t.collaborator(0, '# ');
        t.reconnect('conn2');
        // the local replica reads the doc, merges its file into Overleaf's text, and writes
        assert.strictEqual(await t.open(), '# hello a');
        await t.vfs.writeDoc(t.uri, new TextEncoder().encode('# hello a b'));
        assert.strictEqual(t.server.content, '# hello a b');
    });

    it('settles a write that the editor dropped (Revert) before the editor reads the doc again', async () => {
        const t = setup('hello');
        await t.open();
        t.server.neverApply = true;
        const saving = t.save('hello a');
        await t.server.nextQueued();
        t.disconnect();
        await assert.rejects(saving, /has not confirmed/);
        t.server.neverApply = false;
        t.reconnect('conn2');
        t.editor.isDirty = false;                 // reverted: VS Code reads the file again
        assert.strictEqual(await t.open(), 'hello a');
        assert.strictEqual(t.doc.unconfirmed, undefined);
        assert.match(notices.told[0], /^main\.tex: the update of .+ that the editor dropped is in Overleaf's text: Overleaf had not applied it, and Overleaf Workshop sent it again when the editor read the file\./);
    });

    it('tells the user when an edit that the editor dropped (Revert) had been applied', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.reconnect('conn2');
        t.editor.isDirty = false;
        assert.strictEqual(await t.open(), 'hello a');
        assert.match(notices.told[0], /that the editor dropped is in Overleaf's text: Overleaf had applied it\./);
        assert.strictEqual(t.server.emitted.length, 1);
    });

    it('does not take a write of the local replica for an edit that an editor dropped', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.vfs.writeDoc(t.uri, new TextEncoder().encode('hello a')), /has not confirmed/);
        t.reconnect('conn2');
        assert.strictEqual(await t.open(), 'hello a'); // an editor without unsaved changes reads the file
        assert.deepStrictEqual(notices.told, []);
    });
});

describe('VirtualFileSystem: refusals through the emit\'s callback', () => {
    it('fails a write that Overleaf refuses, and does not send it again', async () => {
        const t = setup('hello');
        await t.open();
        t.server.refuseNext = 'not authorized';
        const dropped = t.server.nextDisconnect();
        await assert.rejects(t.save('hello a'), /Overleaf refused the update \('applyOtUpdate' rejected: not authorized\)/);
        assert.strictEqual(t.doc.unconfirmed, undefined);
        await dropped;                            // real-time disconnects after the refusal
        t.reconnect('conn2');
        await t.vfs.documentUpdatesSettled();
        assert.strictEqual(t.server.emitted.length, 1);
        await t.save('hello a b');                // the next write carries the edit
        assert.strictEqual(t.server.content, 'hello a b');
    });

    it('sends each write once while Overleaf keeps refusing them', async () => {
        const t = setup('hello');
        await t.open();
        t.server.refuseAll = 'not authorized';
        let dropped = t.server.nextDisconnect();
        await assert.rejects(t.save('hello a'), /refused/);
        await dropped;
        t.reconnect('conn2');
        dropped = t.server.nextDisconnect();
        await assert.rejects(t.save('hello a b'), /refused/);
        await dropped;
        assert.deepStrictEqual(t.server.emitted.map(u => [u.v, u.dupIfSource]), [[10, undefined], [10, undefined]]);
    });

    it('does not send again a resend that Overleaf refused, and ends in an outcome it cannot determine (R)', async () => {
        const t = setup('hello');
        await t.open();
        t.server.neverApply = true;
        const saving = t.save('hello a');
        await t.server.nextQueued();
        t.disconnect();
        await assert.rejects(saving, /has not confirmed/);
        t.editor.isDirty = true;
        t.server.neverApply = false;
        t.server.refuseAll = 'not authorized';    // e.g. the user lost edit rights meanwhile
        t.reconnect('conn2');
        // Each round asks settled(); after a refusal real-time disconnects us, and we connect again,
        // as the replica's full sync does after every reconnect.
        const reasons: string[] = [];
        for (let i = 0; i < 4; i++) {
            const dropped = t.server.nextDisconnect();
            const error: any = await t.vfs.documentUpdatesSettled().then(() => undefined, (e: any) => e);
            reasons.push(error?.documents?.[0]?.reason);
            if (t.server.connection === undefined) { await dropped; t.reconnect(`conn${3 + i}`); }
        }
        assert.strictEqual(t.server.emitted.filter(u => u.dupIfSource).length, 1, 'resends');
        assert.match(reasons[0], /^not confirmed \('applyOtUpdate' rejected: not authorized/);
        for (const reason of reasons.slice(1)) {
            assert.match(reason, /^cannot be determined \(Overleaf refused the update or reported an error for the document when it was sent again/);
        }
        assert.strictEqual(await t.open(), 'hello');
    });
});

describe('VirtualFileSystem: a history read that Overleaf refuses, and the reasons it names', () => {
    it('takes a refusal of the history read with a text it does not know as an outcome it cannot determine (M)', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.server.refuseHistory = 'a refusal with a text that Overleaf Workshop does not know';
        t.reconnect('conn2');
        assert.strictEqual(await t.open(), 'hello a'); // the doc can be read, and the read takes Overleaf's text
        assert.strictEqual(t.doc.undetermined, undefined);
        assert.match(notices.shown[0], /Overleaf refused to read the document's updates since then \('joinDoc' rejected: a refusal with a text/);
        await t.vfs.writeDoc(t.uri, new TextEncoder().encode('hello a b'));
        assert.strictEqual(t.server.content, 'hello a b');
        await t.vfs.documentUpdatesSettled();
    });

    it('takes a history read that fails with another update of the batch it applies first as an outcome it cannot determine', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.editor.isDirty = true;
        t.reconnect('conn2');
        t.server.failNext = 1;                    // another client's queued update fails as the read applies it
        t.server.queue.push({update: {v: 11, op: [{p: 0, i: 'x'}]}, source: 'web'});
        await assert.rejects(t.vfs.documentUpdatesSettled(), namesMainTex(/^cannot be determined \(Overleaf refused to read the document's updates since then \('joinDoc' rejected: Something went wrong in real-time service\)\)$/));
        assert.strictEqual(t.server.emitted.length, 1);
    });

    it('ends at settled() an outcome it cannot determine by reading the doc, unless an editor holds unsaved changes', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.server.flush();
        t.reconnect('conn2');
        await t.vfs.documentUpdatesSettled();     // cannot be determined; then read as a reader that is not an editor
        assert.strictEqual(t.doc.undetermined, undefined);
        assert.strictEqual(t.doc.localCache, 'hello a');
        assert.strictEqual(notices.shown.length, 1);
        await t.vfs.writeDoc(t.uri, new TextEncoder().encode('hello a b'));
        assert.strictEqual(t.server.content, 'hello a b');
    });

    it('names a write that it could not ask Overleaf about with both reasons, each once', async () => {
        const t = setup('hello');
        await t.open();
        t.server.dropAfterApply = true;
        await assert.rejects(t.save('hello a'), /has not confirmed/);
        t.reconnect('conn2');
        t.server.connection = undefined;          // the connection is gone before the file system notices
        await assert.rejects(t.vfs.documentUpdatesSettled(), (error: any) => {
            assert.strictEqual(error.documents?.[0]?.reason, 'not confirmed (the connection was lost (disconnected); asking Overleaf about it failed: \'joinDoc\' timed out)', String(error));
            assert.ok(!error.message.includes('/test/main.tex'), error.message);
            return true;
        });
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
    it('rejects with FileNotFound when the path does not hold a document, and leaves Overleaf\'s text as it was', async () => {
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

describe('SocketIOAPI: how an emit ends', () => {
    it('tells a refusal in the callback from an emit that was not answered', async () => {
        const saved = SocketIOAPI.emitTimeoutMs;
        try {
            SocketIOAPI.emitTimeoutMs = 5;        // the emit's own limit, which this test is about
            const answers: Record<string, any> = {
                applyOtUpdate: { message: 'not authorized' },
                joinDoc: { message: 'doc updater could not load requested ops' },
            };
            const raw = {
                on() {},
                emit(event: string, ...args: any[]) {
                    const callback = args.pop();
                    if (answers[event]) { setImmediate(() => callback(answers[event])); }
                },
            };
            const api = Object.create(SocketIOAPI.prototype);
            Object.assign(api, { scheme: 'v1', _handlers: [], _eventBusCleanups: [], api: { _initSocketV0: () => raw } });
            api.init();
            const refused = await api.emit('applyOtUpdate', 'doc1', {}).catch((error: any) => error);
            assert.ok(refused instanceof EmitRefusedError, String(refused));
            assert.deepStrictEqual(refused.answer, { message: 'not authorized' });
            const missing = await api.emit('joinDoc', 'doc1', 10, {}).catch((error: any) => error);
            assert.ok(isMissingOpsRefusal(missing));
            assert.ok(!isMissingOpsRefusal(refused));
            const unanswered = await api.emit('clientTracking.getConnectedUsers').catch((error: any) => error);
            assert.ok(unanswered instanceof EmitTimeoutError, String(unanswered));
        } finally {
            SocketIOAPI.emitTimeoutMs = saved;
        }
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

describe('VirtualFileSystem: a rename or a move made on Overleaf', () => {
    /** A project with a folder "chapters" holding the document "ch", and a folder "parts"; its events as paths. */
    function project() {
        const handlers: any = {};
        const vfs = Object.create(VirtualFileSystem.prototype);
        vfs.socket = { isUsingAlternativeConnectionScheme: false, updateEventHandlers(h: any) { Object.assign(handlers, h); } };
        const batches: { type: number, path: string, renamedFrom?: string }[][] = [];
        vfs.notify = (events: any[]) => batches.push(events.map(e => ({ type: e.type, path: e.uri.path, ...(e.renamedFrom ? { renamedFrom: e.renamedFrom.path } : {}) })));
        vfs.pathToUri = (...parts: string[]) => ({ path: parts.join('/').replace(/\/+/g, '/') });
        vfs.root = { rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [], fileRefs: [], folders: [
            { _id: 'chapters', name: 'chapters', docs: [{ _id: 'ch', name: 'ch' }], fileRefs: [], folders: [] },
            { _id: 'parts', name: 'parts', docs: [], fileRefs: [], folders: [] },
        ] }] };
        vfs.connections = [];
        vfs.remoteWatch();
        return { handlers, batches };
    }
    const { Created, Deleted } = vscodeMock.FileChangeType;

    it('reports a renamed file at its new path, with the path it had, also when a folder name holds the file name', () => {
        const t = project();
        t.handlers.onFileRenamed('ch', 'intro');
        assert.deepStrictEqual(t.batches, [[{ type: Deleted, path: '/chapters/ch' }, { type: Created, path: '/chapters/intro', renamedFrom: '/chapters/ch' }]]);
    });

    it('reports a renamed folder at its new path, with the path it had', () => {
        const t = project();
        t.handlers.onFileRenamed('chapters', 'parts2');
        assert.deepStrictEqual(t.batches, [[{ type: Deleted, path: '/chapters/' }, { type: Created, path: '/parts2/', renamedFrom: '/chapters/' }]]);
    });

    it('reports a moved file at its new path, with the path it had', () => {
        const t = project();
        t.handlers.onFileMoved('ch', 'parts');
        assert.deepStrictEqual(t.batches, [[{ type: Deleted, path: '/chapters/ch' }, { type: Created, path: '/parts/ch', renamedFrom: '/chapters/ch' }]]);
    });
});

describe('VirtualFileSystem: a folder moved or deleted on Overleaf', () => {
    /** A project with the folders "chapters", holding the document "one.tex", and "parts"; the paths its tree holds. */
    function project() {
        const handlers: any = {};
        const vfs = Object.create(VirtualFileSystem.prototype);
        vfs.socket = { isUsingAlternativeConnectionScheme: false, updateEventHandlers(h: any) { Object.assign(handlers, h); } };
        vfs.notify = () => {};
        vfs.pathToUri = (...parts: string[]) => ({ path: parts.join('/').replace(/\/+/g, '/') });
        vfs.root = { rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [], fileRefs: [], folders: [
            { _id: 'chapters', name: 'chapters', docs: [{ _id: 'one', name: 'one.tex' }], fileRefs: [], folders: [] },
            { _id: 'parts', name: 'parts', docs: [], fileRefs: [], folders: [] },
        ] }] };
        vfs.connections = [];
        vfs.remoteWatch();
        const paths = () => vfs.walk(() => true).map((e: any) => e.path).sort();
        return { handlers, paths };
    }

    it('holds a moved folder at its new path only', () => {
        const t = project();
        t.handlers.onFileMoved('chapters', 'parts');
        assert.deepStrictEqual(t.paths(), ['/', '/parts', '/parts/chapters', '/parts/chapters/one.tex']);
    });

    it('holds a deleted folder nowhere', () => {
        const t = project();
        t.handlers.onFileRemoved('chapters');
        assert.deepStrictEqual(t.paths(), ['/', '/parts']);
    });
});
