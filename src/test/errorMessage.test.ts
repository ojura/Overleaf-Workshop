import * as assert from 'assert';
import { errorMessage } from '../utils/errorMessage';

/** What Node's fetch throws when it cannot reach the server: the reason is in the cause. */
const fetchFailure = () => Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') });

describe('the text of an error for a message (errorMessage)', () => {
    it('gives an error\'s message, and its cause\'s message after it when it has one, as fetch\'s failures have', () => {
        assert.strictEqual(errorMessage(new Error('the upload failed')), 'the upload failed');
        assert.strictEqual(errorMessage(fetchFailure()), 'fetch failed: connect ECONNREFUSED 127.0.0.1:443');
    });

    it('gives the message of a value that a server sent, as Overleaf\'s real-time server sends its errors', () => {
        assert.strictEqual(errorMessage({ message: 'rate-limit hit when joining doc', code: 'TooManyRequests' }), 'rate-limit hit when joining doc');
    });

    it('writes an object without a message as JSON, so that its fields show', () => {
        assert.strictEqual(errorMessage({ code: 'TooManyRequests' }), '{"code":"TooManyRequests"}');
    });

    it('writes a value that JSON cannot write, and any other value, as text', () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        assert.strictEqual(errorMessage(cycle), '[object Object]');
        assert.strictEqual(errorMessage({ size: 1n }), '[object Object]');
        assert.strictEqual(errorMessage('not authorized'), 'not authorized');
        assert.strictEqual(errorMessage(undefined), 'undefined');
        assert.strictEqual(errorMessage(null), 'null');
    });
});
