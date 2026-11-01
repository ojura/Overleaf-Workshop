// Build a checkout of this extension and install it into an extension folder, so that the folder
// holds exactly the checkout's package: the files that vsce puts into the extension's .vsix in the
// repository's workflow (.github/workflows/vsce-package.yml), from the checkout's working tree.
// scripts/install-local-build.sh installs into the user's IDEs through these functions, and
// scripts/hidden-ide.sh start --build into a test instance's copy of the extension.
//
// The package holds, less what vsce's rules leave out (vscePackaged):
// - the files that git tracks in the checkout, as the working tree has them; files that git does
//   not track stay out, as they are not in the workflow's clean clone;
// - the folders that npm's postinstall downloads (DOWNLOADS), which git ignores;
// - the outputs of `npm run compile`, from a build into a temporary folder (buildCheckout): out/,
//   views/pdf-viewer/dist/ and views/chat-view/dist/;
// - the production dependencies, from the checkout's node_modules (npm ls --omit=dev).
// As vsce does, the license file LICENSE goes into the package as LICENSE.txt, and package.json
// with mode 644.
// vsce also rewrites the relative links in README.md and CHANGELOG.md; the install copies those two
// files as they are.
//
// Of what the extension folder held, the install keeps only the installer's metadata, which the
// IDE wrote when it installed the extension from its gallery: __metadata in package.json, and the
// file .vsixmanifest. Antigravity's code does not read .vsixmanifest; it stays because it is the
// installer's, as __metadata is, and keeping it costs nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { onCleanup, run } from './cleanup.mjs';

/** the extension's id in an IDE's list of its extensions */
export const EXTENSION_ID = 'iamhyc.overleaf-workshop';

const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');

/**
 * The IDEs that the scripts know, on Linux: the folder of each one's installed extensions, and its
 * data folders, which hold its settings, saved state and caches. VSCodium and Code - OSS share
 * ~/.vscode-oss.
 */
export const IDES = [
    { name: 'Antigravity IDE', extensions: '.antigravity-ide/extensions', data: ['Antigravity IDE'] },
    { name: 'VS Code', extensions: '.vscode/extensions', data: ['Code'] },
    { name: 'VSCodium or Code - OSS', extensions: '.vscode-oss/extensions', data: ['VSCodium', 'Code - OSS'] },
    { name: 'Cursor', extensions: '.cursor/extensions', data: ['Cursor'] },
].map(ide => ({ ...ide, extensions: path.join(os.homedir(), ide.extensions), data: ide.data.map(name => path.join(configHome, name)) }));

/**
 * The file in an extension folder that names the build that an install wrote there:
 * { label, commit, checkout }. The IDE's own install of the extension does not write it.
 */
export const STAMP = '.overleaf-workshop-build.json';

/**
 * The folders that npm's postinstall downloads (package.json's scripts), other than the PDF
 * viewers' pdf.js release, which buildCheckout takes from scripts/build-pdf-viewer.mjs.
 */
const DOWNLOADS = [{ folder: 'data/vendor', how: 'npm run download-latex-basics' }];

/**
 * The build script of views/chat-view/package.json, which runs its scripts type-check and
 * build-only (run-p). The output folder that it passes on to build-only does not reach vite, as npm
 * takes the option for itself, so buildCheckout runs the two scripts with an output folder of its
 * own, and refuses a build script that does something else.
 */
const CHAT_VIEW_BUILD = 'run-p type-check "build-only {@}" --';

/**
 * What vsce 2.15.0, the version that the workflow installs (npm install -g vsce), leaves out of
 * every package before .vscodeignore (its out/package.js: defaultIgnore), and what it puts in
 * whatever .vscodeignore says (notIgnored).
 */
const VSCE_DEFAULT_IGNORE = [
    '.vscodeignore', 'package-lock.json', 'npm-debug.log', 'yarn.lock', 'yarn-error.log', 'npm-shrinkwrap.json',
    '.editorconfig', '.npmrc', '.yarnrc', '.gitattributes', '*.todo', 'tslint.yaml', '.eslintrc*', '.babelrc*',
    '.prettierrc*', '.cz-config.js', '.commitlintrc*', 'webpack.config.js', 'ISSUE_TEMPLATE.md', 'CONTRIBUTING.md',
    'PULL_REQUEST_TEMPLATE.md', 'CODE_OF_CONDUCT.md', '.github', '.travis.yml', 'appveyor.yml', '**/.git/**',
    '**/*.vsix', '**/.DS_Store', '**/*.vsixmanifest', '**/.vscode-test/**', '**/.vscode-test-web/**',
];
const VSCE_NOT_IGNORED = ['!package.json', '!README.md'];

