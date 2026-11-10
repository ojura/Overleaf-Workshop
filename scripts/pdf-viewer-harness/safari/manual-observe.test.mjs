import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserSource } from './browser-source.mjs';

const source = loadBrowserSource('manual-observe.js');
const documentConfig = JSON.parse(fs.readFileSync(new URL('./document.example.json', import.meta.url), 'utf8'));
const token = 'offline-manual-owner-1234';
function target() {
  const listeners = new Map();
  return { addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type, event = {}) { for (const fn of [...listeners.get(type) ?? []]) fn({ type, ...event }); },
    count() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0); } };
}
function harness(options = {}) {
  let clock = 0, serial = 0, reads = 0;
  const jobs = new Map(), values = { page: 46, top: 22500, scale: 0.54, selection: true, rawBytes: 131072 };
  const box = () => { reads++; return { x: 0, y: 0, width: 362, height: 514 }; };
  const canvas = { isConnected: true, width: 1086, height: 1542, getBoundingClientRect: box };
  const document = Object.assign(target(), { visibilityState: 'visible', hasFocus: () => false,
    getElementById: id => id === 'pdf-prefetch-diagnostics' ? panel : null,
    querySelectorAll: selector => selector.startsWith('#toolbarViewer') ? [toolbar]
      : selector.startsWith('#spomenarActions') ? header : [] });
  const toolbar = { id: 'zoomIn', tagName: 'BUTTON', matches: value => value.includes('button'),
    getBoundingClientRect: box };
  const header = ['spomenarShare', 'spomenarDownload', 'pdf-prefetch-toggle', 'pdf-prefetch-measurements'].map((id, index) => ({
    id, tagName: index === 1 ? 'A' : 'BUTTON', getBoundingClientRect() { reads++;
      return { x: 12 + index * 44, y: 8, width: 40, height: 40 }; } }));
  const panel = { hidden: true, dataset: { dock: 'float' }, rect: { x: 12, y: 64, width: 280, height: 220 },
    shadowRoot: { querySelector(selector) {
      if (selector === 'section') return { isConnected: true, getBoundingClientRect() { reads++; return { ...panel.rect }; } };
      if (selector === '.measurements') return { open: false };
      return null;
    } } };
  const container = Object.assign(target(), { getBoundingClientRect:box, get scrollTop() { return values.top; },
    set scrollTop(_value) { throw new Error('Manual mode must not scroll'); }, scrollLeft: 0 });
  // Object.assign evaluates getters, so keep the reader accessor explicit.
  Object.defineProperty(container, 'scrollTop', { get: () => values.top, set: () => { throw new Error('Manual mode must not scroll'); } });
  const pdf = { numPages: 460 };
  const viewer = { pagesCount:460, _getVisiblePages:()=>({views:[{id:values.page}]}), pdfDocument: pdf, container, get currentPageNumber() { return values.page; },
    set currentPageNumber(_value) { throw new Error('Manual mode must not navigate'); },
    get currentScale() { return values.scale; }, currentScaleValue: 'page-width', pagesRotation: 0, scrollMode: 0, spreadMode: 0,
    scrollPageIntoView() { throw new Error('Manual mode must not navigate'); },
    getPageView() { return { canvas, renderingState: 3, div: { isConnected:true, getBoundingClientRect:box, querySelector: () => null, querySelectorAll:()=>[] } }; } };
  const app = { pdfViewer: viewer, pdfDocument: pdf, url: documentConfig.pdfUrl, pdfSidebar: { visibleView: 0 } };
  const prefetch = { robotsEnabled: true, diagnosticsEnabled: false,
    setRobotsEnabled() { throw new Error('Manual mode must not change controls'); },
    setDiagnosticsEnabled() { throw new Error('Manual mode must not change controls'); },
    snapshot() { return { visible: [values.page], visibleMissing: [], pending: [], previewBytes: 737280, canvasBytes: 6698448,
      performance: { pendingFetchCount: 0 }, rangeCache: { residentBytes: values.rawBytes }, decodedImages: { pageBytes: 0 },
      previewSource: { state: 'ready' }, robots: { pages: [], activeActors: 0, cargoBytes: 0, spriteBytes: 0 } }; } };
  const visual = Object.assign(target(), { width: 402, height: 548, scale: 1, offsetLeft: 0, offsetTop: 0 });
  const window = Object.assign(target(), { PDFViewerApplication: app, pdfPrefetch: prefetch, visualViewport: visual,
    getSelection: () => ({ isCollapsed: values.selection, rangeCount: values.selection ? 0 : 1 }) });
  const context = { window, document, performance: { now: () => clock }, URL, innerWidth: 402, innerHeight: 548,
    location: { href: documentConfig.pageUrl }, devicePixelRatio: 3, screen: { orientation: { angle: 0 } },
    getComputedStyle: node => {
      if (options.surfaceFailure && node === container) throw new Error('forced surface capture failure');
      return { display: 'block', visibility: 'visible' };
    },
    setTimeout(callback, ms) { const id = ++serial; jobs.set(id, { at: clock + ms, callback }); return id; },
    clearTimeout(id) { jobs.delete(id); }, requestAnimationFrame(callback) { const id=++serial; jobs.set(id,{at:clock+16,callback});return id; },cancelAnimationFrame(id){jobs.delete(id);},MutationObserver:class {observe(){} takeRecords(){return [];}disconnect(){}}  };
  const start = vm.runInNewContext(source, context);
  assert.equal(typeof start, 'function'); assert.equal(window.__spomenarManualProbe, undefined);
  assert.equal(reads, 0); assert.equal(jobs.size, 0);
  const ack = start({ token, document: options.document ?? documentConfig, durationMs: options.durationMs ?? 30000, leaseMs: 20000 });
  const api = window.__spomenarManualProbe;
  const allListeners = () => document.count() + window.count() + container.count() + visual.count();
  return { api, ack, document, window, app, viewer, container, visual, toolbar, header, panel, values, jobs, reads: () => reads, allListeners,
    advance(until, heartbeat = false) { for (;;) {
      const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      jobs.delete(next[0]); clock = next[1].at;
      if (heartbeat && clock % 5000 === 0) api.heartbeat(token);
      next[1].callback();
    } clock = until; } };
}

