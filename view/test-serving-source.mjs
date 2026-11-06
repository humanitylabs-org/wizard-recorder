import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {TinfoilProvider} from './provider.js';
import {RouterModels} from './router-models.js';
import {ownerIdentityPrompt,noAttributionPrompt} from './owner-identity.mjs';
import {transcriptPacket} from './agent-router.mjs';
const source=fs.readFileSync(new URL('./web/app.js',import.meta.url),'utf8');

test('retained capture kind, native adapter and phone upload/journal compatibility',()=>{
  assert.match(source,/capture\.start\(\{ kind:'meeting'/);
  const capture=fs.readFileSync(new URL('./web/core/app-capture.js',import.meta.url),'utf8');
  assert.match(capture,/wizard-meetings/);assert.ok(capture.includes('beginVoiceBorrow'));assert.ok(capture.includes('endVoiceBorrow'));
  const aliases=fs.readFileSync(new URL('../docs/cutover/native-aliases.caddy',import.meta.url),'utf8');
  assert.match(aliases,/\/meetings\/api\/\*/);assert.match(aliases,/\/mizel-live\/orb-events/);
});
test('all live recording affordances remain in the adopted view',()=>{
  for(const name of ['renderLive','summaryExpansionFor','retryRecording','stopRecording','syncAppOrb','renderRoute'])assert.ok(source.includes(name),name);
  assert.ok(source.includes('Recorder recording'));assert.ok(source.includes('Keep this recording in Recorder only'));assert.ok(source.includes('New recording'));assert.ok(source.includes('Recording capture or durable task save'));
  assert.match(source,/WizardApp\.ready\(\{ name: 'Recorder'/);
  assert.doesNotMatch(source,/'Added by Mizel'|'Mizel recording'|'Mizel recorder'/);
});
test('identity prompt and no-attribution rule survive all summary routes',()=>{
  assert.match(ownerIdentityPrompt({MEETINGS_OWNER_NAME:'Fixture Owner'}),/Fixture Owner/);
  assert.match(noAttributionPrompt(),/cannot diarize/);
  for(const file of ['provider.js','router-models.js']){
    const code=fs.readFileSync(new URL(file,import.meta.url),'utf8');
    assert.ok(code.includes('ownerIdentityPrompt()'));assert.ok(code.includes('noAttributionPrompt()'));
  }
  const packet=transcriptPacket({meeting:{title:'Fixture',segments:[]},agentLabel:'Fixture agent'});
  assert.match(packet.text,/Recording owner:/);assert.match(packet.text,/Sent from Recorder/);
});
test('Tinfoil refresh re-attests once per minute and preserves injected clients',()=>{
  const clock=mock.method(Date,'now',()=>200000);
  try {
    const provider=new TinfoilProvider('synthetic-not-a-credential');
    const original=provider.client;
    assert.equal(provider.refresh(new Error('TLS pinning failed')),true);assert.notEqual(provider.client,original);
    const refreshed=provider.client;
    assert.equal(provider.refresh(new Error('Connection error')),false);assert.equal(provider.client,refreshed);
    clock.mock.mockImplementation(()=>260001);
    assert.equal(provider.refresh(new Error('outer',{cause:new Error('attestation failed')})),true);
    assert.equal(provider.refresh(new Error('ordinary input error')),false);
    const injected={};const fixture=new TinfoilProvider('synthetic',injected);
    assert.equal(fixture.refresh(new Error('TLS pinning failed')),false);assert.equal(fixture.client,injected);
  } finally {clock.mock.restore();}
});
test('summary refresh retries once, ordinary errors do not retry',async()=>{
  const provider=new TinfoilProvider('synthetic',{});let attempts=0,refreshes=0;
  provider.summarizeOnce=async()=>{if(++attempts===1)throw Error('TLS pinning failed');return {title:'Fixture'};};
  provider.refresh=()=>{refreshes++;return true;};
  assert.deepEqual(await provider.summarize({}),{title:'Fixture'});assert.equal(attempts,2);assert.equal(refreshes,1);
  provider.refresh=()=>false;provider.summarizeOnce=async()=>{throw Error('invalid input');};
  await assert.rejects(provider.summarize({}),/invalid input/);
});
test('realtime startup error reaches retained refresh hook',async()=>{
  const provider=new TinfoilProvider('synthetic',{realtime:async()=>{throw Error('TLS pinning failed');}});
  let refreshed=0;provider.refresh=()=>{refreshed++;return false;};
  await assert.rejects(provider.openRealtime({error:()=>{}}),/connection failed/);assert.ok(refreshed>0);
});

for(const owner of ['Fixture Owner','',undefined])test(`captured live prompts retain configured owner and no attribution: ${String(owner)}`,async()=>{
 const previous=process.env.MEETINGS_OWNER_NAME;
 try {
  if(owner===undefined)delete process.env.MEETINGS_OWNER_NAME;else process.env.MEETINGS_OWNER_NAME=owner;
  const expected=owner||'the device owner';let request;
  const delta={topicChanged:true,title:'Fixture topic',newBullets:[{text:'Fixture point',atMs:0}]};
  const input={transcript:[{startMs:0,endMs:1000,speaker:'Me',text:'Fixture point'}]};
  const provider=new TinfoilProvider('synthetic',{chat:{completions:{create:async r=>{request=r;return {choices:[{message:{content:JSON.stringify(delta)}}]};}}}});
  await provider.summarize(input);
  assert.ok(request.messages[0].content.includes(`Recording owner: ${expected}`));
  assert.ok(request.messages[0].content.includes('cannot diarize'));
  const router=new RouterModels('http://fixture','synthetic');
  router.run=async(_feature,r)=>{request=r;return {text:JSON.stringify(delta),provenance:{}};};
  await router.summarize(input);
  assert.ok(request.system.includes(`Recording owner: ${expected}`));
  assert.ok(request.system.includes('cannot diarize'));
 } finally {if(previous===undefined)delete process.env.MEETINGS_OWNER_NAME;else process.env.MEETINGS_OWNER_NAME=previous;}
});
