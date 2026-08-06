var crypto = require("crypto");
var closeOrchestrationTask = require("./project-task-orchestrator-close").closeOrchestrationTask;
var taskGraph = require("./orchestration-task-graph");
var createToolHandlers = require("./orchestration-tool-handlers").createToolHandlers;
var attachSessionAdoption = require("./project-session-adoption").attachSessionAdoption;
var createQueuedCoordinator = require("./project-coordinate-queued").createQueuedCoordinator;
var prepareWorkerSession = require("./adaptive-worker-routing").prepareWorkerSession;
var externalOrchestration = require("./project-task-orchestrator-external");
var createExternalTaskCoordinator = externalOrchestration.createExternalTaskCoordinator;
var attachCoordinatorDemotion =
  require("./project-task-orchestrator-demotion").attachCoordinatorDemotion;
var attachCoordinatorResolver =
  require("./project-task-orchestrator-coordinator").attachCoordinatorResolver;
var attachCompletionGate =
  require("./project-task-orchestrator-completion").attachCompletionGate;
var attachTaskFollowup =
  require("./project-task-orchestrator-followup").attachTaskFollowup;
var orchestratorHelpers = require("./project-task-orchestrator-helpers");
var usersModule = require("./users");
var attachTaskOrchestratorCoop =
  require("./project-task-orchestrator-coop").attachTaskOrchestratorCoop;
var createProjectCoordinatorSteering = require("./project-task-orchestrator-steering").createProjectCoordinatorSteering;
var createCrossProjectEnvelopeHandler = require("./project-task-orchestrator-cross-project").createCrossProjectEnvelopeHandler;
var {
  orchestrationStateForClient,
  orchestrationTasksForClient,
  workerPrompt,
  workerResultUpdateText,
  workerResultText,
  workerTaskStatusFromResult,
  isVerifiedCompletion,
  restoreVerifiedWorkerCompletion,
} = require("./orchestration-task-state");

