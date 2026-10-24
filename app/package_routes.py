"""Portable upload and stateless Streamable HTTP MCP over the recorder's public API."""
from __future__ import annotations
import asyncio
import io
import json
import tempfile
import wave
from pathlib import Path
import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response


def tool(name, description, properties=None, required=()):
    return {"name": name, "description": description, "inputSchema": {
        "type": "object", "properties": properties or {}, "required": list(required), "additionalProperties": False}}

ID = {"type": "string", "pattern": "^[A-Za-z0-9_-]{3,64}$"}
TOOLS = [
    tool("list_meetings", "List recordings in this app, newest first.", {"limit": {"type": "integer", "minimum": 1, "maximum": 200}}),
    tool("get_meeting", "Read one saved meeting with notes, audio status and transcript.", {"id": ID}, ["id"]),
    tool("search_meetings", "Search titles, notes and transcript text in this app only.", {"query": {"type": "string", "minLength": 1, "maxLength": 200}, "limit": {"type": "integer", "minimum": 1, "maximum": 200}}, ["query"]),
    tool("start_recording", "Create a recording session. Device capture starts when the owner presses Record in the view; this tool never silently opens a microphone.", {"title": {"type": "string", "maxLength": 160}}),
    tool("stop_recording", "Request an active device to stop and flush audio. Await awaiting_device_ack until status becomes processing/ready; sessions without an active device finalize immediately.", {"id": ID}, ["id"]),
    tool("get_transcript", "Read full untruncated transcript in segment pages. Follow next_offset until has_more=false. Defaults offset=0, limit=100; max limit=200. No segment text is shortened.", {"id": ID, "offset": {"type":"integer", "minimum":0, "maximum":2147483647}, "limit": {"type":"integer", "minimum":1, "maximum":200}}, ["id"]),
]


def validate(arguments, schema):
    import re
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    if set(arguments) - set(schema['properties']):
        raise ValueError("unknown argument")
    if set(schema['required']) - set(arguments):
        raise ValueError("missing required argument")
    for k, value in arguments.items():
        s = schema['properties'][k]
        if s['type'] == 'integer':
            if type(value) is not int or not s.get('minimum', 0) <= value <= s.get('maximum', 200):
                raise ValueError(f"invalid {k}")
        elif not isinstance(value, str) or not s.get('minLength', 0) <= len(value) <= s.get('maxLength', 200):
            raise ValueError(f"invalid {k}")
        if 'pattern' in s and not re.fullmatch(s['pattern'], value):
            raise ValueError(f"invalid {k}")


