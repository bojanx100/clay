var buildHandoffContextFromHistory = require("./handoff-context").buildHandoffContextFromHistory;
var taskGraph = require("./orchestration-task-graph");
var deriveControlledBy = require("./coop-control-provenance").deriveControlledBy;
var projectIdentity = require("./project-identity");
var workerHasCompletedTurn =
  require("./project-task-orchestrator-helpers").workerHasCompletedTurn;
var sessionExecutionBinding =
  require("./portfolio-execution-bindings").sessionExecutionBinding;

function directLeafBinding(session) {
  var binding = sessionExecutionBinding(session);
  return !!(binding && binding.mode === "direct_leaf");
}

function adoptionIntent(value) {
  return value === "worker" ? "worker" : "classify";
}

function attachSessionAdoption(ctx) {
  var sm = ctx.sm;
  var aliasWatchers = {};

  function storageId(session) {
    return session && (session.storageId || session.cliSessionId) || null;
  }

  function sessionById(id) {
    var numeric = Number(id);
    if (Number.isFinite(numeric) && sm.sessions.has(numeric)) return sm.sessions.get(numeric);
    var found = null;
    sm.sessions.forEach(function (session) {
      if (!found && storageId(session) === String(id || "")) found = session;
    });
    return found;
  }

  function projectIdForManager(manager) {
    return manager && typeof manager.getProjectId === "function" ? manager.getProjectId() : null;
  }

  function sourceRuntime(input) {
    var sourceProjectRef = projectIdentity.normalizeProjectRef(input && input.sourceProjectRef);
    if (input && input.sourceProjectRef !== undefined && !sourceProjectRef) {
      return { error: "invalid source ProjectRef" };
    }
    if (!sourceProjectRef) {
      var local = sessionById(input && input.sourceSessionId);
      return local ? { session: local, manager: sm, external: false,
        ref: projectIdentity.sessionRef({ projectId: projectIdForManager(sm) }, local) } : null;
    }
    if (typeof ctx.resolveGlobalSessionRef !== "function") {
      return { error: "cross-project session resolution is unavailable" };
    }
    var ref = projectIdentity.normalizeSessionRef({
      projectId: sourceProjectRef.projectId,
      sessionStorageId: String(input && input.sourceSessionId || ""),
    });
    if (!ref) return { error: "invalid source ProjectRef or stable source session id" };
    var resolved = ctx.resolveGlobalSessionRef(ref);
    if (!resolved || resolved.ok !== true || !resolved.session) {
      return { error: "source session could not be resolved from the supplied ProjectRef (" +
        String(resolved && resolved.code || "session_not_found") + ")" };
    }
    var manager = resolved.project && typeof resolved.project.getSessionManager === "function" ?
      resolved.project.getSessionManager() : resolved.project && resolved.project.sm;
    if (!manager || typeof manager.saveSessionFile !== "function" ||
        typeof manager.subscribeSession !== "function") {
      return { error: "source project cannot provide a durable adoption alias" };
    }
    return {
      session: resolved.session,
      manager: manager,
      project: resolved.project,
      external: manager !== sm,
      ref: ref,
    };
  }

  function exactOwnerHandoffMatches(coordinator, input) {
    var ingressId = String(input && input.ownerHandoffIngressId || "").trim();
    var sourceId = String(input && input.sourceSessionId || "").trim();
    var history = coordinator && coordinator.history;
    if (!ingressId || !sourceId || !Array.isArray(history)) return false;
    for (var i = history.length - 1; i >= 0; i--) {
      var item = history[i];
      if (!item || item.type !== "user_message" || item.synthetic ||
          item.coopIngressId !== ingressId) continue;
      return String(item.text || "").indexOf(sourceId) !== -1;
    }
    return false;
  }

  function sessionTerms(session) {
    var text = String(session && session.title || "");
    var history = session && session.history;
    if (Array.isArray(history)) {
      for (var i = Math.max(0, history.length - 40); i < history.length; i++) {
        if (history[i] && history[i].type === "user_message") text += " " + (history[i].text || "");
      }
    }
    var words = text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    var terms = {};
    for (var j = 0; j < words.length; j++) terms[words[j]] = true;
    return terms;
  }

  function relatedness(sourceTerms, session) {
    var terms = sessionTerms(session);
    var keys = Object.keys(sourceTerms);
    var score = session.coordinationMode ? 4 : 0;
    for (var i = 0; i < keys.length; i++) {
      if (terms[keys[i]]) score++;
    }
    return score;
  }

  function listCoordinators(source) {
    var candidates = [];
    var sourceTerms = sessionTerms(source);
    sm.sessions.forEach(function (session) {
      if (!session || session.hidden || session === source || session.orchestrationParent ||
          directLeafBinding(session)) return;
      candidates.push({
        id: session.localId,
        storageId: storageId(session),
        title: session.title || "New Session",
        isCoordinator: !!session.coordinationMode,
        isProcessing: !!session.isProcessing,
        lastActivity: session.lastActivity || session.createdAt || 0,
        relatedness: relatedness(sourceTerms, session),
      });
    });
    candidates.sort(function (a, b) {
      if (a.relatedness !== b.relatedness) return b.relatedness - a.relatedness;
      return b.lastActivity - a.lastActivity;
    });
    if (candidates.length) candidates[0].recommended = true;
    return candidates;
  }

  function adoptionPrompt(source, coordinator, intent) {
    var handoff = buildHandoffContextFromHistory(source.history, {
      cwd: ctx.cwd || process.cwd(),
      fromVendor: source.vendor || "source provider",
      toVendor: coordinator.vendor || "coordinator provider",
      sourceLabel: "an existing Clay conversation offered for adoption",
      maxChars: 90000,
    });
    var instructions = intent === "worker" ? [
      "The user explicitly asked you to take this existing conversation as a worker.",
      "You are the owning coordinator. Adopt it as either a new task or an",
      "existing task's worker; do not classify it as context only or unrelated.",
      "Use clay-orchestration/adopt_session to record the task binding. Provide",
      "the objective, acceptance criteria, and ownership boundary; Clay will",
      "continue the existing session as the executor and return its result here.",
    ] : [
      "The user offered an existing conversation to you for classification.",
      "You are the owning coordinator; do not assume it is a separate task.",
      "Decide whether this is a new task, an existing task's worker, useful",
      "context only, or unrelated. Use clay-orchestration/adopt_session to",
      "record that decision. For task adoption, provide the objective, acceptance",
      "criteria, and ownership boundary; Clay will continue the existing session",
      "as the executor and return its result here.",
    ];
    return [
      "[Clay existing-session adoption]",
      instructions.join("\n"),
      "",
      "Source session ID: " + (storageId(source) || source.localId),
      "Source title: " + (source.title || "New Session"),
      "",
      "Existing conversation handoff:",
      handoff || "(No transcript was available.)",
    ].join("\n");
  }

  function propose(source, coordinator, options) {
    if (!source || !coordinator || source === coordinator || source.orchestrationParent ||
        sessionExecutionBinding(source) || directLeafBinding(coordinator)) return false;
    var intent = adoptionIntent(options && options.intent);
    coordinator.coordinationMode = true;
    source.orchestrationAdoption = {
      status: "proposed",
      intent: intent,
      coordinatorStorageId: storageId(coordinator),
      proposedAt: Date.now(),
    };
    sm.saveSessionFile(source);
    sm.saveSessionFile(coordinator);
    ctx.queueCoordinatorUpdate(coordinator, adoptionPrompt(source, coordinator, intent));
    sm.broadcastSessionList();
    return true;
  }

  function bindExistingWorker(coordinator, task, source, message) {
    task.workerSessionId = source.localId;
    task.workerStorageId = storageId(source);
    task.provider = source.vendor || null;
    task.model = source.model || null;
    task.attempt = (task.attempt || 0) + 1;
    taskGraph.transition(coordinator, task, "running", {
      currentActivity: "Adopted session " + source.localId + " is running",
    });
    source.orchestrationParent = {
      taskId: task.taskId,
      sessionId: coordinator.localId,
      sessionStorageId: storageId(coordinator),
      workerColor: task.workerColor || null,
    };
    var controlledBy = deriveControlledBy(coordinator, Date.now());
    if (controlledBy) source.coopControlledBy = controlledBy;
    source.orchestrationAdoption = {
      status: "adopted",
      coordinatorStorageId: storageId(coordinator),
      taskId: task.taskId,
      decidedAt: Date.now(),
    };
    sm.saveSessionFile(source);
    ctx.watchWorker(coordinator, task, source);
    var instruction = [
      "This conversation has been adopted as an owned coordinator task.",
      "Title: " + (task.title || "Adopted task"),
      "Objective: " + (task.objective || "Continue the relevant work"),
      "Acceptance criteria: " + (task.acceptanceCriteria || "Verify the requested outcome"),
      "Owned paths/subsystem: " + (task.ownedPaths || "Infer the smallest safe ownership boundary"),
      task.context ? "Additional context: " + task.context : "",
      message || "Continue from the existing investigation and complete this task.",
    ].filter(function (line) { return !!line; }).join("\n");
    ctx.dispatchTaskMessage(coordinator, task, source, instruction);
  }

  function finishAliasedWorker(coordinator, task, runtime) {
    if (!task || task.status !== "running") return false;
    ctx.finishWorkerTurn(coordinator, task, runtime.session);
    return true;
  }

  function aliasWatcherKey(coordinator, task) {
    return String(storageId(coordinator) || coordinator.localId) + ":" + task.taskId;
  }

  function unwatchAliasedWorker(coordinator, task) {
    var key = aliasWatcherKey(coordinator, task);
    var unsubscribe = aliasWatchers[key];
    delete aliasWatchers[key];
    if (typeof unsubscribe === "function") unsubscribe();
  }

  function watchAliasedWorker(coordinator, task, runtime) {
    var source = runtime && runtime.session;
    var manager = runtime && runtime.manager;
    var key = aliasWatcherKey(coordinator, task);
    if (!source || !manager || aliasWatchers[key]) return false;
    aliasWatchers[key] = true;
    var unsubscribe = manager.subscribeSession(source.localId, function (event) {
      if (!event || event.type !== "done" || task.status !== "running") return;
      unwatchAliasedWorker(coordinator, task);
      finishAliasedWorker(coordinator, task, runtime);
    });
    aliasWatchers[key] = unsubscribe || true;
    return true;
  }

  function bindAliasedWorker(coordinator, task, runtime) {
    var source = runtime.session;
    var coordinatorRef = projectIdentity.sessionRef({ projectId: projectIdForManager(sm) }, coordinator);
    task.workerSessionId = null;
    task.workerStorageId = runtime.ref.sessionStorageId;
    task.workerSessionRef = runtime.ref;
    task.externalAdoptedSession = true;
    task.maxAttempts = 1;
    task.provider = source.vendor || null;
    task.model = source.model || null;
    task.attempt = (task.attempt || 0) + 1;
    ctx.updateTask(coordinator, task.taskId, {
      status: "running",
      currentActivity: "Owner-directed session " + runtime.ref.sessionStorageId + " is running",
    });
    source.orchestrationAdoption = {
      status: "aliased",
      coordinatorSessionRef: coordinatorRef,
      taskId: task.taskId,
      decidedAt: Date.now(),
    };
    runtime.manager.saveSessionFile(source, { durable: true });
    watchAliasedWorker(coordinator, task, runtime);
    if (!source.isProcessing && workerHasCompletedTurn(source)) {
      unwatchAliasedWorker(coordinator, task);
      finishAliasedWorker(coordinator, task, runtime);
    }
  }

  function sourceCanBeAdopted(source, coordinator) {
    var adoption = source && source.orchestrationAdoption;
    var alreadyAdopted = adoption && (adoption.status === "adopted" || adoption.status === "aliased");
    return !!source && source !== coordinator && !source.orchestrationParent &&
      !sessionExecutionBinding(source) && !alreadyAdopted;
  }

  function proposalMatches(source, coordinator) {
    var proposal = source.orchestrationAdoption;
    return !!proposal && proposal.status === "proposed" &&
      proposal.coordinatorStorageId === storageId(coordinator);
  }

  function recordClassification(source, coordinator, action) {
    source.orchestrationAdoption = {
      status: action,
      coordinatorStorageId: storageId(coordinator),
      decidedAt: Date.now(),
    };
    sm.saveSessionFile(source);
    sm.broadcastSessionList();
    return ctx.success("Recorded " + action + " for session " + source.localId + ".");
  }

  function taskForAdoption(input, coordinator, source, action) {
    if (action === "existing_task") {
      return taskGraph.findTask(coordinator, String(input.taskId || ""));
    }
    return taskGraph.createTask(coordinator, {
      title: String(input.title || source.title || "Adopted task").trim(),
      objective: String(input.objective || "").trim(),
      context: String(input.context || "").trim(),
      acceptanceCriteria: String(input.acceptanceCriteria || "").trim(),
      ownedPaths: String(input.ownedPaths || "").trim(),
    });
  }

  function adoptFromTool(input) {
    var coordinator = ctx.coordinatorForInput(input);
    if (!coordinator) return ctx.error("invalid or non-coordinator session id");
    var runtime = sourceRuntime(input);
    if (!runtime) {
      return ctx.error("source session was not found in this project; for an owner-directed " +
        "cross-project handoff provide sourceProjectRef and ownerHandoffIngressId");
    }
    if (runtime.error) return ctx.error(runtime.error);
    var source = runtime.session;
    if (!sourceCanBeAdopted(source, coordinator)) {
      return ctx.error("source session is unavailable or already owned");
    }
    var ownerDirectedAlias = runtime.external && exactOwnerHandoffMatches(coordinator, input);
    if (!proposalMatches(source, coordinator) && !ownerDirectedAlias) {
      if (runtime.external) {
        return ctx.error("cross-project source session was not offered by the exact owner ingress");
      }
      return ctx.error("source session was not offered to this coordinator");
    }
    var action = String(input.action || "");
    var proposal = source.orchestrationAdoption || {};
    if (runtime.external && (action === "context_only" || action === "unrelated")) {
      return ctx.error("owner-directed cross-project handoffs must be aliased as a new or existing task");
    }
    if (proposal.intent === "worker" &&
        (action === "context_only" || action === "unrelated")) {
      return ctx.error("user offered this session as a worker; choose new_task or existing_task");
    }
    if (action === "context_only" || action === "unrelated") {
      return recordClassification(source, coordinator, action);
    }
    if (action !== "new_task" && action !== "existing_task") return ctx.error("invalid adoption action");
    if (!runtime.external && source.isProcessing) {
      return ctx.error("source session is currently processing");
    }
    var task = taskForAdoption(input, coordinator, source, action);
    if (!task) return ctx.error("existing task not found");
    if (task.status === "running" && task.workerStorageId !== storageId(source)) {
      return ctx.error("existing task already has a running worker");
    }
    if (runtime.external) {
      bindAliasedWorker(coordinator, task, runtime);
      return ctx.success("Aliased owner-directed session " + runtime.ref.sessionStorageId +
        " as worker for " + task.taskId + "; its result will return automatically.");
    }
    bindExistingWorker(coordinator, task, source, String(input.message || "").trim());
    return ctx.success("Adopted session " + source.localId + " as worker for " + task.taskId + ".");
  }

  function restoreAliasedWorkers() {
    if (typeof ctx.resolveGlobalSessionRef !== "function" || !sm.sessions) return;
    sm.sessions.forEach(function (coordinator) {
      var tasks = coordinator && coordinator.orchestrationTasks;
      if (!Array.isArray(tasks)) return;
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i];
        if (!task || !task.externalAdoptedSession || task.status !== "running") continue;
        var ref = projectIdentity.normalizeSessionRef(task.workerSessionRef);
        var resolved = ref && ctx.resolveGlobalSessionRef(ref);
        var manager = resolved && resolved.project &&
          typeof resolved.project.getSessionManager === "function" ?
          resolved.project.getSessionManager() : resolved && resolved.project && resolved.project.sm;
        if (!resolved || resolved.ok !== true || !resolved.session || !manager) {
          ctx.updateTask(coordinator, task.taskId, {
            status: "needs_input",
            resultSummary: "Owner-directed source session is unavailable after restart.",
            currentActivity: "Needs coordinator attention after source resolution failed",
          });
          ctx.queueCoordinatorUpdate(coordinator,
            "[Clay owner-directed handoff] Source session " +
            String(ref && ref.sessionStorageId || task.workerStorageId || "unknown") +
            " could not be resolved after restart. Reconcile this owned task; do not wait for an owner status request.");
          continue;
        }
        var runtime = { session: resolved.session, manager: manager,
          project: resolved.project, external: true, ref: ref };
        if (!runtime.session.isProcessing && workerHasCompletedTurn(runtime.session)) {
          finishAliasedWorker(coordinator, task, runtime);
        } else {
          watchAliasedWorker(coordinator, task, runtime);
        }
      }
    });
  }

  return {
    adoptFromTool: adoptFromTool,
    listCoordinators: listCoordinators,
    propose: propose,
    restoreAliasedWorkers: restoreAliasedWorkers,
    sessionById: sessionById,
  };
}

module.exports = { attachSessionAdoption: attachSessionAdoption };
