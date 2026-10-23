import {test,after} from 'node:test';
import assert from 'node:assert/strict';
for(const key of ['TINFOIL_API_KEY','WIZARD_ROUTER_URL','WIZARD_ROUTER_GRANT','MEETINGS_LLM_URL','MEETINGS_LLM_MODEL','WIZARD_DELIVERY_URL','WIZARD_DELIVERY_TOKEN','RECORDER_ORB_EVENTS'])delete process.env[key];
const {capabilities,server}=await import('./server.mjs');

await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
after(()=>new Promise(resolve=>server.close(resolve)));
const base='http://127.0.0.1:'+server.address().port;

test('standalone has no optional dependency or agent configuration',()=>{
  assert.deepEqual(capabilities({}),{realtime:false,summaries:false,agent:false,orb:false});
  assert.equal(capabilities({WIZARD_DELIVERY_URL:'http://bound'}).agent,false);
  assert.equal(capabilities({WIZARD_ROUTER_URL:'http://router'}).summaries,false);
  assert.equal(capabilities({MEETINGS_LLM_URL:'http://owner'}).summaries,false);
  assert.equal(capabilities({TINFOIL_API_KEY:'fixture'}).realtime,true);
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
test('orb projection is off and cross-origin mutation is refused',async()=>{
  assert.equal((await fetch(base+'/wizard-recorder/orb-events')).status,404);
  assert.equal((await fetch(base+'/wizard-recorder/api/meetings',{method:'POST',headers:{Origin:'https://foreign.invalid'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/wizard-recorder/api/meetings',{method:'POST',headers:{'Sec-Fetch-Site':'cross-site'},body:'{}'})).status,403);
});
