"""Fail the source gate on owner coupling or retired package identifiers."""
from pathlib import Path
import re
import subprocess

root=Path(__file__).resolve().parents[1]
files=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
owner=re.compile('|'.join(re.escape(''.join(parts)) for parts in [
    ('te','los'),('tail','c0f369'),('wizard','001'),('ja','mes'),('Bang','kok'),('Archi','medes'),('/h','ome/'),('/Us','ers/')]),re.I)
retired=re.compile('|'.join(re.escape(''.join(parts)) for parts in [('mi','zel'),('meeting','-recorder'),('Meeting',' Recorder')]),re.I)
matches=[]
for name in files:
    if not name or not (root/name).is_file():continue
    try:text=(root/name).read_text()
    except UnicodeError:continue
    for number,line in enumerate(text.splitlines(),1):
        if owner.search(line):matches.append(f'{name}:{number}: owner coupling')
        if retired.search(line) and name!='app/migrate_data.py' and not (name=='README.md' and line.startswith('Historical note:')):
            matches.append(f'{name}:{number}: retired identifier')
print('Source files checked:',len([x for x in files if x and (root/x).is_file()]))
print('Matches:',len(matches))
for match in matches:print(match)
raise SystemExit(bool(matches))
