// The Overleaf viewer: is a forward SyncTeX search drawn when it arrives before the first document,
// and when it arrives during a reload?
//   node probes/pending-highlight.mjs [--ext DIR] [--port 8766]
import { notWithinLimit } from '../../lib/devtools.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import { openHarness } from '../common.mjs';

const options = scriptOptions({ ext: 'value', port: 'number' });

const h = await openHarness({ name: 'pending-highlight', port: options.get('port', 8766), ext: options.get('ext'), latency: 80 });
const { page } = h;
try {
    const V = 'window.overleafViewer.wrapper.viewer';
    const yellow = `[...document.querySelectorAll('.page > div, .pdfViewer > div')].some(d => d.style.backgroundColor === 'rgb(255, 255, 0)')`;
    // 1. before the first document: send the search as soon as the stub exists
    await page.send('Page.navigate', { url: `${h.origin}/page?engine=overleaf&doc=pending-probe` });
    await page.waitFor(`!!window.harness && !!window.overleafViewer`, 20000);
    await page.evaluate(`harness.syncCode([{ page: 40, h: 72, v: 300, width: 320, height: 14 }]); true`);
    const first = await page.waitFor(yellow, 20000).then(() => true, (error) => notWithinLimit(error) ?? false);
    await new Promise(r => setTimeout(r, 1500));
    console.log('search before the first document: drawn', first, 'current page', await page.evaluate(`${V}.currentPageNumber`));
    // 2. during a reload
    await page.evaluate(`window.__old = ${V}.pdfDocument; harness.load('b'); harness.syncCode([{ page: 70, h: 72, v: 300, width: 320, height: 14 }]); true`);
    await page.waitFor(`${V}.pdfDocument !== window.__old`, 30000);
    const second = await page.waitFor(yellow, 20000).then(() => true, (error) => notWithinLimit(error) ?? false);
    await new Promise(r => setTimeout(r, 1500));
    console.log('search during a reload: drawn after the swap', second, 'current page', await page.evaluate(`${V}.currentPageNumber`));
} finally {
    await h.close();
}
