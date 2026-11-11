import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
describe('PDF delivery plan ownership', function () {
    let directory: string, api: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-delivery-plan-'));
        try {
            await esbuild.build({ entryPoints: [path.resolve(__dirname, '../../views/pdf-viewer/src/common/pdf-delivery-plan.ts')],
                outfile: path.join(directory, 'plan.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
            api = await importModule(path.join(directory, 'plan.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });
    function fixture() {
        let eligible = 'waiting', payload: number | undefined = 9;
        const covers = new Set<number>(), cancelled: number[] = [], admissions: number[] = [];
        const crop = { x: .1, y: .1, width: .3, height: .3, imageId: 'p1-i0', imageIds: ['p1-i0'], kind: 'image', score: 1 };
        const plans = new api.PdfDeliveryPlans({ select: () => [crop],
            protect(_plan: number, value: any) { covers.add(value.id); }, rebind() {},
            release(_plan: number, value: any) { covers.delete(value.id); }, eligible: () => eligible,
            admit(_plan: number, value: any) { admissions.push(value.id); return payload; }, cancel(id: number) { cancelled.push(id); } });
        const candidate: any = { document: {}, page: {}, pageNumber: 1, appearance: 'plain', attempt: {}, successful: true,
            canvas: {}, projection: {}, revision: 1, coverage: { kind: 'complete-page' } };
        const encounter: any = { pageElement: {}, moving: false, axis: 'y', imageRegionsComplete: true,
            imageRegions: [{ ...crop, id: 'p1-i0', resourceId: 'x5' }] };
        return { plans, candidate, encounter, covers, cancelled, admissions,
            eligible(value: string) { eligible = value; }, payload(value: number | undefined) { payload = value; } };
    }
    it('binds final crop quality to all intersecting native aliases while unrelated images may still load', () => {
        const f = fixture(), crop = f.encounter.imageRegions[0];
        f.candidate.canvas = { width: 800, height: 1200 };
        const resources = [
            { objectId: 'a', imageId: 'x5', covered: true, final: true, failed: false },
            { objectId: 'alias', imageId: 'x5', covered: true, final: true, failed: false },
            { objectId: 'other', imageId: 'x6', covered: true, final: false, failed: false },
        ];
        f.candidate.coverage = { kind: 'native', intent: {}, discovered: true, resources, untrackedImageOperations: false };
        f.encounter.imageRegions.push({ id: 'p1-i1', resourceId: 'x6', x: .7, y: .7, width: .2, height: .2 });
        const quality = () => api.pdfDeliveryCropQuality(f.candidate, crop, f.encounter);
        assert.strictEqual(quality(), 'final', 'a different photograph cannot delay this crop completion');
        resources[1].final = false;
        assert.strictEqual(quality(), 'partial', 'repeated instances of the same resource must all be final');
        resources[1].final = true;
        Object.assign(f.encounter.imageRegions[1], { x: .2, y: .2 });
        assert.strictEqual(quality(), 'partial', 'overlapping pixels belong to the copied crop even outside its selected image IDs');
        resources[2].final = true;
        assert.strictEqual(quality(), 'final');
        resources[2].failed = true;
        assert.strictEqual(quality(), 'unknown', 'failed pixels cannot authorize a sharp-image reveal');
    });

    it('keeps complete previews and unavailable raster evidence distinct from final source quality', () => {
        const f = fixture(), crop = f.encounter.imageRegions[0];
        f.candidate.canvas = { width: 800, height: 1200 };
        const quality = () => api.pdfDeliveryCropQuality(f.candidate, crop, f.encounter);
        assert.strictEqual(quality(), 'partial', 'complete atlas coverage says every image is present, not that its source pixels are final');
        for (const coverage of [
            { kind: 'unknown' },
            { kind: 'native', intent: {}, discovered: false, resources: [] },
            { kind: 'native', intent: {}, discovered: true, resources: [], untrackedImageOperations: false },
        ]) {
            f.candidate.coverage = coverage;
            assert.strictEqual(quality(), 'unknown');
        }
        f.candidate.coverage = { kind: 'native', intent: {}, discovered: true,
            resources: [{ objectId: 'a', imageId: 'x5', covered: true, final: true, failed: false }] };
        assert.strictEqual(quality(), 'final');
        f.candidate.successful = false;
        assert.strictEqual(quality(), 'unknown');
        f.candidate.successful = true;
        f.candidate.canvas.width = 0;
        assert.strictEqual(quality(), 'unknown', 'zeroed backing has no final pixels to reveal');
    });

    it('requires every mapped crop instance to be painted before recognizing coarse quality', () => {
        const f = fixture(), crop = f.encounter.imageRegions[0];
        f.candidate.canvas = { width: 800, height: 1200 };
        const resources = [
            { objectId: 'a', imageId: 'x5', covered: true, final: false, failed: false },
            { objectId: 'alias', imageId: 'x5', covered: false, final: false, failed: false },
            { objectId: 'other', imageId: 'x6', covered: false, final: false, failed: false },
        ];
        f.candidate.coverage = { kind: 'native', intent: {}, discovered: true, resources, untrackedImageOperations: false };
        f.encounter.imageRegions.push({ id: 'p1-i1', resourceId: 'x6', x: .7, y: .7, width: .2, height: .2 });
        const quality = () => api.pdfDeliveryCropQuality(f.candidate, crop, f.encounter);
        assert.strictEqual(quality(), 'unknown', 'one painted alias cannot stand in for another missing occurrence');
        resources[1].covered = true;
        assert.strictEqual(quality(), 'partial', 'all selected occurrences now have coarse pixels');
        resources[0].final = resources[1].final = true;
        assert.strictEqual(quality(), 'final', 'an unrelated missing image does not delay this fully painted crop');
        Object.assign(f.encounter.imageRegions[1], { x: .2, y: .2 });
        assert.strictEqual(quality(), 'unknown', 'an intersecting missing image makes the copied crop incomplete');
        resources[2].covered = true;
        assert.strictEqual(quality(), 'partial');
        resources[2].final = true;
        assert.strictEqual(quality(), 'final');
    });

    for (const linkage of ['incomplete', 'unmapped']) {
        it('does not infer a coarse photograph from unrelated page pixels with ' + linkage + ' linkage', () => {
            const f = fixture(), crop = f.encounter.imageRegions[0];
            f.candidate.canvas = { width: 800, height: 1200 };
            if (linkage === 'incomplete') { f.encounter.imageRegionsComplete = false; }
            else { delete f.encounter.imageRegions[0].resourceId; }
            f.encounter.imageRegions.push({ id: 'p1-i1', resourceId: 'x6', x: .7, y: .7, width: .2, height: .2 });
            const resources = [
                { objectId: 'selected', imageId: 'x5', covered: false, final: false, failed: false },
                { objectId: 'unrelated', imageId: 'x6', covered: true, final: true, failed: false },
            ];
            f.candidate.coverage = { kind: 'native', intent: {}, discovered: true, resources, untrackedImageOperations: false };
            const quality = () => api.pdfDeliveryCropQuality(f.candidate, crop, f.encounter);
            assert.strictEqual(quality(), 'unknown', 'the selected crop can still be white while another image is painted');
            resources[0].covered = true;
            assert.strictEqual(quality(), 'partial', 'a complete coarse inventory makes the crop available');
            resources[0].final = true;
            assert.strictEqual(quality(), 'final');
            delete f.candidate.coverage.untrackedImageOperations;
            assert.strictEqual(quality(), 'unknown', 'the complete inventory proof remains required without a resource link');
        });
    }

    it('requires a complete final native inventory when crop linkage is incomplete', () => {
        const f = fixture(), crop = f.encounter.imageRegions[0];
        f.candidate.canvas = { width: 800, height: 1200 };
        f.encounter.imageRegionsComplete = false;
        const resources = [
            { objectId: 'a', imageId: 'x5', covered: true, final: true, failed: false },
            { objectId: 'b', imageId: 'x6', covered: true, final: false, failed: false },
        ];
        f.candidate.coverage = { kind: 'native', intent: {}, discovered: true, resources, untrackedImageOperations: false };
        const quality = () => api.pdfDeliveryCropQuality(f.candidate, crop, f.encounter);
        assert.strictEqual(quality(), 'partial');
        resources[1].final = true;
        assert.strictEqual(quality(), 'final');
        delete f.candidate.coverage.untrackedImageOperations;
        assert.strictEqual(quality(), 'unknown', 'an absent inventory proof cannot authorize unmapped final quality');
        f.candidate.coverage.untrackedImageOperations = true;
        assert.strictEqual(quality(), 'unknown', 'unmapped untracked imagery has no complete source-quality inventory');
        f.encounter.imageRegionsComplete = true;
        assert.strictEqual(quality(), 'final', 'complete explicit linkage can prove the selected crop independently');
    });

    it('keeps unbound proven text unplanned until metadata arrives before the first photograph', () => {
        const f = fixture();
        const text = { ...f.candidate, coverage: { kind: 'native', intent: {}, discovered: true,
            resources: [{ objectId: 'a', imageId: 'x5', covered: false, final: false, failed: false }], untrackedImageOperations: false } };
        f.plans.preparePublication(text, { ...f.encounter, imageRegions: undefined, imageRegionsComplete: false }).commit();
        assert.strictEqual(f.covers.size, 0);
        assert.strictEqual(f.plans.snapshot().length, 0);
        f.plans.preparePublication(f.candidate, f.encounter).commit();
        assert.strictEqual(f.covers.size, 1, 'metadata can protect the finite plan before photo publication');
    });

    it('records permanent exposure when unknown or photo pixels precede occurrence metadata', () => {
        for (const coverage of [{ kind: 'unknown' }, { kind: 'native', intent: {}, discovered: true,
            resources: [], untrackedImageOperations: true }]) {
            let regions = false, protections = 0;
            const plans = new api.PdfDeliveryPlans({ select: () => regions ? [{ x: 0, y: 0, width: 1, height: 1, imageIds: [] }] : [],
                protect() { protections++; }, rebind() {}, release() {}, eligible: () => 'waiting', admit() {}, cancel() {} });
            const f = fixture(), candidate = { ...f.candidate, coverage };
            plans.preparePublication(candidate, { ...f.encounter, imageRegions: undefined }).commit();
            regions = true;
            plans.preparePublication(f.candidate, f.encounter).commit();
            assert.strictEqual(protections, 0, 'late metadata cannot remask an exposed raster');
        }
    });

    it('protects prefetched pixels before publication without allocating cargo and adopts only at the first eligible encounter', () => {
        const f = fixture(); const transaction = f.plans.preparePublication(f.candidate, f.encounter);
        assert.strictEqual(f.covers.size, 1); assert.strictEqual(f.admissions.length, 0);
        transaction.commit(); assert.strictEqual(f.admissions.length, 0);
        f.eligible('ready'); f.plans.reconcileEncounter(f.candidate.page, f.encounter, f.candidate);
        assert.deepStrictEqual(f.admissions, [0]); assert.strictEqual(f.covers.size, 1);
        const plan = f.plans.snapshot()[0];
        f.plans.finishCrop(plan.id, 0, 8, 'delivered'); assert.strictEqual(f.covers.size, 1);
        f.plans.finishCrop(plan.id, 0, 9, 'delivered'); assert.strictEqual(f.covers.size, 0);
        f.plans.reconcileEncounter(f.candidate.page, f.encounter, f.candidate); assert.deepStrictEqual(f.admissions, [0]);
    });
    it('rolls back a failed publication and immediately reveals capacity failures without reviving them', () => {
        const f = fixture(); f.plans.preparePublication(f.candidate, f.encounter).abort();
        assert.strictEqual(f.covers.size, 0); assert.deepStrictEqual(f.plans.snapshot(), []);
        f.eligible('ready'); f.payload(undefined); f.plans.preparePublication(f.candidate, f.encounter).commit();
        assert.strictEqual(f.covers.size, 0); assert.strictEqual(f.plans.snapshot()[0].crops[0].state, 'skipped');
        f.payload(10); f.plans.reconcileEncounter(f.candidate.page, f.encounter, f.candidate);
        assert.strictEqual(f.admissions.length, 1);
    });
    it('requires all linked object instances and treats unknown valid resource links conservatively', () => {
        const f = fixture(); f.eligible('ready');
        f.candidate.coverage = { kind: 'native', intent: {}, discovered: true, resources: [
            { objectId: 'a', imageId: 'x5', covered: true, final: false, failed: false },
            { objectId: 'b', imageId: 'x5', covered: false, final: false, failed: false }] };
        f.plans.preparePublication(f.candidate, f.encounter).commit(); assert.strictEqual(f.admissions.length, 0);
        f.candidate.coverage.resources[1].covered = true;
        f.plans.updateSource(f.candidate.page, f.candidate.coverage);
        f.plans.reconcileEncounter(f.candidate.page, f.encounter, f.candidate); assert.strictEqual(f.admissions.length, 1);
        const g = fixture(); g.eligible('ready'); g.encounter.imageRegions[0].resourceId = 'x999'; g.candidate.coverage = f.candidate.coverage;
        g.plans.preparePublication(g.candidate, g.encounter).commit(); assert.strictEqual(g.admissions.length, 0);
        for (const resource of g.candidate.coverage.resources) { resource.final = true; }
        g.plans.updateSource(g.candidate.page, g.candidate.coverage);
        g.plans.reconcileEncounter(g.candidate.page, g.encounter, g.candidate); assert.strictEqual(g.admissions.length, 1);
    });
    it('preserves the previous appearance on aborted replacement and installs existing protection before DOM rebinding', () => {
        const f = fixture(); f.plans.preparePublication(f.candidate, f.encounter).commit();
        const original = f.plans.snapshot()[0];
        const changed = { ...f.candidate, appearance: 'changed', attempt: {} };
        f.plans.preparePublication(changed, f.encounter).abort();
        assert.strictEqual(f.plans.snapshot()[0].id, original.id);
        assert.strictEqual(f.plans.snapshot()[0].crops[0].state, 'queued');
        f.eligible('ready'); f.plans.reconcileEncounter(f.candidate.page, f.encounter, f.candidate);
        assert.strictEqual(f.admissions.length, 1);
        f.plans.removePage(f.candidate.page, 'hidden'); f.plans.removePage(f.candidate.page, 'hidden');
        assert.deepStrictEqual(f.cancelled, [9], 'active ownership resolves once across repeated cancellation');
    });

    it('keeps uncovered exposure terminal while trustworthy text-only inventory retains the first photo opportunity', () => {
        const f = fixture();
        const adapter = (f.plans as any).adapter;
        adapter.select = () => [];
        f.plans.preparePublication(f.candidate, f.encounter).commit();
        adapter.select = () => [{ x: 0, y: 0, width: 1, height: 1, imageId: 'late', imageIds: ['late'], kind: 'image', score: 1 }];
        f.plans.preparePublication(f.candidate, f.encounter).commit();
        assert.deepStrictEqual(f.plans.snapshot()[0].crops, []);
        assert.strictEqual(f.plans.snapshot()[0].exposed, true);
        const g = fixture(); g.encounter.imageRegions = [];
        g.candidate.coverage = { kind: 'native', intent: {}, discovered: true, resources: [] };
        g.plans.preparePublication(g.candidate, g.encounter).commit();
        assert.deepStrictEqual(g.plans.snapshot(), [], 'only complete trustworthy occurrence inventory grants the text-only exception');
    });

    it('never admits newer resource pixels from an older successful raster', () => {
        const f = fixture(); f.eligible('ready');
        f.candidate.coverage = { kind: 'native', intent: {}, discovered: true,
            resources: [{ objectId: 'a', imageId: 'x5', covered: false, final: false, failed: false }] };
        f.plans.preparePublication(f.candidate, f.encounter).commit();
        const newer = { ...f.candidate.coverage, resources: [{ ...f.candidate.coverage.resources[0], covered: true }] };
        f.plans.updateSource(f.candidate.page, newer);
        f.plans.reconcileEncounter(f.candidate.page, f.encounter, f.candidate);
        assert.strictEqual(f.admissions.length, 0, 'source availability cannot change evidence bound to the copied raster');
        const candidate = { ...f.candidate, coverage: newer, attempt: {} };
        f.plans.preparePublication(candidate, f.encounter).commit();
        assert.strictEqual(f.admissions.length, 1);
    });

    it('restores the prior live owner when replacement protection throws', () => {
        const f = fixture(); f.plans.preparePublication(f.candidate, f.encounter).commit();
        const original = f.plans.snapshot()[0].id;
        (f.plans as any).adapter.protect = () => { throw new Error('protection failed'); };
        assert.throws(() => f.plans.preparePublication({ ...f.candidate, document: {}, appearance: 'replacement' }, f.encounter), /protection failed/);
        assert.strictEqual(f.plans.snapshot()[0]?.id, original, 'the prior protected owner survives preparation failure');
        f.plans.cancelAll(); assert.strictEqual(f.covers.size, 0);
    });

    it('retains terminal dependency failure across detached eviction and later publication', () => {
        const f = fixture();
        f.encounter.imageRegions.push({ id: 'overlap', x: .2, y: .2, width: .2, height: .2, resourceId: 'x6' });
        f.candidate.coverage = { kind: 'native', intent: {}, discovered: true, resources: [
            { objectId: 'a', imageId: 'x5', covered: true, final: false, failed: false },
            { objectId: 'b', imageId: 'x6', covered: false, final: false, failed: false }] };
        f.plans.preparePublication(f.candidate, f.encounter).commit();
        f.plans.updateSource(f.candidate.page, { ...f.candidate.coverage, resources: [f.candidate.coverage.resources[0],
            { ...f.candidate.coverage.resources[1], failed: true }] });
        const id = f.plans.snapshot()[0].id;
        assert.strictEqual(f.plans.snapshot()[0].crops[0].state, 'skipped');
        f.plans.removePage(f.candidate.page, 'eviction', true);
        assert.strictEqual(f.plans.snapshot()[0]?.id, id, 'terminal release is outside provisional eviction');
        f.plans.preparePublication({ ...f.candidate, coverage: { kind: 'complete-page' } }, f.encounter).commit();
        assert.strictEqual(f.covers.size, 0);
    });

    it('preserves source-page terminal history across rotation while allowing a genuinely new document lifetime', () => {
        const f = fixture(); f.plans.preparePublication(f.candidate, f.encounter).commit();
        const id = f.plans.snapshot()[0].id;
        f.plans.removePage(f.candidate.page, 'appearance');
        const rotated = { ...f.candidate, appearance: 'rotation90' };
        f.plans.preparePublication(rotated, f.encounter).commit();
        assert.strictEqual(f.plans.snapshot()[0].id, id, 'rotation retains the source-page history owner');
        assert.strictEqual(f.plans.snapshot()[0].exposed, true);
        assert.strictEqual(f.plans.snapshot()[0].crops[0].state, 'cancelled');
        assert.strictEqual(f.covers.size, 0, 'rotation cannot recreate cancelled protection');
        f.plans.preparePublication({ ...rotated, document: {} }, f.encounter).commit();
        assert.notStrictEqual(f.plans.snapshot()[0].id, id);
        assert.strictEqual(f.plans.snapshot()[0].crops[0].state, 'queued');
        assert.strictEqual(f.covers.size, 1);
    });

    it('resolves impossible resources and repeated lifecycle removal once while preserving terminal history', () => {
        const f = fixture(); f.candidate.coverage = { kind: 'native', intent: {}, discovered: true,
            resources: [{ objectId: 'a', imageId: 'x5', covered: false, final: false, failed: false }] };
        f.plans.preparePublication(f.candidate, f.encounter).commit();
        f.candidate.coverage.resources[0].failed = true; f.plans.updateSource(f.candidate.page, f.candidate.coverage);
        assert.strictEqual(f.covers.size, 0); assert.strictEqual(f.plans.snapshot()[0].crops[0].state, 'skipped');
        f.plans.removePage(f.candidate.page, 'hidden'); f.plans.removePage(f.candidate.page, 'hidden');
        assert.strictEqual(f.covers.size, 0); assert.strictEqual(f.plans.snapshot().length, 1);
        f.plans.resetDocument(); assert.deepStrictEqual(f.plans.snapshot(), []);
    });
});
