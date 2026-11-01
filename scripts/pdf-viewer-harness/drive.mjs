// Runs a viewer through the harness in headless Chrome, on the test book of book() in common.mjs,
// and prints what it measured and checked; what it checks about the book comes from the book's
// book.json (bookFacts).
//   node drive.mjs [--ext <views/pdf-viewer dir>] [--engine overleaf|pdfjs] [--latency 40] [--frame]
//                  [--port N] [--shots DIR] [--json FILE]
// --ext defaults to the checkout's views/pdf-viewer. --frame runs the page in a same-origin iframe
// with the sandbox and allow lists of VS Code's webview, as VS Code does. The server takes a port
// that is free when the script starts, or the one that --port names. Screenshots go to --shots, by
// default shots/<engine> in the work folder (common.mjs); --json writes the measurements and checks
// to a file.
// The checks find the viewer's objects in the page through viewers.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { clickAt, notWithinLimit, pressKey } from '../lib/devtools.mjs';
import { scriptOptions } from '../lib/options.mjs';
import { launchChrome } from './cdp.mjs';
import { book, bookFacts, checker, defaultExt, startServer, work } from './common.mjs';
import { highlightInView, OVERLEAF_DOCUMENTS, pageDrawn, SYNCTEX_HIGHLIGHT, TWO_FRAMES, viewerIfAny, viewerOf } from './viewers.mjs';

const options = scriptOptions({ ext: 'value', engine: 'value', frame: 'flag', latency: 'number', shots: 'value', port: 'number', json: 'value' });

const ext = path.resolve(options.get('ext', defaultExt));
const engine = options.get('engine', 'overleaf');
const framed = options.has('frame');
const latency = options.get('latency', 40);
const shots = path.resolve(options.get('shots', path.join(work, 'shots', engine)));
const port = options.get('port');
fs.mkdirSync(shots, { recursive: true });

const bookDir = book();
/** the book's pages, `text`, which every page holds, and `chapters` */
const facts = bookFacts(bookDir);
const { origin, stop: stopServer } = await startServer({ name: `drive-${engine}`, port, ext, bookDir, latency });

// a measurement follows a wait that fails the run when it does not end, so it is not a check of its own
const { check, measure, summary, results } = checker();
const metrics = {};
const stats = async () => (await fetch(`${origin}/stats`)).json();
const resetStats = () => fetch(`${origin}/stats/reset`, { method: 'POST' });
const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;
const traffic = (s) => `${s.bridgeRequests} bridge requests, ${mb(s.bridgeBytes)} through the bridge; server: ${s.outputRequests} output requests (${s.outputWholeRequests} whole), ${s.contentRequests} pieces, ${mb(s.outputBytes + s.contentBytes)}`;

const VIEWER = viewerIfAny(engine);
/** the same, for assignments */
const V = viewerOf(engine);
const rendered = (page) => pageDrawn(engine, page);

/** The last resort for a state that the viewer reaches at once after an action, such as a scale after a key. */
const STATE_LIMIT_MS = 5000;
/** The last resort for the viewer's saveState, which it sends 500 ms after the last scroll. */
const SAVE_LIMIT_MS = 5000;
/** How long the Ctrl+S check watches for a download through the bridge: a window to observe, not a wait for a state. */
const DOWNLOAD_WINDOW_MS = 3000;
/** How long the find measurement watches what a search downloads: the measurement itself. */
const FIND_WINDOW_MS = 10000;

const { page, close } = await launchChrome({ dir: work });
/**
 * The value of `expression` once `condition` holds in the page, or at STATE_LIMIT_MS when it does
 * not: for the checks of a state that an action brings about.
 */
const once = async (condition, expression) => {
    await page.waitFor(condition, STATE_LIMIT_MS).catch(notWithinLimit);
    return page.evaluate(expression);
};
/** Whether VS Code's key listener in the stub saw Ctrl with the key `k` (and Shift when `shift`): an expression. */
const keySeen = (k, shift) => `harness.messages('did-keydown').some(e => e.key.toLowerCase() === ${JSON.stringify(k)} && e.ctrl && e.shift === ${shift})`;
const problems = [];
page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning' || p.type === 'warn') {
        problems.push(`${p.type}: ${p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
    }
});
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 300) ?? p.exceptionDetails.text}`));
await page.send('Runtime.enable');
await page.send('Page.enable');

