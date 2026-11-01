/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
/**
 * The git commands the git-bridge tools need, run in one repository. Every command runs
 * without a terminal prompt, so a missing credential fails instead of waiting for input.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export class GitError extends Error {
    constructor(readonly args: string[], readonly status: number | null, readonly stderr: string) {
        super(`git ${args.join(' ')} failed${status !== null ? ` with exit status ${status}` : ''}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-4).join(' | ')}` : ''}`);
    }
}

export interface RunOptions {
    input?: string | Buffer;
    env?: Record<string, string>;
    /** return the result instead of throwing when git exits with a non-zero status */
    allowFailure?: boolean;
}

export interface RunResult { status: number; stdout: Buffer; stderr: string; }

/** One tree entry: a file's mode and object id. */
export interface Entry { mode: string; oid: string; }

/** A tree, flattened: path (with "/" between folders) to entry. Only blobs and submodule links. */
export type FlatTree = Map<string, Entry>;

/** A commit's parts, as `git cat-file commit` gives them. */
export interface CommitInfo {
    oid: string;
    tree: string;
    parents: string[];
    /** "Name <email>" */
    author: string;
    /** "<seconds> <+hhmm>", git's own format, which GIT_AUTHOR_DATE accepts */
    authorDate: string;
    committer: string;
    committerDate: string;
    /** the message, exactly as stored */
    message: string;
}

export interface Person { name: string; email: string; }

export class Repo {
    constructor(readonly dir: string) {}

    run(args: string[], options: RunOptions = {}): RunResult {
        const result = spawnSync('git', ['-C', this.dir, ...args], {
            input: options.input,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
            maxBuffer: 2 * 1024 * 1024 * 1024,
        });
        if (result.error) { throw result.error; }
        const out = { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr.toString('utf8') };
        if (out.status !== 0 && !options.allowFailure) { throw new GitError(args, result.status, out.stderr); }
        return out;
    }

    text(args: string[], options?: RunOptions): string {
        return this.run(args, options).stdout.toString('utf8').trim();
    }

    /** The commit `rev` names, or undefined when it names none. */
    commit(rev: string): string | undefined {
        const result = this.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFailure: true });
        return result.status === 0 ? result.stdout.toString('utf8').trim() : undefined;
    }

    mustCommit(rev: string): string {
        const oid = this.commit(rev);
        if (!oid) { throw new Error(`${rev} names no commit in ${this.dir}`); }
        return oid;
    }

    gitDir(): string {
        return path.resolve(this.dir, this.text(['rev-parse', '--git-dir']));
    }

    config(key: string): string | undefined {
        const result = this.run(['config', '--get', key], { allowFailure: true });
        return result.status === 0 ? result.stdout.toString('utf8').trim() : undefined;
    }

    /** The repository's user, from user.name and user.email, as commits made as the user need it. */
    user(): Person {
        const name = this.config('user.name'), email = this.config('user.email');
        if (!name || !email) { throw new Error(`set user.name and user.email in ${this.dir}: commits that this tool makes are authored as that user`); }
        return { name, email };
    }

    commitInfo(rev: string): CommitInfo {
        const oid = this.mustCommit(rev);
        const raw = this.run(['cat-file', 'commit', oid]).stdout.toString('utf8');
        const split = raw.indexOf('\n\n');
        const header = split < 0 ? raw : raw.slice(0, split);
        const message = split < 0 ? '' : raw.slice(split + 2);
        const info: CommitInfo = { oid, tree: '', parents: [], author: '', authorDate: '', committer: '', committerDate: '', message };
        for (const line of header.split('\n')) {
            const space = line.indexOf(' ');
            const key = line.slice(0, space), value = line.slice(space + 1);
            if (key === 'tree') { info.tree = value; }
            else if (key === 'parent') { info.parents.push(value); }
            else if (key === 'author' || key === 'committer') {
                const m = /^(.*>) (\d+ [+-]\d{4})$/.exec(value);
                if (!m) { throw new Error(`commit ${oid} has an unreadable ${key} line: ${value}`); }
                if (key === 'author') { info.author = m[1]; info.authorDate = m[2]; } else { info.committer = m[1]; info.committerDate = m[2]; }
            }
        }
        return info;
    }

    /** Every blob (and submodule link) of a tree or commit, by path. */
    flatTree(treeish: string): FlatTree {
        const out = this.run(['ls-tree', '-r', '-z', '--full-tree', treeish]).stdout.toString('utf8');
        const tree: FlatTree = new Map();
        for (const record of out.split('\0')) {
            if (!record) { continue; }
            const tab = record.indexOf('\t');
            const [mode, , oid] = record.slice(0, tab).split(' ');
            tree.set(record.slice(tab + 1), { mode, oid });
        }
        return tree;
    }

    /** Store `content` as a blob and return its id. */
    blob(content: Buffer | Uint8Array): string {
        return this.text(['hash-object', '-w', '--stdin'], { input: Buffer.from(content) });
    }

    /** Write a tree from a flat map, with a temporary index, and return its id. */
    writeTree(tree: FlatTree): string {
        const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-index-')), 'index');
        try {
            const env = { GIT_INDEX_FILE: index };
            this.run(['read-tree', '--empty'], { env });
            const lines = [...tree].map(([p, e]) => `${e.mode} ${e.mode === '160000' ? 'commit' : 'blob'} ${e.oid}\t${p}`).join('\0');
            if (lines) { this.run(['update-index', '-z', '--index-info'], { env, input: lines + '\0' }); }
            return this.text(['write-tree'], { env });
        } finally {
            fs.rmSync(path.dirname(index), { recursive: true, force: true });
        }
    }

    /**
     * Make a commit. `author` and `committer` hold the person and git's date format
     * ("<seconds> <+hhmm>"); the message is stored exactly as given.
     */
    commitTree(tree: string, parents: string[], message: string, author: { person: string, date: string }, committer: { person: string, date: string }): string {
        const parse = (person: string) => {
            const m = /^(.*) <(.*)>$/.exec(person);
            if (!m) { throw new Error(`not "Name <email>": ${person}`); }
            return { name: m[1], email: m[2] };
        };
        const a = parse(author.person), c = parse(committer.person);
        return this.text(['commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-F', '-'], {
            input: message,
            env: {
                GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: author.date,
                GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: committer.date,
            },
        });
    }

    /** `message` with the trailer added, in the trailer block git interpret-trailers keeps. */
    addTrailer(message: string, trailer: string): string {
        return this.run(['interpret-trailers', '--trailer', trailer], { input: message }).stdout.toString('utf8');
    }

    isAncestor(ancestor: string, descendant: string): boolean {
        const result = this.run(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
        if (result.status === 0) { return true; }
        if (result.status === 1) { return false; }
        throw new GitError(['merge-base', '--is-ancestor', ancestor, descendant], result.status, result.stderr);
    }

    /**
     * The tree of a merge of `ours` and `theirs` with `base` as the merge base, made without
     * touching the work tree or the index. `conflicts` lists the paths that need a person.
     */
    mergeTrees(base: string, ours: string, theirs: string): { tree: string, conflicts: string[] } {
        const result = this.run(['merge-tree', '--write-tree', '-z', '--name-only', `--merge-base=${base}`, ours, theirs], { allowFailure: true });
        if (result.status !== 0 && result.status !== 1) {
            throw new GitError(['merge-tree', '--write-tree', `--merge-base=${base}`, ours, theirs], result.status, result.stderr);
        }
        const fields = result.stdout.toString('utf8').split('\0');
        const tree = fields[0];
        const conflicts: string[] = [];
        if (result.status === 1) {
            // after the tree: the conflicted paths, each ended by NUL, then an empty field and the messages
            for (let i = 1; i < fields.length && fields[i] !== ''; i++) { conflicts.push(fields[i]); }
        }
        return { tree, conflicts };
    }

    /** Point `ref` at `oid`; with `expected`, only when it still points there (an empty string: does not exist yet). */
    updateRef(ref: string, oid: string, expected?: string) {
        this.run(['update-ref', ref, oid, ...(expected === undefined ? [] : [expected || '0'.repeat(40)])]);
    }

    /** The commits from the roots to `rev`, parents before children. */
    commitsUpTo(rev: string): string[] {
        return this.text(['rev-list', '--reverse', '--topo-order', rev]).split('\n').filter(Boolean);
    }
}

