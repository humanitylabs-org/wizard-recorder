#!/usr/bin/env python3
"""Parent-admitted forum/light browser continuation; inherit, never repeat, passing tests."""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time

stage = Path(__file__).resolve().parents[2]
if socket.gethostname() != 'forum' or not str(stage).startswith('/srv/work/'):
    raise SystemExit('forum /srv/work required')
if os.environ.get('WIZARD_WORKER_LANE') != 'light':
    raise SystemExit('parent durable light-lane admission required')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = json.loads((stage / 'stage-manifest.json').read_text())
for relative, expected in manifest['files'].items():
    p = stage / relative
    if not p.is_file() or p.is_symlink() or sha(p) != expected:
        raise SystemExit('staged closure mismatch: ' + relative)
for relative, expected in manifest['symlinks'].items():
    p = stage / relative
    if not p.is_symlink() or str(p.readlink()) != expected:
        raise SystemExit('staged link mismatch: ' + relative)
source = stage / 'source'
app = source / 'adoptions/mizel-live'
out = stage / 'evidence'
out.mkdir(mode=0o700)
scratch = stage / 'scratch'
scratch.mkdir(mode=0o700, exist_ok=True)
inherited = json.loads((stage / 'inherited-evidence.json').read_text())
for relative, expected in inherited['files'].items():
    if sha(stage / relative) != expected:
        raise SystemExit('inherited evidence mismatch: ' + relative)
old_receipt = json.loads((stage / 'inherited/runner-receipt.json').read_text())
for label, expected_exit in [('fault-before', 1), ('fault-after', 0), ('existing-contracts', 0)]:
    step = next(s for s in old_receipt['steps'] if s['step'] == label)
    if step['exit_code'] != expected_exit or step['expected_exit'] != expected_exit:
        raise SystemExit('inherited verdict mismatch: ' + label)
    if old_receipt['artifacts'][label + '.log'] != sha(stage / 'inherited' / (label + '.log')):
        raise SystemExit('inherited log receipt mismatch: ' + label)
for label, passed, failed in [('fault-before', 1, 4), ('fault-after', 5, 0), ('existing-contracts', 61, 0)]:
    text = (stage / 'inherited' / (label + '.log')).read_text()
    if f'# pass {passed}\n' not in text or f'# fail {failed}\n' not in text:
        raise SystemExit('inherited exact totals mismatch: ' + label)
browser = json.loads((stage / 'browser-preflight.json').read_text())
executable = Path(browser['executable'])
if not executable.is_file() or not os.access(executable, os.X_OK) or sha(executable) != browser['executable_sha256']:
    raise SystemExit('installed browser executable mismatch')
for module in ['playwright', 'playwright-core']:
    package = json.loads((stage / 'browser-node-modules' / module / 'package.json').read_text())
    if package['version'] != browser['playwright_version']:
        raise SystemExit('Playwright package version mismatch')
chromium = next(b for b in json.loads((stage / 'browser-node-modules/playwright-core/browsers.json').read_text())['browsers'] if b['name'] == 'chromium')
if chromium['revision'] != browser['revision'] or chromium['browserVersion'] != browser['browser_version']:
    raise SystemExit('Playwright bundled browser metadata mismatch')
if executable.parent.parent.name != 'chromium-' + chromium['revision']:
    raise SystemExit('Playwright/installed Chromium revision mismatch')
node = '/srv/ci-runners/tools/node22/bin/node'
# Only synthetic credentials and loopback fixtures. Do not inherit any provider/owner secret.
env = {k: os.environ[k] for k in ['PATH', 'HOME', 'LANG', 'WIZARD_WORKER_LANE', 'XDG_RUNTIME_DIR'] if k in os.environ}
env.update(QA_OUT=str(out), QA_SHARED_STATIC=str(stage / 'shared-static'),
           QA_TLS_CERT=str(stage / 'fixture-cert.pem'), QA_TLS_KEY=str(stage / 'fixture-key.pem'),
           QA_PLAYWRIGHT=str(stage / 'browser-node-modules/playwright'), NODE_PATH=str(stage / 'browser-node-modules'),
           QA_CHROMIUM=str(executable), QA_SYNTHETIC_WAV=str(stage / 'synthetic.wav'),
           PYTHONDONTWRITEBYTECODE='1', TMPDIR=str(scratch))
receipt = {'synthetic_only': True, 'productionAcceptance': False, 'source_revision': manifest['source_revision'],
           'product_revision': inherited['product_revision'], 'product_bytes_unchanged': True,
           'stage_manifest_sha256': sha(stage / 'stage-manifest.json'), 'runner_sha256': sha(Path(__file__)),
           'no_provider_credential': True, 'browser_only': True, 'inherited': inherited,
           'browser_preflight': browser, 'steps': [], 'started_at': time.time()}
def save():
    (out / 'runner-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
def run(label, argv, timeout=30):
    started = time.time()
    step = {'step': label, 'started_at': started, 'timeout_s': timeout}
    receipt['steps'].append(step)
    save()
    proc = None
    with tempfile.TemporaryFile(dir=scratch) as log:
        try:
            proc = subprocess.Popen(argv, cwd=app, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            step['pid'] = proc.pid
            try:
                step['exit_code'] = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                step['timed_out'] = True
                os.killpg(proc.pid, signal.SIGKILL)
                step['exit_code'] = proc.wait(timeout=10)
        finally:
            if proc is not None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                    step['process_group_cleaned'] = True
                except ProcessLookupError:
                    step['process_group_cleaned'] = True
            log.seek(0, 2)
            size = log.tell()
            step['log_bytes'] = size
            log.seek(0)
            data = log.read(1024 * 1024)
            if size > 2 * 1024 * 1024:
                log.seek(-1024 * 1024, 2)
                data += b'\n[bounded log: middle omitted]\n' + log.read()
                step['log_truncated'] = True
            else:
                data += log.read()
            (out / (label + '.log')).write_bytes(data)
            step['duration_s'] = time.time() - started
            save()
    if step.get('exit_code') != 0:
        raise RuntimeError('Synthetic browser continuation step failed: ' + label)
    return data.decode(errors='replace')
try:
    actual = run('browser-version', [str(executable), '--version']).strip()
    if browser['browser_version'] not in actual:
        raise RuntimeError('Installed browser version does not match Playwright')
    run('browser-module-preflight', [node, '-e', "const p=require(process.env.QA_PLAYWRIGHT);console.log(JSON.stringify({chromium:p.chromium.name(),playwright:require(process.env.QA_PLAYWRIGHT+'/package.json').version}));"])
    run('local-test-certificate', ['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=synthetic-loopback-only', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', str(stage / 'fixture-key.pem'), '-out', str(stage / 'fixture-cert.pem')])
    run('browser-recovery', [node, 'qa-desktop-recovery.cjs'], timeout=240)
    result = json.loads((out / 'browser-recovery.json').read_text())
    if result.get('passed') is not True or len(result['tests']) != 2 or result['pageErrors']:
        raise RuntimeError('Complete desktop and narrow browser verdict required')
    receipt['passed'] = True
except BaseException as error:
    receipt['failure'] = {'type': type(error).__name__, 'message': str(error)}
    raise
finally:
    (stage / 'fixture-key.pem').unlink(missing_ok=True)
    receipt['finished_at'] = time.time()
    receipt['artifacts'] = {p.name: sha(p) for p in out.iterdir() if p.is_file() and p.name != 'runner-receipt.json'}
    save()
    print(json.dumps(receipt, indent=2))
