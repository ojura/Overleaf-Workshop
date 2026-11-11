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
            initialize(content: Record<string, unknown>) { receiver({ data: { type: 'initState', content } }); },
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
    it('shares robot visibility across host reopen while preserving the complete reader state', async () => {
        for (const enabled of [false, true]) {
            const f = fixture(), preference = f.host.hostRobotsPreference;
            assert.ok(preference, 'both extension engines have a host-backed visibility adapter');
            const ready = preference.whenReady();
            const position = { page: 8, offset: { top: 21, left: 5 }, pageSize: { width: 600, height: 800 } };
            f.initialize({ documentRobotsEnabled: enabled, scale: '2', position, motionLabMeasurementsOpen: true }); await ready;
            assert.strictEqual(preference.read(), enabled); assert.deepStrictEqual(f.writes, []);
            await preference.write(!enabled);
            assert.deepStrictEqual(f.writes.at(-1), { documentRobotsEnabled: !enabled, scale: '2', position, motionLabMeasurementsOpen: true });
            const reopened = fixture(f.state()); const settled = reopened.host.hostRobotsPreference.whenReady();
            reopened.initialize({ scale: '1', documentRobotsEnabled: enabled }); await settled;
            assert.strictEqual(reopened.host.hostRobotsPreference.read(), !enabled);
            assert.strictEqual(reopened.state().scale, '2');
        }
    });

    it('merges an early robot toggle after host readiness and drops a disposed host write', async () => {
        const f = fixture(); const pending = f.host.hostRobotsPreference.write(false);
        assert.deepStrictEqual(f.writes, []);
        f.initialize({ documentRobotsEnabled: true, scale: '2', sidebarView: 2 }); await pending;
        assert.deepStrictEqual(f.writes, [{ documentRobotsEnabled: false, scale: '2', sidebarView: 2 }]);
        const closed = fixture(); const late = closed.host.hostRobotsPreference.write(true);
        closed.initialize({ documentRobotsEnabled: false, scale: '3' }); closed.host.disposeHost(); await late;
        assert.deepStrictEqual(closed.writes, [], 'late readiness has no disposed host message owner');
    });

});
