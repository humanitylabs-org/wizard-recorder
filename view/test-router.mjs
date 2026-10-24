import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { LiveClient } from './live-client.js';
import { RouterModels } from './router-models.js';
import { parseSummaryDelta } from './summary.js';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-router-'));
const grant = 'synthetic-app-grant';
const requests = [], liveFrames = [], txRequests = [], peers = new Set();
let mode = 'ok', readyDelay = 0;
const done = { type:'done', provider:'fixture-private', model:'fixture-text', tier:'fast', tested_on:'deepseek-v4-1-flash', chosen:'owner-swap', usage:{output_tokens:12} };
const fake = http.createServer(async (req, res) => {
  const parts=[]; for await(const chunk of req) parts.push(chunk);
  const raw=Buffer.concat(parts);
  if(req.url==='/v1/audio/transcriptions') {
    txRequests.push(raw);
    res.writeHead(200, {'Content-Type':'application/json'});return res.end(JSON.stringify({text:'The purple bicycle is beside the library.'}));
  }
  requests.push({url:req.url, headers:req.headers, body:JSON.parse(raw)});
  if(req.headers['x-wizard-grant']!==grant){res.writeHead(403);return res.end();}
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  let text=req.url.includes('live-summary')?JSON.stringify({topicChanged:false,title:'Library',newBullets:[{text:'The bicycle is beside the library.',atMs:0}]}):'# Library\n\n## Summary\n- The purple bicycle is beside the library. [E1]';
  if(mode==='invalid-json')text='{"title":"Missing bullets"}';
  if(mode==='ungrounded')text=JSON.stringify({title:'Wrong time',newBullets:[{text:'Invalid',atMs:999999}]});
  // Deliberately fragment UTF-8/SSE transport across writes, use both event kinds.
  const event=(type,text)=>`event: ${type}\r\ndata: ${JSON.stringify({type,text})}\r\n\r\n`;
  const stream=event('delta',text.slice(0,12))+event('text',text.slice(12));
  res.write(stream.slice(0,9));res.write(stream.slice(9));
  if(mode==='error')res.write('event: error\ndata: {"type":"error","code":"signed_out"}\n\n');
  else if(mode!=='truncated')res.write(`event: done\ndata: ${JSON.stringify(mode==='bad-done'?{type:'done'}:mode==='bad-chosen'?{...done,chosen:true}:{...done,tier:req.url.includes('recap')?'standard':'fast'})}\n\n`);
  res.end();
});
const wss = new WebSocketServer({noServer:true});
fake.on('upgrade',(req,socket,head)=>{
  requests.push({url:req.url,headers:req.headers});
  if(req.url!=='/v1/services/live-transcription/v1/live' || req.headers['x-wizard-grant']!==grant)return socket.destroy();
  wss.handleUpgrade(req,socket,head,ws=>{
    peers.add(ws);ws.on('close',()=>peers.delete(ws));
    let ready=false, audio=0;
    ws.on('message',(raw,binary)=>{
      if(binary){
        assert.equal(ready,true,'audio is buffered until ready');assert.ok(raw.length<=65536);
        audio+=raw.length;liveFrames.push({binary:true,bytes:raw.length});
        ws.send(JSON.stringify({type:'delta',text:'The purple bicycle'}));return;
      }
      const frame=JSON.parse(raw.toString());liveFrames.push(frame);
      if(frame.type==='start'){
        assert.deepEqual(frame,{type:'start',format:'pcm_s16le',sample_rate:16000,channels:1,language:null});
        setTimeout(()=>{if(ws.readyState===1){ready=true;ws.send(JSON.stringify({type:'ready',provider:'fixture-private',model:'fixture-live'}));}},readyDelay);
      } else if(frame.type==='commit' || frame.type==='stop'){
        if(audio){ws.send(JSON.stringify({type:'final',text:'The purple bicycle is beside the library.'}));audio=0;}
        if(frame.type==='stop'){ws.send(JSON.stringify({type:'closed'}));ws.close();}
      }
    });
  });
});
await new Promise(r=>fake.listen(0,'127.0.0.1',r));
const router='http://127.0.0.1:'+fake.address().port;
const reserved=http.createServer();await new Promise(r=>reserved.listen(0,'127.0.0.1',r));const apiPort=reserved.address().port;await new Promise(r=>reserved.close(r));
const childEnv={...process.env,MEETINGS_DATA:data,MEETINGS_ALLOWED_HOSTS:`127.0.0.1:8080`,TRANSCRIPTION_URL:router+'/v1/audio/transcriptions',WIZARD_ROUTER_URL:router,WIZARD_ROUTER_GRANT:grant};
for(const key of Object.keys(childEnv))if(/API_KEY|MEETINGS_LLM_|RECORDER_REALTIME_MODEL/.test(key))delete childEnv[key];
const python=spawn(process.env.RECORDER_TEST_PYTHON||'python3',['-m','uvicorn','server:app','--host','127.0.0.1','--port',String(apiPort),'--log-level','warning'],{cwd:new URL('../app/',import.meta.url),env:childEnv,stdio:['ignore','pipe','pipe']});
let pythonLog='';python.stdout.on('data',b=>pythonLog+=b);python.stderr.on('data',b=>pythonLog+=b);
async function until(fn, timeout=15000){
  const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,30));}
  throw Error('Timed out waiting for fixture result: '+pythonLog);
}
after(async()=>{
  for(const ws of peers)ws.terminate();
  python.kill('SIGTERM');await Promise.race([once(python,'exit'),new Promise(r=>setTimeout(r,1000))]);if(python.exitCode===null)python.kill('SIGKILL');
  await new Promise(r=>fake.close(r));wss.close();fs.rmSync(data,{recursive:true,force:true});
});
// Probe like the bridge does: the API allow-lists only the public Host, which fetch() cannot set.
await until(()=>new Promise(resolve=>{const r=http.get({host:'127.0.0.1',port:apiPort,path:'/healthz',headers:{host:'127.0.0.1:8080'}},res=>{res.resume();resolve(res.statusCode===200);});r.on('error',()=>resolve(false));}));
Object.assign(process.env,{NODE_ENV:'test',MEETINGS_DATA:data,RECORDER_API_PORT:String(apiPort),WIZARD_ROUTER_URL:router,WIZARD_ROUTER_GRANT:grant});
const {server}=await import('./server.mjs');await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port+'/wizard-recorder';
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
async function api(p,body,method='POST'){
  const response=await fetch(base+p,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  assert.ok(response.ok,await response.clone().text());return response.json();
}
function wav(){
  const pcm=Buffer.alloc(32000);for(let i=0;i<16000;i++)pcm.writeInt16LE(i%2?500:-500,i*2);
  const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(pcm.length+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(pcm.length,40);return Buffer.concat([b,pcm]);
}

test('Router grant enables capabilities without any provider key env',async()=>{
  const health=await api('/live-health',undefined,'GET');assert.equal(health.realtime,true);assert.equal(health.summaries,true);
  assert.ok(!Object.keys(childEnv).some(k=>/API_KEY|MEETINGS_LLM_|RECORDER_REALTIME_MODEL/.test(k)));
  for(const filename of ['../runtipi/config.json','../runtipi/compose.yaml','package.json'])assert.doesNotMatch(fs.readFileSync(new URL(filename,import.meta.url),'utf8'),/API_KEY|MEETINGS_LLM_|"tinfoil"/);
});

test('live client buffers binary and commit before ready, splits 64 KiB, stop drains final',async()=>{
  readyDelay=60;const completed=[],deltas=[],failures=[];
  const client=new LiveClient(router,grant).realtime({delta:x=>deltas.push(x.delta),completed:x=>completed.push(x.transcript),failed:x=>failures.push(x)});
  client.append(Buffer.alloc(70000));client.commit();client.append(Buffer.alloc(32000));client.close();
  await until(()=>completed.length===2);await until(()=>liveFrames.some(x=>x.type==='stop'));
  assert.ok(deltas.length);assert.deepEqual(failures,[]);assert.equal(liveFrames.filter(x=>x.binary).reduce((n,x)=>n+x.bytes,0),102000);readyDelay=0;
});

test('browser /live words + saved final, Router failure leaves recording + shared batch + recap working',async()=>{
  const m=await api('/api/meetings',{title:'Synthetic live session'}),mid=m.id;
  const ws=new WebSocket(base.replace('http:','ws:')+'/live'),messages=[];
  ws.on('message',b=>messages.push(JSON.parse(b.toString())));await once(ws,'open');
  ws.send(JSON.stringify({type:'start',meetingId:mid}));
  await until(()=>messages.some(x=>x.type==='status'&&x.live));
  ws.send(Buffer.alloc(32000));ws.send(JSON.stringify({type:'pause'}));
  await until(()=>messages.some(x=>x.type==='words'&&x.partial));
  await until(()=>messages.some(x=>x.type==='settled'));
  const archive=JSON.parse(fs.readFileSync(path.join(data,'live',mid+'.jsonl'),'utf8').trim());assert.match(archive.text,/purple bicycle/);
  const caption=messages.find(x=>x.type==='settled');assert.equal(caption.text,archive.text);
  for(const peer of peers)peer.terminate();
  await until(()=>messages.some(x=>x.type==='status'&&x.live===false));
  assert.equal((await api('/api/meetings/'+mid,undefined,'GET')).status,'recording');
  const upload=await fetch(base+`/api/meetings/${mid}/chunks?source=me&seq=0&start_ms=0`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:wav()});assert.equal(upload.status,200);
  await until(async()=>{const m=await api('/api/meetings/'+mid,undefined,'GET');return m.segments.length&&m;});
  const outline=await api('/summary?meetingId='+mid,undefined,'GET');assert.equal(outline.summary.topics[0].bullets[0].atMs,0);assert.equal(outline.summary.provenance.provider,done.provider);
  ws.send(JSON.stringify({type:'stop'}));await once(ws,'close');
  await api('/api/meetings/'+mid+'/stop',{final_seq:{me:0}});
  const saved=await until(async()=>{const m=await api('/api/meetings/'+mid,undefined,'GET');return m.status==='ready'&&m.enhanced&&m;});
  assert.match(saved.segments[0].text,/purple bicycle/);assert.match(saved.enhanced.markdown,/\[E1\]/);assert.equal(saved.enhanced.provenance.model,done.model);
  assert.equal((await fetch(base+'/api/meetings/'+mid+'/audio.wav')).status,200);
  assert.ok(txRequests.length);assert.match(txRequests[0].toString(),/name="model"/);
  assert.ok(requests.some(x=>x.url==='/v1/models/recap/run'));assert.ok(requests.some(x=>x.url==='/v1/models/live-summary/run'));
  for(const request of requests){assert.equal(request.headers['x-wizard-grant'],grant);assert.equal(request.headers.authorization,undefined);if(request.body){assert.equal(request.body.stream,true);assert.equal(typeof request.body.system,'string');assert.equal(request.body.model,undefined);assert.ok(request.body.messages.every(m=>m.role!=='system'));}}
});

test('strict summary validator and Router SSE reject provisional, error and malformed output',async()=>{
  const models=new RouterModels(router,grant);
  for(const failure of ['truncated','error','bad-done','bad-chosen','invalid-json','ungrounded']){
    mode=failure;await assert.rejects(()=>models.summarize({activeTopic:null,transcript:[{text:'fixture',startMs:0,endMs:1000}]}));
  }
  mode='ok';
  for(const bad of ['null','[]','{"title":"x"}','{"title":"x","newBullets":[{"text":"x","atMs":-1}]}','{"title":"x","newBullets":[{"text":"x","atMs":0.5}]}'])assert.throws(()=>parseSummaryDelta(bad));
  const result=await models.summarize({activeTopic:null,transcript:[{text:'fixture',startMs:0,endMs:1000}]});assert.equal(result.delta.newBullets.length,1);
});
