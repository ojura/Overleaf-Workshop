import * as assert from 'assert';
import {
    gitBlobHash, LocalStat, RemoteEntry, ReplicaLocal, ReplicaRemote, ReplicaStore, ReplicaSync,
    ReplicaUI, SavedState, SyncSummary,
} from '../scm/replicaSync';

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Overleaf, in memory: docs hold text, files hold bytes and report their hash. */
class FakeRemote implements ReplicaRemote {
    /** the error that Overleaf's requests get while it does not answer; undefined while it answers */
    lost?: Error;
    disconnected() { return this.lost; }
    docs = new Map<string, string>();
    files = new Map<string, Uint8Array>();
    folders = new Set<string>();
    /** files whose tree entry carries no hash */
    noHash = new Set<string>();
    calls: string[] = [];
    failReads = new Map<string, number>();
    failWrites = new Map<string, number>();
    corruptReads = new Set<string>();

    async list() {
        const all = new Map<string, RemoteEntry>();
        for (const path of this.docs.keys()) { all.set(path, {kind: 'doc'}); }
        for (const path of this.files.keys()) { all.set(path, (await this.entry(path))!); }
        return all;
    }
    async entry(path: string): Promise<RemoteEntry | undefined> {
        if (this.docs.has(path)) { return {kind: 'doc'}; }
        const content = this.files.get(path);
        if (content===undefined) { return undefined; }
        return this.noHash.has(path) ? {kind: 'file'} : {kind: 'file', hash: gitBlobHash(content)};
    }
    async isFolder(path: string) { return this.folders.has(path); }
    async readDoc(path: string) {
        this.calls.push(`readDoc ${path}`);
        const text = this.docs.get(path);
        if (text===undefined) { throw new Error(`no doc ${path}`); }
        return text;
    }
    async readFile(path: string) {
        this.calls.push(`readFile ${path}`);
        const failures = this.failReads.get(path) ?? 0;
        if (failures>0) {
            this.failReads.set(path, failures-1);
            throw new Error('getaddrinfo EAI_AGAIN www.overleaf.com');
        }
        const content = this.files.get(path);
        if (content===undefined) { throw new Error(`no file ${path}`); }
        return this.corruptReads.has(path) ? content.slice(0, 3) : content;
    }
    async writeDoc(path: string, text: string) {
        this.calls.push(`writeDoc ${path}`);
        const failures = this.failWrites.get(path) ?? 0;
        if (failures>0) {
            this.failWrites.set(path, failures-1);
            throw new Error(`'applyOtUpdate' timed out after 15000ms`);
        }
        this.docs.set(path, text);
    }
    async upload(path: string, content: Uint8Array): Promise<RemoteEntry> {
        this.calls.push(`upload ${path}`);
        if (path.endsWith('.tex') && !this.files.has(path)) {
            this.docs.set(path, dec(content));
            return {kind: 'doc'};
        }
        this.files.set(path, content);
        return {kind: 'file', hash: gitBlobHash(content)};
    }
    async remove(path: string) {
        this.calls.push(`remove ${path}`);
        this.docs.delete(path);
        this.files.delete(path);
    }
    async removeFolderIfEmpty() {}
    async settled() {}
    count(prefix: string) { return this.calls.filter(call => call.startsWith(prefix)).length; }
}

/** The local folder, in memory, with a clock for modification times. */
class FakeLocal implements ReplicaLocal {
    async verify() {}
    files = new Map<string, {content: Uint8Array, mtime: number}>();
    clock = 1_000_000;
    reads: string[] = [];

