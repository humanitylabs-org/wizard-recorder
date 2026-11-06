"""Bounded synthetic Caddy/native/Router/agent replay on forum only.

PARITY_IMAGE is the candidate image. PARITY_OVERLAY=1 permits a clearly labelled
source-overlay proof using the prebuilt base while the candidate build is queued.
Nothing contacts owner services, changes gateway config or publishes an image.
"""
import json, os, pathlib, socket, subprocess, sys, time, uuid
root=pathlib.Path(__file__).resolve().parents[2]
assert str(root).startswith('/srv/work/') and socket.gethostname().startswith('forum'), 'Run only via the forum heavy worker'
docker=['docker']
image=os.environ['PARITY_IMAGE'];overlay=os.environ.get('PARITY_OVERLAY')=='1'
out=pathlib.Path(os.environ['PARITY_OUT']);out.mkdir(parents=True,exist_ok=True)
name='recorder-parity-'+uuid.uuid4().hex[:8];names=[]
def run(args,**kwargs):
    return subprocess.check_output(docker+args,text=True,stderr=subprocess.STDOUT,**kwargs).strip()
def container(role,image,args):
    n=name+'-'+role;run(['run','-d','--name',n,'--network',name,'--network-alias',role,*args,image,*({'fixture':['node','/app/fixture.mjs']}.get(role,[]))]);names.append(n);return n
def mount(src,dst):return ['--mount',f'type=bind,src={src},dst={dst},readonly']
try:
    try:run(['image','inspect','caddy:2-alpine'])
    except subprocess.CalledProcessError:run(['pull','caddy:2-alpine'],timeout=90)
    run(['network','create','--internal',name])
    fixture=container('fixture',image,mount(root/'qa/parity/fixture.mjs','/app/fixture.mjs'))
    args=['-e','RECORDER_ORB_EVENTS=1','-e','WIZARD_AGENTS_URL=http://fixture:9100/wizard/v1/agents','-e','WIZARD_ORB_API_URL=http://fixture:9100','-e','WIZARD_API_TOKEN=synthetic-token','-e','WIZARD_ROUTER_URL=http://fixture:9100','-e','WIZARD_ROUTER_GRANT=synthetic-grant','-e','TRANSCRIPTION_URL=http://fixture:9100/v1/audio/transcriptions','-e','RECORDER_FINISH_POLL_MS=250','-e','MEETINGS_AUTO_ENHANCE=0','-e','MEETINGS_ALLOWED_HOSTS=127.0.0.1:8080']
    if overlay:
        for p in (root/'app').glob('*.py'):args+=mount(p,'/app/'+p.name)
        for p in (root/'view').iterdir():
            if p.suffix in {'.js','.mjs'} and not p.name.startswith('test-'):args+=mount(p,'/app/view/'+p.name)
        args+=mount(root/'view/web','/app/view/web')
    recorder=container('recorder',image,args)
    caddy=out/'Caddyfile'
    caddy.write_text('''{\n admin off\n auto_https off\n}\n:8080 {\n import /etc/caddy/native-aliases.caddy\n handle /wizard-recorder/* {\n  reverse_proxy recorder:8080\n }\n handle /wizard/v1/agents {\n  reverse_proxy fixture:9100\n }\n handle /wizard/hermes/* {\n  uri strip_prefix /wizard/hermes\n  reverse_proxy fixture:9100\n }\n handle /qa/log {\n  reverse_proxy fixture:9100\n }\n}\n''')
    gateway=container('gateway','caddy:2-alpine',['-p','127.0.0.1::8080','-e','RECORDER_UPSTREAM=recorder:8080',*mount(caddy,'/etc/caddy/Caddyfile'),*mount(root/'docs/cutover/native-aliases.caddy','/etc/caddy/native-aliases.caddy')])
    # Only the gateway gets a host-facing bridge. Recorder and fixture remain egress-isolated.
    run(['network','connect','bridge',gateway])
    address=run(['port',gateway,'8080/tcp']);base='http://'+address
    import urllib.request
    for attempt in range(100):
        try:
            with urllib.request.urlopen(base+'/wizard-recorder/healthz',timeout=1) as r:
                if r.status==200:break
        except Exception:time.sleep(.1)
    else:raise RuntimeError('Isolated container startup timeout')
    env={**os.environ,'PARITY_BASE':base,'PARITY_OUT':str(out)}
    with (out/'browser.log').open('w') as log:
        subprocess.run(['node',str(root/'qa/parity/browser.cjs')],env=env,check=True,stdout=log,stderr=subprocess.STDOUT,timeout=100)
    info=json.loads(run(['image','inspect',image]))[0]
    (out/'runtime.json').write_text(json.dumps({'image':image,'imageId':info['Id'],'overlay':overlay,'sourceSHA':os.environ.get('SOURCE_SHA'),'gatewayMatcherFile':'docs/cutover/native-aliases.caddy','networkInternal':True},indent=2))
    print((out/'receipt.json').read_text())
finally:
    for n in reversed(names):
        try:(out/(n.rsplit('-',1)[-1]+'.log')).write_text(run(['logs',n]));run(['rm','-f',n])
        except subprocess.CalledProcessError:pass
    try:run(['network','rm',name])
    except subprocess.CalledProcessError:pass
