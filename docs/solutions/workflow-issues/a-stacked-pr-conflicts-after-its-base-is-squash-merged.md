---
module: porchfest
date: 2026-08-29
problem_type: workflow_issue
component: version_control
severity: medium
related_components:
  - pull_requests
  - ci
tags:
  - stacked-prs
  - squash-merge
  - merge-conflict
  - ours-strategy
  - verify-before-acting
applies_when: "A PR is based on another PR's branch, the lower PR is squash-merged into main, and the upper PR then reports CONFLICTING against main even though nothing in it actually conflicts."
related:
  - "docs/solutions/workflow-issues/rewriting-commits-breaks-the-cross-model-controller-ancestry.md"
  - "docs/solutions/workflow-issues/local-verification-must-match-the-ci-gate-list.md"
---

# A stacked PR goes CONFLICTING the moment its base is squash-merged — and the fix is a one-line merge, not a rebase

## What happened

PR #27 (U7) was stacked on PR #26's branch (U6). #26 was squash-merged into
`main` as `ab66025`. Retargeting #27 to `main` turned it `CONFLICTING` with
eight conflicted files, including an add/add on `season-lifecycle.ts`.

Nothing was actually in conflict. A squash merge creates a _new_ commit whose
tree equals the U6 tip, but git's merge base for #27 is still the old fork
point, so both sides appear to have changed every U6 region — and wherever U7
edited a line U6 had also touched, git cannot tell the two "changes" apart.

## The check that makes the fix safe

Before resolving anything, prove the squash reproduced the base branch exactly:

```bash
git diff origin/main origin/<base-branch> | wc -l    # must print 0
```

`0` means `main`'s tree is byte-identical to the base tip, which is already
an ancestor of the stacked branch. The stacked branch's own tree is therefore
the correct merge result, and every "conflict" is an artifact of the merge
base.

## The fix

```bash
git merge -s ours origin/main -m "Merge main (<base> squash <sha>) into <stacked-branch>"
git diff HEAD~1 HEAD | wc -l                          # 0: the tree did not move
npm test                                              # full gate, then push
```

`-s ours` is exact here, not a shortcut — it records `main` as an ancestor
without touching a single file. The merge commit is harmless because the PR
is squash-merged anyway.

## Why not rebase

A rebase onto `main` needs a force-push, which is on the approval list, and it
rewrites the commits the ce-work controller's ancestry check already validated
(see the related solution on rewritten commits). The merge commit does neither.

## Do not

- Do not resolve the conflicts by hand; eight files of identical-looking hunks
  is exactly where a wrong pick slips through.
- Do not run `-s ours` without the `diff | wc -l` check. If the squash was
  not a clean reproduction of the base (a merge-time edit, a different base
  tip), `-s ours` would silently discard main's real changes.
- Do not delete the base branch at merge time if you want GitHub to leave the
  stacked PR's base alone; retarget it explicitly with `gh pr edit N --base main`.
