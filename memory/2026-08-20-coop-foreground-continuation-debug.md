# Coop foreground continuation diagnosis

## Scope

Investigated why a completed owner-facing Coop foreground turn did not resume
admitted Lead work or reconcile visible worker progress until the owner sent a
new message.

## Initial evidence

- Read `docs/guides/DIAGNOSTICS.md` before source inspection. The latest
  recovery canary did not show a Coop-control recovery failure for this
  incident. The diagnostics canary contained earlier event-loop lag spikes,
  but no corresponding foreground-drain failure.
- The canonical owner ingress `coop:871a194b-8879-40f7-a1fe-656e48e722af:533`
  was recorded as conversational with `expectsExecution: false`. That is
  correct historical admission evidence and was not changed or backfilled.
- The canonical transcript records the foreground result at event 42686 and
  `done` at 42687. The next owner ingress is event 42688, about 34 seconds
  later. No `scheduled_message_queued` Lead tick appears in that interval.

## Root cause

The successful per-turn `result` path already calls the project turn-complete
hook. That hook drains the completed foreground ingress and invokes the Lead
wake handler. The wake handler then rejected the Coop home whenever
`queryInstance` existed.

For Codex, `queryInstance` is intentionally a resident, reusable query between
turns. `project-user-message-queue` dispatches its next turn through
`pushMessage` when `isProcessing` is false. Thus the wake handler classified
the exact reusable transport as busy even though the foreground turn had
finished. The queued Lead tick never existed, so no autonomous reconciliation
could occur.

## Repair

`homeIsIdle` now uses the same busy signal as dispatch: destruction, active
processing, and an existing scheduled continuation remain blockers; a resident
query alone does not. Owner ingress and Lead-mode gates are unchanged. The
foreground-drain callback schedules a normal typed `↻ Lead tick`, which keeps
the existing exact ProjectRef and admission paths intact.

## Regression proof

`test/coop-foreground-turn-interrupt.test.js` now drives the actual
`markIdle`/`onIngressDrained`/Lead-wake seam with an idle resident Codex query.
It verifies one typed Lead tick is scheduled after the owner answer while the
resident query is retained for reuse.

With the production change temporarily reversed, the focused file reported 2
passing tests and 1 failing test. The new regression failed because the
schedule count stayed `0` instead of `1`. After restoring the repair, the same
file passed 3 of 3 tests.

## Validation boundary

The focused control, scheduling, and restart suites verify continuation,
restart checkpoint fail-closed behavior, typed auto-action provenance, and
exact Coop ingress restoration. They do not perform a live worker execution or
mutate the owner-request ledger; live activation and canary observation remain
the deployment verification step.

`NODE_PATH=/Users/bojansubotic/Desktop/clay/node_modules npm test` completed
with exit code 0 across the repository's 297-file default suite.
