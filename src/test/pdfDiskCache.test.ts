import * as assert from 'assert';
import { createHash } from 'crypto';
import { fork, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { PdfDiskCache, PDF_DISK_POLICY, PdfFillRequest } from '../core/pdfDiskCache';
import { PdfFetchBridge, outputsOf } from '../core/pdfFetchBridge';
import type { BridgeResponse, PdfOutput } from '../core/viewerProtocol';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const content = (size: number, salt = 0) => Uint8Array.from({ length: size }, (_, i) => (i * 131 + (i >>> 8) + (i >>> 16) + salt) & 255);
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function output(size: number, build = 'build-a', ranges: PdfOutput['file']['ranges'] = []): PdfOutput {
    const domain = 'http://127.0.0.1:1/zone/d';
    const file = { path: 'output.pdf', type: 'pdf', size, build,
        url: '/project/project-a/user/user-a/build/' + build + '/output/output.pdf',
        editorId: 'editor-a', contentId: 'content-a', ranges };
    return { url: domain + file.url, downloadDomain: domain, projectId: 'project-a', file };
}

function response(bytes: Uint8Array, start: number, end: number, etag = '"edition-a"'): BridgeResponse {
    return { id: 0, status: 206, statusText: 'Partial Content',
        headers: [['content-range', 'bytes ' + start + '-' + (end - 1) + '/' + bytes.length], ['etag', etag]],
        body: bytes.slice(start, end) };
}

class Timers {
    now = 0;
    next = 0;
    tasks = new Map<number, { callback: () => void, due: number }>();
    set = (callback: () => void, ms: number) => {
        const id = ++this.next; this.tasks.set(id, { callback, due: this.now + ms }); return id;
    };
    clear = (timer: unknown) => { this.tasks.delete(timer as number); };
    fire(): boolean {
        const next = [...this.tasks].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) { return false; }
        this.now = next[1].due; this.tasks.delete(next[0]); next[1].callback(); return true;
    }
}

function diskBytes(dir: string): number {
    return fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}$|^(build|object)-[a-f0-9]{64}\.json$|^[a-f0-9]{64}\..*\.tmp$/.test(name))
        .reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
}

