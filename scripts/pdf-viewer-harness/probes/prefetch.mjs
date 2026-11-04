// Compare native PDF.js scheduling with the shared predictor in one background tab of an
// existing Chrome connection. --headless yes uses one owned browser for the entire run;
// --cdp reuses a browser endpoint with a separate context that closes on disconnect.
// Usage: node scripts/pdf-viewer-harness/probes/prefetch.mjs [--daemon http://127.0.0.1:7799]
//        [--headless yes | --cdp http://127.0.0.1:PORT] [--hold yes] [--latency 60] [--port 8786]
// A ws://.../devtools/browser/... endpoint also works with --cdp.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { arg, book, startServer, work } from '../common.mjs';
import { launchChrome } from '../cdp.mjs';
import { connect } from '../../lib/devtools.mjs';

const daemon = arg('daemon', 'http://127.0.0.1:7799');
const port = Number(arg('port', '8786'));
const latency = Number(arg('latency', '60'));
const cdpEndpoint = arg('cdp');
const results = [];
let targetId, sessionId, server, chrome, page, browser, browserContextId;

async function powerSnapshot() {
    const source = '/sys/class/power_supply';
    const at = new Date().toISOString();
    const errors = [];
    let names;
    try {
        names = await fs.promises.readdir(source);
    } catch (error) {
        return { at, source, acOnline: null, batteries: [], supplies: [], errors: [error.code ?? String(error)] };
    }
    // Keep peripheral batteries separate from the machine's own battery and AC state.
    const fields = ['type', 'scope', 'present', 'online', 'status', 'capacity', 'power_now', 'energy_now', 'charge_now'];
    const supplies = await Promise.all(names.sort().map(async name => {
        const state = { name };
        await Promise.all(fields.map(async field => {
            try {
                state[field] = (await fs.promises.readFile(path.join(source, name, field), 'utf8')).trim();
            } catch (error) {
                if (error.code !== 'ENOENT') { errors.push({ name, field, error: error.code ?? String(error) }); }
            }
        }));
        return state;
    }));
    const system = supplies.filter(supply => supply.scope !== 'Device');
    const external = system.filter(supply => supply.type !== 'Battery' && supply.online !== undefined);
    const number = (supply, field, divisor = 1) => {
        const value = Number(supply[field]);
        return Number.isFinite(value) ? value / divisor : null;
    };
    return {
        at,
        source,
        acOnline: external.length ? external.some(supply => supply.online === '1') : null,
        batteries: system.filter(supply => supply.type === 'Battery' && supply.present !== '0').map(supply => ({
            name: supply.name,
            status: supply.status ?? null,
            capacityPercent: number(supply, 'capacity'),
            powerWatts: number(supply, 'power_now', 1e6),
            energyWh: number(supply, 'energy_now', 1e6),
            chargeAh: number(supply, 'charge_now', 1e6),
        })),
        supplies,
        errors,
    };
}

