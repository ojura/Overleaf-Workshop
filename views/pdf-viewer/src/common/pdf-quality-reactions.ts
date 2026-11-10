/** Final quality belongs to a successful crop raster, independently of its delivery. */
export type PdfCropQuality = 'unknown' | 'partial' | 'final';
export interface PdfQualityOpportunity {
    page: object;
    pageNumber: number;
    key: string;
    imageId?: string;
    imageIds: readonly string[];
    quality: PdfCropQuality;
    width: number;
    height: number;
}
export interface PdfQualityEffect {
    commit(): void;
    abort(): void;
    cancel(): void;
}
interface RecordState {
    quality: PdfCropQuality;
    width: number;
    height: number;
    pending: boolean;
}
export interface PdfQualityDecision {
    pageNumber: number;
    imageId?: string;
    reason: string;
    key: string;
    width: number;
    height: number;
}
/** A publication abort leaves both the prior quality and its opportunity unchanged. */
export class PdfQualityReactions {
    private pages = new Map<object, Map<string, RecordState>>();
    private provisional = new Set<{ page: object; abort(): void }>();
    private generation = 0;
    private pageGenerations = new Map<object, number>();
    private effects = new Map<number, { page: object; effect: PdfQualityEffect }>();
    private serial = 0;
    private provisionalPending = 0;
    private prepared = 0;
    private completed = 0;
    private cancelled = 0;
    private skipped = 0;
    private lastDecision?: PdfQualityDecision;
    private decisions: PdfQualityDecision[] = [];

    private recordDecision(next: PdfQualityOpportunity, reason: string): void {
        this.lastDecision = { pageNumber: next.pageNumber, imageId: next.imageId, key: next.key, width: next.width, height: next.height, reason };
        this.decisions.push(this.lastDecision);
        if (this.decisions.length > 32) { this.decisions.shift(); }
    }

    prepare(next: PdfQualityOpportunity, previous: PdfQualityOpportunity | undefined,
        reserve: (id: number) => { effect?: PdfQualityEffect; reason?: string }) {
        if (previous && (previous.page !== next.page || previous.pageNumber !== next.pageNumber || previous.key !== next.key
            || previous.imageId !== next.imageId || JSON.stringify(previous.imageIds) !== JSON.stringify(next.imageIds))) {
            throw new Error('Previous quality belongs to another source crop');
        }
        const generation = this.generation, pageGeneration = this.pageGenerations.get(next.page) ?? 0;
        const states = this.pages.get(next.page), saved = states?.get(next.key);
        const before = previous ?? (saved && { ...next, ...saved });
        const improves = next.quality === 'final' && !!before && (before.quality === 'partial'
            || before.quality === 'final' && next.width >= before.width && next.height >= before.height
                && (next.width > before.width || next.height > before.height));
        const repeated = saved?.quality === 'final' && next.quality === 'final'
            && next.width <= saved.width && next.height <= saved.height;
        const id = improves && !repeated ? ++this.serial : undefined;
        const pendingReservation = next.quality === 'partial' && !saved?.pending;
        if (pendingReservation) { this.provisionalPending++; }
        let reservation: ReturnType<typeof reserve> | undefined, finished = false;
        const owner = { page: next.page, abort: () => {
            if (finished) { return; } finished = true; this.provisional.delete(owner);
            if (pendingReservation) { this.provisionalPending--; }
            reservation?.effect?.abort();
        } };
        this.provisional.add(owner);
        if (id !== undefined) {
            try { reservation = reserve(id); }
            catch { reservation = { reason: 'allocation-failed' }; }
            // An allocator can synchronously trigger source disposal.
            if (finished) { reservation?.effect?.abort(); }
        }
        return {
            abort: owner.abort,
            commit: () => {
                if (finished) { return; }
                if (generation !== this.generation || pageGeneration !== (this.pageGenerations.get(next.page) ?? 0)) {
                    owner.abort(); return;
                }
                finished = true; this.provisional.delete(owner);
                if (pendingReservation) { this.provisionalPending--; }
                let entries = this.pages.get(next.page);
                if (!entries) { this.pages.set(next.page, entries = new Map()); }
                entries.set(next.key, { quality: next.quality, width: next.width, height: next.height,
                    pending: next.quality === 'partial' });
                if (id === undefined) { return; }
                if (!reservation?.effect) {
                    this.skipped++;
                    this.recordDecision(next, reservation?.reason ?? 'unavailable');
                    return;
                }
                this.effects.set(id, { page: next.page, effect: reservation.effect });
                try {
                    reservation.effect.commit(); this.prepared++;
                    this.recordDecision(next, 'admitted');
                } catch {
                    this.effects.delete(id); reservation.effect.cancel(); this.skipped++;
                    this.recordDecision(next, 'commit-failed');
                }
            },
        };
    }

    observe(next: PdfQualityOpportunity): void {
        let states = this.pages.get(next.page);
        if (states?.has(next.key)) { return; }
        if (!states) { this.pages.set(next.page, states = new Map()); }
        // Reading a displayed raster cannot reopen a source failure settled after its publication.
        states.set(next.key, { quality: next.quality, width: next.width, height: next.height, pending: next.quality === 'partial' });
    }

    finish(id: number, completed = true): void {
        if (!this.effects.delete(id)) { return; }
        if (completed) { this.completed++; } else { this.cancelled++; }
    }

    removePage(page: object): void {
        this.pageGenerations.set(page, (this.pageGenerations.get(page) ?? 0) + 1);
        for (const owner of [...this.provisional]) if (owner.page === page) { owner.abort(); }
        this.pages.delete(page);
        for (const [id, value] of this.effects) {
            if (value.page !== page) { continue; }
            this.effects.delete(id); this.cancelled++; value.effect.cancel();
        }
    }

    failPage(page: object): void {
        this.pageGenerations.set(page, (this.pageGenerations.get(page) ?? 0) + 1);
        for (const owner of [...this.provisional]) if (owner.page === page) { owner.abort(); }
        const states = this.pages.get(page);
        for (const state of states?.values() ?? []) { state.pending = false; }
    }

    reset(): void {
        this.generation++;
        for (const owner of [...this.provisional]) { owner.abort(); }
        this.pageGenerations.clear();
        for (const value of this.effects.values()) { value.effect.cancel(); }
        this.effects.clear(); this.pages.clear(); this.lastDecision = undefined; this.decisions.length = 0;
        this.prepared = this.completed = this.cancelled = this.skipped = 0;
    }

    get pending(): number {
        let count = this.provisionalPending;
        for (const states of this.pages.values()) for (const value of states.values()) if (value.pending) { count++; }
        return count;
    }

    snapshot() { return { pending: this.pending, active: this.effects.size, prepared: this.prepared,
        completed: this.completed, cancelled: this.cancelled, skipped: this.skipped, lastDecision: this.lastDecision, history: [...this.decisions] }; }
}
