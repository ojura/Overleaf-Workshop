import { PDF_VIEWER_POLICY } from './viewer-policy';

/** An operation that may never answer has one bound, cleared on every completed path. */
export function waitForDocumentOperation(run: () => unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, PDF_VIEWER_POLICY.destroyTimeoutMs);
        let work: unknown;
        try { work = run(); } catch (error) { clearTimeout(timer); reject(error); return; }
        Promise.resolve(work).then(() => { clearTimeout(timer); resolve(); }, error => {
            clearTimeout(timer); reject(error);
        });
    });
}

/** Own the abort listener only while the awaited work is pending. */
export function untilAborted<T>(signal: AbortSignal, promise: PromiseLike<T>): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const aborted = () => { signal.removeEventListener('abort', aborted); resolve(undefined); };
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) { aborted(); }
        Promise.resolve(promise).then(value => {
            signal.removeEventListener('abort', aborted);
            resolve(signal.aborted ? undefined : value);
        }, error => {
            signal.removeEventListener('abort', aborted);
            if (signal.aborted) { resolve(undefined); } else { reject(error); }
        });
    });
}

/** Configure PDF.js before run(), then wait for its actual initializedPromise. */
export function waitForPdfJsApplication(configure: (app: any) => void, signal: AbortSignal): Promise<any | undefined> {
    return new Promise((resolve, reject) => {
        let started = false, done = false;
        const documents = new Set<Document>([document]);
        try { documents.add(parent.document); } catch { /* Cross-origin embedding uses the page's event. */ }
        const removeStartupListeners = () => {
            for (const target of documents) { target.removeEventListener('webviewerloaded', loaded); }
        };
        const finish = (app?: any, error?: unknown) => {
            if (done) { return; }
            done = true; removeStartupListeners(); signal.removeEventListener('abort', aborted);
            if (error !== undefined) { reject(error); } else { resolve(app); }
        };
        const aborted = () => finish();
        const start = () => {
            const app = (window as any).PDFViewerApplication;
            if (started || done || !app?.initializedPromise) { return; }
            started = true; removeStartupListeners();
            try { configure(app); } catch (error) { finish(undefined, error); return; }
            Promise.resolve(app.initializedPromise).then(() => finish(signal.aborted ? undefined : app), error => finish(undefined, error));
        };
        const loaded = (event: Event) => {
            if ((event as CustomEvent).detail?.source === window) { start(); }
        };
        if (signal.aborted) { finish(); return; }
        signal.addEventListener('abort', aborted, { once: true });
        for (const target of documents) { target.addEventListener('webviewerloaded', loaded); }
        start();
    });
}
