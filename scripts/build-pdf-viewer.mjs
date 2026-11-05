// Build the PDF viewers that load a build of Overleaf in ranges with Overleaf's loader
// (setting overleaf-workshop.pdfViewer.engine):
//   pdfjs     pdf.js's own viewer app, views/pdf-viewer/src/pdfjs/
//   overleaf  Overleaf's PDFJSWrapper with the extension's toolbar, views/pdf-viewer/src/overleaf/
// Overleaf's files stay unmodified in views/pdf-viewer/overleaf/; the extension's stand-ins for
// the parts of Overleaf's web app that they import are in views/pdf-viewer/src/shims/. The build
// adapts its cache flag, consumes owned bridge bodies, and cleans up document transitions.
// These transforms stop when Overleaf's text is not the one they expect.
// Each viewer's page script src/<engine>/main.ts goes to views/pdf-viewer/dist/<engine>.mjs
// (and .css), its page src/<engine>/index.html to dist/<engine>.html, which
// src/core/pdfViewerPages.ts completes at run time.
//   node scripts/build-pdf-viewer.mjs [--outdir DIR]
// --outdir writes the viewers into DIR instead of views/pdf-viewer/dist. The build goes into a new
// folder next to the output folder, which then replaces it, so that the output folder holds only
// what this build wrote. Exit status 1 when a viewer does not build.
import * as esbuild from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { pdfjsRelease, pdfjsReleaseFolder, protocol, repo, viewerRoot } from './viewer-protocol.mjs';

export { viewerRoot };
const src = path.join(viewerRoot, 'src');
const overleafJs = path.join(viewerRoot, 'overleaf', 'services', 'web', 'frontend', 'js');

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
 * - Overleaf's loader gets src/common/caching-flags.ts in place of Overleaf's flags module, and
 *   asks it about the fallback to Overleaf's cache for each load (perLoadCacheFlag).
 */
/**
 * Overleaf's loader `source` (in `file`), with the fallback to Overleaf's cache decided for each
 * load. The loader reads canUseClsiCache, one flag for every load, when a request fails
 * (pdf-caching-transport.ts:150), also for a request of an older load that fails after a newer
 * load has begun. Here it asks canUseClsiCacheFor with the load's own file
 * (src/common/caching-flags.ts). Throws when Overleaf's text is not the expected one.
 */
function perLoadCacheFlag(source, file) {
    const changes = [
        ["  canUseClsiCache,\n} from './pdf-caching-flags'", "  canUseClsiCacheFor,\n} from './pdf-caching-flags'"],
        ['        if (!canUseClsiCache) return false', '        if (!canUseClsiCacheFor(this.pdfFile)) return false'],
    ];
    for (const [from, to] of changes) {
        if (source.split(from).length !== 2) {
            throw new Error(`${file}: the build expects ${JSON.stringify(from)} once, to decide the fallback to Overleaf's cache for each load (perLoadCacheFlag)`);
        }
        source = source.replace(from, to);
    }
    return source;
}

/** Keep native fetch fallback while consuming an owned host body without another byte copy. */
function bridgeBodyReads(source, file) {
    const from = 'await response.arrayBuffer()';
    if (source.split(from).length !== 3) {
        throw new Error(`${file}: the build expects ${JSON.stringify(from)} exactly twice for bridge body consumption`);
    }
    const helper = JSON.stringify(path.join(src, 'common', 'bridge-response.ts'));
    return `import { readPdfResponse } from ${helper};\n` + source.replaceAll(from, 'await readPdfResponse(response)');
}

/** Observe native callback rejection and keep a height hold only around actual assignment. */
function wrapperDocumentCommit(source, file) {
    const original = `      // Hold the .pdfViewer element's height steady across the synchronous page-clear
      // that setDocument() triggers, so the viewer doesn't visually collapse while the
      // new pages are being initialised. The min-height is released on pagesinit.
      const viewerEl = this.container.querySelector('.pdfViewer') as HTMLElement
      const currentHeight = viewerEl.getBoundingClientRect().height
      if (currentHeight > 0) {
        viewerEl.style.minHeight = \`\${currentHeight}px\`
        const clearMinHeight = () => {
          viewerEl.style.minHeight = ''
          this.eventBus.off('pagesinit', clearMinHeight)
        }
        this.eventBus.on('pagesinit', clearMinHeight)
      }

      const setDocument = () => {
        this.viewer.setDocument(doc)
        this.linkService.setDocument(doc)
      }`;
    const replacement = `      const setDocument = () => {
        if (abortController.signal.aborted || url !== this.url) {
          throw new DOMException('The document load was cancelled.', 'AbortError')
        }
        const releaseHeight = holdDocumentHeight(
          this.container.querySelector('.pdfViewer') as HTMLElement,
          this.eventBus,
          abortController.signal,
        )
        try {
          this.viewer.setDocument(doc)
          this.linkService.setDocument(doc)
        } catch (error) {
          releaseHeight()
          throw error
        }
      }`;
    const changes = [
        [original, replacement],
        ['          ready: Promise<void>', '          ready: Promise<void>\n          updateCallbackDone: Promise<void>'],
        ['        const transition = container.startViewTransition(setDocument)',
            '        const transition = container.startViewTransition(setDocument)\n        void transition.updateCallbackDone.catch(() => {})'],
    ];
    for (const [from, to] of changes) {
        if (source.split(from).length !== 2) {
            throw new Error(`${file}: the build expects ${JSON.stringify(from)} once for document transition cleanup`);
        }
        source = source.replace(from, to);
    }
    const helper = JSON.stringify(path.join(src, 'common', 'document-height.ts'));
    return `import { holdDocumentHeight } from ${helper};\n` + source;
}

