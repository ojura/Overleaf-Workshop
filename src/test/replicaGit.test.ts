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
import { gitignoreLine, gitMergeText, GitReplicaStore, NOTES_REF, OVERLEAF_REF, trailerValue } from '../scm/replicaGit';
import {
    gitBlobHash, LocalStat, RemoteEntry, ReplicaLocal, ReplicaRemote, ReplicaSync, ReplicaUI, SyncSummary,
} from '../scm/replicaSync';

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Overleaf, in memory: docs hold text, files hold bytes and report their hash; it can rename. */
class Remote implements ReplicaRemote {
    disconnected() { return undefined; }
    docs = new Map<string, string>();
    files = new Map<string, Uint8Array>();
    calls: string[] = [];
    failWrites = new Map<string, number>();

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
    async readDoc(p: string) { const text = this.docs.get(p); if (text === undefined) { throw new Error(`no doc ${p}`); } return text; }
    async readFile(p: string) { const content = this.files.get(p); if (content === undefined) { throw new Error(`no file ${p}`); } return content; }
    async writeDoc(p: string, text: string) {
        this.calls.push(`writeDoc ${p}`);
        const failures = this.failWrites.get(p) ?? 0;
        if (failures > 0) { this.failWrites.set(p, failures - 1); throw new Error('applyOtUpdate timed out'); }
        this.docs.set(p, text);
    }
    async upload(p: string, content: Uint8Array): Promise<RemoteEntry> {
        this.calls.push(`upload ${p}`);
        const failures = this.failWrites.get(p) ?? 0;
        if (failures > 0) { this.failWrites.set(p, failures - 1); throw new Error('the upload failed'); }
        if (/\.(tex|bib|txt|md|t|py|sh)$/.test(p) && !this.files.has(p)) { this.docs.set(p, dec(content)); return { kind: 'doc' }; }
        this.files.set(p, content);
        return { kind: 'file', hash: gitBlobHash(content) };
    }
    async rename(from: string, to: string) {
        this.calls.push(`rename ${from} ${to}`);
        if (this.docs.has(from)) { this.docs.set(to, this.docs.get(from)!); this.docs.delete(from); return; }
        if (this.files.has(from)) { this.files.set(to, this.files.get(from)!); this.files.delete(from); return; }
        throw new Error(`no ${from}`);
    }
    async remove(p: string) { this.calls.push(`remove ${p}`); this.docs.delete(p); this.files.delete(p); }
    async removeFolderIfEmpty() {}
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
    async remove(p: string) { await fsp.rm(this.abs(p), { force: true }); }
    async removeFolderIfEmpty(p: string) { try { await fsp.rmdir(this.abs(p)); } catch { /* not empty */ } }
}

class UI implements ReplicaUI {
    logs: string[] = [];
    blocked: string[] = [];
    log(message: string) { this.logs.push(message); }
    progress() {}
    async confirmDeletions() { return true; }
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
        await sync.indexChanged();
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

        await sync.flush(true);
        assert.strictEqual(t.remote.docs.get('/main.tex'), text.replace('line 2', 'ours'));
        assert.deepStrictEqual(t.ui.blocked, ['/main.tex']);

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
