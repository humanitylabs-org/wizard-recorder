// Mizel private live transcription and summaries; explicit manual Wizard requests only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TinfoilProvider, parseSummaryDelta } from './provider.js';
import { OrbEvents, discussionMarkdown } from './orb-events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;
const BASE = '/mizel-live';
const PORT = Number(process.env.MIZEL_LIVE_PORT || 8976);
const WEB = process.env.MIZEL_LIVE_WEB || path.join(HERE, 'web');
const DATA = process.env.MIZEL_LIVE_DATA || path.join(HOME, '.hermes/data/apps/mizel-live');
const UP = { host: '127.0.0.1', port: Number(process.env.MEETINGS_PORT || 8973), base: '/meetings' };
const WIZARD_API = process.env.WIZARD_API_URL || 'http://127.0.0.1:8865';
const PUBLIC_ORIGINS = new Set([...(process.env.MIZEL_ALLOWED_ORIGINS || '').split(',').filter(Boolean), `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const REALTIME_MODEL = process.env.MIZEL_LIVE_REALTIME_MODEL || 'voxtral-mini-4b-realtime';
const SUMMARY_MODEL = process.env.MIZEL_LIVE_SUMMARY_MODEL || 'deepseek-v4-1-flash';
const SUMMARY_EVERY_MS = 5000;    // check often; a pass runs once ~12 new words have locked in
const SAMPLE_RATE = 16000;
const COMMIT_MS = 6000;          // force a transcription commit at least this often while speaking
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
// Phone recordings (Wizard OS) never stream audio to this page: the phone writes 5 s WAV chunks and uploads
// them to the Meetings service. In follow mode the server reads those chunks as they land and feeds them to
// the realtime transcriber itself, so private live words work for phone recordings too.
const MEETINGS_AUDIO = path.join(process.env.MEETINGS_DATA_DIR || path.join(HOME, '.hermes/data/apps/meetings'), 'audio');
const FOLLOW_POLL_MS = 700;        // look for a new uploaded chunk this often
const FOLLOW_FRAME_MS = 40;        // feed a 5 s chunk as 250 ms frames, one every 40 ms (~6x real time)
const FOLLOW_GAP_SKIP_MS = 15000;  // a missing chunk with later ones present for this long is skipped
const FOLLOW_IDLE_CLOSE_MS = 45 * 60 * 1000;
const STATE_PATH = path.join(DATA, 'state.json');
const LOG_PATH = path.join(DATA, 'events.jsonl');
const orbEvents = new OrbEvents(path.join(DATA, 'orb-events.json'));
setInterval(() => void orbEvents.refresh(id => wizard(`/v1/runs/${encodeURIComponent(id)}`)), 5000).unref();

function readEnvFile(file, keys) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && keys.includes(m[1])) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch { /* missing file → empty */ }
  return out;
}
const secrets = {
  ...readEnvFile(path.join(HOME, '.hermes/.env'), ['TINFOIL_API_KEY']),
  ...readEnvFile(path.join(HOME, '.config/wizard-mobile/runtime.env'), ['API_SERVER_KEY']),
};
for (const k of ['TINFOIL_API_KEY', 'API_SERVER_KEY']) if (process.env[k]) secrets[k] = process.env[k];
const missing = ['TINFOIL_API_KEY', 'API_SERVER_KEY'].filter((k) => !secrets[k]);
if (missing.length) { console.error(`mizel-live refused to start: missing ${missing.join(', ')}`); process.exit(1); }
const provider = new TinfoilProvider(secrets.TINFOIL_API_KEY, null, REALTIME_MODEL, SUMMARY_MODEL);

// ───────────── durable state: one Live thread per recording, and its ask cards ─────────────
let state = { threads: {}, asks: {}, summaries: {} };
try { state = { threads: {}, asks: {}, summaries: {}, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch { /* first run */ }
function save() {
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}
function logEvent(event, data = {}) {
  fs.appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', { mode: 0o600 });
}
const sockets = new Map(); // meetingId → Set<LiveSession>
function broadcast(meetingId, msg) {
  for (const s of sockets.get(meetingId) || []) s.send(msg);
}
function asksFor(meetingId) {
  return Object.values(state.asks).filter((a) => a.meetingId === meetingId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
const publicAsk = (a) => ({ id: a.id, meetingId: a.meetingId, title: a.title || '', text: a.text, status: a.status, answer: a.answer || null, error: a.error || null,
  threadId: a.threadId || null, createdAt: a.createdAt, latency: a.latency || null, endedBy: a.endedBy || null, dismissed: !!a.dismissed });


// ───────────── Live summary: append-only topics + bullets, as in the Mizel.ai app ─────────────
// Built from the accurate (~30 s window) transcript, not the grey live words. Anything said to
// Archimedes is left out: it has its own cards and "Asked Archimedes" list.
const SUMMARY_PROMPT = 'You maintain an append-only live summary of a meeting or spoken ramble. Return only JSON {"topicChanged":boolean,"title":string,"newBullets":[{"text":string,"atMs":integer}]}. "title" is a short plain-English name (2-6 words) for the topic of the newest transcript lines. Set topicChanged=true only when discussion has clearly moved to a different topic than activeTopic.title. Each new bullet is one concise, concrete point (decisions, asks, facts, ideas, open questions) in plain English, with "atMs" copied exactly from the startMs of the transcript line that best supports it. Skip filler, mic checks, and repetition. Sentences addressed to Archimedes (the AI assistant; often mis-transcribed as "our communities" or "our comedies") are requests to the assistant, not meeting content: leave them out, along with any answer text. Return [] when nothing is new. Never restate existing bullets.';
const summaryJobs = new Map(); // meetingId → { timer, running }
function summaryFor(mid) { return state.summaries[mid] || null; }
const publicSummary = (sm) => sm && ({ topics: sm.topics, updatedAt: sm.updatedAt || null, summarizedToMs: sm.summarizedToMs || 0,
  originalLiveSummary: sm.originalLiveSummary || null });
function freezeLiveSummary(sm, capturedAt = new Date().toISOString()) {
  if (!sm || sm.originalLiveSummary || !sm.topics?.some(t => t.bullets?.length)) return false;
  sm.originalLiveSummary = { topics: JSON.parse(JSON.stringify(sm.topics)), updatedAt: sm.updatedAt || null,
    summarizedToMs: sm.summarizedToMs || 0, capturedAt };
  return true;
}
async function meetingSegments(mid) {
  const r = await fetch(`http://${UP.host}:${UP.port}${UP.base}/api/meetings/${encodeURIComponent(mid)}`);
  if (!r.ok) throw new Error(`meetings ${r.status}`);
  const m = await r.json();
  return { status: m.status, segments: (m.segments || []).filter((x) => x.text && x.text.trim()) };
}
async function summarizeMeeting(mid, { force = false, chain = true } = {}) {
  const job = summaryJobs.get(mid) || {}; if (job.running) return; job.running = true; summaryJobs.set(mid, job);
  try {
    const sm = state.summaries[mid] ||= { topics: [], summarizedToMs: 0, updatedAt: null };
    const { segments } = await meetingSegments(mid);
    const fresh = segments.filter((x) => (x.start_ms || 0) >= sm.summarizedToMs);
    const words = fresh.reduce((n, x) => n + x.text.split(/\s+/).length, 0);
    if (!fresh.length || (!force && words < 12)) return;
    const batch = fresh.slice(0, 40);
    const active = sm.topics.find((t) => t.active) || null;
    const askTexts = Object.values(state.asks).filter((a) => a.meetingId === mid).map((a) => a.text).slice(-12);
    const input = {
      activeTopic: active ? { title: active.title, bullets: active.bullets.slice(-24).map((b) => b.text) } : null,
      transcript: batch.map((x) => ({ startMs: x.start_ms, endMs: x.end_ms, text: x.text })),
      saidToArchimedes: askTexts,
    };
    const t0 = Date.now();
    const resp = await provider.client.chat.completions.create({
      model: SUMMARY_MODEL, response_format: { type: 'json_object' }, temperature: 0,
      messages: [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: JSON.stringify(input) }],
    });
    const delta = parseSummaryDelta(resp.choices[0]?.message?.content || '');
    const starts = batch.map((x) => x.start_ms || 0);
    const snap = (ms) => starts.reduce((best, st) => (Math.abs(st - ms) < Math.abs(best - ms) ? st : best), starts[0]);
    let target = active;
    if (!target || delta.topicChanged) {
      if (target) { target.active = false; target.endMs ??= starts[0]; }
      target = { id: `topic_${crypto.randomUUID()}`, title: delta.title, bullets: [], active: true, startMs: starts[0] };
      sm.topics.push(target);
    } else if (delta.title && !target.bullets.length) target.title = delta.title;
    const known = new Set(target.bullets.map((b) => b.text.toLowerCase()));
    for (const b of delta.newBullets) {
      if (known.has(b.text.toLowerCase())) continue; known.add(b.text.toLowerCase());
      target.bullets.push({ id: `b_${crypto.randomUUID()}`, text: b.text, atMs: snap(b.atMs) });
    }
    if (!target.bullets.length && !delta.newBullets.length && sm.topics.length && target !== active) {
      // A topic header with nothing under it yet is noise; keep it only once it has a point.
      sm.topics.pop(); if (active) active.active = true;
    }
    sm.summarizedToMs = Math.max(...batch.map((x) => x.end_ms || x.start_ms || 0)) ;
    sm.updatedAt = new Date().toISOString(); save();
    logEvent('summary.updated', { meetingId: mid, topics: sm.topics.length, added: delta.newBullets.length, ms: Date.now() - t0 });
    broadcast(mid, { type: 'summary', summary: publicSummary(sm) });
    if (chain && fresh.length > batch.length) setTimeout(() => void summarizeMeeting(mid, { force }), 500);
  } catch (e) {
    logEvent('summary.error', { meetingId: mid, error: String(e.message || e).slice(0, 200) });
  } finally { job.running = false; }
}
// Walk a finished transcript to the end in 40-line passes, then mark the outline complete.
async function buildOutline(mid) {
  const job = summaryJobs.get(mid); if (job?.building) return;
  summaryJobs.set(mid, { ...(job || {}), building: true });
  try {
    for (let i = 0; i < 200; i++) {
      const before = state.summaries[mid]?.summarizedToMs ?? -1;
      await summarizeMeeting(mid, { force: true, chain: false });
      const sm = state.summaries[mid];
      const { status, segments } = await meetingSegments(mid);
      const lastStart = segments.length ? Math.max(...segments.map((x) => x.start_ms || 0)) : 0;
      const finished = !segments.length || (sm && sm.summarizedToMs > lastStart);
      if (finished || (sm?.summarizedToMs ?? -1) === before) {
        if (finished && status === 'ready') { const s2 = state.summaries[mid] ||= { topics: [], summarizedToMs: 0, updatedAt: null }; s2.complete = true; s2.topics.forEach((t) => { t.active = false; }); save(); }
        break;
      }
    }
  } catch (e) { logEvent('summary.build_error', { meetingId: mid, error: String(e.message || e).slice(0, 200) }); }
  finally { const j = summaryJobs.get(mid); if (j) j.building = false; }
}
function startSummaries(mid) {
  const job = summaryJobs.get(mid) || {}; summaryJobs.set(mid, job);
  if (!job.timer) job.timer = setInterval(() => void summarizeMeeting(mid), SUMMARY_EVERY_MS);
}
function stopSummaries(mid) {
  const job = summaryJobs.get(mid); if (!job) return;
  if ((sockets.get(mid)?.size || 0) > 0) return;
  clearInterval(job.timer); job.timer = null;
  // The last stretch locks in a few seconds after Stop; catch it with two closing passes.
  for (const ms of [15000, 45000]) setTimeout(() => { if (!(sockets.get(mid)?.size)) void summarizeMeeting(mid, { force: true }); }, ms);
}

