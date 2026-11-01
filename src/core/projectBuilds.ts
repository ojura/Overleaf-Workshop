import type { CompileResponseSchema } from '../api/base';
import type { CompileRecord } from '../compile/outputFiles';
import type { BuildStatus } from './viewerProtocol';

/**
 * The build of a project that this window shows: in the PDF viewers, for SyncTeX, in the output
 * folder, in the Problems view and in the replica's .overleaf/output. Overleaf is compiled from
 * several places, such as the web editor, other windows and the command-line tools, and each
 * compile makes a new build that this window does not hear of. Overleaf keeps each user's latest
 * compile of a project in its cache of compile outputs and answers for it
 * (BaseAPI.getLatestCompileFromCache), so the window asks when the latest build may have changed.
 */

/** What a compile typesets, as far as it decides whether a build shows what the window would compile. */
export interface CompileSettings {
    /** the main document, relative to the project's folder, e.g. 'main.tex' */
    rootResourcePath: string | null;
    draft: boolean;
    stopOnFirstError: boolean;
}

/**
 * Whether a build compiled with `build` shows what this window compiles with `window`. These are
 * the checks Overleaf's editor makes before it shows a compile from its cache instead of compiling
 * (local-compile-context.tsx:402-425): the same main document; the same draft mode; and stopping on
 * the first error only if the window stops too, since a compile that passed while stopping on the
 * first error also passes without it, but not the other way round. Overleaf's editor also compares
 * png2pdf, which Overleaf's server decides for each user, so the window has no value of its own
 * to compare it with.
 */
export function sameSettings(build: CompileSettings, window: CompileSettings): boolean {
    return build.rootResourcePath === window.rootResourcePath
        && build.draft === window.draft
        && (build.stopOnFirstError || !window.stopOnFirstError);
}

/** A successful compile's build with output.pdf: this window's, or another client's from Overleaf's cache. */
export interface Build {
    /** output.pdf's build ID, from the file's `build` field */
    id: string;
    /** the editor whose compile made the build; with the build ID it names the build in Overleaf's cache */
    editorId: string;
    /** what the compile typeset */
    settings: CompileSettings;
    /** the compile: Overleaf's answer, and how the replica's .overleaf/output records it (outputFiles.ts) */
    record: CompileRecord & { response: CompileResponseSchema };
}

/**
 * Overleaf's build ID: the time at which Overleaf began the compile, in milliseconds since 1970 in
 * hex, a dash, and 8 random bytes in hex (web CompileManager.mjs:26-28; the compile server checks
 * that form, OutputCacheManager.js:107-108, BUILD_REGEX). Overleaf takes the time before it reads
 * the project, "so that the buildId's timestamp is before any lastUpdated date"
 * (CompileManager.mjs:66).
 */
const BUILD_ID = /^([0-9a-f]+)-[0-9a-f]+$/;

/** The time in build ID `id`, in milliseconds since 1970; undefined for an ID of another form. */
export function buildTimeOf(id: string): number | undefined {
    const match = BUILD_ID.exec(id);
    return match ? parseInt(match[1], 16) : undefined;
}

/** Whether `build` is one that Overleaf's cache answered with, which marks its answers (ClsiCacheController.mjs:217). */
export function fromCache(build: Build): boolean {
    return build.record.response.fromCache === true;
}

/** output.pdf of `response`, when the compile succeeded */
function pdfOf(response: CompileResponseSchema | undefined) {
    return response?.status === 'success' ? response.outputFiles?.find(file => file.path === 'output.pdf') : undefined;
}

/** The build that this window's compile `record` made, compiled with `settings` by editor `editorId`; undefined without output.pdf. */
export function ownBuild(record: CompileRecord, editorId: string, settings: CompileSettings): Build | undefined {
    const response = record.response;
    const pdf = pdfOf(response);
    if (!response || !pdf?.build) {
        return undefined;
    }
    return { id: pdf.build, editorId, settings, record: { ...record, response } };
}

/**
 * The build in Overleaf's answer about the latest compile, `response`, which came at
 * `answeredAt`; undefined without output.pdf, its editor or the compile's options. The compile
 * server stores draft and stopOnFirstError as booleans (RequestParser.js:88-103).
 */
