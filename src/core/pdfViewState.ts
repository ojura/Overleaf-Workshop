import type { SavedState } from './viewerProtocol';
import { PDF_VIEWER_POLICY } from './pdfViewerPolicy';

interface Storage {
    read(uri: string): SavedState | undefined;
    write(uri: string, state: SavedState): PromiseLike<void> | void;
    failed(error: unknown): void;
}

/** Keeps received state available while one ordered stream of durable writes catches up. */
export class PdfViewState {
    private readonly current = new Map<string, SavedState>();
    private readonly dirty = new Set<string>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private queue: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(private readonly storage: Storage) {}

    read(uri: string): SavedState | undefined {
        return this.current.get(uri) ?? this.storage.read(uri);
    }

    save(uri: string, state: SavedState) {
        if (this.disposed) { return; }
        // Messages are structured clones, but callers must not change an enqueued snapshot.
        this.current.set(uri, { ...state, ...(state.position ? { position: {
            ...state.position,
            ...(state.position.offset ? { offset: { ...state.position.offset } } : {}),
            ...(state.position.pageSize ? { pageSize: { ...state.position.pageSize } } : {}),
        } } : {}) });
        this.dirty.add(uri);
        if (this.timer === undefined) {
            this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, PDF_VIEWER_POLICY.stateWriteDelayMs);
            this.timer.unref?.();
        }
    }

    /** Flush captured state before a page leaves; this never waits for a closing webview. */
    flush(uri?: string): Promise<void> {
        const pending = uri === undefined ? [...this.dirty] : this.dirty.has(uri) ? [uri] : [];
        for (const key of pending) { this.dirty.delete(key); }
        if (!this.dirty.size && this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
        for (const key of pending) {
            const state = this.current.get(key)!;
            this.queue = this.queue.then(async () => {
                try {
                    await this.storage.write(key, state);
                    if (this.current.get(key) === state) { this.current.delete(key); }
                } catch (error) {
                    // A later explicit flush or new change can retry; a failure starts no timer.
                    if (this.current.get(key) === state) { this.dirty.add(key); }
                    this.storage.failed(error);
                }
            });
        }
        return this.queue;
    }

    get settled(): Promise<void> { return this.queue; }

    dispose(): Promise<void> {
        this.disposed = true;
        return this.flush();
    }
}
