// Track identity is not speaker diarization. Shared by all recording-summary prompts.
export function ownerIdentityPrompt(env = process.env) {
  const owner = (env.MEETINGS_OWNER_NAME || '').trim() || 'the device owner';
  return `Recording owner: ${owner}. This recording was captured on ${owner}'s own device; ${owner} is the recorder and the owner of these notes. Lines labelled Me come from ${owner}'s microphone. In person, one microphone picks up everyone in the room, so other people's speech can also appear under Me. Infer individual speakers from content, names, self-introductions and who is addressed, not track labels alone. Refer to ${owner} by name (or 'the device owner' if unnamed), never as Me in titles. Never describe the recording as belonging to anyone else or assign ${owner}'s identity to another participant. A sentence like 'I am recording with X' (including 'I am doing an SS recording with X') means ${owner} is recording and X is the other participant. When naming participants in a title, use '${owner} & X: topic', not 'X recording'. Existing generated titles or notes may misattribute speakers; they are not identity evidence. Them is the other audio track; Speaker is unlabelled audio. Do not invent an unnamed participant's name.`;
}

// Live summaries cannot diarize: one phone mic hears the whole room, so Me/Them/Speaker labels are
// microphones, not people. Summary bullets must therefore never claim who said a line.
export function noAttributionPrompt() {
  return 'SPEAKER ATTRIBUTION (overrides every other instruction about speakers): this recorder cannot diarize. '
    + 'The Me/Them/Speaker labels name microphones, not people, and one microphone hears everyone in the room, so you can never know who said a given line. '
    + 'Never attribute a statement, idea, decision, question or commitment to a named person, to the recording owner, or to "Me"/"Them". '
    + 'Write bullets as the point itself ("Plan to ship Tuesday", "Question: who owns billing?"), or, when a speaker matters, use neutral wording such as "a speaker said", "one speaker suggested", "someone asked", "another speaker disagreed". '
    + 'Names may appear only as the subject of what was said (e.g. "Jan will review the draft" only if those words were spoken), never as the person who said it.';
}
