# Installed Mizel backend

This package adopts the live recorder behavior (e4c46d1 plus cf610d3: STT mode=meeting) and adds the existing stateless MCP adapter. The obsolete independent Meetings browser recorder is retired; the owner's existing Mizel Live view and Android native recorder continue using the unchanged /meetings/api routes. The package also accepts /api and /mcp at root on empty fresh installations.

Reuse:
- Recording view: REUSE the existing Mizel Live adoption; do not deploy the obsolete Meetings browser capture implementation.
- Native capture and chunk/stop lifecycle: REUSE the existing Android recorder protocol and live backend.
- App admission, registry and MCP discovery: REUSE Runtipi lifecycle, WAM registry.build and the Agent Service gateway.
- Agent app permissions: REUSE PUT /wizard/v1/apps/mizel/agents; never edit agent storage.
- UI platform functions: no new capture, chat, theme or Back implementation.

## Owner adoption override

Use a digest-pinned Python 3.12 image with an immutable read-only app-only source release and binary-wheel dependencies. No compilation or image build is required on the control-plane box. The ordinary Dockerfile remains the portable image-build recipe, for the configured build worker only.

Configure host networking, MEETINGS_HOST=127.0.0.1, MEETINGS_PORT=8973, MEETINGS_TIMEZONE=Asia/Bangkok and MEETINGS_EXTERNAL_VIEW=/mizel-live/. Preserve the live STT and LLM endpoints/models and inject its LLM credential through the owner-only Runtipi user-config API. Set exact trusted hosts/origins. Bind only the recorder data directory for writable state. Existing chunk records contain absolute paths: mount the data directory at the same absolute target path and set MEETINGS_DATA_DIR to it, so old audio continues to resolve without rewriting records. The source repository contains no owner paths or credentials.

The stock-image override uses /app/app as working directory, PYTHONPATH=/app/vendor and /app/vendor/bin in PATH (vendored static ffmpeg). Fresh image installs continue to use /data and /web by default. Optional calendar/import integrations require explicit owner configuration; they do not gain mounts or access to other apps automatically.

Before cutover, create a SQLite .backup and a SHA256 audio listing. Stop and disable the old service before starting the installed app; never run two transcription workers against the same database. Rollback stops the Runtipi app before re-enabling the old service. Uninstall must preserve the adopted owner data.

## Transcript tools

get_meeting returns all stored segments. get_transcript accepts id, offset (default 0) and limit (default 100, maximum 200); no segment text is shortened. Follow next_offset until has_more=false. total_segments is the authoritative count. search_meetings uses the recorder's full-text index over every nondeleted meeting's title, notes and transcript. It is not restricted to a recent list window. list/get/search do not initiate capture; start_recording only creates a session awaiting the owner's device.
