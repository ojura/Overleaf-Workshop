// A second Antigravity for tests: on a virtual display, with its own profile and extensions
// folder, outside the caller's desktop session, on a local replica of an Overleaf project that the
// user listed as a test project and that the user's own IDE does not keep a replica of, or on a
// local folder. scripts/hidden-ide.sh runs this file.
//
//   scripts/hidden-ide.sh start [options]     start the virtual display and the IDE
//   scripts/hidden-ide.sh stop                stop the IDE and the display, delete the login copy
//   scripts/hidden-ide.sh status              the instance's record (instance.json), and whether it runs
//   scripts/hidden-ide.sh field NAME          one field of the record; an empty line when the record lacks it
//   scripts/hidden-ide.sh window ACTION       hide, show, focus, state, "size WIDTH HEIGHT",
//                                             minimize or restore, through the main process;
//                                             the virtual display does not run a window manager, so
//                                             minimize does not take effect there, and hide is
//                                             what puts the window in the background
//   scripts/hidden-ide.sh probe               the window's page: visible? focused? drawing? A
//                                             page that does not run a task within 2 s, as a page
//                                             that freeze froze, makes the probe say
//                                             {"frozen": true}. When the page and the record's field
//                                             frozen disagree, as after a reload of a frozen page,
//                                             the probe adds the record's value as "recorded"
//   scripts/hidden-ide.sh freeze | thaw       freeze the page, or make it active again, check that
//                                             it stopped or started running tasks, and record that
//                                             in the record's field frozen; thaw also hides and
//                                             shows a shown window, so that the page is visible and
//                                             draws again
//   scripts/hidden-ide.sh screenshot FILE.png [WIDTH HEIGHT]
//                                             the window's page as an image, laid out at
//                                             WIDTH x HEIGHT if given (on the virtual display,
//                                             "window size" changes Electron's bounds but not the
//                                             page's size)
//
// Every command needs HIDDEN_IDE_HOME: the folder of an instance of one's own, for example below
// one's own scratch folder. The scripts require it and do not fall back to a shared folder, so that
// two agents never share an instance, and a stop in one agent's folder cannot end another agent's
// tests. start makes the folder for this user only (mode 700), and every command refuses a folder
// that other users can enter or change, also through a folder above it (checkInstanceFolder in
// scripts/lib/test-instance.mjs). It holds profile/, extensions/, replica/ and home/ (below),
// instance.json and the logs. start makes the IDE's profile new each time, so that each start
// begins from the same state: what an earlier run left there, such as the editor that a file was
// last opened with, does not carry over. The replica folder and home/ are kept between starts, so
// only the first start downloads the whole project, and Antigravity installs its agent once.
//
// Options for start (give --project or --folder; without either, start opens the project of the
// previous start):
//   --project ID        the Overleaf project of the replica; the instance opens its replica
//                       folder. It must be listed in the user's test projects (below)
//   --folder DIR        open DIR; start does not copy the login and does not make a replica, e.g.
//                       for tests that only open local files. A local replica, a folder that holds
//                       .overleaf/settings.json or lies inside one, is refused: only --project opens
//                       a replica, of a project that the user listed
//   --project-name N    the project's name, if the extension's saved login does not list it
//   --build DIR         build that checkout of this extension as npm run compile does, into a
//                       temporary folder, and make the instance's copy of the extension hold
//                       exactly the checkout's package (scripts/lib/install-build.mjs); without
//                       it, the instance runs a copy of the installed extension. The checkout
//                       needs what npm's postinstall downloads, and npm ci in views/chat-view. A
//                       step of the build that fails fails start
//   --ide PATH          the Antigravity binary, else the environment variable HIDDEN_IDE_BINARY
//   --display :N        the virtual display; by default the first free one from :99 up. :0 and :1
//                       are refused, and so is a display that another X server holds
//   --screen WxH        the virtual screen, default 1600x1000
// When start fails, or gets a signal, it stops what it started and deletes the login copy
// (scripts/lib/cleanup.mjs), as stop does: when one of the instance's processes outlives SIGTERM,
// what comes after it stays, the display, the saved state and the runtime folder, for a stop that
// ends that process. A start in the folder of an instance that ended without stop first ends what
// that instance left: its X server, its saved state and its runtime folder.
//
// The test projects: the user lists in ${XDG_CONFIG_HOME:-~/.config}/overleaf-workshop/test-projects,
// once, the Overleaf projects made for tests, one project id per line ("#" starts a comment).
// start refuses every other project, so that a mistyped or misremembered id cannot make an instance
// sync, write to or delete files of a project that other people edit.
//
// The instance's environment: of the caller's environment, the IDE gets PATH and LANG; the session
// bus's address, the keyring's and the SSH agent's sockets and the caller's tokens stay with the
// caller. HOME is home/ and the XDG folders are in it, so Antigravity's own data (~/.gemini,
// ~/.antigravity-ide) is the instance's. XDG_RUNTIME_DIR, where the session bus's, the IDE's and
// the replica's control sockets are, is a new folder of the instance's own in /tmp (the record's
// run), short so that a socket's path stays within the system's limit however long the instance's
// folder is; start records its path, then makes it with mode 700, and stop and a failed start remove
// it, only when it has the form that start gives it. The IDE runs
// under dbus-run-session, on a session bus of its own that does not start
// services on demand (its configuration leaves out the service folders), so a file dialog, a
// notification or a keyring prompt that the IDE asks for on its session bus does not reach the
// user's desktop. Chromium keeps the secrets it encrypts in the profile (--password-store=basic)
// instead of the user's keyring. The isolation is by environment: the instance runs as the user,
// so a program in it that names the user's bus (/run/user/<uid>/bus) or opens the user's files
// reaches them.
//
// The IDE picks the ports of its two DevTools endpoints itself, one for the window and one for its
// main process's inspector, and start records the endpoints; each holds an id that only this IDE
// accepts. Every command connects to those endpoints only, and checks that the process that answers
// is the instance's IDE (scripts/lib/test-instance.mjs).
//
// instance.json: boot (the boot's id), group and groupStart (the process group of the session bus
// and the IDE, and its leader's start time), pid and pidStart (the IDE's main process), xvfb and
// xvfbStart (the display's X server), display (":N"), run (the runtime folder), devtools and
// inspector (the endpoints), frozen, project and replica (null in folder mode), folder (what the
// instance opened), profile and ide. A recorded pid counts only together with its start time in the recorded boot, so that a
// command never acts on another process that got the same pid.
//
// stop sends SIGTERM to the instance's process group and waits for each process's exit through a
// pidfd (scripts/lib/stop-processes.py). When the IDE still runs after STOP_LIMIT_S, stop exits
// with status 1 and keeps the display and the saved state.
//
// The login: the IDE's own saved Overleaf login is copied into the instance's profile, with only
// the chosen project in it, readable only by this user, and deleted again by "stop". Nothing in
// this program prints it.
//
// Exit status: 0 done; 1 failed; 2 the page or the main process did not answer within
// ANSWER_LIMIT_MS; 64 wrong usage.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onCleanup, run } from './lib/cleanup.mjs';
import { answerWithin, evaluate, removeActivePort, WaitLimitError } from './lib/devtools.mjs';
import { buildCheckout, EXTENSION_ID, IDES, installedExtension, installInto } from './lib/install-build.mjs';
import { parseOptions, usageOf, UsageError } from './lib/options.mjs';
import {
    bootId, checkFoldersAbove, checkInstanceFolder, connectMainProcess, connectWindow, inMainProcess, instanceHome, instanceProcesses, isRecordedProcess,
    drawsExpression, processStat, readInstance, readRunningInstance, waitForInstance, workbenchTarget, writeInstance,
} from './lib/test-instance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The last resort for an IDE that runs but never opens its window. */
const START_LIMIT_MS = 60000;
/** The last resort for an X server that does not report its display and does not exit. */
const DISPLAY_LIMIT_MS = 30000;
/**
 * The last resort for a page, or the IDE's main process, that does not answer: for example a page
 * that DevTools froze outside freeze, which does not run scripts. Exit status 2 reports it.
 */
