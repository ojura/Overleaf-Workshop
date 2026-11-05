import { PDF_PREVIEW_MANIFEST_BYTES, type PdfPreviewIdentity } from '../../../../src/core/viewerProtocol';
import { createPdfRasterProjection, type PdfRasterProjection } from './pdf-raster-projection';
export type { PdfPreviewIdentity } from '../../../../src/core/viewerProtocol';

/** Trusted adapters bind an optional preview pyramid to one exact PDF representation. */
export interface PdfPreviewAsset {
    path: string;
    width: number;
    height: number;
    bytes: number;
    sha256: string;
    mime: 'image/jpeg' | 'image/png' | 'image/webp';
}
/** Image placements in the intrinsic-rotation CropBox, normalized to the page rectangle. */
export interface PdfPreviewImageRegion { id: string; x: number; y: number; width: number; height: number }
export interface PdfPreviewPage {
    pageNumber: number;
    width: number;
    height: number;
    rotation: number;
    assets: readonly PdfPreviewAsset[];
    imageRegions?: readonly PdfPreviewImageRegion[];
}
export interface PdfPreviewManifest {
    version: 1;
    document: PdfPreviewIdentity & { pageCount: number };
    pages: readonly PdfPreviewPage[];
}
export interface PdfPreviewSource {
    identity: PdfPreviewIdentity;
    loadManifest(signal: AbortSignal): Promise<unknown | null>;
    /** Adapters enforce the advertised byte bound while streaming, before returning data. */
    loadAsset(asset: PdfPreviewAsset, signal: AbortSignal): Promise<Uint8Array>;
    onChange?(listener: () => void): () => void;
}

export const PDF_PREVIEW_LIMITS = Object.freeze({
    manifestBytes: PDF_PREVIEW_MANIFEST_BYTES,
    maxPages: 10_000,
    maxAssetsPerPage: 6,
    maxAssets: 32_768,
    maxRegionsPerPage: 256,
    maxRegions: 65_536,
    assetBytes: 4 * 1024 * 1024,
    maxAssetDimension: 4096,
    maxAssetPixels: 4096 * 4096,
    maxRequests: 2,
    maxPlannedPages: 64,
});

const HASH = /^[a-f0-9]{64}$/i;
const RGBA_BYTES = 4;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum;
const integer = (value: unknown, maximum: number): value is number => positive(value, maximum) && Number.isSafeInteger(value);
const rotationOf = (value: number) => ((value % 360) + 360) % 360;

function identityOf(value: unknown): PdfPreviewIdentity {
    if (!object(value) || typeof value.key !== 'string' || !value.key.length || value.key.length > 512
        || /[\x00-\x1f\x7f]/.test(value.key) || !integer(value.size, Number.MAX_SAFE_INTEGER)
        || value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !HASH.test(value.sha256))) {
        throw new Error('Invalid preview document identity');
    }
    return Object.freeze({ key: value.key, size: value.size, ...(value.sha256 ? { sha256: value.sha256.toLowerCase() } : {}) });
}

function relativeAssetPath(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)
        && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** Bad optional placement metadata is discarded without rejecting usable page pixels. */
function imageRegions(value: unknown, remaining: number): readonly PdfPreviewImageRegion[] {
    if (!Array.isArray(value) || value.length > PDF_PREVIEW_LIMITS.maxRegionsPerPage || value.length > remaining) { return []; }
    const ids = new Set<string>();
    const regions: PdfPreviewImageRegion[] = [];
    for (const entry of value) {
        if (!object(entry) || typeof entry.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(entry.id) || ids.has(entry.id)
            || ![entry.x, entry.y, entry.width, entry.height].every(Number.isFinite)
            || entry.x < 0 || entry.y < 0 || entry.x >= 1 || entry.y >= 1 || entry.width <= 0 || entry.height <= 0
            || entry.x + entry.width > 1.000001 || entry.y + entry.height > 1.000001) { continue; }
        ids.add(entry.id);
        regions.push(Object.freeze({ id: entry.id, x: entry.x, y: entry.y,
            width: Math.min(entry.width, 1 - entry.x), height: Math.min(entry.height, 1 - entry.y) }));
    }
    return Object.freeze(regions);
}

