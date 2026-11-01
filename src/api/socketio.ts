/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
import { SocketIOAlt } from './socketioAlt';
import { decodePackedUtf8 } from './packedUtf8';
import type { TrackChangesState } from '../utils/docUpdate';


/** Render a socket.io error payload as something readable instead of `[object Object]`. */
function stringifyError(err: any): string {
    if (err === null || err === undefined) { return 'unknown error'; }
    if (typeof err === 'string') { return err; }
    if (err.message) { return err.message; }
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

/**
 * The server answered an emit with an error: it refused the request. Real-time refuses an
 * update this way before it queues it (WebsocketController.applyOtUpdate); `answer` is what it
 * sent, which for most refusals carries only a message (Router._handleError).
 */
export class EmitRefusedError extends Error {
    constructor(readonly event: string, readonly answer: unknown) {
        super(`'${event}' rejected: ${stringifyError(answer)}`);
        this.name = 'EmitRefusedError';
    }
}

/** An emit was not answered within SocketIOAPI.emitTimeoutMs; the request may or may not have arrived. */
export class EmitTimeoutError extends Error {
    constructor(readonly event: string, ms: number) {
        super(`'${event}' timed out after ${ms}ms`);
        this.name = 'EmitTimeoutError';
    }
}

/**
 * Whether `error` is real-time's refusal to read a doc from a version when document-updater no
 * longer keeps the ops since that version. Real-time raises ClientRequestedMissingOpsError, with
 * the message 'doc updater could not load requested ops' (services/real-time/app/js/Errors.js),
 * and Router._handleError forwards only that message to the client, so the message is the one
 * value that tells this refusal from the others. Should Overleaf change the text, this answers
 * false: the write that VirtualFileSystem.settleUnconfirmed asks about then stays unconfirmed,
 * and each read of its doc from Overleaf and each write of it fails with the refusal until the
 * window is reloaded; the edit is neither applied twice nor dropped.
 */
export function isMissingOpsRefusal(error: unknown): boolean {
    return error instanceof EmitRefusedError && (error.answer as {message?: unknown} | undefined)?.message === 'doc updater could not load requested ops';
}

export interface UpdateUserSchema {
    id: string,
    user_id: string,
    name: string,
    email: string,
    doc_id: string,
    row: number,
    column: number,
    last_updated_at?: number, //unix timestamp
}

export interface OnlineUserSchema {
    client_age: number,
    client_id: string,
    connected: boolean,
    cursorData?: {
        column: number,
        doc_id: string,
        row: number,
    },
    email: string,
    first_name: string,
    last_name?: string,
    last_updated_at: string, //unix timestamp
    user_id: string,
}

export interface UpdateSchema {
    doc: string, //doc id
    op?: {
        p: number, //position
        i?: string, //insert
        d?: string, //delete
        u?: boolean, //isUndo
    }[],
    v: number, //doc version number
    lastV?: number, //last version number
    hash?: string, //(not needed if lastV is provided)
    dupIfSource?: string[], //publicIds an earlier submission of this update may have come from
    meta?: {
        source?: string, //socketio client id, in updates from the server
        ts?: number, //unix timestamp, in updates from the server
        user_id?: string, //in updates from the server
        tc?: string, //the seed of the tracked changes this update makes (see utils/docUpdate)
    }
}

export interface EventsHandler {
    onFileCreated?: (parentFolderId:string, type:FileType, entity:FileEntity) => void,
    onFileRenamed?: (entityId:string, newName:string) => void,
    onFileRemoved?: (entityId:string) => void,
    onFileMoved?: (entityId:string, newParentFolderId:string) => void,
    onFileChanged?: (update:UpdateSchema) => void,
    /** otUpdateError: Overleaf could not apply an update of the doc `docId` */
    onUpdateError?: (docId:string|undefined, error:string) => void,
    //
    onDisconnected?: () => void,
    onConnectionAccepted?: (publicId:string) => void,
    onClientUpdated?: (user:UpdateUserSchema) => void,
    onClientDisconnected?: (id:string) => void,
    //
    onReceivedMessage?: (message:ProjectMessageResponseSchema) => void,
    //
    onSpellCheckLanguageUpdated?: (language:string) => void,
    onCompilerUpdated?: (compiler:string) => void,
    onRootDocUpdated?: (rootDocId:string) => void,
    onTrackChangesToggled?: (state:TrackChangesState) => void,
}

type ConnectionScheme = 'Alt' | 'v1' | 'v2';

export class SocketIOAPI {
    /** How long to wait for a server acknowledgement before giving up on an emit. */
    static emitTimeoutMs = 15000;
    /** How long to wait for the server's answer to joining the project. */
    static joinTimeoutMs = 15000;
    /**
     * Told when the connection looks lost although socket.io may not have noticed: an emit
     * got no answer, the socket reported an error, or socket.io gave up reconnecting.
     */
    onConnectionProblem?: (reason: string) => void;
    private scheme: ConnectionScheme = 'v1';
    private record?: Promise<ProjectEntity>;
    /** resolves `record` once the current connection's joinProjectResponse arrives (scheme v2) */
    private recordWaiter?: (project: ProjectEntity) => void;
    private _handlers: Array<EventsHandler> = [];
    /** Track EventBus listeners for cleanup to prevent MaxListenersExceededWarning */
    private _eventBusCleanups: Array<()=>void> = [];

    private socket?: any;
    private emit: any;
    /** Track the scheme used when the socket was last initialized */
    private _socketInitScheme?: ConnectionScheme;

    constructor(private url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.init();
    }

    init() {
        // Clean up old EventBus listeners before creating new socket
        this._cleanupEventBusListeners();

        // CRITICAL: Properly disconnect old socket before creating a new one.
        // Without this, the old TCP connection is abandoned but still alive. When the
        // server later sends data on it (out-of-order/late packets), the OS TCP stack
        // responds with RST, which can cause the server to drop ALL connections from
        // this client — explaining the "connection lost" loop reported in issue #309.
        if (this.socket) {
            try {
                // Remove all listeners to prevent stale event handlers from firing
                if (typeof this.socket.removeAllListeners === 'function') {
                    this.socket.removeAllListeners();
                }
                // Gracefully close the connection (sends FIN, not RST)
                if (typeof this.socket.disconnect === 'function') {
                    this.socket.disconnect();
                }
            } catch {
                // Best-effort cleanup; socket may already be in a bad state
            }
        }

        // connect
        switch(this.scheme) {
            case 'Alt':
                this.socket = new SocketIOAlt(this.url, this.api, this.identity, this.projectId, this.record!);
                break;
            case 'v1':
                this.record = undefined;
                this.socket = this.api._initSocketV0(this.identity);
                break;
            case 'v2':
                this.record = undefined;
                const query = `?projectId=${this.projectId}&t=${Date.now()}`;
                this.socket = this.api._initSocketV0(this.identity, query);
                break;
        }
        // create emit
        (this.socket.emit)[require('util').promisify.custom] = (event:string, ...args:any[]) => {
            // Bind the call to the socket it is emitted on: init() may swap this.socket
            // out from under an in-flight call, and that call can never be acknowledged.
            const socket = this.socket;
            let timer: NodeJS.Timeout;
            const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new EmitTimeoutError(event, SocketIOAPI.emitTimeoutMs));
                    // No answer means the connection is gone, even when socket.io still takes it
                    // for open; unless this socket has been replaced meanwhile.
                    if (socket===this.socket) {
                        this.onConnectionProblem?.(`'${event}' got no answer within ${SocketIOAPI.emitTimeoutMs} ms`);
                    }
                }, SocketIOAPI.emitTimeoutMs);
            });
            const waitPromise = new Promise((resolve, reject) => {
                socket.emit(event, ...args, (err:any, ...data:any[]) => {
                    // Clear the timer as soon as the ack lands, otherwise every single
                    // emit leaks a live timer for the whole timeout window.
                    clearTimeout(timer);
                    if (err) {
                        reject(new EmitRefusedError(event, err));
                    } else {
                        resolve(data);
                    }
                });
            });
            return Promise.race([waitPromise, timeoutPromise]);
        };
        this.emit = require('util').promisify(this.socket.emit).bind(this.socket);
        // resume handlers
        this.initInternalHandlers();
        // Re-register existing event handlers on the new socket
        this.resumeEventHandlers(this._handlers);
        // Track which scheme this socket was created with
        this._socketInitScheme = this.scheme;
    }

    /** Returns true if the socket needs re-initialization (scheme changed, or socket was never init'd) */
    get needsReinit(): boolean {
        return this._socketInitScheme !== this.scheme || !this.socket;
    }

    /** Clean up any accumulated EventBus listeners */
    private _cleanupEventBusListeners() {
        for (const cleanup of this._eventBusCleanups) {
            try { cleanup(); } catch {}
        }
        this._eventBusCleanups = [];
    }

    private initInternalHandlers() {
        this.socket.on('connect', () => {
            console.log('SocketIOAPI: connected');
        });
        this.socket.on('connect_failed', () => {
            console.log('SocketIOAPI: connect_failed');
            this.onConnectionProblem?.('the connection could not be made');
        });
        // socket.io stops after its last reconnection attempt and leaves the socket closed
        this.socket.on('reconnect_failed', () => {
            console.log('SocketIOAPI: reconnect_failed');
            this.onConnectionProblem?.('socket.io gave up reconnecting');
        });
        this.socket.on('forceDisconnect', (message:string, delay=10) => {
            console.log('SocketIOAPI: forceDisconnect', message);
        });
        this.socket.on('connectionRejected', (err:any) => {
            console.log('SocketIOAPI: connectionRejected.', err?.message || err);
            // If v2 also gets rejected, fall back to v1 rather than staying stuck
            if (this.scheme === 'v2') {
                console.log('SocketIOAPI: v2 rejected, falling back to v1');
                this.scheme = 'v1';
            }
            // Disable auto-reconnect on this socket: the server explicitly rejected
            // our connection parameters. Reconnecting would just get rejected again,
            // creating unnecessary TCP connection churn (and RST packets).
            if (this.socket.io && typeof this.socket.io.reconnect === 'function') {
                this.socket.io.reconnect(false);
            }
        });
        this.socket.on('error', (err:any) => {
            // Log error instead of throwing to avoid crashing the extension
            console.error('SocketIOAPI: socket error', err?.message || err);
            this.onConnectionProblem?.(`socket error: ${stringifyError(err)}`);
        });

        if (this.scheme==='v2') {
            // The server joins the project when the connection is made and answers with
            // joinProjectResponse, again after socket.io reconnects. `record` is the answer of
            // the current connection: after a disconnect it waits for the next one, so that a
            // join is not taken for done while the socket is closed.
            this.awaitJoinResponse();
            this.socket.on('joinProjectResponse', (res:any) => {
                const publicId = res.publicId as string;
                const project = res.project as ProjectEntity;
                EventBus.fire('socketioConnectedEvent', {publicId});
                if (this.recordWaiter) {
                    this.recordWaiter(project);
                    this.recordWaiter = undefined;
                } else {
                    this.record = Promise.resolve(project);
                }
            });
            this.socket.on('disconnect', () => {
                if (this.scheme==='v2') { this.awaitJoinResponse(); }
            });
        }
    }

    private awaitJoinResponse() {
        this.record = new Promise(resolve => { this.recordWaiter = resolve; });
    }

    disconnect() {
        this.socket.disconnect();
    }

    get handlers() {
        return this._handlers;
    }

    get isUsingAlternativeConnectionScheme() {
        return this.scheme==='Alt';
    }

    toggleAlternativeConnectionScheme(url: string, updatedRecord?: ProjectEntity) {
        this.scheme = this.scheme==='Alt' ? 'v1' : 'Alt';
        if (updatedRecord) {
            this.url = url;
            this.record = Promise.resolve(updatedRecord);
        }
    }

    resumeEventHandlers(handlers: Array<EventsHandler>) {
        this._handlers = [];
        handlers.forEach((handler) => {
            this.updateEventHandlers(handler);
        });
    }

    updateEventHandlers(handlers: EventsHandler) {
        this._handlers.push(handlers);
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    this.socket.on('reciveNewDoc', (parentFolderId:string, doc:DocumentEntity) => {
                        handler(parentFolderId, 'doc', doc);
                    });
                    this.socket.on('reciveNewFile', (parentFolderId:string, file:FileRefEntity) => {
                        handler(parentFolderId, 'file', file);
                    });
                    this.socket.on('reciveNewFolder', (parentFolderId:string, folder:FolderEntity) => {
                        handler(parentFolderId, 'folder', folder);
                    });
                    break;
                case handlers.onFileRenamed:
                    this.socket.on('reciveEntityRename', (entityId:string, newName:string) => {
                        handler(entityId, newName);
                    });
                    break;
                case handlers.onFileRemoved:
                    this.socket.on('removeEntity', (entityId:string) => {
                        handler(entityId);
                    });
                    break;
                case handlers.onFileMoved:
                    this.socket.on('reciveEntityMove', (entityId:string, folderId:string) => {
                        handler(entityId, folderId);
                    });
                    break;
                case handlers.onFileChanged:
                    this.socket.on('otUpdateApplied', (update: UpdateSchema) => {
                        handler(update);
                    });
                    break;
                case handlers.onUpdateError:
                    // Sent to the connections that joined the doc, or for an update too large
                    // to queue to its sender, which real-time then disconnects; `message` names
                    // the doc (DocumentUpdaterController, WebsocketController.applyOtUpdate).
                    this.socket.on('otUpdateError', (error:any, message?:{doc_id?: string}) => {
                        handler(message?.doc_id, stringifyError(error));
                    });
                    break;
                case handlers.onDisconnected:
                    this.socket.on('disconnect', () => {
                        handler();
                    });
                    break;
                case handlers.onConnectionAccepted:
                    this.socket.on('connectionAccepted', (_:any, publicId:any) => {
                        handler(publicId);
                    });
                    // Track EventBus listener via Disposable for cleanup to prevent MaxListenersExceededWarning
                    const eventBusDisposable = EventBus.on('socketioConnectedEvent', (arg:{publicId:string}) => {
                        handler(arg.publicId);
                    });
                    this._eventBusCleanups.push(() => eventBusDisposable.dispose());
                    break;
                case handlers.onClientUpdated:
                    this.socket.on('clientTracking.clientUpdated', (user:UpdateUserSchema) => {
                        handler(user);
                    });
                    break;
                case handlers.onClientDisconnected:
                    this.socket.on('clientTracking.clientDisconnected', (id:string) => {
                        handler(id);
                    });
                    break;
                case handlers.onReceivedMessage:
                    this.socket.on('new-chat-message', (message:ProjectMessageResponseSchema) => {
                        handler(message);
                    });
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    this.socket.on('spellCheckLanguageUpdated', (language:string) => {
                        handler(language);
                    });
                    break;
                case handlers.onCompilerUpdated:
                    this.socket.on('compilerUpdated', (compiler:string) => {
                        handler(compiler);
                    });
                    break;
                case handlers.onRootDocUpdated:
                    this.socket.on('rootDocUpdated', (rootDocId:string) => {
                        handler(rootDocId);
                    });
                    break;
                case handlers.onTrackChangesToggled:
                    // the whole new trackChangesState: false, true, or {userId: true, ...}
                    this.socket.on('toggle-track-changes', (state:TrackChangesState) => {
                        handler(state);
                    });
                    break;
                default:
                    break;
            }
        });
    }

    get unSyncFileChanges(): number {
        if (this.socket instanceof SocketIOAlt) {
            return this.socket.unSyncedChanges;
        }
        return 0;
    }

    async syncFileChanges() {
        if (this.socket instanceof SocketIOAlt) {
            return await this.socket.uploadToVFS();
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
     * @param {string} projectId - The project id.
     * @returns {Promise}
     */
    async joinProject(project_id:string): Promise<ProjectEntity> {
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`joining the project got no answer within ${SocketIOAPI.joinTimeoutMs} ms`));
            }, SocketIOAPI.joinTimeoutMs);
        });
        try {
            return await this.joinProjectOnce(project_id, timeoutPromise);
        } finally {
            clearTimeout(timer);
        }
    }

    private joinProjectOnce(project_id:string, timeoutPromise: Promise<ProjectEntity>): Promise<ProjectEntity> {
        switch(this.scheme) {
            case 'Alt':
            case 'v1':
                const joinPromise = this.emit('joinProject', {project_id})
                .then((returns:[ProjectEntity, string, number]) => {
                    const [project, permissionsLevel, protocolVersion] = returns;
                    this.record = Promise.resolve(project);
                    return project;
                });
                const rejectPromise = new Promise((_, reject) => {
                    this.socket.on('connectionRejected', (err:any) => {
                        // Only fall back to v2 if we haven't already tried it;
                        // otherwise let the outer retry logic handle backoff
                        this.scheme = 'v2';
                        reject(err.message);
                    });
                });
                return Promise.race([joinPromise, rejectPromise, timeoutPromise]);
            case 'v2': {
                // fail at once when this connection cannot be made, instead of at the timeout
                const failed = new Promise<ProjectEntity>((_, reject) => {
                    this.socket.on('connectionRejected', (err:any) => reject(new Error(`the connection was rejected: ${stringifyError(err)}`)));
                    this.socket.on('connect_failed', () => reject(new Error('the connection could not be made')));
                    this.socket.on('error', (err:any) => reject(new Error(`socket error: ${stringifyError(err)}`)));
                });
                return Promise.race([this.record!, timeoutPromise, failed]);
            }
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async joinDoc(docId:string, fromVersion?:number) {
        // With `fromVersion`, Overleaf also returns the ops applied since that version, each
        // with `meta.source`, the publicId of the connection that sent it (unpacked, unlike
        // the lines); it refuses when it no longer keeps them (see isMissingOpsRefusal).
        const args = fromVersion===undefined ? [docId, { encodeRanges: true }] : [docId, fromVersion, { encodeRanges: true }];
        return this.emit('joinDoc', ...args)
            .then((returns: [Array<string>, number, Array<any>, any]) => {
                const [docLinesAscii, version, updates, ranges] = returns;
                const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
                return {docLines, version, updates, ranges};
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L591
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async leaveDoc(docId:string) {
        return this.emit('leaveDoc', docId)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     * @param {string} docId - The document id.
     * @param {any} update - The changes.
     * @returns {Promise}
     */
    async applyOtUpdate(docId:string, update:UpdateSchema) {
        // An update that carries no ops is a no-op — there is nothing for the
        // server to apply. The alternative connection scheme (SocketIOAlt)
        // already short-circuits these; the realtime socket must too. Recent
        // overleaf.com real-time validation rejects an empty-op update outright
        // (`'applyOtUpdate' rejected: Invalid input`) and then disconnects the
        // client, after which every following write fails until the window is
        // reloaded. The genuine Overleaf client never emits an empty op either.
        if (!update.op?.length) {
            return;
        }
        // overleaf.com acknowledges an update that inserts "\r", does not apply it, and drops
        // the connection; the document writes send the text with "\n" (overleafLineEndings)
        if (update.op.some(op => op.i?.includes('\r') || op.d?.includes('\r'))) {
            throw new EmitRefusedError('applyOtUpdate', 'refused to send an update with a "\\r" character: Overleaf stores "\\n" line endings and drops the connection after such an update');
        }
        return this.emit('applyOtUpdate', docId, update)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L42
     * @returns {Promise}
     */
    async getConnectedUsers(): Promise<OnlineUserSchema[]> {
        return this.emit('clientTracking.getConnectedUsers')
            .then((returns:[OnlineUserSchema[]]) => {
                const [connectedUsers] = returns;
                return connectedUsers;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L150
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async updatePosition(doc_id:string, row:number, column:number) {
        return this.emit('clientTracking.updatePosition', {row, column, doc_id})
            .then(() => {
                return;
            });
    }
}
