import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('./release-guard.js', import.meta.url), 'utf8');
const documentConfig = JSON.parse(fs.readFileSync(new URL('./document.example.json', import.meta.url), 'utf8'));
const pdfPath = '/spomenar-versions/6abb3d0b13d2970bca0f613287a6ea5d30280be14435b5c681b8ca8bd61d24d0/book.pdf';
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
class Events {
  listeners = new Map();
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, values = {}) { for (const callback of [...this.listeners.get(name) ?? []]) callback({ type: name, ...values }); }
  on(name, callback) { this.addEventListener(name, callback); }
  off(name, callback) { this.removeEventListener(name, callback); }
  dispatch(name) { this.emit(name); }
  get count() { return [...this.listeners.values()].reduce((total, set) => total + set.size, 0); }
}
function fixture({ storage = new Map(), origin = 1 } = {}) {
  const window = new Events(), document = new Events(), bus = new Events();
  const frames = new Map(), timers = new Map(), frameHooks = new Set();
  let serial = 0, resolvePages, now = Date.now();
  const pagesPromise = new Promise(resolve => { resolvePages = resolve; });
  const ids = new Map();
  const element = (id = '') => ({ id, tagName: 'DIV', dataset: {}, isConnected: true,
    closest(selector) {
      if (selector !== '.page[data-page-number]') return null;
      for (let node = this; node; node = node.parentElement) {
        if (node.className === 'page' && node.dataset.pageNumber) return node;
      }
      return null;
    },
    contains(value) { for (let node = value; node; node = node.parentElement) if (node === this) return true; return false; },
    focus(options) { this.lastFocusOptions = options; document.activeElement = this; },
    blur() { document.activeElement = document.body; } });
  document.body = element(); document.documentElement = element(); document.activeElement = document.body;
  document.visibilityState = 'visible'; document.hasFocus = () => true;
  document.getElementById = id => ids.get(id) ?? null;
  document.querySelectorAll = selector => selector.startsWith('#') && ids.has(selector.slice(1)) ? [ids.get(selector.slice(1))] : [];
  let scaleValue = '0.5', scale = 0.5, rejectScale = false;
  const pages = new Map();
  const viewer = { currentPageNumber: 59, pagesRotation: 0, scrollMode: 0, spreadMode: 1,
    container: Object.assign(element('viewerContainer'), { scrollTop: 1000, scrollLeft: 0 }), pagesPromise,
    getPageView: index => pages.get(index + 1),
    scrollPageIntoView({ pageNumber }) { this.currentPageNumber = pageNumber; this.container.scrollTop = pageNumber * 10; } };
  const page = (number, connected = true) => {
    const div = Object.assign(element(), { className: 'page', dataset: { pageNumber: String(number) }, parentElement: viewer.container });
    const layer = Object.assign(element(), { className: 'textLayer', tabIndex: 0, parentElement: div, isConnected: connected });
    const value = { id: number, div, textLayer: { div: layer } }; pages.set(number, value); return value;
  };
  Object.defineProperties(viewer, {
    currentScaleValue: { get: () => scaleValue, set: value => { scaleValue = value; if (!rejectScale) scale = Number(value); } },
    currentScale: { get: () => scale },
  });
  const pdfDocument = { numPages: 460 }; viewer.pdfDocument = pdfDocument;
  const app = { initializedPromise: Promise.resolve(), pdfViewer: viewer, pdfDocument, isInitialViewSet: false,
    eventBus: bus, url: 'https://cloud.larics.fer.hr' + pdfPath,
    pdfSidebar: { visibleView: 2, close() { this.visibleView = 0; }, switchView(value) { this.visibleView = value; } } };
  const prefetch = { robotsEnabled: true, diagnosticsEnabled: false,
    setRobotsEnabled(value) { this.robotsEnabled = value; }, setDiagnosticsEnabled(value) { this.diagnosticsEnabled = value; } };
  const location = { origin: 'https://cloud.larics.fer.hr', pathname: '/spomenar/', href: 'https://cloud.larics.fer.hr/spomenar/#page=59',
    reloads: 0, reload() { this.reloads++; } };
  Object.assign(window, { document, PDFViewerApplication: app, pdfPrefetch: prefetch, location,
    visualViewport: { scale: 1 }, performance: { timeOrigin: origin }, URL, URLSearchParams,
    Date: class extends Date { static now() { return now; } }, JSON, Number, Math, Promise, Error,
    CSS: { escape: value => value }, getSelection: () => ({ isCollapsed: true }),
    getComputedStyle: () => ({ getPropertyValue: () => '0' }),
    PointerEvent: class { constructor(type, options) { Object.assign(this, options, { type, isTrusted: false }); } },
    history: { state: {}, replaceState(_state, _title, href) { location.href = href; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    requestAnimationFrame(callback) { const id = ++serial; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay = 0) { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  window.window = window; window.top = window;
  const context = vm.createContext(window), install = vm.runInContext(source, context);
  const api = () => window.__spomenarReleaseGuard;
  const frame = (elapsed = 16) => {
    now += elapsed;
    for (const hook of frameHooks) hook(now);
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    const current = [...frames.values()]; frames.clear(); for (const callback of current) callback();
  };
  return { window, document, app, viewer, prefetch, bus, storage, frames, timers, location, api, frame, element, ids,
    page, pages, frameHooks, get now() { return now; },
    rejectScale: value => { rejectScale = value; },
    install: options => install({ token: 'test-token', document: documentConfig,
      durationMs: 60000, bootstrap: false, ...options }),
    async init() { await drain(); app.isInitialViewSet = true; bus.dispatch('documentinit'); },
    resolvePages,
    async ready() { await this.init(); resolvePages(); await drain(); frame(); await drain(); frame(); await drain(); assert.equal(api().status().ready, true); },
    async drive(promise) {
      let settled = false, result, error;
      promise.then(value => { result = value; settled = true; }, reason => { error = reason; settled = true; });
      for (let i = 0; i < 1000 && !settled; i++) { await drain(); frame(); }
      await drain(); assert.equal(settled, true, 'the real guard operation must finish with bounded frames');
      if (error) throw error; return result;
    },
    async dispose() {
      api()?.dispose(); await drain();
      assert.equal(document.count + window.count + bus.count + frames.size + timers.size, 0);
      assert.equal(window.__spomenarReleaseGuard, undefined);
    },
  };
}

const rect = (x, y, width, height) => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height,
  toJSON() { return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }; } });
function panelFixture(f, { dock = 'float', bounds = rect(180, 80, 320, 240), viewportWidth = 800, viewportHeight = 700 } = {}) {
  let current = bounds, currentDock = dock, animation, column, columnX = 0, pointer;
  const actions = [], overlaps = [], details = { open: false }, handles = new Map(), controls = new Map();
  const host = Object.assign(f.element('pdf-prefetch-diagnostics'), { hidden: false, dataset: { dock } });
  const floating = rect(100, 70, 240, 220);
  const root = { activeElement: null };
  host.shadowRoot = root; f.ids.set(host.id, host); f.prefetch.diagnosticsEnabled = true;
  const surface = { getBoundingClientRect: () => current };
  function moveColumn(to) {
    column = { from: columnX, to, at: f.now };
    f.viewer.container.dataset.pdfColumnMoving = 'true';
  }
  function selectDock(value) {
    currentDock = value; host.dataset.dock = value;
    const to = value === 'float' ? floating : rect(value === 'left' ? 0 : 800 - current.width, 0, current.width, 700);
    animation = { from: current, to, at: f.now };
    host.dataset.panelMoving = 'true'; moveColumn(value === 'right' ? -40 : 40);
    actions.push({ kind: 'dock', value, at: f.now });
  }
  const makeHandle = direction => {
    const handle = Object.assign(f.element(), { dataset: direction ? { panelResize: direction } : {},
      getBoundingClientRect: () => rect(current.x, current.y, 20, 20),
      focus(options) { this.lastFocusOptions = options; root.activeElement = this; f.document.activeElement = host; },
      dispatchEvent(event) {
        if (event.type !== 'pointerdown') return;
        if (animation || host.dataset.panelMoving === 'true') overlaps.push({ direction, at: f.now });
        actions.push({ kind: direction ? 'resize' : 'drag', direction, at: f.now });
        animation = undefined; delete host.dataset.panelMoving;
        if (currentDock !== 'float' && direction !== (currentDock === 'left' ? 'e' : 'w')) {
          currentDock = 'float'; host.dataset.dock = 'float';
          actions.push({ kind: 'adopt-float', direction, at: f.now });
        }
        pointer = { direction, from: current, x: event.clientX, y: event.clientY };
      } });
    return handle;
  };
  const drag = makeHandle();
  for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) handles.set(direction, makeHandle(direction));
  for (const value of ['left', 'right', 'float']) controls.set(value, { click: () => selectDock(value) });
  root.querySelectorAll = selector => {
    if (selector === 'section') return [surface];
    if (selector === '.panel-drag') return [drag];
    if (selector === '.measurements') return [details];
    if (selector === '.panel-resize' || selector === '[data-panel-resize]') return [...handles.values()];
    const direction = selector.match(/^\[data-panel-resize="([a-z]+)"\]$/)?.[1];
    if (direction) return handles.has(direction) ? [handles.get(direction)] : [];
    const dock = selector.match(/^\[data-panel-dock="([a-z]+)"\]$/)?.[1];
    return dock && controls.has(dock) ? [controls.get(dock)] : [];
  };
  root.querySelector = selector => root.querySelectorAll(selector)[0];
  f.window.getComputedStyle = () => ({ getPropertyValue: () => String(columnX) });
  f.window.dispatchEvent = event => {
    if (event.type === 'pointerup') { pointer = undefined; return; }
    if (event.type !== 'pointermove' || !pointer) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y, from = pointer.from, direction = pointer.direction;
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    if (!direction) current = rect(clamp(from.x + dx, 8, viewportWidth - 8 - from.width),
      clamp(from.y + dy, 8, viewportHeight - 8 - from.height), from.width, from.height);
    else {
      const west = direction.includes('w'), north = direction.includes('n');
      const left = west ? clamp(from.x + dx, 8, from.right - 240) : from.x;
      const right = direction.includes('e') ? clamp(from.right + dx, from.x + 240, viewportWidth - 8) : from.right;
      const top = currentDock === 'float' && north ? clamp(from.y + dy, 8, from.bottom - 160) : from.y;
      const bottom = currentDock === 'float' && direction.includes('s')
        ? clamp(from.bottom + dy, from.y + 160, viewportHeight - 8) : from.bottom;
      current = rect(left, top, right - left, bottom - top);
    }
    moveColumn(columnX + 12);
  };
  f.prefetch.setDiagnosticsEnabled = value => { f.prefetch.diagnosticsEnabled = value; host.hidden = !value; };
  f.frameHooks.add(now => {
    if (column) {
      const progress = Math.min(1, Math.max(0, (now - column.at - 500) / 1800));
      columnX = column.from + (column.to - column.from) * progress;
      if (now >= column.at + 2500) { column = undefined; delete f.viewer.container.dataset.pdfColumnMoving; }
    }
    if (animation) {
      const progress = Math.min(1, Math.max(0, (now - animation.at - 2500) / 1200));
      current = rect(...['x', 'y', 'width', 'height'].map(key => animation.from[key] + (animation.to[key] - animation.from[key]) * progress));
      if (now >= animation.at + 3700) { animation = undefined; delete host.dataset.panelMoving; }
    }
  });
  return { host, root, handles, actions, overlaps, selectDock,
    configure(value, bounds) { currentDock = value; host.dataset.dock = value; current = bounds; },
    snapshot: () => ({ dock: currentDock, rect: current.toJSON(), measurements: details.open }) };
}

test('initial view waits for the actual pages promise and both later frames', async () => {
  const f = fixture(); f.install(); await f.init(); await drain();
  assert.equal(f.api().status().ready, false);
  assert.throws(() => f.api().capture(), /initial view has not settled/);
  f.resolvePages(); await drain();
  assert.equal(f.api().status().ready, false);
  f.frame(); await drain(); assert.equal(f.api().status().ready, false);
  f.frame(); await drain(); assert.equal(f.api().status().ready, true);
  await f.dispose(); assert.equal(f.storage.size, 0);
});

test('configured reader and PDF identity replace installation-specific paths', async () => {
  const f = fixture(), configuration = { ...documentConfig,
    pageUrl: 'https://reader.example.test/book/', entryUrl: 'https://reader.example.test/book/main.mjs',
    pdfUrl: 'https://reader.example.test/assets/exact.pdf?version=7' };
  Object.assign(f.location, { origin: 'https://reader.example.test', pathname: '/book/', href: configuration.pageUrl + '#page=59' });
  f.app.url = configuration.pdfUrl;
  f.install({ document: configuration });
  assert.ok(f.api(), 'the guard installs on the explicitly configured owned reader');
  await f.ready(); assert.equal(f.api().capture().page, 59);
  f.app.url = 'https://reader.example.test/assets/exact.pdf?version=8';
  assert.equal(f.api().status().ready, false, 'another query generation is not the configured PDF');
  await f.dispose();
});

test('visible activation records false hasFocus without treating it as a hidden reader', async () => {
  const f = fixture(); f.document.hasFocus = () => false; f.install(); await f.ready();
  const status = f.api().status(); assert.equal(status.visible, true); assert.equal(status.focused, false);
  assert.equal(f.api().capture().page, 59);
  f.document.visibilityState = 'hidden'; f.document.emit('visibilitychange');
  assert.throws(() => f.api().capture(), /interruption|visible/i);
  await f.dispose();
});

test('our old-document hide and pagehide are recorded as permitted reload lifecycle', async () => {
  const old = fixture(); old.install(); await old.ready();
  const expiresAt = old.api().reload(old.api().capture(true)).expiresAt;
  assert.equal(old.location.reloads, 1);
  old.document.visibilityState = 'hidden'; old.document.emit('visibilitychange'); old.window.emit('pagehide', { isTrusted: true });
  assert.equal(old.api().status().interrupted, false);
  assert.deepEqual(Array.from(old.api().status().reloadLifecycle), ['visibilitychange', 'pagehide']);
  const fresh = fixture({ storage: old.storage, origin: 2 }); fresh.install({ bootstrap: true, expiresAt }); await fresh.ready();
  assert.equal(fresh.api().status().interrupted, false);
  assert.deepEqual(Array.from(fresh.api().status().reloadLifecycle), ['visibilitychange', 'pagehide']);
  await fresh.dispose(); await old.dispose(); assert.equal(old.storage.size, 0);
});

test('trusted input in the armed old document survives bootstrap and prevents new-state rollback', async () => {
  const old = fixture(); old.install(); await old.ready(); const saved = old.api().capture();
  const expiresAt = old.api().reload(saved).expiresAt;
  old.document.emit('pointerdown', { isTrusted: false }); assert.equal(old.api().status().interrupted, false);
  old.document.emit('touchstart', { isTrusted: true });
  const fresh = fixture({ storage: old.storage, origin: 2 }); fresh.install({ bootstrap: true, expiresAt }); await fresh.ready();
  assert.equal(fresh.api().status().reason, 'touchstart');
  await assert.rejects(fresh.api().restore(saved), /User interruption/);
  assert.equal(fresh.viewer.currentPageNumber, 59);
  await fresh.dispose(); await old.dispose();
});

test('independent new-document hiding remains an interruption', async () => {
  const f = fixture(); f.install(); await f.ready();
  f.document.visibilityState = 'hidden'; f.document.emit('visibilitychange');
  assert.equal(f.api().status().interrupted, true); assert.equal(f.api().status().reason, 'hidden');
  await f.dispose();
});

test('non-unit pinch and unrecoverable focus fail capture before navigation', async () => {
  const f = fixture(); f.install(); await f.ready();
  f.window.visualViewport.scale = 1.5; assert.throws(() => f.api().capture(), /pinch cannot be restored/);
  f.window.visualViewport.scale = 1;
  f.document.activeElement = { id: '', closest: () => null };
  assert.throws(() => f.api().capture(), /focused control cannot be restored/);
  await f.dispose();
});

test('restore preserves sidebar, modes, exact offsets, hash, robots and focus', async () => {
  const f = fixture(); f.install(); await f.ready(); const saved = f.api().capture();
  f.viewer.currentPageNumber = 1; f.viewer.container.scrollTop = 0; f.viewer.container.scrollLeft = 20;
  f.viewer.pagesRotation = 90; f.viewer.scrollMode = 1; f.viewer.spreadMode = 0;
  f.viewer.currentScaleValue = '0.3'; f.app.pdfSidebar.visibleView = 0; f.prefetch.robotsEnabled = false;
  f.location.href = 'https://cloud.larics.fer.hr/spomenar/#page=1';
  const result = await f.drive(f.api().restore(saved));
  assert.equal(result.exact, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.state)), JSON.parse(JSON.stringify(saved)));
  await f.dispose();
});

