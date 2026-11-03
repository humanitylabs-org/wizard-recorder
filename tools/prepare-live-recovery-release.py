#!/usr/bin/env python3
"""Prepare an immutable source-only release. NEVER restart/reload a live service.
Dependencies are linked read-only to the existing release; no credentials/state read.
Cutover requires separately verified browser proof and a trusted idle-capture receipt.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--live-dir', required=True)
parser.add_argument('--release-dir', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
app = root / 'adoptions/mizel-live'
live = Path(args.live_dir).resolve()
release = Path(args.release_dir)
if release.exists() or not release.is_absolute():
    raise SystemExit('New absolute immutable release directory required')
expected = {
    'web/app.js': '4ceab05a6cde6ac666a8df7be515c448bd8b6a58ccb9080f568055424337a267',
    'server.mjs': '1eac22450c582c7c77edbb0e69a275d0ed4b606cda0d9e689454e6387eb42ecc',
    'provider.js': 'fcdd6ea100af1295e061eee1d3b6fc60af6fd5b2c91d206f9674ea6afabfc2fd',
}
def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
for name, wanted in expected.items():
    if sha(live / name) != wanted:
        raise SystemExit('Live source drift; rebase/preserve before staging: ' + name)
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root).strip():
    raise SystemExit('Committed, clean source required')
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
files = subprocess.check_output(['git', 'ls-files', '-z', 'adoptions/mizel-live'], cwd=root).decode().split('\0')
closure = {}
# Preserve *all* tracked adopted assets, including owner identity/no-attribution overlays.
for relative in filter(None, files):
    p = root / relative
    if p.is_symlink() or not p.is_file():
        raise SystemExit('Unexpected source entry: ' + relative)
    name = str(p.relative_to(app))
    if name not in {'provider.js', 'package.json'} and (live / name).is_file() and sha(p) != sha(live / name):
        raise SystemExit('Unapproved serving delta: ' + name)
    closure[name] = sha(p)
modules = live / 'node_modules'
if not modules.is_dir():
    raise SystemExit('Existing pinned dependencies missing')
for name, version in [('tinfoil', '1.2.1'), ('ws', '8.21.3')]:
    if json.loads((modules / name / 'package.json').read_text())['version'] != version:
        raise SystemExit('Dependency pin differs: ' + name)
release.mkdir(parents=True, mode=0o755)
for name in closure:
    p = release / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes((app / name).read_bytes())
    p.chmod(0o444)
os.symlink(str(modules), release / 'node_modules')
receipt = {'source_revision': revision, 'files': closure, 'previous_source': str(live),
           'dependency_link': str(modules), 'service_changed': False, 'restart_permitted': False,
           'remaining_gates': ['admitted browser proof and screenshot review', 'trusted content-free capture-idle receipt', 'exact served hash readback after cutover']}
(release / 'release-manifest.json').write_text(json.dumps(receipt, indent=2) + '\n')
(release / 'release-manifest.json').chmod(0o444)
print(json.dumps(receipt, indent=2))
