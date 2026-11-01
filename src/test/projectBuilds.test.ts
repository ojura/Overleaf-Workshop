import * as assert from 'assert';
import type { CompileResponseSchema } from '../api/base';
import {
    Build, BuildsHost, cachedBuild, CoalescedRuns, CompileSettings, CompileStart, LatestAnswer, ownBuild,
    ProjectBuilds, sameSettings,
} from '../core/projectBuilds';
import type { BuildStatus } from '../core/viewerProtocol';

/** A promise and the functions that settle it. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const MAIN: CompileSettings = { rootResourcePath: 'main.tex', draft: false, stopOnFirstError: false };

/** A build ID of Overleaf's form, of a compile begun `seconds` after 2026-11-01 00:00 UTC (buildTimeOf). */
const at = (seconds: number) => `${(Date.parse('2026-11-01T00:00:00Z') + seconds * 1000).toString(16)}-0123456789abcdef`;

/** Overleaf's answer about the latest compile, as ClsiCacheController.getLatestBuildFromCache gives it. */
function cachedResponse(id: string, { editorId = 'web-editor', shard = 'cache-1' as string | undefined, options = {} as Partial<CompileSettings> } = {}) {
    const response = {
        fromCache: true,
        status: 'success',
        compileGroup: 'priority',
        clsiServerId: 'clsi-vm-1',
        ...(shard ? { clsiCacheShard: shard } : {}),
        pdfDownloadDomain: 'https://dl/zone/b',
        outputFiles: [
            { path: 'output.pdf', build: id, editorId, size: 1000, url: `/project/p1/user/u1/build/${id}/output/output.pdf`, type: 'pdf' },
            { path: 'output.log', build: id, url: `/project/p1/user/u1/build/${editorId}-${id}/output/output.log`, downloadURL: `/download/project/p1/build/${editorId}-${id}/output/cached/output.log`, type: 'log' },
        ],
        options: { ...MAIN, ...options },
    };
    return response as unknown as CompileResponseSchema;
}

/** A build from Overleaf's cache, made by another client. */
const fromCache = (id: string, options: Parameters<typeof cachedResponse>[1] = {}) => cachedBuild(cachedResponse(id, options), 0)!;

/** A build of this window's own compile. */
function own(id: string, { shard = 'cache-1' as string | undefined } = {}): Build {
    const response = {
        status: 'success', compileGroup: 'priority', clsiServerId: 'clsi-vm-2', ...(shard ? { clsiCacheShard: shard } : {}),
        outputFiles: [{ path: 'output.pdf', build: id, size: 1000, url: `/project/p1/user/u1/build/${id}/output/output.pdf`, type: 'pdf' }],
    } as unknown as CompileResponseSchema;
    return ownBuild({ response, rootResourcePath: 'main.tex', startedAt: 1, finishedAt: 2 }, 'this-window', MAIN)!;
}

/** The window as ProjectBuilds sees it: Overleaf's answers, the window's settings and its compile path. */
class Host implements BuildsHost {
    /** the answers to the next checks, first to last */
    answers: LatestAnswer[] = [];
    /** answers that a test settles itself: each check takes the next one */
    held: Array<ReturnType<typeof deferred<LatestAnswer>>> = [];
    checks = 0;
    compiles = 0;
    /** what the next compile requests answer; a compile starts when none is given */
    starts: CompileStart[] = [];
    window: CompileSettings = MAIN;
    /** the lines of the log of the builds (BuildsHost.log) */
    lines: string[] = [];
    /** the waiters for the next compile request */
    private readonly compileWaiters: Array<() => void> = [];

