// Tests the PDF viewer of the hidden IDE (ide.mjs) on the project's build, output.pdf, which the
// viewer loads in ranges through the extension host. It closes and reopens the output.pdf tab, so
// that the viewer the setting picks opens it, attaches to the viewer page as soon as the webview
// exists, and checks that the page in view is drawn, that pdf.js 5.1.91 runs in its own worker,
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
    checker, instance, INSTANCE_OPTION, notWithinLimit, rafOnTimer, reopenTab, sleep, viewerOf, viewerPage,
    waitUntil, windowDraws, workbench,
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
    check('pdf.js 5.1.91 in its own worker', info.version === '5.1.91' && info.workerPort && !info.fakeWorker);
    check('the build is loaded in ranges', info.whole === 'only parts are loaded');

    /** show page n and wait until it is drawn; returns the time taken, or undefined when it is not drawn within limitMs */
    const goTo = async (n, limitMs = 30000) => {
        const t = Date.now();
        await E(`${V}.currentPageNumber = ${n}; ${draws ? '' : `${V}.update();`} true`);
        const done = await waitUntil(() => E(`${V}.getPageView(${n - 1})?.renderingState === 3`), { what: `page ${n} drawn`, limitMs }).catch(notWithinLimit);
        return done && Date.now() - t;
    };
    for (const target of [...new Set([Math.min(200, info.pages), info.pages])]) {
        const ms = await goTo(target);
        check(`jump to page ${target}: drawn`, ms !== undefined, `${ms ?? 'more than 30000'} ms`);
    }

    if (themePage) {
        const button = shown.engine === 'overleaf' ? `document.getElementById('themeToggle')` : `document.getElementById('themeButton')`;
        const themeName = () => E(`${button}?.dataset.theme`);
        const index = themePage - 1;
        await goTo(themePage);
        const nextTheme = async () => {
            await E(`${button}.click(); true`);
            await sleep(400);
            for (let i = 0; i < 200; i++) { if (await E(`${V}.getPageView(${index})?.renderingState === 3`)) { break; } await sleep(50); }
            await sleep(300);
        };
        // pixels on a grid of about 80 x 120, each with whether it counts as an image's
        const sample = `(async () => {
            const p = ${V}.getPageView(${index});
            const c = p.canvas || p.div.querySelector('canvas');
            const g = c.getContext('2d', { willReadFrequently: true });
            const d = g.getImageData(0, 0, c.width, c.height).data;
            const colored = (x, y) => { const i = (y * c.width + x) * 4; return Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 40; };
            // the text layer's spans in canvas pixels, 2 px wider on each side
            for (let i = 0; i < 100 && !p.div.querySelector('.textLayer span'); i++) { await new Promise(r => setTimeout(r, 50)); }
            const cr = c.getBoundingClientRect(), sx = c.width / cr.width, sy = c.height / cr.height;
            const text = [...p.div.querySelectorAll('.textLayer span')].map(s => s.getBoundingClientRect()).filter(r => r.width > 0)
                .map(r => [(r.left - cr.left) * sx - 2, (r.top - cr.top) * sy - 2, (r.right - cr.left) * sx + 2, (r.bottom - cr.top) * sy + 2]);
            const inText = (x, y) => text.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
            const pts = [];
            for (let y = 2; y < c.height - 1; y += Math.max(1, Math.floor(c.height / 120))) {
                for (let x = 2; x < c.width - 1; x += Math.max(1, Math.floor(c.width / 80))) {
                    const i = (y * c.width + x) * 4;
                    let area = !inText(x, y);
                    for (let dy = -1; dy <= 1 && area; dy++) { for (let dx = -1; dx <= 1 && area; dx++) { area = colored(x + dx, y + dy); } }
                    pts.push([d[i], d[i + 1], d[i + 2], area]);
                }
            }
            return pts;
        })()`;
        let guard = 0;
        while ((await themeName()) !== 'default' && guard++ < 4) { await nextTheme(); }
        const plain = await E(sample);
        while ((await themeName()) !== 'dark' && guard++ < 8) { await nextTheme(); }
        const dark = await E(sample);
        let kept = 0, changed = 0, white = 0, background = 0;
        plain.forEach(([r, gr, b, inImage], i) => {
            const q = dark[i];
            if (!q) { return; }
            if (inImage) { if (Math.abs(r - q[0]) <= 2 && Math.abs(gr - q[1]) <= 2 && Math.abs(b - q[2]) <= 2) { kept++; } else { changed++; } }
            if (r >= 250 && gr >= 250 && b >= 250) { white++; if (q[0] === 0x4b && q[1] === 0x4b && q[2] === 0x4b) { background++; } }
        });
        check(`dark theme on page ${themePage}: the images' colored pixels keep their colors`, kept > 0 && changed <= kept * 0.02, `${kept} kept, ${changed} changed`);
        check(`dark theme on page ${themePage}: the white background takes the theme's color`, white > 0 && background >= white * 0.9, `${background} of ${white}`);
        while ((await themeName()) !== 'default' && guard++ < 12) { await nextTheme(); }
    }
    // the extension keeps the view's position; leave it at the start of the document
    await E(`${V}.currentPageNumber = 1; ${V}.container.scrollTop = 0; true`);
    await sleep(1500);
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    console.log('console problems in the viewer page:', view?.problems.length ? view.problems.slice(0, 8) : 'none');
    summary();
    view?.close();
    wb.close();
}
