/* eslint-disable @typescript-eslint/naming-convention -- HTTP header and Overleaf field names */
import * as assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');

// GlobalStateManager imports 'vscode', which only exists inside the extension host, and so do
// the modules it imports. Stand in for anything they touch while they load, as download.test does.
function stub(): any {
    const f: any = function () { return stub(); };
    return new Proxy(f, {
        get(target, key) {
            if (key === 'then') { return undefined; }
            if (!(key in target)) { target[key] = stub(); }
            return target[key];
        },
        construct() { return stub(); },
    });
}
const withStubs = (target: any): any => new Proxy(target, { get: (t, key) => (key in t ? t[key] : stub()) });
const vscodeMock = withStubs({
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    TreeItem: class {},
    workspace: withStubs({ getConfiguration: () => ({ get: (_key: string, value: any) => value }) }),
    l10n: { t: (message: string) => message },
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { GlobalStateManager } = require('../utils/globalStateManager');
const { BaseAPI } = require('../api/base');
moduleAny._load = originalLoad;

import { checkGitToken, NO_PROJECT_ID } from '../api/gitBridge';
import { cloneProject, credentialAnswer, credentialConfig, credentialHelperCommand, fetchProject, parseCredentialInput, stableNodePath } from '../sandbox/git';
import { readStoredLogin } from '../sandbox/login';

const TOKEN = 'olp_TESTtesttesttesttesttesttesttesttest1';

/** globalState in memory, as the extension's context has it. */
function fakeContext(initial: any) {
    let state = JSON.parse(JSON.stringify(initial));
    return {
        globalState: {
            get: (key: string, fallback: any) => (key === 'overleaf-servers' ? state : fallback),
            update: async (key: string, value: any) => { if (key === 'overleaf-servers') { state = value; } },
        },
        read: () => state,
    };
}
const loggedIn = (userId = 'u1') => ({ 'www.overleaf.com': { name: 'www.overleaf.com', url: 'https://www.overleaf.com/',
    login: { userId, username: `${userId}@example.org`, identity: { cookies: 'c=1', csrfToken: 'x' } } } });
const noLogout = { logout: async () => ({ type: 'success' }) };

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
async function serve(handler: Handler) {
    const requests: Array<{ method?: string, url?: string, headers: http.IncomingHttpHeaders, body: string }> = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => { requests.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, body, res); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}/`, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe('git token storage, next to the login', () => {
    it('keeps the token for the logged-in account and hands it out again', async () => {
        const context = fakeContext(loggedIn());
        assert.strictEqual(GlobalStateManager.getGitToken(context, 'www.overleaf.com'), undefined);
        assert.strictEqual(await GlobalStateManager.setGitToken(context, 'www.overleaf.com', { token: TOKEN, id: 't1' }), true);
        assert.deepStrictEqual(GlobalStateManager.getGitToken(context, 'www.overleaf.com'), { token: TOKEN, id: 't1' });
        assert.deepStrictEqual(context.read()['www.overleaf.com'].gitTokens, { u1: { token: TOKEN, id: 't1' } });
    });

    it('refuses to store a token when nobody is logged in', async () => {
        const context = fakeContext({ 'www.overleaf.com': { name: 'www.overleaf.com', url: 'https://www.overleaf.com/' } });
        assert.strictEqual(await GlobalStateManager.setGitToken(context, 'www.overleaf.com', { token: TOKEN }), false);
    });

    it('does not hand one account\'s token to another account', async () => {
        const context = fakeContext({ 'www.overleaf.com': { ...loggedIn('u2')['www.overleaf.com'], gitTokens: { u1: { token: TOKEN } } } });
        assert.strictEqual(GlobalStateManager.getGitToken(context, 'www.overleaf.com'), undefined);
    });

    it('removes the token with a logout the user asks for', async () => {
        const context = fakeContext(loggedIn());
        await GlobalStateManager.setGitToken(context, 'www.overleaf.com', { token: TOKEN });
        await GlobalStateManager.logoutServer(context, noLogout, 'www.overleaf.com');
        assert.deepStrictEqual(context.read()['www.overleaf.com'].gitTokens, {});
    });

    it('keeps the token through the logout after an expired session, for the next login', async () => {
        const context = fakeContext(loggedIn());
        await GlobalStateManager.setGitToken(context, 'www.overleaf.com', { token: TOKEN });
        await GlobalStateManager.logoutServer(context, noLogout, 'www.overleaf.com', true);
        assert.strictEqual(context.read()['www.overleaf.com'].login, undefined);
        context.read()['www.overleaf.com'].login = loggedIn()['www.overleaf.com'].login;
        assert.deepStrictEqual(GlobalStateManager.getGitToken(context, 'www.overleaf.com'), { token: TOKEN });
    });

    it('forgets the token on request and says what it was', async () => {
        const context = fakeContext(loggedIn());
        await GlobalStateManager.setGitToken(context, 'www.overleaf.com', { token: TOKEN, id: 't1' });
        assert.deepStrictEqual(await GlobalStateManager.removeGitToken(context, 'www.overleaf.com'), { token: TOKEN, id: 't1' });
        assert.strictEqual(GlobalStateManager.getGitToken(context, 'www.overleaf.com'), undefined);
    });
});

describe('the command-line tool reads the same storage', () => {
    const saved = process.env.OVERLEAF_LOGIN;
    afterEach(() => { if (saved === undefined) { delete process.env.OVERLEAF_LOGIN; } else { process.env.OVERLEAF_LOGIN = saved; } });

    function stateDb(servers: any): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-token-test-'));
        const file = path.join(dir, 'state.vscdb');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(file);
        db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
        db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('iamhyc.overleaf-workshop', JSON.stringify({ 'overleaf-servers': servers }));
        db.close();
        return file;
    }

    it('finds the git token of the stored login\'s account', () => {
        delete process.env.OVERLEAF_LOGIN;
        const file = stateDb({ 'www.overleaf.com': { ...loggedIn()['www.overleaf.com'], gitTokens: { u1: { token: TOKEN } } } });
        assert.strictEqual(readStoredLogin('www.overleaf.com', file).gitToken, TOKEN);
    });

    it('finds none when the stored token belongs to another account', () => {
        delete process.env.OVERLEAF_LOGIN;
        const file = stateDb({ 'www.overleaf.com': { ...loggedIn('u2')['www.overleaf.com'], gitTokens: { u1: { token: TOKEN } } } });
        assert.strictEqual(readStoredLogin('www.overleaf.com', file).gitToken, undefined);
    });

    it('takes gitToken from OVERLEAF_LOGIN', () => {
        process.env.OVERLEAF_LOGIN = JSON.stringify({ url: 'https://www.overleaf.com/', cookies: 'c=1', csrfToken: 'x', userId: 'u1', gitToken: TOKEN });
        assert.strictEqual(readStoredLogin('www.overleaf.com').gitToken, TOKEN);
    });
});

describe('the token requests of Account Settings', () => {
    const identity = { cookies: 'overleaf_session2=s', csrfToken: 'csrf-1' };

    it('lists the tokens with the session cookie', async () => {
        const list = [{ _id: 't1', accessTokenPartial: 'olp_TEST', createdAt: '2026-10-30T13:38:52.882Z', accessTokenExpiresAt: '2027-10-30T13:38:52.882Z', scope: 'git_bridge' }];
        const server = await serve((req, body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(list)); });
        try {
            const res = await new BaseAPI(server.url).listGitTokens(identity);
            assert.deepStrictEqual(res.gitTokens, list);
            assert.strictEqual(server.requests[0].method, 'GET');
            assert.strictEqual(server.requests[0].url, '/oauth/personal-access-tokens');
            assert.strictEqual(server.requests[0].headers.cookie, 'overleaf_session2=s');
        } finally { await server.close(); }
    });

    it('creates a token with the CSRF token, and returns it', async () => {
        const server = await serve((req, body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ accessToken: TOKEN })); });
        try {
            const res = await new BaseAPI(server.url).createGitToken(identity);
            assert.strictEqual(res.gitToken, TOKEN);
            assert.strictEqual(server.requests[0].method, 'POST');
            assert.strictEqual(server.requests[0].headers['x-csrf-token'], 'csrf-1');
            assert.strictEqual(JSON.parse(server.requests[0].body)._csrf, 'csrf-1');
        } finally { await server.close(); }
    });

    it('sends the create request once, also after a server error', async () => {
        const server = await serve((req, body, res) => { res.writeHead(500); res.end('oops'); });
        try {
            const res = await new BaseAPI(server.url).createGitToken(identity);
            assert.strictEqual(res.type, 'error');
            assert.strictEqual(server.requests.length, 1);
        } finally { await server.close(); }
    });

    it('revokes a token by its id', async () => {
        const server = await serve((req, body, res) => { res.writeHead(204); res.end(); });
        try {
            const res = await new BaseAPI(server.url).revokeGitToken(identity, '6ae5b792c27a05460b7a5a4f');
            assert.strictEqual(res.type, 'success');
            assert.strictEqual(server.requests[0].method, 'DELETE');
            assert.strictEqual(server.requests[0].url, '/oauth/personal-access-tokens/6ae5b792c27a05460b7a5a4f');
            assert.strictEqual(server.requests[0].headers['x-csrf-token'], 'csrf-1');
        } finally { await server.close(); }
    });
});

describe('the token check at the git bridge', () => {
    // the answers git.overleaf.com gave on 2026-10-31
    const bridge = (token: string) => serve((req, body, res) => {
        const auth = String(req.headers.authorization ?? '');
        if (auth !== `Basic ${Buffer.from(`git:${token}`).toString('base64')}`) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Git Bridge"' });
            res.end('Enter your Git authentication token when prompted for a password.');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
        res.end('001e# service=git-upload-pack\n0000013fERR no git access This Overleaf project currently has no git access');
    });

    it('asks for the project that cannot exist, with user name git', async () => {
        const server = await bridge(TOKEN);
        try {
            assert.strictEqual(await checkGitToken(server.url, TOKEN), 'accepted');
            // the literal id, not the constant: the test must fail when the constant changes
            assert.strictEqual(server.requests[0].url, '/000000000000000000000000/info/refs?service=git-upload-pack');
            assert.strictEqual(NO_PROJECT_ID, '000000000000000000000000');
        } finally { await server.close(); }
    });

    it('reports a wrong token as rejected', async () => {
        const server = await bridge(TOKEN);
        try {
            assert.strictEqual(await checkGitToken(server.url, 'olp_wrong'), 'rejected');
        } finally { await server.close(); }
    });

    it('throws on any other answer, rather than guessing', async () => {
        const server = await serve((req, body, res) => { res.writeHead(404); res.end('not found'); });
        try {
            await assert.rejects(checkGitToken(server.url, TOKEN), /HTTP 404/);
        } finally { await server.close(); }
    });
});

describe('the credential helper', () => {
    it('answers git with the token for the bridge only', () => {
        const request = parseCredentialInput('protocol=https\nhost=git.overleaf.com\n\n');
        assert.strictEqual(credentialAnswer('get', request, 'https://git.overleaf.com', TOKEN), `username=git\npassword=${TOKEN}\n`);
        assert.strictEqual(credentialAnswer('get', parseCredentialInput('protocol=https\nhost=github.com\n'), 'https://git.overleaf.com', TOKEN), '');
        assert.strictEqual(credentialAnswer('get', parseCredentialInput('protocol=http\nhost=git.overleaf.com\n'), 'https://git.overleaf.com', TOKEN), '');
    });

    it('stays silent for store and erase, and without a token', () => {
        const request = parseCredentialInput('protocol=https\nhost=git.overleaf.com\nusername=git\npassword=x\n');
        assert.strictEqual(credentialAnswer('store', request, 'https://git.overleaf.com', TOKEN), '');
        assert.strictEqual(credentialAnswer('erase', request, 'https://git.overleaf.com', TOKEN), '');
        assert.strictEqual(credentialAnswer('get', request, 'https://git.overleaf.com', undefined), '');
    });

    it('is configured by paths and names, never by the token', () => {
        assert.strictEqual(stableNodePath('/snap/node/12219/bin/node'), '/snap/node/current/bin/node');
        assert.strictEqual(stableNodePath('/usr/bin/node'), '/usr/bin/node');
        const helper = credentialHelperCommand('/usr/bin/node', "/x/it's/cli.js", 'www.overleaf.com', 'https://git.overleaf.com');
        assert.strictEqual(helper, `!'/usr/bin/node' '/x/it'\\''s/cli.js' git-credential --server 'www.overleaf.com' --bridge 'https://git.overleaf.com'`);
        assert.deepStrictEqual(credentialConfig('https://git.overleaf.com/', helper),
                               [['credential.https://git.overleaf.com.helper', ''], ['credential.https://git.overleaf.com.helper', helper]]);
    });

    it('builds clone commands that hold no token', () => {
        const calls: string[][] = [];
        cloneProject({ bridgeUrl: 'https://git.overleaf.com', projectId: 'p'.repeat(24), into: '/tmp/x', helper: '!helper' },
                     args => { calls.push(args); return { status: 0, error: undefined }; });
        assert.ok(calls.every(args => args.every(arg => !arg.includes(TOKEN))));
        assert.deepStrictEqual(calls[0].slice(-3), ['--', `https://git.overleaf.com/${'p'.repeat(24)}`, '/tmp/x']);
        assert.deepStrictEqual(calls[1], ['-C', '/tmp/x', 'config', '--local', '--replace-all', 'credential.https://git.overleaf.com.helper', '']);
        assert.deepStrictEqual(calls[2], ['-C', '/tmp/x', 'config', '--local', '--add', 'credential.https://git.overleaf.com.helper', '!helper']);
    });
});

