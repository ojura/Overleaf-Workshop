import * as assert from 'assert';
import { ERROR_JSON_LIMIT, errorMessage } from '../utils/errorMessage';

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

    it('cuts the JSON of a large value to a length that a notification or a line can show, and says so', () => {
        const text = errorMessage({ data: 'x'.repeat(1_000_000) });
        assert.ok(text.startsWith('{"data":"xxx'), text.slice(0, 20));
        assert.strictEqual(text, `${JSON.stringify({ data: 'x'.repeat(1_000_000) }).slice(0, ERROR_JSON_LIMIT)} [cut to ${ERROR_JSON_LIMIT} of 1000011 characters]`);
        // a JSON text of the limit's length stays whole
        const whole = { data: 'y'.repeat(ERROR_JSON_LIMIT - '{"data":""}'.length) };
        assert.strictEqual(errorMessage(whole), JSON.stringify(whole));
    });

    it('writes a value that JSON cannot write, and any other value, as text', () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        assert.strictEqual(errorMessage(cycle), '[object Object]');
        assert.strictEqual(errorMessage({ size: 1n }), '[object Object]');
        // JSON gives no text for it
        assert.strictEqual(errorMessage({ toJSON: () => undefined }), '[object Object]');
        assert.strictEqual(errorMessage('not authorized'), 'not authorized');
        assert.strictEqual(errorMessage(undefined), 'undefined');
        assert.strictEqual(errorMessage(null), 'null');
    });
});
