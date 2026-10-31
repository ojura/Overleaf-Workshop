// How a script of the harness or the IDE drivers ends. It registers with onCleanup what must be
// undone or stopped when it ends: a setting that it changed in a test instance, a browser or a
// server that it started. The clean-ups run, newest first, when the process exits, also through
// process.exit; each is synchronous, as the 'exit' event cannot wait.
//
// SIGINT, SIGTERM and SIGHUP (Ctrl+C, the end of a time limit, a closed terminal) close every
// DevTools connection of the script (scripts/lib/devtools.mjs) and end every pause of sleep(). The
// command or pause that the script awaits then fails, naming the signal, and the script's catch
// and finally blocks run as on any failure; when it has ended, it exits with 128 + the signal's
// number. A process that holds an open connection or a pause ends that way; any other process, such
// as the harness's server or a script while its browser starts, exits at once through process.exit
// and the clean-ups, and so does every process on a second signal.
import { closeAllConnections, openConnectionCount } from './devtools.mjs';

/** the exit status of a script that a signal ended: 128 + the signal's number */
export const EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** the clean-ups that have not run, oldest first */
const cleanups = [];
/** the pauses of sleep() that have not ended */
const pauses = new Set();
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

for (const [signal, code] of Object.entries(EXIT_CODES)) {
    process.on(signal, () => {
        if (signalled || (openConnectionCount() === 0 && pauses.size === 0)) { process.exit(code); }
        signalled = signal;
        process.stderr.write(`\n${signal}: the script ends after its clean-ups; a second ${signal} ends it at once\n`);
        const reason = `the script got ${signal}`;
        for (const pause of pauses) {
            clearTimeout(pause.timer);
            pause.reject(new Error(reason));
        }
        pauses.clear();
        closeAllConnections(reason);
    });
}

process.on('exit', () => {
    for (const { fn } of cleanups.splice(0).reverse()) {
        try {
            fn();
        } catch (error) {
            process.stderr.write(`a clean-up failed: ${error?.message ?? error}\n`);
        }
    }
    if (signalled) { process.exitCode = EXIT_CODES[signalled]; }
});
