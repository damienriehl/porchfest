# The organizer UAT — what to hand a tester, and why it is a task sheet

U5's Definition of Done is not a test result:

> an organizer **other than Damien** completes the Tuesday-night loop end to
> end, **unaided**, on a local instance — a record gets corrected, gets
> assigned, and produces a reviewable message.

Read that twice, because it decides the shape of this document.

## What this is actually measuring

"Unaided" is the whole test. It is not asking whether the code works — 452
automated tests already answer that, and a full browser walkthrough of every
built surface answers the rest. It is asking whether **a person who did not
build this can figure it out**, which is a property of the interface, not the
implementation.

That is why what follows is a list of **outcomes to achieve**, not steps to
follow. A click-by-click script would hand the tester exactly the knowledge the
test exists to discover they lack. If the tester needs the script, the product
has already failed the gate — so the script must not exist.

Give the tester the tasks. Give the observer the recording sheet. Say nothing
else.

## Before you can run this at all

**The loop is complete.** The DoD names three things in sequence: a record
gets corrected, **gets assigned**, and **produces a reviewable message**.
Assignment landed with U6 and the outbox with U7, so every task below is
runnable. Leave the email adapter unconfigured: the outbox then offers
copy-paste and export instead of a send button, which is the deployment a new
festival starts from and exactly what task 5 asks the tester to find.

## Setting up for the tester

One instance, one fresh database, no seeded data. The tester should meet the
same empty deployment a new festival would.

```bash
nvm use 24                      # engines, CI, and the Dockerfile all pin 24
npm ci
PORCHFEST_DATA_DIR=./uat-data \
PUBLIC_BASE_URL=http://127.0.0.1:9398 \
  npm start
```

The first organizer account does not exist yet. The application prints a
single-use bootstrap link to its own log on boot — **give the tester the log, or
the terminal, and let them find it.** Finding it is part of task 1. Handing them
the URL skips the first thing being measured.

Leave email and anti-bot adapters unconfigured. That is the deployment a new
festival starts from, and the application is designed to work without them.

## The task sheet — give the tester this, and nothing more

> You are an organizer for a neighbourhood porch festival. The software is
> running at `http://127.0.0.1:9398` and has never been used before. Work
> through these in order. If you get stuck, say so out loud and keep trying —
> being stuck is useful information, not failure. Do not ask how anything works.
>
> 1. Get yourself an organizer account and open a season that can accept
>    signups. It runs on a Saturday next September, in this timezone, in this
>    neighbourhood, with two afternoon time slots.
> 2. As a neighbour, offer your porch as a stage. Then, as a musician, sign your
>    act up to play.
> 3. Find both of those in the organizer view. The porch's name is wrong — fix
>    it. Then mark the porch confirmed.
> 4. Put the act on the porch, in a slot. The software should tell you why it
>    suggests what it suggests — say out loud whether that helped.
> 5. Produce the message that tells them both, and read it over before
>    anything is sent. Fix one word in it.
> 6. Close the season for the year.

## The observer's sheet — this is the actual result

Record per task. The tester's commentary matters more than the timing.

| #   | Task              | Completed unaided? | Time | Where they hesitated | What they expected instead |
| --- | ----------------- | ------------------ | ---- | -------------------- | -------------------------- |
| 1   | Account + season  |                    |      |                      |                            |
| 2   | Both signups      |                    |      |                      |                            |
| 3   | Correct + confirm |                    |      |                      |                            |
| 4   | Assign            |                    |      |                      |                            |
| 5   | Message           |                    |      |                      |                            |
| 6   | Close season      |                    |      |                      |                            |

Write down verbatim:

- **Every question they asked.** Each one names a place the interface did not
  explain itself. These are the finding list.
- **Every wrong turn**, including ones they recovered from. A recovered wrong
  turn is still a defect; they simply paid for it themselves.
- **Anything they said out loud** while hesitating. "Where do I…" and "I thought
  that would…" are the highest-value sentences in the whole exercise.

**The gate is per task, not overall.** Any task the tester could not finish
without help is a failed gate for that task, however small the help was. Do not
soften this: "I only had to tell them where the button was" is the finding.

## What is already known to work, so the observer can tell defects from noise

Verified by walking a real instance in a browser on 2026-08-24, plus the
automated suite (500+ tests after U6):

- First-run setup opens a season that accepts signups.
- Both public signup forms accept a submission and show a receipt that separates
  what is public from what only organizers see.
- Both signups arrive in the organizer queue.
- A field correction saves and confirms; a status change saves.
- A refused submission keeps every answer the participant already typed and
  names only the fields that need fixing.
- The retention page renders and reports the deployment's window.
- Unauthenticated requests to organizer routes are refused.
- Every form control has a label, focus is visible, and touch targets are at
  least 44×44 at phone width.

Covered by automated tests only (U6 on 2026-08-28, U7 on 2026-08-29 — no
browser walkthrough of either yet, so an interface finding here is expected,
not a regression):

- A venue's assignment page lists its slots with ranked candidate acts and the
  reasons beside each; an act's page lists its ranked slots the same way.
- A double-booking is refused with the conflict named; two acts that share a
  member need a recorded override to play the same hour.
- The season page offers only forward transitions and says what each stops
  allowing before it is taken; lock and archive ask for confirmation.
- The outbox generates a wave from stored records, lists every message with
  its recipients and state, lets an organizer edit the text, and — with no
  provider configured — exports copy-paste text and `.eml` instead of sending.

If the tester hits something in that list, it is a regression and worth
escalating immediately rather than filing as a usability finding.

## One thing the tester should not be asked to judge

Whether the _data_ is right. That is what the automated suite covers, and a
tester cannot see a version guard or a retention window. Keep them on the
interface: what they wanted to do, and whether they could.
