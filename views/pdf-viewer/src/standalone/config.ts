import type { PdfPreviewDescriptor } from '../common/protocol';
import type { PdfHttpValidator } from './http-range';

export interface SitePreviewConfig {
    manifestUrl: string;
    manifestRevision?: string;
    sha256: string;
    size: number;
    validator: PdfHttpValidator;
}

/** Public deployment settings, loaded from config.json beside index.html. */
export interface SiteConfig {
    pdfUrl: string;
    title: string;
    filename: string;
    sourceUrl?: string;
    previews?: SitePreviewConfig;
    publicationGeneration?: number;
}

function readPreviewConfig(value: unknown, base: URL): SitePreviewConfig | undefined {
    if (!value || typeof value !== 'object') { return; }
    const input = value as Record<string, any>;
    if (typeof input.manifestUrl !== 'string' || !input.manifestUrl
        || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)
        || !Number.isSafeInteger(input.size) || input.size <= 0) { return; }
    const validator = input.validator;
    if (!validator || typeof validator.value !== 'string' || /[\r\n]/.test(validator.value)) { return; }
    if (validator.header === 'ETag') {
        if (!/^"[^"\r\n]*"$/.test(validator.value)) { return; }
    } else if (validator.header === 'Last-Modified') {
        if (!Number.isFinite(Date.parse(validator.value))) { return; }
    } else { return; }
    try {
        const url = new URL(input.manifestUrl, base);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password) { return; }
        url.hash = '';
        const manifestRevision = typeof input.manifestRevision === 'string' && /^[a-f0-9]{64}$/.test(input.manifestRevision)
            ? input.manifestRevision : undefined;
        return { manifestUrl: url.href, manifestRevision, sha256: input.sha256, size: input.size,
            validator: { header: validator.header, value: validator.value } };
    } catch { return; }
}

export function readSiteConfig(value: unknown, baseUrl: string): SiteConfig {
    if (!value || typeof value !== 'object') { throw new Error('Invalid website configuration.'); }
    const input = value as Record<string, unknown>;
    if (typeof input.pdfUrl !== 'string' || !input.pdfUrl.trim()) { throw new Error('config.json requires pdfUrl.'); }
    const base = new URL(baseUrl);
    const pdf = new URL(input.pdfUrl, base);
    if (!['http:', 'https:'].includes(pdf.protocol) || pdf.origin !== base.origin) {
        throw new Error('pdfUrl must be an HTTP URL on the same origin as the viewer.');
    }
    if (pdf.username || pdf.password) { throw new Error('pdfUrl must not contain credentials.'); }
    pdf.hash = '';
    if (typeof input.title !== 'string' || !input.title.trim()) { throw new Error('config.json requires title.'); }
    if (typeof input.filename !== 'string' || !input.filename.trim() || /[/\\\u0000-\u001f]/.test(input.filename)) {
        throw new Error('config.json requires a plain download filename.');
    }
    let sourceUrl: string | undefined;
    if (typeof input.sourceUrl === 'string' && input.sourceUrl) {
        const source = new URL(input.sourceUrl, base);
        if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) {
            throw new Error('sourceUrl must be an HTTP URL without credentials.');
        }
        sourceUrl = source.href;
    }
    const publicationGeneration = typeof input.publicationGeneration === 'number' && Number.isSafeInteger(input.publicationGeneration)
        && input.publicationGeneration >= 0 ? input.publicationGeneration : undefined;
    return { pdfUrl: pdf.href, title: input.title.trim(), filename: input.filename, sourceUrl, publicationGeneration,
        previews: readPreviewConfig(input.previews, base) };
}

/** The published digest is trusted only while the PDF transport observes its bound HTTP version. */
export function sitePreviewDescriptor(config: SiteConfig, source: { length: number; validator?: PdfHttpValidator }): PdfPreviewDescriptor | undefined {
    const preview = config.previews, actual = source.validator;
    if (!preview || preview.size !== source.length || !actual
        || preview.validator.header !== actual.header || preview.validator.value !== actual.value) { return; }
    return { identity: { key: 'sha256:' + preview.sha256, size: preview.size, sha256: preview.sha256 },
        manifestUrl: preview.manifestUrl };
}

/** PDF.js supplies the page, zoom and position as one canonical PDF-open hash. */
export function pageLink(baseUrl: string, pdfOpenParams: string): string {
    const url = new URL(baseUrl);
    url.searchParams.delete('file');
    url.hash = pdfOpenParams;
    return url.href;
}
