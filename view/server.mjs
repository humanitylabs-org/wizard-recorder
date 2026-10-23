// Recorder's own view and same-origin API front. No host files or raw agent APIs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TinfoilProvider } from './provider.js';
import { OrbEvents } from './orb-events.mjs';

const WEB=fileURLToPath(new URL('./web/',import.meta.url));
const DATA=process.env.MEETINGS_DATA || '/data';
const BASE='/wizard-recorder';
const UP={host:'127.0.0.1',port:Number(process.env.RECORDER_API_PORT||8081),base:''};
const MEETINGS_AUDIO=path.join(DATA,'audio');
const FOLLOW_POLL_MS=700,FOLLOW_FRAME_MS=40,FOLLOW_GAP_SKIP_MS=15000,FOLLOW_IDLE_CLOSE_MS=45*60*1000,COMMIT_MS=6000;
export function capabilities(env=process.env) {
  return {realtime:!!env.TINFOIL_API_KEY,
    summaries:!!((env.WIZARD_ROUTER_URL && env.WIZARD_ROUTER_GRANT)||(env.MEETINGS_LLM_URL && env.MEETINGS_LLM_MODEL)),
    agent:!!(env.WIZARD_DELIVERY_URL && env.WIZARD_DELIVERY_TOKEN),orb:env.RECORDER_ORB_EVENTS==='1'};
}
const caps=capabilities();
const provider=caps.realtime?new TinfoilProvider(process.env.TINFOIL_API_KEY,null,process.env.RECORDER_REALTIME_MODEL||'voxtral-mini-4b-realtime'):null;
const events=caps.orb?new OrbEvents(path.join(DATA,'orb-events.json')):null;
const sockets=new Map(),state={asks:{},threads:{}};
const asksFor=()=>[], publicAsk=x=>x, publicSummary=x=>x, summaryFor=()=>null;
const startSummaries=()=>{},stopSummaries=()=>{},freezeLiveSummary=()=>false,save=()=>{};
function logEvent(event,data={}) {console.log(JSON.stringify({event,...data}));}
function broadcast(mid,value){for(const s of sockets.get(mid)||[])s.send(value);}
function safeClose(stream,mid){try{Promise.resolve(stream?.close()).catch(()=>logEvent('realtime.close_error',{mid}));}catch{}}

