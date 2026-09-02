# Organizer UAT result — 2026-08-30 persona run

## Scope and method

This is the observer's sheet for the six tasks in
[`organizer-uat.md`](organizer-uat.md), consolidated from the organizer,
neighbour, and musician persona sheets in `uat/`.

The gate is per task. Because the prescribed tester was not a human using a
browser, **the formal gate is not established for any of tasks 1–6**. Within the
proxy run, tasks 1 and 3–6 were completed without human assistance. Task 2 fails
the method's strict unaided rule: it could start only because its supplied flyer
contained the participant routes and intended-season context that the organizer
interface had failed to surface. Task 1 also left an accidental second live
season. The proxy outcomes remain useful evidence, but they are not a substitute
for the method's human-browser gate.

This was not the human browser test prescribed by the method. The “tester” was
a Codex worker driving the rendered HTTP interface with `curl`. Request counts
are therefore recorded instead of elapsed time. The run observed route choice,
rendered copy, form values, validation, redirects, receipts, and persisted state.
It did **not** observe visual layout, visible focus, keyboard flow, screen-reader
output, or touch-target size. A human browser pass is still required for those
parts of the UAT.

## Observer's sheet

| #   | Task              | Completed unaided?                                                                                                                        |                                 Requests | Where they hesitated                                                                                                                                                                                                                         | What they expected instead                                                                                                                                                                     |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Account + season  | **Proxy: yes. Formal gate: not established.** The corrected 2027 season was open.                                                         | 17 total; 16 to the corrected completion | Whether the refused curl POST consumed the one-use token; timezone and bounding-box syntax; required fields; where public links lived; whether “next September” meant 2026 or 2027; how to correct the event without creating another season | A completion summary with date, timezone, slots, state, copyable host/performer/map URLs, and an event-details edit link. “You can change any of it later” should lead to an actual edit page. |
| 2   | Both signups      | **Proxy: no—assistance required. Formal gate: not established.** The supplied flyer provided both routes and the intended-season context. |               7: neighbour 3, musician 4 | Which of two open seasons to choose; event date/locality/slots; what would be public; how updates, corrections, or withdrawal would work; where a musician should describe needed versus lendable gear                                       | Season-bound links or a dated selector; event context on both forms; public/private labels before submission; a receipt reference and concrete next steps.                                     |
| 3   | Correct + confirm | **Proxy: yes. Formal gate: not established.** The rename and confirmation both persisted.                                                 |  7, including the initial `/` wrong turn | The base URL was a 404. Once on the record, the separate save and status controls were clear.                                                                                                                                                | The base URL should offer or redirect to a public or organizer entry point.                                                                                                                    |
| 4   | Assign            | **Proxy: yes. Formal gate: not established.**                                                                                             |                                        3 | The reasons established compatibility, but both slots had the same reasons and no stated tie-breaker.                                                                                                                                        | A rank/preference or an explicit statement that the slots are equally suitable.                                                                                                                |
| 5   | Message           | **Proxy: yes. Formal gate: not established.** The message was reviewed and one word was saved; nothing was sent.                          |                                        7 | Provider-disabled pages still said “press send” and “Review and send,” although only export actions were available.                                                                                                                          | Provider-aware “review and export” copy and a direct copy action. The notification should name the corrected porch.                                                                            |
| 6   | Close season      | **Proxy: yes. Formal gate: not established.** The 2027 season persisted as `archived`.                                                    |                                        3 | The tester had to translate “close the season for the year” into the raw `archived` transition rather than `signups_closed` or `locked`.                                                                                                     | “Close and archive season,” with the internal state name secondary and the same effect summary and confirmation.                                                                               |

## Consolidated finding list

Questions and wrong turns are de-duplicated below. Quotes are retained where
the interface wording itself is the finding.

### Defects

1. **D1 — A still-live first-run page created a duplicate live season.** After
   season 1 existed, `GET /admin/setup` still said **“First-run setup”** and
   **“Open your first season,”** rendered blank fields, and accepted another
   creation POST. The tester entered the page looking for the correction
   promised by **“You can change any of it later”** and instead produced season
   2 while season 1 remained `signups_open`. Both participant selectors then
   offered the mistaken 2026 season as an apparently valid target. This
   consolidates the questions “Which open season should I choose?”, “Why is
   2026 still accepting selections?”, “How should an organizer retire a
   mistakenly created season?”, and “If two seasons are open, which one does an
   unqualified signup use?” The interface did have an archive transition for
   season 1; the test harness, not the product, declined to perform that extra
   irreversible cleanup.

2. **D2 — Event details cannot be corrected through the organizer UI.** The
   setup promise **“You can change any of it later”** has no corresponding edit
   affordance. “Season settings & state” shows only name, year, and state; the
   conservative `/admin/seasons/1/edit` check returned 404. This is why the
   tester asked, “Where can I edit the event details after creation?” and why
   the duplicate-season wrong turn was possible.

3. **D3 — The receipt privacy promise contradicts the match notification.** The
   receipts put contact details and host organizer notes under **“Kept private”**
   and say **“Only the Porchfest organizers see these.”** The generated match
   email then sends both participants' contact details to the match and includes
   the venue's organizer notes under **“NOTES FROM YOUR HOST.”** Sharing contact
   and logistics details with a confirmed match may be intended, but it is a
   third audience—not “organizer-only”—and the participant was not told before
   submission. This also answers the question whether hosts or performers ever
   see private gear/access notes: under the observed implementation, some host
   notes do reach the matched participants.

4. **D4 — The generated match message contains a grammar defect.** It rendered
   **“Juniper Static need amplification; the porch reports power: Yes.”** The
   stored act and power values were correct, but the generated sentence is not.