const ANSWER_LIMIT_MS = 15000;
/**
 * How long freeze, thaw and probe wait for the workbench page to run a task before they take it as
 * frozen (pageRunsTasks). A page that DevTools froze does not run the tasks of its queues, and one
 * that runs them, shown or hidden, runs one within milliseconds; a page that has not run the task
 * within this time is what "frozen" means here.
 */
const FROZEN_LIMIT_MS = 2000;
/** The last resort for an IDE, or an X server, that does not end after SIGTERM. */
const STOP_LIMIT_S = 30;
/** The first display that start tries when it is not given one. */
const FIRST_DISPLAY = 99;
/** How many displays from FIRST_DISPLAY up start tries. */
const DISPLAYS_TRIED = 100;

const antigravity = IDES.find(ide => ide.name === 'Antigravity IDE');
const userState = process.env.HIDDEN_IDE_USER_STATE ?? path.join(antigravity.data[0], 'User', 'globalStorage', 'state.vscdb');
const userExtensions = process.env.HIDDEN_IDE_USER_EXTENSIONS ?? antigravity.extensions;
const testProjects = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'overleaf-workshop', 'test-projects');

/** A failure with an exit status of its own. */
const failure = (message, status) => Object.assign(new Error(message), { status });

/** The usage: the comment at the top of this file. */
const usage = () => usageOf(fileURLToPath(import.meta.url));

/** Write `text` to `file` through a new file that is renamed over it, readable only by this user. */
function writePrivately(file, text) {
    fs.writeFileSync(`${file}.new`, text, { mode: 0o600 });
    fs.renameSync(`${file}.new`, file);
}

/**
 * The instance's folder (HIDDEN_IDE_HOME), checked before any command reads it
 * (checkInstanceFolder); with `make`, start makes it first, with mode 700, and checks it after.
 */
function instanceFolder({ make = false } = {}) {
    const home = instanceHome();
    if (make && !fs.lstatSync(home, { throwIfNoEntry: false })) {
        // the folders above are checked before anything is made in them
        checkFoldersAbove(home);
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    }
    checkInstanceFolder(home);
    return home;
}

/**
 * The project ids of the user's test projects. The list must be a regular file of the user's that
 * only the user can write, with Unix line ends, and each line that is not blank and not a comment
 * ("#" to the line's end) must be exactly one project id (24 hexadecimal digits). Any other list is
 * refused as a whole, with the reason, so that a line that names a project in another way cannot
 * count as a listed project.
 */
