import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserSource } from './browser-source.mjs';

const source = loadBrowserSource('sustained.js');
const portable = fs.readFileSync(new URL('./payload-observation.mjs', import.meta.url), 'utf8')
  .replace(/^export /gm, '').trim();
const embedded = source.split('  // BEGIN portable payload observer\n')[1].split('  // END portable payload observer')[0]
  .split('\n').map(line => line.startsWith('  ') ? line.slice(2) : line).join('\n').trim();
const token = 'offline-sustained-owner-1234';
const documentConfig = JSON.parse(fs.readFileSync(new URL('./document.example.json', import.meta.url), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let index = 0; index < 64; index++) await Promise.resolve(); };
function target() {
  const listeners = new Map();
  return { addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type, value = {}) { for (const fn of [...listeners.get(type) ?? []]) fn({ type, ...value }); },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); } };
}
async function harness(options = {}) {
  let clock = 0, serial = 0, geometryReads = 0, top = 22500, scaleValue = 'page-width', effectiveScaleDelta = 0;
  const jobs = new Map(), schedule = (callback, ms, frame = false) => { const id = ++serial; jobs.set(id, { at: clock + ms, callback, frame }); return id; };
  const bounds = (x, y, width, height) => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height,
    toJSON() { return { x, y, width, height }; } });
  const children = [];
  const body = { tagName: 'BODY', id: '', isConnected: true, matches: () => !!options.editable,
    appendChild(node) { children.push(node); node.isConnected = true; return node; } };
  const document = Object.assign(target(), { visibilityState: options.hidden ? 'hidden' : 'visible', body, activeElement: body, hasFocus: () => options.hasFocus !== false,
    getElementById: () => null, querySelectorAll: () => [],
    createElement(tag) { return Object.assign(target(), { tagName: tag.toUpperCase(), style: {}, isConnected: false,
      setAttribute() {}, contains(node) { return node === this; },
      remove() { this.isConnected = false; const index = children.indexOf(this); if (index >= 0) children.splice(index, 1); } }); } });
  const canvas = { isConnected: !options.detachedNative, width: 1086, height: 1542,
    getBoundingClientRect() { geometryReads++; return bounds(0, 0, 362, 514); } };
  const preview = { ...canvas, isConnected: true, width: 360, height: 512 };
  const container = { clientTop: 0, clientHeight: 548, clientWidth: 402, scrollHeight: 230000, scrollWidth: 402, scrollLeft: 0,
    get scrollTop() { return top; }, set scrollTop(value) { top = value; viewer.currentPageNumber = Math.min(460, Math.floor(top / 500) + 1); },
    getBoundingClientRect() { geometryReads++; return bounds(0, 0, 402, 548); } };
  const pdf = { numPages: 460 };
  const viewer = { container, pdfDocument: pdf, currentPageNumber: 46, pagesRotation: 0, scrollMode: 0, spreadMode: 0,
    pagesPromise: Promise.resolve(), get currentScaleValue() { return scaleValue; }, set currentScaleValue(value) { scaleValue = value; },
    get currentScale() { return (scaleValue === 'page-width' ? 0.54 : Number(scaleValue)) + effectiveScaleDelta; },
    scrollPageIntoView({ pageNumber }) { container.scrollTop = (pageNumber - 1) * 500; },
    getPageView(page) { return { renderingState: options.detachedNative ? 1 : 3, canvas,
      div: { querySelector: () => options.preview ? preview : null,
        getBoundingClientRect() { geometryReads++; return bounds(0, page * 500 - top, 362, 514); } } }; } };
  const sha = '6abb3d0b13d2970bca0f613287a6ea5d30280be14435b5c681b8ca8bd61d24d0';
  const path = '/spomenar-versions/' + sha + '/book.pdf';
  const app = { pdfViewer: viewer, pdfDocument: pdf, url: 'https://cloud.larics.fer.hr' + path, isInitialViewSet: true,
    pdfSidebar: { visibleView: 0, switchView(value) { this.visibleView = value; } } };
  const prefetch = { robotsEnabled: true, diagnosticsEnabled: false,
    setRobotsEnabled(value) { this.robotsEnabled = value; }, setDiagnosticsEnabled(value) { this.diagnosticsEnabled = value; },
    snapshot() { return { cachePolicy: 'mobile', cacheLimits: { maxPreviewBytes: 8388608 }, previewBytes: 737280, canvasBytes: 6698448,
      previewPages: 1, visible: [viewer.currentPageNumber], visibleMissing: [], pending: [], idle: true,
      performance: { pendingFetchCount: 0, fetchCount: 0, fetchBytes: 0, events: [] },
      rangeCache: { trackedBytes: 131072, imageDecodeActive: options.decodeBusy ? 1 : 0,
        activeOperations: options.decodeBusy ? 3 : 0, imageDecodeQueued: options.decodeBusy ? 2 : 0 }, decodedImages: { pageBytes: 0, sharedBytes: 0 },
      previewSource: { state: 'ready', pending: 0, decoding: 0, queuedDecodes: 0, assetRequests: 1, completed: 1 },
      robots: { presentation: 'compact', maxActors: 4, activeActors: 0, activePayloads: 0, cargoBytes: 0, spriteBytes: 0,
        retainedBytes: 0, maxCargoBytes: 524288, maxSpriteBytes: 204800, pages: [], scheduled: false,
        frames: 0, paintTotalMs: 0, deliveredFragments: 0, refinements: 0, activeArrivalCovers: 0, activeRefinements: 0 } }; } };
  const window = Object.assign(target(), { PDFViewerApplication: app, pdfPrefetch: prefetch, getSelection: () => ({ isCollapsed: !options.selection }) });
  const wake = { requests: 0, releases: 0, types: [] };
  const sentinel = Object.assign(target(), { released: false, type: 'screen',
    release() { wake.releases++; if (options.wakeReleasePending) return new Promise(() => {});
      this.released = true; this.emit('release'); return Promise.resolve(); } });
  const navigator = options.wake === 'unsupported' ? {} : { wakeLock: { request(type) {
    wake.requests++; wake.types.push(type);
    if (options.wake === 'denied') return Promise.reject(Object.assign(new Error('Permission was denied'), { name: 'NotAllowedError' }));
    if (options.wake === 'pending') return new Promise(resolve => { wake.grant = () => resolve(sentinel); });
    return Promise.resolve(sentinel);
  } } };
  const context = { window, document, navigator, isSecureContext: options.secure !== false,
    URL, AbortController, Uint8Array, TextDecoder, performance: { now: () => clock },
    location: { href: 'https://cloud.larics.fer.hr/spomenar/', origin: 'https://cloud.larics.fer.hr' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout: (callback, ms) => schedule(callback, ms), clearTimeout: id => jobs.delete(id),
    requestAnimationFrame: callback => schedule(callback, 16, true), cancelAnimationFrame: id => jobs.delete(id),
    fetch: async url => {
      if (options.metadataError) throw new Error('offline metadata failure');
      const value = url.pathname.endsWith('config.json') ? { pdfUrl: path, previews: { sha256: sha, size: 1608358464, manifestUrl: '/atlas.json' } }
        : { document: { sha256: sha, size: 1608358464, pageCount: 460, key: 'sha256:' + sha } };
      let read = false;
      return { ok: true, redirected: false, body: { getReader() { return {
        async read() { if (read) return { done: true }; read = true; return { done: false, value: new TextEncoder().encode(JSON.stringify(value)) }; },
        async cancel() {}, releaseLock() {},
      }; } } };
    } };
  const start = vm.runInNewContext(source, context);
  assert.equal(window.__spomenarSustainedProbe, undefined, 'loading the expression is inert');
  const ack = await start({ token, workloadMs: options.workloadMs ?? 600000, leaseMs: 20000,
    document: options.document ?? documentConfig, scenario: options.scenario,
    startMode: options.startMode, startWaitMs: options.startWaitMs }); await flush();
  const api = window.__spomenarSustainedProbe;
  let lastHeartbeat = 0;
  const step = async () => {
    const item = [...jobs].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!item) return false; jobs.delete(item[0]); clock = item[1].at;
    if (options.autoHeartbeat && clock - lastHeartbeat >= 5000) { api.heartbeat(token); lastHeartbeat = clock; }
    item[1].callback(item[1].frame ? clock : undefined); await flush(); return true;
  };
  return { api, ack, app, viewer, container, document, window, jobs, wake, sentinel, children,
    geometryReads: () => geometryReads, clock: () => clock,
    setEffectiveScaleDelta(value) { effectiveScaleDelta = value; },
    suspend(ms) { clock += ms; for (const job of jobs.values()) job.at += ms; },
    async until(predicate, limit = 60000) { for (let n = 0; !predicate() && clock <= limit && n < 100000; n++) if (!await step()) break; assert.ok(predicate()); },
    async advance(until) { while ([...jobs.values()].some(job => job.at <= until)) await step(); clock = until; await flush(); },
    withholdFrame() { for (const [id, job] of jobs) if (job.frame) jobs.delete(id); },
    listeners: () => window.listenerCount() + document.listenerCount() + sentinel.listenerCount()
      + children.reduce((sum, node) => sum + node.listenerCount(), 0) };
}

