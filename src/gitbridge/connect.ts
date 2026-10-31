/**
 * Connecting a local history with Overleaf's history of a project, for a local history that
 * started from a copy of the project's files and so has no commit in common with it. Overleaf's
 * side is a commit with Overleaf's state and its ancestors (`Side.overleaf`): the git bridge's
 * newest commit for the git-bridge tools (cli.ts), or the state a local replica recorded for
 * replica-connect (src/scm/replicaConnect.ts). Two steps, in this order:
 *
 * rebase (optional, once): the local commits written again so that they branch from the
 *          project's state where the local history started, with whole trees (the project's
 *          binary files included). The start is a commit of Overleaf's side with that state
 *          when there is one; otherwise a commit made from the project's history at that
 *          version. Each rewritten commit keeps its author, committer, dates and message and
 *          gets a "Rewritten-from: <old id>" trailer; a map lists old and new ids.
 * merge (always): one merge, first parent Overleaf's commit, second the local history's
 *          newest commit, so that the local branch contains Overleaf's commit and a push
 *          through the git bridge, or a landing in the replica, is a fast-forward. Without the
 *          rebase the local history keeps its own root and its commit ids, and the result has
 *          two roots.
 *
 * After them, the routine flow only fast-forwards and merges.
 *
 * The repository's own files are the paths of the local history's newest commit that
 * Overleaf's commit lacks, except the paths the local history's first commit has: that commit
 * is the copy of the project's files the history started from, so its paths are project files,
 * and one that Overleaf's commit lacks was deleted on Overleaf. They travel with the commits
 * into the project, as tests/ does for the book.
 */
import { changedPaths, CommitInfo, FlatTree, gitDate, gitNow, Repo } from './plumbing';
import { HistorySource, HistoryUpdate, treeAtVersion, versionAtTime } from './history';

export class ConnectError extends Error {
    constructor(message: string, readonly paths: string[] = []) { super(message); }
}

/** Overleaf's commit (the git bridge's, or a replica's recorded state) and the local history's newest commit. */
export interface Side { overleaf: string; local: string; }

/**
 * The commits with the project's state the local history started from as their tree: `start`
 * when given (after a rebase, the commit the local history branches from), otherwise the
 * local history's first commits.
 */
function startCommits(repo: Repo, local: string, start?: string): string[] {
    return start ? [start] : repo.text(['rev-list', '--max-parents=0', local]).split('\n').filter(Boolean);
}

/** The paths that travel from the local history into the project, and the ones it leaves out. */
export function ownFiles(repo: Repo, side: Side, notOwn: (path: string) => boolean = () => false, start?: string) {
    const overleafTree = repo.flatTree(side.overleaf);
    const localTree = repo.flatTree(side.local);
    const roots = startCommits(repo, side.local, start);
    const inRoot = new Set(roots.flatMap(root => [...repo.flatTree(root).keys()]));
    const own: string[] = [], deletedOnOverleaf: string[] = [], excluded: string[] = [];
    for (const p of localTree.keys()) {
        if (overleafTree.has(p)) { continue; }
        if (inRoot.has(p)) { deletedOnOverleaf.push(p); }
        else if (notOwn(p)) { excluded.push(p); }
        else { own.push(p); }
    }
    return { own: own.sort(), deletedOnOverleaf: deletedOnOverleaf.sort(), excluded: excluded.sort(), overleafTree, localTree };
}

/** Overleaf's tree with the repository's own files added. */
function overleafPlusOwn(overleafTree: FlatTree, localTree: FlatTree, own: string[]): FlatTree {
    const tree = new Map(overleafTree);
    for (const p of own) { tree.set(p, localTree.get(p)!); }
    return tree;
}

/** Where a rewritten history starts. */
export type Start =
    { kind: 'commit', commit: string } |
    { kind: 'version', update: HistoryUpdate, tree: FlatTree, parent?: string, read: string[], fromZip: string[] };

