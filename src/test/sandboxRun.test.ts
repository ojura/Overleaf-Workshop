/* eslint-disable @typescript-eslint/naming-convention -- Overleaf's field names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitBlobHash } from '../scm/replicaSync';
import { overleafText } from '../sandbox/plan';
import { SandboxSafetyError } from '../sandbox/guard';
import { LockTimeoutError } from '../sandbox/lock';
import { createSandbox, formatSandboxStatus, lockFile, readRecord, readReplica, recentRuns, recordFile, runCompile, RunOptions, sandboxStatus } from '../sandbox/sandbox';

const SHARED = '5a5a5a5a5a5a5a5a5a5a5a5a';
const USER = '5b5b5b5b5b5b5b5b5b5b5b5b';
let ids = 0;
const newId = () => (0x6a0000000000000000000000n + BigInt(++ids)).toString(16).padStart(24, '0');

interface Folder { _id: string, name: string, docs: any[], fileRefs: any[], folders: Folder[] }

/** One project in memory, with the fields that joinProject returns for it. */
class FakeProject {
    root: Folder = { _id: newId(), name: 'rootFolder', docs: [], fileRefs: [], folders: [] };
    texts = new Map<string, string>();
    bytes = new Map<string, Uint8Array>();
    compiler = 'pdflatex';
    imageName = 'texlive-full:2025.1';
    members: unknown[] = [];
    invites: unknown[] = [];
    publicAccesLevel = 'private';
    constructor(readonly _id: string, public name: string, public owner = USER) {}

    folder(p: string, create = true): Folder {
        let folder = this.root;
        for (const part of p.split('/').filter(Boolean)) {
            let sub = folder.folders.find(f => f.name === part);
            if (!sub) {
                if (!create) { throw new Error(`no folder ${p}`); }
                sub = { _id: newId(), name: part, docs: [], fileRefs: [], folders: [] };
                folder.folders.push(sub);
            }
            folder = sub;
        }
        return folder;
    }
    put(folder: Folder, name: string, content: Uint8Array, asDoc: boolean) {
        folder.docs = folder.docs.filter(d => d.name !== name);
        folder.fileRefs = folder.fileRefs.filter(f => f.name !== name);
        const id = newId();
        if (asDoc) {
            folder.docs.push({ _id: id, name });
            this.texts.set(id, overleafText(content)!);
            return { type: 'doc', id };
        }
        folder.fileRefs.push({ _id: id, name, hash: gitBlobHash(content), linkedFileData: null, created: '' });
        this.bytes.set(id, content);
        return { type: 'file', id };
    }
    doc(p: string, text: string) { this.put(this.folder(path.posix.dirname(p)), path.posix.basename(p), new TextEncoder().encode(text), true); return this; }
    file(p: string, content: string) { this.put(this.folder(path.posix.dirname(p)), path.posix.basename(p), new TextEncoder().encode(content), false); return this; }
    find(id: string, folder = this.root): Folder | undefined {
        if (folder._id === id) { return folder; }
        for (const sub of folder.folders) { const found = this.find(id, sub); if (found) { return found; } }
        return undefined;
    }
    view() {
        return {
            project: {
                _id: this._id, name: this.name, owner: { _id: this.owner }, members: this.members, invites: this.invites,
                publicAccesLevel: this.publicAccesLevel, compiler: this.compiler, imageName: this.imageName,
                rootFolder: [JSON.parse(JSON.stringify(this.root))], features: { compileTimeout: 240, compileGroup: 'priority' },
            },
            permissionsLevel: this.owner === USER ? 'owner' : 'readAndWrite',
        };
    }
    /** the content by path, text for documents */
    contents(): Record<string, string> {
        const result: Record<string, string> = {};
        const walk = (folder: Folder, prefix: string) => {
            folder.docs.forEach(d => { result[`${prefix}/${d.name}`] = this.texts.get(d._id)!; });
            folder.fileRefs.forEach(f => { result[`${prefix}/${f.name}`] = new TextDecoder().decode(this.bytes.get(f._id)); });
            folder.folders.forEach(sub => walk(sub, `${prefix}/${sub.name}`));
        };
        walk(this.root, '');
        return result;
    }
}

