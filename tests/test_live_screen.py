"""The imported live screen (live/) keeps its own Node tests green (issue #1)."""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

LIVE = Path(__file__).resolve().parents[1] / 'live'
# Pure Node tests that pass against the served bytes. node:sqlite needs Node >= 22.5.
GREEN = ['test-agent-router.mjs', 'test-live-recovery.mjs', 'test-no-system-audio-prompt.mjs',
         'test-orb-events.mjs', 'test-recording-retry.mjs', 'test-recording-start-timeout.mjs']
SQLITE = ['test-orb-authority.mjs']


def node_version():
    node = shutil.which('node')
    if not node:
        return None
    m = re.match(r'v(\d+)\.(\d+)', subprocess.check_output([node, '--version'], text=True))
    return (int(m[1]), int(m[2])) if m else None


def test_live_screen_is_tracked_and_portable():
    for name in ['server.mjs', 'provider.js', 'owner-identity.mjs', 'web/index.html', 'web/app.js',
                 'web/wizard-appearance.js', 'package.json', 'package-lock.json']:
        assert (LIVE / name).is_file(), name
    # The live summary keeps its no-speaker-attribution rule.
    assert 'noAttributionPrompt' in (LIVE / 'server.mjs').read_text()
    # No owner tailnet address is baked in; origins come from MIZEL_ALLOWED_ORIGINS.
    assert 'MIZEL_ALLOWED_ORIGINS' in (LIVE / 'server.mjs').read_text()


def test_live_screen_node_tests():
    v = node_version()
    if v is None or v < (20, 0):
        pytest.skip('node >= 20 not installed')
    files = GREEN + (SQLITE if v >= (22, 5) else [])
    r = subprocess.run(['node', '--test', *files], cwd=LIVE, capture_output=True, text=True, timeout=240)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
