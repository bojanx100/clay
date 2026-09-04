# Thread identity and uncategorised routing (2026-08-26)

## Task

`clay-fix-thread-identity-and-uncategorized-routing-20260826`, canonical
ProjectRef `5332aafc-31e7-5cb1-ba96-c8d90e78260e`.

## Symptoms and reproduction

Two alternate summaries classified at the same canonical next-turn position
created two automatic topics before this change. The old id was a hash of the
inferred group and derived display title, so changing wording changed the
durable topic id. Projection and client deduplication correctly deduplicated
only equal durable refs, which left those title-only variants visible as two
Threads.

A low-information owner turn such as `Where are we now` was durably attached
to `uncategorised-conversations`, and the catch-all seed was always projectable.
The result was a visible catch-all Thread even when the turn named no durable
subject and had no evidence connecting it to existing work.

## Root cause

Canonical ingress classifies before appending the new turn, so the next local
event position is the strongest available identity evidence. The classifier
did not receive that evidence and instead used display-title text to mint an
automatic id. Retro extraction already had the durable storage id and turn
anchor, but it did not feed that anchor into classification. The projection
layer then had no safe way to distinguish an unresolved triage membership from
a meaningful uncategorised topic.

## Fix

- Automatic Thread identity now hashes only the canonical Lead turn anchor
  (`projectId`, `sessionStorageId`, `eventIndex`) when ingress evidence exists.
  New topics persist the same evidence in `threadIdentity`; title refinement
  remains independently machine-managed, so owner renames are preserved.
- Live and retro classification pass the canonical next-turn anchor. Existing
  open topics with the exact anchor are reused even if their inferred title or
  group differs. A deterministic retro convergence pass backfills legacy
  title-only identities and merges only exact same-anchor, same-group,
  unmodified automatic rows through the audited Thread merge path. Manual,
  closed, handed-off, dispositioned, or linked work is never auto-merged.
- The uncategorised seed remains durable for audit and replay, but projection
  treats it as temporary triage: with history, only a meaningful owner subject
  that has no non-catch-all topic connection is shown. Noise-only and already
  connected catch-all memberships are withheld instead of becoming a visible
  junk Thread. Reference-only projections without history retain the seed for
  administrative inspection.
- No canonical transcript records are rewritten or deleted. Existing merges
  retain `threadCorrections` audit evidence and source `mergedInto` refs.

## Verification

- Before the fix, in a detached worktree containing only the new regressions,
  the two regression tests failed 2/2: the alternate title created a second
  topic and the noise-only catch-all projected.
- After the fix, the same regressions pass 2/2. The distinct next-anchor case
  remains a separate Thread, and an injected legacy title-only duplicate is
  merged with an audited correction.
- Focused topic suite: 108/108 passed.
- Broader topic/thread/projection/access suite: 510/510 passed.
- `test/codex-recovery-loop.test.js` rerun independently: 26/26 passed after
  one transient failure during the full run.
- `npm test` reached 318/319 files. It stopped with SIGINT after the unrelated
  `test/coop-owner-requests.test.js` child consumed more than seven minutes at
  100% CPU without completing. That file imports only the owner-request ledger
  and does not load the changed topic modules; the complete independent
  topic/thread/projection/access run passed.
- Syntax checks and `git diff --check` passed. No live `~/.clay` state was
  touched.
