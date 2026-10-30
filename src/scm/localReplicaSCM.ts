import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { FileRefEntity, FolderEntity, VirtualFileSystem, __OUTPUTS_ID, parseUri } from '../core/remoteFileSystemProvider';
import {
    describe, LocalStat, RemoteEntry, ReplicaLocal, ReplicaRemote, ReplicaStore, ReplicaSync, ReplicaUI,
    SavedState, SyncSummary,
} from './replicaSync';
import { DEFAULT_IGNORE_PATTERNS } from './ignorePatterns';

const IGNORE_SETTING_KEY = 'ignore-patterns';
/** Where the sync keeps its state inside the local folder. Paths in `.overleaf` are never synced. */
const SYNC_FOLDER = '.overleaf/sync';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let outputChannel: vscode.OutputChannel | undefined;
function log(message: string) {
    outputChannel ??= vscode.window.createOutputChannel('Overleaf Workshop: Local Replica');
    outputChannel.appendLine(`${new Date().toLocaleString()} ${message}`);
}

/** The sync working on each local folder, by the folder's URI. */
const folderSyncs = new Map<string, {sync: ReplicaSync, stopped?: Promise<void>}>();
/** The active providers, so that a compile can wait for their uploads. */
const providers = new Set<LocalReplicaSCMProvider>();

