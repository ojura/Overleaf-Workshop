import { PDF_READING_LIMITS, PDF_READING_DIGEST, validatePdfReadingManifest, type PdfReadingManifest, type PdfReadingImage } from '../../../../src/core/pdfReadingManifest';
import type { PdfReadingDescriptor } from './protocol';
import { pdfPerformance } from './prefetch-performance';
import { pdfCachePolicy } from './scroll-prefetch';

interface ReadingMetrics {
    beginFetch(): () => void;
    fetch(bytes: number, durationMs: number): void;
    event(type: string, data?: Record<string, number | string | boolean | null>): void;
}
interface Options {
    signal: AbortSignal;
    fetch?: typeof fetch;
    metrics?: ReadingMetrics;
    concurrency?: number;
    readImage?(request: ExternalImageRead): Promise<Response>;
}
export interface ExternalImageRead {
    id: string;
    chunkIndex: number;
    signal: AbortSignal;
}
export type ExternalImageMetadata = Omit<PdfReadingImage, 'path' | 'fallbackReason'>;
export interface PdfReadingSource {
    manifest: PdfReadingManifest;
    data: Uint8Array;
    externalImageSource: {
        images: readonly ExternalImageMetadata[];
        read(request: ExternalImageRead): Promise<Uint8Array>;
    };
    dispose(): void;
}
const abortError = () => new DOMException('PDF reading source stopped.', 'AbortError');
const digest = (bytes: Uint8Array) => crypto.subtle.digest('SHA-256', bytes)
    .then(value => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join(''));

