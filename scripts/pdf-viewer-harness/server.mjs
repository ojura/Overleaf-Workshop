// Test server for the PDF viewers of overleaf-workshop, without Overleaf and without VS Code.
//
//   node server.mjs [--book DIR] [--ext DIR] [--port 8765] [--latency 40] [--cache DIR]
//                   [--live <compile-response.json> --live-project <project id>]
//
// It plays three parts:
// - Overleaf's download domain: it serves the builds that make_book.py wrote, with single and
//   multipart Range requests as nginx answers them, and the pieces of Overleaf's PDF caching
//   under /project/<p>/user/<u>/content/<contentId>/<hash>. Each answer waits --latency ms.
//   It also plays Overleaf's cache of compile outputs, which serves a build under
//   /build/<editor>-<build>/ for clsiserverid=harness-cache after the compile server has
//   deleted it; POST /gone?build=a&from=server|everywhere deletes a build.
// - The extension host: POST /bridge runs the extension's own PdfFetchBridge and PieceCache
//   (src/core/pdfFetchBridge.ts, bundled by common.mjs) on a fetch message.
// - The webview: GET /page?engine=overleaf|pdfjs serves <ext>/dist/<engine>.html with
//   <!--viewer-config--> replaced as the provider replaces it, VS Code's default styles for
//   webviews, and stub.js, which stands in for acquireVsCodeApi and the host's messages.
// --ext is a views/pdf-viewer folder (with dist/ and the pdf.js release that package.json pins,
// scripts/viewer-protocol.mjs's pdfjsReleaseFolder), by default the
// checkout's; --book defaults to the 120-page test book in the work folder (common.mjs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { arg, book, bridgeModule, defaultExt, here, work } from './common.mjs';
import { pdfjsReleaseFolder } from '../viewer-protocol.mjs';
// the extension's bridge, bundled as CommonJS
const { PdfFetchBridge, PieceCache, outputsOf } = bridgeModule();

const port = Number(arg('port', '8765'));
const bookDir = path.resolve(arg('book') ?? book());
const extDir = path.resolve(arg('ext', defaultExt));
const latencyMs = Number(arg('latency', '40'));
const cacheDir = path.resolve(arg('cache', path.join(work, 'piece-cache')));
const origin = `http://127.0.0.1:${port}`;

const PROJECT = '0123456789abcdef01234567';
const USER = 'fedcba9876543210fedcba98';
const CONTENT_ID = '19a1b2c3d4e-c0ffee0123456789';
const BOUNDARY = '00000000000000000001';
const BUILD_IDS = { a: '19a1b2c3d4e-0000000000000001', b: '19a1b2c3d4e-0000000000000002' };
// the editor whose compiles made the builds, and the shard of the cache of compile outputs
const EDITOR = '0d9c1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const CACHE_SHARD = 'harness-cache';
/** builds deleted from the compile server ('server') or from the cache as well ('everywhere') */
const gone = new Map();

const builds = JSON.parse(fs.readFileSync(path.join(bookDir, 'builds.json'), 'utf8'));
const files = Object.fromEntries(Object.entries(builds).map(([name, b]) => [name, fs.readFileSync(path.join(bookDir, b.file))]));
const buildByID = Object.fromEntries(Object.entries(BUILD_IDS).map(([name, id]) => [id, name]));
const pieces = new Map(); // hash -> bytes
for (const [name, b] of Object.entries(builds)) {
    for (const r of b.ranges) {
        if (!pieces.has(r.hash)) { pieces.set(r.hash, files[name].subarray(r.start, r.end)); }
    }
}

