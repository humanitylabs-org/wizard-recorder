"""Portable app invariants; synthetic data only."""
import asyncio
import json
import sqlite3
from pathlib import Path
import pytest
from test_package import run_test, wav_bytes
from migrate_data import migrate, resolve_audio


def test_standalone_without_any_optional_service(tmp_path, monkeypatch):
    for key in ('WIZARD_ROUTER_URL','WIZARD_ROUTER_GRANT','WIZARD_DELIVERY_URL','WIZARD_DELIVERY_TOKEN'):
        monkeypatch.delenv(key, raising=False)
    async def test(s,c):
        assert not s.model_configured()
        mid=(await c.post('/api/meetings',json={'title':'Standalone'})).json()['id']
        assert (await c.post(f'/api/meetings/{mid}/enhance',json={})).status_code==503
        assert (await c.post(f'/api/meetings/{mid}/send',json={})).status_code==503
        assert (await c.get('/api/live-summary',params={'meetingId':mid})).json()['configured'] is False
        assert (await c.get('/api/agent-delivery')).json()=={'configured':False,'delivered':0,'waiting':0,'last_error':''}
        assert (await c.put(f'/api/meetings/{mid}/notes',json={'notes':'Portable fixture note','base_rev':0})).status_code==200
        assert (await c.get('/api/meetings?q=Portable')).json()['meetings'][0]['id']==mid
        assert 'Portable fixture note' in (await c.get(f'/api/meetings/{mid}/export.md')).text
        assert not (tmp_path/'agent-outbox').exists()
        assert not (tmp_path/'outlines').exists()
    run_test(tmp_path,test)


def test_old_absolute_paths_dry_run_backup_and_playback(tmp_path):
    async def test(s,c):
        mid=(await c.post('/api/meetings',json={'title':'Migration fixture'})).json()['id']
        await c.post(f'/api/meetings/{mid}/chunks?source=me&seq=0&start_ms=0',content=wav_bytes(500))
        with s.db() as db:
            original=db.execute('SELECT path FROM chunks').fetchone()[0]
            relative=Path(original).relative_to(tmp_path)
            legacy='/legacy-owner/apps/recordings/'+str(relative)
            db.execute('UPDATE chunks SET path=?',(legacy,))
        assert migrate(tmp_path)['changed_paths']==1
        with sqlite3.connect(tmp_path/'meetings.db') as db:
            assert db.execute('SELECT path FROM chunks').fetchone()[0]==legacy
        # Runtime resolver also works before the offline rewrite.
        assert resolve_audio(tmp_path,legacy).read_bytes()==wav_bytes(500)
        assert (await c.get(f'/api/meetings/{mid}/audio.wav')).content==wav_bytes(500)
        assert migrate(tmp_path,True)['changed_paths']==1
        assert (tmp_path/'pre-recorder-migration.db').is_file()
        assert migrate(tmp_path,True)['changed_paths']==0
        with s.db() as db:
            assert db.execute('SELECT path FROM chunks').fetchone()[0]==str(relative)
        assert (await c.get(f'/api/meetings/{mid}/audio.wav')).content==wav_bytes(500)
    run_test(tmp_path,test)


def test_audio_paths_cannot_escape_data(tmp_path):
    with pytest.raises(ValueError):
        resolve_audio(tmp_path,'audio/../../outside.wav')
    (tmp_path/'audio').mkdir()
    (tmp_path/'audio'/'escape.wav').symlink_to(tmp_path.parent/'outside.wav')
    with pytest.raises(ValueError):
        resolve_audio(tmp_path,'audio/escape.wav')
    with pytest.raises(ValueError):
        resolve_audio(tmp_path,'/etc/passwd')


def test_router_stream_requires_completion_and_never_falls_back(monkeypatch):
    import model_client as m
    import httpx
    monkeypatch.setenv('WIZARD_ROUTER_URL','http://router')
    monkeypatch.setenv('WIZARD_ROUTER_GRANT','fixture-grant')
    calls=[]
    def handle(req):
        calls.append(str(req.url))
        assert req.headers['X-Wizard-Grant']=='fixture-grant'
        assert json.loads(req.content)['stream'] is True
        return httpx.Response(200,headers={'Content-Type':'text/event-stream'},text='data: {"type":"delta","text":"provisional"}\n\n')
    real=httpx.AsyncClient
    monkeypatch.setattr(m.httpx,'AsyncClient',lambda **kw:real(transport=httpx.MockTransport(handle),**kw))
    with pytest.raises(RuntimeError,match='provenance'):
        asyncio.run(m.model_run([{'role':'user','content':'fixture'}]))
    assert calls==['http://router/v1/models/recap/run']


@pytest.mark.parametrize('failure', ['truncated', 'error', 'bad-provenance', 'bad-chosen', 'after-done', 'not-sse', 'redirect'])
def test_recap_router_rejects_unvalidated_streams(monkeypatch, failure):
    import model_client as m
    import httpx
    monkeypatch.setenv('WIZARD_ROUTER_URL', 'http://router')
    monkeypatch.setenv('WIZARD_ROUTER_GRANT', 'fixture-grant')
    done = {'type': 'done', 'provider': 'private-fixture', 'model': 'fixture',
            'tier': 'standard', 'tested_on': 'deepseek-v4-1-flash', 'chosen': 'owner-swap', 'usage': {}}
    def handle(req):
        assert req.headers['X-Wizard-Grant'] == 'fixture-grant'
        body = json.loads(req.content)
        assert body == {'system': 'Fixture system', 'messages': [{'role': 'user', 'content': 'Fixture'}],
                        'max_tokens': 3000, 'stream': True}
        text = 'event: delta\ndata: {"text":"Untrusted draft"}\n\n'
        if failure == 'redirect':
            return httpx.Response(307, headers={'Location': 'http://not-router'})
        if failure == 'error':
            text += 'event: error\ndata: {"type":"error","code":"signed_out"}\n\n'
        elif failure == 'bad-provenance':
            text += 'event: done\ndata: {"type":"done","provider":"fixture","model":"fixture"}\n\n'
        elif failure == 'bad-chosen':
            text += 'event: done\ndata: ' + json.dumps({**done, 'chosen': True}) + '\n\n'
        elif failure in ('after-done', 'not-sse'):
            text += 'event: done\ndata: ' + json.dumps(done) + '\n\n'
            if failure == 'after-done':
                text += 'event: delta\ndata: {"text":"Extra"}\n\n'
        return httpx.Response(200, headers={'Content-Type': 'application/json' if failure == 'not-sse' else 'text/event-stream'}, text=text)
    real = httpx.AsyncClient
    monkeypatch.setattr(m.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(handle), **kw))
    with pytest.raises((RuntimeError, httpx.HTTPStatusError)):
        asyncio.run(m.model_run([{'role': 'system', 'content': 'Fixture system'}, {'role': 'user', 'content': 'Fixture'}]))


def test_model_needs_require_both_router_fields(monkeypatch):
    import model_client as m
    monkeypatch.delenv('WIZARD_ROUTER_URL', raising=False)
    monkeypatch.setenv('WIZARD_ROUTER_GRANT', 'fixture-grant')
    assert not m.model_configured()
    with pytest.raises(RuntimeError, match='required'):
        asyncio.run(m.model_run([]))
    monkeypatch.setenv('WIZARD_ROUTER_URL', 'http://router')
    assert m.model_configured()
    monkeypatch.delenv('WIZARD_ROUTER_GRANT')
    assert not m.model_configured()
