// Narrow integration seam between durable Slice 2 control and the existing
// portfolio execution target. Disabled control is a strict pass-through.

var crypto = require("crypto");
var prepareWorkerSession = require("./adaptive-worker-routing").prepareWorkerSession;
var executionRuntime = require("./coop-control-runtime");
var executionFence = require("./coop-control-fence");
var finishControlledExecution =
  require("./coop-control-execution-completion").finishControlledExecution;
var projectIdentity = require("./project-identity");
var coordinatorHierarchy = require("./project-coordinator-hierarchy");

var TERMINAL = { completed: true, failed: true, needs_input: true, superseded: true, cancelled: true };

function executionBrief(payload) {
  return {
    title: String(payload.title || "Project execution").trim().slice(0, 240),
    objective: String(payload.objective || "").trim(),
    context: String(payload.context || "").trim(),
    acceptanceCriteria: String(payload.acceptanceCriteria || "").trim(),
    ownedPaths: String(payload.ownedPaths || "").trim(),
    provider: String(payload.provider || "").trim() || null,
    model: String(payload.model || "").trim() || null,
    difficulty: String(payload.difficulty || "").trim() || null,
    controlRole: String(payload.controlRole || "").trim() || null,
    reviewOnly: payload.reviewOnly === true,
  };
}

function executionSessionOptions(sm, brief, payload) {
  var parentPolicy = {
    ownerId: payload.ownerId || null,
    vendor: brief.provider || sm.defaultVendor || "claude",
    providerRouteId: payload.providerRouteId || null,
    model: brief.model || sm.currentModel || null,
    permissionMode: sm.currentPermissionMode || sm.serverDefaultMode || null,
    automationMode: sm.defaultAutomationMode || null,
    codexApproval: sm.codexApproval || null,
    codexSandbox: sm.codexSandbox || null,
    codexWebSearch: sm.codexWebSearch || null,
  };
  var task = Object.assign({}, brief, {
    providerPinned: !!brief.provider,
    modelPinned: !!brief.model,
  });
  return prepareWorkerSession(sm, parentPolicy, task, crypto.randomUUID());
}

function activeExecutionMetadata(metadata, request, source) {
  var timestamp = Date.now();
  var result = metadata ? Object.assign({}, metadata) : {
    portfolioTaskId: request.portfolioTaskId,
    bindingRevision: request.bindingRevision,
    idempotencyKey: request.idempotencyKey,
    mode: request.mode,
    createdAt: timestamp,
  };
  result.targetProject = request.targetProject;
  result.controlPlaneProvenance = request.controlPlaneProvenance;
  result.taskPayloadDigest = request.taskPayloadDigest;
  result.provider = request.provider || null;
  result.model = request.model || null;
  result.status = "running";
  result.source = source;
  result.updatedAt = timestamp;
  if (request.controlRole) result.controlRole = request.controlRole;
  else delete result.controlRole;
  if (request.reviewOnly === true) result.reviewOnly = true;
  else delete result.reviewOnly;
  if (request.coopTopicRef) result.coopTopicRef = request.coopTopicRef;
  else delete result.coopTopicRef;
  if (request.automationAuthorization) {
    result.automationAuthorization = request.automationAuthorization;
  } else delete result.automationAuthorization;
  delete result.completedAt;
  delete result.terminalAt;
  delete result.reason;
  delete result.resultEventId;
  delete result.currentActivity;
  delete result.progress;
  delete result.failureCode;
  delete result.failureDetails;
  return result;
}

function discardUnstartedSession(sm, session) {
  if (!session) return;
  if (session.coordinationRole === "task_coordinator" && session.orchestrationParent) {
    var root = null;
    sm.sessions.forEach(function (candidate) {
      if (!root && projectIdentity.sessionStorageId(candidate) ===
          session.orchestrationParent.sessionStorageId) root = candidate;
    });
    if (root) coordinatorHierarchy.unlinkTaskCoordinator(sm, root, session);
  }
  if (typeof session._portfolioExecutionWatcher === "function") {
    try { session._portfolioExecutionWatcher(); } catch (error) {}
  }
  session._portfolioExecutionWatcher = null;
  if (typeof sm.deleteSessionQuiet === "function") {
    try { sm.deleteSessionQuiet(session.localId); } catch (error) {}
  }
  if (sm.sessions && typeof sm.sessions.delete === "function" && sm.sessions.has(session.localId)) {
    sm.sessions.delete(session.localId);
  }
}

