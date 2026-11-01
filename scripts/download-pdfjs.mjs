// Download the pdf.js release that package.json pins as pdfjs-dist into views/pdf-viewer/vendor/,
// and apply the extension's patch for that release, which lies next to it as
// vendor/pdfjs-<version>-dist.patch (scripts/viewer-protocol.mjs derives both from package.json).
// The release is unpacked and patched in a folder of its own next to its place, and takes the place
// only when the patch has applied, so a failed download or patch leaves an earlier copy as it was.
//   npm run download-pdfjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pdfjsRelease, pdfjsVersion, repo } from './viewer-protocol.mjs';

/** What to fetch and where it goes, for pdf.js `version` unpacked into `release`. */
export function planOf(version = pdfjsVersion, release = pdfjsRelease) {
    return {
        version,
        /** the release's archive, as pdf.js publishes it on GitHub */
        url: `https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`,
        release,
        /** the extension's changes to the release, next to its folder */
        patch: `${release}-dist.patch`,
    };
}

/**
 * Run `command` with `args`; throws unless it ends with status 0. With `output` 'inherit' the
 * command's output goes to this process's; with 'pipe' it is kept, and a failure's error ends with
 * what the command wrote to its error output, so that a caller such as a test shows only what
 * failed.
 */
function run(what, command, args, { output = 'inherit', ...options } = {}) {
    const result = spawnSync(command, args, { stdio: output === 'pipe' ? ['ignore', 'ignore', 'pipe'] : 'inherit', encoding: 'utf8', ...options });
    if (result.error || result.status !== 0) {
        const said = output === 'pipe' ? result.stderr?.trim() : undefined;
        throw new Error(`${what} failed: ${result.error?.message ?? (result.signal ? `ended by ${result.signal}` : `exit status ${result.status}`)}${said ? `\n${said}` : ''}`);
    }
}

/**
 * Download, unpack and patch the release of `plan` into its folder. `output` is where the output
 * of the download and of patch goes (run): this process's, or kept for the error of a failure.
 */
export function download(plan = planOf(), { output = 'inherit' } = {}) {
    const name = (file) => path.relative(repo, file);
    if (!existsSync(plan.patch)) {
        throw new Error(`there is no patch for pdf.js ${plan.version}: ${name(plan.patch)} is missing; the viewers need the extension's changes to pdf.js, so make one for this release first`);
    }
    // the download-cli package that package.json lists, which unpacks the archive as it downloads it
    const downloadCli = createRequire(import.meta.url).resolve('download-cli/cli.js');
    const unpacked = mkdtempSync(`${plan.release}.download-`);
    try {
        run(`the download of ${plan.url}`, process.execPath, [downloadCli, '--extract', '--out', unpacked, plan.url], { output });
        // --forward: a patch that looks applied already fails rather than being reversed
        run(`applying ${name(plan.patch)}`, 'patch', ['-p1', '--forward', '--batch', '-i', plan.patch], { output, cwd: unpacked });
        // the earlier copy aside, the new one in, the earlier one away
        const earlier = `${unpacked}.earlier`;
        const replaced = existsSync(plan.release);
        if (replaced) { renameSync(plan.release, earlier); }
        try {
            renameSync(unpacked, plan.release);
        } catch (error) {
            if (replaced) { renameSync(earlier, plan.release); }
            throw error;
        }
        if (replaced) { rmSync(earlier, { recursive: true, force: true }); }
    } finally {
        rmSync(unpacked, { recursive: true, force: true });
    }
    console.log(`pdf.js ${plan.version} is in ${name(plan.release)}, with ${name(plan.patch)} applied`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        download();
    } catch (error) {
        console.error(`download-pdfjs: ${error.message}`);
        process.exitCode = 1;
    }
}
