// The test instance of the IDE that scripts/hidden-ide.sh starts, as the scripts reach it: its
// record, instance.json in the instance's folder, and DevTools connections to its window and to
// its main process. start records two endpoints: ws://127.0.0.1:<port>/devtools/browser/<id> for
// the window's browser, and ws://127.0.0.1:<port>/<id> for the main process's inspector. The IDE
// picked both ports itself, and only this IDE accepts the id in each path, so a connection to a
// recorded endpoint reaches this instance's IDE or fails. Each connection also checks that the
// process that answers is the IDE that start recorded (instance.json's pid).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, evaluate, waitForActivePort, waitForTarget } from './devtools.mjs';

/**
 * The instance's folder: `explicit`, else HIDDEN_IDE_HOME. The scripts require one of them and do
 * not fall back to a shared folder, so that two agents never share an instance.
 */
export function instanceHome(explicit) {
    const home = explicit ?? process.env.HIDDEN_IDE_HOME;
    if (!home) {
        throw new Error('name the folder of the test instance with --instance DIR or HIDDEN_IDE_HOME; the scripts do not fall back to a shared folder, so that two agents never share an instance');
    }
    return path.resolve(home);
}

/**
 * Whether the group `gid` holds no user but this one: no other user has it as the primary group,
 * and its list of members names only this user (getent, so that the system's user databases
 * answer).
 */
function groupHoldsOnlyThisUser(gid) {
    const group = spawnSync('getent', ['group', String(gid)], { encoding: 'utf8' });
    if (group.status !== 0) { return false; }
    const members = (group.stdout.trim().split(':')[3] ?? '').split(',').filter(Boolean);
    if (members.some(member => member !== os.userInfo().username)) { return false; }
    const users = spawnSync('getent', ['passwd'], { encoding: 'utf8' });
    if (users.status !== 0) { return false; }
    return users.stdout.split('\n').filter(Boolean).every((line) => {
        const [, , uid, primary] = line.split(':');
        return Number(primary) !== gid || Number(uid) === process.getuid();
    });
}

/**
 * Fail unless `home` can hold an instance: it holds the login copy and the record that stop acts
 * on. It must be the folder itself (not a symbolic link), belong to this user and have mode 700,
 * and each folder above it must belong to root or to this user, and other users must not be able to
 * write it, except a folder with the sticky bit (as /tmp has), in which they cannot rename or
 * remove what is not theirs. A folder that its group can write counts as closed to others when the
 * group holds no user but this one.
 */
export function checkInstanceFolder(home) {
    const refuse = (reason) => { throw new Error(`refusing the instance's folder ${home}: ${reason}`); };
    let stat;
    try {
        stat = fs.lstatSync(home);
    } catch (error) {
        if (error.code === 'ENOENT') { refuse('it does not exist'); }
        throw error;
    }
    if (stat.isSymbolicLink()) { refuse('it is a symbolic link; name the folder itself'); }
    if (!stat.isDirectory()) { refuse('it is not a folder'); }
    if (stat.uid !== process.getuid()) { refuse('another user owns it'); }
    if ((stat.mode & 0o777) !== 0o700) {
        refuse(`its mode is ${(stat.mode & 0o777).toString(8)}; it must be 700, so that only this user can enter, read and write it`);
    }
    for (let dir = path.dirname(fs.realpathSync(home)); ; dir = path.dirname(dir)) {
        const above = fs.statSync(dir);
        const sticky = (above.mode & 0o1000) !== 0;
        if (above.uid !== 0 && above.uid !== process.getuid()) { refuse(`the folder ${dir} above it belongs to another user`); }
        if ((above.mode & 0o002) && !sticky) { refuse(`every user can write the folder ${dir} above it`); }
        if ((above.mode & 0o020) && !sticky && !groupHoldsOnlyThisUser(above.gid)) {
            refuse(`the members of group ${above.gid} can write the folder ${dir} above it, and other users are among them`);
        }
        if (dir === path.dirname(dir)) { break; }
    }
}

/**
 * The record of the instance in `home`, which must run (instanceProcesses); the drivers and
 * hidden-ide.sh's commands call it before they change anything.
 */
export function readRunningInstance(home) {
    const record = readInstance(home);
    if (instanceProcesses(record).length === 0) { throw new Error(`the instance in ${home} does not run`); }
    return record;
}

/** The record of the instance in `home`, with `home` added; fails when start has not written one. */
export function readInstance(home) {
    const file = path.join(home, 'instance.json');
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`${file} does not exist: start an instance with scripts/hidden-ide.sh start, or name its folder with HIDDEN_IDE_HOME (the drivers also take --instance DIR)`);
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

/**
 * The path of the page of VS Code's workbench window. The instance's window is the one window that
 * shows this page: the window commands pick it among the IDE's BrowserWindows, and the page
 * commands and the drivers among its page targets, both by this path, and both refuse when there
 * is not exactly one.
 */
const WORKBENCH_PAGE = '/workbench/workbench.html';

/** Whether a target is the page of the IDE's workbench window. */
export const isWorkbench = (target) => target.type === 'page' && target.url.includes(WORKBENCH_PAGE);

/** The process id of the browser on the connection `browser`, as the browser reports it. */
async function browserProcess(browser) {
    const { processInfo } = await browser.send('SystemInfo.getProcessInfo');
    return processInfo.find(p => p.type === 'browser')?.id;
}

/** Fail unless the browser on the connection `browser` is the process `pid`. */
async function checkBrowserProcess(browser, pid) {
    const answering = await browserProcess(browser);
    if (answering !== pid) {
        throw new Error(`the browser at ${browser.url} is process ${answering}, not the instance's IDE (process ${pid})`);
    }
}

