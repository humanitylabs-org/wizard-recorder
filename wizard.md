---
wizard: 0.2
id: meeting-recorder
name: Meeting Recorder
type: service
category: app
tags: [audio, meetings, notes]
version: 0.1.0
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
  path: /mcp
  port: 8080
  transport: streamable-http
skill: SKILL.md
view:
  path: /
  port: 8080
  source:
    path: web
    build: python3 app/build_view.py
    dist: web
provides: [meeting-recording, meeting-transcripts]
system: false
uses: [transcriber]
needs: []
health: /healthz
---

# Meeting Recorder

Start a recording, write notes, upload an audio file, read and search the transcript. The shared transcription provider does the speech recognition; this app contains no model. It starts empty and keeps SQLite, audio and notes in its own app-data volume. Uninstall preserves that volume.

The view inherits Wizard appearance v1 and keeps Back inside the app. Native capture remains available through the existing Wizard recorder bridge; browser capture works without a native shell. Optional OpenAI-compatible notes enhancement uses owner-supplied configuration only.
