// Export the published reader from the pinned full PDF.js app and the shared prefetch modules.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pdfjsRelease, repo, viewerRoot } from './viewer-protocol.mjs';
import { installImageRevisions } from './pdfjs-image-revisions.mjs';

const source = path.join(viewerRoot, 'src', 'standalone');
export const defaultOutput = path.join(repo, 'dist', 'spomenar');

function replaceOnce(text, pattern, replacement, description) {
    const matches = [...text.matchAll(new RegExp(pattern.source, 'g'))];
    if (matches.length !== 1) { throw new Error('The pinned PDF.js page must contain one ' + description + '.'); }
    return text.replace(pattern, replacement);
}

/** Keep the full upstream toolbar/sidebar/dialog markup and its accessibility semantics. */
export function standalonePage() {
    let html = readFileSync(path.join(pdfjsRelease, 'web', 'viewer.html'), 'utf8');
    const head = readFileSync(path.join(source, 'head.html'), 'utf8').trim();
    const header = readFileSync(path.join(source, 'header.html'), 'utf8').trim();
    html = replaceOnce(html, /<head>[\s\S]*?<\/head>/, head, 'head');
    html = replaceOnce(html, /<html dir="ltr" mozdisallowselectionprint>/, '<html lang="hr" dir="ltr" mozdisallowselectionprint>', 'root');
    html = replaceOnce(html, /<body tabindex="0">/, '<body tabindex="0">\n' + header, 'body');
    return html;
}

export async function buildSpomenar(outdir = defaultOutput) {
    installImageRevisions(pdfjsRelease);
    const assets = path.join(outdir, 'assets');
    mkdirSync(assets, { recursive: true });
    await esbuild.build({
        entryPoints: [path.join(source, 'main.ts')],
        outfile: path.join(assets, 'spomenar.mjs'),
        bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
        tsconfig: path.join(viewerRoot, 'tsconfig.json'),
        legalComments: 'eof', minify: true, logLevel: 'warning',
    });
    cpSync(pdfjsRelease, path.join(assets, 'pdfjs'), {
        recursive: true,
        // The viewer uses these relative files directly. Sample PDFs and source maps do not
        // belong in the published reader; PDF bytes come only from config.json's endpoint.
        filter: file => !/\.(?:pdf|map)$/.test(file),
    });
    cpSync(path.join(source, 'favicon.svg'), path.join(assets, 'favicon.svg'));
    cpSync(path.join(source, 'larics-logo.svg'), path.join(assets, 'larics-logo.svg'));
    cpSync(path.join(source, 'config.json'), path.join(outdir, 'config.json'));
    writeFileSync(path.join(outdir, 'index.html'), standalonePage());
    return outdir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--out')) {
        throw new Error('Usage: node scripts/build-spomenar.mjs [--out directory]');
    }
    const output = await buildSpomenar(args.length ? path.resolve(args[1]) : defaultOutput);
    console.log('Built the standalone reader: ' + output);
}
