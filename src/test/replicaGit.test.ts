/* eslint-disable @typescript-eslint/naming-convention -- environment variable names and file paths as keys */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { HistoryUpdate } from '../gitbridge/history';
import { DEFAULT_IGNORE_PATTERNS } from '../scm/ignorePatterns';
import { moveFile } from '../scm/localFolderFs';
import { gitignoreLine, gitMergeText, GitReplicaStore, NOTES_REF, OVERLEAF_REF, trailerValue } from '../scm/replicaGit';
import {
    gitBlobHash, LocalStat, RemoteEntry, ReplicaLocal, ReplicaRemote, ReplicaSync, ReplicaUI, SyncSummary,
} from '../scm/replicaSync';
import { opsFor, TextOp } from '../utils/docUpdate';

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A comment on a document: where the commented text starts, and that text. */
interface Comment { p: number; text: string; }

/**
 * Move the comments of a document by the ops of an edit, as Overleaf moves a comment when text
 * is inserted or deleted before it. An op at or inside a comment is not modelled here: it
 * throws, so that the edit fails and the test says so.
 */
function moveComments(comments: Comment[], ops: TextOp[]) {
    for (const op of ops) {
        for (const c of comments) {
            const end = c.p + c.text.length;
            if (op.i !== undefined) {
                if (op.p < c.p) { c.p += op.i.length; } else if (op.p <= end) { throw new Error(`the edit inserts ${JSON.stringify(op.i)} at the comment on ${JSON.stringify(c.text)}`); }
            } else if (op.p + op.d!.length <= c.p) {
                c.p -= op.d!.length;
            } else if (op.p < end) {
                throw new Error(`the edit deletes ${JSON.stringify(op.d)} across the comment on ${JSON.stringify(c.text)}`);
            }
        }
    }
}

/**
 * Overleaf, in memory: docs hold text, files hold bytes and report their hash; it can rename.
 * Each document and file has an id: a rename keeps it, and an upload makes a new one, as
 * Overleaf gives a new id to a new document and to a binary file it replaces. A document's
 * comments belong to its id, and an edit (writeDoc) moves them by the ops the extension sends
 * for it (opsFor); a removal drops them.
 */
class Remote implements ReplicaRemote {
    disconnected() { return undefined; }
    docs = new Map<string, string>();
    files = new Map<string, Uint8Array>();
    calls: string[] = [];
    failWrites = new Map<string, number>();
    ids = new Map<string, number>();
    comments = new Map<number, Comment[]>();
    /** the folders removed because they were empty */
    removedFolders = new Set<string>();
    private lastId = 0;

    /** The id of the document or file at `p`, given when first asked for. */
    idOf(p: string): number {
        if (!this.ids.has(p)) { this.ids.set(p, ++this.lastId); }
        return this.ids.get(p)!;
    }
    /** A comment on the first place where the document at `p` has `text`. */
    comment(p: string, text: string) {
        const at = this.docs.get(p)!.indexOf(text);
        assert.ok(at >= 0, `${p} has no ${JSON.stringify(text)} to comment on`);
        const id = this.idOf(p);
        this.comments.set(id, [...this.comments.get(id) ?? [], { p: at, text }]);
    }
    /** The text that each comment of the document at `p` covers now. */
    commentedText(p: string): string[] {
        const text = this.docs.get(p) ?? '';
        return (this.comments.get(this.ids.get(p)!) ?? []).map(c => text.slice(c.p, c.p + c.text.length));
    }
    private dropId(p: string) {
        const id = this.ids.get(p);
        if (id !== undefined) { this.comments.delete(id); this.ids.delete(p); }
    }

    async list() {
        const all = new Map<string, RemoteEntry>();
        for (const p of this.docs.keys()) { all.set(p, { kind: 'doc' }); }
        for (const p of this.files.keys()) { all.set(p, (await this.entry(p))!); }
        return all;
    }
    async entry(p: string): Promise<RemoteEntry | undefined> {
        if (this.docs.has(p)) { return { kind: 'doc' }; }
        const content = this.files.get(p);
        return content === undefined ? undefined : { kind: 'file', hash: gitBlobHash(content) };
    }
    async isFolder(p: string) { return [...this.docs.keys(), ...this.files.keys()].some(q => q.startsWith(`${p}/`)); }
    /** while set, a read of a document waits for it; `onRead` hears of each read */
    readGate?: Promise<void>;
    onRead?: (p: string) => void;
    async readDoc(p: string) {
        this.onRead?.(p);
        await this.readGate;
        const text = this.docs.get(p);
        if (text === undefined) { throw new Error(`no doc ${p}`); }
        return text;
    }
    async readFile(p: string) { const content = this.files.get(p); if (content === undefined) { throw new Error(`no file ${p}`); } return content; }
    async writeDoc(p: string, text: string) {
        this.calls.push(`writeDoc ${p}`);
        const failures = this.failWrites.get(p) ?? 0;
        if (failures > 0) { this.failWrites.set(p, failures - 1); throw new Error('applyOtUpdate timed out'); }
        moveComments(this.comments.get(this.idOf(p)) ?? [], opsFor(this.docs.get(p) ?? '', text));
        this.docs.set(p, text);
    }
    async upload(p: string, content: Uint8Array): Promise<RemoteEntry> {
        this.calls.push(`upload ${p}`);
        const failures = this.failWrites.get(p) ?? 0;
        if (failures > 0) { this.failWrites.set(p, failures - 1); throw new Error('the upload failed'); }
        this.dropId(p);
        this.idOf(p);
        if (/\.(tex|bib|txt|md|t|py|sh)$/.test(p) && !this.files.has(p)) { this.docs.set(p, dec(content)); return { kind: 'doc' }; }
        this.files.set(p, content);
        return { kind: 'file', hash: gitBlobHash(content) };
    }
    /** while set, Overleaf refuses every rename */
    refuseRenames = false;
    async rename(from: string, to: string) {
        this.calls.push(`rename ${from} ${to}`);
        if (this.refuseRenames) { throw new Error(`Overleaf refused to rename ${from}`); }
        const id = this.idOf(from);
        if (this.docs.has(from)) { this.docs.set(to, this.docs.get(from)!); this.docs.delete(from); }
        else if (this.files.has(from)) { this.files.set(to, this.files.get(from)!); this.files.delete(from); }
        else { throw new Error(`no ${from}`); }
        this.ids.delete(from);
        this.ids.set(to, id);
    }
    async remove(p: string) { this.calls.push(`remove ${p}`); this.docs.delete(p); this.files.delete(p); this.dropId(p); }
    async removeFolderIfEmpty(folder: string) {
        if (folder !== '/' && ![...this.docs.keys(), ...this.files.keys()].some(q => q.startsWith(`${folder}/`))) { this.removedFolders.add(folder); }
    }
    async settled() {}
    count(prefix: string) { return this.calls.filter(c => c.startsWith(prefix)).length; }
}

/** The replica folder on disk, the repository's work tree. */
class Folder implements ReplicaLocal {
    constructor(readonly root: string, readonly ignored: (p: string) => boolean) {}
    async verify() {}
    private abs(p: string) { return path.join(this.root, p); }
    async list() {
        const files = new Map<string, LocalStat>();
        const walk = async (dir: string) => {
            for (const item of await fsp.readdir(this.abs(dir), { withFileTypes: true })) {
                const p = `${dir}${item.name}`;
                if (p === '/.overleaf' || p === '/.git' || this.ignored(p)) { continue; }
                if (item.isDirectory()) { await walk(`${p}/`); } else if (item.isFile()) { const s = await fsp.stat(this.abs(p)); files.set(p, { size: s.size, mtime: s.mtimeMs }); }
            }
        };
        await walk('/');
        return files;
    }
    async stat(p: string): Promise<LocalStat | 'folder' | undefined> {
        try { const s = await fsp.stat(this.abs(p)); return s.isDirectory() ? 'folder' : { size: s.size, mtime: s.mtimeMs }; } catch { return undefined; }
    }
    async read(p: string) { try { return new Uint8Array(await fsp.readFile(this.abs(p))); } catch { return undefined; } }
    async write(p: string, content: Uint8Array) {
        await fsp.mkdir(path.dirname(this.abs(p)), { recursive: true });
        await fsp.writeFile(this.abs(p), content);
        const s = await fsp.stat(this.abs(p));
        return { size: s.size, mtime: s.mtimeMs };
    }
    /** while set, a move waits for it; `onMove` hears of each move */
    moveGate?: Promise<void>;
    onMove?: () => void;
    async move(from: string, to: string) {
        this.onMove?.();
        await this.moveGate;
        await moveFile(this.abs(from), this.abs(to));
    }
    async remove(p: string) { await fsp.rm(this.abs(p), { force: true }); }
    async removeFolderIfEmpty(p: string) { try { await fsp.rmdir(this.abs(p)); } catch { /* not empty */ } }
}

class UI implements ReplicaUI {
    logs: string[] = [];
    blocked: string[] = [];
    log(message: string) { this.logs.push(message); }
    progress() {}
    /** the questions about deletions, each with its paths; `onQuestion` hears of each */
    questions: string[][] = [];
    onQuestion?: () => void;
    async confirmDeletions(_where: 'local' | 'remote', paths: string[]) { this.questions.push(paths); this.onQuestion?.(); return true; }
    conflictBlocked(p: string) { this.blocked.push(p); }
    liveResult(_summary: SyncSummary) {}
}

