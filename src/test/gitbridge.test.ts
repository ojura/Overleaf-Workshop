/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { bridgeCommitWithStart, checkResult, ConnectError, merge, ownFiles, rebase, startFromVersion } from '../gitbridge/connect';
import { pullFromBridge, pushToBridge } from '../gitbridge/flow';
import { findStartVersion, HistorySource, HistoryUpdate, readZip, treeAtVersion, TreeChange, VersionEntry } from '../gitbridge/history';
import { answerFromFindings } from '../gitbridge/overleaf';
import { gitDate, Repo } from '../gitbridge/plumbing';
import { connectReplica, CONNECT_REF } from '../gitbridge/replicaConnect';
import { anchorBridge } from '../gitbridge/anchor';

/** a time in seconds that git reads as one: git takes small numbers for something else */
const T = 1_700_000_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-test-'));

function newRepo(dir: string, bare = false): Repo {
    fs.mkdirSync(dir, { recursive: true });
    const repo = new Repo(dir);
    repo.run(['init', '--quiet', ...(bare ? ['--bare'] : []), '-b', 'master']);
    repo.run(['config', 'user.name', 'Test User']);
    repo.run(['config', 'user.email', 'test@example.com']);
    return repo;
}

/** Commit `files` (path to content, undefined to delete) on top of HEAD, with a fixed time and person. */
function commit(repo: Repo, files: Record<string, string | Buffer | undefined>, message: string, seconds: number, who = 'Test User <test@example.com>'): string {
    for (const [p, content] of Object.entries(files)) {
        const full = path.join(repo.dir, p);
        if (content === undefined) { fs.rmSync(full, { force: true }); repo.run(['rm', '--quiet', '--cached', '--ignore-unmatch', p]); continue; }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        repo.run(['add', p]);
    }
    const m = /^(.*) <(.*)>$/.exec(who)!;
    repo.run(['commit', '--quiet', '--allow-empty', '-m', message], { env: {
        GIT_AUTHOR_NAME: m[1], GIT_AUTHOR_EMAIL: m[2], GIT_AUTHOR_DATE: `${seconds} +0100`,
        GIT_COMMITTER_NAME: m[1], GIT_COMMITTER_EMAIL: m[2], GIT_COMMITTER_DATE: `${seconds} +0100`,
    } });
    return repo.mustCommit('HEAD');
}

