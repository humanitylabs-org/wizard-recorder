// Synthetic upstreams only. Run on a Docker --internal network; no production credentials.
import http from 'node:http';
import {WebSocketServer} from '/app/view/node_modules/ws/wrapper.mjs';
const text='The synthetic purple bicycle is beside the library and the next action is to test recording parity.';
const log=[], runs=new Map();
const provenance={type:'done',provider:'synthetic-private',model:'synthetic-model',tier:'fast',tested_on:'synthetic-model',chosen:'match',usage:{}};
const agents=[{id:'fixture-helper',label:'Fixture guide',is_default:true,privacy:'standard',status:'running'},{id:'fixture-local',label:'Local private guide',privacy:'private',status:'running'}];
const server=http.createServer(async(req,res)=>{
  let chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);let body={};try{body=JSON.parse(raw)}catch{}
  const p=new URL(req.url,'http://fixture').pathname;log.push({method:req.method,path:p,agent:body.agent,session_id:body.session_id,bytes:raw.length});
  const send=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
  if(p==='/qa/log')return send({log,runs:[...runs.values()]});
  if(p==='/wizard/v1/agents')return send({agents});
  if(p==='/v1/audio/transcriptions')return send({text,segments:[{start:0,end:1,text}]});
  if(p.startsWith('/v1/models/')){
    const input=body.messages?.[0]?.content;let parsed={};try{parsed=JSON.parse(input)}catch{}
    const atMs=parsed.transcript?.[0]?.startMs??0;
    const answer=p.includes('live-summary')?JSON.stringify({topicChanged:false,title:'Synthetic parity',newBullets:[{text:'Test recording parity',atMs}]}):'# Synthetic recap\n\n- Test recording parity.';
    res.setHeader('Content-Type','text/event-stream');res.end('event: delta\ndata: '+JSON.stringify({type:'delta',text:answer})+'\n\nevent: done\ndata: '+JSON.stringify(provenance)+'\n\n');return;
  }
  if(p==='/api/sessions' && req.method==='POST')return send({id:body.session_id,session_id:body.session_id});
  if(p.startsWith('/api/sessions/')&&req.method==='PATCH')return send({ok:true});
  if(p==='/v1/runs'&&req.method==='POST'){const run={run_id:'synthetic-run-'+runs.size,session_id:body.session_id,agent:body.agent,status:'completed',output:'Synthetic dispatched answer',idempotency_key:req.headers['idempotency-key']};runs.set(run.run_id,run);return send(run);}
  if(p.startsWith('/v1/runs/'))return send(runs.get(p.split('/').pop())||{status:'completed',output:'Synthetic dispatched answer'});
  if(p.includes('/messages'))return send({data:[],pagination:{has_more:false}});
  send({ok:true});
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/v1/services/live-transcription/v1/live' || req.headers['x-wizard-grant']!=='synthetic-grant')return socket.destroy();
  log.push({method:'WS',path:req.url});
  wss.handleUpgrade(req,socket,head,ws=>{let audio=0;ws.on('message',(raw,binary)=>{if(binary){audio+=raw.length;return ws.send(JSON.stringify({type:'delta',text:'The synthetic purple bicycle'}));}const m=JSON.parse(raw);if(m.type==='start')ws.send(JSON.stringify({type:'ready',provider:'synthetic-private',model:'synthetic-live'}));if(['commit','stop'].includes(m.type)&&audio){ws.send(JSON.stringify({type:'final',text}));audio=0;}if(m.type==='stop'){ws.send(JSON.stringify({type:'closed'}));ws.close();}});});
});
server.listen(9100,'0.0.0.0');
