import type PDFJSWrapper from '@/features/pdf-preview/util/pdf-js-wrapper';
import { PDFJS, documentParams, loadingTasks } from '../shims/pdf-js';
import { bridgeOutputsOf, readReadingImage } from '../common/bridge';
import { toPdfFile } from '../common/output';
import type { PdfOutput, PdfPreviewDescriptor, PdfReadingDescriptor } from '../common/protocol';
import { createWorkerPort } from '../common/worker';
import { holdDocumentHeight } from '../common/document-height';
import { untilAborted, waitForDocumentOperation } from '../common/document-lifecycle';
import { openPdfReadingSource, type PdfReadingSource } from '../common/pdf-reading-source';
import { preparePdfReadingUpgrade } from '../common/pdf-reading-upgrade';

export interface DocumentHooks {
    /** a load is about to replace the shown document: save what depends on it */
    beforeLoad(): void;
    /** The validated proxy is being installed now, including a deferred native view transition. */
    beforeSwap?(doc: any, build: string | undefined, signal: AbortSignal): (() => void) | undefined;
    /** Keep painted pixels while the candidate owns image preparation. */
    pauseRefinement?(): Promise<() => void>;
    /** `doc`, of build `build` or read whole, is shown */
    loaded(doc: any, build: string | undefined, preview?: PdfPreviewDescriptor): void;
    /** the load of build `build`, or of a PDF read whole, failed; `aborted` when a newer load stopped it */
    failed(error: unknown, aborted: boolean, build: string | undefined): void;
    /** a request of build `build`'s document failed (the transport's handleFetchError) */
    fetchFailed(error: unknown, build: string): void;
}

type Adoption = { doc: any } | { error: unknown };

interface Job {
    abort: AbortController;
    task?: any;
    adopted: Promise<Adoption>;
    adopt(result: Adoption): void;
    shown: boolean;
    readingSource?: PdfReadingSource;
}

/** What the page ends together with a document it loaded. */
interface Owned {
    /** the document's worker */
    worker: Worker;
    job: Job;
    signal: AbortSignal;
    build?: string;
    representationOnly?: boolean;
    /** the abort controller of the document's range requests (Overleaf's transport), for a build loaded in ranges */
    requests?: AbortController;
}

/**
 * Loads the host's documents into PDFJSWrapper one at a time, and destroys every document the
 * page no longer shows.
 *
 * Overleaf's wrapper never destroys a document: it replaces the shown one in loadDocument, and it
 * drops a load that a newer one overtook (pdf-js-wrapper.ts:84-87). A document kept alive keeps
 * its worker's state, including a buffer as long as the PDF (ChunkedStream in pdf.worker.mjs).
 *
 * Each document gets a worker of its own (GlobalWorkerOptions.workerPort, set just before the
 * wrapper's getDocument reads it), which is stopped once the document is destroyed. A shared
 * worker would need every destroy to finish before the next load starts: pdf.js refuses a load on
 * a port whose destroy is pending (PDFWorker.fromPort), and a destroy that never finishes would
 * block every later load.
 *
 * A load that a newer one overtakes is not awaited: once its transport is set up, destroying its
 * task leaves the task's promise pending for good (it settles only on the worker's GetDoc or
 * DocException, pdf.mjs).
 *
 * Destroying a document stops its range requests first. pdf.js removes the transport's range
 * readers when the document's worker ends (the worker's Terminate handler cancels its range
 * requests, pdf.worker.mjs), and aborts the transport only after the worker has answered
 * (WorkerTransport.destroy, pdf.mjs). A response that arrives in between finds its reader gone,
 * and pdf.js throws "_onReceiveData - no `PDFDataTransportStreamRangeReader` instance found".
 * Overleaf's transport delivers a response only while its signal is not aborted.
 */
export class Documents {
    private queue: Promise<void> = Promise.resolve();
    private inFlight?: Job;
    /** the build shown, unless the shown document was read whole */
    private shownBuild?: string;
    private shownReadingRevision?: string;
    /** the worker and the range requests of each document's loading task */
    private readonly owned = new Map<any, Owned>();
    /** Deferred callbacks may still hold a proxy after its task was destroyed. */
    private readonly retired = new WeakSet<object>();
    private disposed = false;
    private readonly destroying = new Set<Promise<void>>();

