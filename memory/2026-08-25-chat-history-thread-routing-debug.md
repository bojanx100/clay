# Chat history and Thread routing investigation — 2026-08-25

Status: DONE

## Symptom

In the canonical Coop session, ordinary Main requests such as `Do it` and
`Fix it` were persisted with `coop_thread_control` ambiguity and the question
`Which Thread should I apply that to?`. The same session lineage also exposed
only the current compacted continuation instead of the earlier relevant
conversation.

## Root cause

1. `lib/coop-thread-intent.js:resolveDominantTarget` required the topic index's
   `canonicalSessionStorageId` to equal the current Coop session storage ID.
   Coop compaction changes the current storage ID while the durable topic index
   can still correctly point at an ancestor. The resolver therefore returned
   `canonical_coop_required` before inspecting exact evidence.
2. `lib/sessions-history.js`, `lib/project-sessions-history.js`, and
   `lib/coop-topic-connection.js` replayed and paged only `session.history`.
   Compaction intentionally starts a new provider session, so predecessor
   histories were not part of the owner-facing transcript view.
3. The ingress parser treated every unscoped implementation phrase as a
   Thread-control clarification even when resolution produced no exact target.
   That made an unproven ordinary implementation follow-up look like a
   lifecycle command. A resolver result with genuine multi-Thread ambiguity
   still remains a clarification.

Live evidence came from the canonical Coop JSONL and topic index: the affected
session was a compaction descendant, while the topic index remained pinned to
an older canonical storage ID. The current successor contained only the
continuation transcript.

## Fix

- Added `lib/coop-session-history.js`, a transient oldest-to-newest history view
  across verified compaction predecessors. It never mutates provider session
  history or durable records.
- Wired that view into default replay, generic history pagination, Main and
  selected Topic membership indexes, exact-event focus, and session-manager
  history access.
- Made dominant-target resolution accept an exact canonical ancestor present in
  the verified lineage and map topic evidence by its original storage ID and
  event index.
- Kept explicit route validation and multi-Thread fail-closed behavior intact.
- Suppressed only the unproven unscoped implementation classification; lifecycle
  commands and genuine `thread_target_ambiguous` results still ask for a
  precise Thread choice.

## Verification

- Focused relevant suite: 81 tests, 81 pass, 0 fail across:
  - `test/coop-thread-intent.test.js`
  - `test/session-history.test.js`
  - `test/project-connection-handlers.test.js`
  - `test/coop-topic-relevance.test.js`
  - `test/coop-composer-scope.test.js`
- Revert proof: after reverting implementation files while retaining the new
  regressions, 36 tests produced 33 pass and 3 fail. The failures were the bare
  Main request, compacted ancestor target, and predecessor replay regressions.
  Restoring the implementation returned the same 36 tests to 36 pass, 0 fail.
- `git diff --check` passed.

## Remaining evidence

No live browser/device UI run was performed in this code-only checkout. The
server-side replay and WebSocket connection paths are covered by the focused
connection tests; a post-deploy reconnect/scroll check remains the appropriate
device-level confirmation.
