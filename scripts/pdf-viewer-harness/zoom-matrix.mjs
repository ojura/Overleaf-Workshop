// Check document robots in an existing page of server.mjs; importing this module is inert.
// node scripts/pdf-viewer-harness/zoom-matrix.mjs --execute --id <receipt>
//   --work <results-dir> --ext <views/pdf-viewer> --book <make_book.py output>
//   --origin http://127.0.0.1:<port> --target <existing-page-id>
//   (--daemon-url http://127.0.0.1:7799 | --profile <isolated-Chrome-profile> | --browser-url <isolated-browser-WebSocket>)
//   [--engine pdfjs|overleaf] [--scenario matrix|text-strip|entry-strip|controls|content|dom] [--operations]
//   [--compact-only | --representative-only | --small-only] [--timeout-ms 240000]
//   [--profile-cpu] [--zoom-helper-target <state-reader-bridge-target>]
// Without --execute, print the selected cases without reading runtime files or connecting.
// The caller owns the already running browser/server. The exact harness page is reused and
// left on its final fixture, with robots off, emulation cleared and the CDP session detached.
// text-strip and entry-strip use the portrait layout written by make_book.py, not a user PDF.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activePortUrl, answerWithin, connect, waitUntil } from '../lib/devtools.mjs';
import { parseOptions, UsageError, usageOf } from '../lib/options.mjs';
import { collectPayloadArtifacts, PayloadObservations } from './safari/payload-observation.mjs';
import { connectDaemon, evaluateHarness } from './scenario-connection.mjs';
import { normalizeTabZoom } from './per-tab-zoom.mjs';
import { keepRendering } from './render-capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ZOOMS = Object.freeze([0.5, 1, 1.5, 2, 3, 4]);
export const DPRS = Object.freeze([1, 1.2, 2, 3]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const RPC_LIMIT_MS = 10000;
const CLEANUP_MS = Object.freeze({ scenario: 30000, page: 10000, detach: 20000 });
const SCENARIO_MODULES = Object.freeze({ controls: './controls-scenes.mjs', content: './content-scenes.mjs', dom: './dom-checks.mjs' });

export function matrixOptions(argv) {
  const value = parseOptions({ execute: 'flag', help: 'flag', id: 'value', work: 'value', ext: 'value', book: 'value',
    origin: 'value', target: 'value', profile: 'value', ['browser-url']: 'value', ['daemon-url']: 'value',
    scenario: ['matrix', 'text-strip', 'entry-strip', ...Object.keys(SCENARIO_MODULES)], engine: ['pdfjs', 'overleaf'],
    ['compact-only']: 'flag', ['representative-only']: 'flag', ['small-only']: 'flag', operations: 'flag',
    ['timeout-ms']: 'number', ['profile-cpu']: 'flag', ['zoom-helper-target']: 'value' }, argv);
  const options = { execute: !!value.execute, help: !!value.help, id: value.id,
    work: path.resolve(value.work ?? process.env.PDF_VIEWER_HARNESS_WORK ?? path.join(os.tmpdir(), 'pdf-viewer-harness')),
    ext: path.resolve(value.ext ?? path.join(here, '../../views/pdf-viewer')), book: value.book && path.resolve(value.book),
    origin: value.origin, target: value.target, profile: value.profile && path.resolve(value.profile), browserUrl: value['browser-url'], daemonUrl: value['daemon-url'],
    scenario: value.scenario ?? 'matrix', engine: value.engine, compactOnly: !!value['compact-only'],
    representativeOnly: !!value['representative-only'], smallOnly: !!value['small-only'], requireOperations: !!value.operations,
    timeoutMs: value['timeout-ms'] ?? 240000, profileCpu: !!value['profile-cpu'], zoomHelperTarget: value['zoom-helper-target'] };
  const require = (ok, message) => { if (!ok) {throw new UsageError(message);} };
  const selectors = Number(options.compactOnly) + Number(options.representativeOnly) + Number(options.smallOnly);
  require(selectors <= 1 && (!selectors || options.scenario === 'matrix'), 'Choose one cell selector with --scenario matrix');
  require(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1000, '--timeout-ms must be an integer of at least 1000');
  if (options.origin) {
    let url;
    try { url = new URL(options.origin); } catch { throw new UsageError('--origin must name the local harness server'); }
    require(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    '--origin must name a local HTTP harness origin');
    options.origin = url.origin;
  }
  if (options.browserUrl) {
    let url;
    try { url = new URL(options.browserUrl); } catch { throw new UsageError('--browser-url must name an existing local browser endpoint'); }
    require(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && /^\/devtools\/browser\/[^/]+$/.test(url.pathname) && !url.search && !url.hash,
    '--browser-url must name an existing local browser endpoint');
  }
  if (options.daemonUrl) {
    let url;
    try { url = new URL(options.daemonUrl); } catch { throw new UsageError('--daemon-url must name the local CDP daemon'); }
    require(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    '--daemon-url must name a local HTTP origin');
    options.daemonUrl = url.origin;
  }
  require(Number(!!options.profile) + Number(!!options.browserUrl) + Number(!!options.daemonUrl) <= 1,
    'Choose one of --daemon-url, --profile or --browser-url');
  if (options.execute && !options.help) {
    require(/^[a-z0-9][a-z0-9-]{0,95}$/.test(options.id ?? ''), '--id needs a unique receipt name (lowercase letters, numbers and hyphens)');
    require(options.origin && options.target && options.book && (options.profile || options.browserUrl || options.daemonUrl),
      '--execute needs --origin, --target, --book and one of --daemon-url, --profile or --browser-url');
  }
  return options;
}

export function matrixCases(options) {
  const { scenario, engine, compactOnly, representativeOnly, smallOnly } = options;
  return (SCENARIO_MODULES[scenario]
    ? ['pdfjs', 'overleaf'].map(engine => ({ engine, dpr: 1, zoom: 1, width: 1800, height: 1000, compact: false, scenario }))
    : scenario === 'entry-strip'
    ? ['pdfjs', 'overleaf'].map(engine => ({ engine, dpr: 1, zoom: 1, width: 1200, height: 720, compact: false, entry: true }))
    : scenario === 'text-strip'
    ? ['pdfjs', 'overleaf'].map(engine => ({ engine, dpr: 1, zoom: 2, width: 420, height: 300, compact: true, strip: true }))
    : ['pdfjs', 'overleaf'].flatMap(engine => [
      ...DPRS.flatMap(dpr => ZOOMS.map(zoom => ({ engine, dpr, zoom, width: 1800, height: 1000, compact: false }))),
      { engine, dpr: 3, zoom: 2, width: 390, height: 844, compact: true },
    ])).filter(config => (!engine || config.engine === engine) && (!compactOnly || config.compact)
      && (!representativeOnly || !config.compact && config.zoom === 4 && config.dpr === 3)
      && (!smallOnly || !config.compact && config.zoom === 0.5 && config.dpr === 1));
}

export function selectHarnessTarget(targets, { target, origin }) {
  const matches = targets.filter(value => value.targetId === target && value.type === 'page');
  assert.equal(matches.length, 1, 'The exact existing page target is required');
  const url = new URL(matches[0].url);
  assert.ok(url.origin === origin && url.pathname === '/page', 'The selected target is not a page of the configured harness');
  return matches[0];
}

export function validateFixtureBuilds(expected, actual, origin) {
  for (const name of ['a', 'b']) {
    const build = expected[name], remote = actual[name];
    assert.ok(build?.size > 0 && Array.isArray(build.ranges) && build.ranges.length >= 3, 'Use a make_book.py fixture with at least three pages');
    assert.equal(new URL(remote?.url).origin, origin, 'The harness is serving a live document instead of its local fixture');
    for (const key of ['size', 'startXRefTable', 'ranges']) {assert.deepEqual(remote?.file?.[key], build[key], 'Served fixture differs: ' + name + '/' + key);}
  }
}

export function executedEntry(scripts, origin, engine) {
  const matches = scripts.filter(item => {
    if (!item.url?.startsWith(origin + '/ext/')) {return false;}
    const url = new URL(item.url);
    return url.origin === origin && url.pathname === '/ext/dist/' + engine + '.mjs';
  });
  assert.equal(matches.length, 1, 'One executed engine entry must be observed');
  return matches[0];
}

export function deferredCleanup() {
  const entries = [];
  return {
    defer(label, cleanup) {
      let active = true;
      const once = async () => { if (active) { active = false; await cleanup(); } };
      entries.push({ label, once });
      return once;
    },
    async run() {
      const errors = [];
      for (const { label, once } of entries.splice(0).reverse()) {
        try { await once(); } catch (error) { errors.push(label + ': ' + error); }
      }
      return errors;
    },
  };
}

/** The caller owns one connection until close(), including when setup or its callback fails. */
export async function attachHarness(options, open = connect, request = fetch) {
  const browser = await openOwnedConnection(options.daemonUrl ?? options.browserUrl,
    options.daemonUrl ? url => connectDaemon(url, { request }) : open);
  let session, zoom, capture;
  try {
    const { targetInfos } = await answerWithin(browser, 'Target.getTargets', RPC_LIMIT_MS, () => browser.send('Target.getTargets'));
    const target = selectHarnessTarget(targetInfos, options);
    session = await answerWithin(browser, 'Target.attachToTarget', options.daemonUrl ? 19000 : RPC_LIMIT_MS, () => browser.attach(target.targetId));
    if (session.prepare) { await answerWithin(browser, 'Prepare page', RPC_LIMIT_MS, () => session.prepare()); }
    if (session.prepare) { capture = await keepRendering(session); }
    if (options.zoomHelperTarget) { zoom = await normalizeTabZoom(browser, options.zoomHelperTarget, target.targetId); }
    return { browser, session, target, zoom, capture, async close() {
      const errors = [];
      try {
        try { if (capture) { await capture.close(); } } catch (error) { errors.push(error); }
        try { if (zoom) { zoom.restoration = await zoom.close(); } } catch (error) { errors.push(error); }
        try { await answerWithin(browser, 'Target.detachFromTarget', CLEANUP_MS.detach, () => session.detach()); } catch (error) { errors.push(error); }
        if (errors.length) { throw new AggregateError(errors, errors.map(String).join('\n')); }
      }
      finally { browser.close(); }
    } };
  } catch (error) {
    if (session) {
      try { await capture?.close(); } catch (cleanup) { error = new AggregateError([error, cleanup], 'Setup and rendering cleanup failed'); }
      try { await session.detach(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], String(error) + '\n' + String(cleanup)); }
      finally { browser.close(); }
    } else { browser.close(); }
    throw error;
  }
}

