// One owned background target and server, retained for before/after commands on stdin.
// node loading-layout-runner.mjs --output /absolute/temporary/directory
// Commands: baseline, verify (rebuild and assert), close. JSON captures stay outside Git.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { build } from 'esbuild';
import { bundleOptions } from '../build-pdf-viewer.mjs';
import { startHarness } from './server.mjs';
import { connectDaemon, evaluateHarness } from './scenario-connection.mjs';
import { fileURLToPath } from 'node:url';
import { keepRendering } from './render-capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const index = process.argv.indexOf('--output');
if (index < 0 || !path.isAbsolute(process.argv[index + 1] ?? '')) throw new Error('--output requires an absolute temporary directory');
const output = process.argv[index + 1];
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'builds.json'), '{}');
await fs.copyFile(path.join(here, 'loading-layout.html'), path.join(output, 'loading-layout.html'));
async function bundle() {
    await fs.copyFile(path.join(here, 'loading-layout.html'), path.join(output, 'loading-layout.html'));
    await build({ ...bundleOptions, entryPoints: [path.join(here, 'loading-layout-fixture.ts')], outfile: path.join(output, 'loading-layout.js') });
}
let server, browser, target, targetId, rendering;
const summaries = [];
async function measure(name) {
    await bundle();
    await target.send('Page.navigate', { url: server.origin + '/ext/loading-layout.html?run=' + name });
    await target.prepare();
    await rendering?.refresh();
    const results = [];
    for (const width of [1400, 280]) for (const reduced of [false, true]) {
        await target.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
        await target.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
        for (const actorless of [false, true]) for (const long of [false, true]) {
            const capture = await evaluateHarness(target, 'window.loadingLayout.run(' + JSON.stringify({ actorless, long }) + ')', { limitMs: 30000 });
            const visible = capture.samples.filter(s => s.opacity === '1' && s.connected && s.width > 0);
            const sizes = [...new Set(visible.map(s => `${s.width}x${s.height}`))];
            const settled = visible.filter(s => s.phase === 'parked');
            const stableSizes = [...new Set(settled.map(s => `${s.width}x${s.height}`))];
            const item = { width, reduced, actorless, long, samples: capture.samples.length, sizes, stableSizes,
                nodeStable: capture.samples.every(s => s.sameNode && s.connected),
                visibleFrames: visible.length, hiddenFrames: capture.samples.filter(s => s.opacity !== '1').length,
                phases: [...new Set(capture.samples.map(s => s.phase))],
                invariant: visible.length > 0 && sizes.length === 1 && capture.samples.every(s => s.sameNode && s.connected)
                    && (!(actorless || reduced) || capture.samples.every(s => s.opacity === '1')) };
            results.push(item);
            await fs.writeFile(path.join(output, `${name}-${width}-${reduced}-${actorless}-${long}.json`), JSON.stringify(capture));
            console.log(JSON.stringify(item));
        }
    }
    const passed = results.every(r => r.invariant);
    if (name === 'verify') process.exitCode = passed ? 0 : 1;
    await fs.writeFile(path.join(output, name + '-summary.json'), JSON.stringify({ passed, results }, null, 2));
    summaries.push({ name, passed });
    console.log(JSON.stringify({ name, passed, path: path.join(output, name + '-summary.json') }));
}
try {
    server = await startHarness({ port: 0, book: output, ext: output, cache: path.join(output, 'cache') });
    browser = await connectDaemon('http://127.0.0.1:7799', { limitMs: 30000 });
    ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank', background: true }));
    target = await browser.attach(targetId);
    await target.prepare();
    rendering = await keepRendering(target);
    await fs.writeFile(path.join(output, 'owner.json'), JSON.stringify({ pid: process.pid, targetId, sessionId: target.sessionId, origin: server.origin }));
    console.log(JSON.stringify({ ready: true, pid: process.pid, targetId, sessionId: target.sessionId, origin: server.origin, output }));
    const input = readline.createInterface({ input: process.stdin });
    for await (const command of input) {
        if (command === 'close') { input.close(); break; }
        if (!['baseline', 'verify'].includes(command)) { console.log('Use baseline, verify or close'); continue; }
        try { await measure(command); } catch (error) { console.error(error); }
    }
} finally {
    const failures = [];
    try { await rendering?.close(); } catch (error) { failures.push(error); }
    try { await target?.detach(); } catch (error) { failures.push(error); }
    try { if (targetId) await browser.send('Target.closeTarget', { targetId }); } catch (error) { failures.push(error); }
    browser?.close();
    try { await server?.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Loading fixture cleanup failed');
    console.log(JSON.stringify({ closed: true, summaries }));
}
