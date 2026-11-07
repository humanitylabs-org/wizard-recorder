import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
// James, 6 Nov 2026: orb voice notes stay in the meeting, as a quiet aside that does not flicker on live re-renders.
const js=fs.readFileSync(new URL('./web/app.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('./web/styles.css',import.meta.url),'utf8');
test('orb notes are shown in the transcript and summaries',()=>{
  assert.match(js,/setInterval\(loadDiscussions,3000\)/);assert.match(js,/transcriptTimeline\(segs,events\)/);
  assert.doesNotMatch(js,/function discussionSection\(id\) \{\n  return null;/);
});
test('orb notes are a quiet aside without entry animation and keep an opened answer open',()=>{
  assert.match(js,/class:'ask-note'/);assert.doesNotMatch(js,/class:'qa orb-event'/);
  assert.match(css,/\.ask-note \{[^}]*animation: none/);
  assert.match(js,/openOrbAnswers\.has\(e\.id\)/);
  assert.doesNotMatch(js,/Question pending transcription/);
});
