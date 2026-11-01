import { createHash } from 'crypto';
import { errorMessage } from '../utils/errorMessage';
import { isReplicaOwnPath } from './ignorePatterns';
import { gitMergeText } from './replicaGit';

/*
 * Two-way sync between a local folder and an Overleaf project, used by the local replica.
 *
 * For every file, the engine saves on disk the content that both sides had after the file
 * was last synced: its base. Comparing each side with the base tells which side changed:
 *
 *   local     Overleaf   action
 *   base      base       nothing
 *   changed   base       upload
 *   base      changed    download
 *   changed   changed    merge the text, or keep both versions of a binary file
 *
 * Files are compared by git blob SHA-1. Overleaf reports that hash for every binary file in
 * the project tree, so a binary file that matches is never downloaded again. A local file
 * with the size and modification time recorded at the last sync is not hashed again.
 *
 * Merges are git's (git merge-file). The extension's store (replicaGit.ts) keeps the bases in
 * the replica's git repository and, once the sync has been idle for `recordQuietMs`, records
 * them as a commit of Overleaf's state; the sync tells it where each change of a base came
 * from (`SavedState.changes`). A text file with overlapping changes is unmerged in git's index
 * until the user resolves it, and is not uploaded meanwhile.
 *
 * A synced file gone from the folder and a new file in it that git pairs as one file renamed
 * or moved, as git log shows the history, are renamed or moved on Overleaf, and a change of
 * the content follows as an edit, so that a document keeps its comments, tracked changes and
 * history there. A rename or a move made on Overleaf moves the local file and its base, with
 * its local changes (docs/replica-workflows.md, "Renames and moves").
 *
 * Deletions go through one step in every kind of sync (`applyDeletions`): more than
 * `deletionThreshold` files deleted on one side and still synced on the other need the user's
 * confirmation in the window, and a tool's request does not make them.
 *
 * Every sync, and every deletion and record, first asks `mayAct` whether it may act on the folder
 * as it is now. The folder must still be the one the sync started with (`ReplicaLocal.verify`):
 * a folder moved away, or another folder at its path, is not read or written, and its files do
 * not reach Overleaf; the sync goes on once that folder is back. And git must not be in the
 * middle of an operation there (a rebase, a merge, ...), and the checked-out commit must contain
 * Overleaf's recorded state (`ReplicaStore.workTree`): otherwise the folder holds a state that git
 * is in the middle of making, or an older one, and its differences from Overleaf are not edits,
 * so the sync waits. When it may act again, a full sync catches up. Saves check the folder alone.
 *
 * Without uploads (the push mode "bridge"), local changes and deletions stay local until a push
 * through the git bridge brings them to Overleaf, and a local deletion does not count toward
 * `deletionThreshold` or ask; changes made on Overleaf still come in, merged into the local files.
 *
 * This module does not import 'vscode', so that it can be tested in plain Node.
 */

export type EntryKind = 'doc' | 'file';

/** A file in the Overleaf project. */
export interface RemoteEntry {
    kind: EntryKind,
    /** git blob SHA-1 of the content, which Overleaf reports for binary files */
    hash?: string,
}

export interface LocalStat {
    size: number,
    mtime: number,
}

/** The Overleaf side. Paths look like '/folder/name.ext'. */
export interface ReplicaRemote {
    /**
     * Why Overleaf does not answer now, e.g. while the connection is made again: the error that its
     * requests get meanwhile; undefined while it answers. While it does not answer, a file missing
     * there is not taken as deleted.
     */
    disconnected(): Error | undefined,
    /** All files of the project; rejects when Overleaf does not answer. */
    list(): Promise<Map<string, RemoteEntry>>,
    /** The file at `path` in the project tree as it is now: undefined only when the tree does not have it. */
    entry(path: string): Promise<RemoteEntry | undefined>,
    isFolder(path: string): Promise<boolean>,
    readDoc(path: string): Promise<string>,
    readFile(path: string): Promise<Uint8Array>,
    /** Replace the text of the document at `path`; resolves once Overleaf has applied it, and rejects when `path` is not a document or when Overleaf refused the update or has not confirmed it. */
    writeDoc(path: string, text: string): Promise<void>,
    /** Create `path` or replace the binary file there; returns what Overleaf made of it. */
    upload(path: string, content: Uint8Array): Promise<RemoteEntry>,
    /** Rename or move the file at `from` to `to`, keeping it the same document or file on Overleaf. */
    rename?(from: string, to: string): Promise<void>,
    remove(path: string): Promise<void>,
    removeFolderIfEmpty(path: string): Promise<void>,
    /** Resolves once the document updates sent so far are applied on the server; rejects naming the documents with an update that Overleaf has not confirmed. */
    settled(): Promise<void>,
}

/** The local folder. Paths look like '/folder/name.ext'. */
export interface ReplicaLocal {
    /** All files, without the replica's own folders and without ignored paths; rejects when a folder cannot be read. */
    list(): Promise<Map<string, LocalStat>>,
    /** undefined only when `path` does not exist; rejects when that cannot be told */
    stat(path: string): Promise<LocalStat | 'folder' | undefined>,
    /** undefined only when `path` does not exist; rejects when the file cannot be read */
    read(path: string): Promise<Uint8Array | undefined>,
    write(path: string, content: Uint8Array): Promise<LocalStat>,
    /** Move the file at `from` to `to`, where nothing may be, keeping the file itself; fails when something is at `to`. */
    move?(from: string, to: string): Promise<void>,
    remove(path: string): Promise<void>,
    removeFolderIfEmpty(path: string): Promise<void>,
    /** Rejects with a FolderChangedError when the folder is no longer the one the sync started with; cheap enough for every sync. */
    verify(): Promise<void>,
}

export interface SavedEntry {
    kind: EntryKind,
    /** git blob SHA-1 of the content both sides had after the last sync */
    base: string,
    /** size and mtime of the local file when it was last seen to hold `base`, and when that was */
    size?: number,
    mtime?: number,
    checked?: number,
    /** the local file holds conflict markers that the sync wrote */
    conflict?: boolean,
}

/**
 * Where the change of a base came from: Overleaf (downloaded, or deleted there), the local
 * folder (uploaded, renamed, or deleted there), both (merged), or the sync state kept before
 * the git backend.
 */
export type Origin = 'remote' | 'local' | 'merge' | 'import';

export interface SavedState {
    version: 1,
    entries: {[path: string]: SavedEntry},
    /** local files that were not on Overleaf at the first sync and stay local */
    untracked: string[],
    /** the paths with a base that changed since the store last recorded the state, and where each change came from */
    changes?: {[path: string]: Origin},
    /**
     * The bases are those of Overleaf's last recorded state, taken because the saved state was
     * missing: the next full sync leaves local-only files alone, as a first sync does.
     */
    restored?: boolean,
}

/** What keeps the sync from acting on the folder as git has it now (`ReplicaStore.workTree`). */
export type WorkTreeState = {operation: string} | {head: string, overleaf: string};

/** Storage for the sync state; the git store (replicaGit.ts) keeps it in the replica's repository. */
export interface ReplicaStore {
    load(): Promise<SavedState | undefined>,
    save(state: SavedState): Promise<void>,
    readBase(hash: string): Promise<string | undefined>,
    writeBase(hash: string, text: string): Promise<void>,
    /** Remove the saved base texts with a hash that is not in `keep`. */
    pruneBases(keep: Set<string>): Promise<void>,
    /** Keep a copy of a local version that the sync replaces; returns where the copy is. */
    keepCopy(path: string, content: Uint8Array): Promise<string>,
    /** Keep the content of a binary file that is now a base. */
    writeFileBase?(hash: string, content: Uint8Array): Promise<void>,
    /**
     * Record the bases as Overleaf's state, e.g. as a commit. Called when the sync is idle;
     * `waiting` in the answer: not yet (a push is uploading), keep `state.changes`.
     */
    record?(state: SavedState): Promise<{waiting?: boolean}>,
    /** A text file has overlapping changes to resolve: the base, the local and Overleaf's versions. */
    markConflict?(path: string, versions: {base: string, local: string, remote: string}): Promise<void>,
    /** Whether `path` has changes to resolve that keep it from being uploaded. */
    isUnmerged?(path: string): Promise<boolean>,
    /**
     * git's pairing of the synced files gone from the folder with the new files in it, as git
     * log shows renames and moves (docs/replica-workflows.md, "Renames and moves"): `removed`
     * maps each removed path to its base, `added` lists the new paths. Answers the removed path
     * of each new path that git pairs. Without it, every new file is uploaded as a new file.
     */
    renames?(removed: Map<string, string>, added: string[]): Promise<Map<string, string>>,
    /**
     * What keeps the sync from acting on the folder as git has it now: a git operation under way
     * there (`operation`, e.g. 'a rebase'), or a checked-out commit (`head`) that does not contain
     * Overleaf's recorded state (`overleaf`); undefined when the sync may act. A store without it
     * never makes the sync wait.
     */
    workTree?(): Promise<WorkTreeState | undefined>,
    /** The git operation under way in the folder, e.g. 'a merge', from the files that git keeps for it; undefined when none is. */
    operation?(): Promise<string | undefined>,
    /**
     * The path of git's index lock while a program other than the store holds it, as git does
     * while it writes the work tree and the index, e.g. during a checkout, which moves HEAD last;
     * undefined while nobody holds it, or the store's own index write does.
     */
    foreignIndexLock?(): Promise<string | undefined>,
    /** Resolves once the lock `file` is gone, at the event of its folder that removes it; `dispose` stops the watch before that. */
    indexLockReleased?(file: string): {released: Promise<void>, dispose(): void},
    /** When the lock `file` was last written, its modification time in ms since the epoch; undefined once it is gone. */
    indexLockTime?(file: string): Promise<number | undefined>,
}

export interface ReplicaUI {
    log(message: string): void,
    progress(done: number, total: number): void,
    /** Asked before a sync deletes more than `deletionThreshold` files on one side (`applyDeletions`). */
    confirmDeletions(where: 'local' | 'remote', paths: string[]): Promise<boolean>,
    /** Told once about each file that its conflicts keep from being uploaded. */
    conflictBlocked(path: string): void,
    /** What the sync did for changes reported by events (not for `syncAll`). */
    liveResult(summary: SyncSummary): void,
    /**
     * The checked-out commit `head` does not contain Overleaf's recorded state `overleaf`, as
     * after a checkout of an older commit: whether the user wants the folder's files put on
     * Overleaf. The sync waits meanwhile, and without this method, or without an answer, it
     * keeps waiting.
     */
    confirmCheckout?(head: string, overleaf: string): Promise<boolean>,
    /** The sync waits, and why (`reason`), or acts again after waiting (undefined). */
    waiting?(reason: string | undefined): void,
    /**
     * Another program's git index lock has been there for `ReplicaSync.staleLockMs` or longer, and
     * the sync waits for its removal; `reason` names the file. Called once for each lock that
     * stays; `gone` resolves when the wait ends, as the lock goes or the sync stops, so that the
     * window can end its notice then.
     */
    lockStays?(reason: string, gone: Promise<void>): void,
}

