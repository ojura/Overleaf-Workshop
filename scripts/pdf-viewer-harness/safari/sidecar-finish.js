(async options => {
  // @include awake-idle.mjs
  const probe = window.__spomenarSidecarProbe;
  if (!probe || probe.token !== options?.token) throw new Error('The short observation owner does not match');
  const { result, budget, sample, dispose, restore, guard, sleep, panel, panelState } = probe;
  const viewer = PDFViewerApplication.pdfViewer, container = viewer.container;
  const finishDeadline = Math.min(result.startedAt + budget.workMs, performance.now() + budget.finishMs);
  const closeEnough = (left, right) => Math.abs(left - right) <= 1;
  const moving = () => panel()?.host.dataset.panelMoving === 'true' || container.dataset.pdfColumnMoving === 'true';
  const settled = state => !moving() && state.robots.activeActors === 0 && state.robots.activePayloads === 0
    && state.robots.retainedBytes === 0 && !state.robots.queuedDeliveryCovers
    && !(state.payloadArtifacts?.plans?.length) && !state.robots.scheduled && !state.robots.caption?.pendingExpiry
    && Object.values(state.effectNodes).every(count => count === 0);
  const displayed = image => image?.connected && image.width > 0 && image.height > 0
    && image.rect.width > 0 && image.rect.height > 0
    && image.computed.display !== 'none' && image.computed.visibility !== 'hidden';
  const useful = state => state.documentVisible && state.canvases.length > 0 && state.missing.length === 0
    && state.canvases.every(page => displayed(page.preview) || page.state === 3 && displayed(page.native));
  const ready = state => state.prefetchIdle === true && settled(state) && useful(state)
    && state.canvases.every(page => page.state !== 1 && page.state !== 2)
    && !state.pending.length && !state.pendingFetches && state.source?.state !== 'loading'
    && !state.source?.pending && !state.source?.decoding && !state.source?.queuedDecodes
    && !state.raw?.activeOperations && !state.raw?.pendingRequests && !state.raw?.imageDecodeActive && !state.raw?.imageDecodeQueued
    && !state.raw?.externalImageActive && !state.raw?.externalImageQueued && !state.raw?.externalImagePaused;
  const nextFrame = maximum => new Promise((resolve, reject) => {
    let id, timer;
    const end = (at, error) => { cancelAnimationFrame(id); clearTimeout(timer); error ? reject(error) : resolve(at); };
    id = requestAnimationFrame(at => end(at));
    timer = setTimeout(() => end(undefined, new Error('An animation frame did not arrive during reader restoration')), maximum);
  });
  const settle = async maximum => {
    const began = performance.now();
    while (!result.interrupted && performance.now() < Math.min(finishDeadline, began + maximum)) {
      guard();
      const state = sample();
      if (settled(state)) return { at: performance.now(), elapsedMs: performance.now() - began, state, settled: true };
      await sleep(80);
    }
    const state = sample();
    return { at: performance.now(), elapsedMs: performance.now() - began, state, settled: settled(state) };
  };
  function pointGesture(kind, dx, dy, check = guard) {
    check();
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
  function dock(value, check = guard) {
    check();
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
    const readerLeft = area.left + container.clientLeft, readerTop = area.top + container.clientTop;
    const readerClip = { left: Math.max(readerLeft, viewport.x), top: Math.max(readerTop, viewport.y),
      right: Math.min(readerLeft + container.clientWidth, viewport.x + viewport.width),
      bottom: Math.min(readerTop + container.clientHeight, viewport.y + viewport.height) };
    return { ...value, viewport, reader: area.toJSON(), readerClip, reading: probe.readState(),
      panelMoving: panel()?.host.dataset.panelMoving === 'true', columnMoving: container.dataset.pdfColumnMoving === 'true',
      scrollWidth: container.scrollWidth, scrollHeight: container.scrollHeight,
      pages: pdfPrefetch.snapshot().visible.map(page => ({ page, rect: viewer.getPageView(page - 1).div.getBoundingClientRect().toJSON() })) };
  }
  const sameRect = (a, b) => ['left', 'top', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) <= 0.01);
  const sameGeometry = (a, b) => sameRect(a.rect, b.rect) && Math.abs(a.columnX - b.columnX) <= 0.01
    && a.dock === b.dock && a.pages.length === b.pages.length
    && a.pages.every((page, index) => page.page === b.pages[index].page && sameRect(page.rect, b.pages[index].rect))
    && a.reading.top === b.reading.top && a.reading.left === b.reading.left;
  async function settlePanel(action, { check = guard, deadline = finishDeadline } = {}) {
    const began = performance.now(), end = Math.min(deadline, began + budget.settleMs);
    let previous, state;
    while (performance.now() < end) {
      check(); state = geometry();
      if (!state.panelMoving && !state.columnMoving) {
        if (previous && sameGeometry(previous, state)) {
          result.panel.settles.push({ action, elapsedMs: performance.now() - began });
          return state;
        }
        previous = state;
      } else previous = undefined;
      await nextFrame(Math.max(1, Math.min(1000, end - performance.now())));
    }
    check();
    throw new Error('Motion Lab ' + action + ' did not settle');
  }
  async function restoreMeasurements(details, open, { check, deadline }) {
    const end = Math.min(deadline, performance.now() + budget.settleMs);
    let processed = false;
    const toggled = () => { processed = true; };
    details.addEventListener('toggle', toggled, { once: true });
    try {
      details.open = open;
      // Wait for the queued native event before sampling the resulting content geometry.
      while (!processed) {
        check();
        const remaining = end - performance.now();
        if (remaining <= 0) throw new Error('Motion Lab disclosure did not settle');
        await nextFrame(Math.max(1, Math.min(1000, remaining)));
      }
      check();
    } finally { details.removeEventListener('toggle', toggled); }
  }
  function verifyPanel(state, expected) {
    if (state.dock !== expected.dock || state.measurements !== expected.measurements
        || ['x', 'y', 'width', 'height'].some(key => !closeEnough(state.rect[key], expected.rect[key]))) {
      throw new Error('Motion Lab geometry was not restored');
    }
  }
  function checkColumn(base, state, value) {
    if (value === 'left' && state.columnX < -1 || value === 'right' && state.columnX > 1) throw new Error('Column moved toward the wrong dock');
    const bounds = base.pages.filter(page => page.rect.bottom > state.readerClip.top && page.rect.top < state.readerClip.bottom);
    if (!bounds.length) return;
    const left = Math.min(...bounds.map(page => page.rect.left)) - base.columnX;
    const right = Math.max(...bounds.map(page => page.rect.right)) - base.columnX;
    const room = state.columnX >= 0 ? Math.max(0, state.readerClip.right - right) : Math.max(0, left - state.readerClip.left);
    if (Math.abs(state.columnX) > room + 1) throw new Error('Column exceeded the opposite blank margin');
    if (value !== 'float') return;
    if (state.rect.right <= state.readerClip.left || state.rect.left >= state.readerClip.right
        || state.rect.bottom <= state.readerClip.top || state.rect.top >= state.readerClip.bottom) {
      if (Math.abs(state.columnX) > 1) throw new Error('Floating panel outside the reader displaced the column');
      return;
    }
    const overlaps = bounds.some(page => page.rect.bottom > state.rect.top && page.rect.top < state.rect.bottom);
    const clearAt = offset => right + offset + 16 <= state.rect.left + 1 || left + offset >= state.rect.right + 16 - 1;
    const fitsAt = offset => left + offset >= state.readerClip.left - 1 && right + offset <= state.readerClip.right + 1;
    if (!overlaps || clearAt(0)) {
      if (Math.abs(state.columnX) > 1) throw new Error('Floating clearance shifted an already-clear column');
      return;
    }
    const candidates = [state.rect.left - 16 - right, state.rect.right + 16 - left].filter(fitsAt);
    if (candidates.length ? !fitsAt(state.columnX) || !clearAt(state.columnX) : Math.abs(state.columnX) > 1) {
      throw new Error('Floating clearance did not preserve the full page/spread and panel gap');
    }
  }
  async function checkPanel() {
    guard();
    const trials = [], settles = [];
    result.panel = { trials, settles };
    pdfPrefetch.setDiagnosticsEnabled(true);
    const original = await settlePanel('opening');
    let floating = original.dock === 'float' ? original : undefined, panelRestoring;
    const restorePanel = controls => {
      if (panelRestoring) return panelRestoring;
      const check = controls?.guard ?? (() => guard(true));
      const deadline = controls?.deadline ?? performance.now() + budget.restoreMs;
      panelRestoring = Promise.resolve().then(async () => {
        check();
        if (!panel()) pdfPrefetch.setDiagnosticsEnabled(true);
        const details = panel()?.root.querySelector('.measurements');
        if (details && details.open !== original.measurements) {
          await restoreMeasurements(details, original.measurements, { check, deadline });
          await settlePanel('restore measurements', { check, deadline });
        }
        if (floating) {
          if (panelState().dock !== 'float') { dock('float', check); await settlePanel('restore undock', { check, deadline }); }
          let current = panelState();
          // Moving first permits growth near a viewport edge; the final drag corrects any clamp while shrinking.
          if (!closeEnough(current.rect.x, floating.rect.x) || !closeEnough(current.rect.y, floating.rect.y)) {
            pointGesture('drag', floating.rect.x - current.rect.x, floating.rect.y - current.rect.y, check);
            current = panelState();
          }
          if (!closeEnough(current.rect.width, floating.rect.width) || !closeEnough(current.rect.height, floating.rect.height)) {
            pointGesture('resize', floating.rect.width - current.rect.width, floating.rect.height - current.rect.height, check);
          }
          current = panelState();
          if (!closeEnough(current.rect.x, floating.rect.x) || !closeEnough(current.rect.y, floating.rect.y)) {
            pointGesture('drag', floating.rect.x - current.rect.x, floating.rect.y - current.rect.y, check);
          }
          await settlePanel('restore floating geometry', { check, deadline });
        }
        if (original.dock !== 'float') {
          if (panelState().dock !== original.dock) { dock(original.dock, check); await settlePanel('restore dock', { check, deadline }); }
          const current = panelState();
          if (!closeEnough(current.rect.width, original.rect.width)) {
            pointGesture('resize', (original.rect.width - current.rect.width) * (original.dock === 'right' ? -1 : 1), 0, check);
          }
        }
        const restored = await settlePanel('restoration', { check, deadline });
        verifyPanel(restored, original);
        return restored;
      }).finally(() => { panelRestoring = undefined; });
      return panelRestoring;
    };
    // Keep recovery armed while the first undock and its measurement are in flight.
    probe.setPanelRestore(restorePanel);
    if (!floating) { dock('float'); floating = await settlePanel('initial undock'); }
    const before = geometry(); result.panel.before = before;
    const visual = before.viewport, roomBelow = visual.y + visual.height - 8 - before.rect.bottom;
    pointGesture('drag', 0, roomBelow >= 12 ? 12 : -12);
    const moved = await settlePanel('drag'); trials.push({ action: 'drag', state: moved });
    if (closeEnough(moved.rect.y, before.rect.y)) throw new Error('Motion Lab drag did not move');
    const dw = moved.rect.width > 260 ? -20 : 20, dh = moved.rect.height > 180 ? -20 : 20;
    pointGesture('resize', dw, dh);
    const resized = await settlePanel('resize'); trials.push({ action: 'resize', state: resized });
    if (closeEnough(resized.rect.width, moved.rect.width) && closeEnough(resized.rect.height, moved.rect.height)) {
      throw new Error('Motion Lab resize did not change its size');
    }
    const base = geometry();
    for (const value of ['left', 'right', 'float']) {
      dock(value);
      const state = await settlePanel('dock-' + value);
      trials.push({ action: 'dock-' + value, state });
      if (state.dock !== value) throw new Error('Dock control did not select ' + value);
      checkColumn(base, state, value);
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
    }
    result.panel.restored = await restorePanel(); guard();
    probe.setPanelRestore(undefined);
  }
  try {
    guard();
    result.deliverySettled = await settle(budget.settleMs);
    if (!result.interrupted) {
      await checkPanel();
      guard(); await restore(); guard();
      result.restorationSettled = await settle(budget.settleMs);
      const baseline = sample();
      // Restoring the original view can restart progressive native images. One existing
      // finish deadline owns their completion and every renewed continuous idle interval.
      const observed = await observeAwakeIdle({ now: () => performance.now(), deadline: finishDeadline, sample,
        canContinue: () => { guard(); return document.visibilityState === 'visible'; },
        ready, frameCount: state => state.robots.frames, nextFrame });
      guard(); const end = sample();
      result.idle = { ...observed.idle, start: baseline, end,
        framesAdded: observed.idle.framesAdded + end.robots.frames - observed.state.robots.frames, quiet: ready(end) };
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
        throw new Error('The restored reader did not reach continuously observed awake, displayed idle');
      }
    }
  } catch (error) {
    if (!result.interrupted && !probe.closing) result.failure = String(error.message || error);
  } finally {
    try { await restore(); } catch (error) { result.cleanupError = String(error.message || error); }
    dispose(); if (window.__spomenarSidecarProbe === probe) delete window.__spomenarSidecarProbe;
    result.finishedAt = performance.now();
    result.readingState = probe.readState();
  }
  return result;
})
