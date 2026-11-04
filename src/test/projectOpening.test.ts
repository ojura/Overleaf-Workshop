/* eslint-disable @typescript-eslint/naming-convention -- mirrors VS Code and the extension module exports */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Emitter, load, Uri, world } from './replicaTestWorld';
import { loadWithVscode, strict } from './standIn';

const prefix = 'overleaf-workshop.projectManager.';
const projectUri = 'overleaf-workshop://www.overleaf.com/Selected?user=u&project=selected';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return {promise, resolve};
}

class Picker {
    placeholder = '';
    items: any[] = [];
    selectedItems: any[] = [];
    ignoreFocusOut = false;
    disposed = false;
    readonly shown = deferred<void>();
    readonly accept = new Set<() => unknown>();
    readonly hide = new Set<() => unknown>();
    readonly button = new Set<(event: any) => unknown>();
    private listen<T>(set: Set<T>, listener: T) { set.add(listener); return {dispose: () => set.delete(listener)}; }
    onDidAccept = (fn: () => unknown) => this.listen(this.accept, fn);
    onDidHide = (fn: () => unknown) => this.listen(this.hide, fn);
    onDidTriggerItemButton = (fn: (event: any) => unknown) => this.listen(this.button, fn);
    show() { this.shown.resolve(); }
    dispose() { this.disposed = true; }
    async choose(index: number) { this.selectedItems = [this.items[index]]; await Promise.all([...this.accept].map(fn => fn())); }
    async cancel() { await Promise.all([...this.hide].map(fn => fn())); }
    async blur() { if (!this.ignoreFocusOut) { await this.cancel(); } }
    async remove(index: number) {
        const item = this.items[index];
        await Promise.all([...this.button].map(fn => fn({item, button: item.buttons[0]})));
    }
    assertClosed() {
        assert.strictEqual(this.disposed, true);
        assert.strictEqual(this.accept.size + this.hide.size + this.button.size, 0, 'picker event subscriptions are released');
    }
}

function setup() {
    const picker = new Picker();
    const persists: Record<string, any> = {};
    const valid = new Set<string>();
    const calls: {command: string; args: any[]}[] = [];
    const errors: string[] = [];
    const created: {vfs: unknown; parent: Uri}[] = [];
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const selectedVfs = strict('selected project VFS', {projectId: 'selected'});
    const state = {
        folder: undefined as Uri | undefined,
        dialogCalls: 0,
        pickerCalls: 0,
        warningAnswer: 'Yes' as string | undefined,
        workspaceFolders: [] as {uri: Uri}[],
        validate: async (folder: Uri, _project: Uri) => valid.has(folder.fsPath),
        create: async (vfs: unknown, parent: Uri) => {
            created.push({vfs, parent});
            return Uri.joinPath(parent, 'Selected');
        },
        remove: async (key: string) => { delete persists[key]; },
    };
    const api = {getAllTags: async () => ({type: 'success', tags: []})};
    const globals = strict('project registry', {
        getServerProjectSCMPersists: (_context: unknown, server: string, project: string) => {
            assert.strictEqual(server, 'www.overleaf.com');
            assert.strictEqual(project, 'selected');
            return persists;
        },
        updateServerProjectSCMPersist: (_context: unknown, _server: string, _project: string, key: string) => state.remove(key),
        getServers: () => ({server: {api, server: {name: 'www.overleaf.com', login: {username: 'user'}}}}),
        fetchServerProjects: async () => [
            {id: 'selected', name: 'Selected', userId: 'u'},
            {id: 'archived', name: 'Archived', userId: 'u', archived: true},
        ],
        authenticate: async () => ({}),
    });
    const replica = strict('local replica opening API', {
        label: 'Local Replica',
        isReplicaForProject: async (folder: Uri, project: Uri) => {
            assert.strictEqual(project.toString(), projectUri);
            return state.validate(folder, project);
        },
        createReplica: (vfs: unknown, parent: Uri) => state.create(vfs, parent),
    });
    const mock = strict('vscode project opening', {
        Uri,
        TreeItem: class { constructor(public label: string) {} },
        TreeItemCollapsibleState: {None: 0, Collapsed: 1},
        ThemeIcon: class { constructor(public id: string) {} },
        EventEmitter: Emitter,
        l10n: {t: (message: string, args?: Record<string, unknown>) => message.replace(/\{(\w+)\}/g, (_m, key) => String(args?.[key]))},
        workspace: {get workspaceFolders() { return state.workspaceFolders; }},
        window: strict('project opening window', {
            registerTreeDataProvider: () => ({dispose() {}}),
            createQuickPick: () => { state.pickerCalls++; return picker; },
            showOpenDialog: async () => { state.dialogCalls++; return state.folder ? [state.folder] : undefined; },
            showErrorMessage: async (message: string) => { errors.push(message); },
            showWarningMessage: async () => state.warningAnswer,
        }),
        commands: strict('project opening commands', {
            registerCommand: (id: string, fn: (...args: any[]) => unknown) => {
                handlers.set(id, fn);
                return {dispose: () => handlers.delete(id)};
            },
            executeCommand: async (command: string, ...args: any[]) => {
                calls.push({command, args});
                if (command === 'remoteFileSystem.prefetch') { return selectedVfs; }
                assert.ok(['vscode.openFolder', 'workbench.view.explorer', 'workbench.action.focusActiveEditorGroup'].includes(command), command);
            },
        }),
    });
    const {ProjectManagerProvider} = loadWithVscode(mock, () => require('../core/projectManagerProvider'), {
        '../consts': {ROOT_NAME: 'overleaf-workshop'},
        '../api/base': {},
        '../api/gitBridge': {},
        '../utils/globalStateManager': {GlobalStateManager: globals},
        './remoteFileSystemProvider': {parseUri: (uri: Uri) => ({serverName: uri.authority, projectId: new URLSearchParams(uri.query).get('project')})},
        '../scm/localReplicaSCM': {LocalReplicaSCMProvider: replica},
        '../sandbox/client': {},
        '../sandbox/projectInfo': {},
    });
    const provider = new ProjectManagerProvider({});
    provider.triggers;
    const project = {uri: projectUri, label: 'Selected'};
    function addReplica(key: string, folder: string, options: {valid?: boolean; legacyPath?: boolean} = {}) {
        persists[key] = {enabled: true, label: 'Local Replica', baseUri: options.legacyPath ? folder : Uri.file(folder).toString(), settings: {}};
        if (options.valid !== false) { valid.add(folder); }
    }
    const invoke = (command: string) => {
        const handler = handlers.get(prefix + command);
        assert.ok(handler, `registered ${command}`);
        return handler(project);
    };
    const opened = () => calls.filter(call => call.command === 'vscode.openFolder').map(call => [call.args[0].toString(), call.args[1]]);
    return {provider, project, state, picker, persists, calls, errors, created, selectedVfs, addReplica, invoke, opened};
}

