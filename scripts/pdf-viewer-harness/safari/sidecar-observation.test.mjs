import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserSource } from './browser-source.mjs';

const phone = loadBrowserSource('sidecar-active.js');
const portable = fs.readFileSync(new URL('./payload-observation.mjs', import.meta.url), 'utf8')
  .replace(/^export /gm, '').trim();
const embedded = phone.split('  // BEGIN portable payload observer\n')[1]?.split('  // END portable payload observer')[0]
  .split('\n').map(line => line.startsWith('  ') ? line.slice(2) : line).join('\n').trim();
const start = phone.indexOf('  const sample = () => {'), end = phone.indexOf('  const probe = {', start);
assert.ok(start >= 0 && end > start, 'the actual phone sample function is available');
const pixelStart = phone.indexOf('  const displayed =');
const sampleSource = phone.slice(pixelStart < 0 ? start : pixelStart, end);
const oldPixelStart = phone.indexOf('        if (!entry.firstPixels');
const oldPixelEnd = phone.indexOf('        for (const page of state.robots.pages)', oldPixelStart);
const oldPixelSource = pixelStart < 0 ? 'const recordFirstPixels = (state, target, entry) => {\n'
  + phone.slice(oldPixelStart, oldPixelEnd) + '\n};\n' : '';
const event = JSON.parse(fs.readFileSync(new URL('./fixtures/refine-then-retire.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
function node(kind, id, connected = true) {
  return { isConnected: connected, dataset: { payload: String(id) },
    classList: { contains: name => name === 'pdfDocumentRobot' + kind },
    getBoundingClientRect() { throw new Error('The artifact inventory must not read layout'); } };
}
function snapshot(payload, page = event.page) {
  return { cachePolicy: 'mobile', previewBytes: 0, cacheLimits: { maxPreviewBytes: 8388608 },
    previewSource: { pending: 0 }, performance: { events: [], pendingFetchCount: 0 },
    visible: [page], visibleMissing: [], pending: [], robots: { presentation: 'compact', maxActors: 4,
      activeActors: 1, cargoBytes: 0, maxCargoBytes: 1048576, spriteBytes: 0, maxSpriteBytes: 1048576, retainedBytes: 0,
      pages: payload ? [{ page, payloads: [clone(payload)] }] : [] } };
}
function harness() {
  let at = 0;
  const context = { current: () => true, dispose: () => {}, payloads: new Map(), eventSequences: new Set(),
    result: { startedAt: 0, events: [], samples: [], refinements: [], retirements: [] },
    container: { scrollWidth: 400, scrollHeight: 800, clientWidth: 400, clientHeight: 700 },
    performance: { now: () => ++at }, latest: undefined, nodes: [],
    viewer: { currentPageNumber: event.page }, getComputedStyle: node => node.computed };
  const view = { renderingState: 3, canvas: { isConnected: false, width: 396, height: 564 },
    div: { querySelector: () => context.preview } };
  context.viewer.getPageView = () => view;
  context.prefetch = { snapshot: () => context.latest };
  context.document = { visibilityState: 'visible', querySelectorAll: selector => context.nodes.filter(value => selector.split(',')
    .some(name => value.classList.contains(name.slice(1)))) };
  vm.runInNewContext((embedded ?? portable) + '\nconst payloadObservations = new PayloadObservations();\n'
    + sampleSource + oldPixelSource + '\nglobalThis.phoneSample = sample; globalThis.phoneFirstPixels = recordFirstPixels;', context);
  return { result: context.result, view, setPreview(node) { context.preview = node; },
    firstPixels(state, target = event.page, entry = { at: 0 }) { context.phoneFirstPixels(state, target, entry); return entry; },
    sample(payload, nodes = [], page = event.page) {
    context.latest = snapshot(payload, page); context.nodes = nodes; return context.phoneSample();
  } };
}
function primed() {
  const h = harness(); h.sample(event.before, [node('Cargo', event.before.id)]); return h;
}

test('the phone sample accepts the actual refine-then-retire pair as retirement only', () => {
  const h = primed();
  const sample = h.sample(event.after);
  assert.equal(h.result.refinements.length, 0);
  assert.equal(h.result.retirements.length, 1);
  assert.equal(h.result.retirements[0].kind, 'retired-between-samples');
  assert.equal(sample.payloadArtifacts.complete, true);
  assert.equal(sample.payloadArtifacts.payloads.length, 0);
});

test('the embedded browser observer is the accepted portable source', () => {
  assert.equal(embedded, portable);
});

test('both sidecar expressions remain inert until an explicit owned invocation', async () => {
  for (const filename of ['sidecar-active.js', 'sidecar-finish.js']) {
    const value = vm.runInNewContext(loadBrowserSource(filename), {});
    if (value?.then) await value.catch(() => {});
    assert.equal(typeof value, 'function', filename + ' must not act merely because its source is loaded');
  }
  const owned = { token: 'correct-sidecar-token', result: {} };
  const finish = vm.runInNewContext(loadBrowserSource('sidecar-finish.js'), { window: { __spomenarSidecarProbe: owned } });
  await assert.rejects(finish({ token: 'another-sidecar-token' }), /owner/);
});

test('panel geometry uses the unique floating corner or dock-preserving inner width edge', () => {
  const begin = phone.indexOf('  const panel = () => {'), end = phone.indexOf('  const panelState =', begin);
  assert.ok(begin >= 0 && end > begin, 'the actual active-probe panel selector is available');
  const handles = new Map(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].map(direction =>
    [direction, { dataset: { panelResize: direction } }]));
  let duplicate = false, missing = false;
  const root = { querySelectorAll(selector) {
    if (selector === '.panel-resize') return [...handles.values()];
    const direction = selector.match(/^\[data-panel-resize="([a-z]+)"\]$/)?.[1];
    const handle = handles.get(direction);
    return handle && !missing ? duplicate ? [handle, { ...handle }] : [handle] : [];
  } };
  root.querySelector = selector => root.querySelectorAll(selector)[0];
  const host = { shadowRoot: root, dataset: { dock: 'float' }, hidden: false };
  const context = { document: { getElementById: () => host } };
  vm.runInNewContext(phone.slice(begin, end) + '\nglobalThis.readPanel = panel;', context);
  for (const [dock, direction] of [['float', 'se'], ['left', 'e'], ['right', 'w']]) {
    host.dataset.dock = dock;
    assert.equal(context.readPanel().resize, handles.get(direction), dock + ' must use the exact supported handle');
    duplicate = true; assert.equal(context.readPanel().resize, undefined, 'an ambiguous handle cannot drive a gesture');
    duplicate = false; missing = true; assert.equal(context.readPanel().resize, undefined);
    missing = false;
  }
});

test('retained refinements remain monotone and partial-zero or shrinking rasters fail', () => {
  const h = primed();
  h.sample({ ...clone(event.before), refinements: event.before.refinements + 1, rasterWidth: 342, rasterHeight: 194 },
    [node('Cargo', event.before.id)]);
  assert.equal(h.result.refinements.length, 1);
  assert.equal(h.result.retirements.length, 0);
  for (const dimensions of [[170, 97], [0, 97], [171, 0]]) {
    assert.throws(() => primed().sample({ ...clone(event.before), rasterWidth: dimensions[0], rasterHeight: dimensions[1] }), /shrank|partial-zero/);
  }
});

test('complete artifact ownership and pending work block a zero-raster retirement', () => {
  for (const kind of ['Cargo', 'Arrival', 'CargoUnderlay', 'Cleaner']) {
    const nodes = [...Array.from({ length: 13 }, (_, index) => node('Cleaner', 100 + index)), node(kind, event.after.id)];
    assert.throws(() => primed().sample(event.after, nodes), /still owns/);
  }
  assert.throws(() => primed().sample({ ...clone(event.after), refinementPending: true }), /still owns/);
});

test('terminal retirement freezes count and rejects raster, pending work or artifact resurrection', () => {
  for (const change of [
    value => { value.refinements++; },
    value => { value.rasterWidth = 171; value.rasterHeight = 97; },
    value => { value.refinementPending = true; },
  ]) {
    const h = primed(); h.sample(event.after);
    const after = clone(event.after); change(after);
    assert.throws(() => h.sample(after), /after retirement|resumed raster ownership/);
  }
  const h = primed(); h.sample(event.after);
  assert.throws(() => h.sample(undefined, [node('Arrival', event.after.id)]), /artifact reappeared/);
});

test('identity, deadline, page and target remain strict without a refinement increase', () => {
  for (const change of [
    value => { value.id += 1000; },
    value => { value.imageId += '-changed'; },
    value => { value.deadline++; },
    value => { value.target.x += 0.01; },
  ]) {
    const after = clone(event.before); change(after);
    assert.throws(() => primed().sample(after), /identity|deadline|target/);
  }
  assert.throws(() => primed().sample(event.before, [], event.page + 1), /identity/);
});

test('terminal ownership remains tracked beyond the former 32-payload eviction', () => {
  const h = primed(); h.sample(event.after);
  for (let index = 0; index < 40; index++) {
    h.sample({ ...clone(event.before), id: 100 + index, helpers: [1000 + index] }, [], event.page + index);
  }
  assert.throws(() => h.sample(undefined, [node('CargoUnderlay', event.after.id)]), /artifact reappeared/);
});

function raster({ connected = true, width = 541, height = 768, boxWidth = 330, boxHeight = 470,
  display = 'block', visibility = 'visible' } = {}) {
  return { isConnected: connected, width, height, computed: { display, visibility },
    getBoundingClientRect() {
      if (!connected) throw new Error('Detached backing must not require a layout read');
      return { width: boxWidth, height: boxHeight };
    } };
}

test('firstPixels rejects detached allocation and records a displayed preview during the native draw', () => {
  const h = harness(); h.view.renderingState = 1;
  h.view.canvas = raster({ connected: false, width: 396, height: 564 });
  const allocated = h.sample(event.before);
  assert.equal(h.firstPixels(allocated).firstPixels, undefined);
  h.setPreview(raster());
  const covered = h.sample(event.before), entry = h.firstPixels(covered);
  assert.ok(entry.firstPixels);
  assert.equal(entry.firstPixels.raster.preview.connected, true);
  assert.equal(entry.firstPixels.raster.native.connected, false);
  h.view.canvas = raster({ width: 396, height: 564, visibility: 'hidden' });
  const hiddenNative = h.firstPixels(h.sample(event.before));
  assert.ok(hiddenNative.firstPixels, 'a displayed preview also covers a connected but hidden native draw');
});

test('firstPixels requires FINISHED native state and rejects zero-box or hidden rasters', () => {
  const h = harness(); h.view.canvas = raster({ width: 396, height: 564 });
  h.view.renderingState = 1;
  assert.equal(h.firstPixels(h.sample(event.before)).firstPixels, undefined);
  h.view.renderingState = 3;
  assert.ok(h.firstPixels(h.sample(event.before)).firstPixels);
  for (const options of [{ boxWidth: 0 }, { boxHeight: 0 }, { display: 'none' }, { visibility: 'hidden' }, { width: 0 }]) {
    h.view.canvas = raster({ width: 396, height: 564, ...options });
    assert.equal(h.firstPixels(h.sample(event.before)).firstPixels, undefined);
    h.view.canvas = undefined; h.setPreview(raster(options));
    assert.equal(h.firstPixels(h.sample(event.before)).firstPixels, undefined);
    h.setPreview(undefined);
  }
});
