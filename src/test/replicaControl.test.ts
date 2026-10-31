import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ControlRequest, NoReplicaWindowError, POINTER_FILE, ReplicaControlServer, replicaSocketPath, ReplicaTimeoutError,
    requestReplica,
} from '../scm/replicaControl';

describe('the control socket of a local replica', () => {
    let runtime: string;
    let folder: string;
    let savedRuntime: string | undefined;
    const servers: ReplicaControlServer[] = [];
    const logs: string[] = [];

    beforeEach(() => {
        savedRuntime = process.env.XDG_RUNTIME_DIR;
        runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-runtime-'));
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
