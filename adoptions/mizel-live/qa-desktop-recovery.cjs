/* Synthetic-only integration rig. Run on forum through durable admission.
 * Exact app, shared capture/client/services and LiveSession; fake ONLY domain storage,
 * API receipts, app registry/window chrome and the confidential provider's network peer.
 * The REAL pinned SDK is exercised against a local CA-trusted TLS fault peer. No key,
 * owner state, production API, external STT, or production socket is ever used.
 */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),https=require('node:https'),vm=require('node:vm'),crypto=require('node:crypto');
const {WebSocketServer}=require('ws');
const {OpenAIRealtimeWS}=require('openai/realtime/ws');
const {chromium}=require(process.env.QA_PLAYWRIGHT);
const base=__dirname,shared=process.env.QA_SHARED_STATIC,out=process.env.QA_OUT;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const cert=fs.readFileSync(process.env.QA_TLS_CERT),key=fs.readFileSync(process.env.QA_TLS_KEY);
const report={syntheticOnly:true,productionAcceptance:false,providerRouteChanged:false,tests:[],source:{},warnings:[],pageErrors:[],checkpoints:[],requests:[],console:[],input:[]};
const retain=(list,item)=>{if(list.length<500)list.push(item);};
const persist=()=>{const target=path.join(out,'browser-recovery.json'),tmp=target+'.partial';fs.writeFileSync(tmp,JSON.stringify(report,null,2)+'\n');fs.renameSync(tmp,target);};
async function bounded(promise,ms){let t;try{return await Promise.race([promise,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error('Diagnostic deadline exceeded')),ms);})]);}finally{clearTimeout(t);}}
let currentPage=null,currentViewport=null;
async function checkpoint(label){
 const name=`${currentViewport}-${label}`,entry={name,at:Date.now(),syntheticOnly:true};
 // Save partial JSON before each await; retain the page on any failed original assertion.
 report.checkpoints.push(entry);persist();
 if(currentPage&&!currentPage.isClosed()){
  try{entry.ui=await bounded(currentPage.evaluate(()=>{
   const f=document.querySelector('#app'),w=f?.contentWindow,d=w?.document;
   const box=el=>{if(!el)return null;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,transform:s.transform,pointerEvents:s.pointerEvents,hidden:el.hidden,disabled:el.disabled===true};};
   const button=d?.querySelector(innerWidth>700?'#btn-new':'#btn-new-mobile'),r=button?.getBoundingClientRect();
   return {hostReady:!!window.WizAppServices,frame:box(f),url:w?.location.href,hosted:w?.WizardApp?.hosted===true,domainReady:!!w?.mizel,viewport:{width:w?.innerWidth,height:w?.innerHeight},newButton:box(button),hitTarget:r?d.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')?.id:null,inputs:w?.__qaInputs||[],pill:box(d?.querySelector('#pill')),buttons:[...(d?.querySelectorAll('button')||[])].map(b=>({id:b.id,label:b.getAttribute('aria-label')||b.innerText,hidden:b.hidden,disabled:b.disabled})),text:d?.body?.innerText?.slice(0,12000),capture:window.WizAppCapture?.getState?.()};
  }),8000);}catch(e){entry.uiError=e.message;}persist();
  try{entry.screenshot=name+'.png';await currentPage.screenshot({path:path.join(out,entry.screenshot),timeout:8000});}catch(e){entry.screenshotError=e.message;}persist();
 }
}
for(const p of ['web/app.js','server.mjs','provider.js'])report.source[p]=hash(fs.readFileSync(path.join(base,p)));
for(const p of ['app-capture.js','app-client.js','app-services.js','appearance-host.js','skins.css'])report.source['shared/'+p]=hash(fs.readFileSync(path.join(shared,p)));
let browser;const sessions=new Set(),timers=new Set(),sockets=new Set();let mode=null;
const it=(fn,ms)=>{const t=setInterval(fn,ms);timers.add(t);return t;};
const to=(fn,ms)=>{const t=setTimeout(fn,ms);timers.add(t);return t;};
const source=fs.readFileSync(path.join(base,'server.mjs'),'utf8');
const start=source.indexOf('class LiveSession {'),end=source.indexOf('// ───────────── HTTP:',start);
assert(start>0&&end>start);
const journal=(run,event,data={})=>{
 if(run.journal.length>=2000)throw Error('Causal ledger overflow');
 const entry={seq:run.journal.length,event,at:Date.now(),...data};run.journal.push(entry);
 const fd=fs.openSync(path.join(out,'causal-ledger.jsonl'),'a',0o600);
 try{fs.writeSync(fd,JSON.stringify({viewport:run.viewport,...entry})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}persist();
};
const until=async(fn,ms,what)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('Timed out: '+what);await new Promise(r=>setTimeout(r,25));}};
const OUTAGE='Live words dropped out, recording continues. Reconnecting…';
const tls=https.createServer({key,cert}),peer=new WebSocketServer({server:tls});
peer.on('connection',ws=>{
 const run=mode,ordinal=++run.connections;let started=false,finalized=false,frames=0,armedFrames=0;
 sockets.add(ws);ws.on('close',code=>{sockets.delete(ws);journal(run,'peer.close',{ordinal,code});});
 journal(run,'peer.connect',{ordinal});ws.send(JSON.stringify({type:'session.created'}));
 ws.on('message',raw=>{
  const m=JSON.parse(raw);
  if(m.type==='input_audio_buffer.commit'){
   // Native dialect: non-final starts generation; only final:true completes it.
   // Answering the initial commit with done retires ownership BEFORE any injected close.
   if(m.final!==true){started=true;journal(run,'peer.generation',{ordinal});return;}
   finalized=true;journal(run,'peer.final',{ordinal});
   ws.send(JSON.stringify({type:'transcription.done',text:run.faultAt?'Synthetic recovery words. Synthetic words after reconnect.':'Synthetic recovery words.'}));return;
  }
  if(m.type!=='input_audio_buffer.append')return;
  const pcm=Buffer.from(m.audio,'base64');run.providerBytes+=pcm.length;run.providerFrames++;frames++;
  if(!started||finalized){run.violations++;journal(run,'peer.violation',{ordinal,started,finalized});return;}
  if(run.inject&&run.armed&&!run.faults&&++armedFrames===3){run.faultAt=Date.now();run.faults++;run.faultOrdinal=ordinal;journal(run,'peer.fault',{ordinal,frames,armedFrames,code:1001});ws.close(1001,'synthetic peer shutdown');return;}
  if(frames%3===0)ws.send(JSON.stringify({type:'transcription.delta',delta:run.faultAt?'Synthetic recovery words. Synthetic words after reconnect. ':'Synthetic recovery words. '}));
 });
});
function domain(run){
 const meeting={id:'synthetic-browser',source:'meetings',title:'Synthetic capture recovery',status:'recording',started_at:new Date().toISOString(),duration_ms:0,notes_md:'',notes_rev:0,segments:[],audio:{tracks:[]},jobs:{enhance:'idle',transcribe_pending:0},enhanced:null};
 return {meeting,run,chunks:[]};
}
function shell(){return `<!doctype html><html data-skin="nebula"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{--bg:#05030c;--ink:#f3efff;--ink-2:#b9b0d8;--ink-3:#7d74a3;color-scheme:dark}html,body{margin:0;height:100%}.win{height:100%;background:var(--bg)}iframe{width:100%;height:100%;border:0}</style><link rel="stylesheet" href="/wizard-os-home/core/skins.css"></head><body><div class="win"><iframe id="app" allow="microphone;display-capture" src="about:blank"></iframe></div><script>window.WizCore={apps:()=>({APPS:[{id:'mizel',url:'/mizel-live/'}]})};</script><script src="/wizard-os-home/core/app-capture.js"></script><script src="/wizard-os-home/core/appearance-host.js"></script><script src="/wizard-os-home/core/app-services.js"></script><script>const f=document.querySelector('#app');f.src='/mizel-live/';WizAppServices.attach(f,{appId:'mizel',path:'/mizel-live/',isVisible:()=>true,isFront:()=>true});</script></body></html>`;}
const mime=p=>p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html':'application/octet-stream';
let store;
const web=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1'),p=u.pathname;
 const json=x=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(x));};
 if(p==='/'){res.setHeader('content-type','text/html');return res.end(shell());}
 if(p.startsWith('/mizel-live/api/')){
  const route=p.slice('/mizel-live'.length),m=store.meeting;
  if(route==='/api/meetings')return json(req.method==='POST'?m:{meetings:[]});
  if(route===`/api/meetings/${m.id}`)return json(m);
  if(route.endsWith('/audio.wav')){
   assert(store.chunks.length>0);const end=Math.max(...store.chunks.map(c=>Math.round(c.start_ms*16)+(c.wav.length-44)/2));
   const summed=new Int32Array(end);for(const c of store.chunks){const at=Math.round(c.start_ms*16);for(let i=0;i<(c.wav.length-44)/2;i++)summed[at+i]+=c.wav.readInt16LE(44+i*2);}
   const wav=Buffer.alloc(44+end*2);store.chunks[0].wav.copy(wav,0,0,44);wav.writeUInt32LE(wav.length-8,4);wav.writeUInt32LE(end*2,40);for(let i=0;i<end;i++)wav.writeInt16LE(Math.max(-32768,Math.min(32767,summed[i])),44+i*2);
   res.setHeader('content-type','audio/wav');return res.end(wav);
  }
  if(route.endsWith('/chunks')){
   const buffers=[];for await(const b of req)buffers.push(b);const wav=Buffer.concat(buffers);
   assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt16LE(34),16);
   const item={source:u.searchParams.get('source'),seq:+u.searchParams.get('seq'),start_ms:+u.searchParams.get('start_ms'),wav};const prior=store.chunks.find(c=>c.source===item.source&&c.seq===item.seq);if(prior)assert(prior.wav.equals(wav));else store.chunks.push(item);
   m.audio.tracks=[{source:'me',chunks:store.chunks.filter(x=>x.source==='me').length}];m.duration_ms=Math.max(m.duration_ms,item.start_ms+(wav.length-44)/32);
   journal(store.run,'custody.chunk',{source:item.source,chunkSeq:item.seq,start_ms:item.start_ms,pcmBytes:wav.length-44,sha256:hash(wav),duplicate:!!prior});
   return json({stored:true,ok:true,bytes:wav.length,seq:item.seq,source:item.source});
  }
  if(route.endsWith('/stop')){m.status='ready';return json(m);}
  return json({meetings:[],events:[],asks:[],segments:[],pending:0});
 }
 if(p==='/mizel-live/live-health')return json({ok:true,build:'synthetic-fixture'});
 if(p==='/mizel-live/summary'||p==='/mizel-live/asks'||p==='/mizel-live/orb-events')return json({asks:[],events:[]});
 let file;
 if(p.startsWith('/wizard-os-home/core/'))file=path.join(shared,path.basename(p));
 else if(p.startsWith('/wizard-os-home/kit/'))file=path.join(shared,path.basename(p));
 else if(p.startsWith('/mizel-live/'))file=path.join(base,'web',p.slice('/mizel-live/'.length)||'index.html');
 if(file&&fs.existsSync(file)&&fs.statSync(file).isFile()){res.setHeader('content-type',mime(file));return res.end(fs.readFileSync(file));}
 res.statusCode=404;res.end('Synthetic fixture route not provided');
});
const livews=new WebSocketServer({noServer:true});
web.on('upgrade',(req,socket,head)=>{if(new URL(req.url,'http://localhost').pathname!=='/mizel-live/live'){socket.destroy();return;}livews.handleUpgrade(req,socket,head,ws=>livews.emit('connection',ws));});
(async()=>{
 await new Promise(r=>tls.listen(0,'127.0.0.1',r));await new Promise(r=>web.listen(0,'127.0.0.1',r));
 const {TinfoilProvider}=await import('./provider.js');
 livews.on('connection',ws=>{
  const run=mode;
  run.bridgeSockets++;journal(run,'bridge.connect');
  const provider=new TinfoilProvider('synthetic-unused',null,'voxtral-mini-4b-realtime','deepseek-v4-1-flash');
  provider.client={realtime:async props=>{
   const rt=new OpenAIRealtimeWS({...props,options:{ca:cert}},{baseURL:`https://127.0.0.1:${tls.address().port}`,apiKey:'synthetic-unused',_options:{}});
   const n=++run.sdkOpens;journal(run,'sdk.open',{n});
   rt.socket.on('close',code=>journal(run,'sdk.close',{n,code}));return rt;
  }};
  const ctx={provider,Buffer,Date,Math,Number,String,Set,Map,Promise,state:{threads:{}},sockets:new Map(),asksFor:()=>[],publicAsk:x=>x,publicSummary:x=>x,summaryFor:()=>null,startSummaries(){},stopSummaries(){},freezeLiveSummary:()=>false,save(){},logEvent(){},safeClose:s=>{Promise.resolve(s?.close()).catch(()=>{});},COMMIT_MS:6000,FOLLOW_POLL_MS:700,setTimeout:to,setInterval:it,clearTimeout,clearInterval};
  const LiveSession=vm.runInNewContext(source.slice(start,end)+'\nLiveSession',ctx);
  ctx.logEvent=(event,d={})=>journal(run,'server.'+event,{error:d.error,attempt:d.attempt,follow:d.follow});
  const originalSend=ws.send.bind(ws);ws.send=data=>{
   const m=JSON.parse(data);
   if(m.type==='status'){run.statuses.push({live:m.live,reason:m.reason,at:Date.now()});journal(run,'bridge.status',{live:m.live,reason:m.reason});}
   if(m.type==='words'&&m.partial&&!run.wordPhases.includes(run.faults)){run.wordPhases.push(run.faults);journal(run,'bridge.words',{partial:m.partial.slice(-100),phase:run.faults});}
   if(m.type==='settled'){run.settled++;journal(run,'bridge.settled',{text:m.text});}
   originalSend(data);
  };
  const session=new LiveSession(ws);sessions.add(session);
  ws.on('message',(raw,binary)=>{if(binary){run.browserBytes+=raw.length;session.audio(raw);}else{const m=JSON.parse(raw);if(m.type==='start'){journal(run,'bridge.start',{follow:m.follow===true});void session.start(m);}else if(m.type==='stop'){journal(run,'bridge.stop');session.close();ws.close();}}});
  ws.on('close',()=>{session.close();sessions.delete(session);});
 });
 browser=await chromium.launch({headless:true,executablePath:process.env.QA_CHROMIUM,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${process.env.QA_SYNTHETIC_WAV}`]});
 for(const size of [{name:'desktop',width:1440,height:1000},{name:'phone',width:390,height:844}]){
  mode={viewport:size.name,inject:true,armed:false,connections:0,sdkOpens:0,bridgeSockets:0,faults:0,violations:0,providerBytes:0,providerFrames:0,browserBytes:0,statuses:[],settled:0,journal:[],wordPhases:[],passed:false};store=domain(mode);
  report.tests.push(mode);persist();const run=mode;
  const context=await browser.newContext({viewport:{width:size.width,height:size.height},permissions:['microphone'],isMobile:size.name==='phone',hasTouch:size.name==='phone',...(size.name==='phone'?{userAgent:'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'}:{})});
  // No page (including accidental APIs) can leave this synthetic loopback origin.
  const origin=`http://127.0.0.1:${web.address().port}`;
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();currentPage=page;currentViewport=size.name;
  page.on('pageerror',e=>{retain(report.pageErrors,{viewport:size.name,message:e.message});persist();});
  page.on('console',m=>{if(['warning','error'].includes(m.type())){retain(report.console,{viewport:size.name,type:m.type(),text:m.text().slice(0,2000)});persist();}});
  page.on('request',r=>{retain(report.requests,{viewport:size.name,event:'request',method:r.method(),url:r.url(),at:Date.now()});persist();});
  page.on('response',r=>{retain(report.requests,{viewport:size.name,event:'response',method:r.request().method(),url:r.url(),status:r.status(),at:Date.now()});persist();});
  page.on('requestfailed',r=>{retain(report.requests,{viewport:size.name,event:'failed',url:r.url(),error:r.failure()?.errorText,at:Date.now()});persist();});
  await context.addInitScript(()=>{window.__qaInputs=[];for(const name of ['pointerdown','click'])addEventListener(name,e=>{if(window.__qaInputs.length<30)window.__qaInputs.push({event:name,trusted:e.isTrusted,target:e.target.closest?.('button')?.id||e.target.id||e.target.tagName});},true);});
  await page.goto(origin);const frame=page.frameLocator('#app');
  await checkpoint('loaded-before-readiness');
  // The old harness waited for attached HTML, not the synchronous host connection,
  // module boot or the initial shared-capture ownership/recovery pass.
  await page.waitForFunction(()=>{const w=document.querySelector('#app')?.contentWindow,s=window.WizAppCapture?.getState?.();return !!w?.mizel&&w.WizardApp?.hosted===true&&s?.nativeRegistryReady===true&&s.nativeOwnershipReady===true&&!s.active&&!s.hold&&!s.error;},{},{timeout:15000});
  await checkpoint('ready-before-input');
  await frame.locator('#btn-new').waitFor({state:'attached'});const appFrame=page.frames().find(f=>f.url().includes('/mizel-live/'));assert.equal(await appFrame.evaluate(()=>innerWidth),size.width);
  // Observation only: no product objects, timers or callbacks are replaced.
  await page.exposeBinding('__qaTransition',(_source,event)=>journal(run,'browser.transition',event));
  await appFrame.evaluate(outage=>{
   let last='';const observe=()=>{
    const text=document.body.innerText,phase=text.includes(outage)?'outage':text.includes('Synthetic words after reconnect.')?'recovered':text.includes('Synthetic recovery words.')?'baseline':'starting';
    if(phase===last)return;last=phase;const s=parent.WizAppCapture.getState();
    void window.__qaTransition({phase,browserAt:Date.now(),captureId:s.id,active:s.active});
   };
   new MutationObserver(observe).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});observe();
  },OUTAGE);
  const button=size.name==='desktop'?frame.locator('#btn-new'):frame.locator('#btn-new-mobile');await button.click();
  await checkpoint('after-start-click-before-stop-assertion');
  await frame.getByRole('button',{name:'Stop recording',exact:true}).waitFor({timeout:20000});
  await page.waitForFunction(()=>WizAppCapture.getState().active===true);const captureBefore=await page.evaluate(()=>WizAppCapture.getState().id);
  assert(captureBefore,'active capture has an identity before the fault');
  await until(()=>mode.journal.some(e=>e.event==='bridge.words'&&e.phase===0),15000,'real baseline delta before fault');
  // Start the visible-text observer BEFORE closing an owned provider connection.
  // Handle rejection immediately; preserve the original visible assertion below.
  const outageSeen=frame.getByText(OUTAGE,{exact:false}).waitFor({timeout:15000}).then(()=>({ok:true}),e=>({ok:false,error:e.message}));
  mode.armed=true;journal(mode,'rig.armed',{captureId:captureBefore});
  const seen=await outageSeen;assert(seen.ok,'prearmed visible outage observer: '+seen.error);
  await frame.getByText('Live words dropped out, recording continues. Reconnecting…',{exact:false}).waitFor({timeout:15000});
  const shotStart=Date.now();
  await page.screenshot({path:path.join(out,size.name+'-outage.png')});
  const shotEnd=Date.now();journal(mode,'rig.outage-screenshot',{shotStart,shotEnd,file:size.name+'-outage.png'});
  assert(await frame.getByText(OUTAGE,{exact:false}).isVisible(),'outage remains visible after screenshot');
  const during=await page.evaluate(()=>WizAppCapture.getState());
  assert.equal(during.active,true);assert.equal(during.id,captureBefore,'same capture during outage');
  journal(mode,'rig.capture-during-outage',{captureId:during.id,active:during.active});
  await page.waitForTimeout(8500);
  await frame.getByText('Synthetic words after reconnect.',{exact:false}).first().waitFor({timeout:15000});
  await until(()=>mode.journal.some(e=>e.event==='bridge.settled'&&/after reconnect/.test(e.text)),15000,'settled post-recovery words');
  assert.equal(mode.faults,1);assert(mode.statuses.some(s=>!s.live));assert.equal(mode.statuses.at(-1).live,true);assert(mode.connections>=2);assert(mode.settled>=1);assert(mode.browserBytes>32000);assert(mode.providerBytes>32000);
  assert.equal(await page.evaluate(()=>WizAppCapture.getState().id),captureBefore,'live recovery must not replace durable capture');
  const J=mode.journal,ix=(pred,from=0)=>{const i=J.findIndex((e,k)=>k>=from&&pred(e));assert(i>=0,'missing causal step after '+from);return i;};
  const armed=ix(e=>e.event==='rig.armed'),fault=ix(e=>e.event==='peer.fault',armed),sdkClose=ix(e=>e.event==='sdk.close'&&e.code===1001,fault);
  const error=ix(e=>e.event==='server.provider.error',sdkClose);
  assert.equal(J[error].error,'Tinfoil realtime connection closed before transcription completed');
  const down=ix(e=>e.event==='bridge.status'&&e.live===false,error);assert.equal(J[down].reason,OUTAGE);
  const shot=ix(e=>e.event==='rig.outage-screenshot',down),reopen=ix(e=>e.event==='sdk.open',down),up=ix(e=>e.event==='bridge.status'&&e.live===true,reopen);
  assert(J[reopen].at-J[down].at>=1900,'unmodified product retry timer');
  assert(J[shot].shotEnd<J[up].at,'screenshot completed within genuine live:false window');
  const generation=ix(e=>e.event==='peer.generation'&&e.ordinal>mode.faultOrdinal,up);
  ix(e=>e.event==='bridge.words'&&/after reconnect/.test(e.partial),generation);
  for(const phase of ['outage','recovered']){const event=J[ix(e=>e.event==='browser.transition'&&e.phase===phase,down)];assert.equal(event.active,true);assert.equal(event.captureId,captureBefore);}
  assert.equal(mode.bridgeSockets,1,'same browser socket and LiveSession');assert.equal(mode.violations,0);
  assert(J[fault].at-J[armed].at<2000,'prompt bounded synthetic fault');
  assert(J.filter(e=>e.event==='bridge.start').every(e=>e.follow===false),'socket audio, not follow');
  mode.causalProof={armed,fault,sdkClose,error,down,shot,reopen,up,generation,captureId:captureBefore};persist();
  for(const skin of ['nebula','grove']){
   await page.evaluate(skin=>{document.documentElement.dataset.skin=skin;WizAppearance.sync();},skin);
   await page.waitForTimeout(300);
   const app=page.frames().find(f=>f.url().includes('/mizel-live/'));
   assert.equal(await app.evaluate(()=>document.documentElement.dataset.skin),skin);
   await page.screenshot({path:path.join(out,`${size.name}-${skin}.png`)});
  }
  await frame.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.waitForFunction(()=>WizAppCapture.getState().active===false,{},{timeout:20000});await page.waitForTimeout(1500);
  const pending=await page.evaluate(()=>WizAppCapture.pending('mizel'));
  assert.equal(pending.length,0,'synthetic API readback must let the real app acknowledge retained capture');
  assert(store.chunks.length>0);const ordered=store.chunks.filter(c=>c.source==='me').sort((a,b)=>a.seq-b.seq);for(let i=0;i<ordered.length;i++)assert.equal(ordered[i].seq,i);
  mode.custody={chunks:ordered.length,pcmBytes:ordered.reduce((n,c)=>n+c.wav.length-44,0),sha256:hash(Buffer.concat(ordered.map(c=>c.wav.subarray(44)))),captureIdRetained:true,acknowledged:true};
  journal(mode,'custody.final',{...mode.custody,browserBytes:mode.browserBytes,pending:pending.length});
  assert(mode.custody.pcmBytes>=mode.browserBytes,'durable upload includes the PCM sent to live words');
  mode.passed=true;persist();await context.close();
 }
 assert.equal(report.pageErrors.length,0);report.passed=true;
})().catch(async e=>{report.failure={name:e.name,message:e.message,stack:e.stack};process.exitCode=1;persist();await checkpoint('failed-before-cleanup');}).finally(async()=>{
 try{await browser?.close();}catch(_){}for(const s of sessions)s.close();for(const t of timers){clearTimeout(t);clearInterval(t);}for(const s of sockets)s.terminate();for(const s of livews.clients)s.terminate();peer.close();livews.close();tls.close();web.close();
 persist();console.log(JSON.stringify(report,null,2));setTimeout(()=>process.exit(process.exitCode||0),200).unref();
});
