// The two viewer pages, the pdfjs viewer and the Overleaf viewer, as the harness's scripts read and
// drive them: expressions, and the sources of functions, that run in a viewer page, in headless
// Chrome (cdp.mjs) and in a webview of the test instance (ide/ide.mjs) alike. Each fact about the
// pages that the scripts use is written here once: where a page keeps its viewer object (pdf.js's
// PDFViewer), when a page counts as drawn, the ids of the buttons and toolbars, the SyncTeX
// highlight, how a theme switch waits for the new drawing, and which pixels of a page count as an
// image's.

/** pdf.js's RenderingStates.FINISHED: the renderingState of a page view whose canvas is drawn. */
export const RENDERING_FINISHED = 3;

/** The viewer object (pdf.js's PDFViewer) of a page that runs the viewer `engine` ('pdfjs' or 'overleaf'): an expression for the page. */
export const viewerOf = (engine) => (engine === 'overleaf' ? 'window.overleafViewer.wrapper.viewer' : 'window.PDFViewerApplication.pdfViewer');

/** viewerOf(engine), which is undefined while the page has not made its viewer. */
export const viewerIfAny = (engine) => viewerOf(engine).replaceAll('.', '?.');

/** The viewer object of a page that runs either viewer, undefined while the page has not made one. */
export const ANY_VIEWER = `(${viewerIfAny('overleaf')} ?? ${viewerIfAny('pdfjs')})`;

/** Which viewer a page runs: an expression that gives 'overleaf', 'pdfjs', or undefined while the page has not made its viewer. */
export const ENGINE_OF_PAGE = `(window.overleafViewer ? 'overleaf' : window.PDFViewerApplication ? 'pdfjs' : undefined)`;

/** The Overleaf viewer's documents (views/pdf-viewer/src/overleaf/documents.ts): owned, inFlight, shownUrl. */
export const OVERLEAF_DOCUMENTS = 'window.overleafViewer.documents';

/**
 * Whether page `page` of the viewer `engine` is drawn: an expression that is false while the page
 * has not made its viewer, and while the viewer has no document. `page` is a page number, or an
 * expression that can use `v`, the viewer object, as pageInViewDrawn does.
 */
export const pageDrawn = (engine, page) => `(() => { const v = ${viewerIfAny(engine)}; return !!v && v.pagesCount > 0 && v.getPageView((${page}) - 1)?.renderingState === ${RENDERING_FINISHED}; })()`;

/** Whether the page in view of the viewer `engine` is drawn (pageDrawn). */
export const pageInViewDrawn = (engine) => pageDrawn(engine, 'v.currentPageNumber');

/** The ids of each viewer's buttons: the color theme button, and the button that shows the PDF in the other viewer. */
export const BUTTONS = {
    pdfjs: { theme: 'themeButton', switchViewer: 'switchViewerButton' },
    overleaf: { theme: 'themeToggle', switchViewer: 'switchViewer' },
};

/** The button `name` of BUTTONS in the viewer `engine`: an expression that is null when the page does not have it. */
export const buttonOf = (engine, name) => `document.getElementById(${JSON.stringify(BUTTONS[engine][name])})`;

/** The selector of each viewer's toolbar. */
export const TOOLBAR = { pdfjs: '#toolbarContainer', overleaf: '#toolbar' };

/** The pdfjs viewer's pop-ups that the toolbar opens: [name, the id of the button that opens and closes it, its selector]. */
export const PDFJS_POPUPS = [['find bar', 'viewFindButton', '#findbar'], ['tools menu', 'secondaryToolbarToggleButton', '#secondaryToolbar']];

/**
 * The elements in the element of `selector` that reach past the right edge of the page's
 * viewport: an expression that gives up to six of them, by id, class or tag name, and an empty
 * list when the page does not have that element.
 */
export const pastRightEdge = (selector) => `(() => {
    const width = document.documentElement.clientWidth;
    const root = document.querySelector(${JSON.stringify(selector)});
    if (!root) { return []; }
    return [...root.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > width + 0.5 && getComputedStyle(e).visibility !== 'hidden'; })
        .map(e => e.id || e.className || e.tagName).slice(0, 6);
})()`;

/**
 * The Overleaf viewer's highlight of a forward SyncTeX search: an expression for its element, a
 * yellow box in the viewer's or a page's div, or undefined.
 */
export const SYNCTEX_HIGHLIGHT = `[...document.querySelectorAll('.pdfViewer > div, .pdfViewer .page > div')].find(d => d.style.backgroundColor === 'rgb(255, 255, 0)')`;

/** The last resort for a page that a viewer does not draw: the viewers draw a page within a few seconds. */
const DRAW_LIMIT_MS = 30000;

/**
 * The source of a function for a page of the viewer `engine` that waits for pdf.js's event bus to
 * report the end of the drawing of page `pageNumber`, the event 'pagerendered' of the page's own
 * canvas, after `start()` has run, and fails when the drawing fails or has not ended within
 * `limitMs`. Used by showPageFunction and switchThemeFunction.
 */
const drawnAfter = (engine) => `((pageNumber, start, limitMs) => new Promise((resolve, reject) => {
    const viewer = ${viewerOf(engine)};
    const drawn = (event) => {
        // an event with cssTransform only scaled the old canvas, and a detail view draws a part of the page
        if (event.pageNumber !== pageNumber || event.cssTransform || event.isDetailView) { return; }
        clearTimeout(timer);
        viewer.eventBus.off('pagerendered', drawn);
        if (event.error) { reject(new Error('page ' + pageNumber + ' failed to draw: ' + event.error)); } else { resolve(); }
    };
    const timer = setTimeout(() => {
        viewer.eventBus.off('pagerendered', drawn);
        reject(new Error('page ' + pageNumber + ' was not drawn within ' + limitMs / 1000 + ' s'));
    }, limitMs);
    viewer.eventBus.on('pagerendered', drawn);
    try {
        start();
    } catch (error) {
        clearTimeout(timer);
        viewer.eventBus.off('pagerendered', drawn);
        reject(error);
    }
}))`;

