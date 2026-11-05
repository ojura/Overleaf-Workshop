// Build this checkout and install it over the Overleaf Workshop extension of each IDE in the home
// folder that has it installed (IDES in scripts/lib/install-build.mjs: Antigravity IDE, VS Code,
// VSCodium or Code - OSS, Cursor), e.g. again after an extension update.
// scripts/install-local-build.sh runs this file.
//
//   scripts/install-local-build.sh            build and install
//   scripts/install-local-build.sh --check    build, and say for each IDE which build its extension
//                                             folder holds and what the install would change there
//
// The extension's folder in an IDE is the one that the IDE's list of its extensions,
// extensions.json, names. The install makes the folder hold exactly the package of this checkout
// (scripts/lib/install-build.mjs); of what was there, it keeps only the installer's metadata
// (package.json's __metadata, and .vsixmanifest). It writes the stamp file
// .overleaf-workshop-build.json into the folder, which names the build: git describe --always
// --dirty, the commit, and the checkout. A folder without that file holds the extension as the
// IDE installed it, for example after the IDE updated the extension, or an install by an earlier
// version of this script. The install leaves alone an extension of another version than this
// checkout's: the IDE has updated it, and an install would undo what the update changed; rebase
// the fork onto that release first. To undo an install, reinstall the release in the IDE's
// Extensions view (Install Specific Version...).
//
// The build goes into a temporary folder, not into this checkout's out/ and dist/ folders: the
// command-line tools run from out/ (node out/sandbox/cli.js), and replacing it would break a run in
// progress. After an install, the IDE's cache of its installed extensions is deleted, so that its
// next window reads the new manifest. Reload the IDE's windows to use the build.
//
// Exit status: 0 when it installed into at least one IDE (with --check: when it would), 1 when it
// did not or a step failed, 64 for a wrong use, and 128 + the signal's number after a signal
// (scripts/lib/cleanup.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildCheckout, EXTENSION_ID, IDES, installedExtension, installInto, plannedChanges, readStamp, removeExtensionCache,
} from './lib/install-build.mjs';
import { parseOptions, usageOf, UsageError } from './lib/options.mjs';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the stamp of `ext` says about the build in it, as a sentence; with `build`, also whether that is the commit of the build. */
function describeStamp(ext, build) {
    const stamp = readStamp(ext);
    if (!stamp) {
        return 'it does not hold the stamp file, so it holds the extension as the IDE installed it, or an install by an earlier version of this script';
    }
    const same = !build ? '' : stamp.commit === build.commit ? '; this checkout is at that commit' : `; this checkout is at ${build.label}`;
    return `it holds the build ${stamp.label} (commit ${stamp.commit}) of ${stamp.checkout}${same}`;
}

/** The lines that say what plannedChanges found. */
function describeChanges({ deleted, added, changed }) {
    const lines = [`  the install would delete ${deleted.length}, add ${added.length} and change ${changed.length} files or folders (a folder counts once)`];
    if (deleted.length) { lines.push('  it would delete:', ...deleted.map(file => `    ${file}`)); }
    if (added.length) { lines.push('  it would add:', ...added.map(file => `    ${file}`)); }
    return lines.join('\n');
}

async function main(args) {
    const check = parseOptions({ check: 'flag' }, args).check === true;
    const version = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')).version;
    const targets = [];
    for (const ide of IDES) {
        if (!fs.existsSync(path.join(ide.extensions, 'extensions.json'))) { continue; }
        const ext = installedExtension(ide.extensions, EXTENSION_ID);
        if (!ext) { continue; }
        const manifest = path.join(ext, 'package.json');
        if (!fs.statSync(manifest, { throwIfNoEntry: false })?.isFile()) {
            console.log(`skip ${ide.name}: its extensions.json names ${ext}, which does not hold package.json`);
            continue;
        }
        const installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
        if (installed !== version) {
            console.log(`skip ${ide.name}: ${ext} holds Overleaf Workshop ${installed}, and this checkout builds ${version}; ${describeStamp(ext)}`);
            continue;
        }
        targets.push({ ide, ext });
    }
    if (!targets.length) {
        console.error(`${check ? 'would not install' : 'did not install'}: Overleaf Workshop ${version} is not installed in ${IDES.map(ide => ide.name).join(', ')}`);
        return 1;
    }
    const build = await buildCheckout(checkout);
    try {
        for (const { ide, ext } of targets) {
            if (check) {
                console.log(`${ide.name}: ${ext}\n  ${describeStamp(ext, build)}\n${describeChanges(await plannedChanges(build, ext, { sameVersion: true }))}`);
                continue;
            }
            const files = await installInto(build, ext, { sameVersion: true });
            const caches = ide.data.flatMap(removeExtensionCache);
            console.log(`installed ${build.label} (commit ${build.commit}, ${files} files) into ${ext}`);
            for (const cache of caches) { console.log(`  deleted the IDE's extension cache ${cache}`); }
        }
        if (!check) { console.log('reload the IDE\'s windows to use the build'); }
        return 0;
    } finally {
        build.remove();
    }
}

try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    console.error(`install-local-build: ${error.message}`);
    if (error instanceof UsageError) { console.error(`\n${usageOf(fileURLToPath(import.meta.url))}`); }
    process.exitCode = error instanceof UsageError ? 64 : 1;
}
