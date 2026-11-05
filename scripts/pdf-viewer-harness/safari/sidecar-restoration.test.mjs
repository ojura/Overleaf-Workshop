import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserSource } from './browser-source.mjs';

const source = loadBrowserSource('sidecar-active.js');
const restoreStart = source.indexOf('  const restore =');
const restoreEnd = source.indexOf('  for (const type of types) document.addEventListener', restoreStart);
const probeStart = source.indexOf('  const probe = {');
const abortStart = source.indexOf('abort(supplied', probeStart);
const abortEnd = source.indexOf('    setPanelRestore', abortStart);
const watchdogStart = source.indexOf('  timer = setTimeout(', abortEnd);
const watchdogEnd = source.indexOf('  async function json(', watchdogStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart && abortStart > probeStart && watchdogEnd > watchdogStart);

function fixture() {
  let resolvePanel, rejectPanel, enterPanel, focused, panelCalls = 0, disposals = 0, watchdog;
  const entered = new Promise(resolve => { enterPanel = resolve; });
  const panel = new Promise((resolve, reject) => { resolvePanel = resolve; rejectPanel = reject; });
  panel.catch(() => {});
  const body = { isConnected: true }, other = { blur() { focused = body; } }; focused = other;
  const context = { result: { interrupted: false }, token: 'owned-restoration-token', budget: { workMs: 100000, restoreMs: 15000 },
    changed: true, closing: false, disposed: false, restoreInFlight: undefined, closeInFlight: undefined,
    performance: { now: () => 100 }, current: () => true, document: { body }, focus: body,
    deepFocus: () => focused, window: {}, timer: 1, request: { abort() {} },
    saved: { page: 46, rotation: 0, scrollMode: 0, spreadMode: 0, scaleValue: 'page-width', sidebar: 0,
      top: 23685, left: 0, robots: true, lab: false },
    container: { scrollTop: 50000, scrollLeft: 0 },
    viewer: { pagesRotation: 0, scrollMode: 0, spreadMode: 0, currentScaleValue: 'page-width', currentPageNumber: 99,
      scrollPageIntoView({ pageNumber }) { this.currentPageNumber = pageNumber; } },
    app: { pdfSidebar: { visibleView: 0, switchView(value) { this.visibleView = value; } } },
    prefetch: { robotsEnabled: true, diagnosticsEnabled: true,
      setRobotsEnabled(value) { this.robotsEnabled = value; }, setDiagnosticsEnabled(value) { this.diagnosticsEnabled = value; } },
    panelRestore: async controls => { panelCalls++; enterPanel(); await panel; controls?.guard?.(); },
    readState: () => ({ page: context.viewer.currentPageNumber, top: context.container.scrollTop }),
    dispose: () => { if (!context.disposed) disposals++; context.disposed = true; context.result.observersRemoved = true; },
    guard: allowClosing => { if (context.result.interrupted || context.disposed || context.closing && !allowClosing) throw new Error('Observation closed'); },
    clearTimeout() {}, setTimeout(fn) { watchdog = fn; return 1; } };
  const methodStart = source.slice(probeStart, abortStart).trimEnd().endsWith('async') ? 'async ' : '';
  vm.runInNewContext(source.slice(restoreStart, restoreEnd)
    + '\nconst probe = {' + methodStart + source.slice(abortStart, abortEnd) + '};'
    + '\nwindow.__spomenarSidecarProbe=probe;globalThis.callRestore=restore;globalThis.owner=probe;'
    + source.slice(watchdogStart, watchdogEnd), context);
  return { context, resolvePanel, rejectPanel, entered, get calls() { return panelCalls; }, get disposals() { return disposals; },
    get watchdog() { return watchdog; } };
}

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
