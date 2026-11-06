---
wizard: 0.2
id: wizard-recorder
name: Recorder
voice_names: [recorder, meeting recorder, meetings]
type: service
category: app
tags: [audio, meetings, notes]
privacy: private
version: 0.4.0
summary: Record, upload, play back and search audio transcripts using the shared transcriber.
icon: icon.png
license: GPL-3.0-only
source: https://github.com/humanitylabs-org/wizard-recorder
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/compose.yaml
api:
  port: 8080
  path: /wizard-recorder/api
  spec: openapi.json
mcp:
  path: /wizard-recorder/mcp
  port: 8080
  transport: streamable-http
skill: skills/wizard-recorder/SKILL.md
view:
  path: /wizard-recorder/
  port: 8080
provides: [recording, transcripts]
system: false
uses: []
needs: [mic]
agent_binding:
  required: false
  purpose: Send a recording to the agent selected in Wizard
requires:
  models:
    live-summary: {tier: fast, tested_on: deepseek-v4-1-flash, swap: ask, private_data: true, abilities: [text, streaming], purpose: "Live outline while you record"}
    recap: {tier: standard, tested_on: deepseek-v4-1-flash, swap: ask, private_data: true, abilities: [text, streaming], purpose: "Summary when a recording ends"}
  services:
    - slot: live-transcription
      recommend: wizard-tinfoil
      private_data: true
      purpose: "Words appear as you speak"
health: /healthz
---

# Recorder

One self-contained image serves the view, API and six MCP tools. Fresh installs start empty;
/data contains SQLite, audio, notes and optional outbox/outline state. Uninstall preserves data.
Browser/native capture, shared chunk transcription, notes, search, upload, export and playback
survive a live-service outage. Installation requires private live transcription and models
through the Connection Router setup checklist; no provider keys belong in this app.
