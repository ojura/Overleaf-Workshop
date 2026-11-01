/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { BaseAPI, COMPILERS, CompileResponseSchema, MemberEntity, ProjectSettingsSchema } from '../api/base';
import type { CompileRecord } from '../compile/outputFiles';
import { EmitRefusedError, isMissingOpsRefusal, SocketIOAPI, UpdateSchema } from '../api/socketio';
import { applyOps, opsFor, overleafLineEndings, TrackChangesState, updateMeta } from '../utils/docUpdate';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { GlobalStateManager } from '../utils/globalStateManager';
import { ClientManager } from '../collaboration/clientManager';
import { EventBus } from '../utils/eventBus';
import { SCMCollectionProvider } from '../scm/scmCollectionProvider';
import { ExtendedBaseAPI, ProjectLinkedFileProvider, UrlLinkedFileProvider } from '../api/extendedBase';

export const __OUTPUTS_ID = `${ROOT_NAME}-outputs`;

export type FileType = 'doc' | 'file' | 'folder' | 'outputs';
export type FolderKey = 'docs' | 'fileRefs' | 'folders' | 'outputs';
const FolderKeys: {[_type:string]: FolderKey} = {
    'folder': 'folders',
    'doc': 'docs',
    'file': 'fileRefs',
    'outputs': 'outputs',
};

export interface FileEntity {
    _id: string,
    name: string,
    _type?: FileType,
    readonly?: boolean,
}

export interface DocumentEntity extends FileEntity {
    version?: number,
    mtime?: number,
    lastVersion?: number,
    /**
     * The text that the next write of the doc is based on: the writer's text is merged with
     * what changed on Overleaf since. Undefined while `undetermined` is set.
     */
    localCache?: string,
    remoteCache?: string,
    /**
     * `seq` of the connection that this doc was last joined on (see VirtualFileSystem.connections).
     * Overleaf takes an update of a doc only over a connection that joined the doc.
     */
    joinedOn?: number,
    /** the last of this doc's writes and reads from Overleaf, which run one at a time (see VirtualFileSystem.serialize) */
    writes?: Promise<void>,
    /** Set while one of our updates waits for Overleaf's answer (see VirtualFileSystem.attempt). */
    sync?: Attempt,
    /**
     * A write that Overleaf may or may not have applied: its answer was lost, or Overleaf reported
     * an error for the doc while it waited. It is settled from what Overleaf reports before the
     * doc is read from Overleaf or written again, and by documentUpdatesSettled (see
     * settleUnconfirmed).
     */
    unconfirmed?: PendingWrite,
    /**
     * A write with an outcome that cannot be determined (see settleUnconfirmed). It is not sent
     * again, the user is told, and the base of the next write is not known until a reader takes
     * Overleaf's text (see takeRead) or the user chooses to replace Overleaf's text with the
     * editor's (`replace`, see tellUndetermined).
     */
    undetermined?: {write: PendingWrite, reason: string, replace?: boolean, shown?: boolean},
}

interface PendingWrite {
    update: UpdateSchema,
    /** the content the update turns the server's copy into */
    mergeRes: string,
    /** the content written, i.e. what the editor holds */
    content: string,
    /** `localCache` before the write */
    base: string,
    /** when the write was made, for messages */
    madeAt: number,
    /** written through the FileSystemProvider, i.e. an editor's save, not by the local replica (writeDoc) */
    fromEditor: boolean,
    /** how many times the update was sent */
    attempts: number,
    /** `seq` of the connection current at the first attempt (see VirtualFileSystem.connections) */
    firstConnection?: number,
    /** why the last attempt ended without Overleaf confirming the update */
    failure?: string,
    /** why the last question to Overleaf about the update was not answered (see settleUnconfirmed) */
    checkFailure?: string,
    /**
     * Overleaf refused a resend of this write, or reported an error for the doc (otUpdateError)
     * while a resend waited: another resend is not tried (see settleUnconfirmed).
     */
    resendFailed?: boolean,
}

/**
 * How an attempt to send a write ended: Overleaf applied the update at `version`; refused it
 * before queuing it (the emit's callback carried an error); reported an error for the doc while
 * it waited (otUpdateError); or the answer cannot arrive any more.
 */
type Answer =
    | {kind: 'applied', version: number}
    | {kind: 'refused', error: string}
    | {kind: 'rejected', error: string}
    | {kind: 'lost', error: string};

/** One attempt to send a write, waiting for Overleaf's answer (see VirtualFileSystem.attempt). */
interface Attempt {
    write: PendingWrite,
    /** settles with the first answer; later ones are ignored */
    answered: Promise<Answer>,
    answer: (answer: Answer) => void,
    /** ops from others that arrived meanwhile, applied once the doc is settled */
    buffered: UpdateSchema[],
}

/**
 * Overleaf has not confirmed the last write of each of `documents`: the write waits to be
 * settled, or its outcome cannot be determined (see documentUpdatesSettled).
 */
export class UnconfirmedWritesError extends Error {
    constructor(readonly documents: {path: string, reason: string}[]) {
        super(`Overleaf has not confirmed these updates: ${documents.map(d => `${d.path}: ${d.reason}`).join('; ')}`);
        this.name = 'UnconfirmedWritesError';
    }
}

export interface FileRefEntity extends FileEntity {
    linkedFileData: ProjectLinkedFileProvider | UrlLinkedFileProvider | null,
    created: string, //ISO date string
    hash?: string, //git blob SHA-1 of the content
}

export interface OutputFileEntity extends FileEntity {
    path: string, //output file name
    url: string, // `project/${projectId}/user/${userId}/output/${build}/output/${path}`
    type: string, //output file type (postfix)
    build: string, //build id
    // for output.pdf, when the compile asked for PDF caching: its size, and the pieces of the
    // PDF that the download domain serves by their SHA-256 under /content/<contentId>/
    size?: number,
    ranges?: Array<{start: number, end: number, hash: string, objectId?: string}>,
    contentId?: string,
    createdAt?: string,
}

/** A build's output.pdf, as Overleaf's PDF viewer loads it: in ranges from the download domain. */
export interface PdfOutput {
    /** output.pdf on the download domain, with the query Overleaf's viewer uses */
    url: string,
    downloadDomain: string,
    projectId: string,
    file: OutputFileEntity,
}

export interface FolderEntity extends FileEntity {
    docs: Array<DocumentEntity>,
    fileRefs: Array<FileRefEntity>,
    folders: Array<FolderEntity>,
    outputs?: Array<OutputFileEntity>,
}

export interface ProjectEntity {
    _id: string,
    name: string,
    rootDoc_id: string,
    rootFolder: Array<FolderEntity>,
    publicAccessLevel: string, //"tokenBased"
    compiler: string,
    spellCheckLanguage: string,
    deletedDocs: Array<{
        _id: string,
        name: string,
        deletedAt: string,
    }>,
    members: Array<MemberEntity>,
    invites: Array<MemberEntity>,
    owner: MemberEntity,
    features: {[key:string]:any},
    settings: ProjectSettingsSchema,
    /** for whom Overleaf records edits as tracked changes; kept current by toggle-track-changes */
    trackChangesState?: TrackChangesState,
}

export class File implements vscode.FileStat {
    type: vscode.FileType;
    name: string;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: vscode.FilePermission;
    constructor(name: string, type: vscode.FileType, ctime?: number, permissions?:vscode.FilePermission) {
        this.type = type;
        this.name = name;
        this.ctime = ctime || Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.permissions = permissions;
    }
}

export function parseUri(uri: vscode.Uri) {
    const query:any = uri.query.split('&').reduce((acc, v) => {
        const [key,value] = v.split('=');
        return {...acc, [key]:value};
    }, {});
    const [userId, projectId] = [query.user, query.project];
    const _pathParts = uri.path.split('/');
    const serverName = uri.authority;
    const projectName = decodeURIComponent(_pathParts[1]);
    const pathParts = _pathParts.splice(2);
    const identifier = `${userId}/${projectId}/${projectName}`;
    return {userId, projectId, serverName, projectName, identifier, pathParts};
}

export class VirtualFileSystem extends vscode.Disposable {
    private root?: ProjectEntity;
    private currentVersion?: number;
    private context: vscode.ExtensionContext;
    private api: BaseAPI;
    private socket: SocketIOAPI;
    private publicId?: string;
    /** this client's recent connections, numbered in the order they were accepted */
    private connections: {publicId: string, seq: number}[] = [];
    /** `seq` of the connection accepted last; 0 before the first */
    private get connectionSeq(): number {
        return this.connections[this.connections.length-1]?.seq ?? 0;
    }
    /** settles once a connection is accepted again, while the socket is disconnected */
    private reconnected?: {promise: Promise<void>, resolve: () => void};
    /**
     * A last resort: how long an update waits for Overleaf's answer. The wait ends with the
     * answer, which is the op-less otUpdateApplied that Overleaf sends the author once the update
     * is applied, a refusal in the emit's callback, or otUpdateError for the doc; or when the
     * connection is lost. This limit is for an update that Overleaf does not answer at all:
     * document-updater applies a project's queued updates in batches and stops a batch at the
     * first update that fails, real-time tells of the failure only the connections that joined
     * that update's doc, and the updates queued after the batch wait for the project's next
     * update (RealTimeRedisManager.getPendingProjectUpdates, UpdateManager.fetchAndApplyProjectUpdates,
     * DocumentUpdaterController._processErrorFromDocumentUpdater). The value is the one after
     * which Overleaf's editor reports an update as failed when it does not keep an offline copy
     * of the document (FATAL_OP_TIMEOUT in share-js-doc.ts); with the offline copy it does not
     * limit the wait.
     */
    static updateAnswerLimitMs = 45 * 1000;
    /** whether this session has told the user that "\r\n" line endings go up as "\n" */
    private static toldLineEndings = false;

