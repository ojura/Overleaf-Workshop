import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserSource } from './browser-source.mjs';

const source = loadBrowserSource('sidecar-finish.js');
const budget = { activeMs: 35000, captureMs: 5000, finishMs: 60000, workMs: 100000, restoreMs: 15000,
  settleMs: 6000, awakeMs: 4000 };
const clone = value => JSON.parse(JSON.stringify(value));
const box = (x, y, width, height) => ({ x, y, left: x, top: y, width, height,
  right: x + width, bottom: y + height, toJSON() { return { ...this, toJSON: undefined }; } });

function fixture({ dock = 'float', floatX = 140, floatWidth = 200, readerLeft = 0, pageLeft = 300, pageWidth = 300,
  stallDock, insufficientFloat = false, interruptDuringRestore = false } = {}) {
  let now = 0, serial = 0, columnX = 0, animation, column, pointer, callback, restoring;
  let closed = false, interrupted = false, stalled = false, recovery = false;
  const timers = new Map(), overlaps = [], history = [];
  const readerRight = readerLeft + 1000;
  const originalFloat = box(floatX, 80, floatWidth, 220);
  let floating = clone(originalFloat), currentDock = dock;
  const destination = value => value === 'float' ? clone(floating)
    : box(value === 'left' ? readerLeft : readerRight - floating.width, 20, floating.width, 660);
  let rect = destination(dock);
  const original = clone(rect), details = { open: false }, host = { dataset: { dock } };
  const saved = { page: 46, scaleValue: 'page-width', scale: 0.5, rotation: 0, scrollMode: 0,
    spreadMode: 0, sidebar: 0, top: 23685, left: 0, robots: true, lab: false };
  const reading = { ...saved, page: 99, top: 50000 };
  const container = { dataset: {}, clientLeft: 0, clientTop: 0, clientWidth: 1000, clientHeight: 700,
    scrollWidth: 1000, scrollHeight: 200000, getBoundingClientRect: () => box(readerLeft, 0, 1000, 700) };
  const result = { token: 'owned-sidecar-fixture', startedAt: 0, saved, interrupted: false, errors: [] };
  const timeout = (fn, delay = 0) => { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id; };
  const ease = value => 1 - (1 - Math.min(1, Math.max(0, value))) ** 3;
  const plan = (value, target) => {
    const left = pageLeft, right = pageLeft + pageWidth;
    if (value === 'left') return Math.min(Math.max(0, target.right + 16 - left), Math.max(0, readerRight - right));
    if (value === 'right') return -Math.min(Math.max(0, right + 16 - target.left), Math.max(0, left - readerLeft));
    if (target.right <= readerLeft || target.left >= readerRight) return 0;
    if (right + 16 <= target.left || left >= target.right + 16 || pageWidth > 1000) return 0;
    const a = target.left - 16 - right, b = target.right + 16 - left;
    const available = [a, b].filter(x => left + x >= readerLeft && right + x <= readerRight);
    const answer = available.sort((a, b) => Math.abs(a) - Math.abs(b))[0] ?? 0;
    return insufficientFloat ? answer / 2 : answer;
  };
  function update() {
    if (column) {
      columnX = column.from + (column.to - column.from) * ease((now - column.at - 500) / 1800);
      if (!column.stall && now >= column.at + 2500) { columnX = column.to; column = undefined; delete container.dataset.pdfColumnMoving; }
    }
    if (animation) {
      const progress = ease((now - animation.at - 2500) / 1200), from = animation.from, to = animation.to;
      rect = box(...['x', 'y', 'width', 'height'].map(key => from[key] + (to[key] - from[key]) * progress));
      if (!animation.stall && now >= animation.at + 3700) { rect = clone(to); animation = undefined; delete host.dataset.panelMoving; }
    }
  }
  function moveColumn(target, stall = false) {
    column = { from: columnX, to: target, at: now, stall };
    container.dataset.pdfColumnMoving = 'true';
  }
  function clickDock(value) {
    update();
    if (animation || column) overlaps.push({ action: 'dock-' + value, at: now, recovery });
    const stall = value === stallDock && !stalled; stalled ||= stall;
    const to = destination(value);
    currentDock = value; host.dataset.dock = value;
    animation = { at: now, from: clone(rect), to, stall };
    host.dataset.panelMoving = 'true'; moveColumn(plan(value, to), stall);
    history.push({ action: 'dock-' + value, at: now, intendedEnd: now + 3700, recovery });
  }
  function down(kind, event) {
    update();
    if (animation) overlaps.push({ action: kind, at: now, recovery });
    animation = undefined; column = undefined;
    delete host.dataset.panelMoving; delete container.dataset.pdfColumnMoving;
    pointer = { kind, x: event.clientX, y: event.clientY, rect: clone(rect) };
  }
  const handle = kind => ({ getBoundingClientRect: () => box(rect.x, rect.y, 20, 20),
    dispatchEvent(event) { if (event.type === 'pointerdown') down(kind, event); } });
  const controls = { host, surface: { getBoundingClientRect: () => box(rect.x, rect.y, rect.width, rect.height) },
    drag: handle('drag'), resize: handle('resize'), root: { querySelector(selector) {
      if (selector === '.measurements') return details;
      const value = selector.match(/data-panel-dock="([^"]+)"/)?.[1];
      return value && { click() { clickDock(value); } };
    } } };
  const guard = allowClosing => {
    if (interrupted || result.interrupted) throw new Error('trusted-input');
    if (closed || recovery && !allowClosing) throw new Error('Observation closed');
  };
  const panelState = () => ({ dock: currentDock, rect: clone(rect), measurements: details.open, columnX });
  const window = { visualViewport: { offsetLeft: 0, offsetTop: 0, width: readerRight, height: 700 },
    dispatchEvent(event) {
      if (event.type === 'pointerup') { pointer = undefined; return; }
      if (event.type !== 'pointermove' || !pointer) return;
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y, old = pointer.rect;
      if (pointer.kind === 'drag') {
        currentDock = 'float'; host.dataset.dock = currentDock;
        rect = box(old.x + dx, old.y + dy, old.width, old.height);
      } else if (currentDock === 'right') rect = box(old.x + dx, old.y, old.width - dx, old.height);
      else rect = box(old.x, old.y, old.width + dx, old.height + (currentDock === 'float' ? dy : 0));
      if (currentDock === 'float') floating = clone(rect);
      moveColumn(plan(currentDock, rect));
      history.push({ action: pointer.kind, at: now, recovery });
    } };
  const pdfPrefetch = { snapshot: () => ({ visible: [99] }),
    setDiagnosticsEnabled(value) { reading.lab = value; if (!value) { animation = undefined; column = undefined;
      delete host.dataset.panelMoving; delete container.dataset.pdfColumnMoving; columnX = 0; }
      else if (Math.abs(columnX - plan(currentDock, rect)) > 0.01) moveColumn(plan(currentDock, rect)); } };
  const sample = () => ({ documentVisible: true, robots: { activeActors: 0, activePayloads: 0, retainedBytes: 0,
      scheduled: false, frames: 0 }, effectNodes: {}, missing: [], pending: [], pendingFetches: 0,
    canvases: [{ page: saved.page, state: 3, native: { connected: true, width: 300, height: 600,
      rect: { width: 300, height: 600 }, computed: { display: 'block', visibility: 'visible' } } }] });
  const probe = { token: result.token, result, budget, sample, guard, sleep: delay => new Promise(resolve => timeout(resolve, delay)),
    panel: () => reading.lab ? controls : undefined, panelState, readState: () => ({ ...reading }),
    setPanelRestore(value) { callback = value; },
    dispose() { closed = true; result.observersRemoved = true; },
    restore() {
      if (restoring) return restoring;
      restoring = (async () => {
        if (result.interrupted) return false;
        recovery = true;
        if (interruptDuringRestore) timeout(() => { interrupted = result.interrupted = true; reading.page = 311; }, 32);
        await callback?.({ guard: () => guard(true), deadline: now + budget.restoreMs });
        if (result.interrupted) return false;
        Object.assign(reading, saved); pdfPrefetch.setDiagnosticsEnabled(saved.lab); result.focusRestored = true;
        recovery = false; return true;
      })().finally(() => { restoring = undefined; });
      return restoring;
    } };
  window.__spomenarSidecarProbe = probe;
  const context = { window, pdfPrefetch, PDFViewerApplication: { pdfViewer: { container,
    getPageView: () => ({ div: { getBoundingClientRect: () => box(pageLeft + columnX, 40, pageWidth, 600) } }) } },
    document: { visibilityState: 'visible', hasFocus: () => false }, innerWidth: readerRight, innerHeight: 700,
    performance: { now: () => now }, PointerEvent: class { constructor(type, fields) { Object.assign(this, fields, { type }); } },
    setTimeout: timeout, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => timeout(() => fn(now), 16), cancelAnimationFrame: id => timers.delete(id) };
  const finish = vm.runInNewContext(source, context);
  return { result, history, overlaps, original, originalFloat, panelState, reading, timers, probe,
    async run() {
      let done = false, failure;
      finish({ token: result.token }).then(() => { done = true; }, error => { done = true; failure = error; });
      for (let count = 0; !done && count < 20000; count++) {
        await new Promise(setImmediate);
        if (done) break;
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        assert.ok(next, 'the actual async finish must own a frame or timeout while pending');
        timers.delete(next[0]); now = next[1].at; update(); next[1].fn();
      }
      assert.ok(done, 'the finite finish must terminate');
      if (failure) throw failure;
      return result;
    }, get floating() { return floating; }, get now() { return now; } };
}

