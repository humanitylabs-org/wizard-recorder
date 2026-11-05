# Local Recorder reload check (diagnostic, not a recorder repair)

## Reuse / boundary

REUSE existing loaded `WizAppCapture.reloadCheck()` / `getState()` and ordinary first-party app links. EXTEND Recorder's static UI with a fixed read-only view. No shell change, capture implementation, backend endpoint, arbitrary inputs, native command, storage inspection, telemetry, eval or new bridge. Only allowlisted reason/error and bounded elapsed time leave the observation function, only into this phone's UI. Unknown values are `unclassified`; absent parent is `shell_unavailable`, not empty/idle custody.

`reload-check.html` never imports `app.js` or `app-capture.js`, so it neither starts another Recorder controller nor runs capture recovery. The ordinary `WizardApp.ready` handshake provides Appearance and Back, with no share receiver, capture, orb or hold registration.

## Why it can reach an already-open blocked shell

The candidate is served at the existing authenticated Recorder static prefix `/mizel-live/`. A fresh in-app Chats link to `/mizel-live/reload-check.html?check=local-v1` opens a separate ordinary app view, rather than reloading Wizard or replacing the original Recorder frame. The new view reads its existing same-origin parent, so its code does not depend on a blocked shell module reload. Query values are never evaluated or acted upon.

Current phone `web/app.js:985-1008` handles a private-origin message link with `openLinkDesk` -> `linkDesk` -> new `openWin({app:'frame', appId, url, from})` when clicked from Chats. Exact URL reuse can focus an existing link frame; the first `check=local-v1` link is new. The original Recorder launched through `WizOpenApp` has no such `from` link identity. Do not open this URL in an external browser: that has no loaded parent and correctly reports `shell_unavailable`.

This is a source-grounded bootstrap path, not physical-phone proof. Do not ask for another Reload, Recents swipe, reopen, forced refresh or update install. After real closed-browser verification and static-only deployment, the single needed owner observation is the three lines on this specific new check view. Do not describe the diagnostic as a completed Recorder fix.

## Evidence / remaining gate

`test-reload-check.mjs` runs a pinned actual served reload predicate with synthetic control state, and can instead consume the exact full module with `QA_REVIEW_CAPTURE`. It checks immediate retained-row, native-uncertain, unreadable-storage and active-error branches, privacy allowlists, and unchanged safety. This is not the owner's retained database or a causal reproduction of their handset.

`qa-reload-check.cjs` is FORUM ONLY. Set `QA_SHELL_SOURCE` to a production-shell source closure, `QA_APP_SOURCE` to this `web/` directory, `QA_OUT`, `QA_PLAYWRIGHT` and `QA_CHROME` as appropriate. It uses the existing closed synthetic shell fence and production Recorder controller extractor. It exercises the actual immediate guard toast, then the existing Chats link path to a new diagnostic frame, checks unchanged root/controller identity and fail-closed safety, and captures two live skins in phone and desktop. The navigated diagnostic is found through Playwright's complete frame tree by exact pathname; the result is awaited inside that actual frame, not through top-document iframe/src assumptions. Failure evidence retains synthetic frame URLs/parent URLs, capture-presence flags and the diagnostic's three-line result. The real Review mode coach is dismissed with Got it before screenshots; computed panel/button pairs must be opaque and have contrast at least 4.5, including standalone dark. Set `QA_DIAGNOSTIC_BASELINE=1` for the exact old absent-view 404 failure. Browser execution still needs parent-owned durable forum admission; screenshots must be inspected before deployment.

The CSS uses the actually transported `--wz-base`/`--wz-text` pair. The pinned host does not transport `--wz-panel`, so its dark literal fallback with Sepia ink was unreadable. No capture-host ancestor walk is added: desktop source `openAppLink` -> `newWin` -> `bodyHtml` creates an ordinary iframe, and shared `links.js` may also navigate a frame's contentWindow without changing its src attribute. The corrected frame oracle must prove the actual route/result; if it does not, retain failure metadata rather than infer a nesting fix or alter production desktop routing.

No live mutation, shell/backend/native restart, owner data access, APK build or install is included. Parent must verify the existing owner-edge static prefix remains authenticated and admits the new three static assets before offering the link; asset serving success alone is not handset execution proof.
