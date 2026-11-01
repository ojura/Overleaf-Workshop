// What the harness's scripts share: where they find the extension, and the work folder where they
// write what they generate (test books, browser profiles, piece caches, screenshots, results).
// Set PDF_VIEWER_HARNESS_WORK to choose the work folder; it defaults to pdf-viewer-harness in the
// system's temporary folder, outside the checkout.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onCleanup } from '../lib/cleanup.mjs';
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
// are stopped also when it ends without them.

/** The value of the option `--name`, or `fallback`. */
export const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
};

/** A file in the work folder's shots/ folder, which is created when missing. */
export function shotPath(name) {
    const dir = path.join(work, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
}

/**
 * The book `name` in the work folder, which the Python script `writer` writes, with `args`, the
 * first time it is asked for. A book is complete once its builds.json exists, which the script
 * writes last. The script writes into a new folder next to the book's, which then takes the
 * book's name, so that a run that is cut short cannot leave a book without some of its files
 * under that name; a folder of that name without builds.json is left from an older version of
 * this function, and is replaced. The scripts write the same bytes every time (make_book.py seeds
 * its random data), so when two first runs write a book at once, it does not matter whose folder
 * ends up under the name.
 */
function writtenBook(name, writer, args = []) {
    const dir = path.join(work, name);
    if (fs.existsSync(path.join(dir, 'builds.json'))) { return dir; }
    const fresh = fs.mkdtempSync(`${dir}.new-`);
    const removal = onCleanup(() => fs.rmSync(fresh, { recursive: true, force: true }));
    try {
        execFileSync('python3', ['-I', path.join(here, writer), fresh, ...args], { stdio: 'inherit' });
        if (!fs.existsSync(path.join(fresh, 'builds.json'))) { throw new Error(`${writer} ended without writing builds.json into ${fresh}`); }
        // the rename fails while a folder of that name is not empty: a leftover without builds.json,
        // which goes, or the book of another run that renamed its folder first, which stays
        if (!fs.existsSync(path.join(dir, 'builds.json'))) { fs.rmSync(dir, { recursive: true, force: true }); }
        try {
            fs.renameSync(fresh, dir);
        } catch (error) {
            if (!['ENOTEMPTY', 'EEXIST'].includes(error.code) || !fs.existsSync(path.join(dir, 'builds.json'))) { throw error; }
        }
    } finally {
        removal.run();
    }
    return dir;
}

/** The test book of make_book.py, 120 pages with an image of 1 MB on each, in the folder book/ of the work folder. */
export const book = () => writtenBook('book', 'make_book.py', ['120', '1024']);

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
 * Start server.mjs on `port` with an empty piece cache of its own (piece-cache-<name>-<port> in the
 * work folder) and wait until it listens. stop() stops the server and deletes the piece cache; when the
 * script ends first, its clean-up kills the server and deletes the piece cache. `args` are
 * more options for server.mjs; `stderr: 'pipe'` lets the caller read the server's errors.
 */
export async function startServer({ name, port, ext = defaultExt, bookDir = book(), latency = 20, args = [], stderr = 'inherit' }) {
    const cache = path.join(work, `piece-cache-${name}-${port}`);
    fs.rmSync(cache, { recursive: true, force: true });
    const server = spawn(process.execPath, [path.join(here, 'server.mjs'), '--ext', ext, '--book', bookDir,
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
