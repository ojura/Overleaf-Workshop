import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
describe('PDF crop quality reaction ownership', () => {
    let directory: string, api: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-quality-'));
        try {
            await esbuild.build({ entryPoints: [path.resolve(__dirname, '../../views/pdf-viewer/src/common/pdf-quality-reactions.ts')],
                outfile: path.join(directory, 'quality.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
            api = await importModule(path.join(directory, 'quality.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });
    function fixture() {
        const owner = new api.PdfQualityReactions(), page = {};
        const partial = { page, pageNumber: 1, key: 'crop1', imageId: 'photo', imageIds: ['photo'], quality: 'partial', width: 80, height: 100 };
        const final = { ...partial, quality: 'final', width: 160, height: 200 };
        const calls = { reserve: 0, commit: 0, abort: 0, cancel: 0 };
        const reserve = () => { calls.reserve++; return { effect: {
            commit() { calls.commit++; }, abort() { calls.abort++; }, cancel() { calls.cancel++; },
        } }; };
        return { owner, page, partial, final, calls, reserve };
    }
    it('aborts every prepared copy on removal/reset/failure and ignores late duplicate settlement', () => {
        for (const end of ['removePage', 'reset', 'failPage']) {
            const f = fixture(), tx = f.owner.prepare(f.final, f.partial, f.reserve);
            if (end === 'reset') { f.owner.reset(); } else { f.owner[end](f.page); }
            tx.commit(); tx.abort(); tx.commit();
            assert.strictEqual(f.calls.abort, 1, end); assert.strictEqual(f.calls.commit, 0, end);
            assert.strictEqual(f.owner.snapshot().active + f.owner.pending, 0, end);
            assert.strictEqual(f.owner.snapshot().prepared, 0, end);
        }
    });
    it('releases provisional partial reservations and prevents stale commit from recreating metadata', () => {
        const f = fixture(), tx = f.owner.prepare(f.partial, undefined, f.reserve);
        assert.strictEqual(f.owner.pending, 1); f.owner.reset(); assert.strictEqual(f.owner.pending, 0);
        tx.commit(); tx.abort(); assert.strictEqual(f.owner.pending, 0); assert.strictEqual(f.calls.reserve, 0);
    });
    it('requires the supplied previous pixels to belong to the same source and crop', () => {
        const f = fixture();
        for (const patch of [{ page: {} }, { pageNumber: 2 }, { key: 'other' }, { imageIds: ['other'] }]) {
            assert.throws(() => f.owner.prepare(f.final, { ...f.partial, ...patch }, f.reserve), /another source crop/);
        }
        assert.strictEqual(f.calls.reserve, 0);
    });
    it('spends a direct-sharp fallback once but preserves an aborted admission for retry', () => {
        const f = fixture(); f.owner.prepare(f.final, f.partial, () => ({ reason: 'actor-limit' })).commit();
        f.owner.prepare(f.final, f.partial, f.reserve).commit();
        assert.strictEqual(f.calls.reserve, 0); assert.strictEqual(f.owner.snapshot().skipped, 1);
        assert.strictEqual(f.owner.snapshot().lastDecision.reason, 'actor-limit');
        const g = fixture(); g.owner.prepare(g.final, g.partial, g.reserve).abort();
        g.owner.prepare(g.final, g.partial, g.reserve).commit();
        assert.strictEqual(g.calls.reserve, 2); assert.strictEqual(g.calls.abort, 1); assert.strictEqual(g.calls.commit, 1);
        assert.strictEqual(g.owner.snapshot().active, 1);
    });
    it('does not reopen settled source failure when the old partial raster is merely observed', () => {
        const f = fixture(); f.owner.prepare(f.partial, undefined, f.reserve).commit();
        f.owner.failPage(f.page); assert.strictEqual(f.owner.pending, 0);
        f.owner.observe(f.partial); assert.strictEqual(f.owner.pending, 0);
        f.owner.prepare(f.partial, undefined, f.reserve).commit(); assert.strictEqual(f.owner.pending, 1,
            'a genuinely new successful publication can create a new partial-quality opportunity');
        f.owner.reset();
    });
    it('permits a genuinely larger final backing without treating ordinary final revisions as another wipe', () => {
        const f = fixture(); f.owner.prepare(f.final, undefined, f.reserve).commit();
        f.owner.prepare(f.final, f.final, f.reserve).commit(); assert.strictEqual(f.calls.reserve, 0);
        const larger = { ...f.final, width: 320, height: 400 };
        f.owner.prepare(larger, f.final, f.reserve).commit(); assert.strictEqual(f.calls.reserve, 1);
        f.owner.removePage(f.page); assert.strictEqual(f.calls.cancel, 1);
    });
});
