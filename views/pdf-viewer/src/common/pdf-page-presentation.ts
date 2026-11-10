import type { PdfRasterProjection } from './pdf-raster-projection';

/** One native object instance; repeated uses of one source image retain separate objects. */
export interface PdfImageResourceCoverage {
    objectId: string;
    imageId: string;
    covered: boolean;
    final: boolean;
    failed: boolean;
}

export type PdfPageCoverage =
    | { kind: 'native'; intent: object; discovered: boolean; resources: readonly PdfImageResourceCoverage[]; untrackedImageOperations?: boolean }
    | { kind: 'complete-page' }
    | { kind: 'unknown' };

/** Evidence travels with the successful raster, never with a mutable page proxy. */
export interface PdfPagePresentationCandidate {
    document: object;
    page: object;
    pageNumber: number;
    appearance: string;
    rasterGeometry?: string;
    attempt: object;
    successful: boolean;
    canvas: HTMLCanvasElement;
    projection: PdfRasterProjection;
    revision: number;
    coverage: PdfPageCoverage;
}

function complete(coverage: PdfPageCoverage): boolean {
    return coverage.kind === 'complete-page' || coverage.kind === 'native' && coverage.discovered
        && coverage.resources.every(resource => resource.covered);
}

/** Source image readiness requires every native instance, including repeated aliases. */
export function pdfImageResourceReady(coverage: PdfPageCoverage, imageId: string): boolean {
    if (coverage.kind === 'complete-page') { return true; }
    if (coverage.kind !== 'native' || !coverage.discovered) { return false; }
    const resources = coverage.resources.filter(resource => resource.imageId === imageId);
    return resources.length > 0 && resources.every(resource => resource.covered);
}

/** One synchronous publication owner for a source page's displayed raster. */
export class PdfPagePresentation {
    private displayed?: PdfPagePresentationCandidate;

    current(): PdfPagePresentationCandidate | undefined { return this.displayed; }

    accepts(candidate: PdfPagePresentationCandidate): boolean {
        if (!candidate.successful) { return false; }
        const prior = this.displayed;
        if (!prior) { return true; }
        if (prior.document !== candidate.document || prior.page !== candidate.page) { return false; }
        if (prior.appearance !== candidate.appearance) { return complete(candidate.coverage); }
        if (complete(candidate.coverage)) { return true; }
        const before = prior.coverage, after = candidate.coverage;
        if (before.kind !== 'native' || after.kind !== 'native' || !before.discovered || !after.discovered) { return false; }
        const covered = before.resources.filter(resource => resource.covered);
        if (covered.length === 0) { return true; }
        if (before.intent !== after.intent || prior.rasterGeometry !== candidate.rasterGeometry || candidate.revision < prior.revision) { return false; }
        const next = new Set(after.resources.filter(resource => resource.covered).map(resource => resource.objectId));
        return covered.every(resource => next.has(resource.objectId));
    }

    present(candidate: PdfPagePresentationCandidate, commitRaster: () => void): boolean {
        if (!this.accepts(candidate)) { return false; }
        commitRaster();
        this.displayed = candidate;
        return true;
    }

    reset(): void { this.displayed = undefined; }
}