/** Validate every binding and allocation field before a remote image is requested. */
export function validatePdfPreviewManifest(value: unknown, expected: PdfPreviewIdentity, pageCount: number): PdfPreviewManifest {
    const identity = identityOf(expected);
    if (!object(value) || value.version !== 1 || !object(value.document)) { throw new Error('Invalid preview manifest'); }
    const actual = identityOf(value.document);
    if (actual.key !== identity.key || actual.size !== identity.size || identity.sha256 && actual.sha256 !== identity.sha256
        || !integer(value.document.pageCount, PDF_PREVIEW_LIMITS.maxPages) || value.document.pageCount !== pageCount
        || !Array.isArray(value.pages) || value.pages.length > pageCount) { throw new Error('Preview document does not match'); }
    const pages: PdfPreviewPage[] = [], seen = new Set<number>(), paths = new Set<string>();
    let assets = 0, regions = 0;
    for (const page of value.pages) {
        if (!object(page) || !integer(page.pageNumber, pageCount) || seen.has(page.pageNumber)
            || !positive(page.width, 1_000_000) || !positive(page.height, 1_000_000)
            || ![0, 90, 180, 270].includes(page.rotation)
            || !Array.isArray(page.assets) || page.assets.length > PDF_PREVIEW_LIMITS.maxAssetsPerPage) {
            throw new Error('Invalid preview page');
        }
        seen.add(page.pageNumber);
        const levels: PdfPreviewAsset[] = [];
        for (const asset of page.assets) {
            if (!object(asset) || !relativeAssetPath(asset.path) || paths.has(asset.path)
                || !integer(asset.width, PDF_PREVIEW_LIMITS.maxAssetDimension)
                || !integer(asset.height, PDF_PREVIEW_LIMITS.maxAssetDimension)
                || asset.width * asset.height > PDF_PREVIEW_LIMITS.maxAssetPixels
                || !integer(asset.bytes, PDF_PREVIEW_LIMITS.assetBytes)
                || typeof asset.sha256 !== 'string' || !HASH.test(asset.sha256)
                || !['image/jpeg', 'image/png', 'image/webp'].includes(asset.mime)
                || Math.abs(asset.width * page.height - asset.height * page.width) > 2 * Math.max(page.width, page.height)
                || ++assets > PDF_PREVIEW_LIMITS.maxAssets) { throw new Error('Invalid preview asset'); }
            paths.add(asset.path);
            levels.push(Object.freeze({ path: asset.path, width: asset.width, height: asset.height, bytes: asset.bytes,
                sha256: asset.sha256.toLowerCase(), mime: asset.mime }));
        }
        levels.sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
        const placements = imageRegions(page.imageRegions, PDF_PREVIEW_LIMITS.maxRegions - regions);
        regions += placements.length;
        pages.push(Object.freeze({ pageNumber: page.pageNumber, width: page.width, height: page.height,
            rotation: page.rotation, assets: Object.freeze(levels), imageRegions: placements }));
    }
    return Object.freeze({ version: 1, document: Object.freeze({ ...actual, pageCount }), pages: Object.freeze(pages) });
}

/** Rotation is the viewer's additional rotation, beyond the manifest's intrinsic orientation. */
export function rotatePdfPreviewImageRegions(regions: readonly PdfPreviewImageRegion[] = [], rotation = 0): readonly PdfPreviewImageRegion[] {
    const angle = rotationOf(rotation);
    if (![0, 90, 180, 270].includes(angle)) { return []; }
    return regions.map(({ id, x, y, width, height }) => {
        if (angle === 90) { return { id, x: 1 - y - height, y: x, width: height, height: width }; }
        if (angle === 180) { return { id, x: 1 - x - width, y: 1 - y - height, width, height }; }
        if (angle === 270) { return { id, x: y, y: 1 - x - width, width: height, height: width }; }
        return { id, x, y, width, height };
    });
}

export interface PdfPreviewRequest { pageNumber: number; visible: boolean; maxDimension: number; rotation: number }
export interface DecodedPdfPreview { width: number; height: number; image: CanvasImageSource; close(): void }
export interface PdfPreviewSourceLoaderOptions {
    pageCount: number;
    decodeConcurrency: number;
    maxDecodePixels: number;
    /** Bound an encoded tier's long edge before fetching or decoding it. */
    maxDecodeDimension?: number;
    createCanvas(): HTMLCanvasElement;
    /** Infinity means a finished native canvas; zero means no retained pixels. */
    quality(pageNumber: number): number;
    /** Ownership of the canvas transfers on both acceptance and rejection. */
    onPreview(page: PdfPreviewPage, canvas: HTMLCanvasElement, projection: PdfRasterProjection): boolean;
    onChange(): void;
    onEvent?(type: string, data?: Record<string, number | string | boolean | null>): void;
    decode?(bytes: Uint8Array, asset: PdfPreviewAsset, signal: AbortSignal): Promise<DecodedPdfPreview>;
}

