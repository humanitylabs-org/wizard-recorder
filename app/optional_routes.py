"""Optional app-bound delivery and private live outline, independent of capture."""
import asyncio
from contextlib import closing
import hashlib
import json
from pathlib import Path
from fastapi import HTTPException
from agent_delivery import Outbox, configured
from model_client import model_configured


def install_optional(app):
    delivery_lock = asyncio.Lock()

    async def flush():
        import server as s
        async with delivery_lock:
            await Outbox(s.DATA).flush()

    @app.get('/api/live-summary')
    async def live_summary(meetingId: str):
        import server as s
        mid = s._mid(meetingId)
        with closing(s.db()) as c:
            s.meeting_detail(c, mid)
        file = s.DATA / 'outlines' / (mid + '.json')
        summary = json.loads(file.read_text()) if file.exists() else None
        return {'summary': summary, 'building': False, 'configured': model_configured()}

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
