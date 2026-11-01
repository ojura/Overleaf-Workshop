// Tests the PDF viewer of the hidden IDE (ide.mjs) on a local PDF, which the viewer reads whole.
// It opens the PDF with Quick Open, as a user would, and checks that the page in view and the
// last page are drawn, that pdf.js 5.1.91 runs in its own worker, that Ctrl+= zooms the PDF by 1.25
// and leaves the window's zoom alone (its devicePixelRatio), that Ctrl+P in the viewer opens Quick Open, and, in the
// pdfjs viewer, that Ctrl+F finds text without asking first. With --theme-book the PDF is the page
// of theme_book.py, and the colors of the dark theme are checked too.
//   node ide/drive-local-pdf.mjs --pdf <path> [--pages N] [--find TEXT] [--theme-book]
// The viewer is the one that overleaf-workshop.pdfViewer.engine picks in the instance; *.pdf is
// associated with it while the script runs (associatePdfs). Test books are in the work folder
// (common.mjs) once a harness script has written them, book/build-a.pdf and book-theme/build-a.pdf;
// for a PDF of a test book, --pages and --find default to what the book's book.json says, and
// --theme-book takes the boxes of the things on the page from there.
import fs from 'node:fs';
import path from 'node:path';
import { scriptOptions } from '../../lib/options.mjs';
import { bookFacts } from '../common.mjs';
import {
    areaColorsFunction, associatePdfs, checker, clickAt, instance, INSTANCE_OPTION, openWithQuickOpen, pressKey, rafOnTimer, settings,
    showPageFunction, sleep, switchThemeFunction, themeColors, THEMES_SETTING, viewerOf, viewerPage, windowDraws, workbench,
} from './ide.mjs';

const options = scriptOptions({ ...INSTANCE_OPTION, pdf: 'value', pages: 'number', find: 'value', 'theme-book': 'flag' });

