import test from 'node:test';
import assert from 'node:assert/strict';
import { observeReaderSurfaces } from './surface-observation.mjs';
function fixture(options = {}) {
  let time = 0, callback, mutation, disconnected = false, observed = [], phase = 'delivery';
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const node = (tag, parent = null) => { const value = ({ tagName: tag, className: '', parentNode: parent, isConnected: true,
    classList: { contains(name) { return this.owner.className.split(/\s+/).includes(name); } },
    width: tag === 'CANVAS' ? 300 : undefined, height: tag === 'CANVAS' ? 300 : undefined,
    css: { display: 'block', visibility: 'visible', opacity: '1', transform: 'none' },
    getBoundingClientRect: () => box }); value.classList.owner = value; return value; };
  const outer = node('DIV'), reader = node('DIV', outer), column = node('DIV', reader), root = node('DIV', column);
  const wrapper = node('DIV', root); wrapper.className = 'canvasWrapper';
  const indicator = node('INPUT', outer);
  const old = node('CANVAS', wrapper); let children = [wrapper, old], visible = [1], reactions = [];
  root.querySelectorAll = () => children; root.querySelector = () => children.find(n => n.className === 'pdfPrefetchPreview') ?? null;
  const view = { div: root, canvas: old, renderingState: 3, pdfPage: { imageRevision: 1 } };
  const viewer = { pagesCount: 3, currentPageNumber: 1, _getVisiblePages: () => ({ views: visible.map(id => ({ id })) }),
    getPageView: index => index === 0 ? view : undefined };
  const listeners = new Map(), bus = { on: (name, fn) => listeners.set(name, fn), off: name => listeners.delete(name) };
  const pending = [];
  const observer = observeReaderSurfaces({ viewer, container: reader, bus, document: { visibilityState: 'visible', body: outer, getElementById: () => indicator, querySelectorAll: () => reactions }, window: {},
    now: () => time, requestFrame: fn => (callback = fn, 1), cancelFrame: () => callback = null, style: n => n.css,
    MutationObserver: class { constructor(fn) { mutation = fn; } observe(node, options) { observed.push({ node, options }); } takeRecords() { return pending.splice(0); }
      disconnect() { disconnected = true; } }, phase: () => phase, ...options });
  return { observer, view, viewer, old, root, wrapper, column, outer, indicator, observed, node, pending, listeners,
    step() { time += 16; callback(); }, setChildren(value) { children = value; }, setVisible(value) { visible = value; },
    setReactions(value) { reactions = value; }, setPhase(value) { phase = value; }, mutation, closed: () => disconnected && listeners.size === 0 && callback === null };
}
const page = f => f.observer.result.last.pages.find(p => p.page === 1);
test('null public pointer differs from actual connected predecessor loss and native handoff', () => {
  const f = fixture(), first = page(f), oldId = first.main;
  f.view.canvas = null; f.step();
  assert.equal(page(f).main, null); assert.ok(page(f).surfaces.some(n => n.id === oldId && n.connected));
  f.setChildren([f.wrapper]); f.old.isConnected = false; f.step();
  assert.ok(!page(f).surfaces.some(n => n.id === oldId));
  const next = f.node('CANVAS', f.wrapper); f.setChildren([f.wrapper, next]); f.view.canvas = next; f.step();
  assert.notEqual(oldId, page(f).main); f.observer.stop(); assert.equal(f.closed(), true);
});
test('all canvas owners, wrapper and ancestor style changes are observed without pixel readback', () => {
  const f = fixture(), detail = f.node('CANVAS', f.wrapper), preview = f.node('CANVAS', f.wrapper);
  preview.className = 'pdfPrefetchPreview'; f.view.detailView = { canvas: detail, renderingState: 1 };
  f.setChildren([f.wrapper, f.old, detail, preview]); f.column.css.transform = 'translateX(1.5px)';
  f.outer.css.clipPath = 'inset(10px)'; f.wrapper.css.opacity = '0.5'; f.old.width = 0;
  f.old.getContext = () => { throw new Error('pixel readback is forbidden'); }; f.step();
  const p = page(f), all = [...p.surfaces, ...f.observer.result.last.ancestors];
  assert.ok(all.some(n => n.transform === 'translateX(1.5px)'));
  assert.ok(all.some(n => n.clipPath === 'inset(10px)'));
  assert.ok(all.some(n => n.opacity === '0.5'));
  assert.ok(p.surfaces.some(n => n.id === p.main && n.width === 0));
  assert.ok(p.surfaces.some(n => n.id === p.detail)); assert.ok(p.surfaces.some(n => n.id === p.preview));
  f.observer.stop();
});
test('lost and replaced page roots remain explicit after leaving the visible inventory', () => {
  const f = fixture(), oldRoot = page(f).root; f.setVisible([3]); f.view.div = undefined; f.step();
  assert.deepEqual(page(f), { page: 1, root: null, missing: true });
  f.view.div = f.root; f.root.isConnected = false; f.step(); assert.equal(page(f).connected, false);
  const replacement = f.node('DIV'); replacement.querySelectorAll = () => []; replacement.querySelector = () => null;
  f.view.div = replacement; f.step(); assert.notEqual(page(f).root, oldRoot); f.observer.stop();
});
test('first and final full-span snapshots survive capped change/event history and unchanged frames', () => {
  const f = fixture({ cap: 2 }); const first = f.observer.result.first;
  for (let i = 0; i < 5; i++) { f.view.renderingState = i; f.step();
    f.mutation([{ target: f.root, type: 'attributes', attributeName: 'style' }]); }
  const changes = f.observer.result.changes.length; f.step(); assert.equal(f.observer.result.changes.length, changes);
  f.setPhase('restoration'); f.step(); f.pending.push({ target: f.root, type: 'childList', addedNodes: [f.old] });
  f.observer.stop(); f.observer.stop();
  const r = f.observer.result; assert.equal(r.first, first); assert.equal(r.first.at, 0);
  assert.equal(r.last.phase, 'restoration'); assert.ok(r.last.at > r.first.at);
  assert.equal(r.changes.length, 2); assert.ok(r.droppedChanges > 0); assert.equal(r.events.length, 2);
  assert.ok(r.droppedEvents > 0); assert.equal(r.events.at(-1).kind, 'childList'); assert.equal(f.closed(), true);
});
test('node/page caps and large mutation batches expose bounded losses', () => {
  const f = fixture({ cap: 2, nodeCap: 2, pageCap: 1 }); f.step();
  assert.ok(f.observer.result.droppedNodes > 0); assert.ok(f.observer.result.droppedPages > 0);
  assert.ok(f.observer.result.last.omittedNodes > 0); assert.ok(f.observer.result.last.omittedPages > 0);
  f.mutation(Array.from({ length: 200 }, () => ({ target: f.root, type: 'childList',
    addedNodes: Array(20).fill(f.old), removedNodes: [] })));
  assert.equal(f.observer.result.events.length, 2); assert.equal(f.observer.result.events[0].added.length, 16);
  assert.equal(f.observer.result.events[0].omittedAdded, 4); assert.ok(f.observer.result.droppedEvents >= 198);
  f.observer.stop();
});
test('render events carry revision, phase and identity while stop removes every observer', () => {
  const f = fixture(); f.setPhase('restoration');
  f.listeners.get('pagerendered')({ pageNumber: 1, imageRevision: 72, imagePassRevision: 72 });
  assert.deepEqual(f.observer.result.events.at(-1), { at: 0, phase: 'restoration', type: 'pagerendered',
    page: 1, source: null, loadingState: null, indicatorClass: '', indicatorLoading: false, cssTransform: undefined, error: false, revision: 72, passRevision: 72 });
  f.view._imagePassIntent = {}; f.view._paintedImageIntent = {}; f.view.hasUsefulPresentation = true; f.step();
  assert.equal(page(f).hasUsefulPresentation, true);
  assert.notEqual(page(f).intent, page(f).paintedIntent); f.observer.stop(); assert.equal(f.closed(), true);
});