test('finish waits through stationary column phases and the subsequent panel glide before each trial', async () => {
  const h = fixture({ dock: 'right' }), result = await h.run();
  assert.equal(result.failure, undefined);
  assert.equal(result.cleanupError, undefined);
  assert.equal(result.panel.trials.length, 5);
  assert.equal(result.restorationExact, true);
  assert.equal(result.idle.awake, true);
  assert.deepEqual(h.overlaps.filter(value => !value.recovery), []);
  assert.ok(h.history.filter(value => value.action.startsWith('dock-')).length >= 5);
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(h.panelState().rect[key] - h.original[key]) <= 1, key);
    assert.ok(Math.abs(h.floating[key] - h.originalFloat[key]) <= 1, 'remembered float ' + key);
  }
  assert.equal(h.timers.size, 0);
});

test('floating clearance accepts either actual side and an intentional zero shift when neither side fits', async () => {
  for (const options of [{ floatX: 140 }, { floatX: 600 }, { pageLeft: -100, pageWidth: 1200 }]) {
    const h = fixture(options), result = await h.run();
    assert.equal(result.failure, undefined, JSON.stringify(options));
    const state = result.panel.trials.find(value => value.action === 'dock-float').state;
    if (options.pageWidth) assert.equal(state.columnX, 0);
    else assert.equal(Math.sign(state.columnX), options.floatX === 140 ? 1 : -1);
    assert.equal(result.restorationExact, true);
    assert.equal(h.timers.size, 0);
  }
});

