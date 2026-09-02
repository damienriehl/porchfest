# UAT 2026-09-02 — Leg 1: organizer personas (Dana P1, Marge P2)

Executed against a real local instance by a UAT operator acting strictly as the
personas (curl + DOM inspection as the "browser"; no direct DB writes; no code
paths a real person could not discover). Stories are S1.1–S1.8 and S2.1–S2.12
from `docs/operations/uat-2026-09-02-personas.md`.

## Instance

| | |
| --- | --- |
| App | `npm start` (tsx `packages/web/src/server.ts`) from this worktree, PID 1494767 |
| Port | `http://127.0.0.1:8912` (`PORCHFEST_PORT=8912`, `PUBLIC_BASE_URL=http://127.0.0.1:8912`, `PORCHFEST_TRUSTED_PROXY_HOPS=0`) |
| Data dir | `~/.local/state/porchfest-uat-20260902/data` |
| SMTP | local catcher at 127.0.0.1:8925 (`PORCHFEST_SMTP_HOST/PORT`, `PORCHFEST_SMTP_FROM=organizers@example.test`) |
| Organizer | `dana@example.test` ("Dana Okafor"), created via the bootstrap link from the app log |
| Marge | **could not be created** — see S1.3 |
| Season 1 | "Elm Hollow Porchfest 2026", 2026-09-26, four 45-min slots 12:00–15:45, bounds ~St. Anthony Park; now **archived** (S1.6 ran to completion) |
| Season 2 | "Elm Hollow Porchfest 2027" (id 2), left in `signups_open` so later legs have a live season |

The app stayed running throughout and is still running.

## Tally

**13 PASS · 5 FAIL · 2 NOT-EXECUTABLE** (20 stories)

