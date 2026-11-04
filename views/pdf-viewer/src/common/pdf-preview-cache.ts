/** A retained raster is independent of PDF.js's decoded page resources. */
export interface PdfPreview {
    canvas: HTMLCanvasElement;
    bytes: number;
}

interface Options {
    maxBytes: number;
    maxPages: number;
    trailMaxDimension: number;
    createCanvas: () => HTMLCanvasElement;
}

const RGBA_BYTES = 4;

/**
 * Recent/prepared previews keep their quality. Under byte pressure, older detached previews
 * become smaller placeholders before any page is evicted. The Map order is least-recent first.
 *
 * This cache owns every canvas passed to retain, including a rejected admission. Visible or
 * attached entries are protected from trimming; explicit remove/clear still release them.
 */
export class PdfPreviewCache implements Iterable<[number, PdfPreview]> {
    private readonly entries = new Map<number, PdfPreview>();
    private retainedBytes = 0;

    constructor(private readonly options: Options) {}

    get size(): number { return this.entries.size; }
    get bytes(): number { return this.retainedBytes; }
    get(id: number): PdfPreview | undefined { return this.entries.get(id); }
    has(id: number): boolean { return this.entries.has(id); }
    keys(): IterableIterator<number> { return this.entries.keys(); }
    [Symbol.iterator](): IterableIterator<[number, PdfPreview]> { return this.entries[Symbol.iterator](); }

    touch(id: number): void {
        const entry = this.entries.get(id);
        if (!entry) { return; }
        this.entries.delete(id);
        this.entries.set(id, entry);
    }

    remove(id: number): void {
        const entry = this.entries.get(id);
        if (!entry) { return; }
        this.entries.delete(id);
        this.retainedBytes -= entry.bytes;
        this.release(entry.canvas);
    }

    clear(): void {
        for (const id of this.entries.keys()) { this.remove(id); }
    }

    /**
     * The caller protects the union of visible and prepared page IDs. A rejected replacement
     * keeps the old entry and its DOM coverage; the new canvas is released in either case.
     */
    retain(id: number, canvas: HTMLCanvasElement, protectedIds: ReadonlySet<number>): boolean {
        const previous = this.entries.get(id);
        if (previous?.canvas === canvas) { this.touch(id); return true; }
        const bytes = canvas.width * canvas.height * RGBA_BYTES;
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.options.maxBytes || this.options.maxPages < 1) {
            this.release(canvas);
            return false;
        }
        const keep = new Set(protectedIds);
        keep.add(id);
        let protectedBytes = bytes;
        let protectedPages = 1;
        for (const [page, entry] of this.entries) {
            if (page !== id && (keep.has(page) || entry.canvas.parentNode)) {
                protectedBytes += entry.bytes;
                protectedPages++;
            }
        }
        // Do not sacrifice old placeholders for an admission that cannot fit its protected set.
        if (protectedBytes > this.options.maxBytes || protectedPages > this.options.maxPages) {
            this.release(canvas);
            return false;
        }
        const extraBytes = bytes - (previous?.bytes ?? 0);
        const extraPages = previous ? 0 : 1;
        const eligible = (page: number, entry: PdfPreview) => !keep.has(page) && !entry.canvas.parentNode;
        if (this.retainedBytes + extraBytes > this.options.maxBytes) {
            for (const [page, entry] of this.entries) {
                if (eligible(page, entry)) { this.reduce(page, entry); }
                if (this.retainedBytes + extraBytes <= this.options.maxBytes) { break; }
            }
        }
        while (this.retainedBytes + extraBytes > this.options.maxBytes || this.entries.size + extraPages > this.options.maxPages) {
            const oldest = [...this.entries].find(([page, entry]) => eligible(page, entry));
            if (!oldest) { this.release(canvas); return false; }
            this.remove(oldest[0]);
        }
        if (previous) {
            this.replaceAttached(previous.canvas, canvas);
            this.entries.delete(id);
            this.retainedBytes -= previous.bytes;
            this.release(previous.canvas);
        }
        this.entries.set(id, { canvas, bytes });
        this.retainedBytes += bytes;
        return true;
    }

    private reduce(id: number, entry: PdfPreview): void {
        const limit = this.options.trailMaxDimension;
        const source = entry.canvas;
        const longest = Math.max(source.width, source.height);
        if (limit <= 0 || longest <= limit) { return; }
        const ratio = limit / longest;
        const width = Math.max(1, Math.min(limit, Math.ceil(source.width * ratio)));
        const height = Math.max(1, Math.min(limit, Math.ceil(source.height * ratio)));
        const bytes = width * height * RGBA_BYTES;
        if (bytes >= entry.bytes) { return; }
        let canvas: HTMLCanvasElement | undefined;
        try {
            canvas = this.options.createCanvas();
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) { this.release(canvas); return; }
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(source, 0, 0, width, height);
        } catch {
            if (canvas) { this.release(canvas); }
            return;
        }
        // set() preserves the old entry's LRU position; a downgrade is not a new visit.
        this.entries.set(id, { canvas, bytes });
        this.retainedBytes += bytes - entry.bytes;
        this.release(source);
    }

    private replaceAttached(previous: HTMLCanvasElement, canvas: HTMLCanvasElement): void {
        const parent = previous.parentNode as (Node & ParentNode) | null;
        if (!parent) { return; }
        canvas.className = previous.className;
        canvas.style.cssText = previous.style.cssText;
        for (let index = 0; index < previous.attributes.length; index++) {
            const attribute = previous.attributes[index];
            if (attribute.name !== 'width' && attribute.name !== 'height') { canvas.setAttribute(attribute.name, attribute.value); }
        }
        // Every preview is prepended to its page. Publish the replacement before releasing
        // the old attached bitmap, so a visible page always retains its placeholder node.
        parent.prepend(canvas);
    }

    private release(canvas: HTMLCanvasElement): void {
        canvas.remove();
        canvas.width = canvas.height = 0;
    }
}
