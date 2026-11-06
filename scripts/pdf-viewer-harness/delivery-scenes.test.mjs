import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deliveryRequestCategory, summarizeDeliveryNetwork } from './delivery-observation.mjs';

test('reading images, layout and descriptor traffic remain separate from application code and original PDF bytes', () => {
    const root = '/spomenar/previews/edition/';
    assert.equal(deliveryRequestCategory('/spomenar-versions/edition/book.pdf'), 'pdf');
    assert.equal(deliveryRequestCategory(root + 'reading.json'), 'reading-manifest');
    assert.equal(deliveryRequestCategory(root + 'reading/layout-sha.pdf'), 'reading-layout');
    assert.equal(deliveryRequestCategory(root + 'reading/image-sha.jpg'), 'reading-images');
    assert.equal(deliveryRequestCategory(root + 'reading/image-sha.bin'), 'reading-images');
    assert.equal(deliveryRequestCategory(root + 'previews/page-99.png'), 'previews');
    assert.equal(deliveryRequestCategory('/spomenar/app.js'), 'application');
});

test('byte accounting uses the completed transfer once and retains cancelled partial bodies', () => {
    const result = summarizeDeliveryNetwork([
        { category: 'pdf', bodyBytes: 1000, encodedBodyBytes: 1000, totalBytes: 1100, completed: true },
        { category: 'pdf', bodyBytes: 250, encodedBodyBytes: 250, failed: true },
        { category: 'previews', bodyBytes: 200, encodedBodyBytes: 0, totalBytes: 0, completed: true, cached: true },
    ]);
    assert.deepEqual(result.pdf, { requests: 2, completed: 1, failed: 1, bodyBytes: 1250, transferredBytes: 1350, cached: 0 });
    assert.equal(result.previews.transferredBytes, 0);
    assert.equal(result.previews.bodyBytes, 200);
    assert.equal(result.previews.cached, 1);
});

for (const scenario of [
    { name: 'a failed optional screenshot retains measured pages and closes the owned target', mode: 'screenshot' },
    { name: 'a final-quality deadline keeps its partial measurement and fails the requested completion', mode: 'final' },
    { name: 'an unexpected CSS viewport or browser zoom fails the comparison and retains its observation', mode: 'viewport' },
    { name: 'a failed verification repaint retains measured pages and closes the owned target', mode: 'repaint' },
]) test(scenario.name, async t => {
    const calls = [];
    const sample = { finished: 'measurement-budget', elapsedMs: 60000,
        pages: [{ page: 99, firstPixelsMs: 300, firstSelectableTextMs: 1200 }],
        frames: { count: 100, p95Ms: 17 }, viewport: { width: 1400, height: 1000, dpr: 1 }, document: { pages: 460, notice: null }, errors: [] };
    if (scenario.mode === 'viewport') sample.viewport = { width: 1120, height: 800, dpr: 1.25 };
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        calls.push({ route: request.url, ...body });
        response.setHeader('content-type', 'application/json');
        let result;
        if (request.url === '/status') result = { connected: true, event_seq: 0 };
        else if (request.url.startsWith('/events?')) result = [];
        else if (request.url === '/attach') result = { sessionId: 'measurement-session' };
        else if (body.method === 'Target.createTarget') result = { result: { targetId: 'measurement-target' } };
        else if (body.method === 'Runtime.evaluate' && body.params.expression.includes('repaintDeliveryPages')) {
            result = { result: { exceptionDetails: { text: 'Injected native verification repaint failure' } } };
        } else if (body.method === 'Runtime.evaluate') result = { result: { result: { type: 'object', value: sample } } };
        else if (body.method === 'Page.startScreencast' && body.params.format === 'png') {
            response.statusCode = 500;
            result = { error: { code: -32000, message: 'Injected screenshot failure' } };
        } else result = { result: {} };
        response.end(JSON.stringify(result));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-delivery-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const destination = path.join(directory, 'result.json');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./delivery-scenes.mjs', import.meta.url)),
        '--daemon', 'http://127.0.0.1:' + server.address().port, '--url', 'https://reader.example/book/',
        '--pages', '99', '--json', destination,
        ...(scenario.mode === 'screenshot' ? ['--screenshot', path.join(directory, 'view.png')]
            : scenario.mode === 'final' ? ['--finish-on-final']
            : scenario.mode === 'repaint' ? ['--repaint-canvases', path.join(directory, 'repeat')] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 1, stderr);
    const result = JSON.parse(await fs.readFile(destination, 'utf8'));
    assert.deepEqual(result.observation?.pages, sample.pages, stdout);
    assert.ok(result.failures.some(failure => scenario.mode === 'screenshot'
        ? /screenshot/i.test(JSON.stringify(failure)) : scenario.mode === 'repaint' ? /repaint/i.test(JSON.stringify(failure))
            : failure.kind === (scenario.mode === 'final' ? 'completion' : 'viewport')));
    assert.ok(calls.some(call => call.route === '/release' && call.sessionId === 'measurement-session'));
    assert.ok(calls.some(call => call.method === 'Target.detachFromTarget' && call.params.sessionId === 'measurement-session'));
    assert.ok(calls.some(call => call.method === 'Target.closeTarget' && call.params.targetId === 'measurement-target'));
});
