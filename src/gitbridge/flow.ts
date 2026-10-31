/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
/**
 * The routine flow with Overleaf's git bridge, once the local history contains the bridge's
 * commits (connect.ts): fetch; merge the bridge's commit when Overleaf changed; push as a
 * fast-forward; and when the bridge refuses the push because the project changed after the
 * fetch, fetch, merge and push again. No commit is rewritten.
 *
 * A fetch can make a commit on the bridge: when the project changed since the bridge's newest
 * commit, the bridge makes one for its current state. A push does the same before it decides
 * whether the push is a fast-forward, which is why an edit on Overleaf between our fetch and
 * our push gets the push refused.
 */
import { GitError, Repo } from './plumbing';

/** What a check before a push says; a push goes ahead only when `ok`. */
export interface CheckAnswer { ok: boolean; message?: string; }

/**
 * A check before each push, with the bridge's commit the push starts from and the commit it
 * would push. The check of comments and tracked changes on Overleaf plugs in here.
 */
export type PrePushCheck = (repo: Repo, from: string, to: string) => Promise<CheckAnswer> | CheckAnswer;

export interface Bridge { remote: string; branch: string; head: string; }

/** The bridge's branch, from the remote's fetched refs: the bridge has exactly one (master or main). */
export function bridgeBranch(repo: Repo, remote: string): Bridge {
    const refs = repo.text(['for-each-ref', '--format=%(refname)', `refs/remotes/${remote}/`]).split('\n')
        .filter(r => r && !r.endsWith('/HEAD'));
    if (refs.length !== 1) { throw new Error(`the remote ${remote} has ${refs.length} fetched branches (${refs.join(', ') || 'none; fetch first'}); the git bridge has exactly one`); }
    const branch = refs[0].slice(`refs/remotes/${remote}/`.length);
    return { remote, branch, head: repo.mustCommit(refs[0]) };
}

export function fetchBridge(repo: Repo, remote: string): Bridge {
    repo.run(['fetch', '--quiet', remote]);
    return bridgeBranch(repo, remote);
}

export type MergeOutcome = 'up-to-date' | 'fast-forward' | 'merged';

/**
 * Bring the bridge's commit into the checked-out branch: nothing when the branch contains it,
 * a fast-forward when the branch has nothing of its own, else a merge. A conflicted merge
 * stays in progress for a person to finish, as with git merge.
 */
export function mergeBridge(repo: Repo, bridge: Bridge): MergeOutcome {
    const head = repo.mustCommit('HEAD');
    if (repo.isAncestor(bridge.head, head)) { return 'up-to-date'; }
    if (repo.isAncestor(head, bridge.head)) {
        repo.run(['merge', '--quiet', '--ff-only', bridge.head]);
        return 'fast-forward';
    }
    const result = repo.run(['merge', '--quiet', '--no-edit', '-m', `Merge the changes made on Overleaf (${bridge.head.slice(0, 7)})`, bridge.head], { allowFailure: true });
    if (result.status !== 0) {
        const conflicted = repo.text(['diff', '--name-only', '--diff-filter=U']);
        throw new GitError(['merge', bridge.head], result.status,
                           `${result.stderr}${conflicted ? `\nconflicts in: ${conflicted.split('\n').join(', ')}. Finish the merge and run this again.` : ''}`);
    }
    return 'merged';
}

export interface PushReport {
    pushed: boolean;
    /** the commit the bridge's branch holds afterwards */
    head: string;
    attempts: Array<{ fetched: string, merge: MergeOutcome, refused?: string }>;
}

const REFUSED = /\[rejected\]|non-fast-forward|fetch first|failed to push some refs/;

/** The flow: fetch, merge, check, push; again from the fetch when the bridge refuses the push. */
export async function pushToBridge(repo: Repo, remote: string, options: { check?: PrePushCheck, attempts?: number, log?: (m: string) => void } = {}): Promise<PushReport> {
    const log = options.log ?? (() => {});
    const attempts: PushReport['attempts'] = [];
    for (let n = 1; n <= (options.attempts ?? 3); n++) {
        const bridge = fetchBridge(repo, remote);
        const merge = mergeBridge(repo, bridge);
        attempts.push({ fetched: bridge.head, merge });
        log(`fetched ${bridge.branch} at ${bridge.head.slice(0, 7)}; ${merge}`);
        const head = repo.mustCommit('HEAD');
        if (head === bridge.head) { return { pushed: false, head, attempts }; }
        if (options.check) {
            const answer = await options.check(repo, bridge.head, head);
            if (!answer.ok) { throw new Error(`the check before the push refused it${answer.message ? `: ${answer.message}` : ''}`); }
            if (answer.message) { log(answer.message); }
        }
        const result = repo.run(['push', '--porcelain', remote, `${head}:refs/heads/${bridge.branch}`], { allowFailure: true });
        if (result.status === 0) {
            log(`pushed ${head.slice(0, 7)} to ${bridge.branch}`);
            return { pushed: true, head, attempts };
        }
        const said = `${result.stdout.toString('utf8')}\n${result.stderr}`;
        if (!REFUSED.test(said)) { throw new GitError(['push', remote], result.status, said); }
        attempts[attempts.length - 1].refused = said.split('\n').find(l => REFUSED.test(l))?.trim();
        log(`the bridge refused the push (the project changed after the fetch); fetching again`);
    }
    throw new Error(`the bridge refused the push ${options.attempts ?? 3} times; someone keeps editing the project. Try again later.`);
}

/** fetch and merge only: bring Overleaf's changes into the checked-out branch. */
export function pullFromBridge(repo: Repo, remote: string): { bridge: Bridge, merge: MergeOutcome } {
    const bridge = fetchBridge(repo, remote);
    return { bridge, merge: mergeBridge(repo, bridge) };
}

/** A check that runs a command: it gets BRIDGE_FROM, BRIDGE_TO and BRIDGE_REPO, and refuses the push by exiting with a non-zero status. */
export function commandCheck(command: string): PrePushCheck {
    return (repo, from, to) => {
        const { spawnSync } = require('child_process') as typeof import('child_process');
        const result = spawnSync(command, { shell: true, env: { ...process.env, BRIDGE_FROM: from, BRIDGE_TO: to, BRIDGE_REPO: repo.dir }, encoding: 'utf8' });
        const message = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || undefined;
        return { ok: result.status === 0, message };
    };
}
