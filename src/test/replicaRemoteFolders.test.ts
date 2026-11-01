/* eslint-disable @typescript-eslint/naming-convention -- the replica's class name, as the module exports it */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Emitter, Uri, load, wait, world } from './replicaTestWorld';

/** git in the replica folder */
function git(folder: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8' });
    if (result.status !== 0) { throw new Error(`git ${args.join(' ')}: ${result.stderr}`); }
    return result.stdout.trim();
}

/** A project tree as Overleaf sends it: the folder "chapters" with two documents, and the folder "parts". */
function project() {
    const doc = (id: string, name: string, text: string) => ({ _id: id, _type: 'doc', name, remoteCache: text, localCache: text });
    return { rootFolder: [{ _id: 'root', name: 'rootFolder', docs: [doc('main', 'main.tex', 'main\n')], fileRefs: [], folders: [
        { _id: 'chapters', name: 'chapters', docs: [doc('one', 'one.tex', 'one\n'), doc('two', 'two.tex', 'two\n')], fileRefs: [], folders: [] },
        { _id: 'parts', name: 'parts', docs: [], fileRefs: [], folders: [] },
    ] }] };
}

/**
 * The extension's own project tree (VirtualFileSystem), loaded with the replica, over `tree`: the
 * server's events come through `handlers`, and what the replica asks of Overleaf is recorded in
 * `asked` and not sent.
 */
function projectTree(t: ReturnType<typeof world>, tree: any) {
    // the errors the project tree throws, with the codes of the IDE's FileSystemError
    const error = (code: string) => (uri?: Uri) => Object.assign(new Error(`${code}: ${uri?.path ?? ''}`), { code });
    t.mock.FileSystemError = { FileNotFound: error('FileNotFound'), FileIsADirectory: error('FileIsADirectory'), FileExists: error('FileExists'), Unavailable: error('Unavailable') };
    const { VirtualFileSystem } = require('../core/remoteFileSystemProvider');
    const vfs = Object.create(VirtualFileSystem.prototype);
    const handlers: any = {};
    const changes = new Emitter<any[]>();
    const asked: string[] = [];
    const rel = (uri: Uri) => uri.path.slice(t.vfs.origin.path.length);
    Object.assign(vfs, {
        origin: t.vfs.origin, serverName: 'www.overleaf.com', projectName: 'project', projectId: 'p', userId: 'u',
        joinedOnce: true, root: tree, connections: [],
        socket: { isUsingAlternativeConnectionScheme: false, updateEventHandlers(h: any) { Object.assign(handlers, h); } },
        notify: (events: any[]) => changes.fire(events),
        onDidChangeFiles: changes.event,
        getProjectSCMPersist: () => ({ settings: {} }),
        setProjectSCMPersist: () => {},
        getUpdates: async () => ({ updates: [], nextBeforeTimestamp: 0 }),
        documentUpdatesSettled: async () => {},
        createFile: async (uri: Uri) => { asked.push(`create ${rel(uri)}`); throw new Error('not sent in this test'); },
        writeFile: async (uri: Uri) => { asked.push(`write ${rel(uri)}`); throw new Error('not sent in this test'); },
        remove: async (uri: Uri) => { asked.push(`remove ${rel(uri)}`); throw new Error('not sent in this test'); },
        rename: async (from: Uri, to: Uri) => { asked.push(`rename ${rel(from)} ${rel(to)}`); throw new Error('not sent in this test'); },
        mkdir: async (uri: Uri) => { asked.push(`mkdir ${rel(uri)}`); throw new Error('not sent in this test'); },
    });
    vfs.remoteWatch();
    return { vfs, handlers, asked };
}

describe('a local replica over the project tree, when Overleaf moves or deletes a folder', function () {
    this.timeout(20000);
    let folder: string, runtime: string, data: string;
    const saved: Record<string, string | undefined> = {};
    let triggers: { dispose(): void }[] = [];

    beforeEach(() => {
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-replica-folders-'));
        runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-runtime-'));
        data = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-data-'));
        fs.chmodSync(runtime, 0o700);
        for (const key of ['XDG_RUNTIME_DIR', 'XDG_DATA_HOME']) { saved[key] = process.env[key]; }
        process.env.XDG_RUNTIME_DIR = runtime;
        process.env.XDG_DATA_HOME = data;
    });
    afterEach(async () => {
        triggers.forEach(trigger => trigger.dispose());
        triggers = [];
        await wait(300);
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
        }
        for (const dir of [folder, runtime, data]) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    /** A replica of the project over its tree, after its first sync. */
    async function start(tree: any) {
        const t = world(folder, false);
        git(folder, 'init', '--quiet', '--initial-branch=main');
        git(folder, 'config', 'user.name', 'Local User');
        git(folder, 'config', 'user.email', 'local@example.com');
        const { LocalReplicaSCMProvider } = load(t.mock);
        const overleaf = projectTree(t, tree);
        const open = async () => {
            const scm = new LocalReplicaSCMProvider(overleaf.vfs, Uri.file(folder));
            triggers = await scm.triggers;
            await (scm as any).fullSync;
            return scm;
        };
        const scm = await open();
        assert.ok(fs.existsSync(path.join(folder, 'chapters', 'one.tex')), 'the first sync downloads the project');
        /** As after a reconnect: a new provider for the folder, over the tree the project is joined with. */
        const reconnect = async (fresh: any) => {
            triggers.forEach(trigger => trigger.dispose());
            overleaf.vfs.root = fresh;
            return open();
        };
        return { ...t, ...overleaf, scm, reconnect };
    }
    const exists = (p: string) => fs.existsSync(path.join(folder, p));

    it('does not bring back the files of a folder moved on Overleaf, in a later full sync or after a reconnect', async () => {
        const t = await start(project());
        await t.scm.syncNow();
        const first = git(folder, 'rev-parse', 'refs/remotes/overleaf/main');
        t.handlers.onFileMoved('chapters', 'parts');
        await t.scm.syncNow();
        assert.deepStrictEqual([exists('chapters/one.tex'), exists('parts/chapters/one.tex')], [false, true], 'the local files after the move');
        assert.match(git(folder, 'diff', '--name-status', '-M', first, 'refs/remotes/overleaf/main'), /^R100\tchapters\/one.tex\tparts\/chapters\/one.tex$/m, 'git\'s view of the recorded state');

        await (t.scm as any).syncAll();
        assert.deepStrictEqual([exists('chapters/one.tex'), exists('parts/chapters/one.tex')], [false, true], 'the local files after a full sync');

        const moved: any = project();
        moved.rootFolder[0].folders = [{ ...moved.rootFolder[0].folders[1], folders: [moved.rootFolder[0].folders[0]] }];
        await t.reconnect(moved);
        assert.deepStrictEqual([exists('chapters/one.tex'), exists('parts/chapters/one.tex')], [false, true], 'the local files after a reconnect');
        assert.deepStrictEqual(t.asked, [], 'what the replica asked of Overleaf');
    });

    it('deletes the local files of a folder deleted on Overleaf in the next full sync, and asks nothing of Overleaf', async () => {
        const t = await start(project());
        t.handlers.onFileRemoved('chapters');
        await (t.scm as any).syncAll();
        assert.deepStrictEqual([exists('chapters/one.tex'), exists('main.tex')], [false, true], 'the local files after a full sync');
        assert.deepStrictEqual(t.asked, [], 'what the replica asked of Overleaf');
    });
});
