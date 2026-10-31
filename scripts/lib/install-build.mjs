// Build a checkout of this extension and install the build into an extension folder. A test
// instance of the IDE (scripts/hidden-ide.sh start --build) installs through these functions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Run `program`, with its output on this process's stderr; fail with what failed and how. */
function run(what, program, args) {
    const result = spawnSync(program, args, { stdio: ['ignore', process.stderr, process.stderr] });
    if (result.error) { throw new Error(`${what}: ${program} could not run: ${result.error.message}`); }
    if (result.status !== 0) { throw new Error(`${what} failed: ${program} ended with ${result.signal ?? `status ${result.status}`}`); }
}

/** Write `text` to `file` through a new file that is renamed over it. */
function writeAtomically(file, text) {
    fs.writeFileSync(`${file}.new`, text);
    fs.renameSync(`${file}.new`, file);
}

/**
 * Build `checkout` into a new temporary folder: the extension's TypeScript (out/) and its PDF
 * viewers (viewers/). Returns { dir, checkout, version, label, pdfjs, remove }: `label` names the
 * checkout's commit as `git describe --always --dirty` does, so a build with uncommitted changes
 * says so; `pdfjs` is the checkout's pdf.js release, which the viewers run on; remove() deletes
 * the folder. Fails when a step fails, and when the checkout lacks its pdf.js release.
 */
export async function buildCheckout(checkout) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-workshop-build.'));
    const remove = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
        run(`the TypeScript build of ${checkout}`, process.execPath,
            [path.join(checkout, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', checkout, '--outDir', path.join(dir, 'out')]);
        const viewerBuild = path.join(checkout, 'scripts', 'build-pdf-viewer.mjs');
        run(`the PDF viewers' build of ${checkout}`, process.execPath, [viewerBuild, '--outdir', path.join(dir, 'viewers')]);
        const { pdfjsRelease } = await import(pathToFileURL(viewerBuild).href);
        if (!fs.existsSync(pdfjsRelease)) {
            throw new Error(`${pdfjsRelease} is missing: run npm run download-pdfjs in ${checkout}`);
        }
        const version = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')).version;
        const described = spawnSync('git', ['-C', checkout, 'describe', '--always', '--dirty'], { encoding: 'utf8' });
        if (described.status !== 0) { throw new Error(`git describe in ${checkout} failed: ${described.stderr.trim()}`); }
        return { dir, checkout, version, label: described.stdout.trim(), pdfjs: pdfjsRelease, remove };
    } catch (error) {
        remove();
        throw error;
    }
}

/**
 * Install `build` (buildCheckout) into the extension folder `ext`: out/ without source maps and
 * tests, the viewers in views/pdf-viewer/dist/, the pdf.js release in views/pdf-viewer/vendor/,
 * each as an exact copy (rsync --delete); package.json from the checkout with the installer's
 * __metadata kept; package.nls.json. With `sameVersion`, an installed extension of another version
 * is refused, so that the install does not undo what an update of the extension changed.
 */
export function installInto(build, ext, { sameVersion }) {
    const installed = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
    if (sameVersion && installed.version !== build.version) {
        throw new Error(`${ext} holds version ${installed.version}, and ${build.checkout} builds ${build.version}`);
    }
    run(`copying out/ into ${ext}`, 'rsync', ['-a', '--delete', '--exclude', '*.map', '--exclude', 'test/', `${build.dir}/out/`, `${ext}/out/`]);
    fs.mkdirSync(path.join(ext, 'views', 'pdf-viewer', 'vendor'), { recursive: true });
    run(`copying the PDF viewers into ${ext}`, 'rsync', ['-a', '--delete', `${build.dir}/viewers/`, `${ext}/views/pdf-viewer/dist/`]);
    run(`copying pdf.js into ${ext}`, 'rsync', ['-a', '--delete', '--exclude', '*.map', `${build.pdfjs}/`, `${ext}/views/pdf-viewer/vendor/${path.basename(build.pdfjs)}/`]);
    const manifest = JSON.parse(fs.readFileSync(path.join(build.checkout, 'package.json'), 'utf8'));
    if (installed.__metadata) { manifest.__metadata = installed.__metadata; }
    writeAtomically(path.join(ext, 'package.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
    writeAtomically(path.join(ext, 'package.nls.json'), fs.readFileSync(path.join(build.checkout, 'package.nls.json'), 'utf8'));
}

/**
 * Delete the cache of the installed extensions and their manifests in the IDE's data folder
 * `data`. The IDE starts from that cache, which an install does not update: its next window would
 * start with the old manifest, notice the change a few seconds later and ask for another reload.
 * Without the cache, the IDE reads the installed manifests and writes a new cache. Returns the
 * files it deleted.
 */
export function removeExtensionCache(data) {
    const profiles = path.join(data, 'CachedProfilesData');
    if (!fs.existsSync(profiles)) { return []; }
    const removed = [];
    for (const profile of fs.readdirSync(profiles)) {
        const cache = path.join(profiles, profile, 'extensions.user.cache');
        if (fs.existsSync(cache)) {
            fs.rmSync(cache);
            removed.push(cache);
        }
    }
    return removed;
}

/**
 * The folder of the extension `id` (e.g. iamhyc.overleaf-workshop) in an IDE's extensions folder,
 * as the IDE's own list of its installed extensions, extensions.json, names it; undefined when the
 * list does not hold it.
 */
export function installedExtension(extensions, id) {
    const list = JSON.parse(fs.readFileSync(path.join(extensions, 'extensions.json'), 'utf8'));
    const entry = list.find(e => e.identifier?.id?.toLowerCase() === id.toLowerCase());
    return entry && path.join(extensions, entry.relativeLocation);
}