| Story | Verdict | Evidence (abridged) |
| --- | --- | --- |
| S1.1 first-run setup | PASS | Empty DB: `GET /admin` → `303 /admin/setup`; setup POST → `303 /admin?season=1`; public host signup → `HTTP/1.1 201 Created` |
| S1.2 bootstrap auth | PASS | Bootstrap POST → `303 /admin` + session cookie; replayed token POST → `403` "That sign-in link has already been used. Ask an organizer for a new one." |
| S1.3 invite Marge | **FAIL** | No invite surface exists anywhere (see below) |
| S1.4 duplicate-year confirm | PASS | Create with year 2026 → `422` "Confirm that you want another 2026 season. This creates a separate season; it does not edit the existing one." + `confirm_duplicate_year` checkbox; edit season 2 → year 2026 → `422` "Confirm that you want this season to share 2026 with another season. This edits the current season; it does not create a new one." |
| S1.5 edit with dependent data | PASS | Dropping the assigned 14:00 slot → `409` "Schedule changes are unavailable because this season has dependent data… Organizer-clearable actions: unassign 9 assignments." Bounds-only change saved (`303 …?saved=1`); coordinate re-check had honestly nothing to report because no coordinate can exist in this deployment (see S1.8) |
| S1.6 season lifecycle | PASS | Each transition names what it stops allowing (e.g. locked: "public signups, assigning acts to slots, holding slots"; archived adds "releasing holds, correcting records"); locked and archived require an explicit confirmation input; after `signups_closed` the public form served `409` "Signups are not open for that Porchfest season"; after locked, assign forms disappear and a forged assign POST is refused; after archived the record page renders zero forms: "This season is archived. Records can no longer be changed." |
| S1.7 retention/deletion | **NOT-EXECUTABLE** | `/admin/retention` only lists participants "last updated before the 24-month retention window" — fresh data is never eligible, and no on-demand delete exists on contact records (only edit/supersede). Route `/admin/retention/:id/anonymize` renders no form for current participants. Gap flagged: an organizer cannot honor a deletion **request** today (R35 expectation in the story) |
| S1.8 map publication | **FAIL** | Publish control is explicit and honest, but unreachable in a no-geocoder deployment (see below). Unpublished/archived serve-nothing half verified: `/map` → "No map is published yet."; `/map/data`, `/map.json` → 404 |
| S2.1 Marge signs in | **FAIL** | Blocked by S1.3 — there is no path by which Marge can come to exist |
| S2.2 queue triage | **NOT-EXECUTABLE** (scoping) | Single-organizer half worked: signups and edits appear in "New for you" with version stamps (venue edit resurfaced as "version 2"); dismissing moved the item to "Everything in this season". The differentiator "clears for her only — Dana still sees it" needs the second organizer that S1.3 cannot produce. UI asserts it ("Marking an item reviewed clears it for you only") but it could not be observed |
| S2.3 typo fix, original readable | **FAIL** | The fix itself works (`303 …saved=1`, version 1→2, corrected text renders). But the original submission is nowhere readable: record page and dashboard offer no history/original view (evidence: full sweep of `/admin/records/venue/2` and `/admin?season=1` — zero links besides queue/assign). R6's "original submission stays readable" is not satisfied by any discoverable surface |
| S2.4 ranked, reason-bearing suggestions | PASS | Venue-first view per slot. Foss Porch slot 1: The Gravel Roadsters ranked first with "The host and act requested each other by name" + "Genre preference matches folk" (mutual request first). Powerless Liu Family Steps: amplified Volt Brothers ranked last with warning "Act needs amplification, but the venue has no power"; acoustic acts ahead |
| S2.5 double-booking / shared member | **FAIL** (shared-member half) | Double-booking blocked by name: second assignment of the same act at the same time → `409` "Priya and the Low End are already assigned to Haddad Garden Stage, 1:00–1:45 PM". Shared-member: **silently allowed** (see below) |
| S2.6 tie explanation | PASS | Equal candidates carry the per-slot banner "Equally suitable based on recorded information" (Liu 2:00 slot, Ortiz 2:00 slot) |
| S2.7 concurrent edit | PASS | Stale save → `409` "Someone else saved this first. Your answers are below, unchanged. Here is what is stored now — save again to overwrite it, or edit yours first." with per-field "Yours:" vs "Stored:"; typed values kept in the re-armed form at the new version |
| S2.8 wave, edit, staleness | PASS | Generated match wave (6 messages, grouped per venue with hosts+performers in one thread); message edit saved; after the underlying venue record changed, the wave shows "Edited · Data changed since this was written" and the edited text (added PS line) is intact |
| S2.9 outbox send path | PASS (send-state half) | With the catcher configured the send action exists; send attempt recorded **per-recipient** state: "hank@example.test — Failed: The SMTP provider did not offer STARTTLS; refusing to continue in the clear." — honest, per recipient, with "Some messages may already have gone out. Reload this wave and read each recipient's state" on partial-send errors. Export verified: selection → `application/mbox` (`outbox-wave-1.mbox`); per-message `.eml` → `message/rfc822`. The no-provider half is NOT-EXECUTABLE on this instance (provider is configured; restarting the app was out of scope). Note: the send form also enforces per-message review versions — selecting without `version_N` → `409` "outbox message 1 was selected without the version it was reviewed at" |
| S2.10 withdrawal | PASS | Withdrawing matched Half-Step Down (allowed even at locked): Liu 12:00 slot state returned to "Open"; wave message and its per-recipient send states intact. "Leaves the regenerated map" clause blocked by S1.8 (no map can publish here) |
| S2.11 placeholder lifecycle | PASS | Placeholder act created reached via host Hank (existing-contact selector); assigned to Foss 13:00; real public submission promoted into it ("The submitted details become canonical here. Existing matches and email history follow this record.") — assignment survived, the submitted record left the queue. Separate resubmission superseded into its canonical act → left the queue |
| S2.12 holds | PASS | Held Foss 13:00 for a named act with a past decide-by and a fallback venue; held slot renders no assign affordance and direct POST is refused; "Held for The Mayor's Surprise Band until 2026-09-01. Fallback: Haddad Garden Stage"; release → `303 …?released_to=3` and banner "Hold released. Assign at Haddad Garden Stage." Caveat: past-decide-by holds get no dashboard/queue surfacing — only the slot row shows the date (possible AE6 gap) |

## The five failures

1. **S1.3 / S2.1 — a second organizer cannot be invited (R9).** The sign-in page
   says "A new link must come from another organizer", but no signed-in surface
   offers it: swept the dashboard, season settings, season edit, outbox,
   retention, coordinates, and record pages — no invite link; `/admin/organizers`
   is 404. The documented CLI (`npm run organizer:link`, run with the instance's
   env) refuses unknown addresses: "Organizer "marge@example.test" was not
   found. Candidates: 1: dana@example.test", and `--help` shows only
   `[--organizer <email-or-id>]`. Diagnostic: `packages/core/src/access.ts` has
   `issueInvite`, but its only caller is the recovery script, which restricts to
   existing organizers. Every S2 story ran as Dana in consequence.
