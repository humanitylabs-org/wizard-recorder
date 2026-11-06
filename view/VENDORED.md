WizardApp facade/capture are vendored from the serving humanitylabs-org/wizard-ux shell revision ffe0733b7888f31bda75e95868cd5732f29eb67b (GPL-3.0-only). Hosted capture uses the host-owned resource; standalone uses the same core implementation.

Upstream source SHA-256 before the documented Recorder adaptations:
- app-client.js: 695f178c0b3df7360e551d48ec718be40b241d6ecaca914d4d27bae4bbc83012
- app-capture.js: 8b6d4427923298269ef02cbeb293c867402dc9bdac3338c9028985665b1c5a6c

Recorder adaptations: task ownership IDs use wizard-recorder; native bridge admission supports both wizardRecorderPort and the existing Android wizardMizelPort (not renamed prematurely); the second-Back browser exit is disabled. The current upstream facade includes orb claim/release and is necessary for the live New recording orb feature. No upstream shared file or core Hermes source is modified by this port.