const TEXT_NAME = /\.(tex|txt|md|bib|bst)$|^latexmkrc$/;

/** Overleaf in memory: the shared project, the copies it clones, and every call made. */
class FakeServer {
    url = 'https://www.overleaf.com/';
    projects = new Map<string, FakeProject>();
    calls: string[] = [];
    failUpload?: string;
    compiled: Array<Record<string, string>> = [];
    constructor(readonly shared: FakeProject) { this.projects.set(shared._id, shared); }

    private project(id: string) { const p = this.projects.get(id); if (!p) { throw new Error(`no project ${id}`); } return p; }
    private write(projectId: string, call: string) {
        this.calls.push(`${call} ${projectId}`);
        if (projectId === this.shared._id) { throw new Error(`TEST FAILURE: ${call} sent to the shared project`); }
        return this.project(projectId);
    }
    async join(projectId: string) { this.calls.push(`join ${projectId}`); return this.project(projectId).view() as any; }
    async docText(projectId: string, docId: string) { this.calls.push(`docText ${projectId}`); return this.project(projectId).texts.get(docId)!; }
    async fileContent(projectId: string, fileId: string) { this.calls.push(`fileContent ${projectId}`); return this.project(projectId).bytes.get(fileId)!; }
    async outputFile(file: any) { return new TextEncoder().encode(`content of ${file.path}`); }
    async clone(projectId: string, name: string) {
        this.calls.push(`clone ${projectId}`);
        const source = this.project(projectId);
        const copy = new FakeProject(newId(), name);
        copy.imageName = 'texlive-full:2026.1'; // a clone gets the current default image
        copy.root = JSON.parse(JSON.stringify(source.root));
        source.texts.forEach((t, id) => copy.texts.set(id, t));
        source.bytes.forEach((b, id) => copy.bytes.set(id, b));
        this.projects.set(copy._id, copy);
        return copy._id;
    }
    async upload(projectId: string, folderId: string, name: string, content: Uint8Array) {
        const project = this.write(projectId, `upload ${name}`);
        if (name === this.failUpload) { throw new Error('HTTP 500'); }
        return project.put(project.find(folderId)!, name, content, TEXT_NAME.test(name) && overleafText(content) !== undefined);
    }
    async addFolder(projectId: string, parentFolderId: string, name: string) {
        const project = this.write(projectId, `addFolder ${name}`);
        const folder: Folder = { _id: newId(), name, docs: [], fileRefs: [], folders: [] };
        project.find(parentFolderId)!.folders.push(folder);
        return { id: folder._id };
    }
    async remove(projectId: string, type: string, id: string) {
        const project = this.write(projectId, `remove ${type}`);
        const walk = (folder: Folder) => {
            folder.docs = folder.docs.filter(d => d._id !== id);
            folder.fileRefs = folder.fileRefs.filter(f => f._id !== id);
            folder.folders = folder.folders.filter(f => f._id !== id);
            folder.folders.forEach(walk);
        };
        walk(project.root);
    }
    async updateSettings(projectId: string, settings: any) {
        const project = this.write(projectId, `settings ${JSON.stringify(settings)}`);
        Object.assign(project, settings);
    }
    async clearOutput(projectId: string) { this.write(projectId, 'clearOutput'); }
    async compile(projectId: string, request: any) {
        const project = this.write(projectId, `compile ${request.rootResourcePath}`);
        this.compiled.push(project.contents());
        return {
            response: {
                status: 'success', compileGroup: 'priority', clsiServerId: 'clsi-1',
                timings: { sync: 10, compile: 1000, output: 5, compileE2E: 1100 },
                outputFiles: ['output.log', 'output.pdf', 'output.ilg', '../escape'].map(p => ({ path: p, url: `/build/1/output/${p}`, type: p.split('.').pop(), build: '1' })),
            },
        };
    }
    writes() { return this.calls.filter(c => !/^(join|docText|fileContent) /.test(c)); }
}

