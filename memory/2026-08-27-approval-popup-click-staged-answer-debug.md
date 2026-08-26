# Approval popup click and staged-answer admission

Date: 2026-08-27

Task: `clay-fix-approval-popup-click-noop-20260827`, revision 1

## DEBUG REPORT

### Symptom

The Workers popup showed a staged approval as “decision needed,” but clicking its row did nothing. The same live flow then rejected the owner's ordinary answer, “Yes I approve,” with `owner_implementation_decision_required`, even though the exact staged question had been rendered before the answer.

### Root cause

Three independent conditions combined:

1. Approval placeholders intentionally have no `workerSessionId`, while every popup row click only called `openTaskSession(task.workerSessionId)`. The guard inside that function turned the click into a silent no-op.
2. The staged-question admission reconstruction appended `assistant_message` and `delta` records but ignored `delta_replace`. In the observed stream, an early malformed delta was replaced by the final assistant text, so admission never reconstructed what the owner actually saw.
3. Admission required the entire assistant turn to equal the generated question and accepted “yes” or “approve” separately, but not a preamble plus Markdown-formatted question followed by the natural answer “Yes I approve.”

### Fix

- The approval placeholder now renders an explicit **Approve** control. It validates the displayed task/revision/ProjectRef against the staged approval set and sends one exact owner message through the normal WebSocket message path in Main scope.
- A successful send disables only that control and leaves the staged card visible until authoritative server state clears it. A disconnected or throwing send leaves the control enabled and shows a retryable error.
- Rows without a worker session are no longer exposed as keyboard/click navigation controls.
- Staged-question reconstruction now applies `delta_replace`, tolerates surrounding coordinator explanation and inline-code presentation, and still requires the exact generated question with its identifiers and terminator.
- The anchored assent allowlist now accepts `I approve`, `I confirm`, and `Yes I approve` while continuing to reject refusals, named extra objects, questions, and unrelated trailing instructions.

### Evidence

Before the fix, the focused regression command reported 48 passing and 2 failing tests: no popup approval control was present, and the live-shaped replaced prompt plus “Yes I approve” was refused.

The repaired focused approval set reported 92 passing and 0 failing tests.

The repository gate then reported 3,347/3,347 passing in the default pass and 516/516 passing in the controlled-execution pass.

Revert sensitivity was checked at each repaired seam:

- Replacing the popup handler with the former `openTaskSession(undefined)` behavior made the click regression fail 0/1 because it sent zero decisions; restoring the fix made it pass 1/1.
- Restoring whole-turn equality and ignoring `delta_replace` made the live prompt regression fail 0/1; restoring the fix made it pass 1/1.
- Removing the personal-confirmation grammar made the same live regression fail 0/1; restoring the fix made it pass 1/1.

The click-level regression renders the real preview module, clicks the real button twice, observes exactly one WebSocket owner message, and passes that message through the real item-approval predicate using the staged task/revision/ProjectRef. A second path proves a disconnected send is visible and retryable.

### Coverage boundary

No live `~/.clay` state was changed and no daemon was restarted. The regression exercises the actual DOM click handler, message payload, and server-side approval predicate in-process; it does not claim a manual click against a restarted browser/daemon deployment.

### Status

DONE