    /**
     * `doc` was written with "\r\n" or "\r" line endings, which go up as "\n". The local
     * replica then writes the file back with "\n" too, as Overleaf holds it, so the user is
     * told once a session why the file changed.
     */
    private lineEndingsNormalized(doc: DocumentEntity) {
        console.log(`${doc.name}: "\\r\\n" line endings written; sent with "\\n", as Overleaf stores them`);
        if (VirtualFileSystem.toldLineEndings) { return; }
        VirtualFileSystem.toldLineEndings = true;
        vscode.window.showInformationMessage(vscode.l10n.t(
            '{0} has Windows line endings (\\r\\n). Overleaf stores \\n, so it was uploaded with \\n, and the local replica writes it back with \\n. Other files with \\r\\n are handled the same way.', doc.name));
    }
    private userId: string;
    private isDirty: boolean = true;
    /** the project has been compiled once since it was opened */
    private compileStarted: boolean = false;
    private initializing?: Promise<ProjectEntity>;
    /** How long a file operation waits for a lost connection to come back before it fails. */
    static reconnectWaitMs = 30 * 1000;
    /** The pause before the second attempt to reconnect; it doubles with each further attempt. */
    static reconnectBaseDelayMs = 1000;
    /** The longest pause between two attempts to reconnect. */
    static reconnectMaxDelayMs = 60 * 1000;
    /** The pause before the first connection's second attempt; it doubles with each further one. */
    static connectRetryBaseMs = 1000;
    /** The project has been joined; from then on a lost connection is made again in the background. */
    private joinedOnce = false;
    /** Set while a lost connection is made again: settles with the project once it is joined. */
    private reconnecting?: {promise: Promise<ProjectEntity>, resolve: (project: ProjectEntity) => void};
    /**
     * Whether the project is joined on a connection that Overleaf accepted, so that an update or
     * a read of a doc can go out now (see readyToSend); also for a tool asking for the state.
     */
    get connected(): boolean {
        return !this.disposed && this.root!==undefined && this.reconnected===undefined;
    }
    /** the tree before the connection was lost; its documents keep their editing state */
    private previousRoot?: ProjectEntity;
    /** why the connection was lost again while a reconnect was still setting up the new one */
    private lostWhileJoining?: string;
    private disposed = false;
    private retryConnection: number = 0;
    private retryTimer?: NodeJS.Timeout;
    /** Whether a "Reconnecting..." notification is currently shown */
    private reconnectingNotification: boolean = false;
    /** Timestamp of last disconnect for debounce */
    private lastDisconnectTime: number = 0;
    /** Whether event handlers have been registered on the current socket */
    private handlersRegistered: boolean = false;
    private outputBuildId?: string;
    /** the last compile on Overleaf, whatever its status */
    lastCompile?: CompileRecord;
    private compileGroup?: string;
    private clsiServerId?: string;
    private pdfDownloadDomain?: string;
    private notify: (events:vscode.FileChangeEvent[])=>void;
    private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    /**
     * The changes of this project's files, as they are reported to the IDE. Listeners in the
     * extension host get them here directly: a file system watcher gets them only after a round
     * trip through the window, which can stop passing file events on.
     */
    readonly onDidChangeFiles = this.changes.event;
    private clientManagerItem?: {manager: ClientManager, triggers: vscode.Disposable[]};
    private scmCollectionItem?: {collection: SCMCollectionProvider, triggers: vscode.Disposable[]};

    public readonly origin: vscode.Uri;
    public readonly projectName: string;
    public readonly serverName: string;
    public readonly projectId: string;

    constructor(context: vscode.ExtensionContext, uri: vscode.Uri, notify: (events:vscode.FileChangeEvent[])=>void) {
        // define the dispose behavior
        super(() => {
            // dispose all triggers of clientManager
            this.clientManagerItem?.triggers.forEach((trigger) => trigger.dispose());
            this.clientManagerItem = undefined;
            // dispose all triggers of scmCollection
            this.scmCollectionItem?.triggers.forEach((trigger) => trigger.dispose());
            this.scmCollectionItem = undefined;
            this.changes.dispose();
            // the updates waiting for an answer end, with their timers
            this.answersLost('the project was closed');
            this.disposed = true;
            // disconnect socketio
            // this.socket.disconnect();
        });

        const {userId,projectId,serverName,projectName} = parseUri(uri);
        this.serverName = serverName;
        this.projectName = projectName;
        this.origin = uri.with({path: '/'+projectName});
        this.userId = userId;
        this.projectId = projectId;
        this.context = context;
        this.notify = (events) => {
            notify(events);
            this.changes.fire(events);
        };

        const res = GlobalStateManager.initSocketIOAPI(this.context, this.serverName, projectId);
        if (res) {
            this.api = res.api;
            this.socket = res.socket;
            this.socket.onConnectionProblem = (reason) => this.connectionLost(reason);
        } else {
            throw new Error( vscode.l10n.t('Cannot init SocketIOAPI for {serverName}', {serverName}) );
        }
    }

    get _userId() {
        return this.userId;
    }

    async init() : Promise<ProjectEntity> {
        if (this.root) {
            return Promise.resolve(this.root);
        }
        if (this.reconnecting) {
            return this.waitForReconnect(this.reconnecting.promise);
        }
        if (!this.initializing) {
            this.initializing = this.initializingPromise;
        }
        return this.initializing;
    }

