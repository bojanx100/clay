# Coop execution recovery

These changes address operational tasks that stalled during context exhaustion,
lost command output in Clay, or remained failed after a resident coordinator
verified the requested outcome. They are source changes on `coop_v2`; committing
them does not activate a running daemon or prove a project's automatic launch.

## Conversation recovery

Codex command completion reads the current `aggregatedOutput` field, retaining
legacy output and streamed fallback support. A provider-native transcript may
contain output even when an older Clay transcript omitted it.

Context exhaustion from Codex or Claude receives one fresh provider conversation
inside the same Clay session. Renewal preserves task references, the execution
fence, pending reports, the latest request and progress made during its interrupted
turn. It waits for the old stream to detach and rechecks authority before starting.

The retry budget is durable. Repeated exhaustion, failed persistence, owner stop,
pending interaction, lost authority, or Lead OFF produces visible attention rather
than another automatic start. A productive completed turn clears the budget.
Restored recovery records preserve their budget and attention; this is not a promise
to automatically restart every interrupted recovery after daemon loss.

## Outcome and discussion

Generic worker completion remains immutable. A separate resident-coordinator
resolution can complete a portfolio task after a failed or attention-requiring
worker attempt. The router reads the actual saved coordinator task and matches its
project, portfolio revision and both session references. It requires verification,
a settled worker and any required owner acceptance. The previous attempt outcome
remains in the resolution record, and the execution kernel is never reopened.

Project registration and the daemon maintenance clock reconcile previously verified
coordinator resolutions, including verification that arrived while the worker was
still stopping.
Replays preserve the original resolution time. Session and Thread projections see
the reconciled portfolio outcome and its verification. Worker failures also retain
their actionable reason instead of becoming `unspecified`.

Owner follow-ups in a closed controlled task coordinator go to its existing
resident coordinator's durable queue. They keep their binding/Thread association,
saved image paths and a link to the coordinator conversation. The old worker never
receives a new execution capability. Answers use the existing coordinator-to-Coop
feedback path; this does not mirror the answer into the closed worker transcript.

The resident's next-turn context includes saved task verification, resolution time,
worker execution reason, last activity and context-recovery attention. These are
recorded facts, not a timer that labels a task productive merely because it is busy.

## Runtime activation

Use `scripts/verify-runtime-activation.js` with an explicit serving socket and
intended checkout. The default is read-only. `--restart` requests a restart only
within the operator's existing authorization and state-snapshot/rollback procedure.
An old daemon without the identity endpoint requires a separately coordinated
bootstrap; the verifier refuses to restart it blindly.

The daemon captures its checkout, commit and source fingerprint before loading
the server. Activation requires the serving process and on-disk source to match
the expected identity. The restart path checks its target both before requesting
the drain and after the drain, before shutdown. Already loaded source needs no
restart. The verifier polls the serving process after a restart; a successful IPC
reply alone is never activation evidence.

## Verification boundaries

Regression tests exercise real temporary SQLite execution control, real binding
and delivery stores, provider event fixtures, coordinator task graphs, the session
URL parser, temporary Git repositories and an isolated Clay daemon. The test daemon
uses temporary HOME/state and disables TUI-hook installation. No live provider runs
or live owner-state repairs are part of these tests.

Each incident regression was run with its production fix removed and then restored.
The Codex protocol regression failed 3 of 4 tests without the fix. Context recovery
failed all 10 original scenarios without its production changes. Coordinator
resolution failed all 10 scenarios without its changes. Closed-worker discussion
failed 5 of 7 tests without its routing changes; ordinary manual chat and the new
standalone URL helper remained valid. Additional negative checks cover durable
recovery-budget persistence, coordinator outcome context and runtime activation.


Final validation on 2026-09-06: `CLAY_TEST_CONCURRENCY=4 npm test` passed
4,520 tests in the default pass and 844 in controlled mode, with zero failures.
The final maintenance regression failed 1 of 10 tests in each mode with its hook
removed and passed all 10 after restoration. The initial full run also exposed
an obsolete blanket-compaction refusal assertion (updated to prove stable identity)
and an owner-feedback timing failure; the latter passed in isolation and in both
subsequent full runs at lower parallelism. Its initial timing cause is not proven.
No live automatic-launch outcome is asserted by these test results.