test('a refused scale mutation fails the actual restoration equality check', async () => {
  const f = fixture(); f.install(); await f.ready(); const saved = f.api().capture();
  f.viewer.currentScaleValue = '0.3'; f.rejectScale(true);
  await assert.rejects(f.drive(f.api().restore(saved)), /Reading restoration differs: scale/);
  await f.dispose();
});

test('BODY restoration blurs the native viewer when BODY.focus is a no-op', async () => {
  const f = fixture(); f.document.body.focus = () => {};
  f.install(); await f.ready(); const saved = f.api().capture();
  f.viewer.container.focus();
  assert.equal(f.document.activeElement, f.viewer.container);
  const restored = await f.drive(f.api().restore(saved));
  assert.equal(restored.exact, true); assert.equal(f.document.activeElement, f.document.body);
  await f.dispose();
});

test('a shadow-focused ID cannot alias an unrelated light-DOM focus target', async () => {
  const f = fixture(); f.install(); await f.ready();
  const shadowButton = f.element('shared-control'), lightButton = f.element('shared-control');
  f.ids.set(lightButton.id, lightButton);
  f.document.activeElement = { shadowRoot: { activeElement: shadowButton } };
  assert.throws(() => f.api().capture(), /focused control cannot be restored unambiguously/);
  f.document.activeElement = lightButton;
  assert.deepEqual(JSON.parse(JSON.stringify(f.api().capture().focus)), { kind: 'id', id: 'shared-control' });
  await f.dispose();
});