/**
 * Keeps a local folder in sync with the project, in both directions.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private sync?: ReplicaSync;
    private ready?: Promise<vscode.Disposable[]>;
    private fullSync?: Promise<void>;
    private reportProgress?: (done: number, total: number) => void;
    private fullSyncRunning = false;
    private running = 0;
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
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

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
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

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch (error) {
            return undefined;
        }
    }

    /** Write `.overleaf/settings.json` of the workspace's local replica. */
    public static async writeSettings(settings: any): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot.scheme!=='file') { return; }
        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        await vscode.workspace.fs.writeFile(settingUri, Buffer.from(JSON.stringify(settings, null, 4)));
    }

    public static async readSettings(): Promise<any | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (vscode.workspace.workspaceFolders?.length!==1 || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
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

    private async resolveRemote(path: string) {
        try {
            return await this.vfs._resolveUri(this.vfs.pathToUri(path));
        } catch {
            return undefined; // a folder on the way does not exist
        }
    }

    /** Create the folders on Overleaf that `path` needs. */
    private async ensureRemoteFolders(path: string) {
        let folder = '';
        for (const name of path.split('/').filter(Boolean).slice(0, -1)) {
            folder += `/${name}`;
            if ((await this.resolveRemote(folder))?.fileType!=='folder') {
                await this.vfs.mkdir(this.vfs.pathToUri(folder));
            }
        }
    }

    /** Overleaf's side of the sync, through the project tree that the VFS keeps up to date. */
    private remoteSide(): ReplicaRemote {
        const vfs = this.vfs;
        const uri = (path: string) => vfs.pathToUri(path);
        return {
            list: async () => {
                const root = await vfs.init();
                const files = new Map<string, RemoteEntry>();
                const walk = (folder: FolderEntity, prefix: string) => {
                    folder.docs?.forEach(doc => files.set(prefix+doc.name, {kind: 'doc'}));
                    folder.fileRefs?.forEach(file => files.set(prefix+file.name, {kind: 'file', hash: file.hash}));
                    folder.folders?.forEach(sub => {
                        if (sub._id!==__OUTPUTS_ID) { walk(sub, `${prefix}${sub.name}/`); }
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
            readDoc: async (path) => decoder.decode(await vfs.openFile(uri(path))),
            readFile: (path) => vfs.openFile(uri(path)),
            writeDoc: (path, text) => vfs.writeFile(uri(path), encoder.encode(text), false, true),
            upload: async (path, content) => {
                await this.ensureRemoteFolders(path);
                const entity = await vfs.createFile(uri(path), content, true);
                return entity._type==='doc' ? {kind: 'doc'} : {kind: 'file', hash: (entity as FileRefEntity).hash};
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

    /** The local folder's side of the sync. */
    private localSide(): ReplicaLocal {
        const fs = vscode.workspace.fs;
        const uri = (path: string) => vscode.Uri.joinPath(this.baseUri, path);
        const statOf = (stat: vscode.FileStat): LocalStat => ({size: stat.size, mtime: stat.mtime});
        const stat = async (path: string): Promise<LocalStat | 'folder' | undefined> => {
            try {
                const res = await fs.stat(uri(path));
                return (res.type & vscode.FileType.Directory) ? 'folder' : statOf(res);
            } catch {
                return undefined;
            }
        };
        return {
            list: async () => {
                const files = new Map<string, LocalStat>();
                const walk = async (dir: string) => {
                    let items: [string, vscode.FileType][] = [];
                    try { items = await fs.readDirectory(uri(dir)); } catch { return; }
                    await Promise.all(items.map(async ([name, type]) => {
                        const path = dir + name;
                        if (path==='/.overleaf' || this.matchIgnorePatterns(path)) { return; }
                        if (type & vscode.FileType.Directory) {
                            if (!(type & vscode.FileType.SymbolicLink)) { await walk(`${path}/`); }
                        } else if (type & vscode.FileType.File) {
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
                try { return await fs.readFile(uri(path)); } catch { return undefined; }
            },
            write: async (path, content) => {
                await fs.createDirectory(vscode.Uri.joinPath(uri(path), '..'));
                await fs.writeFile(uri(path), content);
                return statOf(await fs.stat(uri(path)));
            },
            remove: async (path) => {
                try {
                    await fs.delete(uri(path), {useTrash: true});
                    return;
                } catch {
                    // no trash here: delete it for good
                }
                try {
                    await fs.delete(uri(path), {useTrash: false});
                } catch (error) {
                    if (await stat(path)!==undefined) { throw error; }
                }
            },
            removeFolderIfEmpty: async (path) => {
                if (path==='/' || path==='') { return; }
                try {
                    if ((await fs.readDirectory(uri(path))).length===0) {
                        await fs.delete(uri(path), {recursive: false, useTrash: false});
                    }
                } catch {
                    // already gone
                }
            },
        };
    }

    /** The sync state, in `.overleaf/sync` inside the local folder, which the sync never uploads. */
    private stateStore(): ReplicaStore {
        const fs = vscode.workspace.fs;
        const dir = vscode.Uri.joinPath(this.baseUri, SYNC_FOLDER);
        const stateUri = vscode.Uri.joinPath(dir, 'state.json');
        const baseUri = (hash: string) => vscode.Uri.joinPath(dir, 'base', hash);
        const project = this.vfs.projectId;
        return {
            load: async () => {
                try {
                    const saved = JSON.parse(decoder.decode(await fs.readFile(stateUri)));
                    return saved.project===project ? saved.state as SavedState : undefined;
                } catch {
                    return undefined;
                }
            },
            save: async (state) => {
                // write a new file and rename it over the old one, so a crash cannot leave half a state
                const tmp = vscode.Uri.joinPath(dir, 'state.json.tmp');
                await fs.createDirectory(dir);
                await fs.writeFile(tmp, encoder.encode(JSON.stringify({project, state})));
                await fs.rename(tmp, stateUri, {overwrite: true});
            },
            readBase: async (hash) => {
                try { return decoder.decode(await fs.readFile(baseUri(hash))); } catch { return undefined; }
            },
            writeBase: async (hash, text) => {
                await fs.createDirectory(vscode.Uri.joinPath(dir, 'base'));
                await fs.writeFile(baseUri(hash), encoder.encode(text));
            },
            pruneBases: async (keep) => {
                let items: [string, vscode.FileType][] = [];
                try { items = await fs.readDirectory(vscode.Uri.joinPath(dir, 'base')); } catch { return; }
                await Promise.all(items.filter(([name]) => !keep.has(name))
                    .map(([name]) => Promise.resolve(fs.delete(baseUri(name))).catch(() => {})));
            },
            keepCopy: async (path, content) => {
                const now = new Date();
                const pad = (n: number) => String(n).padStart(2, '0');
                const stamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
                const copy = `${SYNC_FOLDER}/conflicts/${stamp}${path}`;
                const copyUri = vscode.Uri.joinPath(this.baseUri, copy);
                await fs.createDirectory(vscode.Uri.joinPath(copyUri, '..'));
                await fs.writeFile(copyUri, content);
                return copy;
            },
        };
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
            conflictBlocked: (path) => {
                const open = vscode.l10n.t('Open');
                vscode.window.showWarningMessage(
                    vscode.l10n.t('"{path}" still has conflict markers. It is uploaded to Overleaf once they are resolved and the file is saved.', {path}),
                    open,
                ).then(choice => {
                    if (choice===open) { vscode.window.showTextDocument(vscode.Uri.joinPath(this.baseUri, path)); }
                });
            },
            liveResult: (summary) => this.report(summary),
        };
    }

    /** Tell the user what needs their attention after a sync. */
    private async report(summary: SyncSummary) {
        const list = (paths: string[]) => paths.slice(0, 3).join(', ') + (paths.length>3 ? ', ...' : '');
        const notes: string[] = [];
        if (summary.conflicts.length) {
            notes.push(vscode.l10n.t('{count} files were changed on both sides in the same place and have conflict markers to resolve: {files}.', {count: summary.conflicts.length, files: list(summary.conflicts)}));
        }
        if (summary.keptAside.length) {
            notes.push(vscode.l10n.t('{count} local files differed from Overleaf without saved sync state to tell which side changed; Overleaf\'s version is in place and the local one is kept in {folder}: {files}.', {count: summary.keptAside.length, folder: `${SYNC_FOLDER}/conflicts`, files: list(summary.keptAside.map(k => k.path))}));
        }
        if (summary.failed.length) {
            notes.push(vscode.l10n.t('{count} files could not be synced and keep their local content: {files}.', {count: summary.failed.length, files: list(summary.failed.map(f => f.path))}));
        }
        if (summary.untracked.length) {
            notes.push(vscode.l10n.t('{count} local files are not on Overleaf and were not uploaded: {files}.', {count: summary.untracked.length, files: list(summary.untracked)}));
        }
        if (summary.skippedDeletions.length) {
            notes.push(vscode.l10n.t('{count} deletions were not confirmed and wait for the next sync.', {count: summary.skippedDeletions.length}));
        }
        if (summary.notChecked) {
            notes.push(vscode.l10n.t('The sync was cancelled before {count} files were checked.', {count: summary.notChecked}));
        }
        if (notes.length===0) { return; }

        const showLog = vscode.l10n.t('Show Log');
        const compare = vscode.l10n.t('Compare');
        const open = vscode.l10n.t('Open');
        const upload = vscode.l10n.t('Upload Local-Only Files');
        const actions = [showLog];
        if (summary.keptAside.length) { actions.push(compare); }
        if (summary.conflicts.length) { actions.push(open); }
        if (summary.untracked.length) { actions.push(upload); }
        const choice = await vscode.window.showWarningMessage(notes.join(' '), ...actions);
        if (choice===showLog) {
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

    private async initWatch() {
        // write ".overleaf/settings.json" if not exist
        const settingUri = vscode.Uri.joinPath(this.baseUri, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
        } catch (error) {
            await vscode.workspace.fs.writeFile(settingUri, Buffer.from(
                JSON.stringify({
                    'uri': this.vfs.origin.toString(),
                    'serverName': this.vfs.serverName,
                    'enableCompileNPreview': false,
                    'projectName': this.vfs.projectName,
                }, null, 4)
            ));
        }

        // One sync per folder: a reconnect creates a new provider for the same folder, and
        // its sync starts only after the previous one has stopped.
        const key = this.baseUri.toString();
        const previous = folderSyncs.get(key);
        if (previous) {
            await (previous.stopped ??= previous.sync.stop());
        }
        const sync = new ReplicaSync(this.remoteSide(), this.localSide(), this.stateStore(), this.userInterface(),
                                     path => this.matchIgnorePatterns(path));
        const record: {sync: ReplicaSync, stopped?: Promise<void>} = {sync};
        folderSyncs.set(key, record);
        this.sync = sync;

        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.vfs.origin, '**/*' )
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.baseUri.path, '**/*' )
        );

        const syncOnFileChange = vscode.workspace
            .getConfiguration('overleaf-workshop.localReplica.syncOnFileChange')
            .get<boolean>('enabled', false);
        const onLocal = (uri: vscode.Uri) => {
            const path = this.localPath(uri);
            if (path!==undefined && !path.startsWith('/.overleaf/')) {
                this.track('push', path, sync.localChanged(path));
            }
        };
        const onRemote = (deleted: boolean) => (uri: vscode.Uri) => {
            const path = this.remotePath(uri);
            this.track('pull', path, sync.remoteChanged(path, deleted));
        };

        const listeners: vscode.Disposable[] = [
            // sync from vfs to local
            this.vfsWatcher.onDidChange(onRemote(false)),
            this.vfsWatcher.onDidCreate(onRemote(false)),
            this.vfsWatcher.onDidDelete(onRemote(true)),
            // sync from local to vfs: saves in the editor always, and with `syncOnFileChange`
            // also changes that other programs write; the saved sync state keeps the two
            // from uploading a file twice and our own writes from coming back as uploads
            vscode.workspace.onDidSaveTextDocument(doc => onLocal(doc.uri)),
            ...(syncOnFileChange ? [this.localWatcher.onDidChange(onLocal)] : []),
            this.localWatcher.onDidCreate(onLocal),
            this.localWatcher.onDidDelete(onLocal),
            {dispose: () => {
                providers.delete(this);
                record.stopped ??= sync.stop();
                record.stopped.finally(() => {
                    if (folderSyncs.get(key)===record) { folderSyncs.delete(key); }
                });
            }},
        ];

        // The full sync runs in the background. The listeners above are already active,
        // so changes on either side keep syncing when it fails or is cancelled.
        this.syncAll();
        return listeners;
    }

    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return new Promise(async (resolve, reject) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        this.ready = this.initWatch();
        return this.ready.then((watches) => {
            if (this.vfsWatcher!==undefined && this.localWatcher!==undefined) {
                return [
                    this.vfsWatcher,
                    this.localWatcher,
                    ...watches,
                ];
            } else {
                return [];
            }
        });
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
