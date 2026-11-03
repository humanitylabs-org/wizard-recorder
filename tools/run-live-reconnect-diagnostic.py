#!/usr/bin/env python3
"""Admitted forum-only synthetic diagnostic; never opens production recording data."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time

stage = Path(__file__).resolve().parents[2]
if socket.gethostname() != 'forum' or not str(stage).startswith('/srv/work/'):
    raise SystemExit('forum staged source required')
if os.environ.get('WIZARD_WORKER_LANE') != 'light':
    raise SystemExit('native light-lane worker required')
source = stage / 'source'
out = stage / 'evidence'
out.mkdir(mode=0o700, exist_ok=True)
manifest = json.loads((stage / 'stage-manifest.json').read_text())
for relative, wanted in manifest['files'].items():
    p = stage / relative
    if p.is_symlink() or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != wanted:
        raise SystemExit('staged file hash mismatch: ' + relative)
node = '/srv/ci-runners/tools/node22/bin/node'
key = stage / '.credential'
pcm = stage / 'synthetic-speech.pcm'
receipt = {'synthetic_only': True, 'review_required': True, 'full_acceptance': False,
           'source_revision': manifest['source_revision'], 'steps': [], 'started_at': time.time()}
try:
    # Local libflite synthesizer only; no TTS/provider other than selected confidential STT.
    cmds = [
        ('synthesize', ['/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', "flite=text='This is a synthetic meeting transcription test. The garden has seven green trees. The next subject is a quiet river and a bright yellow boat.':voice=slt",
          '-ar', '16000', '-ac', '1', '-f', 's16le', str(pcm)]),
        ('provider-and-session', [node, str(source / 'tools/diagnose-live-reconnect.mjs')]),
    ]
    env = dict(os.environ, QA_OUT=str(out), QA_TINFOIL_KEY_FILE=str(key),
               QA_SYNTHETIC_PCM=str(pcm), PYTHONDONTWRITEBYTECODE='1')
    for label, argv in cmds:
        started = time.time()
        try:
            p = subprocess.run(argv, cwd=source, env=env, capture_output=True, timeout=130)
            (out / (label + '.log')).write_bytes(p.stdout + p.stderr)
            result = {'step': label, 'exit_code': p.returncode, 'duration_s': time.time() - started}
        except subprocess.TimeoutExpired as e:
            (out / (label + '.log')).write_bytes((e.stdout or b'') + (e.stderr or b''))
            result = {'step': label, 'timeout': True, 'duration_s': time.time() - started}
        receipt['steps'].append(result)
        (out / 'runner-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        if result.get('exit_code') != 0:
            raise RuntimeError('synthetic step failed: ' + label)
finally:
    # Credential copy is disposable, never committed, printed or retained as evidence.
    if key.exists():
        key.unlink()
    receipt['credential_removed'] = not key.exists()
    receipt['finished_at'] = time.time()
    receipt['artifacts'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                            for p in out.iterdir() if p.is_file() and p.name != 'runner-receipt.json'}
    (out / 'runner-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))
