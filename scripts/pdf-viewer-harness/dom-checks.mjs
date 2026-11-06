import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Run CSS paint-order and scroll-containment checks in a disposable same-origin frame. */
export function inspectDom({ css, labZ }, win = window) {
  const outer = win.document, focused = outer.activeElement;
  const host = outer.createElement('div'), frame = outer.createElement('iframe');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', width: '500px', height: '400px',
    pointerEvents: 'none', contain: 'strict', overflow: 'hidden' });
  frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { width: '500px', height: '400px', border: '0', pointerEvents: 'none' });
  host.attachShadow({ mode: 'closed' }).append(frame);
  let result;
  try {
    outer.body.append(host);
    const doc = frame.contentDocument, view = frame.contentWindow;
    if (!doc?.body || !view) { throw new Error('The disposable same-origin frame is unavailable'); }
    doc.body.style.margin = '0';
    const element = (style, id) => {
      const node = doc.createElement('div'); Object.assign(node.style, style); if (id) { node.id = id; } return node;
    };
    const box = node => { const value = node.getBoundingClientRect(); return { x: value.left, y: value.top, width: value.width, height: value.height }; };
    const delta = (after, before) => ({ x: after.x - before.x, y: after.y - before.y });
    const scrollInk = () => {
      const scroller = element({ position: 'absolute', left: '0', top: '0', width: '400px', height: '300px', overflow: 'auto' });
      const content = element({ width: '1800px', height: '2400px' });
      const page = element({ position: 'absolute', left: '200px', top: '600px', width: '400px', height: '600px' });
      const transit = element({ position: 'absolute', left: '0', top: '0', width: '0', height: '0',
        contain: 'layout size', overflow: 'visible', pointerEvents: 'none' });
      const actor = element({ position: 'absolute', left: '0', top: '0', width: '128px', height: '100px', transform: 'translate(360px,760px)' });
      const extreme = element({ position: 'absolute', left: '0', top: '0', width: '256px', height: '160px', transform: 'translate(200000px,300000px)' });
      content.append(page); scroller.append(content); doc.body.append(scroller);
      const size = () => ({ width: scroller.scrollWidth, height: scroller.scrollHeight });
      const baseline = size();
      transit.append(actor, extreme); scroller.append(transit);
      const contained = size();
      transit.style.contain = 'size'; const sizeOnly = size();
      transit.style.contain = 'layout size'; const restored = size();
      scroller.scrollLeft = 100; scroller.scrollTop = 500;
      const beforePage = box(page), beforeActor = box(actor), transform = actor.style.transform;
      scroller.scrollLeft += 37; scroller.scrollTop += 53;
      const pageDelta = delta(box(page), beforePage), actorDelta = delta(box(actor), beforeActor);
      transit.style.position = 'fixed';
      const beforeFixed = box(actor), beforeControlPage = box(page);
      scroller.scrollLeft += 17; scroller.scrollTop += 29;
      const fixedDelta = delta(box(actor), beforeFixed), controlPageDelta = delta(box(page), beforeControlPage);
      scroller.remove();
      return { baseline, contained, sizeOnly, restored, pageDelta, actorDelta, fixedDelta, controlPageDelta,
        transformUnchanged: actor.style.transform === transform };
    };
    const stacking = () => {
      const vendor = doc.createElement('style'), shared = doc.createElement('style');
      vendor.textContent = '#viewerContainer{position:absolute;left:40px;top:60px;width:400px;height:300px;overflow:auto;z-index:0;background:white}.pdfViewer{width:1800px;height:2400px}.page{position:relative;left:200px;top:600px;width:400px;height:600px}';
      doc.head.append(vendor);
      const scroller = element({}, 'viewerContainer'), content = element({}), page = element({});
      content.className = 'pdfViewer'; page.className = 'page';
      const annotation = element({ position: 'absolute', left: '-200px', top: '-600px', width: '500px', height: '500px',
        zIndex: '2147483647', background: 'green' }, 'annotation');
      const sidebar = element({ position: 'absolute', left: '40px', top: '60px', width: '100px', height: '300px',
        zIndex: '1', background: 'gray' }, 'sidebar');
      const toolbar = element({ position: 'absolute', left: '150px', top: '60px', width: '100px', height: '40px',
        zIndex: '2', background: 'black' }, 'toolbar');
      const transit = element({ position: 'absolute', left: '0', top: '0', width: '0', height: '0',
        contain: 'layout size', overflow: 'visible', zIndex: '2147483647', pointerEvents: 'none' });
      // Only this disposable document enables pointer hits on courier ink to inspect paint order.
      const actor = element({ position: 'absolute', left: '0', top: '0', width: '128px', height: '100px',
        transform: 'translate(260px,70px)', pointerEvents: 'auto', background: 'red' }, 'courier');
      const extreme = element({ position: 'absolute', left: '0', top: '0', width: '128px', height: '100px',
        transform: 'translate(200000px,300000px)' });
      const lab = element({ position: 'fixed', left: '240px', top: '80px', width: '140px', height: '80px',
        zIndex: String(labZ), background: 'blue' }, 'lab');
      page.append(annotation); content.append(page); scroller.append(content); doc.body.append(scroller, sidebar, toolbar, lab);
      const size = () => ({ width: scroller.scrollWidth, height: scroller.scrollHeight });
      const parents = () => ({ page: page.offsetParent === scroller, annotation: annotation.offsetParent === page,
        pageOffsetTop: page.offsetTop, pageOffsetLeft: page.offsetLeft });
      const hit = (x, y) => doc.elementFromPoint(x, y)?.id ?? '';
      const beforeParents = parents(), baseline = size();
      transit.append(actor, extreme); scroller.append(transit);
      const legacyCourierOverlap = hit(300, 130);
      shared.textContent = css; doc.head.append(shared);
      const afterParents = parents(), afterRulesSize = size();
      const courierOverlap = hit(300, 130), sidebarOverlap = hit(70, 180), toolbarOverlap = hit(190, 80), pageContent = hit(200, 180);
      const isolation = view.getComputedStyle(content).isolation, viewerZ = view.getComputedStyle(scroller).zIndex;
      const noIsolation = doc.createElement('style'); noIsolation.textContent = '.pdfViewer{isolation:auto!important}'; doc.head.append(noIsolation);
      const noIsolationSidebar = hit(70, 180), noIsolationToolbar = hit(190, 80); noIsolation.remove();
      const beforeLab = box(lab), beforeActor = box(actor), beforePage = box(page), transform = actor.style.transform;
      scroller.scrollLeft = 37; scroller.scrollTop = 53;
      const afterLab = box(lab), actorDelta = delta(box(actor), beforeActor), pageDelta = delta(box(page), beforePage);
      const afterScrollSize = size(), afterScrollCourierOverlap = hit(300, 130);
      const transformUnchanged = actor.style.transform === transform;
      actor.style.transform = 'translate(260px,-100px)';
      const courierClipped = hit(300, 20) !== 'courier';
      return { baseline, afterRulesSize, afterScrollSize, beforeParents, afterParents, viewerZ, isolation,
        legacyCourierOverlap, courierOverlap, sidebarOverlap, toolbarOverlap, pageContent,
        noIsolationSidebar, noIsolationToolbar, afterScrollCourierOverlap, beforeLab, afterLab, actorDelta, pageDelta,
        courierClipped, labOutsideViewerInputPath: !scroller.contains(lab) && lab.parentNode === doc.body,
        transformUnchanged };
    };
    result = { ink: scrollInk(), stacking: stacking() };
  } finally { host.remove(); }
  return { ...result, fixtureRemoved: !host.isConnected, focusUnchanged: outer.activeElement === focused };
}

