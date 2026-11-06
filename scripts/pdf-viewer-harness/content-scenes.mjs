import assert from 'node:assert/strict';
import { installPanelProbe, withNativeInput } from './panel-probe.mjs';

/** Hold the first fixture host initialization for three actual frames while an open request waits. */
export function installHostGap(win) {
  const key = '__pdfHarnessHostGap', doc = win.document;
  if (win[key]) { throw new Error('An existing host-initialization probe is active'); }
  let held, frame, timer, observer, disposed = false;
  const receipt = { frames: 0, released: false };
  const writes = () => win.harness?.messages('saveState').length ?? 0;
  const panel = () => doc.getElementById('pdf-prefetch-diagnostics');
  const remove = () => {
    win.removeEventListener('message', receive, true);
    if (frame !== undefined) { win.cancelAnimationFrame(frame); frame = undefined; }
    win.clearTimeout(timer);
  };
  const release = () => {
    if (receipt.released || !held) { return; }
    receipt.beforeRelease = !!panel(); receipt.earlyWrites = writes() - receipt.writesBefore;
    receipt.releasedAt = win.performance.now(); receipt.released = true;
    remove();
    win.postMessage(held, '*');
    // A page that never creates the panel still releases its diagnostic observer.
    timer = win.setTimeout(() => observer?.disconnect(), 5000);
  };
  const observe = () => {
    const node = panel();
    if (!node || receipt.firstPanelAt !== undefined) { return; }
    receipt.firstPanelAt = win.performance.now();
    receipt.firstOpen = !!node.shadowRoot?.querySelector('.measurements')?.open;
    observer.disconnect(); win.clearTimeout(timer);
  };
  const tick = () => {
    frame = undefined;
    receipt.frames++;
    if (receipt.frames >= 3) { release(); } else { frame = win.requestAnimationFrame(tick); }
  };
  function receive(event) {
    if (disposed || held || event.data?.type !== 'initState') { return; }
    event.stopImmediatePropagation();
    held = event.data;
    Object.assign(receipt, { receivedAt: win.performance.now(), prefetchReady: !!win.pdfPrefetch,
      hostOpen: held.content?.motionLabMeasurementsOpen, panelBefore: !!panel(), writesBefore: writes() });
    observer = new win.MutationObserver(observe); observer.observe(doc, { childList: true, subtree: true });
    win.pdfPrefetch?.setDiagnosticsEnabled(true);
    receipt.panelAfterRequest = !!panel();
    frame = win.requestAnimationFrame(tick);
    // This releases host initialization if rendering stops before the three observed frames.
    timer = win.setTimeout(() => { receipt.error = 'Host-delay frames did not arrive'; release(); }, 5000);
  }
  const api = { receipt, dispose() {
    if (disposed) { return; }
    disposed = true;
    release(); remove(); observer?.disconnect();
    if (win[key] === api) { delete win[key]; }
  } };
  win[key] = api;
  win.addEventListener('message', receive, true);
  return { installed: true };
}

export function validateHostGap(gap) {
  assert.equal(gap.error, undefined, 'The host-delay probe stopped rendering');
  assert.equal(gap.prefetchReady, true, 'The controller must exist before host initialization');
  assert.equal(gap.hostOpen, true, 'The delayed host preference must start expanded');
  assert.equal(gap.panelBefore, false);
  assert.equal(gap.panelAfterRequest, false);
  assert.equal(gap.beforeRelease, false, 'The pending open request painted a default panel');
  assert.equal(gap.earlyWrites, 0, 'Pending panel creation persisted state before the host merged it');
  assert.equal(gap.frames, 3);
  assert.equal(gap.firstOpen, true, 'The first panel ignored the saved host preference');
  assert.ok(gap.firstPanelAt >= gap.releasedAt, 'The panel painted before host initialization was released');
}

export function validateContentGeometry(state, label) {
  assert.ok(state.shown && state.panel && state.flow, label + ': the panel must be shown and measured');
  assert.ok(state.panel.width > 0 && state.panel.height > 0, label + ': invalid panel dimensions');
  assert.ok(state.blankTail <= 1.1, label + ': empty space extends below useful content');
  const viewport = state.viewport;
  assert.ok(state.panel.x >= viewport.x - 1 && state.panel.y >= viewport.y - 1
    && state.panel.right <= viewport.x + viewport.width + 1
    && state.panel.bottom <= viewport.y + viewport.height + 1, label + ': panel extends beyond the visual viewport');
}

