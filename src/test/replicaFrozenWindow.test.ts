/* eslint-disable @typescript-eslint/naming-convention -- the replica's class name, as the module exports it */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri, load, until, wait, world } from './replicaTestWorld';

// While the IDE's window does not run (its page frozen in the background), every call of
// vscode.workspace.fs waits for it, even for a local file. The local replica must keep syncing
// then: it reads and writes its folder with Node's own functions (src/scm/localFolderFs.ts).
describe('a local replica while the IDE\'s window does not answer', function () {
    this.timeout(15000);
    let folder: string;
    let runtime: string;
    let data: string;
    const saved: Record<string, string | undefined> = {};
    let triggers: { dispose(): void }[] = [];

    beforeEach(() => {
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-replica-frozen-'));
        runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-runtime-'));
        data = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-data-')); // its Trash, so gio never uses the user's
        fs.chmodSync(runtime, 0o700);
        for (const key of ['XDG_RUNTIME_DIR', 'XDG_DATA_HOME']) { saved[key] = process.env[key]; }
        process.env.XDG_RUNTIME_DIR = runtime;
        process.env.XDG_DATA_HOME = data;
    });
    afterEach(async () => {
        triggers.forEach(trigger => trigger.dispose());
        triggers = [];
        await wait(50);
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
        }
        for (const dir of [folder, runtime, data]) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    async function start() {
        const t = world(folder, true, { windowFrozen: true });
        t.w.remote.set('/main.tex', 'v1\n');
        t.w.remote.set('/old.tex', 'to be deleted on Overleaf\n');
        const { LocalReplicaSCMProvider, requestReplica } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        triggers = await scm.triggers;
        await until(() => fs.existsSync(path.join(folder, 'main.tex')) && fs.existsSync(path.join(folder, 'old.tex')));
        await wait(200);
        t.w.remoteWrites.length = 0;
        return { ...t, requestReplica };
    }

    it('makes its first sync, and writes its saved state', async () => {
        await start();
        assert.strictEqual(fs.readFileSync(path.join(folder, 'main.tex'), 'utf8'), 'v1\n');
        await until(() => fs.existsSync(path.join(folder, '.overleaf', 'sync', 'state.json')));
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
