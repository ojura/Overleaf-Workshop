// What the harness's scripts share: where they find the extension, and the work folder where they
// write what they generate (test books, browser profiles, piece caches, screenshots, results).
// Set PDF_VIEWER_HARNESS_WORK to choose the work folder; it defaults to pdf-viewer-harness in the
// system's temporary folder, outside the checkout.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onCleanup, spawnTied } from '../lib/cleanup.mjs';
import { launchChrome } from './cdp.mjs';

/** the harness's folder, scripts/pdf-viewer-harness/ */
export const here = path.dirname(fileURLToPath(import.meta.url));
/** the checkout */
export const repo = path.resolve(here, '../..');
/** the checkout's PDF viewers: views/pdf-viewer/ with dist/ (npm run build-pdf-viewer) and vendor/pdfjs-5.1.91/ (npm run download-pdfjs) */
export const defaultExt = path.join(repo, 'views/pdf-viewer');
export const work = path.resolve(process.env.PDF_VIEWER_HARNESS_WORK ?? path.join(os.tmpdir(), 'pdf-viewer-harness'));
fs.mkdirSync(work, { recursive: true });

// Ctrl+C, and the SIGTERM of a time limit, end a script as scripts/lib/cleanup.mjs describes: the
// command that it awaits fails, its finally blocks run, and the server and Chrome that it started
// are stopped also when it ends without them. When a SIGKILL ends the script before its clean-ups
// can run, the kernel kills the server and Chrome (spawnTied), and their folders stay in the work
// folder.

/**
 * The value of server.mjs's option `--name` (`--name value` or `--name=value`), or `fallback`; an
 * option given without its value ends the script with exit status 64. server.mjs reads its options
 * this way; the other scripts name theirs (scriptOptions in scripts/lib/options.mjs), which also
 * refuses an option that the script does not have.
 */
export const arg = (name, fallback) => {
    const argv = process.argv.slice(2);
    const inline = argv.find(a => a.startsWith(`--${name}=`));
    if (inline !== undefined) { return inline.slice(name.length + 3); }
    const i = argv.indexOf(`--${name}`);
    if (i < 0) { return fallback; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
        console.error(`--${name} needs a value`);
        process.exit(64);
    }
    return argv[i + 1];
};

/**
 * The checks of a script: check(name, ok, detail) prints PASS or FAIL and records the check;
 * measure(name, detail) prints a measurement, which does not count as a check; summary() prints ALL
 * PASS, or SOME FAILED with the count, and sets the exit status: 0 when every check passed and
 * there was at least one, 1 otherwise. `results` holds { name, ok, detail } for each check.
 */
export function checker() {
    const results = [];
    const check = (name, ok, detail = '') => {
        results.push({ name, ok: !!ok, detail });
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
        return !!ok;
    };
    const measure = (name, detail) => { console.log(`MEASURED  ${name}  (${detail})`); };
    const summary = () => {
        const failed = results.filter(r => !r.ok).length;
        const passed = results.length > 0 && failed === 0;
        console.log(passed ? 'ALL PASS' : `SOME FAILED (${failed} of ${results.length})`);
        process.exitCode = passed ? 0 : 1;
        return passed;
    };
    return { check, measure, summary, results };
}

