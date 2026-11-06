/** Release native pointer/key input after an acknowledged or ambiguous press. */
export async function withNativeInput(rpc, method, down, up, action = async () => {}) {
  let value, failure;
  try { await rpc(method, down); value = await action(); }
  catch (error) { failure = error; }
  try { await rpc(method, typeof up === 'function' ? up() : up); }
  catch (error) {
    if (failure) { throw new AggregateError([failure, error], 'Input and release both failed'); }
    throw error;
  }
  if (failure) { throw failure; }
  return value;
}

// Shared browser observations and restoration for the owned fixture page.
export function installPanelProbe(win) {
  const doc = win.document, pref = win.pdfPrefetch;
  const viewer = win.PDFViewerApplication?.pdfViewer ?? win.overleafViewer?.wrapper?.viewer;
  const container = viewer?.container, pdf = viewer?.pdfDocument;
  const key = '__pdfHarnessPanel';
  const check = (ok, message) => { if (!ok) { throw new Error(message); } };
  check(pref && viewer && container && pdf, 'The fixture reader must be initialized');
  check(!win[key], 'Dispose the existing panel probe before installing another');
  let disposed = false, pointer = 9100;
  const waits = new Set(), removers = new Set();
  const now = () => win.performance.now();
  const host = () => doc.getElementById('pdf-prefetch-diagnostics');
  const root = () => host()?.shadowRoot;
  const rect = node => {
    if (!node) { return null; }
    const value = node.getBoundingClientRect();
    return { x: value.x ?? value.left, y: value.y ?? value.top, width: value.width, height: value.height,
      right: value.right ?? value.left + value.width, bottom: value.bottom ?? value.top + value.height };
  };
  const near = (a, b, tolerance = 0.05) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  const sameRect = (a, b, tolerance = 0.6) => !!a && !!b
    && ['x', 'y', 'width', 'height'].every(name => near(a[name], b[name], tolerance));
  const guard = () => {
    check(!disposed, 'Panel probe is disposed');
    check(viewer.pdfDocument === pdf && win.pdfPrefetch === pref, 'The fixture document changed');
    check(doc.visibilityState !== 'hidden', 'The fixture document became hidden');
  };
  const reading = () => ({ page: viewer.currentPageNumber, scale: viewer.currentScale, scaleValue: viewer.currentScaleValue,
    top: container.scrollTop, left: container.scrollLeft, rotation: viewer.pagesRotation,
    scrollMode: viewer.scrollMode, spreadMode: viewer.spreadMode });
  const unchanged = (before, after, label = 'reading restoration') => {
    for (const name of ['page', 'scaleValue', 'rotation', 'scrollMode', 'spreadMode']) {
      check(before[name] === after[name], label + ': ' + name + ' changed');
    }
    for (const name of ['scale', 'top', 'left']) {
      check(near(before[name], after[name], name === 'scale' ? 1e-8 : 0.05), label + ': ' + name + ' changed');
    }
  };
  const room = () => {
    const visual = win.visualViewport;
    const x = visual?.offsetLeft ?? 0, y = visual?.offsetTop ?? 0;
    const width = visual?.width ?? win.innerWidth, height = visual?.height ?? win.innerHeight;
    const mx = Math.min(8, Math.max(0, (width - 1) / 2)), my = Math.min(8, Math.max(0, (height - 1) / 2));
    return { x: x + mx, y: y + my, width: width - 2 * mx, height: height - 2 * my };
  };
  function read() {
    guard();
    const state = pref.snapshot(), robots = state.robots, lab = state.labRobots;
    const panelHost = host(), panelRoot = root(), panel = rect(panelHost);
    const surface = panelRoot?.querySelector('section'), flow = panelRoot?.querySelector('.panel-content-flow');
    const content = panelRoot?.querySelector('.panel-content');
    const surfaceRect = rect(surface), flowRect = rect(flow), css = surface && win.getComputedStyle(surface);
    const number = value => Number.parseFloat(value) || 0;
    const naturalHeight = surfaceRect && flowRect ? flowRect.bottom - surfaceRect.y + (content?.scrollTop ?? 0)
      + number(css.paddingBottom) + number(css.borderBottomWidth) : null;
    const pages = (state.visible ?? []).map(page => {
      const node = viewer.getPageView(page - 1)?.div, box = rect(node);
      check(node?.isConnected && box && box.width > 0 && box.height > 0, 'Visible page ' + page + ' has no canonical rectangle');
      return { page, id: page, rect: box };
    });
    const visual = win.visualViewport, column = state.documentColumn ?? null, pull = robots?.columnPull ?? null;
    return { at: now(), reading: reading(), panel, rect: panel, surface: surfaceRect, flow: flowRect,
      shown: !!panelHost && !panelHost.hidden, dock: panelHost?.dataset.dock ?? 'float',
      details: !!panelRoot?.querySelector('.measurements')?.open, open: !!panelRoot?.querySelector('.measurements')?.open,
      naturalHeight, blankTail: naturalHeight === null || !surfaceRect ? null : Math.max(0, surfaceRect.height - naturalHeight),
      scroll: content ? { top: content.scrollTop, height: content.clientHeight, extent: content.scrollHeight } : null,
      viewport: { x: visual?.offsetLeft ?? 0, y: visual?.offsetTop ?? 0,
        width: visual?.width ?? win.innerWidth, height: visual?.height ?? win.innerHeight, dpr: win.devicePixelRatio },
      reader: rect(container), pages, visible: [...(state.visible ?? [])], missing: [...(state.visibleMissing ?? [])],
      pending: [...(state.pending ?? [])], panelMoving: panelHost?.dataset.panelMoving === 'true',
      columnMoving: container.dataset.pdfColumnMoving === 'true', column, documentColumn: column, pull, columnPull: pull,
      offset: column?.offsetX ?? 0, robotFrames: robots?.frames ?? 0, robotScheduled: !!robots?.scheduled,
      activeActors: robots?.activeActors ?? 0, activePayloads: robots?.activePayloads ?? 0,
      activeEpisodes: robots?.activeEpisodes ?? 0, retainedBytes: robots?.retainedBytes ?? 0,
      labFrames: lab?.renderer?.frames ?? 0, labScheduled: !!lab?.renderer?.scheduled,
      forklift: lab?.actors?.find(actor => actor.vehicle === 'forklift') ?? null };
  }
  function until(predicate, label, limitMs = 15000) {
    check(Number.isFinite(limitMs) && limitMs > 0, 'A finite panel wait is required');
    return new Promise((resolve, reject) => {
      let frame, timer, finished = false;
      const finish = (error, value) => {
        if (finished) { return; }
        finished = true;
        if (frame !== undefined) { win.cancelAnimationFrame(frame); }
        win.clearTimeout(timer); waits.delete(cancel);
        if (error) { reject(error); } else { resolve(value); }
      };
      const cancel = () => finish(new Error('Panel probe disposed during ' + label));
      const poll = () => {
        frame = undefined;
        try {
          guard();
          const value = predicate();
          if (value) { finish(undefined, value); }
          else { frame = win.requestAnimationFrame(poll); }
        } catch (error) { finish(error); }
      };
      waits.add(cancel);
      // This bounds a browser that stops rendering; normal completion follows observed frames.
      timer = win.setTimeout(() => finish(new Error(label + ' did not complete')), limitMs);
      poll();
    });
  }
  const frames = (count = 2, limitMs = 5000) => {
    check(Number.isSafeInteger(count) && count > 0, 'A positive frame count is required');
    let remaining = count;
    return until(() => --remaining < 0, 'animation frames', limitMs);
  };
  async function settle(label = 'panel and column settlement', limitMs = 15000) {
    let previous, stable = 0;
    return until(() => {
      const state = read(), eligible = !state.panelMoving && !state.columnMoving && !state.column?.transition;
      const matching = previous && (state.panel === null && previous.panel === null || sameRect(state.panel, previous.panel, 0.05))
        && near(state.offset, previous.offset)
        && (state.naturalHeight === null && previous.naturalHeight === null || near(state.naturalHeight, previous.naturalHeight, 0.1));
      stable = eligible && matching ? stable + 1 : 0;
      previous = eligible ? state : undefined;
      return stable >= 2 ? state : false;
    }, label, limitMs);
  }
  async function quiet(label = 'panel and both renderers idle', limitMs = 15000) {
    await settle(label, limitMs);
    return until(() => {
      const state = read();
      return !state.panelMoving && !state.columnMoving && !state.column?.transition && !state.pull
        && !state.robotScheduled && !state.labScheduled && !state.activeActors && !state.activePayloads
        && !state.activeEpisodes && !state.forklift?.outside ? state : false;
    }, label, limitMs);
  }
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    const remove = () => { target.removeEventListener(name, callback, options); removers.delete(remove); };
    removers.add(remove);
    return remove;
  };
  function gesture(element, dx, dy) {
    guard();
    check(element?.isConnected, 'The panel input target is unavailable');
    const box = rect(element), x = box.x + box.width / 2, y = box.y + box.height / 2, id = ++pointer;
    const event = (type, target, px, py, buttons) => target.dispatchEvent(new win.PointerEvent(type,
      { bubbles: true, composed: true, cancelable: true, pointerId: id, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons, clientX: px, clientY: py }));
    event('pointerdown', element, x, y, 1);
    try { event('pointermove', win, x + dx, y + dy, 1); }
    finally { event('pointerup', win, x + dx, y + dy, 0); }
  }
  const handle = direction => {
    check(/^(n|ne|e|se|s|sw|w|nw)$/.test(direction), 'Unknown panel resize direction');
    return root()?.querySelector('[data-panel-resize="' + direction + '"]');
  };
  const point = selector => {
    guard();
    const panelRoot = root(), node = panelRoot?.querySelector(selector), box = rect(node);
    check(node?.isConnected && box?.width > 0 && box.height > 0, 'The native input target is unavailable');
    const visual = win.visualViewport, left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
    const right = left + (visual?.width ?? win.innerWidth), bottom = top + (visual?.height ?? win.innerHeight);
    // Corner controls contain two arms and an empty centre. Check the actual hit region.
    for (const fx of [0.5, 0.1, 0.25, 0.75, 0.9]) {
      for (const fy of [0.5, 0.1, 0.25, 0.75, 0.9]) {
        const x = box.x + box.width * fx, y = box.y + box.height * fy;
        if (x < left || y < top || x >= right || y >= bottom || doc.elementFromPoint(x, y) !== host()) { continue; }
        const hit = panelRoot.elementFromPoint(x, y);
        if (hit === node || !node.dataset.panelResize && node.contains(hit)) { return { x, y, rect: box }; }
      }
    }
    throw new Error('The native input target has no reachable point: ' + selector);
  };
  const resize = (direction, dx, dy) => gesture(handle(direction), dx, dy);
  const move = (x, y) => {
    const box = rect(host());
    check(box, 'The panel is unavailable');
    gesture(root().querySelector('.panel-drag'), x - box.x, y - box.y);
  };
  const dock = side => {
    check(['float', 'left', 'right'].includes(side), 'Unknown panel dock');
    const button = root()?.querySelector('[data-panel-dock="' + side + '"]');
    check(button, 'The dock control is unavailable'); button.click();
  };
  async function show(value = true) {
    guard(); pref.setDiagnosticsEnabled(value);
    if (value) { await until(() => host() && !host().hidden && root(), 'panel creation'); }
    await settle('panel visibility');
  }
  async function setDetails(open) {
    guard();
    const details = root()?.querySelector('.measurements');
    check(details, 'The measurements disclosure is unavailable');
    if (details.open === open) { await frames(2); return; }
    let processed = false;
    const remove = listen(details, 'toggle', () => { processed = true; }, { once: true });
    try {
      details.open = open;
      await until(() => processed, 'native disclosure toggle');
      await settle('disclosure content geometry');
    } finally { remove(); }
  }
  async function setRect(next) {
    check(next && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(next[key])), 'A finite panel rectangle is required');
    if (host()?.dataset.dock !== 'float') { dock('float'); await settle('undocking'); }
    const available = room();
    move(available.x, available.y);
    let current = rect(host());
    resize('se', next.width - current.width, next.height - current.height);
    move(next.x, next.y);
    await settle('floating rectangle');
    current = rect(host());
    return current;
  }
  const deepFocus = () => {
    let node = doc.activeElement;
    while (node?.shadowRoot?.activeElement) { node = node.shadowRoot.activeElement; }
    return node;
  };
  function selector(node, within) {
    if (node.id) { return '#' + win.CSS.escape(node.id); }
    const parts = [];
    while (node && node !== within && node.nodeType === 1) {
      const tag = node.localName;
      const siblings = Array.from(node.parentNode?.children ?? []).filter(value => value.localName === tag);
      parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function focusState() {
    const path = [];
    let within = doc, node = doc.activeElement;
    while (node) {
      path.push(selector(node, within));
      within = node.shadowRoot; node = within?.activeElement;
    }
    const focused = deepFocus();
    return { path, body: focused === doc.body || focused === doc.documentElement,
      ...(typeof focused?.selectionStart === 'number'
        ? { selection: { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } } : {}) };
  }
  function restoreFocus(saved) {
    if (saved.body) { deepFocus()?.blur?.(); return; }
    let within = doc, node;
    for (const part of saved.path) { node = within?.querySelector(part); within = node?.shadowRoot; }
    check(node?.isConnected, 'The saved focused element is unavailable');
    node.focus({ preventScroll: true });
    if (saved.selection && typeof node.setSelectionRange === 'function') {
      node.setSelectionRange(saved.selection.start, saved.selection.end, saved.selection.direction);
    }
  }
  function capture() {
    const state = read();
    return { reading: state.reading, shown: state.shown, panel: state.shown ? state.panel : null,
      dock: state.dock, details: state.details, robots: pref.robotsEnabled, focus: focusState() };
  }
  async function restore(saved) {
    guard();
    const before = saved.reading;
    if (viewer.pagesRotation !== before.rotation) { viewer.pagesRotation = before.rotation; }
    if (viewer.scrollMode !== before.scrollMode) { viewer.scrollMode = before.scrollMode; }
    if (viewer.spreadMode !== before.spreadMode) { viewer.spreadMode = before.spreadMode; }
    if (viewer.currentScaleValue !== before.scaleValue) { viewer.currentScaleValue = before.scaleValue; }
    if (viewer.currentPageNumber !== before.page) { viewer.currentPageNumber = before.page; }
    container.scrollTop = before.top; container.scrollLeft = before.left;
    if (saved.panel) {
      await show(true);
      await setDetails(saved.details);
      await setRect(saved.panel);
      if (saved.dock !== 'float') {
        dock(saved.dock); await settle('saved docking');
        const current = rect(host()), sign = saved.dock === 'right' ? -1 : 1;
        resize(saved.dock === 'right' ? 'w' : 'e', sign * (saved.panel.width - current.width), 0);
        await settle('saved dock width');
      }
    } else if (root()?.querySelector('.measurements')) {
      await setDetails(saved.details);
    }
    if (pref.robotsEnabled !== saved.robots) { pref.setRobotsEnabled(saved.robots); }
    if (pref.diagnosticsEnabled !== saved.shown) { await show(saved.shown); }
    await quiet('saved panel and actor restoration');
    container.scrollTop = before.top; container.scrollLeft = before.left;
    restoreFocus(saved.focus);
    await frames(3);
    const after = read();
    unchanged(before, after.reading);
    check(after.shown === saved.shown, 'Panel visibility was not restored');
    if (saved.panel) {
      check(after.dock === saved.dock && after.details === saved.details && sameRect(after.panel, saved.panel),
        'Panel geometry or disclosure was not restored');
    }
    const focus = focusState();
    check(focus.body === saved.focus.body && (focus.body || JSON.stringify(focus.path) === JSON.stringify(saved.focus.path)),
      'Reader focus was not restored');
    return { reading: after.reading, panel: after.panel, dock: after.dock, details: after.details,
      exactReading: true, exactPanel: true, exactFocus: true, state: after };
  }
  const api = { read, reading, capture, restore, until, frames, settle, quiet, gesture, handle, point, move, resize, dock,
    setRect, setDetails, show, room, rect, near, sameRect, unchanged, listen,
    get host() { return host(); }, get root() { return root(); }, viewer, container, pref,
    dispose() {
      if (disposed) { return; }
      disposed = true;
      for (const cancel of [...waits]) { cancel(); }
      for (const remove of [...removers]) { remove(); }
      if (win[key] === api) { delete win[key]; }
    } };
  win[key] = api;
  return { installed: true, name: key };
}
