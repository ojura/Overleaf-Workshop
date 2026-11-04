/* eslint-disable @typescript-eslint/naming-convention -- HTTP headers and browser fixture globals */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');
const browser = globalThis as any;

describe('bounded PDF preview resource transport', function () {
    this.timeout(30_000);
    let dir: string, adapter: any;
    const descriptor = { identity: { key: 'build-a', size: 5000 }, manifestUrl: 'https://reader.test/previews/build-a/manifest.json' };
    const asset = { path: 'assets/photo.jpg', width: 2, height: 1, bytes: 8, sha256: 'a'.repeat(64), mime: 'image/jpeg' };

    function measured() {
        const state = { active: 0, ended: 0, bytes: 0 };
        return { state, beginFetch() { state.active++; return () => { state.active--; state.ended++; }; },
            fetch(bytes: number) { state.bytes += bytes; } };
    }

    before(async () => {
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-preview-http-'));
        await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/pdf-preview-http.ts')],
            outfile: path.join(dir, 'source.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
        await esbuild.stop();
        adapter = await importModule(path.join(dir, 'source.mjs'));
    });
    after(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); } });

    it('reads a bounded manifest and exact image bytes with balanced transfer accounting', async () => {
        const metrics = measured(), requests: any[] = [];
        const manifest = { version: 1, document: { key: 'build-a', size: 5000 }, pages: [] };
        const source = adapter.httpPdfPreviewSource(descriptor, { metrics, fetch: async (url: string, options: any) => {
            requests.push({ url, options });
            return url.endsWith('manifest.json') ? new browser.Response(JSON.stringify(manifest))
                : new browser.Response(new Uint8Array(8).fill(3), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '8' } });
        } });
        const signal = new browser.AbortController().signal;
        assert.deepStrictEqual(await source.loadManifest(signal), manifest);
        assert.deepStrictEqual(await source.loadAsset(asset, signal), new Uint8Array(8).fill(3));
        assert.strictEqual(requests[1].url, 'https://reader.test/previews/build-a/assets/photo.jpg');
        assert.strictEqual(requests[1].options.redirect, 'error');
        assert.strictEqual(requests[1].options.credentials, 'same-origin');
        assert.strictEqual(metrics.state.active, 0);
        assert.strictEqual(metrics.state.ended, 2);
        assert.strictEqual(metrics.state.bytes, Buffer.byteLength(JSON.stringify(manifest)) + 8);
    });

    it('accepts the IDE image/jpg response header for a canonical JPEG asset', async () => {
        const bytes = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]);
        const metrics = measured();
        const source = adapter.httpPdfPreviewSource(descriptor, { metrics, fetch: async () =>
            new browser.Response(bytes, { headers: { 'Content-Type': 'image/jpg', 'Content-Length': String(bytes.length) } }) });
        assert.deepStrictEqual(await source.loadAsset(asset, new browser.AbortController().signal), bytes);
        assert.strictEqual(asset.mime, 'image/jpeg');
        assert.deepStrictEqual(metrics.state, { active: 0, ended: 1, bytes: bytes.length });
    });

    it('cancels an oversized declared manifest before reading its body', async () => {
        let cancelled = 0, reads = 0;
        const metrics = measured();
        const source = adapter.httpPdfPreviewSource(descriptor, { metrics, fetch: async () => ({ status: 200,
            headers: new browser.Headers({ 'Content-Length': String(4 * 1024 * 1024 + 1) }),
            body: { cancel: async () => { cancelled++; }, getReader() { reads++; throw new Error('should not read'); } },
        }) });
        await assert.rejects(source.loadManifest(new browser.AbortController().signal), /length|size/i);
        assert.strictEqual(reads, 0); assert.strictEqual(cancelled, 1);
        assert.strictEqual(metrics.state.active, 0); assert.strictEqual(metrics.state.ended, 1);
    });

    it('stops an undeclared oversized manifest stream and releases its reader', async () => {
        let cancelled = 0, released = 0, reads = 0;
        const metrics = measured();
        const source = adapter.httpPdfPreviewSource(descriptor, { metrics, fetch: async () => ({ status: 200,
            headers: new browser.Headers(), body: { getReader() { return {
                async read() { reads++; return { done: false, value: new Uint8Array(1024 * 1024) }; },
                async cancel() { cancelled++; }, releaseLock() { released++; },
            }; } },
        }) });
        await assert.rejects(source.loadManifest(new browser.AbortController().signal), /bounded|budget/i);
        assert.strictEqual(reads, 5); assert.strictEqual(cancelled, 1); assert.strictEqual(released, 1);
        assert.strictEqual(metrics.state.active, 0);
    });

    it('rejects truncated, oversized and wrong-type assets while ending every transfer', async () => {
        for (const [bytes, mime] of [[7, 'image/jpeg'], [9, 'image/jpeg'], [8, 'text/html']] as const) {
            const metrics = measured();
            const source = adapter.httpPdfPreviewSource(descriptor, { metrics, fetch: async () =>
                new browser.Response(new Uint8Array(bytes), { headers: { 'Content-Type': mime } }) });
            await assert.rejects(source.loadAsset(asset, new browser.AbortController().signal), /length|budget|type/i);
            assert.strictEqual(metrics.state.active, 0); assert.strictEqual(metrics.state.ended, 1);
        }
    });

    it('rejects escaped asset paths and impossible sizes before requesting anything', async () => {
        let calls = 0;
        const source = adapter.httpPdfPreviewSource(descriptor, { metrics: measured(), fetch: async () => { calls++; throw new Error('should not fetch'); } });
        for (const name of ['../other.jpg', '/other.jpg', 'https://elsewhere.test/a.jpg', 'assets/%2e%2e/a.jpg', 'assets/a.jpg?token=x', 'assets//a.jpg']) {
            await assert.rejects(source.loadAsset({ ...asset, path: name }, new browser.AbortController().signal), /path|directory/i);
        }
        await assert.rejects(source.loadAsset({ ...asset, bytes: 4 * 1024 * 1024 + 1 }, new browser.AbortController().signal), /size/i);
        assert.strictEqual(calls, 0);
    });

    it('accepts fetch-decoded compressed responses while enforcing the decoded byte bounds', async () => {
        const manifest = { version: 1, note: 'photo '.repeat(150) };
        const source = adapter.httpPdfPreviewSource(descriptor, { metrics: measured(), fetch: async (url: string) =>
            // Fetch exposes decoded bytes but retains the compressed Content-Length header.
            new browser.Response(url.endsWith('manifest.json') ? JSON.stringify(manifest) : new Uint8Array(8), {
                headers: { 'Content-Encoding': 'gzip', 'Content-Length': '3' },
            }) });
        const signal = new browser.AbortController().signal;
        assert.deepStrictEqual(await source.loadManifest(signal), manifest);
        assert.strictEqual((await source.loadAsset(asset, signal)).byteLength, 8);
    });

    it('treats a missing manifest as one optional request and preserves its change subscription', async () => {
        let calls = 0, cancelled = 0;
        const subscribe = () => () => {};
        const source = adapter.httpPdfPreviewSource(descriptor, { metrics: measured(), onChange: subscribe, fetch: async () => {
            calls++; return { status: 404, body: { async cancel() { cancelled++; } } };
        } });
        assert.strictEqual(await source.loadManifest(new browser.AbortController().signal), null);
        assert.strictEqual(calls, 1); assert.strictEqual(cancelled, 1); assert.strictEqual(source.onChange, subscribe);
    });

    it('cancels and releases a body when its generation ends during a read', async () => {
        const controller = new browser.AbortController(), metrics = measured();
        let cancelled = 0, released = 0, calls = 0;
        const source = adapter.httpPdfPreviewSource(descriptor, { metrics, fetch: async () => {
            calls++;
            return { status: 200, headers: new browser.Headers(), body: { getReader() { return {
                async read() { controller.abort(); return { done: false, value: new Uint8Array(8) }; },
                async cancel() { cancelled++; }, releaseLock() { released++; },
            }; } } };
        } });
        await assert.rejects(source.loadAsset(asset, controller.signal), /stopped|abort/i);
        assert.strictEqual(cancelled, 1); assert.strictEqual(released, 1); assert.strictEqual(metrics.state.active, 0);
        await assert.rejects(source.loadManifest(controller.signal), /stopped|abort/i);
        assert.strictEqual(calls, 1);
    });
});
