"""Reject owner-host coupling while retaining required native/history compatibility.

Former app IDs are protocol/data identifiers: banning them caused the native
bridge regression. Historical agent labels are exercised as fixture data only;
production labels and routing choices must come from the installed registry.
"""
from pathlib import Path
import re
import subprocess
root=Path(__file__).resolve().parents[1]
files=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
owner_host=re.compile('|'.join(re.escape(''.join(parts)) for parts in [
    ('tail','c0f369'),('wizard','001'),('/h','ome/'),('/Us','ers/')]),re.I)
owner_name=re.compile('|'.join(re.escape(''.join(parts)) for parts in [
    ('Archi','medes'),('Philo','sopher'),('Asia/','Bangkok')]))
matches=[]
for name in files:
    if not name or not (root/name).is_file():continue
    try:text=(root/name).read_text()
    except UnicodeError:continue
    fixture=name.startswith(('tests/','qa/')) or '/test-' in name or '/qa-' in name
    for number,line in enumerate(text.splitlines(),1):
        if owner_host.search(line):matches.append(f'{name}:{number}: owner host/path coupling')
        if not fixture and owner_name.search(line):matches.append(f'{name}:{number}: owner agent/default coupling')
print('Source files checked:',sum(bool(x and (root/x).is_file()) for x in files))
print('Matches:',len(matches))
for match in matches:print(match)
raise SystemExit(bool(matches))