test('the reused observer is exact and the stage plan contains 600 seconds of motion', () => {
  assert.equal(embedded, portable);
  const start = source.indexOf('  function makePlan');
  const code = source.slice(start, source.indexOf('  const displayed', start));
  const plan = vm.runInNewContext(code + '\nmakePlan(600000)');
  assert.equal(plan.length, 12);
  assert.equal(plan.flatMap(stage => stage.legs).reduce((sum, leg) => sum + leg.durationMs, 0), 600000);
  assert.equal(plan.reduce((sum, stage) => sum + stage.dwellMs, 0), 12000);
  assert.deepEqual([...new Set(plan.map(stage => stage.zoom))], ['page-width', 0.5, 0.8, 1.6]);
  assert.ok(plan.flatMap(stage => stage.legs).some(leg => leg.page === 455));
});

test('token checks and status/result reads do not renew the lease; expiry restores and removes observers', async () => {
  const h = await harness(); await h.until(() => h.api.status(token).scrollMs > 0, 10000);
  const started = h.clock(); await h.advance(started + 1000);
  const before = h.api.status(token).leaseRemainingMs, reads = h.geometryReads();
  assert.equal(h.api.heartbeat('wrong').ok, false); assert.equal(h.api.stop('wrong').ok, false);
  h.api.status(token); h.api.result(token); assert.equal(h.geometryReads(), reads);
  await h.advance(started + 2000); assert.equal(h.api.status(token).leaseRemainingMs, before - 1000);
  assert.ok(h.api.status(token).scrollMs > 1000, 'progress advances within a long leg');
  await h.until(() => h.api.status(token).finished, 35000);
  const result = h.api.result(token);
  assert.equal(result.interruption, 'host-lease-expired'); assert.equal(result.state, 'interrupted');
  assert.equal(result.restorationExact, true); assert.equal(result.observersRemoved, true);
  assert.equal(h.viewer.currentPageNumber, 46); assert.equal(h.container.scrollTop, 22500);
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('normal completion preserves all stage aggregates and disposes only its own terminal token', async () => {
  const h = await harness({ autoHeartbeat: true }); await h.until(() => h.api.status(token).finished, 650000);
  const result = h.api.result(token);
  assert.equal(result.state, 'completed'); assert.equal(result.restorationExact, true);
  assert.equal(h.wake.requests, 1); assert.deepEqual(h.wake.types, ['screen']); assert.equal(h.wake.releases, 1);
  assert.equal(result.wakeLock.granted, true); assert.equal(result.wakeLock.released, true); assert.equal(result.wakeLock.state, 'released');
  assert.ok(result.wakeLock.grantedAt <= result.workloadStartedAt);
  assert.equal(result.stages.length, 12); assert.ok(result.scrollMs >= 600000); assert.equal(result.dwellMs, 12000);
  assert.ok(result.sampleCount > 1200); assert.equal(result.samples.length, 240);
  assert.ok(result.stages[0].sampleCount > 0 && result.stages[0].startedAt < result.samples[0].at,
    'early stage aggregates survive raw-sample rollover');
  assert.ok(result.stages.every(stage => stage.frames.frames > 0 && stage.endedAt <= result.workloadEndedAt));
  assert.ok(result.sampleCostMs >= 0); assert.equal(result.idle.framesAdded, 0);
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
  assert.equal(h.api.dispose('wrong').ok, false); assert.ok(h.window.__spomenarSustainedProbe);
  assert.equal(h.api.dispose(token).disposed, true); assert.equal(h.window.__spomenarSustainedProbe, undefined);
  assert.equal(h.wake.releases, 1, 'terminal disposal does not release the same sentinel twice');
});

test('trusted input stops without overwriting the user position', async () => {
  const h = await harness(); await h.until(() => h.api.status(token).scrollMs > 0, 10000);
  h.container.scrollTop = 12345; h.document.emit('pointerdown', { isTrusted: true }); await flush();
  await h.until(() => h.api.status(token).finished);
  const result = h.api.result(token); assert.equal(result.state, 'interrupted');
  assert.equal(result.restorationSkipped, 'trusted-input'); assert.equal(h.container.scrollTop, 12345);
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('hidden state restores, while document replacement never receives the old position', async () => {
  for (const replace of [false, true]) {
    const h = await harness(); await h.until(() => h.api.status(token).scrollMs > 0, 10000);
    if (replace) { h.app.pdfDocument = { numPages: 460 }; h.container.scrollTop = 7777; }
    else { h.document.visibilityState = 'hidden'; h.document.emit('visibilitychange'); }
    await h.until(() => h.api.status(token).finished);
    const result = h.api.result(token); assert.equal(result.state, 'interrupted');
    if (replace) { assert.equal(result.restorationSkipped, 'document-changed'); assert.equal(h.container.scrollTop, 7777); }
    else assert.equal(result.restorationExact, true);
    assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
  }
});

test('an initialization error cleans up without a reader mutation', async () => {
  const h = await harness({ metadataError: true }); await h.until(() => h.api.status(token).finished);
  assert.equal(h.api.result(token).state, 'failed'); assert.match(h.api.result(token).failure, /metadata failure/);
  assert.equal(h.container.scrollTop, 22500); assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('a withheld frame after scrolling restores the reader on workload failure', async () => {
  const h = await harness(); await h.until(() => h.api.status(token).scrollMs > 0, 10000);
  h.withholdFrame(); await h.until(() => h.api.status(token).finished, 15000);
  const result = h.api.result(token); assert.equal(result.state, 'failed');
  assert.match(result.failure, /No animation frame/); assert.equal(result.restorationExact, true);
  assert.equal(h.container.scrollTop, 22500); assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('the same named zoom cannot pass restoration with a different effective scale', async () => {
  const h = await harness(); await h.until(() => h.api.status(token).scrollMs > 0, 10000);
  h.setEffectiveScaleDelta(0.01); h.api.stop(token, 'offline-stop');
  await h.until(() => h.api.status(token).finished, 15000);
  const result = h.api.result(token);
  assert.equal(result.readingState.scaleValue, result.saved.scaleValue);
  assert.notEqual(result.readingState.scale, result.saved.scale);
  assert.equal(result.restorationExact, false); assert.equal(result.state, 'restore-failed');
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('actual sample distinguishes detached allocation from its displayed preview', async () => {
  for (const preview of [false, true]) {
    const h = await harness({ detachedNative: true, preview }); await h.until(() => h.api.status(token).scrollMs > 0, 10000);
    h.api.stop(token, 'offline-stop'); await h.until(() => h.api.status(token).finished);
    const result = h.api.result(token), initial = result.initial;
    assert.equal(initial.canvases[0].native.connected, false);
    assert.ok(result.coverage.detachedNative > 0);
    assert.equal(result.coverage.detachedCovered > 0, preview);
    assert.equal(result.coverage.noUsefulPixels > 0, !preview);
    assert.equal(h.jobs.size, 0);
  }
});

test('unsupported or insecure wake lock fails before any scroll or zoom mutation', async () => {
  for (const options of [{ wake: 'unsupported' }, { secure: false }]) {
    const h = await harness(options); await h.until(() => h.api.status(token).finished, 5000);
    const result = h.api.result(token);
    assert.equal(result.state, 'failed'); assert.equal(result.scrollMs, 0);
    assert.equal(result.wakeLock.granted, false);
    assert.equal(result.wakeLock.state, 'unsupported');
    assert.equal(h.container.scrollTop, 22500); assert.equal(h.viewer.currentScaleValue, 'page-width');
    assert.equal(h.wake.requests, 0); assert.equal(h.wake.releases, 0);
    assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
  }
});

test('native wake-lock denial permits the visible workload while hidden, lease and trusted-input stops remain effective', async () => {
  for (const cause of ['hidden', 'lease', 'input']) {
    const h = await harness({ wake: 'denied', hasFocus: false });
    assert.equal(h.api.status(token).failure, null);
    await h.until(() => h.api.status(token).scrollMs > 0, 10000);
    const lock = h.api.status(token).wakeLock;
    assert.equal(lock.state, 'denied'); assert.equal(lock.granted, false);
    assert.equal(lock.errorName, 'NotAllowedError'); assert.equal(lock.error, 'Permission was denied');
    if (cause === 'hidden') { h.document.visibilityState = 'hidden'; h.document.emit('visibilitychange'); }
    if (cause === 'input') { h.container.scrollTop = 12345; h.document.emit('pointerdown', { isTrusted: true }); }
    await h.until(() => h.api.status(token).finished, 35000);
    const result = h.api.result(token);
    assert.equal(result.state, 'interrupted'); assert.ok(result.scrollMs > 0);
    assert.equal(result.wakeLock.state, 'denied'); assert.equal(result.wakeLock.granted, false);
    if (cause === 'input') { assert.equal(result.restorationSkipped, 'trusted-input'); assert.equal(h.container.scrollTop, 12345); }
    else { assert.equal(result.restorationExact, true); assert.equal(h.container.scrollTop, 22500); }
    assert.equal(h.wake.requests, 1); assert.equal(h.wake.releases, 0);
    assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
  }
});

test('a wake lock granted after stop or acquisition timeout is released even after terminal disposal', async () => {
  for (const cause of ['stop', 'timeout']) {
    const h = await harness({ wake: 'pending' }); assert.equal(h.wake.requests, 1);
    assert.equal(h.api.status(token).wakeLock.state, 'requesting');
    if (cause === 'stop') h.api.stop(token, 'offline-stop');
    await h.until(() => h.api.status(token).finished, 5000);
    const result = h.api.result(token); assert.equal(result.scrollMs, 0);
    assert.equal(result.state, cause === 'stop' ? 'interrupted' : 'failed');
    if (cause === 'timeout') assert.equal(result.wakeLock.state, 'timed-out');
    assert.equal(h.api.dispose(token).disposed, true); assert.equal(h.window.__spomenarSustainedProbe, undefined);
    h.wake.grant(); await flush();
    assert.equal(h.wake.releases, 1); assert.equal(h.sentinel.released, true);
    assert.equal(result.wakeLock.lateGrant, true); assert.equal(result.wakeLock.releaseReason, 'late-grant');
    assert.equal(result.wakeLock.state, 'released');
    assert.equal(h.container.scrollTop, 22500); assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
  }
});

test('browser wake-lock release stops and restores without reacquiring', async () => {
  const h = await harness(); await h.until(() => h.api.status(token).scrollMs > 0, 10000);
  h.sentinel.released = true; h.sentinel.emit('release'); await flush();
  await h.until(() => h.api.status(token).finished, 15000);
  const result = h.api.result(token);
  assert.equal(result.interruption, 'wake-lock-released'); assert.equal(result.restorationExact, true);
  assert.equal(result.wakeLock.released, true); assert.equal(h.wake.requests, 1); assert.equal(h.wake.releases, 0);
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('wake-lock release acknowledgement is bounded and reported separately from reader restoration', async () => {
  const h = await harness({ wakeReleasePending: true }); await h.until(() => h.api.status(token).scrollMs > 0, 10000);
  h.api.stop(token, 'offline-stop'); await h.until(() => h.api.status(token).finished, 15000);
  const result = h.api.result(token);
  assert.equal(result.restorationExact, true); assert.equal(result.state, 'restore-failed');
  assert.equal(result.wakeLock.state, 'release-failed'); assert.match(result.wakeLock.releaseError, /timed out/);
  assert.equal(h.wake.releases, 1); assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('admits a visible noneditable reader when hasFocus is false', async () => {
  const h = await harness({ hasFocus: false });
  assert.equal(h.api.status(token).failure, null);
  await h.until(() => h.api.status(token).scrollMs > 0, 10000);
  assert.equal(h.api.status(token).wakeLock.state, 'held');
  h.api.stop(token, 'offline-stop'); await h.until(() => h.api.status(token).finished);
  const result = h.api.result(token);
  assert.equal(result.savedFocus.hasFocus, false); assert.equal(result.restorationExact, true);
  assert.equal(h.wake.requests, 1); assert.equal(h.wake.releases, 1);
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('hidden, selected and editable readers still stop before wake-lock acquisition or movement', async () => {
  for (const options of [{ hidden: true }, { selection: true }, { editable: true }]) {
    const h = await harness(options); await h.until(() => h.api.status(token).finished, 5000);
    const result = h.api.result(token);
    assert.notEqual(result.state, 'completed'); assert.equal(result.scrollMs, 0);
    assert.equal(h.wake.requests, 0); assert.equal(h.container.scrollTop, 22500);
    assert.equal(h.viewer.currentScaleValue, 'page-width'); assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
  }
});

test('heartbeat exports full-span cached checkpoints without geometry reads or mutable aliases', async () => {
  const h = await harness(); await h.until(() => h.api.status(token).scrollMs > 1000, 10000);
  const reads = h.geometryReads(), first = h.api.heartbeat(token).clientCheckpoint;
  assert.ok(first, 'a heartbeat retains the client evidence when a later result RPC fails');
  assert.ok(first.frames.frames > 0 && first.coverage.pageObservations > 0);
  assert.equal(first.sampleCount, h.api.status(token).sampleCount);
  assert.equal(first.at, h.api.status(token).latestAt);
  assert.equal(first.current.page, h.api.status(token).page);
  assert.ok(first.peaks.previewBytes > 0 && first.rawPeaks.trackedBytes > 0);
  assert.equal(first.current.robots.pages, undefined, 'checkpoints contain no payload or actor rings');
  first.frames.frames = -1; first.peaks.previewBytes = -1;
  assert.ok(h.api.heartbeat(token).clientCheckpoint.frames.frames > 0);
  assert.ok(h.api.status(token).clientCheckpoint.peaks.previewBytes > 0);
  assert.equal(h.geometryReads(), reads);
  h.api.stop(token, 'offline-stop'); await h.until(() => h.api.status(token).finished);
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('tap mode acknowledges an armed owner and acquires wake lock synchronously only on the real Start tap', async () => {
  const h = await harness({ startMode: 'tap', startWaitMs: 60000 });
  assert.equal(h.ack.state, 'armed'); assert.equal(h.wake.requests, 0);
  assert.equal(h.container.scrollTop, 22500); assert.equal(h.children.length, 1);
  const button = h.children[0]; button.emit('click', { isTrusted: false, target: button }); await flush();
  assert.equal(h.wake.requests, 0); assert.equal(h.api.status(token).state, 'armed');
  h.document.emit('touchstart', { isTrusted: true, target: button });
  button.emit('click', { isTrusted: true, target: button });
  assert.equal(h.wake.requests, 1, 'wake request runs in the trusted event turn');
  assert.equal(h.children.length, 0); assert.equal(button.listenerCount(), 0);
  await h.until(() => h.api.status(token).scrollMs > 0, 10000);
  assert.equal(h.api.status(token).wakeLock.granted, true);
  assert.equal(h.api.status(token).interruption, null);
  h.api.stop(token, 'offline-stop'); await h.until(() => h.api.status(token).finished);
  const result = h.api.result(token);
  assert.equal(result.startMode, 'tap'); assert.ok(result.armedAt <= result.activationAt);
  assert.ok(result.activationAt <= result.workloadStartedAt);
  assert.equal(h.wake.releases, 1); assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('tap mode requires a wake-lock grant, while its armed cancellation paths remove the Start control', async () => {
  for (const reason of ['denied', 'lease', 'hidden', 'dispose', 'wait-timeout', 'input']) {
    const h = await harness({ startMode: 'tap', startWaitMs: reason === 'wait-timeout' ? 1000 : 60000,
      wake: reason === 'denied' ? 'denied' : undefined });
    assert.equal(h.api.status(token).state, 'armed');
    const button = h.children[0];
    if (reason === 'denied') button.emit('click', { isTrusted: true, target: button });
    if (reason === 'hidden') { h.document.visibilityState = 'hidden'; h.document.emit('visibilitychange'); }
    if (reason === 'input') h.document.emit('pointerdown', { isTrusted: true, target: h.document.body });
    if (reason === 'dispose') assert.equal(h.api.dispose(token).ok, true);
    await h.until(() => h.api.status(token).finished, 25000);
    const result = h.api.result(token);
    assert.equal(result.scrollMs, 0); assert.notEqual(result.state, 'completed');
    assert.equal(h.container.scrollTop, 22500); assert.equal(h.children.length, 0);
    assert.equal(button.listenerCount(), 0); assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
    if (reason === 'denied') { assert.equal(result.wakeLock.state, 'denied'); assert.equal(h.wake.requests, 1); }
    else assert.equal(h.wake.requests, 0);
    if (reason === 'dispose') assert.equal(h.window.__spomenarSustainedProbe, undefined);
  }
});

test('a completed run certifies displayed awake restoration even when hasFocus is false', async () => {
  const h = await harness({ hasFocus: false, autoHeartbeat: true, workloadMs: 1000 });
  await h.until(() => h.api.status(token).finished, 30000);
  const result = h.api.result(token);
  assert.equal(result.state, 'completed'); assert.equal(result.restorationExact, true);
  assert.equal(result.restoredViewport.visible, true); assert.equal(result.restoredViewport.focused, false);
  assert.equal(result.restoredViewport.displayed, true); assert.equal(result.idle.awake, true);
  assert.ok(result.idle.observedMs >= 1500); assert.ok(result.idle.maxGapMs <= 100);
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('hidden interruption retains exact coordinates without calling suspended wall time awake idle', async () => {
  const h = await harness(); await h.until(() => h.api.status(token).scrollMs > 0, 10000);
  const visibleObservations = h.api.status(token).clientCheckpoint.coverage.pageObservations;
  h.document.visibilityState = 'hidden'; h.document.emit('visibilitychange');
  await h.until(() => h.api.status(token).finished, 15000);
  const result = h.api.result(token);
  assert.equal(result.state, 'interrupted'); assert.equal(result.restorationExact, true);
  assert.equal(result.restoredViewport.visible, false); assert.equal(result.idle.awake, false);
  assert.equal(result.restoredViewport.displayed, false);
  assert.equal(result.final.documentVisible, false);
  assert.equal(result.coverage.pageObservations, visibleObservations, 'hidden DOM allocation is not visible coverage');
  assert.equal(result.idle.observedMs, 0); assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('restoration with missing pixels or pending native decode cannot pass an awake idle check', async () => {
  for (const options of [{ detachedNative: true }, { decodeBusy: true }]) {
    const h = await harness({ ...options, autoHeartbeat: true, workloadMs: 1000 });
    await h.until(() => h.api.status(token).finished, 35000);
    const result = h.api.result(token);
    assert.equal(result.state, 'restore-failed'); assert.equal(result.restorationExact, true);
    assert.equal(result.idle.awake, false); assert.ok(result.cleanupErrors.some(item => /awake|displayed/i.test(item)));
    assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
  }
});

test('a delayed restoration frame must earn a fresh continuous idle interval after resumption', async () => {
  const h = await harness({ autoHeartbeat: true, workloadMs: 1000 });
  await h.until(() => h.api.status(token).phase === 'restoring', 20000);
  await h.advance(h.clock() + 100); h.suspend(5000);
  await h.until(() => h.api.status(token).finished, 35000);
  const result = h.api.result(token);
  assert.equal(result.state, 'completed'); assert.equal(result.idle.awake, true);
  assert.ok(result.idle.maxGapMs >= 5000); assert.ok(result.idle.observedMs >= 1500);
  assert.ok(result.idle.durationMs >= 6500, 'the five suspended seconds do not satisfy the observed interval');
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});

test('the named traverse scenario retains both historical passes and real robot-on/off idle phases', async () => {
  const h = await harness({ scenario: 'traverse', autoHeartbeat: true });
  await h.until(() => h.api.status(token).state === 'running', 5000);
  assert.equal(h.viewer.currentPageNumber, 60, 'this is the preserved short route, not a shortened endurance route');
  await h.until(() => h.api.status(token).finished, 60000);
  const result = h.api.result(token);
  assert.equal(result.state, 'completed'); assert.equal(result.requestedScrollMs, 11000);
  assert.equal(result.stages.length, 2);
  for (const stage of result.stages) {
    assert.deepEqual(Array.from(stage.legs, leg => leg.page), [90, 65]);
    assert.deepEqual(Array.from(stage.legs, leg => leg.plannedMs), [3000, 2500]);
    assert.equal(stage.start, 60); assert.equal(stage.settled, true); assert.ok(stage.settleMs <= 8000);
  }
  assert.deepEqual(Array.from(result.naturalIdle, part => part.robots), [true, false]);
  assert.ok(result.naturalIdle[0].durationMs >= 8000 && result.naturalIdle[1].durationMs >= 4000);
  assert.ok(result.naturalIdle.every(part => part.quiet && part.framesAdded === 0 && part.frames.frames > 0));
  assert.equal(result.restorationExact, true); assert.equal(result.readingState.robots, true);
  assert.equal(h.jobs.size, 0); assert.equal(h.listeners(), 0);
});
