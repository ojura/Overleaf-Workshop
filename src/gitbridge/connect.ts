/**
 * The one-time connection of a local history with the history that Overleaf's git bridge
 * gives a project, for a local history that started from a copy of the project's files and
 * so has no commit in common with the bridge's. After it, the local branch contains the
 * bridge's newest commit, and the routine flow (flow.ts) only fast-forwards and merges.
 *
 * attach:  one merge, first parent the bridge's newest commit, second parent the local
 *          history, which keeps its own root and its commit ids. Its tree is the bridge
 *          commit's, plus the repository's own files (below), so no project file changes.
 * rewrite: the local commits written again, once, so that they branch from the project's
 *          state where the local history started, with whole trees (the project's binary
 *          files included); then the merge that joins them to the bridge's newest commit.
 *          Each rewritten commit keeps its author, committer, dates and message and gets a
 *          "Rewritten-from: <old id>" trailer; a map lists old and new ids.
 *
 * The repository's own files are the paths of the local history's newest commit that the
 * bridge's newest commit lacks, except the paths the local history's first commit has: that
 * commit is the copy of the project's files the history started from, so its paths are
 * project files, and one the bridge lacks was deleted on Overleaf. They travel with the
 * commits into the project, as tests/ does for the book.
 */
import { changedPaths, CommitInfo, FlatTree, gitDate, gitNow, Repo } from './plumbing';
import { HistorySource, HistoryUpdate, treeAtVersion, versionAtTime } from './history';

export class ConnectError extends Error {
    constructor(message: string, readonly paths: string[] = []) { super(message); }
}

export interface Side { bridge: string; local: string; }

/** The paths that travel from the local history into the project, and the ones it leaves out. */
export function ownFiles(repo: Repo, side: Side, notOwn: (path: string) => boolean = () => false) {
    const bridgeTree = repo.flatTree(side.bridge);
    const localTree = repo.flatTree(side.local);
    const roots = repo.text(['rev-list', '--max-parents=0', side.local]).split('\n').filter(Boolean);
    const inRoot = new Set(roots.flatMap(root => [...repo.flatTree(root).keys()]));
    const own: string[] = [], deletedOnOverleaf: string[] = [], excluded: string[] = [];
    for (const p of localTree.keys()) {
        if (bridgeTree.has(p)) { continue; }
        if (inRoot.has(p)) { deletedOnOverleaf.push(p); }
        else if (notOwn(p)) { excluded.push(p); }
        else { own.push(p); }
    }
    return { own: own.sort(), deletedOnOverleaf: deletedOnOverleaf.sort(), excluded: excluded.sort(), bridgeTree, localTree };
}

/** The bridge's tree with the repository's own files added. */
function bridgePlusOwn(bridgeTree: FlatTree, localTree: FlatTree, own: string[]): FlatTree {
    const tree = new Map(bridgeTree);
    for (const p of own) { tree.set(p, localTree.get(p)!); }
    return tree;
}

export interface AttachResult {
    commit: string;
    tree: string;
    own: string[];
    deletedOnOverleaf: string[];
    /** paths both sides have with different content, where the bridge's version was taken */
    tookBridge: string[];
}

/**
 * attach. Paths that both sides have must be equal, since the merge takes the bridge's tree:
 * a difference means a local change that Overleaf lacks or an edit on Overleaf that the local
 * history lacks. `takeBridge` accepts the bridge's version for them.
 */
export function attach(repo: Repo, side: Side, options: { takeBridge?: boolean, notOwn?: (p: string) => boolean, message?: string } = {}): AttachResult {
    if (repo.isAncestor(side.bridge, side.local)) { throw new ConnectError('the local history already contains the bridge\'s commit; nothing to connect'); }
    const { own, deletedOnOverleaf, bridgeTree, localTree } = ownFiles(repo, side, options.notOwn);
    const differing = [...localTree.keys()].filter(p => bridgeTree.has(p) && bridgeTree.get(p)!.oid !== localTree.get(p)!.oid).sort();
    if (differing.length && !options.takeBridge) {
        throw new ConnectError(`${differing.length} files differ between the local history and the bridge's commit: a local change that Overleaf lacks, an edit on Overleaf that the local history lacks, or a bridge commit older than the project's state. Fetch first; land the local changes; or pass --take-bridge, which takes the bridge's version of each`, differing);
    }
    const tree = repo.writeTree(bridgePlusOwn(bridgeTree, localTree, own));
    const user = repo.user();
    const person = `${user.name} <${user.email}>`;
    const count = repo.commitsUpTo(side.local).length;
    const message = options.message ?? [
        'Connect the local history with the git bridge\'s history',
        '',
        `The local history (${count} commits, ending in ${side.local.slice(0, 7)}) becomes a second root.`,
        `The tree is the bridge commit ${side.bridge.slice(0, 7)}'s${own.length ? `, plus ${own.length} files of the repository's own` : ''}, so no project file changes.`,
        '',
    ].join('\n');
    const now = gitNow();
    const commit = repo.commitTree(tree, [side.bridge, side.local], message, { person, date: now }, { person, date: now });
    return { commit, tree, own, deletedOnOverleaf, tookBridge: differing };
}

