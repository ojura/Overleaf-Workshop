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
        assert.deepStrictEqual(f.posts, [{ type: 'ready' }]);
        assert.deepStrictEqual(f.writes, []);
        f.initialize({ motionLabMeasurementsOpen: true, scale: '1.5', sidebarView: 2 });
        await ready;
        assert.strictEqual(f.preference.read(), true);
        assert.deepStrictEqual(f.state(), { motionLabMeasurementsOpen: true, scale: '1.5', sidebarView: 2 });
        assert.deepStrictEqual(f.writes, []);
        assert.deepStrictEqual(f.posts, [{ type: 'ready' }]);
        assert.strictEqual(f.acquired(), 1);
    });

    it('persists an early real toggle only after merging the complete host reader state', async () => {
        const f = fixture();
        const pending = f.preference.write(false);
        assert.deepStrictEqual(f.posts, [{ type: 'ready' }]);
        assert.deepStrictEqual(f.writes, [], 'an early preference must not replace persisted state with a partial object');
        const position = { page: 8, offset: { top: 21, left: 5 }, pageSize: { width: 600, height: 800 } };
        f.initialize({ motionLabMeasurementsOpen: true, scale: '2', position, spreadMode: 1, colorTheme: 'Paper' });
        await pending;
        const expected = { motionLabMeasurementsOpen: false, scale: '2', position, spreadMode: 1, colorTheme: 'Paper' };
        assert.deepStrictEqual(f.writes, [expected]);
        assert.deepStrictEqual(f.posts, [{ type: 'ready' }, { type: 'saveState', content: expected }]);
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
});
