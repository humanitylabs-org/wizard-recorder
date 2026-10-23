"""Run both app processes; any child failure terminates the container."""
import os
import signal
import subprocess
import sys
import time

children = []
stopping = False


def stop(signum=None, frame=None):
    global stopping
    stopping = True
    for child in children:
        if child.poll() is None:
            child.terminate()


for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, stop)
try:
    children.append(subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '8081']))
    children.append(subprocess.Popen(['node', 'view/server.mjs']))
    while not stopping and all(c.poll() is None for c in children):
        time.sleep(.25)
    code = next((c.returncode for c in children if c.returncode is not None), 0)
finally:
    stop()
    for child in children:
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
sys.exit(code or 0)
