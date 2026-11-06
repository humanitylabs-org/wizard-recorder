// Run against the isolated fixture gateway only. All dispatch reaches the synthetic upstream.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const WebSocket=require(process.env.WS_MODULE||'ws');
const base=process.env.PARITY_BASE,out=process.env.PARITY_OUT;
assert.match(base,/^http:\/\/127\.0\.0\.1:\d+$/);fs.mkdirSync(out,{recursive:true});
const checks=[],errors=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const deadline=Date.now()+25000;while(Date.now()<deadline){const v=await fn();if(v)return v;await sleep(100);}throw Error('Timed out');}
async function api(p,body,method=body===undefined?'GET':'POST'){const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,`${p}: ${r.status} ${await r.clone().text()}`);return r.json();}
function wav(){const pcm=Buffer.alloc(64000);for(let i=0;i<32000;i++)pcm.writeInt16LE(i%2?4000:-4000,i*2);const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(pcm.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);}
let browser, liveSocket;
const observedFrames=[];
(async()=>{
 const m=await api('/wizard-recorder/api/meetings',{title:'Synthetic native parity'}),mid=m.id;
 await api('/wizard-recorder/finish-route',{meetingId:mid,agent:'fixture-helper'});
 const audio=wav();const chunk=await fetch(base+`/meetings/api/meetings/${mid}/chunks?source=me&seq=0&start_ms=0`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:audio});assert.equal(chunk.status,200);
 // Exact native journal shape, then read back its immutable identity via the legacy path.
 const marker={id:'synthetic-native-marker',meetingId:mid,captureId:'synthetic-native-capture',atMediaMs:500,clientRevision:1,status:'local',voiceTakeId:'synthetic-voice',pausedAt:1000,endedAt:1500,pausedByHandoff:true,question:'Synthetic local handoff'};
 await api('/mizel-live/orb-events',marker,'PUT');const events=await api(`/mizel-live/orb-events?meetingId=${mid}`);assert.deepEqual(events.events.map(x=>x.id),[marker.id]);checks.push('native orb PUT/readback through exact staged alias');
 await api(`/meetings/api/meetings/${mid}/stop`,{final_seq:{me:0},reason:'user'});
 const done=await until(async()=>{const m=await api(`/meetings/api/meetings/${mid}`);return m.status==='ready'&&m.segments?.length?m:null;});assert.match(done.segments.map(x=>x.text).join(' '),/synthetic purple bicycle/);
 const saved=Buffer.from(await (await fetch(base+`/wizard-recorder/api/meetings/${mid}/audio.wav`)).arrayBuffer());assert.deepEqual(saved.subarray(44),audio.subarray(44));fs.writeFileSync(path.join(out,'saved-native.wav'),saved);checks.push('native chunks/final_seq/readback reaches ready with exact saved PCM and transcript');
 await until(async()=>{const r=await api('/wizard-recorder/finish-route?meetingId='+mid);return r.sent?.agent==='fixture-helper';});checks.push('automatic finish dispatch to selected installed agent intercepted by synthetic fixture');
 // Exercise Router live words through the same gateway and force a completed outline.
 const live=await api('/wizard-recorder/api/meetings',{title:'Synthetic live slot parity'}),frames=observedFrames;
 await api('/wizard-recorder/finish-route',{meetingId:live.id,agent:'none'});
 const ws=liveSocket=new WebSocket(base.replace('http:','ws:')+'/wizard-recorder/live');ws.on('message',raw=>frames.push(JSON.parse(raw)));
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});ws.send(JSON.stringify({type:'start',meetingId:live.id,title:'Synthetic live slot parity'}));await until(()=>frames.some(x=>x.type==='status'&&x.live));ws.send(audio.subarray(44));ws.send(JSON.stringify({type:'pause'}));await until(()=>frames.some(x=>x.type==='settled'&&/synthetic purple/.test(x.text)));
 ws.send(JSON.stringify({type:'stop',finish:false}));await new Promise(r=>ws.once('close',r));
 const liveUpload=await fetch(base+`/meetings/api/meetings/${live.id}/chunks?source=me&seq=0&start_ms=0`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:audio});assert.equal(liveUpload.status,200);
 await until(async()=>{const m=await api(`/meetings/api/meetings/${live.id}`);return m.segments?.length;});
 await until(async()=>{const r=await api('/wizard-recorder/summary?meetingId='+live.id);return r.summary?.topics?.some(t=>t.bullets?.length);});fs.writeFileSync(path.join(out,'live-frames.json'),JSON.stringify(frames,null,2));checks.push('Router-slot live delta/final, canonical transcript and grounded outline');
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM});
 for(const skin of ['nebula','grove']){
   const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/wizard-recorder/#/m/'+live.id);await page.waitForSelector('#doc-route button');
   await page.addStyleTag({path:path.join(__dirname,'appearance-tokens.css')});
   await page.evaluate(skin=>{document.documentElement.dataset.skin=skin;document.documentElement.setAttribute('data-wz-hosted','');document.documentElement.dataset.presentation='window';},skin);
   assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--wz-base').trim()),skin==='grove'?'#050b07':'#05030c');
   await page.screenshot({path:path.join(out,'390-'+skin+'-route-row.png'),animations:'disabled'});
   await page.locator('#doc-route button').click();await page.getByRole('dialog').waitFor();await page.screenshot({path:path.join(out,'390-'+skin+'-send-picker.png'),animations:'disabled'});
   assert.match(await page.getByRole('dialog').innerText(),/Fixture guide/);assert.match(await page.getByRole('dialog').innerText(),/Local private guide/);
   for(const button of await page.getByRole('dialog').getByRole('button').all()){
     const b=await button.boundingBox();assert.ok(b&&b.x>=0&&b.y>=0&&b.x+b.width<=390.5&&b.y+b.height<=844.5,'every settled picker control fits the 390px viewport');
   }
   await ctx.close();
 }
 checks.push('390px Nebula/Grove route row and installed-agent picker screenshots');
 // Manual send endpoint is the same action used by the UI, stubbed at the service boundary.
 const manual=await api('/wizard-recorder/send',{meetingId:live.id,agent:'fixture-helper',note:'Synthetic explicit owner send'});assert.equal(manual.send.agent,'fixture-helper');await until(async()=>{const r=await api('/wizard-recorder/sends?meetingId='+live.id);return r.sends?.some(s=>s.status==='sent');});checks.push('explicit Send to selected installed agent intercepted; no real agent sends');
 const upstream=await api('/qa/log');assert.ok(upstream.log.some(x=>x.path==='/v1/models/live-summary/run'));assert.ok(upstream.log.some(x=>x.path==='/v1/services/live-transcription/v1/live'));assert.equal(upstream.runs.length,2,'one automatic and one explicit send, no duplicate sweeps');assert.ok(upstream.runs.every(x=>x.agent==='fixture-helper'));assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({ok:true,checks,errors,terminalStatus:done.status,meeting:mid,live:live.id,sourceSHA:process.env.SOURCE_SHA,dispatches:upstream.runs,requests:upstream.log},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,errors,evidence:out}));
})().catch(e=>{console.error(e);fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:e.stack,checks,errors,frames:observedFrames},null,2));process.exitCode=1;}).finally(async()=>{liveSocket?.terminate();await browser?.close();});
