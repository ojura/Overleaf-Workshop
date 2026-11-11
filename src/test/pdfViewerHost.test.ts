import * as assert from 'assert';
import * as path from 'path';
import * as vm from 'vm';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('PDF viewer host disclosure preference', function () {
    this.timeout(30_000);
    let source: string;

    before(async () => {
        const esbuild = await importModule('esbuild');
        try {
            const result = await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/host.ts')],
                bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2020', logLevel: 'silent' });
            source = result.outputFiles[0].text;
        } finally { await esbuild.stop(); }
    });

    function fixture(previous: Record<string, unknown> = {}) {
        const posts: any[] = [], writes: any[] = [];
        const copy = (value: any) => JSON.parse(JSON.stringify(value));
        let receiver: (event: { data: unknown }) => void;
        let acquired = 0;
        const module = { exports: {} as any };
        vm.runInNewContext(source, { module, exports: module.exports,
            window: { addEventListener(name: string, callback: typeof receiver) {
                assert.strictEqual(name, 'message'); receiver = callback;
            } },
            document: { getElementById: () => ({ textContent: JSON.stringify({ page: 'host-test-page' }) }) },
            acquireVsCodeApi: () => {
                acquired++;
                return { getState: () => copy(previous), setState: (value: unknown) => writes.push(copy(value)),
                    postMessage: (message: unknown) => posts.push(copy(message)) };
            },
        });
        const host = module.exports, preference = host.hostMeasurementsPreference;
        assert.ok(preference, 'the shared host adapter must be available to both extension engines');
        return { host, preference, posts, writes, acquired: () => acquired,
            initialize(content: Record<string, unknown>, robotsEnabled = true) { receiver({ data: { type: 'initState', content, robotsEnabled } }); },
            receive(data: unknown) { receiver({ data }); },
            state: () => copy(host.savedState()),
        };
    }

    it('waits for late host expansion without persisting a collapsed default', async () => {
        const f = fixture();
        assert.strictEqual(f.preference.read(), undefined);
        assert.deepStrictEqual(f.posts, []);
        const ready = f.preference.whenReady();
        assert.deepStrictEqual(f.posts, [{ type: 'ready', page: 'host-test-page' }]);
        assert.deepStrictEqual(f.writes, []);
        f.initialize({ motionLabMeasurementsOpen: true, scale: '1.5', sidebarView: 2 });
        await ready;
        assert.strictEqual(f.preference.read(), true);
        assert.deepStrictEqual(f.state(), { motionLabMeasurementsOpen: true, scale: '1.5', sidebarView: 2 });
        assert.deepStrictEqual(f.writes, []);
        assert.deepStrictEqual(f.posts, [{ type: 'ready', page: 'host-test-page' }]);
        assert.strictEqual(f.acquired(), 1);
    });

    it('persists an early real toggle only after merging the complete host reader state', async () => {
        const f = fixture();
        const pending = f.preference.write(false);
        assert.deepStrictEqual(f.posts, [{ type: 'ready', page: 'host-test-page' }]);
        assert.deepStrictEqual(f.writes, [], 'an early preference must not replace persisted state with a partial object');
        const position = { page: 8, offset: { top: 21, left: 5 }, pageSize: { width: 600, height: 800 } };
        f.initialize({ motionLabMeasurementsOpen: true, scale: '2', position, spreadMode: 1, colorTheme: 'Paper' });
        await pending;
        const expected = { motionLabMeasurementsOpen: false, scale: '2', position, spreadMode: 1, colorTheme: 'Paper' };
        assert.deepStrictEqual(f.writes, [expected]);
        assert.deepStrictEqual(f.posts, [{ type: 'ready', page: 'host-test-page' }, { type: 'saveState', page: 'host-test-page', content: expected }]);
        assert.strictEqual(f.preference.read(), false);
    });

    it('preserves newer webview state while adding host fields and writes later changes from the current state', async () => {
        const f = fixture({ motionLabMeasurementsOpen: false, scale: '3' });
        const ready = f.preference.whenReady();
        f.initialize({ motionLabMeasurementsOpen: true, scale: '1', sidebarView: 2 });
        await ready;
        assert.strictEqual(f.preference.read(), false);
        assert.deepStrictEqual(f.state(), { motionLabMeasurementsOpen: false, scale: '3', sidebarView: 2 });
        f.host.saveState({ scrollMode: 1 });
        await f.preference.write(true);
        assert.strictEqual(f.preference.read(), true);
        assert.deepStrictEqual(f.writes[f.writes.length - 1],
            { motionLabMeasurementsOpen: true, scale: '3', sidebarView: 2, scrollMode: 1 });
        assert.strictEqual(f.posts.filter(value => value.type === 'ready').length, 1);
    });

    it('reads explicit booleans lazily and leaves absent or malformed saved values unset', async () => {
        for (const value of [undefined, null, 'true', 1, false, true]) {
            const f = fixture(value === undefined ? {} : { motionLabMeasurementsOpen: value });
            assert.strictEqual(f.preference.read(), typeof value === 'boolean' ? value : undefined);
            assert.deepStrictEqual(f.posts, []);
            assert.deepStrictEqual(f.writes, []);
            const ready = f.preference.whenReady(); f.initialize({}); await ready;
        }
    });
    it('uses global robot visibility instead of either document-state copy and follows live changes', async () => {
        const f = fixture({ documentRobotsEnabled: true, scale: '3' });
        const preference = f.host.hostRobotsPreference, changes: boolean[] = [];
        const stop = preference.onDidChange((value: boolean) => changes.push(value));
        const ready = preference.whenReady();
        f.initialize({ documentRobotsEnabled: true, sidebarView: 2 }, false); await ready;
        assert.strictEqual(preference.read(), false);
        f.receive({ type: 'robotsEnabledChanged', page: 'retired-page', enabled: true });
        assert.deepStrictEqual(changes, []);
        f.receive({ type: 'robotsEnabledChanged', page: 'host-test-page', enabled: true });
        assert.strictEqual(preference.read(), true); assert.deepStrictEqual(changes, [true]);
        await preference.write(false);
        assert.deepStrictEqual(f.posts.at(-1), { type: 'setRobotsEnabled', page: 'host-test-page', enabled: false });
        assert.deepStrictEqual(f.writes, [], 'the global control does not replace document state');
        assert.strictEqual(f.state().scale, '3');
        stop(); f.host.disposeHost();
        f.receive({ type: 'robotsEnabledChanged', page: 'host-test-page', enabled: false });
        assert.deepStrictEqual(changes, [true]);
    });

    it('keeps a newer global notification across pending init and drops disposed preference writes', async () => {
        const f = fixture(), preference = f.host.hostRobotsPreference;
        const pending = preference.write(false);
        f.receive({ type: 'robotsEnabledChanged', page: 'host-test-page', enabled: true });
        f.initialize({ documentRobotsEnabled: false, scale: '2' }, false); await pending;
        assert.strictEqual(preference.read(), true);
        assert.deepStrictEqual(f.posts.at(-1), { type: 'setRobotsEnabled', page: 'host-test-page', enabled: false });
        assert.deepStrictEqual(f.writes, []);
        const closed = fixture(); const late = closed.host.hostRobotsPreference.write(true);
        closed.initialize({}, false); closed.host.disposeHost(); await late;
        assert.deepStrictEqual(closed.posts, [{ type: 'ready', page: 'host-test-page' }]);
    });
});
