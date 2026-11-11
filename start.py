"""Container entry. Runtipi bind-mounts the app-data folder, and Docker creates a missing host folder as root,
so /data can arrive root-owned (or owned by an older uid). Prepare only that folder, drop every privilege, then
exec the server as uid 1000. Started as uid 1000 directly (docker volumes, tests) it skips the preparation."""
import os
import sys

UID = GID = 1000
DATA = os.environ.get('MEETINGS_DATA', '/data')


def prepare(root):
    os.makedirs(root, exist_ok=True)
    for path, dirs, files in os.walk(root):
        for name in (path, *(os.path.join(path, n) for n in (*dirs, *files))):
            info = os.lstat(name)
            if (info.st_uid, info.st_gid) != (UID, GID):
                os.lchown(name, UID, GID)


if os.geteuid() == 0:
    prepare(DATA)
    os.setgroups([])
    os.setgid(GID)
    os.setuid(UID)
    assert os.geteuid() == UID and os.getegid() == GID
    os.environ.setdefault('HOME', '/home/recorder')
os.execvp('uvicorn', ['uvicorn', 'server:app', '--host', '0.0.0.0', '--port', '8080'])
