var crypto = require("crypto");
var closeOrchestrationTask = require("./project-task-orchestrator-close").closeOrchestrationTask;
var taskGraph = require("./orchestration-task-graph");
var createToolHandlers = require("./orchestration-tool-handlers").createToolHandlers;
var attachSessionAdoption = require("./project-session-adoption").attachSessionAdoption;
var createQueuedCoordinator = require("./project-coordinate-queued").createQueuedCoordinator;
var prepareWorkerSession = require("./adaptive-worker-routing").prepareWorkerSession;
var externalOrchestration = require("./project-task-orchestrator-external");
var createExternalTaskCoordinator = externalOrchestration.createExternalTaskCoordinator;
var attachCoordinatorDemotion = require("./project-task-orchestrator-demotion").attachCoordinatorDemotion;
var attachCoordinatorResolver = require("./project-task-orchestrator-coordinator").attachCoordinatorResolver;
var attachCompletionGate = require("./project-task-orchestrator-completion").attachCompletionGate;
var attachTaskFollowup = require("./project-task-orchestrator-followup").attachTaskFollowup;
var requestTaskInput = require("./project-task-orchestrator-input").requestTaskInput;
var orchestratorHelpers = require("./project-task-orchestrator-helpers");
var coopTopicIndex = require("./coop-topic-index");
var governanceLifecycle = require("./coop-governance-lifecycle");
var executionFence = require("./coop-control-fence");
var localDelegationProblem = require("./coop-control-plane").localDelegationProblem;
var usersModule = require("./users");
var attachTaskOrchestratorCoop =
  require("./project-task-orchestrator-coop").attachTaskOrchestratorCoop;
var createProjectCoordinatorSteering = require("./project-task-orchestrator-steering").createProjectCoordinatorSteering;
var createControlPlaneBindingMigrationTool = require("./project-task-orchestrator-binding-migration").createControlPlaneBindingMigrationTool;
var createCrossProjectEnvelopeHandler = require("./project-task-orchestrator-cross-project").createCrossProjectEnvelopeHandler;
var attachCoopSessionQuery = require("./coop-session-query").attachCoopSessionQuery;
var {
  orchestrationStateForClient, orchestrationTasksForClient, workerPrompt, workerResultUpdateText,
  workerResultText, workerTaskStatusFromResult, isVerifiedCompletion, restoreVerifiedWorkerCompletion,
} = require("./orchestration-task-state");