describe('local-first project opening', () => {
    for (const [command, newWindow] of [['openProjectInCurrentWindow', false], ['openProjectInNewWindow', true]] as const) {
        it(`${command} reuses the sole matching replica directly`, async () => {
            const h = setup();
            h.addReplica('one', '/replicas/selected', {legacyPath: true});
            await h.invoke(command);
            assert.deepStrictEqual(h.opened(), [['file:///replicas/selected', newWindow]]);
            assert.strictEqual(h.state.pickerCalls, 0);
            assert.strictEqual(h.state.dialogCalls, 0);
            assert.ok(!h.calls.some(call => call.command === 'remoteFileSystem.prefetch'));
        });
    }

    it('the compatibility alias can open while another remote project is open', async () => {
        const h = setup();
        h.state.workspaceFolders = [{uri: Uri.parse('overleaf-workshop://www.overleaf.com/Other?project=other')}];
        h.addReplica('one', '/replicas/selected');
        await h.invoke('openProjectLocalReplica');
        assert.deepStrictEqual(h.opened(), [['file:///replicas/selected', false]]);
    });

    it('opens the sole valid replica when another registration has corrupt settings', async () => {
        const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'overleaf-registered-replicas-'));
        try {
            const h = setup();
            const replica = load(world(parent, false).mock).LocalReplicaSCMProvider;
            h.state.validate = (folder, project) => replica.isReplicaForProject(folder, project);
            for (const [name, settings] of [['corrupt', '{ broken'], ['valid', JSON.stringify({uri: projectUri})]]) {
                const folder = path.join(parent, name);
                await fs.promises.mkdir(path.join(folder, '.overleaf'), {recursive: true});
                await fs.promises.writeFile(path.join(folder, '.overleaf/settings.json'), settings);
                h.addReplica(name, folder);
            }
            await h.invoke('openProjectInCurrentWindow');
            assert.deepStrictEqual(h.opened(), [[Uri.file(path.join(parent, 'valid')).toString(), false]]);
            assert.strictEqual(h.state.pickerCalls, 0);
            assert.strictEqual(h.state.dialogCalls, 0);
            assert.deepStrictEqual(h.errors, []);
        } finally { await fs.promises.rm(parent, {recursive: true, force: true}); }
    });

    it('ordinary normal project activation uses the local default', async () => {
        const h = setup();
        const [server] = await h.provider.getChildren();
        const [normal, archived] = await h.provider.getChildren(server);
        assert.strictEqual(normal.command?.command, prefix + 'openProjectInCurrentWindow');
        assert.deepStrictEqual(normal.command.arguments, [normal]);
        assert.strictEqual(archived.command, undefined);
    });

    it('chooses among valid replicas, ignoring missing or mismatched registrations', async () => {
        const h = setup();
        h.addReplica('gone', '/replicas/gone', {valid: false});
        h.addReplica('one', '/replicas/one');
        h.addReplica('two', '/replicas/two');
        const opening = h.invoke('openProjectInNewWindow');
        await h.picker.shown.promise;
        assert.deepStrictEqual(h.picker.items.map(item => item.label), ['/replicas/one', '/replicas/two']);
        await h.picker.choose(1);
        await opening;
        assert.deepStrictEqual(h.opened(), [['file:///replicas/two', true]]);
        h.picker.assertClosed();
    });

    it('cancelling a replica picker settles the opening and releases all listeners', async () => {
        const h = setup();
        h.addReplica('one', '/replicas/one');
        h.addReplica('two', '/replicas/two');
        const opening = h.invoke('openProjectInCurrentWindow');
        await h.picker.shown.promise;
        await h.picker.cancel();
        await opening;
        assert.deepStrictEqual(h.opened(), []);
        h.picker.assertClosed();
    });

    it('removing a replica waits for registration removal and keeps the other choices', async () => {
        const h = setup();
        h.addReplica('one', '/replicas/one');
        h.addReplica('two', '/replicas/two');
        const removed = deferred<void>();
        const removing = deferred<void>();
        h.state.remove = async key => { removing.resolve(); await removed.promise; delete h.persists[key]; };
        const opening = h.invoke('openProjectInCurrentWindow');
        await h.picker.shown.promise;
        const removal = h.picker.remove(0);
        await removing.promise;
        assert.strictEqual(h.picker.items.length, 2);
        removed.resolve();
        await removal;
        assert.deepStrictEqual(h.picker.items.map(item => item.label), ['/replicas/two']);
        await h.picker.choose(0);
        await opening;
        assert.deepStrictEqual(h.opened(), [['file:///replicas/two', false]]);
        h.picker.assertClosed();
    });

    it('creates for the explicitly selected project while another remote project is open', async () => {
        const h = setup();
        h.state.workspaceFolders = [{uri: Uri.parse('overleaf-workshop://www.overleaf.com/Other?project=other')}];
        h.addReplica('gone', '/replicas/gone', {valid: false});
        h.state.folder = Uri.file('/chosen');
        const prepared = deferred<Uri>();
        const creating = deferred<void>();
        h.state.create = async (vfs, parent) => {
            h.created.push({vfs, parent});
            creating.resolve();
            return prepared.promise;
        };
        const opening = h.invoke('openProjectInNewWindow');
        await creating.promise;
        assert.deepStrictEqual(h.opened(), [], 'registration completes before changing the window');
        assert.strictEqual(h.created[0].vfs, h.selectedVfs);
        assert.strictEqual(h.created[0].parent.fsPath, '/chosen');
        assert.deepStrictEqual(h.calls.filter(call => call.command === 'remoteFileSystem.prefetch').map(call => call.args[0].toString()), [projectUri]);
        prepared.resolve(Uri.file('/chosen/Selected'));
        await opening;
        assert.deepStrictEqual(h.opened(), [['file:///chosen/Selected', true]]);
        assert.deepStrictEqual(h.errors, []);
    });

    it('keeps the replica picker alive while its removal confirmation receives focus', async () => {
        const h = setup();
        h.addReplica('one', '/replicas/one');
        h.addReplica('two', '/replicas/two');
        const opening = h.invoke('openProjectInCurrentWindow');
        await h.picker.shown.promise;
        const removal = h.picker.remove(0);
        await h.picker.blur();
        await removal;
        assert.deepStrictEqual(h.picker.items.map(item => item.label), ['/replicas/two']);
        await h.picker.choose(0);
        await opening;
        assert.deepStrictEqual(h.opened(), [['file:///replicas/two', false]]);
        h.picker.assertClosed();
    });

    it('cancelling the parent-folder dialog leaves the project unopened', async () => {
        const h = setup();
        await h.invoke('openProjectInCurrentWindow');
        assert.strictEqual(h.state.dialogCalls, 1);
        assert.deepStrictEqual(h.calls, [], 'cancel before borrowing a VFS or opening a folder');
        assert.deepStrictEqual(h.created, []);
    });

    it('reports replica creation failures without opening the destination', async () => {
        const h = setup();
        h.state.folder = Uri.file('/chosen');
        h.state.create = async () => { throw new Error('The destination contains unrelated files.'); };
        await h.invoke('openProjectInCurrentWindow');
        assert.deepStrictEqual(h.opened(), []);
        assert.strictEqual(h.errors.length, 1);
        assert.match(h.errors[0], /destination contains unrelated files/);
    });

    for (const [command, newWindow] of [['openProjectRemoteInCurrentWindow', false], ['openProjectRemoteInNewWindow', true]] as const) {
        it(`${command} explicitly opens the remote workspace`, async () => {
            const h = setup();
            h.addReplica('one', '/replicas/selected');
            await h.invoke(command);
            assert.deepStrictEqual(h.opened(), [[projectUri, newWindow]]);
            assert.strictEqual(h.state.dialogCalls, 0);
            assert.deepStrictEqual(h.created, []);
        });
    }
});