export function cachedBuild(response: CompileResponseSchema, answeredAt: number): Build | undefined {
    const pdf = pdfOf(response);
    const options = response.options;
    if (!pdf?.build || !pdf.editorId || !options) {
        return undefined;
    }
    const settings: CompileSettings = {
        rootResourcePath: options.rootResourcePath ?? null,
        draft: options.draft === true,
        stopOnFirstError: options.stopOnFirstError === true,
    };
    return { id: pdf.build, editorId: pdf.editorId, settings, record: { response, rootResourcePath: settings.rootResourcePath, answeredAt } };
}

/**
 * Overleaf's answer about the latest compile of the project by this user:
 *   build   a successful compile with output.pdf
 *   none    Overleaf answered, without a build to show: 404 when its cache has no compile, 410
 *           when the project changed after the latest one (ClsiCacheManager.mjs:52,108), or a
 *           compile stored without output.pdf, as Overleaf stores a standard-group user's
 *           compile (CLSICacheHandler.js:199-223)
 *   failed  the request failed, with the error
 */
export type LatestAnswer =
    | { kind: 'build', build: Build }
    | { kind: 'none' }
    | { kind: 'failed', detail: string };

/**
 * How a request for a compile went (CompileManager.compile):
 *   started      the compile started; compileEndedEvent reports its end, however it ends
 *   busy         another compile of the window was running; `ended` settles when that compile has
 *                ended, however it ended, also when it ended before it compiled anything, which
 *                fires no compileEndedEvent
 *   unavailable  the window has no project to compile
 */
export type CompileStart =
    | { kind: 'started' }
    | { kind: 'busy', ended: Promise<void> }
    | { kind: 'unavailable' };

/** Whether `value`, an answer that came through a command, is a CompileStart: 'busy' with a promise it can wait for. */
export function isCompileStart(value: unknown): value is CompileStart {
    const start = value as { kind?: unknown, ended?: { then?: unknown } } | undefined;
    return start?.kind === 'started' || start?.kind === 'unavailable'
        || (start?.kind === 'busy' && typeof start.ended?.then === 'function');
}

/**
 * How a compile in the window ended:
 *   success  Overleaf's status was 'success'
 *   failure  it was another, or the request failed; `detail` says which
 *   skipped  nothing changed since the last compile, so the compile was not sent
 */
export type CompileOutcome =
    | { result: 'success' }
    | { result: 'failure', detail: string }
    | { result: 'skipped' };

/**
 * Runs of a task, one at a time. A request while a run is in flight asks for one more run after
 * it, which every request until it starts shares. A request's promise settles as the first run
 * that starts after the request settles, so a caller that asks because of an event gets a run
 * that began after the event.
 */
export class CoalescedRuns {
    private inFlight = false;
    private queued?: { promise: Promise<void>, resolve: () => void, reject: (error: unknown) => void };

    constructor(private readonly task: () => Promise<void>) {}

    request(): Promise<void> {
        if (!this.inFlight) {
            return this.launch();
        }
        if (!this.queued) {
            let resolve!: () => void;
            let reject!: (error: unknown) => void;
            const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
            this.queued = { promise, resolve, reject };
        }
        return this.queued.promise;
    }

    private async launch(): Promise<void> {
        this.inFlight = true;
        try {
            await this.task();
        } finally {
            const queued = this.queued;
            this.queued = undefined;
            if (queued) {
                // still in flight: the queued run starts in the same step as this one ends
                this.launch().then(queued.resolve, queued.reject);
            } else {
                this.inFlight = false;
            }
        }
    }
}

/** What the window does about a missing build: a compile it asked for, and how that went. */
type CompileState =
    /** no compile was asked for since the build in use came */
    | { state: 'idle' }
    /**
     * a compile of this project runs, or was asked for and has not ended: `started` once a
     * compile of this project has started, asked for here or elsewhere (compileStarted); before,
     * the request is on its way, or it found another compile running, maybe of another project,
     * and waits for that compile's end (CompileStart 'busy')
     */
    | { state: 'running', started: boolean }
    /** the compile ended without a build, or did not start; the user's Recompile is next */
    | { state: 'failed', status: BuildStatus };

/**
 * Who asks ProjectBuilds for a compile, which decides when it asks (asks):
 *   viewer   no build to show while a viewer of the build is visible (compileIfNeeded)
 *   opening  the project was opened in this window (opened)
 *   user     a viewer's Recompile (recompile)
 */