/**
 * A matcher for one pattern of vsce's lists, as vsce's minimatch (version 3, with { dot: true })
 * matches it: `*` and `?` within a path segment, `**` as a whole segment for any number of
 * segments, and every other character for itself. A pattern with other glob syntax ([...], {...},
 * (...), \) is refused, since this matcher would not read it as minimatch does.
 */
export function globMatcher(pattern) {
    if (/[[\]{}()\\]/.test(pattern)) { throw new Error(`.vscodeignore: the pattern ${pattern} uses glob syntax that the install does not read`); }
    const segments = pattern.split('/');
    const regex = segments.map((segment, i) => {
        const last = i === segments.length - 1;
        if (segment === '**') { return last ? '.*' : '(?:[^/]*/)*'; }
        const text = segment.replace(/[.+^$|]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]');
        return last ? text : `${text}/`;
    }).join('');
    const compiled = new RegExp(`^${regex}$`);
    return (file) => compiled.test(file);
}

/**
 * The paths of `files` (relative to the package's root, with /) that vsce packages, by its lists
 * and the lines of `vscodeignore`, as vsce 2.15.0 reads them (its collectFiles): each line that is
 * not blank or a comment is a pattern; a line that does not end in a segment with * also stands for
 * the files below it (line/**); a file is packaged when it matches no pattern without !, or when it
 * matches a pattern with ! (after the !).
 */
export function vscePackaged(files, vscodeignore) {
    const lines = vscodeignore.split(/[\n\r]/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const withFolders = [...lines, ...lines.filter(line => !/(^|\/)[^/]*\*[^/]*$/.test(line)).map(line => (line.endsWith('/') ? `${line}**` : `${line}/**`))];
    const all = [...VSCE_DEFAULT_IGNORE, ...withFolders, ...VSCE_NOT_IGNORED];
    const ignore = all.filter(pattern => !pattern.startsWith('!')).map(globMatcher);
    const negate = all.filter(pattern => pattern.startsWith('!')).map(pattern => globMatcher(pattern.slice(1)));
    return files.filter(file => !/\r$/m.test(file) && (!ignore.some(match => match(file)) || negate.some(match => match(file))));
}

/**
 * The files below `dir`, as paths relative to it with /, in the way vsce's glob finds them: dot
 * files too, a link to a file as a file, and neither links to folders nor the folders named in
 * `skip` (relative paths) below them.
 */
function filesBelow(dir, skip = []) {
    const found = [];
    const walk = (relative) => {
        for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (!skip.includes(child)) { walk(child); }
            } else if (entry.isFile() || (entry.isSymbolicLink() && fs.statSync(path.join(dir, child), { throwIfNoEntry: false })?.isFile())) {
                found.push(child);
            }
        }
    };
    walk('');
    return found;
}

/** The text that `program` writes to its standard output, without the line end at its end. */
const output = async (what, program, args, options) => (await run(what, program, args, { ...options, capture: true })).replace(/\n$/, '');

/**
 * Build `checkout` into a new temporary folder, as `npm run compile` builds it in place: the
 * extension's TypeScript (out/), its PDF viewers (viewers/) and its chat view (chat-view/).
 * Returns { dir, checkout, version, label, commit, pdfjs, remove }: `label` names the checkout's
 * commit as `git describe --always --dirty` does, so a build with uncommitted changes says so;
 * `pdfjs` is the checkout's pdf.js release, which the viewers run on; remove() deletes the folder,
 * which also happens when the script ends first. Fails when a step fails, and first when the
 * checkout lacks what npm's postinstall downloads or the chat view's own node_modules.
 */
