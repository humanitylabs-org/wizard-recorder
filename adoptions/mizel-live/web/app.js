/*
 * Mizel — front end (no dependencies). Styled by wizard-style.css (shared) + styles.css (app layer).
 *
 *  1. Utilities             7. Transcript (panel + inline, grouped paragraphs, citations)
 *  2. API client            8. Capture: WAV, upload queue, browser + native recorders
 *  3. Markdown renderer     9. Recording controller + floating recorder
 *  4. State & routing      10. Ask (per meeting and across all)
 *  5. Sidebar + home       11. Command palette, shortcuts, native hook
 *  6. Meeting document     12. Boot
 */

// ───────────────────────── 1. Utilities ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

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
const icon = (name, cls = 'w-ic') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use);
  return svg;
};
const kbd = (...keys) => keys.map((k) => h('kbd', { class: 'w-kbd', text: k }));
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const replace = (el, ...kids) => { clear(el).append(...kids.flat().filter(Boolean)); return el; };
function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
const isTyping = (el = document.activeElement) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

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
  if (diff < -1 && diff > -7) return d.toLocaleDateString([], { weekday: 'long' });
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}
const fmtDateLong = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDateShort = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const relTime = (iso) => { const d = new Date(iso); return startOfDay(d) - startOfDay(new Date()) === 0 ? fmtTime(iso) : `${dayLabel(iso)} ${fmtTime(iso)}`; };
const pluralize = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SOURCE_LABEL = { mizel: 'Mizel recorder', anarlog: 'Anarlog', meetings: 'Recorded here' };
const TEMPLATES = [['general', 'General'], ['one_on_one', '1:1'], ['sales', 'Sales']];
const supportsPlaintextOnly = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only'; })();
const initials = (s) => { const t = String(s || '').split('@')[0].split(/[\s._-]+/).filter(Boolean); return ((t[0]?.[0] || '') + (t[1]?.[0] || '')).toUpperCase() || '?'; };
const personName = (s) => { const v = String(s || ''); if (!v.includes('@')) return v; return v.split('@')[0].split(/[._-]+/).map((p) => p[0]?.toUpperCase() + p.slice(1)).join(' '); };

function toast(msg, { error = false, action = null, timeout = error ? 8000 : 3500 } = {}) {
  const el = h('div', { class: `w-toast${error ? ' is-error' : ''}`, role: error ? 'alert' : 'status' }, h('span', { class: 'msg', text: msg }));
  if (action) el.append(h('button', { class: `w-btn w-btn-sm${action.primary ? ' w-btn-primary' : ''}`, type: 'button', text: action.label, onclick: () => { el.remove(); action.fn(); } }));
  el.append(h('button', { class: 'w-icon-btn', type: 'button', 'aria-label': 'Dismiss', style: 'width:28px;height:28px', onclick: () => el.remove() }, icon('close')));
  $('#toasts').append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
// In-app confirmation (window.confirm is unreliable inside bare WKWebViews).
const confirmToast = (msg, label, fn) => toast(msg, { error: true, timeout: 12000, action: { label, fn, primary: true } });
const errMsg = (e) => e?.message || 'Something went wrong';

// ───────────────────────── 2. API client ─────────────────────────
class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || data?.message || `Request failed (${status})`);
    this.status = status; this.data = data;
  }
}
// Browser connectivity flags are hints, never proof a request or local save failed.
async function transport(path, opts = {}) {
  try { return await fetch(path, opts); }
  catch (cause) {
    throw Object.assign(new Error('Could not reach the meeting service. Check the connection and retry.', { cause }), { code: 'transport_unavailable' });
  }
}
async function api(path, { method = 'GET', json, body, headers = {}, cache = 'no-store' } = {}) {
  const opts = { method, headers: { Accept: 'application/json', ...headers }, credentials: 'same-origin', cache };
  if (json !== undefined) { opts.body = JSON.stringify(json); opts.headers['Content-Type'] = 'application/json'; }
  else if (body !== undefined) opts.body = body;
  const res = await transport(path, opts);
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, data);
  }
  if (res.status === 204) return null;
  try { return await res.json(); }
  catch (cause) { throw Object.assign(new Error(`Meeting service returned an unreadable response (${res.status}).`, { cause }), { status: res.status, code: 'invalid_response' }); }
}
const API = {
  meetings: (q = '', limit = 200) => api(`api/meetings?${new URLSearchParams({ q, limit: String(limit) })}`),
  calendar: () => api('api/calendar'),
  create: (body) => api('api/meetings', { method: 'POST', json: body }),
  meeting: (id) => api(`api/meetings/${enc(id)}`),
  patch: (id, body) => api(`api/meetings/${enc(id)}`, { method: 'PATCH', json: body }),
  notes: (id, notes, base_rev) => api(`api/meetings/${enc(id)}/notes`, { method: 'PUT', json: { notes, base_rev } }),
  segments: (id, after) => api(`api/meetings/${enc(id)}/segments?${new URLSearchParams(after ? { after } : {})}`),
  chunk: (id, source, seq, start_ms, blob) =>
    api(`api/meetings/${enc(id)}/chunks?${new URLSearchParams({ source, seq, start_ms })}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'audio/wav' } }),
  stop: (id, body) => api(`api/meetings/${enc(id)}/stop`, body ? { method: 'POST', json: body } : { method: 'POST' }),
  audioUrl: (id) => `api/meetings/${enc(id)}/audio.wav`,
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
  if (opts.evidence) s = s.replace(/\[(E(\d+))\]/g, '<button type="button" class="ev" data-ref="$1" aria-label="Source $2 in transcript">$2</button>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
// opts.marks: lines starting with U+2063 are the user's own ("yours"); all others are "ai".
function md(src, opts = {}) {
  const out = []; let list = null; let code = null;
  const flush = () => { if (list) { out.push(`<${list.type}>${list.items.join('')}</${list.type}>`); list = null; } };
  for (let raw of String(src || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (code) { if (/^\s*```/.test(raw)) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; } else code.push(raw); continue; }
    let cls = '';
    if (opts.marks) { if (raw.startsWith('\u2063')) { cls = ' class="yours"'; raw = raw.slice(1); } else cls = ' class="ai"'; }
    const line = raw.replace(/\u2063/g, '');
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
const stripMarks = (s) => String(s || '').replace(/\u2063/g, '');
const plainPreview = (s) => stripMarks(s).replace(/^\s*# .*$/m, '').replace(/\[E\d+\]/g, ' ').replace(/[#*_`>\[\]]/g, ' ').replace(/\s+/g, ' ').trim();

// ───────────────────────── 4. State & routing ─────────────────────────
const mobileMQ = matchMedia('(max-width: 760px)');
const state = {
  route: { view: 'home', id: null },
  meetings: [], meetingsLoading: true, meetingsError: null,
  calendar: [], calendarError: null, calendarLoaded: false,
  current: null, currentLoading: false, currentError: null,
  docMode: 'notes', // 'notes' | 'enhanced'
  drawerTab: (() => { try { return localStorage.getItem('mizel-live.drawerTab') === 'summary' ? 'summary' : 'transcript'; } catch { return 'transcript'; } })(),
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
// Computer audio is never a start-of-meeting setting: the browser asks the owner to pick a
// window/tab to share, so it is only requested when they press "Them" during a meeting.
try { localStorage.removeItem('meetings.systemAudio'); } catch {}
const draftKey = (id) => `meetings.draft.${id}`;

function parseHash() {
  const ask = /[?&]ask=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1] || null;
  if (/^#\/archimedes/.test(location.hash)) return { view: 'archimedes', id: null, ask };
  const m = /^#\/m\/([^/?#]+)/.exec(location.hash);
  return m ? { view: 'meeting', id: decodeURIComponent(m[1]), ask } : { view: 'home', id: null, ask };
}
function openAsk(id) { const base = location.hash.replace(/[?&]ask=[^&]*/, '') || '#/'; const hash = `${base}${base.includes('?') ? '&' : '?'}ask=${enc(id)}`; const composer = overlay?.manualHistory && history.state?.mizelManualComposer; if (composer) { closeOverlay({ preserveEntry: true }); history.replaceState(null, '', hash); } else if (location.hash !== hash) history.pushState(null, '', hash); applyRoute(parseHash()); }
function closeAskSheet() { if (state.route.ask) history.back(); else closeOverlay(); }
function navigate(id) {
  const hash = id ? `#/m/${enc(id)}` : '#/';
  // Forward hash assignments fire popstate and can be mistaken for shell Back
  // while voice or an overlay is active. Explicit route pushes are forward-only.
  if (location.hash !== hash) history.pushState(null, '', hash);
  applyRoute(parseHash());
}
function goBack() { if (history.length > 1) history.back(); else navigate(null); }
function applyRoute(route) {
  const prev = state.route;
  state.route = route;
  els.app.dataset.view = route.view === 'archimedes' ? 'meeting' : route.view;
  syncAppOrb();
  closeOverlay();
  els.archView.hidden = route.view !== 'archimedes';
  if (route.view === 'archimedes') {
    els.home.hidden = true; els.doc.hidden = true; closeDrawer(); stopPolling(); closeMenu();
    if (state.current && !state.rec) { flushNotes(); state.current = null; }
    replace(els.topStatus, h('span', { class: 'w-badge is-accent', text: 'Archimedes' })); clear(els.docActions);
    renderAskBar(); renderPill(); loadAllAsks();
    if (prev.view !== 'archimedes') els.docScroll.scrollTop = 0;
  } else if (route.view === 'meeting') {
    els.home.hidden = true; els.doc.hidden = false;
    if (state.current?.id !== route.id) loadMeeting(route.id);
    else renderDoc();
  } else {
    flushNotes();
    els.home.hidden = false; els.doc.hidden = true;
    state.current = null; state.currentError = null; closeDrawer(); stopPolling(); closeMenu();
    renderAskBar(); renderPill(); renderHome();
    els.docScroll.scrollTop = 0;
  }
  renderList(); renderRecBanner(); placeAskAll();
  if (route.ask) openAskSheetFor(route.ask);
}
function placeAskAll() {
  const target = mobileMQ.matches ? els.listFoot : els.askAllMount;
  if (els.askAll.parentElement !== target) target.prepend(els.askAll);
}

// ───────────────────────── 5. Sidebar + home ─────────────────────────
async function loadMeetings() {
  state.meetingsLoading = true; state.meetingsError = null; renderList();
  try { const r = await API.meetings(); state.meetings = r.meetings || []; }
  catch (e) { state.meetingsError = errMsg(e); }
  state.meetingsLoading = false; renderList(); renderHome();
}
async function loadCalendar() {
  try { state.calendar = (await API.calendar()).events || []; state.calendarError = null; }
  catch (e) { state.calendarError = errMsg(e); }
  state.calendarLoaded = true;
  renderUpcoming(); renderHome();
}
const refreshAll = () => { loadMeetings(); loadCalendar(); };
// Today in the calendar timezone, plus a four-hour lookahead across midnight.
const upcomingEvents = (now = Date.now()) => {
  const day = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const today = day(now), overnightThrough = now + 4 * 3600000;
  return state.calendar.filter((ev) => {
    const start = new Date(ev.start).getTime(), end = new Date(ev.end).getTime();
    return !ev.allDay && end > now && (day(start) === today || start <= now || start <= overnightThrough);
  });
};
const isOngoing = (ev) => { const now = Date.now(); return new Date(ev.start).getTime() <= now && new Date(ev.end).getTime() >= now; };

function eventAction(ev, { big = false } = {}) {
  const linked = state.meetings.find((m) => m.id === ev.meeting_id);
  if (ev.meeting_id) {
    return h('button', { class: `w-btn ${big ? '' : 'w-btn-sm '}open`, type: 'button', onclick: () => navigate(ev.meeting_id) },
      linked?.status === 'recording' ? [h('span', { class: 'w-live-dot' }), 'Recording'] : 'Open notes');
  }
  if (big) return h('button', { class: 'w-btn w-btn-primary w-btn-lg', type: 'button', onclick: () => startFromEvent(ev) }, icon('mic'), 'Record');
  return h('button', { class: 'go', type: 'button', title: `Record “${ev.title || 'event'}”`, 'aria-label': `Record ${ev.title || 'event'}`, onclick: () => startFromEvent(ev) }, icon('mic'));
}
function renderUpcoming() {
  const box = els.upcoming;
  const events = upcomingEvents();
  if (!events.length) {
    replace(box, state.calendarError && h('div', { class: 'w-notice is-warn list-error' }, h('span', { class: 'msg', text: 'Calendar unavailable.' }), h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'Retry', onclick: loadCalendar })));
    return;
  }
  replace(box, h('h2', { class: 'w-label', text: 'Coming up' }), ...events.map((ev) => {
    const ongoing = isOngoing(ev);
    const sameDay = startOfDay(new Date(ev.start)).getTime() === startOfDay(new Date()).getTime();
    const who = (ev.attendees || []).length ? pluralize(ev.attendees.length, 'person', 'people') : '';
    return h('div', { class: 'event' },
      h('div', { class: `when${ongoing ? ' now' : ''}` }, h('b', { text: ev.allDay ? 'All day' : ongoing ? 'Now' : fmtTime(ev.start) }), ev.allDay ? (ongoing ? 'Today' : dayLabel(ev.start)) : sameDay ? `until ${fmtTime(ev.end)}` : dayLabel(ev.start)),
      h('div', { class: 'body', onclick: ev.meeting_id ? () => navigate(ev.meeting_id) : null },
        h('div', { class: 'name', text: ev.title || 'Untitled event' }),
        h('div', { class: 'sub', text: [who, ev.meet_url ? 'Google Meet' : ''].filter(Boolean).join(' · ') || fmtDateShort(ev.start) })),
      eventAction(ev));
  }));
}

function renderList() {
  renderUpcoming();
  if (els.archEntry) {
    const n = allAsks.list.filter((a) => a.status !== 'cancelled').length;
    $('.n', els.archEntry).textContent = allAsks.loaded ? (n ? String(n) : '') : '';
    els.archEntry.setAttribute('aria-current', String(state.route.view === 'archimedes'));
  }
  const box = els.meetings;
  if (state.meetingsLoading && !state.meetings.length) {
    replace(box, h('h2', { class: 'w-label' }, h('span', { class: 'w-skeleton', text: 'Loading' })), ...[70, 55, 80, 60, 50].map((w) =>
      h('div', { class: 'w-row row sk' }, h('div', { class: 'w-skeleton', style: `width:${w}%` }), h('div', { class: 'w-skeleton', style: `width:${w - 20}%` }))));
    return;
  }
  if (state.meetingsError && !state.meetings.length) {
    replace(box, h('div', { class: 'w-notice is-danger list-error' }, h('span', { class: 'msg', text: `Couldn't load meetings. ${state.meetingsError}.` }),
      h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'Retry', onclick: loadMeetings })));
    return;
  }
  if (!state.meetings.length) {
    replace(box, h('div', { class: 'w-empty' }, h('b', { text: 'No meetings yet' }), 'Record one from your calendar, or start one now.',
      h('br'), h('button', { class: 'w-btn w-btn-primary', type: 'button', onclick: newMeeting }, icon('mic'), 'New meeting')));
    return;
  }
  const groups = new Map();
  for (const m of state.meetings) { const k = dayLabel(m.started_at); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const kids = [];
  for (const [label, items] of groups) { kids.push(h('h2', { class: 'w-label', text: label })); for (const m of items) kids.push(renderRow(m)); }
  replace(box, ...kids);
}
function rowPreview(m) {
  const p = stripMarks(m.preview);
  if (p) return p;
  return m.has_notes ? 'Notes' : m.status === 'recording' ? 'Recording…' : 'Transcript only';
}
function renderRow(m) {
  const active = state.route.view === 'meeting' && state.route.id === m.id;
  const live = m.status === 'recording', proc = m.status === 'processing';
  const lead = live ? h('span', { class: 'w-live-dot' }) : h('span', { class: `src ${m.source}`, title: SOURCE_LABEL[m.source] || m.source });
  return h('button', { class: `w-row row${active ? ' is-active' : ''}`, type: 'button', onclick: () => navigate(m.id), dataset: { id: m.id } },
    h('div', { class: 'r1' }, h('span', { class: 'name', text: m.title || 'Untitled meeting' }), h('span', { class: 'time', text: fmtTime(m.started_at) })),
    h('div', { class: 'r2' }, lead,
      proc && h('span', { class: 'w-badge is-accent', text: 'Processing' }),
      m.enhanced && !live && !proc && icon('spark', 'w-ic tiny-spark'),
      h('span', { class: 'preview', text: [fmtDuration(m.duration_ms), rowPreview(m)].filter(Boolean).join(' · ') })));
}
function renderRecBanner() {
  const r = state.rec;
  const show = r && !(state.route.view === 'meeting' && state.route.id === r.meetingId);
  els.recBanner.hidden = !show;
  if (show) replace(els.recBanner, h('span', { class: 'w-live-dot' }), h('span', { class: 't', text: r.phase === 'error' ? 'Audio retained · Open to retry save' : r.title || 'Untitled meeting' }), h('span', { class: 'clock', text: fmtClock(recElapsed()) }));
}

