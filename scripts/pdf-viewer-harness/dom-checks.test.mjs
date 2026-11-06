import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { byteOwnershipExpression, inspectByteOwnership, validateDom } from './dom-checks.mjs';

function evidence() {
  const size = { width: 1800, height: 2400 }, parents = { page: true, annotation: true, pageOffsetTop: 600, pageOffsetLeft: 200 };
  return { fixtureRemoved: true, focusUnchanged: true,
    ink: { baseline: size, contained: { ...size }, restored: { ...size }, sizeOnly: { width: 200256, height: 300160 },
      actorDelta: { x: -37, y: -53 }, pageDelta: { x: -37, y: -53 }, fixedDelta: { x: 0, y: 0 },
      controlPageDelta: { x: -17, y: -29 }, transformUnchanged: true },
    stacking: { baseline: size, afterRulesSize: { ...size }, afterScrollSize: { ...size },
      beforeParents: parents, afterParents: { ...parents }, viewerZ: 'auto', isolation: 'isolate',
      legacyCourierOverlap: 'lab', courierOverlap: 'courier', afterScrollCourierOverlap: 'courier',
      sidebarOverlap: 'sidebar', toolbarOverlap: 'toolbar', pageContent: 'annotation',
      noIsolationSidebar: 'annotation', noIsolationToolbar: 'annotation',
      beforeLab: { x: 240, y: 80, width: 140, height: 80 }, afterLab: { x: 240, y: 80, width: 140, height: 80 },
      actorDelta: { x: -37, y: -53 }, pageDelta: { x: -37, y: -53 },
      courierClipped: true, labOutsideViewerInputPath: true, transformUnchanged: true } };
}

test('checks real geometry and the negative controls independently of CSS text', () => {
  validateDom(evidence());
  for (const mutate of [
    value => { value.ink.contained.width++; },
    value => { value.ink.sizeOnly = { ...value.ink.baseline }; },
    value => { value.ink.actorDelta.y = 0; },
    value => { value.stacking.courierOverlap = 'lab'; },
    value => { value.stacking.noIsolationSidebar = 'sidebar'; },
    value => { value.stacking.afterParents.page = false; },
    value => { value.stacking.afterLab.y++; },
    value => { value.fixtureRemoved = false; },
    value => { value.focusUnchanged = false; },
  ]) {
    const value = evidence(); mutate(value); assert.throws(() => validateDom(value));
  }
});

test('the browser byte expression runs the actual bridge against native Response streams', async () => {
  const ext = fileURLToPath(new URL('../../views/pdf-viewer/', import.meta.url));
  const value = await Function('return ' + byteOwnershipExpression(ext))();
  assert.deepEqual(value, { passed: true, originalBufferDetached: true, fullSpanBytes: 4, nativeMaterializations: 0,
    consumedThroughEof: true, unlockedAfterRead: true, exactSliceBytes: 3, cloneReplacesOriginalStream: true,
    rawCloneMutationIndependent: true, cloneReadersReleased: true });
});

test('the native byte check rejects a copy-based response before reporting success', async () => {
  await assert.rejects(inspectByteOwnership({
    createBridgeResponse: bytes => new Response(bytes),
    readPdfResponse: response => response.arrayBuffer(),
  }), /not transferred/);
});
