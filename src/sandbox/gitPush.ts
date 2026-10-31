/**
 * A pending push in a clone of a project from Overleaf's git bridge: the files that the
 * commits from `from` to `to` add, change, delete, rename or move. It only reads the
 * clone and runs no fetch, because a fetch makes a commit of the project's current state
 * on Overleaf.
 */
import { execFileSync } from 'child_process';
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

/** The files the commits from `from` to `to` change, with their content at both ends. */
export function pushedFiles(repo: string, from: string, to: string): PushedFile[] {
    const out = git(repo, ['diff', '--name-status', '-z', '--find-renames', from, to]).toString('utf8');
    const fields = out.split('\0').filter((field, i, all) => i < all.length - 1 || field !== '');
    const blob = (rev: string, path: string) => new Uint8Array(git(repo, ['cat-file', 'blob', `${rev}:${path}`]));
    const files: PushedFile[] = [];
    for (let i = 0; i < fields.length;) {
        const status = fields[i++];
        const kind = status[0];
        if (kind === 'R' || kind === 'C') {
            const oldPath = fields[i++], path = fields[i++];
            if (kind === 'C') { files.push({ status: 'A', path, after: blob(to, path) }); continue; }
            files.push({ status: 'R', path, oldPath, before: blob(from, oldPath), after: blob(to, path) });
        } else {
            const path = fields[i++];
            if (kind === 'A') { files.push({ status: 'A', path, after: blob(to, path) }); }
            else if (kind === 'D') { files.push({ status: 'D', path, before: blob(from, path) }); }
            else if (kind === 'M' || kind === 'T') { files.push({ status: 'M', path, before: blob(from, path), after: blob(to, path) }); }
            else { throw new Error(`git diff reported an unexpected status ${status} for ${path}`); }
        }
    }
    return files;
}