function renderHome() {
  if (state.route.view !== 'home' || !els.home) return;
  const now = new Date();
  const hour = now.getHours();
  els.homeDate.textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  els.greeting.textContent = hour < 5 ? 'Still up?' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  // Stats: quiet, factual, from the list we already have.
  const ms = state.meetings;
  if (ms.length) {
    const weekAgo = Date.now() - 7 * 86400000;
    const week = ms.filter((m) => new Date(m.started_at).getTime() > weekAgo);
    const hours = week.reduce((a, m) => a + (m.duration_ms || 0), 0) / 3600000;
    replace(els.homeStats, h('b', { text: pluralize(week.length, 'meeting') }), ' this week',
      hours >= 0.1 ? [' · ', h('b', { text: hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h` }), ' recorded'] : null,
      ' · ', `${ms.length} in your library`);
  } else clear(els.homeStats);
  // Next up
  const events = upcomingEvents();
  const kids = [];
  if (events.length) {
    const ev = events[0]; const ongoing = isOngoing(ev);
    const who = (ev.attendees || []).map(personName).slice(0, 3).join(', ');
    kids.push(h('div', { class: 'hero' },
      h('div', { class: 'h-when' }, h('small', { text: ongoing ? 'Now' : dayLabel(ev.start).slice(0, 3) }), h('b', { text: ev.allDay ? 'All day' : fmtTime(ev.start).replace(/\s?[AP]M$/i, '') })),
      h('div', { class: 'h-body' },
        h('div', { class: 'h-kicker', text: ev.allDay ? (ongoing ? 'Today · All day' : `${dayLabel(ev.start)} · All day`) : ongoing ? 'Happening now' : `Next · ${dayLabel(ev.start)} ${fmtTime(ev.start)}–${fmtTime(ev.end)}` }),
        h('div', { class: 'h-title', text: ev.title || 'Untitled event' }),
        h('div', { class: 'h-sub', text: [who || (ev.attendees?.length ? pluralize(ev.attendees.length, 'person', 'people') : 'Just you'), ev.meet_url ? 'Google Meet' : ''].filter(Boolean).join(' · ') })),
      eventAction(ev, { big: true })));
    for (const e of events.slice(1)) kids.push(h('button', { class: 'later', type: 'button', onclick: () => (e.meeting_id ? navigate(e.meeting_id) : startFromEvent(e)) },
      h('time', { text: `${e.allDay && isOngoing(e) ? 'Today' : dayLabel(e.start).slice(0, 3)} ${e.allDay ? 'All day' : fmtTime(e.start)}` }), h('span', { text: e.title || 'Untitled event' }), icon('mic')));
  } else if (state.calendarLoaded) {
    kids.push(h('div', { class: 'clear-card' }, icon('cal'),
      h('div', {}, h('b', { text: 'No upcoming meetings today' }), h('span', { text: state.calendarError ? 'Calendar is unavailable right now.' : 'A clear runway. Meetings after midnight appear within four hours.' })),
      h('button', { class: 'w-btn w-btn-primary', type: 'button', onclick: newMeeting }, icon('mic'), 'New meeting')));
  }
  replace(els.nextUp, ...kids);
}
const SUGGESTIONS = ['What did I commit to this week?', 'Summarize my last meeting', 'Which open questions keep coming up?'];
function renderSuggestions() {
  replace(els.askSuggest, ...SUGGESTIONS.map((s) => h('button', { class: 'w-chip', type: 'button', text: s, onclick: () => askAll(s) })));
}

// Creating meetings. Capture resources are "warmed" inside the click so Safari/WKWebView and
// Chrome's gesture rules are satisfied even though the meeting is created over the network first.
let pendingAutostart = null; // { id, warm }
async function startFromEvent(ev) {
  let warm;try{warm=prewarmCapture();}catch(e){toast(errMsg(e),{error:true});return;}
  try {
    const m = await API.create({ calendar_event_id: ev.id, title: ev.title, transcribe: 'window' });
    pendingAutostart = { id: m.id, warm };
    navigate(m.id);
  } catch (e) { discardWarm(warm); toast(`Couldn't start the meeting: ${errMsg(e)}`, { error: true }); }
}
let creating = false;
async function newMeeting() {
  if (creating) return;
  if (state.rec) { navigate(state.rec.meetingId); toast(state.rec.phase === 'error' ? 'Retry saving the retained recording first.' : 'Already recording. Stop this one first.'); return; }
  let warm;try{warm=prewarmCapture();}catch(e){toast(errMsg(e),{error:true});return;}
  creating = true; els.btnNew.disabled = true; els.btnNewMobile.disabled = true;
  try {
    const m = await API.create({ transcribe: 'window' });
    pendingAutostart = { id: m.id, warm };
    navigate(m.id);
  } catch (e) { discardWarm(warm); toast(`Couldn't create a meeting: ${errMsg(e)}`, { error: true }); }
  finally { creating = false; els.btnNew.disabled = false; els.btnNewMobile.disabled = false; }
}

// ───────────────────────── 6. Meeting document ─────────────────────────
async function loadMeeting(id) {
  flushNotes();
  stopPolling(); closeDrawer(); closeMenu();
  player.unmount();
  state.current = null; state.currentLoading = true; state.currentError = null;
  state.notes = { rev: 0, dirty: false, saving: false, conflict: null, flash: false };
  state.segPending = 0;
  renderDoc(); els.docScroll.scrollTop = 0;
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
    if (state.current && p.id === id) beginRecording({ warm: p.warm, fresh: true }); else discardWarm(p.warm);
  }
  schedulePoll();
}
function setCurrent(m, { fresh = false } = {}) {
  const prev = state.current;
  state.current = m;
  if (m.status !== 'recording') state.segPending = 0;
  const enhancedAt = m.enhanced?.created_at || null;
  if (fresh) {
    state.notes.rev = m.notes_rev || 0;
    state.notes.editing = false;
    els.notepad.value = m.notes || '';
    state.docMode = m.status === 'recording' ? 'transcript' : 'enhanced';
    state.lastEnhancedAt = enhancedAt;
    state.pendingTemplate = m.enhanced?.template || null;
    const draft = isImported(m) ? null : localStorage.getItem(draftKey(m.id));
    if (draft != null && draft !== (m.notes || '')) state.notes.conflict = { draft, server: m.notes || '', rev: state.notes.rev };
    else if (draft != null) localStorage.removeItem(draftKey(m.id));
  } else {
    if (!state.notes.dirty && !state.notes.saving && !state.notes.conflict && (m.notes_rev || 0) > state.notes.rev) { state.notes.rev = m.notes_rev; els.notepad.value = m.notes || ''; autogrow(); }
    if (enhancedAt && enhancedAt !== state.lastEnhancedAt) state.lastEnhancedAt = enhancedAt;
    if (prev?.jobs?.enhance !== 'running' && m.jobs?.enhance === 'running' && !state.pendingTemplate) state.pendingTemplate = 'general';
    if (prev?.jobs?.enhance === 'running' && m.jobs?.enhance === 'error') toast('Summary failed. Tap Create summary to try again.', { error: true });
  }
  if (m.status !== 'recording' && state.docMode === 'live-summary') state.docMode = 'enhanced';
  // keep the list row in sync
  const i = state.meetings.findIndex((x) => x.id === m.id);
  const prevText = plainPreview(m.enhanced?.markdown || m.notes || '').slice(0, 160);
  const row = { ...m, enhanced: !!m.enhanced, preview: prevText || (i >= 0 ? state.meetings[i].preview : '') };
  delete row.segments; delete row.asks; delete row.notes; delete row.audio; delete row.jobs;
  if (i >= 0) state.meetings[i] = { ...state.meetings[i], ...row }; else state.meetings.unshift(row);
  renderList();
}
const isImported = (m) => !!m && m.source !== 'meetings';
const isLiveHere = (m) => !!m && !!state.rec && state.rec.meetingId === m.id && ['starting','recording'].includes(state.rec.phase);

function renderDoc() {
  const m = state.current;
  els.docPane.dataset.rec = isLiveHere(m) ? '1' : '';
  if (state.currentLoading) {
    els.title.textContent = ''; els.title.classList.add('w-skeleton'); els.title.removeAttribute('contenteditable');
    replace(els.eyebrow, h('span', { class: 'w-skeleton', text: 'Thursday, 8 October · 2:00 PM' }));
    clear(els.meta); clear(els.docActions); clear(els.topStatus); clear(els.docStatus); els.docRoute.hidden = true; clear(els.docToolbar); clear(els.asks); clear(els.conflict); els.conflict.hidden = true;
    els.notepad.hidden = true; els.enhanced.hidden = false; els.transcriptInline.hidden = true; els.summary.hidden = true; els.notesView.hidden = true; els.notesActions.hidden = true;
    replace(els.enhanced, h('div', { class: 'placeholder' }, ...[92, 78, 85, 40].map((w) => h('div', { class: 'w-skeleton line', style: `width:${w}%` }))));
    renderSaved(); renderAskBar(); renderPill();
    return;
  }
  els.title.classList.remove('w-skeleton');
  if (!m) {
    const notFound = state.currentError?.status === 404;
    els.title.textContent = notFound ? 'Meeting not found' : 'Couldn’t open this meeting'; els.title.removeAttribute('contenteditable');
    clear(els.eyebrow); clear(els.meta); clear(els.docActions); clear(els.topStatus); els.docRoute.hidden = true; clear(els.docToolbar); clear(els.asks);
    replace(els.docStatus, h('div', { class: `w-notice ${notFound ? '' : 'is-danger'}` },
      h('span', { class: 'msg', text: notFound ? 'It may have been deleted.' : errMsg(state.currentError || {}) }),
      !notFound && h('button', { class: 'w-btn w-btn-sm w-btn-primary', type: 'button', text: 'Retry', onclick: () => loadMeeting(state.route.id) }),
      h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'All meetings', onclick: () => navigate(null) })));
    els.notepad.hidden = true; els.enhanced.hidden = true; els.transcriptInline.hidden = true; renderSaved(); renderAskBar(); renderPill();
    return;
  }
  renderHeader(m); player.mount(m); renderStatus(m); renderToolbar(m); renderBody(m); renderAsks(m); renderArchimedesSection(); renderAskBar(); renderPill(); renderSaved();
  if (els.archSection.dataset.for !== m.id) { els.archSection.dataset.for = m.id; refreshMeetingAsks(m.id); }
  if (['transcript', 'live-summary'].includes(state.docMode)) renderDrawer();
}

function renderHeader(m) {
  if (document.activeElement !== els.title) els.title.textContent = m.title || '';
  if (isImported(m)) els.title.removeAttribute('contenteditable'); else els.title.setAttribute('contenteditable', supportsPlaintextOnly ? 'plaintext-only' : 'true');
  const sep = () => h('span', { class: 'sep' });
  const eb = [h('span', { text: fmtDateLong(m.started_at) }), sep(), h('span', { text: fmtTime(m.started_at) })];
  if (m.duration_ms) eb.push(sep(), h('span', { text: fmtDuration(m.duration_ms) }));
  if (isImported(m)) eb.push(sep(), h('span', { text: `From ${SOURCE_LABEL[m.source] || m.source}` }));
  replace(els.eyebrow, ...eb);
  const ev = m.calendar_event; const kids = [];
  if (ev?.attendees?.length) {
    kids.push(...ev.attendees.slice(0, 6).map((a) => h('span', { class: 'w-chip', title: a }, h('span', { class: 'w-avatar', text: initials(a) }), personName(a))));
    if (ev.attendees.length > 6) kids.push(h('span', { class: 'w-chip', text: `+${ev.attendees.length - 6}` }));
  }
  if (ev?.meet_url && /^https:\/\//.test(ev.meet_url)) kids.push(h('a', { class: 'join', href: ev.meet_url, target: '_blank', rel: 'noopener noreferrer' }, icon('screen'), 'Join call'));
  replace(els.meta, ...kids);
  // Top bar: live status + actions
  const st = [];
  if (isLiveHere(m)) st.push(h('span', { class: 'w-badge is-live' }, h('span', { class: 'w-live-dot' }), 'Recording'));
  else if (m.status === 'processing') st.push(h('span', { class: 'w-badge is-accent' }, 'Processing'));
  else if (m.jobs?.enhance === 'running') st.push(h('span', { class: 'w-badge is-accent' }, 'Summarizing'));
  else if (isImported(m)) st.push(h('span', { class: 'w-badge', text: 'Read-only' }));
  replace(els.topStatus, ...st);
  const segCount = m.segments?.length || 0;
  replace(els.docActions,
    h('button', { class: 'w-icon-btn', type: 'button', title: 'More', 'aria-label': 'More actions', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); toggleMenu(m); } }, icon('more')));
  void renderRoute(m);
}
function toggleMenu(m) {
  if (closeMenu()) return;
  const fileName = `${(m.title || 'meeting').replace(/[\\/:*?"<>|]+/g, '-')}.md`;
  const menu = h('div', { class: 'w-menu', role: 'menu', onclick: (e) => e.stopPropagation() },
    h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); openManualAsk(m.id); } }, icon('spark'), 'Ask Archimedes…'),
    h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); copyMarkdown(m); } }, icon('copy'), 'Copy as Markdown'),
    h('a', { href: API.exportUrl(m.id), download: fileName, role: 'menuitem', onclick: () => setTimeout(closeMenu) }, icon('download'), 'Export .md'),
    m.source === 'meetings' && h('hr'),
    m.source === 'meetings' && h('button', { type: 'button', role: 'menuitem', class: 'is-danger', onclick: () => { closeMenu(); deleteMeeting(m); } }, icon('trash'), 'Delete meeting'));
  els.docActions.append(menu);
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }));
}
function closeMenu() { const open = els.docActions && $('.w-menu', els.docActions); if (open) open.remove(); return !!open; }
const deletingMeetings = new Set();
function deletionBlocked(m) {
  const r = state.rec?.meetingId === m.id ? state.rec : null;
  const current = WizardApp.capture.current();
  if (current?.meta?.meetingId === m.id && current.id !== r?.engine?.captureId) return true;
  if (r) return r.phase !== 'error' || !!(r.engine?.captureId && (r.engine.meetingId !== m.id || !r.engine.canDiscardStopped()));
  return current?.meta?.meetingId === m.id;
}
async function finishDeletedRecording(r) {
  try {
    await r.engine?.discardDeleted(r.meetingId);
    if (state.rec === r) endRecSession();
    return true;
  } catch (e) {
    if (state.rec === r) {
      r.phase = 'error'; r.error = `Meeting deleted, but local audio cleanup failed: ${errMsg(e)}`;
      renderRecBanner(); renderPill();
    }
    toast(`Meeting deleted, but local audio is still retained: ${errMsg(e)}`, { error: true, action: { label: 'Retry cleanup', fn: () => retryRecording() } });
    return false;
  }
}
function deleteMeeting(m) {
  if (deletingMeetings.has(m.id) || deletionBlocked(m)) { toast('Stop the recording and wait for saving before deleting.', { error: true }); return; }
  confirmToast(`Delete “${m.title || 'Untitled meeting'}” with its notes, transcript and audio, including any retained local recording?`, 'Delete', async () => {
    // Recheck after confirmation: a retry/start may have changed the capture owner.
    if (deletingMeetings.has(m.id) || deletionBlocked(m)) { toast('Stop the recording and wait for saving before deleting.', { error: true }); return; }
    const r = state.rec?.meetingId === m.id ? state.rec : null;
    deletingMeetings.add(m.id);
    if (r) r.phase = 'deleting'; // Exclude concurrent save/retry until DELETE settles.
    try {
      await API.remove(m.id);
      if (r) {
        r.deletionConfirmed = true;
        // Keep cleanup-only intent through a frame reload if local ACK must be retried.
        if (r.engine?.captureId) try { const hint=JSON.parse(sessionStorage.getItem('mizel.sharedCapture')||'null'); if(!hint || (hint.id===r.engine.captureId && hint.meetingId===r.meetingId))sessionStorage.setItem('mizel.sharedCapture', JSON.stringify({ id:r.engine.captureId, meetingId:r.meetingId, deletionConfirmed:true })); } catch {}
      }
      const cleaned = !r || await finishDeletedRecording(r);
      state.meetings = state.meetings.filter((x) => x.id !== m.id); localStorage.removeItem(draftKey(m.id));
      if (cleaned) toast('Meeting deleted');
      if (state.current?.id === m.id) navigate(null); else renderList();
    } catch (e) {
      if (r && state.rec === r) r.phase = 'error';
      toast(`Couldn't delete: ${errMsg(e)}`, { error: true });
    } finally { deletingMeetings.delete(m.id); }
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

let stoppedHere = null; // { id, at }: a recording this device just stopped, while the server catches up
const justStoppedHere = (m) => stoppedHere?.id === m.id && Date.now() - stoppedHere.at < 10 * 60e3;
const canEnhance = (m) => !!(m.notes?.trim() || m.segments?.length) && m.status === 'ready';
function renderStatus(m) {
  const kids = [];
  const r = state.rec?.meetingId === m.id ? state.rec : null;
  if (r?.phase === 'error') {
    kids.push(h('div', { class: 'w-notice is-danger' }, h('span', { class: 'msg', text: r.error || 'Recording failed to start.' }),
      h('button', { class: 'w-btn w-btn-sm w-btn-primary', type: 'button', text: r.engine?.result ? 'Retry save' : 'Try again', onclick: retryRecording }),
      m.status === 'recording' && !r.engine?.result && h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'End meeting', onclick: () => finishWithoutAudio(m) })));
  } else if (m.status === 'recording' && !r && justStoppedHere(m)) {
    kids.push(h('div', { class: 'w-notice is-accent' }, h('span', { class: 'w-spinner' }), h('span', { class: 'msg', text: 'Saving the last of the recording…' })));
  } else if (m.status === 'recording' && !r && pendingAutostart?.id !== m.id) {
    kids.push(h('div', { class: 'w-notice' }, h('span', { class: 'w-live-dot' }),
      h('span', { class: 'msg', text: 'Still marked as recording, perhaps from another device or an interrupted session.' }),
      h('button', { class: 'w-btn w-btn-sm w-btn-primary', type: 'button', text: 'Resume here', onclick: () => beginRecording({ resume: true }) }),
      h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'End', onclick: () => finishWithoutAudio(m) })));
  } else if (m.status === 'processing') {
    const n = m.jobs?.transcribe_pending || 0;
    kids.push(h('div', { class: 'w-notice is-accent' }, h('span', { class: 'w-spinner' }),
      h('span', { class: 'msg', text: n ? `Transcribing the last ${pluralize(n, 'chunk')}… notes will enhance automatically.` : 'Finishing the transcript…' })));
  }
  // Invitation to enhance (Granola's signature moment) when nothing has been enhanced yet.
  replace(els.docStatus, ...kids);
}

