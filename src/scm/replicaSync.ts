import { createHash } from 'crypto';
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
 * A local file that appears with the content of a synced file that disappeared, as after a
 * rename or a move, is renamed on Overleaf, so that the document keeps its comments and its
 * history there.
 *
 * Without uploads (the push mode "bridge"), local changes stay local until a push through
 * the git bridge brings them to Overleaf; changes made on Overleaf still come in, merged
 * into the local files.
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
    /** All files of the project. */
    list(): Promise<Map<string, RemoteEntry>>,
    /** The file at `path` in the project tree as it is now. */
    entry(path: string): Promise<RemoteEntry | undefined>,
    isFolder(path: string): Promise<boolean>,
    readDoc(path: string): Promise<string>,
    readFile(path: string): Promise<Uint8Array>,
    writeDoc(path: string, text: string): Promise<void>,
    /** Create `path` or replace the binary file there; returns what Overleaf made of it. */
    upload(path: string, content: Uint8Array): Promise<RemoteEntry>,
    /** Rename or move the file at `from` to `to`, keeping it the same document or file on Overleaf. */
    rename?(from: string, to: string): Promise<void>,
    remove(path: string): Promise<void>,
    removeFolderIfEmpty(path: string): Promise<void>,
    /** Resolves once the document updates sent so far are applied on the server. */
    settled(): Promise<void>,
}

/** The local folder. Paths look like '/folder/name.ext'. */
export interface ReplicaLocal {
    /** All files, without the `.overleaf` folder and without ignored paths. */
    list(): Promise<Map<string, LocalStat>>,
    stat(path: string): Promise<LocalStat | 'folder' | undefined>,
    read(path: string): Promise<Uint8Array | undefined>,
    write(path: string, content: Uint8Array): Promise<LocalStat>,
    remove(path: string): Promise<void>,
    removeFolderIfEmpty(path: string): Promise<void>,
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
}

/** Storage for the sync state, inside the local folder's `.overleaf` folder. */
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
}

export interface ReplicaUI {
    log(message: string): void,
    progress(done: number, total: number): void,
    /** Asked before deleting more than `deletionThreshold` files after a startup scan. */
    confirmDeletions(where: 'local' | 'remote', paths: string[]): Promise<boolean>,
    /** Told once about each file that its conflicts keep from being uploaded. */
    conflictBlocked(path: string): void,
    /** What the sync did for changes reported by events (not for `syncAll`). */
    liveResult(summary: SyncSummary): void,
}

export interface SyncSummary {
    downloaded: string[],
    uploaded: string[],
    /** renamed or moved on Overleaf as they were locally */
    renamed: {from: string, to: string}[],
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
    /** deletions that were not confirmed */
    skippedDeletions: string[],
    failed: {path: string, error: string}[],
    unchanged: number,
    /** files a cancelled `syncAll` did not get to */
    notChecked: number,
}