/**
 * The source of an async function for a page of the viewer `engine`, (pageNumber) => ms: it shows
 * page `pageNumber` and returns once the page is drawn, with the time that took, from pdf.js's
 * event bus ('pagerendered'). It calls the viewer's update(), which draws the pages in view also in
 * a window that does not draw (see rafOnTimer in ide/ide.mjs). It fails when the document does not
 * have the page, and when the page has not been drawn within `limitMs`.
 */
export const showPageFunction = (engine, limitMs = DRAW_LIMIT_MS) => `(async (pageNumber) => {
    const viewer = ${viewerOf(engine)};
    const view = viewer.getPageView(pageNumber - 1);
    if (!view) { throw new Error('the document does not have page ' + pageNumber + '; it has ' + viewer.pagesCount); }
    const t0 = performance.now();
    if (viewer.currentPageNumber === pageNumber && view.renderingState === ${RENDERING_FINISHED}) { return 0; }
    await ${drawnAfter(engine)}(pageNumber, () => {
        viewer.currentPageNumber = pageNumber;
        viewer.update();
        // a page that was drawn before is not drawn again
        if (view.renderingState === ${RENDERING_FINISHED}) { throw 'drawn'; }
    }, ${limitMs}).catch((error) => { if (error !== 'drawn') { throw error; } });
    return Math.round(performance.now() - t0);
})`;

/**
 * The source of an async function for a page of the viewer `engine`, (pageNumber, theme) => the
 * name of the theme now: it clicks the viewer's theme button and waits until page `pageNumber`,
 * which must be in view, is drawn again, once when `theme` is undefined, else until the button
 * names `theme`. A click makes the viewer draw its pages again at once (applyTheme in
 * views/pdf-viewer/src/common/theme.ts calls the viewer's refresh()), and pdf.js's event bus reports
 * the end of a page's drawing ('pagerendered'). It fails when the viewer has one theme, when it
 * does not offer `theme`, and when a drawing has not ended within `limitMs`.
 */
export const switchThemeFunction = (engine, limitMs = DRAW_LIMIT_MS) => `(async (pageNumber, theme) => {
    const button = ${buttonOf(engine, 'theme')};
    if (!button || button.hidden) { throw new Error('the viewer offers one color theme, and its theme button is hidden'); }
    const next = () => ${drawnAfter(engine)}(pageNumber, () => button.click(), ${limitMs});
    if (theme === undefined) { await next(); return button.dataset.theme; }
    const first = button.dataset.theme;
    const offered = [first];
    while (button.dataset.theme !== theme) {
        await next();
        if (button.dataset.theme === first) { throw new Error('the viewer does not offer the color theme ' + theme + '; it offers ' + offered.join(', ')); }
        offered.push(button.dataset.theme);
    }
    return theme;
})`;

/**
 * The source of an async function for a page of the viewer `engine`, (pageNumber) => pixels: the
 * drawn canvas of page `pageNumber` as { width, height, data } (getImageData), with colored(x, y),
 * whether a pixel is colored (its channels differ by more than 40), and inImage(x, y), whether a
 * pixel counts as an image's: it is colored, lies outside the text layer's spans (2 px wider on
 * each side), and its eight neighbors are colored too. The colored edges of anti-aliased text change
 * with the text's color, and this leaves them out. It waits up to `limitMs` for the page's text
 * layer: pdf.js adds the element .endOfContent to it once it has rendered it, also when the page
 * has no text, and then reports 'textlayerrendered'.
 */
export const pagePixelsFunction = (engine, limitMs = DRAW_LIMIT_MS) => `(async (pageNumber) => {
    const viewer = ${viewerOf(engine)};
    const view = viewer.getPageView(pageNumber - 1);
    if (!view.div.querySelector('.textLayer .endOfContent')) {
        await new Promise((resolve, reject) => {
            const rendered = (event) => {
                if (event.pageNumber !== pageNumber) { return; }
                clearTimeout(timer);
                viewer.eventBus.off('textlayerrendered', rendered);
                if (event.error) { reject(new Error('the text layer of page ' + pageNumber + ' failed: ' + event.error)); } else { resolve(); }
            };
            const timer = setTimeout(() => { viewer.eventBus.off('textlayerrendered', rendered); reject(new Error('the text layer of page ' + pageNumber + ' was not rendered within ' + ${limitMs} / 1000 + ' s')); }, ${limitMs});
            viewer.eventBus.on('textlayerrendered', rendered);
        });
    }
    const canvas = view.canvas || view.div.querySelector('canvas');
    const { width, height } = canvas;
    const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const colored = (x, y) => { const i = (y * width + x) * 4; return Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 40; };
    const box = canvas.getBoundingClientRect(), sx = width / box.width, sy = height / box.height;
    const text = [...view.div.querySelectorAll('.textLayer span')].map(s => s.getBoundingClientRect()).filter(r => r.width > 0)
        .map(r => [(r.left - box.left) * sx - 2, (r.top - box.top) * sy - 2, (r.right - box.left) * sx + 2, (r.bottom - box.top) * sy + 2]);
    const inText = (x, y) => text.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
    const inImage = (x, y) => {
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1 || inText(x, y)) { return false; }
        for (let dy = -1; dy <= 1; dy++) { for (let dx = -1; dx <= 1; dx++) { if (!colored(x + dx, y + dy)) { return false; } } }
        return true;
    };
    return { width, height, data, colored, inImage };
})`;