function renderToolbar(m) {
  const recording = m.status === 'recording' || isLiveHere(m);
  const tabs = recording ? [['notes', 'Notes'], ['transcript', 'Live transcript'], ['live-summary', 'Live summary']]
    : [['notes', 'My notes'], ['enhanced', 'Summary'], ['transcript', 'Transcript']];
  replace(els.docToolbar, h('div', { class: 'w-seg doc-tabs', role: 'tablist', 'aria-label': 'Recording content' },
    ...tabs.map(([mode, label]) => h('button', { type: 'button', role: 'tab', dataset: { mode }, text: label,
      'aria-selected': String(state.docMode === mode), 'aria-pressed': String(state.docMode === mode), onclick: () => setDocMode(mode) }))));
}
function setDocMode(mode) {
  if (!state.current) return;
  state.tabScroll ||= {};
  state.tabScroll[`${state.current.id}:${state.docMode}`] = els.docScroll.scrollTop;
  state.docMode = mode; renderToolbar(state.current); renderBody(state.current);
  els.docScroll.scrollTop = state.tabScroll[`${state.current.id}:${mode}`] || 0;
  if (['transcript', 'live-summary'].includes(mode)) void summaryStore.load(state.current.id);
}
async function runEnhance(m, template) {
  state.pendingTemplate = template;
  try {
    await API.enhance(m.id, template);
    if (state.current?.id !== m.id) return;
    setCurrent({ ...state.current, jobs: { ...(state.current.jobs || {}), enhance: 'running' } });
    state.docMode = 'enhanced'; renderDoc(); schedulePoll();
  } catch (e) { toast(`Couldn't create summary: ${errMsg(e)}`, { error: true }); }
}

function renderBody(m) {
  const mode = state.docMode;
  els.notesActions.hidden = mode !== 'notes';
  const editable = !isImported(m) && (m.status === 'recording' || state.notes.editing);
  els.notepad.hidden = mode !== 'notes' || !editable;
  els.notesView.hidden = mode !== 'notes' || editable;
  if (mode === 'notes') renderReviewNotes(m);
  els.enhanced.hidden = mode !== 'enhanced';
  els.transcriptInline.hidden = mode !== 'transcript';
  els.summary.hidden = mode !== 'live-summary';
  if (mode === 'enhanced') {
    if (m.enhanced || m.jobs?.enhance === 'running' || m.jobs?.enhance === 'error') renderEnhanced(m);
    else replace(els.enhanced, h('div', { class: 'w-empty summary-empty' }, 'No summary yet.',
      canEnhance(m) && h('button', { class: 'w-btn w-btn-primary', type: 'button', text: 'Create summary', onclick: () => runEnhance(m, 'general') })));
  }
  if (mode === 'transcript') { renderSegments(els.segments); renderOriginalSummary(); }
  if (mode === 'live-summary') renderSummary();
  autogrow(); renderConflict(); renderConnectionStatus();
}
function renderReviewNotes(m) {
  const text = isImported(m) ? m.notes || '' : els.notepad.value;
  replace(els.notesView, text.trim() ? h('div', { class: 'w-prose md', html: md(text) }) : h('div', { class: 'w-empty', text: 'No notes for this recording.' }));
  if (state.notes.conflict && !state.notes.editing) els.notesView.append(h('div', { class: 'w-notice is-warn', text: 'An unsaved draft is kept on this device. Edit notes to review it.' }));
  const review = m.status !== 'recording' && !isImported(m);
  els.notesActions.hidden = state.docMode !== 'notes' || !review;
  if (review) replace(els.notesActions, h('button', { class: 'w-btn w-btn-sm', type: 'button', text: state.notes.editing ? (state.notes.saving ? 'Saving…' : 'Done') : 'Edit notes', disabled: state.notes.saving,
    onclick: async () => { if (!state.notes.editing) { state.notes.editing = true; renderBody(m); els.notepad.focus(); return; } await saveNotes(); if (state.notes.dirty || state.notes.saving || state.notes.conflict) return; state.notes.editing = false; renderBody(state.current); } }));
}
function renderEnhanced(m) {
  const box = els.enhanced;
  if (m.jobs?.enhance === 'running') {
    const label = TEMPLATES.find(([k]) => k === state.pendingTemplate)?.[1];
    replace(box, h('div', { class: 'enhancing' }, h('span', { class: 'orb' }), `Summarizing — reading ${m.segments?.length ? pluralize(m.segments.length, 'transcript segment') : 'your notes'}…`),
      h('div', { class: 'placeholder' }, ...[38, 92, 84, 70, 0, 30, 88, 76, 64].map((w) => (w ? h('div', { class: 'w-skeleton line', style: `width:${w}%` }) : h('div', { style: 'height:14px' })))));
    return;
  }
  if (!m.enhanced) {
    replace(box, h('div', { class: 'w-notice is-danger' }, h('span', { class: 'msg', text: 'Summary didn’t finish.' }),
      h('button', { class: 'w-btn w-btn-sm w-btn-primary', type: 'button', text: 'Try again', onclick: () => runEnhance(m, state.pendingTemplate || 'general') })));
    return;
  }
  const src = m.enhanced.markdown || '';
  const hasYours = /(^|\n)\u2063/.test(src);
  const nCites = (m.enhanced.evidence || []).length;
  const tpl = TEMPLATES.find(([k]) => k === m.enhanced.template)?.[1] || 'General';
  replace(box,
    hasYours && h('div', { class: 'legend' }, h('span', { class: 'k-yours' }, h('i'), 'Your notes'), h('span', { class: 'k-ai' }, h('i'), 'Added by Mizel')),
    h('div', { class: 'w-prose md marks', html: md(src, { marks: true, evidence: true, shift: 1 }) }),
    h('div', { class: 'enh-foot' }, icon('spark'), 'Summary', m.enhanced.created_at && `· ${relTime(m.enhanced.created_at)}`, nCites ? `· ${pluralize(nCites, 'source')} — hover a number to preview, click to jump` : null), discussionSection(m.id));
}

// Notes autosave: debounce 800 ms, PUT with base_rev, 409 → keep both copies visible.
function autogrow() { const t = els.notepad; if (t.hidden) return; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }
function renderSaved() {
  syncNotesUpdateHold();
  const el = els.saved; if (!el) return;
  if (state.current && state.docMode === 'notes') renderReviewNotes(state.current);
  const m = state.current; const n = state.notes;
  if (!m || isImported(m) || state.route.view !== 'meeting') { el.textContent = ''; el.classList.add('off'); return; }
  el.textContent = n.saving ? 'Saving…' : n.dirty ? 'Editing' : 'Saved';
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
  replace(els.conflict, h('div', { class: 'w-notice is-warn', style: 'flex-direction:column;align-items:stretch' },
    h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      h('span', { class: 'msg', text: 'Your unsaved draft differs from the saved notes. The notepad shows the saved copy; your draft is kept below until you choose.' }),
      h('button', { class: 'w-btn w-btn-sm w-btn-primary', type: 'button', text: 'Use my draft', onclick: () => { els.notepad.value = c.draft; state.notes.conflict = null; state.notes.dirty = true; renderConflict(); autogrow(); saveNotes(); } }),
      h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'Keep saved copy', onclick: () => { state.notes.conflict = null; localStorage.removeItem(draftKey(state.current.id)); renderConflict(); } })),
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

// ───────────────────────── 6b. Playback ─────────────────────────
// The recording's own audio (media time: pauses removed), so every timestamp is a place you can listen to.
const player = {
  id: null, ok: false, audio: null, el: null, dragging: false,
  hasAudio(m) { return !!m && m.source === 'meetings' && (m.audio?.tracks || []).some((t) => t.chunks > 0) && m.status !== 'recording'; },
  mount(m) {
    const want = this.hasAudio(m) ? m.id : null;
    if (want === this.id && this.el?.isConnected) { this.render(); return; }
    this.unmount();
    if (!want) return;
    this.id = want; this.ok = true;
    const a = new Audio(); a.preload = 'metadata'; a.src = API.audioUrl(want);
    a.addEventListener('timeupdate', () => this.render());
    a.addEventListener('loadedmetadata', () => this.render());
    a.addEventListener('play', () => this.render()); a.addEventListener('pause', () => this.render()); a.addEventListener('ended', () => this.render());
    a.addEventListener('error', () => { this.ok = false; if (this.el) this.el.hidden = true; });
    this.audio = a;
    this.el = h('div', { class: 'player', role: 'group', 'aria-label': 'Recording playback' },
      h('button', { class: 'pl-btn', type: 'button', 'aria-label': 'Play', onclick: () => this.toggle() }),
      h('div', { class: 'pl-track' }, h('input', { class: 'pl-seek', type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Seek',
        oninput: (e) => { this.dragging = true; const d = this.dur(); if (d) this.label(Number(e.target.value) / 1000 * d); },
        onchange: (e) => { this.dragging = false; const d = this.dur(); if (d) this.seek(Number(e.target.value) / 1000 * d * 1000, false); } }),
        h('div', { class: 'pl-times' }, h('span', { class: 'pl-cur', text: '0:00' }), h('span', { class: 'pl-dur', text: m.duration_ms ? fmtClock(m.duration_ms) : '' }))));
    els.meta.after(this.el);
    this.render();
  },
  unmount() { if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } this.el?.remove(); this.el = null; this.audio = null; this.id = null; this.ok = false; },
  dur() { const d = this.audio?.duration; return Number.isFinite(d) && d > 0 ? d : (state.current?.duration_ms || 0) / 1000; },
  toggle() { const a = this.audio; if (!a) return; if (a.paused) a.play().catch((e) => toast(`Couldn't play: ${e.message || e}`, { error: true })); else a.pause(); },
  seek(ms, play) {
    const a = this.audio; if (!a) return;
    a.currentTime = Math.max(0, ms / 1000);
    if (play) a.play().catch(() => {});
    this.el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this.render();
  },
  label(sec) { const c = this.el && $('.pl-cur', this.el); if (c) c.textContent = fmtClock(sec * 1000); },
  render() {
    const a = this.audio; const el = this.el; if (!a || !el) return;
    const playing = !a.paused && !a.ended;
    const b = $('.pl-btn', el); b.classList.toggle('is-playing', playing); b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const d = this.dur();
    if (!this.dragging) { $('.pl-seek', el).value = String(d ? Math.round((a.currentTime / d) * 1000) : 0); this.label(a.currentTime); }
    if (d) $('.pl-dur', el).textContent = fmtClock(d * 1000);
  },
};

