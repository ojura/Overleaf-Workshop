// Saves page N of the newest viewer in the hidden IDE (ide.mjs), drawn in the default and in the
// dark theme, as two PNGs at a third of the canvas's size, and prints the page's classes and the
// theme's colors, for a look by eye.
//   node ide/snap-page.mjs --page N [--out PREFIX]
// The files are PREFIX-default.png and PREFIX-dark.png; PREFIX defaults to shots/page-N in the
// work folder (common.mjs). When the instance does not show a viewer that draws, it prints the
// error and exits with 1.
import fs from 'node:fs';
import path from 'node:path';
import { work } from '../common.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import { instance, INSTANCE_OPTION, newestViewer, workbench } from './ide.mjs';

const options = scriptOptions({ ...INSTANCE_OPTION, page: 'number', out: 'value' });

const page = options.get('page');
if (!page) { console.error('usage: node ide/snap-page.mjs --page N [--out PREFIX]'); process.exit(2); }
const prefix = path.resolve(options.get('out', path.join(work, 'shots', `page-${page}`)));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const wb = await workbench(instance(options));
try {
    const { view, engine, V } = await newestViewer(wb);
    const button = engine === 'overleaf' ? `document.getElementById('themeToggle')` : `document.getElementById('themeButton')`;
    const shots = await view.E(`(async () => {
        const v = ${V}; const idx = ${page - 1};
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const drawn = async () => { for (let i = 0; i < 400; i++) { if (v.getPageView(idx)?.renderingState === 3) return true; await sleep(50); } return false; };
        v.currentPageNumber = ${page}; v.update(); await drawn(); await sleep(300);
        const name = () => ${button}.dataset.theme;
        const toTheme = async (t) => { for (let i = 0; i < 4 && name() !== t; i++) { ${button}.click(); await sleep(300); await drawn(); await sleep(300); } };
        const shot = () => { const p = v.getPageView(idx); const c = p.canvas || p.div.querySelector('canvas'); const s = document.createElement('canvas'); s.width = Math.round(c.width / 3); s.height = Math.round(c.height / 3); s.getContext('2d').drawImage(c, 0, 0, s.width, s.height); return { url: s.toDataURL('image/png'), classes: p.div.className, canvasParent: c.parentElement?.className, filter: getComputedStyle(c).filter, pageColors: JSON.stringify(v.pageColors ?? null), theme: JSON.stringify(globalThis.pdfjsViewerColorTheme ?? null) }; };
        await toTheme('default'); const plain = shot();
        await toTheme('dark'); const dark = shot();
        await toTheme('default');
        return { default: plain, dark };
    })()`);
    for (const [theme, s] of Object.entries(shots)) {
        const file = `${prefix}-${theme}.png`;
        fs.writeFileSync(file, Buffer.from(s.url.split(',')[1], 'base64'));
        console.log(file, JSON.stringify({ ...s, url: undefined }));
    }
} finally {
    wb.close();
}
