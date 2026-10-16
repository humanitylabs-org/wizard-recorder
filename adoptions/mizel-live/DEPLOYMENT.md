# Live Mizel source and preservation contract

The production browser UI and server live in **`adoptions/mizel-live`** in this repository. The portable root `web/`, retired standalone checkouts and unapproved design previews are different projections; never substitute one for the live app.

Before editing, resolve the currently deployed service's WorkingDirectory and HEAD, inspect tracked/untracked changes, fetch the approved integration branch, and preserve the actual deployed source. A branch being newer by date does not establish feature containment. Reconcile live-only changes explicitly. Keep previews separate until the requested scope is approved; tell the owner clearly whether a change is staged or deployed.

## Required promotion gate

On a user-systemd deployment, run from the candidate repository immediately before changing the service pointer:

```sh
git fetch origin feature/agent-binding
python3 tools/check-deployment-lineage.py \
  --unit mizel-live.service \
  --candidate-directory "$PWD/adoptions/mizel-live" \
  --base-ref origin/feature/agent-binding \
  --receipt "$EVIDENCE/source-preservation.json"
```

Use `--live-directory` only when the deployment is not systemd-managed and the actual live path has been independently resolved. The gate reads the remote branch head, refuses stale base refs, dirty source and projection switches, and requires both the live revision and approved integration tip in the candidate. It emits exact file manifests. It never edits, imports, deploys or repairs anything automatically.

The gate complements behavior tests: a descendant commit can still introduce a bad change. `Mizel regression contracts` runs the adopted app's normal tests and the negative source-gate cases on pull requests. Before release, run the affected real browser/Android checks on Thales and keep a source-pinned receipt. Include ordinary gestures (idle→tap and idle→hold), a false-negative browser network hint while successful service requests continue, genuine outage/retry, finished-state controls and notice deduplication, and hint/control geometry at phone sizes when those paths change.

Promote one reviewed immutable checkout while the recorder is idle, preserve its data and provider configuration, and read back the live asset hashes and behavior through the real Wizard entry. Preserve the former source pointer for rollback. Never copy an entire preview over live or use a remembered retired checkout. An APK has its own immutable source/signer pin; web activation must not claim native changes from a later branch are in that APK.

Preserve the deployed `MIZEL_ALLOWED_ORIGINS` values, including exact gateway-derived origins: the authenticated private-route adapter may rewrite same-origin HTTP Origin while WebSockets retain the public origin. Do not replace the existing allowlist with only the browser-visible hostname or relax gateway checks. Before declaring release, use a disposable meeting through the real authenticated browser route to write a marker, read it back, delete the meeting, verify its readback is 404 and its markers are absent; a foreign Origin must still be rejected. Direct loopback success does not prove this route. Never use a person's recording for this canary.
