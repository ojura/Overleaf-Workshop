/* eslint-disable @typescript-eslint/naming-convention -- CGI variable names */
/**
 * A stand-in for Overleaf's git bridge in tests: git's own HTTP server program (git
 * http-backend) behind the bridge's login check, user name git and the token as the password.
 * It runs as its own process, because the code under test runs git with spawnSync, which
 * blocks the test process's event loop.
 *
 *   node gitHttpServer.js <folder with bare repositories> <token>
 *
 * prints "listening <port>" once it accepts connections.
 */
import { spawn } from 'child_process';
import * as http from 'http';
import { AddressInfo } from 'net';

const [root, token] = process.argv.slice(2);
const expected = `Basic ${Buffer.from(`git:${token}`).toString('base64')}`;

const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Git Bridge"' });
        res.end('Enter your Git authentication token when prompted for a password.');
        return;
    }
    const url = new URL(req.url!, 'http://localhost');
    const cgi = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method!,
        CONTENT_TYPE: String(req.headers['content-type'] ?? ''), REMOTE_USER: 'git', REMOTE_ADDR: '127.0.0.1' } });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headDone = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
        if (headDone) { res.write(chunk); return; }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) { return; }
        headDone = true;
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.subarray(0, end).toString().split('\r\n')) {
            const colon = line.indexOf(':');
            const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
            if (key.toLowerCase() === 'status') { status = parseInt(value, 10); } else { headers[key] = value; }
        }
        res.writeHead(status, headers);
        res.write(head.subarray(end + 4));
    });
    cgi.stdout.on('end', () => res.end());
});
server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`listening ${(server.address() as AddressInfo).port}\n`);
});
