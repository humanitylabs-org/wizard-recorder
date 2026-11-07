# Mizel.ai Recorder

Official Wizard OS app (id `mizel`). A recorder backend that starts empty: meetings, notes, audio upload, searchable transcripts, an HTTP API and MCP tools. No recordings, transcripts, calendars, credentials or model weights are included; speech recognition comes from the shared transcription provider.

`privacy: private` in `wizard.md` is a runtime promise: this app's recordings and transcripts are not readable by public agents.

## Install

Install **Mizel.ai** from the Wizard Store, or with the App Manager:

    wam install humanitylabs-org/wizard-recorder

Every install setting is optional. Defaults point at the shared Transcriber app (`http://transcriber:8000/v1/audio/transcriptions`, model `Systran/faster-whisper-small`) and the owner-authenticated Wizard ingress. Add trusted hosts or origins only if your ingress needs them.

## Use

Recording starts from the Wizard recorder on your device; write notes during or after recording. Upload audio files through `POST /api/uploads`. The server accepts raw uploads up to 100 MiB and six hours, then decodes them into 30-second WAV chunks before using the same shared-transcription queue. Transcripts are searchable and exportable as Markdown; audio remains playable.

Plain notes and transcripts work without a notes model. Optional notes enhancement/Ask uses owner-configured MEETINGS_LLM_URL, MEETINGS_LLM_MODEL and MEETINGS_LLM_KEY. Missing configuration returns an explicit 503 rather than pretending that a model ran. Calendar, Mizel imports and Anarlog imports are intentionally empty in this portable package; the original host service stays unchanged.

## Interfaces and storage

- `GET /healthz`, `GET /openapi.json`.
- HTTP API documented in `openapi.json` and `API.md`.
- Stateless Streamable HTTP MCP at `/mcp`; six tools documented in `SKILL.md`.
- SQLite, notes, transcript segments and audio chunks under `/data`, mapped to this app's persistent app-data volume. No owner/home or secret mounts.
- Native bridge: existing `wizardNative.meetings` start/stop/on callback contract remains; start also receives the installed view's `apiBaseUrl`. The existing bridge is selected only when it declares `capabilities.apiBaseUrl=true`; older bridges use browser capture to keep this installed app separate from the host recorder. Device-native routing remains a separate capability check.
- Host and Origin fences: same-host browser origins are accepted, extra origins and an optional host allowlist can be configured; app requests cannot select arbitrary filesystem input or remote audio URLs.
- App Back is exposed as the shell's canonical `__wizardCloseOverlay` hook and the native `__wosNativeBack` hook; nested Back returns to the list and root Back is consumed.

## Build and test

    python3 scripts/check_release.py
    python3 -m pip install -r app/requirements.txt pytest
    python3 -m pytest tests -q
    docker build -t ghcr.io/humanitylabs-org/wizard-recorder:0.2.0 .
    python3 tests/smoke_container.py --image ghcr.io/humanitylabs-org/wizard-recorder:0.2.0 --context default

Release images (linux/amd64 and linux/arm64) are built by the `Build, test and publish image` workflow. Private data never belongs in git or an image.

## License

GPL-3.0-only. See `LICENSE`.
