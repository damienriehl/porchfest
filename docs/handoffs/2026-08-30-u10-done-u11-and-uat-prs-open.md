---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-30T16:22:46Z"
title: "U10 is complete; U11 deploy tooling (#42) and the organizer-UAT fixes (#44) are in review; the first real deploy on riehl-dev is next"
summary: "2026-08-30: U10 landed (#40, #41, #43) with a clean fidelity gate on the real artifacts; venues-map 1.3.1 landed in platform, site (live), and producer; DNS + R2 bucket + token are in place for U11; PR #42 (KTD9 deploy tooling) awaits a final Codex re-review; PR #44 (11 UAT fixes) has a ready fix packet. Written before a home-box reboot."
keywords:
  [
    "porchfest",
    "u11",
    "deploy",
    "riehl-dev",
    "r2",
    "uat",
    "pr-42",
    "pr-44",
    "reboot",
    "node-24",
  ]
resume_focus: "Merge #42 when its Codex re-review is clean; dispatch the #44 fix packet; then the first real deploy on riehl-dev per docs/deploy.md and the shakedown wave (Damien triggers)"
repository: "porchfest"
branch: "main"
head: "cda4c21"
---

# Where things stand

Supersedes `2026-08-30-u9-complete-u10-next.md` (retired in this commit). Written
at the end of a long autonomous session, immediately before Damien reboots the
home box, so it is written to be resumed cold. Everything below is verified against
`main` at `cda4c21`.

## Landed today (2026-08-30)

| PR                                                | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| porchfest #40, #41, #43                           | U10 — the Goal-1 season import (natural-key idempotent importer, CLI `import:goal1`, synthetic fixture, `docs/import-2026.md`); `--event-year`; the real-artifact shapes (reach-via via slot or chase list, exact geocache source labels, `map_address`, canceled slots, no hold in this artifact version). **Fidelity gate on the real artifacts is clean:** 22 venues, 33 acts (27 + 6 placeholders), 3 supersessions, 20 coordinates, 1 expected warning (the unmatched venue was never geocoded). |
| sapporchfest-site #1 (live), woodshed-private #84 | venues-map contract 1.3.1 in both other copies; all three repos pin digest `7164e291…`. Site browser-verified against production before merge.                                                                                                                                                                                                                                                                                                                                                        |
| —                                                 | `app.sapporchfest.org` A record → riehl-dev (DNS-only); R2 bucket `porchfest-sap-backups`; bucket-scoped S3 token on riehl-dev at `~/.config/porchfest/r2.env` (0600; rclone remote `porchfestr2`, `no_check_bucket` required); age recipient generated on the home box (machine-local: `~/.config/porchfest/backup-age-recipient.txt`; the identity file next to it never leaves the home box).                                                                                                      |
| —                                                 | Organizer UAT run as Codex personas: `docs/operations/organizer-uat-2026-08-30-result.md` (all six tasks completed by proxy; **the formal human-browser gate is not established**).                                                                                                                                                                                                                                                                                                                   |

## Open PRs and their exact state

- **#42 `u11-deploy-tooling`** (head `15f3d8a`): KTD9 scripts (`deploy/`), external-proxy Traefik overlay, CI restore rehearsal, `docs/deploy.md`. Two review passes applied (17-item packet + Codex P1/P2 on rollback errexit and Traefik names). Gate: 842 tests + container rehearsal exit 0; CI green. **Waiting only on the Codex re-review of `15f3d8a`** (requested); merge when clean.
- **#44 `uat-persona-run`** (head `54c7aaa`): the 11 UAT fixes, 894 tests, CI green. Reviews done; **fix packet ready and not yet dispatched:** cockpit `agents/tasks/porchfest-uat-review-fixes.md` (11 items: public-map preview must render only public-labelled fields; bounds edit re-checks the box instead of stamping `address-changed`; duplicate-year confirmation on edit; dependency guard names clearable blockers only; conflict branch keeps submitted values; 503 catch-all; signup URLs by state; fingerprint churn documented; tie statement per venue; two cleanups). Dispatch from `~/worktrees/porchfest-uat` with `agents/worker-wrapper.sh --allow-off-master porchfest-uat-review-fixes <packet>` after a Codex trust entry check.

