# Coop end-to-end ownership debug — 2026-08-22

## Scope

ProjectRef: `5332aafc-31e7-5cb1-ba96-c8d90e78260e`

Task: `clay-coop-end-to-end-ownership-2026-08-22 rev1`

This investigation covered the exact owner approval at Coop ingress 605, the
owner-directed handoff at ingress 610, foreground continuation dispatch, restart
restoration, provider/rate-limit recovery, worker completion fan-in, and the live
Webapp/Voice/reaper/Class-B records named by the owner.

## Root causes

1. `coop-item-approval` evaluated the whole owner turn as an exact command. The
   owner put a valid exact approval first and pasted fenced diagnostic context
   after it; a question mark inside the fenced quote invalidated the approval.
2. `project-scheduled-messages` treated the presence of an idle resident Codex
   `queryInstance` as proof that the session was busy. A foreground drain could
   persist a Lead tick, but the scheduled sender deferred it every 30 seconds.
3. `project-session-adoption` resolved `sourceSessionId` only through the
   coordinator project's SessionManager. Canonical Coop lives in Lead while the
   owner-direct session lived in Clay, so the source was unfindable. The generic
   "unavailable or already owned" error collapsed that fact into a dead end.

## Fixes

- Exact approval parsing stops at a Markdown fence only after it has found the
  valid command. Unfenced prose and a fenced quote at the start remain invalid.
- Scheduled synthetic continuations gate on `isProcessing`; an idle resident
  query is reused through `pushMessage`, while a cold session still starts a new
  query.
- `adopt_session` now advertises `sourceProjectRef` and
  `ownerHandoffIngressId`. A cross-project alias requires both the exact stable
  SessionRef and an exact non-synthetic owner ingress that names the source.
  It never creates Lead-local execution or converts the owner-direct source into
  a local Lead worker.
- The alias persists a reference-only `workerSessionRef`, observes completion in
  the source project's SessionManager, and fans the result into the owning
  coordinator. Restart restoration reattaches the observer, immediately
  reconciles a completed source, and turns an unresolvable source into visible
  attention without waiting for an owner status request.
- Same-project semantics remain unchanged: a busy local source is rejected
  before any task is created.

## Executable proof

- Approval path with fix: 45/45. Production approval fix reverted while tests
  remained: 43/45.
- Foreground/scheduled continuation with fix: 8/8. Production sender fix
  reverted while tests remained: 6/8.
- Owner-directed handoff with fix: 5/5. Production handoff commit reverted while
  tests remained: 0/5. Restored: 5/5.
- Combined approval, foreground, scheduling, restart, orchestration,
  provider-failover, and rate-limit families: 188/188.
- Repository-wide: default 3079/3080; controlled 428/428. The sole default
  failure is `coop-main-lens-interaction`'s archived navigation expectation. It
  reproduces at pre-fix commit `67e1117524` (12/13 both there and at the fixed
  tip), so it is unrelated baseline debt. The full gate does not cover live
  daemon activation, a real browser, or iPhone speech recognition.

## Live reconciliation evidence

No live daemon restart or out-of-process binding rewrite was performed. The
live daemon has not loaded these local commits, and its binding store is held in
process; editing the JSON from another process could be overwritten by the next
daemon save. Canonical Coop's reconciliation tools correctly reject this
owner-direct session, so the durable records remain truthful rather than being
forcibly relabelled.

### Closed bounded outcomes

- Webapp PR #2592 push is at remote head `e841ae9ad0adf3dbaa93b87cf7f37f682e7e7f76`.
  The parked cross-row race commit was not pushed; issue #2721 is open for it.
- Webapp PR #2504 push is at remote head `e15a4432247ee020c72daaf96f30a278315b70c2`.
  This closes the authorized push/review action only. It does not close the
  separate parent-email navigation 404.
- The owner-direct approval and scheduled-continuation implementation is
  committed locally on `bojan`; no push occurred.

### Active or attention-required outcomes

- Webapp #1643 is held. Its unpushed `e68d2d0f0` contains only the 409 guard and
  tests; the prefix unlock is already published in `061abfa42`. Reverting the
  unlock makes two retained tests fail. Owner choice remains: revert and remove
  those tests, push only `e68d2d0f0`, or keep holding.
- Webapp #2504's parent-email 404 remains an implementation defect. It is not an
  owner-choice blocker and must not be reported as fixed by the a11y push.
- Voice STT rev2 is locally committed as `9f1eeab6e9` with 5/5 fixed versus 1/5
  under production-code reversion and 89/89 related tests. A real iPhone retry
  is still required before claiming device-level completion.
- Runtime reaper and Class-B trigger remain active, rate-limited workers. Their
  shared-checkout files are uncommitted and were not touched here. Both have an
  automatic provider continuation scheduled for 2026-08-22 02:21 CEST.
- Existing live portfolio bindings for #2504, #1643, Webapp push, Voice rev2,
  reaper, and Class-B still show `active`; this is a live-activation/reconciliation
  boundary, not evidence that all six are still doing useful work.

## Activation boundary

The new handoff schema and continuation transport take effect only after a safe
daemon restart from a clean integrated `bojan`. Restarting while reaper/Class-B
own uncommitted runtime files would load a mixed state and race their work, so it
was intentionally not done in this task.