test('manual mode records only trusted gestures and leaves the user reading state untouched', () => {
  const h = harness();
  h.document.emit('click', { isTrusted: false, target: h.toolbar });
  assert.deepEqual(Object.keys(h.api.status(token).clientCheckpoint.eventCounts), []);
  for (const type of ['touchstart', 'touchmove', 'gesturechange', 'selectionchange', 'click', 'keydown']) {
    h.document.emit(type, { isTrusted: true, target: h.toolbar, scale: 1.4, touches: [{}, {}], key: 'private typed character' });
  }
  h.window.emit('orientationchange', { isTrusted: true });
  h.visual.scale = 1.4; h.visual.emit('resize', { isTrusted: true });
  h.values.page = 90; h.values.top = 44500; h.values.scale = 0.8; h.values.selection = false;
  h.advance(500); h.api.stop(token);
  const result = h.api.result(token);
  assert.equal(result.mutatedReader, false); assert.equal(result.readingState.page, 90); assert.equal(h.values.top, 44500);
  assert.equal(result.final.viewport.scale, 1.4); assert.equal(result.final.focused, false);
  assert.equal(result.final.selection.collapsed, false); assert.equal(result.eventCounts.click, 1);
  assert.equal(result.eventCounts.orientationchange, 1); assert.equal(result.eventCounts.resize, 1);
  assert.ok(result.events.every(event => event.key === undefined && event.text === undefined));
  assert.equal(result.restorationSkipped, 'manual-observation');
  assert.equal(result.surfaceObservation.stopped, true);
  assert.equal(result.surfaceObservation.errors.length, 0);
  assert.equal(result.surfaceObservation.first.phase, 'observing');
  assert.equal(result.surfaceObservation.last.phase, result.state);
  assert.equal(h.jobs.size, 0); assert.equal(h.allListeners(), 0);
});

