import { buildHighlightElement } from '@/features/pdf-preview/util/highlights';
import { post } from './host';
import type { Position } from './host';

/**
 * SyncTeX in a viewer page, as Overleaf's viewer does it
 * (features/pdf-preview/components/pdf-js-viewer.tsx, hooks/use-synctex.ts). The extension host
 * sends the requests to Overleaf (src/compile/compileManager.ts).
 */

/** A box of the PDF that a source position maps to; page counts from 1, PDF points from the top left. */
export interface SyncBox {
    page: number;
    h: number;
    v: number;
    width: number;
    height: number;
}

/** The page and PDF point of a click, as PDFJSWrapper.clickPosition gives them; page counts from 0. */
export type ClickPosition = (event: MouseEvent, canvas: HTMLCanvasElement, page: number) =>
    { page: number, offset: { left: number, top: number } } | undefined;

let clearHighlights: (() => void) | undefined;

/**
 * Highlight the boxes that the source position maps to, scroll the first one into view, and fade
 * each one in and out once it is in view (pdf-js-viewer.tsx:324-393).
 */
export function showHighlights(viewer: any, boxes: SyncBox[]) {
    clearHighlights?.();
    const timers: number[] = [];
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                observer.unobserve(entry.target);
                const element = entry.target as HTMLElement;
                element.style.opacity = '0.5';
                timers.push(window.setTimeout(() => { element.style.opacity = '0'; }, 1100));
            }
        }
    }, { threshold: 1.0 }); // the whole element must be visible

    const elements: HTMLElement[] = [];
    for (const box of boxes) {
        try {
            const element = buildHighlightElement(box, viewer);
            elements.push(element);
            observer.observe(element);
        } catch {
            // a box on a page that the viewer does not have
        }
    }
    const [first] = elements;
    if (first) {
        // briefly after adding the element to the page
        timers.push(window.setTimeout(() => first.scrollIntoView({ block: 'center', inline: 'start', behavior: 'smooth' }), 100));
    }
    clearHighlights = () => {
        timers.forEach(timer => window.clearTimeout(timer));
        elements.forEach(element => element.remove());
        observer.disconnect();
    };
}

/** Ask the host to open the source at a position in the PDF (use-synctex.ts:187-258). */
function syncToCode(position: { page: number, offset: { left: number, top: number }, pageSize?: { height: number } }, identifier: string, visualOffset = 0) {
    // SyncTeX measures v from the top of the page; a position from currentPosition is measured
    // from the bottom, a click position from the top already
    const v = (position.pageSize?.height ? position.pageSize.height - position.offset.top : position.offset.top) + visualOffset;
    post({ type: 'syncPdf', content: { page: position.page + 1, h: position.offset.left, v, identifier } });
}

/**
 * Open the source at a double-clicked point of the PDF (pdf-js-viewer.tsx:249-287). The
 * double-clicked word goes along, so the host can put the cursor on it in the source line.
 */
export function listenForDoubleClick(eventBus: any, clickPosition: ClickPosition) {
    eventBus.on('textlayerrendered', ({ source, pageNumber }: { source: any, pageNumber: number }) => {
        const textLayerDiv: HTMLElement | undefined = source.textLayerDiv ?? source.textLayer?.div;
        if (!textLayerDiv || textLayerDiv.dataset.listeningForDoubleClick) { return; }
        textLayerDiv.dataset.listeningForDoubleClick = 'true';
        textLayerDiv.addEventListener('dblclick', (event: MouseEvent) => {
            const canvas = textLayerDiv.closest('.page')?.querySelector('canvas');
            const position = canvas ? clickPosition(event, canvas, pageNumber - 1) : undefined;
            if (position) {
                const word = window.getSelection()?.toString().trim() || (event.target as HTMLElement | null)?.textContent || '';
                syncToCode(position, word);
            }
        });
    });
}

/**
 * Open the source at the top of the viewer's current position, 72 points down so that SyncTeX
 * finds the first line that is fully visible (pdf-synctex-controls.tsx:62).
 */
export function goToCode(position: Position) {
    syncToCode(position, '', 72);
}