try {
    // the page must exist: dist/ is built per checkout (node scripts/build-pdf-viewer.mjs)
    const probe = await fetch(`${origin}/page?engine=${engine}&doc=book`);
    if (!probe.ok) { throw new Error(`the ${engine} page is missing: ${probe.status} ${await probe.text()}`); }
    // 1. first page of build A
    await resetStats();
    await page.send('Page.navigate', { url: `${origin}/${framed ? 'frame' : 'page'}?engine=${engine}&doc=book` });
    if (framed) { await page.useFrame(); }
    const first = await page.waitFor(rendered(1), 60000);
    let s = await stats();
    measure('build A: first page rendered', `${first.ms} ms after navigation; ${traffic(s)}`);
    metrics.firstPageMs = first.ms; metrics.firstPageBridgeMB = +(s.bridgeBytes / 1048576).toFixed(2);
    check('build A: the whole file was not requested', s.outputWholeRequests === 0);
    await page.screenshot(path.join(shots, '1-first-page.png'));
    const pages = await page.evaluate(`${VIEWER}.pagesCount`);
    check(`build A: ${facts.pages} pages`, pages === facts.pages, `${pages}`);

    // 2. read on at page 60
    await resetStats();
    const saves = await page.evaluate(`harness.messages('saveState').length`);
    await page.evaluate(`${V}.currentPageNumber = 60; ${V}.container.scrollTop += 250; true`);
    const p60 = await page.waitFor(rendered(60), 30000);
    s = await stats();
    measure('page 60 rendered', `${p60.ms} ms; ${traffic(s)}`);
    metrics.page60Ms = p60.ms; metrics.page60BridgeMB = +(s.bridgeBytes / 1048576).toFixed(2);
    // the viewer saves the position 500 ms after the last scroll, with a saveState to the host
    await page.waitFor(`harness.messages('saveState').length > ${saves}`, SAVE_LIMIT_MS);
    /**
     * the page in view and its offset, after pdf.js's start-up fetch of the pages (pagesPromise),
     * which gives each page that it fetches its own size and so moves the pages below; when the
     * viewer loads in ranges (disableAutoFetch), it ends after the first page
     */
    const where = `${VIEWER}.pagesPromise.then(() => { const v = ${VIEWER}; const n = v.currentPageNumber; const div = v.getPageView(n - 1).div; return { page: n, px: Math.round(v.container.scrollTop - div.offsetTop), scale: v.currentScale }; })`;
    const beforePx = await page.evaluate(where);
    const before = await page.evaluate(engine === 'overleaf' ? 'window.overleafViewer.wrapper.currentPosition' : 'null');
    await page.screenshot(path.join(shots, '2-page-60.png'));

    // 3. a new build: B
    await resetStats();
    // the page notes at each frame, until it shows the new document, whether it shows a document
    // with a page canvas: the old pages must stay on screen until the new build replaces them
    await page.evaluate(`(() => {
        const old = window.__oldDoc = ${VIEWER}.pdfDocument;
        const kept = window.__kept = { frames: 0, empty: 0 };
        const look = () => {
            const shown = ${VIEWER}?.pdfDocument;
            if (shown && shown !== old) { return; }
            kept.frames++;
            if (!shown || document.querySelectorAll('.page canvas').length === 0) { kept.empty++; }
            requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
        return true;
    })()`);
    const t0 = Date.now();
    await page.evaluate(`harness.load('b'); true`);
    await page.waitFor(`${VIEWER}.pdfDocument && ${VIEWER}.pdfDocument !== window.__oldDoc`, 60000);
    const swapped = Date.now() - t0;
    const kept = await page.evaluate('window.__kept');
    check('reload: the old pages stay while the new build loads', kept.frames > 0 && kept.empty === 0, `${kept.frames} frames before the swap, ${kept.empty} of them without a page canvas`);
    await page.waitFor(rendered(60), 30000);
    const reloadMs = Date.now() - t0;
    s = await stats();
    measure('reload: page 60 of build B rendered', `swap after ${swapped} ms, rendered after ${reloadMs} ms; ${traffic(s)}`);
    metrics.reloadSwapMs = swapped; metrics.reloadRenderedMs = reloadMs; metrics.reloadBridgeMB = +(s.bridgeBytes / 1048576).toFixed(2); metrics.reloadServerMB = +((s.outputBytes + s.contentBytes) / 1048576).toFixed(2);
    check('reload: the image pieces come from the piece cache', s.contentRequests === 0, `${s.contentRequests} pieces from the server`);
    const afterPx = await page.evaluate(where);
    check('reload: same page, same offset on screen', beforePx.page === afterPx.page && Math.abs(beforePx.px - afterPx.px) <= 2 && Math.abs(beforePx.scale - afterPx.scale) < 0.001,
        `before p${beforePx.page} +${beforePx.px}px at ${beforePx.scale.toFixed(3)}, after p${afterPx.page} +${afterPx.px}px at ${afterPx.scale.toFixed(3)}`);
    const after = await page.evaluate(engine === 'overleaf' ? 'window.overleafViewer.wrapper.currentPosition' : 'null');
    if (before && after) {
        const same = before.page === after.page && Math.abs(before.offset.top - after.offset.top) < 2;
        check('reload: the reading position is kept', same, `before p${before.page + 1} top ${before.offset.top.toFixed(1)}, after p${after.page + 1} top ${after.offset.top.toFixed(1)}`);
    }
    if (engine === 'overleaf') {
        const alive = await once(`${OVERLEAF_DOCUMENTS}.owned.size === 1`, `${OVERLEAF_DOCUMENTS}.owned.size`);
        check('reload: the old document was destroyed', alive === 1, `${alive} document(s) with a worker`);
    }
    await page.screenshot(path.join(shots, '3-after-reload.png'));

    // 4. a PDF read whole ('update')
    await resetStats();
    await page.evaluate(`window.__oldDoc = ${VIEWER}.pdfDocument; harness.update('a'); true`);
    await page.waitFor(`${VIEWER}.pdfDocument && ${VIEWER}.pdfDocument !== window.__oldDoc && ${VIEWER}.pagesCount === ${facts.pages}`, 60000);
    await page.waitFor(rendered(await page.evaluate(`${VIEWER}.currentPageNumber`)), 30000);
    s = await stats();
    measure('update: a PDF read whole is shown', traffic(s));
    if (engine === 'overleaf') {
        const alive = await once(`${OVERLEAF_DOCUMENTS}.owned.size === 1`, `${OVERLEAF_DOCUMENTS}.owned.size`);
        check('update: the replaced document was destroyed', alive === 1, `${alive} document(s) with a worker`);
    }
    // back to a build in ranges
    await page.evaluate(`harness.load('a'); true`);
    await page.waitFor(`${VIEWER}.pdfDocument && ${VIEWER}.pagesCount === ${facts.pages}${engine === 'overleaf' ? ` && ${OVERLEAF_DOCUMENTS}.inFlight === undefined` : ''}`, 60000);

    // 5. SyncTeX from the source: a highlight on page 30
    await page.evaluate(`harness.syncCode([{ page: 30, h: 72, v: 110, width: 320, height: 14 }]); true`);
    const highlight = await page.waitFor(`(${SYNCTEX_HIGHLIGHT}) !== undefined`, 10000).catch(notWithinLimit);
    check('forward SyncTeX: the highlight is drawn', !!highlight);
    // the viewer scrolls the highlight into view 100 ms after it drew it: once it lies in the
    // viewer's visible area, and the viewer has taken in the scroll
    const inView = await page.waitFor(highlightInView(engine), STATE_LIMIT_MS).catch(notWithinLimit);
    await page.evaluate(TWO_FRAMES);
    const at = await page.evaluate(`${VIEWER}.currentPageNumber`);
    check('forward SyncTeX: the highlight is scrolled into view', !!inView && Math.abs(at - 30) <= 1, `${inView ? 'in the visible area' : 'not in the visible area'}, current page ${at}`);
    await page.screenshot(path.join(shots, '5-synctex-highlight.png'));

    // 6. SyncTeX to the source: double-click a word
    const states = () => page.evaluate(`JSON.stringify({ current: ${VIEWER}.currentPageNumber, pages: [${at - 2},${at - 1},${at},${at + 1}].map(n => [n, ${VIEWER}.getPageView(n - 1)?.renderingState]), fetches: harness.messages('fetch').length, scrollTop: Math.round(${VIEWER}.container.scrollTop) })`);
    const text = await page.waitFor(`document.querySelector('.page[data-page-number="${at}"] .textLayer span')`, 15000).catch(async (e) => { console.log('  diagnostics:', await states()); throw e; });
    const dbl = await page.evaluate(`(() => {
        const span = [...document.querySelectorAll('.page[data-page-number="${at}"] .textLayer span')].find(s => s.textContent.includes(${JSON.stringify(facts.text)}));
        if (!span) { return ${JSON.stringify(`the text layer does not contain "${facts.text}"`)}; }
        const r = span.getBoundingClientRect();
        const before = harness.messages('syncPdf').length;
        span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 5, clientY: r.top + r.height / 2 }));
        const sent = harness.messages('syncPdf');
        return sent.length > before ? JSON.stringify(sent.at(-1).content) : 'the page did not send syncPdf';
    })()`);
    check('inverse SyncTeX: a double-click sends syncPdf', dbl.startsWith('{'), dbl);

    // 7. the outline
    if (engine === 'overleaf') {
        await page.evaluate(`document.getElementById('outlineToggle').click(); true`);
        const items = await page.waitFor(`document.querySelectorAll('#outline .outline-item').length`, 10000);
        check('outline: the chapters are listed', items.value === facts.chapters.length, `${items.value} items`);
        await page.evaluate(`document.querySelectorAll('#outline .outline-item')[2].click(); true`);
        const ch3 = await page.waitFor(`${VIEWER}.currentPageNumber === ${facts.chapters[2].page}`, 10000).catch(notWithinLimit);
        check('outline: a chapter opens its page', !!ch3, `page ${await page.evaluate(`${VIEWER}.currentPageNumber`)}`);
        await page.waitFor(rendered(facts.chapters[2].page), 30000).catch(notWithinLimit);
        await page.screenshot(path.join(shots, '7-outline.png'));
        await page.evaluate(`document.getElementById('outlineToggle').click(); true`);
    }

    // 8. zoom keys
    const zoomBefore = await page.evaluate(`${VIEWER}.currentScale`);
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true })); true`);
    const zoomIn = await once(`${VIEWER}.currentScale > ${zoomBefore} * 1.05`, `${VIEWER}.currentScale`);
    check('Ctrl+= zooms in', zoomIn > zoomBefore * 1.05, `${zoomBefore.toFixed(3)} -> ${zoomIn.toFixed(3)}`);
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '9', ctrlKey: true, bubbles: true })); true`);
    const fitHeight = await once(`${VIEWER}.currentScaleValue === 'page-height'`, `${VIEWER}.currentScaleValue`);
    check('Ctrl+9 fits the page height', fitHeight === 'page-height', fitHeight);
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true })); true`);
    const fitWidth = await once(`${VIEWER}.currentScaleValue === 'page-width'`, `${VIEWER}.currentScaleValue`);
    check('Ctrl+0 fits the page width', fitWidth === 'page-width', fitWidth);
    await page.screenshot(path.join(shots, '8-zoom.png'));

    // 9. keys that belong to VS Code: do they reach VS Code's listener, and does Ctrl+S download the PDF?
    // a click in the viewer gives it the focus; the iframe of --frame fills the page, so the
    // viewer's coordinates are the page's
    const box = await page.evaluate(`(() => { const r = ${VIEWER}.container.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await clickAt(page, box.x, box.y);
    await resetStats();
    await pressKey(page, 'Ctrl+P');
    const ctrlP = await once(keySeen('p', false), keySeen('p', false));
    check('Ctrl+P (Quick Open) reaches VS Code', ctrlP);
    await pressKey(page, 'Ctrl+Shift+P');
    const ctrlShiftP = await once(keySeen('p', true), keySeen('p', true));
    check('Ctrl+Shift+P (Command Palette) reaches VS Code', ctrlShiftP);
    const zoomBeforeKey = await page.evaluate(`${VIEWER}.currentScale`);
    await pressKey(page, 'Ctrl+=');
    const zoomed = (await once(`${VIEWER}.currentScale > ${zoomBeforeKey} * 1.05`, `${VIEWER}.currentScale`)) > zoomBeforeKey * 1.05;
    // the key's dispatch has ended once the viewer has zoomed, so VS Code's listener has seen it by then if it gets it
    const ctrlEqToVSCode = await page.evaluate(keySeen('=', false));
    check('Ctrl+= zooms the PDF (trusted key event)', zoomed);
    check('Ctrl+= stays with the viewer (VS Code would zoom its window too)', !ctrlEqToVSCode);
    await pressKey(page, 'Ctrl+0');
    await once(`${VIEWER}.currentScaleValue === 'page-width'`, 'true');
    await pressKey(page, 'Ctrl+S');
    const ctrlS = await once(keySeen('s', false), keySeen('s', false));
    await new Promise(r => setTimeout(r, DOWNLOAD_WINDOW_MS));
    s = await stats();
    check('Ctrl+S reaches VS Code', ctrlS);
    check('Ctrl+S does not download the PDF through the bridge', s.bridgeBytes < 8 * 1048576 && s.outputWholeRequests === 0, traffic(s));
    metrics.keys = { ctrlP, ctrlShiftP, ctrlEqToVSCode, ctrlSBridgeMB: +(s.bridgeBytes / 1048576).toFixed(2) };
    await pressKey(page, 'Escape');

    // 10. pdf.js's viewer only: what a search downloads
    if (engine === 'pdfjs') {
        await resetStats();
        await page.evaluate(`${V}.eventBus.dispatch('find', { source: window, type: '', query: 'zebra', caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false }); true`);
        await page.waitFor(`!!document.getElementById('findConsent')`, STATE_LIMIT_MS).catch(notWithinLimit);
        const consent = await page.evaluate(`(() => { const bar = document.getElementById('findConsent'); if (!bar) { return null; } const text = bar.textContent.trim().slice(0, 160); bar.querySelector('button')?.click(); return text; })()`);
        check('find: the viewer asks before a search downloads the PDF', consent !== null, consent ?? 'the viewer searched without asking');
        await new Promise(r => setTimeout(r, FIND_WINDOW_MS));
        s = await stats();
        measure(`find: what a search for a missing word downloads in ${FIND_WINDOW_MS / 1000} s`, traffic(s));
        metrics.find10sBridgeMB = +(s.bridgeBytes / 1048576).toFixed(2);
    }

    // 11. the saved state reached the host
    const saved = await (await fetch(`${origin}/state?doc=book`)).json();
    check('state: zoom and position were saved for the host', saved?.scale === 'page-width' && saved?.position?.page >= 0, JSON.stringify({ scale: saved?.scale, page: saved?.position?.page }));
} catch (error) {
    check('run', false, String(error?.stack ?? error));
    await page.screenshot(path.join(shots, 'failure.png')).catch((error) => console.log(`the screenshot of the failure could not be taken: ${error.message}`));
} finally {
    console.log(`\nconsole errors and warnings in the page (${problems.length}):`);
    for (const p of [...new Set(problems)].slice(0, 30)) { console.log(`  ${p}`); }
    const failed = results.filter(r => !r.ok).length;
    const jsonFile = options.get('json');
    if (jsonFile) { fs.writeFileSync(jsonFile, JSON.stringify({ engine, framed, latency: Number(latency), metrics, results, problems: [...new Set(problems)] }, null, 1)); }
    console.log(`\n${results.length - failed} passed, ${failed} failed; screenshots in ${shots}`);
    summary();
    await close();
    await stopServer();
}
