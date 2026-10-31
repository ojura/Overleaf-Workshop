// The pdfjs viewer: does a build that is in view stay when the host sends it again, does a new
// build still load, and do the zoom buttons and Ctrl+= step by 1.25?
//   node probes/pdfjs-same-build-zoom.mjs [--ext DIR] [--port 8798]
import { arg, openHarness } from '../common.mjs';

const h = await openHarness({ name: 'same-build', port: Number(arg('port', '8798')), ext: arg('ext'), latency: 20 });
const { page, origin } = h;
const problems = [];
page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') { problems.push(p.args.map(a => a.value ?? a.description).join(' ').slice(0, 200)); } });
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 200)}`));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const stats = async () => (await fetch(`${origin}/stats`)).json();
const resetStats = () => fetch(`${origin}/stats/reset`, { method: 'POST' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const A = 'window.PDFViewerApplication';

try {
    await page.send('Page.navigate', { url: `${origin}/frame?engine=pdfjs&doc=same-build` });
    await page.useFrame();
    await page.waitFor(`(() => { try { return ${A}.pdfViewer.getPageView(0).renderingState === 3; } catch { return false; } })()`, 60000);
    await sleep(1500);

    // the host sends the build in view again
    await page.evaluate(`window.__shown = ${A}.pdfDocument; true`);
    await resetStats();
    await page.evaluate(`harness.load('a'); true`);
    await sleep(3000);
    let s = await stats();
    const same = await page.evaluate(`${A}.pdfDocument === window.__shown`);
    check('the same build sent again: the document in view stays', same === true);
    check('the same build sent again: the viewer does not fetch', s.bridgeRequests === 0, `${s.bridgeRequests} bridge requests`);

    // a new build still loads
    await resetStats();
    await page.evaluate(`harness.load('b'); true`);
    await page.waitFor(`${A}.pdfDocument && ${A}.pdfDocument !== window.__shown && ${A}.pdfViewer.getPageView(0)?.renderingState === 3`, 60000);
    s = await stats();
    check('a new build loads', true, `${s.bridgeRequests} bridge requests`);
    // and when it comes again while it is in view, it stays too
    await page.evaluate(`window.__shown = ${A}.pdfDocument; true`);
    await sleep(1000);
    await resetStats();
    await page.evaluate(`harness.load('b'); true`);
    await sleep(3000);
    s = await stats();
    check('build B sent again: the document stays, and the viewer does not fetch', (await page.evaluate(`${A}.pdfDocument === window.__shown`)) === true && s.bridgeRequests === 0, `${s.bridgeRequests} bridge requests`);

    // zoom steps
    await page.evaluate(`${A}.pdfViewer.currentScale = 1; true`);
    await sleep(300);
    await page.evaluate(`document.getElementById('zoomInButton').click(); true`);
    await sleep(300);
    const afterIn = await page.evaluate(`${A}.pdfViewer.currentScale`);
    check('the zoom-in button steps by 1.25', Math.abs(afterIn - 1.25) < 1e-9, `${afterIn}`);
    const box = await page.evaluate(`(() => { const r = ${A}.pdfViewer.container.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    for (const type of ['rawKeyDown', 'keyUp']) {
        await page.send('Input.dispatchKeyEvent', { type, modifiers: 2, key: '=', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187 });
    }
    await sleep(300);
    const afterKey = await page.evaluate(`${A}.pdfViewer.currentScale`);
    check('Ctrl+= steps by 1.25', Math.abs(afterKey - 1.56) < 1e-9, `${afterKey}`);
    await page.evaluate(`document.getElementById('zoomOutButton').click(); true`);
    await sleep(300);
    const afterOut = await page.evaluate(`${A}.pdfViewer.currentScale`);
    check('the zoom-out button steps back by 1.25', Math.abs(afterOut - 1.25) < 1e-9, `${afterOut}`);
    const reachedVsCode = await page.evaluate(`JSON.stringify(harness.messages('did-keydown').filter(e => e.key === '=' && e.ctrl).length)`);
    check('Ctrl+= stays with the viewer, VS Code does not get it', reachedVsCode === '0', `${reachedVsCode} seen by VS Code's listener`);
} finally {
    console.log('console problems:', problems.length ? problems : 'none');
    console.log(results.length && results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
    await h.close();
    process.exitCode = results.length && results.every(Boolean) ? 0 : 1;
}