type Asker = 'viewer' | 'opening' | 'user';

/** Something a viewer can say about itself: whether it is visible now. */
export interface BuildViewer {
    readonly visible: boolean;
}

/**
 * Where to ask: Overleaf's answer about the latest compile, the settings the window compiles with,
 * and the window's compile path (CompileManager.compile).
 */
export interface BuildsHost {
    latest(): Promise<LatestAnswer>;
    settings(): CompileSettings;
    compile(): Promise<CompileStart>;
}

const messageOf = (error: unknown) => String((error as Error)?.message ?? error);

/** Call each of `listeners` with `value`; one that throws does not keep the others from it. */
function notify<T>(listeners: Set<(value: T) => void>, value: T) {
    for (const listener of listeners) {
        try {
            listener(value);
        } catch (error) {
            console.error('Overleaf Workshop: a listener of the build in use failed:', error);
        }
    }
}

/**
 * The build in use of one project, and what the window does when it has none to show.
 *
 * The build in use changes when this window's compile makes a build (useOwn), and when Overleaf's
 * answer about the latest compile names a build that the window has not had (check). A build
 * that the window replaced is older than the build in use, so an answer naming it is ignored. An
 * answer is also ignored when its compile typeset something else than the window compiles
 * (sameSettings). While the build in use is another client's, any other build in an answer is
 * taken: Overleaf answers only for its latest compile, and only while the project has not changed
 * since.
 *
 * While the build in use is this window's own compile X, a build Y in an answer is taken only if
 * Y's build ID says that Y began later than X (buildTimeOf). Overleaf stores a compile in its cache
 * after it has answered the compile request, without waiting for the store
 * (CLSICacheHandler.js:142-196), so a check after X and before that store answers with the cache's
 * earlier latest, Y. Y can lack an edit that X has: Overleaf answers with its latest compile while
 * the time of the cache's copy is at least the time of the project's last update
 * (ClsiCacheManager.mjs:33-52, 108), and the copy is written after the compile, so an edit made
 * while Y compiled counts as older than Y. Overleaf orders compiles by the times in their build
 * IDs, which it takes before it reads the project (CompileManager.mjs:66). When either ID has
 * another form, the build is taken as above, and the form is logged once.
 *
 * When the project opens, the window shows Overleaf's latest compile if it is current and of the
 * window's settings, and compiles otherwise (opened).
 *
 * A viewer reports the build in use gone when its files are gone from the compile server and
 * from Overleaf's cache (reportGone). With no build to show, either gone or none known, as after
 * a window reload, a check that finds no newer build starts one compile through the window's
 * compile path, while a viewer of the build is visible (attachViewer); else the next check while
 * one is visible starts it. The compile's build becomes the build in use as any compile's does.
 * When that compile fails or cannot start, the window says why and leaves the next compile to the
 * user, until a build comes. With a build to show, an answer without a newer build keeps it.
 *
 * Checks run one at a time (CoalescedRuns): an event during a check asks for one more check after
 * it, so the answer is never older than the event.
 */
export class ProjectBuilds {
    private current?: Build;
    /** the builds that this window replaced */
    private readonly superseded = new Set<string>();
    /** whether a viewer reported the build in use gone */
    private gone = false;
    /** whether a check is waiting for Overleaf's answer */
    private checking = false;
    /** why the last check failed; cleared by the next check that gets an answer */
    private checkError?: string;
    private compile: CompileState = { state: 'idle' };
    private readonly viewers = new Set<BuildViewer>();
    private readonly checks = new CoalescedRuns(() => this.runCheck());
    /** the handling of the project's opening (opened) */
    private opening?: Promise<void>;
    /** whether a build ID of another form than Overleaf's was logged (laterThanOwn) */
    private loggedIdForm = false;
    private shown: BuildStatus = { state: 'none' };
    private readonly buildListeners = new Set<(build: Build) => void>();
    private readonly statusListeners = new Set<(status: BuildStatus) => void>();

    constructor(private readonly host: BuildsHost) {}

    /** the build in use */
    get build(): Build | undefined {
        return this.current;
    }

    get status(): BuildStatus {
        return this.shown;
    }

    /** Call `listener` with each new build in use; returns the function that stops it. */
    onDidChangeBuild(listener: (build: Build) => void): () => void {
        this.buildListeners.add(listener);
        return () => { this.buildListeners.delete(listener); };
    }

