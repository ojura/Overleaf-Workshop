/* eslint-disable @typescript-eslint/naming-convention -- Overleaf's field names (__guests__) */
import * as assert from 'assert';
import * as DiffMatchPatch from 'diff-match-patch';
import { opsFor, semanticDiff, TextOp, trackChangesOn, trackedChangesSeed, updateMeta } from '../utils/docUpdate';

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

describe('docUpdate: tracked updates', () => {
    it('reads for whom track changes is on, as the toggle event and joinProject send it', () => {
        assert.deepStrictEqual({ ...trackChangesOn(true), isOnFor: undefined }, { everyone: true, users: [], isOnFor: undefined });
        assert.deepStrictEqual(trackChangesOn(false).users, []);
        assert.deepStrictEqual(trackChangesOn(undefined).users, []);
        assert.deepStrictEqual(trackChangesOn({ u1: true, u2: false, __guests__: true }).users, ['u1', '__guests__']);
        assert.strictEqual(trackChangesOn(true).isOnFor('u1'), true);
        assert.strictEqual(trackChangesOn(false).isOnFor('u1'), false);
        assert.strictEqual(trackChangesOn({ u1: true }).isOnFor('u1'), true);
        assert.strictEqual(trackChangesOn({ u1: false, u2: true }).isOnFor('u1'), false);
        assert.strictEqual(trackChangesOn(undefined).isOnFor('u1'), false);
        assert.strictEqual(trackChangesOn({ u1: true }).isOnFor(undefined), false);
    });
    it('gives an update a fresh seed when track changes is on for its user, and no meta otherwise', () => {
        const a = updateMeta({ u1: true }, 'u1'), b = updateMeta(true, 'u1');
        assert.match(a!.tc, /^[0-9a-f]{18}$/);
        assert.notStrictEqual(a!.tc, b!.tc);
        assert.strictEqual(updateMeta({ u2: true }, 'u1'), undefined);
        assert.strictEqual(updateMeta(false, 'u1'), undefined);
        assert.strictEqual(updateMeta(undefined, 'u1'), undefined);
    });
    it('makes a seed that begins with the time in seconds, as an ObjectId does', () => {
        const seconds = parseInt(trackedChangesSeed().slice(0, 8), 16);
        assert.ok(Math.abs(seconds - Date.now() / 1000) < 5);
    });
});