export function validateDom(value) {
  assert.equal(value.fixtureRemoved, true, 'Disposable frame remained attached');
  assert.equal(value.focusUnchanged, true, 'DOM checks changed reader focus');
  const ink = value.ink, stack = value.stacking;
  assert.deepEqual(ink.contained, ink.baseline, 'Courier ink enlarged scroll overflow');
  assert.deepEqual(ink.restored, ink.baseline, 'Restoring layout containment did not restore scroll extent');
  assert.ok(ink.sizeOnly.width > ink.baseline.width && ink.sizeOnly.height > ink.baseline.height,
    'The size-only negative control did not expose scroll overflow');
  assert.deepEqual(ink.actorDelta, ink.pageDelta, 'Scroll-local courier and page moved differently');
  assert.deepEqual(ink.fixedDelta, { x: 0, y: 0 }, 'The fixed-position negative control moved with the document');
  assert.ok(ink.controlPageDelta.x !== 0 && ink.controlPageDelta.y !== 0, 'The negative control did not scroll');
  assert.equal(ink.transformUnchanged, true, 'Scrolling rewrote the courier transform');
  for (const [key, expected] of Object.entries({ legacyCourierOverlap: 'lab', courierOverlap: 'courier',
    afterScrollCourierOverlap: 'courier', sidebarOverlap: 'sidebar', toolbarOverlap: 'toolbar', pageContent: 'annotation',
    noIsolationSidebar: 'annotation', noIsolationToolbar: 'annotation', viewerZ: 'auto', isolation: 'isolate' })) {
    assert.equal(stack[key], expected, 'Paint-order check failed: ' + key);
  }
  assert.deepEqual(stack.beforeParents, stack.afterParents, 'Shared CSS changed PDF offset parents');
  assert.equal(stack.afterParents.page, true); assert.equal(stack.afterParents.annotation, true);
  assert.deepEqual(stack.afterRulesSize, stack.baseline); assert.deepEqual(stack.afterScrollSize, stack.baseline);
  assert.deepEqual(stack.afterLab, stack.beforeLab, 'The fixed Lab moved with document scroll');
  assert.deepEqual(stack.actorDelta, stack.pageDelta, 'Painted courier and page scroll differently');
  assert.equal(stack.courierClipped, true); assert.equal(stack.labOutsideViewerInputPath, true);
  assert.equal(stack.transformUnchanged, true);
}

