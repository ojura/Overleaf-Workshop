/**
 * Connecting a development history with a local replica's repository (replica-connect): the
 * history's commits are written again on top of the project's state where the history started,
 * and merged with Overleaf's state as the replica recorded it (refs/remotes/overleaf/main), with
 * the rebase and merge of src/gitbridge/connect.ts. It works from the project's history and the
 * two repositories. The result goes to refs/connect/merge, a commit that
 * descends from the replica's checked-out commit; replica-land then lands it, which uploads the
 * files the history adds to the project (its tests, say).
 *
 * The development repository is only read (git fetch from it). Running the connection again
 * makes the same rebased commits from the same input; once the replica's branch contains the
 * connection, it says so and does nothing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ConnectError, merge, MergeResult, overleafCommitWithStart, rebase, RebaseResult, Start, startFromVersion } from '../gitbridge/connect';
import { filesMatchVersion, findStartVersion, HistorySource, updateForVersion } from '../gitbridge/history';
import { Repo } from '../gitbridge/plumbing';

/** Overleaf's states in a replica's repository (src/scm/replicaGit.ts). */
const OVERLEAF_REF = 'refs/remotes/overleaf/main';
export const CONNECT_REF = 'refs/connect/merge';
const LOCAL_REF = 'refs/connect/local';
const START_REF = 'refs/connect/start';

export interface ConnectOptions {
    /** the development repository, a path or URL git can fetch from */
    historyRepo: string;
    /** its branch or commit to connect, e.g. master */
    ref: string;
    history: HistorySource;
    /** the history version the development history started from; found from its first commit by default */
    startVersion?: number;
    /** files of the development history that stay out of the project */
    notOwn?: (path: string) => boolean;
    log?: (message: string) => void;
}

export interface ConnectResult {
    /** the development history's newest commit */
    local: string;
    /** when the replica's branch already contains the connection: the rewritten commit of `local` */
    already?: string;
    rebase?: RebaseResult;
    merge?: MergeResult;
    /** the map of old and new ids */
    mapFile?: string;
}

export async function connectReplica(repo: Repo, options: ConnectOptions): Promise<ConnectResult> {
    const log = options.log ?? (() => {});
    const overleaf = repo.commit(OVERLEAF_REF);
    const head = repo.commit('HEAD');
    if (!overleaf) { throw new ConnectError(`the replica has not recorded Overleaf's state (${OVERLEAF_REF}); open it in the IDE and let it sync first`); }
    if (head !== overleaf) {
        throw new ConnectError(`Overleaf's state (${overleaf.slice(0, 7)}) is not the replica's checked-out commit (${head?.slice(0, 7) ?? 'none'}); sync the replica first (replica-sync)`);
    }
    repo.run(['fetch', '--quiet', '--no-tags', options.historyRepo, `+${options.ref}:${LOCAL_REF}`]);
    const local = repo.mustCommit(LOCAL_REF);
    const already = repo.text(['log', '--format=%H', '--fixed-strings', `--grep=Rewritten-from: ${local}`, 'HEAD']).split('\n')[0];
    if (already) {
        log(`the replica's branch already contains ${local.slice(0, 7)}, rewritten as ${already.slice(0, 7)}`);
        return { local, already };
    }
    const side = { overleaf, local };
    let start: Start;
    const existing = options.startVersion === undefined ? overleafCommitWithStart(repo, side) : undefined;
    if (existing) {
        log(`the recorded state ${existing.slice(0, 7)} has the development history's first files; the rebase starts from it`);
        start = { kind: 'commit', commit: existing };
    } else {
        const roots = repo.text(['rev-list', '--max-parents=0', local]).split('\n').filter(Boolean);
        if (roots.length !== 1) { throw new ConnectError(`the development history has ${roots.length} first commits; connecting needs exactly one`); }
        const files = new Map([...repo.flatTree(roots[0])].map(([p, e]) => [p, repo.run(['cat-file', 'blob', e.oid]).stdout]));
        let update;
        if (options.startVersion !== undefined) {
            update = await updateForVersion(options.history, options.startVersion);
            const { match, differing } = await filesMatchVersion(options.history, options.startVersion, files, log);
            if (!match) { throw new ConnectError(`the development history's first commit differs from the project at version ${options.startVersion}`, differing); }
        } else {
            const seconds = Number(repo.commitInfo(roots[0]).committerDate.split(' ')[0]);
            update = await findStartVersion(options.history, files, seconds, log);
        }
        log(`the development history started from version ${update.toV} (${new Date(update.endTs).toISOString()})`);
        start = await startFromVersion(repo, side, options.history, update, log);
    }
    const rebased = rebase(repo, local, start);
    const mapFile = path.join(repo.gitDir(), 'overleaf', 'connect-map.txt');
    fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    fs.writeFileSync(mapFile, rebased.map.map(([o, n]) => `${o} ${n}`).join('\n') + '\n');
    repo.updateRef(START_REF, rebased.start);
    const merged = merge(repo, { overleaf, local: rebased.commit }, {
        start: rebased.start,
        notOwn: options.notOwn,
        message: [
            `Connect the development history (${rebased.map.length} commits, ${options.ref} at ${local.slice(0, 7)})`,
            '',
            `Its commits were written again on top of the project's state where it started (${rebased.start.slice(0, 7)}),`,
            `each with a Rewritten-from trailer; this merge joins them with Overleaf's state ${overleaf.slice(0, 7)}.`,
            '',
        ].join('\n'),
    });
    repo.updateRef(CONNECT_REF, merged.commit);
    return { local, rebase: rebased, merge: merged, mapFile };
}
