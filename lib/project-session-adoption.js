var buildHandoffContextFromHistory = require("./handoff-context").buildHandoffContextFromHistory;
var taskGraph = require("./orchestration-task-graph");
var deriveControlledBy = require("./coop-control-provenance").deriveControlledBy;

function attachSessionAdoption(ctx) {
  var sm = ctx.sm;

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
      if (!session || session.hidden || session === source || session.orchestrationParent) return;
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

  function adoptionPrompt(source, coordinator) {
    var handoff = buildHandoffContextFromHistory(source.history, {
      cwd: ctx.cwd || process.cwd(),
      fromVendor: source.vendor || "source provider",
      toVendor: coordinator.vendor || "coordinator provider",
      sourceLabel: "an existing Clay conversation offered for adoption",
      maxChars: 90000,
    });
    return [
      "[Clay existing-session adoption]",
      "The user offered an existing conversation to you for classification.",
      "You are the owning coordinator; do not assume it is a separate task.",
      "",
      "Source session ID: " + (storageId(source) || source.localId),
      "Source title: " + (source.title || "New Session"),
      "",
      "Decide whether this is a new task, an existing task's worker, useful",
      "context only, or unrelated. Use clay-orchestration/adopt_session to",
      "record that decision. For task adoption, provide the objective, acceptance",
      "criteria, and ownership boundary; Clay will continue the existing session",
      "as the executor and return its result here.",
      "",
      "Existing conversation handoff:",
      handoff || "(No transcript was available.)",
    ].join("\n");
  }

  function propose(source, coordinator) {
    if (!source || !coordinator || source === coordinator || source.orchestrationParent) return false;
    coordinator.coordinationMode = true;
    source.orchestrationAdoption = {
      status: "proposed",
      coordinatorStorageId: storageId(coordinator),
      proposedAt: Date.now(),
    };
    sm.saveSessionFile(source);
    sm.saveSessionFile(coordinator);
    ctx.queueCoordinatorUpdate(coordinator, adoptionPrompt(source, coordinator));
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

  function adoptFromTool(input) {
    var coordinator = ctx.coordinatorForInput(input);
    if (!coordinator) return ctx.error("invalid or non-coordinator session id");
    var source = sessionById(input.sourceSessionId);
    if (!source || source === coordinator || source.orchestrationParent) {
      return ctx.error("source session is unavailable or already owned");
    }
    var proposal = source.orchestrationAdoption;
    if (!proposal || proposal.status !== "proposed" ||
        proposal.coordinatorStorageId !== storageId(coordinator)) {
      return ctx.error("source session was not offered to this coordinator");
    }
    var action = String(input.action || "");
    if (action === "context_only" || action === "unrelated") {
      source.orchestrationAdoption = {
        status: action,
        coordinatorStorageId: storageId(coordinator),
        decidedAt: Date.now(),
      };
      sm.saveSessionFile(source);
      sm.broadcastSessionList();
      return ctx.success("Recorded " + action + " for session " + source.localId + ".");
    }
    if (action !== "new_task" && action !== "existing_task") return ctx.error("invalid adoption action");
    if (source.isProcessing) return ctx.error("source session is currently processing");
    var task = action === "existing_task"
      ? taskGraph.findTask(coordinator, String(input.taskId || ""))
      : taskGraph.createTask(coordinator, {
        title: String(input.title || source.title || "Adopted task").trim(),
        objective: String(input.objective || "").trim(),
        context: String(input.context || "").trim(),
        acceptanceCriteria: String(input.acceptanceCriteria || "").trim(),
        ownedPaths: String(input.ownedPaths || "").trim(),
      });
    if (!task) return ctx.error("existing task not found");
    if (task.status === "running" && task.workerStorageId !== storageId(source)) {
      return ctx.error("existing task already has a running worker");
    }
    bindExistingWorker(coordinator, task, source, String(input.message || "").trim());
    return ctx.success("Adopted session " + source.localId + " as worker for " + task.taskId + ".");
  }

  return {
    adoptFromTool: adoptFromTool,
    listCoordinators: listCoordinators,
    propose: propose,
    sessionById: sessionById,
  };
}

module.exports = { attachSessionAdoption: attachSessionAdoption };
