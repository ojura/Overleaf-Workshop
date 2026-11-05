import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connectMainProcess, connectWindow, processStat, waitForInstance } from './test-instance.mjs';
import { connect as connectDevtools, openConnectionCount } from './devtools.mjs';

const turn = () => new Promise(setImmediate);

/** Completed handshakes with controllable protocol answers; no network connection. */
function sockets(t, answer = () => undefined, autoOpen = true) {
    const opened = [];
    class Socket extends EventTarget {
        constructor(url) {
            super();
            this.url = url;
            this.sent = [];
            this.isClosed = false;
            opened.push(this);
            if (autoOpen) { queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        }
        send(text) {
            const command = JSON.parse(text);
            this.sent.push(command);
            const result = answer(command, this);
            if (result !== undefined) {
                queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result }) })));
            }
        }
        close() {
            if (this.isClosed) { return; }
            this.isClosed = true;
            this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: 'offline fixture closed' }));
        }
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', { ...original, value: Socket });
    t.after(() => Object.defineProperty(globalThis, 'WebSocket', original));
    t.after(() => { for (const socket of opened) { socket.close(); } });
    return opened;
}

for (const [name, connect, endpoint, method] of [
    ['browser', connectWindow, 'devtools', 'SystemInfo.getProcessInfo'],
    ['main process', connectMainProcess, 'inspector', 'Runtime.evaluate'],
]) {
    test(`the ${name} identity must answer after a completed handshake`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const opened = sockets(t);
        let outcome;
        const pending = connect({ home: '/unused-offline-fixture', pid: 42, [endpoint]: 'ws://offline.invalid/identity' });
        pending.then(value => { outcome = { value }; }, error => { outcome = { error }; });
        await turn();
        assert.deepEqual(opened[0].sent.map(command => command.method), [method]);
        t.mock.timers.tick(15000);
        await turn();
        assert.ok(outcome?.error, 'identity verification must terminate at its answer deadline');
        assert.match(outcome.error.message, /did not answer within/);
        assert.equal(opened[0].isClosed, true);
        assert.equal(openConnectionCount(), 0);
    });

    test(`the ${name} rejects the wrong identity and closes its connection`, async (t) => {
        const opened = sockets(t, () => method === 'Runtime.evaluate' ? { result: { value: 43 } } : { processInfo: [{ type: 'browser', id: 43 }] });
        await assert.rejects(connect({ home: '/unused-offline-fixture', pid: 42, [endpoint]: 'ws://offline.invalid/identity' }), /process 43/);
        assert.equal(opened[0].isClosed, true);
        assert.equal(openConnectionCount(), 0);
    });

    test(`the ${name} returns its verified connection for later commands`, async (t) => {
        const opened = sockets(t, () => method === 'Runtime.evaluate' ? { result: { value: 42 } } : { processInfo: [{ type: 'browser', id: 42 }] });
        const connection = await connect({ home: '/unused-offline-fixture', pid: 42, [endpoint]: 'ws://offline.invalid/identity' });
        assert.equal(opened[0].isClosed, false);
        assert.equal(openConnectionCount(), 1);
        connection.close();
        assert.equal(openConnectionCount(), 0);
    });
}

test('a handshake uses the shorter remaining startup deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const opened = sockets(t, () => undefined, false);
    const pending = assert.rejects(connectDevtools('ws://offline.invalid/handshake', { limitMs: 25 }), /handshake within 0.025 s/);
    t.mock.timers.tick(25);
    await pending;
    assert.equal(opened[0].isClosed, true);
    assert.equal(openConnectionCount(), 0);
});

test('startup applies its remaining deadline to the browser identity', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const opened = sockets(t);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-ide-identity-test-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'profile'));
    fs.writeFileSync(path.join(home, 'profile/DevToolsActivePort'), '32122\n/devtools/browser/abcdef\n');
    let outcome;
    waitForInstance(home, processStat(process.pid).group, 25).then(value => { outcome = { value }; }, error => { outcome = { error }; });
    await turn();
    assert.deepEqual(opened[0].sent.map(command => command.method), ['SystemInfo.getProcessInfo']);
    t.mock.timers.tick(25);
    await turn();
    assert.ok(outcome?.error, 'startup must end while identity verification is pending');
    assert.equal(opened[0].isClosed, true);
    assert.equal(openConnectionCount(), 0);
});

test('startup gives the main-process identity only the time left after browser readiness', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const opened = sockets(t, (command) => {
        if (command.method === 'SystemInfo.getProcessInfo') {
            t.mock.timers.tick(20);
            return { processInfo: [{ type: 'browser', id: process.pid }] };
        }
        if (command.method === 'Target.setDiscoverTargets') { return {}; }
        if (command.method === 'Target.getTargets') { return { targetInfos: [{ type: 'page', url: 'file:///workbench/workbench.html' }] }; }
        return undefined;
    });
    const read = fs.readFileSync;
    const list = fs.readdirSync;
    const link = fs.readlinkSync;
    t.mock.method(fs, 'readdirSync', (file, ...args) => file === `/proc/${process.pid}/fd` ? ['9'] : list(file, ...args));
    t.mock.method(fs, 'readlinkSync', (file, ...args) => file === `/proc/${process.pid}/fd/9` ? 'socket:[42]' : link(file, ...args));
    t.mock.method(fs, 'readFileSync', (file, ...args) => file === `/proc/${process.pid}/net/tcp` ? 'header\n0: 0100007F:7D7B 00000000:0000 0A 0 0 0 0 0 42\n' : read(file, ...args));
    const lookupLimits = [];
    t.mock.method(AbortSignal, 'timeout', (milliseconds) => { lookupLimits.push(milliseconds); return new AbortController().signal; });
    t.mock.method(globalThis, 'fetch', async () => ({ status: 200, text: async () => JSON.stringify([{ type: 'node', webSocketDebuggerUrl: 'ws://offline.invalid/node' }]) }));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-ide-identity-test-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, 'profile'));
    fs.writeFileSync(path.join(home, 'profile/DevToolsActivePort'), '32122\n/devtools/browser/abcdef\n');
    let outcome;
    waitForInstance(home, processStat(process.pid).group, 25).then(value => { outcome = { value }; }, error => { outcome = { error }; });
    await turn();
    assert.equal(opened.length, 2);
    assert.deepEqual(opened[1].sent.map(command => command.method), ['Runtime.evaluate']);
    assert.deepEqual(lookupLimits, [5]);
    t.mock.timers.tick(5);
    await turn();
    assert.ok(outcome?.error, 'the inspector identity must use the remaining 5 ms');
    assert.equal(opened.every(socket => socket.isClosed), true);
    assert.equal(openConnectionCount(), 0);
});
