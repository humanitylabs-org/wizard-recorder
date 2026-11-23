// The Recorder's Ready extension (ready/shell.js) sends due Private-agent meetings from the shell (issue 29).
// Pure: fetch, document and timers are fixtures; the module is the exact served file.
import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let due = [], failRun = false, claimStatus = 200;
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ u: u.replace(/^.*?(live\/|\/wizard\/hermes)/, '$1'), method: opts.method || 'GET', body, headers: opts.headers || {} });
  if (u.endsWith('live/deliveries/due')) return json(200, { due });
  if (u.endsWith('live/deliveries/claim')) return claimStatus === 200 ? json(200, { sendId: 'send_1', agent: body.agent, title: 'Recorder · Weekly sync → Private agent', text: 'transcript' }) : json(claimStatus, { error: 'Another device is sending it' });
  if (u.endsWith('live/deliveries/result')) { due = due.filter((d) => d.meetingId !== 'mt_a' || body.error); return json(200, { send: { status: body.error ? 'failed' : 'sent' } }); }
  if (u.includes('/wizard/hermes/api/sessions')) return json(200, {});
  if (u.includes('/wizard/hermes/v1/runs')) return failRun ? json(503, { error: { message: 'Private agent is down' } }) : json(200, { run_id: 'run_1' });
  return json(404, {});
};
const listeners = {};
globalThis.document = { visibilityState: 'visible', addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; } };
const timers = [];
const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
globalThis.clearInterval = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };

const mod = await import('../ready/shell.js');
const settle = () => new Promise((r) => setTimeout(r, 20));
const host = { installed: () => true, changed() {}, toast() {}, open() {}, authorize: () => false };

test('declares the Ready extension contract and draws nothing itself', () => {
  assert.equal(mod.contract, 'wizard.ready-extension/1');
  const x = mod.default(host);
  for (const k of ['html', 'write', 'poll', 'handle', 'dispose']) assert.equal(typeof x[k], 'function');
  assert.equal(x.html(), '');
  assert.equal(x.handle({ target: {} }), false);
  x.dispose();
});

test('a due meeting is claimed, sent through /wizard/hermes to its agent, and reported', async () => {
  calls.length = 0; due = [{ meetingId: 'mt_a', agent: 'private', at: new Date().toISOString(), failedAt: null, sending: false }];
  const x = mod.default(host);
  assert.equal(timers.at(-1).ms, 30000, 'it keeps checking every 30 s while the shell is open');
  x.poll(); await settle();
  const seq = calls.map((c) => `${c.method} ${c.u.split('?')[0]}`);
  assert.deepEqual(seq, ['GET live/deliveries/due', 'POST live/deliveries/claim', 'POST /wizard/hermes/api/sessions', 'POST /wizard/hermes/v1/runs', 'POST live/deliveries/result']);
  const [session, run] = [calls[2], calls[3]];
  assert.match(session.u, /\?agent=private$/); assert.equal(session.body.agent, 'private');
  assert.equal(run.body.session_id, session.body.id); assert.equal(run.headers['Idempotency-Key'], 'send_1');
  assert.equal(calls[4].body.threadId, session.body.id);
  x.dispose(); assert.ok(timers.at(-1).cleared, 'dispose stops it');
});

test('a failed run is reported, and the next automatic try waits; another device sending is left alone', async () => {
  calls.length = 0; failRun = true; due = [{ meetingId: 'mt_b', agent: 'private', at: new Date().toISOString(), failedAt: null, sending: false }];
  const x = mod.default(host);
  x.poll(); await settle();
  const result = calls.find((c) => c.u.endsWith('deliveries/result'));
  assert.match(result.body.error, /Private agent is down/);
  calls.length = 0; failRun = false;
  due = [{ meetingId: 'mt_b', agent: 'private', at: new Date().toISOString(), failedAt: new Date().toISOString(), sending: false },
    { meetingId: 'mt_c', agent: 'private', at: new Date().toISOString(), failedAt: null, sending: true }];
  timers.at(-1).fn(); await settle();
  assert.deepEqual(calls.map((c) => c.u), ['live/deliveries/due'], 'recent failure and a held lease: no claim');
  calls.length = 0; due[0].failedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  listeners.visibilitychange(); await settle();
  assert.ok(calls.some((c) => c.u.endsWith('deliveries/claim') && c.body.meetingId === 'mt_b'), 'retried after 5 minutes');
  x.dispose();
});

test('a lost race (409) or an uninstalled app sends nothing more', async () => {
  calls.length = 0; claimStatus = 409; due = [{ meetingId: 'mt_d', agent: 'private', at: new Date().toISOString(), failedAt: null, sending: false }];
  const x = mod.default(host);
  x.poll(); await settle();
  assert.ok(!calls.some((c) => c.u.includes('/wizard/hermes')), 'no thread is opened when another device has it');
  x.dispose(); claimStatus = 200;
  calls.length = 0;
  const y = mod.default({ ...host, installed: () => false });
  y.poll(); await settle();
  assert.equal(calls.length, 0);
  y.dispose();
  globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval;
});
