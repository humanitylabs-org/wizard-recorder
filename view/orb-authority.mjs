// Optional private-host authority adapter. Reads the issuing service's admission
// ledger in read-only mode; never exposes a request body or writes runtime state.
export async function queueAuthority(file) {
  if (!file) return null;
  const {DatabaseSync} = await import('node:sqlite');
  return async row => {
    if (row.steered || !row.deliveryKey || !row.runId || !row.threadId) return false;
    const db = new DatabaseSync(file, {readOnly:true});
    try {
      const entry = db.prepare('SELECT body FROM wizard_run_queue WHERE public_run_id=? AND session_id=? AND idempotency_key=? AND runtime=?').get(row.runId,row.threadId,row.deliveryKey,'direct');
      if (!entry) return false;
      const request = JSON.parse(entry.body);
      return request.session_id === row.threadId && (request.agent || '') === (row.agent || '');
    } finally { db.close(); }
  };
}

// Keep accumulated rows at the bounded limit, but mark partial scans so a
// seemingly unique audio reference cannot be accepted as exhaustive evidence.
export async function threadMessages(readPage, row, cap=2000) {
  const rows=[];
  for (let offset=0; offset<cap; offset+=200) {
    const page=await readPage(`/api/sessions/${encodeURIComponent(row.threadId)}/messages?limit=200&offset=${offset}&order=latest`,row);
    rows.push(...(page.data||page.messages||[]));
    const more=page.pagination?.has_more ?? page.has_more;
    if (more === false) { rows.complete=true; return rows; }
    if (more == null) { rows.complete=false; return rows; }
  }
  rows.complete=false; return rows;
}