test('a canonical anonymous page text layer restores into the new document instance', async t => {
  const old = fixture(); t.after(() => old.dispose()); old.install(); await old.ready();
  const oldPage = old.page(59); oldPage.textLayer.div.focus();
  const saved = old.api().capture(true);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.focus)), { kind: 'page-text', pageNumber: 59 });
  const expiresAt = old.api().reload(saved).expiresAt;
  const fresh = fixture({ storage: old.storage, origin: 2 }); t.after(() => fresh.dispose());
  const newPage = fresh.page(59); fresh.viewer.currentPageNumber = 1; fresh.viewer.container.scrollTop = 0;
  fresh.install({ bootstrap: true, expiresAt }); await fresh.ready(); fresh.viewer.container.focus();
  const restored = await fresh.drive(fresh.api().restore(saved));
  assert.equal(restored.exact, true);
  assert.equal(fresh.document.activeElement, newPage.textLayer.div);
  assert.notEqual(fresh.document.activeElement, oldPage.textLayer.div);
  assert.equal(newPage.textLayer.div.lastFocusOptions.preventScroll, true);
  assert.equal(fresh.viewer.container.scrollTop, saved.top);
});

test('page text focus rejects lookalikes, nested controls and mismatched page ownership', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.install(); await f.ready();
  const page = f.page(59);
  const impostor = Object.assign(f.element(), { className: 'textLayer', tabIndex: 0, parentElement: page.div });
  const child = Object.assign(f.element(), { parentElement: page.textLayer.div });
  for (const target of [impostor, child]) {
    target.focus(); assert.throws(() => f.api().capture(true), /focused control cannot be restored/);
  }
  page.textLayer.div.focus(); page.id = 60;
  assert.throws(() => f.api().capture(true), /focused control cannot be restored/);
  page.id = 59; page.div.parentElement = undefined;
  assert.throws(() => f.api().capture(true), /focused control cannot be restored/);
  assert.equal(f.location.reloads, 0);
});

