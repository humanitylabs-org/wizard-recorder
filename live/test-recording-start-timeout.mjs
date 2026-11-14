// Issue #16: a meeting start that never answers must not sit on "Starting…" for ever, and a late answer keeps its audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./web/app.js',import.meta.url),'utf8');
const slice=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a);assert(a>=0&&b>a,from);return source.slice(a,b);};
const code=[
  slice('const START_TIMEOUT_MS','// In-memory upload queue'),
  slice('function failedStartOwnsMemory(r)','async function beginRecording'),
  slice('async function beginRecording','const PAUSE_LIMIT_MS'),
  slice('async function retryRecording()','// Rebind fresh app observers'),
  slice('async function finishWithoutAudio(m)','function endRecSession()'),
].join('\n');

function fixture({shellHolds=true}={}){
  const calls=[],events=[],timers=[];
  let settle;
  class SharedMeeting{constructor(meetingId,cbs,o={}){Object.assign(this,{meetingId,cbs,...o});this.info={};}
    start(){this.starting=true;calls.push('start');return new Promise((resolve,reject)=>{settle={resolve:()=>{this.starting=false;this.captureId='cap-1';this.session={};resolve();},reject:e=>{this.starting=false;reject(e);}};});}}
  const state={rec:null,current:{id:'mt_1',title:'T',status:'recording'},route:{}};
  const ctx={state,SharedMeeting,console,performance,
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].cleared=true;},
    API:{captureEvent:(id,b)=>{events.push(b.event);return Promise.resolve();}},
    WizardApp:{capture:{current:()=>shellHolds?{phase:'starting'}:null,pending:async()=>[]}},
    deletingMeetings:new Set(),els:{notepad:{hidden:true}},mobileMQ:{matches:true},live:{start(){calls.push('live');},stop(){}},
    isImported:()=>false,setCurrent:m=>{state.current=m;},discardWarm(){},schedulePoll(){},notifyNative(){},showParticipantsHint(){},
    renderDoc(){},renderRecBanner(){},renderPill(){},startPillClock(){},stopPillClock(){},updateLevel(){},renderPillQueue(){},onNativeState(){},
    toast:msg=>calls.push({toast:msg}),errMsg:e=>e.message,endRecSession(){calls.push('end');state.rec=null;},
    reattachShared:async()=>{calls.push('reattach');},stopRecording:async()=>{calls.push('stop');},finishStop:async()=>{calls.push('finishStop');},
    recordingUpdateHold:null};
  vm.createContext(ctx);
  vm.runInContext(code+';globalThis.START_TIMEOUT_MS=START_TIMEOUT_MS;globalThis.api={beginRecording,retryRecording,finishWithoutAudio,clearEmptyFailedStart:typeof clearEmptyFailedStart==="function"?clearEmptyFailedStart:null}',ctx);
  // beginRecording also calls clearEmptyFailedStart from a slice we did not load: give it the real rule.
  ctx.clearEmptyFailedStart=async r=>!ctx.failedStartOwnsMemory(r)&&!ctx.WizardApp.capture.current();
  const fire=()=>{const t=timers.filter(t=>!t.cleared&&t.ms===ctx.START_TIMEOUT_MS).pop();assert(t,'watchdog armed');t.cleared=true;t.fn();};
  return {ctx,state,calls,events,fire,settle:()=>settle,api:ctx.api};
}
const tick=()=>new Promise(r=>setImmediate(r));

test('a start that never answers turns into a visible error with Try again',async()=>{
  const f=fixture();const run=f.api.beginRecording({});await tick();
  assert.equal(f.state.rec.phase,'starting');
  f.fire();
  assert.equal(f.state.rec.phase,'error');
  assert.match(f.state.rec.error,/microphone didn.t start/);
  assert(f.events.includes('start_timeout'));
  // The late answer still becomes the recording: its audio is already flowing and is kept.
  f.settle().resolve();await run;
  assert.equal(f.state.rec.phase,'recording');assert.equal(f.state.rec.error,null);assert(f.calls.includes('live'));
});

test('Try again while the shell still holds the start waits on it instead of opening a second microphone',async()=>{
  const f=fixture();const run=f.api.beginRecording({});await tick();f.fire();
  await f.api.retryRecording();
  assert.equal(f.state.rec.phase,'starting');
  assert.equal(f.calls.filter(c=>c==='start').length,1);
  assert(!f.calls.includes('reattach'));
  assert(f.events.includes('start_retry_wait'));
  f.fire();assert.equal(f.state.rec.phase,'error');
  f.settle().resolve();await run;assert.equal(f.state.rec.phase,'recording');
});

test('Try again after the shell let go starts fresh',async()=>{
  const f=fixture({shellHolds:false});void f.api.beginRecording({});await tick();f.fire();
  const first=f.state.rec.engine;
  void f.api.retryRecording();await tick();await tick();
  assert(f.events.includes('start_retry_fresh'));
  assert.equal(f.calls.filter(c=>c==='start').length,2);
  assert.notEqual(f.state.rec.engine,first);assert.equal(f.state.rec.phase,'starting');
});

test('End meeting during a pending start stops it once it answers, never orphaning audio',async()=>{
  const f=fixture();const run=f.api.beginRecording({});await tick();f.fire();
  await f.api.finishWithoutAudio(f.state.current);
  assert(!f.calls.includes('stop'));assert(!f.calls.includes('finishStop'));
  f.settle().resolve();await run;
  assert(f.calls.includes('stop'));
});

test('a start that answers in time never shows the timeout',async()=>{
  const f=fixture();const run=f.api.beginRecording({});await tick();
  f.settle().resolve();await run;
  assert.equal(f.state.rec.phase,'recording');
  assert(!f.events.includes('start_timeout'));
});
