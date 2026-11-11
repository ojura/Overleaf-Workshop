(options => {
  // @include reader-focus.mjs
  const name = '__spomenarReleaseGuard';
  const storageKey = name + ':' + options.token;
  const expected = options.document;
  if (!expected || !Number.isInteger(expected.pages) || expected.pages < 1) throw new Error('Invalid release document configuration');
  const pageUrl = new URL(expected.pageUrl), pdfUrl = new URL(expected.pdfUrl), currentUrl = new URL(location.href);
  if (window !== top || currentUrl.origin !== pageUrl.origin || currentUrl.pathname !== pageUrl.pathname
    || currentUrl.search !== pageUrl.search) return;
  if (window[name]) {
    if (window[name].token !== options.token) throw new Error('Another release guard owns this document');
    return window[name].status();
  }
  const expiresAt = options.expiresAt ?? Date.now() + options.durationMs;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  let record;
  if (options.bootstrap) {
    record = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (!record || record.token !== options.token || record.expiresAt !== expiresAt) throw new Error('Release guard continuity is missing');
  } else {
    if (sessionStorage.getItem(storageKey) !== null) throw new Error('Release guard token already exists');
    record = { token: options.token, expiresAt, interrupted: false, reason: null, reloadLifecycle: [] };
    sessionStorage.setItem(storageKey, JSON.stringify(record));
  }
  let disposed = false, navigating = false, seenVisible = document.visibilityState === 'visible';
  let app, viewer, boundApp, bus, initialDocument, initialEpoch = 0, layoutSettled = false;
  const frames = new Set(), waiters = new Set();
  const types = ['touchstart', 'touchmove', 'gesturestart', 'gesturechange', 'pointerdown', 'keydown', 'wheel'];
  const validDocument = () => app?.pdfDocument && viewer?.pdfDocument === app.pdfDocument
    && app.pdfDocument.numPages === expected.pages
    && new URL(app.url, location.href).href === pdfUrl.href;
  const visible = () => document.visibilityState === 'visible';
  const visualScale = () => window.visualViewport?.scale ?? 1;
  const storageRecord = () => JSON.parse(sessionStorage.getItem(storageKey) || 'null');
  const cancelWaits = reason => {
    for (const id of frames) cancelAnimationFrame(id);
    frames.clear();
    for (const reject of waiters) reject(new Error(reason));
    waiters.clear();
  };
  const interrupt = reason => {
    if (record.interrupted || disposed) return;
    record.interrupted = true; record.reason = reason;
    try { sessionStorage.setItem(storageKey, JSON.stringify(record)); } catch { record.reason = 'Guard storage failed'; }
    cancelWaits(record.reason);
  };
  const input = event => { if (event.isTrusted) interrupt(event.type); };
  const reloadLifecycle = type => {
    if (record.reloadLifecycle.length < 4) record.reloadLifecycle.push(type);
    sessionStorage.setItem(storageKey, JSON.stringify(record));
  };
  const visibility = () => {
    if (document.visibilityState === 'visible') seenVisible = true;
    else if (seenVisible) { if (navigating) reloadLifecycle('visibilitychange'); else interrupt('hidden'); }
  };
  const pagehide = () => { if (navigating) reloadLifecycle('pagehide'); else interrupt('pagehide'); };
  function guard(requireReady = false) {
    const stored = storageRecord();
    if (!stored || stored.token !== options.token || stored.expiresAt !== expiresAt) throw new Error('Release guard continuity was lost');
    if (stored.interrupted) { record = stored; throw new Error('User interruption: ' + record.reason); }
    if (disposed || Date.now() >= expiresAt) throw new Error('Release guard expired');
    if (!visible()) throw new Error('The owned Safari tab is not visible');
    if (!Number.isFinite(visualScale()) || Math.abs(visualScale() - 1) > 1e-6) throw new Error('Native pinch cannot be restored exactly');
    if (requireReady && (!validDocument() || !app.isInitialViewSet || !layoutSettled)) throw new Error('The exact initial view has not settled');
  }
  const nextFrame = () => new Promise((resolve, reject) => {
    waiters.add(reject);
    const id = requestAnimationFrame(() => {
      frames.delete(id); waiters.delete(reject);
      if (disposed) reject(new Error('Release guard disposed')); else resolve();
    });
    frames.add(id);
  });
  async function twoFrames() { await nextFrame(); await nextFrame(); }
  const documentInit = () => {
    const epoch = ++initialEpoch;
    initialDocument = app?.pdfDocument; layoutSettled = false;
    const pages = viewer?.pagesPromise;
    if (!initialDocument || !pages || typeof pages.then !== 'function') return;
    // The pinned viewer's second initial-view pass waits on this same pagesPromise.
    // Two later frames also follow its promise continuations and resulting layout.
    void Promise.resolve(pages).then(twoFrames).then(() => {
      if (!disposed && epoch === initialEpoch && app.pdfDocument === initialDocument) layoutSettled = true;
    }, () => {});
  };
  async function bind() {
    const candidate = window.PDFViewerApplication;
    if (!candidate || candidate === boundApp || disposed) return;
    boundApp = candidate;
    try { await candidate.initializedPromise; } catch { return; }
    if (disposed || candidate !== window.PDFViewerApplication) return;
    app = candidate; viewer = app.pdfViewer; bus = app.eventBus;
    bus?.on('documentinit', documentInit);
    if (app.isInitialViewSet && app.pdfDocument) documentInit();
  }
  const loaded = () => { void bind(); };
  const focusOwner = createReaderFocus({ document, window, viewer: () => viewer, pages: expected.pages,
    panelRoot: () => panel()?.root });
  function panel() {
    const host = document.getElementById('pdf-prefetch-diagnostics'), root = host?.shadowRoot;
    if (!root || host.hidden) return;
    const surface = root.querySelector('section');
    if (!surface) return;
    const direction = host.dataset.dock === 'right' ? 'w' : host.dataset.dock === 'left' ? 'e' : 'se';
    return { host, root, surface, drag: root.querySelector('.panel-drag'),
      resize: uniqueControl(root, '[data-panel-resize="' + direction + '"]') };
  }
  function uniqueControl(root, selector) {
    const matches = root?.querySelectorAll(selector);
    return matches?.length === 1 ? matches[0] : undefined;
  }
  function panelState() {
    const value = panel();
    if (!value) return null;
    return { dock: value.host.dataset.dock || 'float', rect: value.surface.getBoundingClientRect().toJSON(),
      measurements: !!value.root.querySelector('.measurements')?.open };
  }
  const arrangementMoving = () => document.getElementById('pdf-prefetch-diagnostics')?.dataset.panelMoving === 'true'
    || viewer?.container.dataset.pdfColumnMoving === 'true';
  function arrangementState() {
    return { panel: panelState(), columnX: Number.parseFloat(getComputedStyle(viewer.container)
      .getPropertyValue('--pdf-document-column-x')) || 0, page: viewer.currentPageNumber,
      top: viewer.container.scrollTop, left: viewer.container.scrollLeft };
  }
  function sameArrangement(left, right) {
    if (left.page !== right.page || ['columnX', 'top', 'left'].some(key => !near(left[key], right[key], 0.01))) return false;
    if (!left.panel || !right.panel) return left.panel === right.panel;
    return left.panel.dock === right.panel.dock && left.panel.measurements === right.panel.measurements
      && ['x', 'y', 'width', 'height'].every(key => near(left.panel.rect[key], right.panel.rect[key], 0.01));
  }
  async function settleArrangement() {
    let previous;
    for (;;) {
      guard(true);
      const current = arrangementState();
      if (!arrangementMoving()) {
        if (previous && sameArrangement(previous, current)) return;
        previous = current;
      } else previous = undefined;
      await nextFrame();
    }
  }
  async function restoreMeasurements(details, open) {
    let processed = false;
    const toggled = () => { processed = true; };
    details.addEventListener('toggle', toggled, { once: true });
    try {
      details.open = open;
      // Native details queues toggle; unchanged geometry before that event is not settled.
      while (!processed) { guard(true); await nextFrame(); }
      guard(true);
    } finally { details.removeEventListener('toggle', toggled); }
  }
  function assertReloadBookmark() {
    const reject = () => { throw new Error('Reload requires a synchronous page/zoom bookmark'); };
    const check = value => {
      if (typeof value !== 'string') reject();
      const hash = value.replace(/^#/, '');
      if (!hash.includes('=')) reject();
      const params = new Map();
      for (const [rawKey, item] of new URLSearchParams(hash)) {
        const key = rawKey.toLowerCase();
        if (!['page', 'zoom'].includes(key) || params.has(key)) reject();
        params.set(key, item);
      }
      const page = params.get('page');
      if (!/^[1-9]\d*$/.test(page ?? '') || !Number.isSafeInteger(Number(page)) || Number(page) > expected.pages) reject();
      if (params.has('zoom')) {
        const parts = params.get('zoom').split(','), zoom = parts[0];
        const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(zoom)
          && Number.isFinite(Number(zoom)) && Number(zoom) / 100 > 0;
        if (!numeric && !['page-actual', 'page-width', 'page-height', 'page-fit', 'auto'].includes(zoom)) reject();
        if (parts.length !== 1 && parts.length !== 3) reject();
        for (const coordinate of parts.slice(1)) {
          if (!/^[+-]?(?:0|[1-9]\d*)$/.test(coordinate) || Number(coordinate) < -2147483648 || Number(coordinate) > 2147483647) reject();
        }
      }
    };
    // Pinned setHash lowercases decoded keys. Search, named and explicit destinations
    // may finish after pagesPromise; this temporary reload only restores numeric views.
    // Empty URL hashes select the site's synchronous default/stored view. The
    // public entry uses PREVIOUS, which does not inject an open-action destination.
    const urlHash = new URL(location.href).hash;
    if (urlHash) check(urlHash);
    for (const value of [app?.initialBookmark, app?.pdfHistory?.initialBookmark]) if (value) check(value);
    const destination = history.state?.destination;
    if (destination?.dest) reject();
    if (destination?.hash) check(destination.hash);
    else if (destination?.page) check('page=' + destination.page);
  }
  function readState() {
    return { page: viewer.currentPageNumber, scale: viewer.currentScale, scaleValue: viewer.currentScaleValue,
      rotation: viewer.pagesRotation, scrollMode: viewer.scrollMode, spreadMode: viewer.spreadMode,
      sidebar: app.pdfSidebar?.visibleView ?? 0, top: viewer.container.scrollTop, left: viewer.container.scrollLeft,
      robots: window.pdfPrefetch.robotsEnabled, lab: window.pdfPrefetch.diagnosticsEnabled,
      panel: panelState(), focus: focusOwner.capture(), url: location.href, visualScale: visualScale() };
  }
  function capture(forReload = false) {
    guard(true);
    if (forReload) {
      if (arrangementMoving()) throw new Error('The Motion Lab arrangement is still moving');
      assertReloadBookmark();
    }
    const state = readState();
    if (state.lab && !state.panel) throw new Error('The open Motion Lab has no restorable geometry');
    if (['page', 'scale', 'top', 'left', 'rotation', 'scrollMode', 'spreadMode', 'sidebar'].some(key => !Number.isFinite(state[key]))) {
      throw new Error('Reading state is incomplete');
    }
    return state;
  }
  const near = (a, b, tolerance = 0.5) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  function differences(saved, current) {
    const errors = [];
    for (const key of ['page', 'scaleValue', 'rotation', 'scrollMode', 'spreadMode', 'sidebar', 'robots', 'lab', 'url']) {
      if (saved[key] !== current[key]) errors.push(key);
    }
    for (const key of ['top', 'left']) if (!near(saved[key], current[key])) errors.push(key);
    if (!near(saved.scale, current.scale, 1e-6)) errors.push('scale');
    if (!near(saved.visualScale, current.visualScale, 1e-6)) errors.push('visualScale');
    if (JSON.stringify(saved.focus) !== JSON.stringify(current.focus)) errors.push('focus');
    if (saved.lab) {
      if (!current.panel || saved.panel.dock !== current.panel.dock || saved.panel.measurements !== current.panel.measurements) errors.push('panel');
      else for (const key of ['x', 'y', 'width', 'height']) if (!near(saved.panel.rect[key], current.panel.rect[key], 1)) errors.push('panel.' + key);
    }
    return errors;
  }
  function dock(value) {
    guard(true);
    const button = panel()?.root.querySelector('[data-panel-dock="' + value + '"]');
    if (!button) throw new Error('Motion Lab dock control is missing');
    button.click();
  }
  function gesture(kind, dx, dy) {
    if (Math.abs(dx) + Math.abs(dy) < 0.25) return;
    guard(true);
    const handle = panel()?.[kind];
    if (!handle) throw new Error('Motion Lab geometry control is missing');
    const box = handle.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    const event = (type, px, py) => new PointerEvent(type, { pointerId: 90641, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: px, clientY: py, bubbles: true, composed: true, cancelable: true });
    try { handle.dispatchEvent(event('pointerdown', x, y)); window.dispatchEvent(event('pointermove', x + dx, y + dy)); }
    finally { window.dispatchEvent(event('pointerup', x + dx, y + dy)); }
  }
  async function restore(saved) {
    guard(true);
    if (new URL(saved.url).origin !== location.origin || new URL(saved.url).pathname !== location.pathname) throw new Error('Saved URL belongs to another page');
    const existing = capture();
    if (!differences(saved, existing).length && !arrangementMoving()) return { exact: true, state: existing };
    const sidebar = app.pdfSidebar;
    if ((sidebar?.visibleView ?? 0) !== saved.sidebar) {
      if (!sidebar) throw new Error('The saved sidebar is unavailable');
      if (saved.sidebar === 0) sidebar.close(); else sidebar.switchView(saved.sidebar, true);
    }
    if (viewer.pagesRotation !== saved.rotation) viewer.pagesRotation = saved.rotation;
    if (viewer.scrollMode !== saved.scrollMode) viewer.scrollMode = saved.scrollMode;
    if (viewer.spreadMode !== saved.spreadMode) viewer.spreadMode = saved.spreadMode;
    if (viewer.currentScaleValue !== saved.scaleValue) viewer.currentScaleValue = saved.scaleValue;
    viewer.scrollPageIntoView({ pageNumber: saved.page });
    viewer.container.scrollTop = saved.top; viewer.container.scrollLeft = saved.left;
    if (window.pdfPrefetch.robotsEnabled !== saved.robots) window.pdfPrefetch.setRobotsEnabled(saved.robots);
    if (window.pdfPrefetch.diagnosticsEnabled !== saved.lab) window.pdfPrefetch.setDiagnosticsEnabled(saved.lab);
    await twoFrames(); guard(true);
    if (saved.lab) {
      if (!panelState()) throw new Error('Motion Lab failed to reopen');
      const details = panel()?.root.querySelector('.measurements');
      if (details && details.open !== saved.panel.measurements) {
        await restoreMeasurements(details, saved.panel.measurements);
        await settleArrangement(); guard(true);
      }
      if (panelState().dock !== saved.panel.dock) dock(saved.panel.dock);
      await settleArrangement(); guard(true);
      let current = panelState();
      if (saved.panel.dock === 'float') {
        // Make room at the saved anchor before a bounded southeast resize.
        gesture('drag', saved.panel.rect.x - current.rect.x, saved.panel.rect.y - current.rect.y);
        current = panelState();
      }
      gesture('resize', (saved.panel.rect.width - current.rect.width) * (saved.panel.dock === 'right' ? -1 : 1),
        saved.panel.dock === 'float' ? saved.panel.rect.height - current.rect.height : 0);
      if (saved.panel.dock === 'float') {
        current = panelState(); gesture('drag', saved.panel.rect.x - current.rect.x, saved.panel.rect.y - current.rect.y);
      }
    }
    await settleArrangement(); guard(true);
    await focusOwner.restore(saved.focus, { guard: () => guard(true), nextFrame });
    await twoFrames(); guard(true);
    if (location.href !== saved.url) history.replaceState(history.state, '', saved.url);
    const current = capture(), changed = differences(saved, current);
    if (changed.length) throw new Error('Reading restoration differs: ' + changed.join(', '));
    return { exact: true, state: current };
  }
  async function restoreFocus(saved) {
    const ready = () => {
      guard(true);
      if (window.__spomenarSustainedProbe || window.__spomenarManualProbe || window.__spomenarSidecarProbe) {
        throw new Error('A phone observation still owns the reader');
      }
      if (arrangementMoving()) throw new Error('The reader arrangement is still moving');
      const changed = differences(saved, readState()).filter(key => key !== 'focus');
      if (changed.length) throw new Error('Focus recovery reader differs: ' + changed.join(', '));
    };
    ready();
    await focusOwner.restore(saved.focus, { guard: ready, nextFrame });
    await twoFrames(); ready();
    const current = capture(), changed = differences(saved, current);
    if (changed.length) throw new Error('Focus recovery differs: ' + changed.join(', '));
    return { exact: true, state: current };
  }
  function status() {
    const stored = storageRecord();
    if (stored?.token === options.token) record = stored;
    return { token: options.token, origin: performance.timeOrigin, expiresAt, interrupted: !!record.interrupted,
      reason: record.reason, reloadLifecycle: record.reloadLifecycle, disposed, visible: visible(), focused: document.hasFocus(), visualScale: visualScale(),
      ready: !!validDocument() && !!app?.isInitialViewSet && layoutSettled,
      initialViewSet: !!app?.isInitialViewSet, layoutSettled, pageCount: app?.pdfDocument?.numPages,
      pdfPath: app?.url ? new URL(app.url, location.href).pathname : null };
  }
  function dispose() {
    if (disposed) return;
    disposed = true; clearTimeout(timer); cancelWaits('Release guard disposed');
    for (const type of types) document.removeEventListener(type, input, true);
    window.removeEventListener('orientationchange', input); document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', pagehide);
    document.removeEventListener('webviewerloaded', loaded); bus?.off('documentinit', documentInit);
    try {
      const stored = storageRecord();
      if (stored?.token === options.token) sessionStorage.removeItem(storageKey);
    } finally { if (window[name] === api) delete window[name]; }
  }
  const api = { token: options.token, status, capture, restore, restoreFocus,
    reload(saved) {
      const current = capture(true);
      if (differences(saved, current).length) throw new Error('Reading state changed before reload');
      // One JavaScript turn keeps the final trusted-input check adjacent to navigation.
      navigating = true;
      try { location.reload(); } catch (error) { navigating = false; throw error; }
      return { ...status(), navigationRequested: true };
    },
    verify(saved) { const current = capture(); return { exact: differences(saved, current).length === 0, differences: differences(saved, current), state: current }; },
    dispose };
  window[name] = api;
  for (const type of types) document.addEventListener(type, input, { capture: true, passive: true });
  window.addEventListener('orientationchange', input, { passive: true });
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', pagehide);
  document.addEventListener('webviewerloaded', loaded);
  const timer = setTimeout(() => { try { dispose(); } catch { /* Host receipt reports storage cleanup when attached. */ } }, Math.max(1, expiresAt - Date.now()));
  void bind();
  return status();
})
