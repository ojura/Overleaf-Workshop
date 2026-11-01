// Tests the PDF viewer of the hidden IDE (ide.mjs) on the project's build, output.pdf, which the
// viewer loads in ranges through the extension host. It closes and reopens the output.pdf tab, so
// that the viewer the setting picks opens it, attaches to the viewer page as soon as the webview
// exists, and checks that the page in view is drawn, that pdf.js runs in its own worker in the
// version that package.json pins (PDFJS_VERSION in viewers.mjs),
// that the build is loaded in ranges, and that jumps to page 200 and to the last page draw them.
// With --theme-page N it also draws page N in the default and the dark theme and checks that
// colored pixels of images keep their colors and the white background takes the theme's color;
// pick a page with images for N (find-image-page.mjs lists some). A colored pixel counts as an
// image's when it lies outside the text layer's spans and its eight neighbors are colored too:
// the colored edges of anti-aliased text change with the text's color. At the end the viewer is back
// on page 1, where the extension then keeps it.
//   node ide/drive-build.mjs [--theme-page N]
// Open output.pdf in the instance first, for example with Overleaf Workshop's View PDF command.
import { scriptOptions } from '../../lib/options.mjs';
import {
    checker, instance, INSTANCE_OPTION, pagePixelsFunction, PDFJS_VERSION, POSITION_SAVE_MS, rafOnTimer, reopenTab, settings,
    showPageFunction, sleep, switchThemeFunction, themeColors, THEMES_SETTING, viewerOf, viewerPage, windowDraws, workbench,
} from './ide.mjs';

const options = scriptOptions({ ...INSTANCE_OPTION, 'theme-page': 'number' });

const themePage = options.get('theme-page');
const inst = instance(options);
const { check, summary } = checker();
const wb = await workbench(inst);
let view;
try {
    const draws = await windowDraws(wb);
    console.log(`the window ${draws ? 'draws' : 'does not draw: the viewer page gets a 16 ms timer for requestAnimationFrame'}`);
    const t0 = Date.now();
    const frame = await reopenTab(wb, 'output.pdf');
    check('output.pdf opens again in a new viewer webview', !!frame);
    if (!frame) { throw new Error('the instance does not show an output.pdf tab, or it did not open again'); }
    view = await viewerPage(wb, frame, { beforeLoad: draws ? undefined : rafOnTimer });
    const shown = await view.drawn(undefined, 90000);
    check('the page in view is drawn', !!shown, `${Date.now() - t0} ms after reopening the tab${shown ? `, in the ${shown.engine} viewer` : ''}`);
    if (!shown) { throw new Error('the viewer did not draw the page in view'); }
    const V = viewerOf(shown.engine);
    const E = view.E;
    const info = await E(`(async () => {
        const v = ${V}, d = v.pdfDocument, lib = globalThis.pdfjsLib;
        const whole = await Promise.race([d.getDownloadInfo().then(() => 'the whole file is loaded'), new Promise(r => setTimeout(() => r('only parts are loaded'), 2000))]);
        return { pages: v.pagesCount, page: v.currentPageNumber, whole, version: lib.version, workerPort: lib.GlobalWorkerOptions.workerPort instanceof Worker, fakeWorker: typeof globalThis.pdfjsWorker !== 'undefined' };
    })()`);
    console.log('viewer:', JSON.stringify(info));
    check(`pdf.js ${PDFJS_VERSION} in its own worker`, info.version === PDFJS_VERSION && info.workerPort && !info.fakeWorker);
    check('the build is loaded in ranges', info.whole === 'only parts are loaded');

    /** show page n and wait until it is drawn: the time that took, or the error */
    const goTo = (n) => E(`(${showPageFunction(shown.engine)})(${n})`).then(ms => ({ ms }), error => ({ error: error.message }));
    for (const target of [...new Set([Math.min(200, info.pages), info.pages])]) {
        const jump = await goTo(target);
        check(`jump to page ${target}: drawn`, !jump.error, jump.error ?? `${jump.ms} ms`);
    }

    if (themePage) {
        const toTheme = (theme) => E(`(${switchThemeFunction(shown.engine)})(${themePage}, ${JSON.stringify(theme)})`);
        const shownPage = await goTo(themePage);
        if (shownPage.error) { throw new Error(shownPage.error); }
        // pixels on a grid of about 80 x 120, each with whether it counts as an image's (pagePixelsFunction)
        const sample = `(async () => {
            const { width, height, data, inImage } = await (${pagePixelsFunction(shown.engine)})(${themePage});
            const pts = [];
            for (let y = 2; y < height - 1; y += Math.max(1, Math.floor(height / 120))) {
                for (let x = 2; x < width - 1; x += Math.max(1, Math.floor(width / 80))) {
                    const i = (y * width + x) * 4;
                    pts.push([data[i], data[i + 1], data[i + 2], inImage(x, y)]);
                }
            }
            return pts;
        })()`;
        await toTheme('default');
        const plain = await E(sample);
        await toTheme('dark');
        const dark = await E(sample);
        // the dark theme's background as the instance gives it to the viewer: its setting, else the setting's default
        const darkBackground = themeColors('dark', settings(inst).get(THEMES_SETTING)).bgColor.match(/[0-9a-f]{2}/g).map(h => parseInt(h, 16));
        let kept = 0, changed = 0, white = 0, background = 0;
        plain.forEach(([r, gr, b, inImage], i) => {
            const q = dark[i];
            if (!q) { return; }
            if (inImage) { if (Math.abs(r - q[0]) <= 2 && Math.abs(gr - q[1]) <= 2 && Math.abs(b - q[2]) <= 2) { kept++; } else { changed++; } }
            if (r >= 250 && gr >= 250 && b >= 250) { white++; if (darkBackground.every((value, k) => q[k] === value)) { background++; } }
        });
        check(`dark theme on page ${themePage}: the images' colored pixels keep their colors`, kept > 0 && changed <= kept * 0.02, `${kept} kept, ${changed} changed`);
        check(`dark theme on page ${themePage}: the white background takes the theme's color`, white > 0 && background >= white * 0.9, `${background} of ${white}`);
        await toTheme('default');
    }
    // the extension keeps the view's position; leave it at the start of the document
    await E(`${V}.currentPageNumber = 1; ${V}.container.scrollTop = 0; true`);
    await sleep(POSITION_SAVE_MS);
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    console.log('console problems in the viewer page:', view?.problems.length ? view.problems.slice(0, 8) : 'none');
    summary();
    view?.close();
    wb.close();
}