    constructor(private readonly wrapper: PDFJSWrapper, private readonly hooks: DocumentHooks) {
        // loadDocument may return before its view-transition callback installs the
        // proxy. Observe the actual assignment, with PDFViewer as the real receiver.
        const viewer = wrapper.viewer;
        const setDocument = viewer.setDocument;
        viewer.setDocument = (doc) => {
            const owned = this.owned.get(doc?.loadingTask);
            if (this.retired.has(doc?.loadingTask) || owned?.signal.aborted) {
                // Throw before the wrapper continues to linkService.setDocument as well.
                throw new DOMException('The document load was cancelled.', 'AbortError');
            }
            let cancel: (() => void) | undefined;
            if (doc && viewer.pdfDocument && doc !== viewer.pdfDocument && owned && !owned.representationOnly) {
                try { cancel = hooks.beforeSwap?.(doc, owned.build, owned.signal); }
                catch { /* Optional scene preparation cannot prevent useful document pixels. */ }
            }
            try { setDocument.call(viewer, doc); }
            catch (error) {
                try { cancel?.(); } catch { /* Keep the viewer's original load failure. */ }
                owned?.job.adopt({ error });
                throw error;
            }
            if (owned) {
                owned.job.shown = true;
                owned.job.adopt({ doc });
                if (this.inFlight === owned.job) { this.inFlight = undefined; }
            }
        };
    }

    /** whether a load is under way, whose document will replace the shown one */
    get loading() {
        return this.inFlight !== undefined;
    }

    /** settles when the loads asked for so far have ended, shown, failed or overtaken */
    get settled(): Promise<void> {
        return this.queue.then(() => Promise.all([...this.destroying])).then(() => {});
    }

    dispose(): Promise<void> {
        if (!this.disposed) {
            this.disposed = true;
            if (this.inFlight) { this.stop(this.inFlight); this.inFlight = undefined; }
            for (const task of this.owned.keys()) { this.destroy(task); }
        }
        return this.settled;
    }

    /** Load the build `output` in ranges, unless it is the build shown already. */
    load(output: PdfOutput, force = false, preview?: PdfPreviewDescriptor, reading?: PdfReadingDescriptor) {
        if (!force && !this.inFlight && output.file.build === this.shownBuild
            && reading?.manifestRevision === this.shownReadingRevision) { return; }
        this.enqueue(job => this.loadOutput(output, job, preview, reading));
    }

    /** Load a PDF read whole. */
    loadData(data: ArrayBuffer) {
        this.enqueue(job => this.loadBytes(data, job));
    }

    private enqueue(run: (job: Job) => Promise<void>) {
        if (this.disposed) { return; }
        // a newer load overtakes the one in flight: stop its requests and destroy its document
        if (this.inFlight) { this.stop(this.inFlight); }
        let adopt!: (result: Adoption) => void;
        const adopted = new Promise<Adoption>(resolve => { adopt = resolve; });
        const job: Job = { abort: new AbortController(), adopted, adopt, shown: false };
        this.inFlight = job;
        this.queue = this.queue
            .then(() => run(job))
            .catch(error => console.error('pdf viewer:', error))
            .finally(() => { if (this.inFlight === job) { this.inFlight = undefined; } });
    }

    private destroy(task: any) {
        if (!loadingTasks.has(task)) { return; }
        loadingTasks.delete(task);
        const owned = this.owned.get(task);
        this.owned.delete(task);
        this.retired.add(task);
        owned?.requests?.abort();
        owned?.job.readingSource?.dispose();
        const destroying = waitForDocumentOperation(() => task.destroy())
            .catch(error => console.warn('pdf viewer: destroying a document:', error))
            .finally(() => { owned?.worker.terminate(); this.destroying.delete(destroying); });
        this.destroying.add(destroying);
    }

    /** Destroy every document but `shown`. */
    private destroyAllBut(shown: any) {
        for (const task of [...loadingTasks]) {
            if (task !== shown?.loadingTask) { this.destroy(task); }
        }
    }

    /** Resolves with what `promise` gives, or with `undefined` once the job is aborted. */
    private untilAborted<T>(job: Job, promise: Promise<T>): Promise<T | undefined> {
        return untilAborted(job.abort.signal, promise);
    }

    /** Start the job's worker; false if the job was overtaken meanwhile. */
    private async prepare(job: Job): Promise<Worker | undefined> {
        if (job.abort.signal.aborted) { return undefined; }
        const port = await createWorkerPort();
        if (job.abort.signal.aborted) {
            port.terminate();
            return undefined;
        }
        this.hooks.beforeLoad();
        PDFJS.GlobalWorkerOptions.workerPort = port;
        return port;
    }

