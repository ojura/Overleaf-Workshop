/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import * as path from 'path';
import { loadWithVscode, strict } from './standIn';

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

/**
 * The project as the PDF document sees it (VirtualFileSystem): its build in use, which changes when
 * a test says so, and the address of that build's output.pdf.
 */
const project = {
    build: undefined as { id: string } | undefined,
    output: undefined as any,
    listeners: new Set<(build: unknown) => void>(),
    /** the build in use changes to `id`, with output.pdf at `output` */
    use(id: string, output: unknown) {
        this.build = { id };
        this.output = output;
        this.listeners.forEach(listener => listener(this.build));
    },
};
const vfs = {
    builds: {
        get build() { return project.build; },
        onDidChangeBuild: (listener: (build: unknown) => void) => {
            project.listeners.add(listener);
            return () => { project.listeners.delete(listener); };
        },
    },
    pdfOutput: () => project.output,
};

const world = { reads: [] as string[], unreadable: new Set<string>() };
const vscodeStandIn = strict('vscode', {
    Uri,
    EventEmitter: class {
        private listeners: ((value: any) => void)[] = [];
        event = (listener: (value: any) => void) => { this.listeners.push(listener); return { dispose() {} }; };
        fire(value: any) { this.listeners.forEach(listener => listener(value)); }
        dispose() { this.listeners = []; }
    },
    l10n: strict('vscode.l10n', { t: (message: string) => message }),
    window: strict('vscode.window', {}),
    commands: strict('vscode.commands', {
        executeCommand: async (command: string) => {
            if (command !== 'remoteFileSystem.prefetch') { throw new Error(`the test has no command ${command}`); }
            return vfs;
        },
    }),
    // classes that the extension's modules extend when they load
    TreeItem: class {},
    QuickPickItem: class {},
    Disposable: class { dispose() {} },
    workspace: strict('vscode.workspace', {
        getConfiguration: () => ({ get: (_key: string, value: unknown) => value }),
        fs: strict('vscode.workspace.fs', {
            readFile: async (uri: Uri) => {
                world.reads.push(uri.path);
                if (world.unreadable.has(uri.path)) { throw new Error(`${uri.path}: unavailable`); }
                return new TextEncoder().encode('%PDF-1.7 whole');
            },
        }),
    }),
});
const { PdfDocument } = loadWithVscode(vscodeStandIn, () => require('../core/pdfViewEditorProvider'));

const projectFile = (file: string) => Uri.parse(`overleaf-workshop://www.overleaf.com/Book/${file}?user%3Du1%26project%3Dp1`);
const outputOf = (build: string) => ({
    url: `https://dl/zone/d/project/p1/user/u1/build/${build}/output/output.pdf?enable_pdf_caching=true`,
    downloadDomain: 'https://dl/zone/d', projectId: 'p1', file: { path: 'output.pdf', build, size: 885_484_347 },
});

describe('what the PDF viewer loads', () => {
    beforeEach(() => {
        world.reads = [];
        world.unreadable.clear();
        project.build = undefined;
        project.output = undefined;
        project.listeners.clear();
    });

    it('passes the build\'s address to the viewers, which load it in ranges, and reads nothing', async () => {
        project.use('b1', outputOf('b1'));
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'overleaf');
        await doc.refresh();
        assert.deepStrictEqual(doc.output, outputOf('b1'));
        assert.deepStrictEqual(world.reads, []);
    });

    it('follows the build in use, and tells the viewers only about a new build', async () => {
        project.use('b1', outputOf('b1'));
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'pdfjs');
        const changes: string[] = [];
        doc.onDidChange((change: any) => changes.push(change.output?.file.build));
        await doc.refresh();
        // another client's compile became the build in use (ProjectBuilds)
        project.use('b2', outputOf('b2'));
        assert.strictEqual(doc.output.file.build, 'b2');
        // the same build again
        project.use('b2', outputOf('b2'));
        assert.deepStrictEqual(changes, ['b1', 'b2']);
    });

    it('shows nothing and reads nothing while the project has no build', async () => {
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'overleaf');
        const changes: unknown[] = [];
        doc.onDidChange((change: unknown) => changes.push(change));
        await doc.refresh();
        assert.strictEqual(doc.output, undefined);
        assert.deepStrictEqual(changes, []);
        assert.deepStrictEqual(world.reads, []);
    });

    it('reads a build whole that the download domain does not serve, as without one on a server of one\'s own', async () => {
        project.use('b1', undefined);
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'overleaf');
        await doc.refresh();
        assert.strictEqual(doc.output, undefined);
        assert.deepStrictEqual(world.reads, ['/Book/.output/output.pdf']);
        assert.strictEqual(new TextDecoder().decode(doc.cache), '%PDF-1.7 whole');
    });

    it('reads any other PDF of the project whole', async () => {
        const doc = new PdfDocument(projectFile('slike/figure.pdf'), 'pdfjs');
        await doc.refresh();
        assert.strictEqual(doc.output, undefined);
        assert.deepStrictEqual(world.reads, ['/Book/slike/figure.pdf']);
        assert.strictEqual(new TextDecoder().decode(doc.cache), '%PDF-1.7 whole');
    });

    it('fails to open a PDF that cannot be read, instead of showing an empty one', async () => {
        world.unreadable.add('/Book/slike/figure.pdf');
        const doc = new PdfDocument(projectFile('slike/figure.pdf'), 'pdfjs');
        await assert.rejects(doc.refresh(), /unavailable/);
        assert.strictEqual(doc.cache.byteLength, 0);
    });

    it('opens a PDF in the pdfjs viewer when no viewer is named', () => {
        assert.strictEqual(new PdfDocument(projectFile('.output/output.pdf')).engine, 'pdfjs');
    });

    it('reads a local PDF whole', async () => {
        const doc = new PdfDocument(Uri.file('/home/u/paper/output.pdf'), 'overleaf');
        await doc.refresh();
        assert.deepStrictEqual(world.reads, ['/home/u/paper/output.pdf']);
    });

    it('stops following the build in use when it is closed', async () => {
        project.use('b1', outputOf('b1'));
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'overleaf');
        await doc.refresh();
        doc.dispose();
        assert.strictEqual(project.listeners.size, 0);
    });
});

describe('switching the viewer of an open PDF', () => {
    beforeEach(() => {
        world.reads = [];
        project.listeners.clear();
        project.use('b1', outputOf('b1'));
    });

    it('keeps a build loaded in ranges between the two viewers that load in ranges', async () => {
        const doc = new PdfDocument(projectFile('.output/output.pdf'), 'pdfjs');
        await doc.refresh();
        assert.strictEqual(await doc.setEngine('overleaf'), true);
        assert.strictEqual(doc.engine, 'overleaf');
        assert.deepStrictEqual(doc.output, outputOf('b1'));
        assert.deepStrictEqual(world.reads, []);
        assert.strictEqual(await doc.setEngine('overleaf'), false);
    });

    it('does not read a PDF read whole again', async () => {
        const doc = new PdfDocument(projectFile('slike/figure.pdf'), 'pdfjs');
        await doc.refresh();
        assert.strictEqual(await doc.setEngine('overleaf'), true);
        assert.deepStrictEqual(world.reads, ['/Book/slike/figure.pdf']);
    });
});
