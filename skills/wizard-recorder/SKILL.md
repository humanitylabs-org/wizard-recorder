---
name: wizard-recorder
description: Use when recording or searching private Recorder transcripts.
---

# Recorder

Use the installed app's MCP at `/wizard-recorder/mcp`. Six tools are available:
list_meetings, get_meeting, search_meetings, start_recording, stop_recording,
get_transcript. Read full transcripts by following get_transcript pagination until
has_more=false. Cite recording ID and segment time. Never invent speech or treat
assistant/orb material as meeting speech. Capture tools require an attached device;
awaiting_device is not a successful microphone recording.

No private agent is required for capture, upload, transcription, notes, search,
export or playback. Send to agent is available only through the configured app
binding. Never access a host agent database or private runtime API.

## Connections and outage behavior

Recorder requires private live-transcription, live-summary (fast) and recap
(standard). Use the shared Connection Router setup checklist; wizard-tinfoil is
recommended for live words. Configure providers in their own apps, never supply
provider keys to Recorder. Runtime integration uses only WIZARD_ROUTER_URL and an
app-scoped WIZARD_ROUTER_GRANT. Shared TRANSCRIPTION_URL remains the durable batch
transcript source; a live-service failure must not stop capture or chunk uploads.
Summaries admit only completed Router SSE with provenance and validated outline
JSON. Provisional captions are not durable transcript evidence; cite batch segments.
