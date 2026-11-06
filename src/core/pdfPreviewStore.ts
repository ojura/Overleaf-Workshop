import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { PdfCacheCompletionError, type PdfDiskCache } from './pdfDiskCache';
import type { PdfOutput, PdfPreviewIdentity, PdfReadingDescriptor } from './viewerProtocol';
import { PDF_PREVIEW_MANIFEST_BYTES } from './viewerProtocol';
import { PDF_READING_LIMITS, pdfReadingImageRange, validatePdfReadingManifest } from './pdfReadingManifest';

const KEY = /^[a-f0-9]{64}$/;

/** Open before inspecting the descriptor without waiting for a FIFO writer. A path
 * lstat alone cannot protect the subsequent open from a file replacement race. */
async function openBoundedRegularFile(filename: string, limit: number, current: () => boolean) {
    const check = () => { if (!current()) { throw new Error('Local preview file request stopped'); } };
    check();
    const handle = await fs.promises.open(filename,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
        check();
        const stat = await handle.stat();
        check();
        if (!stat.isFile() || stat.size > limit) { throw new Error('Local preview file must be a bounded regular file'); }
        return { handle, stat };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

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
export interface PdfPreviewExportProgress {
    phase: 'fetching' | 'writing';
    completedBytes: number;
    totalBytes: number;
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
    private readonly exports = new Set<AbortController>();
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

    /** Bind a reading publication to the SHA recorded by the existing exact-build export. */
    readingDescriptor(identity: PdfPreviewIdentity): Promise<(Omit<PdfReadingDescriptor, 'manifestUrl'> & {
        manifestPath: string;
        readImage(id: string, chunkIndex: number, signal: AbortSignal, chunkCount?: number): Promise<{ body: Uint8Array; offset: number; total: number }>;
    }) | undefined> {
        const task = (async () => {
            const directory = this.directory(identity);
            const folder = await fs.promises.lstat(directory).catch(() => undefined);
            if (this.closed || !folder?.isDirectory() || folder.isSymbolicLink()) { return; }
            const read = async (filename: string, limit: number) => {
                const opened = await openBoundedRegularFile(filename, limit, () => !this.closed).catch(() => undefined);
                if (!opened) { return; }
                const { handle, stat } = opened;
                try {
                    const bytes = Buffer.alloc(stat.size);
                    const result = await handle.read(bytes, 0, bytes.length, 0);
                    if (this.closed || result.bytesRead !== bytes.length) { return; }
                    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
                } finally { await handle.close(); }
            };
            const preview = await read(this.manifestPath(identity), PDF_PREVIEW_MANIFEST_BYTES);
            const document = preview?.value?.document;
            if (preview?.value?.version !== 1 || document?.key !== identity.key || document.size !== identity.size
                || typeof document.sha256 !== 'string' || !KEY.test(document.sha256)
                || identity.sha256 && document.sha256 !== identity.sha256) { return; }
            const source = { sha256: document.sha256, size: identity.size };
            const manifestPath = path.join(directory, 'reading.json');
            const reading = await read(manifestPath, PDF_READING_LIMITS.manifestBytes);
            const validated = reading && validatePdfReadingManifest(reading.value, source);
            if (this.closed || !reading || !validated || validated.source.pageCount !== document.pageCount) { return; }
            const images = new Map(validated.images.map(image => [image.id, image]));
            return { identity: source, manifestPath, manifestRevision: createHash('sha256').update(reading.bytes).digest('hex'),
                readImage: async (id: string, chunkIndex: number, signal: AbortSignal, chunkCount?: number) => {
                    const check = () => { if (this.closed || signal.aborted) { throw new Error('Reading image request stopped'); } };
                    check();
                    const image = images.get(id);
                    const selected = image && pdfReadingImageRange(image, chunkIndex, chunkCount);
                    if (!image || !selected) { throw new Error('Unknown registered reading image chunks'); }
                    const filename = path.join(directory, image.path);
                    // Refuse symlinked parents as well as a symlinked final file.
                    if (await fs.promises.realpath(filename) !== filename) { throw new Error('Reading image paths must be regular local files'); }
                    check();
                    const { handle: file, stat } = await openBoundedRegularFile(filename, image.bytes, () => !this.closed && !signal.aborted);
                    try {
                        if (stat.size !== image.bytes || await fs.promises.realpath(filename) !== filename) {
                            throw new Error('Registered reading image size or path changed');
                        }
                        check();
                        const offset = selected.offset, length = selected.bytes;
                        const body = Buffer.allocUnsafe(length);
                        for (let received = 0; received < length;) {
                            check();
                            const result = await file.read(body, received, Math.min(256 * 1024, length - received), offset + received);
                            if (!result.bytesRead) { throw new Error('Registered reading image chunk is incomplete'); }
                            received += result.bytesRead;
                        }
                        check();
                        for (const chunk of selected.chunks) {
                            check();
                            const start = chunk.offset - offset;
                            if (createHash('sha256').update(body.subarray(start, start + chunk.bytes)).digest('hex') !== chunk.sha256) {
                                throw new Error('Registered reading image chunk digest changed');
                            }
                        }
                        return { body, offset, total: image.bytes };
                    } finally { await file.close(); }
                } };
        })().catch(() => undefined);
        const pending = task.then(() => {}).finally(() => { this.pending.delete(pending); });
        this.pending.add(pending);
        return task;
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
                    if (!filename || ['manifest.json', 'reading.json'].includes(filename.toString())) { this.check(entry); }
                });
                entry.watcher.on('error', () => {
                    entry.watcher?.close(); entry.watcher = undefined;
                });
            } catch { return; }
        }
        const filename = this.manifestPath(entry.identity);
        const link = await fs.promises.lstat(filename).catch(() => undefined);
        if (!this.current(entry) || !link?.isFile() || link.isSymbolicLink() || link.size > PDF_PREVIEW_MANIFEST_BYTES) { return; }
        const reading = await fs.promises.lstat(path.join(directory, 'reading.json')).catch(() => undefined);
        if (!this.current(entry)) { return; }
        const signature = [link.dev, link.ino, link.size, link.mtimeMs,
            ...(reading?.isFile() && !reading.isSymbolicLink() ? [reading.dev, reading.ino, reading.size, reading.mtimeMs] : [])].join(':');
        if (signature === entry.signature) { return; }
        const opened = await openBoundedRegularFile(filename, PDF_PREVIEW_MANIFEST_BYTES, () => this.current(entry)).catch(() => undefined);
        if (!opened) { return; }
        const { handle, stat } = opened;
        let manifest: any;
        try {
            if (stat.ino !== link.ino || stat.dev !== link.dev) { return; }
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

    /** Complete the captured build, then bind its exported PDF and preview receipt to the same bytes. */
    async exportSource(cache: PdfDiskCache, output: PdfOutput, target: string, current: () => boolean,
        signal?: AbortSignal, progress?: (value: PdfPreviewExportProgress) => void): Promise<{ pdfPath: string, receiptPath: string, receipt: PdfPreviewReceipt }> {
        const identity = cache.previewIdentity(output);
        const outputDirectory = this.directory(identity);
        const receiptPath = target + '.preview-source.json';
        const unique = randomUUID();
        const stagedPdf = target + '.' + unique + '.preview-source';
        const stagedReceipt = receiptPath + '.' + unique + '.tmp';
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); }
        this.exports.add(controller);
        let published = false;
        const checkCurrent = () => {
            if (!current()) { throw new PdfPreviewExportError('superseded', 'The shown build changed before its preview source was exported. Start the export again for the new build.'); }
            if (this.closed || controller.signal.aborted) { throw new PdfPreviewExportError('cancelled', 'Preview source export was cancelled.'); }
        };
        try {
            checkCurrent();
            try {
                await cache.completeForExport(output, { signal: controller.signal, current,
                    onProgress: (completedBytes, totalBytes) => {
                        checkCurrent();
                        progress?.({ phase: 'fetching', completedBytes, totalBytes });
                    } });
            } catch (error) {
                checkCurrent();
                if (error instanceof PdfCacheCompletionError) {
                    throw new PdfPreviewExportError(error.reason === 'cancelled' ? 'cancelled' : 'incomplete', error.message);
                }
                throw error;
            }
            checkCurrent();
            progress?.({ phase: 'writing', completedBytes: 0, totalBytes: identity.size });
            let sha256: string | undefined;
            const copied = await cache.copyComplete(output, stagedPdf, controller.signal, completedBytes => {
                checkCurrent();
                progress?.({ phase: 'writing', completedBytes, totalBytes: identity.size });
            }, value => { sha256 = value; });
            checkCurrent();
            if (!copied || !sha256) {
                throw new PdfPreviewExportError('incomplete', 'Cached bytes became unavailable while writing the exact PDF. Start the export again.');
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
            controller.abort();
            signal?.removeEventListener('abort', abort);
            this.exports.delete(controller);
            await fs.promises.unlink(stagedPdf).catch(() => {});
            await fs.promises.unlink(stagedReceipt).catch(() => {});
        }
    }

    dispose() {
        if (this.closed) { return; }
        this.closed = true;
        for (const controller of this.exports) { controller.abort(); }
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