describe('a sandbox run', () => {
    let tmp: string;
    let replica: string;
    let dir: string;
    let server: FakeServer;
    const log = () => {};

    const options = (changes: Partial<RunOptions> = {}): RunOptions => ({
        dir, main: 'main.tex', out: path.join(tmp, 'out'), mirror: false, keep: [], ignore: [], include: [],
        incremental: false, draft: false, stopOnFirstError: false, pdf: true, dryRun: false, lockTimeoutMs: 0,
        purpose: 'test', ...changes,
    });
    const write = (p: string, content: string) => {
        fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
        fs.writeFileSync(path.join(dir, p), content);
    };

    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-run-test-'));
        replica = path.join(tmp, 'replica');
        dir = path.join(tmp, 'version');
        fs.mkdirSync(path.join(replica, '.overleaf'), { recursive: true });
        fs.writeFileSync(path.join(replica, '.overleaf', 'settings.json'), JSON.stringify({
            uri: `overleaf-workshop://www.overleaf.com/Book?user%3D${USER}%26project%3D${SHARED}`,
            serverName: 'www.overleaf.com', enableCompileNPreview: false, projectName: 'Book',
        }));
        const shared = new FakeProject(SHARED, 'Book');
        shared.members = [{ _id: 'collaborator' }];
        shared.publicAccesLevel = 'tokenBased';
        shared.doc('/main.tex', 'book').doc('/latexmkrc', 'old rc').file('/autoindex.pl', 'old script').file('/slike/a.jpg', 'photo a');
        server = new FakeServer(shared);
        await createSandbox(server as any, readReplica(replica), USER, 'Book (sandbox)', log);
        fs.mkdirSync(dir);
        write('main.tex', 'book');
        write('latexmkrc', 'new rc');
        write('autoindex.pl', 'new script');
        write('index-terms.txt', 'terms');
        write('main.aux', 'a local build product');
        write('.git/HEAD', 'ref');
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('says in the status why it could not join the copy or the shared project, with the cause that fetch reports', async () => {
        // what Node's fetch throws when it cannot reach the server: the reason is in the cause
        server.join = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') }); };
        const status = await sandboxStatus(server as any, readReplica(replica), USER);
        if (!status.record) { assert.fail('the sandbox is recorded'); }
        const text = formatSandboxStatus(status, [], '/r/.overleaf/sandbox-runs.jsonl');
        assert.match(text, /^could not join the copy: fetch failed: connect ECONNREFUSED 127\.0\.0\.1:443$/m);
        assert.match(text, /^could not join the shared project: fetch failed: connect ECONNREFUSED 127\.0\.0\.1:443$/m);
    });

    it('writes the status: the copy and the shared project as joined, the safety checks, the lock and the latest runs', async () => {
        const status = await sandboxStatus(server as any, readReplica(replica), USER);
        if (!status.record) { assert.fail('the sandbox is recorded'); }
        const runs = [{ event: 'start', at: '2026-11-01T05:00:00Z', pid: 7, purpose: 'a test', dir: '/v', main: 'main.tex' }];
        const lines = formatSandboxStatus(status, runs, '/r/.overleaf/sandbox-runs.jsonl').split('\n');
        assert.match(lines[0], /^sandbox: "Book \(sandbox\)", \S+\/project\/[0-9a-f]{24}, created \S+$/);
        // the fake projects name no main document (rootDoc_id)
        assert.deepStrictEqual(lines.slice(1), [
            'copy: compiler pdflatex, image texlive-full:2025.1, main document undefined, compile timeout 240 s, compile group priority',
            'shared project: compiler pdflatex, image texlive-full:2025.1, main document undefined',
            'safety checks pass: owned by this account, no collaborators, no invites, link sharing off',
            'lock: free',
            'latest runs (from /r/.overleaf/sandbox-runs.jsonl):',
            '  2026-11-01T05:00:00Z pid 7 started: a test (/v, main.tex)',
        ]);
    });

    it('is created by cloning, with the shared project\'s TeX Live image, and recorded', () => {
        const record = readRecord(replica)!;
        assert.strictEqual(record.source.projectId, SHARED);
        assert.notStrictEqual(record.projectId, SHARED);
        assert.strictEqual(server.projects.get(record.projectId)!.imageName, 'texlive-full:2025.1');
        assert.deepStrictEqual(server.writes(), [`clone ${SHARED}`, `settings {"imageName":"texlive-full:2025.1"} ${record.projectId}`]);
    });

    it('is not created twice', async () => {
        await assert.rejects(createSandbox(server as any, readReplica(replica), USER, 'Book (sandbox)', log), /already records a sandbox/);
    });

    it('uploads what differs, compiles the directory over the shared project and saves the results', async () => {
        const copyId = readRecord(replica)!.projectId;
        const before = server.calls.length;
        const result = await runCompile(server as any, readReplica(replica), USER, options(), log);
        const calls = server.calls.slice(before);
        assert.strictEqual(result.status, 'success');
        assert.deepStrictEqual(server.compiled.at(-1), {
            '/main.tex': 'book', '/latexmkrc': 'new rc', '/autoindex.pl': 'new script', '/index-terms.txt': 'terms', '/slike/a.jpg': 'photo a',
        });
        // every write went to the copy, right after a join of the copy
        const writeCalls = calls.filter(c => !/^(join|docText|fileContent) /.test(c));
        assert.deepStrictEqual(writeCalls.map(c => c.replace(` ${copyId}`, '')).sort(), [
            'clearOutput', 'compile main.tex', 'upload autoindex.pl', 'upload index-terms.txt', 'upload latexmkrc',
        ]);
        calls.forEach((call, i) => {
            if (writeCalls.includes(call)) { assert.strictEqual(calls[i - 1], `join ${copyId}`, `${call} follows ${calls[i - 1]}`); }
        });
        assert.ok(calls.every(c => !c.endsWith(SHARED) || /^(join|docText|fileContent) /.test(c)), 'the shared project is only read');
        // results
        const out = path.join(tmp, 'out');
        assert.deepStrictEqual(fs.readdirSync(out).sort(), ['compile-response.json', 'output.ilg', 'output.log', 'output.pdf', 'run.json']);
        const summary = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
        assert.strictEqual(summary.compile.status, 'success');
        assert.deepStrictEqual(summary.outputs.failed.map((f: any) => f.path), ['../escape']);
        assert.deepStrictEqual(summary.local.ignored, ['/.git', '/main.aux']);
        assert.deepStrictEqual(summary.uploaded.map((u: any) => [u.path, u.inCopy]).sort(),
            [['/autoindex.pl', 'same hash'], ['/index-terms.txt', 'document'], ['/latexmkrc', 'document']]);
        assert.strictEqual(fs.existsSync(lockFile(replica)), false);
        const runs = recentRuns(replica, 10);
        assert.deepStrictEqual(runs.map(r => r.event), ['created', 'start', 'end']);
        assert.strictEqual(runs[1].purpose, 'test');
        assert.strictEqual(runs[2].status, 'success');
        assert.deepStrictEqual(runs[2].uploaded, ['/autoindex.pl', '/index-terms.txt', '/latexmkrc']);
    });

    it('uploads nothing the next time, and restores the shared version of a file the directory drops', async () => {
        const copyId = readRecord(replica)!.projectId;
        await runCompile(server as any, readReplica(replica), USER, options(), log);
        fs.rmSync(path.join(dir, 'latexmkrc'));
        fs.rmSync(path.join(dir, 'index-terms.txt'));
        const before = server.calls.length;
        await runCompile(server as any, readReplica(replica), USER, options(), log);
        const writes = server.calls.slice(before).filter(c => !/^(join|docText|fileContent) /.test(c))
            .map(c => c.replace(` ${copyId}`, '').replace(/^remove doc .*/, 'remove doc'));
        assert.deepStrictEqual(writes.sort(), ['clearOutput', 'compile main.tex', 'remove doc', 'upload latexmkrc']);
        assert.deepStrictEqual(server.compiled.at(-1), { '/main.tex': 'book', '/latexmkrc': 'old rc', '/autoindex.pl': 'new script', '/slike/a.jpg': 'photo a' });
    });

    it('writes nothing in a dry run, and takes no lock', async () => {
        const before = server.calls.length;
        const result = await runCompile(server as any, readReplica(replica), USER, options({ dryRun: true }), log);
        assert.deepStrictEqual(server.calls.slice(before).filter(c => !/^(join|docText|fileContent) /.test(c)), []);
        assert.strictEqual(result.summary.plan.uploads.length, 3);
    });

    it('refuses to run when the record names the shared project, and writes nothing', async () => {
        const record = readRecord(replica)!;
        fs.writeFileSync(recordFile(replica), JSON.stringify({ ...record, projectId: SHARED }));
        const before = server.calls.length;
        await assert.rejects(runCompile(server as any, readReplica(replica), USER, options(), log), SandboxSafetyError);
        assert.deepStrictEqual(server.calls.slice(before), []);
    });

    it('stops before any write when the copy has been shared', async () => {
        const copy = server.projects.get(readRecord(replica)!.projectId)!;
        copy.invites = [{ email: 'someone@example.com' }];
        const before = server.calls.length;
        await assert.rejects(runCompile(server as any, readReplica(replica), USER, options(), log), /1 pending invites/);
        assert.deepStrictEqual(server.calls.slice(before).filter(c => !/^(join|docText|fileContent) /.test(c)), []);
    });

    it('does not compile when an upload fails, and says what happened in run.json', async () => {
        server.failUpload = 'latexmkrc';
        await assert.rejects(runCompile(server as any, readReplica(replica), USER, options(), log), /HTTP 500/);
        assert.ok(!server.calls.some(c => c.startsWith('compile ')));
        const summary = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'run.json'), 'utf8'));
        assert.match(summary.error, /HTTP 500/);
        assert.strictEqual(fs.existsSync(lockFile(replica)), false);
    });

    it('waits for the lock, and with timeout 0 fails before any write while another run holds it', async () => {
        fs.writeFileSync(lockFile(replica), JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: '', purpose: 'another agent', token: 'x' }));
        const before = server.calls.length;
        await assert.rejects(runCompile(server as any, readReplica(replica), USER, options(), log), LockTimeoutError);
        assert.deepStrictEqual(server.calls.slice(before), []);
    });

    it('does not upload the results of an earlier run kept inside the directory', async () => {
        const inside = options({ out: path.join(dir, 'results') });
        await runCompile(server as any, readReplica(replica), USER, inside, log);
        const result = await runCompile(server as any, readReplica(replica), USER, inside, log);
        assert.deepStrictEqual(result.summary.plan.uploads, []);
        assert.ok(result.summary.local.ignored.includes('/results'));
    });

    it('refuses an output folder that holds something else', async () => {
        fs.mkdirSync(path.join(tmp, 'out'));
        fs.writeFileSync(path.join(tmp, 'out', 'thesis.tex'), 'not ours');
        await assert.rejects(runCompile(server as any, readReplica(replica), USER, options(), log), /not empty/);
        assert.strictEqual(fs.readFileSync(path.join(tmp, 'out', 'thesis.tex'), 'utf8'), 'not ours');
    });
});
