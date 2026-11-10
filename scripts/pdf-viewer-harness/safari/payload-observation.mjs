// Payload observations shared by the Safari probes; this module does not schedule work.
export function collectPayloadArtifacts(root) {
  const classes = {
    pdfDocumentRobotCargo: 'cargo', pdfDocumentRobotArrival: 'cover',
    pdfDocumentRobotCargoUnderlay: 'underlay', pdfDocumentRobotCleaner: 'cleaner',
  };
  const payloads = new Map(), plans = [];
  let unassigned = 0;
  for (const node of root.querySelectorAll(Object.keys(classes).map(name => '.' + name).join(','))) {
    if (!node.isConnected) continue;
    const plan = node.dataset.deliveryPlan, crop = node.dataset.deliveryCrop;
    if (plan !== undefined || crop !== undefined) {
      if (node.dataset.payload !== undefined || !/^[1-9][0-9]*$/.test(plan ?? '')
        || !/^(0|[1-9][0-9]*)$/.test(crop ?? '') || !Number.isSafeInteger(Number(plan))
        || !Number.isSafeInteger(Number(crop)) || !node.classList.contains('pdfDocumentRobotArrival')
        || ['pdfDocumentRobotCargo', 'pdfDocumentRobotCargoUnderlay', 'pdfDocumentRobotCleaner'].some(name => node.classList.contains(name))) unassigned++;
      else plans.push({ planId: Number(plan), cropId: Number(crop) });
      continue;
    }
    const id = Number(node.dataset.payload);
    if (!Number.isSafeInteger(id) || id < 1) { unassigned++; continue; }
    let entry = payloads.get(id);
    if (!entry) payloads.set(id, entry = { id, cargo: 0, cover: 0, underlay: 0, cleaner: 0 });
    for (const [name, kind] of Object.entries(classes)) if (node.classList.contains(name)) entry[kind]++;
  }
  return { complete: true, unassigned, plans, payloads: [...payloads.values()] };
}

function ownershipCounts(inventory) {
  if (inventory?.complete !== true || inventory.unassigned !== 0 || !Array.isArray(inventory.payloads)) {
    throw new Error('Payload artifact absence evidence is incomplete');
  }
  const counts = new Map();
  for (const entry of inventory.payloads) {
    if (!Number.isSafeInteger(entry.id) || entry.id < 1
      || ['cargo', 'cover', 'underlay', 'cleaner'].some(key => !Number.isSafeInteger(entry[key]) || entry[key] < 0)) {
      throw new Error('Invalid payload artifact ownership evidence');
    }
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + entry.cargo + entry.cover + entry.underlay + entry.cleaner);
  }
  return counts;
}

