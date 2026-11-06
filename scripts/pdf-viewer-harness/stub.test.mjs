/* eslint-disable @typescript-eslint/naming-convention -- browser globals supplied to the VM */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./stub.js', import.meta.url), 'utf8');

function fixture(options = {}) {
    const messages = [], requests = [], state = new Map(), listeners = new Map();
    const window = { postMessage(message) { messages.push(message); }, addEventListener(type, callback) { listeners.set(type, callback); } };
    class Request {
        open(_method, url) { this.url = url; }
        send() { this.responseText = JSON.stringify(this.url === '/builds' ? { a: { file: { build: 'a' } } } : {}); }
    }
    vm.runInNewContext(source, {
        window, document: { currentScript: { src: 'http://localhost/stub.js?doc=fixture' },
            getElementById: id => id === 'viewer-config' ? { textContent: JSON.stringify({ page: 'current-page', harness: options.harness }) } : null },
        location: { search: '' }, URL, URLSearchParams, XMLHttpRequest: Request, performance: { now: () => 0 },
        AbortController, Uint8Array,
        sessionStorage: { getItem: key => state.get(key), setItem: (key, value) => state.set(key, value) },
        fetch: (url, request) => { requests.push({ url, ...request }); return options.fetch?.(url, request) ?? Promise.resolve({ ok: true }); },
    });
    return { api: window.acquireVsCodeApi(), messages, requests, listeners };
}

test('the browser host replies only to the current page readiness message', () => {
    const f = fixture();
    f.api.postMessage({ type: 'ready', page: 'retired-page' });
    assert.equal(f.messages.length, 0);
    f.api.postMessage({ type: 'ready', page: 'current-page' });
    assert.deepEqual(f.messages.map(message => message.type), ['initState', 'load']);
});

test('the browser host ignores saved state from a replaced page', () => {
    const f = fixture();
    f.api.postMessage({ type: 'saveState', page: 'retired-page', content: { scale: '1' } });
    assert.equal(f.requests.length, 0);
    f.api.postMessage({ type: 'saveState', page: 'current-page', content: { scale: '2' } });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].body, '{"scale":"2"}');
});

test('registered readiness sends the pinned preview and reading descriptors to the actual adapter', () => {
    const harness = { preview: { identity: { key: 'public' }, manifestUrl: '/registered/manifest.json' },
        reading: { identity: { sha256: 'public' }, manifestUrl: '/registered/reading.json', manifestRevision: 'revision' } };
    const f = fixture({ harness });
    f.api.postMessage({ type: 'ready', page: 'current-page' });
    const load = f.messages.find(message => message.type === 'load');
    assert.deepEqual(JSON.parse(JSON.stringify(load.preview)), harness.preview);
    assert.deepEqual(JSON.parse(JSON.stringify(load.reading)), harness.reading);
});

test('reading messages forward chunk counts through the host and return exact typed bytes', async () => {
    const f = fixture({ fetch: async () => ({ headers: { get: name => name === 'x-bridge'
        ? JSON.stringify({ id: 7, status: 206, headers: [['content-range', 'bytes 0-2/9']] }) : null },
    arrayBuffer: async () => Uint8Array.from([4, 5, 6]).buffer }) });
    f.api.postMessage({ type: 'readingFetch', page: 'current-page', id: 7, manifestRevision: 'revision', imageId: 'x635', chunkIndex: 0, chunkCount: 3 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests[0]?.url, '/reading-bridge');
    assert.equal(JSON.parse(f.requests[0].body).chunkCount, 3);
    const response = f.messages.find(message => message.type === 'fetchResponse');
    assert.deepEqual([...response.body], [4, 5, 6]);
    assert.equal(response.page, 'current-page');
});

test('navigation cancels pending requests and closes exactly its own host page', async () => {
    let signal;
    const f = fixture({ fetch: (url, request) => {
        if (url !== '/reading-bridge') { return Promise.resolve({ ok: true }); }
        signal = request.signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
    f.api.postMessage({ type: 'readingFetch', page: 'current-page', id: 4, manifestRevision: 'revision', imageId: 'x1', chunkIndex: 0 });
    assert.equal(signal?.aborted, false);
    f.listeners.get('pagehide')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    const close = f.requests.find(request => request.url === '/page-close');
    assert.equal(JSON.parse(close.body).page, 'current-page');
    assert.equal(close.keepalive, true);
    assert.equal(f.messages.length, 0);
});
