"""Finished meetings reach the Private agent without the Recorder screen open (issue 29).

Real uvicorn + real Node (dry mode, the Private agent not visible to the server, as on a box): a finished meeting
becomes due; the shell's Ready extension (ready.json + content-addressed shell.js) is served; two devices claiming at
once never both send; a failed try is remembered; a meeting that waits too long is one inbox item for Ready; a deleted
recording drops out of due.
"""
import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from test_live_served import clean_env, free_port, node_ready  # noqa: E402,F401


def wait_for(fn, timeout=30, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        got = fn()
        if got:
            return got
        time.sleep(step)
    return fn()


@pytest.fixture
def recorder(tmp_path):
    if not node_ready():
        pytest.skip('node >= 22 with live/ dependencies not available')
    app_port, live_port = free_port(), free_port()
    env = {**os.environ, 'MEETINGS_DATA': str(tmp_path), 'TINFOIL_API_KEY': 'fixture-key', 'MIZEL_LIVE_DRY': '1',
           'MIZEL_LIVE_DRY_AGENTS': json.dumps([{'id': 'hermes', 'label': 'Wizard'}]), 'MIZEL_FINISH_POLL_MS': '500',
           'MEETINGS_FINAL_SEQ_WAIT_S': '0', 'MIZEL_LIVE_PORT': str(live_port), 'MIZEL_LIVE_UPSTREAM_PORT': str(app_port),
           'MEETINGS_INBOX_AFTER_S': '0', 'TRANSCRIPTION_URL': 'http://fixture/v1/audio/transcriptions',
           'PYTHONPATH': str(ROOT / 'app')}
    srv = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', str(app_port)],
                           cwd=ROOT / 'app', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f'http://127.0.0.1:{app_port}'
    try:
        assert wait_for(lambda: _ok(base + '/healthz'), 20)
        assert httpx.get(base + '/live/', timeout=30).status_code == 200   # the live service is up
        time.sleep(1.2)   # recordings started in the service's first second count as older (autoSince, whole seconds)
        yield base
    finally:
        srv.terminate()
        srv.wait(10)


def _ok(url):
    try:
        return httpx.get(url, timeout=1).status_code == 200
    except httpx.HTTPError:
        return False


def finished(base, title):
    mid = httpx.post(base + '/api/meetings', json={'title': title}, headers={'Origin': base}).json()['id']
    httpx.post(base + f'/api/meetings/{mid}/stop', json={}, headers={'Origin': base})
    due = wait_for(lambda: [d for d in httpx.get(base + '/live/deliveries/due').json()['due'] if d['meetingId'] == mid], 30)
    assert due, 'a finished meeting for the Private agent becomes due'
    return mid, due[0]


def claim(base, mid):
    return httpx.post(base + '/live/deliveries/claim', json={'meetingId': mid, 'agentLabel': 'Private agent'},
                      headers={'Origin': base}, timeout=20)


def test_shell_extension_is_declared_and_content_addressed(recorder):
    base = recorder
    assert 'ready-extension' in (ROOT / 'wizard.md').read_text().split('provides:')[1].split('\n')[0]
    d = httpx.get(base + '/ready.json').json()
    assert d['contract'] == 'wizard.ready-extension/1'
    js, css = (ROOT / 'ready' / 'shell.js').read_bytes(), (ROOT / 'ready' / 'shell.css').read_bytes()
    assert d['module_sha256'] == hashlib.sha256(js).hexdigest() and d['style_sha256'] == hashlib.sha256(css).hexdigest()
    r = httpx.get(base + '/shell.js', params={'sha256': d['module_sha256']})
    assert r.status_code == 200 and r.content == js and r.headers['content-type'].startswith('text/javascript')
    assert httpx.get(base + '/shell.css', params={'sha256': d['style_sha256']}).status_code == 200
    assert httpx.get(base + '/shell.js', params={'sha256': 'a' * 64}).status_code == 404   # another revision's bytes
    assert httpx.get(base + '/shell.js').status_code == 404


def test_due_claim_lease_failure_and_inbox(recorder):
    base = recorder
    mid, due = finished(base, 'Weekly sync')
    assert due['agent'] == 'private' and due['at'] and due['failedAt'] is None and due['sending'] is False

    # Two devices at the same moment: exactly one gets it.
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        codes = sorted(r.status_code for r in pool.map(lambda _: claim(base, mid), range(2)))
    assert codes == [200, 409], codes
    first = [d for d in httpx.get(base + '/live/deliveries/due').json()['due'] if d['meetingId'] == mid][0]
    assert first['sending'] is True

    # The device that had it reports a failure: it stays due with the reason, and the lease is free again.
    sends = httpx.get(base + '/live/sends', params={'meetingId': mid}).json()['sends']
    r = httpx.post(base + '/live/deliveries/result', json={'sendId': sends[0]['id'], 'error': 'Private agent is down'},
                   headers={'Origin': base})
    assert r.status_code == 200 and r.json()['send']['status'] == 'failed'
    d = [d for d in httpx.get(base + '/live/deliveries/due').json()['due'] if d['meetingId'] == mid][0]
    assert d['failedAt'] and 'Private agent is down' in d['error'] and d['sending'] is False

    # Waiting too long (0 s in this test): one item for the owner's Ready, opening the meeting with send=.
    items = httpx.get(base + '/api/inbox').json()
    assert items['inbox'] == 1
    item = [i for i in items['items'] if i['key'] == f'deliver:{mid}'][0]
    assert item['title'] == 'Meeting ready to send to Private agent'
    assert 'Weekly sync' in item['text'] and 'Last try: Private agent is down' in item['text']
    assert item['open'] == f'live/?send={mid}#/m/{mid}' and item['priority'] == 4
    assert abs(item['time'] - time.time()) < 3600   # seconds, like every inbox feed

    # A successful send clears it everywhere.
    c = claim(base, mid)
    assert c.status_code == 200
    r = httpx.post(base + '/live/deliveries/result', json={'sendId': c.json()['sendId'], 'threadId': 'wizard_fixture_1'},
                   headers={'Origin': base})
    assert r.json()['send']['status'] == 'sent'
    assert not [d for d in httpx.get(base + '/live/deliveries/due').json()['due'] if d['meetingId'] == mid]
    assert not [i for i in httpx.get(base + '/api/inbox').json()['items'] if i['key'] == f'deliver:{mid}']


def test_deleted_recordings_drop_out_of_due(recorder):
    base = recorder
    a, _ = finished(base, 'Deleted before anyone sent it')
    b, _ = finished(base, 'Deleted, then claimed')
    assert httpx.delete(base + f'/api/meetings/{a}', headers={'Origin': base}).json()['deleted'] is True
    # The server's own finish loop drops it, with no device involved.
    assert wait_for(lambda: a not in [d['meetingId'] for d in httpx.get(base + '/live/deliveries/due').json()['due']], 20)
    # A device that claims a deleted one gets a clear answer and it is dropped at once.
    httpx.delete(base + f'/api/meetings/{b}', headers={'Origin': base})
    r = claim(base, b)
    if r.status_code != 409:   # (unless the finish loop dropped it first)
        assert r.status_code == 410, r.text
    assert b not in [d['meetingId'] for d in httpx.get(base + '/live/deliveries/due').json()['due']]
    assert not httpx.get(base + '/api/inbox').json()['items']