/** The newest commit of Overleaf's side that holds every file of the local history's first commit unchanged; undefined when none does. */
export function overleafCommitWithStart(repo: Repo, side: Side): string | undefined {
    const roots = repo.text(['rev-list', '--max-parents=0', side.local]).split('\n').filter(Boolean);
    if (roots.length !== 1) { throw new ConnectError(`the local history has ${roots.length} first commits; rewrite needs exactly one`); }
    const rootTree = repo.flatTree(roots[0]);
    for (const c of repo.text(['rev-list', side.overleaf]).split('\n').filter(Boolean)) {
        const tree = repo.flatTree(c);
        if ([...rootTree].every(([p, e]) => tree.get(p)?.oid === e.oid)) { return c; }
    }
    return undefined;
}

/**
 * The start for rewrite when no commit of Overleaf's side has the local history's first
 * state: the project's whole tree at `version`, built from the history (history.ts), with the
 * newest commit of Overleaf's side before that version as its parent.
 */
export async function startFromVersion(repo: Repo, side: Side, history: HistorySource, update: HistoryUpdate, log: (m: string) => void = () => {}): Promise<Start> {
    const overleafInfo = repo.commitInfo(side.overleaf);
    const head = await versionAtTime(history, Number(overleafInfo.authorDate.split(' ')[0]));
    log(`${side.overleaf.slice(0, 7)} holds the state of version ${head.toV}`);
    if (update.toV > head.toV) { throw new ConnectError(`version ${update.toV} is newer than Overleaf's state in ${side.overleaf.slice(0, 7)} (version ${head.toV}); fetch or sync first`); }
    const { tree, read, fromZip } = await treeAtVersion(history, repo, update.toV, head.toV, repo.flatTree(side.overleaf), log);
    // a commit of Overleaf's side is dated at the project's last change it holds: its author date
    const seconds = Math.floor(update.endTs / 1000);
    const older = repo.text(['rev-list', '--first-parent', side.overleaf]).split('\n').filter(Boolean)
        .find(c => Number(repo.commitInfo(c).authorDate.split(' ')[0]) <= seconds);
    return { kind: 'version', update, tree, parent: older, read, fromZip };
}

export interface RebaseResult {
    /** the commit the rebased history branches from */
    start: string;
    /** whether the start was made from the project's history (no commit of Overleaf's side had that state) */
    startMade: boolean;
    /** old id to new id, in the order the commits were written */
    map: Array<[string, string]>;
    /** the rebased history's newest commit */
    commit: string;
}

/** The local commit's tree, made on `base`: the paths it changed against its first parent, applied to `base`. */
function rewrittenTree(repo: Repo, info: CommitInfo, base: FlatTree): FlatTree {
    const oldBase = info.parents.length ? repo.flatTree(info.parents[0]) : new Map();
    const now = repo.flatTree(info.oid);
    const tree = new Map(base);
    for (const p of changedPaths(oldBase, now)) {
        const entry = now.get(p);
        if (entry) { tree.set(p, entry); } else { tree.delete(p); }
    }
    return tree;
}

/**
 * rebase, from `start`: the local history up to `local` written again on top of it, with
 * whole trees. It gives the same ids when it runs again on the same input.
 */
export function rebase(repo: Repo, local: string, start: Start): RebaseResult {
    const user = repo.user();
    const person = `${user.name} <${user.email}>`;
    let s: string;
    if (start.kind === 'commit') {
        s = start.commit;
    } else {
        const when = gitDate(start.update.endTs);
        const message = [
            `Overleaf's state at history version ${start.update.toV}`,
            '',
            `The project's files at version ${start.update.toV} of its history (${new Date(start.update.endTs).toISOString()}),`,
            'the state the local history started from. No commit of Overleaf\'s states had it, so this',
            `commit was made from the history: ${start.read.length} documents read at that version,`,
            ...(start.fromZip.length ? [`${start.fromZip.length} files from the version's zip,`] : []),
            'and every other file as in the newest state, which the history shows unchanged since.',
            '',
        ].join('\n');
        s = repo.commitTree(repo.writeTree(start.tree), start.parent ? [start.parent] : [], message, { person, date: when }, { person, date: when });
    }
    const trees = new Map<string, FlatTree>([[s, repo.flatTree(s)]]);
    const map = new Map<string, string>();
    for (const c of repo.commitsUpTo(local)) {
        const info = repo.commitInfo(c);
        const parents = info.parents.length ? info.parents.map(p => map.get(p)!) : [s];
        const tree = rewrittenTree(repo, info, trees.get(parents[0])!);
        const oid = repo.commitTree(repo.writeTree(tree), parents, repo.addTrailer(info.message, `Rewritten-from: ${c}`),
                                    { person: info.author, date: info.authorDate }, { person: info.committer, date: info.committerDate });
        map.set(c, oid);
        trees.set(oid, tree);
    }
    return { start: s, startMade: start.kind === 'version', map: [...map], commit: map.get(local)! };
}

