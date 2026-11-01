// Tests of scripts/lib/options.mjs. npm run test:unit runs them with node --test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOptions, UsageError } from './options.mjs';

const spec = { ext: 'value', port: 'number', frame: 'flag', 'theme-page': 'number' };

test('parseOptions reads --name value, --name=value, numbers and flags', () => {
    assert.deepEqual(parseOptions(spec, ['--ext', 'a', '--port=8765', '--frame', '--theme-page', '3']),
        { ext: 'a', port: 8765, frame: true, 'theme-page': 3 });
    assert.deepEqual(parseOptions(spec, ['--ext=--odd']), { ext: '--odd' });
    assert.deepEqual(parseOptions(spec, []), {});
});

test('parseOptions refuses what it cannot read as the script means it', () => {
    const cases = [
        [['--extt', 'a'], /unknown option --extt/],
        [['ext'], /ext is not an option/],
        [['--ext'], /--ext needs a value/],
        [['--ext', '--port', '1'], /--ext needs a value/],
        [['--ext', 'a', '--ext', 'b'], /--ext is given twice/],
        [['--frame=yes'], /--frame does not take a value/],
        [['--port', 'abc'], /--port needs a number, not abc/],
        [['--port='], /--port needs a number/],
    ];
    for (const [argv, message] of cases) {
        assert.throws(() => parseOptions(spec, argv), (error) => error instanceof UsageError && message.test(error.message), argv.join(' '));
    }
});