    /** Call `listener` with each change of the status; returns the function that stops it. */
    onDidChangeStatus(listener: (status: BuildStatus) => void): () => void {
        this.statusListeners.add(listener);
        return () => { this.statusListeners.delete(listener); };
    }

    /** This window's compile made `build`, which replaces the build in use. */
    useOwn(build: Build) {
        this.replace(build);
    }

    /** Ask Overleaf for the latest compile; settles when a check that started after this call has ended. */
    check(): Promise<void> {
        return this.checks.request();
    }

    /**
     * The project was opened in this window. Overleaf's latest compile is shown when it is current
     * and was compiled as the window compiles; else the project is compiled, also when Overleaf
     * could not be asked, as Overleaf's editor does when it opens a project
     * (local-compile-context.tsx:383-425). Every call answers with the same promise.
     */
    opened(): Promise<void> {
        this.opening ??= (async () => {
            await this.check();
            await this.startCompile('opening');
        })();
        return this.opening;
    }

    /**
     * The user asked for a compile with a viewer's Recompile. The viewers say 'compiling' from the
     * click; while a compile of this project runs, or was asked for, its end decides.
     */
    recompile(): Promise<void> {
        return this.startCompile('user');
    }

    /**
     * A viewer found build `id` gone from Overleaf's servers. A report about a build that is no
     * longer in use is ignored: the viewer gets the build in use next.
     */
    reportGone(id: string): Promise<void> {
        if (id !== this.current?.id) {
            return Promise.resolve();
        }
        this.gone = true;
        this.update();
        return this.check();
    }

    /** Follow `viewer` while it is open; returns the function to call when it closes. */
    attachViewer(viewer: BuildViewer): () => void {
        this.viewers.add(viewer);
        return () => { this.viewers.delete(viewer); };
    }

    /**
     * A compile in this window started: of this project when `ofThisProject`, else of another
     * project. A compile of this project runs, whoever asked for it (a viewer, an editor, a save),
     * so the viewers say 'compiling' while there is no build to show, until its end
     * (compileEnded). A compile that this project asked for is running already.
     */
    compileStarted(ofThisProject: boolean) {
        if (ofThisProject && this.compile.state !== 'running') {
            this.compile = { state: 'running', started: true };
            this.update();
        }
    }

    /**
     * A compile in this window ended: of this project when `ofThisProject`, else of another
     * project, which the window compiles one at a time.
     */
    compileEnded(outcome: CompileOutcome, ofThisProject: boolean) {
        // another project's compile made no build of this project; a request of this project that
        // waited for it asks again when it has ended (startCompile)
        if (!ofThisProject) {
            return;
        }
        if (outcome.result === 'skipped') {
            // nothing had changed since the last compile, so it made no build; a compile that ran
            // ends here, and a request waiting for it asks again when it has ended
            if (this.compile.state === 'running' && this.compile.started) {
                this.compile = { state: 'idle' };
                this.update();
            }
            return;
        }
        if (this.hasBuildToShow()) {
            // the compile made the build in use (useOwn came first), or the build in use stays
            if (this.compile.state === 'running') {
                this.compile = { state: 'idle' };
                this.update();
            }
            return;
        }
        const detail = outcome.result === 'failure' ? outcome.detail : 'the compile made no output.pdf';
        this.compile = { state: 'failed', status: { state: 'compile-failed', detail } };
        this.update();
    }

    private hasBuildToShow(): boolean {
        return this.current !== undefined && !this.gone;
    }

    private async runCheck(): Promise<void> {
        this.checking = true;
        this.update();
        let answer: LatestAnswer;
        try {
            answer = await this.host.latest();
        } catch (error) {
            answer = { kind: 'failed', detail: messageOf(error) };
        }
        this.checking = false;
        if (answer.kind === 'failed') {
            this.checkError = answer.detail;
            this.update();
            return;
        }
        this.checkError = undefined;
        if (answer.kind === 'build' && this.take(answer.build)) {
            return;
        }
        // a compile that starts now is shown at once, without the state before it
        await this.compileIfNeeded();
        this.update();
    }

