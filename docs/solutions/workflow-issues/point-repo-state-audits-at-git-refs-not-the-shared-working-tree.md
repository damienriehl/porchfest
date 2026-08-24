---
module: agents
date: 2026-08-23
problem_type: workflow_issue
component: agent_dispatch
severity: high
related_components:
  - version_control
  - concurrent_sessions
tags:
  - working-tree
  - shared-mutable-state
  - git-refs
  - false-regression
  - verify-before-acting
  - concurrent-sessions
  - subagent-audit
applies_when: "Dispatching a subagent whose job is to report on repository state -- diffs, regressions, file contents, or absence claims -- especially in a shared checkout another concurrent session might be using."
related:
  - "docs/solutions/workflow-issues/worker-dispatch-fails-silently-outside-the-target-repo.md"
  - "docs/solutions/workflow-issues/local-verification-must-match-the-ci-gate-list.md"
  - "cockpit: CLAUDE.md (Claims about machine state carry their evidence)"
---

# An agent asked about repository state reports on whatever branch another session last left checked out

## Context

A read-only audit subagent was dispatched to compare two copies of the browser map
module — `packages/map/` in this repo against the same module living in the separate
`sapporchfest-site` repo — and enumerate every divergence. It came back thorough and
well-evidenced. It also came back with a section headed **"Correction to the stated
premise"**, asserting that `packages/map/assets/porchfest-map.css` still carried
`margin: 0 !important` on `.porchfest-marker-shell`. It quoted the offending rule. It
called it a live regression. It explained — correctly, and in the right amount of
detail — that an `!important` margin outranks the inline style Leaflet derives from
`iconAnchor`, and therefore displaces every venue pin 22px east and 40px south
(`docs/solutions/logic-errors/css-important-discards-the-geometry-a-js-library-writes-inline.md`).

Every technical claim in that paragraph was true. The conclusion was false.

The declaration had been deleted and merged hours earlier, as PR #5
(`fix(map): stop sending failed loads to a removed Google map`, merged
`2026-08-23T23:04:24Z`), and the rule on `main` now carries a comment and a guard test
in place of the flags:

```
$ git show origin/main:packages/map/assets/porchfest-map.css | awk '/^\.porchfest-marker-shell \{/,/^\}/'
.porchfest-marker-shell {
  /* Nothing here may be !important. Leaflet drives this element's geometry with
     inline styles derived from iconSize and iconAnchor, ... */
  position: relative;
  width: 44px;
  height: 44px;
  border: 0;
  background: transparent;
}
```

**Why the agent was wrong.** It read the repository **working tree** at
`/home/damienriehl/Coding Projects/porchfest`. That checkout was parked on a _different
concurrent session's_ branch, `u5-retention-and-deletion`, which forked at `3e7aef6`
(2026-08-23 14:33) — three and a half hours before PR #5 merged. On that branch the
pre-fix rule is exactly what the agent quoted:

```
$ cd "/home/damienriehl/Coding Projects/porchfest" && git rev-parse --abbrev-ref HEAD
u5-retention-and-deletion
$ awk '/^\.porchfest-marker-shell \{/,/^\}/' packages/map/assets/porchfest-map.css
.porchfest-marker-shell {
  position: relative;
  width: 44px !important;
  height: 44px !important;
  margin: 0 !important;
  border: 0;
  background: transparent;
}
```

The dispatching prompt had named file **paths**, not git **refs**. The agent read the
tree it was pointed at, faithfully. The orchestrator's prompt was the defect.

Two aggravating details make this a standing hazard rather than a one-off:

- **The stale branch was the _newest_ thing in the repo.** At the time of writing its
  tip was dated fifty minutes _after_ the fix merged, and it is a local branch that was
  never pushed — so its commit id is ephemeral and is deliberately not cited here.
  Recency of a branch tip says nothing about whether the branch carries a given fix;
  only reachability does. `git merge-base --is-ancestor <fix-commit> <branch>` exits
  non-zero for that branch and zero for `origin/main`, and that check — not the dates,
  and not a commit id another checkout may never have seen — is the one to run.
- **The checkout moved under this very session.** The `git status` snapshot taken at
  session start reports the branch as `feat/u4-signup-forms`; by the time of this
  writing the same directory is on `u5-retention-and-deletion`. Nobody in this session
  moved it.

That is what a working tree is: shared mutable state, which any other session can move
between the moment you dispatch an agent and the moment it reads. This cockpit fans work
out to many concurrent sessions by standing policy — `git worktree list` shows three
attached to this repo right now — so the window is not exotic. It is the normal case.

## Guidance

**When a subagent's job is to report on repository STATE, point it at explicit refs,
never the working tree.** The three verbs that read a ref without touching the
checkout:

