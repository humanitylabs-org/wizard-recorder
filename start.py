"""Container entry. Runtipi bind-mounts the app-data folder, and Docker creates a missing host folder as root,
so /data can arrive root-owned (or owned by an older uid). Give only that folder to uid 1000, drop every privilege, then
exec the server as uid 1000. Started as uid 1000 directly (docker volumes, tests) it skips the preparation."""
import os
import sys

UID = GID = 1000
DATA = os.environ.get('MEETINGS_DATA', '/data')


def prepare(root):
    # Only the data folder itself: Docker made it, so root owns it and needs no extra capability. Anything inside is
    # already uid 1000's (the server made it), and root without DAC_READ_SEARCH could not list a 0700 folder anyway.
    os.makedirs(root, exist_ok=True)
    if os.stat(root).st_uid != UID or os.stat(root).st_gid != GID:
        os.chown(root, UID, GID)


if os.geteuid() == 0:
    prepare(DATA)
    os.setgroups([])
    os.setgid(GID)
    os.setuid(UID)
    assert os.geteuid() == UID and os.getegid() == GID
    os.environ.setdefault('HOME', '/home/recorder')
os.execvp('uvicorn', ['uvicorn', 'server:app', '--host', '0.0.0.0', '--port', '8080'])