export async function openOwnedConnection(url, open = connect, limitMs = 10000) {
  let abandoned = false, timer;
  const pending = Promise.resolve().then(() => open(url)).then(connection => {
    if (abandoned) {connection.close();}
    return connection;
  });
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('CDP connection deadline')), limitMs);
    })]);
  } catch (error) { abandoned = true; throw error; }
  finally { clearTimeout(timer); }
}

export function visibleInReader(box, reader, viewport, documentVisible) {
  return documentVisible
    && Math.min(box.right, reader.right, viewport.width) > Math.max(box.x, reader.x, 0)
    && Math.min(box.bottom, reader.bottom, viewport.height) > Math.max(box.y, reader.y, 0);
}

export function validateTargetOwnership(robots) {
  const check = (payloads, scope) => {
    const owners = new Map();
    for (const payload of payloads ?? []) {
      const box = payload.target;
      assert.ok(Number.isSafeInteger(payload.id) && payload.id > 0 && box
        && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]))
        && box.width > 0 && box.height > 0, scope + ': invalid target ownership');
      const existing = owners.get(payload.id);
      if (existing) { assert.deepEqual(box, existing, scope + ': one payload has conflicting targets'); continue; }
      for (const [id, other] of owners) {
        const width = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
        const height = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
        assert.ok(width <= 1e-12 || height <= 1e-12,
          scope + ': separate payloads ' + id + ' and ' + payload.id + ' overlap in normalized target space');
      }
      owners.set(payload.id, box);
    }
  };
  for (const page of robots.pages ?? []) {check(page.payloads, 'current page ' + page.page);}
  const retiring = robots.replacement;
  if (retiring) {
    const pages = new Map();
    for (const payload of retiring.payloads) {
      const group = pages.get(payload.page) ?? []; group.push(payload); pages.set(payload.page, group);
    }
    for (const [page, payloads] of pages) {check(payloads, 'retiring ' + retiring.identity + ' page ' + page);}
  }
}

export function validateTextStrip(sample) {
  const page = sample.currentPage.rect, reader = sample.reader;
  const top = Math.max(0, (reader.y - page.y) / page.height);
  const bottom = Math.min(1, (reader.bottom - page.y) / page.height);
  assert.equal(sample.reading.page, 1, 'The strip must use the known portrait fixture page');
  assert.ok(page.width > reader.width * 2 && page.height > reader.height * 3, 'The fixture is not a narrow visible strip');
  assert.ok(top > 80 / 792 && bottom < 264 / 792,
    'The visible strip must stay in the paragraph above the fixture image');
  return { top, bottom, imageStartsAt: 274 / 792 };
}

export function validateDisplayConfiguration(sample, config) {
  // Chrome reports a float-rounded screen factor for values such as 1.2.
  assert.ok(Math.abs(sample.dpr - config.dpr) < 1e-6, config.tag + ': display density changed');
  assert.ok(Math.abs(sample.reading.scale - config.zoom) < 1e-8, config.tag + ': document scale changed');
  assert.equal(sample.viewport.width, config.width, config.tag + ': viewport width changed');
  assert.equal(sample.viewport.height, config.height, config.tag + ': viewport height changed');
}

export async function prepareNavigatedView({ previousTimeOrigin, row, waitFor, zoom, capture, activate, prepare }) {
  await waitFor(`performance.timeOrigin !== ${previousTimeOrigin}
    && (document.readyState === 'interactive' || document.readyState === 'complete')`,
  { limitMs: 15000, what: row.tag + ': navigated document commitment' });
  if (zoom) { row.zoomNormalization = await zoom.ensure(); }
  // The target survives navigation, but its renderer view is replaced. Keep the existing
  // daemon focus registration while activating and capturing the newly committed view.
  await activate?.();
  await capture?.refresh();
  if (prepare) { row.nativePreparation = await prepare(); }
}

