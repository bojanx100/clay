var taskGraph = require("./orchestration-task-graph");
var taskState = require("./orchestration-task-state");
var envelope = require("./project-completion-envelope");
var projectCompletionTransport = require("./project-task-orchestrator-project-completion-transport");
var deliverProjectCompletion = projectCompletionTransport.deliverProjectCompletion;
var deliverProjectAttention = projectCompletionTransport.deliverProjectAttention;
var deliverProjectFailure = projectCompletionTransport.deliverProjectFailure;
var archiveCompletedCoopSession = projectCompletionTransport.archiveCompletedCoopSession;
var isCoordinatorVerifiedReadOnlyReview = projectCompletionTransport.isCoordinatorVerifiedReadOnlyReview;
var defaultFinishControlledExecution =
  require("./coop-control-execution-completion").finishControlledExecution;
var coordinatorHierarchy = require("./project-coordinator-hierarchy");
var controlRole = require("./coop-control-role");
var settledReview = require("./coop-control-settled-review-reconciliation");
var ownerAcceptanceModule = require("./project-owner-acceptance");
var MAX_NO_PROGRESS_TURNS = 3;
function isPortfolioProjectCoordinator(session) {
  return !!(session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution &&
    session.orchestrationPolicy.portfolioExecution.mode === "project_coordinator");
}
function attachCompletionGate(ctx) {
  var sm = ctx.sm;
  var flushCoordinatorUpdates = ctx.flushCoordinatorUpdates;
  var queueCoordinatorUpdate = ctx.queueCoordinatorUpdate;
  var sendState = ctx.sendState;
  var crossProject = ctx.crossProject || null;
  var onProjectCompletion = ctx.onProjectCompletion || function () {};
  var finishControlledExecution = ctx.finishControlledExecution || defaultFinishControlledExecution;
  var ownerAcceptance = ownerAcceptanceModule.attachProjectOwnerAcceptance({
    usersModule: ctx.usersModule,
  });
  function acceptanceRequired(execution) {
    return !!(execution && execution.ownerAcceptanceRequired === true);
  }
  function acceptancePending(execution) {
    return acceptanceRequired(execution) &&
      !ownerAcceptanceModule.isAccepted(execution.ownerAcceptance);
  }
  function clearLocalReviewAcceptance(execution) {
    var acceptance = execution && execution.ownerAcceptance;
    if (!execution || execution.ownerAcceptanceRequired !== true || !acceptance ||
        acceptance.status !== "pending" || acceptance.source !== "project_local_instructions") return;
    delete execution.ownerAcceptanceRequired;
    delete execution.ownerAcceptance;
    execution.updatedAt = Date.now();
  }
  function isCoordinator(session) {
    if (session && session.coordinationRole === "project_coordinator") return false;
    return !!(session && session.coordinationMode &&
      (!session.orchestrationParent || session.coordinationRole === "task_coordinator") &&
      Array.isArray(session.orchestrationTasks) && (session.orchestrationTasks.length > 0 ||
        isPortfolioProjectCoordinator(session)));
  }
  function finalizeProjectCompletion(session, state, reviewDelivery) {
    if (!isPortfolioProjectCoordinator(session) || !state || state.status !== "completed") return false;
    if (!/^no\b/i.test(String(state.escalationRequired || "").trim())) return false;
    var execution = session.orchestrationPolicy.portfolioExecution;
    if (acceptancePending(execution) && !reviewDelivery) return false;
    var completedAt = state.completedAt || Date.now();
    var changed = false;
    if (execution.status !== "completed") {
      if (!settledReview.receiptMatchesSession(session, execution)) {
        finishControlledExecution(session, "completed");
      }
      execution.status = "completed";
      execution.updatedAt = Date.now();
      changed = true;
    }
    if (!execution.completedAt) {
      execution.completedAt = completedAt;
      changed = true;
    }
    if (archiveCompletedCoopSession(sm, session)) changed = true;
    coordinatorHierarchy.rollUpTaskCoordinator(sm, session, "completed", state.summary);
    return changed;
  }
  function recordImplementationAwaitingAcceptance(session, state, redeliver, options) {
    var execution = session.orchestrationPolicy.portfolioExecution;
    if (!acceptancePending(execution)) return false;
    var implementationCompletedAt = state.completedAt || Date.now();
    var implementationRevision = state.completionRevision || 0;
    var implementationDigest = state.graphDigest || "";
    var enteringOwnerWait = execution.status !== "needs_input";
    var changed = execution.status !== "needs_input" ||
      execution.reason !== "awaiting_owner_acceptance" ||
      execution.implementationCompletedAt !== implementationCompletedAt ||
      execution.implementationCompletionRevision !== implementationRevision ||
      execution.implementationGraphDigest !== implementationDigest;
    if (changed) {
      // Runtime fences are restored after the task orchestrator. Defer this
      // terminal transition during startup just like other controlled results.
      if (enteringOwnerWait && options && options.restoring && execution.control &&
          !session._coopExecutionFence) return false;
      // The provider turn is finished. Leaving its durable lease running makes
      // startup recovery quarantine this settled wait as restart_recovery,
      // while the portfolio binding remains needs_input. A later exact owner
      // decision can renew the same coordinator through its normal recovery
      // path; the old turn must be terminal before we publish the wait.
      if (enteringOwnerWait) finishControlledExecution(session, "needs_input");
      execution.status = "needs_input";
      execution.reason = "awaiting_owner_acceptance";
      execution.updatedAt = Date.now();
      execution.implementationCompletedAt = implementationCompletedAt;
      execution.implementationCompletionRevision = implementationRevision;
      execution.implementationGraphDigest = implementationDigest;
      coordinatorHierarchy.rollUpTaskCoordinator(sm, session, "needs_input",
        "Implementation verified; awaiting explicit owner acceptance");
    }
    var shouldDeliver = redeliver || !execution.attentionDeliveredAt;
    var delivered = shouldDeliver && deliverProjectAttention(sm, crossProject, session,
      state.summary || "Implementation verified; awaiting explicit owner acceptance.");
    if (delivered && delivered.ok === true && !execution.attentionDeliveredAt) {
      execution.attentionDeliveredAt = Date.now();
      changed = true;
    }
    return changed;
  }
  function clearCompletionRefusal(execution) {
    if (!execution.completionRefusalSignature) return false;
    delete execution.completionRefusalSignature;
    delete execution.completionRefusalReason;
    delete execution.completionRefusalMissing;
    delete execution.completionRefusedAt;
    execution.updatedAt = Date.now();
    return true;
  }
  // Persist each distinct refused envelope and give the coordinator its exact missing fields.
  function refuseProjectCompletion(execution, reason, report) {
    var missing = envelope.missingEnvelopeFields(report);
    var signature = reason + "|" + missing.join(",");
    if (execution.completionRefusalSignature === signature) return "";
    execution.completionRefusalSignature = signature;
    execution.completionRefusalReason = reason;
    execution.completionRefusalMissing = missing;
    execution.completionRefusedAt = Date.now();
    execution.updatedAt = execution.completionRefusedAt;
    return envelope.refusalPrompt(reason, missing);
  }
  function finalizeAndDeliverCompletion(session, state, reviewDelivery, redeliver) {
    var finalized = finalizeProjectCompletion(session, state, reviewDelivery);
    var delivered = (redeliver || reviewDelivery) &&
      deliverProjectCompletion(sm, crossProject, session, state);
    if (reviewDelivery && delivered && delivered.ok === true) {
      clearLocalReviewAcceptance(session.orchestrationPolicy.portfolioExecution);
    }
    return finalized || delivered;
  }
  // Returns "completed", "needs_input", "refused", "changed" or "".
  function recordProjectCompletion(session, redeliver, options) {
    if (!isPortfolioProjectCoordinator(session)) return "";
    var execution = session.orchestrationPolicy.portfolioExecution;
    var existing = taskGraph.projectCompletionState(session);
    if (existing.status === "completed") {
      var reviewDelivery = isCoordinatorVerifiedReadOnlyReview(session, existing);
      if (acceptancePending(execution) && !reviewDelivery) {
        return recordImplementationAwaitingAcceptance(session, existing, redeliver, options) ?
          "needs_input" : "";
      }
      return finalizeAndDeliverCompletion(session, existing, reviewDelivery, redeliver) ? "completed" : "";
    }
    var result = taskState.workerResultText(session);
    // Normalize formatted chat fields, but require a whole-line completion marker.
    if (!envelope.envelopeRequested(result)) return clearCompletionRefusal(execution) ? "changed" : "";
    var report = taskState.projectCompletionFromResult(envelope.normalizeEnvelopeText(result));
    report.portfolioTaskId = execution.portfolioTaskId;
    report.bindingRevision = execution.bindingRevision;
    var completed = taskGraph.completeProject(session, report);
    if (!completed.ok) {
      return refuseProjectCompletion(execution, completed.reason, report) ? "refused" : "";
    }
    if (!completed.created) return "";
    clearCompletionRefusal(execution);
    var reviewDelivery = isCoordinatorVerifiedReadOnlyReview(session, completed.state);
    if (acceptancePending(execution) && !reviewDelivery) {
      recordImplementationAwaitingAcceptance(session, completed.state, true, options);
      return "needs_input";
    }
    finalizeAndDeliverCompletion(session, completed.state, reviewDelivery, true);
    onProjectCompletion(session, completed.state);
    return "completed";
  }
  function refusalPromptFor(execution) {
    return envelope.refusalPrompt(execution.completionRefusalReason,
      execution.completionRefusalMissing || []);
  }
  function unavailableVisualCanary(reason, result) {
    return reason === "visual_canary_browser_unavailable" || reason === "visual_canary_unavailable" || reason === "browser_inventory_unavailable" || /(?:browser\s+inventory|visual\s+canary)[^\n]{0,120}\bunavailable\b/i.test(result);
  }
  function recordProjectNeedsInput(session, options) {
    if (!isPortfolioProjectCoordinator(session)) return false;
    var execution = session.orchestrationPolicy.portfolioExecution;
    if (execution.status !== "running" && execution.status !== "needs_input") return false;
    var result = taskState.workerResultText(session);
    var blocked = /(?:^|\n)WORKER_STATUS:\s*blocked\b/i.test(result) &&
      /(?:^|\n)ESCALATION_REQUIRED:\s*yes\b/i.test(result);
    var status = blocked ? "failed" : (/(?:^|\n)WORKER_STATUS:\s*needs_input\b/i.test(result) ||
      execution.status === "needs_input" ? "needs_input" : "");
    if (!status) return false;
    var reason = taskState.workerReasonFromResult(result) || String(execution.reason || "");
    var reviewAttention = execution.reviewOnly === true ||
      controlRole.isPeer(controlRole.forSession(session, null, execution));
    var canaryAttention = unavailableVisualCanary(reason, result);
    var ownerAttention = status === "needs_input";
    var terminalAttention = blocked || reviewAttention || canaryAttention;
    var changed = execution.status !== status ||
      String(execution.reason || "") !== reason;
    if (changed) {
      // Terminal attention or failure releases its lease before publishing.
      if (terminalAttention && execution.status !== status) {
        // Runtime fences are intentionally not persisted. During startup the
        // project session can load before control recovery reattaches its
        // capability. Defer the whole terminal transition so a historical
        // blocked result cannot crash boot or persist state without the fence.
        if (options && options.restoring && execution.control &&
            !session._coopExecutionFence) return false;
        finishControlledExecution(session, status);
      }
      execution.status = status;
      execution.updatedAt = Date.now();
      if (reason) execution.reason = reason;
      else delete execution.reason;
      coordinatorHierarchy.rollUpTaskCoordinator(sm, session, status, reason);
    }
    if (blocked && !execution.attentionDeliveredAt) {
      var blockedReport = taskState.projectCompletionFromResult(result);
      var failure = deliverProjectFailure(sm, crossProject, session, blockedReport.summary || result);
      if (failure && failure.ok === true) {
        execution.attentionDeliveredAt = Date.now();
        changed = true;
      }
    } else if ((terminalAttention || ownerAttention) && !execution.attentionDeliveredAt) {
      var report = taskState.projectCompletionFromResult(result);
      var delivered = deliverProjectAttention(sm, crossProject, session, report.summary || result,
        { visualCanaryUnavailable: canaryAttention });
      if (delivered && delivered.ok === true) {
        execution.attentionDeliveredAt = Date.now();
        changed = true;
      }
    }
    return changed;
  }
  function reconciliationState(session) {
    if (!session.orchestrationReconciliation) {
      session.orchestrationReconciliation = {
        lastDigest: "",
        stalledDigest: "",
        noProgressTurns: 0,
        stalled: false,
        updatedAt: Date.now(),
      };
    }
    return session.orchestrationReconciliation;
  }
  function persistState(session) {
    sm.saveSessionFile(session);
    sendState(session);
    sm.broadcastSessionList();
  }
  function resetReconciliation(session, digest) {
    var state = reconciliationState(session);
    var changed = state.lastDigest !== digest || state.noProgressTurns !== 0 ||
      state.stalled || !!state.stalledDigest;
    state.lastDigest = digest;
    state.stalledDigest = "";
    state.noProgressTurns = 0;
    state.stalled = false;
    state.updatedAt = Date.now();
    if (changed) persistState(session);
    return changed;
  }
  function unresolvedLines(session) {
    var tasks = session.orchestrationTasks || [];
    var lines = [];
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i] || {};
      var status = task.status || "queued";
      if (status === "completed" || status === "dismissed" || status === "cancelled" ||
          status === "waiting_user" || status === "queued" || status === "ready" ||
          status === "running") continue;
      lines.push("- " + task.taskId + " · " + (task.title || "Untitled task") + " · " + status);
    }
    return lines;
  }
  function reconciliationPrompt(session, noProgressTurns, reason) {
    var lines = [
      "[Clay coordinator completion gate]",
      reason || "The task graph still contains work that needs coordinator attention.",
      "",
      "Unresolved tasks:",
    ].concat(unresolvedLines(session));
    lines.push(
      "",
      "You own closure of this graph. Reconcile every task before reporting the overall job complete:",
      "- finish and verify work, then call clay-orchestration/resolve_task;",
      "- retry or send focused follow-up when more execution can resolve it;",
      "- call clay-orchestration/dismiss_task with a durable reason when work is obsolete or duplicated;",
      "- call clay-orchestration/request_task_input with one precise question only when human judgment is genuinely unavoidable.",
      "Do not ask the user to inspect worker colors or manually reconcile worker sessions.",
      "A provider turn ending does not complete the coordination graph."
    );
    if (noProgressTurns >= 2) {
      lines.push(
        "",
        "This is the final automatic reconciliation pass before Clay marks the graph stalled. " +
          "Make a concrete task-state change now."
      );
    }
    return lines.join("\n");
  }
  function recordTurnCompletion(session, graphState, completionWasMissing, revoked) {
    var outcome = graphState.phase === "complete" ? recordProjectCompletion(session, true) : "";
    var completed = outcome === "completed";
    var needsInput = !completed && recordProjectNeedsInput(session);
    var completionHydrated = completionWasMissing && !!session.orchestrationProjectCompletion;
    if (revoked || outcome || needsInput || completionHydrated) persistState(session);
    return outcome;
  }
  function handleKnownGraphPhase(session, graphState) {
    var settled = graphState.phase === "complete" || graphState.phase === "executing" ||
      graphState.phase === "waiting_user";
    if (settled) {
      resetReconciliation(session, graphState.digest);
      return false;
    }
    if (graphState.phase !== "stalled") return null;
    sendState(session);
    return false;
  }
  function continueReconciliation(session, graphState) {
    var state = reconciliationState(session);
    var progressed = !!state.lastDigest && state.lastDigest !== graphState.digest;
    var noProgressTurns = !state.lastDigest ? 1 :
      (progressed ? 0 : (state.noProgressTurns || 0) + 1);
    state.lastDigest = graphState.digest;
    state.noProgressTurns = noProgressTurns;
    state.updatedAt = Date.now();
    if (noProgressTurns >= MAX_NO_PROGRESS_TURNS) {
      state.stalled = true;
      state.stalledDigest = graphState.digest;
      persistState(session);
      return false;
    }
    state.stalled = false;
    state.stalledDigest = "";
    persistState(session);
    queueCoordinatorUpdate(session, reconciliationPrompt(session, noProgressTurns));
    return true;
  }
  function handleTurnDone(session) {
    if (!isCoordinator(session)) return false;
    if (flushCoordinatorUpdates(session)) return true;
    var completionWasMissing = !session.orchestrationProjectCompletion;
    var revoked = taskGraph.reconcileProjectCompletion(session);
    var graphState = taskGraph.graphResolutionState(session);
    var outcome = recordTurnCompletion(session, graphState, completionWasMissing, revoked);
    if (outcome === "refused") {
      queueCoordinatorUpdate(session,
        refusalPromptFor(session.orchestrationPolicy.portfolioExecution));
      return true;
    }
    var known = handleKnownGraphPhase(session, graphState);
    return known === null ? continueReconciliation(session, graphState) : known;
  }
  function restore(session) {
    if (!isCoordinator(session)) return false;
    if (flushCoordinatorUpdates(session)) return true;
    var completionWasMissing = !session.orchestrationProjectCompletion;
    var revoked = taskGraph.reconcileProjectCompletion(session);
    var graphState = taskGraph.graphResolutionState(session);
    var outcome = "";
    try {
      if (graphState.phase === "complete") {
        outcome = recordProjectCompletion(session, false, { restoring: true });
      }
    } catch (cause) {
      // A saved completion can precede control recovery. Exact durable replays
      // still finalize above; otherwise leave the execution for startup recovery.
      // An attached but mismatched fence remains an error, as do live completions.
      if (cause.code !== "COOP_CONTROL_FENCE_MISSING" || session._coopExecutionFence) throw cause;
    }
    var completed = outcome === "completed";
    var needsInput = !completed && recordProjectNeedsInput(session, { restoring: true });
    var completionHydrated = completionWasMissing && !!session.orchestrationProjectCompletion;
    if (revoked || outcome || needsInput || completionHydrated) persistState(session);
    if (outcome === "refused") {
      queueCoordinatorUpdate(session,
        refusalPromptFor(session.orchestrationPolicy.portfolioExecution));
      return true;
    }
    if (graphState.phase !== "reconciling") return false;
    var state = reconciliationState(session);
    if (state.stalled && state.stalledDigest === graphState.digest) return false;
    state.lastDigest = graphState.digest;
    state.noProgressTurns = 0;
    state.stalled = false;
    state.stalledDigest = "";
    state.updatedAt = Date.now();
    persistState(session);
    queueCoordinatorUpdate(session, reconciliationPrompt(
      session,
      0,
      "Clay restored a task graph with unresolved worker results."
    ));
    return true;
  }
  function resumeWaitingFromUser(session, text, actorUserId) {
    if (!isCoordinator(session)) return "";
    var execution = session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
    if (acceptancePending(execution) &&
        ownerAcceptanceModule.matchesCompletionTrigger({}, text)) {
      var approval = ownerAcceptance.approvalFor(session, actorUserId, text);
      if (!approval) {
        return "[Clay coordinator completion gate]\nOnly the project owner may authorize the " +
          "Done workflow. Preserve issue, PR, board, assignment, and cleanup state.";
      }
      execution.ownerAcceptance = approval;
      execution.status = "running";
      execution.updatedAt = approval.at;
      delete execution.reason;
      persistState(session);
      return [
        "[Clay coordinator completion gate]",
        "The owner explicitly authorized the Done workflow for this exact portfolio execution.",
        "Apply the loaded project-local Done instructions now. Do not broaden scope.",
        "Emit PROJECT_COMPLETED: yes only after that workflow and integration verification finish.",
      ].join("\n");
    }
    var tasks = session.orchestrationTasks || [];
    var resumed = [];
    for (var i = 0; i < tasks.length; i++) {
      if (!tasks[i] || tasks[i].status !== "waiting_user") continue;
      // Typed plan decisions are answered only by the exact owner popup
      // action. Ordinary chat must neither transition nor advertise them as
      // having been answered.
      if (tasks[i].ownerDecision) continue;
      resumed.push({ taskId: tasks[i].taskId, question: tasks[i].userQuestion || "" });
      // Approval placeholders must remain pending until exact execution
      // admission replays the staged set and proves this question was asked.
      // Eagerly moving them to reviewing here would destroy that second factor
      // before the coordinator can submit the approved binding.
      if (tasks[i].approvalSet) continue;
      taskGraph.transition(session, tasks[i], "reviewing", {
        currentActivity: "User decision received; coordinator is reconciling",
        userAnsweredAt: Date.now(),
      });
    }
    if (resumed.length === 0) return "";
    var state = reconciliationState(session);
    state.lastDigest = "";
    state.stalledDigest = "";
    state.noProgressTurns = 0;
    state.stalled = false;
    state.updatedAt = Date.now();
    persistState(session);
    var lines = [
      "[Clay coordinator completion gate]",
      "The user's message answers the recorded decision for:",
    ];
    for (var ri = 0; ri < resumed.length; ri++) {
      lines.push("- " + resumed[ri].taskId + ": " + resumed[ri].question);
    }
    lines.push(
      "Resume reconciliation using the user's answer. For staged approvals, dispatch only the exact " +
        "recorded portfolio revisions and then dismiss their approval placeholders with a durable reason. " +
        "Resolve, retry, or dismiss every other task before reporting the overall job complete."
    );
    return lines.join("\n");
  }
  function retry(session) {
    if (!isCoordinator(session)) return false;
    var graphState = taskGraph.graphResolutionState(session);
    if (graphState.phase !== "stalled") return false;
    var state = reconciliationState(session);
    state.lastDigest = graphState.digest;
    state.stalledDigest = "";
    state.noProgressTurns = 0;
    state.stalled = false;
    state.updatedAt = Date.now();
    persistState(session);
    queueCoordinatorUpdate(session, reconciliationPrompt(
      session,
      0,
      "The user requested another bounded reconciliation pass."
    ));
    return true;
  }
  return {
    handleTurnDone: handleTurnDone,
    restore: restore,
    resumeWaitingFromUser: resumeWaitingFromUser,
    retry: retry,
  };
}
module.exports = {
  attachCompletionGate: attachCompletionGate,
  archiveCompletedCoopSession: archiveCompletedCoopSession,
};
