// The flags must be set before Overleaf's loader modules run: keep this import first.
import './flags';
import { generatePdfCachingTransportFactory as overleafFactory } from '@/features/pdf-preview/util/pdf-caching-transport';
import { getPdfCachingMetrics } from '@/features/pdf-preview/util/metrics';
import { useClsiCacheFor } from './caching-flags';
import type { PDFFile } from '@ol-types/compile';

export interface TransportArgs {
    url: string;
    pdfFile: PDFFile;
    abortController: AbortController;
    handleFetchError: (error: any) => void;
}

/**
 * Overleaf's range transport factory, for every load.
 *
 * After any failed request, Overleaf's factory returns undefined for every later load
 * (pdf-caching-transport.ts:304-308), so that pdf.js requests the PDF itself. On overleaf.com
 * that works. In the webview such a request goes through the extension host, starts with a GET
 * of the whole file, and the host answers only once it has all of it: 885 MB for a large book.
 * So this factory clears the flag that switches the transport off before each load. The flag is a
 * field of the metrics object, a module singleton that Overleaf's factory extends with
 * Object.assign; the factory's other state, the use counts and the URLs of earlier builds' pieces,
 * stays. Failed requests within a load still fall back to plain range requests (fallbackRequest).
 *
 * The build script also gives this module to PDFJSWrapper in place of its
 * './pdf-caching-transport', so the wrapper gets the same factory.
 */
export function generatePdfCachingTransportFactory(): (args: TransportArgs) => any {
    const factory = overleafFactory();
    return (args: TransportArgs) => {
        (getPdfCachingMetrics() as { failedOnce?: boolean }).failedOnce = false;
        // the fallback to Overleaf's cache, for a build that names its shard (caching-flags.ts)
        useClsiCacheFor(args.pdfFile.clsiCacheShard);
        const transport = factory(args);
        if (!transport) {
            throw new Error('Overleaf\'s loader did not make a range transport; are its flags set (flags.ts)?');
        }
        return transport;
    };
}