// --live <compile-response.json> --live-project <id>: the build of a real compile, which the
// extension's bridge fetches from Overleaf's download domain (read only, without a login)
const liveResponse = arg('live') ? JSON.parse(fs.readFileSync(arg('live'), 'utf8')) : undefined;
const liveOutput = liveResponse && (() => {
    const file = liveResponse.outputFiles.find(f => f.path === 'output.pdf');
    const query = new URLSearchParams();
    if (liveResponse.compileGroup) { query.set('compileGroup', liveResponse.compileGroup); }
    if (liveResponse.clsiServerId) { query.set('clsiserverid', liveResponse.clsiServerId); }
    query.set('enable_pdf_caching', 'true');
    return {
        url: `${liveResponse.pdfDownloadDomain}${file.url}?${query}`,
        downloadDomain: liveResponse.pdfDownloadDomain, projectId: arg('live-project'), file,
        clsiCacheShard: liveResponse.clsiCacheShard,
    };
})();
// the provider passes the size of the build in view; here the largest build's stands in for it
const bridge = liveOutput
    ? new PdfFetchBridge(outputsOf(liveOutput.downloadDomain, liveOutput.projectId), new PieceCache(cacheDir, 1024 * 1024 * 1024), { buildSize: () => liveOutput.file.size })
    : new PdfFetchBridge(outputsOf(origin, PROJECT), new PieceCache(cacheDir, 1024 * 1024 * 1024),
        { buildSize: () => Math.max(...Object.values(builds).map(b => b.size)) });
const hostState = new Map(); // doc -> saved state, as GlobalStateManager keeps it per document URI

const emptyStats = () => ({
    outputRequests: 0, outputWholeRequests: 0, outputBytes: 0, outputRanges: 0,
    contentRequests: 0, contentBytes: 0,
    // requests of output.pdf that the cache of compile outputs answered
    cacheRequests: 0,
    bridgeRequests: 0, bridgeBytes: 0, bridgeErrors: 0,
    log: [],
});
let stats = emptyStats();
const startedAt = Date.now();
const note = (entry) => { stats.log.push({ t: Date.now() - startedAt, ...entry }); if (stats.log.length > 5000) { stats.log.shift(); } };

export function outputFor(name) {
    const b = builds[name];
    const id = BUILD_IDS[name];
    const query = new URLSearchParams({ compileGroup: 'standard', clsiserverid: 'harness-clsi', enable_pdf_caching: 'true' });
    const fileUrl = `/project/${PROJECT}/user/${USER}/build/${id}/output/output.pdf`;
    return {
        url: `${origin}${fileUrl}?${query}`,
        downloadDomain: origin,
        projectId: PROJECT,
        file: {
            path: 'output.pdf', url: fileUrl, type: 'pdf', build: id,
            size: b.size, ranges: b.ranges, contentId: CONTENT_ID,
            createdAt: new Date(startedAt).toISOString(), startXRefTable: b.startXRefTable,
            editorId: EDITOR,
        },
        clsiCacheShard: CACHE_SHARD,
    };
}

const TYPES = {
    '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.gif': 'image/gif',
    '.png': 'image/png', '.ftl': 'text/plain', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf', '.icc': 'application/octet-stream', '.map': 'application/json',
};

function serveStatic(res, root, rel) {
    const file = path.resolve(root, '.' + path.posix.normalize('/' + decodeURIComponent(rel)));
    if (!file.startsWith(path.resolve(root))) { res.writeHead(403).end(); return; }
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404).end('not found: ' + rel); return; }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
            'Content-Length': st.size, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache',
        });
        fs.createReadStream(file).pipe(res);
    });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseRanges(header, size) {
    const m = /^bytes=(.+)$/.exec(header ?? '');
    if (!m) { return undefined; }
    return m[1].split(',').map(part => {
        const [a, b] = part.trim().split('-');
        const start = Number(a), end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
        return { start, end: end + 1 };
    });
}