async function request(endpoint, body) {
    const response = await fetch(daemon + endpoint, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    if (!response.ok || value.error) { throw new Error(JSON.stringify(value)); }
    return value;
}
async function cdp(method, params = {}) {
    if (page) { return page.send(method, params); }
    const value = await request('/cdp', { method, params, ...(sessionId ? { sessionId } : {}), timeout_seconds: 40 });
    return value.result ?? value;
}
async function evaluate(expression) {
    const params = { expression, awaitPromise: true, returnByValue: true };
    const value = page
        ? await page.send('Runtime.evaluate', params)
        : await request('/eval', { sessionId, ...params, timeout_seconds: 50 });
    if (value.exceptionDetails) { throw new Error(JSON.stringify(value)); }
    if (!value.result || !('value' in value.result)) { throw new Error(JSON.stringify(value)); }
    return value.result.value;
}
const viewer = '(window.overleafViewer?.wrapper.viewer ?? window.PDFViewerApplication?.pdfViewer)';
async function selectScale(value) {
    // Both toolbars use this control. Its change handler also updates Overleaf's retained
    // scale and saved state, which direct PDFViewer.currentScale writes would bypass.
    return evaluate(`(() => {
        const control = document.getElementById('scaleSelect');
        const value = ${JSON.stringify(String(value))};
        if (!(control instanceof HTMLSelectElement) || control.disabled ||
            ![...control.options].some(option => option.value === value && !option.disabled)) {
            throw new Error('Unavailable zoom preset: ' + value);
        }
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
        const v = ${viewer};
        if (String(v.currentScaleValue) !== value) { throw new Error('The zoom control did not apply ' + value); }
        return { value: v.currentScaleValue, scale: v.currentScale };
    })()`);
}
async function ready(extra = 'true') {
    return evaluate(`new Promise((resolve, reject) => {
        const start = performance.now();
        function check() {
            const v = ${viewer};
            if (v?.pagesCount && v.getPageView(v.currentPageNumber - 1)?.renderingState === 3 && (${extra})) {
                resolve(true);
            } else if (performance.now() - start > 30000) {
                reject(new Error('viewer readiness timeout'));
            } else {
                requestAnimationFrame(check);
            }
        }
        check();
    })`);
}
async function frames(milliseconds) {
    return evaluate(`new Promise(resolve => {
        const start = performance.now();
        function step() {
            if (performance.now() - start >= ${milliseconds}) { resolve(true); }
            else { requestAnimationFrame(step); }
        }
        requestAnimationFrame(step);
    })`);
}
async function trajectory(pagesPerSecond, seconds) {
    return evaluate(`new Promise(resolve => {
        const v = ${viewer}, c = v.container, start = performance.now(), initial = c.scrollTop;
        const pageHeight = v.getPageView(v.currentPageNumber - 1).div.getBoundingClientRect().height;
        const samples = [];
        let prior = start, blankMs = 0, totalMs = 0, maxBlank = 0, runBlank = 0;
        function tick(t) {
            const dt = t - prior;
            prior = t;
            const elapsed = Math.min(${seconds} * 1000, t - start);
            c.scrollTop = initial + elapsed / 1000 * pageHeight * ${pagesPerSecond};
            v.update();
            const visible = v._getVisiblePages().views;
            const missing = visible.filter(({ view }) => view.renderingState !== 3 &&
                !view.div.querySelector(':scope > .pdfPrefetchPreview')).map(entry => entry.id);
            if (missing.length) {
                blankMs += dt;
                runBlank += dt;
                maxBlank = Math.max(maxBlank, runBlank);
            } else {
                runBlank = 0;
            }
            totalMs += dt;
            const p = window.pdfPrefetch?.snapshot();
            const canvasBytes = [...v.getCachedPageViews()].reduce((sum, view) =>
                sum + (view.canvas?.width || 0) * (view.canvas?.height || 0) * 4, 0);
            samples.push({
                dt, missing: missing.length, preview: p?.previewBytes ?? 0, canvas: canvasBytes,
                pending: p?.pending.length ?? 0, lead: p?.preloadPx ?? 0, margin: p?.safetySeconds ?? null,
            });
            if (elapsed >= ${seconds} * 1000) {
                const times = samples.map(sample => sample.dt).sort((a, b) => a - b);
                resolve({
                    pagesPerSecond: ${pagesPerSecond}, seconds: ${seconds}, page: v.currentPageNumber,
                    frames: samples.length, blankPercent: 100 * blankMs / totalMs, maxBlankMs: maxBlank,
                    p95FrameMs: times[Math.floor(times.length * .95)], maxFrameMs: times.at(-1),
                    maxPreviewBytes: Math.max(...samples.map(sample => sample.preview)),
                    maxCanvasBytes: Math.max(...samples.map(sample => sample.canvas)),
                    maxPending: Math.max(...samples.map(sample => sample.pending)),
                    maxLeadPx: Math.max(...samples.map(sample => sample.lead)),
                });
            } else {
                requestAnimationFrame(tick);
            }
        }
        requestAnimationFrame(tick);
    })`);
}
async function lifecycle(enabled) {
    await selectScale('2');
    await evaluate(`${viewer}.currentPageNumber = 70; true`);
    await ready();
    const zoom = await evaluate(`(() => {
        const v = ${viewer};
        return { page: v.currentPageNumber, scale: v.currentScale };
    })()`);
    await evaluate(`window.__beforeDoc = ${viewer}.pdfDocument;
        window.__beforePrefetch = window.pdfPrefetch;
        harness.load('b'); true`);
    await ready(`${viewer}.pdfDocument !== window.__beforeDoc`);
    const replaced = await evaluate(`(() => {
        const v = ${viewer};
        const result = {
            page: v.currentPageNumber, scale: v.currentScale, pages: v.pagesCount,
            errors: window.__prefetchProbeErrors ?? [],
            controllerPreserved: !!window.__beforePrefetch && window.pdfPrefetch === window.__beforePrefetch,
        };
        delete window.__beforeDoc;
        delete window.__beforePrefetch;
        return result;
    })()`);
    return {
        zoom,
        replaced: { page: replaced.page, scale: replaced.scale, pages: replaced.pages },
        scalePreserved: Math.abs(replaced.scale - zoom.scale) < 1e-9,
        ...(enabled ? { controllerPreserved: replaced.controllerPreserved } : {}),
        errors: replaced.errors,
    };
}

try {
    if (cdpEndpoint && arg('headless') === 'yes') {
        throw new Error('Choose --cdp or --headless yes, not both');
    }
    if (cdpEndpoint) {
        let endpoint = new URL(cdpEndpoint);
        if (['http:', 'https:'].includes(endpoint.protocol)) {
            const response = await fetch(new URL('/json/version', endpoint));
            if (!response.ok) { throw new Error('CDP browser discovery failed: HTTP ' + response.status); }
            endpoint = new URL((await response.json()).webSocketDebuggerUrl);
        }
        if (!['ws:', 'wss:'].includes(endpoint.protocol)) { throw new Error('Expected an HTTP or WebSocket CDP browser endpoint'); }
        browser = await connect(endpoint.href);
        // The context belongs to this probe; disconnecting also removes it after a signal exit.
        ({ browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: true }));
        ({ targetId } = await browser.send('Target.createTarget', {
            url: 'about:blank', background: true, browserContextId,
        }));
        page = await browser.attach(targetId);
        sessionId = page.sessionId;
        await cdp('Runtime.enable');
        await cdp('Page.enable');
        console.log(JSON.stringify({ connection: 'existing-cdp', targetId, sessionId, browserContextId }));
    } else if (arg('headless') === 'yes') {
        chrome = await launchChrome({ dir: work, width: 1200, height: 900 });
        page = chrome.page;
        await cdp('Runtime.enable');
        await cdp('Page.enable');
    } else {
        const status = await request('/status');
        if (!status.connected) { throw new Error('The existing browser daemon is not connected'); }
        const created = await request('/cdp', {
            method: 'Target.createTarget', params: { url: 'about:blank', background: true },
        });
        targetId = (created.result ?? created).targetId;
        ({ sessionId } = await request('/attach', { targetId }));
        const prepared = await request('/prepare', { sessionId, readiness: 'animation', timeout_seconds: 20 });
        console.log(JSON.stringify({ targetId, sessionId, prepared }));
    }
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__prefetchProbeErrors = [];
            addEventListener('error', event => window.__prefetchProbeErrors.push(event.message));
            addEventListener('unhandledrejection', event => window.__prefetchProbeErrors.push(String(event.reason)));`,
    });
    async function runSuite() {
        results.length = 0;
        const bookDir = book('prefetch-book', 120, 1024);
        for (const engine of ['pdfjs', 'overleaf']) {
            for (const enabled of [false, true]) {
                const before = await powerSnapshot();
                let result = { engine, enabled, latency };
                try {
                    if (server) {
                        await cdp('Page.navigate', { url: 'about:blank' });
                        await server.stop();
                    }
                    server = await startServer({ name: 'prefetch', port, bookDir, latency });
                    await cdp('Page.navigate', {
                        url: `${server.origin}/page?engine=${engine}&doc=prefetch-${engine}-${enabled}-${Date.now()}`,
                    });
                    await ready();
                    if (!enabled) { await evaluate('window.pdfPrefetch.dispose(); window.pdfPrefetch = undefined; true'); }
                    await selectScale('page-width');
                    await evaluate(`${viewer}.currentPageNumber = 12; true`);
                    await ready();
                    const cadence = await evaluate(`new Promise(resolve => {
                        const times = [];
                        let previous = performance.now();
                        function next(t) {
                            times.push(t - previous);
                            previous = t;
                            if (times.length === 12) { resolve(times); }
                            else { requestAnimationFrame(next); }
                        }
                        requestAnimationFrame(next);
                    })`);
                    if (cadence.slice(1).some(ms => ms > 250)) {
                        throw new Error('The test renderer is throttled; use --headless yes or an existing unthrottled browser with --cdp. Cadence: ' + JSON.stringify(cadence));
                    }
                    await frames(1200);
                    const phases = [];
                    for (const speed of [3, 10, -7]) { phases.push(await trajectory(speed, 3)); }
                    await ready();
                    const checks = await lifecycle(enabled);
                    const traffic = await (await fetch(server.origin + '/stats')).json();
                    result = { ...result, phases, checks, traffic };
                    if (enabled && !checks.controllerPreserved) {
                        throw new Error('The prefetch controller changed during build replacement');
                    }
                } catch (error) {
                    result.error = String(error);
                    throw error;
                } finally {
                    result.power = { before, after: await powerSnapshot() };
                    results.push(result);
                    console.log(JSON.stringify(result));
                    fs.writeFileSync(path.join(work, 'prefetch-results.json'), JSON.stringify(results, null, 2) + '\n');
                }
            }
        }
        await evaluate('window.pdfPrefetch.toggleDiagnostics(); true');
        await frames(600);
        const shot = await cdp('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(work, 'prefetch-dashboard.png'), Buffer.from(shot.data, 'base64'));
        console.log(JSON.stringify({
            results: path.join(work, 'prefetch-results.json'),
            screenshot: path.join(work, 'prefetch-dashboard.png'),
            targetId, sessionId,
        }));
    }
    await runSuite();
    if (arg('hold') === 'yes') {
        console.log('Holding the owned tab and server. Send run to repeat, a JSON expression for inspection, or done to clean up.');
        const input = readline.createInterface({ input: process.stdin });
        for await (const line of input) {
            if (line.trim() === 'done') { break; }
            if (line.trim() === 'run') { await runSuite(); continue; }
            try {
                const command = JSON.parse(line);
                if (command.expression) { console.log(JSON.stringify({ inspection: await evaluate(command.expression) })); }
                if (command.screenshot) {
                    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
                    fs.writeFileSync(path.join(work, command.screenshot), Buffer.from(shot.data, 'base64'));
                    console.log('Saved ' + command.screenshot);
                }
            } catch (error) { console.error(String(error)); }
        }
        input.close();
    }
} finally {
    if (browser) {
        await page?.detach().catch(error => console.error(error));
        if (browserContextId) {
            await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(error => console.error(error));
        }
        browser.close();
    } else {
        if (sessionId) { await request('/release', { sessionId }).catch(error => console.error(error)); }
        if (targetId) {
            await request('/cdp', { method: 'Target.closeTarget', params: { targetId } }).catch(error => console.error(error));
        }
        if (sessionId) {
            await request('/cdp', { method: 'Target.detachFromTarget', params: { sessionId } }).catch(() => {});
        }
    }
    await chrome?.close();
    await server?.stop();
}
