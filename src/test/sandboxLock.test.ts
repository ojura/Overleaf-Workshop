import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { acquireLock, LockOwner, LockTimeoutError, ownerHasExited, processStartTime } from '../sandbox/lock';

describe('sandbox lock', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lock-test-'));
        file = path.join(dir, 'sandbox.lock');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const ownerFile = (owner: Partial<LockOwner>) => fs.writeFileSync(file, JSON.stringify({
        pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), purpose: 'another run', token: 'other', ...owner,
    }));

    it('takes a free lock, names its owner in the file and removes it on release', async () => {
        const lock = await acquireLock(file, { timeoutMs: 0, purpose: 'compile main.tex' });
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(owner.pid, process.pid);
        assert.strictEqual(owner.purpose, 'compile main.tex');
        assert.strictEqual(owner.processStart, processStartTime(process.pid));
        lock.release();
        assert.strictEqual(fs.existsSync(file), false);
        lock.release(); // again: nothing happens
    });

    it('fails at once with timeout 0 while another run holds it, naming that run', async () => {
        const first = await acquireLock(file, { timeoutMs: 0, purpose: 'the first run' });
        await assert.rejects(acquireLock(file, { timeoutMs: 0, purpose: 'the second run' }),
            (error: any) => error instanceof LockTimeoutError && /the first run/.test(error.message));
        first.release();
    });

    it('waits until the holder releases it', async () => {
        const first = await acquireLock(file, { timeoutMs: 0, purpose: 'first' });
        setTimeout(() => first.release(), 150);
        const waits: number[] = [];
        const second = await acquireLock(file, { timeoutMs: 5000, pollMs: 20, reportMs: 50, purpose: 'second', onWait: (_o, ms) => waits.push(ms) });
        assert.ok(second.waitedMs >= 100, `waited ${second.waitedMs} ms`);
        assert.ok(waits.length >= 1);
        assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).purpose, 'second');
        second.release();
    });

    it('lets one run at a time hold it when many wait', async () => {
        let holders = 0;
        let most = 0;
        const order: number[] = [];
        await Promise.all(Array.from({ length: 8 }, async (_x, i) => {
            const lock = await acquireLock(file, { timeoutMs: 10000, pollMs: 5, purpose: `run ${i}` });
            holders += 1;
            most = Math.max(most, holders);
            order.push(i);
            await new Promise(resolve => setTimeout(resolve, 10));
            holders -= 1;
            lock.release();
        }));
        assert.strictEqual(most, 1);
        assert.strictEqual(order.length, 8);
    });

    it('takes over a lock whose owner has exited', async () => {
        const exited = spawnSync('true');
        assert.ok(exited.pid);
        ownerFile({ pid: exited.pid, processStart: undefined });
        assert.strictEqual(ownerHasExited(JSON.parse(fs.readFileSync(file, 'utf8'))), true);
        const lock = await acquireLock(file, { timeoutMs: 0, purpose: 'after a crash' });
        assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).purpose, 'after a crash');
        lock.release();
    });

    it('takes a pid that now belongs to another process for an exited owner', function () {
        if (processStartTime(process.pid) === undefined) { this.skip(); }
        assert.strictEqual(ownerHasExited({ pid: process.pid, host: os.hostname(), processStart: '1', acquiredAt: '', purpose: '', token: 't' }), true);
        assert.strictEqual(ownerHasExited({ pid: process.pid, host: os.hostname(), processStart: processStartTime(process.pid), acquiredAt: '', purpose: '', token: 't' }), false);
    });

    it('does not take over a live owner\'s lock, nor one taken on another machine', async () => {
        ownerFile({ pid: process.pid, processStart: processStartTime(process.pid) });
        await assert.rejects(acquireLock(file, { timeoutMs: 0, purpose: 'x' }), LockTimeoutError);
        ownerFile({ pid: 1, host: 'another-host' });
        assert.strictEqual(ownerHasExited(JSON.parse(fs.readFileSync(file, 'utf8'))), false);
    });

    it('takes over a lock file without a readable owner only once it is old', async () => {
        fs.writeFileSync(file, '');
        await assert.rejects(acquireLock(file, { timeoutMs: 0, purpose: 'x', unreadableStaleMs: 60 * 1000 }), LockTimeoutError);
        const old = new Date(Date.now() - 120 * 1000);
        fs.utimesSync(file, old, old);
        const lock = await acquireLock(file, { timeoutMs: 0, purpose: 'x', unreadableStaleMs: 60 * 1000 });
        lock.release();
    });

    it('leaves a lock that another acquisition took meanwhile when releasing', async () => {
        const lock = await acquireLock(file, { timeoutMs: 0, purpose: 'mine' });
        ownerFile({ token: 'someone else' });
        lock.release();
        assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'someone else');
    });

    it('does not remove a stale lock while another process is removing it', async () => {
        ownerFile({ token: 'stale' });
        fs.writeFileSync(`${file}.break`, '');
        await assert.rejects(acquireLock(file, { timeoutMs: 0, purpose: 'x', isStale: () => true }), LockTimeoutError);
        assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'stale');
        fs.unlinkSync(`${file}.break`);
        const lock = await acquireLock(file, { timeoutMs: 0, purpose: 'x', isStale: () => true });
        lock.release();
    });
});
