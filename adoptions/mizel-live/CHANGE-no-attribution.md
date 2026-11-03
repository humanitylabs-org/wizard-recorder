# 2026-10-25 — live summary stops attributing speakers
Base: ../../../7b4a3d1-owner-876c5c8b9a38 (rollback: point zz-mizel-orb-release.conf back at it; backup in ~/.hermes/cache/scratch/zz-mizel-orb-release.conf.bak).
James: the recorder cannot diarize, so the live summary must not say "James says…"; use neutral "a speaker / one speaker" wording.
Change: owner-identity.mjs adds noAttributionPrompt(); appended to the live summary system prompt (server.mjs) and provider.js summary prompt. Agent-router (Ask Archimedes) unchanged.
Evidence: synthetic-transcript A/B only. (An earlier run read real recording content in breach of the owner's privacy boundary; that evidence was removed.)
