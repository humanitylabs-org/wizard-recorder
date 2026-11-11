"""The Recorder live screen (issue #1), served by this app behind the off-by-default `live-screen` switch.

live/ is the screen James uses every day (live words, Ask cards, live summary, close recovery, Appearance v1). It is a
small Node service; this module runs it inside the Recorder container on a loopback port and proxies `/live/` (HTTP and
the `/live/live` WebSocket) to it, so the normal store install serves it and no separate host service is needed.

Off (the default): nothing changes. `/` answers as before, `/live/` is 404 and no Node process runs.
On: `/` redirects to `live/`, and the Node service starts (it also keeps running for phone follow mode and finished
recordings while the page is closed). Turning the switch off stops it.

Everything owner-specific comes from the install, never from code: the realtime key and models, the main agent's name
and endpoint, the time zone and the owner name (see runtipi/config.json form fields).
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import socket
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import Request, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

SWITCH = 'live-screen'
BASE = '/live'
HOP = {'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization',
       'proxy-authenticate', 'host', 'content-length', 'origin', 'cookie', 'authorization', 'referer'}


def port() -> int:
    return int(os.environ.get('MIZEL_LIVE_PORT') or 8976)


def live_dir() -> Path:
    return Path(os.environ.get('MIZEL_LIVE_DIR') or Path(__file__).resolve().parent.parent / 'live')


def missing() -> list[str]:
    """What the screen still needs before it can start, in owner words."""
    out = []
    if not (os.environ.get('TINFOIL_API_KEY') or '').strip():
        out.append('a live words key (Tinfoil API key)')
    if not shutil.which(os.environ.get('MIZEL_LIVE_NODE') or 'node') or not (live_dir() / 'server.mjs').is_file():
        out.append('the live screen files in this image')
    return out


def node_env(data: Path) -> dict:
    """The Node service's environment: install settings only, nothing read from a home directory."""
    home = data / 'live'
    home.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k in (
        'PATH', 'LANG', 'TZ', 'TINFOIL_API_KEY', 'MIZEL_LIVE_REALTIME_MODEL', 'MIZEL_LIVE_SUMMARY_MODEL',
        'MIZEL_AGENT_NAME', 'MEETINGS_OWNER_NAME', 'MEETINGS_TIMEZONE', 'WIZARD_API_URL', 'WIZARD_ORB_API_URL',
        'WIZARD_AGENTS_URL', 'WIZARD_ORB_QUEUE_DB', 'MIZEL_DEFAULT_AGENT', 'MIZEL_LIVE_DRY', 'MIZEL_LIVE_DRY_AGENTS')}
    for k in [k for k, v in env.items() if not str(v).strip()]:
        env.pop(k)
    key = (os.environ.get('WIZARD_AGENT_KEY') or '').strip()
    if key:
        env['API_SERVER_KEY'] = key
    env.update({
        'HOME': str(home), 'MIZEL_LIVE_DATA': str(home), 'MIZEL_LIVE_BASE': BASE, 'MIZEL_LIVE_PORT': str(port()),
        'MEETINGS_DATA_DIR': str(data), 'MEETINGS_HOST': '127.0.0.1',
        'MEETINGS_PORT': str(os.environ.get('MIZEL_LIVE_UPSTREAM_PORT') or 8080),
        # The proxy below has already checked the browser's origin; Node only ever sees its own loopback origin.
        'MIZEL_ALLOWED_ORIGINS': '',
    })
    return env


class Runner:
    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.lock = asyncio.Lock()
        self.data: Path | None = None
        self.error = ''

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _listening(self) -> bool:
        with contextlib.suppress(OSError), socket.create_connection(('127.0.0.1', port()), timeout=0.3):
            return True
        return False

    async def ensure(self, data: Path) -> bool:
        async with self.lock:
            if self.running() and self._listening():
                return True
            if missing():
                return False
            if not self.running():
                self.data = data
                env = node_env(data)
                with open(Path(env['MIZEL_LIVE_DATA']) / 'server.log', 'ab') as log:
                    self.proc = subprocess.Popen([os.environ.get('MIZEL_LIVE_NODE') or 'node', 'server.mjs'],
                                                 cwd=live_dir(), env=env, stdout=log, stderr=log,
                                                 stdin=subprocess.DEVNULL)
            for _ in range(100):
                if self._listening():
                    self.error = ''
                    return True
                if not self.running():
                    self.error = f'The live screen stopped while starting (exit {getattr(self.proc, "returncode", None)}).'
                    return False
                await asyncio.sleep(0.1)
            self.error = 'The live screen did not start in time.'
            return False

    def stop(self):
        p, self.proc = self.proc, None
        if p and p.poll() is None:
            p.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                p.wait(5)
            if p.poll() is None:
                p.kill()


runner = Runner()


