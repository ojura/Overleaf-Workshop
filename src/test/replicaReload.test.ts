import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ControlRequest, POINTER_FILE, ReplicaCancelledError, ReplicaControlServer, ReplicaTimeoutError, requestReplica } from '../scm/replicaControl';
import { reloadReplica, ReplicaReloadError } from '../scm/replicaReload';
import { Cleanup } from './replicaTestWorld';

describe('replica window reload acknowledgement', function () {
    this.timeout(10_000);
    let cleanup: Cleanup, folder: string;
    const host = (id: string) => ({ id, pid: process.pid, since: new Date().toISOString() });

    beforeEach(() => {
        cleanup = new Cleanup(); cleanup.privateRuntime();
        folder = cleanup.tempDir('replica-reload-');
    });
    afterEach(async () => { await cleanup.undo(); });

    async function serve(id: string, reload?: () => Promise<unknown> | unknown,
        handle: (request: ControlRequest, signal?: AbortSignal) => Promise<any> = async () => ({ ok: true, connected: true }), directory = folder) {
        const server = new ReplicaControlServer(directory, handle, () => {}, { host: host(id), reload });
        cleanup.add(() => server.dispose());
        assert.ok(await server.start());
        return server;
    }

    it('identifies the actual extension host and the canonical replica folder', async () => {
        await serve('host-a', async () => {});
        const answer: any = await requestReplica(folder, { op: 'host' } as any, 1000);
        assert.strictEqual(answer.ok, true);
        assert.strictEqual(answer.host.id, 'host-a');
        assert.strictEqual(answer.folder, fs.realpathSync(folder));
        assert.strictEqual(answer.reloadSupported, true);
        const pointer = JSON.parse(fs.readFileSync(path.join(folder, POINTER_FILE), 'utf8'));
        assert.deepStrictEqual(pointer.host, answer.host);
    });

    it('acknowledges one reload before its command and rejects an obsolete host', async () => {
        let calls = 0, invoked!: () => void;
        const command = new Promise<void>(resolve => { invoked = resolve; });
        await serve('host-a', () => { calls++; invoked(); });
        const old: any = await requestReplica(folder, { op: 'reload', folder, host: 'retired-host', id: 'obsolete' } as any, 1000);
        assert.strictEqual(old.ok, false);
        assert.match(old.error, /host/i);
        assert.strictEqual(calls, 0);
        const answer: any = await requestReplica(folder, { op: 'reload', folder, host: 'host-a', id: 'reload-1' } as any, 1000);
        assert.strictEqual(answer.ok, true);
        assert.strictEqual(answer.reload.id, 'reload-1');
        assert.strictEqual(answer.host.id, 'host-a');
        await command;
        assert.strictEqual(calls, 1);
    });

    it('requires the requested host and folder before waiting for replica readiness', async () => {
        let release!: () => void, entered!: () => void;
        const ready = new Promise<void>(resolve => { release = resolve; });
        const called = new Promise<void>(resolve => { entered = resolve; });
        await serve('new-host', undefined, async () => { entered(); await ready; return { ok: true, connected: true }; });
        const wrong: any = await requestReplica(folder, { op: 'ready', folder: folder + '-other', host: 'new-host' } as any, 1000);
        assert.strictEqual(wrong.ok, false); assert.match(wrong.error, /folder/i);
        const answer = requestReplica(folder, { op: 'ready', folder, host: 'new-host' } as any, 1000);
        try { await called; } finally { release(); }
        const value: any = await answer;
        assert.strictEqual(value.ok, true); assert.strictEqual(value.ready, true);
        assert.strictEqual(value.host.id, 'new-host');
    });

    it('observes a fast replacement and waits for the new host actual readiness reply', async () => {
        let release!: () => void, called!: () => void, calls = 0;
        const ready = new Promise<void>(resolve => { release = resolve; });
        const reached = new Promise<void>(resolve => { called = resolve; });
        const old = await serve('old', async () => {
            calls++; old.dispose();
            await serve('new', undefined, async request => {
                assert.strictEqual(request.op, 'ready'); called(); await ready;
                return { ok: true, connected: true, git: { head: 'same', overleaf: 'same' } };
            });
        });
        let completed = false;
        const running = reloadReplica(folder, 2000).then(value => { completed = true; return value; });
        try {
            await reached; assert.strictEqual(completed, false);
        } finally { release(); }
        const report = await running;
        assert.strictEqual(report.previousHost.id, 'old'); assert.strictEqual(report.host.id, 'new');
        assert.strictEqual(report.readiness.ready, true); assert.strictEqual(calls, 1);
        assert.deepStrictEqual(report.readiness.git, { head: 'same', overleaf: 'same' });
    });

    it('rejects a pointer to another replica without reloading its window', async () => {
        let calls = 0;
        const other = cleanup.tempDir('replica-other-');
        await serve('other-host', () => { calls++; }, undefined, other);
        fs.mkdirSync(path.join(folder, '.overleaf'));
        fs.copyFileSync(path.join(other, POINTER_FILE), path.join(folder, POINTER_FILE));
        await assert.rejects(reloadReplica(folder, 1000), /different replica folder/);
        assert.strictEqual(calls, 0);
    });

    it('does not submit reload when the replacement observer cannot start', async () => {
        let calls = 0;
        await serve('host', () => { calls++; });
        const nativeFs = require('fs'), original = nativeFs.watch;
        const failure = new Error('fixture watch capacity exhausted');
        nativeFs.watch = () => { throw failure; };
        cleanup.add(() => { nativeFs.watch = original; });
        await assert.rejects(reloadReplica(folder, 1000), error => error === failure);
        assert.strictEqual(calls, 0);
    });

    it('cancels a pending preparation when its replacement observer fails', async () => {
        let calls = 0, entered!: () => void, release!: () => void, observer: fs.FSWatcher | undefined;
        const called = new Promise<void>(resolve => { entered = resolve; });
        const preparation = new Promise<void>(resolve => { release = resolve; });
        const server = await serve('host', () => { calls++; }, async () => { entered(); await preparation; return { ok: true }; });
        const nativeFs = require('fs'), original = nativeFs.watch;
        nativeFs.watch = (...args: any[]) => { observer = original(...args); return observer; };
        cleanup.add(() => { nativeFs.watch = original; });
        const failure = new Error('fixture replacement observer failed');
        const result = reloadReplica(folder, 500);
        try {
            await called;
            assert.ok(observer);
            const disconnected = Promise.all([...(server as any).connections as Set<any>]
                .map(socket => new Promise<void>(resolve => socket.once('close', resolve))));
            observer.emit('error', failure);
            await assert.rejects(result, error => error === failure);
            await disconnected;
        } finally { nativeFs.watch = original; release(); }
        await cleanup.folderShows(path.dirname(path.join(folder, POINTER_FILE)), () =>
            JSON.parse(fs.readFileSync(path.join(folder, POINTER_FILE), 'utf8')).reload?.state === 'cancelled');
        assert.strictEqual(calls, 0);
    });

    it('reports rejected and explicitly cancelled commands through the original pointer', async () => {
        let first = await serve('reject-host', () => { throw new Error('Reload rejected by IDE'); });
        await assert.rejects(reloadReplica(folder, 1000), /Reload rejected by IDE/);
        first.dispose();
        first = await serve('cancel-host', () => false);
        await assert.rejects(reloadReplica(folder, 1000), /cancelled the window reload/);
        first.dispose();
    });

    it('never accepts a restarted control server in the same extension host as a replacement', async () => {
        let replacement!: ReplicaControlServer, calls = 0;
        const old = await serve('same-host', async () => { calls++; old.dispose(); replacement = await serve('same-host'); });
        await assert.rejects(reloadReplica(folder, 100), ReplicaTimeoutError);
        assert.strictEqual(calls, 1); assert.ok(replacement);
    });

    it('cancels observation while waiting for new-host readiness and closes the waiting socket', async () => {
        const abort = new AbortController();
        let release!: () => void, reached!: () => void, replacement!: ReplicaControlServer, calls = 0;
        const ready = new Promise<void>(resolve => { release = resolve; });
        const called = new Promise<void>(resolve => { reached = resolve; });
        const old = await serve('old', async () => {
            calls++; old.dispose();
            replacement = await serve('new', undefined, async () => { reached(); await ready; return { ok: true }; });
        });
        const result = reloadReplica(folder, 2000, abort.signal);
        try {
            await called;
            const disconnected = Promise.all([...(replacement as any).connections as Set<any>].map(socket => new Promise<void>(resolve => socket.once('close', resolve))));
            abort.abort();
            await assert.rejects(result, ReplicaCancelledError);
            await disconnected;
            assert.strictEqual((replacement as any).connections.size, 0);
            assert.strictEqual(calls, 1);
        } finally { release(); }
    });

    it('cancels before submission without issuing a reload', async () => {
        let calls = 0; await serve('host', () => { calls++; });
        const abort = new AbortController(); abort.abort();
        await assert.rejects(reloadReplica(folder, 1000, abort.signal), ReplicaCancelledError);
        assert.strictEqual(calls, 0);
    });

    it('does not reload after the caller cancels while preparation is still pending', async () => {
        const abort = new AbortController();
        let release!: () => void, entered!: () => void, calls = 0;
        const preparation = new Promise<void>(resolve => { release = resolve; });
        const called = new Promise<void>(resolve => { entered = resolve; });
        const server = await serve('host', () => { calls++; }, async () => {
            entered(); await preparation; return { ok: true };
        });
        const result = reloadReplica(folder, 2000, abort.signal);
        try {
            await called;
            const disconnected = Promise.all([...(server as any).connections as Set<any>]
                .map(socket => new Promise<void>(resolve => socket.once('close', resolve))));
            abort.abort();
            await assert.rejects(result, ReplicaCancelledError);
            await disconnected;
        } finally { release(); }
        await cleanup.folderShows(path.dirname(path.join(folder, POINTER_FILE)), () =>
            JSON.parse(fs.readFileSync(path.join(folder, POINTER_FILE), 'utf8')).reload?.state === 'cancelled');
        assert.strictEqual(calls, 0);
    });

    it('ends the server request lifetime when its client disconnects', async () => {
        const abort = new AbortController();
        let entered!: () => void, release!: () => void, stopped!: () => void, signal: AbortSignal | undefined;
        const called = new Promise<void>(resolve => { entered = resolve; });
        const preparation = new Promise<void>(resolve => { release = resolve; });
        const ended = new Promise<void>(resolve => { stopped = resolve; });
        let calls = 0;
        await serve('host', () => { calls++; }, async (_request, owner) => {
            signal = owner; entered();
            owner?.addEventListener('abort', stopped, { once: true });
            await preparation; return { ok: true };
        });
        const result = reloadReplica(folder, 1000, abort.signal);
        try {
            await called;
            assert.ok(signal, 'the provider receives the request lifetime');
            abort.abort();
            await assert.rejects(result, ReplicaCancelledError);
            await ended;
            assert.strictEqual(signal.aborted, true);
            assert.strictEqual(calls, 0);
        } finally { abort.abort(); release(); void result.catch(() => {}); }
    });

    it('does not repeat a request after a lost response or allow a competing in-flight request', async () => {
        let calls = 0, release!: () => void;
        const command = new Promise<void>(resolve => { release = resolve; });
        await serve('host', () => { calls++; return command; });
        const request = { op: 'reload', folder, host: 'host', id: 'same-request' } as const;
        try {
            assert.strictEqual((await requestReplica(folder, request, 1000)).ok, true);
            assert.strictEqual((await requestReplica(folder, request, 1000)).ok, true);
            const other = await requestReplica(folder, { ...request, id: 'other-request' }, 1000);
            assert.strictEqual(other.ok, false); assert.strictEqual(calls, 1);
        } finally { release(); }
    });

    it('releases a failed acknowledgement write so a later request can proceed', async () => {
        let calls = 0, invoked!: () => void;
        const called = new Promise<void>(resolve => { invoked = resolve; });
        const server = await serve('host', () => { calls++; invoked(); });
        const failedConnection = { destroyed: false, write(_line: string, done: (error: Error) => void) {
            done(new Error('fixture acknowledgement write failed'));
        } };
        await (server as any).answer(failedConnection, JSON.stringify({ op: 'reload', folder, host: 'host', id: 'unacknowledged' }));
        assert.strictEqual(calls, 0);
        const later = await requestReplica(folder, { op: 'reload', folder, host: 'host', id: 'later-request' }, 1000);
        assert.strictEqual(later.ok, true, JSON.stringify(later));
        await called;
        assert.strictEqual(calls, 1);
    });

    it('keeps a replacement pointer when the old command rejects after host shutdown', async () => {
        let reject!: (error: Error) => void;
        const late = new Promise<void>((_yes, no) => { reject = no; });
        const old = await serve('old', async () => { old.dispose(); await serve('new'); return late; });
        const result = await reloadReplica(folder, 1000);
        assert.strictEqual(result.host.id, 'new');
        reject(new Error('Old renderer command reply')); await Promise.resolve(); await Promise.resolve();
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(folder, POINTER_FILE), 'utf8')).host.id, 'new');
    });

    it('reports incomplete new-host readiness instead of certifying a reload', async () => {
        const old = await serve('old', async () => {
            old.dispose(); await serve('new', undefined, async () => ({ ok: false, error: 'Initial sync cancelled', initialSync: { notChecked: 4 } }));
        });
        await assert.rejects(reloadReplica(folder, 1000), error => error instanceof ReplicaReloadError
            && error.answer?.ok === false && error.message === 'Initial sync cancelled');
    });

    it('the command-line tool prints the replacement host and exits after readiness', async () => {
        const old = await serve('cli-old', async () => { old.dispose(); await serve('cli-new'); });
        const cli = path.resolve(__dirname, '../sandbox/cli.js');
        const child = spawn(process.execPath, [cli, 'replica-reload', '--replica', folder, '--timeout', '2', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
        cleanup.add(() => { if (child.exitCode === null) { child.kill(); } });
        let out = '', err = '';
        child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        assert.strictEqual(code, 0, err);
        const report = JSON.parse(out); assert.strictEqual(report.host.id, 'cli-new'); assert.strictEqual(report.readiness.ready, true);
    });
});
