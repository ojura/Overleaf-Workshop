import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
describe('successful page presentation evidence', () => {
    let directory: string, api: any;
    before(async () => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-presentation-'));
        const esbuild = await importModule('esbuild');
        try { await esbuild.build({ entryPoints: [path.resolve(__dirname, '../../views/pdf-viewer/src/common/pdf-page-presentation.ts')],
            outfile: path.join(directory, 'presentation.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' }); }
        finally { await esbuild.stop(); }
        api = await importModule(path.join(directory, 'presentation.mjs'));
    });
    after(() => fs.rmSync(directory, { recursive: true, force: true }));

    it('compares actual covered object identities rather than equal counts and requires all aliases', () => {
        const owner = new api.PdfPagePresentation(), document = {}, page = {}, intent = {};
        const resource = (objectId: string, covered: boolean) => ({ objectId, imageId: 'x5', covered, final: false, failed: false });
        const candidate = (resources: any[], revision = 1) => ({ document, page, appearance: 'same', successful: true, revision,
            coverage: { kind: 'native', intent, discovered: true, resources } });
        let commits = 0;
        assert.ok(owner.present(candidate([resource('a', true), resource('b', false)]), () => commits++));
        assert.strictEqual(owner.present(candidate([resource('a', false), resource('b', true)], 2), () => commits++), false);
        assert.strictEqual(commits, 1);
        assert.strictEqual(api.pdfImageResourceReady(owner.current().coverage, 'x5'), false);
        assert.strictEqual(api.pdfImageResourceReady(owner.current().coverage, 'missing'), false);
        assert.ok(owner.present(candidate([resource('a', true), resource('b', true)], 3), () => commits++));
        assert.strictEqual(api.pdfImageResourceReady(owner.current().coverage, 'x5'), true);
    });

    it('keeps failed, unknown and complete-page predecessors distinct from known empty external coverage', () => {
        const document = {}, page = {}, base = { document, page, appearance: 'same', successful: true, revision: 0 };
        const partial = { ...base, revision: 1, coverage: { kind: 'native', intent: {}, discovered: true,
            resources: [{ objectId: 'a', imageId: 'x1', covered: true }, { objectId: 'b', imageId: 'x2', covered: false }] } };
        for (const coverage of [{ kind: 'unknown' }, { kind: 'complete-page' }]) {
            const owner = new api.PdfPagePresentation(); owner.present({ ...base, coverage }, () => {});
            assert.strictEqual(owner.accepts(partial), false);
        }
        const owner = new api.PdfPagePresentation();
        owner.present({ ...base, coverage: { kind: 'native', intent: {}, discovered: true, resources: [] } }, () => {});
        assert.strictEqual(owner.accepts(partial), true);
        assert.strictEqual(owner.accepts({ ...partial, successful: false }), false);
        assert.throws(() => owner.present(partial, () => { throw new Error('commit rejected'); }), /commit rejected/);
        assert.strictEqual(owner.current().revision, 0);
    });
});