## Decisions today (Damien's, all executed)

Host = riehl-dev behind the existing Coolify Traefik (own compose project, literal volume); DNS-only record; R2 for off-site backups; delete the superseded `u10-season-import` branch (bundled first); schema catch-up now; delete merged branches/worktrees; run the UAT as Codex personas and fix what they find; merge the site PR once it followed best practices (it did: P1 fixed, preview verified).

## What the next session does (one path)

1. Merge #42 when Codex is clean → `git pull` main → re-install (`npm install --include-workspace-root --workspaces`, then `git checkout -- package-lock.json`).
2. Dispatch the #44 fix packet → gate → push → CI → merge.
3. **First real deploy on riehl-dev** per `docs/deploy.md`: create `/opt/porchfest` with the `.porchfest-deploy-root` sentinel and `.env` (project `porchfest-sap`, volume `porchfest-sap-data`, `PORCHFEST_PROXY_NETWORK=coolify`, `PORCHFEST_DOMAIN=app.sapporchfest.org`, `PORCHFEST_TLS_RESOLVER=letsencrypt`, `PUBLIC_BASE_URL=https://app.sapporchfest.org`, `PORCHFEST_TRUSTED_PROXY_HOPS=1`, `PORCHFEST_ARCHIVE_DIR=/var/backups/porchfest`, `PORCHFEST_BACKUP_REMOTE=porchfestr2:porchfest-sap-backups`, `PORCHFEST_BACKUP_AGE_RECIPIENT=<from the home box file>`; the R2 env is sourced from `~/.config/porchfest/r2.env` on the box); `deploy/deploy.sh` with the external-proxy overlay; then the KTD9 gate incl. `restore.sh` from the R2 copy on a clean volume. Then `import:goal1` on the box (the artifacts must be copied to a machine-local path, never into the repo), then the shakedown wave — **Damien triggers every send**.
4. Retire this handoff when those land.

## Traps (all cost time today)

- **Node 24**: `export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"` (nvm default is now 24 on the home box; CI and Docker pin 24). Never `npm rebuild`.
- **Codex trusts worktrees per directory** — append a `[projects."~/worktrees/<name>"]` `trust_level = "trusted"` entry to `~/.codex/config.toml` before the first launch from a new worktree.
- **The clean-room scanner walks every ref** (`git rev-list --all`; CI checks out with `fetch-depth: 0`). A fixture renamed after commit leaves flagged paths in history; name fixtures so they never match `private/`, `out/`, or the real-artifact basenames.
- **The harness `code-review` fork exits before its verifiers finish**; late verdicts land in the session transcript (`grep 'Verify .* finished'`).
- **`gen-board.py` has no `--help`** — invoking it runs a full generation pass. The Cockpit fast publisher was down all day (the cockpit checkout sits on a feature branch; `branch-mismatch`); asks were filed and answered inline; Decision Sheets were delivered as claude.ai artifacts.
- **rclone with a bucket-scoped R2 token** cannot `ListBuckets` and will try `CreateBucket` unless `no_check_bucket` is set; verify with an in-bucket list plus a write/read/delete probe.
- **The real `event.date_display`** is weekday-prefixed and year-less: the import needs `--event-year 2026`.
- **ICU differs between the box and the CI runner** (zero offset renders `GMT` vs `GMT+00:00`); `normalizeRfc3339Offset` exists for this.

## Damien's

The organizer UAT's formal gate still needs a human in a browser (the persona run found and fixed the discoverability defects, but did not establish the gate). Every send in the shakedown is his trigger.
