/**
 * Overleaf's pdf-caching-flags.ts as the viewers' build gives it to Overleaf's loader,
 * pdf-caching-transport.ts (scripts/build-pdf-viewer.mjs, standIns): Overleaf's flags, except
 * canUseClsiCache. Overleaf's editor turns the fallback to its cache of compile outputs on for a
 * whole project, when the project's owner has the priority compile group
 * (ProjectController.mjs:1104-1106). The window does not know the owner's group, and Overleaf's
 * cache keeps a build under the shard that its compile names, so the fallback is on for a load
 * whose build names a shard. Overleaf's loader reads its flag each time a request fails
 * (pdf-caching-transport.ts:150), and a request of an older load can fail after a newer load has
 * begun, so the decision belongs to each load: the build has the loader ask canUseClsiCacheFor
 * with the load's own file in place of reading canUseClsiCache.
 */
export {
    cachedUrlLookupEnabled, enablePdfCaching, prefetchingEnabled, prefetchLargeEnabled, trackPdfDownloadEnabled,
} from '@/features/pdf-preview/util/pdf-caching-flags';

/** Whether a load of `file` falls back to Overleaf's cache: when its build names the cache's shard. */
export function canUseClsiCacheFor(file: { clsiCacheShard?: string }): boolean {
    return Boolean(file.clsiCacheShard);
}
