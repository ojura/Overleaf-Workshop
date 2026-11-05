// The Overleaf viewer after a PDF read whole ('update'), a reload, and a forward SyncTeX jump to
// page 30: prints every 2 s for 16 s the current page, the rendering state of pages 28 to 32 with
// whether their text layer exists, and the number of fetches. Pages that stay unrendered show a
// stall. --steps chooses which of update, load and sync run. The reload loads build A after an
// update, and build B without one, since the viewer keeps a build that is already in view.
//   node probes/stall.mjs [--ext DIR] [--latency 150] [--steps update,load,sync] [--port N]
// It prints what it sees, for a person to read; its exit status says only whether it ran to its end.
import { book, bookFacts, openHarness } from '../common.mjs';
import { OVERLEAF_DOCUMENTS, pageDrawn, viewerOf } from '../viewers.mjs';
import { scriptOptions } from '../../lib/options.mjs';

/** The time between two samples of the pages, and their number. */
const SAMPLE_MS = 2000;
const SAMPLES = 8;
const options = scriptOptions({ ext: 'value', latency: 'number', port: 'number', steps: 'value' });

const bookDir = book();
const h = await openHarness({ name: 'stall', port: options.get('port'), ext: options.get('ext'), bookDir, latency: options.get('latency', 150) });
const { page } = h;
const problems = [];
page.on('Runtime.consoleAPICalled', (p) => problems.push(`${p.type}: ${p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`));
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 300)}`));
try {
    await page.send('Page.navigate', { url: `${h.origin}/page?engine=overleaf&doc=stall` });
    const V = viewerOf('overleaf');
    await page.waitFor(pageDrawn('overleaf', 1), 60000);
    const states = (pages) => page.evaluate(`JSON.stringify([${pages}].map(n => [n, ${V}.getPageView(n - 1)?.renderingState, !!document.querySelector('.page[data-page-number="' + n + '"] .textLayer span')]))`);
    const steps = options.get('steps', 'update,load,sync');
    if (steps.includes('update')) {
        await page.evaluate(`window.__old = ${V}.pdfDocument; harness.update('a'); true`);
        await page.waitFor(`${V}.pdfDocument !== window.__old && ${V}.pagesCount === ${bookFacts(bookDir).pages}`, 60000);
        console.log('after update, current', await page.evaluate(`${V}.currentPageNumber`), await states('1,2'));
    }
    if (steps.includes('load')) {
        const build = steps.includes('update') ? 'a' : 'b';
        await page.evaluate(`window.__old = ${V}.pdfDocument; harness.load('${build}'); true`);
        await page.waitFor(`${V}.pdfDocument !== window.__old && !${OVERLEAF_DOCUMENTS}.loading`, 60000);
        console.log(`after load ${build}, current`, await page.evaluate(`${V}.currentPageNumber`), await states('1,2'));
    }
    if (steps.includes('sync')) {
        await page.evaluate(`harness.syncCode([{ page: 30, h: 72, v: 110, width: 320, height: 14 }]); true`);
    }
    // the samples are what the probe shows, every SAMPLE_MS for SAMPLES samples
    for (let i = 0; i < SAMPLES; i++) {
        await new Promise(r => setTimeout(r, SAMPLE_MS));
        const fetches = await page.evaluate(`harness.messages('fetch').length`);
        console.log(`t+${(i + 1) * SAMPLE_MS / 1000}s current ${await page.evaluate(`${V}.currentPageNumber`)} states ${await states('28,29,30,31,32')} fetches ${fetches}`);
    }
} finally {
    console.log('page messages:', JSON.stringify(problems.slice(-15), null, 1));
    await h.close();
}
