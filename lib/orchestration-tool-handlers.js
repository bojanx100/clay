var taskGraph = require("./orchestration-task-graph");
var approvalStaging = require("./coop-approval-question-staging");
var decisionStaging = require("./coop-owner-decision-staging");
var localDelegationProblem = require("./coop-control-plane").localDelegationProblem;

function createToolHandlers(deps) {
  function owningTask(parent, taskId) {
    var directTask = taskGraph.findTask(parent, String(taskId || ""));
    if (directTask) return { owner: parent, task: directTask };
    if (typeof deps.coordinatorOwningTask !== "function") return null;
    return deps.coordinatorOwningTask(parent, String(taskId || ""));
  }

  function projectExecutionResult(result, input) {
    if (!result || result.ok !== true) {
      var reason = result && (result.error || result.reason) || "unknown error";
      return deps.error("project execution failed: " + reason);
    }
    var action = result.reused || result.skipped ? "Reused" : "Started";
    var sessionId = result.sessionStorageId || result.coordinatorSessionId ||
      result.workerStorageId || "pending";
    return deps.success(action + " project-owned " + String(input.mode || "execution") +
      " for " + String(input.portfolioTaskId || "portfolio task") + " in project " +
      String(input.targetProject && input.targetProject.projectId || "unknown") +
      " at binding revision " + String(input.bindingRevision || "unknown") +
      " (session " + sessionId + "). Its result will return to this coordinator automatically.");
  }

  // An explicitly supplied topic ref is an attribution CLAIM by the caller.
  // Silently dropping an unusable one would hand the work to whatever inference
  // happens to return -- i.e. attribute it to the wrong lens -- so a supplied
  // ref that cannot be normalized or resolved fails the call instead. Omitting
  // the ref entirely is unchanged: inference still applies.
  function resolvedTopicRef(supplied) {
    if (supplied === undefined || supplied === null || supplied === "") {
      return { ok: true, topicRef: null };
    }
    var normalized = taskGraph.normalizeTopicRefInput(supplied);
    if (!normalized) {
      return { ok: false, reason: "coopTopicRef must be a reference-only { topicId }" };
    }
    if (typeof deps.resolveCoopTopicRef !== "function") {
      return { ok: true, topicRef: normalized };
    }
    var resolved = deps.resolveCoopTopicRef(normalized);
    if (!resolved || resolved.ok !== true) {
      var reason = resolved && (resolved.reason || resolved.error) || "unresolved_topic";
      return { ok: false, reason: "coopTopicRef " + normalized.topicId + " is unusable: " + reason };
    }
    return { ok: true, topicRef: taskGraph.normalizeTopicRefInput(resolved.topicRef) || normalized };
  }

  function delegate(input) {
    var required = ["title", "objective", "context", "acceptanceCriteria", "ownedPaths"];
    for (var i = 0; i < required.length; i++) {
      if (!String(input[required[i]] || "").trim()) return deps.error(required[i] + " is required");
    }
    var topic = resolvedTopicRef(input.coopTopicRef);
    if (!topic.ok) return deps.error(topic.reason);
    if (typeof deps.isProjectExecutionInput === "function" &&
        deps.isProjectExecutionInput(input)) {
      if (typeof deps.coordinateExternalTask !== "function") {
        return deps.error("project execution is unavailable");
      }
      if (topic.topicRef) input = Object.assign({}, input, { coopTopicRef: topic.topicRef });
      var routed = deps.coordinateExternalTask(input);
      if (routed && typeof routed.then === "function") {
        return routed.then(function (result) { return projectExecutionResult(result, input); });
      }
      return projectExecutionResult(routed, input);
    }
    var parent = deps.ensureCoordinatorForInput(input);
    if (!parent) return deps.error("invalid session id or worker sessions cannot delegate");
    var problem = localDelegationProblem(parent);
    if (problem) return deps.error(problem);
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
      // Forward-only: null here means "no explicit claim", which leaves
      // createTask's own inference in charge exactly as before.
      coopTopicRef: topic.topicRef,
    });
    deps.schedule(parent);
    return deps.success("Started owned worker task " + task.taskId + " in session " +
      task.workerSessionId + ". Its result will return to this coordinator automatically.");
  }

  function plan(input) {
    var specs = Array.isArray(input.tasks) ? input.tasks : [];
    if (!specs.length) return deps.error("tasks is required");
    // Every ref is resolved BEFORE any task is created: a bad ref on the third
    // task must not leave the first two behind as half of a graph.
    var topicRefs = [];
    for (var si = 0; si < specs.length; si++) {
      var candidateSpec = specs[si] || {};
      if (!String(candidateSpec.title || "").trim() || !String(candidateSpec.objective || "").trim()) {
        return deps.error("every task requires title and objective");
      }
      var specTopic = resolvedTopicRef(candidateSpec.coopTopicRef);
      if (!specTopic.ok) return deps.error(specTopic.reason);
      topicRefs.push(specTopic.topicRef);
    }
    var parent = deps.ensureCoordinatorForInput(input);
    if (!parent) return deps.error("invalid session id or worker sessions cannot delegate");
    var problem = localDelegationProblem(parent);
    if (problem) return deps.error(problem);
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
        coopTopicRef: topicRefs[i],
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
    var owned = owningTask(parent, input.taskId);
    if (!owned) return deps.error("task not found");
    parent = owned.owner;
    var task = owned.task;
    if (task.status === "running") return deps.error("task is already running");
    var externalRetry = deps.retryExternalTask && deps.retryExternalTask(parent, task);
    if (externalRetry) {
      if (externalRetry.ok !== true) {
        return deps.error("project task retry failed: " +
          String(externalRetry.reason || "delivery_error"));
      }
      return deps.success("Retrying " + task.taskId + " in project task coordinator session " +
        String(externalRetry.sessionStorageId || "unknown") + ".");
    }
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

  function steerProjectCoordinator(input) {
    if (typeof deps.steerProjectCoordinator !== "function") {
      return deps.error("typed cross-project coordinator steering is unavailable");
    }
    return deps.steerProjectCoordinator(input);
  }

  function migrateControlPlaneBinding(input) {
    if (typeof deps.migrateControlPlaneBinding !== "function") {
      return deps.error("typed control-plane binding migration is unavailable");
    }
    return deps.migrateControlPlaneBinding(input);
  }

  function resolve(input) {
    var parent = deps.coordinatorForInput(input);
    if (!parent) return deps.error("invalid or non-coordinator session id");
    var owned = owningTask(parent, input.taskId);
    if (!owned) return deps.error("task not found");
    parent = owned.owner;
    var task = owned.task;
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
    var owned = owningTask(parent, input.taskId);
    if (!owned) return deps.error("task not found");
    parent = owned.owner;
    var task = owned.task;
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
    var suppliedApprovalScopes = Array.isArray(input.approvalScopes) ? input.approvalScopes : [];
    var suppliedDecisionScope = input.ownerDecisionScope || null;
    var question = String(input.question || "").trim();
    var reason = String(input.reason || "").trim();
    if (!reason) return deps.error("reason is required");
    if ((ids.length ? 1 : 0) + (suppliedApprovalScopes.length ? 1 : 0) +
        (suppliedDecisionScope ? 1 : 0) > 1) {
      return deps.error("taskIds, approvalScopes, and ownerDecisionScope are mutually exclusive");
    }
    if (suppliedApprovalScopes.length) {
      if (!parent.coopHome) return deps.error("approvalScopes require the canonical Coop session");
      var scopes = approvalStaging.normalizeScopes(suppliedApprovalScopes);
      if (!scopes) return deps.error("approvalScopes require unique exact task/revision/ProjectRef entries");
      var open = approvalStaging.openStage(parent, scopes);
      if (!open.ok) return deps.error(open.reason);
      if (typeof deps.getExecutionBinding === "function") {
        for (var bi = 0; bi < scopes.length; bi++) {
          var scope = scopes[bi];
          var binding = deps.getExecutionBinding(scope.portfolioTaskId, scope.bindingRevision);
          if (!binding) continue;
          var boundProject = binding.targetProject && binding.targetProject.projectId;
          if (boundProject !== scope.targetProject.projectId) {
            return deps.error("approval_scope_binding_mismatch");
          }
          var boundStatus = String(binding.status || "unknown");
          if (!open.tasks.length) {
            return deps.error("approval_scope_already_bound:" + boundStatus);
          }
          var reason = "Exact portfolio revision is already bound with status " +
            boundStatus + "; the approval placeholder is stale.";
          for (var oi = 0; oi < open.tasks.length; oi++) {
            if (!deps.dismissTask(parent, open.tasks[oi], reason)) {
              return deps.error("stale_approval_cleanup_failed");
            }
          }
          return deps.success("Cleared the stale staged approval because the exact portfolio " +
            "revision is already bound with status " + boundStatus + ". Do not ask the owner again.");
        }
      }
      question = approvalStaging.questionFor(scopes);
      if (open.tasks.length) {
        return deps.success("Reused the existing staged approval set. Ask exactly: " + question);
      }
      var approvalSet = {
        setId: approvalStaging.setIdFor(scopes),
        scopes: scopes,
        stagedAt: Date.now(),
      };
      var created = [];
      for (var ai = 0; ai < scopes.length; ai++) {
        var stagedInput = approvalStaging.stagedTaskInput(scopes[ai], approvalSet,
          question, reason);
        var stagedTask = taskGraph.createTask(parent, stagedInput);
        stagedTask.approvalSet = stagedInput.approvalSet;
        // Make every placeholder non-runnable in memory before the first save.
        // Since a session save writes the whole graph, creating the whole set as
        // queued first could durably expose later members to the scheduler if a
        // save or process failed partway through this loop.
        taskGraph.transition(parent, stagedTask, "waiting_user", {
          currentActivity: "Waiting for the staged owner approval",
          userQuestion: question,
          waitingReason: reason,
          userAnsweredAt: null,
          approvalSet: approvalSet,
        });
        created.push(stagedTask);
      }
      for (var ci = 0; ci < created.length; ci++) {
        var persisted = deps.updateTask(parent, created[ci].taskId, {
          status: "waiting_user",
        });
        if (!persisted) return deps.error("approval_set_persistence_failed");
      }
      return deps.success("Staged exact approval for " + scopes.length + " portfolio revision" +
        (scopes.length === 1 ? "" : "s") + " without scheduling work. Ask exactly: " + question);
    }
    if (suppliedDecisionScope) {
      if (!parent.coopHome) return deps.error("ownerDecisionScope requires the canonical Coop session");
      if (!question) return deps.error("question is required");
      var scope = decisionStaging.normalizeScope(suppliedDecisionScope);
      if (!scope) {
        return deps.error("ownerDecisionScope requires exact targetProject, portfolioTaskId, bindingRevision, planRevision, planDigest, and coopTopicRef");
      }
      var opened = decisionStaging.openStage(parent, scope, question);
      if (!opened.ok) return deps.error(opened.reason);
      if (opened.existing) {
        return deps.success("Reused the existing durable owner decision " +
          opened.decision.decisionRef + ". Ask exactly: " + question);
      }
      var stagedDecision = decisionStaging.newDecision(scope, parent);
      var active = decisionStaging.activeDecisionTasks(parent);
      for (var oi = 0; oi < active.length; oi++) {
        var prior = active[oi];
        if (prior.decision.state !== "unanswered" ||
            decisionStaging.planKey(prior.decision.scope) !== decisionStaging.planKey(scope)) continue;
        var superseded = deps.updateTask(parent, prior.task.taskId,
          decisionStaging.supersessionUpdates(prior.decision, stagedDecision.decisionRef,
            "Superseded by explicitly staged plan decision " + stagedDecision.decisionRef));
        if (!superseded) return deps.error("owner_decision_supersession_failed");
      }
      var stagedInput = decisionStaging.stagedTaskInput(scope, stagedDecision, question, reason);
      var stagedTask = taskGraph.createTask(parent, stagedInput);
      stagedTask.ownerDecision = stagedInput.ownerDecision;
      taskGraph.transition(parent, stagedTask, "needs_input", {
        currentActivity: "Waiting for the owner's explicit plan decision",
        userQuestion: question,
        waitingReason: reason,
        userAnsweredAt: null,
        ownerDecision: stagedInput.ownerDecision,
      });
      var persistedDecision = deps.updateTask(parent, stagedTask.taskId, { status: "needs_input" });
      if (!persistedDecision) return deps.error("owner_decision_persistence_failed");
      if (typeof deps.onOwnerDecisionStaged === "function") {
        deps.onOwnerDecisionStaged(parent, stagedDecision);
      }
      return deps.success("Staged durable owner decision " + stagedDecision.decisionRef +
        " without scheduling work. Ask exactly: " + question);
    }
    if (ids.length === 0) return deps.error("taskIds, approvalScopes, or ownerDecisionScope is required");
    if (!question) return deps.error("question is required");
    var tasks = [];
    var taskOwner = null;
    for (var i = 0; i < ids.length; i++) {
      var owned = owningTask(parent, ids[i]);
      if (!owned) return deps.error("task not found: " + ids[i]);
      if (!taskOwner) taskOwner = owned.owner;
      if (taskOwner !== owned.owner) {
        return deps.error("taskIds must belong to one task graph");
      }
      var task = owned.task;
      if (task.status === "running") return deps.error("task is still running: " + task.taskId);
      if (task.status === "completed" || task.status === "dismissed" || task.status === "cancelled") {
        return deps.error("task is already resolved: " + task.taskId);
      }
      if (tasks.indexOf(task) === -1) tasks.push(task);
    }
    var graphTasks = Array.isArray(taskOwner && taskOwner.orchestrationTasks) ?
      taskOwner.orchestrationTasks : [];
    for (var wi = 0; wi < graphTasks.length; wi++) {
      if (graphTasks[wi] && graphTasks[wi].status === "waiting_user" &&
          String(graphTasks[wi].userQuestion || "").trim() !== question) {
        return deps.error("one user decision is already pending for this task graph");
      }
    }
    deps.requestTaskInput(taskOwner, tasks, question, reason);
    return deps.success("Recorded one user decision for " + tasks.length + " task" +
      (tasks.length === 1 ? "" : "s") + ". Ask exactly: " + question);
  }

  return {
    delegate: delegate,
    dismiss: dismiss,
    migrateControlPlaneBinding: migrateControlPlaneBinding,
    plan: plan,
    report: report,
    requestInput: requestInput,
    resolve: resolve,
    retry: retry,
    steerProjectCoordinator: steerProjectCoordinator,
  };
}

module.exports = { createToolHandlers: createToolHandlers };
