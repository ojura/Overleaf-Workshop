/* eslint-disable @typescript-eslint/naming-convention -- package.json's package names */
import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PDF_VIEWER_ENGINE, PDF_VIEWER_ENGINES, pdfjsReleaseOf } from '../core/viewerProtocol';

// tsc turns import() into require(), which cannot load ES modules
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

/**
 * The messages and types that the extension host and the viewer pages share are defined once, in
 * src/core/viewerProtocol.ts. Where they must be written again, these tests compare.
 */
describe('what the extension host and the PDF viewer pages share', function () {
    this.timeout(60 * 1000);

    it('package.json offers the viewers that the extension defines, with its default', () => {
        const contributes = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).contributes;
        const sections = Array.isArray(contributes.configuration) ? contributes.configuration : [contributes.configuration];
        const setting = sections.map((section: any) => section.properties?.['overleaf-workshop.pdfViewer.engine']).find(Boolean);
        assert.deepStrictEqual(setting.enum, [...PDF_VIEWER_ENGINES]);
        assert.strictEqual(setting.default, DEFAULT_PDF_VIEWER_ENGINE);
    });

    it('the viewers\' build builds the viewers that the extension defines', async () => {
        const { engines } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        assert.deepStrictEqual(engines, [...PDF_VIEWER_ENGINES]);
        // the build script started esbuild's service to read the protocol; another build starts it again
        await (await importModule('esbuild')).stop();
    });

    it('takes the folder of pdf.js\'s release from the release that package.json pins as pdfjs-dist', () => {
        const packageJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
        assert.strictEqual(pdfjsReleaseOf(packageJson), `vendor/pdfjs-${packageJson.devDependencies['pdfjs-dist']}`);
        assert.strictEqual(pdfjsReleaseOf({ dependencies: { 'pdfjs-dist': '9.8.7' } }), 'vendor/pdfjs-9.8.7');
        // a range names no one release, and so no folder
        assert.throws(() => pdfjsReleaseOf({ devDependencies: { 'pdfjs-dist': '^5.1.91' } }), /one release/);
        assert.throws(() => pdfjsReleaseOf({}), /one release/);
    });

    it('the viewers\' build writes that folder into the pages, and gives it to other scripts', async () => {
        const { pdfjsRelease, viewerPage, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const release = pdfjsReleaseOf(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')));
        assert.strictEqual(pdfjsRelease, path.join(viewerRoot, release));
        for (const engine of PDF_VIEWER_ENGINES) {
            const page: string = viewerPage(engine);
            assert.ok(page.includes(`${release}/build/pdf.mjs`), `${engine}: ${release}/build/pdf.mjs`);
            assert.ok(!page.includes('{{'), `${engine}: a placeholder is left`);
        }
        assert.ok(viewerPage('pdfjs').includes(`${release}/web/viewer.mjs`));
        await (await importModule('esbuild')).stop();
    });

    it('the viewer pages\' own sources type-check against the shared protocol', async () => {
        // tsc exits with 0, or with 2 when it reports errors; its report is on its standard output
        const { code, report, stderr } = await new Promise<{ code: unknown, report: string, stderr: string }>((resolve) => {
            execFile(process.execPath, [path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(repo, 'views', 'pdf-viewer', 'tsconfig.json'), '--noEmit'],
                { cwd: repo, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, report: stdout, stderr }));
        });
        assert.ok(code === 0 || code === 2, `tsc did not finish its check: ${String(code)} ${stderr}`);
        // Overleaf's own files, which the viewers import unmodified, miss parts of Overleaf's web app;
        // tsc names files relative to the checkout, with '/'
        const errors = report.split('\n').filter(line => / error TS\d+:/.test(line) && !line.startsWith('views/pdf-viewer/overleaf/'));
        assert.deepStrictEqual(errors, []);
    });
});
