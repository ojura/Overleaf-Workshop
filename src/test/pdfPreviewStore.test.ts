import * as assert from 'assert';
import { execFileSync, fork } from 'child_process';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PdfDiskCache } from '../core/pdfDiskCache';
import { PdfPreviewExportError, PdfPreviewStore } from '../core/pdfPreviewStore';
import type { PdfOutput, PdfPreviewIdentity } from '../core/viewerProtocol';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
};

class Watch extends EventEmitter {
    closed = false;
    constructor(readonly directory: string, readonly callback: (event: string, filename: string) => void) { super(); }
    change(filename: string) { this.callback('rename', filename); }
    close() { this.closed = true; }
}

describe('exact-build local PDF preview registration', () => {
    let base: string, root: string, store: PdfPreviewStore;
    const watches: Watch[] = [];
    const cleanups: Array<() => void> = [];
    const identity: PdfPreviewIdentity = { key: 'a'.repeat(64), size: 1024 };
    const nativeFs = require('fs') as typeof fs;
    const originalWatch = nativeFs.watch;
    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-preview-store-'));
        root = path.join(base, 'previews'); store = new PdfPreviewStore(root);
        watches.length = 0;
        nativeFs.watch = ((directory: fs.PathLike, _options: unknown, callback: (event: string, filename: string) => void) => {
            const watch = new Watch(String(directory), callback); watches.push(watch); return watch;
        }) as any;
    });
    afterEach(async () => {
        cleanups.splice(0).forEach(cleanup => cleanup());
        store.dispose(); await store.settled();
        nativeFs.watch = originalWatch;
        fs.rmSync(base, { recursive: true, force: true });
    });
    const watchAt = (directory: string) => [...watches].reverse().find(watch => watch.directory === directory && !watch.closed)!;
    const manifest = (source = identity) => ({ version: 1, document: { ...source, pageCount: 1 }, pages: [] });
    async function publish(value: unknown) {
        const directory = store.directory(identity);
        fs.mkdirSync(directory, { recursive: true });
        const temporary = path.join(directory, 'manifest.next');
        fs.writeFileSync(temporary, JSON.stringify(value));
        fs.renameSync(temporary, path.join(directory, 'manifest.json'));
    }

    const reading = () => ({ version: 1, source: { sha256: 'c'.repeat(64), size: identity.size, pageCount: 1 },
        pdf: { path: 'reading/document.pdf', sha256: 'd'.repeat(64), bytes: 100 }, images: [] });

    it('binds structural source discovery to the registered original digest and exact manifest bytes', async () => {
        await publish(manifest({ ...identity, sha256: 'c'.repeat(64) }));
        const filename = path.join(store.directory(identity), 'reading.json');
        const value = reading(), bytes = Buffer.from(JSON.stringify(value));
        fs.writeFileSync(filename, bytes);
        const registered = await store.readingDescriptor(identity);
        assert.ok(registered);
        const { readImage, ...descriptor } = registered;
        assert.strictEqual(typeof readImage, 'function');
        assert.deepStrictEqual(descriptor, {
            identity: { sha256: 'c'.repeat(64), size: identity.size }, manifestPath: filename, manifestRevision: digest(bytes),
        });
        for (const change of ['digest', 'size', 'pages']) {
            const wrong = reading();
            if (change === 'digest') { wrong.source.sha256 = 'e'.repeat(64); }
            if (change === 'size') { wrong.source.size++; }
            if (change === 'pages') { wrong.source.pageCount++; }
            fs.writeFileSync(filename, JSON.stringify(wrong));
            assert.strictEqual(await store.readingDescriptor(identity), undefined, change);
        }
        fs.unlinkSync(filename);
        const outside = path.join(base, 'reading.json'); fs.writeFileSync(outside, bytes);
        fs.symlinkSync(outside, filename);
        assert.strictEqual(await store.readingDescriptor(identity), undefined, 'linked manifests are never admitted');
    });

    it('reads only the registered scan and verifies its immutable bytes before delivery', async () => {
        await publish(manifest({ ...identity, sha256: 'c'.repeat(64) }));
        const bytes = new Uint8Array([255, 216, 3, 4, 5, 6, 7, 8, 9, 10, 255, 217]);
        const directory = store.directory(identity), filename = path.join(directory, 'reading', 'x1.jpg');
        fs.mkdirSync(path.dirname(filename)); fs.writeFileSync(filename, bytes);
        const value = { ...reading(), images: [{ id: 'x1', path: 'reading/x1.jpg', bytes: bytes.length,
            sha256: digest(bytes), originalSha256: 'e'.repeat(64), width: 8, height: 8, components: 3,
            encoding: 'progressive-jpeg', coefficientBytes: 768, chunks: [
                { offset: 0, bytes: 6, sha256: digest(bytes.slice(0, 6)), scan: 1 },
                { offset: 6, bytes: 6, sha256: digest(bytes.slice(6)), scan: 2 },
            ] }] };
        fs.writeFileSync(path.join(directory, 'reading.json'), JSON.stringify(value));
        const registered = (await store.readingDescriptor(identity))!;
        const signal = new AbortController().signal;
        const chunk = await registered.readImage('x1', 1, signal);
        assert.deepStrictEqual(new Uint8Array(chunk.body), bytes.slice(6));
        assert.deepStrictEqual([chunk.offset, chunk.total], [6, 12]);
        await assert.rejects(registered.readImage('../x1', 0, signal), /Unknown/);
        await assert.rejects(registered.readImage('x1', 2, signal), /Unknown/);
        // A later manifest cannot alter the partition or hashes already authorized for this reader.
        fs.writeFileSync(path.join(directory, 'reading.json'), JSON.stringify(reading()));
        assert.deepStrictEqual(new Uint8Array((await registered.readImage('x1', 0, signal)).body), bytes.slice(0, 6));
        const damaged = bytes.slice(); damaged[8] ^= 1; fs.writeFileSync(filename, damaged);
        await assert.rejects(registered.readImage('x1', 1, signal), /digest/);
        fs.unlinkSync(filename);
        const outside = path.join(base, 'outside.jpg'); fs.writeFileSync(outside, bytes); fs.symlinkSync(outside, filename);
        await assert.rejects(registered.readImage('x1', 0, signal), /regular local files/);
        fs.unlinkSync(filename); fs.writeFileSync(filename, bytes);
        const cancelled = new AbortController(); cancelled.abort();
        await assert.rejects(registered.readImage('x1', 0, cancelled.signal), /stopped/);
        store.dispose();
        await assert.rejects(registered.readImage('x1', 0, signal), /stopped/);
    });

    it('reads a manifest-authorized scan batch and rejects a corrupt later scan', async () => {
        await publish(manifest({ ...identity, sha256: 'c'.repeat(64) }));
        const bytes = new Uint8Array([255, 216, 3, 4, 5, 6, 7, 8, 9, 10, 255, 217]);
        const directory = store.directory(identity), filename = path.join(directory, 'reading', 'x1.jpg');
        fs.mkdirSync(path.dirname(filename)); fs.writeFileSync(filename, bytes);
        const value = { ...reading(), images: [{ id: 'x1', path: 'reading/x1.jpg', bytes: bytes.length,
            sha256: digest(bytes), originalSha256: 'e'.repeat(64), width: 8, height: 8, components: 3,
            encoding: 'progressive-jpeg', coefficientBytes: 768, chunks: [0, 4, 8].map((offset, index) => ({
                offset, bytes: 4, sha256: digest(bytes.subarray(offset, offset + 4)), scan: index + 1,
            })) }] };
        fs.writeFileSync(path.join(directory, 'reading.json'), JSON.stringify(value));
        const registered = (await store.readingDescriptor(identity))!, signal = new AbortController().signal;
        const batch = await registered.readImage('x1', 1, signal, 2);
        assert.deepStrictEqual(new Uint8Array(batch.body), bytes.slice(4));
        assert.deepStrictEqual([batch.offset, batch.total], [4, 12]);
        for (const count of [0, -1, 1.5, 3, '2', null]) {
            await assert.rejects(registered.readImage('x1', 1, signal, count as number), /Unknown/);
        }
        const damaged = bytes.slice(); damaged[9] ^= 1; fs.writeFileSync(filename, damaged);
        await assert.rejects(registered.readImage('x1', 1, signal, 2), /digest/);
        const cancelled = new AbortController(); cancelled.abort();
        await assert.rejects(registered.readImage('x1', 1, cancelled.signal, 2), /stopped/);
    });

    for (const target of ['manifest.json', 'reading.json', 'reading/x1.jpg']) {
        it('rejects a no-writer FIFO at ' + target + ' without blocking discovery or image admission', async function () {
            if (process.platform === 'win32') { this.skip(); }
            this.timeout(7000);
            await publish(manifest({ ...identity, sha256: 'c'.repeat(64) }));
            const directory = store.directory(identity), filename = path.join(directory, target);
            const bytes = Buffer.from([255, 216, 255, 217]);
            fs.mkdirSync(path.join(directory, 'reading'));
            fs.writeFileSync(path.join(directory, 'reading', 'x1.jpg'), bytes);
            fs.writeFileSync(path.join(directory, 'reading.json'), JSON.stringify({ ...reading(), images: [{
                id: 'x1', path: 'reading/x1.jpg', bytes: bytes.length, sha256: digest(bytes), originalSha256: digest(bytes),
                width: 8, height: 8, components: 3, encoding: 'original',
            }] }));
            fs.unlinkSync(filename); execFileSync('mkfifo', [filename]);
            assert.ok(fs.lstatSync(filename).isFIFO());
            // A blocking open cannot be cancelled in Node. Isolate it so the regression's
            // failure deadline can kill and reap only this child, including its libuv work.
            const helper = path.join(base, 'fifo-reader.cjs');
            fs.writeFileSync(helper, [
                "const fs = require('fs');",
                "const { PdfPreviewStore } = require(process.argv[2]);",
                "const store = new PdfPreviewStore(process.argv[3]);",
                "const identity = JSON.parse(process.argv[4]), filename = process.argv[5], image = process.argv[6] === 'image';",
                "const originalOpen = fs.promises.open; let opened = 0, closed = 0;",
                "fs.promises.open = async (...args) => {",
                "  const tracked = String(args[0]) === filename; if (tracked) process.send({ type: 'opening' });",
                "  const handle = await originalOpen(...args);",
                "  if (tracked) { opened++; const close = handle.close.bind(handle); handle.close = async () => { await close(); closed++; }; }",
                "  return handle;",
                "};",
                "(async () => {",
                "  const registered = await store.readingDescriptor(identity); let rejected = !registered;",
                "  if (image) { if (!registered) throw new Error('Image fixture was not registered');",
                "    try { await registered.readImage('x1', 0, new AbortController().signal); } catch { rejected = true; } }",
                "  store.dispose(); await store.settled(); process.send({ type: 'result', rejected, opened, closed }); process.disconnect();",
                "})().catch(error => { store.dispose(); process.send({ type: 'failure', message: error.message }); process.disconnect(); process.exitCode = 1; });",
            ].join('\n'));
            const child = fork(helper, [require.resolve('../core/pdfPreviewStore'), root, JSON.stringify(identity), filename,
                target.startsWith('reading/') ? 'image' : 'discovery'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
            let timer: NodeJS.Timeout | undefined, stderr = '';
            child.stderr!.on('data', value => { stderr += value; });
            try {
                const result = await new Promise<{ rejected: boolean; opened: number; closed: number }>((resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('FIFO child did not start: ' + stderr)), 5000);
                    child.once('error', reject);
                    child.once('exit', code => { if (code !== 0) { reject(new Error('FIFO child exited: ' + code + ' ' + stderr)); } });
                    child.on('message', (message: any) => {
                        if (message.type === 'opening') {
                            clearTimeout(timer);
                            timer = setTimeout(() => reject(new Error('No-writer FIFO blocked the file open: ' + target)), 1000);
                        } else if (message.type === 'result') { resolve(message); }
                        else if (message.type === 'failure') { reject(new Error(message.message)); }
                    });
                });
                assert.deepStrictEqual(result, { type: 'result', rejected: true, opened: 1, closed: 1 });
            } finally {
                clearTimeout(timer);
                if (child.exitCode === null) { child.kill('SIGKILL'); }
                await closed;
            }
        });
    }

    it('closes late-opened reading files after cancellation or store disposal', async () => {
        await publish(manifest({ ...identity, sha256: 'c'.repeat(64) }));
        const directory = store.directory(identity), imagePath = path.join(directory, 'reading', 'x1.jpg');
        const bytes = Buffer.from([255, 216, 255, 217]);
        fs.mkdirSync(path.dirname(imagePath)); fs.writeFileSync(imagePath, bytes);
        fs.writeFileSync(path.join(directory, 'reading.json'), JSON.stringify({ ...reading(), images: [{
            id: 'x1', path: 'reading/x1.jpg', bytes: bytes.length, sha256: digest(bytes), originalSha256: digest(bytes),
            width: 8, height: 8, components: 3, encoding: 'original',
        }] }));
        for (const operation of ['discovery', 'image']) {
            for (const phase of ['open', 'stat']) {
                const currentStore = new PdfPreviewStore(root), abort = new AbortController();
                const registered = (await currentStore.readingDescriptor(identity))!;
                const filename = operation === 'image' ? imagePath : path.join(directory, 'reading.json');
                const entered = deferred(), release = deferred(), originalOpen = fs.promises.open;
                let closes = 0, reads = 0;
                fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
                    const handle = await originalOpen(...args);
                    if (String(args[0]) === filename) {
                        const close = handle.close.bind(handle), read = handle.read.bind(handle), stat = handle.stat.bind(handle);
                        handle.close = async () => { await close(); closes++; };
                        handle.read = ((...values: Parameters<typeof handle.read>) => { reads++; return read(...values); }) as typeof handle.read;
                        if (phase === 'open') { entered.resolve(); await release.promise; }
                        else { handle.stat = (async () => { const value = await stat(); entered.resolve(); await release.promise; return value; }) as typeof handle.stat; }
                    }
                    return handle;
                }) as typeof originalOpen;
                const pending = operation === 'image'
                    ? assert.rejects(registered.readImage('x1', 0, abort.signal), /stopped/)
                    : currentStore.readingDescriptor(identity).then(value => assert.strictEqual(value, undefined));
                try {
                    await entered.promise;
                    if (operation === 'image') { abort.abort(); } else { currentStore.dispose(); }
                    release.resolve(); await pending;
                    assert.strictEqual(closes, 1, operation + '/' + phase + ' closes the acquired handle once');
                    assert.strictEqual(reads, 0, operation + '/' + phase + ' stops before reading any file bytes');
                } finally {
                    release.resolve(); await pending.catch(() => {});
                    fs.promises.open = originalOpen; currentStore.dispose(); await currentStore.settled();
                }
            }
        }
    });

    it('observes same-edition structural publication and removal through the existing directory watcher', async () => {
        await publish(manifest({ ...identity, sha256: 'c'.repeat(64) }));
        let changes = 0;
        store.watch(identity, () => { changes++; });
        await store.settled();
        assert.strictEqual(changes, 1);
        assert.strictEqual(await store.readingDescriptor(identity), undefined);
        const filename = path.join(store.directory(identity), 'reading.json');
        fs.writeFileSync(filename, JSON.stringify(reading()));
        const watcher = watchAt(store.directory(identity));
        watcher.change('reading.json'); watcher.change('reading.json');
        await store.settled();
        assert.strictEqual(changes, 2);
        assert.ok(await store.readingDescriptor(identity));
        fs.unlinkSync(filename); watcher.change('reading.json');
        await store.settled();
        assert.strictEqual(changes, 3);
        assert.strictEqual(await store.readingDescriptor(identity), undefined);
    });

    it('finds a later atomic publication once and rejects a different key or size without polling', async () => {
        let changes = 0;
        const stop = store.watch(identity, () => { changes++; });
        await store.settled();
        assert.strictEqual(watches.length, 1, 'an absent key directory needs only its parent event watcher');
        await publish(manifest({ ...identity, key: 'b'.repeat(64) }));
        watchAt(root).change(identity.key);
        await store.settled();
        assert.strictEqual(changes, 0);
        await publish(manifest({ ...identity, size: identity.size + 1 }));
        watchAt(store.directory(identity)).change('manifest.json');
        await store.settled();
        assert.strictEqual(changes, 0);
        await publish(manifest());
        const directoryWatch = watchAt(store.directory(identity));
        directoryWatch.change('manifest.json'); directoryWatch.change('manifest.json');
        await store.settled();
        assert.strictEqual(changes, 1, 'duplicate filesystem events coalesce for one manifest inode');
        directoryWatch.change('manifest.json');
        await store.settled();
        assert.strictEqual(changes, 1);
        stop();
        assert.strictEqual(directoryWatch.closed, true);
        directoryWatch.change('manifest.json');
        await store.settled();
        assert.strictEqual(changes, 1);
    });

    it('keeps registration inside the canonical key directory and ignores linked manifests', async () => {
        assert.throws(() => store.manifestPath({ ...identity, key: '../outside' }));
        assert.throws(() => store.manifestPath({ ...identity, key: '/absolute' }));
        assert.throws(() => store.manifestPath({ ...identity, size: 0 }));
        assert.throws(() => store.manifestPath({ ...identity, sha256: 'not-a-digest' }));
        fs.mkdirSync(root);
        const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'manifest.json'), JSON.stringify(manifest()));
        fs.symlinkSync(outside, store.directory(identity));
        let changes = 0;
        store.watch(identity, () => { changes++; });
        await store.settled();
        assert.strictEqual(changes, 0);
        assert.strictEqual(watches.length, 1, 'a symlink cannot create a watcher outside the registered root');
        fs.unlinkSync(store.directory(identity)); fs.mkdirSync(store.directory(identity));
        fs.symlinkSync(path.join(outside, 'manifest.json'), store.manifestPath(identity));
        watchAt(root).change(identity.key);
        await store.settled();
        assert.strictEqual(changes, 0);
    });

    it('fences a manifest read that finishes after unsubscribe or store disposal', async () => {
        for (const ending of ['unsubscribe', 'dispose']) {
            const currentStore = ending === 'unsubscribe' ? store : new PdfPreviewStore(root);
            await publish(manifest());
            const entered = deferred(), release = deferred();
            const originalOpen = fs.promises.open;
            fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
                const handle = await originalOpen(...args);
                if (String(args[0]) === currentStore.manifestPath(identity)) { entered.resolve(); await release.promise; }
                return handle;
            }) as typeof originalOpen;
            let changes = 0;
            const stop = currentStore.watch(identity, () => { changes++; });
            try {
                await entered.promise;
                if (ending === 'unsubscribe') { stop(); } else { currentStore.dispose(); }
                release.resolve(); await currentStore.settled();
                assert.strictEqual(changes, 0, ending + ' rejects the late manifest read');
            } finally {
                release.resolve(); fs.promises.open = originalOpen;
                currentStore.dispose(); await currentStore.settled();
            }
        }
        assert.strictEqual(watches.filter(watch => !watch.closed).length, 0);
    });

    it('leaves no watcher when disposal races root-directory initialization', async () => {
        const entered = deferred(), release = deferred();
        const original = fs.promises.mkdir;
        fs.promises.mkdir = (async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (String(args[0]) === root) { entered.resolve(); await release.promise; }
            return result;
        }) as typeof original;
        try {
            store.watch(identity, () => { throw new Error('disposed publication callback'); });
            await entered.promise;
            store.dispose(); release.resolve(); await store.settled();
            assert.strictEqual(watches.length, 0);
        } finally { release.resolve(); fs.promises.mkdir = original; }
    });
});

