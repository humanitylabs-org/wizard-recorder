"""Trusted-ref worker entry; isolate GHCR auth and serialize on the worker lock."""
import base64
import fcntl
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

assert os.environ['GITHUB_REPOSITORY']=='humanitylabs-org/wizard-recorder'
assert os.environ['GITHUB_EVENT_NAME'] in {'push','workflow_dispatch'}
assert os.environ['GITHUB_REF']=='refs/heads/main' or os.environ['GITHUB_REF'].startswith('refs/tags/v')
lock=Path(os.environ['WIZARD_WORKER_LOCK'])
with lock.open('a') as held:
    fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
    with tempfile.TemporaryDirectory(prefix='recorder-auth-',dir=os.environ['RUNNER_TEMP']) as auth:
        config=Path(auth)/'config.json'
        config.write_text(json.dumps({'auths':{'ghcr.io':{'auth':base64.b64encode((os.environ['GITHUB_ACTOR']+':'+os.environ['GH_TOKEN']).encode()).decode()}},'cliPluginsExtraDirs':os.environ.get('DOCKER_CLI_PLUGIN_DIRS','').split(':')}))
        config.chmod(0o600)
        env={**os.environ,'DOCKER_CONFIG':auth}
        args=[sys.executable,'scripts/release_images.py','--commit',os.environ['GITHUB_SHA'],'--output',str(Path(os.environ['RUNNER_TEMP'])/'recorder-release'),'--push-ghcr','--context',os.environ.get('RELEASE_DOCKER_CONTEXT','colima'),'--builder',os.environ.get('RELEASE_BUILDX_BUILDER','colima')]
        if os.environ['GITHUB_REF'].startswith('refs/tags/v'):args.append('--release-version')
        subprocess.run(args,env=env,check=True)