/** Every request and byte buffer belongs to this one document, including late or cancelled reads. */
export async function openPdfReadingSource(descriptor: PdfReadingDescriptor, options: Options): Promise<PdfReadingSource | undefined> {
    const manifestUrl = new URL(descriptor.manifestUrl);
    if (!['https:', 'http:'].includes(manifestUrl.protocol) || manifestUrl.username || manifestUrl.password
        || manifestUrl.search || manifestUrl.hash || typeof descriptor.manifestRevision !== 'string'
        || !PDF_READING_DIGEST.test(descriptor.manifestRevision)) {
        throw new Error('Invalid reading manifest location or digest.');
    }
    const base = new URL('./', manifestUrl), request = options.fetch ?? globalThis.fetch.bind(globalThis);
    const metrics = options.metrics ?? pdfPerformance;
    const concurrency = options.concurrency ?? pdfCachePolicy().imageDecodeConcurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) { throw new Error('Invalid reading request concurrency.'); }
    const active = new Set<AbortController>();
    const queue: Array<{ start(): void; cancel(): void }> = [];
    let disposed = false;
    function current(signal?: AbortSignal) {
        if (disposed || options.signal.aborted || signal?.aborted) { throw abortError(); }
    }
    function pump() {
        while (!disposed && active.size < concurrency && queue.length) { queue.shift()!.start(); }
    }
    function dispose() {
        if (disposed) { return; }
        disposed = true;
        options.signal.removeEventListener('abort', dispose);
        for (const job of queue.splice(0)) { job.cancel(); }
        for (const controller of active) { controller.abort(); }
    }
    options.signal.addEventListener('abort', dispose, { once: true });
    if (options.signal.aborted) { dispose(); }

    async function receive(url: URL, signal: AbortSignal, kind: string, expected: number | undefined,
        limit: number, sha256: string, range?: { offset: number; bytes: number; total: number },
        fields: Record<string, number | string | boolean | null> = {}, provided?: () => Promise<Response>): Promise<Uint8Array | undefined> {
        current(signal);
        const finish = metrics.beginFetch(), started = performance.now();
        let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, received = 0;
        try {
            const headers: Record<string, string> = {};
            if (range) { headers.Range = 'bytes=' + range.offset + '-' + (range.offset + range.bytes - 1); }
            response = provided ? await provided() : await request(url.href, { signal, headers, credentials: 'same-origin', redirect: 'error',
                cache: kind === 'manifest' ? 'no-cache' : 'default' });
            current(signal);
            if (kind === 'manifest' && response.status === 404) {
                await response.body?.cancel();
                return;
            }
            if (range) {
                if (response.status !== 206 || response.headers.get('Content-Range')
                    !== 'bytes ' + range.offset + '-' + (range.offset + range.bytes - 1) + '/' + range.total
                    || (response.headers.get('Content-Encoding') || 'identity') !== 'identity') {
                    throw new Error('The reading image server returned a different byte range.');
                }
            } else if (response.status !== 200) { throw new Error('Reading resource returned HTTP ' + response.status + '.'); }
            if (!response.body) { throw new Error('Reading resource has no response body.'); }
            const header = response.headers.get('Content-Length');
            const decoded = (response.headers.get('Content-Encoding') || 'identity') !== 'identity';
            const declared = header !== null && !decoded ? Number(header) : undefined;
            if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > limit
                || expected !== undefined && declared !== expected)) { throw new Error('Reading resource length is outside its bound.'); }
            const capacity = expected ?? declared ?? limit;
            const bytes = new Uint8Array(capacity);
            reader = response.body.getReader();
            for (;;) {
                current(signal);
                const part = await reader.read();
                current(signal);
                if (part.done) { break; }
                const offset = received;
                received += part.value.length;
                if (received > bytes.length) { throw new Error('Reading resource exceeds its byte bound.'); }
                bytes.set(part.value, offset);
            }
            if (expected !== undefined && received !== expected || declared !== undefined && received !== declared) {
                throw new Error('Reading resource ended before its declared length.');
            }
            const result = received === bytes.length ? bytes : bytes.slice(0, received);
            if (await digest(result) !== sha256) { throw new Error('Reading resource digest does not match its publication.'); }
            current(signal);
            metrics.event('reading-transfer', { kind, bytes: received, durationMs: performance.now() - started, ...fields });
            return result;
        } catch (error) {
            try { if (reader) { await reader.cancel(); } else { await response?.body?.cancel(); } } catch { /* The signal can close it first. */ }
            metrics.event('reading-transfer-error', { kind, bytes: received, cancelled: signal.aborted || disposed, ...fields });
            throw error;
        } finally {
            reader?.releaseLock();
            if (received) { metrics.fetch(received, performance.now() - started); }
            finish();
        }
    }

    try {
        current();
        const bytes = await receive(manifestUrl, options.signal, 'manifest', undefined,
            PDF_READING_LIMITS.manifestBytes, descriptor.manifestRevision);
        if (!bytes) { dispose(); return; }
        const manifest = validatePdfReadingManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), descriptor.identity);
        if (!manifest) { throw new Error('Reading manifest does not match the original PDF or its resource bounds.'); }
        const data = await receive(new URL(manifest.pdf.path, base), options.signal, 'pdf',
            manifest.pdf.bytes, PDF_READING_LIMITS.pdfBytes, manifest.pdf.sha256);
        current();
        if (!data) { throw new Error('Reading PDF is unavailable.'); }
        const images = new Map(manifest.images.map(image => [image.id, image]));
        const metadata = manifest.images.map(image => {
            const { path: _path, fallbackReason: _reason, ...value } = image;
            return value;
        });
        const read = (value: ExternalImageRead): Promise<Uint8Array> => {
            try {
                current(value.signal);
                const image = images.get(value.id);
                if (!image || !Number.isSafeInteger(value.chunkIndex) || value.chunkIndex < 0) { throw new Error('Unknown reading image request.'); }
                const chunk = image.chunks?.[value.chunkIndex];
                if (image.chunks ? !chunk : value.chunkIndex !== 0) { throw new Error('Unknown reading image chunk.'); }
                if (queue.length >= 64) { throw new Error('Reading image request queue is full.'); }
                return new Promise((resolve, reject) => {
                    const controller = new AbortController();
                    const cancel = () => {
                        controller.abort();
                        const index = queue.indexOf(job);
                        if (index >= 0) {
                            queue.splice(index, 1);
                            value.signal.removeEventListener('abort', cancel);
                            reject(abortError());
                        }
                    };
                    const job = {
                        cancel() { value.signal.removeEventListener('abort', cancel); reject(abortError()); },
                        start() {
                            if (disposed || value.signal.aborted) { job.cancel(); pump(); return; }
                            active.add(controller);
                            const range = chunk && (chunk.offset !== 0 || chunk.bytes !== image.bytes)
                                ? { offset: chunk.offset, bytes: chunk.bytes, total: image.bytes } : undefined;
                            void receive(new URL(image.path, base), controller.signal, 'image',
                                chunk?.bytes ?? image.bytes, PDF_READING_LIMITS.assetBytes, chunk?.sha256 ?? image.sha256, range,
                                { id: image.id, encoding: image.encoding, chunk: value.chunkIndex, scan: chunk?.scan ?? 0 },
                                options.readImage ? () => options.readImage!({ id: image.id, chunkIndex: value.chunkIndex, signal: controller.signal }) : undefined)
                                .then(result => { current(value.signal); if (!result) { throw new Error('Reading image is unavailable.'); } resolve(result); })
                                .catch(reject).finally(() => {
                                    value.signal.removeEventListener('abort', cancel);
                                    active.delete(controller); pump();
                                });
                        },
                    };
                    value.signal.addEventListener('abort', cancel, { once: true });
                    queue.push(job);
                    pump();
                });
            } catch (error) { return Promise.reject(error); }
        };
        metrics.event('reading-source', { sourceSha256: manifest.source.sha256, readingSha256: manifest.pdf.sha256,
            manifestRevision: descriptor.manifestRevision,
            sourceBytes: manifest.source.size, readingBytes: manifest.pdf.bytes, images: manifest.images.length });
        return { manifest, data, externalImageSource: { images: metadata, read }, dispose };
    } catch (error) {
        dispose();
        throw error;
    }
}
