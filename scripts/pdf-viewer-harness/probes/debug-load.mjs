// Opens a book in a viewer, waits 8 s, and prints the viewer's state, the stub's last events, the
// page's console messages and the server's errors.
//   node probes/debug-load.mjs [--ext DIR] [--engine pdfjs|overleaf] [--book DIR] [--port N]
// --book is a folder of make_book.py or theme_book.py; the default is the test book of book() in common.mjs.
// It prints what it sees, for a person to read; its exit status says only whether it ran to its end.
import { openHarness } from '../common.mjs';
import { viewerIfAny } from '../viewers.mjs';
import { scriptOptions } from '../../lib/options.mjs';

/** When the probe looks at the viewer, after the navigation: the time it observes, not a wait for a state. */
const LOOK_AFTER_MS = 8000;
const options = scriptOptions({ book: 'value', engine: 'value', ext: 'value', port: 'number' });

const engine = options.get('engine', 'pdfjs');
const h = await openHarness({ name: `debug-${engine}`, port: options.get('port'), ext: options.get('ext'), bookDir: options.get('book'), latency: 5, stderr: 'pipe' });
let serverErrors = '';
h.server.stderr.on('data', d => { serverErrors += d; });
const logs = [];
h.page.on('Runtime.consoleAPICalled', (p) => logs.push(`${p.type}: ${p.args.map(a => a.value ?? a.description).join(' ').slice(0, 400)}`));
h.page.on('Runtime.exceptionThrown', (p) => logs.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 400) ?? p.exceptionDetails.text}`));
try {
    await h.page.send('Page.navigate', { url: `${h.origin}/page?engine=${engine}&doc=debug` });
    // what the probe shows is the state 8 s after the navigation, also when the viewer never draws
    await new Promise(r => setTimeout(r, LOOK_AFTER_MS));
    const V = viewerIfAny(engine);
    console.log('state:', await h.page.evaluate(`JSON.stringify({ pages: ${V}?.pagesCount, r0: ${V}?.getPageView?.(0)?.renderingState, events: window.harness?.events?.slice(-15) })`));
} finally {
    console.log('console:', logs.slice(0, 30).join('\n'));
    console.log('server errors:', serverErrors.slice(0, 1000));
    await h.close();
}
