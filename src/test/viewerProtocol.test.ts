import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PDF_VIEWER_ENGINE, PDF_VIEWER_ENGINES } from '../core/viewerProtocol';

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
