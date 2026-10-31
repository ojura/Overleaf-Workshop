import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/**
 * Lets programs outside the IDE talk to the window that keeps a local replica in sync, e.g. a
 * script that writes files into the folder and must wait until they are on Overleaf. The window
 * listens on a local socket, one per folder. Only this user can reach it: the socket is in the
 * user's runtime folder (or a folder of the user's own below the temporary folder), which other
 * users cannot enter. The window also writes the socket's path to `.overleaf/control.json` in the
 * folder, which the sync never uploads, so a program finds it whatever environment it runs in.
 *
 * Requests and answers are JSON objects, one per line:
 *   {"op":"status"}  the replica's state
 *   {"op":"sync"}    look for files changed on disk, upload them, wait for Overleaf's
 *                    acknowledgement of every change so far, and answer what was done
 */
export type ControlRequest = { op: 'status' } | { op: 'sync' };
export type ControlAnswer = { ok: true, [key: string]: unknown } | { ok: false, error: string, [key: string]: unknown };

/** The file in a replica's folder that names the socket of the window keeping the folder in sync. */
export const POINTER_FILE = '.overleaf/control.json';

/** The socket path for `folder`, computed from the folder's real path. */
export function replicaSocketPath(folder: string): string {
    let real = path.resolve(folder);
    try { real = fs.realpathSync(folder); } catch { /* not there (yet) */ }
    const key = crypto.createHash('sha1').update(real).digest('hex').slice(0, 16);
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\overleaf-workshop-${key}`;
    }
    const base = process.env.XDG_RUNTIME_DIR
        ? path.join(process.env.XDG_RUNTIME_DIR, 'overleaf-workshop')
        : path.join(os.tmpdir(), `overleaf-workshop-${os.userInfo().uid}`);
    return path.join(base, `${key}.sock`);
}

/** Create the socket's folder for this user only, or say why it cannot be used. */
function prepareSocketFolder(socket: string): string | undefined {
    if (process.platform === 'win32') { return undefined; }
    const dir = path.dirname(socket);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== os.userInfo().uid || (stat.mode & 0o077) !== 0) {
        return `${dir} is not a folder that only this user can enter`;
    }
    return undefined;
}

/** Whether a server answers on `socket`. */
function answers(socket: string): Promise<boolean> {
    return new Promise(resolve => {
        const client = net.connect(socket);
        client.once('connect', () => { client.destroy(); resolve(true); });
        client.once('error', () => resolve(false));
    });
}

export class ReplicaControlServer {
    private server?: net.Server;
    private socket?: string;
    private disposed = false;

    /**
     * @param folder the replica's folder
     * @param handle answers one request
     * @param log the replica's log
     */
    constructor(
        private readonly folder: string,
        private readonly handle: (request: ControlRequest) => Promise<ControlAnswer>,
        private readonly log: (message: string) => void,
    ) {}

    /** Listen; the socket's path, or undefined when another window keeps this folder in sync or the socket cannot be used. */
    async start(): Promise<string | undefined> {
        const socket = replicaSocketPath(this.folder);
        try {
            const problem = prepareSocketFolder(socket);
            if (problem) {
                this.log(`Tools cannot ask for a sync: ${problem}.`);
                return undefined;
            }
            for (let attempt = 0; attempt < 2; attempt++) {
                const server = net.createServer(connection => this.serve(connection));
                const error = await new Promise<NodeJS.ErrnoException | undefined>(resolve => {
                    server.once('error', resolve);
                    server.listen(socket, () => resolve(undefined));
                });
                if (!error && this.disposed) {
                    // disposed while starting, e.g. by a quick reconnect: the next provider listens
                    server.close();
                    if (process.platform !== 'win32') { fs.rmSync(socket, { force: true }); }
                    return undefined;
                }
                if (!error) {
                    server.unref(); // the window lives on its own; a tool's process need not wait for the socket
                    this.server = server;
                    this.socket = socket;
                    if (process.platform !== 'win32') { fs.chmodSync(socket, 0o600); }
                    this.writePointer(socket);
                    return socket;
                }
                if (error.code !== 'EADDRINUSE' || attempt > 0) { throw error; }
                if (await answers(socket)) {
                    this.log(`Another window keeps this folder in sync and answers tools at ${socket}.`);
                    return undefined;
                }
                fs.rmSync(socket, { force: true }); // left by a window that ended
            }
        } catch (error: any) {
            this.log(`Tools cannot ask for a sync: ${error?.message ?? error}.`);
        }
        return undefined;
    }

    private serve(connection: net.Socket) {
        let buffer = '';
        connection.setEncoding('utf8');
        connection.on('error', () => { /* the program went away */ });
        connection.on('data', chunk => {
            buffer += chunk;
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line) { void this.answer(connection, line); }
            }
        });
    }

    private async answer(connection: net.Socket, line: string) {
        let answer: ControlAnswer;
        try {
            const request = JSON.parse(line);
            answer = (request?.op === 'status' || request?.op === 'sync')
                ? await this.handle(request)
                : { ok: false, error: `unknown request ${JSON.stringify(request?.op)}` };
        } catch (error: any) {
            answer = { ok: false, error: String(error?.message ?? error) };
        }
        if (!connection.destroyed) { connection.write(JSON.stringify(answer) + '\n'); }
    }

    private writePointer(socket: string) {
        try {
            const file = path.join(this.folder, POINTER_FILE);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ socket, pid: process.pid, since: new Date().toISOString() }, null, 4) + '\n');
        } catch (error: any) {
            this.log(`Could not write ${POINTER_FILE}: ${error?.message ?? error}`);
        }
    }

    dispose() {
        this.disposed = true;
        const socket = this.socket;
        this.server?.close();
        this.server = undefined;
        this.socket = undefined;
        if (socket === undefined) { return; }
        if (process.platform !== 'win32') { fs.rmSync(socket, { force: true }); }
        try {
            const file = path.join(this.folder, POINTER_FILE);
            const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (pointer.socket === socket && pointer.pid === process.pid) { fs.rmSync(file, { force: true }); }
        } catch { /* gone, or another window's */ }
    }
}

/** No window answers for the folder: the IDE is not running, or it does not have the folder open as a replica. */
export class NoReplicaWindowError extends Error {}
/** The window did not answer in time. */
export class ReplicaTimeoutError extends Error {}

/** The socket a program should use for `folder`: the one the window named, else the computed one. */
export function findReplicaSocket(folder: string): string {
    try {
        const pointer = JSON.parse(fs.readFileSync(path.join(folder, POINTER_FILE), 'utf8'));
        if (typeof pointer.socket === 'string') { return pointer.socket; }
    } catch { /* no pointer file */ }
    return replicaSocketPath(folder);
}

/** Send one request to the window that keeps `folder` in sync and wait for its answer. */
export function requestReplica(folder: string, request: ControlRequest, timeoutMs: number): Promise<ControlAnswer> {
    const socket = findReplicaSocket(folder);
    return new Promise((resolve, reject) => {
        let buffer = '';
        let settled = false;
        const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); client.destroy(); fn(); } };
        const client = net.connect(socket);
        const timer = setTimeout(() => finish(() => reject(new ReplicaTimeoutError(
            `the IDE window did not answer within ${Math.round(timeoutMs / 1000)} s (${socket})`))), timeoutMs);
        client.setEncoding('utf8');
        client.once('connect', () => client.write(JSON.stringify(request) + '\n'));
        client.on('data', chunk => {
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline >= 0) {
                const line = buffer.slice(0, newline);
                finish(() => {
                    try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
                });
            }
        });
        client.once('error', (error: NodeJS.ErrnoException) => finish(() => reject(
            error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
                ? new NoReplicaWindowError(`no IDE window keeps ${folder} in sync (nothing answers at ${socket})`)
                : error)));
        client.once('close', () => finish(() => reject(new Error(`the IDE window closed the connection without answering (${socket})`))));
    });
}
