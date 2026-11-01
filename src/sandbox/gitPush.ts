/**
 * A pending push in a clone of a project from Overleaf's git bridge: the files that the
 * commits from `from` to `to` add, change, delete, rename or move. It only reads the
 * clone and runs no fetch, because a fetch makes a commit of the project's current state
 * on Overleaf.
 */
import { execFileSync } from 'child_process';
import { parseTreeDiff, TREE_DIFF_ARGS } from '../gitbridge/plumbing';
import { PushedFile } from './ranges';

function git(repo: string, args: string[]): Buffer {
    return execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The commit id that `rev` names in `repo`; throws when it names none. */
export function resolveCommit(repo: string, rev: string): string {
    try {
        return git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).toString().trim();
    } catch {
        throw new Error(`${rev} names no commit in ${repo}`);
    }
}

/** The project id of the clone's remote, when it is a git bridge URL such as https://git.overleaf.com/<id>. */
export function bridgeProjectId(repo: string, remote = 'origin'): string | undefined {
    let url: string;
    try { url = git(repo, ['remote', 'get-url', remote]).toString().trim(); } catch { return undefined; }
    const match = /^https?:\/\/(?:[^@/]+@)?git\.[^/]+\/([0-9a-f]{24})(?:\.git)?\/?$/.exec(url);
    return match?.[1];
}

/**
 * The files the commits from `from` to `to` change, with their content at both ends; a rename
 * or a move is the one git's rename detection pairs (TREE_DIFF_ARGS), as git log shows it.
 */
export function pushedFiles(repo: string, from: string, to: string): PushedFile[] {
    const out = git(repo, [...TREE_DIFF_ARGS, from, to]).toString('utf8');
    const blob = (rev: string, path: string) => new Uint8Array(git(repo, ['cat-file', 'blob', `${rev}:${path}`]));
    return parseTreeDiff(out).map((change): PushedFile => {
        const { path, oldPath } = change;
        switch (change.status) {
            case 'R': return { status: 'R', path, oldPath, before: blob(from, oldPath!), after: blob(to, path) };
            case 'A': return { status: 'A', path, after: blob(to, path) };
            case 'D': return { status: 'D', path, before: blob(from, path) };
            default: return { status: 'M', path, before: blob(from, path), after: blob(to, path) };
        }
    });
}