async function wizard(pathname, { method = 'GET', json, headers = {} } = {}) {
  const res = await fetch(WIZARD_API + pathname, {
    method,
    headers: { Authorization: `Bearer ${secrets.API_SERVER_KEY}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`Wizard ${method} ${pathname} → ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}
async function liveThreadFor(meetingId, title) {
  if (state.threads[meetingId]) return state.threads[meetingId];
  const id = `wizard_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  // Thread titles must be unique in Wizard, and most recordings start as "Untitled meeting",
  // so the title carries the Bangkok start time (plus a short tag if that still clashes).
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const base = `Live · ${(title || 'Recording').slice(0, 50)} · ${when}`;
  const candidates = [base, `${base} · ${meetingId.slice(-4)}`, `${base} · ${crypto.randomBytes(3).toString('hex')}`];
  for (let i = 0; i < candidates.length; i++) {
    try { await wizard('/api/sessions', { method: 'POST', json: { id, source: 'wizard-mobile', title: candidates[i].slice(0, 90) } }); break; }
    catch (e) { if (!/invalid_title|already in use/i.test(e.message) || i === candidates.length - 1) throw e; }
  }
  state.threads[meetingId] = id; save();
  logEvent('thread.created', { meetingId, threadId: id });
  return id;
}
function promptFor(ask) {
  // Never include the recording, its title, or inferred ambient context.
  return ask.text;
}
async function dispatchAsk(ask, title) {
  if (ask.origin !== 'manual-button') throw new Error('Automatic recording dispatch is disabled');
  if (process.env.MIZEL_LIVE_DRY === '1') {   // QA instance only: no Wizard thread or run
    await new Promise((r) => setTimeout(r, 300));
    ask.status = 'answered'; ask.answer = process.env.MIZEL_LIVE_DRY_LONG ? ('[dry run] long answer. ' + 'Here is a longer paragraph to check scrolling in the full answer sheet on a phone. '.repeat(40)) : '[dry run] would ask Archimedes'; save();
    return broadcast(ask.meetingId, { type: 'ask', ask: publicAsk(ask) });
  }
  try {
    const threadId = await liveThreadFor(ask.id, 'Mizel.ai · Manual ask');
    ask.threadId = threadId; save();
    broadcast(ask.meetingId, { type: 'ask', ask: publicAsk(ask) });
    const run = await wizard('/v1/runs', { method: 'POST', json: { session_id: threadId, input: promptFor(ask, title) }, headers: { 'Idempotency-Key': ask.id } });
    ask.runId = run.run_id || run.id; save();
    logEvent('run.started', { askId: ask.id, runId: ask.runId, threadId });
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      let r;
      try { r = await wizard(`/v1/runs/${encodeURIComponent(ask.runId)}`); } catch { continue; }
      if (ask.status === 'cancelled') return;
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status)) {
        if (r.status === 'completed' && r.output) {
          ask.status = 'answered'; ask.answer = String(r.output).slice(0, 6000);
        } else {
          ask.status = 'failed'; ask.error = `The run ended as ${r.status}. Open the Live thread to retry.`;
        }
        ask.latency = { ...(ask.latency || {}), answeredMs: Date.now() - Date.parse(ask.createdAt) };
        save(); logEvent('run.finished', { askId: ask.id, status: ask.status, answeredMs: ask.latency.answeredMs });
        broadcast(ask.meetingId, { type: 'ask', ask: publicAsk(ask) });
        return;
      }
    }
    ask.status = 'failed'; ask.error = 'Still working after 10 minutes. The answer will land in the Live thread.'; save();
    broadcast(ask.meetingId, { type: 'ask', ask: publicAsk(ask) });
  } catch (e) {
    ask.status = 'failed'; ask.error = `Couldn't start the Live thread, so this didn't reach Archimedes. Tap Retry. (${e.message.slice(0, 140)})`; save();
    logEvent('run.error', { askId: ask.id, error: e.message });
    broadcast(ask.meetingId, { type: 'ask', ask: publicAsk(ask) });
  }
}

// Provider close() is async and can reject (e.g. "final transcript timed out" while Tinfoil is unreachable).
// A rejection here must never take the server, and every other live recording, down with it.
function safeClose(stream, meetingId) {
  if (!stream) return;
  try { Promise.resolve(stream.close()).catch((e) => logEvent('provider.close_error', { meetingId, error: String(e?.message || e).slice(0, 200) })); }
  catch (e) { logEvent('provider.close_error', { meetingId, error: String(e?.message || e).slice(0, 200) }); }
}
process.on('unhandledRejection', (e) => logEvent('server.unhandled_rejection', { error: String(e?.message || e).slice(0, 240) }));

// ───────────── one live socket = one recording stream ─────────────
class LiveSession {
  constructor(ws) {
    this.ws = ws; this.meetingId = null; this.title = ''; this.stream = null; this.closed = false;
    this.finals = '';            // settled words of this stream
    this.partial = '';           // words still being heard
    this.consumed = 0;           // offset in finals+partial already judged
    this.audioBytes = 0; this.lastCommitBytes = 0; this.lastCommitAt = Date.now();
    this.judging = false; this.rejudge = false; this.idleTimer = null; this.unfinishedSince = 0;
    this.pending = null;         // a request Archimedes is still listening to
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
  control(msg) {
    const ask = state.asks[String(msg.askId || '')];
    if (!ask || ask.meetingId !== this.meetingId || ask.origin !== 'manual-button') return;
    if (msg.type === 'cancel' && ['listening', 'working'].includes(ask.status)) {
      if (this.pending?.ask === ask) { this.consumed = this.text().length; this.pending = null; }
      ask.status = 'cancelled'; save(); logEvent('ask.cancelled', { askId: ask.id });
      broadcast(this.meetingId, { type: 'ask', ask: publicAsk(ask) });
    } else if (msg.type === 'retry' && ask.status === 'failed') {
      ask.status = 'working'; ask.error = null; ask.runId = null; save();
      logEvent('ask.retry', { askId: ask.id });
      broadcast(this.meetingId, { type: 'ask', ask: publicAsk(ask) });
      void dispatchAsk(ask, this.title);
    }
  }
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

// ───────────── HTTP: static view + Meetings API proxy ─────────────
const TYPES = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json', json: 'application/json', html: 'text/html; charset=utf-8' };
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host']);
function sendRaw(res, code, body, type = 'text/plain', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(body);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (p === BASE) return sendRaw(res, 308, '', 'text/plain', { Location: BASE + '/' });
  if (p.startsWith(BASE + '/')) p = p.slice(BASE.length);
  if (p === '/live-health') return sendRaw(res, 200, JSON.stringify({ ok: true, realtimeModel: REALTIME_MODEL, summaryModel: SUMMARY_MODEL, wakeWord: false, automaticDispatch: false, manualAsk: true }), 'application/json');
  if (p === '/orb-events' && req.method === 'GET') {
    const mid=url.searchParams.get('meetingId');
    return sendRaw(res,200,JSON.stringify({events:orbEvents.list(mid),discussions:discussionMarkdown(orbEvents.list(mid))}),'application/json');
  }
  if (p === '/orb-events' && req.method === 'PUT') {
    if (!req.headers.origin || !PUBLIC_ORIGINS.has(req.headers.origin)) return sendRaw(res,403,'forbidden');
    try {
      const chunks=[];let bytes=0;
      for await(const c of req){bytes+=c.length;if(bytes>100000)return sendRaw(res,413,'too large');chunks.push(c);}
      const event=orbEvents.upsert(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return sendRaw(res,200,JSON.stringify({event}),'application/json');
    }catch(e){return sendRaw(res,409,JSON.stringify({error:e.message}),'application/json');}
  }
  const exportMatch=/^\/api\/meetings\/([A-Za-z0-9_-]+)\/export.md$/.exec(p);
  if(exportMatch && req.method==='GET') {
    try {const upstream=await fetch(`http://${UP.host}:${UP.port}${UP.base}${p}`);
      return sendRaw(res,upstream.status,(await upstream.text())+(upstream.ok?discussionMarkdown(orbEvents.list(exportMatch[1])):''),'text/markdown; charset=utf-8');
    }catch{return sendRaw(res,502,'Meeting export unavailable');}
  }
  if (p === '/manual-ask' && req.method === 'POST') {
    if (!req.headers.origin || !PUBLIC_ORIGINS.has(req.headers.origin)) return sendRaw(res, 403, 'forbidden');
    let chunks = []; let bytes = 0; let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > 16000) { overflow = true; chunks = []; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) return sendRaw(res, 413, 'message too large');
      let msg; try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendRaw(res, 400, 'bad JSON'); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.meetingId !== 'string' || typeof msg.text !== 'string') return sendRaw(res, 400, 'meetingId and text must be strings');
      const mid = msg.meetingId; const text = msg.text.trim();
      if (!/^[A-Za-z0-9_-]{3,64}$/.test(mid) || !text || text.length > 6000) return sendRaw(res, 400, 'meetingId and message required');
      // Payload allowlist: context, transcript, title, and legacy wake fields are ignored.
      const ask = { id: `ask_${crypto.randomUUID()}`, meetingId: mid, title: 'Manual ask', text, context: '', origin: 'manual-button', status: 'working', createdAt: new Date().toISOString() };
      state.asks[ask.id] = ask; save();
      logEvent('ask.manual', { askId: ask.id, meetingId: mid });
      broadcast(mid, { type: 'ask', ask: publicAsk(ask) });
      sendRaw(res, 202, JSON.stringify({ ask: publicAsk(ask) }), 'application/json');
      void dispatchAsk(ask, 'Manual ask');
    });
    return;
  }
  if (p === '/asks' && req.method === 'GET') {
    const mid = url.searchParams.get('meetingId');
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
    const list = Object.values(state.asks).filter((a) => a.status !== 'cancelled' && (!mid || a.meetingId === mid))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(publicAsk);
    return sendRaw(res, 200, JSON.stringify({ asks: list }), 'application/json');
  }
  if (p === '/summary' && req.method === 'GET') {
    const mid = url.searchParams.get('meetingId') || '';
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(mid)) return sendRaw(res, 400, JSON.stringify({ error: 'meetingId required' }), 'application/json');
    // Finished recordings (phone, browser or imported) get the same topic outline, built once on first open.
    let building = false;
    if (url.searchParams.get('build') === '1' && !(sockets.get(mid)?.size)) {
      const sm = summaryFor(mid); const job = summaryJobs.get(mid);
      if (job?.running) building = true;
      else if (!sm || !sm.complete) { building = true; void buildOutline(mid); }
    }
    return sendRaw(res, 200, JSON.stringify({ summary: publicSummary(summaryFor(mid)), live: (sockets.get(mid)?.size || 0) > 0, building }), 'application/json');
  }
  const dm = /^\/asks\/(ask_[A-Za-z0-9-]{8,64})\/(dismiss|restore)$/.exec(p);
  if (dm && req.method === 'POST') {
    if (req.headers.origin && !PUBLIC_ORIGINS.has(req.headers.origin)) return sendRaw(res, 403, 'forbidden');
    const ask = state.asks[dm[1]];
    if (!ask) return sendRaw(res, 404, JSON.stringify({ error: 'not found' }), 'application/json');
    ask.dismissed = dm[2] === 'dismiss'; save();
    broadcast(ask.meetingId, { type: 'ask', ask: publicAsk(ask) });
    return sendRaw(res, 200, JSON.stringify({ ask: publicAsk(ask) }), 'application/json');
  }
  if (p.startsWith('/api/')) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    if (headers.origin && /^http:\/\/(127\.0\.0\.1|localhost):/.test(headers.origin)) headers.origin = `http://127.0.0.1:${UP.port}`;
    const up = http.request({ host: UP.host, port: UP.port, method: req.method, path: UP.base + p + url.search, headers }, (r) => {
      const h = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k.toLowerCase())) h[k] = v;
      res.writeHead(r.statusCode || 502, h); r.pipe(res);
    });
    up.on('error', (e) => sendRaw(res, 502, JSON.stringify({ error: `Meetings service unreachable: ${e.code || e.message}` }), 'application/json'));
    req.pipe(up);
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) return sendRaw(res, 405, 'method not allowed');
  const name = p === '/' || p === '' ? 'index.html' : p.replace(/^\//, '');
  if (!/^[\w-][\w.-]*\.(js|css|svg|png|webmanifest|json|html)$/.test(name)) return sendRaw(res, 404, 'not found');
  const f = path.join(WEB, name);
  if (!fs.existsSync(f)) return sendRaw(res, 404, 'not found');
  sendRaw(res, 200, req.method === 'HEAD' ? '' : fs.readFileSync(f), TYPES[name.split('.').pop()]);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p !== BASE + '/live' && p !== '/live') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const origin = req.headers.origin;
  if (origin && !PUBLIC_ORIGINS.has(origin)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const s = new LiveSession(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return s.audio(data);
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === 'start' && !s.meetingId) void s.start(msg);
      else if (msg.type === 'pcm-at' && !s.follow && Number.isFinite(msg.startMs) && msg.startMs >= 0) s.baseMs = msg.startMs - s.audioMs - (s.earlyBytes || 0) / 32;
      else if (msg.type === 'pause') s.maybeCommit(true);
      else if (['send-now', 'cancel', 'retry'].includes(msg.type)) s.control(msg);
      else if (msg.type === 'stop') { s.maybeCommit(true); s.close({ finish: msg.finish !== false }); ws.close(1000, 'stopped'); }
    });
    ws.on('close', () => s.close());
    ws.on('error', () => s.close());
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`mizel-live listening on 127.0.0.1:${PORT}${BASE}/ (realtime ${REALTIME_MODEL}, button-only, summary ${SUMMARY_MODEL})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
