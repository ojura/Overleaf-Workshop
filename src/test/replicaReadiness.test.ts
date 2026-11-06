/* eslint-disable @typescript-eslint/naming-convention -- the replica's exported class and VS Code API */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Cleanup, Uri, load, world } from './replicaTestWorld';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
}

describe('the replica readiness acknowledgement', function () {
    this.timeout(10_000);
    let cleanup: Cleanup, folder: string;
    beforeEach(() => {
        cleanup = new Cleanup(); cleanup.privateRuntime();
        folder = cleanup.tempDir('replica-ready-');
    });
    afterEach(() => cleanup.undo());

    async function start(t: ReturnType<typeof world>) {
        const { LocalReplicaSCMProvider, requestReplica } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await cleanup.controlListens(folder);
        const identity = await requestReplica(folder, { op: 'host' }, 2000);
        assert.strictEqual(identity.ok, true);
        const ask = (op: 'ready' | 'reload' = 'ready', timeoutMs = 5000): Promise<any> => requestReplica(folder,
            { op, folder, host: identity.host.id, ...(op === 'reload' ? { id: 'provider-reload' } : {}) }, timeoutMs);
        return { scm, ask };
    }

    it('waits for the actual initial download and queued changes without rescanning the folder', async () => {
        const t = world(folder, true), entered = deferred(), release = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const openFile = t.vfs.openFile;
        t.vfs.openFile = async uri => { entered.resolve(); await release.promise; return openFile(uri); };
        const { scm, ask } = await start(t);
        let finished = false;
        const ready = ask().then(answer => { finished = true; return answer; });
        try {
            await entered.promise;
            assert.strictEqual(finished, false);
        } finally { release.resolve(); }
        const answer = await ready;
        assert.strictEqual(answer.ok, true, JSON.stringify(answer));
        assert.strictEqual(answer.ready, true);
        assert.strictEqual(answer.fullSyncRunning, false);
        assert.deepStrictEqual(answer.initialSync.downloaded, ['/main.tex']);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'initial\n');

        let scans = 0;
        const syncAll = scm.sync.syncAll;
        scm.sync.syncAll = (...args: unknown[]) => { scans++; return syncAll.apply(scm.sync, args); };
        t.remoteChange('/main.tex', 'queued change\n');
        const changed = await ask();
        assert.strictEqual(changed.ok, true, JSON.stringify(changed));
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'queued change\n');
        assert.strictEqual(scans, 0, 'readiness drains existing work instead of starting another full sync');
        assert.deepStrictEqual(t.w.remoteWrites, []);
    });

    it('rejects a cancelled initial comparison with unchecked files', async () => {
        const t = world(folder, true), entered = deferred(), release = deferred();
        for (let i = 0; i < 24; i++) { t.w.remote.set(`/chapter-${i}.tex`, 'text\n'); }
        let cancel!: () => void;
        t.mock.window.withProgress = (_options: unknown, task: any) => task({ report() {} }, {
            isCancellationRequested: false, onCancellationRequested(callback: () => void) { cancel = callback; },
        });
        const openFile = t.vfs.openFile;
        t.vfs.openFile = async uri => { entered.resolve(); await release.promise; return openFile(uri); };
        const { ask } = await start(t);
        const ready = ask();
        try { await entered.promise; cancel(); } finally { release.resolve(); }
        const answer = await ready;
        assert.strictEqual(answer.ok, false);
        assert.strictEqual(answer.ready, false);
        assert.ok(answer.initialSync.notChecked > 0);
        assert.match(answer.error, /unchecked/);
    });

    it('does not reload while the initial download has failed', async () => {
        const t = world(folder, true), calls: string[] = [];
        t.w.remote.set('/main.tex', 'initial\n');
        t.vfs.openFile = async () => { throw new Error('fixture download failed'); };
        t.mock.commands = { executeCommand: async (command: string) => { calls.push(command); } };
        const { ask } = await start(t);
        const answer = await ask('reload');
        assert.strictEqual(answer.ok, false);
        assert.match(answer.error, /fixture download failed/);
        assert.ok(answer.initialSync.failed.some((file: any) => file.path === '/main.tex'));
        assert.deepStrictEqual(calls, []);
    });

    it('requires the live connection and invokes the canonical window command once when ready', async () => {
        const t = world(folder, true), invoked = deferred(), calls: string[] = [];
        t.w.remote.set('/main.tex', 'initial\n');
        t.mock.commands = { executeCommand: async (command: string) => { calls.push(command); invoked.resolve(); } };
        const { ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        t.vfs.connected = false;
        const offline = await ask();
        assert.strictEqual(offline.ok, false);
        assert.match(offline.error, /not connected/);
        t.vfs.connected = true;
        assert.strictEqual((await ask('reload')).ok, true);
        await invoked.promise;
        assert.deepStrictEqual(calls, ['workbench.action.reloadWindow']);
        assert.deepStrictEqual(t.w.remoteWrites, []);
    });

    it('reports a queued download failure until that actual path recovers', async () => {
        const t = world(folder, true), entered = deferred(), release = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const openFile = t.vfs.openFile;
        t.vfs.openFile = async () => { entered.resolve(); await release.promise; throw new Error('queued download failed'); };
        t.remoteChange('/main.tex', 'remote update\n');
        await entered.promise;
        const ready = ask();
        release.resolve();
        const failed = await ready;
        assert.strictEqual(failed.ok, false);
        assert.strictEqual(failed.ready, false);
        assert.match(failed.error, /queued download failed/);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'initial\n');
        assert.strictEqual((await ask()).ok, false, 'an empty later flush cannot erase the unresolved failure');
        t.vfs.openFile = openFile;
        t.remoteChange('/main.tex', 'recovered update\n');
        const recovered = await ask();
        assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
        assert.deepStrictEqual(recovered.summary.failed, []);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'recovered update\n');
    });

    it('retains a local preparation failure until the received file actually recovers', async () => {
        const t = world(folder, true), failed = deferred(), uploaded = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const stat = scm.sync.local.stat.bind(scm.sync.local), writeDoc = t.vfs.writeDoc;
        let fail = true;
        scm.sync.local.stat = async (file: string) => {
            if (file === '/main.tex' && fail) { fail = false; failed.resolve(); throw new Error('local preparation failed'); }
            return stat(file);
        };
        fs.writeFileSync(path.join(folder, 'main.tex'), 'local update\n');
        await failed.promise;
        const blocked = await ask();
        assert.strictEqual(blocked.ok, false);
        assert.match(blocked.error, /local preparation failed/);
        assert.strictEqual(t.w.remote.get('/main.tex'), 'initial\n');
        t.vfs.writeDoc = async (uri, bytes) => { await writeDoc(uri, bytes); uploaded.resolve(); };
        fs.writeFileSync(path.join(folder, 'main.tex'), 'recovered local update\n');
        await uploaded.promise;
        assert.strictEqual((await ask()).ok, true);
        assert.strictEqual(t.w.remote.get('/main.tex'), 'recovered local update\n');
    });

    it('retains an aggregate scan failure until a successful scan recovers it', async () => {
        const t = world(folder, true);
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const list = scm.sync.local.list.bind(scm.sync.local);
        let scans = 0;
        scm.sync.local.list = async () => { scans++; throw new Error('local enumeration failed'); };
        await scm.scanFolder();
        const blocked = await ask();
        assert.strictEqual(blocked.ok, false);
        assert.match(blocked.error, /local enumeration failed/);
        assert.strictEqual(scans, 1, 'readiness did not hide the failure with a new scan');
        scm.sync.local.list = async () => { scans++; return list(); };
        await scm.scanFolder();
        assert.strictEqual((await ask()).ok, true);
        assert.strictEqual(scans, 2);
    });

    it('waits for the existing automatic comparison and cancels only the readiness request', async () => {
        const t = world(folder, true), entered = deferred(), release = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const workTree = scm.sync.store.workTree.bind(scm.sync.store), list = scm.sync.remote.list.bind(scm.sync.remote);
        let blocked = true;
        scm.sync.store.workTree = async () => blocked ? { operation: 'a merge' } : workTree();
        t.remoteChange('/main.tex', 'while git waited\n');
        await Promise.all([...scm.liveWork]);
        assert.match(scm.sync.waitingFor, /merge/);
        scm.sync.remote.list = async () => { entered.resolve(); await release.promise; return list(); };
        const listeners = scm.sync.questionListeners.size;
        const requestFinished = deferred(), toolReady = scm.toolReady.bind(scm);
        scm.toolReady = (signal?: AbortSignal) => toolReady(signal).finally(() => {
            if (signal?.aborted) { requestFinished.resolve(); }
        });
        blocked = false;
        const waiting = ask('ready', 500);
        try {
            await entered.promise;
            await assert.rejects(waiting, /did not answer/);
            await requestFinished.promise;
            assert.strictEqual(scm.sync.questionListeners.size, listeners);
            assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'initial\n');
        } finally { release.resolve(); }
        const recovered = await ask();
        assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'while git waited\n');
    });

    it('retains an automatic comparison preparation failure until an actual comparison recovers', async () => {
        const t = world(folder, true), entered = deferred(), release = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const workTree = scm.sync.store.workTree.bind(scm.sync.store), list = scm.sync.remote.list.bind(scm.sync.remote);
        let blocked = true;
        scm.sync.store.workTree = async () => blocked ? { operation: 'a merge' } : workTree();
        t.remoteChange('/main.tex', 'waiting update\n');
        await Promise.all([...scm.liveWork]);
        scm.sync.remote.list = async () => { entered.resolve(); await release.promise; throw new Error('automatic listing failed'); };
        blocked = false;
        const waiting = ask();
        try { await entered.promise; } finally { release.resolve(); }
        const failed = await waiting;
        assert.strictEqual(failed.ok, false);
        assert.match(failed.error, /automatic listing failed/);
        assert.strictEqual((await ask()).ok, false);
        await scm.scanFolder();
        assert.strictEqual((await ask()).ok, false, 'a local-only scan cannot recover a failed complete comparison');
        scm.sync.remote.list = list;
        await scm.syncAll();
        const recovered = await ask();
        assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'waiting update\n');
    });

    it('returns a deletion question from the automatic catch-up without owning its answer', async () => {
        const t = world(folder, true), shown = deferred();
        for (let i = 0; i < 6; i++) { t.w.remote.set(`/chapter-${i}.tex`, 'text\n'); }
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const workTree = scm.sync.store.workTree.bind(scm.sync.store);
        let blocked = true;
        scm.sync.store.workTree = async () => blocked ? { operation: 'a merge' } : workTree();
        for (let i = 0; i < 6; i++) { t.remoteDelete(`/chapter-${i}.tex`); }
        await Promise.all([...scm.liveWork]);
        let choose: (() => void) | undefined;
        t.mock.window.showWarningMessage = (_message: string, options: any, action: string) => {
            if (!options?.modal) { return Promise.resolve(undefined); }
            return new Promise<string>(resolve => { choose = () => resolve(action); shown.resolve(); });
        };
        const listeners = scm.sync.questionListeners.size;
        blocked = false;
        const ready = ask();
        try {
            await shown.promise;
            const question = await ready;
            assert.strictEqual(question.ok, false);
            assert.strictEqual(question.question.paths.length, 6);
            assert.strictEqual(scm.sync.questionListeners.size, listeners);
            assert.strictEqual(fs.existsSync(path.join(folder, 'chapter-0.tex')), true);
        } finally { choose?.(); }
        assert.strictEqual((await ask()).ok, true);
        assert.strictEqual(fs.existsSync(path.join(folder, 'chapter-0.tex')), false);
    });

    it('rechecks outcomes when a complete received event occurs during the Git snapshot', async () => {
        const t = world(folder, true), entered = deferred(), release = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const gitState = scm.gitState.bind(scm);
        let first = true;
        scm.gitState = async () => {
            if (first) { first = false; entered.resolve(); await release.promise; }
            return gitState();
        };
        const ready = ask();
        try {
            await entered.promise;
            t.vfs.openFile = async () => { throw new Error('event after snapshot failed'); };
            t.remoteChange('/main.tex', 'later remote update\n');
            await Promise.all([...scm.liveWork]);
            assert.strictEqual(scm.liveWork.size, 0);
        } finally { release.resolve(); }
        const blocked = await ready;
        assert.strictEqual(blocked.ok, false);
        assert.match(blocked.error, /event after snapshot failed/);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'initial\n');
    });

    it('keeps a newer same-path preparation failure when an older read completes', async () => {
        const t = world(folder, false), entered = deferred(), release = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const openFile = t.vfs.openFile, resolveUri = t.vfs._resolveUri;
        t.vfs.openFile = async uri => {
            const bytes = await openFile(uri); entered.resolve(); await release.promise; return bytes;
        };
        t.remoteChange('/main.tex', 'older received update\n');
        try {
            await entered.promise;
            t.vfs._resolveUri = async () => { throw new Error('newer same-path preparation failed'); };
            await scm.sync.remoteChanged('/main.tex', false);
        } finally { t.vfs._resolveUri = resolveUri; release.resolve(); }
        await Promise.all([...scm.liveWork]);
        const blocked = await ask();
        assert.strictEqual(blocked.ok, false);
        assert.match(blocked.error, /newer same-path preparation failed/);
        t.vfs.openFile = openFile;
        t.remoteChange('/main.tex', 'new recovery\n');
        assert.strictEqual((await ask()).ok, true);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'new recovery\n');
    });

    it('rechecks a received event that begins before the outcome snapshot and finishes during Git state', async () => {
        const t = world(folder, true), preparing = deferred(), finishPreparation = deferred(), readingGit = deferred(), finishGit = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const receivedWork = scm.receivedWork.bind(scm), gitState = scm.gitState.bind(scm), resolveUri = t.vfs._resolveUri;
        let receive = true, readGit = true;
        t.vfs._resolveUri = async uri => {
            if (uri.path === '/project/main.tex') {
                preparing.resolve(); await finishPreparation.promise;
                throw new Error('pre-snapshot event preparation failed');
            }
            return resolveUri(uri);
        };
        scm.receivedWork = async (signal?: AbortSignal) => {
            const question = await receivedWork(signal);
            if (receive) {
                receive = false;
                t.remoteChange('/main.tex', 'preparing update\n');
                await preparing.promise;
            }
            return question;
        };
        scm.gitState = async () => {
            if (readGit) { readGit = false; readingGit.resolve(); await finishGit.promise; }
            return gitState();
        };
        const ready = ask();
        try {
            await readingGit.promise;
            finishPreparation.resolve();
            await Promise.all([...scm.liveWork]);
            assert.strictEqual(scm.liveWork.size, 0);
        } finally { finishPreparation.resolve(); finishGit.resolve(); }
        const blocked = await ready;
        assert.strictEqual(blocked.ok, false);
        assert.match(blocked.error, /pre-snapshot event preparation failed/);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'initial\n');
    });

    it('does not create readiness listeners for an already cancelled request', async () => {
        const t = world(folder, true);
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const questionOpened = scm.sync.questionOpened.bind(scm.sync);
        let listeners = 0;
        scm.sync.questionOpened = () => { listeners++; return questionOpened(); };
        const abort = new AbortController(); abort.abort();
        await assert.rejects(scm.toolReady(abort.signal), /cancelled/);
        assert.strictEqual(listeners, 0);
    });

    it('removes abandoned readiness listeners while the received download continues', async () => {
        const t = world(folder, true), entered = deferred(), release = deferred(), waiting = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const openFile = t.vfs.openFile;
        t.vfs.openFile = async uri => { entered.resolve(); await release.promise; return openFile(uri); };
        t.remoteChange('/main.tex', 'continued download\n');
        await entered.promise;
        const receivedWork = scm.receivedWork.bind(scm);
        scm.receivedWork = (signal?: AbortSignal) => { const work = receivedWork(signal); waiting.resolve(); return work; };
        const abort = new AbortController(), ready = scm.toolReady(abort.signal);
        let timer: NodeJS.Timeout | undefined;
        try {
            await waiting.promise;
            assert.ok(scm.sync.questionListeners.size > 0);
            abort.abort();
            await assert.rejects(Promise.race([ready, new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('readiness ignored caller cancellation')), 500);
            })]), /request was cancelled/);
            assert.strictEqual(scm.sync.questionListeners.size, 0);
            assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'initial\n');
        } finally { clearTimeout(timer); release.resolve(); }
        await ready.catch(() => {});
        assert.strictEqual((await ask()).ok, true);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'continued download\n');
    });

    it('waits for a received remote event still preparing before its path queue', async () => {
        const t = world(folder, true), entered = deferred(), release = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const resolveUri = t.vfs._resolveUri;
        t.vfs._resolveUri = async uri => { entered.resolve(); await release.promise; return resolveUri(uri); };
        t.remoteChange('/main.tex', 'prepared update\n');
        try {
            await entered.promise;
            await assert.rejects(ask('ready', 500), /did not answer/);
        } finally { release.resolve(); }
        assert.strictEqual((await ask()).ok, true);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'prepared update\n');
    });

    it('clears an aggregate folder preparation failure after a complete successful comparison', async () => {
        const t = world(folder, true);
        t.w.remote.set('/chapter/part.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const resolveUri = t.vfs._resolveUri;
        t.vfs._resolveUri = async uri => {
            if (uri.path === '/project/chapter') { throw new Error('folder lookup failed'); }
            return resolveUri(uri);
        };
        await scm.sync.remoteChanged('/chapter', false);
        const failed = await ask();
        assert.strictEqual(failed.ok, false);
        assert.match(failed.error, /folder lookup failed/);
        t.vfs._resolveUri = resolveUri;
        await scm.syncAll();
        const recovered = await ask();
        assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
        assert.deepStrictEqual(recovered.summary.failed, []);
    });

    it('retains a newer folder failure when an older full comparison finishes', async () => {
        const t = world(folder, true), entered = deferred(), release = deferred();
        t.w.remote.set('/chapter/part.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const openFile = t.vfs.openFile, resolveUri = t.vfs._resolveUri;
        t.vfs.openFile = async uri => { entered.resolve(); await release.promise; return openFile(uri); };
        const comparing = scm.syncAll();
        try {
            await entered.promise;
            t.vfs._resolveUri = async uri => {
                if (uri.path === '/project/chapter') { throw new Error('newer folder failure'); }
                return resolveUri(uri);
            };
            await scm.sync.remoteChanged('/chapter', false);
        } finally { release.resolve(); }
        await comparing;
        t.vfs.openFile = openFile; t.vfs._resolveUri = resolveUri;
        const stillFailed = await ask();
        assert.strictEqual(stillFailed.ok, false);
        assert.match(stillFailed.error, /newer folder failure/);
        await scm.syncAll();
        assert.strictEqual((await ask()).ok, true);
    });

    it('waits for local file-event preparation before deciding whether to sync it', async () => {
        const t = world(folder, false), entered = deferred(), release = deferred();
        t.w.remote.set('/main.tex', 'initial\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        const knows = scm.sync.knows.bind(scm.sync);
        scm.sync.knows = async (file: string) => {
            if (file === '/new.tex') { entered.resolve(); await release.promise; }
            return knows(file);
        };
        fs.writeFileSync(path.join(folder, 'new.tex'), 'new local document\n');
        try {
            await entered.promise;
            await assert.rejects(ask('ready', 500), /did not answer/);
        } finally { release.resolve(); }
        assert.strictEqual((await ask()).ok, true);
        assert.strictEqual(t.w.remote.get('/new.tex'), 'new local document\n');
    });

    it('keeps a live conflict not ready until its staged resolution reaches Overleaf', async () => {
        const t = world(folder, false);
        t.w.remote.set('/main.tex', 'base line\n');
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        fs.writeFileSync(path.join(folder, 'main.tex'), 'local line\n');
        t.remoteChange('/main.tex', 'remote line\n');
        await cleanup.folderShows(folder, () => fs.readFileSync(path.join(folder, 'main.tex'), 'utf8').includes('<<<<<<< Local'));
        const conflict = await ask();
        assert.strictEqual(conflict.ok, false);
        assert.ok(conflict.summary.conflicts.includes('/main.tex'));
        fs.writeFileSync(path.join(folder, 'main.tex'), 'resolved line\n');
        await scm.store.git.run(['add', '--', 'main.tex']);
        await scm.sync.localChanged('/main.tex');
        const recovered = await ask();
        assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
        assert.deepStrictEqual(recovered.summary.conflicts, []);
        assert.strictEqual(t.w.remote.get('/main.tex'), 'resolved line\n');
    });

    it('reports a question opened during queued work and retains declined deletions until retry', async () => {
        const t = world(folder, true), shown = deferred();
        for (let i = 0; i < 6; i++) { t.w.remote.set(`/chapter-${i}.tex`, 'text\n'); }
        const { scm, ask } = await start(t);
        assert.strictEqual((await ask()).ok, true);
        let choose: ((value: string | undefined) => void) | undefined;
        t.mock.window.showWarningMessage = (_message: string, options: any) => {
            if (!options?.modal) { return Promise.resolve(undefined); }
            return new Promise<string | undefined>(resolve => { choose = resolve; shown.resolve(); });
        };
        for (let i = 0; i < 6; i++) { t.remoteDelete(`/chapter-${i}.tex`); }
        const waiting = ask();
        try {
            await shown.promise;
            const question = await waiting;
            assert.strictEqual(question.ok, false);
            assert.strictEqual(question.question.paths.length, 6);
        } finally { choose?.(undefined); }
        const declined = await ask();
        assert.strictEqual(declined.ok, false);
        assert.strictEqual(declined.summary.skippedDeletions.length, 6);
        t.mock.window.showWarningMessage = async (_message: string, options: any, action: string) => options?.modal ? action : undefined;
        await scm.syncAll();
        assert.strictEqual((await ask()).ok, true);
        assert.ok([...t.w.remote.keys()].length === 0);
        assert.strictEqual(fs.existsSync(path.join(folder, 'chapter-0.tex')), false);
    });
});
