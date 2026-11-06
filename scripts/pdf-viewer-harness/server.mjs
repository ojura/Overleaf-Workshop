/* eslint-disable @typescript-eslint/naming-convention -- HTTP fields, file extensions and production exports retain their public names. */
// Test server for the PDF viewers of overleaf-workshop, without Overleaf and without VS Code.
//
//   node server.mjs [--book DIR] [--ext DIR] [--port 8765] [--latency 40] [--cache DIR]
//                   [--live <compile-response.json> --live-project <project id>]
//                   [--registered <owned-registration.json>]
// A registered edition uses the actual PdfPreviewStore and one PdfFetchBridge per page.
// Its JSON pins previewDirectory, identity {key,sha256,size}, readingRevision,
// originalUrl and originalValidator {header:'ETag',value}. The original is probed
// with sixteen bytes and served only in bounded ranges; no original PDF is copied.
// The server does not launch a browser. Use the existing daemon with /page?engine=...
// and close the served page or call POST /page-close before stopping this owner.
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
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { arg, book, defaultExt, here, repo, work } from './common.mjs';
import { pdfjsReleaseFolder } from '../viewer-protocol.mjs';

let hostClasses;
function hostModule() {
    if (hostClasses) { return hostClasses; }
    const bundle = path.join(work, `pdfHarnessHost.${process.pid}.${randomUUID()}.cjs`);
    const require = createRequire(path.join(repo, 'package.json'));
    try {
        require('esbuild').buildSync({
            stdin: { contents: 'export { PdfFetchBridge, PieceCache, outputsOf } from "./src/core/pdfFetchBridge";'
                + 'export { PdfPreviewStore } from "./src/core/pdfPreviewStore";'
                + 'export { PDF_READING_LIMITS, validatePdfReadingManifest } from "./src/core/pdfReadingManifest";', resolveDir: repo },
            bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: bundle, logLevel: 'warning',
        });
        hostClasses = require(bundle);
        return hostClasses;
    } finally { fs.rmSync(bundle, { force: true }); }
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

async function readSmallFile(filename, limit) {
    const file = await fs.promises.open(filename, fileFlags);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > limit) { throw new Error('Registered metadata exceeds its regular-file bound'); }
        const bytes = Buffer.alloc(stat.size);
        for (let offset = 0; offset < bytes.length;) {
            const result = await file.read(bytes, offset, bytes.length - offset, offset);
            if (!result.bytesRead) { throw new Error('Registered metadata ended before its declared size'); }
            offset += result.bytesRead;
        }
        return bytes;
    } finally { await file.close(); }
}

