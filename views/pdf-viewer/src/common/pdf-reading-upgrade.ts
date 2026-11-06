import { untilAborted } from './document-lifecycle';
import { nativePdfImageContext } from './pdf-image-hints';

/**
 * A representation upgrade keeps the actual old document until the current visible pages
 * have native image coverage. This preparation owns no displayed layer or persistent bitmap.
 */
export async function preparePdfReadingUpgrade(candidate: any, viewer: any, signal: AbortSignal): Promise<void> {
    if (!candidate?.hasExternalImages || !viewer?.pdfDocument) { return; }
    const abort = new AbortController(), pages = new Map<number, { page: any; key: string }>();
    const stop = () => abort.abort();
    const visibility = () => { if (document.hidden) { stop(); } };
    const interaction = (event: Event) => { if (event.isTrusted) { stop(); } };
    signal.addEventListener('abort', stop, { once: true });
    document.addEventListener('visibilitychange', visibility);
    for (const name of ['wheel', 'pointerdown', 'touchstart', 'keydown']) { document.addEventListener(name, interaction, true); }
    if (signal.aborted || document.hidden) { stop(); }
    const check = () => { if (abort.signal.aborted) { throw new DOMException('Reading preparation stopped.', 'AbortError'); } };
    const visible = () => {
        const ids = viewer._getVisiblePages?.()?.views?.map((item: any) => item.id)
            ?? [viewer.currentPageNumber || 1];
        return [...new Set<number>(ids.filter((id: number) => Number.isInteger(id) && id > 0 && id <= candidate.numPages))];
    };
    const intent = (id: number, page: any) => {
        const view = viewer.getPageView?.(id - 1);
        if (!view?._getRenderingContext) { throw new Error('The native page cannot describe its adopting image intent.'); }
        const native = nativePdfImageContext(page, view, viewer.pagesRotation || 0, document.defaultView?.devicePixelRatio || 1);
        const { annotationMode, isEditing, pageColors } = view._getRenderingContext(null, native.transform);
        const parameters = { ...native, annotationMode, isEditing, pageColors };
        const { viewport, transform, imageDecodeScale, imageDecodeMaxDimension } = native;
        return { parameters, key: JSON.stringify([viewport.width, viewport.height, viewport.scale, viewport.rotation,
            ...transform, imageDecodeScale, imageDecodeMaxDimension, annotationMode, !!isEditing, pageColors]) };
    };
    let committed = false;
    try {
        for (;;) {
            check();
            const ids = visible();
            if (!ids.length) { throw new Error('No current pages are available for reading preparation.'); }
            for (const [id, prepared] of pages) {
                const { page, key } = prepared;
                if (!ids.includes(id) || intent(id, page).key !== key) {
                    await page.cancelImageRefinement?.();
                    page.cleanup?.();
                    pages.delete(id);
                    check();
                }
            }
            for (const id of ids) {
                if (pages.has(id)) { continue; }
                const page: any = await untilAborted(abort.signal, candidate.getPage(id));
                check();
                if (!page?.waitForImages) { throw new Error('The native viewer cannot prepare reading image coverage.'); }
                const plan = intent(id, page);
                pages.set(id, { page, key: plan.key });
                const canvas = document.createElement('canvas');
                // Clipping the destination does not clip operator discovery. Retain the real
                // viewport/density and annotation intent so adoption reuses its covered objects.
                canvas.width = canvas.height = 2;
                let task: any;
                const cancel = () => task?.cancel();
                abort.signal.addEventListener('abort', cancel, { once: true });
                try {
                    task = page.render({ ...plan.parameters, canvasContext: canvas.getContext('2d', { alpha: false }) });
                    await untilAborted(abort.signal, task.promise);
                    check();
                    await untilAborted(abort.signal, page.waitForImages({ final: false, signal: abort.signal }));
                    check();
                } finally {
                    abort.signal.removeEventListener('abort', cancel);
                    canvas.width = canvas.height = 0;
                }
            }
            // Navigation during a transfer changes the prepared set, not the user's reading state.
            const current = visible();
            if (current.length === ids.length && current.every(id => {
                const prepared = pages.get(id);
                return prepared && intent(id, prepared.page).key === prepared.key;
            })) { committed = true; return; }
        }
    } finally {
        signal.removeEventListener('abort', stop);
        document.removeEventListener('visibilitychange', visibility);
        for (const name of ['wheel', 'pointerdown', 'touchstart', 'keydown']) { document.removeEventListener(name, interaction, true); }
        if (!committed) {
            await Promise.allSettled([...pages.values()].map(async ({ page }) => {
                try { await page.cancelImageRefinement?.(); } finally { page.cleanup?.(); }
            }));
        }
    }
}
