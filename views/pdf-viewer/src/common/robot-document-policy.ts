/** Presentation decisions use CSS page geometry, never a preview tier or canvas backing size. */
export interface RobotDocumentSize { width: number; height: number }
export interface RobotDocumentRect extends RobotDocumentSize { x: number; y: number }
export interface RobotImageRegion extends RobotDocumentRect { id: string }
export interface RobotImageCrop extends RobotDocumentRect {
    imageId: string;
    imageIds: readonly string[];
    kind: 'image' | 'collage' | 'portion';
    score: number;
}
export interface RobotDocumentMetrics {
    /** A modest document-size multiplier, applied before the shared screen/DPR compensation. */
    bodyScale: number;
    /** Maximum displayed cargo edge in CSS px. This is independent of DPR. */
    cargoEdge: number;
}

export const ROBOT_DOCUMENT_POLICY = Object.freeze({
    referencePageCss: Object.freeze({ width: 640, height: 900 }),
    minBodyScale: 0.8,
    maxBodyScale: 1.35,
    cargoEdgeCss: Object.freeze({ desktop: 400, compact: 256 }),
    minVisibleEdgeCss: 32,
    maxRegions: 256,
    maxCrops: 12,
    grouping: Object.freeze({
        maxMembers: 12,
        minMemberEdgeCss: 8,
        maxGapCss: 8,
        maxGapFraction: 0.06,
        maxAlignmentCss: 2,
        maxAlignmentFraction: 0.02,
        minDensity: 0.9,
    }),
});

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const validSize = (size: RobotDocumentSize) => Number.isFinite(size.width) && size.width > 0
    && Number.isFinite(size.height) && size.height > 0;

/** The geometric mean makes a quarter-turn neutral; square-root growth stays slower than page magnification. */
export function robotDocumentMetrics(size: RobotDocumentSize, kind: 'desktop' | 'compact'): RobotDocumentMetrics {
    const policy = ROBOT_DOCUMENT_POLICY, reference = policy.referencePageCss;
    const linearSize = validSize(size) ? Math.sqrt(size.width / reference.width) * Math.sqrt(size.height / reference.height) : 1;
    const bodyScale = clamp(Math.sqrt(linearSize), policy.minBodyScale, policy.maxBodyScale);
    return { bodyScale, cargoEdge: policy.cargoEdgeCss[kind] * bodyScale };
}

