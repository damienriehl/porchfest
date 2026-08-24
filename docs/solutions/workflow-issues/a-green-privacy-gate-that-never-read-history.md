---
module: scripts
date: 2026-08-23
problem_type: workflow_issue
component: clean_room_scan
severity: high
related_components:
  - ci
  - test_fixtures
tags:
  - privacy
  - git-history
  - false-negative
  - self-test
  - public-repo
applies_when: "A repo has a privacy or secret scanner whose routine test-suite entry point scans a narrower scope than its full run."
related:
  - "docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md"
---

# A privacy gate ran on every commit and still missed the thing it exists to catch

## Context

The Definition of Done says no participant PII is committed, in the tree or in an
image. `scripts/clean-room-scan.mjs` enforces it, and `npm test` runs it, so every
gate on U5 PR 5 was green from the first commit to the last.

A test fixture in `packages/core/test/records.test.ts` read:

```ts
phone: "<Saint Paul area code>-555-0100",   // written out in full in the original
```

That literal is not reproduced here, for the reason this document exists: the scanner
reads every file in the tree and in history, and a document _about_ the finding would
otherwise reintroduce it. Writing it out is what makes CI red.

`555-01xx` is the reserved fictional range, so the number cannot reach a person. But
the area code is Saint Paul's — the neighborhood this application serves — and the
repo's own convention everywhere else is a non-numeric placeholder
(`synthetic-host-phone`, `synthetic-performer-phone`). The scanner's phone rule
flagged it correctly.

It flagged it four commits late, and only because a _different_ gate happened to run.

## What actually happened

`npm test` ends with `node scripts/clean-room-scan.test.mjs` — the scanner's **self
test**, which proves the scanner still refuses known-bad content. The scanner's real
run (`node scripts/clean-room-scan.mjs`) scans the working tree **and `git rev-list
--all`**. Those are different scopes, and only the second reads history.

The fixture landed in the working tree and in a commit. The working tree got cleaned
up by nothing in particular; the commit kept it. Every `npm test` stayed green.

The finding surfaced by accident: `npm run test:container` failed on this machine for
an unrelated Docker networking reason, and its log — which invokes the full scan —
carried the real error underneath the noise:

```
ERROR: clean-room scan found possible participant phone number
       at history 55a3c3aa89bd:packages/core/test/records.test.ts
```

Had Docker been healthy and the container gate passed, nobody would have read that
log. Had the branch been pushed first, the string would have been permanent.

## The shape of the mistake

**A gate's routine entry point scanned less than its full run, and the narrower scope
was the one wired into the loop everybody actually runs.** The self test answers "does
the scanner still work?" It does not answer "is this repo clean?" Both printed `OK:`
lines, one line apart, in the same command's output:

```
OK: clean-room self-test refuses participant-data artifacts and content   <- npm test
OK: clean-room scan found no participant-data artifacts in working tree
    (including ignored paths) and Git history                             <- the real run
```

Reading the first as though it were the second is easy, because it is the one that
scrolls past on every commit.

## Why history, specifically, is the part that matters

For a repo intended to go public, a working-tree scan is close to worthless on its own.
Deleting the line fixes the tree and changes nothing about the commit — `git log -S`
still returns it, and a public repo hands that to anyone. Retrofitting redaction after
a push does not work. The only cheap moment is before the first push, while history is
still local and rewriting is a rebase rather than a coordinated force-push.

That is what happened here: the branch had never been pushed, so

```bash
git rebase main --exec 'sed -i "s/<bad>/<good>/g" <file> \
  && git add <file> && git commit --amend --no-edit --only <file>'
```

purged it from all four commits that carried it, and the verification is
`git grep <bad> $(git rev-list main..HEAD)` returning nothing.

## What to do

- **Run the full scan before the first push of a branch, not just `npm test`.** The
  history scope is the one that cannot be fixed later.
- **Do not read a self test as a clean bill of health.** When a suite prints `OK:` for
  both a scanner's self test and its real run, the wording has to make the scope
  obvious, because the two lines sit together and only one is about this repo.
- **Keep fixture data non-numeric.** `synthetic-manual-reach-phone` cannot trip a phone
  rule, cannot be mistaken for real, and needs no reasoning about reserved ranges. A
  fixture that requires knowing NANP reserved blocks to evaluate is a fixture that will
  be evaluated wrongly.
- **Do not let a real area code near test data in a repo scoped to one neighborhood.**
  The reserved-range argument is correct and irrelevant: the scanner is pattern-based
  by design, and a scanner that trusted area codes would be the weaker tool.

## It happened again the same day, in the sibling gate

Hours after this was written, the identical shape appeared in the _other_ checker.

`scripts/check-core-boundary.mjs` refuses a dotted `get(` call under
`packages/web/src`, because that reads as a route registered outside the central
registry. A refactor added a shared `admin-http.ts` whose doc comment _explained that
rule_ — and wrote the offending accessor out three times to explain it. The scanner
reads comments. Three violations.

It survived a full local gate run, because `npm test` was:

```
vitest run && node scripts/check-core-boundary.test.mjs && node scripts/clean-room-scan.test.mjs
```

Two **self**-tests and no real check, exactly as described above. CI ran
`npm run check:boundaries` and `npm run check:clean-room` as separate steps, so CI
would have caught it and the local command could not.

The fix was not another rule for humans to remember. `npm test` now runs both self-tests
**and** both real checks, so the routine command matches what CI actually enforces:

```
vitest run
  && node scripts/check-core-boundary.test.mjs && npm run check:boundaries
  && node scripts/clean-room-scan.test.mjs   && npm run check:clean-room
```

It prints six `OK:` lines now instead of three. Verified by mutation: reintroducing the
accessor into that comment makes `npm test` exit 1 and name the file and line; removing
it restores the file byte-identically.

**The general rule:** when a check has a self-test and a real run, the routine command
must run BOTH, or the self-test becomes a decoy that reads like coverage. Two different
gates in this repo had that shape, and both were found by accident rather than by the
suite.

## The wider point

This is the same failure family as suppressing stderr on a check whose empty output you
intend to read as a negative result. Here nothing was suppressed — the narrower check
simply ran in the loop and the wider one did not, and both said `OK`. **An all-clear is
a claim about where you looked.** When two checks share a name and differ in scope, the
one wired into the routine command will be the one people believe.
