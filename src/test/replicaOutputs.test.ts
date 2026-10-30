/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');
import { CompileRecord, saveCompileOutputs } from '../compile/outputFiles';

const response = (status: string, paths: string[]): any => ({
    status, compileGroup: 'priority', clsiServerId: 'clsi-1',
    timings: { sync: 3038, compile: 240260, output: 11 },
    outputFiles: paths.map(p => ({ path: p, url: `/project/p/user/u/build/b1/output/${p}`, type: p.split('.').pop(), build: 'b1' })),
});
const record = (res: any): CompileRecord => ({ response: res, rootResourcePath: 'main.tex', startedAt: Date.parse('2026-10-30T18:00:00Z'), finishedAt: Date.parse('2026-10-30T18:04:04Z') });
const content = async (file: any) => new TextEncoder().encode(`${file.path} of ${file.build}`);

describe('saving a compile\'s logs in .overleaf/output', () => {
    let dir: string;
    let folder: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-outputs-test-'));
        folder = path.join(dir, '.overleaf', 'output');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('saves the logs, the response with its timings and a summary, also for a compile that timed out', async () => {
        const res = response('timedout', ['output.aux', 'output.blg', 'output.log', 'output.stdout', 'output.pdf']);
        const summary = await saveCompileOutputs(folder, record(res), content);
        assert.deepStrictEqual(fs.readdirSync(folder).sort(), ['compile-response.json', 'compile.json', 'output.blg', 'output.log', 'output.stdout']);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'output.log'), 'utf8'), 'output.log of b1');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(folder, 'compile-response.json'), 'utf8')).timings, res.timings);
        const saved = JSON.parse(fs.readFileSync(path.join(folder, 'compile.json'), 'utf8'));
        assert.strictEqual(saved.status, 'timedout');
        assert.strictEqual(saved.requestMs, 244000);
        assert.deepStrictEqual(saved.notSaved, ['output.aux', 'output.pdf']);
        assert.deepStrictEqual(summary.saved.map(s => s.path), ['output.blg', 'output.log', 'output.stdout']);
    });

    it('replaces the previous compile\'s files, so no old log is left next to new ones', async () => {
        await saveCompileOutputs(folder, record(response('success', ['output.log', 'output.blg', 'output.ilg'])), content);
        await saveCompileOutputs(folder, record({ ...response('failure', ['output.log']), outputFiles: [{ path: 'output.log', url: '/x', type: 'log', build: 'b2' }] }), content);
        assert.deepStrictEqual(fs.readdirSync(folder).sort(), ['compile-response.json', 'compile.json', 'output.log']);
        assert.strictEqual(fs.readFileSync(path.join(folder, 'output.log'), 'utf8'), 'output.log of b2');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(folder)), ['output']);
    });

    it('saves the other files when one download fails, and says which one failed', async () => {
        const failing = async (file: any) => { if (file.path === 'output.blg') { throw new Error('HTTP 404'); } return content(file); };
        const summary = await saveCompileOutputs(folder, record(response('success', ['output.log', 'output.blg'])), failing);
        assert.deepStrictEqual(summary.failed, [{ path: 'output.blg', error: 'HTTP 404' }]);
        assert.ok(fs.existsSync(path.join(folder, 'output.log')));
    });

    it('records a request that failed, with its message and no response', async () => {
        await saveCompileOutputs(folder, { ...record(undefined), message: 'getaddrinfo EAI_AGAIN www.overleaf.com' }, content);
        const saved = JSON.parse(fs.readFileSync(path.join(folder, 'compile.json'), 'utf8'));
        assert.strictEqual(saved.status, 'request failed');
        assert.match(saved.message, /EAI_AGAIN/);
        assert.deepStrictEqual(fs.readdirSync(folder), ['compile.json']);
    });
});

// ---- the compile manager saves the logs for a local replica, and only for the replica's project

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
const withStubs = (target: any): any => new Proxy(target, { get: (t, key) => (key in t ? t[key] : stub()) });
const uri = (value: string) => {
    const query = value.split('?')[1] ?? '';
    return { scheme: value.split(':')[0], path: '/Book', query: decodeURIComponent(query), authority: 'www.overleaf.com', fsPath: value.replace(/^file:\/\//, ''), toString: () => value };
};
const vscodeMock = withStubs({
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    TreeItem: class {},
    MarkdownString: class { appendMarkdown() { return this; } },
    Uri: { parse: uri },
    l10n: { t: (message: string) => message },
    window: withStubs({ showWarningMessage: async () => undefined, createStatusBarItem: () => withStubs({ show() {}, hide() {} }) }),
    workspace: withStubs({ saveAll: async () => true, getConfiguration: () => ({ get: (_key: string, value: any) => value }), textDocuments: [] }),
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { CompileManager } = require('../compile/compileManager');
const { LocalReplicaSCMProvider } = require('../scm/localReplicaSCM');
moduleAny._load = originalLoad;
for (const key of Object.keys(require.cache)) {
    if (/[\\/]out[\\/](?!test[\\/])/.test(key)) { delete require.cache[key]; }
}

describe('CompileManager and a local replica\'s logs', () => {
    const saved = { readSettings: LocalReplicaSCMProvider.readSettings, pathToUri: LocalReplicaSCMProvider.pathToUri, flushAll: LocalReplicaSCMProvider.flushAll };
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-compile-test-')); });
    afterEach(() => {
        Object.assign(LocalReplicaSCMProvider, saved);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function compileWith(projectInSettings: string, compiled: boolean) {
        LocalReplicaSCMProvider.readSettings = async () => ({ uri: `overleaf-workshop://www.overleaf.com/Book?user%3Du%26project%3D${projectInSettings}`, enableCompileNPreview: true });
        LocalReplicaSCMProvider.pathToUri = async (p: string) => uri(`file://${path.join(dir, p)}`);
        LocalReplicaSCMProvider.flushAll = async () => {};
        const downloads: string[] = [];
        let compileCalled!: () => void;
        const called = new Promise<void>(resolve => { compileCalled = resolve; });
        const vfs: any = {
            projectId: 'p1',
            getRootDocName: () => '/main.tex',
            getCompiler: () => ({ name: 'pdfLaTeX' }),
            _resolveUri: async () => ({ fileType: 'folder', fileId: 'root' }),
            compile: async () => {
                setImmediate(compileCalled);
                if (!compiled) { return undefined; }
                vfs.lastCompile = record(response('failure', ['output.log', 'output.pdf']));
                return false;
            },
            downloadCompileOutput: async (file: any) => { downloads.push(file.path); return new TextEncoder().encode('log'); },
        };
        const manager = new CompileManager({ prefetch: async () => vfs });
        await manager.compile(true);
        await called;
        for (let i = 0; i < 20; i++) { await new Promise(resolve => setImmediate(resolve)); }
        await (manager as any).outputSaves;
        return downloads;
    }

    it('saves the logs of a failed compile of the replica\'s project', async () => {
        const downloads = await compileWith('p1', true);
        assert.deepStrictEqual(downloads, ['output.log']);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.overleaf', 'output', 'compile.json'), 'utf8')).status, 'failure');
    });

    it('saves nothing for another project, or when nothing was compiled', async () => {
        assert.deepStrictEqual(await compileWith('another', true), []);
        assert.deepStrictEqual(await compileWith('p1', false), []);
        assert.strictEqual(fs.existsSync(path.join(dir, '.overleaf', 'output')), false);
    });
});
