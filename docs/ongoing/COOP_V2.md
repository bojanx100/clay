# Coop v2 implementation

Owner: Bojan. Owning task: Codex thread `01a07320-baad-7281-8b80-ca6b0cefb97e`.
Created 2026-09-05 from `origin/bojan` at `8d60c648803701bf78e604df2bcd4469d042f785`.
Working and push destination: `coop_v2`, explicitly requested by the owner. Retain
this branch/worktree for iteration. Landing on `bojan` is a later owner decision.

## Product contract

The owner sets direction, provides business judgment, and can work directly in
ordinary project sessions. Coop owns discussion, portfolio priorities, delegation,
and useful high-level answers. Persistent project coordinators know their project's
rules, organize assignments, oversee eligible automation, and report outcomes and
blockers to Coop. Existing project execution and launch rules remain the foundation.

Threads retain conversation identity when tasks are commissioned. Tasks describe
outcomes, attempts describe executions, and sessions run agents. Answering a request,
finishing implementation, and owner acceptance are separate facts.

Pending owner preferences: behavior of already-running work when Lead turns OFF;
coordinator freedom to change plans and create extra workers within project rules.
Independent defect repairs can proceed while those preferences are discussed.

## Implementation ledger

- [ ] Preserve legitimate repeat automation with distinct binding attempts.
- [ ] Preserve authenticated owner completion of unadopted project automation.
- [ ] Separate internal completion from local owner-accepted workflow completion.
- [ ] Accept natural owner instructions and preserve their constraints at ingress.
- [ ] Make multi-batch owner response linking durable and idempotent.
- [ ] Drive durable delivery retries and recover or explicitly account for sequence gaps.
- [ ] Make normal completion and late attention transitions idempotent.
- [ ] Preserve execution links and concurrent changes during Thread undo.
- [ ] Enforce read-only authority at admission and execution boundaries.
- [ ] Define and implement ON adoption / OFF ownership handover.
- [ ] Give persistent project coordinators explicit role, project context, intake,
      scoped delegation, and upward reporting.
- [ ] Let Coop own high-level discussion while delegating substantial execution.
- [ ] Consolidate owner-request/task/attempt outcome provenance.
- [ ] Remove recovery mutations from projections, drive them through daemon events,
      and release removed managers from the recovery registry.
- [ ] Verify recovery isolation boundaries and scoped historical reconciliation.
- [ ] Establish supervised maintenance activation/rollback without a worker stopping
      its own supporting daemon.
- [ ] Resolve the known test baseline failures and run the full suite.
- [ ] Prove the complete owner-to-work-to-owner lifecycle, including retries,
      a second valid automation pass, restart, Thread undo, and Lead toggles.

## Verification

Every bug fix must include a regression test, a passing run, a run with that fix
removed that fails, and a restored passing run. Record exact counts below per
logical change. Tests use isolated CLAY_HOME and stub provider boundaries; live
state repairs and production activation are separate actions.

Reviewed baseline: default 4,074 tests, 4,061 pass, 13 fail; controlled 586 tests,
582 pass, 4 fail. Six default environment failures and one repeated controlled
failure passed in targeted reruns. Seven default failures and three repeated
controlled failures remained, including likely stale UI/policy fixtures. This is
not a clean baseline and not evidence that each failure is a production defect.

## Completed iterations

None yet. The branch is initialized; implementation is in progress.