// ───────────────────────── 7. Transcript ─────────────────────────
const linkedDiscussions = new Map();
let discussionLoading=false;
async function loadDiscussions() {
  const id=state.current?.id;if(!id||discussionLoading)return;discussionLoading=true;
  try{const r=await fetch(`orb-events?meetingId=${enc(id)}`,{cache:'no-store'});if(!r.ok)return;const j=await r.json();
    const old=JSON.stringify(linkedDiscussions.get(id)||[]);linkedDiscussions.set(id,j.events||[]);
    if(state.current?.id===id && old!==JSON.stringify(j.events||[])){
      if(state.docMode==='transcript')renderSegments(els.segments);
      if(state.docMode==='live-summary')renderSummary();
      if(state.docMode==='enhanced'&&state.current.enhanced)renderEnhanced(state.current);
    }
  }catch{}finally{discussionLoading=false;}
}
setInterval(loadDiscussions,3000);
const openOrbAnswers = new Set(); // keep an opened answer open across live re-renders
function discussionCard(e) {
  const label=['sent','answered'].includes(e.status)?'Asked Archimedes':e.status==='cancelled'?'Cancelled':e.status==='local'?'On-device':'Orb · '+e.status;
  return h('section',{class:'ask-note',dataset:{orbEvent:e.id,atMediaMs:String(e.atMediaMs)},title:'Assistant material · not meeting speech or an agreed decision'},
    h('div',{class:'ask-note-head'},
      h('button',{class:'sum-at',type:'button',text:fmtClock(e.atMediaMs),onclick:()=>jumpTo(e.atMediaMs)}),
      h('span',{class:'ask-note-label',text:label}),
      e.threadId&&h('a',{class:'ask-note-open',href:threadHref(e.threadId),target:'_top',text:'Open chat'})),
    h('p',{class:'ask-note-q',text:e.question||(['cancelled','local'].includes(e.status)?'Nothing sent to Archimedes.':'Voice note')}),
    e.answer&&h('details',{class:'ask-note-a',open:openOrbAnswers.has(e.id),ontoggle:ev=>ev.target.open?openOrbAnswers.add(e.id):openOrbAnswers.delete(e.id)},h('summary',{text:'Answer'}),h('p',{text:e.answer})),
    e.error&&h('p',{class:'ask-note-err',text:e.error}));
}
function discussionSection(id) {
  const rows=(linkedDiscussions.get(id)||[]).filter(e=>!['cancelled','paused','local'].includes(e.status));
  return rows.length?h('section',{class:'sum-topic linked-discussions'},h('h3',{text:'Archimedes discussions'}),...rows.map(discussionCard)):null;
}
// Kept as compatibility hooks for citations and the keyboard shortcut; content is inline.
function toggleDrawer() { setDocMode('transcript'); }
function openDrawer(tab) { setDocMode(tab === 'summary' ? 'live-summary' : 'transcript'); }
function setDrawerTab(tab) { openDrawer(tab); }
function renderDrawer() { if (state.docMode === 'transcript') renderSegments(els.segments); else if (state.docMode === 'live-summary') renderSummary(); }
const summaryStore = {
  byMeeting: new Map(), loading: new Set(),
  get(id) { return this.byMeeting.get(id) || null; },
  building: new Set(),
  retry(id) { this.building.add(id); setTimeout(() => { this.building.delete(id); if (state.current?.id === id) void this.load(id); }, 4000); },
  set(id, sm) { if (sm) this.byMeeting.set(id, sm); if (state.current?.id === id) { if (state.docMode === 'live-summary') renderSummary(); if (state.docMode === 'transcript') renderOriginalSummary(); } },
  async load(id) {
    if (this.loading.has(id)) return; this.loading.add(id);
    try {
      const m = state.current?.id === id ? state.current : null;
      const build = ''; // Viewing the archived live summary never regenerates it.
      const r = await fetch(new URL(`summary?meetingId=${encodeURIComponent(id)}${build}`, location.href));
      if (r.ok) { const j = await r.json(); this.set(id, j.summary || { topics: [] }); if (j.building) this.retry(id); }
    }
    catch { /* offline: keep what we have */ }
    finally { this.loading.delete(id); if (state.current?.id === id) { if (state.docMode === 'live-summary') renderSummary(); if (state.docMode === 'transcript') renderOriginalSummary(); } }
  },
};
// Expansion belongs to the viewer, never the generated summary. Only explicit
// choices persist: the newest untouched topic opens; older untouched topics close.
const summaryExpansion = new Map();
function summaryExpansionFor(id, snapshot) {
  const key = `mizel.summaryExpansion.v1:${snapshot ? 'archive' : 'live'}:${id}`;
  if (!summaryExpansion.has(key)) {
    let choices = {};
    try { choices = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch {}
    const entries = choices && typeof choices === 'object' && !Array.isArray(choices)
      ? Object.entries(choices).filter(([, value]) => typeof value === 'boolean') : [];
    summaryExpansion.set(key, new Map(entries));
  }
  const choices = summaryExpansion.get(key);
  return { choices, save() { try { sessionStorage.setItem(key, JSON.stringify(Object.fromEntries(choices))); } catch {} } };
}
function renderSummary({ scrollEnd = false, container = els.summary, snapshot = null } = {}) {
  const box = container; if (!box) return;
  const m = state.current; if (!m) return clear(box);
  const sm = snapshot || summaryStore.get(m.id);
  const recording = !snapshot && m.status === 'recording' && isLiveHere(m);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const scrollTop = box.scrollTop;
  const focusedKey = box.contains(document.activeElement) ? document.activeElement.dataset.summaryFocus : null;
  const topics = (sm?.topics || []).filter((t) => t.bullets?.length);
  const expansion = summaryExpansionFor(m.id, !!snapshot);
  const rows = [];
  const collapseAll = h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'Collapse all', dataset: { summaryFocus: 'collapse-all' }, onclick: () => {
    for (const row of rows) { expansion.choices.set(row.key, false); row.setOpen(false); }
    expansion.save();
  } });
  const kids = topics.map((t, i) => {
    const key = String(t.id || `topic:${t.startMs || 0}:${i}`);
    const open = expansion.choices.has(key) ? expansion.choices.get(key) : i === topics.length - 1;
    const bodyId = `${snapshot ? 'archived' : 'live'}-summary-topic-${i}`;
    const body = h('ul', { id: bodyId, hidden: !open }, ...t.bullets.map((b) => h('li', {},
      h('span', { text: b.text }),
      h('button', { class: 'sum-at', type: 'button', title: player.ok ? 'Play from here' : 'Show in transcript', 'aria-label': `${player.ok ? 'Play from' : 'Show'} ${fmtClock(b.atMs || 0)}`, text: `${fmtClock(b.atMs || 0)} ↗`, onclick: () => jumpTo(b.atMs || 0) }))));
    const toggle = h('button', { class: 'sum-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId, dataset: { summaryFocus: key }, onclick: () => {
      const next = toggle.getAttribute('aria-expanded') !== 'true';
      expansion.choices.set(key, next); expansion.save(); setOpen(next);
    } }, h('span', { class: 'sum-chevron', 'aria-hidden': 'true', text: '›' }),
    h('span', { class: 'sum-title', text: t.title }), h('time', { text: fmtClock(t.startMs || 0) }));
    function setOpen(value) { toggle.setAttribute('aria-expanded', String(value)); body.hidden = !value; }
    rows.push({ key, setOpen });
    return h('section', { class: `sum-topic${t.active && recording ? ' is-active' : ''}`, dataset: { topicId: key } }, h('h3', {}, toggle), body);
  });
  if (topics.length) kids.unshift(h('div', { class: 'sum-controls' }, collapseAll));
  if (!kids.length) {
    kids.push(h('div', { class: 'w-empty sum-empty' }, !sm && summaryStore.loading.has(m.id) ? 'Loading…'
      : summaryStore.building.has(m.id) ? 'Building the outline from the transcript…'
      : recording ? 'Topics and key points appear here as you talk — first ones after about half a minute.'
      : 'No live summary for this meeting.'));
  } else if (recording) kids.push(h('div', { class: 'sum-live' }, h('span', { class: 'w-live-dot' }), 'Updates as each stretch of transcript locks in'));
  if(!snapshot)kids.push(discussionSection(m.id));
  replace(box, ...kids);
  if (focusedKey != null) [...box.querySelectorAll('[data-summary-focus]')].find(el => el.dataset.summaryFocus === focusedKey)?.focus({ preventScroll: true });
  box.scrollTop = scrollEnd || atBottom ? box.scrollHeight : scrollTop;
}
function renderOriginalSummary() {
  const m = state.current, sm = m && summaryStore.get(m.id);
  const snapshot = sm?.originalLiveSummary;
  const show = m && m.status !== 'recording' && !!snapshot?.topics?.some(t => t.bullets?.length);
  els.originalSummary.hidden = !show;
  if (show) renderSummary({ container: els.originalSummaryBody, snapshot });
}
function renderConnectionStatus() {
  const el = els.liveConnection; if (!el) return;
  const show = live.on && state.current?.id === live.meetingId && ['transcript', 'live-summary'].includes(state.docMode)
    && ['connecting', 'reconnecting', 'down', 'unavailable'].includes(live.status);
  el.hidden = !show;
  if (show) replace(el, h('span', { text: live.status === 'unavailable' ? 'Live transcript unavailable. Recording continues.' : live.status === 'down' && live.reason ? live.reason : 'Reconnecting live transcript… Recording continues.' }),
    live.status === 'unavailable' && h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'Retry', onclick: () => live.retryNow() }));
  else clear(el);
}
function jumpTo(ms) { if (player.ok && player.id === state.current?.id) { player.seek(ms, true); return; } jumpToTranscript(ms); }
function jumpToTranscript(ms) {
  setDocMode('transcript');
  const segs = state.current?.segments || []; if (!segs.length) return;
  const seg = segs.reduce((best, x) => (Math.abs((x.start_ms || 0) - ms) < Math.abs((best.start_ms || 0) - ms) ? x : best));
  const el = els.segments.querySelector(`[data-seg-id="${CSS.escape(seg.id)}"]`);
  if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
}
function closeDrawer() { state.drawerOpen = false; els.docPane.dataset.drawer = ''; }
// Group 5-second segments into readable speaker paragraphs.
function groupSegments(segs) {
  const out = [];
  for (const s of segs) {
    const src = s.source || 'mixed';
    const g = out[out.length - 1];
    if (g && g.source === src && g.items.length < 3 && (s.end_ms || s.start_ms || 0) - g.start <= 30000 && (s.start_ms || 0) - (g.end || 0) < 5000) { g.items.push(s); g.end = s.end_ms || s.start_ms; }
    else out.push({ source: src, start: s.start_ms || 0, end: s.end_ms || s.start_ms, items: [s] });
  }
  return out;
}
const SPEAKER = { me: 'Me', them: 'Them', mixed: 'Room' };
function transcriptTimeline(segs,events){
  const timeline=[],ordered=[...events].sort((a,b)=>a.atMediaMs-b.atMediaMs||a.id.localeCompare(b.id));let pending=[],at=0;
  const flush=()=>{timeline.push(...groupSegments(pending));pending=[];};
  for(const segment of segs){while(at<ordered.length&&ordered[at].atMediaMs<=(segment.start_ms||0)){flush();timeline.push({start:ordered[at].atMediaMs,event:ordered[at++]});}pending.push(segment);}
  flush();while(at<ordered.length)timeline.push({start:ordered[at].atMediaMs,event:ordered[at++]});return timeline;
}
function renderSegments(container, { scrollEnd = false } = {}) {
  if (!container) return;
  const m = state.current; const segs = m?.segments || [];
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  const events=linkedDiscussions.get(m?.id)||[];
  const timeline=transcriptTimeline(segs,events);
  const kids = timeline.map((g) => g.event?discussionCard(g.event):h('div', { class: `tx ${g.source}` },
    h('div', { class: 'who' }, player.ok && player.id === m?.id
      ? h('button', { class: 'tx-at', type: 'button', title: 'Play from here', text: fmtClock(g.start), onclick: () => player.seek(g.start, true) })
      : h('time', { text: fmtClock(g.start) })),
    h('div', { class: 'txt' }, ...g.items.flatMap((s, i) => [i ? ' ' : null, h('span', { class: 'seg', dataset: { segId: s.id }, text: s.text })]))));
  const active = m && (m.status === 'recording' || m.status === 'processing');
  if (active && isLiveHere(m)) kids.push(h('div', { class: 'live-preview' }, ...livePreviewRows()));
  else if (!segs.length) kids.push(h('div', { class: 'w-empty' }, active ? 'Transcribing…' : 'No transcript for this recording.'));
  replace(container, ...kids);
  if (container === els.segments) {
    els.drawerCount.textContent = segs.length ? fmtClock(segs[segs.length - 1].end_ms || 0) : '';
    const pending = active ? (m?.jobs?.transcribe_pending ?? (m?.status === 'recording' ? state.segPending : 0)) : 0;
    replace(els.drawerPending, isLiveHere(m) ? [h('span', { class: 'w-live-dot' }), 'Live'] : pending ? [h('span', { class: 'w-spinner', style: 'width:11px;height:11px' }), 'Finishing…'] : '');
    if (scrollEnd || atBottom) container.scrollTop = container.scrollHeight;
  }
}
function findEvidence(ref) {
  const m = state.current; if (!m) return {};
  const ev = (m.enhanced?.evidence || []).find((x) => x.ref === ref);
  let seg = ev?.segment_id ? m.segments?.find((s) => s.id === ev.segment_id) : null;
  if (!seg && ev && m.segments?.length) seg = m.segments.reduce((best, s) => (Math.abs((s.start_ms || 0) - ev.start_ms) < Math.abs((best.start_ms || 0) - ev.start_ms) ? s : best));
  return { ev, seg };
}
function showEvidence(ref) {
  hideTip();
  const m = state.current; if (!m) return;
  const { ev, seg } = findEvidence(ref);
  if (!seg) { toast(ev?.quote ? `“${ev.quote}”` : 'No transcript segment for this source.'); return; }
  let container;
  openDrawer(); container = els.segments;
  const span = container?.querySelector(`[data-seg-id="${CSS.escape(seg.id)}"]`);
  if (!span) return;
  container.querySelectorAll('.seg.hit').forEach((r) => r.classList.remove('hit'));
  span.classList.add('hit');
  span.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => span.classList.remove('hit'), 3200);
}
// Hover preview for citations (pointer devices only).
function showTip(btn) {
  const { ev, seg } = findEvidence(btn.dataset.ref);
  const quote = ev?.quote || seg?.text; if (!quote) return;
  const who = SPEAKER[seg?.source] || '';
  replace(els.tip, h('span', { class: 'tq', text: quote.length > 220 ? `${quote.slice(0, 220)}…` : quote }),
    h('span', { class: 'tm' }, [who, fmtClock(ev?.start_ms ?? seg?.start_ms ?? 0)].filter(Boolean).join(' · '), ' · click to jump'));
  els.tip.hidden = false;
  const r = btn.getBoundingClientRect(); const t = els.tip.getBoundingClientRect();
  const left = Math.max(10, Math.min(window.innerWidth - t.width - 10, r.left + r.width / 2 - t.width / 2));
  const top = r.top - t.height - 8 > 8 ? r.top - t.height - 8 : r.bottom + 8;
  els.tip.style.left = `${left}px`; els.tip.style.top = `${top}px`;
}
function hideTip() { if (els.tip) els.tip.hidden = true; }

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
    if (['transcript', 'live-summary'].includes(state.docMode)) renderDrawer();
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
// Platform capture is exclusively WizardApp; this app owns domain uploads and finalization.
const captureCaps = () => { try { return WizardApp.capture.capabilities({ kind: 'meeting' }); } catch { return {}; } };
const supportsSystemAudio = () => !!captureCaps().systemAudio;
function prewarmCapture() { return WizardApp.capture.prepare({ kind: 'meeting', pcm: true, systemAudio: false }); }
function discardWarm(w) { w?.release?.(); }

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
        const receipt = await API.chunk(this.meetingId, it.source, it.seq, it.startMs, it.blob);
        if (receipt?.stored !== true) throw new Error('The meeting backend did not confirm durable chunk storage.');
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

