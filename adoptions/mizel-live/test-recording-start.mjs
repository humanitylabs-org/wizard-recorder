import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(process.env.MIZEL_APP_SOURCE || new URL('./web/app.js',import.meta.url),'utf8');
const slice=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i);assert(i>=0&&j>i,a);return source.slice(i,j)};
function fixture({start, pending=async()=>[], current=()=>null}={}) {
 const acked=new Set(),engines=[],calls=[],stops=[],apiStops=[],navigations=[],holds=new Set(),state={current:{id:'synthetic',title:'Synthetic',status:'recording'},rec:null};
 const ctx={state,WizardApp:{capture:{current:()=>{const r=current();return r&&!acked.has(r.id)?r:null},pending:async()=>(await pending()).filter(r=>!acked.has(r.id))},update:{hold(reason){holds.add(reason);return {release(){calls.push('release');holds.delete(reason)}}}}},
  deletingMeetings:new Set(),prefs:{},live:{start(){},stop(){}},els:{notepad:{hidden:true},docPane:{dataset:{}}},mobileMQ:{matches:false},
  discardWarm(){calls.push('release-warm')},setCurrent(v){state.current=v},isImported:()=>false,navigate(id){calls.push('navigate');navigations.push(id)},
  setInterval:()=>1,clearInterval(){},clearTimeout(){},document:{querySelector:()=>null},errMsg:e=>e.message,onNativeState(){},sessionStorage:{getItem:()=>null},
  SharedMeeting:class {constructor(id,cbs,opts={}){engines.push(this);this.meetingId=id;this.captureId=opts.captureId;this.info={};this.uploader={pending:0};this.sent=new Set();this.finalSeq={};this.detach=()=>calls.push('detach');this.abort=()=>calls.push('FORBIDDEN abort');this.stop=()=>{calls.push('stop');stops.push(this.meetingId);return {meta:{}}};this.acknowledge=()=>{acked.add(this.captureId);calls.push('ack')};this.uploader.drain=async()=>{};}async start(){if(start)await start(this);else throw Error('Synthetic permission rejection')}},
  API:{stop:async id=>{apiStops.push(id);return {id}}},loadMeeting:async()=>{},loadMeetings(){},toast(){},retryRecording(){}};
 for(const n of ['updateLevel','renderPillQueue','renderDoc','renderRecBanner','renderPill','renderAskBar','renderHeader','tickPillClock','schedulePoll','notifyNative','showParticipantsHint'])ctx[n]=()=>{};
 vm.createContext(ctx);
 vm.runInContext(slice('async function clearEmptyFailedStart(', '// A recording left paused')+slice('function recordingSaveFailed(', 'async function finishStop(')+slice('function endRecSession()', 'const BAR_SHAPE =')+';globalThis.x={beginRecording,stopRecording,clearEmptyFailedStart};',ctx);
 vm.runInContext(slice('async function retryRecording()', 'async function toggleSystemAudio('),ctx);
 ctx.x.reattachShared=ctx.reattachShared;ctx.x.retryRecording=ctx.retryRecording;
 const unloadLine=source.split('\n').find(line=>line.includes("window.addEventListener('beforeunload'"));assert(unloadLine);
 ctx.window={addEventListener:(_name,fn)=>ctx.unload=fn};ctx.flushNotes=()=>calls.push('flush-notes');vm.runInContext(unloadLine,ctx);
 return {engines,ctx,state,calls,stops,apiStops,navigations,holds,x:ctx.x};
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
const tick=async()=>{for(let i=0;i<24;i++)await Promise.resolve()};
for(const second of ['Start','Stop'])test(`same-task double cleanup (${second}) cannot tear down the next starting engine`,async()=>{
  let attempt=0,finishStart;let pending=async()=>[];
  const f=fixture({pending:()=>pending(),start:async()=>{if(++attempt===1)throw Error('Denied');await new Promise(r=>finishStart=r)}});
  await f.x.beginRecording();
  const waiters=[];pending=()=>new Promise(r=>waiters.push(r));
  const a=f.x.beginRecording(),b=second==='Start'?f.x.beginRecording():f.x.stopRecording();
  assert.equal(waiters.length,2);
  // Resolve both pending() promises in exactly this task, not separate timer/microtask turns.
  for(const r of waiters)r([]);
  await tick();const next=f.state.rec,engine=next.engine;
  assert.equal(attempt,2);assert.equal(next.phase,'starting');assert(f.holds.has('Mizel recording'));
  const detaches=f.calls.filter(x=>x==='detach').length;
  finishStart();await Promise.all([a,b]);assert.equal(f.state.rec,next);assert.equal(next.engine,engine);
  assert.equal(next.phase,'recording');assert(f.holds.has('Mizel recording'));
  assert.equal(f.calls.filter(x=>x==='detach').length,detaches);
});
for(const action of ['Start','Stop'])test(`failed ${action} adopts exact current app capture instead of dead-ending or starting a new mic`,async()=>{
  let current=null,attempt=0;
  const f=fixture({current:()=>current,start:async e=>{
    attempt++;if(attempt===1){current={id:'retained-capture',meta:{meetingId:'synthetic'}};throw Error('Lost shell reply')}
    assert.equal(e.captureId,current.id);e.session={};
  }});
  await f.x.beginRecording();const failed=f.state.rec;assert(failed.engine);assert(f.holds.has('Mizel recording'));
  if(action==='Start')await f.x.beginRecording();else await f.x.stopRecording();
  assert.equal(attempt,2);assert.notEqual(f.state.rec,failed);
  assert(!f.calls.includes('FORBIDDEN abort'));assert.equal(f.calls.filter(x=>x==='release').length,action==='Stop'?1:0);
  if(action==='Start'){assert.equal(f.state.rec.phase,'recording');assert.equal(f.state.rec.engine.captureId,'retained-capture');assert(f.holds.has('Mizel recording'));}
  else {assert(f.calls.includes('stop'));assert(f.calls.includes('ack'));assert.equal(f.state.rec,null);}
});
test('legacy pending without metadata uses only an exact capture hint, never guesses a meeting',async()=>{
  for(const match of [true,false]){
    const take={id:'retained',streamChunks:[]};const f=fixture({pending:async()=>[take]});
    await f.x.beginRecording();const failed=f.state.rec;
    f.ctx.sessionStorage.getItem=()=>JSON.stringify({id:match?'retained':'different',meetingId:'synthetic'});
    await f.x.beginRecording();
    if(match){assert.equal(f.state.rec,null);assert(f.calls.includes('ack'));}
    else {assert.equal(f.state.rec,failed);assert.match(failed.error,/no verified meeting link/);assert(f.holds.has('Mizel recording'));assert(!f.calls.includes('ack'));assert(!f.calls.includes('release'));}
  }
});
test('concurrent retained-capture adoption installs only one engine and keeps its hold',async()=>{
  let current=null,attempt=0;
  const f=fixture({current:()=>current,start:async e=>{if(++attempt===1){current={id:'retained',meta:{meetingId:'synthetic'}};throw Error('Lost reply')}e.session={}}});
  await f.x.beginRecording();await Promise.all([f.x.beginRecording(),f.x.beginRecording()]);
  assert.equal(attempt,2);assert.equal(f.state.rec.engine.captureId,'retained');assert(f.holds.has('Mizel recording'));assert(!f.calls.includes('release'));
});
test('Stop adoption awaiting resume cannot stop or mutate a replacement controller',async()=>{
  let current=null,attempt=0,resume;
  const f=fixture({current:()=>current,start:async e=>{
    if(++attempt===1){current={id:'retained',meta:{meetingId:'synthetic'}};throw Error('Lost reply')}
    await new Promise(r=>resume=r);e.session={};
  }});
  await f.x.beginRecording();const work=f.x.stopRecording();await tick();assert.equal(attempt,2);
  const next={meetingId:'replacement',phase:'recording',engine:{captureId:'different'}};f.state.rec=next;
  resume();await work;assert.equal(f.state.rec,next);assert.equal(next.phase,'recording');
  assert(!f.calls.includes('stop'));assert(!f.calls.includes('ack'));assert(!f.calls.includes('release'));
});

test('frame remount adopts positive current even when pending would throw capture_custody_uncertain',async()=>{
  let pendingCalls=0;const take={id:'active',meta:{meetingId:'synthetic'}};
  const f=fixture({current:()=>take,pending:async()=>{pendingCalls++;throw Object.assign(Error('uncertain'),{code:'capture_custody_uncertain'})},start:async e=>{e.session={}}});
  await f.x.reattachShared();assert.equal(f.state.rec?.engine.captureId,take.id);assert.equal(f.state.rec.phase,'recording');
  assert.equal(pendingCalls,0);assert.equal(f.engines.length,1);assert(f.holds.size);assert.deepEqual(f.stops,[]);assert.deepEqual(f.apiStops,[]);
});

// Execute the selected candidate shell's genuine pending/current bodies, not a permissive [] mock.
// Like the existing real-ack contract test, enabled by the acceptance worker's pinned source path.
function shellCustody(mode='active',meetingId='synthetic') {
  const sdk=readFileSync(process.env.WIZARD_CAPTURE_SOURCE,'utf8');
  const take={id:'shell-retained',appId:'mizel',status:'recording',meta:{meetingId}};
  const c={validate(){},ready:Promise.resolve(),recover:async()=>{},rows:async()=>[take],result:async r=>r,
    active:mode==='active'?{row:take,phase:'recording',engine:{}}:null,recoveryLive:new Set(mode==='recoveryLive'?[take.id]:[]),
    ownedRows:new Map([[take.id,take]]),ownershipLoaded:true,recoveryError:null,unknownMeetingActive:false,
    fail:(code,message)=>Object.assign(Error(message),{code})};
  const a=sdk.indexOf('  async function pending(appId)'),b=sdk.indexOf('  async function ack(',a);
  const i=sdk.indexOf('    current(appId)'),j=sdk.indexOf('    configureNativeBridge(',i);
  assert(a>=0&&b>a&&i>=0&&j>i);vm.createContext(c);
  vm.runInContext(sdk.slice(a,b)+';globalThis.capture={'+sdk.slice(i,j)+'};',c);
  let pendingCalls=0;
  return {take,current:()=>c.capture.current('mizel'),pending:()=>{pendingCalls++;return c.pending('mizel')},get pendingCalls(){return pendingCalls}};
}
if(process.env.WIZARD_CAPTURE_SOURCE){
  for(const mode of ['active','recoveryLive'])test(`genuine shell ${mode}: frame remount reattaches while pending rejects active custody`,async()=>{
    const shell=shellCustody(mode);await assert.rejects(shell.pending(),e=>e.code==='capture_custody_uncertain');
    assert.equal(shell.current().id,shell.take.id);const before=shell.pendingCalls;
    const f=fixture({...shell,start:async e=>{assert.equal(e.captureId,shell.take.id);e.session={}}});
    await f.x.reattachShared();assert.equal(f.state.rec?.phase,'recording');assert.equal(f.state.rec.engine.captureId,shell.take.id);
    assert.equal(shell.pendingCalls,before);assert.equal(f.engines.length,1);assert(f.holds.size);assert.deepEqual(f.stops,[]);assert.deepEqual(f.apiStops,[]);
  });
  for(const action of ['Retry','Stop'])test(`genuine shell active: failed Start ${action} adopts the same meeting despite rejecting pending`,async()=>{
    const shell=shellCustody();await assert.rejects(shell.pending(),e=>e.code==='capture_custody_uncertain');
    let started=false,attempts=0;const f=fixture({current:()=>started?shell.current():null,pending:shell.pending,start:async e=>{
      if(++attempts===1){started=true;throw Error('Lost shell reply')}
      assert.equal(e.captureId,shell.take.id);e.session={};
    }});
    await f.x.beginRecording();const failed=f.state.rec,before=shell.pendingCalls;assert(f.holds.size);
    if(action==='Retry')await f.x.retryRecording();else await f.x.stopRecording();
    assert.equal(attempts,2);assert.notEqual(f.state.rec,failed);assert.equal(shell.pendingCalls,before);
    assert(!f.calls.includes('FORBIDDEN abort'));
    if(action==='Retry'){assert.equal(f.state.rec.phase,'recording');assert.equal(f.state.rec.meetingId,'synthetic');assert(f.holds.size);assert.deepEqual(f.stops,[]);assert.deepEqual(f.apiStops,[]);}
    else {assert.equal(f.state.rec,null);assert.deepEqual(f.stops,['synthetic']);assert.deepEqual(f.apiStops,['synthetic']);assert(f.calls.includes('ack'));assert.equal(f.holds.size,0);}
  });
  test('genuine shell active: Stop on failed B adopts A without stopping A until explicit second Stop',async()=>{
    const shell=shellCustody('active','meeting-A');await assert.rejects(shell.pending(),e=>e.code==='capture_custody_uncertain');
    const f=fixture({...shell,start:async e=>{if(!e.captureId)throw Error('Busy');e.session={}}});
    await f.x.beginRecording();await f.x.stopRecording();
    assert.equal(f.state.rec?.meetingId,'meeting-A');assert.equal(f.state.rec.phase,'recording');assert.deepEqual(f.stops,[]);assert.deepEqual(f.apiStops,[]);
    assert.deepEqual(f.navigations,['meeting-A']);assert(f.holds.size);assert(!f.calls.includes('ack'));assert(!f.calls.includes('release'));
    await f.x.stopRecording();assert.deepEqual(f.stops,['meeting-A']);assert.deepEqual(f.apiStops,['meeting-A']);assert.equal(f.state.rec,null);
  });
}
// Isolate N2 even against the old controller, whose N1 otherwise hides this accidental Stop.
test('cross-meeting Stop adoption never transfers the first Stop intent to a different meeting',async()=>{
  const f=fixture({current:()=>({id:'take-A',meta:{meetingId:'meeting-A'}}),start:async e=>{if(!e.captureId)throw Error('Busy');e.session={}}});
  await f.x.beginRecording();await f.x.stopRecording();
  assert.deepEqual(f.stops,[]);assert.deepEqual(f.apiStops,[]);assert.equal(f.state.rec.meetingId,'meeting-A');assert.equal(f.state.rec.phase,'recording');
  assert.deepEqual(f.navigations,['meeting-A']);assert(f.holds.size);assert(!f.calls.includes('ack'));assert(!f.calls.includes('release'));
});
for(const replace of [false,true])test(`reattach awaiting pending rechecks ${replace?'controller identity':'new current capture'} before adoption`,async()=>{
  let current=null,release;const f=fixture({current:()=>current,pending:()=>new Promise(r=>release=r),start:async e=>{e.session={}}});
  const work=f.x.reattachShared();assert(release);
  const next={meetingId:'replacement',phase:'recording',engine:{captureId:'new'}};
  if(replace)f.state.rec=next;else current={id:'new-active',meta:{meetingId:'synthetic'}};
  release([{id:'old-pending',meta:{meetingId:'old'}}]);await work;
  if(replace){assert.equal(f.state.rec,next);assert.equal(f.engines.length,0);}
  else {assert.equal(f.state.rec.engine.captureId,'new-active');assert.equal(f.state.rec.meetingId,'synthetic');}
  assert.deepEqual(f.stops,[]);assert.deepEqual(f.apiStops,[]);
});
