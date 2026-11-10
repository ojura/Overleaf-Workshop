(async options => {
  'use strict';
  // The host invokes this expression once with its own token. Merely loading it is inert.
  // @include payload-observation.mjs
  // @include scene-ready.mjs
  // @include awake-idle.mjs

  function makePlan(workloadMs, scenario = 'endurance', currentZoom = 'page-width') {
    if (scenario === 'traverse') return [0, 1].map(index => ({ index, zoom: currentZoom, start: 60, dwellMs: 0, settleBudgetMs: 8000,
      legs: [{ page: 90, durationMs: 3000 }, { page: 65, durationMs: 2500 }] }));
    const stages = [
      ['page-width', 30, [[160, 35], [90, 15]]],
      [0.5, 90, [[360, 40], [160, 10]]],
      [0.8, 160, [[110, 15], [90, 20], [110, 5], [94, 10]]],
      [1.6, 94, [[104, 20], [98, 8], [110, 12], [90, 10]]],
      ['page-width', 90, [[420, 40], [300, 10]]],
      [0.5, 300, [[455, 25], [90, 25]]],
      [0.8, 90, [[110, 30], [94, 10], [105, 10]]],
      [1.6, 105, [[98, 20], [110, 10], [90, 20]]],
      ['page-width', 90, [[10, 30], [90, 20]]],
      [0.5, 90, [[430, 35], [90, 15]]],
      [0.8, 90, [[110, 30], [90, 20]]],
      [1.6, 90, [[110, 20], [98, 5], [104, 15], [99, 10]]],
    ];
    return stages.map(([zoom, start, legs], index) => ({ index, zoom, start, dwellMs: 1000,
      legs: legs.map(([page, seconds]) => ({ page, durationMs: seconds * workloadMs / 600 })) }));
  }
  function gapStats() { return { frames: 0, gaps: 0, sumMs: 0, maxMs: 0,
    boundsMs: [20, 34, 50, 100, 250, 1000], buckets: [0, 0, 0, 0, 0, 0, 0] }; }
  function addGap(stats, gap) {
    stats.frames++;
    if (!(gap >= 0)) return;
    stats.gaps++; stats.sumMs += gap; stats.maxMs = Math.max(stats.maxMs, gap);
    const bucket = stats.boundsMs.findIndex(value => gap <= value);
    stats.buckets[bucket < 0 ? stats.boundsMs.length : bucket]++;
  }
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
  const boundedPush = (array, value, limit) => { if (array.length >= limit) array.shift(); array.push(value); };
  const numbers = object => Object.fromEntries(Object.entries(object ?? {})
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'));
  const increasePeaks = (peaks, values) => {
    for (const [key, value] of Object.entries(values)) if (typeof value === 'number') peaks[key] = Math.max(peaks[key] ?? 0, value);
  };
  const scenario = options?.scenario ?? 'endurance';
  const token = options?.token, workloadMs = scenario === 'traverse' ? 11000 : options?.workloadMs ?? 600000, leaseMs = options?.leaseMs ?? 20000;
  const startMode = options?.startMode ?? 'immediate', startWaitMs = options?.startWaitMs ?? 60000;
  if (typeof token !== 'string' || token.length < 16 || token.length > 128
      || !Number.isFinite(workloadMs) || workloadMs < 1000 || workloadMs > 600000 || leaseMs !== 20000
      || !['endurance', 'traverse'].includes(scenario)
      || !['immediate', 'tap'].includes(startMode) || !Number.isFinite(startWaitMs) || startWaitMs < 1000 || startWaitMs > 300000) {
    throw new Error('Invalid sustained-probe options');
  }
  if (window.__spomenarSustainedProbe || window.__spomenarSidecarProbe) throw new Error('Another phone probe owns this page');
  const expected = options.document;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0
      || !Number.isInteger(expected.pages) || expected.pages < (scenario === 'traverse' ? 90 : 455)) throw new Error('Invalid sustained document configuration');
  const pageUrl = new URL(expected.pageUrl), pdfUrl = new URL(expected.pdfUrl), currentPageUrl = new URL(location.href);
  if (currentPageUrl.origin !== pageUrl.origin || currentPageUrl.pathname !== pageUrl.pathname
      || currentPageUrl.search !== pageUrl.search || pdfUrl.origin !== pageUrl.origin) throw new Error('Unexpected reader origin');
  const expectedPath = pdfUrl.pathname;
  const app = window.PDFViewerApplication, prefetch = window.pdfPrefetch;
  const viewer = app?.pdfViewer, pdfDocument = app?.pdfDocument, container = viewer?.container;
  if (!container || !prefetch || pdfDocument?.numPages !== expected.pages
      || new URL(app.url, location.href).href !== pdfUrl.href) throw new Error('Unexpected current PDF identity');
  const now = () => performance.now();
  const current = () => app.pdfDocument === pdfDocument && viewer.pdfDocument === pdfDocument
    && new URL(app.url, location.href).href === pdfUrl.href;
  const deepestFocus = () => { let node = document.activeElement; while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement; return node; };
  const readState = () => ({ page: viewer.currentPageNumber, scaleValue: viewer.currentScaleValue, scale: viewer.currentScale,
    rotation: viewer.pagesRotation, scrollMode: viewer.scrollMode, spreadMode: viewer.spreadMode,
    sidebar: app.pdfSidebar?.visibleView, top: container.scrollTop, left: container.scrollLeft,
    robots: prefetch.robotsEnabled, lab: prefetch.diagnosticsEnabled });
  const readPanel = () => {
    const host = document.getElementById('pdf-prefetch-diagnostics'), root = host?.shadowRoot;
    return { exists: !!host, hidden: host?.hidden ?? true, dock: host?.dataset.dock ?? null,
      measurements: !!root?.querySelector('.measurements')?.open,
      rect: host && !host.hidden ? root?.querySelector('section')?.getBoundingClientRect().toJSON() : null };
  };
  const sameReading = (left, right) => ['page', 'scaleValue', 'rotation', 'scrollMode', 'spreadMode', 'sidebar', 'robots', 'lab']
    .every(key => left[key] === right[key]) && Number.isFinite(left.scale) && Number.isFinite(right.scale)
    && Math.abs(left.scale - right.scale) <= 1e-8 && Math.abs(left.top - right.top) <= 0.5 && Math.abs(left.left - right.left) <= 0.5;
  const samePanel = (left, right) => ['exists', 'hidden', 'dock', 'measurements'].every(key => left[key] === right[key])
    && (!left.rect && !right.rect || left.rect && right.rect
      && ['x', 'y', 'width', 'height'].every(key => Math.abs(left.rect[key] - right.rect[key]) <= 1));
  const planInfo = scenario === 'traverse'
    ? { expectedStages: 2, plannedDwellMs: 0, plannedSettleBudgetMs: 16000, plannedNaturalIdleMs: 12000 }
    : { expectedStages: 12, plannedDwellMs: 12000, plannedSettleBudgetMs: 0, plannedNaturalIdleMs: 0 };
  const result = { token, expected, scenario, startMode, startWaitMs, startedAt: now(), requestedScrollMs: workloadMs, ...planInfo,
    state: 'preparing', phase: 'preparing', finished: false, restored: false, observersRemoved: false,
    scrollMs: 0, dwellMs: 0, preparationMs: 0, setupMs: 0, restorationMs: 0,
    commandedDistancePx: 0, movingSampleIntervalsMs: 0, sampleCount: 0, sampleCostMs: 0, maxSampleCostMs: 0,
    coverage: { pageObservations: 0, missing: 0, noDisplayedRaster: 0, noUsefulPixels: 0, detachedNative: 0, detachedCovered: 0 },
    peaks: {}, rawPeaks: {}, decodedPeaks: {}, sourcePeaks: {}, eventCounts: {}, observationCounts: { refined: 0, retired: 0 },
    frames: gapStats(), stages: [], samples: [], events: [], refinements: [], retirements: [], errors: [], cleanupErrors: [],
    wakeLock: { state: 'not-requested', granted: false, released: false } };
  const work = new AbortController(), timers = new Set(), frames = new Set(), observer = new PayloadObservations();
  let leaseUntil = now() + leaseMs, stopReason, userTookOver = false, changed = false, stage, mode = 'preparing';
  let saved, savedPanel, savedFocus, lastSample, lastEventSequence = -1, disposed = false, finishing = false;
  let latest, firstCounters, sampleTimer, leaseTimer, phaseTimer, api, activeLegStartedAt, activeDwellStartedAt;
  let screenLock, screenLockRelease, screenLockListener, wakeLockClosed = false;
  let startButton, cancelStart, armedFocus, disposeRequested = false;
  const timer = (callback, ms) => { const id = setTimeout(() => { timers.delete(id); callback(); }, ms); timers.add(id); return id; };
  const clearTimer = id => { clearTimeout(id); timers.delete(id); };
  const stop = (reason, trusted = false) => {
    if (result.finished) return;
    userTookOver ||= trusted;
    stopReason ??= String(reason).slice(0, 160);
    result.interruption = stopReason;
    work.abort();
    cancelStart?.();
  };
  const guard = () => {
    if (!current()) stop('document-changed');
    if (document.visibilityState !== 'visible') stop('hidden');
    if (work.signal.aborted) throw new Error(stopReason || 'Stopped');
  };
  const releaseScreenLock = (reason, sentinel = screenLock) => {
    wakeLockClosed = true;
    if (!sentinel) return screenLockRelease ?? Promise.resolve();
    if (screenLockRelease) return screenLockRelease;
    screenLock = undefined;
    if (screenLockListener) sentinel.removeEventListener('release', screenLockListener);
    screenLockListener = undefined;
    const record = result.wakeLock;
    record.releaseReason = reason; record.releaseRequestedAt = now();
    screenLockRelease = (async () => {
      let timeout;
      try {
        if (!sentinel.released) {
          record.state = 'releasing';
          await Promise.race([sentinel.release(), new Promise((_, reject) => {
            timeout = timer(() => reject(new Error('Screen wake lock release timed out')), 1500);
          })]);
        }
        record.released = sentinel.released;
        if (!record.released) throw new Error('Screen wake lock did not report release');
        record.state = 'released'; record.releasedAt = now();
      } catch (error) {
        record.state = 'release-failed'; record.releaseError = String(error.message || error);
        boundedPush(result.cleanupErrors, record.releaseError, 8);
      } finally { clearTimer(timeout); }
    })();
    return screenLockRelease;
  };
  const acquireScreenLock = async () => {
    guard();
    const record = result.wakeLock;
    record.supported = typeof navigator !== 'undefined' && typeof navigator.wakeLock?.request === 'function';
    if (!record.supported || globalThis.isSecureContext !== true) {
      record.state = 'unsupported'; record.error = 'A secure-context screen wake lock is required';
      throw new Error(record.error);
    }
    record.state = 'requesting'; record.requestedAt = now();
    let timeout, abort;
    const gate = new Promise((_, reject) => {
      abort = () => reject(new Error(stopReason || 'Wake lock acquisition stopped'));
      work.signal.addEventListener('abort', abort, { once: true });
      timeout = timer(() => reject(Object.assign(new Error('Screen wake lock acquisition timed out'), { name: 'TimeoutError' })), 3000);
    });
    try {
      const pending = Promise.resolve(navigator.wakeLock.request('screen')).then(sentinel => {
        record.granted = true; record.grantedAt = now();
        if (wakeLockClosed || work.signal.aborted || disposed || result.finished || !current() || document.visibilityState !== 'visible') {
          record.lateGrant = true; void releaseScreenLock('late-grant', sentinel); return;
        }
        screenLock = sentinel;
        screenLockListener = () => {
          sentinel.removeEventListener('release', screenLockListener); screenLockListener = undefined;
          screenLock = undefined; record.released = true; record.releasedAt = now(); record.state = 'released';
          if (!wakeLockClosed && !finishing && !result.finished && !work.signal.aborted) stop('wake-lock-released');
        };
        sentinel.addEventListener('release', screenLockListener);
        if (sentinel.released) throw new Error('Screen wake lock was already released');
        record.state = 'held';
      });
      await Promise.race([pending, gate]); guard();
      if (!screenLock || screenLock.released) throw new Error('Screen wake lock is not held');
    } catch (error) {
      wakeLockClosed = true; record.error = String(error.message || error); record.errorName = error.name;
      if (!record.granted) record.state = error.name === 'TimeoutError' ? 'timed-out' : error.name === 'NotAllowedError' ? 'denied' : 'failed';
      if (startMode === 'immediate' && !record.granted && error.name === 'NotAllowedError') { guard(); return; }
      throw error;
    } finally { clearTimer(timeout); work.signal.removeEventListener('abort', abort); }
  };
  const wait = (ms, signal = work.signal) => new Promise((resolve, reject) => {
    let id;
    const finish = error => { clearTimer(id); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const abort = () => finish(new Error(stopReason || 'Stopped'));
    if (signal?.aborted) { reject(new Error(stopReason || 'Stopped')); return; }
    signal?.addEventListener('abort', abort, { once: true }); id = timer(() => finish(), ms);
  });
  const nextFrame = (signal = work.signal, timeoutMs = 5000) => new Promise((resolve, reject) => {
    let id, timeout;
    const finish = (at, error) => { cancelAnimationFrame(id); frames.delete(id); clearTimer(timeout);
      signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(at); };
    const abort = () => finish(undefined, new Error(stopReason || 'Stopped'));
    if (signal?.aborted) { reject(new Error(stopReason || 'Stopped')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    id = requestAnimationFrame(at => finish(at)); frames.add(id);
    timeout = timer(() => finish(undefined, new Error('No animation frame for ' + timeoutMs + ' ms')), timeoutMs);
  });
  const types = ['touchstart', 'touchmove', 'gesturestart', 'gesturechange', 'pointerdown', 'keydown', 'wheel'];
  const input = event => {
    if (startButton && (event.target === startButton || event.composedPath?.().includes(startButton))) return;
    if (event.isTrusted) stop('trusted-' + event.type, true);
  };
  const hidden = () => { if (document.visibilityState !== 'visible') stop('hidden'); };
  const pageError = event => boundedPush(result.errors, { at: now(), message: String(event.message || event.reason).slice(0, 500) }, 16);
  for (const type of types) document.addEventListener(type, input, { capture: true, passive: true });
  window.addEventListener('orientationchange', input, { passive: true });
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('error', pageError); window.addEventListener('unhandledrejection', pageError);
  const cleanup = async () => {
    if (disposed) return;
    disposed = true; work.abort();
    cancelStart?.();
    await releaseScreenLock('terminal-cleanup');
    for (const id of timers) clearTimeout(id); timers.clear();
    for (const id of frames) cancelAnimationFrame(id); frames.clear();
    for (const type of types) document.removeEventListener(type, input, true);
    window.removeEventListener('orientationchange', input); document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('error', pageError); window.removeEventListener('unhandledrejection', pageError);
    result.observersRemoved = true;
  };
  const counters = state => ({ fetchCount: state.performance.fetchCount, fetchBytes: state.performance.fetchBytes,
    sourceRequests: state.previewSource?.assetRequests ?? 0, sourceCompleted: state.previewSource?.completed ?? 0,
    robotFrames: state.robots?.frames ?? 0, robotPaintMs: state.robots?.paintTotalMs ?? 0,
    delivered: state.robots?.deliveredFragments ?? 0, robotRefinements: state.robots?.refinements ?? 0 });
  const sample = () => {
    if (!current()) throw new Error('Document changed during sampling');
    const began = now(), state = prefetch.snapshot(), robots = state.robots;
    if (state.cachePolicy !== 'mobile' || robots?.presentation !== 'compact' || robots.maxActors !== 4) throw new Error('Phone policy changed');
    if (robots.activeActors > 4 || robots.cargoBytes > robots.maxCargoBytes || robots.spriteBytes > robots.maxSpriteBytes
        || robots.retainedBytes !== robots.cargoBytes + robots.spriteBytes || state.previewBytes > state.cacheLimits.maxPreviewBytes
        || state.previewSource?.pending > 2) throw new Error('Phone resource limit exceeded');
    if (state.visible.length > 32) throw new Error('Unexpected visible-page count');
    const next = { at: began, stage: stage?.index ?? null, mode, documentVisible: document.visibilityState === 'visible',
      page: viewer.currentPageNumber, top: container.scrollTop,
      scale: viewer.currentScale, scaleValue: viewer.currentScaleValue, visible: state.visible, missing: state.visibleMissing,
      pending: state.pending, idle: state.idle, pendingFetches: state.performance.pendingFetchCount,
      previewPages: state.previewPages, previewBytes: state.previewBytes, canvasBytes: state.canvasBytes,
      raw: numbers(state.rangeCache), decodedImages: numbers(state.decodedImages), source: state.previewSource,
      memoryBackpressure: state.memoryBackpressure, fetchBackpressure: state.fetchBackpressure,
      robots, payloadArtifacts: collectPayloadArtifacts(document), counters: counters(state),
      vehicleNodes: document.querySelectorAll('.pdfDocumentRobotVehicle').length,
      canvases: state.visible.map(page => { const view = viewer.getPageView(page - 1); return { page, state: view?.renderingState,
        native: displayRaster(view?.canvas), preview: displayRaster(view?.div.querySelector('.pdfPrefetchPreview')) }; }) };
    const coverage = { pageObservations: next.documentVisible ? next.canvases.length : 0,
      missing: next.documentVisible ? next.missing.length : 0, noDisplayedRaster: 0,
      noUsefulPixels: 0, detachedNative: 0, detachedCovered: 0 };
    for (const page of next.documentVisible ? next.canvases : []) {
      const preview = displayed(page.preview), native = displayed(page.native);
      coverage.noDisplayedRaster += !(preview || native);
      coverage.noUsefulPixels += !(preview || page.state === 3 && native);
      if (page.native && !page.native.connected) { coverage.detachedNative++; coverage.detachedCovered += !!preview; }
    }
    for (const [key, value] of Object.entries(coverage)) { result.coverage[key] += value; if (stage) stage.coverage[key] += value; }
    const values = { previewBytes: next.previewBytes, canvasBytes: next.canvasBytes, pendingFetches: next.pendingFetches,
      activeActors: robots.activeActors, cargoBytes: robots.cargoBytes, spriteBytes: robots.spriteBytes,
      retainedBytes: robots.retainedBytes, covers: robots.activeArrivalCovers, refinements: robots.activeRefinements };
    increasePeaks(result.peaks, values); if (stage) increasePeaks(stage.peaks, values);
    increasePeaks(result.rawPeaks, next.raw); increasePeaks(result.decodedPeaks, next.decodedImages);
    increasePeaks(result.sourcePeaks, numbers(next.source));
    for (const item of observer.observe(next)) {
      const kind = item.kind === 'refined' ? 'refined' : 'retired'; result.observationCounts[kind]++;
      if (stage) stage.observationCounts[kind]++;
      boundedPush(kind === 'refined' ? result.refinements : result.retirements, item, 128);
    }
    for (const event of state.performance.events) {
      if (event.sequence <= lastEventSequence || event.at < result.startedAt) continue;
      lastEventSequence = event.sequence;
      result.eventCounts[event.type] = (result.eventCounts[event.type] ?? 0) + 1;
      if (/^(sidecar-|preview-ready|page-render)/.test(event.type)) boundedPush(result.events,
        { sequence: event.sequence, at: event.at, type: event.type, data: numbers(event.data) }, 512);
    }
    if (lastSample && mode === 'scroll' && lastSample.mode === 'scroll' && lastSample.stage === next.stage
        && Math.abs(next.top - lastSample.top) > 0.5) result.movingSampleIntervalsMs += next.at - lastSample.at;
    result.sampleCount++; if (stage) { stage.sampleCount++; stage.lastCounters = next.counters; }
    firstCounters ??= next.counters; result.lastCounters = next.counters;
    lastSample = latest = next; boundedPush(result.samples, next, 240);
    result.sampleCostMs += now() - began; result.maxSampleCostMs = Math.max(result.maxSampleCostMs, now() - began);
    return next;
  };
  const sampleLoop = () => {
    if (finishing || disposed) return;
    try { guard(); sample(); } catch (error) { if (!stopReason) result.failure = String(error.message || error); stop(stopReason || 'sample-failed'); return; }
    sampleTimer = timer(sampleLoop, 500);
  };
  const counterDelta = () => firstCounters && Object.fromEntries(Object.entries(result.lastCounters ?? firstCounters)
    .map(([key, value]) => [key, value - firstCounters[key]]));
  const copyFrames = value => ({ ...value, boundsMs: [...value.boundsMs], buckets: [...value.buckets] });
  // Status and heartbeat publish cached evidence only. They neither sample the DOM
  // nor renew the bounded sample rings, so a lost terminal RPC retains full-span totals.
  const checkpoint = () => ({ at: latest?.at ?? null, phase: result.phase, stage: stage?.index ?? null,
    sampleCount: result.sampleCount, frames: copyFrames(result.frames), coverage: { ...result.coverage },
    peaks: { ...result.peaks }, rawPeaks: { ...result.rawPeaks }, decodedPeaks: { ...result.decodedPeaks },
    sourcePeaks: { ...result.sourcePeaks }, counterDelta: counterDelta() ?? null,
    current: latest ? { page: latest.page, top: latest.top, scale: latest.scale, scaleValue: latest.scaleValue,
      documentVisible: latest.documentVisible,
      visible: [...latest.visible], missing: [...latest.missing], pending: [...latest.pending], pendingFetches: latest.pendingFetches,
      previewBytes: latest.previewBytes, canvasBytes: latest.canvasBytes, raw: { ...latest.raw }, decodedImages: { ...latest.decodedImages },
      source: numbers(latest.source), robots: numbers(latest.robots), memoryBackpressure: latest.memoryBackpressure } : null,
    stages: result.stages.map(value => ({ index: value.index, startedAt: value.startedAt, endedAt: value.endedAt ?? null,
      scrollMs: value.scrollMs, dwellMs: value.dwellMs, sampleCount: value.sampleCount,
      frames: copyFrames(value.frames), coverage: { ...value.coverage }, peaks: { ...value.peaks },
      firstCounters: { ...value.firstCounters }, lastCounters: { ...value.lastCounters } })) });
  const status = () => ({ ok: true, token, scenario, state: result.state, phase: result.phase,
    elapsedMs: now() - result.startedAt,
    scrollMs: result.scrollMs + (activeLegStartedAt === undefined ? 0 : now() - activeLegStartedAt),
    dwellMs: result.dwellMs + (activeDwellStartedAt === undefined ? 0 : now() - activeDwellStartedAt),
    leaseRemainingMs: Math.max(0, leaseUntil - now()), finished: result.finished, restored: result.restored,
    observersRemoved: result.observersRemoved, failure: result.failure ?? null, interruption: result.interruption ?? null,
    stage: stage?.index ?? null, sampleCount: result.sampleCount, latestAt: latest?.at ?? null, page: latest?.page ?? null,
    startMode, armedAt: result.armedAt ?? null, activationAt: result.activationAt ?? null,
    workloadStartedAt: result.workloadStartedAt ?? null, clientCheckpoint: checkpoint(), wakeLock: { ...result.wakeLock } });
  const valid = supplied => supplied === token;
  api = Object.freeze({
    heartbeat(supplied) { if (!valid(supplied)) return { ok: false }; if (!finishing && !result.finished) leaseUntil = now() + leaseMs; return status(); },
    status(supplied) { return valid(supplied) ? status() : { ok: false }; },
    stop(supplied, reason = 'host-stop') { if (!valid(supplied)) return { ok: false }; stop(reason); return status(); },
    result(supplied) { return valid(supplied) && result.finished ? result : null; },
    dispose(supplied) { if (!valid(supplied)) return { ok: false };
      if (!result.finished) {
        if (result.state !== 'armed') return { ok: false };
        disposeRequested = true; stop('host-dispose'); return { ok: true, disposed: false, pending: true };
      }
      void releaseScreenLock('dispose');
      if (window.__spomenarSustainedProbe === api) delete window.__spomenarSustainedProbe; return { ok: true, disposed: true }; },
  });
  window.__spomenarSustainedProbe = api;
  const leaseCheck = () => { if (finishing || result.finished) return;
    if (now() >= leaseUntil) { stop('host-lease-expired'); return; } leaseTimer = timer(leaseCheck, Math.min(1000, leaseUntil - now())); };
  leaseCheck();
  const waitForStartTap = () => new Promise((resolve, reject) => {
    guard(); armedFocus = deepestFocus();
    result.state = result.phase = mode = 'armed'; result.armedAt = now();
    const button = startButton = document.createElement('button'); button.type = 'button';
    button.textContent = 'Start Safari endurance check'; button.setAttribute('aria-label', button.textContent);
    Object.assign(button.style, { position: 'fixed', left: '12px', right: '12px', bottom: '16px', zIndex: '2147483647',
      minHeight: '52px', padding: '12px', font: '600 17px system-ui', color: '#fff', background: '#173f70',
      border: '2px solid #fff', borderRadius: '10px' });
    let timeout, ended = false;
    const remove = () => { clearTimer(timeout); button.removeEventListener('click', activate);
      button.remove(); if (startButton === button) startButton = undefined; cancelStart = undefined; };
    const activate = event => {
      if (!event.isTrusted || ended) return;
      try {
        guard(); ended = true; result.activationAt = now(); remove(); result.state = result.phase = mode = 'preparing';
        // Calling this async function enters wakeLock.request before its first await,
        // in this actual trusted click turn. The host never synthesizes activation.
        const acquisition = acquireScreenLock(); acquisition.catch(() => {}); resolve({ acquisition });
      } catch (error) { ended = true; remove(); reject(error); }
    };
    cancelStart = () => { if (ended) return; ended = true; remove(); reject(new Error(stopReason || 'Start cancelled')); };
    button.addEventListener('click', activate); document.body.appendChild(button);
    timeout = timer(() => stop('start-wait-expired'), startWaitMs);
  });
  async function metadata(url, cap) {
    const response = await fetch(url, { cache: 'no-cache', credentials: 'same-origin', signal: work.signal });
    if (!response.ok || response.redirected || !response.body) { await response.body?.cancel(); throw new Error('Metadata request failed'); }
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try { for (;;) { guard(); const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
      if (length > cap) throw new Error('Metadata size exceeded'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(data));
  }
  const quiet = value => value && !value.robots.activeActors && !value.robots.activePayloads && !value.robots.retainedBytes && qualitySceneEmpty(value)
    && !value.robots.scheduled && !value.robots.caption?.pendingExpiry && value.payloadArtifacts.payloads.length === 0 && value.payloadArtifacts.plans.length === 0 && !value.robots.queuedDeliveryCovers && !value.vehicleNodes;
  const useful = value => value.documentVisible && value.canvases.length > 0 && value.missing.length === 0
    && value.canvases.every(page => displayed(page.preview) || page.state === 3 && displayed(page.native));
  const settled = value => quiet(value) && useful(value) && !value.pending.length && !value.pendingFetches
    && !value.source?.pending && !value.source?.decoding && !value.source?.queuedDecodes
    && !value.raw.activeOperations && !value.raw.pendingRequests && !value.raw.imageDecodeActive && !value.raw.imageDecodeQueued;
  async function restore() {
    finishing = true; result.state = 'restoring'; result.phase = mode = 'restoring';
    if (stage) { stage.endedAt ??= now(); stage.interrupted = !!stopReason; stage = undefined; }
    clearTimer(sampleTimer); clearTimer(leaseTimer); clearTimer(phaseTimer);
    const began = now();
    if (!changed || !saved) { result.restored = true; result.restorationMs = now() - began; return; }
    if (userTookOver || !current()) { result.restorationSkipped = userTookOver ? 'trusted-input' : 'document-changed'; return; }
    const apply = () => {
      if (userTookOver || !current()) return false;
      if (viewer.pagesRotation !== saved.rotation) viewer.pagesRotation = saved.rotation;
      if (viewer.scrollMode !== saved.scrollMode) viewer.scrollMode = saved.scrollMode;
      if (viewer.spreadMode !== saved.spreadMode) viewer.spreadMode = saved.spreadMode;
      if (viewer.currentScaleValue !== saved.scaleValue) viewer.currentScaleValue = saved.scaleValue;
      if (app.pdfSidebar?.visibleView !== saved.sidebar) app.pdfSidebar?.switchView(saved.sidebar);
      if (viewer.currentPageNumber !== saved.page) viewer.scrollPageIntoView({ pageNumber: saved.page });
      container.scrollTop = saved.top; container.scrollLeft = saved.left;
      if (prefetch.robotsEnabled !== saved.robots) prefetch.setRobotsEnabled(saved.robots);
      if (prefetch.diagnosticsEnabled !== saved.lab) prefetch.setDiagnosticsEnabled(saved.lab);
      if (savedFocus?.isConnected && deepestFocus() !== savedFocus) {
        if (savedFocus === document.body) deepestFocus()?.blur?.(); else savedFocus.focus?.({ preventScroll: true });
      }
      return true;
    };
    apply();
    // 10.5 s here leaves 1.5 s for the existing bounded wake-lock release.
    const observation = await observeAwakeIdle({ now, deadline: began + 10500, sample,
      canContinue: () => !userTookOver && current() && document.visibilityState === 'visible',
      ready: value => settled(value) && sameReading(saved, readState()), frameCount: value => value.robots.frames,
      nextFrame: maximum => nextFrame(null, maximum) });
    const idle = result.idle = observation.idle;
    if (userTookOver || !current()) { result.restorationSkipped = userTookOver ? 'trusted-input' : 'document-changed'; return; }
    const after = sample(); result.final = after; result.readingState = readState(); result.panelAfter = readPanel();
    result.focusRestored = deepestFocus() === savedFocus;
    result.restorationExact = sameReading(saved, result.readingState) && samePanel(savedPanel, result.panelAfter) && result.focusRestored;
    Object.assign(idle, { durationMs: now() - began, framesAdded: idle.framesAdded + after.robots.frames - observation.state.robots.frames,
      quiet: quiet(after), pendingAtEnd: after.pending.length, pendingFetchesAtEnd: after.pendingFetches });
    result.restoredViewport = { visible: document.visibilityState === 'visible', focused: document.hasFocus(),
      displayed: useful(after), missingPages: after.canvases.filter(page => !(displayed(page.preview)
        || page.state === 3 && displayed(page.native))).map(page => page.page) };
    result.restored = result.restorationExact;
    result.restorationMs = now() - began;
    if (!result.restored) throw new Error('Initial reading, panel or focus state was not restored');
    if (!stopReason && (!idle.awake || !result.restoredViewport.visible || !result.restoredViewport.displayed)) {
      throw new Error('Restored viewport did not reach continuously observed awake, displayed idle');
    }
  }
  async function run() {
    try {
      guard();
      if (window.getSelection()?.isCollapsed === false
          || deepestFocus()?.matches('input,textarea,[contenteditable="true"]')) throw new Error('Reader input is active');
      if (startMode === 'tap') { const activation = await waitForStartTap(); await activation.acquisition; }
      else await acquireScreenLock();
      phaseTimer = timer(() => stop('preparation-timeout'), 30000);
      const config = await metadata(new URL('./config.json', pageUrl), 65536);
      if (new URL(config.pdfUrl, pageUrl).href !== pdfUrl.href || config.previews?.sha256 !== expected.sha256
          || config.previews.size !== expected.bytes) throw new Error('Published edition changed');
      const manifestUrl = new URL(config.previews.manifestUrl, location.href);
      if (manifestUrl.origin !== location.origin) throw new Error('Unexpected atlas origin');
      const manifest = await metadata(manifestUrl, 4 * 1024 * 1024);
      if (manifest.document?.sha256 !== expected.sha256 || manifest.document.size !== expected.bytes
          || manifest.document.pageCount !== expected.pages) throw new Error('Atlas identity mismatch');
      result.identity = { path: expectedPath, key: manifest.document.key, ...expected };
      if (!app.isInitialViewSet || !viewer.pagesPromise) throw new Error('Initial view is not ready');
      await Promise.race([viewer.pagesPromise, wait(15000).then(() => { throw new Error('Initial pages timeout'); })]);
      await nextFrame(); await nextFrame(); guard();
      if (prefetch.snapshot().previewSource?.state !== 'ready') throw new Error('Preview source is not ready');
      saved = result.saved = readState(); savedPanel = result.savedPanel = readPanel(); savedFocus = armedFocus ?? deepestFocus();
      result.savedFocus = { tag: savedFocus?.tagName, id: savedFocus?.id ?? '', hasFocus: document.hasFocus() };
      result.policy = prefetch.snapshot().cachePolicy; result.limits = prefetch.snapshot().cacheLimits;
      result.initial = sample(); result.preparationMs = now() - result.startedAt;
      clearTimer(phaseTimer); phaseTimer = timer(() => stop('workload-deadline'), workloadMs + 30000);
      result.state = 'running'; result.workloadStartedAt = now(); sampleLoop();
      if (scenario === 'traverse') { changed = true; prefetch.setRobotsEnabled(true); prefetch.setDiagnosticsEnabled(false); }
      for (const planned of makePlan(workloadMs, scenario, saved.scaleValue)) {
        guard();
        stage = { ...planned, startedAt: now(), scrollMs: 0, dwellMs: 0, sampleCount: 0,
          frames: gapStats(), coverage: Object.fromEntries(Object.keys(result.coverage).map(key => [key, 0])),
          peaks: {}, observationCounts: { refined: 0, retired: 0 }, firstCounters: counters(prefetch.snapshot()), legs: [] };
        result.stages.push(stage); result.phase = 'stage-' + (planned.index + 1); mode = 'setup';
        const setup = now(); changed = true;
        viewer.currentScaleValue = planned.zoom; viewer.scrollPageIntoView({ pageNumber: planned.start });
        await nextFrame(); await nextFrame(); guard(); result.setupMs += now() - setup;
        for (const leg of planned.legs) {
          guard();
          const view = viewer.getPageView(leg.page - 1), box = view.div.getBoundingClientRect(), area = container.getBoundingClientRect();
          const from = container.scrollTop, target = Math.max(0, Math.min(container.scrollHeight - container.clientHeight,
            from + box.top - area.top - container.clientTop));
          const started = now(), record = { page: leg.page, from, target, startedAt: started, plannedMs: leg.durationMs, frames: 0 };
          stage.legs.push(record); mode = 'scroll'; activeLegStartedAt = started; let previousAt, previousTop = from;
          try {
            for (;;) {
              const at = await nextFrame(); guard();
              const progress = Math.min(1, (at - started) / leg.durationMs), top = from + (target - from) * progress;
              const gap = previousAt === undefined ? undefined : at - previousAt;
              addGap(stage.frames, gap); addGap(result.frames, gap); previousAt = at;
              container.scrollTop = top;
              result.commandedDistancePx += Math.abs(top - previousTop); previousTop = top; record.frames++;
              if (progress === 1) break;
            }
          } finally { record.elapsedMs = now() - started; stage.scrollMs += record.elapsedMs; result.scrollMs += record.elapsedMs; activeLegStartedAt = undefined; }
        }
        if (planned.dwellMs) {
          mode = 'dwell'; const dwell = now(); activeDwellStartedAt = dwell;
          try { await wait(planned.dwellMs); } finally { stage.dwellMs = now() - dwell; result.dwellMs += stage.dwellMs; activeDwellStartedAt = undefined; }
        }
        if (planned.settleBudgetMs) {
          mode = 'settle'; const began = now(); let state;
          do { guard(); state = sample(); if (settled(state)) break; await wait(200); } while (now() - began < planned.settleBudgetMs);
          stage.settleMs = now() - began; stage.settled = settled(state);
          if (!stage.settled) throw new Error('Short traversal did not settle within its bounded interval');
        }
        stage.endedAt = now(); stage.lastCounters = counters(prefetch.snapshot());
      }
      stage = undefined;
      if (scenario === 'traverse') {
        result.naturalIdle = [];
        for (const [enabled, durationMs] of [[true, 8000], [false, 4000]]) {
          guard(); prefetch.setRobotsEnabled(enabled); result.phase = mode = enabled ? 'robots-on-idle' : 'robots-off-idle';
          const began = now(), before = sample(), observed = gapStats(); let previousAt;
          do { const at = await nextFrame(); guard(); addGap(observed, previousAt === undefined ? undefined : at - previousAt); previousAt = at; }
          while (now() - began < durationMs);
          const after = sample(), framesAdded = after.robots.frames - before.robots.frames;
          const part = { robots: enabled, startedAt: began, durationMs: now() - began, frames: observed, framesAdded,
            quiet: quiet(before) && quiet(after) && framesAdded === 0, firstCounters: before.counters, lastCounters: after.counters };
          result.naturalIdle.push(part);
          if (!part.quiet) throw new Error('Short traversal robot idle phase retained scheduled work');
        }
      }
      result.workloadEndedAt = now();
    } catch (error) {
      if (!stopReason) result.failure = String(error.message || error);
    } finally {
      try { await restore(); } catch (error) { boundedPush(result.cleanupErrors, String(error.message || error), 8); }
      await cleanup(); result.finishedAt = now(); result.finished = true;
      result.interrupted = !!stopReason;
      result.counterDelta = counterDelta();
      result.state = result.cleanupErrors.length ? 'restore-failed' : result.failure ? 'failed'
        : stopReason ? 'interrupted' : 'completed'; result.phase = 'finished';
      if (disposeRequested && window.__spomenarSustainedProbe === api) delete window.__spomenarSustainedProbe;
    }
  }
  void run();
  return { ok: true, token, scenario, state: result.state, startMode, startWaitMs, workloadMs, leaseMs,
    armedAt: result.armedAt ?? null, ...planInfo, restorationReserveMs: 12000 };
})