function listedTestProjects() {
    const refuse = (reason) => { throw new Error(`refusing to use ${testProjects}: ${reason}`); };
    let stat;
    try {
        stat = fs.lstatSync(testProjects);
    } catch (error) {
        if (error.code !== 'ENOENT') { throw error; }
        refuse('it does not exist; the user lists there, once, the Overleaf projects made for tests, one project id per line ("#" starts a comment)');
    }
    if (stat.isSymbolicLink()) { refuse('it is a symbolic link; the list must be the file itself'); }
    if (stat.isDirectory()) { refuse('it is a folder; the list is a file'); }
    if (!stat.isFile()) { refuse('it is not a regular file'); }
    if (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) { refuse('it must belong to this user, and only the user may write it'); }
    let text;
    try {
        text = fs.readFileSync(testProjects, 'utf8');
    } catch (error) {
        refuse(`it cannot be read (${error.code})`);
    }
    if (text.includes('\r')) { refuse('it has CRLF line ends; write it with Unix line ends'); }
    const ids = [];
    text.split('\n').forEach((line, i) => {
        const content = line.replace(/#.*/, '').trim();
        if (content === '') { return; }
        if (!/^[0-9a-f]{24}$/.test(content)) {
            refuse(`line ${i + 1} is not one project id (24 hexadecimal digits): ${JSON.stringify(line)}`);
        }
        ids.push(content);
    });
    return ids;
}

/** Fail unless `project` is one of the user's test projects (listedTestProjects), compared as strings. */
function checkTestProject(project) {
    if (!listedTestProjects().includes(project)) {
        throw new Error(`refusing project ${project}: it is not listed in ${testProjects}, the user's list of Overleaf projects made for tests`);
    }
}

/**
 * The local replica that `folder` is or lies in: the first folder from `folder` up that holds
 * .overleaf/settings.json; undefined when there is none.
 */
function replicaAround(folder) {
    for (let dir = folder; ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.overleaf', 'settings.json'))) { return dir; }
        if (dir === path.dirname(dir)) { return undefined; }
    }
}

/**
 * The record of the instance in `home`, or undefined before the first start. A record that an
 * earlier version of this program wrote lacks the processes' start times, so whether its
 * processes still run cannot be told: it is refused with what it names.
 */
function recordIfAny(home) {
    if (!fs.existsSync(path.join(home, 'instance.json'))) { return undefined; }
    const record = readInstance(home);
    if (record.boot === undefined) {
        throw new Error(`${home}/instance.json was written by an earlier hidden-ide.sh, without the start times that tell its processes from others (it names process group ${record.group ?? 'none'}, IDE ${record.pid ?? 'none'}, Xvfb ${record.xvfb ?? 'none'}). Stop that instance with the version that started it, or end those processes, then delete the file`);
    }
    return record;
}

/** The record of the instance in HIDDEN_IDE_HOME, which must run. */
function runningInstance() {
    const home = instanceFolder();
    if (!recordIfAny(home)) { throw new Error(`${home} does not hold an instance (instance.json)`); }
    return readRunningInstance(home);
}

/** Stop processes and wait for their exits (scripts/lib/stop-processes.py); whether all have ended. */
function stopProcesses(args) {
    const result = spawnSync('python3', ['-I', path.join(here, 'lib', 'stop-processes.py'), ...args, '--limit', String(STOP_LIMIT_S)],
        { stdio: ['ignore', process.stderr, process.stderr] });
    if (result.error) { throw new Error(`python3 could not run: ${result.error.message}`); }
    if (result.status !== 0 && result.status !== 1) { throw new Error(`stop-processes.py ended with ${result.signal ?? `status ${result.status}`}`); }
    return result.status === 0;
}

/**
 * The path of a runtime folder, as start makes one: /tmp/hidden-ide-run- and six letters or digits.
 * It is in /tmp, not in the instance's folder or in TMPDIR, so that the paths of the sockets in it
 * stay short.
 */
const RUNTIME_FOLDER = /^\/tmp\/hidden-ide-run-[A-Za-z0-9]{6}$/;

/**
 * A new path for a runtime folder (RUNTIME_FOLDER). start records it before it makes the folder,
 * so that a start that a SIGKILL ends leaves the folder in a record, for the next start or stop.
 */
function runtimeFolderName() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return `/tmp/hidden-ide-run-${Array.from({ length: 6 }, () => characters[crypto.randomInt(characters.length)]).join('')}`;
}

/** Make the runtime folder `run` with mode 700; fails when something exists at that path. */
const makeRuntimeFolder = (run) => fs.mkdirSync(run, { mode: 0o700 });

/**
 * Remove the runtime folder `run` that a record names, when it exists. The record could name any
 * path, so only a folder of the form that start makes (RUNTIME_FOLDER) goes, when this user owns it
 * and it is not a symbolic link; for any other path it throws, with the reason.
 */
function removeRuntimeFolder(run) {
    if (!run) { return; }
    if (typeof run !== 'string' || !RUNTIME_FOLDER.test(run)) {
        throw new Error(`refusing to delete ${run}, which the record names as the runtime folder: start makes runtime folders as /tmp/hidden-ide-run-XXXXXX`);
    }
    const stat = fs.lstatSync(run, { throwIfNoEntry: false });
    if (!stat) { return; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) { throw new Error(`refusing to delete ${run}: it is ${stat.isSymbolicLink() ? 'a symbolic link' : 'not a folder'}`); }
    if (stat.uid !== process.getuid()) { throw new Error(`refusing to delete ${run}: user ${stat.uid} owns it`); }
    fs.rmSync(run, { recursive: true, force: true });
}

