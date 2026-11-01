import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { FileRefEntity, FolderEntity, VirtualFileSystem, __OUTPUTS_ID, parseUri } from '../core/remoteFileSystemProvider';
import {
    Deletions, describe, FolderChange, FolderChangedError, LocalStat, RemoteEntry, ReplicaLocal, ReplicaRemote, ReplicaSync,
    ReplicaUI, SyncSummary,
} from './replicaSync';
import { DEFAULT_IGNORE_PATTERNS, isReplicaOwnPath, REPLICA_CONFLICTS_FOLDER, REPLICA_SETTINGS_FILE, REPLICA_TEMPORARY_FOLDER } from './ignorePatterns';
import * as localFs from './localFolderFs';
import { LocalFolderWatcher } from './localFolderWatcher';
import { ControlAnswer, ControlRequest, ReplicaControlServer } from './replicaControl';
import { ReplicaModes, replicaModes } from './replicaModes';
import { GitReplicaStore, OVERLEAF_REF, Person } from './replicaGit';
import type { HistoryUpdate } from '../gitbridge/history';

const IGNORE_SETTING_KEY = 'ignore-patterns';

/**
 * How often a replica that syncs the changes of other programs also scans its folder, in case a
 * watcher missed a change, e.g. when the system's queue of file events overflowed.
 */
const SCAN_INTERVAL_MS = 60_000;
/** A periodic scan leaves out files written this recently, which may still be half written. */
const SCAN_SKIP_RECENT_MS = 2_000;
/** How long the replica remembers what it synced, for tools that ask. */
const RECENT_MS = 10 * 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let outputChannel: vscode.OutputChannel | undefined;
function log(message: string) {
    outputChannel ??= vscode.window.createOutputChannel('Overleaf Workshop: Local Replica');
    outputChannel.appendLine(`${new Date().toLocaleString()} ${message}`);
}

/** The sync working on each local folder, by the folder's URI. */
const folderSyncs = new Map<string, {sync: ReplicaSync, stopped?: Promise<void>}>();
/** The notices about fetch and push modes shown in this session, so that each shows once. */
const modeNoticesShown = new Set<string>();
/** The active providers, so that a compile can wait for their uploads. */
const providers = new Set<LocalReplicaSCMProvider>();

