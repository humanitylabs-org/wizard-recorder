// Recorder's Ready extension (wizard.ready-extension/1), run by the Wizard shell on the owner's phone and desktop.
// Finished meetings for an agent the Recorder server may not open (the Private agent) are sent by the owner's own
// device. This keeps sending them while the shell is open, without the Recorder screen (issue 29): it reads
// live/deliveries/due, claims one (the server's lease means two devices never both send), opens the thread and run
// through the same /wizard/hermes path the Recorder screen uses, and reports the result. A delivery that still waits
// after 10 minutes is one item in Ready through Recorder's inbox feed (app/server.py /api/inbox).
export const contract = 'wizard.ready-extension/1';

const LIVE = new URL('live/', import.meta.url);
const POLL_MS = 30 * 1000;           // a due meeting goes within about half a minute while the shell is open
const RETRY_MS = 5 * 60 * 1000;      // after a failed try, wait before the next automatic one (opening the meeting in Recorder sends it at once)
const NAMES = { private: 'Private agent' };
const agentName = (id) => NAMES[id] || id;
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

async function live(path, json) {
  const r = await fetch(new URL(path, LIVE), json === undefined
    ? { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }
    : { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
  let data = null; try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(data?.error || `Recorder ${r.status}`), { status: r.status });
  return data || {};
}
async function wizard(path, agent, json, headers = {}) {
  const r = await fetch(`/wizard/hermes${path}?agent=${encodeURIComponent(agent)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify({ ...json, agent }) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || data?.error || `Wizard ${r.status}`), { status: r.status, body: text.slice(0, 200) });
  return data || {};
}
// The same steps as the Recorder screen's deviceDeliver (live/web/app.js).
export async function sendDue(meetingId, agent) {
  const c = await live('deliveries/claim', { meetingId, agent, manual: false, agentLabel: agentName(agent) });
  try {
    const id = `wizard_${Date.now()}_${hex(6)}`;
    for (const [i, title] of [c.title, `${c.title} · ${hex(2)}`, `${c.title} · ${hex(4)}`].entries()) {
      try { await wizard('/api/sessions', c.agent, { id, source: 'wizard-mobile', title: String(title).slice(0, 90) }); break; }
      catch (e) { if (!/invalid_title|already in use/i.test(`${e.message} ${e.body}`) || i === 2) throw e; }
    }
    const run = await wizard('/v1/runs', c.agent, { session_id: id, input: c.text }, { 'Idempotency-Key': c.sendId });
    return await live('deliveries/result', { sendId: c.sendId, threadId: id, runId: run.run_id || run.id || '' });
  } catch (e) {
    await live('deliveries/result', { sendId: c.sendId, error: e?.message || 'Something went wrong' }).catch(() => {});
    throw e;
  }
}

export default function recorderReady(host) {
  let busy = false, timer = 0, last = 0, gone = false;
  const retryLater = (d) => d.sending || (d.failedAt && Date.now() - Date.parse(d.failedAt) < RETRY_MS);
  async function pump() {
    if (gone || busy || !host.installed()) return;
    busy = true; last = Date.now();
    try {
      const { due = [] } = await live('deliveries/due');
      for (const d of due) {
        if (gone) break;
        if (retryLater(d)) continue;
        try { await sendDue(d.meetingId, d.agent); }
        catch { /* the server keeps it due with the reason; Recorder's inbox item shows it after 10 minutes */ }
      }
    } catch { /* Recorder or the network is away: next tick */ }
    finally { busy = false; }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') void pump(); };
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => void pump(), POLL_MS);
  return {
    // Nothing drawn here: a meeting that waits too long is one item in Ready through Recorder's inbox feed (api/inbox).
    html: () => '',
    poll() { if (Date.now() - last > 15000) void pump(); },
    write() { return Promise.reject(new Error('Recorder has no Ready writes')); },
    handle: () => false,
    busy: () => busy,
    dispose() { gone = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); },
  };
}
