/* eslint-disable @typescript-eslint/naming-convention -- Overleaf's field names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { assessPush, bridgeEdits, DocRanges, Finding, ProjectRanges, PushedFile, rangesOf } from '../sandbox/ranges';
import { bridgeProjectId, pushedFiles } from '../sandbox/gitPush';

// The test document of the measurements (2026-10-31): a comment on "commented span text",
// a tracked insertion of "inserted words " and a tracked deletion of "deleted words ".
const TEXT = [
    'L01 alpha one: the first line is far from every range.',
    'L02 bravo two: still far away.',
    'L03 charlie three: a plain line.',
    'L04 delta four: before the target commented span text after the target.',
    'L05 echo five: a plain line.',
    'L06 foxtrot six: a plain line.',
    'L07 golf seven: before the insertion inserted words after the insertion.',
    'L08 hotel eight: a plain line.',
    'L09 india nine: a plain line.',
    'L10 juliet ten: before the deletion after the deletion.',
    'L11 kilo eleven: a plain line.',
    'L12 lima twelve: the last line is far from every range.',
].join('\n') + '\n';
const COMMENT = 'commented span text', INSERT = 'inserted words ';
const enc = (s: string) => new TextEncoder().encode(s);

function doc(text = TEXT, extra: Partial<DocRanges> = {}): DocRanges {
    return {
        path: 'a.tex', docId: 'd1', text,
        comments: [{ id: 't1', threadId: 't1', p: text.indexOf(COMMENT), text: COMMENT, userId: 'u1' }],
        changes: [
            { id: 'c1', kind: 'insertion', p: text.indexOf(INSERT), text: INSERT, userId: 'u1' },
            { id: 'c2', kind: 'deletion', p: text.indexOf('before the deletion ') + 'before the deletion '.length, text: 'deleted words ', userId: 'u1' },
        ],
        ...extra,
    };
}
const project = (docs: DocRanges[], trackChanges: ProjectRanges['trackChanges'] = false): ProjectRanges =>
    ({ projectId: 'p', docs, trackChanges, users: { u1: 'Ana', u2: 'Ivo' } });
const modify = (after: string, before = TEXT, filePath = 'a.tex'): PushedFile =>
    ({ status: 'M', path: filePath, before: enc(before), after: enc(after) });
const at = (s: string) => TEXT.indexOf(s);
const splice = (from: number, to: number, by: string) => TEXT.slice(0, from) + by + TEXT.slice(to);
const severities = (findings: Finding[]) => findings.map(f => f.severity);
const only = (findings: Finding[], severity: string) => findings.filter(f => f.severity === severity);

describe('git push check: the bridge\'s edits', () => {
    it('places a deleted line as the semantic diff does, where the plain diff would cut across lines', () => {
        const before = 'L09 x.\nL10 y.\nL11 z.\n', after = 'L09 x.\nL11 z.\n';
        // measured: the bridge put a tracked deletion of the removed line at the next line's start
        assert.deepStrictEqual(bridgeEdits(before, after), [{ from: 7, to: 14, inserted: '' }]);
    });
    it('keeps a replacement inside a word as one edit', () => {
        const c = at(COMMENT);
        assert.deepStrictEqual(bridgeEdits(TEXT, splice(c + 3, c + 6, 'ZZZ')), [{ from: c + 3, to: c + 6, inserted: 'ZZZ' }]);
    });
});

describe('git push check: edits of a document with ranges', () => {
    const state = project([doc()]);
    const c = at(COMMENT), i = at(INSERT);
    it('says nothing about edits far from every range (measured: all kept)', () => {
        assert.deepStrictEqual(assessPush(state, [modify(TEXT.replace('alpha one', 'ALPHA ONE').replace('lima twelve', 'LIMA TWELVE'))]), []);
    });
    it('says nothing about text added right before or right after a comment (measured: kept)', () => {
        assert.deepStrictEqual(assessPush(state, [modify(splice(c, c, 'XX '))]), []);
        assert.deepStrictEqual(assessPush(state, [modify(splice(c + COMMENT.length, c + COMMENT.length, ' YY'))]), []);
    });
    it('warns that a comment shrinks when the push replaces text across its start (measured: "ted span text")', () => {
        const f = assessPush(state, [modify(splice(c - 7, c + 6, 'OVERLAPPED'))]);
        assert.deepStrictEqual(severities(f), ['warn']);
        assert.match(f[0].message, /comment by Ana on "commented span text" \(line 4\) shrinks to "ted span text"/);
    });
    it('warns that a comment shrinks when the push replaces its last word, whose new text lands after it (measured: "commented span ")', () => {
        const f = assessPush(state, [modify(splice(c + COMMENT.length - 4, c + COMMENT.length, 'TEXT'))]);
        assert.deepStrictEqual(severities(f), ['warn']);
        assert.match(f[0].message, /shrinks to "commented span "/);
    });
    it('warns that a comment covers text the push changes inside it (measured: "comZZZted span text")', () => {
        const f = assessPush(state, [modify(splice(c + 3, c + 6, 'ZZZ'))]);
        assert.match(f[0].message, /then covers "comZZZted span text"/);
    });
    it('warns that a comment is emptied when the push deletes its text or its line (measured: emptied)', () => {
        assert.match(assessPush(state, [modify(splice(c, c + COMMENT.length, ''))])[0].message, /is emptied/);
        const line = TEXT.lastIndexOf('\n', c) + 1, end = TEXT.indexOf('\n', c) + 1;
        assert.match(assessPush(state, [modify(splice(line, end, ''))])[0].message, /is emptied/);
    });
    it('warns about tracked insertions that shrink, split or are lost (measured)', () => {
        assert.match(assessPush(state, [modify(splice(i - 7, i + 6, 'OVERLAPPED'))])[0].message, /tracked insertion by Ana of "inserted words " \(line 7\) shrinks to "ed words "/);
        assert.match(assessPush(state, [modify(splice(i + 3, i + 6, 'ZZZ'))])[0].message, /is split in two/);
        assert.match(assessPush(state, [modify(splice(i, i + INSERT.length, ''))])[0].message, /is lost: its text is deleted/);
    });
    it('does not warn about tracked deletions, which every edit kept (measured)', () => {
        const d = state.docs[0].changes[1].p;
        for (const after of [splice(d, d, 'XX '), splice(d - 7, d + 6, 'OVERLAPPED'), splice(d - 4, d + 6, '')]) {
            assert.deepStrictEqual(only(assessPush(state, [modify(after)]), 'warn'), []);
            assert.deepStrictEqual(only(assessPush(state, [modify(after)]), 'refuse'), []);
        }
    });
    it('warns when repeated text next to a comment makes the edit\'s place ambiguous (measured: the comment moved to another copy)', () => {
        const text = 'L1 one two three.\nL2 alpha beta alpha beta alpha beta end.\nL3 four five six.\n';
        const middle = text.indexOf('alpha beta', text.indexOf('alpha beta') + 1);
        const d = doc(text, { comments: [{ id: 't1', threadId: 't1', p: middle, text: 'alpha beta', userId: 'u1' }], changes: [] });
        const f = assessPush(project([d]), [modify(text.replace('alpha beta ', ''), text)]);
        assert.deepStrictEqual(severities(f), ['warn']);
        assert.match(f[0].message, /repeated text next to it/);
        // the same comment with the edit far away: nothing to say
        assert.deepStrictEqual(assessPush(project([d]), [modify(text.replace('four', 'FOUR'), text)]), []);
    });
    it('says that repeated text may have changed another copy when the diff empties a comment', () => {
        const text = 'L2 alpha beta alpha beta end.\n';
        const second = text.indexOf('alpha beta', 4);
        const d = doc(text, { comments: [{ id: 't1', threadId: 't1', p: second, text: 'alpha beta', userId: 'u1' }], changes: [] });
        const f = assessPush(project([d]), [modify(text.replace('alpha beta ', ''), text)]);
        assert.match(f[0].message, /is emptied.*repeats here/);
    });
});

describe('git push check: files', () => {
    const state = project([doc(), { path: 'plain.tex', docId: 'd2', text: 'no ranges\n', comments: [], changes: [] }]);
    it('refuses to delete, rename or move a document with ranges (measured: all lost, threads left without a comment)', () => {
        const rename = assessPush(state, [{ status: 'R', path: 'b.tex', oldPath: 'a.tex', before: enc(TEXT), after: enc(TEXT) }]);
        assert.deepStrictEqual(severities(rename), ['refuse']);
        assert.match(rename[0].message, /renames it to b.tex: .*1 comment, 1 tracked insertion, 1 tracked deletion are lost/);
        assert.match(assessPush(state, [{ status: 'R', path: 'sub/a.tex', oldPath: 'a.tex', before: enc(TEXT), after: enc(TEXT) }])[0].message, /moves it to sub\/a.tex/);
        assert.match(assessPush(state, [{ status: 'D', path: 'a.tex', before: enc(TEXT) }])[0].message, /deletes it/);
    });
    it('lets documents without ranges be renamed, moved and deleted', () => {
        assert.deepStrictEqual(assessPush(state, [{ status: 'R', path: 'plain2.tex', oldPath: 'plain.tex', before: enc('no ranges\n'), after: enc('no ranges\n') }]), []);
        assert.deepStrictEqual(assessPush(state, [{ status: 'D', path: 'plain.tex', before: enc('no ranges\n') }]), []);
        assert.deepStrictEqual(assessPush(state, [{ status: 'A', path: 'new.tex', after: enc('new\n') }]), []);
    });
    it('refuses when Overleaf no longer has the text the push starts from', () => {
        const f = assessPush(state, [modify(TEXT.replace('alpha', 'ALPHA'), TEXT.replace('bravo', 'BRAVO'))]);
        assert.deepStrictEqual(severities(f), ['refuse']);
        assert.match(f[0].message, /differs from the commit the push starts from/);
    });
    it('warns about "\\r\\n" line endings, which change nothing on Overleaf (measured: ranges kept)', () => {
        const f = assessPush(state, [modify(TEXT.replace(/\n/g, '\r\n'))]);
        assert.deepStrictEqual(severities(f), ['warn']);
        assert.match(f[0].message, /line endings/);
    });
    it('refuses to turn a document with ranges into a binary file', () => {
        const f = assessPush(state, [{ status: 'M', path: 'a.tex', before: enc(TEXT), after: new Uint8Array([0, 1, 2]) }]);
        assert.deepStrictEqual(severities(f), ['refuse']);
    });
});

describe('git push check: track changes', () => {
    const edit = modify(TEXT.replace('alpha one', 'ALPHA ONE'));
    it('warns when track changes is on for the pushing account (measured: the push became tracked changes)', () => {
        const f = assessPush(project([doc()], { u1: true }), [edit], 'u1');
        assert.deepStrictEqual(severities(f), ['warn']);
        assert.match(f[0].message, /track changes is on for Ana/);
        assert.deepStrictEqual(severities(assessPush(project([doc()], true), [edit], 'u1')), ['warn']);
    });
    it('says nothing when track changes is on only for someone else', () => {
        assert.deepStrictEqual(assessPush(project([doc()], { u2: true }), [edit], 'u1'), []);
    });
    it('says nothing about track changes when the push changes no text', () => {
        assert.deepStrictEqual(assessPush(project([doc()], { u1: true }), [], 'u1'), []);
    });
});

describe('git push check: reading', () => {
    it('reads joinDoc\'s ranges as measured on overleaf.com', () => {
        const r = rangesOf({
            changes: [
                { id: 'e45e', op: { i: 'inserted words ', p: 288 }, metadata: { user_id: 'u1', ts: '2026-10-31T09:42:10.243Z' } },
                { id: '79b1', op: { p: 421, d: 'deleted words ' }, metadata: { user_id: 'u1', ts: '2026-10-31T09:42:10.365Z' } },
            ],
            comments: [{ id: 'f8fe', op: { c: 'commented span text', p: 153, t: 'f8fe' }, metadata: { user_id: 'u1', ts: '2026-10-31T09:42:10.119Z' } }],
        });
        assert.deepStrictEqual(r.comments, [{ id: 'f8fe', threadId: 'f8fe', p: 153, text: 'commented span text', userId: 'u1' }]);
        assert.deepStrictEqual(r.changes.map(c => [c.kind, c.p, c.text]), [['insertion', 288, 'inserted words '], ['deletion', 421, 'deleted words ']]);
        assert.deepStrictEqual(rangesOf(undefined), { comments: [], changes: [] });
    });
    it('reads the project id from a git bridge remote', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranges-remote-'));
        execFileSync('git', ['init', '--quiet', dir]);
        execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://git.overleaf.com/6ae5b75144c9b8a04abed664']);
        assert.strictEqual(bridgeProjectId(dir), '6ae5b75144c9b8a04abed664');
        execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com/x/y']);
        assert.strictEqual(bridgeProjectId(dir), undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    it('lists what the commits add, change, delete and rename, with both contents', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranges-push-'));
        const g = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();
        g('init', '--quiet');
        fs.writeFileSync(path.join(dir, 'keep.tex'), 'one\n');
        fs.writeFileSync(path.join(dir, 'gone.tex'), 'two\n');
        fs.writeFileSync(path.join(dir, 'old.tex'), 'three, long enough to be recognized as renamed\n');
        g('add', '-A'); g('commit', '--quiet', '-m', 'start');
        const from = g('rev-parse', 'HEAD');
        fs.writeFileSync(path.join(dir, 'keep.tex'), 'one, changed\n');
        fs.rmSync(path.join(dir, 'gone.tex'));
        fs.mkdirSync(path.join(dir, 'sub'));
        fs.renameSync(path.join(dir, 'old.tex'), path.join(dir, 'sub', 'new.tex'));
        fs.writeFileSync(path.join(dir, 'added.tex'), 'four\n');
        g('add', '-A'); g('commit', '--quiet', '-m', 'push');
        const files = pushedFiles(dir, from, 'HEAD');
        const byPath = Object.fromEntries(files.map(f => [f.path, f]));
        assert.deepStrictEqual(files.map(f => f.status).sort(), ['A', 'D', 'M', 'R']);
        assert.strictEqual(Buffer.from(byPath['keep.tex'].after!).toString(), 'one, changed\n');
        assert.strictEqual(Buffer.from(byPath['keep.tex'].before!).toString(), 'one\n');
        assert.strictEqual(byPath['sub/new.tex'].oldPath, 'old.tex');
        assert.strictEqual(byPath['gone.tex'].after, undefined);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
