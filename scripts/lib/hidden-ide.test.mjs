import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { processStat } from './test-instance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
test('SIGTERM during display readiness stops the recorded child before the launcher exits', { timeout: 15000 }, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-ide-display-test-'));
    const worker = fork(path.join(here, 'fixtures/display-startup.mjs'), [home], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let pid;
    let stderr = '';
    worker.stderr.on('data', data => { stderr += data; });
    t.after(() => {
        if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); }
        if (pid) {
            const stopped = spawnSync('python3', ['-I', path.join(here, 'stop-processes.py'), '--pid', String(pid), '--signal', 'KILL', '--limit', '2'], { encoding: 'utf8' });
            assert.equal(stopped.status, 0, stopped.stderr);
        }
        fs.rmSync(home, { recursive: true, force: true });
    });
    const [started] = await Promise.race([
        once(worker, 'message', { signal: t.signal }),
        once(worker, 'exit', { signal: t.signal }).then(([code, signal]) => { throw new Error(`offline launcher ended before display startup: ${code ?? signal}: ${stderr}`); }),
    ]);
    pid = started.pid;
    const exited = once(worker, 'exit', { signal: t.signal });
    worker.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 143, stderr);
    assert.equal(signal, null, stderr);
    const stat = processStat(pid);
    assert.ok(!stat || stat.state === 'Z' || stat.state === 'X', 'the display child must have exited before its launcher');
    assert.equal(started.recorded, true, 'the instance must own the process before its display is ready');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'instance.json'), 'utf8')).xvfb, pid);
});

test('a failed display ownership record closes the pipe and ends the child', { timeout: 15000 }, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-ide-display-test-'));
    const worker = fork(path.join(here, 'fixtures/display-startup.mjs'), [home, 'fail-record'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(worker, 'exit', { signal: t.signal });
    let pid;
    let stderr = '';
    worker.stderr.on('data', data => { stderr += data; });
    t.after(() => {
        if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); }
        if (pid) {
            const stopped = spawnSync('python3', ['-I', path.join(here, 'stop-processes.py'), '--pid', String(pid), '--signal', 'KILL', '--limit', '2'], { encoding: 'utf8' });
            assert.equal(stopped.status, 0, stopped.stderr);
        }
        fs.rmSync(home, { recursive: true, force: true });
    });
    const [failure] = await Promise.race([
        once(worker, 'message', { signal: t.signal }),
        exited.then(([code, signal]) => { throw new Error(`offline launcher ended without its failure: ${code ?? signal}: ${stderr}`); }),
    ]);
    pid = failure.pid;
    assert.equal(failure.code, 'EISDIR', stderr);
    assert.equal(failure.pipeDestroyed, true);
    assert.deepEqual(await exited, [0, null], stderr);
    const stat = processStat(pid);
    assert.ok(!stat || stat.state === 'Z' || stat.state === 'X');
    assert.ok(!fs.existsSync(path.join(home, 'instance.json')));
});
