"""Recorder's Ready extension for the Wizard shell (wizard.ready-extension/1, issue 29).

The shell reads `ready.json` next to the app's address, then imports `shell.js?sha256=<digest>` and styles
`shell.css?sha256=<digest>` (wizard-ux docs/app-ready-extensions.md). The module runs inside the shell on the owner's
phone and desktop and sends finished meetings that are due for the Private agent from that device, so they no longer
wait until someone opens the Recorder screen. A request whose digest is not the exact bytes served is refused.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

CONTRACT = 'wizard.ready-extension/1'
FILES = {'shell.js': 'text/javascript; charset=utf-8', 'shell.css': 'text/css; charset=utf-8'}


def ready_dir() -> Path:
    if os.environ.get('RECORDER_READY_DIR'):
        return Path(os.environ['RECORDER_READY_DIR'])
    here = Path(__file__).resolve().parent
    return here / 'ready' if (here / 'ready').is_dir() else here.parent / 'ready'


def _read(name: str) -> bytes:
    p = ready_dir() / name
    if not p.is_file():
        raise HTTPException(404)
    return p.read_bytes()


def digest(name: str) -> str:
    return hashlib.sha256(_read(name)).hexdigest()


def declaration() -> dict:
    return {'contract': CONTRACT, 'module_sha256': digest('shell.js'), 'style_sha256': digest('shell.css')}


def install(app) -> None:
    @app.get('/ready.json')
    async def ready_json():
        return JSONResponse(declaration(), headers={'Cache-Control': 'no-store'})

    async def serve(name: str, request: Request):
        body = _read(name)
        if request.query_params.get('sha256') != hashlib.sha256(body).hexdigest():
            raise HTTPException(404, 'not this revision')
        return Response(body, media_type=FILES[name], headers={'Cache-Control': 'no-cache'})

    @app.get('/shell.js')
    async def shell_js(request: Request):
        return await serve('shell.js', request)

    @app.get('/shell.css')
    async def shell_css(request: Request):
        return await serve('shell.css', request)
