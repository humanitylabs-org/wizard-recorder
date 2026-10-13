# Meeting Recorder

Private Wizard OS app, starting empty. It packages the existing Meetings recorder and the audio-upload workflow without recordings, transcripts, calendars, sync configuration, credentials or model weights.

## Install

Use the current App Manager and an account permitted to read this private repo. Resolve the selected transcription provider in the box's apps.json; today's default is the transcriber app.

    wam install humanitylabs-org/meeting-recorder \
      --set TRANSCRIPTION_URL=http://transcriber:8000/v1/audio/transcriptions \
      --set TRANSCRIPTION_MODEL=Systran/faster-whisper-small \
      --set MEETINGS_ALLOWED_ORIGINS=https://your-wizard.tailnet.ts.net \
      --set MEETINGS_ALLOWED_HOSTS=your-wizard.tailnet.ts.net

The repo-qualified private install route is supported today. Short-name installation (`wam install meeting-recorder`) needs a catalog entry or private-id mapping; publication is separately gated. The private image must be available locally or readable by the box's GitHub login. This candidate's Docker build and installation evidence are produced on Thales.

## Use

Open the installed app in Wizard. Start a meeting and grant microphone access; write notes during or after recording. Upload audio using the quiet sidebar control. The server accepts raw uploads up to 100 MiB and six hours, then decodes them into 30-second WAV chunks before using the same shared-transcription queue. Transcripts are searchable and exportable as Markdown; audio remains playable.

Plain notes and transcripts work without a notes model. Optional notes enhancement/Ask uses owner-configured MEETINGS_LLM_URL, MEETINGS_LLM_MODEL and MEETINGS_LLM_KEY. Missing configuration returns an explicit 503 rather than pretending that a model ran. Calendar, Mizel imports and Anarlog imports are intentionally empty in this portable package; the original host service stays unchanged.

## Interfaces and storage

- `GET /healthz`, `GET /openapi.json`.
- HTTP API documented in `openapi.json` and `API.md`.
- Stateless Streamable HTTP MCP at `/mcp`; six tools documented in `SKILL.md`.
- SQLite, notes, transcript segments and audio chunks under `/data`, mapped to this app's persistent app-data volume. No owner/home or secret mounts.
- Native bridge: existing `wizardNative.meetings` start/stop/on callback contract remains; start also receives the installed view's `apiBaseUrl`. The existing bridge is selected only when it declares `capabilities.apiBaseUrl=true`; older bridges use browser capture to keep this installed app separate from the host recorder. Device-native routing remains a separate capability check.
- Host and Origin fences require explicit shell origins and hostnames at install; app requests cannot select arbitrary filesystem input or remote audio URLs.
- The existing two-pane recorder/editor layout and serif document type are retained. The template's appearance v1 client supplies colors, transparent hosted canvas and live updates. Dark standalone fallback; all five accepted skins supported.
- App Back is exposed as the shell's canonical `__wizardCloseOverlay` hook and the native `__wosNativeBack` hook; nested Back returns to the list and root Back is consumed.

## Build and test

Build/test on the configured heavy worker (Thales), in a disposable Linux VM.

    docker build -f app/Dockerfile -t ghcr.io/humanitylabs-org/meeting-recorder:0.1.0 .
    python3 -m pytest tests -q
    python3 /path/to/wizard-app-manager/wam/wizardmd.py .

`SOURCE_PROVENANCE.json` identifies the recorder revision and the hello-wizard template revision. The Docker context is an explicit code-only allowlist. `qa/` contains reproducible acceptance scripts; receipts distinguish fixture tests from real speech recognition, hosted browser use and Hermes tool calls. Private data never belongs in git or an image.
