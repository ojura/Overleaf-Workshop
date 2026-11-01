// The Overleaf viewer: five reloads within a few milliseconds (the last build must stay, with one
// document), the banner for a build that is gone from the server, and the Recompile button.
// Each of these is a check; the exit status is 1 when one fails (common.mjs's checker).
//   node probes/errors.mjs [--ext DIR] [--port 8766]
import { notWithinLimit } from '../../lib/devtools.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import { checker, openHarness, shotPath } from '../common.mjs';

const options = scriptOptions({ ext: 'value', port: 'number' });

const h = await openHarness({ name: 'errors', port: options.get('port', 8766), ext: options.get('ext'), latency: 30 });
const { page } = h;
const { check, summary } = checker();
const problems = [];
page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') { problems.push(`${p.type}: ${p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`); } });
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 200)}`));
try {
    await page.send('Page.navigate', { url: `${h.origin}/page?engine=overleaf&doc=errors-probe` });
    const V = 'window.overleafViewer.wrapper.viewer';
    await page.waitFor(`window.overleafViewer?.wrapper?.viewer?.getPageView(0)?.renderingState === 3`, 60000);
    // 1. rapid reloads: b, a, b, a, b within a few ms; the last one must win and leave one document
    await page.evaluate(`window.__start = ${V}.pdfDocument; for (const b of ['b','a','b','a','b']) harness.load(b); true`);
    await page.waitFor(`${V}.pdfDocument !== window.__start && window.overleafViewer.documents.inFlight === undefined`, 30000);
    await new Promise(r => setTimeout(r, 1500));
    const rapid = await page.evaluate(`({ shown: window.overleafViewer.documents.shownUrl.includes('0000000000000002') ? 'b' : 'a', documents: window.overleafViewer.documents.owned.size, rendered: ${V}.getPageView(${V}.currentPageNumber - 1).renderingState === 3 })`);
    check('rapid reloads: the last build is shown, drawn, with one document', rapid.shown === 'b' && rapid.documents === 1 && rapid.rendered, JSON.stringify(rapid));
    // 2. a build that is gone from the server (404)
    await page.evaluate(`(() => { const o = structuredClone(harness.builds.b); o.url = o.url.replace('0000000000000002', '00000000000000ff'); o.file.url = o.file.url.replace('0000000000000002', '00000000000000ff'); o.file.build = o.file.build.replace('0000000000000002', '00000000000000ff'); window.postMessage({ type: 'load', output: o }, '*'); return true; })()`);
    const banner = await page.waitFor(`(() => { const all = [...document.body.querySelectorAll('*')].filter(e => /no longer|Recompile|could not|failed/i.test(e.textContent) && e.children.length < 4 && e.offsetParent); return all.map(e => e.textContent.trim()).join(' | ').slice(0, 300); })()`, 20000).catch((error) => notWithinLimit(error) ?? { value: 'the page did not show a banner within 20 s' });
    check('a build that is gone from the server: the page shows a banner', banner.value && !banner.value.startsWith('the page did not show'), banner.value);
    const stillShown = await page.evaluate(`({ pages: ${V}.pagesCount, rendered: ${V}.getPageView(${V}.currentPageNumber - 1)?.renderingState, documents: window.overleafViewer.documents.owned.size })`);
    check('after the failed load, the viewer still shows the last build, with one document', stillShown.pages > 0 && stillShown.rendered === 3 && stillShown.documents === 1, JSON.stringify(stillShown));
    await page.screenshot(shotPath('errors-missing-build.png'));
    // 3. the Recompile button posts 'recompile'
    const recompile = await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => /recompile/i.test(b.textContent)); if (!b) return 'the page does not show a Recompile button'; b.click(); return harness.messages('recompile').length; })()`);
    check('the Recompile button sends one recompile message', recompile === 1, String(recompile));
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    console.log('console problems:', JSON.stringify(problems.slice(0, 12), null, 1));
    summary();
    await h.close();
}
