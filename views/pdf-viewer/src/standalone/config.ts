/** Public deployment settings, loaded from config.json beside index.html. */
export interface SiteConfig {
    pdfUrl: string;
    title: string;
    filename: string;
    sourceUrl?: string;
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
    return { pdfUrl: pdf.href, title: input.title.trim(), filename: input.filename, sourceUrl };
}

/** PDF.js supplies the page, zoom and position as one canonical PDF-open hash. */
export function pageLink(baseUrl: string, pdfOpenParams: string): string {
    const url = new URL(baseUrl);
    url.searchParams.delete('file');
    url.hash = pdfOpenParams;
    return url.href;
}
