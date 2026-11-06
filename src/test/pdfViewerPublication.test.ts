import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('visible Spomenar publication updates', function () {
    this.timeout(30_000);
    let directory: string, publication: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-publication-test-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/standalone/publication.ts')],
                outfile: path.join(directory, 'publication.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
            publication = await importModule(path.join(directory, 'publication.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    const config = (id = 'a', revision = '1') => ({
        pdfUrl: 'https://book.test/versions/' + id + '/book.pdf', title: 'Spomenar', filename: 'Spomenar.pdf',
        previews: { manifestUrl: 'https://book.test/previews/' + id + '/manifest.json', manifestRevision: revision.repeat(64),
            sha256: id.repeat(64), size: 1234, validator: { header: 'ETag', value: '"' + id + '"' } },
    });
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    class Clock {
        time = 0;
        id = 0;
        jobs = new Map<number, { at: number; callback: () => void }>();
        setTimeout = (callback: () => void, delay: number) => {
            const id = ++this.id; this.jobs.set(id, { at: this.time + delay, callback }); return id;
        };
        clearTimeout = (id: number) => { this.jobs.delete(id); };
        advance(ms: number) {
            const end = this.time + ms;
            for (;;) {
                const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) { break; }
                this.time = next[1].at; this.jobs.delete(next[0]); next[1].callback();
            }
            this.time = end;
        }
    }
    class Visibility extends EventTarget {
        visibilityState = 'visible';
        set(value: string) { this.visibilityState = value; this.dispatchEvent(new Event('visibilitychange')); }
    }

    it('distinguishes a new edition, same-edition transport move, fuller atlas and title-only change', () => {
        const old = config();
        assert.strictEqual(publication.sitePublicationChange(old, config()), undefined);
        assert.deepStrictEqual(publication.sitePublicationChange(old, config('b')), { kind: 'document', newEdition: true });
        assert.deepStrictEqual(publication.sitePublicationChange(old, { ...old, pdfUrl: 'https://book.test/immutable.pdf' }),
            { kind: 'document', newEdition: false });
        assert.deepStrictEqual(publication.sitePublicationChange(old, config('a', '2')), { kind: 'previews', newEdition: false });
        assert.deepStrictEqual(publication.sitePublicationChange(old, { ...old, title: 'Novi naslov' }), { kind: 'metadata', newEdition: false });
    });

    it('reopens a new reading representation of the same original without announcing an edition', () => {
        const original = config(), reading = { ...original.previews, manifestUrl: 'https://book.test/previews/a/reading.json' };
        const ready = { ...original, reading };
        assert.deepStrictEqual(publication.sitePublicationChange(original, ready), { kind: 'reading', newEdition: false });
        assert.deepStrictEqual(publication.sitePublicationChange(ready, { ...ready, reading: { ...reading, manifestRevision: '2'.repeat(64) } }),
            { kind: 'reading', newEdition: false });
        assert.deepStrictEqual(publication.sitePublicationChange(ready, original), { kind: 'reading', newEdition: false });
        assert.strictEqual(publication.sitePublicationChange(ready, { ...ready }), undefined);
    });

    it('pauses while hidden and discards a late hidden-generation response before resuming', async () => {
        const clock = new Clock(), document = new Visibility();
        let finish!: (value: unknown) => void, signal!: AbortSignal, calls = 0, applied = 0;
        const watcher = publication.watchSitePublication({ clock, document, current: () => config(),
            read: (value: AbortSignal) => { signal = value; calls++; return new Promise(resolve => { finish = resolve; }); },
            apply: () => { applied++; } });
        clock.advance(15_000); await flush();
        document.set('hidden');
        assert.ok(signal.aborted);
        finish(config('b')); await flush();
        clock.advance(120_000); await flush();
        assert.strictEqual(calls, 1); assert.strictEqual(applied, 0); assert.strictEqual(clock.jobs.size, 0);
        document.set('visible'); clock.advance(0); await flush();
        assert.strictEqual(calls, 2);
        watcher.dispose(); finish(config('b')); await flush();
        assert.strictEqual(applied, 0); assert.strictEqual(clock.jobs.size, 0);
    });

    it('waits for interaction to settle and rereads the newest publication after input during a request', async () => {
        const clock = new Clock(), document = new Visibility();
        let quiet = false, calls = 0, finish!: (value: unknown) => void;
        const applied: string[] = [];
        const watcher = publication.watchSitePublication({ clock, document, current: () => config(), canApply: () => quiet,
            read: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
            apply: (value: any) => { applied.push(value.previews.sha256); } });
        clock.advance(15_000); await flush(); assert.strictEqual(calls, 0);
        quiet = true; clock.advance(1000); await flush(); assert.strictEqual(calls, 1);
        quiet = false; finish(config('b')); await flush(); assert.deepStrictEqual(applied, []);
        quiet = true; clock.advance(1000); await flush(); assert.strictEqual(calls, 2);
        finish(config('c')); await flush(); assert.deepStrictEqual(applied, ['c'.repeat(64)]);
        watcher.dispose(); assert.strictEqual(clock.jobs.size, 0);
    });

    it('keeps one read or application in flight and refreshes previews without a document change', async () => {
        const clock = new Clock(), document = new Visibility();
        let release!: () => void, reads = 0, current = config();
        const changes: string[] = [];
        const watcher = publication.watchSitePublication({ clock, document, current: () => current,
            read: async () => { reads++; return config('a', '2'); },
            apply: async (value: any, change: any) => { changes.push(change.kind); await new Promise<void>(resolve => { release = resolve; }); current = value; } });
        clock.advance(15_000); await flush();
        for (let i = 0; i < 10; i++) { watcher.refresh(); clock.advance(0); }
        assert.strictEqual(reads, 1); assert.deepStrictEqual(changes, ['previews']);
        release(); await flush(); clock.advance(1000); await flush();
        assert.strictEqual(reads, 2); assert.deepStrictEqual(changes, ['previews']);
        watcher.dispose(); assert.strictEqual(clock.jobs.size, 0);
    });

    it('retains the current reader on failed checks, backs off, and cancels an in-flight check on disposal', async () => {
        const clock = new Clock(), document = new Visibility();
        let calls = 0, applied = 0, signal!: AbortSignal, finish!: (value: unknown) => void;
        const watcher = publication.watchSitePublication({ clock, document, current: () => config(),
            read: (value: AbortSignal) => { calls++; signal = value; return calls === 1 ? Promise.reject(new Error('offline'))
                : new Promise(resolve => { finish = resolve; }); }, apply: () => { applied++; } });
        clock.advance(15_000); await flush();
        clock.advance(29_999); await flush(); assert.strictEqual(calls, 1);
        clock.advance(1); await flush(); assert.strictEqual(calls, 2);
        watcher.dispose(); assert.ok(signal.aborted); finish(config('b')); await flush();
        assert.strictEqual(applied, 0); assert.strictEqual(clock.jobs.size, 0);
    });
});