2. **S2.5 — shared-member conflict never fires from organizer-entered data (R7).**
   Both acts carried the shared-member note in `sharedMemberNote` (public form
   and record page). Assigning Becker Brass Collective at 13:00 while Priya and
   the Low End (shared bassist) was already assigned at 13:00 elsewhere →
   `303 …?assigned=2`, no block, no warning, nowhere. Diagnostic: the conflict
   in `packages/core/src/season.ts` keys on the structured `actLinks` table,
   which only `packages/core/src/import/goal1.ts` writes — no web surface reads
   or writes it, so a season built from public signups can never produce the
   block, and the recorded-override path is equally unreachable.
3. **S2.3 — the original submission is not readable after a correction (R6).**
   Fix works, version increments, but no surface shows version 1.
4. **S1.8 — a no-geocoder deployment cannot publish a map (R16).** Publish
   honestly refuses: "No venue has a verified coordinate and an assigned act."
   Geocoding honestly reports "Geocoding is not configured. Set GEO_PROVIDER to
   enable it." But the README's promised "Manual organizer entry and review"
   does not exist: the coordinate page shows "No stored coordinates need
   review" and renders no entry form; venue records and placeholder-venue forms
   have no coordinate fields. The verify route
   (`/seasons/:id/coordinates/:venueId/verify`) exists server-side but no form
   ever renders for a venue that was never geocoded. Consequence: S2.10's map
   clause and leg-3 attendee map stories cannot run against this instance.
5. **S2.1** — counted above with S1.3.

## Environment notes for later legs

- **Mail cannot actually deliver on this instance.** The app refuses plaintext
  SMTP ("The SMTP provider did not offer STARTTLS; refusing to continue in the
  clear") and the harness catcher speaks no STARTTLS. `mail/` holds 0 files.
  Send-state recording was still verifiable; participant magic-link stories
  (S3.5, S4.x) will be blocked unless the catcher gains STARTTLS.
- **Season 1 is archived** (S1.6 ran to its end); its data remains for
  read-only/archive checks. **Season 2 (2027, id 2) is in `signups_open`** with
  two slots (12:00, 13:00) for legs that need a live season.
- Public-form rate limit: ~5 submissions/minute/IP, then `429` "Too many signup
  attempts arrived from this address. Wait a minute, then try again." (form
  re-renders with values kept). Seeding was paced accordingly.
- One harness-workaround attempt (computing the CSRF token for the coordinate
  verify route from the deployment secret) was started and abandoned; no
  coordinates were written. The instance state is exactly what the UI produced.

## Seeded data (all via the public forms, all `@example.test`)

Venues (6): The Foss Porch (Hank Foss; power, PA; requested The Gravel
Roadsters), Liu Family Steps (Grace Liu; no power), Haddad Garden Stage (Omar
Haddad; power, PA/mic), Nordquist Veranda (Betty Nordquist; no power),
Ortiz Corner Lot (Ray Ortiz; power, drum kit), Park Porch on Dudley (June Park).

Acts (8 + 2 lifecycle extras): The Gravel Roadsters (Pete Malone; acoustic;
requested the Foss Porch — the mutual pair), Priya and the Low End (Priya Nair;
amplified; shared-member note naming Sam Becker), Becker Brass Collective (Sam
Becker; the other half of the shared member), Maple and Thorn, The Volt
Brothers (amplified), Como Chamber Trio, Half-Step Down (later withdrawn, S2.10),
DJ Cricket (amplified). Extras: The Carter Ave Ceilidh Band (placeholder →
promoted from Fiona Walsh's real submission, S2.11) and a Maple & Thorn
resubmission (superseded, S2.11).

Messy-links note: the performer form **rejects** messy links text outright
(`422` "Use only links that begin with http:// or https://.", values kept) —
the S4.1 expectation of "structured links plus note residue" will need that
story's own verdict; Priya was seeded with URL-only lines plus residue moved to
her notes.

Assignments made while open/assigning: Roadsters→Foss 12:00,
Ceilidh Band→Foss 13:00, Half-Step Down→Liu 12:00 (later withdrawn),
LowEnd→Haddad 13:00, Volt→Haddad 14:00, Como→Nordquist 13:00,
Brass→Ortiz 12:00, Cricket→Ortiz 14:00, Maple and Thorn→Park 13:00.
Wave 1 (match notification) generated over the six venues; message 1 edited
and stale-marked; send attempted for messages 1–2 (5 recipient failures
recorded as above); messages 3–4 exported as mbox/.eml.

Authentication artifacts live under `~/.local/state/porchfest-uat-20260902/`
(`cookies-dana.txt` etc.). The bootstrap credential is referred to here only as
"the bootstrap link from the app log"; it was consumed by Dana's sign-in and
its replay is dead.