/** Where a rewritten history starts. */
export type Start =
    { kind: 'commit', commit: string } |
    { kind: 'version', update: HistoryUpdate, tree: FlatTree, parent?: string, read: string[], fromZip: string[] };

/** The newest bridge commit that holds every file of the local history's first commit unchanged; undefined when none does. */
export function bridgeCommitWithStart(repo: Repo, side: Side): string | undefined {
    const roots = repo.text(['rev-list', '--max-parents=0', side.local]).split('\n').filter(Boolean);
    if (roots.length !== 1) { throw new ConnectError(`the local history has ${roots.length} first commits; rewrite needs exactly one`); }
    const rootTree = repo.flatTree(roots[0]);
    for (const c of repo.text(['rev-list', side.bridge]).split('\n').filter(Boolean)) {
        const tree = repo.flatTree(c);
        if ([...rootTree].every(([p, e]) => tree.get(p)?.oid === e.oid)) { return c; }
    }
    return undefined;
}

/**
 * The start for rewrite when no bridge commit has the local history's first state: the
 * project's whole tree at `version`, built from the history (history.ts), with the newest
 * bridge commit before that version as its parent.
 */
export async function startFromVersion(repo: Repo, side: Side, history: HistorySource, update: HistoryUpdate, log: (m: string) => void = () => {}): Promise<Start> {
    const bridgeInfo = repo.commitInfo(side.bridge);
    const head = await versionAtTime(history, Number(bridgeInfo.authorDate.split(' ')[0]));
    log(`the bridge's commit ${side.bridge.slice(0, 7)} holds the state of version ${head.toV}`);
    if (update.toV > head.toV) { throw new ConnectError(`version ${update.toV} is newer than the bridge's commit (version ${head.toV}); fetch first`); }
    const { tree, read, fromZip } = await treeAtVersion(history, repo, update.toV, head.toV, repo.flatTree(side.bridge), log);
    // the bridge dates a commit at the project's last change it holds: its author date
    const seconds = Math.floor(update.endTs / 1000);
    const older = repo.text(['rev-list', '--first-parent', side.bridge]).split('\n').filter(Boolean)
        .find(c => Number(repo.commitInfo(c).authorDate.split(' ')[0]) <= seconds);
    return { kind: 'version', update, tree, parent: older, read, fromZip };
}

export interface RewriteResult {
    start: string;
    startMade: boolean;
    /** old id to new id, in the order the commits were written */
    map: Array<[string, string]>;
    /**
     * The local commit (its old id) that holds the state of the bridge's commit, where the
     * merge joins the two histories; undefined when no local commit holds it.
     */
    joinedAt?: string;
    /** the merge that joins the histories */
    merge: string;
    /** the local commits (old ids) written on top of the merge: they came after joinedAt */
    after: string[];
    /** the newest commit of the result: the merge, or the last commit on top of it */
    commit: string;
    tree: string;
    own: string[];
}

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
 * rewrite, from `start`. The rewritten history joins the bridge's at the newest rewritten
 * commit that holds the bridge commit's state, apart from the repository's own files: the
 * merge there changes no project file, and the local commits made after that one are
 * written on top of the merge, as the commits the bridge lacks. When no rewritten commit
 * holds that state, because Overleaf has edits the local history lacks, the merge is a
 * three-way merge of the bridge's commit and the last rewritten one, with the start as the
 * base: the edits made on Overleaf come from the bridge's side, the local changes from the
 * other, and the landed ones are on both sides alike.
 */
