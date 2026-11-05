// Loaded into every mocha run of this repository through .mocharc.cjs. It reports each unhandled
// rejection with what was running when it came, a test or a hook, and the test that had ended
// before it, since a rejection can come from work that an earlier test left behind, and at the end
// the number of them. Mocha 12 handles only its own errors among unhandled rejections and passes
// the others on to the process's other listeners; without one, they disappear without a trace.
//
// What runs comes from the events of mocha's runner (test and hook begin, end and failure), which
// this file hears by wrapping the runner's run(). Node reports a rejection at the end of the turn of
// the event loop in which it was left without a handler, and mocha emits the end of a test or a hook
// in that same turn, so an end takes effect one turn later (setImmediate), and the rejection still
// counts as the test's or the hook's. A test whose "before each" hook failed did not run, and does
// not count as the test that ended before. A rejection that gets its handler later, for which Node
// then emits 'rejectionHandled', is reported as such and no longer counts.
//
// A rejection fails the run, so that a new one cannot hide among passing tests. One that came
// before the root "after all" hook of this file (mochaHooks below, mocha's root hook plugin), also
// while mocha loaded the test files, fails that hook, which mocha reports and counts as a failure,
// so that mocha's own exit status carries it. Mocha runs that hook before the root "after all"
// hooks of the test files, and work that the tests left behind can end later still; a rejection
// that comes after the hook, or in a run that does not reach it, gives exit status 1 at the
// process's exit (failLater). With --exit, mocha calls process.exit as soon as the run's output is
// written, before Node reports a rejection that comes after the run, so such a rejection goes
// unseen; the repository's runs do not use --exit. report-unhandled-rejections.test.mjs checks
// these cases.
'use strict';
const util = require('node:util');
// mocha's own runner class: its command line and this require share the module
const { Runner } = require('mocha');

/** the test and the hook that run now, and the last test that ran to its end */
let runningTest;
let runningHook;
let lastEnded;
/** the number of each rejected promise reported so far: mocha passes a rejection that is not its own to this listener once more */
const reported = new WeakMap();
let reportedCount = 0;
/** the rejections that still count: reported, and without a handler since */
let count = 0;
/** how many rejections the root "after all" hook has failed the run for */
let counted = 0;

const { EVENT_TEST_BEGIN, EVENT_TEST_END, EVENT_HOOK_BEGIN, EVENT_HOOK_END, EVENT_TEST_FAIL } = Runner.constants;
const run = Runner.prototype.run;
Runner.prototype.run = function runWithAttribution(...args) {
    this.on(EVENT_TEST_BEGIN, (test) => { runningTest = test; });
    this.on(EVENT_TEST_END, (test) => {
        setImmediate(() => {
            if (runningTest === test) { runningTest = undefined; }
            lastEnded = test;
        });
    });
    this.on(EVENT_HOOK_BEGIN, (hook) => { runningHook = hook; });
    this.on(EVENT_HOOK_END, (hook) => { setImmediate(() => { if (runningHook === hook) { runningHook = undefined; } }); });
    // a failed hook ends without EVENT_HOOK_END, and a failed "before each" hook ends its test, which does not run
    this.on(EVENT_TEST_FAIL, (runnable) => {
        if (runnable.type !== 'hook') { return; }
        setImmediate(() => {
            if (runningHook === runnable) { runningHook = undefined; }
            runningTest = undefined;
        });
    });
    return run.apply(this, args);
};

const title = (runnable) => `"${runnable.fullTitle()}"`;
function where() {
    const before = lastEnded ? `; the test that ended before it: ${title(lastEnded)}` : '';
    // mocha's title of a hook names its suite or its test: "before all" hook in "<suite>", "before each" hook for "<test>"
    if (runningHook) { return `while the ${runningHook.title} ran${before}`; }
    if (runningTest) { return `while ${title(runningTest)} ran${before}`; }
    return lastEnded ? `after ${title(lastEnded)} had ended` : 'before the first test';
}
function reasonOf(reason) {
    if (reason === undefined) { return 'the promise was rejected with undefined'; }
    if (reason instanceof Error) { return reason.stack ?? `${reason.name}: ${reason.message}`; }
    return `the promise was rejected with ${util.inspect(reason, { depth: 3 })}`;
}

process.on('unhandledRejection', (reason, promise) => {
    if (reported.has(promise)) { return; }
    reported.set(promise, ++reportedCount);
    count++;
    process.stderr.write(`\nunhandled rejection ${reportedCount}, ${where()}: ${reasonOf(reason)}\n`);
});

process.on('rejectionHandled', (promise) => {
    const number = reported.get(promise);
    if (number === undefined) { return; }
    reported.delete(promise);
    count--;
    process.stderr.write(`\nrejection ${number} got a handler later, ${where()}; it no longer counts${counted > count ? ', but the root "after all" hook has failed the run for it already' : ''}\n`);
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
    afterAll() {
        counted = count;
        if (count > 0) { throw new Error(`${count} unhandled rejection${count === 1 ? '' : 's'} during the run (listed above)`); }
    },
};
