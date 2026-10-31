// Headless Chrome for the harness: starts it on a profile of its own in the work folder, opens one
// page and evaluates expressions in it. The browser is google-chrome, or the one the environment
// variable CHROME names. Chrome picks its DevTools port itself, and the harness connects through
// the endpoint that Chrome wrote into the profile (scripts/lib/devtools.mjs), so it drives only the
// Chrome it started.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connect, evaluate, waitFor, waitForActivePort, WaitLimitError } from '../lib/devtools.mjs';

/** The last resort for a Chrome that runs but never opens DevTools; it opens them within a second or two. */
const DEVTOOLS_LIMIT_MS = 30000;

/** Write each line that `stream` gives to this process's stderr, after `prefix`; empty lines are left out. */
function forwardLines(stream, prefix) {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines.filter(Boolean)) { process.stderr.write(`${prefix}${line}\n`); }
    });
    stream.on('end', () => { if (rest) { process.stderr.write(`${prefix}${rest}\n`); } });
}

/**
 * Start headless Chrome on a new profile in the folder `dir` and connect to its page. close()
 * stops Chrome and deletes the profile; when this process exits before that, it kills Chrome and
 * deletes the profile on the way out. Chrome's own messages go to this process's stderr, each line
 * after "chrome: ".
 */
export async function launchChrome({ dir, width = 1200, height = 900 }) {
    const profile = fs.mkdtempSync(path.join(dir, 'chrome-profile-'));
    const chrome = spawn(process.env.CHROME || 'google-chrome', [
        '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
        `--window-size=${width},${height}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    forwardLines(chrome.stderr, 'chrome: ');
    /** settles when Chrome's process has ended, with how it ended */
    const ended = new Promise((resolve, reject) => {
        chrome.once('exit', (code, signal) => resolve(signal ?? `exit code ${code}`));
        chrome.once('error', reject);
    });
    // Chrome leads its own process group, with its renderer and GPU processes in it
    const stop = (signal = 'SIGTERM') => { try { process.kill(-chrome.pid, signal); } catch { chrome.kill(signal); } };
    const removeProfile = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const onExit = () => {
        stop('SIGKILL');
        try { removeProfile(); } catch { /* the work folder can be deleted at any time */ }
    };
    process.once('exit', onExit);
    let browser;
    let page;
    try {
        browser = await connect(await waitForActivePort(profile, { ended, limitMs: DEVTOOLS_LIMIT_MS }));
        const { targetInfos } = await browser.send('Target.getTargets');
        const target = targetInfos.find(t => t.type === 'page');
        if (!target) { throw new Error(`headless Chrome (pid ${chrome.pid}) has no page`); }
        page = pageOf(await browser.attach(target.targetId));
    } catch (error) {
        browser?.close();
        process.removeListener('exit', onExit);
        stop('SIGKILL');
        await ended.catch(() => {});
        removeProfile();
        throw error;
    }
    const close = async () => {
        process.removeListener('exit', onExit);
        browser.close();
        stop();
        await ended.catch(() => {});
        removeProfile();
    };
    return { chrome, page, close };
}

/**
 * The harness's helpers on a session with a page: evaluate(expression), and waitFor(expression,
 * limitMs, stepMs), which ends with the page's exception when the expression throws, and with a
 * WaitLimitError (scripts/lib/devtools.mjs) when it is not truthy within limitMs.
 */
function pageOf(session) {
    const { send, on } = session;
    let contextId; // set by useFrame: evaluate in a child frame's page
    const screenshot = async (file) => {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
    };
    /** the execution contexts that exist, by id, from the Runtime domain's events */
    const contexts = new Map();
    on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
    on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
    on('Runtime.executionContextsCleared', () => contexts.clear());
    /**
     * From now on evaluate in the default context of a child frame of the page's main frame, and
     * return that frame's id: one that exists, or the first that the page attaches and gives a
     * context. Call it after Runtime.enable, Page.enable and the navigation. `limitMs` is the last
     * resort for a page that never gets a child frame.
     */
    const useFrame = async (limitMs = 30000) => {
        const { frameTree } = await send('Page.getFrameTree');
        const children = new Set((frameTree.childFrames ?? []).map(c => c.frame.id));
        return new Promise((resolve, reject) => {
            const stops = [];
            const finish = (settle, value) => { clearTimeout(timer); stops.forEach(stop => stop()); settle(value); };
            const look = () => {
                const context = [...contexts.values()].reverse().find(c => children.has(c.auxData?.frameId) && c.auxData?.isDefault);
                if (context) { contextId = context.id; finish(resolve, context.auxData.frameId); }
            };
            const timer = setTimeout(() => finish(reject, new WaitLimitError(`the page did not get a child frame within ${limitMs / 1000} s`)), limitMs);
            stops.push(on('Page.frameAttached', ({ frameId, parentFrameId }) => {
                if (parentFrameId === frameTree.frame.id) { children.add(frameId); look(); }
            }));
            stops.push(on('Runtime.executionContextCreated', look));
            look();
        });
    };
    return {
        send, on, screenshot, useFrame, close: () => session.detach(),
        evaluate: (expression) => evaluate(session, expression, contextId),
        waitFor: (expression, limitMs = 30000, stepMs = 50) => waitFor(session, expression, { limitMs, stepMs, contextId }),
    };
}
