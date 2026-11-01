// Which colors does each color theme change? Draws the page of theme_book.py in a viewer, then
// steps through the themes with the theme button and counts the pixel colors in each element's
// area. Saves a screenshot per theme as shots/theme-<engine>-<theme>.png in the work folder.
//   node probes/theme-colors.mjs [--ext DIR] [--engine pdfjs|overleaf] [--port 8790]
// It prints the colors it counts, for a person to read; its exit status says only whether it ran to its end.
import { openHarness, shotPath, themeBook } from '../common.mjs';
import { buttonOf, pageDrawn, switchThemeFunction, viewerOf } from '../viewers.mjs';
import { scriptOptions } from '../../lib/options.mjs';

const options = scriptOptions({ engine: 'value', ext: 'value', port: 'number' });

const engine = options.get('engine', 'pdfjs');
const h = await openHarness({ name: `theme-${engine}`, port: options.get('port', 8790), ext: options.get('ext'), bookDir: themeBook(), latency: 5 });
const { page } = h;
const problems = [];
page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') { problems.push(p.args.map(a => a.value ?? a.description).join(' ').slice(0, 200)); } });
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 200)}`));
await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=theme-${engine}` });
await page.useFrame();
const V = viewerOf(engine);
await page.waitFor(pageDrawn(engine, 1), 60000);

// [x0, y0, x1, y1] in PDF points
const areas = {
    background: [560, 740, 600, 780],
    blackText: [72, 640, 330, 705],
    blackLine: [100, 598, 500, 602],
    blackRect: [80, 545, 260, 565],
    redText: [72, 420, 330, 485],
    imageBlue: [340, 500, 500, 560],
    imageGreen: [340, 400, 500, 460],
    formText: [72, 210, 330, 275],
    formLine: [100, 178, 500, 182],
};
const sample = `(() => {
    const view = ${V}.getPageView(0);
    const canvas = view.canvas || view.div.querySelector('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const sx = canvas.width / view.viewport.width, sy = canvas.height / view.viewport.height;
    const out = {};
    for (const [name, [x0, y0, x1, y1]] of Object.entries(${JSON.stringify(areas)})) {
        const [ax, ay] = view.viewport.convertToViewportPoint(x0, y1);
        const [bx, by] = view.viewport.convertToViewportPoint(x1, y0);
        const left = Math.round(Math.min(ax, bx) * sx), top = Math.round(Math.min(ay, by) * sy);
        const w = Math.max(1, Math.round(Math.abs(bx - ax) * sx)), h = Math.max(1, Math.round(Math.abs(by - ay) * sy));
        const d = ctx.getImageData(left, top, w, h).data;
        const counts = new Map();
        for (let i = 0; i < d.length; i += 4) {
            const key = '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        const total = d.length / 4;
        out[name] = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => c + ' ' + Math.round(100 * n / total) + '%').join(', ');
    }
    return out;
})()`;
console.log(`theme ${await page.evaluate(`${buttonOf(engine, 'theme')}?.dataset.theme`)}:`, JSON.stringify(await page.evaluate(sample), null, 1));
for (let i = 0; i < 3; i++) {
    // the next theme, once page 1 is drawn in it
    const name = await page.evaluate(`(${switchThemeFunction(engine)})(1)`);
    console.log(`theme ${name}:`, JSON.stringify(await page.evaluate(sample), null, 1));
    await page.screenshot(shotPath(`theme-${engine}-${name}.png`));
}
console.log('console problems:', problems.length ? problems : 'none');
await h.close();
