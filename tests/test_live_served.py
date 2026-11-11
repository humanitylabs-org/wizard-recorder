"""The Recorder serves its live screen behind the off-by-default `live-screen` switch (issue #1)."""
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'app'))
from test_package import run_test  # noqa: E402

LIVE_ENV = ('TINFOIL_API_KEY', 'WIZARD_AGENT_KEY', 'MIZEL_AGENT_NAME', 'MIZEL_LIVE_PORT', 'MIZEL_LIVE_UPSTREAM_PORT',
            'MIZEL_LIVE_DRY', 'MEETINGS_TIMEZONE')


@pytest.fixture(autouse=True)
def clean_env():
    saved = {k: os.environ.pop(k, None) for k in LIVE_ENV}
    yield
    for k, v in saved.items():
        os.environ.pop(k, None)
        if v is not None:
            os.environ[k] = v


def switch(tmp_path, on):
    (tmp_path / 'switches.json').write_text(json.dumps({'live-screen': on}))


def test_switch_is_declared_off_by_default_with_its_issue(tmp_path):
    async def test(s, c):
        import wizard_switches
        sw = {x['id']: x for x in wizard_switches.switches_doc()['switches']}['live-screen']
        assert sw['on'] is False and sw['default'] is False
        assert sw['issues'] == ['humanitylabs-org/wizard-recorder#1']
    run_test(tmp_path, test)


def test_off_keeps_the_old_answers_and_starts_nothing(tmp_path):
    async def test(s, c):
        r = await c.get('/')
        assert r.status_code == 200 and r.json()['app'] == 'mizel'
        for path in ('/live', '/live/', '/live/app.js', '/live/live-health'):
            r = await c.get(path)
            assert r.status_code == 404 and r.json()['code'] == 'switch_off', path
        assert not s.live_screen.runner.running()
    run_test(tmp_path, test, {'TINFOIL_API_KEY': 'fixture-key'})


def test_on_without_a_key_says_what_is_missing(tmp_path):
    switch(tmp_path, True)

    async def test(s, c):
        r = await c.get('/')
        assert r.status_code == 302 and r.headers['location'] == 'live/'
        assert (await c.get('/live')).headers['location'] == 'live/'
        r = await c.get('/live/')
        assert r.status_code == 503 and 'Tinfoil API key' in r.text
        assert not s.live_screen.runner.running()
    run_test(tmp_path, test)


def test_node_env_comes_from_the_install_only(tmp_path):
    os.environ.update({'TINFOIL_API_KEY': 'k', 'WIZARD_AGENT_KEY': 'agent-k', 'MIZEL_AGENT_NAME': 'Ada'})
    import live_screen
    env = live_screen.node_env(tmp_path)
    assert env['API_SERVER_KEY'] == 'agent-k' and env['MIZEL_AGENT_NAME'] == 'Ada'
    assert env['HOME'] == env['MIZEL_LIVE_DATA'] == str(tmp_path / 'live')
    assert env['MEETINGS_DATA_DIR'] == str(tmp_path) and env['MIZEL_LIVE_BASE'] == '/live'
    assert env['MIZEL_ALLOWED_ORIGINS'] == ''
    assert 'WIZARD_AGENT_KEY' not in env and 'MEETINGS_LLM_KEY' not in env


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def node_ready():
    node = shutil.which('node')
    if not node:
        return False
    major = int(subprocess.check_output([node, '--version'], text=True).lstrip('v').split('.')[0])
    if major < 22:
        return False
    live = ROOT / 'live'
    if not (live / 'node_modules' / 'tinfoil').is_dir():
        npm = shutil.which('npm')
        if not npm or subprocess.run([npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=live,
                                     capture_output=True, timeout=300).returncode:
            return False
    return True


def test_on_serves_the_screen_through_the_app(tmp_path):
    """Real uvicorn + real Node (dry mode: no Tinfoil or agent calls): page, health, origin guard, WebSocket."""
    if not node_ready():
        pytest.skip('node >= 22 with live/ dependencies not available')
    import websockets
    switch(tmp_path, True)
    app_port, live_port = free_port(), free_port()
    env = {**os.environ, 'MEETINGS_DATA': str(tmp_path), 'TINFOIL_API_KEY': 'fixture-key', 'MIZEL_LIVE_DRY': '1',
           'MIZEL_AGENT_NAME': 'Ada', 'MEETINGS_TIMEZONE': 'Europe/Lisbon', 'MIZEL_LIVE_PORT': str(live_port),
           'MIZEL_LIVE_UPSTREAM_PORT': str(app_port), 'TRANSCRIPTION_URL': 'http://fixture/v1/audio/transcriptions',
           'PYTHONPATH': str(ROOT / 'app')}
    srv = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', str(app_port)],
                           cwd=ROOT / 'app', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{app_port}'
    try:
        for _ in range(100):
            try:
                if httpx.get(base + '/healthz', timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.1)
        r = httpx.get(base + '/', follow_redirects=False)
        assert r.status_code == 302 and r.headers['location'] == 'live/'
        r = httpx.get(base + '/live/', timeout=30)
        assert r.status_code == 200 and 'app.js' in r.text and 'wizard-tokens.css' in r.text, log(srv, r.text)
        health = httpx.get(base + '/live/live-health', timeout=10).json()
        assert health['agentName'] == 'Ada' and health['timeZone'] == 'Europe/Lisbon' and health['agentConnected'] is False
        assert httpx.get(base + '/live/app.js').headers['content-type'].startswith('text/javascript')
        # Node reaches the recordings API back through this app.
        mid = httpx.post(base + '/api/meetings', json={'title': 'Fixture'}, headers={'Origin': base}).json()['id']
        assert httpx.get(base + f'/live/api/meetings/{mid}').json()['id'] == mid
        # Writes keep the same-host origin rule.
        ask = {'meetingId': mid, 'text': 'What did we decide?'}
        assert httpx.post(base + '/live/manual-ask', json=ask, headers={'Origin': 'https://foreign.example'}).status_code == 403
        r = httpx.post(base + '/live/manual-ask', json=ask, headers={'Origin': base})
        assert r.status_code == 202 and r.json()['ask']['agentLabel'] == 'Ada', r.text

        async def sockets():
            url = f'ws://127.0.0.1:{app_port}/live/live'
            with pytest.raises(websockets.InvalidStatus):
                async with websockets.connect(url, origin='https://foreign.example', open_timeout=5):
                    pass
            async with websockets.connect(url, origin=base, open_timeout=10) as ws:
                await ws.send(json.dumps({'type': 'stop'}))
                with pytest.raises(websockets.ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), 10)
        asyncio.run(sockets())
        # Off again: the screen goes away and the Node service stops.
        switch(tmp_path, False)
        assert httpx.get(base + '/live/').status_code == 404
        assert httpx.get(base + '/', follow_redirects=False).status_code == 200
        for _ in range(50):
            try:
                socket.create_connection(('127.0.0.1', live_port), timeout=0.2).close()
                time.sleep(0.1)
            except OSError:
                break
        else:
            raise AssertionError('live service still listening after the switch went off')
    finally:
        srv.terminate()
        srv.wait(10)


def log(proc, extra=''):
    return extra[-2000:]
