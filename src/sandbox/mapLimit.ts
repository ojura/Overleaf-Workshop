/**
 * Run `fn` over `items`, at most `limit` at a time, and return the results in order.
 *
 * After the first failure no further item is started, and the promise rejects with that
 * failure only once the items already started have finished. So when this rejects,
 * nothing it started is still running, e.g. an upload after the run has released its lock.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    let failure: { error: unknown } | undefined;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (failure === undefined && next < items.length) {
            const index = next++;
            try {
                results[index] = await fn(items[index], index);
            } catch (error) {
                failure ??= { error };
            }
        }
    }));
    if (failure !== undefined) { throw failure.error; }
    return results;
}
