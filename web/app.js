/*
 * Meetings — front end (no dependencies).
 *
 *  1. Utilities            6. Meeting document (header, notes, enhanced, status)
 *  2. API client           7. Transcript (drawer + inline)
 *  3. Markdown renderer    8. Capture: WAV, upload queue, browser + native recorders
 *  4. State & routing      9. Recording controller + pill
 *  5. Home / list pane    10. Ask (per-meeting and across all) · 11. Boot
 */

// ───────────────────────── 1. Utilities ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v; // only ever fed by md() output
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use);
  return svg;
};
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const replace = (el, ...kids) => { clear(el).append(...kids.flat().filter(Boolean)); return el; };
function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtDuration(ms) {
  if (!ms || ms < 1000) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
}
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
function dayLabel(iso) {
  const d = startOfDay(new Date(iso)), today = startOfDay(new Date());
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}
const fmtDateLong = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const relTime = (iso) => { const d = new Date(iso); return startOfDay(d) - startOfDay(new Date()) === 0 ? fmtTime(iso) : `${dayLabel(iso)} ${fmtTime(iso)}`; };
const pluralize = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SOURCE_LABEL = { mizel: 'Mizel', anarlog: 'Anarlog' };
const TEMPLATES = [['general', 'General'], ['one_on_one', '1:1'], ['sales', 'Sales']];
const supportsPlaintextOnly = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only'; })();

function toast(msg, { error = false, action = null, timeout = error ? 8000 : 4000 } = {}) {
  const el = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, h('span', { class: 'msg', text: msg }));
  if (action) el.append(h('button', { class: `btn sm${action.primary ? ' primary' : ''}`, type: 'button', text: action.label, onclick: () => { el.remove(); action.fn(); } }));
  el.append(h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', style: 'width:32px;height:32px', onclick: () => el.remove() }, icon('close')));
  $('#toasts').append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
// In-app confirmation (window.confirm is unreliable inside bare WKWebViews).
const confirmToast = (msg, label, fn) => toast(msg, { error: true, timeout: 12000, action: { label, fn, primary: true } });
const errMsg = (e) => (e instanceof ApiError ? e.message : (!navigator.onLine ? 'You are offline' : (e?.message || 'Something went wrong')));

// ───────────────────────── 2. API client ─────────────────────────
class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || data?.message || `Request failed (${status})`);
    this.status = status; this.data = data;
  }
}
async function api(path, { method = 'GET', json, body, headers = {} } = {}) {
  const opts = { method, headers: { Accept: 'application/json', ...headers }, credentials: 'same-origin' };
  if (json !== undefined) { opts.body = JSON.stringify(json); opts.headers['Content-Type'] = 'application/json'; }
  else if (body !== undefined) opts.body = body;
  const res = await fetch(path, opts);
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, data);
  }
  if (res.status === 204) return null;
  return res.json();
}
const API = {
  meetings: (q = '') => api(`api/meetings?${new URLSearchParams({ q, limit: '100' })}`),
  calendar: () => api('api/calendar'),
  create: (body) => api('api/meetings', { method: 'POST', json: body }),
  meeting: (id) => api(`api/meetings/${enc(id)}`),
  patch: (id, body) => api(`api/meetings/${enc(id)}`, { method: 'PATCH', json: body }),
  notes: (id, notes, base_rev) => api(`api/meetings/${enc(id)}/notes`, { method: 'PUT', json: { notes, base_rev } }),
  segments: (id, after) => api(`api/meetings/${enc(id)}/segments?${new URLSearchParams(after ? { after } : {})}`),
  chunk: (id, source, seq, start_ms, blob) =>
    api(`api/meetings/${enc(id)}/chunks?${new URLSearchParams({ source, seq, start_ms })}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'audio/wav' } }),
  stop: (id) => api(`api/meetings/${enc(id)}/stop`, { method: 'POST' }),
  enhance: (id, template) => api(`api/meetings/${enc(id)}/enhance`, { method: 'POST', json: { template } }),
  ask: (id, question) => api(`api/meetings/${enc(id)}/ask`, { method: 'POST', json: { question } }),
  askAll: (question) => api('api/ask', { method: 'POST', json: { question } }),
  remove: (id) => api(`api/meetings/${enc(id)}`, { method: 'DELETE' }),
  exportUrl: (id) => `api/meetings/${enc(id)}/export.md`,
};

// ───────────────────────── 3. Markdown renderer ─────────────────────────
// Escape first, then add a small set of tags. Raw input never reaches innerHTML.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function mdInline(text, opts) {
  const codes = [];
  let s = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(>])\*(?!\s)([^*\n]+?)\*(?=$|[\s.,;:!?)<])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(>])_(?!\s)([^_\n]+?)_(?=$|[\s.,;:!?)<])/g, '$1<em>$2</em>');
  if (opts.evidence) s = s.replace(/\[(E\d+)\]/g, '<button type="button" class="ev" data-ref="$1" title="Show in transcript">$1</button>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
// opts.marks: lines starting with U+2063 are the user's own ("yours"); all others are "ai".
function md(src, opts = {}) {
  const out = []; let list = null; let code = null;
  const flush = () => { if (list) { out.push(`<${list.type}>${list.items.join('')}</${list.type}>`); list = null; } };
  for (let raw of String(src || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (code) { if (/^\s*```/.test(raw)) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; } else code.push(raw); continue; }
    let cls = '';
    if (opts.marks) { if (raw.startsWith('⁣')) { cls = ' class="yours"'; raw = raw.slice(1); } else cls = ' class="ai"'; }
    const line = raw.replace(/⁣/g, '');
    if (!line.trim()) { flush(); continue; }
    if (/^\s*```/.test(line)) { flush(); code = []; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); const n = Math.min(m[1].length + (opts.shift || 0), 6); out.push(`<h${n}${cls}>${mdInline(m[2], opts)}</h${n}>`); }
    else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { if (list?.type !== 'ul') { flush(); list = { type: 'ul', items: [] }; } list.items.push(`<li${cls}>${mdInline(m[1].replace(/^\[([ xX])\]\s*/, (_, c) => (c === ' ' ? '☐ ' : '☑ ')), opts)}</li>`); }
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (list?.type !== 'ol') { flush(); list = { type: 'ol', items: [] }; } list.items.push(`<li${cls}>${mdInline(m[1], opts)}</li>`); }
    else if ((m = /^>\s?(.*)$/.exec(line))) { flush(); out.push(`<blockquote${cls}>${mdInline(m[1], opts)}</blockquote>`); }
    else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); }
    else { flush(); out.push(`<p${cls}>${mdInline(line, opts)}</p>`); }
  }
  if (code) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flush();
  return out.join('');
}
const stripMarks = (s) => String(s || '').replace(/⁣/g, '');
const plainPreview = (s) => stripMarks(s).replace(/^\s*# .*$/m, '').replace(/\[E\d+\]/g, ' ').replace(/[#*_`>\[\]]/g, ' ').replace(/\s+/g, ' ').trim();

// ───────────────────────── 4. State & routing ─────────────────────────
const mobileMQ = matchMedia('(max-width: 760px)');
const state = {
  route: { view: 'home', id: null },
  meetings: [], meetingsLoading: true, meetingsError: null, query: '',
  calendar: [], calendarError: null,
  current: null, currentLoading: false, currentError: null,
  docMode: 'notes', // 'notes' | 'enhanced'
  notes: { rev: 0, dirty: false, saving: false, conflict: null, flash: false },
  pendingTemplate: null,
  drawerOpen: false,
  segPending: 0,
  rec: null, // active recording session (see §9)
  askAll: { thread: [] },
  pollTimer: null,
  lastEnhancedAt: null,
};
const els = {};
const prefs = {
  get systemAudio() { return localStorage.getItem('meetings.systemAudio') === '1'; },
  set systemAudio(v) { localStorage.setItem('meetings.systemAudio', v ? '1' : '0'); },
};
const draftKey = (id) => `meetings.draft.${id}`;

function parseHash() {
  const m = /^#\/m\/([^/?#]+)/.exec(location.hash);
  return m ? { view: 'meeting', id: decodeURIComponent(m[1]) } : { view: 'home', id: null };
}
function navigate(id) { location.replace(id ? `#/m/${enc(id)}` : '#/'); }
function goBack() { navigate(null); }
function applyRoute(route) {
  state.route = route;
  els.app.dataset.view = route.view;
  if (route.view === 'meeting') {
    els.home.hidden = true; els.doc.hidden = false;
    if (state.current?.id !== route.id) loadMeeting(route.id);
    else renderDoc();
  } else {
    flushNotes();
    els.home.hidden = false; els.doc.hidden = true;
    state.current = null; state.currentError = null; closeDrawer(); stopPolling(); closeMenu();
    renderAskBar(); renderPill();
  }
  renderList(); renderRecBanner(); placeAskAll();
}
function placeAskAll() {
  const target = mobileMQ.matches ? els.listFoot : els.askAllMount;
  if (els.askAll.parentElement !== target) target.append(els.askAll);
}

