import * as assert from 'assert';
import type { CompileResponseSchema } from '../api/base';
import {
    BUILD_REFRESH_INTERVAL_MS, Build, BuildRefreshScheduler, BuildsHost, CompileSettings,
    CompileStart, LatestAnswer, ProjectBuilds,
} from '../core/projectBuilds';

/** Finish continuations from a completed request or fired event without advancing elapsed time. */
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

class Clock implements BuildRefreshScheduler {
    private now = 0;
    readonly jobs = new Set<{ at: number, callback: () => void }>();
    after(ms: number, callback: () => void) {
        const job = { at: this.now + ms, callback };
        this.jobs.add(job);
        return () => { this.jobs.delete(job); };
    }
    async advance(ms: number) {
        const end = this.now + ms;
        for (;;) {
            const next = [...this.jobs].sort((a, b) => a.at - b.at)[0];
            if (!next || next.at > end) { break; }
            this.now = next.at;
            this.jobs.delete(next);
            next.callback();
            await settled();
        }
        this.now = end;
        await settled();
    }
}

const MAIN: CompileSettings = { rootResourcePath: 'main.tex', draft: false, stopOnFirstError: false };
const none: LatestAnswer = { kind: 'none', said: 'Overleaf answers 410' };
const at = (seconds: number) => `${(Date.parse('2026-11-04T14:00:00Z') + seconds * 1000).toString(16)}-0123456789abcdef`;

function build(seconds: number, settings = MAIN): Build {
    return {
        id: at(seconds), editorId: 'external-editor', settings,
        record: { rootResourcePath: settings.rootResourcePath, response: { status: 'success', fromCache: true } as CompileResponseSchema },
    };
}

class Host implements BuildsHost {
    answer: LatestAnswer = none;
    readonly held: Array<ReturnType<typeof deferred<LatestAnswer>>> = [];
    readonly starts: CompileStart[] = [];
    checks = 0;
    compiles = 0;
    active = 0;
    maxActive = 0;
    joinedNow = true;
    readonly lines: string[] = [];
    async latest() {
        this.checks++;
        this.active++;
        this.maxActive = Math.max(this.maxActive, this.active);
        try { return await (this.held.shift()?.promise ?? this.answer); }
        finally { this.active--; }
    }
    settings() { return MAIN; }
    joined() { return this.joinedNow; }
    log(line: string) { this.lines.push(line); }
    async compile(): Promise<CompileStart> {
        this.compiles++;
        return this.starts.shift() ?? { kind: 'started' };
    }
}

