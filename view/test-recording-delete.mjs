import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./web/app.js',import.meta.url),'utf8');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b));
function fixture({phase='error',inputStopped=true,hasResult=true,session=true,other=false,removeFail=false,ackFail=false}={}) {
  const calls=[],toasts=[],storage=new Map(),pending=new Map();
  const meeting={id:'original',title:'Test',source:'meetings'};
  const take={id:'capture',meta:{meetingId:'original'},streamChunks:[]};pending.set(take.id,take);
  storage.set('mizel.sharedCapture',JSON.stringify({id:'capture',meetingId:'original'}));
  let current=inputStopped?null:{id:'capture',meta:{meetingId:'original'}};
  const state={current:meeting,meetings:[meeting,{id:'other'}],rec:null};
  const c={state,console,setTimeout,clearTimeout,clearInterval,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},localStorage:{removeItem:k=>calls.push('draft:'+k)},draftKey:id=>id,errMsg:e=>e.message,els:{docPane:{dataset:{rec:'error'}}},live:{stop:()=>calls.push('live.stop')},toast:(s,opts)=>toasts.push([s,opts]),confirmToast:(_s,_label,fn)=>{c.confirm=fn;},navigate:id=>{calls.push(['navigate',id]);state.current=null;},API:{async remove(id){calls.push(['remove',id]);if(removeFail)throw Object.assign(Error('forbidden'),{status:403});}},WizardApp:{capture:{current:()=>current,pending:async()=>[...pending.values()],async ack(id){calls.push(['ack',id]);if(ackFail)throw Error('storage unavailable');if(current?.id===id)throw Error('capture_active');assert(pending.has(id));pending.delete(id);}}},Uploader:class{constructor(){this.abandoned=false;}abandon(){calls.push('abandon');this.abandoned=true;}},stopRecording:()=>calls.push('save'),beginRecording:()=>calls.push('new')};
  for(const n of ['renderRecBanner','renderPill','renderAskBar','renderHeader','notifyNative','renderList','renderDoc'])c[n]=()=>calls.push(n);
  vm.createContext(c);
  vm.runInContext('let recordingUpdateHold={release(){globalThis.released=true;}}; let pillClock=1;'+slice('const deletingMeetings =','async function copyMarkdown(')+slice('class SharedMeeting {','// Decode backend WAV')+slice('async function retryRecording()','// Rebind fresh app observers')+slice('async function reattachShared()','async function toggleSystemAudio()')+slice('function endRecSession()','let pillClock =')+'function stopPillClock(){pillClock=0;}globalThis.x={deleteMeeting,retryRecording,reattachShared,SharedMeeting};',c);
  const engine=new c.x.SharedMeeting('original',{});engine.captureId='capture';engine.result=hasResult?take:null;
  if(session)engine.session={getInfo:()=>({inputStopped}),async stop(){calls.push('finalize');current=null;return take;},async cancel(){throw Error('already_stopping');}};
  engine.offs.push(()=>calls.push('detach'));
  const rec={meetingId:other?'other':'original',engine,phase,error:'Audio retained',pauseTimer:0};state.rec=rec;
  return {c,state,engine,rec,calls,toasts,storage,pending,async confirm(){c.x.deleteMeeting(meeting);await c.confirm?.();},setCurrent:v=>{current=v;},allowAck(){ackFail=false;}};
}
test('confirmed DELETE releases stopped Result, hint, uploader, UI hold; reload cannot resurrect it',async()=>{
  const f=fixture();f.c.x.deleteMeeting(f.state.current);assert.equal(f.calls.length,0);await f.c.confirm();
  assert.deepEqual(f.calls.filter(Array.isArray).slice(0,2),[['remove','original'],['ack','capture']]);
  assert.equal(f.engine.uploader.abandoned,true);assert.equal(f.storage.has('mizel.sharedCapture'),false);assert.equal(f.pending.size,0);assert.equal(f.state.rec,null);assert.equal(f.c.released,true);assert.equal(f.c.els.docPane.dataset.rec,'');
  await f.c.x.reattachShared();assert.equal(f.state.rec,null);
});
test('403 preserves exact capture, Result, hint, uploader and retryable error',async()=>{
  const f=fixture({removeFail:true}),result=f.engine.result,hint=f.storage.get('mizel.sharedCapture');await f.confirm();
  assert.equal(f.state.rec,f.rec);assert.equal(f.rec.phase,'error');assert.equal(f.rec.error,'Audio retained');assert.equal(f.engine.result,result);assert.equal(f.engine.uploader.abandoned,false);assert.equal(f.storage.get('mizel.sharedCapture'),hint);assert.equal(f.pending.size,1);assert.equal(f.c.released,undefined);assert.deepEqual(f.calls,[['remove','original']]);
  await f.c.x.retryRecording();assert.equal(f.calls.at(-1),'save');
});
for(const phase of ['starting','recording','stopping','uploading','deleting'])test(`${phase} capture cannot be deleted`,async()=>{const f=fixture({phase});await f.confirm();assert.equal(f.c.confirm,undefined);assert.equal(f.calls.length,0);assert.equal(f.pending.size,1);});
test('error is not proof the microphone stopped',async()=>{const f=fixture({inputStopped:false});await f.confirm();assert.equal(f.c.confirm,undefined);assert.equal(f.pending.size,1);});
test('confirmation revalidates an error that resumed recording',async()=>{const f=fixture();f.c.x.deleteMeeting(f.state.current);f.rec.phase='recording';await f.c.confirm();assert.equal(f.calls.length,0);});
test('other meeting deletion cannot discard or detach the retained capture',async()=>{const f=fixture({other:true});await f.confirm();assert.equal(f.state.rec,f.rec);assert.equal(f.engine.uploader.abandoned,false);assert.equal(f.pending.size,1);assert.equal(f.storage.has('mizel.sharedCapture'),true);assert(!f.calls.includes('detach'));});
test('DELETE in flight excludes duplicate confirmation and Retry',async()=>{const f=fixture();let resolve;f.c.API.remove=()=>new Promise(r=>{resolve=r;f.calls.push('remove');});f.c.x.deleteMeeting(f.state.current);const first=f.c.confirm();await f.c.x.retryRecording();await f.c.confirm();assert.deepEqual(f.calls,['remove']);resolve();await first;assert.equal(f.pending.size,0);});
test('input-stopped storage error finalizes before ACK, never calls cancel or normal save',async()=>{const f=fixture({hasResult:false});await f.confirm();assert(f.calls.indexOf('finalize')>f.calls.indexOf('abandon'));assert.equal(f.state.rec,null);assert(!f.calls.includes('save'));});
test('reattached pending Result needs no live session to release',async()=>{const f=fixture({session:false});await f.confirm();assert.equal(f.state.rec,null);assert.equal(f.pending.size,0);});
test('cleanup failure stays retryable without re-uploading a deleted meeting',async()=>{const f=fixture({ackFail:true});await f.confirm();assert.equal(f.rec.deletionConfirmed,true);assert.equal(f.rec.phase,'error');assert.equal(f.pending.size,1);assert.equal(f.storage.has('mizel.sharedCapture'),true);f.allowAck();await f.c.x.retryRecording();assert.equal(f.state.rec,null);assert.equal(f.pending.size,0);assert(!f.calls.includes('save'));assert(!f.calls.includes('new'));assert.equal(f.calls.filter(v=>Array.isArray(v)&&v[0]==='remove').length,1);});
test('different session hint survives exact capture cleanup',async()=>{const f=fixture();const hint=JSON.stringify({id:'new-capture',meetingId:'other'});f.storage.set('mizel.sharedCapture',hint);await f.confirm();assert.equal(f.storage.get('mizel.sharedCapture'),hint);});
test('identity mismatch refuses custody release',async()=>{const f=fixture();f.engine.result={id:'wrong',meta:{meetingId:'other'}};await f.confirm();assert.equal(f.pending.size,1);assert.equal(f.state.rec,f.rec);assert(!f.calls.some(v=>Array.isArray(v)&&v[0]==='ack'));});
test('reload after cleanup failure retries only exact pending deletion, not upload/stop',async()=>{
  const f=fixture({ackFail:true});await f.confirm();assert.equal(JSON.parse(f.storage.get('mizel.sharedCapture')).deletionConfirmed,true);
  f.allowAck();f.state.rec=null;
  Object.assign(f.c,{updateLevel(){},renderPillQueue(){},onNativeState(){},startPillClock(){},recordingSaveFailed:(_r,e)=>{throw e;}});
  f.c.WizardApp.update={hold:()=>({release(){}})};
  await f.c.x.reattachShared();assert.equal(f.state.rec,null);assert.equal(f.pending.size,0);assert.equal(f.storage.has('mizel.sharedCapture'),false);
});
test('real Stop -> readback failure -> explicit Delete clears original custody',async()=>{
  const f=fixture({phase:'recording'});f.engine.uploader.drain=async()=>{};
  Object.assign(f.c,{document:{querySelector:()=>null},verifyCaptureReadback:async()=>{throw Error('PCM differs');},setCurrent:m=>{f.state.current=m;}});
  f.c.API.stop=async()=>f.state.current;
  vm.runInContext(slice('function recordingSaveFailed(','async function finishStop(')+';globalThis.runStop=stopRecording;',f.c);
  await f.c.runStop();assert.equal(f.rec.phase,'error');assert.match(f.rec.error,/PCM differs/);assert.equal(f.pending.size,1);
  await f.confirm();assert.equal(f.state.rec,null);assert.equal(f.pending.size,0);
});
// Optional contract check executes the inspected shell's real ack implementation with isolated rows.
if(process.env.WIZARD_CAPTURE_SOURCE)test('real SDK ack deletes only pending owned row and refuses active/recoverable/foreign',async()=>{
  const sdk=readFileSync(process.env.WIZARD_CAPTURE_SOURCE,'utf8');const fn=sdk.slice(sdk.indexOf('  async function ack(appId, id)'),sdk.indexOf('  const channel =',sdk.indexOf('  async function ack(appId, id)')));
  for(const mode of ['pending','active','recoverable','foreign']){
    const removed=[];const row={id:'capture',appId:mode==='foreign'?'other':'mizel',status:mode==='recoverable'?'recoverable':'pending'};
    const c={validate(){},ready:Promise.resolve(),active:mode==='active'?{row}:null,fail:(code,msg)=>Object.assign(Error(msg),{code}),navigator:{locks:{request:async(_id,fn)=>fn()}},DB_NAME:'fixture',rows:async()=>[row],remove:async id=>removed.push(id)};vm.createContext(c);vm.runInContext(fn+';globalThis.ack=ack;',c);
    if(mode==='pending'){await c.ack('mizel','capture');assert.deepEqual(removed,['capture']);}else{await assert.rejects(c.ack('mizel','capture'));assert.deepEqual(removed,[]);}
  }
});
