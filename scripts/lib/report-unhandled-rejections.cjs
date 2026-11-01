// Loaded into every mocha run of this repository through .mocharc.json. It reports each unhandled
// rejection with the test that was running when it came and the test that had ended before it,
// since a rejection can come from work that an earlier test left behind, and at the end the number
// of them. Mocha 12 handles only its own errors among unhandled rejections and passes the others on
// to the process's other listeners; without one, they disappear without a trace.
//
// A rejection fails the run, so that a new one cannot hide among passing tests. One that came
// during the run fails the root "after all" hook of this file (mochaHooks below, mocha's root hook
// plugin), which mocha reports and counts as a failure, so that mocha's own exit status carries it.
// Mocha runs that hook before the root "after all" hooks of the test files, and work that the tests
// left behind can end later still; a rejection that comes after the hook, or in a run that does not
// reach it, gives exit status 1 at the process's exit (failLater). With --exit, mocha calls
// process.exit as soon as the run's output is written, before Node reports a rejection that comes
// after the run, so such a rejection goes unseen; the repository's runs do not use --exit.
// report-unhandled-rejections.test.mjs checks both ways, the first also with --exit.
'use strict';
const util = require('node:util');

/** the test that runs now, and the one that ended last */
let running;
let lastEnded;
/** the rejected promises reported so far: mocha passes a rejection that is not its own to this listener once more */
const reported = new WeakSet();
let count = 0;
/** how many rejections the root "after all" hook has failed the run for */
let counted = 0;

const title = (test) => `"${test.fullTitle()}"`;
function where() {
    const before = lastEnded ? `; the test that ended before it: ${title(lastEnded)}` : '';
    return running ? `while ${title(running)} ran${before}` : lastEnded ? `after ${title(lastEnded)} had ended` : 'before the first test';
}
function reasonOf(reason) {
    if (reason === undefined) { return 'the promise was rejected with undefined'; }
    if (reason instanceof Error) { return reason.stack ?? `${reason.name}: ${reason.message}`; }
    return `the promise was rejected with ${util.inspect(reason, { depth: 3 })}`;
}

process.on('unhandledRejection', (reason, promise) => {
    if (reported.has(promise)) { return; }
    reported.add(promise);
    count++;
    process.stderr.write(`\nunhandled rejection ${count}, ${where()}: ${reasonOf(reason)}\n`);
});

process.on('exit', () => {
    if (count === 0) { return; }
    process.stderr.write(`\n${count} unhandled rejection${count === 1 ? '' : 's'} in this run (listed above); each is a defect in the code or the test that caused it\n`);
});

/** Exit status 1 for the rejections that the root "after all" hook has not failed the run for, unless the run fails already. */
const failLater = () => { if (count > counted) { process.exitCode ||= 1; } };
// This depends on the order of mocha's 'exit' listeners, as in mocha 12.0.1 (lib/cli/run-helpers.cjs):
// mocha sets the run's exit status with --exit before it calls process.exit, and without --exit in
// an 'exit' listener that it adds when the run has ended (exitMochaLater), which would overwrite a
// status set by an earlier listener. So failLater is the last 'exit' listener: Node emits
// 'beforeExit' each time the event loop has run empty, which happens after mocha's run has ended,
// and failLater moves to the end of the list there. With --exit, Node does not emit 'beforeExit',
// and failLater, added here, runs after mocha has set the status.
process.on('exit', failLater);
process.on('beforeExit', () => {
    process.removeListener('exit', failLater);
    process.on('exit', failLater);
});

exports.mochaHooks = {
    beforeEach() { running = this.currentTest; },
    afterEach() { lastEnded = this.currentTest; running = undefined; },
    afterAll() {
        counted = count;
        if (count > 0) { throw new Error(`${count} unhandled rejection${count === 1 ? '' : 's'} during the run (listed above)`); }
    },
};