```bash
git show <ref>:<path>          # one file's content at a ref
git diff <base>...<branch>     # what a branch adds, from its merge base
git ls-tree -r <ref> --name-only   # the file inventory at a ref
```

Put the ref in the prompt and forbid the alternative outright:

> Compare `packages/map/assets/porchfest-map.css` **as of `origin/main`** against
> `<the other copy>`. Read every file with `git show origin/main:<path>`. Do **not**
> read the working tree, do **not** `git checkout` or `git switch` anything, and do
> **not** assume the currently checked-out branch is relevant — this checkout is shared
> with other sessions and may be on any branch.

**Then verify the claim across every relevant ref before acting on it.** This is the
sweep that caught the false regression:

```bash
for ref in origin/main u5-retention-and-deletion \
           origin/u5-placeholders-supersession-change-requests origin/fix/map-module-sync; do
  git show "$ref:packages/map/assets/porchfest-map.css" \
    | perl -0777 -pe 's{/\*.*?\*/}{}gs' \
    | awk '/^\.porchfest-marker-shell \{/,/^\}/' \
    | grep -q "margin: 0 !important" \
    && echo "$ref: HAS the bug" || echo "$ref: fixed"
done
```

Two things about that loop are load-bearing.

**It prints in every outcome.** `&& echo HAS … || echo fixed` — a ref that errors or
matches nothing can never be silently read as a clean result. Compare a bare
`grep -q … && echo BUG`, whose silence means "clean" and "the ref does not exist" and
"the path moved" identically.

**The `perl` comment strip is not decoration.** The first version of this sweep counted
`!important` occurrences in the rule and reported `3` for _every_ ref, fixed and broken
alike — because the fix's own explanatory comment uses the word `!important` three
times, exactly matching the three real flags (`width`, `height`, `margin`) it replaced.
A count-based check is perfectly ambiguous here. The repo's own guard test hit the same
wall and solved it the same way, at
`packages/map/test/porchfest-map.test.js:2209`:

```js
const declarations = rule && rule[1].replace(/\/\*[\s\S]*?\*\//g, "");
```

**Confirm ancestry rather than inferring it from dates.** Whether a branch contains a
fix is a graph question with an exact answer:

```bash
git merge-base --is-ancestor <fix-commit> <branch>; echo "exit=$?"   # 0 = contains it
```

**The cheap structural mitigation: dispatch repo-state work against a dedicated worktree
the orchestrator controls.**

```bash
git worktree add /home/damienriehl/worktrees/<repo>-audit origin/main --detach
```

A worktree you created is a checkout no other session knows about, so nothing can move
it between dispatch and read. It costs one command and removes the failure mode
entirely, rather than depending on every future prompt getting the ref right.

**Cite PR numbers, not bare SHAs, when you reference merge state.** Squash merges
rewrite SHAs, so the commit an agent quotes may not exist on `main` under that name; the
PR number survives. The map fix is PR #5; the module sync that followed it is PR #14
(merged `2026-08-23T23:56:09Z`).

## Why This Matters

A ref is content-addressed and immutable under its name for the duration of your read.
A working tree is a mutable directory whose meaning is set by whoever touched it last.
Ask a question of the first and the answer is reproducible; ask it of the second and the
answer is a function of another session's scheduling.

What makes this dangerous is not that the agent was wrong — agents are wrong routinely,
and most wrong answers advertise themselves by being thin. This one was _thick_. It
quoted real code, from a real file, at a real path, and reasoned from it to a
displacement figure that matches the documented defect to the pixel. Every check a
reviewer would run against the report's internals passes. The only check that fails is
the one nobody thinks to run, because the report gives no reason to suspect it: _which
snapshot of the repository was this read from?_

**This is the same shape as
`docs/solutions/workflow-issues/worker-dispatch-fails-silently-outside-the-target-repo.md`,
one axis over.** There, two Codex workers were launched from the cockpit root instead of
the target repo, Codex refused with `Not inside a trusted directory`, and the
orchestrator was told both had _succeeded_. The worker was in the wrong **place**; here
it was at the wrong **time** — the wrong ref. In both cases the prompt left a piece of
context implicit (the invocation directory there, the snapshot here), the environment
silently supplied a wrong value for it, and the result came back with full confidence
and no marker of the substitution. Confidence is the payload. A hedged wrong answer
prompts a check; a well-evidenced one prompts action.

And the action here would have been actively destructive. The plausible response to
"`margin: 0 !important` is back on `main`" is to delete it again and commit — which
means re-applying a change that is already on `main`, on a branch (`u5-retention-and-
deletion`) that touches **zero** of `packages/map`'s files among its 35 changed files.
The stale CSS there is inherited, not authored; it disappears the moment the branch
merges. A "fix" pushed onto it creates a duplicate of PR #5 to conflict with. The worse
branch of the same response is to conclude that the merge had silently reverted, and go
audit the merge machinery for a bug that does not exist.