test('existing publication/eviction events are bounded, deduplicated and omit private fields', () => {
  const f = fixture({ cap: 2 });
  const events = [1, 2, 3].map(sequence => ({ sequence, at: sequence, type: 'canvas-evict',
    data: { page: 100, bytes: 128, url: 'private', text: 'private' } }));
  f.observer.performance(events); f.observer.performance(events);
  assert.equal(f.observer.result.events.length, 2); assert.equal(f.observer.result.droppedEvents, 1);
  assert.deepEqual(f.observer.result.events[0].data, { page: 100, bytes: 128 }); f.observer.stop();
});

test('detached public raster references retain their separate former ancestor ownership', () => {
  const f = fixture(), detached = f.node('DIV'); detached.isConnected = false;
  detached.css.opacity = '0.2'; f.old.parentNode = detached; f.old.isConnected = false;
  f.setChildren([f.wrapper]); f.step();
  assert.ok(page(f).references.some(n => n.tag === 'CANVAS' && !n.connected));
  assert.ok(page(f).references.some(n => n.opacity === '0.2' && !n.connected)); f.observer.stop();
});

test('the ancestor walk stops layout reads at the real Document boundary', () => {
  const f = fixture(); f.outer.parentNode = { nodeType: 9, parentNode: null };
  f.step(); assert.deepEqual(f.observer.result.errors, []);
  assert.equal(f.observer.result.stopped, false); f.observer.stop(); assert.equal(f.closed(), true);
});

