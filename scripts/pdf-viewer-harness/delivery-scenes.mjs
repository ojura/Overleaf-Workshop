// Measure a cold Spomenar page or spread in an owned tab of the existing browser.
// node scripts/pdf-viewer-harness/delivery-scenes.mjs --url https://cloud.larics.fer.hr/spomenar/
//   --pages 99,100 --spread odd --budget-ms 60000 --json /absolute/path/result.json
// Optional: --daemon http://127.0.0.1:7799 --width 1400 --height 1000 --dpr 1 --zoom 75
//   --download-kib 4096 --latency-ms 40 --robots off --finish-on-render --screenshot /absolute/path/view.png
//   --canvases /absolute/path/page-canvases
//   --zoom-helper-target <existing-state-reader-bridge-target-id>
// Use --finish-on-final to wait for final image quality instead of the fixed measurement duration.
// This uses the shared daemon, creates one regular background tab, isolates PDF.js history,
// disables that tab's HTTP cache, and closes its target and session on every completion path.
import fs from 'node:fs/promises';
import path from 'node:path';
import { scriptOptions } from '../lib/options.mjs';
import { connectDaemon, evaluateHarness } from './scenario-connection.mjs';
import { keepRendering } from './render-capture.mjs';
import { normalizeTabZoom } from './per-tab-zoom.mjs';
import { deliveryRequestCategory, installDeliveryObservation, summarizeDeliveryNetwork } from './delivery-observation.mjs';

const options = scriptOptions({ url: 'value', pages: 'value', spread: ['none', 'odd', 'even'], daemon: 'value',
    width: 'number', height: 'number', dpr: 'number', zoom: 'number', 'budget-ms': 'number',
    'download-kib': 'number', 'latency-ms': 'number', robots: ['off', 'on'], 'finish-on-render': 'flag', 'finish-on-final': 'flag',
    json: 'value', screenshot: 'value', canvases: 'value', 'zoom-helper-target': 'value' });
if (options.has('finish-on-render') && options.has('finish-on-final')) throw new Error('Choose one rendering completion condition');
const url = new URL(options.get('url', 'https://cloud.larics.fer.hr/spomenar/'));
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an explicit HTTP reader URL without credentials');
const pages = options.get('pages', '99,100').split(',').map(Number);
if (!pages.length || pages.some(page => !Number.isSafeInteger(page) || page < 1) || new Set(pages).size !== pages.length) throw new Error('--pages requires distinct positive page numbers');
const positive = (name, fallback, maximum) => {
    const value = options.get(name, fallback);
    if (!(value > 0) || value > maximum) throw new Error('--' + name + ' is outside its supported range');
    return value;
};
const width = positive('width', 1400, 8192), height = positive('height', 1000, 8192), dpr = positive('dpr', 1, 8);
const zoom = positive('zoom', 75, 1000), budgetMs = positive('budget-ms', 60000, 180000);
const latency = options.get('latency-ms', 40), downloadKib = options.get('download-kib', 4096);
if (latency < 0 || downloadKib <= 0) throw new Error('Latency must be nonnegative and throughput must be positive');
url.hash = 'page=' + pages[0] + '&zoom=' + zoom;
const settings = { origin: url.origin, pages, spread: { none: 0, odd: 1, even: 2 }[options.get('spread', 'odd')],
    budgetMs, robots: options.get('robots', 'off') === 'on', finishOnRender: options.has('finish-on-render'), finishOnFinal: options.has('finish-on-final') };