function attachTaskOrchestrator(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var slug = ctx.slug || null;
  var crossProject = ctx.crossProject || null;
  var usersApi = ctx.usersModule || usersModule;
  var sendToSession = ctx.sendToSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
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
  function queueCoordinatorUpdate(parentSession, text) {
    if (!Array.isArray(parentSession.pendingCoordinatorUpdates)) {
      parentSession.pendingCoordinatorUpdates = [];
    }
    parentSession.pendingCoordinatorUpdates.push({
      text: text,
      queuedAt: Date.now(),
    });
    sm.saveSessionFile(parentSession);
    flushCoordinatorUpdates(parentSession);
  }
  function dispatchCoordinatorUpdate(parentSession, text) {
    var item = {
      type: "user_message",
      text: text,
      synthetic: true,
      origin: { kind: "task-notification" },
      fromName: "Clay workers",
      internalOnly: true,
      _ts: Date.now(),
    };
    parentSession.history.push(item);
    sm.appendToSessionFile(parentSession, item);
    parentSession.isProcessing = true;
    parentSession._queryStartTs = Date.now();
    parentSession.sentToolResults = {};
    onProcessingChanged();
    sendToSession(parentSession.localId, { type: "status", status: "processing" });
    if (!parentSession.queryInstance && (!parentSession.worker || parentSession.messageQueue !== "worker")) {
      sdk.startQuery(parentSession, text, null, ensureProjectAccessForSession(parentSession));
    } else sdk.pushMessage(parentSession, text, null);
    sm.broadcastSessionList();
  }
  function flushCoordinatorUpdates(parentSession) {
    if (!parentSession || parentSession.isProcessing) return false;
    if (parentSession.restartResumeEligible || parentSession.restartAutoContinueQueued) return false;
    if ((Array.isArray(parentSession.pendingUserMessageQueue) && parentSession.pendingUserMessageQueue.length > 0) || (Array.isArray(parentSession.pendingCoopIngress) && parentSession.pendingCoopIngress.length > 0)) return false;
    var pending = parentSession.pendingCoordinatorUpdates;
    if (!Array.isArray(pending) || pending.length === 0) return false;
    var updates = pending.splice(0, pending.length);
    sm.saveSessionFile(parentSession);
    var text = updates.map(function (entry) { return entry.text; }).join("\n\n---\n\n");
    dispatchCoordinatorUpdate(parentSession, text);
    return true;
  }
  function finishWorkerTurn(parentSession, task, worker) {
    if (worker._orchestrationTaskClosed || !findTask(parentSession, task.taskId)) return;
    var resultText = workerResultText(worker);
    var status = workerTaskStatusFromResult(resultText);
    var taskUpdates = {
      status: status,
      resultSummary: resultText,
      currentActivity: status === "completed" ? "Completed; awaiting coordinator integration" :
        (status === "reviewing" ? "Worker completed; coordinator action required" : "Needs coordinator attention"),
      verification: orchestratorHelpers.structuredField(resultText, "VERIFICATION"),
      resolutionReason: status === "completed" ? "Verified worker completion" : "",
      resolutionSummary: status === "completed" ? orchestratorHelpers.structuredField(resultText, "SUMMARY") : "",
      resolvedAt: status === "completed" ? Date.now() : null,
      userQuestion: "",
      waitingReason: "",
      userAnsweredAt: null,
    };
    if (status === "failed" && task.attempt < task.maxAttempts) taskUpdates._skipCoopFanIn = true;
    updateTask(parentSession, task.taskId, taskUpdates);
    if (status === "failed" && task.attempt < task.maxAttempts) {
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
      if (Array.isArray(worker.pendingCoordinatorMessages) &&
          worker.pendingCoordinatorMessages.length > 0) {
        var nextMessage = worker.pendingCoordinatorMessages.shift();
        sm.saveSessionFile(worker);
        followup.dispatchTaskMessage(parentSession, task, worker, nextMessage);
        return;
      }
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
          if (slug !== "lead") orchestratorHelpers.archiveTaskWorker(sm, parentSession, tasks[i], worker, "Recovered terminal task worker");
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
    var task = brief.task || taskGraph.createTask(parentSession, brief);
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
    var policy = parentSession.orchestrationPolicy || {};
    var ready = taskGraph.readyTasks(parentSession, policy.maxParallel || 3);
    for (var i = 0; i < ready.length; i++) {
      startTaskFromBrief(parentSession, {
        task: ready[i],
        title: ready[i].title,
        objective: ready[i].objective,
        context: ready[i].context,
        acceptanceCriteria: ready[i].acceptanceCriteria,
        ownedPaths: ready[i].ownedPaths,
        provider: ready[i].provider,
        model: ready[i].model,
        images: ready[i].imageRefs && ctx.loadImagesForSdk ?
          ctx.loadImagesForSdk(ready[i].imageRefs) : null,
      });
    }
    sm.saveSessionFile(parentSession);
    sendState(parentSession);
    return ready;
  }
  function dismissTask(parentSession, task, reason) {
    var previousStatus = task && task.status || "";
    var closed = closeOrchestrationTask(ctx, parentSession, task.taskId, null, {
      reason: reason,
    });
    if (closed) coopRelay.maybeDeliverTaskTransition(parentSession, findTask(parentSession, task.taskId), previousStatus);
    coopRelay.refreshWatchdog();
    return closed;
  }
  function requestTaskInput(parentSession, tasks, question, reason) {
    for (var i = 0; i < tasks.length; i++) {
      updateTask(parentSession, tasks[i].taskId, {
        status: "waiting_user",
        currentActivity: "Waiting for one user decision",
        userQuestion: question,
        waitingReason: reason,
        userAnsweredAt: null,
        resolutionReason: "",
        resolutionSummary: "",
        resolvedAt: null,
      });
    }
  }
  coopRelay = attachTaskOrchestratorCoop({
    sm: sm,
    slug: slug,
    crossProject: crossProject,
    usersModule: usersApi,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    workerForTask: workerForTask,
    now: Date.now,
  });
  followup = attachTaskFollowup({
    sm: sm,
    sdk: sdk,
    coordinatorForInput: coordinatorForInput,
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
  });
  completionGate = attachCompletionGate({
    sm: sm,
    flushCoordinatorUpdates: flushCoordinatorUpdates,
    crossProject: crossProject,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    sendState: sendState,
  });
  orchestratorHelpers.reconcileWorkerSessions(sm, slug, sessionByStorageId);
  restoreWorkers();
  var coordinateExternalTask = createExternalTaskCoordinator({
    coordinatorForInput: coordinatorForInput,
    createProjectExecution: crossProject && (crossProject.createProjectExecution ||
      crossProject.createExecution),
    ensureCoordinatorForInput: ensureCoordinatorForInput,
    projectId: function () {
      return sm && typeof sm.getProjectId === "function" ? sm.getProjectId() : null;
    },
    schedule: scheduleReadyTasks,
    sessionForInput: sessionForInput,
    sm: sm,
  });
  var steerProjectCoordinator = createProjectCoordinatorSteering({ crossProject: crossProject, sessionForInput: sessionForInput, sm: sm, toolError: toolError, toolSuccess: toolSuccess });
  var toolHandlers = createToolHandlers({
    afterResolve: function (parentSession, task) { orchestratorHelpers.archiveTaskWorker(sm, parentSession, task, workerForTask(task), "Resolved by coordinator"); coordinatorDemotion.completePending(parentSession); },
    beforeRetry: function (parentSession, task) {
      orchestratorHelpers.detachWorker(sm, workerForTask(task));
    },
    coordinatorForInput: coordinatorForInput,
    dismissTask: dismissTask,
    ensureCoordinatorForInput: ensureCoordinatorForInput,
    error: toolError,
    retryExistingWorker: followup.retryExistingWorker,
    requestTaskInput: requestTaskInput,
    schedule: scheduleReadyTasks,
    sessionById: function (id) {
      return sessionByStorageId(String(id || "")) || sm.sessions.get(Number(id));
    },
    success: toolSuccess,
    updateTask: updateTask,
    isVerifiedCompletion: isVerifiedCompletion,
    coordinateExternalTask: coordinateExternalTask,
    isProjectExecutionInput: externalOrchestration.hasProjectExecutionInput, steerProjectCoordinator: steerProjectCoordinator,
  });
  var sessionAdoption = attachSessionAdoption({
    cwd: ctx.cwd,
    sm: sm,
    coordinatorForInput: coordinatorForInput,
    dispatchTaskMessage: followup.dispatchTaskMessage,
    error: toolError,
    queueCoordinatorUpdate: queueCoordinatorUpdate,
    success: toolSuccess,
    watchWorker: watchWorker,
  });
  var coordinateQueuedMessage = createQueuedCoordinator({
    cwd: ctx.cwd,
    schedule: scheduleReadyTasks,
    sendToSession: sendToSession,
    sm: sm,
  });
  var portfolioExecutionTarget = externalOrchestration.attachPortfolioExecutionTarget({
    crossProject: crossProject, ensureProjectAccessForSession: ensureProjectAccessForSession,
    onProcessingChanged: onProcessingChanged,
    sdk: sdk,
    sm: sm,
    slug: slug,
  });
  var crossProjectEnvelopes = createCrossProjectEnvelopeHandler({
    commandSchema: externalOrchestration.COMMAND_SCHEMA, crossProject: crossProject,
    followup: followup, portfolioExecutionTarget: portfolioExecutionTarget,
  });
  return {
    coordinateExternalTask: coordinateExternalTask,
    coordinateQueuedMessage: coordinateQueuedMessage,
    deliverCoordinatorUpdate: followup.deliverCoordinatorUpdate,
    deliverCrossProjectEnvelope: crossProjectEnvelopes.deliver,
    handleCoordinatorTurnDone: completionGate.handleTurnDone,
    resumeOwnedWorker: followup.resumeOwnedWorker,
    resumeWaitingCoordinator: completionGate.resumeWaitingFromUser,
    retryReconciliation: completionGate.retry,
    closeTask: function (parentSession, taskId, targetWs) {
      var task = findTask(parentSession, taskId);
      var previousStatus = task && task.status || "";
      var closed = closeOrchestrationTask(ctx, parentSession, taskId, targetWs);
      if (closed) coopRelay.maybeDeliverTaskTransition(parentSession, findTask(parentSession, taskId), previousStatus);
      if (closed && parentSession.coordinationMode &&
          (!Array.isArray(parentSession.orchestrationTasks) ||
           parentSession.orchestrationTasks.length === 0)) {
        coordinatorDemotion.demote(parentSession);
      }
      coopRelay.refreshWatchdog();
      return closed;
    },
    delegateFromTool: toolHandlers.delegate,
    dismissFromTool: toolHandlers.dismiss,
    flushCoordinatorUpdates: flushCoordinatorUpdates,
    messageFromTool: followup.messageFromTool,
    adoptFromTool: sessionAdoption.adoptFromTool,
    listAdoptionCoordinators: sessionAdoption.listCoordinators,
    proposeSessionAdoption: sessionAdoption.propose,
    planFromTool: toolHandlers.plan,
    reportFromTool: portfolioExecutionTarget.wrapReport(toolHandlers.report),
    requestInputFromTool: toolHandlers.requestInput,
    resolveFromTool: toolHandlers.resolve,
    retryFromTool: toolHandlers.retry,
    steerProjectCoordinatorFromTool: toolHandlers.steerProjectCoordinator,
    sendState: sendState,
    tasksForClient: tasksForClient,
    stopCoopWatchdog: coopRelay.stopWatchdog,
  };
}
module.exports = { attachTaskOrchestrator: attachTaskOrchestrator };
