---
wizard: 0.2
id: mizel
name: Mizel.ai
type: service
category: app
voice_names: [mizel, meetings, meeting recorder]
tags: [audio, meetings, notes]
privacy: private
# James, 23 Oct 2026: "The whole point of Mizel was to be fully private so no public agent can read its transcripts."
version: 0.2.0
summary: Record meetings, upload audio, keep notes and search transcripts using the shared transcriber.
icon: icon.png
license: GPL-3.0-only
source: https://github.com/humanitylabs-org/meeting-recorder
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/compose.yaml
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
---

# Meeting Recorder

Start a recording, write notes, upload an audio file, read and search the transcript. The shared transcription provider does the speech recognition; this app contains no model. It starts empty and keeps SQLite, audio and notes in its own app-data volume. Uninstall preserves that volume.

The view inherits Wizard appearance v1 and keeps Back inside the app. Native capture remains available through the existing Wizard recorder bridge; browser capture works without a native shell. Optional OpenAI-compatible notes enhancement uses owner-supplied configuration only. Finished recaps go to the agent this app routes through (chosen in Wizard, the main agent by default) through the Wizard delivery endpoint; the app never names an agent, and a bound agent that is down keeps recaps queued (`GET /api/agent-delivery`).