export class PayloadObservations {
  #seen = new Map();
  #helperOwners = new Map();
  #historical;
  constructor({ historical = false } = {}) { this.#historical = historical; }

  observe(sample) {
    const counts = ownershipCounts(sample.payloadArtifacts);
    const expected = new Set(), actual = new Set();
    for (const plan of sample.robots?.deliveryPlans ?? []) for (const crop of plan.crops) {
      if (crop.state !== 'queued' || crop.protected !== true) continue;
      const key = plan.id + ':' + crop.id;
      if (!Number.isSafeInteger(plan.id) || plan.id < 1 || !Number.isSafeInteger(crop.id) || crop.id < 0 || expected.has(key)) throw new Error('Invalid queued cover plan ownership');
      expected.add(key);
    }
    for (const entry of sample.payloadArtifacts.plans ?? []) {
      const key = entry.planId + ':' + entry.cropId;
      if (actual.has(key) || !expected.has(key)) throw new Error('Unowned or duplicate queued cover');
      actual.add(key);
    }
    if (actual.size !== expected.size || (sample.robots?.queuedDeliveryCovers ?? 0) !== actual.size) throw new Error('Queued cover evidence is incomplete');
    for (const [id, entry] of this.#seen) {
      if (entry.retired && (counts.get(id) ?? 0) > 0) throw new Error('Retired payload artifact reappeared: ' + id);
    }
    const observations = [];
    for (const page of sample.robots?.pages ?? []) for (const payload of page.payloads) {
      const { id, rasterWidth: width, rasterHeight: height } = payload;
      if (!Number.isSafeInteger(id) || id < 1 || !Number.isFinite(payload.deadline)
        || !Number.isSafeInteger(width) || width < 0 || !Number.isSafeInteger(height) || height < 0
        || !Number.isSafeInteger(payload.refinements) || payload.refinements < 0
        || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(payload.target?.[key]))) {
        throw new Error('Invalid payload observation');
      }
      let planIdentity;
      if (!this.#historical) {
        if (typeof payload.operation?.key !== 'string' || !Array.isArray(payload.operation.memberIds)
          || !payload.operation.memberIds.length || !Array.isArray(payload.imageIds) || typeof payload.cropKind !== 'string'
          || !Array.isArray(payload.helpers)) throw new Error('Incomplete current payload identity');
        for (const values of [payload.operation.memberIds, payload.helpers]) {
          if (!values.length || values.some(value => !Number.isSafeInteger(value) || value < 1)
            || new Set(values).size !== values.length) throw new Error('Invalid numeric crew identity');
        }
        const bindings = [];
        for (const plan of sample.robots?.deliveryPlans ?? []) for (const crop of plan.crops) {
          if (plan.pageNumber === page.page && crop.payloadId === id) bindings.push({ plan, crop });
        }
        if (bindings.length !== 1 || !bindings[0].plan.committed) throw new Error('Payload has no unique committed plan');
        const { plan, crop } = bindings[0], geometry = crop.geometry;
        if (!Number.isSafeInteger(plan.id) || plan.id < 1 || !Number.isSafeInteger(crop.id) || crop.id < 0) throw new Error('Invalid committed plan identity');
        if (geometry.imageId !== payload.imageId || geometry.kind !== payload.cropKind
          || JSON.stringify(geometry.imageIds) !== JSON.stringify(payload.imageIds)
          || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(geometry[key]) || geometry[key] !== payload.target[key])) throw new Error('Payload differs from frozen plan');
        planIdentity = plan.id + ':' + crop.id;
        if (this.#seen.has(id) && this.#seen.get(id).planIdentity !== planIdentity) throw new Error('Payload changed committed plan');
        const original = payload.operation.memberIds;
        const emptyReturn = payload.deposited === true && payload.stage === 'return' && width === 0 && height === 0 && payload.arrivalCovered === false;
        if (emptyReturn ? !original.every(id => payload.helpers.includes(id))
          : JSON.stringify(original) !== JSON.stringify(payload.helpers)) throw new Error('Payload helper membership changed');
        const before = this.#seen.get(id)?.payload;
        if (before && JSON.stringify([before.operation.key, before.operation.memberIds, before.imageIds, before.cropKind])
          !== JSON.stringify([payload.operation.key, original, payload.imageIds, payload.cropKind])) throw new Error('Payload operation or source identity changed');
      }
      for (const helper of payload.helpers ?? []) {
        const owner = this.#helperOwners.get(helper);
        if (owner !== undefined && owner !== id) throw new Error('Payload identity changed for continuing courier: ' + helper);
      }
      const previous = this.#seen.get(id), before = previous?.payload;
      if (before && (previous.page !== page.page || before.id !== id || before.imageId !== payload.imageId
        || before.deadline !== payload.deadline
        || ['x', 'y', 'width', 'height'].some(key => before.target[key] !== payload.target[key]))) {
        throw new Error('Payload identity/deadline/target changed: ' + id);
      }
      if ((width === 0) !== (height === 0)) throw new Error('Payload raster has a partial-zero dimension: ' + id);
      if (previous?.retired && payload.refinements !== before.refinements) {
        throw new Error('Payload recorded a refinement after retirement: ' + id);
      }
      if (before && payload.refinements < before.refinements) throw new Error('Payload refinement count regressed: ' + id);
      const retired = width === 0;
      if (previous?.retired && (!retired || payload.refinementPending !== false || payload.arrivalCovered !== false)) {
        throw new Error('Retired payload resumed raster ownership: ' + id);
      }
      if (retired && ((counts.get(id) ?? 0) !== 0 || payload.refinementPending !== false || payload.arrivalCovered !== false)) {
        throw new Error('Zeroed payload still owns an artifact or pending refinement: ' + id);
      }
      if (!retired && before && (width < before.rasterWidth || height < before.rasterHeight)) {
        throw new Error('Retained payload raster shrank: ' + id);
      }
      let kind;
      if (retired && !previous?.retired) kind = before ? 'retired-between-samples' : 'retired-on-first-sample';
      else if (!retired && before && payload.refinements > before.refinements) kind = 'refined';
      if (kind) observations.push({ kind, at: sample.at, page: page.page, payloadId: id, stable: true, before, after: payload });
      // Retain terminal identities for this bounded run; never silently forget a retired payload.
      if (!previous && this.#seen.size >= 4096) throw new Error('Payload observation history limit reached');
      this.#seen.set(id, { page: page.page, payload, retired, planIdentity });
      for (const helper of payload.helpers ?? []) this.#helperOwners.set(helper, id);
    }
    return observations;
  }
}
