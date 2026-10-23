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
