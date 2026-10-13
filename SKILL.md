---
name: meeting-recorder
description: Use when recording meetings or searching their notes and transcripts.
---

# Meeting Recorder

Call the installed app through Wizard's MCP gateway; discover its prefix with tools/list.

- list_meetings: newest saved recordings; optional limit 1–200.
- search_meetings: query titles, notes and transcripts; optional limit 1–200.
- get_meeting and get_transcript: pass the exact meeting id returned by list/search.
- start_recording: create a session with an optional title. It returns capture=awaiting_device: the owner starts the microphone in the app. Never report that this tool activated a microphone.
- stop_recording: requests the connected device to stop and flush audio. `capture=awaiting_device_ack` means capture has not yet confirmed stopping; poll get_meeting until processing/ready and inspect pending/failed counts. A session with no active device finalizes immediately.

Open the installed view to record, write notes or upload an audio file. API: GET/POST /api/meetings, GET /api/meetings/{id}, POST /api/meetings/{id}/chunks (WAV, source, seq, start_ms), POST /api/meetings/{id}/stop, POST /api/uploads (raw audio), GET /api/meetings/{id}/export.md. Duplicate identical chunks are safe; conflicting chunks return 409. Notes use PUT with base_rev to avoid overwrites.

Transcription uses the box's selected transcription slot. Resolve it from apps.json and configure TRANSCRIPTION_URL and TRANSCRIPTION_MODEL at install; uses:[transcriber] installs today's default. No models or credentials are embedded. Recordings persist only in app-data. A fresh install imports nothing, and uninstall preserves data. Optional notes/Ask requires owner-configured MEETINGS_LLM_URL, MODEL and KEY; plain notes and transcripts work without it.
