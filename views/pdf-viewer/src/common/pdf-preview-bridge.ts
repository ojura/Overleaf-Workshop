import { config } from './config';
import { onMessage } from './host';
import { httpPdfPreviewSource } from './pdf-preview-http';
import type { PdfPreviewDescriptor } from './protocol';
import type { PdfPreviewSource } from './pdf-preview-source';

const changes = new Map<string, Set<() => void>>();

onMessage('previewChanged', message => {
    if (message.page !== config.page) { return; }
    for (const listener of changes.get(message.key) ?? []) { listener(); }
});

/** The descriptor travels with the exact output that installed this document. */
export function hostPdfPreviewSource(descriptor: PdfPreviewDescriptor | undefined): PdfPreviewSource | undefined {
    if (!descriptor) { return; }
    return httpPdfPreviewSource(descriptor, {
        onChange(listener) {
            const key = descriptor.identity.key;
            const listeners = changes.get(key) ?? new Set<() => void>();
            listeners.add(listener);
            changes.set(key, listeners);
            return () => {
                listeners.delete(listener);
                if (!listeners.size && changes.get(key) === listeners) { changes.delete(key); }
            };
        },
    });
}