export const standIns = {
    name: 'overleaf-stand-ins',
    setup(build) {
        build.onResolve({ filter: /(error-reporter|event-tracking|pdf-js)$/ }, (args) => {
            const shim = shims[overleafModule(args)];
            return shim ? { path: path.join(src, 'shims', shim) } : undefined;
        });
        // Overleaf's caching flags, with the cache's fallback decided for each load (common/caching-flags.ts)
        build.onResolve({ filter: /pdf-caching-flags$/ }, (args) => {
            const fromTransport = path.basename(args.importer) === 'pdf-caching-transport.ts';
            return fromTransport && overleafModule(args) === 'features/pdf-preview/util/pdf-caching-flags'
                ? { path: path.join(src, 'common', 'caching-flags.ts') }
                : undefined;
        });
        build.onLoad({ filter: /pdf-caching-transport\.ts$/ }, (args) => {
            const relative = path.relative(overleafJs, args.path).split(path.sep).join('/');
            return relative === 'features/pdf-preview/util/pdf-caching-transport.ts'
                ? { contents: perLoadCacheFlag(readFileSync(args.path, 'utf8'), args.path), loader: 'ts' }
                : undefined;
        });
        build.onLoad({ filter: /pdf-caching\.ts$/ }, (args) => {
            const relative = path.relative(overleafJs, args.path).split(path.sep).join('/');
            return relative === 'features/pdf-preview/util/pdf-caching.ts'
                ? { contents: bridgeBodyReads(readFileSync(args.path, 'utf8'), args.path), loader: 'ts' }
                : undefined;
        });
        build.onLoad({ filter: /pdf-js-wrapper\.ts$/ }, (args) => {
            const relative = path.relative(overleafJs, args.path).split(path.sep).join('/');
            return relative === 'features/pdf-preview/util/pdf-js-wrapper.ts'
                ? { contents: wrapperDocumentCommit(readFileSync(args.path, 'utf8'), args.path), loader: 'ts' }
                : undefined;
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
    // the bundles name their modules by paths relative to this folder, the checkout, in comments
    // and in the names of CommonJS modules; esbuild's default is the working directory, with which
    // the same checkout built different files from different folders
    absWorkingDir: repo,
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

/** the viewers (PDF_VIEWER_ENGINES) */
export const engines = [...protocol.PDF_VIEWER_ENGINES];
/** pdf.js's release, which npm run download-pdfjs unpacks; Overleaf's viewer uses this version (scripts/viewer-protocol.mjs) */
export { pdfjsRelease };
/** where a viewer's page source (src/<engine>/index.html) names the folder of pdf.js's release */
const PDFJS_RELEASE_IN_PAGE = '{{pdfjs-release}}';

/** The page of viewer `engine`, with the folder of pdf.js's release written in. */
export function viewerPage(engine) {
    const page = readFileSync(path.join(src, engine, 'index.html'), 'utf8');
    if (!page.includes(PDFJS_RELEASE_IN_PAGE)) {
        throw new Error(`the ${engine} viewer's page does not name ${PDFJS_RELEASE_IN_PAGE}`);
    }
    return page.replaceAll(PDFJS_RELEASE_IN_PAGE, pdfjsReleaseFolder);
}
/** what the pdf.js viewer leaves out of pdf.js's viewer app */
const enginePlugins = { pdfjs: [noViewerComponents] };

/** Whether the process `pid` runs: a process of another user counts as running. */
function isRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

/**
 * Remove the folders that builds which ended before they finished left next to `outdir`, its
 * .new-<pid> and .old-<pid> folders (buildViewers), when their process has ended; the folder of
 * a process that runs belongs to a build in progress, and stays. git ignores these folders in the
 * checkout (.gitignore: views/pdf-viewer/dist.*).
 */
function removeLeftovers(outdir) {
    const parent = path.dirname(outdir);
    if (!existsSync(parent)) { return; }
    const base = path.basename(outdir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${base}\\.(?:new|old)-(\\d+)$`);
    for (const name of readdirSync(parent)) {
        const pid = pattern.exec(name)?.[1];
        if (pid && !isRunning(Number(pid))) { rmSync(path.join(parent, name), { recursive: true, force: true }); }
    }
}

/**
 * Build the page script and page of each viewer into `outdir`: into a new folder next to it,
 * which then replaces it. Fails when a viewer does not build, also when its files are missing.
 */
export async function buildViewers(outdir = path.join(viewerRoot, 'dist')) {
    removeLeftovers(outdir);
    const fresh = `${outdir}.new-${process.pid}`;
    rmSync(fresh, { recursive: true, force: true });
    mkdirSync(fresh, { recursive: true });
    try {
        for (const engine of engines) {
            await esbuild.build({
                ...bundleOptions,
                plugins: [...bundleOptions.plugins, ...(enginePlugins[engine] ?? [])],
                entryPoints: [path.join(src, engine, 'main.ts')],
                outfile: path.join(fresh, `${engine}.mjs`),
            });
            writeFileSync(path.join(fresh, `${engine}.html`), viewerPage(engine));
        }
        const old = `${outdir}.old-${process.pid}`;
        let replaced = false;
        try {
            renameSync(outdir, old);
            replaced = true;
        } catch (error) {
            if (error.code !== 'ENOENT') { throw error; }
        }
        renameSync(fresh, outdir);
        if (replaced) { rmSync(old, { recursive: true, force: true }); }
    } finally {
        rmSync(fresh, { recursive: true, force: true });
    }
    return engines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--outdir')) {
        console.error('usage: node scripts/build-pdf-viewer.mjs [--outdir DIR]');
        process.exit(64);
    }
    const outdir = args.length ? path.resolve(args[1]) : undefined;
    console.log(`built the PDF viewers: ${(await buildViewers(outdir)).join(', ')}${outdir ? ` into ${outdir}` : ''}`);
}
