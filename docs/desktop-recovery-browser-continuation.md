# Desktop recovery: browser-only continuation

## Scope and reuse

EXTEND the existing `qa-desktop-recovery.cjs` harness. REUSE its production `LiveSession`, unchanged desktop/narrow assertions, real shared `WizardApp.capture`, the two existing Wizard skins and opaque-panel checks. NEW is a small admission-enforced browser-only runner; the already-passing fault/contracts/provider canaries must not be rerun.

Product bytes, provider route/model, frontend and shared capture bytes are unchanged. This is synthetic loopback browser evidence, not a real microphone/device receipt or production acceptance.

## Demonstrated failure and bounded repair

The first admitted browser run timed out waiting for the existing exact `Stop recording` role locator. It had no page errors, no completed viewport tests, and no screenshots. Therefore it did **not** distinguish a startup exception from fixture readiness/input/visibility. Do not label the root cause proven from that timeout.

Source inspection found two definite harness defects:

* The staged Playwright browser metadata requested Chromium revision **1193 / 140.0.7339.186**, while its runner forced installed revision **1248**. The continuation stages matching Playwright **1.64.1** and Chromium **1248 / 156.0.8078.4** and binds the installed executable hash. The admitted runner also checks its actual `--version`.
* The synthetic chunk endpoint returned `{ok:true}` without `stored:true`; the unchanged app's `Uploader.pump` requires `receipt.stored === true`. Correct the fixture receipt, not the product's durable-save assertion. This is a later save-path defect, not proof of the initial startup cause.

The original harness waited for attached HTML, not the synchronous hosted facade, app module boot or shared ownership-readiness pass. Wait for those positive preconditions without changing the real click, Stop locator, timeout, UI or capture behavior. Persist request/response/failure metadata (no bodies/headers), console errors, input hit/trusted-click information, synthetic UI and capture state plus screenshots before the first browser assertion, immediately after the real start click, and on any failure before cleanup. All diagnostic waits are bounded. Preserve the existing original assertion expressions exactly.

The second actual browser run remains a parent-admitted action. If it hard-fails again, inspect its saved startup/failure evidence and consult Opus before another attempt; do not blindly retry or weaken assertions.

## Inherited receipts

Original source: `82aa3adc45604050ee0179129b7d0a87b17c3765`.
Original admitted job: `heavy_6513e2b25fa447499272f1bcc6c5fdd3`.
Original stage: `/srv/work/mizel-desktop-recovery-82aa3ad`.

| Artifact | SHA-256 | Verdict inherited, not rerun |
|---|---|---|
| `runner-receipt.json` | `d9850ab2a53e16452473793319c5be065bc4159aaecbeff55d6fd34cbca9d045` | mixed run, browser failed |
| `fault-before.log` | `dc95afd6413162483c6f3b390ee80606952df0482ed6faf706f016d06d7b7f00` | expected exit 1, pass 1 / fail 4 |
| `fault-after.log` | `9774c56f79594f60600367b25f4be203f6d94724a9fb2aa36b2b1ff734097e21` | pass 5 / fail 0 |
| `existing-contracts.log` | `6fe4793bce4257e932be7e865a53c0ae05decd69abd08c770cf58c7f72d7b19c` | pass 61 / fail 0 / skip 0 |
| `browser-recovery.json` | `98bc8be0c2af0f21fad6deb8e2563257bdff4ed4e21b5d20c02eed3bb019a2fc` | startup timeout; not a passing receipt |
| original worker log | `94cebeec746f73b829e962a76bf95992da322e1c41776480b3633e4ee4ba8acc` | exit 1 |

The continuation copies and verifies original receipts/logs plus their original source closure, verifies product identity, reuses the synthetic WAV, creates only an ephemeral local test TLS key, and runs the browser only. Its manifest binds source, dependencies, shared assets, inherited evidence, runner, and preflight. Process-group cleanup and partial receipts survive browser timeouts; the test TLS key is removed in `finally`.

## Capture-idle mechanism: source-only finding, not a live receipt

Existing shipped shared code already owns the correct **in-page** truth:

* `app-capture.js:29-54`: `WizAppCapture.getState()` has active/recording/hold/phase, ownership/registry-ready flags and errors. Do **not** return its raw object: it also contains identifiers. No need to call `pending()`, read IndexedDB, or inspect recordings.
* `app-capture.js:1041-1061`: `reloadCheck()` blocks preparations, uncertain native ownership and desktop capture. `safe:true` alone is insufficient: an Android recording may survive reload and be named in `keeps`.
* `app-services.js:483-490` and `:667-679`, exported at `:792`: `WizAppServices.update.busy()` and `reloadPlan()` include active capture and app save/unsaved-work holds. A capture that has stopped but is still saving can remain busy.
* `server.mjs:611`: `/live-health` reports service/model/build metadata only. It has **no capture-idle proof**. Neither it nor zero WebSockets authorizes a restart.

An existing trusted owner-page executor can reduce these getters **inside that owning page**, returning only a fresh timestamp and Boolean `captureIdle`, `ownershipReady`, `noSaveHold`, `reloadSafe`, `keepsNothing`. Require all five true, known modules present, no capture error, idle phase, registry/ownership ready, and no active/recording/hold. Do not export identifiers, reasons, frame lists, DOM, events, recording/transcript data, pending results, or storage. A new throwaway browser's idle state is not James's desktop state. One client's receipt cannot establish that every other open client/device is idle, nor fence a new start after sampling.

No existing authenticated server-side, content-free, all-client receipt endpoint or start fence was found in the inspected exact app/shared source. This task deliberately does not inspect the owner's live browser/state or obtain a production receipt. Therefore activation stays blocked until the parent has a trusted fresh receipt/owner attestation covering the relevant desktop/other clients and an agreed no-new-recording window.

Minimal James-only step after browser tests pass: **“Finish any recording, wait until saving has finished, then tell me ‘Ready to update Mizel.’ Leave Mizel idle until I confirm.”** Do not ask for meeting names/content. Do not treat this document or a synthetic receipt as activation permission.
