import type { PDFFile } from '@ol-types/compile';
import type { PdfOutput } from './protocol';

/**
 * The file and URL that Overleaf's loader and PDFJSWrapper.loadDocument take, as
 * features/pdf-preview/util/output-files.ts builds them from a compile response. The loader
 * changes the file it is given, so it gets a copy.
 */
export function toPdfFile(output: PdfOutput): { url: string, pdfFile: PDFFile } {
    const file = structuredClone(output.file);
    const pdfFile = {
        ...file,
        downloadURL: output.url,
        pdfUrl: output.url,
        pdfDownloadUrl: output.url,
        size: file.size ?? 0,
        ranges: (file.ranges ?? []).map(range => ({ ...range, objectId: range.objectId ?? '' })),
        contentId: file.contentId ?? '',
        // where the loader finds the build when the compile server has deleted it
        // (pdf-caching-transport.ts, getOutputPDFURLFromCache)
        clsiCacheShard: output.clsiCacheShard ?? '',
        editorId: file.editorId ?? '',
    } as unknown as PDFFile;
    return { url: output.url, pdfFile };
}
