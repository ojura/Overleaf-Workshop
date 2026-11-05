// The Overleaf viewer: is a forward SyncTeX search drawn when it arrives before the first document,
// and when it arrives during a reload? Each is a check; the exit status is 1 when one fails.
//   node probes/pending-highlight.mjs [--ext DIR] [--port N]
import { notWithinLimit } from '../../lib/devtools.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import { checker, openHarness } from '../common.mjs';
import { highlightInView, SYNCTEX_HIGHLIGHT, TWO_FRAMES, viewerOf } from '../viewers.mjs';

const options = scriptOptions({ ext: 'value', port: 'number' });

const h = await openHarness({ name: 'pending-highlight', port: options.get('port'), ext: options.get('ext'), latency: 80 });
const { page } = h;
const { check, summary } = checker();
try {
    const V = viewerOf('overleaf');
    const yellow = `(${SYNCTEX_HIGHLIGHT}) !== undefined`;
    // 1. before the first document: send the search as soon as the stub exists
    await page.send('Page.navigate', { url: `${h.origin}/page?engine=overleaf&doc=pending-probe` });
    await page.waitFor(`!!window.harness && !!window.overleafViewer`, 20000);
    await page.evaluate(`harness.syncCode([{ page: 40, h: 72, v: 300, width: 320, height: 14 }]); true`);
    const first = await page.waitFor(yellow, 20000).then(() => true, (error) => notWithinLimit(error) ?? false);
    // the page that the check reports, once the viewer has scrolled the highlight into view and taken in the scroll
    await page.waitFor(highlightInView('overleaf'), 5000).catch(notWithinLimit);
    await page.evaluate(TWO_FRAMES);
    check('a search that arrives before the first document is drawn', first, `current page ${await page.evaluate(`${V}.currentPageNumber`)}`);
    // 2. during a reload
    await page.evaluate(`window.__old = ${V}.pdfDocument; harness.load('b'); harness.syncCode([{ page: 70, h: 72, v: 300, width: 320, height: 14 }]); true`);
    await page.waitFor(`${V}.pdfDocument !== window.__old`, 30000);
    const second = await page.waitFor(yellow, 20000).then(() => true, (error) => notWithinLimit(error) ?? false);
    await page.waitFor(highlightInView('overleaf'), 5000).catch(notWithinLimit);
    await page.evaluate(TWO_FRAMES);
    check('a search that arrives during a reload is drawn after the swap', second, `current page ${await page.evaluate(`${V}.currentPageNumber`)}`);
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    summary();
    await h.close();
}