class LiveSession {
  constructor(ws) {
    this.ws = ws; this.meetingId = null; this.title = ''; this.stream = null; this.closed = false;
    this.finals = '';            // settled words of this stream
    this.partial = '';           // words still being heard
    this.consumed = 0;           // offset in finals+partial already judged
    this.audioBytes = 0; this.lastCommitBytes = 0; this.lastCommitAt = Date.now();
    this.judging = false; this.rejudge = false; this.idleTimer = null; this.unfinishedSince = 0;
    this.pending = null;         // a request the assistant is still listening to
    this.lastWordsAt = 0;
  }
  send(msg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }
  get audioMs() { return Math.round(this.audioBytes / 32); }
  async start(msg) {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(String(msg.meetingId || ''))) return this.fail('bad meeting id');
    this.meetingId = msg.meetingId; this.title = String(msg.title || '').slice(0, 120);
    this.follow = msg.follow === true;  // phone recording: read its uploaded chunks instead of socket audio
    this.baseMs = Math.max(0, Math.min(24 * 3600e3, Number(msg.baseMs) || 0)); this.segStartMs = 0;
    if (!sockets.has(this.meetingId)) sockets.set(this.meetingId, new Set());
    sockets.get(this.meetingId).add(this);
    this.send({ type: 'ready', asks: asksFor(this.meetingId).map(publicAsk), threadId: state.threads[this.meetingId] || null, summary: publicSummary(summaryFor(this.meetingId)) });
    startSummaries(this.meetingId);
    await this.openStream();
  }
  // Opens the attested realtime stream. When the provider is unreachable the recording carries on and
  // this keeps retrying (2 s → 30 s) for as long as the socket lives, telling the view plainly meanwhile.
  async openStream() {
    if (this.closed || this.stream || this.opening) return;
    this.opening = true;
    try {
      this.stream = await provider.openRealtime({
        delta: (t) => this.onDelta(t), completed: (t) => this.onCompleted(t), error: (e) => this.onProviderError(e),
      });
    } catch (e) {
      this.opening = false;
      const wait = [2000, 4000, 8000, 15000, 30000][Math.min(this.openFailures = (this.openFailures || 0) + 1, 5) - 1];
      logEvent('provider.blocked', { meetingId: this.meetingId, error: e.message, attempt: this.openFailures, retryMs: wait });
      this.send({ type: 'status', live: false, retrying: true, reason: 'Live words unavailable, recording continues. Retrying…' });
      if (!this.closed) this.reopenTimer = setTimeout(() => void this.openStream(), wait);
      return;
    }
    this.opening = false;
    if (this.closed) { safeClose(this.stream, this.meetingId); this.stream = null; return; }
    for (const b of this.early || []) { this.stream.append(b); this.audioBytes += b.length; }
    this.early = null; this.earlyBytes = 0;
    this.send({ type: 'status', live: true });
    clearInterval(this.commitTimer); this.commitTimer = setInterval(() => this.maybeCommit(false), 250);
    if (this.follow && !this.followTimer) this.startFollow();
    else if (this.follow) this.followSeq = null; // after a reconnect, pick up at the newest chunk rather than replaying the backlog
    logEvent('live.started', { meetingId: this.meetingId, follow: !!this.follow, attempt: (this.openFailures || 0) + 1 });
    this.openFailures = 0;
  }
  // ── follow mode: feed the chunks the phone has uploaded ──
  startFollow() {
    this.followDir = path.join(MEETINGS_AUDIO, this.meetingId, 'me');
    this.followSeq = null; this.followBusy = false; this.followGapSince = 0; this.followLastAt = Date.now();
    this.followTimer = setInterval(() => void this.followTick(), FOLLOW_POLL_MS);
    void this.followTick();
  }
  followSeqs() {
    try { return fs.readdirSync(this.followDir).filter((f) => /^\d{6}\.wav$/.test(f)).map((f) => Number(f.slice(0, 6))).sort((a, b) => a - b); }
    catch { return []; }
  }
  chunkPcm(seq) {
    const buf = fs.readFileSync(path.join(this.followDir, `${String(seq).padStart(6, '0')}.wav`));
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return Buffer.alloc(0);
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
      if (id === 'data') { const pcm = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)); return pcm.subarray(0, pcm.length - (pcm.length % 2)); }
      off += 8 + size + (size % 2);
    }
    return Buffer.alloc(0);
  }
  // Media time where chunk `seq` starts: the sum of the earlier chunks' lengths (pauses add no audio).
  chunkStartMs(seq) {
    let ms = 0;
    for (let i = 0; i < seq; i++) {
      try { ms += Math.max(0, fs.statSync(path.join(this.followDir, `${String(i).padStart(6, '0')}.wav`)).size - 44) / 32; }
      catch { ms += 5000; }
    }
    return Math.round(ms);
  }
  async followTick() {
    if (this.closed || this.followBusy || !this.stream) return;
    const seqs = this.followSeqs(); if (!seqs.length) return;
    const latest = seqs[seqs.length - 1];
    if (this.followSeq === null) {
      // Start with the newest chunk so words show up within seconds; the accurate transcript covers the rest.
      this.followSeq = latest; this.baseMs = this.chunkStartMs(latest) - this.audioMs;
    }
    let next = this.followSeq;
    if (!seqs.includes(next)) {
      if (latest < next) { if (Date.now() - this.followLastAt > FOLLOW_IDLE_CLOSE_MS) { logEvent('live.follow_idle', { meetingId: this.meetingId }); this.ws.close(1000, 'idle'); } return; }
      // An upload arrived out of order: wait for the gap a little, then jump to the newest chunk.
      if (!this.followGapSince) this.followGapSince = Date.now();
      if (Date.now() - this.followGapSince < FOLLOW_GAP_SKIP_MS) return;
      next = latest; this.baseMs = this.chunkStartMs(latest) - this.audioMs; this.maybeCommit(true);
    }
    this.followGapSince = 0; this.followBusy = true;
    try {
      const pcm = this.chunkPcm(next);
      for (let off = 0; off < pcm.length && !this.closed && this.stream; off += 8000) {
        this.stream.append(Buffer.from(pcm.subarray(off, off + 8000))); this.audioBytes += Math.min(8000, pcm.length - off);
        await new Promise((r) => setTimeout(r, FOLLOW_FRAME_MS));
      }
      this.followSeq = next + 1; this.followLastAt = Date.now();
      if (pcm.length < 5000 * 32 - 64) this.maybeCommit(true); // a short chunk means a pause or the end
    } catch (e) {
      logEvent('live.follow_error', { meetingId: this.meetingId, seq: next, error: String(e.message || e).slice(0, 160) });
      this.followSeq = next + 1;
    } finally { this.followBusy = false; }
  }
  fail(reason) { this.send({ type: 'error', reason }); this.ws.close(1008, reason); }
  audio(buf) {
    if (this.closed || this.follow || buf.length < 2 || buf.length % 2) return;
    if (!this.stream) {
      // Words spoken while the attested connection opens are held (up to 10 s), not dropped.
      (this.early ||= []).push(Buffer.from(buf)); this.earlyBytes = (this.earlyBytes || 0) + buf.length;
      while (this.earlyBytes > 320000) this.earlyBytes -= this.early.shift().length;
      return;
    }
    this.stream.append(Buffer.from(buf)); this.audioBytes += buf.length;
  }
  maybeCommit(pause) {
    if (!this.stream) return;
    const fresh = this.audioBytes - this.lastCommitBytes;
    if (fresh <= 0) return;
    if ((pause && fresh >= 0.8 * 32000) || Date.now() - this.lastCommitAt >= COMMIT_MS) {
      this.lastCommitBytes = this.audioBytes; this.lastCommitAt = Date.now(); this.stream.commit();
    }
  }
  onDelta(text) {
    const t = String(text || '');
    if (!t) return;
    this.partial = (this.partial + t).replace(/\s+/g, ' ');
    this.lastWordsAt = Date.now();
    this.send({ type: 'words', finals: this.tail(), partial: this.partial.trimStart(), atMs: this.audioMs, startMs: (this.baseMs || 0) + this.segStartMs });
    clearTimeout(this.idleTimer);

  }
  onCompleted(text) {
    const t = String(text || this.partial).replace(/\s+/g, ' ').trim();
    const before = this.finals.length;
    if (t) this.send({ type: 'settled', text: t, startMs: (this.baseMs || 0) + this.segStartMs, endMs: (this.baseMs || 0) + this.audioMs });
    this.segStartMs = this.audioMs;
    if (t) this.finals = (this.finals ? `${this.finals} ` : '') + t;
    // Offsets into the partial region keep their meaning once it settles.
    if (this.consumed > before) this.consumed = Math.min(this.consumed, this.finals.length);
    this.partial = '';
    this.send({ type: 'words', finals: this.tail(), partial: '', atMs: this.audioMs, startMs: (this.baseMs || 0) + this.segStartMs, settled: t });
    clearTimeout(this.idleTimer);

  }
  onProviderError(error) {
    logEvent('provider.error', { meetingId: this.meetingId, error: String(error?.message || error?.error?.message || 'provider connection dropped').slice(0, 240), status: error?.status || null, code: error?.code || null });
    this.send({ type: 'status', live: false, retrying: true, reason: 'Live words dropped out, recording continues. Reconnecting…' });
    const dead = this.stream; this.stream = null; safeClose(dead, this.meetingId);
    // Reopen on the same socket: follow mode keeps reading uploaded chunks, socket audio is held meanwhile.
    if (!this.closed) { clearTimeout(this.reopenTimer); this.reopenTimer = setTimeout(() => void this.openStream(), 2000); }
  }
  tail() { return this.finals.slice(-600); }
  text() { return this.partial ? `${this.finals} ${this.partial.trim()}` : this.finals; }
  close({ finish = false } = {}) {
    if (this.closed) return; this.closed = true;
    if (finish && freezeLiveSummary(summaryFor(this.meetingId))) save();

    clearInterval(this.commitTimer); clearInterval(this.followTimer); clearTimeout(this.idleTimer); clearTimeout(this.reopenTimer);
    try { this.stream?.commit(); } catch { /* ignore */ }
    const stream = this.stream;
    setTimeout(() => safeClose(stream, this.meetingId), 4000);
    sockets.get(this.meetingId)?.delete(this);
    if (this.meetingId) stopSummaries(this.meetingId);
    logEvent('live.closed', { meetingId: this.meetingId, audioMs: this.audioMs });
  }
}



