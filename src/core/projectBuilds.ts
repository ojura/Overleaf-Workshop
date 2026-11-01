import type { CompileResponseSchema } from '../api/base';
import type { CompileRecord } from '../compile/outputFiles';
import type { BuildStatus } from './viewerProtocol';
import { errorMessage } from '../utils/errorMessage';

/**
 * The build of a project that this window shows: in the PDF viewers, for SyncTeX, in the output
 * folder, in the Problems view and in the replica's REPLICA_OUTPUT_FOLDER. Overleaf is compiled
 * from several places, such as the web editor, other windows and the command-line tools, and each
 * compile makes a new build that this window does not hear of. Overleaf keeps each user's latest
 * compile of a project in its cache of compile outputs and answers for it
 * (BaseAPI.getLatestCompileFromCache), so the window asks when the latest build may have changed.
 *
 * What the IDE test of 2026-11-01 found on overleaf.com, on the private copy of the book:
 * - Its owner has the priority compile group, and Overleaf's cache kept this window's builds and
 *   other clients' (each with its editor ID), older ones included, until an output deletion
 *   (Recompile from Scratch) cleared them. Whether the shared book's owner has that group is not
 *   determined. Without it, the cache does not keep a compile's PDF (CLSICacheHandler.js:197-224):
 *   the window then shows only its own compiles, and a gone build only comes back by a compile.
 * - One user's compiles ran on four compile servers. Each keeps the two newest builds of the
 *   user's compile folder (OutputCacheManager.js:110-111), so a build is not deleted by newer
 *   builds that another server made.
 * - The book's output.pdf has 885,588,853 bytes and 456 pages, which is why the viewers and Save
 *   PDF read a build in ranges.
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
 * (local-compile-context.tsx:402-425): the same main document; the same draft mode; and a build
 * compiled without stopping on the first error only while the window does not stop either. A build
 * that stopped on the first error is taken either way: a compile that passed while stopping on the
 * first error also passes without it, but not the other way round (local-compile-context.tsx:
 * 417-420). Overleaf's editor also compares png2pdf, which Overleaf's server decides for each user,
 * so the window has no value of its own to compare it with.
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
    /** the compile: Overleaf's answer, and how the replica's REPLICA_OUTPUT_FOLDER records it (outputFiles.ts) */
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
 *   none    Overleaf answered, without a build to show: 404 when its cache has no compile; 410
 *           when the project changed after the latest one (ClsiCacheManager.mjs:52, 108), or
 *           when the project's compiler or TeX Live image is not the cached compile's (141-143);
 *           or an answer that lists no output.pdf. The cache does not keep the PDF of a
 *           standard-group user's compile (CLSICacheHandler.js:197-224); whether Overleaf then
 *           answers 404 or 200 without output.pdf does not show in its source, and both give none
 *   failed  the request failed, with the error
 * `said` is what Overleaf answered, in words, for the log of the builds (BuildsHost.log).
 */
export type LatestAnswer =
    | { kind: 'build', build: Build }
    | { kind: 'none', said?: string }
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

/** Why a successful compile made no build: its answer lists no output.pdf. */
export const NO_OUTPUT_PDF = 'the compile made no output.pdf';

/** Why a check waits: the window has not joined the project on Overleaf yet, or lost it (BuildsHost.joined). */
export const NOT_JOINED = 'the window is not connected to the project on Overleaf yet';

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
 * Who asks ProjectBuilds for a compile, which decides when it asks (whyNotCompile):
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
    /**
     * Whether the window has joined the project now: only then are the settings it compiles with
     * known (settings), such as the main document, which comes with the project's tree
     */
    joined(): boolean;
    /** Log `line`: each check's answer and what the window did with it, so that it can be read later. */
    log(line: string): void;
}