/**
 * A tool's request, a sync or a landing, across all of its checks (`ReplicaSync.mayAct`): it waits
 * for another program's git index lock for up to `ReplicaSync.toolLockWaitMs` in total.
 */
export interface ToolRequest {
    /** when the request's wait for the lock ends: set when its first wait starts */
    lockDeadline?: number,
}

export interface SyncSummary {
    downloaded: string[],
    uploaded: string[],
    /** renamed or moved on Overleaf as they were locally */
    renamed: {from: string, to: string}[],
    /** renamed or moved locally as they were on Overleaf */
    renamedLocally: {from: string, to: string}[],
    merged: string[],
    deletedLocal: string[],
    deletedRemote: string[],
    /** local versions that the sync replaced, and where their copies are */
    keptAside: {path: string, copy: string}[],
    /** text files that now hold conflict markers */
    conflicts: string[],
    /** local changes that wait for a push, when the sync does not upload */
    held: string[],
    /** local files that are not on Overleaf and were left alone */
    untracked: string[],
    /** deletions that the user did not confirm in the window */
    skippedDeletions: string[],
    /** deletions that a tool's request did not make: more than `deletionThreshold` on one side need the user's confirmation */
    deletionsToConfirm: Deletions[],
    /** for a tool's request: the deletions that a question open in the window asks about, which the request did not wait for */
    question?: Deletions,
    failed: {path: string, error: string}[],
    /** why the sync did not act on the folder: it waits (`ReplicaSync.waitingFor`) */
    waitingFor?: string,
    unchanged: number,
    /** files a cancelled `syncAll` did not get to */
    notChecked: number,
}

/** Deletions on one side of the sync: of local files (`local`), or of files on Overleaf (`remote`). */
export interface Deletions {
    where: 'local' | 'remote',
    paths: string[],
}

function emptySummary(): SyncSummary {
    return {
        downloaded: [], uploaded: [], renamed: [], renamedLocally: [], merged: [], deletedLocal: [], deletedRemote: [],
        keptAside: [], conflicts: [], held: [], untracked: [], skippedDeletions: [], deletionsToConfirm: [], failed: [], unchanged: 0, notChecked: 0,
    };
}

export function gitBlobHash(content: Uint8Array): string {
    return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Hash of a document's text, the same for the local file and Overleaf's copy. */
function textHash(text: string): string {
    return gitBlobHash(encoder.encode(text));
}

/**
 * Hash of local file content. A document is hashed through its decoded text: Overleaf
 * stores text, so bytes that do not survive decoding would never compare equal.
 */
function contentHash(kind: EntryKind | undefined, content: Uint8Array): string {
    return kind==='doc' ? textHash(decoder.decode(content)) : gitBlobHash(content);
}

const CONFLICT_START = /^<<<<<<< Local$/m;
const CONFLICT_END = /^>>>>>>> Remote$/m;
function hasConflictMarkers(text: string): boolean {
    return CONFLICT_START.test(text) && CONFLICT_END.test(text);
}

/**
 * How the local folder differs from the one the sync started with (`ReplicaLocal.verify`): it is
 * gone from its path, another folder is there, or its git folder or its settings file is gone.
 */
export type FolderChange = 'gone' | 'replaced' | 'gitFolderGone' | 'settingsGone';

/**
 * The local folder is not the one the sync started with (`ReplicaLocal.verify`). Every step of
 * the sync, and every deletion, record and save, stops with this error until that folder is back
 * at its path, with its git folder and its settings file.
 */
export class FolderChangedError extends Error {
    constructor(readonly reason: FolderChange, message: string) { super(message); }
}

/** A reconcile found right before a write that the sync waits (`beforeWrite`): it leaves its path to the full sync after the wait. */
class SyncWaitsError extends Error {
    constructor(readonly reason: string) { super(`the sync waits: ${reason}`); }
}

/**
 * A reconcile found right before a write that git held its index lock, or was in the middle of
 * an operation, and the sync may act again once that is over (`beforeWrite`). git may have
 * written the file since the reconcile read it, so the reconcile reads both sides again (`reported`).
 */
class StaleReadError extends Error {}

class Semaphore {
    private waiting: (() => void)[] = [];
    constructor(private available: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.available>0) {
            this.available -= 1;
        } else {
            await new Promise<void>(resolve => this.waiting.push(resolve));
        }
        try {
            return await task();
        } finally {
            const next = this.waiting.shift();
            if (next) { next(); } else { this.available += 1; }
        }
    }
}

/**
 * How a reconcile treats deletions: collect them for `applyDeletions`, or apply them, which only
 * `applyDeletions` asks for.
 */
interface Mode {
    deletions: 'apply' | 'collect',
    collected?: {local: string[], remote: string[]},
    summary: SyncSummary,
    /** started by an event: joins a reconcile of the same path that has not started yet */
    live?: boolean,
    /** a tool's request: deletions that need the user's confirmation are not made */
    tool?: boolean,
    /** the tool's request that the mode's steps belong to, with its one limit for the wait for git's index lock */
    request?: ToolRequest,
    /** deletions that the request itself confirms, e.g. those of a commit that is landed */
    approved?: ReadonlySet<string>,
    /** git's pairing of the local renames and moves (`localRenames`), asked for once by the reconciles of this mode */
    renames?: Promise<Map<string, string>>,
    /** work that reconciles of this mode queued in the queues of two paths (a rename); the batch waits for it */
    queued?: Promise<void>[],
    /** the reconciles of a rename made on Overleaf, which apply it (`remoteRenamed`) */
    remoteMove?: boolean,
}

/** A mode that collects deletions. */
function collecting(summary: SyncSummary, options: Partial<Pick<Mode, 'live' | 'tool' | 'request' | 'approved'>> = {}): Mode {
    return {deletions: 'collect', collected: {local: [], remote: []}, summary, ...options};
}

interface Slot {
    /** settles when the last scheduled reconcile of the path is done */
    tail: Promise<void>,
    /** a reconcile that has not started yet; a new change joins it instead of queueing another */
    waiting?: Promise<void>,
}

/** A three-way merge of one text, e.g. git's (the default). */
export type MergeText = (base: string, local: string, remote: string) => Promise<{content: string, hasConflict: boolean}>;

export class ReplicaSync {
    /** network transfers at a time */
    static concurrency = 4;
    /** files reconciled at a time during a full sync */
    static scanConcurrency = 8;
    /**
     * More files than this deleted on one side at once need the user's confirmation in the window,
     * in every kind of sync (`applyDeletions`); a tool's request does not make them.
     */
    static deletionThreshold = 5;
    /** Wait this long before acting on a remote deletion: replacing a file on Overleaf removes it and then adds it again. */
    static remoteDeleteDelayMs = 1000;
    /**
     * Wait this long before acting on a local deletion that an event reports, so that a program
     * that renames or moves files by deleting them and then writing the new ones, as a git
     * checkout does, can write the new files first, and git's pairing of renames (`localRenames`)
     * sees them. It is a last resort: at a deletion, the sync cannot tell whether a new file will
     * follow, nor when. A rename or a move in one step shows both paths at once, whichever event
     * comes first.
     */
    static localDeleteDelayMs = 1000;
    static saveDelayMs = 1000;
    /** Record the state (the store's commits) once the sync has been idle this long. */
    static recordQuietMs = 10_000;
    /**
     * Another program's git index lock that has been there this long, counted from the time its
     * file was last written (`ReplicaStore.indexLockTime`), is taken for one that stays: the
     * window tells the user, and a tool's answer says so. A git that ended without removing its
     * lock, e.g. at a crash, never answers, so the time limit is the only sign of it. The steps
     * keep waiting for the lock's removal.
     */
    static staleLockMs = 10_000;
    /**
     * How long a tool's request waits for another program's git index lock to go before it
     * answers that the sync waits. The IDE's own git takes the lock for a few milliseconds when it
     * refreshes the index, e.g. after the sync wrote files, so a tool's request right after a sync
     * can meet it. A lock that stays never goes, and this limit is the last resort for it. The
     * limit is for the whole request: its checks (the start of its step, each write's, the
     * deletion step's and the record's) wait together until `ToolRequest.lockDeadline`, which
     * its first wait sets.
     */
    static toolLockWaitMs = 2_000;

    private state: SavedState = {version: 1, entries: {}, untracked: []};
    private loaded?: Promise<void>;
    /** whether `loaded` has settled with the saved state in place */
    private stateLoaded = false;
    /** paths that existed only locally when a sync without saved state started */
    private firstRunLocalOnly = new Set<string>();
    private slots = new Map<string, Slot>();
    private transfers = new Semaphore(ReplicaSync.concurrency);
    private baseTexts = new Map<string, string>();
    private stopped = false;
    private cancelled = false;
    private saveTimer?: NodeJS.Timeout;
    private saving: Promise<void> = Promise.resolve();
    private fullSync?: Promise<SyncSummary>;
    private warnedConflicts = new Set<string>();
    /** reconciles scheduled and not finished */
    private active = 0;
    private recordTimer?: NodeJS.Timeout;
    private recording: Promise<unknown> = Promise.resolve();
    /** while held, local changes reported by events wait, e.g. while a commit is checked out to be pushed */
    private holds = 0;
    private heldPaths = new Set<string>();
    /** deletions the user declined in the window, by side: asked again by the next full sync or Sync Now */
    private declined = {local: new Set<string>(), remote: new Set<string>()};
    /** one deletion step at a time, so that the deletions of one moment get one question */
    private deleting: Promise<unknown> = Promise.resolve();
    /** the deletions that a question open in the window asks about (decideDeletions); undefined while the window does not ask */
    private question?: Deletions;
    /** who waits for a question to open (`questionOpened`), told the question when it opens */
    private readonly questionListeners = new Set<(question: Deletions) => void>();
    /** why the sync waits instead of acting on the folder (`mayAct`); undefined while it acts */
    private waitReason?: string;
    /** the index lock of another program that the window's steps wait for (`indexLockReleased`), and why the sync waits once the lock stays (`lockReason`) */
    private lockWait?: {file: string, released: Promise<void>, stale?: string};
    /** resolves when the sync stops, so that a step waiting for git's index lock ends then */
    private readonly stopping: Promise<void>;
    private markStopped!: () => void;
    /** the checked-out commit that the user agreed to put on Overleaf, and the last one asked about */
    private agreedHead?: string;
    private askedHead?: string;
    private readonly merge: MergeText;
    /** whether local changes are uploaded; without, they wait for a push through the git bridge */
    private readonly uploads: boolean;
    /** a pairing of local renames that has not started yet, which a request joins, and the end of the last one (`localRenames`) */
    private renamesWaiting?: Promise<Map<string, string>>;
    private renamesTail: Promise<unknown> = Promise.resolve();
    /**
     * renames made on Overleaf that `remoteRenamed` is applying, or that wait for the sync to act
     * again (`renamedWhileWaiting`), old path (a file's or a folder's) to new path
     */
    private remoteMoves = new Map<string, string>();
    /**
     * Binary files that a download read from Overleaf before the check right before its write
     * stopped it (StaleReadError), with the hash that the project's tree gave them. The reconcile
     * that runs again takes the content from here while the tree gives the same hash: each read
     * of a binary file is a request to Overleaf (vfs.openFile), unlike a document's (`reported`).
     */
    private readBeforeRerun = new Map<string, {hash: string, content: Uint8Array}>();
    /**
     * Renames made on Overleaf while the sync waited (`mayAct`), old path and new path, in their
     * order. The next full sync applies them before it compares the folder with Overleaf; their
     * paths stay in `remoteMoves` until then, so that no reconcile takes them for a deletion and
     * a new file. They are kept in memory only: after a restart, the two paths of each sync as a
     * deletion and a new file.
     */
    private renamedWhileWaiting: [string, string][] = [];
    private readonly onRecorded?: (result: {waiting?: boolean}) => void;

