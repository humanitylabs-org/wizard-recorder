import {test,after} from 'node:test';
import assert from 'node:assert/strict';
for(const key of ['WIZARD_ROUTER_URL','WIZARD_ROUTER_GRANT','WIZARD_DELIVERY_URL','WIZARD_DELIVERY_TOKEN','RECORDER_ORB_EVENTS'])delete process.env[key];
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fixtureData=fs.mkdtempSync(path.join(os.tmpdir(),'recorder-portable-'));
process.env.RECORDER_VIEW_DATA=fixtureData;
const {capabilities,server}=await import('./server.mjs');
after(()=>fs.rmSync(fixtureData,{recursive:true,force:true}));

await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
after(()=>new Promise(resolve=>server.close(resolve)));
const base='http://127.0.0.1:'+server.address().port;

test('standalone has no optional dependency or agent configuration',()=>{
  assert.deepEqual(capabilities({}),{realtime:false,summaries:false,agent:false,orb:false});
  assert.equal(capabilities({WIZARD_DELIVERY_URL:'http://bound'}).agent,false);
  assert.equal(capabilities({WIZARD_ROUTER_URL:'http://router'}).summaries,false);
  assert.equal(capabilities({WIZARD_ROUTER_GRANT:'fixture'}).realtime,false);
  assert.equal(capabilities({WIZARD_ROUTER_URL:'http://router',WIZARD_ROUTER_GRANT:'fixture'}).realtime,true);
  assert.equal(capabilities({WIZARD_DELIVERY_URL:'http://bound',WIZARD_DELIVERY_TOKEN:'fixture'}).agent,true);
  assert.equal(capabilities({WIZARD_ROUTER_URL:'http://router',WIZARD_ROUTER_GRANT:'fixture'}).summaries,true);
});
test('view and shared facade are owned by this image under its app path',async()=>{
  const r=await fetch(base+'/wizard-recorder/');assert.equal(r.status,200);
  const html=await r.text();assert.match(html,/data-app="wizard-recorder"/);assert.match(html,/>Recorder</);
  assert.doesNotMatch(html,/src="\/wizard-os-home/);
  for(const name of ['core/app-client.js','core/app-capture.js','styles.css','capabilities.js'])assert.equal((await fetch(base+'/wizard-recorder/'+name)).status,200);
  const caps=await (await fetch(base+'/wizard-recorder/capabilities.js')).text();assert.match(caps,/"realtime":false/);
});
test('device-only manual ask sends no ambient context and persists answer without a server agent credential',async()=>{
  const response=await fetch(base+'/wizard-recorder/manual-ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({meetingId:'fixture-meeting',text:'Only this explicit question',agent:'owner-guide',agentLabel:'My guide',device:true,context:'MUST NOT LEAVE',transcript:'MUST NOT LEAVE',title:'PRIVATE TITLE'})});
  assert.equal(response.status,202);const {ask}=await response.json();assert.equal(ask.via,'device');assert.equal(ask.text,'Only this explicit question');assert.equal(ask.status,'working');
  const stored=JSON.parse(fs.readFileSync(path.join(fixtureData,'state.json'))).asks[ask.id];assert.equal(stored.context,'');assert.equal(stored.title,'Manual ask');
  const result=await fetch(base+'/wizard-recorder/manual-ask/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({askId:ask.id,threadId:'fixture-thread',runId:'fixture-run',status:'answered',answer:'Fixture answer'})});
  assert.equal(result.status,200);assert.equal((await result.json()).ask.answer,'Fixture answer');
  const conflict=await fetch(base+'/wizard-recorder/manual-ask/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({askId:ask.id,threadId:'different-thread'})});assert.equal(conflict.status,409);
});
test('orb projection is off and cross-origin mutation is refused',async()=>{
  assert.equal((await fetch(base+'/wizard-recorder/orb-events')).status,404);
  assert.equal((await fetch(base+'/wizard-recorder/api/meetings',{method:'POST',headers:{Origin:'https://foreign.invalid'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/wizard-recorder/api/meetings',{method:'POST',headers:{'Sec-Fetch-Site':'cross-site'},body:'{}'})).status,403);
});
