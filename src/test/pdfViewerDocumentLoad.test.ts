/* eslint-disable @typescript-eslint/naming-convention -- PDF.js exports */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('prepared Spomenar editions', function () {
    this.timeout(30_000);
    let directory: string, loader: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-edition-test-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/standalone/document-load.ts')],
                outfile: path.join(directory, 'load.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
            loader = await importModule(path.join(directory, 'load.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    const config = { pdfUrl: 'https://book.test/versions/a/book.pdf', filename: 'Book.pdf', title: 'Book',
        previews: { manifestUrl: 'https://book.test/previews/a/manifest.json', sha256: 'a'.repeat(64), size: 1234,
            validator: { header: 'ETag', value: '"edition-a"' } } };

    function fixture() {
        const counts = { aborts: 0, destroys: 0, pages: 0, tasks: 0, workers: 0, workerDestroys: 0 };
        const source = { length: 1234, validator: { header: 'ETag', value: '"edition-a"' },
            documentParams: { range: {}, length: 1234, disableStream: true }, abort: () => { counts.aborts++; } };
        const document = { numPages: 460, getPage: async (page: number) => { assert.strictEqual(page, 1); counts.pages++; return {}; } };
        let implicitWorker: { destroy(): void } | undefined;
        const task = { promise: Promise.resolve(document) as Promise<any>, destroy: async () => { counts.destroys++; implicitWorker?.destroy(); } };
        const controller = new AbortController();
        let params: any;
        const pdfjs = { PDFWorker: class {
            constructor() { counts.workers++; }
            destroy() { counts.workerDestroys++; }
        }, getDocument: (value: any) => {
            counts.tasks++; params = value;
            if (!value.worker) { implicitWorker = new pdfjs.PDFWorker(); }
            return task;
        } };
        const options = { signal: controller.signal, requirePreviewIdentity: true, apiParams: { enableScripting: false },
            openRange: async () => source, onError: assert.fail };
        return { counts, source, document, task, controller, pdfjs, options, params: () => params };
    }

    it('prepares validated PDF metadata and its first page before handing ownership to the viewer', async () => {
        const f = fixture();
        const ready = await loader.prepareSiteDocument(f.pdfjs, config, f.options);
        assert.strictEqual(ready.document, f.document);
        assert.strictEqual(ready.task, f.task);
        assert.strictEqual(f.counts.pages, 1);
        assert.strictEqual(f.params().enableScripting, false);
        assert.strictEqual(f.params().range, f.source.documentParams.range);
        assert.strictEqual(f.counts.aborts, 0);
        ready.destroy(); ready.destroy(); f.controller.abort(); await flush();
        assert.strictEqual(f.counts.aborts, 1); assert.strictEqual(f.counts.destroys, 1);
    });

    it('rejects a publication/source mismatch before PDF.js creates a task', async () => {
        const f = fixture(); f.source.validator.value = '"changed"';
        await assert.rejects(loader.prepareSiteDocument(f.pdfjs, config, f.options), /konfiguraciji/);
        assert.strictEqual(f.counts.tasks, 0); assert.strictEqual(f.counts.aborts, 1);
    });

    it('cancels a load whose PDF.js promise never settles after transport destruction', async () => {
        const f = fixture(); f.task.promise = new Promise(() => {});
        const pending = loader.prepareSiteDocument(f.pdfjs, config, f.options);
        await flush(); f.controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        assert.strictEqual(f.counts.aborts, 1); assert.strictEqual(f.counts.destroys, 1);
    });

    it('releases a source returned after cancellation without constructing a stale document', async () => {
        const f = fixture(); let release!: (value: any) => void;
        f.options.openRange = () => new Promise(resolve => { release = resolve; });
        const pending = loader.prepareSiteDocument(f.pdfjs, config, f.options);
        f.controller.abort(); release(f.source);
        await assert.rejects(pending, { name: 'AbortError' });
        assert.strictEqual(f.counts.tasks, 0); assert.strictEqual(f.counts.aborts, 1);
    });

    it('rejects a broken first page and a range failure while leaving current-view ownership to the caller', async () => {
        const f = fixture(); f.document.getPage = async () => { throw new Error('broken first page'); };
        await assert.rejects(loader.prepareSiteDocument(f.pdfjs, config, f.options), /broken first page/);
        assert.strictEqual(f.counts.aborts, 1); assert.strictEqual(f.counts.destroys, 1);
        const g = fixture(); g.task.promise = new Promise(() => {});
        let rangeError!: (error: Error) => void, reported = 0;
        const pending = loader.prepareSiteDocument(g.pdfjs, config, { ...g.options,
            openRange: async (_pdfjs: any, _url: string, options: any) => { rangeError = options.onError; return g.source; },
            onError: () => { reported++; } });
        await flush(); rangeError(new Error('range interrupted'));
        await assert.rejects(pending, /range interrupted/);
        assert.strictEqual(reported, 1); assert.strictEqual(g.counts.destroys, 1);
    });

    it('owns and releases the candidate worker even when task destruction never settles', async () => {
        const f = fixture();
        f.task.destroy = () => { f.counts.destroys++; return new Promise(() => {}); };
        const ready = await loader.prepareSiteDocument(f.pdfjs, config, f.options);
        assert.strictEqual(f.counts.workers, 1);
        ready.destroy(); ready.destroy(); f.controller.abort();
        assert.strictEqual(f.counts.workerDestroys, 1); assert.strictEqual(f.counts.destroys, 1);
        assert.strictEqual(f.counts.aborts, 1);
        assert.ok(f.params().worker instanceof f.pdfjs.PDFWorker);
    });

    it('releases an allocated worker when getDocument throws before returning a task', async () => {
        const f = fixture();
        f.pdfjs.getDocument = () => { throw new Error('getDocument failed'); };
        await assert.rejects(loader.prepareSiteDocument(f.pdfjs, config, f.options), /getDocument failed/);
        assert.strictEqual(f.counts.workers, 1); assert.strictEqual(f.counts.workerDestroys, 1);
        assert.strictEqual(f.counts.aborts, 1); assert.strictEqual(f.counts.destroys, 0);
    });

    it('preserves zoom and PDF coordinates, clamps a shorter edition, and keeps presentation modes', () => {
        const app = { pdfViewer: { currentPageNumber: 121, currentScaleValue: '0.9', currentScale: 0.9,
            pagesRotation: 90, scrollMode: 0, spreadMode: 1 }, pdfSidebar: { visibleView: 2 } };
        const view = loader.captureSiteView(app, '#page=121&zoom=90,12,350&nameddest=old&pagemode=thumbs', 100);
        const params = new URLSearchParams(view.hash);
        assert.strictEqual(params.get('page'), '100'); assert.strictEqual(params.get('zoom'), '90,12,350');
        assert.strictEqual(params.has('nameddest'), false); assert.strictEqual(params.has('pagemode'), false);
        assert.deepStrictEqual({ ...view, hash: undefined }, { hash: undefined, rotation: 90, sidebarView: 2, scrollMode: 0, spreadMode: 1 });
        app.pdfViewer.currentScaleValue = 'page-width';
        assert.strictEqual(new URLSearchParams(loader.captureSiteView(app, '', 460).hash).get('zoom'), 'page-width');
    });
});
