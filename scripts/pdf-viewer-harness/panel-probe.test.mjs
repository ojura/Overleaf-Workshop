import assert from 'node:assert/strict';
import test from 'node:test';
import { installPanelProbe, withNativeInput } from './panel-probe.mjs';

function fixture() {
  let clock = 0, serial = 0, drag;
  const callbacks = new Map(), timers = new Map(), tasks = [], events = [], nodes = new Map();
  const geometry = { x: 900, y: 200, width: 400, height: 400 };
  class Element {
    constructor(id, bounds = () => geometry) {
      this.id = id; this.localName = 'div'; this.nodeType = 1; this.isConnected = true;
      this.listeners = new Map(); this.dataset = {}; this.bounds = bounds; this.scrollTop = 0;
      this.clientHeight = 300; this.scrollHeight = 600; nodes.set('#' + id, this);
    }
    getBoundingClientRect() {
      const b = this.bounds();
      return { ...b, left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
    }
    addEventListener(name, callback) {
      const set = this.listeners.get(name) ?? new Set(); set.add(callback); this.listeners.set(name, set);
    }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    dispatchEvent(event) {
      if (event.type === 'pointerdown') { drag = { target: this, x: event.clientX, y: event.clientY }; }
      for (const listener of [...this.listeners.get(event.type) ?? []]) { listener(event); }
      return true;
    }
    focus() { doc.activeElement = this; }
    blur() { doc.activeElement = body; }
  }
  const body = new Element('body'), input = new Element('input');
  const host = new Element('pdf-prefetch-diagnostics'); host.hidden = true; host.dataset.dock = 'float';
  const surface = new Element('surface');
  const flow = new Element('flow', () => ({ x: geometry.x, y: geometry.y + 40, width: geometry.width,
    height: (details.open ? 600 : 300) - 40 }));
  const content = new Element('content'), details = new Element('measurements');
  let open = true;
  Object.defineProperty(details, 'open', { get: () => open, set(value) {
    if (open === value) { return; }
    open = value;
    tasks.push(() => {
      events.push('toggle:' + open);
      geometry.height = open ? 600 : Math.min(geometry.height, 300);
      details.dispatchEvent({ type: 'toggle' });
    });
  } });
  const grip = new Element('drag');
  const handles = new Map(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].map(name => {
    const element = new Element('resize-' + name); element.direction = name; return [name, element];
  }));
  const docks = new Map(['float', 'left', 'right'].map(name => {
    const element = new Element('dock-' + name);
    element.click = () => { host.dataset.dock = name; events.push('dock:' + name); };
    return [name, element];
  }));
  const root = { activeElement: null, querySelector(selector) {
    if (selector === 'section') { return surface; }
    if (selector === '.panel-content-flow') { return flow; }
    if (selector === '.panel-content') { return content; }
    if (selector === '.measurements') { return details; }
    if (selector === '.panel-drag') { return grip; }
    const resize = selector.match(/data-panel-resize="([^"]+)"/);
    if (resize) { return handles.get(resize[1]); }
    const dock = selector.match(/data-panel-dock="([^"]+)"/);
    return dock ? docks.get(dock[1]) : nodes.get(selector);
  } };
  host.shadowRoot = root;
  const container = new Element('viewerContainer', () => ({ x: 0, y: 0, width: 1800, height: 1000 }));
  container.scrollTop = 100; container.scrollLeft = 0;
  const page = new Element('page-1', () => ({ x: 500, y: 0, width: 600, height: 900 }));
  const doc = { visibilityState: 'visible', activeElement: input, body, documentElement: body,
    getElementById: id => nodes.get('#' + id), querySelector: selector => nodes.get(selector) };
  const viewer = { container, pdfDocument: {}, currentPageNumber: 1, currentScale: 1,
    currentScaleValue: '1', pagesRotation: 0, scrollMode: 0, spreadMode: 0, getPageView: () => ({ div: page }) };
  const state = { visible: [1], visibleMissing: [], pending: [], documentColumn: { offsetX: 0 },
    robots: { frames: 7, activeActors: 0, activeEpisodes: 0, activePayloads: 0, retainedBytes: 0, scheduled: false },
    labRobots: { renderer: { frames: 11, scheduled: false }, actors: [{ vehicle: 'forklift', outside: false }] } };
  const pref = { robotsEnabled: true, diagnosticsEnabled: false, snapshot: () => state,
    setDiagnosticsEnabled(value) { this.diagnosticsEnabled = value; host.hidden = !value; },
    setRobotsEnabled(value) { this.robotsEnabled = value; } };
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Existing viewer global name.
  const win = { document: doc, pdfPrefetch: pref, PDFViewerApplication: { pdfViewer: viewer },
    performance: { now: () => clock }, innerWidth: 1800, innerHeight: 1000, devicePixelRatio: 1,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Native browser API name.
    CSS: { escape: value => value }, getComputedStyle: () => ({ paddingBottom: '0', borderBottomWidth: '0' }),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Native browser API name.
    PointerEvent: class { constructor(type, value) { Object.assign(this, { type }, value); } },
    requestAnimationFrame(callback) { const id = ++serial; callbacks.set(id, callback); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
    setTimeout(callback, ms) { const id = ++serial; timers.set(id, { callback, at: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    dispatchEvent(event) {
      if (event.type === 'pointermove' && drag) {
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y, direction = drag.target.direction;
        if (!direction) { geometry.x += dx; geometry.y += dy; events.push('move'); }
        else {
          events.push('resize:' + direction);
          if (direction.includes('e')) { geometry.width += dx; }
          if (direction.includes('s')) { geometry.height += dy; }
          if (direction.includes('w')) { geometry.x += dx; geometry.width -= dx; }
          if (direction.includes('n')) { geometry.y += dy; geometry.height -= dy; }
          geometry.height = Math.min(geometry.height, details.open ? 600 : 300);
        }
      }
      if (event.type === 'pointerup') { drag = undefined; }
    } };
  // Execute the exact serialized browser function so accidental outer dependencies fail here.
  Function('window', 'return (' + installPanelProbe.toString() + ')(window);')(win);
  const api = win.__pdfHarnessPanel;
  const step = () => {
    tasks.splice(0).forEach(task => task());
    clock += 16;
    const frames = [...callbacks.values()]; callbacks.clear(); frames.forEach(callback => callback(clock));
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) { timers.delete(id); timer.callback(); }
    }
  };
  const drive = async promise => {
    let done = false, value, failure;
    promise.then(result => { value = result; done = true; }, error => { failure = error; done = true; });
    for (let i = 0; i < 1200 && !done; i++) { await Promise.resolve(); step(); }
    assert.ok(done, 'the owned fake frame/timer lifecycle must terminate');
    if (failure) { throw failure; }
    return value;
  };
  return { api, win, doc, pref, state, viewer, host, details, geometry, events, tasks, callbacks, timers, drive, step };
}

test('an ambiguous native press is released once and never repeats its action', async () => {
  const calls = []; let actions = 0;
  await assert.rejects(withNativeInput(async (_method, params) => {
    calls.push(params.type); if (params.type === 'keyDown') { throw new Error('lost press acknowledgement'); }
  }, 'Input.dispatchKeyEvent', { type: 'keyDown' }, { type: 'keyUp' }, async () => { actions++; }), /lost press/);
  assert.deepEqual(calls, ['keyDown', 'keyUp']); assert.equal(actions, 0);
});

test('failed pointer movement releases at the last commanded point', async () => {
  const calls = []; let last = 0;
  await assert.rejects(withNativeInput(async (_method, params) => { calls.push(params); },
    'Input.dispatchMouseEvent', { type: 'mousePressed', x: 0 }, () => ({ type: 'mouseReleased', x: last }),
    async () => { last = 40; throw new Error('movement failed'); }), /movement failed/);
  assert.deepEqual(calls, [{ type: 'mousePressed', x: 0 }, { type: 'mouseReleased', x: 40 }]);
});

test('native hit targeting uses an exposed corner arm when its centre is empty', () => {
  const f = fixture();
  try {
    const handle = f.api.handle('nw'), root = f.api.root;
    handle.dataset.panelResize = 'nw';
    handle.bounds = () => ({ x: 900, y: 200, width: 24, height: 24 });
    const other = root.querySelector('.panel-content');
    const checked = [];
    root.elementFromPoint = (x, y) => { checked.push({ x, y }); return x < 906 || y < 206 ? handle : other; };
    f.doc.elementFromPoint = () => f.host;
    const point = f.api.point('[data-panel-resize="nw"]');
    assert.notDeepEqual({ x: point.x, y: point.y }, { x: 912, y: 212 });
    assert.equal(root.elementFromPoint(point.x, point.y), handle);
    assert.ok(checked.length <= 26, 'native hit targeting must have a bounded search');
    f.doc.elementFromPoint = () => f.doc.body;
    assert.throws(() => f.api.point('[data-panel-resize="nw"]'), /reachable/);
  } finally { f.api.dispose(); }
});

test('captures a closed panel and restores reading, visibility and both idle owners', async () => {
  const f = fixture();
  try {
    const saved = f.api.capture();
    assert.equal(saved.shown, false); assert.equal(saved.panel, null);
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
    await f.drive(f.api.show());
    f.viewer.currentPageNumber = 2; f.viewer.container.scrollTop = 600;
    const result = await f.drive(f.api.restore(saved));
    assert.equal(result.exactReading, true); assert.equal(result.exactFocus, true);
    assert.equal(f.host.hidden, true); assert.equal(f.pref.diagnosticsEnabled, false);
    assert.equal(f.callbacks.size + f.timers.size, 0);
  } finally { f.api.dispose(); }
});

test('awaits the native opening toggle before restoring a manually short panel', async () => {
  const f = fixture();
  try {
    await f.drive(f.api.show());
    const saved = f.api.capture();
    assert.equal(saved.details, true); assert.equal(saved.panel.height, 400);
    f.details.open = false; f.step();
    assert.equal(f.geometry.height, 300);
    f.events.length = 0;
    const result = await f.drive(f.api.restore(saved));
    assert.equal(result.panel.height, 400);
    assert.ok(f.events.indexOf('toggle:true') >= 0);
    assert.ok(f.events.indexOf('toggle:true') < f.events.indexOf('resize:se'));
    assert.equal(f.callbacks.size + f.timers.size, 0);
  } finally { f.api.dispose(); }
});

test('disposal cancels an outstanding frame wait and removes disclosure listeners', async () => {
  const f = fixture();
  const pending = f.api.setDetails(false);
  assert.equal(f.details.listeners.get('toggle').size, 1);
  f.api.dispose();
  await assert.rejects(pending, /disposed/);
  assert.equal(f.callbacks.size + f.timers.size, 0);
  assert.equal(f.details.listeners.get('toggle').size, 0);
  assert.equal(f.win.__pdfHarnessPanel, undefined);
  f.step();
  assert.equal(f.callbacks.size + f.timers.size, 0);
});

test('quiet waits for the real forklift lease and both renderer schedules', async () => {
  const f = fixture();
  try {
    f.state.labRobots.actors[0].outside = true;
    f.state.labRobots.renderer.scheduled = true;
    f.state.robots.scheduled = true;
    let completed = false;
    const pending = f.api.quiet().then(value => { completed = true; return value; });
    await Promise.resolve(); f.step(); await Promise.resolve(); f.step(); await Promise.resolve();
    assert.equal(completed, false);
    f.state.labRobots.actors[0].outside = false;
    f.state.labRobots.renderer.scheduled = false; f.state.robots.scheduled = false;
    const result = await f.drive(pending);
    assert.equal(result.robotFrames, 7); assert.equal(result.labFrames, 11);
    assert.equal(f.callbacks.size + f.timers.size, 0);
  } finally { f.api.dispose(); }
});

test('a replaced document refuses restoration and cancels the active wait', async () => {
  const f = fixture();
  try {
    const saved = f.api.capture(), top = f.viewer.container.scrollTop;
    f.viewer.pdfDocument = {};
    await assert.rejects(f.api.restore(saved), /document changed/);
    await assert.rejects(f.api.until(() => false, 'replacement'), /document changed/);
    assert.equal(f.viewer.container.scrollTop, top);
    assert.equal(f.callbacks.size + f.timers.size, 0);
  } finally { f.api.dispose(); }
});
