import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadBrowserSource } from './browser-source.mjs';
import { collectPayloadArtifacts, PayloadObservations } from './payload-observation.mjs';
import { qualitySceneEmpty } from './scene-ready.mjs';

const target = { x: 0.1, y: 0.2, width: 0.3, height: 0.2 };
const scene = () => ({
  id: 1, sourcePage: 7, pageNumber: 1, planId: 1, cropId: 0,
  imageId: 'p1-i0', imageIds: ['p1-i0'], target: { ...target }, actorId: 8,
  location: 'page', sharpKind: 'native-page', state: 'wiping', startedAt: 100, deadline: 900, phase: 0.25,
  coarseWidth: 64, coarseHeight: 32, sharpWidth: 0, sharpHeight: 0,
  coarseBytes: 64 * 32 * 4, sharpBytes: 0, spriteBytes: 32 * 32 * 4,
});
function node(kind, current = scene()) {
  const className = 'pdfDocumentRobotQuality' + kind;
  const width = kind === 'Coarse' ? current.coarseWidth : kind === 'Sharp' ? current.sharpWidth : 32;
  const height = kind === 'Coarse' ? current.coarseHeight : kind === 'Sharp' ? current.sharpHeight : 32;
  return {
    isConnected: true, width, height,
    dataset: { quality: String(current.id), page: String(current.pageNumber), imageId: current.imageId },
    classList: { contains: name => name === className },
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 60, left: 10, top: 20, right: 110, bottom: 80 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) } },
  };
}
const nodesFor = current => (current.sharpKind === 'cargo-copy' ? ['Coarse', 'Sharp', 'Cleaner'] : ['Coarse', 'Cleaner']).map(kind => node(kind, current));
const inventory = nodes => collectPayloadArtifacts({
  querySelectorAll: selector => nodes.filter(value => selector.split(',').some(name => value.classList.contains(name.slice(1)))),
});
function sample(current = scene(), nodes = nodesFor(current)) {
  return {
    at: 300,
    payloadArtifacts: inventory(nodes),
    robots: {
      pages: [], queuedDeliveryCovers: 0,
      deliveryPlans: [{ id: 1, pageNumber: 1, committed: true, crops: [{
        id: 0, payloadId: 9, state: 'delivered', protected: false,
        geometry: { ...target, imageId: 'p1-i0', imageIds: ['p1-i0'], kind: 'image' },
      }] }],
      qualityReactions: [current], activeQualityReactions: 1, qualityOutcomes: [],
      cargoBytes: current.coarseBytes + current.sharpBytes,
      spriteBytes: current.spriteBytes,
      retainedBytes: current.coarseBytes + current.sharpBytes + current.spriteBytes,
    },
  };
}
function finish(value, outcome = 'completed') {
  const current = value.robots.qualityReactions[0];
  value.at = 950;
  value.payloadArtifacts = inventory([]);
  value.robots.qualityReactions = [];
  value.robots.activeQualityReactions = 0;
  value.robots.cargoBytes = value.robots.spriteBytes = value.robots.retainedBytes = 0;
  value.robots.qualityOutcomes = [{
    id: current.id, sourcePage: current.sourcePage, pageNumber: current.pageNumber,
    planId: current.planId, cropId: current.cropId, imageId: current.imageId,
    imageIds: current.imageIds, target: current.target, actorId: current.actorId,
    associatedPayloadId: current.associatedPayloadId,
    outcome, reason: outcome === 'completed' ? 'wiped' : 'hidden', at: value.at,
  }];
  return value;
}

test('independent quality artifacts have complete ownership and real raster dimensions', () => {
  const value = sample(), observer = new PayloadObservations();
  assert.equal(value.payloadArtifacts.quality?.length, 1);
  const owned = value.payloadArtifacts.quality[0];
  assert.equal(owned.id, 1);
  assert.equal(owned.coarse.width, 64);
  assert.equal(owned.sharp, undefined, 'page mode reveals the published native raster directly');
  assert.equal(owned.cleaner.width, 32);
  assert.doesNotThrow(() => observer.observe(value));
  assert.doesNotThrow(() => observer.observe(finish(sample())));
  assert.throws(() => observer.observe(sample()), /quality.*(terminal|reappear)/i);
});

