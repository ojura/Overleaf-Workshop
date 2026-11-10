// Passive surface evidence: no pixel readback, input, navigation or render calls.
export function observeReaderSurfaces({ viewer, container, bus, document, window, now, requestFrame, cancelFrame,
  style, MutationObserver, phase = () => 'observing', cap = 2048, nodeCap = 256, pageCap = 16 }) {
  for (const [value, maximum] of [[cap, 4096], [nodeCap, 512], [pageCap, 32]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid surface observation limit');
  }
  const result = { frames: 0, startedAt: now(), first: null, last: null, changes: [], events: [],
    droppedChanges: 0, droppedEvents: 0, droppedNodes: 0, droppedPages: 0, ignoredMutations: 0, stopped: false, errors: [] };
  const identities = new WeakMap(), relevantNodes = new WeakSet(), watched = new Set(), listeners = [];
  const indicator = document.getElementById?.('pageNumber');
  const loadingState = page => {
    const value = viewer.getPageLoadingState?.(page);
    return typeof value === 'boolean' ? value : null;
  };
  const hasClass = (node, name) => node?.classList?.contains(name) ?? false;
  let serial = 0, frame, stopped = false, previous, lastSequence = -1;
  const id = node => {
    if (!node || typeof node !== 'object' && typeof node !== 'function') return null;
    if (!identities.has(node)) identities.set(node, ++serial);
    return identities.get(node);
  };
  const push = (kind, value) => {
    if (result[kind].length >= cap) {
      result[kind].shift(); result[kind === 'changes' ? 'droppedChanges' : 'droppedEvents']++;
    }
    result[kind].push(value);
  };
  const rect = node => {
    if (!node?.getBoundingClientRect) return null;
    const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const nodeState = node => {
    const css = style(node);
    return { id: id(node), parent: id(node.parentNode), tag: node.tagName, className: String(node.className ?? '').slice(0, 512),
      connected: !!node.isConnected, hidden: !!node.hidden, width: node.width, height: node.height, rect: rect(node),
      display: css.display, visibility: css.visibility, opacity: css.opacity, transform: css.transform,
      transformOrigin: css.transformOrigin, clip: css.clip, clipPath: css.clipPath, overflow: css.overflow,
      overflowX: css.overflowX, overflowY: css.overflowY, contain: css.contain, contentVisibility: css.contentVisibility,
      position: css.position, zIndex: css.zIndex, columnX: css.getPropertyValue?.('--pdf-document-column-x') };
  };
  const status = value => value && Object.fromEntries(['covered', 'total', 'pending', 'failed', 'discovered', 'final', 'revision']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const capture = () => {
    const visible = [...new Set((viewer._getVisiblePages()?.views ?? []).map(entry => entry.id))];
    // Visible pages win the bounded inventory. Keep earlier roots long enough to record loss/replacement.
    const wanted = [...new Set([...visible, ...visible.flatMap(n => [n - 1, n + 1]), ...watched])]
      .filter(n => Number.isInteger(n) && n > 0 && n <= viewer.pagesCount);
    const chosen = wanted.slice(0, pageCap); result.droppedPages += Math.max(0, wanted.length - chosen.length);
    watched.clear(); for (const number of chosen) watched.add(number);
    let remaining = nodeCap, omitted = 0;
    const seen = new Set(), take = node => {
      if (!node || typeof node.getBoundingClientRect !== 'function' || seen.has(node)) return;
      seen.add(node); relevantNodes.add(node);
      if (!remaining) { omitted++; return; }
      remaining--; return nodeState(node);
    };
    const chain = node => {
      const values = []; const loop = new Set();
      while (node && !loop.has(node)) {
        loop.add(node); const value = take(node); if (value) values.push(value);
        node = node.parentElement ?? node.parentNode;
      }
      return values;
    };
    const readerRect = rect(container), ancestors = chain(container), pages = [];
    for (const number of chosen) {
      const view = viewer.getPageView(number - 1), root = view?.div;
      if (!root) { pages.push({ page: number, root: null, missing: true }); continue; }
      const bounds = rect(root);
      const intersection = bounds && readerRect && {
        width: Math.max(0, Math.min(bounds.x + bounds.width, readerRect.x + readerRect.width) - Math.max(bounds.x, readerRect.x)),
        height: Math.max(0, Math.min(bounds.y + bounds.height, readerRect.y + readerRect.height) - Math.max(bounds.y, readerRect.y)),
      };
      const surfaces = [];
      for (const node of [root, ...root.querySelectorAll('.canvasWrapper,canvas')]) {
        // Include disconnected references separately from actual connected descendants.
        const value = take(node); if (value) surfaces.push(value);
        for (const parent of chain(node.parentElement ?? node.parentNode)) surfaces.push(parent);
      }
      const references = [];
      for (const node of [view.canvas, view.detailView?.canvas]) {
        const value = take(node); if (value) references.push(value);
        for (const parent of chain(node?.parentElement ?? node?.parentNode)) references.push(parent);
      }
      pages.push({ page: number, root: id(root), connected: !!root.isConnected, intersection,
        preview: id(root.querySelector?.('.pdfPrefetchPreview')), main: id(view.canvas), detail: id(view.detailView?.canvas),
        loadingState: loadingState(number), loadingIcon: hasClass(root, 'loadingIcon'), loading: hasClass(root, 'loading'),
        state: view.renderingState, hasUsefulPresentation: !!view.hasUsefulPresentation, detailState: view.detailView?.renderingState,
        intent: id(view._imagePassIntent), paintedIntent: id(view._paintedImageIntent),
        revision: view.pdfPage?.imageRevision, passRevision: view.imagePassRevision, paintedRevision: view.paintedImageRevision,
        coverage: status(view.pdfPage?.imageStatus), paintedCoverage: status(view.paintedImageStatus),
        surfaces, references });
    }
    const indicatorState = indicator ? { ...take(indicator), className: String(indicator.className ?? '').slice(0, 512), loading: hasClass(indicator, 'loading') } : null;
    result.droppedNodes += omitted;
    const vp = window.visualViewport;
    return { phase: phase(), documentVisible: document.visibilityState, visible, page: viewer.currentPageNumber,
      loadingState: loadingState(viewer.currentPageNumber), indicator: indicatorState,
      scroll: { top: container.scrollTop, left: container.scrollLeft },
      viewport: vp && { width: vp.width, height: vp.height, offsetTop: vp.offsetTop, offsetLeft: vp.offsetLeft, scale: vp.scale },
      ancestors, pages, omittedNodes: omitted, omittedPages: Math.max(0, wanted.length - chosen.length) };
  };
  const record = () => {
    const state = capture(), value = { at: now(), frame: result.frames, ...state }, key = JSON.stringify(state);
    result.first ??= value; result.last = value;
    if (key !== previous) { push('changes', value); previous = key; }
  };
  const relevant = node => {
    if (!node || typeof node !== 'object') return false;
    if (node === indicator || relevantNodes.has(node)) return true;
    const classes = String(node.className ?? '');
    if (/pdfDocumentRobot/.test(classes)) return false;
    return node.tagName === 'CANVAS' || hasClass(node, 'page') || hasClass(node, 'canvasWrapper')
      || hasClass(node, 'pdfPrefetchPreview');
  };
  const relevantSubtree = node => relevant(node) || [...(node.querySelectorAll?.('.page,.canvasWrapper,canvas,.pdfPrefetchPreview') ?? [])].some(relevant);
  const mutation = records => {
    let accepted = 0;
    for (const item of records) {
      const added = [...(item.addedNodes ?? [])].filter(relevantSubtree), removed = [...(item.removedNodes ?? [])].filter(relevantSubtree);
      const useful = item.type === 'childList' ? added.length > 0 || removed.length > 0 : relevant(item.target);
      if (!useful) { result.ignoredMutations++; continue; }
      // Apply the batch budget only after filtering: text and robot animation cannot consume it.
      if (accepted++ >= 128) { result.droppedEvents++; continue; }
      push('events', { at: now(), phase: phase(), type: 'mutation',
        target: id(item.target), kind: item.type, attribute: item.attributeName,
        oldClass: item.attributeName === 'class' ? String(item.oldValue ?? '').slice(0, 512) : undefined,
        currentClass: item.attributeName === 'class' ? String(item.target.className ?? '').slice(0, 512) : undefined,
        added: added.slice(0, 16).map(id), removed: removed.slice(0, 16).map(id),
        omittedAdded: Math.max(0, added.length - 16), omittedRemoved: Math.max(0, removed.length - 16) });
    }
  };
  const observer = new MutationObserver(mutation);
  observer.observe(container, { subtree: true, childList: true, attributes: true,
    attributeOldValue: true, attributeFilter: ['width', 'height', 'style', 'class', 'hidden'] });
  if (indicator && !container.contains?.(indicator)) observer.observe(indicator, { attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
  for (const name of ['pagerender', 'pagerendered', 'updateviewarea', 'scalechanging', 'rotationchanging', 'pageloadingstatechanged']) {
    const listener = event => push('events', { at: now(), phase: phase(), type: name, page: event.pageNumber, source: id(event.source?.div ?? event.source),
      loadingState: loadingState(event.pageNumber ?? viewer.currentPageNumber), indicatorClass: String(indicator?.className ?? '').slice(0, 512), indicatorLoading: hasClass(indicator, 'loading'),
      cssTransform: event.cssTransform, error: !!event.error, revision: event.imageRevision, passRevision: event.imagePassRevision });
    bus?.on(name, listener); listeners.push(() => bus?.off(name, listener));
  }
  const stop = () => {
    if (stopped) return;
    stopped = true; cancelFrame(frame);
    try { record(); mutation(observer.takeRecords()); } catch (error) { result.errors.push(String(error.message ?? error).slice(0, 256)); }
    observer.disconnect(); for (const remove of listeners) remove();
    result.stopped = true; result.finishedAt = now();
  };
  const sample = () => {
    if (stopped) return;
    result.frames++;
    try { record(); } catch (error) { result.errors.push(String(error.message ?? error).slice(0, 256)); stop(); return; }
    frame = requestFrame(sample);
  };
  sample();
  return { result, stop, performance(events) {
    if (stopped) return;
    for (const event of events ?? []) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) continue;
      lastSequence = event.sequence;
      if (event.at < result.startedAt || !/^(canvas-evict|image-pass|page-render|preview-)/.test(event.type)) continue;
      // Retain only geometry/lifecycle numbers and booleans, never document text or URLs.
      const data = Object.fromEntries(Object.entries(event.data ?? {}).filter(([, value]) =>
        typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)));
      push('events', { at: event.at, observedAt: now(), phase: phase(), type: event.type, sequence: event.sequence, data });
    }
  } };
}
