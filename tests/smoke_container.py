"""Exercise an already-built hardened image; no owner data, no recordings, no model calls."""
import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid

p = argparse.ArgumentParser()
p.add_argument('--image', required=True)
p.add_argument('--context', default='colima')
a = p.parse_args()
docker = ['docker', '--context', a.context]


def run(*args):
    return subprocess.check_output([*docker, *args], text=True).strip()


name = 'wizard-recorder-smoke-'+uuid.uuid4().hex[:12]
volume = name+'-data'
run('volume', 'create', volume)
try:
    # A new daemon volume (and a Docker-created bind-mount folder) is root-owned. Started as Runtipi starts it, the entry
    # must give only /data to uid 1000 and drop root before serving.
    run('run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--user', '0:0',
        '--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
        '--security-opt', 'no-new-privileges:true', '--memory', '512m',
        '-e', 'TRANSCRIPTION_URL=http://127.0.0.1:9/unused', '-p', '127.0.0.1::8080', '-v', volume+':/data', a.image)
    base = 'http://'+run('port', name, '8080/tcp').splitlines()[0]

    def request(path, body=None, headers=None, method=None):
        h = {'Content-Type': 'application/json', **(headers or {})}
        req = urllib.request.Request(base+path, data=None if body is None else json.dumps(body).encode(), headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def wait():
        for _ in range(60):
            try:
                if request('/healthz')[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(.5)
        raise AssertionError('Container health did not become ready')

    wait()
    health = json.loads(request('/healthz')[1])
    assert health['app'] == 'mizel' and health['ok'] is True
    assert json.loads(request('/api/meetings')[1]) == {'meetings': []}
    rpc = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}
    code, body = request('/mcp', rpc)
    assert code == 200 and len(json.loads(body)['result']['tools']) == 6
    # Browser writes: foreign origin refused, same-host origin accepted.
    assert request('/api/meetings', {}, {'Origin': 'https://foreign.example.invalid'})[0] == 403
    assert request('/api/meetings', {}, {'Sec-Fetch-Site': 'cross-site'})[0] == 403
    code, body = request('/api/meetings', {'title': 'Smoke fixture'}, {'Origin': base})
    assert code == 200, (code, body)
    mid = json.loads(body)['id']
    run('restart', name)
    base = 'http://'+run('port', name, '8080/tcp').splitlines()[0]
    wait()
    assert [m['id'] for m in json.loads(request('/api/meetings')[1])['meetings']] == [mid]
    state = run('exec', name, 'python', '-c', "from pathlib import Path;print(Path('/proc/1/status').read_text())")
    fields = dict(line.split(':', 1) for line in state.splitlines() if ':' in line)
    assert set(fields['Uid'].split()) == {'1000'} and int(fields['CapEff'].strip(), 16) == 0
    run('exec', name, 'ffmpeg', '-version')
    print(json.dumps({'passed': True, 'image': a.image, 'checks': [
        'health', 'empty list', 'MCP 6 tools', 'foreign-origin 403', 'cross-site 403', 'same-host origin write',
        'restart retention', 'Uid 1000', 'CapEff 0', 'ffmpeg present']}))
finally:
    subprocess.run([*docker, 'rm', '-f', name], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([*docker, 'volume', 'rm', volume], check=True, stdout=subprocess.DEVNULL)