test('actual clipping and ancestor visibility corroborate quality and caption display', () => {
  const current = scene(), coarse = node('Coarse', current), parent = { parentElement: null };
  coarse.parentElement = parent;
  let parentOpacity = '1', clipPath = 'inset(0px 0px 0px 25%)';
  const view = { getComputedStyle: value => ({ display: 'block', visibility: 'visible',
    opacity: value === parent ? parentOpacity : '1', clipPath: value === coarse ? clipPath : 'none', transform: 'none' }) };
  coarse.ownerDocument = { defaultView: view };
  const caption = { ...node('Cleaner', current), textContent: 'ASAP: Nježno, po Jeleninoj školi.',
    parentElement: parent, ownerDocument: { defaultView: view },
    classList: { contains: name => name === 'pdfDocumentRobotCaption' } };
  const nodes = [coarse, node('Cleaner', current), caption];
  const before = inventory(nodes);
  assert.equal(before.quality[0].coarse.computed.clipPath, clipPath);
  assert.equal(before.quality[0].coarse.displayed, true);
  assert.equal(before.captions[0].text, caption.textContent);
  assert.equal(before.captions[0].displayed, true);
  clipPath = 'inset(0px 0px 0px 75%)'; parentOpacity = '0';
  const after = inventory(nodes);
  assert.equal(after.quality[0].coarse.computed.clipPath, clipPath);
  assert.equal(after.quality[0].coarse.displayed, false, 'a visible child style cannot override its hidden ancestor');
  assert.equal(after.captions[0].displayed, false);
});

for (const [name, mutate] of [
  ['missing owner', nodes => delete nodes[0].dataset.quality],
  ['mixed payload owner', nodes => { nodes[0].dataset.payload = '9'; }],
  ['mixed plan owner', nodes => { nodes[0].dataset.deliveryPlan = '1'; nodes[0].dataset.deliveryCrop = '0'; }],
  ['unsafe numeric ID', nodes => { nodes[0].dataset.quality = '9007199254740992'; }],
  ['wrong page', nodes => { nodes[0].dataset.page = '2'; }],
  ['wrong logical crop', nodes => { nodes[0].dataset.imageId = 'different'; }],
  ['duplicate coarse layer', nodes => nodes.push(node('Coarse'))],
  ['missing cleaner layer', nodes => nodes.splice(1, 1)],
  ['extra sharp copy over the native page', nodes => nodes.push(node('Sharp'))],
  ['unreported scene', nodes => nodes.push(node('Cleaner', { ...scene(), id: 2 }))],
]) {
  test('rejects quality artifact ' + name, () => {
    const nodes = nodesFor(scene()); mutate(nodes);
    assert.throws(() => new PayloadObservations().observe(sample(scene(), nodes)), /quality|artifact/i);
  });
}

for (const [name, mutate] of [
  ['wrong count', value => { value.robots.activeQualityReactions = 0; }],
  ['uncommitted plan', value => { value.robots.deliveryPlans[0].committed = false; }],
  ['different frozen crop', value => { value.robots.qualityReactions[0].target.width += 1e-12; }],
  ['source alias change', value => { value.robots.qualityReactions[0].imageIds = ['other']; }],
  ['unaccounted coarse pixels', value => { value.robots.qualityReactions[0].coarseBytes = 1; }],
  ['missing finite deadline', value => { value.robots.qualityReactions[0].deadline = Infinity; }],
  ['invalid progress', value => { value.robots.qualityReactions[0].phase = 1.1; }],
  ['wrong sharp owner', value => { value.robots.qualityReactions[0].sharpKind = 'cargo-copy'; }],
  ['duplicate scene', value => { value.robots.qualityReactions.push(structuredClone(value.robots.qualityReactions[0])); value.robots.activeQualityReactions = 2; }],
]) {
  test('rejects quality snapshot ' + name, () => {
    const value = sample(); mutate(value);
    assert.throws(() => new PayloadObservations().observe(value), /quality/i);
  });
}

test('quality cancellation is terminal and cannot be relabelled completion', () => {
  const observer = new PayloadObservations(), value = sample();
  observer.observe(value);
  const cancelled = finish(sample(), 'cancelled');
  assert.doesNotThrow(() => observer.observe(cancelled));
  cancelled.robots.qualityOutcomes[0].outcome = 'completed';
  assert.throws(() => observer.observe(cancelled), /quality.*(outcome|terminal)/i);
});

test('a disappearing quality scene requires its own terminal outcome', () => {
  const observer = new PayloadObservations(); observer.observe(sample());
  const gone = finish(sample()); gone.robots.qualityOutcomes = [];
  assert.throws(() => observer.observe(gone), /quality.*(outcome|missing)/i);
});

