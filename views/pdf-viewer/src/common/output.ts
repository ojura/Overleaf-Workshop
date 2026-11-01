import type { PDFFile } from '@ol-types/compile';

/** output.pdf in a compile response, as the extension host passes it on (OutputFileEntity). */
export interface OutputFile {
    path: string;
    url: string;
    type: string;
    build: string;
    size?: number;
    ranges?: { start: number, end: number, hash: string, objectId?: string }[];
    contentId?: string;
    createdAt?: string;
    startXRefTable?: number;
    /** the editor whose compile made the build; with the build ID it names the build in Overleaf's cache of compile outputs */
    editorId?: string;
}

/** A build's output.pdf, as the host's 'load' message carries it (src/core/remoteFileSystemProvider.ts). */
export interface PdfOutput {
    /** output.pdf on the download domain, with the query that Overleaf's viewer uses */
    url: string;
    downloadDomain: string;
    projectId: string;
    file: OutputFile;
    /** the shard of Overleaf's cache of compile outputs that keeps the build */
    clsiCacheShard?: string;
}

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
