import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startHarness } from './server.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));
const request = (origin, route, body) => fetch(origin + route, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-registered-reader-'));
    const stops = [];
    t.after(async () => {
        try { for (const stop of stops.reverse()) { await stop(); } }
        finally { await fs.rm(root, { recursive: true, force: true }); }
    });
    const original = Buffer.alloc(512 * 1024, 0x20);
    original.write('%PDF-1.7\n');
    const identity = { key: hash('registered-build'), sha256: hash(original), size: original.length };
    const directory = path.join(root, identity.key), ext = path.join(root, 'viewer');
    await fs.mkdir(path.join(directory, 'reading'), { recursive: true });
    await fs.mkdir(path.join(directory, 'assets'));
    await fs.mkdir(path.join(ext, 'dist'), { recursive: true });
    for (const engine of ['pdfjs', 'overleaf']) {
        await fs.writeFile(path.join(ext, 'dist', engine + '.html'), `<!doctype html><!--viewer-config--><script data-engine="${engine}"></script>`);
    }
    const layout = Buffer.from('%PDF-1.7\n native ordered text\n%%EOF');
    const image = Buffer.from('first-native-scansecond-native-scan');
    const asset = Buffer.from('small raster');
    const preview = { version: 1, document: { ...identity, pageCount: 1 }, pages: [{ pageNumber: 1,
        assets: [{ path: 'assets/page.jpg', bytes: asset.length, sha256: hash(asset), mime: 'image/jpeg' }] }] };
    const imagePath = 'reading/image-' + hash(image) + '.jpg';
    const chunks = [image.subarray(0, 17), image.subarray(17)];
    const manifest = { version: 1, source: { sha256: identity.sha256, size: identity.size, pageCount: 1 },
        pdf: { path: 'reading/layout-' + hash(layout) + '.pdf', bytes: layout.length, sha256: hash(layout) },
        images: [{ id: 'x1', path: imagePath, bytes: image.length, sha256: hash(image), originalSha256: hash('original encoding'),
            encoding: 'progressive-jpeg', width: 8, height: 8, components: 3, coefficientBytes: 384,
            chunks: chunks.map((bytes, index) => ({ offset: index ? chunks[0].length : 0, bytes: bytes.length, sha256: hash(bytes), scan: index + 1 })) }] };
    await Promise.all([
        fs.writeFile(path.join(directory, 'manifest.json'), json(preview)),
        fs.writeFile(path.join(directory, 'reading.json'), json(manifest)),
        fs.writeFile(path.join(directory, manifest.pdf.path), layout),
        fs.writeFile(path.join(directory, imagePath), image),
        fs.writeFile(path.join(directory, 'assets/page.jpg'), asset),
    ]);
    const originalRequests = [];
    let hold = false, entered, cancelled;
    const atHeld = new Promise(resolve => { entered = resolve; });
    const atCancelled = new Promise(resolve => { cancelled = resolve; });
    const source = http.createServer((req, res) => {
        originalRequests.push(req.headers.range);
        if (hold) {
            res.once('close', cancelled); entered(); return;
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
        if (!range) { res.writeHead(416).end(); return; }
        const start = Number(range[1]), end = Math.min(original.length - 1, Number(range[2]));
        res.writeHead(206, Object.fromEntries([['content-type', 'application/pdf'], ['content-length', end - start + 1],
            ['content-range', `bytes ${start}-${end}/${original.length}`], ['etag', '"fixture-edition"']]));
        res.end(original.subarray(start, end + 1));
    });
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
    stops.push(async () => { source.closeAllConnections(); await new Promise(resolve => source.close(resolve)); });
    const spec = { previewDirectory: directory, identity, readingRevision: hash(json(manifest)),
        originalUrl: `http://127.0.0.1:${source.address().port}/book.pdf`, originalValidator: { header: 'ETag', value: '"fixture-edition"' } };
    return { root, directory, ext, identity, spec, manifest, layout, chunks, originalRequests, stops,
        hold: () => { hold = true; }, atHeld, atCancelled,
        async start(change = {}) {
            const harness = await startHarness({ registered: { ...spec, ...change }, ext, port: 0, cache: path.join(root, 'unused-original-cache') });
            stops.push(harness.close);
            return harness;
        } };
}

async function page(origin, engine = 'pdfjs') {
    const response = await fetch(origin + `/page?engine=${engine}&doc=registered`);
    assert.equal(response.status, 200);
    const html = await response.text();
    return { html, config: JSON.parse(/<script id="viewer-config" type="application\/json">([^<]+)<\/script>/.exec(html)[1]) };
}

test('both adapter routes receive the exact registered descriptors without loading an original book', async t => {
    const f = await fixture(t), h = await f.start();
    const pages = [];
    for (const engine of ['pdfjs', 'overleaf']) {
        const p = await page(h.origin, engine); pages.push(p.config.page);
        assert.equal(p.config.engine, engine);
        assert.match(p.html, new RegExp(`data-engine="${engine}"`));
        assert.deepEqual(p.config.harness.preview.identity, f.identity);
        assert.equal(p.config.harness.reading.manifestRevision, f.spec.readingRevision);
        const manifest = await (await fetch(p.config.harness.reading.manifestUrl)).json();
        assert.deepEqual(manifest.source, f.manifest.source);
        const pdf = await fetch(new URL(manifest.pdf.path, p.config.harness.reading.manifestUrl), { headers: { range: 'bytes=0-7' } });
        assert.equal(pdf.status, 206);
        assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), f.layout.subarray(0, 8));
    }
    assert.notEqual(pages[0], pages[1]);
    assert.deepEqual(f.originalRequests, ['bytes=0-15']);
    assert.equal(await fs.stat(path.join(f.root, 'unused-original-cache')).catch(() => undefined), undefined);
    for (const id of pages) { await request(h.origin, '/page-close', { page: id }); }
    const stats = await (await fetch(h.origin + '/stats')).json();
    assert.equal(stats.pages, 0); assert.equal(stats.originalBytes, 0);
});