Verifying cost one command. That asymmetry is the whole argument.

The cockpit rule that _claims about machine state carry their evidence_ already covers
half of this: an absence claim is really a claim about **where** you looked. A
repository adds a second axis. It is also a claim about **when** — about which commit
you were standing on. A path alone answers neither.

## When to Apply

Apply this whenever the **deliverable is a statement about repository state**:

- **Divergence audits** — comparing a module against a copy in another repo, a vendored
  dependency against upstream, a port against its original.
- **Presence and absence questions** — "is this bug still there," "did the fix land,"
  "does this branch have X." These are the highest-risk category, because a wrong answer
  looks like a finding rather than an error.
- **Inventories and sweeps** — dead-code hunts, secret scans, "every file that does Y,"
  license and dependency enumeration. `git ls-tree -r <ref>` also excludes untracked
  scratch files that a `find` over the tree would happily include.
- **Anything whose output will be acted on without a second reading.** If the report goes
  straight into a commit, it needs a ref.

Apply it **regardless of how confident you are about the branch**. The branch under this
session's own checkout changed mid-session without anyone here touching it.

Apply it **most urgently when fan-out is active** — multiple worktrees, concurrent
sessions, background workers. Standing cockpit policy makes that the default posture, so
treat the shared checkout as hostile terrain by default rather than on suspicion.

**Do not** apply it where the agent must operate on a real tree — running the build,
executing the suite, taking a browser screenshot, applying an edit. Those genuinely need
files on disk. Pin the snapshot instead: create your own worktree at the ref you mean
(`git worktree add <dir> <ref>`) and dispatch the agent there. Same guarantee, obtained
structurally rather than by instruction.

Separately and always: **treat an agent's regression-or-absence claim as evidence to
verify, not a result to act on.** One `git show` on the ref you actually care about
settles it.

## Examples

**The dispatch — before.** Paths only; the ref is left to whatever the filesystem
happens to be holding.

> Compare `packages/map/` against the same module in the `sapporchfest-site` repo and
> enumerate every divergence.

**The dispatch — after.** The snapshot is named, and the working tree is ruled out.

> Compare `packages/map/` **as of `origin/main`** against `sapporchfest-site`'s copy **as
> of its `origin/main`**, and enumerate every divergence. Read every file with
> `git show <ref>:<path>` — never from the working tree. Do not `git checkout`,
> `git switch`, or `git stash` anything. This checkout is shared with other concurrent
> sessions and may currently be on an unrelated branch; the branch it is on is not
> evidence of anything. Quote the ref alongside every file:line you cite.

**The verification — the naive form that failed.** Counting flags inside the rule,
without stripping comments:

```
origin/main: !important count in .porchfest-marker-shell rule = 3
main: !important count in .porchfest-marker-shell rule = 3
u5-retention-and-deletion: !important count in .porchfest-marker-shell rule = 3
origin/u5-placeholders-supersession-change-requests: !important count = 3
origin/fix/map-module-sync: !important count in .porchfest-marker-shell rule = 3
```

Uniform, and uniformly meaningless: the fixed rule's comment mentions `!important`
exactly three times, the broken rule carries exactly three real flags.

**The verification — the form that answered it.** Comments stripped, matching the
literal declaration, printing in both outcomes:

```
origin/main: fixed
main: fixed
u5-retention-and-deletion: HAS the bug
origin/u5-placeholders-supersession-change-requests: HAS the bug
origin/fix/map-module-sync: fixed
```

The audit agent's "live regression on `main`" was a real defect on two branches that had
forked before the fix — and on neither of the two refs that represent shipped state.

**The ancestry cross-check**, which needs no knowledge of the CSS at all:

```
$ git merge-base --is-ancestor 82a6030 u5-retention-and-deletion; echo "exit=$?"
exit=1
$ git merge-base --is-ancestor 82a6030 origin/main; echo "exit=$?"
exit=0
$ git merge-base u5-retention-and-deletion origin/main
3e7aef6e57cb3277c3e12ceb9f41ea929cd4bdf4    # docs: U5 handoff ... (#12), 2026-08-23 14:33
```

The branch predates the fix by three and a half hours and never picked it up. Nothing
regressed; a stale fork was read as the present.

**The structural version — before and after.** Before, the agent inherits the ambient
checkout:

```bash
# agent runs wherever the session happens to be
grep -rn "margin: 0 !important" packages/map/assets/
```

After, the orchestrator owns the snapshot the agent sees:

```bash
git worktree add /home/damienriehl/worktrees/porchfest-audit origin/main --detach
# dispatch the agent with cwd=/home/damienriehl/worktrees/porchfest-audit
git worktree remove /home/damienriehl/worktrees/porchfest-audit
```

No other session holds a reference to that directory, so no other session can move it
out from under the read.
