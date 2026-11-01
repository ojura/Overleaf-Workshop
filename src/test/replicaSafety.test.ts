/* eslint-disable @typescript-eslint/naming-convention -- the replica's class name, as the module exports it */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { POINTER_FILE } from '../scm/replicaControl';
import { OVERLEAF_REF } from '../scm/replicaGit';
import { Uri, load, world } from './replicaTestWorld';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const read = (file: string) => fs.readFileSync(file, 'utf8');
/** The files of Overleaf's last recorded state, by git path. */
const recorded = (folder: string) => git(folder, 'ls-tree', '-r', '--name-only', OVERLEAF_REF).split('\n').filter(Boolean);

/** A replica's deletions, the folders it calls its own, and its saved state. */
describe('local replica: what it deletes and what it never syncs', function () {
    this.timeout(20000);
    /** what each test set up, undone in reverse order on every path */
    let undo: (() => void | Promise<void>)[] = [];
    afterEach(async () => {
        const errors: unknown[] = [];
        for (const step of undo.reverse()) {
            try { await step(); } catch (error) { errors.push(error); }
        }
        undo = [];
        if (errors.length) { throw errors[0]; }
    });

    function tempDir(prefix: string): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        undo.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        return dir;
    }
    function setEnv(key: string, value: string) {
        const saved = process.env[key];
        process.env[key] = value;
        undo.push(() => { if (saved === undefined) { delete process.env[key]; } else { process.env[key] = saved; } });
    }
    /**
     * Resolves once `holds()` is true: at once, or at the change in the folder `dir` that makes
     * it so. Its watcher closes then, or at the end of the test.
     */
    function folderShows(dir: string, holds: () => boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            const watcher = fs.watch(dir);
            undo.push(() => watcher.close());
            const check = () => { if (holds()) { watcher.close(); resolve(); } };
            watcher.on('change', check);
            watcher.on('error', error => { watcher.close(); reject(error); });
            check();
        });
    }
    /** Resolves once `file` exists: the replica's control server writes it after it listens. */
    const fileAppears = (file: string) => folderShows(path.dirname(file), () => fs.existsSync(file));
    /**
     * A commit of the folder as an agent makes it with `git add -A` and `git commit` on top of
     * HEAD, in an index of its own, so that the replica's index and HEAD stay as they are.
     */
    function commitAll(folder: string, message: string): string {
        const env = {
            ...process.env, GIT_INDEX_FILE: path.join(tempDir('ow-safety-index-'), 'index'),
            GIT_AUTHOR_NAME: 'An Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'An Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
        };
        const run = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', env }).trim();
        run('read-tree', 'HEAD');
        run('add', '-A');
        return run('commit-tree', run('write-tree'), '-p', 'HEAD', '-m', message);
    }

    /** One extension host with its own socket folder and trash, and the replica's folder. */
    function host(folder?: string) {
        const runtime = tempDir('ow-safety-run-');
        fs.chmodSync(runtime, 0o700);
        setEnv('XDG_RUNTIME_DIR', runtime);
        setEnv('XDG_DATA_HOME', tempDir('ow-safety-data-'));
        const dir = folder ?? tempDir('ow-safety-');
        const t = world(dir, false);
        return { ...t, folder: dir };
    }

    /** Start a replica of `t`'s project and wait for its first sync and record. */
    async function start(t: ReturnType<typeof host>, modules = load(t.mock)) {
        const scm = new modules.LocalReplicaSCMProvider(t.vfs, Uri.file(t.folder));
        const triggers: { dispose(): void }[] = await scm.triggers;
        undo.push(async () => {
            triggers.forEach(trigger => trigger.dispose());
            await scm.sync?.stop(); // the stop saves the state into the folder: wait for it before the folder goes
        });
        await scm.syncNow();
        return { ...modules, scm };
    }

    function project(t: ReturnType<typeof host>, files: Record<string, string>) {
        for (const [p, text] of Object.entries(files)) { t.w.remote.set(p, text); }
    }

    /** The connection to Overleaf is lost: the project is not connected, and its lookups fail as the VFS's do then. */
    function loseConnection(t: ReturnType<typeof host>, options: { treeAnswers?: boolean } = {}) {
        const vfs = t.vfs as any;
        vfs.connected = false;
        const message = 'Not connected to www.overleaf.com; reconnecting in the background.';
        const keys = options.treeAnswers ? ['getUpdates'] : ['init', '_resolveUri', 'openFile', 'writeFile', 'writeDoc', 'createFile', 'remove', 'rename', 'mkdir', 'getUpdates'];
        for (const key of keys) {
            const original = vfs[key];
            vfs[key] = async (...args: any[]) => { if (!vfs.connected) { throw new Error(message); } return original(...args); };
        }
    }

    describe('while the connection to Overleaf is lost', () => {
        it('keeps a file saved meanwhile, and keeps Overleaf\'s recorded state as it was', async () => {
            const t = host();
            project(t, { '/main.tex': 'v1\n', '/other.tex': 'other\n' });
            const { scm } = await start(t);
            loseConnection(t);
            fs.writeFileSync(path.join(t.folder, 'main.tex'), 'v2, saved while offline\n');
            const summary = await scm.syncNow();
            assert.strictEqual(read(path.join(t.folder, 'main.tex')), 'v2, saved while offline\n');
            assert.deepStrictEqual(summary.failed.map((f: any) => f.path), ['/main.tex']);
            assert.deepStrictEqual(recorded(t.folder), ['main.tex', 'other.tex'], 'Overleaf\'s recorded state still has the file');
            assert.strictEqual(fs.existsSync(path.join(t.folder, '.overleaf', 'conflicts')), false, 'the local version is not kept aside');
        });

        it('does not take a file missing from the old project tree as deleted', async () => {
            const t = host();
            project(t, { '/main.tex': 'v1\n', '/other.tex': 'other\n' });
            const { scm } = await start(t);
            // the tree answers, but from before the connection was lost
            loseConnection(t, { treeAnswers: true });
            t.w.remote.delete('/main.tex');
            fs.writeFileSync(path.join(t.folder, 'main.tex'), 'v2, saved while offline\n');
            const summary = await scm.syncNow();
            assert.strictEqual(read(path.join(t.folder, 'main.tex')), 'v2, saved while offline\n');
            assert.deepStrictEqual(summary.failed.map((f: any) => f.path), ['/main.tex']);
            assert.deepStrictEqual(recorded(t.folder), ['main.tex', 'other.tex']);
        });

        it('keeps a local deletion for when the connection is back, and keeps Overleaf\'s recorded state as it was', async () => {
            const t = host();
            project(t, { '/main.tex': 'v1\n', '/other.tex': 'other\n' });
            const { scm } = await start(t);
            loseConnection(t);
            fs.rmSync(path.join(t.folder, 'other.tex'));
            const summary = await scm.syncNow();
            assert.deepStrictEqual(summary.failed.map((f: any) => f.path), ['/other.tex']);
            assert.deepStrictEqual(recorded(t.folder), ['main.tex', 'other.tex'], 'the deletion is not taken for one made on Overleaf');
            assert.strictEqual(t.w.remote.has('/other.tex'), true);
        });
    });

    describe('deletions on Overleaf', () => {
        const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/chapter${i}.tex`, `chapter ${i}\n`]));

        it('are not made when the replica folder is gone', async () => {
            const t = host();
            project(t, eight);
            const { scm } = await start(t);
            const moved = `${t.folder}-moved`;
            fs.renameSync(t.folder, moved);
            undo.push(() => fs.rmSync(moved, { recursive: true, force: true }));
            await scm.syncNow().catch(() => { /* the sync fails: the folder cannot be read */ });
            assert.strictEqual(t.w.remote.size, 8, 'every file is still on Overleaf');
        });

        it('are not made, and the other folder\'s files stay local, when another folder is at the replica\'s path', async () => {
            const t = host();
            project(t, { '/a.tex': 'a\n', '/b.tex': 'b\n', '/c.tex': 'c\n' });
            const { scm } = await start(t);
            // the folder moved away, and another one with a repository, the settings and an older a.tex took its path
            const moved = `${t.folder}-moved`;
            fs.renameSync(t.folder, moved);
            undo.push(() => fs.rmSync(moved, { recursive: true, force: true }));
            fs.mkdirSync(path.join(t.folder, '.overleaf'), { recursive: true });
            fs.copyFileSync(path.join(moved, '.overleaf', 'settings.json'), path.join(t.folder, '.overleaf', 'settings.json'));
            git(t.folder, 'init', '--quiet');
            fs.writeFileSync(path.join(t.folder, 'a.tex'), 'a, from another folder\n');
            const error = await scm.syncNow().then(() => undefined, (e: Error) => e);
            assert.strictEqual(t.w.remote.size, 3, 'every file is still on Overleaf');
            assert.strictEqual(t.w.remote.get('/a.tex'), 'a\n', 'the other folder\'s file is not uploaded');
            assert.match(String(error), /not the folder this replica started with: another folder is at its path/);
        });

        it('are not made when a folder cannot be read', async function () {
            if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); } // permissions do not stop this user
            const t = host();
            project(t, { '/main.tex': 'main\n', '/figs/a.tex': 'a\n', '/figs/b.tex': 'b\n' });
            const { scm } = await start(t);
            const figs = path.join(t.folder, 'figs');
            fs.chmodSync(figs, 0o000);
            undo.push(() => fs.chmodSync(figs, 0o755));
            const error = await scm.syncNow().then(() => undefined, (e: Error) => e);
            assert.strictEqual(t.w.remote.has('/figs/a.tex') && t.w.remote.has('/figs/b.tex'), true, 'the files are still on Overleaf');
            assert.match(String(error), /EACCES/);
        });

        it('are refused to a tool when more than the threshold would go at once, naming the count', async () => {
            const t = host();
            project(t, eight);
            const { requestReplica } = await start(t);
            await fileAppears(path.join(t.folder, POINTER_FILE));
            // as git checkout, git stash -u or git clean leave the folder
            for (let i = 0; i < 6; i++) { fs.rmSync(path.join(t.folder, `chapter${i}.tex`)); }
            const answer: any = await requestReplica(t.folder, { op: 'sync' }, 10000);
            assert.strictEqual(answer.ok, false, JSON.stringify(answer));
            assert.match(answer.error, /\b6\b/);
            assert.strictEqual(t.w.remote.size, 8, 'every file stays on Overleaf');
        });

        it('wait for the user\'s confirmation in the window when more than the threshold would go at once', async () => {
            const t = host();
            project(t, eight);
            const questions: string[][] = [];
            t.mock.window.showWarningMessage = async (_message: string, options?: any) => {
                if (options?.modal) { questions.push(String(options.detail).split('\n')); }
                return undefined; // the user does not confirm
            };
            const { LocalReplicaSCMProvider } = await start(t);
            for (let i = 0; i < 6; i++) { fs.rmSync(path.join(t.folder, `chapter${i}.tex`)); }
            await LocalReplicaSCMProvider.syncNowCommand();
            assert.ok(questions.length > 0, 'the user is asked');
            for (const question of questions) {
                assert.deepStrictEqual([...question].sort(), ['/chapter0.tex', '/chapter1.tex', '/chapter2.tex', '/chapter3.tex', '/chapter4.tex', '/chapter5.tex']);
            }
            assert.strictEqual(t.w.remote.size, 8, 'every file stays on Overleaf');
        });
    });

    describe('a question about deletions that waits for an answer in the window', () => {
        /**
         * Nine synced files; a collaborator deletes six on Overleaf, and the window asks whether
         * to delete them locally too. The user answers with `answer`, or never. `noticeShown`
         * resolves at the first notice that the window shows after the answer.
         */
        async function questionOpen() {
            const t = host();
            const chapters = Array.from({ length: 8 }, (_, i) => `/chapter${i}.tex`);
            project(t, { ...Object.fromEntries(chapters.map(p => [p, `${p}\n`])), '/main.tex': 'main\n' });
            let shown!: () => void;
            const questionShown = new Promise<void>(resolve => { shown = resolve; });
            let respond!: (confirm: boolean) => void;
            let answered = false;
            let noticed!: () => void;
            const noticeShown = new Promise<void>(resolve => { noticed = resolve; });
            t.mock.window.showWarningMessage = (_message: string, options?: any, ...actions: string[]) => {
                if (options?.modal) {
                    shown();
                    return new Promise(resolve => {
                        respond = confirm => { answered = true; resolve(confirm ? actions[0] : undefined); };
                    });
                }
                if (answered) { noticed(); }
                return Promise.resolve(undefined);
            };
            const started = await start(t);
            await fileAppears(path.join(t.folder, POINTER_FILE));
            const deleted = chapters.slice(0, 6);
            deleted.forEach(p => t.remoteDelete(p));
            await questionShown;
            return { ...started, t, deleted, answer: (confirm: boolean) => respond(confirm), noticeShown };
        }

        it('is named to a tool at once, and shows in the status', async () => {
            const { t, deleted, requestReplica } = await questionOpen();
            const answer: any = await requestReplica(t.folder, { op: 'sync' }, 10000);
            assert.strictEqual(answer.ok, false, JSON.stringify(answer));
            for (const p of deleted) { assert.ok(answer.error.includes(p), answer.error); }
            const status: any = await requestReplica(t.folder, { op: 'status' }, 10000);
            assert.deepStrictEqual([...(status.question?.paths ?? [])].sort(), deleted);
        });

        it('keeps the files tracked in git, so that a commit of the folder made meanwhile does not upload them after the user confirms', async () => {
            const { t, deleted, scm, requestReplica, answer } = await questionOpen();
            await scm.sync.recordNow();
            assert.strictEqual(git(t.folder, 'status', '--porcelain'), '', 'git status is clean while the deletion waits');
            const commit = commitAll(t.folder, 'an agent\'s commit of the folder');
            assert.strictEqual(git(t.folder, 'diff', '--name-status', 'HEAD', commit), '', 'the commit adds nothing');
            answer(true);
            const files = deleted.map(p => path.join(t.folder, p.slice(1)));
            await folderShows(t.folder, () => files.every(file => !fs.existsSync(file)));
            await requestReplica(t.folder, { op: 'sync' }, 10000);
            await requestReplica(t.folder, { op: 'land', commit }, 10000);
            assert.deepStrictEqual([...t.w.remote.keys()].sort(), ['/chapter6.tex', '/chapter7.tex', '/main.tex'], 'the collaborator\'s deletion stands on Overleaf');
            assert.deepStrictEqual(files.filter(file => fs.existsSync(file)), [], 'and in the folder');
        });

        it('keeps the files tracked in git after the user declines their deletion', async () => {
            const { t, deleted, scm, answer, noticeShown } = await questionOpen();
            answer(false);
            await noticeShown;
            await scm.sync.recordNow();
            assert.strictEqual(git(t.folder, 'status', '--porcelain'), '', 'git status is clean');
            assert.strictEqual(git(t.folder, 'diff', '--name-status', 'HEAD', commitAll(t.folder, 'an agent\'s commit of the folder')), '', 'a commit of the folder adds nothing');
            assert.ok(deleted.every(p => fs.existsSync(path.join(t.folder, p.slice(1)))), 'the local files stay');
        });
    });

    describe('the replica\'s own folders', () => {
        // the user removed the dot-file patterns, e.g. to sync a .latexmkrc
        const patterns = ['**/*.aux', '**/*.log'];

        it('never upload the replica\'s git repository, whatever the ignore patterns say', async () => {
            const t = host();
            project(t, { '/main.tex': 'v1\n' });
            (t.vfs as any).getProjectSCMPersist = () => ({ settings: { 'ignore-patterns': patterns } });
            const modules = load(t.mock);
            await start(t, modules);
            // the next start of the replica, as after a reload or a reconnect
            await undo.pop()!();
            await start(t, modules);
            assert.deepStrictEqual([...t.w.remote.keys()].filter(p => p.startsWith('/.git')), []);
        });

        it('remove the temporary files that writes of an earlier run left behind', async () => {
            const t = host();
            project(t, { '/main.tex': 'v1\n' });
            const leftover = path.join(t.folder, '.overleaf', 'tmp', '1234-0badc0de0badc0de.tmp');
            fs.mkdirSync(path.dirname(leftover), { recursive: true });
            fs.writeFileSync(leftover, 'half a download');
            await start(t);
            assert.strictEqual(fs.existsSync(leftover), false);
            assert.deepStrictEqual([...t.w.remote.keys()], ['/main.tex']);
        });

        it('never download into the replica\'s git repository, whatever the ignore patterns say', async () => {
            const t = host();
            project(t, { '/main.tex': 'v1\n', '/.git/config': '# written on Overleaf\n[core]\n\tbare = true\n' });
            (t.vfs as any).getProjectSCMPersist = () => ({ settings: { 'ignore-patterns': patterns } });
            await start(t);
            assert.doesNotMatch(read(path.join(t.folder, '.git', 'config')), /written on Overleaf/);
            assert.strictEqual(read(path.join(t.folder, 'main.tex')), 'v1\n');
        });
    });

    describe('the saved sync state', () => {
        /** A replica folder with Overleaf's recorded state and main.tex edited since, without its state file. */
        function replicaWithoutState(t: ReturnType<typeof host>) {
            project(t, { '/main.tex': 'v1\n', '/other.tex': 'other\n' });
            git(t.folder, 'init', '--quiet', '--initial-branch=main');
            git(t.folder, 'config', 'user.name', 'Local User');
            git(t.folder, 'config', 'user.email', 'local@example.com');
            fs.writeFileSync(path.join(t.folder, 'main.tex'), 'v1\n');
            fs.writeFileSync(path.join(t.folder, 'other.tex'), 'other\n');
            git(t.folder, 'add', 'main.tex', 'other.tex');
            git(t.folder, 'commit', '--quiet', '-m', 'Overleaf\'s state');
            git(t.folder, 'update-ref', OVERLEAF_REF, 'HEAD');
            // edited while the IDE was closed
            fs.writeFileSync(path.join(t.folder, 'main.tex'), 'v2, edited while the IDE was closed\n');
        }

        it('when it is missing, takes the bases of Overleaf\'s recorded state and keeps the local edit', async () => {
            const t = host();
            replicaWithoutState(t);
            await start(t);
            assert.strictEqual(read(path.join(t.folder, 'main.tex')), 'v2, edited while the IDE was closed\n');
            assert.strictEqual(t.w.remote.get('/main.tex'), 'v2, edited while the IDE was closed\n', 'the edit is uploaded');
            assert.strictEqual(fs.existsSync(path.join(t.folder, '.overleaf', 'conflicts')), false, 'the local version is not kept aside');
        });

        it('when it cannot be read, stops the replica, says why, and leaves the files and the state as they are', async () => {
            const t = host();
            replicaWithoutState(t);
            const stateFile = path.join(t.folder, '.git', 'overleaf', 'state.json');
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            fs.writeFileSync(stateFile, '{not json');
            const errors: string[] = [];
            t.mock.window.showErrorMessage = async (message: string) => { errors.push(message); return undefined; };
            const { LocalReplicaSCMProvider } = load(t.mock);
            const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(t.folder));
            const started = await scm.triggers.then((triggers: { dispose(): void }[]) => {
                undo.push(async () => { triggers.forEach(trigger => trigger.dispose()); await scm.sync?.stop(); });
                return 'started';
            }, (error: Error) => error);
            if (started === 'started') { await scm.syncNow().catch(() => { /* the test asserts what the sync did */ }); }
            assert.strictEqual(read(path.join(t.folder, 'main.tex')), 'v2, edited while the IDE was closed\n');
            assert.strictEqual(read(stateFile), '{not json');
            assert.strictEqual(t.w.remote.get('/main.tex'), 'v1\n');
            assert.ok(started instanceof Error, 'the replica does not start');
            assert.ok(errors.some(message => message.includes('state.json')), JSON.stringify(errors));
        });
    });
});
