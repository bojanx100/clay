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
