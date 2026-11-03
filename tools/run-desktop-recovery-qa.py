#!/usr/bin/env python3
"""Forum/light admitted synthetic fault/browser acceptance; no production access/key."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time

stage = Path(__file__).resolve().parents[2]
if socket.gethostname() != 'forum' or not str(stage).startswith('/srv/work/'):
    raise SystemExit('forum /srv/work required')
if os.environ.get('WIZARD_WORKER_LANE') != 'light':
    raise SystemExit('durable light-lane admission required')
source = stage / 'source'
app = source / 'adoptions/mizel-live'
out = stage / 'evidence'
out.mkdir(mode=0o700, exist_ok=True)
(stage / 'scratch').mkdir(mode=0o700, exist_ok=True)
manifest = json.loads((stage / 'stage-manifest.json').read_text())
for relative, expected in manifest['files'].items():
    p = stage / relative
    if not p.is_file() or p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
        raise SystemExit('staged closure mismatch: ' + relative)
node = '/srv/ci-runners/tools/node22/bin/node'
env = dict(os.environ, QA_OUT=str(out), QA_SHARED_STATIC=str(stage / 'shared-static'),
           QA_TLS_CERT=str(stage / 'fixture-cert.pem'), QA_TLS_KEY=str(stage / 'fixture-key.pem'),
           QA_PLAYWRIGHT=str(stage / 'browser-node-modules/playwright'), NODE_PATH=str(stage / 'browser-node-modules'),
           QA_CHROMIUM='/home/james/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
           QA_SYNTHETIC_WAV=str(stage / 'synthetic.wav'), PYTHONDONTWRITEBYTECODE='1', TMPDIR=str(stage / 'scratch'))
receipt = {'synthetic_only': True, 'source_revision': manifest['source_revision'], 'productionAcceptance': False,
           'no_provider_credential': True, 'steps': [], 'started_at': time.time()}
def run(label, argv, *, extra=None, expect=0, timeout=120):
    started = time.time()
    p = subprocess.run(argv, cwd=app, env=dict(env, **(extra or {})), capture_output=True, timeout=timeout)
    log = p.stdout + p.stderr
    (out / (label + '.log')).write_bytes(log)
    receipt['steps'].append({'step': label, 'exit_code': p.returncode, 'expected_exit': expect, 'duration_s': time.time() - started})
    if p.returncode != expect:
        raise RuntimeError('Synthetic step failed: ' + label)
    return log.decode(errors='replace')
try:
    before = run('fault-before', [node, '--test', 'test-live-recovery.mjs'],
                 extra={'QA_PROVIDER_SOURCE': str(stage / 'baseline-provider.js')}, expect=1)
    if '# fail 4' not in before or '# pass 1' not in before:
        raise RuntimeError('Expected exact four close/recovery regressions before patch')
    run('fault-after', [node, '--test', 'test-live-recovery.mjs'])
    tests = sorted(p.name for p in app.glob('test-*.mjs'))
    run('existing-contracts', [node, '--test', *tests])
    run('synthesize', ['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        "flite=text='This is a synthetic desktop capture test. Green trees surround a quiet river. Recording continues while live words reconnect.':voice=slt",
        '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', str(stage / 'synthetic.wav')])
    run('local-test-certificate', ['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=synthetic-loopback-only', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', str(stage / 'fixture-key.pem'), '-out', str(stage / 'fixture-cert.pem')])
    run('browser-recovery', [node, 'qa-desktop-recovery.cjs'], timeout=180)
finally:
    # Local test TLS key is not a production secret, but do not retain it anyway.
    (stage / 'fixture-key.pem').unlink(missing_ok=True)
    receipt['finished_at'] = time.time()
    receipt['artifacts'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir() if p.is_file() and p.name != 'runner-receipt.json'}
    (out / 'runner-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))
