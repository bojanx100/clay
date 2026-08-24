# Main Lead-tick repetition diagnosis

## Symptom

The Clay Coop Main conversation repeatedly displayed the Lead tick commentary
pair `Running the tick; I'll report only if the state changes.` and `No state
change...`, while the owner message below the noise was easy to miss.

## Root cause

The synthetic Lead `user_message` opener carried automation provenance and was
classified as internal, but the following `delta`, `result`, and `done` records
were classified independently. Those records have no repeated opener metadata,
so the per-record denylist treated each continuation event as owner-facing.
Every scheduled tick therefore appended another visible commentary/status pair.

## Repair

The replay predicate now carries internal-turn state from each synthetic opener.
It keeps one first distinct progress text as a meaningful milestone, retains
genuine owner-actionable blockers/questions, and suppresses repeated progress
and terminal noise. The live client uses the same tracker before rendering,
resets it on session/history boundaries, and returns to the ordinary owner path
when a provenanced owner message arrives.

## Evidence

- The owner transcript at `~/.clay/sessions/-Users-bojansubotic--clay-lead-workspace/871a194b-8879-40f7-a1fe-656e48e722af.jsonl` contains the alternating tick events and the owner complaint.
- Running the repaired server predicate over that canonical slice returns one
  copy of each distinct tick status and keeps the owner complaint.
- With the replay repair temporarily reverted, the focused regression failed by
  re-admitting both repeated tick turns and their `done` records.
- With the live tracker temporarily reverted, the focused regression failed
  because the second identical tick delta was classified as `owner`.
- Focused replay/topic tests pass 50/50; live/rendering tests pass 17/17.
- The controlled-execution suite passes 490/490. The repository default suite
  has two unrelated existing failures: the archived-control navigation fixture
  in `test/coop-main-lens-interaction.test.js` and a raw control byte in
  `test/coop-owner-response-linkage.test.js`.

## Validation boundary

The connected in-app browser runtime had no available browser instances, so a
browser screenshot/send verification could not be performed here. The
canonical transcript projection and live tracker regression are the observable
integration substitute; no live owner message or durable live state was
mutated.

## Follow-up: event-loop starvation guard

The same owner-facing Main conversation also became vulnerable to server
event-loop starvation because its canonical Coop history could grow without
bound. Cleanup classification correctly requested compaction at the message
threshold, but the runtime returned `active_session` before it could reach the
existing safe `permanent_coop_conversation` continuation path. The active Coop
home was therefore skipped even while idle.

The runtime now permits only idle canonical Coop homes and project channels to
reach the existing compaction-and-continue path. Processing, unread, attention,
active-binding, and unresolved-work guards still defer maintenance. This keeps
the owner conversation responsive without allowing cleanup to interrupt live
work or owner-visible activity.

Evidence:

- The focused runtime and cleanup tests pass 34/34, including the new active
  Coop home and unsafe-state regressions.
- With the active-session guard restored temporarily, the new idle-active-home
  regression fails 1/2 selected tests because compaction is skipped; with the
  exemption restored, both selected tests pass 2/2.
- The implementation is a one-line guard-ordering change; no live `~/.clay`
  state was edited.
