/* eslint-disable @typescript-eslint/naming-convention -- mirrors persisted settings and module exports */
import * as assert from 'assert';
import { Cleanup, Uri, world } from './replicaTestWorld';
import { loadWithVscode } from './standIn';
import { DEFAULT_IGNORE_PATTERNS } from '../scm/ignorePatterns';

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
        return { collection, item, recording, release, registered: () => persist,
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
});
