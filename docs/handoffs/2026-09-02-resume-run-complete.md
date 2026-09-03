---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-03T03:55:00Z"
title: "Resume run complete: U8–U12 landed, app.sapporchfest.org live and green; the reconstructed 2026 artifacts await Damien's changelog review"
summary: "2026-09-02: #44 review fixes, #46, #47, U8 (#48), and the 50-story persona UAT with its 12-fix packet (#49) all merged; prod serves main at 9b7589c over HTTPS with R2 offsite and a passed restore rehearsal; U12 staged as sapporchfest-site#2 (draft, merge after Sept 16); the corrected Goal-1 artifacts vanished with ~/worktrees/woodshed-porchfest, so the season import and shakedown wait on Damien's recovery decision."
keywords:
  [
    "porchfest",
    "u8",
    "uat",
    "deploy",
    "import-reconstruction",
    "goal1-artifacts",
    "shakedown",
    "u12",
  ]
resume_focus: "With Damien present: walk RECONSTRUCTION-CHANGELOG.md (machine-local), decide the E6 rain-plan correction, then import on the box per docs/import-2026.md; wire SMTP by paste-safe prompts; stage the shakedown wave (his trigger); finish branch fix-locked-season-year; after Sept 16 merge sapporchfest-site#2"
repository: "porchfest"
branch: "main"
head: "bd6f1b0"
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

## Evening update (2026-09-02 late / 09-03)

Everything below happened after the section above was first written; the open
items list above is superseded by this one.

### Resolved since

- **The artifact recovery ran its course.** Damien chose option A; a live
  woodshed session (woodshed-fa) traced the deletion to the woodshed resume
  session's merged-worktree sweep (`git worktree remove --force`, no archive —
  confirmed in its transcript), and the Drive workbook predates the Aug-22
  corrections. So a **reconstruction was staged and validated** (machine-local:
  `~/.local/state/porchfest-goal1-reconstruction/`): it reproduces the
  2026-08-30 fidelity record line-for-line under importer `ce0f450` and passes
  the current documented gate exactly. All invented-not-recovered values are
  flagged in its `RECONSTRUCTION-CHANGELOG.md` (7 timestamps, 1 submitter
  identity, 2 OSM refs, prose). This session's call, per Damien's option-C
  terms: **nothing imports until Damien reviews that changelog** — he also
  decides the flagged E6 rain-plan correction (2349 Commonwealth is NOT fully
  rain-safe; never made the Aug-22 finals; safety-relevant on event day).
- **UAT residue re-verified: 4/4 PASS** — invites (S1.3/S2.1), manual
  coordinates + publish (S1.8), map stories (S5.1–S5.4), self-serve
  discoverability (S3.5) all work through the UI alone. Evidence was
  session-local; the durable claims are the merged tests.
- **`docs/import-2026.md` corrected** (#51): the fidelity line's "26 approved
  act entries" double-counted placeholders; true value 25, per the 08-30
  record and the Aug-22 listserv draft.
- **CI tail closed:** #50 and #51 briefly ran main red on a prettier-only
  violation in this very handoff; #52 fixed it and main HEAD `bd6f1b0` is
  **green** (verified).

### Still open

1. **Branch `fix-locked-season-year` (pushed, WIP):** `year` must join the
   event-details schedule dependency guard (a locked season with dependent
   data accepts a `year` edit while refusing `event_date`, and the two can
   disagree; `year` gates map publication by calendar year). The guard shape
   in `packages/core/src/setup.ts` looks right; 4 tests need reconciliation
   and prettier needs a pass. Two Codex dispatches were externally killed
   (209 codex processes were live on the box; killer unidentified), so it was
   preserved rather than forced. Task spec: quoted in the branch's WIP commit
   message trail; full text was session-local.
2. **Damien-gated (queue also in project memory `pending-for-damien-2026-09-02`):**
   changelog review → real import per `docs/import-2026.md` → SMTP by
   paste-safe prompts → shakedown wave staged with every send his trigger →
   sapporchfest-site#2 merge after Sept 16 → Marge's E5 media answer.
3. **Post-thaw cockpit reconciliation:** this run wrote no board/on-deck
   entries and read no events.log (freeze honored); reconcile after Damien
   thaws. If he switched models to Fable 5.1, update the ratchet's pinned
   `interactive_model` string.
4. **UAT instance leftovers (machine-local, deletable after item 1's re-run
   needs pass):** `~/.local/state/porchfest-uat-20260902/` (fixture data,
   @example.test only; processes stopped).
