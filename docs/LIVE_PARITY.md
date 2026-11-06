# Recorder live parity — staged candidate

REUSE — The serving Mizel view feature tree: agent router, finish routing, orb authority/events, retry/delete/save state, summary collapse and idle reload, including its original regression suites. Keep native protocol and historical source IDs stable.

EXTEND — Recorder's existing Connection Router adapters and app API proxy: retain app-scoped grants, live transcription, live-summary and recap slots, strict verified SSE provenance, Node `http.request` for the allow-listed Host, and the `RECORDER_TEST_PYTHON` CI runner. Retain setup and data migration.

EXTEND — Vendored WizardApp facade/capture from the serving shell revision, not a parallel UI/runtime: orb claim/release, retained native capture, original `wizardMizelPort` compatibility, no browser Back exit. Upstream/core Hermes is untouched.

EXTEND — Same existing route row/picker: installed shell registry labels and privacy choose the optional private default. No synthesized agent, owner alias or fixed host is a fallback. Device-only destinations stay device-routed; server routing requires explicit service configuration.

NEW — None in product UI/core. Synthetic QA adds an isolated Docker network, a Caddy importing the exact staged native compatibility snippet, fake Router/STT/agent service, and 390px canonical Appearance token fixtures. The gateway alone has a host-facing bridge; Recorder/fixture cannot reach owner services.

## Live backend recovery

The running backend and all five release Python modules have matching hashes. The release includes subsequent owner-identity changes; its directory name is not sufficient provenance. The code-only baseline and exact hashes are recorded in `SOURCE_PROVENANCE.json`. The currently serving static view was re-resolved after the November orb-save hotfix; see `SERVING_PARITY_20261106.md`. Compared deployed source, not an old image or GitHub main. Reinstated the lost Markdown importers as optional data-local import sources; Recorder's migration, model and delivery adapters remain.

## Agent label parity

The live tree hardcoded owner-specific labels. Production strings are now generated from installed registry labels. `test-registry-labels.mjs` executes the actual UI template expressions with the historic labels and a different owner's labels, and verifies production modules do not contain the former owner's agent names. These are executable fixture inputs/expected output, not shipping defaults or parity waivers. Original static regression tests are ported too. No waivers file is used.

## Proof boundary

`qa/parity/run.py` supports two explicit modes: a baked candidate image, or `PARITY_OVERLAY=1` mounting the candidate sources into the prebuilt Recorder image while its new amd64 build is pending. Receipts record which was exercised. An overlay proof is not a baked-image proof. No actual handset or live owner recording is used in synthetic QA. A later cutover still requires an approved real-handset recording; this branch does not authorize or perform a cutover.

Canonical Appearance fixtures are copied without alteration from Wizard shell `web/style-review/tokens.css` at revision `ffe0733b7888f31bda75e95868cd5732f29eb67b`, not made-up palettes. Browser QA asserts skin-specific computed tokens before capturing the route row and picker.

All gateway changes are snippets staged under `docs/cutover/`, never installed. No live gateway, routes, runtime apps or owner data are changed.
