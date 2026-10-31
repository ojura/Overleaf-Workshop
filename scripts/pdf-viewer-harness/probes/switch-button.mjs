// Does a viewer show the button to the other viewer, and what does a click send the host?
// Saves a screenshot as shots/switch-<engine>.png in the work folder.
//   node probes/switch-button.mjs [--ext DIR] [--engine pdfjs|overleaf] [--port 8850]
import { arg, openHarness, shotPath, themeBook } from '../common.mjs';

const engine = arg('engine', 'pdfjs');
const h = await openHarness({ name: `switch-${engine}`, port: Number(arg('port', '8850')), ext: arg('ext'), bookDir: themeBook(), latency: 5 });
const { page } = h;
try {
    await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=switch-${engine}` });
    await page.useFrame();
    const V = engine === 'overleaf' ? 'window.overleafViewer.wrapper.viewer' : 'window.PDFViewerApplication.pdfViewer';
    await page.waitFor(`${V.replaceAll('.', '?.')}?.getPageView(0)?.renderingState === 3`, 60000);
    const button = engine === 'overleaf' ? `document.getElementById('switchViewer')` : `document.getElementById('switchViewerButton')`;
    const shown = await page.evaluate(`(() => { const b = ${button}; if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), title: b.title, visible: r.width > 0 && r.height > 0 }; })()`);
    console.log('button:', JSON.stringify(shown));
    await page.screenshot(shotPath(`switch-${engine}.png`));
    await page.evaluate(`${button}.click(); true`);
    await new Promise(r => setTimeout(r, 500));
    const sent = await page.evaluate(`JSON.stringify(harness.events.filter(e => e.type === 'switchViewer' || e.type === 'saveState').slice(-3))`);
    console.log('sent to the host:', sent);
} finally {
    await h.close();
}
