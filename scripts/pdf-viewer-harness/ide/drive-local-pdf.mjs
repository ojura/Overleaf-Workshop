// Tests the PDF viewer of the hidden IDE (ide.mjs) on a local PDF, which the viewer reads whole.
// It opens the PDF with Quick Open, as a user would, and checks that the page in view and the
// last page are drawn, that pdf.js 5.1.91 runs in its own worker, that Ctrl+= zooms the PDF by 1.25
// and leaves the window's zoom alone, that Ctrl+P in the viewer opens Quick Open, and, in the
// pdfjs viewer, that Ctrl+F finds text without asking first. With --theme-book the PDF is the page
// of theme_book.py, and the colors of the dark theme are checked too.
//   node ide/drive-local-pdf.mjs --pdf <path> --pages N [--find TEXT] [--theme-book]
// The viewer is the one that overleaf-workshop.pdfViewer.engine picks in the instance; *.pdf is
// associated with it while the script runs (associatePdfs). Test books are in the work folder
// (common.mjs) once a harness script has written them: book/build-a.pdf (120 pages, with the text
// "quick brown") and book-theme/build-a.pdf (1 page, with the text "IIII").
import fs from 'node:fs';
import path from 'node:path';
import { arg } from '../common.mjs';
import {
    associatePdfs, checker, click, instance, key, notWithinLimit, openWithQuickOpen, rafOnTimer, settings, sleep,
    viewerOf, viewerPage, waitUntil, windowDraws, workbench,
} from './ide.mjs';