test('restoration waits for the authoritative text layer to connect after the initial view', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.install(); await f.ready();
  const saved = f.api().capture(); saved.focus = { kind: 'page-text', pageNumber: 59 };
  const page = f.page(59, false); f.viewer.currentPageNumber = 1; f.viewer.container.scrollTop = 0;
  let complete = false;
  const pending = f.api().restore(saved); pending.then(() => { complete = true; }, () => {});
  for (let i = 0; i < 6; i++) { await drain(); f.frame(); }
  assert.equal(complete, false);
  assert.equal(f.document.activeElement, f.document.body);
  page.textLayer.div.isConnected = true; f.bus.emit('textlayerrendered', { pageNumber: 59 });
  const restored = await f.drive(pending);
  assert.equal(restored.exact, true);
  assert.equal(f.document.activeElement, page.textLayer.div);
  assert.equal(f.viewer.container.scrollTop, saved.top);
});

test('trusted input or expiry cancels a pending page text focus without a late focus change', async t => {
  for (const reason of ['input', 'expiry']) {
    const f = fixture(); t.after(() => f.dispose()); f.install(); await f.ready();
    const saved = f.api().capture(); saved.focus = { kind: 'page-text', pageNumber: 59 };
    const page = f.page(59, false), pending = f.api().restore(saved);
    let complete = false; pending.then(() => { complete = true; }, () => { complete = true; });
    const rejected = assert.rejects(pending);
    for (let i = 0; i < 5; i++) { await drain(); f.frame(); }
    assert.equal(complete, false, 'the target is still disconnected when cancellation arrives');
    if (reason === 'input') f.document.emit('touchstart', { isTrusted: true });
    else f.frame(60000);
    await rejected; page.textLayer.div.isConnected = true; f.frame(); await drain();
    assert.equal(f.document.activeElement, f.document.body);
    assert.equal(f.frames.size, 0);
  }
});