// ───────────────────────── 5. Home / list pane ─────────────────────────
async function loadMeetings() {
  state.meetingsLoading = true; state.meetingsError = null; renderList();
  const q = state.query;
  try { const r = await API.meetings(q); if (q !== state.query) return; state.meetings = r.meetings || []; }
  catch (e) { state.meetingsError = errMsg(e); }
  state.meetingsLoading = false; renderList();
}
async function loadCalendar() {
  try { state.calendar = (await API.calendar()).events || []; state.calendarError = null; }
  catch (e) { state.calendarError = errMsg(e); }
  renderUpcoming();
}
const refreshAll = () => { loadMeetings(); loadCalendar(); };

function renderUpcoming() {
  const box = els.upcoming;
  if (state.query) { clear(box); return; }
  const now = Date.now();
  const events = state.calendar.filter((ev) => new Date(ev.end).getTime() > now - 10 * 60000).slice(0, 6);
  if (!events.length) {
    replace(box, state.calendarError && h('div', { class: 'error-box' }, h('span', { class: 'msg', text: `Calendar unavailable. ${state.calendarError}.` }), h('button', { class: 'btn sm', type: 'button', text: 'Retry', onclick: loadCalendar })));
    return;
  }
  replace(box, h('h2', { class: 'group-label', text: 'Coming up' }), ...events.map((ev) => {
    const ongoing = new Date(ev.start).getTime() <= now && new Date(ev.end).getTime() >= now;
    const sameDay = startOfDay(new Date(ev.start)).getTime() === startOfDay(new Date()).getTime();
    const who = (ev.attendees || []).length ? pluralize(ev.attendees.length, 'attendee') : '';
    const linked = state.meetings.find((m) => m.id === ev.meeting_id);
    const open = () => navigate(ev.meeting_id);
    const action = ev.meeting_id
      ? h('button', { class: 'btn sm', type: 'button', text: linked?.status === 'recording' ? 'Recording' : 'Open', onclick: open })
      : h('button', { class: 'btn sm primary', type: 'button', text: 'Start', onclick: () => startFromEvent(ev) });
    return h('div', { class: 'event' },
      h('div', { class: `time${ongoing ? ' now' : ''}` }, h('b', { text: ongoing ? 'Now' : fmtTime(ev.start) }), sameDay ? fmtTime(ev.end) : dayLabel(ev.start)),
      h('div', { class: 'body', onclick: ev.meeting_id ? open : null },
        h('div', { class: 'name', text: ev.title || 'Untitled event' }),
        h('div', { class: 'sub', text: [who, ev.meet_url ? 'Google Meet' : ''].filter(Boolean).join(' · ') })),
      action);
  }));
}