/** `settings` in words, for the log. */
function settingsText(settings: CompileSettings): string {
    return `${settings.rootResourcePath ?? 'the project\'s main document'}, draft ${settings.draft ? 'on' : 'off'}, ${settings.stopOnFirstError ? 'stopping' : 'not stopping'} at the first error`;
}


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
 * (sameSettings). Overleaf answers only for its latest compile, and only while the project has
 * not changed since.
 *
 * A build Y in an answer is taken only if Y's build ID says that Y began later than the build in
 * use X (buildTimeOf), whether X is this window's own compile or another client's. Overleaf stores
 * a compile in its cache after it has answered the compile request, without waiting for the store
 * (CLSICacheHandler.js:142-196): a check after X and before that store answers with the cache's
 * earlier latest, Y, and another client's earlier compile can be stored after a later one. Y can
 * lack an edit that X has: Overleaf answers with its latest compile while the time of the cache's
 * copy is at least the time of the project's last update (ClsiCacheManager.mjs:33-52, 108), and
 * the copy is written after the compile, so an edit made while Y compiled counts as older than Y.
 * Overleaf orders compiles by the times in their build IDs, which it takes before it reads the
 * project (CompileManager.mjs:66). When either ID has another form, the times are not compared:
 * the build is taken unless the window replaced it, and the form is logged once.
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
 * it, so the answer is never older than the event. A check waits while the window has not joined
 * the project (BuildsHost.joined), as when a viewer that the window restores at its load asks, or
 * during a reconnect: an answer is taken against the window's settings, and the main document
 * comes with the project's tree. At the opening the waiting checks are the opening's own check;
 * after a reconnect, one check runs (rejoined). An answer that comes after the window lost the
 * project decides nothing and compiles nothing; the check waits for the next join.
 */
export class ProjectBuilds {
    private current?: Build;
    /** the builds that this window replaced */
    private readonly superseded = new Set<string>();
    /** whether a viewer reported the build in use gone */
    private gone = false;
    /** whether a check is waiting for Overleaf's answer */
    private checking = false;
    /**
     * the checks asked while the window had not joined the project (BuildsHost.joined): the first
     * check that runs after the join settles them (waitForJoin)
     */
    private waitingForJoin?: { promise: Promise<void>, resolve: () => void };
    /** why the last check failed; cleared by the next check that gets an answer */
    private checkError?: string;
    private compile: CompileState = { state: 'idle' };
    private readonly viewers = new Set<BuildViewer>();
    private readonly checks = new CoalescedRuns(() => this.runCheck());
    /** the handling of the project's opening (opened) */
    private opening?: Promise<void>;
    /** whether a build ID of another form than Overleaf's was logged (beganLater) */
    private loggedIdForm = false;
    /**
     * whether the window compiled on its own for a viewer without a build to show, since a viewer
     * last showed a build or the user last compiled (a compile that compiled nothing because
     * nothing had changed does not count): then the next such compile is the user's, so that
     * builds reported gone one after another do not each start a compile
     */
    private compiledForViewer = false;
    /**
     * what a compile of this project that started elsewhere replaced (compileStarted): the
     * compile state and compiledForViewer, which come back when that compile compiled nothing
     */
    private beforeStart?: { compile: CompileState, compiledForViewer: boolean };
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

    /**
     * Ask Overleaf for the latest compile; settles when a check that started after this call has
     * ended. While the window has not joined the project, the check waits for the join, since the
     * window's settings, against which an answer is taken, are not known before it (waitForJoin).
     */
    check(): Promise<void> {
        return this.host.joined() ? this.checks.request() : this.waitForJoin();
    }

    /**
     * The window joined the project again after a lost connection, whose reconnect took the
     * project's tree away: the checks asked meanwhile run now, as one check. At the first join, the
     * opening's check is that check (opened).
     */
    rejoined(): Promise<void> {
        return this.waitingForJoin ? this.checks.request() : Promise.resolve();
    }

    /**
     * A check for when the window has joined the project: as at a window's load, when a restored
     * viewer asks before the join, or during a reconnect. It settles with the first check that runs
     * after the join (runCheck), and the viewers say meanwhile that the window waits for its
     * connection to the project.
     */
    private waitForJoin(): Promise<void> {
        if (!this.waitingForJoin) {
            let resolve!: () => void;
            const promise = new Promise<void>(r => { resolve = r; });
            this.waitingForJoin = { promise, resolve };
            this.host.log('check: waits until the window has joined the project, whose settings it needs');
            this.update();
        }
        return this.waitingForJoin.promise;
    }

