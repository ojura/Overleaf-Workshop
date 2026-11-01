// The Overleaf viewer: where does the highlight of a forward SyncTeX search land, relative to its
// page and to the middle of the viewer?
//   node probes/highlight.mjs [--ext DIR] [--port N]
// It prints what it measures, for a person to read; its exit status says only whether it ran to its end.
import { notWithinLimit } from '../../lib/devtools.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import { openHarness } from '../common.mjs';
import { highlightInView, pageDrawn, SYNCTEX_HIGHLIGHT, TWO_FRAMES, viewerOf } from '../viewers.mjs';

const options = scriptOptions({ ext: 'value', port: 'number' });

const h = await openHarness({ name: 'highlight', port: options.get('port'), ext: options.get('ext'), latency: 20 });
const { page } = h;
try {
    await page.send('Page.navigate', { url: `${h.origin}/page?engine=overleaf&doc=probe` });
    const V = viewerOf('overleaf');
    await page.waitFor(pageDrawn('overleaf', 1), 60000);
    for (const [pageNo, v] of [[30, 110], [30, 600], [75, 400]]) {
        await page.evaluate(`harness.syncCode([{ page: ${pageNo}, h: 72, v: ${v}, width: 320, height: 14 }]); true`);
        // the highlight is a yellow box in the page's div; the viewer scrolls it into view, and the
        // probe measures where it lands once it lies in the visible area and the viewer has taken
        // in the scroll, or after 10 s
        await page.waitFor(highlightInView('overleaf'), 10000).catch(notWithinLimit);
        await page.evaluate(TWO_FRAMES);
        const m = await page.evaluate(`(() => {
            const c = ${V}.container.getBoundingClientRect();
            const hl = ${SYNCTEX_HIGHLIGHT};
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
