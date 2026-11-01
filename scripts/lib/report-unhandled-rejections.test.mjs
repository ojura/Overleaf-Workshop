// Tests of scripts/lib/report-unhandled-rejections.cjs: mocha runs the test files in fixtures/ with
// the repository's configuration (.mocharc.json), which loads the logger, with and without --exit.
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

/** Run mocha with the repository's configuration on fixtures/`file`; { status, stderr }. */
function runMocha(file, options = []) {
    const result = spawnSync(process.execPath, [mocha, '--config', path.join(repo, '.mocharc.json'), ...options, path.join('scripts', 'lib', 'fixtures', file)],
        { cwd: repo, encoding: 'utf8' });
    if (result.error) { throw result.error; }
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

// With --exit, mocha calls process.exit once the run's output is written, before Node reports a
// rejection that comes after the run, so that case is tested without --exit only.
test('a rejection after the logger\'s root "after all" hook gives exit status 1, without --exit', () => {
    const { status, output } = runMocha('rejection-after-run.cjs');
    assert.equal(status, 1, output);
    assert.match(output, /unhandled rejection 1, after "passes" had ended: Error: left behind after the run/);
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
