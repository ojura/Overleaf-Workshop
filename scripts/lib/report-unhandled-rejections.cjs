// Loaded into every mocha run of this repository through .mocharc.json. It reports each unhandled
// rejection with the test that was running when it came and the test that had ended before it,
// since a rejection can come from work that an earlier test left behind, and at the end the number
// of them. Mocha 12 handles only its own errors among unhandled rejections and passes the others on
// to the process's other listeners; without one, they disappear without a trace.
'use strict';
const util = require('node:util');

/**
 * Whether an unhandled rejection fails the run. Not yet: src/test/compileWait.test.ts leaves
 * rejections with the reason undefined behind in each run (7 at 94fefaf; node:test's runner, when
 * it shared mocha's process, printed each of them twice, as 14 lines), and ow-sandbox, which owns
 * the compile code, is fixing that test. Once it is fixed, this becomes true, so that a new
 * unhandled rejection cannot hide.
 */
const FAIL_THE_RUN = false;

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
    if (FAIL_THE_RUN) { process.exitCode = 1; }
});

exports.mochaHooks = {
    beforeEach() { running = this.currentTest; },
    afterEach() { lastEnded = this.currentTest; running = undefined; },
};
