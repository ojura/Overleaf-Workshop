/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { HistoryUpdate } from '../gitbridge/history';
import { changedPaths, Entry, FlatTree, GitError, parseTreeDiff, TREE_DIFF_ARGS } from '../gitbridge/plumbing';
import { REPLICA_OWN_FOLDERS } from './ignorePatterns';
import type { Origin, ReplicaStore, SavedState } from './replicaSync';

/*
 * The git repository of a local replica: the sync's only merge backend
 * (docs/replica-workflows.md). The replica folder is the repository's work tree, with `.git`
 * at the folder's root; the sync leaves the replica's own folders out (REPLICA_OWN_FOLDERS),
 * whatever the ignore patterns say, so the repository stays local.
 * In it:
 *
 *   refs/remotes/overleaf/main  Overleaf's states as the replica saw them, one commit per state
 *   refs/notes/overleaf         the Overleaf version of a commit that became Overleaf's state
 *                               by a push, which carries no Overleaf-Version trailer itself
 *   the checked-out branch      the user's commits; git merges Overleaf's states into it
 *
 * The sync (replicaSync.ts) keeps, for every file, the content both sides had after its last
 * sync: its base. This store keeps the bases as git blobs, and when the sync has been idle for
 * a moment it records them as Overleaf's state (`record`):
 *
 * - the bases hold the checked-out commit's files: Overleaf holds that commit, so
 *   refs/remotes/overleaf/main moves to it, and a note gives the version (a native push);
 * - the bases hold files that neither the checked-out commit nor refs/remotes/overleaf/main
 *   has: a commit for Overleaf's new state on refs/remotes/overleaf/main, authored by whoever
 *   made the change (the user of the newest history update for a change made on Overleaf, the
 *   repository's user for an upload from the folder), with the trailers Overleaf-Project and
 *   Overleaf-Version. Its parent is the checked-out commit when that commit's changes are all on
 *   Overleaf (a push, then edits on Overleaf), else the previous state. Then git merges it into
 *   the checked-out branch: a fast-forward when the branch has nothing of its own, else a merge
 *   commit. The work tree already holds the downloaded files, so only the branch and the index
 *   move.
 *
 * The bases of files the sync leaves out (the replica's ignore patterns) are not Overleaf's
 * state: a commit on refs/remotes/overleaf/main keeps such files as its parent has them.
 *
 * Changes in one document on both sides that overlap are git's conflicts: the file holds git's
 * conflict markers and its path is unmerged in the index, with the base, the local version and
 * Overleaf's as stages 1, 2 and 3, until the user resolves it (git add); an unmerged path is
 * never uploaded.
 *
 * This module does not import 'vscode', so that it can be tested in plain Node.
 */

/** Overleaf's states, as the replica saw them. */
export const OVERLEAF_REF = 'refs/remotes/overleaf/main';
/** The Overleaf version of commits that became Overleaf's state by a push. */
export const NOTES_REF = 'refs/notes/overleaf';
const NULL_OID = '0'.repeat(40);

export interface Person { name: string; email: string; }
/** A person and a date in git's format, "<seconds> <+hhmm>". */
export interface Signature extends Person { date: string; }

/** A time in milliseconds in git's date format, in UTC. */
export function gitTime(ms: number): string {
    return `${Math.floor(ms / 1000)} +0000`;
}

/** The environment git gets: no prompt, and nothing inherited that points git at another repository. */
function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']) {
        delete env[key];
    }
    return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', ...extra };
}

export interface GitResult { status: number; stdout: Buffer; stderr: string; }

/** git in one folder, run without blocking: the extension host keeps serving the window meanwhile. */
export class AsyncGit {
    constructor(readonly dir: string) {}

