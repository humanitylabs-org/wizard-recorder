# Mizel Live shared-capture adoption (staged, not deployed)

This directory is the **actual Mizel Live UI + server**, not the portable package's root `web/`. It deliberately captures the existing uncommitted shared-capture adoption from the private host source at `215eee587cae70e3c105773698b29c42cdcf8a5b`; baseline file hashes are in `SOURCE_PROVENANCE.json`. Every source web asset was projected, including appearance and index changes and the already-deleted private worklet. QA screenshots and private data were not projected. The generic Python recorder remains in `app/`; no host service/config was overwritten.

## Deployment contract for the parent release owner

- Requires the matching wizard-ux `feature/mizel-orb-handoff-20261015` shell. Native ABI v1 requires the parent-owned real Android gate; old APKs refuse the handoff.
- Install from package-lock (`npm ci --ignore-scripts`), Node >=22.13; preserve existing host environment and persistent data directory. Do not run a second writer on the same `MIZEL_LIVE_DATA`.
- Keep `MEETINGS_PORT`, `WIZARD_API_URL`, `MIZEL_LIVE_DATA`, `MIZEL_LIVE_PORT`, and Tinfoil credentials as host config. Set `MIZEL_ALLOWED_ORIGINS` to the approved comma-separated shell origins; owner hostnames are not baked into source.
- **Set `WIZARD_ORB_API_URL` to the same authenticated service prefix the orb uses, including `/wizard/hermes` if applicable.** This is distinct from the raw `WIZARD_API_URL` used for existing manual asks. Queue/public run IDs must resolve through their issuing service, not a guessed raw-runtime endpoint. The existing `API_SERVER_KEY` authenticates reads; configure the service to accept it. Unreachable/mismatched routes leave the link pending and never cause another send.
- **Set `WIZARD_ORB_QUEUE_DB` to that issuing service's existing run-queue SQLite path on a co-located private host.** The adapter opens it read-only and verifies the exact run/session/idempotency/agent tuple before reading run output or thread history. No database contents are returned to the browser. Without this adapter, the selected upstream must return an affirmative matching `idempotency_key`; absent authority remains pending. Meeting-loan requests use normal queued admission, not steering another run (steering has no durable original-request receipt). No Hermes or Agent Service source change is required.
- Keep existing Tinfoil-only automatic meeting transcription/summary configuration. This adoption introduces **no automatic model call**: orb discussions and recap additions are deterministic projections. Node live automatic summary remains the copied `TinfoilProvider`, no fallback provider was added. Root generic Python provider config is not an instruction to replace the deployed private Tinfoil route.
- Mount existing shell SDK URLs `/wizard-os-home/core/{app-client,app-capture}.js` as before. Serve this directory's `web/`, not root package web.

## Durable event contract

`PUT /mizel-live/orb-events` from an allowed origin stores a revisioned meeting boundary and links the **existing** orb delivery. Identity fields cannot change. Disk persistence uses write/fsync/atomic rename/directory fsync. Duplicate or stale client revisions return the existing row. `GET ...?meetingId=<id>` is the readback authority. The shell journal keeps retries independent of the normal outbox, so link failures never resend the request. Capture acknowledgement requires matching persisted boundary, voice take and end timestamp.

A bounded background GET-only reconciliation reads the exact run and thread. If a run response includes a user-message ID it is retained. Current Hermes does not promise that field; otherwise a unique existing user message containing the exact uploaded audio ID in the service-generated `WIZARD_FILES_V1` attachment marker supplies the ID (numeric IDs are preserved). Ambiguous or missing matches remain unresolved, never guessed from text/time/latest message. The run ID and delivery key still link the exact request while message history is unavailable. Agent route is pinned as part of the event. This is not an inbox consumer and never POSTs `/v1/runs`.

`orb-events.json` is canonical for these links. A service restart retries pending answers and user-message resolution. Transcript cards are inserted at original media offsets; summary/export append an explicitly labelled **Archimedes discussions** section. Late answers update that projection, not frozen transcript/summary prose. Cancelled/local-only interruptions are not recap asks. The historical in-meeting manual Ask UI is preserved; orb events do not create another Ask submission.

## Isolated QA

All browser profiles, synthetic data, npm dependencies and execution belong on Thales `/Volumes/ThalesMedia`.

- `node --test test-orb-events.mjs`: storage/replay/identity/late-answer/error contracts.
- `node qa-http-ui.cjs`: actual server restart + HTTP + adopted mobile UI, all upstreams synthetic. Set `PLAYWRIGHT_MODULE`, `CHROMIUM`, `UI_EVIDENCE`, `UX_WEB` (matching UX web directory), `SOURCE_SHA`, `TMPDIR`.
- UX `qa-handoff/host.cjs`: actual host + real WebAudio/MediaRecorder/IDB, synthetic transport; includes parked reply and native **adapter mocks**, not Android proof. Set `MIZEL_ADOPTION` to this directory and `HOST_EVIDENCE`.

No deployment, live restart, physical-device install, default-branch merge or Mac guest rebuild is authorized by these tests.