test('floating clearance rejects a partial shift that leaves a feasible photo column behind the panel', async () => {
  const h = fixture({ insufficientFloat: true }), result = await h.run();
  assert.match(result.failure, /floating.*clearance/i);
  assert.equal(result.cleanupError, undefined);
  assert.equal(h.reading.page, result.saved.page);
  assert.equal(h.timers.size, 0);
});

test('a floating panel outside the clipped reader does not obstruct an already clipped page', async () => {
  const h = fixture({ readerLeft: 280, pageLeft: 270, pageWidth: 600, floatX: 8, floatWidth: 282 });
  const result = await h.run();
  assert.equal(result.failure, undefined);
  const state = result.panel.trials.find(value => value.action === 'dock-float').state;
  assert.equal(state.readerClip.left, 280);
  assert.equal(state.readerClip.right, 1280);
  assert.equal(state.rect.left, 8);
  assert.equal(state.rect.right, 270);
  assert.ok(state.rect.right < state.readerClip.left);
  assert.equal(state.pages[0].rect.left, 270);
  assert.equal(state.columnX, 0);
  assert.equal(result.restorationExact, true);
  assert.equal(h.timers.size, 0);
});

test('a never-completing dock fails finitely and still awaits exact panel recovery', async () => {
  const h = fixture({ dock: 'left', stallDock: 'right' }), result = await h.run();
  assert.match(result.failure, /did not settle/i);
  assert.equal(result.cleanupError, undefined);
  assert.equal(h.panelState().dock, 'left');
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(h.panelState().rect[key] - h.original[key]) <= 1);
  assert.ok(h.now < budget.workMs + budget.restoreMs);
  assert.equal(h.timers.size, 0);
});

test('trusted input during asynchronous recovery keeps the user-selected reader state', async () => {
  const h = fixture({ dock: 'left', stallDock: 'right', interruptDuringRestore: true }), result = await h.run();
  assert.equal(result.interrupted, true);
  assert.equal(h.reading.page, 311);
  assert.equal(result.observersRemoved, true);
  assert.equal(h.timers.size, 0);
});