async function registeredEdition(specification, classes) {
    const spec = typeof specification === 'string'
        ? JSON.parse(await readSmallFile(path.resolve(specification), 64 * 1024)) : specification;
    const { identity, previewDirectory, readingRevision, originalUrl, originalValidator } = spec ?? {};
    if (!identity || !hashPattern.test(identity.key ?? '') || !hashPattern.test(identity.sha256 ?? '')
        || !Number.isSafeInteger(identity.size) || identity.size <= 0 || identity.size > classes.PDF_READING_LIMITS.sourceBytes
        || typeof previewDirectory !== 'string' || !path.isAbsolute(previewDirectory)
        || path.basename(previewDirectory) !== identity.key || !hashPattern.test(readingRevision ?? '')
        || !originalValidator || originalValidator.header !== 'ETag' || typeof originalValidator.value !== 'string'
        || !/^"[^"\r\n]+"$/.test(originalValidator.value)) {
        throw new Error('Registered reader requires a pinned build identity, reading revision and original ETag');
    }
    const source = new URL(originalUrl);
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || source.hash) {
        throw new Error('Registered original URL must be HTTP(S) without credentials or a fragment');
    }
    if (await fs.promises.realpath(previewDirectory) !== previewDirectory) { throw new Error('Registered directory cannot contain symlinks'); }
    const store = new classes.PdfPreviewStore(path.dirname(previewDirectory));
    try {
        const descriptor = await store.readingDescriptor(identity);
        if (!descriptor || descriptor.manifestRevision !== readingRevision || descriptor.identity.sha256 !== identity.sha256) {
            throw new Error('The registered reading publication differs from the pinned edition');
        }
        const manifest = JSON.parse(await readSmallFile(descriptor.manifestPath, classes.PDF_READING_LIMITS.manifestBytes));
        const reading = classes.validatePdfReadingManifest(manifest, identity);
        if (!reading) { throw new Error('The registered reading manifest is invalid'); }
        const prefix = `/registered/${readingRevision}/`;
        const resources = new Map();
        const add = (relative, metadata, type) => {
            if (typeof relative !== 'string' || relative.split('/').some(part => !/^[A-Za-z0-9._-]+$/.test(part) || ['.', '..'].includes(part))
                || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > classes.PDF_READING_LIMITS.pdfBytes
                || !hashPattern.test(metadata.sha256 ?? '')) { throw new Error('Registered resource has invalid metadata'); }
            resources.set(prefix + relative, { filename: path.join(previewDirectory, relative), ...metadata, type });
        };
        const readingBytes = await readSmallFile(descriptor.manifestPath, classes.PDF_READING_LIMITS.manifestBytes);
        if (digest(readingBytes) !== readingRevision) { throw new Error('Reading manifest changed during registration'); }
        const previewBytes = await readSmallFile(store.manifestPath(identity), 4 * 1024 * 1024);
        const preview = JSON.parse(previewBytes);
        if (preview.document?.key !== identity.key || preview.document?.size !== identity.size
            || preview.document?.sha256 !== identity.sha256 || preview.document?.pageCount !== reading.source.pageCount) {
            throw new Error('Registered raster and reading editions differ');
        }
        add('reading.json', { bytes: readingBytes.length, sha256: readingRevision }, 'application/json');
        add('manifest.json', { bytes: previewBytes.length, sha256: digest(previewBytes) }, 'application/json');
        add(reading.pdf.path, reading.pdf, 'application/pdf');
        for (const page of preview.pages ?? []) {
            for (const asset of page.assets ?? []) { add(asset.path, asset, asset.mime); }
        }
        const headers = { range: 'bytes=0-15', 'if-range': originalValidator.value, 'accept-encoding': 'identity' };
        const response = await fetch(source, { headers, signal: AbortSignal.timeout(10000) });
        if (response.status !== 206 || response.headers.get('etag') !== originalValidator.value
            || response.headers.get('content-range') !== `bytes 0-15/${identity.size}`
            || response.headers.get('content-length') !== '16') {
            await response.body?.cancel();
            throw new Error('Original PDF no longer matches its registered size and validator');
        }
        let received = 0;
        for await (const bytes of response.body) {
            received += bytes.length;
            if (received > 16) { throw new Error('Original identity probe exceeded sixteen bytes'); }
        }
        if (received !== 16) { throw new Error('Original identity probe was incomplete'); }
        return { identity, source, originalValidator, reading, descriptor, store, resources,
            preview: { identity, manifestUrl: prefix + 'manifest.json' },
            readingDescriptor: { identity: descriptor.identity, manifestRevision: readingRevision, manifestUrl: prefix + 'reading.json' } };
    } catch (error) { store.dispose(); await store.settled(); throw error; }
}

async function serveRegisteredResource(req, res, resource) {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    if (await fs.promises.realpath(resource.filename) !== resource.filename) { throw new Error('Registered resource path changed'); }
    const file = await fs.promises.open(resource.filename, fileFlags);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== resource.bytes) { throw new Error('Registered resource size or type changed'); }
        let start = 0, end = stat.size - 1, status = 200;
        if (req.headers.range) {
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
            if (!range || !Number.isSafeInteger(Number(range[1])) || !Number.isSafeInteger(Number(range[2] || end))
                || Number(range[1]) > Number(range[2] || end) || Number(range[1]) >= stat.size) { res.writeHead(416).end(); return; }
            start = Number(range[1]); end = Math.min(Number(range[2] || end), end); status = 206;
        }
        res.writeHead(status, { 'Content-Type': resource.type, 'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes', ETag: `"${resource.sha256}"`, 'Cache-Control': 'no-store',
            ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}) });
        if (req.method === 'HEAD') { res.end(); return; }
        await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
    } finally { await file.close(); }
}

