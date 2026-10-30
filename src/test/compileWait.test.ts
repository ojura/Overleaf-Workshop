/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import Module = require('module');

/** Stands in for anything else: callable, constructible, and every member is one again. */
function stub(): any {
    const f: any = function () { return stub(); };
    return new Proxy(f, {
        get(target, key) {
            if (key === 'then') { return undefined; }
            if (!(key in target)) { target[key] = stub(); }
            return target[key];
        },
        construct() { return stub(); },
    });
}
const withStubs = (target: any): any => new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : stub()),
});

const warnings: string[] = [];
const vscodeMock = withStubs({
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    TreeItem: class {},
    MarkdownString: class { appendMarkdown() { return this; } },
    Uri: { parse: (value: string) => ({ scheme: 'overleaf-workshop', path: '/project', toString: () => value }) },
    l10n: { t: (message: string) => message },
    window: withStubs({
        showWarningMessage: async (message: string) => { warnings.push(message); return undefined; },
        createStatusBarItem: () => withStubs({ show() {}, hide() {} }),
    }),
    workspace: withStubs({
        saveAll: async () => true,
        getConfiguration: () => ({ get: (_key: string, value: any) => value }),
        textDocuments: [],
    }),
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { CompileManager } = require('../compile/compileManager');
const { LocalReplicaSCMProvider } = require('../scm/localReplicaSCM');
moduleAny._load = originalLoad;
// The modules just loaded hold this file's stand-in for 'vscode': keep them out of other tests.
for (const key of Object.keys(require.cache)) {
    if (/[\\/]out[\\/](?!test[\\/])/.test(key)) { delete require.cache[key]; }
}

const settle = async () => { for (let i = 0; i < 50; i++) { await new Promise(resolve => setImmediate(resolve)); } };

describe('CompileManager with a local replica', () => {
    const flushAll = LocalReplicaSCMProvider.flushAll;
    const readSettings = LocalReplicaSCMProvider.readSettings;
    const waitMs = CompileManager.uploadWaitMs;
    afterEach(() => {
        LocalReplicaSCMProvider.flushAll = flushAll;
        LocalReplicaSCMProvider.readSettings = readSettings;
        CompileManager.uploadWaitMs = waitMs;
        warnings.length = 0;
    });

    function setup(flush: () => Promise<void>) {
        const events: string[] = [];
        LocalReplicaSCMProvider.readSettings = async () => ({ uri: 'overleaf-workshop://server/project?user=u&project=p', enableCompileNPreview: true });
        LocalReplicaSCMProvider.flushAll = async () => { events.push('flush started'); await flush(); events.push('flush done'); };
        const vfs = {
            getRootDocName: () => '/main.tex',
            getCompiler: () => ({ name: 'pdfLaTeX' }),
            _resolveUri: async () => ({ fileType: 'folder', fileId: 'root' }),
            compile: async () => { events.push('compile'); return undefined; },
        };
        const manager = new CompileManager({ prefetch: async () => vfs });
        return { events, manager };
    }

    it('compiles only after the local changes have been uploaded', async () => {
        let release!: () => void;
        const { events, manager } = setup(() => new Promise<void>(resolve => { release = resolve; }));
        manager.compile(true);
        await settle();
        assert.deepStrictEqual(events, ['flush started'], 'the compile waits for the uploads');
        release();
        await settle();
        assert.deepStrictEqual(events, ['flush started', 'flush done', 'compile']);
    });

    it('compiles anyway when the uploads take too long, and says so', async () => {
        CompileManager.uploadWaitMs = 20;
        const { events, manager } = setup(() => new Promise<void>(() => {}));
        manager.compile(true);
        await new Promise(resolve => setTimeout(resolve, 100));
        await settle();
        assert.deepStrictEqual(events, ['flush started', 'compile']);
        assert.strictEqual(warnings.length, 1);
    });
});