export async function buildCheckout(checkout) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-workshop-build.'));
    const removal = onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
    try {
        const viewerBuild = path.join(checkout, 'scripts', 'build-pdf-viewer.mjs');
        const { pdfjsRelease } = await import(pathToFileURL(viewerBuild).href);
        const chatView = path.join(checkout, 'views', 'chat-view');
        const needed = [
            { folder: pdfjsRelease, how: `npm run download-pdfjs, in ${checkout}` },
            ...DOWNLOADS.map(({ folder, how }) => ({ folder: path.join(checkout, folder), how: `${how}, in ${checkout}` })),
            { folder: path.join(chatView, 'node_modules'), how: `npm ci, in ${chatView}` },
        ];
        const missing = needed.filter(({ folder }) => !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory());
        if (missing.length) {
            throw new Error(`the checkout lacks ${missing.length === 1 ? 'a folder' : 'folders'} that the build needs:\n${missing.map(({ folder, how }) => `  ${folder}: run ${how}`).join('\n')}`);
        }
        const chatViewBuild = JSON.parse(fs.readFileSync(path.join(chatView, 'package.json'), 'utf8')).scripts?.build;
        if (chatViewBuild !== CHAT_VIEW_BUILD) {
            throw new Error(`the build script of ${chatView}/package.json is ${JSON.stringify(chatViewBuild)}; the install runs ${JSON.stringify(CHAT_VIEW_BUILD)} as its two scripts, type-check and build-only (CHAT_VIEW_BUILD in scripts/lib/install-build.mjs)`);
        }
        await run(`the TypeScript build of ${checkout}`, process.execPath,
            [path.join(checkout, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', checkout, '--outDir', path.join(dir, 'out')]);
        await run(`the PDF viewers' build of ${checkout}`, process.execPath, [viewerBuild, '--outdir', path.join(dir, 'viewers')]);
        await run(`the chat view's type check in ${checkout}`, 'npm', ['--no-update-notifier', 'run', 'type-check'], { cwd: chatView });
        await run(`the chat view's build of ${checkout}`, 'npm',
            ['--no-update-notifier', 'run', 'build-only', '--', '--outDir', path.join(dir, 'chat-view'), '--emptyOutDir'], { cwd: chatView });
        const version = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')).version;
        const label = await output(`git describe in ${checkout}`, 'git', ['-C', checkout, 'describe', '--always', '--dirty']);
        const commit = await output(`git rev-parse in ${checkout}`, 'git', ['-C', checkout, 'rev-parse', 'HEAD']);
        return { dir, checkout, version, label, commit, pdfjs: pdfjsRelease, remove: removal.run };
    } catch (error) {
        removal.run();
        throw error;
    }
}

/**
 * The package of `build` (buildCheckout), as described at the top: a Map from each path in the
 * package to the file that holds its content. Fails when the package would hold a native module
 * (a .node file): the checkout's native modules are built for the system's Node, not for the IDE's
 * Electron.
 */
export async function packageFiles(build) {
    const { checkout } = build;
    const sources = new Map();
    const addFolder = (prefix, dir, skip) => { for (const file of filesBelow(dir, skip)) { sources.set(`${prefix}/${file}`, path.join(dir, file)); } };

    const tracked = (await output(`git ls-files in ${checkout}`, 'git', ['-C', checkout, 'ls-files', '-z', '--cached'])).split('\0').filter(Boolean);
    for (const file of tracked) {
        const source = path.join(checkout, file);
        if (fs.statSync(source, { throwIfNoEntry: false })?.isFile()) { sources.set(file, source); }
    }
    for (const folder of [path.relative(checkout, build.pdfjs).split(path.sep).join('/'), ...DOWNLOADS.map(d => d.folder)]) {
        addFolder(folder, path.join(checkout, folder));
    }
    addFolder('out', path.join(build.dir, 'out'));
    addFolder('views/pdf-viewer/dist', path.join(build.dir, 'viewers'));
    addFolder('views/chat-view/dist', path.join(build.dir, 'chat-view'));

    // npm ls names the checkout first, then the folder of each production dependency
    const listing = await output(`npm ls in ${checkout}`, 'npm', ['--no-update-notifier', 'ls', '--omit=dev', '--parseable', '--all'], { cwd: checkout });
    const modules = fs.realpathSync(path.join(checkout, 'node_modules'));
    for (const dependency of listing.split('\n').filter(line => path.isAbsolute(line)).slice(1)) {
        const real = fs.realpathSync(dependency);
        const relative = path.relative(modules, real);
        if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error(`npm ls names ${dependency}, which is outside ${modules}`); }
        // a dependency's own node_modules holds dependencies that npm ls names by themselves
        addFolder(`node_modules/${relative.split(path.sep).join('/')}`, real, ['node_modules']);
    }

    const packaged = new Set(vscePackaged([...sources.keys()], fs.readFileSync(path.join(checkout, '.vscodeignore'), 'utf8')));
    const native = [...packaged].filter(file => file.endsWith('.node'));
    if (native.length) {
        throw new Error(`the package would hold native modules, which are built for the system's Node and not for the IDE's Electron: ${native.join(', ')}`);
    }
    const files = new Map([...sources].filter(([file]) => packaged.has(file)));
    // vsce's LicenseProcessor: unless package.json's license says "SEE LICENSE IN <file>", the license
    // file at the top (LICENSE, LICENSE.md or LICENSE.txt, in any case) goes into the package, and
    // gets .txt when it has no extension
    const { license } = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8'));
    if (!/^SEE LICENSE IN (.*)$/.test(license ?? '')) {
        const licenses = [...files.keys()].filter(file => /^license(\.(md|txt))?$/i.test(file));
        if (licenses.length > 1) { throw new Error(`the package would hold several license files, ${licenses.join(', ')}, of which vsce takes the first that it finds`); }
        if (licenses.length === 1 && !path.extname(licenses[0])) {
            files.set(`${licenses[0]}.txt`, files.get(licenses[0]));
            files.delete(licenses[0]);
        }
    }
    return files;
}

/**
 * Write the package of `build` into a new temporary folder `stage`, as the extension folder `ext`
 * should hold it: package.json with the installer's __metadata from `installed` (the installed
 * package.json), the stamp file, and the mode of `ext` on the folder itself. Returns { stage, files,
 * remove }.
 */
async function stagePackage(build, ext, installed) {
    const files = await packageFiles(build);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-workshop-package.'));
    const removal = onCleanup(() => fs.rmSync(stage, { recursive: true, force: true }));
    try {
        for (const [file, source] of files) {
            const target = path.join(stage, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target);
            fs.chmodSync(target, fs.statSync(source).mode & 0o777);
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
        if (installed.__metadata) { manifest.__metadata = installed.__metadata; }
        // with tabs, as the IDE writes package.json when it adds __metadata; mode 644, as vsce packages it
        fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
        fs.chmodSync(path.join(stage, 'package.json'), 0o644);
        fs.writeFileSync(path.join(stage, STAMP), `${JSON.stringify({ label: build.label, commit: build.commit, checkout: build.checkout }, null, 2)}\n`);
        fs.chmodSync(stage, fs.statSync(ext).mode & 0o7777);
        return { stage, files, remove: removal.run };
    } catch (error) {
        removal.run();
        throw error;
    }
}

/** rsync's options that make an extension folder an exact copy of a staged package, keeping the installer's .vsixmanifest (see the top). */
const EXACT_COPY = ['-a', '--checksum', '--delete', '--filter', 'protect /.vsixmanifest'];

/**
 * Install `build` (buildCheckout) into the extension folder `ext`, so that it holds exactly the
 * package (packageFiles), with the installer's metadata kept (package.json's __metadata and
 * .vsixmanifest) and the stamp file. With `sameVersion`, an installed extension of another version
 * is refused, so that the install does not undo what an update of the extension changed. Returns
 * the number of files in the package.
 */
export async function installInto(build, ext, { sameVersion }) {
    const installed = checkVersion(build, ext, sameVersion);
    const { stage, files, remove } = await stagePackage(build, ext, installed);
    try {
        await run(`copying the package into ${ext}`, 'rsync', [...EXACT_COPY, `${stage}/`, `${ext}/`]);
        return files.size;
    } finally {
        remove();
    }
}

/**
 * What installInto(build, ext, { sameVersion }) would change in `ext`, from rsync's dry run:
 * { deleted, added, changed }, the paths that it would delete and add (a folder as a whole, with /
 * at its end) and the files that it would write again with other content.
 */
export async function plannedChanges(build, ext, { sameVersion }) {
    const installed = checkVersion(build, ext, sameVersion);
    const { stage, remove } = await stagePackage(build, ext, installed);
    try {
        const itemized = await output(`comparing ${ext} with the package`, 'rsync', ['-n', '--itemize-changes', ...EXACT_COPY, `${stage}/`, `${ext}/`]);
        const deleted = [];
        const added = [];
        const changed = [];
        for (const line of itemized.split('\n').filter(Boolean)) {
            // rsync's change summary: 11 characters, a space, the path (man rsync, --itemize-changes)
            const [summary, file] = [line.slice(0, 11), line.slice(12)];
            if (summary === '*deleting  ') { deleted.push(file); } else if (summary.slice(2, 11) === '+++++++++') { added.push(file); } else if (summary[0] === '>' && summary[2] === 'c') { changed.push(file); }
        }
        // a path below a folder in the same list is part of that folder
        const outermost = (list) => list.filter(file => !list.some(other => other !== file && other.endsWith('/') && file.startsWith(other)));
        return { deleted: outermost(deleted).sort(), added: outermost(added).sort(), changed: changed.sort() };
    } finally {
        remove();
    }
}

/** The installed package.json of `ext`; with `sameVersion`, fails when its version is not the version of `build`. */
function checkVersion(build, ext, sameVersion) {
    const installed = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
    if (sameVersion && installed.version !== build.version) {
        throw new Error(`${ext} holds version ${installed.version}, and ${build.checkout} builds ${build.version}`);
    }
    return installed;
}

/** The stamp of the extension folder `ext` (STAMP), or undefined when the folder lacks one. */
export function readStamp(ext) {
    const file = path.join(ext, STAMP);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
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
