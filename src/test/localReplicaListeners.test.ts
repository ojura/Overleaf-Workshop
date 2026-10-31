/* eslint-disable @typescript-eslint/naming-convention -- the replica's class name, as the module exports it */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri, load, until, wait, world } from './replicaTestWorld';

// The replica reads and writes its folder with Node's own functions, so these tests use a real
// folder; the replicas start a control socket (src/scm/replicaControl.ts), kept out of the
// user's runtime folder.
let folder: string;
let runtime: string;
let savedRuntime: string | undefined;
let triggers: { dispose(): void }[] = [];
beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-replica-listeners-'));
    runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-runtime-'));
    fs.chmodSync(runtime, 0o700);
    savedRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtime;
});
afterEach(async () => {
    triggers.forEach(trigger => trigger.dispose());
    triggers = [];
    await wait(50);
    if (savedRuntime === undefined) { delete process.env.XDG_RUNTIME_DIR; } else { process.env.XDG_RUNTIME_DIR = savedRuntime; }
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
});

describe('LocalReplicaSCMProvider when the first sync fails', () => {
    it('keeps its listeners, reports the failure and uploads later changes', async () => {
        const t = world(folder, true);
        const warnings: string[] = [];
        t.mock.window.showWarningMessage = async (message: string) => { warnings.push(message); return undefined; };
        // the project cannot be listed
        (t.vfs as any).init = async () => { throw new Error('getaddrinfo EAI_AGAIN www.overleaf.com'); };
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));

        triggers = await scm.triggers;
        await until(() => warnings.length > 0);
        assert.ok(triggers.length > 2, 'the listeners are registered');
        assert.strictEqual(warnings.length, 1, 'the failure is reported once');
        assert.match(warnings[0], /EAI_AGAIN/);

        // a file created afterwards is still uploaded
        fs.writeFileSync(path.join(folder, 'new.tex'), 'new');
        await until(() => t.w.remoteWrites.includes('/new.tex'));
        assert.deepStrictEqual(t.w.remoteWrites, ['/new.tex']);
    });
});

describe('LocalReplicaSCMProvider when a live sync fails', () => {
    it('says why, offers Sync Now, and keeps one such notice open at a time', async () => {
        const t = world(folder, true);
        const warnings: string[] = [];
        const offered: string[][] = [];
        const answers: Array<(choice?: string) => void> = [];
        t.mock.window.showWarningMessage = (message: string, ...items: string[]) => {
            warnings.push(message);
            offered.push(items);
            return new Promise(resolve => answers.push(resolve));
        };
        // the project is empty and reachable at first; then the connection is gone
        (t.vfs as any).createFile = async () => { throw new Error('Not connected to www.overleaf.com; reconnecting in the background.'); };
        const { LocalReplicaSCMProvider } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        triggers = await scm.triggers;
        await wait(300);
        assert.deepStrictEqual(warnings, []);

        fs.writeFileSync(path.join(folder, 'INDEXING.md'), 'INDEXING.md');
        await until(() => warnings.length > 0);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /\/INDEXING\.md \(Not connected to www\.overleaf\.com; reconnecting in the background\.\)/);
        assert.ok(offered[0].includes('Sync Now'));

        // while that notice is open, more failures only go to the log
        fs.writeFileSync(path.join(folder, 'index-terms.txt'), 'index-terms.txt');
        await wait(500);
        assert.strictEqual(warnings.length, 1);

        // once it is closed, the next failure opens a new one
        answers[0](undefined);
        await wait(50);
        fs.writeFileSync(path.join(folder, 'latexmkrc'), 'latexmkrc');
        await until(() => warnings.length === 2);
    });
});
