/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as path from 'path';
import Module = require('module');

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

const world = { reads: [] as string[], output: undefined as any };
const vscodeMock = withStubs({
    Uri,
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    TreeItem: class {},
    l10n: { t: (message: string) => message },
    commands: withStubs({
        executeCommand: async (command: string) => command === 'remoteFileSystem.prefetch' ? { pdfOutput: () => world.output } : undefined,
    }),
    workspace: withStubs({
        getConfiguration: () => ({ get: (_key: string, value: any) => value }),
        fs: withStubs({
            readFile: async (uri: Uri) => { world.reads.push(uri.path); return new TextEncoder().encode('%PDF-1.7 whole'); },
        }),
    }),
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { PdfDocument } = require('../core/pdfViewEditorProvider');
moduleAny._load = originalLoad;
for (const key of Object.keys(require.cache)) {
    if (/[\\/]out[\\/](?!test[\\/])/.test(key)) { delete require.cache[key]; }
}

const projectFile = (file: string) => Uri.parse(`overleaf-workshop://www.overleaf.com/Book/${file}?user%3Du1%26project%3Dp1`);
const output = { url: 'https://dl/zone/d/project/p1/user/u1/build/b1/output/output.pdf?enable_pdf_caching=true', downloadDomain: 'https://dl/zone/d', projectId: 'p1', file: { path: 'output.pdf', size: 885_484_347 } };

describe('what the PDF viewer loads', () => {
    beforeEach(() => { world.reads = []; world.output = output; });

    it('passes the build\'s address to a viewer that loads in ranges, and reads nothing', async () => {
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'overleaf');
        await doc.refresh();
        assert.strictEqual(doc.output, output);
        assert.deepStrictEqual(world.reads, []);
    });

    it('reads any other PDF of the project whole, also in a viewer that loads in ranges', async () => {
        const doc = new PdfDocument(projectFile('slike/figure.pdf'), 'pdfjs');
        await doc.refresh();
        assert.strictEqual(doc.output, undefined);
        assert.deepStrictEqual(world.reads, ['/Book/slike/figure.pdf']);
        assert.strictEqual(new TextDecoder().decode(doc.cache), '%PDF-1.7 whole');
    });

    it('reads the build whole for the legacy viewer, and when this session has not compiled it', async () => {
        await new PdfDocument(projectFile('.output/output.pdf'), 'legacy').refresh();
        assert.deepStrictEqual(world.reads, ['/Book/.output/output.pdf']);
        world.output = undefined;
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'overleaf');
        await doc.refresh();
        assert.strictEqual(doc.output, undefined);
        assert.strictEqual(world.reads.length, 2);
    });

    it('reads a local PDF whole', async () => {
        const doc = new PdfDocument(Uri.file('/home/u/paper/output.pdf'), 'overleaf');
        await doc.refresh();
        assert.deepStrictEqual(world.reads, ['/home/u/paper/output.pdf']);
    });
});
