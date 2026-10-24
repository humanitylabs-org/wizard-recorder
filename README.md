# Recorder

Private, installable Wizard OS audio recorder (`wizard-recorder`). One image serves
its own mobile view at `/wizard-recorder/`, API and six MCP tools. No separate host
view service is needed. Fresh installs contain no recordings or owner configuration.

Historical note: previously named Mizel.ai / meeting-recorder.

## Baseline — only a shared transcriber

- Record with the shared Wizard browser/native capture resource; 5-second durable
  audio chunks go to the box's OpenAI-compatible transcription slot. This is
  near-live transcription, not a realtime-provider dependency.
- Upload audio, edit notes, full-text search, export Markdown and play back audio.
- MCP at `/wizard-recorder/mcp`: list_meetings, get_meeting, search_meetings,
  start_recording, stop_recording and get_transcript. Capture tools request device
  participation; a headless MCP call does not claim to open a microphone.
- Browser microphone requires HTTPS or localhost, like any secure-context web app.
- WizardApp owns capture custody, skin updates, sharing and Back. Vendored core
  supplies the same resource standalone; see `view/VENDORED.md`.

## Install from the image

The package is private pending publication approval. Registry access is required.
Use Runtipi `runtipi/config.json` / `compose.yaml`, or start the image directly:

```sh
mkdir -p recorder-data
# The image runs as UID 1000. Make the data directory writable by that UID.
# On Linux, an administrator may need: chown 1000:1000 recorder-data
docker run --name wizard-recorder --network wizard-apps -p 8080:8080 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -v "$PWD/recorder-data:/data" \
  -e TRANSCRIPTION_URL=http://transcriber:8000/v1/audio/transcriptions \
  -e TRANSCRIPTION_MODEL=Systran/faster-whisper-small \
  ghcr.io/humanitylabs-org/wizard-recorder:0.3.5
```

The existing shared transcriber must be reachable on that Docker network. Its
model identifier is non-secret configuration. `MEETINGS_TIMEZONE` defaults to UTC.
No host files or home-directory defaults are read. The internal Python API listens
only on loopback; Node owns same-origin validation before proxying API and MCP.
Set `MEETINGS_ALLOWED_ORIGINS` to a comma-separated explicit allowlist if required
by an unusual reverse proxy; normal same-origin installs need no hostnames.

`/data` holds meetings.db, audio/, optional outlines/, orb-events.json and
agent-outbox/. Restart keeps data. Removing the container does not remove the bind
mount. Uninstall must preserve the directory. Protect and back up this private
volume; no public app or agent needs access to it. Do not publish its contents.

## Optional upgrades — off unless explicitly configured

| Upgrade | Configuration |
| --- | --- |
| Tinfoil realtime words | `TINFOIL_API_KEY` from the install form; never a host secrets file. Optional `RECORDER_REALTIME_MODEL`. Shared transcription remains durable truth. |
| Live outlines and recap | `WIZARD_ROUTER_URL` + app-scoped `WIZARD_ROUTER_GRANT`. Features `live-summary` and `recap` declare `private_data: true`. Approve a private provider in Wizard. SSE output is discarded without a valid completion/provenance. |
| Direct model alternative | Owner-set `MEETINGS_LLM_URL` (full chat/completions endpoint), `MEETINGS_LLM_MODEL`, optional `MEETINGS_LLM_KEY`. Owner is responsible for this endpoint's privacy. Router failures never silently fall back here. |
| Send to agent | `WIZARD_DELIVERY_URL` + `WIZARD_DELIVERY_TOKEN`, scoped by Wizard App → agent binding. No raw runtime API, agent selector or agent DB. Failed delivery stays queued with an idempotent key. |
| Orb meeting event projection | Set `RECORDER_ORB_EVENTS=1`. App-local event journal only; no host queue DB or implicit ingestion of agent messages. |

No LLM controls, live-provider sockets or agent-delivery controls appear in the
baseline. Audio capture, saving, transcription and playback do not wait for them.
A model route's declared tested_on identifier is inherited from the original
summary implementation; new portable Connection Router integration needs its own
configured-provider acceptance before claiming model quality.

## Move an existing data copy

Do not run migration against a running source install. Stop a *copy* of the old
meetings.db and audio/ tree, preserving their layout, then:

```sh
python app/migrate_data.py ./copied-data
python app/migrate_data.py ./copied-data --apply
```

Dry-run checks every audio reference without editing. Apply creates
pre-recorder-migration.db, then rewrites absolute chunk paths to relative audio/
paths in a transaction. Audio bytes and recording IDs are unchanged. Missing files,
traversal and symlinks outside audio/ fail closed. Running again is a no-op.
Runtime playback/transcription can resolve the old absolute audio suffix even
before rewriting. Restore from the backup only with the app stopped.

## Verification

```sh
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r app/requirements.txt pytest
.venv/bin/python -m pytest -q
npm --prefix view ci
npm --prefix view test
```

`qa/clean-install.py` is the destructive-to-its-own-project-only clean image proof:
new Compose project, shared Speaches, generated synthetic speech, upload, real
transcript/search/MCP, playback/export, image restart and volume retention. It must
run on the designated build machine; never point it at an owner's install.
`qa/browser.mjs` exercises 390px layouts, two skins, optional-feature hiding and
nested Back against that disposable instance.