function renderList() {
  renderUpcoming();
  const box = els.meetings;
  if (state.meetingsLoading && !state.meetings.length) {
    replace(box, h('h2', { class: 'group-label skeleton', text: 'Loading' }), ...[0, 1, 2, 3].map(() =>
      h('div', { class: 'row sk' }, h('div', { class: 'skeleton', style: 'width:70%' }), h('div', { class: 'skeleton', style: 'width:45%' }))));
    return;
  }
  if (state.meetingsError && !state.meetings.length) {
    replace(box, h('div', { class: 'error-box' }, h('span', { class: 'msg', text: `Couldn't load meetings. ${state.meetingsError}.` }),
      h('button', { class: 'btn sm', type: 'button', text: 'Retry', onclick: loadMeetings })));
    return;
  }
  if (!state.meetings.length) {
    replace(box, state.query
      ? h('div', { class: 'empty', text: `No meetings match “${state.query}”.` })
      : h('div', { class: 'empty' }, 'No meetings yet.', h('br'), 'Start one from your calendar above, or tap New meeting to record right away.'));
    return;
  }
  const groups = new Map();
  for (const m of state.meetings) { const k = dayLabel(m.started_at); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const kids = [];
  if (state.query) kids.push(h('h2', { class: 'group-label', text: `Results for “${state.query}”` }));
  for (const [label, items] of groups) {
    if (!state.query) kids.push(h('h2', { class: 'group-label', text: label }));
    for (const m of items) kids.push(renderRow(m));
  }
  replace(box, ...kids);
}
function renderRow(m) {
  const active = state.route.view === 'meeting' && state.route.id === m.id;
  const badge = m.source !== 'meetings' ? h('span', { class: 'badge', text: SOURCE_LABEL[m.source] || m.source })
    : m.status === 'recording' ? h('span', { class: 'badge live' }, h('span', { class: 'dot pulse' }), ' Live')
    : m.status === 'processing' ? h('span', { class: 'badge proc', text: 'Processing' }) : null;
  const when = [fmtTime(m.started_at), fmtDuration(m.duration_ms)].filter(Boolean).join(' · ');
  return h('button', { class: `row${active ? ' active' : ''}`, type: 'button', onclick: () => navigate(m.id), dataset: { id: m.id } },
    h('div', { class: 'r1' }, h('span', { class: 'name', text: m.title || 'Untitled meeting' }), h('span', { class: 'when', text: when })),
    h('div', { class: 'r2' }, badge, h('span', { class: 'preview', text: stripMarks(m.preview) || (m.has_notes ? 'Notes' : 'No notes yet') })));
}
function renderRecBanner() {
  const r = state.rec;
  const show = r && r.phase !== 'error' && !(state.route.view === 'meeting' && state.route.id === r.meetingId);
  els.recBanner.hidden = !show;
  if (show) replace(els.recBanner, h('span', { class: 'dot pulse' }), h('span', { class: 't', text: `Recording · ${r.title || 'Untitled meeting'}` }), h('span', { class: 'small muted', text: fmtClock(recElapsed()) }));
}

// Creating meetings. Capture resources are "warmed" inside the click so Safari/WKWebView and
// Chrome's gesture rules are satisfied even though the meeting is created over the network first.
let pendingAutostart = null; // { id, warm }
async function startFromEvent(ev) {
  const warm = prewarmCapture();
  try {
    const m = await API.create({ calendar_event_id: ev.id, title: ev.title });
    pendingAutostart = { id: m.id, warm };
    navigate(m.id);
  } catch (e) { discardWarm(warm); toast(`Couldn't start the meeting: ${errMsg(e)}`, { error: true }); }
}
async function newMeeting() {
  const warm = prewarmCapture();
  els.btnNew.disabled = true;
  try {
    const m = await API.create({});
    pendingAutostart = { id: m.id, warm };
    navigate(m.id);
  } catch (e) { discardWarm(warm); toast(`Couldn't create a meeting: ${errMsg(e)}`, { error: true }); }
  finally { els.btnNew.disabled = false; }
}

// ───────────────────────── 6. Meeting document ─────────────────────────
async function loadMeeting(id) {
  flushNotes();
  stopPolling(); closeDrawer(); closeMenu();
  state.current = null; state.currentLoading = true; state.currentError = null;
  state.notes = { rev: 0, dirty: false, saving: false, conflict: null, flash: false };
  state.segPending = 0;
  renderDoc();
  try {
    const m = await API.meeting(id);
    if (state.route.id !== id) return; // user moved on
    setCurrent(m, { fresh: true });
  } catch (e) {
    if (state.route.id !== id) return;
    state.currentError = e;
  }
  state.currentLoading = false;
  renderDoc();
  if (pendingAutostart) {
    const p = pendingAutostart; pendingAutostart = null;
    if (state.current && p.id === id) beginRecording({ warm: p.warm }); else discardWarm(p.warm);
  }
  schedulePoll();
}
function setCurrent(m, { fresh = false } = {}) {
  const prev = state.current;
  state.current = m;
  const enhancedAt = m.enhanced?.created_at || null;
  if (fresh) {
    state.notes.rev = m.notes_rev || 0;
    els.notepad.value = m.notes || '';
    state.docMode = m.enhanced ? 'enhanced' : 'notes';
    state.lastEnhancedAt = enhancedAt;
    state.pendingTemplate = m.enhanced?.template || null;
    const draft = isImported(m) ? null : localStorage.getItem(draftKey(m.id));
    if (draft != null && draft !== (m.notes || '')) state.notes.conflict = { draft, server: m.notes || '', rev: state.notes.rev };
    else if (draft != null) localStorage.removeItem(draftKey(m.id));
  } else {
    if (!state.notes.dirty && !state.notes.saving && !state.notes.conflict && (m.notes_rev || 0) > state.notes.rev) { state.notes.rev = m.notes_rev; els.notepad.value = m.notes || ''; autogrow(); }
    if (enhancedAt && enhancedAt !== state.lastEnhancedAt) { state.lastEnhancedAt = enhancedAt; state.docMode = 'enhanced'; }
    if (prev?.jobs?.enhance !== 'running' && m.jobs?.enhance === 'running') { state.docMode = 'enhanced'; if (!state.pendingTemplate) state.pendingTemplate = 'general'; }
    if (prev?.jobs?.enhance === 'running' && m.jobs?.enhance === 'error') toast('Enhance failed. You can try again from the template switcher.', { error: true });
  }
  // keep the list row in sync
  const i = state.meetings.findIndex((x) => x.id === m.id);
  const row = { ...m, enhanced: !!m.enhanced, preview: plainPreview(m.enhanced?.markdown || m.notes || m.segments?.[0]?.text || '').slice(0, 160) };
  delete row.segments; delete row.asks; delete row.notes;
  if (i >= 0) state.meetings[i] = { ...state.meetings[i], ...row }; else if (!state.query) state.meetings.unshift(row);
  renderList();
}
const isImported = (m) => !!m && m.source !== 'meetings';
const isLiveHere = (m) => !!m && !!state.rec && state.rec.meetingId === m.id && state.rec.phase !== 'error';

function renderDoc() {
  const m = state.current;
  els.docPane.dataset.rec = isLiveHere(m) ? '1' : '';
  if (state.currentLoading) {
    els.title.textContent = ''; els.title.classList.add('skeleton'); els.title.style.width = '60%'; els.title.removeAttribute('contenteditable');
    replace(els.meta, h('span', { class: 'skeleton', text: 'Loading date and time' }));
    clear(els.docActions); clear(els.docStatus); clear(els.docToolbar); clear(els.asks); clear(els.conflict); els.conflict.hidden = true;
    els.notepad.hidden = true; els.enhanced.hidden = true; els.transcriptInline.hidden = true; renderAskBar(); renderPill();
    return;
  }
  els.title.classList.remove('skeleton'); els.title.style.width = '';
  if (!m) {
    els.title.textContent = 'Meeting unavailable'; els.title.removeAttribute('contenteditable');
    replace(els.meta, h('span', { text: state.currentError?.status === 404 ? 'This meeting does not exist or was deleted.' : `Couldn't load this meeting. ${errMsg(state.currentError || {})}.` }));
    clear(els.docActions); clear(els.docToolbar); clear(els.asks);
    replace(els.docStatus, h('div', { class: 'notice warn' }, h('span', { class: 'msg', text: 'Nothing to show.' }),
      state.currentError?.status !== 404 && h('button', { class: 'btn sm', type: 'button', text: 'Retry', onclick: () => loadMeeting(state.route.id) }),
      h('button', { class: 'btn sm ghost', type: 'button', text: 'Back to meetings', onclick: () => navigate(null) })));
    els.notepad.hidden = true; els.enhanced.hidden = true; els.transcriptInline.hidden = true; renderAskBar(); renderPill();
    return;
  }
  renderHeader(m); renderStatus(m); renderToolbar(m); renderBody(m); renderAsks(m); renderAskBar(); renderPill();
  if (state.drawerOpen) renderSegments(els.segments);
}

function renderHeader(m) {
  if (document.activeElement !== els.title) els.title.textContent = m.title || '';
  if (isImported(m)) els.title.removeAttribute('contenteditable'); else els.title.setAttribute('contenteditable', supportsPlaintextOnly ? 'plaintext-only' : 'true');
  const ev = m.calendar_event;
  const kids = [h('span', { text: `${fmtDateLong(m.started_at)} · ${fmtTime(m.started_at)}` })];
  if (m.duration_ms) kids.push(h('span', { text: fmtDuration(m.duration_ms) }));
  if (isImported(m)) kids.push(h('span', { class: 'badge', text: `Imported from ${SOURCE_LABEL[m.source] || m.source}` }));
  if (m.enhanced?.model) kids.push(h('span', { class: 'small', style: 'color:var(--text-3)', text: `Enhanced · ${m.enhanced.model}` }));
  if (ev?.attendees?.length) kids.push(h('span', { class: 'chips' }, ...ev.attendees.slice(0, 8).map((a) => h('span', { class: 'chip', text: a, title: a })),
    ev.attendees.length > 8 && h('span', { class: 'chip', text: `+${ev.attendees.length - 8}` })));
  if (ev?.meet_url && /^https:\/\//.test(ev.meet_url)) kids.push(h('a', { href: ev.meet_url, target: '_blank', rel: 'noopener noreferrer', text: 'Join call' }));
  replace(els.meta, ...kids);
  const segCount = m.segments?.length || 0;
  replace(els.docActions,
    h('button', { class: 'icon-btn', type: 'button', title: 'Transcript', 'aria-label': `Transcript, ${segCount} segments`, 'aria-pressed': String(state.drawerOpen), onclick: toggleDrawer }, icon('transcript')),
    h('button', { class: 'icon-btn', type: 'button', title: 'More', 'aria-label': 'More actions', onclick: (e) => { e.stopPropagation(); toggleMenu(m); } }, icon('more')));
}
function toggleMenu(m) {
  if (closeMenu()) return;
  const fileName = `${(m.title || 'meeting').replace(/[\\/:*?"<>|]+/g, '-')}.md`;
  const menu = h('div', { class: 'menu', role: 'menu', onclick: (e) => e.stopPropagation() },
    h('button', { type: 'button', text: 'Copy as Markdown', onclick: () => { closeMenu(); copyMarkdown(m); } }),
    h('a', { href: API.exportUrl(m.id), download: fileName, text: 'Export .md', style: 'display:block;padding:10px 12px;min-height:44px;line-height:24px;border-radius:7px;color:var(--text)', onclick: () => setTimeout(closeMenu) }),
    m.source === 'meetings' && h('button', { type: 'button', class: 'danger', text: 'Remove meeting', onclick: () => { closeMenu(); deleteMeeting(m); } }));
  els.docActions.append(menu);
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }));
}
function closeMenu() { const open = els.docActions && $('.menu', els.docActions); if (open) open.remove(); return !!open; }
function deleteMeeting(m) {
  if (isLiveHere(m)) { toast('Stop the recording before deleting.', { error: true }); return; }
  confirmToast(`Remove “${m.title || 'Untitled meeting'}” from the app? Its saved data is retained in the app volume.`, 'Remove', async () => {
    try { await API.remove(m.id); state.meetings = state.meetings.filter((x) => x.id !== m.id); localStorage.removeItem(draftKey(m.id)); toast('Meeting removed'); if (state.current?.id === m.id) navigate(null); else renderList(); }
    catch (e) { toast(`Couldn't delete: ${errMsg(e)}`, { error: true }); }
  });
}
async function copyMarkdown(m) {
  const body = state.docMode === 'enhanced' && m.enhanced ? stripMarks(m.enhanced.markdown) : (m.notes || '');
  const text = `# ${m.title || 'Untitled meeting'}\n\n${fmtDateLong(m.started_at)}\n\n${body}`.trim() + '\n';
  try { await navigator.clipboard.writeText(text); toast('Copied as Markdown'); }
  catch { toast('Clipboard unavailable. Use Export instead.', { error: true }); }
}
async function saveTitle() {
  const m = state.current; if (!m || isImported(m)) return;
  const title = els.title.textContent.replace(/\s+/g, ' ').trim();
  if (title === (m.title || '')) { els.title.textContent = m.title || ''; return; }
  try {
    const d = await API.patch(m.id, { title });
    if (state.current?.id === m.id) { setCurrent({ ...state.current, title: d.title }); if (document.activeElement !== els.title) els.title.textContent = d.title || ''; }
    if (state.rec?.meetingId === m.id) state.rec.title = d.title;
  } catch (e) { els.title.textContent = m.title || ''; toast(`Couldn't rename: ${errMsg(e)}`, { error: true }); }
}