class SharedMeeting {
  constructor(meetingId, cbs, { warm = null, seqBase = {}, offsetMs = 0, captureId = null } = {}) {
    Object.assign(this, { meetingId, cbs, warm, seqBase, offsetMs, captureId });
    this.offs=[];this.finalSeq={};this.sent=new Set();this.info={};this.st=null;this.result=null;
    this.uploader=new Uploader(meetingId,()=>cbs.onQueue());
  }
  get native() { return !!this.info.native; }
  get wos() { return !!this.info.backendStopOwned; }
  get livePcm() { return this.info.livePcm !== false; }
  get elapsedMs() { return this.session ? this.session.getInfo().durationMs || 0 : this.result?.durationMs || 0; }
  get hasSystemAudio() { return this.session ? this.session.getInfo().hasSystemAudio : false; }
  get systemAudioAvailable() { return !!this.info.capabilities?.systemAudio; }
  acceptChunk(item) {
    this.finalSeq[item.source]=Math.max(this.finalSeq[item.source] ?? -1,item.seq);
    const key=item.source+':'+item.seq;if(this.sent.has(key))return;this.sent.add(key);this.uploader.enqueue(item);
  }
  async start({ systemAudio }) {
    this.session=await WizardApp.capture.start({ kind:'meeting',pcm:true,mime:'audio/wav',chunkMs:5000,
      systemAudio:!!systemAudio && !!captureCaps().systemAudioStart, preparedId:this.warm?.id,
      resumeId:this.captureId || undefined,seqBase:this.seqBase,offsetMs:this.offsetMs,meta:{meetingId:this.meetingId} });
    this.captureId=this.session.id;this.info=this.session.getInfo();this.st=this.info.state;
    sessionStorage.setItem('mizel.sharedCapture',JSON.stringify({id:this.captureId,meetingId:this.meetingId}));
    this.offs.push(this.session.onLevel(lvl=>this.cbs.onLevel(lvl)),
      this.session.onPcm(f=>this.cbs.onLive?.(f.pcm,f.startMs)),
      this.session.onChunk(c=>this.acceptChunk(c)),
      this.session.onWarn(msg=>this.cbs.onWarn(msg)),
      this.session.onState(st=>{ this.st=st;this.info=this.session.getInfo();this.cbs.onNative?.(st,this); }));
    for(const item of await this.session.chunks())this.acceptChunk(item);
  }
  async pause() { await this.session.pause(); }
  async resume() { await this.session.resume(); }
  async addSystemAudio() { await this.session.setSystemAudio(true);this.info=this.session.getInfo();this.cbs.onState(); }
  async removeSystemAudio() { await this.session.setSystemAudio(false);this.info=this.session.getInfo();this.cbs.onState(); }
  async stop() { if(!this.result)this.result=await this.session.stop();for(const item of this.result.streamChunks||[])this.acceptChunk(item);return this.result; }
  async abort() { discardWarm(this.warm); if(this.session && !this.result)await this.session.cancel();this.detach(); }
  detach() { for(const off of this.offs.splice(0))off(); }
  canDiscardStopped() {
    if (!this.captureId || (this.result && (this.result.id !== this.captureId || (this.result.meta?.meetingId && this.result.meta.meetingId !== this.meetingId)))) return false;
    const info = this.session?.getInfo();
    if (info) return info.inputStopped === true;
    return !!this.result && this.result.id === this.captureId && WizardApp.capture.current()?.id !== this.captureId;
  }
  async discardDeleted(meetingId) {
    // Only the explicit, successful domain DELETE permits this custody release.
    // cancel() rejects once Stop begins; ack() removes only this app's pending Result.
    // Ordinary saves still use acknowledge() and its PCM/marker readback gates below.
    if (meetingId !== this.meetingId || !this.canDiscardStopped()) throw new Error('Stop the original capture before deleting its local audio.');
    this.uploader.abandon(); this.detach();
    if (!this.result) this.result = await this.session.stop(); // Finish storage after input already stopped, without uploading.
    if (this.result.id !== this.captureId || (this.result.meta?.meetingId && this.result.meta.meetingId !== meetingId)) throw new Error('Retained capture identity changed.');
    await WizardApp.capture.ack(this.captureId);
    try { const hint=JSON.parse(sessionStorage.getItem('mizel.sharedCapture')||'null'); if(hint?.id===this.captureId && hint.meetingId===meetingId)sessionStorage.removeItem('mizel.sharedCapture'); } catch {}
  }
  async acknowledge() {
    // Native uploads and Stop may still be finishing after microphone Stop resolves. Read the own
    // domain record until durable completion; never expire recording/save holds or restart a take.
    for(;;){try{await verifyCaptureReadback(this.meetingId,this.result,this.finalSeq);break;}catch(e){
      if(e.code!=='native_upload_pending')throw e;this.cbs.onQueue();await new Promise(resolve=>setTimeout(resolve,1500));
    }}
    const markers=this.result?.meta?.handoffs||[];
    // The audio is already verified on the server above. Orb-event links are metadata: give the shell's
    // journal a few seconds to sync, then save anyway. A failed or abandoned orb press (e.g. the phone's
    // storage timed out mid-handoff) must never hold the whole meeting hostage (James, 6 Nov 2026).
    if(markers.length){for(let i=0;i<4;i++){let saved=null;try{saved=await api(`orb-events?meetingId=${enc(this.meetingId)}`);}catch{}
      const missing=markers.filter(m=>!saved?.events?.some(e=>e.id===m.id&&e.captureId===this.captureId));
      if(!missing.length)break;
      if(i===3){console.warn('mizel: saving without '+missing.length+' unsynced orb event(s)');break;}
      await new Promise(resolve=>setTimeout(resolve,1500));}
    }
    await WizardApp.capture.ack(this.captureId);this.detach();
    try {const hint=JSON.parse(sessionStorage.getItem('mizel.sharedCapture')||'null');if(hint?.id===this.captureId)sessionStorage.removeItem('mizel.sharedCapture');}catch{} }
}
// Decode backend WAV only to compare its durable samples; capture/encoding stays in shared core.
function pcmData(buffer) {
  const v=new DataView(buffer);if(v.byteLength<44||v.getUint32(0)!==0x52494646||v.getUint32(8)!==0x57415645)throw new Error('Backend audio is not a WAV.');
  let format=false;
  for(let at=12;at+8<=v.byteLength;) {
    const n=v.getUint32(at+4,true),id=v.getUint32(at);if(at+8+n>v.byteLength)throw new Error('Backend WAV is truncated.');
    if(id===0x666d7420)format=v.getUint16(at+8,true)===1&&v.getUint16(at+10,true)===1&&v.getUint32(at+12,true)===16000&&v.getUint16(at+22,true)===16;
    if(id===0x64617461){if(!format||n%2)throw new Error('Backend PCM format changed.');return new Int16Array(buffer.slice(at+8,at+8+n));}at+=8+n+(n%2);
  }throw new Error('Backend WAV has no PCM data.');
}
async function verifyCaptureReadback(meetingId, take, finalSeq) {
  if(!take)throw new Error('No durable shared capture Result.');
  const saved=await API.meeting(meetingId);
  if(saved.id!==meetingId)throw new Error('Backend returned a different meeting; audio retained.');
  // Project canonical completion independently of local capture cleanup. This is NOT an ack.
  if(state.current?.id===meetingId && saved.status!=='recording') { setCurrent(saved); renderDoc(); schedulePoll(); }
  if(saved.status==='recording')throw Object.assign(new Error('Backend stop has not been durably read back; audio retained.'),{code:take.meta?.native?.backendOwned?'native_upload_pending':'backend_stop_unconfirmed'});
  for(const [source,last] of Object.entries(finalSeq))if(Number((saved.audio?.tracks||[]).find(t=>t.source===source)?.chunks||0) < last+1)throw new Error('Backend is missing promised audio; shared capture retained.');
  if(take.meta?.native?.backendOwned) {
    if((saved.duration_ms||0)+1<(take.durationMs||0))throw Object.assign(new Error('Native audio is still uploading; shared capture retained.'),{code:'native_upload_pending'});return;
  }
  const items=take.streamChunks||[];if(!items.length && take.blob?.size>44)throw new Error('Shared PCM delivery metadata missing; audio retained.');
  if(!items.length)return;
  const first=Math.round(Math.min(...items.map(c=>c.startMs))*16),end=Math.round(Math.max(...items.map(c=>c.startMs+c.durationMs))*16);
  const expected=new Int32Array(end-first);
  for(const c of items) {const samples=pcmData(await c.blob.arrayBuffer()),at=Math.round(c.startMs*16)-first;for(let i=0;i<samples.length;i++)expected[at+i]+=samples[i];}
  const response=await transport(API.audioUrl(meetingId)+`?capture_readback=${enc(take.id)}`,{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw new ApiError(response.status,{error:`Backend audio readback failed (${response.status}); shared capture retained.`});
  const actual=pcmData(await response.arrayBuffer());if(actual.length<end)throw new Error('Backend PCM is incomplete; audio retained.');
  for(let i=0;i<expected.length;i++)if(actual[first+i]!==Math.max(-32768,Math.min(32767,expected[i])))throw new Error('Backend PCM differs from shared capture; audio retained.');
}

// ───────────────────────── 9. Recording controller + floating recorder ─────────────────────────
function recElapsed() { return state.rec?.engine?.elapsedMs || 0; }
// Mizel transcripts carry no speaker labels, so the Wizard bridge reads a spoken opener ("Call with Jan and
// Miguel") as the participant list. A brand-new recording gets one quiet, self-dismissing nudge to say it.
const PARTICIPANTS_HINT = 'In a meeting? Start by saying who\u2019s here, like \u201cCall with Jan and Miguel.\u201d';
const PARTICIPANTS_HINT_MS = 5000;
function showParticipantsHint() {
  document.querySelector('.who-hint')?.remove();
  const el = h('div', { class: 'w-toast is-hint who-hint', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'msg', text: PARTICIPANTS_HINT }));
  els.pill.parentElement.append(el);
  setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 400); }, PARTICIPANTS_HINT_MS);
}
// A rejected Start is not evidence of an empty recorder: it may have obtained a session before
// observer/storage setup failed. Only the app can prove its own memory is empty, and shared custody
// must independently report no current/pending take. Never cancel, acknowledge or discard on error.
async function clearEmptyFailedStart(r) {
  const retained = () => failedStartOwnsMemory(r);
  if (!r || state.rec !== r || r.phase !== 'error' || retained()) return false;
  try {
    if (WizardApp.capture.current() || (await WizardApp.capture.pending()).length) return false;
    // The read yielded: a new Start, recovered session or buffered chunk wins over this old cleanup.
    if (state.rec !== r || r.phase !== 'error' || retained() || WizardApp.capture.current()) return false;
  } catch { return false; } // Unknown custody stays held and retryable.
  r.engine?.detach?.(); r.engine = null; r.emptyStartProven = true;
  recordingUpdateHold?.release(); recordingUpdateHold = null; stopPillClock();
  return true;
}
function failedStartOwnsMemory(r) {
  const e = r?.engine;
  return !!(e?.captureId || e?.session || e?.result || e?.uploader?.pending || e?.uploader?.running || e?.sent?.size || Object.keys(e?.finalSeq || {}).length);
}
async function beginRecording({ warm = null, resume = false, fresh = false } = {}) {
  const m = state.current; if (!m || deletingMeetings.has(m.id)) return;
  if (state.rec && state.rec.phase !== 'error') return;
  if (state.rec?.engine?.captureId) { navigate(state.rec.meetingId); return; }
  if (state.rec) {
    const r = state.rec;
    if (!await clearEmptyFailedStart(r)) { if (state.rec === r && !failedStartOwnsMemory(r)) await reattachShared(r); return; }
    if (state.rec !== r) return; // Another same-task waiter may already own the next engine.
    endRecSession();
  }
  if (state.current !== m || deletingMeetings.has(m.id)) return;
  const cbs = {
    onLevel: (lvl) => updateLevel(lvl),
    onQueue: () => renderPillQueue(),
    onState: () => renderPill(),
    onWarn: (msg) => toast(msg, { error: true }),
    onLive: (samples, at) => live.audio(samples, at),
    onNative: (s, eng) => onNativeState(s, eng),
  };
  const seqBase = {}; let offsetMs = 0;
  if (resume) { for(const t of m.audio?.tracks||[])seqBase[t.source]=t.chunks||0;
    offsetMs=Math.max(m.duration_ms||0,...(m.segments||[]).map(s=>s.end_ms||0),(seqBase.me||0)*5000); }
  const engine=new SharedMeeting(m.id,cbs,{warm,seqBase,offsetMs});
  state.rec = { meetingId: m.id, title: m.title, engine, phase: 'starting', paused: false, error: null };
  renderDoc(); renderRecBanner(); startPillClock();
  try {
    await engine.start({ systemAudio: false });
    if (state.rec?.engine !== engine) return;
    state.rec.phase = 'recording';
    if (fresh && !resume && state.current?.id === m.id) showParticipantsHint();
    // New phone builds tee 250 ms PCM frames while durable uploads stay at 5 s. Older builds follow uploads.
    live.start(m.id, m.title, { follow: engine.native && !engine.livePcm });
    if (state.current?.id === m.id && state.current.status !== 'recording') setCurrent({ ...state.current, status: 'recording' });
    if (state.current?.id === m.id && !isImported(m) && !els.notepad.hidden && !mobileMQ.matches) els.notepad.focus({ preventScroll: true });
  } catch (e) {
    // Start can reject after obtaining a live session. Retain it for Stop/Retry, never abort audio.
    discardWarm(engine.warm); engine.warm = null;
    if (state.rec?.engine !== engine) return;
    const r = state.rec; r.phase = 'error';
    r.error = e?.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser or system settings, then try again.'
      : e?.name === 'NotFoundError' ? 'No microphone was found.' : `Recording couldn't start: ${e?.message || e}`;
    await clearEmptyFailedStart(r);
    if (state.rec !== r) return;
  }
  if (state.current?.id === m.id) renderDoc();
  renderRecBanner(); schedulePoll(); notifyNative();
}
// A recording left paused this long finishes by itself (the phone recorder enforces the same limit natively),
// so a forgotten pause never holds the summary thread back for hours.
const PAUSE_LIMIT_MS = 30 * 60 * 1000;
function armPauseLimit(r) {
  clearTimeout(r.pauseTimer); r.pauseTimer = 0;
  if (!r.paused || r.engine?.wos) return;
  r.pauseTimer = setTimeout(() => {
    if (state.rec !== r || !r.paused) return;
    toast('Paused for 30 minutes, so the recording was finished and saved.');
    stopRecording({ reason: 'pause_timeout' });
  }, PAUSE_LIMIT_MS);
}
async function togglePause() {
  const r = state.rec; if (!r?.engine || r.phase !== 'recording') return;
  try { if (r.paused) { await r.engine.resume(); r.paused = false; } else { await r.engine.pause(); r.paused = true; } }
  catch (e) { toast(errMsg(e), { error: true }); }
  if (r.paused) live.pause();
  armPauseLimit(r);
  renderPill(); notifyNative();
}
// Wizard OS phone recorder state: also covers Stop/Pause pressed on the notification and the 30-minute pause limit.
function onNativeState(s, eng) {
  const r = state.rec; if (!r || r.engine !== eng) return;
  if (r.phase === 'recording' && s.recording) {
    if (!!s.paused !== !!r.paused) { r.paused = !!s.paused; if (r.paused) live.pause(); renderPill(); notifyNative(); }
    renderPillQueue();
    return;
  }
  if (r.phase === 'recording' && s.recording === false) {
    // Notification Stop crosses the same durable task finalization path; never delete on a push alone.
    void stopRecording({reason:s.pausedMs >= (s.pauseTimeoutMs||PAUSE_LIMIT_MS)-1000 ? 'pause_timeout' : 'user'});
  }
}
// Retry reattaches the retained capture; it never creates or cancels a replacement.
async function retryRecording() {
  const r=state.rec, engine=r?.engine;
  if(r?.phase!=='error')return;
  if(r.deletionConfirmed) { r.phase='deleting'; return finishDeletedRecording(r); }
  if(engine?.result)return stopRecording();
  if(!engine?.captureId)return beginRecording({});
  r.phase='starting';r.error=null;engine.detach();renderPill();
  try {
    await engine.start({systemAudio:false});
    if(state.rec!==r)return;
    r.phase='recording';r.paused=!!engine.info.paused;
    if(engine.info.phase==='error'||engine.info.inputStopped){r.phase='error';await stopRecording();return;}
    live.start(r.meetingId,r.title||'',{follow:engine.native&&!engine.livePcm});
  }catch(e){if(state.rec===r){r.phase='error';r.error=errMsg(e);}}
  if(state.rec!==r)return;
  renderRecBanner();renderPill();notifyNative();if(state.current?.id===r.meetingId)renderDoc();
}
// Rebind fresh app observers after iframe reload. The shell retains the physical recorder and PCM custody.
async function reattachShared(failed = null) {
  if(state.rec !== failed || (failed && (failed.phase !== 'error' || failedStartOwnsMemory(failed))))return;
  let adopted = null;
  try {
    let current=WizardApp.capture.current();
    // Active custody is already positive proof; pending may reject while this exact take is live.
    const pending=current ? [] : await WizardApp.capture.pending();
    // Re-entrant recovery/Retry/Stop cannot replace an engine installed by another waiter.
    if(state.rec !== failed || (failed && (failed.phase !== 'error' || failedStartOwnsMemory(failed))))return;
    current=WizardApp.capture.current();
    const take=current || pending.find(t=>t.meta?.captureRecovery?.resumable) || pending[0];
    let hint;try{hint=JSON.parse(sessionStorage.getItem('mizel.sharedCapture')||'null');}catch{}
    // No guessed meeting ownership: legacy metadata may use only our exact persisted capture hint.
    const id=take?.meta?.meetingId || (hint?.id===take?.id ? hint?.meetingId : null);
    if(!take || !id) {
      if(failed && take) recordingSaveFailed(failed,Error('Shared audio has no verified meeting link. It is still kept; retry after its owner reconnects.'));
      return;
    }
    failed?.engine?.detach?.();
    const cbs={onLevel:updateLevel,onQueue:renderPillQueue,onState:renderPill,onWarn:msg=>toast(msg,{error:true}),onLive:(samples,at)=>live.audio(samples,at),onNative:onNativeState};
    const engine=new SharedMeeting(id,cbs,{captureId:take.id});
    const r=adopted={meetingId:id,title:'',engine,phase:'starting',paused:false,error:null};state.rec=r;recordingUpdateHold ||= WizardApp.update.hold('Mizel capture or durable task save');startPillClock();
    if(current || take.meta?.captureRecovery?.resumable) {
      await engine.start({systemAudio:false});if(state.rec!==r)return;r.phase='recording';r.paused=!!engine.info.paused;
      if(engine.info.phase==='error'||engine.info.inputStopped){state.rec.phase='error';await stopRecording();return;}
      live.start(id,'',{follow:engine.native&&!engine.livePcm});
    } else {
      engine.result=take;engine.captureId=take.id;
      let hint;try{hint=JSON.parse(sessionStorage.getItem('mizel.sharedCapture')||'null');}catch{}
      if(hint?.deletionConfirmed===true && hint.id===take.id && hint.meetingId===id) {
        state.rec.deletionConfirmed=true;state.rec.phase='deleting';await finishDeletedRecording(state.rec);return;
      }
      for(const c of take.streamChunks||[])engine.acceptChunk(c);
      r.phase='uploading';renderPill();await engine.uploader.drain();if(state.rec!==r)return;
      if(!take.meta?.native?.backendStopOwned)await API.stop(id,{final_seq:engine.finalSeq,reason:take.partial?'process_death':'user'});
      if(state.rec!==r)return;await engine.acknowledge();if(state.rec!==r)return;endRecSession();void reattachShared();return;
    }
    renderRecBanner();renderPill();notifyNative();if(state.current?.id===id)renderDoc();return r;
  }catch(e){if(adopted && state.rec===adopted)recordingSaveFailed(adopted,e);return adopted;}
}

async function toggleSystemAudio() {
  const r = state.rec; if (!r?.engine?.systemAudioAvailable) return;
  try { if (r.engine.hasSystemAudio) await r.engine.removeSystemAudio(); else await r.engine.addSystemAudio(); }
  catch (e) { if (e?.name !== 'NotAllowedError') toast(`Computer audio: ${e.message || e.name}`, { error: true }); }
  renderPill();
}
function recordingSaveFailed(r, e) {
  if (state.rec !== r) return;
  r.phase='error';
  r.saveFailure={stage:r.saveStage || 'recover capture',status:e.status || null,code:e.code || 'save_verification',message:errMsg(e)};
  r.error=`Audio retained — ${r.saveFailure.stage}: ${errMsg(e)}`;
  renderPill(); renderRecBanner();
  if(state.current?.id===r.meetingId)renderDoc();
}
async function stopRecording({ reason = 'user' } = {}) {
  const r = state.rec; if (!r || !['recording','error'].includes(r.phase)) return;
  if (!r.engine || (r.phase === 'error' && !r.engine.session && !r.engine.captureId && !r.engine.result)) {
    if (await clearEmptyFailedStart(r)) { if (state.rec === r) endRecSession(); }
    else if (state.rec === r && !failedStartOwnsMemory(r)) {
      const adopted = await reattachShared(r);
      if (adopted && state.rec === adopted) {
        // This Stop belongs to the failed meeting, not a different take discovered during recovery.
        if (adopted.meetingId !== r.meetingId) { navigate(adopted.meetingId); return; }
        if (['recording','error'].includes(adopted.phase)) return stopRecording({reason});
      }
    }
    return;
  }
  if (r.deletionConfirmed) return retryRecording();
  const id = r.meetingId; const engine = r.engine;
  clearTimeout(r.pauseTimer);
  r.phase = 'stopping'; r.error = null; r.saveStage = 'stop capture'; renderPill(); renderAskBar();
  document.querySelector('.who-hint')?.remove();
  live.stop();
  try {
    const take=await engine.stop();r.phase='uploading';r.saveStage='upload audio';renderPill();await engine.uploader.drain();
    // Native Android owns uploads/final_seq/Stop; Mac and browser keep the existing app Stop controller.
    r.saveStage='confirm backend stop';
    if(!take.meta?.native?.backendStopOwned) { const saved=await API.stop(id,{final_seq:engine.finalSeq,reason}); if(state.current?.id===id && saved?.id===id)setCurrent(saved); }
    r.saveStage='verify saved audio and acknowledge capture';
    await engine.acknowledge();stoppedHere={id,at:Date.now()};endRecSession();
    if(state.current?.id===id)await loadMeeting(id);else loadMeetings();
    toast('Saved. Transcript and summary are on their way.');
  }catch(e){recordingSaveFailed(r,e);}
}

async function finishStop(id, body) {
  try {
    const d = await API.stop(id, body && (body.final_seq || body.reason !== 'user') ? body : undefined);
    if (state.rec?.meetingId === id) endRecSession();
    if (state.current?.id === id) { setCurrent(d); state.docMode = 'enhanced'; renderDoc(); schedulePoll(); }
    else loadMeetings();
    toast('Saved. Transcript and summary are on their way.');
  } catch (e) {
    toast(`Couldn't stop the meeting: ${errMsg(e)}`, { error: true, action: { label: 'Retry', fn: () => finishStop(id) } });
    if (state.rec?.meetingId === id) { state.rec.phase = 'error'; state.rec.error = 'Audio was uploaded, but the server did not confirm the stop.'; renderPill(); if (state.current?.id === id) renderDoc(); }
  }
}
function stopAnyway() {
  const r = state.rec; if (!r) return;
  const lost = r.engine?.uploader?.pending || 0;
  toast(`${pluralize(lost, 'chunk')} retained by shared capture. Reconnect and retry saving.`, {error:true,action:{label:'Retry save',fn:()=>stopRecording()}});
}
async function finishWithoutAudio(m) {
  if (state.rec?.meetingId === m.id) { await stopRecording(); return; }
  await finishStop(m.id);
}
function endRecSession() { state.rec?.engine?.detach?.(); clearTimeout(state.rec?.pauseTimer); recordingUpdateHold?.release(); recordingUpdateHold = null; live.stop(); stopPillClock(); state.rec = null; renderRecBanner(); renderPill(); renderAskBar(); els.docPane.dataset.rec = ''; if (state.current) renderHeader(state.current); notifyNative(); }