export function readEntryPage(win, page) {
  const viewer = win.PDFViewerApplication?.pdfViewer ?? win.overleafViewer?.wrapper.viewer;
  const view = viewer.getPageView(page - 1), box = view.div.getBoundingClientRect(), canvas = view.canvas;
  const nativeBox = canvas?.getBoundingClientRect(), css = canvas && win.getComputedStyle(canvas);
  return { sample: win.__labZoomSample(), target: { page,
    clip: { x: box.left + view.div.clientLeft, y: box.top + view.div.clientTop,
      width: view.div.clientWidth, height: view.div.clientHeight },
    native: { state: view.renderingState, connected: !!canvas?.isConnected,
      width: canvas?.width ?? 0, height: canvas?.height ?? 0,
      displayedWidth: nativeBox?.width ?? 0, displayedHeight: nativeBox?.height ?? 0,
      display: css?.display, visibility: css?.visibility } } };
}

export function installEntryScrollObservation(win, page, read) {
  const viewer = win.PDFViewerApplication?.pdfViewer ?? win.overleafViewer?.wrapper.viewer;
  let eventAt, wheel, frame, observation, error;
  const timer = win.setTimeout(() => { error = 'Native entry scroll observation deadline'; }, 1500);
  const onWheel = event => { wheel ??= { at: win.performance.now(), trusted: event.isTrusted, deltaY: event.deltaY }; };
  const onScroll = event => {
    if (eventAt !== undefined) {return;}
    eventAt = win.performance.now();
    const trusted = event.isTrusted;
    frame = win.requestAnimationFrame(() => { frame = win.requestAnimationFrame(() => {
      observation = { ...read(win, page), eventAt, trusted, wheel };
      win.clearTimeout(timer); frame = undefined;
    }); });
  };
  viewer.container.addEventListener('wheel', onWheel, { capture: true, passive: true });
  viewer.container.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return { read() { return { observation, error, eventAt }; }, dispose() {
    viewer.container.removeEventListener('wheel', onWheel, true);
    viewer.container.removeEventListener('scroll', onScroll, true);
    win.clearTimeout(timer); if (frame !== undefined) {win.cancelAnimationFrame(frame);}
  } };
}

export function validateEntryStrip(before, early) {
  const { sample, target } = early, { clip, native } = target, reader = sample.reader;
  assert.equal(target.page, before.target.page);
  assert.ok(early.trusted && early.wheel?.trusted && early.wheel.deltaY > 0, 'Entry did not follow the native forward wheel');
  assert.ok(sample.at - early.eventAt >= 0 && sample.at - early.eventAt < 250,
    'Entry observation crossed the existing settle interval');
  assert.ok(sample.direction > 0 && sample.reading.top > before.sample.reading.top, 'Entry did not capture active scroll motion');
  assert.ok(clip.y > (reader.y + reader.bottom) / 2 && reader.bottom - clip.y >= 120
    && clip.y + clip.height > reader.bottom, 'Entry is not a usable strip outside the viewport midpoint');
  assert.ok(native.state === 3 && native.connected && native.width > 0 && native.height > 0
    && native.displayedWidth > 0 && native.displayedHeight > 0
    && native.display !== 'none' && native.visibility !== 'hidden', 'Entering page lacks its ready native pixels');
  assert.ok(!sample.robots.pages.some(value => value.page === target.page), 'An entering strip admitted its page early');
  assert.equal(sample.robots.episodes, before.sample.robots.episodes, 'An entering strip committed an early episode');
}

export function validateEntrySettlement(before, early, committed) {
  const { sample, target } = committed;
  assert.equal(target.page, early.target.page);
  assert.equal(sample.direction, 0, 'Entry committed before the scroll settled');
  assert.equal(sample.reading.top, early.sample.reading.top, 'The settled entry changed scroll position');
  assert.equal(sample.reading.left, early.sample.reading.left, 'The settled entry changed horizontal position');
  assert.equal(sample.reading.scale, early.sample.reading.scale, 'The settled entry changed scale');
  assert.deepEqual(target.clip, early.target.clip, 'The settled entry changed page geometry');
  const pages = sample.robots.pages.filter(value => value.page === target.page);
  assert.equal(pages.length, 1, 'Settling did not create exactly one target episode');
  assert.ok(pages[0].payloads.length, 'The committed target episode has no payload');
  assert.equal(sample.robots.episodes, before.sample.robots.episodes + 1, 'Settling committed more than one episode');
}

export function installReducedMotionObservation(win) {
  const query = win.matchMedia('(prefers-reduced-motion: reduce)');
  const before = win.__labZoomSample(), events = [];
  let changed = false;
  const change = event => {
    changed ||= event.matches;
    events.push({ at: win.performance.now(), matches: event.matches, sample: win.__labZoomSample() });
  };
  query.addEventListener('change', change);
  return {
    read() { return { before, events: [...events], matches: query.matches, changed }; },
    dispose() { query.removeEventListener('change', change); },
  };
}

export async function waitForReducedMotionChange(read, delay = pause, clock = Date.now, limitMs = 1500) {
  const until = clock() + limitMs;
  for (;;) {
    const state = await read();
    if (state.changed && state.matches) {return state;}
    assert.ok(clock() < until, 'Native reduced-motion change was not observed');
    await delay(25);
  }
}

