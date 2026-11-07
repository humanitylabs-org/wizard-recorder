"""Cheap release contract and tracked-source portability checks."""
import ast
import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
config = json.loads((root/'runtipi/config.json').read_text())
version = config['version']
manifest = (root/'wizard.md').read_text()
compose = (root/'runtipi/docker-compose.yml').read_text()
assert config['id'] == 'mizel' and 'id: mizel\n' in manifest
assert 'name: Mizel.ai\n' in manifest and 'privacy: private\n' in manifest
assert not re.search(r'^shares:', manifest, re.M)
assert 'version: '+version+'\n' in manifest
assert 'source: https://github.com/humanitylabs-org/wizard-recorder\n' in manifest
assert config['source'] == 'https://github.com/humanitylabs-org/wizard-recorder'
assert 'ghcr.io/humanitylabs-org/wizard-recorder:'+version+'\n' in compose
assert json.loads((root/'openapi.json').read_text())['info']['version'] == version
module = ast.parse((root/'app/server.py').read_text())
assert any(isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'VERSION' for t in n.targets)
           and ast.literal_eval(n.value) == version for n in module.body)
assert not re.search(r'"version":\s*"\d', (root/'app/package_routes.py').read_text())
for field in config['form_fields']:
    assert not field.get('required') or 'default' in field or field['type'] == 'password'
    assert 'default' in field, field['env_variable']
# Construct machine markers from pieces so the guard also checks its own source.
forbidden = ['/'+'home'+'/'+'telos', 't'+'s.net', '/'+'home'+'/'+'thales', 'meeting'+'-recorder']
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
failures = []
for name in filter(None, files):
    try:
        text = (root/name).read_text()
    except UnicodeError:
        continue
    for i, line in enumerate(text.splitlines(), 1):
        if any(marker in line for marker in forbidden):
            failures.append(f'{name}:{i}')
assert not failures, 'Nonportable tracked source: '+', '.join(failures)
print('PASS: release versions, private manifest, no shares, optional form defaults, tracked-source portability')
