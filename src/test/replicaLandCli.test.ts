/* eslint-disable @typescript-eslint/naming-convention -- file paths and Overleaf's field names as keys */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CompileRequest } from '../api/base';
import { Repo } from '../gitbridge/plumbing';
import { checkBuild } from '../sandbox/buildCheck';
import { AskWindow, fetchCommitFrom, LandClient, LandError, landCommit, landedCleanly } from '../sandbox/land';
import { ReplicaControlServer, ReplicaSyncIgnore, replicaSocketPath, requestReplica } from '../scm/replicaControl';
import { DEFAULT_IGNORE_PATTERNS, IgnoreMatcher, isReplicaOwnPath } from '../scm/ignorePatterns';
import { SHORT_TEMP } from './replicaTestWorld';

const OVERLEAF_REF = 'refs/remotes/overleaf/main';

function git(dir: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (result.status !== 0) { throw new Error(`git ${args.join(' ')}: ${result.stderr}`); }
    return result.stdout.trim();
}

const LOG_OK = 'This is pdfTeX\nLaTeX Warning: Reference `a\' on page 3 undefined on input line 12.\nLaTeX Warning: Reference `b\' on page 4 undefined on input line 40.\nOutput written on output.pdf (812 pages, 123 bytes).\n';

/** A project on Overleaf in memory, as joinProject and joinDoc show it, with a compile. */
class Overleaf implements LandClient {
    docs = new Map<string, string>();
    files = new Map<string, string>();
    reads = 0;
    compiles: string[] = [];
    /** the main document's ID that each compile named */
    rootDocIds: Array<string | undefined> = [];
    /** what the next compiles answer, first to last; then "success" */
    statuses: string[] = [];
    outputs: Record<string, string> = { 'output.log': LOG_OK, 'output.stdout': 'Latexmk: All targets are up-to-date\n', 'output.aux': '\\relax\n', 'output.pdf': '%PDF' };
    /** run before each read of the project, e.g. to let a push arrive late */
    beforeRead?: () => void;

    async readProject(projectId: string) {
        this.beforeRead?.();
        this.reads += 1;
        const root: any = { _id: 'root', name: 'rootFolder', docs: [], fileRefs: [], folders: [] };
        const folderOf = (p: string) => {
            let folder = root;
            for (const name of p.split('/').slice(0, -1)) {
                let sub = folder.folders.find((f: any) => f.name === name);
                if (!sub) { sub = { _id: name, name, docs: [], fileRefs: [], folders: [] }; folder.folders.push(sub); }
                folder = sub;
            }
            return folder;
        };
        for (const p of this.docs.keys()) { folderOf(p).docs.push({ _id: `doc-${p}`, name: p.split('/').pop() }); }
        for (const [p, hash] of this.files) { folderOf(p).fileRefs.push({ _id: `file-${p}`, name: p.split('/').pop(), hash }); }
        return {
            joined: { project: { _id: projectId, name: 'Book', rootFolder: [root], rootDoc_id: 'doc-main.tex', owner: {}, members: [], invites: [] }, permissionsLevel: 'owner' } as any,
            ranges: { projectId, docs: [...this.docs].map(([p, text]) => ({ path: p, docId: `doc-${p}`, text, comments: [], changes: [] })), trackChanges: false, users: {} },
        };
    }
    async compile(_projectId: string, request: CompileRequest) {
        this.compiles.push(request.rootResourcePath!);
        this.rootDocIds.push(request.rootDocId);
        const status = this.statuses.shift() ?? 'success';
        return { response: { status, outputFiles: Object.keys(this.outputs).map(p => ({ path: p, url: `/build/${p}`, type: p.split('.').pop(), build: 'b' })) } } as any;
    }
    async outputFile(file: { path: string }) { return new TextEncoder().encode(this.outputs[file.path]); }
}