function renderStatus(m) {
  const kids = [];
  const r = state.rec?.meetingId === m.id ? state.rec : null;
  if (r?.phase === 'error') {
    kids.push(h('div', { class: 'notice warn' }, h('span', { class: 'msg', text: r.error || 'Recording failed to start.' }),
      h('button', { class: 'btn sm primary', type: 'button', text: 'Try again', onclick: () => beginRecording({}) }),
      h('button', { class: 'btn sm', type: 'button', text: 'Stop meeting', onclick: () => finishWithoutAudio(m) })));
  } else if (m.status === 'recording' && !r && pendingAutostart?.id !== m.id) {
    kids.push(h('div', { class: 'notice' }, h('span', { class: 'dot pulse' }),
      h('span', { class: 'msg', text: 'This meeting is still marked as recording, perhaps from another device or an interrupted session.' }),
      h('button', { class: 'btn sm primary', type: 'button', text: 'Resume here', onclick: () => beginRecording({ resume: true }) }),
      h('button', { class: 'btn sm', type: 'button', text: 'Stop', onclick: () => finishWithoutAudio(m) })));
  } else if (m.status === 'processing') {
    const n = m.jobs?.transcribe_pending || 0;
    kids.push(h('div', { class: 'notice accent' }, h('span', { class: 'spinner' }),
      h('span', { class: 'msg', text: n ? `Transcribing… ${pluralize(n, 'chunk')} left.` : 'Finishing the transcript…' })));
  }
  if (!navigator.onLine) kids.push(h('div', { class: 'notice warn' }, h('span', { class: 'msg', text: 'You are offline. Notes are kept on this device and will save when you reconnect.' })));
  replace(els.docStatus, ...kids);
}

function renderToolbar(m) {
  const kids = [];
  const hasNotes = !isImported(m) || !!(m.notes && m.notes.trim());
  const running = m.jobs?.enhance === 'running';
  const canEnhance = !!(m.notes?.trim() || m.segments?.length) && m.status === 'ready';
  if (m.enhanced || running) {
    kids.push(h('div', { class: 'seg', role: 'group', 'aria-label': 'View' },
      hasNotes && h('button', { type: 'button', text: 'My notes', 'aria-pressed': String(state.docMode === 'notes'), onclick: () => setDocMode('notes') }),
      h('button', { type: 'button', text: 'Enhanced', 'aria-pressed': String(state.docMode === 'enhanced'), onclick: () => setDocMode('enhanced') })));
  }
  if (m.enhanced || running || canEnhance) {
    const cur = running ? state.pendingTemplate : m.enhanced?.template;
    kids.push(h('div', { class: 'seg', role: 'group', 'aria-label': 'Template' }, ...TEMPLATES.map(([key, label]) =>
      h('button', { type: 'button', text: label, 'aria-pressed': String(cur === key), disabled: running || m.status !== 'ready', onclick: () => runEnhance(m, key) }))));
    if (!m.enhanced && !running) kids.push(h('span', { class: 'small muted', text: 'Pick a template to enhance' }));
  }
  kids.push(h('span', { class: 'spacer' }));
  if (!isImported(m)) kids.push(h('span', { class: 'saved off', id: 'saved' }, 'Saved'));
  replace(els.docToolbar, ...kids);
  renderSaved();
}
function setDocMode(mode) { state.docMode = mode; renderToolbar(state.current); renderBody(state.current); }
async function runEnhance(m, template) {
  state.pendingTemplate = template;
  try {
    await API.enhance(m.id, template);
    if (state.current?.id !== m.id) return;
    setCurrent({ ...state.current, jobs: { ...(state.current.jobs || {}), enhance: 'running' } });
    state.docMode = 'enhanced'; renderDoc(); schedulePoll();
  } catch (e) { toast(`Couldn't start Enhance: ${errMsg(e)}`, { error: true }); }
}

function renderBody(m) {
  const imported = isImported(m);
  const showEnhanced = state.docMode === 'enhanced' && (m.enhanced || m.jobs?.enhance === 'running' || m.jobs?.enhance === 'error');
  els.enhanced.hidden = !showEnhanced;
  els.notepad.hidden = showEnhanced || imported;
  if (showEnhanced) renderEnhanced(m);
  if (imported) {
    // Imported meetings are read-only: rendered notes (if any) plus the transcript inline.
    const parts = [];
    if (!showEnhanced) parts.push(m.notes ? h('div', { class: 'md', html: md(m.notes) }) : h('p', { class: 'muted', text: 'No notes were imported for this meeting.' }));
    parts.push(h('h3', { text: 'Transcript' }), h('div', { class: 'segments', id: 'segments-inline' }));
    replace(els.transcriptInline, ...parts); els.transcriptInline.hidden = false;
    renderSegments($('#segments-inline'));
  } else { els.transcriptInline.hidden = true; clear(els.transcriptInline); autogrow(); }
  renderConflict();
}
function renderEnhanced(m) {
  const box = els.enhanced;
  if (m.jobs?.enhance === 'running') {
    const label = TEMPLATES.find(([k]) => k === state.pendingTemplate)?.[1];
    replace(box, h('div', { class: 'state' }, h('span', { class: 'spinner' }), `Enhancing notes${label ? ` with the ${label} template` : ''}…`),
      h('div', { class: 'placeholder' }, ...[70, 95, 85, 40, 90, 60].map((w) => h('div', { class: 'skeleton line', style: `width:${w}%` }))));
    return;
  }
  if (!m.enhanced) {
    replace(box, h('div', { class: 'notice warn' }, h('span', { class: 'msg', text: 'Enhance did not finish.' }),
      h('button', { class: 'btn sm primary', type: 'button', text: 'Try again', onclick: () => runEnhance(m, state.pendingTemplate || 'general') })));
    return;
  }
  replace(box, h('div', { class: 'md marks', html: md(m.enhanced.markdown, { marks: true, evidence: true, shift: 1 }) }));
}

// Notes autosave: debounce 800 ms, PUT with base_rev, 409 → keep both copies visible.
function autogrow() { const t = els.notepad; if (t.hidden) return; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }
function renderSaved() {
  const el = $('#saved'); if (!el) return;
  const n = state.notes;
  el.textContent = n.saving ? 'Saving…' : n.dirty ? 'Unsaved' : 'Saved';
  el.classList.toggle('off', !n.saving && !n.dirty && !n.flash);
}
function onNotesInput() {
  if (!state.current || isImported(state.current)) return;
  state.notes.dirty = true; renderSaved(); autogrow();
  localStorage.setItem(draftKey(state.current.id), els.notepad.value);
  saveNotesDebounced();
}
const saveNotesDebounced = debounce(saveNotes, 800);
function flushNotes() { if (state.current && state.notes.dirty && !state.notes.saving) { saveNotesDebounced.cancel(); saveNotes(); } }
async function saveNotes() {
  const m = state.current; const n = state.notes;
  if (!m || isImported(m) || n.saving || n.conflict || !n.dirty) return;
  const text = els.notepad.value; const id = m.id;
  n.saving = true; n.dirty = false; renderSaved();
  try {
    const r = await API.notes(id, text, n.rev);
    n.rev = r.notes_rev;
    if (state.current?.id !== id) { localStorage.removeItem(draftKey(id)); return; }
    m.notes = text;
    if (!n.dirty) localStorage.removeItem(draftKey(id));
    n.flash = true; renderSaved(); setTimeout(() => { n.flash = false; renderSaved(); }, 1500);
  } catch (e) {
    if (state.current?.id !== id) return; // draft stays in localStorage and is offered on next open
    if (e instanceof ApiError && e.status === 409 && e.data) {
      n.conflict = { draft: text, server: e.data.notes || '', rev: e.data.notes_rev };
      els.notepad.value = n.conflict.server; n.rev = n.conflict.rev; m.notes = n.conflict.server;
      renderConflict(); autogrow();
    } else {
      n.dirty = true; // keep the text and keep trying
      toast(`Notes not saved: ${errMsg(e)}`, { error: true, action: { label: 'Retry', fn: saveNotes } });
      setTimeout(() => { if (state.current?.id === id && state.notes.dirty) saveNotesDebounced(); }, 5000);
    }
  } finally { n.saving = false; if (state.current?.id === id) { renderSaved(); if (n.dirty && !n.conflict) saveNotesDebounced(); } }
}
function renderConflict() {
  const c = state.notes.conflict;
  els.conflict.hidden = !c || els.notepad.hidden;
  if (!c) { clear(els.conflict); return; }
  replace(els.conflict, h('div', { class: 'notice warn', style: 'flex-direction:column;align-items:stretch' },
    h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      h('span', { class: 'msg', text: 'Your unsaved draft differs from the saved notes. The notepad shows the saved copy; your draft is kept below until you choose.' }),
      h('button', { class: 'btn sm primary', type: 'button', text: 'Use my draft', onclick: () => { els.notepad.value = c.draft; state.notes.conflict = null; state.notes.dirty = true; renderConflict(); autogrow(); saveNotes(); } }),
      h('button', { class: 'btn sm', type: 'button', text: 'Keep saved copy', onclick: () => { state.notes.conflict = null; localStorage.removeItem(draftKey(state.current.id)); renderConflict(); } })),
    h('textarea', { class: 'draft', readonly: true, 'aria-label': 'Your unsaved draft', text: c.draft })));
}
// Light markdown feel in the notepad: bullets and numbered lists continue on Enter, Tab indents a bullet.
function notepadKeydown(e) {
  const t = els.notepad;
  if (e.key !== 'Enter' && e.key !== 'Tab') return;
  if (e.isComposing || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  const s = t.selectionStart; const v = t.value;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  const m = /^(\s*)([-*]|\d+[.)])\s(\[[ xX]\]\s)?(.*)$/.exec(v.slice(lineStart, s));
  if (e.key === 'Tab') {
    if (!m || t.selectionEnd !== s) return;
    e.preventDefault(); insertText(t, lineStart, lineStart, '  ');
    return;
  }
  if (!m) return;
  e.preventDefault();
  if (!m[4].trim()) { insertText(t, lineStart, s, ''); return; } // empty bullet ends the list
  const marker = /^\d/.test(m[2]) ? `${parseInt(m[2], 10) + 1}${m[2].endsWith(')') ? ')' : '.'}` : m[2];
  insertText(t, s, t.selectionEnd, `\n${m[1]}${marker} ${m[3] ? '[ ] ' : ''}`);
}
function insertText(t, start, end, text) {
  t.setSelectionRange(start, end);
  let done = false;
  try { done = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text); } catch { done = false; }
  if (!done) { t.setRangeText(text, start, end, 'end'); t.dispatchEvent(new Event('input', { bubbles: true })); }
}

