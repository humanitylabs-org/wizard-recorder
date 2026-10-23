"""Optional app-bound delivery and private live outline, independent of capture."""
import asyncio
from contextlib import closing
import hashlib
import json
from pathlib import Path
from fastapi import HTTPException
from agent_delivery import Outbox, configured
from model_client import model_configured, model_run


def install_optional(app):
    outline_jobs = set()
    delivery_lock = asyncio.Lock()

    async def flush():
        import server as s
        async with delivery_lock:
            await Outbox(s.DATA).flush()

    async def build_outline(mid):
        import server as s
        file = s.DATA / 'outlines' / (mid+'.json')
        try:
            with closing(s.db()) as c:
                m = s.meeting_detail(c,mid)
            outline = json.loads(file.read_text()) if file.exists() else {'topics':[], 'summarizedToMs':0}
            fresh = [x for x in m['segments'] if x['end_ms'] > outline['summarizedToMs']][:40]
            if not fresh:
                return
            text = await model_run([
                {'role':'system','content':'Maintain an append-only live recording outline. Return JSON only: {"title":string,"bullets":[{"text":string,"atMs":integer}]}. Exclude filler and requests addressed to the assistant. Each atMs must equal a transcript start_ms. Do not infer decisions or names.'},
                {'role':'user','content':json.dumps({'existing':outline['topics'][-3:],'transcript':fresh})}],feature='live-summary',max_tokens=2000)
            data = json.loads(text.removeprefix('```json').removeprefix('```').removesuffix('```').strip())
            allowed = {x['start_ms'] for x in fresh}
            bullets = [{'id':f"{mid}-{fresh[0]['start_ms']}-{i}", 'text':str(b['text'])[:2000], 'atMs':b['atMs']}
                       for i,b in enumerate(data.get('bullets',[])[:24]) if b.get('atMs') in allowed and str(b.get('text','')).strip()]
            if bullets:
                outline['topics'].append({'id':f"{mid}-{fresh[0]['start_ms']}", 'title':str(data.get('title','Recording'))[:160],
                                          'bullets':bullets,'startMs':fresh[0]['start_ms'],'active':m['status']=='recording'})
            outline['summarizedToMs']=max(x['end_ms'] for x in fresh)
            outline['updatedAt']=s.now_iso()
            file.parent.mkdir(exist_ok=True)
            tmp=file.with_suffix('.tmp'); tmp.write_text(json.dumps(outline)); tmp.replace(file)
        except Exception as e:
            s.log.warning('Live summary unavailable: %s',type(e).__name__)
        finally:
            outline_jobs.discard(mid)

    @app.get('/api/live-summary')
    async def live_summary(meetingId: str):
        import server as s
        mid=s._mid(meetingId)
        with closing(s.db()) as c:
            m=s.meeting_detail(c,mid)
        if not model_configured():
            return {'summary':None,'building':False,'configured':False}
        file=s.DATA/'outlines'/(mid+'.json')
        summary=json.loads(file.read_text()) if file.exists() else None
        if m['segments'] and m['segments'][-1]['end_ms'] > (summary or {}).get('summarizedToMs',0) and mid not in outline_jobs:
            outline_jobs.add(mid);s.start_bg(build_outline(mid))
        return {'summary':summary,'building':mid in outline_jobs,'configured':True}

    @app.get('/api/agent-delivery')
    async def delivery_status():
        import server as s
        return Outbox(s.DATA).status()

    @app.post('/api/meetings/{mid}/send')
    async def send_recording(mid: str):
        import server as s
        if not configured()[0]:
            raise HTTPException(503,'App agent binding is not configured')
        with closing(s.db()) as c:
            m=s.meeting_detail(c,s._mid(mid))
        if m['status']!='ready':
            raise HTTPException(409,'Wait for transcription to finish')
        body='# '+m['title']+'\n\n'+m.get('notes','')+'\n\n## Transcript\n\n'+'\n'.join(x['text'] for x in m['segments'])
        edition=hashlib.sha256(body.encode()).hexdigest()[:16]
        Outbox(s.DATA).queue(mid,m['title'],body,edition)
        await flush()
        return Outbox(s.DATA).status()

    async def retry_deliveries():
        import server as s
        while not s._stop.is_set():
            if configured()[0]:
                await flush()
            try:
                await asyncio.wait_for(s._stop.wait(),60)
            except asyncio.TimeoutError:
                pass
    @app.on_event('startup')
    async def startup_optional():
        import server as s
        s.start_bg(retry_deliveries())