function createExecutionSession(ctx, input) {
  var control = ctx.executionControl;
  var start = control.reserve(input.request, input.source);
  var session = null;
  try {
    var options = executionSessionOptions(ctx.sm, input.brief, input.payload);
    // Controlled commands are one provider turn each. The Codex adapter keeps
    // a handle subscribed until its input closes; leaving this false lets each
    // prior resume handle receive every later turn on the same provider thread.
    options.singleTurn = true;
    options.coordinationMode = input.request.mode === "project_coordinator";
    options.coopControlledBy = {
      coopSessionStorageId: input.source.sessionStorageId,
      since: Date.now(),
    };
    session = ctx.sm.createSessionRaw(options);
    var controlMetadata = control.bind(session, start);
    session.title = input.brief.title || (input.request.mode === "project_coordinator" ?
      "Project coordinator" : "Direct portfolio task");
    session.titleManuallySet = true;
    session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
      portfolioExecution: activeExecutionMetadata(null, input.request, input.source),
    });
    if (controlMetadata) session.orchestrationPolicy.portfolioExecution.control = controlMetadata;
    if (input.request.mode === "project_coordinator") {
      session.orchestrationTasks = [];
      session.orchestrationEvents = [];
    }
    if (typeof input.prepareSession === "function") input.prepareSession(session);
    if (typeof input.captureRecovery === "function") input.captureRecovery(session);
    var message = {
      type: "user_message", text: input.prompt, synthetic: true,
      origin: { kind: "portfolio_execution" }, _ts: Date.now(),
    };
    session.history.push(message);
    ctx.sm.appendToSessionFile(session, message);
    ctx.sm.saveSessionFile(session);
    ctx.sm.broadcastSessionList();
    if (input.request.mode === "direct_leaf") ctx.watchDirectLeaf(session);
    control.open(start);
    return session;
  } catch (error) {
    if (typeof input.rollbackSession === "function") {
      try { input.rollbackSession(session); } catch (rollbackError) {}
    }
    if (control.enabled) {
      try { control.abandonStart(start, "pre_start_failed"); } catch (abandonError) {}
      discardUnstartedSession(ctx.sm, session);
    }
    throw error;
  }
}

function sameDurableIncarnation(metadata, durable) {
  var current = durable && durable.current;
  return !!(current && current.incarnationId === metadata.control.incarnationId &&
    current.epoch === metadata.control.epoch);
}

function durableTerminalStatus(durable, sameIncarnation) {
  if (!sameIncarnation) return "failed";
  if (durable.execution.status === "completed") return "completed";
  return durable.current.failureCode === "needs_input" ? "needs_input" : "failed";
}

function applyDurableTerminal(session, metadata, durable, sameIncarnation) {
  metadata.status = durableTerminalStatus(durable, sameIncarnation);
  session.isProcessing = false;
  metadata.updatedAt = sameIncarnation && durable.execution.updatedAt || Date.now();
  metadata.terminalAt = sameIncarnation && durable.execution.finishedAt || metadata.updatedAt;
  if (metadata.status === "completed") {
    metadata.completedAt = metadata.terminalAt;
    delete metadata.reason;
  } else {
    metadata.reason = sameIncarnation && durable.current.failureCode || "control_restart_recovery";
  }
  return true;
}

function createTargetExecutionControl(ctx) {
  var control = ctx.coopExecutionControl || executionRuntime.getExecutionControl();

  function reserve(request, source) {
    if (!control.enabled) return null;
    return control.reserveStart({
      portfolioTaskId: request.portfolioTaskId,
      bindingRevision: request.bindingRevision,
      idempotencyKey: request.idempotencyKey,
      mode: request.mode,
      targetProject: request.targetProject,
      source: source,
    });
  }

  function bind(session, start) {
    if (!start) return null;
    var ref = projectIdentity.sessionRef({ projectId: ctx.projectId() }, session);
    control.bindStart(start, ref);
    var fence = control.createFence(start);
    var metadata = executionFence.attachFence(session, fence);
    return metadata;
  }

  function open(start) {
    return start ? control.openStartBarrier(start) : true;
  }

  function abandonStart(start, reason) {
    if (!start) return false;
    try { return control.abandon(start, reason); } catch (cause) { return false; }
  }

  function abandonSession(session, reason) {
    if (!control.enabled) return false;
    var fence;
    try { fence = executionFence.fenceFor(session); } catch (cause) { return false; }
    return fence ? fence.abandon(reason) : false;
  }

  function finish(session, status) {
    return finishControlledExecution(session, status, { control: control });
  }

  function reconcileSession(session, metadata) {
    if (!control.enabled) return false;
    if (!metadata || !metadata.control) return false;
    var runtimeFence = session._coopExecutionFence;
    if (runtimeFence && runtimeFence.isCurrent("callback")) return false;
    var durable = control.inspect(metadata.control.executionId);
    var sameIncarnation = sameDurableIncarnation(metadata, durable);
    var durableStatus = durableTerminalStatus(durable, sameIncarnation);
    if (!sameIncarnation && TERMINAL[metadata.status]) return false;
    if (sameIncarnation && metadata.status === durableStatus && TERMINAL[metadata.status]) return false;
    return applyDurableTerminal(session, metadata, durable, sameIncarnation);
  }

  function findSession(sm, request, executionMetadata) {
    var first = null;
    var active = null;
    sm.sessions.forEach(function (session) {
      var metadata = executionMetadata(session);
      if (metadata && metadata.portfolioTaskId === request.portfolioTaskId &&
          metadata.bindingRevision === request.bindingRevision) {
        if (!first) first = session;
        if (!active && !TERMINAL[metadata.status]) active = session;
      }
    });
    return active || first;
  }

  return {
    abandonSession: abandonSession,
    abandonStart: abandonStart,
    assert: function (session, action) {
      return control.enabled ? executionFence.assertAction(session, action) : true;
    },
    bind: bind,
    enabled: !!control.enabled,
    finish: finish,
    findSession: findSession,
    open: open,
    reconcileSession: reconcileSession,
    reserve: reserve,
  };
}