/** Execute the native Response checks in the target browser, using the current bridge implementation. */
export async function inspectByteOwnership({ createBridgeResponse, readPdfResponse }) {
  const check = (value, message) => { if (!value) { throw new Error(message); } };
  const equal = (bytes, expected) => bytes.length === expected.length && expected.every((value, index) => bytes[index] === value);
  const body = new Uint8Array([1, 2, 3, 4]), originalBuffer = body.buffer;
  const response = createBridgeResponse(body, { status: 206 });
  check(originalBuffer.byteLength === 0, 'The original full buffer was not transferred');
  let nativeMaterializations = 0;
  const nativeArrayBuffer = response.arrayBuffer;
  response.arrayBuffer = () => { nativeMaterializations++; return nativeArrayBuffer.call(response); };
  const full = await readPdfResponse(response);
  check(full instanceof ArrayBuffer && equal(new Uint8Array(full), [1, 2, 3, 4]), 'Full-span bytes changed');
  check(nativeMaterializations === 0 && response.bodyUsed && !response.body.locked, 'Full-span body lifecycle changed');
  const closedReader = response.body.getReader();
  try { check((await closedReader.read()).done, 'The helper did not consume EOF'); }
  finally { closedReader.releaseLock(); }
  const neighbours = new Uint8Array([91, 92, 4, 5, 6, 93, 94]);
  const sliced = createBridgeResponse(neighbours.subarray(2, 5), { status: 206 });
  const slice = await readPdfResponse(sliced);
  check(equal(new Uint8Array(slice), [4, 5, 6]), 'Sliced boundaries changed');
  check(sliced.bodyUsed && !sliced.body.locked, 'Sliced reader remained locked');
  const clonable = createBridgeResponse(new Uint8Array([7, 8, 9]), { status: 206 });
  const markedOriginal = clonable.body, clone = clonable.clone();
  check(clonable.body !== markedOriginal, 'Clone kept the marked original stream');
  const one = clonable.body.getReader(), two = clone.body.getReader();
  try {
    const first = await one.read(); first.value[0] = 99;
    const second = await two.read();
    check(equal(second.value, [7, 8, 9]), 'Raw clone branches share mutable bytes');
    check((await one.read()).done && (await two.read()).done, 'Cloned streams did not finish');
  } finally { one.releaseLock(); two.releaseLock(); }
  return { passed: true, originalBufferDetached: originalBuffer.byteLength === 0,
    fullSpanBytes: full.byteLength, nativeMaterializations, consumedThroughEof: true,
    unlockedAfterRead: !response.body.locked, exactSliceBytes: slice.byteLength,
    cloneReplacesOriginalStream: clonable.body !== markedOriginal, rawCloneMutationIndependent: true,
    cloneReadersReleased: !clonable.body.locked && !clone.body.locked };
}

export function byteOwnershipExpression(ext) {
  const esbuild = createRequire(import.meta.url)('esbuild');
  const built = esbuild.buildSync({ entryPoints: [path.join(ext, 'src/common/bridge-response.ts')],
    bundle: true, write: false, format: 'iife', globalName: 'pdfHarnessBridgeBytes',
    platform: 'browser', target: 'es2022', logLevel: 'silent' });
  return '(async () => {\n' + built.outputFiles[0].text + '\nreturn (' + inspectByteOwnership.toString() + ')(pdfHarnessBridgeBytes);\n})()';
}

export async function runScenario(context) {
  const common = path.join(context.options.ext, 'src/common');
  const css = fs.readFileSync(path.join(common, 'prefetch.css'), 'utf8');
  const performanceSource = fs.readFileSync(path.join(common, 'prefetch-performance.ts'), 'utf8');
  const labZ = Number(performanceSource.match(/:host\s*\{[^}]*z-index:(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(labZ), 'The actual Lab z-index was not found');
  const dom = await context.evaluate('(' + inspectDom.toString() + ')(' + JSON.stringify({ css, labZ }) + ',window)');
  await context.checkpoint('dom', dom);
  validateDom(dom);
  const bytes = await context.evaluate(byteOwnershipExpression(context.options.ext));
  await context.checkpoint('byte-ownership', bytes);
  assert.equal(bytes.passed, true, 'Native browser byte ownership failed');
  return { dom, bytes };
}