export function validateOperation(payload, actors = [], required = false, rasterExpected = true) {
  const op = payload.operation;
  if (!op) { assert.ok(!required, 'An admitted payload has no operation'); return; }
  const finite = (value, label, minimum = 0) => assert.ok(Number.isFinite(value) && value >= minimum, label);
  const same = (a, b, label) => assert.ok(Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b)), label);
  const ids = value => Array.isArray(value) && value.length <= 12
    && value.every(id => Number.isSafeInteger(id) && id >= 0) && new Set(value).size === value.length;
  if (rasterExpected || payload.rasterWidth !== undefined || payload.rasterHeight !== undefined) {
    finite(payload.rasterWidth, 'Published payload raster width is missing');
    finite(payload.rasterHeight, 'Published payload raster height is missing');
  }
  assert.ok(typeof op.key === 'string' && op.key.length, 'Operation key missing');
  assert.ok(['delivery', 'removal', 'relocation', 'return'].includes(op.goal), 'Unknown operation goal');
  assert.ok(['normal', 'volunteer', 'overreach'].includes(op.operatingMode), 'Unknown operating mode');
  assert.ok(op.workload && op.workload.mass > 0 && op.workload.span > 0, 'Invalid admitted workload');
  finite(op.workload.mass, 'Invalid workload mass'); finite(op.workload.span, 'Invalid workload span');
  assert.ok(Number.isSafeInteger(op.workload.preferredCrew) && op.workload.preferredCrew >= 1 && op.workload.preferredCrew <= 3,
    'Invalid handling preference');
  assert.ok(ids(op.memberIds) && op.memberIds.length, 'Invalid original operation crew');
  assert.ok(op.decision?.key === op.key && ['volunteer', 'willingness', 'fulfillment', 'aftermath']
    .every(key => Number.isFinite(op.decision[key]) && op.decision[key] >= 0 && op.decision[key] < 1), 'Invalid canonical decision record');
  for (const key of ['demand', 'support', 'peakStrain']) {finite(op[key], 'Invalid operation ' + key);}
  const members = new Set(op.memberIds), seen = new Set(), bodies = new Map(actors.map(actor => [actor.id, actor]));
  assert.ok(Array.isArray(op.phases) && op.phases.length && op.phases.length <= 12, 'Missing operation phases');
  let until = 0, peak = 0;
  for (const phase of op.phases) {
    assert.ok(phase.id && Number.isFinite(phase.until) && phase.until > until && phase.until <= 1, 'Invalid phase order');
    until = phase.until;
    assert.ok(Array.isArray(phase.loads) && phase.loads.length && phase.loads.length <= 12, 'Missing phase loads');
    let phasePeak = 0;
    for (const load of phase.loads) {
      finite(load.demand, 'Invalid phase demand'); finite(load.support, 'Invalid phase support');
      assert.ok(Array.isArray(load.members) && load.members.length && ids(load.members.map(value => value.member)), 'Invalid phase crew');
      for (const value of load.members) {
        assert.ok(members.has(value.member), 'Phase uses an uncommitted supporter'); seen.add(value.member);
        assert.ok(['carry', 'lift', 'tow'].includes(value.role), 'Unknown support role');
        for (const key of ['support', 'effectiveSupport', 'committedEffort', 'assignedLoad', 'strain']) {finite(value[key], 'Invalid member ' + key);}
        assert.ok(value.effectiveSupport <= value.support + 1e-8, 'Effective support exceeds its structure');
        if (bodies.has(value.member)) {assert.equal(bodies.get(value.member).vehicle, value.vehicle, 'Support evidence names a different actor');}
        phasePeak = Math.max(phasePeak, value.strain);
      }
      same(load.members.reduce((sum, value) => sum + value.effectiveSupport, 0), load.support, 'Phase support accounting differs');
      same(load.members.reduce((sum, value) => sum + value.assignedLoad, 0), load.demand, 'Assigned load accounting differs');
    }
    same(phasePeak, phase.peakStrain, 'Phase strain accounting differs'); peak = Math.max(peak, phasePeak);
  }
  assert.equal(until, 1, 'Operation phases do not cover the work interval');
  assert.deepEqual([...seen].sort((a, b) => a - b), [...members].sort((a, b) => a - b), 'Original crew has no phase ownership');
  same(peak, op.peakStrain, 'Operation strain differs from its phases');
  assert.ok(op.operatingMode === 'overreach' ? op.peakStrain > 1 : op.peakStrain <= 1 + 1e-8,
    'Strain contradicts the explicit operating mode');
  const times = ['startedAt', 'workEnd', 'aftermathEnd', 'deadline'].map(key => op.timing?.[key]);
  assert.ok(times.every(Number.isFinite) && times.every((value, index) => !index || value >= times[index - 1]), 'Invalid operation timing');
  if (payload.deadline !== undefined) {same(times[3], payload.deadline, 'Operation extended the payload deadline');}
  const outcome = op.outcome;
  assert.ok(outcome && ['valiant-failure', 'expensive-success', 'clean-triumph'].includes(outcome.family)
    && ['fulfilled', 'partial', 'failed'].includes(outcome.completion)
    && ['none', 'strained', 'smoke', 'disabled'].includes(outcome.aftermath)
    && ['self', 'assisted', 'release'].includes(outcome.recovery), 'Invalid explicit outcome');
  assert.ok(ids(outcome.affectedActors) && outcome.affectedActors.every(id => members.has(id)), 'Aftermath targets an uncommitted actor');
  assert.ok(Number.isFinite(outcome.progress) && outcome.progress >= 0 && outcome.progress <= 1, 'Invalid planned work progress');
  assert.ok(['work', 'aftermath', 'recovery', 'complete', 'cancelled'].includes(op.state), 'Unknown operation state');
  assert.ok(['pending', 'fulfilled', 'partial', 'failed', 'cancelled'].includes(op.resolution), 'Unknown operation resolution');
  assert.equal(op.state === 'cancelled', op.resolution === 'cancelled', 'Cancellation state and resolution disagree');
  if (op.state === 'aftermath' || op.state === 'recovery') {assert.notEqual(op.resolution, 'pending', 'Aftermath started before work resolved');}
  if (op.resolution !== 'pending' && op.resolution !== 'cancelled')
    {assert.equal(op.resolution, outcome.completion, 'Resolution contradicts the committed outcome');}
  if (op.resolution === 'pending' && payload.rasterWidth !== undefined) {
    assert.ok(payload.rasterWidth > 0 && payload.rasterHeight > 0, 'Pending operation lost its owned cargo raster');
    for (const id of members) {assert.ok(payload.helpers.includes(id) && bodies.get(id)?.payloadId === payload.id,
      'Loaded operation is missing an original supporting actor');}
  } else if (op.resolution !== 'pending' && payload.rasterWidth !== undefined) {
    assert.equal(payload.rasterWidth, 0, 'Resolved work retained a cargo raster');
    assert.equal(payload.rasterHeight, 0, 'Resolved work retained a cargo raster');
    assert.equal(payload.arrivalCovered, false, 'Resolved work retained an arrival cover');
    if (op.goal === 'delivery') {assert.equal(payload.deposited, op.resolution === 'fulfilled', 'Deposit credit contradicts work resolution');}
  }
}

export function rememberPayloadIdentity(history, page, payload) {
  let operation;
  if (payload.operation) {
    const { state, resolution, ...frozen } = payload.operation; operation = frozen;
  }
  const identity = { page, id: payload.id, kind: payload.cropKind, imageId: payload.imageId,
    imageIds: payload.imageIds, target: payload.target, deadline: payload.deadline, operation };
  const previous = history.get(payload.id);
  if (previous) {assert.deepEqual(identity, previous, 'Crop or admitted operation changed during one delivery');}
  else {history.set(payload.id, structuredClone(identity));}
}

export function recordAdmission(row, sample, required = false) {
  const robot = sample.robots;
  const keys = ['operationAdmissions', 'operationCandidates', 'operationCommitChecks', 'operationNarrativeRecords', 'operationAdmissionTotalMs', 'operationAdmissionMaxMs'];
  if (robot.operationAdmissions === undefined) { assert.ok(!required, 'Admission diagnostics are missing'); return; }
  for (const key of [...keys, 'operationDecisionRecords']) {assert.ok(Number.isFinite(robot[key]) && robot[key] >= 0, 'Invalid admission diagnostic: ' + key);}
  for (const key of ['operationAdmissions', 'operationCandidates', 'operationCommitChecks', 'operationNarrativeRecords', 'operationDecisionRecords'])
    {assert.ok(Number.isSafeInteger(robot[key]), 'Admission count is not an integer: ' + key);}
  assert.ok(robot.operationAdmissionMaxMs <= robot.operationAdmissionTotalMs + 1e-8, 'Admission maximum exceeds total time');
  const current = { at: sample.at, ...Object.fromEntries(keys.map(key => [key, robot[key]])),
    operationDecisionRecords: robot.operationDecisionRecords, refinements: robot.refinements, paintTotalMs: robot.paintTotalMs };
  const log = row.admission ??= { stableIntervals: 0, refinementIntervals: 0, samples: [] };
  const previous = log.samples.at(-1);
  if (previous) {
    for (const key of keys) {assert.ok(current[key] >= previous[key], 'Admission statistic regressed within a document: ' + key);}
    if (current.operationAdmissions === previous.operationAdmissions) {
      for (const key of keys) {assert.equal(current[key], previous[key], 'Work repeated without a new admission: ' + key);}
      log.stableIntervals++;
      if (current.refinements > previous.refinements) {log.refinementIntervals++;}
    }
  }
  log.samples.push(current);
}

