import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { REPLICA_FOLDER } from './ignorePatterns';

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
 *                    acknowledgement of every change so far, record Overleaf's state in the
 *                    replica's git repository, and answer what was done; deletions of more
 *                    than ReplicaSync.deletionThreshold files on one side are not made, and
 *                    the answer is not ok until the user confirms them in the window
 *   {"op":"land","commit":"<id>"}
 *                    push a commit that descends from the checked-out one: fast-forward the
 *                    branch to it, upload what it changed and wait for Overleaf's acknowledgements
 */
export type ControlRequest = { op: 'status' } | { op: 'sync' } | { op: 'land', commit: string };
export type ControlAnswer = { ok: true, [key: string]: unknown } | { ok: false, error: string, [key: string]: unknown };

/** The file in a replica's folder that names the socket of the window keeping the folder in sync. */
export const POINTER_FILE = `${REPLICA_FOLDER}/control.json`;

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

/**
 * The bytes of sun_path, the field of a Unix socket's address that holds the socket's path and its
 * terminating NUL: 108 on Linux (unix(7): "On Linux, sun_path is 108 bytes in size"), and 104 on
 * macOS (xnu's bsd/sys/un.h: `char sun_path[104]`), FreeBSD (sys/sys/un.h: `#define SUNPATHLEN
 * 104`, `char sun_path[SUNPATHLEN]`) and OpenBSD (sys/sys/un.h: `char sun_path[104]`). unix(7)
 * asks, for portability, that the path and its NUL fit: Linux also binds a path of 108 bytes
 * without the NUL, which Node's clients reach but Python's refuse. On other systems, socketIsThere
 * finds a path that Node shortened.
 */
export const SUN_PATH_BYTES: Readonly<Partial<Record<NodeJS.Platform, number>>> = { linux: 108, darwin: 104, freebsd: 104, openbsd: 104 };

/**
 * Why `socket` cannot be a socket's path on this system, or undefined when it fits or when
 * SUN_PATH_BYTES does not give this system's limit. Node would shorten such a path at listen and
 * at connect alike. The callers add what to shorten: the runtime folder of the program that
 * computed the path.
 */
function socketPathTooLong(socket: string): string | undefined {
    const field = ReplicaControlServer.sunPathBytes;
    if (field === undefined || Buffer.byteLength(socket) < field) { return undefined; }
    return `the path of the control socket, ${socket} (${Buffer.byteLength(socket)} bytes), is longer than the ${field - 1} bytes that a socket's path may have on this system`;
}

/**
 * What to do about a socket path that a window computed: its runtime folder comes from the IDE's
 * environment, also when a tool shows the window's reason in another shell.
 */
const SHORTER_WINDOW_RUNTIME = 'start the IDE with XDG_RUNTIME_DIR set to a folder with a shorter path';

/**
 * Whether a socket is at `socket`, which a server listens on. Node shortens a socket path that is
 * too long, without an error: it makes the socket at the first bytes of the path that fit into
 * sun_path, and stat of the path asked for fails with ENOENT (measured with Node 22 on Linux,
 * where server.address() still answers the path asked for).
 */
function socketIsThere(socket: string): boolean {
    try {
        return fs.statSync(socket).isSocket();
    } catch (error: any) {
        if (error?.code === 'ENOENT') { return false; }
        throw error;
    }
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
    /**
     * The bytes of sun_path on this system (SUN_PATH_BYTES). start() refuses a socket path that
     * does not fit, with its NUL, before Node would make the socket at a shortened path, which can
     * be in a folder that other users can enter; requestReplica does not connect to such a path,
     * where another program can listen. Undefined on a system that SUN_PATH_BYTES does not list:
     * there, the check after listen finds the shortening, and the close removes that socket.
     */
    static sunPathBytes: number | undefined = SUN_PATH_BYTES[process.platform];

    private server?: net.Server;
    private socket?: string;
    private disposed = false;
    /** whether this server wrote the pointer file, with its socket or with why it cannot listen */
    private pointerWritten = false;

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
            const tooLong = socketPathTooLong(socket);
            if (tooLong) { return this.cannotListen(`${tooLong}: ${SHORTER_WINDOW_RUNTIME}`); }
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
                if (!error && process.platform !== 'win32' && !socketIsThere(socket)) {
                    // closing the server removes the socket at the shortened path
                    await new Promise<void>(resolve => server.close(() => resolve()));
                    return this.cannotListen(`Node shortened the path of the control socket, ${socket} (${Buffer.byteLength(socket)} bytes), as a socket's path must be shorter: ${SHORTER_WINDOW_RUNTIME}`);
                }
                if (!error) {
                    server.unref(); // the window lives on its own; a tool's process need not wait for the socket
                    this.server = server;
                    this.socket = socket;
                    if (process.platform !== 'win32') { fs.chmodSync(socket, 0o600); }
                    this.writePointer({ socket });
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

    /** Say in the log, and in the pointer file for the tools, why this window cannot listen. */
    private cannotListen(reason: string): undefined {
        this.log(`Tools cannot ask for a sync: ${reason}.`);
        this.writePointer({ error: reason });
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
            answer = (request?.op === 'status' || request?.op === 'sync' || (request?.op === 'land' && typeof request.commit === 'string'))
                ? await this.handle(request)
                : { ok: false, error: `unknown request ${JSON.stringify(request?.op)}` };
        } catch (error: any) {
            answer = { ok: false, error: String(error?.message ?? error) };
        }
        if (!connection.destroyed) { connection.write(JSON.stringify(answer) + '\n'); }
    }

    /** Name the socket in the folder, or why this window cannot listen, for the tools that look there. */
    private writePointer(content: { socket: string } | { error: string }) {
        try {
            const file = path.join(this.folder, POINTER_FILE);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // a new file renamed over the old one, so that a tool reads all of it or the one before
            const tmp = `${file}.${process.pid}.tmp`;
            const processStart = processStartTime(process.pid);
            fs.writeFileSync(tmp, JSON.stringify({
                ...content, pid: process.pid, ...(processStart === undefined ? {} : { processStart }), since: new Date().toISOString(),
            }, null, 4) + '\n');
            fs.renameSync(tmp, file);
            this.pointerWritten = true;
        } catch (error: any) {
            this.log(`Could not write ${path.join(this.folder, POINTER_FILE)}: ${error?.message ?? error}`);
        }
    }

    dispose() {
        this.disposed = true;
        const socket = this.socket;
        this.server?.close();
        this.server = undefined;
        this.socket = undefined;
        if (socket !== undefined && process.platform !== 'win32') { fs.rmSync(socket, { force: true }); }
        if (!this.pointerWritten) { return; }
        try {
            const file = path.join(this.folder, POINTER_FILE);
            const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (pointer.pid === process.pid && (pointer.socket === socket || typeof pointer.error === 'string')) { fs.rmSync(file, { force: true }); }
        } catch { /* gone, or another window's */ }
    }
}

