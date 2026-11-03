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
const report={syntheticOnly:true,productionAcceptance:false,providerRouteChanged:false,tests:[],source:{},warnings:[],pageErrors:[]};
for(const p of ['web/app.js','server.mjs','provider.js'])report.source[p]=hash(fs.readFileSync(path.join(base,p)));
for(const p of ['app-capture.js','app-client.js','app-services.js','appearance-host.js','skins.css'])report.source['shared/'+p]=hash(fs.readFileSync(path.join(shared,p)));
let browser;const sessions=new Set(),timers=new Set(),sockets=new Set();let mode=null;
const it=(fn,ms)=>{const t=setInterval(fn,ms);timers.add(t);return t;};
const to=(fn,ms)=>{const t=setTimeout(fn,ms);timers.add(t);return t;};
const source=fs.readFileSync(path.join(base,'server.mjs'),'utf8');
const start=source.indexOf('class LiveSession {'),end=source.indexOf('// ───────────── HTTP:',start);
assert(start>0&&end>start);
const tls=https.createServer({key,cert}),peer=new WebSocketServer({server:tls});
peer.on('connection',ws=>{
 sockets.add(ws);ws.on('close',()=>sockets.delete(ws));const run=mode;run.connections++;const ordinal=run.connections;
 ws.send(JSON.stringify({type:'session.created'}));let frames=0;
 ws.on('message',raw=>{
  const m=JSON.parse(raw);
  if(m.type==='input_audio_buffer.append'){
   const pcm=Buffer.from(m.audio,'base64');run.providerBytes+=pcm.length;run.providerFrames++;frames++;
   if(run.inject&&ordinal===1&&frames===3){run.faultAt=Date.now();run.faults++;ws.close(1001,'synthetic peer shutdown');return;}
   if(frames%3===0)ws.send(JSON.stringify({type:'transcription.delta',delta:'Synthetic recovery words. '}));
  }
  if(m.type==='input_audio_buffer.commit')ws.send(JSON.stringify({type:'transcription.done',text:'Synthetic recovery words.'}));
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
   return json({ok:true,bytes:wav.length,seq:item.seq,source:item.source});
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
  const provider=new TinfoilProvider('synthetic-unused',null,'voxtral-mini-4b-realtime','deepseek-v4-1-flash');
  provider.client={realtime:async props=>new OpenAIRealtimeWS({...props,options:{ca:cert}},{baseURL:`https://127.0.0.1:${tls.address().port}`,apiKey:'synthetic-unused',_options:{}})};
  const ctx={provider,Buffer,Date,Math,Number,String,Set,Map,Promise,state:{threads:{}},sockets:new Map(),asksFor:()=>[],publicAsk:x=>x,publicSummary:x=>x,summaryFor:()=>null,startSummaries(){},stopSummaries(){},freezeLiveSummary:()=>false,save(){},logEvent(){},safeClose:s=>{Promise.resolve(s?.close()).catch(()=>{});},COMMIT_MS:6000,FOLLOW_POLL_MS:700,setTimeout:to,setInterval:it,clearTimeout,clearInterval};
  const LiveSession=vm.runInNewContext(source.slice(start,end)+'\nLiveSession',ctx);
  const originalSend=ws.send.bind(ws);ws.send=data=>{const m=JSON.parse(data);if(m.type==='status')run.statuses.push({live:m.live,at:Date.now()});if(m.type==='settled')run.settled++;originalSend(data);};
  const session=new LiveSession(ws);sessions.add(session);
  ws.on('message',(raw,binary)=>{if(binary){run.browserBytes+=raw.length;session.audio(raw);}else{const m=JSON.parse(raw);if(m.type==='start')void session.start(m);else if(m.type==='stop'){session.close();ws.close();}}});
  ws.on('close',()=>{session.close();sessions.delete(session);});
 });
 browser=await chromium.launch({headless:true,executablePath:process.env.QA_CHROMIUM,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${process.env.QA_SYNTHETIC_WAV}`]});
 for(const size of [{name:'desktop',width:1440,height:1000},{name:'phone',width:390,height:844}]){
  mode={viewport:size.name,inject:true,connections:0,faults:0,providerBytes:0,providerFrames:0,browserBytes:0,statuses:[],settled:0};store=domain(mode);
  const context=await browser.newContext({viewport:{width:size.width,height:size.height},permissions:['microphone'],isMobile:size.name==='phone',hasTouch:size.name==='phone',...(size.name==='phone'?{userAgent:'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'}:{})});
  // No page (including accidental APIs) can leave this synthetic loopback origin.
  const origin=`http://127.0.0.1:${web.address().port}`;
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push({viewport:size.name,message:e.message}));
  await page.goto(origin);const frame=page.frameLocator('#app');
  await frame.locator('#btn-new').waitFor({state:'attached'});const appFrame=page.frames().find(f=>f.url().includes('/mizel-live/'));assert.equal(await appFrame.evaluate(()=>innerWidth),size.width);
  const button=size.name==='desktop'?frame.locator('#btn-new'):frame.locator('#btn-new-mobile');await button.click();
  await frame.getByRole('button',{name:'Stop recording',exact:true}).waitFor({timeout:20000});
  await frame.getByText('Live words dropped out, recording continues. Reconnecting…',{exact:false}).waitFor({timeout:15000});
  await page.screenshot({path:path.join(out,size.name+'-outage.png')});
  await page.waitForFunction(()=>WizAppCapture.getState().active===true);const captureBefore=await page.evaluate(()=>WizAppCapture.getState().id);
  await page.waitForTimeout(8500);
  assert.equal(mode.faults,1);assert(mode.statuses.some(s=>!s.live));assert.equal(mode.statuses.at(-1).live,true);assert(mode.connections>=2);assert(mode.settled>=1);assert(mode.browserBytes>32000);assert(mode.providerBytes>32000);
  assert.equal(await page.evaluate(()=>WizAppCapture.getState().id),captureBefore,'live recovery must not replace durable capture');
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
  assert(mode.custody.pcmBytes>=mode.browserBytes,'durable upload includes the PCM sent to live words');
  report.tests.push(mode);await context.close();
 }
 assert.equal(report.pageErrors.length,0);report.passed=true;
})().catch(e=>{report.failure={name:e.name,message:e.message,stack:e.stack};process.exitCode=1;}).finally(async()=>{
 try{await browser?.close();}catch(_){}for(const s of sessions)s.close();for(const t of timers){clearTimeout(t);clearInterval(t);}for(const s of sockets)s.terminate();for(const s of livews.clients)s.terminate();peer.close();livews.close();tls.close();web.close();
 fs.writeFileSync(path.join(out,'browser-recovery.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));setTimeout(()=>process.exit(process.exitCode||0),200).unref();
});
