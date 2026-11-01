/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { loadWithVscode } from './standIn';

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

class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '') {}
    get fsPath() { return this.path; }
    with(change: { path?: string }) { return new Uri(this.scheme, this.authority, change.path ?? this.path, this.query); }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`; }
    static file(p: string) { return new Uri('file', '', p); }
    static joinPath(base: Uri, ...parts: string[]) { return base.with({ path: path.posix.join(base.path, ...parts) }); }
    static parse(value: string) {
        const m = /^([^:]+):\/\/([^/]*)([^?]*)(?:\?(.*))?$/.exec(value)!;
        return new Uri(m[1], m[2], decodeURIComponent(m[3]), decodeURIComponent(m[4] ?? ''));
    }
}

const REPLICA = '/home/user/Book';
const files = new Set<string>();
let settings: any;
const world = { activeTextEditor: undefined as any, infos: [] as string[], opened: [] as string[] };
const vscodeMock = withStubs({
    Uri,
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    TreeItem: class {},
    MarkdownString: class { appendMarkdown() { return this; } },
    l10n: { t: (message: string) => message },
    window: withStubs({
        get activeTextEditor() { return world.activeTextEditor; },
        showInformationMessage: async (message: string) => { world.infos.push(message); return undefined; },
        createStatusBarItem: () => withStubs({ show() {}, hide() {} }),
    }),
    workspace: withStubs({
        get workspaceFolders() { return [{ uri: Uri.file(REPLICA) }]; },
        getConfiguration: () => ({ get: (_key: string, value: any) => value }),
        textDocuments: [],
        fs: withStubs({
            stat: async (uri: Uri) => {
                if (uri.path === `${REPLICA}/.overleaf/settings.json` && settings) { return { type: 1 }; }
                if (files.has(uri.path)) { return { type: 1 }; }
                throw new Error(`ENOENT ${uri.path}`);
            },
            readFile: async (uri: Uri) => {
                if (uri.path === `${REPLICA}/.overleaf/settings.json` && settings) { return new TextEncoder().encode(JSON.stringify(settings)); }
                throw new Error(`ENOENT ${uri.path}`);
            },
        }),
    }),
});
const [{ CompileManager }, { BaseAPI }] = loadWithVscode(vscodeMock, () => [require('../compile/compileManager'), require('../api/base')]);

const projectUri = Uri.parse('overleaf-workshop://www.overleaf.com/Book?user%3Du1%26project%3Dp1');

describe('SyncTeX', () => {
    beforeEach(() => {
        files.clear();
        settings = { uri: projectUri.toString().replace('?user=u1&project=p1', '?user%3Du1%26project%3Dp1'), enableCompileNPreview: true };
        world.infos = [];
    });

    it('sends the line as SyncTeX counts it, the path encoded, and the compile server and editor of the build', async () => {
        const urls: string[] = [];
        const server = http.createServer((req, res) => { urls.push(req.url!); res.end(JSON.stringify({ pdf: [], code: [{ file: 'main.tex', line: 3, column: 0 }] })); });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const api = new BaseAPI(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
            const identity = { cookies: 'c', csrfToken: 't' };
            const editor = '0d9c1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
            await api.proxySyncCode(identity, 'p1', 'chapters/a b&c.tex', 12, 4, 'build1', editor, 'clsi-7');
            await api.proxySyncPdf(identity, 'p1', 3, 10.5, 200.25, 'build1', editor, 'clsi-7');
            const code = new URL(urls[0], 'http://x');
            assert.strictEqual(code.pathname, '/project/p1/sync/code');
            assert.strictEqual(code.searchParams.get('file'), 'chapters/a b&c.tex');
            assert.strictEqual(code.searchParams.get('line'), '12');
            assert.strictEqual(code.searchParams.get('clsiserverid'), 'clsi-7');
            // the build's editor: Overleaf looks a build up in its cache of compile outputs by editor and build
            assert.deepStrictEqual([code.searchParams.get('editorId'), code.searchParams.get('buildId')], [editor, 'build1']);
            const pdf = new URL(urls[1], 'http://x');
            assert.deepStrictEqual([pdf.searchParams.get('page'), pdf.searchParams.get('h'), pdf.searchParams.get('v'), pdf.searchParams.get('clsiserverid')], ['3', '10.50', '200.25', 'clsi-7']);
            assert.deepStrictEqual([pdf.searchParams.get('editorId'), pdf.searchParams.get('buildId')], [editor, 'build1']);
        } finally { server.close(); }
    });

    it('finds the project path of a replica file, and of nothing outside the replica or in its own folders', async () => {
        assert.strictEqual(await CompileManager.projectPathOf(Uri.file(`${REPLICA}/chapters/intro.tex`)), 'chapters/intro.tex');
        assert.strictEqual(await CompileManager.projectPathOf(Uri.file(`${REPLICA}/.overleaf/output/output.log`)), undefined);
        // the replica's git repository, where the IDE opens COMMIT_EDITMSG for a commit message
        assert.strictEqual(await CompileManager.projectPathOf(Uri.file(`${REPLICA}/.git/COMMIT_EDITMSG`)), undefined);
        assert.strictEqual(await CompileManager.projectPathOf(Uri.file('/elsewhere/x.tex')), undefined);
        assert.strictEqual(await CompileManager.projectPathOf(projectUri.with({ path: '/Book/chapters/intro.tex' })), 'chapters/intro.tex');
    });

    it('opens the replica\'s copy of a file SyncTeX names, or the project\'s when the replica has none', async () => {
        files.add(`${REPLICA}/main.tex`);
        assert.strictEqual((await CompileManager.sourceUriOf(projectUri, 'p1', 'main.tex')).toString(), `file://${REPLICA}/main.tex`);
        assert.strictEqual((await CompileManager.sourceUriOf(projectUri, 'p1', 'slike/missing.tex')).path, '/Book/slike/missing.tex');
        assert.strictEqual((await CompileManager.sourceUriOf(projectUri, 'p1', 'output.bbl')).path, '/Book/.output/output.bbl');
        // a replica of another project does not count
        assert.strictEqual((await CompileManager.sourceUriOf(projectUri, 'p2', 'main.tex')).scheme, 'overleaf-workshop');
    });

    it('jumps to the PDF from a replica file with its project path and the line counted from 1', async () => {
        const calls: any[] = [];
        const vfs = { syncCode: async (...args: any[]) => { calls.push(args); return undefined; } };
        const manager = new CompileManager({ prefetch: async () => vfs });
        world.activeTextEditor = { document: { uri: Uri.file(`${REPLICA}/chapters/intro.tex`) }, selection: { start: { line: 41, character: 7 } } };
        await manager.syncCode();
        assert.deepStrictEqual(calls, [['chapters/intro.tex', 42, 7]]);
        world.activeTextEditor = { document: { uri: Uri.file('/elsewhere/x.tex') }, selection: { start: { line: 0, character: 0 } } };
        await manager.syncCode();
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(world.infos, ['This file is not part of the Overleaf project.']);
    });
});