test('manual cached heartbeats do not read layout or allow another owner to stop or renew the probe', () => {
  const h = harness(), reads = h.reads(), status = h.api.status(token);
  assert.equal(h.api.heartbeat('wrong').ok, false); assert.equal(h.api.stop('wrong').ok, false); assert.equal(h.api.dispose('wrong').ok, false);
  const checkpoint = h.api.heartbeat(token).clientCheckpoint; checkpoint.peaks.previewBytes = -1;
  assert.equal(checkpoint.peaks.rawBytes, 131072, 'cached raw peak uses the real residentBytes field');
  assert.ok(h.api.status(token).clientCheckpoint.peaks.previewBytes > 0);
  assert.equal(h.reads(), reads); assert.equal(status.finished, false);
  h.values.rawBytes = 262144; h.advance(500);
  h.values.rawBytes = 65536; h.advance(1000);
  assert.equal(h.api.status(token).clientCheckpoint.peaks.rawBytes, 262144);
  assert.equal(h.api.status(token).clientCheckpoint.raw.residentBytes, 65536);
  h.advance(20000);
  assert.equal(h.api.result(token).reason, 'host-lease-expired');
  assert.equal(h.api.result(token).peaks.rawBytes, 262144, 'the full-span peak survives a later resident-byte drop');
  assert.equal(h.jobs.size, 0); assert.equal(h.allListeners(), 0);
});

test('manual observation stops and removes all observers on hidden, document change and disposal', () => {
  for (const cause of ['hidden', 'document', 'dispose']) {
    const h = harness(); h.values.page = 65; h.values.top = 32000;
    if (cause === 'hidden') { h.document.visibilityState = 'hidden'; h.document.emit('visibilitychange'); }
    if (cause === 'document') { h.app.pdfDocument = { numPages: 460 }; h.advance(500); }
    if (cause === 'dispose') assert.equal(h.api.dispose(token).disposed, true);
    assert.equal(h.api.status(token).finished, true); assert.equal(h.values.page, 65); assert.equal(h.values.top, 32000);
    assert.equal(h.jobs.size, 0); assert.equal(h.allListeners(), 0);
    if (cause === 'dispose') assert.equal(h.window.__spomenarManualProbe, undefined);
  }
});

test('manual full-span event and sample totals survive bounded rings through normal completion', () => {
  const h = harness({ durationMs: 130000 });
  for (let index = 0; index < 300; index++) h.document.emit('touchmove', { isTrusted: true });
  h.advance(130000, true);
  const result = h.api.result(token);
  assert.equal(result.state, 'completed'); assert.equal(result.reason, 'duration-complete');
  assert.equal(result.events.length, 256); assert.equal(result.eventCounts.touchmove, 300);
  assert.equal(result.samples.length, 240); assert.ok(result.sampleCount > 240);
  assert.equal(h.jobs.size, 0); assert.equal(h.allListeners(), 0);
});

test('manual samples preserve standalone header controls and changing visible Motion Lab geometry', () => {
  const h = harness();
  h.panel.hidden = false; h.advance(500);
  h.panel.rect.x += 15; h.panel.rect.width += 20; h.panel.dataset.dock = 'right'; h.advance(1000);
  h.api.stop(token); const result = h.api.result(token), first = result.samples[0], opened = result.samples[1];
  assert.ok(Array.isArray(first.header), 'standalone Share, Download, robot and lab controls are included');
  assert.deepEqual(Array.from(first.header, item => item.id), Array.from(h.header, item => item.id));
  assert.equal(first.header[1].tag, 'A'); assert.equal(first.header[3].x, 144);
  assert.equal(first.toolbar[0].id, 'zoomIn', 'the PDF.js toolbar remains observed');
  assert.equal(first.panel, null); assert.equal(opened.panel.x, 12); assert.equal(opened.panel.width, 280);
  assert.equal(result.final.panel.x, 27); assert.equal(result.final.panel.width, 300); assert.equal(result.final.panel.dock, 'right');
  assert.equal(h.values.page, 46); assert.equal(h.values.top, 22500);
  assert.equal(h.jobs.size, 0); assert.equal(h.allListeners(), 0);
});

test('assembled manual capture failure reaches terminal errors while all cleanup still completes', () => {
  const h = harness({ surfaceFailure: true }); h.advance(500); h.api.stop(token);
  const result = h.api.result(token);
  assert.equal(result.surfaceObservation.stopped, true);
  assert.ok(result.surfaceObservation.errors.some(error => error.includes('forced surface capture failure')));
  assert.ok(result.errors.some(error => error.includes('Surface observation: forced surface capture failure')),
    'the host frontend-errors validation must see the surface failure');
  assert.equal(result.observersRemoved, true); assert.equal(h.jobs.size, 0); assert.equal(h.allListeners(), 0);
});
