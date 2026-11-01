// Tests of scripts/lib/report-unhandled-rejections.cjs: mocha runs the test files in fixtures/ with
// the repository's configuration (.mocharc.cjs), which loads the logger, with and without --exit.
// npm run test:unit runs these tests with node --test, so a change of mocha that stops the logger
// from failing a run fails them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mocha = createRequire(path.join(repo, 'package.json')).resolve('mocha/bin/mocha.js');

/**
 * Run mocha with the repository's configuration on fixtures/`file`, started in the checkout or in
 * the folder `cwd` inside it, where mocha finds .mocharc.cjs by searching upward; { status, output }.
 */
function runMocha(file, options = [], cwd = repo) {
    const result = spawnSync(process.execPath, [mocha, ...options, path.join(repo, 'scripts', 'lib', 'fixtures', file)],
        { cwd, encoding: 'utf8' });
    if (result.error) { throw result.error; }
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

// With --exit, mocha calls process.exit once the run's output is written, before Node reports a
// rejection that comes after the run, so that case is tested without --exit only.
test('a rejection after the logger\'s root "after all" hook gives exit status 1, without --exit', () => {
    const { status, output } = runMocha('rejection-after-run.cjs');
    assert.equal(status, 1, output);
    assert.match(output, /unhandled rejection 1, while the "after all" hook in "\{root\}" ran; the test that ended before it: "passes": Error: left behind after the run/);
    assert.match(output, /1 passing/);
    assert.doesNotMatch(output, /failing/);
    assert.match(output, /1 unhandled rejection in this run/);
});

for (const options of [[], ['--exit']]) {
    const how = options.length ? 'with --exit' : 'without --exit';

    test(`a rejection during the run fails the run's root "after all" hook, ${how}`, () => {
        const { status, output } = runMocha('rejection-during-run.cjs', options);
        assert.equal(status, 1, output);
        assert.match(output, /unhandled rejection 1, while "passes and leaves a rejection behind" ran: Error: left behind during the run/);
        assert.match(output, /2 passing/);
        assert.match(output, /1 failing/);
        assert.match(output, /"after all" hook.*\n.*1 unhandled rejection during the run/);
    });

    test(`a run without a rejection passes, ${how}`, () => {
        const { status, output } = runMocha('clean.cjs', options);
        assert.equal(status, 0, output);
        assert.doesNotMatch(output, /unhandled rejection/);
    });
}

test('a rejection while mocha loads the test files fails the run, from CommonJS and from an ES module', () => {
    for (const [file, reason] of [['load-time.cjs', 'rejected while the test file loads'], ['load-time-await.mjs', 'rejected before a top-level wait']]) {
        const { status, output } = runMocha(file);
        assert.equal(status, 1, output);
        assert.match(output, new RegExp(`unhandled rejection 1, before the first test: Error: ${reason}`));
        assert.match(output, /1 unhandled rejection during the run/);
    }
});

test('a rejection names the hook that ran, and a test whose "before each" hook failed does not count as having run', () => {
    const { status, output } = runMocha('hooks.cjs');
    assert.equal(status, 2, output);
    assert.match(output, /unhandled rejection 1, while the "before all" hook in "a suite whose before-all hook leaves a rejection" ran: Error: left by a before-all hook/);
    assert.match(output, /unhandled rejection 2, while "after them leaves a rejection" ran; the test that ended before it: "a suite whose before-all hook leaves a rejection passes": Error: left by a test/);
});

test('a rejection that gets its handler later does not fail the run', () => {
    const { status, output } = runMocha('handled-later.cjs');
    assert.equal(status, 0, output);
    assert.match(output, /rejection 1 got a handler later, while "attaches its handler 10 ms later" ran; it no longer counts/);
    assert.doesNotMatch(output, /unhandled rejections? in this run/);
});

test('mocha started in a folder inside the checkout finds the configuration and loads the logger', () => {
    for (const folder of ['scripts', path.join('scripts', 'lib', 'fixtures'), 'views']) {
        const { status, output } = runMocha('rejection-during-run.cjs', [], path.join(repo, folder));
        assert.equal(status, 1, `${folder}: ${output}`);
        assert.match(output, /unhandled rejection 1, while "passes and leaves a rejection behind" ran/, folder);
    }
});
