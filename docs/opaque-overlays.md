# Opaque text overlays

Owner rule: a text-bearing floating panel is fully opaque. Scrims may still dim. Keep the existing tint and geometry.

Reuse:
- overlay panel material: REUSE `--wz-panel`
- existing app overlay selectors and layout: EXTEND with opaque backing only
- NEW: none

## Serving source

- Source: `~/apps/mizel-live-releases/7b4a3d1-owner-876c5c8b9a38-nodiar/adoptions/mizel-live`
- Base commit: `7b4a3d1232345caa69943c70ac073b14f5657285`
- Evidence: Active mizel-live.service WorkingDirectory is the release above; all three web CSS files match 7b4a3d1. The installed Mizel container retains an older view but the live app uses /mizel-live/.

## Pixel regression

Browser: Chromium / Playwright on forum; synthetic CSS-only fixtures; all network requests aborted. No private API or user data.

Five skins (nebula/grove/tide/ember/signal), hosted (`html.wz-hosted` plus the production `data-wz-hosted` marker) and standalone, plus a token-free standalone fallback. Each panel interior must render identically over loud text versus nothing. Exact screenshot byte equality, no tolerance. `will-change: transform` retains the raster layer to stabilize gradient dithering; no panel fill or visible opacity is replaced by the fixture.

- Same final test against unmodified baseline CSS: **78 failing comparisons / 132** (expected failure).
- Patched CSS: **0 failing comparisons / 132**.
- Baseline leaking selectors: `{".cite-tip": 5, ".composer-box": 5, ".live-card": 11, ".live-words": 11, ".palette": 5, ".panel": 5, ".recorder": 11, ".route-sheet": 5, ".sheet": 5, ".w-menu": 5, ".w-toast": 5, ".who-hint": 5}`.

```sh
NODE_PATH=<playwright-modules> TOKENS_CSS=<shell-web/kit/wizard-tokens.css> \
  QA_RESULT=after.json node tests/opaque_overlays_browser.cjs
# Negative control: point SOURCE_ROOT at the original CSS tree.
SOURCE_ROOT=<baseline> NODE_PATH=<playwright-modules> \
  TOKENS_CSS=<shell-web/kit/wizard-tokens.css> QA_RESULT=before.json \
  node tests/opaque_overlays_browser.cjs
```

Raw receipts are retained on forum under `/srv/work/opaque-overlays-apps/recorder/before.json` and `after.json`. Only CSS, this test, and this note changed.

## Deployment handoff — NOT performed

Copy only adoptions/mizel-live/web/styles.css and adoptions/mizel-live/web/wizard-appearance.css to web/styles.css and web/wizard-appearance.css under the live release path. No restart; never replace owner identity/no-diarization release code with this historical baseline.

Do not promote the entire branch over live code: the branch deliberately starts at the serving revision. Apply only the CSS delta to preserve later or owner-specific release work.
