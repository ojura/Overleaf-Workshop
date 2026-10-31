// A small Chrome DevTools Protocol client for the harness: starts headless Chrome on a profile of
// its own in the work folder, opens one page and evaluates expressions in it. The browser is
// google-chrome, or the one the environment variable CHROME names.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Start headless Chrome on a fresh profile and connect to its page. close() stops Chrome and
 * deletes the profile; when this process exits before that, it kills Chrome and deletes the
 * profile on the way out.
 */
export async function launchChrome({ port = 9333, profile, width = 1200, height = 900 }) {
    fs.rmSync(profile, { recursive: true, force: true });
    const chrome = spawn(process.env.CHROME || 'google-chrome', [
        '--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
        `--window-size=${width},${height}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    // Chrome leads its own process group, with its renderer and GPU processes in it
    const stop = (signal = 'SIGTERM') => { try { process.kill(-chrome.pid, signal); } catch { chrome.kill(signal); } };
    const onExit = () => {
        stop('SIGKILL');
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* the next start deletes it */ }
    };
    process.once('exit', onExit);
    let target;
    for (let i = 0; i < 100 && !target; i++) {
        await new Promise(r => setTimeout(r, 100));
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            target = list.find(t => t.type === 'page');
        } catch { /* not up yet */ }
    }
    if (!target) { stop(); throw new Error(`headless Chrome did not start (port ${port})`); }
    const page = await connect(target.webSocketDebuggerUrl);
    const close = () => new Promise((resolve) => {
        const removeProfile = () => {
            fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            resolve();
        };
        page.close();
        process.removeListener('exit', onExit);
        if (chrome.exitCode !== null || chrome.signalCode !== null) { removeProfile(); return; }
        chrome.once('exit', removeProfile);
        stop();
    });
    return { chrome, page, close };
}

async function connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let next = 1;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) {
            for (const fn of listeners.get(msg.method) ?? []) { fn(msg.params); }
        }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
    const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    let contextId; // set by useFrame: evaluate in a child frame's page
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
        if (r.exceptionDetails) {
            throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
        }
        return r.result.value;
    };
    const waitFor = async (expression, timeoutMs = 30000, stepMs = 50) => {
        const start = Date.now();
        for (;;) {
            const value = await evaluate(expression).catch(() => undefined);
            if (value) { return { value, ms: Date.now() - start }; }
            if (Date.now() - start > timeoutMs) { throw new Error(`timed out waiting for ${expression}`); }
            await new Promise(r => setTimeout(r, stepMs));
        }
    };
    const screenshot = async (file) => {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
    };
    const contexts = [];
    on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
    /** From now on evaluate in the default context of the first child frame (call after Runtime.enable and navigation). */
    const useFrame = async (timeoutMs = 30000) => {
        const start = Date.now();
        for (;;) {
            const { frameTree } = await send('Page.getFrameTree');
            const child = frameTree.childFrames?.[0]?.frame;
            const context = child && [...contexts].reverse().find(c => c.auxData?.frameId === child.id && c.auxData?.isDefault);
            if (context) { contextId = context.id; return child; }
            if (Date.now() - start > timeoutMs) { throw new Error(`the page did not get a child frame within ${timeoutMs} ms`); }
            await new Promise(r => setTimeout(r, 50));
        }
    };
    return { send, on, evaluate, waitFor, screenshot, useFrame, close: () => ws.close() };
}