test('reload capture rejects a moving column without blocking ordinary state inspection', async t => {
  const f = fixture(); t.after(() => f.dispose()); f.install(); await f.ready();
  f.viewer.container.dataset.pdfColumnMoving = 'true';
  assert.throws(() => f.api().capture(true), /moving|settle/i);
  assert.equal(f.api().capture().page, 59);
  assert.equal(f.location.reloads, 0);
  delete f.viewer.container.dataset.pdfColumnMoving;
  assert.equal(f.api().capture(true).page, 59);
});

test('reload capture rejects the stationary panel wait and its later glide', async t => {
  const f = fixture(); t.after(() => f.dispose()); const panel = panelFixture(f);
  f.install(); await f.ready(); panel.selectDock('right');
  const initial = panel.snapshot();
  assert.throws(() => f.api().capture(true), /moving|settle/i);
  assert.equal(f.api().capture().panel.rect.x, initial.rect.x);
  f.frame(2600); await drain();
  assert.equal(f.viewer.container.dataset.pdfColumnMoving, undefined);
  assert.equal(panel.host.dataset.panelMoving, 'true');
  assert.throws(() => f.api().capture(true), /moving|settle/i);
  f.frame(1200); await drain();
  assert.equal(f.api().capture(true).panel.dock, 'right');
  assert.equal(f.location.reloads, 0);
});