export interface MergeResult {
    /** the merge: first parent Overleaf's commit, second the local history's newest commit */
    commit: string;
    tree: string;
    /**
     * how its tree was made:
     * held          a local commit holds Overleaf's state: Overleaf's tree, with the local
     *               changes made after that commit and the repository's own files;
     * three-way     no local commit holds it, and the histories have a merge base (after a rebase);
     * took-overleaf no local commit holds it and the histories are unrelated: Overleaf's tree
     *               with the own files, where the local version of `tookOverleaf` is dropped.
     */
    how: 'held' | 'three-way' | 'took-overleaf';
    /** the newest local commit that holds Overleaf's state, for 'held' */
    heldAt?: string;
    /** the merge base, for 'three-way' */
    base?: string;
    own: string[];
    deletedOnOverleaf: string[];
    /** project files with other content in the merge than in Overleaf's commit: the local changes a push or a landing carries */
    carries: string[];
    /** paths both sides have with different content, where Overleaf's version was taken */
    tookOverleaf: string[];
}

/**
 * Whether a local tree holds Overleaf's state: every path is one of the repository's own
 * files, equal to Overleaf's, or one that Overleaf deleted and the local history left as
 * it was in the state it started from (`startTrees`).
 */
function holdsOverleafState(tree: FlatTree, overleafTree: FlatTree, own: Set<string>, startTrees: FlatTree[]): boolean {
    for (const [p, e] of tree) {
        if (own.has(p)) { continue; }
        const b = overleafTree.get(p);
        if (b) { if (b.oid !== e.oid) { return false; } continue; }
        if (!startTrees.some(s => s.get(p)?.oid === e.oid)) { return false; }
    }
    return true;
}

/**
 * merge: join the local history up to `side.local` with Overleaf's commit `side.overleaf`.
 *
 * When a local commit holds Overleaf's state (the newest such commit: everything Overleaf's
 * commit has, the local history had then), the merge's tree is Overleaf's, with the changes
 * of the later local commits and the repository's own files: no Overleaf edit is lost, and the
 * files the local history never had (the images of a history of text files) stay as they are.
 * Otherwise, with a merge base (`start`, or git's), a three-way merge; and for unrelated
 * histories, only with `takeOverleaf`, which takes Overleaf's version where the two differ.
 *
 * `start`, after a rebase, is the commit the rebased history branches from: its tree is the
 * project's state the local history started from, so it tells the project's files from the
 * repository's own, and it is the base of a three-way merge.
 */