let pillClock = 0;
let recordingUpdateHold = null;
function startPillClock() { if (!recordingUpdateHold) recordingUpdateHold = WizardApp.update.hold('Mizel recording'); stopPillClock(); pillClock = setInterval(() => { tickPillClock(); renderRecBanner(); }, 500); }
function stopPillClock() { clearInterval(pillClock); pillClock = 0; }
function tickPillClock() { const c = $('.clock', els.pill); if (c && state.rec) c.textContent = fmtClock(recElapsed()); }
const BAR_SHAPE = [0.5, 0.8, 1, 0.75, 0.45];
function setMeter(el, level) {
  if (!el) return;
  const bars = el.children;
  for (let i = 0; i < bars.length; i++) bars[i].style.height = `${3 + Math.round(level * 17 * BAR_SHAPE[i % BAR_SHAPE.length])}px`;
}
function updateLevel(lvl) {
  const v = typeof lvl === 'number' ? { me: lvl, them: 0 } : (lvl || {});
  const me = Math.min(1, Number(v.me) || 0), them = Math.min(1, Number(v.them) || 0);
  setMeter($('.chan.me .w-meter', els.pill), me);
  setMeter($('.chan.them .w-meter', els.pill), them);
  els.pill.style.setProperty('--lvl', Math.max(me, them).toFixed(2));
}
function renderPill() {
  const r = state.rec; const m = state.current;
  const show = r && m && r.meetingId === m.id && r.phase !== 'error';
  els.pill.hidden = !show;
  if (!show) { clear(els.pill); return; }
  els.pill.className = `recorder${r.paused ? ' is-paused' : ''}`;
  if (r.phase === 'starting') { els.pill.classList.add('is-state'); replace(els.pill, h('span', { class: 'w-spinner' }), 'Starting… allow the microphone if asked'); return; }
  if (r.phase === 'stopping' || r.phase === 'uploading') {
    els.pill.classList.add('is-state');
    replace(els.pill, h('span', { class: 'w-spinner' }), h('span', { class: 'qstate' }), h('button', { class: 'w-btn w-btn-sm w-btn-ghost', type: 'button', text: 'Stop anyway', hidden: true, onclick: stopAnyway }));
    renderPillQueue(); return;
  }
  const segCount = m.segments?.length || 0;
  const browser = !r.engine?.native;
  const sysOk = !!r.engine?.systemAudioAvailable;
  const themOn = !!r.engine?.hasSystemAudio;
  const meter = () => h('span', { class: 'w-meter', 'aria-hidden': 'true' }, ...BAR_SHAPE.map(() => h('i')));
  const them = h(sysOk ? 'button' : 'span', {
    class: `chan them${themOn ? '' : ' off'}`, type: sysOk ? 'button' : null,
    title: sysOk ? (themOn ? 'Stop recording computer audio' : 'Also record the other side of a call (your browser will ask which window or tab to share)') : 'Computer audio not available here',
    'aria-label': 'Them: computer audio', 'aria-pressed': sysOk ? String(themOn) : null, onclick: sysOk ? toggleSystemAudio : null,
  }, h('span', { class: 'lbl', text: 'Them' }), meter());
  replace(els.pill,
    h('span', { class: 'rec-time' }, h('span', { class: 'w-live-dot' }), h('span', { class: 'clock', text: fmtClock(recElapsed()) })),
    r.paused && h('span', { class: 'paused', text: 'Paused' }),
    h('span', { class: 'divider' }),
    h('span', { class: 'chan me', title: 'Me: your microphone' }, h('span', { class: 'lbl', text: 'Me' }), meter()),
    them,
    h('span', { class: 'divider' }),
    h('span', { class: 'q qstate' }),
    (browser || !!r.engine?.info?.capabilities?.pause) && h('button', { class: 'w-icon-btn', type: 'button', title: r.paused ? 'Resume' : 'Pause', 'aria-label': r.paused ? 'Resume' : 'Pause', onclick: togglePause }, icon(r.paused ? 'play' : 'pause')),
    h('button', { class: 'stop', type: 'button', title: `Stop recording (${MOD}↩)`, 'aria-label': 'Stop recording', onclick: stopRecording }, icon('stop'), h('span', { class: 'txt', text: 'Stop' }), h('kbd', { text: `${MOD === '⌘' ? '⌘' : 'Ctrl+'}↩` })));
  renderPillQueue();
}
function renderPillQueue() {
  const r = state.rec; const el = $('.qstate', els.pill); if (!r || !el) return;
  const up = r.engine?.uploader; const n = up?.pending || 0; const failing = !!up?.lastError;
  if (r.phase === 'uploading' || r.phase === 'stopping') {
    if(r.engine.native && r.phase==='uploading'){el.textContent='Native recorder is saving…';return;}
    el.textContent = r.phase === 'stopping' ? 'Finishing…' : n ? `Uploading ${n} ${n === 1 ? 'chunk' : 'chunks'}…${failing ? ` (${up.lastError?.code === 'transport_unavailable' ? 'connection failed; retrying' : 'retrying'})` : ''}` : 'Saving…';
    const btn = $('.w-btn', els.pill); if (btn) btn.hidden = !(failing && n);
    return;
  }
  el.textContent = n > 1 || failing ? `${failing ? 'Retrying · ' : ''}${n} queued` : '';
  el.classList.toggle('warn', failing);
}


// ───────────────────────── 9b. Live mode: live words + "Archimedes, …" ask cards ─────────────────────────
const live = {
  ws: null, meetingId: null, title: '', on: false, partial: '', settled: [], asks: new Map(),
  threadId: null, status: 'off', retry: 0, heard: null, reason: '',
  start(meetingId, title, { follow = false } = {}) {
    this.stop({ finish: false }); this.on = true; this.meetingId = meetingId; this.title = title || ''; this.follow = !!follow;
    this.partial = ''; this.partialAt = Math.round(recElapsed()); this.settled = []; this.heard = null; this.retry = 0;
    if (!this.asks.size || [...this.asks.values()][0]?.meetingId !== meetingId) this.asks = new Map();
    this.connect(); renderLive();
  },
  connect() {
    if (!this.on) return;
    clearTimeout(this.retryTimer);
    const u = new URL('live', location.href); u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; u.hash = ''; u.search = '';
    const ws = new WebSocket(u); ws.binaryType = 'arraybuffer'; this.ws = ws; this.status = this.retry ? 'reconnecting' : 'connecting'; renderLive();
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', meetingId: this.meetingId, title: this.title, baseMs: Math.round(recElapsed()), follow: this.follow }));
    ws.onmessage = (e) => { if (this.ws !== ws) return; let m; try { m = JSON.parse(e.data); } catch { return; } this.onMessage(m); };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return; this.ws = null;
      if (!this.on) return;
      if (this.retry >= 6) { this.status = 'unavailable'; renderLive(); return; }
      this.status = 'reconnecting'; renderLive();
      const wait = [1000, 2000, 4000, 8000, 16000, 30000][this.retry++];
      this.retryTimer = setTimeout(() => { if (this.on) this.connect(); }, wait);
    };
  },
  retryNow() { if (!this.on) return; this.retry = 0; this.connect(); },
  onMessage(m) {
    if (m.type === 'ready') { this.threadId = m.threadId; for (const a of m.asks || []) this.asks.set(a.id, a); if (m.summary) summaryStore.set(this.meetingId, m.summary); }
    else if (m.type === 'summary') { summaryStore.set(this.meetingId, m.summary); return; }
    else if (m.type === 'status') { this.status = m.live ? 'live' : 'down'; this.reason = m.reason || ''; }
    else if (m.type === 'words') { this.partial = m.partial || ''; this.partialAt = Number.isFinite(m.startMs) ? m.startMs : this.partialAt; if (this.partial.trim()) { this.retry = 0; this.status = 'live'; } renderLiveTail(); renderConnectionStatus(); return; }
    else if (m.type === 'settled') { if (m.text) { this.settled.push({ text: m.text, startMs: m.startMs, endMs: m.endMs }); this.retry = 0; this.status = 'live'; } this.partial = ''; if (this.settled.length > 400) this.settled.splice(0, 100); renderLiveTail(); renderConnectionStatus(); return; }
    else if (m.type === 'ask') {
      const had = this.asks.get(m.ask.id); this.asks.set(m.ask.id, m.ask); if (m.ask.threadId) this.threadId = m.ask.threadId;
      if (!had && navigator.vibrate) navigator.vibrate(30);
      const i = allAsks.list.findIndex((x) => x.id === m.ask.id); if (i >= 0) allAsks.list[i] = m.ask; else allAsks.list.unshift(m.ask);
      if (overlay?.askId === m.ask.id) openAskSheetFor(m.ask.id, true);
      if (state.current?.id === m.ask.meetingId) renderArchimedesSection();
    }
    else if (m.type === 'heard') { this.heard = { text: m.text, at: Date.now() }; setTimeout(renderLive, 4200); }
    renderLive();
  },
  audio(samples, at) { if (this.ws?.readyState === 1) { if (Number.isFinite(at)) this.ws.send(JSON.stringify({ type: 'pcm-at', startMs: at })); this.ws.send(samples.buffer); } },
  control(type, askId) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type, askId })); },
  pause() { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'pause' })); },
  stop({ finish = true } = {}) {
    const ws = this.ws; this.on = false; this.ws = null; clearTimeout(this.retryTimer);
    if (ws) { try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop', finish })); } catch { /* ignore */ } setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 1500); }
    this.status = 'off'; this.partial = ''; renderLive(); renderLiveTail();
  },
};
// Live words: grey while being heard, then replaced by the accurate transcript as each ~30 s stretch locks in.
function liveTailText() {
  const m = state.current; if (!m || !live.on || live.meetingId !== m.id) return null;
  const lockedTo = Math.max(0, ...(m.segments || []).map((x) => x.end_ms || 0));
  const fresh = live.settled.filter((x) => (x.startMs + x.endMs) / 2 > lockedTo).map((x) => x.text);
  if (live.partial) fresh.push(live.partial);
  return fresh.join(' ').replace(/\s+/g, ' ').trim();
}
function livePreviewRows() {
  const m = state.current; if (!m) return [];
  const lockedTo = Math.max(0, ...(m.segments || []).map(s => s.end_ms || 0));
  const fresh = live.settled.filter(s => (s.startMs + s.endMs) / 2 > lockedTo);
  const rows = fresh.map(s => h('div', { class: 'tx me tx-provisional' }, h('div', { class: 'who' }, h('time', { text: fmtClock(s.startMs) })), h('div', { class: 'txt', text: s.text })));
  const at = Number.isFinite(live.partialAt) ? live.partialAt : fresh[fresh.length - 1]?.endMs || lockedTo;
  rows.push(h('div', { class: `tx me tx-live${live.partial ? '' : ' is-empty'}` }, h('div', { class: 'who' }, h('time', { class: 'live-tag', text: fmtClock(at) })),
    h('div', { class: 'txt', text: live.partial || '' }), h('div', { class: 'listening' }, 'Listening…')));
  return rows;
}
function renderLiveTail() {
  const box = els.segments; if (!box || state.docMode !== 'transcript') return;
  const region = box.querySelector('.live-preview'); if (!region) return renderSegments(box);
  replace(region, ...livePreviewRows());
}
function threadHref(id) { return `/wizard/?session=${enc(id)}`; }
const ASK_ST = { listening: 'Listening…', working: 'On it…', answered: 'Answered', failed: 'Needs a look', cancelled: 'Cancelled' };
function askBtn(text, type, id, primary = false) { return h('button', { class: `w-btn w-btn-sm ${primary ? 'w-btn-primary' : ''}`, type: 'button', text, onclick: (e) => { e.stopPropagation(); live.control(type, id); } }); }
async function dismissAsk(a, undo = true) {
  a.dismissed = true; live.asks.set(a.id, a); renderLive();
  try { await fetch(`asks/${enc(a.id)}/dismiss`, { method: 'POST' }); } catch { /* ignore */ }
  if (undo) toast('Moved to Archimedes', { action: { label: 'Undo', fn: async () => { a.dismissed = false; live.asks.set(a.id, a); renderLive(); try { await fetch(`asks/${enc(a.id)}/restore`, { method: 'POST' }); } catch { /* ignore */ } } } });
}
function renderLive() {
  const el = els.live; if (!el) return;
  // Cards float only while this meeting is recording (or an answer is still on its way);
  // afterwards they live in the meeting's "Asked Archimedes" list and the Archimedes section.
  const here = state.current?.id === live.meetingId;
  const pending = (a) => ['listening', 'working'].includes(a.status);
  const cards = [...live.asks.values()].filter((a) => a.status !== 'cancelled' && !a.dismissed && here && (live.on || pending(a)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-2);
  const heard = live.heard && Date.now() - live.heard.at < 4000;
  const down = live.on && live.status === 'down';
  const show = cards.length || heard;
  renderConnectionStatus();
  el.hidden = !show; if (!show) { clear(el); return; }
  replace(el,
    ...cards.map((a) => h('article', { class: `live-card is-${a.status}`, dataset: { id: a.id }, role: 'button', tabindex: '0', 'aria-label': 'Open Archimedes answer', onclick: () => openAsk(a.id), onkeydown: (e) => { if (e.key === 'Enter') openAsk(a.id); } },
      h('header', {},
        h('span', { class: 'who' }, h('span', { class: 'orb', 'aria-hidden': 'true' }), a.agentLabel || 'Archimedes'),
        h('span', { class: 'st', text: ASK_ST[a.status] || a.status }),
        h('button', { class: 'w-icon-btn x', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss (find it again under Archimedes)', onclick: (e) => { e.stopPropagation(); if (a.status === 'listening') live.control('cancel', a.id); else dismissAsk(a); } }, icon('close'))),
      h('p', { class: 'q', text: `“${a.text}”` }),
      a.status === 'listening' ? h('div', { class: 'la-listen' },
          h('span', { class: 'hint', text: 'Automatic voice requests are disabled. Use Ask Archimedes.' }),
          h('span', { class: 'acts' }, askBtn('Cancel', 'cancel', a.id), askBtn('Send now', 'send-now', a.id, true)))
        : a.status === 'working' ? h('div', { class: 'dots', 'aria-label': 'Working' }, h('i'), h('i'), h('i'))
        : a.status === 'answered' ? h('div', { class: 'a md clamp', html: md(a.answer || '') })
        : h('div', { class: 'la-fail' }, h('p', { class: 'err', text: a.error || 'Something went wrong.' }), askBtn('Retry', 'retry', a.id, true)),
      a.status === 'answered' ? h('span', { class: 'more', text: 'Tap to read in full' }) : null)),
    heard ? h('div', { class: 'lw-heard', text: 'Heard “Archimedes” — no request, carrying on.' }) : null,
    down ? h('div', { class: 'lw-heard warn', text: live.reason || 'Live words unavailable. Recording continues.' }) : null);
  for (const c of el.querySelectorAll('.a.clamp')) c.classList.toggle('is-long', c.scrollHeight > c.clientHeight + 4);
}

// ── Archimedes: every live answer, findable again ──
const allAsks = { list: [], loaded: false, loading: false };
async function loadAllAsks() {
  allAsks.loading = true; renderArchimedesView();
  try { const r = await fetch('asks?limit=300').then((x) => x.json()); allAsks.list = r.asks || []; allAsks.loaded = true; }
  catch (e) { toast(`Couldn't load Archimedes answers: ${errMsg(e)}`, { error: true }); }
  allAsks.loading = false; renderArchimedesView(); renderList();
}
function askRow(a, { showMeeting = false } = {}) {
  const mt = state.meetings.find((x) => x.id === a.meetingId);
  return h('button', { class: `arch-row is-${a.status}`, type: 'button', onclick: () => openAsk(a.id) },
    h('span', { class: 'orb', 'aria-hidden': 'true' }),
    h('span', { class: 'body' },
      h('span', { class: 'q', text: a.text }),
      h('span', { class: 'a', text: a.status === 'answered' ? stripMd(a.answer || '') : ASK_ST[a.status] || a.status }),
      h('span', { class: 'when', text: [showMeeting ? (mt?.title || a.title || 'Recording') : null, `${dayLabel(a.createdAt)} · ${fmtTime(a.createdAt)}`].filter(Boolean).join(' · ') })));
}
function stripMd(t) { return String(t).replace(/[*_`#>]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim(); }
function renderArchimedesView() {
  const box = els.archView; if (!box || state.route.view !== 'archimedes') return;
  const list = allAsks.list.filter((a) => a.status !== 'cancelled');
  const groups = [];
  for (const a of list) { const k = dayLabel(a.createdAt); const g = groups[groups.length - 1]; if (g && g.k === k) g.items.push(a); else groups.push({ k, items: [a] }); }
  replace(box,
    h('p', { class: 'eyebrow', text: 'Live mode' }),
    h('h1', { class: 'title', text: 'Archimedes' }),
    h('p', { class: 'arch-sub', text: 'Messages you explicitly sent to Archimedes, newest first. Previous answers remain here too.' }),
    allAsks.loading && !list.length ? h('div', { class: 'w-empty' }, h('span', { class: 'w-spinner' }), ' Loading…')
      : !list.length ? h('div', { class: 'w-empty', text: 'Nothing yet. Open a recording and tap Ask Archimedes.' })
      : h('div', { class: 'arch-list' }, ...groups.flatMap((g) => [h('h2', { class: 'w-label', text: g.k }), ...g.items.map((a) => askRow(a, { showMeeting: true }))])));
}
function renderArchimedesSection() {
  const m = state.current; const box = els.archSection; if (!box) return;
  if (!m || isImported(m)) { clear(box); box.hidden = true; return; }
  const mine = allAsks.list.filter((a) => a.meetingId === m.id && a.status !== 'cancelled').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  box.hidden = !mine.length;
  replace(box, mine.length ? h('div', { class: 'section-head', text: `Asked Archimedes · ${mine.length}` }) : null, ...mine.map((a) => askRow(a)));
}
async function refreshMeetingAsks(id) {
  try { const r = await fetch(`asks?meetingId=${enc(id)}`).then((x) => x.json());
    const ids = new Set((r.asks || []).map((a) => a.id));
    allAsks.list = [...(r.asks || []), ...allAsks.list.filter((a) => !ids.has(a.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch { /* ignore */ }
  if (state.current?.id === id) renderArchimedesSection();
}
function findAsk(id) { return live.asks.get(id) || allAsks.list.find((a) => a.id === id) || null; }
async function openAskSheetFor(id, refresh = false) {
  let a = findAsk(id);
  if (!a) { try { const r = await fetch('asks?limit=500').then((x) => x.json()); allAsks.list = r.asks || []; a = findAsk(id); } catch { /* ignore */ } }
  if (!a) { toast('That answer is no longer here.'); if (state.route.ask) history.back(); return; }
  if (refresh && overlay?.askId !== id) return;
  const mt = state.meetings.find((x) => x.id === a.meetingId) || (state.current?.id === a.meetingId ? state.current : null);
  const el = openOverlay(() => h('div', { class: 'sheet ask-sheet', role: 'dialog', 'aria-label': `${a.agentLabel || 'Archimedes'} answer` },
    h('div', { class: 'grabber', 'aria-hidden': 'true' }),
    h('header', {},
      h('span', { class: 'who' }, h('span', { class: 'orb', 'aria-hidden': 'true' }), 'Archimedes'),
      h('span', { class: 'st', text: ASK_ST[a.status] || a.status }),
      h('button', { class: 'w-icon-btn', type: 'button', 'aria-label': 'Close', onclick: closeAskSheet }, icon('close'))),
    h('p', { class: 'when', text: [mt?.title || a.title || 'Recording', `${dayLabel(a.createdAt)} · ${fmtTime(a.createdAt)}`].join(' · ') }),
    h('h3', { class: 'q', text: `“${a.text}”` }),
    h('div', { class: 'a-scroll' },
      a.status === 'answered' ? h('div', { class: 'a w-prose md', html: md(a.answer || '') })
        : a.status === 'failed' ? h('p', { class: 'err', text: a.error || 'Something went wrong.' })
        : h('div', { class: 'dots' }, h('i'), h('i'), h('i'))),
    h('div', { class: 'acts' },
      a.threadId ? h('a', { class: 'w-btn w-btn-sm w-btn-primary', href: threadHref(a.threadId), target: '_top' }, 'Continue in Wizard') : null,
      a.meetingId && state.route.view !== 'meeting' ? h('a', { class: 'w-btn w-btn-sm', href: `#/m/${enc(a.meetingId)}` }, 'Open recording') : null,
      a.status === 'answered' ? h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(a.answer || ''); toast('Copied'); } catch { toast('Clipboard unavailable', { error: true }); } } }) : null,
      a.status === 'failed' ? h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'Retry', onclick: () => live.control('retry', a.id) }) : null)));
  overlay.askId = id;
  const scrim = el.previousElementSibling; if (scrim) scrim.onclick = closeAskSheet;
}