test('continuing quality work preserves source, actor, deadline and progress', () => {
  for (const mutate of [
    current => { current.sourcePage++; }, current => { current.actorId++; },
    current => { current.deadline++; }, current => { current.phase = 0.1; },
    current => { current.startedAt++; },
  ]) {
    const observer = new PayloadObservations(); observer.observe(sample());
    const next = sample(); mutate(next.robots.qualityReactions[0]);
    assert.throws(() => observer.observe(next), /quality/i);
  }
});

test('one quality scene transfers from cargo to the page while its payload retires strictly', () => {
  const current = { ...scene(), location: 'cargo', sharpKind: 'cargo-copy', associatedPayloadId: 9,
    sharpWidth: 128, sharpHeight: 64, sharpBytes: 128 * 64 * 4 };
  const carrying = sample(current);
  carrying.robots.deliveryPlans[0].crops[0].state = 'active';
  const payload = {
    id: 9, imageId: 'p1-i0', imageIds: ['p1-i0'], cropKind: 'image', target: { ...target },
    operation: { key: 'photo-9', memberIds: [1] }, helpers: [1], deadline: 500,
    rasterWidth: 64, rasterHeight: 32, refinements: 1, refinementPending: false,
    arrivalCovered: true, stage: 'carry', deposited: false,
  };
  carrying.robots.pages = [{ page: 1, payloads: [payload] }];
  const observer = new PayloadObservations();
  assert.doesNotThrow(() => observer.observe(carrying));
  const placed = sample({ ...scene(), associatedPayloadId: 9, phase: 0.6 });
  placed.robots.pages = [{ page: 1, payloads: [{ ...payload,
    rasterWidth: 0, rasterHeight: 0, arrivalCovered: false, stage: 'return', deposited: true,
  }] }];
  assert.doesNotThrow(() => observer.observe(placed));
  const incorrectlyRevived = structuredClone(placed);
  incorrectlyRevived.robots.pages[0].payloads[0].rasterWidth = 64;
  incorrectlyRevived.robots.pages[0].payloads[0].rasterHeight = 32;
  assert.throws(() => observer.observe(incorrectlyRevived), /Retired payload/);
});

test('quality actor cannot simultaneously carry a delivery payload', () => {
  const value = sample();
  value.robots.pages = [{ page: 1, payloads: [{ helpers: [8] }] }];
  assert.throws(() => new PayloadObservations().observe(value), /Quality actor/);
});

test('moving cargo requires its sharp copy until the explicit native-page handoff', () => {
  const current = { ...scene(), location: 'cargo', sharpKind: 'cargo-copy', associatedPayloadId: 9,
    sharpWidth: 128, sharpHeight: 64, sharpBytes: 128 * 64 * 4 };
  const value = sample(current, nodesFor(current).filter(item => !item.classList.contains('pdfDocumentRobotQualitySharp')));
  value.robots.deliveryPlans[0].crops[0].state = 'active';
  value.robots.pages = [{ page: 1, payloads: [{ id: 9, rasterWidth: 64, deposited: false }] }];
  assert.throws(() => new PayloadObservations().observe(value), /Quality raster/);
});

test('actual short finish and sustained idle predicates drain independent quality ownership', () => {
  const state = {
    robots: { activeActors: 0, activePayloads: 0, retainedBytes: 0, activeQualityReactions: 0, qualityReactions: [] },
    payloadArtifacts: { payloads: [], plans: [], quality: [] }, effectNodes: {}, vehicleNodes: 0,
  };
  for (const [filename, name] of [['sidecar-finish.js', 'settled'], ['sustained.js', 'quiet']]) {
    const source = loadBrowserSource(filename), start = source.indexOf('  const ' + name + ' =');
    assert.ok(start > 0);
    const predicate = source.slice(start, source.indexOf(';', start) + 1);
    const evaluate = vm.runInNewContext(predicate + '\n' + name, { moving: () => false, qualitySceneEmpty });
    assert.equal(evaluate(state), true, filename);
    for (const mutate of [
      value => { value.robots.activeQualityReactions = 1; },
      value => { value.robots.qualityReactions = [{ id: 1 }]; },
      value => { value.payloadArtifacts.quality = [{ id: 1 }]; },
    ]) {
      const pending = structuredClone(state); mutate(pending);
      assert.equal(evaluate(pending), false, filename);
    }
  }
});