export function rewrite(repo: Repo, side: Side, start: Start, options: { message?: string } = {}): RewriteResult {
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
            'the state the local history started from. The git bridge has no commit for it,',
            `because nobody fetched then; this commit was made from the history: ${start.read.length} documents`,
            `read at that version${start.fromZip.length ? `, ${start.fromZip.length} files from its zip` : ''}, every other file as in the bridge's commit.`,
            '',
        ].join('\n');
        s = repo.commitTree(repo.writeTree(start.tree), start.parent ? [start.parent] : [], message, { person, date: when }, { person, date: when });
    }
    const trees = new Map<string, FlatTree>([[s, repo.flatTree(s)]]);
    /** write the local commits `commits` again, with `parentOf` for the new id of each old parent */
    const write = (commits: string[], parentOf: (old: string) => string, map: Map<string, string>) => {
        for (const c of commits) {
            const info = repo.commitInfo(c);
            const parents = info.parents.length ? info.parents.map(parentOf) : [s];
            const tree = rewrittenTree(repo, info, trees.get(parents[0])!);
            const oid = repo.commitTree(repo.writeTree(tree), parents, repo.addTrailer(info.message, `Rewritten-from: ${c}`),
                                        { person: info.author, date: info.authorDate }, { person: info.committer, date: info.committerDate });
            map.set(c, oid);
            trees.set(oid, tree);
        }
    };
    const order = repo.commitsUpTo(side.local);
    const first = new Map<string, string>();
    write(order, p => first.get(p)!, first);

    const { own, bridgeTree } = ownFiles(repo, side);
    const roots = new Set(repo.text(['rev-list', '--max-parents=0', side.local]).split('\n').filter(Boolean).flatMap(r => [...repo.flatTree(r).keys()]));
    /** whether a tree holds the bridge commit's state: the same project files, plus any files of the repository's own */
    const holdsBridgeState = (tree: FlatTree) => {
        for (const [p, e] of tree) { if (bridgeTree.get(p)?.oid !== e.oid && (bridgeTree.has(p) || roots.has(p))) { return false; } }
        for (const p of bridgeTree.keys()) { if (!tree.has(p)) { return false; } }
        return true;
    };
    const joinedAt = [...order].reverse().find(c => holdsBridgeState(trees.get(first.get(c)!)!));
    const now = gitNow();
    const intro = `The local history, rewritten to branch from ${s.slice(0, 7)}${start.kind === 'version' ? ` (Overleaf's state at history version ${start.update.toV})` : ''},`;
    if (joinedAt === undefined) {
        const last = first.get(side.local)!;
        const merged = repo.mergeTrees(s, side.bridge, last);
        if (merged.conflicts.length) {
            throw new ConnectError(`no rewritten commit holds the state of the bridge's commit, and the three-way merge from the start conflicts in ${merged.conflicts.length} files`, merged.conflicts);
        }
        const message = options.message ?? ['Connect the local history with the git bridge\'s history', '', intro,
            `ends in ${last.slice(0, 7)}. No rewritten commit holds the state of the bridge's commit ${side.bridge.slice(0, 7)},`,
            'so this merge joins the two with the start as the merge base.', ''].join('\n');
        const merge = repo.commitTree(merged.tree, [side.bridge, last], message, { person, date: now }, { person, date: now });
        return { start: s, startMade: start.kind === 'version', map: [...first], merge, after: [], commit: merge, tree: merged.tree, own };
    }
    const joined = first.get(joinedAt)!;
    const after = order.filter(c => c !== joinedAt && !repo.isAncestor(c, joinedAt));
    const mergeTree = new Map(bridgeTree);
    for (const [p, e] of trees.get(joined)!) { if (!bridgeTree.has(p) && !roots.has(p)) { mergeTree.set(p, e); } }
    const message = options.message ?? ['Connect the local history with the git bridge\'s history', '', intro,
        `holds the state of the bridge's commit ${side.bridge.slice(0, 7)} at ${joined.slice(0, 7)} (rewritten from ${joinedAt.slice(0, 7)}).`,
        `This merge joins the two there and changes no project file.${after.length ? ` The ${after.length} local commit${after.length > 1 ? 's' : ''} after it follow${after.length > 1 ? '' : 's'}, on top of this merge.` : ''}`, ''].join('\n');
    const mergeTreeId = repo.writeTree(mergeTree);
    const merge = repo.commitTree(mergeTreeId, [side.bridge, joined], message, { person, date: now }, { person, date: now });
    trees.set(merge, mergeTree);
    const second = new Map<string, string>();
    write(after, p => p === joinedAt ? merge : (second.get(p) ?? first.get(p)!), second);
    const map = order.map(c => [c, second.get(c) ?? first.get(c)!] as [string, string]);
    const commit = after.length ? second.get(side.local)! : merge;
    return { start: s, startMade: start.kind === 'version', map, joinedAt, merge, after, commit, tree: repo.text(['rev-parse', `${commit}^{tree}`]), own };
}

/**
 * Whether a connection's tree is the bridge's tree plus the repository's own files, and the
 * paths where it is not. It is when every local change has landed on Overleaf.
 */
export function checkResult(repo: Repo, side: Side, result: string) {
    const { own, bridgeTree, localTree } = ownFiles(repo, side);
    const expected = bridgePlusOwn(bridgeTree, localTree, own);
    const differing = changedPaths(expected, repo.flatTree(result));
    return { equal: differing.length === 0, differing, own };
}
