import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { publicAgents, transcriptPacket, threadTitle, validAgentId, stamp } from './agent-router.mjs';

test('agents: main first and named from the install, bad ids and stopped agents dropped', () => {
  const list = publicAgents({ agents: [
    { id: 'quick', label: 'Quick', status: 'running' },
    { id: 'hermes', label: 'Hermes', status: 'running' },
    { id: 'Bad Id', label: 'x', status: 'running' },
    { id: 'old', label: 'Old', status: 'stopped' },
    { id: 'philosopher', label: 'Philosopher', status: 'running', privacy: 'private' },
  ] });
  assert.deepEqual(list.map((a) => a.id), ['hermes', 'philosopher', 'quick']);
  assert.equal(list[0].label, process.env.MIZEL_AGENT_NAME || 'Wizard');
  assert.equal(list[1].privacy, 'private');
});

test('the main agent name and time zone come from the install, never from code', () => {
  const probe = "import('./agent-router.mjs').then((m) => console.log(JSON.stringify([m.MAIN_AGENT_NAME, m.TIME_ZONE])))";
  const run = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe],
    { cwd: import.meta.dirname, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  assert.deepEqual(run({}), ['Wizard', 'UTC']);
  assert.deepEqual(run({ MIZEL_AGENT_NAME: 'Ada', MEETINGS_TIMEZONE: 'Europe/Lisbon' }), ['Ada', 'Europe/Lisbon']);
  assert.deepEqual(run({ MEETINGS_TIMEZONE: 'Not/AZone' }), ['Wizard', 'UTC']);
});

test('agent ids are strict', () => {
  assert.ok(validAgentId('archimedes-new'));
  assert.ok(!validAgentId('../hermes'));
  assert.ok(!validAgentId(''));
});

test('packet: note first, memory, notes, timestamped transcript', () => {
  const p = transcriptPacket({
    meeting: { enhanced: { markdown: '# Standup\n- Decided X' }, title: 'Standup', started_at: '2026-10-22T09:00:00+07:00', duration_ms: 600000, notes: 'Ship router', segments: [{ start_ms: 0, text: 'Hello' }, { start_ms: 65000, text: ' Next item ' }, { start_ms: 70000, text: '  ' }] },
    summary: { topics: [{ title: 'Plans', bullets: [{ text: 'Build router', atMs: 65000 }] }] },
    note: 'Pull out action items', agentLabel: 'Quick',
  });
  assert.ok(p.text.startsWith('Pull out action items'));
  assert.match(p.text, /# Standup/);
  assert.match(p.text, /- Build router \[01:05\]/);
  assert.match(p.text, /## Notes\n\nShip router/);
  assert.match(p.text, /## Summary \(Recorder\)\n\n- Decided X/);
  assert.match(p.text, /\[00:00\] Hello\n\[01:05\] Next item/);
  assert.equal(p.segments, 2);
  assert.equal(p.truncated, false);
});

test('packet: default instruction names the agent when no note', () => {
  const p = transcriptPacket({ meeting: { title: '', segments: [] }, summary: null, agentLabel: 'Philosopher' });
  assert.match(p.text, /\(Philosopher\)/);
  assert.match(p.text, /\(No transcript yet\.\)/);
});

test('title and stamp', () => {
  assert.equal(threadTitle('Standup', 'Quick'), 'Recorder · Standup → Quick');
  assert.ok(threadTitle('x'.repeat(200), 'Quick').length <= 90);
  assert.equal(stamp(3_725_000), '1:02:05');
});
