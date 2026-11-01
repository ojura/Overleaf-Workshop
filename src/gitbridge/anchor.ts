/**
 * The git bridge's commits in a local replica's repository (docs/replica-workflows.md, "Bridge
 * fetch"). The replica records Overleaf's states as commits of its own; the bridge makes
 * commits for the same states with other ids, because their committer date is the moment of
 * the bridge's sync. A bridge commit and a commit of the replica's for the same state are found
 * by their files, and an anchor merge joins the two lines: its parents are the checked-out
 * commit and the bridge's commit, its tree the checked-out commit's, unchanged. Nothing is
 * rewritten, and from then on the bridge's commit is in the branch's history, so a push
 * through the bridge is a fast-forward.
 *
 * A bridge commit without such a twin holds a state between two that the replica recorded (an
 * edit the replica took in together with a later one). It is older than the replica's newest
 * recorded state when its author date (the time of the last change it holds) is no later than
 * that state's: Overleaf's history is a line, so the recorded state contains its changes, and
 * the anchor merge joins it the same way. A bridge commit newer than the replica's state has
 * changes the replica has not seen yet; it waits until the replica has synced.
 */
import { OVERLEAF_REF } from '../scm/replicaGit';
import { CommitInfo, FlatTree, gitNow, Repo } from './plumbing';

export interface AnchorResult {
    /** the bridge's commit */
    bridge: string;
    /**
     * up-to-date  the branch contains the bridge's commit
     * anchored    an anchor merge joined it; `commit` is the new checked-out commit
     * newer       the bridge's commit has changes the replica has not recorded; nothing changed
     * diverged    the checked-out commit does not contain the replica's recorded state; nothing changed
     */
    outcome: 'up-to-date' | 'anchored' | 'newer' | 'diverged';
    commit?: string;
    /** the replica's commit with the bridge commit's files, when there is one */
    twin?: string;
}

function sameFiles(a: FlatTree, b: FlatTree): boolean {
    if (a.size !== b.size) { return false; }
    for (const [p, e] of a) { if (b.get(p)?.oid !== e.oid) { return false; } }
    return true;
}

const seconds = (info: CommitInfo) => Number(info.authorDate.split(' ')[0]);

/**
 * Join the bridge's commit `bridgeRef` with the checked-out branch of the replica's repository.
 * `isProjectFile` tells Overleaf's files from the repository's own (the replica's ignore
 * patterns), so that files only one side has do not hide a twin.
 */
export function anchorBridge(repo: Repo, bridgeRef: string, isProjectFile: (path: string) => boolean, options: { log?: (message: string) => void, searchLimit?: number } = {}): AnchorResult {
    const log = options.log ?? (() => {});
    const bridge = repo.mustCommit(bridgeRef);
    const head = repo.mustCommit('HEAD');
    if (repo.isAncestor(bridge, head)) { return { bridge, outcome: 'up-to-date' }; }
    const overleaf = repo.commit(OVERLEAF_REF);
    if (overleaf && !repo.isAncestor(overleaf, head)) {
        log(`the checked-out commit ${head.slice(0, 7)} does not contain the replica's recorded state ${overleaf.slice(0, 7)}; merge it first`);
        return { bridge, outcome: 'diverged' };
    }
    const project = (rev: string): FlatTree => new Map([...repo.flatTree(rev)].filter(([p]) => isProjectFile(p)));
    const bridgeFiles = project(bridge);
    const candidates = repo.text(['rev-list', `--max-count=${options.searchLimit ?? 2000}`, head]).split('\n').filter(Boolean);
    const twin = candidates.find(c => sameFiles(project(c), bridgeFiles));
    const bridgeInfo = repo.commitInfo(bridge);
    if (!twin) {
        const newest = overleaf ? repo.commitInfo(overleaf) : undefined;
        if (!newest || seconds(bridgeInfo) > seconds(newest)) {
            log(`the bridge's commit ${bridge.slice(0, 7)} has changes the replica has not recorded yet; let the replica sync, then fetch again`);
            return { bridge, outcome: 'newer' };
        }
    }
    const user = repo.user();
    const person = `${user.name} <${user.email}>`;
    const now = gitNow();
    const message = [
        `Join the git bridge's commit ${bridge.slice(0, 7)}`,
        '',
        twin
            ? `It holds the files of ${twin.slice(0, 7)}, which the replica recorded, so the tree stays as it is.`
            : `It holds a state from before the replica's recorded state ${overleaf!.slice(0, 7)}, which contains its changes, so the tree stays as it is.`,
        '',
    ].join('\n');
    const anchor = repo.commitTree(repo.commitInfo(head).tree, [head, bridge], message, { person, date: now }, { person, date: now });
    const branch = repo.run(['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true }).stdout.toString('utf8').trim();
    repo.run(['update-ref', ...(branch ? [] : ['--no-deref']), '-m', `bridge: join ${bridge.slice(0, 7)}`, branch || 'HEAD', anchor, head]);
    log(`joined the bridge's commit ${bridge.slice(0, 7)}${twin ? ` (the files of ${twin.slice(0, 7)})` : ''}: ${anchor.slice(0, 7)}`);
    return { bridge, outcome: 'anchored', commit: anchor, twin };
}
