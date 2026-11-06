# Portable Recorder delivery

## Outcome and boundaries

A private installable app with id `wizard-recorder` and name Recorder. One image
contains the real adopted view and the Python API. No owner install is deployed,
restarted or migrated. Heavy image/browser/TTS acceptance runs only on the build
machine's external volume, under a disposable Compose project.

REUSE: WizardApp capture, Back, appearance, sharing and update custody via the
canonical app-client/app-capture modules; no second browser/native recorder.
EXTEND: Existing recorder view with standalone capability gates, upload action,
app-bound delivery and private Connection Router summaries. Vendor notes document
limited package-identity/root-Back changes.
NEW: No new shared UI primitive. Packaging supervisor, offline data-path migration
and image acceptance harness are app-specific backend/release plumbing.

## Acceptance receipts

- Python: standalone without optional services; synthetic old-layout migration,
  traversal refusal and playback; Router incomplete streams fail closed; existing
  notes/search/MCP/upload/delivery tests.
- Node: view and core resources served by this image; optional-service capability
  gates and cross-origin write refusal; durable app-local orb event journal.
- Heavy workflow: publish both architectures, then pull the immutable digest into
  an empty Compose project with only shared Speaches; generated speech upload,
  real transcript/search/MCP/playback/export, restart and preserved bind volume.
- Browser: 390px standalone plus same-origin hosted conformance harness, two
  appearance skins, optional-control hiding and nested menu/document Back.

Do not infer configured-provider or native-device acceptance from baseline tests.
Do not infer real Wizard App Manager installation from the isolated Compose proof.
Keep the PR unmerged until the actual image/e2e receipts and screenshot review pass.