/** Delete the instance's saved state, which holds the login copy in --project mode. */
function deleteSavedState(home) {
    for (const suffix of ['', '-journal', '.backup']) {
        fs.rmSync(path.join(home, 'profile', 'User', 'globalStorage', `state.vscdb${suffix}`), { force: true });
    }
}

/** The X server that holds display `n`, as "process N (name)", from its socket or its lock file. */
function displayHolder(n) {
    const listing = spawnSync('ss', ['-lxpH'], { encoding: 'utf8' });
    const line = listing.stdout?.split('\n').find(l => l.includes(`/tmp/.X11-unix/X${n} `));
    let pid = /pid=(\d+)/.exec(line ?? '')?.[1];
    if (!pid && fs.existsSync(`/tmp/.X${n}-lock`)) { pid = fs.readFileSync(`/tmp/.X${n}-lock`, 'utf8').trim(); }
    if (pid && processStat(Number(pid))) {
        return `process ${pid} (${fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()})`;
    }
    if (listensOn(`@/tmp/.X11-unix/X${n}`)) { return `a process listens on the abstract socket @/tmp/.X11-unix/X${n}`; }
    return `the socket /tmp/.X11-unix/X${n} or the lock file /tmp/.X${n}-lock is left from an X server that has ended`;
}

/**
 * Whether a socket listens on the Unix socket address `address` ("@..." for an abstract one), from
 * the kernel's table /proc/net/unix: its Flags field has __SO_ACCEPTCON (0x10000) for a listening
 * socket.
 */
function listensOn(address) {
    return fs.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1).some((line) => {
        const fields = line.trim().split(/\s+/);
        return fields[7] === address && (parseInt(fields[3], 16) & 0x10000) !== 0;
    });
}

/**
 * Whether display :n is taken. What holds a display is an X server's listening abstract socket
 * @/tmp/.X11-unix/X<n>, whose bind is exclusive, so a second X server on the display fails; that is
 * also how start learns that another start took a display in the meantime (startDisplay). The
 * socket file /tmp/.X11-unix/X<n> and the lock file /tmp/.X<n>-lock count too, as they can stay from
 * an X server that ended. An X server started with -displayfd, as start starts Xvfb, does not write
 * the lock file, so tools that look only at lock files, such as xvfb-run's find_free_servernum, take
 * a test instance's display as free, and their X server then fails on it.
 */
const displayInUse = (n) => listensOn(`@/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X${n}-lock`);

/**
 * Start Xvfb on display `requested` (":N"), or on the first free display from FIRST_DISPLAY up, and
 * wait until it accepts connections: it then writes the display's number to -displayfd. Returns
 * { display, xvfb }, with the X server's process. When another X server takes a free display
 * between the check and the start, this one exits, and start goes on to the next display.
 */
async function startDisplay(requested, screen, home) {
    let numbers;
    if (requested) {
        const n = /^:(\d+)$/.exec(requested)?.[1];
        if (n === undefined) { throw new UsageError(`not a display: ${requested}`); }
        if (Number(n) <= 1) { throw new Error(`refusing display ${requested}: :0 and :1 belong to desktop sessions`); }
        if (displayInUse(n)) { throw new Error(`refusing display ${requested}: it is in use (${displayHolder(n)})`); }
        numbers = [Number(n)];
    } else {
        numbers = Array.from({ length: DISPLAYS_TRIED }, (_, i) => FIRST_DISPLAY + i).filter(n => !displayInUse(n));
    }
    if (!/^\d+x\d+$/.test(screen)) { throw new UsageError(`not a screen size: ${screen}`); }
    for (const n of numbers) {
        const log = fs.openSync(path.join(home, 'xvfb.log'), 'w');
        const xvfb = spawn('Xvfb', [`:${n}`, '-displayfd', '3', '-screen', '0', `${screen}x24`, '-nolisten', 'tcp'],
            { stdio: ['ignore', log, log, 'pipe'], detached: true });
        fs.closeSync(log);
        const outcome = await new Promise((resolve) => {
            let text = '';
            const timer = setTimeout(() => resolve({ ready: false, how: `no display reported within ${DISPLAY_LIMIT_MS / 1000} s` }), DISPLAY_LIMIT_MS);
            xvfb.stdio[3].on('data', (chunk) => {
                text += chunk;
                if (text.includes('\n')) { clearTimeout(timer); resolve({ ready: true }); }
            });
            xvfb.once('exit', (code, signal) => { clearTimeout(timer); resolve({ ready: false, how: signal ?? `exit code ${code}` }); });
            xvfb.once('error', (error) => { clearTimeout(timer); resolve({ ready: false, how: error.message }); });
        });
        xvfb.stdio[3].destroy();
        if (outcome.ready) { return { display: `:${n}`, xvfb }; }
        if (xvfb.exitCode === null && xvfb.signalCode === null && xvfb.pid) { process.kill(-xvfb.pid, 'SIGKILL'); }
        if (!requested && displayInUse(n)) { continue; }
        throw new Error(`Xvfb did not start on :${n} (${outcome.how}; see ${home}/xvfb.log)`);
    }
    throw new Error(`every display from :${FIRST_DISPLAY} to :${FIRST_DISPLAY + DISPLAYS_TRIED - 1} is in use`);
}