/** A zip with stored and deflated entries, as Overleaf's version zips have them. */
function makeZip(files: Map<string, Buffer>): Buffer {
    const locals: Buffer[] = [], centrals: Buffer[] = [];
    let offset = 0, n = 0;
    for (const [name, content] of files) {
        const deflate = n++ % 2 === 1;
        const data = deflate ? zlib.deflateRawSync(content) : content;
        const nameBytes = Buffer.from(name, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(deflate ? 8 : 0, 10);
        central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, data);
        centrals.push(central, nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = centrals.reduce((s, b) => s + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

interface FakeFile { content: Buffer; editable: boolean; }

/** A project's history in memory: its state after each update. */
class FakeHistory implements HistorySource {
    states: Array<{ update: HistoryUpdate, files: Map<string, FakeFile> }> = [];
    zips = 0;
    docReads: string[] = [];
    add(endSeconds: number, change: (files: Map<string, FakeFile>) => void) {
        const previous = this.states.length ? this.states[this.states.length - 1] : undefined;
        const files = new Map(previous?.files ?? []);
        change(files);
        const fromV = previous?.update.toV ?? 0;
        this.states.push({ update: { fromV, toV: fromV + 1, endTs: endSeconds * 1000 + 250 }, files });
        return fromV + 1;
    }
    private at(v: number) { const s = this.states.find(x => x.update.toV === v); if (!s) { throw new Error(`no version ${v}`); } return s.files; }
    async updates(before?: number) {
        const all = [...this.states].reverse().map(s => s.update).filter(u => before === undefined || u.endTs < before);
        const page = all.slice(0, 3);
        return { updates: page, next: all.length > 3 ? page[page.length - 1].endTs : undefined };
    }
    async treeAt(v: number): Promise<VersionEntry[]> { return [...this.at(v)].map(([pathname, f]) => ({ pathname, editable: f.editable })); }
    async treeChanges(from: number, to: number): Promise<TreeChange[]> {
        const a = this.at(from), b = this.at(to);
        const out: TreeChange[] = [];
        for (const [p, f] of b) { if (!a.has(p)) { out.push({ pathname: p, operation: 'added' }); } else if (!a.get(p)!.content.equals(f.content)) { out.push({ pathname: p, operation: 'edited' }); } }
        for (const p of a.keys()) { if (!b.has(p)) { out.push({ pathname: p, operation: 'removed' }); } }
        return out;
    }
    async docAt(p: string, v: number) {
        this.docReads.push(`${p}@${v}`);
        const f = this.at(v).get(p);
        if (!f) { throw new Error(`no ${p} at ${v}`); }
        return f.editable ? f.content.toString('utf8') : 'binary' as const;
    }
    async zipAt(v: number) { this.zips++; return makeZip(new Map([...this.at(v)].map(([p, f]) => [p, f.content]))); }
}

const doc = (text: string): FakeFile => ({ content: Buffer.from(text), editable: true });
const bin = (bytes: number[]): FakeFile => ({ content: Buffer.from(bytes), editable: false });

/**
 * A project with history from before the local history: versions 1 and 2 are older, 3 is
 * the state the local history's first commit copies, and after it come two landings of
 * local commits and edits made on Overleaf (an image replaced, a document deleted, an image
 * added). The bridge has a commit for version 1 and one for the newest state, as when
 * nobody fetched in between.
 */
function scenario() {
    const dir = tmp();
    const history = new FakeHistory();
    const t0 = 1_700_000_000;
    history.add(t0, f => { f.set('main.tex', doc('main v1\n')); f.set('fig.png', bin([1, 2, 3])); f.set('logo.png', bin([5, 5])); });
    history.add(t0 + 100, f => { f.set('notes.tex', doc('notes v1\n')); f.set('old.tex', doc('old\n')); f.set('chapter.tex', doc('chapter\n')); });
    const startV = history.add(t0 + 200, f => { f.set('main.tex', doc('main v2\n')); });
    // the local history: a copy of the documents at version 3, then two commits
    const local = newRepo(path.join(dir, 'local'));
    const root = commit(local, { 'main.tex': 'main v2\n', 'notes.tex': 'notes v1\n', 'old.tex': 'old\n', 'chapter.tex': 'chapter\n' }, 'Snapshot of the project\'s text files', t0 + 300);
    const l1 = commit(local, { 'main.tex': 'main v3\n', 'tests/a.t': 'test a\n' }, 'Change main\n\nCo-Authored-By: Someone <s@example.com>', t0 + 400, 'Author One <one@example.com>');
    history.add(t0 + 450, f => { f.set('main.tex', doc('main v3\n')); });  // l1 landed
    history.add(t0 + 500, f => { f.set('fig.png', bin([9, 9])); f.delete('old.tex'); f.set('new.png', bin([7])); });  // edits on Overleaf
    const l2 = commit(local, { 'notes.tex': 'notes v2\n' }, 'Change notes', t0 + 600);
    const lastV = history.add(t0 + 650, f => { f.set('notes.tex', doc('notes v2\n')); });  // l2 landed
    // the bridge: a commit for version 1 and one for the newest state, dated at the last change
    const bridge = newRepo(path.join(dir, 'bridge'));
    const state = (v: number) => Object.fromEntries([...history.states.find(s => s.update.toV === v)!.files].map(([p, f]) => [p, f.content]));
    const b1 = commit(bridge, state(1), 'Update on Overleaf.', t0, 'Collaborator <c@example.com>');
    const remove = Object.fromEntries(Object.keys(state(1)).filter(p => !(p in state(lastV))).map(p => [p, undefined]));
    const b2 = commit(bridge, { ...remove, ...state(lastV) }, 'Update on Overleaf.', t0 + 650, 'Test User <test@example.com>');
    local.run(['remote', 'add', 'overleaf', bridge.dir]);
    local.run(['fetch', '--quiet', 'overleaf']);
    return { dir, history, local, bridge, root, l1, l2, b1, b2, startV, lastV, t0 };
}

describe('git bridge: plumbing', () => {
    it('writes nested trees and reads them back', () => {
        const repo = newRepo(path.join(tmp(), 'r'));
        const a = repo.blob(Buffer.from('a')), b = repo.blob(Buffer.from('b'));
        const tree = repo.writeTree(new Map([['x/y/a.txt', { mode: '100644', oid: a }], ['b.txt', { mode: '100755', oid: b }]]));
        assert.deepStrictEqual([...repo.flatTree(tree)], [['b.txt', { mode: '100755', oid: b }], ['x/y/a.txt', { mode: '100644', oid: a }]]);
    });
    it('adds a trailer to the trailer block', () => {
        const repo = newRepo(path.join(tmp(), 'r'));
        assert.strictEqual(repo.addTrailer('Subject\n\nBody.\n\nCo-Authored-By: A <a@x>\n', 'Rewritten-from: abc'),
                           'Subject\n\nBody.\n\nCo-Authored-By: A <a@x>\nRewritten-from: abc\n');
    });
    it('reports a conflicted three-way merge with its paths', () => {
        const repo = newRepo(path.join(tmp(), 'r'));
        const base = commit(repo, { 'f.txt': 'one\n', 'g.txt': 'g\n' }, 'base', T + 1000);
        const ours = commit(repo, { 'f.txt': 'two\n' }, 'ours', T + 1001);
        repo.run(['checkout', '--quiet', '-b', 'side', base]);
        const theirs = commit(repo, { 'f.txt': 'three\n' }, 'theirs', T + 1002);
        const merged = repo.mergeTrees(base, ours, theirs);
        assert.deepStrictEqual(merged.conflicts, ['f.txt']);
    });
});

describe('git bridge: zip', () => {
    it('reads stored and deflated entries', () => {
        const files = new Map([['a.txt', Buffer.from('alpha')], ['dir/b.bin', Buffer.from([0, 1, 2, 255])], ['c.txt', Buffer.from('c'.repeat(1000))]]);
        const read = readZip(makeZip(files));
        assert.deepStrictEqual([...read.keys()], [...files.keys()]);
        for (const [k, v] of files) { assert.ok(read.get(k)!.equals(v), k); }
    });
});

describe('git bridge: connect', () => {
    const show = (repo: Repo, rev: string, file: string) => repo.text(['show', `${rev}:${file}`]);
    it('merge without a rebase keeps every local id, takes the bridge\'s tree and adds the repository\'s own files', () => {
        const s = scenario();
        const side = { bridge: s.b2, local: s.l2 };
        const own = ownFiles(s.local, side);
        assert.deepStrictEqual(own.own, ['tests/a.t']);
        assert.deepStrictEqual(own.deletedOnOverleaf, ['old.tex']);
        const result = merge(s.local, side);
        assert.strictEqual(result.how, 'held');
        assert.strictEqual(result.heldAt, s.l2, 'the tip holds the bridge\'s state; old.tex, deleted on Overleaf and unchanged here, does not count against it');
        assert.deepStrictEqual(s.local.commitInfo(result.commit).parents, [s.b2, s.l2]);
        assert.deepStrictEqual([...s.local.flatTree(result.commit).keys()].sort(), ['chapter.tex', 'fig.png', 'logo.png', 'main.tex', 'new.png', 'notes.tex', 'tests/a.t']);
        assert.deepStrictEqual(result.carries, []);
        assert.ok(checkResult(s.local, side, result.commit).equal);
        assert.ok(s.local.isAncestor(s.root, result.commit), 'the local history stays, with its ids');
    });
    it('merge without a rebase joins at an older commit that holds the bridge\'s state, and carries the later local changes', () => {
        const s = scenario();
        s.local.run(['checkout', '--quiet', s.l2]);
        const l3 = commit(s.local, { 'notes.tex': 'notes v3, not landed\n', 'tests/b.t': 'test b\n' }, 'Not landed', s.t0 + 700);
        const result = merge(s.local, { bridge: s.b2, local: l3 });
        assert.strictEqual(result.how, 'held');
        assert.strictEqual(result.heldAt, s.l2);
        assert.deepStrictEqual(result.carries, ['notes.tex']);
        assert.deepStrictEqual(result.own, ['tests/a.t', 'tests/b.t']);
        assert.strictEqual(show(s.local, result.commit, 'notes.tex'), 'notes v3, not landed');
        assert.strictEqual(s.local.flatTree(result.commit).get('fig.png')!.oid, s.local.flatTree(s.b2).get('fig.png')!.oid, 'the files the local history never had come from the bridge');
    });
    it('merge refuses unrelated histories when no local commit holds the bridge\'s state, unless the bridge\'s version is taken', () => {
        const s = scenario();
        s.local.run(['checkout', '--quiet', s.l2]);
        const l3 = commit(s.local, { 'main.tex': 'main, a local change\n' }, 'Local', s.t0 + 700);
        s.bridge.run(['checkout', '--quiet', 'master']);
        const b3 = commit(s.bridge, { 'main.tex': 'main, edited on Overleaf\n' }, 'Update on Overleaf.', s.t0 + 660);
        s.local.run(['fetch', '--quiet', 'overleaf']);
        assert.throws(() => merge(s.local, { bridge: b3, local: l3 }), (e: any) => e instanceof ConnectError && e.paths.join() === 'main.tex');
        const result = merge(s.local, { bridge: b3, local: l3 }, { takeBridge: true });
        assert.strictEqual(result.how, 'took-bridge');
        assert.deepStrictEqual(result.tookBridge, ['main.tex']);
        assert.strictEqual(show(s.local, result.commit, 'main.tex'), 'main, edited on Overleaf');
    });
    it('merge stops on a local change to a file deleted on Overleaf', () => {
        const s = scenario();
        s.local.run(['checkout', '--quiet', s.l2]);
        const l3 = commit(s.local, { 'old.tex': 'old, changed here after Overleaf deleted it\n' }, 'Change old', s.t0 + 700);
        assert.throws(() => merge(s.local, { bridge: s.b2, local: l3 }), (e: any) => e instanceof ConnectError && e.paths.join() === 'old.tex');
    });
    it('merge refuses a local history that already contains the bridge\'s commit', () => {
        const s = scenario();
        const first = merge(s.local, { bridge: s.b2, local: s.l2 });
        assert.throws(() => merge(s.local, { bridge: s.b2, local: first.commit }), (e: any) => e instanceof ConnectError);
    });
    it('rebase from a version, then merge: the start is made from the history, authors, dates and messages stay, and the merge is three-way from the start', async () => {
        const s = scenario();
        const side = { bridge: s.b2, local: s.l2 };
        assert.strictEqual(bridgeCommitWithStart(s.local, side), undefined, 'no bridge commit has version 3');
        const files = new Map([...s.local.flatTree(s.root)].map(([p, e]) => [p, s.local.run(['cat-file', 'blob', e.oid]).stdout]));
        const update = await findStartVersion(s.history, files, s.t0 + 300);
        assert.strictEqual(update.toV, s.startV);
        const start = await startFromVersion(s.local, side, s.history, update);
        assert.strictEqual(start.kind, 'version');
        if (start.kind !== 'version') { return; }
        assert.strictEqual(start.parent, s.b1, 'the start\'s parent is the newest bridge commit before it');
        assert.deepStrictEqual(start.read.sort(), ['main.tex', 'notes.tex', 'old.tex'], 'documents that changed after the start are read at it');
        assert.deepStrictEqual(start.fromZip, ['fig.png'], 'a binary file that changed after the start comes from the zip');
        const rebased = rebase(s.local, s.l2, start);
        // the start: the whole project at version 3, made as the repository's user
        const sInfo = s.local.commitInfo(rebased.start);
        assert.ok(rebased.startMade);
        assert.strictEqual(sInfo.author, 'Test User <test@example.com>');
        assert.strictEqual(sInfo.authorDate, gitDate(s.history.states[2].update.endTs));
        assert.deepStrictEqual(sInfo.parents, [s.b1]);
        assert.match(sInfo.message, /version 3/);
        assert.deepStrictEqual(Object.fromEntries([...s.local.flatTree(rebased.start)].map(([p, e]) => [p, s.local.run(['cat-file', 'blob', e.oid]).stdout.toString('latin1')])),
                               { 'chapter.tex': 'chapter\n', 'fig.png': '\x01\x02\x03', 'logo.png': '\x05\x05', 'main.tex': 'main v2\n', 'notes.tex': 'notes v1\n', 'old.tex': 'old\n' });
        // the rewritten commits
        assert.strictEqual(rebased.map.length, 3);
        assert.strictEqual(rebased.commit, rebased.map[2][1]);
        const [, newL1] = rebased.map[1];
        const l1Info = s.local.commitInfo(s.l1), new1 = s.local.commitInfo(newL1);
        assert.strictEqual(new1.author, l1Info.author);
        assert.strictEqual(new1.authorDate, l1Info.authorDate);
        assert.strictEqual(new1.committerDate, l1Info.committerDate);
        assert.strictEqual(new1.message, `Change main\n\nCo-Authored-By: Someone <s@example.com>\nRewritten-from: ${s.l1}\n`);
        assert.strictEqual(show(s.local, newL1, 'fig.png').length, 3, 'whole trees: the image is there');
        assert.strictEqual(s.history.zips, 1);
        // the merge: Overleaf's edits come from the bridge, the own files from the local side
        const rside = { bridge: s.b2, local: rebased.commit };
        const result = merge(s.local, rside, { start: rebased.start });
        assert.strictEqual(result.how, 'three-way', 'Overleaf has edits the local history lacks (fig.png), so no rebased commit holds the bridge\'s state');
        assert.strictEqual(result.base, rebased.start);
        assert.deepStrictEqual(result.own, ['tests/a.t']);
        assert.deepStrictEqual(result.deletedOnOverleaf, ['old.tex']);
        assert.deepStrictEqual(s.local.commitInfo(result.commit).parents, [s.b2, rebased.commit]);
        assert.deepStrictEqual([...s.local.flatTree(result.commit).keys()].sort(), ['chapter.tex', 'fig.png', 'logo.png', 'main.tex', 'new.png', 'notes.tex', 'tests/a.t']);
        assert.ok(checkResult(s.local, rside, result.commit, rebased.start).equal);
        assert.ok(s.local.isAncestor(s.b2, result.commit), 'pushing the merge is a fast-forward of the bridge');
    });
    it('rebase gives the same ids when it runs again', async () => {
        const s = scenario();
        const side = { bridge: s.b2, local: s.l2 };
        const update = s.history.states[2].update;
        const one = rebase(s.local, s.l2, await startFromVersion(s.local, side, s.history, update));
        const two = rebase(s.local, s.l2, await startFromVersion(s.local, side, s.history, update));
        assert.strictEqual(one.start, two.start);
        assert.deepStrictEqual(one.map, two.map);
    });
    it('rebase from a bridge commit that has the first state, then merge where the tip holds the bridge\'s state', () => {
        const s = scenario();
        // a bridge with a first commit that holds exactly the local history's first state
        const bridge = newRepo(path.join(s.dir, 'bridge2'));
        const b1 = commit(bridge, { 'main.tex': 'main v2\n', 'notes.tex': 'notes v1\n', 'old.tex': 'old\n', 'chapter.tex': 'chapter\n', 'fig.png': Buffer.from([1, 2, 3]), 'logo.png': Buffer.from([5, 5]) }, 'Update on Overleaf.', s.t0 + 200);
        const b2 = commit(bridge, { 'main.tex': 'main v3\n', 'notes.tex': 'notes v2\n' }, 'Update on Overleaf.', s.t0 + 650);
        s.local.run(['remote', 'add', 'b2', bridge.dir]);
        s.local.run(['fetch', '--quiet', 'b2']);
        assert.strictEqual(bridgeCommitWithStart(s.local, { bridge: b2, local: s.l2 }), b1);
        const rebased = rebase(s.local, s.l2, { kind: 'commit', commit: b1 });
        assert.strictEqual(rebased.start, b1);
        assert.ok(!rebased.startMade);
        assert.strictEqual(rebased.map.length, 3);
        const rside = { bridge: b2, local: rebased.commit };
        const result = merge(s.local, rside, { start: rebased.start });
        assert.strictEqual(result.how, 'held');
        assert.strictEqual(result.heldAt, rebased.commit);
        assert.ok(checkResult(s.local, rside, result.commit, rebased.start).equal);
    });
    it('rebase, then merge at the tip where an earlier rebased commit holds the bridge\'s state: the later commits keep their rebased ids', async () => {
        const s = scenario();
        // a bridge that holds the state after l1 landed, and nothing else: Overleaf has no edits of its own
        const bridge = newRepo(path.join(s.dir, 'bridge3'));
        commit(bridge, { 'main.tex': 'main v1\n', 'fig.png': Buffer.from([1, 2, 3]), 'logo.png': Buffer.from([5, 5]) }, 'Update on Overleaf.', s.t0, 'Collaborator <c@example.com>');
        const b3 = commit(bridge, { 'main.tex': 'main v3\n', 'notes.tex': 'notes v1\n', 'old.tex': 'old\n', 'chapter.tex': 'chapter\n' }, 'Update on Overleaf.', s.t0 + 450);
        s.local.run(['remote', 'add', 'b3', bridge.dir]);
        s.local.run(['fetch', '--quiet', 'b3']);
        // after l1: a commit that changes only a test, so it too holds the bridge's state; then
        // the notes, and a commit that changes the line l1 changed (from the start, both sides changed it)
        s.local.run(['checkout', '--quiet', s.l1]);
        const l1b = commit(s.local, { 'tests/a.t': 'test a, changed\n' }, 'Change only a test', s.t0 + 460);
        commit(s.local, { 'notes.tex': 'notes v2\n' }, 'Change notes', s.t0 + 600);
        const l3 = commit(s.local, { 'main.tex': 'main v4\n' }, 'Change main again', s.t0 + 700);
        const history = new FakeHistory();
        history.states = s.history.states.slice(0, 4);  // up to l1's landing, which b3 holds
        const rebased = rebase(s.local, l3, await startFromVersion(s.local, { bridge: b3, local: l3 }, history, history.states[2].update));
        const ids = new Map(rebased.map);
        const result = merge(s.local, { bridge: b3, local: rebased.commit }, { start: rebased.start });
        assert.strictEqual(result.how, 'held');
        assert.strictEqual(result.heldAt, ids.get(l1b), 'the newest rebased commit that holds the bridge\'s state');
        assert.deepStrictEqual(s.local.commitInfo(result.commit).parents, [b3, rebased.commit], 'the merge sits at the tip; nothing is written again');
        assert.deepStrictEqual(result.carries.sort(), ['main.tex', 'notes.tex']);
        assert.strictEqual(show(s.local, result.commit, 'main.tex'), 'main v4');
        assert.strictEqual(show(s.local, result.commit, 'notes.tex'), 'notes v2');
        assert.strictEqual(show(s.local, result.commit, 'tests/a.t'), 'test a, changed');
        assert.ok(s.local.isAncestor(b3, result.commit), 'pushing the result is a fast-forward of the bridge');
    });
    it('rebase, then merge stops on a conflict between a local change and an edit on Overleaf', async () => {
        const s = scenario();
        s.local.run(['checkout', '--quiet', s.l2]);
        const l3 = commit(s.local, { 'main.tex': 'main, a local change Overleaf lacks\n' }, 'Local', s.t0 + 700);
        s.bridge.run(['checkout', '--quiet', 'master']);
        const b3 = commit(s.bridge, { 'main.tex': 'main, edited on Overleaf\n' }, 'Update on Overleaf.', s.t0 + 650);
        s.history.add(s.t0 + 650, f => { f.set('main.tex', doc('main, edited on Overleaf\n')); });
        s.local.run(['fetch', '--quiet', 'overleaf']);
        const start = await startFromVersion(s.local, { bridge: b3, local: l3 }, s.history, s.history.states[2].update);
        const rebased = rebase(s.local, l3, start);
        assert.throws(() => merge(s.local, { bridge: b3, local: rebased.commit }, { start: rebased.start }), (e: any) => e instanceof ConnectError && e.paths.join() === 'main.tex');
    });
});

describe('git bridge: the routine flow', () => {
    function connected() {
        const dir = tmp();
        const bare = newRepo(path.join(dir, 'bridge.git'), true);
        const seed = newRepo(path.join(dir, 'seed'));
        commit(seed, { 'main.tex': 'one\n', 'notes.tex': 'notes\n' }, 'Update on Overleaf.', T + 1000);
        seed.run(['push', '--quiet', bare.dir, 'master']);
        const work = new Repo(path.join(dir, 'work'));
        new Repo(dir).run(['clone', '--quiet', bare.dir, work.dir]);
        work.run(['config', 'user.name', 'Test User']); work.run(['config', 'user.email', 'test@example.com']);
        /** an edit on Overleaf: the bridge makes a commit of the project's state */
        const overleafEdit = (file: string, text: string) => {
            seed.run(['pull', '--quiet', '--ff-only', bare.dir, 'master']);
            commit(seed, { [file]: text }, 'Update on Overleaf.', T + 2000);
            seed.run(['push', '--quiet', bare.dir, 'master']);
        };
        return { bare, work, overleafEdit };
    }
    it('pushes our commit as a fast-forward, and merges an edit made on Overleaf between two of our commits', async () => {
        const { bare, work, overleafEdit } = connected();
        const c1 = commit(work, { 'main.tex': 'two\n' }, 'Ours 1', T + 1500);
        const r1 = await pushToBridge(work, 'origin');
        assert.ok(r1.pushed);
        assert.strictEqual(bare.mustCommit('master'), c1, 'the bridge keeps our commit id');
        overleafEdit('notes.tex', 'notes, edited on Overleaf\n');
        commit(work, { 'main.tex': 'three\n' }, 'Ours 2', T + 2500);
        const r2 = await pushToBridge(work, 'origin');
        assert.ok(r2.pushed);
        assert.strictEqual(r2.attempts[0].merge, 'merged');
        const head = work.commitInfo('HEAD');
        assert.strictEqual(head.parents.length, 2);
        assert.strictEqual(bare.mustCommit('master'), head.oid);
        assert.strictEqual(work.text(['show', 'HEAD:notes.tex']), 'notes, edited on Overleaf');
        assert.strictEqual(work.text(['show', 'HEAD:main.tex']), 'three');
    });
    it('fetches, merges and pushes again when the bridge refuses the push', async () => {
        const { bare, work, overleafEdit } = connected();
        commit(work, { 'main.tex': 'two\n' }, 'Ours', T + 1500);
        let checks = 0;
        const report = await pushToBridge(work, 'origin', { check: () => {
            if (checks++ === 0) { overleafEdit('notes.tex', 'edited between our fetch and our push\n'); }
            return { ok: true };
        } });
        assert.ok(report.pushed);
        assert.strictEqual(report.attempts.length, 2);
        assert.ok(report.attempts[0].refused, 'the first push was refused');
        assert.strictEqual(report.attempts[1].merge, 'merged');
        assert.strictEqual(bare.mustCommit('master'), work.mustCommit('HEAD'));
        assert.strictEqual(work.text(['show', 'HEAD:notes.tex']), 'edited between our fetch and our push');
    });
    it('does not push when the check refuses', async () => {
        const { bare, work } = connected();
        const before = bare.mustCommit('master');
        commit(work, { 'main.tex': 'two\n' }, 'Ours', T + 1500);
        await assert.rejects(pushToBridge(work, 'origin', { check: () => ({ ok: false, message: 'a comment would be lost' }) }), /a comment would be lost/);
        assert.strictEqual(bare.mustCommit('master'), before);
    });
    it('pull fast-forwards to an edit made on Overleaf', async () => {
        const { work, overleafEdit } = connected();
        overleafEdit('main.tex', 'edited\n');
        const { merge } = pullFromBridge(work, 'origin');
        assert.strictEqual(merge, 'fast-forward');
        assert.strictEqual(work.text(['show', 'HEAD:main.tex']), 'edited');
    });
});

describe('git bridge: the tree at a version', () => {
    it('reads only what changed after the version, and the zip only for binary files', async () => {
        const s = scenario();
        const result = await treeAtVersion(s.history, s.local, s.startV, s.lastV, s.local.flatTree(s.b2));
        assert.deepStrictEqual(result.read.sort(), ['main.tex', 'notes.tex', 'old.tex']);
        assert.deepStrictEqual(result.fromZip, ['fig.png'], 'logo.png is unchanged since the version, so it comes from the bridge');
        assert.ok(!s.history.docReads.includes(`chapter.tex@${s.startV}`), 'chapter.tex is unchanged since the version, so it comes from the bridge');
    });
});

describe('git bridge: the check of comments and tracked changes', () => {
    const f = (severity: 'info' | 'warn' | 'refuse') => ({ severity, path: 'main.tex', message: `a ${severity} finding` });
    it('stops the push on "refuse", even with --accept-warnings', () => {
        assert.strictEqual(answerFromFindings([f('info'), f('refuse')], 'summary', true).ok, false);
    });
    it('stops the push on "warn" unless the warnings are accepted', () => {
        const stopped = answerFromFindings([f('warn')], 'summary', false);
        assert.strictEqual(stopped.ok, false);
        assert.match(stopped.message!, /--accept-warnings/);
        assert.strictEqual(answerFromFindings([f('warn')], 'summary', true).ok, true);
    });
    it('lets the push go with findings of "info" only', () => {
        const answer = answerFromFindings([f('info')], 'summary', false);
        assert.strictEqual(answer.ok, true);
        assert.match(answer.message!, /a info finding/);
    });
});

describe('git bridge: connecting a development history with a local replica\'s repository', () => {
    /** The replica's repository: Overleaf's newest state of the scenario, as the replica recorded it, checked out. */
    function replicaOf(s: ReturnType<typeof scenario>) {
        const replica = newRepo(path.join(s.dir, 'replica'));
        const files = Object.fromEntries([...s.history.states[s.history.states.length - 1].files].map(([p, f]) => [p, f.content]));
        const recorded = commit(replica, files, `Overleaf version ${s.lastV}`, s.t0 + 650, 'Collaborator <c@example.com>');
        replica.run(['update-ref', 'refs/remotes/overleaf/main', recorded]);
        return { replica, recorded };
    }

    it('writes the history again from the version it started at and merges it with Overleaf\'s recorded state, without changing the development repository', async () => {
        const s = scenario();
        const { replica, recorded } = replicaOf(s);
        const devRefs = s.local.text(['for-each-ref', '--format=%(refname) %(objectname)']);
        const result = await connectReplica(replica, { historyRepo: s.local.dir, ref: 'master', history: s.history });
        assert.strictEqual(result.local, s.l2);
        assert.strictEqual(result.rebase!.map.length, 3);
        assert.ok(result.rebase!.startMade);
        const m = result.merge!;
        assert.strictEqual(m.how, 'three-way');
        assert.deepStrictEqual(m.own, ['tests/a.t']);
        assert.strictEqual(replica.mustCommit(CONNECT_REF), m.commit);
        assert.deepStrictEqual(replica.commitInfo(m.commit).parents, [recorded, result.rebase!.commit]);
        assert.deepStrictEqual([...replica.flatTree(m.commit).keys()].sort(), [...replica.flatTree(recorded).keys(), 'tests/a.t'].sort());
        assert.ok(replica.isAncestor('HEAD', m.commit), 'the connection lands as a fast-forward of the replica\'s branch');
        assert.strictEqual(s.local.text(['for-each-ref', '--format=%(refname) %(objectname)']), devRefs);

        // after the landing, a second run finds the connection in the branch
        replica.run(['merge', '--ff-only', '--quiet', m.commit]);
        replica.run(['update-ref', 'refs/remotes/overleaf/main', m.commit]);
        const again = await connectReplica(replica, { historyRepo: s.local.dir, ref: 'master', history: s.history });
        assert.strictEqual(again.already, result.rebase!.commit);
    });

    it('refuses a replica whose checked-out commit is not Overleaf\'s state', async () => {
        const s = scenario();
        const { replica } = replicaOf(s);
        commit(replica, { 'main.tex': 'a local change\n' }, 'Local', s.t0 + 700);
        await assert.rejects(connectReplica(replica, { historyRepo: s.local.dir, ref: 'master', history: s.history }), /is not the replica's checked-out commit/);
    });
});

describe('git bridge: joining the bridge\'s commits with a replica\'s', () => {
    const isProjectFile = (p: string) => !p.startsWith('.') && !p.endsWith('.aux');
    /** A replica whose branch and Overleaf's ref hold `files`, recorded at `seconds`; a bridge with its own history. */
    function setup(files: Record<string, string>, seconds: number) {
        const dir = tmp();
        const replica = newRepo(path.join(dir, 'replica'));
        const recorded = commit(replica, files, 'Overleaf version 7', seconds, 'Collaborator <c@example.com>');
        replica.run(['update-ref', 'refs/remotes/overleaf/main', recorded]);
        const bridge = newRepo(path.join(dir, 'bridge'));
        const fetchBridge = () => {
            replica.run(['fetch', '--quiet', bridge.dir, '+master:refs/remotes/bridge/master']);
            return 'refs/remotes/bridge/master';
        };
        return { replica, recorded, bridge, fetchBridge };
    }

    it('joins the bridge\'s commit for the replica\'s state with an anchor merge that keeps the tree', () => {
        const s = setup({ 'main.tex': 'v2\n', 'fig.png': 'png' }, T + 100);
        commit(s.bridge, { 'main.tex': 'v1\n', 'fig.png': 'png' }, 'Update on Overleaf.', T);
        // the bridge's tree also has a file that the replica leaves out
        const b = commit(s.bridge, { 'main.tex': 'v2\n', '.latexmkrc': 'x' }, 'Update on Overleaf.', T + 100);
        const result = anchorBridge(s.replica, s.fetchBridge(), isProjectFile);
        assert.strictEqual(result.outcome, 'anchored');
        assert.strictEqual(result.twin, s.recorded);
        const anchor = s.replica.mustCommit('HEAD');
        assert.strictEqual(result.commit, anchor);
        assert.deepStrictEqual(s.replica.commitInfo(anchor).parents, [s.recorded, b]);
        assert.strictEqual(s.replica.commitInfo(anchor).tree, s.replica.commitInfo(s.recorded).tree);
        assert.strictEqual(anchorBridge(s.replica, 'refs/remotes/bridge/master', isProjectFile).outcome, 'up-to-date');
    });

    it('joins a bridge commit for a state older than the replica\'s, and leaves one with newer changes', () => {
        const s = setup({ 'main.tex': 'v3\n' }, T + 300);
        // a state between two that the replica recorded together
        commit(s.bridge, { 'main.tex': 'v2\n' }, 'Update on Overleaf.', T + 200);
        assert.strictEqual(anchorBridge(s.replica, s.fetchBridge(), isProjectFile).outcome, 'anchored');
        const anchored = s.replica.mustCommit('HEAD');
        // an edit the replica has not seen yet
        commit(s.bridge, { 'main.tex': 'v4\n' }, 'Update on Overleaf.', T + 400);
        const result = anchorBridge(s.replica, s.fetchBridge(), isProjectFile);
        assert.strictEqual(result.outcome, 'newer');
        assert.strictEqual(s.replica.mustCommit('HEAD'), anchored);
    });

    it('leaves a branch alone that does not contain the replica\'s recorded state', () => {
        const s = setup({ 'main.tex': 'v2\n' }, T + 100);
        commit(s.bridge, { 'main.tex': 'v2\n' }, 'Update on Overleaf.', T + 100);
        const elsewhere = s.replica.commitTree(s.replica.commitInfo(s.recorded).tree, [], 'A state on another line', { person: 'X <x@example.com>', date: `${T} +0000` }, { person: 'X <x@example.com>', date: `${T} +0000` });
        s.replica.run(['update-ref', 'refs/remotes/overleaf/main', elsewhere]);
        assert.strictEqual(anchorBridge(s.replica, s.fetchBridge(), isProjectFile).outcome, 'diverged');
    });
});