    constructor(
        private readonly remote: ReplicaRemote,
        private readonly local: ReplicaLocal,
        private readonly store: ReplicaStore,
        private readonly ui: ReplicaUI,
        private readonly isIgnored: (path: string) => boolean,
        options: {merge?: MergeText, uploads?: boolean, onRecorded?: (result: {waiting?: boolean}) => void} = {},
    ) {
        this.stopping = new Promise<void>(resolve => { this.markStopped = resolve; });
        this.merge = options.merge ?? gitMergeText;
        this.uploads = options.uploads ?? true;
        this.onRecorded = options.onRecorded;
    }

    /** Read the saved state; rejects when it cannot be used, and then the sync does not start. */
    open(): Promise<void> {
        return this.load();
    }

    /** The deletions that a question open in the window asks about now; undefined while the window does not ask. */
    get openQuestion(): Deletions | undefined {
        return this.question && {where: this.question.where, paths: [...this.question.paths]};
    }

    /**
     * Resolves with the deletions that a question open in the window asks about, as they were
     * when it opened: at once while one is open, else when the next one opens. A tool that must
     * not wait behind the question waits for this or for what it needs, whichever comes first.
     * `dispose` ends the wait.
     */
    questionOpened(): {opened: Promise<Deletions>, dispose(): void} {
        let listener!: (question: Deletions) => void;
        const opened = new Promise<Deletions>(resolve => { listener = resolve; });
        const open = this.openQuestion;
        if (open) {
            listener(open);
            return {opened, dispose: () => {}};
        }
        this.questionListeners.add(listener);
        return {opened, dispose: () => { this.questionListeners.delete(listener); }};
    }

    /** Why the sync waits instead of acting on the folder, e.g. for a tool's status; undefined while it acts. */
    get waitingFor(): string | undefined {
        return this.waitReason ?? this.lockWait?.stale;
    }

    /**
     * The one check before the sync acts on the folder: every kind of sync, every deletion and
     * every record asks it. Rejects when the folder is not the one the sync started with. Answers
     * why the sync waits: git is in the middle of an operation in the folder, or the checked-out
     * commit does not contain Overleaf's recorded state and the user has not agreed to put its
     * files on Overleaf; undefined when the sync may act. In the window the user is asked once
     * about each such commit; a tool (`by`) is not asked. When the sync may act again after
     * waiting, a full sync catches up with what changed meanwhile.
     */
    private async mayAct(by?: 'tool' | 'user', request?: ToolRequest): Promise<string | undefined> {
        await this.local.verify();
        // While another program holds git's index lock, git writes the work tree and the index, as
        // in a checkout, which moves HEAD last. A window step waits until the lock is gone and asks
        // again, without the full sync that ends a wait: the step itself goes on. A tool's request
        // waits up to toolLockWaitMs, and then answers that the sync waits; for a lock that stays
        // (`lockReason`), it answers at once.
        for (let lock = await this.store.foreignIndexLock?.(); lock!==undefined; lock = await this.store.foreignIndexLock?.()) {
            if (by==='tool') {
                const {reason, stays} = await this.lockReason(lock);
                if (stays) { return reason; }
                const deadline = request ? request.lockDeadline ??= Date.now() + ReplicaSync.toolLockWaitMs : Date.now() + ReplicaSync.toolLockWaitMs;
                if (!await this.indexLockGoesWithin(lock, Math.max(0, deadline - Date.now()))) { return (await this.lockReason(lock)).reason; }
            } else {
                await this.indexLockReleased(lock);
            }
            if (this.stopped) { return 'the sync stopped'; }
        }
        const tree = await this.store.workTree?.();
        let reason: string | undefined;
        if (tree!==undefined && 'operation' in tree) {
            reason = `git is in the middle of ${tree.operation} in the folder`;
        } else if (tree!==undefined && tree.head!==this.agreedHead) {
            reason = `the checked-out commit ${tree.head.slice(0, 7)} does not contain Overleaf's recorded state ${tree.overleaf.slice(0, 7)}`;
            if (by!=='tool' && this.uploads && this.askedHead!==tree.head && this.ui.confirmCheckout) {
                const head = tree.head;
                this.askedHead = head;
                this.ui.confirmCheckout(head, tree.overleaf).then(async agreed => {
                    if (!agreed || this.stopped) { return; }
                    this.agreedHead = head;
                    await this.mayAct();
                }).catch(error => this.ui.log(`Acting on the answer about ${head.slice(0, 7)} failed: ${errorMessage(error)}`));
            }
        }
        if (reason!==undefined) {
            if (this.waitReason!==reason) {
                this.waitReason = reason;
                this.ui.log(`The sync waits: ${reason}.`);
                this.ui.waiting?.(reason);
            }
        } else if (this.waitReason!==undefined) {
            this.waitReason = undefined;
            this.ui.log('The sync acts again; a full sync catches up with what changed while it waited.');
            this.ui.waiting?.(undefined);
            // a full sync that runs now, e.g. the one that asked, catches up itself
            if (!this.stopped && this.fullSync===undefined) {
                this.syncAll().then(summary => this.ui.liveResult(summary),
                                    error => this.ui.log(`The full sync after waiting failed: ${errorMessage(error)}`));
            }
        }
        return reason;
    }

    /**
     * Why the sync waits for another program's index lock `file`: a git command under way, or a
     * lock that stays, one that has been there for `staleLockMs` or longer; and when the lock
     * stays from, undefined when the store does not tell its time or it is gone.
     */
    private async lockReason(file: string): Promise<{reason: string, stays: boolean, staysFrom?: number}> {
        // The lock's age is this machine's clock against the file's modification time, which the
        // file system's clock sets. On a network file system, the server's clock can differ from
        // this machine's: a fresh lock can then look old, and be taken for one that stays at once,
        // or an old lock young.
        const written = await this.store.indexLockTime?.(file);
        const staysFrom = written===undefined ? undefined : written + ReplicaSync.staleLockMs;
        if (staysFrom!==undefined && staysFrom<=Date.now()) {
            return {reason: `git's index lock ${file} has been there for ${ReplicaSync.staleLockMs/1000} s or longer: a git command still runs in the folder, or one that ended without removing it left it, and git does not work there until it is removed`, stays: true, staysFrom};
        }
        return {reason: `git holds its index lock ${file}: it is writing the folder, e.g. for a checkout`, stays: false, staysFrom};
    }

