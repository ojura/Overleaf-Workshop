// Opens a real build in a viewer: the output.pdf of a saved compile response, which the
// extension's bridge fetches from Overleaf's download domain, as the extension host does. The
// download domain serves a build by its URL, without a login. Prints the bridge's exchanges, how
// long the first page took, and the page's console problems.
//   node probes/live.mjs --response <compile-response.json> --project <project id>
//                        [--ext DIR] [--engine pdfjs|overleaf] [--port 8820] [--seconds 60]
// The compile response is the JSON that Overleaf's compile endpoint answers, saved from a compile
// of a project you may compile, such as a private copy for tests; its build stays on the download
// domain for a limited time after the compile.
import path from 'node:path';
import { notWithinLimit } from '../../lib/devtools.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import { checker, openHarness, themeBook } from '../common.mjs';

const options = scriptOptions({ engine: 'value', ext: 'value', port: 'number', project: 'value', response: 'value', seconds: 'number' });

const response = options.get('response');
const project = options.get('project');
if (!response || !project) {
    console.error('usage: node probes/live.mjs --response <compile-response.json> --project <project id> [--engine pdfjs|overleaf]');
    process.exit(2);
}
const engine = options.get('engine', 'pdfjs');
const seconds = options.get('seconds', 60);
// server.mjs reads a book at start; in live mode the pages show the compile response's build
const h = await openHarness({
    name: `live-${engine}`, port: options.get('port', 8820), ext: options.get('ext'), bookDir: themeBook(), latency: 0,
    args: ['--live', path.resolve(response), '--live-project', project], stderr: 'pipe',
});
h.server.stderr.on('data', d => process.stdout.write(String(d)));
const { page } = h;
const { check, summary } = checker();
const logs = [];
page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') { logs.push(`${p.type}: ${p.args.map(a => a.value ?? a.description).join(' ').slice(0, 2500)}`); } });
page.on('Runtime.exceptionThrown', (p) => logs.push(`exception: ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300)}`));
const V = engine === 'overleaf' ? 'window.overleafViewer?.wrapper?.viewer' : 'window.PDFViewerApplication?.pdfViewer';
try {
    // print the tags that Overleaf's loader adds to its errors (OError's _oErrorTags)
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const tags = (e) => { try { return JSON.stringify(e && e._oErrorTags, (k, v) => (v instanceof Uint8Array ? '[' + v.length + ' bytes]' : v)); } catch (x) { return String(x); } };
        for (const name of ['error', 'warn']) {
            const orig = console[name].bind(console);
            console[name] = (...args) => { for (const a of args) { if (a && typeof a === 'object' && a._oErrorTags) { orig('TAGS ' + tags(a)); } } orig(...args); };
        }
    })();` });
    const t0 = Date.now();
    await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=live-${engine}` });
    await page.useFrame();
    const ok = await page.waitFor(`(() => { const v = ${V}; return !!v && v.getPageView(v.currentPageNumber - 1)?.renderingState === 3; })()`, seconds * 1000, 200)
        .then(() => true, (error) => notWithinLimit(error) ?? false);
    check(`the first page is drawn within ${seconds} s`, ok, ok ? `after ${Date.now() - t0} ms` : `still not drawn after ${seconds} s`);
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    console.log(`console problems (${logs.length}):`, logs.slice(0, 12).join('\n'));
    summary();
    await h.close();
}
