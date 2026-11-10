// Logical crop keys are opaque. Evidence binds the published source to the committed crop.
export function photoEvidence(
  payload,
  pageNumber,
  robots,
  atlasPage,
  rotation = 0,
) {
  if (
    payload.deposited ||
    payload.stage === 'return' ||
    !(payload.rasterWidth > 0) ||
    !(payload.rasterHeight > 0)
  )
    return null;
  if (!Array.isArray(payload.imageIds))
    throw new Error('Missing crop source inventory');
  if (!payload.imageIds.length) return null;
  const ids = payload.imageIds;
  if (
    ids.some((id) => typeof id !== 'string' || !id) ||
    new Set(ids).size !== ids.length
  )
    throw new Error('Ambiguous crop source IDs');
  const matches = [];
  for (const plan of robots.deliveryPlans ?? [])
    for (const crop of plan.crops) {
      if (plan.pageNumber === pageNumber && crop.payloadId === payload.id)
        matches.push({ plan, crop });
    }
  if (matches.length !== 1)
    throw new Error('Photo has no unique committed crop');
  const { plan, crop } = matches[0],
    geometry = crop.geometry;
  const fields = ['x', 'y', 'width', 'height'];
  const same = (a, b) =>
    fields.every(
      (key) =>
        Number.isFinite(a?.[key]) &&
        Number.isFinite(b?.[key]) &&
        Math.abs(a[key] - b[key]) <= 1e-12,
    );
  if (
    !Number.isSafeInteger(plan.id) || plan.id < 1 || !Number.isSafeInteger(crop.id) || crop.id < 0 ||
    !plan.committed ||
    crop.state !== 'active' ||
    geometry.imageId !== payload.imageId ||
    geometry.kind !== payload.cropKind ||
    JSON.stringify(geometry.imageIds) !== JSON.stringify(ids) ||
    !fields.every(key => Number.isFinite(geometry[key]) && geometry[key] === payload.target?.[key])
  )
    throw new Error('Photo differs from committed crop');
  if (
    atlasPage?.pageNumber !== pageNumber ||
    ![0, 90, 180, 270].includes(rotation)
  )
    throw new Error('Wrong photo page or rotation');
  const sources = ids.map((id) => {
    const matches = atlasPage.imageRegions.filter((region) => region.id === id);
    if (matches.length !== 1)
      throw new Error('Unknown or ambiguous atlas source');
    const original = matches[0];
    if (
      !fields.every((key) => Number.isFinite(original[key])) ||
      original.width <= 0 ||
      original.height <= 0 || original.x < 0 || original.y < 0 || original.x >= 1 || original.y >= 1
      || original.x + original.width > 1.000001 || original.y + original.height > 1.000001
    )
      throw new Error('Invalid source geometry');
    let { x, y, width, height } = original;
    const right = Math.min(1, x + width),
      bottom = Math.min(1, y + height);
    x = Math.max(0, x);
    y = Math.max(0, y);
    width = right - x;
    height = bottom - y;
    if (width <= 0 || height <= 0) throw new Error('Empty source geometry');
    if (rotation === 90)
      [x, y, width, height] = [1 - y - height, x, height, width];
    else if (rotation === 180) [x, y] = [1 - x - width, 1 - y - height];
    else if (rotation === 270)
      [x, y, width, height] = [y, 1 - x - width, height, width];
    const rightRotated = Math.min(1, x + width), bottomRotated = Math.min(1, y + height);
    x = Math.max(0, x); y = Math.max(0, y);
    return { ...original, x, y, width: rightRotated - x, height: bottomRotated - y };
  });
  const left = Math.min(...sources.map((r) => r.x)),
    top = Math.min(...sources.map((r) => r.y));
  const box = {
    x: left,
    y: top,
    width: Math.max(...sources.map((r) => r.x + r.width)) - left,
    height: Math.max(...sources.map((r) => r.y + r.height)) - top,
  };
  if (payload.cropKind === 'image') {
    if (sources.length !== 1 || !same(box, payload.target))
      throw new Error('Whole photo geometry mismatch');
  } else if (payload.cropKind === 'collage') {
    for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i], b = sources[j];
      if (Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1e-12
        && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1e-12) throw new Error('Collage sources overlap or alias');
    }
    if (sources.length < 2 || !same(box, payload.target))
      throw new Error('Collage geometry mismatch');
  } else if (payload.cropKind === 'portion') {
    const target = payload.target;
    if (sources.length !== 1 || target.width <= 0 || target.height <= 0)
      throw new Error('Invalid portion');
    const columns = Math.round(box.width / target.width), rows = Math.round(box.height / target.height);
    const column = Math.round((target.x - box.x) / target.width), row = Math.round((target.y - box.y) / target.height);
    if (![columns, rows, column, row].every(Number.isSafeInteger) || columns < 1 || rows < 1
      || columns === 1 && rows === 1 || column < 0 || row < 0 || column >= columns || row >= rows
      || !same(target, { x: box.x + column * box.width / columns, y: box.y + row * box.height / rows,
        width: box.width / columns, height: box.height / rows })) throw new Error('Portion is not an in-source grid cell');
  } else throw new Error('Unknown photo crop kind');
  return { planId: plan.id, cropId: crop.id, photoRegions: sources };
}
