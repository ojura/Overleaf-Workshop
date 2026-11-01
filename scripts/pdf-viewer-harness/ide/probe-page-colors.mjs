// Draws page N of the newest viewer in the hidden IDE (ide.mjs) in the default and in the dark
// theme, and prints the canvas sizes, how many of the sampled colored pixels changed between the
// two (with up to eight examples), and the page's drawing operators by kind. The counts are given
// for all colored pixels, and for those that count as an image's: outside the text layer's spans,
// with their eight neighbors colored too. The colored edges of anti-aliased text change with the
// text's color, and they are among the first only.
//   node ide/probe-page-colors.mjs --page N
// When the instance does not show a viewer that draws, it prints the error and exits with 1.
import { arg } from '../common.mjs';
import { instance, newestViewer, workbench } from './ide.mjs';

const page = Number(arg('page'));
if (!page) { console.error('usage: node ide/probe-page-colors.mjs --page N'); process.exit(2); }
const wb = await workbench(instance());
try {
    const { view, engine, V } = await newestViewer(wb);
    const button = engine === 'overleaf' ? `document.getElementById('themeToggle')` : `document.getElementById('themeButton')`;
    console.log(JSON.stringify(await view.E(`(async () => {
        const v = ${V}; const idx = ${page - 1};
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const drawn = async () => { for (let i = 0; i < 400; i++) { if (v.getPageView(idx)?.renderingState === 3) return true; await sleep(50); } return false; };
        v.currentPageNumber = ${page}; v.update(); await drawn(); await sleep(300);
        const name = () => ${button}.dataset.theme;
        const toTheme = async (t) => { for (let i = 0; i < 4 && name() !== t; i++) { ${button}.click(); await sleep(300); await drawn(); await sleep(300); } };
        const grab = () => { const p = v.getPageView(idx); const c = p.canvas || p.div.querySelector('canvas'); return { w: c.width, h: c.height, data: c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data }; };
        await toTheme('default'); const a = grab();
        await toTheme('dark'); const b = grab();
        await toTheme('default');
        const out = { sizes: [a.w + 'x' + a.h, b.w + 'x' + b.h], pairs: [] };
        if (a.w === b.w && a.h === b.h) {
            const colored = (x, y) => { const i = (y * a.w + x) * 4; return Math.max(a.data[i], a.data[i + 1], a.data[i + 2]) - Math.min(a.data[i], a.data[i + 1], a.data[i + 2]) > 40; };
            const pv = v.getPageView(idx), canvas = pv.canvas || pv.div.querySelector('canvas');
            const cr = canvas.getBoundingClientRect(), sx = a.w / cr.width, sy = a.h / cr.height;
            const text = [...pv.div.querySelectorAll('.textLayer span')].map(s => s.getBoundingClientRect()).filter(r => r.width > 0)
                .map(r => [(r.left - cr.left) * sx - 2, (r.top - cr.top) * sy - 2, (r.right - cr.left) * sx + 2, (r.bottom - cr.top) * sy + 2]);
            const inText = (x, y) => text.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
            let n = 0, colorful = 0, changedColorful = 0, inImages = 0, changedInImages = 0;
            for (let i = 0; i < a.data.length; i += 4 * 997) {
                const x = (i / 4) % a.w, y = Math.floor(i / 4 / a.w);
                n++;
                if (x < 1 || y < 1 || x >= a.w - 1 || y >= a.h - 1 || !colored(x, y)) { continue; }
                const p = [a.data[i], a.data[i + 1], a.data[i + 2]], q = [b.data[i], b.data[i + 1], b.data[i + 2]];
                let area = !inText(x, y);
                for (let dy = -1; dy <= 1 && area; dy++) { for (let dx = -1; dx <= 1 && area; dx++) { area = colored(x + dx, y + dy); } }
                const changed = p.some((v, k) => Math.abs(v - q[k]) > 2);
                colorful++;
                if (changed) { changedColorful++; }
                if (area) { inImages++; if (changed) { changedInImages++; if (out.pairs.length < 8) out.pairs.push(p.join(',') + ' -> ' + q.join(',')); } }
            }
            out.counts = { sampled: n, colorful, changedColorful, inImages, changedInImages };
        }
        const OPS = globalThis.pdfjsLib.OPS; const names = Object.fromEntries(Object.entries(OPS).map(([k, n]) => [n, k]));
        const ops = await v.getPageView(idx).pdfPage.getOperatorList();
        const byKind = {}; ops.fnArray.forEach(f => { byKind[names[f]] = (byKind[names[f]] || 0) + 1; });
        out.ops = byKind;
        return out;
    })()`), null, 1));
} finally {
    wb.close();
}
