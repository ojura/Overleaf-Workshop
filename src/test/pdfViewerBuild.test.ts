/* eslint-disable @typescript-eslint/naming-convention -- native PDF.js states and esbuild extension keys */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('incremental PDF viewer builds', function () {
    this.timeout(30_000);
    let scratch: string, protocol: any, esbuild: any;
    let originalViewer: string, originalWorker: string;

    before(async () => {
        esbuild = await importModule('esbuild');
        protocol = await importModule(path.join(repo, 'scripts/viewer-protocol.mjs'));
        originalViewer = fs.readFileSync(path.join(protocol.pdfjsRelease, 'web/viewer.mjs'), 'utf8');
        originalWorker = fs.readFileSync(path.join(protocol.pdfjsRelease, 'build/pdf.worker.mjs'), 'utf8');
    });
    beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-build-')); });
    afterEach(async () => {
        await esbuild.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    function earlierPreparedViewer(source = originalViewer) {
        // Reproduce the prepared full viewer from before the cancellation repair. The
        // builders must update this input; the inspected output is never transformed here.
        const repaired = source.includes('// A cancelled native pass returns its owned view to the rendering queue.');
        const changes = [
            ['      if (error instanceof RenderingCancelledException && renderTask === this.renderTask) {\n        onCancel();',
                '      if (error instanceof RenderingCancelledException) {\n        onCancel();'],
            [`      if (e instanceof RenderingCancelledException) {
        // A cancelled native pass returns its owned view to the rendering queue.
        if (renderTask === this.renderTask) {
          this.resume = null;
          this.renderingState = RenderingStates.INITIAL;
        }
        return;
      }\n      error = e;`,
                '      if (e instanceof RenderingCancelledException) {\n        return;\n      }\n      error = e;'],
            ['      if (renderTask === this.renderTask) {\n        this.#renderError = error;\n        this.renderTask = null;',
                '      this.#renderError = error;\n      if (renderTask === this.renderTask) {\n        this.renderTask = null;'],
        ];
        for (const [current, historical] of changes) {
            const expected = repaired ? current : historical;
            assert.strictEqual(source.split(expected).length, 2, 'the prepared input matches its pinned cancellation shape');
            if (repaired) { source = source.replace(current, historical); }
        }
        for (const [current, historical] of changes) {
            assert.strictEqual(source.split(historical).length, 2);
            assert.ok(!source.includes(current), 'the fixture retains the historical cancellation behavior');
        }
        assert.ok(source.includes('// Verified external image passes'), 'all earlier preparation remains installed');
        return source;
    }

    async function fixture() {
        const release = path.join(scratch, 'viewer', protocol.pdfjsReleaseFolder);
        const viewer = path.join(release, 'web/viewer.mjs'), worker = path.join(release, 'build/pdf.worker.mjs');
        fs.mkdirSync(path.dirname(viewer), { recursive: true });
        fs.mkdirSync(path.dirname(worker), { recursive: true });
        const historical = earlierPreparedViewer();
        assert.strictEqual(earlierPreparedViewer(historical), historical, 'a genuinely older prepared input is already a valid fixture');
        fs.writeFileSync(viewer, historical);
        const format = /^const PDF_READING_FORMAT = .*; \/\/ PDF_READING_FORMAT_INPUT$/m;
        assert.ok(format.test(originalWorker));
        fs.writeFileSync(worker, originalWorker.replace(format, 'const PDF_READING_FORMAT = {}; // PDF_READING_FORMAT_INPUT'));
        fs.copyFileSync(path.join(protocol.pdfjsRelease, 'web/viewer.html'), path.join(release, 'web/viewer.html'));
        const output = path.join(scratch, 'builders');
        // Only the generated release location changes. Both maintained builder bodies,
        // their shared preparation helper, input sources and esbuild calls run unchanged.
        await esbuild.build({
            entryPoints: {
                viewers: path.join(repo, 'scripts/build-pdf-viewer.mjs'),
                standalone: path.join(repo, 'scripts/build-spomenar.mjs'),
                preparation: path.join(repo, 'scripts/pdfjs-image-revisions.mjs'),
            },
            outdir: output, bundle: true, format: 'esm', platform: 'node', target: 'es2022',
            packages: 'external', outExtension: { '.js': '.mjs' }, logLevel: 'silent',
            plugins: [{ name: 'isolated-prepared-release', setup(build: any) {
                build.onResolve({ filter: /^esbuild$/ }, () => ({ path: require.resolve('esbuild'), external: true }));
                build.onResolve({ filter: /^\.\/viewer-protocol\.mjs$/ }, () => ({ path: 'protocol', namespace: 'prepared-release-test' }));
                build.onLoad({ filter: /.*/, namespace: 'prepared-release-test' }, () => ({ loader: 'js', contents:
                    Object.entries({ repo, viewerRoot: protocol.viewerRoot, pdfjsRelease: release,
                        pdfjsReleaseFolder: protocol.pdfjsReleaseFolder, pdfjsVersion: protocol.pdfjsVersion, protocol: protocol.protocol })
                        .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join('\n'),
                }));
            } }],
        });
        const viewers = await importModule(path.join(output, 'viewers.mjs'));
        const standalone = await importModule(path.join(output, 'standalone.mjs'));
        const preparation = await importModule(path.join(output, 'preparation.mjs'));
        return { release, viewer, worker, viewers, standalone, preparation };
    }

    async function assertCancelledOwnerIsReleased(file: string) {
        const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const base = source.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'BasePDFPageView');
        assert.ok(base, 'the asset the reader loads contains the actual native page view');
        class Cancelled extends Error {}
        const states = { INITIAL: 0, RUNNING: 1, PAUSED: 2, FINISHED: 3 };
        const Constructor = new Function('RenderingStates', 'RenderingCancelledException', 'document', base.getText(source) + '\nreturn BasePDFPageView;')(states, Cancelled, {});
        const page = new Constructor({ id: 1, eventBus: { dispatch() {} } });
        page.div = { classList: { add() {}, remove() {} } };
        let reject!: (error: Error) => void;
        const task: any = { promise: new Promise<void>((_resolve, fail) => { reject = fail; }) };
        page.pdfPage = { render: () => task };
        page.canvas = {}; page.renderingState = states.RUNNING;
        const pending = page._drawCanvas({}, () => { page.canvas = null; }, () => assert.fail('cancelled work cannot publish a completed page'));
        try {
            const error = new Cancelled('image intent cancelled');
            reject(error); task.onError(error); await pending;
            assert.strictEqual(page.renderTask, null);
            assert.strictEqual(page.canvas, null);
            assert.strictEqual(page.renderingState, states.INITIAL, 'the shipped full viewer must release its cancelled owner');
        } finally { await pending; page.renderingState = states.INITIAL; }
    }

    for (const engine of ['extension', 'standalone']) {
        it(`${engine} builder refreshes an earlier prepared full viewer before it can be shipped`, async () => {
            const f = await fixture();
            const output = engine === 'extension' ? path.join(scratch, 'viewer/dist') : path.join(scratch, 'site');
            let asset: string;
            if (engine === 'extension') {
                await f.viewers.buildViewers(output);
                const html = fs.readFileSync(path.join(output, 'pdfjs.html'), 'utf8');
                assert.ok(html.includes(`${protocol.pdfjsReleaseFolder}/web/viewer.mjs`));
                assert.ok(fs.statSync(path.join(output, 'overleaf.mjs')).size > 0);
                asset = f.viewer;
            } else {
                await f.standalone.buildSpomenar(output);
                asset = path.join(output, 'assets/pdfjs/web/viewer.mjs');
                assert.ok(fs.readFileSync(path.join(output, 'index.html'), 'utf8').includes('assets/pdfjs/web/viewer.mjs'));
            }
            await assertCancelledOwnerIsReleased(asset);
            assert.strictEqual(fs.readFileSync(f.worker, 'utf8'), originalWorker, 'the same preparation updates the worker format');
            if (engine === 'standalone') {
                assert.strictEqual(fs.readFileSync(path.join(output, 'assets/pdfjs/build/pdf.worker.mjs'), 'utf8'), originalWorker);
            }
        });

        for (const invalid of ['missing', 'unsupported']) {
            it(`${engine} builder rejects ${invalid} prepared input before changing prior output or worker`, async () => {
                const f = await fixture();
                const output = path.join(scratch, 'prior-output');
                fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'previous.txt'), 'accepted build');
                const worker = fs.readFileSync(f.worker, 'utf8');
                if (invalid === 'missing') { fs.rmSync(f.viewer); }
                else { fs.writeFileSync(f.viewer, 'export const unsupportedViewer = true;\n'); }
                const build = engine === 'extension' ? f.viewers.buildViewers : f.standalone.buildSpomenar;
                await assert.rejects(build(output), invalid === 'missing' ? /ENOENT/ : /pinned cancellation hook/);
                assert.deepStrictEqual(fs.readdirSync(output), ['previous.txt']);
                assert.strictEqual(fs.readFileSync(path.join(output, 'previous.txt'), 'utf8'), 'accepted build');
                assert.strictEqual(fs.readFileSync(f.worker, 'utf8'), worker, 'all input transforms validate before either file is changed');
            });
        }
    }

    it('prepares changed files atomically and leaves current prepared files untouched', async () => {
        const f = await fixture(), files = [f.worker, f.viewer];
        const prior = files.map(file => fs.readFileSync(file, 'utf8'));
        const modes = [0o664, 0o640];
        files.forEach((file, index) => fs.chmodSync(file, modes[index]));
        const readers = files.map(file => fs.openSync(file, 'r'));
        try {
            f.preparation.installImageRevisions(f.release);
            files.forEach((file, index) => {
                assert.strictEqual(fs.readFileSync(readers[index], 'utf8'), prior[index], 'an existing reader keeps the complete old file');
                assert.notStrictEqual(fs.readFileSync(file, 'utf8'), prior[index]);
                assert.strictEqual(fs.statSync(file).mode & 0o777, modes[index]);
                fs.utimesSync(file, new Date(1000), new Date(1000));
            });
            const before = files.map(file => fs.statSync(file));
            f.preparation.installImageRevisions(f.release);
            files.forEach((file, index) => {
                const after = fs.statSync(file);
                assert.strictEqual(after.ino, before[index].ino, 'a current prepared file retains its inode');
                assert.strictEqual(after.mtimeMs, before[index].mtimeMs, 'a current prepared file is not rewritten');
            });
            assert.deepStrictEqual(fs.readdirSync(path.dirname(f.release)), [path.basename(f.release)], 'preparation removes its own temporary paths');
        } finally { readers.forEach(reader => fs.closeSync(reader)); }
    });
});
