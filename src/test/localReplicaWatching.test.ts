/* eslint-disable @typescript-eslint/naming-convention -- the replica's class name, as the module exports it */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Cleanup, Uri, load, until, wait, world } from './replicaTestWorld';

describe('a local replica that watches its folder itself', () => {
    const cleanup = new Cleanup();
    afterEach(() => cleanup.undo());
    let folder: string;

    async function start(syncOnFileChange: boolean) {
        cleanup.privateRuntime();
        folder = cleanup.tempDir('ow-replica-watch-');
        const t = world(folder, syncOnFileChange);
        t.w.remote.set('/main.tex', 'v1\n');
        const { LocalReplicaSCMProvider, requestReplica } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow(); // the first sync downloads main.tex, and its state is recorded
        await cleanup.controlListens(folder);
        t.w.remoteWrites.length = 0;
        return { ...t, scm, requestReplica };
    }

    it('uploads a file another program writes, without the IDE\'s file events', async () => {
        const t = await start(true);
        assert.deepStrictEqual(t.w.ideWatchers, [], 'no IDE watcher, for the folder or for the project');
        fs.writeFileSync(path.join(folder, 'main.tex'), 'v2, written by another program\n');
        await until(() => t.w.remote.get('/main.tex') === 'v2, written by another program\n');
        fs.writeFileSync(path.join(folder, 'chapter.tex'), 'new\n');
        await until(() => t.w.remote.get('/chapter.tex') === 'new\n');
    });

    it('follows changes on Overleaf that the project reports to it directly', async () => {
        const t = await start(true);
        t.remoteChange('/main.tex', 'v2, edited on Overleaf\n');
        await until(() => fs.readFileSync(path.join(folder, 'main.tex'), 'utf8') === 'v2, edited on Overleaf\n');
        await wait(300);
        assert.deepStrictEqual(t.w.remoteWrites, [], 'its own write does not come back as an upload');
    });

    it('answers a tool\'s request once the file the tool wrote is on Overleaf', async () => {
        const t = await start(true);
        fs.writeFileSync(path.join(folder, 'main.tex'), 'v2, written by a script\n');
        const answer = await t.requestReplica(folder, { op: 'sync' }, 10000);
        assert.strictEqual(answer.ok, true, JSON.stringify(answer));
        assert.strictEqual(t.w.remote.get('/main.tex'), 'v2, written by a script\n');
        assert.strictEqual(answer.watcher, 'node');
        assert.strictEqual(answer.connected, true);
        const status = await t.requestReplica(folder, { op: 'status' }, 10000);
        assert.ok(status.recent.some((r: any) => r.path === '/main.tex' && r.what === 'uploaded'), JSON.stringify(status.recent));
    });

    it('without syncOnFileChange, uploads only new and removed files, unless a tool asks for a sync', async () => {
        const t = await start(false);
        fs.writeFileSync(path.join(folder, 'main.tex'), 'v2, written by another program\n');
        fs.writeFileSync(path.join(folder, 'chapter.tex'), 'new\n');
        await until(() => t.w.remote.get('/chapter.tex') === 'new\n');
        await wait(300);
        assert.strictEqual(t.w.remote.get('/main.tex'), 'v1\n', 'a changed file waits');
        const answer = await t.requestReplica(folder, { op: 'sync' }, 10000);
        assert.strictEqual(answer.ok, true, JSON.stringify(answer));
        assert.deepStrictEqual(answer.summary.uploaded, ['/main.tex']);
        assert.strictEqual(t.w.remote.get('/main.tex'), 'v2, written by another program\n');
    });

    it('ignores saved documents from another file system even when their path matches the replica', async () => {
        cleanup.privateRuntime();
        folder = cleanup.tempDir('ow-replica-save-');
        const t = world(folder, false);
        t.w.remote.set('/main.tex', 'v1\n');
        let saved: ((doc: {uri: Uri}) => void) | undefined;
        t.mock.workspace.onDidSaveTextDocument = (listener: typeof saved) => {
            saved = listener;
            return {dispose: () => { saved = undefined; }};
        };
        const {LocalReplicaSCMProvider} = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        await cleanup.start(scm);
        await scm.syncNow();
        assert.ok(saved, 'the actual editor-save listener is registered');
        const tracked: Array<{path: string, work: Promise<unknown>}> = [];
        const track = (scm as any).track.bind(scm);
        (scm as any).track = (direction: string, file: string, work: Promise<unknown>) => {
            tracked.push({path: file, work});
            return track(direction, file, work);
        };
        const file = Uri.file(path.join(folder, 'main.tex'));
        fs.writeFileSync(file.fsPath, 'v2, saved locally\n');
        for (const scheme of ['overleaf-workshop', 'untitled', 'vscode-remote']) {
            saved({uri: file.with({scheme})});
        }
        saved({uri: file.with({authority: 'another-server'})});
        saved({uri: Uri.file(path.join(`${folder}-other`, 'main.tex'))});
        assert.deepStrictEqual([...tracked], [], 'foreign documents must not enqueue local sync work');
        saved({uri: file});
        assert.strictEqual(tracked.length, 1, 'a real file save still enqueues the replica change');
        assert.strictEqual(tracked[0].path, '/main.tex');
        await Promise.all(tracked.map(entry => entry.work));
        assert.strictEqual(t.w.remote.get('/main.tex'), 'v2, saved locally\n');
    });
});
