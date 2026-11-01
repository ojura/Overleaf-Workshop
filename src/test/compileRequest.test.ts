/* eslint-disable @typescript-eslint/naming-convention -- HTTP header names */
import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { BaseAPI, CompileRequest, EDITOR_ID } from '../api/base';
import { OverleafClient } from '../sandbox/client';

/** A server that answers each request after `delayMs` with `status` and `body`. */
async function serve(delayMs: number, status: number, body: string) {
    let requests = 0;
    const server = http.createServer((_req, res) => {
        requests += 1;
        setTimeout(() => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); }, delayMs);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        requests: () => requests,
        close: () => { server.closeAllConnections(); server.close(); },
    };
}

const identity = { cookies: 'overleaf_session2=s', csrfToken: 't' };
const answer = JSON.stringify({ status: 'success', outputFiles: [], compileGroup: 'priority' });
const main: CompileRequest = { rootDocId: 'd1', rootResourcePath: 'main.tex', draft: false, stopOnFirstError: false };

/** A server that records each compile request's URL and body, and answers it at once. */
async function record() {
    const requests: Array<{ url: URL, body: any }> = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            requests.push({ url: new URL(req.url!, 'http://x'), body: JSON.parse(body) });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(answer);
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, requests, close: () => server.close() };
}

describe('BaseAPI.compile', () => {
    const saved = { timeout: BaseAPI.compileRequestTimeoutMs, dispatcher: getGlobalDispatcher() };
    afterEach(() => {
        BaseAPI.compileRequestTimeoutMs = saved.timeout;
        setGlobalDispatcher(saved.dispatcher);
    });

    // undici checks these limits on a timer that ticks about every half second, so the
    // times here are seconds apart

    it('waits for the answer longer than the dispatcher that other requests use', async function () {
        this.timeout(10 * 1000);
        // stands in for undici's five minutes: the compile's answer comes later than that
        setGlobalDispatcher(new Agent({ headersTimeout: 1000, bodyTimeout: 1000 }));
        BaseAPI.compileRequestTimeoutMs = 6000;
        const server = await serve(3000, 200, answer);
        try {
            const res = await new BaseAPI(server.url).compile(identity, 'p1', main, { auto: true });
            assert.strictEqual(res.type, 'success');
            assert.strictEqual(res.compile?.status, 'success');
        } finally { server.close(); }
    });

    it('fails at its own limit, and does not send the compile again', async function () {
        this.timeout(15 * 1000);
        BaseAPI.compileRequestTimeoutMs = 1000;
        const server = await serve(5000, 200, answer);
        try {
            const res = await new BaseAPI(server.url).compile(identity, 'p1', main, { auto: true });
            assert.strictEqual(res.type, 'error');
            assert.match(res.message!, /timeout/i);
            await new Promise(resolve => setTimeout(resolve, 1500));
            assert.strictEqual(server.requests(), 1);
        } finally { server.close(); }
    });

    it('does not send a compile again after a 5xx, which could start a second build', async () => {
        const server = await serve(0, 503, 'unavailable');
        try {
            const res = await new BaseAPI(server.url).compile(identity, 'p1', main, { auto: true });
            assert.strictEqual(res.type, 'error');
            assert.strictEqual(server.requests(), 1);
        } finally { server.close(); }
    });
});

describe('the compile request, which the window and the command-line tools share', () => {
    /** what every compile sends, as the web editor's compile does (compiler.ts:137-150) */
    function assertWebEditorBody(body: any) {
        // the editor ID, without which Overleaf does not keep the build in its cache of compile outputs
        assert.strictEqual(body.editorId, EDITOR_ID);
        assert.match(body.editorId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        // the main document by ID: Overleaf compiles the project's main document otherwise
        assert.strictEqual(body.rootDoc_id, 'd1');
        assert.strictEqual(body.rootResourcePath, 'main.tex');
        assert.strictEqual(body.draft, false);
        assert.strictEqual(body.stopOnFirstError, false);
    }

    it('the window\'s compile names the main document and the editor, and is an automatic one', async () => {
        const server = await record();
        try {
            const res = await new BaseAPI(server.url).compile(identity, 'p1', main, { auto: true });
            assert.strictEqual(res.type, 'success');
            const [{ url, body }] = server.requests;
            assert.strictEqual(url.pathname, '/project/p1/compile');
            assert.strictEqual(url.searchParams.get('enable_pdf_caching'), 'true');
            assert.strictEqual(url.searchParams.get('auto_compile'), 'true');
            assertWebEditorBody(body);
        } finally { server.close(); }
    });

    it('the private-copy tool\'s compile names them too, asks for PDF caching, and is not automatic', async () => {
        const server = await record();
        try {
            const result = await new OverleafClient(server.url, identity).compile('p1', main);
            assert.strictEqual(result.response.status, 'success');
            const [{ url, body }] = server.requests;
            assert.strictEqual(url.pathname, '/project/p1/compile');
            assert.strictEqual(url.searchParams.get('enable_pdf_caching'), 'true');
            // a compile of the Recompile button, not an automatic one
            assert.strictEqual(url.searchParams.get('auto_compile'), null);
            assertWebEditorBody(body);
        } finally { server.close(); }
    });
});
