/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import { SocketIOAlt } from './socketioAlt';
import { decodePackedUtf8 } from './packedUtf8';
import type { TrackChangesState } from '../utils/docUpdate';
import { errorMessage } from '../utils/errorMessage';


/**
 * The server answered an emit with an error: it refused the request. Real-time refuses an
 * update this way before it queues it (WebsocketController.applyOtUpdate); `answer` is what it
 * sent, which for most refusals carries only a message (Router._handleError).
 */
export class EmitRefusedError extends Error {
    constructor(readonly event: string, readonly answer: unknown) {
        super(`'${event}' rejected: ${errorMessage(answer)}`);
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

function handshakeError(error: unknown): Error {
    return new Error(`the connection was rejected: ${errorMessage(error)}`);
}

/**
 * Whether `error` is real-time's refusal 'doc updater could not load requested ops'
 * (ClientRequestedMissingOpsError, services/real-time/app/js/Errors.js). Real-time sends it when
 * document-updater could not load the doc (404), or the ops since the version asked for (422)
 * (DocumentUpdaterManager.getDocument), and Router._handleError forwards only that message, so
 * the message is the one value that tells this refusal from the others. It chooses only the
 * wording of what the user is told: VirtualFileSystem.settleUnconfirmed takes any refusal of the
 * read as an outcome that cannot be determined, so a change of the text changes that wording.
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
    onMessageEdited?: (message: { messageId: string; userId: string; content: string }) => void,
    onMessageDeleted?: (message: { messageId: string; userId: string }) => void,
    onMessagesRefreshed?: (messages: ProjectMessageResponseSchema[]) => void,
    onMetadataUpdated?: (metadata: { docId: string; meta: unknown }) => void,
    onProjectNameUpdated?: (name: string) => void,
    onProjectAccessChanged?: (change?: {newAccessLevel?: string}) => void,
    onProjectAccessRevoked?: () => void,
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
    private disposed = false;
    private readonly pending = new Set<() => void>();
    private readonly registrations = new Set<{ handlers: EventsHandler; active: boolean; cleanups: Array<() => void> }>();

    private socket?: any;
    private emit: any;
    /** Track the scheme used when the socket was last initialized */
    private _socketInitScheme?: ConnectionScheme;
    /** The current socket can be rejected before the owner first asks to join. */
    private connectionRejected?: Error;
    private readonly rejectedSchemes = new Set<ConnectionScheme>();

    constructor(private url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.init();
    }

    init() {
        if (this.disposed) { throw new Error('The project connection is disposed.'); }
        for (const registration of this.registrations) { registration.cleanups.splice(0).forEach(cleanup => cleanup()); }
        this.connectionRejected = undefined;

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
            if (this.disposed) { return Promise.reject(new Error('The project connection is closed.')); }
            if (this.connectionRejected) { return Promise.reject(this.connectionRejected); }
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = (error?: unknown, data?: any[]) => {
                    if (settled) { return; }
                    settled = true;
                    clearTimeout(timer);
                    socket.removeListener?.('connectionRejected', rejected);
                    this.pending.delete(cancel);
                    if (error) { reject(error); } else { resolve(data); }
                };
                const cancel = () => finish(new Error('The project connection is closed.'));
                const rejected = (error: unknown) => finish(handshakeError(error));
                const timer = setTimeout(() => {
                    if (settled) { return; }
                    finish(new EmitTimeoutError(event, SocketIOAPI.emitTimeoutMs));
                    if (!this.disposed && socket === this.socket) {
                        this.onConnectionProblem?.(`'${event}' got no answer within ${SocketIOAPI.emitTimeoutMs} ms`);
                    }
                }, SocketIOAPI.emitTimeoutMs);
                this.pending.add(cancel);
                socket.on?.('connectionRejected', rejected);
                try {
                    socket.emit(event, ...args, (err:any, ...data:any[]) => finish(err ? new EmitRefusedError(event, err) : undefined, data));
                } catch (error) { finish(error); }
            });
        };
        this.emit = require('util').promisify(this.socket.emit).bind(this.socket);
        // resume handlers
        this.initInternalHandlers();
        // Re-register existing event handlers on the new socket
        for (const registration of this.registrations) { this.bindHandlers(registration); }
        // Track which scheme this socket was created with
        this._socketInitScheme = this.scheme;
    }

    /** A changed scheme or a rejected handshake needs a new socket. */
    get needsReinit(): boolean {
        return this._socketInitScheme !== this.scheme || !this.socket || this.connectionRejected!==undefined;
    }

    private initInternalHandlers() {
        const socket = this.socket;
        const scheme = this.scheme;
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
            if (this.disposed || socket!==this.socket) { return; }
            console.log('SocketIOAPI: connectionRejected.', err?.message || err);
            this.connectionRejected = handshakeError(err);
            this.rejectedSchemes.add(scheme);
            // Select an untried handshake for the owner's next attempt. Once both have
            // been rejected, its existing retry/backoff keeps using the current scheme.
            if (scheme==='v1' && !this.rejectedSchemes.has('v2')) {
                console.log('SocketIOAPI: v1 rejected, retrying with v2');
                this.scheme = 'v2';
            } else if (scheme==='v2' && !this.rejectedSchemes.has('v1')) {
                console.log('SocketIOAPI: v2 rejected, falling back to v1');
                this.scheme = 'v1';
            }
            // Disable auto-reconnect on this socket: the server explicitly rejected
            // our connection parameters. Reconnecting would just get rejected again,
            // creating unnecessary TCP connection churn (and RST packets).
            try {
                // The bundled 0.9 client returns a namespace around the actual socket.
                if (socket.socket?.options) { socket.socket.options.reconnect = false; }
                if (typeof socket.io?.reconnect === 'function') { socket.io.reconnect(false); }
            } catch { /* a rejected connection still fails the owned calls */ }
        });
        this.socket.on('error', (err:any) => {
            // Log error instead of throwing to avoid crashing the extension
            console.error('SocketIOAPI: socket error', err?.message || err);
            this.onConnectionProblem?.(`socket error: ${errorMessage(err)}`);
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
                project.permissionsLevel = res.permissionsLevel;
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
        return [...this.registrations].map(registration => registration.handlers);
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

    /** Each subscriber owns its listeners, including their replacement-socket bindings. */
    updateEventHandlers(handlers: EventsHandler): { dispose(): void } {
        const registration = { handlers, active: !this.disposed, cleanups: [] as Array<() => void> };
        if (registration.active) {
            this.registrations.add(registration);
            this.bindHandlers(registration);
        }
        return { dispose: () => {
            registration.active = false;
            registration.cleanups.splice(0).forEach(cleanup => cleanup());
            this.registrations.delete(registration);
        } };
    }

    private bindHandlers(registration: { handlers: EventsHandler; active: boolean; cleanups: Array<() => void> }) {
        const socket = this.socket;
        const handlers = registration.handlers;
        const listen = (event: string, callback: (...args: any[]) => void) => {
            const listener = (...args: any[]) => {
                if (registration.active && !this.disposed && socket === this.socket) { callback(...args); }
            };
            socket.on(event, listener);
            registration.cleanups.push(() => socket.removeListener?.(event, listener));
        };
        if (handlers.onFileCreated) {
            listen('reciveNewDoc', (parent: string, doc: DocumentEntity) => handlers.onFileCreated!(parent, 'doc', doc));
            listen('reciveNewFile', (parent: string, file: FileRefEntity) => handlers.onFileCreated!(parent, 'file', file));
            listen('reciveNewFolder', (parent: string, folder: FolderEntity) => handlers.onFileCreated!(parent, 'folder', folder));
        }
        const direct: Array<[string, keyof EventsHandler]> = [
            ['reciveEntityRename', 'onFileRenamed'], ['removeEntity', 'onFileRemoved'],
            ['reciveEntityMove', 'onFileMoved'], ['otUpdateApplied', 'onFileChanged'],
            ['disconnect', 'onDisconnected'], ['clientTracking.clientUpdated', 'onClientUpdated'],
            ['clientTracking.clientDisconnected', 'onClientDisconnected'],
            ['new-chat-message', 'onReceivedMessage'], ['edit-global-message', 'onMessageEdited'],
            ['delete-global-message', 'onMessageDeleted'], ['chat-messages-refreshed', 'onMessagesRefreshed'],
            ['broadcastDocMeta', 'onMetadataUpdated'], ['projectNameUpdated', 'onProjectNameUpdated'],
            ['project:access:revoked', 'onProjectAccessRevoked'],
            ['project:publicAccessLevel:changed', 'onProjectAccessChanged'],
            ['project:collaboratorAccessLevel:changed', 'onProjectAccessChanged'],
            ['project:membership:changed', 'onProjectAccessChanged'],
            ['spellCheckLanguageUpdated', 'onSpellCheckLanguageUpdated'],
            ['compilerUpdated', 'onCompilerUpdated'], ['rootDocUpdated', 'onRootDocUpdated'],
            ['toggle-track-changes', 'onTrackChangesToggled'],
        ];
        for (const [event, name] of direct) {
            const handler = handlers[name];
            if (handler) { listen(event, handler as (...args: any[]) => void); }
        }
        if (handlers.onUpdateError) {
            listen('otUpdateError', (error: unknown, message?: { doc_id?: string }) =>
                handlers.onUpdateError!(message?.doc_id, errorMessage(error)));
        }
        if (handlers.onConnectionAccepted) {
            listen('connectionAccepted', (_: unknown, publicId: string) => handlers.onConnectionAccepted!(publicId));
            // v2 joins belong to this socket. A global bus would notify other projects too.
            listen('joinProjectResponse', (response: { publicId?: string }) => {
                if (this.scheme === 'v2' && typeof response.publicId === 'string') {
                    handlers.onConnectionAccepted!(response.publicId);
                }
            });
        }
    }

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        this.onConnectionProblem = undefined;
        for (const cancel of [...this.pending]) { cancel(); }
        for (const registration of this.registrations) {
            registration.active = false;
            registration.cleanups.splice(0).forEach(cleanup => cleanup());
        }
        this.registrations.clear();
        this.socket?.removeAllListeners?.();
        this.socket?.disconnect();
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
        if (this.disposed) { throw new Error('The project connection is closed.'); }
        if (this.connectionRejected) { throw this.connectionRejected; }
        const socket = this.socket;
        let timer: NodeJS.Timeout | undefined;
        let cancel!: () => void;
        const timeoutPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
            cancel = () => reject(new Error('The project connection is closed.'));
            this.pending.add(cancel);
            timer = setTimeout(() => {
                reject(new Error(`joining the project got no answer within ${SocketIOAPI.joinTimeoutMs} ms`));
            }, SocketIOAPI.joinTimeoutMs);
        });
        try {
            const project = await this.joinProjectOnce(project_id, timeoutPromise);
            if (socket===this.socket && !this.connectionRejected) { this.rejectedSchemes.clear(); }
            return project;
        } finally {
            clearTimeout(timer);
            this.pending.delete(cancel);
        }
    }

    private joinProjectOnce(project_id:string, timeoutPromise: Promise<ProjectEntity>): Promise<ProjectEntity> {
        const socket = this.socket;
        const cleanups: Array<() => void> = [];
        const listen = (event:string, handler:(...args:any[])=>void) => {
            socket.on(event, handler);
            cleanups.push(() => socket.removeListener?.(event, handler));
        };
        const raced = (promises: Promise<any>[]) => Promise.race(promises).finally(() => cleanups.forEach(cleanup => cleanup()));
        const rejected = new Promise<ProjectEntity>((_, reject) => {
            listen('connectionRejected', (error: unknown) => reject(handshakeError(error)));
        });
        switch(this.scheme) {
            case 'Alt':
            case 'v1':
                const joinPromise = this.emit('joinProject', {project_id})
                .then((returns:[ProjectEntity, string, number]) => {
                    const [project, permissionsLevel, protocolVersion] = returns;
                    if (permissionsLevel !== undefined) { project.permissionsLevel = permissionsLevel; }
                    this.record = Promise.resolve(project);
                    return project;
                });
                return raced([joinPromise, rejected, timeoutPromise]);
            case 'v2': {
                // fail at once when this connection cannot be made, instead of at the timeout
                const failed = new Promise<ProjectEntity>((_, reject) => {
                    listen('connect_failed', () => reject(new Error('the connection could not be made')));
                    listen('error', (err:any) => reject(new Error(`socket error: ${errorMessage(err)}`)));
                });
                return raced([this.record!, timeoutPromise, rejected, failed]);
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
