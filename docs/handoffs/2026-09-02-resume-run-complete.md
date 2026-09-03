---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-02T21:30:00Z"
title: "Resume run complete: U8–U12 landed, app.sapporchfest.org live through two KTD9 gates; the 2026 import is blocked on lost artifacts"
summary: "2026-09-02: #44 review fixes, #46, #47, U8 (#48), and the 50-story persona UAT with its 12-fix packet (#49) all merged; prod serves main at 9b7589c over HTTPS with R2 offsite and a passed restore rehearsal; U12 staged as sapporchfest-site#2 (draft, merge after Sept 16); the corrected Goal-1 artifacts vanished with ~/worktrees/woodshed-porchfest, so the season import and shakedown wait on Damien's recovery decision."
keywords:
  [
    "porchfest",
    "u8",
    "uat",
    "deploy",
    "import-blocked",
    "goal1-artifacts",
    "shakedown",
    "u12",
  ]
resume_focus: "Resolve the Goal-1 artifact recovery decision (sheet: claude.ai/code/artifact/e23207ae-6871-4c3c-b9c8-a424865cd163), then import on the box, configure SMTP, stage the shakedown wave (Damien triggers every send), and merge sapporchfest-site#2 after the Sept 16 event"
repository: "porchfest"
branch: "main"
head: "9b7589c"
---

# Where things stand (2026-09-02, end of the autonomous resume run)

Supersedes `2026-08-30-u10-done-u11-and-uat-prs-open.md` (retired in this
commit; its open items either landed today or are re-recorded here).

## Landed today

| What                                                                                                                                            | Where                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PR #44's 11-item review-fix packet (previous UAT round)                                                                                         | merged `babb86d`                                                                   |
| PR #19 closed as superseded by #21                                                                                                              | closed, branch deleted                                                             |
| deploy.sh ship-guard POSIX fix (#46) — found by the first real ship                                                                             | merged `462b5cb`                                                                   |
| Origin-guard trusted-proxy + loopback-health fix (#47) — found by the first real deploy; without it every proxied request 421'd                 | merged `9678e5e`                                                                   |
| **U8: participant self-serve + magic links (#48)** — the last unbuilt unit; 12/12 plan scenarios covered; three review P2s fixed                | merged `94ab861`                                                                   |
| **Persona UAT (#49): 7 personas, 50 stories, 3 legs; 33P/10F/7NE before fixes; all 10 FAILs + 2 browser findings fixed (F1–F12) + 1 review P2** | merged `9b7589c`                                                                   |
| U12 site cutover                                                                                                                                | **staged draft PR sapporchfest-site#2 — merge after Sept 16, before 2027 signups** |

## Production state (verified, not claimed)

- `https://app.sapporchfest.org` serves main `9b7589c`: HTTPS 200 with a valid
  Let's Encrypt cert, HTTP→HTTPS redirect, healthy container behind the
  existing Traefik on the `coolify` network, compose project `porchfest-sap`,
  literal volume `porchfest-sap-data`.
- The KTD9 gate passed on every deploy (integrity ok, quiesced 0600 archive,
  SHA-256 verified, rollback tag retained, off-site copy in R2 bucket
  `porchfest-sap-backups`).
- A full **restore rehearsal passed on the home box**: encrypted archive pulled
  from R2, decrypted with the home-box-only age identity, booted on a fresh
  volume, counts matched. Rehearsal volume removed afterwards.
- The database is **empty** (no season) pending the import decision below.
- UAT evidence: `docs/operations/uat-2026-09-02-*.md` (personas + three leg
  reports); fix packet report `docs/handoffs/worker-uat-20260902-fixes-report.md`.

## Open items, in order

1. **Goal-1 artifact recovery — Damien's decision.** The corrected 2026
   artifacts (Aug 22 16:47 finals) vanished with the `woodshed-porchfest`
   worktree during the cockpit-freeze window; the surviving 16:07 ops backup is
   pre-correction and fails the documented fidelity gate (20/22 venues, 23/26
   act entries, 3 warnings vs 1). Decision sheet with options A–D:
   `https://claude.ai/code/artifact/e23207ae-6871-4c3c-b9c8-a424865cd163`.
   Until answered, the prod season stays empty (safe default D).
2. **SMTP provider + credentials** — none configured anywhere. Needed for the
   shakedown send and for participant self-serve to surface in prod (AE1 keeps
   it hidden meanwhile, which is correct pre-import anyway).
3. **Import + shakedown** once 1 and 2 resolve: `import:goal1` on the box per
   `docs/import-2026.md` (artifacts to a machine-local path, never the repo),
   then the follow-up wave staged in the outbox — **every send is Damien's
   trigger**.
4. **sapporchfest-site#2** (U12) — Damien merges after the Sept 16 event.
5. Deferred UAT residue: S7.1 (Turnstile live-config story; covered by unit
   suite), re-running the 7 NOT-EXECUTABLE stories against a published map now
   that manual coordinate entry exists (F4), and Marge-persona re-run of S1.3/
   S2.1 against the new invite surface (fix-proven by tests, not yet by a
   fresh persona pass).

## Traps that cost time today (beyond the memory entries)

- The KTD9 gate cannot self-bootstrap: the archive step restarts the _running_
  (old) image and demands health, so a first boot — or recovery from an
  unhealthy old image — is the documented manual `compose up -d --build app`
  before `deploy.sh` gates cleanly.
- CI's container test runs with no `PUBLIC_BASE_URL`, so the origin-guard
  class of bug (#47) is invisible to it; the first real proxied deploy is the
  only gate that catches it.
- `gh pr checks --watch` can race ahead of check registration right after a
  push ("no checks reported") — verify the run on the branch afterwards.
