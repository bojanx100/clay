var taskGraph = require("./orchestration-task-graph");

function createToolHandlers(deps) {
  function delegate(input) {
    var required = ["title", "objective", "context", "acceptanceCriteria", "ownedPaths"];
    for (var i = 0; i < required.length; i++) {
      if (!String(input[required[i]] || "").trim()) return deps.error(required[i] + " is required");
    }
    var parent = deps.ensureCoordinatorForInput(input);
    if (!parent) return deps.error("invalid session id or worker sessions cannot delegate");
    var task = taskGraph.createTask(parent, {
      title: String(input.title).trim(),
      objective: String(input.objective).trim(),
      context: String(input.context).trim(),
      acceptanceCriteria: String(input.acceptanceCriteria).trim(),
      ownedPaths: String(input.ownedPaths).trim(),
      provider: String(input.provider || "").trim() || null,
      model: String(input.model || "").trim() || null,
      providerPinned: !!String(input.provider || "").trim(),
      modelPinned: !!String(input.model || "").trim(),
      difficulty: String(input.difficulty || "").trim() || null,
    });
    deps.schedule(parent);
    return deps.success("Started owned worker task " + task.taskId + " in session " +
      task.workerSessionId + ". Its result will return to this coordinator automatically.");
  }

  function plan(input) {
    var specs = Array.isArray(input.tasks) ? input.tasks : [];
    if (!specs.length) return deps.error("tasks is required");
    for (var si = 0; si < specs.length; si++) {
      var candidateSpec = specs[si] || {};
      if (!String(candidateSpec.title || "").trim() || !String(candidateSpec.objective || "").trim()) {
        return deps.error("every task requires title and objective");
      }
    }
    var parent = deps.ensureCoordinatorForInput(input);
    if (!parent) return deps.error("invalid session id or worker sessions cannot delegate");
    if (input.maxParallel) {
      parent.orchestrationPolicy = Object.assign({}, parent.orchestrationPolicy || {}, {
        maxParallel: Math.max(1, Math.min(10, Number(input.maxParallel) || 3)),
      });
    }
    var refs = {};
    var created = [];
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i] || {};
      var task = taskGraph.createTask(parent, {
        clientRef: String(spec.ref || "").trim() || null,
        title: String(spec.title).trim(),
        objective: String(spec.objective).trim(),
        context: String(spec.context || "").trim(),
        acceptanceCriteria: String(spec.acceptanceCriteria || "").trim(),
        ownedPaths: String(spec.ownedPaths || "").trim(),
        dependencies: [],
        provider: String(spec.provider || "").trim() || null,
        model: String(spec.model || "").trim() || null,
        providerPinned: !!String(spec.provider || "").trim(),
        modelPinned: !!String(spec.model || "").trim(),
        difficulty: String(spec.difficulty || "").trim() || null,
        maxAttempts: spec.maxAttempts,
      });
      if (task.clientRef) refs[task.clientRef] = task.taskId;
      created.push({ task: task, dependencies: spec.dependencies });
    }
    for (var j = 0; j < created.length; j++) {
      var dependencies = Array.isArray(created[j].dependencies) ? created[j].dependencies : [];
      created[j].task.dependencies = dependencies.map(function (id) { return refs[id] || id; });
    }
    deps.schedule(parent);
    return deps.success("Created task graph " + parent.orchestrationGraphId + " with tasks: " +
      created.map(function (entry) { return entry.task.taskId; }).join(", ") + ".");
  }

  function report(input) {
    var worker = deps.sessionById(input.workerSessionId);
    var owner = worker && worker.orchestrationParent;
    if (!owner || owner.taskId !== String(input.taskId || "")) return deps.error("invalid worker task");
    var parent = deps.sessionById(owner.sessionStorageId || owner.sessionId);
    var task = parent && taskGraph.findTask(parent, owner.taskId);
    if (!task) return deps.error("task not found");
    deps.updateTask(parent, task.taskId, {
      currentActivity: String(input.activity || "").trim() || "Worker reported progress",
      progress: Math.max(0, Math.min(100, Number(input.progress) || 0)),
    });
    return deps.success("Progress recorded for " + task.taskId + ".");
  }

  function retry(input) {
    var parent = deps.coordinatorForInput(input);
    if (!parent) return deps.error("invalid or non-coordinator session id");
    var task = taskGraph.findTask(parent, String(input.taskId || ""));
    if (!task) return deps.error("task not found");
    if (task.status === "running") return deps.error("task is already running");
    var reusedWorker = !input.freshSession && deps.retryExistingWorker &&
      deps.retryExistingWorker(parent, task);
    if (reusedWorker) {
      return deps.success("Retrying " + task.taskId + " in existing worker session " +
        reusedWorker.localId + ".");
    }
    if (deps.beforeRetry) deps.beforeRetry(parent, task);
    taskGraph.retryTask(parent, task);
    deps.schedule(parent);
    return deps.success("Retry scheduled for " + task.taskId + " with stable task identity.");
  }

  function resolve(input) {
    var parent = deps.coordinatorForInput(input);
    if (!parent) return deps.error("invalid or non-coordinator session id");
    var task = taskGraph.findTask(parent, String(input.taskId || ""));
    if (!task) return deps.error("task not found");
    if (task.status === "running") {
      return deps.error("task is still running; send the worker an update or stop it before resolving");
    }
    var summary = String(input.summary || "").trim();
    var verification = String(input.verification || "").trim();
    var escalation = String(input.escalationRequired || "").trim();
    if (!deps.isVerifiedCompletion(summary, verification, escalation)) {
      return deps.error("completion requires a concrete summary, verification evidence, and escalationRequired=no");
    }
    deps.updateTask(parent, task.taskId, {
      status: "completed",
      resultSummary: summary,
      verification: verification,
      currentActivity: "Completed and verified by coordinator",
      progress: 100,
      resolvedByCoordinator: true,
      resolutionReason: "Verified by coordinator",
      resolutionSummary: summary,
      resolvedAt: Date.now(),
      userQuestion: "",
      waitingReason: "",
    });
    deps.schedule(parent);
    if (deps.afterResolve) deps.afterResolve(parent, task);
    return deps.success("Resolved " + task.taskId + " as completed with coordinator verification.");
  }

  function dismiss(input) {
    var parent = deps.coordinatorForInput(input);
    if (!parent) return deps.error("invalid or non-coordinator session id");
    var task = taskGraph.findTask(parent, String(input.taskId || ""));
    if (!task) return deps.error("task not found");
    var reason = String(input.reason || "").trim();
    if (!reason) return deps.error("reason is required");
    if (task.status === "completed" || task.status === "dismissed" || task.status === "cancelled") {
      return deps.error("task is already resolved");
    }
    if (!deps.dismissTask(parent, task, reason)) return deps.error("task could not be dismissed");
    deps.schedule(parent);
    if (deps.afterResolve) deps.afterResolve(parent, task);
    return deps.success("Dismissed " + task.taskId + " with a durable reason.");
  }

  function requestInput(input) {
    var parent = deps.coordinatorForInput(input);
    if (!parent) return deps.error("invalid or non-coordinator session id");
    var ids = Array.isArray(input.taskIds) ? input.taskIds : [];
    var question = String(input.question || "").trim();
    var reason = String(input.reason || "").trim();
    if (ids.length === 0) return deps.error("taskIds is required");
    if (!question) return deps.error("question is required");
    if (!reason) return deps.error("reason is required");
    var graphTasks = Array.isArray(parent.orchestrationTasks) ? parent.orchestrationTasks : [];
    for (var wi = 0; wi < graphTasks.length; wi++) {
      if (graphTasks[wi] && graphTasks[wi].status === "waiting_user" &&
          String(graphTasks[wi].userQuestion || "").trim() !== question) {
        return deps.error("one user decision is already pending for this task graph");
      }
    }
    var tasks = [];
    for (var i = 0; i < ids.length; i++) {
      var task = taskGraph.findTask(parent, String(ids[i] || ""));
      if (!task) return deps.error("task not found: " + ids[i]);
      if (task.status === "running") return deps.error("task is still running: " + task.taskId);
      if (task.status === "completed" || task.status === "dismissed" || task.status === "cancelled") {
        return deps.error("task is already resolved: " + task.taskId);
      }
      if (tasks.indexOf(task) === -1) tasks.push(task);
    }
    deps.requestTaskInput(parent, tasks, question, reason);
    return deps.success("Recorded one user decision for " + tasks.length + " task" +
      (tasks.length === 1 ? "" : "s") + ". Ask exactly: " + question);
  }

  return {
    delegate: delegate,
    dismiss: dismiss,
    plan: plan,
    report: report,
    requestInput: requestInput,
    resolve: resolve,
    retry: retry,
  };
}

module.exports = { createToolHandlers: createToolHandlers };
