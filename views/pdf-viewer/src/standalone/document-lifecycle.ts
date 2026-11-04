import { captureSiteView, type SiteView } from './document-load';

// Match the extension's worker teardown allowance. A worker may never answer Terminate.
export const SITE_DOCUMENT_DESTROY_TIMEOUT_MS = 10_000;

interface Options {
    viewHash(): string;
    inputVersion(): number;
    clock?: Pick<Window, 'setTimeout' | 'clearTimeout'>;
}

interface ClosingDocument {
    promise: Promise<void>;
    previous?: { destroy(): void };
    released: boolean;
}

const stopped = () => new DOMException('PDF publication stopped.', 'AbortError');
class CloseTimeout extends Error {
    constructor() { super('Prethodna knjiga još se zatvara. Pokušajte ponovno.'); }
}

/**
 * PDF.js 5.1.91 restores history before setInitialView and can repeat that view after
 * discovering unequal page sizes. Keep those callbacks with their document. A per-load
 * receiver also isolates its automatic focus call; controls still use the real viewer.
 */
export function createSiteDocumentLifecycle(app: any, options: Options) {
    const clock = options.clock ?? window;
    const lifetime = new AbortController();
    let active: object | undefined;
    let closing: ClosingDocument | undefined;

    function release(record: ClosingDocument) {
        if (record.released) { return; }
        record.released = true;
        if (closing === record) { closing = undefined; }
        record.previous?.destroy();
    }

    function waitForClose(record: ClosingDocument, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const signals = signal ? [signal, lifetime.signal] : [lifetime.signal];
            const finish = (error?: unknown) => {
                if (settled) { return; }
                settled = true;
                clock.clearTimeout(timer);
                for (const value of signals) { value.removeEventListener('abort', abort); }
                if (error) { reject(error); } else { resolve(); }
            };
            const abort = () => finish(stopped());
            const timer = clock.setTimeout(() => finish(new CloseTimeout()), SITE_DOCUMENT_DESTROY_TIMEOUT_MS);
            for (const value of signals) { value.addEventListener('abort', abort, { once: true }); }
            record.promise.then(() => finish(), finish);
            if (signals.some(value => value.aborted)) { abort(); }
        });
    }

    async function close(previous: { destroy(): void } | undefined, signal?: AbortSignal): Promise<void> {
        if (lifetime.signal.aborted || signal?.aborted) { throw stopped(); }
        active = undefined;
        if (!closing) {
            closing = { promise: Promise.resolve(app.close()), previous, released: false };
        }
        const record = closing;
        try {
            await waitForClose(record, signal);
            if (lifetime.signal.aborted || signal?.aborted) { throw stopped(); }
            release(record);
        } catch (error) {
            // In the pinned close(), all application writes finish before the final worker
            // wait. A pending annotation save occurs before detachment; keep that same close
            // for a retry so its late continuation cannot clear a newer document.
            const detached = app.pdfLoadingTask === null && app.pdfDocument === null;
            if (detached) { release(record); }
            if (error instanceof CloseTimeout && detached && !lifetime.signal.aborted && !signal?.aborted) { return; }
            throw error;
        }
    }

    function load(document: any, loadOptions: { view?: SiteView; automatic?: boolean }) {
        if (lifetime.signal.aborted) { throw stopped(); }
        if (closing) { throw new Error('Prethodna knjiga još se zatvara. Pokušajte ponovno.'); }
        const binding = {};
        active = binding;
        const owned = () => !lifetime.signal.aborted && active === binding;
        const current = () => owned() && app.pdfDocument === document;
        let view = loadOptions.view ? { ...loadOptions.view } : undefined;
        let applied = false, inputVersion = options.inputVersion();
        let initialNavigation: unknown[] | undefined;

        function navigationState(): unknown[] {
            const viewer = app.pdfViewer;
            return [viewer.currentPageNumber, viewer.currentScale, viewer.currentScaleValue,
                viewer.pagesRotation, viewer.scrollMode, viewer.spreadMode, app.pdfSidebar?.visibleView,
                viewer.container?.scrollLeft, viewer.container?.scrollTop];
        }

        // Read private-field getters and invoke methods on the real instances. Only this
        // load's callbacks see these receivers; app and its public viewer stay unchanged.
        function guarded(target: any, overrides = new Map<PropertyKey, unknown>(), writable = current): any {
            const methods = new Map<Function, Function>();
            return new Proxy(target, {
                get(value, key) {
                    if (overrides.has(key)) { return overrides.get(key); }
                    const entry = Reflect.get(value, key, value);
                    if (typeof entry !== 'function') { return entry; }
                    let method = methods.get(entry);
                    if (!method) {
                        method = (...args: unknown[]) => current() ? Reflect.apply(entry, value, args) : undefined;
                        methods.set(entry, method);
                    }
                    return method;
                },
                set(value, key, entry) { return writable() ? Reflect.set(value, key, entry, value) : true; },
            });
        }

        function restoreBookmark() {
            if (!view) { return; }
            const navigated = initialNavigation && navigationState().some((value, index) => value !== initialNavigation![index]);
            if ((applied || navigated) && inputVersion !== options.inputVersion()) {
                view = captureSiteView(app, options.viewHash(), document.numPages);
            }
            app.initialBookmark = view.hash;
            app.initialRotation = view.rotation;
        }
        const viewer = app.pdfViewer;
        const scopedViewer = guarded(viewer, new Map<PropertyKey, unknown>([
            ['setDocument', (...args: unknown[]) => {
                if (!current()) { return; }
                const result = Reflect.apply(viewer.setDocument, viewer, args);
                // PDF.js constructs the first page and dispatches pagesinit in the same
                // task that resolves this promise. Register before load's metadata wait
                // so setup's temporary page-1 view is never mistaken for user navigation.
                void Promise.resolve(viewer.firstPagePromise).then(() => {
                    if (!current() || applied) { return; }
                    initialNavigation = navigationState();
                    inputVersion = options.inputVersion();
                }, () => {});
                return result;
            }],
            ['focus', (...args: unknown[]) => {
                if (current() && !loadOptions.automatic) { Reflect.apply(viewer.focus, viewer, args); }
            }],
        ]));
        let receiver: any;
        const eventBus = app.eventBus;
        const scopedEvents = guarded(eventBus, new Map<PropertyKey, unknown>([
            ['dispatch', (name: string, data: any) => {
                if (!current()) { return; }
                return eventBus.dispatch(name, data?.source === receiver ? { ...data, source: app } : data);
            }],
        ]));
        const overrides = new Map<PropertyKey, unknown>([
            ['pdfViewer', scopedViewer],
            ['eventBus', scopedEvents],
            ['loadingBar', app.loadingBar ? guarded(app.loadingBar) : app.loadingBar],
            ['_initializePdfHistory', (...args: unknown[]) => {
                // load() catches this inside its metadata continuation. Stop before that
                // stale continuation can dispatch documentinit or create its page timer.
                if (!current()) { throw stopped(); }
                Reflect.apply(app._initializePdfHistory, app, args);
                if (current()) { restoreBookmark(); }
            }],
            ['setInitialView', (hash?: string, initialOptions: Record<string, unknown> = {}) => {
                if (!current()) { return; }
                restoreBookmark();
                const result = app.setInitialView(view?.hash ?? hash, view ? { ...initialOptions,
                    rotation: view.rotation, sidebarView: view.sidebarView,
                    scrollMode: view.scrollMode, spreadMode: view.spreadMode } : initialOptions);
                applied = true;
                inputVersion = options.inputVersion();
                return result;
            }],
        ]);
        let installing = true;
        receiver = guarded(app, overrides, () => current() || installing && owned());
        try { Reflect.apply(app.load, receiver, [document]); }
        catch (error) { if (active === binding) { active = undefined; } throw error; }
        finally { installing = false; }
    }

    return {
        load, close,
        dispose() {
            if (lifetime.signal.aborted) { return; }
            active = undefined;
            lifetime.abort();
            if (closing) { release(closing); }
        },
    };
}