    /** `reconnected` once the connection is back, or an error after `reconnectWaitMs`. */
    private waitForReconnect<T>(reconnected: Promise<T>): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(
                vscode.l10n.t('Not connected to {serverName}; reconnecting in the background.', {serverName: this.serverName})
            )), VirtualFileSystem.reconnectWaitMs);
        });
        return Promise.race([reconnected, timeout]).finally(() => clearTimeout(timer));
    }

    /** The first connection: a few attempts, then a message with Reload and Retry. */
    private get initializingPromise(): Promise<ProjectEntity> {
        const MAX_RETRIES = 5;
        const BASE_DELAY_MS = VirtualFileSystem.connectRetryBaseMs;

        // if retry connection exhausted, show error
        if (this.retryConnection >= MAX_RETRIES) {
            this.retryConnection = 0;
            this.initializing = undefined;
            this.reconnectingNotification = false;
            vscode.window.showErrorMessage(
                vscode.l10n.t('Connection lost: {serverName}', {serverName:this.serverName}),
                vscode.l10n.t('Reload'),
                vscode.l10n.t('Retry'),
            ).then((choice) => {
                if (choice === vscode.l10n.t('Reload')) {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                } else if (choice === vscode.l10n.t('Retry')) {
                    this.retryConnection = 0;
                    this.socket.init(); // Recreate socket after all auto-reconnect attempts exhausted
                    this.initializing = this.initializingPromise;
                    this.init().catch(() => {});
                }
            });
            throw new Error( vscode.l10n.t('Connection lost') );
        }

        // exponential backoff delay: 1s, 2s, 4s, 8s, 16s
        const delayMs = this.retryConnection > 0 ? Math.min(BASE_DELAY_MS * Math.pow(2, this.retryConnection - 1), 16 * BASE_DELAY_MS) : 0;

        // Show reconnecting notification on first retry
        if (this.retryConnection === 1 && !this.reconnectingNotification) {
            this.reconnectingNotification = true;
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Reconnecting to {serverName}...', {serverName:this.serverName}),
                cancellable: false,
            }, async () => {
                // Keep the notification visible while reconnecting
                await new Promise<void>((resolve) => {
                    const check = () => {
                        // once joined, a later loss has its own notification (reconnectInBackground)
                        if (this.root || this.joinedOnce || this.disposed || this.retryConnection >= MAX_RETRIES) {
                            this.reconnectingNotification = false;
                            resolve();
                        } else {
                            setTimeout(check, 500);
                        }
                    };
                    check();
                });
            });
        }

        // Wait for backoff delay before retrying
        const attemptReconnect = async (): Promise<ProjectEntity> => {
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }

            // Only recreate the socket when the connection scheme has changed
            // (e.g., v1→v2 after connectionRejected). The new socket takes over the event
            // handlers registered so far, so they are registered once only.
            if (this.socket.needsReinit) {
                this.socket.init();
            }

            // Register event handlers once on the current socket
            if (!this.handlersRegistered) {
                this.remoteWatch();
                this.handlersRegistered = true;
            }

            this.previousRoot = this.root ?? this.previousRoot;
            this.root = undefined;
            return this.socket.joinProject(this.projectId)
                .then(project => this.joined(project))
                .catch((err) => {
                    this.retryConnection += 1;
                    return this.initializingPromise;
                });
        };

        return attemptReconnect();
    }

    /** The project was joined on the current connection: take its tree, and set up what depends on it. */
    private async joined(project: ProjectEntity): Promise<ProjectEntity> {
        this.retryConnection = 0;
        this.reconnectingNotification = false;
        // The tree goes into use at once, so that the changes the server reports after the
        // join apply to it. The settings are fetched next; until then the last ones stand in.
        const previousSettings = this.previousRoot?.settings;
        project.settings = previousSettings ?? {learnedWords: [], languages: [], compilers: [...COMPILERS]};
        const adopted = this.adoptDocuments(project);
        this.root = project;
        this.previousRoot = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const settings = (await this.api.getProjectSettings(identity, this.projectId)).settings;
        if (settings) {
            project.settings = settings;
        } else {
            console.warn(`Overleaf Workshop: could not read the settings of ${this.projectName}; using ${previousSettings ? 'the previous ones' : 'the defaults'}`);
        }
        this.joinedOnce = true;
        const activeCondition = (vscode.workspace.workspaceFolders===undefined) || (vscode.workspace.workspaceFolders?.[0].uri.scheme!==ROOT_NAME) || (vscode.workspace.workspaceFolders?.[0].uri===this.origin);
        // Register: [collaboration] ClientManager on Statusbar
        if (activeCondition) {
            if (this.clientManagerItem?.triggers) {
                this.clientManagerItem.triggers.forEach((trigger) => trigger.dispose());
                delete this.clientManagerItem;
            }
            const clientManager = new ClientManager(this, this.context, this.publicId||'', this.socket);
            this.clientManagerItem = {
                manager: clientManager,
                triggers: clientManager.triggers,
            };
        }
        // Register: [scm] SCMCollectionProvider in explorer. A local replica's provider starts
        // with a full sync, which also uploads the changes that failed while disconnected.
        if (activeCondition) {
            if (this.scmCollectionItem?.triggers) {
                this.scmCollectionItem.triggers.forEach((trigger) => trigger.dispose());
                delete this.scmCollectionItem;
            }
            const scmCollection = new SCMCollectionProvider(this, this.context);
            this.scmCollectionItem = {
                collection: scmCollection,
                triggers: scmCollection.triggers,
            };
        }
        // Compile when the project is opened. A reconnect, e.g. after the network
        // dropped or the machine resumed, does not start another compile.
        if (!this.compileStarted) {
            this.compileStarted = true;
            vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`);
        }
        // documents may have changed on the server while disconnected: have them read again
        if (adopted.length > 0) {
            this.notify(adopted.map(path => ({type: vscode.FileChangeType.Changed, uri: this.pathToUri(path)})));
        }
        return project;
    }

    /**
     * Put the documents of the tree before the connection was lost into the new tree, by id,
     * so that their editing state survives: the base an editor's content is merged against,
     * and a write that Overleaf has not confirmed. Their copy of the server's content is
     * dropped and read again on the next use, since updates may have been missed meanwhile.
     * Returns their paths.
     */
    private adoptDocuments(project: ProjectEntity): string[] {
        const previous = this.previousRoot;
        if (previous===undefined) { return []; }
        const docs = new Map<string, DocumentEntity>();
        const collect = (folder: FolderEntity) => {
            folder.docs?.forEach(doc => docs.set(doc._id, doc));
            folder.folders?.forEach(collect);
        };
        collect(previous.rootFolder[0]);
        const paths: string[] = [];
        const adopt = (folder: FolderEntity, prefix: string) => {
            folder.docs = (folder.docs ?? []).map(doc => {
                const old = docs.get(doc._id);
                if (old===undefined) { return doc; }
                old.name = doc.name;
                old.remoteCache = undefined;
                old.version = undefined;
                paths.push(prefix + doc.name);
                return old;
            });
            folder.folders?.forEach(sub => adopt(sub, `${prefix}${sub.name}/`));
        };
        adopt(project.rootFolder[0], '/');
        return paths;
    }

    /**
     * The connection is gone, or looks so: socket.io disconnected, an emit got no answer, or
     * the socket failed. Once the project has been joined, it is joined again in the
     * background on a new connection, with growing pauses and without giving up; file
     * operations meanwhile wait for it, up to `reconnectWaitMs`.
     */
    private connectionLost(reason: string) {
        this.answersLost(reason);
        if (!this.reconnected) {
            let resolve!: () => void;
            const promise = new Promise<void>((r) => { resolve = r; });
            this.reconnected = {promise, resolve};
        }
        if (this.reconnecting && this.root!==undefined) {
            // the reconnect has joined and is still setting up: start again after it
            this.lostWhileJoining = reason;
            return;
        }
        if (!this.joinedOnce || this.reconnecting || this.disposed || this.socket.isUsingAlternativeConnectionScheme) {
            return;
        }
        console.log(`Overleaf Workshop: lost the connection to ${this.serverName} (${reason}); reconnecting`);
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        this.previousRoot = this.root ?? this.previousRoot;
        this.root = undefined;
        let resolve!: (project: ProjectEntity) => void;
        const promise = new Promise<ProjectEntity>((r) => { resolve = r; });
        this.reconnecting = {promise, resolve};
        this.reconnectInBackground(this.reconnecting).catch(error => {
            console.error('Overleaf Workshop: reconnecting failed:', error);
        });
    }

    private async reconnectInBackground(reconnecting: NonNullable<VirtualFileSystem['reconnecting']>) {
        const started = Date.now();
        let shown = false;
        // not from within the event that reported the loss, which may be the old socket's own
        await new Promise(resolve => setImmediate(resolve));
        for (let attempt = 1; !this.disposed; attempt++) {
            if (attempt > 1) {
                if (!shown) {
                    shown = true;
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: vscode.l10n.t('Reconnecting to {serverName}...', {serverName:this.serverName}),
                        cancellable: false,
                    }, () => reconnecting.promise);
                }
                const delay = Math.min(VirtualFileSystem.reconnectBaseDelayMs * Math.pow(2, attempt - 2), VirtualFileSystem.reconnectMaxDelayMs);
                await new Promise(resolve => setTimeout(resolve, delay));
                if (this.disposed) { return; }
            }
            try {
                // A new connection: socket.io may have given up on the old one, or may not
                // have noticed that it is dead. The new socket takes over the event handlers.
                this.socket.init();
                const project = await this.socket.joinProject(this.projectId);
                if (this.disposed) { return; }
                this.lostWhileJoining = undefined;
                await this.joined(project);
                this.reconnecting = undefined;
                reconnecting.resolve(project);
                const lostAgain = this.lostWhileJoining;
                this.lostWhileJoining = undefined;
                if (lostAgain!==undefined) { this.connectionLost(lostAgain); }
                console.log(`Overleaf Workshop: reconnected to ${this.serverName} after ${attempt} attempts, ${Math.round((Date.now() - started) / 1000)} s`);
                if (shown) {
                    vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Reconnected to {serverName}', {serverName: this.serverName}), 10000);
                }
                return;
            } catch (error: any) {
                console.log(`Overleaf Workshop: reconnection attempt ${attempt} failed: ${error?.message ?? error}`);
            }
        }
    }

    get isInvisibleMode() {
        return this.socket.isUsingAlternativeConnectionScheme;
    }

    toggleInvisibleMode() {
        // Clear disconnect debounce to prevent false retry trigger during mode switch
        this.lastDisconnectTime = 0;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        this.socket.toggleAlternativeConnectionScheme(this.origin.toString(), this.root);
        this.socket.disconnect(); // jump to `onDisconnected` handler
    }

    async _resolveUri(uri: vscode.Uri) {
        // resolve path
        const [parentFolder, fileName] = await (async () => {
            const {pathParts} = parseUri(uri);
            const root = await this.init();

            let currentFolder = root.rootFolder[0];
            for (let i = 0; i < pathParts.length-1; i++) {
                const folderName = pathParts[i];
                const folder = currentFolder.folders.find((folder) => folder.name === folderName);
                if (folder) {
                    currentFolder = folder;
                } else {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
            }
            const fileName = pathParts[pathParts.length-1];
            return [currentFolder, fileName];
        })();
        // resolve file
        const [fileEntity, fileType, fileId] = (() => {
            for (const _type of Object.keys(FolderKeys)) {
                let entity = parentFolder[ FolderKeys[_type] ]?.find((entity) => entity.name === fileName);
                if (!fileName && _type==='folder') { entity = parentFolder; }
                if (entity) {
                    return [entity, _type as FileType, entity._id];
                }
            }
            return [];
        })();
        return {parentFolder, fileName, fileEntity, fileType, fileId};
    }

    _resolveById(entityId: string, root?: FolderEntity, path?:string):{
        parentFolder: FolderEntity, fileEntity: FileEntity, fileType:FileType, path:string
    } | undefined {
        if (!this.root) {
            throw vscode.FileSystemError.FileNotFound();
        }
        root = root || this.root.rootFolder[0];
        path = path || '/';

        if (root._id === entityId) {
            return {parentFolder: root, fileType: 'folder', fileEntity: root, path};
        } else {
            // search files in root
            for (const _type of Object.keys(FolderKeys)) {
                const key = FolderKeys[_type];
                if (key==='folders') { continue; }
                const entity = root[key]?.find((entity) => entity._id === entityId);
                if (entity) {
                    return {parentFolder: root, fileType: _type as FileType, fileEntity: entity, path:path+entity.name};
                }
            }
            // recursive search
            for (const folder of root.folders) {
                const res = this._resolveById(entityId, folder, path+folder.name+'/');
                if (res) { return res; }
            }
        }
        return undefined;
    }

    /** The entities of `tree`, the project tree unless given, that `filter` takes, with their paths. */
    walk(filter:(entity:FileEntity)=>boolean, tree: ProjectEntity | undefined = this.root): {entity:FileEntity, path:string}[] {
        const result: {entity:FileEntity, path:string}[] = [];
        if (tree===undefined) { return result; }
        const folders: {entity:FolderEntity, path:string}[] = [{entity:tree.rootFolder[0], path:'/'}];

        // apply filter to root folder
        filter(folders[0].entity) && result.push(folders[0]);
        // walk through all folders
        for (const folder of folders) {
            for (const [key,value] of Object.entries(FolderKeys)) {
                if (value==='folders') {
                    folder.entity[value]?.forEach((entity) => {
                        folders.push({entity, path:folder.path+entity.name+'/'});
                    });
                }
                folder.entity[value]?.forEach((entity) => {
                    entity._type = key as FileType;
                    filter(entity) && result.push({ entity, path:folder.path+entity.name });
                });
            };
        }

        return result;
    }

    private insertEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index===undefined || index<0) {
            parentFolder[key]?.push(entity as any);
        }
    }

    private removeEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private removeEntityById(parentFolder: FolderEntity, fileType:FileType, entityId: string, recursive?:boolean) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entityId);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private remoteWatch(): void {
        this.socket.updateEventHandlers({
            onDisconnected: () => {
                this.answersLost('disconnected');
                if (!this.reconnected) {
                    let resolve!: () => void;
                    const promise = new Promise<void>((r) => { resolve = r; });
                    this.reconnected = {promise, resolve};
                }
                if (this.root===undefined) { return; } // the first connection, or already reconnecting
                console.log("Disconnected");
                if (!this.socket.isUsingAlternativeConnectionScheme) {
                    this.connectionLost('disconnected');
                    return;
                }
                // the alternative connection scheme reconnects as before
                // Debounce: ignore rapid disconnect/reconnect cycles (within 2 seconds)
                const now = Date.now();
                if (now - this.lastDisconnectTime < 2000) {
                    console.log("Disconnected: debounced (too soon since last disconnect)");
                    return;
                }
                this.lastDisconnectTime = now;
                // Clear any pending retry timer
                if (this.retryTimer) {
                    clearTimeout(this.retryTimer);
                }
                // Delay reconnection attempt slightly to allow transient issues to resolve
                this.retryTimer = setTimeout(() => {
                    this.retryConnection += 1;
                    this.initializing = this.initializingPromise;
                }, 1000);
            },
            onTrackChangesToggled: (state:TrackChangesState) => {
                if (this.root) { this.root.trackChangesState = state; }
            },
            onConnectionAccepted: (publicId:string) => {
                this.retryConnection = 0;
                this.reconnectingNotification = false;
                this.lastDisconnectTime = 0;
                if (this.retryTimer) {
                    clearTimeout(this.retryTimer);
                    this.retryTimer = undefined;
                }
                this.publicId = publicId;
                this.connections.push({publicId, seq: this.connectionSeq + 1});
                this.connections.splice(0, this.connections.length - 20);
                this.reconnected?.resolve();
                this.reconnected = undefined;
            },
            onFileCreated: (parentFolderId:string, type:FileType, entity:FileEntity) => {
                const res = this._resolveById(parentFolderId);
                if (res) {
                    const {fileEntity,path} = res;
                    const entityPath = path + entity.name;
                    this.insertEntity(fileEntity as FolderEntity, type, entity);
                    this.notify([
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(entityPath)}
                    ]);
                }
            },
            onFileRenamed: (entityId:string, newName:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {fileEntity} = res;
                    const oldName = fileEntity.name;
                    fileEntity.name = newName;
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(res.path.replace(oldName, newName))}
                    ]);
                }
            },
            onFileRemoved: (entityId:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {parentFolder, fileType, fileEntity} = res;
                    this.removeEntity(parentFolder, fileType, fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)}
                    ]);
                }
            },
            onFileMoved: (entityId:string, folderId:string) => {
                const oldPath = this._resolveById(entityId);
                const newPath = this._resolveById(folderId);
                if (oldPath && newPath) {
                    const newParentFolder = newPath.fileEntity as FolderEntity;
                    this.insertEntity(newParentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(oldPath.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(newPath.path, oldPath.fileEntity.name)}
                    ]);
                }
            },
            onFileChanged: (update:UpdateSchema) => {
                const res = this.root ? this._resolveById(update.doc) : undefined;
                if (res===undefined) { return; }

                const doc = res.fileEntity as DocumentEntity;
                if (update.op===undefined) {
                    // Overleaf's answer to the author of an update: applied at version `v`.
                    // A late answer to an earlier update of the doc has a lower version than
                    // the update waiting now, so it does not count for that one.
                    if (doc.sync && update.v>=doc.sync.write.update.v) {
                        doc.sync.answer({kind: 'applied', version: update.v});
                    }
                    return;
                }
                // While one of our updates waits for its answer, hold the ops of others back
                // until the doc is settled (see settle).
                if (doc.sync) {
                    doc.sync.buffered.push(update);
                    return;
                }
                this.applyRemoteUpdate(res.path, doc, update);
            },
            onUpdateError: (docId: string | undefined, error: string) => {
                // Overleaf could not apply an update of the doc, and disconnects us next. It does
                // not say which update failed: ours, if one waits, may have failed, may have been
                // dropped with the rest of its batch, or may still be queued (see settle).
                const res = docId!==undefined && this.root ? this._resolveById(docId) : undefined;
                console.error(`Overleaf Workshop: Overleaf could not apply an update of ${res?.path ?? docId}: ${error}`);
                (res?.fileEntity as DocumentEntity | undefined)?.sync?.answer({kind: 'rejected', error});
            },
            onSpellCheckLanguageUpdated: (language:string) => {
                if (this.root) {
                    this.root.spellCheckLanguage = language;
                    EventBus.fire('spellCheckLanguageUpdateEvent', {language});
                }
            },
            onCompilerUpdated: (compiler:string) => {
                if (this.root) {
                    this.root.compiler = compiler;
                    EventBus.fire('compilerUpdateEvent', {compiler});
                }
            },
            onRootDocUpdated: (rootDocId:string) => {
                //NOTE: do not sync rootDocId
                // if (this.root) {
                //     this.root.rootDoc_id = rootDocId;
                //     EventBus.fire('rootDocUpdateEvent', {rootDocId});
                // }
            },
        });
    }

    /** Apply a remote op for `doc` in order; resync lazily when one was missed. */
    private applyRemoteUpdate(path: string, doc: DocumentEntity, update: UpdateSchema) {
        if (doc.version===undefined || doc.remoteCache===undefined) { return; }
        // already part of the content we hold, e.g. fetched by a re-join
        if (update.v<doc.version) { return; }
        if (update.v>doc.version) {
            // an op was missed: drop the server-side copy but keep `localCache`, the
            // content the editor is based on, so the next write can still 3-way merge
            doc.remoteCache = undefined;
            this.notify([
                {type: vscode.FileChangeType.Changed, uri: this.pathToUri(path)}
            ]);
            return;
        }
        const content = applyOps(doc.remoteCache, update.op ?? []);
        if (content===undefined) {
            // a delete that does not match our copy: the copy is wrong, read the doc again
            doc.remoteCache = undefined;
            this.notify([
                {type: vscode.FileChangeType.Changed, uri: this.pathToUri(path)}
            ]);
            return;
        }
        doc.version += 1;
        // `localCache` is not advanced here but when the editor actually reloads the doc
        // (see openFile): if the user types before that, the reload is skipped and the
        // next write must still merge this op in rather than overwrite it.
        doc.remoteCache = content;
        this.isDirty = true;
        this.notify([
            {type: vscode.FileChangeType.Changed, uri: this.pathToUri(path)}
        ]);
    }

    pathToUri(...path: string[]): vscode.Uri {
        return vscode.Uri.joinPath(this.origin, ...path);
    }

    async resolve(uri: vscode.Uri): Promise<File> {
        const {fileName, fileEntity, fileType} = await this._resolveUri(uri);
        const readonly = fileEntity?.readonly ? vscode.FilePermission.Readonly : undefined;
        switch (fileType) {
            case undefined:
                throw vscode.FileSystemError.FileNotFound(uri);
            case 'folder':
                return new File(fileName, vscode.FileType.Directory, undefined, readonly);
            case 'file':
                if ((fileEntity as FileRefEntity).linkedFileData!==null) {
                    return new File(fileName, vscode.FileType.File | vscode.FileType.SymbolicLink, Date.parse((fileEntity as FileRefEntity).created), readonly);
                } else {
                    return new File(fileName, vscode.FileType.File, Date.parse((fileEntity as FileRefEntity).created), readonly);
                }
            default:
                return new File(fileName, vscode.FileType.File, undefined, readonly);
        }
    }

    async list(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const {fileEntity} = await this._resolveUri(uri);
        const folder = fileEntity as FolderEntity;
        let results:[string, vscode.FileType][] = [];
        if (folder) {
            Object.values(FolderKeys).forEach((key) => {
                const _type = key==='folders'? vscode.FileType.Directory : vscode.FileType.File;
                folder[key]?.forEach((entity) => {
                    results.push([entity.name, _type]);
                });
            });
        }
        return results;
    }

    async openFile(uri: vscode.Uri): Promise<Uint8Array> {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (!fileEntity) {
            throw vscode.FileSystemError.FileNotFound();
        }
        if (fileType==='folder') {
            throw vscode.FileSystemError.FileIsADirectory(uri);
        }

        if (fileType==='doc') {
            const doc = fileEntity as DocumentEntity;
            if (doc.remoteCache!==undefined && doc.unconfirmed===undefined) {
                const content = doc.remoteCache;
                this.takeRead(doc, uri, content);
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            } else {
                // A write that Overleaf has not confirmed is settled first, so that the reader
                // gets Overleaf's text with that write's outcome known (see settleUnconfirmed).
                const content = await this.serialize(doc, async () => {
                    const write = doc.unconfirmed;
                    if (write) {
                        const outcome = await this.settleUnconfirmed(uri, doc);
                        const editor = this.editorOf(uri);
                        if ((outcome==='applied' || outcome==='resent') && write.fromEditor && editor!==undefined && !editor.isDirty) {
                            // The editor dropped the unsaved text of its save: a save that Overleaf
                            // has not confirmed leaves the editor with unsaved changes until then.
                            vscode.window.showInformationMessage(`${doc.name}: the update of ${VirtualFileSystem.timeOf(write)} that the editor dropped is in Overleaf's text: ${outcome==='applied' ? 'Overleaf had applied it' : 'Overleaf had not applied it, and Overleaf Workshop sent it again when the editor read the file'}. Undo it in the file if you meant to drop it.`);
                        }
                    }
                    return doc.remoteCache ?? (await this.readDoc(doc)).content;
                });
                this.takeRead(doc, uri, content);
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            }
        } else if (fileType==='outputs') {
            const {compileGroup, clsiServerId, pdfDownloadDomain} = this;
            return GlobalStateManager.authenticate(this.context, this.serverName)
            .then((identity) => {
                return this.api.getFileFromClsi(identity, (fileEntity as OutputFileEntity).url, compileGroup || 'standard', clsiServerId, pdfDownloadDomain)
                .then((res) => {
                    if (res.type==='success' && res.content) {
                        EventBus.fire('fileWillOpenEvent', {uri});
                        return res.content;
                    } else {
                        return new Uint8Array(0);
                    }
                });
            });
        } else {
            const fileId = fileEntity._id;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.getFile(identity, this.projectId, fileId);
            if (res.type==='success' && res.content) {
                EventBus.fire('fileWillOpenEvent', {uri});
                return res.content;
            } else {
                // An empty buffer would be taken for the file's content, and the local
                // replica would write it over the real file.
                throw vscode.FileSystemError.Unavailable(`${uri.path}: ${res.message}`);
            }
        }
    }

    /** Create `uri`, or replace the file there; throws when the server refuses. */
    async createFile(uri: vscode.Uri, content:Uint8Array, overwrite?:boolean): Promise<FileEntity> {
        const {parentFolder, fileName, fileEntity} = await this._resolveUri(uri);
        if (fileEntity && !overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
        }

        let res = undefined;
        let message = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);

        if (content.length===0) {
            const _res = await this.api.addDoc(identity, this.projectId, parentFolder._id, fileName);
            res = _res.type==='success' ? _res.entity : undefined;
            message = _res.message;
        } else {
            const parentFolderId = parentFolder._id;
            const _res = await this.api.uploadFile(identity, this.projectId, parentFolderId, fileName, content);
            res = _res.type==='success' ? _res.entity : undefined;
            message = _res.message;
        }
        if (!res || !res._type) {
            throw vscode.FileSystemError.Unavailable(`${uri.path}: ${message ?? 'the server did not create the file'}`);
        }
        // An upload replaces the file of the same name; the server's notice of that may come later.
        for (const key of ['docs', 'fileRefs'] as const) {
            parentFolder[key] = (parentFolder[key] as FileEntity[]).filter(e => e.name!==fileName || e._id===res!._id) as any;
        }
        this.insertEntity(parentFolder, res._type, res);
        this.isDirty = true;
        const inserted = parentFolder[FolderKeys[res._type]]?.find((e:FileEntity) => e._id===res!._id) as FileEntity | undefined;
        if (res._type==='file' && inserted && (inserted as FileRefEntity).hash===undefined) {
            // the hash Overleaf computes for a file: git's blob SHA-1
            (inserted as FileRefEntity).hash = require('crypto').createHash('sha1')
                .update(`blob ${content.byteLength}\0`).update(content).digest('hex');
        }
        this.notify([
            {type: vscode.FileChangeType.Created, uri: uri},
        ]);
        return inserted ?? res;
    }

    async refreshLinkedFile(uri: vscode.Uri) {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType==='file' && fileEntity) {
            if ((fileEntity as FileRefEntity).linkedFileData===null) { return; }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `${vscode.l10n.t('Refreshing')} ${fileEntity.name}`,
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {});
                
                const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
                const res = await (this.api as ExtendedBaseAPI).refreshLinkedFile(identity, this.projectId, fileEntity._id);

                if (res.type==='success' && res.message!==undefined) {
                    // refresh the entity id
                    fileEntity._id = res.message;
                    this.notify([
                        {type: vscode.FileChangeType.Changed, uri: uri},
                    ]);
                    progress.report({message: vscode.l10n.t('Done')});
                } else {
                    if (res.message!==undefined) {
                        throw new Error(res.message);
                    }
                }
            });
        }
    }

    async createLinkedFile(uri: vscode.Uri) {
        const res = await this._resolveUri(uri);
        const parentFolder = res.fileType==='folder' ? res.fileEntity as FolderEntity : res.parentFolder;

        const supportedProviders = [
            vscode.l10n.t('From Another Project'),
            vscode.l10n.t('From External URL'),
        ];
        const selection = await vscode.window.showQuickPick(supportedProviders, {
            placeHolder: vscode.l10n.t('Import file from...'),
        });

        let provider = undefined, entityId = undefined, fileName = undefined, data = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        if (selection === vscode.l10n.t('From Another Project')) {
            provider = 'project_file';
            const allTags = (await this.api.getAllTags(identity)).tags || [];
            const projectId = await vscode.window.showQuickPick(
                (await this.api.userProjectsJson(identity)).projects!
                .filter(project => project.id!==this.projectId)
                .map(project => {
                    let detail = '';
                    for (const tag of allTags) {
                        if (tag.project_ids.includes(project.id)) {
                            detail += `$(tag) ${tag.name} `;
                        }
                    }
                    return {label: project.name, id: project.id, detail};
                }),
                {
                    title: vscode.l10n.t('Select a Project'),
                    ignoreFocusOut: true,
                }
            );
            const filePath = projectId && await vscode.window.showQuickPick(
                (await this.api.projectEntitiesJson(identity, projectId!.id)).entities!.map(entity => entity.path),
                {
                    title: vscode.l10n.t('Select a File'),
                    ignoreFocusOut: true,
                }
            );
            fileName = filePath && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: filePath?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {source_entity_path: filePath!, source_project_id: projectId!.id};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else if (selection === vscode.l10n.t('From External URL')) {
            provider = 'url';
            const url = await vscode.window.showInputBox({
                title: vscode.l10n.t('URL to fetch the file from'),
                placeHolder: 'https://example.com/my-file.png',
                ignoreFocusOut: true,
            });
            fileName = url && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: url?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {url:url!};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else {
            return;
        }

        // insert entity
        const entity = {
            _id: entityId!, name: fileName!, _type: 'file', readonly: false,
            linkedFileData: { provider, ...data! },
            created: new Date().toISOString(),
        } as FileRefEntity;
        this.insertEntity(parentFolder, 'file', entity);
        const {path} = this._resolveById(entityId!)!;
        this.notify([
            {type: vscode.FileChangeType.Created, uri: uri.with({path:`/${this.projectName}${path}`})},
        ]);
    }

    /**
     * FileSystemProvider.writeFile. The text of a document is replaced as writeDoc does it; any
     * other file is uploaded. As the FileSystemProvider interface says, a path that does not
     * exist is FileNotFound without `create`, and an existing file is replaced.
     */
    async writeFile(uri: vscode.Uri, content:Uint8Array, create:boolean, overwrite:boolean) {
        const {fileType} = await this._resolveUri(uri);
        if (fileType==='doc') {
            return this.writeText(uri, content, true);
        }
        if (fileType===undefined && !create) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        await this.createFile(uri, content, fileType===undefined || overwrite || !create);
    }

    /**
     * Replace the text of the document at `uri`, and resolve once Overleaf has applied the
     * update. Rejects with FileNotFound when `uri` is not a document, e.g. once it is deleted or
     * replaced by a binary file. Rejects with an error when Overleaf refused the update or has
     * not confirmed it (see settle), and while the doc has a write with an outcome that cannot
     * be determined and the user has not chosen to make this text Overleaf's (see undetermined).
     */
    writeDoc(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        return this.writeText(uri, content, false);
    }

    /** writeDoc, for an editor's save (`fromEditor`) or for the local replica. */
    private async writeText(uri: vscode.Uri, content: Uint8Array, fromEditor: boolean): Promise<void> {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType!=='doc' || fileEntity===undefined) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        const doc = fileEntity as DocumentEntity;
        // Overleaf stores "\n" line endings, and drops the connection after an update
        // that inserts "\r": send the text Overleaf stores
        const decoded = new TextDecoder().decode(content);
        const text = overleafLineEndings(decoded);
        if (text!==decoded) { this.lineEndingsNormalized(doc); }
        await this.serialize(doc, async () => {
            if (doc.unconfirmed) {
                // Overleaf may or may not have applied an earlier write: settle it first, so
                // that its edit is neither lost nor applied twice.
                await this.settleUnconfirmed(uri, doc);
            }
            await this.readyToSend(doc);
            const undetermined = doc.undetermined;
            if (undetermined) {
                if (!undetermined.replace) {
                    this.tellUndetermined(uri, doc);
                    throw new Error(`${uri.path}: Overleaf Workshop cannot tell whether Overleaf applied the update of ${VirtualFileSystem.timeOf(undetermined.write)} (${undetermined.reason}), so it does not merge this text with Overleaf's. Compare it with Overleaf's text. ${VirtualFileSystem.replaceChoice} in the notice about ${doc.name} makes the editor's text Overleaf's text at the next save, which deletes what others changed in the file since this editor loaded it.`);
                }
                // the user chose to replace Overleaf's text with this one: base it on Overleaf's text as it is now
                doc.localCache = doc.remoteCache;
            }
            const write = this.writeFor(doc, text, fromEditor);
            if (write===undefined) {
                // Overleaf holds this content already: the update would be empty
                doc.localCache = text;
                doc.undetermined = undefined;
                this.notifyChanged(uri);
                return;
            }
            this.isDirty = true;
            await this.settle(uri, doc, this.attempt(doc, write));
        });
    }

    /**
     * The write that turns Overleaf's copy of `doc` into `text`, with the ops of others since the
     * doc's base merged in; undefined when the merged text equals Overleaf's copy.
     */
    private writeFor(doc: DocumentEntity, text: string, fromEditor: boolean): PendingWrite | undefined {
        const dmp = new DiffMatchPatch();
        const patches = dmp.patch_make(doc.localCache!, doc.remoteCache!);
        const mergeRes = dmp.patch_apply(patches, text)[0] as string;
        // placed as Overleaf places edits (semantic cleanup), so comments and tracked
        // changes next to the edit move as with the same edit in the editor or a git push
        const op = opsFor(doc.remoteCache!, mergeRes);
        if (op.length===0) { return undefined; }
        const update = {
            doc: doc._id,
            lastV: doc.lastVersion,
            v: doc.version!,
            // Reference: services/web/frontend/js/vendor/libs/sharejs.js#L1288
            hash: (()=>{
                if (!doc.mtime || Date.now()-doc.mtime>5000) {
                    doc.mtime = Date.now();
                    return require('crypto').createHash('sha1').update(
                        "blob " + mergeRes.length + "\x00" + mergeRes
                    ).digest('hex');
                }
            })() as string,
            op,
            // tracked, as the editor's updates are, when track changes is on for this user
            ...(()=>{
                const meta = updateMeta(this.root?.trackChangesState, this.userId);
                return meta ? {meta} : {};
            })(),
        };
        return {update, mergeRes, content: text, base: doc.localCache!, madeAt: Date.now(), fromEditor, attempts: 0};
    }

    /**
     * Run `task` after the writes and reads from Overleaf of `doc` that came before it, whatever
     * their outcome, so that one of them runs at a time. The caller gets the outcome of `task`.
     */
    private serialize<T>(doc: DocumentEntity, task: () => Promise<T>): Promise<T> {
        const run = (doc.writes ?? Promise.resolve()).then(task);
        doc.writes = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * Wait until a request about a doc can go out (see connected). An update emitted while
     * socket.io reconnects would go out over the next connection, which dupIfSource could not
     * name should it drop before accepting us. Fails as the other file operations do when the
     * connection does not come back (see waitForReconnect).
     */
    private async waitConnected() {
        while (!this.connected) {
            if (this.disposed) {
                throw vscode.FileSystemError.Unavailable(`${this.projectName}: the project is closed`);
            }
            await (this.reconnected ? this.waitForReconnect(this.reconnected.promise) : this.init());
        }
    }

    /**
     * Wait until an update of `doc` can go out: see waitConnected, and the doc must be joined on
     * the current connection with a known version, as Overleaf takes an update only over a
     * connection that joined its doc (real-time's AuthorizationManager).
     */
    private async readyToSend(doc: DocumentEntity) {
        for (;;) {
            await this.waitConnected();
            if (doc.joinedOn===this.connectionSeq && doc.version!==undefined && doc.remoteCache!==undefined) {
                return;
            }
            // never read, read on an earlier connection, or dropped after a missed op
            await this.resyncDoc(doc);
        }
    }

    /**
     * The publicIds of the connections that `write` may have gone out over: the one current at its
     * first attempt or, as socket.io sends an emit made while reconnecting over the next
     * connection, any connection accepted since.
     */
    private sourcesOf(write: PendingWrite): string[] {
        return this.connections.filter(c => c.seq>=write.firstConnection!).map(c => c.publicId);
    }

    /**
     * Send `write` once and wait for the answer: Overleaf's answer to the update (see
     * onFileChanged and onUpdateError), the emit's callback, or the loss of the connection (see
     * answersLost). `updateAnswerLimitMs` is a last resort.
     */
    private attempt(doc: DocumentEntity, write: PendingWrite): Attempt {
        write.firstConnection ??= this.connectionSeq;
        write.attempts += 1;
        // dupIfSource names the connections that a copy sent before may have reached Overleaf
        // over: Overleaf answers such a copy as applied instead of applying the update twice,
        // when the update is at most maxUpdateAge versions behind the doc and Overleaf still keeps
        // the ops since its version (see settleUnconfirmed).
        const update = write.attempts===1 ? write.update : {...write.update, dupIfSource: this.sourcesOf(write)};
        let resolve!: (answer: Answer) => void;
        const answered = new Promise<Answer>((r) => { resolve = r; });
        const limit = setTimeout(() => resolve({
            kind: 'lost', error: `Overleaf did not answer within ${VirtualFileSystem.updateAnswerLimitMs / 1000} s`,
        }), VirtualFileSystem.updateAnswerLimitMs);
        const attempt: Attempt = {
            write, answered, buffered: [],
            answer: (answer) => {
                clearTimeout(limit);
                resolve(answer);
            },
        };
        doc.sync = attempt;
        this.socket.applyOtUpdate(doc._id, update).then(() => {
            // The callback only means that Overleaf queued the update. The alternative connection
            // scheme does not send another answer: there, the callback is all there is.
            if (this.socket.isUsingAlternativeConnectionScheme) {
                attempt.answer({kind: 'applied', version: write.update.v});
            }
        }, (error: any) => attempt.answer(error instanceof EmitRefusedError
            ? {kind: 'refused', error: error.message}
            : {kind: 'lost', error: error?.message ?? String(error)}));
        return attempt;
    }

    /**
     * Settle `doc` with the answer to `attempt`, and throw unless Overleaf applied the update.
     * - Applied: the written content is the doc's base, and Overleaf's copy is known again.
     * - Refused at its first attempt: real-time refuses an update before it queues it
     *   (WebsocketController.applyOtUpdate), so it is not applied and will not be; a redis
     *   failure in queueChange's second push is the one exception, after which the update is
     *   queued (DocumentUpdaterManager.queueChange). The doc's base reverts to the one from
     *   before the write, so the next write of the doc carries the edit.
     * - Otherwise Overleaf may or may not apply it: the base reverts to the one from before the
     *   write, the editor is not reloaded over the edit, and the write is kept until it is
     *   settled from what Overleaf reports (see settleUnconfirmed), which happens before the doc
     *   is read from Overleaf or written again.
     */
    private async settle(uri: vscode.Uri, doc: DocumentEntity, attempt: Attempt): Promise<void> {
        const answer = await attempt.answered;
        const write = attempt.write;
        try {
            if (answer.kind==='applied') {
                doc.unconfirmed = undefined;
                doc.undetermined = undefined;
                doc.localCache = write.content;
                if (answer.version===write.update.v && doc.version===write.update.v && doc.remoteCache!==undefined) {
                    // applied as sent, to the copy it was made for: that copy is now `mergeRes`
                    doc.lastVersion = answer.version;
                    doc.version = answer.version + 1;
                    doc.remoteCache = write.mergeRes;
                } else {
                    // Ops from others went first and ours was transformed against them, or the
                    // copy was read again meanwhile: read the doc back. The update is applied
                    // either way; should the read fail, the doc is read on its next use.
                    await this.resyncDoc(doc).catch(() => {
                        doc.remoteCache = undefined;
                        doc.version = undefined;
                    });
                }
                // `mergeRes` may carry ops from others merged in, which the editor shows once it reloads
                this.notifyChanged(uri);
                return;
            }
            doc.localCache = write.base;
            if (answer.kind==='refused' && write.attempts===1) {
                doc.unconfirmed = undefined;
                throw new Error(`${uri.path}: Overleaf refused the update (${answer.error}); the next write of the file sends the edit again`);
            }
            doc.remoteCache = undefined;
            doc.version = undefined;
            if (answer.kind!=='lost' && write.attempts>1) {
                // Overleaf answered the resend with a refusal or an error: another resend would
                // be answered the same way, and real-time disconnects us after each (see settleUnconfirmed)
                write.resendFailed = true;
            }
            write.failure = answer.error;
            doc.unconfirmed = write;
            throw new Error(`${uri.path}: Overleaf has not confirmed the update (${answer.error}). Before the file is read from Overleaf or written again, Overleaf Workshop asks Overleaf whether it applied the update, and sends it again when Overleaf did not and can still take it.`);
        } finally {
            this.endSync(doc, attempt);
        }
    }

    /** Overleaf refuses an update more than this many versions behind the doc as too old (MAX_AGE_OF_OP in document-updater's ShareJsUpdateManager). */
    private static readonly maxUpdateAge = 80;

    /**
     * Settle the doc's unconfirmed write from what Overleaf reports, and throw while it stays
     * unconfirmed. Overleaf reads the doc from the write's version (joinDoc with fromVersion,
     * which also joins the doc on this connection) and returns the ops applied since, each with
     * the connection that sent it:
     * - One came from a connection the write went out over: the write is applied.
     * - Overleaf refuses the read: whether it applied the write cannot be determined. It no longer
     *   keeps those ops (it keeps a doc's last 100 ops, for an hour after the doc's last update,
     *   and drops them when the project is flushed), or it could not load the doc, or another
     *   update failed in the batch that it applies before the read (UpdateManager.lockUpdatesAndDo).
     * - The read is not answered: the write stays unconfirmed, and is asked about again.
     * - The ops all came from other connections: the write is not applied so far, and a copy may
     *   still be queued, e.g. behind a batch that failed. When the doc has moved more than
     *   maxUpdateAge versions since, Overleaf refuses any copy of it as too old, so it will not
     *   be applied: the doc's next write carries the edit. When Overleaf refused a resend of it
     *   or reported an error while one waited, its outcome cannot be determined. Else it is sent
     *   again unchanged: Overleaf applies it, or answers it as applied when a copy that went out
     *   earlier is applied first (dupIfSource).
     * A write with an outcome that cannot be determined is not sent again: the user is told,
     * and the edit stays in the writer's text (see DocumentEntity.undetermined).
     *
     * An editor that drops the unsaved text (Revert, or closing without saving) does not withdraw
     * the write: Overleaf may have applied it already, or apply a copy it has queued, and only
     * settling it tells which. The editor's next read settles it first, so the editor then shows
     * Overleaf's text with the write's outcome, and the user is told when the dropped edit is in
     * it (see openFile).
     */
    private async settleUnconfirmed(uri: vscode.Uri, doc: DocumentEntity): Promise<'applied' | 'resent' | 'failed' | 'undetermined'> {
        const write = doc.unconfirmed!;
        await this.waitConnected();
        let ops: Array<{meta?: {source?: string}}>;
        try {
            ops = await this.resyncDoc(doc, write.update.v);
        } catch (error: any) {
            if (error instanceof EmitRefusedError) {
                this.cannotDetermine(uri, doc, write, isMissingOpsRefusal(error)
                    ? `Overleaf could not load the document or its updates since then (${error.message})`
                    : `Overleaf refused to read the document's updates since then (${error.message})`);
                return 'undetermined';
            }
            write.checkFailure = error?.message ?? String(error);
            throw new Error(`${uri.path}: Overleaf has not confirmed the update of ${VirtualFileSystem.timeOf(write)} (${write.failure}), and asking Overleaf about it failed (${write.checkFailure})`);
        }
        write.checkFailure = undefined;
        const sources = this.sourcesOf(write);
        if (ops.some(op => op?.meta?.source!==undefined && sources.includes(op.meta.source))) {
            // applied; the copy just read holds it
            doc.unconfirmed = undefined;
            doc.undetermined = undefined;
            doc.localCache = write.content;
            return 'applied';
        }
        if (doc.version! - write.update.v > VirtualFileSystem.maxUpdateAge) {
            console.log(`Overleaf Workshop: ${uri.path}: Overleaf did not apply the update of ${VirtualFileSystem.timeOf(write)}, and now refuses it as too old; the next write of the file sends the edit again`);
            doc.unconfirmed = undefined;
            doc.localCache = write.base;
            return 'failed';
        }
        if (write.resendFailed) {
            this.cannotDetermine(uri, doc, write, `Overleaf refused the update or reported an error for the document when it was sent again (${write.failure})`);
            return 'undetermined';
        }
        if (!this.connected) {
            write.checkFailure = 'the connection was lost before it could be sent again';
            throw new Error(`${uri.path}: Overleaf has not confirmed the update of ${VirtualFileSystem.timeOf(write)} (${write.failure}), and ${write.checkFailure}`);
        }
        await this.settle(uri, doc, this.attempt(doc, write));
        return 'resent';
    }

    /** `write`'s outcome cannot be determined: it is not sent again, the doc's base is not known, and the user is told. */
    private cannotDetermine(uri: vscode.Uri, doc: DocumentEntity, write: PendingWrite, reason: string) {
        console.warn(`Overleaf Workshop: ${uri.path}: cannot tell whether Overleaf applied the update of ${VirtualFileSystem.timeOf(write)}: ${reason}`);
        doc.unconfirmed = undefined;
        doc.undetermined = {write, reason};
        doc.localCache = undefined;
        this.tellUndetermined(uri, doc);
    }

    /** The choices in the notice about a write with an outcome that cannot be determined (see tellUndetermined). */
    private static readonly compareChoice = 'Compare With Overleaf';
    private static readonly replaceChoice = 'Replace Overleaf\'s Text';

    /**
     * Tell the user that Overleaf Workshop cannot tell whether Overleaf applied the doc's write.
     * With an editor open on the doc, the notice offers to compare its text with Overleaf's, and
     * to replace Overleaf's text with the editor's at the next save, which deletes what others
     * changed in the doc since the editor loaded it.
     */
    private tellUndetermined(uri: vscode.Uri, doc: DocumentEntity) {
        const state = doc.undetermined;
        if (state===undefined || state.shown) { return; }
        state.shown = true;
        const what = `${doc.name}: Overleaf Workshop cannot tell whether Overleaf applied the update of ${VirtualFileSystem.timeOf(state.write)}: ${state.reason}.`;
        const open = vscode.workspace.textDocuments.some((d) => d.uri.toString()===uri.toString());
        const {compareChoice, replaceChoice} = VirtualFileSystem;
        const shown = open
            ? vscode.window.showWarningMessage(`${what} The editor keeps your text. Compare it with Overleaf's text first. ${replaceChoice} makes Overleaf's text of ${doc.name} the editor's text at the next save: it deletes what others added or changed in ${doc.name} since this editor loaded it, unless the editor's text has those changes too.`, compareChoice, replaceChoice)
            : vscode.window.showWarningMessage(`${what} The next read of the file takes Overleaf's text as it is then; check the file.`);
        Promise.resolve(shown).then((choice) => {
            state.shown = false;
            if (choice===replaceChoice && doc.undetermined===state) {
                state.replace = true;
            } else if (choice===compareChoice) {
                vscode.commands.executeCommand('workbench.files.action.compareWithSaved', uri);
            }
        }, () => { state.shown = false; });
    }

    /** When `write` was made, for messages. */
    private static timeOf(write: PendingWrite): string {
        return new Date(write.madeAt).toLocaleTimeString();
    }

    /**
     * A read of the doc for `uri` returned `content`. A reader that shows the text without
     * unsaved changes, or that is not an editor (the local replica), bases its next write on it:
     * it becomes the doc's base, and a doc without a known base has one again. An editor with
     * unsaved changes keeps its base: its text derives from that base, not from this read.
     */
    private takeRead(doc: DocumentEntity, uri: vscode.Uri, content: string) {
        if (this.editorOf(uri)?.isDirty!==true) {
            doc.localCache = content;
            doc.undetermined = undefined;
        } else if (doc.localCache===undefined && doc.undetermined===undefined) {
            doc.localCache = content; // the doc's first read
        }
    }

    /** The editor's document open on `uri`, if any. */
    private editorOf(uri: vscode.Uri): vscode.TextDocument | undefined {
        return vscode.workspace.textDocuments.find((d) => d.uri.toString()===uri.toString());
    }

    /**
     * Resolves once Overleaf has confirmed every document write made so far. Waits for the
     * writes going on and, while the project is joined on a working connection (see connected),
     * settles each write that Overleaf has not confirmed (see settleUnconfirmed). Rejects with
     * UnconfirmedWritesError naming the documents with a write that Overleaf has still not
     * confirmed, or with an outcome that cannot be determined; during a reconnect, the documents
     * are those of the tree from before the connection was lost.
     */
    async documentUpdatesSettled(): Promise<void> {
        const docs = this.walk(entity => entity._type==='doc', this.root ?? this.previousRoot);
        await Promise.all(docs.map(({entity, path}) => {
            const doc = entity as DocumentEntity;
            return this.serialize(doc, async () => {
                if (!this.connected) { return; }
                const uri = this.pathToUri(path);
                try {
                    if (doc.unconfirmed) { await this.settleUnconfirmed(uri, doc); }
                    if (doc.undetermined && this.editorOf(uri)?.isDirty!==true) {
                        // Without an editor holding unsaved changes, read the doc as a reader that
                        // is not an editor: its base is Overleaf's text again (see takeRead).
                        this.takeRead(doc, uri, (await this.readDoc(doc)).content);
                    }
                } catch {
                    // the doc keeps its state, which says why, and it is named below
                }
            });
        }));
        const named = docs.flatMap(({entity, path}) => {
            const doc = entity as DocumentEntity;
            const unconfirmed = doc.unconfirmed;
            const reason = unconfirmed ? `not confirmed (${unconfirmed.failure}${unconfirmed.checkFailure ? `; asking Overleaf about it failed: ${unconfirmed.checkFailure}` : ''})`
                : doc.undetermined ? `cannot be determined (${doc.undetermined.reason})` : undefined;
            return reason===undefined ? [] : [{path, reason}];
        });
        if (named.length>0) {
            throw new UnconfirmedWritesError(named);
        }
    }

    /** The connection is gone: the updates sent over it cannot be answered any more (see attempt). */
    private answersLost(reason: string) {
        for (const {entity} of this.walk(e => e._type==='doc', this.root ?? this.previousRoot)) {
            (entity as DocumentEntity).sync?.answer({kind: 'lost', error: `the connection was lost (${reason})`});
        }
    }

    /** The doc is settled: apply the ops of others held back meanwhile (see onFileChanged). */
    private endSync(doc: DocumentEntity, attempt: Attempt) {
        if (doc.sync!==attempt) { return; }
        doc.sync = undefined;
        const res = this.root ? this._resolveById(doc._id) : undefined;
        if (res) {
            attempt.buffered.forEach((update) => this.applyRemoteUpdate(res.path, doc, update));
        }
    }

    /**
     * Tell the IDE that the doc at `uri` changed, so that an editor showing it reads it again.
     * The notice goes out 10 ms after the write returns to the IDE; whether the IDE needs that
     * delay to read the document again is unchecked.
     */
    private notifyChanged(uri: vscode.Uri) {
        setTimeout(() => {
            this.notify([
                {type: vscode.FileChangeType.Changed, uri: uri}
            ]);
        }, 10);
    }

    /**
     * Fetch the server's copy of `doc`, and with `fromVersion` the ops applied since then (see
     * settleUnconfirmed). `localCache` is kept: the next write is based on it.
     */
    private async resyncDoc(doc: DocumentEntity, fromVersion?: number) {
        const {content, ops} = await this.readDoc(doc, fromVersion);
        doc.lastVersion = doc.version;
        if (doc.localCache===undefined && doc.undetermined===undefined) { doc.localCache = content; }
        doc.mtime = undefined;
        return ops;
    }

    /** Join `doc` on the current connection, which reads Overleaf's copy of it, and with `fromVersion` the ops since. */
    private async readDoc(doc: DocumentEntity, fromVersion?: number): Promise<{content: string, ops: Array<{meta?: {source?: string}}>}> {
        const connection = this.connectionSeq;
        const res = await this.socket.joinDoc(doc._id, fromVersion);
        const content = res.docLines.join('\n');
        doc.joinedOn = connection;
        doc.version = res.version;
        doc.remoteCache = content;
        return {content, ops: res.updates ?? []};
    }

    async mkdir(uri: vscode.Uri) {
        const {parentFolder, fileName} = await this._resolveUri(uri);
        const [folderName, parentFolderId] = [fileName, parentFolder._id];
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.addFolder(identity, this.projectId, folderName, parentFolderId);

        if (res.type==='success' && res.entity!==undefined) {
            this.insertEntity(parentFolder, 'folder', res.entity as FolderEntity);
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
        } else {
            throw vscode.FileSystemError.Unavailable(`${uri.path}: ${res.message ?? 'the server did not create the folder'}`);
        }
    }

    /**
     * Delete `uri` on Overleaf; throws when Overleaf refuses. A path that is not in the project
     * tree is not on Overleaf either, so it resolves without a request, where the
     * FileSystemProvider interface asks for FileNotFound: the local replica deletes on Overleaf
     * the files deleted locally, and one that someone deleted on Overleaf meanwhile is gone
     * as the replica wants it.
     */
    async remove(uri: vscode.Uri, recursive: boolean) {
        const {parentFolder, fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType && fileEntity) {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.deleteEntity(identity, this.projectId, fileType, fileEntity._id);
            if (res.type==='success') {
                this.isDirty = true;
                this.removeEntityById(parentFolder, fileType, fileEntity._id, recursive);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: uri},
                ]);
            } else {
                throw vscode.FileSystemError.Unavailable(`${uri.path}: ${res.message ?? 'the server did not delete it'}`);
            }
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, force: boolean) {
        const oldPath = await this._resolveUri(oldUri);
        const newPath = await this._resolveUri(newUri);

        if (oldPath.fileType && oldPath.fileEntity && oldPath.fileEntity) {
            // delete existence firstly
            if (newPath.fileType && newPath.fileEntity) {
                if (!force) { return; }
                await this.remove(newUri, true);
                this.removeEntity(newPath.parentFolder, newPath.fileType, newPath.fileEntity);
            }
            // rename or move
            let res = undefined;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            if (oldPath.parentFolder===newPath.parentFolder) {
                const [entityType, entityId, newName] = [oldPath.fileType, oldPath.fileEntity._id, newPath.fileName];
                res = await this.api.renameEntity(identity, this.projectId, entityType, entityId, newName);
            } else {
                const [entityType, entityId, newParentFolderId] = [oldPath.fileType, oldPath.fileEntity._id, newPath.parentFolder._id];
                res = await this.api.moveEntity(identity, this.projectId, entityType, entityId, newParentFolderId);
            }
            // update local cache
            if (res?.type==='success') {
                this.isDirty = true;
                const newEntity = Object.assign(oldPath.fileEntity);
                newEntity.name = newPath.fileName;
                this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                this.insertEntity(newPath.parentFolder, oldPath.fileType, newEntity);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: oldUri},
                    {type: vscode.FileChangeType.Created, uri: newUri},
                ]);
            } else {
                if (res?.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
            }
        }
    }

    /**
     * Compile on Overleaf, incrementally: the compile server keeps the previous build's
     * output, as for the web editor's Recompile. With `fromScratch`, that output is cleared
     * first, as by "Recompile from scratch": this user's build is deleted, and the compile
     * sends every file and runs every pass.
     */
    async compile(force:boolean=false, draft:boolean=false, stopOnFirstError:boolean=false, rootDocId?:string, fromScratch:boolean=false) {
        if (force || fromScratch || (this.root && this.isDirty)) {
            this.isDirty = false;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            if (fromScratch) {
                const cleared = await this.api.deleteAuxFiles(identity, this.projectId);
                if (cleared.type!=='success') {
                    console.warn(`Overleaf Workshop: clearing the compile output failed, compiling anyway: ${cleared.message}`);
                }
            }
            // compile project
            const resolvedRootDocId = rootDocId ?? this.root?.rootDoc_id ?? null;
            let rootResourcePath: string | null = null;
            if (resolvedRootDocId) {
                const rootEntry = this._resolveById(resolvedRootDocId);
                if (rootEntry?.path) {
                    rootResourcePath = rootEntry.path.replace(/^\//, '');
                } else {
                    console.warn(`Unable to resolve root document id '${resolvedRootDocId}' to a path; compiling without explicit rootResourcePath.`);
                }
            }
            const startedAt = Date.now();
            const res = await this.api.compile(identity, this.projectId, rootResourcePath, draft, stopOnFirstError);
            this.lastCompile = {
                response: res.type==='success' ? res.compile : undefined,
                message: res.type==='success' ? undefined : res.message,
                rootResourcePath, startedAt, finishedAt: Date.now(),
            };
            if (res.type==='success' && res.compile?.status==='success') {
                // Store CDN download info from the response for subsequent output file requests
                this.compileGroup = res.compile.compileGroup;
                this.clsiServerId = res.compile.clsiServerId;
                this.pdfDownloadDomain = res.compile.pdfDownloadDomain;
                this.updateOutputs(res.compile.outputFiles);
                return true;
            } else {
                if (res.message!==undefined) {
                    console.error('Compile failure.', res.message);
                }
                return false;
            }
        }
        return Promise.resolve(undefined);
    }

    /**
     * The last successful build's output.pdf, to load in ranges as Overleaf's PDF viewer does
     * (frontend/js/features/pdf-preview/util/output-files.ts); undefined without a build that
     * the download domain serves, and without output.pdf's size, which the compile response
     * gives when the compile asked for PDF caching.
     */
    pdfOutput(): PdfOutput | undefined {
        const response = this.lastCompile?.response;
        const file = response?.status==='success' ? response.outputFiles?.find(f => f.path==='output.pdf') : undefined;
        if (!file?.build || !file.size || !response?.pdfDownloadDomain) { return undefined; }
        const query = new URLSearchParams();
        if (response.compileGroup) { query.set('compileGroup', response.compileGroup); }
        if (response.clsiServerId) { query.set('clsiserverid', response.clsiServerId); }
        query.set('enable_pdf_caching', 'true');
        return {
            url: `${response.pdfDownloadDomain}${file.url}?${query}`,
            downloadDomain: response.pdfDownloadDomain,
            projectId: this.projectId,
            file,
        };
    }

    /** Download an output file of `response`, a compile of this project with any status. */
    async downloadCompileOutput(file: OutputFileEntity, response: CompileResponseSchema): Promise<Uint8Array> {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getFileFromClsi(identity, file.url, response.compileGroup || 'standard',
                                                   response.clsiServerId, response.pdfDownloadDomain);
        if (res.type!=='success' || !res.content) {
            throw new Error(res.message ?? `the download of ${file.path} failed`);
        }
        return res.content;
    }

    async stopCompile() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.stopCompile(identity, this.projectId);
        if (res.type==='success') {
            return true;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return false;
        }
    }

    async updateOutputs(outputs: Array<OutputFileEntity>) {
        if (this.root) {
            // update output buildId
            // '/project/65dbfff719ad65b54b9eaed4/user/65094b5fa537faaba0bec01f/build/19620231e54-5372f67292889500/output/output.aux' --> 19620231e54-5372f67292889500'
            this.outputBuildId = outputs[0].url.match(/\/build\/([^\/]+)/)?.[1];

            const rootFolder = this.root.rootFolder[0];
            if (this.removeEntityById(rootFolder, 'folder', __OUTPUTS_ID)) {
                this.notify([
                    {type:vscode.FileChangeType.Deleted, uri:this.pathToUri(OUTPUT_FOLDER_NAME)}
                ]);
            }

            this.insertEntity(rootFolder, 'folder', {
                _id: __OUTPUTS_ID,
                name: OUTPUT_FOLDER_NAME,
                readonly: true,
                docs: [], fileRefs: [], folders:[],
                outputs: outputs.map((file) => {
                    file._id = __OUTPUTS_ID;
                    file.name=file.path;
                    file.readonly=true;
                    return file;
                })
            } as FolderEntity);
            this.notify([
                {type:vscode.FileChangeType.Created, uri:this.pathToUri(OUTPUT_FOLDER_NAME)},
                ...(outputs.map((file) => {
                    return {type:vscode.FileChangeType.Changed, uri:this.pathToUri(OUTPUT_FOLDER_NAME, file.path)};
                }))
            ]);
        }
    }

    /** The PDF positions of `line` (from 1) and `column` of `filePath`, a path inside the project. */
    async syncCode(filePath: string, line:number, column:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncCode(identity, this.projectId, filePath, line, column, this.outputBuildId ?? '', this.clsiServerId);
        if (res.type==='success') {
            return res.syncCode;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async syncPdf(page:number, h:number, v:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncPdf(identity, this.projectId, page, h, v, this.outputBuildId ?? '', this.clsiServerId);
        if (res.type==='success') {
            return res.syncPdf;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async spellCheck(uri: vscode.Uri, words: string[]) {
        if (this.root?.spellCheckLanguage==='') { return []; }

        const {fileType} = await this._resolveUri(uri);
        if (fileType==='doc' || fileType==='file') {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = this.root && await this.api.proxyRequestToSpellingApi(identity, this.root.spellCheckLanguage, this.userId, words);
            if (res?.type==='success') {
                return res.misspellings;
            }
        }
    }

    async spellLearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerLearn(identity, this.userId, word);
        if (res.type==='success') {
            this.root?.settings.learnedWords.push(word);
            return true;
        } else {
            return false;
        }
    }

    async spellUnlearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerUnlearn(identity, word);
        if (res.type==='success') {
            const index = this.root?.settings.learnedWords.findIndex((w) => w===word);
            if (index!==undefined && index>=0) {
                this.root?.settings.learnedWords.splice(index, 1);
            }
            return true;
        } else {
            return false;
        }
    }

    getSpellCheckLanguage() {
        const language = this.root?.spellCheckLanguage;
        if (language==='') {
            return {name:'Off', code:''};
        } else {
            return this.root?.settings.languages.find(item => item.code===language);
        }
    }

    getAllSpellCheckLanguages() {
        return this.root?.settings.languages;
    }

    getCompiler() {
        const compiler = this.root?.compiler;
        const compilerItem = this.root?.settings.compilers.find(item => item.code===compiler);
        return compilerItem;
    }

    getAllCompilers() {
        return this.root?.settings.compilers;
    }

    getDictionary() {
        return this.root?.settings.learnedWords;
    }

    getRootDocName() {
        return this._resolveById(this.root?.rootDoc_id!)?.path ?? '';
    }

    getValidMainDocs() {
        return this.walk((entity) => {
            return entity._type==='doc' && entity.name.match(/\.tex$/g)!==null;
        });
    }

    getProjectSCMPersist(scmKey: string) {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.serverName, this.projectId);
        return scmPersists[scmKey];
    }

    setProjectSCMPersist(scmKey: string, persist: any) {
        GlobalStateManager.updateServerProjectSCMPersist(this.context, this.serverName, this.projectId, scmKey, persist);
    }

    async updateSettings(setting: any) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.updateProjectSettings(identity, this.projectId, setting);
        if (res.type==='success') {
            const keys = Object.keys(setting);
            if (keys.includes('spellCheckLanguage')) {
                this.root!.spellCheckLanguage = setting.spellCheckLanguage;
            }
            if (keys.includes('compiler')) {
                this.root!.compiler = setting.compiler;
            }
            if (keys.includes('rootDocId')) {
                this.root!.rootDoc_id = setting.rootDocId;
            }
        }
        return res.type==='success'? true : false;
    }

    async metadata() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMetadata(identity, this.projectId);
        if (res.type==='success') {
            return res.meta?.projectMeta;
        } else {
            return undefined;
        }
    }

    async getUpdates(before?: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetUpdates(identity, this.projectId, before);
        if (res.type==='success') {
            return res.updates;
        } else {
            return undefined;
        }
    }

    async getFileDiff(pathname:string, from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileDiff(identity, this.projectId, pathname, from, to);
        if (res.type==='success') {
            return res.diff;
        } else {
            return undefined;
        }
    }

    async getFileTreeDiff(from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileTreeDiff(identity, this.projectId, from, to);
        if (res.type==='success') {
            return res.treeDiff;
        } else {
            return undefined;
        }
    }

    async getCurrentVersion() {
        const base = this.currentVersion ?? 0;
        let lb = base;
        let rb = base+2**4;
        // firstly try: a) no update `+1`, b) one update `+2`
        const res = await this.getFileTreeDiff(base+1, base+1);
        if (res===undefined) {
            this.currentVersion = base;
            return base;
        }
        const res2 = await this.getFileTreeDiff(base+2, base+2);
        if (res2===undefined) {
            this.currentVersion = base+1;
            return this.currentVersion;
        }
        // locate the actual upper bound
        do {
            const res = await this.getFileTreeDiff(rb, rb);
            if (res!==undefined) {
                rb = lb + (rb-lb)*2;
            } else {
                break;
            }
        } while (true);
        // binary search the current version
        while (lb<rb) {
            const mid = Math.floor((lb+rb)/2);
            const res = await this.getFileTreeDiff(mid, mid);
            if (res!==undefined) {
                lb = mid+1;
            } else {
                rb = mid;
            }
        }
        // update current version
        this.currentVersion = rb-1;
        return this.currentVersion;
    }

    async createLabel(comment: string, version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.createLabel(identity, this.projectId, comment, version);
        if (res.type==='success') {
            return res.labels?.at(0);
        } else {
            return undefined;
        }
    }

    async deleteLabel(labelId: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.deleteLabel(identity, this.projectId, labelId);
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }

    async downloadProjectArchive(version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.downloadZipOfVersion(identity, this.projectId, version);
        if (res.type!=='success' || res.content===undefined) {
            throw new Error(res.message);
        }
        return res.content;
    }

    async getMessages() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMessages(identity, this.projectId);
        if (res.type==='success') {
            return res.messages;
        } else {
            return undefined;
        }
    }

    async sendMessage(publicId:string, content: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.sendMessage(identity, this.projectId, publicId, content);
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private vfss: {[key:string]:VirtualFileSystem};

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.vfss = {};
    }

    private getVFS(uri: vscode.Uri): Promise<VirtualFileSystem> {
        const vfs = this.vfss[ uri.query ];
        if (vfs) {
            return Promise.resolve(vfs);
        } else {
            const vfs = new VirtualFileSystem(this.context, uri, this.notify.bind(this));
            this.vfss[ uri.query ] = vfs;
            return Promise.resolve(vfs);
        }
    }

    prefetch(uri: vscode.Uri): Promise<VirtualFileSystem> {
        return this.getVFS(uri).then((vfs) => {return vfs;});
    }

    notify(events :vscode.FileChangeEvent[]) {
        this._emitter.fire(events);
    }

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        return this.getVFS(uri).then( vfs => vfs.resolve(uri) );
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        return this.getVFS(uri).then( vfs => vfs.list(uri) );
    }

    createDirectory(uri: vscode.Uri): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.mkdir(uri) );
    }

    readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        return this.getVFS(uri).then( vfs => vfs.openFile(uri) );
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.writeFile(uri, content, options.create, options.overwrite) );
    }

    delete(uri: vscode.Uri, options: { recursive: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.remove(uri, options.recursive) );
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }) {
        if (oldUri.authority !== newUri.authority) {
            vscode.window.showErrorMessage( vscode.l10n.t('Cannot rename across servers') );
            return;
        } else {
            return this.getVFS(oldUri).then( vfs => vfs.rename(oldUri, newUri, options.overwrite) );
        }
    }

    get triggers() {
        return [
            // register file system provider
            vscode.workspace.registerFileSystemProvider(ROOT_NAME, this, { isCaseSensitive: true }),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.refreshLinkedFile`, (uri: vscode.Uri) => {
                return this.prefetch(uri).then((vfs) => vfs.refreshLinkedFile(uri));
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.createLinkedFile`, (uri?: vscode.Uri) => {
                uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
                if (uri) {
                    return this.prefetch(uri).then((vfs) => vfs.createLinkedFile(uri!));
                }                
            }),
            vscode.commands.registerCommand('remoteFileSystem.prefetch', (uri: vscode.Uri) => {
                return this.prefetch(uri);
            }),
        ];
    }
}
