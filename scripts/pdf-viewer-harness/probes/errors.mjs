// The Overleaf viewer: five reloads within a few milliseconds (the last build must stay, with one
// document), the line about a build that is gone from the server (BANNER in viewers.mjs), and its
// Recompile button.
// Each of these is a check; the exit status is 1 when one fails (common.mjs's checker).
//   node probes/errors.mjs [--ext DIR] [--port N]
import { notWithinLimit } from '../../lib/devtools.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import { checker, openHarness, shotPath } from '../common.mjs';
import { BANNER, OVERLEAF_DOCUMENTS, pageDrawn, pageInViewDrawn, RENDERING_FINISHED, SHOWN_BUILD, viewerOf } from '../viewers.mjs';

const options = scriptOptions({ ext: 'value', port: 'number' });

const h = await openHarness({ name: 'errors', port: options.get('port'), ext: options.get('ext'), latency: 30 });
const { page } = h;
const { check, summary } = checker();
const problems = [];
page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') { problems.push(`${p.type}: ${p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`); } });
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 200)}`));
try {
    await page.send('Page.navigate', { url: `${h.origin}/page?engine=overleaf&doc=errors-probe` });
    const V = viewerOf('overleaf');
    await page.waitFor(pageDrawn('overleaf', 1), 60000);
    // 1. rapid reloads: b, a, b, a, b within a few ms; the last one must win and leave one document
    await page.evaluate(`window.__start = ${V}.pdfDocument; for (const b of ['b','a','b','a','b']) harness.load(b); true`);
    await page.waitFor(`${V}.pdfDocument !== window.__start && !${OVERLEAF_DOCUMENTS}.loading`, 30000);
    const rapidState = `({ shown: ${SHOWN_BUILD} === harness.builds.b.file.build ? 'b' : 'a', documents: ${OVERLEAF_DOCUMENTS}.owned.size, rendered: ${pageInViewDrawn('overleaf')} })`;
    // the state that the check asks for, or the state after 5 s
    await page.waitFor(`(() => { const r = ${rapidState}; return r.shown === 'b' && r.documents === 1 && r.rendered; })()`, 5000).catch(notWithinLimit);
    const rapid = await page.evaluate(rapidState);
    check('rapid reloads: the last build is shown, drawn, with one document', rapid.shown === 'b' && rapid.documents === 1 && rapid.rendered, JSON.stringify(rapid));
    // 2. a build that is gone from the server (404)
    await page.evaluate(`(() => { const o = structuredClone(harness.builds.b); o.url = o.url.replace('0000000000000002', '00000000000000ff'); o.file.url = o.file.url.replace('0000000000000002', '00000000000000ff'); o.file.build = o.file.build.replace('0000000000000002', '00000000000000ff'); window.postMessage({ type: 'load', output: o }, '*'); return true; })()`);
    // the line about the build (BANNER), with its state and text
    const banner = await page.waitFor(`(() => { const b = ${BANNER}; return b && JSON.stringify({ state: b.dataset.state, text: b.textContent.trim().slice(0, 200) }); })()`, 20000)
        .then(({ value }) => JSON.parse(value), (error) => notWithinLimit(error));
    check('a build that is gone from the server: the page shows a line about it', !!banner, banner ? JSON.stringify(banner) : 'the page did not show a line about the build within 20 s');
    const stillShown = await page.evaluate(`({ pages: ${V}.pagesCount, rendered: ${V}.getPageView(${V}.currentPageNumber - 1)?.renderingState, documents: ${OVERLEAF_DOCUMENTS}.owned.size })`);
    check('after the failed load, the viewer still shows the last build, with one document', stillShown.pages > 0 && stillShown.rendered === RENDERING_FINISHED && stillShown.documents === 1, JSON.stringify(stillShown));
    await page.screenshot(shotPath('errors-missing-build.png'));
    // 3. the Recompile button posts 'recompile'
    const recompile = await page.evaluate(`(() => { const b = [...((${BANNER})?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'Recompile'); if (!b) return 'the line about the build does not offer Recompile'; b.click(); return harness.messages('recompile').length; })()`);
    check('the Recompile button sends one recompile message', recompile === 1, String(recompile));
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    console.log('console problems:', JSON.stringify(problems.slice(0, 12), null, 1));
    summary();
    await h.close();
}