test('semantic loading and actual spinner/page classes remain independent across native pass events', () => {
  const f = fixture(); assert.equal(f.observer.result.last.loadingState, null, 'undefined means unmanaged, not idle');
  f.viewer.getPageLoadingState = () => true; f.indicator.className = 'loading';
  f.root.className = 'page loadingIcon loading'; f.step();
  assert.equal(f.observer.result.last.loadingState, true); assert.equal(f.observer.result.last.indicator.loading, true);
  assert.equal(page(f).loadingState, true); assert.equal(page(f).loadingIcon, true); assert.equal(page(f).loading, true);
  f.indicator.className = ''; f.listeners.get('pagerendered')({ pageNumber: 1 }); f.step();
  const event = f.observer.result.events.at(-1), state = f.observer.result.last;
  assert.equal(event.loadingState, true); assert.equal(event.indicatorLoading, false);
  assert.equal(state.loadingState, true); assert.equal(state.indicator.loading, false,
    'a native pass cannot erase the actual class/semantic mismatch from evidence');
  f.listeners.get('pageloadingstatechanged')({ pageNumber: 1 });
  assert.equal(f.observer.result.events.at(-1).type, 'pageloadingstatechanged');
  assert.ok(f.observed.some(({ node, options }) => node === f.indicator && options.attributeOldValue));
  f.mutation([{ target: f.indicator, type: 'attributes', attributeName: 'class', oldValue: 'loading' }]);
  assert.equal(f.observer.result.events.at(-1).oldClass, 'loading'); assert.equal(f.observer.result.events.at(-1).currentClass, '');
  f.viewer.getPageLoadingState = () => false; f.step(); assert.equal(f.observer.result.last.loadingState, false); f.observer.stop();
});

test('irrelevant mutation floods cannot crowd out a relevant raster removal at the batch tail', () => {
  const f = fixture({ cap: 4 }), text = f.node('SPAN'), actor = f.node('CANVAS');
  actor.className = 'pdfDocumentRobotCargo';
  const noise = Array.from({ length: 4000 }, (_, i) => ({ target: i % 2 ? text : actor,
    type: 'attributes', attributeName: 'style' }));
  f.mutation([...noise, { target: f.wrapper, type: 'childList', removedNodes: [f.old] }]);
  const r = f.observer.result; assert.equal(r.ignoredMutations, 4000); assert.equal(r.droppedEvents, 0);
  assert.equal(r.events.length, 1); assert.equal(r.events[0].removed.length, 1); f.observer.stop();
});
test('new raster subtrees are relevant before the next frame has assigned their identities', () => {
  const f = fixture(), wrapper = f.node('DIV'), canvas = f.node('CANVAS', wrapper);
  wrapper.className = 'canvasWrapper'; wrapper.querySelectorAll = () => [canvas];
  f.mutation([{ target: f.root, type: 'childList', addedNodes: [wrapper] }]);
  assert.equal(f.observer.result.events.length, 1); assert.equal(f.observer.result.events[0].added.length, 1);
  assert.equal(f.observer.result.ignoredMutations, 0); f.observer.stop();
});