const pdf = options.get('pdf');
if (!pdf) {
    console.error('usage: node ide/drive-local-pdf.mjs --pdf <path> [--pages N] [--find TEXT] [--theme-book]');
    process.exit(2);
}
// Quick Open finds files by name, so a path that does not exist could open another file of that name
if (!fs.existsSync(path.resolve(pdf))) {
    console.error(`${path.resolve(pdf)} does not exist`);
    process.exit(2);
}
/** what the test book of the PDF says about it (common.mjs), when the PDF is one */
const facts = fs.existsSync(path.join(path.dirname(path.resolve(pdf)), 'book.json')) ? bookFacts(path.dirname(path.resolve(pdf))) : undefined;
const expectedPages = options.get('pages') ?? facts?.pages;
if (!expectedPages) {
    console.error(`--pages N is required: ${path.resolve(pdf)} is not a PDF of a test book with book.json`);
    process.exit(2);
}
const isThemeBook = options.has('theme-book');
if (isThemeBook && !facts?.elements) {
    console.error(`--theme-book needs the page of theme_book.py, whose book.json lists the boxes of its things; ${path.resolve(pdf)} is not that page`);
    process.exit(2);
}
const findText = options.get('find') ?? facts?.text;
const inst = instance(options);
const config = settings(inst);
const restoreAssociation = await associatePdfs(config);
const { check, summary } = checker();
const wb = await workbench(inst);
let view;
try {
    const draws = await windowDraws(wb);
    check('requestAnimationFrame fires in the window', draws);
    const t0 = Date.now();
    let frame;
    try {
        frame = await openWithQuickOpen(wb, path.resolve(pdf));
    } catch (error) {
        check(`${path.resolve(pdf)} opens in the extension's viewer`, false, error.message);
        throw error;
    }
    check(`${path.resolve(pdf)} opens in the extension's viewer`, true, 'Quick Open focused that file, and a new viewer webview opened');
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
        const jump = await E(`(${showPageFunction(engine, 20000)})(${expectedPages})`).then(ms => `${ms} ms`, error => ({ error: error.message }));
        check(`jump to page ${expectedPages}: drawn`, !jump.error, jump.error ?? jump);
    }

    // the dark theme on the page of theme_book.py: the line takes the theme's text color, the
    // background its background color, and the image keeps its colors
    if (isThemeBook) {
        // the most frequent color in the box of each thing on the page, 2 points inside its edges
        const sample = `(() => Object.fromEntries(Object.entries((${areaColorsFunction(engine)})(1, ${JSON.stringify(facts.elements)})).map(([name, list]) => [name, list[0][0]])))()`;
        const toTheme = (theme) => E(`(${switchThemeFunction(engine)})(1, ${JSON.stringify(theme)})`);
        await toTheme('dark');
        const dark = await E(sample);
        // the dark theme's colors as the instance gives them to the viewer: its setting, else the setting's default
        const colors = themeColors('dark', config.get(THEMES_SETTING));
        check('dark theme: background, line and image as expected', dark.background === colors.bgColor && dark.blackLine === colors.fontColor && dark.imageBlue === '#0000ff' && dark.imageGreen === '#00ff00', JSON.stringify(dark));
        await toTheme('default');
    }

    // Ctrl+= zooms the PDF, and VS Code's window keeps its zoom
    const area = await E(`(() => { const r = ${V}.container.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const outer = await wb.E(`(() => { const f = [...document.querySelectorAll('iframe')].map(f => f.getBoundingClientRect()).filter(r => r.width > 200).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return { x: f.left, y: f.top }; })()`);
    const intoViewer = () => clickAt(wb.session, outer.x + area.x, outer.y + area.y);
    await intoViewer();
    await sleep(300);
    const scale0 = await E(`${V}.currentScale`);
    // the IDE zooms its window with Electron's webFrame, which changes the workbench page's
    // devicePixelRatio (View: Zoom In took it from 1 to 1.2) and leaves CSS zoom at 1
    const windowZoom = () => wb.E('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.devicePixelRatio))))');
    const zoom0 = await windowZoom();
    // the viewer's next scale, from pdf.js's event bus; 5 s is the last resort for a key that the viewer does not get
    await E(`(() => { window.__scaleChange = new Promise((resolve) => { ${V}.eventBus.on('scalechanging', (event) => resolve(event.scale), { once: true }); setTimeout(() => resolve(undefined), 5000); }); return true; })()`);
    await pressKey(wb.session, 'Ctrl+=');
    const scale1 = (await E('window.__scaleChange')) ?? scale0;
    check('Ctrl+= in the viewer zooms the PDF by 1.25', Math.abs(scale1 / scale0 - 1.25) < 0.02, `${scale0.toFixed(3)} -> ${scale1.toFixed(3)}`);
    const zoom1 = await windowZoom();
    check('the window keeps its zoom', zoom1 === zoom0, `the workbench's devicePixelRatio ${zoom0} -> ${zoom1}`);
    await E(`(() => { window.__scaleChange = new Promise((resolve) => { ${V}.eventBus.on('scalechanging', (event) => resolve(event.scale), { once: true }); setTimeout(() => resolve(undefined), 5000); }); return true; })()`);
    await pressKey(wb.session, 'Ctrl+-');
    await E('window.__scaleChange');

    // Ctrl+P in the viewer opens Quick Open
    await intoViewer();
    await sleep(300);
    await pressKey(wb.session, 'Ctrl+P');
    // the first Quick Open of a window takes longer
    let quick = false;
    for (let i = 0; i < 30 && !quick; i++) {
        await sleep(100);
        quick = await wb.E(`(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none'; })()`);
    }
    check('Ctrl+P in the viewer opens Quick Open', quick);
    await pressKey(wb.session, 'Escape');
    await sleep(300);

    // find, in a PDF read whole (the pdfjs viewer only)
    if (engine === 'pdfjs') {
        await intoViewer();
        await sleep(200);
        await pressKey(wb.session, 'Ctrl+F');
        await sleep(500);
        const findOpen = await E(`(() => { const b = document.getElementById('findbar'); return !!b && !b.classList.contains('hidden'); })()`);
        check('Ctrl+F in the viewer opens pdf.js\'s find bar', findOpen);
        if (findOpen && !findText) {
            check('find finds a text without asking first', false, 'there is no text to look for: give --find TEXT');
        } else if (findOpen) {
            await view.session.send('Input.insertText', { text: findText });
            await sleep(1500);
            const count = await E(`(() => { const c = PDFViewerApplication.findController; return { matches: c?._matchesCountTotal ?? null, consent: !!document.getElementById('findConsent') }; })()`);
            check(`find finds "${findText}" without asking first (the PDF is read whole)`, (count.matches ?? 0) > 0 && !count.consent, JSON.stringify(count));
            await pressKey(wb.session, 'Escape');
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
