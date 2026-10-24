export function parseSummaryDelta(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid summary delta');
  const title = typeof parsed.title === 'string' ? parsed.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (!title) throw new Error('invalid summary delta');
  if (!Array.isArray(parsed.newBullets) || parsed.newBullets.length > 12) throw new Error('invalid summary delta');
  const newBullets = parsed.newBullets.map((bullet) => {
    if (!bullet || typeof bullet !== 'object' || Array.isArray(bullet)) throw new Error('invalid summary delta');
    if (typeof bullet.text !== 'string' || bullet.text.length > 2000 || !Number.isSafeInteger(bullet.atMs) || bullet.atMs < 0) {
      throw new Error('invalid summary delta');
    }
    return { text: bullet.text.replace(/\s+/g, ' ').trim().slice(0, 500), atMs: bullet.atMs };
  }).filter((bullet) => bullet.text);
  return { topicChanged: parsed.topicChanged === true, title, newBullets };
}
