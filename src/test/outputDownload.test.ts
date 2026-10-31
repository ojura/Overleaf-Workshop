import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { BaseAPI, downloadDomainUrl } from '../api/base';

/** A server that plays both the download domain (paths below /cdn) and the web frontend. */
async function serve(answer: (req: http.IncomingMessage) => { status: number, body?: string }) {
    const requests: Array<{ url: string, cookie?: string }> = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url!, cookie: req.headers.cookie });
        const { status, body } = answer(req);
        res.writeHead(status);
        res.end(body ?? '');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    return { base, requests, close: () => server.close() };
}

const identity = { cookies: 'overleaf_session2=s', csrfToken: 't' };
const url = '/project/p1/user/u1/build/b1/output/output.synctex.gz';

describe('BaseAPI.getFileFromClsi', () => {
    it('takes the file from the download domain, without cookies, when it serves it', async () => {
        const server = await serve(() => ({ status: 200, body: 'from the cdn' }));
        try {
            const res = await new BaseAPI(server.base).getFileFromClsi(identity, url, 'priority', 'clsi-1', `${server.base}cdn`);
            assert.strictEqual(res.type, 'success');
            assert.strictEqual(new TextDecoder().decode(res.content), 'from the cdn');
            assert.deepStrictEqual(server.requests.map(r => r.url), [`/cdn${url}?compileGroup=priority&clsiserverid=clsi-1&enable_pdf_caching=true`]);
            assert.strictEqual(server.requests[0].cookie, undefined);
        } finally { server.close(); }
    });

    it('falls back to the web frontend, with the compile server\'s id, when the download domain refuses', async function () {
        this.timeout(10 * 1000); // the download domain's 503 is retried twice first
        const server = await serve((req) => (req.url!.startsWith('/cdn/') ? { status: 503 } : { status: 200, body: 'from the web' }));
        try {
            const res = await new BaseAPI(server.base).getFileFromClsi(identity, url, 'priority', 'clsi-1', `${server.base}cdn`);
            assert.strictEqual(res.type, 'success');
            assert.strictEqual(new TextDecoder().decode(res.content), 'from the web');
            const web = server.requests.filter(r => !r.url.startsWith('/cdn/'));
            assert.deepStrictEqual(web.map(r => r.url), [`${url}?clsiserverid=clsi-1`]);
            assert.strictEqual(web[0].cookie, identity.cookies);
        } finally { server.close(); }
    });

    it('reports both failures when neither serves the file', async () => {
        const server = await serve(() => ({ status: 404 }));
        try {
            const res = await new BaseAPI(server.base).getFileFromClsi(identity, url, 'priority', 'clsi-1', `${server.base}cdn`);
            assert.strictEqual(res.type, 'error');
            assert.match(res.message!, /HTTP 404.*from the web server: .*HTTP 404/);
        } finally { server.close(); }
    });

    it('asks the web frontend directly when there is no download domain', async () => {
        const server = await serve(() => ({ status: 200, body: 'log' }));
        try {
            const res = await new BaseAPI(server.base).getFileFromClsi(identity, url, 'standard');
            assert.strictEqual(res.type, 'success');
            assert.deepStrictEqual(server.requests.map(r => r.url), [url]);
        } finally { server.close(); }
    });
});

describe('downloadDomainUrl', () => {
    it('joins the download domain and the file with one slash, and adds the query of Overleaf\'s viewer', () => {
        const file = '/project/p1/user/u1/build/b1/output/output.pdf';
        const expected = 'https://dl/zone/b/project/p1/user/u1/build/b1/output/output.pdf?compileGroup=priority&clsiserverid=clsi-1&enable_pdf_caching=true';
        assert.strictEqual(downloadDomainUrl('https://dl/zone/b', file, 'clsi-1', 'priority'), expected);
        assert.strictEqual(downloadDomainUrl('https://dl/zone/b/', file, 'clsi-1', 'priority'), expected);
        assert.strictEqual(downloadDomainUrl('https://dl/zone/b', file.slice(1), 'clsi-1', 'priority'), expected);
    });

    it('leaves out the compile group and the compile server that the compile does not name', () => {
        assert.strictEqual(downloadDomainUrl('https://dl', '/f', undefined, undefined), 'https://dl/f?enable_pdf_caching=true');
    });
});