function intersection(a: RobotDocumentRect, b: RobotDocumentRect): RobotDocumentRect {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
        height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

/** Page-space arithmetic can differ by a few ULPs at a shared portion edge. */
const PAGE_EDGE_EPSILON = Number.EPSILON * 8;

/**
 * A payload claims its exact logical region before allocating pixels or a crew.
 * Claims come from admitted payloads, not raster rounding or padded arrival covers.
 * The returned semantic unit is unchanged; failed construction owns no region.
 */
export function planRobotDocumentRegion<T extends RobotDocumentRect>(candidate: T,
    admitted: readonly RobotDocumentRect[]): T | undefined {
    if (!validSize(candidate) || ![candidate.x, candidate.y].every(Number.isFinite)
        || candidate.x < -PAGE_EDGE_EPSILON || candidate.y < -PAGE_EDGE_EPSILON
        || candidate.x + candidate.width > 1 + PAGE_EDGE_EPSILON
        || candidate.y + candidate.height > 1 + PAGE_EDGE_EPSILON) { return; }
    for (const owned of admitted) {
        const overlap = intersection(candidate, owned);
        if (overlap.width > PAGE_EDGE_EPSILON && overlap.height > PAGE_EDGE_EPSILON) { return; }
    }
    return candidate;
}

function bounds(regions: readonly RobotDocumentRect[]): RobotDocumentRect {
    const x = Math.min(...regions.map(value => value.x)), y = Math.min(...regions.map(value => value.y));
    return { x, y, width: Math.max(...regions.map(value => value.x + value.width)) - x,
        height: Math.max(...regions.map(value => value.y + value.height)) - y };
}

function contained(rect: RobotDocumentRect, clip: RobotDocumentRect): boolean {
    return rect.x >= clip.x - 1e-12 && rect.y >= clip.y - 1e-12
        && rect.x + rect.width <= clip.x + clip.width + 1e-12 && rect.y + rect.height <= clip.y + clip.height + 1e-12;
}

/**
 * Only aligned rows/columns with a narrow gutter can form a collage. The gutter is
 * at most 8 CSS px and 6% of the smaller image edge; alignment differs by at most
 * 2 CSS px and 2%. A group must be fully visible, nonoverlapping, at least 90%
 * image area, and fit one cargo envelope. Wider caption-like bands stay separate.
 */
function neighbours(a: RobotImageRegion, b: RobotImageRegion, page: RobotDocumentSize): boolean {
    const overlap = intersection(a, b);
    if (overlap.width > 1e-12 && overlap.height > 1e-12) { return false; }
    const policy = ROBOT_DOCUMENT_POLICY.grouping;
    const short = Math.min(a.width * page.width, a.height * page.height, b.width * page.width, b.height * page.height);
    const gap = Math.min(policy.maxGapCss, short * policy.maxGapFraction);
    const alignment = Math.min(policy.maxAlignmentCss, short * policy.maxAlignmentFraction);
    const row = Math.abs(a.y - b.y) * page.height <= alignment
        && Math.abs(a.y + a.height - b.y - b.height) * page.height <= alignment;
    const column = Math.abs(a.x - b.x) * page.width <= alignment
        && Math.abs(a.x + a.width - b.x - b.width) * page.width <= alignment;
    const horizontal = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
    const vertical = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
    return row && horizontal >= -1e-12 && horizontal * page.width <= gap
        || column && vertical >= -1e-12 && vertical * page.height <= gap;
}

function nearbyIndices(first: number, last: number, center: number): number[] {
    const count = Math.min(ROBOT_DOCUMENT_POLICY.maxCrops, last - first + 1);
    const values: number[] = [];
    center = clamp(center, first, last);
    for (let step = 0; values.length < count; step++) {
        if (center - step >= first) { values.push(center - step); }
        if (step && values.length < count && center + step <= last) { values.push(center + step); }
    }
    return values;
}

/**
 * Planning runs once at admission. Each resulting logical crop and identity remains
 * frozen through sharper preview/native pixels. Portions use the source placement's
 * grid, so moving the viewport cannot slide their boundaries. Only visible cells are
 * examined, with a fixed candidate bound even for an extremely magnified photograph.
 */
export function selectRobotImageCrops(regions: readonly RobotImageRegion[], page: RobotDocumentSize,
    visible: RobotDocumentRect, metrics: RobotDocumentMetrics): RobotImageCrop[] {
    if (!validSize(page) || !validSize(visible) || ![visible.x, visible.y, metrics.cargoEdge].every(Number.isFinite)
        || metrics.cargoEdge <= 0) { return []; }
    const clip = intersection(visible, { x: 0, y: 0, width: 1, height: 1 });
    if (!clip.width || !clip.height) { return []; }
    const rectangles = new Set<string>();
    const images: RobotImageRegion[] = [];
    for (const value of regions.slice(0, ROBOT_DOCUMENT_POLICY.maxRegions)) {
        if (!value.id || !validSize(value) || ![value.x, value.y].every(Number.isFinite)) { continue; }
        const rect = value.x >= 0 && value.y >= 0 && value.x + value.width <= 1 && value.y + value.height <= 1
            ? { x: value.x, y: value.y, width: value.width, height: value.height }
            : intersection(value, { x: 0, y: 0, width: 1, height: 1 });
        if (!rect.width || !rect.height) { continue; }
        const key = [rect.x, rect.y, rect.width, rect.height].join(':');
        if (rectangles.has(key)) { continue; }
        rectangles.add(key); images.push({ ...rect, id: value.id });
    }
    images.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        || a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height);
    const roots = images.map((_, index) => index);
    const root = (index: number): number => {
        while (roots[index] !== index) { roots[index] = roots[roots[index]]; index = roots[index]; }
        return index;
    };
    const eligible = images.map(image => contained(image, clip)
        && Math.min(image.width * page.width, image.height * page.height) >= ROBOT_DOCUMENT_POLICY.grouping.minMemberEdgeCss
        && Math.max(image.width * page.width, image.height * page.height) <= metrics.cargoEdge);
    for (let first = 0; first < images.length; first++) {
        if (!eligible[first]) { continue; }
        for (let next = first + 1; next < images.length; next++) {
            if (eligible[next] && neighbours(images[first], images[next], page)) { roots[root(next)] = root(first); }
        }
    }
    const groups = new Map<number, RobotImageRegion[]>();
    images.forEach((image, index) => {
        const key = root(index), group = groups.get(key) ?? [];
        group.push(image); groups.set(key, group);
    });
    const candidates: RobotImageCrop[] = [];
    const add = (rect: RobotDocumentRect, imageId: string, imageIds: readonly string[], kind: RobotImageCrop['kind']) => {
        const showing = intersection(rect, clip), minimum = ROBOT_DOCUMENT_POLICY.minVisibleEdgeCss;
        if (showing.width * page.width + 1e-9 < minimum || showing.height * page.height + 1e-9 < minimum) { return; }
        candidates.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            imageId, imageIds, kind, score: 1 + showing.width * showing.height });
    };
    for (const group of groups.values()) {
        const box = bounds(group);
        const density = group.reduce((sum, image) => sum + image.width * image.height, 0) / (box.width * box.height);
        const disjoint = group.every((a, first) => group.slice(first + 1).every(b => {
            const overlap = intersection(a, b); return overlap.width <= 1e-12 || overlap.height <= 1e-12;
        }));
        if (group.length > 1 && group.length <= ROBOT_DOCUMENT_POLICY.grouping.maxMembers && disjoint
            && contained(box, clip) && density >= ROBOT_DOCUMENT_POLICY.grouping.minDensity
            && Math.max(box.width * page.width, box.height * page.height) <= metrics.cargoEdge) {
            const members = group.map(value => value.id);
            add(box, 'collage[' + members.join('|') + ']', members, 'collage');
            continue;
        }
        for (const image of group) {
            const columns = Math.ceil(image.width * page.width / metrics.cargoEdge);
            const rows = Math.ceil(image.height * page.height / metrics.cargoEdge);
            if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || rows < 1) { continue; }
            if (columns === 1 && rows === 1) { add(image, image.id, [image.id], 'image'); continue; }
            const showing = intersection(image, clip);
            if (!showing.width || !showing.height) { continue; }
            const width = image.width / columns, height = image.height / rows;
            const firstColumn = clamp(Math.floor((showing.x - image.x) / width), 0, columns - 1);
            const lastColumn = clamp(Math.ceil((showing.x + showing.width - image.x) / width) - 1, firstColumn, columns - 1);
            const firstRow = clamp(Math.floor((showing.y - image.y) / height), 0, rows - 1);
            const lastRow = clamp(Math.ceil((showing.y + showing.height - image.y) / height) - 1, firstRow, rows - 1);
            const centerColumn = Math.floor((showing.x + showing.width / 2 - image.x) / width);
            const centerRow = Math.floor((showing.y + showing.height / 2 - image.y) / height);
            for (const row of nearbyIndices(firstRow, lastRow, centerRow)) {
                for (const column of nearbyIndices(firstColumn, lastColumn, centerColumn)) {
                    const rect = { x: image.x + column * width, y: image.y + row * height, width, height };
                    add(rect, 'portion[' + image.id + ']:' + columns + ':' + rows + ':' + column + ':' + row, [image.id], 'portion');
                }
            }
        }
    }
    const distance = (value: RobotDocumentRect) => Math.hypot(
        (value.x + value.width / 2 - clip.x - clip.width / 2) * page.width,
        (value.y + value.height / 2 - clip.y - clip.height / 2) * page.height);
    const selected: RobotImageCrop[] = [];
    // Content priority chooses the whole image/collage/portion before a route can
    // prefer a smaller overlapping lower placement. Crew choice cannot split it.
    for (const candidate of candidates.sort((a, b) => b.score - a.score || distance(a) - distance(b)
        || (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0))) {
        if (planRobotDocumentRegion(candidate, selected)) { selected.push(candidate); }
        if (selected.length >= ROBOT_DOCUMENT_POLICY.maxCrops) { break; }
    }
    return selected;
}
