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
import { launchChrome } from './cdp.mjs';

/** the harness's folder, scripts/pdf-viewer-harness/ */
export const here = path.dirname(fileURLToPath(import.meta.url));
/** the checkout */
export const repo = path.resolve(here, '../..');
/** the checkout's PDF viewers: views/pdf-viewer/ with dist/ (npm run build-pdf-viewer) and vendor/pdfjs-5.1.91/ (npm run download-pdfjs) */
export const defaultExt = path.join(repo, 'views/pdf-viewer');
export const work = path.resolve(process.env.PDF_VIEWER_HARNESS_WORK ?? path.join(os.tmpdir(), 'pdf-viewer-harness'));
fs.mkdirSync(work, { recursive: true });

// Ctrl+C, and the SIGTERM of a timeout, end a script through process.exit, which runs the 'exit'
// handlers that stop the server and Chrome the script started.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(signal, () => process.exit(code));
}

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

/** A test book of make_book.py in the work folder, written the first time it is asked for. */
export function book(name = 'book', pages = 120, imageKb = 1024) {
    const dir = path.join(work, name);
    if (!fs.existsSync(path.join(dir, 'builds.json'))) {
        execFileSync('python3', ['-I', path.join(here, 'make_book.py'), dir, String(pages), String(imageKb)], { stdio: 'inherit' });
    }
    return dir;
}

/** The one-page book of theme_book.py, for the color themes. */
export function themeBook() {
    const dir = path.join(work, 'book-theme');
    if (!fs.existsSync(path.join(dir, 'builds.json'))) {
        execFileSync('python3', ['-I', path.join(here, 'theme_book.py'), dir], { stdio: 'inherit' });
    }
    return dir;
}

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
 * work folder) and wait until it listens. stop() stops the server and deletes the piece cache; when this
 * process exits first, it kills the server and deletes the piece cache on the way out. `args` are
 * more options for server.mjs; `stderr: 'pipe'` lets the caller read the server's errors.
 */
export async function startServer({ name, port, ext = defaultExt, bookDir = book(), latency = 20, args = [], stderr = 'inherit' }) {
    const cache = path.join(work, `piece-cache-${name}-${port}`);
    fs.rmSync(cache, { recursive: true, force: true });
    const server = spawn(process.execPath, [path.join(here, 'server.mjs'), '--ext', ext, '--book', bookDir,
        '--latency', String(latency), '--cache', cache, '--port', String(port), ...args], { stdio: ['ignore', 'pipe', stderr] });
    const onExit = () => {
        server.kill('SIGKILL');
        try { fs.rmSync(cache, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* the next start deletes it */ }
    };
    process.once('exit', onExit);
    await new Promise((resolve, reject) => {
        server.stdout.on('data', (d) => { if (String(d).includes('harness on')) { resolve(); } });
        server.once('exit', (code, signal) => reject(new Error(`server.mjs ended (${signal ?? `exit code ${code}`}) before it listened on port ${port}`)));
    });
    const stop = () => new Promise((resolve) => {
        process.removeListener('exit', onExit);
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
