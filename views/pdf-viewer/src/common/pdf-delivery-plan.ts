import type { PdfPageProjection } from './pdf-raster-projection';
import type { PdfPreviewImageRegion } from './pdf-preview-source';
import type { PdfCropQuality } from './pdf-quality-reactions';

/** Current DOM facts accompany source-page candidate identities at publication. */
export interface PdfDeliveryEncounter {
    pageElement: HTMLElement;
    moving: boolean;
    axis: 'x' | 'y';
    pageProjection?: PdfPageProjection;
    imageRegions?: readonly PdfPreviewImageRegion[];
    imageRegionsComplete?: boolean;
}

import type { PdfPageCoverage, PdfPagePresentationCandidate } from './pdf-page-presentation';
import type { RobotDocumentRect, RobotImageCrop } from './robot-document-policy';

export type PdfDeliveryCropState = 'queued' | 'active' | 'delivered' | 'skipped' | 'cancelled';
export interface PdfDeliveryPlannedCrop {
    readonly id: number;
    readonly geometry: RobotImageCrop;
    state: PdfDeliveryCropState;
    protected: boolean;
    payloadId?: number;
}
interface PagePlan {
    id: number;
    document: object;
    page: object;
    pageNumber: number;
    appearance: string;
    crops: PdfDeliveryPlannedCrop[];
    encounter?: PdfDeliveryEncounter;
    coverage?: PdfPageCoverage;
    regions?: readonly PdfPreviewImageRegion[];
    regionsComplete: boolean;
    encountered: boolean;
    exposed: boolean;
    committed: boolean;
}
export interface PdfDeliveryPlanAdapter {
    select(candidate: PdfPagePresentationCandidate, encounter: PdfDeliveryEncounter): readonly RobotImageCrop[];
    protect(planId: number, crop: PdfDeliveryPlannedCrop, encounter: PdfDeliveryEncounter): void;
    rebind(planId: number, crop: PdfDeliveryPlannedCrop, encounter: PdfDeliveryEncounter): boolean | void;
    release(planId: number, crop: PdfDeliveryPlannedCrop): void;
    eligible(crop: RobotDocumentRect, encounter: PdfDeliveryEncounter): 'ready' | 'waiting' | 'skip';
    admit(planId: number, crop: PdfDeliveryPlannedCrop, candidate: PdfPagePresentationCandidate,
        encounter: PdfDeliveryEncounter): number | undefined;
    cancel(payloadId: number): void;
}
const intersects = (a: RobotDocumentRect, b: RobotDocumentRect) => a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;

function cropResources(coverage: Extract<PdfPageCoverage, { kind: 'native' }>, crop: RobotDocumentRect,
    regions: readonly PdfPreviewImageRegion[] | undefined, regionsComplete: boolean) {
    const relevant = regions?.filter(region => intersects(region, crop));
    const mapped = !!(regionsComplete && coverage.discovered && relevant?.length
        && relevant.every(region => region.resourceId && coverage.resources.some(resource => resource.imageId === region.resourceId)));
    const resources = mapped ? coverage.resources.filter(resource => relevant!.some(region => region.resourceId === resource.imageId))
        : coverage.resources;
    return { mapped, resources };
}

export type PdfDeliveryCropQuality = PdfCropQuality;

/** Quality belongs to the successful raster and every source instance intersecting its crop. */
export function pdfDeliveryCropQuality(candidate: PdfPagePresentationCandidate, crop: RobotDocumentRect,
    encounter: Pick<PdfDeliveryEncounter, 'imageRegions' | 'imageRegionsComplete'>): PdfDeliveryCropQuality {
    if (!candidate.successful || !(candidate.canvas.width > 0 && candidate.canvas.height > 0)
        || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) { return 'unknown'; }
    const coverage = candidate.coverage;
    if (coverage.kind === 'complete-page') { return 'partial'; }
    if (coverage.kind !== 'native' || !coverage.discovered) { return 'unknown'; }
    const { mapped, resources } = cropResources(coverage, crop, encounter.imageRegions, encounter.imageRegionsComplete === true);
    if (!resources.length || resources.some(resource => resource.failed) || !mapped && coverage.untrackedImageOperations !== false) { return 'unknown'; }
    if (resources.every(resource => resource.covered && resource.final)) { return 'final'; }
    return resources.some(resource => resource.covered) ? 'partial' : 'unknown';
}

