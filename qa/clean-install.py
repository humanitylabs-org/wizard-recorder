"""Disposable clean-install proof. Runs only on the designated external build volume."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import urllib.error

parser=argparse.ArgumentParser()
parser.add_argument('--image',required=True)
parser.add_argument('--root',type=Path,required=True)
args=parser.parse_args()
root=args.root.resolve()
if not str(root).startswith('/Volumes/ThalesMedia/'):
    raise SystemExit('Clean-install proof must use the external build volume')
root.mkdir(parents=True,exist_ok=False)
evidence=root/'evidence'; evidence.mkdir()
data=root/'data';data.mkdir()
models=root/'models';models.mkdir();models.chmod(0o777)
project='recorder-proof-'+str(os.getpid())
compose=root/'compose.json'
services={
 'transcriber':{'image':'ghcr.io/speaches-ai/speaches@sha256:2fedebb4b4dccd37ab8f233374ae32bd5b11ee96e8033d2a0a230b9cd052e409',
                'ports':['127.0.0.1::8000'],'environment':{'WHISPER__COMPUTE_TYPE':'int8','HF_HUB_CACHE':'/var/tmp/hf'},
                'user':'0:0','volumes':['models:/var/tmp/hf']},  # test-only fixture: root so the fresh named cache volume is writable
 'wizard-recorder':{'image':args.image,'user':'1000:1000','read_only':True,'tmpfs':['/tmp'],'cap_drop':['ALL'],
                    'security_opt':['no-new-privileges:true'],'ports':['127.0.0.1::8080'],
                    'environment':{'TRANSCRIPTION_URL':'http://transcriber:8000/v1/audio/transcriptions',
                                   'TRANSCRIPTION_MODEL':'Systran/faster-whisper-tiny.en'},
                    'volumes':[str(data)+':/data']}}
# Named volume: Colima bind mounts are not writable by the speaches user.
compose.write_text(json.dumps({'services':services,'volumes':{'models':{}}},indent=2))
cmd=['docker','compose','-p',project,'-f',str(compose)]

def run(argv,**kw):
    print('+',' '.join(argv),flush=True)
    return subprocess.run(argv,check=True,**kw)

def ctl(*parts):
    return run(cmd+list(parts),capture_output=True,text=True).stdout.strip()

def request(url,body=None,*,method=None,content_type='application/json',timeout=60):
    if isinstance(body,dict):body=json.dumps(body).encode()
    req=urllib.request.Request(url,data=body,headers={'Content-Type':content_type},method=method)
    with urllib.request.urlopen(req,timeout=timeout) as r:
        result=r.read()
        return json.loads(result) if r.headers.get('Content-Type','').startswith('application/json') else result

def ready(url,seconds=180):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        try:return request(url)
        except (OSError,ValueError):time.sleep(2)
    raise RuntimeError('Not ready: '+url)

def rpc(method,params=None):
    return request(base+'/mcp',{'jsonrpc':'2.0','id':1,'method':method,'params':params or {}})

try:
    # Use the disposable image to set volume ownership, without changing the app image or owner files.
    run(['docker','run','--rm','--user','0','--entrypoint','chown','-v',str(data)+':/data',args.image,'1000:1000','/data'])
    ctl('up','-d')
    app_port=ctl('port','wizard-recorder','8080').split(':')[-1]
    tx_port=ctl('port','transcriber','8000').split(':')[-1]
    base='http://127.0.0.1:'+app_port+'/wizard-recorder'
    stt='http://127.0.0.1:'+tx_port
    assert ready(base+'/healthz')['ok'] is True
    assert request(base+'/api/meetings')=={'meetings':[]}
    assert b'<title>Recorder' in request(base+'/')
    caps=request(base+'/capabilities.js').decode()
    for feature in ('realtime','summaries','agent','orb'):assert f'"{feature}":false' in caps
    # A fake Router URL/grant advertises features; actual readiness belongs to Router needs.
    # This exec is an isolated module probe, not a second app or a live install mutation.
    probe=ctl('exec','-T','-e','NODE_ENV=test','-e','WIZARD_ROUTER_URL=http://fake-router:8802',
              '-e','WIZARD_ROUTER_GRANT=synthetic-grant','wizard-recorder','node','--input-type=module','-e',
              "import('/app/view/server.mjs').then(({capabilities})=>console.log(JSON.stringify(capabilities())))")
    configured=json.loads(probe)
    assert configured['realtime'] is True and configured['summaries'] is True
    assert configured['agent'] is False and configured['orb'] is False
    evidence.joinpath('router-capabilities.json').write_text(json.dumps(configured,indent=2))
    ready(stt+'/health')
    request(stt+'/v1/models/Systran/faster-whisper-tiny.en',b'',method='POST',timeout=600)
    # TTS generation runs here, on the build machine, using only synthetic fixture text.
    script='apt-get update -qq && apt-get install -y -qq --no-install-recommends espeak-ng >/dev/null && espeak-ng -v en-us -s 135 -w /qa/speech.wav "The purple bicycle is parked beside the library. We will meet on Friday to discuss the garden project. Please bring the blue notebook to our meeting."'
    run(['docker','run','--rm','--user','0','--entrypoint','sh','-v',str(root)+':/qa',args.image,'-c',script])
    speech=(root/'speech.wav').read_bytes();assert speech[:4]==b'RIFF'
    m=request(base+'/api/uploads?title=Clean%20install%20speech',speech,content_type='audio/wav');mid=m['id']
    end=time.monotonic()+600
    while time.monotonic()<end:
        m=request(base+'/api/meetings/'+mid)
        if m['status']=='ready' and m['segments']:break
        time.sleep(2)
    else:raise RuntimeError('Real speech transcription did not finish: '+json.dumps(m))
    text=' '.join(s['text'] for s in m['segments'])
    print('REAL TRANSCRIPT:',text,flush=True)
    assert re.search(r'bicycle|library|Friday|garden|notebook',text,re.I),text
    evidence.joinpath('transcript.json').write_text(json.dumps(m,indent=2))
    term=next(t for t in ['library','bicycle','garden','notebook','Friday'] if t.lower() in text.lower())
    search=request(base+'/api/meetings?q='+term)
    assert mid in [x['id'] for x in search['meetings']]
    evidence.joinpath('search.json').write_text(json.dumps(search,indent=2))
    tools=rpc('tools/list')['result']['tools'];assert len(tools)==6
    transcript=rpc('tools/call',{'name':'get_transcript','arguments':{'id':mid}})['result']
    assert not transcript['isError'] and transcript['structuredContent']['segments']
    evidence.joinpath('mcp.json').write_text(json.dumps({'tools':tools,'transcript':transcript},indent=2))
    audio=request(base+'/api/meetings/'+mid+'/audio.wav');assert audio[:4]==b'RIFF' and len(audio)>44
    exported=request(base+'/api/meetings/'+mid+'/export.md');assert term.lower().encode() in exported.lower()
    request(base+'/api/meetings/'+mid+'/notes',{'notes':'Persistence proof note','base_rev':0},method='PUT')
    env={**os.environ,'RECORDER_QA_BASE':base,'RECORDER_QA_MEETING':mid,'RECORDER_QA_EVIDENCE':str(evidence)}
    run(['node',str(Path(__file__).with_name('browser.mjs'))],env=env)
    ctl('restart','wizard-recorder')
    # Ephemeral host ports are reassigned on restart; re-resolve before checking persistence.
    base='http://127.0.0.1:'+ctl('port','wizard-recorder','8080').split(':')[-1]+'/wizard-recorder'
    ready(base+'/healthz')
    kept=request(base+'/api/meetings/'+mid)
    assert kept['notes']=='Persistence proof note' and kept['segments']==m['segments']
    assert request(base+'/api/meetings/'+mid+'/audio.wav')==audio
    container=ctl('ps','-q','wizard-recorder')
    inspected=subprocess.check_output(['docker','inspect',container],text=True)
    evidence.joinpath('container.json').write_text(inspected)
    ctl('stop','wizard-recorder');ctl('rm','-f','wizard-recorder')
    assert (data/'meetings.db').is_file() and any((data/'audio').rglob('*.wav'))
    result={'ok':True,'image':args.image,'project':project,'view':base+'/','meeting_id':mid,'real_transcript':text,
            'tools':len(tools),'restart_persisted':True,'removed_container_data_preserved':True,'evidence':str(evidence)}
    evidence.joinpath('result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
finally:
    try:
        evidence.joinpath('compose.log').write_text(ctl('logs','--no-color'))
        ctl('down','--remove-orphans')  # Deliberately no --volumes; bind data survives.
    except Exception as e:print('cleanup:',str(e),flush=True)
