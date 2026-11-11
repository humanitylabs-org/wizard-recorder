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


def run_test(tmp_path, fn, env=None):
    os.environ['MEETINGS_DATA'] = str(tmp_path)
    os.environ['TRANSCRIPTION_URL'] = 'http://fixture/v1/audio/transcriptions'
    for n in ('MEETINGS_LLM_URL','MEETINGS_LLM_MODEL','MEETINGS_ALLOWED_HOSTS','MEETINGS_ALLOWED_ORIGINS','MEETINGS_OWNER_NAME'):
        os.environ.pop(n, None)
    os.environ.update(env or {})
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
        assert (await c.get('/healthz')).json()['app']=='mizel'
        assert (await c.get('/api/meetings')).json()=={'meetings':[]}
        assert (await c.get('/api/calendar')).json()['events']==[]
        assert (await c.get('/api/meetings?limit=-1')).status_code==400
        # Blank host allowlist trusts the owner-authenticated ingress; same-host browser origins work.
        assert (await c.get('/healthz', headers={'Host':'wizard.example'})).status_code==200
        assert (await c.post('/api/meetings', json={}, headers={'Host':'wizard.example','Origin':'https://wizard.example'})).status_code==200
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
        assert (await c.post(endpoint+'/chunks?source=me&seq=0&start_ms=0',content=wav_bytes(200))).status_code==200
        assert (await c.post(endpoint+'/chunks?source=bad&seq=1&start_ms=1000',content=wav_bytes())).status_code==400
        assert (await c.post(endpoint+'/chunks?source=me&seq=-1&start_ms=0',content=wav_bytes())).status_code==400
        assert (await c.post(endpoint+'/chunks?source=me&seq=1&start_ms=999999999999',content=wav_bytes())).status_code==400
        assert (await c.post(endpoint+'/chunks?source=me&seq=1&start_ms=1000',content=b'RIFF'+b'x'*8000001)).status_code==413
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
        assert not (await c.post('/api/meetings/'+m['id']+'/capture',json={})).json()['stop_requested']
        stopped=(await rpc('tools/call',{'name':'stop_recording','arguments':{'id':m['id']}}))['result']['structuredContent']
        assert stopped['capture']=='awaiting_device_ack'
        assert (await c.post('/api/meetings/'+m['id']+'/capture',json={})).json()['stop_requested']
        assert (await c.get('/api/meetings/'+m['id'])).json()['status']=='recording'
        await c.post('/api/meetings/'+m['id']+'/stop',json={})
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
            assert b'name="mode"' in seen[0] and b'meeting' in seen[0]
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:httpx.Response(422,json={'detail':'invalid model'}))) as stt:
            assert await s.stt(stt,wav_bytes()) == ''
        assert (await c.post('/api/uploads',content=b'not audio')).status_code==415
        assert (await c.get('/api/meetings')).json()['meetings']==[]
    run_test(tmp_path,test)


def test_recap_goes_to_bound_agent_and_waits_when_down(tmp_path, monkeypatch):
    import agent_delivery
    monkeypatch.setenv('WIZARD_DELIVERY_URL', 'http://wizard/wizard/v1/apps/mizel/deliveries')
    monkeypatch.setenv('WIZARD_DELIVERY_TOKEN', 'app-token-0123456789abcdefghijkl')
    seen, up = [], {'ok': False}
    def handler(request):
        seen.append((request.headers['authorization'], __import__('json').loads(request.content)))
        if not up['ok']:
            return httpx.Response(503, json={'error': 'bound_agent_unavailable', 'check': 'app.binding.agent_running'})
        return httpx.Response(200, json={'verified': True, 'already_delivered': False, 'session_id': 's', 'agent': {'id': 'x', 'label': 'Private'}})
    box = agent_delivery.Outbox(tmp_path)
    assert box.queue('m1', 'Team sync', '# Recap', 'e1')['delivery_key'] == 'meeting-m1-e1'
    box.queue('m1', 'Team sync', '# Recap', 'e1')   # same edition queued once
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            assert await box.flush(c) == 0
            assert box.status()['waiting'] == 1 and '503' in box.status()['last_error']
            up['ok'] = True
            assert await box.flush(c) == 1
            assert await box.flush(c) == 0
    asyncio.run(go())
    assert box.status() == {'configured': True, 'delivered': 1, 'waiting': 0, 'last_error': ''}
    auth, body = seen[-1]
    assert auth == 'Bearer app-token-0123456789abcdefghijkl'
    assert body['delivery_key'] == 'meeting-m1-e1' and body['thread'] == 'meeting-recaps' and 'agent' not in body
    monkeypatch.delenv('WIZARD_DELIVERY_URL')
    assert agent_delivery.Outbox(tmp_path / 'x').queue('m2', 't', 'b', 'e') is None   # standalone: nothing queued


def test_host_allowlist_when_configured(tmp_path):
    async def test(s,c):
        assert (await c.get('/healthz', headers={'Host':'evil.example'})).status_code==403
        assert (await c.get('/healthz', headers={'Host':'allowed.example:1'})).status_code==200
        assert (await c.get('/healthz')).status_code==200  # loopback host from the test client
        assert (await c.post('/api/meetings', json={}, headers={'Host':'allowed.example:1','Origin':'https://other.example'})).status_code==403
    run_test(tmp_path,test,{'MEETINGS_ALLOWED_HOSTS':'allowed.example:1'})


