import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./web/app.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('const AGENT_NAMES ='),source.indexOf('const agentName ='));
async function registry(agents){
  const writes=[];
  const context={Date,window:{},els:{},fetch:async()=>({ok:true,json:async()=>({agents})}),api:async(p,opts)=>{if(opts)writes.push({p,...opts});return {agents:[],deviceOnly:true};}};
  vm.createContext(context);
  const result=await vm.runInContext('(async()=>{'+body+';return {list:await wizardAgents(),default:DEFAULT_AGENT,deviceOnly:agentList.deviceOnly};})()',context);
  return {result,writes};
}
test('installed private agent is the optional default, regardless of id or label',async()=>{
  const {result,writes}=await registry([{id:'owner-primary',label:'Guide',privacy:'standard',is_default:true},{id:'owner-secret',label:'My confidential helper',privacy:'private'}]);
  assert.equal(result.default,'owner-secret');assert.equal(result.list[0].label,'My confidential helper');assert.equal(writes[0].json.agent,'owner-secret');assert.equal(result.deviceOnly,true);
});
test('no installed private agent means no invented private destination',async()=>{
  const {result}=await registry([{id:'owner-primary',label:'Guide',privacy:'standard'}]);assert.equal(result.default,'none');assert.deepEqual(Array.from(result.list,a=>a.id),['owner-primary']);
});
test('stopped, removed and recovery agents cannot become the private default',async()=>{
  const {result}=await registry([{id:'old',privacy:'private',status:'stopped'},{id:'removed',privacy:'private',status:'removed'},{id:'recovery',privacy:'private',role:'recovery'}]);assert.equal(result.default,'none');assert.equal(result.list.length,0);
});