/** `text` as the value of a D-Bus address: the bytes outside [-0-9A-Za-z_/.\*] as %XX. */
const dbusAddressValue = (text) => [...Buffer.from(text)]
    .map(byte => (/[-0-9A-Za-z_/.\\*]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, '0')}`)).join('');
/** `text` as XML character data. */
const xmlText = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Start the IDE under its own session bus, with the environment described at the top, in a process
 * group of its own that dbus-run-session leads. It picks the ports of its DevTools endpoints itself
 * (port 0): the window's browser names its endpoint in DevToolsActivePort in the profile, and the
 * file that an earlier start left there must not be taken for the new one.
 */
function startIde(home, runtime, ide, display, folder) {
    const busConfig = path.join(home, 'session-bus.conf');
    // only this user may connect, and the configuration leaves out the service folders, so the bus does not start services on demand
    writePrivately(busConfig, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=${xmlText(dbusAddressValue(runtime))}</listen>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`);
    removeActivePort(path.join(home, 'profile'));
    const userHome = path.join(home, 'home');
    const log = fs.openSync(path.join(home, 'ide.log'), 'w');
    const child = spawn('dbus-run-session', [`--config-file=${busConfig}`, '--', ide,
        '--ozone-platform=x11', '--disable-gpu', '--password-store=basic', '--remote-debugging-port=0', '--inspect=0',
        `--user-data-dir=${path.join(home, 'profile')}`, `--extensions-dir=${path.join(home, 'extensions')}`,
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', folder], {
        detached: true,
        stdio: ['ignore', log, log],
        env: {
            PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: userHome,
            XDG_CONFIG_HOME: path.join(userHome, '.config'), XDG_DATA_HOME: path.join(userHome, '.local', 'share'),
            XDG_STATE_HOME: path.join(userHome, '.local', 'state'), XDG_CACHE_HOME: path.join(userHome, '.cache'),
            XDG_RUNTIME_DIR: runtime, DISPLAY: display, XDG_SESSION_TYPE: 'x11',
        },
    });
    fs.closeSync(log);
    return child;
}

/**
 * The instance's extensions: a copy of the installed Overleaf Workshop, and of LaTeX Workshop for
 * .tex files when it is installed, from the folders that the user's extensions.json names. The
 * instance's extensions folder then holds exactly these: rsync copies from the user's extensions
 * folder with only their folders included, and deletes every other entry of the instance's folder,
 * a folder that an earlier start copied as well as the IDE's own list there, extensions.json, which
 * the IDE writes again from the folders. Returns Overleaf Workshop's folder in the instance.
 */
async function copyExtensions(home) {
    const source = installedExtension(userExtensions, EXTENSION_ID);
    if (!source) { throw new Error(`${userExtensions}/extensions.json does not list Overleaf Workshop (${EXTENSION_ID})`); }
    const chosen = [source, ...['james-yu.latex-workshop'].map(id => installedExtension(userExtensions, id)).filter(Boolean)];
    const included = chosen.flatMap(folder => ['--include', `/${path.basename(folder)}/***`]);
    await run('copying the installed extensions', 'rsync',
        ['-a', '--delete', '--delete-excluded', ...included, '--exclude', '*', `${userExtensions}/`, `${path.join(home, 'extensions')}/`]);
    fs.chmodSync(path.join(home, 'extensions'), 0o700); // rsync gave it the mode of the user's extensions folder
    return path.join(home, 'extensions', path.basename(source));
}

/** The instance's settings: no updates, no telemetry, no trust prompt. */
function writeSettings(home) {
    writePrivately(path.join(home, 'profile', 'User', 'settings.json'), `${JSON.stringify({
        'overleaf-workshop.localReplica.syncOnFileChange.enabled': true,
        'security.workspace.trust.enabled': false,
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
        'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none',
    }, null, 2)}\n`);
}

/**
 * The instance's saved state, made new at each start: Antigravity's onboarding marked done, so that
 * the window opens on the workbench; with a project also the login copy, with only that project and
 * its replica in this instance's folder.
 */