test('the external indicator omission is included in cumulative node losses at the limit', () => {
  const f = fixture({ nodeCap: 2 });
  assert.ok(f.observer.result.first.omittedNodes > 0);
  assert.equal(f.observer.result.droppedNodes, f.observer.result.first.omittedNodes);
  const before = f.observer.result.droppedNodes; f.step();
  assert.equal(f.observer.result.droppedNodes - before, f.observer.result.last.omittedNodes); f.observer.stop();
});


test('a complete wipe between phase samples retains exact clip progression, native backing and caption continuity', () => {
  const f = fixture(), transit = f.node('DIV', f.outer);
  const coarse = f.node('CANVAS', transit), cleaner = f.node('CANVAS', transit), caption = f.node('DIV', transit);
  coarse.className = 'pdfDocumentRobotQualityCoarse'; cleaner.className = 'pdfDocumentRobotQualityCleaner';
  for (const node of [coarse, cleaner]) node.dataset = { quality: '7', page: '1', imageId: 'portion-2' };
  caption.className = 'pdfDocumentRobotCaption'; caption.textContent = 'Fotografija je spremna.';
  f.setReactions([coarse, cleaner, caption]);
  for (const clip of ['inset(0 0 0 0%)', 'inset(0 0 0 50%)', 'inset(0 0 0 100%)']) {
    coarse.css.clipPath = clip; transit.css.opacity = '1'; f.step();
  }
  coarse.isConnected = cleaner.isConnected = caption.isConnected = false;
  f.setReactions([]); f.step(); f.observer.stop();
  const r = f.observer.result, frames = r.changes.filter(frame => frame.reactions.length);
  assert.deepEqual(frames.map(frame => frame.reactions[0].clipPath), ['inset(0 0 0 0%)', 'inset(0 0 0 50%)', 'inset(0 0 0 100%)']);
  assert.equal(new Set(frames.map(frame => frame.reactions[0].id)).size, 1);
  for (const frame of frames) {
    assert.equal(frame.phase, 'delivery', 'no ordinary phase sample or phase change was needed');
    assert.equal(frame.reactions[0].qualityId, '7'); assert.equal(frame.reactions[0].imageId, 'portion-2');
    assert.equal(frame.reactions[0].width, 300); assert.ok(frame.reactions[0].ancestors.some(n => n.opacity === '1'));
    assert.ok(frame.pages[0].surfaces.some(n => n.id === frame.pages[0].main && n.connected));
    assert.equal(frame.reactions[2].text, 'Fotografija je spremna.');
  }
  assert.deepEqual(r.last.reactions, []); assert.equal(r.stopped, true); assert.deepEqual(r.errors, []);
  assert.equal(r.droppedNodes + r.droppedChanges + r.droppedEvents + r.truncatedTexts, 0); assert.equal(f.closed(), true);
});
test('quality mutations survive unrelated robot noise before the next frame and reaction limits are explicit', () => {
  const f = fixture(), quality = f.node('CANVAS'), actor = f.node('CANVAS');
  quality.className = 'pdfDocumentRobotQualityCoarse'; actor.className = 'pdfDocumentRobotCargo';
  f.mutation([...Array.from({length: 4000}, () => ({target: actor, type: 'attributes', attributeName: 'style'})),
    {target: f.outer, type: 'childList', addedNodes: [quality]},
    {target: quality, type: 'attributes', attributeName: 'style'}]);
  assert.equal(f.observer.result.ignoredMutations, 4000); assert.equal(f.observer.result.events.length, 2);
  const caption = f.node('DIV'); caption.className = 'pdfDocumentRobotCaption'; caption.textContent = 'x'.repeat(2050);
  f.setReactions([caption]); f.step(); assert.equal(f.observer.result.last.reactions[0].text.length, 2048);
  assert.equal(f.observer.result.last.reactions[0].omittedText, 2); assert.ok(f.observer.result.truncatedTexts > 0);
  f.observer.stop();
  const limited = fixture({nodeCap: 2}); limited.setReactions([quality]); limited.step();
  assert.equal(limited.observer.result.last.reactions.length, 0); assert.ok(limited.observer.result.last.omittedNodes > 0);
  limited.observer.stop();
});
