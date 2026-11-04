import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// tsc turns import() into require(), which cannot load ES modules.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('PDF prefetch performance measurements', function () {
    this.timeout(30 * 1000);
    let dir: string;
    let performanceModule: any;

    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts', 'build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-viewer-performance-'));
        try {
            await esbuild.build({
                ...bundleOptions,
                entryPoints: [path.join(viewerRoot, 'src', 'common', 'prefetch-performance.ts')],
                outfile: path.join(dir, 'performance.mjs'),
            });
            performanceModule = await importModule(path.join(dir, 'performance.mjs'));
        } finally {
            await esbuild.stop();
        }
    });

    after(() => {
        if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('keeps the newest bounded event history in chronological order', () => {
        let now = 0;
        const recorder = new performanceModule.PdfPerformance(() => now);
        const capacity = performanceModule.PERFORMANCE_LIMITS.eventCapacity;
        for (let index = 0; index < capacity + 7; index++) {
            now = index;
            recorder.event('prepare', { page: index + 1 });
        }
        const snapshot = recorder.snapshot();
        assert.strictEqual(snapshot.events.length, capacity);
        assert.strictEqual(snapshot.eventCount, capacity + 7);
        assert.strictEqual(snapshot.droppedEvents, 7);
        assert.strictEqual(snapshot.events[0].data.page, 8);
        assert.strictEqual(snapshot.events.at(-1).data.page, capacity + 7);
        assert.ok(snapshot.events.every((event: any, index: number, events: any[]) =>
            index === 0 || event.sequence > events[index - 1].sequence));
    });

    it('copies event data so callers cannot rewrite recorded measurements', () => {
        const recorder = new performanceModule.PdfPerformance(() => 10);
        const data = { page: 2, elapsedMs: 7 };
        recorder.event('preview-ready', data);
        data.page = 9;
        const snapshot = recorder.snapshot();
        assert.strictEqual(snapshot.events[0].data.page, 2);
        snapshot.events[0].data.page = 20;
        snapshot.events[0].type = 'changed';
        assert.strictEqual(recorder.snapshot().events[0].data.page, 2);
        assert.strictEqual(recorder.snapshot().events[0].type, 'preview-ready');
    });

    it('measures overlapping transfers over their shared elapsed time and ages them out', () => {
        let now = 2000;
        const recorder = new performanceModule.PdfPerformance(() => now);
        const mib = 1024 * 1024;
        recorder.fetch(mib, 1000);
        recorder.fetch(mib, 1000);
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 2);

        now = 3000;
        recorder.fetch(2 * mib, 2000);
        const snapshot = recorder.snapshot();
        assert.strictEqual(snapshot.fetchMiBPerSecond, 2);
        assert.strictEqual(snapshot.fetchBytes, 4 * mib);
        assert.strictEqual(snapshot.fetchCount, 3);

        now = 7000;
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 0.2);
        now = 8000;
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 0);
        assert.strictEqual(recorder.snapshot().fetchBytes, 4 * mib);
    });

    it('uses a long transfer\'s measured duration instead of reporting all its bytes in the last window', () => {
        const recorder = new performanceModule.PdfPerformance(() => 20000);
        recorder.fetch(20 * 1024 * 1024, 20000);
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 1);
    });

    it('rejects invalid transfer samples and keeps instantaneous completions finite', () => {
        const recorder = new performanceModule.PdfPerformance(() => 0);
        for (const [bytes, elapsed] of [[NaN, 1], [Infinity, 1], [-1, 1], [0, 1], [1, -1], [1, NaN], [1, Infinity]]) {
            recorder.fetch(bytes, elapsed);
        }
        assert.strictEqual(recorder.snapshot().fetchCount, 0);
        recorder.fetch(1024, 0);
        const snapshot = recorder.snapshot();
        assert.strictEqual(snapshot.fetchBytes, 1024);
        assert.strictEqual(snapshot.fetchCount, 1);
        assert.ok(Number.isFinite(snapshot.fetchMiBPerSecond));
        assert.ok(snapshot.fetchMiBPerSecond > 0);
    });

    it('tracks concurrent fetch ages and cleans up each request exactly once', () => {
        let now = 100;
        const recorder = new performanceModule.PdfPerformance(() => now);
        const changes: number[][] = [];
        recorder.onFetchChange(() => {
            const snapshot = recorder.snapshot();
            assert.strictEqual(snapshot.pendingFetchCount, recorder.pendingFetchCount);
            assert.strictEqual(snapshot.oldestFetchMs, recorder.oldestFetchMs);
            changes.push([recorder.pendingFetchCount, recorder.oldestFetchMs]);
        });
        assert.deepStrictEqual(changes, []);
        assert.strictEqual(recorder.oldestFetchMs, 0);

        const first = recorder.beginFetch();
        now = 140;
        const second = recorder.beginFetch();
        assert.strictEqual(recorder.snapshot().fetchCount, 0);
        assert.strictEqual(recorder.snapshot().fetchBytes, 0);
        now = 180;
        first();
        first();
        second();
        second();
        assert.deepStrictEqual(changes, [[1, 0], [2, 40], [1, 40], [0, 0]]);
        assert.strictEqual(recorder.pendingFetchCount, 0);
        assert.strictEqual(recorder.oldestFetchMs, 0);
    });

    it('unsubscribes fetch observers independently and preserves subscriptions across reset', () => {
        const recorder = new performanceModule.PdfPerformance(() => 10);
        const firstChanges: number[] = [];
        const secondChanges: number[] = [];
        const stopFirst = recorder.onFetchChange(() => firstChanges.push(recorder.pendingFetchCount));
        const stopSecond = recorder.onFetchChange(() => secondChanges.push(recorder.pendingFetchCount));
        const staleEnd = recorder.beginFetch();
        stopFirst();
        stopFirst();
        recorder.reset();
        staleEnd();
        const end = recorder.beginFetch();
        end();
        stopSecond();
        recorder.beginFetch()();
        recorder.reset();
        assert.deepStrictEqual(firstChanges, [1]);
        assert.deepStrictEqual(secondChanges, [1, 0, 1, 0]);
    });

    it('notifies reset after clearing all metrics and fences stale completions from the next document', () => {
        let now = 10;
        const recorder = new performanceModule.PdfPerformance(() => now);
        const snapshots: any[] = [];
        recorder.onFetchChange(() => snapshots.push(recorder.snapshot()));
        const staleEnd = recorder.beginFetch();
        recorder.fetch(2048, 5);
        now = 50;
        recorder.reset();
        const reset = snapshots.at(-1);
        assert.strictEqual(reset.pendingFetchCount, 0);
        assert.strictEqual(reset.oldestFetchMs, 0);
        assert.strictEqual(reset.fetchBytes, 0);
        assert.strictEqual(reset.elapsedMs, 0);
        assert.deepStrictEqual(reset.events, []);

        now = 60;
        const currentEnd = recorder.beginFetch();
        now = 80;
        staleEnd();
        assert.strictEqual(recorder.pendingFetchCount, 1);
        assert.strictEqual(recorder.oldestFetchMs, 20);
        assert.strictEqual(snapshots.length, 3);
        currentEnd();
        staleEnd();
        assert.strictEqual(recorder.pendingFetchCount, 0);
        assert.strictEqual(snapshots.length, 4);
    });

    it('keeps cleanup and other observers working when a fetch observer throws', () => {
        const recorder = new performanceModule.PdfPerformance(() => 10);
        const changes: number[] = [];
        recorder.onFetchChange(() => { throw new Error('observer failure'); });
        recorder.onFetchChange(() => changes.push(recorder.pendingFetchCount));
        let end = () => {};
        assert.doesNotThrow(() => { end = recorder.beginFetch(); });
        assert.strictEqual(recorder.pendingFetchCount, 1);
        assert.doesNotThrow(() => end());
        assert.strictEqual(recorder.pendingFetchCount, 0);
        assert.deepStrictEqual(changes, [1, 0]);
        assert.deepStrictEqual(recorder.snapshot().events.map((event: any) => event.type),
            ['fetch-observer-error', 'fetch-observer-error']);
    });

    it('starts fresh for a new document, including the measurement window and ring cursors', () => {
        let now = 1000;
        const recorder = new performanceModule.PdfPerformance(() => now);
        recorder.event('page-ready', { page: 1 });
        recorder.fetch(1024 * 1024, 1000);
        now = 9000;
        recorder.reset();
        const reset = recorder.snapshot();
        assert.deepStrictEqual(reset.events, []);
        assert.strictEqual(reset.eventCount, 0);
        assert.strictEqual(reset.droppedEvents, 0);
        assert.strictEqual(reset.fetchBytes, 0);
        assert.strictEqual(reset.fetchCount, 0);
        assert.strictEqual(reset.fetchMiBPerSecond, 0);
        now = 10000;
        recorder.fetch(1024 * 1024, 500);
        assert.strictEqual(recorder.snapshot().fetchMiBPerSecond, 2);
    });

    it('leaves diagnostics dormant until opened and removes its handlers on disposal', () => {
        const listeners = new Map<string, (event: unknown) => void>();
        let timers = 0;
        let elements = 0;
        let samples = 0;
        const document = {
            defaultView: { setInterval() { timers++; }, clearInterval() {} },
            createElement() { elements++; throw new Error('The hidden dashboard must not create DOM'); },
            addEventListener(name: string, listener: (event: unknown) => void) { listeners.set(name, listener); },
            removeEventListener(name: string, listener: (event: unknown) => void) {
                assert.strictEqual(listeners.get(name), listener);
                listeners.delete(name);
            },
        };
        const diagnostics = performanceModule.installPrefetchDiagnostics({ ownerDocument: document }, () => { samples++; });
        assert.strictEqual(listeners.size, 2);
        listeners.get('keydown')!({ key: 'r', code: 'KeyR', ctrlKey: true, altKey: true, shiftKey: false });
        assert.strictEqual(timers, 0);
        assert.strictEqual(elements, 0);
        assert.strictEqual(samples, 0);
        diagnostics.dispose();
        assert.strictEqual(listeners.size, 0);
        diagnostics.dispose();
        diagnostics.toggle();
        assert.strictEqual(timers, 0);
        assert.strictEqual(elements, 0);
    });
});
