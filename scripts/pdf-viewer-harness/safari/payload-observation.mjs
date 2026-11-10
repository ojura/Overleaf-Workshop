// Payload observations shared by the Safari probes; this module does not schedule work.
export function collectPayloadArtifacts(root) {
  const display = node => {
    const rect = node.getBoundingClientRect?.(), view = node.ownerDocument?.defaultView;
    const style = view?.getComputedStyle(node);
    let visible = !!rect && !!style && rect.width > 0 && rect.height > 0;
    for (let ancestor = node; visible && ancestor; ancestor = ancestor.parentElement) {
      const css = ancestor === node ? style : view.getComputedStyle(ancestor);
      visible = css.display !== 'none' && !['hidden', 'collapse'].includes(css.visibility) && Number(css.opacity) > 0;
    }
    const reader = view?.PDFViewerApplication?.pdfViewer?.container?.getBoundingClientRect();
    const fraction = rect && reader && rect.width > 0 && rect.height > 0
      ? Math.max(0, Math.min(rect.right, reader.right) - Math.max(rect.left, reader.left))
        * Math.max(0, Math.min(rect.bottom, reader.bottom) - Math.max(rect.top, reader.top)) / (rect.width * rect.height)
      : undefined;
    return { rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      computed: style && { display: style.display, visibility: style.visibility, opacity: style.opacity,
        clipPath: style.clipPath || 'none', transform: style.transform || 'none' },
      readerFraction: fraction, displayed: visible && (fraction === undefined || fraction > 0) };
  };
  const classes = {
    pdfDocumentRobotCargo: 'cargo', pdfDocumentRobotArrival: 'cover',
    pdfDocumentRobotCargoUnderlay: 'underlay', pdfDocumentRobotCleaner: 'cleaner',
  };
  const qualityClasses = {
    pdfDocumentRobotQualityCoarse: 'coarse', pdfDocumentRobotQualitySharp: 'sharp',
    pdfDocumentRobotQualityCleaner: 'cleaner',
  };
  const payloads = new Map(), plans = [], quality = new Map();
  let unassigned = 0;
  for (const node of root.querySelectorAll([...Object.keys(classes), ...Object.keys(qualityClasses)].map(name => '.' + name).join(','))) {
    if (!node.isConnected) continue;
    const qualityKinds = Object.entries(qualityClasses).filter(([name]) => node.classList.contains(name));
    if (qualityKinds.length || node.dataset.quality !== undefined) {
      const id = Number(node.dataset.quality), pageNumber = Number(node.dataset.page);
      if (qualityKinds.length !== 1 || Object.keys(classes).some(name => node.classList.contains(name))
        || node.dataset.payload !== undefined || node.dataset.deliveryPlan !== undefined || node.dataset.deliveryCrop !== undefined
        || !/^[1-9][0-9]*$/.test(node.dataset.quality ?? '') || !Number.isSafeInteger(id)
        || !/^[1-9][0-9]*$/.test(node.dataset.page ?? '') || !Number.isSafeInteger(pageNumber)
        || typeof node.dataset.imageId !== 'string' || !node.dataset.imageId) { unassigned++; continue; }
      const kind = qualityKinds[0][1];
      let entry = quality.get(id);
      if (!entry) quality.set(id, entry = { id, pageNumber, imageId: node.dataset.imageId });
      if (entry[kind] || entry.pageNumber !== pageNumber || entry.imageId !== node.dataset.imageId) { unassigned++; continue; }
      entry[kind] = { width: node.width, height: node.height, ...display(node) };
      continue;
    }
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
  const captions = [...root.querySelectorAll('.pdfDocumentRobotCaption')]
    .filter(node => node.isConnected && node.classList.contains('pdfDocumentRobotCaption'))
    .map(node => ({ text: node.textContent, ...display(node) }));
  return { complete: true, unassigned, plans, payloads: [...payloads.values()], quality: [...quality.values()], captions };
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

/** Quality pixels have their own finite owner; they never revive a retired payload. */
export class QualityObservations {
  #seen = new Map();

  #identity(value) {
    if (['id', 'sourcePage', 'pageNumber', 'planId', 'actorId'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1)
      || !Number.isSafeInteger(value.cropId) || value.cropId < 0 || typeof value.imageId !== 'string' || !value.imageId
      || value.associatedPayloadId !== undefined && (!Number.isSafeInteger(value.associatedPayloadId) || value.associatedPayloadId < 1)
      || !Array.isArray(value.imageIds) || !value.imageIds.length || new Set(value.imageIds).size !== value.imageIds.length
      || value.imageIds.some(id => typeof id !== 'string' || !id)
      || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(value.target?.[key]))
      || value.target.x < 0 || value.target.y < 0 || value.target.width <= 0 || value.target.height <= 0
      || value.target.x + value.target.width > 1.000001 || value.target.y + value.target.height > 1.000001) {
      throw new Error('Invalid quality scene identity');
    }
    return JSON.stringify([value.id, value.sourcePage, value.pageNumber, value.planId, value.cropId,
      value.imageId, value.imageIds, value.actorId, value.associatedPayloadId,
      ...['x', 'y', 'width', 'height'].map(key => value.target[key])]);
  }

  #remember(id, value) {
    if (!this.#seen.has(id) && this.#seen.size >= 4096) throw new Error('Quality observation history limit reached');
    this.#seen.set(id, value);
  }

  observe(sample) {
    const robots = sample.robots ?? {}, inventory = sample.payloadArtifacts?.quality ?? [];
    const current = robots.qualityReactions ?? [], outcomes = robots.qualityOutcomes ?? [];
    const declared = robots.qualityReactions !== undefined || robots.qualityOutcomes !== undefined
      || robots.activeQualityReactions !== undefined;
    if (declared && (!Array.isArray(robots.qualityReactions) || !Array.isArray(robots.qualityOutcomes)
        || !Number.isSafeInteger(robots.activeQualityReactions) || robots.activeQualityReactions !== current.length)
      || !Array.isArray(inventory)) throw new Error('Quality ownership evidence is incomplete');
    const artifacts = new Map(), active = new Set(), terminal = new Set(), actors = new Set();
    for (const entry of inventory) {
      if (!Number.isSafeInteger(entry.id) || entry.id < 1 || artifacts.has(entry.id)) throw new Error('Duplicate or invalid quality artifact owner');
      artifacts.set(entry.id, entry);
    }
    for (const outcome of outcomes) {
      const identity = this.#identity(outcome), before = this.#seen.get(outcome.id);
      if (terminal.has(outcome.id) || !['completed', 'cancelled'].includes(outcome.outcome)
        || !Number.isFinite(outcome.at) || typeof outcome.reason !== 'string' || !outcome.reason) throw new Error('Invalid quality terminal outcome');
      const outcomeKey = JSON.stringify([identity, outcome.outcome, outcome.reason, outcome.at]);
      if (before && (before.identity !== identity || before.terminal && before.terminal !== outcomeKey)) throw new Error('Quality terminal outcome changed');
      if (artifacts.has(outcome.id)) throw new Error('Terminal quality artifact reappeared');
      terminal.add(outcome.id);
      this.#remember(outcome.id, { ...before, identity, terminal: outcomeKey });
    }
    let cargoBytes = 0, spriteBytes = 0;
    for (const scene of current) {
      const identity = this.#identity(scene), before = this.#seen.get(scene.id), owned = artifacts.get(scene.id);
      if (active.has(scene.id) || terminal.has(scene.id) || before?.terminal) throw new Error('Quality terminal scene reappeared or has duplicate ownership');
      active.add(scene.id);
      if (actors.has(scene.actorId)) throw new Error('Quality actor has concurrent owners');
      actors.add(scene.actorId);
      if (!owned || owned.pageNumber !== scene.pageNumber || owned.imageId !== scene.imageId) throw new Error('Quality artifact source binding is missing or different');
      const plans = (robots.deliveryPlans ?? []).filter(plan => plan.id === scene.planId);
      const crops = plans.length === 1 ? plans[0].crops.filter(crop => crop.id === scene.cropId) : [];
      const crop = crops[0], geometry = crop?.geometry;
      if (plans.length !== 1 || crops.length !== 1 || plans[0].committed !== true || plans[0].pageNumber !== scene.pageNumber
        || geometry.imageId !== scene.imageId || JSON.stringify(geometry.imageIds) !== JSON.stringify(scene.imageIds)
        || ['x', 'y', 'width', 'height'].some(key => geometry[key] !== scene.target[key])) throw new Error('Quality scene differs from its committed crop');
      if (!['cargo', 'page'].includes(scene.location) || !['waiting-visible', 'wiping'].includes(scene.state)
        || scene.sharpKind !== (scene.location === 'cargo' ? 'cargo-copy' : 'native-page')
        || !Number.isFinite(scene.deadline) || !Number.isFinite(scene.phase) || scene.phase < 0 || scene.phase > 1
        || scene.state === 'wiping' && (!Number.isFinite(scene.startedAt) || scene.startedAt >= scene.deadline)
        || scene.state === 'waiting-visible' && (scene.startedAt !== undefined || scene.phase !== 0)) throw new Error('Invalid quality phase or deadline');
      if (scene.location === 'cargo') {
        const payloads = (robots.pages ?? []).flatMap(page => page.page === scene.pageNumber ? page.payloads : [])
          .filter(payload => payload.id === scene.associatedPayloadId);
        if (!Number.isSafeInteger(scene.associatedPayloadId) || scene.associatedPayloadId < 1 || payloads.length !== 1
          || payloads[0].deposited || payloads[0].rasterWidth <= 0 || crop.payloadId !== scene.associatedPayloadId) throw new Error('Quality cargo association has no live payload');
      }
      for (const page of robots.pages ?? []) for (const payload of page.payloads) {
        if (payload.helpers?.includes(scene.actorId)) throw new Error('Quality actor also owns a payload');
      }
      for (const kind of ['coarse', 'sharp']) {
        const width = scene[kind + 'Width'], height = scene[kind + 'Height'], bytes = scene[kind + 'Bytes'];
        if (kind === 'sharp' && scene.sharpKind === 'native-page') {
          if (width !== 0 || height !== 0 || bytes !== 0 || owned.sharp) throw new Error('Native-page quality retained a sharp-copy artifact');
          continue;
        }
        if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1
          || !Number.isSafeInteger(bytes) || bytes !== width * height * 4
          || owned[kind]?.width !== width || owned[kind]?.height !== height) throw new Error('Quality raster ownership or byte accounting differs');
        cargoBytes += bytes;
      }
      if (!Number.isSafeInteger(scene.spriteBytes) || scene.spriteBytes < 1
        || !Number.isSafeInteger(owned.cleaner?.width) || owned.cleaner.width < 1
        || !Number.isSafeInteger(owned.cleaner?.height) || owned.cleaner.height < 1
        || owned.cleaner.width * owned.cleaner.height * 4 !== scene.spriteBytes) throw new Error('Quality cleaner ownership or byte accounting differs');
      spriteBytes += scene.spriteBytes;
      if (before && (before.identity !== identity || before.deadline !== scene.deadline
        || before.location === 'page' && scene.location !== 'page'
        || before.location === 'cargo' && scene.location === 'cargo' && before.associatedPayloadId !== scene.associatedPayloadId
        || before.startedAt !== undefined && scene.startedAt !== before.startedAt || scene.phase < before.phase)) throw new Error('Continuing quality identity, deadline or progress changed');
      this.#remember(scene.id, { identity, deadline: scene.deadline, location: scene.location,
        associatedPayloadId: scene.associatedPayloadId, startedAt: scene.startedAt, phase: scene.phase });
    }
    if (artifacts.size !== active.size || cargoBytes > (robots.cargoBytes ?? 0) || spriteBytes > (robots.spriteBytes ?? 0)) throw new Error('Quality scene inventory or budget is incomplete');
    for (const [id, before] of this.#seen) {
      if (!before.terminal && !active.has(id)) throw new Error('Missing quality terminal outcome for scene ' + id);
    }
  }
}

export class PayloadObservations {
  #seen = new Map();
  #helperOwners = new Map();
  #quality = new QualityObservations();
  #historical;
  constructor({ historical = false } = {}) { this.#historical = historical; }

  observe(sample) {
    const counts = ownershipCounts(sample.payloadArtifacts);
    this.#quality.observe(sample);
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
