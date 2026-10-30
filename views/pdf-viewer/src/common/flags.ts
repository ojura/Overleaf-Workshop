/**
 * Overleaf's PDF loader reads its settings with getMeta (overleaf/.../utils/meta.ts), which
 * takes them from window.metaAttributesCache, a Map that Overleaf's pages fill from their meta
 * tags; getMeta throws when the Map is missing. pdf-caching-flags.ts reads the flags once, when
 * it is first imported, so this module must run before it: transport.ts imports it first.
 *
 * The values are the ones overleaf.com uses for PDF caching. Download tracking stays off: it only
 * reports metrics to Overleaf. The fallback to Overleaf's cache of compile outputs stays off too:
 * it needs the editor ID that the compile request sent, which the extension does not keep.
 */
const cache: Map<string, unknown> = (window as any).metaAttributesCache ??= new Map();

cache.set('ol-splitTestVariants', {
    ...(cache.get('ol-splitTestVariants') as object | undefined),
    'pdf-caching-mode': 'enabled',
    'pdf-caching-prefetching': 'enabled',
    'pdf-caching-prefetch-large': 'enabled',
    'pdf-caching-cached-url-lookup': 'enabled',
    'track-pdf-download': 'disabled',
});
cache.set('ol-canUseClsiCache', false);

export {};
