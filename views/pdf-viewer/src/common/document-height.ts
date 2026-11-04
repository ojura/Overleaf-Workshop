/** One temporary height hold shared by the range and inline document setters. */
const holds = new WeakMap<HTMLElement, () => void>();

interface PageEvents {
    on(name: 'pagesinit', listener: () => void): void;
    off(name: 'pagesinit', listener: () => void): void;
}

/** Keep the old page height through assignment; release on pagesinit, abort, or setter failure. */
export function holdDocumentHeight(element: HTMLElement, events: PageEvents, signal?: AbortSignal): () => void {
    if (signal?.aborted) { return () => {}; }
    const height = element.getBoundingClientRect().height;
    holds.get(element)?.();
    if (height <= 0) { return () => {}; }
    const previous = element.style.minHeight;
    let released = false;
    const release = () => {
        if (released) { return; }
        released = true;
        events.off('pagesinit', release);
        signal?.removeEventListener('abort', release);
        if (holds.get(element) === release) {
            holds.delete(element);
            element.style.minHeight = previous;
        }
    };
    holds.set(element, release);
    element.style.minHeight = `${height}px`;
    events.on('pagesinit', release);
    signal?.addEventListener('abort', release, { once: true });
    if (signal?.aborted) { release(); }
    return release;
}
