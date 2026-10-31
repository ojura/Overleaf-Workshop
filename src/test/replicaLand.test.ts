/* eslint-disable @typescript-eslint/naming-convention -- the replica's class name, as the module exports it */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri, load, until, wait, world } from './replicaTestWorld';

const OVERLEAF_REF = 'refs/remotes/overleaf/main';

/** git in the replica folder */
function git(folder: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8' });
    if (result.status !== 0) { throw new Error(`git ${args.join(' ')}: ${result.stderr}`); }
    return result.stdout.trim();
}

/** A commit with `files` on top of `parent`, made in a clone of the replica's repository, as a tool would. */
function commitInClone(folder: string, clone: string, parent: string, files: Record<string, string | null>, message: string): string {
    if (!fs.existsSync(clone)) { spawnSync('git', ['clone', '--quiet', '--no-checkout', folder, clone]); }
    git(clone, 'fetch', '--quiet', folder, parent);
    git(clone, 'checkout', '--quiet', '-f', '--detach', parent);
    for (const [p, content] of Object.entries(files)) {
        if (content === null) { git(clone, 'rm', '--quiet', p); continue; }
        fs.mkdirSync(path.dirname(path.join(clone, p)), { recursive: true });
        fs.writeFileSync(path.join(clone, p), content);
        git(clone, 'add', p);
    }
    git(clone, '-c', 'user.name=Book Author', '-c', 'user.email=author@example.com', 'commit', '--quiet', '-m', message);
    const commit = git(clone, 'rev-parse', 'HEAD');
    // the replica's repository gets the commit, as git push or git fetch would bring it
    git(folder, 'fetch', '--quiet', clone, `+${commit}:refs/heads/to-land`);
    return commit;
}

describe('landing a commit through the replica\'s window (the land request)', function () {
    this.timeout(20000);
    let folder: string, runtime: string, data: string, clone: string;
    const saved: Record<string, string | undefined> = {};
    let triggers: { dispose(): void }[] = [];

    beforeEach(() => {
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-replica-land-'));
        clone = `${folder}-clone`;
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
        for (const dir of [folder, clone, runtime, data]) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    async function start() {
        const t = world(folder, true);
        t.w.remote.set('/main.tex', 'main v1\n');
        t.w.remote.set('/chapters/one.tex', 'one v1\n');
        t.w.updates.push({ fromV: 0, toV: 3, meta: { end_ts: Date.UTC(2026, 9, 31, 9, 0, 0), users: [{ id: 'a', first_name: 'Alice', last_name: 'Author', email: 'alice@example.com' }] } });
        // the repository exists before the replica starts only to give it a user
        git(folder, 'init', '--quiet', '--initial-branch=main');
        git(folder, 'config', 'user.name', 'Local User');
        git(folder, 'config', 'user.email', 'local@example.com');
        const { LocalReplicaSCMProvider, requestReplica } = load(t.mock);
        const scm = new LocalReplicaSCMProvider(t.vfs, Uri.file(folder));
        triggers = await scm.triggers;
        await until(() => fs.existsSync(path.join(folder, 'chapters', 'one.tex')));
        const first = await requestReplica(folder, { op: 'sync' }, 10000);
        assert.strictEqual(first.ok, true, JSON.stringify(first));
        t.w.remoteWrites.length = 0;
        return { ...t, requestReplica };
    }

    it('records Overleaf\'s state when a tool asks for a sync, and says so in the status', async () => {
        const t = await start();
        const head = git(folder, 'rev-parse', 'HEAD');
        assert.strictEqual(git(folder, 'rev-parse', OVERLEAF_REF), head);
        assert.strictEqual(git(folder, 'log', '-1', '--format=%an', head), 'Alice Author');
        const status: any = await t.requestReplica(folder, { op: 'status' }, 5000);
        assert.deepStrictEqual(status.git, { head, overleaf: head, branch: 'main', unmerged: [] });
    });

    it('pushes a commit: uploads its changes, renames as renames, and Overleaf\'s ref becomes the commit', async () => {
        const t = await start();
        const head = git(folder, 'rev-parse', 'HEAD');
        const commit = commitInClone(folder, clone, head, {
            'main.tex': 'main v2\n', 'chapters/one.tex': null, 'chapters/first.tex': 'one v1\n', 'tests/01.t': 'ok\n',
        }, 'A book commit with a rename');
        const answer: any = await t.requestReplica(folder, { op: 'land', commit }, 10000);
        assert.strictEqual(answer.ok, true, JSON.stringify(answer));
        assert.strictEqual(answer.landed, commit);
        assert.strictEqual(answer.overleaf, commit);
        assert.deepStrictEqual(answer.summary.renamed, [{ from: '/chapters/one.tex', to: '/chapters/first.tex' }]);
        assert.strictEqual(t.w.remote.get('/main.tex'), 'main v2\n');
        assert.strictEqual(t.w.remote.get('/chapters/first.tex'), 'one v1\n');
        assert.strictEqual(t.w.remote.has('/chapters/one.tex'), false);
        assert.strictEqual(t.w.remote.get('/tests/01.t'), 'ok\n');
        assert.strictEqual(git(folder, 'rev-parse', OVERLEAF_REF), commit);
        assert.strictEqual(git(folder, 'rev-parse', 'HEAD'), commit);
        assert.strictEqual(git(folder, 'status', '--porcelain'), '');
    });

    it('refuses a commit that does not descend from Overleaf\'s state, and one while the folder has changes', async () => {
        const t = await start();
        const head = git(folder, 'rev-parse', 'HEAD');
        const first = commitInClone(folder, clone, head, { 'main.tex': 'main v2\n' }, 'One');
        const sibling = commitInClone(folder, clone, head, { 'main.tex': 'main v3\n' }, 'Another');
        assert.strictEqual(((await t.requestReplica(folder, { op: 'land', commit: first }, 10000)) as any).ok, true);
        const refused: any = await t.requestReplica(folder, { op: 'land', commit: sibling }, 10000);
        assert.strictEqual(refused.ok, false);
        assert.match(refused.error, /does not descend from the checked-out commit/);

        const next = commitInClone(folder, clone, first, { 'chapters/one.tex': 'one v2\n' }, 'Next');
        git(folder, 'update-index', '--chmod=+x', 'main.tex');
        const dirty: any = await t.requestReplica(folder, { op: 'land', commit: next }, 10000);
        assert.strictEqual(dirty.ok, false);
        assert.match(dirty.error, /changes that are not committed/);
        assert.strictEqual(t.w.remote.get('/chapters/one.tex'), 'one v1\n');
    });
});
