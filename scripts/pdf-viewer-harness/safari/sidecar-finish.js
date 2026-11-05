(async options => {
  // @include awake-idle.mjs
  const probe = window.__spomenarSidecarProbe;
  if (!probe || probe.token !== options?.token) throw new Error('No matching sidecar owner to finish');
  const { result, sample, dispose, restore, guard, sleep, panel, panelState } = probe;
  const viewer = PDFViewerApplication.pdfViewer, container = viewer.container;
  const closeEnough = (left, right) => Math.abs(left - right) <= 1;
  const settled = state => state.robots.activeActors === 0 && state.robots.activePayloads === 0
    && state.robots.retainedBytes === 0 && !state.robots.scheduled && !state.robots.caption?.pendingExpiry
    && Object.values(state.effectNodes).every(count => count === 0);
  const displayed = image => image?.connected && image.width > 0 && image.height > 0
    && image.rect.width > 0 && image.rect.height > 0
    && image.computed.display !== 'none' && image.computed.visibility !== 'hidden';
  const useful = state => state.documentVisible && state.canvases.length > 0 && state.missing.length === 0
    && state.canvases.every(page => displayed(page.preview) || page.state === 3 && displayed(page.native));
  const ready = state => settled(state) && useful(state) && !state.pending.length && !state.pendingFetches
    && !state.source?.pending && !state.source?.decoding && !state.source?.queuedDecodes
    && !state.raw?.activeOperations && !state.raw?.pendingRequests && !state.raw?.imageDecodeActive && !state.raw?.imageDecodeQueued;
  const nextFrame = maximum => new Promise((resolve, reject) => {
    let id, timer;
    const end = (at, error) => { cancelAnimationFrame(id); clearTimeout(timer); error ? reject(error) : resolve(at); };
    id = requestAnimationFrame(at => end(at));
    timer = setTimeout(() => end(undefined, new Error('No animation frame during sidecar restoration')), maximum);
  });
  const settle = async maximum => {
    const began = performance.now();
    while (!result.interrupted && performance.now() - began < maximum) {
      const state = sample();
      if (settled(state)) return { at: performance.now(), elapsedMs: performance.now() - began, state, settled: true };
      await sleep(80);
    }
    const state = sample();
    return { at: performance.now(), elapsedMs: performance.now() - began, state, settled: settled(state) };
  };
  function pointGesture(kind, dx, dy) {
    guard();
    const controls = panel(), handle = controls?.[kind];
    if (!handle) throw new Error('Motion Lab control is missing');
    const box = handle.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    const pointerId = 90541;
    const event = (type, px, py) => new PointerEvent(type, { pointerId, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: px, clientY: py,
      bubbles: true, composed: true, cancelable: true });
    try {
      handle.dispatchEvent(event('pointerdown', x, y));
      window.dispatchEvent(event('pointermove', x + dx, y + dy));
    } finally { window.dispatchEvent(event('pointerup', x + dx, y + dy)); }
  }
  function dock(value) {
    guard();
    const button = panel()?.root.querySelector('[data-panel-dock="' + value + '"]');
    if (!button) throw new Error('Motion Lab docking control is missing');
    button.click();
  }
  function geometry() {
    const value = panelState(), area = container.getBoundingClientRect();
    if (!value) throw new Error('Motion Lab did not open');
    const visual = window.visualViewport;
    const viewport = { x: visual?.offsetLeft || 0, y: visual?.offsetTop || 0,
      width: visual?.width || innerWidth, height: visual?.height || innerHeight };
    if (value.rect.left < viewport.x - 1 || value.rect.top < viewport.y - 1
        || value.rect.right > viewport.x + viewport.width + 1 || value.rect.bottom > viewport.y + viewport.height + 1) {
      throw new Error('Motion Lab extends beyond the visual viewport');
    }
    return { ...value, viewport, reader: area.toJSON(), reading: probe.readState(),
      scrollWidth: container.scrollWidth, scrollHeight: container.scrollHeight,
      pages: pdfPrefetch.snapshot().visible.map(page => ({ page, rect: viewer.getPageView(page - 1).div.getBoundingClientRect().toJSON() })) };
  }
  async function checkPanel() {
    guard();
    pdfPrefetch.setDiagnosticsEnabled(true);
    await sleep(80); guard();
    const original = panelState();
    if (!original) throw new Error('Motion Lab has no geometry');
    // Keep recovery armed while the first undock and its measurement are in flight.
    probe.setPanelRestore(() => {
      if (result.interrupted) return;
      if (!panel()) pdfPrefetch.setDiagnosticsEnabled(true);
      if (panelState().dock !== original.dock) dock(original.dock);
      let current = panelState();
      pointGesture('resize', (original.rect.width - current.rect.width) * (original.dock === 'right' ? -1 : 1),
        original.dock === 'float' ? original.rect.height - current.rect.height : 0);
      if (original.dock === 'float') {
        current = panelState();
        pointGesture('drag', original.rect.x - current.rect.x, original.rect.y - current.rect.y);
      }
      panel().root.querySelector('.measurements').open = original.measurements;
    });
    if (original.dock !== 'float') { dock('float'); await sleep(500); guard(); }
    const floating = panelState();
    const restorePanel = () => {
      if (result.interrupted) return;
      if (!panel()) pdfPrefetch.setDiagnosticsEnabled(true);
      if (panelState().dock !== 'float') dock('float');
      let current = panelState();
      pointGesture('resize', floating.rect.width - current.rect.width, floating.rect.height - current.rect.height);
      current = panelState();
      pointGesture('drag', floating.rect.x - current.rect.x, floating.rect.y - current.rect.y);
      if (original.dock !== 'float') {
        dock(original.dock); current = panelState();
        pointGesture('resize', (original.rect.width - current.rect.width) * (original.dock === 'right' ? -1 : 1), 0);
      }
      const details = panel()?.root.querySelector('.measurements');
      if (details) details.open = original.measurements;
    };
    probe.setPanelRestore(restorePanel);
    const trials = [], before = geometry();
    result.panel = { before, trials };
    const visual = before.viewport, roomBelow = visual.y + visual.height - 8 - before.rect.bottom;
    pointGesture('drag', 0, roomBelow >= 12 ? 12 : -12);
    await sleep(80); guard();
    const moved = geometry(); trials.push({ action: 'drag', state: moved });
    if (closeEnough(moved.rect.y, before.rect.y)) throw new Error('Motion Lab drag did not move');
    const dw = moved.rect.width > 260 ? -20 : 20, dh = moved.rect.height > 180 ? -20 : 20;
    pointGesture('resize', dw, dh);
    await sleep(80); guard();
    const resized = geometry(); trials.push({ action: 'resize', state: resized });
    if (closeEnough(resized.rect.width, moved.rect.width) && closeEnough(resized.rect.height, moved.rect.height)) {
      throw new Error('Motion Lab resize did not change its size');
    }
    const base = geometry();
    for (const value of ['left', 'right', 'float']) {
      dock(value); await sleep(500); guard();
      const state = geometry();
      trials.push({ action: 'dock-' + value, state });
      if (state.dock !== value) throw new Error('Dock control did not select ' + value);
      if (value === 'float' && Math.abs(state.columnX) > 1) throw new Error('Floating lab retained a column displacement');
      if (value === 'left' && state.columnX < -1 || value === 'right' && state.columnX > 1) throw new Error('Column moved toward the wrong dock');
      if (!closeEnough(state.reading.top, base.reading.top) || !closeEnough(state.reading.left, base.reading.left)
          || state.reading.scaleValue !== base.reading.scaleValue || state.reading.rotation !== base.reading.rotation
          || state.reading.scrollMode !== base.reading.scrollMode || state.reading.spreadMode !== base.reading.spreadMode) {
        throw new Error('Docking changed the reading state');
      }
      const originals = new Map(base.pages.map(page => [page.page, page.rect]));
      for (const page of state.pages) {
        const old = originals.get(page.page);
        if (!old) continue;
        if (!closeEnough(page.rect.left - old.left, state.columnX - base.columnX)
            || !closeEnough(page.rect.width, old.width) || !closeEnough(page.rect.top, old.top)) {
          throw new Error('Column/page displacement differs from its single shared offset');
        }
      }
      const bounds = base.pages.filter(page => page.rect.bottom > base.reader.top && page.rect.top < base.reader.bottom);
      if (bounds.length) {
        const left = Math.min(...bounds.map(page => page.rect.left)) - base.columnX;
        const right = Math.max(...bounds.map(page => page.rect.right)) - base.columnX;
        const room = value === 'left' ? Math.max(0, base.reader.right - right) : Math.max(0, left - base.reader.left);
        if (Math.abs(state.columnX) > room + 1) throw new Error('Column exceeded the opposite blank margin');
      }
    }
    restorePanel(); await sleep(500); guard();
    result.panel.restored = geometry();
    const restored = result.panel.restored;
    if (restored.dock !== original.dock || ['x', 'y', 'width', 'height'].some(key => !closeEnough(restored.rect[key], original.rect[key]))) {
      throw new Error('Motion Lab geometry was not restored');
    }
    probe.setPanelRestore(undefined);
  }
  try {
    guard();
    result.deliverySettled = await settle(6000);
    if (!result.interrupted) {
      await checkPanel();
      guard(); restore();
      result.restorationSettled = await settle(6000);
      const baseline = sample();
      const observed = await observeAwakeIdle({ now: () => performance.now(), deadline: performance.now() + 4000, sample,
        canContinue: () => { guard(); return document.visibilityState === 'visible'; },
        ready, frameCount: state => state.robots.frames, nextFrame });
      guard(); const end = sample();
      result.idle = { ...observed.idle, start: baseline, end,
        framesAdded: observed.idle.framesAdded + end.robots.frames - observed.state.robots.frames, quiet: settled(end) };
      result.restoredViewport = { visible: document.visibilityState === 'visible', focused: document.hasFocus(),
        displayed: useful(end), missingPages: end.canvases.filter(page => !(displayed(page.preview)
          || page.state === 3 && displayed(page.native))).map(page => page.page) };
      result.readingState = probe.readState();
      const saved = result.saved, current = result.readingState;
      result.restorationExact = ['page', 'scaleValue', 'rotation', 'scrollMode', 'spreadMode', 'sidebar', 'robots', 'lab']
        .every(key => current[key] === saved[key]) && closeEnough(current.top, saved.top) && closeEnough(current.left, saved.left)
        && Math.abs(current.scale - saved.scale) <= 1e-8 && result.focusRestored === true;
      if (!result.restorationExact) throw new Error('Reading state differs after restoration');
      if (!result.restorationSettled.settled || !result.idle.quiet || !result.idle.awake || result.idle.framesAdded !== 0
          || !result.restoredViewport.visible || !result.restoredViewport.displayed) {
        throw new Error('Restored sidecar viewport did not reach continuously observed awake, displayed idle');
      }
    }
  } catch (error) {
    if (!result.interrupted) result.failure = String(error.message || error);
  } finally {
    try { restore(); } catch (error) { result.cleanupError = String(error.message || error); }
    dispose(); if (window.__spomenarSidecarProbe === probe) delete window.__spomenarSidecarProbe;
    result.finishedAt = performance.now();
    result.readingState = probe.readState();
  }
  return result;
})
