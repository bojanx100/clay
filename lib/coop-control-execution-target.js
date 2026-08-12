// Narrow integration seam between durable Slice 2 control and the existing
// portfolio execution target. Disabled control is a strict pass-through.

var crypto = require("crypto");
var prepareWorkerSession = require("./adaptive-worker-routing").prepareWorkerSession;
var executionRuntime = require("./coop-control-runtime");
var executionFence = require("./coop-control-fence");
var finishControlledExecution =
  require("./coop-control-execution-completion").finishControlledExecution;
var projectIdentity = require("./project-identity");

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
  result.status = "running";
  result.source = source;
  result.updatedAt = timestamp;
  delete result.completedAt;
  delete result.terminalAt;
  delete result.reason;
  delete result.resultEventId;
  delete result.currentActivity;
  delete result.progress;
  return result;
}

function discardUnstartedSession(sm, session) {
  if (!session) return;
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

function applyDurableTerminal(session, metadata, durable, sameIncarnation) {
  var durableStatus = sameIncarnation && durable.execution.status;
  metadata.status = durableStatus === "completed" ? "completed" : "failed";
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
    if (!sameIncarnation && TERMINAL[metadata.status]) return false;
    if (sameIncarnation && metadata.status === durable.execution.status && TERMINAL[metadata.status]) return false;
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

function createExecutionStarter(ctx) {
  function fail(session, error, discardOnFailure, capturedFence) {
    if (capturedFence && !executionFence.isIncarnationCurrent(session, capturedFence)) {
      var metadata = session && session.orchestrationPolicy &&
        session.orchestrationPolicy.portfolioExecution;
      if (!executionFence.matchesSession(session, capturedFence) || !metadata || metadata.status !== "running") {
        return false;
      }
    }
    try { ctx.executionControl.abandonSession(session, "provider_start_failed"); }
    catch (abandonError) {}
    session.isProcessing = false;
    ctx.setExecutionStatus(session, "failed", error && error.message || "execution_start_failed");
    if (discardOnFailure && ctx.executionControl.enabled) discardUnstartedSession(ctx.sm, session);
    return true;
  }

  function startQuery(session, prompt, discardOnFailure) {
    var capturedFence = executionFence.fenceFor(session);
    session.isProcessing = true;
    session._queryStartTs = Date.now();
    ctx.onProcessingChanged();
    try {
      var started = ctx.sdk.startQuery(session, prompt, null, ctx.ensureProjectAccessForSession(session));
      if (started && typeof started.then === "function") {
        started.then(function (result) {
          if (result && result.ok === false) {
            fail(session, new Error(result.reason), discardOnFailure, capturedFence);
          }
        }, function (error) { fail(session, error, discardOnFailure, capturedFence); });
      } else if (started && started.ok === false) {
        fail(session, new Error(started.reason), discardOnFailure, capturedFence);
      }
    } catch (error) {
      fail(session, error, discardOnFailure, capturedFence);
    }
  }

  function continueExecution(session, prompt) {
    if (session.isProcessing && typeof ctx.sdk.pushMessage === "function") {
      ctx.executionControl.assert(session, "tool");
      ctx.sdk.pushMessage(session, prompt, null);
      return;
    }
    startQuery(session, prompt, false);
  }

  return { continueExecution: continueExecution, startQuery: startQuery };
}

module.exports = {
  activeExecutionMetadata: activeExecutionMetadata,
  createExecutionSession: createExecutionSession,
  createExecutionStarter: createExecutionStarter,
  createTargetExecutionControl: createTargetExecutionControl,
  executionBrief: executionBrief,
  executionSessionOptions: executionSessionOptions,
};