/**
 * The state, the process group and the start time (in clock ticks after the boot) of process
 * `pid`, from /proc/<pid>/stat, or undefined when no such process exists.
 */
export function processStat(pid) {
    let stat;
    try {
        stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') { return undefined; }
        throw error;
    }
    // after the command name, which can hold spaces: state, ppid, pgrp, ... and starttime, field 22
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], group: Number(fields[2]), start: Number(fields[19]) };
}

/** This boot's id: a recorded pid and start time name the same process only within one boot. */
export const bootId = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

/**
 * Whether process `pid` is the one recorded with the start time `start` in the boot `boot`, and
 * not another process that got the same pid later.
 */
export function isRecordedProcess(pid, start, boot) {
    return Boolean(pid) && boot === bootId() && processStat(pid)?.start === start;
}

/**
 * The processes of the instance `record` that have not exited: the members of its process group,
 * while the group is still the one that start made, in this boot. After the group's leader has
 * ended, the group stays the instance's as long as members of it run, since the system gives the
 * group's number to another group only after all of them have ended. This is the one test of whether an instance runs, for
 * start, for the commands and for stop.
 */
export function instanceProcesses(record) {
    if (!record.group || record.boot !== bootId()) { return []; }
    const leader = processStat(record.group);
    if (leader && leader.start !== record.groupStart) { return []; }
    return fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).map(Number).filter((pid) => {
        const stat = processStat(pid);
        return stat?.group === record.group && stat.state !== 'Z' && stat.state !== 'X';
    });
}

/** Fail unless the Node inspector on the connection `main` runs in the process `pid`. */
async function checkMainProcess(main, pid) {
    const answering = await evaluate(main, 'process.pid');
    if (answering !== pid) {
        throw new Error(`the inspector at ${main.url} runs in process ${answering}, not in the instance's IDE (process ${pid})`);
    }
}

/**
 * Connect to a recorded endpoint of the instance. When that fails, the error says whether the
 * recorded IDE process still runs, and what the connection reported.
 */
async function connectRecorded(instance, url, name) {
    if (!url) {
        throw new Error(`${path.join(instance.home, 'instance.json')} does not record the ${name} endpoint: the instance did not finish starting`);
    }
    try {
        return await connect(url);
    } catch (error) {
        const ide = isRecordedProcess(instance.pid, instance.pidStart, instance.boot)
            ? `the instance's IDE (process ${instance.pid}) runs, and does not answer at its recorded ${name} endpoint`
            : `the instance's IDE (process ${instance.pid}) has ended`;
        throw new Error(`${ide}: ${error.message}`);
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
 * which `electron` is Electron's module and `w` the window that shows the workbench (WORKBENCH_PAGE).
 */
export function inMainProcess(main, statements) {
    return evaluate(main, `(async () => {
        // the main process is an ES module, and the inspector's context lacks require and import()
        const electron = typeof require === 'function' ? require('electron')
            : process.mainModule ? process.mainModule.require('electron')
            : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
        const windows = electron.BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.webContents.getURL().includes(${JSON.stringify(WORKBENCH_PAGE)}));
        if (windows.length !== 1) { throw new Error(\`the IDE shows \${windows.length} workbench windows, not one\`); }
        const w = windows[0];
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
 * its DevTools port, the one that names a target of type node in its /json/list.
 */
export async function findInspector(pid, devtoolsPort) {
    const found = [];
    /** what each port answered, for the error when the inspector is not found exactly once */
    const outcomes = [];
    for (const port of listeningPorts(pid).filter(p => p !== devtoolsPort)) {
        let answer;
        try {
            answer = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(SERVER_ANSWER_LIMIT_MS) });
        } catch (error) {
            outcomes.push(`port ${port}: ${error.name === 'TimeoutError' ? `did not answer within ${SERVER_ANSWER_LIMIT_MS / 1000} s` : error.message}`);
            continue;
        }
        const text = await answer.text();
        let inspectors = [];
        try {
            const list = JSON.parse(text);
            inspectors = Array.isArray(list) ? list.filter(t => t.type === 'node' && t.webSocketDebuggerUrl).map(t => t.webSocketDebuggerUrl) : [];
        } catch {
            // the answer is not JSON: a server of the IDE's own that speaks another protocol
        }
        outcomes.push(`port ${port}: HTTP ${answer.status}, ${inspectors.length} Node inspector${inspectors.length === 1 ? '' : 's'}`);
        found.push(...inspectors);
    }
    if (found.length !== 1) {
        throw new Error(`the IDE (process ${pid}) shows ${found.length} Node inspectors on 127.0.0.1, not one (${outcomes.join('; ') || 'it listens on its DevTools port alone'})`);
    }
    return found[0];
}

/**
 * Wait until the IDE of the instance in `home`, started with --remote-debugging-port=0 and
 * --inspect=0 in the process group `group`, has opened its workbench window, and return its pid as
 * its browser reports it, checked to be in `group`, and its two endpoints, checked to belong to
 * that pid: { pid, devtools, inspector }. The waits follow file and target events; `ended`, a
 * promise that settles when the IDE's session ends, ends the wait for DevToolsActivePort, and the
 * closed connection the later waits; `limitMs` is the last resort for an IDE that runs but never
 * opens its window.
 */
export async function waitForInstance(home, group, limitMs, ended) {
    const deadline = Date.now() + limitMs;
    const devtools = await waitForActivePort(path.join(home, 'profile'), { ended, limitMs });
    const browser = await connect(devtools);
    let pid;
    try {
        pid = await browserProcess(browser);
        if (processStat(pid)?.group !== group) {
            throw new Error(`the browser that wrote ${home}/profile/DevToolsActivePort, process ${pid}, is not in the instance's process group ${group}`);
        }
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
    return { pid, devtools, inspector };
}