    latest(): Promise<LatestAnswer> {
        this.checks += 1;
        const held = this.held.shift();
        if (held) { return held.promise; }
        const answer = this.answers.shift();
        if (!answer) { throw new Error(`check ${this.checks} has no answer`); }
        return Promise.resolve(answer);
    }
    settings() { return this.window; }
    log(line: string) { this.lines.push(line); }
    async compile(): Promise<CompileStart> {
        this.compiles += 1;
        this.compileWaiters.splice(0).forEach(resolve => resolve());
        return this.starts.shift() ?? { kind: 'started' };
    }
    /** settles at the next compile request */
    nextCompile(): Promise<void> {
        return new Promise(resolve => this.compileWaiters.push(resolve));
    }
}

/** A project's builds with a viewer, and the statuses and builds it reported. */
function setup({ visible = true } = {}) {
    const host = new Host();
    const builds = new ProjectBuilds(host);
    const viewer = { visible };
    builds.attachViewer(viewer);
    const statuses: BuildStatus[] = [];
    const changes: string[] = [];
    builds.onDidChangeStatus(status => statuses.push(status));
    builds.onDidChangeBuild(build => changes.push(build.id));
    return { host, builds, viewer, statuses, changes };
}

describe('the build in use (ProjectBuilds)', () => {
    it('takes another client\'s build that the window has not had, begun after its own', async () => {
        const { host, builds, changes } = setup();
        builds.useOwn(own(at(0)));
        host.answers.push({ kind: 'build', build: fromCache(at(10)) });
        await builds.check();
        assert.strictEqual(builds.build?.id, at(10));
        assert.deepStrictEqual(changes, [at(0), at(10)]);
        assert.deepStrictEqual(builds.status, { state: 'ready' });
    });

    it('ignores an answer naming a build that the window replaced', async () => {
        const { host, builds, changes } = setup();
        host.answers.push({ kind: 'build', build: fromCache('w') });
        await builds.check();
        // this window's compile replaces w; Overleaf's cache may still name w as its latest
        builds.useOwn(own('x'));
        host.answers.push({ kind: 'build', build: fromCache('w') });
        await builds.check();
        assert.strictEqual(builds.build?.id, 'x');
        assert.deepStrictEqual(changes, ['w', 'x']);
    });

    it('keeps its own build x, which has the last edit, while the cache still names the earlier y (the known case)', async () => {
        const { host, builds, changes } = setup();
        // y began before x and before the edit; Overleaf stores x in its cache after it answered
        // x's compile, so a check before that store answers y, which Overleaf takes for current
        // since its copy was written after the edit
        const x = at(20);
        const y = at(10);
        builds.useOwn(own(x));
        host.answers.push({ kind: 'build', build: fromCache(y) });
        await builds.check();
        assert.strictEqual(builds.build?.id, x);
        // once Overleaf has stored x, its answer names the build in use
        host.answers.push({ kind: 'build', build: fromCache(x, { editorId: 'this-window' }) });
        await builds.check();
        assert.strictEqual(builds.build?.id, x);
        assert.deepStrictEqual(changes, [x]);
        assert.deepStrictEqual(builds.status, { state: 'ready' });
    });

    it('compares the times with another client\'s build too: it keeps that build when the cache names an earlier one afterwards', async () => {
        const { host, builds, changes } = setup();
        // the cache's stores are not ordered: another client's earlier compile can be stored after a later one
        host.answers.push({ kind: 'build', build: fromCache(at(20)) }, { kind: 'build', build: fromCache(at(10)) }, { kind: 'build', build: fromCache(at(30)) });
        await builds.check();
        await builds.check();
        assert.strictEqual(builds.build?.id, at(20));
        await builds.check();
        assert.deepStrictEqual(changes, [at(20), at(30)]);
    });

    it('does not take an earlier build that the window never had after another client\'s later build (the review\'s scratch T1)', async () => {
        // the window's x, then another client's later w, then the earlier y
        const { host, builds, changes } = setup();
        builds.useOwn(own(at(20)));
        host.answers.push({ kind: 'build', build: fromCache(at(30)) }, { kind: 'build', build: fromCache(at(10)) });
        await builds.check();
        await builds.check();
        assert.deepStrictEqual(changes, [at(20), at(30)]);
    });

    it('does not go back to an earlier build when the build in use is gone, and compiles instead', async () => {
        const { host, builds } = setup();
        host.answers.push({ kind: 'build', build: fromCache(at(20)) }, { kind: 'build', build: fromCache(at(10)) });
        await builds.check();
        await builds.reportGone(at(20));
        assert.strictEqual(builds.build?.id, at(20));
        assert.strictEqual(host.compiles, 1);
        assert.deepStrictEqual(builds.status, { state: 'compiling' });
    });

    it('with a build ID of another form, takes a build that it has not had, and says once that it cannot compare them', async () => {
        const warnings: string[] = [];
        const warn = console.warn;
        console.warn = (message: string) => { warnings.push(message); };
        try {
            const { host, builds } = setup();
            builds.useOwn(own('x'));
            host.answers.push({ kind: 'build', build: fromCache(at(10)) });
            await builds.check();
            assert.strictEqual(builds.build?.id, at(10));
            builds.useOwn(own(at(30)));
            host.answers.push({ kind: 'build', build: fromCache('w') });
            await builds.check();
            assert.strictEqual(builds.build?.id, 'w');
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /x and .* are not both of Overleaf's form/);
        } finally {
            console.warn = warn;
        }
    });

    it('takes another client\'s build after one whose compile named no shard of the cache', async () => {
        const { host, builds } = setup();
        builds.useOwn(own(at(0), { shard: undefined }));
        host.answers.push({ kind: 'build', build: fromCache(at(10)) });
        await builds.check();
        assert.strictEqual(builds.build?.id, at(10));
    });

    describe('takes a build only if it was compiled as the window compiles (sameSettings)', () => {
        const cases: Array<[string, Partial<CompileSettings>, Partial<CompileSettings>, boolean]> = [
            ['of another main document', { rootResourcePath: 'chapters/one.tex' }, {}, false],
            ['in draft mode while the window compiles without it', { draft: true }, {}, false],
            ['without draft mode while the window compiles in it', { draft: false }, { draft: true }, false],
            ['without stopping on the first error while the window stops', { stopOnFirstError: false }, { stopOnFirstError: true }, false],
            ['stopping on the first error while the window does not stop', { stopOnFirstError: true }, { stopOnFirstError: false }, true],
            ['with the window\'s settings', {}, {}, true],
        ];
        for (const [what, build, window, taken] of cases) {
            it(`${taken ? 'takes' : 'ignores'} a build ${what}`, async () => {
                const { host, builds } = setup();
                builds.useOwn(own(at(0)));
                host.window = { ...MAIN, ...window };
                host.answers.push({ kind: 'build', build: fromCache(at(10), { options: build }) });
                await builds.check();
                assert.strictEqual(builds.build?.id, taken ? at(10) : at(0));
                assert.strictEqual(sameSettings({ ...MAIN, ...build }, { ...MAIN, ...window }), taken);
            });
        }
    });

    // Overleaf's 404 (no compile in its cache) and 410 (the project changed after it) both give
    // 'none' (VirtualFileSystem.latestBuild)
    it('keeps a build that is still served when Overleaf has no newer one', async () => {
        const { host, builds } = setup();
        builds.useOwn(own('x'));
        host.answers.push({ kind: 'none' });
        await builds.check();
        assert.strictEqual(builds.build?.id, 'x');
        assert.strictEqual(host.compiles, 0);
        assert.deepStrictEqual(builds.status, { state: 'ready' });
    });

    it('compiles once when the build in use is gone and Overleaf has no newer one', async () => {
        const { host, builds, statuses } = setup();
        builds.useOwn(own('x'));
        statuses.length = 0;
        host.answers.push({ kind: 'none' }, { kind: 'none' });
        await builds.reportGone('x');
        assert.strictEqual(host.compiles, 1);
        assert.deepStrictEqual(builds.status, { state: 'compiling' });
        // the viewer reports the same build again, and the window is focused: one compile still
        await builds.reportGone('x');
        assert.strictEqual(host.compiles, 1);
        // the compile's build replaces the gone one, as any compile's does
        builds.useOwn(own('z'));
        builds.compileEnded({ result: 'success' }, true);
        assert.strictEqual(builds.build?.id, 'z');
        // the check starts with the report, so 'gone' shows only when no compile follows
        assert.deepStrictEqual(statuses.map(s => s.state), ['checking', 'compiling', 'ready']);
    });

    describe('compiles on its own once, until a viewer shows a build or the user compiles', () => {
        /** A project whose build x a viewer showed, then reported gone; the window compiled y for it. */
        async function goneOnce() {
            const { host, builds } = setup();
            builds.useOwn(own(at(0)));
            builds.buildShown(at(0));
            host.answers.push({ kind: 'none' }, { kind: 'none' });
            await builds.reportGone(at(0));
            assert.strictEqual(host.compiles, 1);
            builds.useOwn(own(at(10)));
            builds.compileEnded({ result: 'success' }, true);
            return { host, builds };
        }

        it('does not compile on its own for a build that goes before a viewer has shown it, and leaves Recompile to the user', async () => {
            const { host, builds } = await goneOnce();
            await builds.reportGone(at(10));
            assert.strictEqual(host.compiles, 1);
            assert.deepStrictEqual(builds.status, { state: 'gone' });
            await builds.recompile();
            assert.strictEqual(host.compiles, 2);
        });

        it('compiles on its own again once a viewer has shown the build', async () => {
            const { host, builds } = await goneOnce();
            builds.buildShown(at(10));
            await builds.reportGone(at(10));
            assert.strictEqual(host.compiles, 2);
        });

        it('compiles on its own again after a compile that the user started elsewhere', async () => {
            const { host, builds } = await goneOnce();
            // the user compiles from an editor; its build too goes before a viewer shows it
            builds.compileStarted(true);
            builds.useOwn(own(at(20)));
            builds.compileEnded({ result: 'success' }, true);
            host.answers.push({ kind: 'none' });
            await builds.reportGone(at(20));
            assert.strictEqual(host.compiles, 2);
        });

        it('does not count a compile that the user started elsewhere when it compiled nothing (skipped)', async () => {
            const { host, builds } = await goneOnce();
            await builds.reportGone(at(10));
            assert.deepStrictEqual(builds.status, { state: 'gone' });
            // a compile on save finds nothing changed since the last compile
            builds.compileStarted(true);
            builds.compileEnded({ result: 'skipped' }, true);
            assert.deepStrictEqual(builds.status, { state: 'gone' });
            host.answers.push({ kind: 'none' });
            await builds.check();
            assert.strictEqual(host.compiles, 1);
        });

        it('does not count the compile at the project\'s opening, while no viewer was visible', async () => {
            const { host, builds, viewer } = setup({ visible: false });
            host.answers.push({ kind: 'none' }, { kind: 'none' });
            await builds.opened();
            assert.strictEqual(host.compiles, 1);
            builds.useOwn(own(at(0)));
            builds.compileEnded({ result: 'success' }, true);
            // the PDF opens later, when that build has gone
            viewer.visible = true;
            await builds.reportGone(at(0));
            assert.strictEqual(host.compiles, 2);
        });
    });

    it('compiles once when it knows no build and Overleaf has none, as after a reload', async () => {
        const { host, builds } = setup();
        host.answers.push({ kind: 'none' });
        await builds.check();
        assert.strictEqual(host.compiles, 1);
        assert.deepStrictEqual(builds.status, { state: 'compiling' });
    });

    it('compiles only while a viewer of the build is visible, and then at its next check', async () => {
        const { host, builds, viewer } = setup({ visible: false });
        host.answers.push({ kind: 'none' }, { kind: 'none' });
        await builds.check();
        assert.strictEqual(host.compiles, 0);
        assert.deepStrictEqual(builds.status, { state: 'none' });
        viewer.visible = true;
        await builds.check();
        assert.strictEqual(host.compiles, 1);
    });

    it('says why the compile failed, and leaves the next compile to the user', async () => {
        const { host, builds } = setup();
        host.answers.push({ kind: 'none' }, { kind: 'none' });
        await builds.check();
        builds.compileEnded({ result: 'failure', detail: 'Overleaf\'s status is "failure"' }, true);
        assert.deepStrictEqual(builds.status, { state: 'compile-failed', detail: 'Overleaf\'s status is "failure"' });
        await builds.check();
        assert.strictEqual(host.compiles, 1);
        assert.deepStrictEqual(builds.status, { state: 'compile-failed', detail: 'Overleaf\'s status is "failure"' });
        // the user's Recompile makes a build: the window shows it
        builds.useOwn(own('z'));
        assert.deepStrictEqual(builds.status, { state: 'ready' });
    });

    it('keeps the failure of its compile when a compile that the user started elsewhere compiled nothing (skipped)', async () => {
        const { host, builds } = setup();
        host.answers.push({ kind: 'none' }, { kind: 'none' });
        await builds.check();
        const failed: BuildStatus = { state: 'compile-failed', detail: 'Overleaf\'s status is "failure"' };
        builds.compileEnded({ result: 'failure', detail: 'Overleaf\'s status is "failure"' }, true);
        // a compile on save finds nothing changed since the failed compile
        builds.compileStarted(true);
        assert.deepStrictEqual(builds.status, { state: 'compiling' });
        builds.compileEnded({ result: 'skipped' }, true);
        assert.deepStrictEqual(builds.status, failed);
        // the viewer becomes visible again: the failure waits for the user, and nothing compiles on its own
        await builds.check();
        assert.strictEqual(host.compiles, 1);
        assert.deepStrictEqual(builds.status, failed);
    });

    it('says that it compiles while a compile of the project runs that it did not ask for, until that compile ends', () => {
        const { host, builds, statuses } = setup({ visible: false });
        // another project's compile
        builds.compileStarted(false);
        assert.deepStrictEqual(builds.status, { state: 'none' });
        // this project's, from an editor
        builds.compileStarted(true);
        assert.deepStrictEqual(builds.status, { state: 'compiling' });
        builds.compileEnded({ result: 'failure', detail: 'Overleaf\'s status is "failure"' }, true);
        assert.deepStrictEqual(builds.status, { state: 'compile-failed', detail: 'Overleaf\'s status is "failure"' });
        assert.deepStrictEqual(statuses.map(s => s.state), ['compiling', 'compile-failed']);
        assert.strictEqual(host.compiles, 0);
    });

    it('ends the compiling state when a compile that it started turns out to have nothing to compile', async () => {
        const { host, builds } = setup();
        host.answers.push({ kind: 'none' });
        await builds.check();
        assert.deepStrictEqual(builds.status, { state: 'compiling' });
        builds.compileEnded({ result: 'skipped' }, true);
        assert.deepStrictEqual(builds.status, { state: 'none' });
        assert.strictEqual(host.compiles, 1);
    });

    it('compiles at the user\'s Recompile after a failure, once however often it is clicked, and says so from the click', async () => {
        const { host, builds } = setup({ visible: false });
        builds.compileStarted(true);
        builds.compileEnded({ result: 'failure', detail: 'Overleaf\'s status is "failure"' }, true);
        assert.strictEqual(builds.status.state, 'compile-failed');
        const first = builds.recompile();
        assert.deepStrictEqual(builds.status, { state: 'compiling' });
        await builds.recompile();
        await first;
        assert.strictEqual(host.compiles, 1);
        assert.deepStrictEqual(builds.status, { state: 'compiling' });
    });

    it('says why when the compile cannot start', async () => {
        const { host, builds } = setup();
        host.answers.push({ kind: 'none' });
        host.starts.push({ kind: 'unavailable' });
        await builds.check();
        assert.strictEqual(builds.status.state, 'compile-unavailable');
        assert.ok(builds.status.detail);
    });

    describe('when another compile of the window kept its compile from starting', () => {
        /** a project without a build, whose compile request found the window busy with the compile `running` */
        async function waiting() {
            const { host, builds, statuses } = setup();
            const running = deferred<void>();
            host.answers.push({ kind: 'none' });
            host.starts.push({ kind: 'busy', ended: running.promise });
            await builds.check();
            assert.strictEqual(host.compiles, 1);
            assert.deepStrictEqual(builds.status, { state: 'compiling' });
            return { host, builds, statuses, running };
        }

        it('compiles once another project\'s compile has ended', async () => {
            const { host, builds, running } = await waiting();
            builds.compileEnded({ result: 'success' }, false);
            const asked = host.nextCompile();
            running.resolve();
            await asked;
            assert.strictEqual(host.compiles, 2);
            assert.deepStrictEqual(builds.status, { state: 'compiling' });
        });

        it('compiles once a compile of this project turned out to have nothing to compile', async () => {
            const { host, builds, running } = await waiting();
            builds.compileEnded({ result: 'skipped' }, true);
            const asked = host.nextCompile();
            running.resolve();
            await asked;
            assert.strictEqual(host.compiles, 2);
        });

        it('compiles once that compile has ended before it compiled anything, which reports no end', async () => {
            const { host, builds, running } = await waiting();
            const asked = host.nextCompile();
            running.resolve();
            await asked;
            assert.strictEqual(host.compiles, 2);
            assert.deepStrictEqual(builds.status, { state: 'compiling' });
        });

        // ProjectBuilds took its reaction to `running` when it found the window busy, and the
        // reactions to one promise run in the order they were taken: the tests' own waits for
        // `running` below go on after ProjectBuilds' reaction has run
        it('does not compile again when that compile was of this project and failed', async () => {
            const { host, builds, running } = await waiting();
            builds.compileEnded({ result: 'failure', detail: 'Overleaf\'s status is "failure"' }, true);
            running.resolve();
            await running.promise;
            assert.strictEqual(host.compiles, 1);
            assert.deepStrictEqual(builds.status, { state: 'compile-failed', detail: 'Overleaf\'s status is "failure"' });
        });

        it('asks again for the opening\'s compile when that compile has ended, also without a visible viewer', async () => {
            const { host, builds } = setup({ visible: false });
            const running = deferred<void>();
            host.answers.push({ kind: 'none' });
            host.starts.push({ kind: 'busy', ended: running.promise });
            await builds.opened();
            assert.strictEqual(host.compiles, 1);
            running.resolve();
            await running.promise;
            assert.strictEqual(host.compiles, 2);
        });

        it('asks again for the user\'s Recompile when that compile has ended', async () => {
            const { host, builds } = setup({ visible: false });
            const running = deferred<void>();
            host.starts.push({ kind: 'busy', ended: running.promise });
            await builds.recompile();
            assert.deepStrictEqual(builds.status, { state: 'compiling' });
            running.resolve();
            await running.promise;
            assert.strictEqual(host.compiles, 2);
        });

        it('checks meanwhile, and does not compile again when a build came', async () => {
            const { host, builds, running } = await waiting();
            host.answers.push({ kind: 'build', build: fromCache('y') });
            await builds.check();
            assert.strictEqual(builds.build?.id, 'y');
            running.resolve();
            await running.promise;
            assert.strictEqual(host.compiles, 1);
            assert.deepStrictEqual(builds.status, { state: 'ready' });
        });
    });

    it('stores a failed check, says why, and keeps the build it has', async () => {
        const { host, builds } = setup();
        builds.useOwn(own('x'));
        host.answers.push({ kind: 'failed', detail: 'fetch failed: Headers Timeout Error' });
        await builds.check();
        assert.strictEqual(builds.build?.id, 'x');
        // quietly: the PDF shown stays, and only may not be the latest
        assert.deepStrictEqual(builds.status, { state: 'unchecked', detail: 'fetch failed: Headers Timeout Error' });
        host.answers.push({ kind: 'none' });
        await builds.check();
        assert.deepStrictEqual(builds.status, { state: 'ready' });
    });

    it('does not compile after a failed check, and says why there is no build', async () => {
        const { host, builds } = setup();
        host.answers.push({ kind: 'failed', detail: '503: unavailable' });
        await builds.check();
        assert.strictEqual(host.compiles, 0);
        assert.deepStrictEqual(builds.status, { state: 'check-failed', detail: '503: unavailable' });
    });

    it('says why a check failed with the failure\'s cause, as fetch reports one', async () => {
        const { host, builds } = setup();
        host.latest = () => Promise.reject(Object.assign(new Error('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') }));
        await builds.check();
        assert.deepStrictEqual(builds.status, { state: 'check-failed', detail: 'fetch failed: connect ECONNREFUSED 127.0.0.1:443' });
    });

    it('takes a check that throws for a failed one', async () => {
        const { host, builds } = setup();
        host.latest = () => Promise.reject(new Error('not logged in'));
        await builds.check();
        assert.deepStrictEqual(builds.status, { state: 'check-failed', detail: 'not logged in' });
    });

    it('says that it asks Overleaf while it has no build to show, and stays quiet while it has one', async () => {
        const { host, builds, statuses } = setup();
        const first = deferred<LatestAnswer>();
        host.held.push(first);
        const check = builds.check();
        assert.deepStrictEqual(builds.status, { state: 'checking' });
        first.resolve({ kind: 'build', build: fromCache('y') });
        await check;
        assert.deepStrictEqual(builds.status, { state: 'ready' });
        const second = deferred<LatestAnswer>();
        host.held.push(second);
        statuses.length = 0;
        const quiet = builds.check();
        second.resolve({ kind: 'none' });
        await quiet;
        assert.deepStrictEqual(statuses, []);
    });

    describe('when the project opens', () => {
        it('shows Overleaf\'s latest compile when it is current, and compiles nothing', async () => {
            const { host, builds } = setup({ visible: false });
            host.answers.push({ kind: 'build', build: fromCache('y') });
            await builds.opened();
            assert.strictEqual(builds.build?.id, 'y');
            assert.strictEqual(host.compiles, 0);
        });

        it('compiles when Overleaf has no current compile, also with no viewer of the build', async () => {
            const { host, builds } = setup({ visible: false });
            host.answers.push({ kind: 'none' });
            await builds.opened();
            assert.strictEqual(host.compiles, 1);
        });

        it('compiles when the latest compile typeset another main document', async () => {
            const { host, builds } = setup({ visible: false });
            host.answers.push({ kind: 'build', build: fromCache('y', { options: { rootResourcePath: 'chapters/one.tex' } }) });
            await builds.opened();
            assert.strictEqual(builds.build, undefined);
            assert.strictEqual(host.compiles, 1);
        });

        it('compiles when Overleaf could not be asked', async () => {
            const { host, builds } = setup({ visible: false });
            host.answers.push({ kind: 'failed', detail: 'fetch failed' });
            await builds.opened();
            assert.strictEqual(host.compiles, 1);
            assert.deepStrictEqual(builds.status, { state: 'compiling' });
        });

        it('logs Overleaf\'s answer and what the window did with it, so that each opening can be read later', async () => {
            const opening = async (answer: LatestAnswer) => {
                const { host, builds } = setup({ visible: false });
                host.answers.push(answer);
                await builds.opened();
                return host.lines;
            };
            const asks = 'opening: asks Overleaf for its latest compile';
            const noViewer = 'viewer: does not compile: no viewer of the build is visible';
            assert.deepStrictEqual(await opening({ kind: 'build', build: fromCache('y') }), [
                asks,
                'check: Overleaf names build y of editor web-editor, compiled with main.tex, draft off, not stopping at the first error; the window takes it',
                'opening: does not compile: it shows build y',
            ]);
            assert.deepStrictEqual(await opening({ kind: 'none', said: 'Overleaf answers 410: the project changed after its latest compile' }), [
                asks, 'check: Overleaf answers 410: the project changed after its latest compile', noViewer, 'opening: compiles',
            ]);
            assert.deepStrictEqual(await opening({ kind: 'build', build: fromCache('y', { options: { rootResourcePath: 'chapters/one.tex' } }) }), [
                asks,
                'check: Overleaf names build y of editor web-editor, compiled with chapters/one.tex, draft off, not stopping at the first error; '
                    + 'the window does not take it: the window compiles with main.tex, draft off, not stopping at the first error',
                noViewer, 'opening: compiles',
            ]);
            assert.deepStrictEqual(await opening({ kind: 'failed', detail: 'fetch failed: connect ECONNREFUSED 127.0.0.1:443' }), [
                asks, 'check: failed: fetch failed: connect ECONNREFUSED 127.0.0.1:443', 'opening: compiles',
            ]);
        });

        it('does it once, whoever asks', async () => {
            const { host, builds } = setup({ visible: false });
            host.answers.push({ kind: 'none' });
            assert.strictEqual(builds.opened(), builds.opened());
            await builds.opened();
            assert.strictEqual(host.checks, 1);
            assert.strictEqual(host.compiles, 1);
        });
    });

    it('ignores a report about a build that is no longer in use', async () => {
        const { host, builds } = setup();
        builds.useOwn(own('x'));
        builds.useOwn(own('z'));
        await builds.reportGone('x');
        assert.strictEqual(host.checks, 0);
        assert.deepStrictEqual(builds.status, { state: 'ready' });
    });
});

