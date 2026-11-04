import type { PdfPreviewSource } from './pdf-preview-source';

interface Viewer {
    pdfDocument?: unknown;
    eventBus: { on(name: string, listener: () => void): void; off(name: string, listener: () => void): void };
}

/** A native view transition can return a document before it installs that document's pages. */
export function createPdfPreviewBinding(viewer: Viewer, attach: (source: PdfPreviewSource | undefined, document: unknown) => void) {
    let pending: { source: PdfPreviewSource | undefined, document: unknown } | undefined;
    let disposed = false;
    const apply = () => {
        if (disposed || !pending || pending.document !== viewer.pdfDocument) { return; }
        const selected = pending;
        pending = undefined;
        attach(selected.source, selected.document);
    };
    viewer.eventBus.on('pagesinit', apply);
    return {
        set(source: PdfPreviewSource | undefined, document: unknown) {
            if (disposed || !document) { return; }
            pending = { source, document };
            apply();
        },
        /** Withdraw only a not-yet-installed source; the currently displayed document keeps its source. */
        clear() { pending = undefined; },
        dispose() {
            if (disposed) { return; }
            disposed = true; pending = undefined;
            viewer.eventBus.off('pagesinit', apply);
        },
    };
}
