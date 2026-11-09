import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
test('meetings never ask for computer audio at start', () => {
  assert(!/systemAudio:\s*prefs/.test(app), 'start/prewarm must not read a saved computer-audio preference');
  assert(!app.includes('prefs.systemAudio'), 'no saved computer-audio preference');
  assert(!html.includes('sys-audio'), 'no sidebar computer-audio switch');
  assert(/addSystemAudio\(\)/.test(app), 'opt-in Them button stays');
  assert(app.includes("removeItem('meetings.systemAudio')"), 'stale saved preference is cleared');
});