    set(path: string, content: string | Uint8Array) {
        this.clock += 10_000;
        this.files.set(path, {content: typeof content==='string' ? enc(content) : content, mtime: this.clock});
    }
    text(path: string) { const f = this.files.get(path); return f && dec(f.content); }
    async list() {
        const all = new Map<string, LocalStat>();
        for (const [path, f] of this.files) { all.set(path, {size: f.content.byteLength, mtime: f.mtime}); }
        return all;
    }
    async stat(path: string): Promise<LocalStat | 'folder' | undefined> {
        const f = this.files.get(path);
        if (f) { return {size: f.content.byteLength, mtime: f.mtime}; }
        const prefix = `${path}/`;
        for (const p of this.files.keys()) { if (p.startsWith(prefix)) { return 'folder'; } }
        return undefined;
    }
    async read(path: string) { this.reads.push(path); return this.files.get(path)?.content; }
    async write(path: string, content: Uint8Array) {
        this.set(path, content);
        return {size: content.byteLength, mtime: this.clock};
    }
    async remove(path: string) { this.files.delete(path); }
    async removeFolderIfEmpty() {}
}

class FakeStore implements ReplicaStore {
    state?: SavedState;
    bases = new Map<string, string>();
    copies = new Map<string, Uint8Array>();
    async load() { return this.state && JSON.parse(JSON.stringify(this.state)); }
    async save(state: SavedState) { this.state = JSON.parse(JSON.stringify(state)); }
    async readBase(hash: string) { return this.bases.get(hash); }
    async writeBase(hash: string, text: string) { this.bases.set(hash, text); }
    async pruneBases(keep: Set<string>) { for (const hash of [...this.bases.keys()]) { if (!keep.has(hash)) { this.bases.delete(hash); } } }
    async keepCopy(path: string, content: Uint8Array) {
        const copy = `/.overleaf/sync/conflicts/x${path}`;
        this.copies.set(copy, content);
        return copy;
    }
}

class FakeUI implements ReplicaUI {
    logs: string[] = [];
    confirm = true;
    /** while set, the answer to a question, e.g. one that never comes */
    answer?: Promise<boolean>;
    /** told when a question is asked */
    onAsk?: () => void;
    asked: string[][] = [];
    blocked: string[] = [];
    live: SyncSummary[] = [];
    log(message: string) { this.logs.push(message); }
    progress() {}
    async confirmDeletions(_where: 'local' | 'remote', paths: string[]) { this.asked.push(paths); this.onAsk?.(); return this.answer ?? this.confirm; }
    conflictBlocked(path: string) { this.blocked.push(path); }
    liveResult(summary: SyncSummary) { this.live.push(summary); }
}

