# Recorder live screen (source only, not served yet)

This folder is the Recorder screen James uses every day: live words while
recording, Ask cards, the live summary, playback, transcript and outline, close
recovery and the Appearance v1 skin. It is a Node service (`server.mjs`, port
8976 by default) plus its browser files in `web/`.

Source: imported by Archimedes on branch `import/mizel-live-served-20261109`
(commit 7a157b2, the bytes served by release `1af2177-live-plus-close-recovery`),
see issue #1. Changes on import: owner-box notes and the old provenance file were
left out, the browser QA scripts (`qa-*.cjs`, they need a private test volume)
were left out, and one comment in `web/wizard-style.css` that pointed at an
owner-box path was reworded. Everything else is byte for byte.

## Status

Nothing in the Recorder image or the runtipi compose uses this folder yet, so
installing Recorder still gives the back-end only. Next steps on issue #1:

1. Serve this screen from the Recorder container behind an install setting that is
   off by default.
2. Turn the owner-box values into install settings: allowed origins
   (`MIZEL_ALLOWED_ORIGINS`), the agent endpoint (`WIZARD_ORB_API_URL`,
   `WIZARD_ORB_QUEUE_DB`), the realtime and summary models, the owner name, and the
   hard-coded "Archimedes" labels (use the bound agent's name).

The live summary never names a speaker ("James says..."), because the recorder
cannot tell speakers apart: see `noAttributionPrompt()` in `owner-identity.mjs`.

## Tests

Node >= 22.13 (`node:sqlite`). No npm install is needed for the tests.

    cd live && node --test test-agent-router.mjs test-live-recovery.mjs \
      test-no-system-audio-prompt.mjs test-orb-authority.mjs test-orb-events.mjs \
      test-recording-retry.mjs

`python3 -m pytest tests/test_live_screen.py` runs the same list. Two imported
test files are stale against the served `web/app.js` and are not in that list
yet: `test-recording-delete.mjs` (all 18 fail: `reattachShared is not defined`,
the served app.js no longer has the slice markers it cuts out) and
`test-save-state.mjs` (1 of 11 fails: "durable acknowledgement blocked by
marker"). Fix or retire them in the serving slice.
