import test from 'node:test';
import assert from 'node:assert/strict';
import { photoEvidence } from './photo-evidence.mjs';
import { PayloadObservations } from './payload-observation.mjs';
function fixture() {
  const region = {
    id: 'p102-i0',
    x: 0.15363461278489152,
    y: 0.18167260687596667,
    width: 0.6927310649875916,
    height: 0.2579931859417286,
  };
  const target = {
    x: region.x,
    y: region.y,
    width: region.width / 2,
    height: region.height,
  };
  const payload = {
    id: 5,
    imageId: 'portion[p102-i0]:2:1:0:0',
    imageIds: [region.id],
    cropKind: 'portion',
    target,
    deadline: 22195.928377914242,
    helpers: [11],
    rasterWidth: 152,
    rasterHeight: 160,
    refinements: 3,
    refinementPending: false,
    arrivalCovered: true,
    operation: { key: 'synthetic-operation', memberIds: [11] },
    deposited: false,
  };
  const crop = {
    id: 0,
    payloadId: 5,
    state: 'active',
    geometry: {
      ...target,
      imageId: payload.imageId,
      imageIds: payload.imageIds,
      kind: 'portion',
    },
  };
  return {
    payload,
    robots: {
      deliveryPlans: [
        { id: 3, pageNumber: 102, committed: true, crops: [crop] },
      ],
    },
    page: { pageNumber: 102, imageRegions: [region] },
  };
}
const check = (f) => photoEvidence(f.payload, 102, f.robots, f.page);
test('captured physical portion is source-backed although logical key is not an atlas ID', () => {
  const f = fixture();
  assert.equal(
    f.page.imageRegions.some((r) => r.id === f.payload.imageId),
    false,
  );
  assert.deepEqual(check(f).photoRegions, f.page.imageRegions);
  assert.equal(check(f).planId, 3);
});
for (const [name, mutate] of [
  ['unknown source', (f) => { f.payload.imageIds = ['wrong']; f.robots.deliveryPlans[0].crops[0].geometry.imageIds = ['wrong']; }],
  ['duplicate source', (f) => f.payload.imageIds.push('p102-i0')],
  ['target drift', (f) => (f.payload.target = { ...f.payload.target, x: 0 })],
  ['wrong page', (f) => (f.page.pageNumber = 101)],
  ['wrong kind', (f) => (f.payload.cropKind = 'image')],
  ['missing plan', (f) => (f.robots.deliveryPlans = [])],
  [
    'non-grid portion',
    (f) => {
      f.payload.target.width *= 0.9;
      f.robots.deliveryPlans[0].crops[0].geometry.width =
        f.payload.target.width;
    },
  ],
])
  test('rejects ' + name, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => check(f));
  });
test('fallback is skipped', () => {
  const f = fixture();
  f.payload.imageIds = [];
  assert.equal(check(f), null);
});
test('current lifetime rejects carry changes but accepts empty return recruitment', () => {
  const f = fixture(),
    observer = new PayloadObservations();
  const sample = (p) => ({
    payloadArtifacts: {
      complete: true,
      unassigned: 0,
      payloads: [],
      plans: [],
    },
    robots: { ...f.robots, pages: [{ page: 102, payloads: [p] }] },
  });
  observer.observe(sample(f.payload));
  assert.throws(
    () => observer.observe(sample({ ...f.payload, helpers: [11, 12] })),
    /membership/,
  );
  observer.observe(
    sample({
      ...f.payload,
      helpers: [11, 12],
      deposited: true,
      stage: 'return',
      rasterWidth: 0,
      rasterHeight: 0,
      arrivalCovered: false,
    }),
  );
});
for (const rotation of [90, 180, 270])
  test('portion applies viewer rotation once: ' + rotation, () => {
    const f = fixture(),
      r = f.payload.target;
    const t =
      rotation === 90
        ? { x: 1 - r.y - r.height, y: r.x, width: r.height, height: r.width }
        : rotation === 180
          ? {
              x: 1 - r.x - r.width,
              y: 1 - r.y - r.height,
              width: r.width,
              height: r.height,
            }
          : { x: r.y, y: 1 - r.x - r.width, width: r.height, height: r.width };
    f.payload.target = t;
    Object.assign(f.robots.deliveryPlans[0].crops[0].geometry, t);
    assert.ok(photoEvidence(f.payload, 102, f.robots, f.page, rotation));
  });