function writeSavedState(home, project, projectName) {
    deleteSavedState(home);
    const script = `
import json, os, sqlite3, sys, urllib.parse
src, dst, replica, project, name = sys.argv[1:6]
items = {"antigravityOnboarding": "true"}
if project:
    con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    row = con.execute("SELECT value FROM ItemTable WHERE key = ?", ("iamhyc.overleaf-workshop",)).fetchone()
    if row is None:
        sys.exit("hidden-ide: the IDE has not saved Overleaf Workshop's state")
    state = json.loads(row[0])
    servers = state.get("overleaf-servers", {})
    server_name, server = next(((k, v) for k, v in servers.items() if v.get("login")), (None, None))
    if server is None:
        sys.exit("hidden-ide: the IDE has not saved an Overleaf login")
    login = dict(server["login"])
    known = {p.get("id"): p for p in login.get("projects", [])}
    mine = os.path.realpath(replica)
    for p in login.get("projects", []):
        for record in (p.get("scm") or {}).values():
            base = record.get("baseUri", "")
            if p.get("id") == project and os.path.realpath(base) != mine:
                sys.exit(f"hidden-ide: refusing project {project}: the user's IDE keeps a local replica of it in {base}")
    name = name or known.get(project, {}).get("name")
    if not name:
        sys.exit(f"hidden-ide: the saved login does not list project {project}; pass --project-name")
    login["projects"] = [{"id": project, "name": name, "archived": False, "trashed": False, "accessLevel": "owner",
                          "source": "owner", "joined": True, "userId": login["userId"],
                          "scm": {"file://" + urllib.parse.quote(replica): {"enabled": True, "label": "Local Replica", "baseUri": replica, "settings": {}}}}]
    items["iamhyc.overleaf-workshop"] = json.dumps({"overleaf-servers": {server_name: {"name": server["name"], "url": server["url"], "login": login}}})
out = sqlite3.connect(dst)
out.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
out.executemany("INSERT INTO ItemTable VALUES (?, ?)", items.items())
out.commit()
if project:
    uri = "overleaf-workshop://{}/{}?{}".format(server_name, urllib.parse.quote(name),
                                                 urllib.parse.quote(f"user={login['userId']}&project={project}"))
    settings = os.path.join(replica, ".overleaf", "settings.json")
    existing = {}
    if os.path.exists(settings):
        existing = json.load(open(settings))
    existing.update({"uri": uri, "serverName": server_name, "projectName": name})
    existing.setdefault("enableCompileNPreview", False)
    with open(settings + ".new", "w") as f:
        json.dump(existing, f, indent=4)
    os.replace(settings + ".new", settings)
    print(f"replica of {name} ({project}) in {replica}")
`;
    if (project && !fs.existsSync(userState)) { throw new Error(`${userState} does not exist; start copies the IDE's saved login from there`); }
    const result = spawnSync('python3', ['-I', '-', userState, path.join(home, 'profile', 'User', 'globalStorage', 'state.vscdb'),
        path.join(home, 'replica'), project ?? '', projectName ?? ''], { input: script, stdio: ['pipe', 'inherit', 'inherit'] });
    if (result.error) { throw new Error(`python3 could not run: ${result.error.message}`); }
    if (result.status !== 0) { throw new Error('the instance\'s saved state was not written (see the message above)'); }
}

/** start: see the usage at the top. */
async function start(...argv) {
    const options = parseOptions({ project: 'value', folder: 'value', 'project-name': 'value', build: 'value', ide: 'value', display: 'value', screen: 'value' }, argv);
    const home = instanceFolder({ make: true });
    const previous = recordIfAny(home);
    if (previous && instanceProcesses(previous).length > 0) {
        throw new Error(`an instance is already running in ${home} (process group ${previous.group}); stop it first`);
    }
    if (previous) {
        // what an instance that ended without stop leaves: its X server, which runs in a process
        // group of its own, its saved state and its runtime folder
        const xvfbLeft = isRecordedProcess(previous.xvfb, previous.xvfbStart, previous.boot);
        endInstance(home, previous);
        if (xvfbLeft) { console.log(`stopped the X server of the previous instance in ${home} (process ${previous.xvfb} on ${previous.display}), whose IDE had ended`); }
    }
    let { project, folder } = options;
    if (folder) {
        if (project) { throw new UsageError('give --project or --folder, not both'); }
        if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) { throw new Error(`${folder} is not a folder`); }
        folder = fs.realpathSync(folder);
        const replica = replicaAround(folder);
        if (replica) {
            throw new Error(`refusing to open ${folder}: ${replica === folder ? 'it is' : `it lies in ${replica}, which is`} a local replica (it holds .overleaf/settings.json); only --project opens a replica, of a project that the user listed`);
        }
    } else {
        project ??= previous?.project ?? undefined;
        if (!project) { throw new UsageError('--project ID or --folder DIR is required'); }
        if (!/^[0-9a-f]{24}$/.test(project)) { throw new UsageError(`not a project id: ${project}`); }
        checkTestProject(project);
        folder = path.join(home, 'replica');
    }
    const ide = options.ide ?? process.env.HIDDEN_IDE_BINARY;
    if (!ide) { throw new UsageError('name the Antigravity binary with --ide PATH or HIDDEN_IDE_BINARY'); }
    fs.accessSync(ide, fs.constants.X_OK);
    let build;
    if (options.build) {
        if (!fs.statSync(options.build, { throwIfNoEntry: false })?.isDirectory()) { throw new Error(`${options.build} is not a folder`); }
        build = fs.realpathSync(options.build);
    }

    fs.rmSync(path.join(home, 'profile'), { recursive: true, force: true });
    for (const dir of [['profile', 'User', 'globalStorage'], ['extensions'], ['home'], ...(project ? [['replica', '.overleaf']] : [])]) {
        fs.mkdirSync(path.join(home, ...dir), { recursive: true, mode: 0o700 });
    }
    const ext = await copyExtensions(home);
    if (build) {
        const built = await buildCheckout(build);
        try {
            const files = await installInto(built, ext, { sameVersion: false });
            console.log(`installed the package of ${build} (${built.label}, ${files} files) into the instance`);
        } finally {
            built.remove();
        }
    }
    writeSettings(home);

    // From here on, start ends what it started when it fails, and when the script ends before start
    // has finished, as after a signal (scripts/lib/cleanup.mjs), through endInstance with the record
    // as it is at that moment, as stop would: the IDE's process group, then the X server, then the
    // saved state and the runtime folder; when a process outlives its SIGTERM, the rest stays for a
    // stop. The record names the runtime folder before the folder exists, and each process only once
    // it runs, so that it never names a process that start did not start.
    const run = runtimeFolderName();
    const boot = bootId();
    let record = { boot, run, frozen: false, project: project ?? null, replica: project ? folder : null, folder, profile: path.join(home, 'profile'), ide };
    /** the child processes that start holds, which must not keep this process from ending */
    const children = [];
    const abandonment = onCleanup(() => {
        try {
            endInstance(home, record);
        } catch (error) {
            process.stderr.write(`hidden-ide: ${error.message}\n`);
        }
        for (const child of children) { child.unref(); }
    });
    try {
        writeInstance(home, record);
        makeRuntimeFolder(run);
        writeSavedState(home, project, options['project-name']);
        if (!project) { console.log(`the instance opens ${folder}; start did not copy the login`); }
        const { display, xvfb } = await startDisplay(options.display, options.screen ?? '1600x1000', home);
        children.push(xvfb);
        record = { ...record, xvfb: xvfb.pid, xvfbStart: processStat(xvfb.pid)?.start, display };
        writeInstance(home, record);
        const session = startIde(home, run, ide, display, folder);
        children.push(session);
        // a program that cannot be started gets no pid, so the record names the group only once it runs
        await new Promise((resolve, reject) => {
            session.once('spawn', resolve);
            session.once('error', (error) => reject(new Error(`dbus-run-session, which starts the IDE, could not run: ${error.message}`)));
        });
        // recorded at once, so that stop finds the instance also when the wait below fails
        record = { ...record, group: session.pid, groupStart: processStat(session.pid)?.start };
        writeInstance(home, record);
        const ended = new Promise((resolve, reject) => {
            session.once('exit', (code, signal) => resolve(signal ?? `exit code ${code}`));
            session.once('error', reject);
        });
        const found = await Promise.race([
            waitForInstance(home, session.pid, START_LIMIT_MS, ended),
            ended.then((how) => { throw new Error(`the IDE exited (${how}; see ${home}/ide.log)`); }),
        ]);
        writeInstance(home, { ...record, ...found, pidStart: processStat(found.pid)?.start });
        // the instance runs on its own: this process does not wait for it
        abandonment.cancel();
        session.unref();
        xvfb.unref();
        console.log(`started: pid ${found.pid} on ${display}, folder ${folder}`);
    } catch (error) {
        abandonment.run();
        throw error;
    }
}