    /**
     * The project was opened in this window. Overleaf's latest compile is shown when it is current
     * and was compiled as the window compiles; else the project is compiled, also when Overleaf
     * could not be asked, as Overleaf's editor does when it opens a project
     * (local-compile-context.tsx:383-425). Every call answers with the same promise.
     */
    opened(): Promise<void> {
        this.opening ??= (async () => {
            this.host.log('opening: asks Overleaf for its latest compile');
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
        // the check starts first, so that the viewers say 'checking', and 'gone' only when no
        // compile follows on its own
        const checked = this.check();
        this.update();
        return checked;
    }

    /**
     * A viewer shows the document of build `id`. Once the build in use has been shown, the window
     * compiles on its own again for a viewer without a build to show (compiledForViewer).
     */
    buildShown(id: string) {
        if (id === this.current?.id) {
            this.compiledForViewer = false;
        }
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
            // a compile that the user started, from an editor or with a save; whether it compiles
            // anything shows only at its end, which puts this state back when it did not
            this.beforeStart = { compile: this.compile, compiledForViewer: this.compiledForViewer };
            this.compiledForViewer = false;
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
        this.host.log(`compile ended: ${outcome.result === 'failure' ? `failure: ${outcome.detail}` : outcome.result}`);
        const before = this.beforeStart;
        this.beforeStart = undefined;
        if (outcome.result === 'skipped') {
            // nothing had changed since the last compile, so it compiled nothing and made no build:
            // a compile that started elsewhere leaves the state that it found, a failure and
            // compiledForViewer included; a compile that this project asked for ends here, and a
            // request waiting for it asks again when it has ended
            if (this.compile.state === 'running' && this.compile.started) {
                this.compile = before?.compile ?? { state: 'idle' };
                if (before) {
                    this.compiledForViewer = before.compiledForViewer;
                }
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
        const detail = outcome.result === 'failure' ? outcome.detail : NO_OUTPUT_PDF;
        this.compile = { state: 'failed', status: { state: 'compile-failed', detail } };
        this.update();
    }

    private hasBuildToShow(): boolean {
        return this.current !== undefined && !this.gone;
    }

    private async runCheck(): Promise<void> {
        // this check is the one that the checks waiting for the join wait for
        const waited = this.waitingForJoin;
        this.waitingForJoin = undefined;
        let lost = false;
        try {
            lost = (await this.checkOnce()) === 'lost';
        } finally {
            if (!lost) {
                waited?.resolve();
            }
        }
        if (lost) {
            // the window lost the project before the answer: this check waits for the next join,
            // and so do the checks that waited for it
            const next = this.waitForJoin();
            if (waited) {
                void next.then(waited.resolve);
            }
        }
    }

    /** One check: 'lost' when the window lost the project before Overleaf answered, and the answer decided nothing. */
    private async checkOnce(): Promise<'decided' | 'lost'> {
        this.checking = true;
        this.update();
        let answer: LatestAnswer;
        try {
            answer = await this.host.latest();
        } catch (error) {
            answer = { kind: 'failed', detail: errorMessage(error) };
        }
        this.checking = false;
        if (!this.host.joined()) {
            // the connection was lost while Overleaf answered: without the window's settings the
            // answer decides nothing, and nothing compiles; a check after the join decides
            this.host.log('check: the window lost the project before the answer came; the answer is left');
            return 'lost';
        }
        if (answer.kind === 'failed') {
            this.host.log(`check: failed: ${answer.detail}`);
            this.checkError = answer.detail;
            this.update();
            return 'decided';
        }
        this.checkError = undefined;
        if (answer.kind === 'none') {
            this.host.log(`check: ${answer.said ?? 'Overleaf has no build to show'}`);
        } else {
            const build = answer.build;
            const refused = this.refusal(build);
            this.host.log(`check: Overleaf names build ${build.id} of editor ${build.editorId}, compiled with ${settingsText(build.settings)}; `
                + (refused === undefined ? 'the window takes it' : `the window does not take it: ${refused}`));
            if (refused === undefined) {
                this.replace(build);
                return 'decided';
            }
        }
        // a compile that starts now is shown at once, without the state before it
        await this.compileIfNeeded();
        this.update();
        return 'decided';
    }

    /**
     * Why `build` from Overleaf's answer does not become the build in use: the window has had it,
     * it typeset something else, or it began before the build in use; undefined when it does.
     */
    private refusal(build: Build): string | undefined {
        if (build.id === this.current?.id) {
            return 'it is the build in use';
        }
        if (this.superseded.has(build.id)) {
            return 'the window replaced that build';
        }
        if (!sameSettings(build.settings, this.host.settings())) {
            return `the window compiles with ${settingsText(this.host.settings())}`;
        }
        if (this.current && !this.beganLater(build, this.current)) {
            return 'that build began before it';
        }
        return undefined;
    }

    /**
     * Whether `build` from Overleaf's cache began after `current`, the build in use, as the times
     * in their build IDs say. With an ID of another form the times cannot be compared, and the
     * build counts as later.
     */
    private beganLater(build: Build, current: Build): boolean {
        const time = buildTimeOf(build.id);
        const currentTime = buildTimeOf(current.id);
        if (time === undefined || currentTime === undefined) {
            if (!this.loggedIdForm) {
                this.loggedIdForm = true;
                console.warn(`Overleaf Workshop: the build IDs ${current.id} and ${build.id} are not both of Overleaf's form <time in hex>-<random hex>, so the window takes the build from Overleaf's cache without comparing their times`);
            }
            return true;
        }
        return time > currentTime;
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
     * Why `asker` does not ask for a compile now, in words for the log; undefined when it asks.
     * It never asks while a compile of this project runs or was asked for; the user always asks
     * else; the others ask only while there is no build to show and no failure that waits for the
     * user: at the project's opening, or while a viewer of the build is visible and the window has
     * not compiled for a viewer since a build was shown or the user compiled (compiledForViewer).
     */
    private whyNotCompile(asker: Asker): string | undefined {
        if (this.compile.state === 'running') {
            return 'a compile of the project runs, or was asked for';
        }
        if (asker === 'user') {
            return undefined;
        }
        if (this.hasBuildToShow()) {
            return `it shows build ${this.current!.id}`;
        }
        if (this.compile.state !== 'idle') {
            return 'the last compile failed, and the next one is the user\'s';
        }
        if (asker === 'opening') {
            return undefined;
        }
        if (this.compiledForViewer) {
            return 'it compiled on its own already, and the next compile is the user\'s';
        }
        return [...this.viewers].some(viewer => viewer.visible) ? undefined : 'no viewer of the build is visible';
    }

    /** Ask the window's compile path for the compile that `asker` wants, if it asks now (whyNotCompile). */
    private async startCompile(asker: Asker): Promise<void> {
        const whyNot = this.whyNotCompile(asker);
        // a viewer's request comes with each check: logged only when there is no build to show
        if (asker !== 'viewer' || !this.hasBuildToShow()) {
            this.host.log(`${asker}: ${whyNot === undefined ? 'compiles' : `does not compile: ${whyNot}`}`);
        }
        if (whyNot !== undefined) {
            return;
        }
        if (asker === 'user') {
            this.compiledForViewer = false;
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
            detail = errorMessage(error);
        }
        // the compile may have ended meanwhile (compileEnded), or a build may have come
        if (this.compile !== request) {
            return;
        }
        if (start.kind === 'unavailable') {
            this.host.log(`${asker}: the compile cannot start: ${detail}`);
            this.compile = { state: 'failed', status: { state: 'compile-unavailable', detail } };
            this.update();
        } else if (start.kind === 'started') {
            if (asker === 'viewer') {
                this.compiledForViewer = true;
            }
            this.compile = { state: 'running', started: true };
        } else {
            // the window compiles one project at a time: once the running compile has ended,
            // however it ended, the same asker asks again, unless a build or a failure to show
            // replaced this request meanwhile. A failure of this project that the compile's end
            // reports comes first: the compile fires compileEndedEvent in the same step as it
            // settles `ended`. Not awaited, so that checks go on meanwhile.
            this.host.log(`${asker}: another compile of the window runs; asks again when it has ended`);
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
            // the PDF shown stays valid: a check that waits for the join, or a failed check, only
            // says that it may not be the latest
            if (this.waitingForJoin) {
                return { state: 'unchecked', detail: NOT_JOINED };
            }
            return this.checkError !== undefined ? { state: 'unchecked', detail: this.checkError } : { state: 'ready' };
        }
        if (this.compile.state === 'running') {
            return { state: 'compiling' };
        }
        if (this.compile.state === 'failed') {
            return this.compile.status;
        }
        if (this.waitingForJoin) {
            return { state: 'connecting' };
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