function setup() {
    const remote = new FakeRemote();
    const local = new FakeLocal();
    const store = new FakeStore();
    const ui = new FakeUI();
    const ignored = (path: string) => path.endsWith('.aux');
    const start = () => new ReplicaSync(remote, local, store, ui, ignored);
    return {remote, local, store, ui, start};
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const png2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
const text = 'line 1\nline 2\nline 3\nline 4\nline 5\n';

describe('ReplicaSync', () => {
    before(() => { ReplicaSync.remoteDeleteDelayMs = 0; ReplicaSync.saveDelayMs = 0; });

    it('downloads a new project and saves what it downloaded', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        t.remote.files.set('/fig/a.png', png);
        const summary = await t.start().syncAll();
        assert.deepStrictEqual(summary.downloaded.sort(), ['/fig/a.png', '/main.tex']);
        assert.strictEqual(t.local.text('/main.tex'), text);
        assert.deepStrictEqual(t.local.files.get('/fig/a.png')!.content, png);
        assert.deepStrictEqual(Object.keys(t.store.state!.entries).sort(), ['/fig/a.png', '/main.tex']);
    });

    it('does not download files whose hash matches the local copy, even without saved state', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        t.remote.files.set('/a.png', png);
        t.local.set('/main.tex', text);
        t.local.set('/a.png', png);
        const summary = await t.start().syncAll();
        assert.strictEqual(t.remote.count('readFile'), 0);
        assert.deepStrictEqual(summary.downloaded, []);
        assert.strictEqual(summary.unchanged, 2);
    });

    it('does not read unchanged local files again on the next sync', async () => {
        const t = setup();
        t.remote.files.set('/a.png', png);
        t.local.set('/a.png', png);
        await t.start().syncAll();
        t.local.reads = [];
        const summary = await t.start().syncAll();
        assert.deepStrictEqual(t.local.reads, []);
        assert.strictEqual(summary.unchanged, 1);
    });

    it('uploads files changed locally while the editor was closed', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        t.remote.files.set('/a.png', png);
        await t.start().syncAll();
        t.local.set('/main.tex', text + 'line 6\n');
        t.local.set('/a.png', png2);
        const summary = await t.start().syncAll();
        assert.deepStrictEqual(summary.uploaded.sort(), ['/a.png', '/main.tex']);
        assert.strictEqual(t.remote.docs.get('/main.tex'), text + 'line 6\n');
        assert.deepStrictEqual(t.remote.files.get('/a.png'), png2);
    });

    it('downloads files changed on Overleaf while the editor was closed', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        t.remote.files.set('/a.png', png);
        await t.start().syncAll();
        t.remote.docs.set('/main.tex', 'line 0\n' + text);
        t.remote.files.set('/a.png', png2);
        const summary = await t.start().syncAll();
        assert.deepStrictEqual(summary.downloaded.sort(), ['/a.png', '/main.tex']);
        assert.strictEqual(t.local.text('/main.tex'), 'line 0\n' + text);
        assert.strictEqual(t.remote.count('writeDoc') + t.remote.count('upload'), 0);
    });

    it('merges a document changed on both sides in different places', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        await t.start().syncAll();
        t.local.set('/main.tex', text.replace('line 1', 'line one'));
        t.remote.docs.set('/main.tex', text.replace('line 5', 'line five'));
        const summary = await t.start().syncAll();
        const merged = text.replace('line 1', 'line one').replace('line 5', 'line five');
        assert.deepStrictEqual(summary.merged, ['/main.tex']);
        assert.strictEqual(t.local.text('/main.tex'), merged);
        assert.strictEqual(t.remote.docs.get('/main.tex'), merged);
    });

    it('marks overlapping changes and uploads nothing until they are resolved', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        await t.start().syncAll();
        t.local.set('/main.tex', text.replace('line 3', 'line three, local'));
        t.remote.docs.set('/main.tex', text.replace('line 3', 'line three, remote'));
        const sync = t.start();
        const summary = await sync.syncAll();
        assert.deepStrictEqual(summary.conflicts, ['/main.tex']);
        assert.match(t.local.text('/main.tex')!, /<<<<<<< Local\nline three, local\n=======\nline three, remote\n>>>>>>> Remote/);
        assert.strictEqual(t.remote.docs.get('/main.tex'), text.replace('line 3', 'line three, remote'));

        // saving the file with the markers still in it does not upload it
        t.local.set('/main.tex', t.local.text('/main.tex')! + '% note\n');
        await sync.localChanged('/main.tex');
        assert.strictEqual(t.remote.count('writeDoc'), 0);
        assert.deepStrictEqual(t.ui.blocked, ['/main.tex']);

        // a new change on Overleaf is taken in, still without uploading the markers
        t.remote.docs.set('/main.tex', 'line 0\n' + text.replace('line 3', 'line three, remote'));
        await sync.remoteChanged('/main.tex', false);
        assert.strictEqual(t.remote.count('writeDoc'), 0);
        assert.match(t.local.text('/main.tex')!, /^line 0\n/);

        // once resolved, the resolution is uploaded
        const resolved = 'line 0\n' + text.replace('line 3', 'line three, both');
        t.local.set('/main.tex', resolved);
        await sync.localChanged('/main.tex');
        assert.strictEqual(t.remote.docs.get('/main.tex'), resolved);
        await sync.stop();
        assert.strictEqual(t.store.state!.entries['/main.tex'].conflict, undefined);
    });

    it('keeps the local version of a binary file changed on both sides', async () => {
        const t = setup();
        t.remote.files.set('/a.png', png);
        await t.start().syncAll();
        t.local.set('/a.png', png2);
        t.remote.files.set('/a.png', new Uint8Array([1, 2, 3]));
        const summary = await t.start().syncAll();
        assert.strictEqual(summary.keptAside.length, 1);
        assert.deepStrictEqual(t.local.files.get('/a.png')!.content, new Uint8Array([1, 2, 3]));
        assert.deepStrictEqual(t.store.copies.get(summary.keptAside[0].copy), png2);
        assert.strictEqual(t.remote.count('upload'), 0);
    });

    it('without saved state, puts Overleaf in place and keeps a differing local file', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        t.local.set('/main.tex', text + 'unsaved local work\n');
        const summary = await t.start().syncAll();
        assert.strictEqual(t.local.text('/main.tex'), text);
        assert.strictEqual(dec(t.store.copies.get(summary.keptAside[0].copy)!), text + 'unsaved local work\n');
        assert.strictEqual(t.remote.count('writeDoc'), 0);
    });

    it('without saved state, leaves local-only files alone until asked to upload them', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        t.local.set('/main.tex', text);
        t.local.set('/notes.tex', 'notes');
        const sync = t.start();
        const summary = await sync.syncAll();
        assert.deepStrictEqual(summary.untracked, ['/notes.tex']);
        assert.strictEqual(t.remote.count('upload'), 0);

        // still left alone on the next sync and when edited
        await t.start().syncAll();
        t.local.set('/notes.tex', 'more notes');
        await sync.localChanged('/notes.tex');
        assert.strictEqual(t.remote.count('upload'), 0);

        await sync.uploadUntracked();
        assert.strictEqual(t.remote.docs.get('/notes.tex'), 'more notes');
    });

    it('uploads a file created locally while the editor was closed', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        await t.start().syncAll();
        t.local.set('/chapter.tex', 'chapter');
        const summary = await t.start().syncAll();
        assert.deepStrictEqual(summary.uploaded, ['/chapter.tex']);
        assert.strictEqual(t.remote.docs.get('/chapter.tex'), 'chapter');
    });

    it('deletes on Overleaf what was deleted locally, asking first when it is many files', async () => {
        const t = setup();
        for (let i = 0; i < 8; i++) { t.remote.files.set(`/f${i}.png`, new Uint8Array([i])); }
        await t.start().syncAll();
        t.local.files.delete('/f0.png');
        let summary = await t.start().syncAll();
        assert.deepStrictEqual(summary.deletedRemote, ['/f0.png']);
        assert.strictEqual(t.ui.asked.length, 0);

        for (let i = 1; i < 8; i++) { t.local.files.delete(`/f${i}.png`); }
        t.ui.confirm = false;
        summary = await t.start().syncAll();
        assert.strictEqual(t.ui.asked.length, 1);
        assert.strictEqual(summary.skippedDeletions.length, 7);
        assert.strictEqual(t.remote.files.size, 7);
    });

    it('does not take a file missing on Overleaf for deleted while Overleaf does not answer, and fails with Overleaf\'s reason', async () => {
        const t = setup();
        t.remote.docs.set('/a.tex', text);
        const sync = t.start();
        await sync.syncAll();
        // the project tree lacks the file, but Overleaf does not answer: the tree may be old
        t.remote.docs.delete('/a.tex');
        t.remote.lost = new Error('Not connected to Overleaf, as the test has it');
        const summary = await sync.syncAll();
        assert.deepStrictEqual(summary.failed, [{ path: '/a.tex', error: t.remote.lost.message }]);
        assert.strictEqual(t.local.text('/a.tex'), text, 'the local file stays');
    });

    it('counts deletions that events report one at a time together, and asks once before making many', async () => {
        const saved = ReplicaSync.localDeleteDelayMs;
        ReplicaSync.localDeleteDelayMs = 0;
        try {
            const t = setup();
            for (let i = 0; i < 8; i++) { t.remote.files.set(`/f${i}.png`, new Uint8Array([i])); }
            const sync = t.start();
            await sync.syncAll();
            // six files deleted at once, as by a git checkout, and reported one by one
            for (let i = 0; i < 6; i++) { t.local.files.delete(`/f${i}.png`); }
            t.ui.confirm = false;
            await sync.localChanged('/f0.png');
            assert.strictEqual(t.ui.asked.length, 1);
            assert.deepStrictEqual([...t.ui.asked[0]].sort(), ['/f0.png', '/f1.png', '/f2.png', '/f3.png', '/f4.png', '/f5.png']);
            assert.strictEqual(t.remote.files.size, 8, 'every file stays on Overleaf');
            await sync.localChanged('/f1.png');
            assert.strictEqual(t.ui.asked.length, 1, 'the user is not asked again about deletions they declined');
            assert.strictEqual(t.remote.files.size, 8);
        } finally {
            ReplicaSync.localDeleteDelayMs = saved;
        }
    });

    it('without uploads, holds local deletions for a push without asking, also when a tool asks', async () => {
        const saved = ReplicaSync.localDeleteDelayMs;
        ReplicaSync.localDeleteDelayMs = 0;
        try {
            const t = setup();
            for (let i = 0; i < 8; i++) { t.remote.files.set(`/f${i}.png`, new Uint8Array([i])); }
            const sync = new ReplicaSync(t.remote, t.local, t.store, t.ui, (p: string) => p.endsWith('.aux'), { uploads: false });
            await sync.syncAll();
            // six files deleted at once, as by a git checkout, and reported one by one
            for (let i = 0; i < 6; i++) { t.local.files.delete(`/f${i}.png`); }
            await sync.localChanged('/f0.png');
            const summary = await sync.flush(true, { by: 'tool' });
            assert.deepStrictEqual(t.ui.asked, [], 'the user is not asked');
            assert.deepStrictEqual(summary.deletionsToConfirm, [], 'the tool is not refused');
            assert.deepStrictEqual([...summary.held].sort(), ['/f0.png', '/f1.png', '/f2.png', '/f3.png', '/f4.png', '/f5.png']);
            assert.strictEqual(t.remote.files.size, 8, 'every file stays on Overleaf until a push');
        } finally {
            ReplicaSync.localDeleteDelayMs = saved;
        }
    });

    it('finishes the steps without deletions while a question about others waits for an answer', async () => {
        const t = setup();
        for (let i = 0; i < 6; i++) { t.remote.files.set(`/fig/f${i}.png`, new Uint8Array([i])); }
        t.remote.docs.set('/main.tex', text);
        const sync = t.start();
        await sync.syncAll();
        // a collaborator deletes the six figures; the question about them is never answered
        for (let i = 0; i < 6; i++) { t.remote.files.delete(`/fig/f${i}.png`); }
        t.ui.answer = new Promise(() => { /* the user is away */ });
        const asked = new Promise<void>(resolve => { t.ui.onAsk = resolve; });
        void sync.remoteChanged('/fig', true);
        await asked;
        // a local edit meanwhile is uploaded and reported
        t.local.set('/main.tex', text + 'line 6\n');
        await sync.localChanged('/main.tex');
        assert.strictEqual(t.remote.docs.get('/main.tex'), text + 'line 6\n');
        assert.deepStrictEqual(t.ui.live.at(-1)!.uploaded, ['/main.tex']);
        assert.strictEqual(t.ui.asked.length, 1);
    });

    it('asks before deleting the many local files of a folder deleted on Overleaf', async () => {
        const t = setup();
        for (let i = 0; i < 7; i++) { t.remote.files.set(`/fig/f${i}.png`, new Uint8Array([i])); }
        t.remote.docs.set('/main.tex', text);
        const sync = t.start();
        await sync.syncAll();
        for (let i = 0; i < 7; i++) { t.remote.files.delete(`/fig/f${i}.png`); }
        t.ui.confirm = false;
        await sync.remoteChanged('/fig', true);
        assert.strictEqual(t.ui.asked.length, 1);
        assert.strictEqual(t.ui.asked[0].length, 7);
        assert.strictEqual(t.local.files.size, 8, 'the local files stay');
    });

    it('deletes locally what was deleted on Overleaf, keeping local changes aside', async () => {
        const t = setup();
        t.remote.docs.set('/a.tex', 'a');
        t.remote.docs.set('/b.tex', 'b');
        await t.start().syncAll();
        t.remote.docs.delete('/a.tex');
        t.remote.docs.delete('/b.tex');
        t.local.set('/b.tex', 'b changed');
        const summary = await t.start().syncAll();
        assert.deepStrictEqual(summary.deletedLocal, ['/a.tex']);
        assert.strictEqual(summary.keptAside[0].path, '/b.tex');
        assert.strictEqual(t.local.files.size, 0);
    });

    it('keeps the local file when its download fails, and retries on the next sync', async () => {
        const t = setup();
        t.remote.files.set('/a.png', png);
        await t.start().syncAll();
        t.remote.files.set('/a.png', png2);
        t.remote.failReads.set('/a.png', 1);
        let summary = await t.start().syncAll();
        assert.strictEqual(summary.failed.length, 1);
        assert.match(summary.failed[0].error, /EAI_AGAIN/);
        assert.deepStrictEqual(t.local.files.get('/a.png')!.content, png);
        summary = await t.start().syncAll();
        assert.deepStrictEqual(summary.downloaded, ['/a.png']);
        assert.deepStrictEqual(t.local.files.get('/a.png')!.content, png2);
    });

    it('does not write a download that does not match the hash Overleaf reports', async () => {
        const t = setup();
        t.remote.files.set('/a.png', png);
        t.remote.corruptReads.add('/a.png');
        const summary = await t.start().syncAll();
        assert.strictEqual(summary.failed.length, 1);
        assert.strictEqual(t.local.files.has('/a.png'), false);
    });

    it('downloads a file without a hash to compare it, and leaves an equal local copy alone', async () => {
        const t = setup();
        t.remote.files.set('/a.png', png);
        t.remote.noHash.add('/a.png');
        t.local.set('/a.png', png);
        const before = t.local.files.get('/a.png')!.mtime;
        const summary = await t.start().syncAll();
        assert.strictEqual(t.remote.count('readFile'), 1);
        assert.strictEqual(summary.unchanged, 1);
        assert.strictEqual(t.local.files.get('/a.png')!.mtime, before);
    });

    it('reports a live upload that fails, and the next full sync uploads it', async () => {
        const t = setup();
        t.remote.docs.set('/INDEXING.md', text);
        const sync = t.start();
        await sync.syncAll();

        // the connection is gone: the upload of a local change fails
        t.local.set('/INDEXING.md', text + 'line 6\n');
        t.remote.failWrites.set('/INDEXING.md', 1);
        await sync.localChanged('/INDEXING.md');
        assert.deepStrictEqual(t.ui.live.at(-1)!.failed.map(f => f.path), ['/INDEXING.md']);
        assert.match(t.ui.live.at(-1)!.failed[0].error, /timed out/);
        assert.strictEqual(t.remote.docs.get('/INDEXING.md'), text);
        await sync.stop();

        // reconnected: the new provider's sync starts with a full sync
        const summary = await t.start().syncAll();
        assert.deepStrictEqual(summary.uploaded, ['/INDEXING.md']);
        assert.strictEqual(t.remote.docs.get('/INDEXING.md'), text + 'line 6\n');
    });

    it('syncs live changes in both directions without echoing its own writes', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        const sync = t.start();
        await sync.syncAll();

        t.local.set('/main.tex', text + 'line 6\n');
        await Promise.all([sync.localChanged('/main.tex'), sync.localChanged('/main.tex'), sync.localChanged('/main.tex')]);
        assert.strictEqual(t.remote.count('writeDoc'), 1);
        assert.strictEqual(t.remote.docs.get('/main.tex'), text + 'line 6\n');

        // the remote echo of that upload changes nothing
        await sync.remoteChanged('/main.tex', false);
        assert.strictEqual(t.remote.count('writeDoc'), 1);

        // a remote change is downloaded, and the local echo of that write uploads nothing
        t.remote.docs.set('/main.tex', 'line 0\n' + text + 'line 6\n');
        await sync.remoteChanged('/main.tex', false);
        assert.strictEqual(t.local.text('/main.tex'), 'line 0\n' + text + 'line 6\n');
        await sync.localChanged('/main.tex');
        assert.strictEqual(t.remote.count('writeDoc'), 1);
    });

    it('flush uploads a file changed on disk that no event reported', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        const sync = t.start();
        await sync.syncAll();
        t.local.set('/main.tex', text + 'written by another program\n');
        await sync.flush(true);
        assert.strictEqual(t.remote.docs.get('/main.tex'), text + 'written by another program\n');
    });

    it('flush answers what its scan synced, and leaves out files written a moment ago', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        const sync = t.start();
        await sync.syncAll();
        t.local.set('/main.tex', text + 'written by another program\n');
        const written = t.local.clock;
        // a periodic scan right after the write: the file may still be half written
        const early = await sync.flush(true, {skipRecentMs: 2000, now: written + 1000});
        assert.deepStrictEqual(early.uploaded, []);
        assert.strictEqual(t.remote.docs.get('/main.tex'), text);
        const later = await sync.flush(true, {skipRecentMs: 2000, now: written + 5000});
        assert.deepStrictEqual(later.uploaded, ['/main.tex']);
        assert.strictEqual(t.remote.docs.get('/main.tex'), text + 'written by another program\n');
        // without a scan, flush only waits, and answers that it synced nothing
        assert.deepStrictEqual((await sync.flush(false)).uploaded, []);
    });

    it('knows which files it synced before', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        const sync = t.start();
        await sync.syncAll();
        assert.strictEqual(await sync.knows('/main.tex'), true);
        assert.strictEqual(await sync.knows('/new.tex'), false);
    });

    it('never syncs ignored files or the .overleaf folder', async () => {
        const t = setup();
        t.remote.docs.set('/main.tex', text);
        await t.start().syncAll();
        t.local.set('/main.aux', 'aux');
        t.local.set('/.overleaf/settings.json', '{}');
        const sync = t.start();
        await sync.syncAll();
        await sync.localChanged('/main.aux');
        await sync.localChanged('/.overleaf/settings.json');
        assert.strictEqual(t.remote.count('upload'), 0);
    });

    it('deletes the local files of a folder deleted on Overleaf', async () => {
        const t = setup();
        t.remote.files.set('/fig/a.png', png);
        t.remote.files.set('/fig/b.png', png2);
        t.remote.docs.set('/main.tex', text);
        const sync = t.start();
        await sync.syncAll();
        t.remote.files.delete('/fig/a.png');
        t.remote.files.delete('/fig/b.png');
        await sync.remoteChanged('/fig', true);
        assert.deepStrictEqual([...t.local.files.keys()], ['/main.tex']);
    });

    it('keeps working on the files that did not fail', async () => {
        const t = setup();
        t.remote.files.set('/a.png', png);
        t.remote.files.set('/b.png', png2);
        t.remote.failReads.set('/a.png', 5);
        const summary = await t.start().syncAll();
        assert.deepStrictEqual(summary.downloaded, ['/b.png']);
        assert.deepStrictEqual(summary.failed.map(f => f.path), ['/a.png']);
    });
});

