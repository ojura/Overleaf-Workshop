(async options => {
  // @include reader-focus.mjs
  // @include payload-observation.mjs
  // @include surface-observation.mjs
  // @include photo-evidence.mjs
  // @include scene-ready.mjs
  if (window.__spomenarSidecarProbe || window.__spomenarSustainedProbe) throw new Error('A phone observation is already active');
  const token = options?.token, expected = options?.document, targets = options?.pages ?? [99, 100];
  const budget = options?.budget;
  if (typeof token !== 'string' || token.length < 16 || token.length > 128 || !expected
      || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0
      || !Number.isInteger(expected.pages) || !Array.isArray(targets) || targets.length !== 2
      || new Set(targets).size !== 2 || targets.some(page => !Number.isInteger(page) || page < 1 || page > expected.pages)
      || !budget || ['activeMs', 'captureMs', 'finishMs', 'workMs', 'restoreMs', 'settleMs'].some(key => !Number.isSafeInteger(budget[key]) || budget[key] <= 0)
      || budget.workMs !== budget.activeMs + budget.captureMs + budget.finishMs) {
    throw new Error('Invalid short observation options');
  }
  const pageUrl = new URL(expected.pageUrl), pdfUrl = new URL(expected.pdfUrl), here = new URL(location.href);
  if (here.origin !== pageUrl.origin || here.pathname !== pageUrl.pathname || here.search !== pageUrl.search
      || pdfUrl.origin !== pageUrl.origin) throw new Error('Unexpected reader origin');
  const app = window.PDFViewerApplication, prefetch = window.pdfPrefetch;
  const viewer = app?.pdfViewer, pdfDocument = app?.pdfDocument, container = viewer?.container;
  const expectedPath = pdfUrl.pathname;
  if (!container || !pdfDocument || pdfDocument.numPages !== expected.pages
      || new URL(app.url, location.href).href !== pdfUrl.href) throw new Error('The live document is not the exact expected edition');
  if (document.visibilityState !== 'visible') throw new Error('The current Safari page is not visible');
  const focusOwner = createReaderFocus({ document, window, viewer: () => viewer, pages: expected.pages,
    panelRoot: () => {
      const host = document.getElementById('pdf-prefetch-diagnostics');
      return host && !host.hidden ? host.shadowRoot : undefined;
    } });
  const savedFocus = focusOwner.capture();
  const readState = () => ({ page: viewer.currentPageNumber, scaleValue: viewer.currentScaleValue, scale: viewer.currentScale,
    rotation: viewer.pagesRotation, scrollMode: viewer.scrollMode, spreadMode: viewer.spreadMode,
    sidebar: app.pdfSidebar?.visibleView, top: container.scrollTop, left: container.scrollLeft,
    robots: prefetch.robotsEnabled, lab: prefetch.diagnosticsEnabled });
  const saved = readState();
  const result = { phase: 'preparing', token, expected, budget: { ...budget }, startedAt: performance.now(), saved, savedFocus, focused: document.hasFocus(), samples: [], events: [], entries: [], errors: [],
    refinements: [], retirements: [], interrupted: false, initialGeometry: { scrollWidth: container.scrollWidth,
      scrollHeight: container.scrollHeight, clientWidth: container.clientWidth, clientHeight: container.clientHeight } };
  const eventSequences = new Set(), payloadObservations = new PayloadObservations(), request = new AbortController();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const panel = () => {
    const host = document.getElementById('pdf-prefetch-diagnostics');
    const root = host?.shadowRoot;
    if (!root || host.hidden) return;
    const dock = host.dataset.dock || 'float', direction = dock === 'right' ? 'w' : dock === 'left' ? 'e' : 'se';
    const handles = root.querySelectorAll('[data-panel-resize="' + direction + '"]');
    return { host, root, surface: root.querySelector('section'), drag: root.querySelector('.panel-drag'),
      resize: handles.length === 1 ? handles[0] : undefined, dock };
  };
  const panelState = () => {
    const value = panel();
    if (!value) return;
    return { dock: value.dock, rect: value.surface.getBoundingClientRect().toJSON(),
      measurements: !!value.root.querySelector('.measurements')?.open,
      columnX: Number.parseFloat(getComputedStyle(container).getPropertyValue('--pdf-document-column-x')) || 0 };
  };
  result.savedPanel = panelState();
  result.focusRecovery = { ...saved, focus: savedFocus, panel: result.savedPanel ?? null,
    url: location.href, visualScale: window.visualViewport?.scale ?? 1 };
  const surfaces = observeReaderSurfaces({viewer,container,bus:app.eventBus,document,window,now:()=>performance.now(),
    requestFrame:callback=>requestAnimationFrame(callback),cancelFrame:id=>cancelAnimationFrame(id),style:getComputedStyle,MutationObserver,
    phase: () => result.phase});
  result.surfaceObservation = surfaces.result;
  let activeTimer, timer, disposed = false, changed = false, closing = false, panelRestore, restoreInFlight, closeInFlight;
  const focusWaits = new Set();
  const nextFocusFrame = deadline => new Promise((resolve, reject) => {
    let frame, timeout, finished = false;
    const finish = error => {
      if (finished) return;
      finished = true; cancelAnimationFrame(frame); clearTimeout(timeout); focusWaits.delete(cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(new Error('Observation closed'));
    focusWaits.add(cancel);
    frame = requestAnimationFrame(() => finish());
    timeout = setTimeout(() => finish(new Error('Focus restoration deadline expired')),
      Math.max(1, deadline - performance.now()));
    if (disposed) cancel();
  });
  const current = () => app.pdfDocument === pdfDocument && viewer.pdfDocument === pdfDocument
    && new URL(app.url, location.href).href === pdfUrl.href;
  const stop = event => {
    if (!event.isTrusted) return;
    result.interrupted = true; result.interruption = event.type;
    request.abort(); dispose();
  };
  const hidden = () => {
    if (document.visibilityState === 'visible') return;
    result.interrupted = true; result.interruption = 'hidden'; request.abort(); dispose();
  };
  const error = event => { if (result.errors.length < 8) result.errors.push(String(event.message || event.reason)); };
  const types = ['touchstart', 'touchmove', 'gesturestart', 'gesturechange', 'pointerdown', 'keydown', 'wheel'];
  const dispose = () => {
    if (disposed) return;
    disposed = true; surfaces.stop();
    for (const cancel of focusWaits) cancel();
    for (const message of surfaces.result.errors) {
      if (result.errors.length < 8) result.errors.push('Surface observation: ' + message);
    }
    clearTimeout(timer); clearTimeout(activeTimer); request.abort();
    for (const type of types) document.removeEventListener(type, stop, true);
    window.removeEventListener('orientationchange', stop); document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('error', error); window.removeEventListener('unhandledrejection', error);
    result.observersRemoved = true;
  };
  const guard = (allowClosing = false) => {
    if (!current()) { result.interrupted = true; result.interruption = 'document changed'; dispose(); }
    if (result.interrupted || disposed || closing && !allowClosing) throw new Error(result.interruption || 'Observation closed');
  };
  const restore = () => {
    if (restoreInFlight) return restoreInFlight;
    restoreInFlight = Promise.resolve().then(async () => {
      result.phase = 'restoring';
      if (result.interrupted || disposed || !current()) return false;
      if (!changed) { result.readingState = readState(); result.focusRestored = focusOwner.matches(savedFocus); return true; }
      const deadline = performance.now() + budget.restoreMs;
      let panelError;
      try { await panelRestore?.({ guard: () => guard(true), deadline }); }
      catch (error) { panelError = error; }
      if (result.interrupted || disposed || !current()) return false;
      if (viewer.pagesRotation !== saved.rotation) viewer.pagesRotation = saved.rotation;
      if (viewer.scrollMode !== saved.scrollMode) viewer.scrollMode = saved.scrollMode;
      if (viewer.spreadMode !== saved.spreadMode) viewer.spreadMode = saved.spreadMode;
      if (viewer.currentScaleValue !== saved.scaleValue) viewer.currentScaleValue = saved.scaleValue;
      if (app.pdfSidebar?.visibleView !== saved.sidebar) app.pdfSidebar?.switchView(saved.sidebar);
      if (viewer.currentPageNumber !== saved.page || Math.abs(container.scrollTop - saved.top) > 0.5
          || Math.abs(container.scrollLeft - saved.left) > 0.5) {
        viewer.scrollPageIntoView({ pageNumber: saved.page });
        container.scrollTop = saved.top; container.scrollLeft = saved.left;
      }
      if (prefetch.robotsEnabled !== saved.robots) prefetch.setRobotsEnabled(saved.robots);
      if (prefetch.diagnosticsEnabled !== saved.lab) prefetch.setDiagnosticsEnabled(saved.lab);
      result.restored = true; result.readingState = readState(); result.focusRestored = false;
      try {
        result.focusAfter = await focusOwner.restore(savedFocus, {
          guard: () => { guard(true); if (performance.now() >= deadline) throw new Error('Focus restoration deadline expired'); },
          nextFrame: () => nextFocusFrame(deadline),
        });
        result.focusRestored = focusOwner.matches(savedFocus);
      } catch (error) {
        result.focusFailure = String(error.message || error);
        throw error;
      } finally {
        if (result.interrupted || disposed || !current()) result.restored = false;
        result.readingState = readState();
      }
      if (panelError) throw panelError;
      return true;
    }).finally(() => { restoreInFlight = undefined; });
    return restoreInFlight;
  };
  for (const type of types) document.addEventListener(type, stop, { capture: true, passive: true });
  window.addEventListener('orientationchange', stop, { passive: true });
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('error', error); window.addEventListener('unhandledrejection', error);
  const displayed = image => image?.connected && image.width > 0 && image.height > 0
    && image.rect.width > 0 && image.rect.height > 0
    && image.computed.display !== 'none' && image.computed.visibility !== 'hidden';
  const displayRaster = node => {
    if (!node) return;
    const value = { connected: node.isConnected, width: node.width, height: node.height };
    if (value.connected && value.width > 0 && value.height > 0) {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      value.rect = { width: rect.width, height: rect.height };
      value.computed = { display: style.display, visibility: style.visibility };
    }
    return value;
  };
  const recordFirstPixels = (state, target, entry) => {
    const raster = state.canvases.find(page => page.page === target);
    const useful = displayed(raster?.preview) || raster?.state === 3 && displayed(raster.native);
    if (!entry.firstPixels && state.documentVisible && state.visible.includes(target) && !state.missing.includes(target) && useful) {
      entry.firstPixels = { at: state.at, elapsedMs: state.at - entry.at, raster, source: state.source };
    }
  };
  const sample = () => {
    if (!current()) { result.interrupted = true; result.interruption = 'document changed'; dispose(); }
    const state = prefetch.snapshot(), robots = state.robots;
    surfaces.performance(state.performance.events);
    for (const event of state.performance.events) {
      if (event.at < result.startedAt || eventSequences.has(event.sequence) || !/^(sidecar-|preview-ready|page-render)/.test(event.type)) continue;
      eventSequences.add(event.sequence); result.events.push(event);
      if (result.events.length > 256) result.events.shift();
    }
    if (robots?.presentation !== 'compact' || robots.maxActors !== 4 || state.cachePolicy !== 'mobile') throw new Error('Compact phone policy changed');
    if (robots.activeActors > robots.maxActors || robots.cargoBytes > robots.maxCargoBytes
        || robots.spriteBytes > robots.maxSpriteBytes || robots.retainedBytes !== robots.cargoBytes + robots.spriteBytes
        || state.previewBytes > state.cacheLimits.maxPreviewBytes || state.previewSource?.pending > 2) throw new Error('Phone resource limit exceeded');
    const next = { sceneMoving: panel()?.host.dataset.panelMoving === 'true' || container.dataset.pdfColumnMoving === 'true', at: performance.now(), documentVisible: document.visibilityState === 'visible', prefetchIdle: state.idle,
      page: viewer.currentPageNumber, visible: state.visible, missing: state.visibleMissing,
      pending: state.pending, pendingFetches: state.performance.pendingFetchCount, source: state.previewSource,
      imagePages: state.imagePages, raw: state.rangeCache, robots,
      payloadArtifacts: collectPayloadArtifacts(document),
      effectNodes: Object.fromEntries(['Arrival', 'Cargo', 'CargoUnderlay', 'Vehicle', 'Cleaner', 'QualityCoarse', 'QualitySharp', 'QualityCleaner'].map(name =>
        [name, document.querySelectorAll('.pdfDocumentRobot' + name).length])),
      scrollWidth: container.scrollWidth, scrollHeight: container.scrollHeight, clientWidth: container.clientWidth,
      clientHeight: container.clientHeight, previewBytes: state.previewBytes, cacheLimits: state.cacheLimits,
      canvases: state.visible.map(page => {
        const view = viewer.getPageView(page - 1), preview = view?.div.querySelector('.pdfPrefetchPreview');
        return { page, state: view?.renderingState, nativeWidth: view?.canvas?.width ?? 0, nativeHeight: view?.canvas?.height ?? 0,
          previewWidth: preview?.width ?? 0, previewHeight: preview?.height ?? 0,
          native: displayRaster(view?.canvas), preview: displayRaster(preview) };
      }) };
    for (const observation of payloadObservations.observe(next)) {
      (observation.kind === 'refined' ? result.refinements : result.retirements).push(observation);
    }
    result.samples.push(next); if (result.samples.length > 256) result.samples.shift(); return next;
  };
  const probe = { token, result, budget, sample, dispose, restore, readState, panel, panelState, guard, sleep,
    get closing() { return closing; },
    abort(supplied, reason = 'host-stop') {
      if (supplied !== token) return { ok: false };
      if (closeInFlight) return closeInFlight;
      closing = true; clearTimeout(timer); clearTimeout(activeTimer); request.abort();
      closeInFlight = Promise.resolve().then(async () => {
        try { await restore(); } catch (error) { result.cleanupError = String(error.message || error); }
        finally { result.interrupted = true; result.interruption ??= String(reason).slice(0, 160); dispose();
          if (window.__spomenarSidecarProbe === probe) delete window.__spomenarSidecarProbe; }
        return { ok: true, result };
      });
      return closeInFlight;
    },
    focusMatches: () => focusOwner.matches(savedFocus),
    setPanelRestore(callback) { panelRestore = callback; } };
  window.__spomenarSidecarProbe = probe;
  timer = setTimeout(() => {
    result.watchdog = true;
    result.failure ??= 'Short observation work deadline expired';
    void probe.abort(token, 'watchdog');
  }, budget.workMs);
  const activeDeadline = result.startedAt + budget.activeMs;
  let activePhase = 'metadata';
  activeTimer = setTimeout(() => request.abort(), Math.max(0, activeDeadline - performance.now()));
  async function json(url, cap) {
    const response = await fetch(url, { cache: 'no-cache', credentials: 'same-origin', signal: request.signal });
    if (!response.ok || response.redirected || !response.body) {
      await response.body?.cancel();
      throw new Error('Metadata request failed: ' + response.status);
    }
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > cap) throw new Error('Metadata limit exceeded');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  try {
    const config = await json(new URL('./config.json', pageUrl), 64 * 1024);
    guard();
    if (new URL(config.pdfUrl, pageUrl).href !== pdfUrl.href || config.previews?.sha256 !== expected.sha256
        || config.previews.size !== expected.bytes) throw new Error('Public configuration is not the expected exact edition');
    const manifestUrl = new URL(config.previews.manifestUrl, location.href);
    if (manifestUrl.origin !== location.origin) throw new Error('Unexpected atlas origin');
    const manifest = await json(manifestUrl, 4 * 1024 * 1024);
    guard();
    if (manifest.document?.sha256 !== expected.sha256 || manifest.document.size !== expected.bytes
        || manifest.document.pageCount !== expected.pages) throw new Error('Atlas identity mismatch');
    const pages = new Map(manifest.pages.filter(page => targets.includes(page.pageNumber)).map(page => [page.pageNumber, page]));
    if (pages.size !== 2 || [...pages.values()].some(page => !page.imageRegions?.length)) throw new Error('Priority photo regions are missing');
    result.identity = { path: expectedPath, key: manifest.document.key, sha256: manifest.document.sha256,
      bytes: manifest.document.size, pages: manifest.document.pageCount };
    const deadline = activeDeadline;
    while (!result.interrupted && performance.now() < deadline && prefetch.snapshot().previewSource?.state !== 'ready') {
      sample(); await sleep(100);
    }
    guard();
    if (prefetch.snapshot().previewSource?.state !== 'ready') throw new Error('Published preview source is not ready');
    if (!app.isInitialViewSet) throw new Error('The PDF initial view has not settled');
    activePhase = 'initial saved scene';
    while (performance.now() < activeDeadline && !sceneReady(sample())) { guard(); await sleep(80); }
    if (performance.now() >= activeDeadline || !sceneReady(sample())) throw new Error('Incomplete initial saved scene at active deadline');
    guard();
    changed = true;
    prefetch.setRobotsEnabled(true); prefetch.setDiagnosticsEnabled(false);
    result.phase = 'delivery';
    for (const target of targets) {
      guard();
      const entry = { page: target, at: performance.now() }; result.entries.push(entry);
      activePhase = 'target scene ' + target;
      viewer.scrollPageIntoView({ pageNumber: target });
      const deadline = activeDeadline;
      while (!result.interrupted && performance.now() < deadline) {
        guard();
        const state = sample();
        recordFirstPixels(state, target, entry);
        for (const page of state.robots.pages) {
          if (!pages.has(page.page)) continue;
          for (const payload of page.payloads) {
          if (!payload.imageId || payload.progress < 0.28 || payload.progress >= 0.68) continue;
          const evidence = photoEvidence(payload, page.page, state.robots, pages.get(page.page), viewer.pagesRotation || 0);
          if (!evidence) continue;
          const cargo = [...document.querySelectorAll('.pdfDocumentRobotCargo')].filter(node => node.dataset.payload === String(payload.id));
          const picture = cargo[0]?.getBoundingClientRect(), area = container.getBoundingClientRect();
          const width = picture && Math.max(0, Math.min(picture.right, area.right) - Math.max(picture.left, area.left));
          const height = picture && Math.max(0, Math.min(picture.bottom, area.bottom) - Math.max(picture.top, area.top));
          if (!picture || width * height < picture.width * picture.height * 0.8) continue;
          const transit = document.querySelector('.pdfDocumentRobotTransit'), style = transit && getComputedStyle(transit);
          result.phase = 'selected';
          result.active = { at: state.at, page: page.page, payload, ...evidence,
            helpers: page.actors.filter(actor => actor.payloadId === payload.id),
            cargo: cargo.map(node => ({ width: node.width, height: node.height, bytes: node.width * node.height * 4,
              rect: node.getBoundingClientRect().toJSON(), pointerEvents: getComputedStyle(node).pointerEvents })),
            snapshot: state, clip: transit?.style.clipPath,
            transit: { position: style?.position, contain: style?.contain, width: style?.width, height: style?.height,
              insideScroller: !!transit && container.contains(transit) },
            viewer: area.toJSON(), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } };
          clearTimeout(activeTimer);
          return result;
          }
        }
        if (state.visible.includes(state.page) && state.visible.includes(target) && state.canvases.some(page => page.page === target) && sceneReady(state)) break;
        await sleep(80);
      }
      if (performance.now() >= activeDeadline) throw new Error('Incomplete ' + activePhase + ' at active deadline');
    }
    clearTimeout(activeTimer);
    result.noContentAwarePayloadObserved = !result.interrupted;
  } catch (error) {
    if (!result.interrupted && !closing) result.failure = performance.now() >= activeDeadline ? 'Incomplete ' + activePhase + ' at active deadline' : String(error.message || error);
    try { await restore(); } catch (cleanup) { result.cleanupError = String(cleanup.message || cleanup); }
    dispose(); if (window.__spomenarSidecarProbe === probe) delete window.__spomenarSidecarProbe;
  }
  return result;
})