describe('checks one at a time (CoalescedRuns)', () => {
    it('runs exactly one more check for any number of events during a check', async () => {
        const runs: Array<ReturnType<typeof deferred<void>>> = [];
        const coalesced = new CoalescedRuns(() => {
            const run = deferred<void>();
            runs.push(run);
            return run.promise;
        });
        const first = coalesced.request();
        const during = [coalesced.request(), coalesced.request(), coalesced.request()];
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(during[0], during[2], 'the requests during a run share the next one');
        runs[0].resolve();
        await first;
        assert.strictEqual(runs.length, 2);
        runs[1].resolve();
        await Promise.all(during);
        assert.strictEqual(runs.length, 2);
    });

    it('settles a request only after a run that started after it', async () => {
        const runs: Array<ReturnType<typeof deferred<void>>> = [];
        const coalesced = new CoalescedRuns(() => {
            const run = deferred<void>();
            runs.push(run);
            return run.promise;
        });
        void coalesced.request();
        let settled = false;
        const late = coalesced.request().then(() => { settled = true; });
        runs[0].resolve();
        await Promise.resolve();
        await Promise.resolve();
        assert.strictEqual(settled, false, 'the run in flight began before the request');
        runs[1].resolve();
        await late;
        assert.strictEqual(settled, true);
    });

    it('runs the queued check after a run that failed, and reports each run\'s own failure', async () => {
        const runs: Array<ReturnType<typeof deferred<void>>> = [];
        const coalesced = new CoalescedRuns(() => {
            const run = deferred<void>();
            runs.push(run);
            return run.promise;
        });
        const first = coalesced.request();
        const second = coalesced.request();
        runs[0].reject(new Error('first'));
        await assert.rejects(first, /first/);
        assert.strictEqual(runs.length, 2);
        runs[1].resolve();
        await second;
    });
});
