// Reopens the output.pdf tab in the hidden IDE (ide.mjs) and records, from as early as possible,
// the messages from the extension host, pdf.js's page events, and the state of the page in view.
//   node ide/timeline.mjs [--seconds 25] [--tab output.pdf]
// --tab is the start of the tab's label, for another PDF's tab. When the tab is not open, or the
// viewer page does not appear in the new webview, it prints the error and exits with 1.
import { scriptOptions } from '../../lib/options.mjs';
import { ANY_VIEWER, evaluate, instance, INSTANCE_OPTION, reopenTab, sleep, viewerPage, workbench } from './ide.mjs';

const options = scriptOptions({ ...INSTANCE_OPTION, seconds: 'number', tab: 'value' });

const seconds = options.get('seconds', 25);
const wb = await workbench(instance(options));
try {
    const t0 = Date.now();
    const frame = await reopenTab(wb, options.get('tab', 'output.pdf'));
    if (!frame) { throw new Error('the tab is not open, or it did not open again in a new viewer webview'); }
    const log = [];
    const at = () => `${String(Date.now() - t0).padStart(6)} ms`;
    const view = await viewerPage(wb, frame);
    view.session.on('Runtime.consoleAPICalled', (p) => log.push(`${at()} console.${p.type}: ${p.args.map(a => a.value ?? a.description).join(' ').slice(0, 260).replace(/\n/g, ' | ')}`));
    view.session.on('Runtime.exceptionThrown', (p) => log.push(`${at()} exception: ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 260)}`));
    log.push(`${at()} attached to the viewer's webview`);
    // VS Code renames the webview's inner frame from pending-frame to active-frame without an
    // event that DevTools reports, so the script looks for the page's context every 20 ms
    let ctx;
    while (!(ctx = await view.context()) && Date.now() - t0 < 15000) { await sleep(20); }
    if (!ctx) {
        console.log(log.join('\n'));
        throw new Error('the viewer page did not appear in the webview within 15 s');
    }
    log.push(`${at()} the viewer page's context exists`);
    // the host's messages, and pdf.js's events once the event bus exists, in either viewer
    await evaluate(view.session, `(() => {
        window.__tl = [];
        const t0 = performance.now();
        const note = (s) => window.__tl.push(Math.round(performance.now() - t0) + ' ' + s);
        window.addEventListener('message', (e) => { const d = e.data; if (d && typeof d.type === 'string' && d.type !== 'fetchResponse' && d.type !== 'fetchError') note('host -> ' + d.type + (d.output ? ' build ' + d.output.file?.build : '')); });
        const hook = () => {
            const bus = ${ANY_VIEWER}?.eventBus;
            if (!bus) { setTimeout(hook, 20); return; }
            for (const name of ['pagesinit', 'pagesloaded', 'documentloaded', 'pagerender', 'pagerendered', 'scalechanging', 'pagechanging', 'documentinit']) {
                bus.on(name, (x) => note(name + (x?.pageNumber ? ' p' + x.pageNumber : '') + (x?.scale ? ' scale ' + x.scale : '') + (x?.error ? ' error ' + x.error : '')));
            }
            note('event bus hooked');
        };
        hook();
        return true;
    })()`, ctx.id);
    let last = '';
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
        const s = await evaluate(view.session, `(() => { const v = ${ANY_VIEWER}; if (!v || !v.pagesCount) return 'the viewer has not shown a document yet'; const p = v.getPageView(v.currentPageNumber - 1); return 'page ' + v.currentPageNumber + ' state ' + p?.renderingState + ' task ' + !!p?.renderTask + ' doc ' + (v.pdfDocument?.fingerprints?.[0]?.slice(0, 8) ?? '-'); })()`, ctx.id).catch(e => 'evaluation failed: ' + e.message);
        if (s !== last) { log.push(`${at()} ${s}`); last = s; }
        await sleep(100);
    }
    const tl = await evaluate(view.session, `window.__tl`, ctx.id);
    console.log(log.join('\n'));
    console.log('in the page (ms after the hook):');
    console.log(tl.join('\n'));
} finally {
    wb.close();
}
