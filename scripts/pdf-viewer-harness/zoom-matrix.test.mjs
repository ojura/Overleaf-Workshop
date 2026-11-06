import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { DPRS, ZOOMS, validateSample, validateMatrix, openOwnedConnection, visibleInReader,
  validateTargetOwnership, validateTextStrip, validateDisplayConfiguration, prepareNavigatedView,
  installReducedMotionObservation, waitForReducedMotionChange,
  validateOperation, rememberPayloadIdentity, recordAdmission,
  readEntryPage, installEntryScrollObservation, validateEntryStrip, validateEntrySettlement,
  matrixOptions, matrixCases, selectHarnessTarget, validateFixtureBuilds, attachHarness, runMatrix } from './zoom-matrix.mjs';

function sample() {
  return { dpr: 2, reader: { x: 0, y: 0, right: 800, bottom: 600 }, labels: [],
    robots: { spriteScale: 0.5, activeActors: 1, maxActors: 4, cargoBytes: 0, maxCargoBytes: 1024,
      spriteBytes: 128 * 100 * 4, maxSpriteBytes: 102400, retainedBytes: 128 * 100 * 4,
      pages: [{ actors: [{ id: 1, spriteScale: 0.5, spriteDensity: 2, fromLab: false }] }] },
    vehicles: [{ id: 1, displayed: true, width: 128, height: 100, bytes: 128 * 100 * 4,
      cssWidth: 64, cssHeight: 50 }], cleaners: [], cargo: [] };
}

test('matches actual CSS body size with current backing and owner accounting', () => {
  assert.deepEqual(validateSample(sample()), [0.5]);
  const wrongSize = sample(); wrongSize.vehicles[0].cssWidth = 65;
  assert.throws(() => validateSample(wrongSize), /Displayed body width/);
  const insufficientBacking = sample(); insufficientBacking.dpr = 3;
  insufficientBacking.robots.pages[0].actors[0].spriteDensity = 3;
  assert.throws(() => validateSample(insufficientBacking), /published sprite density/);
  const uncharged = sample(); uncharged.robots.spriteBytes = uncharged.robots.retainedBytes = 0;
  assert.throws(() => validateSample(uncharged), /Connected sprite bytes/);
});

test('rejects readable labels outside the actual reader rectangle', () => {
  const value = sample(); value.labels = [{ opacity: 1, display: 'block', fontSize: 12, lineHeight: 16,
    rect: { x: 20, y: -5, right: 200, bottom: 20 } }];
  assert.throws(() => validateSample(value), /escaped the reader bounds/);
});

test('cross-density observations detect double compensation and absent zoom growth', () => {
  const values = DPRS.flatMap(dpr => ZOOMS.map(zoom => ({ engine: 'pdfjs', dpr, zoom,
    bodyScale: Math.min(1.3, 0.8 + zoom * 0.2) / Math.sqrt(dpr) })));
  validateMatrix(values);
  assert.throws(() => validateMatrix(values.map(row => ({ ...row, bodyScale: row.bodyScale / Math.sqrt(row.dpr) }))), /DPR compensation/);
  assert.throws(() => validateMatrix(values.map(row => ({ ...row, bodyScale: 1 / Math.sqrt(row.dpr) }))), /Body growth/);
});

test('serialized displayed predicate excludes the toolbar and hidden document', () => {
  const visible = vm.runInNewContext('(' + visibleInReader.toString() + ')');
  const reader = { x: 0, y: 32, right: 800, bottom: 600 }, viewport = { width: 800, height: 600 };
  const body = { x: 100, y: 0, right: 150, bottom: 31 };
  assert.equal(visible(body, reader, viewport, true), false);
  assert.equal(visible({ ...body, bottom: 33 }, reader, viewport, true), true);
  assert.equal(visible({ ...body, y: 40, bottom: 80 }, reader, viewport, false), false);
});

