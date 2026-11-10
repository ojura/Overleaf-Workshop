import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadBrowserSource } from './browser-source.mjs';
const source=loadBrowserSource('sidecar-active.js');
const initial=source.slice(source.indexOf("    activePhase = 'initial saved scene';"),source.indexOf('    prefetch.setRobotsEnabled'));
const targets=source.slice(source.indexOf('    for (const target of targets)'),source.indexOf('    clearTimeout(activeTimer);\n    result.noContentAware'));
function fixture(pendingUntil=160){
 let now=0,current=46;const moves=[];
 const context={result:{entries:[]},activeDeadline:500,changed:false,activePhase:'',targets:[101,102],performance:{now:()=>now},guard(){},panel:()=>null,container:{dataset:{}},sleep:async ms=>{now+=ms;},sceneReady:state=>state.ready,sample:()=>({page:current,visible:[current],canvases:[{page:current}],ready:now>=pendingUntil,robots:{pages:[]}}),viewer:{scrollPageIntoView({pageNumber}){current=pageNumber;moves.push({page:current,at:now});}},recordFirstPixels(){},clearTimeout(){},activeTimer:1};
 return {context,moves};
}
test('actual initial block cannot leave a pending saved scene',async()=>{
 const f=fixture();await vm.runInNewContext('(async()=>{'+initial+'})()',f.context);assert.equal(f.context.performance.now(),160);
});
test('actual target loop cannot advance from a pending first target',async()=>{
 const f=fixture();await vm.runInNewContext('(async()=>{'+targets+'})()',f.context);assert.deepEqual(f.moves,[{page:101,at:0},{page:102,at:160}]);
});
test('actual initial and target deadlines identify incomplete scenes',async()=>{
 for(const block of [initial,targets]){const f=fixture(Infinity);await assert.rejects(vm.runInNewContext('(async()=>{'+block+'})()',f.context),/Incomplete .*scene/);assert.ok(f.moves.length<=1);}
});

test('trusted interruption on ready transition prevents initial mutations',async()=>{
 const f=fixture();let interrupted=false;
 f.context.sleep=async()=>{interrupted=true;f.context.sample=()=>({ready:true});};
 f.context.guard=()=>{if(interrupted)throw new Error('trusted input');};
 await assert.rejects(vm.runInNewContext('(async()=>{'+initial+'})()',f.context),/trusted input/);
 assert.equal(f.context.changed,false);assert.equal(f.moves.length,0);
});
test('second fully visible spread member may settle with first member indicator',async()=>{
 const f=fixture(0);f.context.targets=[102];f.context.sample=()=>({page:101,visible:[101,102],canvases:[{page:101},{page:102}],ready:true,robots:{pages:[]}});
 await vm.runInNewContext('(async()=>{'+targets+'})()',f.context);assert.equal(f.moves.length,1);
});
test('stale previous page cannot satisfy requested target readiness',async()=>{
 const f=fixture(0);f.context.sample=()=>({page:46,visible:[46],canvases:[{page:46}],ready:true,robots:{pages:[]}});
 await assert.rejects(vm.runInNewContext('(async()=>{'+targets+'})()',f.context),/Incomplete target scene/);assert.equal(f.moves.length,1);
});
