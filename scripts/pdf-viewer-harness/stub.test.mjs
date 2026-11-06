/* eslint-disable @typescript-eslint/naming-convention -- browser globals supplied to the VM */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./stub.js', import.meta.url), 'utf8');

function fixture() {
    const messages = [], requests = [], state = new Map();
    const window = { postMessage(message) { messages.push(message); }, addEventListener() {} };
    class Request {
        open(_method, url) { this.url = url; }
        send() { this.responseText = JSON.stringify(this.url === '/builds' ? { a: { file: { build: 'a' } } } : {}); }
    }
    vm.runInNewContext(source, {
        window, document: { currentScript: { src: 'http://localhost/stub.js?doc=fixture' },
            getElementById: id => id === 'viewer-config' ? { textContent: '{"page":"current-page"}' } : null },
        location: { search: '' }, URL, URLSearchParams, XMLHttpRequest: Request, performance: { now: () => 0 },
        sessionStorage: { getItem: key => state.get(key), setItem: (key, value) => state.set(key, value) },
        fetch: (url, options) => { requests.push({ url, ...options }); return Promise.resolve({ ok: true }); },
    });
    return { api: window.acquireVsCodeApi(), messages, requests };
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
