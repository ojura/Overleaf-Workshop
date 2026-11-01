// The viewer pages, as the harness's scripts read and drive them: expressions, and the sources of
// functions, that run in a viewer page, in headless Chrome (cdp.mjs) and in a webview of the test
// instance (ide/ide.mjs) alike. Each fact about the pages that the scripts use is written here
// once: which viewers there are (the extension's PDF_VIEWER_ENGINES), where a page keeps its viewer
// object (pdf.js's PDFViewer), when a page counts as drawn, the ids of the buttons and toolbars, the
// SyncTeX highlight, how a theme switch waits for the new drawing, and which pixels of a page count
// as an image's.
import fs from 'node:fs';
import path from 'node:path';
import { pdfjsVersion, protocol, repo } from '../viewer-protocol.mjs';

/** The version of pdf.js that package.json pins and the viewers run (scripts/viewer-protocol.mjs). */
export const PDFJS_VERSION = pdfjsVersion;

/** The viewers, by their names in the setting overleaf-workshop.pdfViewer.engine (src/core/viewerProtocol.ts). */
export const ENGINES = [...protocol.PDF_VIEWER_ENGINES];
/** The viewer that the extension shows when the setting names none of ENGINES. */
export const DEFAULT_ENGINE = protocol.DEFAULT_PDF_VIEWER_ENGINE;
/** The setting that picks the viewer. */
export const ENGINE_SETTING = 'overleaf-workshop.pdfViewer.engine';
/** The setting with the viewers' color themes. */
export const THEMES_SETTING = 'overleaf-workshop.pdfViewer.themes';

/** The default of the extension's setting `key`, from where the extension defines it: package.json's contributes.configuration. */
export function settingDefault(key) {
    const { configuration } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).contributes;
    const property = [configuration].flat().map(c => c.properties?.[key]).find(Boolean);
    if (!property || !Object.hasOwn(property, 'default')) { throw new Error(`package.json does not define a default for the setting ${key}`); }
    return property.default;
}

/** The colors that a theme may name instead of #rrggbb (views/pdf-viewer/src/common/theme.ts). */
const NAMED_COLORS = { black: '#000000', white: '#ffffff' };

/**
 * The colors of the color theme `name` that the viewers get, as { fontColor, bgColor } in the form
 * '#rrggbb' in lower case: from `themes`, the setting's value where the caller has one, as in an
 * instance's settings, and else from the setting's default (settingDefault).
 */
export function themeColors(name, themes = settingDefault(THEMES_SETTING)) {
    const theme = (themes ?? settingDefault(THEMES_SETTING))[name];
    if (!theme) { throw new Error(`the setting ${THEMES_SETTING} does not have the theme ${name}`); }
    const color = (value) => NAMED_COLORS[value.toLowerCase()] ?? value.toLowerCase();
    return { fontColor: color(theme.fontColor), bgColor: color(theme.bgColor) };
}
/** The viewer that the extension shows for the setting's value `value` (as the provider picks it). */
export const engineOfSetting = (value) => (protocol.isPdfViewerEngine(value) ? value : DEFAULT_ENGINE);

/**
 * What the page of each viewer has: the global that only that page makes, its viewer object, the
 * ids of its color theme button and of its button to the other viewer, and its toolbar's selector.
 */
const PAGES = {
    pdfjs: { global: 'PDFViewerApplication', viewer: 'window.PDFViewerApplication.pdfViewer', theme: 'themeButton', switchViewer: 'switchViewerButton', toolbar: '#toolbarContainer' },
    overleaf: { global: 'overleafViewer', viewer: 'window.overleafViewer.wrapper.viewer', theme: 'themeToggle', switchViewer: 'switchViewer', toolbar: '#toolbar' },
};
if (JSON.stringify(Object.keys(PAGES).sort()) !== JSON.stringify([...ENGINES].sort())) {
    throw new Error(`viewers.mjs describes the viewers ${Object.keys(PAGES).join(', ')}, and the extension has ${ENGINES.join(', ')} (PDF_VIEWER_ENGINES)`);
}
/** The facts of PAGES about the viewer `engine`; an engine that the extension does not have is refused. */
const pageOf = (engine) => {
    if (!Object.hasOwn(PAGES, engine)) { throw new Error(`not a viewer of the extension: ${engine} (it has ${ENGINES.join(', ')})`); }
    return PAGES[engine];
};

/** The other viewer than `engine`, which a viewer's switch button shows the PDF in: the extension has two. */
export const otherEngine = (engine) => {
    pageOf(engine);
    if (ENGINES.length !== 2) { throw new Error(`the switch buttons go to the other viewer, and the extension has ${ENGINES.length} viewers`); }
    return ENGINES.find(e => e !== engine);
};

/** pdf.js's RenderingStates.FINISHED: the renderingState of a page view whose canvas is drawn. */
export const RENDERING_FINISHED = 3;