describe('metadata freshness owned by ProjectBuilds', () => {
    let host: Host;
    let clock: Clock;
    let builds: ProjectBuilds;
    let viewer: { visible: boolean };
    let changes: string[];

    beforeEach(() => {
        host = new Host();
        clock = new Clock();
        builds = new ProjectBuilds(host, clock);
        viewer = { visible: true };
        builds.attachViewer(viewer);
        changes = [];
        builds.onDidChangeBuild(value => { changes.push(value.id); });
    });

    afterEach(() => {
        builds.dispose();
        assert.strictEqual(clock.jobs.size, 0, 'the owner leaves no timer behind');
    });

    it('waits for the actual window focus before starting its cadence', async () => {
        assert.strictEqual(clock.jobs.size, 0);
        await clock.advance(BUILD_REFRESH_INTERVAL_MS * 3);
        assert.strictEqual(host.checks, 0);
        builds.setWindowFocused(true);
        await settled();
        assert.strictEqual(host.checks, 1);
        assert.strictEqual(clock.jobs.size, 1);
        assert.strictEqual(host.compiles, 0);
    });

    it('schedules after completion, with no overlapping requests or timer during a slow check', async () => {
        builds.useOwn(build(1));
        builds.setWindowFocused(true);
        await settled();
        const held = deferred<LatestAnswer>();
        host.held.push(held);
        await clock.advance(BUILD_REFRESH_INTERVAL_MS);
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(clock.jobs.size, 0);
        await clock.advance(BUILD_REFRESH_INTERVAL_MS * 10);
        assert.strictEqual(host.checks, 2);
        held.resolve({ kind: 'build', build: build(2) });
        await settled();
        assert.strictEqual(builds.build?.id, at(2));
        assert.strictEqual(clock.jobs.size, 1);
        await clock.advance(BUILD_REFRESH_INTERVAL_MS - 1);
        assert.strictEqual(host.checks, 2);
        await clock.advance(1);
        assert.strictEqual(host.checks, 3);
        assert.strictEqual(host.maxActive, 1);
        assert.strictEqual(host.compiles, 0);
    });

    it('keeps retrying metadata after missing, expired and failed answers without a build or a compile', async () => {
        const answers: LatestAnswer[] = [
            { kind: 'none', said: 'Overleaf answers 404' },
            none,
            { kind: 'failed', detail: 'invalid cached-build JSON' },
            { kind: 'failed', detail: 'fetch failed' },
            { kind: 'none', said: 'the response has no output.pdf' },
        ];
        host.answer = answers.shift()!;
        builds.setWindowFocused(true);
        await settled();
        for (const answer of answers) {
            host.answer = answer;
            await clock.advance(BUILD_REFRESH_INTERVAL_MS);
            assert.strictEqual(host.compiles, 0);
            assert.strictEqual(clock.jobs.size, 1);
        }
        host.answer = { kind: 'build', build: build(1) };
        await clock.advance(BUILD_REFRESH_INTERVAL_MS);
        assert.strictEqual(builds.build?.id, at(1));
        assert.strictEqual(host.compiles, 0);
    });

    it('stops offline and checks on rejoin without needing a focus or panel event', async () => {
        builds.useOwn(build(1));
        builds.setWindowFocused(true);
        await settled();
        const checked = host.checks;
        host.joinedNow = false;
        await clock.advance(BUILD_REFRESH_INTERVAL_MS * 3);
        assert.strictEqual(host.checks, checked);
        assert.strictEqual(clock.jobs.size, 0);
        host.answer = { kind: 'build', build: build(2) };
        host.joinedNow = true;
        await builds.rejoined();
        assert.strictEqual(host.checks, checked + 1);
        assert.strictEqual(builds.build?.id, at(2));
        assert.strictEqual(clock.jobs.size, 1);
    });

    it('checks on a short disconnect and rejoin before the old timer could notice it', async () => {
        builds.setWindowFocused(true);
        await settled();
        host.joinedNow = false;
        host.joinedNow = true;
        host.answer = { kind: 'build', build: build(1) };
        await builds.rejoined();
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(builds.build?.id, at(1));
        assert.strictEqual(clock.jobs.size, 1);
        await clock.advance(BUILD_REFRESH_INTERVAL_MS);
        assert.strictEqual(host.checks, 3);
    });

    it('leaves an answer received offline and resumes a metadata-only check on rejoin', async () => {
        const held = deferred<LatestAnswer>();
        host.held.push(held);
        builds.setWindowFocused(true);
        host.joinedNow = false;
        held.resolve({ kind: 'build', build: build(1) });
        await settled();
        assert.deepStrictEqual(changes, []);
        assert.strictEqual(clock.jobs.size, 0);
        host.joinedNow = true;
        await builds.rejoined();
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(host.compiles, 0);
        assert.strictEqual(clock.jobs.size, 1);
    });

    it('coalesces events during a check into one follow-up without overlapping them', async () => {
        const first = deferred<LatestAnswer>();
        const second = deferred<LatestAnswer>();
        host.held.push(first, second);
        builds.setWindowFocused(true);
        const during = [builds.checkForUpdates(), builds.checkForUpdates()];
        builds.setWindowFocused(false);
        builds.setWindowFocused(true);
        builds.viewerStateChanged();
        assert.strictEqual(host.checks, 1);
        first.resolve(none);
        await settled();
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(clock.jobs.size, 0);
        second.resolve({ kind: 'build', build: build(1) });
        await Promise.all(during);
        await settled();
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(clock.jobs.size, 1);
        assert.strictEqual(host.maxActive, 1);
        assert.strictEqual(host.compiles, 0);
    });

    it('does not inherit an ordinary run\'s compile permission for a queued metadata-only run', async () => {
        viewer.visible = false;
        const first = deferred<LatestAnswer>();
        const second = deferred<LatestAnswer>();
        host.held.push(first, second);
        const ordinary = builds.check();
        const metadata = builds.checkForUpdates();
        first.resolve(none);
        await ordinary;
        viewer.visible = true;
        second.resolve(none);
        await metadata;
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(host.compiles, 0);
    });

    it('drops an automatic follow-up queued before the window was blurred', async () => {
        const held = deferred<LatestAnswer>();
        host.held.push(held);
        builds.setWindowFocused(true);
        builds.setWindowFocused(false);
        builds.setWindowFocused(true);
        builds.setWindowFocused(false);
        held.resolve(none);
        await settled();
        assert.strictEqual(host.checks, 1);
        assert.strictEqual(clock.jobs.size, 0);
        builds.setWindowFocused(true);
        await settled();
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(clock.jobs.size, 1);
        assert.strictEqual(host.compiles, 0);
    });

    it('preserves an ordinary request\'s compile permission when metadata events share its queued run', async () => {
        const first = deferred<LatestAnswer>();
        const second = deferred<LatestAnswer>();
        host.held.push(first, second);
        const metadata = builds.checkForUpdates();
        const during = [builds.checkForUpdates(), builds.check(), builds.checkForUpdates()];
        first.resolve(none);
        await metadata;
        assert.strictEqual(host.compiles, 0, 'the first metadata-only run cannot compile');
        second.resolve(none);
        await Promise.all(during);
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(host.compiles, 1, 'the explicit ordinary request retains its missing-build policy');
    });

    it('does not send a queued check after connection loss, and preserves the ordinary waiter for rejoin', async () => {
        const first = deferred<LatestAnswer>();
        host.held.push(first);
        const metadata = builds.checkForUpdates();
        const ordinary = builds.check();
        host.joinedNow = false;
        first.resolve(none);
        await Promise.all([metadata, ordinary]);
        assert.strictEqual(host.checks, 1);
        assert.strictEqual(host.compiles, 0);
        host.answer = { kind: 'build', build: build(1) };
        host.joinedNow = true;
        await builds.rejoined();
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(builds.build?.id, at(1));
        assert.strictEqual(host.compiles, 0);
    });

    it('pauses for an own compile through useOwn and resumes when the compile ends', async () => {
        builds.useOwn(build(1));
        builds.setWindowFocused(true);
        await settled();
        builds.compileStarted(false);
        assert.strictEqual(clock.jobs.size, 1, 'another project does not pause this one');
        builds.compileStarted(true);
        assert.strictEqual(clock.jobs.size, 0);
        const checked = host.checks;
        await clock.advance(BUILD_REFRESH_INTERVAL_MS * 3);
        builds.useOwn(build(3));
        assert.strictEqual(clock.jobs.size, 0, 'own output arrives before compileEnded');
        host.answer = { kind: 'build', build: build(2) };
        builds.compileEnded({ result: 'success' }, true);
        await settled();
        assert.strictEqual(host.checks, checked + 1);
        assert.strictEqual(builds.build?.id, at(3), 'asynchronous cache publication cannot roll back the own build');
        assert.strictEqual(clock.jobs.size, 1);
        assert.strictEqual(host.compiles, 0);
    });

    it('skips a metadata run queued before an own compile began and resumes after its end', async () => {
        const first = deferred<LatestAnswer>();
        host.held.push(first);
        builds.setWindowFocused(true);
        const queued = builds.checkForUpdates();
        builds.compileStarted(true);
        first.resolve(none);
        await queued;
        assert.strictEqual(host.checks, 1);
        assert.strictEqual(clock.jobs.size, 0);
        builds.compileEnded({ result: 'failure', detail: 'compile failed' }, true);
        await settled();
        assert.strictEqual(host.checks, 2);
        assert.strictEqual(host.compiles, 0);
        assert.strictEqual(clock.jobs.size, 1);
    });

    it('keeps the own compile running when an earlier metadata request answers during it', async () => {
        const held = deferred<LatestAnswer>();
        host.held.push(held);
        builds.setWindowFocused(true);
        builds.compileStarted(true);
        held.resolve({ kind: 'build', build: build(1) });
        await settled();
        await builds.recompile();
        assert.strictEqual(host.compiles, 0, 'the own compile is still running');
        assert.strictEqual(clock.jobs.size, 0);
        builds.useOwn(build(2));
        builds.compileEnded({ result: 'success' }, true);
        await settled();
        assert.strictEqual(builds.build?.id, at(2));
        assert.strictEqual(clock.jobs.size, 1);
    });

    it('does not replace a newer own build or accept another compile configuration during metadata refresh', async () => {
        builds.useOwn(build(1));
        const held = deferred<LatestAnswer>();
        host.held.push(held);
        const check = builds.checkForUpdates();
        builds.useOwn(build(3));
        held.resolve({ kind: 'build', build: build(2) });
        await check;
        host.answer = { kind: 'build', build: build(4, { ...MAIN, draft: true }) };
        await builds.checkForUpdates();
        assert.deepStrictEqual(changes, [at(1), at(3)]);
        assert.strictEqual(builds.build?.id, at(3));
        assert.strictEqual(host.compiles, 0);
    });

    it('ignores a cancelled timer callback that had already been queued', async () => {
        builds.setWindowFocused(true);
        await settled();
        const timer = [...clock.jobs][0];
        const checked = host.checks;
        builds.setWindowFocused(false);
        timer.callback();
        await settled();
        assert.strictEqual(host.checks, checked);
        assert.strictEqual(clock.jobs.size, 0);
    });

    it('does not adopt, notify, compile or start a queued check after disposal during a request', async () => {
        builds.useOwn(build(1));
        const held = deferred<LatestAnswer>();
        host.held.push(held);
        const metadata = builds.checkForUpdates();
        const ordinary = builds.check();
        const statuses: string[] = [];
        builds.onDidChangeStatus(status => { statuses.push(status.state); });
        builds.dispose();
        held.resolve({ kind: 'build', build: build(2) });
        await Promise.all([metadata, ordinary]);
        builds.useOwn(build(3));
        builds.setWindowFocused(true);
        builds.viewerStateChanged();
        await Promise.all([builds.opened(), builds.recompile(), builds.check(), builds.checkForUpdates(), builds.rejoined()]);
        assert.strictEqual(host.checks, 1);
        assert.strictEqual(host.compiles, 0);
        assert.deepStrictEqual(changes, [at(1)]);
        assert.deepStrictEqual(statuses, []);
        assert.strictEqual(clock.jobs.size, 0);
    });

    it('settles an opening waiting for join on disposal without compiling', async () => {
        host.joinedNow = false;
        const opening = builds.opened();
        builds.dispose();
        await opening;
        assert.strictEqual(host.checks, 0);
        assert.strictEqual(host.compiles, 0);
    });

    it('settles a join waiter on disposal even while the joined check is still in flight', async () => {
        host.joinedNow = false;
        const waiting = builds.check();
        const held = deferred<LatestAnswer>();
        host.held.push(held);
        host.joinedNow = true;
        const rejoined = builds.rejoined();
        builds.dispose();
        await waiting;
        held.resolve(none);
        await rejoined;
        assert.strictEqual(host.compiles, 0);
    });

    it('does not retry a busy compile after its owner was disposed', async () => {
        const busy = deferred<void>();
        host.starts.push({ kind: 'busy', ended: busy.promise });
        await builds.recompile();
        builds.dispose();
        busy.resolve();
        await settled();
        assert.strictEqual(host.compiles, 1);
    });
});
