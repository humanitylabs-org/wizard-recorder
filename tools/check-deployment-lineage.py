#!/usr/bin/env python3
"""Read-only source preservation gate before a service deployment.

Resolve the actual service directory (not a remembered checkout); require clean
tracked source, the deployed revision, and the current approved base in candidate.
This complements behavioral regression tests; ancestry cannot detect a bad edit.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def inspect(directory):
    directory = Path(directory).resolve()
    root = Path(git(directory, 'rev-parse', '--show-toplevel')).resolve()
    prefix = directory.relative_to(root).as_posix()
    if prefix == '.':
        prefix = ''
    sha = git(root, 'rev-parse', 'HEAD')
    scope = prefix or '.'
    dirty = git(root, 'status', '--porcelain', '--untracked-files=normal', '--', scope)
    if dirty:
        raise ValueError('Deployment source has uncommitted or untracked files: ' + str(directory))
    manifest = {}
    files = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z', '--', scope]).decode().split('\0')
    for file in filter(None, files):
        p = root / file
        if p.is_symlink():
            raise ValueError('Deployment source contains a symlink: ' + file)
        if p.is_file():
            manifest[str(p.relative_to(directory))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return root, prefix, sha, manifest


def check(live, candidate, required_base):
    lr, lp, ls, lm = inspect(live)
    cr, cp, cs, cm = inspect(candidate)
    if lp != cp:
        raise ValueError('Deployment projection differs; reconcile explicitly before release')
    for name, revision in [('deployed', ls), ('approved base', required_base)]:
        full = git(cr, 'rev-parse', '--verify', revision + '^{commit}')
        r = subprocess.run(['git', '-C', str(cr), 'merge-base', '--is-ancestor', full, cs], capture_output=True)
        if r.returncode:
            raise ValueError('Candidate omits ' + name + ' revision ' + full)
    return {'ok': True, 'deployed_revision': ls, 'candidate_revision': cs,
            'approved_base': git(cr, 'rev-parse', required_base + '^{commit}'),
            'projection': cp, 'live_manifest': lm, 'candidate_manifest': cm,
            'changed_files': sorted(p for p in lm.keys() | cm.keys() if lm.get(p) != cm.get(p))}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument('--unit', help='Actual user systemd service; reads its WorkingDirectory')
    src.add_argument('--live-directory', help='Explicit source, for non-systemd hosts and tests')
    p.add_argument('--candidate-directory', required=True)
    p.add_argument('--base-ref', required=True, help='Fresh local remote-tracking ref, e.g. origin/feature/agent-binding')
    p.add_argument('--receipt', help='Optional successful JSON receipt path')
    a = p.parse_args()
    try:
        live = a.live_directory
        if a.unit:
            live = subprocess.check_output(['systemctl', '--user', 'show', a.unit, '-p', 'WorkingDirectory', '--value'], text=True).strip()
            if not live:
                raise ValueError('Service has no explicit WorkingDirectory')
        candidate = Path(a.candidate_directory)
        remote, branch = a.base_ref.split('/', 1)
        local = git(candidate, 'rev-parse', a.base_ref)
        upstream = git(candidate, 'ls-remote', '--exit-code', remote, 'refs/heads/' + branch).split()[0]
        if local != upstream:
            raise ValueError('Approved base ref is stale; fetch and integrate before release')
        result = check(live, candidate, local)
        if a.receipt:
            Path(a.receipt).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    except (ValueError, subprocess.CalledProcessError, IndexError) as e:
        p.exit(1, 'SOURCE PRESERVATION BLOCKED: ' + str(e) + '\n')


if __name__ == '__main__':
    main()