    private async loadOutput(output: PdfOutput, job: Job, preview?: PdfPreviewDescriptor, reading?: PdfReadingDescriptor) {
        if (reading) {
            try {
                job.readingSource = await openPdfReadingSource(reading, { signal: job.abort.signal,
                    readImage: ({ id, chunkIndex, signal, chunkCount }) => readReadingImage(reading.manifestRevision, id, chunkIndex, signal, chunkCount) });
                if (!job.readingSource) { throw new Error('The registered reading publication is unavailable.'); }
                await this.loadBytes(job.readingSource.data, job, { output, preview, reading });
            } catch (error) {
                job.readingSource?.dispose();
                this.hooks.failed(error, job.abort.signal.aborted, output.file.build);
            }
            return;
        }
        const port = await this.prepare(job);
        if (!port) { return; }
        bridgeOutputsOf(output);
        const { url, pdfFile } = toPdfFile(output);
        const before = new Set(loadingTasks);
        const loading = this.wrapper.loadDocument({
            url,
            pdfFile,
            abortController: job.abort,
            handleFetchError: (error: unknown) => {
                if (job.abort.signal.aborted) { return; }
                this.hooks.fetchFailed(error, output.file.build);
                // Before the document is shown, a request that failed for good ends its load:
                // pdf.js waits for the missing range forever. Stop the job, so that its worker
                // goes and the next load can start.
                if (!job.shown) { this.stop(job); }
            },
        });
        // loadDocument has created the task before its first await
        job.task = [...loadingTasks].find(task => !before.has(task));
        if (job.task) { this.owned.set(job.task, { worker: port, job, signal: job.abort.signal, build: output.file.build,
            representationOnly: this.shownBuild === output.file.build, requests: job.abort }); } else { port.terminate(); }
        let doc: any;
        try {
            doc = await this.untilAborted(job, loading);
            if (doc) {
                const adoption = await this.untilAborted(job, job.adopted);
                if (!adoption) { doc = undefined; }
                else if ('error' in adoption) { throw adoption.error; }
                else { doc = adoption.doc; }
            }
        } catch (error) {
            if (job.task) { this.destroy(job.task); }
            this.hooks.failed(error, job.abort.signal.aborted, output.file.build);
            return;
        }
        if (!doc) {
            // overtaken: by a newer load of this page, or one the wrapper dropped (url changed)
            if (job.task) { this.destroy(job.task); }
            return;
        }
        this.shownBuild = output.file.build;
        this.shownReadingRevision = undefined;
        this.destroyAllBut(doc);
        this.hooks.loaded(doc, output.file.build, preview);
    }

    /** End `job` now: stop its requests and destroy its document. */
    private stop(job: Job) {
        job.abort.abort();
        job.readingSource?.dispose();
        if (job.task) { this.destroy(job.task); }
    }

    private async loadBytes(data: ArrayBuffer | Uint8Array, job: Job,
        source?: { output: PdfOutput; preview?: PdfPreviewDescriptor; reading: PdfReadingDescriptor }) {
        const port = await this.prepare(job);
        if (!port) { job.readingSource?.dispose(); return; }
        // the wrapper loads URLs only; a PDF read whole is set the way loadDocument sets one
        let task: any, doc: any, resume: (() => void) | undefined;
        const representationOnly = !!source && source.output.file.build === this.shownBuild;
        try {
            task = PDFJS.getDocument({ data, ...documentParams(),
                ...(job.readingSource ? { externalImageSource: job.readingSource.externalImageSource } : {}) });
            loadingTasks.add(task);
            this.owned.set(task, { worker: port, job, signal: job.abort.signal, build: source?.output.file.build, representationOnly });
            job.task = task;
            doc = await this.untilAborted(job, task.promise);
            if (doc && source && doc.numPages !== job.readingSource?.manifest.source.pageCount) {
                throw new Error('The reading PDF page count differs from its publication.');
            }
            if (doc && representationOnly) {
                resume = await this.hooks.pauseRefinement?.();
                await preparePdfReadingUpgrade(doc, this.wrapper.viewer, job.abort.signal);
            }
            if (doc && !job.abort.signal.aborted) {
                if (representationOnly) { this.hooks.beforeLoad(); }
                this.setDocument(doc);
            }
            else { doc = undefined; }
        } catch (error) {
            if (task) { this.destroy(task); } else { job.readingSource?.dispose(); port.terminate(); }
            this.hooks.failed(error, job.abort.signal.aborted, source?.output.file.build);
            return;
        } finally {
            resume?.();
        }
        if (!doc) {
            this.destroy(task);
            return;
        }
        this.shownBuild = source?.output.file.build;
        this.shownReadingRevision = source?.reading.manifestRevision;
        this.destroyAllBut(doc);
        this.hooks.loaded(doc, this.shownBuild, source?.preview);
    }

    /** PDFJSWrapper.loadDocument's swap (pdf-js-wrapper.ts:89-106), for a document it did not load. */
    private setDocument(doc: any) {
        const { wrapper } = this;
        const viewerEl = wrapper.container.querySelector('.pdfViewer') as HTMLElement;
        const releaseHeight = holdDocumentHeight(viewerEl, wrapper.eventBus, this.owned.get(doc?.loadingTask)?.signal);
        try {
            wrapper.viewer.setDocument(doc);
            // the wrapper's own PDFLinkService, which the viewer was given
            (wrapper.viewer.linkService as any).setDocument(doc);
        } catch (error) {
            releaseHeight();
            throw error;
        }
    }
}