    /** Whether another program's index lock `file` goes, or the sync stops, within `ms` (`indexLockReleased`). */
    private async indexLockGoesWithin(file: string, ms: number): Promise<boolean> {
        let timer: NodeJS.Timeout | undefined;
        const limit = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
        try {
            return await Promise.race([this.indexLockReleased(file).then(() => true), limit]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Resolves once another program's index lock `file` is gone (the store's event), or the sync
     * stops; the steps that wait for it, the window's and a tool's (`indexLockGoesWithin`), share
     * one wait. When the lock stays
     * (`lockReason`), the user is told, with the file, as git's own message about the lock names
     * it; the steps keep waiting.
     */
    private indexLockReleased(file: string): Promise<void> {
        if (this.lockWait?.file===file) { return this.lockWait.released; }
        const watch = this.store.indexLockReleased!(file);
        const wait: {file: string, released: Promise<void>, stale?: string} = {file, released: Promise.resolve()};
        let over = false;
        let timer: NodeJS.Timeout | undefined;
        // Looked at again when the lock would stay by then: git may have replaced the lock with a
        // newer one meanwhile, at the same path.
        const look = () => this.lockReason(file).then(({reason, stays, staysFrom}) => {
            if (over || staysFrom===undefined) { return; }
            if (!stays) {
                timer = setTimeout(look, staysFrom - Date.now());
                // the wait itself keeps the work that waits; the look alone does not keep a process alive
                timer.unref?.();
                return;
            }
            wait.stale = reason;
            this.ui.log(`The sync waits: ${reason}.`);
            this.ui.waiting?.(reason);
            this.ui.lockStays?.(reason, wait.released.then(() => {}, () => {}));
        }).catch(error => this.ui.log(`Looking at git's index lock ${file} failed: ${errorMessage(error)}`));
        void look();
        wait.released = Promise.race([watch.released, this.stopping]).finally(() => {
            over = true;
            clearTimeout(timer);
            watch.dispose();
            if (this.lockWait===wait) { this.lockWait = undefined; }
            if (wait.stale!==undefined) {
                this.ui.log(`git's index lock ${file} is gone.`);
                this.ui.waiting?.(this.waitReason);
            }
        });
        this.lockWait = wait;
        return wait.released;
    }

    private load(): Promise<void> {
        this.loaded ??= (async () => {
            const saved = await this.store.load();
            if (saved!==undefined) {
                if (saved.version!==1) {
                    throw new Error(`the saved sync state has version ${String(saved.version)}, which this version of the extension does not read`);
                }
                this.state = {version: 1, entries: saved.entries ?? {}, untracked: saved.untracked ?? [], changes: saved.changes ?? {},
                              ...(saved.restored ? {restored: true} : {})};
            }
            // the state kept before the git backend: its bases are the first record, before anything syncs
            if (Object.values(this.state.changes ?? {}).includes('import')) {
                await this.recordNow();
            }
            this.stateLoaded = true;
        })();
        return this.loaded;
    }

    /** Note where the change of a path's base came from, for the store's next record. */
    private noteChange(path: string, origin: Origin) {
        const changes = this.state.changes ??= {};
        const before = changes[path];
        changes[path] = before===undefined || before===origin || before==='import' ? origin : 'merge';
    }

    /** The paths the sync looks after: not the replica's own folders, and not ignored. */
    private tracked(path: string): boolean {
        return !isReplicaOwnPath(path) && !this.isIgnored(path);
    }

    /**
     * Compare every file on both sides and bring them in line. Runs once when the replica
     * starts, and again on request. Changes reported meanwhile are queued per file.
     */
    syncAll(): Promise<SyncSummary> {
        this.fullSync ??= this.runSyncAll().finally(() => { this.fullSync = undefined; });
        return this.fullSync;
    }

    /** Make the running `syncAll` start no more files. Changes reported by events still sync. */
    cancel() {
        this.cancelled = true;
    }

    private async runSyncAll(): Promise<SyncSummary> {
        this.cancelled = false;
        await this.load();
        const waiting = await this.mayAct();
        if (waiting!==undefined) { return {...emptySummary(), waitingFor: waiting}; }
        // the renames made on Overleaf while the sync waited, before the comparison
        for (const [from, to] of this.renamedWhileWaiting.splice(0)) { await this.remoteRenamed(from, to); }
        // the user asks again about the deletions declined before
        this.declined.local.clear();
        this.declined.remote.clear();
        const firstRun = Object.keys(this.state.entries).length===0;
        const restored = this.state.restored===true;
        const [remoteFiles, localFiles] = await Promise.all([this.remote.list(), this.local.list()]);
        const paths = new Set<string>([...remoteFiles.keys(), ...localFiles.keys(), ...Object.keys(this.state.entries)]);
        if (firstRun || restored) {
            for (const path of localFiles.keys()) {
                if (!remoteFiles.has(path) && this.state.entries[path]===undefined) { this.firstRunLocalOnly.add(path); }
            }
        }
        const summary = emptySummary();
        const mode = collecting(summary);
        for (const path of Object.keys(this.state.entries)) {
            if (!this.tracked(path)) { delete this.state.entries[path]; }
        }
        const todo = [...paths].filter(path => this.tracked(path)).sort();
        this.ui.log(`Sync of ${todo.length} files started${firstRun ? ' (without saved state: a first sync)' : restored ? ' (bases of Overleaf\'s last recorded state)' : ''}.`);

        let done = 0;
        let next = 0;
        const worker = async () => {
            while (next<todo.length && !this.stopped && !this.cancelled) {
                const path = todo[next++];
                await this.schedule(path, mode);
                done += 1;
                this.ui.progress(done, todo.length);
            }
        };
        await Promise.all(Array.from({length: ReplicaSync.scanConcurrency}, worker));
        // the renames that the scan found, before the deletions it collected are confirmed
        await this.queuedWork(mode);
        summary.notChecked = todo.length - done;

        if (!this.stopped && !this.cancelled) {
            await this.applyDeletions(mode);
            if (restored) { delete this.state.restored; }
        }
        this.firstRunLocalOnly.clear();
        await this.saveNow();
        this.ui.log(`Sync finished: ${describe(summary)}.`);
        return summary;
    }

    /** A local file or folder at `path` was created, changed or deleted. */
    async localChanged(path: string): Promise<void> {
        if (this.holds>0) {
            this.heldPaths.add(path);
            return;
        }
        await this.load();
        if (this.state.entries[path]!==undefined && await this.local.stat(path)===undefined) {
            // a deletion: the creation of a renamed file is matched with it first
            await new Promise(resolve => setTimeout(resolve, ReplicaSync.localDeleteDelayMs));
        }
        return this.changed(path, false);
    }

    /**
     * Let local changes reported by events wait until `release`, e.g. while a commit is
     * checked out to be pushed; `flush` still syncs the whole folder meanwhile.
     */
    hold() {
        this.holds += 1;
    }

    /** End a `hold`; the changes reported meanwhile sync now. */
    release() {
        this.holds = Math.max(0, this.holds-1);
        if (this.holds>0) { return; }
        const paths = [...this.heldPaths];
        this.heldPaths.clear();
        for (const path of paths) {
            this.localChanged(path).catch(error => this.ui.log(`${path}: sync failed: ${errorMessage(error)}`));
        }
    }

    /** A file or folder at `path` was created, changed or deleted on Overleaf. */
    remoteChanged(path: string, deleted: boolean): Promise<void> {
        if (deleted) {
            // Replacing a file on Overleaf removes it and then adds it again.
            return new Promise(resolve => setTimeout(resolve, ReplicaSync.remoteDeleteDelayMs))
                .then(() => this.changed(path, true));
        }
        return this.changed(path, true);
    }

    /**
     * The file or folder at `from` was renamed or moved on Overleaf to `to`: one change, as the
     * project reports it. The local file moves with its saved entry and keeps its local changes,
     * which then sync as for any file, and the record shows the rename as git shows renames. Where
     * a file cannot move (it was never synced, its local file is gone, or `to` is taken in the
     * folder), its two paths sync as a deletion and a new file. While the sync waits (`mayAct`),
     * the rename waits too, and the next full sync applies it first.
     */
    async remoteRenamed(from: string, to: string): Promise<void> {
        if (this.stopped || from===to) { return; }
        // From now until the move is applied, other reconciles leave both paths alone: a reconcile
        // of `from` would take the local file for one deleted on Overleaf, one of `to` would download it.
        this.remoteMoves.set(from, to);
        const mode: Mode = {...collecting(emptySummary(), {live: true}), remoteMove: true};
        // set when a move finds the sync waiting: the rename waits for the next full sync (`renamedWhileWaiting`)
        let waits = false;
        try {
            // Once the saved state is loaded, the moves are queued before the first wait, so that
            // the work scheduled after the event in the queues of these paths comes after them.
            if (!this.stateLoaded) { await this.load(); }
            const prefix = `${from}/`;
            const moves: [string, string][] = this.state.entries[from]!==undefined ? [[from, to]]
                : Object.keys(this.state.entries).filter(p => p.startsWith(prefix)).map(p => [p, `${to}${p.slice(from.length)}`]);
            // each file moves, after the check that the sync may act on the folder (`mayAct`), and
            // then both of its paths sync as they are, in the queues of both; a move that finds the
            // sync waiting at either check, the first or the one right before it moves the file, waits
            const moving = moves.map(([a, b]) => this.inQueues([a, b], async () => {
                const waitsFor = await this.mayAct() ?? await this.reported(a, mode, () => this.moveLocally(a, b, mode));
                if (waitsFor!==undefined) { waits = true; return; }
                await this.reconcileReported(a, mode);
                if (this.tracked(b)) { await this.reconcileReported(b, mode); }
            }));
            const failed = (await Promise.allSettled(moving)).find((result): result is PromiseRejectedResult => result.status==='rejected');
            if (failed) { throw failed.reason; }
            if (waits) {
                this.renamedWhileWaiting.push([from, to]);
                this.ui.log(`${from}: its rename to ${to} on Overleaf waits for the sync, until it acts again`);
                return;
            }
            // Overleaf's other files in a moved folder
            const moved = new Set(moves.map(([, b]) => b));
            await this.scheduleAll((await this.expand(to, true)).filter(p => !moved.has(p) && this.tracked(p)), mode);
        } catch (error) {
            // e.g. the folder is not the one the sync started with
            mode.summary.failed.push({path: from, error: errorMessage(error)});
            this.ui.log(`${from}: applying its rename to ${to} on Overleaf failed: ${errorMessage(error)}`);
        } finally {
            if (!waits && this.remoteMoves.get(from)===to) { this.remoteMoves.delete(from); }
        }
        // a file that did not move is a deletion like any other, decided with them
        await this.applyDeletions(mode);
        this.scheduleSave();
        this.ui.liveResult(mode.summary);
    }

    /** Whether `path` is the old or the new path of a rename made on Overleaf that `remoteRenamed` is applying, or inside one. */
    private movingOnOverleaf(path: string): boolean {
        const inside = (p: string) => path===p || path.startsWith(`${p}/`);
        return [...this.remoteMoves].some(([from, to]) => inside(from) || inside(to));
    }

    /** Move the local file at `from` and its saved entry to `to`, as Overleaf moved it; nothing when it cannot move. */
    private async moveLocally(from: string, to: string, mode: Mode): Promise<void> {
        const entry = this.state.entries[from];
        if (!this.local.move || entry===undefined || this.state.entries[to]!==undefined || !this.tracked(to)) { return; }
        const [localFrom, localTo, remoteFrom, remoteTo] = await Promise.all([
            this.local.stat(from), this.local.stat(to), this.remote.entry(from), this.remote.entry(to)]);
        if (localFrom===undefined || localFrom==='folder' || localTo!==undefined || remoteFrom!==undefined || remoteTo?.kind!==entry.kind) { return; }
        if (await this.isUnmerged(from) || await this.isUnmerged(to)) { return; }
        await this.beforeWrite(mode);
        await this.local.move(from, to);
        // The entry keeps the size and time the file had when it held the base. A hard link keeps
        // the file itself, with them, so they still tell whether it holds the base; a copy, where
        // the file system has no hard links, has a new time, and the next reconcile compares its content.
        delete this.state.entries[from];
        this.state.entries[to] = entry;
        this.noteChange(from, 'remote');
        this.noteChange(to, 'remote');
        this.scheduleSave();
        mode.summary.renamedLocally.push({from, to});
        this.ui.log(`${from}: renamed to ${to} locally, as on Overleaf`);
        if (parentOf(from)!==parentOf(to)) { await this.removeFolderIfEmpty('local', parentOf(from)); }
    }

    private async changed(path: string, remote: boolean): Promise<void> {
        if (this.stopped || path==='' || path==='/') { return; }
        await this.load();
        const mode = collecting(emptySummary(), {live: true});
        try {
            // while the sync waits, the full sync after the wait takes this change in
            if (await this.mayAct()!==undefined) { return; }
            const paths = await this.expand(path, remote);
            await this.scheduleAll(paths.filter(p => this.tracked(p)), mode);
            await this.applyDeletions(mode);
        } catch (error) {
            // e.g. Overleaf does not answer: the next full sync looks at the file again
            mode.summary.failed.push({path, error: errorMessage(error)});
            this.ui.log(`${path}: sync failed: ${errorMessage(error)}`);
        }
        this.scheduleSave();
        this.ui.liveResult(mode.summary);
    }

    /** The files that an event about `path` may concern: the path itself, or the files in a folder. */
    private async expand(path: string, remote: boolean): Promise<string[]> {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        const paths = new Set<string>();
        for (const p of Object.keys(this.state.entries)) {
            if (p.startsWith(prefix)) { paths.add(p); }
        }
        if (remote) {
            if (await this.remote.isFolder(path)) {
                for (const p of (await this.remote.list()).keys()) {
                    if (p.startsWith(prefix)) { paths.add(p); }
                }
            } else {
                paths.add(path);
            }
        } else {
            if (await this.local.stat(path)==='folder') {
                for (const p of (await this.local.list()).keys()) {
                    if (p.startsWith(prefix)) { paths.add(p); }
                }
            } else {
                paths.add(path);
            }
        }
        return [...paths];
    }

    /**
     * Wait until the local changes made so far have reached Overleaf. With `scan`, first look
     * for files changed on disk that no event reported, e.g. written by another program, and
     * answer what the scan synced. `skipRecentMs` leaves out files written that recently, which
     * may still be half written: a periodic scan gets them the next time. `by` says who asks:
     * a tool, which does not make the deletions that need a confirmation, or the user in the
     * window, who is asked again about deletions declined before. `approved` lists deletions
     * that the request itself confirms. `question` is the question about deletions that a tool
     * saw open in the window (`questionOpened`): the answer names it, also when the user has
     * answered it since; without it, the answer names the question open at its end.
     */
    async flush(scan: boolean, {skipRecentMs = 0, now = Date.now(), record = false, by, approved, question: seen, request: given}: {
        skipRecentMs?: number, now?: number, record?: boolean, by?: 'tool' | 'user', approved?: ReadonlySet<string>, question?: Deletions,
        /** a tool's request that the flush is a part of, e.g. a landing's (`ToolRequest`); a tool's flush makes its own otherwise */
        request?: ToolRequest,
    } = {}): Promise<SyncSummary> {
        await this.load();
        const request = by==='tool' ? given ?? {} : undefined;
        const summary = emptySummary();
        summary.waitingFor = await this.mayAct(by, request);
        if (summary.waitingFor!==undefined) { return summary; }
        if (by==='user') {
            this.declined.local.clear();
            this.declined.remote.clear();
        }
        if (scan) {
            const localFiles = await this.local.list();
            const changed: string[] = [];
            const deleted: string[] = [];
            let recentNewFile = false;
            for (const [path, stat] of localFiles) {
                const entry = this.state.entries[path];
                if (!this.tracked(path) || this.state.untracked.includes(path)) { continue; }
                if (skipRecentMs>0 && now - stat.mtime < skipRecentMs) {
                    recentNewFile ||= entry===undefined;
                    continue;
                }
                if (!entry || entry.size!==stat.size || entry.mtime!==stat.mtime) { changed.push(path); }
            }
            // A new file written a moment ago may be the new path of a deleted file, still half
            // written, which git cannot pair with it yet: the deletions wait for the next scan.
            if (!recentNewFile) {
                for (const path of Object.keys(this.state.entries)) {
                    if (!localFiles.has(path) && this.tracked(path)) { deleted.push(path); }
                }
            }
            // A tool's request does not join a reconcile that another step scheduled and has not
            // started: that step would decide the deletion, without the request's approvals and
            // without the request learning about it. The request reconciles after it instead.
            const mode = collecting(summary, {live: by!=='tool', tool: by==='tool', request, approved});
            await this.scheduleAll([...changed, ...deleted], mode);
            await this.applyDeletions(mode);
            this.ui.liveResult(mode.summary);
        }
        // a tool learns about a question open in the window, whatever its own step collected; the
        // question names the deletions on its side that the step could not make
        const question = by==='tool' ? seen ?? this.openQuestion : undefined;
        if (question) {
            summary.question = question;
            summary.deletionsToConfirm = summary.deletionsToConfirm.filter(({where}) => where!==question.where);
        }
        await Promise.all([...this.slots.values()].map(slot => slot.tail));
        await this.remote.settled();
        if (record) {
            await this.recordNow({by, request});
        } else {
            this.scheduleSave();
        }
        return summary;
    }

    /** Whether the saved sync state has the file at `path`, i.e. whether it was synced before. */
    async knows(path: string): Promise<boolean> {
        await this.load();
        return this.state.entries[path]!==undefined;
    }

    /** Stop syncing: drop the queued work, wait for the running work and save the state. */
    async stop(): Promise<void> {
        this.stopped = true;
        this.markStopped();
        await Promise.all([...this.slots.values()].map(slot => slot.tail));
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        clearTimeout(this.recordTimer);
        this.recordTimer = undefined;
        // a state that could not be read is not saved over
        if (this.loaded && await this.loaded.then(() => true, () => false)) {
            await this.saveNow().catch(error => this.ui.log(`Saving the sync state failed: ${errorMessage(error)}`));
            await this.recordNow({stopping: true}).catch(error => this.ui.log(`Recording the state failed: ${errorMessage(error)}`));
        }
    }

    /** Upload local files that the first sync left alone because they were not on Overleaf. */
    async uploadUntracked(): Promise<SyncSummary> {
        await this.load();
        const waiting = await this.mayAct();
        if (waiting!==undefined) { return {...emptySummary(), waitingFor: waiting}; }
        const paths = this.state.untracked;
        this.state.untracked = [];
        const summary = emptySummary();
        const mode = collecting(summary);
        await this.scheduleAll(paths, mode);
        await this.applyDeletions(mode);
        await this.saveNow();
        return summary;
    }

    get untracked(): string[] {
        return [...this.state.untracked];
    }

    /** Run one reconcile of `path` after the ones already scheduled. */
    private schedule(path: string, mode: Mode): Promise<void> {
        const slot = this.slotOf(path);
        if (slot.waiting && mode.live) {
            return slot.waiting;
        }
        const own = slot;
        this.active += 1;
        const run = own.tail.then(async () => {
            if (own.waiting===run) { own.waiting = undefined; }
            if (this.stopped) { return; }
            await this.reconcileReported(path, mode);
        }).finally(() => { this.active -= 1; });
        own.waiting = run;
        own.tail = run;
        return run;
    }

    /** Schedule a reconcile of each path, and wait for them and for the work they queued (a rename's). */
    private async scheduleAll(paths: string[], mode: Mode): Promise<void> {
        await Promise.all(paths.map(path => this.schedule(path, mode)));
        await this.queuedWork(mode);
    }

    /** Wait for the work that the reconciles of `mode` queued, and for the work that queues. */
    private async queuedWork(mode: Mode): Promise<void> {
        while (mode.queued?.length) {
            await Promise.all(mode.queued.splice(0));
        }
    }

    private slotOf(path: string): Slot {
        let slot = this.slots.get(path);
        if (slot===undefined) {
            slot = {tail: Promise.resolve()};
            this.slots.set(path, slot);
        }
        return slot;
    }

    /** Reconcile `path`, in its queue already; a failure goes into the summary and the log. */
    private async reconcileReported(path: string, mode: Mode): Promise<void> {
        await this.reported(path, mode, () => this.reconcile(path, mode));
    }

    /**
     * Right before a reconcile writes to either side, or trashes or moves a file. A step asks
     * mayAct when it starts; a git operation, or another program's index lock, that comes during
     * the step is found here. While the sync waits, the reconcile leaves its path (SyncWaitsError)
     * to the full sync after the wait. When the lock is gone, or the operation is over, by the
     * time mayAct answers, git may have written the file since the reconcile read it, and the
     * reconcile reads both sides again (StaleReadError). mayAct is asked as at the start of the
     * step: for a tool's request (`mode.tool`) as a tool, which waits for a lock up to
     * toolLockWaitMs and does not ask the window about a checked-out commit. When neither is
     * there, the check is the existence of their files.
     */
    private async beforeWrite(mode: Mode): Promise<void> {
        const atWork = await this.gitAtWork();
        if (atWork===undefined) { return; }
        const reason = await this.mayAct(mode.tool ? 'tool' : undefined, mode.request);
        if (reason!==undefined) { throw new SyncWaitsError(reason); }
        throw new StaleReadError(`${atWork.lock!==undefined ? `git held its index lock ${atWork.lock}` : `git was in the middle of ${atWork.operation}`} when the sync was about to write; it reads both sides again`);
    }

    /** The git operation under way and another program's index lock, by the files that git keeps for them; undefined when neither is there. */
    private async gitAtWork(): Promise<{operation?: string, lock?: string} | undefined> {
        const [operation, lock] = await Promise.all([this.store.operation?.(), this.store.foreignIndexLock?.()]);
        return operation===undefined && lock===undefined ? undefined : {operation, lock};
    }

    /**
     * Remove `folder` when it is empty, in the local folder or on Overleaf (`where`), after its
     * last file was deleted or moved away. While git holds its index lock or is in the middle of
     * an operation (`gitAtWork`), the empty folder stays: git may be writing into it, as a
     * checkout does, and the sync does not act on the folder meanwhile.
     */
    private async removeFolderIfEmpty(where: 'local' | 'remote', folder: string): Promise<void> {
        const atWork = await this.gitAtWork();
        if (atWork!==undefined) {
            this.ui.log(`${folder}: the empty folder stays ${where==='local' ? 'in the local folder' : 'on Overleaf'}, since ${atWork.lock!==undefined ? `git holds its index lock ${atWork.lock}` : `git is in the middle of ${atWork.operation}`}`);
            return;
        }
        if (where==='local') {
            await this.local.removeFolderIfEmpty(folder);
            return;
        }
        await this.remote.removeFolderIfEmpty(folder)
            .catch(error => this.ui.log(`${folder}: removing the empty folder on Overleaf failed: ${errorMessage(error)}`));
    }

    /**
     * Run `work` on `path`; a failure goes into the summary and the log. Answers why the work
     * stopped to wait for the sync (`SyncWaitsError`), undefined when it ran or failed. Work that
     * found git's lock or operation right before a write, over by then (`StaleReadError`), runs
     * again from its reads. Each attempt after the first comes after a lock or an operation of
     * git's that has ended, so the work runs again only as often as git's commands came during
     * it, and its reads of Overleaf's side are local: a document's text comes from the copy of
     * the joined document, which Overleaf's updates keep up to date (vfs.openFile, measured in
     * writeFile.test.ts), and a binary file that the attempt before downloaded comes from
     * `readBeforeRerun`.
     */
    private async reported(path: string, mode: Mode, work: () => Promise<void>): Promise<string | undefined> {
        try {
            for (;;) {
                try {
                    await work();
                    return undefined;
                } catch (error) {
                    if (error instanceof StaleReadError) {
                        // Every write of the work comes after a check, so what it decided before is not
                        // carried out; only the copy that keepAside keeps before its download's check
                        // stays, and keepAside logs where it is.
                        this.ui.log(`${path}: ${error.message}`);
                        continue;
                    }
                    if (error instanceof SyncWaitsError) {
                        // not a failure: the full sync after the wait takes the path in
                        mode.summary.waitingFor ??= error.reason;
                        return error.reason;
                    }
                    mode.summary.failed.push({path, error: errorMessage(error)});
                    this.ui.log(`${path}: sync failed: ${errorMessage(error)}`);
                    return undefined;
                }
            }
        } finally {
            this.readBeforeRerun.delete(path);
        }
    }

    /**
     * Run `task` in the queues of `paths` at once: after the work scheduled so far for each of
     * them, and before the work scheduled for any of them later. Work on two paths, a rename, is
     * queued this way, and no work waits for a queue while it holds another, so that queues
     * cannot wait for each other in a circle.
     */
    private inQueues(paths: string[], task: () => Promise<void>): Promise<void> {
        const slots = [...new Set(paths)].map(path => this.slotOf(path));
        this.active += 1;
        const run = Promise.all(slots.map(slot => slot.tail)).then(task).finally(() => { this.active -= 1; });
        const settled = run.then(() => {}, () => {});
        for (const slot of slots) {
            slot.tail = settled;
            slot.waiting = undefined;
        }
        return run;
    }

    /**
     * Make the deletions that the reconciles in `mode` collected: the one deletion step of every
     * kind of sync. A side's deletions count with every other synced file that is missing on the
     * other side at this moment, so that deletions reported one at a time, as those of a git
     * checkout are, count together. Up to `deletionThreshold` go ahead; more need the user's
     * confirmation in the window, and a tool's request does not make them. A file missing on one
     * side counts even when the other side changed it, so the count is never below the deletions.
     * Deletions the user declined wait for the next full sync or Sync Now, and the deletions
     * that the request approves do not count. Before deleting, the local folder must still be
     * the one the sync started with.
     */
    private applyDeletions(mode: Mode): Promise<void> {
        const collected = mode.collected!;
        // only a window step with deletions can ask, so only such a step waits behind a question
        // open in the window; a tool's request never asks
        if (mode.tool || (collected.local.length===0 && collected.remote.length===0)) { return this.decideDeletions(mode); }
        const run = this.deleting.then(() => this.decideDeletions(mode));
        this.deleting = run.catch(() => {});
        return run;
    }

    private async decideDeletions(mode: Mode): Promise<void> {
        const requested = {...mode.collected!};
        mode.collected!.local = [];
        mode.collected!.remote = [];
        const summary = mode.summary;
        // the deletions not decided yet, which a failure leaves undone
        const open = new Set([...requested.local, ...requested.remote]);
        if (this.stopped || open.size===0) { return; }
        try {
            const deletable = await this.deletable();
            const renamed = await this.renamedPaths();
            for (const where of ['local', 'remote'] as const) {
                if (requested[where].length===0 || this.stopped) { continue; }
                const side = where==='local' ? 'in the local folder' : 'on Overleaf';
                const declined = this.declined[where];
                const before = requested[where].filter(path => declined.has(path));
                if (before.length) {
                    // a tool learns that the sync is not complete; the window asked already
                    if (mode.tool) { summary.skippedDeletions.push(...before); }
                    this.ui.log(`Not deleting ${before.length} files ${side}, which the user declined to delete: ${before.join(', ')}`);
                }
                // a rename takes these paths away: not deleted, and decided
                requested[where].filter(path => renamed.has(path)).forEach(path => open.delete(path));
                let apply = requested[where].filter(path => !declined.has(path) && !renamed.has(path));
                const counted = deletable[where].filter(path => !declined.has(path) && !mode.approved?.has(path) && !renamed.has(path));
                if (counted.length>ReplicaSync.deletionThreshold) {
                    if (mode.tool) {
                        summary.deletionsToConfirm.push({where, paths: counted});
                        this.ui.log(`Not deleting ${counted.length} files ${side} for a tool's request: more than ${ReplicaSync.deletionThreshold} at once need the user's confirmation in the window: ${counted.join(', ')}`);
                        requested[where].forEach(path => open.delete(path));
                        continue;
                    }
                    this.question = {where, paths: counted};
                    this.questionListeners.forEach(listener => listener(this.openQuestion!));
                    let confirmed: boolean;
                    try {
                        confirmed = await this.ui.confirmDeletions(where, counted);
                    } finally {
                        this.question = undefined;
                    }
                    if (this.stopped) { return; }
                    if (!confirmed) {
                        counted.forEach(path => declined.add(path));
                        summary.skippedDeletions.push(...counted);
                        this.ui.log(`Deleting ${counted.length} files ${side} was not confirmed: ${counted.join(', ')}`);
                        requested[where].forEach(path => open.delete(path));
                        continue;
                    }
                    apply = [...new Set([...apply, ...counted])];
                }
                requested[where].filter(path => declined.has(path)).forEach(path => open.delete(path));
                if (apply.length===0) { continue; }
                const waiting = await this.mayAct(mode.tool ? 'tool' : undefined, mode.request);
                if (waiting!==undefined) {
                    // the full sync after the wait makes these deletions, or finds them gone
                    summary.waitingFor = waiting;
                    return;
                }
                const applying: Mode = {deletions: 'apply', summary};
                apply.forEach(path => open.delete(path));
                await Promise.all(apply.map(path => this.schedule(path, applying)));
            }
        } catch (error) {
            // e.g. the folder is not the one the sync started with: the deletions not made yet wait
            for (const path of open) { summary.failed.push({path, error: errorMessage(error)}); }
            this.ui.log(`Deleting ${open.size} files failed: ${errorMessage(error)}`);
        }
    }

    /**
     * The synced paths that a rename takes away, not a deletion: the old paths that git pairs with
     * a new local file, and the paths of renames made on Overleaf that `remoteRenamed` is
     * applying. They are neither counted nor deleted. The pairing is made when the deletion step
     * decides (`currentRenames`), not taken from the batch: a pair whose rename Overleaf refused,
     * and whose new file is uploaded since, is not a pair any more, and its old path is a deletion.
     */
    private async renamedPaths(): Promise<Set<string>> {
        const paths = new Set((await this.currentRenames()).values());
        for (const path of Object.keys(this.state.entries)) {
            if (this.movingOnOverleaf(path)) { paths.add(path); }
        }
        return paths;
    }

    /**
     * The synced files that a deletion on each side would remove now: there, and missing on the
     * other side. A synced file that the local listing lacks is looked up with stat, as the
     * reconcile looks it up: the listing does not walk symbolically linked folders, while stat
     * follows links, so a file in a linked folder is there for both.
     */
    private async deletable(): Promise<{local: string[], remote: string[]}> {
        const [localFiles, remoteFiles] = await Promise.all([this.local.list(), this.remote.list()]);
        const paths = Object.keys(this.state.entries).filter(path => this.tracked(path));
        const foundByStat = new Set<string>();
        await Promise.all(paths.filter(path => !localFiles.has(path)).map(async path => {
            const stat = await this.local.stat(path);
            if (stat!==undefined && stat!=='folder') { foundByStat.add(path); }
        }));
        const deletable = {local: [] as string[], remote: [] as string[]};
        for (const path of paths) {
            const local = localFiles.has(path) || foundByStat.has(path), remote = remoteFiles.has(path);
            if (local && !remote) { deletable.local.push(path); }
            if (remote && !local) { deletable.remote.push(path); }
        }
        return deletable;
    }

    private async reconcile(path: string, mode: Mode): Promise<void> {
        const summary = mode.summary;
        const entry = this.state.entries[path];
        const [remote, localStat] = await Promise.all([this.remote.entry(path), this.local.stat(path)]);
        if (localStat==='folder') {
            return;
        }
        if (this.state.untracked.includes(path)) {
            if (localStat!==undefined && remote===undefined) {
                summary.untracked.push(path);
                return;
            }
            // deleted locally, or now on Overleaf too: no longer left alone
            this.state.untracked = this.state.untracked.filter(p => p!==path);
        }
        const kind = remote?.kind ?? entry?.kind;

        // the local side
        let localContent: Uint8Array | undefined;
        let localHash: string | undefined;
        if (localStat!==undefined) {
            if (entry && !entry.conflict && entry.size===localStat.size && entry.mtime===localStat.mtime
                && entry.checked!==undefined && entry.checked-entry.mtime>2000) {
                localHash = entry.base;
            } else {
                localContent = await this.local.read(path);
                if (localContent===undefined) { return; } // gone meanwhile; its deletion is reported next
                localHash = contentHash(kind, localContent);
            }
        }

        // the Overleaf side
        let remoteText: string | undefined;
        let remoteContent: Uint8Array | undefined;
        let remoteHash: string | undefined;
        if (remote?.kind==='doc') {
            remoteText = await this.transfers.run(() => this.remote.readDoc(path));
            remoteHash = textHash(remoteText);
        } else if (remote?.kind==='file') {
            if (remote.hash) {
                remoteHash = remote.hash;
            } else {
                remoteContent = await this.download(path, remote);
                remoteHash = gitBlobHash(remoteContent);
            }
        }

        const base = entry?.base;
        // a file missing from the project tree is known to be gone from Overleaf only while Overleaf
        // answers; until then the next sync decides
        const disconnected = remote===undefined ? this.remote.disconnected() : undefined;
        if (disconnected) { throw disconnected; }
        if (localHash===undefined && remoteHash===undefined) {
            if (entry) {
                delete this.state.entries[path];
                this.noteChange(path, 'remote');
            }
            return;
        }
        if (localHash===remoteHash) {
            if (base!==localHash || entry?.conflict || entry?.checked===undefined || localContent!==undefined) {
                await this.setEntry(path, {kind: remote!.kind, base: localHash!, ...seen(localStat)}, 'remote', remoteText, localContent);
            }
            summary.unchanged += 1;
            return;
        }
        // A git operation of the user's (a merge, a rebase) left changes to resolve in this file:
        // leave it alone until they are resolved.
        if (!entry?.conflict && await this.isUnmerged(path)) {
            this.blocked(path);
            return;
        }

        if (localHash!==undefined && remoteHash!==undefined) {
            if (base===undefined || this.firstRunLocalOnly.has(path)) {
                // No saved state tells which side changed: keep the local version aside.
                await this.keepAside(path, localContent ?? await this.local.read(path), remote!, remoteText, remoteContent, mode);
                return;
            }
            if (entry.conflict) {
                // overlapping changes that the sync marked: resolved once git's index has the
                // file merged (git add) and the markers are gone
                localContent ??= await this.local.read(path);
                const localText = decoder.decode(localContent);
                if (hasConflictMarkers(localText) || await this.isUnmerged(path)) {
                    if (remoteHash!==base && remote!.kind==='doc') {
                        // Overleaf changed again: take that into the file, markers and all.
                        await this.mergeDoc(path, entry, localText, remoteText!, localStat, mode);
                    } else {
                        this.blocked(path);
                    }
                    return;
                }
                this.warnedConflicts.delete(path);
            }
            if (remoteHash===base) {
                await this.upload(path, localContent ?? await this.local.read(path), localStat, remote!, mode);
            } else if (localHash===base) {
                await this.download(path, remote!, remoteText, remoteContent, mode);
            } else if (remote!.kind==='doc') {
                localContent ??= await this.local.read(path);
                await this.mergeDoc(path, entry!, decoder.decode(localContent), remoteText!, localStat, mode);
            } else {
                await this.keepAside(path, localContent ?? await this.local.read(path), remote!, remoteText, remoteContent, mode);
            }
            return;
        }

        if (localHash!==undefined) {
            // only the local file exists
            if (base===undefined) {
                if (this.firstRunLocalOnly.has(path)) {
                    // Left alone: it may be a local build product, or a file someone deleted on Overleaf.
                    if (!this.state.untracked.includes(path)) { this.state.untracked.push(path); }
                    summary.untracked.push(path);
                } else {
                    const renames = await this.localRenames(mode);
                    const from = renames.get(path);
                    if (from===undefined) {
                        await this.upload(path, localContent ?? await this.local.read(path), localStat, undefined, mode);
                        return;
                    }
                    // the rename, in the queues of both paths, after this reconcile
                    (mode.queued ??= []).push(this.inQueues([from, path], async () => { await this.reported(path, mode, () => this.renameLocalPair(from, path, renames, mode)); }));
                }
            } else if (!mode.remoteMove && this.movingOnOverleaf(path)) {
                // renamed on Overleaf: the move takes the local file, with its local changes
                return;
            } else if (mode.deletions==='collect') {
                mode.collected!.local.push(path);
            } else if (localHash===base) {
                await this.beforeWrite(mode);
                await this.local.remove(path);
                delete this.state.entries[path];
                this.noteChange(path, 'remote');
                summary.deletedLocal.push(path);
                this.ui.log(`${path}: deleted locally, as on Overleaf`);
                await this.removeFolderIfEmpty('local', parentOf(path));
            } else {
                // deleted on Overleaf, changed locally: follow Overleaf and keep the local version aside
                await this.beforeWrite(mode);
                const copy = await this.store.keepCopy(path, localContent ?? await this.local.read(path) ?? new Uint8Array());
                await this.local.remove(path);
                delete this.state.entries[path];
                this.noteChange(path, 'remote');
                summary.keptAside.push({path, copy});
                this.ui.log(`${path}: deleted on Overleaf but changed locally; the local version is kept at ${copy}`);
                await this.removeFolderIfEmpty('local', parentOf(path));
            }
            return;
        }

        // only the Overleaf file exists
        if (base!==undefined && [...(await this.localRenames(mode)).values()].includes(path)) {
            // git pairs it with a new local file: the reconcile of that file renames it on Overleaf
            return;
        }
        if (base===undefined && !mode.remoteMove && this.movingOnOverleaf(path)) {
            // the new path of a rename made on Overleaf: the move brings the local file here
            return;
        }
        if (base===undefined || remoteHash!==base) {
            await this.download(path, remote!, remoteText, remoteContent, mode);
        } else if (mode.deletions==='collect' && this.uploads) {
            // without uploads the deletion waits for a push and is not made here (below), so it does not count or ask
            mode.collected!.remote.push(path);
        } else if (await this.isUnmerged(path)) {
            this.blocked(path);
        } else if (!this.uploads) {
            summary.held.push(path);
        } else {
            await this.transfers.run(async () => { await this.beforeWrite(mode); await this.remote.remove(path); });
            delete this.state.entries[path];
            this.noteChange(path, 'local');
            summary.deletedRemote.push(path);
            this.ui.log(`${path}: deleted on Overleaf, as locally`);
            await this.removeFolderIfEmpty('remote', parentOf(path));
        }
    }

    /** Download `path` and write it locally; returns the content. */
    private async download(path: string, remote: RemoteEntry, text?: string, content?: Uint8Array, mode?: Mode): Promise<Uint8Array> {
        let hash: string;
        if (remote.kind==='doc') {
            text ??= await this.transfers.run(() => this.remote.readDoc(path));
            content = encoder.encode(text);
            hash = textHash(text);
        } else {
            const kept = this.readBeforeRerun.get(path);
            content ??= kept!==undefined && kept.hash===remote.hash ? kept.content : await this.transfers.run(() => this.remote.readFile(path));
            hash = gitBlobHash(content);
            if (remote.hash && hash!==remote.hash) {
                throw new Error(`the downloaded content does not match the hash Overleaf reports (${hash} instead of ${remote.hash})`);
            }
        }
        if (mode===undefined) {
            return content; // only needed for comparing
        }
        try {
            await this.beforeWrite(mode);
        } catch (error) {
            if (error instanceof StaleReadError && remote.kind==='file' && remote.hash!==undefined) { this.readBeforeRerun.set(path, {hash: remote.hash, content}); }
            throw error;
        }
        const stat = await this.local.write(path, content);
        await this.setEntry(path, {kind: remote.kind, base: hash, ...stat, checked: Date.now()}, 'remote', text, content);
        mode.summary.downloaded.push(path);
        this.ui.log(`${path}: downloaded`);
        return content;
    }

    /** Upload `content`, read from the local file after its stat `stat` was taken. */
    private async upload(path: string, content: Uint8Array | undefined, stat: LocalStat | undefined,
                         remote: RemoteEntry | undefined, mode: Mode) {
        const summary = mode.summary;
        if (content===undefined) { return; }
        if (await this.isUnmerged(path)) {
            this.blocked(path);
            return;
        }
        if (!this.uploads) {
            summary.held.push(path);
            return;
        }
        let kind: EntryKind;
        let text: string | undefined;
        if (remote?.kind==='doc') {
            text = decoder.decode(content);
            if (this.state.entries[path]?.conflict && hasConflictMarkers(text)) {
                return;
            }
            const sent = text;
            await this.transfers.run(async () => { await this.beforeWrite(mode); await this.remote.writeDoc(path, sent); });
            kind = 'doc';
        } else {
            const created = await this.transfers.run(async () => { await this.beforeWrite(mode); return this.remote.upload(path, content); });
            kind = created.kind;
            if (kind==='doc') { text = decoder.decode(content); }
        }
        const hash = kind==='doc' ? textHash(text!) : gitBlobHash(content);
        await this.setEntry(path, {kind, base: hash, ...seen(stat)}, 'local', text, content);
        summary.uploaded.push(path);
        this.ui.log(`${path}: uploaded`);
    }

    private async mergeDoc(path: string, entry: SavedEntry, localText: string, remoteText: string,
                           stat: LocalStat | undefined, mode: Mode) {
        const summary = mode.summary;
        const baseText = await this.baseText(entry.base);
        if (baseText===undefined) {
            await this.keepAside(path, encoder.encode(localText), {kind: 'doc'}, remoteText, undefined, mode);
            return;
        }
        const merged = await this.merge(baseText, localText, remoteText);
        await this.beforeWrite(mode);
        // Markers left from an earlier conflict merge cleanly with new changes, but must not be
        // uploaded either; nor a merge into a file that git's index still has unmerged
        if (merged.hasConflict || (entry.conflict && (hasConflictMarkers(merged.content) || await this.isUnmerged(path)))) {
            // Overlapping changes: write them with markers and upload nothing until they are resolved.
            await this.local.write(path, encoder.encode(merged.content));
            await this.setEntry(path, {kind: 'doc', base: textHash(remoteText), conflict: true}, 'remote', remoteText);
            await this.store.markConflict?.(path, {base: baseText, local: localText, remote: remoteText});
            summary.conflicts.push(path);
            this.warnedConflicts.delete(path);
            this.ui.log(`${path}: changed on both sides in the same place; the conflicts are marked in the file`);
            return;
        }
        if (!this.uploads) {
            // Overleaf's changes go into the local file; the local ones wait for a push
            const written = merged.content!==localText ? await this.local.write(path, encoder.encode(merged.content)) : stat;
            await this.setEntry(path, {kind: 'doc', base: textHash(remoteText), ...seen(written)}, 'remote', remoteText);
            summary.merged.push(path);
            if (merged.content!==remoteText) { summary.held.push(path); }
            this.ui.log(`${path}: merged the changes made on Overleaf into the local file`);
            return;
        }
        if (merged.content!==remoteText) {
            const sent = merged.content;
            await this.transfers.run(async () => { await this.beforeWrite(mode); await this.remote.writeDoc(path, sent); });
        }
        let written = stat;
        if (merged.content!==localText) {
            // Checked again after the upload, during which git may have taken its lock and written
            // the file. A rerun then reads Overleaf's side with the merged text, and the saved base
            // is still the one before the merge: it merges what git wrote into the merged text, and
            // the local changes, which the merged text holds, are not sent again.
            await this.beforeWrite(mode);
            written = await this.local.write(path, encoder.encode(merged.content));
        }
        await this.setEntry(path, {kind: 'doc', base: textHash(merged.content), ...seen(written)}, 'merge', merged.content);
        summary.merged.push(path);
        this.ui.log(`${path}: merged changes from both sides`);
    }

    /** Put Overleaf's version in place and keep a copy of the local one. */
    private async keepAside(path: string, localContent: Uint8Array | undefined, remote: RemoteEntry,
                            remoteText: string | undefined, remoteContent: Uint8Array | undefined, mode: Mode) {
        const summary = mode.summary;
        await this.beforeWrite(mode);
        const copy = await this.store.keepCopy(path, localContent ?? new Uint8Array());
        try {
            await this.download(path, remote, remoteText, remoteContent, mode);
        } catch (error) {
            // e.g. the download's check met git's lock (StaleReadError): the copy stays, and it can be
            // the only copy of the local version, when git's command replaced the file meanwhile
            this.ui.log(`${path}: the local version is kept at ${copy}, and Overleaf's version was not put in place: ${errorMessage(error)}`);
            throw error;
        }
        summary.downloaded.pop();
        summary.keptAside.push({path, copy});
        this.ui.log(`${path}: differs from Overleaf and the saved state cannot tell which side changed; Overleaf's version is in place, the local one is kept at ${copy}`);
    }

    /** Set the saved state of `path`; `origin` says where a new base came from. */
    private async setEntry(path: string, entry: SavedEntry, origin: Origin, text?: string, content?: Uint8Array) {
        const changed = this.state.entries[path]?.base!==entry.base;
        if (entry.kind==='doc' && text!==undefined && !this.baseTexts.has(entry.base)) {
            this.baseTexts.set(entry.base, text);
            await this.store.writeBase(entry.base, text);
        } else if (entry.kind==='file' && content!==undefined && changed && this.store.writeFileBase) {
            await this.store.writeFileBase(entry.base, content);
        }
        this.state.entries[path] = entry;
        if (changed) { this.noteChange(path, origin); }
        this.scheduleSave();
    }

    /** Whether git's index has `path` unmerged: changes to resolve, which are not uploaded. */
    private async isUnmerged(path: string): Promise<boolean> {
        return await this.store.isUnmerged?.(path) ?? false;
    }

    /** Tell once that `path` waits for its conflicts to be resolved. */
    private blocked(path: string) {
        if (!this.warnedConflicts.has(path)) {
            this.warnedConflicts.add(path);
            this.ui.conflictBlocked(path);
        }
    }

    /** git's pairing of the local renames and moves (`currentRenames`), which the reconciles of one mode ask for once. */
    private localRenames(mode: Mode): Promise<Map<string, string>> {
        mode.renames ??= this.currentRenames();
        return mode.renames;
    }

    /**
     * git's pairing of the synced files gone from the folder with the new files in it, by new
     * path (the store's `renames`; docs/replica-workflows.md, "Renames and moves"), as the folder,
     * the saved state and Overleaf are after this request: a request joins the next pairing
     * while that one has not started, and otherwise starts one after the running one. The
     * requests that come while a pairing runs share the next one, so a burst of events, such as
     * for the files of a moved folder, lists the folder and runs git about twice, not once per file.
     */
    private currentRenames(): Promise<Map<string, string>> {
        let run = this.renamesWaiting;
        if (run===undefined) {
            run = this.renamesTail.then(() => {
                this.renamesWaiting = undefined;
                return this.pairRenames();
            });
            this.renamesWaiting = run;
            this.renamesTail = run.catch(() => {});
        }
        return run;
    }

    /**
     * The local changes that git pairs: a removed path is synced, gone from the folder, and on
     * Overleaf as the same kind of file; a new path is in the folder only. A path that Overleaf
     * lacks, or has already, changed on Overleaf too and is left out: the record puts it into
     * the commit of Overleaf's changes, and the pairs are the ones that the commit of the
     * uploads shows. Only the sync with uploads and a remote side that can rename applies renames.
     */
    private async pairRenames(): Promise<Map<string, string>> {
        const none = new Map<string, string>();
        if (!this.uploads || !this.remote.rename || !this.store.renames || Object.keys(this.state.entries).length===0) { return none; }
        // Overleaf's tree is read only when the folder has both kinds of change
        const localFiles = await this.local.list();
        const gone = Object.entries(this.state.entries).filter(([path, entry]) => !entry.conflict && this.tracked(path) && !localFiles.has(path));
        const fresh = [...localFiles.keys()].filter(path => this.state.entries[path]===undefined && this.tracked(path)
            && !this.state.untracked.includes(path) && !this.firstRunLocalOnly.has(path));
        if (gone.length===0 || fresh.length===0) { return none; }
        const remoteFiles = await this.remote.list();
        const removed = new Map(gone.filter(([path, entry]) => remoteFiles.get(path)?.kind===entry.kind).map(([path, entry]) => [path, entry.base]));
        const added = fresh.filter(path => !remoteFiles.has(path));
        return removed.size>0 && added.length>0 ? await this.store.renames(removed, added) : none;
    }

    /**
     * The rename on Overleaf of `from` to `to`, as git pairs them in the folder, and then the sync
     * of `to`'s content; run in the queues of both paths. When the rename does not happen, `to`
     * syncs as a new file, and `from` is a deletion like any other once `to` is on Overleaf or
     * gone, not while it waits (e.g. for its conflicts to be resolved).
     */
    private async renameLocalPair(from: string, to: string, renames: Map<string, string>, mode: Mode) {
        if (await this.renameOnOverleaf(from, to, mode)) {
            // the base moved with the file: the content syncs as for any file, a change as an edit of it
            await this.reconcile(to, mode);
            return;
        }
        const unpaired: Mode = {...mode, renames: Promise.resolve(new Map([...renames].filter(([p]) => p!==to)))};
        await this.reconcile(to, unpaired);
        if (this.state.entries[to]!==undefined || await this.local.stat(to)===undefined) {
            await this.reconcileReported(from, unpaired);
        }
    }

    /**
     * Rename or move `from` to `to` on Overleaf, as git pairs them in the folder: the file keeps
     * its id there, and a document its comments, tracked changes and history. The saved base
     * moves with it, without the local file's size and time, so that the reconcile of `to` that
     * follows compares the content and sends a change as for any local change: a document's as
     * an edit of it, which leaves the comments on the text it does not touch where they are, and
     * merges with edits made on Overleaf meanwhile; a binary file's as a replacement. Overleaf
     * keeps the rename of a binary file in its history, and gives the replaced file a new id,
     * which its history records as a removal and an addition at `to` (Overleaf's source at
     * e039ad26: ProjectEntityMongoUpdateHandler.replaceFileWithNew); a binary file has no
     * comments or tracked changes. False when the pair no longer holds, or Overleaf refused.
     */
    private async renameOnOverleaf(from: string, to: string, mode: Mode): Promise<boolean> {
        const entry = this.state.entries[from];
        const [remoteFrom, remoteTo, localFrom, localTo] = await Promise.all([
            this.remote.entry(from), this.remote.entry(to), this.local.stat(from), this.local.stat(to)]);
        const still = entry!==undefined && !entry.conflict && this.state.entries[to]===undefined && remoteFrom?.kind===entry.kind
            && remoteTo===undefined && localFrom===undefined && localTo!==undefined && localTo!=='folder';
        if (!still || await this.isUnmerged(from) || await this.isUnmerged(to)) { return false; }
        try {
            // checked inside the transfer, right before the request, also after a wait for a transfer slot
            await this.transfers.run(async () => { await this.beforeWrite(mode); await this.remote.rename!(from, to); });
        } catch (error) {
            // a rename that the check stops waits for the full sync after the wait, or runs again,
            // and is not taken for one that Overleaf refused
            if (error instanceof SyncWaitsError || error instanceof StaleReadError) { throw error; }
            this.ui.log(`${from}: renaming it to ${to} on Overleaf failed (${errorMessage(error)}); ${to} syncs as a new file`);
            return false;
        }
        delete this.state.entries[from];
        this.state.entries[to] = {kind: entry.kind, base: entry.base};
        this.noteChange(from, 'local');
        this.noteChange(to, 'local');
        this.scheduleSave();
        mode.summary.renamed.push({from, to});
        this.ui.log(`${from}: renamed to ${to} on Overleaf, as in the folder`);
        if (parentOf(from)!==parentOf(to)) { await this.removeFolderIfEmpty('remote', parentOf(from)); }
        return true;
    }

    /**
     * The repository's git folder changed: its index, HEAD, or the files of an operation under
     * way. Check again whether the sync may act (`mayAct`), and sync the files that waited for
     * their conflicts to be resolved.
     */
    async gitChanged(): Promise<void> {
        const paths = Object.entries(this.state.entries).filter(([, entry]) => entry.conflict).map(([path]) => path);
        paths.push(...[...this.warnedConflicts].filter(path => !paths.includes(path)));
        const mode = collecting(emptySummary(), {live: true});
        try {
            if (await this.mayAct()!==undefined) { return; }
            await this.scheduleAll(paths, mode);
            await this.applyDeletions(mode);
        } catch (error) {
            mode.summary.failed.push(...paths.map(path => ({path, error: errorMessage(error)})));
        }
        this.scheduleSave();
        this.ui.liveResult(mode.summary);
    }

    private async baseText(hash: string): Promise<string | undefined> {
        let text = this.baseTexts.get(hash);
        if (text===undefined) {
            text = await this.store.readBase(hash);
            if (text!==undefined && textHash(text)===hash) {
                this.baseTexts.set(hash, text);
            } else {
                text = undefined;
            }
        }
        return text;
    }

    private scheduleSave() {
        if (this.stopped || this.saveTimer) { return; }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveNow().catch(error => this.ui.log(`Saving the sync state failed: ${errorMessage(error)}`));
        }, ReplicaSync.saveDelayMs);
    }

