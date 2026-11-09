/* eslint-disable @typescript-eslint/naming-convention -- the replica's exported class */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Cleanup, Uri, load, world } from './replicaTestWorld';
import { AsyncGit } from '../scm/replicaGit';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return {promise, resolve};
}

describe('the replica setting to respect .gitignore', function () {
    this.timeout(10_000);
    let cleanup: Cleanup, folder: string;
    beforeEach(() => {
        cleanup = new Cleanup();
        cleanup.privateRuntime();
        folder = cleanup.tempDir('replica-gitignore-');
    });
    afterEach(() => cleanup.undo());

    function persistedWorld() {
        const t = world(folder, false);
        const persists = new Map<string, any>();
        (t.vfs as any).getProjectSCMPersist = (key: string) => persists.get(key) ?? {settings: {}};
        (t.vfs as any).setProjectSCMPersist = (key: string, value: any) => { persists.set(key, value); };
        return {...t, persists};
    }

    async function chooseRespect(t: ReturnType<typeof persistedWorld>, scm: any, enabled: boolean) {
        t.mock.window.showQuickPick = async (items: {enabled: boolean}[]) => items.find(item => item.enabled === enabled);
        await scm.settingItems.find((item: {label: string}) => item.label === 'Respect .gitignore ...').callback();
    }

    it('defaults to enabled in an existing replica with no saved setting', async () => {
        fs.writeFileSync(path.join(folder, '.gitignore'), '*.generated\n');
        const t = world(folder, false);
        fs.mkdirSync(path.join(folder, '.overleaf'));
        fs.writeFileSync(path.join(folder, '.overleaf/settings.json'), JSON.stringify({uri: t.vfs.origin.toString()}));
        t.w.remote.set('/main.tex', 'document\n');
        t.w.remote.set('/build.generated', 'generated output\n');
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow();
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'document\n');
        assert.strictEqual(fs.existsSync(path.join(folder, 'build.generated')), false,
            'a matching remote file must stay outside the replica sync');
        assert.strictEqual(t.w.remote.get('/build.generated'), 'generated output\n', 'ignoring keeps the remote file');
    });

    it('also defaults to enabled when a new replica is created', async () => {
        const t = persistedWorld();
        const { LocalReplicaSCMProvider } = load(t.mock);
        const base = await LocalReplicaSCMProvider.createReplica(t.vfs, Uri.file(folder));
        fs.writeFileSync(path.join(base.fsPath, '.gitignore'), '*.generated\n');
        t.w.remote.set('/main.tex', 'document\n');
        t.w.remote.set('/new.generated', 'generated\n');
        const scm = new LocalReplicaSCMProvider(t.vfs, base);
        await cleanup.start(scm);
        await scm.syncNow();
        assert.strictEqual(fs.existsSync(path.join(base.fsPath, 'new.generated')), false);
        assert.strictEqual(t.persists.get(base.toString()).settings['respect-gitignore'], undefined, 'the absent setting uses its default');
    });

    it('can be disabled in one replica while another replica of the same project stays enabled', async () => {
        const other = cleanup.tempDir('replica-gitignore-other-');
        for (const root of [folder, other]) { fs.writeFileSync(path.join(root, '.gitignore'), '*.generated\n'); }
        const t = persistedWorld();
        t.w.remote.set('/main.tex', 'document\n');
        t.w.remote.set('/build.generated', 'generated output\n');
        t.w.remote.set('/main.aux', 'configured exclusion\n');
        const { LocalReplicaSCMProvider } = load(t.mock);
        const first = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        const second = new LocalReplicaSCMProvider(t.vfs, Uri.file(other));
        await cleanup.start(first);
        await cleanup.start(second);
        await Promise.all([first.syncNow(), second.syncNow()]);
        await chooseRespect(t, first, false);
        await Promise.all([first.syncNow(), second.syncNow()]);
        assert.strictEqual(t.persists.get(Uri.file(folder).toString()).settings['respect-gitignore'], false);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'build.generated'), 'utf8'), 'generated output\n');
        assert.strictEqual(fs.existsSync(path.join(other, 'build.generated')), false, 'the other replica keeps the default');
        assert.strictEqual(fs.existsSync(path.join(folder, 'main.aux')), false, 'configured patterns still apply when disabled');
    });

    it('rechecks changed, removed and new ignore files during normal sync', async () => {
        fs.writeFileSync(path.join(folder, '.gitignore'), '*.generated\n');
        const t = persistedWorld();
        t.w.remote.set('/main.tex', 'document\n');
        t.w.remote.set('/build.generated', 'generated output\n');
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow();
        assert.strictEqual(fs.existsSync(path.join(folder, 'build.generated')), false);
        fs.unlinkSync(path.join(folder, '.gitignore'));
        await scm.syncNow();
        assert.strictEqual(fs.readFileSync(path.join(folder, 'build.generated'), 'utf8'), 'generated output\n');
        fs.writeFileSync(path.join(folder, '.gitignore'), '*.generated\n');
        fs.writeFileSync(path.join(folder, 'build.generated'), 'local work\n');
        t.w.remote.set('/build.generated', 'remote work\n');
        await scm.syncNow();
        assert.strictEqual(fs.readFileSync(path.join(folder, 'build.generated'), 'utf8'), 'local work\n');
        assert.strictEqual(t.w.remote.get('/build.generated'), 'remote work\n');
    });

    it('ignores already tracked files without deleting either side or dropping their Git content', async () => {
        fs.writeFileSync(path.join(folder, '.gitignore'), '*.generated\n');
        const t = persistedWorld();
        t.persists.set(Uri.file(folder).toString(), {settings: {'respect-gitignore': false}});
        t.w.remote.set('/main.tex', 'document\n');
        t.w.remote.set('/local.generated', 'initial local\n');
        t.w.remote.set('/remote.generated', 'initial remote\n');
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow();
        const git = new AsyncGit(folder);
        const tracked = (await git.text(['ls-files'])).split('\n');
        assert.ok(tracked.includes('local.generated') && tracked.includes('remote.generated'));
        fs.writeFileSync(path.join(folder, 'local.generated'), 'local work\n');
        t.w.remote.set('/local.generated', 'remote work\n');
        await chooseRespect(t, scm, true);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'local.generated'), 'utf8'), 'local work\n');
        assert.strictEqual(t.w.remote.get('/local.generated'), 'remote work\n');
        fs.unlinkSync(path.join(folder, 'local.generated'));
        t.w.remote.delete('/remote.generated');
        await scm.syncNow();
        assert.strictEqual(t.w.remote.get('/local.generated'), 'remote work\n', 'local absence does not delete an ignored remote file');
        assert.strictEqual(fs.readFileSync(path.join(folder, 'remote.generated'), 'utf8'), 'initial remote\n',
            'remote absence does not delete an ignored local file');
        assert.strictEqual(await git.text(['show', 'HEAD:local.generated']), 'initial local');
        assert.strictEqual(await git.text(['show', 'HEAD:remote.generated']), 'initial remote');
    });

    it('stops a pending upload when the path becomes ignored while its comparison reads Overleaf', async () => {
        fs.writeFileSync(path.join(folder, '.gitignore'), '*.generated\n');
        const t = persistedWorld();
        const key = Uri.file(folder).toString();
        t.persists.set(key, {settings: {'respect-gitignore': false}});
        t.w.remote.set('/main.tex', 'document\n');
        t.w.remote.set('/build.generated', 'original\n');
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow();
        const entered = deferred(), release = deferred();
        cleanup.add(() => release.resolve());
        const open = t.vfs.openFile;
        t.vfs.openFile = async (uri: Uri) => {
            if (uri.path.endsWith('/build.generated')) { entered.resolve(); await release.promise; }
            return open(uri);
        };
        fs.writeFileSync(path.join(folder, 'build.generated'), 'local work\n');
        const work = scm.sync.localChanged('/build.generated');
        await entered.promise;
        const saved = deferred();
        const save = t.vfs.setProjectSCMPersist;
        (t.vfs as any).setProjectSCMPersist = (name: string, value: any) => {
            (save as any)(name, value);
            saved.resolve();
        };
        const changing = chooseRespect(t, scm, true);
        await saved.promise;
        release.resolve();
        await Promise.all([work, changing]);
        await scm.syncNow();
        assert.strictEqual(t.w.remote.get('/build.generated'), 'original\n');
        assert.strictEqual(fs.readFileSync(path.join(folder, 'build.generated'), 'utf8'), 'local work\n');
    });

    it('cancels an open setting picker and ignores its late answer after removal aborts it', async () => {
        const t = persistedWorld();
        t.w.remote.set('/main.tex', 'document\n');
        let cancelled = 0, disposed = 0;
        t.mock.CancellationTokenSource = class {
            token = {};
            cancel() { cancelled++; }
            dispose() { disposed++; }
        };
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow();
        const opened = deferred();
        let answer!: (value: {enabled: boolean}) => void;
        t.mock.window.showQuickPick = () => new Promise(resolve => { answer = resolve; opened.resolve(); });
        const controller = new AbortController();
        const work = scm.settingItems.find((item: {label: string}) => item.label === 'Respect .gitignore ...').callback(controller.signal);
        await opened.promise;
        controller.abort();
        answer({enabled: false});
        await work;
        assert.strictEqual(cancelled, 1);
        assert.strictEqual(disposed, 1);
        assert.strictEqual(t.persists.has(Uri.file(folder).toString()), false, 'a late answer does not recreate settings');
    });

    it('compares newly included files after a setting changes during an existing comparison', async () => {
        fs.writeFileSync(path.join(folder, '.gitignore'), '*.generated\n');
        const t = persistedWorld();
        t.w.remote.set('/main.tex', 'document\n');
        t.w.remote.set('/build.generated', 'generated output\n');
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow();
        const entered = deferred(), release = deferred(), saved = deferred();
        cleanup.add(() => release.resolve());
        const open = t.vfs.openFile;
        let first = true;
        t.vfs.openFile = async (uri: Uri) => {
            if (first && uri.path.endsWith('/main.tex')) { first = false; entered.resolve(); await release.promise; }
            return open(uri);
        };
        const comparison = scm.settingItems[0].callback();
        await entered.promise; // the comparison has already captured its paths without build.generated
        const save = t.vfs.setProjectSCMPersist;
        (t.vfs as any).setProjectSCMPersist = (key: string, value: any) => { (save as any)(key, value); saved.resolve(); };
        const changing = chooseRespect(t, scm, false);
        await saved.promise;
        release.resolve();
        await Promise.all([comparison, changing]);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'build.generated'), 'utf8'), 'generated output\n');
    });

    it('does not recreate removed settings when enabling waits for ignore rules', async () => {
        fs.writeFileSync(path.join(folder, '.gitignore'), '*.generated\n');
        const t = persistedWorld();
        const key = Uri.file(folder).toString();
        t.persists.set(key, {settings: {'respect-gitignore': false}});
        t.w.remote.set('/main.tex', 'document\n');
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow();
        const entered = deferred(), release = deferred();
        cleanup.add(() => release.resolve());
        const rules = scm.gitIgnore, refresh = rules.refresh.bind(rules);
        rules.refresh = async () => { entered.resolve(); await release.promise; await refresh(); };
        cleanup.add(() => { rules.refresh = refresh; });
        t.mock.window.showQuickPick = async () => ({enabled: true});
        const controller = new AbortController();
        const changing = scm.settingItems.find((item: {label: string}) => item.label === 'Respect .gitignore ...').callback(controller.signal);
        await entered.promise;
        controller.abort();
        t.persists.delete(key);
        release.resolve();
        await changing;
        assert.strictEqual(t.persists.has(key), false, 'rule preparation must not revive a removed replica');
    });

    it('leaves a previously offered local-only file alone after a rule starts ignoring it', async () => {
        fs.writeFileSync(path.join(folder, 'local.generated'), 'local output\n');
        const t = persistedWorld();
        t.w.remote.set('/main.tex', 'document\n');
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow();
        assert.deepStrictEqual(scm.sync.untracked, ['/local.generated']);
        fs.writeFileSync(path.join(folder, '.gitignore'), '*.generated\n');
        await scm.syncNow();
        assert.deepStrictEqual(scm.sync.untracked, [], 'ignored files disappear from the upload offer');
        const result = await scm.sync.uploadUntracked();
        assert.deepStrictEqual(result.uploaded, []);
        assert.strictEqual(t.w.remote.has('/local.generated'), false);
        assert.strictEqual(t.w.remoteWrites.includes('/local.generated'), false);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'local.generated'), 'utf8'), 'local output\n');
    });

    it('reads the landed commit\'s ignore rules before uploading a tracked archive without watcher events', async () => {
        const t = persistedWorld();
        t.w.remote.set('/main.tex', 'document\n');
        const { LocalReplicaSCMProvider, requestReplica } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        // No filesystem event can prepare the new rules before the landing's own comparison.
        scm.localEvent = async () => {};
        scm.scanFolder = () => undefined;
        await cleanup.start(scm);
        await scm.syncNow();
        await cleanup.controlListens(folder);
        const git = new AsyncGit(folder);
        const head = await git.text(['rev-parse', 'HEAD']);
        const clone = cleanup.tempDir('replica-gitignore-land-');
        await git.run(['clone', '--quiet', '--no-checkout', folder, clone]);
        const author = new AsyncGit(clone);
        await author.run(['checkout', '--quiet', '--detach', head]);
        fs.writeFileSync(path.join(clone, '.gitignore'), '*.generated\n');
        fs.writeFileSync(path.join(clone, 'archive.generated'), 'generated archive\n');
        fs.writeFileSync(path.join(clone, 'main.tex'), 'landed document\n');
        await author.run(['add', '--force', '.gitignore', 'archive.generated', 'main.tex']);
        await author.run(['-c', 'user.name=Test Author', '-c', 'user.email=author@example.com', 'commit', '--quiet', '-m', 'Document and generated archive']);
        const commit = await author.text(['rev-parse', 'HEAD']);
        await git.run(['fetch', '--quiet', clone, `${commit}:refs/heads/to-land`]);
        t.w.remoteWrites.length = 0;
        const answer: any = await requestReplica(folder, {op: 'land', commit}, 10_000);
        assert.strictEqual(answer.ok, true, JSON.stringify(answer));
        assert.strictEqual(answer.landed, commit);
        assert.strictEqual(answer.overleaf, commit);
        assert.strictEqual(t.w.remote.get('/main.tex'), 'landed document\n');
        assert.strictEqual(t.w.remote.has('/archive.generated'), false);
        assert.deepStrictEqual(t.w.remoteWrites, ['/main.tex']);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'archive.generated'), 'utf8'), 'generated archive\n');
        assert.strictEqual(await git.text(['show', 'HEAD:archive.generated']), 'generated archive');
    });
});