export async function startHarness(options = {}) {
    if (options.registered && options.live) { throw new Error('Choose one registered edition or live compile response'); }
    const { PdfFetchBridge, PieceCache, outputsOf } = hostModule();
    const registered = options.registered ? await registeredEdition(options.registered, hostModule()) : undefined;
    const port = Number(options.port ?? 8765);
    const bookDir = registered ? undefined : path.resolve(options.book ?? book());
    const extDir = path.resolve(options.ext ?? defaultExt);
    const latencyMs = Number(options.latency ?? 40);
    const cacheDir = path.resolve(options.cache ?? path.join(work, 'piece-cache'));
    let origin = `http://127.0.0.1:${port}`;

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

    const builds = registered ? {} : JSON.parse(fs.readFileSync(path.join(bookDir, 'builds.json'), 'utf8'));
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
    const liveResponse = options.live ? JSON.parse(fs.readFileSync(options.live, 'utf8')) : undefined;
    const liveOutput = liveResponse && (() => {
        const file = liveResponse.outputFiles.find(f => f.path === 'output.pdf');
        const query = new URLSearchParams();
        if (liveResponse.compileGroup) { query.set('compileGroup', liveResponse.compileGroup); }
        if (liveResponse.clsiServerId) { query.set('clsiserverid', liveResponse.clsiServerId); }
        query.set('enable_pdf_caching', 'true');
        return {
            url: `${liveResponse.pdfDownloadDomain}${file.url}?${query}`,
            downloadDomain: liveResponse.pdfDownloadDomain, projectId: options.liveProject, file,
            clsiCacheShard: liveResponse.clsiCacheShard,
        };
    })();
    // the provider passes the size of the build in view; here the largest build's stands in for it
    const pieceCache = registered ? undefined : new PieceCache(cacheDir, 1024 * 1024 * 1024);
    const legacyBridge = registered ? undefined : liveOutput
        ? new PdfFetchBridge(outputsOf(liveOutput.downloadDomain, liveOutput.projectId), pieceCache, { buildSize: () => liveOutput.file.size })
        : new PdfFetchBridge(url => outputsOf(origin, PROJECT)(url), pieceCache,
            { buildSize: () => Math.max(...Object.values(builds).map(b => b.size)) });
    const hostState = new Map(); // doc -> saved state, as GlobalStateManager keeps it per document URI
    const pages = new Map();
    const pending = new Set();
    const originalReads = new Set();

    function registeredOutput() {
        return { url: `${origin}/registered-output/output.pdf`, downloadDomain: origin, projectId: 'registered',
            file: { path: 'output.pdf', url: '/registered-output/output.pdf', type: 'pdf',
                build: registered.identity.key, size: registered.identity.size } };
    }

    function pageOwner(page) {
        const owner = pages.get(page);
        if (!owner) { throw new Error('The requesting harness page is no longer open'); }
        return owner;
    }

    function closePage(page) {
        const owner = pages.get(page);
        if (!owner) { return; }
        pages.delete(page);
        if (owner.bridge !== legacyBridge) { owner.bridge.dispose(); }
        note({ kind: 'page-close', page });
    }

    const emptyStats = () => ({
        outputRequests: 0, outputWholeRequests: 0, outputBytes: 0, outputRanges: 0,
        contentRequests: 0, contentBytes: 0,
        // requests of output.pdf that the cache of compile outputs answered
        cacheRequests: 0,
        bridgeRequests: 0, bridgeBytes: 0, bridgeErrors: 0, bridgeActive: 0,
        readingRequests: 0, readingBytes: 0, readingErrors: 0, readingActive: 0, readingPeakActive: 0,
        originalRequests: 0, originalBytes: 0,
        log: [],
    });
    let stats = emptyStats();
    const startedAt = Date.now();
    const note = (entry) => { stats.log.push({ t: Date.now() - startedAt, ...entry }); if (stats.log.length > 5000) { stats.log.shift(); } };

    function outputFor(name) {
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
        let bytes = 0;
        for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 64 * 1024) { throw new Error('Harness request metadata exceeds 64 KiB'); }
            chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    async function serveBridge(req, res, reading = false) {
        const request = JSON.parse(await readBody(req));
        const owner = pageOwner(request.page);
        const bridge = owner.bridge;
        const abort = () => { if (!res.writableFinished) { bridge.abort(request.id); } };
        res.once('close', abort);
        req.once('aborted', abort);
        stats.bridgeRequests++;
        stats.bridgeActive++;
        try {
            const t = Date.now();
            if (reading) { stats.readingRequests++; }
            const r = await (reading ? bridge.handleReading(request) : bridge.handle(request));
            stats.bridgeBytes += r.body.byteLength;
            if (reading) { stats.readingBytes += r.body.byteLength; }
            note({ kind: reading ? 'reading' : 'bridge', page: request.page, imageId: request.imageId,
                chunkIndex: request.chunkIndex, chunkCount: request.chunkCount ?? 1, bytes: r.body.byteLength, ms: Date.now() - t });
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
            if (reading) { stats.readingErrors++; }
            note({ kind: 'bridge-error', message: String(error?.message ?? error) });
            if (!res.destroyed) {
                res.writeHead(200, { 'x-bridge-error': encodeURIComponent(String(error?.message ?? error)) });
                res.end();
            }
        } finally {
            stats.bridgeActive--;
            res.off('close', abort);
            req.off('aborted', abort);
        }
    }

    async function serveOriginal(req, res) {
        if (!registered || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
        const range = req.headers.range;
        const ranges = parseRanges(range, registered.identity.size);
        if (req.method === 'GET' && (!/^bytes=\d+-\d+(,\d+-\d+)*$/.test(range ?? '') || !ranges?.length || ranges.length > 128
            || ranges.some(value => !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
                || value.start < 0 || value.end <= value.start || value.end > registered.identity.size)
            || ranges.reduce((sum, value) => sum + value.end - value.start, 0) > 16 * 1024 * 1024)) {
            res.writeHead(416).end('Original PDF requests require at most 16 MiB of explicit ranges'); return;
        }
        const controller = new AbortController();
        originalReads.add(controller);
        const abort = () => { if (!res.writableFinished) { controller.abort(); } };
        res.once('close', abort); req.once('aborted', abort);
        try {
            const response = await fetch(registered.source, { method: req.method,
                headers: { ...(range ? { range } : {}), 'if-range': registered.originalValidator.value, 'accept-encoding': 'identity' },
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
            if (response.headers.get('etag') !== registered.originalValidator.value
                || response.status !== (req.method === 'HEAD' ? 200 : 206)) {
                await response.body?.cancel(); throw new Error('Original PDF changed or ignored a bounded range');
            }
            stats.originalRequests++;
            const headers = Object.fromEntries(['content-type', 'content-length', 'content-range', 'etag', 'accept-ranges']
                .map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null));
            res.writeHead(response.status, headers);
            const limit = req.method === 'HEAD' ? 0 : ranges.reduce((sum, value) => sum + value.end - value.start, 0) + 128 * 1024;
            let bytes = 0;
            for await (const block of response.body ?? []) {
                bytes += block.length;
                if (bytes > limit) { controller.abort(); throw new Error('Original range exceeded its byte bound'); }
                stats.originalBytes += block.length;
                if (!res.write(block)) { await new Promise((resolve, reject) => {
                    const clear = () => { res.off('drain', drained); res.off('close', closed); };
                    const drained = () => { clear(); resolve(); };
                    const closed = () => { clear(); reject(new Error('Original response closed')); };
                    res.once('drain', drained); res.once('close', closed);
                }); }
            }
            res.end();
        } finally { originalReads.delete(controller); res.off('close', abort); req.off('aborted', abort); }
    }

    function servePage(res, engine, doc) {
        if (!['pdfjs', 'overleaf'].includes(engine)) { res.writeHead(400).end('Unknown PDF viewer engine'); return; }
        if (pages.size >= 16) { res.writeHead(429).end('Close an owned harness page before opening another'); return; }
        let html;
        try {
            html = fs.readFileSync(path.join(extDir, 'dist', `${engine}.html`), 'utf8');
        } catch {
            res.writeHead(404).end(`${extDir}/dist/${engine}.html does not exist: npm run build-pdf-viewer writes it`);
            return;
        }
        const vendor = `${origin}/ext/${pdfjsReleaseFolder}`;
        const page = randomUUID();
        const bridge = registered ? new PdfFetchBridge(url => url.href === registeredOutput().url,
            undefined, { output: registeredOutput() }) : legacyBridge;
        if (registered) {
            bridge.setReading(registered.descriptor.manifestRevision, async (...args) => {
                stats.readingActive++;
                stats.readingPeakActive = Math.max(stats.readingPeakActive, stats.readingActive);
                try { return await registered.descriptor.readImage(...args); }
                finally { stats.readingActive--; }
            });
        }
        pages.set(page, { bridge });
        const config = {
            engine, page,
            harness: registered ? { preview: { ...registered.preview, manifestUrl: origin + registered.preview.manifestUrl },
                reading: { ...registered.readingDescriptor, manifestUrl: origin + registered.readingDescriptor.manifestUrl } } : undefined,
            pdfjs: {
                build: `${vendor}/build/`, cMapUrl: `${vendor}/web/cmaps/`, standardFontDataUrl: `${vendor}/web/standard_fonts/`,
                wasmUrl: `${vendor}/web/wasm/`, iccUrl: `${vendor}/web/iccs/`, imageResourcesPath: `${vendor}/web/images/`,
            },
        };
        // VS Code adds its default styles for webviews to every page (pre/index.html, _defaultStyles)
        const vscodeStyles = `<style id="_defaultStyles">${fs.readFileSync(path.join(here, 'vscode-default-styles.css'), 'utf8')}</style>`;
        const injected = vscodeStyles + `<base href="${origin}/ext/"><script id="viewer-config" type="application/json">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`
            + `<script src="${origin}/harness/stub.js?doc=${encodeURIComponent(doc)}"></script>`;
        if (!html.includes('<!--viewer-config-->')) {
            closePage(page);
            res.writeHead(500).end('the page does not contain the <!--viewer-config--> placeholder');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html.replace('<!--viewer-config-->', injected));
    }

    async function handle(req, res) {
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
                const selected = registered ? registeredOutput() : liveOutput;
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(selected ? { a: selected, b: selected } : { a: outputFor('a'), b: outputFor('b') }));
            } else if (p === '/whole') {
                if (registered) { res.writeHead(403).end('The registered original is available only in bounded ranges'); return; }
                const name = url.searchParams.get('build') ?? 'a';
                res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': files[name].length }).end(files[name]);
            } else if (p === '/bridge' && req.method === 'POST') {
                await serveBridge(req, res);
            } else if (p === '/reading-bridge' && req.method === 'POST' && registered) {
                await serveBridge(req, res, true);
            } else if (p === '/bridge-abort' && req.method === 'POST') {
                const message = JSON.parse(await readBody(req));
                pages.get(message.page)?.bridge.abort(message.id);
                res.writeHead(204).end();
            } else if (p === '/page-close' && req.method === 'POST') {
                closePage(JSON.parse(await readBody(req)).page);
                res.writeHead(204).end();
            } else if (p === '/registered-output/output.pdf' && registered) {
                await serveOriginal(req, res);
            } else if (registered?.resources.has(p)) {
                await serveRegisteredResource(req, res, registered.resources.get(p));
            } else if (p === '/state') {
                const doc = url.searchParams.get('doc') ?? 'book';
                if (req.method === 'POST') { hostState.set(doc, JSON.parse(await readBody(req) || 'null')); res.writeHead(204).end(); }
                else { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(hostState.get(doc) ?? null)); }
            } else if (p === '/stats') {
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...stats,
                    pages: pages.size, originalActive: originalReads.size,
                    registration: registered && { identity: registered.identity, manifestRevision: registered.descriptor.manifestRevision },
                    log: url.searchParams.has('log') ? stats.log : undefined }));
            } else if (p === '/stats/reset' && req.method === 'POST') {
                if (stats.bridgeActive || originalReads.size) { res.writeHead(409).end('Wait for current host reads before resetting counters'); return; }
                stats = emptyStats();
                res.writeHead(204).end();
            } else {
                res.writeHead(404).end();
            }
        } catch (error) {
            if (res.destroyed) { return; }
            if (!res.headersSent) { res.writeHead(500); }
            res.end(String(error));
        }
    }

    const server = http.createServer((req, res) => {
        const task = handle(req, res).finally(() => pending.delete(task));
        pending.add(task);
    });
    let closing;
    const close = () => closing ??= (async () => {
        for (const page of [...pages.keys()]) { closePage(page); }
        legacyBridge?.dispose();
        registered?.store.dispose();
        for (const controller of originalReads) { controller.abort(); }
        const stopped = new Promise((resolve, reject) => server.close(error => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') { reject(error); } else { resolve(); }
        }));
        server.closeAllConnections();
        await Promise.all([stopped, ...pending]);
        await registered?.store.settled();
        await pieceCache?.dispose();
    })();
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        origin = `http://127.0.0.1:${server.address().port}`;
        return { server, origin, close, registered: registered && { identity: registered.identity,
            manifestRevision: registered.descriptor.manifestRevision } };
    } catch (error) { await close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const owned = await startHarness({ port: Number(arg('port', '8765')), book: arg('book'), ext: arg('ext'),
        latency: Number(arg('latency', '40')), cache: arg('cache'), live: arg('live'), liveProject: arg('live-project'), registered: arg('registered') });
    console.log(`harness on ${owned.origin}${owned.registered ? `: registered ${owned.registered.identity.key}` : ''}`);
    const close = () => { owned.close().catch(error => { console.error(error); process.exitCode = 1; }); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
}
