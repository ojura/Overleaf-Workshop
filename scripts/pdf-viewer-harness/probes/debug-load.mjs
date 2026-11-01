// Opens a book in a viewer, waits 8 s, and prints the viewer's state, the stub's last events, the
// page's console messages and the server's errors.
//   node probes/debug-load.mjs [--ext DIR] [--engine pdfjs|overleaf] [--book DIR] [--port 8794]
// --book is a folder of make_book.py or theme_book.py; the default is the 120-page test book.
// It prints what it sees, for a person to read; its exit status says only whether it ran to its end.
import { openHarness } from '../common.mjs';
import { scriptOptions } from '../../lib/options.mjs';

const options = scriptOptions({ book: 'value', engine: 'value', ext: 'value', port: 'number' });

const engine = options.get('engine', 'pdfjs');
const h = await openHarness({ name: `debug-${engine}`, port: options.get('port', 8794), ext: options.get('ext'), bookDir: options.get('book'), latency: 5, stderr: 'pipe' });
let serverErrors = '';
h.server.stderr.on('data', d => { serverErrors += d; });
const logs = [];
h.page.on('Runtime.consoleAPICalled', (p) => logs.push(`${p.type}: ${p.args.map(a => a.value ?? a.description).join(' ').slice(0, 400)}`));
h.page.on('Runtime.exceptionThrown', (p) => logs.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 400) ?? p.exceptionDetails.text}`));
try {
    await h.page.send('Page.navigate', { url: `${h.origin}/page?engine=${engine}&doc=debug` });
    await new Promise(r => setTimeout(r, 8000));
    const V = engine === 'overleaf' ? 'window.overleafViewer?.wrapper?.viewer' : 'window.PDFViewerApplication?.pdfViewer';
    console.log('state:', await h.page.evaluate(`JSON.stringify({ pages: ${V}?.pagesCount, r0: ${V}?.getPageView?.(0)?.renderingState, events: window.harness?.events?.slice(-15) })`));
} finally {
    console.log('console:', logs.slice(0, 30).join('\n'));
    console.log('server errors:', serverErrors.slice(0, 1000));
    await h.close();
}