// ───────────────────────── 7. Transcript ─────────────────────────
function toggleDrawer() { if (state.drawerOpen) closeDrawer(); else openDrawer(); }
function openDrawer() {
  if (!state.current) return;
  state.drawerOpen = true; els.drawer.hidden = false; els.docPane.dataset.drawer = '1';
  renderSegments(els.segments, { scrollEnd: true }); renderHeader(state.current); renderPill();
}
function closeDrawer() {
  if (!state.drawerOpen) return;
  state.drawerOpen = false; els.drawer.hidden = true; els.docPane.dataset.drawer = '';
  if (state.current) { renderHeader(state.current); renderPill(); }
}
function renderSegments(container, { scrollEnd = false } = {}) {
  if (!container) return;
  const m = state.current; const segs = m?.segments || [];
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  const kids = segs.map((s) => h('div', { class: `seg-row ${s.source || 'mixed'}`, dataset: { segId: s.id } },
    h('div', { class: 'who' }, s.source === 'me' ? 'Me' : s.source === 'them' ? 'Them' : 'Mix', h('span', { class: 'ts', text: fmtClock(s.start_ms || 0) })),
    h('div', { class: 'txt', text: s.text })));
  if (!kids.length) {
    const live = m && (m.status === 'recording' || m.status === 'processing');
    kids.push(h('div', { class: 'empty', text: live ? 'Listening… words appear here a few seconds after they are spoken.' : 'No transcript for this meeting.' }));
  }
  replace(container, ...kids);
  if (container === els.segments) {
    els.drawerCount.textContent = segs.length ? `· ${segs.length}` : '';
    const pending = m?.jobs?.transcribe_pending || state.segPending || 0;
    els.drawerPending.textContent = pending ? `${pluralize(pending, 'chunk')} transcribing` : (m?.status === 'recording' ? 'Live' : '');
    if (scrollEnd || atBottom) container.scrollTop = container.scrollHeight;
  }
}
function showEvidence(ref) {
  const m = state.current; if (!m?.enhanced) return;
  const ev = (m.enhanced.evidence || []).find((x) => x.ref === ref);
  let seg = ev?.segment_id ? m.segments?.find((s) => s.id === ev.segment_id) : null;
  if (!seg && ev && m.segments?.length) seg = m.segments.reduce((best, s) => (Math.abs((s.start_ms || 0) - ev.start_ms) < Math.abs((best.start_ms || 0) - ev.start_ms) ? s : best));
  if (!seg) { toast(ev?.quote ? `Evidence: “${ev.quote}”` : 'No transcript segment for this reference.'); return; }
  let container;
  if (isImported(m)) container = $('#segments-inline'); else { openDrawer(); container = els.segments; }
  const row = container?.querySelector(`[data-seg-id="${CSS.escape(seg.id)}"]`);
  if (!row) return;
  container.querySelectorAll('.seg-row.hit').forEach((r) => r.classList.remove('hit'));
  row.classList.add('hit');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => row.classList.remove('hit'), 3500);
}

// Polling: segments every 2 s while recording here; detail every 3 s while processing / enhancing / asks pending.
function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }
function needsDetailPoll(m) {
  return !!m && (m.status === 'processing' || m.jobs?.enhance === 'running' || (m.asks || []).some((a) => a.status === 'pending') || (m.status === 'recording' && !isLiveHere(m)));
}
function schedulePoll() {
  stopPolling();
  const m = state.current; if (!m) return;
  if (m.status === 'recording' && isLiveHere(m)) state.pollTimer = setTimeout(pollSegments, 2000);
  else if (needsDetailPoll(m)) state.pollTimer = setTimeout(pollDetail, 3000);
}
async function pollSegments() {
  const m = state.current; if (!m) return;
  const id = m.id;
  try {
    const last = m.segments?.length ? m.segments[m.segments.length - 1].id : '';
    const r = await API.segments(id, last);
    if (state.current?.id !== id) return;
    if (r.segments?.length) { state.current.segments = [...(state.current.segments || []), ...r.segments]; renderHeader(state.current); renderPill(); }
    state.segPending = r.transcribe_pending || 0;
    if (state.drawerOpen) renderSegments(els.segments);
  } catch { /* transient; try again on the next tick */ }
  schedulePoll();
}
async function pollDetail() {
  const m = state.current; if (!m) return;
  const id = m.id;
  try {
    const d = await API.meeting(id);
    if (state.current?.id !== id) return;
    const sig = (x) => JSON.stringify([x.status, x.jobs, x.enhanced?.created_at, (x.asks || []).map((a) => a.status), x.segments?.length, x.title, x.duration_ms]);
    const changed = sig(d) !== sig(m);
    setCurrent(d);
    if (changed) renderDoc();
  } catch { /* transient */ }
  schedulePoll();
}

// ───────────────────────── 8. Capture ─────────────────────────
const SAMPLE_RATE = 16000;
function wavBlob(int16) {
  const buf = new ArrayBuffer(44 + int16.length * 2); const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + int16.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, int16.length * 2, true);
  new Int16Array(buf, 44).set(int16);
  return new Blob([buf], { type: 'audio/wav' });
}
const supportsSystemAudio = () => !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad/i.test(navigator.userAgent);
const requestDisplayAudio = () => navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
// Called synchronously inside a click: creates the AudioContext (Safari/WKWebView) and, if the user
// opted in, asks for computer audio (Chrome needs a fresh gesture for getDisplayMedia).
function prewarmCapture() {
  if (window.wizardNative?.meetings?.capabilities?.apiBaseUrl === true) return {};
  const warm = {};
  try { warm.ctx = new AudioContext(); warm.ctx.resume?.(); } catch { /* no WebAudio */ }
  if (prefs.systemAudio && supportsSystemAudio()) warm.display = requestDisplayAudio().catch((e) => { warm.displayError = e; return null; });
  return warm;
}
function discardWarm(w) {
  if (!w) return;
  w.ctx?.close?.().catch(() => {});
  w.display?.then((s) => s?.getTracks().forEach((t) => t.stop()));
}

// In-memory upload queue with exponential backoff; one request in flight at a time.
class Uploader {
  constructor(meetingId, onChange) { this.meetingId = meetingId; this.onChange = onChange; this.q = []; this.running = false; this.failures = 0; this.lastError = null; this.abandoned = false; this.sleeper = null; }
  get pending() { return this.q.length; }
  enqueue(item) { this.q.push(item); this.onChange(); this.pump(); }
  wake() { this.failures = 0; if (this.sleeper) this.sleeper(); }
  async pump() {
    if (this.running) return; this.running = true;
    while (this.q.length && !this.abandoned) {
      const it = this.q[0];
      try {
        await API.chunk(this.meetingId, it.source, it.seq, it.startMs, it.blob);
        this.q.shift(); this.failures = 0; this.lastError = null; this.onChange();
      } catch (e) {
        this.failures++; this.lastError = e; this.onChange();
        const wait = Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5));
        await new Promise((r) => { this.sleeper = r; setTimeout(r, wait); }); this.sleeper = null;
      }
    }
    this.running = false; this.onChange();
  }
  async drain() { while (this.q.length && !this.abandoned) { this.pump(); await sleep(250); } }
  abandon() { this.abandoned = true; this.wake(); }
}

