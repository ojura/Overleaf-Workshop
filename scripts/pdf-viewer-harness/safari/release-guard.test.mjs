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
  const frames = new Map(), timers = new Map(); let serial = 0, resolvePages;
  const pagesPromise = new Promise(resolve => { resolvePages = resolve; });
  const ids = new Map();
  const element = (id = '') => ({ id, isConnected: true, closest: () => null,
    focus() { document.activeElement = this; }, blur() { document.activeElement = document.body; } });
  document.body = element(); document.documentElement = element(); document.activeElement = document.body;
  document.visibilityState = 'visible'; document.hasFocus = () => true;
  document.getElementById = id => ids.get(id) ?? null;
  document.querySelectorAll = selector => selector.startsWith('#') && ids.has(selector.slice(1)) ? [ids.get(selector.slice(1))] : [];
  let scaleValue = '0.5', scale = 0.5, rejectScale = false;
  const viewer = { currentPageNumber: 59, pagesRotation: 0, scrollMode: 0, spreadMode: 1,
    container: Object.assign(element('viewerContainer'), { scrollTop: 1000, scrollLeft: 0 }), pagesPromise,
    scrollPageIntoView({ pageNumber }) { this.currentPageNumber = pageNumber; this.container.scrollTop = pageNumber * 10; } };
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
    visualViewport: { scale: 1 }, performance: { timeOrigin: origin }, URL, URLSearchParams, Date, JSON, Number, Math, Promise, Error,
    CSS: { escape: value => value }, getSelection: () => ({ isCollapsed: true }),
    history: { state: {}, replaceState(_state, _title, href) { location.href = href; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    requestAnimationFrame(callback) { const id = ++serial; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback) { const id = ++serial; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  window.window = window; window.top = window;
  const context = vm.createContext(window), install = vm.runInContext(source, context);
  const api = () => window.__spomenarReleaseGuard;
  const frame = () => { const current = [...frames.values()]; frames.clear(); for (const callback of current) callback(); };
  return { window, document, app, viewer, prefetch, bus, storage, frames, timers, location, api, frame, element, ids,
    rejectScale: value => { rejectScale = value; },
    install: options => install({ token: 'test-token', document: documentConfig,
      durationMs: 60000, bootstrap: false, ...options }),
    async init() { await drain(); app.isInitialViewSet = true; bus.dispatch('documentinit'); },
    resolvePages,
    async ready() { await this.init(); resolvePages(); await drain(); frame(); await drain(); frame(); await drain(); assert.equal(api().status().ready, true); },
    async drive(promise) {
      let settled = false, result, error;
      promise.then(value => { result = value; settled = true; }, reason => { error = reason; settled = true; });
      for (let i = 0; i < 20 && !settled; i++) { await drain(); frame(); }
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