    private saveNow(): Promise<void> {
        const save = this.saving.then(async () => {
            await this.local.verify();
            const state: SavedState = JSON.parse(JSON.stringify(this.state));
            await this.store.save(state);
            const keep = new Set<string>();
            for (const entry of Object.values(state.entries)) {
                if (entry.kind==='doc') { keep.add(entry.base); }
            }
            for (const hash of [...this.baseTexts.keys()]) {
                if (!keep.has(hash)) { this.baseTexts.delete(hash); }
            }
            await this.store.pruneBases(keep);
        });
        // the next save runs after this one, whatever this one's result
        this.saving = save.catch(() => {});
        this.scheduleRecord();
        return save;
    }

    /** Record the state once the sync has been idle for `recordQuietMs`. */
    private scheduleRecord() {
        if (!this.store.record || this.stopped) { return; }
        clearTimeout(this.recordTimer);
        this.recordTimer = setTimeout(() => {
            this.recordTimer = undefined;
            if (this.active>0 || this.holds>0) {
                this.scheduleRecord();
                return;
            }
            this.recordNow().catch(error => this.ui.log(`Recording the state failed: ${errorMessage(error)}`));
        }, ReplicaSync.recordQuietMs);
        this.recordTimer.unref?.();
    }

    /**
     * Have the store record the synced state now (the git store's commit of Overleaf's state),
     * after the reconciles under way. Does nothing while held, unless `force`.
     */
    async recordNow({force = false, stopping = false, by, request}: {
        force?: boolean, stopping?: boolean,
        /** a tool's request (`by`, `request`) waits for git's index lock by its rule (`mayAct`) */
        by?: 'tool' | 'user', request?: ToolRequest,
    } = {}): Promise<{waiting?: boolean} | undefined> {
        if (!this.store.record || (this.holds>0 && !force)) { return undefined; }
        if (!stopping) {
            while (this.active>0) {
                await Promise.all([...this.slots.values()].map(slot => slot.tail));
            }
        }
        const run = this.recording.then(async (): Promise<{waiting?: boolean}> => {
            await this.saving;
            // while the sync waits, the record waits too: the changes stay noted for the record after the wait
            if (await this.mayAct(by, request)!==undefined) { return {waiting: true}; }
            const state: SavedState = JSON.parse(JSON.stringify(this.state));
            await this.store.save(state);
            const result = await this.store.record!(state);
            this.onRecorded?.(result);
            if (!result.waiting) {
                // the changes noted before the record are in it; later ones wait for the next
                const changes = this.state.changes ?? {};
                for (const [path, origin] of Object.entries(state.changes ?? {})) {
                    if (changes[path]===origin) { delete changes[path]; }
                }
                await this.store.save(JSON.parse(JSON.stringify(this.state)));
            }
            return result;
        });
        this.recording = run.catch(() => {});
        return run;
    }
}