/**
 * End what the record `record` of the instance in `home` names: its process group and its X server,
 * each while it is still the process that start recorded, then its saved state and its runtime
 * folder. When a process still runs STOP_LIMIT_S s after SIGTERM, it throws, and the saved state and
 * the runtime folder stay, since the instance may still use them.
 */
function endInstance(home, record) {
    if (instanceProcesses(record).length > 0 && !stopProcesses(['--group', String(record.group)])) {
        throw new Error(`the instance's processes still run ${STOP_LIMIT_S} s after SIGTERM (listed above); its display and its saved state stay. Run stop again, or end those processes`);
    }
    if (isRecordedProcess(record.xvfb, record.xvfbStart, record.boot) && !stopProcesses(['--pid', String(record.xvfb)])) {
        throw new Error(`the display's X server (process ${record.xvfb}) still runs ${STOP_LIMIT_S} s after SIGTERM; the saved state stays`);
    }
    deleteSavedState(home);
    removeRuntimeFolder(record.run);
}

/** stop: see the usage at the top. */
function stop() {
    const home = instanceFolder();
    const record = recordIfAny(home);
    if (!record) { throw new Error(`${home} does not hold an instance (instance.json)`); }
    endInstance(home, record);
    writeInstance(home, { ...record, run: null, frozen: false });
    console.log('stopped; deleted the instance\'s saved state (state.vscdb, which holds the login copy in --project mode) and its runtime folder');
}

/** `work` on `connection` within ANSWER_LIMIT_MS, with exit status 2 at the limit; the connection is closed afterwards. */
async function withinLimit(connection, what, work) {
    try {
        return await answerWithin(connection, what, ANSWER_LIMIT_MS, work);
    } catch (error) {
        throw error instanceof WaitLimitError ? failure(error.message, 2) : error;
    } finally {
        connection.close();
    }
}

/** Run `work` with a session on the instance's workbench page, within ANSWER_LIMIT_MS; `what` names the work. */
async function withPage(instance, what, work) {
    const browser = await connectWindow(instance);
    return withinLimit(browser, what, async () => work(await browser.attach((await workbenchTarget(browser)).targetId)));
}

/** What `statements` return in the IDE's main process, with w set to its window, within ANSWER_LIMIT_MS. */
async function inMain(instance, statements) {
    const main = await connectMainProcess(instance);
    return withinLimit(main, 'the main process', () => inMainProcess(main, statements));
}

const WINDOW_STATE = 'return { visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(), bounds: w.getBounds() };';

/** Set the page's lifecycle state ('frozen' or 'active') and record it in the field frozen. */
async function setLifecycle(instance, state) {
    await withPage(instance, 'Page.setWebLifecycleState', (page) => page.send('Page.setWebLifecycleState', { state }));
    const runs = await pageRunsTasks(instance);
    if (runs !== (state === 'active')) {
        throw new Error(`after Page.setWebLifecycleState ${state}, the page ${runs ? 'still runs tasks' : `has not run a task within ${FROZEN_LIMIT_MS / 1000} s`}`);
    }
    writeInstance(instance.home, { ...readInstance(instance.home), frozen: state === 'frozen' });
}