/** The current time in git's date format. */
export function gitNow(): string {
    return gitDate(Date.now());
}

/** A time in milliseconds in git's date format, in UTC. */
export function gitDate(ms: number): string {
    return `${Math.floor(ms / 1000)} +0000`;
}

/** The paths that two trees hold differently: with other content, or in only one of them. */
export function changedPaths(a: FlatTree, b: FlatTree): string[] {
    const paths = new Set([...a.keys(), ...b.keys()]);
    return [...paths].filter(p => a.get(p)?.oid !== b.get(p)?.oid).sort();
}

/**
 * The git command that compares two trees (or commits), followed by the two: each path that
 * changed, with a removed path and an added path paired as one file renamed or moved when git's
 * rename detection pairs them (-M, at git's default similarity of 50%), as git log, git show
 * and git log --follow show the history. This is the one rule for which paths are a rename:
 * the local replica's sync renames on Overleaf what it pairs (src/scm/replicaGit.ts,
 * GitReplicaStore.renames), and push-check lists a push's renames with it (src/sandbox/gitPush.ts).
 * Only removed and added paths are paired: a path that both trees hold is a change of that path.
 */
export const TREE_DIFF_ARGS = ['diff-tree', '-r', '-z', '--name-status', '-M'];

/** One path in git's answer to TREE_DIFF_ARGS; for a rename or move, `oldPath` is where the file was. */
export interface TreeChange { status: 'A' | 'M' | 'D' | 'T' | 'R'; path: string; oldPath?: string; }

/** git's answer to TREE_DIFF_ARGS, read: "<status>\0<path>\0", and "R<score>\0<old path>\0<new path>\0" for a rename. */
export function parseTreeDiff(out: string): TreeChange[] {
    const fields = out.split('\0');
    const changes: TreeChange[] = [];
    for (let i = 0; i < fields.length && fields[i] !== '';) {
        const status = fields[i++];
        const kind = status[0];
        if (kind === 'R') {
            const oldPath = fields[i++], path = fields[i++];
            changes.push({ status: 'R', path, oldPath });
        } else if (kind === 'A' || kind === 'M' || kind === 'D' || kind === 'T') {
            changes.push({ status: kind, path: fields[i++] });
        } else {
            throw new Error(`git ${TREE_DIFF_ARGS[0]} reported an unexpected status ${status} for ${fields[i]}`);
        }
    }
    return changes;
}
