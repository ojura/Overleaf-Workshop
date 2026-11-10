import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedDeliveryComplete } from './scene-ready.mjs';
const active={planId:1,cropId:0,page:102,payload:{id:5}};
const state=()=>({robots:{deliveryPlans:[{id:1,pageNumber:102,committed:true,crops:[{id:0,payloadId:5,state:'delivered'}]}]}});
test('selected terminal evidence is exact and unique',()=>{assert.equal(selectedDeliveryComplete(active,state()),true);});
for(const [name,mutate] of [
 ['missing',s=>s.robots.deliveryPlans=[]],['wrong payload',s=>s.robots.deliveryPlans[0].crops[0].payloadId=6],
 ['wrong page',s=>s.robots.deliveryPlans[0].pageNumber=103],['uncommitted',s=>s.robots.deliveryPlans[0].committed=false],
 ['duplicate',s=>s.robots.deliveryPlans.push(structuredClone(s.robots.deliveryPlans[0]))],
])test('rejects selected terminal '+name,()=>{const s=state();mutate(s);assert.equal(selectedDeliveryComplete(active,s),false);});
