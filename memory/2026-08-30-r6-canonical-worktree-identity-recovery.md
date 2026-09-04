# R6 canonical worktree identity recovery

## Symptom

Temporary linked Git worktrees were registered by their filesystem paths as
separate configured projects. That gave their sessions a different ProjectRef,
produced an extra project-rail tile, and omitted live worktree activity from
the canonical Clay projection.

## Root cause

Project discovery treated a selected directory as a new durable project before
checking whether it belonged to an already configured Git worktree family.
The path can sit outside the parent checkout, so descendant-path checks cannot
establish canonical ownership.

## Recovery

`9903e84dd6` identifies a real Git worktree from the configured parent's
`git worktree list` data, registers it as a parent-owned runtime, gives it the
parent ProjectRef, and aggregates sibling runtime sessions for the Coop and
session-ledger projections. The client rail groups only canonical parents as
tiles. `d1b2969f1c` is the recoverable exact revert of the unrelated rejected
owner-ledger commit `52c892cba9862e49776f898d955795e9f748ab39`.

## Correction at 2026-08-30T15:36Z

**Retracted as incomplete:** the original recovery description did not account
for filesystem aliases before `scanWorktrees()` returned results. On macOS,
the configured `/var/...` path and Git's `/private/var/...` path describe the
same checkout but were compared as distinct strings. The scanner consequently
registered the parent checkout as its own worktree. The follow-up fix resolves
both paths through `realpath` before self-filtering and accessibility checks.
It is covered by a disposable-daemon regression that begins with both the
canonical parent row and an old path-distinct worktree config row.

## Evidence

- Focused identity, reference, global projection, cross-project ledger, rail,
  and owner-sidebar suites: 92 passed, 0 failed.
- Reverting `9903e84dd6` without committing made a real Git-worktree identity
  check fail with `findRegisteredWorktree is not a function`; the revert was
  aborted and the candidate restored before the recovery commit was made.
- The live `daemon-dev.json` entry for
  `/private/tmp/clay-fix-r6-compaction-source-stream-fanout` is a linked
  worktree; the fixed resolver maps it to canonical Clay ProjectRef
  `5332aafc-31e7-5cb1-ba96-c8d90e78260e` instead of stale ProjectRef
  `e9afddc4-9943-5b8c-971c-2b267ed3b361`.
- The live daemon was found to have loaded an older dirty shared checkout,
  retaining the stale `e9af...` runtime ProjectRef. Its source differs from
  the pushed tip, so it must not be restarted as evidence for this recovery.

## Verification limits

The in-app browser had no available surface, so no owner-visible rail or Work
Ledger canary could be run. **Retracted as incomplete:** the first `npm test`
run lacked this worktree's dependency resolution and reported missing provider
packages. Re-running with the validated shared dependency cache reached a
pre-existing, concurrently contended `coop-control-sdk-fence` stall after two
minutes without a pass/fail result; only this recovery run's process group was
stopped. The focused recovery-specific and adjacent suites passed.

## Correction at 2026-08-30T15:46Z: fence-test baseline

**Retracted as incomplete:** the generic contention explanation above did not
identify the clean-tip fence failure. The isolated fence harness creates a
Codex adapter with an empty `modelsByVendor.codex` catalog, while the
pre-existing provider-readiness contract rejects initialized providers without
a usable model catalog. That contract was introduced in `96c67d606f` before
R6; neither the fence test nor its direct query-start, query-vendor,
query-launch, query-options, readiness, or fence dependencies changed in the
R6 range `9903e84dd6^..3617c9624d`.

The pre-R6 parent `dd89d92f7d` reproduces the same catalog error and the same
line-169 assertion failure. The pending promise comes from the fifth test:
the early catalog failure prevents `_workerExitPromise` from reaching the code
which clears it. In a disposable baseline checkout only, supplying the
harness with the valid fake model `gpt-5.6-sol` made all 12 fence tests pass in
3.1 seconds; the checkout was restored clean and removed. This is an
out-of-scope, pre-existing isolated-fixture defect, not a regression in the
R6 commits. It remains explicitly outstanding for its owning provider/control
subsystem; no R6 code was changed for it.

## Independent same-environment baseline at 2026-08-30T15:48Z

The clean original worktree
`/private/tmp/clay-fix-r6-compaction-source-stream-fanout` at
`9903e84dd6`, run with the exact shared dependency setting
`NODE_PATH=/Users/bojansubotic/Desktop/clay/node_modules`, independently
reproduced the clean-tip result: `Provider initialized without a usable model
catalog`, the line-169 `assert:provider_start`-before-`create` failure, then
the pending-Promise hang. Terminating only that owned test run reported 3
passed, 1 failed, and 1 cancelled. This exactly matches the clean
`3617c9624d` result and, together with the parent baseline above, establishes
that the full-suite failure is pre-existing/environmental rather than caused
by the R6 recovery commits. It is not an R6 scope-expansion candidate.

The sole remaining acceptance gap is a safe live deployment followed by the
owner-visible rail, canonical-session, and Work Ledger canaries. Browser
inventory remains empty, and the shared daemon is running an older dirty
checkout with foreign changes at `9903e84dd6`; it must not be restarted from
that checkout as part of this recovery.

## Strict pre-R6-parent confirmation at 2026-08-30T15:49Z

The main verification thread ran the exact single-test command from
`/private/tmp/clay-fence-pre-r6-baseline` at
`dd89d92f7d0b` (`9903e84dd6^`) with the same shared `NODE_PATH`. It exited
normally in 64 ms with 0 passed and 1 failed, reporting the same unusable
model-catalog error and the same line-169 assertion failure. This is the
strict pre-R6-parent proof: the failure predates the entire R6 identity range,
is unrelated baseline behavior, and must not be fixed under this recovery.

## Correction at 2026-08-30T21:37Z: mobile picker execution roots

**Retracted as incomplete:** the prior recovery described only linked Git
worktrees. Mobile screenshot evidence showed that the persisted daemon config
also contained a non-Git isolated-canary directory and the independent
`clay-chrome` browser-helper repository as ordinary top-level projects. The
client correctly suppresses only rows explicitly marked `isWorktree`, so those
durable rows reached the mobile Projects picker unchanged.

The recovery now reconciles configured paths before startup registration. A
row is removed only when an existing configured parent proves one exact
relationship: it is a linked Git worktree, a temporary isolated/canary/worker
root beneath the system temporary directory with the parent's path prefix, or
the canonical parent's sibling `-chrome` browser helper. Unrelated projects,
including ones under the temporary directory, remain registered. The real
daemon fixture proves that the canonical family and an unrelated configured
project reach the project list, while stale rows are removed from the refreshed
config so later discovery cannot resurrect them.

With the reconciliation decision temporarily disabled, the focused fixture
reports 2 passed and 2 failed: all three stale rows remain in config, and the
isolated/browser-helper rows appear in the runtime picker. Restoring the
implementation reports 4 passed and 0 failed. The fixture sets `HOME`,
`CLAY_HOME`, and `CLAY_CONFIG` to one disposable root and clears sudo-home
overrides, so it cannot modify the live `.clayrc` or Claude settings files.

The active production daemon is still the older dirty checkout and has not
received this correction. A safe clean deployment and a connected browser are
still required for the outstanding owner-visible canaries.
