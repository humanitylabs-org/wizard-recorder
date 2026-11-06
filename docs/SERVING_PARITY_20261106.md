# Serving-source Recorder candidate (6 November)

**Decision hold:** branch only. The owner is reconsidering a full app-ID/package
port versus a display-name-only rename. Nothing here authorizes either activation.
No service restart, live route edit, migration, private-agent send or image publication
was performed. The external build script is staged, not started.

REUSE — Current serving backend and complete adopted view/live service feature
inventory, not the stale owner image. The source-only baseline commit immediately
preceding this candidate preserves the selected serving bytes for reproducibility.
The live backend's five Python module hashes match its mounted release exactly.
The serving view was re-resolved after the new orb-save patch arrived.

EXTEND — Existing portable Recorder packaging (id `wizard-recorder`, name Recorder),
with the serving owner-identity/no-diarization prompts and Tinfoil re-attestation fix.
The direct private Tinfoil connection remains available from explicit inherited
configuration; a configured Router is selected instead, never used as an implicit
fallback after a provider failure. The backend also retains explicit private-model
endpoint configuration and empty-reasoning retry. Credentials are neither embedded
nor read. Reuse the owning shell's capture implementation; no Hermes/core edit.

EXTEND — Native protocol compatibility remains `/meetings/api/...` plus the legacy
orb journal alias, `kind:'meeting'`, adapter `wizard-meetings`, and the original
`wizardMizelPort` fallback. The live shell's phone-store soft-failure/orb-loan fix
therefore still applies. Historical protocol/data keys are not display names.

EXTEND — The latest serving `acknowledge()` behavior verifies canonical audio first,
then tries orb metadata up to four times with 1.5-second waits between attempts and
saves even if metadata remains unavailable. Audio/PCM/stop failures still retain
custody and block acknowledgement. Regression tests exercise missing metadata and
HTTP failure through the actual controller, not a replacement implementation.

Preserved: orb mic loan, New recording orb, live words/outline, installed-agent
routing and Private default when installed, device-only private send boundary,
save/retry/delete, summary collapse, owner framing, update holds, native chunks,
stop/final_seq/readback and journal PUT. Backend missing declarations are only
`_llm_key` (env resolution now in model_client) and `_import_loop` (retained import
helpers under `_maintenance_loop`); Markdown imports remain data-local.

## Evidence and limits

- Targeted Python: 18 passed, 1 deselected (new serving/identity/legacy-endpoint,
  Router refusal, copied-path migration and audio traversal cases).
- Targeted Node: 14 passed (provider/Router owner prompts, re-attestation, native
  contract and agent packets); save-state suite: 12 passed.
- Current serving backend + view `app-parity-gate`: PASS, no waivers. Verified
  label-renames in `qa/serving-renames.txt` are name changes, not feature removals.
- Full Python/Node suites and baked-image/browser/device acceptance are **not yet
  run**. The live-server guard refused broad suites; the staged forum script runs
  them, builds a new local immutable-SHA image, and replays the isolated native/
  Router/agent harness with `overlay=false`. It never publishes or deploys.
- No phone/desktop in-shell screenshot acceptance is claimed. A static inventory
  PASS is not proof of real device behavior. Cutover stays blocked pending the
  owner's rename decision and those external receipts.

No recording content, transcript, summary, live state/events, private-agent history
or Messenger data was opened. Only source, selected runtime metadata and hashes
were inspected. Cutover/rollback instructions stay with the local staged script.