export function merge(repo: Repo, side: Side, options: { takeOverleaf?: boolean, notOwn?: (p: string) => boolean, start?: string, message?: string } = {}): MergeResult {
    if (repo.isAncestor(side.overleaf, side.local)) { throw new ConnectError('the local history already contains Overleaf\'s commit; nothing to merge'); }
    const { own, deletedOnOverleaf, overleafTree, localTree } = ownFiles(repo, side, options.notOwn, options.start);
    const ownSet = new Set(own);
    const startTrees = startCommits(repo, side.local, options.start).map(c => repo.flatTree(c));
    const user = repo.user();
    const person = `${user.name} <${user.email}>`;
    const now = gitNow();
    const count = repo.commitsUpTo(side.local).length;
    const finish = (tree: FlatTree, how: MergeResult['how'], text: string[], extra: Partial<MergeResult>): MergeResult => {
        const treeId = repo.writeTree(tree);
        const message = options.message ?? ['Merge Overleaf\'s state into the local history', '', ...text, ''].join('\n');
        const commit = repo.commitTree(treeId, [side.overleaf, side.local], message, { person, date: now }, { person, date: now });
        const carries = changedPaths(overleafTree, tree).filter(p => !ownSet.has(p));
        return { commit, tree: treeId, how, own, deletedOnOverleaf, carries, tookOverleaf: [], ...extra };
    };

    const candidates = repo.text(['rev-list', '--topo-order', side.local]).split('\n').filter(Boolean);
    const heldAt = candidates.find(c => holdsOverleafState(repo.flatTree(c), overleafTree, ownSet, startTrees));
    if (heldAt) {
        const heldTree = repo.flatTree(heldAt);
        const changed = changedPaths(heldTree, localTree);
        // a file Overleaf deleted, which the local history then changed: a change against a deletion
        const againstDeletion = changed.filter(p => heldTree.has(p) && !overleafTree.has(p) && !ownSet.has(p));
        if (againstDeletion.length) {
            throw new ConnectError(`${againstDeletion.length} files were deleted on Overleaf and changed in the local history afterwards; decide which stays, then merge again`, againstDeletion);
        }
        const tree = new Map(overleafTree);
        for (const p of changed) {
            const entry = localTree.get(p);
            if (entry) { tree.set(p, entry); } else { tree.delete(p); }
        }
        for (const p of own) { tree.set(p, localTree.get(p)!); }
        const later = heldAt === side.local ? 0 : repo.commitsUpTo(side.local).length - repo.commitsUpTo(heldAt).length;
        return finish(tree, 'held', [
            `The local history (${count} commits, ending in ${side.local.slice(0, 7)}) holds Overleaf's state in`,
            `${side.overleaf.slice(0, 7)} at ${heldAt.slice(0, 7)}. The tree is Overleaf's${later ? `, with the changes of the ${later} later local commits` : ''}${own.length ? `, and ${own.length} files of the repository's own` : ''}.`,
        ], { heldAt });
    }

    const base = options.start ?? (repo.run(['merge-base', side.overleaf, side.local], { allowFailure: true }).stdout.toString('utf8').trim() || undefined);
    if (base) {
        const merged = repo.mergeTrees(base, side.overleaf, side.local);
        if (merged.conflicts.length) {
            throw new ConnectError(`no local commit holds Overleaf's state in ${side.overleaf.slice(0, 7)}, and the three-way merge from ${base.slice(0, 7)} conflicts in ${merged.conflicts.length} files`, merged.conflicts);
        }
        return finish(repo.flatTree(merged.tree), 'three-way', [
            `No commit of the local history (${count} commits, ending in ${side.local.slice(0, 7)}) holds Overleaf's state`,
            `in ${side.overleaf.slice(0, 7)}, so this is a three-way merge from ${base.slice(0, 7)}.`,
        ], { base });
    }

    const differing = [...localTree.keys()].filter(p => overleafTree.has(p) && overleafTree.get(p)!.oid !== localTree.get(p)!.oid).sort();
    if (!options.takeOverleaf) {
        throw new ConnectError(`no local commit holds Overleaf's state in ${side.overleaf.slice(0, 7)}, and the histories are unrelated; ${differing.length} files differ: a local change that Overleaf lacks, an edit on Overleaf that the local history lacks, or a recorded state older than the project's. Fetch first; land the local changes; rebase; or take Overleaf's version of each (merge --take-bridge of the git-bridge tools)`, differing);
    }
    return finish(overleafPlusOwn(overleafTree, localTree, own), 'took-overleaf', [
        `The local history (${count} commits, ending in ${side.local.slice(0, 7)}) becomes a second root. The tree is`,
        `${side.overleaf.slice(0, 7)}'s${own.length ? `, plus ${own.length} files of the repository's own` : ''}; Overleaf's version was taken for ${differing.length} files.`,
    ], { tookOverleaf: differing });
}

/**
 * Whether a connection's tree is Overleaf's tree plus the repository's own files, and the
 * paths where it is not. It is when every local change has landed on Overleaf.
 */
export function checkResult(repo: Repo, side: Side, result: string, start?: string) {
    const { own, overleafTree, localTree } = ownFiles(repo, side, undefined, start);
    const expected = overleafPlusOwn(overleafTree, localTree, own);
    const differing = changedPaths(expected, repo.flatTree(result));
    return { equal: differing.length === 0, differing, own };
}