def install_routes(app):
    async def call_api(method, path, **kwargs):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:8080') as client:
            r = await client.request(method, path, **kwargs)
            if not r.is_success:
                raise HTTPException(r.status_code, r.text[:200])
            return r.json()

    @app.get('/config.js')
    async def config_js():
        import server
        return Response('window.WizardAppHosts='+json.dumps(sorted(server.ALLOWED_ORIGINS))+';', media_type='text/javascript')

    @app.get('/healthz')
    async def healthz():
        return {"ok": True, "app": "wizard-recorder", "version": "0.3.5"}

    @app.get('/mcp')
    async def mcp_get():
        return JSONResponse({'error': 'Use POST /mcp'}, status_code=405, headers={'Allow': 'POST'})

    @app.post('/mcp')
    async def mcp(request: Request):
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            raise HTTPException(415, 'application/json required')
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 65536:
                raise HTTPException(413, 'MCP request exceeds 64 KiB')
        try:
            msg = json.loads(raw)
        except (ValueError, UnicodeError):
            return JSONResponse({'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':'Invalid JSON'}})
        if not isinstance(msg, dict) or msg.get('jsonrpc') != '2.0' or not isinstance(msg.get('method'), str):
            return JSONResponse({'jsonrpc':'2.0','id':None,'error':{'code':-32600,'message':'Invalid request'}})
        if 'id' not in msg:
            return Response(status_code=202)
        ident, method = msg['id'], msg['method']
        def error(code, message):
            return JSONResponse({'jsonrpc':'2.0','id':ident,'error':{'code':code,'message':message}})
        if method == 'initialize':
            result = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name':'wizard-recorder','version':'0.2.0'}}
        elif method == 'ping':
            result = {}
        elif method == 'tools/list':
            result = {'tools': TOOLS}
        elif method == 'tools/call':
            p = msg.get('params') or {}
            if not isinstance(p, dict):
                return error(-32602, 'params must be an object')
            name, arguments = p.get('name'), p.get('arguments', {})
            t = next((t for t in TOOLS if t['name'] == name), None)
            if not t:
                return error(-32602, 'Unknown tool')
            try:
                validate(arguments, t['inputSchema'])
            except ValueError as e:
                return error(-32602, str(e))
            try:
                if name in ('list_meetings','search_meetings'):
                    value = await call_api('GET', '/api/meetings', params={'q':arguments.get('query',''),'limit':arguments.get('limit',100)})
                elif name in ('get_meeting','get_transcript'):
                    value = await call_api('GET', '/api/meetings/'+arguments['id'])
                    if name == 'get_transcript':
                        offset, limit = arguments.get('offset', 0), arguments.get('limit', 100)
                        total = len(value['segments'])
                        page = value['segments'][offset:offset + limit]
                        more = offset + len(page) < total
                        value = {"id": value['id'], "status": value['status'], "segments": page,
                                 "offset":offset, "limit":limit, "total_segments":total,
                                 "has_more":more, "next_offset":offset + len(page) if more else None,
                                 "text": '\n'.join(s['text'] for s in page)}
                elif name == 'start_recording':
                    value = await call_api('POST', '/api/meetings', json={'title':arguments.get('title','')})
                    value['capture'] = 'awaiting_device'
                else:
                    value = await call_api('POST', '/api/meetings/'+arguments['id']+'/request-stop', json={})
                result = {'content':[{'type':'text','text':json.dumps(value,ensure_ascii=False)}], 'structuredContent':value, 'isError':False}
            except HTTPException as e:
                result = {'content':[{'type':'text','text':str(e.detail)}], 'isError':True}
        else:
            return error(-32601, 'Unknown method')
        return JSONResponse({'jsonrpc':'2.0','id':ident,'result':result})

    async def capture_control_schema():
        import server
        with server.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS capture_control (meeting_id TEXT PRIMARY KEY, lease_until REAL NOT NULL DEFAULT 0, stop_requested INTEGER NOT NULL DEFAULT 0)")

    @app.post('/api/meetings/{mid}/capture')
    async def capture(mid: str, request: Request):
        import server, time
        await capture_control_schema()
        with server.db() as db:
            m = server.meeting_detail(db, server._mid(mid))
            db.execute("INSERT INTO capture_control(meeting_id,lease_until) VALUES(?,?) ON CONFLICT(meeting_id) DO UPDATE SET lease_until=excluded.lease_until", (mid,time.time()+10))
            requested = db.execute("SELECT stop_requested FROM capture_control WHERE meeting_id=?",(mid,)).fetchone()[0]
        return {'stop_requested':bool(requested),'status':m['status']}

    @app.post('/api/meetings/{mid}/request-stop')
    async def request_stop(mid: str):
        import server, time
        await capture_control_schema()
        with server.db() as db:
            m = server.meeting_detail(db, server._mid(mid))
            row=db.execute("SELECT lease_until FROM capture_control WHERE meeting_id=?",(mid,)).fetchone()
            if row and row[0] > time.time() and m['status']=='recording':
                db.execute("UPDATE capture_control SET stop_requested=1 WHERE meeting_id=?",(mid,))
                return {'id':mid,'status':'stop_requested','capture':'awaiting_device_ack'}
        return await call_api('POST','/api/meetings/'+mid+'/stop',json={})

    upload_lock = asyncio.Semaphore(1)

    @app.post('/api/uploads')
    async def upload(request: Request, title: str = 'Uploaded recording'):
        # Decode untrusted audio in a restricted ffmpeg subprocess; never accept a filesystem path or URL.
        import server
        async with upload_lock:
            with tempfile.TemporaryDirectory(prefix='upload-', dir=server.DATA) as temp:
                src, dst = Path(temp)/'input', Path(temp)/'decoded.wav'
                count = 0
                with src.open('wb') as f:
                    async for chunk in request.stream():
                        count += len(chunk)
                        if count > 100 * 1024 * 1024:
                            raise HTTPException(413, 'Audio upload exceeds 100 MiB')
                        f.write(chunk)
                if not count:
                    raise HTTPException(400, 'empty audio')
                process = await asyncio.create_subprocess_exec(
                    'ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', str(src),
                    '-vn', '-t', '21601', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', str(dst),
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                try:
                    await asyncio.wait_for(process.wait(), 120)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    process.kill(); await process.wait()
                    raise
                if process.returncode:
                    raise HTTPException(415, 'Audio could not be decoded')
                with wave.open(str(dst),'rb') as w:
                    if not w.getnframes():
                        raise HTTPException(400, 'empty audio')
                    if w.getnframes()/w.getframerate() > 21600:
                        raise HTTPException(413, 'Audio exceeds six-hour limit')
                    m = await call_api('POST', '/api/meetings', json={'title':title[:160]})
                    seq = 0
                    while pcm := w.readframes(30*16000):
                        buf = io.BytesIO()
                        with wave.open(buf, 'wb') as chunk:
                            chunk.setnchannels(1); chunk.setsampwidth(2); chunk.setframerate(16000); chunk.writeframes(pcm)
                        await call_api('POST', f"/api/meetings/{m['id']}/chunks", params={'source':'me','seq':seq,'start_ms':seq*30000}, content=buf.getvalue(), headers={'Content-Type':'audio/wav'})
                        seq += 1
                return await call_api('POST', f"/api/meetings/{m['id']}/stop", json={'final_seq':{'me':seq-1}})
