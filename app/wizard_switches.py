"""wizard.app-switches/1 for FastAPI apps: owner feature switches for the Tracker's Try it (wizard-os docs/APP_SWITCHES.md).

Shared module (Python BaseHTTPRequestHandler twin: wizard-app-manager templates/hello-wizard). Every new feature ships
behind a switch, off by default: append it to SWITCHES with the issue it delivers, e.g.
  {'id': 'compact-header', 'name': 'Compact top bar', 'description': '...', 'default': False,
   'issues': ['humanitylabs-org/<repo>#20']}
and gate the feature on switch_on('compact-header'). State lives on the box (<data dir>/switches.json). GET/POST
/api/switches, owner only: the box's Tailscale Serve owner login with X-Wizard-Switch: 1; never a bearer, agent grant or
box-local host. An app with a platform owner-proof key (owner_proof in wizard.md, wizard-os spec/OWNER_PROOF.md) accepts
only a valid signed proof: any process on the box can set the other headers. Wire it with install_switches(app, data_dir).
"""
import hashlib
import hmac
import json
import os
import re
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

SWITCHES = [
    {'id': 'live-screen', 'name': 'Live screen',
     'description': 'Open the Recorder with its full screen: live words while you record, Ask cards, a live summary, '
                    'playback, transcript and outline. Needs a live words key in the app settings.',
     'default': False, 'issues': ['humanitylabs-org/wizard-recorder#1']},
]
CONTRACT = 'wizard.app-switches/1'
_LOCAL = {'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'}
_lock = threading.Lock()
_dir = {'path': None}
_nonces = {}
_PROOF = re.compile(r'(\d{1,12})\.([0-9a-f]{48})\.([0-9a-f]{64})')


def _file():
    return Path(_dir['path'] or os.environ.get('WIZARD_SWITCHES_DIR') or os.environ.get('DATA_DIR') or '/data') / 'switches.json'


def _saved():
    try:
        v = json.loads(_file().read_text())
    except (OSError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def switches_doc():
    s = _saved()
    return {'contract': CONTRACT, 'switches': [
        dict(x, on=s[x['id']] if isinstance(s.get(x['id']), bool) else bool(x.get('default'))) for x in SWITCHES]}


def switch_on(switch_id):
    return next((x['on'] for x in switches_doc()['switches'] if x['id'] == switch_id), False)


def _set(switch_id, on):
    with _lock:
        ids = {x['id'] for x in SWITCHES}
        nxt = {k: v for k, v in _saved().items() if k in ids and isinstance(v, bool)}
        nxt[switch_id] = on
        f = _file()
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f.name + '.tmp')
        tmp.write_text(json.dumps(nxt))
        os.replace(tmp, f)
    return switches_doc()


def _target(scope):
    """The request target as the app received it (raw path plus query), which the owner proof is bound to."""
    raw = scope.get('raw_path') or scope.get('path', '').encode()
    q = scope.get('query_string') or b''
    return (raw + (b'?' + q if q else b'')).decode('latin-1')


def _proof(h, method, target):
    """None when this app has no platform owner-proof key, else whether the request carries a valid, unused proof."""
    key_file = os.environ.get('WIZARD_OWNER_PROOF_KEY_FILE')
    if not key_file:
        return None
    try:
        with open(key_file, 'rb') as f:
            key = f.read(33)
    except OSError:
        return False                    # a key is named but unreadable: refuse, never fall back to headers
    app = os.environ.get('WIZARD_OWNER_PROOF_APP') or ''
    values = h.getlist('x-wizard-app-owner-proof') if hasattr(h, 'getlist') else [h.get('x-wizard-app-owner-proof') or '']
    m = _PROOF.fullmatch(values[0].strip()) if len(values) == 1 else None
    if len(key) != 32 or not app or not m or abs(time.time() - int(m.group(1))) > 30:
        return False
    msg = '\n'.join(('wizard-app-owner-v1', app, m.group(1), m.group(2), method, target)).encode()
    if not hmac.compare_digest(hmac.new(key, msg, hashlib.sha256).hexdigest(), m.group(3)):
        return False
    now = time.monotonic()
    with _lock:
        for n in [n for n, until in _nonces.items() if until < now]:
            del _nonces[n]
        if m.group(2) in _nonces:
            return False
        _nonces[m.group(2)] = now + 61
    return True


def _owner(h, write, method='GET', target=''):
    if h.get('authorization') or h.get('x-wizard-switch') != '1':
        return False
    proof = _proof(h, method, target)
    if proof is not None:
        return proof
    if (h.get('sec-fetch-site') or 'same-origin').lower() not in ('same-origin', 'none'):
        return False
    host = (h.get('host') or '').strip().lower()
    name = host.split(']')[0] + ']' if host.startswith('[') else host.rsplit(':', 1)[0]
    if not name or name in _LOCAL or '.' not in name:
        return False
    origin = h.get('origin')
    trusted = {o.strip() for o in (os.environ.get('WIZARD_TRUSTED_ORIGINS') or '').split(',') if o.strip()}
    if origin and urlsplit(origin).netloc.lower() != host and origin not in trusted:
        return False
    if write and not origin:
        return False
    logins = h.getlist('tailscale-user-login') if hasattr(h, 'getlist') else [h.get('tailscale-user-login') or '']
    owners = {x.strip().lower() for x in (os.environ.get('WIZARD_OWNER_LOGINS') or '').split(',') if x.strip()}
    return len(logins) == 1 and '@' in logins[0] and (not owners or logins[0].strip().lower() in owners)


def install_switches(app, data_dir=None, path='/api/switches'):
    """Add GET/POST <path> to a FastAPI/Starlette app."""
    from fastapi import Request
    from fastapi.responses import JSONResponse
    _dir['path'] = data_dir
    nocache = {'Cache-Control': 'no-store'}

    @app.get(path, include_in_schema=False)
    async def wizard_switches_get(request: Request):
        if not _owner(request.headers, False, request.method, _target(request.scope)):
            return JSONResponse({'error': "Only this Wizard's owner can see these switches.", 'code': 'owner_only'}, 403, nocache)
        return JSONResponse(switches_doc(), 200, nocache)

    @app.post(path, include_in_schema=False)
    async def wizard_switches_post(request: Request):
        if not _owner(request.headers, True, request.method, _target(request.scope)):
            return JSONResponse({'error': "Only this Wizard's owner can change these switches.", 'code': 'owner_only'}, 403, nocache)
        try:
            if (request.headers.get('content-type') or '').split(';')[0].strip() != 'application/json':
                raise ValueError
            raw = await request.body()
            if not raw or len(raw) > 4096:
                raise ValueError
            body = json.loads(raw)
            if not isinstance(body, dict) or not isinstance(body.get('id'), str) or not isinstance(body.get('on'), bool) \
                    or set(body) - {'id', 'on'}:
                raise ValueError
        except (ValueError, TypeError):
            return JSONResponse({'error': 'Send JSON {"id": "...", "on": true|false}', 'code': 'invalid_input'}, 400, nocache)
        if body['id'] not in {x['id'] for x in SWITCHES}:
            return JSONResponse({'error': 'No such switch', 'code': 'unknown_switch'}, 404, nocache)
        try:
            return JSONResponse(_set(body['id'], body['on']), 200, nocache)
        except OSError:
            return JSONResponse({'error': 'storage_failure'}, 500, nocache)
    return app
