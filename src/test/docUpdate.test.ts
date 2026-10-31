import * as assert from 'assert';
import * as DiffMatchPatch from 'diff-match-patch';
import { opsFor, semanticDiff, TextOp } from '../utils/docUpdate';

/** Apply ops one after the other, as Overleaf does. */
function apply(text: string, ops: TextOp[]): string {
    for (const op of ops) {
        if (op.i !== undefined) { text = text.slice(0, op.p) + op.i + text.slice(op.p); }
        else {
            assert.strictEqual(text.slice(op.p, op.p + op.d!.length), op.d, `op ${JSON.stringify(op)} deletes other text`);
            text = text.slice(0, op.p) + text.slice(op.p + op.d!.length);
        }
    }
    return text;
}

describe('docUpdate: the ops of an update', () => {
    it('turns the text before into the text after', () => {
        const pairs: Array<[string, string]> = [
            ['hello', 'hello a'],
            ['L04 before the target commented span text after.', 'L04 before the target comZZZted span text after.'],
            ['a b c\nd e f\n', 'a B c\nd f\nnew line\n'],
            ['Kovačić je ćirilica ž\n', 'Kovačić nije ćirilica ž!\n'],
            ['same', 'same'],
            ['', 'all new'],
            ['all gone', ''],
        ];
        for (const [before, after] of pairs) { assert.strictEqual(apply(before, opsFor(before, after)), after); }
        assert.deepStrictEqual(opsFor('same', 'same'), []);
    });
    it('places a deleted line as Overleaf\'s git bridge does, where the plain diff cuts across lines', () => {
        const before = 'L09 x.\nL10 y.\nL11 z.\n', after = 'L09 x.\nL11 z.\n';
        assert.deepStrictEqual(opsFor(before, after), [{ p: 7, d: 'L10 y.\n' }]);
        // the plain diff, which the extension used before: from the middle of one line to the middle of the next
        assert.deepStrictEqual(new DiffMatchPatch().diff_main(before, after).filter(d => d[0] !== 0), [[-1, '0 y.\nL1']]);
        assert.deepStrictEqual(semanticDiff(before, after).filter(d => d[0] !== 0), [[-1, 'L10 y.\n']]);
    });
});
