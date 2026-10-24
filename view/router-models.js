import { parseSummaryDelta } from './summary.js';

export class RouterModels {
  constructor(router, grant) { this.router = router.replace(/\/$/, ''); this.grant = grant; }
  async run(feature, { system, messages, max_tokens = 2000 }) {
    const res = await fetch(`${this.router}/v1/models/${feature}/run`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { 'Content-Type': 'application/json', 'X-Wizard-Grant': this.grant },
      body: JSON.stringify({ system, messages, max_tokens, stream: true }),
    });
    if (!res.ok || !res.headers.get('content-type')?.startsWith('text/event-stream')) throw Error('Router unavailable');
    let pending = '', text = '', provenance = null, size = 0;
    const admit = (frame) => {
      let event = '', data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) return;
      if (provenance) throw Error('Events after completion');
      const msg = JSON.parse(data.join('\n')), type = msg.type || event;
      if (type === 'error' || event === 'error') throw Error('Router rejected model run');
      if (type === 'delta' || type === 'text') {
        if (typeof msg.text !== 'string') throw Error('Invalid model text');
        text += msg.text;
      } else if (type === 'done') {
        if (!msg.provider || !msg.model || !msg.tier || !msg.tested_on || typeof msg.chosen !== 'boolean' || !msg.usage || typeof msg.usage !== 'object' || Array.isArray(msg.usage)) throw Error('Router completion has no verified provenance');
        provenance = msg;
      } else throw Error('Unexpected model event');
    };
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Error('Router response too large');
      pending += chunk.replace(/\r/g, '');
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) { admit(pending.slice(0, end)); pending = pending.slice(end + 2); }
    }
    if (pending.trim()) admit(pending);
    if (!provenance || !text.trim()) throw Error('Router ended without verified completion');
    return { text: text.trim(), provenance };
  }
  async summarize({ activeTopic, transcript }) {
    const result = await this.run('live-summary', {
      system: 'Maintain an append-only live recording outline. Return JSON only: {"topicChanged":boolean,"title":string,"newBullets":[{"text":string,"atMs":integer}]}. At most 12 new bullets. Each atMs must equal a transcript startMs. Exclude filler and assistant requests. Do not infer names, decisions or commitments.',
      messages: [{ role: 'user', content: JSON.stringify({ activeTopic, transcript }) }],
    });
    const delta = parseSummaryDelta(result.text), allowed = new Set(transcript.map(s => s.startMs));
    if (delta.newBullets.some(b => !allowed.has(b.atMs))) throw Error('Ungrounded summary timestamp');
    return { delta, provenance: result.provenance };
  }
}
