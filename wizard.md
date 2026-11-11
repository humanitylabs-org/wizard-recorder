---
wizard: 0.2
id: mizel
name: Mizel.ai
type: service
category: app
voice_names: [mizel, meetings, meeting recorder]
tags: [audio, productivity]
privacy: private
# Private app: recordings and transcripts are not readable by public agents.
version: 0.2.4
summary: Record meetings, upload audio, keep notes and search transcripts using the shared transcriber.
icon: icon.png
license: GPL-3.0-only
source: https://github.com/humanitylabs-org/wizard-recorder
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
api:
  port: 8080
  path: /api
  spec: openapi.json
mcp:
  path: /meetings/mcp
  port: 8080
  transport: streamable-http
skill: SKILL.md
view:
  path: /
  port: 8080
provides: [meeting-recording, meeting-transcripts]
system: false
uses: []
needs: [mic]
agent_binding:
  required: false
  purpose: Where your meeting recaps go
health: /healthz
switches:
  contract: wizard.app-switches/1
  path: /api/switches
---

# Mizel.ai Recorder

Record meetings from your device, upload audio, keep notes and search transcripts. This package is the recorder backend: HTTP API, MCP tools, storage and the transcription queue. The shared transcription provider does the speech recognition; this app contains no model. It starts empty and keeps SQLite, audio and notes in its own app-data volume. Uninstall preserves that volume.

Capture uses the existing Wizard recorder bridge on the owner's device. The full Recorder screen (live words, Ask cards, live summary, playback, transcript and outline; `live/`) is served by this app behind the switch **Live screen** (`live-screen`, off by default) and needs a live words key in the app settings. With the switch off, opening its address returns a short JSON pointer to `/api` and `/mcp`. Optional OpenAI-compatible notes enhancement uses owner-supplied configuration only. Finished recaps go to the agent this app routes through (chosen in Wizard, the main agent by default) through the Wizard delivery endpoint; the app never names an agent, and a bound agent that is down keeps recaps queued (`GET /api/agent-delivery`).
