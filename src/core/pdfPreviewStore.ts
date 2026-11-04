import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PdfDiskCache } from './pdfDiskCache';
import type { PdfOutput, PdfPreviewIdentity } from './viewerProtocol';
import { PDF_PREVIEW_MANIFEST_BYTES } from './viewerProtocol';

const KEY = /^[a-f0-9]{64}$/;

interface Subscription {
    identity: PdfPreviewIdentity;
    listeners: Set<() => void>;
    watcher?: fs.FSWatcher;
    signature?: string;
    checking: boolean;
    again: boolean;
}

export interface PdfPreviewReceipt {
    version: 1;
    document: PdfPreviewIdentity & { sha256: string };
    pdf: string;
    outputDirectory: string;
}

export class PdfPreviewExportError extends Error {
    constructor(readonly reason: 'incomplete' | 'superseded' | 'cancelled' | 'receipt', message: string) { super(message); }
}

/** Local preview publication is event driven. It never opens or downloads the source PDF. */
export class PdfPreviewStore {
    private readonly subscriptions = new Map<string, Subscription>();
    private watcher?: fs.FSWatcher;
    private ready?: Promise<void>;
    private readonly pending = new Set<Promise<void>>();
    private closed = false;

    constructor(readonly root: string) {}

    directory(identity: PdfPreviewIdentity): string {
        if (!KEY.test(identity.key) || !Number.isSafeInteger(identity.size) || identity.size <= 0 ||
            identity.sha256 !== undefined && !KEY.test(identity.sha256)) {
            throw new Error('Preview registration requires an exact cached build identity');
        }
        return path.join(this.root, identity.key);
    }

    manifestPath(identity: PdfPreviewIdentity): string {
        return path.join(this.directory(identity), 'manifest.json');
    }

    private current(entry: Subscription): boolean {
        return !this.closed && this.subscriptions.get(entry.identity.key) === entry && entry.listeners.size > 0;
    }

    private async initialize() {
        await fs.promises.mkdir(this.root, { recursive: true });
        if (this.closed) { return; }
        this.watcher = fs.watch(this.root, { persistent: false }, (_event, filename) => {
            if (this.closed) { return; }
            const name = filename?.toString();
            const entries = name ? [this.subscriptions.get(name)] : [...this.subscriptions.values()];
            for (const entry of entries) {
                if (!entry) { continue; }
                // A generator may replace the whole key directory atomically.
                entry.watcher?.close(); entry.watcher = undefined;
                this.check(entry);
            }
        });
        this.watcher.on('error', () => {});
    }

    watch(identity: PdfPreviewIdentity, listener: () => void): () => void {
        this.directory(identity);
        if (this.closed) { return () => {}; }
        let entry = this.subscriptions.get(identity.key);
        if (entry && (entry.identity.size !== identity.size || entry.identity.sha256 !== identity.sha256)) {
            throw new Error('A preview key cannot identify different source bytes');
        }
        if (!entry) {
            entry = { identity: { ...identity }, listeners: new Set(), checking: false, again: false };
            this.subscriptions.set(identity.key, entry);
        }
        const watched = entry;
        watched.listeners.add(listener);
        this.ready ??= this.initialize().catch(() => {});
        void this.ready.then(() => this.check(watched));
        return () => {
            watched.listeners.delete(listener);
            if (!watched.listeners.size) {
                watched.watcher?.close(); watched.watcher = undefined;
                if (this.subscriptions.get(identity.key) === watched) { this.subscriptions.delete(identity.key); }
            }
        };
    }

    private check(entry: Subscription) {
        if (!this.current(entry)) { return; }
        entry.again = true;
        if (entry.checking) { return; }
        entry.checking = true;
        const task = (async () => {
            do {
                entry.again = false;
                await this.inspect(entry);
            } while (entry.again && this.current(entry));
        })().catch(() => {}).finally(() => { entry.checking = false; this.pending.delete(task); });
        this.pending.add(task);
    }