interface AssetJob {
    request: PdfPreviewRequest;
    page: PdfPreviewPage;
    asset: PdfPreviewAsset;
    abort: AbortController;
}
interface DecodeWaiter { signal: AbortSignal; resolve(release: () => void): void; reject(error: Error): void; abort(): void }

const aborted = () => new DOMException('Preview work stopped', 'AbortError');

/** Check the encoded raster size before the browser allocates a decoded bitmap. */
function encodedDimensions(bytes: Uint8Array, mime: PdfPreviewAsset['mime']): { width: number; height: number } | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (offset: number, value: string) => [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
    if (mime === 'image/png') {
        if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
            || view.getUint32(8) !== 13 || !ascii(12, 'IHDR')) { return; }
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (mime === 'image/jpeg') {
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) { return; }
        let offset = 2;
        while (offset + 3 < bytes.length) {
            if (bytes[offset++] !== 0xff) { return; }
            while (bytes[offset] === 0xff) { offset++; }
            const marker = bytes[offset++];
            if (marker === 0xda || marker === 0xd9 || marker === undefined) { return; }
            if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { continue; }
            if (offset + 2 > bytes.length) { return; }
            const length = view.getUint16(offset);
            if (length < 2 || offset + length > bytes.length) { return; }
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                if (length < 8) { return; }
                return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
            }
            offset += length;
        }
        return;
    }
    if (bytes.length < 25 || !ascii(0, 'RIFF') || !ascii(8, 'WEBP') || view.getUint32(4, true) + 8 !== bytes.length) { return; }
    if (ascii(12, 'VP8X') && bytes.length >= 30) {
        if (bytes[20] & 2) { return; } // Offline page previews are still images.
        const uint24 = (offset: number) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
        return { width: uint24(24) + 1, height: uint24(27) + 1 };
    }
    if (ascii(12, 'VP8L') && bytes[20] === 0x2f) {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (ascii(12, 'VP8 ') && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
}

async function decode(bytes: Uint8Array, asset: PdfPreviewAsset, signal: AbortSignal): Promise<DecodedPdfPreview> {
    if (signal.aborted) { throw aborted(); }
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: asset.mime }), { imageOrientation: 'none' });
    if (signal.aborted) { bitmap.close(); throw aborted(); }
    return { width: bitmap.width, height: bitmap.height, image: bitmap, close: () => bitmap.close() };
}

/**
 * Two bounded transfers cover a spread before either half is refined. Canceled transfers
 * retain their slots until they settle. There are no timers, polling loops, or DOM reads.
 */