/**
 * Keeps a local folder in sync with the project, in both directions. The folder is a git
 * repository, which records Overleaf's states and merges them with the user's commits
 * (src/scm/replicaGit.ts).
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private sync?: ReplicaSync;
    private store?: GitReplicaStore;
    private ready?: Promise<vscode.Disposable[]>;
    private fullSync?: Promise<void>;
    private reportProgress?: (done: number, total: number) => void;
    private fullSyncRunning = false;
    /** a notice about files that failed to sync is open */
    private failureNoticeOpen = false;
    /** the status bar message that says why the sync waits (ReplicaSync.waitingFor) */
    private waitingMessage?: vscode.Disposable;
    private running = 0;
    /** the IDE's watcher of the local folder, only where Node's watcher cannot watch it */
    private localWatcher?: vscode.FileSystemWatcher;
    /** what reports changes of the local folder: Node's watcher, or the IDE's */
    private watchedBy: 'node' | 'ide' = 'node';
    /** the fetch and push modes in effect (src/scm/replicaModes.ts) */
    private modes: ReplicaModes = {fetch: 'native', push: 'native'};
    private scanning?: Promise<void>;
    /** the files synced in the last RECENT_MS, newest last */
    private readonly recent: {path: string, what: string, at: string}[] = [];
    private ignorePatterns: string[] = [...DEFAULT_IGNORE_PATTERNS];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
        providers.add(this);
    }

    private static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, REPLICA_SETTINGS_FILE);
        try {
            await vscode.workspace.fs.stat(settingUri);
            return vscode.Uri.joinPath(workspaceRoot, path);
        } catch (error) {
            return undefined;
        }
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, REPLICA_SETTINGS_FILE);
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch (error) {
            return undefined;
        }
    }

    /** Write the settings file of the workspace's local replica. */
    public static async writeSettings(settings: any): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot.scheme!=='file') { return; }
        const settingUri = vscode.Uri.joinPath(workspaceRoot, REPLICA_SETTINGS_FILE);
        await vscode.workspace.fs.writeFile(settingUri, Buffer.from(JSON.stringify(settings, null, 4)));
    }

    public static async readSettings(): Promise<any | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (vscode.workspace.workspaceFolders?.length!==1 || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, REPLICA_SETTINGS_FILE);
        try {
            await vscode.workspace.fs.stat(settingUri);
            const content = await vscode.workspace.fs.readFile(settingUri);
            return JSON.parse( new TextDecoder().decode(content) );
        } catch (error) {
            return undefined;
        }
    }

    private matchIgnorePatterns(path: string): boolean {
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if (minimatch(path, pattern, {dot:true})) {
                return true;
            }
        }
        return false;
    }

    /** The path of `uri` inside the local folder, like '/dir/name.ext'; undefined when outside. */
    private localPath(uri: vscode.Uri): string | undefined {
        const base = this.baseUri.path.replace(/\/+$/, '');
        const path = uri.path;
        const inside = process.platform==='win32'
            ? path.toLowerCase().startsWith(`${base.toLowerCase()}/`)
            : path.startsWith(`${base}/`);
        return inside ? path.slice(base.length) : undefined;
    }

    private remotePath(vfsUri: vscode.Uri): string {
        const {pathParts} = parseUri(vfsUri);
        pathParts.at(-1)==='' && pathParts.pop(); // remove the last empty string
        return '/' + pathParts.join('/');
    }

    /**
     * What the project tree has at `path`. Rejects while the project is not connected, and for
     * every failure other than a folder on the way that does not exist: only then is the file
     * known to be absent on Overleaf.
     */
    private async resolveRemote(path: string) {
        if (!this.vfs.connected) { throw this.vfs.notConnectedError(); }
        try {
            return await this.vfs._resolveUri(this.vfs.pathToUri(path));
        } catch (error) {
            // vscode.FileSystemError.FileNotFound, which _resolveUri throws for a missing folder
            if ((error as {code?: unknown} | undefined)?.code==='FileNotFound') { return undefined; }
            throw error;
        }
    }

    /** folders being created on Overleaf, so that uploads into the same new folder create it once */
    private readonly creatingFolders = new Map<string, Promise<void>>();

    /**
     * Create the folders on Overleaf that `path` needs. Uploads run four at a time, and several
     * into the same new folder wait for one creation of it: Overleaf refuses a second one ("file
     * already exists"). A folder that appears meanwhile, made by someone else, is taken as it is.
     */
    private async ensureRemoteFolders(path: string) {
        let folder = '';
        for (const name of path.split('/').filter(Boolean).slice(0, -1)) {
            folder += `/${name}`;
            const current = folder;
            let creating = this.creatingFolders.get(current);
            if (creating===undefined) {
                creating = (async () => {
                    if ((await this.resolveRemote(current))?.fileType==='folder') { return; }
                    try {
                        await this.vfs.mkdir(this.vfs.pathToUri(current));
                    } catch (error) {
                        if ((await this.resolveRemote(current))?.fileType!=='folder') { throw error; }
                    }
                })().finally(() => this.creatingFolders.delete(current));
                this.creatingFolders.set(current, creating);
            }
            await creating;
        }
    }

    /** Overleaf's side of the sync, through the project tree that the VFS keeps up to date. */
    private remoteSide(): ReplicaRemote {
        const vfs = this.vfs;
        const uri = (path: string) => vfs.pathToUri(path);
        // while the project is not connected, a lookup cannot be answered
        const online = () => { if (!vfs.connected) { throw vfs.notConnectedError(); } };
        return {
            disconnected: () => vfs.connected ? undefined : vfs.notConnectedError(),
            list: async () => {
                online();
                const root = await vfs.init();
                const files = new Map<string, RemoteEntry>();
                const walk = (folder: FolderEntity, prefix: string) => {
                    const add = (name: string, entry: RemoteEntry) => {
                        if (!isReplicaOwnPath(prefix + name)) { files.set(prefix + name, entry); }
                    };
                    folder.docs?.forEach(doc => add(doc.name, {kind: 'doc'}));
                    folder.fileRefs?.forEach(file => add(file.name, {kind: 'file', hash: file.hash}));
                    folder.folders?.forEach(sub => {
                        if (sub._id!==__OUTPUTS_ID && !isReplicaOwnPath(`${prefix}${sub.name}`)) { walk(sub, `${prefix}${sub.name}/`); }
                    });
                };
                walk(root.rootFolder[0], '/');
                return files;
            },
            entry: async (path) => {
                const res = await this.resolveRemote(path);
                if (res?.fileType==='doc') { return {kind: 'doc'}; }
                if (res?.fileType==='file') { return {kind: 'file', hash: (res.fileEntity as FileRefEntity).hash}; }
                return undefined;
            },
            isFolder: async (path) => (await this.resolveRemote(path))?.fileType==='folder',
            readDoc: async (path) => { online(); return decoder.decode(await vfs.openFile(uri(path))); },
            readFile: async (path) => { online(); return vfs.openFile(uri(path)); },
            writeDoc: (path, text) => vfs.writeDoc(uri(path), encoder.encode(text)),
            upload: async (path, content) => {
                await this.ensureRemoteFolders(path);
                const entity = await vfs.createFile(uri(path), content, true);
                return entity._type==='doc' ? {kind: 'doc'} : {kind: 'file', hash: (entity as FileRefEntity).hash};
            },
            rename: async (from, to) => {
                // Overleaf renames and moves in separate requests: move first, then rename
                await this.ensureRemoteFolders(to);
                const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
                const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);
                let current = from;
                const step = async (target: string, what: string) => {
                    await vfs.rename(uri(current), uri(target), false);
                    if ((await this.resolveRemote(current))?.fileType!==undefined || (await this.resolveRemote(target))?.fileType===undefined) {
                        throw new Error(`Overleaf did not ${what} ${current} to ${target}`);
                    }
                    current = target;
                };
                if (parent(from)!==parent(to)) { await step(`${parent(to)==='/' ? '' : parent(to)}/${name(from)}`, 'move'); }
                if (name(from)!==name(to)) { await step(to, 'rename'); }
            },
            remove: (path) => vfs.remove(uri(path), true),
            removeFolderIfEmpty: async (path) => {
                const res = path==='/' ? undefined : await this.resolveRemote(path);
                const folder = res?.fileType==='folder' ? res.fileEntity as FolderEntity : undefined;
                if (folder && !folder.docs?.length && !folder.fileRefs?.length && !folder.folders?.length) {
                    await vfs.remove(uri(path), true);
                }
            },
            settled: () => vfs.documentUpdatesSettled(),
        };
    }

    /**
     * The local folder's side of the sync. `start` is what the folder was when the replica
     * started: its identity, and the repository's git folder.
     */
    private localSide(start: {identity: {dev: string, ino: string}, gitDir: string}): ReplicaLocal {
        // Node's own file functions: vscode.workspace.fs waits for the window (src/scm/localFolderFs.ts)
        const fs = localFs;
        const uri = (path: string) => vscode.Uri.joinPath(this.baseUri, path);
        const statOf = (stat: localFs.LocalStat): LocalStat => ({size: stat.size, mtime: stat.mtime});
        const stat = async (path: string): Promise<LocalStat | 'folder' | undefined> => {
            try {
                const res = await fs.stat(uri(path));
                return (res.type & localFs.fileType.directory) ? 'folder' : statOf(res);
            } catch (error) {
                if (fs.isMissing(error)) { return undefined; }
                throw error;
            }
        };
        return {
            list: async () => {
                const files = new Map<string, LocalStat>();
                const walk = async (dir: string) => {
                    let items: [string, number][];
                    try {
                        items = await fs.readDirectory(uri(dir));
                    } catch (error) {
                        // a folder that went away after its parent was read; the replica folder itself must be readable
                        if (dir!=='/' && fs.isMissing(error)) { return; }
                        throw error;
                    }
                    await Promise.all(items.map(async ([name, type]) => {
                        const path = dir + name;
                        if (this.leftOut(path)) { return; }
                        if (type & localFs.fileType.directory) {
                            if (!(type & localFs.fileType.symbolicLink)) { await walk(`${path}/`); }
                        } else if (type & localFs.fileType.file) {
                            const res = await stat(path);
                            if (res!==undefined && res!=='folder') { files.set(path, res); }
                        }
                    }));
                };
                await walk('/');
                return files;
            },
            stat,
            read: async (path) => {
                try {
                    return await fs.readFile(uri(path));
                } catch (error) {
                    if (fs.isMissing(error)) { return undefined; }
                    throw error;
                }
            },
            verify: async () => {
                const folder = this.baseUri.fsPath;
                let now: {dev: string, ino: string} | undefined;
                try {
                    now = await fs.identity(folder);
                } catch (error) {
                    if (!fs.isMissing(error)) { throw error; }
                }
                const settings = uri(REPLICA_SETTINGS_FILE).fsPath;
                const reason: FolderChange | undefined = now===undefined ? 'gone'
                    : now.dev!==start.identity.dev || now.ino!==start.identity.ino ? 'replaced'
                    : !await fs.exists(start.gitDir) ? 'gitFolderGone'
                    : !await fs.exists(settings) ? 'settingsGone'
                    : undefined;
                if (reason===undefined) { return; }
                const problem = {
                    gone: vscode.l10n.t('it is gone'),
                    replaced: vscode.l10n.t('another folder is at its path'),
                    gitFolderGone: vscode.l10n.t('its git folder {folder} is gone', {folder: start.gitDir}),
                    settingsGone: vscode.l10n.t('its settings file {file} is gone', {file: settings}),
                }[reason];
                // verify runs before every step of the sync, so the steps go ahead again once the folder is back
                throw new FolderChangedError(reason, vscode.l10n.t(
                    '"{folder}" is not the folder this replica started with: {problem}. The replica syncs again once that folder is back at this path, with its git folder and its settings file. To sync another folder at this path, reload the window.',
                    {folder, problem}));
            },
            write: async (path, content) => {
                await fs.createDirectory(vscode.Uri.joinPath(uri(path), '..'));
                await fs.writeFile(uri(path), content, this.temporaryFolder);
                return statOf(await fs.stat(uri(path)));
            },
            move: (from, to) => fs.moveFile(uri(from), uri(to)),
            remove: async (path) => {
                // to the system trash: on Linux through gio, without the window; elsewhere only the
                // IDE can move a file there, and that waits for the window
                if (await fs.trash(uri(path))) { return; }
                if (process.platform!=='linux') {
                    try {
                        await vscode.workspace.fs.delete(uri(path), {useTrash: true});
                        return;
                    } catch {
                        // no trash here: delete it for good
                    }
                }
                try {
                    await fs.remove(uri(path));
                } catch (error) {
                    if (await stat(path)!==undefined) { throw error; }
                }
            },
            removeFolderIfEmpty: async (path) => {
                if (path==='/' || path==='') { return; }
                try {
                    if ((await fs.readDirectory(uri(path))).length===0) {
                        await fs.remove(uri(path));
                    }
                } catch {
                    // already gone
                }
            },
        };
    }

    /** Where the local writes go before the rename over their target (localFolderFs.writeFile). */
    private get temporaryFolder(): string {
        return vscode.Uri.joinPath(this.baseUri, REPLICA_TEMPORARY_FOLDER).fsPath;
    }

    /** Whether the sync leaves `path` out: the replica's own folders, and the ignored paths. */
    private leftOut(path: string): boolean {
        return isReplicaOwnPath(path) || this.matchIgnorePatterns(path);
    }

    /** The sync state, in the replica's git repository (src/scm/replicaGit.ts). */
    private gitStore(): GitReplicaStore {
        const vfs = this.vfs;
        let person: Person | undefined;
        const store = new GitReplicaStore({
            folder: this.baseUri.fsPath,
            projectId: vfs.projectId,
            serverName: vfs.serverName,
            ignorePatterns: this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns,
            isIgnored: path => this.leftOut(path),
            history: async () => {
                const res = await vfs.getUpdates();
                if (res===undefined) { throw new Error('the request for the project\'s history updates failed'); }
                return res.updates.map((u): HistoryUpdate => ({
                    fromV: u.fromV, toV: u.toV, endTs: u.meta.end_ts,
                    users: (u.meta.users ?? []).filter(user => user).map(user => ({
                        id: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined, email: user.email,
                    })),
                    origin: u.meta.origin?.kind,
                }));
            },
            // when git has no user.name and user.email: the Overleaf account, as the project lists it
            fallbackUser: () => person,
            log: message => log(`[${vfs.projectName}] ${message}`),
        });
        void vfs.init().then(project => {
            const me = [project.owner, ...(project.members ?? [])].find(member => member?._id===vfs._userId);
            if (me?.email) { person = {name: [me.first_name, me.last_name].filter(Boolean).join(' ') || me.email, email: me.email}; }
        }).catch(() => {});
        return store;
    }

    private userInterface(): ReplicaUI {
        return {
            log: (message) => log(`[${this.vfs.projectName}] ${message}`),
            progress: (done, total) => this.reportProgress?.(done, total),
            confirmDeletions: async (where, paths) => {
                const folder = this.baseUri.fsPath;
                const action = where==='local' ? vscode.l10n.t('Delete Locally') : vscode.l10n.t('Delete on Overleaf');
                const message = where==='local'
                    ? vscode.l10n.t('{count} files were deleted on Overleaf since the last sync. Delete them in "{folder}" too?', {count: paths.length, folder})
                    : vscode.l10n.t('{count} files were deleted in "{folder}" since the last sync. Delete them on Overleaf too?', {count: paths.length, folder});
                const detail = paths.slice(0, 20).join('\n') + (paths.length>20 ? '\n...' : '');
                return await vscode.window.showWarningMessage(message, {modal: true, detail}, action)===action;
            },
            confirmCheckout: async (head, overleaf) => {
                const upload = vscode.l10n.t('Upload to Overleaf');
                const keepWaiting = vscode.l10n.t('Keep Waiting');
                const choice = await vscode.window.showWarningMessage(vscode.l10n.t(
                    'The checked-out commit {head} in "{folder}" does not contain Overleaf\'s recorded state {overleaf} ({ref}), as after a git checkout or reset to an older commit. The replica waits, so that the files of {head} are not uploaded as edits. Upload them to Overleaf, or keep waiting until a commit that contains {overleaf} is checked out?',
                    {head: head.slice(0, 7), overleaf: overleaf.slice(0, 7), ref: OVERLEAF_REF, folder: this.baseUri.fsPath}),
                    upload, keepWaiting);
                return choice===upload;
            },
            waiting: (reason) => {
                this.waitingMessage?.dispose();
                this.waitingMessage = reason===undefined ? undefined : vscode.window.setStatusBarMessage(`$(debug-pause) ${this.waitingText(reason)}`);
            },
            lockStays: (reason, gone) => {
                // a notification that ends with the wait, so that the window does not show the lock after it is gone
                void vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: this.waitingText(reason)}, () => gone);
            },
            conflictBlocked: (path) => {
                const open = vscode.l10n.t('Open');
                vscode.window.showWarningMessage(
                    vscode.l10n.t('"{path}" still has conflict markers. It is uploaded to Overleaf once they are resolved and the file is saved.', {path}),
                    open,
                ).then(choice => {
                    if (choice===open) { vscode.window.showTextDocument(vscode.Uri.joinPath(this.baseUri, path)); }
                });
            },
            liveResult: (summary) => {
                this.remember(summary);
                this.report(summary);
                // in the fetch mode "mixed", the bridge's commit joins a conflict, so that it is between shareable commits
                if (summary.conflicts.length && this.modes.fetch==='mixed') { this.fetchBridge('a conflict'); }
            },
        };
    }

    /** Tell the user what needs their attention after a sync. */
    private async report(summary: SyncSummary) {
        const list = (paths: string[]) => paths.slice(0, 3).join(', ') + (paths.length>3 ? ', ...' : '');
        const notes: string[] = [];
        if (summary.conflicts.length) {
            notes.push(vscode.l10n.t('{count} files were changed on both sides in the same place and have conflicts to resolve: {files}. They are uploaded once the markers are gone and the file is staged (git add).', {count: summary.conflicts.length, files: list(summary.conflicts)}));
        }
        if (summary.keptAside.length) {
            notes.push(vscode.l10n.t('{count} local files differed from Overleaf without saved sync state to tell which side changed; Overleaf\'s version is in place and the local one is kept in {folder}: {files}.', {count: summary.keptAside.length, folder: vscode.Uri.joinPath(this.baseUri, REPLICA_CONFLICTS_FOLDER).fsPath, files: list(summary.keptAside.map(k => k.path))}));
        }
        if (summary.failed.length) {
            notes.push(vscode.l10n.t('{count} files could not be synced and keep their local content: {files} ({error}). They are synced again when the connection is back, or with "Sync Now".', {count: summary.failed.length, files: list(summary.failed.map(f => f.path)), error: summary.failed[0].error}));
        }
        if (summary.untracked.length) {
            notes.push(vscode.l10n.t('{count} local files are not on Overleaf and were not uploaded: {files}.', {count: summary.untracked.length, files: list(summary.untracked)}));
        }
        if (summary.skippedDeletions.length) {
            notes.push(`${this.deletionsDeclined(summary.skippedDeletions.length)}.`);
        }
        for (const deletions of summary.deletionsToConfirm) {
            notes.push(`${this.deletionsWaiting(deletions, false)}: ${list(deletions.paths)}.`);
        }
        if (summary.notChecked) {
            notes.push(vscode.l10n.t('The sync was cancelled before {count} files were checked.', {count: summary.notChecked}));
        }
        if (notes.length===0) { return; }
        // While the connection is gone every save fails: one notice at a time, the log has all
        const onlyFailures = notes.length===1 && summary.failed.length>0;
        if (onlyFailures && this.failureNoticeOpen) { return; }

        const showLog = vscode.l10n.t('Show Log');
        const compare = vscode.l10n.t('Compare');
        const open = vscode.l10n.t('Open');
        const upload = vscode.l10n.t('Upload Local-Only Files');
        const syncNow = vscode.l10n.t('Sync Now');
        const actions = [showLog];
        if (summary.keptAside.length) { actions.push(compare); }
        if (summary.conflicts.length) { actions.push(open); }
        if (summary.untracked.length) { actions.push(upload); }
        if (summary.failed.length || summary.skippedDeletions.length || summary.deletionsToConfirm.length) { actions.push(syncNow); }
        if (onlyFailures) { this.failureNoticeOpen = true; }
        let choice: string | undefined;
        try {
            choice = await vscode.window.showWarningMessage(notes.join(' '), ...actions);
        } finally {
            if (onlyFailures) { this.failureNoticeOpen = false; }
        }
        if (choice===syncNow) {
            await this.syncAll();
        } else if (choice===showLog) {
            outputChannel?.show();
        } else if (choice===compare) {
            const {path, copy} = summary.keptAside[0];
            vscode.commands.executeCommand('vscode.diff',
                vscode.Uri.joinPath(this.baseUri, copy), vscode.Uri.joinPath(this.baseUri, path),
                vscode.l10n.t('{path}: local version ↔ Overleaf', {path}));
        } else if (choice===open) {
            vscode.window.showTextDocument(vscode.Uri.joinPath(this.baseUri, summary.conflicts[0]));
        } else if (choice===upload) {
            await this.uploadUntracked();
        }
    }

    /** Note what a sync did, for tools that ask what happened. */
    private remember(summary: SyncSummary) {
        const at = new Date().toISOString();
        const done: [string, string[]][] = [
            ['uploaded', summary.uploaded], ['downloaded', summary.downloaded], ['merged', summary.merged],
            ['renamed', summary.renamed.map(r => `${r.from} -> ${r.to}`)],
            ['renamed locally', summary.renamedLocally.map(r => `${r.from} -> ${r.to}`)],
            ['deleted locally', summary.deletedLocal], ['deleted on Overleaf', summary.deletedRemote],
            ['failed', summary.failed.map(f => f.path)],
        ];
        for (const [what, paths] of done) {
            paths.forEach(path => this.recent.push({path, what, at}));
        }
        const oldest = new Date(Date.now() - RECENT_MS).toISOString();
        while (this.recent.length>0 && (this.recent[0].at<oldest || this.recent.length>200)) { this.recent.shift(); }
    }

    /** Keep the SCM status on push or pull while event-driven work runs. */
    private track(status: 'push' | 'pull', message: string, work: Promise<void>) {
        this.running += 1;
        this.status = {status, message};
        work.catch(error => log(`[${this.vfs.projectName}] ${message}: ${error}`)).finally(() => {
            this.running -= 1;
            if (this.running===0 && !this.fullSyncRunning) {
                this.status = {status: 'idle', message: ''};
            }
        });
    }

    /** Compare all files on both sides; changes on either side keep syncing whatever happens here. */
    private syncAll(): Promise<void> {
        this.fullSync = this.runSyncAll();
        return this.fullSync;
    }

    private async runSyncAll() {
        const sync = this.sync;
        if (sync===undefined) { return; }
        const retry = vscode.l10n.t('Retry');
        this.fullSyncRunning = true;
        this.status = {status: 'pull', message: vscode.l10n.t('Syncing')};
        try {
            const summary = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Syncing "{folder}" with Overleaf', {folder: this.baseUri.fsPath}),
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => sync.cancel());
                let reported = 0;
                this.reportProgress = (done, total) => {
                    const percent = 100 * done / total;
                    progress.report({increment: percent - reported, message: `${done}/${total}`});
                    reported = percent;
                };
                return await sync.syncAll();
            });
            const changed = summary.downloaded.length + summary.uploaded.length + summary.merged.length
                + summary.deletedLocal.length + summary.deletedRemote.length;
            vscode.window.setStatusBarMessage(
                vscode.l10n.t('$(cloud) Overleaf: {count} files synced, {unchanged} unchanged', {count: changed, unchanged: summary.unchanged}), 10000);
            // not awaited: the sync is over even while the notification waits for an answer
            this.report(summary);
        } catch (error) {
            log(`[${this.vfs.projectName}] The sync failed: ${error}`);
            const message = vscode.l10n.t('The sync of "{folder}" with Overleaf failed: {error}. Changes on either side are still synced as they happen.',
                {folder: this.baseUri.fsPath, error: String((error as Error)?.message ?? error)});
            vscode.window.showWarningMessage(message, retry).then(choice => {
                if (choice===retry) { this.syncAll(); }
            });
        } finally {
            this.reportProgress = undefined;
            this.fullSyncRunning = false;
            if (this.running===0) {
                this.status = {status: 'idle', message: ''};
            }
        }
    }

    private async uploadUntracked() {
        if (this.sync===undefined) { return; }
        const summary = await this.sync.uploadUntracked();
        log(`[${this.vfs.projectName}] Local-only files uploaded: ${describe(summary)}.`);
        this.report(summary);
    }

    /**
     * Wait until local changes made so far have reached Overleaf, e.g. before compiling.
     * Waits for a full sync that is running, which uploads what changed while the editor was closed.
     */
    async flush() {
        if (this.ready===undefined) { return; } // never started, e.g. disabled
        await this.ready;
        await this.fullSync;
        const scan = vscode.workspace
            .getConfiguration('overleaf-workshop.localReplica.syncOnFileChange')
            .get<boolean>('enabled', false);
        await this.sync?.flush(scan);
    }

    /** Wait until the local changes of every replica of `vfs` have reached Overleaf. */
    static async flushAll(vfs: VirtualFileSystem) {
        await Promise.all([...providers].filter(provider => provider.vfs===vfs).map(provider => provider.flush()));
    }

    /**
     * For tools and the "Sync Local Replica Now" command: look for files changed on disk,
     * whatever `syncOnFileChange` says, upload them, wait until Overleaf has acknowledged every
     * local change so far, and answer what the scan synced. `by` says who asks, for the
     * deletions that need a confirmation (ReplicaSync.flush).
     */
    async syncNow(by: 'tool' | 'user' = 'user'): Promise<SyncSummary> {
        if (this.ready===undefined || this.sync===undefined) {
            throw new Error(vscode.l10n.t('This local replica has not started.'));
        }
        await this.ready;
        const question = by==='tool' ? await this.questionComesFirst() : undefined;
        if (question) {
            // the answer names the question at once instead of waiting for the user, also when the
            // user answers it meanwhile
            return await this.sync.flush(false, {by, question});
        }
        await this.fullSync;
        return await this.sync.flush(true, {record: true, by});
    }

    /**
     * For a tool: the deletions that a question open in the window asks about, or one that opens
     * before the full sync under way is done, e.g. the full sync's own question; undefined when
     * the full sync is done first. A tool waits for neither.
     */
    private async questionComesFirst(): Promise<Deletions | undefined> {
        const sync = this.sync!;
        // a question open now comes first, whether or not the full sync is done
        const open = sync.openQuestion;
        if (open) { return open; }
        const question = sync.questionOpened();
        try {
            // when both have settled, Promise.race takes the first of the list: the question
            return await Promise.race([question.opened, (this.fullSync ?? Promise.resolve()).then(() => undefined)]);
        } finally {
            question.dispose();
        }
    }

    /**
     * What a tool's answer, the status and the window say about deletions that wait for the
     * user: a question open in the window (`asked`), or a confirmation that the window has to ask for.
     */
    private deletionsWaiting({where, paths}: Deletions, asked: boolean): string {
        const side = where==='local' ? vscode.l10n.t('in the local folder') : vscode.l10n.t('on Overleaf');
        return asked
            ? vscode.l10n.t('A question in the IDE window asks whether to delete {count} files {side}; answer it there', {count: paths.length, side})
            : vscode.l10n.t('{count} files would be deleted {side}, more than {threshold} at once, and wait for a confirmation in the IDE window ("Sync Local Replica Now")',
                {count: paths.length, side, threshold: ReplicaSync.deletionThreshold});
    }

    /** What a tool's answer, the status and the window say while the sync waits instead of acting on the folder (ReplicaSync.waitingFor). */
    private waitingText(reason: string): string {
        return vscode.l10n.t('The local replica waits: {reason}', {reason});
    }

    /** What a tool's answer and the window say about deletions that the user declined in the window. */
    private deletionsDeclined(count: number): string {
        return vscode.l10n.t('{count} deletions were not confirmed in the IDE window; the next full sync or "Sync Local Replica Now" asks again', {count});
    }

    /** What keeps a sync from being complete, one line each, for a tool's answer. */
    private syncProblems(summary: SyncSummary): string[] {
        return [
            ...summary.failed.map(f => `${f.path}: ${f.error}`),
            ...summary.conflicts.map(path => vscode.l10n.t('{path}: conflict markers to resolve', {path})),
            ...(summary.question ? [`${this.deletionsWaiting(summary.question, true)}: ${summary.question.paths.join(', ')}`] : []),
            ...summary.deletionsToConfirm.map(deletions => `${this.deletionsWaiting(deletions, false)}: ${deletions.paths.join(', ')}`),
            ...(summary.skippedDeletions.length ? [this.deletionsDeclined(summary.skippedDeletions.length)] : []),
            ...(summary.waitingFor ? [this.waitingText(summary.waitingFor)] : []),
        ];
    }

    /** The command "Sync Local Replica Now", for every open replica. */
    static async syncNowCommand() {
        const open = [...providers].filter(provider => provider.sync!==undefined);
        if (open.length===0) {
            vscode.window.showInformationMessage(vscode.l10n.t('No local replica is open.'));
            return;
        }
        for (const provider of open) {
            const folder = provider.baseUri.fsPath;
            try {
                const summary = await provider.syncNow('user');
                vscode.window.setStatusBarMessage(vscode.l10n.t('$(cloud) Overleaf: "{folder}" is in sync: {result}', {folder, result: describe(summary)}), 10000);
                provider.report(summary);
            } catch (error: any) {
                vscode.window.showErrorMessage(vscode.l10n.t('The sync of "{folder}" with Overleaf failed: {error}.', {folder, error: String(error?.message ?? error)}));
            }
        }
    }

    /** Look for files changed on disk that no event reported, unless a full sync or a scan runs. */
    private scanFolder(): Promise<void> | undefined {
        if (this.scanning || this.fullSyncRunning || this.sync===undefined) { return this.scanning; }
        const sync = this.sync;
        this.scanning = sync.flush(true, {skipRecentMs: SCAN_SKIP_RECENT_MS})
            .then(() => {}, error => log(`[${this.vfs.projectName}] The scan of the folder failed: ${error}`))
            .finally(() => { this.scanning = undefined; });
        return this.scanning;
    }

    /**
     * After the sync recorded Overleaf's state: in the fetch mode "bridge", every new state also
     * gets the git bridge's commit, joined with the replica's; in "mixed", only a state that git
     * could not merge into the branch.
     */
    private afterRecord(result: {waiting?: boolean, made?: string[], notMerged?: string}) {
        if (this.modes.fetch==='bridge' && result.made?.length) {
            this.fetchBridge('Overleaf\'s new state');
        } else if (this.modes.fetch==='mixed' && result.notMerged) {
            this.fetchBridge('a merge that git could not make');
        }
    }

    private bridgeFetching?: Promise<void>;
    private bridgeFetchAgain = false;

    /**
     * Fetch the git bridge's newest commit and join it with the replica's commits
     * (node out/sandbox/cli.js replica-bridge), in a process of its own: a request to the
     * bridge takes from seconds to a minute. One at a time; a request meanwhile runs after it.
     */
    private fetchBridge(reason: string, label?: string): Promise<void> {
        if (this.bridgeFetching) {
            this.bridgeFetchAgain = true;
            return this.bridgeFetching;
        }
        const cli = path.join(__dirname, '..', 'sandbox', 'cli.js');
        const args = [cli, 'replica-bridge', '--replica', this.baseUri.fsPath, ...(label!==undefined ? ['--label', label] : [])];
        log(`[${this.vfs.projectName}] Fetching the git bridge's commit (${reason}).`);
        this.bridgeFetching = new Promise<void>(resolve => {
            // the extension host's binary runs as Node with this variable
            // eslint-disable-next-line @typescript-eslint/naming-convention
            execFile(process.execPath, args, {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, timeout: 10 * 60 * 1000}, (error, stdout, stderr) => {
                const said = `${stdout}${stderr}`.trim().split('\n').filter(line => line && !/DEP0044|trace-deprecation/.test(line));
                log(`[${this.vfs.projectName}] The git bridge: ${said.join(' | ') || (error ? String(error) : 'done')}`);
                resolve();
            });
        }).finally(() => {
            this.bridgeFetching = undefined;
            if (this.bridgeFetchAgain) {
                this.bridgeFetchAgain = false;
                void this.fetchBridge('a request made meanwhile');
            }
        });
        return this.bridgeFetching;
    }

    /** The replica's git state, for tools: the checked-out commit, Overleaf's, and the unmerged paths. */
    private async gitState() {
        const git = this.store?.git;
        if (git===undefined) { return undefined; }
        const [head, overleaf, branch, unmerged] = await Promise.all([
            git.commit('HEAD'), git.commit(OVERLEAF_REF),
            git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {allowFailure: true}).then(r => r.stdout.toString('utf8').trim() || undefined),
            git.run(['ls-files', '--unmerged', '-z']).then(r => [...new Set(r.stdout.toString('utf8').split('\0').filter(Boolean).map(x => x.slice(x.indexOf('\t') + 1)))]),
        ]);
        return {head, overleaf, branch, unmerged};
    }

    /** Answer a tool's request on the control socket (src/scm/replicaControl.ts). */
    private async answerTool(request: ControlRequest): Promise<ControlAnswer> {
        const question = this.sync?.openQuestion;
        const waiting = this.sync?.waitingFor;
        const state = {
            folder: this.baseUri.fsPath,
            project: {id: this.vfs.projectId, name: this.vfs.projectName, server: this.vfs.serverName},
            connected: this.vfs.connected,
            watcher: this.watchedBy,
            modes: this.modes,
            fullSyncRunning: this.fullSyncRunning,
            question: question && {...question, message: this.deletionsWaiting(question, true)},
            waiting: waiting && {reason: waiting, message: this.waitingText(waiting)},
        };
        if (request.op==='status') {
            return {ok: true, ...state, git: await this.gitState(), recent: [...this.recent]};
        }
        if (request.op==='land') {
            return {...await this.land(request.commit), ...state, recent: [...this.recent]};
        }
        const summary = await this.syncNow('tool');
        const problems = this.syncProblems(summary);
        const git = await this.gitState();
        return problems.length===0
            ? {ok: true, ...state, summary, git, recent: [...this.recent]}
            : {ok: false, error: problems.join('; '), ...state, summary, git, recent: [...this.recent]};
    }

    /**
     * A native push of `commit`, for tools (replica-land): once Overleaf holds the checked-out
     * commit and the folder has no changes, fast-forward the branch to `commit`, upload what it
     * changed (the sync renames on Overleaf what git shows as renames and moves) and wait for
     * Overleaf's acknowledgements. Then Overleaf's ref is the commit, or a commit on top of it
     * when someone edited meanwhile.
     */
    private async land(commit: string): Promise<ControlAnswer> {
        const sync = this.sync, store = this.store;
        if (sync===undefined || store===undefined || this.ready===undefined) {
            return {ok: false, error: vscode.l10n.t('This local replica has not started.')};
        }
        await this.ready;
        const question = await this.questionComesFirst();
        if (question) {
            const waiting = await sync.flush(false, {by: 'tool', question});
            return {ok: false, error: `the replica is not in sync: ${this.syncProblems(waiting).join('; ')}`, summary: waiting};
        }
        await this.fullSync;
        const git = store.git;
        const before = await sync.flush(true, {record: true, by: 'tool'});
        const problems = this.syncProblems(before);
        if (problems.length) { return {ok: false, error: `the replica is not in sync: ${problems.join('; ')}`, summary: before}; }
        const [head, overleaf, target] = await Promise.all([git.commit('HEAD'), git.commit(OVERLEAF_REF), git.commit(commit)]);
        if (target===undefined) { return {ok: false, error: `${commit} names no commit in the replica's repository`}; }
        if (head===undefined || head!==overleaf) {
            return {ok: false, error: `Overleaf does not hold the checked-out commit (HEAD ${head?.slice(0, 7) ?? 'none'}, ${OVERLEAF_REF} ${overleaf?.slice(0, 7) ?? 'none'}); sync and commit first`, git: await this.gitState()};
        }
        if (target===head) {
            return {ok: true, landed: target, overleaf, summary: before, note: 'Overleaf already holds the commit'};
        }
        if (!await git.isAncestor(head, target)) {
            return {ok: false, error: `${commit} does not descend from the checked-out commit ${head.slice(0, 7)}; merge that commit into it first (git pull --no-rebase, or git merge ${head.slice(0, 7)})`};
        }
        const changes = await git.text(['status', '--porcelain', '--untracked-files=no']);
        if (changes) { return {ok: false, error: `the folder has changes that are not committed:\n${changes}`}; }
        log(`[${this.vfs.projectName}] Landing ${target.slice(0, 7)} on top of ${head.slice(0, 7)}.`);
        sync.hold();
        try {
            // the files the commit deletes are deleted because the commit is landed: that is their confirmation
            const deleted = (await git.run(['diff', '--name-only', '--no-renames', '--diff-filter=D', '-z', head, target]))
                .stdout.toString('utf8').split('\0').filter(Boolean).map(p => `/${p}`);
            await git.ownIndexWrite(() => git.run(['merge', '--ff-only', '--quiet', target]));
            const summary = await sync.flush(true, {by: 'tool', approved: new Set(deleted)});
            const failed = this.syncProblems(summary);
            const recorded = await sync.recordNow({force: true});
            const after = await git.commit(OVERLEAF_REF);
            const held = after!==undefined && (after===target || await git.isAncestor(target, after));
            const ok = failed.length===0 && held && !recorded?.waiting;
            log(`[${this.vfs.projectName}] Landing ${target.slice(0, 7)}: ${describe(summary)}; ${OVERLEAF_REF} is ${after?.slice(0, 7)}.`);
            return ok
                ? {ok: true, landed: target, overleaf: after, summary, editedSince: after!==target}
                : {ok: false, error: failed.length ? failed.join('; ') : `Overleaf does not hold ${target.slice(0, 7)} yet (${OVERLEAF_REF} is ${after?.slice(0, 7)})`, landed: target, overleaf: after, summary};
        } finally {
            sync.release();
        }
    }

    /**
     * Node reports created, changed and removed files alike. Without `syncOnFileChange` only
     * creations and removals sync, as with the IDE's watcher: a file that was synced before and
     * is still there was changed.
     */
    private async localEvent(sync: ReplicaSync, path: string, syncOnFileChange: boolean, onLocal: (path: string) => void) {
        if (syncOnFileChange) {
            onLocal(path);
            return;
        }
        let exists = true;
        try {
            await localFs.stat(vscode.Uri.joinPath(this.baseUri, path));
        } catch (error) {
            // a file that cannot be looked at goes to the sync, which reports why
            if (!localFs.isMissing(error)) { onLocal(path); return; }
            exists = false;
        }
        if (exists !== await sync.knows(path)) { onLocal(path); }
    }

    private async initWatch() {
        /** A step of the start: when it fails, the log says which step and why, and the replica does not start. */
        const step = async <T>(failed: string, run: () => Promise<T>): Promise<T> => {
            try {
                return await run();
            } catch (error) {
                log(`[${this.vfs.projectName}] ${failed}: ${error}`);
                throw error;
            }
        };
        // write the settings file if it does not exist
        const settingUri = vscode.Uri.joinPath(this.baseUri, REPLICA_SETTINGS_FILE);
        await step(`The replica's settings file ${settingUri.fsPath} could not be written`, async () => {
            if (await localFs.exists(settingUri)) { return; }
            await localFs.writeFile(settingUri, Buffer.from(
                JSON.stringify({
                    'uri': this.vfs.origin.toString(),
                    'serverName': this.vfs.serverName,
                    'enableCompileNPreview': false,
                    'projectName': this.vfs.projectName,
                }, null, 4)
            ), this.temporaryFolder);
        });

        // One sync per folder: a reconnect creates a new provider for the same folder, and
        // its sync starts only after the previous one has stopped.
        const key = this.baseUri.toString();
        const previous = folderSyncs.get(key);
        if (previous) {
            await (previous.stopped ??= previous.sync.stop());
        }
        // the temporary files that writes of processes that no longer run left behind, e.g. at a
        // crash; a running writer keeps its files, as another replica of this folder that starts
        // at the same time in this window, or one in another window
        await step(`The leftovers of earlier writes in ${this.temporaryFolder} could not be removed`,
                   () => localFs.removeLeftoverWrites(this.temporaryFolder));
        // the folder as the replica starts: before deleting anything, the sync checks that it still is
        const identity = await step(`The replica folder ${this.baseUri.fsPath} could not be read`, () => localFs.identity(this.baseUri.fsPath));
        const store = this.gitStore();
        const gitDir = await step('The replica\'s git repository could not be opened', () => store.open());
        const replicaSettings = vscode.workspace.getConfiguration('overleaf-workshop.localReplica');
        const {modes, notices} = replicaModes({fetch: replicaSettings.get('fetchMode'), push: replicaSettings.get('pushMode')});
        this.modes = modes;
        const sync = new ReplicaSync(this.remoteSide(), this.localSide({identity, gitDir}), store, this.userInterface(),
                                     path => this.matchIgnorePatterns(path), {
                                         // with pushes through the git bridge, local changes wait for git push
                                         uploads: modes.push==='native',
                                         onRecorded: result => this.afterRecord(result),
                                     });
        // a saved state that cannot be used stops the replica here, before anything syncs; the
        // collection's notice of the failed start says why (scmCollectionProvider.ts)
        try {
            await sync.open();
        } catch (error) {
            log(`[${this.vfs.projectName}] ${String((error as Error)?.message ?? error)}`);
            throw error;
        }
        const record: {sync: ReplicaSync, stopped?: Promise<void>} = {sync};
        folderSyncs.set(key, record);
        this.sync = sync;
        this.store = store;

        const syncOnFileChange = vscode.workspace
            .getConfiguration('overleaf-workshop.localReplica.syncOnFileChange')
            .get<boolean>('enabled', false);
        log(`[${this.vfs.projectName}] Fetch mode ${modes.fetch}, push mode ${modes.push}.`);
        for (const notice of notices) {
            log(`[${this.vfs.projectName}] ${notice}`);
            if (!modeNoticesShown.has(notice)) {
                modeNoticesShown.add(notice);
                void vscode.window.showInformationMessage(vscode.l10n.t('Overleaf Workshop: {0}', notice));
            }
        }
        const onLocal = (path: string) => {
            if (!isReplicaOwnPath(path)) {
                this.track('push', path, sync.localChanged(path));
            }
        };
        const onLocalUri = (uri: vscode.Uri) => {
            const path = this.localPath(uri);
            if (path!==undefined) { onLocal(path); }
        };
        const onRemote = (path: string, deleted: boolean) => {
            this.track('pull', path, sync.remoteChanged(path, deleted));
        };

        const listeners: vscode.Disposable[] = [
            // Overleaf's side: the project reports its changes here directly, not through the
            // window as a file system watcher would. A rename or a move is one change: its
            // Created event names where the file or folder was, and the Deleted event of that
            // path in the same batch belongs to it.
            this.vfs.onDidChangeFiles(events => {
                const renamed = new Map<string, string>();
                for (const event of events) {
                    const from = event.renamedFrom && this.remotePath(event.renamedFrom), to = this.remotePath(event.uri);
                    if (from!==undefined && from!==to) { renamed.set(from, to); }
                }
                for (const [from, to] of renamed) {
                    this.track('pull', to, sync.remoteRenamed(from, to));
                }
                const moved = new Set([...renamed].flat());
                for (const event of events) {
                    const path = this.remotePath(event.uri);
                    if (!moved.has(path)) { onRemote(path, event.type===vscode.FileChangeType.Deleted); }
                }
            }),
            // saves in the editor always sync; the saved sync state keeps a save and the
            // watcher's event of the same change from uploading the file twice, and our own
            // writes from coming back as uploads
            vscode.workspace.onDidSaveTextDocument(doc => onLocalUri(doc.uri)),
        ];

        // The local side: Node's watcher, which reports to the extension host directly. The
        // IDE's watcher only where Node's cannot watch the folder.
        const folderWatcher = new LocalFolderWatcher(
            this.baseUri.fsPath,
            path => { void this.localEvent(sync, path, syncOnFileChange, onLocal); },
            reason => {
                log(`[${this.vfs.projectName}] Looking at the whole folder: ${reason}.`);
                void this.scanFolder();
            },
            isReplicaOwnPath,
        );
        // The repository's git folder: git replaces the index with a new file at each change, and
        // keeps HEAD and the files of an operation under way there. A change checks again whether
        // the sync may act, and syncs the files that waited for their conflicts to be resolved.
        try {
            let timer: NodeJS.Timeout | undefined;
            const gitWatcher = fs.watch(gitDir, {persistent: false}, () => {
                clearTimeout(timer);
                timer = setTimeout(() => { void sync.gitChanged(); }, LocalFolderWatcher.quietMs);
            });
            gitWatcher.on('error', error => {
                log(`[${this.vfs.projectName}] Watching the git folder stopped (${error}); the sync checks git's state when it next acts.`);
                gitWatcher.close();
            });
            listeners.push({dispose: () => { clearTimeout(timer); gitWatcher.close(); }});
        } catch (error) {
            log(`[${this.vfs.projectName}] The git folder cannot be watched (${error}); the sync checks git's state when it next acts.`);
        }
        const watching = folderWatcher.start();
        if (watching.ok) {
            this.watchedBy = 'node';
            listeners.push({dispose: () => folderWatcher.dispose()});
        } else {
            this.watchedBy = 'ide';
            log(`[${this.vfs.projectName}] Node cannot watch "${this.baseUri.fsPath}" (${watching.reason}); the IDE's file events are used, which the window passes on.`);
            this.localWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern( this.baseUri.path, '**/*' )
            );
            listeners.push(
                ...(syncOnFileChange ? [this.localWatcher.onDidChange(onLocalUri)] : []),
                this.localWatcher.onDidCreate(onLocalUri),
                this.localWatcher.onDidDelete(onLocalUri),
            );
        }
        // in case a watcher missed a change
        if (syncOnFileChange) {
            const timer = setInterval(() => { void this.scanFolder(); }, SCAN_INTERVAL_MS);
            timer.unref?.();
            listeners.push({dispose: () => clearInterval(timer)});
        }

        // tools ask for a sync on the control socket
        const control = new ReplicaControlServer(this.baseUri.fsPath, request => this.answerTool(request),
                                                 message => log(`[${this.vfs.projectName}] ${message}`));
        void control.start();
        listeners.push(
            {dispose: () => control.dispose()},
            {dispose: () => {
                this.waitingMessage?.dispose();
                this.waitingMessage = undefined;
                providers.delete(this);
                record.stopped ??= sync.stop();
                record.stopped.finally(() => {
                    if (folderSyncs.get(key)===record) { folderSyncs.delete(key); }
                });
            }},
        );

        // The full sync runs in the background. The listeners above are already active,
        // so changes on either side keep syncing when it fails or is cancelled.
        this.syncAll();
        return listeners;
    }

    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        return localFs.writeFile(vscode.Uri.joinPath(this.baseUri, relPath), content, this.temporaryFolder);
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        return localFs.readFile(vscode.Uri.joinPath(this.baseUri, relPath)).catch(() => undefined);
    }

    get triggers(): Promise<vscode.Disposable[]> {
        this.ready = this.initWatch();
        return this.ready.then((watches) => [
            ...(this.localWatcher ? [this.localWatcher] : []),
            ...watches,
        ]);
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            {
                label: vscode.l10n.t('Sync now'),
                callback: async () => { await this.syncAll(); },
            },
            {
                label: vscode.l10n.t('Upload local-only files ...'),
                callback: async () => {
                    const paths = this.sync?.untracked ?? [];
                    if (paths.length===0) {
                        vscode.window.showInformationMessage(vscode.l10n.t('Every local file is on Overleaf or ignored.'));
                        return;
                    }
                    const upload = vscode.l10n.t('Upload');
                    const choice = await vscode.window.showWarningMessage(
                        vscode.l10n.t('Upload {count} local files that are not on Overleaf?', {count: paths.length}),
                        {modal: true, detail: paths.join('\n')}, upload);
                    if (choice===upload) { await this.uploadUntracked(); }
                },
            },
            {
                label: vscode.l10n.t('Show sync log'),
                callback: async () => {
                    outputChannel ??= vscode.window.createOutputChannel('Overleaf Workshop: Local Replica');
                    outputChannel.show();
                },
            },
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