export function validateSample(sample, requireOperations = false) {
  const r = sample.robots;
  assert.ok(r, 'Robot snapshot must be exposed');
  validateTargetOwnership(r);
  for (const page of r.pages ?? []) {for (const payload of page.payloads ?? []) {validateOperation(payload, page.actors, requireOperations);}}
  for (const payload of r.replacement?.payloads ?? []) {validateOperation(payload, r.replacement.actors, requireOperations, false);}
  assert.ok(r.activeActors <= r.maxActors, 'Actor budget exceeded');
  assert.ok(r.cargoBytes <= r.maxCargoBytes, 'Cargo byte budget exceeded');
  assert.ok(r.spriteBytes <= r.maxSpriteBytes, 'Sprite byte budget exceeded');
  assert.equal(r.retainedBytes, r.cargoBytes + r.spriteBytes, 'Owned byte accounting differs');
  assert.equal(sample.cargo.reduce((sum, item) => sum + item.bytes, 0), r.cargoBytes,
    'Connected cargo and underlay bytes differ from their owner');
  assert.equal([...sample.vehicles, ...sample.cleaners].reduce((sum, item) => sum + item.bytes, 0), r.spriteBytes,
    'Connected sprite bytes differ from their owner');
  const actors = new Map((r.pages ?? []).flatMap(page => page.actors).map(actor => [actor.id, actor]));
  const scales = [];
  for (const body of sample.vehicles.filter(item => item.displayed)) {
    const actor = actors.get(body.id);
    if (!actor || actor.fromLab) {continue;}
    assert.ok(Math.abs(body.cssWidth - 128 * actor.spriteScale) <= 0.03, 'Displayed body width differs from its scale');
    assert.ok(Math.abs(body.cssHeight - 100 * actor.spriteScale) <= 0.03, 'Displayed body height differs from its scale');
    const requested = Math.min(3, Math.max(1, sample.dpr)), density = actor.spriteDensity;
    assert.ok(Number.isFinite(density) && density > 0 && density <= requested + 1e-8, 'Invalid published sprite density');
    const floor = Math.min(1, actor.spriteScale * requested);
    assert.ok(body.width + 1e-8 >= 128 * floor && body.height + 1e-8 >= 100 * floor,
      'Body backing lost its minimum local artwork detail');
    const width = 128 * actor.spriteScale * density, height = 100 * actor.spriteScale * density;
    assert.ok(body.width + 1e-8 >= width && body.width < width + 1 + 1e-8
      && body.height + 1e-8 >= height && body.height < height + 1 + 1e-8,
    'Body backing differs from its published sprite density');
    assert.ok(Number.isFinite(r.spriteScale) && r.spriteScale > 0, 'Shared document body scale is missing');
    // Check each physical body above; compare document scaling independently of which vehicle
    // was visible, since the structural presentation factor can differ between vehicles.
    scales.push(r.spriteScale);
  }
  for (const label of sample.labels.filter(label => label.opacity > 0.2 && label.display !== 'none')) {
    assert.equal(label.fontSize, 12, 'Caption CSS font size changed with page zoom or density');
    assert.equal(label.lineHeight, 16);
    assert.ok(label.rect.x >= sample.reader.x - 1 && label.rect.right <= sample.reader.right + 1
      && label.rect.y >= sample.reader.y - 1 && label.rect.bottom <= sample.reader.bottom + 1,
    'Readable caption escaped the reader bounds');
  }
  return scales;
}

export function validateMatrix(cases) {
  for (const engine of ['pdfjs', 'overleaf']) {
    const entries = cases.filter(item => item.engine === engine && !item.compact);
    if (!entries.length) {continue;}
    for (const zoom of ZOOMS) {
      const values = entries.filter(item => item.zoom === zoom);
      assert.equal(values.length, DPRS.length, 'Every density is required for ' + engine + '/' + zoom);
      const reference = values[0].bodyScale * Math.sqrt(values[0].dpr);
      for (const value of values) {assert.ok(Math.abs(value.bodyScale * Math.sqrt(value.dpr) / reference - 1) < 0.015,
        'DPR compensation is not applied exactly once: ' + engine + '/' + zoom + '/' + value.dpr);}
    }
    for (const dpr of DPRS) {
      const values = entries.filter(item => item.dpr === dpr).sort((a, b) => a.zoom - b.zoom);
      for (let i = 1; i < values.length; i++) {assert.ok(values[i].bodyScale >= values[i - 1].bodyScale - 0.002,
        'Body size regressed while document zoom increased');}
      const growth = values.at(-1).bodyScale / values[0].bodyScale;
      assert.ok(growth > 1.05 && growth < 1.8, 'Body growth must be visible and slower than page magnification');
    }
  }
}

