// Tests the switch between the two viewers in the hidden IDE (ide.mjs), on the open output.pdf: a
// change of overleaf-workshop.pdfViewer.engine in the instance's settings switches the open PDF to
// the other viewer, and each viewer's button switches to the other one, in the same tab, at the
// same page, and writes the setting. At the end the setting is restored.
//   node ide/drive-switch.mjs
// Open output.pdf in the instance first, for example with Overleaf Workshop's View PDF command.
import { checker, instance, rafOnTimer, settings, sleep, viewerFrames, viewerOf, viewerPage, windowDraws, workbench } from './ide.mjs';

const SETTING = 'overleaf-workshop.pdfViewer.engine';
const inst = instance();
const config = settings(inst);
const original = config.get(SETTING);
const { check, summary } = checker();
const wb = await workbench(inst.port);
let view;
try {
    const draws = await windowDraws(wb);
    console.log(`the window ${draws ? 'draws' : 'does not draw: the viewer pages get a 16 ms timer for requestAnimationFrame'}`);
    const frame = (await viewerFrames(inst.port)).at(-1);
    if (!frame) { throw new Error('the instance does not show a PDF viewer: open output.pdf first'); }
    view = await viewerPage(frame, { beforeLoad: draws ? undefined : rafOnTimer });
    const start = await view.drawn(undefined, 30000);
    if (!start) { throw new Error('the webview does not show a drawn viewer page'); }
    console.log(`output.pdf is in the ${start.engine} viewer; the setting is ${original ?? '(not set)'}`);
    const other = (engine) => (engine === 'pdfjs' ? 'overleaf' : 'pdfjs');
    const pages = await view.E(`${viewerOf(start.engine)}.pagesCount`);

    /** the inner frame's id, which changes when the webview loads a new page */
    const frameId = async () => (await view.context())?.auxData?.frameId;
    /** show page n and wait until it is drawn, and until the viewer has saved its position */
    const goTo = async (engine, n) => {
        const V = viewerOf(engine);
        await view.E(`(() => { const v = ${V}; v.currentPageNumber = ${n}; ${draws ? '' : 'v.update();'} return true; })()`);
        for (let i = 0; i < 300; i++) { if (await view.E(`${V}.getPageView(${n - 1})?.renderingState === 3`)) { break; } await sleep(50); }
        await sleep(800); // the viewers save their position 500 ms after a scroll
    };

    // the setting
    const target = other(start.engine);
    config.set(SETTING, target);
    let now = await view.drawn(target, 90000);
    check(`a change of the setting to ${target} switches the open PDF to the ${target} viewer`, !!now, now ? `${now.ms} ms` : 'timed out');
    if (!now) { throw new Error('the setting did not switch the viewer'); }

    // each viewer's button, at a page of its own: at 60 % and at 35 % of the document
    const buttons = { pdfjs: 'switchViewerButton', overleaf: 'switchViewer' };
    for (const n of [Math.max(1, Math.round(pages * 0.6)), Math.max(1, Math.round(pages * 0.35))]) {
        const from = now.engine;
        const to = other(from);
        await goTo(from, n);
        const before = await view.E(`${viewerOf(from)}.currentPageNumber`);
        const beforeFrame = await frameId();
        await view.E(`document.getElementById('${buttons[from]}').click(); true`);
        now = await view.drawn(to, 90000);
        check(`the ${from} viewer's button switches the PDF to the ${to} viewer, in the same tab`, !!now && (await frameId()) !== beforeFrame, now ? `${now.ms} ms` : 'timed out');
        check(`the setting now says ${to}`, config.get(SETTING) === to, String(config.get(SETTING)));
        if (!now) { throw new Error('the button did not switch the viewer'); }
        await sleep(800);
        const at = await view.E(`${viewerOf(to)}.currentPageNumber`);
        check(`the ${to} viewer opens at the page the ${from} viewer showed`, at === before, `${before} -> ${at}`);
        if (to === 'overleaf') {
            const ranges = await view.E(`Promise.race([${viewerOf('overleaf')}.pdfDocument.getDownloadInfo().then(() => 'whole'), new Promise(r => setTimeout(() => r('ranges'), 2000))])`);
            check('the Overleaf viewer loads the build in ranges', ranges === 'ranges', ranges);
        }
    }
    await goTo(now.engine, 1);
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    // restore the setting, and wait for the viewer it picks
    config.set(SETTING, original);
    const restored = await view?.drawn(original === 'overleaf' ? 'overleaf' : 'pdfjs', 90000);
    console.log(`the setting is ${original ?? '(not set)'} again; the PDF is in the ${restored?.engine ?? 'unknown'} viewer`);
    console.log('console problems in the viewer pages:', view?.problems.length ? view.problems.slice(0, 8) : 'none');
    summary();
    view?.close();
    wb.close();
}
