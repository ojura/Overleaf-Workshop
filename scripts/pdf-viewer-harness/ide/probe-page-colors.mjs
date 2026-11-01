// Draws page N of the newest viewer in the hidden IDE (ide.mjs) in the default and in the dark
// theme, and prints the canvas sizes, how many of the sampled colored pixels changed between the
// two (with up to eight examples), and the page's drawing operators by kind. The counts are given
// for all colored pixels, and for those that count as an image's: outside the text layer's spans,
// with their eight neighbors colored too. The colored edges of anti-aliased text change with the
// text's color, and they are among the first only.
//   node ide/probe-page-colors.mjs --page N
// When the instance does not show a viewer that draws, it prints the error and exits with 1.
import { scriptOptions } from '../../lib/options.mjs';
import {
    instance, INSTANCE_OPTION, newestViewer, pagePixelsFunction, showPageFunction, switchThemeFunction, workbench,
} from './ide.mjs';

const options = scriptOptions({ ...INSTANCE_OPTION, page: 'number' });

const page = options.get('page');
if (!page) { console.error('usage: node ide/probe-page-colors.mjs --page N'); process.exit(2); }
const wb = await workbench(instance(options));
try {
    const { view, engine, V } = await newestViewer(wb);
    console.log(JSON.stringify(await view.E(`(async () => {
        const v = ${V}; const n = ${page};
        const showPage = ${showPageFunction(engine)};
        const toTheme = ${switchThemeFunction(engine)};
        const pixels = ${pagePixelsFunction(engine)};
        await showPage(n);
        await toTheme(n, 'default'); const a = await pixels(n);
        await toTheme(n, 'dark'); const b = await pixels(n);
        await toTheme(n, 'default');
        const out = { sizes: [a.width + 'x' + a.height, b.width + 'x' + b.height], pairs: [] };
        if (a.width === b.width && a.height === b.height) {
            let sampled = 0, colorful = 0, changedColorful = 0, inImages = 0, changedInImages = 0;
            for (let i = 0; i < a.data.length; i += 4 * 997) {
                const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
                sampled++;
                if (x < 1 || y < 1 || x >= a.width - 1 || y >= a.height - 1 || !a.colored(x, y)) { continue; }
                const p = [a.data[i], a.data[i + 1], a.data[i + 2]], q = [b.data[i], b.data[i + 1], b.data[i + 2]];
                const changed = p.some((value, k) => Math.abs(value - q[k]) > 2);
                colorful++;
                if (changed) { changedColorful++; }
                if (a.inImage(x, y)) { inImages++; if (changed) { changedInImages++; if (out.pairs.length < 8) out.pairs.push(p.join(',') + ' -> ' + q.join(',')); } }
            }
            out.counts = { sampled, colorful, changedColorful, inImages, changedInImages };
        }
        const OPS = globalThis.pdfjsLib.OPS; const names = Object.fromEntries(Object.entries(OPS).map(([k, n]) => [n, k]));
        const ops = await v.getPageView(n - 1).pdfPage.getOperatorList();
        const byKind = {}; ops.fnArray.forEach(f => { byKind[names[f]] = (byKind[names[f]] || 0) + 1; });
        out.ops = byKind;
        return out;
    })()`), null, 1));
} finally {
    wb.close();
}
