# Mizel desktop reconnect — demonstrated recovery defect

**A narrow recovery defect is fixed and locally regressed; the owner's original trigger is still unknown. Not deployed. Browser acceptance is staged for parent admission.** No production process, socket, capture, meeting API, recording state/events or private-agent content was changed/read.

## Exact base and reuse

- Branch `fix/mizel-desktop-reconnect-20261103`, preserved live snapshot at `a994cbb`, prior diagnostic at `db1a25ec3db145eecc166e4468fc168aeb3b9c8f`.
- Effective live service source remains the `7b4a3d1-owner-876c5c8b9a38-nodiar/adoptions/mizel-live` projection. All owner-identity/no-attribution overlays are preserved.
- Served `web/app.js`: 148446 bytes, SHA256 `4ceab05a6cde6ac666a8df7be515c448bd8b6a58ccb9080f568055424337a267`. Frontend and `server.mjs` remain unchanged by this repair.
- Shared capture: REUSE `WizardApp.capture.start`, the real `app-client.js` / `app-services.js`, and the existing `SharedMeeting` PCM/chunk tee. Capture hash `353ef40d6e1e0f527a7b46ebfe1db58201b3c4831e291499ee6012b2cccaba68` matches the previously served asset. No replacement capture stack.
- Theme: REUSE `WizardApp.theme` / Appearance v1 `--wz-*`. No visual changes. Browser rig uses the real Appearance host and skin CSS in a synthetic registered shell window; this is not a claim of full installed-shell or native-phone proof.
- Provider: REUSE pinned `tinfoil@1.2.1`, its actual OpenAI realtime SDK, and `voxtral-mini-4b-realtime`. No provider/model/privacy-route changes.

## Demonstrated defect and focused fix

The exact served `NativeRealtimeTranscriber` subscribes to SDK `error`, but ignores its underlying `socket.close`. The installed `OpenAIRealtimeWS` forwards socket `error` to its high-level emitter, **not socket `close`**. A peer/proxy shutdown can therefore leave an unusable stream installed without invoking `LiveSession.onProviderError`; no retry is scheduled. Closing during a final commit can instead strand shutdown until its 30-second final-transcript timeout. This is a demonstrated defect, not proof that it caused the owner's screenshot.

Focused production delta in `provider.js`:

1. Observe the actual SDK socket's close event and pass it through the existing guarded `failed()` path. This clears pending provider frames, not durable capture, and invokes the existing server's reconnect/backoff.
2. Retire stream ownership before intentional final/empty close. Normal rotation, empty stop, duplicate close and late old-stream events must not become errors against a successor.

No browser/UI/server-controller changes, no speculative opening-race rewrite.

`test-live-recovery.mjs` executes exact production provider/session class bodies with synthetic PCM and minimal SDK socket fakes. On the preserved provider: **four fail, one pass**. After patch: **five pass**. It covers close before session-created, during audio, awaiting final, normal rotation/empty close, and real `LiveSession` retry plus buffered PCM and resumed settled output. Local TAPs are retained in the task evidence directory. These are focused lightweight unit results, not browser/provider-network acceptance.

## Next admitted job (no provider credentials)

`tools/run-desktop-recovery-qa.py` is guarded to forum `/srv/work` and the native durable light lane. Parent must admit the prepared `submit-spec.json`; a staged directory is not admission.

It verifies the complete staged regular-file closure, replays the exact before-fails/after-passes regression, runs existing synthetic unit contracts, generates local libflite speech as 48 kHz mono WAV, creates an ephemeral loopback-only test certificate, and runs `qa-desktop-recovery.cjs`.

The browser rig:

- Serves the exact unchanged app assets, real shared capture worklet/client/services, Appearance host, and skin CSS locally.
- Uses a disposable Chromium fake-media device with that local synthetic WAV, real AudioWorklet resampling/16-bit mono PCM, IndexedDB custody, real `SharedMeeting` upload/readback/ack, and the unchanged `LiveSession`.
- Injects only the domain API/storage receipts and confidential network peer. The **actual installed OpenAI realtime SDK** connects to a loopback TLS WebSocket with the test certificate trusted explicitly; it is not a fake SDK or a changed production trust policy.
- The peer closes after three audio frames without sending an SDK error. Requires visible reconnect copy, later live status/settled words, same capture ID, valid 16 kHz WAV chunks, exact app-side PCM readback and cleared retained capture only after acknowledgement.
- Repeats at desktop and phone browser widths. Captures two live skin screenshots (`nebula`, `grove`) and outage screenshots; review these images before claiming visual acceptance. Phone width is not a native Android capture claim. Desktop system-audio picker/loopback audio and a real provider's long-lived outage remain separate unproved surfaces.
- Blocks non-loopback browser requests and never calls production services. No production recording is started/stopped. Output text, if any, is synthetic only.

Artifacts: `fault-before.log`, `fault-after.log`, `existing-contracts.log`, `browser-recovery.log`, `browser-recovery.json`, desktop/phone screenshots, and hashed `runner-receipt.json`. Review actual execution; do not infer pass from the staged harness. If this new browser harness fails, repair its demonstrated fixture defect or code defect and re-admit a new immutable head.

## Safe deployment mechanism (fail closed)

`tools/prepare-live-recovery-release.py --live-dir <effective source> --release-dir <new immutable directory>` prepares source only. It requires a clean committed worktree, checks the three known live source hashes, preserves all tracked overlay files, rejects unapproved serving deltas, checks the existing dependency pins, copies read-only candidate files and links the existing installed dependency tree. It writes a source/dependency receipt. **It never reloads, restarts, edits a service or grants permission to restart.** It can be exercised before an idle boundary because it does not touch live capture.

After actual browser PASS and screenshot review, the parent must first obtain a trusted, content-free receipt that desktop/native/shared capture is idle and there are no live sessions. Zero TCP sockets alone is NOT proof of idle capture (a disconnected browser may still record). Do not read meeting APIs/DBs/state to invent that receipt. With no authoritative receipt, leave the candidate staged and the current service running.

Only then preserve the current systemd drop-in, change the service's WorkingDirectory/ExecStart to the new immutable release while retaining all existing data paths, origin, model, owner and privacy settings; daemon-reload and restart once. Verify service-manager running/restart counters, allowlisted `/live-health` model values and exact authenticated static app/provider release hashes, then run the authorized installed desktop synthetic check without taking over an owner's session. Rollback uses the saved drop-in and previous immutable source, subject to the same idle gate. Do not remove either release or retained local capture during rollback. Parent must report custody of the owner's historical recording as unverified; synthetic custody proves only the tested fixture.

## Known limits

- Prior admitted healthy provider/unchanged-session canary is already complete; do not rerun it as a substitute for this fault/browser test.
- Original screenshot's provider error cause, actual system-audio sharing, real desktop permission/device behavior, and owner-recording custody are not established.
- Tailnet public hostname DNS was unavailable in this helper's live environment; capture was bound to the prior public-static hash and local static source snapshot. Shared client/services/Appearance snapshots have independent hashes; parent should confirm serving-route identity if their current host permits it.
- The full package suite was correctly blocked on the live VPS; only the specific changed lightweight regression and syntax checks were run locally. Full unit/browser work belongs to the admitted forum job.
