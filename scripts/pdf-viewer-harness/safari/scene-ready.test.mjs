import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneReady, selectedDeliveryComplete } from './scene-ready.mjs';
const active={planId:1,cropId:0,page:102,payload:{id:5}};
const state=()=>({robots:{deliveryPlans:[{id:1,pageNumber:102,committed:true,crops:[{id:0,payloadId:5,state:'delivered'}]}]}});
test('selected terminal evidence is exact and unique',()=>{assert.equal(selectedDeliveryComplete(active,state()),true);});
for(const [name,mutate] of [
 ['missing',s=>s.robots.deliveryPlans=[]],['wrong payload',s=>s.robots.deliveryPlans[0].crops[0].payloadId=6],
 ['wrong page',s=>s.robots.deliveryPlans[0].pageNumber=103],['uncommitted',s=>s.robots.deliveryPlans[0].committed=false],
 ['duplicate',s=>s.robots.deliveryPlans.push(structuredClone(s.robots.deliveryPlans[0]))],
])test('rejects selected terminal '+name,()=>{const s=state();mutate(s);assert.equal(selectedDeliveryComplete(active,s),false);});

test('independent quality ownership blocks navigation even after delivery is idle', () => {
  const ready = {
    documentVisible: true, prefetchIdle: true, missing: [], pending: [],
    canvases: [{ state: 3, native: { connected: true, width: 100, height: 100,
      rect: { width: 100, height: 100 }, computed: { display: 'block', visibility: 'visible' } } }],
    robots: { activeActors: 0, activePayloads: 0, retainedBytes: 0, activeQualityReactions: 0, qualityReactions: [] },
    payloadArtifacts: { plans: [], quality: [] }, effectNodes: {}, source: {}, raw: {},
  };
  assert.equal(sceneReady(ready), true);
  for (const mutate of [
    value => { value.robots.activeQualityReactions = 1; },
    value => { value.robots.qualityReactions = [{ id: 1 }]; },
    value => { value.payloadArtifacts.quality = [{ id: 1 }]; },
  ]) {
    const pending = structuredClone(ready); mutate(pending);
    assert.equal(sceneReady(pending), false);
  }
});
