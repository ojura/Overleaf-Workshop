import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { load, Uri, world } from './replicaTestWorld';
import { strict } from './standIn';

const selected = Uri.parse('overleaf-workshop://www.overleaf.com/Selected?user=u&project=selected');
const other = Uri.parse('overleaf-workshop://www.overleaf.com/Other?user=u&project=other');

describe('preparing a local replica for an explicitly selected project', () => {
    let parent: string;
    let replica: any;
    let entries: Map<string, any>;
    let save: (key: string, value: any) => Promise<void>;
    let vfs: any;

    beforeEach(async () => {
        parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'overleaf-project-opening-'));
        replica = load(world(parent, false).mock).LocalReplicaSCMProvider;
        entries = new Map();
        save = async (key, value) => { entries.set(key, value); };
        vfs = strict('selected VFS metadata and registry', {
            origin: selected,
            serverName: selected.authority,
            projectId: 'selected',
            projectName: 'Selected',
            getProjectSCMPersist: (key: string) => entries.get(key),
            setProjectSCMPersist: (key: string, value: any) => save(key, value),
        });
    });

    afterEach(async () => { await fs.promises.rm(parent, {recursive: true, force: true}); });

    const settingsPath = (folder: string) => path.join(folder, '.overleaf', 'settings.json');
    async function writeSettings(folder: string, uri: Uri, extra: Record<string, unknown> = {}) {
        await fs.promises.mkdir(path.dirname(settingsPath(folder)), {recursive: true});
        const text = JSON.stringify({uri: uri.toString(), serverName: uri.authority, projectName: 'Old Name', ...extra}, null, 4);
        await fs.promises.writeFile(settingsPath(folder), text);
        return text;
    }

    it('creates the project subfolder, settings and awaited registration without starting or disposing a VFS', async () => {
        let started!: () => void;
        const saving = new Promise<void>(resolve => { started = resolve; });
        let release!: () => void;
        const persisted = new Promise<void>(resolve => { release = resolve; });
        save = async (key, value) => { started(); await persisted; entries.set(key, value); };
        let settled = false;
        const creating = replica.createReplica(vfs, Uri.file(parent)).then((folder: Uri) => { settled = true; return folder; });
        await saving;
        assert.strictEqual(settled, false, 'opening must wait for the registry write');
        release();
        const folder = await creating;
        assert.strictEqual(folder.fsPath, path.join(parent, 'Selected'));
        const settings = JSON.parse(await fs.promises.readFile(settingsPath(folder.fsPath), 'utf8'));
        assert.deepStrictEqual(settings, {uri: selected.toString(), serverName: selected.authority, projectName: 'Selected'});
        assert.deepStrictEqual(entries.get(folder.toString()), {enabled: true, label: 'Local Replica', baseUri: folder.toString(), settings: {}});
        assert.strictEqual(await replica.isReplicaForProject(folder, selected), true);
    });

    it('uses an already named empty folder without nesting the project name twice', async () => {
        const folder = Uri.file(path.join(parent, 'Selected'));
        await fs.promises.mkdir(folder.fsPath);
        assert.strictEqual((await replica.createReplica(vfs, folder)).fsPath, folder.fsPath);
    });

    it('reuses matching project metadata after a project or local folder rename without rewriting user settings', async () => {
        const folder = Uri.file(path.join(parent, 'Renamed local folder'));
        const oldUri = selected.with({path: '/Previous%20project%20name', query: 'user=previous-user&project=selected'});
        const original = await writeSettings(folder.fsPath, oldUri, {enableCompileNPreview: false, custom: 'keep'});
        entries.set(folder.toString(), {enabled: false, label: 'Local Replica', baseUri: folder.toString(), settings: {custom: true}});
        assert.strictEqual(await replica.isReplicaForProject(folder, selected), true);
        assert.strictEqual((await replica.createReplica(vfs, folder)).fsPath, folder.fsPath);
        assert.strictEqual(await fs.promises.readFile(settingsPath(folder.fsPath), 'utf8'), original);
        assert.strictEqual(entries.get(folder.toString()).enabled, false);
        assert.deepStrictEqual(entries.get(folder.toString()).settings, {custom: true});
    });

    it('refuses a nonempty unrelated destination without adding metadata or changing its files', async () => {
        const folder = path.join(parent, 'Selected');
        await fs.promises.mkdir(folder);
        await fs.promises.writeFile(path.join(folder, 'notes.txt'), 'Unrelated work');
        await assert.rejects(replica.createReplica(vfs, Uri.file(parent)), /not empty|unrelated/i);
        assert.deepStrictEqual(await fs.promises.readdir(folder), ['notes.txt']);
        assert.strictEqual(await fs.promises.readFile(path.join(folder, 'notes.txt'), 'utf8'), 'Unrelated work');
        assert.strictEqual(entries.size, 0);
    });

    it('refuses another project at the destination without changing its metadata', async () => {
        const folder = path.join(parent, 'Selected');
        const original = await writeSettings(folder, other);
        await assert.rejects(replica.createReplica(vfs, Uri.file(parent)), /different project/i);
        assert.strictEqual(await fs.promises.readFile(settingsPath(folder), 'utf8'), original);
        assert.strictEqual(entries.size, 0);
    });

    it('refuses a selected parent that is itself another project replica', async () => {
        const original = await writeSettings(parent, other);
        await assert.rejects(replica.createReplica(vfs, Uri.file(parent)), /different project/i);
        assert.strictEqual(await fs.promises.readFile(settingsPath(parent), 'utf8'), original);
        assert.deepStrictEqual(await fs.promises.readdir(parent), ['.overleaf']);
    });

    it('preserves malformed settings and reports the unusable destination', async () => {
        const folder = path.join(parent, 'Selected');
        await fs.promises.mkdir(path.dirname(settingsPath(folder)), {recursive: true});
        await fs.promises.writeFile(settingsPath(folder), '{ broken');
        await assert.rejects(replica.createReplica(vfs, Uri.file(parent)), /settings|JSON/i);
        assert.strictEqual(await fs.promises.readFile(settingsPath(folder), 'utf8'), '{ broken');
        assert.strictEqual(entries.size, 0);
    });

    it('only recognizes directories with matching server and project metadata', async () => {
        const missing = Uri.file(path.join(parent, 'missing'));
        assert.strictEqual(await replica.isReplicaForProject(missing, selected), false);
        await fs.promises.mkdir(missing.fsPath);
        assert.strictEqual(await replica.isReplicaForProject(missing, selected), false);
        await writeSettings(missing.fsPath, other);
        assert.strictEqual(await replica.isReplicaForProject(missing, selected), false);
        await writeSettings(missing.fsPath, selected.with({authority: 'another.overleaf.example'}));
        assert.strictEqual(await replica.isReplicaForProject(missing, selected), false);
        await writeSettings(missing.fsPath, selected.with({scheme: 'https'}));
        assert.strictEqual(await replica.isReplicaForProject(missing, selected), false);
        await writeSettings(missing.fsPath, selected);
        assert.strictEqual(await replica.isReplicaForProject(missing, selected), true);
    });
});
