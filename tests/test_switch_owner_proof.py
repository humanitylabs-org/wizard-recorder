"""The switch owner check: an app with a platform owner-proof key takes only a valid signed proof (wizard-os#133).

Host, Origin, Tailscale-User-Login and X-Wizard-Switch are client-set, so any process on the box that reaches the app
port could set them. With WIZARD_OWNER_PROOF_KEY_FILE named, only an hmac-v1 proof (wizard-os spec/OWNER_PROOF.md,
bound to app id, method and target, +-30 s, each nonce once) is accepted.
"""
import hashlib
import hmac
import os
import secrets
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import wizard_switches  # noqa: E402

KEY = bytes(range(32))
APP = 'wizard-recorder'
FORGED = {'X-Wizard-Switch': '1', 'Host': 'box.tail1234.ts.net', 'Origin': 'https://box.tail1234.ts.net',
          'Tailscale-User-Login': 'owner@example.com'}
ENV = ('WIZARD_OWNER_PROOF_KEY_FILE', 'WIZARD_OWNER_PROOF_APP', 'WIZARD_OWNER_LOGINS', 'WIZARD_TRUSTED_ORIGINS')


def sign(method, target, key=KEY, app=APP, ts=None, nonce=None):
    ts = str(int(time.time()) if ts is None else ts)
    nonce = nonce or secrets.token_hex(24)
    msg = '\n'.join(('wizard-app-owner-v1', app, ts, nonce, method, target)).encode()
    return f'{ts}.{nonce}.{hmac.new(key, msg, hashlib.sha256).hexdigest()}'


@pytest.fixture
def client(tmp_path, monkeypatch):
    for k in ENV:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(wizard_switches, 'SWITCHES', [{'id': 'demo', 'name': 'Demo', 'default': False, 'issues': []}])
    getattr(wizard_switches, '_nonces', {}).clear()
    app = FastAPI()
    wizard_switches.install_switches(app, str(tmp_path))
    return TestClient(app, base_url='http://127.0.0.1:8080')


def keyed(tmp_path, monkeypatch, key=KEY):
    f = tmp_path / 'proof'
    f.write_bytes(key)
    monkeypatch.setenv('WIZARD_OWNER_PROOF_KEY_FILE', str(f))
    monkeypatch.setenv('WIZARD_OWNER_PROOF_APP', APP)


def test_keyless_app_keeps_the_serve_login_check(client):
    assert client.get('/api/switches', headers=FORGED).status_code == 200
    assert client.get('/api/switches', headers={**FORGED, 'Host': '127.0.0.1:8080'}).status_code == 403


def test_keyed_app_refuses_the_forgeable_headers(client, tmp_path, monkeypatch):
    keyed(tmp_path, monkeypatch)
    assert client.get('/api/switches', headers=FORGED).status_code == 403
    r = client.post('/api/switches', headers=FORGED, json={'id': 'demo', 'on': True})
    assert r.status_code == 403
    assert wizard_switches.switch_on('demo') is False


def test_keyed_app_takes_a_valid_proof_once(client, tmp_path, monkeypatch):
    keyed(tmp_path, monkeypatch)
    h = {'X-Wizard-Switch': '1', 'X-Wizard-App-Owner-Proof': sign('POST', '/api/switches')}
    r = client.post('/api/switches', headers=h, json={'id': 'demo', 'on': True})
    assert r.status_code == 200 and wizard_switches.switch_on('demo') is True
    assert client.post('/api/switches', headers=h, json={'id': 'demo', 'on': False}).status_code == 403  # replay
    assert wizard_switches.switch_on('demo') is True
    g = {'X-Wizard-Switch': '1', 'X-Wizard-App-Owner-Proof': sign('GET', '/api/switches?x=1')}
    assert client.get('/api/switches?x=1', headers=g).status_code == 200


@pytest.mark.parametrize('proof', [
    lambda: sign('GET', '/api/switches'),                       # wrong method
    lambda: sign('POST', '/other/api/switches'),                # wrong target
    lambda: sign('POST', '/api/switches', app='wizard-notes'),  # wrong app
    lambda: sign('POST', '/api/switches', key=bytes(32)),       # wrong key
    lambda: sign('POST', '/api/switches', ts=int(time.time()) - 31),  # stale
    lambda: 'not-a-proof',
])
def test_keyed_app_refuses_a_bad_proof(client, tmp_path, monkeypatch, proof):
    keyed(tmp_path, monkeypatch)
    h = {**FORGED, 'X-Wizard-App-Owner-Proof': proof()}
    assert client.post('/api/switches', headers=h, json={'id': 'demo', 'on': True}).status_code == 403
    assert wizard_switches.switch_on('demo') is False


def test_proof_needs_the_switch_header_and_no_bearer(client, tmp_path, monkeypatch):
    keyed(tmp_path, monkeypatch)
    assert client.get('/api/switches', headers={'X-Wizard-App-Owner-Proof': sign('GET', '/api/switches')}).status_code == 403
    h = {'X-Wizard-Switch': '1', 'Authorization': 'Bearer x', 'X-Wizard-App-Owner-Proof': sign('GET', '/api/switches')}
    assert client.get('/api/switches', headers=h).status_code == 403


def test_unreadable_key_refuses_and_never_falls_back(client, tmp_path, monkeypatch):
    monkeypatch.setenv('WIZARD_OWNER_PROOF_KEY_FILE', str(tmp_path / 'missing'))
    monkeypatch.setenv('WIZARD_OWNER_PROOF_APP', APP)
    assert client.get('/api/switches', headers=FORGED).status_code == 403
    h = {'X-Wizard-Switch': '1', 'X-Wizard-App-Owner-Proof': sign('GET', '/api/switches')}
    assert client.get('/api/switches', headers=h).status_code == 403
    assert os.environ['WIZARD_OWNER_PROOF_KEY_FILE'].endswith('missing')