    run(args: string[], options: { input?: string | Uint8Array, env?: Record<string, string>, allowFailure?: boolean } = {}): Promise<GitResult> {
        return new Promise((resolve, reject) => {
            const child = spawn('git', ['-C', this.dir, ...args], { env: gitEnvironment(options.env), stdio: ['pipe', 'pipe', 'pipe'] });
            const out: Buffer[] = [], err: Buffer[] = [];
            child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
            child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
            child.on('error', reject);
            child.on('close', status => {
                const result = { status: status ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') };
                if (result.status !== 0 && !options.allowFailure) {
                    reject(new GitError(args, status, result.stderr));
                } else {
                    resolve(result);
                }
            });
            child.stdin.on('error', () => { /* git exited before reading all of it; its status says why */ });
            child.stdin.end(options.input === undefined ? undefined : Buffer.from(options.input));
        });
    }

    async text(args: string[], options?: { input?: string | Uint8Array, env?: Record<string, string> }): Promise<string> {
        return (await this.run(args, options)).stdout.toString('utf8').trim();
    }

    /** The commit `rev` names, or undefined when it names none. */
    async commit(rev: string): Promise<string | undefined> {
        const result = await this.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFailure: true });
        return result.status === 0 ? result.stdout.toString('utf8').trim() : undefined;
    }

    async config(key: string): Promise<string | undefined> {
        const result = await this.run(['config', '--get', key], { allowFailure: true });
        return result.status === 0 ? result.stdout.toString('utf8').trim() : undefined;
    }

    /** Every blob of a commit or tree, by path. */
    async flatTree(treeish: string): Promise<FlatTree> {
        const out = (await this.run(['ls-tree', '-r', '-z', '--full-tree', treeish])).stdout.toString('utf8');
        const tree: FlatTree = new Map();
        for (const record of out.split('\0')) {
            if (!record) { continue; }
            const tab = record.indexOf('\t');
            const [mode, , oid] = record.slice(0, tab).split(' ');
            tree.set(record.slice(tab + 1), { mode, oid });
        }
        return tree;
    }

    /** Write a tree from a flat map, through a temporary index; fails when a blob is missing. */
    async writeTree(tree: FlatTree): Promise<string> {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'overleaf-index-'));
        try {
            const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
            await this.run(['read-tree', '--empty'], { env });
            if (tree.size > 0) {
                const lines = [...tree].map(([p, e]) => `${e.mode} blob ${e.oid}\t${p}\0`).join('');
                await this.run(['update-index', '-z', '--index-info'], { env, input: lines });
            }
            return await this.text(['write-tree'], { env });
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    }

    async commitTree(tree: string, parents: string[], message: string, author: Signature, committer: Signature): Promise<string> {
        return this.text(['commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-F', '-'], {
            input: message,
            env: {
                GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
                GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: committer.date,
            },
        });
    }

    /** Point `ref` at `oid` when it still points at `expected` (undefined: whatever it points at; '': does not exist). */
    async updateRef(ref: string, oid: string, expected: string | undefined, reason: string, options: { noDeref?: boolean } = {}) {
        await this.run(['update-ref', ...(options.noDeref ? ['--no-deref'] : []), '-m', reason, ref, oid,
            ...(expected === undefined ? [] : [expected || NULL_OID])]);
    }

    async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
        const result = await this.run(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
        if (result.status === 0) { return true; }
        if (result.status === 1) { return false; }
        throw new GitError(['merge-base', '--is-ancestor', ancestor, descendant], result.status, result.stderr);
    }

    async mergeBase(a: string, b: string): Promise<string | undefined> {
        const result = await this.run(['merge-base', a, b], { allowFailure: true });
        return result.status === 0 ? result.stdout.toString('utf8').trim() : undefined;
    }

    /** The tree of git's merge of `ours` and `theirs` from `base`, without touching the work tree or the index. */
    async mergeTrees(base: string, ours: string, theirs: string): Promise<{ tree: string, conflicts: string[] }> {
        const args = ['merge-tree', '--write-tree', '-z', '--name-only', `--merge-base=${base}`, ours, theirs];
        const result = await this.run(args, { allowFailure: true });
        if (result.status !== 0 && result.status !== 1) { throw new GitError(args, result.status, result.stderr); }
        const fields = result.stdout.toString('utf8').split('\0');
        const conflicts: string[] = [];
        if (result.status === 1) {
            for (let i = 1; i < fields.length && fields[i] !== ''; i++) { conflicts.push(fields[i]); }
        }
        return { tree: fields[0], conflicts };
    }

    /** The objects of `oids` that the repository lacks. */
    async missing(oids: string[]): Promise<Set<string>> {
        const missing = new Set<string>();
        if (oids.length === 0) { return missing; }
        const out = (await this.run(['cat-file', '--batch-check'], { input: oids.join('\n') + '\n' })).stdout.toString('utf8');
        for (const line of out.split('\n')) {
            const [oid, kind] = line.split(' ');
            if (kind === 'missing') { missing.add(oid); }
        }
        return missing;
    }

    /** Store `content` as a blob, byte for byte, and return its id. */
    hashObject(content: string | Uint8Array): Promise<string> {
        return this.text(['hash-object', '-w', '--no-filters', '--stdin'], { input: content });
    }

    /** Store the files at `files` (absolute paths) as blobs, byte for byte, and return their ids. */
    async hashFiles(files: string[]): Promise<string[]> {
        if (files.length === 0) { return []; }
        const out = await this.text(['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: files.join('\n') + '\n' });
        return out.split('\n');
    }

    async readBlob(oid: string): Promise<Buffer | undefined> {
        const result = await this.run(['cat-file', 'blob', oid], { allowFailure: true });
        return result.status === 0 ? result.stdout : undefined;
    }

    /** The index's entries: stage 0 by path, and the paths with unmerged stages. */
    async indexEntries(): Promise<{ entries: Map<string, Entry>, unmerged: Set<string> }> {
        const out = (await this.run(['ls-files', '-s', '-z'])).stdout.toString('utf8');
        const entries = new Map<string, Entry>();
        const unmerged = new Set<string>();
        for (const record of out.split('\0')) {
            if (!record) { continue; }
            const tab = record.indexOf('\t');
            const [mode, oid, stage] = record.slice(0, tab).split(' ');
            const p = record.slice(tab + 1);
            if (stage === '0') { entries.set(p, { mode, oid }); } else { unmerged.add(p); }
        }
        return { entries, unmerged };
    }

    /**
     * Change index entries: an entry sets the path's stage-0 entry, undefined removes it. Waits for
     * a git command that holds the index's lock (index.lock) to finish, for up to `waitMs`.
     */
    async setIndexEntries(changes: Map<string, Entry | undefined>, waitMs = 10_000): Promise<void> {
        if (changes.size === 0) { return; }
        const lines = [...changes].map(([p, e]) => e ? `${e.mode} ${e.oid}\t${p}\0` : `0 ${NULL_OID}\t${p}\0`).join('');
        await this.withIndexLock(() => this.run(['update-index', '-z', '--index-info'], { input: lines }), waitMs);
    }

    /** Run an index-writing command again while another git command holds the index's lock. */
    async withIndexLock<T>(write: () => Promise<T>, waitMs = 10_000): Promise<T> {
        for (const end = Date.now() + waitMs; ;) {
            try {
                return await write();
            } catch (error) {
                if (!(error instanceof GitError) || !/index\.lock/.test(error.stderr) || Date.now() > end) { throw error; }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
    }
}

/**
 * git's three-way merge of one text (git merge-file): `local` and `remote` both changed from
 * `base`. Overlapping changes are marked as git marks them, "<<<<<<< Local", "=======" and
 * ">>>>>>> Remote", in git's default style whatever merge.conflictStyle says.
 */
export async function gitMergeText(base: string, local: string, remote: string): Promise<{ content: string, hasConflict: boolean }> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'overleaf-merge-'));
    try {
        const [l, b, r] = ['local', 'base', 'remote'].map(name => path.join(dir, name));
        await Promise.all([fsp.writeFile(l, local), fsp.writeFile(b, base), fsp.writeFile(r, remote)]);
        const result = await new AsyncGit(dir).run(['-c', 'merge.conflictStyle=merge', 'merge-file', '-p', '-L', 'Local', '-L', 'Base', '-L', 'Remote', l, b, r], { allowFailure: true });
        // the number of conflicts, at most 127; a negative status (255 as an exit code) is an error
        if (result.status < 0 || result.status > 127) {
            throw new GitError(['merge-file'], result.status, result.stderr);
        }
        return { content: result.stdout.toString('utf8'), hasConflict: result.status > 0 };
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}

/** A minimatch pattern of the replica (matched against '/dir/name'), as a line of a gitignore file. */
export function gitignoreLine(pattern: string): string {
    let line = pattern.startsWith('**/') ? pattern.slice(3) : pattern;
    if (line.endsWith('/**')) { line = `${line.slice(0, -3)}/`; }
    // a pattern with a slash before its end is anchored at the folder's root, as the replica's paths are
    const inner = line.endsWith('/') ? line.slice(0, -1) : line;
    if (inner.includes('/') && !line.startsWith('/')) { line = `/${line}`; }
    return line;
}

const EXCLUDE_START = '# overleaf-workshop: the replica\'s own state, and the paths it does not sync (rewritten when the replica starts)';
const EXCLUDE_END = '# end of overleaf-workshop';

/**
 * Make `folder` the work tree of a repository of its own, unless it is one already, and keep
 * its exclude file in line with the replica's ignore patterns, so that git status lists
 * neither the replica's `.overleaf` folder nor the products of a local build. Returns the
 * repository's git folder.
 */
export async function ensureRepository(folder: string, ignorePatterns: readonly string[]): Promise<string> {
    const git = new AsyncGit(folder);
    const top = await git.run(['rev-parse', '--show-toplevel'], { allowFailure: true });
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    if (top.status !== 0 || real(top.stdout.toString('utf8').trim()) !== real(folder)) {
        // also when the folder is inside another repository: the replica gets its own
        await git.run(['init', '--quiet', '--initial-branch=main']);
    }
    const gitDir = await git.text(['rev-parse', '--absolute-git-dir']);
    const exclude = path.join(gitDir, 'info', 'exclude');
    let text = '';
    try { text = await fsp.readFile(exclude, 'utf8'); } catch { /* none yet */ }
    const start = text.indexOf(EXCLUDE_START), end = text.indexOf(EXCLUDE_END);
    if (start >= 0 && end > start) { text = text.slice(0, start) + text.slice(end + EXCLUDE_END.length).replace(/^\n/, ''); }
    const own = REPLICA_OWN_FOLDERS.map(folder => `${folder}/`);
    const block = [EXCLUDE_START, ...own, ...new Set(ignorePatterns.map(gitignoreLine)), EXCLUDE_END].join('\n') + '\n';
    const updated = (text && !text.endsWith('\n') ? `${text}\n` : text) + block;
    await fsp.mkdir(path.dirname(exclude), { recursive: true });
    await fsp.writeFile(exclude, updated);
    return gitDir;
}

/** What the history tells about the Overleaf updates that the replica has not recorded yet. */
export type HistoryLookup = (afterVersion: number | undefined) => Promise<HistoryUpdate[] | undefined>;

export interface ReplicaGitOptions {
    /** the replica folder, the repository's work tree */
    folder: string;
    projectId: string;
    serverName: string;
    /** the replica's ignore patterns, for the exclude file */
    ignorePatterns: readonly string[];
    /** whether the sync leaves `path` ('/dir/name') out: ignored, or inside `.overleaf` */
    isIgnored: (path: string) => boolean;
    /** the history updates newer than a version, newest first; undefined when the history cannot be read */
    history?: HistoryLookup;
    /** who commits when git has no user.name and user.email, e.g. the Overleaf account */
    fallbackUser?: () => Person | undefined;
    log: (message: string) => void;
    /** where `keepCopy` puts a local version that the sync replaces, inside the folder */
    copiesFolder?: string;
}

/** What `record` did, for the log and for tools. */
export interface RecordResult {
    /** refs/remotes/overleaf/main afterwards */
    overleaf?: string;
    /** the checked-out commit afterwards */
    head?: string;
    /** the commits made for Overleaf's state, oldest first */
    made: string[];
    /** how the checked-out branch took Overleaf's state */
    head_moved?: 'initialized' | 'fast-forward' | 'merged';
    /** a native push finished: refs/remotes/overleaf/main moved to the checked-out commit */
    pushed?: string;
    /** why the branch did not take Overleaf's state */
    notMerged?: string;
    /** a push is uploading: nothing recorded until it is done */
    waiting?: boolean;
}

/** The content of `<git dir>/overleaf/state.json`. */
interface StateFile { project: string; state: SavedState; }

/**
 * The saved sync state exists but cannot be used. The replica does not sync then: a first sync
 * would take Overleaf's version of every file that differs, and keep the local one only aside.
 */
export class ReplicaStateError extends Error {}

/** Paths of the sync ('/dir/name') and of git ('dir/name'). */
const gitPath = (p: string) => p.replace(/^\//, '');
const syncPath = (p: string) => `/${p}`;

function sameFiles(a: FlatTree, b: FlatTree): boolean {
    if (a.size !== b.size) { return false; }
    for (const [p, e] of a) { if (b.get(p)?.oid !== e.oid) { return false; } }
    return true;
}

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(now = new Date()): string {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

/** The value of `key` in the trailers of a commit message or note, e.g. Overleaf-Version. */
export function trailerValue(message: string, key: string): string | undefined {
    const match = new RegExp(`^${key}: *(.+)$`, 'mi').exec(message);
    return match?.[1].trim();
}

/** "Name <email>" of a history update's user, when the history names one. */
function personOf(user: { name?: string, email?: string } | undefined): Person | undefined {
    if (!user?.email) { return undefined; }
    return { name: user.name || user.email, email: user.email };
}

/**
 * The sync's state in the replica's git repository: the bases as blobs, the rest of the sync
 * state in `<git dir>/overleaf/state.json`, and Overleaf's states as commits.
 */
export class GitReplicaStore implements ReplicaStore {
    readonly git: AsyncGit;
    private gitDir?: string;
    private ready?: Promise<string>;
    /** blob writes under way; a record waits for them */
    private writes = new Set<Promise<unknown>>();
    /** notices given once, e.g. about a branch that cannot take Overleaf's state */
    private told = new Set<string>();
    /** the sync state as last saved, for a record that runs outside the sync */
    private lastState?: SavedState;
    private saving: Promise<void> = Promise.resolve();
    /** the index's unmerged paths, and the index file's identity when they were read */
    private unmerged?: { key: string, paths: Set<string> };

    constructor(readonly options: ReplicaGitOptions) {
        this.git = new AsyncGit(options.folder);
    }

    /** The repository's git folder, after making the folder a repository when it is not one. */
    open(): Promise<string> {
        this.ready ??= ensureRepository(this.options.folder, this.options.ignorePatterns).then(dir => (this.gitDir = dir));
        return this.ready;
    }

    private async stateFile(): Promise<string> {
        return path.join(await this.open(), 'overleaf', 'state.json');
    }

    // ---- ReplicaStore

    /**
     * The saved sync state. Without the state file: the bases of Overleaf's last recorded state,
     * else the state kept before git (.overleaf/sync); without either, undefined, and the sync
     * starts as a first sync. A state file that cannot be read, or that belongs to another
     * project, rejects with ReplicaStateError.
     */
    async load(): Promise<SavedState | undefined> {
        const file = await this.stateFile();
        let text: string;
        try {
            text = await fsp.readFile(file, 'utf8');
        } catch (error: any) {
            if (error?.code !== 'ENOENT') { throw await this.stateError(file, `it cannot be read (${error?.message ?? error})`); }
            // a recorded state is newer than the state kept before git, which its first record turned into commits
            const state = await this.recordedState(file) ?? await this.importLegacyState();
            if (state) { this.lastState = state; }
            return state;
        }
        let saved: StateFile;
        try {
            saved = JSON.parse(text);
        } catch (error: any) {
            throw await this.stateError(file, `it is not valid JSON (${error?.message ?? error})`);
        }
        if (saved?.project !== this.options.projectId) {
            throw await this.stateError(file, `it is the state of another project (${String(saved?.project)})`);
        }
        return this.lastState = saved.state;
    }

    private async stateError(file: string, problem: string): Promise<ReplicaStateError> {
        const recorded = await this.git.commit(OVERLEAF_REF);
        return new ReplicaStateError(`The replica's saved sync state ${file} cannot be used: ${problem}. `
            + `The replica does not sync until the file is fixed or removed; without it, the replica takes its bases from `
            + (recorded ? `Overleaf's last recorded state, ${OVERLEAF_REF} (${recorded.slice(0, 7)}).` : 'a first sync, which keeps the local versions that differ from Overleaf aside.'));
    }

    /**
     * The bases of Overleaf's last recorded state, for a replica without its state file; undefined
     * without a recorded state. Each base is the blob that the commit holds: the sync compares its
     * id with the hash of a local file's bytes, and the next sync takes each file's kind from Overleaf.
     */
    private async recordedState(file: string): Promise<SavedState | undefined> {
        const recorded = await this.git.commit(OVERLEAF_REF);
        if (!recorded) { return undefined; }
        const entries: SavedState['entries'] = {};
        for (const [p, e] of this.projectFiles(await this.git.flatTree(recorded))) {
            entries[syncPath(p)] = { kind: 'file', base: e.oid };
        }
        this.options.log(`${file} does not exist; the bases are those of Overleaf's last recorded state, ${OVERLEAF_REF} (${recorded.slice(0, 7)}): ${Object.keys(entries).length} files.`);
        return { version: 1, entries, untracked: [], restored: true };
    }

    save(state: SavedState): Promise<void> {
        // one save at a time, each a new file renamed over the old one, so that a crash cannot leave half a state
        const save = this.saving.then(async () => {
            const file = await this.stateFile();
            await fsp.mkdir(path.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await fsp.writeFile(tmp, JSON.stringify({ project: this.options.projectId, state } satisfies StateFile));
            await fsp.rename(tmp, file);
            this.lastState = state;
        });
        this.saving = save.catch(() => {});
        return save;
    }

    async readBase(hash: string): Promise<string | undefined> {
        await this.open();
        const content = await this.git.readBlob(hash);
        return content?.toString('utf8');
    }

    async writeBase(hash: string, text: string): Promise<void> {
        await this.writeBlob(hash, text);
    }

    async writeFileBase(hash: string, content: Uint8Array): Promise<void> {
        await this.writeBlob(hash, content);
    }

    private writeBlob(hash: string, content: string | Uint8Array): Promise<void> {
        const write = (async () => {
            await this.open();
            const oid = await this.git.hashObject(content);
            if (oid !== hash) { throw new Error(`git stored the content as ${oid}, not as ${hash}`); }
        })();
        this.writes.add(write);
        return write.finally(() => this.writes.delete(write));
    }

    /** The bases are blobs in the repository: git's garbage collection keeps those that commits reach. */
    async pruneBases(): Promise<void> {}

    async keepCopy(filePath: string, content: Uint8Array): Promise<string> {
        const copy = `${this.options.copiesFolder ?? '.overleaf/conflicts'}/${stamp()}${filePath}`;
        const target = path.join(this.options.folder, copy);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content);
        return copy;
    }

    async markConflict(filePath: string, versions: { base: string, local: string, remote: string }): Promise<void> {
        await this.open();
        const [base, local, remote] = await Promise.all([versions.base, versions.local, versions.remote].map(text => this.git.hashObject(text)));
        const p = gitPath(filePath);
        const mode = (await this.git.indexEntries()).entries.get(p)?.mode ?? '100644';
        const lines = `0 ${NULL_OID}\t${p}\0${mode} ${base} 1\t${p}\0${mode} ${local} 2\t${p}\0${mode} ${remote} 3\t${p}\0`;
        await this.git.withIndexLock(() => this.git.run(['update-index', '-z', '--index-info'], { input: lines }));
    }

    /**
     * git's pairing of the synced files gone from the folder with the new files in it
     * (TREE_DIFF_ARGS; docs/replica-workflows.md, "Renames and moves"). `removed` maps each
     * removed path to its base, `added` lists the new paths in the folder. Answers the removed
     * path of each new path that git pairs with one.
     *
     * git compares a tree of the removed files' bases with a tree of the new files' content,
     * which this store keeps byte for byte, as it keeps every base. The two trees hold the
     * removed and the new files only, which gives the pairs that the trees of the last state and
     * of the whole folder give: git pairs a removed path only with an added one. A base that the
     * repository lacks cannot be compared, and its path is left out; so is a new file gone meanwhile.
     */
    async renames(removed: Map<string, string>, added: string[]): Promise<Map<string, string>> {
        const pairs = new Map<string, string>();
        if (removed.size === 0 || added.length === 0) { return pairs; }
        await this.open();
        const missing = await this.git.missing([...new Set(removed.values())]);
        const before: FlatTree = new Map();
        for (const [p, oid] of removed) {
            if (!missing.has(oid)) { before.set(gitPath(p), { mode: '100644', oid }); }
        }
        if (missing.size > 0) {
            const lost = [...removed].filter(([, oid]) => missing.has(oid)).map(([p]) => p);
            this.options.log(`The saved content of ${lost.length} removed files is not in the repository, so git cannot tell whether they were renamed: ${lost.slice(0, 10).join(', ')}${lost.length > 10 ? ', ...' : ''}`);
        }
        const file = (p: string) => path.join(this.options.folder, p);
        const present = added.map(gitPath).filter(p => { try { return fs.statSync(file(p)).isFile(); } catch { return false; } });
        if (before.size === 0 || present.length === 0) { return pairs; }
        const oids = await this.git.hashFiles(present.map(file));
        const after: FlatTree = new Map(present.map((p, i) => [p, { mode: '100644', oid: oids[i] }]));
        const [from, to] = await Promise.all([this.git.writeTree(before), this.git.writeTree(after)]);
        const out = (await this.git.run([...TREE_DIFF_ARGS, from, to])).stdout.toString('utf8');
        for (const change of parseTreeDiff(out)) {
            if (change.status === 'R') { pairs.set(syncPath(change.path), syncPath(change.oldPath!)); }
        }
        return pairs;
    }

    async isUnmerged(filePath: string): Promise<boolean> {
        const gitDir = await this.open();
        // read again only when the index changed: the sync asks before every upload
        let key = 'none';
        try {
            const stat = await fsp.stat(path.join(gitDir, 'index'));
            key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        } catch { /* no index yet */ }
        if (this.unmerged?.key !== key) {
            const out = (await this.git.run(['ls-files', '--unmerged', '-z'])).stdout.toString('utf8');
            const paths = new Set(out.split('\0').filter(Boolean).map(record => record.slice(record.indexOf('\t') + 1)));
            this.unmerged = { key, paths };
        }
        return this.unmerged.paths.has(gitPath(filePath));
    }

    // ---- the saved state of the sync without git, read once

    /**
     * Before the git backend, the sync kept its state in `.overleaf/sync`: the bases of documents
     * as files, and of binary files only their hash. The first start with git turns that into
     * the first commit of refs/remotes/overleaf/main; a binary base that the local file no
     * longer holds cannot be restored, and its file is synced as if seen for the first time.
     * `.overleaf/sync` is not read again.
     */
    private async importLegacyState(): Promise<SavedState | undefined> {
        const dir = path.join(this.options.folder, '.overleaf', 'sync');
        let legacy: { project?: string, state?: SavedState };
        try {
            legacy = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
        } catch {
            return undefined;
        }
        if (legacy.project !== this.options.projectId || legacy.state?.version !== 1) { return undefined; }
        const state: SavedState = { version: 1, entries: {}, untracked: legacy.state.untracked ?? [] };
        const files: { path: string, base: string }[] = [];
        const dropped: string[] = [];
        for (const [p, entry] of Object.entries(legacy.state.entries ?? {})) {
            if (entry.kind === 'doc') {
                // the saved base text, else the local file when it still holds it
                let held = false;
                for (const file of [path.join(dir, 'base', entry.base), path.join(this.options.folder, gitPath(p))]) {
                    let text: Buffer | undefined;
                    try { text = await fsp.readFile(file); } catch { text = undefined; }
                    if (text !== undefined && await this.git.hashObject(text) === entry.base) { held = true; break; }
                }
                if (held) { state.entries[p] = { ...entry }; } else { dropped.push(p); }
            } else {
                files.push({ path: p, base: entry.base });
                state.entries[p] = { ...entry };
            }
        }
        // the binary files' bases from the local files that still hold them, in one git process
        const present = files.filter(f => fs.existsSync(path.join(this.options.folder, gitPath(f.path))));
        const oids = await this.git.hashFiles(present.map(f => path.join(this.options.folder, gitPath(f.path))));
        const held = new Set(present.filter((f, i) => oids[i] === f.base).map(f => f.path));
        for (const f of files) {
            if (!held.has(f.path)) { delete state.entries[f.path]; dropped.push(f.path); }
        }
        this.options.log(`The sync state in .overleaf/sync (${Object.keys(legacy.state.entries ?? {}).length} files) is now kept in git; .overleaf/sync is no longer read.`
            + (dropped.length ? ` ${dropped.length} files have no saved base any more and sync as if seen for the first time: ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ', ...' : ''}` : ''));
        state.changes = Object.fromEntries(Object.keys(state.entries).map(p => [p, 'import' as Origin]));
        await this.save(state);
        return state;
    }

    // ---- Overleaf's states as commits

    /** The repository's user, for commits made for uploads and merges. */
    private async user(): Promise<Person> {
        const name = await this.git.config('user.name'), email = await this.git.config('user.email');
        if (name && email) { return { name, email }; }
        return this.options.fallbackUser?.() ?? { name: 'Overleaf Workshop', email: `overleaf-workshop@${this.options.serverName}` };
    }

    /** The Overleaf version a commit of refs/remotes/overleaf/main holds: its trailer, or its note. */
    async versionOf(commit: string): Promise<number | undefined> {
        const message = await this.git.text(['log', '-1', '--format=%B', commit]);
        let value = trailerValue(message, 'Overleaf-Version');
        if (value === undefined) {
            const note = await this.git.run(['notes', `--ref=${NOTES_REF}`, 'show', commit], { allowFailure: true });
            if (note.status === 0) { value = trailerValue(note.stdout.toString('utf8'), 'Overleaf-Version'); }
        }
        const version = Number(value);
        return value !== undefined && Number.isInteger(version) ? version : undefined;
    }

    /** The files of the sync's bases, by git path; the paths the sync leaves out are not among them. */
    private basesOf(state: SavedState): FlatTree {
        const tree: FlatTree = new Map();
        for (const [p, entry] of Object.entries(state.entries)) {
            if (!this.options.isIgnored(p)) { tree.set(gitPath(p), { mode: '100644', oid: entry.base }); }
        }
        return tree;
    }

    /** Overleaf's files of a commit's tree: those the sync does not leave out. */
    private projectFiles(tree: FlatTree): FlatTree {
        return new Map([...tree].filter(([p]) => !this.options.isIgnored(syncPath(p))));
    }

    /** Blobs the bases name that the repository lacks: taken from the local files that hold them, else from `fallback`. */
    private async fillMissing(bases: FlatTree, fallback: FlatTree): Promise<string[]> {
        await Promise.allSettled([...this.writes]);
        const missing = await this.git.missing([...new Set([...bases.values()].map(e => e.oid))]);
        if (missing.size === 0) { return []; }
        const wanted = [...bases].filter(([, e]) => missing.has(e.oid));
        const present = wanted.filter(([p]) => fs.existsSync(path.join(this.options.folder, p)));
        const oids = await this.git.hashFiles(present.map(([p]) => path.join(this.options.folder, p)));
        const found = new Set(present.filter((_, i) => oids[i] === present[i][1].oid).map(([p]) => p));
        const lost: string[] = [];
        for (const [p] of wanted) {
            if (found.has(p)) { continue; }
            lost.push(p);
            const older = fallback.get(p);
            if (older) { bases.set(p, older); } else { bases.delete(p); }
        }
        return lost;
    }

    /**
     * `files` (Overleaf's files) as a commit's tree on top of `parentTree`: the files the sync
     * leaves out as the parent has them, and each file with the parent's mode, which Overleaf
     * does not keep (an executable script stays executable); a file the parent lacks with the
     * mode of the file in the folder.
     */
    private treeFor(files: FlatTree, parentTree: FlatTree): FlatTree {
        const tree: FlatTree = new Map();
        for (const [p, e] of files) { tree.set(p, { mode: parentTree.get(p)?.mode ?? this.localMode(p), oid: e.oid }); }
        for (const [p, e] of parentTree) {
            if (this.options.isIgnored(syncPath(p))) { tree.set(p, e); }
        }
        return tree;
    }

    /** git's mode for the file at `p` in the folder: executable or not. */
    private localMode(p: string): string {
        try {
            return (fs.statSync(path.join(this.options.folder, p)).mode & 0o111) ? '100755' : '100644';
        } catch {
            return '100644';
        }
    }

    private trailers(version: number | undefined, coAuthors: Person[] = []): string {
        return [
            ...coAuthors.map(p => `Co-authored-by: ${p.name} <${p.email}>`),
            `Overleaf-Project: ${this.options.projectId}`,
            ...(version !== undefined ? [`Overleaf-Version: ${version}`] : []),
        ].join('\n');
    }

    private static listPaths(before: FlatTree, after: FlatTree, paths: string[]): string {
        return paths.map(p => `  ${!before.has(p) ? 'added' : !after.has(p) ? 'deleted' : 'changed'}: ${p}`).join('\n');
    }

    /**
     * Record the sync's bases as Overleaf's state (see the top of this file), and merge it into
     * the checked-out branch. `state.changes` lists the paths with a base that changed since the
     * last record, and where each change came from; the caller clears it after a record.
     */
    async record(state: SavedState = this.lastState ?? { version: 1, entries: {}, untracked: [] }): Promise<RecordResult> {
        await this.open();
        const git = this.git;
        const overleaf = await git.commit(OVERLEAF_REF);
        const head = await git.commit('HEAD');
        const overleafTree = overleaf ? await git.flatTree(overleaf) : new Map<string, Entry>();
        const headTree = head ? await git.flatTree(head) : undefined;
        const bases = this.basesOf(state);
        const lost = await this.fillMissing(bases, overleafTree);
        if (lost.length) {
            this.options.log(`The saved content of ${lost.length} files is not in the repository; their last recorded state stays: ${lost.slice(0, 10).join(', ')}${lost.length > 10 ? ', ...' : ''}`);
        }
        const result: RecordResult = { made: [], overleaf, head };

        // Overleaf holds the checked-out commit
        if (head && headTree && sameFiles(this.projectFiles(headTree), bases)) {
            if (head === overleaf) { return result; }
            if (!overleaf || await git.isAncestor(overleaf, head)) {
                await this.moveOverleaf(head, overleaf, `overleaf: Overleaf holds ${head.slice(0, 7)}`);
                await this.noteVersion(head);
                return { ...result, overleaf: head, pushed: head };
            }
            if (overleaf && sameFiles(this.projectFiles(overleafTree), bases)) {
                // the branch went back to a commit with Overleaf's files: nothing changed on Overleaf
                return result;
            }
            // Overleaf holds the commit's files, after states the commit lacks: one commit joins them
            const user = await this.user();
            const now = { ...user, date: gitTime(Date.now()) };
            const version = await this.newestVersion(overleaf);
            const message = `Overleaf holds the files of ${head.slice(0, 7)}\n\n${this.trailers(version)}\n`;
            const joined = await git.commitTree(await git.writeTree(this.treeFor(bases, headTree)), [overleaf, head], message, now, now);
            await this.moveOverleaf(joined, overleaf, 'overleaf: Overleaf holds the checked-out files');
            await this.moveHead(head, joined, headTree, await git.flatTree(joined), 'overleaf: fast-forward to Overleaf\'s state');
            return { ...result, overleaf: joined, head: joined, made: [joined], head_moved: 'fast-forward' };
        }
        if (overleaf && sameFiles(this.projectFiles(overleafTree), bases)) {
            // nothing new on Overleaf; a branch without a commit yet starts at Overleaf's state
            if (!head) {
                await this.initHead(overleaf);
                return { ...result, head: overleaf, head_moved: 'initialized' };
            }
            return result;
        }

        // Overleaf holds files that neither the checked-out commit nor the last recorded state has
        let parent = overleaf;
        let parentTree = overleafTree;
        if (head && headTree && overleaf && head !== overleaf && await git.isAncestor(overleaf, head)) {
            const own = changedPaths(this.projectFiles(overleafTree), this.projectFiles(headTree));
            const onOverleaf = (p: string) => bases.get(p)?.oid === headTree.get(p)?.oid;
            if (own.every(onOverleaf)) {
                // the branch's commits are all on Overleaf (a push), with edits made after them
                parent = head;
                parentTree = headTree;
            } else if (changedPaths(this.projectFiles(overleafTree), bases).every(p => own.includes(p) && onOverleaf(p))) {
                // a push is uploading the branch's commits: record when it is done
                return { ...result, waiting: true };
            }
        }
        const made = await this.commitState(state, bases, parent, parentTree);
        const tip = made[made.length - 1];
        await this.moveOverleaf(tip, overleaf, made.length === 1 ? 'overleaf: Overleaf\'s new state' : `overleaf: Overleaf's new state, ${made.length} commits`);
        result.made = made;
        result.overleaf = tip;
        if (!head) {
            await this.initHead(tip);
            return { ...result, head: tip, head_moved: 'initialized' };
        }
        const tipTree = await git.flatTree(tip);
        if (await git.isAncestor(head, tip)) {
            await this.moveHead(head, tip, headTree!, tipTree, 'overleaf: fast-forward to Overleaf\'s state');
            return { ...result, head: tip, head_moved: 'fast-forward' };
        }
        const base = await git.mergeBase(head, tip);
        if (!base) {
            return { ...result, notMerged: this.tellOnce(`unrelated:${head}`, `The checked-out branch (${head.slice(0, 7)}) and Overleaf's state (${OVERLEAF_REF}) have no commit in common, so git does not merge them; connect a history with "node out/sandbox/cli.js replica-connect".`) };
        }
        const merged = await git.mergeTrees(base, head, tip);
        if (merged.conflicts.length) {
            return { ...result, notMerged: this.tellOnce(`conflict:${head}:${tip}`, `Overleaf's state (${tip.slice(0, 7)}) and the checked-out branch (${head.slice(0, 7)}) conflict in ${merged.conflicts.join(', ')}; the branch stays where it is. Merge ${OVERLEAF_REF} into it with git, then commit.`) };
        }
        const user = await this.user();
        const now = { ...user, date: gitTime(Date.now()) };
        const merge = await git.commitTree(merged.tree, [head, tip], `Merge the changes made on Overleaf\n\n${this.trailers(undefined)}\n`, now, now);
        await this.moveHead(head, merge, headTree!, await git.flatTree(merge), 'overleaf: merge Overleaf\'s state');
        return { ...result, head: merge, head_moved: 'merged' };
    }

    private tellOnce(key: string, message: string): string {
        if (!this.told.has(key)) {
            this.told.add(key);
            this.options.log(message);
        }
        return message;
    }

    private async newestVersion(after: string | undefined): Promise<number | undefined> {
        const since = after ? await this.versionOf(after) : undefined;
        const updates = await this.historySince(since);
        return updates?.[0]?.toV ?? since;
    }

    private async historySince(version: number | undefined): Promise<HistoryUpdate[] | undefined> {
        if (!this.options.history) { return undefined; }
        try {
            return (await this.options.history(version))?.filter(u => version === undefined || u.toV > version);
        } catch (error: any) {
            this.options.log(`The project's history could not be read: ${error?.message ?? error}`);
            return undefined;
        }
    }

    /**
     * The commits for Overleaf's new state on top of `parent`: one for the changes made on
     * Overleaf, authored as the history says, and one for the uploads from the folder, authored
     * by the repository's user; one of them when the changes came from one side.
     */
    private async commitState(state: SavedState, bases: FlatTree, parent: string | undefined, parentTree: FlatTree): Promise<string[]> {
        const git = this.git;
        const user = await this.user();
        const now = gitTime(Date.now());
        const committer = { ...user, date: now };
        const since = parent ? await this.versionOf(parent) : undefined;
        const updates = await this.historySince(since);
        const version = updates?.[0]?.toV ?? undefined;
        const before = this.projectFiles(parentTree);
        const changed = changedPaths(before, bases);
        const origin = (p: string) => state.changes?.[syncPath(p)];
        const local = changed.filter(p => origin(p) === 'local' || origin(p) === 'merge');
        const made: string[] = [];

        // the changes made on Overleaf first, then the uploads on top
        const remoteTree = new Map(before);
        for (const p of changed) {
            if (local.includes(p)) { continue; }
            const entry = bases.get(p);
            if (entry) { remoteTree.set(p, entry); } else { remoteTree.delete(p); }
        }
        let tip = parent;
        let tipTree = parentTree;
        const remotePaths = changed.filter(p => !local.includes(p));
        if (remotePaths.length) {
            const imported = remotePaths.every(p => origin(p) === 'import');
            const newest = updates?.[0];
            const users = (updates ?? []).flatMap(u => u.users ?? []).map(personOf).filter((p): p is Person => p !== undefined);
            const author: Signature = imported || !newest || !personOf(newest.users?.[0])
                ? { ...user, date: now }
                : { ...personOf(newest.users![0])!, date: gitTime(newest.endTs) };
            const coAuthors = [...new Map(users.filter(p => p.email !== author.email).map(p => [p.email, p])).values()];
            const first = updates?.length ? updates[updates.length - 1].fromV : undefined;
            const subject = imported
                ? (parent ? 'The replica\'s saved sync state' : 'Overleaf\'s state at the replica\'s last sync')
                : !parent ? (version === undefined ? 'Overleaf\'s state' : `Overleaf's state at version ${version}`)
                : version === undefined ? 'Changes made on Overleaf'
                : first !== undefined && first + 1 < version ? `Overleaf versions ${first + 1} to ${version}` : `Overleaf version ${version}`;
            const body = imported
                ? `The bases of the sync state that the replica kept in .overleaf/sync before it kept a git repository:\n${remotePaths.length} files.`
                : !parent ? `The project's files when the replica first synced: ${remotePaths.length} files.`
                : `Changed on Overleaf:\n${GitReplicaStore.listPaths(before, remoteTree, remotePaths)}`;
            const tree = this.treeFor(remoteTree, tipTree);
            tip = await git.commitTree(await git.writeTree(tree), tip ? [tip] : [], `${subject}\n\n${body}\n\n${this.trailers(version, imported ? [] : coAuthors)}\n`, author, committer);
            made.push(tip);
            tipTree = tree;
        }
        if (local.length) {
            const body = `Uploaded from the local folder:\n${GitReplicaStore.listPaths(remoteTree, bases, local)}`;
            const tree = this.treeFor(bases, tipTree);
            tip = await git.commitTree(await git.writeTree(tree), tip ? [tip] : [], `Uploaded from the local folder\n\n${body}\n\n${this.trailers(version)}\n`, committer, committer);
            made.push(tip);
        }
        if (made.length === 0) {
            // only files that the sync leaves out differ: nothing to commit
            return parent ? [parent] : [];
        }
        return made;
    }

    private async moveOverleaf(to: string, from: string | undefined, reason: string) {
        await this.git.updateRef(OVERLEAF_REF, to, from ?? '', reason);
    }

    /** Note the Overleaf version on a commit that became Overleaf's state by a push. */
    private async noteVersion(commit: string) {
        const version = await this.newestVersion(undefined);
        if (version === undefined) { return; }
        const user = await this.user();
        const date = gitTime(Date.now());
        await this.git.run(['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-F', '-', commit], {
            input: `Overleaf-Project: ${this.options.projectId}\nOverleaf-Version: ${version}\n`,
            env: { GIT_AUTHOR_NAME: user.name, GIT_AUTHOR_EMAIL: user.email, GIT_AUTHOR_DATE: date,
                   GIT_COMMITTER_NAME: user.name, GIT_COMMITTER_EMAIL: user.email, GIT_COMMITTER_DATE: date },
        });
    }

    /** Give a branch without a commit its first commit, and the index that commit's files. */
    private async initHead(commit: string) {
        const branch = (await this.git.run(['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true })).stdout.toString('utf8').trim();
        const { entries, unmerged } = await this.git.indexEntries();
        await this.git.updateRef(branch || 'HEAD', commit, '', 'overleaf: start at Overleaf\'s state', { noDeref: !branch });
        if (entries.size === 0 && unmerged.size === 0) {
            await this.git.withIndexLock(() => this.git.run(['read-tree', commit]));
            // the stat information, so that git status need not read every file again
            await this.git.run(['update-index', '-q', '--refresh'], { allowFailure: true });
        } else {
            this.options.log('The branch had no commit but the index had files; it now starts at Overleaf\'s state, and the index stays as it was.');
        }
    }

    /**
     * Move the checked-out branch from `from` to `to`. The work tree already holds `to`'s files
     * where they differ (the sync wrote them), so only the index follows: a changed path takes
     * `to`'s entry where its entry is `from`'s; a path staged with other content, or unmerged,
     * stays as it is.
     */
    private async moveHead(from: string, to: string, fromTree: FlatTree, toTree: FlatTree, reason: string) {
        const branch = (await this.git.run(['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true })).stdout.toString('utf8').trim();
        await this.git.updateRef(branch || 'HEAD', to, from, reason, { noDeref: !branch });
        const { entries } = await this.git.indexEntries();
        const changes = new Map<string, Entry | undefined>();
        for (const p of changedPaths(fromTree, toTree)) {
            // an unmerged path has no stage-0 entry, so it stays as it is too
            const now = entries.get(p), was = fromTree.get(p);
            if (now?.oid !== was?.oid || now?.mode !== was?.mode) { continue; }
            changes.set(p, toTree.get(p));
        }
        await this.git.setIndexEntries(changes);
    }
}
