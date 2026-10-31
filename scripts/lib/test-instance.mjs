// The test instance of the IDE that scripts/hidden-ide.sh starts, as the scripts reach it: its
// record, instance.json in the instance's folder, and DevTools connections to its window and to
// its main process. start records two endpoints: ws://127.0.0.1:<port>/devtools/browser/<id> for
// the window's browser, and ws://127.0.0.1:<port>/<id> for the main process's inspector. The IDE
// picked both ports itself, and only this IDE accepts the id in each path, so a connection to a
// recorded endpoint reaches this instance's IDE or fails. Each connection also checks that the
// process that answers is the IDE that start recorded (instance.json's pid).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, waitForActivePort, waitForTarget } from './devtools.mjs';

/** The instance's folder: `explicit`, else HIDDEN_IDE_HOME, else hidden-ide-<uid> in /tmp. */
export function instanceHome(explicit) {
    return path.resolve(explicit ?? process.env.HIDDEN_IDE_HOME ?? `/tmp/hidden-ide-${os.userInfo().uid}`);
}

/** The record of the instance in `home`, with `home` added; fails when start has not written one. */
export function readInstance(home) {
    const file = path.join(home, 'instance.json');
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`${file} does not exist: start an instance with scripts/hidden-ide.sh start, or name its folder with HIDDEN_IDE_HOME`);
        }
        throw error;
    }
    return { ...JSON.parse(text), home };
}

/** Replace the record of the instance in `home` with `record`, through a new file that is renamed over it. */
export function writeInstance(home, record) {
    const file = path.join(home, 'instance.json');
    const { home: _, ...fields } = record;
    fs.writeFileSync(`${file}.new`, `${JSON.stringify(fields, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.new`, file);
}

/** Whether a target is the page of the IDE's workbench window. */
export const isWorkbench = (target) => target.type === 'page' && target.url.includes('/workbench/workbench.html');

/** Fail unless the browser on the connection `browser` is the process `pid`. */
async function checkBrowserProcess(browser, pid) {
    const { processInfo } = await browser.send('SystemInfo.getProcessInfo');
    const answering = processInfo.find(p => p.type === 'browser')?.id;
    if (answering !== pid) {
        throw new Error(`the browser at ${browser.url} is process ${answering}, not the instance's IDE (process ${pid})`);
    }
}

/** The value of `expression` in a DevTools context: the session's page, or a Node inspector's main context. */
export async function evaluate(target, expression, contextId) {
    const r = await target.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
}

/** Fail unless the Node inspector on the connection `main` runs in the process `pid`. */
async function checkMainProcess(main, pid) {
    const answering = await evaluate(main, 'process.pid');
    if (answering !== pid) {
        throw new Error(`the inspector at ${main.url} runs in process ${answering}, not in the instance's IDE (process ${pid})`);
    }
}

/** Connect to a recorded endpoint of the instance, with the cause when the IDE does not answer there. */
async function connectRecorded(instance, url, name) {
    if (!url) {
        throw new Error(`${path.join(instance.home, 'instance.json')} records no ${name} endpoint: the instance did not finish starting`);
    }
    try {
        return await connect(url);
    } catch (error) {
        throw new Error(`the instance's IDE does not answer at its ${name} endpoint ${url}: the IDE has stopped, or another process holds that port now`);
    }
}

/** A DevTools connection to the browser of the instance's window, checked to be the instance's IDE. */
export async function connectWindow(instance) {
    const browser = await connectRecorded(instance, instance.devtools, 'DevTools');
    try {
        await checkBrowserProcess(browser, instance.pid);
    } catch (error) {
        browser.close();
        throw error;
    }
    return browser;
}

/** A DevTools connection to the inspector of the instance's main process, checked to be the instance's IDE. */
export async function connectMainProcess(instance) {
    const main = await connectRecorded(instance, instance.inspector, 'inspector');
    try {
        await checkMainProcess(main, instance.pid);
    } catch (error) {
        main.close();
        throw error;
    }
    return main;
}

/**
 * The value that `statements` return, run in the main process as the body of an async function in
 * which `electron` is Electron's module and `w` the IDE's window.
 */
