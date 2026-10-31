/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { attach, bridgeCommitWithStart, checkResult, ConnectError, ownFiles, rewrite, startFromVersion } from '../gitbridge/connect';
import { pullFromBridge, pushToBridge } from '../gitbridge/flow';
import { findStartVersion, HistorySource, HistoryUpdate, readZip, treeAtVersion, TreeChange, VersionEntry } from '../gitbridge/history';
import { answerFromFindings } from '../gitbridge/overleaf';
import { gitDate, Repo } from '../gitbridge/plumbing';

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
    it('attach keeps every local id, takes the bridge\'s tree and adds the repository\'s own files', () => {
        const s = scenario();
        const side = { bridge: s.b2, local: s.l2 };
        const own = ownFiles(s.local, side);
        assert.deepStrictEqual(own.own, ['tests/a.t']);
        assert.deepStrictEqual(own.deletedOnOverleaf, ['old.tex']);
        const result = attach(s.local, side);
        const info = s.local.commitInfo(result.commit);
        assert.deepStrictEqual(info.parents, [s.b2, s.l2]);
        const tree = s.local.flatTree(result.commit);
        assert.deepStrictEqual([...tree.keys()].sort(), ['chapter.tex', 'fig.png', 'logo.png', 'main.tex', 'new.png', 'notes.tex', 'tests/a.t']);
        assert.ok(checkResult(s.local, side, result.commit).equal);
        assert.ok(s.local.isAncestor(s.root, result.commit), 'the local history stays, with its ids');
    });
    it('attach refuses when a file differs, unless the bridge\'s version is taken', () => {
        const s = scenario();
        s.local.run(['checkout', '--quiet', s.l2]);
        const l3 = commit(s.local, { 'notes.tex': 'notes v3, not landed\n' }, 'Not landed', s.t0 + 700);
        assert.throws(() => attach(s.local, { bridge: s.b2, local: l3 }), (e: any) => e instanceof ConnectError && e.paths.join() === 'notes.tex');
        const result = attach(s.local, { bridge: s.b2, local: l3 }, { takeBridge: true });
        assert.deepStrictEqual(result.tookBridge, ['notes.tex']);
        assert.strictEqual(s.local.text(['show', `${result.commit}:notes.tex`]), 'notes v2');
    });
    it('rewrite from a version: makes the start from the history, keeps authors, dates and messages, and merges', async () => {
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
        const result = rewrite(s.local, side, start);
        // the start: the whole project at version 3, made as the repository's user
        const sInfo = s.local.commitInfo(result.start);
        assert.strictEqual(sInfo.author, 'Test User <test@example.com>');
        assert.strictEqual(sInfo.authorDate, gitDate(s.history.states[2].update.endTs));
        assert.deepStrictEqual(sInfo.parents, [s.b1]);
        assert.match(sInfo.message, /version 3/);
        assert.deepStrictEqual(Object.fromEntries([...s.local.flatTree(result.start)].map(([p, e]) => [p, s.local.run(['cat-file', 'blob', e.oid]).stdout.toString('latin1')])),
                               { 'chapter.tex': 'chapter\n', 'fig.png': '\x01\x02\x03', 'logo.png': '\x05\x05', 'main.tex': 'main v2\n', 'notes.tex': 'notes v1\n', 'old.tex': 'old\n' });
        // the rewritten commits
        assert.strictEqual(result.map.length, 3);
        const [, newL1] = result.map[1];
        const l1Info = s.local.commitInfo(s.l1), new1 = s.local.commitInfo(newL1);
        assert.strictEqual(new1.author, l1Info.author);
        assert.strictEqual(new1.authorDate, l1Info.authorDate);
        assert.strictEqual(new1.committerDate, l1Info.committerDate);
        assert.strictEqual(new1.message, `Change main\n\nCo-Authored-By: Someone <s@example.com>\nRewritten-from: ${s.l1}\n`);
        assert.strictEqual(s.local.text(['show', `${newL1}:fig.png`]).length, 3, 'whole trees: the image is there');
        // the merge: Overleaf's edits from the bridge, the own files from the local side
        const mInfo = s.local.commitInfo(result.commit);
        assert.deepStrictEqual(mInfo.parents, [s.b2, result.last]);
        assert.deepStrictEqual([...s.local.flatTree(result.commit).keys()].sort(), ['chapter.tex', 'fig.png', 'logo.png', 'main.tex', 'new.png', 'notes.tex', 'tests/a.t']);
        assert.ok(checkResult(s.local, side, result.commit).equal);
        assert.strictEqual(s.history.zips, 1);
    });
    it('rewrite gives the same ids when it runs again', async () => {
        const s = scenario();
        const side = { bridge: s.b2, local: s.l2 };
        const update = s.history.states[2].update;
        const one = rewrite(s.local, side, await startFromVersion(s.local, side, s.history, update));
        const two = rewrite(s.local, side, await startFromVersion(s.local, side, s.history, update));
        assert.strictEqual(one.start, two.start);
        assert.deepStrictEqual(one.map, two.map);
    });
    it('rewrite from a bridge commit that has the first state', () => {
        const s = scenario();
        // a bridge with a first commit that holds exactly the local history's first state
        const bridge = newRepo(path.join(s.dir, 'bridge2'));
        const b1 = commit(bridge, { 'main.tex': 'main v2\n', 'notes.tex': 'notes v1\n', 'old.tex': 'old\n', 'chapter.tex': 'chapter\n', 'fig.png': Buffer.from([1, 2, 3]), 'logo.png': Buffer.from([5, 5]) }, 'Update on Overleaf.', s.t0 + 200);
        const b2 = commit(bridge, { 'main.tex': 'main v3\n', 'notes.tex': 'notes v2\n' }, 'Update on Overleaf.', s.t0 + 650);
        s.local.run(['remote', 'add', 'b2', bridge.dir]);
        s.local.run(['fetch', '--quiet', 'b2']);
        const side = { bridge: b2, local: s.l2 };
        assert.strictEqual(bridgeCommitWithStart(s.local, side), b1);
        const result = rewrite(s.local, side, { kind: 'commit', commit: b1 });
        assert.strictEqual(result.start, b1);
        assert.strictEqual(result.map.length, 3);
        assert.ok(checkResult(s.local, side, result.commit).equal);
    });
    it('rewrite stops on a conflict between a local change and an edit on Overleaf', async () => {
        const s = scenario();
        s.local.run(['checkout', '--quiet', s.l2]);
        const l3 = commit(s.local, { 'main.tex': 'main, a local change Overleaf lacks\n' }, 'Local', s.t0 + 700);
        s.bridge.run(['checkout', '--quiet', 'master']);
        const b3 = commit(s.bridge, { 'main.tex': 'main, edited on Overleaf\n' }, 'Update on Overleaf.', s.t0 + 650);
        s.history.add(s.t0 + 650, f => { f.set('main.tex', doc('main, edited on Overleaf\n')); });
        s.local.run(['fetch', '--quiet', 'overleaf']);
        const side = { bridge: b3, local: l3 };
        const start = await startFromVersion(s.local, side, s.history, s.history.states[2].update);
        assert.throws(() => rewrite(s.local, side, start), (e: any) => e instanceof ConnectError && e.paths.join() === 'main.tex');
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