const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
function send(res,code,data,type='application/json') {
  res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  res.end(type==='application/json'?JSON.stringify(data):data);
}
function safeOrigin(req) {
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  const origin=req.headers.origin;if(!origin)return true;
  const configured=(process.env.MEETINGS_ALLOWED_ORIGINS||'').split(',').filter(Boolean);
  if(configured.length)return configured.includes(origin);
  try{const u=new URL(origin);return u.host===req.headers.host&&['http:','https:'].includes(u.protocol);}catch{return false;}
}
function proxy(req,res,pathname) {
  const headers={...req.headers,host:'127.0.0.1:8080'};
  for(const h of ['origin','connection','keep-alive','proxy-authorization','proxy-authenticate'])delete headers[h];
  const upstream=http.request({host:UP.host,port:UP.port,path:pathname,method:req.method,headers},r=>{
    const responseHeaders={...r.headers};delete responseHeaders.connection;res.writeHead(r.statusCode,responseHeaders);r.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent)send(res,502,{error:'Recorder API is starting or unavailable'});else res.destroy();});
  req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
}
export const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');let p=url.pathname;
    if(p===BASE){res.writeHead(308,{Location:BASE+'/'});res.end();return;}
    if(p.startsWith(BASE+'/'))p=p.slice(BASE.length);
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!safeOrigin(req))return send(res,403,{error:'Cross-origin writes are not allowed'});
    if(p==='/capabilities.js')return send(res,200,'window.RecorderCapabilities='+JSON.stringify(caps)+';','text/javascript');
    if(p==='/live-health')return send(res,200,{ok:true,build:'0.3.0',...caps});
    if(p==='/asks')return send(res,200,{asks:[]});
    if(p==='/summary')return proxy(req,res,'/api/live-summary'+url.search);
    if(p==='/orb-events'){
      if(!events)return send(res,404,{error:'Orb events are disabled'});
      if(req.method==='GET')return send(res,200,{events:events.list(url.searchParams.get('meetingId'))});
      if(['POST','PUT'].includes(req.method)){let bytes=0,chunks=[];for await(const c of req){bytes+=c.length;if(bytes>65536)return send(res,413,{error:'Event too large'});chunks.push(c);}return send(res,200,{event:events.upsert(JSON.parse(Buffer.concat(chunks)))});}
      return send(res,405,{error:'Method not allowed'});
    }
    if(p.startsWith('/api/')||['/mcp','/healthz'].includes(p))return proxy(req,res,p+url.search);
    if(!['GET','HEAD'].includes(req.method))return send(res,405,{error:'Method not allowed'});
    const name=p==='/'?'index.html':decodeURIComponent(p.slice(1)),file=path.resolve(WEB,name);
    if(!file.startsWith(WEB)||!fs.existsSync(file)||!fs.statSync(file).isFile()||!TYPES[path.extname(file)])return send(res,404,{error:'Not found'});
    res.writeHead(200,{'Content-Type':TYPES[path.extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);
  }catch{if(!res.headersSent)send(res,400,{error:'Invalid request'});else res.destroy();}
});
const wss=new WebSocketServer({noServer:true,maxPayload:256*1024});
server.on('upgrade',(req,socket,head)=>{
  const p=new URL(req.url,'http://localhost').pathname;
  if(!caps.realtime||!['/live',BASE+'/live'].includes(p)||!safeOrigin(req))return socket.destroy();
  wss.handleUpgrade(req,socket,head,ws=>{
    const s=new LiveSession(ws);
    ws.on('message',(data,binary)=>{
      if(binary)return s.audio(data);
      let msg;try{msg=JSON.parse(String(data));}catch{return;}
      if(msg.type==='start'&&!s.meetingId)void s.start(msg);
      else if(msg.type==='pcm-at'&&!s.follow&&Number.isFinite(msg.startMs)&&msg.startMs>=0)s.baseMs=msg.startMs-s.audioMs-(s.earlyBytes||0)/32;
      else if(msg.type==='pause')s.maybeCommit(true);
      else if(msg.type==='stop'){s.maybeCommit(true);s.close();ws.close(1000,'stopped');}
    });
    ws.on('close',()=>s.close());ws.on('error',()=>s.close());
  });
});
if(process.env.NODE_ENV!=='test')server.listen(Number(process.env.PORT||8080),process.env.HOST||'0.0.0.0');