export function inMainProcess(main, statements) {
    return evaluate(main, `(async () => {
        // the main process is an ES module, and the inspector's context has neither require nor import()
        const electron = typeof require === 'function' ? require('electron')
            : process.mainModule ? process.mainModule.require('electron')
            : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
        const w = electron.BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        if (!w) { throw new Error('the IDE has no window'); }
        ${statements}
    })()`);
}

/** The workbench window's page target of the browser on `browser`. */
export async function workbenchTarget(browser) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const pages = targetInfos.filter(isWorkbench);
    if (pages.length !== 1) {
        throw new Error(`the IDE shows ${pages.length} workbench windows, not one: ${pages.map(t => t.url).join(', ') || 'none'}`);
    }
    return pages[0];
}

/**
 * The TCP ports on which process `pid` listens at 127.0.0.1: its socket inodes from
 * /proc/<pid>/fd, matched with the listening sockets of /proc/<pid>/net/tcp.
 */
function listeningPorts(pid) {
    const inodes = new Set();
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        let link;
        try {
            link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch (error) {
            if (error.code === 'ENOENT') { continue; } // closed since the listing
            throw error;
        }
        const socket = /^socket:\[(\d+)\]$/.exec(link);
        if (socket) { inodes.add(socket[1]); }
    }
    const ports = [];
    // columns: sl, local_address, rem_address, st, tx_queue:rx_queue, tr:tm->when, retrnsmt, uid, timeout, inode
    for (const line of fs.readFileSync(`/proc/${pid}/net/tcp`, 'utf8').split('\n').slice(1)) {
        const [, local, , state, , , , , , inode] = line.trim().split(/\s+/);
        // state 0A is LISTEN; 0100007F is 127.0.0.1 as the kernel prints it
        if (state === '0A' && local?.startsWith('0100007F:') && inodes.has(inode)) {
            ports.push(parseInt(local.split(':')[1], 16));
        }
    }
    return ports;
}

/**
 * The last resort for one of the IDE's local servers that accepts a request and never answers it,
 * while start looks for the inspector among them.
 */
const SERVER_ANSWER_LIMIT_MS = 5000;

/**
 * The inspector's endpoint of process `pid`: of the ports it listens on at 127.0.0.1, other than
 * its DevTools port, the one whose /json/list names a target of type node.
 */
async function findInspector(pid, devtoolsPort) {
    const found = [];
    for (const port of listeningPorts(pid).filter(p => p !== devtoolsPort)) {
        let list;
        try {
            const answer = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(SERVER_ANSWER_LIMIT_MS) });
            list = answer.ok ? await answer.json() : [];
        } catch {
            continue; // a server of the IDE's own that does not speak this protocol
        }
        found.push(...(Array.isArray(list) ? list : []).filter(t => t.type === 'node' && t.webSocketDebuggerUrl).map(t => t.webSocketDebuggerUrl));
    }
    if (found.length !== 1) {
        throw new Error(`the IDE (process ${pid}) has ${found.length} Node inspectors on 127.0.0.1, not one: ${found.join(', ') || 'none'}`);
    }
    return found[0];
}

/**
 * Wait until the IDE `pid` of the instance in `home`, started with --remote-debugging-port=0 and
 * --inspect=0, has opened its workbench window, and return its two endpoints, each checked to
 * belong to process `pid`: { devtools, inspector }. The waits follow file and target events;
 * `limitMs` is the last resort for an IDE that runs but never opens its window. The IDE's exit is
 * the caller's to watch: hidden-ide.sh waits for whichever comes first.
 */
export async function waitForInstance(home, pid, limitMs) {
    const deadline = Date.now() + limitMs;
    const devtools = await waitForActivePort(path.join(home, 'profile'), { limitMs });
    const browser = await connect(devtools);
    try {
        await checkBrowserProcess(browser, pid);
        await waitForTarget(browser, isWorkbench, { what: "the IDE's workbench window", limitMs: Math.max(0, deadline - Date.now()) });
    } finally {
        browser.close();
    }
    const inspector = await findInspector(pid, Number(new URL(devtools).port));
    const main = await connect(inspector);
    try {
        await checkMainProcess(main, pid);
    } finally {
        main.close();
    }
    return { devtools, inspector };
}