test('all eight stable resize handles preserve their own focus identity', async t => {
  const f = fixture(); t.after(() => f.dispose()); const panel = panelFixture(f);
  f.install(); await f.ready();
  for (const [direction, handle] of panel.handles) {
    handle.focus(); const saved = f.api().capture(true);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.focus)), { kind: 'panel', selector: '[data-panel-resize="' + direction + '"]' });
    f.document.body.focus(); panel.root.activeElement = null;
    const restored = await f.drive(f.api().restore(saved));
    assert.equal(restored.exact, true);
    assert.equal(panel.root.activeElement, handle);
  }
  const handle = panel.handles.get('se'); handle.focus(); const saved = f.api().capture(true);
  const select = panel.root.querySelectorAll;
  panel.root.querySelectorAll = selector => selector === '[data-panel-resize="se"]' ? [handle, f.element()] : select(selector);
  assert.throws(() => f.api().capture(true), /focused control cannot be restored/);
  f.document.body.focus(); panel.root.activeElement = null;
  await assert.rejects(f.drive(f.api().restore(saved)), /saved focused control is missing/);
  assert.equal(f.document.activeElement, f.document.body);
});

test('saved Lab restoration waits for finite dock and column motion before geometry correction', async t => {
  for (const dock of ['left', 'right', 'float']) {
    const f = fixture(); t.after(() => f.dispose());
    const bounds = dock === 'float' ? rect(180, 80, 320, 240) : rect(dock === 'right' ? 440 : 0, 0, 360, 700);
    const panel = panelFixture(f, { dock, bounds });
    f.install(); await f.ready(); const saved = f.api().capture(true), began = f.now;
    panel.configure(dock === 'float' ? 'right' : 'float', dock === 'float' ? rect(560, 0, 240, 700) : rect(100, 70, 240, 220));
    f.viewer.currentPageNumber = 1; f.viewer.container.scrollTop = 0;
    const pending = f.api().restore(saved); pending.catch(() => {});
    for (let i = 0; i < 10; i++) { await drain(); f.frame(); }
    assert.equal(panel.actions.filter(action => action.kind !== 'dock').length, 0, 'stationary approach cannot be mistaken for dock completion');
    const restored = await f.drive(pending);
    assert.equal(restored.exact, true);
    assert.deepEqual(panel.overlaps, []);
    assert.equal(panel.actions.find(action => action.kind === 'resize').direction, dock === 'float' ? 'se' : dock === 'right' ? 'w' : 'e');
    assert.equal(panel.actions.some(action => action.kind === 'adopt-float'), false, 'width restoration must preserve the saved dock');
    assert.equal(f.viewer.container.dataset.pdfColumnMoving, undefined);
    assert.equal(panel.host.dataset.panelMoving, undefined);
    assert.deepEqual(panel.snapshot(), JSON.parse(JSON.stringify(saved.panel)));
    assert.ok(f.now - began >= 6200 && f.now - began < 8000, 'the actual phases fit the existing normal restore deadline');
  }
});

