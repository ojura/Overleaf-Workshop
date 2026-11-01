// Does a viewer show the button to the other viewer, and what does a click send the host?
// Saves a screenshot as shots/switch-<engine>.png in the work folder.
//   node probes/switch-button.mjs [--ext DIR] [--engine pdfjs|overleaf] [--port N]
import { notWithinLimit } from '../../lib/devtools.mjs';
import { checker, openHarness, shotPath, themeBook } from '../common.mjs';
import { buttonOf, DEFAULT_ENGINE, ENGINES, otherEngine, pageDrawn } from '../viewers.mjs';
import { scriptOptions } from '../../lib/options.mjs';

const options = scriptOptions({ engine: ENGINES, ext: 'value', port: 'number' });

const engine = options.get('engine', DEFAULT_ENGINE);
const h = await openHarness({ name: `switch-${engine}`, port: options.get('port'), ext: options.get('ext'), bookDir: themeBook(), latency: 5 });
const { page } = h;
const { check, summary } = checker();
try {
    await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=switch-${engine}` });
    await page.useFrame();
    await page.waitFor(pageDrawn(engine, 1), 60000);
    const button = buttonOf(engine, 'switchViewer');
    const shown = await page.evaluate(`(() => { const b = ${button}; if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), title: b.title, visible: r.width > 0 && r.height > 0 }; })()`);
    check('the viewer shows the button to the other viewer', shown?.visible, JSON.stringify(shown));
    await page.screenshot(shotPath(`switch-${engine}.png`));
    await page.evaluate(`${button}.click(); true`);
    // the stub logs the message when the page sends it; 5 s is the last resort for a click that sends none
    await page.waitFor(`harness.events.some(e => e.type === 'switchViewer')`, 5000).catch(notWithinLimit);
    const sent = await page.evaluate(`harness.events.filter(e => e.type === 'switchViewer' || e.type === 'saveState').slice(-3)`);
    const other = otherEngine(engine);
    check(`a click sends the host switchViewer to the ${other} viewer`, sent.some(e => e.type === 'switchViewer' && e.engine === other), JSON.stringify(sent));
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    summary();
    await h.close();
}
