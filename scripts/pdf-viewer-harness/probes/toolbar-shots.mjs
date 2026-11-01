// Screenshots of a viewer's toolbar at pane widths from 1400 px down to 220 px, the narrowest
// editor pane VS Code allows, with the toolbar's elements that reach past the pane's right edge.
// In the pdfjs viewer it also opens the find bar and the tools menu at each width and lists their
// elements past the edge. The book has --pages pages (default 456), since the page count's digits
// take room in the toolbar.
//   node probes/toolbar-shots.mjs [--ext DIR] [--engine pdfjs|overleaf] [--pages 456] [--out DIR] [--port 8860]
// --out defaults to shots/toolbar-<engine> in the work folder.
import fs from 'node:fs';
import path from 'node:path';
import { book, openHarness, work } from '../common.mjs';
import { scriptOptions } from '../../lib/options.mjs';

const options = scriptOptions({ engine: 'value', ext: 'value', out: 'value', pages: 'number', port: 'number' });

const engine = options.get('engine', 'pdfjs');
const pages = options.get('pages', 456);
const outDir = path.resolve(options.get('out', path.join(work, 'shots', `toolbar-${engine}`)));
fs.mkdirSync(outDir, { recursive: true });
const h = await openHarness({ name: `toolbar-${engine}`, port: options.get('port', 8860), ext: options.get('ext'), bookDir: book(`book-${pages}`, pages, 1), latency: 5, width: 1400, height: 500 });
const { page } = h;
/** the elements in `selector`'s element whose right edge is past the pane's */
const past = (selector) => page.evaluate(`(() => { const w = document.documentElement.clientWidth; const root = document.querySelector(${JSON.stringify(selector)}); return [...root.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > w + 0.5 && getComputedStyle(e).visibility !== 'hidden'; }).map(e => e.id || e.className || e.tagName).slice(0, 6); })()`);
let problems = 0;
try {
    await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=shots-${engine}` });
    await page.useFrame();
    const V = engine === 'overleaf' ? 'window.overleafViewer.wrapper.viewer' : 'window.PDFViewerApplication.pdfViewer';
    await page.waitFor(`${V.replaceAll('.', '?.')}?.getPageView(0)?.renderingState === 3`, 60000);
    for (const width of [1400, 1085, 900, 760, 740, 680, 560, 470, 350, 330, 300, 260, 220]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 500, deviceScaleFactor: 1, mobile: false });
        await new Promise(r => setTimeout(r, 400));
        const results = { toolbar: await past(engine === 'overleaf' ? '#toolbar' : '#toolbarContainer') };
        await page.screenshot(path.join(outDir, `${engine}-${width}.png`));
        if (engine === 'pdfjs') {
            // the find bar and the tools menu, each opened by its button and closed again
            for (const [name, button, popup] of [['find bar', 'viewFindButton', '#findbar'], ['tools menu', 'secondaryToolbarToggleButton', '#secondaryToolbar']]) {
                await page.evaluate(`document.getElementById('${button}').click(); true`);
                await new Promise(r => setTimeout(r, 300));
                results[name] = await past(popup);
                await page.screenshot(path.join(outDir, `${engine}-${width}-${name.replace(' ', '-')}.png`));
                await page.evaluate(`document.getElementById('${button}').click(); true`);
            }
        }
        problems += Object.values(results).reduce((n, list) => n + list.length, 0);
        console.log(`${width} px: past the right edge: ${Object.entries(results).map(([name, list]) => `${name} ${JSON.stringify(list)}`).join(', ')}`);
    }
    console.log(`screenshots in ${outDir}`);
} finally {
    await h.close();
    process.exitCode = problems ? 1 : 0;
}