class BrowserRecorder {
  constructor(meetingId, cbs, { warm = null, seqBase = {}, offsetMs = 0 } = {}) {
    this.meetingId = meetingId; this.cbs = cbs; this.warm = warm || {}; this.ctx = this.warm.ctx || null; this.seqBase = seqBase; this.offsetMs = offsetMs;
    this.tracks = new Map(); this.startedAt = 0; this.pausedAt = 0; this.pausedTotal = 0; this.raf = 0; this.stopped = false; this.sink = null;
    this.uploader = new Uploader(meetingId, () => cbs.onQueue(this.uploader));
  }
  get elapsedMs() { if (!this.startedAt) return this.offsetMs; return this.offsetMs + (this.pausedAt || performance.now()) - this.startedAt - this.pausedTotal; }
  get hasSystemAudio() { return this.tracks.has('them'); }
  async start({ systemAudio }) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record audio.');
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext();
    if (!this.ctx.audioWorklet) throw new Error('AudioWorklet is not available in this browser.');
    let displayP = this.warm.display || null;
    if (!displayP && systemAudio && supportsSystemAudio()) displayP = requestDisplayAudio().catch((e) => { this.warm.displayError = e; return null; });
    await this.ctx.audioWorklet.addModule('capture-worklet.js');
    this.sink = this.ctx.createGain(); this.sink.gain.value = 0; this.sink.connect(this.ctx.destination);
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.startedAt = performance.now();
    this.addSource('me', mic, this.offsetMs);
    if (displayP) {
      const disp = await displayP;
      try { if (!disp) throw this.warm.displayError || new Error('cancelled'); this.attachDisplay(disp); }
      catch (e) { this.cbs.onWarn(`Computer audio not captured: ${e?.message || e?.name || e}.`); }
    }
    this.meter();
  }
  addSource(name, stream, baseMs) {
    const src = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser(); analyser.fftSize = 512;
    const node = new AudioWorkletNode(this.ctx, 'pcm16-downsampler', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { targetRate: SAMPLE_RATE, chunkSeconds: 5 } });
    src.connect(analyser); analyser.connect(node); node.connect(this.sink);
    const t = { name, stream, src, analyser, node, seq: this.seqBase[name] || 0, samples: 0, baseMs, data: new Uint8Array(analyser.fftSize), flushResolve: null };
    node.port.onmessage = (e) => this.onChunk(t, e.data);
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (this.stopped) return; if (name === 'them') this.removeSystemAudio(); else this.cbs.onWarn('Microphone was disconnected. Stop and resume to continue.'); });
    this.tracks.set(name, t);
  }
  onChunk(t, msg) {
    if (msg?.type !== 'chunk') return;
    const samples = msg.samples;
    if (samples?.length) {
      const startMs = Math.round(t.baseMs + t.samples / (SAMPLE_RATE / 1000));
      t.samples += samples.length;
      this.uploader.enqueue({ source: t.name, seq: t.seq++, startMs, blob: wavBlob(samples) });
    }
    if (msg.final && t.flushResolve) { t.flushResolve(); t.flushResolve = null; }
  }
  attachDisplay(disp) {
    disp.getVideoTracks().forEach((v) => { v.stop(); disp.removeTrack(v); });
    if (!disp.getAudioTracks().length) { disp.getTracks().forEach((x) => x.stop()); throw new Error('no audio was shared (tick “Share audio” in the picker)'); }
    this.addSource('them', disp, this.elapsedMs);
    this.cbs.onState();
  }
  async addSystemAudio() { if (this.tracks.has('them')) return; this.attachDisplay(await requestDisplayAudio()); }
  async removeSystemAudio() {
    const t = this.tracks.get('them'); if (!t) return;
    await this.flush(t); this.teardown(t); this.tracks.delete('them'); this.cbs.onState();
  }
  meter() {
    const tick = () => {
      let level = 0;
      for (const t of this.tracks.values()) {
        t.analyser.getByteTimeDomainData(t.data);
        let sum = 0; for (let i = 0; i < t.data.length; i++) { const x = (t.data[i] - 128) / 128; sum += x * x; }
        level = Math.max(level, Math.sqrt(sum / t.data.length));
      }
      this.cbs.onLevel(this.pausedAt ? 0 : Math.min(1, level * 3));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  async pause() { if (this.pausedAt) return; this.pausedAt = performance.now(); await this.ctx.suspend(); }
  async resume() { if (!this.pausedAt) return; this.pausedTotal += performance.now() - this.pausedAt; this.pausedAt = 0; await this.ctx.resume(); }
  flush(t) { return new Promise((res) => { t.flushResolve = res; t.node.port.postMessage({ type: 'flush' }); setTimeout(res, 1500); }); }
  teardown(t) {
    try { t.node.port.onmessage = null; t.src.disconnect(); t.analyser.disconnect(); t.node.disconnect(); } catch { /* already gone */ }
    t.stream.getTracks().forEach((x) => x.stop());
  }
  async stop() {
    this.stopped = true; cancelAnimationFrame(this.raf);
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    await Promise.all([...this.tracks.values()].map((t) => this.flush(t)));
    for (const t of this.tracks.values()) this.teardown(t);
    this.tracks.clear();
    await this.ctx.close().catch(() => {});
    this.cbs.onLevel(0);
  }
  async abort() {
    this.stopped = true; cancelAnimationFrame(this.raf);
    for (const t of this.tracks.values()) this.teardown(t);
    this.tracks.clear(); discardWarm({ display: this.warm.display });
    await this.ctx?.close?.().catch(() => {});
    this.uploader.abandon();
  }
}

// Native shell bridge (Wizard Mac app / Android): same chunk contract, capture and upload handled natively.
class NativeRecorder {
  constructor(bridge, meetingId, cbs) {
    this.b = bridge; this.meetingId = meetingId; this.cbs = cbs; this.startedAt = 0; this.pausedAt = 0; this.pausedTotal = 0; this.systemAudio = false;
    this.uploader = { pending: 0, lastError: null, abandoned: false, drain: async () => {}, wake() {}, abandon() {} };
  }
  get elapsedMs() { return this.startedAt ? (this.pausedAt || performance.now()) - this.startedAt - this.pausedTotal : 0; }
  get hasSystemAudio() { return this.systemAudio; }
  async start({ systemAudio }) {
    this.systemAudio = !!systemAudio;
    this.b.onLevel?.((lvl) => this.cbs.onLevel(Math.min(1, Number(lvl) || 0)));
    await this.b.start({ meetingId: this.meetingId, includeSystemAudio: !!systemAudio, apiBaseUrl: new URL("api/", location.href).href });
    this.startedAt = performance.now();
  }
  async pause() { if (!this.b.pause) return; this.pausedAt = performance.now(); await this.b.pause(); }
  async resume() { if (!this.b.resume) return; this.pausedTotal += performance.now() - this.pausedAt; this.pausedAt = 0; await this.b.resume(); }
  async stop() { await this.b.stop(); this.cbs.onLevel(0); }
  async abort() { try { await this.b.stop(); } catch { /* ignore */ } }
}

// ───────────────────────── 9. Recording controller + pill ─────────────────────────
let captureTimer = null;
async function captureHeartbeat() {
  const r = state.rec; if (!r?.engine || r.phase !== 'recording') return;
  try {
    const control = await api(`api/meetings/${enc(r.meetingId)}/capture`, {method:'POST',json:{}});
    if (state.rec !== r || r.phase !== 'recording') return;
    if (control.stop_requested || control.status !== 'recording') await stopRecording();
  } catch { /* transient: keep local capture and retry the lease */ }
}

function recElapsed() { return state.rec?.engine?.elapsedMs || 0; }
async function beginRecording({ warm = null, resume = false } = {}) {
  const m = state.current; if (!m) return;
  if (state.rec && state.rec.phase !== 'error') return;
  if (state.rec) endRecSession();
  const cbs = {
    onLevel: (lvl) => updateLevel(lvl),
    onQueue: () => renderPillQueue(),
    onState: () => renderPill(),
    onWarn: (msg) => toast(msg, { error: true }),
  };
  const candidateBridge = window.wizardNative?.meetings;
  const bridge = candidateBridge?.capabilities?.apiBaseUrl === true ? candidateBridge : null;
  let engine;
  if (bridge) engine = new NativeRecorder(bridge, m.id, cbs);
  else {
    const seqBase = {}; let offsetMs = 0;
    if (resume) {
      for (const t of m.audio?.tracks || []) seqBase[t.source] = t.chunks || 0;
      offsetMs = Math.max(m.duration_ms || 0, ...(m.segments || []).map((s) => s.end_ms || 0), (seqBase.me || 0) * 5000);
    }
    engine = new BrowserRecorder(m.id, cbs, { warm, seqBase, offsetMs });
  }
  state.rec = { meetingId: m.id, title: m.title, engine, phase: 'starting', paused: false, error: null };
  renderDoc(); renderRecBanner();
  try {
    await engine.start({ systemAudio: prefs.systemAudio });
    if (state.rec?.engine !== engine) return;
    state.rec.phase = 'recording';
    clearInterval(captureTimer); captureTimer = setInterval(captureHeartbeat, 2000);
    await captureHeartbeat();
    if (state.rec?.engine !== engine) return;
    if (state.current?.id === m.id && state.current.status !== 'recording') setCurrent({ ...state.current, status: 'recording' });
  } catch (e) {
    try { await engine.abort(); } catch { /* ignore */ }
    if (state.rec?.engine !== engine) return;
    state.rec.phase = 'error'; state.rec.engine = null;
    state.rec.error = e?.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser or system settings, then try again.'
      : e?.name === 'NotFoundError' ? 'No microphone was found.' : `Recording couldn't start: ${e?.message || e}`;
  }
  if (state.current?.id === m.id) renderDoc();
  renderRecBanner(); schedulePoll(); startPillClock();
}
async function togglePause() {
  const r = state.rec; if (!r?.engine || r.phase !== 'recording') return;
  try { if (r.paused) { await r.engine.resume(); r.paused = false; } else { await r.engine.pause(); r.paused = true; } }
  catch (e) { toast(errMsg(e), { error: true }); }
  renderPill();
}
async function toggleSystemAudio() {
  const r = state.rec; if (!(r?.engine instanceof BrowserRecorder)) return;
  try { if (r.engine.hasSystemAudio) await r.engine.removeSystemAudio(); else await r.engine.addSystemAudio(); }
  catch (e) { if (e?.name !== 'NotAllowedError') toast(`Computer audio: ${e.message || e.name}`, { error: true }); }
  renderPill();
}
async function stopRecording() {
  const r = state.rec; if (!r?.engine || r.phase !== 'recording') return;
  const id = r.meetingId; const engine = r.engine;
  r.phase = 'stopping'; renderPill(); renderAskBar();
  try {
    await engine.stop();
    r.phase = 'uploading'; renderPill();
    await engine.uploader.drain();
    if (engine.uploader.abandoned) return; // "Stop anyway" took over
    await finishStop(id);
  } catch (e) {
    r.phase = 'error'; r.error = `Couldn't finish the recording: ${errMsg(e)}`; renderPill();
    if (state.current?.id === id) renderDoc();
    toast(r.error, { error: true, action: { label: 'Retry stop', fn: () => finishStop(id) } });
  }
}
async function finishStop(id) {
  try {
    const d = await API.stop(id);
    if (state.rec?.meetingId === id) endRecSession();
    if (state.current?.id === id) { setCurrent(d); state.docMode = d.enhanced ? 'enhanced' : 'notes'; renderDoc(); schedulePoll(); }
    else loadMeetings();
    toast('Recording saved. The transcript and enhanced notes are on their way.');
  } catch (e) {
    toast(`Couldn't stop the meeting: ${errMsg(e)}`, { error: true, action: { label: 'Retry', fn: () => finishStop(id) } });
    if (state.rec?.meetingId === id) { state.rec.phase = 'error'; state.rec.error = 'Audio was uploaded, but the server did not confirm the stop.'; renderPill(); if (state.current?.id === id) renderDoc(); }
  }
}
function stopAnyway() {
  const r = state.rec; if (!r) return;
  const lost = r.engine?.uploader?.pending || 0;
  const go = () => { r.engine?.uploader?.abandon?.(); finishStop(r.meetingId); };
  if (lost) confirmToast(`${pluralize(lost, 'chunk')} of audio could not be uploaded and will be lost.`, 'Stop anyway', go); else go();
}
async function finishWithoutAudio(m) {
  if (state.rec?.meetingId === m.id) { try { await state.rec.engine?.abort?.(); } catch { /* ignore */ } endRecSession(); }
  await finishStop(m.id);
}
function endRecSession() { clearInterval(captureTimer); captureTimer=null; stopPillClock(); state.rec = null; renderRecBanner(); renderPill(); renderAskBar(); els.docPane.dataset.rec = ''; }

let pillClock = 0;
function startPillClock() { stopPillClock(); pillClock = setInterval(() => { tickPillClock(); renderRecBanner(); }, 500); }
function stopPillClock() { clearInterval(pillClock); pillClock = 0; }
function tickPillClock() { const c = $('.clock', els.pill); if (c && state.rec) c.textContent = fmtClock(recElapsed()); }
function updateLevel(level) {
  const bars = els.pill.querySelectorAll('.meter i'); if (!bars.length) return;
  const mult = [0.55, 0.85, 1, 0.75, 0.5];
  bars.forEach((b, i) => { b.style.height = `${3 + Math.round(level * 19 * mult[i])}px`; });
}
function renderPill() {
  const r = state.rec; const m = state.current;
  const show = r && m && r.meetingId === m.id && r.phase !== 'error';
  els.pill.hidden = !show;
  if (!show) { clear(els.pill); return; }
  els.pill.className = `pill${r.paused ? ' paused' : ''}`;
  if (r.phase === 'starting') { els.pill.classList.add('state'); replace(els.pill, h('span', { class: 'spinner' }), 'Starting recording…'); return; }
  if (r.phase === 'stopping' || r.phase === 'uploading') {
    els.pill.classList.add('state');
    replace(els.pill, h('span', { class: 'spinner' }), h('span', { class: 'qstate' }), h('button', { class: 'btn sm ghost', type: 'button', text: 'Stop anyway', hidden: true, onclick: stopAnyway }));
    renderPillQueue(); return;
  }
  const segCount = m.segments?.length || 0;
  const sys = r.engine instanceof BrowserRecorder && supportsSystemAudio();
  replace(els.pill,
    h('span', { class: 'meter', 'aria-hidden': 'true' }, ...[0, 1, 2, 3, 4].map(() => h('i'))),
    h('span', { class: 'clock', text: fmtClock(recElapsed()) }),
    r.paused && h('span', { class: 'sub', text: 'Paused' }),
    h('span', { class: 'sub qstate' }),
    sys && h('button', { class: 'icon-btn', type: 'button', title: r.engine.hasSystemAudio ? 'Stop sharing computer audio' : 'Include computer audio', 'aria-label': 'Computer audio', 'aria-pressed': String(r.engine.hasSystemAudio), onclick: toggleSystemAudio }, icon('screen')),
    h('button', { class: 'icon-btn', type: 'button', title: 'Transcript', 'aria-label': 'Live transcript', 'aria-pressed': String(state.drawerOpen), onclick: toggleDrawer }, icon('transcript'), segCount && !state.drawerOpen ? h('span', { class: 'count', text: segCount > 99 ? '99+' : segCount }) : null),
    (r.engine instanceof BrowserRecorder || !!window.wizardNative?.meetings?.pause) && h('button', { class: 'icon-btn', type: 'button', title: r.paused ? 'Resume' : 'Pause', 'aria-label': r.paused ? 'Resume' : 'Pause', onclick: togglePause }, icon(r.paused ? 'play' : 'pause')),
    h('button', { class: 'icon-btn stop', type: 'button', title: 'Stop', 'aria-label': 'Stop recording', onclick: stopRecording }, icon('stop')));
  renderPillQueue();
}
function renderPillQueue() {
  const r = state.rec; const el = $('.qstate', els.pill); if (!r || !el) return;
  const up = r.engine?.uploader; const n = up?.pending || 0; const failing = !!up?.lastError;
  if (r.phase === 'uploading' || r.phase === 'stopping') {
    el.textContent = r.phase === 'stopping' ? 'Finishing…' : n ? `Uploading ${n}…${failing ? ` (${navigator.onLine ? 'retrying' : 'offline'})` : ''}` : 'Saving…';
    const btn = $('.btn', els.pill); if (btn) btn.hidden = !(failing && n);
    return;
  }
  el.textContent = n > 1 || failing ? `${navigator.onLine ? '' : 'Offline · '}${pluralize(n, 'chunk')} queued` : '';
  el.classList.toggle('warn', failing);
}

// ───────────────────────── 10. Ask ─────────────────────────
function renderAskBar() {
  const m = state.current;
  els.askMeeting.hidden = !m || state.route.view !== 'meeting' || isLiveHere(m);
}
function renderAsks(m) {
  const asks = [...(m.asks || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  replace(els.asks, ...asks.map((a) => h('div', { class: 'qa', dataset: { id: a.id } },
    h('div', { class: 'q' }, h('span', { text: a.question }), a.created_at && h('span', { class: 'when', text: relTime(a.created_at) })),
    a.status === 'pending' ? h('div', { class: 'a working' }, h('span', { class: 'spinner' }), 'Thinking…')
      : a.status === 'error' ? h('div', { class: 'a error' }, 'Could not answer this. ', h('button', { class: 'btn sm', type: 'button', text: 'Ask again', onclick: () => askMeeting(a.question) }))
      : h('div', { class: 'a md answer', html: md(a.answer || '', { evidence: true }) }))));
}
async function askMeeting(question) {
  const m = state.current; if (!m) return;
  const q = question.trim(); if (!q) return;
  const id = m.id;
  const temp = { id: `tmp_${Date.now()}`, question: q, status: 'pending', created_at: new Date().toISOString() };
  m.asks = [...(m.asks || []), temp]; renderAsks(m);
  els.asks.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  try {
    const r = await API.ask(id, q);
    if (state.current?.id !== id) return;
    state.current.asks = state.current.asks.map((a) => (a.id === temp.id ? (r.ask || { ...temp }) : a));
    renderAsks(state.current); schedulePoll();
  } catch (e) {
    if (state.current?.id !== id) return;
    state.current.asks = state.current.asks.map((a) => (a.id === temp.id ? { ...temp, status: 'error' } : a));
    renderAsks(state.current); toast(`Couldn't ask: ${errMsg(e)}`, { error: true });
  }
}
function renderAskAll() {
  const t = state.askAll.thread;
  replace(els.askAllThread, ...t.map((item) => h('div', { class: 'qa' },
    h('div', { class: 'q' }, h('span', { text: item.question })),
    item.status === 'pending' ? h('div', { class: 'a working' }, h('span', { class: 'spinner' }), 'Searching across your meetings… this can take a little while.')
      : item.status === 'error' ? h('div', { class: 'a error' }, `${item.error} `, h('button', { class: 'btn sm', type: 'button', text: 'Try again', onclick: () => askAll(item.question) }))
      : h('div', { class: 'a' }, h('div', { class: 'md answer', html: md(item.answer || '') }),
        item.meetings?.length ? h('div', { class: 'cites' }, ...item.meetings.map((mm) => h('a', { class: 'chip', href: `#/m/${enc(mm.id)}`, text: `${mm.title || 'Untitled'} · ${dayLabel(mm.started_at)}`, title: mm.title }))) : null))));
  els.askAllThread.lastElementChild?.scrollIntoView({ block: 'nearest' });
}
async function askAll(question) {
  const q = question.trim(); if (!q) return;
  const item = { question: q, status: 'pending' };
  state.askAll.thread = [...state.askAll.thread.filter((x) => x.status !== 'pending' && x.question !== q), item]; renderAskAll();
  try { const r = await API.askAll(q); Object.assign(item, { status: 'done', answer: r.answer, meetings: r.meetings || [] }); }
  catch (e) { Object.assign(item, { status: 'error', error: `Couldn't answer: ${errMsg(e)}.` }); }
  renderAskAll();
  try { sessionStorage.setItem('meetings.askAll', JSON.stringify(state.askAll.thread.filter((x) => x.status === 'done').slice(-10))); } catch { /* quota */ }
}

// ───────────────────────── 11. Boot ─────────────────────────
function bind() {
  Object.assign(els, {
    app: $('#app'), home: $('#home-panel'), doc: $('#doc'), docPane: $('#doc-pane'), docScroll: $('#doc-scroll'),
    upcoming: $('#upcoming'), meetings: $('#meetings'), search: $('#search'), btnNew: $('#btn-new'), listFoot: $('#list-foot'), recBanner: $('#rec-banner'),
    title: $('#title'), meta: $('#meta'), docActions: $('#doc-actions'), docStatus: $('#doc-status'), docToolbar: $('#doc-toolbar'),
    notepad: $('#notepad'), enhanced: $('#enhanced'), conflict: $('#conflict'), transcriptInline: $('#transcript-inline'), asks: $('#asks'),
    askMeeting: $('#ask-meeting'), askMeetingInput: $('#ask-meeting-input'),
    drawer: $('#drawer'), segments: $('#segments'), drawerCount: $('#drawer-count'), drawerPending: $('#drawer-pending'),
    pill: $('#pill'), askAll: $('#ask-all'), askAllMount: $('#ask-all-mount'), askAllThread: $('#ask-all-thread'), askAllForm: $('#ask-all-form'), askAllInput: $('#ask-all-input'),
    sysAudioRow: $('#sys-audio-row'), sysAudio: $('#sys-audio'),
  });

  els.btnNew.addEventListener('click', newMeeting);
  $('#btn-back').addEventListener('click', goBack);
  els.search.addEventListener('input', debounce(() => { state.query = els.search.value.trim(); loadMeetings(); }, 300));
  els.search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { els.search.value = ''; state.query = ''; loadMeetings(); } });

  els.title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); els.title.blur(); }
    if (e.key === 'Escape') { els.title.textContent = state.current?.title || ''; els.title.blur(); }
  });
  els.title.addEventListener('blur', saveTitle);
  els.title.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/\s+/g, ' ');
    let done = false; try { done = document.execCommand('insertText', false, text); } catch { done = false; }
    if (!done) els.title.textContent += text;
  });

  els.notepad.addEventListener('input', onNotesInput);
  els.notepad.addEventListener('keydown', notepadKeydown);
  els.enhanced.addEventListener('click', (e) => { const ev = e.target.closest('.ev'); if (ev) showEvidence(ev.dataset.ref); });
  els.asks?.addEventListener('click', (e) => { const ev = e.target.closest('.ev'); if (ev) showEvidence(ev.dataset.ref); });
  $('#drawer-close').addEventListener('click', closeDrawer);

  els.askMeeting.addEventListener('submit', (e) => { e.preventDefault(); const q = els.askMeetingInput.value; els.askMeetingInput.value = ''; askMeeting(q); });
  els.askAllForm.addEventListener('submit', (e) => { e.preventDefault(); const q = els.askAllInput.value; els.askAllInput.value = ''; askAll(q); });

  els.sysAudioRow.hidden = !(supportsSystemAudio() || !!window.wizardNative?.meetings);
  els.sysAudio.checked = prefs.systemAudio;
  els.sysAudio.addEventListener('change', () => { prefs.systemAudio = els.sysAudio.checked; });
  els.recBanner.addEventListener('click', () => { if (state.rec) navigate(state.rec.meetingId); });

  window.addEventListener('hashchange', () => applyRoute(parseHash()));
  mobileMQ.addEventListener('change', () => { placeAskAll(); renderPill(); });
  window.addEventListener('resize', debounce(autogrow, 100));
  window.addEventListener('online', () => { state.rec?.engine?.uploader?.wake?.(); flushNotes(); if (state.current) renderStatus(state.current); renderPillQueue(); toast('Back online'); });
  window.addEventListener('offline', () => { if (state.current) renderStatus(state.current); renderPillQueue(); });
  window.addEventListener('beforeunload', (e) => { if (state.rec && state.rec.phase !== 'error') { e.preventDefault(); e.returnValue = ''; } else flushNotes(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { flushNotes(); refreshAll(); schedulePoll(); } });
  setInterval(() => { if (!document.hidden && !state.query) { loadCalendar(); if (!state.rec) loadMeetings(); } }, 60000);

  const hour = new Date().getHours();
  $('#greeting').textContent = hour < 5 ? 'Still up?' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  try { state.askAll.thread = JSON.parse(sessionStorage.getItem('meetings.askAll') || '[]'); renderAskAll(); } catch { /* ignore */ }
}

function boot() {
  bind();
  // Guarantee a Home entry beneath any deep link so Android Back steps document → list, never out of the app.
  const route = parseHash();
  if (!location.hash) history.replaceState(null, '', '#/');
  applyRoute(route);
  refreshAll();
}
boot();

// Shared shell invokes this hook; root Back is consumed and never exits the app.
window.__wizardCloseOverlay = window.__wosNativeBack = () => {
  if (state.drawerOpen) { toggleDrawer(); return true; }
  if (state.route.view !== 'home') navigate(null);
  return true;
};
$('#btn-upload').addEventListener('click', () => $('#upload-audio').click());
$('#upload-audio').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const m = await api('api/uploads?'+new URLSearchParams({title:file.name}), {method:'POST',body:file,headers:{'Content-Type':file.type||'application/octet-stream'}});
    await loadMeetings(); navigate(m.id);
    toast('Audio saved. The shared transcriber is processing it.');
  } catch (err) { toast(errMsg(err),{error:true}); }
  e.target.value='';
});