function attachTaskOrchestrator(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  sm.sessions.forEach(function (session) { require("./read-only-execution").retain(session, sm); });
  var slug = ctx.slug || null;
  var crossProject = ctx.crossProject || null;
  var governance = ctx.governanceLifecycle || governanceLifecycle.createLifecycle();
  var resolveGlobalSessionRef = ctx.resolveGlobalSessionRef || null;
  var usersApi = ctx.usersModule || usersModule;
  var sendToSession = ctx.sendToSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var onCoopActionQueueChanged = typeof ctx.onCoopActionQueueChanged === "function"
    ? ctx.onCoopActionQueueChanged : function () {};
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var coordinatorDemotion = attachCoordinatorDemotion({
    sendToSession: sendToSession,
    sm: sm,
  });
  var coordinatorResolver = attachCoordinatorResolver({
    sendToSession: sendToSession,
    sm: sm,
  });
  var coordinatorForInput = coordinatorResolver.coordinatorForInput;
  var ensureCoordinatorForInput = coordinatorResolver.ensureCoordinatorForInput;
  var coordinatorOwningTask = coordinatorResolver.coordinatorOwningTask;
  var sessionByStorageId = coordinatorResolver.sessionByStorageId;
  var sessionForInput = coordinatorResolver.sessionForInput;
  var storageIdForSession = coordinatorResolver.storageIdForSession;
  var workerForTask = coordinatorResolver.workerForTask;
  var completionGate = null;
  var followup = null;
  var coopRelay = null;
  function toolError(text) {
    return { content: [{ type: "text", text: "Error: " + text }], isError: true };
  }
  function toolSuccess(text) {
    return { content: [{ type: "text", text: text }] };
  }
  var dispatchControl = require("./project-task-orchestrator-dispatch").createDispatchControl({
    sm: sm, slug: slug, crossProject: crossProject, getLeadMode: ctx.getLeadMode,
    sessionForInput: sessionForInput, coordinatorOwningTask: coordinatorOwningTask,
    workerForTask: workerForTask, followup: function () { return followup; },
    schedule: scheduleReadyTasks, error: toolError,
  });
  var coopSessionQuery = attachCoopSessionQuery({
    crossProject: crossProject,
    sessionForInput: sessionForInput,
    error: toolError,
    success: toolSuccess,
  });
  function tasksForClient(parentSession) {
    return orchestrationTasksForClient(parentSession);
  }
  function sendState(parentSession) {
    sendToSession(parentSession.localId, {
      type: "orchestration_tasks_state",
      tasks: tasksForClient(parentSession),
      state: orchestrationStateForClient(parentSession),
    });
  }
  function findTask(parentSession, taskId) {
    if (!parentSession) return null;
    return taskGraph.findTask(parentSession, taskId);
  }
  function updateTask(parentSession, taskId, updates) {
    var task = findTask(parentSession, taskId);
    if (!task) return null;
    var control = updates || {};
    var cleanUpdates = coopRelay.sanitizedTaskUpdates(updates);
    var nextStatus = cleanUpdates && cleanUpdates.status;
    var statusChanged = nextStatus && nextStatus !== task.status;
    var previousStatus = task.status;
    if (statusChanged) {
      taskGraph.transition(parentSession, task, nextStatus, cleanUpdates);
    } else {
      Object.assign(task, cleanUpdates, { updatedAt: Date.now() });
      taskGraph.appendEvent(parentSession, "task_updated", task, cleanUpdates);
    }
    sm.saveSessionFile(parentSession);
    sendState(parentSession);
    if (statusChanged) sm.broadcastSessionList();
    if (statusChanged) coopRelay.maybeDeliverTaskTransition(parentSession, task, previousStatus, {
      skipFanIn: !!control._skipCoopFanIn,
    });
    coopRelay.refreshWatchdog();
    return task;
  }
  var coordinatorUpdates = require("./project-coordinator-update-queue").attachCoordinatorUpdateQueue({
    sm: sm, sdk: sdk, sendToSession: sendToSession, sendState: sendState,
    onProcessingChanged: onProcessingChanged, ensureProjectAccessForSession: ensureProjectAccessForSession,
    now: ctx.now,
    canDispatch: function (session) {
      return dispatchControl.canDispatch(session) && (!crossProject ||
        typeof crossProject.canRunCoordinatorUpdate !== "function" || crossProject.canRunCoordinatorUpdate(slug, session));
    },
  });
  var queueCoordinatorUpdate = coordinatorUpdates.queue;
  var flushCoordinatorUpdates = coordinatorUpdates.flush;
  function finishWorkerTurn(parentSession, task, worker) {
    if (worker._orchestrationTaskClosed || !findTask(parentSession, task.taskId)) return;
    var resultText = workerResultText(worker);
    var status = workerTaskStatusFromResult(resultText);
    var pendingContinuation = Array.isArray(worker.pendingCoordinatorMessages) && worker.pendingCoordinatorMessages.length > 0;
    if (pendingContinuation && status === "completed") status = "reviewing";
    var taskUpdates = {
      status: status,
      resultSummary: resultText,
      currentActivity: pendingContinuation ? "Worker turn finished; queued follow-up remains" :
        status === "completed" ? "Completed; awaiting coordinator integration" :
        (status === "reviewing" ? "Worker completed; coordinator action required" : "Needs coordinator attention"),
      verification: orchestratorHelpers.structuredField(resultText, "VERIFICATION"),
      resolutionReason: status === "completed" ? "Verified worker completion" : "",
      resolutionSummary: status === "completed" ? orchestratorHelpers.structuredField(resultText, "SUMMARY") : "",
      resolvedAt: status === "completed" ? Date.now() : null,
      userQuestion: "",
      waitingReason: "",
      userAnsweredAt: null,
    };
    if (status === "failed" && !pendingContinuation && task.attempt < task.maxAttempts && dispatchControl.canDispatch(parentSession)) taskUpdates._skipCoopFanIn = true;
    updateTask(parentSession, task.taskId, taskUpdates);
    if (status === "failed" && !pendingContinuation && task.attempt < task.maxAttempts && dispatchControl.canDispatch(parentSession)) {
      orchestratorHelpers.detachWorker(sm, worker);
      taskGraph.retryTask(parentSession, task);
      scheduleReadyTasks(parentSession);
      return;
    }
    queueCoordinatorUpdate(parentSession, workerResultUpdateText(task, worker, resultText, status));
    scheduleReadyTasks(parentSession);
    coordinatorDemotion.completePending(parentSession);
  }
  function watchWorker(parentSession, task, worker) {
    if (!worker || worker._orchestrationWatcherAttached) return;
    worker._orchestrationWatcherAttached = true;
    var unsubscribe = sm.subscribeSession(worker.localId, function (event) {
      if (!event || event.type !== "done") return;
      if (task.status !== "running" || worker._orchestrationTaskClosed) return;
      if (followup.dispatchPendingTaskMessage(parentSession, task, worker)) return;
      if (unsubscribe) unsubscribe();
      worker._orchestrationUnsubscribe = null;
      worker._orchestrationWatcherAttached = false;
      finishWorkerTurn(parentSession, task, worker);
    });
    worker._orchestrationUnsubscribe = unsubscribe;
  }
  function restoreWorkers() {
    if (!sm.sessions || typeof sm.sessions.forEach !== "function") return;
    sm.sessions.forEach(function (parentSession) {
      var tasks = parentSession && parentSession.orchestrationTasks;
      if (!Array.isArray(tasks)) return;
      tasks = tasks.filter(function (task) {
        return !task.externalTaskCoordinator && !task.externalAdoptedSession;
      });
      for (var i = 0; i < tasks.length; i++) {
        if (slug === "lead" && tasks[i].status !== "running") continue;
        var worker = workerForTask(tasks[i]);
        if (tasks[i].status !== "running" && !worker) continue;
        if (!worker) {
          updateTask(parentSession, tasks[i].taskId, { status: "failed" });
          continue;
        }
        var parentStorageId = storageIdForSession(parentSession);
        worker.orchestrationParent = {
          taskId: tasks[i].taskId,
          sessionId: parentSession.localId,
          sessionStorageId: parentStorageId,
          workerColor: tasks[i].workerColor || null,
        };
        sm.saveSessionFile(worker);
        sm.saveSessionFile(parentSession);
        restoreVerifiedWorkerCompletion(parentSession, tasks[i], worker, updateTask);
        if (tasks[i].status !== "running") {
          if (slug !== "lead" && (parentSession.hidden || tasks[i].archivedAt)) orchestratorHelpers.archiveTaskWorker(sm, parentSession, tasks[i], worker, "Recovered archived task worker");
          continue;
        }
        if (!worker.isProcessing) {
          if (worker.restartResumeEligible) {
            watchWorker(parentSession, tasks[i], worker);
            continue;
          }
          if (worker.interruptedByRestart) {
            var interruptionText = "Worker was interrupted by a restart and is not eligible for automatic resume.";
            updateTask(parentSession, tasks[i].taskId, {
              status: "needs_input",
              resultSummary: interruptionText,
            });
            queueCoordinatorUpdate(
              parentSession,
              workerResultUpdateText(tasks[i], worker, interruptionText, "needs_input")
            );
            continue;
          }
          if (orchestratorHelpers.workerHasCompletedTurn(worker) && !tasks[i].resultSummary) {
            finishWorkerTurn(parentSession, tasks[i], worker);
          } else if (!orchestratorHelpers.workerHasCompletedTurn(worker)) {
            updateTask(parentSession, tasks[i].taskId, { status: "failed" });
          }
          continue;
        }
        watchWorker(parentSession, tasks[i], worker);
      }
      scheduleReadyTasks(parentSession);
      completionGate.restore(parentSession);
    });
    coopRelay.refreshWatchdog();
  }
  function startTaskFromBrief(parentSession, brief) {
    if (!dispatchControl.canDispatch(parentSession)) return null;
    var task = brief.task || taskGraph.createTask(parentSession, brief);
    var problem = localDelegationProblem(parentSession);
    if (problem) {
      task.routingBlocked = true;
      var error = new Error(problem);
      error.code = "COOP_CONTROL_SCOPE_REQUIRED";
      throw error;
    }
    var taskId = task.taskId;
    var sessionOpts = prepareWorkerSession(sm, parentSession, task, crypto.randomUUID());
    var worker = sm.createSessionRaw(sessionOpts);
    worker.title = brief.title;
    worker.titleManuallySet = true;
    worker.orchestrationParent = {
      taskId: taskId,
      sessionId: parentSession.localId,
      sessionStorageId: storageIdForSession(parentSession),
      workerColor: task.workerColor || null,
    };
    coopRelay.applyWorkerControl(parentSession, worker);
    var prompt = workerPrompt(parentSession, brief, taskId)
      .replace("{{WORKER_SESSION_ID}}", String(worker.localId));
    var userMessage = {
      type: "user_message",
      text: prompt,
      orchestrationTaskId: taskId,
      synthetic: true,
      origin: { kind: "coordinator" },
      _ts: Date.now(),
    };
    worker.history.push(userMessage);
    sm.appendToSessionFile(worker, userMessage);
    task.attempt = (task.attempt || 0) + 1;
    task.workerSessionId = worker.localId;
    task.workerStorageId = storageIdForSession(worker);
    task.provider = worker.vendor || null;
    task.model = worker.model || null;
    taskGraph.transition(parentSession, task, "running", {
      currentActivity: "Worker session " + worker.localId + " is running",
    });
    sm.saveSessionFile(parentSession);
    sm.saveSessionFile(worker);
    sendState(parentSession);
    orchestratorHelpers.announceWorkerStarted(parentSession, task, worker, sm, sendToSession);
    sm.broadcastSessionList();
    watchWorker(parentSession, task, worker);
    coopRelay.refreshWatchdog();
    worker.isProcessing = true;
    worker._queryStartTs = Date.now();
    onProcessingChanged();
    try {
      var startResult = sdk.startQuery(worker, prompt, brief.images || null, ensureProjectAccessForSession(worker));
      if (startResult && typeof startResult.catch === "function") {
        startResult.catch(function (e) {
          worker.isProcessing = false;
          updateTask(parentSession, taskId, {
            status: "failed",
            resultSummary: (e && e.message) || "Worker failed to start",
          });
        });
      }
    } catch (e) {
      worker.isProcessing = false;
      updateTask(parentSession, taskId, {
        status: "failed",
        resultSummary: (e && e.message) || "Worker failed to start",
      });
    }
    return task;
  }
  function scheduleReadyTasks(parentSession) {
    if (!dispatchControl.canDispatch(parentSession)) return [];
    var policy = parentSession.orchestrationPolicy || {};
    var ready = taskGraph.readyTasks(parentSession, policy.maxParallel || 3);
    for (var i = 0; i < ready.length; i++) {
      try {
        startTaskFromBrief(parentSession, {
          task: ready[i], title: ready[i].title, objective: ready[i].objective,
          context: ready[i].context, acceptanceCriteria: ready[i].acceptanceCriteria,
          ownedPaths: ready[i].ownedPaths, provider: ready[i].provider, model: ready[i].model,
          images: ready[i].imageRefs && ctx.loadImagesForSdk ? ctx.loadImagesForSdk(ready[i].imageRefs) : null,
        });
      } catch (e) {
        if (!ready[i].routingBlocked) throw e;
        taskGraph.transition(parentSession, ready[i], "needs_input", {
          currentActivity: e.code === "COOP_CONTROL_SCOPE_REQUIRED" ?
            "Needs typed project dispatch" : "Needs a healthy verified worker route",
          resultSummary: (e && e.message) || ready[i].routingRationale || "Worker route unavailable",
        });
      }
    }
    sm.saveSessionFile(parentSession);
    sendState(parentSession);
    return ready;
  }
  function dismissTask(parentSession, task, reason) {
    var externalDismissed = followup && followup.dismissExternalTask(parentSession, task, reason);
    if (externalDismissed === false) return false;
    var previousStatus = task && task.status || "";
    var closed = closeOrchestrationTask(ctx, parentSession, task.taskId, null, {
      reason: reason,
    });
    if (closed) coopRelay.maybeDeliverTaskTransition(parentSession, findTask(parentSession, task.taskId), previousStatus);
    coopRelay.refreshWatchdog();
    return closed;
  }
  coopRelay = attachTaskOrchestratorCoop({
    sm: sm, slug: slug,
    crossProject: crossProject,
    usersModule: usersApi,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    workerForTask: workerForTask,
    now: Date.now,
  });
  followup = attachTaskFollowup({
    sm: sm, sdk: sdk, loadImagesForSdk: ctx.loadImagesForSdk,
    canDispatch: dispatchControl.canDispatch,
    coordinatorForInput: coordinatorForInput, coordinatorOwningTask: coordinatorOwningTask,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    findTask: findTask,
    onProcessingChanged: onProcessingChanged,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    flushCoordinatorUpdates: flushCoordinatorUpdates,
    sessionByStorageId: sessionByStorageId,
    toolError: toolError,
    toolSuccess: toolSuccess,
    updateTask: updateTask,
    watchWorker: watchWorker,
    workerForTask: workerForTask,
    crossProject: crossProject,
    projectId: function () {
      return sm && typeof sm.getProjectId === "function" ? sm.getProjectId() : null;
    },
    governanceLifecycle: governance,
  });
  completionGate = attachCompletionGate({
    sm: sm, flushCoordinatorUpdates: flushCoordinatorUpdates,
    crossProject: crossProject,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    sendState: sendState,
    usersModule: usersApi,
  });
  orchestratorHelpers.reconcileWorkerSessions(sm, slug, sessionByStorageId);
  restoreWorkers();
  var coordinateExternalTask = createExternalTaskCoordinator({
    autonomyPolicyFile: ctx.autonomyPolicyFile,
    coordinatorForInput: coordinatorForInput,
    createProjectExecution: crossProject && (crossProject.createProjectExecution ||
      crossProject.createExecution),
    ensureCoordinatorForInput: ensureCoordinatorForInput,
    // Lets a named owner approval mint the Thread its approved work needs.
    // Injected rather than imported inside the delegation module so tests can
    // route it and so this stays the single place that grants the capability.
    ensureOwnerThread: function (request) {
      var index = coopTopicIndex.getDefaultTopicIndex();
      if (!index || typeof index.ensureOwnerThread !== "function") {
        return { ok: false, code: "owner_thread_store_unavailable" };
      }
      return index.ensureOwnerThread(request);
    },
    projectId: function () {
      return sm && typeof sm.getProjectId === "function" ? sm.getProjectId() : null;
    },
    closeTask: function (parentSession, taskId, reason) {
      var task = findTask(parentSession, taskId);
      return task ? dismissTask(parentSession, task, reason) : false;
    },
    schedule: scheduleReadyTasks,
    sessionForInput: sessionForInput,
    sm: sm,
  });
  var steerProjectCoordinator = createProjectCoordinatorSteering({ crossProject: crossProject, sessionForInput: sessionForInput, sm: sm, toolError: toolError, toolSuccess: toolSuccess });
  var migrateControlPlaneBinding = createControlPlaneBindingMigrationTool({ crossProject: crossProject, sessionForInput: sessionForInput, sm: sm, toolError: toolError, toolSuccess: toolSuccess });
  var toolHandlers = createToolHandlers({
    afterResolve: function (parentSession) { coordinatorDemotion.completePending(parentSession); },
    beforeRetry: function (parentSession, task) {
      orchestratorHelpers.detachWorker(sm, workerForTask(task));
    },
    coordinatorForInput: coordinatorForInput,
    coordinatorOwningTask: coordinatorOwningTask,
    dismissTask: dismissTask,
    getExecutionBinding: crossProject && typeof crossProject.getExecutionBinding === "function" ?
      function (taskId, revision) {
        return crossProject.getExecutionBinding(taskId, revision);
      } : null,
    ensureCoordinatorForInput: ensureCoordinatorForInput,
    error: toolError,
    retryExistingWorker: followup.retryExistingWorker,
    retryExternalTask: followup.retryExternalTask,
    requestTaskInput: function (parentSession, tasks, question, reason) {
      requestTaskInput(updateTask, parentSession, tasks, question, reason);
    },
    onOwnerDecisionStaged: function (parentSession, decision) {
      // This is a visibility signal, not a decision payload. The task state was
      // saved before it is sent, and the client reveals only the exact TopicRef
      // it already selected for the response turn currently streaming.
      sendToSession(parentSession.localId, {
        type: "coop_owner_decision_staged",
        decisionRef: decision.decisionRef,
        coopTopicRef: decision.scope.coopTopicRef,
      });
      onCoopActionQueueChanged();
    },
    schedule: scheduleReadyTasks,
    sessionById: function (id) {
      return sessionByStorageId(String(id || "")) || sm.sessions.get(Number(id));
    },
    success: toolSuccess,
    updateTask: updateTask,
    isVerifiedCompletion: isVerifiedCompletion,
    coordinateExternalTask: coordinateExternalTask,
    isProjectExecutionInput: externalOrchestration.hasProjectExecutionInput, steerProjectCoordinator: steerProjectCoordinator,
    migrateControlPlaneBinding: migrateControlPlaneBinding,
  });
  var sessionAdoption = attachSessionAdoption({
    cwd: ctx.cwd,
    sm: sm,
    coordinatorForInput: coordinatorForInput,
    dispatchTaskMessage: followup.dispatchTaskMessage,
    error: toolError,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    resolveGlobalSessionRef: resolveGlobalSessionRef,
    success: toolSuccess,
    finishWorkerTurn: finishWorkerTurn,
    updateTask: updateTask,
    watchWorker: watchWorker,
  });
  sessionAdoption.restoreAliasedWorkers();
  var coordinateQueuedMessage = createQueuedCoordinator({
    cwd: ctx.cwd,
    schedule: scheduleReadyTasks,
    sendToSession: sendToSession,
    sm: sm,
  });
  var portfolioExecutionTarget = externalOrchestration.attachPortfolioExecutionTarget({
    cwd: ctx.cwd,
    crossProject: crossProject, ensureProjectAccessForSession: ensureProjectAccessForSession,
    onProcessingChanged: onProcessingChanged,
    sdk: sdk,
    sm: sm,
    slug: slug,
    reconcileSettledReview: completionGate.restore,
  });
  var crossProjectEnvelopes = createCrossProjectEnvelopeHandler({
    commandSchema: externalOrchestration.COMMAND_SCHEMA, crossProject: crossProject,
    followup: followup, portfolioExecutionTarget: portfolioExecutionTarget,
  });
  return {
    coordinateExternalTask: coordinateExternalTask, coordinateQueuedMessage: coordinateQueuedMessage,
    deliverCoordinatorUpdate: followup.deliverCoordinatorUpdate,
    deliverCrossProjectEnvelope: crossProjectEnvelopes.deliver,
    handoffExecution: portfolioExecutionTarget.handoffExecution,
    recoverInfrastructureExecution: portfolioExecutionTarget.recoverInfrastructureExecution,
    handleCoordinatorTurnDone: completionGate.handleTurnDone, resumeOwnedWorker: followup.resumeOwnedWorker,
    resumeWaitingCoordinator: completionGate.resumeWaitingFromUser, retryReconciliation: completionGate.retry,
    // This exact-task path must not answer the session's other open questions.
    recordOwnerDecision: function (parentSession, taskId, decision) {
      var spec = decision || {};
      if (!findTask(parentSession, taskId)) return false;
      if (spec.updates && !updateTask(parentSession, taskId, spec.updates)) return false;
      if (spec.directive) queueCoordinatorUpdate(parentSession, spec.directive);
      return true;
    },
    closeTask: function (parentSession, taskId, targetWs, reason) {
      var task = findTask(parentSession, taskId);
      if (followup.dismissExternalTask(parentSession, task, reason) === false) return false;
      var previousStatus = task && task.status || "";
      var closed = closeOrchestrationTask(ctx, parentSession, taskId, targetWs, reason ? { reason: reason } : null);
      if (closed) coopRelay.maybeDeliverTaskTransition(parentSession, findTask(parentSession, taskId), previousStatus);
      if (closed && parentSession.coordinationMode && (!Array.isArray(parentSession.orchestrationTasks) ||
          parentSession.orchestrationTasks.length === 0)) {
        coordinatorDemotion.demote(parentSession);
      }
      coopRelay.refreshWatchdog();
      return closed;
    },
    delegateFromTool: dispatchControl.guardTool(toolHandlers.delegate), dismissFromTool: toolHandlers.dismiss,
    acceptProjectAssignmentFromTool: function (caller, input) {
      if (!crossProject || typeof crossProject.acceptProjectAssignment !== "function") {
        return { ok: false, reason: "project_assignment_intake_unavailable" };
      }
      return crossProject.acceptProjectAssignment(caller, sm, input);
    },
    resolveCoordinatorUpdates: coordinatorUpdates.resolve,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    flushCoordinatorUpdates: flushCoordinatorUpdates, messageFromTool: dispatchControl.guardTool(followup.messageFromTool),
    messageFromOwner: followup.messageFromOwner, resumeAutomaticWork: dispatchControl.resume,
    adoptFromTool: dispatchControl.guardTool(sessionAdoption.adoptFromTool), listAdoptionCoordinators: sessionAdoption.listCoordinators,
    listCoopSessionsFromTool: coopSessionQuery.listFromTool, proposeSessionAdoption: sessionAdoption.propose,
    planFromTool: dispatchControl.guardTool(toolHandlers.plan), reportFromTool: portfolioExecutionTarget.wrapReport(toolHandlers.report),
    requestInputFromTool: toolHandlers.requestInput, resolveFromTool: toolHandlers.resolve,
    retryFromTool: dispatchControl.guardTool(toolHandlers.retry), steerProjectCoordinatorFromTool: dispatchControl.guardTool(toolHandlers.steerProjectCoordinator),
    migrateControlPlaneBindingFromTool: toolHandlers.migrateControlPlaneBinding,
    sendState: sendState, tasksForClient: tasksForClient, stopCoopWatchdog: coopRelay.stopWatchdog,
  };
}
module.exports = { attachTaskOrchestrator: attachTaskOrchestrator };