test('registered image requests use the production chunk verifier and reject unregistered paths or revisions', async t => {
    const f = await fixture(t), h = await f.start(), p = await page(h.origin);
    const base = { type: 'readingFetch', page: p.config.page, id: 1, manifestRevision: f.spec.readingRevision, imageId: 'x1', chunkIndex: 0 };
    const response = await request(h.origin, '/reading-bridge', base);
    assert.equal(response.headers.get('x-bridge-error'), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.chunks[0]);
    assert.equal(JSON.parse(response.headers.get('x-bridge')).status, 206);
    const batch = await request(h.origin, '/reading-bridge', { ...base, id: 2, chunkCount: 2 });
    assert.equal(batch.headers.get('x-bridge-error'), null);
    assert.deepEqual(Buffer.from(await batch.arrayBuffer()), Buffer.concat(f.chunks));
    for (const change of [{ imageId: '../reading/image.jpg' }, { manifestRevision: hash('other') }, { chunkIndex: 9 }, { chunkCount: 3 }]) {
        const rejected = await request(h.origin, '/reading-bridge', { ...base, ...change, id: 2 });
        assert.ok(rejected.headers.get('x-bridge-error'));
        assert.equal((await rejected.arrayBuffer()).byteLength, 0);
    }
    const directImage = await fetch(h.origin + `/registered/${f.spec.readingRevision}/${f.manifest.images[0].path}`);
    assert.equal(directImage.status, 404);
    const stats = await (await fetch(h.origin + '/stats')).json();
    assert.equal(stats.readingBytes, f.chunks[0].length + Buffer.concat(f.chunks).length); assert.equal(stats.readingActive, 0); assert.equal(stats.bridgeActive, 0);
    assert.deepEqual(f.originalRequests, ['bytes=0-15']);
});

test('wrong registered source or revision fails before any original network read', async t => {
    const f = await fixture(t);
    await assert.rejects(f.start({ identity: { ...f.identity, size: f.identity.size + 1 } }), /differs from the pinned edition/);
    await assert.rejects(f.start({ readingRevision: hash('other publication') }), /differs from the pinned edition/);
    assert.deepEqual(f.originalRequests, []);
});

test('the registered original is range bounded and its live host request is cancelled when its page closes', async t => {
    const f = await fixture(t), h = await f.start(), p = await page(h.origin);
    const output = (await (await fetch(h.origin + '/builds')).json()).a;
    assert.equal((await fetch(h.origin + '/whole')).status, 403);
    assert.equal((await fetch(output.url)).status, 416);
    const whole = await request(h.origin, '/bridge', { page: p.config.page, id: 1, url: output.url });
    assert.match(decodeURIComponent(whole.headers.get('x-bridge-error')), /fetched whole only/);
    f.hold();
    const pending = request(h.origin, '/bridge', { page: p.config.page, id: 2, url: output.url, headers: [['range', 'bytes=32-47']] });
    await f.atHeld;
    await request(h.origin, '/page-close', { page: p.config.page });
    await f.atCancelled;
    const cancelled = await pending;
    assert.ok(cancelled.headers.get('x-bridge-error'));
    const stats = await (await fetch(h.origin + '/stats')).json();
    assert.equal(stats.pages, 0); assert.equal(stats.originalActive, 0); assert.equal(stats.bridgeActive, 0);
    const stale = await request(h.origin, '/reading-bridge', { page: p.config.page, id: 3 });
    assert.equal(stale.status, 500);
    assert.match(await stale.text(), /no longer open/);
});

test('registered resource paths refuse a replaced symlink and leave the outside file unread', async t => {
    const f = await fixture(t), h = await f.start();
    const outside = path.join(f.root, 'outside.pdf');
    await fs.writeFile(outside, f.layout);
    const filename = path.join(f.directory, f.manifest.pdf.path);
    await fs.unlink(filename); await fs.symlink(outside, filename);
    const response = await fetch(h.origin + `/registered/${f.spec.readingRevision}/${f.manifest.pdf.path}`);
    assert.equal(response.status, 500); assert.match(await response.text(), /path changed/);
    assert.deepEqual(f.originalRequests, ['bytes=0-15']);
});

test('the existing fixture host still serves an ordinary adapter and exact bridge response', async t => {
    const f = await fixture(t), book = path.join(f.root, 'ordinary-book');
    await fs.mkdir(book);
    await fs.writeFile(path.join(book, 'fixture.pdf'), f.layout);
    await fs.writeFile(path.join(book, 'builds.json'), json({ a: { file: 'fixture.pdf', size: f.layout.length, ranges: [] },
        b: { file: 'fixture.pdf', size: f.layout.length, ranges: [] } }));
    const h = await startHarness({ book, ext: f.ext, port: 0, latency: 0, cache: path.join(f.root, 'ordinary-cache') });
    f.stops.push(h.close);
    const p = await page(h.origin), output = (await (await fetch(h.origin + '/builds')).json()).a;
    assert.equal(p.config.harness, undefined);
    const result = await request(h.origin, '/bridge', { page: p.config.page, id: 1, url: output.url });
    assert.equal(result.headers.get('x-bridge-error'), null);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), f.layout);
    assert.deepEqual(f.originalRequests, []);
});
