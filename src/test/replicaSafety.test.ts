/* eslint-disable @typescript-eslint/naming-convention -- the replica's class name, as the module exports it */
import * as assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { OVERLEAF_REF } from '../scm/replicaGit';
import { Cleanup, Uri, load, world } from './replicaTestWorld';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = (file: string) => fs.readFileSync(file, 'utf8');
/** The files of Overleaf's last recorded state, by git path. */
const recorded = (folder: string) => git(folder, 'ls-tree', '-r', '--name-only', OVERLEAF_REF).split('\n').filter(Boolean);

/** A replica's deletions, the folders it calls its own, and its saved state. */
describe('local replica: what it deletes and what it never syncs', function () {
    this.timeout(20000);
    /** what each test set up, undone in reverse order on every path */
    const cleanup = new Cleanup();
    afterEach(() => cleanup.undo());
    /**
     * A commit of the folder as an agent makes it with `git add -A` and `git commit` on top of
     * HEAD, in an index of its own, so that the replica's index and HEAD stay as they are.
     */
    function commitAll(folder: string, message: string): string {
        const env = {
            ...process.env, GIT_INDEX_FILE: path.join(cleanup.tempDir('ow-safety-index-'), 'index'),
            GIT_AUTHOR_NAME: 'An Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'An Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
        };
        const run = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', env }).trim();
        run('read-tree', 'HEAD');
        run('add', '-A');
        return run('commit-tree', run('write-tree'), '-p', 'HEAD', '-m', message);
    }

    /** One extension host with its own socket folder and trash, and the replica's folder. */
    function host(folder?: string) {
        cleanup.privateRuntime();
        const dir = folder ?? cleanup.tempDir('ow-safety-');
        const t = world(dir, false);
        return { ...t, folder: dir };
    }

    /** Start a replica of `t`'s project and wait for its first sync and record. */
    async function start(t: ReturnType<typeof host>, modules = load(t.mock)) {
        const scm = new modules.LocalReplicaSCMProvider(t.vfs, Uri.file(t.folder));
        await cleanup.start(scm);
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
        const keys = options.treeAnswers ? ['getUpdates'] : ['init', '_resolveUri', 'openFile', 'writeFile', 'writeDoc', 'createFile', 'remove', 'rename', 'mkdir', 'getUpdates'];
        for (const key of keys) {
            const original = vfs[key];
            vfs[key] = async (...args: any[]) => { if (!vfs.connected) { throw vfs.notConnectedError(); } return original(...args); };
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

    describe('a document write that Overleaf rejects', () => {
        // as the VFS's writeDoc rejects, with a vscode.FileSystemError by its code
        const rejections: [string, (path: string) => Error][] = [
            ['not confirmed by Overleaf', path => Object.assign(new Error(`${path}: Overleaf has not confirmed the update (the test's)`), { code: 'Unavailable' })],
            ['undetermined while the user decides', path => Object.assign(new Error(`${path}: it cannot be told whether Overleaf applied the update (the test's)`), { code: 'Unavailable' })],
            ['for a path that is not a document', path => Object.assign(new Error(`${path}: not a document (the test's)`), { code: 'FileNotFound' })],
        ];
        for (const [what, rejection] of rejections) {
            it(`fails the file, which keeps its local content and its entry, when the write is refused ${what}`, async () => {
                const t = host();
                project(t, { '/main.tex': 'v1\n', '/other.tex': 'other\n' });
                const { scm, requestReplica } = await start(t);
                await cleanup.controlListens(t.folder);
                const vfs = t.vfs as any;
                const writeDoc = vfs.writeDoc;
                const error = rejection('/main.tex');
                vfs.writeDoc = async () => { throw error; };
                fs.writeFileSync(path.join(t.folder, 'main.tex'), 'v2, edited locally\n');
                const answer: any = await requestReplica(t.folder, { op: 'sync' }, 10000);
                assert.strictEqual(answer.ok, false, JSON.stringify(answer));
                assert.deepStrictEqual(answer.summary.failed, [{ path: '/main.tex', error: error.message }], 'the file fails');
                assert.ok(answer.error.includes(`/main.tex: ${error.message}`), answer.error);
                // nothing takes it for an absence or a deletion
                assert.strictEqual(read(path.join(t.folder, 'main.tex')), 'v2, edited locally\n', 'the local file keeps its content');
                assert.strictEqual(await scm.sync.knows('/main.tex'), true, 'its entry stays');
                assert.deepStrictEqual([...t.w.remote.entries()].sort(), [['/main.tex', 'v1\n'], ['/other.tex', 'other\n']], 'Overleaf keeps both files');
                assert.deepStrictEqual(recorded(t.folder), ['main.tex', 'other.tex'], 'Overleaf\'s recorded state keeps the file');
                assert.deepStrictEqual([answer.summary.deletedLocal, answer.summary.deletedRemote, answer.summary.keptAside], [[], [], []]);
                assert.strictEqual(fs.existsSync(path.join(t.folder, '.overleaf', 'conflicts')), false, 'nothing is kept aside');
                // once Overleaf takes the write, the next sync uploads the change
                vfs.writeDoc = writeDoc;
                const again: any = await requestReplica(t.folder, { op: 'sync' }, 10000);
                assert.strictEqual(again.ok, true, JSON.stringify(again));
                assert.strictEqual(t.w.remote.get('/main.tex'), 'v2, edited locally\n');
            });
        }
    });

    describe('deletions made on Overleaf', () => {
        it('delete the local files of a folder deleted on Overleaf, which the project tree answers as not found', async () => {
            const t = host();
            project(t, { '/main.tex': 'main\n', '/old/a.tex': 'a\n', '/old/b.tex': 'b\n' });
            const { scm } = await start(t);
            // a collaborator deletes the folder: a lookup of a path in it is FileNotFound, as the VFS answers it
            t.w.remote.delete('/old/a.tex');
            t.w.remote.delete('/old/b.tex');
            await scm.settingItems[0].callback(); // Sync now, a full sync
            assert.deepStrictEqual(['a.tex', 'b.tex'].filter(name => fs.existsSync(path.join(t.folder, 'old', name))), []);
            assert.strictEqual(read(path.join(t.folder, 'main.tex')), 'main\n');
        });
    });

    describe('deletions on Overleaf', () => {
        const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/chapter${i}.tex`, `chapter ${i}\n`]));

        it('are not made while the replica folder is gone, nothing is written at its path, and the replica syncs again once the folder is back', async () => {
            const t = host();
            // fewer files than the threshold, which would otherwise hold the deletions back
            project(t, { '/a.tex': 'a\n', '/b.tex': 'b\n', '/c.tex': 'c\n' });
            const { scm } = await start(t);
            const moved = `${t.folder}-moved`;
            fs.renameSync(t.folder, moved);
            cleanup.add(() => fs.rmSync(moved, { recursive: true, force: true }));
            const error = await scm.syncNow().then(() => undefined, (e: any) => e);
            assert.strictEqual(error?.reason, 'gone', String(error));
            assert.strictEqual(t.w.remote.size, 3, 'every file is still on Overleaf');
            // a change on Overleaf meanwhile, as the project reports it to the sync
            t.w.remote.set('/b.tex', 'b, edited on Overleaf\n');
            await scm.sync.remoteChanged('/b.tex', false);
            assert.strictEqual(fs.existsSync(t.folder), false, 'nothing is written at the replica\'s path');
            fs.renameSync(moved, t.folder);
            fs.writeFileSync(path.join(t.folder, 'a.tex'), 'a, edited while the folder was away\n');
            const summary = await scm.syncNow();
            assert.deepStrictEqual(summary.uploaded, ['/a.tex']);
            await scm.settingItems[0].callback(); // Sync now, a full sync
            assert.strictEqual(read(path.join(t.folder, 'b.tex')), 'b, edited on Overleaf\n');
            assert.strictEqual(t.w.remote.size, 3);
        });

        it('are not made, and the other folder\'s files stay local, when another folder is at the replica\'s path', async () => {
            const t = host();
            project(t, { '/a.tex': 'a\n', '/b.tex': 'b\n', '/c.tex': 'c\n' });
            const { scm } = await start(t);
            // the folder moved away, and another one with a repository, the settings and an older a.tex took its path
            const moved = `${t.folder}-moved`;
            fs.renameSync(t.folder, moved);
            cleanup.add(() => fs.rmSync(moved, { recursive: true, force: true }));
            fs.mkdirSync(path.join(t.folder, '.overleaf'), { recursive: true });
            fs.copyFileSync(path.join(moved, '.overleaf', 'settings.json'), path.join(t.folder, '.overleaf', 'settings.json'));
            git(t.folder, 'init', '--quiet');
            fs.writeFileSync(path.join(t.folder, 'a.tex'), 'a, from another folder\n');
            const error = await scm.syncNow().then(() => undefined, (e: Error) => e);
            assert.strictEqual(t.w.remote.size, 3, 'every file is still on Overleaf');
            assert.strictEqual(t.w.remote.get('/a.tex'), 'a\n', 'the other folder\'s file is not uploaded');
            assert.strictEqual((error as any)?.reason, 'replaced', String(error));
        });

        it('are not made when a folder cannot be read', async function () {
            if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); } // permissions do not stop this user
            const t = host();
            project(t, { '/main.tex': 'main\n', '/figs/a.tex': 'a\n', '/figs/b.tex': 'b\n' });
            const { scm } = await start(t);
            const figs = path.join(t.folder, 'figs');
            fs.chmodSync(figs, 0o000);
            cleanup.add(() => fs.chmodSync(figs, 0o755));
            const error = await scm.syncNow().then(() => undefined, (e: Error) => e);
            assert.strictEqual(t.w.remote.has('/figs/a.tex') && t.w.remote.has('/figs/b.tex'), true, 'the files are still on Overleaf');
            assert.strictEqual((error as NodeJS.ErrnoException | undefined)?.code, 'EACCES', String(error));
        });

        it('count the files in a symbolically linked folder as there, so that deleting another file goes ahead', async function () {
            if (process.platform === 'win32') { this.skip(); } // a link to a folder needs rights there
            const t = host();
            const figs = Array.from({ length: 6 }, (_, i) => `/figs/f${i}.tex`);
            project(t, { ...Object.fromEntries(figs.map(p => [p, `${p}\n`])), '/main.tex': 'main\n', '/extra.tex': 'extra\n' });
            // the figures are in another folder that the replica links to
            const outside = cleanup.tempDir('ow-safety-linked-');
            fs.symlinkSync(outside, path.join(t.folder, 'figs'));
            const { requestReplica } = await start(t);
            assert.strictEqual(fs.readdirSync(outside).length, 6, 'the first sync writes the figures through the link');
            await cleanup.controlListens(t.folder);
            fs.rmSync(path.join(t.folder, 'extra.tex'));
            const answer: any = await requestReplica(t.folder, { op: 'sync' }, 10000);
            assert.strictEqual(answer.ok, true, JSON.stringify(answer));
            assert.deepStrictEqual([...t.w.remote.keys()].sort(), [...figs, '/main.tex'].sort(), 'only extra.tex is deleted on Overleaf');
        });

        it('are refused to a tool when more than the threshold would go at once, naming the count', async () => {
            const t = host();
            project(t, eight);
            const { requestReplica } = await start(t);
            await cleanup.controlListens(t.folder);
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
            await cleanup.controlListens(t.folder);
            const deleted = chapters.slice(0, 6);
            deleted.forEach(p => t.remoteDelete(p));
            await questionShown;
            return { ...started, t, deleted, answer: (confirm: boolean) => respond(confirm), noticeShown };
        }

        it('is named to a tool at once, and shows in the status', async () => {
            const { t, deleted, requestReplica } = await questionOpen();
            const answer: any = await requestReplica(t.folder, { op: 'sync' }, 10000);
            assert.strictEqual(answer.ok, false, JSON.stringify(answer));
            assert.deepStrictEqual([...(answer.summary.question?.paths ?? [])].sort(), deleted);
            assert.deepStrictEqual(answer.summary.deletionsToConfirm, [], 'the question names the deletions on its side');
            for (const p of deleted) { assert.ok(answer.error.includes(p), answer.error); }
            const status: any = await requestReplica(t.folder, { op: 'status' }, 10000);
            assert.deepStrictEqual([...(status.question?.paths ?? [])].sort(), deleted);
            assert.strictEqual(typeof status.question.message, 'string', 'the window words the question for replica-status');
        });

        it('is named to a tool also when the user answers it while the tool\'s request runs', async () => {
            const { t, deleted, scm, requestReplica, answer } = await questionOpen();
            // the user answers just after the tool's request saw the question
            const flush = scm.sync.flush.bind(scm.sync);
            scm.sync.flush = (...args: any[]) => { answer(true); return flush(...args); };
            const reply: any = await requestReplica(t.folder, { op: 'sync' }, 10000);
            assert.strictEqual(reply.ok, false, JSON.stringify(reply));
            assert.deepStrictEqual([...(reply.summary.question?.paths ?? [])].sort(), deleted);
        });

        it('that the first sync after a start asks is named to a tool at once, while that sync waits for the answer', async () => {
            const t = host();
            const chapters = Array.from({ length: 8 }, (_, i) => `/chapter${i}.tex`);
            project(t, { ...Object.fromEntries(chapters.map(p => [p, `${p}\n`])), '/main.tex': 'main\n' });
            const modules = load(t.mock);
            await start(t, modules);
            await cleanup.undoLast(); // the IDE closes
            const deleted = chapters.slice(0, 6);
            deleted.forEach(p => t.w.remote.delete(p)); // a collaborator deletes six meanwhile
            let shown!: () => void;
            const questionShown = new Promise<void>(resolve => { shown = resolve; });
            t.mock.window.showWarningMessage = (_message: string, options?: any) => {
                if (options?.modal) { shown(); return new Promise(() => { /* the user is away */ }); }
                return Promise.resolve(undefined);
            };
            // the IDE starts again: its first sync asks about the six, and the question waits
            const scm = new modules.LocalReplicaSCMProvider(t.vfs, Uri.file(t.folder));
            await cleanup.start(scm);
            await questionShown;
            await cleanup.controlListens(t.folder);
            const reply: any = await modules.requestReplica(t.folder, { op: 'sync' }, 10000);
            assert.strictEqual(reply.ok, false, JSON.stringify(reply));
            assert.deepStrictEqual([...(reply.summary.question?.paths ?? [])].sort(), deleted);
            const landing: any = await modules.requestReplica(t.folder, { op: 'land', commit: 'HEAD' }, 10000);
            assert.strictEqual(landing.ok, false, JSON.stringify(landing));
            const status: any = await modules.requestReplica(t.folder, { op: 'status' }, 10000);
            assert.strictEqual(status.fullSyncRunning, true);
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
            await cleanup.folderShows(t.folder, () => files.every(file => !fs.existsSync(file)));
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
            await cleanup.undoLast();
            await start(t, modules);
            assert.deepStrictEqual([...t.w.remote.keys()].filter(p => p.startsWith('/.git')), []);
        });

        it('remove the temporary files that writes of an earlier run left behind', async () => {
            const t = host();
            project(t, { '/main.tex': 'v1\n' });
            // the file of a write of a process that has ended
            const leftover = path.join(t.folder, '.overleaf', 'tmp', `${spawnSync(process.execPath, ['-e', '']).pid}-0badc0de0badc0de.tmp`);
            fs.mkdirSync(path.dirname(leftover), { recursive: true });
            fs.writeFileSync(leftover, 'half a download');
            await start(t);
            assert.strictEqual(fs.existsSync(leftover), false);
            assert.deepStrictEqual([...t.w.remote.keys()], ['/main.tex']);
        });

        it('keep the temporary file of a write that a running process makes, as another replica of the folder that starts at the same moment', async () => {
            const t = host();
            project(t, { '/main.tex': 'v1\n' });
            // this process writes it, as a second provider for the folder in the same window would
            const writing = path.join(t.folder, '.overleaf', 'tmp', `${process.pid}-0badc0de0badc0de.tmp`);
            fs.mkdirSync(path.dirname(writing), { recursive: true });
            fs.writeFileSync(writing, 'half a download');
            await start(t);
            assert.strictEqual(read(writing), 'half a download');
        });

        /** Start a replica of `t`'s folder that fails to start: the error, and the lines of the replica's log. */
        async function failedStart(t: ReturnType<typeof host>) {
            const lines: string[] = [];
            t.mock.window.createOutputChannel = () => ({ appendLine: (line: string) => lines.push(line), show() {}, dispose() {} });
            const { LocalReplicaSCMProvider } = load(t.mock);
            const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(t.folder));
            const error = await cleanup.start(scm).then(() => undefined, (e: NodeJS.ErrnoException) => e);
            return { error, lines };
        }

        it('say in the log why the start failed when the temporary folder cannot be read', async function () {
            if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); } // permissions do not stop this user
            const t = host();
            project(t, { '/main.tex': 'v1\n' });
            const temporary = path.join(t.folder, '.overleaf', 'tmp');
            fs.mkdirSync(temporary, { recursive: true });
            fs.chmodSync(temporary, 0o000);
            cleanup.add(() => fs.chmodSync(temporary, 0o755));
            const { error, lines } = await failedStart(t);
            assert.strictEqual(error?.code, 'EACCES', String(error));
            assert.ok(lines.some(line => line.includes(temporary) && line.includes(String(error))), JSON.stringify(lines));
        });

        it('say in the log why the start failed when the settings file cannot be written', async function () {
            if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); }
            const t = host();
            project(t, { '/main.tex': 'v1\n' });
            const own = path.join(t.folder, '.overleaf');
            fs.mkdirSync(own);
            fs.chmodSync(own, 0o555);
            cleanup.add(() => fs.chmodSync(own, 0o755));
            const { error, lines } = await failedStart(t);
            assert.strictEqual(error?.code, 'EACCES', String(error));
            assert.ok(lines.some(line => line.includes(path.join(own, 'settings.json')) && line.includes(String(error))), JSON.stringify(lines));
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

    describe('git in the replica folder', () => {
        /** A replica with main.tex at v2 in a commit of the user's, which Overleaf holds. */
        async function committedV2(t: ReturnType<typeof host>, files: Record<string, string> = {}) {
            project(t, { '/main.tex': 'v1\n', ...files });
            const started = await start(t);
            fs.writeFileSync(path.join(t.folder, 'main.tex'), 'v2\n');
            await started.scm.syncNow();
            assert.strictEqual(t.w.remote.get('/main.tex'), 'v2\n');
            assert.strictEqual(git(t.folder, 'rev-parse', OVERLEAF_REF), git(t.folder, 'rev-parse', 'HEAD'), 'Overleaf holds the commit');
            return started;
        }

        it('does not upload the files of an older commit that git checks out', async () => {
            const t = host();
            const { scm, requestReplica } = await committedV2(t);
            git(t.folder, 'checkout', '--quiet', '--detach', 'HEAD~1');
            const older = git(t.folder, 'rev-parse', 'HEAD');
            const summary = await scm.syncNow();
            assert.strictEqual(t.w.remote.get('/main.tex'), 'v2\n', 'Overleaf keeps the newer content');
            assert.strictEqual(git(t.folder, 'rev-parse', 'HEAD'), older, 'the checked-out commit stays checked out');
            assert.match(String(summary.waitingFor), /does not contain Overleaf's recorded state/);
            // a tool learns why
            await cleanup.controlListens(t.folder);
            const answer: any = await requestReplica(t.folder, { op: 'sync' }, 10000);
            assert.strictEqual(answer.ok, false, JSON.stringify(answer));
            assert.match(answer.error, /does not contain Overleaf's recorded state/);
            assert.strictEqual(t.w.remote.get('/main.tex'), 'v2\n');
        });

        it('uploads the files of an older commit once the user agrees', async () => {
            const t = host();
            const questions: string[] = [];
            t.mock.window.showWarningMessage = async (message: string, ...items: any[]) => {
                if (items.includes('Upload to Overleaf')) { questions.push(message); return 'Upload to Overleaf'; }
                return undefined;
            };
            const { scm } = await committedV2(t);
            // the replica writes a document with the VFS's writeDoc
            const vfs = t.vfs as any;
            const write = vfs.writeDoc;
            const uploaded = new Promise<void>(resolve => {
                vfs.writeDoc = async (...args: any[]) => {
                    await write(...args);
                    if (t.w.remote.get('/main.tex') === 'v1\n') { resolve(); }
                };
            });
            git(t.folder, 'checkout', '--quiet', '--detach', 'HEAD~1');
            await scm.syncNow();
            await uploaded;
            assert.strictEqual(questions.length, 1, 'the user is asked once');
            assert.strictEqual(t.w.remote.get('/main.tex'), 'v1\n');
            // the record joins the two lines, so that the checked-out commit is Overleaf's state again
            await scm.syncNow();
            execFileSync('git', ['-C', t.folder, 'merge-base', '--is-ancestor', OVERLEAF_REF, 'HEAD']);
        });

        it('does not upload what a checkout under way writes, and tells a tool that it waits for git\'s index lock', async () => {
            const t = host();
            project(t, { '/main.tex': 'v1\n' });
            const { requestReplica } = await start(t);
            await cleanup.controlListens(t.folder);
            // a checkout under way: git holds the index's lock while it writes the files
            const lock = path.join(t.folder, '.git', 'index.lock');
            fs.writeFileSync(lock, '');
            cleanup.add(() => fs.rmSync(lock, { force: true }));
            fs.writeFileSync(path.join(t.folder, 'main.tex'), 'v0, written by a checkout under way\n');
            const answer: any = await requestReplica(t.folder, { op: 'sync' }, 15000);
            assert.strictEqual(t.w.remote.get('/main.tex'), 'v1\n', 'Overleaf keeps its text');
            assert.strictEqual(answer.ok, false, JSON.stringify(answer));
            assert.ok(String(answer.summary?.waitingFor).includes(lock), JSON.stringify(answer));
        });

        it('does not take a change made on Overleaf into a rebase that stopped to edit a commit', async () => {
            const t = host();
            const { scm } = await committedV2(t, { '/other.tex': 'o1\n' });
            git(t.folder, 'config', 'user.name', 'Local User');
            git(t.folder, 'config', 'user.email', 'local@example.com');
            // git rebase -i HEAD~1, with "edit" for the commit: it stops there, HEAD detached
            const editor = path.join(cleanup.tempDir('ow-safety-editor-'), 'edit.js');
            fs.writeFileSync(editor, 'const fs = require("fs"); const f = process.argv[2]; fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^pick /gm, "edit "));\n');
            git(t.folder, '-c', `sequence.editor=${JSON.stringify(process.execPath)} ${JSON.stringify(editor)}`, 'rebase', '--quiet', '-i', 'HEAD~1');
            const stopped = git(t.folder, 'rev-parse', 'HEAD');
            assert.ok(fs.existsSync(path.join(t.folder, '.git', 'rebase-merge')), 'the rebase stopped to edit');
            // a collaborator edits on Overleaf, then a full sync and a sync that records run
            t.remoteChange('/other.tex', 'o2, edited on Overleaf\n');
            await scm.settingItems[0].callback();
            await scm.syncNow();
            assert.strictEqual(git(t.folder, 'rev-parse', 'HEAD'), stopped, 'HEAD stays where the rebase stopped');
            assert.strictEqual(read(path.join(t.folder, 'other.tex')), 'o1\n', 'the rebase\'s work tree is left alone');
            // once the rebase is over, the change made on Overleaf comes in
            git(t.folder, 'rebase', '--abort');
            await scm.settingItems[0].callback();
            assert.strictEqual(read(path.join(t.folder, 'other.tex')), 'o2, edited on Overleaf\n');
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
            const { LocalReplicaSCMProvider } = load(t.mock);
            const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(t.folder));
            const started = await cleanup.start(scm).then(() => 'started', (error: Error) => error);
            if (started === 'started') { await scm.syncNow().catch(() => { /* the test asserts what the sync did */ }); }
            assert.strictEqual(read(path.join(t.folder, 'main.tex')), 'v2, edited while the IDE was closed\n');
            assert.strictEqual(read(stateFile), '{not json');
            assert.strictEqual(t.w.remote.get('/main.tex'), 'v1\n');
            assert.ok(started instanceof Error, 'the replica does not start');
            // the collection's notice of the failed start shows the error
            assert.ok(started.message.includes(stateFile), started.message);
        });
    });
});
