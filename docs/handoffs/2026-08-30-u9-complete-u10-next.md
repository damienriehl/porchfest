---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-30T00:55:00Z"
title: "U9 is complete on main; U10 (2026 season import) is next; the organizer UAT is Damien's"
summary: "PR #36 (U9D-b) squash-merged 2026-08-30 as b8f3b31 at 792 tests: public /map and /map/data.json, explicit map publication in locked with a preflight, coordinate-review screen with bounded season geocoding, OpenStreetMap geocoder behind GEO_* env, venues-map schema 1.3.1. Next agent: build U10 per the plan. Human: run docs/operations/organizer-uat.md; delete merged remote branches."
keywords:
  ["porchfest", "u9", "u10", "import", "map", "schema-1.3.1", "uat", "node-24"]
resume_focus: "Build U10 (2026 season import), then U11 deploy; schedule the cross-repo schema 1.3.1 catch-up before U12"
repository: "porchfest"
branch: "main"
head: "b8f3b31"
---

# Where things stand

Supersedes `2026-08-29-u9-core-and-contract-landed-route-next.md` (retired in this
commit; `git log --diff-filter=D -- docs/handoffs/` recovers it). Everything below is
verified against `main` at `b8f3b31`.

## U9 is done

PR #36 landed the last quarter. Read `docs/handoffs/worker-u9d-map-route-report.md`
for every judgement call, including its `## Review-fix commits` section which maps the
review packet (`agents/tasks/porchfest-u9d-map-route-review-fixes.md` in the cockpit)
to commits. Damien's decisions (ask `porchfest-2026-08-29-1947-u9d-b-map-route-decisions`,
answered inline 2026-08-29): publication is an explicit organizer act allowed only in
`locked` (`seasons.map_published_at`, migration 0015); geocoder env is
`GEO_PROVIDER`, `GEO_USER_AGENT`, `GEO_COUNTRY_CODES`, `GEO_OVERPASS_TIMEOUT_MS`,
`GEO_NOMINATIM_TIMEOUT_MS` (placeholders in `.env.example`).

Orchestrator decisions during review, for the record: the schema went to **1.3.1**
(top-level `venues` may be empty) rather than re-pinning 1.3.0 bytes in place; publish
preflights the full document and refuses with the offender named; season geocoding is
capped at 20 venues per submission with a per-season in-flight guard and a 45 s budget.

## What U10 must build

Read the plan's `### U10.` section first — its test scenarios are the checklist.
Nothing has been started. The 2026 data lives outside every repo (R22); the import
must take a path/env, never a committed fixture.

## Cross-repo work nobody has scheduled

The Goal-1 producer (`porchfest/tools/render.py`) and the site's `static/data/` copies
are at v1.1.0; the platform is at 1.3.1. `packages/map/schemas/README.md` carries the
catch-up steps. Must happen before U12 cutover; nothing breaks until then.

## Damien's — not an agent's

- **Run the organizer UAT** (`docs/operations/organizer-uat.md`) — closes U5.
- Delete merged remote branches if wanted (`u6-*`, `u7-*`, `u9*`, `docs-*`, `ci-*`);
  every one is merged. Local worktrees under `~/worktrees/porchfest-*` are likewise
  all merged and can be removed with `git worktree remove`.

## Traps (all cost time)

- **Node 24 in every shell**: `export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"`.
  Never `npm rebuild`.
- **Re-install after pulling `main`** (`packages/web` now declares `@porchfest/map`):
  `npm install --include-workspace-root --workspaces` then `git checkout -- package-lock.json`.
- **A new `~/worktrees/` dir needs a Codex trust entry** in `~/.codex/config.toml`
  before `worker-wrapper.sh` can launch from it.
- **ICU differs between the box and the CI runner**: a zero UTC offset renders as
  `GMT` locally and `GMT+00:00` on GitHub. `packages/web/src/routes/map.ts`
  `normalizeRfc3339Offset` exists for this; reuse it rather than calling `Intl`
  `longOffset` raw.
- **The harness `code-review` fork exits before its verifiers finish**; late verdicts
  land in the session transcript (`grep 'Verify V'`), not only the fork's file.
- **The admin-records 5 s CI timeout** is a runner stall; re-run, do not raise.