describe('the shared persistent PDF disk budget', () => {
    let dir: string;
    const caches: PdfDiskCache[] = [];
    const cleanups: Array<() => void> = [];
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-disk-cache-')); });
    afterEach(async () => {
        cleanups.splice(0).forEach(cleanup => cleanup());
        for (const cache of caches.splice(0)) { await cache.dispose(); }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const make = (budget = 4 * 1024 * 1024, options: ConstructorParameters<typeof PdfDiskCache>[2] = {}) => {
        const cache = new PdfDiskCache(dir, budget, options); caches.push(cache); return cache;
    };

    it('allocates only arrived bytes for the 1.6 GB book, then resumes those bytes after restart', async () => {
        const book = output(1_608_644_855);
        const timers = new Timers();
        const requests: PdfFillRequest[] = [];
        const cache = make(PDF_DISK_POLICY.defaultMaxBytes, {
            now: () => timers.now, setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: async request => {
                requests.push(request);
                const body = content(request.end - request.start);
                return { id: 0, status: 206, statusText: 'Partial Content',
                    headers: [['content-range', 'bytes ' + request.start + '-' + (request.end - 1) + '/' + book.file.size], ['etag', '"book"']], body };
            },
        });
        const viewer = cache.createViewer();
        viewer.setOutput(book); viewer.setActivity(true, true);
        assert.strictEqual((await cache.snapshot(book)).bytes, 0, 'opening metadata does not reserve a PDF file');
        assert.strictEqual(timers.fire(), true);
        await cache.settled();
        assert.deepStrictEqual(requests.map(r => [r.start, r.end]), [[0, PDF_DISK_POLICY.chunkBytes]]);
        const stored = await cache.snapshot(book);
        assert.strictEqual(stored.covered, PDF_DISK_POLICY.chunkBytes);
        assert.ok(stored.bytes < PDF_DISK_POLICY.chunkBytes + 2048);
        assert.strictEqual(diskBytes(dir), stored.bytes);
        assert.ok(fs.readdirSync(dir).filter(n => n !== '.writer').every(n => fs.statSync(path.join(dir, n)).size <= PDF_DISK_POLICY.chunkBytes));
        viewer.dispose(); await cache.dispose();
        const reopened = make(PDF_DISK_POLICY.defaultMaxBytes);
        assert.deepStrictEqual((await reopened.readRange(book, 0, 37))?.body, content(37));
        assert.strictEqual((await reopened.snapshot(book)).covered, PDF_DISK_POLICY.chunkBytes);
    });

    it('fills one small range at a time only while visible and idle, and streams a complete cached export', async () => {
        const bytes = content(PDF_DISK_POLICY.chunkBytes * 2 + 71);
        const book = output(bytes.length);
        const timers = new Timers();
        const requests: PdfFillRequest[] = [];
        const cache = make(4 * 1024 * 1024, { setTimer: timers.set, clearTimer: timers.clear, now: () => timers.now,
            fetchRange: async request => { requests.push(request); return response(bytes, request.start, request.end); } });
        const viewer = cache.createViewer();
        viewer.setOutput(book);
        viewer.setActivity(false, true);
        assert.strictEqual(timers.fire(), false, 'hidden viewer starts no transfer');
        viewer.setActivity(true, false);
        assert.strictEqual(timers.fire(), false, 'active rendering starts no transfer');
        viewer.setActivity(true, true);
        for (let i = 0; i < 4; i++) { assert.strictEqual(timers.fire(), true); await cache.settled(); }
        assert.strictEqual(timers.fire(), false, 'complete files do not continue a fill loop');
        assert.strictEqual(requests.length, 3);
        assert.ok(requests.every(r => r.end - r.start <= PDF_DISK_POLICY.chunkBytes));
        assert.strictEqual((await cache.snapshot(book)).complete, true);
        viewer.dispose(); await cache.dispose();
        const reopened = make();
        const target = path.join(dir, 'saved.pdf');
        const progress: number[] = [];
        assert.strictEqual(await reopened.copyComplete(book, target, undefined, n => progress.push(n)), true);
        assert.deepStrictEqual(new Uint8Array(fs.readFileSync(target)), bytes);
        assert.strictEqual(progress.at(-1), bytes.length);
        assert.ok(progress.every((value, i) => value - (progress[i - 1] ?? 0) <= PDF_DISK_POLICY.chunkBytes));
    });

    it('does not admit ignored, shifted, compressed, truncated, or unvalidated range responses', async () => {
        const bytes = content(2000);
        const book = output(bytes.length);
        const cache = make();
        const good = response(bytes, 0, 100);
        const bad = [
            { ...good, status: 200 },
            { ...good, headers: [['content-range', 'bytes 1-100/2000'], ['etag', '"edition-a"']] as Array<[string, string]> },
            { ...good, headers: [...good.headers, ['content-encoding', 'gzip']] as Array<[string, string]> },
            { ...good, body: good.body.subarray(0, 99) },
            { ...good, headers: good.headers.filter(([name]) => name !== 'etag') },
            { ...good, headers: [['content-range', 'bytes 0-99/2000'], ['etag', 'W/"weak"']] as Array<[string, string]> },
        ];
        for (const reply of bad) { assert.strictEqual(await cache.storeRange(book, 0, 100, reply), false); }
        assert.strictEqual((await cache.snapshot(book)).bytes, 0);
        assert.strictEqual(await cache.storeRange(book, 0, 100, good), true);
        assert.deepStrictEqual((await cache.readRange(book, 0, 100))?.body, good.body);
        const newer = response(content(bytes.length, 7), 100, 200, '"edition-b"');
        assert.strictEqual(await cache.storeRange(book, 100, 200, newer), true);
        assert.strictEqual(await cache.readRange(book, 0, 200), undefined, 'a changed validator cannot combine two representations');
        assert.deepStrictEqual((await cache.readRange(book, 100, 200))?.body, newer.body);
    });

    it('reserves admission before concurrent writes and includes old piece files in the same total', async () => {
        const budget = 4096;
        const legacy = content(1200, 19);
        fs.writeFileSync(path.join(dir, hash(legacy)), legacy);
        const cache = make(budget);
        let peak = 0;
        const stop = cache.onChange(() => { peak = Math.max(peak, diskBytes(dir)); });
        await Promise.all(Array.from({ length: 30 }, (_, i) => {
            const bytes = content(400, i); return cache.put(hash(bytes), bytes);
        }));
        stop();
        const snapshot = await cache.snapshot();
        assert.ok(peak <= budget, 'no temporary or admitted-write peak exceeds the total budget');
        assert.ok(snapshot.bytes <= budget);
        assert.strictEqual(snapshot.reserved, 0);
        assert.strictEqual(snapshot.bytes, diskBytes(dir));
        assert.strictEqual(snapshot.maxBytes, budget);
        assert.ok(snapshot.files < 30, 'older unpinned data was evicted');
    });

    it('allows only one writer across cache instances and removes interrupted temporary files on restart', async () => {
        const bytes = content(400);
        const first = make();
        assert.strictEqual(await first.put(hash(bytes), bytes), true);
        const second = make();
        assert.strictEqual((await second.snapshot()).writer, false);
        assert.deepStrictEqual(await second.get(hash(bytes)), bytes);
        const different = content(400, 5);
        assert.strictEqual(await second.put(hash(different), different), false);
        await second.dispose();
        assert.strictEqual((await first.snapshot()).writer, true);
        await first.dispose();
        fs.writeFileSync(path.join(dir, hash(different) + '.crashed.tmp'), different);
        fs.writeFileSync(path.join(dir, 'build-' + 'a'.repeat(64) + '.json'), '{"version":');
        const restarted = make();
        assert.strictEqual((await restarted.snapshot()).writer, true);
        assert.strictEqual(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
        assert.deepStrictEqual(await restarted.get(hash(bytes)), bytes);
        assert.ok((await restarted.snapshot()).bytes <= 4 * 1024 * 1024);
    });

    it('reuses fully verified object shards in a new build without storing its object ID in the content hash', async () => {
        const piece = content(1024);
        const prefix = Buffer.from('12 0 obj\n');
        const bytes = new Uint8Array(Buffer.concat([Buffer.from('header\n'), prefix, piece, Buffer.from('\nendobj\n')]));
        const start = 7 + prefix.length;
        const book = output(bytes.length, 'old', [{ start, end: start + piece.length, hash: hash(piece), objectId: prefix.toString() }]);
        const cache = make();
        assert.strictEqual(await cache.storeRange(book, 0, bytes.length, response(bytes, 0, bytes.length)), true);
        assert.deepStrictEqual(await cache.get(hash(piece)), piece);
        const newPrefix = Buffer.from('34567 0 obj\n');
        const movedStart = 200 + newPrefix.length;
        const newer = output(4000, 'new', [{ start: movedStart, end: movedStart + piece.length, hash: hash(piece), objectId: newPrefix.toString() }]);
        const hit = await cache.readRange(newer, 200, movedStart + piece.length);
        assert.deepStrictEqual(hit?.body, new Uint8Array(Buffer.concat([newPrefix, piece])));
        assert.strictEqual(await cache.readRange(newer, 0, 200), undefined, 'unseen text of a new build remains a miss');
        await cache.dispose();
        const restarted = make();
        assert.deepStrictEqual(await restarted.get(hash(piece)), piece, 'the verified object map survives the process');
        assert.deepStrictEqual((await restarted.readRange(newer, 200, movedStart + piece.length))?.body, hit?.body);
    });

    it('keeps one background slot through rapid replacement and rejects an old generation that ignores abort', async () => {
        const timers = new Timers();
        const started = deferred<PdfFillRequest>();
        const firstReply = deferred<BridgeResponse>();
        cleanups.push(() => firstReply.resolve({ id: 0, status: 499, statusText: 'Cancelled', headers: [], body: new Uint8Array() }));
        const requests: PdfFillRequest[] = [];
        const cache = make(PDF_DISK_POLICY.defaultMaxBytes, { setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: request => {
                requests.push(request);
                if (requests.length === 1) { started.resolve(request); return firstReply.promise; }
                return Promise.resolve({ id: 0, status: 206, statusText: 'Partial Content', body: content(request.end - request.start, 9),
                    headers: [['content-range', 'bytes ' + request.start + '-' + (request.end - 1) + '/' + request.output.file.size], ['etag', '"new"']] });
            } });
        const viewer = cache.createViewer();
        const old = output(1_608_644_855, 'old');
        viewer.setOutput(old); viewer.setActivity(true, true);
        assert.strictEqual(timers.fire(), true);
        const inFlight = await started.promise;
        let latest = old;
        for (let i = 0; i < 25; i++) {
            latest = output(1_608_644_855, 'replacement-' + i);
            viewer.setOutput(latest); viewer.setActivity(true, true);
        }
        assert.strictEqual(inFlight.signal.aborted, true);
        assert.strictEqual(timers.fire(), false, 'no second job while old transport has not settled');
        assert.strictEqual((await cache.snapshot()).bytes, 0, 'build churn reserves no book-sized files');
        firstReply.resolve({ id: 0, status: 206, statusText: 'Partial Content', body: content(inFlight.end - inFlight.start),
            headers: [['content-range', 'bytes 0-' + (inFlight.end - 1) + '/' + old.file.size], ['etag', '"old"']] });
        await cache.settled();
        assert.strictEqual((await cache.snapshot(old)).covered, 0);
        assert.strictEqual(timers.fire(), true);
        await cache.settled();
        assert.strictEqual(requests.length, 2);
        assert.strictEqual(requests[1].output.file.build, latest.file.build);
        assert.strictEqual((await cache.snapshot(latest)).covered, PDF_DISK_POLICY.chunkBytes);
        assert.ok((await cache.snapshot()).bytes < PDF_DISK_POLICY.chunkBytes + 2048);
        viewer.dispose();
    });

    it('shares the fill lease across viewers and aborts it synchronously before foreground demand', async () => {
        const timers = new Timers();
        const started = deferred<PdfFillRequest>();
        const reply = deferred<BridgeResponse>();
        cleanups.push(() => reply.resolve({ id: 0, status: 499, statusText: 'Cancelled', headers: [], body: new Uint8Array() }));
        const bytes = content(1000);
        const book = output(bytes.length);
        let count = 0;
        const cache = make(1024 * 1024, { setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: request => { count++; started.resolve(request); return reply.promise; } });
        const a = cache.createViewer();
        const b = cache.createViewer();
        a.setOutput(book); b.setOutput(book);
        a.setActivity(true, true); b.setActivity(true, false);
        assert.strictEqual(timers.fire(), false, 'one busy visible viewer pauses all accumulation');
        b.setActivity(true, true);
        assert.strictEqual(timers.fire(), true);
        const request = await started.promise;
        assert.strictEqual(count, 1);
        const endForeground = cache.beginForeground();
        assert.strictEqual(request.signal.aborted, true);
        b.dispose();
        assert.strictEqual(timers.fire(), false, 'disposal cannot allocate a replacement slot before drain');
        reply.resolve(response(bytes, request.start, request.end));
        await cache.settled();
        assert.strictEqual((await cache.snapshot(book)).covered, 0);
        assert.strictEqual(timers.fire(), false, 'foreground work retains priority after background drains');
        endForeground();
        assert.strictEqual(timers.tasks.size, 1);
        a.setActivity(false, false);
        assert.strictEqual(timers.fire(), false);
        a.dispose();
        assert.strictEqual((await cache.snapshot()).viewers, 0);
    });

    it('serves both loaders single ranges, multipart dynamic gaps, and content URLs from the same stored bytes', async () => {
        const bytes = content(1000);
        const pieceStart = 50;
        const piece = bytes.subarray(pieceStart, 500);
        const book = output(bytes.length, 'shared', [{ start: pieceStart, end: 500, hash: hash(piece) }]);
        const cache = make();
        assert.strictEqual(await cache.storeRange(book, 0, bytes.length, response(bytes, 0, bytes.length)), true);
        const bridge = new PdfFetchBridge(outputsOf(book.downloadDomain, book.projectId), cache, { output: book });
        try {
            const single = await bridge.handle({ id: 1, url: book.url, headers: [['Range', 'bytes=10-20']] });
            assert.strictEqual(single.status, 206);
            assert.deepStrictEqual(single.body, bytes.slice(10, 21));
            const multi = await bridge.handle({ id: 2, url: book.url, headers: [['Range', 'bytes=0-8,990-999']] });
            assert.strictEqual(multi.status, 206);
            const type = multi.headers.find(([name]) => name === 'content-type')?.[1];
            assert.match(type ?? '', /^multipart\/byteranges; boundary=/);
            assert.ok(Buffer.from(multi.body).includes(Buffer.from('Content-Range: bytes 990-999/1000')));
            assert.ok(Buffer.from(multi.body).includes(Buffer.from(bytes.slice(990))));
            const pieceUrl = book.downloadDomain + '/project/project-a/user/user-a/content/another-build/' + hash(piece);
            const object = await bridge.handle({ id: 3, url: pieceUrl });
            assert.strictEqual(object.status, 200);
            assert.deepStrictEqual(object.body, piece);
            bridge.setOutput(output(bytes.length, 'new'));
            await assert.rejects(bridge.handle({ id: 4, url: output(bytes.length, 'new').url, headers: [['Range', 'bytes=0-8']] }), /fetch|connect/i);
        } finally { bridge.dispose(); }
    });

it('refreshes a readonly window and takes over filling after the writer closes', async () => {
        const bytes = content(2000);
        const book = output(bytes.length);
        const first = make();
        const original = content(400);
        assert.strictEqual(await first.put(hash(original), original), true);
        const timers = new Timers();
        let requests = 0;
        const second = make(4 * 1024 * 1024, { setTimer: timers.set, clearTimer: timers.clear,
            fetchRange: async request => { requests++; return response(bytes, request.start, request.end); } });
        assert.strictEqual((await second.snapshot()).writer, false);
        const observedChange = deferred<void>();
        const stop = second.onChange(() => observedChange.resolve());
        const later = content(400, 9);
        assert.strictEqual(await first.put(hash(later), later), true);
        await observedChange.promise;
        stop();
        assert.deepStrictEqual(await second.get(hash(later)), later, 'readonly window observes a newly published hash');
        const viewer = second.createViewer();
        viewer.setOutput(book); viewer.setActivity(true, true);
        assert.strictEqual(timers.fire(), true);
        await second.settled();
        assert.strictEqual(requests, 0);
        await first.dispose();
        assert.strictEqual((await second.snapshot()).writer, true, 'owner exit permits a later window to acquire the writer');
        viewer.setActivity(true, false); viewer.setActivity(true, true);
        assert.strictEqual(timers.fire(), true);
        await second.settled();
        assert.strictEqual(requests, 1);
        assert.strictEqual((await second.snapshot(book)).complete, true);
        viewer.dispose();
    });

    it('bounds transient build metadata and repairs a corrupt same-sized piece on verified admission', async () => {
        const bytes = content(500);
        fs.writeFileSync(path.join(dir, hash(bytes)), content(bytes.length, 7));
        const cache = make();
        assert.strictEqual(await cache.put(hash(bytes), bytes), true);
        assert.deepStrictEqual(await cache.get(hash(bytes)), bytes);
        for (let i = 0; i < PDF_DISK_POLICY.memoryManifests * 3; i++) {
            await cache.readRange(output(1_608_644_855, 'interrupted-' + i), 0, 10);
        }
        const state = await cache.snapshot();
        assert.ok(state.memoryManifests <= PDF_DISK_POLICY.memoryManifests * 2);
        assert.strictEqual(state.files, 1, 'unreceived generations create no persisted manifests');
        assert.strictEqual(state.bytes, bytes.length);
    });

    it('retains an old foreground response during replacement but does not reuse bytes for a changed output query', async () => {
        const bytes = content(1000);
        const arrived = deferred<void>();
        const release = deferred<void>();
        const requests: string[] = [];
        const server = http.createServer((request, reply) => {
            requests.push(request.url!);
            const send = () => {
                const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')!;
                const start = Number(range[1]), end = Number(range[2]) + 1;
                reply.setHeader('Content-Range', 'bytes ' + start + '-' + (end - 1) + '/' + bytes.length);
                reply.setHeader('ETag', '"http-edition"');
                reply.writeHead(206);
                reply.end(bytes.subarray(start, end));
            };
            if (requests.length === 1) { arrived.resolve(); void release.promise.then(send); } else { send(); }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const domain = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        const old = output(bytes.length, 'old');
        old.downloadDomain = domain;
        old.url = domain + old.file.url + '?compileGroup=group-a';
        const newer = { ...output(bytes.length, 'new'), downloadDomain: domain };
        newer.url = domain + newer.file.url;
        const cache = make();
        const bridge = new PdfFetchBridge(outputsOf(domain, 'project-a'), cache, { output: old });
        try {
            const pending = bridge.handle({ id: 1, url: old.url, headers: [['Range', 'bytes=0-99']] });
            await arrived.promise;
            bridge.setOutput(newer);
            release.resolve();
            assert.deepStrictEqual((await pending).body, bytes.slice(0, 100), 'old displayed PDF can finish its in-flight render');
            assert.deepStrictEqual((await cache.readRange(old, 0, 100))?.body, bytes.slice(0, 100));
            bridge.setOutput(old);
            const changed = old.url.replace('group-a', 'group-b');
            await bridge.handle({ id: 2, url: changed, headers: [['Range', 'bytes=0-99']] });
            assert.strictEqual(requests.length, 2, 'same pathname with different query is a network request');
            const different = { ...old, url: changed };
            assert.strictEqual(await cache.readRange(different, 0, 100), undefined, 'query identity is part of the persistent build key');
        } finally {
            release.resolve(); bridge.dispose();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('allows only one process to reap a dead writer even when the second unlink arrives after new ownership', async () => {
        // A live PID with a different kernel start tick also represents a stale, reused PID.
        fs.writeFileSync(path.join(dir, '.writer'), process.pid + ':0:previous-process');
        const helper = path.join(dir, 'writer-race.cjs');
        fs.writeFileSync(helper, [
            "const fs = require('fs');",
            "const { PdfDiskCache } = require(process.argv[2]);",
            "const directory = process.argv[3];",
            "let go, remove, close;",
            "const started = new Promise(r => go = r), permission = new Promise(r => remove = r), shutdown = new Promise(r => close = r);",
            "process.on('message', m => { if(m === 'go') go(); if(m === 'unlink') remove(); if(m === 'close') { remove(); close(); } });",
            "const unlink = fs.promises.unlink.bind(fs.promises); let gate = true;",
            "fs.promises.unlink = async file => { if(gate && file === directory + '/.writer') { process.send({phase:'unlink'}); await permission; } return unlink(file); };",
            "(async () => { process.send({phase:'ready'}); await started;",
            "const cache = new PdfDiskCache(directory, 4096);",
            "const state = await cache.snapshot(); gate = false;",
            "process.send({phase:'result',writer:state.writer}); await shutdown; await cache.dispose(); process.disconnect();",
            "})().catch(e => { process.send({phase:'failure',message:e.message}); process.exitCode=1; process.disconnect(); });",
        ].join('\n'));
        const children: ChildProcess[] = [];
        const events: Array<{ child: ChildProcess, message: any }> = [];
        let wake = deferred<void>();
        const next = async () => {
            while (!events.length) { const waiting = wake; await waiting.promise; }
            return events.shift()!;
        };
        const exits: Promise<void>[] = [];
        for (let i = 0; i < 2; i++) {
            const child = fork(helper, [require.resolve('../core/pdfDiskCache'), dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            children.push(child);
            exits.push(new Promise<void>((resolve, reject) => {
                child.on('exit', code => code === 0 ? resolve() : reject(new Error('writer race helper exited ' + code)));
                child.on('error', reject);
            }));
            child.on('message', message => { events.push({ child, message }); const previous = wake; wake = deferred<void>(); previous.resolve(); });
        }
        try {
            for (let i = 0; i < 2; i++) { assert.strictEqual((await next()).message.phase, 'ready'); }
            children.forEach(child => child.send('go'));
            const first = await next();
            const second = await next();
            assert.ok([first.message.phase, second.message.phase].every(p => p === 'unlink' || p === 'result'));
            const waiting = [first, second].filter(e => e.message.phase === 'unlink');
            const results = [first, second].filter(e => e.message.phase === 'result');
            assert.ok(waiting.length > 0, 'the stale writer was recognized');
            // Hold the second stale unlink until the first process has published its new lock.
            for (const event of waiting) {
                event.child.send('unlink');
                const result = await next();
                assert.strictEqual(result.message.phase, 'result');
                results.push(result);
            }
            assert.strictEqual(results.filter(e => e.message.writer).length, 1, 'exactly one process owns admission after stale recovery');
        } finally {
            children.forEach(child => { if (child.connected) { child.send('close'); } });
            await Promise.all(exits);
        }
    });

    it('does not serve a corrupted persisted blob or create storage when caching is disabled', async () => {
        const bytes = content(200);
        const cache = make();
        assert.strictEqual(await cache.put(hash(bytes), bytes), true);
        await cache.dispose();
        fs.writeFileSync(path.join(dir, hash(bytes)), content(bytes.length, 1));
        const restarted = make();
        assert.strictEqual(await restarted.get(hash(bytes)), undefined);
        assert.strictEqual((await restarted.snapshot()).bytes, 0);
        const offDir = path.join(dir, 'disabled');
        const off = new PdfDiskCache(offDir, 0); caches.push(off);
        assert.strictEqual(await off.put(hash(bytes), bytes), false);
        assert.strictEqual(await off.get(hash(bytes)), undefined);
        assert.strictEqual(fs.existsSync(offDir), false);
        await restarted.dispose();
        fs.writeFileSync(path.join(dir, hash(bytes)), bytes);
        const disabledExisting = make(0);
        assert.strictEqual((await disabledExisting.snapshot()).bytes, 0, 'zero budget removes old cached files once this host owns admission');
        assert.strictEqual(fs.existsSync(path.join(dir, hash(bytes))), false);
    });
});
