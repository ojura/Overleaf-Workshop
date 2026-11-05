// How a script ends: the harness's scripts, the IDE drivers, hidden-ide.mjs and the install. It
// registers with onCleanup what must be undone or stopped when it ends: a setting that it changed
// in a test instance, a browser or a server that it started, a test instance that start has not
// finished starting. The clean-ups run, newest first, when the process exits, also through
// process.exit; each is synchronous, as the 'exit' event cannot wait.
//
// SIGINT, SIGTERM and SIGHUP (Ctrl+C, the end of a time limit, a closed terminal) close every
// DevTools connection of the script (scripts/lib/devtools.mjs), end every pause of sleep(), and send
// SIGTERM to the process group of every program that run() runs. The command, pause or program
// that the script awaits then fails, naming the signal, and the script's catch and finally blocks
// run as on any failure; when it has ended, it exits with 128 + the signal's number. A process
// that holds an open connection, a pause or a program ends that way; any other process, such as
// the harness's server or a script while its browser starts, exits at once through process.exit
// and the clean-ups, and so does every process on a second signal, after SIGKILL to the process
// groups of the programs of run() that still run.
import { spawn } from 'node:child_process';
import { closeAllConnections, openConnectionCount } from './devtools.mjs';

/** the exit status of a script that a signal ended: 128 + the signal's number */
export const EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** the clean-ups that have not run, oldest first */
const cleanups = [];
/** the pauses of sleep() that have not ended */
const pauses = new Set();
/** the programs of run() that have not ended */
const programs = new Set();

/** Send `signal` to the process group of `child`, a program of run(), which leads its group. */
function signalGroup(child, signal) {
    try {
        process.kill(-child.pid, signal);
    } catch (error) {
        if (error.code !== 'ESRCH') { throw error; } // the group has ended
    }
}
/** the first signal that the script got */
let signalled;

/**
 * Run `fn` when the script ends. Returns { run, cancel }: run() runs it now instead, and cancel()
 * drops it; after either, it does not run at the end.
 */
export function onCleanup(fn) {
    const entry = { fn };
    cleanups.push(entry);
    const drop = () => {
        const i = cleanups.indexOf(entry);
        if (i >= 0) { cleanups.splice(i, 1); }
        return i >= 0;
    };
    return { run: () => { if (drop()) { fn(); } }, cancel: () => { drop(); } };
}

/** A pause of `ms`, which fails when the script gets a signal. */
export function sleep(ms) {
    return new Promise((resolve, reject) => {
        if (signalled) {
            reject(new Error(`the script got ${signalled}`));
            return;
        }
        const pause = { reject, timer: setTimeout(() => { pauses.delete(pause); resolve(); }, ms) };
        pauses.add(pause);
    });
}

/**
 * spawn() for a program that must not outlive this process, such as the harness's headless Chrome
 * and server: it runs under util-linux's setpriv with --pdeathsig KILL, so that the kernel sends
 * it SIGKILL when this process ends, also by a SIGKILL, which ends it before its clean-ups can run.
 * setpriv executes the program in its own process, so the child's pid is the program's.
 */
export function spawnTied(program, args, options) {
    return spawn('setpriv', ['--pdeathsig', 'KILL', '--', program, ...args], options);
}

/**
 * Run `program` with `args` in `cwd`, and wait until it has ended: resolves with its standard
 * output when it exits with status 0, and fails with `what`, the program and how it ended
 * otherwise. Its standard error goes to this process's; so does its standard output unless
 * `capture` is set. The program leads a process group of its own, so that a signal to the script
 * stops it and the programs that it starts (see above); run() then fails naming the signal.
 */
export function run(what, program, args, { cwd, capture = false } = {}) {
    return new Promise((resolve, reject) => {
        if (signalled) {
            reject(new Error(`${what}: the script got ${signalled}`));
            return;
        }
        const child = spawn(program, args, { cwd, detached: true, stdio: ['ignore', capture ? 'pipe' : process.stderr, process.stderr] });
        if (child.pid !== undefined) { programs.add(child); }
        const chunks = [];
        child.stdout?.on('data', (chunk) => chunks.push(chunk));
        child.once('error', (error) => {
            programs.delete(child);
            reject(new Error(`${what}: ${program} could not run: ${error.message}`));
        });
        child.once('close', (status, signal) => {
            programs.delete(child);
            if (status === 0) {
                resolve(Buffer.concat(chunks).toString('utf8'));
            } else {
                const how = signal ?? `status ${status}`;
                reject(new Error(signalled ? `${what}: the script got ${signalled}, and ${program} ended with ${how}` : `${what} failed: ${program} ended with ${how}`));
            }
        });
    });
}

for (const [signal, code] of Object.entries(EXIT_CODES)) {
    process.on(signal, () => {
        if (signalled || (openConnectionCount() === 0 && pauses.size === 0 && programs.size === 0)) { process.exit(code); }
        signalled = signal;
        process.stderr.write(`\n${signal}: the script ends after its clean-ups; a second ${signal} ends it at once\n`);
        const reason = `the script got ${signal}`;
        for (const pause of pauses) {
            clearTimeout(pause.timer);
            pause.reject(new Error(reason));
        }
        pauses.clear();
        for (const child of programs) { signalGroup(child, 'SIGTERM'); }
        closeAllConnections(reason);
    });
}

process.on('exit', () => {
    for (const child of programs) { signalGroup(child, 'SIGKILL'); }
    for (const { fn } of cleanups.splice(0).reverse()) {
        try {
            fn();
        } catch (error) {
            process.stderr.write(`a clean-up failed: ${error?.message ?? error}\n`);
        }
    }
    if (signalled) { process.exitCode = EXIT_CODES[signalled]; }
});