test('collage validates all source placements and bounding rectangle', () => {
  const f = fixture();
  f.page.imageRegions = [
    { id: 'a', x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    { id: 'b', x: 0.3, y: 0.1, width: 0.2, height: 0.2 },
  ];
  Object.assign(f.payload, {
    imageId: 'opaque collage',
    imageIds: ['a', 'b'],
    cropKind: 'collage',
    target: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
  });
  f.robots.deliveryPlans[0].crops[0].geometry = {
    ...f.payload.target,
    imageId: f.payload.imageId,
    imageIds: f.payload.imageIds,
    kind: 'collage',
  };
  assert.equal(check(f).photoRegions.length, 2);
});
test('duplicate rectangle alias omitted by the producer does not require invented source IDs', () => {
  const f = fixture();
  f.page.imageRegions.push({ ...f.page.imageRegions[0], id: 'alias' });
  assert.ok(check(f));
  f.page.imageRegions.push({ ...f.page.imageRegions[0] });
  assert.throws(() => check(f), /ambiguous/);
});
test('retired, deposited, returning and fallback entries do not hide a later eligible photo', () => {
  const f = fixture();
  const candidates = [
    { rasterWidth: 0, rasterHeight: 0 },
    { deposited: true, rasterWidth: 10, rasterHeight: 10 },
    { stage: 'return', rasterWidth: 10, rasterHeight: 10 },
    { ...f.payload, imageIds: [] },
    f.payload,
  ];
  const evidence = [];
  for (const payload of candidates) {
    const result = photoEvidence(payload, 102, f.robots, f.page);
    if (result) evidence.push(result);
  }
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].cropId, 0);
});
for (const [name, mutate] of [
  ['tiny owner drift', f => f.payload.target = {...f.payload.target, x:f.payload.target.x+1e-13}],
  ['unsplit portion', f => {Object.assign(f.payload.target,f.page.imageRegions[0]);Object.assign(f.robots.deliveryPlans[0].crops[0].geometry,f.payload.target);}],
  ['unsafe grid', f => {f.payload.target.width=1e-20;f.robots.deliveryPlans[0].crops[0].geometry.width=1e-20;}],
  ['invalid raw source', f => f.page.imageRegions[0].x=-.1],
  ['invalid plan number', f => f.robots.deliveryPlans[0].id=0],
]) test('rejects reviewed '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>check(f));});
for (const duplicate of [true,false]) test('rejects collage '+(duplicate?'aliases':'overlap'),()=>{
 const f=fixture(),a={id:'a',x:.1,y:.1,width:.3,height:.3},b={...a,id:'b',x:duplicate?.1:.2};
 f.page.imageRegions=[a,b];Object.assign(f.payload,{imageIds:['a','b'],cropKind:'collage',target:{x:.1,y:.1,width:duplicate?.3:.4,height:.3}});
 f.robots.deliveryPlans[0].crops[0].geometry={...f.payload.target,imageId:f.payload.imageId,imageIds:f.payload.imageIds,kind:'collage'};assert.throws(()=>check(f));
});
test('rejects duplicate numeric crew IDs',()=>{
 const f=fixture();f.payload.helpers=[11,11];f.payload.operation.memberIds=[11,11];
 assert.throws(()=>new PayloadObservations().observe({payloadArtifacts:{complete:true,unassigned:0,payloads:[],plans:[]},robots:{...f.robots,pages:[{page:102,payloads:[f.payload]}]}}),/crew/);
});

for (const name of ['operation key', 'original members', 'source IDs', 'crop kind', 'plan identity']) test('freezes ' + name + ' across current samples', () => {
  const f = fixture(), observer = new PayloadObservations();
  const sample = () => ({payloadArtifacts:{complete:true,unassigned:0,payloads:[],plans:[]},robots:{...f.robots,pages:[{page:102,payloads:[structuredClone(f.payload)]}]}});
  observer.observe(sample());
  if (name === 'operation key') f.payload.operation.key = 'different';
  if (name === 'original members') { f.payload.operation.memberIds = [12]; f.payload.helpers = [12]; }
  if (name === 'source IDs') { f.payload.imageIds = ['different']; f.robots.deliveryPlans[0].crops[0].geometry.imageIds = ['different']; }
  if (name === 'crop kind') { f.payload.cropKind = 'image'; f.robots.deliveryPlans[0].crops[0].geometry.kind = 'image'; }
  if (name === 'plan identity') f.robots.deliveryPlans[0].id = 4;
  assert.throws(() => observer.observe(sample()));
});