export function createPdfPreviewSourceLoader(source: PdfPreviewSource, options: PdfPreviewSourceLoaderOptions) {
    const identity = identityOf(source.identity);
    const jobs = new Map<number, AssetJob>();
    const failed = new Set<string>();
    const declined = new Set<number>();
    const decodeWaiters: DecodeWaiter[] = [];
    let pages = new Map<number, PdfPreviewPage>();
    let requests = new Map<number, PdfPreviewRequest>();
    let enabled = false, disposed = false, dirty = true;
    let reading: AbortController | undefined;
    let manifestEpoch = 0, activeDecodes = 0;
    let planSignature = '';
    let state: 'idle' | 'loading' | 'ready' | 'missing' | 'invalid' | 'disposed' = 'idle';
    let manifestRequests = 0, assetRequests = 0, completed = 0, rejected = 0;
    const decodeLimit = Math.max(1, Math.min(PDF_PREVIEW_LIMITS.maxRequests, options.decodeConcurrency || 1));
    const pixelLimit = Math.max(1, Math.min(PDF_PREVIEW_LIMITS.maxAssetPixels, options.maxDecodePixels));
    const dimensionLimit = Math.max(1, Math.min(PDF_PREVIEW_LIMITS.maxAssetDimension,
        options.maxDecodeDimension ?? PDF_PREVIEW_LIMITS.maxAssetDimension));
    const notify = () => { if (!disposed) { options.onChange(); } };
    const event = (type: string, data?: Record<string, number | string | boolean | null>) => options.onEvent?.(type, data);

    function current(job: AssetJob): boolean {
        const request = requests.get(job.request.pageNumber);
        return !disposed && enabled && !job.abort.signal.aborted && request?.rotation === job.request.rotation
            && request?.maxDimension === job.request.maxDimension && pages.get(job.page.pageNumber) === job.page;
    }

    function releaseDecode(): void {
        activeDecodes--;
        while (decodeWaiters.length && activeDecodes < decodeLimit) {
            const waiter = decodeWaiters.shift()!;
            waiter.signal.removeEventListener('abort', waiter.abort);
            if (waiter.signal.aborted) { waiter.reject(aborted()); continue; }
            activeDecodes++;
            waiter.resolve(releaseDecode);
        }
    }

    function enterDecode(signal: AbortSignal): Promise<() => void> {
        if (signal.aborted) { return Promise.reject(aborted()); }
        if (activeDecodes < decodeLimit) { activeDecodes++; return Promise.resolve(releaseDecode); }
        return new Promise((resolve, reject) => {
            const waiter: DecodeWaiter = { signal, resolve, reject, abort() {
                const index = decodeWaiters.indexOf(waiter);
                if (index >= 0) { decodeWaiters.splice(index, 1); }
                signal.removeEventListener('abort', waiter.abort);
                reject(aborted());
            } };
            decodeWaiters.push(waiter);
            signal.addEventListener('abort', waiter.abort, { once: true });
        });
    }

    function candidates(request: PdfPreviewRequest): PdfPreviewAsset[] {
        return (pages.get(request.pageNumber)?.assets ?? []).filter(asset => asset.width * asset.height <= pixelLimit
            && Math.max(asset.width, asset.height) <= dimensionLimit
            && !failed.has(asset.path));
    }

    function choose(): { request: PdfPreviewRequest; page: PdfPreviewPage; asset: PdfPreviewAsset } | undefined {
        const entries = [...requests.values()];
        const uncovered = entries.some(request => request.visible && !declined.has(request.pageNumber)
            && options.quality(request.pageNumber) <= 0 && candidates(request).length);
        for (const phase of [0, 1, 2, 3]) {
            if (uncovered && phase > 0) { break; }
            for (const request of entries) {
                if (jobs.has(request.pageNumber) || declined.has(request.pageNumber) || request.visible !== (phase < 2)) { continue; }
                const quality = options.quality(request.pageNumber);
                if (!Number.isFinite(quality) || quality >= request.maxDimension || (phase % 2 === 0) !== (quality <= 0)) { continue; }
                const assets = candidates(request);
                if (!assets.length) { continue; }
                const asset = quality <= 0 ? assets[0]
                    : assets.find(entry => Math.max(entry.width, entry.height) >= request.maxDimension) ?? assets.at(-1)!;
                if (Math.min(request.maxDimension, Math.max(asset.width, asset.height)) <= quality) { continue; }
                return { request, page: pages.get(request.pageNumber)!, asset };
            }
        }
    }

    async function prepare(job: AssetJob): Promise<void> {
        let bitmap: DecodedPdfPreview | undefined, canvas: HTMLCanvasElement | undefined;
        try {
            assetRequests++;
            const bytes = await source.loadAsset(job.asset, job.abort.signal);
            if (!current(job)) { return; }
            if (!(bytes instanceof Uint8Array) || bytes.byteLength !== job.asset.bytes) { throw new Error('Preview byte count differs'); }
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
            if (!current(job)) { return; }
            if ([...digest].map(value => value.toString(16).padStart(2, '0')).join('') !== job.asset.sha256) { throw new Error('Preview checksum differs'); }
            const encoded = encodedDimensions(bytes, job.asset.mime);
            if (encoded?.width !== job.asset.width || encoded.height !== job.asset.height) { throw new Error('Encoded preview dimensions differ'); }
            const leave = await enterDecode(job.abort.signal);
            try {
                if (!current(job)) { return; }
                bitmap = await (options.decode ?? decode)(bytes, job.asset, job.abort.signal);
            } finally { leave(); }
            if (!current(job)) { return; }
            if (bitmap.width !== job.asset.width || bitmap.height !== job.asset.height) { throw new Error('Preview dimensions differ'); }
            const dimension = Math.min(job.request.maxDimension, Math.max(bitmap.width, bitmap.height));
            if (options.quality(job.page.pageNumber) >= dimension) { return; }
            const scale = dimension / Math.max(bitmap.width, bitmap.height);
            const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
            const angle = rotationOf(job.request.rotation);
            canvas = options.createCanvas();
            canvas.width = angle % 180 ? height : width;
            canvas.height = angle % 180 ? width : height;
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) { throw new Error('Preview canvas is unavailable'); }
            if (angle) {
                context.translate(angle === 90 || angle === 180 ? canvas.width : 0, angle === 180 || angle === 270 ? canvas.height : 0);
                context.rotate(angle * Math.PI / 180);
            }
            context.drawImage(bitmap.image, 0, 0, width, height);
            const result = canvas;
            // The atlas covers the whole page, and both pixels and logical orientation
            // have already made the requested quarter-turn in this output canvas.
            const projection = createPdfRasterProjection(result.width, result.height);
            const retained = options.onPreview(job.page, result, projection);
            canvas = undefined;
            if (retained) {
                completed++;
                event('ready', { page: job.page.pageNumber, width: result.width, height: result.height, bytes: result.width * result.height * RGBA_BYTES });
            } else { declined.add(job.page.pageNumber); event('declined', { page: job.page.pageNumber }); }
        } catch {
            if (current(job)) { failed.add(job.asset.path); rejected++; event('asset-error', { page: job.page.pageNumber }); }
        } finally {
            try { bitmap?.close(); } catch { /* Retiring work must still release its request slot. */ }
            if (canvas) { canvas.remove(); canvas.width = canvas.height = 0; }
            if (jobs.get(job.request.pageNumber) === job) { jobs.delete(job.request.pageNumber); }
            if (!disposed) { notify(); pump(); }
        }
    }

    function pump(): void {
        if (disposed || !enabled || reading) { return; }
        if (dirty) { void readManifest(); return; }
        if (state !== 'ready') { return; }
        for (;;) {
            if (jobs.size >= PDF_PREVIEW_LIMITS.maxRequests) { return; }
            const candidate = choose();
            if (!candidate) { return; }
            const job = { ...candidate, abort: new AbortController() };
            jobs.set(job.request.pageNumber, job);
            void prepare(job);
        }
    }

    async function readManifest(): Promise<void> {
        const controller = new AbortController(), epoch = ++manifestEpoch;
        reading = controller;
        dirty = false;
        state = 'loading';
        manifestRequests++;
        notify();
        try {
            const value = await source.loadManifest(controller.signal);
            if (disposed || controller.signal.aborted || epoch !== manifestEpoch) { return; }
            if (value === null) {
                for (const job of jobs.values()) { job.abort.abort(); }
                pages.clear(); state = 'missing'; event('unavailable'); return;
            }
            const manifest = validatePdfPreviewManifest(value, identity, options.pageCount);
            for (const job of jobs.values()) { job.abort.abort(); }
            pages = new Map(manifest.pages.map(page => [page.pageNumber, page]));
            failed.clear(); declined.clear();
            state = 'ready';
            event('manifest', { pages: pages.size });
        } catch {
            if (!disposed && !controller.signal.aborted && epoch === manifestEpoch) {
                for (const job of jobs.values()) { job.abort.abort(); }
                pages.clear(); state = 'invalid'; event('invalid');
            }
        } finally {
            if (reading === controller) { reading = undefined; }
            if (!disposed) { notify(); pump(); }
        }
    }

    const unsubscribe = source.onChange?.(() => {
        if (disposed) { return; }
        dirty = true;
        pump();
    });

    return {
        page(pageNumber: number): PdfPreviewPage | undefined { return pages.get(pageNumber); },
        isPending(pageNumber: number): boolean { return jobs.has(pageNumber); },
        update(next: readonly PdfPreviewRequest[], active = true): void {
            if (disposed) { return; }
            enabled = active;
            requests = new Map(next.slice(0, PDF_PREVIEW_LIMITS.maxPlannedPages)
                .filter(request => integer(request.pageNumber, options.pageCount) && positive(request.maxDimension, PDF_PREVIEW_LIMITS.maxAssetDimension)
                    && [0, 90, 180, 270].includes(rotationOf(request.rotation)))
                .map(request => [request.pageNumber, { ...request, rotation: rotationOf(request.rotation) }]));
            const signature = [...requests.values()].map(request => [request.pageNumber, request.visible, request.maxDimension, request.rotation].join(':')).join(',');
            if (signature !== planSignature) { declined.clear(); planSignature = signature; }
            for (const job of jobs.values()) { if (!current(job)) { job.abort.abort(); } }
            if (!enabled && reading) { dirty = true; reading.abort(); }
            pump();
        },
        snapshot() {
            return { state, pages: pages.size, pending: jobs.size, decoding: activeDecodes, queuedDecodes: decodeWaiters.length,
                manifestRequests, assetRequests, completed, rejected };
        },
        dispose(): void {
            if (disposed) { return; }
            disposed = true; enabled = false; state = 'disposed'; manifestEpoch++;
            reading?.abort(); unsubscribe?.();
            for (const job of jobs.values()) { job.abort.abort(); }
            requests.clear(); pages.clear(); failed.clear(); declined.clear();
        },
    };
}
