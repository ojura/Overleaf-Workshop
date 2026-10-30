// Build the PDF viewers that load a build of Overleaf in ranges with Overleaf's loader
// (setting overleaf-workshop.pdfViewer.engine):
//   pdfjs     pdf.js's own viewer app, views/pdf-viewer/src/pdfjs/
//   overleaf  Overleaf's PDFJSWrapper with the extension's toolbar, views/pdf-viewer/src/overleaf/
// Overleaf's files stay unmodified in views/pdf-viewer/overleaf/; the extension's stand-ins for
// the parts of Overleaf's web app that they import are in views/pdf-viewer/src/shims/.
// Each viewer's page script src/<engine>/main.ts goes to views/pdf-viewer/dist/<engine>.mjs
// (and .css), its page src/<engine>/index.html to dist/<engine>.html, which
// src/core/pdfViewerPages.ts completes at run time.
//   node scripts/build-pdf-viewer.mjs
import * as esbuild from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const viewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'views', 'pdf-viewer');
const src = path.join(viewerRoot, 'src');
const overleafJs = path.join(viewerRoot, 'overleaf', 'services', 'web', 'frontend', 'js');
/** pdf.js 5.1.91's release, which the download-pdfjs script unpacks; Overleaf uses this version */
export const pdfjsRelease = path.join(viewerRoot, 'vendor', 'pdfjs-5.1.91');

const shims = {
    'infrastructure/error-reporter': 'error-reporter.ts',
    'infrastructure/event-tracking': 'event-tracking.ts',
    'features/pdf-preview/util/pdf-js': 'pdf-js.ts',
};

/** where an import of Overleaf's files points, as a path in overleafJs ('' outside it) */
function overleafModule(args) {
    const target = args.path.startsWith('@/')
        ? path.join(overleafJs, args.path.slice(2))
        : path.resolve(args.resolveDir, args.path);
    const relative = path.relative(overleafJs, target);
    return relative.startsWith('..') ? '' : relative.split(path.sep).join('/');
}

/**
 * - Overleaf's modules for its web app's error reporting, event tracking and pdf.js setup become
 *   the stand-ins in src/shims/.
 * - PDFJSWrapper's './pdf-caching-transport' becomes src/common/transport.ts, Overleaf's factory
 *   with the transport kept on after a failed request. That module's own import of Overleaf's
 *   factory still reaches Overleaf's file.
 */
export const standIns = {
    name: 'overleaf-stand-ins',
    setup(build) {
        build.onResolve({ filter: /(error-reporter|event-tracking|pdf-js)$/ }, (args) => {
            const shim = shims[overleafModule(args)];
            return shim ? { path: path.join(src, 'shims', shim) } : undefined;
        });
        build.onResolve({ filter: /pdf-caching-transport$/ }, (args) => {
            const fromWrapper = path.basename(args.importer) === 'pdf-js-wrapper.ts';
            return fromWrapper && overleafModule(args) === 'features/pdf-preview/util/pdf-caching-transport'
                ? { path: path.join(src, 'common', 'transport.ts') }
                : undefined;
        });
    },
};

/**
 * For the pdfjs viewer: pdf.js's viewer app has its own copies of the viewer components, and that
 * viewer uses only PDFJSWrapper's methods on the app's page viewer, not the wrapper's
 * constructor, which makes the components. So the wrapper's imports of pdfjs-dist's components
 * and their CSS are left empty there; the CSS would also restyle the app's page.
 */
const noViewerComponents = {
    name: 'no-viewer-components',
    setup(build) {
        build.onResolve({ filter: /^pdfjs-dist\/web\/pdf_viewer\.(mjs|css)$/ }, (args) => ({ path: args.path, namespace: 'no-viewer-components' }));
        build.onLoad({ filter: /.*/, namespace: 'no-viewer-components' }, (args) => args.path.endsWith('.css')
            ? { contents: '', loader: 'css' }
            : { contents: 'export const PDFViewer = undefined, EventBus = undefined, PDFLinkService = undefined, LinkTarget = {};', loader: 'js' });
    },
};

/** esbuild options shared by the viewers and by the tests that bundle their modules */
export const bundleOptions = {
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    tsconfig: path.join(viewerRoot, 'tsconfig.json'),
    plugins: [standIns],
    loader: { '.svg': 'dataurl', '.gif': 'dataurl', '.png': 'dataurl', '.cur': 'dataurl' },
    legalComments: 'eof',
    logLevel: 'warning',
};

export const engines = ['pdfjs', 'overleaf'];
const enginePlugins = { pdfjs: [noViewerComponents], overleaf: [] };

/** The viewers whose page script and page exist in this checkout. */
export function availableEngines() {
    return engines.filter(engine => existsSync(path.join(src, engine, 'main.ts')) && existsSync(path.join(src, engine, 'index.html')));
}

/** Build the page script and page of each viewer that exists. */
export async function buildViewers(outdir = path.join(viewerRoot, 'dist')) {
    mkdirSync(outdir, { recursive: true });
    const built = [];
    for (const engine of availableEngines()) {
        await esbuild.build({
            ...bundleOptions,
            plugins: [...bundleOptions.plugins, ...enginePlugins[engine]],
            entryPoints: [path.join(src, engine, 'main.ts')],
            outfile: path.join(outdir, `${engine}.mjs`),
        });
        writeFileSync(path.join(outdir, `${engine}.html`), readFileSync(path.join(src, engine, 'index.html'), 'utf8'));
        built.push(engine);
    }
    return built;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const built = await buildViewers();
    console.log(built.length ? `built the PDF viewers: ${built.join(', ')}` : 'no PDF viewer to build yet');
}