async function serveOutput(req, res, name) {
    const data = files[name];
    const ranges = parseRanges(req.headers.range, data.length);
    await delay(latencyMs);
    stats.outputRequests++;
    if (!ranges) {
        stats.outputWholeRequests++;
        stats.outputBytes += data.length;
        note({ kind: 'output', build: name, whole: true, bytes: data.length });
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
        res.end(req.method === 'HEAD' ? undefined : data);
        return;
    }
    stats.outputRanges += ranges.length;
    const bytes = ranges.reduce((s, r) => s + (r.end - r.start), 0);
    stats.outputBytes += bytes;
    note({ kind: 'output', build: name, ranges: ranges.map(r => `${r.start}-${r.end - 1}`).join(','), bytes });
    if (ranges.length === 1) {
        const [r] = ranges;
        res.writeHead(206, {
            'Content-Type': 'application/pdf', 'Content-Length': r.end - r.start, 'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${r.start}-${r.end - 1}/${data.length}`,
        });
        res.end(req.method === 'HEAD' ? undefined : data.subarray(r.start, r.end));
        return;
    }
    // multipart/byteranges, with the part headers that Overleaf's loader checks byte for byte
    const parts = [];
    for (const r of ranges) {
        parts.push(Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Type: application/pdf\r\nContent-Range: bytes ${r.start}-${r.end - 1}/${data.length}\r\n\r\n`));
        parts.push(data.subarray(r.start, r.end));
    }
    parts.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`));
    const body = Buffer.concat(parts);
    res.writeHead(206, { 'Content-Type': `multipart/byteranges; boundary=${BOUNDARY}`, 'Content-Length': body.length });
    res.end(body);
}

async function serveContent(req, res, hash) {
    const data = pieces.get(hash);
    await delay(latencyMs);
    if (!data) { res.writeHead(404).end(); return; }
    stats.contentRequests++;
    stats.contentBytes += data.length;
    note({ kind: 'content', hash: hash.slice(0, 12), bytes: data.length });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    return Buffer.concat(chunks).toString('utf8');
}

async function serveBridge(req, res) {
    const request = JSON.parse(await readBody(req));
    stats.bridgeRequests++;
    try {
        const t = Date.now();
        const r = await bridge.handle(request);
        stats.bridgeBytes += r.body.byteLength;
        if (liveOutput) {
            const h = Object.fromEntries(r.headers);
            const range = (request.headers ?? []).find(([n]) => n.toLowerCase() === 'range')?.[1];
            const want = range ? range.replace(/^bytes=/, '').split(',').reduce((n, part) => { const [a, b] = part.split('-').map(Number); return n + (b - a + 1); }, 0) : undefined;
            console.error(`BRIDGE ${r.status} ${new URL(request.url).pathname.replace(/^.*\/(build|content)\//, '$1/').slice(0, 70)} range=${range ? (range.length > 80 ? range.slice(0, 80) + '...(' + range.split(',').length + ' parts)' : range) : '-'} want=${want ?? '-'} got=${r.body.byteLength} type=${h['content-type']} len=${h['content-length']} crange=${h['content-range'] ?? '-'} enc=${h['content-encoding'] ?? '-'} ${Date.now() - t} ms`);
        }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'x-bridge': JSON.stringify({ id: r.id, status: r.status, statusText: r.statusText, headers: r.headers }),
        });
        res.end(Buffer.from(r.body.buffer, r.body.byteOffset, r.body.byteLength));
    } catch (error) {
        stats.bridgeErrors++;
        note({ kind: 'bridge-error', message: String(error?.message ?? error) });
        res.writeHead(200, { 'x-bridge-error': encodeURIComponent(String(error?.message ?? error)) });
        res.end();
    }
}

