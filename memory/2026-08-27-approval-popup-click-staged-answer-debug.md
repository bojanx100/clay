# Approval popup click and staged-answer admission

Date: 2026-08-27

Task: `clay-fix-approval-popup-click-noop-20260827`, revisions 1-2

## DEBUG REPORT

### Symptom

The Workers popup showed a staged approval as “decision needed,” but clicking its row did nothing. The same live flow then rejected the owner's ordinary answer, “Yes I approve,” with `owner_implementation_decision_required`, even though the exact staged question had been rendered before the answer.

### Root cause

Three independent conditions combined:

1. Approval placeholders intentionally have no `workerSessionId`, while every popup row click only called `openTaskSession(task.workerSessionId)`. The guard inside that function turned the click into a silent no-op.
2. The staged-question admission reconstruction appended `assistant_message` and `delta` records but ignored `delta_replace`. In the observed stream, an early malformed delta was replaced by the final assistant text, so admission never reconstructed what the owner actually saw.
3. Admission required the entire assistant turn to equal the generated question and accepted “yes” or “approve” separately, but not a preamble plus Markdown-formatted question followed by the natural answer “Yes I approve.”

Revision 2 found a fourth condition that revision 1 missed:

4. `orchestrationTasksForClient()` is the production boundary for every popup task payload, but its client projection dropped both `clientRef` and `approvalSet`. `stagedApprovalScope()` requires those fields to prove the exact task/revision/ProjectRef scope, so it correctly failed closed and rendered no approval control. The revision 1 DOM regression constructed the browser task with both fields already present and therefore bypassed the broken boundary.

### Fix

- The approval placeholder now renders an explicit **Approve** control. It validates the displayed task/revision/ProjectRef against the staged approval set and sends one exact owner message through the normal WebSocket message path in Main scope.
- A successful send disables only that control and leaves the staged card visible until authoritative server state clears it. A disconnected or throwing send leaves the control enabled and shows a retryable error.
- Rows without a worker session are no longer exposed as keyboard/click navigation controls.
- Staged-question reconstruction now applies `delta_replace`, tolerates surrounding coordinator explanation and inline-code presentation, and still requires the exact generated question with its identifiers and terminator.
- The anchored assent allowlist now accepts `I approve`, `I confirm`, and `Yes I approve` while continuing to reject refusals, named extra objects, questions, and unrelated trailing instructions.
- Revision 2 preserves `clientRef` and the exact staged `approvalSet` in `orchestrationTasksForClient()`, allowing the existing client validator to receive the authority it was designed to check without weakening any validator or admission path.
- The popup regression now creates the staged task through the real staging helper, projects it through `orchestrationTasksForClient()`, crosses a JSON serialization boundary, renders the real DOM module, and clicks the real control.

### Evidence

Before the fix, the focused regression command reported 48 passing and 2 failing tests: no popup approval control was present, and the live-shaped replaced prompt plus “Yes I approve” was refused.

The repaired focused approval set reported 92 passing and 0 failing tests.

The repository gate then reported 3,347/3,347 passing in the default pass and 516/516 passing in the controlled-execution pass.

Revert sensitivity was checked at each repaired seam:

- Replacing the popup handler with the former `openTaskSession(undefined)` behavior made the click regression fail 0/1 because it sent zero decisions; restoring the fix made it pass 1/1.
- Restoring whole-turn equality and ignoring `delta_replace` made the live prompt regression fail 0/1; restoring the fix made it pass 1/1.
- Removing the personal-confirmation grammar made the same live regression fail 0/1; restoring the fix made it pass 1/1.

**Retracted in revision 2:** ~~The click-level regression proved the production popup path because it rendered the real preview module, clicked the real button twice, observed exactly one WebSocket owner message, and passed that message through the real item-approval predicate.~~ It proved only the downstream DOM and admission path because it supplied `clientRef` and `approvalSet` directly instead of obtaining them from the production serializer.

Revision 2 first made the production-shaped serializer and DOM regressions fail with 14 passing and 3 failing tests. Removing the two projected fields after the fix reproduces the same 14/3 result, including the popup returning no Approve control; restoring them reports 17/17 passing.

The broader approval and orchestration set reports 153/153 passing. The dependency-complete repository gate reports 3,297/3,297 passing in the default pass and 516/516 passing in the controlled-execution pass. The regression also proves a mismatched serialized `clientRef` remains fail-closed, a failed socket send is retryable on the same control, double-clicking a successful send emits exactly one message, and the staged control remains until an authoritative completed task projection removes it.

### Coverage boundary

No live `~/.clay` state was changed and no daemon was restarted. The regression exercises staging, server-to-client projection, JSON serialization, the actual DOM click handler, the message payload, and the server-side approval predicate in-process. It does not claim a manual click against a live browser/daemon deployment.

### Status

**Revision 1 status (retracted):** ~~DONE~~ Incomplete because the regression bypassed production serialization.

**Revision 2 status:** DONE
