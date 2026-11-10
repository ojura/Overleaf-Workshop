// Drive the existing owned daemon session; this neither attaches nor opens a browser/server.
// node native-image-runner.mjs /absolute/owned/output baseline|verify
import fs from 'node:fs/promises';
import path from 'node:path';
const output = process.argv[2], label = process.argv[3] ?? 'baseline';
if (!path.isAbsolute(output ?? '') || !['baseline', 'verify'].includes(label)) throw new Error('Use an absolute owned output directory and baseline|verify');
const owner = JSON.parse(await fs.readFile(path.join(output, 'owner.json'), 'utf8'));
async function request(route, body) {
    const response = await fetch('http://127.0.0.1:7799' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(32000) });
    const result = await response.json();
    if (!response.ok || result.error || result.exceptionDetails) throw new Error(JSON.stringify(result));
    return result;
}
const cdp = (method, params = {}) => request('/cdp', { sessionId: owner.sessionId, method, params });
const evaluate = async expression => (await request('/eval', { sessionId: owner.sessionId, expression,
    awaitPromise: true, timeout_seconds: 28 })).result.value;
const release = (id, tail = false) => evaluate(`window.nativeImages.release(${JSON.stringify(id)},${tail})`);
const save = async name => {
    const value = await evaluate('window.nativeImages.snapshot()');
    await fs.writeFile(path.join(output, `native-${label}-${name}.json`), JSON.stringify(value));
    return value;
};
export function deliveryChecks(normal) {
    const failures = [], owners = new Map();
    let early = false, protectedDelivery = false, deposited = false;
    for (const sample of normal.samples) {
        for (const page of sample.robots?.pages ?? []) for (const payload of page.payloads ?? []) {
            if (payload.cropKind !== 'image') continue;
            const id = payload.imageId;
            const identity = JSON.stringify([payload.id, payload.operation?.key, payload.operation?.memberIds, payload.target, payload.deadline]);
            const prior = owners.get(id);
            const helpers = payload.helpers ?? [];
            const emptyReturn = payload.deposited === true && payload.stage === 'return'
                && payload.rasterWidth === 0 && payload.rasterHeight === 0 && payload.arrivalCovered === false;
            if (prior && (prior.identity !== identity || (emptyReturn
                ? !prior.helpers.every(member => helpers.includes(member))
                : JSON.stringify(prior.helpers) !== JSON.stringify(helpers)))) {
                failures.push({ branch: 'delivery', photo: id, failure: 'Selected photo ownership changed during its delivery' });
            }
            if (!prior) owners.set(id, { identity, helpers: [...helpers] });
            protectedDelivery ||= payload.arrivalCovered === true;
            deposited ||= payload.deposited === true;
            const photo = sample.photos?.find(photo => photo.id === id);
            early ||= !!photo?.visiblePhoto && sample.status?.pending > 0 && sample.status?.covered < sample.status?.total;
        }
    }
    if (!owners.size || !protectedDelivery || !deposited) failures.push({ branch: 'delivery', failure: 'Selected photos did not receive protected actual delivery and deposit' });
    if (!early) failures.push({ branch: 'delivery', failure: 'No eligible selected photo started while unrelated resources were still uncovered' });
    const final = normal.latest;
    if (final.robots?.activeActors || final.robots?.activePayloads || final.robots?.activeArrivalCovers || final.robots?.advance.length) failures.push({ branch: 'delivery', failure: 'Normal delivery did not release its owned actors, cargo and covers' });
    return failures;
}
const regressions = [];
const previousReducedMotion = await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches');
try {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await evaluate('window.nativeImages?.close()');
    await cdp('Page.navigate', { url: owner.origin + '/ext/native-image.html?run=' + label });
    await request('/prepare', { sessionId: owner.sessionId, readiness: 'animation' });
    await evaluate("import('/ext/native-image.js')");
    await evaluate("window.nativeImages.open('normal')");
    await evaluate("window.nativeImages.releaseAndPaint('x5')");
    await evaluate("window.nativeImages.releaseAndPaint('x6')");
    await evaluate("window.nativeImages.releaseAndPaint('x7')");
    await release('x5', true); // Current worker prioritizes every first scan before any tail.
    await evaluate('window.nativeImages.frames(3)');
    await release('x8');
    await evaluate('window.nativeImages.waitImages({covered:4,completed:1})');
    for (const id of ['x6', 'x7', 'x8']) await release(id, true);
    await evaluate('window.nativeImages.finishImages()');
    await evaluate('window.nativeImages.settleScene()');
    const normal = await save('normal');
    regressions.push(...deliveryChecks(normal));
    for (const id of normal.latest.photos.map(photo => photo.id)) {
        let appeared = false;
        const lost = normal.samples.some(sample => {
            const photo = sample.photos?.find(photo => photo.id === id);
            if (!photo) return false;
            const loss = appeared && !photo.displayedPhoto;
            appeared ||= photo.displayedPhoto;
            return loss;
        });
        if (lost) regressions.push({ branch: 'normal', photo: id, failure: 'Destination pixels disappeared after first appearance' });
    }
    await evaluate("window.nativeImages.open('failed-covered-paint')");
    for (const id of ['x5', 'x6', 'x7', 'x8']) await release(id);
    await evaluate('window.nativeImages.waitImages({covered:4})');
    const failed = await evaluate('window.nativeImages.failedPaint()');
    await evaluate('window.nativeImages.frames(12)');
    const failedTrace = await save('failed-paint');
    await fs.writeFile(path.join(output, `native-${label}-failed-paint-boundary.json`), JSON.stringify(failed));
    for (const before of failed.before.photos) {
        if (before.visiblePhoto && !failedTrace.latest.photos.find(photo => photo.id === before.id)?.visiblePhoto) {
            regressions.push({ branch: 'failed-paint', photo: before.id, failure: 'Good displayed raster replaced by failed paint' });
        }
    }
    await evaluate("window.nativeImages.open('cancel-restart-scale')");
    for (const id of ['x5', 'x6']) await evaluate(`window.nativeImages.releaseAndPaint('${id}')`);
    const prior = await evaluate('window.nativeImages.capture()');
    const pause = await evaluate('window.nativeImages.pauseResume()');
    const scale = await evaluate('window.nativeImages.scale(1.25)');
    for (const before of prior.photos.filter(photo => photo.visiblePhoto)) {
        if (![pause.stopped, pause.after, scale].every(sample => sample.photos.find(photo => photo.id === before.id)?.visiblePhoto)) {
            regressions.push({ branch: 'cancel-scale', photo: before.id, failure: 'Useful prior pixels lost across cancellation or scale' });
        }
    }
    for (const id of ['x7', 'x8']) await release(id);
    for (const id of ['x5', 'x6', 'x7', 'x8']) await release(id, true);
    await evaluate('window.nativeImages.finishImages()');
    await save('cancel-scale');
    await evaluate("window.nativeImages.open('terminal-resource-failure')");
    await evaluate("window.nativeImages.reject('x7')");
    for (const id of ['x5', 'x6', 'x8']) { await release(id); await release(id, true); }
    await evaluate('window.nativeImages.terminalImages()');
    const terminal = await save('terminal');
    if (terminal.latest.status.pending === 0 && terminal.latest.robots?.advance.length) {
        regressions.push({ branch: 'terminal', failure: 'Loading crew remains parked after all resource work ended' });
    }
    await fs.writeFile(path.join(output, `native-${label}-summary.json`), JSON.stringify({ passed: !regressions.length, regressions }, null, 2));
    console.log(JSON.stringify({ passed: !regressions.length, regressions, output }));
    if (label === 'verify' && regressions.length) process.exitCode = 1;
} finally {
    await evaluate('window.nativeImages?.close()');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: previousReducedMotion ? 'reduce' : 'no-preference' }] });
}
