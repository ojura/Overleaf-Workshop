import type PDFJSWrapper from '@/features/pdf-preview/util/pdf-js-wrapper';
import { PDFJS, documentParams, loadingTasks } from '../shims/pdf-js';
import { bridgeOutputsOf } from '../common/bridge';
import { toPdfFile } from '../common/output';
import type { PdfOutput, PdfPreviewDescriptor } from '../common/protocol';
import { createWorkerPort } from '../common/worker';

export interface DocumentHooks {
    /** a load is about to replace the shown document: save what depends on it */
    beforeLoad(): void;
    /** `doc`, of build `build` or read whole, is shown */
    loaded(doc: any, build: string | undefined, preview?: PdfPreviewDescriptor): void;
    /** the load of build `build`, or of a PDF read whole, failed; `aborted` when a newer load stopped it */
    failed(error: unknown, aborted: boolean, build: string | undefined): void;
    /** a request of build `build`'s document failed (the transport's handleFetchError) */
    fetchFailed(error: unknown, build: string): void;
}

interface Job {
    abort: AbortController;
    task?: any;
}

/** What the page ends together with a document it loaded. */
interface Owned {
    /** the document's worker */
    worker: Worker;
    /** the abort controller of the document's range requests (Overleaf's transport), for a build loaded in ranges */
    requests?: AbortController;
}

/** how long a document may take to be destroyed before its worker is stopped anyway */
const DESTROY_TIMEOUT_MS = 10_000;

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
    /** the worker and the range requests of each document's loading task */
    private readonly owned = new Map<any, Owned>();

    constructor(private readonly wrapper: PDFJSWrapper, private readonly hooks: DocumentHooks) {}

    /** whether a load is under way, whose document will replace the shown one */
    get loading() {
        return this.inFlight !== undefined;
    }

    /** settles when the loads asked for so far have ended, shown, failed or overtaken */
    get settled(): Promise<void> {
        return this.queue;
    }

    /** Load the build `output` in ranges, unless it is the build shown already. */
    load(output: PdfOutput, force = false, preview?: PdfPreviewDescriptor) {
        if (!force && !this.inFlight && output.file.build === this.shownBuild) { return; }
        this.enqueue(job => this.loadOutput(output, job, preview));
    }

    /** Load a PDF read whole. */
    loadData(data: ArrayBuffer) {
        this.enqueue(job => this.loadBytes(data, job));
    }

    private enqueue(run: (job: Job) => Promise<void>) {
        // a newer load overtakes the one in flight: stop its requests and destroy its document
        if (this.inFlight) { this.stop(this.inFlight); }
        const job: Job = { abort: new AbortController() };
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
        owned?.requests?.abort();
        const timeout = new Promise(resolve => setTimeout(resolve, DESTROY_TIMEOUT_MS));
        Promise.race([task.destroy(), timeout])
            .catch(error => console.warn('pdf viewer: destroying a document:', error))
            .finally(() => owned?.worker.terminate());
    }

    /** Destroy every document but `shown`. */
    private destroyAllBut(shown: any) {
        for (const task of [...loadingTasks]) {
            if (task !== shown?.loadingTask) { this.destroy(task); }
        }
    }

    /** Resolves with what `promise` gives, or with `undefined` once the job is aborted. */
    private untilAborted<T>(job: Job, promise: Promise<T>): Promise<T | undefined> {
        return Promise.race([
            promise,
            new Promise<undefined>(resolve => job.abort.signal.addEventListener('abort', () => resolve(undefined), { once: true })),
        ]);
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

    private async loadOutput(output: PdfOutput, job: Job, preview?: PdfPreviewDescriptor) {
        const port = await this.prepare(job);
        if (!port) { return; }
        bridgeOutputsOf(output);
        const { url, pdfFile } = toPdfFile(output);
        const before = new Set(loadingTasks);
        let shown = false;
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
                if (!shown) { this.stop(job); }
            },
        });
        // loadDocument has created the task before its first await
        job.task = [...loadingTasks].find(task => !before.has(task));
        if (job.task) { this.owned.set(job.task, { worker: port, requests: job.abort }); } else { port.terminate(); }
        let doc: any;
        try {
            doc = await this.untilAborted(job, loading);
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
        shown = true;
        this.shownBuild = output.file.build;
        this.destroyAllBut(doc);
        this.hooks.loaded(doc, output.file.build, preview);
    }

    /** End `job` now: stop its requests and destroy its document. */
    private stop(job: Job) {
        job.abort.abort();
        if (job.task) { this.destroy(job.task); }
    }

    private async loadBytes(data: ArrayBuffer, job: Job) {
        const port = await this.prepare(job);
        if (!port) { return; }
        // the wrapper loads URLs only; a PDF read whole is set the way loadDocument sets one
        const task = PDFJS.getDocument({ data, ...documentParams() });
        loadingTasks.add(task);
        this.owned.set(task, { worker: port });
        job.task = task;
        let doc: any;
        try {
            doc = await this.untilAborted(job, task.promise);
        } catch (error) {
            this.destroy(task);
            this.hooks.failed(error, job.abort.signal.aborted, undefined);
            return;
        }
        if (!doc) {
            this.destroy(task);
            return;
        }
        this.setDocument(doc);
        this.shownBuild = undefined;
        this.destroyAllBut(doc);
        this.hooks.loaded(doc, undefined);
    }

    /** PDFJSWrapper.loadDocument's swap (pdf-js-wrapper.ts:89-106), for a document it did not load. */
    private setDocument(doc: any) {
        const { wrapper } = this;
        const viewerEl = wrapper.container.querySelector('.pdfViewer') as HTMLElement;
        const currentHeight = viewerEl.getBoundingClientRect().height;
        if (currentHeight > 0) {
            viewerEl.style.minHeight = `${currentHeight}px`;
            const clearMinHeight = () => {
                viewerEl.style.minHeight = '';
                wrapper.eventBus.off('pagesinit', clearMinHeight);
            };
            wrapper.eventBus.on('pagesinit', clearMinHeight);
        }
        wrapper.viewer.setDocument(doc);
        // the wrapper's own PDFLinkService, which the viewer was given
        (wrapper.viewer.linkService as any).setDocument(doc);
    }
}
