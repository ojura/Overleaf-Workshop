import type { PdfReadingDescriptor } from './viewerProtocol';
import { version, limits, syntax } from './pdfReadingFormat.json';

/** Metadata limits for an immutable reading publication. Decode admission has its own device budget. */
export const PDF_READING_LIMITS = Object.freeze(limits);
export const PDF_READING_VERSION = version;
export const PDF_READING_DIGEST = new RegExp(syntax.sha256);

export interface PdfReadingAsset {
    path: string;
    sha256: string;
    bytes: number;
}

export interface PdfReadingChunk {
    offset: number;
    bytes: number;
    sha256: string;
    scan: number;
}

export interface PdfReadingImage extends PdfReadingAsset {
    id: string;
    originalSha256: string;
    width: number;
    height: number;
    components?: number;
    encoding: 'progressive-jpeg' | 'original';
    coefficientBytes?: number;
    chunks?: readonly PdfReadingChunk[];
    fallbackReason?: string;
}

export interface PdfReadingManifest {
    version: number;
    source: { sha256: string; size: number; pageCount: number };
    pdf: PdfReadingAsset;
    images: readonly PdfReadingImage[];
}

/** One contiguous selection from an already validated image partition. No caller
 * supplies byte offsets, paths or digests; original encodings have one whole asset. */
export function pdfReadingImageRange(image: PdfReadingImage, chunkIndex: number, chunkCount = 1):
    { offset: number; bytes: number; chunks: readonly PdfReadingChunk[] } | undefined {
    const available = image.chunks?.length ?? 1;
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !Number.isSafeInteger(chunkCount)
        || chunkCount < 1 || chunkCount > available || chunkIndex > available - chunkCount) { return; }
    const chunks = image.chunks?.slice(chunkIndex, chunkIndex + chunkCount)
        ?? [{ offset: 0, bytes: image.bytes, sha256: image.sha256, scan: 0 }];
    const first = chunks[0], last = chunks[chunks.length - 1];
    return { offset: first.offset, bytes: last.offset + last.bytes - first.offset, chunks };
}

const digest = PDF_READING_DIGEST;
const isDigest = (value: unknown): value is string => typeof value === 'string' && digest.test(value);
const imageId = new RegExp(syntax.imageId), pathSegment = new RegExp(syntax.pathSegment);
const integer = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Paths stay below the selected manifest directory, without URL decoding or query semantics. */
export function isPdfReadingPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= limits.pathLength
        && value.split('/').every(part => pathSegment.test(part) && part !== '.' && part !== '..');
}

function asset(value: any, maxBytes: number): PdfReadingAsset | undefined {
    if (!value || !isPdfReadingPath(value.path) || !isDigest(value.sha256)
        || !integer(value.bytes, 1, maxBytes)) { return; }
    return { path: value.path, sha256: value.sha256, bytes: value.bytes };
}

/** Copy only authorized fields; source identity is supplied by the original PDF owner. */
export function validatePdfReadingManifest(value: unknown, identity: PdfReadingDescriptor['identity']): PdfReadingManifest | undefined {
    const input = value as any, source = input?.source;
    if (input?.version !== version || !source || !isDigest(source.sha256)
        || source.sha256 !== identity.sha256 || source.size !== identity.size
        || !integer(source.size, 1, PDF_READING_LIMITS.sourceBytes)
        || !integer(source.pageCount, 1, PDF_READING_LIMITS.pages)
        || !Array.isArray(input.images) || input.images.length > PDF_READING_LIMITS.images) { return; }
    const pdf = asset(input.pdf, PDF_READING_LIMITS.pdfBytes);
    if (!pdf) { return; }
    const images: PdfReadingImage[] = [], ids = new Set<string>(), paths = new Map<string, string>(), directories = new Set<string>();
    const register = (name: string, transport: string) => {
        if (directories.has(name)) { return false; }
        const parts = name.split('/'), parents: string[] = [];
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/');
            if (paths.has(parent)) { return false; }
            parents.push(parent);
        }
        const previous = paths.get(name);
        if (previous !== undefined && previous !== transport) { return false; }
        paths.set(name, transport);
        parents.forEach(parent => directories.add(parent));
        return true;
    };
    register(pdf.path, JSON.stringify([pdf.sha256, pdf.bytes, 'pdf']));
    for (const item of input.images) {
        const encoded = asset(item, PDF_READING_LIMITS.assetBytes);
        if (!encoded || typeof item.id !== 'string' || !imageId.test(item.id)
            || ids.has(item.id) || !isDigest(item.originalSha256)
            || !integer(item.width, 1, PDF_READING_LIMITS.dimension) || !integer(item.height, 1, PDF_READING_LIMITS.dimension)
            || item.width * item.height > PDF_READING_LIMITS.pixels
            || item.components !== undefined && !integer(item.components, 1, limits.components)
            || item.encoding !== 'original' && item.encoding !== 'progressive-jpeg') { return; }
        if (encoded.path === pdf.path) { return; }
        const image: PdfReadingImage = { ...encoded, id: item.id, originalSha256: item.originalSha256,
            width: item.width, height: item.height, encoding: item.encoding };
        if (item.components !== undefined) { image.components = item.components; }
        if (item.fallbackReason !== undefined) {
            if (typeof item.fallbackReason !== 'string' || item.fallbackReason.length > limits.fallbackReasonLength) { return; }
            image.fallbackReason = item.fallbackReason;
        }
        if (item.encoding === 'progressive-jpeg') {
            if (item.components !== limits.progressiveComponents || item.width * item.height > PDF_READING_LIMITS.progressivePixels
                || !integer(item.coefficientBytes, 1, PDF_READING_LIMITS.coefficientBytes)
                || item.coefficientBytes % limits.coefficientElementBytes !== 0 || !Array.isArray(item.chunks)
                || !item.chunks.length || item.chunks.length > PDF_READING_LIMITS.chunks) { return; }
            let offset = 0, scan = 0;
            const chunks: PdfReadingChunk[] = [];
            for (const chunk of item.chunks) {
                if (chunk?.offset !== offset || !integer(chunk.bytes, 1, encoded.bytes)
                    || !isDigest(chunk.sha256) || chunk.scan !== scan + 1) { return; }
                offset += chunk.bytes;
                if (offset > encoded.bytes) { return; }
                scan = chunk.scan;
                chunks.push({ offset: chunk.offset, bytes: chunk.bytes, sha256: chunk.sha256, scan });
            }
            if (offset !== encoded.bytes) { return; }
            image.coefficientBytes = item.coefficientBytes;
            image.chunks = chunks;
        } else if (item.chunks !== undefined || item.coefficientBytes !== undefined || item.sha256 !== item.originalSha256) { return; }
        // Shared encoded assets may have several xref identities, but one transport partition.
        if (!register(image.path, JSON.stringify([image.sha256, image.bytes, image.encoding, image.chunks ?? null]))) { return; }
        ids.add(image.id);
        images.push(image);
    }
    return { version, source: { sha256: source.sha256, size: source.size, pageCount: source.pageCount }, pdf, images };
}
