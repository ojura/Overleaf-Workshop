/* eslint-disable @typescript-eslint/naming-convention -- HTTP header names */
import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { BaseAPI } from '../api/base';

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
            const res = await new BaseAPI(server.url).compile(identity, 'p1', 'main.tex');
            assert.strictEqual(res.type, 'success');
            assert.strictEqual(res.compile?.status, 'success');
        } finally { server.close(); }
    });

    it('fails at its own limit, and does not send the compile again', async function () {
        this.timeout(15 * 1000);
        BaseAPI.compileRequestTimeoutMs = 1000;
        const server = await serve(5000, 200, answer);
        try {
            const res = await new BaseAPI(server.url).compile(identity, 'p1', 'main.tex');
            assert.strictEqual(res.type, 'error');
            assert.match(res.message!, /timeout/i);
            await new Promise(resolve => setTimeout(resolve, 1500));
            assert.strictEqual(server.requests(), 1);
        } finally { server.close(); }
    });

    it('does not send a compile again after a 5xx, which could start a second build', async () => {
        const server = await serve(0, 503, 'unavailable');
        try {
            const res = await new BaseAPI(server.url).compile(identity, 'p1', 'main.tex');
            assert.strictEqual(res.type, 'error');
            assert.strictEqual(server.requests(), 1);
        } finally { server.close(); }
    });
});