test('matching panel coordinates during the stationary approach do not bypass restoration settling', async t => {
  const f = fixture(); t.after(() => f.dispose()); const panel = panelFixture(f);
  f.install(); await f.ready(); const saved = f.api().capture(true);
  panel.selectDock('float');
  let complete = false;
  const pending = f.api().restore(saved); pending.then(() => { complete = true; }, () => {});
  for (let i = 0; i < 10; i++) { await drain(); f.frame(); }
  assert.equal(complete, false, 'the matching start rectangle is not the final arrangement');
  const restored = await f.drive(pending);
  assert.equal(restored.exact, true);
  assert.equal(panel.host.dataset.panelMoving, undefined);
  assert.equal(f.viewer.container.dataset.pdfColumnMoving, undefined);
  assert.deepEqual(panel.snapshot(), JSON.parse(JSON.stringify(saved.panel)));
});

test('viewport-clamped floating restoration moves before growing and corrects position after shrinking', async t => {
  for (const [savedRect, changedRect] of [
    [rect(100, 80, 600, 300), rect(700, 80, 292, 300)],
    [rect(700, 80, 292, 300), rect(100, 80, 600, 300)],
  ]) {
    const f = fixture(); t.after(() => f.dispose());
    const panel = panelFixture(f, { bounds: savedRect, viewportWidth: 1000 });
    f.install(); await f.ready(); const saved = f.api().capture(true), began = f.now;
    panel.configure('float', changedRect);
    const restored = await f.drive(f.api().restore(saved));
    assert.equal(restored.exact, true);
    assert.deepEqual(panel.snapshot(), JSON.parse(JSON.stringify(saved.panel)));
    assert.equal(panel.actions[0].kind, 'drag');
    const gestures = panel.actions.filter(action => action.kind === 'drag' || action.kind === 'resize');
    assert.ok(gestures.some(action => action.kind === 'resize'));
    assert.equal(new Set(gestures.map(action => action.at)).size, 1, 'direct gestures share one column settling period');
    assert.ok(f.now - began < 3000);
  }
});

test('trusted input during saved Lab motion prevents later restoration gestures', async t => {
  const f = fixture(); t.after(() => f.dispose()); const panel = panelFixture(f, { dock: 'right', bounds: rect(440, 0, 360, 700) });
  f.install(); await f.ready(); const saved = f.api().capture(true);
  panel.configure('float', rect(100, 70, 240, 220));
  const pending = f.api().restore(saved), rejected = assert.rejects(pending);
  let complete = false; pending.then(() => { complete = true; }, () => { complete = true; });
  for (let i = 0; i < 10; i++) { await drain(); f.frame(); }
  assert.equal(complete, false, 'input arrives while the dock is still being restored');
  const before = panel.actions.length;
  f.viewer.currentPageNumber = 311; f.document.emit('touchstart', { isTrusted: true });
  await rejected; f.frame(4000); await drain();
  assert.equal(f.viewer.currentPageNumber, 311);
  assert.equal(panel.actions.length, before);
  assert.equal(f.frames.size, 0);
});

