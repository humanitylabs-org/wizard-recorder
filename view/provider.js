import { TinfoilAI } from 'tinfoil';

export class TinfoilProvider {
  constructor(apiKey, client = null, realtimeModel = 'voxtral-mini-4b-realtime', summaryModel = 'deepseek-v4-1-flash') {
    this.client = client || new TinfoilAI({ apiKey });
    this.realtimeModel = realtimeModel;
    this.summaryModel = summaryModel;
  }
  async openRealtime(handlers) {
    const transcriber = new NativeRealtimeTranscriber(this.client, this.realtimeModel, handlers);
    await transcriber.open();
    return transcriber.api();
  }
  async summarize(input) {
    const response = await this.client.chat.completions.create({
      model: this.summaryModel, response_format: { type: 'json_object' }, temperature: 0,
      messages: [{
        role: 'system',
        content: 'You maintain an append-only meeting summary. Return only JSON {"topicChanged":boolean,"title":string,"newBullets":[{"text":string,"atMs":integer}]}. "title" names the topic of the newest transcript lines. Set topicChanged=true only when discussion has moved to a different topic than activeTopic.title. Each new bullet must contain concise new "text" and an "atMs" copied exactly from the startMs of the transcript line that best supports it. Return [] when nothing is new. Never restate or rewrite existing bullets.',
      }, { role: 'user', content: JSON.stringify(input) }],
    });
    return parseSummaryDelta(response.choices[0]?.message?.content || '');
  }
}

/**
 * Parses and bounds a model summary response into the append-only delta contract:
 * `{ topicChanged, title, newBullets }`. Throws on anything malformed so callers fail closed.
 */
export function parseSummaryDelta(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid summary delta');
  const title = typeof parsed.title === 'string' ? parsed.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (!title) throw new Error('invalid summary delta');
  if (!Array.isArray(parsed.newBullets) || parsed.newBullets.length > 12) throw new Error('invalid summary delta');
  const newBullets = parsed.newBullets.map((bullet) => {
    if (!bullet || typeof bullet !== 'object' || Array.isArray(bullet)) throw new Error('invalid summary delta');
    if (typeof bullet.text !== 'string' || bullet.text.length > 2000 || !Number.isSafeInteger(bullet.atMs) || bullet.atMs < 0) {
      throw new Error('invalid summary delta');
    }
    return { text: bullet.text.replace(/\s+/g, ' ').trim().slice(0, 500), atMs: bullet.atMs };
  }).filter((bullet) => bullet.text);
  return { topicChanged: parsed.topicChanged === true, title, newBullets };
}

// Tinfoil's attested native realtime dialect allows exactly one transcription
// session per connection. Each final commit therefore rotates to a newly
// attested connection while audio arriving during the rotation stays queued.
// This preserves bounded live utterances without dropping the recorder tee.
class NativeRealtimeTranscriber {
  constructor(client, model, handlers) {
    this.client = client; this.model = model; this.handlers = handlers;
    this.stream = null; this.ready = false; this.opening = null;
    this.pending = []; this.activeHasAudio = false; this.finalizing = false;
    this.commitQueued = false; this.closing = false; this.closed = false;
    this.idleWaiters = new Set();
  }
  api() {
    return {
      append: (bytes) => this.append(bytes),
      commit: () => this.commit(),
      close: () => this.close(),
    };
  }
  async open() {
    await this.ensureOpen();
    if (!this.stream || this.closed) throw new Error('Tinfoil realtime connection failed');
  }
  async ensureOpen() {
    if (this.closed || this.stream) return;
    if (this.opening) return this.opening;
    this.opening = this.client.realtime({ model: this.model }).then((stream) => {
      this.opening = null;
      if (this.closed) { stream.close(); return; }
      this.stream = stream; this.ready = false;
      stream.on('session.created', (event) => this.created(stream, event));
      stream.on('transcription.delta', (event) => {
        if (stream === this.stream && !this.closed) this.handlers.delta(event.delta || '');
      });
      stream.on('transcription.done', (event) => this.done(stream, event));
      stream.on('error', (error) => this.failed(stream, error));
    }).catch((error) => {
      this.opening = null;
      // `open()` turns this terminal state into a rejected startup promise. Every later
      // rotation is intentionally fire-and-forget, so rethrowing here would become an
      // unhandled rejection and terminate the Node bridge after a provider outage.
      this.failed(null, error);
    });
    return this.opening;
  }
  created(stream, event) {
    if (stream !== this.stream || this.closed || this.ready) return;
    this.ready = true;
    stream.send({ type: 'session.update', model: this.model });
    // A non-final commit starts native streaming generation. The final commit
    // below closes this one native transcription session.
    stream.send({ type: 'input_audio_buffer.commit' });
    const frames = this.pending.splice(0);
    for (const frame of frames) stream.send(frame);
    this.activeHasAudio = frames.length > 0;
    this.handlers.created?.(event);
    if (this.commitQueued && this.activeHasAudio) this.finalCommit();
    else if (this.closing && !this.activeHasAudio) this.finishEmptyStream();
  }
  append(bytes) {
    if (this.closed || this.closing) return;
    const frame = { type: 'input_audio_buffer.append', audio: bytes.toString('base64') };
    if (this.stream && this.ready && !this.finalizing) {
      this.stream.send(frame); this.activeHasAudio = true;
    } else {
      this.pending.push(frame); void this.ensureOpen();
    }
  }
  commit() {
    if (this.closed) return;
    if (this.stream && this.ready && !this.finalizing && this.activeHasAudio) {
      this.finalCommit();
    } else if (this.pending.length > 0) {
      this.commitQueued = true; void this.ensureOpen();
    }
  }
  finalCommit() {
    if (!this.stream || !this.ready || this.finalizing || !this.activeHasAudio) return;
    this.commitQueued = false; this.finalizing = true;
    this.stream.send({ type: 'input_audio_buffer.commit', final: true });
  }
  done(stream, event) {
    if (stream !== this.stream || this.closed) return;
    const text = event.text || '';
    stream.close();
    this.stream = null; this.ready = false; this.finalizing = false; this.activeHasAudio = false;
    this.handlers.completed(text);
    if (this.pending.length > 0) void this.ensureOpen();
    else { this.commitQueued = false; this.notifyIdle(); }
  }
  failed(stream, error) {
    if (this.closed || (stream && stream !== this.stream)) return;
    this.closed = true;
    try { this.stream?.close(); } catch {}
    this.stream = null; this.pending = []; this.notifyIdle();
    this.handlers.error?.(error);
  }
  finishEmptyStream() {
    if (!this.stream || this.activeHasAudio || this.finalizing) return;
    this.stream.close(); this.stream = null; this.ready = false; this.notifyIdle();
  }
  isIdle() { return !this.stream && !this.opening && this.pending.length === 0; }
  notifyIdle() {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
  async close() {
    if (this.closed) return;
    this.closing = true;
    if (this.pending.length > 0) this.commitQueued = true;
    if (this.stream && this.ready) {
      if (this.activeHasAudio && !this.finalizing) this.finalCommit();
      else if (!this.activeHasAudio && !this.finalizing) this.finishEmptyStream();
    } else if (!this.stream && this.pending.length > 0) {
      void this.ensureOpen();
    }
    if (!this.isIdle()) {
      await new Promise((resolve, reject) => {
        const onIdle = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          this.idleWaiters.delete(onIdle);
          reject(new Error('Tinfoil final transcript timed out'));
        }, 30_000);
        this.idleWaiters.add(onIdle);
      });
    }
    this.closed = true;
  }
}
