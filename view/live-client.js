import WebSocket from 'ws';

// App-scoped Router service client; never connects to a provider directly.
export class LiveClient {
  constructor(router, grant) { this.router = router; this.grant = grant; }
  openRealtime(handlers = {}) {
    return this.realtime({ delta: e => handlers.delta?.(e.delta), completed: e => handlers.completed?.(e.transcript), failed: handlers.error });
  }
  realtime(handlers = {}) {
    const url = new URL(`${this.router.replace(/\/$/, '')}/v1/services/live-transcription/v1/live`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, { headers: { 'X-Wizard-Grant': this.grant }, followRedirects: false, handshakeTimeout: 10000, maxPayload: 65536 });
    let ready = false, ended = false, stopping = false, queued = [], bytes = 0;
    const fail = () => {
      if (ended) return;
      ended = true; clearTimeout(deadline); queued = []; bytes = 0;
      ws.terminate(); handlers.failed?.({ message: 'Live transcript unavailable. Recording continues.' });
    };
    const deadline = setTimeout(fail, 15000); deadline.unref?.();
    function send(data) {
      if (ended || ws.readyState === WebSocket.CLOSED) return;
      if (ready) {
        if (ws.bufferedAmount > 2 * 1024 * 1024) return fail();
        ws.send(data);
      } else {
        bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
        if (bytes > 2 * 1024 * 1024) return fail();
        queued.push(data);
      }
    }
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', format: 'pcm_s16le', sample_rate: 16000, channels: 1, language: null })));
    ws.on('message', (raw, binary) => {
      if (ended) return;
      try {
        if (binary) throw Error('Expected a protocol frame');
        const m = JSON.parse(raw.toString());
        if (m.type === 'ready' && !ready) {
          ready = true; clearTimeout(deadline);
          const pending = queued; queued = []; bytes = 0;
          for (const data of pending) send(data);
        } else if (m.type === 'delta' && ready && typeof m.text === 'string') handlers.delta?.({ delta: m.text });
        else if (m.type === 'final' && ready && typeof m.text === 'string') handlers.completed?.({ transcript: m.text });
        else if (m.type === 'error') fail();
        else if (m.type === 'closed' && stopping) { ended = true; clearTimeout(deadline); ws.close(); }
        else throw Error('Unexpected protocol frame');
      } catch { fail(); }
    });
    ws.on('error', fail);
    ws.on('close', () => { if (!ended) fail(); });
    return {
      append(pcm) {
        if (stopping || ended) return;
        const data = Buffer.from(pcm);
        for (let at = 0; at < data.length; at += 65536) send(data.subarray(at, at + 65536));
      },
      commit() { if (!stopping) send(JSON.stringify({ type: 'commit' })); },
      close() {
        if (stopping || ended) return;
        stopping = true; send(JSON.stringify({ type: 'stop' }));
        const timeout = setTimeout(() => { if (!ended) fail(); }, 10000); timeout.unref?.();
        ws.once('close', () => clearTimeout(timeout));
      },
    };
  }
}
