import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserSource } from './browser-source.mjs';
import { createReaderFocus } from './reader-focus.mjs';

const source = loadBrowserSource('sidecar-active.js');
const restoreStart = source.indexOf('  const restore = () => {');
const restoreEnd = source.indexOf('  for (const type of types) document.addEventListener', restoreStart);
const frameStart = source.indexOf('  const nextFocusFrame =');
const frameEnd = source.indexOf('  const current =', frameStart);
const probeStart = source.indexOf('  const probe = {');
const abortStart = source.indexOf('abort(supplied', probeStart);
const abortEnd = source.indexOf('    setPanelRestore', abortStart);
const watchdogStart = source.indexOf('  timer = setTimeout(', abortEnd);
const watchdogEnd = source.indexOf('  async function json(', watchdogStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart && abortStart > probeStart && watchdogEnd > watchdogStart);

function fixture({ pageText = false } = {}) {
  let resolvePanel, rejectPanel, enterPanel, enterFrame, focused, panelCalls = 0, disposals = 0, watchdog, now = 100, serial = 0;
  const frames = new Map(), timers = new Map();
  const entered = new Promise(resolve => { enterPanel = resolve; });
  const frameRequested = new Promise(resolve => { enterFrame = resolve; });
  const panel = new Promise((resolve, reject) => { resolvePanel = resolve; rejectPanel = reject; });
  panel.catch(() => {});
  const body = { isConnected: true, closest: () => null, focus() { focused = this; } }, other = { blur() { focused = body; } }; focused = other;
  const root = { isConnected: true, dataset: { pageNumber: '46' }, contains: node => node === currentText };
  const text = () => ({ isConnected: true,
    closest: selector => selector === '.page[data-page-number]' ? root : undefined,
    focus(options) { this.lastFocusOptions = options; focused = this; } });
  const originalText = text();
  let currentText = originalText;
  const context = { result: { interrupted: false }, token: 'owned-restoration-token', budget: { workMs: 100000, restoreMs: 15000 },
    changed: true, closing: false, disposed: false, restoreInFlight: undefined, closeInFlight: undefined,
    performance: { now: () => now }, current: () => true,
    document: { body, get activeElement() { return focused; } }, focus: pageText ? originalText : body,
    savedFocus: pageText ? { kind: 'page-text', pageNumber: 46 } : { kind: 'body' },
    deepFocus: () => focused, window: { getSelection: () => ({ isCollapsed: true }) }, timer: 1, request: { abort() {} },
    focusWaits: new Set(),
    requestAnimationFrame(callback) {
      const id = ++serial; frames.set(id, callback);
      enterFrame();
      if (!context.holdFrames) void Promise.resolve().then(() => {
        if (!frames.has(id)) return;
        now += 16; context.onFocusWait?.(); callback();
      });
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    saved: { page: 46, rotation: 0, scrollMode: 0, spreadMode: 0, scaleValue: 'page-width', sidebar: 0,
      top: 23685, left: 0, robots: true, lab: false },
    container: { scrollTop: 50000, scrollLeft: 0, contains: node => node === root },
    viewer: { pagesRotation: 0, scrollMode: 0, spreadMode: 0, currentScaleValue: 'page-width', currentPageNumber: 99,
      getPageView: index => index === 45 ? { id: 46, div: root, textLayer: { div: currentText } } : undefined,
      scrollPageIntoView({ pageNumber }) { this.currentPageNumber = pageNumber; } },
    app: { pdfSidebar: { visibleView: 0, switchView(value) { this.visibleView = value; } } },
    prefetch: { robotsEnabled: true, diagnosticsEnabled: true,
      setRobotsEnabled(value) { this.robotsEnabled = value; }, setDiagnosticsEnabled(value) { this.diagnosticsEnabled = value; } },
    panelRestore: async controls => { panelCalls++; enterPanel(); await panel; controls?.guard?.(); },
    readState: () => ({ page: context.viewer.currentPageNumber, top: context.container.scrollTop }),
    dispose: () => {
      if (!context.disposed) disposals++; context.disposed = true;
      for (const cancel of context.focusWaits) cancel();
      context.result.observersRemoved = true;
    },
    guard: allowClosing => { if (context.result.interrupted || context.disposed || context.closing && !allowClosing) throw new Error('Observation closed'); },
    clearTimeout(id) { timers.delete(id); }, setTimeout(fn, ms) { watchdog = fn; const id = ++serial; timers.set(id, { fn, ms }); return id; } };
  context.viewer.container = context.container;
  context.focusOwner = createReaderFocus({ document: context.document, window: context.window,
    viewer: () => context.viewer, pages: 460 });
  const methodStart = source.slice(probeStart, abortStart).trimEnd().endsWith('async') ? 'async ' : '';
  vm.runInNewContext(source.slice(frameStart, frameEnd) + source.slice(restoreStart, restoreEnd)
    + '\nconst probe = {' + methodStart + source.slice(abortStart, abortEnd) + '};'
    + '\nwindow.__spomenarSidecarProbe=probe;globalThis.callRestore=restore;globalThis.owner=probe;'
    + source.slice(watchdogStart, watchdogEnd), context);
  return { context, resolvePanel, rejectPanel, entered, frameRequested, get calls() { return panelCalls; }, get disposals() { return disposals; },
    get watchdog() { return watchdog; }, get focused() { return focused; }, frames, timers,
    removeTextLayer() { currentText = undefined; originalText.isConnected = false; },
    replaceTextLayer() {
      originalText.isConnected = false;
      currentText = text();
      return currentText;
    } };
}

test('short restoration reacquires the saved page text after its original node is replaced', async () => {
  const h = fixture({ pageText: true }), replacement = h.replaceTextLayer(), pending = h.context.callRestore();
  await h.entered; h.resolvePanel(); await pending;
  assert.equal(h.context.result.focusRestored, true);
  assert.equal(h.focused, replacement);
  assert.deepEqual(replacement.lastFocusOptions, { preventScroll: true });
  assert.equal(h.context.viewer.currentPageNumber, 46);
  assert.equal(h.context.container.scrollTop, 23685);
});

test('short focus restoration waits for the canonical replacement within its existing restoration deadline', async () => {
  const h = fixture({ pageText: true }); h.removeTextLayer();
  let replacement;
  h.context.onFocusWait = () => { replacement = h.replaceTextLayer(); };
  const pending = h.context.callRestore(); await h.entered; h.resolvePanel(); await pending;
  assert.equal(h.focused, replacement);
  assert.equal(h.context.result.focusRestored, true);
  assert.deepEqual(h.context.result.focusAfter, { kind: 'page-text', pageNumber: 46 });
});

test('missing text focus fails at the existing deadline without focusing an unrelated control', async () => {
  const h = fixture({ pageText: true }); h.removeTextLayer(); h.context.budget.restoreMs = 32;
  const original = h.focused, pending = h.context.callRestore(); await h.entered; h.resolvePanel();
  await assert.rejects(pending, /Focus restoration deadline expired/);
  assert.equal(h.focused, original);
  assert.equal(h.context.viewer.currentPageNumber, 46);
  assert.equal(h.context.result.restored, true);
  assert.equal(h.context.result.focusRestored, false);
  assert.equal(h.context.result.readingState.top, 23685);
  assert.equal(h.context.focusWaits.size + h.frames.size, 0);
});

test('trusted input during text-layer reacquisition prevents the delayed focus write', async () => {
  const h = fixture({ pageText: true }); h.removeTextLayer();
  const original = h.focused;
  h.context.onFocusWait = () => { h.replaceTextLayer(); h.context.result.interrupted = true; };
  const pending = h.context.callRestore(); await h.entered; h.resolvePanel();
  await assert.rejects(pending, /Observation closed/);
  assert.equal(h.focused, original);
});

test('disposal cancels a pending focus frame while hidden Safari supplies no animation frame', async () => {
  const h = fixture({ pageText: true }); h.removeTextLayer(); h.context.holdFrames = true;
  const pending = h.context.callRestore(); await h.entered; h.resolvePanel();
  await h.frameRequested;
  h.context.result.interrupted = true; h.context.dispose();
  await assert.rejects(pending, /Observation closed/);
  assert.equal(h.context.result.restored, false);
  assert.equal(h.context.focusWaits.size + h.frames.size, 0);
});

test('the existing restoration deadline releases a focus wait when animation frames stop', async () => {
  const h = fixture({ pageText: true }); h.removeTextLayer(); h.context.holdFrames = true;
  h.context.budget.restoreMs = 32;
  const pending = h.context.callRestore(); await h.entered; h.resolvePanel();
  await h.frameRequested;
  [...h.timers.values()].find(timer => timer.ms === 32).fn();
  await assert.rejects(pending, /Focus restoration deadline expired/);
  assert.equal(h.context.result.restored, true);
  assert.equal(h.context.result.focusRestored, false);
  assert.equal(h.context.result.readingState.top, 23685);
  assert.equal(h.context.focusWaits.size + h.frames.size, 0);
});

test('one pending panel restoration is shared and finishes before reader/focus restoration', async () => {
  const h = fixture(), one = h.context.callRestore(), two = h.context.callRestore();
  await h.entered;
  assert.equal(h.calls, 1);
  assert.equal(h.context.viewer.currentPageNumber, 99);
  assert.equal(h.context.prefetch.diagnosticsEnabled, true);
  h.resolvePanel(); await Promise.all([one, two]);
  assert.equal(h.context.viewer.currentPageNumber, 46);
  assert.equal(h.context.container.scrollTop, 23685);
  assert.equal(h.context.result.focusRestored, true);
});

test('a delayed panel failure is reported after restoring the remaining owned reader state', async () => {
  const h = fixture(), pending = h.context.callRestore();
  await h.entered; h.rejectPanel(new Error('panel failed'));
  await assert.rejects(Promise.resolve(pending), /panel failed/);
  assert.equal(h.context.viewer.currentPageNumber, 46);
  assert.equal(h.context.result.focusRestored, true);
});

test('trusted input while panel recovery waits prevents late reader and focus writes', async () => {
  const h = fixture(), pending = h.context.callRestore();
  await h.entered;
  assert.equal(h.context.viewer.currentPageNumber, 99);
  h.context.result.interrupted = true; h.context.viewer.currentPageNumber = 311;
  h.resolvePanel(); await pending;
  assert.equal(h.context.viewer.currentPageNumber, 311);
  assert.equal(h.context.prefetch.diagnosticsEnabled, true);
  assert.notEqual(h.context.result.focusRestored, true);
});

test('token-owned abort awaits the shared recovery before disposing and wrong tokens cannot join it', async () => {
  const h = fixture();
  assert.equal((await h.context.owner.abort('wrong-token')).ok, false);
  const one = h.context.owner.abort(h.context.token), two = h.context.owner.abort(h.context.token);
  await h.entered;
  assert.equal(h.calls, 1);
  assert.equal(h.disposals, 0);
  assert.ok(h.context.window.__spomenarSidecarProbe);
  h.resolvePanel(); await Promise.all([one, two]);
  assert.equal(h.disposals, 1);
  assert.equal(h.context.viewer.currentPageNumber, 46);
  assert.equal(h.context.window.__spomenarSidecarProbe, undefined);
});

test('a watchdog firing during an awaited abort shares that cleanup and leaves no second restoration', async () => {
  const h = fixture(), pending = h.context.owner.abort(h.context.token);
  h.watchdog(); await h.entered;
  assert.equal(h.calls, 1);
  assert.equal(h.disposals, 0);
  h.resolvePanel(); await pending;
  assert.equal(h.disposals, 1);
  assert.equal(h.context.window.__spomenarSidecarProbe, undefined);
});
