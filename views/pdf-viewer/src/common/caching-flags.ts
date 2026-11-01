/**
 * Overleaf's pdf-caching-flags.ts as the viewers' build gives it to Overleaf's loader,
 * pdf-caching-transport.ts (scripts/build-pdf-viewer.mjs, standIns): Overleaf's flags, except
 * canUseClsiCache. Overleaf's editor turns the fallback to its cache of compile outputs on for a
 * whole project, when the project's owner has the priority compile group
 * (ProjectController.mjs:1104-1106). The window does not know the owner's group, and Overleaf's
 * cache keeps a build under the shard that its compile names, so the fallback is on for a load
 * whose build names a shard: the transport sets it before each load (transport.ts), and the
 * loader reads it each time a request fails (pdf-caching-transport.ts:150).
 */
export {
    cachedUrlLookupEnabled, enablePdfCaching, prefetchingEnabled, prefetchLargeEnabled, trackPdfDownloadEnabled,
} from '@/features/pdf-preview/util/pdf-caching-flags';

export let canUseClsiCache = false;

/** Fall back to Overleaf's cache for the next load only when its build names the cache's shard, `shard`. */
export function useClsiCacheFor(shard: string) {
    canUseClsiCache = shard !== '';
}
