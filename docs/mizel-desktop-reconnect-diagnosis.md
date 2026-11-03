# Mizel desktop reconnect — synthetic diagnosis handoff

Status: **not fixed; root cause not established**. This branch first preserves the exact currently served source and stages the next synthetic diagnostic. No production process, socket, capture, meeting API or stored recording was changed/read.

## Exact base

- Effective service source: `mizel-live.service` drop-in selects the `7b4a3d1-owner-876c5c8b9a38-nodiar` release's `adoptions/mizel-live` projection, not the familiar `mizel-live` development checkout or registry commit.
- Snapshot base: `a994cbb` on `fix/mizel-desktop-reconnect-20261103`. This includes all seven owner-identity/no-attribution overlay files absent/different at `7b4a3d1`; existing development edits and open identity PR are untouched.
- Public authenticated app JS GET: HTTP 200, 148446 bytes, SHA256 `4ceab05a6cde6ac666a8df7be515c448bd8b6a58ccb9080f568055424337a267`, identical to exact service source. Shared capture GET: HTTP 200, 79463 bytes, SHA256 `353ef40d6e1e0f527a7b46ebfe1db58201b3c4831e291499ee6012b2cccaba68`.
- Registry SHA `80a45fd6cabe156d5dbe9698e6eb5f207f423d2c` is not this frontend's source identity.

## Observations

- The reported copy comes specifically from `LiveSession.onProviderError` in the served `server.mjs`, which sends `status {live:false, retrying:true}` after a confidential-provider error. It is not the browser WebSocket retry copy. This localizes the symptom to provider/session recovery, without establishing why the error happened.
- A separate empty session through the exact deployed `TinfoilProvider`, SDK 1.2.1 and selected `voxtral-mini-4b-realtime` successfully resolved, emitted `session.created`, and closed. It used no meeting socket or content. This rules out a total setup outage only at that probe instant, not PCM/rotation failures.
- Service remains running with existing connections. No restart/reload/deployment is safe to assume during capture. Independent durable custody remains unverified because private recording state is sealed.

## Reuse

- Capture: REUSE `WizardApp.capture.start` and the existing `SharedMeeting` PCM/chunk tee; do not build a local capture stack.
- Theme: REUSE `WizardApp.theme` / `--wz-*`; preserve dark standalone fallback and opaque text panels. No new visual behavior is proposed by this diagnostic.
- Live transport: REUSE the exact existing `TinfoilProvider` and extracted unchanged `LiveSession` for synthetic localization. Domain state, summaries and fake downstream socket are inert fixtures; this is not full live-browser or custody acceptance.

## Next admitted diagnostic

`tools/run-live-reconnect-diagnostic.py` requires forum and native durable-worker admission. It verifies staged hashes, generates local libflite synthetic 16 kHz mono PCM, then drives both the exact provider and production `LiveSession` class across multiple six-second commits at realtime pace. It never opens a production meeting API, database, live state/events or private-agent home. All results are synthetic; output excludes transcript text and redacts its disposable key. The disposable credential file is removed in finally.

Inspect `evidence/diagnostic.json`, `synthetic-events.json`, `provider-and-session.log`, and `runner-receipt.json`. Failure messages there come solely from synthetic traffic. Use that actual error to choose the narrow repair; do not land a speculative race workaround. If not reproduced, next test is the actual shared browser capture path with synthetic media and intercepted dynamic/write routes, not owner's audio or logs.

## Remaining gates

1. Parent admits the staged forum spec (helpers cannot admit heavy work); the staged job is not yet queued.
2. Actual synthetic failure/root cause; narrow fix and before-fails/after-passes regression.
3. Full shared-capture synthetic PCM, durable custody, outage/recovery and existing feature tests; source preservation/parity gate.
4. If frontend changes, actual in-shell two-skin screenshots with synthetic data only; dark standalone fallback; opaque text overlays.
5. Only at a verified content-free safe idle boundary, authorized immutable deployment with rollback, served asset/hash readback and actual installed desktop-path verification. No active-recording restart.