const ALICE = { id: 'a', name: 'Alice Author', email: 'alice@example.com' };
const BOB = { id: 'b', name: 'Bob Builder', email: 'bob@example.com' };
const ME = { id: 'm', name: 'Juraj', email: 'me@example.com' };

/** git in the replica, for the checks. */
function git(dir: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (result.status !== 0) { throw new Error(`git ${args.join(' ')}: ${result.stderr}`); }
    return result.stdout.trim();
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const text = 'line 1\nline 2\nline 3\nline 4\nline 5\n';

let scratch: string;
let worlds = 0;

/** A replica of an in-memory project in a new folder, with the git store and a history. */
async function world(options: { configureUser?: boolean } = {}) {
    const folder = path.join(scratch, `replica-${++worlds}`);
    await fsp.mkdir(folder, { recursive: true });
    const remote = new Remote();
    const ui = new UI();
    const ignored = (p: string) => p === '/.overleaf' || p.startsWith('/.overleaf/') || DEFAULT_IGNORE_PATTERNS.some(g => minimatch(p, g, { dot: true }));
    const updates: HistoryUpdate[] = [];
    const store = new GitReplicaStore({
        folder, projectId: 'p'.repeat(24), serverName: 'www.overleaf.com', ignorePatterns: DEFAULT_IGNORE_PATTERNS, isIgnored: ignored,
        history: async (after) => updates.filter(u => after === undefined || u.toV > after).sort((a, b) => b.toV - a.toV),
        log: message => ui.log(message),
    });
    await store.open();
    if (options.configureUser !== false) {
        git(folder, 'config', 'user.name', 'Local User');
        git(folder, 'config', 'user.email', 'local@example.com');
    }
    const local = new Folder(folder, ignored);
    const start = () => new ReplicaSync(remote, local, store, ui, ignored);
    /** a new history update by `user`, ending at `endTs` */
    const update = (user: typeof ALICE, endTs = Date.now(), ...others: typeof ALICE[]) => {
        const v = (updates[updates.length - 1]?.toV ?? 0) + 1;
        updates.push({ fromV: v - 1, toV: v, endTs, users: [user, ...others] });
        return v;
    };
    const write = (p: string, content: string | Uint8Array) => {
        fs.mkdirSync(path.dirname(path.join(folder, p)), { recursive: true });
        fs.writeFileSync(path.join(folder, p), content);
    };
    const read = (p: string) => fs.readFileSync(path.join(folder, p), 'utf8');
    const g = (...args: string[]) => git(folder, ...args);
    return { folder, remote, ui, store, local, start, update, updates, write, read, g };
}

/** A commit with `files` changed on top of `parent`, made without the work tree, as in another clone. */
function commitOnTop(dir: string, parent: string, files: Record<string, string | null>, message: string): string {
    const index = path.join(scratch, `index-${Date.now()}-${Math.random()}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const run = (args: string[], input?: string) => {
        const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, input });
        if (result.status !== 0) { throw new Error(`git ${args.join(' ')}: ${result.stderr}`); }
        return result.stdout.trim();
    };
    run(['read-tree', parent]);
    for (const [p, content] of Object.entries(files)) {
        if (content === null) { run(['update-index', '--force-remove', p]); continue; }
        const oid = run(['hash-object', '-w', '--stdin'], content);
        run(['update-index', '--add', '--cacheinfo', `100644,${oid},${p}`]);
    }
    const tree = run(['write-tree']);
    fs.rmSync(index, { force: true });
    return run(['commit-tree', tree, '-p', parent, '-m', message]);
}

describe('local replica: git as the merge backend', function () {
    this.timeout(20000);

    before(async () => {
        scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'replica-git-test-'));
        ReplicaSync.remoteDeleteDelayMs = 0;
        ReplicaSync.localDeleteDelayMs = 0;
        ReplicaSync.saveDelayMs = 0;
        // records only when a test asks for one
        ReplicaSync.recordQuietMs = 60_000;
    });
    after(async () => { await fsp.rm(scratch, { recursive: true, force: true }); });

    describe('git merge-file', () => {
        it('merges changes in different places and marks overlapping ones as Local and Remote', async () => {
            const clean = await gitMergeText(text, text.replace('line 1', 'one'), text.replace('line 5', 'five'));
            assert.deepStrictEqual(clean, { content: text.replace('line 1', 'one').replace('line 5', 'five'), hasConflict: false });
            const both = await gitMergeText(text, text.replace('line 3', 'local'), text.replace('line 3', 'remote'));
            assert.strictEqual(both.hasConflict, true);
            assert.match(both.content, /<<<<<<< Local\nlocal\n=======\nremote\n>>>>>>> Remote\n/);
        });

        it('marks conflicts in git\'s default style whatever merge.conflictStyle says', async () => {
            const config = path.join(scratch, 'gitconfig-diff3');
            fs.writeFileSync(config, '[merge]\n\tconflictStyle = diff3\n');
            const saved = process.env.GIT_CONFIG_GLOBAL;
            process.env.GIT_CONFIG_GLOBAL = config;
            try {
                const both = await gitMergeText(text, text.replace('line 3', 'local'), text.replace('line 3', 'remote'));
                assert.doesNotMatch(both.content, /\|\|\|\|\|\|\|/);
            } finally {
                if (saved === undefined) { delete process.env.GIT_CONFIG_GLOBAL; } else { process.env.GIT_CONFIG_GLOBAL = saved; }
            }
        });
    });

    it('saves the states of two stores of one folder at the same time, as when two replicas of the folder start together', async () => {
        const t = await world();
        const second = new GitReplicaStore({
            folder: t.folder, projectId: 'p'.repeat(24), serverName: 'www.overleaf.com', ignorePatterns: DEFAULT_IGNORE_PATTERNS,
            isIgnored: () => false, log: () => {},
        });
        await second.open();
        const state = (path: string) => ({ version: 1 as const, entries: {}, untracked: [path] });
        // the first save renames its file over the state file only once the second has written its own
        const promises = require('fs/promises');
        const rename = promises.rename;
        let secondRenames!: () => void;
        const secondRenaming = new Promise<void>(resolve => { secondRenames = resolve; });
        let calls = 0;
        promises.rename = async (from: string, to: string) => {
            calls += 1;
            if (calls === 1) { await secondRenaming; } else { secondRenames(); }
            return rename(from, to);
        };
        try {
            const saves = await Promise.allSettled([t.store.save(state('/first.tex')), second.save(state('/second.tex'))]);
            assert.deepStrictEqual(saves.map(save => save.status === 'rejected' ? String(save.reason) : 'saved'), ['saved', 'saved']);
        } finally {
            promises.rename = rename;
        }
        assert.deepStrictEqual(fs.readdirSync(path.join(t.folder, '.git', 'overleaf', 'tmp')), [], 'the temporary files are gone');
    });

    it('reports git\'s index lock of another program and its time, but not the lock of its own index write, and notices when the lock goes', async () => {
        const t = await world();
        const lock = path.join(t.folder, '.git', 'index.lock');
        assert.strictEqual(await t.store.foreignIndexLock(), undefined, 'before the lock');
        // another program's git takes the lock
        fs.writeFileSync(lock, '');
        assert.strictEqual(await t.store.foreignIndexLock(), lock);
        assert.strictEqual(await t.store.indexLockTime(lock), fs.statSync(lock).mtimeMs, 'the time git last wrote the lock');
        assert.strictEqual(await t.store.git.ownIndexWrite(() => t.store.foreignIndexLock()), undefined, 'during the replica\'s own index write the lock is its own');
        const { released, dispose } = t.store.indexLockReleased(lock);
        try {
            fs.rmSync(lock);
            await released;
        } finally {
            dispose();
        }
        assert.strictEqual(await t.store.foreignIndexLock(), undefined, 'after the lock');
        assert.strictEqual(await t.store.indexLockTime(lock), undefined, 'the time of a lock that is gone');
    });

    it('reads both sides again when another program held git\'s index lock at the sync\'s write, and keeps the local change written during the lock', async () => {
        const t = await world();
        const v1 = Array.from({ length: 10 }, (_, i) => `Line ${i + 1} of a.tex.\n`).join('');
        const changedOnOverleaf = (s: string) => s.replace('Line 9 of a.tex.', 'Line 9 of a.tex, changed on Overleaf.');
        const writtenByGit = (s: string) => s.replace('Line 1 of a.tex.', 'Line 1 of a.tex, written by git during its lock.');
        t.remote.docs.set('/a.tex', v1);
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        t.remote.docs.set('/a.tex', changedOnOverleaf(v1));
        t.update(ALICE);
        // While the sync reads Overleaf's text, another program's git takes the index lock and
        // writes a local change into a.tex, as `git stash pop` does.
        const lock = path.join(t.folder, '.git', 'index.lock');
        const readDoc = t.remote.readDoc;
        let gitWrote = false;
        t.remote.readDoc = async (p: string) => {
            if (p === '/a.tex' && !gitWrote) {
                gitWrote = true;
                fs.writeFileSync(lock, '');
                t.write('/a.tex', writtenByGit(v1));
            }
            return readDoc.call(t.remote, p);
        };
        // git's command ends, and removes the lock, once the sync waits for it
        const indexLockReleased = t.store.indexLockReleased;
        let waited = false;
        t.store.indexLockReleased = (file: string) => {
            const watch = indexLockReleased.call(t.store, file);
            waited = true;
            fs.rmSync(lock);
            return watch;
        };
        try {
            await sync.remoteChanged('/a.tex', false);
        } finally {
            t.remote.readDoc = readDoc;
            t.store.indexLockReleased = indexLockReleased;
            fs.rmSync(lock, { force: true });
        }
        assert.deepStrictEqual([gitWrote, waited], [true, true], 'git wrote a.tex during its lock, and the sync waited for the lock');
        const both = changedOnOverleaf(writtenByGit(v1));
        assert.strictEqual(t.read('/a.tex'), both, 'the local file: git\'s change, merged with Overleaf\'s');
        assert.strictEqual(t.remote.docs.get('/a.tex'), both, 'Overleaf: the merge');
        assert.ok(!fs.existsSync(path.join(t.folder, '.overleaf/conflicts')), 'nothing is kept aside');
        await sync.stop();
    });

    it('turns the replica\'s ignore patterns into gitignore lines', () => {
        assert.strictEqual(gitignoreLine('**/*.aux'), '*.aux');
        assert.strictEqual(gitignoreLine('**/.*'), '.*');
        assert.strictEqual(gitignoreLine('**/.*/**'), '.*/');
        assert.strictEqual(gitignoreLine('**/figures/*.pdf'), '/figures/*.pdf');
        assert.strictEqual(gitignoreLine('/build/**'), '/build/');
    });

    it('makes the first sync the first commit of Overleaf\'s state and of the branch, by the history\'s user', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.remote.files.set('/slike/logo.png', png);
        const v = t.update(ALICE, Date.UTC(2026, 9, 31, 10, 0, 0), BOB);
        t.write('/main.aux', 'build product');
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();

        const head = t.g('rev-parse', 'HEAD');
        assert.strictEqual(t.g('rev-parse', OVERLEAF_REF), head);
        assert.strictEqual(t.g('symbolic-ref', 'HEAD'), 'refs/heads/main');
        assert.deepStrictEqual(t.g('ls-tree', '-r', '--name-only', head).split('\n'), ['main.tex', 'slike/logo.png']);
        assert.strictEqual(t.g('log', '-1', '--format=%an <%ae> %at', head), `Alice Author <alice@example.com> ${Date.UTC(2026, 9, 31, 10, 0, 0) / 1000}`);
        assert.strictEqual(t.g('log', '-1', '--format=%cn <%ce>', head), 'Local User <local@example.com>');
        const message = t.g('log', '-1', '--format=%B', head);
        assert.strictEqual(trailerValue(message, 'Overleaf-Version'), String(v));
        assert.strictEqual(trailerValue(message, 'Overleaf-Project'), 'p'.repeat(24));
        assert.match(message, new RegExp(`^Overleaf's state at version ${v}\n\nThe project's files when the replica first synced: 2 files.\n`));
        assert.match(message, /^Co-authored-by: Bob Builder <bob@example.com>$/m);
        // the index holds the commit, and git status shows neither the build product nor .overleaf
        assert.strictEqual(t.g('status', '--porcelain'), '');
        await sync.stop();
    });

    it('commits a change made on Overleaf on top of the last state, and the branch fast-forwards', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');

        t.remote.docs.set('/main.tex', text.replace('line 2', 'line two'));
        const v = t.update(BOB, Date.UTC(2026, 9, 31, 11, 0, 0));
        await sync.remoteChanged('/main.tex', false);
        await sync.recordNow();

        const second = t.g('rev-parse', OVERLEAF_REF);
        assert.notStrictEqual(second, first);
        assert.strictEqual(t.g('rev-parse', `${second}^`), first);
        assert.strictEqual(t.g('rev-parse', 'HEAD'), second);
        assert.strictEqual(t.g('log', '-1', '--format=%an %s', second), `Bob Builder Overleaf version ${v}`);
        assert.strictEqual(t.read('/main.tex'), text.replace('line 2', 'line two'));
        assert.strictEqual(t.g('status', '--porcelain'), '');
        await sync.stop();
    });

    it('commits an upload from the folder as the repository\'s user', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');

        t.write('/main.tex', text + 'line 6\n');
        await sync.localChanged('/main.tex');
        t.update(ME);
        await sync.recordNow();

        const upload = t.g('rev-parse', 'HEAD');
        assert.strictEqual(t.g('rev-parse', OVERLEAF_REF), upload);
        assert.strictEqual(t.g('rev-parse', `${upload}^`), first);
        assert.strictEqual(t.g('log', '-1', '--format=%an <%ae>|%s', upload), 'Local User <local@example.com>|Uploaded from the local folder');
        assert.strictEqual(t.remote.docs.get('/main.tex'), text + 'line 6\n');
        assert.strictEqual(t.g('status', '--porcelain'), '');
        await sync.stop();
    });

    it('pushes a commit: Overleaf\'s ref moves to the commit itself, with the version in a note', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.remote.docs.set('/other.tex', 'other\n');
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');

        const commit = commitOnTop(t.folder, first, { 'main.tex': text.replace('line 4', 'line four'), 'other.tex': 'other, changed\n', 'tests/01.t': 'ok 1\n' }, 'A book commit');
        t.g('merge', '--ff-only', '--quiet', commit);
        await sync.flush(true);
        const v = t.update(ME);
        await sync.recordNow();

        assert.strictEqual(t.g('rev-parse', OVERLEAF_REF), commit);
        assert.strictEqual(t.g('rev-parse', 'HEAD'), commit);
        assert.strictEqual(trailerValue(t.g('notes', `--ref=${NOTES_REF}`, 'show', commit), 'Overleaf-Version'), String(v));
        assert.strictEqual(t.remote.docs.get('/main.tex'), text.replace('line 4', 'line four'));
        assert.strictEqual(t.remote.docs.get('/tests/01.t'), 'ok 1\n');
        assert.strictEqual(t.g('status', '--porcelain'), '');
        await sync.stop();
    });

    it('records nothing while a push is still uploading, and the pushed commit once it is done', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.remote.docs.set('/other.tex', 'other\n');
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');

        const commit = commitOnTop(t.folder, first, { 'main.tex': 'new main\n', 'other.tex': 'new other\n' }, 'Two files');
        t.g('merge', '--ff-only', '--quiet', commit);
        t.remote.failWrites.set('/other.tex', 1);
        await sync.flush(true);
        assert.strictEqual((await sync.recordNow())?.waiting, true);
        assert.strictEqual(t.g('rev-parse', OVERLEAF_REF), first);

        await sync.flush(true);
        await sync.recordNow();
        assert.strictEqual(t.g('rev-parse', OVERLEAF_REF), commit);
        await sync.stop();
    });

    it('commits an edit made on Overleaf during a push on top of the pushed commit', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.remote.docs.set('/other.tex', 'other\n');
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');

        const commit = commitOnTop(t.folder, first, { 'main.tex': text.replace('line 1', 'line one') }, 'One file');
        t.g('merge', '--ff-only', '--quiet', commit);
        await sync.flush(true);
        t.remote.docs.set('/other.tex', 'other, edited on Overleaf\n');
        t.update(BOB);
        await sync.remoteChanged('/other.tex', false);
        await sync.recordNow();

        const tip = t.g('rev-parse', OVERLEAF_REF);
        assert.strictEqual(t.g('rev-parse', `${tip}^`), commit);
        assert.strictEqual(t.g('log', '-1', '--format=%an', tip), 'Bob Builder');
        assert.strictEqual(t.g('rev-parse', 'HEAD'), tip);
        assert.strictEqual(t.g('status', '--porcelain'), '');
        await sync.stop();
    });

    it('merges Overleaf\'s new state into a branch with a commit of its own that is not on Overleaf', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.remote.docs.set('/other.tex', 'other\n');
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');

        // a local commit; the scan that would upload it has not run yet
        const mine = commitOnTop(t.folder, first, { 'main.tex': text.replace('line 1', 'mine') }, 'Mine');
        t.g('merge', '--ff-only', '--quiet', mine);
        t.remote.docs.set('/other.tex', 'theirs\n');
        t.update(BOB);
        await sync.remoteChanged('/other.tex', false);
        await sync.recordNow();

        const overleaf = t.g('rev-parse', OVERLEAF_REF);
        assert.strictEqual(t.g('rev-parse', `${overleaf}^`), first);
        const head = t.g('rev-parse', 'HEAD');
        assert.deepStrictEqual(t.g('log', '-1', '--format=%P', head).split(' '), [mine, overleaf]);
        assert.strictEqual(t.g('show', `${head}:other.tex`), 'theirs');
        assert.strictEqual(t.g('show', `${head}:main.tex`), text.replace('line 1', 'mine').trimEnd());
        assert.strictEqual(t.g('status', '--porcelain'), '');

        // the upload of the commit's change finishes the push: Overleaf holds the merge
        await sync.flush(true);
        await sync.recordNow();
        assert.strictEqual(t.g('rev-parse', OVERLEAF_REF), head);
        await sync.stop();
    });

    it('leaves overlapping changes as a git conflict, uploads nothing of it, and uploads the resolution once it is added', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();

        t.write('/main.tex', text.replace('line 3', 'line three, local'));
        t.remote.docs.set('/main.tex', text.replace('line 3', 'line three, remote'));
        t.update(BOB);
        const summary = await sync.flush(true);
        assert.deepStrictEqual(summary.conflicts, ['/main.tex']);
        assert.match(t.read('/main.tex'), /<<<<<<< Local\nline three, local\n=======\nline three, remote\n>>>>>>> Remote\n/);
        const stages = t.g('ls-files', '-u', 'main.tex').split('\n').map(line => line.split(/\s+/)[2]);
        assert.deepStrictEqual(stages, ['1', '2', '3']);
        assert.strictEqual(t.g('show', ':3:main.tex'), text.replace('line 3', 'line three, remote').trimEnd());
        assert.strictEqual(t.g('show', ':2:main.tex'), text.replace('line 3', 'line three, local').trimEnd());
        assert.strictEqual(t.remote.count('writeDoc'), 0);

        // Overleaf's state is recorded; the conflict stays in the index
        await sync.recordNow();
        assert.strictEqual(t.g('show', `${OVERLEAF_REF}:main.tex`), text.replace('line 3', 'line three, remote').trimEnd());
        assert.match(t.g('status', '--porcelain'), /^UU main.tex$/m);

        // without markers but not added: still not uploaded
        const resolved = text.replace('line 3', 'line three, both');
        t.write('/main.tex', resolved);
        await sync.localChanged('/main.tex');
        assert.strictEqual(t.remote.count('writeDoc'), 0);
        assert.deepStrictEqual(t.ui.blocked, ['/main.tex']);

        t.g('add', 'main.tex');
        await sync.gitChanged();
        assert.strictEqual(t.remote.docs.get('/main.tex'), resolved);
        await sync.recordNow();
        assert.strictEqual(t.g('show', `${OVERLEAF_REF}:main.tex`), resolved.trimEnd());
        assert.strictEqual(t.g('status', '--porcelain'), '');
        await sync.stop();
    });

    it('does not upload a file that a git merge of the user left unmerged', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');
        const ours = commitOnTop(t.folder, first, { 'main.tex': text.replace('line 2', 'ours') }, 'Ours');
        const theirs = commitOnTop(t.folder, first, { 'main.tex': text.replace('line 2', 'theirs') }, 'Theirs');
        t.g('merge', '--ff-only', '--quiet', ours);
        await sync.flush(true);
        assert.strictEqual(t.remote.docs.get('/main.tex'), text.replace('line 2', 'ours'));
        spawnSync('git', ['-C', t.folder, 'merge', '--no-edit', theirs]);
        assert.match(t.read('/main.tex'), /<<<<<<< HEAD/);

        // the sync waits while the merge is under way
        const during = await sync.flush(true);
        assert.strictEqual(t.remote.docs.get('/main.tex'), text.replace('line 2', 'ours'));
        assert.match(String(during.waitingFor), /in the middle of a merge/);

        // nor does a change on Overleaf go into it meanwhile: the merge's stages stay the user's
        const conflicted = t.read('/main.tex');
        t.remote.docs.set('/main.tex', text.replace('line 2', 'ours').replace('line 5', 'five'));
        await sync.remoteChanged('/main.tex', false);
        assert.strictEqual(t.read('/main.tex'), conflicted);
        assert.strictEqual(t.g('show', ':3:main.tex'), text.replace('line 2', 'theirs').trimEnd());
        await sync.stop();
    });

    it('renames a file on Overleaf when it was renamed locally, and git sees the rename', async () => {
        const t = await world();
        t.remote.docs.set('/chapters/one.tex', text);
        t.remote.files.set('/slike/a.png', png);
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');

        t.g('mv', 'chapters/one.tex', 'chapters/first.tex');
        fs.mkdirSync(path.join(t.folder, 'figures'));
        t.g('mv', 'slike/a.png', 'figures/a.png');
        t.g('commit', '--quiet', '-m', 'Rename');
        await sync.flush(true);
        assert.deepStrictEqual(t.remote.calls.filter(c => !c.startsWith('writeDoc')).sort(), ['rename /chapters/one.tex /chapters/first.tex', 'rename /slike/a.png /figures/a.png']);
        assert.strictEqual(t.remote.docs.get('/chapters/first.tex'), text);
        t.update(ME);
        await sync.recordNow();
        assert.strictEqual(t.g('rev-parse', OVERLEAF_REF), t.g('rev-parse', 'HEAD'));
        assert.match(t.g('diff', '--name-status', '-M', first, OVERLEAF_REF), /^R100\tchapters\/one.tex\tchapters\/first.tex$/m);
        await sync.stop();
    });

    it('records a rename made on Overleaf as git sees it', async () => {
        const t = await world();
        t.remote.docs.set('/one.tex', text);
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');

        await t.remote.rename('/one.tex', '/two.tex');
        t.update(ALICE);
        await Promise.all([sync.remoteChanged('/one.tex', true), sync.remoteChanged('/two.tex', false)]);
        await sync.recordNow();
        assert.match(t.g('diff', '--name-status', '-M', first, 'HEAD'), /^R100\tone.tex\ttwo.tex$/m);
        assert.ok(!fs.existsSync(path.join(t.folder, 'one.tex')));
        assert.strictEqual(t.g('status', '--porcelain'), '');
        await sync.stop();
    });

    describe('renames and moves, as git pairs them', () => {
        const lines = (line: (i: number) => string) => Array.from({ length: 10 }, (_, i) => `${line(i + 1)}\n`).join('');
        const chapter = lines(i => `Line ${i} of the chapter, with a few words in it.`);
        // git: 79% similar, a rename
        const edited = lines(i => i >= 9 ? `Line ${i} of the chapter, edited after the rename.` : `Line ${i} of the chapter, with a few words in it.`);
        // git: below 50% similar, not a rename
        const rewritten = lines(i => i <= 2 ? `Line ${i} of the chapter, with a few words in it.` : `Something else entirely, number ${i}.`);
        const commented = 'Line 2 of the chapter';

        /** The renames git shows for the folder's files against `rev`: git add -A, then git diff --cached -M, in an index of the test's own. */
        function gitShowsRenames(folder: string, rev: string): { from: string, to: string }[] {
            const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, `index-${Date.now()}-${Math.random()}`) };
            const run = (...args: string[]) => {
                const result = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', env });
                if (result.status !== 0) { throw new Error(`git ${args.join(' ')}: ${result.stderr}`); }
                return result.stdout;
            };
            run('read-tree', rev);
            run('add', '-A');
            return run('diff', '--cached', '-M', '--name-status', rev).split('\n').filter(line => line.startsWith('R'))
                .map(line => line.split('\t')).map(([, from, to]) => ({ from: `/${from}`, to: `/${to}` }));
        }
        const byFrom = (pairs: { from: string, to: string }[]) => [...pairs].sort((a, b) => a.from.localeCompare(b.from));

        /** A replica of a project with `docs`, synced and recorded; the calls made of Overleaf so far are cleared. */
        async function synced(docs: Record<string, string | Uint8Array>) {
            const t = await world();
            for (const [p, content] of Object.entries(docs)) {
                if (typeof content === 'string') { t.remote.docs.set(p, content); } else { t.remote.files.set(p, content); }
            }
            t.update(ME);
            const sync = t.start();
            await sync.syncAll();
            await sync.recordNow();
            t.remote.calls.length = 0;
            return { ...t, sync, first: t.g('rev-parse', 'HEAD') };
        }
        const move = (t: { folder: string }, from: string, to: string) => {
            fs.mkdirSync(path.dirname(path.join(t.folder, to)), { recursive: true });
            fs.renameSync(path.join(t.folder, from), path.join(t.folder, to));
        };

        it('renames a document with the same content, which keeps its id and comments', async () => {
            const t = await synced({ '/a.tex': chapter });
            const id = t.remote.idOf('/a.tex');
            t.remote.comment('/a.tex', commented);
            move(t, 'a.tex', 'b.tex');
            const summary = await t.sync.flush(true);
            assert.deepStrictEqual(t.remote.calls, ['rename /a.tex /b.tex'], 'what the sync asked of Overleaf');
            assert.deepStrictEqual(summary.renamed, [{ from: '/a.tex', to: '/b.tex' }], 'the summary');
            assert.strictEqual(t.remote.ids.get('/b.tex'), id, 'the document at the new path is the one that was at the old path');
            assert.deepStrictEqual(t.remote.commentedText('/b.tex'), [commented], 'the comment, after the rename');
            t.update(ME);
            await t.sync.recordNow();
            assert.match(t.g('diff', '--name-status', '-M', t.first, OVERLEAF_REF), /^R100\ta.tex\tb.tex$/m, 'git\'s view of the recorded state');
            await t.sync.stop();
        });

        it('renames a document renamed and edited, then sends the edit, as git pairs the paths', async () => {
            const t = await synced({ '/a.tex': chapter });
            const id = t.remote.idOf('/a.tex');
            t.remote.comment('/a.tex', commented);
            move(t, 'a.tex', 'b.tex');
            fs.writeFileSync(path.join(t.folder, 'b.tex'), edited);
            assert.deepStrictEqual(gitShowsRenames(t.folder, t.first), [{ from: '/a.tex', to: '/b.tex' }], 'git pairs the paths');
            const summary = await t.sync.flush(true);
            assert.deepStrictEqual(t.remote.calls, ['rename /a.tex /b.tex', 'writeDoc /b.tex'], 'what the sync asked of Overleaf: the rename, then the edit');
            assert.deepStrictEqual([summary.renamed, summary.uploaded, summary.failed], [[{ from: '/a.tex', to: '/b.tex' }], ['/b.tex'], []], 'the summary');
            assert.strictEqual(t.remote.docs.get('/b.tex'), edited, 'the text on Overleaf');
            assert.strictEqual(t.remote.ids.get('/b.tex'), id, 'the document at the new path is the one that was at the old path');
            assert.deepStrictEqual(t.remote.commentedText('/b.tex'), [commented], 'the comment on the text that the edit left alone');
            t.update(ME);
            await t.sync.recordNow();
            assert.match(t.g('diff', '--name-status', '-M', t.first, OVERLEAF_REF), /^R0[5-9]\d\ta.tex\tb.tex$/m, 'git\'s view of the recorded state');
            assert.match(t.g('log', '--follow', '--format=%H', OVERLEAF_REF, '--', 'b.tex'), new RegExp(`^${t.first}$`, 'm'), 'git log --follow reaches the commit before the rename');
            assert.strictEqual(t.g('status', '--porcelain'), '', 'git status after the record');
            await t.sync.stop();
        });

        it('uploads a rewritten document under a new name as a new document, as git does not pair the paths', async () => {
            const t = await synced({ '/a.tex': chapter });
            const id = t.remote.idOf('/a.tex');
            move(t, 'a.tex', 'b.tex');
            fs.writeFileSync(path.join(t.folder, 'b.tex'), rewritten);
            assert.deepStrictEqual(gitShowsRenames(t.folder, t.first), [], 'git does not pair the paths');
            const summary = await t.sync.flush(true);
            assert.deepStrictEqual([...t.remote.calls].sort(), ['remove /a.tex', 'upload /b.tex'], 'what the sync asked of Overleaf');
            assert.deepStrictEqual(summary.renamed, [], 'the summary');
            assert.notStrictEqual(t.remote.ids.get('/b.tex'), id, 'the document at the new path is a new one');
            t.update(ME);
            await t.sync.recordNow();
            assert.match(t.g('diff', '--name-status', '-M', t.first, OVERLEAF_REF), /^D\ta.tex\nA\tb.tex$/m, 'git\'s view of the recorded state');
            await t.sync.stop();
        });

        it('pairs two documents renamed and edited crosswise as git does, by content', async () => {
            const one = lines(i => `The first chapter, sentence ${i}.`), two = lines(i => `The second chapter, paragraph ${i}.`);
            const t = await synced({ '/one.tex': one, '/two.tex': two });
            const ids = { one: t.remote.idOf('/one.tex'), two: t.remote.idOf('/two.tex') };
            // the second chapter becomes first.tex and the first second.tex, each with an edit
            move(t, 'two.tex', 'first.tex');
            move(t, 'one.tex', 'second.tex');
            fs.writeFileSync(path.join(t.folder, 'first.tex'), two.replace('paragraph 2.', 'paragraph two.'));
            fs.writeFileSync(path.join(t.folder, 'second.tex'), one.replace('sentence 9.', 'sentence nine.'));
            const git = byFrom(gitShowsRenames(t.folder, t.first));
            assert.deepStrictEqual(git, [{ from: '/one.tex', to: '/second.tex' }, { from: '/two.tex', to: '/first.tex' }], 'git pairs the paths by content');
            const summary = await t.sync.flush(true);
            assert.deepStrictEqual(byFrom(summary.renamed), git, 'the sync\'s renames are git\'s pairs');
            assert.deepStrictEqual([...t.remote.calls].sort(), ['rename /one.tex /second.tex', 'rename /two.tex /first.tex', 'writeDoc /first.tex', 'writeDoc /second.tex'], 'what the sync asked of Overleaf');
            assert.deepStrictEqual([t.remote.ids.get('/second.tex'), t.remote.ids.get('/first.tex')], [ids.one, ids.two], 'each document keeps its id');
            assert.strictEqual(t.remote.docs.get('/first.tex'), two.replace('paragraph 2.', 'paragraph two.'), 'the text of first.tex on Overleaf');
            await t.sync.stop();
        });

        it('renames a document to a name with spaces and letters outside ASCII, as git names them', async () => {
            const t = await synced({ '/poglavlje.tex': chapter });
            const id = t.remote.idOf('/poglavlje.tex');
            const to = 'uvod i čćžšđ/prvo poglavlje.tex';
            move(t, 'poglavlje.tex', to);
            fs.writeFileSync(path.join(t.folder, to), edited);
            const summary = await t.sync.flush(true);
            assert.deepStrictEqual(t.remote.calls, [`rename /poglavlje.tex /${to}`, `writeDoc /${to}`], 'what the sync asked of Overleaf: the rename, then the edit');
            assert.deepStrictEqual(summary.failed, [], 'the failures');
            assert.strictEqual(t.remote.ids.get(`/${to}`), id, 'the document at the new path is the one that was at the old path');
            await t.sync.stop();
        });

        it('sends two documents that swapped their content as two edits, as git does not pair paths that both trees have', async () => {
            const one = lines(i => `The first chapter, sentence ${i}.`), two = lines(i => `The second chapter, paragraph ${i}.`);
            const t = await synced({ '/one.tex': one, '/two.tex': two });
            const ids = { one: t.remote.idOf('/one.tex'), two: t.remote.idOf('/two.tex') };
            fs.writeFileSync(path.join(t.folder, 'one.tex'), two);
            fs.writeFileSync(path.join(t.folder, 'two.tex'), one);
            assert.deepStrictEqual(gitShowsRenames(t.folder, t.first), [], 'git shows two changed files');
            const summary = await t.sync.flush(true);
            assert.deepStrictEqual([...t.remote.calls].sort(), ['writeDoc /one.tex', 'writeDoc /two.tex'], 'what the sync asked of Overleaf');
            assert.deepStrictEqual(summary.renamed, [], 'the summary');
            assert.deepStrictEqual([t.remote.ids.get('/one.tex'), t.remote.ids.get('/two.tex')], [ids.one, ids.two], 'each path keeps its document');
            await t.sync.stop();
        });

        it('renames a binary file renamed and changed, then replaces its content', async () => {
            const png = new Uint8Array(4096).map((_, i) => (i * 7 + (i >> 5)) & 0xff);
            png.set([0x89, 0x50, 0x4e, 0x47]);
            const changed = png.map((byte, i) => i >= 3000 && i < 3100 ? 0 : byte);
            const t = await synced({ '/main.tex': chapter, '/slike/a.png': png });
            move(t, 'slike/a.png', 'figures/a.png');
            fs.writeFileSync(path.join(t.folder, 'figures/a.png'), changed);
            assert.deepStrictEqual(gitShowsRenames(t.folder, t.first), [{ from: '/slike/a.png', to: '/figures/a.png' }], 'git pairs the paths');
            const summary = await t.sync.flush(true);
            assert.deepStrictEqual(t.remote.calls, ['rename /slike/a.png /figures/a.png', 'upload /figures/a.png'], 'what the sync asked of Overleaf: the rename, then the new content');
            assert.deepStrictEqual([summary.renamed, summary.uploaded], [[{ from: '/slike/a.png', to: '/figures/a.png' }], ['/figures/a.png']], 'the summary');
            assert.deepStrictEqual([t.remote.files.get('/figures/a.png'), t.remote.files.has('/slike/a.png')], [changed, false], 'the files on Overleaf');
            assert.deepStrictEqual([...t.remote.removedFolders], ['/slike'], 'the folders removed on Overleaf once empty');
            t.update(ME);
            await t.sync.recordNow();
            assert.match(t.g('diff', '--name-status', '-M', t.first, OVERLEAF_REF), /^R0[5-9]\d\tslike\/a.png\tfigures\/a.png$/m, 'git\'s view of the recorded state');
            await t.sync.stop();
        });

        it('moves a folder with an edit inside as the moves of its files, and removes the folder it left', async () => {
            const two = lines(i => `The second chapter, paragraph ${i}.`);
            const t = await synced({ '/chapters/one.tex': chapter, '/chapters/two.tex': two });
            const ids = { one: t.remote.idOf('/chapters/one.tex'), two: t.remote.idOf('/chapters/two.tex') };
            t.remote.comment('/chapters/one.tex', commented);
            move(t, 'chapters', 'parts');
            fs.writeFileSync(path.join(t.folder, 'parts/one.tex'), edited);
            const summary = await t.sync.flush(true);
            assert.deepStrictEqual([...t.remote.calls].sort(), ['rename /chapters/one.tex /parts/one.tex', 'rename /chapters/two.tex /parts/two.tex', 'writeDoc /parts/one.tex'], 'what the sync asked of Overleaf');
            assert.deepStrictEqual(summary.failed, [], 'the failures');
            assert.deepStrictEqual([t.remote.ids.get('/parts/one.tex'), t.remote.ids.get('/parts/two.tex')], [ids.one, ids.two], 'each document keeps its id');
            assert.deepStrictEqual(t.remote.commentedText('/parts/one.tex'), [commented], 'the comment on the text that the edit left alone');
            assert.deepStrictEqual([...t.remote.removedFolders], ['/chapters'], 'the folders removed on Overleaf once empty');
            t.update(ME);
            await t.sync.recordNow();
            const diff = t.g('diff', '--name-status', '-M', t.first, OVERLEAF_REF);
            assert.match(diff, /^R0[5-9]\d\tchapters\/one.tex\tparts\/one.tex$/m, 'git\'s view of the recorded state: one.tex');
            assert.match(diff, /^R100\tchapters\/two.tex\tparts\/two.tex$/m, 'git\'s view of the recorded state: two.tex');
            await t.sync.stop();
        });

        for (const [content, what, calls] of [[chapter, 'the same', ['rename /a.tex /b.tex']], [edited, 'edited', ['rename /a.tex /b.tex', 'writeDoc /b.tex']]] as const) {
            it(`renames a document when the event of its old path comes first, the content ${what}`, async () => {
                const t = await synced({ '/a.tex': chapter });
                const id = t.remote.idOf('/a.tex');
                move(t, 'a.tex', 'b.tex');
                fs.writeFileSync(path.join(t.folder, 'b.tex'), content);
                await t.sync.localChanged('/a.tex');
                assert.deepStrictEqual(t.remote.calls, [], 'after the event of the old path: it waits for the new one');
                await t.sync.localChanged('/b.tex');
                assert.deepStrictEqual(t.remote.calls, calls, 'after the event of the new path');
                assert.strictEqual(t.remote.ids.get('/b.tex'), id, 'the document at the new path is the one that was at the old path');
                await t.sync.stop();
            });
        }

        it('moves the local file when Overleaf renames it, with the local changes that wait for a push in it', async () => {
            const t = await world();
            t.remote.docs.set('/chapter.tex', chapter);
            t.update(ME);
            const sync = new ReplicaSync(t.remote, t.local, t.store, t.ui, (p: string) => p.endsWith('.aux'), { uploads: false });
            await sync.syncAll();
            await sync.recordNow();
            const first = t.g('rev-parse', 'HEAD');
            const local = chapter.replace('Line 1 of', 'Line 1, edited locally, of');
            t.write('/chapter.tex', local);
            await sync.localChanged('/chapter.tex');
            assert.strictEqual(t.remote.docs.get('/chapter.tex'), chapter, 'the local change waits for a push');

            await t.remote.rename('/chapter.tex', '/intro.tex');
            t.update(ALICE);
            await sync.remoteRenamed('/chapter.tex', '/intro.tex');
            assert.deepStrictEqual([fs.existsSync(path.join(t.folder, 'chapter.tex')), t.read('/intro.tex')], [false, local], 'the local files: the moved file keeps the local change');
            assert.ok(!fs.existsSync(path.join(t.folder, '.overleaf/conflicts')), 'nothing is kept aside');
            await sync.recordNow();
            assert.match(t.g('diff', '--name-status', '-M', first, 'HEAD'), /^R100\tchapter.tex\tintro.tex$/m, 'git\'s view of the recorded state');
            assert.strictEqual(t.g('status', '--porcelain'), 'M intro.tex', 'git status: the local change, still to push');
            await sync.stop();
        });

        it('deletes the old path of a rename that Overleaf refuses in the same step, once the new file is uploaded', async () => {
            const t = await synced({ '/a.tex': chapter });
            move(t, 'a.tex', 'b.tex');
            fs.writeFileSync(path.join(t.folder, 'b.tex'), edited);
            t.remote.refuseRenames = true;
            const summary = await t.sync.flush(true);
            assert.deepStrictEqual([...t.remote.calls].sort(), ['remove /a.tex', 'rename /a.tex /b.tex', 'upload /b.tex'], 'what the sync asked of Overleaf: the refused rename, a new document and the deletion');
            assert.deepStrictEqual([summary.renamed, summary.uploaded, summary.deletedRemote], [[], ['/b.tex'], ['/a.tex']], 'the summary of the step');
            await t.sync.stop();
        });

        it('renames the six files that one checkout renames, beside a deletion, without a question about deletions', async () => {
            const chapters = Array.from({ length: 7 }, (_, k) => lines(i => `Chapter ${k}, line ${i}, with a few words in it.`));
            const t = await synced(Object.fromEntries(chapters.map((text, k) => [`/chapter${k}.tex`, text])));
            const ids = chapters.map((_, k) => t.remote.idOf(`/chapter${k}.tex`));
            // one commit, checked out: chapters 0 to 5 become parts, chapter 6 is deleted
            const files: Record<string, string | null> = { 'chapter6.tex': null };
            for (let k = 0; k < 6; k++) { files[`chapter${k}.tex`] = null; files[`part${k}.tex`] = chapters[k]; }
            t.g('merge', '--ff-only', '--quiet', commitOnTop(t.folder, t.first, files, 'Six chapters become parts, one goes'));
            // the events as a checkout gives them: the deleted paths first
            for (let k = 6; k >= 0; k--) { await t.sync.localChanged(`/chapter${k}.tex`); }
            for (let k = 0; k < 6; k++) { await t.sync.localChanged(`/part${k}.tex`); }
            assert.deepStrictEqual(t.ui.questions, [], 'the questions about deletions');
            assert.deepStrictEqual([...t.remote.calls].sort(), ['remove /chapter6.tex', ...Array.from({ length: 6 }, (_, k) => `rename /chapter${k}.tex /part${k}.tex`)].sort(), 'what the sync asked of Overleaf');
            assert.deepStrictEqual(Array.from({ length: 6 }, (_, k) => t.remote.ids.get(`/part${k}.tex`)), ids.slice(0, 6), 'each document keeps its id');
            await t.sync.stop();
        });

        it('leaves the files of a folder that Overleaf moves out of the count of deletions while their move is applied', async () => {
            const chapters = Array.from({ length: 6 }, (_, k) => lines(i => `Chapter ${k}, line ${i}, with a few words in it.`));
            const t = await synced({ ...Object.fromEntries(chapters.map((text, k) => [`/chapters/c${k}.tex`, text])), '/other.tex': chapter });
            // Overleaf moves the folder and deletes another file
            for (let k = 0; k < 6; k++) { await t.remote.rename(`/chapters/c${k}.tex`, `/parts/c${k}.tex`); }
            t.remote.docs.delete('/other.tex');
            // the local moves wait while the deletion is decided
            let open!: () => void;
            t.local.moveGate = new Promise<void>(resolve => { open = resolve; });
            const moving = new Promise<void>(resolve => { t.local.onMove = () => resolve(); });
            const renamed = t.sync.remoteRenamed('/chapters', '/parts');
            await moving;
            // the deletion is decided, or a question about deletions is asked, whichever comes first
            const question = new Promise<void>(resolve => { t.ui.onQuestion = () => resolve(); });
            const deleted = t.sync.remoteChanged('/other.tex', true);
            try {
                await Promise.race([deleted, question]);
                assert.deepStrictEqual(t.ui.questions, [], 'the questions about deletions');
                assert.ok(!fs.existsSync(path.join(t.folder, 'other.tex')), 'the file deleted on Overleaf is deleted locally');
            } finally {
                t.local.moveGate = undefined;
                open();
                await Promise.allSettled([renamed, deleted]);
            }
            await Promise.all([renamed, deleted]);
            assert.deepStrictEqual(chapters.map((text, k) => t.read(`/parts/c${k}.tex`) === text), chapters.map(() => true), 'the moved files');
            assert.ok(!fs.existsSync(path.join(t.folder, 'chapters')), 'the folder they left is gone');
            await t.sync.stop();
        });

        it('finishes when Overleaf reports the rename that the folder made, while the folder\'s rename waits for its pairing', async () => {
            const t = await synced({ '/y.tex': chapter });
            const id = t.remote.idOf('/y.tex');
            move(t, 'y.tex', 'x.tex');
            // git's pairing of the folder's rename is made, and then held, while the reconcile of x.tex holds x.tex's queue
            let open!: () => void;
            const gate = new Promise<void>(resolve => { open = resolve; });
            let paired!: () => void;
            const pairing = new Promise<void>(resolve => { paired = resolve; });
            const renames = t.store.renames.bind(t.store);
            t.store.renames = async (removed, added) => {
                const pairs = await renames(removed, added);
                paired();
                await gate;
                return pairs;
            };
            const folder = t.sync.localChanged('/x.tex');
            await pairing;
            // Overleaf reports the same rename. Its move needs the queues of both paths, and
            // remoteRenamed queues it before it first waits, the saved state being loaded.
            await t.remote.rename('/y.tex', '/x.tex');
            const overleaf = t.sync.remoteRenamed('/y.tex', '/x.tex');
            open();
            // Work that waits for itself in a circle never finishes, and only a limit tells "never"
            // from "not yet": the test's last resort, far above the few hundred milliseconds the work takes.
            const limitMs = 10_000;
            let timer: NodeJS.Timeout | undefined;
            const circle = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`the folder's rename and Overleaf's move did not finish within ${limitMs} ms: they wait for each other`)), limitMs);
            });
            try {
                await Promise.race([Promise.all([folder, overleaf]), circle]);
            } finally {
                clearTimeout(timer);
            }
            assert.deepStrictEqual([fs.existsSync(path.join(t.folder, 'y.tex')), t.read('/x.tex')], [false, chapter], 'the local files');
            assert.deepStrictEqual(t.remote.calls, ['rename /y.tex /x.tex'], 'what was asked of Overleaf: its own rename only');
            assert.strictEqual(t.remote.ids.get('/x.tex'), id, 'the document keeps its id');
            await t.sync.stop();
        });

        it('moves the local file when Overleaf renames it while a reconcile of the old path waits in its queue', async () => {
            const t = await world();
            t.remote.docs.set('/chapter.tex', chapter);
            t.update(ME);
            const sync = new ReplicaSync(t.remote, t.local, t.store, t.ui, (p: string) => p.endsWith('.aux'), { uploads: false });
            await sync.syncAll();
            await sync.recordNow();
            const local = chapter.replace('Line 1 of', 'Line 1, edited locally, of');
            t.write('/chapter.tex', local);
            // a reconcile of chapter.tex waits for Overleaf's text, and a second one waits behind it
            let open!: () => void;
            t.remote.readGate = new Promise<void>(resolve => { open = resolve; });
            const reading = new Promise<void>(resolve => { t.remote.onRead = () => resolve(); });
            const first = sync.localChanged('/chapter.tex');
            await reading;
            const second = sync.remoteChanged('/chapter.tex', false);
            // remoteChanged schedules after promise steps only, without I/O: one turn of the event loop has it queued
            await new Promise(resolve => setImmediate(resolve));
            // then Overleaf renames it
            await t.remote.rename('/chapter.tex', '/intro.tex');
            const renamed = sync.remoteRenamed('/chapter.tex', '/intro.tex');
            t.remote.readGate = undefined;
            open();
            await Promise.all([first, second, renamed]);
            assert.deepStrictEqual([fs.existsSync(path.join(t.folder, 'chapter.tex')), t.read('/intro.tex')], [false, local], 'the local files: the moved file keeps the local change');
            assert.ok(!fs.existsSync(path.join(t.folder, '.overleaf/conflicts')), 'nothing is kept aside');
            await sync.stop();
        });

        it('moves the local file when Overleaf renames it, and uploads a local change saved before to the renamed document', async () => {
            const t = await synced({ '/chapter.tex': chapter });
            const id = t.remote.idOf('/chapter.tex');
            t.remote.comment('/chapter.tex', commented);
            // a change saved, which no event has reported yet
            t.write('/chapter.tex', edited);
            await t.remote.rename('/chapter.tex', '/intro.tex');
            t.remote.calls.length = 0;
            t.update(ALICE);
            await t.sync.remoteRenamed('/chapter.tex', '/intro.tex');
            assert.deepStrictEqual([fs.existsSync(path.join(t.folder, 'chapter.tex')), t.read('/intro.tex')], [false, edited], 'the local files');
            assert.deepStrictEqual(t.remote.calls, ['writeDoc /intro.tex'], 'what the sync asked of Overleaf: the local change, as an edit of the renamed document');
            assert.deepStrictEqual([t.remote.ids.get('/intro.tex'), t.remote.docs.get('/intro.tex')], [id, edited], 'the document on Overleaf');
            assert.deepStrictEqual(t.remote.commentedText('/intro.tex'), [commented], 'the comment on the text that the change left alone');
            await t.sync.stop();
        });

        it('moves the local file when Overleaf renames it while git is in the middle of an operation, once the operation ends', async () => {
            const t = await synced({ '/chapter.tex': chapter });
            const id = t.remote.idOf('/chapter.tex');
            // a change saved, which no event has reported yet
            t.write('/chapter.tex', edited);
            // a merge is under way in the folder: the sync waits
            const mergeHead = path.join(t.folder, '.git', 'MERGE_HEAD');
            fs.writeFileSync(mergeHead, `${t.g('rev-parse', 'HEAD')}\n`);
            await t.remote.rename('/chapter.tex', '/intro.tex');
            t.remote.calls.length = 0;
            t.update(ALICE);
            await t.sync.remoteRenamed('/chapter.tex', '/intro.tex');
            assert.deepStrictEqual([t.read('/chapter.tex'), fs.existsSync(path.join(t.folder, 'intro.tex'))], [edited, false], 'the local files while the sync waits');
            // the merge ends; the full sync after the wait catches up
            fs.rmSync(mergeHead);
            await t.sync.syncAll();
            assert.deepStrictEqual([fs.existsSync(path.join(t.folder, 'chapter.tex')), t.read('/intro.tex')], [false, edited], 'the local files: the moved file keeps the local change');
            assert.ok(!fs.existsSync(path.join(t.folder, '.overleaf/conflicts')), 'nothing is kept aside');
            assert.deepStrictEqual([t.remote.ids.get('/intro.tex'), t.remote.docs.get('/intro.tex')], [id, edited], 'the document on Overleaf: the renamed one, with the local change');
            await t.sync.stop();
        });

        it('moves the local file when Overleaf renames it and git starts an operation while the move looks up the new path, once the operation ends', async () => {
            const t = await synced({ '/chapter.tex': chapter });
            const id = t.remote.idOf('/chapter.tex');
            // a change saved, which no event has reported yet
            t.write('/chapter.tex', edited);
            await t.remote.rename('/chapter.tex', '/intro.tex');
            t.remote.calls.length = 0;
            t.update(ALICE);
            // A merge starts after the move's first check, while the move looks up the new path on
            // Overleaf: the check right before the move finds it.
            const mergeHead = path.join(t.folder, '.git', 'MERGE_HEAD');
            const entry = t.remote.entry;
            let mergeStarted = false;
            t.remote.entry = async (p: string) => {
                if (p === '/intro.tex' && !mergeStarted) {
                    mergeStarted = true;
                    fs.writeFileSync(mergeHead, `${t.g('rev-parse', 'HEAD')}\n`);
                }
                return entry.call(t.remote, p);
            };
            try {
                await t.sync.remoteRenamed('/chapter.tex', '/intro.tex');
            } finally {
                t.remote.entry = entry;
            }
            assert.ok(mergeStarted, 'the merge started during the move');
            assert.deepStrictEqual([t.read('/chapter.tex'), fs.existsSync(path.join(t.folder, 'intro.tex'))], [edited, false], 'the local files while the sync waits');
            // the merge ends; the full sync after the wait catches up
            fs.rmSync(mergeHead);
            await t.sync.syncAll();
            assert.deepStrictEqual([fs.existsSync(path.join(t.folder, 'chapter.tex')), t.read('/intro.tex')], [false, edited], 'the local files: the moved file keeps the local change');
            assert.ok(!fs.existsSync(path.join(t.folder, '.overleaf/conflicts')), 'nothing is kept aside');
            assert.deepStrictEqual([t.remote.ids.get('/intro.tex'), t.remote.docs.get('/intro.tex')], [id, edited], 'the document on Overleaf: the renamed one, with the local change');
            await t.sync.stop();
        });

        it('moves the files of a folder that Overleaf moved, with a local change in one of them', async () => {
            const two = lines(i => `The second chapter, paragraph ${i}.`);
            const t = await world();
            t.remote.docs.set('/chapters/one.tex', chapter);
            t.remote.docs.set('/chapters/two.tex', two);
            t.update(ME);
            const sync = new ReplicaSync(t.remote, t.local, t.store, t.ui, (p: string) => p.endsWith('.aux'), { uploads: false });
            await sync.syncAll();
            await sync.recordNow();
            const first = t.g('rev-parse', 'HEAD');
            t.write('/chapters/one.tex', edited);
            await sync.localChanged('/chapters/one.tex');
            // Overleaf moves the folder: its files are at the new path
            await t.remote.rename('/chapters/one.tex', '/parts/one.tex');
            await t.remote.rename('/chapters/two.tex', '/parts/two.tex');
            t.update(ALICE);
            await sync.remoteRenamed('/chapters', '/parts');
            assert.deepStrictEqual([t.read('/parts/one.tex'), t.read('/parts/two.tex')], [edited, two], 'the local files in the new folder');
            assert.ok(!fs.existsSync(path.join(t.folder, 'chapters')), 'the folder they left is gone');
            await sync.recordNow();
            const diff = t.g('diff', '--name-status', '-M', first, 'HEAD');
            assert.match(diff, /^R100\tchapters\/one.tex\tparts\/one.tex$/m, 'git\'s view of the recorded state: one.tex');
            assert.match(diff, /^R100\tchapters\/two.tex\tparts\/two.tex$/m, 'git\'s view of the recorded state: two.tex');
            assert.strictEqual(t.g('status', '--porcelain'), 'M parts/one.tex', 'git status: the local change, still to push');
            await sync.stop();
        });

        it('syncs a rename on Overleaf onto a path the folder already has as a deletion and a new file', async () => {
            const t = await synced({ '/chapter.tex': chapter });
            t.write('/intro.tex', 'a local file of the same name, not uploaded yet\n');
            await t.remote.rename('/chapter.tex', '/intro.tex');
            t.update(ALICE);
            await t.sync.remoteRenamed('/chapter.tex', '/intro.tex');
            assert.deepStrictEqual([fs.existsSync(path.join(t.folder, 'chapter.tex')), t.read('/intro.tex')], [false, chapter], 'the local files: Overleaf\'s version at the new path');
            const kept = fs.readdirSync(path.join(t.folder, '.overleaf/conflicts'), { recursive: true }).map(String);
            assert.ok(kept.some(p => p.endsWith('intro.tex')), `the local file at the new path is kept aside: ${kept.join(', ')}`);
            await t.sync.stop();
        });

        it('records a rename and an edit made on Overleaf as git shows a rename', async () => {
            const t = await synced({ '/one.tex': chapter });
            await t.remote.rename('/one.tex', '/two.tex');
            t.remote.docs.set('/two.tex', edited);
            t.update(ALICE);
            await Promise.all([t.sync.remoteChanged('/one.tex', true), t.sync.remoteChanged('/two.tex', false)]);
            assert.strictEqual(t.read('/two.tex'), edited, 'the local file at the new path');
            assert.ok(!fs.existsSync(path.join(t.folder, 'one.tex')), 'the local file at the old path is gone');
            await t.sync.recordNow();
            assert.match(t.g('diff', '--name-status', '-M', t.first, 'HEAD'), /^R0[5-9]\d\tone.tex\ttwo.tex$/m, 'git\'s view of the recorded state');
            assert.match(t.g('log', '--follow', '--format=%H', 'HEAD', '--', 'two.tex'), new RegExp(`^${t.first}$`, 'm'), 'git log --follow reaches the commit before the rename');
            assert.strictEqual(t.g('status', '--porcelain'), '', 'git status after the record');
            await t.sync.stop();
        });
    });

    it('keeps files that the sync leaves out, and the files\' modes, in the commits of Overleaf\'s state', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.remote.docs.set('/layout/build.sh', '#!/bin/sh\n');
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        t.write('/.gitignore', '*.pdf\n');
        fs.chmodSync(path.join(t.folder, 'layout/build.sh'), 0o755);
        t.g('add', '-f', '.gitignore', 'layout/build.sh');
        t.g('commit', '--quiet', '-m', 'A gitignore, and an executable script');
        await sync.recordNow();
        const own = t.g('rev-parse', 'HEAD');
        assert.strictEqual(t.g('rev-parse', OVERLEAF_REF), own);

        t.remote.docs.set('/main.tex', text + 'more\n');
        t.update(BOB);
        await sync.remoteChanged('/main.tex', false);
        await sync.recordNow();
        assert.strictEqual(t.g('show', 'HEAD:.gitignore'), '*.pdf');
        assert.match(t.g('ls-tree', 'HEAD', 'layout/build.sh'), /^100755 /);
        assert.strictEqual(t.g('status', '--porcelain'), '');
        await sync.stop();
    });

    it('without uploads, keeps local changes for a push through the bridge and records the state that push makes', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.update(ME);
        const sync = new ReplicaSync(t.remote, t.local, t.store, t.ui, (p: string) => p.endsWith('.aux'), { uploads: false });
        await sync.syncAll();
        await sync.recordNow();
        const first = t.g('rev-parse', 'HEAD');

        // a local edit stays local; an edit on Overleaf elsewhere in the file comes in
        t.write('/main.tex', text.replace('line 1', 'line one, local'));
        await sync.localChanged('/main.tex');
        assert.strictEqual(t.remote.count('writeDoc'), 0);
        t.remote.docs.set('/main.tex', text.replace('line 5', 'line five, Overleaf'));
        t.update(BOB);
        const summary = await sync.flush(true);
        assert.deepStrictEqual(summary.held, ['/main.tex']);
        assert.strictEqual(t.read('/main.tex'), text.replace('line 1', 'line one, local').replace('line 5', 'line five, Overleaf'));
        assert.strictEqual(t.remote.count('writeDoc'), 0);
        await sync.recordNow();
        const overleaf = t.g('rev-parse', OVERLEAF_REF);
        assert.strictEqual(t.g('show', `${overleaf}:main.tex`), text.replace('line 5', 'line five, Overleaf').trimEnd());
        assert.strictEqual(t.g('rev-parse', `${overleaf}^`), first);
        assert.match(t.g('status', '--porcelain'), /^M main.tex$/m);

        // the user commits; a push through the bridge brings the commit to Overleaf
        t.g('commit', '--quiet', '-am', 'A local edit');
        const commit = t.g('rev-parse', 'HEAD');
        t.remote.docs.set('/main.tex', t.read('/main.tex'));
        t.update(ME);
        await sync.remoteChanged('/main.tex', false);
        await sync.recordNow();
        assert.strictEqual(t.g('rev-parse', OVERLEAF_REF), commit);
        assert.strictEqual(t.remote.count('writeDoc'), 0);
        await sync.stop();
    });

    it('records an executable local file as executable when Overleaf\'s state first has it', async () => {
        const t = await world();
        t.remote.docs.set('/main.tex', text);
        t.remote.docs.set('/layout/build.sh', '#!/bin/sh\n');
        t.write('/layout/build.sh', '#!/bin/sh\n');
        fs.chmodSync(path.join(t.folder, 'layout/build.sh'), 0o755);
        t.update(ME);
        const sync = t.start();
        await sync.syncAll();
        await sync.recordNow();
        assert.match(t.g('ls-tree', 'HEAD', 'layout/build.sh'), /^100755 /);
        // a new executable file uploaded from the folder
        t.write('/layout/check.sh', '#!/bin/sh\nexit 0\n');
        fs.chmodSync(path.join(t.folder, 'layout/check.sh'), 0o755);
        await sync.localChanged('/layout/check.sh');
        await sync.recordNow();
        assert.match(t.g('ls-tree', 'HEAD', 'layout/check.sh'), /^100755 /);
        assert.strictEqual(t.g('status', '--porcelain'), '');
        await sync.stop();
    });

    it('takes a document\'s saved base from the local file when the saved copy of it is gone', async () => {
        const t = await world();
        t.remote.docs.set('/terms.txt', 'term\n');
        fs.mkdirSync(path.join(t.folder, '.overleaf/sync/base'), { recursive: true });
        fs.writeFileSync(path.join(t.folder, '.overleaf/sync/state.json'), JSON.stringify({
            project: 'p'.repeat(24),
            state: { version: 1, untracked: [], entries: { '/terms.txt': { kind: 'doc', base: gitBlobHash(enc('term\n')), size: 1, mtime: 1, checked: 1 } } },
        }));
        t.write('/terms.txt', 'term\n');
        const sync = t.start();
        assert.strictEqual(await sync.knows('/terms.txt'), true);
        assert.deepStrictEqual(t.g('ls-tree', '-r', '--name-only', OVERLEAF_REF).split('\n'), ['terms.txt']);
        assert.doesNotMatch(t.ui.logs.join('\n'), /no saved base any more/);
        await sync.stop();
    });

    it('makes the sync state kept before git the first commit, and shows local differences as changes', async () => {
        const t = await world();
        const saved = text, edited = text.replace('line 1', 'edited locally');
        t.remote.docs.set('/main.tex', saved);
        t.remote.files.set('/slike/a.png', png);
        t.remote.files.set('/slike/b.png', png.slice(1));
        // the old sync state: main.tex synced, then edited locally while the IDE was closed; b.png changed locally too
        const base = gitBlobHash(enc(saved));
        fs.mkdirSync(path.join(t.folder, '.overleaf/sync/base'), { recursive: true });
        fs.writeFileSync(path.join(t.folder, '.overleaf/sync/base', base), saved);
        fs.writeFileSync(path.join(t.folder, '.overleaf/sync/state.json'), JSON.stringify({
            project: 'p'.repeat(24),
            state: { version: 1, untracked: [], entries: {
                '/main.tex': { kind: 'doc', base, size: 1, mtime: 1, checked: 1 },
                '/slike/a.png': { kind: 'file', base: gitBlobHash(png), size: 1, mtime: 1, checked: 1 },
                '/slike/b.png': { kind: 'file', base: gitBlobHash(png.slice(1)), size: 1, mtime: 1, checked: 1 },
            } },
        }));
        t.write('/main.tex', edited);
        t.write('/slike/a.png', png);
        t.write('/slike/b.png', png.slice(2));

        const sync = t.start();
        assert.strictEqual(await sync.knows('/main.tex'), true);
        const first = t.g('rev-parse', OVERLEAF_REF);
        assert.strictEqual(t.g('rev-parse', 'HEAD'), first);
        assert.deepStrictEqual(t.g('ls-tree', '-r', '--name-only', first).split('\n'), ['main.tex', 'slike/a.png']);
        assert.strictEqual(t.g('show', `${first}:main.tex`), saved.trimEnd());
        // the local edit shows as a change; b.png, with its saved base gone, syncs as a new file
        assert.strictEqual(spawnSync('git', ['-C', t.folder, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, ' M main.tex\n?? slike/b.png\n');
        assert.match(t.ui.logs.join('\n'), /no saved base any more.*\/slike\/b.png/);
        await sync.stop();
    });
});
