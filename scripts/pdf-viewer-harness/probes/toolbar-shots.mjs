// Screenshots of a viewer's toolbar at pane widths from 1400 px down to 220 px, the narrowest
// editor pane VS Code allows, with the toolbar's elements that reach past the pane's right edge.
// In the pdfjs viewer it also opens the find bar and the tools menu at each width and lists their
// elements past the edge. The book has --pages pages (default 456), since the page count's digits
// take room in the toolbar.
//   node probes/toolbar-shots.mjs [--ext DIR] [--engine pdfjs|overleaf] [--pages 456] [--out DIR] [--port N]
// --out defaults to shots/toolbar-<engine> in the work folder.
import fs from 'node:fs';
import path from 'node:path';
import { book, openHarness, work } from '../common.mjs';
import { notWithinLimit } from '../../lib/devtools.mjs';
import { armResizeWait, pageDrawn, pastRightEdge, popupShown, PDFJS_POPUPS, TOOLBAR } from '../viewers.mjs';
import { scriptOptions } from '../../lib/options.mjs';

const options = scriptOptions({ engine: 'value', ext: 'value', out: 'value', pages: 'number', port: 'number' });

const engine = options.get('engine', 'pdfjs');
const pages = options.get('pages', 456);
const outDir = path.resolve(options.get('out', path.join(work, 'shots', `toolbar-${engine}`)));
fs.mkdirSync(outDir, { recursive: true });
const startWidth = 1400;
const h = await openHarness({ name: `toolbar-${engine}`, port: options.get('port'), ext: options.get('ext'), bookDir: book(`book-${pages}`, pages, 1), latency: 5, width: startWidth, height: 500 });
const { page } = h;
/** the elements in `selector`'s element whose right edge is past the pane's */
const past = (selector) => page.evaluate(pastRightEdge(selector));
let problems = 0;
try {
    await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=shots-${engine}` });
    await page.useFrame();
    await page.waitFor(pageDrawn(engine, 1), 60000);
    let shownWidth = startWidth;
    for (const width of [1400, 1085, 900, 760, 740, 680, 560, 470, 350, 330, 300, 260, 220]) {
        // the viewer lays its toolbar out again after the page's resize event
        await page.evaluate(armResizeWait());
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 500, deviceScaleFactor: 1, mobile: false });
        if (width !== shownWidth && !(await page.evaluate('window.__resized'))) { console.log(`${width} px: the page did not report a resize within 5 s`); }
        shownWidth = width;
        const results = { toolbar: await past(TOOLBAR[engine]) };
        await page.screenshot(path.join(outDir, `${engine}-${width}.png`));
        if (engine === 'pdfjs') {
            // the find bar and the tools menu, each opened by its button and closed again
            for (const [name, button, popup] of PDFJS_POPUPS) {
                await page.evaluate(`document.getElementById('${button}').click(); true`);
                await page.waitFor(popupShown(popup), 5000).catch(notWithinLimit);
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