/** A window does not answer for the folder: the IDE is not running, or it does not have the folder open as a replica. */
export class NoReplicaWindowError extends Error {}
/**
 * Tools cannot reach the window that keeps the folder in sync: the window's pointer file gives the
 * reason, or the socket's path is too long for this system, and a window does not listen at such a
 * path. In the second case a window may or may not run.
 */
export class ReplicaUnreachableError extends Error {}
/** The window did not answer in time. */
export class ReplicaTimeoutError extends Error {}

/** The socket a program should use for `folder`: the one the window named, else the computed one. */
export function findReplicaSocket(folder: string): string {
    return locateReplicaSocket(folder).socket;
}

/** findReplicaSocket's socket, and whether the window named it in the pointer file. */
function locateReplicaSocket(folder: string): { socket: string, named: boolean } {
    let pointer: any;
    try {
        pointer = JSON.parse(fs.readFileSync(path.join(folder, POINTER_FILE), 'utf8'));
    } catch { /* the pointer file is missing, or it is not JSON */ }
    if (typeof pointer?.socket === 'string') { return { socket: pointer.socket, named: true }; }
    if (typeof pointer?.error === 'string' && writerRuns(pointer)) {
        throw new ReplicaUnreachableError(`the IDE window that keeps ${folder} in sync cannot answer tools: ${pointer.error}`);
    }
    return { socket: replicaSocketPath(folder), named: false };
}

/**
 * Whether the window that wrote `pointer` runs: a process with its pid runs, and that process
 * started when the pointer says the window did. The pid decides alone for a pointer without the
 * start time, as older windows and systems without /proc write it, and when the system does not
 * give the start time of the process with that pid.
 */
function writerRuns(pointer: { pid?: unknown, processStart?: unknown }): boolean {
    if (!processRuns(pointer.pid)) { return false; }
    if (typeof pointer.processStart !== 'number') { return true; }
    const start = processStartTime(pointer.pid as number);
    return start === undefined || start === pointer.processStart;
}

/** Whether the process `pid` runs, e.g. the window that wrote a pointer file. */
function processRuns(pid: unknown): boolean {
    if (typeof pid !== 'number') { return false; }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        // EPERM: it runs, as another user's
        return error?.code === 'EPERM';
    }
}

/**
 * When the process `pid` started, as the system records it, or undefined where the system does not
 * give it. On Linux it is field 22 of /proc/<pid>/stat, starttime, in clock ticks after boot
 * (proc_pid_stat(5); man-pages before 6.06 list the fields in proc(5)), which tells a process from a
 * later one that has the same pid. The fields are counted after the last ")", as the command's
 * name before it, field 2, can contain spaces and ")".
 */
function processStartTime(pid: number): number | undefined {
    if (process.platform !== 'linux') { return undefined; }
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const field = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[22 - 3];
        return /^\d+$/.test(field ?? '') ? Number(field) : undefined;
    } catch {
        return undefined;
    }
}

/** Send one request to the window that keeps `folder` in sync and wait for its answer. */
export function requestReplica(folder: string, request: ControlRequest, timeoutMs: number): Promise<ControlAnswer> {
    let located: { socket: string, named: boolean };
    try {
        located = locateReplicaSocket(folder);
    } catch (error) {
        return Promise.reject(error);
    }
    const socket = located.socket;
    // Node would connect to the shortened path, where another program can listen
    const tooLong = socketPathTooLong(socket);
    if (tooLong) {
        // A window that named such a path computed it, e.g. a window of an earlier version, which
        // listened at the shortened path: the window's runtime folder is the one to shorten.
        const advice = located.named
            ? `; the IDE window named it in ${path.join(folder, POINTER_FILE)}, so ${SHORTER_WINDOW_RUNTIME}`
            : ': set XDG_RUNTIME_DIR to a folder with a shorter path';
        return Promise.reject(new ReplicaUnreachableError(`tools cannot reach an IDE window for ${folder}: ${tooLong}${advice}`));
    }
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
        client.once('error', (error: NodeJS.ErrnoException) => finish(() => {
            if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') { reject(error); return; }
            // ECONNREFUSED: the path is there, e.g. left by a window that ended, and a server does not listen on it
            const why = error.code === 'ENOENT' ? `${socket} does not exist` : `a server does not listen on ${socket}`;
            reject(new NoReplicaWindowError(`an IDE window does not keep ${folder} in sync: ${why}`));
        }));
        client.once('close', () => finish(() => reject(new Error(`the IDE window closed the connection without answering (${socket})`))));
    });
}
