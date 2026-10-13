# Acceptance checkpoint — staged, not released

App package PR: https://github.com/humanitylabs-org/meeting-recorder/pull/1

Verified on the dedicated `meeting-qa` Ubuntu 24.04 VM on Thales:

- Both approved v0.2 checkers report COMPATIBLE.
- Four fixture regression tests pass: empty install and access bounds; chunk idempotency/notes conflicts/media bounds/playback; six MCP tools and device-acknowledged stop; shared-transcriber request format and explicit error handling.
- A local prototype image builds on Thales under the shared worker lock, with no data or model in its Docker context. Final source adds the explicit appearance-host configuration route after that prototype build; final image publication is still pending.
- Stock Runtipi base plus the App Manager starts in the fresh VM. Transcriber, Hermes Agent, Files and Wizard Shell install through the actual App Manager. The box setup repaired an upstream Docker Compose version-parsing incompatibility and a transient RabbitMQ image download failure; it did not modify the live Telos recorder.

These are fixture/package/setup receipts. Real recorded/uploaded speech transcription, the app's hosted Wizard view, nested/root shell Back, screenshots, actual Hermes gateway calls and uninstall retention remain pending. No screenshot or end-to-end receipt is claimed.

## Blocking routes

1. Private short-name lookup: App Manager main cannot resolve `wam install meeting-recorder`; the repo-qualified private path is its existing route. A separate proposed, owner-scoped private-id mapping is dispatched as Kanban t_1bdd056f. Its WAM PR must remain draft/unmerged for Miguel/Oscar.
2. Index PR access: the authenticated account has READ on humanitylabs-org/wizard-app-index. Branch push returns 403, and GitHub's fork endpoint says forking is disabled. The private-entry proposal is preserved locally as a patch. A repository owner must grant defleur-agents write permission or open the PR from that patch. Nothing was published to the public index.

## Resume evidence

Thales evidence/source root: `/Volumes/ThalesMedia/WizardOSMeetingQA/`.
VM: `LIMA_HOME=/Volumes/ThalesMedia/WizardOSMeetingQA/lima`, name `meeting-qa`.

Keep the WORK_OUTSTANDING checkbox open until the named install, real clip workflows, hosted Back, Hermes gateway and retained-data tests are all verified. The private image workflow is prepared for an ephemeral Thales runner; it has not run or published a package. The live `/home/telos/apps/meetings` service remains untouched by this task.
