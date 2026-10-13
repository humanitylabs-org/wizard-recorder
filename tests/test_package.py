import asyncio
import importlib
import io
import os
from pathlib import Path
import sys
import wave
import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))


def wav_bytes(sample=0):
    b = io.BytesIO()
    with wave.open(b, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(int(sample).to_bytes(2, 'little', signed=True) * 16000)
    return b.getvalue()


def run_test(tmp_path, fn):
    os.environ['MEETINGS_DATA'] = str(tmp_path)
    os.environ['TRANSCRIPTION_URL'] = 'http://fixture/v1/audio/transcriptions'
    for n in ('MEETINGS_LLM_URL','MEETINGS_LLM_MODEL','MEETINGS_ALLOWED_HOSTS','MEETINGS_ALLOWED_ORIGINS'):
        os.environ.pop(n, None)
    if 'server' in sys.modules:
        s = importlib.reload(sys.modules['server'])
    else:
        s = importlib.import_module('server')
    s.store = s.Store(tmp_path)
    async def test():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=s.app), base_url='http://127.0.0.1:8080') as c:
            await fn(s,c)
    asyncio.run(test())


def test_empty_and_scope(tmp_path):
    async def test(s,c):
        assert (await c.get('/healthz')).json()['app']=='meeting-recorder'
        assert (await c.get('/api/meetings')).json()=={'meetings':[]}
        assert (await c.get('/api/calendar')).json()['events']==[]
        assert (await c.get('/api/meetings?limit=-1')).status_code==400
        assert (await c.get('/healthz', headers={'Host':'evil.example'})).status_code==403
        assert (await c.post('/api/meetings', json={}, headers={'Origin':'https://evil.example'})).status_code==403
        assert (await c.post('/api/meetings', json={}, headers={'Sec-Fetch-Site':'cross-site'})).status_code==403
        assert (await c.post('/api/ask',json={'question':'hello'})).status_code==503
        assert not (tmp_path/'.hermes').exists()
    run_test(tmp_path,test)


def test_chunks_notes_and_stop(tmp_path):
    async def test(s,c):
        m=(await c.post('/api/meetings',json={'title':'Fixture meeting'})).json(); mid=m['id']
        endpoint=f'/api/meetings/{mid}'
        r=await c.put(endpoint+'/notes',json={'notes':'Decide on Friday','base_rev':0}); assert r.status_code==200
        assert (await c.put(endpoint+'/notes',json={'notes':'overwrite','base_rev':0})).status_code==409
        for _ in range(2):
            assert (await c.post(endpoint+'/chunks?source=me&seq=0&start_ms=0',content=wav_bytes())).status_code==200
        assert (await c.post(endpoint+'/chunks?source=me&seq=0&start_ms=0',content=wav_bytes(200))).status_code==409
        assert (await c.post(endpoint+'/chunks?source=bad&seq=1&start_ms=1000',content=wav_bytes())).status_code==400
        assert (await c.get(endpoint+'/audio.wav')).content[:4]==b'RIFF'
        assert (await c.post(endpoint+'/stop',json={'final_seq':{'me':0}})).status_code==200
        assert (await c.post(endpoint+'/stop',json={})).status_code==200
        assert (await c.get('/api/meetings?q=Friday')).json()['meetings'][0]['id']==mid
        with s.db() as db:
            assert db.execute('SELECT COUNT(*) FROM chunks').fetchone()[0]==1
    run_test(tmp_path,test)


def test_mcp_tools(tmp_path):
    async def test(s,c):
        async def rpc(method,params=None):
            return (await c.post('/mcp',json={'jsonrpc':'2.0','id':1,'method':method,'params':params or {}})).json()
        tools=(await rpc('tools/list'))['result']['tools']
        assert {t['name'] for t in tools}=={'list_meetings','get_meeting','search_meetings','start_recording','stop_recording','get_transcript'}
        assert (await c.post('/mcp',json={'jsonrpc':'2.0','method':'notifications/initialized'})).status_code==202
        assert (await c.post('/mcp',content='{}',headers={'Content-Type':'text/plain'})).status_code==415
        assert (await rpc('tools/call',{'name':'list_meetings','arguments':{'limit':True}}))['error']['code']==-32602
        assert (await rpc('tools/call',{'name':'get_meeting','arguments':{'id':'../secret'}}))['error']['code']==-32602
        m=(await rpc('tools/call',{'name':'start_recording','arguments':{'title':'MCP meeting'}}))['result']['structuredContent']
        assert m['capture']=='awaiting_device'
        await rpc('tools/call',{'name':'stop_recording','arguments':{'id':m['id']}})
        value=(await rpc('tools/call',{'name':'get_transcript','arguments':{'id':m['id']}}))['result']
        assert value['structuredContent']['text']=='' and not value['isError']
        assert (await rpc('tools/call',{'name':'get_meeting','arguments':{'id':'missing-id'}}))['result']['isError']
    run_test(tmp_path,test)


def test_transcription_contract_and_errors(tmp_path):
    async def test(s,c):
        seen=[]
        def handler(req):
            seen.append(req.content)
            return httpx.Response(200,json={'text':'fixture-only result'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as stt:
            assert await s.stt(stt,wav_bytes())=='fixture-only result'
            assert b'name="model"' in seen[0] and b'Systran/faster-whisper-small' in seen[0]
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:httpx.Response(422,json={'detail':'invalid model'}))) as stt:
            with pytest.raises(httpx.HTTPStatusError): await s.stt(stt,wav_bytes())
        assert (await c.post('/api/uploads',content=b'not audio')).status_code==415
        assert (await c.get('/api/meetings')).json()['meetings']==[]
    run_test(tmp_path,test)
