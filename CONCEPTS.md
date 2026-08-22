# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Season and scheduling

### Season

One neighborhood porchfest event and everything gathered for it — the hosts, the performers, the schedule, the messages. A deployment carries successive Seasons side by side, and every record belongs to exactly one; there is no global roster.

A Season moves forward through named states and never backward: setup, signups open, signups closed, assigning, locked, archived. Each state names which actions stay legal, and that gate belongs to the domain layer rather than the interface. Correction stays legal in every state except archived. The one deliberate exception to Season isolation is looking up a Contact from an earlier Season to re-invite them, which records the Season it came from.

### Slot

A window of time at one Venue that an Act can be scheduled into. A Slot is open, held, or assigned; only an open Slot can receive an Assignment.

### Hold

A Slot reserved for a named act that has not signed up yet, carrying a decide-by date and optionally a fallback Venue. A Hold blocks assignment. Passing the decide-by date makes the Hold _releasable_ and surfaces it to the Organizer — it never auto-releases, because a schedule that quietly changes itself is worse than one that waits. Releasing offers the fallback Venue as the next assignment target. The held-for name does not have to match any Act record, which is what lets a Hold represent an act penciled in before its host has filed a form.

### Assignment

The placement of one Act into one Slot. Assignments are how a Season's schedule exists.

## Records and their lifecycle

### Venue

A porch offered as a performance space, belonging to a Host.

### Act

A performing group, with the contacts, gear needs, and preferences that decide which Venue suits it.

### Contact

A person reachable about a Venue or an Act. Contacts are Season-scoped and may be deliberately reused across Seasons for re-invites.

### Organizer

A person who administers a Season — reviews signups, corrects records, assigns Slots, triggers messages. A Season has several. Organizer is a role in the domain rather than a stored record; the storage layer does not yet model Organizers or scope anything to an individual one.

### Placeholder

A Venue or Act an Organizer created for a party that has not filed its own form yet, recording how that party is reached — through another party's contact, or a manually entered address. A Placeholder is a real, schedulable record: it can hold Assignments and accumulate message history before the party ever submits anything.

### Promotion

Folding a real submission into the Placeholder that stood in for it, so the Placeholder becomes the canonical record. Promotion must carry the submission's Assignments, Slots, and message history across — losing them is the failure this process exists to prevent. Fields the submission leaves empty keep the Organizer's values rather than being cleared.

### Supersession

Marking one record as replaced by another canonical record, in either direction. A superseded record never reappears in the Activity Queue and never receives its own messages, but its history survives. Supersession and Promotion are distinct: Supersession retires a duplicate, Promotion merges a stand-in with the real thing.

### Activity Queue

The list of records needing an Organizer's attention — new signups, participant edits, change requests. Superseded records are excluded from it by design.

## Concurrency

### Version guard

The rule that a record is changed only by a writer who knows its current version. The expected version is enforced inside the write itself and the write's own outcome decides whether it succeeded — never by reading the record, comparing, and then writing, which lets two writers both pass the comparison before either writes. A timestamp cannot serve as the version token; two writes can share one.

This project treats a version guard as untested until someone has deliberately broken it and watched a named test fail, because a broken one fails silently: it reports success for a write that destroyed another's.

## Relationships

- A Season owns every other record; nothing is shared between Seasons except a deliberate prior-Season Contact lookup.
- A Slot belongs to a Venue; an Assignment joins one Act to one Slot.
- A Hold occupies a Slot without an Assignment, and may name a fallback Venue.
- A Placeholder is a Venue or an Act, not a separate kind of record; Promotion resolves it against a real submission.

## Flagged ambiguities

- _Promotion_ and _Supersession_ both point one record at another and were easy to conflate early on. They are distinct: Promotion merges a stand-in with the submission it stood in for and must preserve the stand-in's Assignments and history; Supersession retires a duplicate and removes it from queues and messaging.
