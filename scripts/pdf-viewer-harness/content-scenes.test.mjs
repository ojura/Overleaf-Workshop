import assert from 'node:assert/strict';
import test from 'node:test';
import { installHostGap, validateHostGap, validateContentGeometry, removeHostGap } from './content-scenes.mjs';

function fixture() {
  let clock = 0, serial = 0, initialized = false, requested = false, panel;
  const handlers = new Set(), frames = new Map(), timers = new Map(), tasks = [], observers = new Set(), writes = [], sent = [];
  const doc = { getElementById: () => panel };
  function createPanel() {
    panel = { shadowRoot: { querySelector: () => ({ open: true }) } };
    for (const observer of [...observers]) { observer.callback(); }
  }
  function message(data) {
    let stopped = false;
    const event = { data, stopImmediatePropagation() { stopped = true; } };
    for (const handler of [...handlers]) { handler(event); if (stopped) { break; } }
    if (!stopped && data.type === 'initState') { initialized = true; if (requested) { createPanel(); } }
  }
  const win = { document: doc, performance: { now: () => clock }, harness: { messages: () => writes },
    pdfPrefetch: { setDiagnosticsEnabled() { requested = true; if (initialized) { createPanel(); } } },
    addEventListener(name, callback) { assert.equal(name, 'message'); handlers.add(callback); },
    removeEventListener(_name, callback) { handlers.delete(callback); },
    requestAnimationFrame(callback) { const id = ++serial; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, ms) { const id = ++serial; timers.set(id, { callback, at: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    postMessage(data) { sent.push(data); tasks.push(() => message(data)); },
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Native browser API name.
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    } };
  Function('window', 'return (' + installHostGap.toString() + ')(window)')(win);
  const step = (ms = 16, render = true) => {
    tasks.splice(0).forEach(task => task()); clock += ms;
    if (render) { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(clock)); }
    for (const [id, value] of [...timers]) { if (value.at <= clock) { timers.delete(id); value.callback(); } }
  };
  return { win, message, step, frames, timers, handlers, observers, writes, sent,
    ready: () => initialized, panel: () => panel, api: win.__pdfHarnessHostGap };
}

test('holds the native initialization for observed frames and shows the saved preference first', () => {
  const f = fixture();
  try {
    f.message({ type: 'initState', content: { motionLabMeasurementsOpen: true } });
    assert.equal(f.ready(), false); assert.equal(f.panel(), undefined);
    f.step(); f.step();
    assert.equal(f.ready(), false); assert.equal(f.sent.length, 0);
    f.step(); assert.equal(f.sent.length, 1);
    f.step();
    validateHostGap(f.api.receipt);
    assert.equal(f.ready(), true); assert.equal(f.frames.size + f.timers.size + f.observers.size, 0);
  } finally { f.api.dispose(); }
  assert.equal(f.handlers.size, 0);
});

test('the host-gap check rejects a state write made before host initialization', () => {
  const f = fixture();
  try {
    f.message({ type: 'initState', content: { motionLabMeasurementsOpen: true } });
    f.writes.push({ type: 'saveState', content: { motionLabMeasurementsOpen: false } });
    for (let i = 0; i < 4; i++) { f.step(); }
    assert.throws(() => validateHostGap(f.api.receipt), /persisted state before/);
  } finally { f.api.dispose(); }
});

test('disposing a held initialization releases the message once and cancels diagnostic owners', () => {
  const f = fixture();
  f.message({ type: 'initState', content: { motionLabMeasurementsOpen: true } });
  f.api.dispose(); f.api.dispose();
  assert.equal(f.sent.length, 1);
  assert.equal(f.frames.size + f.timers.size + f.handlers.size + f.observers.size, 0);
  assert.equal(f.win.__pdfHarnessHostGap, undefined);
  f.step();
  assert.equal(f.ready(), true);
  assert.equal(f.frames.size + f.timers.size + f.handlers.size + f.observers.size, 0);
});

test('the unresponsive-renderer bound releases host initialization and reports the actual failure', () => {
  const f = fixture();
  try {
    f.message({ type: 'initState', content: { motionLabMeasurementsOpen: true } });
    f.step(5000, false); f.step(1, false);
    assert.equal(f.ready(), true); assert.equal(f.sent.length, 1);
    assert.throws(() => validateHostGap(f.api.receipt), /stopped rendering/);
    assert.equal(f.frames.size + f.timers.size + f.observers.size, 0);
  } finally { f.api.dispose(); }
});

test('content geometry checks use the intrinsic ceiling and actual visual viewport', () => {
  const value = { shown: true, panel: { x: 10, y: 20, width: 300, height: 160, right: 310, bottom: 180 },
    flow: {}, blankTail: 0, viewport: { x: 5, y: 10, width: 500, height: 400 } };
  validateContentGeometry(value, 'manually short');
  assert.throws(() => validateContentGeometry({ ...value, blankTail: 40 }, 'empty tail'), /empty space/);
  assert.throws(() => validateContentGeometry({ ...value, viewport: { x: 5, y: 10, width: 200, height: 400 } }, 'clipped'), /beyond/);
  assert.throws(() => validateContentGeometry({ ...value, flow: null }, 'missing'), /measured/);
});

test('a failed page cleanup still removes its known native preload and preserves both errors', async () => {
  const calls = [], pageError = new Error('page context ended'), nativeError = new Error('native removal failed');
  let failure;
  try {
    await removeHostGap(async () => { calls.push('page'); throw pageError; }, async (method, params) => {
      calls.push([method, params]); throw nativeError;
    }, 'owned-preload');
  } catch (error) { failure = error; }
  assert.deepEqual(calls, ['page', ['Page.removeScriptToEvaluateOnNewDocument', { identifier: 'owned-preload' }]]);
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [pageError, nativeError]);
});