5. **D5 — The match message omits the corrected porch name.** After task 3
   renamed the venue to **The Firefly Landing Porch**, the message identified it
   only by street address. The old name was not leaked, but the corrected name
   never appeared, making the task-3 correction less useful in the principal
   participant notification.

No 5xx response occurred. No valid participant input was refused. The one 422
was a deliberate non-URL value rejected by the form's stated `http://` or
`https://` rule, and every answer was retained. All requested state changes
persisted on read-back: porch rename, confirmation, assignment, message edit,
and archive. Apart from D3–D5, the message carried the correct recipients, act,
date, time, address, and contact data.

### Discoverability

1. **F1 — The application does not expose its public entry points.** Neither
   the organizer dashboard nor the season page showed copyable host signup,
   performer signup, or public-map URLs. `GET /` returned a bare 404. The tester
   then guessed `/signup`, `/signup/act`, and `/signup/acts`; all returned 404.
   The real flyer routes had to be supplied separately for task 2. This is the
   shared answer to “Where can I copy the public neighbour and musician signup
   URLs?”, “Is there supposed to be a public landing page at `/`?”, and “Where
   should an organizer start from the supplied base URL?”

2. **F2 — First-run fields do not consistently explain format or requiredness.**
   The timezone copy explains its effect but gives no accepted example such as
   `America/Chicago`. Bounds copy does not say latitude/longitude, decimal
   degrees, accepted ranges, or show sample values. Only the two signup-date
   fields say “Optional,” leaving the public-site, public-map, sender, locality,
   bounds, and other fields ambiguous. These gaps produced the questions about
   exact timezone spelling, coordinate units/range/precision, and which public
   and sender fields were required.

3. **F3 — Organizers cannot verify the one-pass event configuration.** The
   post-setup dashboard and season page omit event date, timezone, locality,
   bounds, time slots, public URLs, and sender identity. The missing summary
   amplified the task wording ambiguity over whether “next September” meant
   2026 or 2027 and made the setup promise difficult to verify.

4. **F4 — Public season choice lacks distinguishing context.** When more than
   one signup-legal season exists, the picker shows names only. It omits event
   date, locality, state, and a current/closed cue. The accidental open 2026
   season therefore looked equivalent to 2027. Closed seasons were not observed
   in the picker; the finding is to preserve that filtering while making every
   offered choice self-identifying.

5. **F5 — Selected signup forms omit the event context participants need.** The
   host and performer forms do not repeat season name, event date, locality, or
   slots. The performer must nevertheless enter required availability. This
   caused “What are the festival date, locality, and performance slots?”, “Must
   availability exactly match advertised slots?”, and “Should setup/teardown
   buffer be included?”

6. **F6 — Audience consequences are not labelled beside fields before
   submission.** The forms should distinguish at least **Public map**, **Shared
   with a confirmed match**, and **Organizer-only**. Most importantly, the
   host's full street address and the performer's links, duration, and
   amplification become public, while contact details and some host notes are
   later shared with the match (D3). Requested acts, preferences, availability,
   shared-member details, and lending answers remain organizer-only in the
   observed match flow. This consolidates both personas' privacy questions. The
   host form also does not explain whether “no rain backup” is acceptable or
   whether an amenity is for performers, the public, or both.

7. **F7 — The performer gear model is too implicit.** The form asks whether an
   act needs amplification and whether it can lend gear, but not what it needs
   or exactly what it can lend. The tester used generic organizer notes and
   wondered whether private gear/access notes would ever reach the matched
   people. The link field clearly accepts absolute HTTP(S) URLs; it offers no
   separate place for social handles or other non-URL references.

8. **F8 — Receipts are not durable next-step instructions.** They say no email
   will follow when delivery is unconfigured, but provide no participant-facing
   reference, status link, correction/withdrawal path, organizer contact, or
   explicit statement that self-service is not yet available. This covers the
   questions about how to save or quote a receipt, receive scheduling updates,
   correct or withdraw a submission, and what a host should do when availability
   or space changes—including the submitted question **“Where should hosts look
   for scheduling updates?”**

9. **F9 — Matching reasons do not explain ties.** “Why this match” correctly
   established genre, power, and availability compatibility. The two slots had
   effectively identical reasons, however, so the tester still had to ask
   whether a scheduling preference existed and chose the first slot by position.

10. **F10 — Provider-disabled outbox copy contradicts the available actions.**
    The page correctly says **“No email provider configured — messages can be
    copied or exported,”** but also says **“Nothing is sent until you select
    messages and press send”** and labels the section **“Review and send.”** No
    send button exists in that state, and there is no dedicated copy button.

11. **F11 — Season lifecycle labels require internal vocabulary.** The effects
    and confirmation made the action safe enough to complete, but “Move to
    archived” forced the tester to decide whether `archived`, `locked`, or
    `signups_closed` meant “close the season for the year.” The interface should
    answer the policy question rather than require it.

### Recorded wrong turns that were not product findings

- The first sign-in POST omitted the browser-generated `Origin` header and was
  correctly refused with 403. Retrying with browser-equivalent same-origin
  metadata succeeded and did not consume the one-use link. This is a curl-method
  artifact, not a visible-form defect.
- The musician deliberately submitted `hear us at the blue mailbox !!!` in a
  URL-only field. The focused 422, retained answers, and successful correction
  were expected behavior, not a defect.
- Local socket attempts blocked by the execution sandbox never reached the app
  and are excluded from request counts and findings.

## Gate result

**Formal human-browser gate: not established for tasks 1, 2, 3, 4, 5, or 6.**
**Proxy result: task 1 pass; task 2 fail because the flyer routes and
intended-season context were supplied help; tasks 3–6 pass.** D1, D3, and F1
also show that the organizer-to-participant handoff is not yet safe or
self-explanatory.
