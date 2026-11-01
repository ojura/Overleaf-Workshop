// Does a viewer show the button to the other viewer, and what does a click send the host?
// Saves a screenshot as shots/switch-<engine>.png in the work folder.
//   node probes/switch-button.mjs [--ext DIR] [--engine pdfjs|overleaf] [--port 8850]
import { checker, openHarness, shotPath, themeBook } from '../common.mjs';
import { scriptOptions } from '../../lib/options.mjs';

const options = scriptOptions({ engine: 'value', ext: 'value', port: 'number' });

const engine = options.get('engine', 'pdfjs');
const h = await openHarness({ name: `switch-${engine}`, port: options.get('port', 8850), ext: options.get('ext'), bookDir: themeBook(), latency: 5 });
const { page } = h;
const { check, summary } = checker();
try {
    await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=switch-${engine}` });
    await page.useFrame();
    const V = engine === 'overleaf' ? 'window.overleafViewer.wrapper.viewer' : 'window.PDFViewerApplication.pdfViewer';
    await page.waitFor(`${V.replaceAll('.', '?.')}?.getPageView(0)?.renderingState === 3`, 60000);
    const button = engine === 'overleaf' ? `document.getElementById('switchViewer')` : `document.getElementById('switchViewerButton')`;
    const shown = await page.evaluate(`(() => { const b = ${button}; if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), title: b.title, visible: r.width > 0 && r.height > 0 }; })()`);
    check('the viewer shows the button to the other viewer', shown?.visible, JSON.stringify(shown));
    await page.screenshot(shotPath(`switch-${engine}.png`));
    await page.evaluate(`${button}.click(); true`);
    await new Promise(r => setTimeout(r, 500));
    const sent = await page.evaluate(`harness.events.filter(e => e.type === 'switchViewer' || e.type === 'saveState').slice(-3)`);
    const other = engine === 'overleaf' ? 'pdfjs' : 'overleaf';
    check(`a click sends the host switchViewer to the ${other} viewer`, sent.some(e => e.type === 'switchViewer' && e.engine === other), JSON.stringify(sent));
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    summary();
    await h.close();
}
