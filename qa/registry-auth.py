"""Scoped CI registry auth without macOS keychain discovery; fail closed on tags."""
import base64
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

folder=Path(os.environ['DOCKER_CONFIG'])
folder.mkdir(mode=0o700,parents=True,exist_ok=True)
auth=base64.b64encode((os.environ['GITHUB_ACTOR']+':'+os.environ['GHCR_TOKEN']).encode()).decode()
config={'auths':{'ghcr.io':{'auth':auth}},'cliPluginsExtraDirs':['/opt/homebrew/lib/docker/cli-plugins']}
file=folder/'config.json'
fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump(config,f)
before=json.loads(Path(os.environ['RUNNER_TEMP'],'evidence','package-before.json').read_text())
if str(before.get('status'))=='404':
    print('New private-repository package namespace; no existing version tags')
else:
    assert before['visibility']=='private'
    scope=urllib.parse.urlencode({'service':'ghcr.io','scope':'repository:humanitylabs-org/wizard-recorder:pull'})
    token_req=urllib.request.Request('https://ghcr.io/token?'+scope,headers={'Authorization':'Basic '+auth})
    with urllib.request.urlopen(token_req,timeout=30) as r:token=json.load(r)['token']
    for tag in ('0.3.4',os.environ['GITHUB_SHA']):
        req=urllib.request.Request('https://ghcr.io/v2/humanitylabs-org/wizard-recorder/manifests/'+tag,
                                   headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json'})
        try:
            with urllib.request.urlopen(req,timeout=30):
                raise RuntimeError('Refusing to overwrite an existing immutable tag: '+tag)
        except urllib.error.HTTPError as e:
            if e.code!=404:raise
        print('Tag absent:',tag)