/** Size and mtime of a local file seen holding the base, and when it was seen. */
function seen(stat: LocalStat | undefined): {size?: number, mtime?: number, checked?: number} {
    return stat===undefined ? {} : {size: stat.size, mtime: stat.mtime, checked: Date.now()};
}

function parentOf(path: string): string {
    return path.slice(0, path.lastIndexOf('/')) || '/';
}

/** One line about what a sync did, e.g. for the log. */
export function describe(summary: SyncSummary): string {
    const parts = [
        [summary.downloaded.length, 'downloaded'],
        [summary.uploaded.length, 'uploaded'],
        [summary.renamed.length, 'renamed'],
        [summary.renamedLocally.length, 'renamed locally'],
        [summary.merged.length, 'merged'],
        [summary.deletedLocal.length, 'deleted locally'],
        [summary.deletedRemote.length, 'deleted on Overleaf'],
        [summary.keptAside.length, 'local versions kept aside'],
        [summary.conflicts.length, 'with conflict markers'],
        [summary.held.length, 'local changes waiting for a push'],
        [summary.untracked.length, 'local-only files left alone'],
        [summary.skippedDeletions.length, 'deletions not confirmed'],
        [summary.deletionsToConfirm.reduce((count, {paths}) => count + paths.length, 0), 'deletions that need a confirmation in the IDE window'],
        [summary.question?.paths.length ?? 0, 'deletions that a question in the IDE window asks about'],
        [summary.failed.length, 'failed'],
        [summary.notChecked, 'not checked'],
    ].filter(([count]) => count!==0).map(([count, what]) => `${count} ${what}`);
    parts.push(`${summary.unchanged} unchanged`);
    if (summary.waitingFor) { parts.push(`waits: ${summary.waitingFor}`); }
    return parts.join(', ');
}
