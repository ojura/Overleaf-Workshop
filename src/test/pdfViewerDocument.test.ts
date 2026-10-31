/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
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

const world = { reads: [] as string[], output: undefined as any, projectReads: [] as string[], projectFails: false };
const vscodeMock = withStubs({
    Uri,
    Disposable: class { dispose() {} },
    EventEmitter: class {
        private listeners: ((value: any) => void)[] = [];
        event = (listener: (value: any) => void) => { this.listeners.push(listener); return { dispose() {} }; };
        fire(value: any) { this.listeners.forEach(listener => listener(value)); }
        dispose() {}
    },
    TreeItem: class {},
    l10n: { t: (message: string) => message },
    commands: withStubs({
        executeCommand: async (command: string) => command === 'remoteFileSystem.prefetch' ? {
            pdfOutput: () => world.output,
            // the project's own read, in the extension host
            openFile: async (uri: Uri) => {
                world.projectReads.push(uri.path);
                if (world.projectFails) { throw new Error('the project could not read it'); }
                return new TextEncoder().encode('%PDF-1.7 read through the project');
            },
        } : undefined,
    }),
    workspace: withStubs({
        getConfiguration: () => ({ get: (_key: string, value: any) => value }),
        fs: withStubs({
            readFile: async (uri: Uri) => { world.reads.push(uri.path); return new TextEncoder().encode('%PDF-1.7 whole'); },
            // the legacy viewer's build folder, on disk
            createDirectory: async (uri: Uri) => { await fs.promises.mkdir(uri.fsPath, { recursive: true }); },
            stat: async (uri: Uri) => { await fs.promises.stat(uri.fsPath); return { type: 1 }; },
            readDirectory: async (uri: Uri) => (await fs.promises.readdir(uri.fsPath)).map(name => [name, 1]),
            delete: async (uri: Uri) => { await fs.promises.rm(uri.fsPath, { force: true }); },
            writeFile: async (uri: Uri, content: Uint8Array) => { await fs.promises.writeFile(uri.fsPath, content); },
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

    it('reads the build whole for the legacy viewer without a build folder, and when this session has not compiled it', async () => {
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

describe('switching the viewer of an open PDF', () => {
    beforeEach(() => { world.reads = []; world.output = output; });

    it('keeps a build loaded in ranges between the two viewers that load in ranges', async () => {
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'pdfjs');
        await doc.refresh();
        assert.strictEqual(await doc.setEngine('overleaf'), true);
        assert.strictEqual(doc.engine, 'overleaf');
        assert.strictEqual(doc.output, output);
        assert.deepStrictEqual(world.reads, []);
        assert.strictEqual(await doc.setEngine('overleaf'), false);
    });

    it('reads a build whole for the legacy viewer, and back in ranges after it', async () => {
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'overleaf');
        await doc.refresh();
        assert.strictEqual(await doc.setEngine('legacy'), true);
        assert.strictEqual(doc.output, undefined);
        assert.deepStrictEqual(world.reads, ['/Book/.output/output.pdf']);
        assert.strictEqual(await doc.setEngine('pdfjs'), true);
        assert.strictEqual(doc.output, output);
        assert.strictEqual(world.reads.length, 1);
    });

    it('does not read a PDF read whole again', async () => {
        const doc = new PdfDocument(projectFile('slike/figure.pdf'), 'pdfjs');
        await doc.refresh();
        assert.strictEqual(await doc.setEngine('legacy'), true);
        assert.deepStrictEqual(world.reads, ['/Book/slike/figure.pdf']);
    });
});

async function until(condition: () => boolean, ms = 3000) {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 10))) {
        if (condition()) { return; }
    }
    assert.fail('timed out waiting');
}

describe('the legacy viewer and a build', () => {
    let folder: string;
    let server: http.Server;
    let requests: string[];
    let status: number;
    let delayMs: number;
    let base: string;

    beforeEach(async () => {
        world.reads = [];
        world.projectReads = [];
        world.projectFails = false;
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-legacy-builds-'));
        requests = [];
        status = 200;
        delayMs = 0;
        // Overleaf's download domain, which answers ranges as Overleaf's viewer asks for them
        server = http.createServer((req, res) => {
            requests.push(req.url!);
            if (status !== 200) { res.writeHead(status); res.end(); return; }
            const body = content(req.url!.split('?')[0]);
            const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
            const [start, end] = range ? [Number(range[1]), Math.min(Number(range[2]), body.byteLength - 1)] : [0, body.byteLength - 1];
            const part = body.subarray(start, end + 1);
            res.writeHead(range ? 206 : 200, {
                'content-type': 'application/pdf', 'content-length': part.byteLength,
                ...(range ? { 'content-range': `bytes ${start}-${end}/${body.byteLength}` } : {}),
            });
            // a part at once, the rest after the delay, as a large build arrives
            res.write(part.subarray(0, 10));
            setTimeout(() => res.end(part.subarray(10)), delayMs);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        base = `http://127.0.0.1:${(server.address() as any).port}`;
    });
    afterEach(async () => {
        server.closeAllConnections(); // the download keeps its connections open for reuse
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(folder, { recursive: true, force: true });
    });

    const content = (pathname: string) => Buffer.from(`%PDF-1.7 ${pathname}`);
    const build = (id: string) => {
        const pathname = `/project/p1/user/u1/build/${id}/output/output.pdf`;
        return {
            url: `${base}${pathname}?compileGroup=priority&enable_pdf_caching=true`, downloadDomain: base, projectId: 'p1',
            file: { path: 'output.pdf', size: content(pathname).byteLength, build: id },
        };
    };

    it('downloads the build to a file of its own, which the viewer page opens, and reads nothing through the IDE', async () => {
        world.output = build('b1');
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'legacy', Uri.file(folder));
        await doc.refresh();
        assert.deepStrictEqual(world.reads, []);
        assert.strictEqual(doc.output, undefined);
        assert.strictEqual(doc.file.fsPath, path.join(folder, 'p1-b1.pdf'));
        assert.strictEqual(fs.readFileSync(doc.file.fsPath, 'utf8'), '%PDF-1.7 /project/p1/user/u1/build/b1/output/output.pdf');
        assert.strictEqual(doc.cache.byteLength, 0);
    });

    it('keeps one build per project: a new build replaces the old file, and the same build is not downloaded twice', async () => {
        world.output = build('b1');
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'legacy', Uri.file(folder));
        await doc.refresh();
        world.output = build('b2');
        await doc.refresh();
        assert.deepStrictEqual(fs.readdirSync(folder), ['p1-b2.pdf']);
        await doc.refresh();
        assert.strictEqual(requests.length, 2);
    });

    it('downloads a build once when it is refreshed again while it downloads, as on opening and after a compile', async () => {
        world.output = build('b1');
        delayMs = 300;
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'legacy', Uri.file(folder));
        const fired: any[] = [];
        doc.onDidChange((change: any) => fired.push(change));
        const first = doc.refresh();
        await until(() => requests.length === 1); // the download is under way
        await Promise.all([first, doc.refresh()]);
        assert.strictEqual(requests.length, 1);
        assert.deepStrictEqual(world.reads, []);
        assert.deepStrictEqual(fs.readdirSync(folder), ['p1-b1.pdf']);
        assert.deepStrictEqual(fired.map(change => change.file?.fsPath), [path.join(folder, 'p1-b1.pdf')], 'the viewer page loads the build once');
    });

    it('stops the download of an older build for a newer one, and does not show or read the older one', async () => {
        world.output = build('b1');
        delayMs = 300;
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'legacy', Uri.file(folder));
        const fired: any[] = [];
        doc.onDidChange((change: any) => fired.push(change));
        const first = doc.refresh();
        await until(() => requests.length === 1);
        world.output = build('b2');
        delayMs = 0;
        await Promise.all([first, doc.refresh()]);
        assert.deepStrictEqual(world.reads, []);
        assert.deepStrictEqual(fired.map(change => change.file?.fsPath), [path.join(folder, 'p1-b2.pdf')]);
        assert.strictEqual(doc.file.fsPath, path.join(folder, 'p1-b2.pdf'));
        assert.strictEqual(fs.readFileSync(doc.file.fsPath, 'utf8'), '%PDF-1.7 /project/p1/user/u1/build/b2/output/output.pdf');
        assert.deepStrictEqual(fs.readdirSync(folder).filter(f => !f.endsWith('.part')), ['p1-b2.pdf']);
    });

    it('reads the build through the project, in the extension host, when the download domain fails', async () => {
        world.output = build('b1');
        status = 500;
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'legacy', Uri.file(folder));
        await doc.refresh();
        assert.strictEqual(requests.length, 3, 'the range was asked for three times');
        assert.deepStrictEqual(world.projectReads, ['/Book/.output/output.pdf']);
        assert.deepStrictEqual(world.reads, [], 'not through the IDE');
        assert.strictEqual(fs.readFileSync(doc.file.fsPath, 'utf8'), '%PDF-1.7 read through the project');
    });

    it('reads the build through the IDE, as before, when the project cannot read it either', async () => {
        world.output = build('b1');
        status = 500;
        world.projectFails = true;
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'legacy', Uri.file(folder));
        await doc.refresh();
        assert.strictEqual(doc.file, undefined);
        assert.deepStrictEqual(world.reads, ['/Book/.output/output.pdf']);
        assert.deepStrictEqual(fs.readdirSync(folder), []);
    });

    it('loads a build in ranges again when the viewer is switched from the legacy one', async () => {
        world.output = build('b1');
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'legacy', Uri.file(folder));
        await doc.refresh();
        assert.ok(doc.file);
        assert.strictEqual(await doc.setEngine('overleaf'), true);
        assert.strictEqual(doc.file, undefined);
        assert.strictEqual(doc.output, world.output);
    });
});