/** A file in the work folder's shots/ folder, which is created when missing. */
export function shotPath(name) {
    const dir = path.join(work, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
}

/**
 * The book `name` in the work folder, which the Python script `writer` writes, with `args`, the
 * first time it is asked for. A book is complete once its book.json exists, which the script
 * writes last (bookFacts). The script writes into a new folder next to the book's, which then takes
 * the book's name, so that a run that is cut short cannot leave a book without some of its files
 * under that name; a folder of that name without book.json is left from an older version of this
 * function or of the writer, and is replaced. The scripts write the same bytes every time
 * (make_book.py seeds its random data), so when two first runs write a book at once, it does not
 * matter whose folder ends up under the name.
 */
function writtenBook(name, writer, args = []) {
    const dir = path.join(work, name);
    const complete = (folder) => fs.existsSync(path.join(folder, 'book.json'));
    if (complete(dir)) { return dir; }
    const fresh = fs.mkdtempSync(`${dir}.new-`);
    const removal = onCleanup(() => fs.rmSync(fresh, { recursive: true, force: true }));
    try {
        execFileSync('python3', ['-I', path.join(here, writer), fresh, ...args], { stdio: 'inherit' });
        if (!complete(fresh)) { throw new Error(`${writer} ended without writing book.json into ${fresh}`); }
        // the rename fails while a folder of that name is not empty: a leftover without book.json,
        // which goes, or the book of another run that renamed its folder first, which stays
        if (!complete(dir)) { fs.rmSync(dir, { recursive: true, force: true }); }
        try {
            fs.renameSync(fresh, dir);
        } catch (error) {
            if (!['ENOTEMPTY', 'EEXIST'].includes(error.code) || !complete(dir)) { throw error; }
        }
    } finally {
        removal.run();
    }
    return dir;
}

/**
 * What the writer of the book in the folder `dir` wrote into its book.json, for the scripts to
 * check against: `pages`, `text`, a text that every page holds, and for make_book.py's books
 * `chapters` ({ title, page } for each entry of the outline), for theme_book.py's `elements` (the
 * box [x0, y0, x1, y1] in PDF points of each thing on its page).
 */
export function bookFacts(dir) {
    const file = path.join(dir, 'book.json');
    if (!fs.existsSync(file)) { throw new Error(`${file} does not exist: ${dir} is not a book of make_book.py or theme_book.py, or one that an older version of them wrote`); }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * A test book of make_book.py in the folder `name` of the work folder: `pages` pages with an image
 * of `imageKb` KB on each; by default the 120-page book in book/. The name stands for the book, so a
 * caller that asks for other pages or images gives it another name, as probes/toolbar-shots.mjs
 * does.
 */
export const book = (name = 'book', pages = 120, imageKb = 1024) => writtenBook(name, 'make_book.py', [String(pages), String(imageKb)]);

/** The one-page book of theme_book.py, for the color themes, in the folder book-theme/ of the work folder. */
export const themeBook = () => writtenBook('book-theme', 'theme_book.py');

/**
 * The extension's fetch bridge and piece cache (src/core/pdfFetchBridge.ts), bundled for Node with
 * esbuild at every start (it takes about 0.1 s), so the server runs the checkout's current code.
 */
export function bridgeModule() {
    const bundle = path.join(work, `pdfFetchBridge.${process.pid}.cjs`);
    const esbuild = createRequire(path.join(repo, 'package.json'))('esbuild');
    esbuild.buildSync({ entryPoints: [path.join(repo, 'src/core/pdfFetchBridge.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: bundle, logLevel: 'warning' });
    try {
        return createRequire(import.meta.url)(bundle);
    } finally {
        fs.rmSync(bundle, { force: true });
    }
}

/**
 * A TCP port of 127.0.0.1 that is free at this moment: the one that the kernel gives a socket that
 * listens on port 0, which then closes. Another process can take it before server.mjs listens on
 * it; server.mjs then ends, and startServer fails, naming the port.
 */
async function freePort() {
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

/**
 * Start server.mjs on `port`, by default a port that is free when it starts (freePort), with an
 * empty piece cache of its own (piece-cache-<name>-<port> in the work folder) and wait until it
 * listens. stop() stops the server and deletes the piece cache; when the
 * script ends first, its clean-up kills the server and deletes the piece cache, and when a SIGKILL
 * ends the script, the kernel kills the server (spawnTied); the piece cache then stays. `args` are
 * more options for server.mjs; `stderr: 'pipe'` lets the caller read the server's errors.
 */
export async function startServer({ name, port, ext = defaultExt, bookDir = book(), latency = 20, args = [], stderr = 'inherit' }) {
    port ??= await freePort();
    const cache = path.join(work, `piece-cache-${name}-${port}`);
    fs.rmSync(cache, { recursive: true, force: true });
    const server = spawnTied(process.execPath, [path.join(here, 'server.mjs'), '--ext', ext, '--book', bookDir,
        '--latency', String(latency), '--cache', cache, '--port', String(port), ...args], { stdio: ['ignore', 'pipe', stderr] });
    const cleanup = onCleanup(() => {
        server.kill('SIGKILL');
        fs.rmSync(cache, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    });
    await new Promise((resolve, reject) => {
        server.stdout.on('data', (d) => { if (String(d).includes('harness on')) { resolve(); } });
        server.once('exit', (code, signal) => reject(new Error(`server.mjs ended (${signal ?? `exit code ${code}`}) before it listened on port ${port}`)));
    });
    const stop = () => new Promise((resolve) => {
        cleanup.cancel();
        const removeCache = () => {
            fs.rmSync(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            resolve();
        };
        if (server.exitCode !== null || server.signalCode !== null) { removeCache(); return; }
        server.once('exit', removeCache);
        server.kill();
    });
    return { origin: `http://127.0.0.1:${port}`, server, stop };
}

/**
 * Start the server and headless Chrome for a probe, with the Runtime and Page domains enabled on
 * Chrome's page. `name` and `port` keep the piece cache apart from other runs; Chrome gets a new
 * profile in the work folder each time. close() stops both.
 */
export async function openHarness({ name, port, width, height, ...serverOptions }) {
    const server = await startServer({ name, port, ...serverOptions });
    const chrome = await launchChrome({ dir: work, width, height });
    await chrome.page.send('Runtime.enable');
    await chrome.page.send('Page.enable');
    return {
        page: chrome.page, origin: server.origin, server: server.server,
        close: async () => { await chrome.close(); await server.stop(); },
    };
}