function servePage(res, engine, doc) {
    let html;
    try {
        html = fs.readFileSync(path.join(extDir, 'dist', `${engine}.html`), 'utf8');
    } catch {
        res.writeHead(404).end(`${extDir}/dist/${engine}.html does not exist: npm run build-pdf-viewer writes it`);
        return;
    }
    const vendor = `${origin}/ext/${pdfjsReleaseFolder}`;
    const config = {
        engine,
        pdfjs: {
            build: `${vendor}/build/`, cMapUrl: `${vendor}/web/cmaps/`, standardFontDataUrl: `${vendor}/web/standard_fonts/`,
            wasmUrl: `${vendor}/web/wasm/`, iccUrl: `${vendor}/web/iccs/`, imageResourcesPath: `${vendor}/web/images/`,
        },
    };
    // VS Code adds its default styles for webviews to every page (pre/index.html, _defaultStyles)
    const vscodeStyles = `<style id="_defaultStyles">${fs.readFileSync(path.join(here, 'vscode-default-styles.css'), 'utf8')}</style>`;
    const injected = vscodeStyles + `<base href="${origin}/ext/"><script id="viewer-config" type="application/json">${JSON.stringify(config)}</script>`
        + `<script src="${origin}/harness/stub.js?doc=${encodeURIComponent(doc)}"></script>`;
    if (!html.includes('<!--viewer-config-->')) {
        res.writeHead(500).end('the page does not contain the <!--viewer-config--> placeholder');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html.replace('<!--viewer-config-->', injected));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const p = url.pathname;
    try {
        let m;
        if ((m = new RegExp(`^/project/${PROJECT}/user/${USER}/build/([^/]+)/output/output\\.pdf$`).exec(p))) {
            // the compile server's path /build/<build>/, or the cache's /build/<editor>-<build>/
            const fromCache = url.searchParams.get('clsiserverid') === CACHE_SHARD && m[1].startsWith(`${EDITOR}-`);
            const name = buildByID[fromCache ? m[1].slice(EDITOR.length + 1) : m[1]];
            const deleted = gone.get(name);
            if (!name || deleted === 'everywhere' || (deleted === 'server' && !fromCache)) {
                note({ kind: 'output', build: name, missing: true, fromCache });
                res.writeHead(404).end();
                return;
            }
            if (fromCache) { stats.cacheRequests++; }
            await serveOutput(req, res, name);
        } else if ((m = new RegExp(`^/project/${PROJECT}/user/${USER}/content/${CONTENT_ID}/([0-9a-f]{64})$`).exec(p))) {
            await serveContent(req, res, m[1]);
        } else if (p.startsWith('/ext/')) {
            serveStatic(res, extDir, p.slice('/ext/'.length));
        } else if (p.startsWith('/harness/')) {
            serveStatic(res, here, p.slice('/harness/'.length));
        } else if (p === '/frame') {
            // VS Code's frame structure: the page runs in an iframe of the same origin as its
            // parent, with the inner frame's sandbox and allow lists of the webview's pre/index.html
            const page = `/page?${url.searchParams}`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block;overflow:hidden}</style></head>`
                + `<body><iframe id="active-frame" sandbox="allow-same-origin allow-pointer-lock allow-scripts allow-downloads allow-forms"`
                + ` allow="cross-origin-isolated; autoplay; local-network-access; clipboard-read; clipboard-write;" src="${page}"></iframe></body></html>`);
        } else if (p === '/page') {
            servePage(res, url.searchParams.get('engine') ?? 'overleaf', url.searchParams.get('doc') ?? 'book');
        } else if (p === '/gone' && req.method === 'POST') {
            const name = url.searchParams.get('build') ?? 'a';
            const from = url.searchParams.get('from') ?? 'server';
            if (from === 'none') { gone.delete(name); } else { gone.set(name, from); }
            res.writeHead(204).end();
        } else if (p === '/builds') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(liveOutput ? { a: liveOutput, b: liveOutput } : { a: outputFor('a'), b: outputFor('b') }));
        } else if (p === '/whole') {
            const name = url.searchParams.get('build') ?? 'a';
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': files[name].length }).end(files[name]);
        } else if (p === '/bridge' && req.method === 'POST') {
            await serveBridge(req, res);
        } else if (p === '/bridge-abort' && req.method === 'POST') {
            bridge.abort(JSON.parse(await readBody(req)).id);
            res.writeHead(204).end();
        } else if (p === '/state') {
            const doc = url.searchParams.get('doc') ?? 'book';
            if (req.method === 'POST') { hostState.set(doc, JSON.parse(await readBody(req) || 'null')); res.writeHead(204).end(); }
            else { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(hostState.get(doc) ?? null)); }
        } else if (p === '/stats') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...stats, log: url.searchParams.has('log') ? stats.log : undefined }));
        } else if (p === '/stats/reset' && req.method === 'POST') {
            stats = emptyStats();
            res.writeHead(204).end();
        } else {
            res.writeHead(404).end();
        }
    } catch (error) {
        console.error(error);
        if (!res.headersSent) { res.writeHead(500); }
        res.end(String(error));
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`harness on ${origin}: book ${bookDir}, ext ${extDir}, latency ${latencyMs} ms, piece cache ${cacheDir}`);
});
