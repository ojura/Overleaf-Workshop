import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
    ControlRequest, NoReplicaWindowError, POINTER_FILE, ReplicaControlServer, replicaSocketPath, ReplicaTimeoutError,
    ReplicaUnreachableError, requestReplica,
} from '../scm/replicaControl';
import { Cleanup, SHORT_TEMP } from './replicaTestWorld';

describe('the control socket of a local replica', () => {
    let runtime: string;
    let folder: string;
    let savedRuntime: string | undefined;
    const servers: ReplicaControlServer[] = [];
    const logs: string[] = [];

    beforeEach(() => {
        savedRuntime = process.env.XDG_RUNTIME_DIR;
        runtime = fs.mkdtempSync(path.join(SHORT_TEMP, 'owr-'));
        fs.chmodSync(runtime, 0o700);
        process.env.XDG_RUNTIME_DIR = runtime;
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-replica-'));
        logs.length = 0;
    });
    afterEach(() => {
        servers.splice(0).forEach(server => server.dispose());
        if (savedRuntime === undefined) { delete process.env.XDG_RUNTIME_DIR; } else { process.env.XDG_RUNTIME_DIR = savedRuntime; }
        fs.rmSync(runtime, { recursive: true, force: true });
        fs.rmSync(folder, { recursive: true, force: true });
    });

    const serve = (handle: (request: ControlRequest) => Promise<any>, dir = folder) => {
        const server = new ReplicaControlServer(dir, handle, message => logs.push(message));
        servers.push(server);
        return server;
    };

    it('answers a status and a sync request, and names its socket in the folder', async () => {
        const asked: string[] = [];
        const socket = await serve(async request => {
            asked.push(request.op);
            return request.op === 'sync' ? { ok: true, summary: { uploaded: ['/main.tex'] } } : { ok: true, connected: true };
        }).start();
        assert.strictEqual(socket, replicaSocketPath(folder));
        const pointer = JSON.parse(fs.readFileSync(path.join(folder, POINTER_FILE), 'utf8'));
        assert.strictEqual(pointer.socket, socket);
        assert.strictEqual(pointer.pid, process.pid);

        assert.deepStrictEqual(await requestReplica(folder, { op: 'status' }, 5000), { ok: true, connected: true });
        assert.deepStrictEqual(await requestReplica(folder, { op: 'sync' }, 5000), { ok: true, summary: { uploaded: ['/main.tex'] } });
        assert.deepStrictEqual(asked, ['status', 'sync']);
    });

    /**
     * Point XDG_RUNTIME_DIR to a folder with a path so long that the socket's path does not fit
     * into a socket's address. Node would make the socket at the first 108 bytes of the path (104
     * on macOS), a name in `runtime` beside the long folder.
     */
    const longRuntime = () => {
        const long = path.join(runtime, 'a-runtime-folder-with-a-long-name-'.repeat(3));
        fs.mkdirSync(long, { mode: 0o700 });
        process.env.XDG_RUNTIME_DIR = long;
        return long;
    };

    it('does not listen on a socket path that is too long for the system, so that Node does not make a socket at a shortened path', async function () {
        // the bytes of sun_path, with the path's NUL; other systems have the check after listen
        const sunPath = ({ linux: 108, darwin: 104 } as Partial<Record<NodeJS.Platform, number>>)[process.platform];
        if (sunPath === undefined) { this.skip(); }
        const long = longRuntime();
        const socket = replicaSocketPath(folder);
        // a file where Node would make the socket: a listen would fail there with EADDRINUSE
        const shortened = Buffer.from(socket).subarray(0, sunPath).toString();
        fs.writeFileSync(shortened, 'a file of another program');
        assert.strictEqual(await serve(async () => ({ ok: true })).start(), undefined, 'the server does not listen');
        const reason = `the path of the control socket, ${socket} (${Buffer.byteLength(socket)} bytes), is longer than the ${sunPath - 1} bytes that a socket's path may have on this system: set XDG_RUNTIME_DIR to a folder with a shorter path`;
        assert.deepStrictEqual(logs, [`Tools cannot ask for a sync: ${reason}.`], 'the log');
        await assert.rejects(requestReplica(folder, { op: 'status' }, 5000),
            (error: Error) => error instanceof ReplicaUnreachableError && error.message === `the IDE window that keeps ${folder} in sync cannot answer tools: ${reason}`,
            'a tool\'s answer');
        assert.strictEqual(fs.readFileSync(shortened, 'utf8'), 'a file of another program', 'the file at the shortened path');
        assert.deepStrictEqual(fs.readdirSync(long), [], 'the long runtime folder, without a socket folder');
    });

    it('does not connect a tool to a socket path that is too long for the system, where another program can listen at the shortened path', async function () {
        const sunPath = ({ linux: 108, darwin: 104 } as Partial<Record<NodeJS.Platform, number>>)[process.platform];
        if (sunPath === undefined) { this.skip(); }
        longRuntime();
        const socket = replicaSocketPath(folder);
        // another program listens where Node would connect a tool: at the first bytes of the path that fit into sun_path
        const requests: string[] = [];
        const connections: net.Socket[] = [];
        const other = net.createServer(connection => {
            connections.push(connection);
            connection.setEncoding('utf8');
            connection.on('data', request => {
                requests.push(String(request).trim());
                connection.end(JSON.stringify({ ok: true, from: 'another program' }) + '\n');
            });
        });
        await new Promise<void>(resolve => other.listen(Buffer.from(socket).subarray(0, sunPath).toString(), resolve));
        try {
            const reason = `the path of the control socket, ${socket} (${Buffer.byteLength(socket)} bytes), is longer than the ${sunPath - 1} bytes that a socket's path may have on this system: set XDG_RUNTIME_DIR to a folder with a shorter path`;
            await assert.rejects(requestReplica(folder, { op: 'sync' }, 5000),
                (error: Error) => error instanceof ReplicaUnreachableError && error.message === `tools cannot reach an IDE window for ${folder}: ${reason}`,
                'a tool\'s answer');
            assert.deepStrictEqual({ connections: connections.length, requests }, { connections: 0, requests: [] }, 'what the other program got');
        } finally {
            connections.forEach(connection => connection.destroy());
            await new Promise<void>(resolve => other.close(() => resolve()));
        }
    });

    it('listens on a socket path as long as the system allows, and not on one a byte longer', async function () {
        const sunPath = ({ linux: 108, darwin: 104 } as Partial<Record<NodeJS.Platform, number>>)[process.platform];
        if (sunPath === undefined) { this.skip(); }
        const added = Buffer.byteLength(replicaSocketPath(folder)) - Buffer.byteLength(runtime);
        /** a runtime folder that makes the socket's path `bytes` long */
        const runtimeFor = (bytes: number) => {
            const dir = path.join(runtime, 'r'.repeat(bytes - added - Buffer.byteLength(runtime) - 1));
            fs.mkdirSync(dir, { mode: 0o700 });
            process.env.XDG_RUNTIME_DIR = dir;
        };
        runtimeFor(sunPath - 1);
        const longest = replicaSocketPath(folder);
        assert.strictEqual(Buffer.byteLength(longest), sunPath - 1);
        const server = serve(async () => ({ ok: true }));
        assert.strictEqual(await server.start(), longest, 'the server listens');
        assert.deepStrictEqual(await requestReplica(folder, { op: 'status' }, 5000), { ok: true }, 'a tool\'s answer');
        server.dispose();

        runtimeFor(sunPath);
        assert.strictEqual(Buffer.byteLength(replicaSocketPath(folder)), sunPath);
        assert.strictEqual(await serve(async () => ({ ok: true })).start(), undefined, 'the server does not listen on a path a byte longer');
        assert.match(logs[logs.length - 1], new RegExp(`is longer than the ${sunPath - 1} bytes that a socket's path may have on this system`));
    });

    it('closes the socket that Node made at a shortened path on a system without a known limit, and tools say why', async function () {
        if (process.platform === 'win32') { this.skip(); }
        // a system that SUN_PATH_BYTES does not list: the server listens, and the check after listen finds the shortening
        const saved = ReplicaControlServer.sunPathBytes;
        ReplicaControlServer.sunPathBytes = undefined;
        try {
            const long = longRuntime();
            const socket = replicaSocketPath(folder);
            assert.strictEqual(await serve(async () => ({ ok: true })).start(), undefined, 'the server does not listen');
            const reason = `Node shortened the path of the control socket, ${socket} (${Buffer.byteLength(socket)} bytes), as a socket's path must be shorter: set XDG_RUNTIME_DIR to a folder with a shorter path`;
            assert.deepStrictEqual(logs, [`Tools cannot ask for a sync: ${reason}.`], 'the log');
            await assert.rejects(requestReplica(folder, { op: 'status' }, 5000),
                (error: Error) => error instanceof ReplicaUnreachableError && error.message === `the IDE window that keeps ${folder} in sync cannot answer tools: ${reason}`,
                'a tool\'s answer');
            assert.deepStrictEqual(fs.readdirSync(runtime), [path.basename(long)],
                'the runtime folder, where Node made the socket at the shortened path, after the server closed');
        } finally {
            ReplicaControlServer.sunPathBytes = saved;
        }
    });

    it('lets a test that waits for the server fail at once with the reason it cannot listen', async function () {
        if (process.platform === 'win32') { this.skip(); }
        longRuntime();
        // the replica's own folder, which a replica folder has before its control server starts
        fs.mkdirSync(path.join(folder, '.overleaf'));
        const cleanup = new Cleanup();
        try {
            const listens = cleanup.controlListens(folder);
            await serve(async () => ({ ok: true })).start();
            await assert.rejects(listens, /^Error: the replica's control server cannot listen: .*the path of the control socket, /);
        } finally {
            await cleanup.undo();
        }
    });

    it('keeps the socket and its folder to this user', async () => {
        const socket = (await serve(async () => ({ ok: true })).start())!;
        assert.strictEqual(fs.statSync(path.dirname(socket)).mode & 0o777, 0o700);
        assert.strictEqual(fs.statSync(socket).mode & 0o777, 0o600);
    });

    it('lets one window answer for a folder, and a second one says so', async () => {
        const first = await serve(async () => ({ ok: true, window: 1 })).start();
        const second = await serve(async () => ({ ok: true, window: 2 })).start();
        assert.ok(first);
        assert.strictEqual(second, undefined);
        assert.ok(logs.some(message => /Another window keeps this folder in sync/.test(message)));
        assert.deepStrictEqual(await requestReplica(folder, { op: 'status' }, 5000), { ok: true, window: 1 });
    });

    it('takes over a socket left behind by a window that ended', async () => {
        const socket = replicaSocketPath(folder);
        fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
        fs.writeFileSync(socket, ''); // what a crash leaves: the path is taken, nothing answers
        assert.strictEqual(await serve(async () => ({ ok: true })).start(), socket);
        assert.deepStrictEqual(await requestReplica(folder, { op: 'status' }, 5000), { ok: true });
    });

    it('removes its socket and its pointer when it is disposed', async () => {
        const server = serve(async () => ({ ok: true }));
        const socket = (await server.start())!;
        server.dispose();
        assert.strictEqual(fs.existsSync(socket), false);
        assert.strictEqual(fs.existsSync(path.join(folder, POINTER_FILE)), false);
        await assert.rejects(requestReplica(folder, { op: 'status' }, 5000), NoReplicaWindowError);
    });

    it('does not keep listening when it is disposed while it starts', async () => {
        const server = serve(async () => ({ ok: true }));
        const starting = server.start();
        server.dispose();
        assert.strictEqual(await starting, undefined);
        assert.strictEqual(fs.existsSync(replicaSocketPath(folder)), false);
        await assert.rejects(requestReplica(folder, { op: 'status' }, 5000), NoReplicaWindowError);
    });

    it('answers a request it does not know, or a broken one, with an error', async () => {
        await serve(async () => ({ ok: true })).start();
        const answer = await requestReplica(folder, { op: 'restart' } as any, 5000);
        assert.deepStrictEqual(answer, { ok: false, error: 'unknown request "restart"' });
    });

    it('passes on what went wrong in the window', async () => {
        await serve(async () => { throw new Error('This local replica has not started.'); }).start();
        assert.deepStrictEqual(await requestReplica(folder, { op: 'sync' }, 5000), { ok: false, error: 'This local replica has not started.' });
    });

    it('says when no window answers for the folder', async () => {
        await assert.rejects(requestReplica(folder, { op: 'status' }, 5000), NoReplicaWindowError);
    });

    it('says when the window does not answer in time', async () => {
        await serve(() => new Promise(() => { /* a sync that never ends */ })).start();
        await assert.rejects(requestReplica(folder, { op: 'sync' }, 300), ReplicaTimeoutError);
    });

    it('finds the socket from the pointer file when the program computes another path', async () => {
        const socket = (await serve(async () => ({ ok: true })).start())!;
        // e.g. a program whose environment has no XDG_RUNTIME_DIR
        delete process.env.XDG_RUNTIME_DIR;
        assert.notStrictEqual(replicaSocketPath(folder), socket);
        assert.deepStrictEqual(await requestReplica(folder, { op: 'status' }, 5000), { ok: true });
    });
});