test('connection timeout closes a late result without adopting it', async () => {
  let resolve, closed = 0;
  const late = new Promise(done => { resolve = done; });
  await assert.rejects(openOwnedConnection('owned-fixture', () => late, 5), /connection deadline/);
  resolve({ close() { closed++; } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, 1);
  const normal = { close() { closed++; } };
  assert.equal(await openOwnedConnection('owned-fixture', async () => normal, 100), normal);
  assert.equal(closed, 1, 'A normally adopted connection remains owned by the caller');
});

test('target ownership rejects overlapping jobs but permits shared crews, touching edges and different generations', () => {
  const a = { id: 1, target: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, helpers: [11, 12] };
  const b = { id: 2, target: { x: 0.25, y: 0.2, width: 0.2, height: 0.2 } };
  assert.throws(() => validateTargetOwnership({ pages: [{ page: 1, payloads: [a, b] }] }), /separate payloads 1 and 2 overlap/);
  validateTargetOwnership({ pages: [{ page: 1, payloads: [a, { ...b, target: { ...b.target, x: 0.3 } }],
    actors: [{ id: 11, payloadId: 1, target: a.target }, { id: 12, payloadId: 1, target: a.target }] }] });
  validateTargetOwnership({ pages: [{ page: 1, payloads: [a] }, { page: 2, payloads: [b] }],
    replacement: { identity: 'old', payloads: [{ ...b, page: 1 }] } });
  assert.throws(() => validateTargetOwnership({ replacement: { identity: 'old',
    payloads: [{ ...a, page: 1 }, { ...b, page: 1 }] } }), /retiring old page 1/);
});

test('text-strip evidence must actually be above the known image, not the initial page top', () => {
  const value = { reading: { page: 1 }, reader: { x: 0, y: 32, width: 420, height: 268, bottom: 300 },
    currentPage: { rect: { x: -210, y: -210, width: 1632, height: 2112 } } };
  const strip = validateTextStrip(value); assert.ok(strip.bottom < strip.imageStartsAt);
  assert.throws(() => validateTextStrip({ ...value, currentPage: { rect: { ...value.currentPage.rect, y: 32 } } }), /paragraph/);
  assert.throws(() => validateTextStrip({ ...value, currentPage: { rect: { ...value.currentPage.rect, y: -600 } } }), /paragraph/);
});

test('accepts the saved fractional Chrome density but rejects real density or zoom changes', () => {
  const value = { dpr: 1.2000000476837158, reading: { scale: 2 }, viewport: { width: 1800, height: 1000 } },
    config = { tag: 'saved-density', dpr: 1.2, zoom: 2, width: 1800, height: 1000 };
  validateDisplayConfiguration(value, config);
  assert.throws(() => validateDisplayConfiguration({ ...value, dpr: 1.2001 }, config), /display density/);
  assert.throws(() => validateDisplayConfiguration({ ...value, reading: { scale: 2.0001 } }, config), /document scale/);
  assert.throws(() => validateDisplayConfiguration({ ...value, viewport: { width: 1440, height: 800 } }, config), /viewport width/);
  assert.throws(() => validateDisplayConfiguration({ ...value, viewport: { width: 1800, height: 800 } }, config), /viewport height/);
});

test('native view setup waits for committed navigation before zoom, activation, capture and readiness', async () => {
  let commit;
  const committed = new Promise(resolve => { commit = resolve; }), calls = [], row = { tag: 'navigation' };
  const pending = prepareNavigatedView({ previousTimeOrigin: 123, row,
    waitFor: async expression => { assert.match(expression, /timeOrigin !== 123/); calls.push('commit'); await committed; },
    zoom: { async ensure() { calls.push('zoom'); return { current: 1 }; } },
    activate: async () => { calls.push('activate'); }, capture: { async refresh() { calls.push('capture'); } },
    prepare: async () => { calls.push('prepare'); return { document: { animationCallbacks: 2 } }; } });
  await Promise.resolve(); assert.deepEqual(calls, ['commit']); commit(); await pending;
  assert.deepEqual(calls, ['commit', 'zoom', 'activate', 'capture', 'prepare']);
  assert.equal(row.nativePreparation.document.animationCallbacks, 2);
  const failure = new Error('native capture failed'); let prepared = false;
  await assert.rejects(prepareNavigatedView({ previousTimeOrigin: 123, row, waitFor: async () => {},
    capture: { async refresh() { throw failure; } }, prepare: async () => { prepared = true; } }), value => value === failure);
  assert.equal(prepared, false);
});

test('serialized media observation retains the native event and its actual cleanup state', () => {
  let listener, removed = 0, actors = 1;
  const query = { matches: false,
    addEventListener(type, value) { assert.equal(type, 'change'); listener = value; },
    removeEventListener(type, value) { assert.equal(type, 'change'); assert.equal(value, listener); removed++; } };
  const install = vm.runInNewContext('(' + installReducedMotionObservation.toString() + ')');
  const observer = install({ matchMedia() { return query; }, performance: { now: () => 125 },
    ['__labZoomSample']: () => ({ robots: { activeActors: actors } }) });
  query.matches = true;
  assert.equal(observer.read().changed, false, 'A matching getter alone is not the change-event boundary');
  listener({ matches: false }); assert.equal(observer.read().changed, false);
  actors = 0; listener({ matches: true });
  const state = observer.read();
  assert.equal(state.before.robots.activeActors, 1);
  assert.equal(state.events.length, 2);
  assert.equal(state.events[1].sample.robots.activeActors, 0);
  assert.equal(state.changed, true);
  observer.dispose(); assert.equal(removed, 1);
});

test('media gate waits for a matching native event and fails finitely without it', async () => {
  let at = 0, reads = 0;
  const state = await waitForReducedMotionChange(async () => {
    reads++; return { matches: true, changed: at >= 125 };
  }, async ms => { at += ms; }, () => at, 500);
  assert.equal(state.changed, true); assert.equal(at, 125); assert.equal(reads, 6);
  at = 0;
  await assert.rejects(waitForReducedMotionChange(async () => ({ matches: true, changed: false }),
    async ms => { at += ms; }, () => at, 75), /Native reduced-motion change/);
  assert.equal(at, 75);
});

function operationFixture(mode = 'normal') {
  const memberIds = mode === 'normal' ? [11, 12] : [11];
  const demand = mode === 'overreach' ? 2 : 1.5, each = mode === 'volunteer' ? 3 : 1;
  const support = memberIds.length * each, strain = demand / support;
  const actors = memberIds.map((id, index) => ({ id, vehicle: index ? 'quad' : 'heavyquad', payloadId: 7 }));
  const members = actors.map(actor => ({ member: actor.id, vehicle: actor.vehicle, role: 'carry', support: each,
    effectiveSupport: each, committedEffort: 0, assignedLoad: demand / memberIds.length, strain }));
  const key = '1:1:delivery:0.1:0.2:0.3:0.2';
  const operation = { key, goal: 'delivery', operatingMode: mode, workload: { mass: demand, span: 300, preferredCrew: 2 },
    demand, support, peakStrain: strain, memberIds, phases: [{ id: 'carry', until: 1, loads: [{ id: 'cargo', demand, support, members }], peakStrain: strain }],
    outcome: { family: mode === 'overreach' ? 'expensive-success' : 'clean-triumph', completion: 'fulfilled',
      aftermath: mode === 'overreach' ? 'smoke' : 'none', affectedActors: mode === 'overreach' ? [11] : [], recovery: 'self', progress: 1 },
    timing: { startedAt: 0, workEnd: 620, aftermathEnd: 760, deadline: 1000 },
    decision: { key, volunteer: 0.1, willingness: 0.1, fulfillment: 0.1, aftermath: 0.5 }, state: 'work', resolution: 'pending' };
  return { actors, payload: { id: 7, cropKind: 'fragment', target: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
    deadline: 1000, helpers: [...memberIds], rasterWidth: 100, rasterHeight: 80, arrivalCovered: true, deposited: false, operation } };
}

test('operation evidence accepts normal crews, qualified volunteers and explicit overreach outcomes', () => {
  for (const mode of ['normal', 'volunteer', 'overreach']) {
    const value = operationFixture(mode); validateOperation(value.payload, value.actors, true);
  }
  const partial = operationFixture('overreach');
  Object.assign(partial.payload.operation.outcome, { family: 'valiant-failure', completion: 'partial', aftermath: 'strained', progress: 0.2 });
  Object.assign(partial.payload.operation, { state: 'aftermath', resolution: 'partial' });
  Object.assign(partial.payload, { rasterWidth: 0, rasterHeight: 0, arrivalCovered: false });
  validateOperation(partial.payload, partial.actors, true);
  const clean = operationFixture('overreach');
  Object.assign(clean.payload.operation.outcome, { family: 'clean-triumph', aftermath: 'none', affectedActors: [] });
  validateOperation(clean.payload, clean.actors, true);
});

test('operation admission requires the complete original loaded crew while allowing later extra helpers', () => {
  const value = operationFixture();
  assert.throws(() => validateOperation(value.payload, value.actors.slice(0, 1), true), /missing an original supporting actor/);
  value.payload.helpers.push(20); value.actors.push({ id: 20, vehicle: 'hexapod', payloadId: 7 });
  validateOperation(value.payload, value.actors, true);
  const absent = operationFixture(); delete absent.payload.operation;
  assert.throws(() => validateOperation(absent.payload, absent.actors, true), /has no operation/);
  const empty = operationFixture(); empty.payload.rasterWidth = empty.payload.rasterHeight = 0;
  assert.throws(() => validateOperation(empty.payload, empty.actors, true), /lost its owned cargo raster/);
  const partial = operationFixture(); partial.payload.rasterHeight = 0;
  assert.throws(() => validateOperation(partial.payload, partial.actors, true), /lost its owned cargo raster/);
  const missing = operationFixture(); delete missing.payload.rasterWidth;
  assert.throws(() => validateOperation(missing.payload, missing.actors, true), /raster width is missing/);
});

test('operation phase evidence rejects lost support, assigned-load drift and uncommitted members', () => {
  const support = operationFixture(); support.payload.operation.phases[0].loads[0].support += 0.1;
  assert.throws(() => validateOperation(support.payload, support.actors), /support accounting/);
  const assignment = operationFixture(); assignment.payload.operation.phases[0].loads[0].members[0].assignedLoad += 0.1;
  assert.throws(() => validateOperation(assignment.payload, assignment.actors), /Assigned load/);
  const member = operationFixture(); member.payload.operation.phases[0].loads[0].members[0].member = 99;
  assert.throws(() => validateOperation(member.payload, member.actors), /uncommitted supporter/);
});

test('operation refinement freezes decisions and timing while state and resolution may advance', () => {
  const value = operationFixture(), history = new Map();
  rememberPayloadIdentity(history, 1, value.payload);
  Object.assign(value.payload.operation, { state: 'aftermath', resolution: 'fulfilled' });
  rememberPayloadIdentity(history, 1, value.payload);
  for (const change of [
    op => { op.workload.mass += 1; },
    op => { op.decision.willingness = 0.2; },
    op => { op.timing.workEnd += 1; },
    op => { op.phases[0].loads[0].members[0].support += 1; },
  ]) {
    const next = structuredClone(value.payload); change(next.operation);
    assert.throws(() => rememberPayloadIdentity(history, 1, next), /admitted operation changed/);
  }
});

test('operation resolution releases cargo and cover before finite aftermath, with correct deposit credit', () => {
  const value = operationFixture();
  Object.assign(value.payload.operation, { state: 'aftermath', resolution: 'fulfilled' });
  Object.assign(value.payload, { rasterWidth: 0, rasterHeight: 0, arrivalCovered: false, deposited: true });
  validateOperation(value.payload, value.actors);
  assert.throws(() => validateOperation({ ...value.payload, rasterWidth: 1 }, value.actors), /retained a cargo raster/);
  assert.throws(() => validateOperation({ ...value.payload, arrivalCovered: true }, value.actors), /retained an arrival cover/);
  const premature = operationFixture(); premature.payload.operation.state = 'aftermath';
  assert.throws(() => validateOperation(premature.payload, premature.actors), /before work resolved/);
  const timing = operationFixture(); timing.payload.operation.timing.aftermathEnd = 600;
  assert.throws(() => validateOperation(timing.payload, timing.actors), /Invalid operation timing/);
  const mismatch = structuredClone(value); mismatch.payload.operation.resolution = 'partial';
  assert.throws(() => validateOperation(mismatch.payload, mismatch.actors), /committed outcome/);
  const partial = structuredClone(mismatch); partial.payload.operation.outcome.completion = 'partial';
  assert.throws(() => validateOperation(partial.payload, partial.actors), /Deposit credit/);
  partial.payload.operation.goal = 'removal';
  validateOperation(partial.payload, partial.actors);
});

test('operation admission diagnostics stay fixed through refinement and idle while new admissions may add work', () => {
  const row = {}, robots = { operationAdmissions: 1, operationCandidates: 12, operationCommitChecks: 2, operationNarrativeRecords: 1,
    operationAdmissionTotalMs: 1.5, operationAdmissionMaxMs: 1.5, operationDecisionRecords: 1, refinements: 0, paintTotalMs: 4 };
  recordAdmission(row, { at: 1, robots }, true);
  recordAdmission(row, { at: 2, robots: { ...robots, refinements: 1, paintTotalMs: 5 } }, true);
  assert.equal(row.admission.stableIntervals, 1); assert.equal(row.admission.refinementIntervals, 1);
  assert.throws(() => recordAdmission(row, { at: 3, robots: { ...robots, operationCandidates: 13 } }, true), /Work repeated/);
  assert.throws(() => recordAdmission(row, { at: 3, robots: { ...robots, operationAdmissionTotalMs: 1.6 } }, true), /Work repeated/);
  assert.throws(() => recordAdmission(row, { at: 3, robots: { ...robots, operationNarrativeRecords: 2 } }, true), /Work repeated/);
  recordAdmission(row, { at: 4, robots: { ...robots, operationAdmissions: 2, operationCandidates: 20,
    operationCommitChecks: 4, operationNarrativeRecords: 2, operationAdmissionTotalMs: 3.5,
    operationAdmissionMaxMs: 2, operationDecisionRecords: 2, refinements: 1 } }, true);
  assert.equal(row.admission.samples.length, 3);
});

function entryFixture() {
  const reader = { x: 0, y: 32, width: 1200, height: 688, bottom: 720 };
  const target = { page: 3, clip: { x: 192, y: 541, width: 816, height: 1056 },
    native: { state: 3, connected: true, width: 816, height: 1056, displayedWidth: 816,
      displayedHeight: 1056, display: 'block', visibility: 'visible' } };
  const state = { at: 132, reader, direction: 1, reading: { top: 280, left: 0, scale: 1 }, robots: { episodes: 5, pages: [] } };
  const before = { sample: { ...state, at: 100, direction: 0, reading: { ...state.reading, top: 100 } },
    target: { ...target, clip: { ...target.clip, y: 721 } } };
  const early = { sample: structuredClone(state), target, eventAt: 116, trusted: true,
    wheel: { at: 112, trusted: true, deltaY: 180 } };
  const committed = { sample: { ...state, at: 400, direction: 0,
    robots: { episodes: 6, pages: [{ page: 3, payloads: [{ id: 7 }] }] } }, target: structuredClone(target) };
  return { before, early, committed };
}

test('entry evidence distinguishes moving ready strips from their unchanged settled admission', () => {
  const { before, early, committed } = entryFixture();
  validateEntryStrip(before, early); validateEntrySettlement(before, early, committed);
  const premature = structuredClone(early); premature.sample.robots.pages.push({ page: 3, payloads: [{ id: 7 }] });
  assert.throws(() => validateEntryStrip(before, premature), /admitted its page early/);
  const late = structuredClone(early); late.sample.at = late.eventAt + 250;
  assert.throws(() => validateEntryStrip(before, late), /settle interval/);
  const empty = structuredClone(early); empty.target.native.width = 0;
  assert.throws(() => validateEntryStrip(before, empty), /ready native pixels/);
  const moved = structuredClone(committed); moved.sample.reading.top++;
  assert.throws(() => validateEntrySettlement(before, early, moved), /changed scroll position/);
  const duplicate = structuredClone(committed); duplicate.sample.robots.episodes++;
  assert.throws(() => validateEntrySettlement(before, early, duplicate), /more than one episode/);
});

test('serialized entry reader measures the inner page clip and the actual ready native backing', () => {
  const read = vm.runInNewContext('(' + readEntryPage.toString() + ')');
  const page = { div: { clientLeft: 2, clientTop: 3, clientWidth: 816, clientHeight: 1056,
    getBoundingClientRect: () => ({ left: 190, top: 538 }) }, renderingState: 3,
    canvas: { isConnected: true, width: 816, height: 1056, getBoundingClientRect: () => ({ width: 816, height: 1056 }) } };
  const result = read({ ['PDFViewerApplication']: { pdfViewer: { getPageView(index) { assert.equal(index, 2); return page; } } },
    ['__labZoomSample']: () => ({ at: 132 }), getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(result.target.clip)), { x: 192, y: 541, width: 816, height: 1056 });
  assert.equal(result.target.native.state, 3); assert.equal(result.target.native.connected, true);
});

test('serialized entry scroll observer captures two rendering turns and removes its own listeners', () => {
  const install = vm.runInNewContext('(' + installEntryScrollObservation.toString() + ')');
  const listeners = new Map(), frames = new Map(), timers = new Map(); let at = 100, serial = 0;
  const container = { addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { assert.equal(listeners.get(type), listener); listeners.delete(type); } };
  const win = { ['PDFViewerApplication']: { pdfViewer: { container } }, performance: { now: () => at },
    setTimeout(fn) { timers.set(++serial, fn); return serial; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { frames.set(++serial, fn); return serial; }, cancelAnimationFrame(id) { frames.delete(id); } };
  const observer = install(win, 3, () => ({ sample: { at }, target: { page: 3 } }));
  listeners.get('wheel')({ isTrusted: true, deltaY: 180 }); listeners.get('scroll')({ isTrusted: true });
  const paint = () => { at += 16; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) {callback();} };
  paint(); assert.equal(observer.read().observation, undefined);
  paint(); const result = observer.read().observation;
  assert.equal(result.sample.at - result.eventAt, 32); assert.equal(result.wheel.trusted, true);
  assert.equal(timers.size, 0); observer.dispose(); assert.equal(listeners.size, 0); assert.equal(frames.size, 0);
});


test('adaptive sprite backing preserves local detail at its published density', () => {
  const value = sample(); value.dpr = 3;
  assert.deepEqual(validateSample(value), [0.5]);
  const belowFloor = structuredClone(value);
  belowFloor.robots.pages[0].actors[0].spriteDensity = 1;
  Object.assign(belowFloor.vehicles[0], { width: 64, height: 50, bytes: 12800 });
  belowFloor.robots.spriteBytes = belowFloor.robots.retainedBytes = 12800;
  assert.throws(() => validateSample(belowFloor), /local artwork detail/);
});

test('matrix scale observations stay comparable when the visible vehicle is enlarged', () => {
  const value = sample();
  Object.assign(value.robots.pages[0].actors[0], { vehicle: 'heavyquad', spriteScale: 1.25, spriteDensity: 2 });
  Object.assign(value.vehicles[0], { cssWidth: 160, cssHeight: 125, width: 320, height: 250, bytes: 320000 });
  Object.assign(value.robots, { spriteBytes: 320000, retainedBytes: 320000, maxSpriteBytes: 1024000 });
  assert.deepEqual(validateSample(value), [0.5], 'Compare the shared document scale while checking each actual body');
});

test('a naturally small requested sprite keeps its rounded full detail without being forced to 128 by 100', () => {
  const value = sample(); value.robots.spriteScale = 0.2;
  Object.assign(value.robots.pages[0].actors[0], { spriteScale: 0.2, spriteDensity: 2 });
  Object.assign(value.vehicles[0], { width: 52, height: 40, bytes: 8320, cssWidth: 25.6, cssHeight: 20 });
  value.robots.spriteBytes = value.robots.retainedBytes = 8320;
  assert.deepEqual(validateSample(value), [0.2]);
  value.vehicles[0].width = 51; value.vehicles[0].bytes = 8160;
  value.robots.spriteBytes = value.robots.retainedBytes = 8160;
  assert.throws(() => validateSample(value), /local artwork detail/);
});

test('portable options use the shared strict parser and preserve every selected scenario', () => {
  const parse = args => matrixOptions(args);
  assert.equal(matrixCases(parse([])).length, 50);
  assert.equal(matrixCases(parse(['--engine=pdfjs'])).length, 25);
  for (const selector of ['--compact-only', '--representative-only', '--small-only']) {
    const cases = matrixCases(parse([selector]));
    assert.equal(cases.length, 2); assert.deepEqual(cases.map(row => row.engine), ['pdfjs', 'overleaf']);
  }
  const entry = matrixCases(parse(['--scenario', 'entry-strip', '--engine', 'overleaf']));
  assert.deepEqual(entry, [{ engine: 'overleaf', dpr: 1, zoom: 1, width: 1200, height: 720, compact: false, entry: true }]);
  assert.equal(matrixCases(parse(['--scenario=text-strip']))[0].strip, true);
  for (const scenario of ['controls', 'content', 'dom']) {
    const cases = matrixCases(parse(['--scenario', scenario]));
    assert.equal(cases.length, 2); assert.ok(cases.every(row => row.scenario === scenario));
  }
  assert.equal(parse(['--daemon-url', 'http://127.0.0.1:7799/']).daemonUrl, 'http://127.0.0.1:7799');
  assert.throws(() => parse(['--daemon-url', 'http://remote.test:7799']), /local HTTP/);
  assert.throws(() => parse(['--daemon-url', 'http://127.0.0.1:7799', '--profile', '/missing']), /Choose one/);
  assert.throws(() => parse(['--compact-only', '--small-only']), /one cell selector/);
  assert.throws(() => parse(['--scenario', 'entry-strip', '--representative-only']), /one cell selector/);
  assert.throws(() => parse(['--engine', 'pdfjs', '--engine', 'overleaf']), /given twice/);
  assert.throws(() => parse(['--engne', 'pdfjs']), /unknown option/);
  assert.throws(() => parse(['--execute']), /--id/);
  assert.throws(() => parse(['--execute', '--id', '../collision']), /--id/);
  assert.throws(() => parse(['--origin', 'https://example.test']), /local HTTP/);
  assert.throws(() => parse(['--browser-url', 'ws://remote.test/devtools/browser/a']), /local browser/);
  assert.throws(() => parse(['--profile', '/missing', '--browser-url', 'ws://127.0.0.1:1/devtools/browser/a']), /Choose one/);
});

test('plan and help invocations remain inert with nonexistent runtime inputs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-plan-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'uncreated'), entry = fileURLToPath(new URL('./zoom-matrix.mjs', import.meta.url));
  const args = [entry, '--work', work, '--ext', path.join(root, 'missing-build'), '--profile', path.join(root, 'missing-profile'),
    '--origin', 'http://127.0.0.1:1', '--target', 'existing-page', '--small-only'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'planned');
  assert.equal(JSON.parse(result.stdout).cases.length, 2);
  assert.equal(fs.existsSync(work), false, 'Planning must not create a runtime folder');
  const help = spawnSync(process.execPath, [...args, '--help', '--execute'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /existing page/);
  assert.equal(fs.existsSync(work), false);
});

test('exact target selection rejects lookalike pages and never adopts another existing tab', () => {
  const options = { origin: 'http://127.0.0.1:8765', target: 'owned' };
  const page = { targetId: 'owned', type: 'page', url: options.origin + '/page?engine=pdfjs&doc=fixture' };
  assert.equal(selectHarnessTarget([page, { ...page, targetId: 'other' }], options), page);
  assert.throws(() => selectHarnessTarget([{ ...page, targetId: 'other' }], options), /exact existing page/);
  assert.throws(() => selectHarnessTarget([{ ...page, url: options.origin + '/page-other' }], options), /configured harness/);
  assert.throws(() => selectHarnessTarget([{ ...page, url: 'http://127.0.0.1:8766/page' }], options), /configured harness/);
});

function fixtureBuilds() {
  const ranges = [0, 1, 2].map(index => ({ objectId: String(index), start: index * 10, end: index * 10 + 9, hash: 'fixture-' + index }));
  return { a: { size: 40, startXRefTable: 30, ranges }, b: { size: 41, startXRefTable: 31, ranges } };
}

function servedBuilds(builds, origin) {
  return Object.fromEntries(Object.entries(builds).map(([name, file]) => [name, { file: structuredClone(file), url: origin + '/output/' + name }]));
}

test('fixture comparison rejects stale range metadata and a live-PDF server', () => {
  const local = fixtureBuilds(), origin = 'http://127.0.0.1:8765', remote = servedBuilds(local, origin);
  validateFixtureBuilds(local, remote, origin);
  remote.a.file.ranges[0].hash = 'another-image';
  assert.throws(() => validateFixtureBuilds(local, remote, origin), /Served fixture differs/);
  remote.a = servedBuilds(local, origin).a; remote.a.url = 'https://book.example/output.pdf';
  assert.throws(() => validateFixtureBuilds(local, remote, origin), /live document/);
});

test('attachment setup and detach failures close the single adopted connection', async () => {
  const options = { browserUrl: 'ws://127.0.0.1:1/devtools/browser/fixture', origin: 'http://127.0.0.1:8765', target: 'owned' };
  let opens = 0, closes = 0, attaches = 0, detaches = 0;
  const browser = { async send() { return { targetInfos: [] }; },
    async attach() { attaches++; return { async detach() { detaches++; throw new Error('detach failed'); } }; }, close() { closes++; } };
  const open = async () => { opens++; return browser; };
  await assert.rejects(attachHarness(options, open), /exact existing page/);
  assert.deepEqual([opens, closes, attaches], [1, 1, 0]);
  browser.send = async () => ({ targetInfos: [{ targetId: 'owned', type: 'page', url: options.origin + '/page' }] });
  const owner = await attachHarness(options, open);
  await assert.rejects(owner.close(), /detach failed/);
  assert.deepEqual([opens, closes, attaches, detaches], [2, 2, 1, 1]);
});

test('an initialization failure records the error and cleans its page before detaching', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-cleanup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ext = path.join(root, 'viewer'), book = path.join(root, 'book'), work = path.join(root, 'results');
  fs.mkdirSync(path.join(ext, 'dist'), { recursive: true }); fs.mkdirSync(book);
  fs.writeFileSync(path.join(ext, 'dist', 'pdfjs.mjs'), '// fixture entry');
  const builds = fixtureBuilds(); fs.writeFileSync(path.join(book, 'builds.json'), JSON.stringify(builds));
  const origin = 'http://127.0.0.1:8765', calls = [];
  const session = { on() {}, async send(method, params) {
    calls.push([method, params]);
    if (method === 'Runtime.enable') {throw new Error('initialization rejected');}
    return { result: { value: { href: origin + '/page', width: 1200, height: 720, dpr: 1 } } };
  }, async detach() { calls.push(['detach']); } };
  const browser = { async send() { return { targetInfos: [{ targetId: 'owned', type: 'page', url: origin + '/page' }] }; },
    async attach() { calls.push(['attach']); return session; }, close() { calls.push(['close']); } };
  const options = matrixOptions(['--execute', '--id', 'failure', '--work', work, '--ext', ext, '--book', book,
    '--origin', origin, '--target', 'owned', '--browser-url', 'ws://127.0.0.1:1/devtools/browser/fixture', '--engine', 'pdfjs', '--small-only']);
  const report = await runMatrix(options, { open: async () => browser,
    request: async () => ({ status: 200, json: async () => servedBuilds(builds, origin) }), log() {} });
  assert.equal(report.status, 'failed'); assert.match(report.errors[0], /initialization rejected/);
  assert.deepEqual(report.cleanupErrors, []);
  assert.equal(calls.filter(([method]) => method === 'attach').length, 1);
  assert.ok(calls.some(([method, params]) => method === 'Runtime.evaluate' && params.expression.includes('setRobotsEnabled(false)')));
  assert.ok(calls.some(([method]) => method === 'Emulation.clearDeviceMetricsOverride'));
  assert.deepEqual(calls.slice(-2).map(([method]) => method), ['detach', 'close']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'failure.json'), 'utf8')).status, 'failed');
  assert.equal(fs.existsSync(path.join(work, 'failure.json.writing')), false);
});
