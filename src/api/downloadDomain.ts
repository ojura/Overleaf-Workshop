/**
 * The addresses of a build's output files on Overleaf's download domain, which serves them in
 * ranges. This module imports nothing, so that the PDF viewer harness can bundle it too
 * (scripts/pdf-viewer-harness).
 */

/**
 * Output file `url` of a build on Overleaf's download domain `downloadDomain`, with the query that
 * Overleaf's viewer sends there (features/pdf-preview/util/output-files.ts, handleOutputFiles): the
 * compile group when the compile names one, the compile server that made the build, and
 * enable_pdf_caching.
 */
export function downloadDomainUrl(downloadDomain: string, url: string, clsiServerId: string | undefined, compileGroup: string | undefined): string {
    const query = new URLSearchParams();
    if (compileGroup) { query.set('compileGroup', compileGroup); }
    if (clsiServerId) { query.set('clsiserverid', clsiServerId); }
    query.set('enable_pdf_caching', 'true');
    return `${downloadDomain.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}?${query}`;
}

/**
 * Where output file `url` of build `build`, which editor `editorId` compiled, is in Overleaf's
 * cache of compile outputs on the download domain, which serves it in ranges: the build's path
 * with build/<editor>-<build>/ for build/<build>/, and the cache's shard `shard` for the compile
 * server, as Overleaf's PDF loader asks for a build that the compile server has deleted
 * (pdf-caching-transport.ts:154-163, getOutputPDFURLFromCache, which finds the build's part of the
 * path by the form of build IDs).
 */
export function cachedDownloadDomainUrl(downloadDomain: string, url: string, build: string, editorId: string, shard: string, compileGroup: string | undefined): string {
    return downloadDomainUrl(downloadDomain, url.replace(`build/${build}/`, `build/${editorId}-${build}/`), shard, compileGroup);
}
