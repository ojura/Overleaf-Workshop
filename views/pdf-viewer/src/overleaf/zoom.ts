import type PDFJSWrapper from '@/features/pdf-preview/util/pdf-js-wrapper';

/**
 * Overleaf's zoom keys (pdf-js-viewer.tsx:441-476): Ctrl or Cmd with + or = zooms in, with -
 * zooms out, with 0 fits the width and with 9 the height.
 *
 * VS Code's webview passes every keydown on to VS Code (handleInnerKeydown in the webview's
 * pre/index.html, a listener on the page's window), where Ctrl+= and Ctrl+- zoom the whole
 * window. These keys are taken in the capture phase and stopped there, so they zoom only the PDF.
 */
export function listenForZoomKeys(zoom: (value: string) => void, isReady: () => boolean) {
    window.addEventListener('keydown', (event: KeyboardEvent) => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey || !isReady()) { return; }
        const target = event.target as HTMLElement | null;
        if (target?.closest?.('input, select, textarea')) { return; }
        let value: string | undefined;
        switch (event.key) {
            case '+':
            case '=':
                value = 'zoom-in';
                break;
            case '-':
                value = 'zoom-out';
                break;
            case '0':
                value = 'page-width';
                break;
            case '9':
                value = 'page-height';
                break;
        }
        if (value) {
            event.preventDefault();
            event.stopImmediatePropagation();
            zoom(value);
        }
    }, true);
}

/**
 * Ctrl or Cmd with the mouse wheel or a touchpad pinch zooms around the pointer: Overleaf's
 * use-mouse-wheel-zoom.ts as a plain listener. Zooming starts only when the key was down before
 * the wheel started, so momentum of a scroll does not turn into a zoom.
 */
const MAX_SCALE_FACTOR = 1.2;
const SCALE_FACTOR_DIVISOR = 20;

export function listenForWheelZoom(wrapper: PDFJSWrapper, setScale: (scale: string) => void) {
    let zooming = false;
    let scrolling = false;
    let scrollingTimeout: ReturnType<typeof setTimeout> | undefined;

    const performZoom = (event: WheelEvent) => {
        const scrollMagnitude = Math.abs(event.deltaY);
        const scaleFactorMagnitude = Math.min(1 + scrollMagnitude / SCALE_FACTOR_DIVISOR, MAX_SCALE_FACTOR);
        const previousScale = wrapper.viewer.currentScale;
        const approximateScaleFactor = Math.sign(event.deltaY) < 0 ? scaleFactorMagnitude : 1 / scaleFactorMagnitude;
        const newScale = Math.round(previousScale * approximateScaleFactor * 100) / 100;
        const exactScaleFactor = newScale / previousScale;
        wrapper.viewer.currentScale = newScale;
        setScale(`${newScale}`);
        const rect = wrapper.container.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        wrapper.container.scrollBy({
            left: x * exactScaleFactor - x,
            top: y * exactScaleFactor - y,
            behavior: 'instant',
        });
    };

    wrapper.container.addEventListener('wheel', (event: WheelEvent) => {
        if ((event.metaKey || event.ctrlKey) && !scrolling) {
            event.preventDefault();
            if (!zooming) {
                zooming = true;
                performZoom(event);
                setTimeout(() => { zooming = false; }, 5);
            }
        } else {
            scrolling = true;
            if (scrollingTimeout) { clearTimeout(scrollingTimeout); }
            scrollingTimeout = setTimeout(() => { scrolling = false; }, 100);
        }
    }, { passive: false });
}