// Explicit public-agent message: never prefill with recording content.
// ───────── Where the finished transcript goes ─────────
// Every recording goes to the private agent unless this one recording is pointed somewhere else.
const DEFAULT_AGENT = 'private';
const AGENT_NAMES = { private: 'Private agent', hermes: 'Archimedes' };
const AGENT_NOTES = { private: 'Only you can read it', hermes: 'Your main agent' };
let agentList = { at: 0, list: null };
async function wizardAgents() {
  if (agentList.list && Date.now() - agentList.at < 60000) return agentList.list;
  let raw = [];
  try { const r = await fetch('/wizard/v1/agents', { credentials: 'same-origin', cache: 'no-store' }); if (r.ok) raw = (await r.json()).agents || []; } catch { /* fall back below */ }
  if (!raw.length) { try { raw = (await api('agents')).agents || []; } catch { raw = []; } }
  const list = raw.filter((a) => a && /^[a-z][a-z0-9-]{0,30}$/.test(a.id) && a.status !== 'stopped' && a.status !== 'removed' && a.role !== 'recovery')
    .map((a) => ({ id: a.id, label: AGENT_NAMES[a.id] || a.label || a.id, privacy: a.privacy === 'private' ? 'private' : 'standard' }));
  const rank = (a) => (a.id === DEFAULT_AGENT ? 0 : a.id === 'hermes' ? 1 : 2);
  list.sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label));
  agentList = { at: Date.now(), list };
  return list;
}
const agentName = (id, list = agentList.list || []) => (id === 'none' ? 'Nobody' : list.find((a) => a.id === id)?.label || AGENT_NAMES[id] || id);
const routeCache = new Map();
async function loadRoute(mid, maxAge = 0) {
  const hit = routeCache.get(mid);
  if (hit && Date.now() - hit.at < maxAge) return hit.r;
  const r = await api(`finish-route?${new URLSearchParams({ meetingId: mid })}`); routeCache.set(mid, { at: Date.now(), r }); return r;
}

function routeRow({ glyph, tone = '', title, sub, onclick, href, trailing = 'chev', busy = false }) {
  const kids = [
    h('span', { class: `rt-ic ${tone}` }, busy ? h('span', { class: 'rt-spin', 'aria-hidden': 'true' }) : icon(glyph)),
    h('span', { class: 'rt-text' }, h('span', { class: 'rt-title' }, ...title), h('span', { class: 'rt-sub', text: sub })),
    trailing ? h('span', { class: 'rt-trail' }, trailing === 'chev' ? icon('chev') : trailing) : null,
  ];
  return href ? h('a', { class: 'rt', href, target: '_top' }, ...kids) : h('button', { class: 'rt', type: 'button', onclick }, ...kids);
}
async function renderRoute(m) {
  const el = els.docRoute; if (!el) return;
  if (!m || isImported(m)) { el.hidden = true; return; }
  let r, list;
  try { [r, list] = await Promise.all([loadRoute(m.id, 8000), wizardAgents()]); } catch { el.hidden = true; return; }
  if (state.current?.id !== m.id) return;
  const name = agentName(r.route, list);
  const glyphFor = (id) => (id === 'none' ? 'off' : id === DEFAULT_AGENT ? 'lock' : 'agent');
  let row;
  if (r.sent) {
    row = routeRow({ glyph: 'check', tone: 'is-done', title: ['Sent to ', h('b', { text: agentName(r.sent.agent, list) })], sub: `${dayLabel(r.sent.createdAt)} · ${fmtTime(r.sent.createdAt)} · Open thread`, href: threadHref(r.sent.threadId) });
  } else if (r.last?.status === 'sending') {
    row = routeRow({ busy: true, title: ['Sending to ', h('b', { text: name })], sub: 'Transcript and summary', trailing: null });
  } else if (r.last?.status === 'failed') {
    row = routeRow({ glyph: glyphFor(r.route), tone: 'is-warn', title: ['Couldn’t reach ', h('b', { text: name })], sub: 'Tap to try again', onclick: () => openRouteSheet(m) });
  } else {
    const finished = m.status === 'ready';
    const sub = r.route === 'none' ? 'This recording stays in Mizel'
      : !r.eligible ? 'Recorded before auto-send · Tap to send'
      : finished ? (r.due ? 'Sending now…' : 'Sends when the summary is ready')
      : r.isDefault ? 'Default · sends when you stop' : 'Just this recording';
    row = routeRow({ glyph: glyphFor(r.route), tone: r.route === DEFAULT_AGENT ? 'is-private' : '', title: [r.route === 'none' ? 'Not sending' : 'Sends to ', r.route === 'none' ? null : h('b', { text: name })], sub, onclick: () => openRouteSheet(m), trailing: h('span', { class: 'rt-change', text: 'Change' }) });
  }
  replace(el, row); el.hidden = false;
}

async function openRouteSheet(m) {
  let r, list;
  try { [r, list] = await Promise.all([loadRoute(m.id), wizardAgents()]); } catch (e) { toast(errMsg(e), { error: true }); return; }
  let choice = r.route;
  const error = h('p', { class: 'rs-err', role: 'status' });
  const opts = [...list, { id: 'none', label: 'Don’t send', note: 'Keep this recording in Mizel only' }];
  const finished = m.status === 'ready';
  const canSendNow = () => finished && choice !== 'none' && (!r.sent || r.sent.agent !== choice);
  const body = h('div', { class: 'rs-list', role: 'radiogroup', 'aria-label': 'Send this recording to' });
  const sendBtn = h('button', { class: 'w-btn w-btn-primary rs-send', type: 'button', onclick: () => sendNow() });
  const foot = h('div', { class: 'rs-foot' });
  const drawFoot = () => {
    sendBtn.textContent = `Send to ${agentName(choice, list)} now`;
    replace(foot, h('p', { class: 'rs-note' }, choice === DEFAULT_AGENT || choice === r.default ? 'New recordings always go to ' : 'Only this recording changes. New recordings still go to ', h('b', { text: 'Private agent' }), '.'),
      canSendNow() ? sendBtn : null);
  };
  const pick = async (id) => {
    if (id === choice) return;
    const prev = choice; choice = id; draw(); error.textContent = '';
    try { await api('finish-route', { method: 'POST', json: { meetingId: m.id, agent: id } }); routeCache.delete(m.id); void renderRoute(m); }
    catch (e) { choice = prev; draw(); error.textContent = errMsg(e); }
  };
  const draw = () => {
    replace(body, ...opts.map((a) => {
      const on = a.id === choice;
      const note = a.note || (a.id === DEFAULT_AGENT ? AGENT_NOTES[a.id] : AGENT_NOTES[a.id] || (a.privacy === 'private' ? 'Private' : 'Standard agent'));
      return h('button', { type: 'button', role: 'radio', class: 'rs-opt', 'aria-checked': String(on), dataset: { agent: a.id }, onclick: () => pick(a.id) },
        h('span', { class: `rs-ic${a.id === DEFAULT_AGENT ? ' is-private' : ''}` }, icon(a.id === 'none' ? 'off' : a.id === DEFAULT_AGENT ? 'lock' : 'agent')),
        h('span', { class: 'rs-text' }, h('span', { class: 'rs-name' }, a.label, a.id === DEFAULT_AGENT ? h('span', { class: 'rs-tag', text: 'Default' }) : null), h('span', { class: 'rs-sub', text: note })),
        h('span', { class: 'rs-check', 'aria-hidden': 'true' }, on ? icon('check') : null));
    }));
    drawFoot();
  };
  const sendNow = async () => {
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; error.textContent = '';
    try {
      const target = list.find((a) => a.id === choice);
      const res = await deliver(m.id, choice, { manual: true, label: agentName(choice, list), viaDevice: target?.privacy === 'private' });
      toast(`Sent to ${agentName(choice, list)}`); closeOverlay(); routeCache.delete(m.id); void renderRoute(m); void res;
    } catch (e) { error.textContent = errMsg(e); sendBtn.disabled = false; drawFoot(); }
  };
  draw();
  openOverlay(() => h('div', { class: 'sheet ask-sheet route-sheet', role: 'dialog', 'aria-label': 'Send this recording to' },
    h('div', { class: 'grabber', 'aria-hidden': 'true' }),
    h('header', { class: 'rs-head' }, h('h2', { text: 'Send this recording to' }), h('button', { class: 'w-icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => closeOverlay() }, icon('close'))),
    h('p', { class: 'rs-what', text: 'The full transcript and summary go to a new thread when the recording is done.' }),
    body, error, foot));
}

// Sending. Standard agents are sent by the Mizel server; the private agent only accepts the owner's own
// device, so this client sends it through Wizard (same path as Chats).
async function wizardCall(path, agent, json, headers = {}) {
  const r = await fetch(`/wizard/hermes${path}?agent=${encodeURIComponent(agent)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify({ ...json, agent }) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || data?.error || `Wizard ${r.status}`), { status: r.status, body: text.slice(0, 200) });
  return data || {};
}
async function deviceDeliver(meetingId, agent, { manual = false, label = '' } = {}) {
  const c = await api('deliveries/claim', { method: 'POST', json: { meetingId, agent, manual, agentLabel: label || agentName(agent) } });
  try {
    const id = `wizard_${Date.now()}_${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const tag = () => Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, '0')).join('');
    for (const [i, title] of [c.title, `${c.title} · ${tag()}`, `${c.title} · ${tag()}${tag()}`].entries()) {
      try { await wizardCall('/api/sessions', c.agent, { id, source: 'wizard-mobile', title: title.slice(0, 90) }); break; }
      catch (e) { if (!/invalid_title|already in use/i.test(`${e.message} ${e.body}`) || i === 2) throw e; }
    }
    const run = await wizardCall('/v1/runs', c.agent, { session_id: id, input: c.text }, { 'Idempotency-Key': c.sendId });
    return await api('deliveries/result', { method: 'POST', json: { sendId: c.sendId, threadId: id, runId: run.run_id || run.id || '' } });
  } catch (e) {
    await api('deliveries/result', { method: 'POST', json: { sendId: c.sendId, error: errMsg(e) } }).catch(() => {});
    throw e;
  }
}
async function deliver(meetingId, agent, { manual = false, label = '', viaDevice = false } = {}) {
  if (viaDevice) return deviceDeliver(meetingId, agent, { manual, label });
  return api('send', { method: 'POST', json: { meetingId, agent } });
}
let pumping = false;
async function pumpDeliveries() {
  if (pumping || document.visibilityState !== 'visible') return;
  pumping = true;
  try {
    const { due = [] } = await api('deliveries/due');
    for (const d of due) {
      try { await deviceDeliver(d.meetingId, d.agent); routeCache.delete(d.meetingId); }
      catch (e) { if (e?.status !== 409) console.warn('Mizel delivery failed', d.meetingId, errMsg(e)); }
      if (state.current?.id === d.meetingId) void renderRoute(state.current);
    }
  } catch { /* offline: next tick */ }
  finally { pumping = false; }
}
void pumpDeliveries();
setInterval(() => { void pumpDeliveries(); if (state.current && !els.docRoute.hidden) void renderRoute(state.current); }, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void pumpDeliveries(); });
function openManualAsk(meetingId) {
  let sending = false;
  const input = h('textarea', { class: 'w-input', rows: '4', maxlength: '6000', placeholder: 'Your message to Archimedes…', 'aria-label': 'Message to Archimedes', style: 'width:100%;resize:vertical;margin:12px 0' });
  const error = h('p', { class: 'err', role: 'status' });
  const send = h('button', { class: 'w-btn w-btn-primary', type: 'button', text: 'Send to Wizard', onclick: async () => {
    const text = input.value.trim(); if (!text || sending) return;
    sending = true; send.disabled = true; error.textContent = '';
    try {
      const r = await api('manual-ask', { method: 'POST', json: { meetingId, text } });
      live.asks.set(r.ask.id, r.ask);
      allAsks.list.unshift(r.ask);
      renderLive(); renderArchimedesSection(); openAsk(r.ask.id);
    } catch (e) { error.textContent = errMsg(e); sending = false; send.disabled = false; }
  } });
  const el = openOverlay(() => h('div', { class: 'sheet ask-sheet', role: 'dialog', 'aria-label': 'Ask Archimedes' },
    h('div', { class: 'grabber', 'aria-hidden': 'true' }),
    h('header', {}, h('h2', { text: 'Ask Archimedes' }), h('button', { class: 'w-icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => closeOverlay() }, icon('close'))),
    h('p', { text: 'Only the message you send goes to your Wizard model. Your recording and transcript stay private.' }),
    input, error,
    h('div', { class: 'acts' }, h('button', { class: 'w-btn', type: 'button', text: 'Cancel', onclick: () => closeOverlay() }), send)));
  overlay.manualHistory = true; history.pushState({ mizelManualComposer: true }, '', location.href);
  el.dataset.manualAsk = 'true'; input.focus();
}

// ───────────────────────── 10. Ask ─────────────────────────
function renderAskBar() {
  const m = state.current;
  els.askMeeting.hidden = !m || state.route.view !== 'meeting' || isLiveHere(m);
}
function renderAsks(m) {
  const asks = [...(m.asks || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  replace(els.asks, asks.length ? h('div', { class: 'section-head', text: 'Questions' }) : null, ...asks.map((a) => h('div', { class: 'qa', dataset: { id: a.id } },
    h('div', { class: 'q' }, h('span', { text: a.question }), a.created_at && h('span', { class: 'when', text: relTime(a.created_at) })),
    a.status === 'pending' ? h('div', { class: 'a working' }, h('span', { class: 'w-spinner' }), 'Reading the transcript…')
      : a.status === 'error' ? h('div', { class: 'a error' }, 'Couldn’t answer this.', h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'Ask again', onclick: () => askMeeting(a.question) }))
      : h('div', { class: 'a w-prose md answer', html: md(a.answer || '', { evidence: true }) }))));
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
    item.status === 'pending' ? h('div', { class: 'a working' }, h('span', { class: 'w-spinner' }), 'Searching across your meetings…')
      : item.status === 'error' ? h('div', { class: 'a error' }, `${item.error} `, h('button', { class: 'w-btn w-btn-sm', type: 'button', text: 'Try again', onclick: () => askAll(item.question) }))
      : h('div', { class: 'a' }, h('div', { class: 'w-prose md answer', html: md(item.answer || '') }),
        item.meetings?.length ? h('div', { class: 'cites' }, ...item.meetings.map((mm) => h('a', { class: 'w-chip', href: `#/m/${enc(mm.id)}`, title: mm.title }, icon('arrow'), `${mm.title || 'Untitled'} · ${dayLabel(mm.started_at)}`))) : null))));
  els.askSuggest.hidden = t.length > 0;
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

// ───────────────────────── 11. Command palette, shortcuts, native hook ─────────────────────────
let overlay = null; // { el, close }
function closeOverlay({ fromHistory = false, preserveEntry = false } = {}) {
  if (!overlay) return false;
  const o = overlay; overlay = null; o.close();
  if (o.manualHistory && !fromHistory && !preserveEntry && history.state?.mizelManualComposer) history.back();
  return true;
}
window.addEventListener('popstate', (e) => {
  if (overlay?.manualHistory && !e.state?.mizelManualComposer) closeOverlay({ fromHistory: true });
});
function openOverlay(build) {
  closeOverlay();
  const scrim = h('div', { class: 'w-scrim', onclick: () => closeOverlay() });
  const el = build();
  els.overlayRoot.append(scrim, el);
  const prevFocus = document.activeElement;
  overlay = { el, close: () => { scrim.remove(); el.remove(); prevFocus?.focus?.({ preventScroll: true }); } };
  return el;
}
function paletteActions() {
  const acts = [];
  const live = state.rec && state.rec.phase === 'recording';
  if (live) acts.push({ id: 'stop', icon: 'stop', title: 'Stop recording', sub: state.rec.title || 'Untitled meeting', keys: [MOD, '↩'], run: () => { navigate(state.rec.meetingId); stopRecording(); } });
  else acts.push({ id: 'new', icon: 'mic', title: 'New meeting', sub: 'Start recording now', keys: [MOD, 'N'], run: newMeeting });
  for (const ev of upcomingEvents().filter((e) => !e.meeting_id).slice(0, 2)) acts.push({ id: `ev-${ev.id}`, icon: 'cal', title: `Record “${ev.title || 'event'}”`, sub: `${dayLabel(ev.start)} · ${fmtTime(ev.start)}`, run: () => startFromEvent(ev) });
  acts.push({ id: 'ask', icon: 'spark', title: 'Ask across meetings…', sub: 'Questions answered from every transcript', run: () => { navigate(null); setTimeout(() => (mobileMQ.matches ? els.askAllInput : els.askAllInput).focus(), 60); } });
  if (state.current) acts.push({ id: 'tx', icon: 'transcript', title: 'Show transcript', keys: [MOD, 'J'], run: toggleDrawer });
  if (state.route.view !== 'home') acts.push({ id: 'home', icon: 'back', title: 'All meetings', keys: ['Esc'], run: () => navigate(null) });
  acts.push({ id: 'keys', icon: 'keyboard', title: 'Keyboard shortcuts', keys: ['?'], run: () => setTimeout(openShortcuts) });
  return acts;
}
function openPalette(initial = '') {
  let sel = 0; let items = []; let remote = null; let lastQ = null;
  const input = h('input', { type: 'text', placeholder: 'Search meetings or type a command', 'aria-label': 'Search meetings or type a command', autocomplete: 'off', spellcheck: 'false', value: initial });
  const list = h('div', { class: 'p-list', role: 'listbox' });
  const el = openOverlay(() => h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Search' },
    h('div', { class: 'p-input' }, icon('search'), input, h('kbd', { class: 'w-kbd', text: 'esc' })), list,
    h('div', { class: 'p-foot' }, h('span', {}, ...kbd('↑', '↓'), 'navigate'), h('span', {}, ...kbd('↩'), 'open'), h('span', {}, ...kbd(MOD, 'K'), 'toggle'))));
  const meetingItem = (m) => ({ id: m.id, icon: m.status === 'recording' ? 'mic' : m.enhanced ? 'spark' : 'transcript', title: m.title || 'Untitled meeting', sub: [`${dayLabel(m.started_at)} · ${fmtTime(m.started_at)}`, stripMarks(m.preview).slice(0, 90)].filter(Boolean).join(' — '), run: () => navigate(m.id) });
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const acts = paletteActions().filter((a) => !q || a.title.toLowerCase().includes(q));
    let ms;
    if (!q) ms = state.meetings.slice(0, 7);
    else {
      const local = state.meetings.filter((m) => (m.title || '').toLowerCase().includes(q) || (m.preview || '').toLowerCase().includes(q));
      const seen = new Set(local.map((m) => m.id));
      ms = [...local, ...((remote?.q === q ? remote.items : []).filter((m) => !seen.has(m.id)))].slice(0, 12);
    }
    const groups = [];
    if (acts.length) groups.push(['Actions', acts]);
    if (ms.length) groups.push([q ? 'Meetings' : 'Recent', ms.map(meetingItem)]);
    items = groups.flatMap(([, g]) => g);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let i = 0;
    replace(list, ...groups.flatMap(([label, g]) => [h('div', { class: 'p-group', text: label }), ...g.map((it) => {
      const idx = i++;
      return h('button', { class: `p-item${idx === sel ? ' is-sel' : ''}`, type: 'button', role: 'option', 'aria-selected': String(idx === sel), onmousemove: () => { if (sel !== idx) { sel = idx; render(); } }, onclick: () => runItem(it) },
        h('span', { class: 'p-ic' }, icon(it.icon)), h('span', { class: 'p-main' }, h('span', { class: 'p-title', text: it.title }), it.sub && h('span', { class: 'p-sub', text: it.sub })),
        it.keys && h('span', { class: 'p-hint' }, ...kbd(...it.keys)));
    })]), !items.length && h('div', { class: 'p-empty', text: q && remote?.q !== q ? 'Searching transcripts…' : `Nothing matches “${input.value.trim()}”.` }));
    list.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
  };
  const search = debounce(async () => {
    const q = input.value.trim().toLowerCase(); if (!q || q === lastQ) return; lastQ = q;
    try { const r = await API.meetings(q, 20); if (input.value.trim().toLowerCase() === q) { remote = { q, items: r.meetings || [] }; render(); } } catch { remote = { q, items: [] }; render(); }
  }, 220);
  const runItem = (it) => { closeOverlay(); it.run(); };
  input.addEventListener('input', () => { sel = 0; render(); search(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) runItem(items[sel]); }
  });
  render(); if (initial) search();
  setTimeout(() => input.focus(), 0);
  return el;
}
function openShortcuts() {
  const rows = [['Search & commands', [MOD, 'K']], ['New meeting', [MOD, 'N']], ['Stop recording', [MOD, '↩']], ['Show / hide transcript', [MOD, 'J']], ['Ask about this meeting', ['/']], ['Back / close', ['Esc']], ['This sheet', ['?']]];
  openOverlay(() => h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Keyboard shortcuts' }, h('h3', { text: 'Keyboard shortcuts' }),
    h('dl', {}, ...rows.flatMap(([label, keys]) => [h('dt', { text: label }), h('dd', {}, ...kbd(...keys))]))));
}
function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'k') { e.preventDefault(); if (overlay) closeOverlay(); else openPalette(); return; }
  if (mod && k === 'n' && !e.shiftKey) { e.preventDefault(); closeOverlay(); newMeeting(); return; }
  if (mod && e.key === 'Enter' && state.rec?.phase === 'recording') { e.preventDefault(); stopRecording(); return; }
  if (mod && k === 'j' && state.current) { e.preventDefault(); toggleDrawer(); return; }
  if (e.key === 'Escape') {
    if (overlay?.askId && state.route.ask) { e.preventDefault(); history.back(); return; }
    if (closeOverlay() || closeMenu()) { e.preventDefault(); return; }
    if (state.drawerOpen) { e.preventDefault(); closeDrawer(); return; }
    if (isTyping()) { if (document.activeElement !== els.title) document.activeElement.blur(); return; }
    if (state.route.view === 'meeting' && !mobileMQ.matches) { navigate(null); return; }
    return;
  }
  if (isTyping() || mod || e.altKey || overlay) return;
  if (e.key === '?') { e.preventDefault(); openShortcuts(); }
  else if (e.key === '/') { e.preventDefault(); if (state.route.view === 'meeting' && !els.askMeeting.hidden) els.askMeetingInput.focus(); else if (state.route.view === 'home') els.askAllInput.focus(); else openPalette(); }
}

