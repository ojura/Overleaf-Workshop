// Screenshots of the PDF viewers' toolbars in the hidden IDE (ide.mjs) at several window widths,
// down to a pane of 220 px, the narrowest editor pane VS Code allows. It opens a PDF with Quick
// Open in the viewer the setting picks, closes the side bars and the panel so that the PDF's pane
// follows the window's width, and for each width lays the window's page out at that width
// (Emulation.setDeviceMetricsOverride, as hidden-ide.sh's screenshot does). It saves the top 40 px
// of the pane and lists the toolbar's elements that reach past the pane's right edge; in the pdfjs
// viewer also those of the find bar and the tools menu. Then it switches to the other viewer with
// its button, does the same, and switches back. It exits with 1 when an element reaches past.
//   node ide/toolbar-shots.mjs --pdf <path> [--widths 1440,1085,900,760,600,450,340,262] [--out DIR]
// With the side bars closed the pane is 42 px narrower than the window. --out defaults to
// shots/ide-toolbars in the work folder (common.mjs). Like drive-local-pdf.mjs, it associates *.pdf
// with the extension's viewer while it runs; it also restores the viewer setting, which the
// switch buttons write.
import fs from 'node:fs';
import path from 'node:path';
import { work } from '../common.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import {
    armResizeWait, associatePdfs, buttonOf, ENGINE_SETTING, instance, INSTANCE_OPTION, openWithQuickOpen, otherEngine,
    pastRightEdge, PDFJS_POPUPS, popupShown, runCommand, settings, TOOLBAR, viewerPage, whenTruthy, workbench,
} from './ide.mjs';

const options = scriptOptions({ ...INSTANCE_OPTION, pdf: 'value', widths: 'value', out: 'value' });

const pdf = options.get('pdf');
if (!pdf) { console.error('usage: node ide/toolbar-shots.mjs --pdf <path> [--widths ...] [--out DIR]'); process.exit(2); }
// Quick Open finds files by name, so a path that does not exist could open another file of that name
if (!fs.existsSync(path.resolve(pdf))) { console.error(`${path.resolve(pdf)} does not exist`); process.exit(2); }
const widths = options.get('widths', '1440,1085,900,760,600,450,340,262').split(',').map(Number);
const outDir = path.resolve(options.get('out', path.join(work, 'shots', 'ide-toolbars')));
fs.mkdirSync(outDir, { recursive: true });
const inst = instance(options);
const config = settings(inst);
// the switch buttons write the viewer setting; it is restored when the script ends
const restoreEngine = config.guard(ENGINE_SETTING);
const restoreAssociation = await associatePdfs(config);
const wb = await workbench(inst);
let view;
let problems = 0;
try {
    for (const title of ['View: Close All Editors', 'View: Close Primary Side Bar', 'View: Hide Secondary Side Bar', 'View: Hide Panel']) {
        console.log(`${title}: ${await runCommand(wb, title) ? 'ran' : 'not offered by the Command Palette now (the part may be hidden already)'}`);
    }
    const frame = await openWithQuickOpen(wb, path.resolve(pdf));
    view = await viewerPage(wb, frame);
    /** the elements in `selector`'s element whose right edge is past the pane's */
    const past = (selector) => view.E(pastRightEdge(selector));
    /**
     * apply `change` to the window, and wait until the viewer page has laid out at its new size:
     * the workbench lays out the editor and then resizes the webview, whose page gets a resize event
     */
    const resized = async (change) => {
        await view.E(armResizeWait());
        await change();
        if (!(await view.E('window.__resized'))) { console.log('the viewer page did not report a resize within 5 s'); }
    };
    const shots = async (engine) => {
        for (const width of widths) {
            await resized(() => wb.session.send('Emulation.setDeviceMetricsOverride', { width, height: 880, deviceScaleFactor: 1, mobile: false }));
            const rect = await wb.E(`(() => { const f = [...document.querySelectorAll('iframe')].map(f => f.getBoundingClientRect()).filter(r => r.width > 100 && r.height > 100).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return f && { x: f.left, y: f.top, w: f.width, h: f.height }; })()`);
            const results = { toolbar: await past(TOOLBAR[engine]) };
            const s = await wb.session.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: 40, scale: 1 } });
            fs.writeFileSync(path.join(outDir, `${engine}-${width}.png`), Buffer.from(s.data, 'base64'));
            if (engine === 'pdfjs') {
                for (const [name, button, popup] of PDFJS_POPUPS) {
                    await view.E(`document.getElementById('${button}').click(); true`);
                    await view.E(whenTruthy(popupShown(popup), 5000));
                    results[name] = await past(popup);
                    await view.E(`document.getElementById('${button}').click(); true`);
                }
            }
            problems += Object.values(results).reduce((n, list) => n + list.length, 0);
            console.log(`${engine}: window ${width} px, pane ${Math.round(rect.w)} px; past the right edge: ${Object.entries(results).map(([name, list]) => `${name} ${JSON.stringify(list)}`).join(', ')}`);
        }
        await resized(() => wb.session.send('Emulation.clearDeviceMetricsOverride'));
    };
    const first = await view.drawn(undefined, 60000);
    if (!first) { throw new Error('the viewer did not draw the page in view'); }
    console.log(`the ${first.engine} viewer shows the PDF`);
    await shots(first.engine);
    const second = otherEngine(first.engine);
    await view.E(`${buttonOf(first.engine, 'switchViewer')}.click(); true`);
    console.log(`switched to the ${second} viewer:`, !!(await view.drawn(second, 60000)));
    await shots(second);
    await view.E(`${buttonOf(second, 'switchViewer')}.click(); true`);
    console.log(`switched back to the ${first.engine} viewer:`, !!(await view.drawn(first.engine, 60000)));
    console.log(`screenshots in ${outDir}`);
} catch (error) {
    console.log('failed:', String(error?.message ?? error));
    problems++;
} finally {
    await wb.session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    restoreEngine();
    view?.close();
    wb.close();
    restoreAssociation();
    process.exitCode = problems ? 1 : 0;
}
