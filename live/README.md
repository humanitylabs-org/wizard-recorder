# Recorder live screen

This folder is the Recorder screen James uses every day: live words while
recording, Ask cards, the live summary, playback, transcript and outline, close
recovery and the Appearance v1 skin. It is a Node service (`server.mjs`) plus its
browser files in `web/`.

Source: imported by Archimedes on branch `import/mizel-live-served-20261109`
(commit 7a157b2, the bytes served by release `1af2177-live-plus-close-recovery`),
see issue #1. The browser QA scripts (`qa-*.cjs`, they need a private test volume)
were left out.

## How the Recorder serves it

The Recorder image ships this folder (Node binary, `tinfoil` and `ws` only) and
`app/live_screen.py` runs it inside the same container on a loopback port. The app
proxies `/live/` and the `/live/live` WebSocket to it, after its own host and
origin checks. It is behind the app switch **Live screen** (`live-screen`, off by
default, `GET/POST /api/switches`):

- Off: nothing changes. `/` answers as before, `/live/` is 404 and no Node process runs.
- On: `/` opens `live/`, and the service runs (also while the page is closed, for
  phone follow mode and finished recordings). Off again stops it.

## Settings (all from the install, nothing owner-specific in code)

| Install setting | Env | Used for |
|---|---|---|
| Live words key | `TINFOIL_API_KEY` | live words and the live summary (required to start) |
| Live words model / Live summary model | `MIZEL_LIVE_REALTIME_MODEL` / `MIZEL_LIVE_SUMMARY_MODEL` | Tinfoil models |
| Your main agent's name | `MIZEL_AGENT_NAME` | Ask cards and answers ("Wizard" if blank) |
| Agent endpoint / Agent key for Ask | `WIZARD_ORB_API_URL` / `WIZARD_AGENT_KEY` | Ask cards and sending recordings to an agent; blank = "not connected" |
| Owner name in notes | `MEETINGS_OWNER_NAME` | owner identity in summaries |
| Timezone | `MEETINGS_TIMEZONE` | times in thread titles and sent recordings |

Allowed hosts and origins are the app's own (`MEETINGS_ALLOWED_HOSTS`,
`MEETINGS_ALLOWED_ORIGINS`); Node only ever sees its own loopback origin.

## Look

The screen follows the WizardOS tokens (`web/wizard-tokens.css`, the kit copy;
the shell's skin when hosted), as decided on issue #1 (option A): same layout and
behaviour as James's screen, colours and type from each install's skin. Agent
marks use the shared orb (`Orb.create`) inside the shell and a plain dot elsewhere.

The live summary never names a speaker ("James says..."), because the recorder
cannot tell speakers apart: see `noAttributionPrompt()` in `owner-identity.mjs`.

## Tests

Node >= 22.13 (`node:sqlite`). No npm install is needed for the unit tests:

    cd live && node --test test-agent-router.mjs test-live-recovery.mjs \
      test-no-system-audio-prompt.mjs test-orb-authority.mjs test-orb-events.mjs \
      test-recording-retry.mjs

`python3 -m pytest tests/test_live_screen.py tests/test_live_served.py` runs them
plus the serving tests (the last one runs `npm ci` here once and starts the real
app and screen in dry mode). Two imported test files were retired in the serving
slice because they tested an older `web/app.js` (their slice markers no longer
exist): `test-recording-delete.mjs` and `test-save-state.mjs`.