def origin_ok(headers, allowed_origins) -> bool:
    """Same rule as the app's write guard: same-host origins, or ones the owner added in the install."""
    origin = headers.get('origin')
    if not origin:
        return True
    host = (headers.get('host') or '').lower()
    o = urlsplit(origin)
    return origin in allowed_origins or (o.scheme in ('http', 'https') and o.netloc.lower() == host)


def install(app, *, data: Path, switch_on, host_ok, allowed_origins):
    """Add the switch-gated /live/ proxy, the /live/live WebSocket and the watchdog to the FastAPI app."""
    def off():
        return JSONResponse({'error': 'The live screen is off. Turn on "Live screen" in this app\'s Try changes.',
                             'code': 'switch_off', 'switch': SWITCH}, 404)

    def needs(what):
        items = ''.join(f'<li>{w}</li>' for w in what)
        return HTMLResponse('<!doctype html><meta charset="utf-8"><title>Recorder</title><h1>Live screen not ready</h1>'
                            f'<p>The live screen needs:</p><ul>{items}</ul>'
                            "<p>Add it in the Recorder app's settings, then open this page again.</p>", 503)

    @app.get(BASE, include_in_schema=False)
    async def live_slash():
        return RedirectResponse('live/', 308) if switch_on(SWITCH) else off()

    methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']

    @app.api_route(BASE + '/', methods=methods, include_in_schema=False)
    async def live_index(request: Request):
        return await live_proxy('', request)

    @app.api_route(BASE + '/{rest:path}', methods=methods, include_in_schema=False)
    async def live_proxy(rest: str, request: Request):
        if not switch_on(SWITCH):
            runner.stop()
            return off()
        if not await runner.ensure(data):
            return needs(missing() or [runner.error or 'a restart of the app'])
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
        if request.headers.get('origin'):
            headers['origin'] = f'http://127.0.0.1:{port()}' if origin_ok(request.headers, allowed_origins) else 'null'
        url = f'http://127.0.0.1:{port()}{BASE}/{rest}'
        client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=5))
        try:
            up = await client.send(client.build_request(request.method, url, params=request.query_params,
                                                        headers=headers, content=await request.body()), stream=True)
        except httpx.HTTPError as e:
            await client.aclose()
            return JSONResponse({'error': f'Live screen unreachable: {type(e).__name__}'}, 502)
        out = {k: v for k, v in up.headers.items() if k.lower() not in HOP and k.lower() != 'content-encoding'}

        async def close():
            await up.aclose()
            await client.aclose()
        if request.method == 'HEAD':
            await close()
            return Response(status_code=up.status_code, headers=out)
        return StreamingResponse(up.aiter_raw(), status_code=up.status_code, headers=out, background=BackgroundTask(close))

    @app.websocket(BASE + '/live')
    async def live_socket(ws: WebSocket):
        if not switch_on(SWITCH) or not host_ok(ws.headers) or not ws.headers.get('origin') \
                or not origin_ok(ws.headers, allowed_origins):
            await ws.close(code=1008)
            return
        if not await runner.ensure(data):
            await ws.close(code=1013)
            return
        import websockets
        try:
            upstream = await websockets.connect(f'ws://127.0.0.1:{port()}{BASE}/live', max_size=256 * 1024,
                                                origin=f'http://127.0.0.1:{port()}', open_timeout=5)
        except (OSError, websockets.WebSocketException):
            await ws.close(code=1011)
            return
        await ws.accept()

        async def browser_to_live():
            while True:
                msg = await ws.receive()
                if msg['type'] == 'websocket.disconnect':
                    return
                if msg.get('bytes') is not None:
                    await upstream.send(msg['bytes'])
                elif msg.get('text') is not None:
                    await upstream.send(msg['text'])

        async def live_to_browser():
            async for msg in upstream:
                if isinstance(msg, bytes):
                    await ws.send_bytes(msg)
                else:
                    await ws.send_text(msg)
        tasks = [asyncio.create_task(browser_to_live()), asyncio.create_task(live_to_browser())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in tasks:
                t.cancel()
            with contextlib.suppress(Exception):
                await upstream.close()
            with contextlib.suppress(Exception):
                await ws.close()

    async def watchdog():
        # Starts the service at boot when the switch is on (phone follow mode, finished recordings), stops it when off.
        while True:
            with contextlib.suppress(Exception):
                if switch_on(SWITCH):
                    if not runner.running() and not missing():
                        await runner.ensure(data)
                elif runner.running():
                    runner.stop()
            await asyncio.sleep(10)

    @app.on_event('startup')
    async def _live_start():
        app.state.live_watchdog = asyncio.create_task(watchdog())

    @app.on_event('shutdown')
    async def _live_stop():
        task = getattr(app.state, 'live_watchdog', None)
        if task:
            task.cancel()
        runner.stop()
    return app
