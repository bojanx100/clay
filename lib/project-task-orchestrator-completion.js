var taskGraph = require("./orchestration-task-graph");
var taskState = require("./orchestration-task-state");
var deliverProjectCompletion =
  require("./project-task-orchestrator-project-completion-transport").deliverProjectCompletion;

var MAX_NO_PROGRESS_TURNS = 3;

function attachCompletionGate(ctx) {
  var sm = ctx.sm;
  var flushCoordinatorUpdates = ctx.flushCoordinatorUpdates;
  var queueCoordinatorUpdate = ctx.queueCoordinatorUpdate;
  var sendState = ctx.sendState;
  var crossProject = ctx.crossProject || null;
  var onProjectCompletion = ctx.onProjectCompletion || function () {};

  function isCoordinator(session) {
    return !!(session && session.coordinationMode && !session.orchestrationParent &&
      Array.isArray(session.orchestrationTasks) &&
      (session.orchestrationTasks.length > 0 || isPortfolioProjectCoordinator(session)));
  }

  function isPortfolioProjectCoordinator(session) {
    var policy = session && session.orchestrationPolicy;
    var execution = policy && policy.portfolioExecution;
    return !!(execution && execution.mode === "project_coordinator");
  }

  function isArchivablyTerminalTask(task) {
    return !!(task && (task.status === "completed" || task.status === "dismissed" ||
      task.status === "cancelled"));
  }

  function archiveTaskEvidence(session) {
    var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
    var changed = false;
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      if (!isArchivablyTerminalTask(task) || task.archivedAt) continue;
      task.archivedAt = Date.now();
      taskGraph.appendEvent(session, "task_worker_archived", task, {
        reason: "Project completion archived terminal descendants",
      });
      changed = true;
    }
    return changed;
  }

  function hasVisibleDescendant(session) {
    if (!sm.sessions || typeof sm.sessions.forEach !== "function") return false;
    var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
    var visible = false;
    sm.sessions.forEach(function (candidate) {
      if (visible || !candidate || candidate.hidden) return;
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i];
        if (task && (task.workerSessionId === candidate.localId ||
             task.workerStorageId === candidate.storageId ||
             task.workerStorageId === candidate.cliSessionId)) {
          visible = true;
          return;
        }
      }
    });
    return visible;
  }

  function finalizeProjectCompletion(session, state) {
    if (!isPortfolioProjectCoordinator(session) || !state || state.status !== "completed") {
      return false;
    }
    if (!/^no\b/i.test(String(state.escalationRequired || "").trim())) return false;
    var execution = session.orchestrationPolicy.portfolioExecution;
    var completedAt = state.completedAt || Date.now();
    var changed = false;
    if (execution.status !== "completed") {
      execution.status = "completed";
      execution.updatedAt = Date.now();
      changed = true;
    }
    if (!execution.completedAt) {
      execution.completedAt = completedAt;
      changed = true;
    }
    if (!session.coopControlledBy) return changed;
    var evidenceChanged = archiveTaskEvidence(session);
    var needsHide = !session.hidden || hasVisibleDescendant(session);
    if (evidenceChanged || needsHide) {
      sm.saveSessionFile(session);
      if (typeof sm.hideSessionForActiveClients === "function") {
        sm.hideSessionForActiveClients(session.localId);
      } else if (typeof sm.hideSession === "function") sm.hideSession(session.localId);
      else {
        session.hidden = true;
        sm.saveSessionFile(session);
      }
      changed = true;
    }
    return changed;
  }

  function recordProjectCompletion(session, redeliver) {
    if (!isPortfolioProjectCoordinator(session)) return false;
    var execution = session.orchestrationPolicy.portfolioExecution;
    var existing = taskGraph.projectCompletionState(session);
    if (existing.status === "completed") {
      var finalized = finalizeProjectCompletion(session, existing);
      var delivered = redeliver && deliverProjectCompletion(sm, crossProject, session, existing);
      return finalized || !!delivered;
    }
    var report = taskState.projectCompletionFromResult(taskState.workerResultText(session));
    if (!report.requested) return false;
    report.portfolioTaskId = execution.portfolioTaskId;
    report.bindingRevision = execution.bindingRevision;
    var completed = taskGraph.completeProject(session, report);
    if (!completed.ok || !completed.created) return false;
    finalizeProjectCompletion(session, completed.state);
    deliverProjectCompletion(sm, crossProject, session, completed.state);
    onProjectCompletion(session, completed.state);
    return true;
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

  function handleTurnDone(session) {
    if (!isCoordinator(session)) return false;
    if (flushCoordinatorUpdates(session)) return true;
    var completionWasMissing = !session.orchestrationProjectCompletion;
    var revoked = taskGraph.reconcileProjectCompletion(session);
    var graphState = taskGraph.graphResolutionState(session);
    var completed = graphState.phase === "complete" && recordProjectCompletion(session, true);
    var completionHydrated = completionWasMissing && !!session.orchestrationProjectCompletion;
    if (revoked || completed || completionHydrated) persistState(session);
    if (graphState.phase === "complete" || graphState.phase === "executing" ||
        graphState.phase === "waiting_user") {
      resetReconciliation(session, graphState.digest);
      return false;
    }
    if (graphState.phase === "stalled") {
      sendState(session);
      return false;
    }

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

  function restore(session) {
    if (!isCoordinator(session)) return false;
    if (flushCoordinatorUpdates(session)) return true;
    var completionWasMissing = !session.orchestrationProjectCompletion;
    var revoked = taskGraph.reconcileProjectCompletion(session);
    var graphState = taskGraph.graphResolutionState(session);
    var completed = graphState.phase === "complete" && recordProjectCompletion(session);
    var completionHydrated = completionWasMissing && !!session.orchestrationProjectCompletion;
    if (revoked || completed || completionHydrated) persistState(session);
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

  function resumeWaitingFromUser(session) {
    if (!isCoordinator(session)) return "";
    var tasks = session.orchestrationTasks || [];
    var resumed = [];
    for (var i = 0; i < tasks.length; i++) {
      if (!tasks[i] || tasks[i].status !== "waiting_user") continue;
      resumed.push({ taskId: tasks[i].taskId, question: tasks[i].userQuestion || "" });
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
      "Resume reconciliation using the user's answer. Resolve, retry, or dismiss each task before " +
        "reporting the overall job complete."
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
};
