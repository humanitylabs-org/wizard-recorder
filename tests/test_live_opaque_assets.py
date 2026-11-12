"""The live screen from a sandboxed (opaque-origin) frame: the shell's browser boundary, wizard-os#133.

The browser asks for a module script from an opaque page with `Origin: null` and needs a CORS answer, or the live
screen stays blank. The Recorder gives it for the screen's own public files only; the page, its JSON, the API and
every write keep their answers (the shell carries the page's own calls).
"""
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'app'))
from test_live_served import clean_env, free_port, node_ready, switch  # noqa: E402,F401

import live_screen  # noqa: E402


def test_only_the_screens_own_files_qualify():
    null = {'origin': 'null'}
    for name in ('app.js', 'styles.css', 'wizard-tokens.css', 'icon-192.png', 'manifest.webmanifest', 'x.mjs'):
        assert live_screen.opaque_asset('GET', null, name), name
        assert live_screen.opaque_asset('HEAD', null, name), name
    for name in ('', 'index.html', 'live-health', 'summary', 'api/meetings', 'api/x.js', '../app.js', '.env.js',
                 'x.json', 'manual-ask'):
        assert not live_screen.opaque_asset('GET', null, name), name
    assert not live_screen.opaque_asset('POST', null, 'app.js')
    assert not live_screen.opaque_asset('GET', {}, 'app.js')
    assert not live_screen.opaque_asset('GET', {'origin': 'https://foreign.example'}, 'app.js')


def test_opaque_page_gets_its_script_files_and_nothing_else(tmp_path):
    """Real uvicorn + real Node (dry mode), with the requests a sandboxed frame really sends."""
    if not node_ready():
        pytest.skip('node >= 22 with live/ dependencies not available')
    switch(tmp_path, True)
    app_port, live_port = free_port(), free_port()
    env = {**os.environ, 'MEETINGS_DATA': str(tmp_path), 'TINFOIL_API_KEY': 'fixture-key', 'MIZEL_LIVE_DRY': '1',
           'MIZEL_LIVE_PORT': str(live_port), 'MIZEL_LIVE_UPSTREAM_PORT': str(app_port),
           'TRANSCRIPTION_URL': 'http://fixture/v1/audio/transcriptions', 'PYTHONPATH': str(ROOT / 'app')}
    srv = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', str(app_port)],
                           cwd=ROOT / 'app', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f'http://127.0.0.1:{app_port}'
    opaque = {'Origin': 'null', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors'}
    try:
        for _ in range(100):
            try:
                if httpx.get(base + '/healthz', timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.1)
        assert httpx.get(base + '/live/', timeout=30).status_code == 200
        for name in ('app.js', 'styles.css', 'wizard-tokens.css', 'wizard-style.css', 'wizard-appearance.css'):
            r = httpx.get(base + '/live/' + name, headers=opaque)
            assert r.status_code == 200 and r.content, name
            assert r.headers.get('access-control-allow-origin') == '*', name
            assert 'access-control-allow-credentials' not in r.headers, name
        r = httpx.head(base + '/live/app.js', headers=opaque)
        assert (r.status_code, r.headers.get('access-control-allow-origin')) == (200, '*')
        # The page, its health JSON, the API and writes give an opaque page no CORS answer.
        for path in ('/live/', '/live/live-health', '/live/api/meetings', '/live/missing.js'):
            assert 'access-control-allow-origin' not in httpx.get(base + path, headers=opaque).headers, path
        r = httpx.post(base + '/live/manual-ask', json={'meetingId': 'abc', 'text': 'x'}, headers=opaque)
        assert r.status_code == 403 and 'access-control-allow-origin' not in r.headers
        # Same-origin and other sites get the same answers as before.
        assert 'access-control-allow-origin' not in httpx.get(base + '/live/app.js').headers
        assert 'access-control-allow-origin' not in httpx.get(base + '/live/app.js', headers={'Origin': base}).headers
        r = httpx.get(base + '/live/app.js', headers={'Origin': 'https://foreign.example'})
        assert 'access-control-allow-origin' not in r.headers
    finally:
        srv.terminate()
        srv.wait(10)
