/* eslint-disable @typescript-eslint/naming-convention */
import * as assert from 'assert';
import { constants, createServer, ServerHttp2Session } from 'http2';
import { AddressInfo } from 'net';
import { ReadableStream, ReadableStreamDefaultController } from 'stream/web';
import * as undici from 'undici';
import { HttpBackoffError, HttpRequestRetry, HttpResponseError, http2ErrorCode } from '../api/requestRetry';
import { retryAfterMs } from '../utils/httpRetry';
import { loadWithVscode } from './standIn';

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

/** Let the promise continuations of the observed response run before checking admission. */
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function clock() {
    let now = 0;
    const waiting: {at: number, resolve: () => void}[] = [];
    return {
        now: () => now,
        wait: (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
            const entry = {at: now + milliseconds, resolve: () => {
                signal?.removeEventListener('abort', abort);
                resolve();
            }};
            const abort = () => {
                const index = waiting.indexOf(entry);
                if (index !== -1) { waiting.splice(index, 1); }
                reject(Object.assign(new Error('cancelled fixture wait'), {name: 'AbortError'}));
            };
            if (signal?.aborted) { abort(); return; }
            waiting.push(entry);
            signal?.addEventListener('abort', abort, {once: true});
        }),
        advance(milliseconds: number) {
            now += milliseconds;
            for (let i = waiting.length - 1; i >= 0; i--) {
                if (waiting[i].at <= now) { waiting.splice(i, 1)[0].resolve(); }
            }
        },
    };
}

function overload() {
    const reset = Object.assign(new Error('stream reset'), {
        code: 'ERR_HTTP2_STREAM_ERROR', http2ErrorCode: constants.NGHTTP2_ENHANCE_YOUR_CALM,
    });
    return Object.assign(new TypeError('fetch failed'), {cause: reset});
}

const identity = {csrfToken: 'fixture-csrf', cookies: 'session=fixture'};
const success = () => new undici.Response(JSON.stringify({success: true, entity_type: 'file', entity_id: 'uploaded'}));