/** The viewer object (pdf.js's PDFViewer) of a page that runs the viewer `engine`: an expression for the page. */
export const viewerOf = (engine) => pageOf(engine).viewer;

/** viewerOf(engine), which is undefined while the page has not made its viewer. */
export const viewerIfAny = (engine) => viewerOf(engine).replaceAll('.', '?.');

/** The viewer object of a page that runs any viewer, undefined while the page has not made one. */
export const ANY_VIEWER = `(${ENGINES.map(viewerIfAny).join(' ?? ')})`;

/** Which viewer a page runs: an expression that gives its name in ENGINES, or undefined while the page has not made its viewer. */
export const ENGINE_OF_PAGE = `(${ENGINES.map(engine => `window.${pageOf(engine).global} ? ${JSON.stringify(engine)} : `).join('')}undefined)`;

/**
 * The line above the PDF about its build (views/pdf-viewer/src/common/banner.ts): an expression for
 * its element, null while the page shows none. Its data-state names the build's state, and its
 * buttons what the line offers, as Recompile.
 */
export const BANNER = `document.getElementById('viewer-banner')`;

/** The build that the page shows, which banner.ts writes into the page's data-shown-build: an expression. */
export const SHOWN_BUILD = 'document.documentElement.dataset.shownBuild';

/**
 * The Overleaf viewer's documents (views/pdf-viewer/src/overleaf/documents.ts): `loading`, whether
 * a load is under way, and `owned`, a private field with the worker of each document, which the
 * checks of destroyed documents count.
 */
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
export const BUTTONS = Object.fromEntries(ENGINES.map(engine => [engine, { theme: pageOf(engine).theme, switchViewer: pageOf(engine).switchViewer }]));

/** The button `name` of BUTTONS in the viewer `engine`: an expression that is null when the page does not have it. */
export const buttonOf = (engine, name) => `document.getElementById(${JSON.stringify(BUTTONS[engine][name])})`;

/** The selector of each viewer's toolbar. */
export const TOOLBAR = Object.fromEntries(ENGINES.map(engine => [engine, pageOf(engine).toolbar]));

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

/**
 * Whether the SyncTeX highlight lies in the visible area of the container of the viewer `engine`:
 * an expression. The viewers scroll it there at once, 100 ms after they draw it (showHighlights in
 * views/pdf-viewer/src/common/synctex.ts).
 */
export const highlightInView = (engine) => `(() => { const h = (${SYNCTEX_HIGHLIGHT})?.getBoundingClientRect(); const c = ${viewerIfAny(engine)}?.container.getBoundingClientRect(); return !!h && !!c && h.top >= c.top && h.bottom <= c.bottom; })()`;

/**
 * An expression for a promise that settles two animation frames later. A scroll's event comes in
 * the next frame, and pdf.js updates the viewer's current page in a frame after that event, so
 * after two frames the viewer has taken in a scroll that happened before.
 */
export const TWO_FRAMES = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))';

/**
 * An expression that makes the page wait for its next 'resize' event and two animation frames after
 * it, when the page has laid out again at its new size: it sets window.__resized, a promise of the
 * page's new width, or of undefined when the page has not been resized within `limitMs`. Evaluate
 * it before the change of size, and window.__resized after it.
 */
export const armResizeWait = (limitMs = 5000) => `(() => {
    window.__resized = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ${limitMs});
        addEventListener('resize', () => requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(innerWidth); })), { once: true });
    });
    return true;
})()`;

