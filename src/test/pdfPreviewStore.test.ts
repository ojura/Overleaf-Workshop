import * as assert from 'assert';
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