describe('API server backpressure', () => {
    it('shares a pause between API clients and admits one recovery request through its body', async () => {
        const time = clock();
        const requests = new HttpRequestRetry(time);
        const failed = deferred();
        const recovering = deferred();
        const calls: string[] = [];
        let body: ReadableStreamDefaultController<Uint8Array> | undefined;
        let closing = false;
        const fakeFetch = async (url: string) => {
            calls.push(url);
            if (calls.length === 1) { failed.resolve(); throw overload(); }
            if (calls.length === 2 && !closing) {
                return new undici.Response(new ReadableStream<Uint8Array>({
                    start(controller) { body = controller; recovering.resolve(); },
                }) as any);
            }
            if (url.includes('/upload')) { return success(); }
            return new undici.Response('downloaded bytes');
        };
        const {BaseAPI} = loadWithVscode({}, () => require('../api/base'), {
            undici: {...undici, fetch: fakeFetch},
            './requestRetry': {...require('../api/requestRetry'), apiRequests: requests},
        });
        const first = new BaseAPI('https://fixture.invalid/');
        const second = new BaseAPI('https://fixture.invalid/');
        const running: Promise<any>[] = [];
        try {
            running.push(first.uploadFile(identity, 'p', 'folder', 'file.bin', new Uint8Array([1, 2, 3])));
            await failed.promise;
            await nextTurn();
            running.push(second.getFile(identity, 'p', 'other'));
            await nextTurn();
            assert.strictEqual(calls.length, 1, 'a second client must wait after the server reported overload');
            time.advance(1000);
            await recovering.promise;
            await nextTurn();
            assert.strictEqual(calls.length, 2, 'only one recovery request may run while its body is incomplete');
            body!.enqueue(new TextEncoder().encode(JSON.stringify({success: true, entity_type: 'file', entity_id: 'uploaded'})));
            body!.close();
            body = undefined;
            const answers = await Promise.all(running);
            assert.deepStrictEqual(answers.map(answer => answer.type), ['success', 'success']);
            assert.strictEqual(calls.length, 3);
        } finally {
            closing = true;
            body?.enqueue(new TextEncoder().encode(JSON.stringify({success: true, entity_type: 'file', entity_id: 'uploaded'})));
            body?.close();
            time.advance(60_000);
            await Promise.allSettled(running);
        }
    }).timeout(10_000);

    it('does not resend a generic mutation after an ambiguous stream reset', async () => {
        let calls = 0;
        const {BaseAPI} = loadWithVscode({}, () => require('../api/base'), {
            undici: {...undici, fetch: async () => { calls++; throw overload(); }},
        });
        const answer = await new BaseAPI('https://mutation.invalid/').newProject(identity, 'project', 'none');
        assert.strictEqual(answer.type, 'error');
        assert.strictEqual(calls, 1);
    }).timeout(10_000);

    it('keeps unrelated origins moving and ignores success from before the pause', async () => {
        const time = clock();
        const requests = new HttpRequestRetry(time);
        const earlier = deferred<string>();
        const earlierStarted = deferred();
        const options = {retries: 0, maximumWaitMs: 60_000};
        const old = requests.run('https://one.invalid/old', () => { earlierStarted.resolve(); return earlier.promise; }, options);
        await earlierStarted.promise;
        await assert.rejects(requests.run('https://one.invalid/failure', async () => { throw overload(); }, options));
        let admitted = false;
        const waiting = requests.run('https://one.invalid/new', async () => { admitted = true; return 'new'; }, options);
        assert.strictEqual(await requests.run('https://two.invalid/other', async () => 'other', options), 'other');
        earlier.resolve('old');
        await old;
        await nextTurn();
        assert.strictEqual(admitted, false, 'an earlier success must not clear newer overload feedback');
        time.advance(1000);
        assert.strictEqual(await waiting, 'new');
    });

    it('retains backpressure when a caller has no retry left and respects Retry-After', async () => {
        const time = clock();
        const requests = new HttpRequestRetry(time);
        const options = {retries: 0, maximumWaitMs: 60_000};
        await assert.rejects(requests.run('https://one.invalid/first', async () => {
            throw new HttpResponseError(503, 'busy', 2000);
        }, options));
        let calls = 0;
        const next = requests.run('https://one.invalid/next', async () => { calls++; return true; }, options);
        time.advance(1999);
        await nextTurn();
        assert.strictEqual(calls, 0);
        time.advance(1);
        assert.strictEqual(await next, true);
        assert.strictEqual(calls, 1);
    });

    it('observes Retry-After before reading a slow error body', async () => {
        const time = clock();
        const requests = new HttpRequestRetry(time);
        const headers = deferred(), body = deferred();
        const options = {retries: 0, maximumWaitMs: 60_000};
        const first = requests.run('https://one.invalid/slow', async observe => {
            const error = new HttpResponseError(429, 'busy', 2000);
            observe(error);
            headers.resolve();
            await body.promise;
            throw error;
        }, options);
        const failed = assert.rejects(first, HttpResponseError);
        await headers.promise;
        let admitted = false;
        const next = requests.run('https://one.invalid/next', async () => { admitted = true; }, options);
        await nextTurn();
        assert.strictEqual(admitted, false, 'a pending error body must not leave admission open');
        time.advance(2000);
        await next;
        body.resolve();
        await failed;
        await requests.run('https://one.invalid/after', async () => {}, options);
    });

    it('keeps the longest server deadline when concurrent replies ask for different pauses', async () => {
        const time = clock();
        const requests = new HttpRequestRetry(time);
        const long = deferred(), short = deferred(), started = deferred();
        const options = {retries: 0, maximumWaitMs: 60_000};
        let starting = 0;
        const response = (wait: Promise<void>, delay: number) => requests.run('https://one.invalid/file', async () => {
            if (++starting === 2) { started.resolve(); }
            await wait;
            throw new HttpResponseError(429, 'busy', delay);
        }, options);
        const first = assert.rejects(response(long.promise, 5000));
        const second = assert.rejects(response(short.promise, 1000));
        await started.promise;
        long.resolve();
        await first;
        short.resolve();
        await second;
        let admitted = false;
        const next = requests.run('https://one.invalid/next', async () => { admitted = true; }, options);
        time.advance(1000);
        await nextTurn();
        assert.strictEqual(admitted, false);
        time.advance(4000);
        await next;
    });

    it('reports a server pause beyond the wait allowance without issuing a request', async () => {
        const time = clock();
        const requests = new HttpRequestRetry(time);
        const options = {retries: 2, maximumWaitMs: 60_000};
        let calls = 0;
        await assert.rejects(requests.run('https://one.invalid/file', async () => {
            calls++;
            throw new HttpResponseError(429, 'busy', 120_000);
        }, options), error => error instanceof HttpBackoffError && error.retryAfterMs === 120_000);
        await assert.rejects(requests.run('https://one.invalid/next', async () => {
            calls++;
        }, options), HttpBackoffError);
        assert.strictEqual(calls, 1);
    });

    it('keeps one recovery request when the preceding probe still answers 503', async () => {
        const time = clock();
        const requests = new HttpRequestRetry(time);
        const options = {retries: 0, maximumWaitMs: 60_000};
        await assert.rejects(requests.run('https://one.invalid/initial', async () => { throw overload(); }, options));
        time.advance(1000);
        await assert.rejects(requests.run('https://one.invalid/probe', async () => {
            throw new HttpResponseError(503, 'still unavailable');
        }, options));
        const release = deferred();
        let admitted = 0;
        const next = () => requests.run('https://one.invalid/next', async () => { admitted++; await release.promise; }, options);
        const waiting = [next(), next()];
        try {
            await nextTurn();
            assert.strictEqual(admitted, 0, 'a 503 probe retains the recovery pause');
            time.advance(2000);
            await nextTurn();
            assert.strictEqual(admitted, 1, 'a failed probe must not release all waiting requests');
        } finally {
            time.advance(60_000);
            release.resolve();
            await Promise.allSettled(waiting);
        }
    });

    it('bounds admission behind an unfinished recovery probe', async () => {
        const time = clock();
        const requests = new HttpRequestRetry(time);
        const options = {retries: 0, maximumWaitMs: 5000};
        await assert.rejects(requests.run('https://one.invalid/initial', async () => { throw overload(); }, options));
        time.advance(1000);
        const entered = deferred(), release = deferred();
        const probe = requests.run('https://one.invalid/compile', async () => { entered.resolve(); await release.promise; }, options);
        await entered.promise;
        let outcome: unknown = 'pending';
        const waiting = requests.run('https://one.invalid/file', async () => {}, options)
            .then(() => { outcome = 'admitted'; }, error => { outcome = error; });
        try {
            time.advance(5001);
            await nextTurn();
            assert.ok(outcome instanceof HttpBackoffError, 'waiting for a probe is part of the admission allowance');
        } finally {
            release.resolve();
            await Promise.allSettled([probe, waiting]);
        }
    });

    it('uses the numeric reset code through causes and reads Retry-After safely', () => {
        assert.strictEqual(http2ErrorCode(overload()), 11);
        assert.strictEqual(http2ErrorCode(new Error('NGHTTP2_ENHANCE_YOUR_CALM')), undefined);
        const cycle: {cause?: unknown} = {};
        cycle.cause = cycle;
        assert.strictEqual(http2ErrorCode(cycle), undefined);
        assert.strictEqual(retryAfterMs('2'), 2000);
        assert.strictEqual(retryAfterMs('9'.repeat(400)), undefined);
        assert.strictEqual(retryAfterMs('Mon, 09 Nov 2026 12:00:02 GMT', Date.parse('2026-11-09T12:00:00Z')), 2000);
    });

    it('recovers a repeatable binary upload after a real HTTP/2 reset with complete body bytes', async () => {
        const sessions = new Set<ServerHttp2Session>();
        const received: {bytes: Buffer, contentType: string}[] = [];
        let sessionCount = 0;
        const server = createServer();
        server.on('session', session => {
            sessions.add(session);
            sessionCount++;
            session.on('close', () => sessions.delete(session));
            session.on('error', () => {});
        });
        server.on('stream', (stream, headers) => {
            const chunks: Buffer[] = [];
            stream.on('error', () => {});
            stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
            stream.on('end', () => {
                received.push({bytes: Buffer.concat(chunks), contentType: String(headers['content-type'])});
                if (received.length === 1) {
                    stream.close(constants.NGHTTP2_ENHANCE_YOUR_CALM);
                } else {
                    stream.respond({':status': 200});
                    stream.end(JSON.stringify({success: true, entity_id: 'file', entity_type: 'file', hash: 'server-file-hash'}));
                }
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        // The installed Undici runtime supports h2c; its Agent.Options declaration omits it.
        const dispatcherOptions = {useH2c: true, connections: 1};
        const agent = new undici.Agent(dispatcherOptions);
        const {BaseAPI} = loadWithVscode({}, () => require('../api/base'), {
            undici: {...undici, fetch: (url: string, options: any) => undici.fetch(url, {...options, dispatcher: agent})},
        });
        const bytes = new Uint8Array([0, 255, 0x50, 0x4b, 10, 13, 1]);
        try {
            const api = new BaseAPI(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
            const result = await api.uploadFile(identity, 'project', 'folder', 'archive.tar.gz', bytes);
            assert.strictEqual(result.type, 'success');
            assert.strictEqual(result.entity.hash, 'server-file-hash', 'use the hash returned by Overleaf');
            assert.strictEqual(received.length, 2);
            assert.strictEqual(sessionCount, 1, 'a stream reset does not require replacing the healthy HTTP/2 session');
            for (const request of received) {
                const form = await new undici.Response(request.bytes, {headers: {'content-type': request.contentType}}).formData();
                const file = form.get('qqfile');
                assert.ok(file && typeof file !== 'string');
                assert.strictEqual(file.name, 'archive.tar.gz');
                assert.deepStrictEqual(new Uint8Array(await file.arrayBuffer()), bytes);
            }
        } finally {
            await agent.close();
            for (const session of sessions) { session.destroy(); }
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    }).timeout(10_000);
});