def test_owner_name_is_off_by_default_and_comes_from_install(tmp_path):
    async def test(s,c):
        sent=[]
        async def fake_llm(messages, **kw):
            sent.append(messages[0]['content'])
            return '# Fixture title\n## Action items\n- [ ] Owner — task'
        s.llm=fake_llm
        m=(await c.post('/api/meetings',json={'title':'Fixture'})).json()
        assert (await c.put(f"/api/meetings/{m['id']}/notes",json={'notes':'Plan','base_rev':0})).status_code==200
        os.environ.pop('MEETINGS_OWNER_NAME', None)
        assert s.owner_identity_prompt()==''
        await s.run_enhance(m['id'],'general')
        assert sent[-1]==s.ENHANCE_SYSTEM.format(sections=', '.join(s.TEMPLATES['general']))
        os.environ['MEETINGS_OWNER_NAME']='  Ada\nLovelace{} '
        try:
            assert s.owner_identity_prompt().startswith('\nThe recording owner is Ada Lovelace.')
            await s.run_enhance(m['id'],'general')
            assert sent[-1].endswith(s.owner_identity_prompt()) and "'Ada Lovelace' instead of 'Me'" in sent[-1]
            assert '{' not in s.owner_identity_prompt()
        finally:
            os.environ.pop('MEETINGS_OWNER_NAME', None)
    run_test(tmp_path,test)


def test_image_package_name_is_one_name_everywhere():
    # The old ghcr.io/humanitylabs-org/wizard-recorder package is held outside this repo's Actions
    # access (write_package denied), so every publish and install path uses the -app package.
    root = Path(__file__).resolve().parents[1]
    old = 'ghcr.io/humanitylabs-org/wizard-recorder'
    for name in ('runtipi/docker-compose.yml', 'scripts/release_images.py', 'scripts/check_release.py'):
        text = (root / name).read_text()
        assert 'ghcr.io/humanitylabs-org/wizard-recorder-app' in text, name
        assert old + ':' not in text and old + "'" not in text, name
    assert "repository='humanitylabs-org/wizard-recorder-app'" in (root / 'scripts/release_images.py').read_text()


def test_release_of_an_already_published_commit_only_adds_the_version_tag(tmp_path, monkeypatch):
    # A main push publishes sha-<commit>; the v* release of the same commit used to die on
    # "Refusing existing immutable image tag". It must reuse those images and only retag the version.
    import json, runpy, subprocess, urllib.error, urllib.request
    root = Path(__file__).resolve().parents[1]
    commit = 'a' * 40
    version = json.loads((root / 'runtipi/config.json').read_text())['version']
    stamp = root / '.source-commit'
    stamp.write_text(commit)
    published = {'sha-' + commit, 'sha-' + commit + '-amd64', 'sha-' + commit + '-arm64'}
    calls = []

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"token": "t"}'

    def urlopen(request, *a, **k):
        url = request.full_url if hasattr(request, 'full_url') else request
        if '/token' in url:
            return Resp()
        tag = url.rsplit('/manifests/', 1)[1]
        if tag in published:
            return Resp()
        raise urllib.error.HTTPError(url, 404, 'nf', {}, None)

    def run(cmd, *a, **k):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(urllib.request, 'urlopen', urlopen)
    monkeypatch.setattr(subprocess, 'run', run)
    monkeypatch.setenv('GITHUB_REF', 'refs/tags/v' + version)
    monkeypatch.setattr('sys.argv', ['release_images.py', '--commit', commit, '--output', str(tmp_path), '--push-ghcr', '--release-version', '--context', 'default', '--builder', 'default'])
    try:
        with pytest.raises(SystemExit) as done:
            runpy.run_path(str(root / 'scripts/release_images.py'), run_name='__main__')
    finally:
        stamp.unlink()
    assert done.value.code == 0
    assert len(calls) == 1 and 'imagetools' in calls[0] and 'create' in calls[0]
    assert 'ghcr.io/humanitylabs-org/wizard-recorder-app:' + version in calls[0]
    assert 'ghcr.io/humanitylabs-org/wizard-recorder-app:sha-' + commit in calls[0]
    assert not any('build' in c for c in calls)


def test_entry_hands_root_owned_data_to_uid_1000_then_serves_as_1000():
    # Release 0.2.2 crash-looped on a fresh box: Runtipi's bind-mounted data folder arrives root-owned and the
    # server (uid 1000, no capabilities) could not chmod it. start.py prepares /data as root and drops privileges.
    root = Path(__file__).resolve().parents[1]
    entry = (root / 'start.py').read_text()
    assert 'os.setuid(UID)' in entry and 'os.lchown' in entry and "'--port', '8080'" in entry
    compose = (root / 'runtipi/docker-compose.yml').read_text()
    assert 'user: 0:0' in compose and 'cap_drop: [ALL]' in compose
    assert 'cap_add: [CHOWN, DAC_READ_SEARCH, SETUID, SETGID]' in compose and 'no-new-privileges:true' in compose
    dockerfile = (root / 'Dockerfile').read_text()
    assert 'COPY start.py /app/start.py' in dockerfile and 'CMD ["python", "/app/start.py"]' in dockerfile
    assert '!start.py' in (root / '.dockerignore').read_text()
