import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./web/app.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function retryRecording()'),source.indexOf('// Rebind fresh app observers'));
function fixture({result=null,fail=false,paused=false,captureId='retained-capture'}={}){
 const calls=[];const engine={captureId,result,info:{paused},native:true,livePcm:false,detach(){calls.push('detach');},async start(opts){calls.push({id:this.captureId,...opts});if(fail)throw Error('microphone busy');}};
 const state={rec:{meetingId:'original-meeting',engine,phase:'error'},current:{id:'original-meeting'}};
 const ctx={state,live:{start(...args){calls.push({live:args});}},stopRecording(){calls.push('stop');},beginRecording(){calls.push('new');},errMsg:e=>e.message};
 for(const name of ['renderPill','renderRecBanner','notifyNative','renderDoc'])ctx[name]=()=>{};
 vm.createContext(ctx);vm.runInContext(body+';globalThis.retry=retryRecording',ctx);return {ctx,state,engine,calls};
}
test('retry keeps exact retained capture, meeting and paused state',async()=>{const f=fixture({paused:true});await f.ctx.retry();assert.equal(f.state.rec.engine,f.engine);assert.equal(f.state.rec.phase,'recording');assert.equal(f.state.rec.paused,true);assert.equal(f.calls[1].id,'retained-capture');assert.equal(f.calls[1].systemAudio,false);assert(!f.calls.includes('new'));assert(!f.calls.includes('stop'));});
test('failed retry retains the same engine and ID for later retry',async()=>{const f=fixture({fail:true});await f.ctx.retry();assert.equal(f.state.rec.engine,f.engine);assert.equal(f.state.rec.phase,'error');assert.equal(f.state.rec.error,'microphone busy');assert.equal(f.engine.captureId,'retained-capture');assert(!f.calls.includes('new'));});
test('finished capture retries save; initial start failure can retry new start',async()=>{const saved=fixture({result:{id:'retained-capture'}});await saved.ctx.retry();assert.deepEqual(saved.calls,['stop']);const initial=fixture({captureId:null});await initial.ctx.retry();assert.deepEqual(initial.calls,['new']);});
test('repeated tap during reattachment does not start twice',async()=>{const f=fixture();f.engine.start=()=>new Promise(resolve=>{f.resolve=resolve;f.calls.push('start');});const pending=f.ctx.retry();await f.ctx.retry();assert.deepEqual(f.calls,['detach','start']);f.resolve();await pending;assert.equal(f.state.rec.phase,'recording');});
