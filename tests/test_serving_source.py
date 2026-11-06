"""Serving compatibility; synthetic endpoint and identity fixtures only."""
import asyncio
import json
import sys
from pathlib import Path
import httpx
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import model_client as model


def test_legacy_private_endpoint_preserves_reasoning_retry(monkeypatch):
    monkeypatch.delenv('WIZARD_ROUTER_URL',raising=False)
    monkeypatch.delenv('WIZARD_ROUTER_GRANT',raising=False)
    monkeypatch.setenv('MEETINGS_LLM_URL','http://fixture/chat/completions')
    monkeypatch.setenv('MEETINGS_LLM_KEY','synthetic')
    seen=[]
    def handle(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200,json={'choices':[{'message':{'content':'<think>fixture</think> Answer' if len(seen)==2 else ''}}]})
    real=httpx.AsyncClient
    monkeypatch.setattr(model.httpx,'AsyncClient',lambda **kw:real(transport=httpx.MockTransport(handle),**kw))
    assert model.model_configured()
    assert asyncio.run(model.model_run([{'role':'user','content':'Fixture'}]))=='Answer'
    assert seen[1]['max_tokens']==seen[0]['max_tokens']*2


def test_router_failure_never_uses_legacy_endpoint(monkeypatch):
    monkeypatch.setenv('WIZARD_ROUTER_URL','http://router')
    monkeypatch.setenv('WIZARD_ROUTER_GRANT','synthetic')
    monkeypatch.setenv('MEETINGS_LLM_URL','http://legacy')
    monkeypatch.setenv('MEETINGS_LLM_KEY','synthetic')
    seen=[]
    def handle(request):
        seen.append(str(request.url));return httpx.Response(503)
    real=httpx.AsyncClient
    monkeypatch.setattr(model.httpx,'AsyncClient',lambda **kw:real(transport=httpx.MockTransport(handle),**kw))
    with pytest.raises(httpx.HTTPStatusError):asyncio.run(model.model_run([]))
    assert seen==['http://router/v1/models/recap/run']


def test_owner_identity_is_not_a_microphone_speaker_claim():
    code=(Path(__file__).resolve().parents[1]/'app/server.py').read_text()
    assert 'MEETINGS_OWNER_NAME' in code
    assert 'owner_identity_prompt()' in code
    assert 'not diarized people' in code
    assert 'MEETINGS_STT_URL' in code


def test_image_keeps_every_live_javascript_adapter():
    root=Path(__file__).resolve().parents[1]
    ignore=(root/'.dockerignore').read_text().splitlines()
    assert '!view/*.js' in ignore
    for module in ('live-client.js','router-models.js','summary.js','provider.js'):
        assert (root/'view'/module).is_file()


@pytest.mark.parametrize('owner',['Fixture Owner','',None])
def test_captured_enhancement_prompt_retains_owner(tmp_path,monkeypatch,owner):
    from test_package import run_test
    if owner is None:monkeypatch.delenv('MEETINGS_OWNER_NAME',raising=False)
    else:monkeypatch.setenv('MEETINGS_OWNER_NAME',owner)
    captured=[]
    async def fixture(server,client):
        mid=(await client.post('/api/meetings',json={'title':'Fixture'})).json()['id']
        await client.put(f'/api/meetings/{mid}/notes',json={'notes':'Synthetic fixture only','base_rev':0})
        async def llm(messages,**_kwargs):
            captured.extend(messages);return '# Fixture recap\n\nSynthetic fixture only'
        monkeypatch.setattr(server,'llm',llm)
        await server.run_enhance(mid,'general')
        assert f"Recording owner: {owner or 'the device owner'}" in captured[0]['content']
    run_test(tmp_path,fixture)