describe('exact-build preview source export', () => {
    let base: string, cache: PdfDiskCache, store: PdfPreviewStore;
    const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index % 251);
    const output = (query = '?build=a'): PdfOutput => ({
        url: 'https://pdf.example.test/output.pdf' + query, downloadDomain: 'https://pdf.example.test', projectId: 'project',
        file: { path: 'output.pdf', url: '/output.pdf', type: 'pdf', build: 'a', size: bytes.length },
    });
    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-preview-export-'));
        cache = new PdfDiskCache(path.join(base, 'pieces'), 1024 * 1024);
        store = new PdfPreviewStore(path.join(base, 'previews'));
    });
    afterEach(async () => { store.dispose(); await store.settled(); await cache.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
    const fill = (source: PdfOutput, end = bytes.length) => cache.storeRange(source, 0, end, {
        id: 0, status: 206, statusText: 'Partial Content', headers: [['content-range', 'bytes 0-' + (end - 1) + '/' + bytes.length], ['etag', '"exact"']],
        body: bytes.slice(0, end),
    });

    it('reuses the canonical cache key and binds the exported PDF to its streamed digest', async () => {
        const source = output();
        assert.strictEqual(await fill(source), true);
        const identity = cache.previewIdentity(source);
        const map = fs.readdirSync(cache.dir).find(name => name.startsWith('build-'))!;
        assert.strictEqual(identity.key, map.slice(6, -5));
        assert.notStrictEqual(cache.previewIdentity(output('?build=b')).key, identity.key, 'equal filename and size cannot identify another build');
        const target = path.join(base, 'source.pdf');
        fs.writeFileSync(target, 'previous destination');
        const result = await store.exportSource(cache, source, target, () => true);
        assert.deepStrictEqual(new Uint8Array(fs.readFileSync(target)), bytes);
        const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
        assert.deepStrictEqual(receipt.document, { ...identity, sha256: digest(bytes) });
        assert.strictEqual(receipt.pdf, 'source.pdf');
        assert.strictEqual(receipt.outputDirectory, store.directory(identity));
        assert.strictEqual(fs.readdirSync(base).some(name => /\.preview-source$|\.tmp$|\.part$/.test(name)), false);
    });

    it('reports incomplete bytes and leaves an existing destination and receipt untouched', async () => {
        const source = output(); await fill(source, 100);
        const target = path.join(base, 'source.pdf');
        fs.writeFileSync(target, 'existing PDF'); fs.writeFileSync(target + '.preview-source.json', 'existing receipt');
        await assert.rejects(store.exportSource(cache, source, target, () => true), error => error instanceof PdfPreviewExportError && error.reason === 'incomplete');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'existing PDF');
        assert.strictEqual(fs.readFileSync(target + '.preview-source.json', 'utf8'), 'existing receipt');
        assert.strictEqual(fs.readdirSync(base).some(name => /\.preview-source$|\.tmp$|\.part$/.test(name)), false);
    });

    it('completes only the captured build\'s missing bytes before exporting its digest and receipt', async () => {
        await cache.dispose();
        const source = output(), requests: Array<{ start: number, end: number }> = [];
        cache = new PdfDiskCache(path.join(base, 'pieces'), 1024 * 1024, { fetchRange: async request => {
            assert.strictEqual(request.output, source);
            requests.push({ start: request.start, end: request.end });
            return { id: 0, status: 206, statusText: 'Partial Content',
                headers: [['content-range', 'bytes ' + request.start + '-' + (request.end - 1) + '/' + bytes.length], ['etag', '"exact"']],
                body: bytes.slice(request.start, request.end) };
        } });
        await fill(source, 100);
        const phases: string[] = [], target = path.join(base, 'completed.pdf');
        const result = await store.exportSource(cache, source, target, () => true, undefined, progress => phases.push(progress.phase));
        assert.deepStrictEqual(requests, [{ start: 100, end: bytes.length }]);
        assert.deepStrictEqual(new Uint8Array(fs.readFileSync(target)), bytes);
        assert.strictEqual(result.receipt.document.sha256, digest(bytes));
        assert.deepStrictEqual([...new Set(phases)], ['fetching', 'writing']);
        assert.strictEqual((await cache.snapshot(source)).complete, true);
    });

    it('aborts captured-build completion on replacement and leaves the destination and receipt intact', async () => {
        await cache.dispose();
        const source = output(), entered = deferred(), release = deferred();
        let current = true, requestSignal: AbortSignal | undefined;
        cache = new PdfDiskCache(path.join(base, 'pieces'), 1024 * 1024, { fetchRange: async request => {
            requestSignal = request.signal; entered.resolve(); await release.promise;
            return { id: 0, status: 206, statusText: 'Partial Content',
                headers: [['content-range', 'bytes 0-' + (bytes.length - 1) + '/' + bytes.length], ['etag', '"exact"']], body: bytes };
        } });
        const target = path.join(base, 'replaced.pdf');
        fs.writeFileSync(target, 'existing PDF'); fs.writeFileSync(target + '.preview-source.json', 'existing receipt');
        const abort = new AbortController();
        const exporting = store.exportSource(cache, source, target, () => current, abort.signal);
        const settled = exporting.then(() => undefined, () => undefined);
        try {
            await Promise.race([entered.promise, exporting.then(() => { throw new Error('export finished before fetching its missing bytes'); })]);
            current = false; abort.abort();
            assert.strictEqual(requestSignal?.aborted, true);
            release.resolve();
            await assert.rejects(exporting, error => error instanceof PdfPreviewExportError && error.reason === 'superseded');
            assert.strictEqual((await cache.snapshot(source)).covered, 0, 'a late response from the captured build cannot publish');
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'existing PDF');
            assert.strictEqual(fs.readFileSync(target + '.preview-source.json', 'utf8'), 'existing receipt');
        } finally { release.resolve(); await settled; }
    });

    it('deletes only owned staging files when a copied source is cancelled or superseded', async () => {
        const source = output(); await fill(source);
        for (const reason of ['cancelled', 'superseded']) {
            const entered = deferred(), release = deferred();
            const original = cache.copyComplete.bind(cache);
            const asked: PdfOutput[] = [];
            cache.copyComplete = async (...args: Parameters<typeof original>) => {
                asked.push(args[0]); const result = await original(...args); entered.resolve(); await release.promise; return result;
            };
            const target = path.join(base, reason + '.pdf'); fs.writeFileSync(target, 'keep this destination');
            let current = true;
            const abort = new AbortController();
            const exporting = store.exportSource(cache, source, target, () => current, abort.signal);
            const rejected = assert.rejects(exporting, error => error instanceof PdfPreviewExportError && error.reason === reason);
            try {
                await entered.promise;
                if (reason === 'cancelled') { abort.abort(); } else { current = false; }
                release.resolve(); await rejected;
                assert.deepStrictEqual(asked, [source]);
                assert.strictEqual(fs.readFileSync(target, 'utf8'), 'keep this destination');
                assert.strictEqual(fs.existsSync(target + '.preview-source.json'), false);
                assert.strictEqual(fs.readdirSync(base).some(name => /\.preview-source$|\.tmp$|\.part$/.test(name)), false);
            } finally { release.resolve(); cache.copyComplete = original; }
        }
    });

    it('treats cancellation during the streaming copy as a cancelled export and preserves the destination', async () => {
        const source = output(); await fill(source);
        const target = path.join(base, 'interrupted.pdf'); fs.writeFileSync(target, 'existing PDF');
        const abort = new AbortController();
        await assert.rejects(store.exportSource(cache, source, target, () => true, abort.signal, () => abort.abort()),
            error => error instanceof PdfPreviewExportError && error.reason === 'cancelled');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'existing PDF');
        assert.strictEqual(fs.existsSync(target + '.preview-source.json'), false);
        assert.strictEqual(fs.readdirSync(base).some(name => /\.preview-source$|\.tmp$|\.part$/.test(name)), false);
    });

    it('preserves a published captured-build PDF through later document changes and receipt failure', async () => {
        const source = output(); await fill(source);
        const original = fs.promises.rename;
        for (const failReceipt of [false, true]) {
            const target = path.join(base, failReceipt ? 'receipt-fails.pdf' : 'advanced.pdf');
            let current = true;
            fs.promises.rename = (async (from: fs.PathLike, to: fs.PathLike) => {
                if (String(to) === target + '.preview-source.json' && failReceipt) { throw new Error('injected receipt publication failure'); }
                const result = await original(from, to);
                if (String(to) === target) { current = false; }
                return result;
            }) as typeof original;
            try {
                const exporting = store.exportSource(cache, source, target, () => current);
                if (failReceipt) { await assert.rejects(exporting, error => error instanceof PdfPreviewExportError && error.reason === 'receipt'); }
                else { assert.strictEqual((await exporting).receipt.document.key, cache.previewIdentity(source).key); }
                assert.deepStrictEqual(new Uint8Array(fs.readFileSync(target)), bytes, 'a valid published PDF remains available');
                assert.strictEqual(fs.readdirSync(base).some(name => /\.preview-source$|\.tmp$|\.part$/.test(name)), false);
            } finally { fs.promises.rename = original; }
        }
    });

    it('publishes a digest only after a successful complete atomic copy', async () => {
        const source = output(); await fill(source);
        const target = path.join(base, 'digest.pdf');
        const abort = new AbortController();
        let received: string | undefined;
        await assert.rejects(cache.copyComplete(source, target, abort.signal, () => abort.abort(), value => { received = value; }));
        assert.strictEqual(received, undefined);
        assert.strictEqual(fs.existsSync(target), false);
        assert.strictEqual(await cache.copyComplete(source, target, undefined, undefined, value => {
            assert.strictEqual(fs.existsSync(target), true, 'digest publication follows the final file rename'); received = value;
        }), true);
        assert.strictEqual(received, digest(bytes));
    });
});