const requests = new Map(), failures = [];
let connection, target, targetId, result, rendering, tabZoom;
let interrupted;
const signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => { interrupted = signal; }]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
try {
    connection = await connectDaemon(options.get('daemon', 'http://127.0.0.1:7799'));
    ({ targetId } = await connection.send('Target.createTarget', { url: 'about:blank', background: true }));
    target = await connection.attach(targetId);
    await target.prepare();
    await target.send('Page.enable');
    await target.send('Network.enable');
    await target.send('Network.setCacheDisabled', { cacheDisabled: true });
    await target.send('Network.setBypassServiceWorker', { bypass: true });
    await target.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    if (options.get('zoom-helper-target')) tabZoom = await normalizeTabZoom(connection, options.get('zoom-helper-target'), targetId);
    rendering = await keepRendering(target);
    await target.send('Network.emulateNetworkConditions', { offline: false, latency,
        downloadThroughput: downloadKib * 1024, uploadThroughput: -1 });
    target.on('Network.requestWillBeSent', event => {
        const requested = new URL(event.request.url);
        if (requested.origin !== url.origin) return;
        if (requests.size >= 8192) throw new Error('Delivery request observation limit reached');
        const category = deliveryRequestCategory(requested.pathname);
        requests.set(event.requestId, { path: requested.pathname, category, started: event.timestamp,
            wallTime: event.wallTime, bodyBytes: 0, encodedBodyBytes: 0 });
    });
    target.on('Network.responseReceived', event => {
        const request = requests.get(event.requestId);
        if (!request) return;
        request.status = event.response.status;
        request.cached = !!(event.response.fromDiskCache || event.response.fromServiceWorker || event.response.fromPrefetchCache);
        request.contentRange = Object.entries(event.response.headers).find(([key]) => key.toLowerCase() === 'content-range')?.[1];
    });
    target.on('Network.dataReceived', event => {
        const request = requests.get(event.requestId);
        if (request) { request.bodyBytes += event.dataLength; request.encodedBodyBytes += event.encodedDataLength; }
    });
    target.on('Network.loadingFinished', event => {
        const request = requests.get(event.requestId);
        if (request) Object.assign(request, { completed: true, totalBytes: event.encodedDataLength, ended: event.timestamp });
    });
    target.on('Network.loadingFailed', event => {
        const request = requests.get(event.requestId);
        if (request) Object.assign(request, { failed: true, cancelled: !!event.canceled, error: event.errorText, ended: event.timestamp });
    });
    await target.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + installDeliveryObservation.toString() + ')(' + JSON.stringify(settings) + ')' });
    const navigation = await target.send('Page.navigate', { url: url.href });
    if (navigation.errorText) throw new Error(navigation.errorText);
    await target.prepare();
    await tabZoom?.ensure();
    await rendering.refresh();
    let sample;
    do {
        sample = await evaluateHarness(target, 'window.__pdfDeliveryObservation.next()');
        if (interrupted) {
            sample = await evaluateHarness(target, "(window.__pdfDeliveryObservation.finish('interrupted'), window.__pdfDeliveryObservation.snapshot())");
        }
    } while (!sample.finished);
    const observedRequests = structuredClone([...requests.values()]);
    result = { url: url.href, viewport: { width, height, dpr }, networkConditions: { latencyMs: latency, downloadKibPerSecond: downloadKib },
        observation: sample, network: summarizeDeliveryNetwork(observedRequests), requests: observedRequests };
    if (sample.viewport.width !== width || sample.viewport.height !== height || !Number.isFinite(sample.viewport.dpr) || Math.abs(sample.viewport.dpr - dpr) > 0.001) {
        failures.push({ kind: 'viewport', expected: { width, height, dpr }, actual: sample.viewport });
    }
    const expectedFinish = options.has('finish-on-final') ? 'final-images-rendered' : options.has('finish-on-render') ? 'pages-rendered' : undefined;
    if (expectedFinish && sample.finished !== expectedFinish) {
        failures.push({ kind: 'completion', expected: expectedFinish, actual: sample.finished });
    }
    if (sample.errors.length || sample.pages.some(page => page.renders?.some(render => render.error))
        || sample.document.notice || !sample.document.pages || interrupted) process.exitCode = 1;
    if (options.get('canvases')) {
        const captures = await evaluateHarness(target, 'window.__pdfDeliveryObservation.captureCanvases()');
        const directory = path.resolve(options.get('canvases'));
        await fs.mkdir(directory, { recursive: true });
        result.canvasFiles = [];
        for (const capture of captures) {
            if (!pages.includes(capture.page) || !capture.dataUrl.startsWith('data:image/png;base64,')) throw new Error('Invalid native canvas capture');
            const filename = path.join(directory, 'page-' + capture.page + '.png');
            await fs.writeFile(filename, Buffer.from(capture.dataUrl.slice('data:image/png;base64,'.length), 'base64'));
            result.canvasFiles.push({ page: capture.page, width: capture.width, height: capture.height, filename });
        }
    }
    if (options.get('screenshot')) {
        const { data } = await rendering.still({ width: sample.viewport.width, height: sample.viewport.height });
        const filename = path.resolve(options.get('screenshot'));
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, Buffer.from(data, 'base64'));
    }
} catch (error) {
    failures.push(error.toJSON?.() ?? { message: String(error) }); process.exitCode = 1;
} finally {
    if (rendering) {
        try { const evidence = await rendering.close(); if (result) result.renderingCapture = evidence; }
        catch (error) { failures.push({ cleanup: 'rendering-capture', message: String(error) }); }
    }
    if (tabZoom) {
        try { const restored = await tabZoom.close(); if (result) result.tabZoom = restored; }
        catch (error) { failures.push({ cleanup: 'tab-zoom', message: String(error) }); }
    }
    if (target) { try { await target.detach(); } catch (error) { failures.push({ cleanup: 'detach', message: String(error) }); } }
    if (targetId && connection) {
        try { await connection.send('Target.closeTarget', { targetId }); }
        catch (error) { failures.push({ cleanup: 'close-target', message: String(error) }); }
    }
    connection?.close();
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
result ??= { network: summarizeDeliveryNetwork(requests.values()), requests: [...requests.values()] };
result.failures = failures;
if (failures.length) process.exitCode = 1;
if (options.get('json')) {
    const filename = path.resolve(options.get('json'));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ pages: result.observation?.pages, elapsedMs: result.observation?.elapsedMs,
    finished: result.observation?.finished, frames: result.observation?.frames, network: result.network,
    renderingCapture: result.renderingCapture, errors: result.observation?.errors, notice: result.observation?.document.notice, failures }, null, 2));
