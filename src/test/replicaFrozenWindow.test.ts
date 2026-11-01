/* eslint-disable @typescript-eslint/naming-convention -- the replica's class name, as the module exports it */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Cleanup, Uri, load, until, world } from './replicaTestWorld';

// While the IDE's window does not run (its page frozen in the background), every call of
// vscode.workspace.fs waits for it, even for a local file. The local replica must keep syncing
// then: it reads and writes its folder with Node's own functions (src/scm/localFolderFs.ts).
describe('a local replica while the IDE\'s window does not answer', function () {
    this.timeout(15000);
    const cleanup = new Cleanup();
    afterEach(() => cleanup.undo());
    let folder: string;
    /** the test's own XDG_DATA_HOME: its Trash, so that gio leaves the user's alone */
    let data: string;

    async function start() {
        ({ data } = cleanup.privateRuntime());
        folder = cleanup.tempDir('ow-replica-frozen-');
        const t = world(folder, true, { windowFrozen: true });
        t.w.remote.set('/main.tex', 'v1\n');
        t.w.remote.set('/old.tex', 'to be deleted on Overleaf\n');
        const { LocalReplicaSCMProvider, requestReplica } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow(); // the first sync downloads both files, and its state is recorded
        await cleanup.controlListens(folder);
        t.w.remoteWrites.length = 0;
        return { ...t, requestReplica };
    }

    it('makes its first sync, and writes its saved state', async () => {
        await start();
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'v1\n');
        assert.ok(fs.existsSync(path.join(folder, '.git', 'overleaf', 'state.json')));
    });

    it('uploads new, changed and deleted files that another program writes', async () => {
        const t = await start();
        fs.writeFileSync(path.join(folder, 'main.tex'), 'v2, written while the window sleeps\n');
        await until(() => t.w.remote.get('/main.tex') === 'v2, written while the window sleeps\n');
        fs.mkdirSync(path.join(folder, 'chapters'));
        fs.writeFileSync(path.join(folder, 'chapters', 'one.tex'), 'new\n');
        await until(() => t.w.remote.get('/chapters/one.tex') === 'new\n');
        fs.rmSync(path.join(folder, 'chapters', 'one.tex'));
        await until(() => !t.w.remote.has('/chapters/one.tex'));
    });

    it('answers a tool\'s request for a sync', async () => {
        const t = await start();
        fs.writeFileSync(path.join(folder, 'main.tex'), 'v2, written by a script\n');
        const answer = await t.requestReplica(folder, { op: 'sync' }, 5000);
        assert.strictEqual(answer.ok, true, JSON.stringify(answer));
        assert.strictEqual(t.w.remote.get('/main.tex'), 'v2, written by a script\n');
    });

    it('applies changes and deletions made on Overleaf', async () => {
        const t = await start();
        t.remoteChange('/main.tex', 'v2, edited on Overleaf\n');
        await until(() => fs.readFileSync(path.join(folder, 'main.tex'), 'utf8') === 'v2, edited on Overleaf\n');
        t.remoteDelete('/old.tex');
        await until(() => !fs.existsSync(path.join(folder, 'old.tex')));
        if (process.platform === 'linux' && spawnSync('gio', ['--version']).status === 0) {
            // into the trash, through gio, as the IDE would: here the test's own, in XDG_DATA_HOME
            assert.ok(fs.existsSync(path.join(data, 'Trash', 'files', 'old.tex')), 'in the trash');
        }
    });
});
