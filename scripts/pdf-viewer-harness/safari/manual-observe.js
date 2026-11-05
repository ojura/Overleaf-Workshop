(options => {
  'use strict';
  // @include payload-observation.mjs
  // This mode observes actual user gestures. It never drives or restores the reader.
  const token = options?.token, expected = options?.document, durationMs = options?.durationMs ?? 120000;
  const leaseMs = options?.leaseMs ?? 20000;
  if (typeof token !== 'string' || token.length < 16 || token.length > 128 || !expected
    || !Number.isInteger(expected.pages) || expected.pages < 1 || !Number.isFinite(durationMs)
    || durationMs < 1000 || durationMs > 300000 || leaseMs !== 20000) throw new Error('Invalid manual-observation options');
  if (window.__spomenarManualProbe || window.__spomenarSustainedProbe || window.__spomenarSidecarProbe) throw new Error('Another phone probe owns this page');
  const pageUrl = new URL(expected.pageUrl), pdfUrl = new URL(expected.pdfUrl), here = new URL(location.href);
  if (here.origin !== pageUrl.origin || here.pathname !== pageUrl.pathname || here.search !== pageUrl.search
    || pdfUrl.origin !== pageUrl.origin) throw new Error('Unexpected reader origin');
  const app = window.PDFViewerApplication, prefetch = window.pdfPrefetch, viewer = app?.pdfViewer;
  const pdfDocument = app?.pdfDocument, container = viewer?.container;
  const current = () => pdfDocument && app.pdfDocument === pdfDocument && viewer.pdfDocument === pdfDocument
    && pdfDocument.numPages === expected.pages && new URL(app.url, location.href).href === pdfUrl.href;
  if (!container || !prefetch || !current() || document.visibilityState !== 'visible') throw new Error('The exact reader is not visible');
  const now = () => performance.now(), push = (array, value, cap) => { if (array.length >= cap) array.shift(); array.push(value); };
  const readState = () => ({ page: viewer.currentPageNumber, scaleValue: viewer.currentScaleValue, scale: viewer.currentScale,
    rotation: viewer.pagesRotation, scrollMode: viewer.scrollMode, spreadMode: viewer.spreadMode,
    sidebar: app.pdfSidebar?.visibleView ?? 0, top: container.scrollTop, left: container.scrollLeft,
    robots: prefetch.robotsEnabled, lab: prefetch.diagnosticsEnabled });
  const compact = value => Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) =>
    typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)));
  const observer = new PayloadObservations();
  const result = { token, expected, state: 'observing', finished: false, startedAt: now(), durationMs,
    mutatedReader: false, saved: readState(), samples: [], events: [], eventCounts: {}, sampleCount: 0,
    observationCounts: { refined: 0, retired: 0 }, refinements: [], retirements: [], peaks: {}, errors: [] };
  let timer, leaseUntil = now() + leaseMs, latest, disposed = false, api;
  const listeners = [];
  const listen = (target, type, callback, options) => { if (!target) return;
    target.addEventListener(type, callback, options); listeners.push(() => target.removeEventListener(type, callback, options)); };
  const display = node => {
    if (!node) return null;
    const value = { connected: node.isConnected, width: node.width, height: node.height };
    if (value.connected && value.width > 0 && value.height > 0) {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      value.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      value.displayed = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    } else value.displayed = false;
    return value;
  };
  const controls = (selector, limit) => [...document.querySelectorAll(selector)].slice(0, limit).map(node => {
    const rect = node.getBoundingClientRect(); return { id: node.id, tag: node.tagName, disabled: !!node.disabled,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const panelGeometry = () => {
    const host = document.getElementById('pdf-prefetch-diagnostics');
    if (!host || host.hidden) return null;
    const surface = host.shadowRoot?.querySelector('section');
    if (!surface?.isConnected) return null;
    const rect = surface.getBoundingClientRect(), style = getComputedStyle(surface);
    if (!(rect.width > 0 && rect.height > 0) || style.display === 'none' || style.visibility === 'hidden') return null;
    return { dock: host.dataset.dock || 'float', x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      measurements: !!host.shadowRoot.querySelector('.measurements')?.open };
  };
  const sample = () => {
    if (!current()) throw new Error('Document changed during manual observation');
    const state = prefetch.snapshot(), robots = state.robots, visual = window.visualViewport;
    if (state.visible.length > 32) throw new Error('Unexpected visible-page count');
    const next = { at: now(), reading: readState(), visible: [...state.visible], missing: [...state.visibleMissing],
      pending: [...state.pending], pendingFetches: state.performance.pendingFetchCount,
      previewBytes: state.previewBytes, canvasBytes: state.canvasBytes, source: state.previewSource,
      raw: compact(state.rangeCache), decodedImages: compact(state.decodedImages), robots,
      payloadArtifacts: collectPayloadArtifacts(document), focused: document.hasFocus(),
      selection: { collapsed: window.getSelection()?.isCollapsed ?? true, ranges: window.getSelection()?.rangeCount ?? 0 },
      viewport: { width: visual?.width ?? innerWidth, height: visual?.height ?? innerHeight,
        scale: visual?.scale ?? 1, offsetLeft: visual?.offsetLeft ?? 0, offsetTop: visual?.offsetTop ?? 0,
        dpr: devicePixelRatio, angle: screen.orientation?.angle ?? null },
      canvases: state.visible.map(page => { const view = viewer.getPageView(page - 1);
        return { page, state: view?.renderingState, native: display(view?.canvas), preview: display(view?.div.querySelector('.pdfPrefetchPreview')) }; }),
      toolbar: controls('#toolbarViewer button, #toolbarViewer select', 32),
      header: controls('#spomenarActions button, #spomenarActions a', 16), panel: panelGeometry() };
    for (const item of observer.observe(next)) {
      const key = item.kind === 'refined' ? 'refined' : 'retired'; result.observationCounts[key]++;
      push(key === 'refined' ? result.refinements : result.retirements, item, 64);
    }
    for (const [key, value] of Object.entries({ previewBytes: state.previewBytes, canvasBytes: state.canvasBytes,
      rawBytes: state.rangeCache?.residentBytes ?? 0, cargoBytes: robots.cargoBytes, spriteBytes: robots.spriteBytes,
      activeActors: robots.activeActors, pendingFetches: state.performance.pendingFetchCount })) {
      result.peaks[key] = Math.max(result.peaks[key] ?? 0, value);
    }
    result.sampleCount++; latest = next; push(result.samples, next, 240); return next;
  };
  const cleanup = () => { if (disposed) return; disposed = true; clearTimeout(timer);
    for (const remove of listeners.splice(0)) remove(); result.observersRemoved = true; };
  const finish = reason => {
    if (result.finished) return;
    result.reason = reason;
    if (current()) { result.readingState = readState();
      if (document.visibilityState === 'visible') try { result.final = sample(); } catch (error) { result.errors.push(String(error.message || error)); }
    }
    result.state = reason === 'duration-complete' || reason === 'host-stop' ? 'completed' : 'interrupted';
    result.finishedAt = now(); result.finished = true; result.restorationSkipped = 'manual-observation'; cleanup();
  };
  const trusted = event => {
    if (!event.isTrusted || result.finished) return;
    result.eventCounts[event.type] = (result.eventCounts[event.type] ?? 0) + 1;
    const path = event.composedPath?.() ?? [event.target];
    const control = path.find(node => node?.matches?.('button,select,a,[role="button"]'));
    push(result.events, { at: now(), type: event.type,
      control: control ? { tag: control.tagName, id: String(control.id ?? '').slice(0, 80) } : null,
      touches: event.touches?.length ?? null, scale: Number.isFinite(event.scale) ? event.scale : null }, 256);
  };
  const loop = () => {
    if (result.finished) return;
    if (!current()) return finish('document-changed');
    if (document.visibilityState !== 'visible') return finish('hidden');
    if (now() >= leaseUntil) return finish('host-lease-expired');
    if (now() - result.startedAt >= durationMs) return finish('duration-complete');
    try { sample(); } catch (error) { result.errors.push(String(error.message || error)); return finish('sample-failed'); }
    timer = setTimeout(loop, Math.min(500, durationMs - (now() - result.startedAt), leaseUntil - now()));
  };
  const checkpoint = () => ({ at: latest?.at ?? null, sampleCount: result.sampleCount, peaks: { ...result.peaks },
    eventCounts: { ...result.eventCounts }, observationCounts: { ...result.observationCounts },
    reading: latest ? { ...latest.reading } : null, viewport: latest ? { ...latest.viewport } : null,
    raw: latest ? { ...latest.raw } : null, robots: compact(latest?.robots) });
  const status = () => ({ ok: true, token, state: result.state, finished: result.finished, mutatedReader: false,
    elapsedMs: now() - result.startedAt, leaseRemainingMs: Math.max(0, leaseUntil - now()), clientCheckpoint: checkpoint() });
  const valid = supplied => supplied === token;
  api = Object.freeze({
    status(supplied) { return valid(supplied) ? status() : { ok: false }; },
    heartbeat(supplied) { if (!valid(supplied)) return { ok: false }; if (!result.finished) leaseUntil = now() + leaseMs; return status(); },
    stop(supplied) { if (!valid(supplied)) return { ok: false }; finish('host-stop'); return status(); },
    result(supplied) { return valid(supplied) && result.finished ? result : null; },
    dispose(supplied) { if (!valid(supplied)) return { ok: false }; finish('host-dispose');
      if (window.__spomenarManualProbe === api) delete window.__spomenarManualProbe; return { ok: true, disposed: true }; },
  });
  window.__spomenarManualProbe = api;
  for (const type of ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange', 'gestureend',
    'pointerdown', 'pointerup', 'click', 'keydown', 'selectionchange']) listen(document, type, trusted, { capture: true, passive: true });
  listen(container, 'scroll', trusted, { passive: true });
  listen(window, 'orientationchange', trusted, { passive: true });
  listen(window, 'resize', trusted, { passive: true });
  listen(window.visualViewport, 'resize', trusted, { passive: true });
  listen(window.visualViewport, 'scroll', trusted, { passive: true });
  listen(document, 'visibilitychange', () => { if (document.visibilityState !== 'visible') finish('hidden'); });
  listen(window, 'pagehide', () => finish('pagehide'));
  const error = event => { push(result.errors, String(event.message || event.reason).slice(0, 500), 16); };
  listen(window, 'error', error); listen(window, 'unhandledrejection', error);
  loop(); return { ...status(), durationMs, leaseMs };
})
