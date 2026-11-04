import { PDF_PREVIEW_LIMITS, type PdfPreviewAsset, type PdfPreviewSource } from './pdf-preview-source';
import type { PdfPreviewDescriptor } from './protocol';
import { pdfPerformance } from './prefetch-performance';

interface Metrics {
    beginFetch(): () => void;
    fetch(bytes: number, durationMs: number): void;
}

interface Options {
    fetch?: typeof fetch;
    metrics?: Metrics;
    onChange?: PdfPreviewSource['onChange'];
}

/** Bounded transport shared by the website and the extension's approved local-resource URLs. */
export function httpPdfPreviewSource(descriptor: PdfPreviewDescriptor, options: Options = {}): PdfPreviewSource {
    const manifest = new URL(descriptor.manifestUrl);
    if (!['https:', 'http:'].includes(manifest.protocol) || manifest.username || manifest.password) {
        throw new Error('The preview manifest requires an HTTP resource URL without credentials.');
    }
    const directory = new URL('.', manifest);
    const request = options.fetch ?? globalThis.fetch.bind(globalThis);
    const metrics = options.metrics ?? pdfPerformance;

    async function read(url: URL, signal: AbortSignal, limit: number, expected?: number, mime?: string): Promise<Uint8Array | null> {
        if (signal.aborted) { throw new DOMException('Preview request stopped.', 'AbortError'); }
        const started = performance.now(), finish = metrics.beginFetch();
        let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let received = 0;
        try {
            response = await request(url.href, { signal, cache: 'no-cache', credentials: 'same-origin', redirect: 'error' });
            if (expected === undefined && response.status === 404) {
                await response.body?.cancel();
                return null;
            }
            if (response.status !== 200 || !response.body) { throw new Error('Preview request failed (HTTP ' + response.status + ').'); }
            const header = response.headers.get('Content-Length');
            // Fetch decodes gzip/br bodies while retaining their encoded Content-Length.
            // The stream cap and asset checksum apply to the decoded file bytes.
            const encoding = response.headers.get('Content-Encoding')?.trim().toLowerCase();
            const length = header === null || encoding && encoding !== 'identity' ? undefined : Number(header);
            if (length !== undefined && (!Number.isSafeInteger(length) || length < 0 || length > limit
                || expected !== undefined && length !== expected)) { throw new Error('Preview response length exceeds its allowed size.'); }
            let contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
            // The IDE's local-resource server labels JPEG files as image/jpg.
            if (contentType === 'image/jpg') { contentType = 'image/jpeg'; }
            if (mime && contentType && contentType !== mime && contentType !== 'application/octet-stream') {
                throw new Error('Preview response has a different image type.');
            }
            const output = expected === undefined ? undefined : new Uint8Array(expected);
            const chunks: Uint8Array[] = [];
            reader = response.body.getReader();
            for (;;) {
                const next = await reader.read();
                if (signal.aborted) { throw new DOMException('Preview request stopped.', 'AbortError'); }
                if (next.done) { break; }
                if (received + next.value.byteLength > limit || output && received + next.value.byteLength > output.byteLength) {
                    throw new Error('Preview response exceeded its bounded byte budget.');
                }
                if (output) { output.set(next.value, received); } else { chunks.push(next.value.slice()); }
                received += next.value.byteLength;
            }
            if (expected !== undefined && received !== expected || length !== undefined && received !== length) {
                throw new Error('Preview response ended before its declared length.');
            }
            if (output) { return output; }
            const joined = new Uint8Array(received);
            let offset = 0;
            for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
            return joined;
        } catch (error) {
            try { if (reader) { await reader.cancel(); } else { await response?.body?.cancel(); } } catch { /* The aborted transport may already be closed. */ }
            throw error;
        } finally {
            reader?.releaseLock();
            if (received) { metrics.fetch(received, performance.now() - started); }
            finish();
        }
    }

    return {
        identity: { ...descriptor.identity },
        onChange: options.onChange,
        async loadManifest(signal) {
            const bytes = await read(manifest, signal, PDF_PREVIEW_LIMITS.manifestBytes);
            return bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes));
        },
        async loadAsset(asset: PdfPreviewAsset, signal) {
            if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > PDF_PREVIEW_LIMITS.assetBytes
                || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(asset.path)
                || asset.path.split('/').some(part => !part || part === '.' || part === '..')) {
                throw new Error('Invalid preview asset path or size.');
            }
            const url = new URL(asset.path, directory);
            if (url.origin !== directory.origin || !url.pathname.startsWith(directory.pathname) || url.search || url.hash) {
                throw new Error('Preview asset escaped its manifest directory.');
            }
            return (await read(url, signal, Math.min(asset.bytes, PDF_PREVIEW_LIMITS.assetBytes), asset.bytes, asset.mime))!;
        },
    };
}
