// Meeting-side projection only. This module NEVER submits a Wizard message/run.
import fs from 'node:fs';
import path from 'node:path';
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v);
const messageId = v => id(v) || (Number.isSafeInteger(v)&&v>=0);
function audioReferences(message) {
  const text=typeof message.content==='string'?message.content:JSON.stringify(message.content||'');
  const match=/\[WIZARD_FILES_V1\]\s*(\[[\s\S]*?\])\s*\[\/WIZARD_FILES_V1\]/.exec(text);
  try{return match?JSON.parse(match[1]).map(f=>f.id):[];}catch{return [];}
}
const statuses = ['paused','captured','queued','failed','unconfirmed','sent','cancelled','local'];
export class OrbEvents {
  constructor(file) {
    this.file=file; this.rows={}; this.refreshing=false;
    if(fs.existsSync(file)) this.rows=JSON.parse(fs.readFileSync(file,'utf8')); // corruption must not erase history
  }
  save(rows) {
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const tmp=this.file+'.tmp', fd=fs.openSync(tmp,'w',0o600);
    try {fs.writeFileSync(fd,JSON.stringify(rows));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(tmp,this.file);
    const dir=fs.openSync(path.dirname(this.file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    this.rows=rows;
  }
  upsert(value) {
    if(!value || !id(value.id)||!id(value.meetingId)||!id(value.captureId)||!Number.isFinite(value.atMediaMs)||value.atMediaMs<0||!Number.isSafeInteger(value.clientRevision)||value.clientRevision<1||!statuses.includes(value.status)) throw Error('Invalid orb event');
    const old=this.rows[value.id];
    for(const key of ['meetingId','captureId','atMediaMs','voiceTakeId','deliveryKey','threadId','runId','audioFileId','agent']) if(old?.[key]!=null && value[key]!=null && old[key]!==value[key]) throw Error('Orb event identity conflict: '+key);
    if(old && value.clientRevision<=old.clientRevision) return old;
    const row={...(old||{}),id:value.id,meetingId:value.meetingId,captureId:value.captureId,atMediaMs:value.atMediaMs,clientRevision:value.clientRevision,revision:(old?.revision||0)+1};
    for(const key of ['voiceTakeId','deliveryKey','threadId','runId','audioFileId']) if(value[key]!=null){if(!id(value[key]))throw Error('Invalid '+key);row[key]=value[key];}
    // Caller IDs are hints, never proof of an accepted message. Only refresh binds them.
    if(value.userMessageId!=null && !messageId(value.userMessageId))throw Error('Invalid message id');
    if(value.agent!=null){if(value.agent!==''&&!id(value.agent))throw Error('Invalid agent');row.agent=value.agent;}
    row.steered=value.steered===true;
    for(const key of ['pausedAt','endedAt']) if(value[key]!=null){if(!Number.isSafeInteger(value[key])||value[key]<0)throw Error('Invalid '+key);row[key]=value[key];}
    row.pausedByHandoff=value.pausedByHandoff===true;
    row.question=typeof value.question==='string'?value.question.slice(0,64000):old?.question||'';
    row.status=old?.status==='answered'?'answered':value.status;
    if(old?.status==='cancelled' && row.status!=='cancelled')throw Error('Cancelled event cannot be sent');
    row.updatedAt=new Date().toISOString();
    this.save({...this.rows,[row.id]:row});return row;
  }
  list(mid) {return Object.values(this.rows).filter(r=>r.meetingId===mid).sort((a,b)=>a.atMediaMs-b.atMediaMs||a.id.localeCompare(b.id));}
  async refresh(readRun, readMessages, verifyDelivery) {
    if(this.refreshing)return;this.refreshing=true;
    try {for(const row of Object.values(this.rows)) {
      if(!row.runId||!row.threadId||!row.deliveryKey||row.status==='cancelled'||row.steered)continue;
      try {
        // Verify against server-owned admission, before reading selected thread history.
        // A steer flag cannot authorize projection of another request's response.
        if(verifyDelivery && !(await verifyDelivery(row)))continue;
        const run=await readRun(row.runId,row);
        if((run.session_id||run.sessionId)!==row.threadId)continue;
        if(!verifyDelivery && run.idempotency_key!==row.deliveryKey)continue;
        if(run.idempotency_key && run.idempotency_key!==row.deliveryKey)continue;
        if(!row.userMessageId && row.audioFileId && readMessages){
          const messages=await readMessages(row);
          if(this.rows[row.id].clientRevision!==row.clientRevision)continue;
          const matches=messages.complete===false?[]:messages.filter(m=>m.role==='user'&&audioReferences(m).includes(row.audioFileId));
          if(matches.length===1&&messageId(matches[0].id??matches[0].message_id)){
            const current=this.rows[row.id];this.save({...this.rows,[row.id]:{...current,userMessageId:matches[0].id??matches[0].message_id,revision:current.revision+1}});
          }
        }
        if(row.status==='answered'||row.runTerminal)continue;

        if(!['completed','failed','cancelled','interrupted'].includes(run.status))continue;
        const current=this.rows[row.id];
        if(current.clientRevision!==row.clientRevision || current.status==='cancelled')continue;
        const update={...current,revision:current.revision+1,runTerminal:true,updatedAt:new Date().toISOString(),status:run.status==='completed'?'answered':'failed',answer:run.status==='completed'?String(run.output||'').slice(0,12000):'',error:run.status==='completed'?'':'Existing run ended '+run.status};
        if(messageId(run.user_message_id))update.userMessageId=run.user_message_id;
        if(messageId(run.answer_message_id))update.answerMessageId=run.answer_message_id;
        this.save({...this.rows,[row.id]:update});
      }catch{/* offline: persisted pending link remains retryable after restart */}
    }}finally{this.refreshing=false;}
  }
}
export function discussionMarkdown(rows) {
  const linked=rows.filter(r=>!['cancelled','local','paused'].includes(r.status));
  if(!linked.length)return '';
  const plain=s=>String(s||'').replace(/[\\`*_{}\[\]<>#]/g,'\\$&');
  return '\n\n## Archimedes discussions\n\nAssistant material — not meeting speech or agreed decisions.\n'+linked.map(r=>`\n### ${Math.floor(r.atMediaMs/60000)}:${String(Math.floor(r.atMediaMs/1000)%60).padStart(2,'0')} · ${r.status}\n\n${plain(r.question)||'Question pending transcription'}\n\n${r.threadId?`[Continue in Wizard](/wizard/?session=${encodeURIComponent(r.threadId)})`:'Delivery pending'}${r.answer?'\n\nAssistant answer: '+plain(r.answer):''}\n`).join('');
}
