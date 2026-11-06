import type { Position, SavedState } from './protocol';

interface Events {
    on(name: string, listener: () => void): void;
    off(name: string, listener: () => void): void;
}

/** Capture the actual visible page even before PDF.js updates currentPageNumber on its next frame. */
export function visibleReadingPosition(viewer: any): Position | undefined {
    const container = viewer.container as HTMLElement;
    if (container.offsetParent === null) { return undefined; }
    const visible = viewer._getVisiblePages?.();
    const first = visible?.first ?? visible?.views?.[0];
    if (!first) { return undefined; }
    const pageView = first.view ?? viewer.getPageView(first.id - 1);
    if (!pageView?.div || !pageView.viewport) { return undefined; }
    const page = pageView.div.getBoundingClientRect(), clip = container.getBoundingClientRect();
    const [left, top] = pageView.viewport.convertToPdfPoint(clip.left - page.left, clip.top - page.top);
    const [, , width, height] = pageView.viewport.viewBox;
    if (![left, top, width, height].every(Number.isFinite)) { return undefined; }
    return { page: first.id - 1, offset: { left, top }, pageSize: { width, height } };
}

/** Restore the measured PDF point, including offsets within the page's surrounding margin. */
export function restoreReadingPosition(viewer: any, position: Position, scale: string | null = null) {
    viewer.scrollPageIntoView({
        pageNumber: position.page + 1,
        destArray: [null, { name: 'XYZ' }, position.offset.left, position.offset.top, scale],
        allowNegativeOffset: true,
    });
}

/** Both adapters publish reading changes immediately. The host owns durable-write coalescing. */
export function installReadingState(options: {
    container: HTMLElement;
    eventBus: Events;
    current(): Pick<SavedState, 'position' | 'scale'> | undefined;
    save(state: Pick<SavedState, 'position' | 'scale'>): void;
}) {
    let disposed = false, restoring = 0, previous = '';
    const capture = () => {
        if (disposed || restoring) { return; }
        const state = options.current();
        if (!state?.position) { return; }
        const snapshot = { position: {
            ...state.position, offset: { ...state.position.offset }, pageSize: { ...state.position.pageSize },
        }, scale: state.scale };
        const key = JSON.stringify(snapshot);
        if (key === previous) { return; }
        previous = key;
        options.save(snapshot);
    };
    const hidden = () => { if (document.visibilityState === 'hidden') { capture(); } };
    const pagehide = (event: PageTransitionEvent) => {
        if (event.persisted) { capture(); } else { dispose(); }
    };
    const dispose = () => {
        if (disposed) { return; }
        capture(); disposed = true;
        options.container.removeEventListener('scroll', capture);
        for (const name of ['updateviewarea', 'scalechanging']) { options.eventBus.off(name, capture); }
        document.removeEventListener('visibilitychange', hidden);
        window.removeEventListener('pagehide', pagehide);
    };
    options.container.addEventListener('scroll', capture, { passive: true });
    for (const name of ['updateviewarea', 'scalechanging']) { options.eventBus.on(name, capture); }
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', pagehide);
    return {
        capture, dispose,
        restore(run: () => void) {
            if (disposed) { return; }
            restoring++;
            try { run(); } finally { restoring--; if (!restoring) { capture(); } }
        },
    };
}
