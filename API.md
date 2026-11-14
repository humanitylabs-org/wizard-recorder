# HTTP API

The installed view uses relative `api/` paths so it survives the Wizard proxy prefix. `/openapi.json` is the machine-readable contract and the root `openapi.json` is its generated snapshot.

Recording flow:

1. `POST /api/meetings` with `{"title":"Optional title"}` creates a recording session.
2. `POST /api/meetings/{id}/chunks?source=me&seq=0&start_ms=0` with WAV bytes uploads audio. `source` is `me` or `them`, WAV must be mono 16 kHz 16-bit PCM, at most 31 seconds per chunk. Media timestamps are bounded to six hours; playback is mixed through disk-backed files with bounded memory. Identical repeated chunks return success; same sequence with different bytes returns 409.
3. `POST /api/meetings/{id}/stop` with `{"final_seq":{"me":0}}` promises final chunk numbers and lets the worker finish. Read the meeting until status is ready; check failed chunk counts before reporting transcription complete.
4. `GET /api/meetings/{id}` returns notes, transcript segments, pending/failed counts and stored-audio status. `GET /api/meetings/{id}/audio.wav` supports ranges; `export.md` exports notes and transcript.

`PUT /api/meetings/{id}/notes` accepts `notes` and `base_rev`; a stale revision returns 409. `PATCH /api/meetings/{id}` changes title. `GET /api/meetings?q=term&limit=100` searches this app's content; limit is 1–200. `DELETE /api/meetings/{id}` marks a meeting deleted.

`POST /api/meetings/{id}/capture-events` with `{"event":"start_timeout","ms":10000,"detail":{}}` records one step of a microphone start (`start_requested`, `start_returned`, `first_level`, `first_pcm`, `first_chunk`, `start_timeout`, `start_failed`, `start_retry_wait`, `start_retry_fresh`) in the app log as `capture <id> <event> +<ms>ms`; `GET` on the same path returns the last 40 for that meeting (memory only, no audio or text). It makes a start that hangs on a phone visible from the box.

`POST /api/uploads?title=Clip` accepts raw audio bytes, bounded to 100 MiB. It decodes only local uploaded bytes, then creates a meeting and queues WAV chunks through the identical transcription path. Invalid audio returns 415 without creating a meeting.

`POST /api/meetings/{id}/enhance`, `POST /api/meetings/{id}/ask`, and `POST /api/ask` are optional owner-configured notes-model features. Unconfigured returns 503. `GET /api/calendar` returns an empty list in the portable package; no calendar credentials or imports are bundled.

All mutations require a trusted Origin (same-host or allowlisted) when a browser sends one, reject cross-site fetches, and apply the optional Host allowlist. Internal MCP uses the same routes through ASGI rather than duplicating recorder state changes.