test('reload preflight admits only numeric page and exact synchronous zoom bookmarks', async () => {
  const f = fixture(); f.install(); await f.ready();
  for (const hash of ['page=59', 'page=59&zoom=page-width', 'PAGE=59&zoom=90,-1,2147483647', '%70age=59&zoom=auto,0,0']) {
    f.location.href = 'https://cloud.larics.fer.hr/spomenar/#' + hash;
    assert.equal(f.api().capture(true).page, 59);
  }
  for (const hash of ['Chapter1', '[1,{"name":"Fit"}]', 'page=59&search=', 'page=59&%53earch=robot',
    'page=59&nameddest=Chapter1', 'page=59&pagemode=thumbs', 'page=59&PAGE=60', 'page=461',
    'page=59&zoom=90junk', 'page=59&zoom=Fit', 'page=59&zoom=90,0,2147483648', 'zoom=page-width']) {
    f.location.href = 'https://cloud.larics.fer.hr/spomenar/#' + hash;
    assert.throws(() => f.api().capture(true), /synchronous page\/zoom bookmark/, hash);
    assert.equal(f.api().capture().page, 59, 'ordinary inspection remains independent');
  }
  await f.dispose();
});

test('an empty default URL can reload and restore the captured numeric reading view', async () => {
  const old = fixture(); old.location.href = 'https://cloud.larics.fer.hr/spomenar/';
  old.app.initialBookmark = ''; old.app.pdfHistory = { initialBookmark: null };
  old.window.history.state = { destination: null };
  old.install(); await old.ready(); const saved = old.api().capture(true);
  const expiresAt = old.api().reload(saved).expiresAt;
  assert.equal(old.location.reloads, 1);
  const fresh = fixture({ storage: old.storage, origin: 2 });
  fresh.location.href = saved.url; fresh.app.initialBookmark = '';
  fresh.viewer.currentPageNumber = 1; fresh.viewer.currentScaleValue = '0.7';
  fresh.viewer.container.scrollTop = 0; fresh.viewer.spreadMode = 0; fresh.app.pdfSidebar.visibleView = 0;
  fresh.install({ bootstrap: true, expiresAt }); await fresh.ready(); fresh.viewer.container.focus();
  const restored = await fresh.drive(fresh.api().restore(saved));
  assert.equal(restored.exact, true);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.state)), JSON.parse(JSON.stringify(saved)));
  assert.equal(fresh.location.href, 'https://cloud.larics.fer.hr/spomenar/');
  await fresh.dispose(); await old.dispose();
});

test('reload preflight also rejects an effective named or search history destination', async () => {
  const f = fixture(); f.install(); await f.ready();
  f.app.initialBookmark = 'nameddest=Chapter1';
  assert.throws(() => f.api().capture(true), /synchronous page\/zoom bookmark/);
  f.app.initialBookmark = null; f.app.pdfHistory = { initialBookmark: 'page=59&search=robot' };
  assert.throws(() => f.api().capture(true), /synchronous page\/zoom bookmark/);
  f.app.pdfHistory.initialBookmark = 'page=59';
  f.window.history.state = { destination: { dest: [1, { name: 'XYZ' }, 0, 0, null] } };
  assert.throws(() => f.api().capture(true), /synchronous page\/zoom bookmark/);
  f.window.history.state = { destination: { hash: 'page=59&zoom=page-width' } };
  assert.equal(f.api().capture(true).page, 59);
  await f.dispose();
});

test('the atomic reload rechecks trusted input and the captured reader before navigation', async () => {
  const f = fixture(); f.install(); await f.ready(); const saved = f.api().capture(true);
  f.viewer.container.scrollTop += 1;
  assert.throws(() => f.api().reload(saved), /Reading state changed before reload/);
  assert.equal(f.location.reloads, 0);
  f.viewer.container.scrollTop = saved.top;
  f.document.emit('touchstart', { isTrusted: true });
  assert.throws(() => f.api().reload(saved), /User interruption/);
  assert.equal(f.location.reloads, 0);
  await f.dispose();
});

test('expired or missing bootstrap token installs no listener or frame loop', async () => {
  const f = fixture(); assert.equal(f.install({ expiresAt: Date.now() - 1 }), undefined);
  assert.throws(() => f.install({ bootstrap: true, expiresAt: Date.now() + 1000 }), /continuity is missing/);
  await f.dispose(); assert.equal(f.storage.size, 0);
});
