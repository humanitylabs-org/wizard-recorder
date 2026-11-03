// Synthetic-only diagnostic. No production service, meeting API, state or logs are read.
// Run only via the owner's admitted forum worker. The exact served LiveSession body
// is executed unchanged; domain storage/summary callbacks are inert synthetic fakes.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TinfoilProvider } from '../adoptions/mizel-live/provider.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.env.QA_OUT || 'diagnostic-evidence');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const key=fs.readFileSync(process.env.QA_TINFOIL_KEY_FILE,'utf8').trim();
if(!key)throw Error('Missing diagnostic credential');
const pcm=fs.readFileSync(process.env.QA_SYNTHETIC_PCM);
const model='voxtral-mini-4b-realtime';
const summaryModel='deepseek-v4-1-flash';
const started=Date.now();
const events=[];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const error=e=>({name:String(e?.name||''),code:e?.code??e?.error?.code??null,status:e?.status??null,message:String(e?.message||e?.error?.message||e||'').replaceAll(key,'[REDACTED]').slice(0,1000)});
const record=(event,fields={})=>{events.push({atMs:Date.now()-started,event,...fields});fs.writeFileSync(path.join(out,'synthetic-events.json'),JSON.stringify(events,null,2)+'\n');};
const source=fs.readFileSync(path.join(root,'adoptions/mizel-live/server.mjs'),'utf8');
const begin=source.indexOf('class LiveSession {');const end=source.indexOf('// ───────────── HTTP:',begin);
if(begin<0||end<0)throw Error('LiveSession source boundary changed');
const report={syntheticOnly:true,reviewRequired:true,productionAcceptance:false,model,summaryModel,sourceSha256:hash(source),providerSha256:hash(fs.readFileSync(path.join(root,'adoptions/mizel-live/provider.js'))),pcmSha256:hash(pcm),pcmBytes:pcm.length,phases:{}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const timers=new Set();
function interval(fn,ms){const t=setInterval(fn,ms);timers.add(t);return t;}
function timeout(fn,ms){const t=setTimeout(fn,ms);timers.add(t);return t;}
let session;
try {
  // Phase 1: the exact deployed provider, with no meeting server involved.
  let deltas=0,completed=0,failures=0;
  const provider=new TinfoilProvider(key,null,model,summaryModel);
  const stream=await provider.openRealtime({created:()=>record('direct.created'),delta:t=>{if(t)deltas++;},completed:t=>{if(t)completed++;record('direct.completed',{nonempty:!!t});},error:e=>{failures++;record('direct.error',error(e));}});
  for(let n=0;n<72;n++){
    const at=(n*8000)%pcm.length;
    stream.append(pcm.subarray(at,Math.min(pcm.length,at+8000)));
    if(n&&n%24===0){stream.commit();record('direct.commit');}
    await sleep(250);
  }
  try{await stream.close();record('direct.closed');}catch(e){failures++;record('direct.close_error',error(e));}
  report.phases.provider={deltas,completed,failures};
  // Phase 2: unchanged production session + provider, fake only domain state/socket.
  const sockets=new Map();const statuses=[];let words=0,settled=0;
  const ws={readyState:1,send:s=>{const m=JSON.parse(s);if(m.type==='status'){statuses.push({atMs:Date.now()-started,...m});record('session.status',{live:m.live,reason:m.reason||''});}if(m.type==='words'&&m.partial)words++;if(m.type==='settled'&&m.text)settled++;},close:()=>{ws.readyState=3;}};
  const context={provider:new TinfoilProvider(key,null,model,summaryModel),state:{threads:{}},sockets,asksFor:()=>[],publicAsk:x=>x,publicSummary:x=>x,summaryFor:()=>null,startSummaries:()=>{},stopSummaries:()=>{},freezeLiveSummary:()=>false,save:()=>{},logEvent:(event,data)=>record(event,{attempt:data.attempt??null,retryMs:data.retryMs??null,...(data.error?{error:String(data.error).replaceAll(key,'[REDACTED]')}:{}),...(data.status?{status:data.status}:{}),...(data.code?{code:data.code}:{})}),safeClose:(s)=>{try{Promise.resolve(s?.close()).catch(e=>record('session.close_error',error(e)));}catch(e){record('session.close_error',error(e));}},COMMIT_MS:6000,FOLLOW_POLL_MS:700,FOLLOW_FRAME_MS:40,FOLLOW_GAP_SKIP_MS:15000,FOLLOW_IDLE_CLOSE_MS:2700000,Buffer,Date,Math,Number,String,Set,Map,Promise,clearTimeout,clearInterval,setInterval:interval,setTimeout:timeout};
  const LiveSession=vm.runInNewContext(source.slice(begin,end)+'\nLiveSession',context,{filename:'exact-served-LiveSession.mjs'});
  session=new LiveSession(ws);
  await session.start({meetingId:'synthetic_reconnect_only',title:'Synthetic audio transport diagnostic',baseMs:0,follow:false});
  for(let n=0;n<144;n++){
    const at=(n*8000)%pcm.length;session.audio(pcm.subarray(at,Math.min(pcm.length,at+8000)));await sleep(250);
  }
  report.phases.liveSession={words,settled,statuses,audioMs:session.audioMs,opening:!!session.opening,streamPresent:!!session.stream,earlyBytes:session.earlyBytes||0};
  session.close();
  report.diagnosis=(failures||statuses.some(s=>!s.live))?'synthetic_provider_or_session_failure_observed':'not_reproduced_in_synthetic_provider_and_extracted_session';
} catch(e){report.fatal=error(e);record('diagnostic.error',report.fatal);process.exitCode=1;}
finally{
  session?.close();for(const t of timers){clearInterval(t);clearTimeout(t);}
  report.durationMs=Date.now()-started;fs.writeFileSync(path.join(out,'diagnostic.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  // SDK sockets that failed during attestation must not keep a diagnostic running.
  setTimeout(()=>process.exit(process.exitCode||0),200).unref();
}