    /**
     * Take `build` from Overleaf's answer as the build in use, unless the window has had it, it
     * typeset something else, or it began before the window's own build in use.
     */
    private take(build: Build): boolean {
        if (build.id === this.current?.id || this.superseded.has(build.id)) {
            return false;
        }
        if (!sameSettings(build.settings, this.host.settings())) {
            return false;
        }
        if (this.current && !fromCache(this.current) && !this.laterThanOwn(build, this.current)) {
            return false;
        }
        this.replace(build);
        return true;
    }

    /**
     * Whether `build` from Overleaf's cache began after `own`, this window's build in use, as the
     * times in their build IDs say. With an ID of another form the times cannot be compared, and
     * the build counts as later.
     */
    private laterThanOwn(build: Build, own: Build): boolean {
        const time = buildTimeOf(build.id);
        const ownTime = buildTimeOf(own.id);
        if (time === undefined || ownTime === undefined) {
            if (!this.loggedIdForm) {
                this.loggedIdForm = true;
                console.warn(`Overleaf Workshop: the build IDs ${own.id} and ${build.id} are not both of Overleaf's form <time in hex>-<random hex>, so the window takes the build from Overleaf's cache without comparing their times`);
            }
            return true;
        }
        return time > ownTime;
    }

    private replace(build: Build) {
        if (this.current && this.current.id !== build.id) {
            this.superseded.add(this.current.id);
        }
        this.current = build;
        this.gone = false;
        // the window has a new build: an earlier failure to ask Overleaf no longer says anything about it
        this.checkError = undefined;
        this.compile = { state: 'idle' };
        notify(this.buildListeners, build);
        this.update();
    }

    /** Start the one compile that makes a build to show, while a viewer of the build is visible. */
    private async compileIfNeeded(): Promise<void> {
        await this.startCompile('viewer');
    }

    /**
     * Whether `asker` asks for a compile now: never while a compile of this project runs or was
     * asked for; the user always else; the others only while there is no build to show and no
     * failure that waits for the user, at the project's opening, or while a viewer of the build
     * is visible.
     */
    private asks(asker: Asker): boolean {
        if (this.compile.state === 'running') {
            return false;
        }
        if (asker === 'user') {
            return true;
        }
        if (this.hasBuildToShow() || this.compile.state !== 'idle') {
            return false;
        }
        return asker === 'opening' || [...this.viewers].some(viewer => viewer.visible);
    }

    /** Ask the window's compile path for the compile that `asker` wants, if it asks now (asks). */
    private async startCompile(asker: Asker): Promise<void> {
        if (!this.asks(asker)) {
            return;
        }
        const request: CompileState = { state: 'running', started: false };
        this.compile = request;
        this.update();
        let start: CompileStart;
        let detail = 'this window has no Overleaf project to compile';
        try {
            start = await this.host.compile();
        } catch (error) {
            start = { kind: 'unavailable' };
            detail = messageOf(error);
        }
        // the compile may have ended meanwhile (compileEnded), or a build may have come
        if (this.compile !== request) {
            return;
        }
        if (start.kind === 'unavailable') {
            this.compile = { state: 'failed', status: { state: 'compile-unavailable', detail } };
            this.update();
        } else if (start.kind === 'started') {
            this.compile = { state: 'running', started: true };
        } else {
            // the window compiles one project at a time: once the running compile has ended,
            // however it ended, the same asker asks again, unless a build or a failure to show
            // replaced this request meanwhile. A failure of this project that the compile's end
            // reports comes first: the compile fires compileEndedEvent in the same step as it
            // settles `ended`. Not awaited, so that checks go on meanwhile.
            void start.ended.then(() => {
                if (this.compile === request) {
                    this.compile = { state: 'idle' };
                    void this.startCompile(asker);
                }
            });
        }
    }

    private derive(): BuildStatus {
        if (this.hasBuildToShow()) {
            return this.checkError !== undefined ? { state: 'check-failed', detail: this.checkError } : { state: 'ready' };
        }
        if (this.compile.state === 'running') {
            return { state: 'compiling' };
        }
        if (this.compile.state === 'failed') {
            return this.compile.status;
        }
        if (this.checking) {
            return { state: 'checking' };
        }
        if (this.checkError !== undefined) {
            return { state: 'check-failed', detail: this.checkError };
        }
        return { state: this.gone ? 'gone' : 'none' };
    }

    private update() {
        const next = this.derive();
        if (next.state === this.shown.state && next.detail === this.shown.detail) {
            return;
        }
        this.shown = next;
        notify(this.statusListeners, next);
    }
}