describe('clone and fetch through the credential helper, with real git', function () {
    this.timeout(60000);
    const cli = path.join(__dirname, '..', 'sandbox', 'cli.js');
    let root: string;
    let server: { url: string, close: () => Promise<void> };
    const saved = process.env.OVERLEAF_LOGIN;

    before(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-git-test-'));
        const origin = path.join(root, 'origin');
        const git = (cwd: string, ...args: string[]) => {
            const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
            assert.strictEqual(r.status, 0, r.stderr);
            return r.stdout;
        };
        fs.mkdirSync(path.join(origin, 'work'), { recursive: true });
        git(path.join(origin, 'work'), 'init', '-q', '-b', 'master');
        fs.writeFileSync(path.join(origin, 'work', 'main.tex'), 'one\n');
        git(path.join(origin, 'work'), 'add', 'main.tex');
        git(path.join(origin, 'work'), 'commit', '-q', '-m', 'one');
        git(origin, 'clone', '-q', '--bare', 'work', `${'a'.repeat(24)}`);
        // the stand-in bridge runs as its own process: cloneProject runs git with spawnSync,
        // which blocks this process's event loop, so a server in this process could not answer
        const child = spawn(process.execPath, [path.join(__dirname, 'gitHttpServer.js'), origin, TOKEN], { stdio: ['ignore', 'pipe', 'inherit'] });
        const port = await new Promise<number>((resolve, reject) => {
            child.stdout!.on('data', (chunk: Buffer) => { const m = /listening (\d+)/.exec(chunk.toString()); if (m) { resolve(Number(m[1])); } });
            child.on('exit', code => reject(new Error(`the stand-in bridge exited with ${code}`)));
        });
        server = { url: `http://127.0.0.1:${port}`, close: async () => { child.kill(); } };
        (server as any).git = git;
        (server as any).origin = origin;
    });

    after(async () => {
        await server?.close();
        if (saved === undefined) { delete process.env.OVERLEAF_LOGIN; } else { process.env.OVERLEAF_LOGIN = saved; }
        fs.rmSync(root, { recursive: true, force: true });
    });

    const helperFor = (bridgeUrl: string) => credentialHelperCommand(stableNodePath(process.execPath), cli, 'www.overleaf.com', bridgeUrl);
    const quiet = (args: string[]) => spawnSync('git', args, { stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

    it('clones with the stored token, keeps no token in the clone, and fetches later', () => {
        process.env.OVERLEAF_LOGIN = JSON.stringify({ url: 'https://www.overleaf.com/', cookies: 'c=1', csrfToken: 'x', userId: 'u1', gitToken: TOKEN });
        const into = path.join(root, 'clone');
        cloneProject({ bridgeUrl: server.url, projectId: 'a'.repeat(24), into, helper: helperFor(server.url) }, quiet);
        assert.strictEqual(fs.readFileSync(path.join(into, 'main.tex'), 'utf8'), 'one\n');
        const config = fs.readFileSync(path.join(into, '.git', 'config'), 'utf8');
        assert.ok(!config.includes(TOKEN), 'the clone\'s configuration holds the token');
        assert.ok(config.includes('git-credential'), config);
        const git = (server as any).git;
        const work = path.join((server as any).origin, 'work');
        fs.writeFileSync(path.join(work, 'main.tex'), 'two\n');
        git(work, 'commit', '-q', '-am', 'two');
        git(work, 'push', '-q', path.join((server as any).origin, 'a'.repeat(24)), 'master');
        fetchProject({ into }, quiet);
        assert.strictEqual(git(into, 'show', 'origin/master:main.tex'), 'two\n');
    });

    it('fails without the stored token', () => {
        process.env.OVERLEAF_LOGIN = JSON.stringify({ url: 'https://www.overleaf.com/', cookies: 'c=1', csrfToken: 'x', userId: 'u1' });
        assert.throws(() => cloneProject({ bridgeUrl: server.url, projectId: 'a'.repeat(24), into: path.join(root, 'clone2'), helper: helperFor(server.url) }, quiet),
                      /git clone failed/);
    });
});