    private async inspect(entry: Subscription) {
        const directory = this.directory(entry.identity);
        const folder = await fs.promises.lstat(directory).catch(() => undefined);
        if (!this.current(entry)) { return; }
        if (!folder?.isDirectory() || folder.isSymbolicLink()) {
            entry.watcher?.close(); entry.watcher = undefined;
            return;
        }
        if (!entry.watcher) {
            try {
                entry.watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
                    if (!filename || filename.toString() === 'manifest.json') { this.check(entry); }
                });
                entry.watcher.on('error', () => {
                    entry.watcher?.close(); entry.watcher = undefined;
                });
            } catch { return; }
        }
        const filename = this.manifestPath(entry.identity);
        const link = await fs.promises.lstat(filename).catch(() => undefined);
        if (!this.current(entry) || !link?.isFile() || link.isSymbolicLink() || link.size > PDF_PREVIEW_MANIFEST_BYTES) { return; }
        const signature = [link.dev, link.ino, link.size, link.mtimeMs].join(':');
        if (signature === entry.signature) { return; }
        const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
        if (!handle) { return; }
        let manifest: any;
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > PDF_PREVIEW_MANIFEST_BYTES || stat.ino !== link.ino || stat.dev !== link.dev) { return; }
            const bytes = Buffer.alloc(stat.size);
            const read = await handle.read(bytes, 0, bytes.length, 0);
            if (read.bytesRead !== bytes.length || !this.current(entry)) { return; }
            manifest = JSON.parse(bytes.toString('utf8'));
        } catch { return; }
        finally { await handle.close(); }
        if (!this.current(entry) || manifest?.version !== 1 || manifest.document?.key !== entry.identity.key ||
            manifest.document?.size !== entry.identity.size ||
            entry.identity.sha256 && manifest.document?.sha256 !== entry.identity.sha256) { return; }
        entry.signature = signature;
        for (const listener of [...entry.listeners]) {
            if (this.current(entry) && entry.listeners.has(listener)) { listener(); }
        }
    }

    /** Export only the captured cached build, then bind the generator receipt to its actual bytes. */
    async exportSource(cache: PdfDiskCache, output: PdfOutput, target: string, current: () => boolean,
        signal?: AbortSignal, progress?: (bytes: number) => void): Promise<{ pdfPath: string, receiptPath: string, receipt: PdfPreviewReceipt }> {
        const identity = cache.previewIdentity(output);
        const outputDirectory = this.directory(identity);
        const receiptPath = target + '.preview-source.json';
        const unique = randomUUID();
        const stagedPdf = target + '.' + unique + '.preview-source';
        const stagedReceipt = receiptPath + '.' + unique + '.tmp';
        let published = false;
        const checkCurrent = () => {
            if (!current()) { throw new PdfPreviewExportError('superseded', 'The shown build changed before its preview source was exported. Start the export again for the new build.'); }
            if (this.closed || signal?.aborted) { throw new PdfPreviewExportError('cancelled', 'Preview source export was cancelled.'); }
        };
        try {
            checkCurrent();
            let sha256: string | undefined;
            const copied = await cache.copyComplete(output, stagedPdf, signal, progress, value => { sha256 = value; });
            checkCurrent();
            if (!copied || !sha256) {
                throw new PdfPreviewExportError('incomplete', 'The exact build could not be exported from the cache. Wait for its disk accumulation to complete, then try again.');
            }
            const receipt: PdfPreviewReceipt = { version: 1, document: { ...identity, sha256 }, pdf: path.basename(target), outputDirectory };
            await fs.promises.writeFile(stagedReceipt, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
            checkCurrent();
            await fs.promises.rename(stagedPdf, target);
            published = true;
            // Once published, this remains a valid export of the captured build even if the
            // editor moves to another build while the receipt is being published.
            await fs.promises.rename(stagedReceipt, receiptPath);
            return { pdfPath: target, receiptPath, receipt };
        } catch (error) {
            if (published) { throw new PdfPreviewExportError('receipt', 'The PDF was exported, but its preview receipt could not be saved: ' + (error instanceof Error ? error.message : String(error))); }
            checkCurrent();
            throw error;
        } finally {
            await fs.promises.unlink(stagedPdf).catch(() => {});
            await fs.promises.unlink(stagedReceipt).catch(() => {});
        }
    }

    dispose() {
        if (this.closed) { return; }
        this.closed = true;
        this.watcher?.close(); this.watcher = undefined;
        for (const entry of this.subscriptions.values()) { entry.watcher?.close(); entry.listeners.clear(); }
        this.subscriptions.clear();
    }

    /** Await publication checks already in progress, without scheduling a poll. */
    async settled() {
        await this.ready;
        while (this.pending.size) { await Promise.all(this.pending); }
    }
}
