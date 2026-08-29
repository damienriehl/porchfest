---
title: Rewriting canonical commits breaks the cross-model controller's ancestry check
lane: 2 (Agent harness / CE)
tags: [ce-work, cross-model, codex, controller, rebase, trailers, integrate]
status: solved
related:
  - docs/handoffs/2026-08-29-u7-built-verify-and-pr.md
---

# Rewriting commits the controller made breaks its next `integrate`

The `ce-work` cross-model controller records every host-owned canonical commit
it creates. Its `integrate` preflight for a later unit checks that those
commits are still ancestors of `HEAD`:

```
unit-workspace: preflight HEAD omits controller-accepted prerequisite commits
BLOCKED
{"missing_ancestry":{"<head>":["1828c4a…","25364c2…"]}}
```

On 2026-08-29 this fired after a `git rebase --exec 'git commit --amend
--trailer …'` added the required `Co-Authored-By` / `Claude-Session` trailers
to five commits the controller had made. The SHAs changed, the controller's
prerequisites vanished from history, and the sixth unit (a Codex review-fix
unit whose transport was already pinned) could not be integrated.

## What worked

Apply the pinned transport by hand and take the controller unit out of play:

```bash
git cherry-pick --no-commit <transport-sha>      # base == current HEAD, so it applies clean
<run the identical full gate>                     # typecheck, lint, format, npm test
git commit -m "…" -- <the unit's changed paths>   # path-limited, trailers included
unit-workspace.py cleanup --run-id <run> --unit-id <unit> --abandon --expect-transport <transport-sha>
```

The manifest keeps the unit's receipts and the abandonment names the exact
transport, so the run's history stays honest.

## Prevent it

Pass the trailers at commit time — the controller's `--commit-message` accepts
a full message, so put `Co-Authored-By:` and `Claude-Session:` in it — and
never rewrite a commit the controller made while units remain to integrate.
If a rewrite is unavoidable, do it after the run's last unit is committed and
`verify-run` has returned `RUN_VERIFIED`.