/** Metadata and protection only: raster references are borrowed during synchronous admission. */
export class PdfDeliveryPlans {
    private readonly pages = new Map<object, PagePlan>();
    private serial = 0;
    constructor(private readonly adapter: PdfDeliveryPlanAdapter) {}

    private resolve(plan: PagePlan, crop: PdfDeliveryPlannedCrop, state: PdfDeliveryCropState): void {
        if (crop.state !== 'queued' && crop.state !== 'active') { return; }
        const payload = crop.state === 'active' ? crop.payloadId : undefined;
        crop.state = state;
        if (plan.committed) { plan.exposed = true; }
        if (crop.protected) { crop.protected = false; this.adapter.release(plan.id, crop); }
        if (payload !== undefined && state === 'cancelled') { this.adapter.cancel(payload); }
    }
    private readiness(plan: PagePlan, crop: PdfDeliveryPlannedCrop, coverage = plan.coverage): 'ready' | 'waiting' | 'failed' {
        if (!coverage) { return 'waiting'; }
        if (coverage.kind === 'complete-page' || coverage.kind === 'unknown') { return 'ready'; }
        const { mapped, resources } = cropResources(coverage, crop.geometry, plan.regions, plan.regionsComplete);
        // Unknown or unsupported occurrence linkage requires a complete successful native inventory.
        // Empty tracked resources alone cannot establish that an unmapped page has no photographs.
        if (!mapped && !coverage.discovered) { return 'waiting'; }
        if (resources.some(resource => resource.failed && !resource.covered)) { return 'failed'; }
        if (resources.every(resource => resource.covered && (mapped || resource.final))) { return 'ready'; }
        return 'waiting';
    }
    preparePublication(candidate: PdfPagePresentationCandidate, encounter: PdfDeliveryEncounter) {
        let plan = this.pages.get(candidate.page);
        if (plan && plan.document === candidate.document && plan.appearance !== candidate.appearance) {
            const owned = plan;
            let finished = false;
            return {
                commit: () => {
                    if (finished) { return; } finished = true;
                    if (this.pages.get(candidate.page) !== owned) { return; }
                    for (const crop of owned.crops) { this.resolve(owned, crop, 'cancelled'); }
                    owned.appearance = candidate.appearance;
                    owned.exposed = true;
                    owned.encounter = undefined;
                },
                abort: () => { finished = true; },
            };
        }
        const previous = plan && plan.document !== candidate.document ? plan : undefined;
        if (previous) { plan = undefined; }
        const provedTextOnly = candidate.successful && candidate.coverage.kind === 'native' && candidate.coverage.discovered
            && candidate.coverage.untrackedImageOperations === false && candidate.coverage.resources.every(resource => !resource.covered);
        if (!plan && provedTextOnly) { return { commit() {}, abort() {} }; }
        const knownEmpty = encounter.imageRegionsComplete === true && encounter.imageRegions?.length === 0
            && candidate.coverage.kind === 'native' && candidate.coverage.discovered && candidate.coverage.resources.length === 0;
        if (!plan && knownEmpty) { return { commit() {}, abort() {} }; }
        const created = !plan;
        if (!plan) {
            plan = { id: ++this.serial, document: candidate.document, page: candidate.page, pageNumber: candidate.pageNumber,
                appearance: candidate.appearance, crops: [], encounter, encountered: false, exposed: false, committed: false,
                regions: encounter.imageRegions?.map(region => Object.freeze({ ...region })),
                regionsComplete: encounter.imageRegionsComplete === true };
            this.pages.set(candidate.page, plan);
            try {
                plan.crops = this.adapter.select(candidate, encounter).map((geometry, id) => ({ id,
                    geometry: Object.freeze({ ...geometry, imageIds: Object.freeze([...geometry.imageIds]) }),
                    state: 'queued', protected: false }));
                for (const crop of plan.crops) {
                    this.adapter.protect(plan.id, crop, encounter);
                    crop.protected = true;
                }
            } catch (error) {
                for (const crop of plan.crops) { this.resolve(plan, crop, 'cancelled'); }
                if (previous) { this.pages.set(candidate.page, previous); }
                else { this.pages.delete(candidate.page); }
                throw error;
            }
        }
        const owned = plan;
        const previousEncounter = owned.encounter;
        if (!created) {
            for (const crop of owned.crops) {
                if (crop.protected && this.adapter.rebind(owned.id, crop, encounter) === false) { this.resolve(owned, crop, 'cancelled'); }
            }
        }
        let finished = false;
        return {
            commit: () => {
                if (finished) { return; } finished = true;
                if (this.pages.get(candidate.page) !== owned) { return; }
                if (previous) { for (const crop of previous.crops) { this.resolve(previous, crop, 'cancelled'); } }
                owned.committed = true;
                owned.coverage = candidate.coverage;
                owned.encounter = encounter;
                if (!owned.crops.length) { owned.exposed = true; }
                this.reconcileEncounter(candidate.page, encounter, candidate);
            },
            abort: () => {
                if (finished) { return; } finished = true;
                if (created && this.pages.get(candidate.page) === owned) {
                    for (const crop of owned.crops) { this.resolve(owned, crop, 'cancelled'); }
                    if (previous) { this.pages.set(candidate.page, previous); }
                    else { this.pages.delete(candidate.page); }
                } else if (!created && previousEncounter) {
                    for (const crop of owned.crops) {
                        if (crop.protected) { this.adapter.rebind(owned.id, crop, previousEncounter); }
                    }
                }
            },
        };
    }
    reconcileEncounter(page: object, encounter: PdfDeliveryEncounter, raster?: PdfPagePresentationCandidate): void {
        const plan = this.pages.get(page);
        if (!plan?.committed) { return; }
        plan.encounter = encounter;
        for (const crop of plan.crops) {
            if (crop.protected && this.adapter.rebind(plan.id, crop, encounter) === false) {
                this.resolve(plan, crop, 'cancelled');
            }
            if (crop.state !== 'queued') { continue; }
            const eligible = this.adapter.eligible(crop.geometry, encounter);
            if (eligible === 'waiting') { continue; }
            plan.encountered = true;
            const ready = this.readiness(plan, crop, raster?.coverage);
            if (ready === 'failed' || eligible === 'skip') { this.resolve(plan, crop, 'skipped'); continue; }
            if (ready !== 'ready' || !raster || raster.page !== page || raster.document !== plan.document
                || raster.appearance !== plan.appearance || !raster.successful) { continue; }
            let payload: number | undefined;
            try { payload = this.adapter.admit(plan.id, crop, raster, encounter); } catch { /* Admission failure reveals the successful raster. */ }
            if (payload === undefined) { this.resolve(plan, crop, 'skipped'); }
            else { crop.state = 'active'; crop.payloadId = payload; }
        }
    }
    updateSource(page: object, coverage: PdfPageCoverage): void {
        const plan = this.pages.get(page);
        if (!plan) { return; }
        if (plan.coverage?.kind === 'native' && coverage.kind === 'native' && plan.coverage.intent !== coverage.intent) { return; }
        for (const crop of plan.crops) {
            // Source outcomes may terminate impossible waiting work, but availability
            // never upgrades the pixels recorded by the last successful raster.
            if (crop.state === 'queued' && this.readiness(plan, crop) !== 'ready'
                && this.readiness(plan, crop, coverage) === 'failed') { this.resolve(plan, crop, 'skipped'); }
        }
    }
    finishCrop(planId: number, cropId: number, payloadId: number, outcome: 'delivered' | 'cancelled'): void {
        const plan = [...this.pages.values()].find(value => value.id === planId);
        const crop = plan?.crops.find(value => value.id === cropId);
        if (plan && crop?.state === 'active' && crop.payloadId === payloadId) { this.resolve(plan, crop, outcome); }
    }
    removePage(page: object, reason: string, detached = false): void {
        const plan = this.pages.get(page);
        if (!plan) { return; }
        // A committed bounded selection can leave other occurrences uncovered.
        // Retain that source-page history rather than infer whole-page protection.
        const discard = reason === 'eviction' && detached && !plan.committed && !plan.encountered && !plan.exposed
            && plan.crops.every(crop => crop.state === 'queued');
        for (const crop of plan.crops) { this.resolve(plan, crop, 'cancelled'); }
        if (discard) { this.pages.delete(page); }
        else { plan.exposed = true; plan.encounter = undefined; }
    }
    cancelAll(): void {
        for (const page of this.pages.keys()) { this.removePage(page, 'cancelled'); }
    }
    resetDocument(): void {
        for (const page of this.pages.keys()) { this.removePage(page, 'document'); }
        this.pages.clear();
    }
    snapshot() {
        return [...this.pages.values()].map(plan => ({ id: plan.id, pageNumber: plan.pageNumber,
            exposed: plan.exposed, encountered: plan.encountered, committed: plan.committed,
            crops: plan.crops.map(crop => ({ ...crop, geometry: { ...crop.geometry } })) }));
    }
}