/**
 * Whether the instance's workbench page runs a task within FROZEN_LIMIT_MS: a message that it posts
 * to itself through a MessageChannel arrives. A page that DevTools froze still runs DevTools' own
 * evaluations, so an evaluation that needs nothing else answers there too, but it does not run the
 * tasks of its queues, timers and messages among them. Measured on the instance: the message
 * arrived within 1 to 15 ms in a shown page, a hidden one and one made active again, and within 3 s
 * on the frozen page it did not, while an evaluation without it answered there after 1.6 s.
 * Messages are not throttled in hidden pages, as timers are.
 */
async function pageRunsTasks(instance) {
    const browser = await connectWindow(instance);
    try {
        const page = await browser.attach((await workbenchTarget(browser)).targetId);
        await answerWithin(browser, 'the workbench page', FROZEN_LIMIT_MS, () => evaluate(page,
            'new Promise((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(true); channel.port2.postMessage(0); })'));
        return true;
    } catch (error) {
        if (error instanceof WaitLimitError) { return false; }
        throw error;
    } finally {
        browser.close();
    }
}

const commands = {
    start,
    stop,
    status() {
        const home = instanceFolder();
        const record = recordIfAny(home);
        if (!record) { throw new Error(`${home} does not hold an instance (instance.json)`); }
        const { home: _, ...fields } = record;
        console.log(JSON.stringify(fields, null, 2));
        console.log(instanceProcesses(record).length > 0 ? 'running' : 'not running');
    },
    field(name) {
        if (!name) { throw new UsageError('field needs a NAME'); }
        const home = instanceFolder();
        const record = recordIfAny(home);
        if (!record) { throw new Error(`${home} does not hold an instance (instance.json)`); }
        console.log(record[name] ?? '');
    },
    async window(action = 'state', width, height) {
        const instance = runningInstance();
        let statements;
        if (['hide', 'show', 'minimize', 'restore', 'focus'].includes(action)) {
            statements = `w.${action}(); ${WINDOW_STATE}`;
        } else if (action === 'size') {
            if (!/^\d+$/.test(width ?? '') || !/^\d+$/.test(height ?? '')) { throw new UsageError('usage: window size WIDTH HEIGHT'); }
            statements = `w.setSize(${width}, ${height}); ${WINDOW_STATE}`;
        } else if (action === 'state') {
            statements = WINDOW_STATE;
        } else {
            throw new UsageError(`unknown window action ${action}`);
        }
        console.log(JSON.stringify(await inMain(instance, statements)));
    },
    async probe() {
        const instance = runningInstance();
        // the record's frozen field, when the page does not agree with it
        const recorded = (frozen) => (frozen === Boolean(instance.frozen) ? {} : { recorded: { frozen: Boolean(instance.frozen) } });
        if (!(await pageRunsTasks(instance))) {
            console.log(JSON.stringify({ frozen: true, ...recorded(true) }));
            return;
        }
        const state = await withPage(instance, 'probe', (page) => evaluate(page, `(async () => {
            const draws = await ${drawsExpression};
            return { frozen: false, visibility: document.visibilityState, focus: document.hasFocus(), draws };
        })()`));
        console.log(JSON.stringify({ ...state, ...recorded(false) }));
    },
    async freeze() {
        await setLifecycle(runningInstance(), 'frozen');
        console.log('frozen');
    },
    async thaw() {
        const instance = runningInstance();
        await setLifecycle(instance, 'active');
        // Chromium marks a page hidden when DevTools freezes it, and does not mark it shown again
        // when DevTools makes it active (PageHandler::SetWebLifecycleState in Chromium's
        // content/browser/devtools/protocol/page_handler.cc), so a thawed page would report
        // visibility "hidden" and not draw. Hiding and showing a shown window marks it shown.
        if (await inMain(instance, 'return w.isVisible();')) {
            await inMain(instance, 'w.hide(); w.show(); return w.isVisible();');
            console.log('thawed; hid and showed the window, so that the page draws again');
        } else {
            console.log('thawed; the window is hidden, and its page draws again once it is shown');
        }
    },
    async screenshot(file, width, height) {
        if (!file) { throw new UsageError('usage: screenshot FILE.png [WIDTH HEIGHT]'); }
        await withPage(runningInstance(), 'screenshot', async (page) => {
            // the page's size is set in the same session as the capture: the override ends with the session
            if (width && height) {
                // The page lays itself out at the new size, then reports its resize event; a page
                // that draws then draws twice. The listener is in place before the size changes.
                const resized = await evaluate(page, `innerWidth !== ${Number(width)} || innerHeight !== ${Number(height)}
                    ? (window.__hiddenIdeResized = new Promise(r => addEventListener('resize', () => document.visibilityState === 'visible'
                        ? requestAnimationFrame(() => requestAnimationFrame(() => r(true))) : r(true), { once: true })), true)
                    : false`);
                await page.send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
                if (resized) { await evaluate(page, 'window.__hiddenIdeResized'); }
            }
            const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
            if (width && height) { await page.send('Emulation.clearDeviceMetricsOverride'); }
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
        });
        console.log(`saved ${file}`);
    },
};

const [command, ...args] = process.argv.slice(2);
if (!Object.hasOwn(commands, command ?? '')) {
    console.log(usage());
    process.exit(command === undefined || command === 'help' ? 0 : 64);
}
try {
    await commands[command](...args);
} catch (error) {
    console.error(`hidden-ide: ${error.message}`);
    if (error instanceof UsageError) { console.error('see scripts/hidden-ide.sh help'); }
    process.exitCode = error instanceof UsageError ? 64 : error.status ?? 1;
}
