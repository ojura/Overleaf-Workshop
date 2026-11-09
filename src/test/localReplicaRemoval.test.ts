/* eslint-disable @typescript-eslint/naming-convention -- mirrors persisted settings and module exports */
import * as assert from 'assert';
import { Cleanup, Uri, world } from './replicaTestWorld';
import { loadWithVscode } from './standIn';
import { DEFAULT_IGNORE_PATTERNS } from '../scm/ignorePatterns';

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

describe('removing a local replica', function () {
    this.timeout(10000);
    const cleanup = new Cleanup();
    afterEach(() => cleanup.undo());

    async function replica() {
        cleanup.privateRuntime();
        const folder = cleanup.tempDir('ow-replica-remove-');
        const t = world(folder, false);
        t.w.remote.set('/lecture.tex', 'A lecture.');
        const uri = Uri.file(folder);
        const settings = { 'ignore-patterns': [...DEFAULT_IGNORE_PATTERNS, '**/build/**'] };
        let persist: any = { label: 'Local Replica', baseUri: uri.toString(), enabled: true, settings };
        const other = { settings: { 'ignore-patterns': ['**/other/**'] } };
        (t.vfs as any).getProjectSCMPersist = (key: string) => key === uri.toString() ? persist : other;
        (t.vfs as any).setProjectSCMPersist = (key: string, value: unknown) => {
            assert.strictEqual(key, uri.toString(), 'only the selected replica is removed');
            persist = value;
        };
        const logs: string[] = [];
        t.mock.window.createOutputChannel = () => ({ appendLine: (message: string) => logs.push(message) });
        t.mock.window.showQuickPick = async (items: any[]) => items.find(item => item.label === 'Disable');
        const { LocalReplicaSCMProvider, SCMCollectionProvider } = loadWithVscode(t.mock, () => ({
            LocalReplicaSCMProvider: require('../scm/localReplicaSCM').LocalReplicaSCMProvider,
            SCMCollectionProvider: require('../scm/scmCollectionProvider').SCMCollectionProvider,
        }));
        const scm = new LocalReplicaSCMProvider(t.vfs, uri);
        const triggers = await scm.triggers;
        // Capture the actual stop once so cleanup can await it even on the regression's failure.
        const stop = scm.sync.stop.bind(scm.sync);
        let stopping: Promise<void> | undefined;
        scm.sync.stop = () => stopping ??= stop();
        let release = () => {};
        cleanup.add(async () => {
            release();
            triggers.forEach((trigger: { dispose(): void }) => trigger.dispose());
            await scm.sync.stop();
        });
        await scm.fullSync;
        await scm.sync.recordNow();

        let entered!: () => void;
        const recording = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const record = scm.store.record.bind(scm.store);
        let recorded = false;
        scm.store.record = async (state: unknown) => {
            entered();
            await gate;
            assert.deepStrictEqual(scm.settings, settings, 'final recording retains the configured exclusions');
            assert.strictEqual(scm.matchIgnorePatterns('/build/figure.pdf'), true);
            const result = await record(state);
            recorded = true;
            return result;
        };
        const item = { scm, enabled: true, triggers: [...triggers] };
        // Use the real collection's actions without starting an unrelated project/history UI.
        const collection = Object.assign(Object.create(SCMCollectionProvider.prototype), {
            disposed: false, scms: [item], vfs: t.vfs, updateStatus() {},
        });
        return { collection, item, scm, t, recording, release, registered: () => persist,
            recorded: () => recorded, logs, other };
    }

    it('keeps its settings until the pending final record finishes', async () => {
        const r = await replica();
        let complete = false;
        const removal = Promise.resolve(r.collection.removeSCM(r.item)).then(() => { complete = true; });
        try {
            await r.recording;
            assert.ok(r.registered(), 'the registration is needed while shutdown records the Git state');
            assert.strictEqual(complete, false, 'Remove waits for final recording');
        } finally {
            r.release();
            await removal;
        }
        assert.strictEqual(r.recorded(), true);
        assert.strictEqual(r.registered(), undefined);
        assert.deepStrictEqual(r.other.settings, { 'ignore-patterns': ['**/other/**'] });
        assert.deepStrictEqual(r.logs.filter(message => message.includes('Recording the state failed')), []);
    });

    it('also waits for shutdown already started by Disable', async () => {
        const r = await replica();
        const disable = r.collection.configSCM(r.item);
        await r.recording;
        const removal = Promise.resolve(r.collection.removeSCM(r.item));
        try {
            assert.ok(r.registered(), 'an emptied trigger list still has a pending shutdown');
            assert.strictEqual(r.registered().enabled, false);
        } finally {
            r.release();
            await Promise.all([disable, removal]);
        }
        assert.strictEqual(r.recorded(), true);
        assert.strictEqual(r.registered(), undefined);
        assert.deepStrictEqual(r.logs.filter(message => message.includes('Recording the state failed')), []);
    });

    it('waits for a forced recording already running while a landing holds the sync', async () => {
        const r = await replica();
        // Only the recording's real Git I/O remains outstanding in this fixture.
        r.scm.sync.local.verify = async () => {};
        r.scm.store.save = async () => {};
        r.scm.sync.hold();
        const recording = r.scm.sync.recordNow({ force: true });
        await r.recording;
        const removal = r.collection.removeSCM(r.item);
        try {
            r.release();
            await Promise.all([recording, removal]);
            assert.strictEqual(r.recorded(), true);
            assert.strictEqual(r.registered(), undefined);
        } finally {
            r.release();
            await Promise.allSettled([recording, removal]);
            r.scm.sync.release();
        }
    });

    it('keeps settings through a comparison that has not queued any files yet', async () => {
        const r = await replica();
        r.release();
        // Finish the shutdown's writes in memory; the comparison still reads the real folder.
        r.scm.sync.local.verify = async () => {};
        r.scm.store.save = async () => {};
        r.scm.store.record = async () => ({ made: [] });
        r.scm.store.foreignIndexLock = async () => undefined;
        r.scm.store.workTree = async () => undefined;
        const entered = deferred(), listing = deferred();
        const list = r.scm.sync.local.list.bind(r.scm.sync.local);
        r.scm.sync.local.list = async () => { entered.resolve(); await listing.promise; return list(); };
        const comparison = r.scm.syncAll();
        await entered.promise;
        const removal = r.collection.removeSCM(r.item);
        try {
            listing.resolve();
            const result = await comparison;
            await removal;
            assert.strictEqual(result.error, undefined, 'the unfinished folder listing retains its ignore settings');
            assert.strictEqual(r.registered(), undefined);
        } finally {
            listing.resolve();
            await Promise.allSettled([comparison, removal]);
        }
    });

    it('removes a replica whose Enable action is still starting its triggers', async () => {
        const r = await replica();
        r.release();
        await r.collection.configSCM(r.item);
        const entered = deferred(), starting = deferred<any[]>();
        r.t.mock.window.showQuickPick = async (items: any[]) => items.find(item => item.label === 'Enable');
        r.collection.start = async () => { entered.resolve(); return starting.promise; };
        let disposed = 0;
        const trigger = { dispose() { disposed++; } };
        const enabling = r.collection.configSCM(r.item);
        await entered.promise;
        const removal = r.collection.removeSCM(r.item);
        try {
            starting.resolve([trigger]);
            await Promise.all([enabling, removal]);
            assert.strictEqual(disposed, 1, 'Remove disposes the triggers returned by Enable');
            assert.deepStrictEqual(r.item.triggers, []);
            assert.strictEqual(r.registered(), undefined);
        } finally {
            starting.resolve([trigger]);
            await Promise.allSettled([enabling, removal]);
            if (!disposed) { trigger.dispose(); }
        }
    });

    it('settles a comparison waiting for a deletion answer when removed', async () => {
        const r = await replica();
        r.release();
        for (let i = 0; i < 6; i++) { r.t.w.remote.set(`/chapter-${i}.tex`, 'Chapter.'); }
        await r.scm.syncAll();
        for (let i = 0; i < 6; i++) { r.t.w.remote.delete(`/chapter-${i}.tex`); }
        const asked = deferred(), answer = deferred<boolean>();
        r.scm.sync.ui.confirmDeletions = () => { asked.resolve(); return answer.promise; };
        const comparison = r.scm.syncAll();
        await asked.promise;
        const removal = r.collection.removeSCM(r.item);
        try {
            await removal;
            assert.strictEqual(r.scm.sync.openQuestion, undefined, 'shutdown ends its wait for the user');
            await comparison;
            assert.strictEqual(r.registered(), undefined);
        } finally {
            answer.resolve(true);
            await Promise.allSettled([comparison, removal]);
        }
    });

    it('ignores a settings choice made in a picker opened before Remove', async () => {
        const r = await replica();
        r.release();
        const choice = deferred<any>();
        const errors: string[] = [];
        r.t.mock.window.showQuickPick = () => choice.promise;
        r.t.mock.window.showErrorMessage = async (message: string) => { errors.push(message); };
        const configuring = r.collection.configSCM(r.item);
        try {
            await r.collection.removeSCM(r.item);
            choice.resolve({ label: 'Configure sync ignore patterns ...' });
            await configuring;
            assert.deepStrictEqual(errors, [], 'a stale picker must not invoke a removed replica');
            assert.strictEqual(r.registered(), undefined);
        } finally {
            choice.resolve(undefined);
            await configuring;
        }
    });

    it('closes an open ignore editor and ignores its queued edits on Remove', async () => {
        const r = await replica();
        r.release();
        let accept!: () => Promise<void>;
        let hidden = () => {};
        let disposed = false;
        const picker = {
            selectedItems: [], value: '**/temporary/**', items: [],
            show() {}, hide() { hidden(); }, dispose() { disposed = true; },
            onDidAccept(callback: () => Promise<void>) { accept = callback; return { dispose() {} }; },
            onDidTriggerItemButton() { return { dispose() {} }; },
            onDidHide(callback: () => void) { hidden = callback; return { dispose() { hidden = () => {}; } }; },
        };
        r.t.mock.window.createQuickPick = () => picker;
        r.t.mock.window.showQuickPick = async (items: any[]) => items.find(item => item.label === 'Configure sync ignore patterns ...');
        await r.collection.configSCM(r.item);
        try {
            await r.collection.removeSCM(r.item);
            await accept(); // An event already received before the picker was disposed.
            assert.strictEqual(disposed, true);
            assert.strictEqual(r.registered(), undefined, 'a late edit must not restore the removed entry');
        } finally { picker.dispose(); }
    });
});