export async function removeHostGap(evaluate, rpc, identifier) {
  const errors = [];
  try { await evaluate('window.__pdfHarnessHostGap?.dispose(); true'); }
  catch (error) { errors.push(error); }
  if (identifier) {
    try { await rpc('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) { throw new AggregateError(errors, 'Host-delay cleanup failed'); }
}

export async function runScenario(context) {
  const { evaluate, rpc, checkpoint } = context;
  const results = [];
  const call = (method, ...args) => evaluate('window.__pdfHarnessPanel.' + method + '(...' + JSON.stringify(args) + ')',
    { timeoutMs: 30000 });
  const record = async (label, value) => {
    results.push({ label, value }); await checkpoint(label, value); return value;
  };
  const install = async () => {
    await evaluate('(' + installPanelProbe.toString() + ')(window)');
    await evaluate('window.__pdfHarnessContent = { toggles: [] }');
  };
  await install();
  const saved = await call('capture');
  const restore = context.defer('content-panel', async () => {
    let restoration;
    try {
      const exists = await evaluate('!!window.__pdfHarnessPanel');
      if (!exists) { await install(); }
      restoration = await call('restore', saved);
      await checkpoint('content-restoration', restoration);
    } finally {
      await evaluate('window.__pdfHarnessPanel?.dispose(); delete window.__pdfHarnessContent; true');
    }
    return restoration;
  });
  const snapshot = () => call('read');
  const baseline = saved.reading;
  const settle = async (label, { quiet = false } = {}) => {
    const state = await call(quiet ? 'quiet' : 'settle', label);
    await call('unchanged', baseline, state.reading, label);
    if (state.shown) { validateContentGeometry(state, label); }
    return record(label, state);
  };
  const move = (x, y, buttons = 0) => rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons });
  const point = selector => call('point', selector);
  async function watchToggles() {
    return evaluate('(() => { const p=window.__pdfHarnessPanel,s=window.__pdfHarnessContent,d=p.root.querySelector(".measurements");'
      + 'if(s.node!==d){s.node=d;p.listen(d,"toggle",e=>s.toggles.push({at:performance.now(),open:d.open,trusted:e.isTrusted}));}'
      + 'return {count:s.toggles.length,expected:!d.open};})()');
  }
  async function click(selector, waitToggle = true) {
    let watch;
    if (selector === '.measurements > summary') {
      await evaluate('(() => { const p=window.__pdfHarnessPanel,r=p.root,n=r.querySelector(".measurements > summary"),'
        + 'c=r.querySelector(".panel-content"),a=p.rect(n),b=p.rect(c);'
        + 'if(a.y<b.y)c.scrollTop+=a.y-b.y;else if(a.bottom>b.bottom)c.scrollTop+=a.bottom-b.bottom;return true;})()');
      await call('frames', 1);
      watch = await watchToggles();
    }
    const at = await point(selector);
    await move(at.x, at.y);
    await withNativeInput(rpc, 'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    if (watch && waitToggle) {
      await context.waitFor('window.__pdfHarnessContent.toggles.length > ' + watch.count
        + ' && window.__pdfHarnessContent.toggles.at(-1).open === ' + watch.expected,
      { what: 'native disclosure event' });
    }
    return at;
  }
  async function drag(start, points) {
    const samples = [];
    await move(start.x, start.y);
    let last = start;
    await withNativeInput(rpc, 'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 },
      () => ({ type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 }), async () => {
      for (const next of points) {
        last = next; await move(last.x, last.y, 1); await call('frames', 1);
        samples.push(await snapshot());
      }
    });
    return samples;
  }
  const handle = direction => point('[data-panel-resize="' + direction + '"]');
  const stored = () => evaluate('fetch("/state?doc="+encodeURIComponent(new URL(location.href).searchParams.get("doc"))).then(r=>r.json())');
  async function waitPreference(open) {
    await context.waitFor('(async()=>{const s=await fetch("/state?doc="+encodeURIComponent(new URL(location.href).searchParams.get("doc"))).then(r=>r.json());'
      + 'return s?.motionLabMeasurementsOpen===' + open + ';})()', { what: 'persisted disclosure preference' });
    return stored();
  }
  async function reload() {
    await evaluate('window.__pdfHarnessPanel?.dispose(); delete window.__pdfHarnessContent; true');
    await context.reload();
    await install();
    await call('show', true);
    return settle('content-reloaded');
  }
  try {
    await call('show', true);
    await call('quiet', 'initial page work');
    const initial = await settle('default-collapsed');
    assert.equal(initial.details, false, 'A fresh fixture defaults to a collapsed measurements disclosure');
    await context.screenshot('content-collapsed');
    await click('.measurements > summary');
    const expanded = await settle('content-expanded');
    assert.equal(expanded.details, true);
    assert.ok(expanded.panel.height > initial.panel.height + 60, 'Opening did not grow useful content');
    assert.ok(Math.abs(expanded.panel.width - initial.panel.width) < 0.1);
    await context.screenshot('content-expanded');
    await click('[data-panel-resize="n"]');
    await withNativeInput(rpc, 'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', modifiers: 8, windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
      { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', modifiers: 0, windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    const north = await settle('content-north-key');
    assert.ok(north.panel.y > expanded.panel.y + 20, 'The native north-handle key did not move its top edge');
    await click('.measurements > summary');
    const collapsed = await settle('content-collapsed-again');
    assert.ok(collapsed.panel.height < north.panel.height - 60, 'Collapse retained expanded height');
    assert.ok(Math.abs(collapsed.panel.y - north.panel.y) < 1.1, 'Collapse reused a completed north-resize anchor');
    const beforeBurst = (await watchToggles()).count;
    await click('.measurements > summary', false); await click('.measurements > summary', false);
    await context.waitFor('window.__pdfHarnessContent.toggles.length>' + beforeBurst
      + ' && !window.__pdfHarnessContent.toggles.at(-1).open', { what: 'queued disclosure burst' });
    const toggles = await evaluate('window.__pdfHarnessContent.toggles.slice(' + beforeBurst + ')');
    assert.ok(toggles.every(event => event.trusted), 'The native disclosure did not produce trusted events');
    await record('content-toggle-burst', toggles); await settle('content-burst-settled');
    const northHandle = await handle('n');
    const maximum = await drag(northHandle, [{ x: northHandle.x, y: Math.max(4, northHandle.y - 150) }]);
    for (const state of maximum) { validateContentGeometry(state, 'manual content maximum'); }
    await record('content-manual-maximum', maximum); await settle('content-manual-settled');
    const corner = await handle('nw'), cornerBefore = (await snapshot()).panel;
    const anchored = await drag(corner, [{ x: corner.x - 60, y: corner.y - 60 },
      { x: corner.x - 120, y: corner.y - 100 }, { x: corner.x - 40, y: corner.y - 30 }]);
    for (const state of anchored) {
      assert.ok(Math.abs(state.panel.right - cornerBefore.right) < 1.1, 'NW resize moved its opposite right edge');
      assert.ok(Math.abs(state.panel.bottom - cornerBefore.bottom) < 1.1, 'NW resize moved its opposite bottom edge');
    }
    await record('content-nw-anchor', { before: cornerBefore, samples: anchored }); await settle('content-nw-settled');
    for (const side of ['left', 'right']) {
      await click('[data-panel-dock="' + side + '"]');
      const state = await settle('content-dock-' + side);
      assert.equal(state.dock, side);
      assert.ok(state.panel.height < state.viewport.height - 30, 'Short content filled the dock with blank space');
    }
    await click('[data-panel-dock="float"]'); await settle('content-floating');
    await click('.measurements > summary'); await settle('content-open-before-short');
    const south = await handle('s'), beforeShort = await snapshot();
    await drag(south, [{ x: south.x, y: south.y + 160 - beforeShort.panel.height }]);
    const short = await settle('content-manually-short');
    assert.ok(Math.abs(short.panel.height - 160) < 1.1);
    await click('.measurements > summary');
    const closedShort = await settle('content-close-short');
    assert.ok(closedShort.panel.height <= short.panel.height + 1.1, 'Closing grew the manually short panel');
    await click('.measurements > summary'); await settle('content-open-before-glide');
    await click('[data-panel-dock="left"]');
    const glide = await snapshot(); await record('content-glide-before-toggle', glide);
    assert.equal(glide.panelMoving, true, 'The input arrived after the docking glide');
    await click('.measurements > summary');
    const midGlide = await snapshot(); await record('content-glide-toggle', midGlide);
    assert.equal(midGlide.details, false);
    const glided = await settle('content-glide-closed');
    assert.equal(glided.dock, 'left');
    await click('[data-panel-dock="right"]');
    const beforeHide = await snapshot(); await record('content-glide-before-hide', beforeHide);
    assert.equal(beforeHide.panelMoving, true, 'The close arrived after the docking glide');
    await click('.close');
    const hidden = await settle('content-hidden');
    assert.equal(hidden.shown, false);
    await call('show', true); await settle('content-reopened');
    await click('[data-panel-dock="float"]'); await settle('content-return-float');
    const beforeMove = await snapshot();
    const page = beforeMove.pages.find(value => value.page === baseline.page)?.rect ?? beforeMove.pages[0].rect;
    const grip = await point('.panel-drag');
    const wanted = { x: page.x - beforeMove.offset - 200,
      y: Math.min(beforeMove.viewport.y + beforeMove.viewport.height - beforeMove.panel.height - 8,
        Math.max(beforeMove.reader.y + 30, page.y + 30)) };
    await drag(grip, [{ x: grip.x + wanted.x - beforeMove.panel.x, y: grip.y + wanted.y - beforeMove.panel.y }]);
    const obstructing = await settle('content-overlap');
    assert.ok(obstructing.offset > 40, 'The fixture did not create a positive column displacement');
    const east = await handle('e');
    await drag(east, [{ x: east.x - 100, y: east.y }]);
    const returnTrace = await evaluate('(async()=>{const p=window.__pdfHarnessPanel,trace=[];let done=false,result,failure;'
      + 'const settled=p.settle("content shrink").then(value=>{done=true;result=value;},error=>{done=true;failure=error;});'
      + 'await p.until(()=>{const s=p.read();if(s.offset<-.1)throw new Error("Column crossed the opposite side");'
      + 'if(trace.length<256)trace.push({at:s.at,offset:s.offset,moving:s.columnMoving});return done;},"content shrink samples");'
      + 'await settled;if(failure)throw failure;return {state:result,trace};})()', { timeoutMs: 30000 });
    assert.ok(returnTrace.state.offset >= 0 && returnTrace.state.offset < obstructing.offset - 20,
      'Shrinking did not return the column toward its center');
    await record('content-same-side-return', { from: obstructing.offset, ...returnTrace });
    await settle('content-return-settled', { quiet: true });
    await context.screenshot('content-return');

    // The same current host and normal UI persist both values across real reloads.
    if (!(await snapshot()).details) { await click('.measurements > summary'); }
    await settle('content-persist-open'); await waitPreference(true);
    assert.equal((await reload()).details, true, 'The expanded preference did not survive reload');
    await click('.measurements > summary'); await settle('content-persist-closed'); await waitPreference(false);
    assert.equal((await reload()).details, false, 'The collapsed preference did not survive reload');
    await record('content-persistence', { expanded: true, collapsed: true, stored: await stored() });

    await click('.measurements > summary'); await settle('content-host-gap-save'); await waitPreference(true);
    await evaluate('sessionStorage.removeItem("vscode-state:"+new URL(location.href).searchParams.get("doc")); true');
    let identifier;
    const removePreload = context.defer('content-host-gap', () => removeHostGap(evaluate, rpc, identifier));
    const source = '(' + installHostGap.toString() + ')(window)';
    ({ identifier } = await rpc('Page.addScriptToEvaluateOnNewDocument', { source }));
    assert.ok(typeof identifier === 'string' && identifier, 'Host-delay preload did not return its identifier');
    try {
      await reload();
      await context.waitFor('window.__pdfHarnessHostGap?.receipt.firstPanelAt !== undefined',
        { what: 'first panel after delayed host initialization' });
      const gap = await evaluate('window.__pdfHarnessHostGap.receipt');
      await record('content-host-gap', gap); validateHostGap(gap);
      assert.equal((await stored()).motionLabMeasurementsOpen, true);
    } finally { await removePreload(); }
    await restore();
    return { status: 'passed', results };
  } catch (error) {
    await checkpoint('content-failure', { error: String(error.message ?? error), state: await snapshot().catch(() => null) });
    throw error;
  } finally { await restore(); }
}