// Domain view hook for existing shells. All recorder access flows through WizardApp.capture. The shell may also drive the view through window.mizel:
//   mizel.open(id) · mizel.newMeeting() · mizel.stop() · mizel.state()
//   mizel.setNativeRecorder(true)  → hides the in-page recorder while a native floating pill is shown
//   mizel.onNativeEvent({type:'level', me, them}) → feeds the in-page meters
// and can listen for `mizel:state` CustomEvents on window ({recording, meetingId, paused, elapsedMs}).
function notifyNative() {
  const r = state.rec;
  const detail = { recording: !!r && r.phase === 'recording', meetingId: r?.meetingId || null, paused: !!r?.paused, elapsedMs: recElapsed() };
  window.dispatchEvent(new CustomEvent('mizel:state', { detail }));
  try { window.webkit?.messageHandlers?.wizardNative?.postMessage({ type: 'mizel.state', ...detail }); } catch { /* not in a shell */ }
}
window.mizel = Object.freeze({
  version: 1,
  open: (id) => navigate(id || null),
  newMeeting: () => newMeeting(),
  stop: () => stopRecording(),
  state: () => ({ view: state.route.view, meetingId: state.route.id, recording: state.rec?.phase === 'recording', recordingMeetingId: state.rec?.meetingId || null }),
  setNativeRecorder: (on) => { document.documentElement.dataset.nativeRecorder = on ? '1' : ''; },
  onNativeEvent: (evt) => { if (evt?.type === 'level') updateLevel(evt); else if (evt?.type === 'stopped' && state.rec) void stopRecording(); },
});

// Wizard Back closes the current app layer before taking a shell step.
function appBack() {
  if (overlay?.askId && state.route.ask) { closeAskSheet(); return true; }
  if (closeOverlay() || closeMenu()) return true;
  if (state.drawerOpen) { closeDrawer(); return true; }
  if (state.route.view !== 'home') { goBack(); return true; }
  return false;
}
WizardApp.ready({ name: 'Mizel', version: '1' });
// Wizard's agent orb becomes Mizel's New recording button on the list (two-orb layout); our own button then hides.
var orbClaimed = null;
function syncAppOrb() {
  if (!WizardApp.orb) return;
  const want = els.app?.dataset.view !== 'meeting';
  if (want === orbClaimed) return; orbClaimed = want;
  const orbButton = { icon: 'plus', label: 'New recording' };
  const orbTap = () => { if (!els.btnNewMobile.disabled) newMeeting(); };
  if (want) WizardApp.orb.claim(orbButton, orbTap)
    .then((shown) => document.documentElement.classList.toggle('wizard-orb-claimed', shown === true), () => {});
  else void WizardApp.orb.release().then(() => document.documentElement.classList.remove('wizard-orb-claimed'));
}
const appCanGoBack = () => !!overlay || !!(els.docActions && $('.w-menu', els.docActions)) || state.drawerOpen || state.route.view !== 'home';
WizardApp.back.useHistory({ isRoot: () => !appCanGoBack() });
WizardApp.back.register({ canGoBack: appCanGoBack, back: appBack });
// Native Back uses the same domain callback; the shared client supplies the root policy.
window.wizardAppBack = () => { appBack(); return true; };
let notesUpdateHold = null;
function syncNotesUpdateHold() {
  const busy = state.notes.dirty || state.notes.saving || !!state.notes.conflict;
  if (busy && !notesUpdateHold) notesUpdateHold = WizardApp.update.hold('Mizel unsaved notes');
  if (!busy && notesUpdateHold) { notesUpdateHold.release(); notesUpdateHold = null; }
}

// ───────────────────────── 12. Boot ─────────────────────────
function bind() {
  Object.assign(els, {
    app: $('#app'), home: $('#home-panel'), doc: $('#doc'), docPane: $('#doc-pane'), docScroll: $('#doc-scroll'),
    upcoming: $('#upcoming'), meetings: $('#meetings'), btnNew: $('#btn-new'), btnNewMobile: $('#btn-new-mobile'), listFoot: $('#list-foot'), recBanner: $('#rec-banner'),
    title: $('#title'), eyebrow: $('#eyebrow'), meta: $('#meta'), docActions: $('#doc-actions'), docRoute: $('#doc-route'), topStatus: $('#top-status'), saved: $('#saved'), docStatus: $('#doc-status'), docToolbar: $('#doc-toolbar'),
    notepad: $('#notepad'), enhanced: $('#enhanced'), conflict: $('#conflict'), transcriptInline: $('#transcript-inline'), asks: $('#asks'),
    notesView: $('#notes-view'), notesActions: $('#notes-actions'),
    originalSummary: $('#original-live-summary'), originalSummaryBody: $('#original-summary-body'), liveConnection: $('#live-connection'),
    askMeeting: $('#ask-meeting'), askMeetingInput: $('#ask-meeting-input'),
    drawer: $('#drawer'), segments: $('#segments'), summary: $('#summary'), drawerTabs: $('#drawer-tabs'), drawerCount: $('#drawer-count'), drawerPending: $('#drawer-pending'),
    pill: $('#pill'), live: $('#live'), archView: $('#arch-view'), archSection: $('#arch-section'), archEntry: $('#arch-entry'), askAll: $('#ask-all'), askAllMount: $('#ask-all-mount'), askAllThread: $('#ask-all-thread'), askAllForm: $('#ask-all-form'), askAllInput: $('#ask-all-input'),
    tip: $('#tip'), overlayRoot: $('#overlay-root'),
    homeDate: $('#home-date'), greeting: $('#greeting'), homeStats: $('#home-stats'), nextUp: $('#next-up'), askSuggest: $('#ask-suggest'),
  });
  if (!IS_MAC) document.querySelectorAll('[data-mod]').forEach((k) => { k.textContent = 'Ctrl K'; });

  els.btnNew.addEventListener('click', newMeeting);
  els.btnNewMobile.addEventListener('click', newMeeting);
  $('#search-open').addEventListener('click', () => openPalette());
  $('#btn-keys').addEventListener('click', openShortcuts);
  $('#btn-back').addEventListener('click', goBack);
  els.archEntry?.addEventListener('click', () => { location.hash = '#/archimedes'; });

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
  const onCite = (e) => { const ev = e.target.closest('.ev'); if (ev) showEvidence(ev.dataset.ref); };
  els.enhanced.addEventListener('click', onCite);
  els.asks.addEventListener('click', onCite);
  const hoverOk = matchMedia('(hover: hover)');
  document.addEventListener('mouseover', (e) => { if (!hoverOk.matches) return; const ev = e.target.closest?.('.ev'); if (ev) showTip(ev); });
  document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.ev')) hideTip(); });
  els.docScroll.addEventListener('scroll', hideTip, { passive: true });
  $('#drawer-close')?.addEventListener('click', closeDrawer);
  els.drawerTabs?.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setDrawerTab(b.dataset.tab); });

  els.askMeeting.addEventListener('submit', (e) => { e.preventDefault(); const q = els.askMeetingInput.value; els.askMeetingInput.value = ''; askMeeting(q); });
  els.askAllForm.addEventListener('submit', (e) => { e.preventDefault(); const q = els.askAllInput.value; els.askAllInput.value = ''; askAll(q); });

  els.recBanner.addEventListener('click', () => { if (state.rec) navigate(state.rec.meetingId); });

  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', () => applyRoute(parseHash()));
  mobileMQ.addEventListener('change', () => { placeAskAll(); renderPill(); });
  window.addEventListener('resize', debounce(autogrow, 100));
  window.addEventListener('online', () => { state.rec?.engine?.uploader?.wake?.(); flushNotes(); if (state.current) renderStatus(state.current); renderPillQueue(); });
  window.addEventListener('offline', () => { if (state.current) renderStatus(state.current); renderPillQueue(); });
  window.addEventListener('beforeunload', (e) => { if (state.rec && (state.rec.phase !== 'error' || state.rec.emptyStartProven !== true)) { e.preventDefault(); e.returnValue = ''; } else flushNotes(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { flushNotes(); refreshAll(); schedulePoll(); } });
  setInterval(() => { if (!document.hidden) { loadCalendar(); if (!state.rec) loadMeetings(); } }, 60000);

  renderSuggestions();
  try { state.askAll.thread = JSON.parse(sessionStorage.getItem('meetings.askAll') || '[]'); renderAskAll(); } catch { /* ignore */ }
}

function boot() {
  bind();
  // Guarantee a Home entry beneath any deep link so Android Back steps document → list, never out of the app.
  const route = parseHash();
  const initialHash = location.hash || '#/';
  history.replaceState({ mizelRoot: true }, '', '#/');
  if (route.view === 'meeting' || route.view === 'archimedes') history.pushState(null, '', initialHash);
  applyRoute(route);
  refreshAll();
  if (route.view !== 'archimedes') loadAllAsks();
  reattachShared();
}
boot();

// Self-update: when a newer Mizel ships, reload on return to the app, never mid-recording or with a sheet open.
let loadedBuild = null;
async function checkForUpdate() {
  try {
    const r = await fetch('live-health', { cache: 'no-store' }).then((x) => x.json());
    if (!r.build) return;
    if (!loadedBuild) { loadedBuild = r.build; return; }
    if (r.build !== loadedBuild && !state.rec && !overlay) location.reload();
  } catch { /* offline: try next time */ }
}
void checkForUpdate();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void checkForUpdate(); });
setInterval(() => { if (document.visibilityState === 'visible') void checkForUpdate(); }, 120000);
