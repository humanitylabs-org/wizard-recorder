import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(process.env.MIZEL_APP_SOURCE || new URL('./web/app.js',import.meta.url),'utf8');
const slice=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i);assert(i>=0&&j>i,a);return source.slice(i,j)};
function fixture({start, pending=async()=>[], current=()=>null}={}) {
 const calls=[],holds=new Set(),state={current:{id:'synthetic',title:'Synthetic',status:'recording'},rec:null};
 const ctx={state,WizardApp:{capture:{current,pending},update:{hold(reason){holds.add(reason);return {release(){calls.push('release');holds.delete(reason)}}}}},
  deletingMeetings:new Set(),prefs:{},live:{start(){},stop(){}},els:{notepad:{hidden:true},docPane:{dataset:{}}},mobileMQ:{matches:false},
  discardWarm(){calls.push('release-warm')},setCurrent(v){state.current=v},isImported:()=>false,navigate(){calls.push('navigate')},
  setInterval:()=>1,clearInterval(){},clearTimeout(){},document:{querySelector:()=>null},errMsg:e=>e.message,
  SharedMeeting:class {constructor(){this.uploader={pending:0};this.sent=new Set();this.finalSeq={};this.detach=()=>calls.push('detach');this.abort=()=>calls.push('FORBIDDEN abort');this.stop=()=>{calls.push('stop');return {meta:{}}};this.acknowledge=()=>calls.push('ack');this.uploader.drain=async()=>{};}async start(){if(start)await start(this);else throw Error('Synthetic permission rejection')}},
  API:{stop:async()=>({id:'synthetic'})},loadMeeting:async()=>{},loadMeetings(){},toast(){},retryRecording(){}};
 for(const n of ['renderDoc','renderRecBanner','renderPill','renderAskBar','renderHeader','tickPillClock','schedulePoll','notifyNative','showParticipantsHint'])ctx[n]=()=>{};
 vm.createContext(ctx);
 vm.runInContext(slice('async function clearEmptyFailedStart(', '// A recording left paused')+slice('function recordingSaveFailed(', 'async function finishStop(')+slice('function endRecSession()', 'const BAR_SHAPE =')+';globalThis.x={beginRecording,stopRecording,clearEmptyFailedStart};',ctx);
 const unloadLine=source.split('\n').find(line=>line.includes("window.addEventListener('beforeunload'"));assert(unloadLine);
 ctx.window={addEventListener:(_name,fn)=>ctx.unload=fn};ctx.flushNotes=()=>calls.push('flush-notes');vm.runInContext(unloadLine,ctx);
 return {ctx,state,calls,holds,x:ctx.x};
}
test('failed empty Start holds synchronously, then releases only its own hold; Stop clears the error UI',async()=>{
 let reject;const f=fixture({start:()=>new Promise((_,r)=>reject=r)});
 const work=f.x.beginRecording();assert(f.holds.has('Mizel recording'));assert.equal(f.state.rec.phase,'starting');
 reject(Error('Permission denied'));await work;assert.equal(f.holds.size,0);assert.equal(f.state.rec.phase,'error');assert.equal(f.state.rec.engine,null);
 await f.x.stopRecording();assert.equal(f.state.rec,null);assert(!f.calls.includes('FORBIDDEN abort'));assert(!f.calls.includes('ack'));assert(!f.calls.includes('stop'));
});
for(const retained of ['captureId','session','result','queued','running','sent','finalSeq'])test(`Start rejection retains ${retained}, hold and exact engine without cancel/ack`,async()=>{
 let engine;const f=fixture({start:async e=>{engine=e;if(retained==='queued')e.uploader.pending=1;else if(retained==='running')e.uploader.running=true;else if(retained==='sent')e.sent.add('me:0');else if(retained==='finalSeq')e.finalSeq.me=0;else e[retained]=retained==='captureId'?'original-capture':{};throw Error('Late setup failure')}});
 await f.x.beginRecording();assert.equal(f.state.rec.engine,engine);assert(f.holds.has('Mizel recording'));assert.equal(f.state.rec.phase,'error');assert(!f.calls.includes('FORBIDDEN abort'));assert(!f.calls.includes('ack'));assert(!f.calls.includes('stop'));
});
for(const reason of ['pending','recoverable','unknown','current'])test(`failed Start keeps ownership when shared custody is ${reason}`,async()=>{
 const row={id:'retained',status:reason};const f=fixture({current:()=>reason==='current'?row:null,pending:async()=>{if(reason==='unknown')throw Error('Native status unknown');return [row]}});
 await f.x.beginRecording();const engine=f.state.rec.engine;assert(engine);assert(f.holds.has('Mizel recording'));await f.x.stopRecording();assert.equal(f.state.rec.engine,engine);assert(f.holds.has('Mizel recording'));assert(!f.calls.includes('ack'));
});
test('failed-start proof cannot release a replacement controller or a newly active take',async()=>{
 for(const replace of [true,false]) {let release,current=null;const f=fixture({current:()=>current,pending:()=>new Promise(r=>release=r)});
    const work=f.x.beginRecording();for(let i=0;i<12&&!release;i++)await Promise.resolve();assert(release);
 const original=f.state.rec;if(replace)f.state.rec={phase:'recording',engine:{captureId:'new'}};else current={id:'new'};
 release([]);await work;assert(f.holds.has('Mizel recording'));assert(!f.calls.includes('release'));if(!replace)assert.equal(f.state.rec,original);
 }
});
test('standalone unload protects retained or unknown error audio; only positively empty Start permits leaving',async()=>{
 for(const retained of [true,false]) {
  const f=fixture({start:async e=>{if(retained)e.session={};throw Error('Denied')}});await f.x.beginRecording();
  let blocked=false;f.ctx.unload({preventDefault(){blocked=true}});assert.equal(blocked,retained);assert.equal(f.calls.includes('flush-notes'),!retained);
 }
 const f=fixture();f.state.rec={phase:'error',engine:null};let blocked=false;f.ctx.unload({preventDefault(){blocked=true}});assert.equal(blocked,true);
});
test('empty error can retry Start; a retained error cannot replace its original take',async()=>{
 let attempt=0;const f=fixture({start:async()=>{attempt++;if(attempt===1)throw Error('Denied')}});await f.x.beginRecording();await f.x.beginRecording();assert.equal(attempt,2);assert.equal(f.state.rec.phase,'recording');assert(f.holds.has('Mizel recording'));
 const g=fixture({pending:async()=>[{id:'original'}]});await g.x.beginRecording();const old=g.state.rec;await g.x.beginRecording();assert.equal(g.state.rec,old);assert(!g.calls.includes('release'));
});
