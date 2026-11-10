// One predicate owns whether scripted navigation may leave the current scene.
export function sceneReady(state) {
  const displayed = image => image?.connected && image.width > 0 && image.height > 0
    && image.rect.width > 0 && image.rect.height > 0
    && image.computed.display !== 'none' && image.computed.visibility !== 'hidden';
  return !state.sceneMoving && state.documentVisible && state.prefetchIdle === true && state.canvases.length > 0 && !state.missing.length
    && state.canvases.every(page => displayed(page.preview) || page.state === 3 && displayed(page.native))
    && state.canvases.every(page => page.state !== 1 && page.state !== 2)
    && !state.robots.activeActors && !state.robots.activePayloads && !state.robots.retainedBytes
    && !state.robots.queuedDeliveryCovers && !state.payloadArtifacts?.plans?.length
    && !state.robots.scheduled && !state.robots.caption?.pendingExpiry
    && Object.values(state.effectNodes).every(count => count === 0)
    && !state.pending.length && !state.pendingFetches && state.source?.state !== 'loading'
    && !state.source?.pending && !state.source?.decoding && !state.source?.queuedDecodes
    && !state.raw?.activeOperations && !state.raw?.pendingRequests && !state.raw?.imageDecodeActive && !state.raw?.imageDecodeQueued
    && !state.raw?.externalImageActive && !state.raw?.externalImageQueued && !state.raw?.externalImagePaused;
}

export function selectedDeliveryComplete(active, state) {
  if (!active) return false;
  const matches = [];
  for (const plan of state.robots.deliveryPlans ?? []) for (const crop of plan.crops) {
    if (plan.id === active.planId && plan.pageNumber === active.page && crop.id === active.cropId) matches.push({plan,crop});
  }
  return matches.length === 1 && matches[0].plan.committed === true
    && matches[0].crop.payloadId === active.payload.id && matches[0].crop.state === 'delivered';
}