export async function runMatrix(options, { open = connect, request = fetch, log = console.log } = {}) {
  assert.ok(options.execute, 'runMatrix requires explicit execution');
  const { id, work, ext: candidate, scenario, engine, compactOnly, representativeOnly, smallOnly, requireOperations, origin } = options;
  const matrix = matrixCases(options);
  const browserUrl = options.browserUrl ?? (options.profile && activePortUrl(options.profile));
  assert.ok(browserUrl || options.daemonUrl, 'The existing browser profile has no complete DevToolsActivePort');
  const fixture = JSON.parse(fs.readFileSync(path.join(options.book, 'builds.json'), 'utf8'));
  const sampler = fs.readFileSync(path.join(here, 'zoom-sample.js'), 'utf8');
  const expected = Object.fromEntries([...new Set(matrix.map(row => row.engine))].map(engine => {
    const file = path.join(candidate, 'dist', engine + '.mjs'), source = fs.readFileSync(file, 'utf8');
    return [engine, { file, size: Buffer.byteLength(source), sha256: digest(source) }];
  }));
  fs.mkdirSync(work, { recursive: true });
  const output = path.join(work, id + '.json'); assert.ok(!fs.existsSync(output), 'Receipt already exists');
  fs.writeFileSync(output, '', { flag: 'wx', mode: 0o600 });
  const report = { id, scenario, selection: { engine, compactOnly, representativeOnly, smallOnly, requireOperations },
    started: Date.now(), origin, fixture: { folder: options.book, builds: fixture }, timeoutMs: options.timeoutMs, cleanupBudgetMs: CLEANUP_MS,
    expected, transport: options.daemonUrl ? 'daemon' : 'direct', cases: [], entrySources: {}, errors: [], cleanupErrors: [] };
  const deadline = report.started + options.timeoutMs;
  let ownership, browser, session, scripts = [], problems = [], lastSample, cleanupDeadline, cleanups;
  const checkpoint = () => {
    fs.writeFileSync(output + '.writing', JSON.stringify(report, null, 2), { mode: 0o600 });
    fs.renameSync(output + '.writing', output);
  };
  const rpc = (method, params = {}, { timeoutMs = RPC_LIMIT_MS } = {}) => {
    assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'RPC timeout must be positive and at most 30 seconds');
    const remaining = (cleanupDeadline ?? deadline) - Date.now();
    assert.ok(remaining > 0, 'Matrix deadline reached during ' + method);
    const limitMs = Math.min(timeoutMs, remaining);
    return answerWithin(browser, method, limitMs, () => session.send(method, params, { limitMs }));
  };
  const evaluate = (expression, budget) => evaluateHarness({ send: rpc }, expression, budget);
  const waitFor = async (expression, { limitMs = 5000, stepMs = 40, what = expression } = {}) =>
    (await waitUntil(() => evaluate(expression), { what, limitMs, stepMs })).value;
  async function preparedDocument(previousTimeOrigin, config, row) {
    await prepareNavigatedView({ previousTimeOrigin, row, waitFor, zoom: ownership.zoom, capture: ownership.capture,
      activate: session.prepare && (() => rpc('Page.setWebLifecycleState', { state: 'active' })),
      prepare: session.prepare && (() => answerWithin(browser, 'Prepare navigated page', RPC_LIMIT_MS, () => session.prepare())) });
    const readyDeadline = Date.now() + 15000;
    for (;;) {
      const ready = await evaluate('(() => { const v = window.PDFViewerApplication?.pdfViewer ?? window.overleafViewer?.wrapper.viewer;'
        + 'return performance.timeOrigin !== ' + previousTimeOrigin + ' && !!window.pdfPrefetch && v?.pagesCount'
        + ' && (!window.PDFViewerApplication || window.PDFViewerApplication.isInitialViewSet)'
        + ' && Math.abs(v.currentScale - ' + config.zoom + ') < 1e-8; })()').catch(error => {
          if (/Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(String(error))) { return false; }
          throw error;
        });
      if (ready) {break;}
      assert.ok(Date.now() < readyDeadline, row.tag + ': target scale did not initialize'); await pause(30);
    }
    await evaluate('(window.PDFViewerApplication?.pdfViewer ?? window.overleafViewer.wrapper.viewer).pagesPromise.then(() => true)');
    if (ownership.zoom) { row.zoomNormalization = await ownership.zoom.ensure(); }
    await waitFor(`innerWidth === ${config.width} && innerHeight === ${config.height}
      && Math.abs(devicePixelRatio - ${config.dpr}) < 1e-6`, { limitMs: 5000, what: row.tag + ': requested viewport and display density' });
    row.renderingTurns = await evaluate(`(async () => {
      const v = window.PDFViewerApplication?.pdfViewer ?? window.overleafViewer?.wrapper.viewer;
      const origin = performance.timeOrigin, pdf = v.pdfDocument, started = performance.now(), frameTimes = [];
      await v.pagesPromise;
      await new Promise((resolve, reject) => {
        let frame = requestAnimationFrame(at => { frameTimes.push(at); frame = requestAnimationFrame(at => { frameTimes.push(at); clearTimeout(timer); resolve(); }); });
        const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('Initial rendering turns unavailable')); }, 1500);
      });
      if (origin !== performance.timeOrigin || v.pdfDocument !== pdf) throw new Error('Reader changed during initial readiness');
      return { elapsedMs: performance.now() - started, frameTimes };
    })()`);
    const script = executedEntry(scripts, origin, config.engine);
    const source = (await rpc('Debugger.getScriptSource', { scriptId: script.scriptId })).scriptSource;
    const actual = { url: script.url, size: Buffer.byteLength(source), sha256: digest(source) };
    assert.equal(actual.size, expected[config.engine].size); assert.equal(actual.sha256, expected[config.engine].sha256);
    report.entrySources[config.engine] = row.entrySource = actual;
    await evaluate('window.__labZoomCollectArtifacts = ' + collectPayloadArtifacts.toString());
    await evaluate('window.__labZoomVisible = ' + visibleInReader.toString());
    await evaluate(sampler);
    validateDisplayConfiguration(await sample(), { ...config, tag: row.tag });
    return actual;
  }
  async function sample() { return lastSample = await evaluate('window.__labZoomSample()'); }
  async function screenshot(name, state) {
    const file = path.join(work, id + '-' + name + '.png');
    // The explicit clip bounds output. Native captureBeyondViewport=false can time out waiting
    // for a new surface on a fully quiet background view, despite normal animation readiness.
    const capture = () => rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: state.viewport.width, height: state.viewport.height, scale: 1 / state.dpr } });
    const { data } = await (ownership.capture ? ownership.capture.still({ width: state.viewport.width, height: state.viewport.height }) : capture());
    const png = Buffer.from(data, 'base64');
    assert.equal(png.readUInt32BE(16), state.viewport.width, name + ': screenshot width changed');
    assert.equal(png.readUInt32BE(20), state.viewport.height, name + ': screenshot height changed');
    fs.writeFileSync(file, png); return file;
  }
  async function prepareEntry(row) {
    const evidence = row.entry = { page: 3, samples: [] };
    const read = () => evaluate('(' + readEntryPage.toString() + ')(window, 3)');
    await evaluate(`(() => { window.pdfPrefetch.setRobotsEnabled(false);
      const v = window.PDFViewerApplication?.pdfViewer ?? window.overleafViewer.wrapper.viewer;
      v.currentPageNumber = 3; v.update(); })()`);
    const warmUntil = Date.now() + 6000;
    for (;;) {
      evidence.warm = await read();
      const native = evidence.warm.target.native;
      if (native.state === 3 && native.connected && native.width && native.height && native.displayedWidth && native.displayedHeight) {break;}
      assert.ok(Date.now() < warmUntil, 'Entry target did not acquire native ready pixels'); await pause(50);
    }
    await evaluate(`(() => { const v = window.PDFViewerApplication?.pdfViewer ?? window.overleafViewer.wrapper.viewer;
      const page = v.getPageView(2).div, reader = v.container.getBoundingClientRect();
      v.container.scrollTop += page.getBoundingClientRect().top + page.clientTop - reader.bottom - 1;
      v.update(); })()`);
    await pause(300);
    await evaluate('window.pdfPrefetch.setRobotsEnabled(true)');
    await evaluate(`new Promise((resolve, reject) => {
      let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(true); }); });
      const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('Entry setup rendering turn unavailable')); }, 1500);
    })`);
    const previousUntil = Date.now() + 10000;
    for (;;) {
      const quiet = await evaluate(`(() => { const r = window.pdfPrefetch.snapshot().robots;
        return !r.activeActors && !r.retainedBytes && !r.scheduled && !r.caption; })()`);
      if (quiet) {break;}
      assert.ok(Date.now() < previousUntil, 'Previous-page delivery did not finish before the entry check'); await pause(100);
    }
    evidence.before = await read();
    assert.ok(evidence.before.target.clip.y >= evidence.before.sample.reader.bottom, 'Warm target is already visible before the wheel');
    assert.ok(!evidence.before.sample.robots.pages.some(value => value.page === 3), 'Warm target already owns an episode');
    await evaluate('window.__labZoomEntryScroll = (' + installEntryScrollObservation.toString()
      + ')(window, 3, ' + readEntryPage.toString() + ')');
    try {
      const reader = evidence.before.sample.reader;
      await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', x: reader.x + reader.width / 2,
        y: reader.y + reader.height / 2, deltaX: 0, deltaY: 180 });
      const earlyUntil = Date.now() + 1800;
      for (;;) {
        evidence.scroll = await evaluate('window.__labZoomEntryScroll.read()');
        assert.ok(!evidence.scroll.error, evidence.scroll.error);
        if (evidence.scroll.observation) {break;}
        assert.ok(Date.now() < earlyUntil, 'Entry scroll did not reach its observed rendering turns'); await pause(20);
      }
      evidence.early = evidence.scroll.observation;
      validateEntryStrip(evidence.before, evidence.early);
    } finally { await evaluate('window.__labZoomEntryScroll?.dispose(); delete window.__labZoomEntryScroll'); }
    const settleUntil = Date.now() + 1600;
    for (;;) {
      const current = await read(); evidence.samples.push(current);
      if (current.sample.robots.pages.some(value => value.page === 3)) {
        evidence.committed = current;
        validateEntrySettlement(evidence.before, evidence.early, current);
        return current.sample;
      }
      assert.ok(Date.now() < settleUntil, 'The unchanged strip did not admit after the existing settle event'); await pause(40);
    }
  }
  async function quietAfterCancel(label, reduced, row) {
    const evidence = row.cancellationEvidence = { samples: [] };
    const capture = async phase => {
      const value = await sample(); evidence.samples.push({ phase, sample: value }); recordAdmission(row, value, requireOperations); return value;
    };
    try {
      await capture('before');
      if (reduced) {
        await evaluate('window.__labZoomReduced = (' + installReducedMotionObservation.toString() + ')(window)');
        await rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        evidence.renderingTurn = await evaluate(`new Promise((resolve, reject) => {
          const frame = requestAnimationFrame(at => { clearTimeout(timer); resolve({ completed: true, at }); });
          const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('Reduced-motion rendering turn unavailable')); }, 1000);
        })`);
        await waitForReducedMotionChange(async () => {
          evidence.media = await evaluate('window.__labZoomReduced.read()'); return evidence.media;
        });
      } else { await evaluate('window.pdfPrefetch.setRobotsEnabled(false)'); await pause(80); }
      const first = await capture('settled'); await pause(250); const last = await capture('quiet');
      for (const state of [first, last]) {
        assert.equal(state.robots.activeActors, 0, label + ': actor remained');
        assert.equal(state.robots.retainedBytes, 0, label + ': owned bytes remained');
        assert.equal(state.robots.scheduled, false, label + ': RAF remained');
        assert.equal(state.ownedElements.length, 0, label + ': payload artifact remained');
        assert.equal(state.labels.length, 0, label + ': caption remained');
      }
      assert.equal(last.robots.frames, first.robots.frames, label + ': idle frames continued');
      if (reduced) {
        await evaluate('window.__labZoomReduced.dispose(); window.pdfPrefetch.setRobotsEnabled(false)');
        await rpc('Emulation.setEmulatedMedia', { features: [] });
      }
      return { elapsedMs: last.at - first.at, frames: last.robots.frames - first.robots.frames,
        mode: reduced ? 'reduced-motion' : 'robots-off', ownedBytes: last.robots.retainedBytes };
    } finally {
      if (reduced) {await evaluate('window.__labZoomReduced?.dispose(); delete window.__labZoomReduced');}
    }
  }
  try {
    const served = await request(origin + '/builds', { signal: AbortSignal.timeout(5000) });
    assert.equal(served.status, 200, 'Harness fixture inventory is unavailable');
    validateFixtureBuilds(fixture, await served.json(), origin);
    ownership = await attachHarness({ ...options, browserUrl }, open, request);
    ({ browser, session } = ownership); report.target = ownership.target.targetId;
    session.on('Runtime.exceptionThrown', event => problems.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
    session.on('Debugger.scriptParsed', event => scripts.push(event));
    await rpc('Runtime.enable'); await rpc('Page.enable'); await rpc('Debugger.enable');
    report.initial = await evaluate('({href:location.href,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
    for (const [index, config] of matrix.entries()) {
      assert.ok(Date.now() < deadline, 'Finite matrix deadline reached');
      assert.equal(digest(fs.readFileSync(expected[config.engine].file)), expected[config.engine].sha256, 'Candidate entry changed during validation');
      const tag = config.engine + '-z' + config.zoom + '-d' + config.dpr + (config.scenario ? '-' + config.scenario
        : config.entry ? '-entry-strip' : config.strip ? '-text-strip' : config.compact ? '-compact' : '');
      const row = { ...config, tag, samples: [], observations: [], cropIdentities: [], peaks: {}, status: 'running' };
      cleanups = deferredCleanup();
      report.cases.push(row); checkpoint();
      await evaluate('window.pdfPrefetch?.setRobotsEnabled(false)').catch(() => {});
      await rpc('Emulation.setDeviceMetricsOverride', { width: config.width, height: config.height,
        deviceScaleFactor: config.dpr, mobile: false });
      const doc = id + '-' + index;
      const state = { scale: String(config.zoom), sidebarView: 0 };
      if (config.strip) {state.position = { page: 0, offset: { left: 80, top: 700 }, pageSize: { width: 612, height: 792 } };}
      const response = await request(origin + '/state?doc=' + doc, { method: 'POST', signal: AbortSignal.timeout(5000),
        body: JSON.stringify(state) });
      assert.equal(response.status, 204); scripts = []; problems = [];
      const oldOrigin = await evaluate('performance.timeOrigin');
      const navigationUrl = origin + '/page?engine=' + config.engine + '&doc=' + doc;
      await rpc('Page.navigate', { url: navigationUrl });
      await preparedDocument(oldOrigin, config, row);
      await evaluate('window.pdfPrefetch.setDiagnosticsEnabled(false); window.pdfPrefetch.setRobotsEnabled(' + !config.entry + ')');
      const artifactName = (label, extension) => {
        assert.match(label, /^[a-z0-9][a-z0-9-]*$/); assert.match(extension, /^[a-z0-9]+$/);
        return path.join(work, id + '-' + tag + '-' + label + '.' + extension);
      };
      const caseCleanup = cleanups;
      const context = { options, row, config, navigationUrl, rpc, evaluate, sample, pause, waitFor,
        defer: (label, cleanup) => caseCleanup.defer(label, cleanup),
        checkpoint(label, value) { (row.evidence ??= {})[label] = value; checkpoint(); },
        screenshot: async label => { artifactName(label, 'png'); return screenshot(tag + '-' + label, await sample()); },
        writeArtifact(label, contents, extension = 'json') {
          const file = artifactName(label, extension);
          fs.writeFileSync(file, typeof contents === 'string' || Buffer.isBuffer(contents)
            ? contents : JSON.stringify(contents, null, 2), { flag: 'wx', mode: 0o600 });
          return file;
        },
        async reload({ scale = config.zoom } = {}) {
          assert.equal(await evaluate('location.href'), navigationUrl, 'The owned fixture navigated before its reload');
          const before = await evaluate('performance.timeOrigin'); scripts = [];
          await rpc('Page.reload');
          return preparedDocument(before, { ...config, zoom: scale }, row);
        },
      };
      const runMovement = async () => {
        if (config.scenario) {
          const module = await import(SCENARIO_MODULES[config.scenario]);
          row.result = await module.runScenario(context);
          return;
        }
      const observer = new PayloadObservations(), identities = new Map(), scales = [];
      let entryFirst = config.entry ? await prepareEntry(row) : undefined;
      const complete = config.entry || !config.compact && (config.zoom === 0.5 && config.dpr === 1 || config.zoom === 4 && config.dpr === 3);
      const observeUntil = Date.now() + (complete ? 8500 : 3300);
      let bodySeenAt, hoverSent = false, last, ended = false;
      while (Date.now() < observeUntil) {
        last = entryFirst ?? await sample(); entryFirst = undefined;
        row.samples.push(last);
        recordAdmission(row, last, requireOperations);
        validateDisplayConfiguration(last, { ...config, tag });
        const observedScales = validateSample(last, requireOperations); scales.push(...observedScales);
        if (config.strip) {row.strip = validateTextStrip(last);}
        row.observations.push(...observer.observe(last));
        for (const page of last.robots.pages) {for (const payload of page.payloads) {
          rememberPayloadIdentity(identities, page.page, payload);
        }}
        const history = new Map();
        for (const identity of identities.values()) {
          const group = history.get(identity.page) ?? []; group.push(identity); history.set(identity.page, group);
        }
        validateTargetOwnership({ pages: [...history].map(([page, payloads]) => ({ page, payloads })) });
        for (const [name, value] of Object.entries({ actors: last.robots.activeActors, cargoBytes: last.robots.cargoBytes,
          spriteBytes: last.robots.spriteBytes, nativeCanvasBytes: last.native.bytes, previewBytes: last.previews.bytes })) {
          row.peaks[name] = Math.max(row.peaks[name] ?? 0, value);
        }
        if (observedScales.length && bodySeenAt === undefined) {bodySeenAt = Date.now();}
        const body = last.vehicles.find(item => item.displayed && item.rect.x >= 0 && item.rect.y >= last.reader.y
          && item.rect.right <= last.reader.right && item.rect.bottom <= last.reader.bottom);
        if (!config.strip && !config.entry && (config.zoom === 1 || config.compact) && !hoverSent && body) {
          hoverSent = true; row.hover = { actorId: body.id, at: last.at };
          await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: body.rect.x + body.rect.width / 2,
            y: body.rect.y + body.rect.height / 2, buttons: 0 });
        }
        if (!row.screenshot && body && (config.compact || config.dpr === 1 && config.zoom === 0.5
          || config.dpr === 3 && config.zoom === 4 || last.labels.some(label => label.opacity > 0.2))) {
          row.screenshot = await screenshot(tag, last); row.screenshotAt = last.at;
        }
        if (complete && bodySeenAt !== undefined && !last.robots.scheduled && !last.robots.activeActors
          && !last.robots.retainedBytes && !last.labels.length) { ended = true; break; }
        if (!complete && bodySeenAt !== undefined && Date.now() - bodySeenAt >= 450
          && (!hoverSent || last.labels.some(label => label.opacity > 0.2))) { ended = true; break; }
        await pause(80);
      }
      assert.ok(scales.length, tag + ': no displayed owned courier was observed');
      assert.ok(ended, tag + ': finite observation did not reach its completion condition');
      row.cropIdentities = [...identities.values()];
      row.cropKinds = [...new Set(row.cropIdentities.map(item => item.kind))];
      row.operations = row.cropIdentities.filter(item => item.operation).map(item => ({ id: item.id, page: item.page, ...item.operation }));
      scales.sort((a, b) => a - b); row.bodyScale = scales[Math.floor(scales.length / 2)];
      if (hoverSent) {assert.ok(row.samples.some(state => state.labels.some(label => label.opacity > 0.2)), 'Hover caption never became visible');}
      if (complete) {
        await pause(250); const settled = await sample(); row.samples.push(settled); recordAdmission(row, settled, requireOperations);
        validateSample(settled, requireOperations); row.observations.push(...observer.observe(settled));
        assert.equal(settled.robots.frames, last.robots.frames, 'Effect frames continued after normal completion');
        assert.equal(settled.ownedElements.length, 0); row.completion = { elapsedMs: settled.at - last.at, frames: 0 };
      }
      row.cancellation = await quietAfterCancel(tag, config.compact && !config.strip, row);
      if (config.entry) {assert.equal(last.robots.episodes, row.entry.before.sample.robots.episodes + 1,
        'The unchanged target was admitted again during its finite scene');}
      };
      if (options.profileCpu) {
        const { withChromiumProfile } = await import('./chromium-profiler.mjs');
        await withChromiumProfile(context, runMovement);
      } else { await runMovement(); }
      const caseCleanupErrors = await cleanups.run(); report.cleanupErrors.push(...caseCleanupErrors);
      assert.deepEqual(caseCleanupErrors, [], 'Scenario cleanup failed');
      assert.deepEqual(problems, [], 'Frontend exceptions occurred');
      row.status = 'passed'; checkpoint();
      log(JSON.stringify({ progress: id, index: index + 1, count: matrix.length, tag,
        bodyScale: row.bodyScale, cropKinds: row.cropKinds, peaks: row.peaks, status: row.status }));
    }
    if (scenario === 'matrix' && !compactOnly && !representativeOnly && !smallOnly) {validateMatrix(report.cases);}
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.errors.push(String(error?.stack ?? error));
    if (error?.toJSON) { (report.errorDetails ??= []).push(error.toJSON()); }
    if (session && lastSample) {report.failureScreenshot = await screenshot('failure', lastSample).catch(() => null);}
  } finally {
    cleanupDeadline = Date.now() + CLEANUP_MS.scenario;
    if (cleanups) {report.cleanupErrors.push(...await cleanups.run());}
    cleanupDeadline = Date.now() + CLEANUP_MS.page;
    if (session) {
      for (const [label, operation] of [
        ['disable-robots', () => evaluate('window.pdfPrefetch?.setRobotsEnabled(false)')],
        ['dispose-entry-observer', () => evaluate('window.__labZoomEntryScroll?.dispose(); delete window.__labZoomEntryScroll')],
        ['dispose-media-observer', () => evaluate('window.__labZoomReduced?.dispose(); delete window.__labZoomReduced')],
        ['remove-sampler', () => evaluate('delete window.__labZoomSample; delete window.__labZoomVisible; delete window.__labZoomCollectArtifacts')],
        ['clear-reduced-motion', () => rpc('Emulation.setEmulatedMedia', { features: [] })],
        ['clear-device-metrics', () => rpc('Emulation.clearDeviceMetricsOverride')],
        ['disable-debugger', () => rpc('Debugger.disable')],
      ]) { try { await operation(); } catch (error) { report.cleanupErrors.push(label + ': ' + error); } }
      try { report.final = await evaluate('({href:location.href,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'); }
      catch (error) { report.cleanupErrors.push('final-state: ' + error); }
    }
    await ownership?.close().catch(error => report.cleanupErrors.push('detach: ' + error));
    if (ownership?.zoom) { report.zoomRestoration = ownership.zoom.restoration; }
    if (ownership?.capture) { report.renderingCapture = ownership.capture.evidence; }
    report.durationMs = Date.now() - report.started;
    if (report.cleanupErrors.length) {report.status = 'failed';}
    checkpoint(); log(JSON.stringify({ status: report.status, cases: report.cases.length, output,
      errors: report.errors, cleanupErrors: report.cleanupErrors, durationMs: report.durationMs }));
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = matrixOptions(argv);
    if (options.help) { console.log(usageOf(fileURLToPath(import.meta.url))); return; }
    if (!options.execute) {
      console.log(JSON.stringify({ status: 'planned', scenario: options.scenario, cases: matrixCases(options),
        work: options.work, ext: options.ext, book: options.book, origin: options.origin, target: options.target,
        requireOperations: options.requireOperations, timeoutMs: options.timeoutMs }));
      return;
    }
    const report = await runMatrix(options);
    if (report.status !== 'passed') {process.exitCode = 1;}
  } catch (error) {
    console.error(error instanceof UsageError ? error.message + '\n\n' + usageOf(fileURLToPath(import.meta.url)) : error.stack);
    process.exitCode = error instanceof UsageError ? 64 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {await main();}
