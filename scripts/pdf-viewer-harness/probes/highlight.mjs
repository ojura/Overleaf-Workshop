// The Overleaf viewer: where does the highlight of a forward SyncTeX search land, relative to its
// page and to the middle of the viewer?
//   node probes/highlight.mjs [--ext DIR] [--port 8766]
import { notWithinLimit } from '../../lib/devtools.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import { openHarness } from '../common.mjs';

const options = scriptOptions({ ext: 'value', port: 'number' });

const h = await openHarness({ name: 'highlight', port: options.get('port', 8766), ext: options.get('ext'), latency: 20 });
const { page } = h;
try {
    await page.send('Page.navigate', { url: `${h.origin}/page?engine=overleaf&doc=probe` });
    const V = 'window.overleafViewer.wrapper.viewer';
    const HIGHLIGHT = `[...document.querySelectorAll('.pdfViewer > div, .pdfViewer .page > div')].find(d => d.style.backgroundColor === 'rgb(255, 255, 0)')`;
    await page.waitFor(`window.overleafViewer?.wrapper?.viewer?.getPageView(0)?.renderingState === 3`, 60000);
    for (const [pageNo, v] of [[30, 110], [30, 600], [75, 400]]) {
        await page.evaluate(`harness.syncCode([{ page: ${pageNo}, h: 72, v: ${v}, width: 320, height: 14 }]); true`);
        // the highlight is a yellow box in the page's div; the view scrolls to it smoothly
        await page.waitFor(`${HIGHLIGHT} !== undefined`, 10000).catch(notWithinLimit);
        await new Promise(r => setTimeout(r, 1500));
        const m = await page.evaluate(`(() => {
            const c = ${V}.container.getBoundingClientRect();
            const hl = ${HIGHLIGHT};
            if (!hl) { return 'the highlight is missing'; }
            const h = hl.getBoundingClientRect();
            const p = ${V}.getPageView(${pageNo - 1}).div.getBoundingClientRect();
            return { current: ${V}.currentPageNumber, containerTop: Math.round(c.top), containerBottom: Math.round(c.bottom),
                highlightTop: Math.round(h.top), highlightBottom: Math.round(h.bottom), pageTop: Math.round(p.top), pageBottom: Math.round(p.bottom),
                highlightInPage: h.top >= p.top && h.bottom <= p.bottom, centered: Math.abs((h.top + h.bottom) / 2 - (c.top + c.bottom) / 2) < 40 };
        })()`);
        console.log(`box on page ${pageNo} at v=${v}:`, JSON.stringify(m));
    }
} finally {
    await h.close();
}
