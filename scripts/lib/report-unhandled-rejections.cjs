// Loaded into every mocha run of this repository through .mocharc.json. It reports each unhandled
// rejection with the test that was running when it came and the test that had ended before it,
// since a rejection can come from work that an earlier test left behind, and at the end the number
// of them. Mocha 12 handles only its own errors among unhandled rejections and passes the others on
// to the process's other listeners; without one, they disappear without a trace. A run with an
// unhandled rejection fails (exit status 1 when the tests passed), so that a new one cannot hide
// among passing tests.
'use strict';
const util = require('node:util');

/** the test that runs now, and the one that ended last */
let running;
let lastEnded;
/** the rejected promises reported so far: mocha passes a rejection that is not its own to this listener once more */
const reported = new WeakSet();
let count = 0;

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

/** Exit status 1 for a run with an unhandled rejection, unless the run fails already. */
const failTheRun = () => { if (count > 0) { process.exitCode ||= 1; } };
// Mocha sets the run's exit status itself (lib/cli/run-helpers.cjs): with --exit before it calls
// process.exit, and without --exit in an 'exit' listener that it adds when the run has ended, which
// would overwrite a status set by an earlier listener. So failTheRun is the last 'exit' listener:
// Node emits 'beforeExit' each time the event loop has run empty, which happens after mocha's run
// has ended, and failTheRun moves to the end of the list there. With --exit, Node does not emit
// 'beforeExit', and failTheRun, added here, runs after mocha has set the status.
process.on('exit', failTheRun);
process.on('beforeExit', () => {
    process.removeListener('exit', failTheRun);
    process.on('exit', failTheRun);
});

exports.mochaHooks = {
    beforeEach() { running = this.currentTest; },
    afterEach() { lastEnded = this.currentTest; running = undefined; },
};
