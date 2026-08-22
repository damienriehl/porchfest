---
module: agents
date: 2026-08-22
problem_type: workflow_issue
component: agent_dispatch
severity: high
related_components:
  - shell_scripting
  - ci
tags:
  - codex-workers
  - worker-wrapper
  - exit-code-masking
  - false-negative
  - silent-failure
applies_when: "Dispatching Codex workers with agents/worker-wrapper.sh, or wrapping any command whose failure you intend to detect from its exit code."
related:
  - "cockpit: CLAUDE.md (How to launch work)"
---

# A worker dispatch that never ran can look exactly like one that succeeded

## Context

Two Codex workers were dispatched for the U3 tail work from the cockpit root
(`~/Coding Projects`). Both exited within seconds having done nothing. The
orchestrator was told both had **succeeded**.

## What actually happened

Two independent faults lined up:

1. **`worker-wrapper.sh` takes its repo from the current directory** — `REPO_PATH=$(pwd -P)`,
   and it runs `codex exec` in that directory. The cockpit root is not a git repo, so Codex
   refused immediately with `Not inside a trusted directory and --skip-git-repo-check was
not specified.` The task file path being correct is irrelevant; the _invocation
   directory_ is what selects the repo.

2. **The launch command masked the failure.** It was written as:

   ```bash
   ./agents/worker-wrapper.sh <id> <task> ; echo "WRAPPER_EXIT=$?"
   ```

   The trailing `echo` is the last command in the list, so the compound command's exit
   status is the `echo`'s — zero. The harness reported "completed (exit code 0)" for a
   dispatch that had failed. The real status was visible only as a string in stdout that
   nobody had reason to read.

## The fix

Invoke the wrapper from inside the target repository, and propagate the status:

```bash
cd <target-repo> && /path/to/agents/worker-wrapper.sh <id> /abs/path/to/task.md
ec=$?; echo "WRAPPER_EXIT=$ec"; exit $ec
```

## Why this matters beyond one wrapper

This is the general shape of a **false negative**: a check whose "all clear" is
indistinguishable from never having run. It is the same family as `2>/dev/null` on a
command whose empty output you read as "nothing found."

- If a zero exit would mean _success_, never let a reporting command be the last one in the list.
- Prefer `ec=$?; …; exit $ec` over a trailing `echo "$?"`.
- Use `set -o pipefail` whenever piping something whose exit code matters.
- Strongest form: make the check self-reporting, so it prints something in every outcome
  and silence is never mistaken for a pass.

## How it was caught

Only because the orchestrator verified artifacts independently — `git status` showed a
clean tree when two workers had supposedly just finished writing code. Had it trusted the
reported exit code, it would have gone looking for changes that did not exist.
