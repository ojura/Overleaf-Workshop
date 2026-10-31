/**
 * Overleaf's PDF loader reads its settings with getMeta (overleaf/.../utils/meta.ts), which
 * takes them from window.metaAttributesCache, a Map that Overleaf's pages fill from their meta
 * tags; getMeta throws when the Map is missing. pdf-caching-flags.ts reads the flags once, when
 * it is first imported, so this module must run before it: transport.ts imports it first.
 *
 * PDF caching, the lookup of pieces by hash and the preference for large pieces are on.
 * Prefetching is off: with it, fetchRange adds the uncached gaps after the requested window to the
 * request (addPrefetchingChunks), and its reassembly sets aside only the cached pieces beyond the
 * window (pdf-caching.ts, "This is a (partially) prefetched chunk"). A gap beyond the window then
 * fails with "RangeError: offset is out of bounds", and the loader fetches the window again with a
 * plain range request. On the 885 MB book that happened on every few requests. Prefetching's other
 * part, fetching the cross-reference table with the first request, needs startXRefTable, which the
 * compile responses do not list. Download tracking stays off: it only reports metrics to Overleaf.
 * The fallback to Overleaf's cache of compile outputs is on. Overleaf's compile server deletes a
 * build after 90 minutes, or once two newer builds exist (OutputCacheManager.js:110-111), and the
 * cache keeps a copy of each build whose compile named an editor (clsi CompileController.js:152-157).
 * When the compile server answers 404, the loader asks the cache's shard for
 * /build/<editor>-<build>/output/output.pdf (getOutputPDFURLFromCache), from the build's editor ID
 * and shard, which the host passes on (output.ts).
 */
const cache: Map<string, unknown> = (window as any).metaAttributesCache ??= new Map();

cache.set('ol-splitTestVariants', {
    ...(cache.get('ol-splitTestVariants') as object | undefined),
    'pdf-caching-mode': 'enabled',
    'pdf-caching-prefetching': 'disabled',
    'pdf-caching-prefetch-large': 'enabled',
    'pdf-caching-cached-url-lookup': 'enabled',
    'track-pdf-download': 'disabled',
});
cache.set('ol-canUseClsiCache', true);

export {};
