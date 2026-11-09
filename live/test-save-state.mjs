import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(process.env.MIZEL_APP_SOURCE || new URL('./web/app.js',import.meta.url),'utf8');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b));
function fixture(){
 const notices=[],toasts=[],calls=[];
 const meeting={id:'original',status:'ready',jobs:{},audio:{tracks:[]}};
 const engine={result:{id:'original-capture',streamChunks:[],meta:{}},finalSeq:{},uploader:{async drain(){}},async stop(){calls.push('stop');return this.result;},async acknowledge(){calls.push('ack');throw Error('Local acknowledgement unavailable');}};
 const state={current:meeting,rec:{meetingId:meeting.id,engine,phase:'recording'},segPending:3};
 const c={document:{querySelector:()=>null},navigator:{onLine:false},fetch:async()=>new Response(JSON.stringify(meeting)),Response,Error,TypeError,console,setTimeout,clearTimeout,Date,encodeURIComponent,enc:encodeURIComponent,state,pendingAutostart:null,els:{docStatus:{}},pluralize:(n,s)=>`${n} ${s}`,h:(tag,attrs,...children)=>({tag,...attrs,children}),replace:(_,...kids)=>{notices.splice(0,notices.length,...kids.flat());},toast:(...args)=>toasts.push(args),live:{stop(){}},setCurrent:m=>{state.current=m;},endRecSession:()=>{state.rec=null;},loadMeeting:async()=>{},loadMeetings:()=>{},finishWithoutAudio:()=>{},retryRecording:()=>{}};
 for(const n of ['renderPill','renderAskBar','renderDoc','renderRecBanner','schedulePoll'])c[n]=()=>{};
 vm.createContext(c);
 vm.runInContext(slice('const errMsg =','// ───────────────────────── 3.')+slice('let stoppedHere =','function renderToolbar')+slice(source.includes('function recordingSaveFailed(') ? 'function recordingSaveFailed(' : 'async function stopRecording(','async function finishStop(')+'\nglobalThis.x={api,errMsg,renderStatus,stopRecording,API};',c);
 return {c,state,engine,calls,notices,toasts,x:c.x};
}
const text=nodes=>JSON.stringify(nodes);
test('false browser offline does not overwrite projection or local acknowledgement error',()=>{const f=fixture();assert.equal(f.x.errMsg(Error('Linked events mismatch')),'Linked events mismatch');});
test('successful request with onLine=false has no offline notice',async()=>{const f=fixture();await f.x.api('api/meetings/original');f.x.renderStatus(f.state.current);assert.doesNotMatch(text(f.notices),/offline/i);});
test('HTTP and transport errors remain distinguishable with original status/cause',async()=>{const f=fixture();f.c.fetch=async()=>new Response('{"error":"storage unavailable"}',{status:503});await assert.rejects(f.x.api('api/save'),e=>e.status===503&&/storage unavailable/.test(e.message));f.c.fetch=async()=>{throw TypeError('Failed to fetch');};await assert.rejects(f.x.api('api/save'),e=>e.code==='transport_unavailable'&&e.cause.message==='Failed to fetch');});
test('stopped capture acknowledgement failure is one notice and no End meeting; retry retains original',async()=>{const f=fixture();await f.x.stopRecording();assert.equal(f.state.rec.engine,f.engine);assert.equal(f.state.rec.phase,'error');f.x.renderStatus(f.state.current);assert.equal(f.notices.length,1);assert.equal(f.toasts.length,0);assert.doesNotMatch(text(f.notices),/End meeting/);assert.match(text(f.notices),/Local acknowledgement unavailable/);f.engine.acknowledge=async()=>f.calls.push('ack-success');await f.x.stopRecording();assert.equal(f.state.rec,null);assert.ok(f.calls.includes('ack-success'));});
test('terminal status never uses stale segment pending fallback',()=>{assert.match(source,/const pending = active \?/);});

function custodyFixture({failure}={}) {
 const f=fixture(); let ack=0;
 const wav=Buffer.alloc(76);wav.write('RIFF');wav.writeUInt32LE(68,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32,40);
 const marker={id:'marker',captureId:'capture',atMediaMs:1,voiceTakeId:'voice',endedAt:'ended'};
 f.c.fetch=async path=>{
  if(path.includes('audio.wav')){if(failure==='audio-http')return new Response('',{status:503});const b=Buffer.from(wav);if(failure==='pcm')b.writeInt16LE(7,44);return new Response(b);}
  if(path.includes('orb-events'))return new Response(JSON.stringify({events:failure==='marker'?[]:[marker]}));
  return new Response(JSON.stringify({id:'original',status:failure==='stop'?'recording':'ready',jobs:{},audio:{tracks:[{source:'me',chunks:failure==='chunks'?0:1}]}}));
 };
 Object.assign(f.c,{Uploader:class{},WizardApp:{capture:{async ack(id){assert.equal(id,'capture');ack++;}}},sessionStorage:{getItem(){return null;}},Blob});
 vm.runInContext(slice('class SharedMeeting {','const PARTICIPANTS_HINT =')+'\nglobalThis.Engine=SharedMeeting;',f.c);
 const engine=new f.c.Engine('original',{});engine.captureId='capture';engine.finalSeq={me:0};engine.result={id:'capture',streamChunks:[{source:'me',seq:0,startMs:0,durationMs:1,blob:new Blob([wav])}],meta:{handoffs:[marker]}};
 return {...f,engine,ack:()=>ack};
}
for(const failure of ['stop','chunks','audio-http','pcm','marker'])test(`durable acknowledgement blocked by ${failure}; original retained`,async()=>{const f=custodyFixture({failure});const original=f.engine.result;await assert.rejects(f.engine.acknowledge());assert.equal(f.ack(),0);assert.equal(f.engine.result,original);assert.equal(f.engine.captureId,'capture');if(failure!=='stop')assert.equal(f.state.current.status,'ready');});
test('false offline permits ack only after canonical stop, exact PCM and all original marker identities',async()=>{const f=custodyFixture();await f.engine.acknowledge();assert.equal(f.ack(),1);});
