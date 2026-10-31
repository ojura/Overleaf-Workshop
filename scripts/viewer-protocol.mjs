// What the extension defines for its PDF viewers (src/core/viewerProtocol.ts), for the scripts
// that build and set up the viewers, and what this checkout's package.json pins with it: pdf.js's
// release. The module src/core/viewerProtocol.ts imports nothing, so esbuild turns it into a
// module that this one imports.
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** the checkout */
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** views/pdf-viewer/ */
export const viewerRoot = path.join(repo, 'views', 'pdf-viewer');

const source = readFileSync(path.join(repo, 'src', 'core', 'viewerProtocol.ts'), 'utf8');
const { code } = await esbuild.transform(source, { loader: 'ts', format: 'esm' });
/** src/core/viewerProtocol.ts */
export const protocol = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const packageJson = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
/** the pdf.js version that package.json pins as pdfjs-dist (pdfjsVersionOf) */
export const pdfjsVersion = protocol.pdfjsVersionOf(packageJson);
/** the folder of that release in views/pdf-viewer/, relative to it (pdfjsReleaseOf), e.g. vendor/pdfjs-<version> */
export const pdfjsReleaseFolder = protocol.pdfjsReleaseOf(packageJson);
/** the same folder, absolute */
export const pdfjsRelease = path.join(viewerRoot, pdfjsReleaseFolder);
