import * as assert from 'assert';
import { threeWayMerge } from '../utils/threeWayMerge';

describe('threeWayMerge', () => {
    it('does not mark identical changes on both sides as a conflict', () => {
        const base = 'a\nb\nc\n';
        const both = 'a\nB\nc\n';
        assert.deepStrictEqual(threeWayMerge(base, both, both), {content: both, hasConflict: false});
        const local = 'a\nB\nc\nlocal\n';
        assert.deepStrictEqual(threeWayMerge(base, local, both), {content: local, hasConflict: false});
    });
});
