// Screenshots of a viewer's toolbar at several pane widths, with the toolbar's elements that reach
// past the pane's right edge, and of pdf.js's tools menu at the narrowest width.
//   node probes/toolbar-shots.mjs [--ext DIR] [--engine pdfjs|overleaf] [--out DIR] [--port 8860]
// --out defaults to shots/toolbar-<engine> in the work folder.
import fs from 'node:fs';
import path from 'node:path';
import { arg, openHarness, themeBook, work } from '../common.mjs';

const engine = arg('engine', 'pdfjs');
const outDir = path.resolve(arg('out', path.join(work, 'shots', `toolbar-${engine}`)));
fs.mkdirSync(outDir, { recursive: true });
const h = await openHarness({ name: `toolbar-${engine}`, port: Number(arg('port', '8860')), ext: arg('ext'), bookDir: themeBook(), latency: 5, width: 1400, height: 400 });
const { page } = h;
try {
    await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=shots-${engine}` });
    await page.useFrame();
    const V = engine === 'overleaf' ? 'window.overleafViewer.wrapper.viewer' : 'window.PDFViewerApplication.pdfViewer';
    await page.waitFor(`(() => { try { return ${V}.getPageView(0).renderingState === 3; } catch { return false; } })()`, 60000);
    for (const width of [1400, 1085, 900, 760, 740, 680, 560, 470, 350]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 400, deviceScaleFactor: 1, mobile: false });
        await new Promise(r => setTimeout(r, 500));
        // the toolbar's elements whose right edge is past the pane's
        const overflow = await page.evaluate(`(() => { const bar = document.getElementById(${engine === 'overleaf' ? "'toolbar'" : "'toolbarContainer'"}); const w = document.documentElement.clientWidth; return [...bar.querySelectorAll('button, input, select, span')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > w + 0.5; }).map(e => e.id || e.className).slice(0, 6); })()`);
        console.log(width, 'px: past the right edge:', JSON.stringify(overflow));
        await page.screenshot(path.join(outDir, `${engine}-${width}.png`));
    }
    if (engine === 'pdfjs') {
        await page.evaluate(`document.getElementById('secondaryToolbarToggleButton').click(); true`);
        await new Promise(r => setTimeout(r, 500));
        await page.screenshot(path.join(outDir, `${engine}-350-menu.png`));
    }
    console.log(`screenshots in ${outDir}`);
} finally {
    await h.close();
}