const pdf = arg('pdf');
const expectedPages = Number(arg('pages'));
if (!pdf || !expectedPages) {
    console.error('usage: node ide/drive-local-pdf.mjs --pdf <path> --pages N [--find TEXT] [--theme-book]');
    process.exit(2);
}
// Quick Open finds files by name, so a path that does not exist could open another file of that name
if (!fs.existsSync(path.resolve(pdf))) {
    console.error(`${path.resolve(pdf)} does not exist`);
    process.exit(2);
}
const isThemeBook = process.argv.includes('--theme-book');
const findText = arg('find', isThemeBook ? 'IIII' : 'quick brown');
const inst = instance();
const restoreAssociation = await associatePdfs(settings(inst));
const { check, summary } = checker();
const wb = await workbench(inst);
let view;
try {
    const draws = await windowDraws(wb);
    check('requestAnimationFrame fires in the window', draws);
    const t0 = Date.now();
    const frame = await openWithQuickOpen(wb, path.resolve(pdf));
    check(`${path.basename(pdf)} opens in the extension's viewer`, !!frame, JSON.stringify(await wb.E(`[...document.querySelectorAll('.tabs-container .tab')].map(t => t.getAttribute('aria-label'))`)));
    if (!frame) { throw new Error('the viewer did not open'); }
    view = await viewerPage(wb, frame, { beforeLoad: draws ? undefined : rafOnTimer });
    const shown = await view.drawn(undefined, 60000);
    check('the page in view is drawn', !!shown, `${Date.now() - t0} ms after Enter in Quick Open${shown ? `, in the ${shown.engine} viewer` : ''}`);
    if (!shown) { throw new Error('the viewer did not draw the page in view'); }
    const { engine } = shown;
    const V = viewerOf(engine);
    const E = view.E;
    const info = await E(`(() => { const v = ${V}; const lib = globalThis.pdfjsLib; return { pages: v.pagesCount, version: lib.version, workerPort: lib.GlobalWorkerOptions.workerPort instanceof Worker, fakeWorker: typeof globalThis.pdfjsWorker !== 'undefined' }; })()`);
    check('pdf.js 5.1.91 in its own worker', info.version === '5.1.91' && info.workerPort && !info.fakeWorker, JSON.stringify(info));
    check(`${expectedPages} pages`, info.pages === expectedPages, `${info.pages}`);

    if (expectedPages > 1) {
        const tJump = Date.now();
        await E(`${V}.currentPageNumber = ${expectedPages}; true`);
        const drawn = await waitUntil(() => E(`${V}.getPageView(${expectedPages - 1})?.renderingState === 3`), { what: `page ${expectedPages} drawn`, limitMs: 20000 })
            .catch(notWithinLimit);
        check(`jump to page ${expectedPages}: drawn`, !!drawn, `${Date.now() - tJump} ms`);
    }

    // the dark theme on the page of theme_book.py: the line takes the theme's text color, the
    // background its background color, and the image keeps its colors
    if (isThemeBook) {
        const areas = { background: [560, 740, 600, 780], blackText: [72, 640, 330, 705], blackLine: [100, 598, 500, 602], redText: [72, 420, 300, 485], imageBlue: [340, 500, 500, 560], imageGreen: [340, 400, 500, 460] };
        const sample = `(() => {
            const view = ${V}.getPageView(0);
            const canvas = view.canvas || view.div.querySelector('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const sx = canvas.width / view.viewport.width, sy = canvas.height / view.viewport.height;
            const out = {};
            for (const [name, [x0, y0, x1, y1]] of Object.entries(${JSON.stringify(areas)})) {
                const [ax, ay] = view.viewport.convertToViewportPoint(x0, y1);
                const [bx, by] = view.viewport.convertToViewportPoint(x1, y0);
                const d = ctx.getImageData(Math.round(Math.min(ax, bx) * sx), Math.round(Math.min(ay, by) * sy), Math.max(1, Math.round(Math.abs(bx - ax) * sx)), Math.max(1, Math.round(Math.abs(by - ay) * sy))).data;
                const counts = new Map();
                for (let i = 0; i < d.length; i += 4) { const k = '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join(''); counts.set(k, (counts.get(k) || 0) + 1); }
                out[name] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
            }
            return out;
        })()`;
        const button = engine === 'overleaf' ? `document.getElementById('themeToggle')` : `document.getElementById('themeButton')`;
        const name = () => E(`${button}?.dataset.theme`);
        const next = async () => { await E(`${button}.click(); true`); await sleep(400); for (let i = 0; i < 100; i++) { if (await E(`${V}.getPageView(0)?.renderingState === 3`)) { break; } await sleep(50); } await sleep(300); };
        let guard = 0;
        while ((await name()) !== 'dark' && guard++ < 4) { await next(); }
        const dark = await E(sample);
        check('dark theme: background, line and image as expected', dark.background === '#4b4b4b' && dark.blackLine === '#fbf0d9' && dark.imageBlue === '#0000ff' && dark.imageGreen === '#00ff00', JSON.stringify(dark));
        while ((await name()) !== 'default' && guard++ < 8) { await next(); }
    }

    // Ctrl+= zooms the PDF, and VS Code's window keeps its zoom
    const area = await E(`(() => { const r = ${V}.container.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const outer = await wb.E(`(() => { const f = [...document.querySelectorAll('iframe')].map(f => f.getBoundingClientRect()).filter(r => r.width > 200).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return { x: f.left, y: f.top }; })()`);
    const intoViewer = () => click(wb.session, outer.x + area.x, outer.y + area.y);
    await intoViewer();
    await sleep(300);
    const scale0 = await E(`${V}.currentScale`);
    await key(wb.session, '=', 'Equal', 187, 2);
    await sleep(500);
    const scale1 = await E(`${V}.currentScale`);
    check('Ctrl+= in the viewer zooms the PDF by 1.25', Math.abs(scale1 / scale0 - 1.25) < 0.02, `${scale0.toFixed(3)} -> ${scale1.toFixed(3)}`);
    const bodyZoom = await wb.E(`getComputedStyle(document.body).zoom || '1'`);
    check('the window keeps its zoom', bodyZoom === '1' || bodyZoom === 'normal', `body zoom ${bodyZoom}`);
    await key(wb.session, '-', 'Minus', 189, 2);
    await sleep(300);

    // Ctrl+P in the viewer opens Quick Open
    await intoViewer();
    await sleep(300);
    await key(wb.session, 'p', 'KeyP', 80, 2);
    // the first Quick Open of a window takes longer
    let quick = false;
    for (let i = 0; i < 30 && !quick; i++) {
        await sleep(100);
        quick = await wb.E(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none'; })()`);
    }
    check('Ctrl+P in the viewer opens Quick Open', quick);
    await key(wb.session, 'Escape', 'Escape', 27);
    await sleep(300);

    // find, in a PDF read whole (the pdfjs viewer only)
    if (engine === 'pdfjs') {
        await intoViewer();
        await sleep(200);
        await key(wb.session, 'f', 'KeyF', 70, 2);
        await sleep(500);
        const findOpen = await E(`(() => { const b = document.getElementById('findbar'); return !!b && !b.classList.contains('hidden'); })()`);
        check('Ctrl+F in the viewer opens pdf.js\'s find bar', findOpen);
        if (findOpen) {
            await view.session.send('Input.insertText', { text: findText });
            await sleep(1500);
            const count = await E(`(() => { const c = PDFViewerApplication.findController; return { matches: c?._matchesCountTotal ?? null, consent: !!document.getElementById('findConsent') }; })()`);
            check(`find finds "${findText}" without asking first (the PDF is read whole)`, (count.matches ?? 0) > 0 && !count.consent, JSON.stringify(count));
            await key(wb.session, 'Escape', 'Escape', 27);
        }
    }
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    console.log('console problems in the viewer page:', view?.problems.length ? view.problems.slice(0, 10) : 'none');
    summary();
    view?.close();
    wb.close();
    restoreAssociation();
}
