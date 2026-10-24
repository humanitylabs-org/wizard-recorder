# Recorder

Private, installable Wizard OS audio recorder (`wizard-recorder`). One image serves
its own mobile view at `/wizard-recorder/`, API and six MCP tools. No separate host
view service is needed. Fresh installs contain no recordings or owner configuration.

Historical note: previously named Mizel.ai / meeting-recorder.

## Durable capture and outage fallback

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
  ghcr.io/humanitylabs-org/wizard-recorder:0.4.0
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

## Required connections (0.4.0)

Wizard's shared setup checklist resolves the required needs in `wizard.md`:

- **Words appear as you speak:** private `live-transcription` service, recommending
  `wizard-tinfoil`. Another installed private provider can satisfy the same slot.
- **Live outline while you record:** `live-summary`, fast tier.
- **Summary when a recording ends:** `recap`, standard tier.

Both model features require text + streaming and private data handling; their
`tested_on` is `deepseek-v4-1-flash` with `swap: ask`. Setup and provider selection
belong to Wizard, not a second setup screen in Recorder. Tinfoil holds its own
credentials; Recorder has no provider keys, SDK or direct model endpoint.

The runtime supplies `WIZARD_ROUTER_URL` and app-scoped `WIZARD_ROUTER_GRANT`.
Recorder sends that grant only to the Router: WebSocket
`/v1/services/live-transcription/v1/live` and SSE model runs at
`/v1/models/live-summary/run` and `/v1/models/recap/run`. Models are never selected
in request bodies. SSE text stays provisional until a validated `done` with
provider/model/tier/tested_on/chosen/usage; errors or truncated streams discard it.
Live-outline JSON and transcript timestamps are validated before saving.

The live socket speaks `wizard.live-transcription/1`: start with PCM16 little-endian,
16 kHz mono, wait/buffer for ready, binary frames at most 64 KiB, commit at pauses,
stop then closed. Final captions are archived separately in `/data/live/`; they
never duplicate or overwrite the shared transcriber's durable segments. Outline
updates use those durable segments. A live-service outage never stops capture,
chunk uploads, batch transcription or playback. No Router credentials means live
and summary capabilities are false (useful for isolated recovery/acceptance);
required setup is normally enforced by the shell before opening the app.

Optional agent delivery still uses `WIZARD_DELIVERY_URL` + `WIZARD_DELIVERY_TOKEN`,
scoped by the app binding. Failed delivery stays queued with an idempotent key.
`RECORDER_ORB_EVENTS=1` enables app-local orb event projection. Neither integration
requires raw runtime APIs or a host agent database.

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
RECORDER_TEST_PYTHON="$PWD/.venv/bin/python" npm --prefix view test
python3 qa/scan-source.py
```

`qa/clean-install.py` is the destructive-to-its-own-project-only clean image proof:
new Compose project, shared Speaches, generated synthetic speech, upload, real
transcript/search/MCP, playback/export, image restart and volume retention. It must
run on the designated build machine; never point it at an owner's install.
`qa/browser.mjs` exercises 390px layouts, two skins, optional-feature hiding and
nested Back against that disposable instance.

Node integration tests run an in-process fake Router (WebSocket + SSE), a synthetic
shared-transcriber endpoint, the real Python API and the real Node bridge. They
prove buffered audio, captions/final archive, strict outline/recap admission, grant
headers, and continued chunk recording/transcription after live failure. These are
protocol proofs, not evidence of real-provider quality or an image build.