function staleStartFailure(session, capturedFence) {
  if (!capturedFence || executionFence.isIncarnationCurrent(session, capturedFence)) return false;
  var metadata = session && session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
  return !executionFence.matchesSession(session, capturedFence) || !metadata || metadata.status !== "running";
}

function normalizedFailureDetails(value) {
  if (!value || typeof value !== "object") return null;
  try {
    var serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 16384) return null;
    var parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

function preStartFailure(value) {
  var input = value && typeof value === "object" ? value : {};
  var reason = String(input.reason || input.message || value || "execution_start_failed").trim()
    .slice(0, 240);
  var code = String(input.code || input.reason || "provider_start_failed").trim().slice(0, 128);
  return {
    reason: reason || "execution_start_failed",
    code: code || "provider_start_failed",
    details: normalizedFailureDetails(input.details),
  };
}

function createExecutionStarter(ctx) {
  function preservingRecoveryFence(fence) {
    if (!fence) return null;
    return Object.freeze({ refs: fence.refs,
      abandon: function () { return false; },
      assert: function (action) { return fence.assert(action); },
      complete: function () { return fence.complete(); },
      isCurrent: function (action) { return fence.isCurrent(action); },
      isIncarnationCurrent: function () { return fence.isIncarnationCurrent(); },
      markProviderStarted: function () { return fence.markProviderStarted(); } });
  }

  function fail(session, error, discardOnFailure, capturedFence, recoveryStart) {
    if (staleStartFailure(session, capturedFence)) return false;
    var failure = preStartFailure(error);
    if (!recoveryStart) {
      try { ctx.executionControl.abandonSession(session, failure.code); }
      catch (abandonError) {}
    }
    session.isProcessing = false;
    ctx.setExecutionStatus(session, recoveryStart ? "pending" : "failed",
      failure.reason, failure);
    var recovery = null;
    if (!recoveryStart && typeof ctx.onStartFailure === "function") {
      try { recovery = ctx.onStartFailure(session, failure); } catch (recoveryError) {}
    }
    if (!recoveryStart && discardOnFailure && ctx.executionControl.enabled &&
        !(recovery && recovery.pending === true)) {
      discardUnstartedSession(ctx.sm, session);
    }
    return true;
  }

  function startQuery(session, prompt, discardOnFailure, startMode) {
    var capturedFence = executionFence.fenceFor(session);
    // Sessions created before this invariant existed are still controlled by a
    // live fence. Enforce the one-turn boundary again at every controlled start
    // so a normal restart or typed recovery cannot recreate stream fanout.
    if (capturedFence) session.singleTurn = true;
    var recoveryStart = startMode === "recovery";
    var activeFence = recoveryStart ? preservingRecoveryFence(capturedFence) : capturedFence;
    if (activeFence && activeFence !== capturedFence) executionFence.attachFence(session, activeFence);
    function restoreFence() {
      if (activeFence && activeFence !== capturedFence && session._coopExecutionFence === activeFence) {
        executionFence.attachFence(session, capturedFence);
      }
    }
    function completionEvidence(result) {
      if (result && result.ok === false) {
        fail(session, result, discardOnFailure, capturedFence, recoveryStart);
        restoreFence();
        return false;
      }
      restoreFence();
      return !capturedFence || capturedFence.isCurrent("callback");
    }
    function failed(error) {
      fail(session, error, discardOnFailure, capturedFence, recoveryStart);
      restoreFence();
      return false;
    }
    session.isProcessing = true;
    session._queryStartTs = Date.now();
    ctx.onProcessingChanged();
    try {
      var queryStart = ctx.sdk.startQuery(session, prompt, null, ctx.ensureProjectAccessForSession(session));
      if (queryStart && typeof queryStart.then === "function") {
        return queryStart.then(function (result) { return completionEvidence(result); }, failed);
      }
      return completionEvidence(queryStart);
    } catch (error) {
      return failed(error);
    }
  }

  function continueExecution(session, prompt, startMode) {
    if (session.isProcessing && typeof ctx.sdk.pushMessage === "function") {
      ctx.executionControl.assert(session, "tool");
      ctx.sdk.pushMessage(session, prompt, null);
      return true;
    }
    return startQuery(session, prompt, false, startMode);
  }

  return { continueExecution: continueExecution, startQuery: startQuery };
}

module.exports = {
  activeExecutionMetadata: activeExecutionMetadata,
  createExecutionSession: createExecutionSession,
  createExecutionStarter: createExecutionStarter,
  createTargetExecutionControl: createTargetExecutionControl,
  discardUnstartedSession: discardUnstartedSession,
  executionBrief: executionBrief,
  executionSessionOptions: executionSessionOptions,
  preStartFailure: preStartFailure,
};