/** Whether the pop-up of `selector` (PDFJS_POPUPS) is shown: pdf.js hides it with the class hidden. An expression. */
export const popupShown = (selector) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !e.classList.contains('hidden'); })()`;

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
 * The source of an async function for a page of the viewer `engine`, (pageNumber, limitMs) =>
 * whether the viewer shows page `pageNumber` as its current page within `limitMs`: at once, or
 * when pdf.js's event bus reports the change of page ('pagechanging'), as when a viewer that
 * opened restores its saved position.
 */
export const untilPageFunction = (engine) => `((pageNumber, limitMs) => new Promise((resolve) => {
    const viewer = ${viewerOf(engine)};
    if (viewer.currentPageNumber === pageNumber) { resolve(true); return; }
    const changed = (event) => { if (event.pageNumber === pageNumber) { done(true); } };
    const done = (result) => { clearTimeout(timer); viewer.eventBus.off('pagechanging', changed); resolve(result); };
    const timer = setTimeout(() => done(false), limitMs);
    viewer.eventBus.on('pagechanging', changed);
}))`;

/**
 * How long a driver in the IDE waits for a viewer to save its position after a scroll: the
 * viewers send saveState to the host 500 ms after the last scroll, and the host's side, which keeps
 * it for the next viewer of the PDF, is not visible from the page, so this is a wait of a fixed
 * time. A switch with a viewer's button saves the position at once and needs no wait.
 */
export const POSITION_SAVE_MS = 1000;

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
 * The source of a function for a page of the viewer `engine`, (pageNumber, boxes, inset) => colors:
 * for each named box [x0, y0, x1, y1] in PDF points (origin at the bottom left), the three most
 * frequent colors of the drawn canvas's pixels in it, as [['#rrggbb', share], ...] with the share
 * from 0 to 1. Each box is first made smaller by `inset` points on each side, so that the
 * anti-aliased edges of what the box holds stay out.
 */
export const areaColorsFunction = (engine) => `((pageNumber, boxes, inset = 2) => {
    const view = ${viewerOf(engine)}.getPageView(pageNumber - 1);
    const canvas = view.canvas || view.div.querySelector('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const sx = canvas.width / view.viewport.width, sy = canvas.height / view.viewport.height;
    const out = {};
    for (const [name, [x0, y0, x1, y1]] of Object.entries(boxes)) {
        const [ax, ay] = view.viewport.convertToViewportPoint(x0 + inset, y1 - inset);
        const [bx, by] = view.viewport.convertToViewportPoint(x1 - inset, y0 + inset);
        const left = Math.round(Math.min(ax, bx) * sx), top = Math.round(Math.min(ay, by) * sy);
        const width = Math.max(1, Math.round(Math.abs(bx - ax) * sx)), height = Math.max(1, Math.round(Math.abs(by - ay) * sy));
        const data = context.getImageData(left, top, width, height).data;
        const counts = new Map();
        for (let i = 0; i < data.length; i += 4) {
            const color = '#' + [data[i], data[i + 1], data[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
            counts.set(color, (counts.get(color) || 0) + 1);
        }
        out[name] = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([color, n]) => [color, n / (data.length / 4)]);
    }
    return out;
})`;

/**
 * The source of an async function for a page of the viewer `engine`, (pageNumber) => boxes: the
 * box [x0, y0, x1, y1] in the drawn canvas's pixels of each image that page `pageNumber` paints,
 * from pdf.js's operator list of the page. The transform at an image's painting maps the unit
 * square onto the image; the list's transforms, saves and restores, and the matrices of form
 * XObjects make that transform, and pdf.js's repeated and grouped images give each image its own
 * transform after it. Image masks, which pdf.js paints in the fill color, are not images here.
 */
export const imageBoxesFunction = (engine) => `(async (pageNumber) => {
    const view = ${viewerOf(engine)}.getPageView(pageNumber - 1);
    const canvas = view.canvas || view.div.querySelector('canvas');
    const { OPS } = globalThis.pdfjsLib;
    const { fnArray, argsArray } = await view.pdfPage.getOperatorList();
    // m after n: the transform that applies n, then m (PDF's concatenation of a cm onto the CTM)
    const after = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const sx = canvas.width / view.viewport.width, sy = canvas.height / view.viewport.height;
    const boxes = [];
    const add = (m) => {
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => view.viewport.convertToViewportPoint(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
        const xs = corners.map(c => c[0] * sx), ys = corners.map(c => c[1] * sy);
        boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    };
    let ctm = [1, 0, 0, 1, 0, 0];
    const saved = [];
    fnArray.forEach((fn, i) => {
        const args = argsArray[i];
        if (fn === OPS.save) { saved.push(ctm); }
        else if (fn === OPS.restore) { ctm = saved.pop() ?? ctm; }
        else if (fn === OPS.transform) { ctm = after(ctm, args); }
        else if (fn === OPS.paintFormXObjectBegin) { saved.push(ctm); if (args[0]) { ctm = after(ctm, args[0]); } }
        else if (fn === OPS.paintFormXObjectEnd) { ctm = saved.pop() ?? ctm; }
        else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) { add(ctm); }
        else if (fn === OPS.paintImageXObjectRepeat) {
            const [, scaleX, scaleY, positions] = args;
            for (let k = 0; k < positions.length; k += 2) { add(after(ctm, [scaleX, 0, 0, scaleY, positions[k], positions[k + 1]])); }
        } else if (fn === OPS.paintInlineImageXObjectGroup) {
            for (const entry of args[1]) { add(after(ctm, entry.transform)); }
        }
    });
    return boxes;
})`;

/**
 * The source of an async function for a page of the viewer `engine`, (pageNumber) => pixels: the
 * drawn canvas of page `pageNumber` as { width, height, data } (getImageData), with colored(x, y),
 * whether a pixel is colored (its channels differ by more than 40), inImage(x, y), whether a
 * pixel counts as an image's: it is colored, lies outside the text layer's spans (2 px wider on
 * each side), and its eight neighbors are colored too, and inImageBox(x, y), whether a pixel lies
 * in the box of an image that the page paints (imageBoxesFunction), which holds the image's white
 * too. The colored edges of anti-aliased text change with the text's color, and inImage leaves
 * them out. It waits up to `limitMs` for the page's text
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
    const imageBoxes = await (${imageBoxesFunction(engine)})(pageNumber);
    const inImageBox = (x, y) => imageBoxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
    return { width, height, data, colored, inImage, inImageBox, imageBoxes };
})`;
