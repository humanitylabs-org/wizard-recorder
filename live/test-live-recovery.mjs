// Exact production provider/session fault injection; synthetic PCM only, no network/storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
const source=fs.readFileSync(process.env.QA_PROVIDER_SOURCE||new URL('./provider.js',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
class Wire extends EventEmitter {
  constructor(){super();this.socket=new EventEmitter();this.frames=[];this.closes=0;}
  send(f){this.frames.push(f);}
  close(){this.closes++;this.socket.emit('close',1000,Buffer.from('synthetic close'));}
}
function providerFixture(){
  const wires=[],errors=[],completed=[];
  const client={async realtime(){const w=new Wire();wires.push(w);return w;}};
  const Transcriber=vm.runInNewContext(source.slice(source.indexOf('class NativeRealtimeTranscriber {'))+'\nNativeRealtimeTranscriber',{Buffer,setTimeout,clearTimeout,Error,Set});
  const make=handlers=>new Transcriber(client,'voxtral-mini-4b-realtime',handlers);
  const p=make({delta(){},completed:t=>completed.push(t),error:e=>errors.push(e)});
  return {wires,errors,completed,p,make,async open(){await p.open();wires.at(-1).emit('session.created',{});}};
}
const tick=()=>new Promise(r=>setImmediate(r));
for(const phase of ['before-created','during-audio','awaiting-final'])test(`unexpected transport close is terminal exactly once: ${phase}`,async()=>{
  const f=providerFixture();await f.p.open();const w=f.wires[0];
  if(phase!=='before-created'){w.emit('session.created',{});f.p.append(Buffer.alloc(8000));}
  if(phase==='awaiting-final')f.p.commit();
  w.socket.emit('close',1006,Buffer.alloc(0));
  assert.equal(f.errors.length,1,'closed SDK socket must notify LiveSession so it can reconnect');
  assert.equal(f.p.closed,true);assert.equal(f.p.pending.length,0);
  w.socket.emit('close',1006,Buffer.alloc(0));assert.equal(f.errors.length,1);
});
test('normal final rotation and intentional empty close are not failures',async()=>{
  const f=providerFixture();await f.open();const first=f.wires[0];f.p.append(Buffer.alloc(8000));f.p.commit();
  f.p.append(Buffer.alloc(8000));first.emit('transcription.done',{text:'Synthetic fixture only'});await tick();
  assert.equal(f.wires.length,2);const second=f.wires[1];second.emit('session.created',{});
  first.socket.emit('close',1000,Buffer.alloc(0));assert.equal(f.p.stream,second);assert.equal(f.errors.length,0);
  second.emit('transcription.done',{text:'Synthetic fixture only'});await f.p.close();assert.equal(f.errors.length,0);
  const empty=providerFixture();await empty.open();await empty.p.close();assert.equal(empty.errors.length,0);
});
test('real LiveSession recovers after silent SDK transport close with buffered PCM',async()=>{
  const f=providerFixture(),messages=[],timeouts=[],intervals=new Set();let current;
  const provider={async openRealtime(handlers){current=f.make(handlers);await current.open();return current.api();}};
  const ctx={provider,Buffer,Date,Math,Number,String,Set,Map,Promise,state:{threads:{}},sockets:new Map(),asksFor:()=>[],publicAsk:x=>x,publicSummary:x=>x,summaryFor:()=>null,startSummaries(){},stopSummaries(){},freezeLiveSummary:()=>false,save(){},logEvent(){},safeClose:s=>{Promise.resolve(s?.close()).catch(()=>{});},COMMIT_MS:6000,
    setTimeout:(fn,ms)=>{const t={fn,ms};timeouts.push(t);return t;},clearTimeout:t=>{if(t)t.cancelled=true;},setInterval:fn=>{intervals.add(fn);return fn;},clearInterval:fn=>intervals.delete(fn)};
  const start=server.indexOf('class LiveSession {'),end=server.indexOf('// ───────────── HTTP:',start);
  const LiveSession=vm.runInNewContext(server.slice(start,end)+'\nLiveSession',ctx);
  const session=new LiveSession({readyState:1,send:s=>messages.push(JSON.parse(s))});
  await session.start({meetingId:'synthetic_recovery',follow:false});f.wires[0].emit('session.created',{});
  session.audio(Buffer.alloc(8000));f.wires[0].socket.emit('close',1006,Buffer.alloc(0));
  assert.equal(messages.filter(m=>m.type==='status'&&!m.live).length,1,'provider close must surface reconnecting');
  assert.equal(session.stream,null);session.audio(Buffer.alloc(8000,1));assert.equal(session.earlyBytes,8000);
  const retry=timeouts.find(t=>t.ms===2000&&!t.cancelled);assert(retry);retry.fn();await tick();
  assert.equal(f.wires.length,2);f.wires[1].emit('session.created',{});
  assert.equal(session.earlyBytes,0);assert.equal(session.audioBytes,16000);assert.equal(messages.at(-1).live,true);
  f.wires[1].emit('transcription.delta',{delta:'Synthetic recovery'});f.wires[1].emit('transcription.done',{text:'Synthetic recovery'});
  assert(messages.some(m=>m.type==='settled'&&m.text==='Synthetic recovery'));session.close();
});