function emptySummary(): SyncSummary {
    return {
        downloaded: [], uploaded: [], renamed: [], merged: [], deletedLocal: [], deletedRemote: [],
        keptAside: [], conflicts: [], held: [], untracked: [], skippedDeletions: [], failed: [], unchanged: 0, notChecked: 0,
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

function errorText(error: any): string {
    return String(error?.message ?? error);
}

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

/** How a reconcile treats deletions: apply them, or collect them for confirmation. */
interface Mode {
    deletions: 'apply' | 'collect',
    collected?: {local: string[], remote: string[]},
    summary: SyncSummary,
    /** started by an event: joins a reconcile of the same path that has not started yet */
    live?: boolean,
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
    /** A full sync asks before deleting more files than this on either side. */
    static deletionThreshold = 5;
    /** Wait this long before acting on a remote deletion: replacing a file on Overleaf removes it and then adds it again. */
    static remoteDeleteDelayMs = 1000;
    /**
     * Wait this long before acting on a local deletion that an event reports: a rename or a move
     * deletes a file and creates another, and the creation is matched with it first.
     */
    static localDeleteDelayMs = 1000;
    static saveDelayMs = 1000;
    /** Record the state (the store's commits) once the sync has been idle this long. */
    static recordQuietMs = 10_000;

    private state: SavedState = {version: 1, entries: {}, untracked: []};
    private loaded?: Promise<void>;
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
    private readonly merge: MergeText;
    /** whether local changes are uploaded; without, they wait for a push through the git bridge */
    private readonly uploads: boolean;
    private readonly onRecorded?: (result: {waiting?: boolean}) => void;

    constructor(
        private readonly remote: ReplicaRemote,
        private readonly local: ReplicaLocal,
        private readonly store: ReplicaStore,
        private readonly ui: ReplicaUI,
        private readonly isIgnored: (path: string) => boolean,
        options: {merge?: MergeText, uploads?: boolean, onRecorded?: (result: {waiting?: boolean}) => void} = {},
    ) {
        this.merge = options.merge ?? gitMergeText;
        this.uploads = options.uploads ?? true;
        this.onRecorded = options.onRecorded;
    }

    private load(): Promise<void> {
        this.loaded ??= (async () => {
            const saved = await this.store.load();
            if (saved?.version===1) {
                this.state = {version: 1, entries: saved.entries ?? {}, untracked: saved.untracked ?? [], changes: saved.changes ?? {}};
            }
            // the state kept before the git backend: its bases are the first record, before anything syncs
            if (Object.values(this.state.changes ?? {}).includes('import')) {
                await this.recordNow();
            }
        })();
        return this.loaded;
    }

    /** Note where the change of a path's base came from, for the store's next record. */
    private noteChange(path: string, origin: Origin) {
        const changes = this.state.changes ??= {};
        const before = changes[path];
        changes[path] = before===undefined || before===origin || before==='import' ? origin : 'merge';
    }

    /** The paths the sync looks after: not ignored, and not inside the `.overleaf` folder. */
    private tracked(path: string): boolean {
        return !path.startsWith('/.overleaf/') && path!=='/.overleaf' && !this.isIgnored(path);
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
        const firstRun = Object.keys(this.state.entries).length===0;
        const [remoteFiles, localFiles] = await Promise.all([this.remote.list(), this.local.list()]);
        const paths = new Set<string>([...remoteFiles.keys(), ...localFiles.keys(), ...Object.keys(this.state.entries)]);
        if (firstRun) {
            for (const path of localFiles.keys()) {
                if (!remoteFiles.has(path)) { this.firstRunLocalOnly.add(path); }
            }
        }
        const summary = emptySummary();
        const mode: Mode = {deletions: 'collect', collected: {local: [], remote: []}, summary};
        for (const path of Object.keys(this.state.entries)) {
            if (!this.tracked(path)) { delete this.state.entries[path]; }
        }
        const todo = [...paths].filter(path => this.tracked(path)).sort();
        this.ui.log(`Sync of ${todo.length} files started${firstRun ? ' (no saved state: first sync)' : ''}.`);

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
        summary.notChecked = todo.length - done;

        // deletions found by the scan: ask before deleting many files at once
        for (const where of ['local', 'remote'] as const) {
            const paths = mode.collected![where];
            if (paths.length===0 || this.stopped || this.cancelled) { continue; }
            const confirmed = paths.length<=ReplicaSync.deletionThreshold || await this.ui.confirmDeletions(where, paths);
            if (!confirmed) {
                summary.skippedDeletions.push(...paths);
                this.ui.log(`Deleting ${paths.length} files ${where==='local' ? 'locally' : 'on Overleaf'} was not confirmed: ${paths.join(', ')}`);
                continue;
            }
            const apply: Mode = {deletions: 'apply', summary};
            await Promise.all(paths.map(path => this.schedule(path, apply)));
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
        for (const path of paths) { void this.localChanged(path); }
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

    private async changed(path: string, remote: boolean): Promise<void> {
        if (this.stopped || path==='' || path==='/') { return; }
        await this.load();
        const paths = await this.expand(path, remote);
        const mode: Mode = {deletions: 'apply', summary: emptySummary(), live: true};
        await Promise.all(paths.filter(p => this.tracked(p)).map(p => this.schedule(p, mode)));
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
     * may still be half written: a periodic scan gets them the next time.
     */
    async flush(scan: boolean, {skipRecentMs = 0, now = Date.now(), record = false} = {}): Promise<SyncSummary> {
        await this.load();
        const summary = emptySummary();
        if (scan) {
            const localFiles = await this.local.list();
            const changed: string[] = [];
            const deleted: string[] = [];
            for (const [path, stat] of localFiles) {
                const entry = this.state.entries[path];
                if (!this.tracked(path) || this.state.untracked.includes(path)) { continue; }
                if (skipRecentMs>0 && now - stat.mtime < skipRecentMs) { continue; }
                if (!entry || entry.size!==stat.size || entry.mtime!==stat.mtime) { changed.push(path); }
            }
            for (const path of Object.keys(this.state.entries)) {
                if (!localFiles.has(path) && this.tracked(path)) { deleted.push(path); }
            }
            const mode: Mode = {deletions: 'apply', summary, live: true};
            // deletions after the rest, so that a renamed file is matched with its new name first
            await Promise.all(changed.map(path => this.schedule(path, mode)));
            await Promise.all(deleted.map(path => this.schedule(path, mode)));
            this.ui.liveResult(mode.summary);
        }
        await Promise.all([...this.slots.values()].map(slot => slot.tail));
        await this.remote.settled();
        if (record) {
            await this.recordNow();
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
        await Promise.all([...this.slots.values()].map(slot => slot.tail));
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        clearTimeout(this.recordTimer);
        this.recordTimer = undefined;
        if (this.loaded) {
            await this.saveNow();
            await this.recordNow({stopping: true}).catch(error => this.ui.log(`Recording the state failed: ${errorText(error)}`));
        }
    }

    /** Upload local files that the first sync left alone because they were not on Overleaf. */
    async uploadUntracked(): Promise<SyncSummary> {
        await this.load();
        const paths = this.state.untracked;
        this.state.untracked = [];
        const summary = emptySummary();
        await Promise.all(paths.map(path => this.schedule(path, {deletions: 'apply', summary})));
        await this.saveNow();
        return summary;
    }

    get untracked(): string[] {
        return [...this.state.untracked];
    }

    /** Run one reconcile of `path` after the ones already scheduled. */
    private schedule(path: string, mode: Mode): Promise<void> {
        let slot = this.slots.get(path);
        if (slot===undefined) {
            slot = {tail: Promise.resolve()};
            this.slots.set(path, slot);
        }
        if (slot.waiting && mode.live) {
            return slot.waiting;
        }
        const own = slot;
        this.active += 1;
        const run = own.tail.then(async () => {
            if (own.waiting===run) { own.waiting = undefined; }
            if (this.stopped) { return; }
            try {
                await this.reconcile(path, mode);
            } catch (error) {
                mode.summary.failed.push({path, error: errorText(error)});
                this.ui.log(`${path}: sync failed: ${errorText(error)}`);
            }
        }).finally(() => { this.active -= 1; });
        own.waiting = run;
        own.tail = run;
        return run;
    }

    /** Run `task` in the queue of `path`, after the reconciles of it that are scheduled. */
    private inQueue<T>(path: string, task: () => Promise<T>): Promise<T> {
        let slot = this.slots.get(path);
        if (slot===undefined) {
            slot = {tail: Promise.resolve()};
            this.slots.set(path, slot);
        }
        this.active += 1;
        const run = slot.tail.then(task).finally(() => { this.active -= 1; });
        slot.tail = run.then(() => {}, () => {});
        slot.waiting = undefined;
        return run;
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
                await this.keepAside(path, localContent ?? await this.local.read(path), remote!, remoteText, remoteContent, summary);
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
                        await this.mergeDoc(path, entry, localText, remoteText!, localStat, summary);
                    } else {
                        this.blocked(path);
                    }
                    return;
                }
                this.warnedConflicts.delete(path);
            }
            if (remoteHash===base) {
                await this.upload(path, localContent ?? await this.local.read(path), localStat, remote!, summary);
            } else if (localHash===base) {
                await this.download(path, remote!, remoteText, remoteContent, summary);
            } else if (remote!.kind==='doc') {
                localContent ??= await this.local.read(path);
                await this.mergeDoc(path, entry!, decoder.decode(localContent), remoteText!, localStat, summary);
            } else {
                await this.keepAside(path, localContent ?? await this.local.read(path), remote!, remoteText, remoteContent, summary);
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
                    const hash = localHash;
                    const from = await this.renamedFrom(path, hash);
                    if (from!==undefined) {
                        await this.inQueue(from, () => this.renameOnOverleaf(from, path, hash, summary));
                    } else {
                        await this.upload(path, localContent ?? await this.local.read(path), localStat, undefined, summary);
                    }
                }
            } else if (mode.deletions==='collect') {
                mode.collected!.local.push(path);
            } else if (localHash===base) {
                await this.local.remove(path);
                delete this.state.entries[path];
                this.noteChange(path, 'remote');
                summary.deletedLocal.push(path);
                this.ui.log(`${path}: deleted locally, as on Overleaf`);
                await this.local.removeFolderIfEmpty(parentOf(path));
            } else {
                // deleted on Overleaf, changed locally: follow Overleaf and keep the local version aside
                const copy = await this.store.keepCopy(path, localContent ?? await this.local.read(path) ?? new Uint8Array());
                await this.local.remove(path);
                delete this.state.entries[path];
                this.noteChange(path, 'remote');
                summary.keptAside.push({path, copy});
                this.ui.log(`${path}: deleted on Overleaf but changed locally; the local version is kept at ${copy}`);
                await this.local.removeFolderIfEmpty(parentOf(path));
            }
            return;
        }

        // only the Overleaf file exists
        if (base===undefined || remoteHash!==base) {
            await this.download(path, remote!, remoteText, remoteContent, summary);
        } else if (mode.deletions==='collect') {
            mode.collected!.remote.push(path);
        } else if (await this.isUnmerged(path)) {
            this.blocked(path);
        } else if (!this.uploads) {
            summary.held.push(path);
        } else {
            await this.transfers.run(() => this.remote.remove(path));
            delete this.state.entries[path];
            this.noteChange(path, 'local');
            summary.deletedRemote.push(path);
            this.ui.log(`${path}: deleted on Overleaf, as locally`);
            await this.remote.removeFolderIfEmpty(parentOf(path)).catch(() => {});
        }
    }

    /** Download `path` and write it locally; returns the content. */
    private async download(path: string, remote: RemoteEntry, text?: string, content?: Uint8Array, summary?: SyncSummary): Promise<Uint8Array> {
        let hash: string;
        if (remote.kind==='doc') {
            text ??= await this.transfers.run(() => this.remote.readDoc(path));
            content = encoder.encode(text);
            hash = textHash(text);
        } else {
            content ??= await this.transfers.run(() => this.remote.readFile(path));
            hash = gitBlobHash(content);
            if (remote.hash && hash!==remote.hash) {
                throw new Error(`the downloaded content does not match the hash Overleaf reports (${hash} instead of ${remote.hash})`);
            }
        }
        if (summary===undefined) {
            return content; // only needed for comparing
        }
        const stat = await this.local.write(path, content);
        await this.setEntry(path, {kind: remote.kind, base: hash, ...stat, checked: Date.now()}, 'remote', text, content);
        summary.downloaded.push(path);
        this.ui.log(`${path}: downloaded`);
        return content;
    }

    /** Upload `content`, read from the local file after its stat `stat` was taken. */
    private async upload(path: string, content: Uint8Array | undefined, stat: LocalStat | undefined,
                         remote: RemoteEntry | undefined, summary: SyncSummary) {
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
            await this.transfers.run(() => this.remote.writeDoc(path, sent));
            kind = 'doc';
        } else {
            const created = await this.transfers.run(() => this.remote.upload(path, content));
            kind = created.kind;
            if (kind==='doc') { text = decoder.decode(content); }
        }
        const hash = kind==='doc' ? textHash(text!) : gitBlobHash(content);
        await this.setEntry(path, {kind, base: hash, ...seen(stat)}, 'local', text, content);
        summary.uploaded.push(path);
        this.ui.log(`${path}: uploaded`);
    }

    private async mergeDoc(path: string, entry: SavedEntry, localText: string, remoteText: string,
                           stat: LocalStat | undefined, summary: SyncSummary) {
        const baseText = await this.baseText(entry.base);
        if (baseText===undefined) {
            await this.keepAside(path, encoder.encode(localText), {kind: 'doc'}, remoteText, undefined, summary);
            return;
        }
        const merged = await this.merge(baseText, localText, remoteText);
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
            await this.transfers.run(() => this.remote.writeDoc(path, sent));
        }
        const written = merged.content!==localText ? await this.local.write(path, encoder.encode(merged.content)) : stat;
        await this.setEntry(path, {kind: 'doc', base: textHash(merged.content), ...seen(written)}, 'merge', merged.content);
        summary.merged.push(path);
        this.ui.log(`${path}: merged changes from both sides`);
    }

    /** Put Overleaf's version in place and keep a copy of the local one. */
    private async keepAside(path: string, localContent: Uint8Array | undefined, remote: RemoteEntry,
                            remoteText: string | undefined, remoteContent: Uint8Array | undefined, summary: SyncSummary) {
        const copy = await this.store.keepCopy(path, localContent ?? new Uint8Array());
        await this.download(path, remote, remoteText, remoteContent, summary);
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

    /**
     * The synced file that a new local file at `path` with content `hash` replaces, as after a
     * rename or a move: a synced path with no local file any more, which Overleaf still has
     * with the same content. Undefined when there is none, or the remote side cannot rename.
     */
    private async renamedFrom(path: string, hash: string): Promise<string | undefined> {
        if (!this.remote.rename || !this.uploads) { return undefined; }
        for (const [from, entry] of Object.entries(this.state.entries)) {
            if (from===path || entry.base!==hash || entry.conflict || !this.tracked(from)) { continue; }
            if (await this.local.stat(from)!==undefined) { continue; }
            const remote = await this.remote.entry(from);
            if (remote===undefined) { continue; }
            const remoteHash = remote.kind==='doc' ? textHash(await this.transfers.run(() => this.remote.readDoc(from)))
                : remote.hash ?? gitBlobHash(await this.transfers.run(() => this.remote.readFile(from)));
            if (remoteHash===hash) { return from; }
        }
        return undefined;
    }

    /** Rename `from` to `to` on Overleaf, as it was renamed locally; else upload `to` and delete `from` as usual. */
    private async renameOnOverleaf(from: string, to: string, hash: string, summary: SyncSummary) {
        const entry = this.state.entries[from];
        const [remoteFrom, remoteTo, localFrom, localTo] = await Promise.all([
            this.remote.entry(from), this.remote.entry(to), this.local.stat(from), this.local.stat(to)]);
        const still = entry!==undefined && entry.base===hash && remoteFrom!==undefined && remoteTo===undefined
            && localFrom===undefined && localTo!==undefined && localTo!=='folder';
        if (still && !await this.isUnmerged(from) && !await this.isUnmerged(to)) {
            try {
                await this.transfers.run(() => this.remote.rename!(from, to));
                delete this.state.entries[from];
                this.state.entries[to] = {...entry, ...seen(localTo as LocalStat)};
                this.noteChange(from, 'local');
                this.noteChange(to, 'local');
                this.scheduleSave();
                summary.renamed.push({from, to});
                this.ui.log(`${from}: renamed to ${to} on Overleaf, as locally`);
                return;
            } catch (error) {
                this.ui.log(`${from}: renaming it to ${to} on Overleaf failed (${errorText(error)}); uploading ${to} instead`);
            }
        }
        const content = await this.local.read(to);
        await this.upload(to, content, localTo==='folder' ? undefined : localTo, undefined, summary);
    }

    /** The git index changed, e.g. conflicts were resolved: sync the files that waited for that. */
    indexChanged(): Promise<void> {
        const paths = Object.entries(this.state.entries).filter(([, entry]) => entry.conflict).map(([path]) => path);
        paths.push(...[...this.warnedConflicts].filter(path => !paths.includes(path)));
        const mode: Mode = {deletions: 'apply', summary: emptySummary(), live: true};
        return Promise.all(paths.map(path => this.schedule(path, mode))).then(() => {
            this.scheduleSave();
            this.ui.liveResult(mode.summary);
        });
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
            this.saveNow().catch(error => this.ui.log(`Saving the sync state failed: ${errorText(error)}`));
        }, ReplicaSync.saveDelayMs);
    }

    private saveNow(): Promise<void> {
        this.saving = this.saving.then(async () => {
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
        this.scheduleRecord();
        return this.saving;
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
            this.recordNow().catch(error => this.ui.log(`Recording the state failed: ${errorText(error)}`));
        }, ReplicaSync.recordQuietMs);
        this.recordTimer.unref?.();
    }

    /**
     * Have the store record the synced state now (the git store's commit of Overleaf's state),
     * after the reconciles under way. Does nothing while held, unless `force`.
     */
    async recordNow({force = false, stopping = false} = {}): Promise<{waiting?: boolean} | undefined> {
        if (!this.store.record || (this.holds>0 && !force)) { return undefined; }
        if (!stopping) {
            while (this.active>0) {
                await Promise.all([...this.slots.values()].map(slot => slot.tail));
            }
        }
        const run = this.recording.then(async () => {
            await this.saving;
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
        [summary.merged.length, 'merged'],
        [summary.deletedLocal.length, 'deleted locally'],
        [summary.deletedRemote.length, 'deleted on Overleaf'],
        [summary.keptAside.length, 'local versions kept aside'],
        [summary.conflicts.length, 'with conflict markers'],
        [summary.held.length, 'local changes waiting for a push'],
        [summary.untracked.length, 'local-only files left alone'],
        [summary.skippedDeletions.length, 'deletions not confirmed'],
        [summary.failed.length, 'failed'],
        [summary.notChecked, 'not checked'],
    ].filter(([count]) => count!==0).map(([count, what]) => `${count} ${what}`);
    parts.push(`${summary.unchanged} unchanged`);
    return parts.join(', ');
}
