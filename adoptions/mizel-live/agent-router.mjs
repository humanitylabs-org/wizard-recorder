// Agent router: the owner picks which Wizard agent a recording (or a manual ask) goes to.
// Nothing here runs on its own. A transcript leaves Mizel only when the owner taps Send.
export const MAIN_AGENT = 'hermes';
const AGENT_ID = /^[a-z][a-z0-9-]{0,30}$/;
const TRANSCRIPT_CAP = 600_000;

// The main Hermes agent is Archimedes to the owner; the registry calls it "Hermes".
export function agentLabel(agent) {
  if (agent.id === MAIN_AGENT) return 'Archimedes';
  return String(agent.label || agent.name || agent.id).slice(0, 60);
}

export function publicAgents(payload) {
  const rows = Array.isArray(payload?.agents) ? payload.agents : [];
  const list = rows
    .filter((a) => a && typeof a.id === 'string' && AGENT_ID.test(a.id) && a.status !== 'stopped' && a.status !== 'removed')
    .map((a) => ({ id: a.id, label: agentLabel(a), privacy: a.privacy === 'private' ? 'private' : 'standard', status: a.status || 'unknown' }));
  list.sort((a, b) => (a.id === MAIN_AGENT ? -1 : b.id === MAIN_AGENT ? 1 : a.label.localeCompare(b.label)));
  return list;
}

export function validAgentId(id) { return typeof id === 'string' && AGENT_ID.test(id); }

const pad = (n) => String(n).padStart(2, '0');
export function stamp(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function bangkok(iso) {
  const d = new Date(iso || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

// One self-contained message: the owner's note first, then the recording as Markdown.
export function transcriptPacket({ meeting, summary, note = '', agentLabel: label = 'agent' }) {
  const title = (meeting?.title || 'Untitled recording').trim();
  const lines = [];
  const ask = String(note || '').trim();
  lines.push(ask || `Here is a Mizel.ai recording I'm sending you (${label}). Read it and tell me what matters: key points, decisions, and anything I should act on.`);
  lines.push('', '---', '', `# ${title}`);
  const meta = [bangkok(meeting?.started_at) && `${bangkok(meeting.started_at)} (Bangkok)`, meeting?.duration_ms ? `${Math.round(meeting.duration_ms / 60000)} min` : '', 'Sent from Mizel.ai'].filter(Boolean);
  lines.push(meta.join(' · '));
  const attendees = meeting?.calendar_event?.attendees;
  if (Array.isArray(attendees) && attendees.length) lines.push(`Attendees: ${attendees.slice(0, 30).join(', ')}`);
  const topics = (summary?.topics || []).filter((t) => t?.bullets?.length);
  if (topics.length) {
    lines.push('', '## Memory');
    for (const t of topics) {
      lines.push('', `### ${t.title || 'Topic'}`);
      for (const b of t.bullets) lines.push(`- ${String(b.text || '').trim()}${Number.isFinite(b.atMs) ? ` [${stamp(b.atMs)}]` : ''}`);
    }
  }
  const notes = typeof meeting?.notes === 'string' ? meeting.notes.trim() : '';
  if (notes) lines.push('', '## Notes', '', notes);
  const segments = (meeting?.segments || []).filter((s) => s?.text && s.text.trim());
  lines.push('', '## Transcript', '');
  if (!segments.length) lines.push('(No transcript yet.)');
  let used = 0; let cut = 0;
  for (const s of segments) {
    const speaker = s.speaker ? `${s.speaker}: ` : '';
    const row = `[${stamp(s.start_ms)}] ${speaker}${s.text.trim()}`;
    if (used + row.length > TRANSCRIPT_CAP) { cut++; continue; }
    used += row.length + 1; lines.push(row);
  }
  if (cut) lines.push('', `(Transcript truncated: ${cut} later lines left out for size.)`);
  return { text: lines.join('\n'), title, segments: segments.length, truncated: cut > 0 };
}

export function threadTitle(meetingTitle, label) {
  return `Mizel · ${String(meetingTitle || 'Recording').slice(0, 48)} → ${label}`.slice(0, 90);
}
