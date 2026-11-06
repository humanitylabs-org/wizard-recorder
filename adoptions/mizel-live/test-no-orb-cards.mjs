import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
// James, 6 Nov 2026: orb voice notes during a recording must not appear as "Asked Archimedes" cards in the meeting.
test('meeting view shows no orb voice-note cards in transcript or summaries',()=>{
  const s=fs.readFileSync(new URL('./web/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(s,/setInterval\(loadDiscussions/);
  assert.match(s,/transcriptTimeline\(segs,\[\]\)/);
  assert.match(s,/function discussionSection\(id\) \{\n  return null;/);
});