describe('replica-land', function () {
    this.timeout(20000);
    let scratch: string;
    beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-land-cli-')); });
    afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

    /** A replica with Overleaf's state in its repository, an IDE window that pushes as the extension does, and Overleaf. */
    function setup() {
        const folder = path.join(scratch, 'replica');
        fs.mkdirSync(folder);
        git(folder, 'init', '--quiet', '--initial-branch=main');
        git(folder, 'config', 'user.name', 'Local User');
        git(folder, 'config', 'user.email', 'local@example.com');
        fs.writeFileSync(path.join(folder, 'main.tex'), 'main v1\n');
        fs.mkdirSync(path.join(folder, 'slike'));
        fs.writeFileSync(path.join(folder, 'slike', 'a.png'), 'PNG');
        fs.writeFileSync(path.join(folder, 'main.aux'), 'a build product, left out');
        git(folder, 'add', 'main.tex', 'slike/a.png');
        git(folder, 'commit', '--quiet', '-m', 'Overleaf\'s state');
        const head = git(folder, 'rev-parse', 'HEAD');
        git(folder, 'update-ref', OVERLEAF_REF, head);
        const overleaf = new Overleaf();
        overleaf.docs.set('main.tex', 'main v1\n');
        overleaf.files.set('slike/a.png', git(folder, 'rev-parse', 'HEAD:slike/a.png'));
        const asked: string[] = [];
        const window: { connected: boolean, pushLater: boolean, push: string, syncIgnore?: ReplicaSyncIgnore,
            afterMerge?: () => void, skipped: Set<string> } = {
            connected: true, pushLater: false, push: 'native', skipped: new Set(),
        };
        const ask: AskWindow = async (request) => {
            asked.push(request.op === 'land' ? `land ${request.commit.slice(0, 7)}` : request.op);
            const state = () => ({ head: git(folder, 'rev-parse', 'HEAD'), overleaf: git(folder, 'rev-parse', OVERLEAF_REF), branch: 'main', unmerged: [] });
            if (request.op === 'sync') { return { ok: true, connected: window.connected, modes: { fetch: 'native', push: window.push }, git: state(), syncIgnore: window.syncIgnore }; }
            if (request.op === 'land') {
                git(folder, 'merge', '--ff-only', '--quiet', request.commit);
                window.afterMerge?.();
                const apply = () => {
                    for (const p of git(folder, 'diff', '--name-only', head, request.commit).split('\n').filter(Boolean)) {
                        if (window.skipped.has(p)) { continue; }
                        const exists = fs.existsSync(path.join(folder, p));
                        if (!exists) { overleaf.docs.delete(p); overleaf.files.delete(p); continue; }
                        if (p.endsWith('.png')) { overleaf.files.set(p, git(folder, 'rev-parse', `${request.commit}:${p}`)); } else { overleaf.docs.set(p, fs.readFileSync(path.join(folder, p), 'utf8')); }
                    }
                };
                if (window.pushLater) { overleaf.beforeRead = () => { if (overleaf.reads >= 2) { apply(); } }; } else { apply(); }
                git(folder, 'update-ref', OVERLEAF_REF, request.commit);
                return { ok: true, landed: request.commit, overleaf: request.commit, summary: { uploaded: ['/main.tex'], renamed: [] }, syncIgnore: window.syncIgnore };
            }
            return { ok: true, git: state() };
        };
        const commit = (files: Record<string, string | undefined>, message: string) => {
            const index = path.join(scratch, 'index');
            const env = { ...process.env, GIT_INDEX_FILE: index };
            const run = (args: string[], input?: string) => {
                const r = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', env, input });
                if (r.status !== 0) { throw new Error(r.stderr); }
                return r.stdout.trim();
            };
            run(['read-tree', 'HEAD']);
            for (const [p, content] of Object.entries(files)) {
                if (content === undefined) { run(['update-index', '--force-remove', '--', p]); continue; }
                run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], content)},${p}`]);
            }
            const tree = run(['write-tree']);
            fs.rmSync(index, { force: true });
            return run(['commit-tree', tree, '-p', 'HEAD', '-m', message]);
        };
        const defaults = new IgnoreMatcher();
        const options = {
            folder, projectId: 'p'.repeat(24), windowTimeoutMs: 1000, verifyIntervalMs: 1, sleep: async () => {},
            isIgnored: (p: string) => isReplicaOwnPath(p) || defaults.matches(DEFAULT_IGNORE_PATTERNS, p), log: () => {},
        };
        return { folder, head, overleaf, ask, asked, window, commit, options, repo: new Repo(folder) };
    }

    it('lands a commit: the window pushes it, Overleaf holds it, the project compiles without errors, and the project\'s check runs', async () => {
        const t = setup();
        const commit = t.commit({ 'main.tex': 'main v2\n', 'tests/01.t': 'ok\n' }, 'A book commit');
        git(t.folder, 'config', 'overleaf.landCheck', 'printf "%s %s %s %s" "$OVERLEAF_COMMIT" "$OVERLEAF_PARENT" "$(basename "$OVERLEAF_COMPILE")" "$(basename "$OVERLEAF_PARENT_COMPILE")"');
        const report = await landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit });
        assert.deepStrictEqual(t.asked, ['sync', `land ${commit.slice(0, 7)}`]);
        assert.strictEqual(report.pushed, true);
        assert.strictEqual(report.overleaf, commit);
        assert.strictEqual(report.verified, 3);
        // the parent was compiled first, for the check to compare with
        assert.deepStrictEqual(t.overleaf.compiles, ['main.tex', 'main.tex']);
        // by ID too: without it Overleaf compiles the project's main document whatever the path says
        assert.deepStrictEqual(t.overleaf.rootDocIds, ['doc-main.tex', 'doc-main.tex']);
        assert.strictEqual(report.parentCompile?.status, 'success');
        assert.strictEqual(report.compile?.status, 'success');
        assert.strictEqual(report.compile?.check?.ok, true);
        assert.strictEqual(report.compile?.check?.pages, 812);
        const gitDir = path.join(t.folder, '.git');
        assert.ok(fs.existsSync(path.join(gitDir, 'overleaf', 'compiles', commit, 'output.log')));
        assert.ok(!fs.existsSync(path.join(gitDir, 'overleaf', 'compiles', commit, 'output.pdf')));
        assert.strictEqual(report.hook?.output, `${commit} ${t.head} ${commit} ${t.head}`);
        assert.strictEqual(landedCleanly(report), true);
        assert.match(fs.readFileSync(path.join(gitDir, 'overleaf', 'landings.log'), 'utf8'), new RegExp(`${commit} parent ${t.head} pushed, compile success, no errors, landCheck exit 0`));
    });

    it('waits until Overleaf shows the pushed commit', async () => {
        const t = setup();
        t.window.pushLater = true;
        const commit = t.commit({ 'main.tex': 'main v2\n' }, 'Late');
        const report = await landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit, compile: false });
        assert.strictEqual(report.verified, 2);
        assert.ok(t.overleaf.reads >= 3);
    });

    it('uses the replica patterns returned through its control socket', async () => {
        const t = setup();
        t.window.syncIgnore = { patterns: ['/local-only.txt'], respectGitignore: false };
        t.window.skipped.add('local-only.txt');
        const commit = t.commit({ 'main.tex': 'main v2\n', 'local-only.txt': 'local material\n' }, 'Filtered');
        const saved = process.env.XDG_RUNTIME_DIR;
        const runtime = fs.mkdtempSync(path.join(SHORT_TEMP, 'owr-'));
        process.env.XDG_RUNTIME_DIR = runtime;
        const server = new ReplicaControlServer(t.folder, request => t.ask(request, 1000), () => {});
        try {
            assert.ok(await server.start());
            const ask: AskWindow = (request, timeout) => requestReplica(t.folder, request, timeout);
            const report = await landCommit(t.repo, t.overleaf, ask, { ...t.options, commit, compile: false, verifyTimeoutMs: -1 });
            assert.strictEqual(report.verified, 2);
            assert.strictEqual(t.overleaf.docs.has('local-only.txt'), false);
            assert.deepStrictEqual(t.asked, ['sync', 'land ' + commit.slice(0, 7)]);
        } finally {
            server.dispose();
            if (saved === undefined) { delete process.env.XDG_RUNTIME_DIR; } else { process.env.XDG_RUNTIME_DIR = saved; }
            fs.rmSync(runtime, { recursive: true, force: true });
        }
    });

    it('replaces default patterns with the reported per-replica patterns', async () => {
        const t = setup();
        t.window.syncIgnore = { patterns: [], respectGitignore: false };
        git(t.folder, 'add', '-f', 'main.aux');
        git(t.folder, 'commit', '--quiet', '-m', 'Tracked auxiliary file');
        git(t.folder, 'update-ref', OVERLEAF_REF, 'HEAD');
        await assert.rejects(landCommit(t.repo, t.overleaf, t.ask, { ...t.options, compile: false }),
            (error: any) => error instanceof LandError && error.details.includes('main.aux: not on Overleaf'));
        assert.deepStrictEqual(t.asked, ['sync']);
    });

    it('reads the landed commit\'s gitignore before comparing a tracked archive', async () => {
        const t = setup();
        t.window.syncIgnore = { patterns: [...DEFAULT_IGNORE_PATTERNS], respectGitignore: true };
        t.window.skipped.add('.gitignore');
        t.window.skipped.add('assets/bundle.tar.gz');
        const commit = t.commit({ '.gitignore': 'assets/*.tar.gz\n', 'assets/bundle.tar.gz': 'archive bytes\n' }, 'Ignored archive');
        const report = await landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit, compile: false, verifyTimeoutMs: -1 });
        assert.strictEqual(report.verified, 2);
        assert.ok(t.repo.flatTree(commit).has('assets/bundle.tar.gz'), 'the archive belongs to the commit');
        assert.strictEqual(t.overleaf.docs.has('assets/bundle.tar.gz'), false);
    });

    it('compares a newly included file when the landed commit removes gitignore', async () => {
        const t = setup();
        t.window.syncIgnore = { patterns: [...DEFAULT_IGNORE_PATTERNS], respectGitignore: true };
        const base = t.commit({ '.gitignore': '*.tar.gz\n', 'bundle.tar.gz': 'archive bytes\n' }, 'Local archive');
        git(t.folder, 'merge', '--ff-only', '--quiet', base);
        git(t.folder, 'update-ref', OVERLEAF_REF, base);
        t.window.skipped.add('.gitignore');
        t.window.skipped.add('bundle.tar.gz');
        const commit = t.commit({ '.gitignore': undefined }, 'Include the archive');
        await assert.rejects(landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit, compile: false, verifyTimeoutMs: -1 }),
            (error: any) => error instanceof LandError && /still differs/.test(error.message)
                && error.details.includes('bundle.tar.gz: not on Overleaf'));
        assert.deepStrictEqual(t.asked, ['sync', 'land ' + commit.slice(0, 7)]);
    });

    it('refreshes local gitignore before each final comparison', async () => {
        const t = setup();
        t.window.syncIgnore = { patterns: [...DEFAULT_IGNORE_PATTERNS], respectGitignore: true };
        t.window.skipped.add('bundle.tar.gz');
        const commit = t.commit({ 'bundle.tar.gz': 'archive bytes\n' }, 'Archive awaiting a rule');
        let comparisons = 0;
        const report = await landCommit(t.repo, t.overleaf, t.ask, {
            ...t.options, commit, compile: false,
            sleep: async () => {
                assert.strictEqual(comparisons++, 0, 'the next comparison must use the new rule');
                fs.writeFileSync(path.join(t.folder, '.gitignore'), '*.tar.gz\n');
            },
        });
        assert.strictEqual(comparisons, 1);
        assert.strictEqual(report.verified, 2);
        assert.strictEqual(t.overleaf.reads, 3);
    });

    it('uses the selection reported after the window finishes landing', async () => {
        const t = setup();
        t.window.syncIgnore = { patterns: [...DEFAULT_IGNORE_PATTERNS], respectGitignore: true };
        t.window.afterMerge = () => { t.window.syncIgnore = { patterns: ['/local-only.txt'], respectGitignore: false }; };
        t.window.skipped.add('local-only.txt');
        const commit = t.commit({ 'local-only.txt': 'local material\n' }, 'Updated selection');
        const report = await landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit, compile: false, verifyTimeoutMs: -1 });
        assert.strictEqual(report.verified, 2);
    });

    for (const respectGitignore of [false, undefined]) {
        it(respectGitignore === false ? 'compares gitignored files when that replica disables gitignore'
            : 'retains the previous comparison selection for a host without syncIgnore', async () => {
            const t = setup();
            if (respectGitignore !== undefined) {
                t.window.syncIgnore = { patterns: [...DEFAULT_IGNORE_PATTERNS], respectGitignore };
            }
            fs.writeFileSync(path.join(t.folder, '.gitignore'), '*.tar.gz\n');
            const base = t.commit({ 'bundle.tar.gz': 'archive bytes\n' }, 'Tracked archive');
            git(t.folder, 'merge', '--ff-only', '--quiet', base);
            git(t.folder, 'update-ref', OVERLEAF_REF, base);
            await assert.rejects(landCommit(t.repo, t.overleaf, t.ask, { ...t.options, compile: false }),
                (error: any) => error instanceof LandError && error.details.includes('bundle.tar.gz: not on Overleaf'));
            assert.deepStrictEqual(t.asked, ['sync']);
        });
    }

    it('stops before pushing when Overleaf does not hold the parent, and says which files differ', async () => {
        const t = setup();
        t.overleaf.docs.set('main.tex', 'edited on Overleaf, not synced yet\n');
        const commit = t.commit({ 'main.tex': 'main v2\n' }, 'Late');
        await assert.rejects(landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit }), (error: any) =>
            error instanceof LandError && /does not hold/.test(error.message) && error.details[0] === 'main.tex: the document on Overleaf differs');
        assert.deepStrictEqual(t.asked, ['sync']);
    });

    it('stops when Overleaf\'s state is not the checked-out commit, or the commit does not descend from it', async () => {
        const t = setup();
        const sibling = t.commit({ 'main.tex': 'main v2\n' }, 'One');
        git(t.folder, 'commit', '--quiet', '--allow-empty', '-m', 'local, not on Overleaf');
        await assert.rejects(landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit: sibling }), /is not the checked-out commit/);
        git(t.folder, 'update-ref', OVERLEAF_REF, 'HEAD');
        await assert.rejects(landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit: sibling }), /does not descend from Overleaf's state .*; merge that state into it first \(git pull --no-rebase/);
    });

    it('compiles again while another compile runs, and fails the landing on a LaTeX error', async () => {
        const t = setup();
        t.overleaf.statuses = ['compile-in-progress', 'compile-in-progress'];
        t.overleaf.outputs['output.log'] = 'stuff\n! Undefined control sequence.\nl.42 \\foo\n   bar\nOutput written on output.pdf (3 pages).\n';
        git(t.folder, 'config', 'overleaf.landCheck', 'printf "%s" "$(basename "$OVERLEAF_PARENT_COMPILE")"');
        const report = await landCommit(t.repo, t.overleaf, t.ask, t.options);
        assert.strictEqual(report.pushed, false);
        // the checked-out commit is the root here: no parent's compile to compare with
        assert.strictEqual(report.hook?.output, '');
        assert.strictEqual(report.compile?.attempts, 3);
        assert.strictEqual(report.compile?.check?.ok, false);
        assert.match(report.compile!.check!.problems[0], /1 LaTeX errors in output.log; the first:\n {2}! Undefined control sequence.\n {2}l.42 \\foo\n {5}bar$/);
        assert.strictEqual(landedCleanly(report), false);
    });

    it('pushes through the bridge when the window does not upload, and refuses while it does', async () => {
        const t = setup();
        const commit = t.commit({ 'main.tex': 'main v2\n' }, 'Through the bridge');
        const pushes: string[] = [];
        const bridgePush = async (repo: Repo) => {
            const head = repo.mustCommit('HEAD');
            pushes.push(head);
            t.overleaf.docs.set('main.tex', 'main v2\n');
            return { pushed: true, head };
        };
        await assert.rejects(landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit, push: 'bridge', bridgePush }), /push mode native/);
        assert.deepStrictEqual(pushes, []);
        t.window.push = 'bridge';
        t.window.syncIgnore = { patterns: ['/**'], respectGitignore: true };
        const report = await landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit, push: 'bridge', bridgePush, compile: false });
        assert.deepStrictEqual(pushes, [commit]);
        assert.strictEqual(git(t.folder, 'rev-parse', 'HEAD'), commit);
        assert.strictEqual(report.verified, 2);
        assert.ok(!t.asked.includes(`land ${commit.slice(0, 7)}`), 'the window does not push');
    });

    it('pushes through the bridge when an IDE window does not keep the replica in sync, and logs why', async () => {
        const t = setup();
        const commit = t.commit({ 'main.tex': 'main v2\n' }, 'Without a window');
        // a runtime folder of the test's own, where a window does not listen
        const saved = process.env.XDG_RUNTIME_DIR;
        const runtime = fs.mkdtempSync(path.join(SHORT_TEMP, 'owr-'));
        process.env.XDG_RUNTIME_DIR = runtime;
        try {
            const bridgePush = async (repo: Repo) => {
                const head = repo.mustCommit('HEAD');
                t.overleaf.docs.set('main.tex', 'main v2\n');
                return { pushed: true, head };
            };
            const logs: string[] = [];
            const ask: AskWindow = (request, timeoutMs) => requestReplica(t.folder, request, timeoutMs);
            const report = await landCommit(t.repo, t.overleaf, ask, { ...t.options, commit, push: 'bridge', bridgePush, compile: false, log: line => logs.push(line) });
            assert.strictEqual(report.pushed, true);
            assert.strictEqual(logs[0], `an IDE window does not keep ${t.folder} in sync: ${replicaSocketPath(t.folder)} does not exist; the replica's repository says what Overleaf holds`);
            assert.ok(logs.includes(`pushed ${commit.slice(0, 7)} through the bridge`), logs.join('\n'));
        } finally {
            if (saved === undefined) { delete process.env.XDG_RUNTIME_DIR; } else { process.env.XDG_RUNTIME_DIR = saved; }
            fs.rmSync(runtime, { recursive: true, force: true });
        }
    });

    it('compares a check of the checked-out commit with its parent\'s compile', async () => {
        const t = setup();
        const commit = t.commit({ 'main.tex': 'main v2\n' }, 'Landed');
        git(t.folder, 'config', 'overleaf.landCheck', 'printf "%s %s" "$(basename "$OVERLEAF_PARENT_COMPILE")" "$(basename "$OVERLEAF_COMPILE")"');
        await landCommit(t.repo, t.overleaf, t.ask, { ...t.options, commit });
        const report = await landCommit(t.repo, t.overleaf, t.ask, t.options);
        assert.strictEqual(report.pushed, false);
        assert.strictEqual(report.hook?.output, `${t.head} ${commit}`);
    });

    it('takes the commit from a clone where the work happens, at a branch\'s tip or below it', () => {
        const t = setup();
        const clone = path.join(scratch, 'clone');
        spawnSync('git', ['clone', '--quiet', t.folder, clone]);
        git(clone, 'config', 'user.name', 'Book Author');
        git(clone, 'config', 'user.email', 'author@example.com');
        fs.writeFileSync(path.join(clone, 'main.tex'), 'main v2\n');
        git(clone, 'commit', '--quiet', '-am', 'One');
        const one = git(clone, 'rev-parse', 'HEAD');
        fs.writeFileSync(path.join(clone, 'main.tex'), 'main v3\n');
        git(clone, 'commit', '--quiet', '-am', 'Two');
        const two = git(clone, 'rev-parse', 'HEAD');
        // a commit below the branch's tip first, which the clone does not advertise
        assert.strictEqual(fetchCommitFrom(t.repo, clone, one.slice(0, 10)), one);
        assert.strictEqual(git(t.folder, 'rev-parse', `${one}^{commit}`), one);
        assert.strictEqual(fetchCommitFrom(t.repo, clone, 'HEAD'), two);
    });

    describe('the build check', () => {
        const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'build-check-'));
        it('passes a clean build and counts the warnings by kind', () => {
            const d = dir();
            fs.writeFileSync(path.join(d, 'output.log'), LOG_OK);
            const check = checkBuild(d);
            assert.deepStrictEqual({ ok: check.ok, pages: check.pages, warnings: check.warnings }, {
                ok: true, pages: 812, warnings: [{ kind: 'LaTeX Warning: Reference `a\' on page N undefined', count: 1 }, { kind: 'LaTeX Warning: Reference `b\' on page N undefined', count: 1 }],
            });
            fs.rmSync(d, { recursive: true });
        });
        it('fails on latexmk\'s error summary, a failed automatic index, and an index that was not built', () => {
            const d = dir();
            fs.writeFileSync(path.join(d, 'output.log'), `${LOG_OK}The index was not built: upmendex failed\n`);
            fs.writeFileSync(path.join(d, 'output.stdout'), 'Latexmk: ...\nCollected error summary (may duplicate other messages):\n  pdflatex: Command for \'pdflatex\' gave return code 1\n');
            fs.writeFileSync(path.join(d, 'output.stderr'), 'Automatic index: autoindex.pl failed\n');
            const check = checkBuild(d);
            assert.strictEqual(check.ok, false);
            assert.strictEqual(check.problems.length, 3);
            fs.rmSync(d, { recursive: true });
        });
        it('fails when output.log is missing or does not say the PDF was written', () => {
            const d = dir();
            assert.match(checkBuild(d).problems[0], /output.log is missing/);
            fs.writeFileSync(path.join(d, 'output.log'), 'This is pdfTeX\n');
            assert.deepStrictEqual(checkBuild(d).problems, ['output.log does not say that output.pdf was written']);
            fs.rmSync(d, { recursive: true });
        });
    });
});
