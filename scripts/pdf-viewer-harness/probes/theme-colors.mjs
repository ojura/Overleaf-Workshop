// Which colors does each color theme change? Draws the page of theme_book.py in a viewer, then
// steps through the themes with the theme button and counts the pixel colors in each element's
// area. Saves a screenshot per theme as shots/theme-<engine>-<theme>.png in the work folder.
//   node probes/theme-colors.mjs [--ext DIR] [--engine pdfjs|overleaf] [--port 8790]
import { arg, openHarness, shotPath, themeBook } from '../common.mjs';

const engine = arg('engine', 'pdfjs');
const h = await openHarness({ name: `theme-${engine}`, port: Number(arg('port', '8790')), ext: arg('ext'), bookDir: themeBook(), latency: 5 });
const { page } = h;
const problems = [];
page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') { problems.push(p.args.map(a => a.value ?? a.description).join(' ').slice(0, 200)); } });
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 200)}`));
await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=theme-${engine}` });
await page.useFrame();
const V = engine === 'overleaf' ? 'window.overleafViewer.wrapper.viewer' : 'window.PDFViewerApplication.pdfViewer';
await page.waitFor(`(() => { try { return ${V}.getPageView(0).renderingState === 3; } catch { return false; } })()`, 60000);

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
const themeName = engine === 'overleaf'
    ? `document.getElementById('themeToggle').dataset.theme`
    : `document.getElementById('themeButton')?.dataset.theme`;
const clickTheme = engine === 'overleaf'
    ? `document.getElementById('themeToggle').click(); true`
    : `document.getElementById('themeButton').click(); true`;

const redrawn = async () => {
    await new Promise(r => setTimeout(r, 300));
    await page.waitFor(`${V}.getPageView(0).renderingState === 3`, 20000);
    await new Promise(r => setTimeout(r, 300));
};
console.log(`theme ${await page.evaluate(themeName)}:`, JSON.stringify(await page.evaluate(sample), null, 1));
for (let i = 0; i < 3; i++) {
    await page.evaluate(clickTheme);
    await redrawn();
    const name = await page.evaluate(themeName);
    console.log(`theme ${name}:`, JSON.stringify(await page.evaluate(sample), null, 1));
    await page.screenshot(shotPath(`theme-${engine}-${name}.png`));
}
console.log('console problems:', problems.length ? problems : 'none');
await h.close();
