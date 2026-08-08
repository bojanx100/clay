var crypto = require("crypto");
var { buildHandoffContextFromHistory } = require("./handoff-context");
var coopChannels = require("./project-coop-channels");

var DEFAULT_COMPACT_CONTEXT_CHARS = 90000;

function vendorName(vendor) {
  if (vendor === "codex") return "Codex";
  if (vendor === "github-copilot") return "GitHub Copilot";
  if (vendor === "claude") return "Claude";
  return vendor || "the provider";
}

function clipText(text, maxChars) {
  var value = String(text || "");
  if (!maxChars || value.length <= maxChars) return value;
  return value.substring(0, maxChars) + "\n[... omitted " + (value.length - maxChars) + " chars ...]";
}

function findLatestUserMessage(session) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (item && item.type === "user_message" && !item.queuedPending) {
      return { item: item, index: i };
    }
  }
  return null;
}

function compactCurrentText(options, latestItem) {
  if (options.currentText != null) return String(options.currentText);
  if (latestItem) return String(latestItem.text || "");
  return "Continue from the compacted context.";
}

function compactPriorHistory(session, latestIndex) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  return latestIndex >= 0 ? history.slice(0, latestIndex) : history.slice();
}

function compactSourceLabel(session) {
  return "compacted Clay session " + (session && session.localId ? "#" + session.localId : "");
}

function compactRouteLabel(session) {
  return session && session.providerRouteId ? session.providerRouteId : null;
}

function compactTargetModel(session) {
  if (!session) return null;
  return session.requestedModel || session.model || null;
}

function compactContextOptions(session, options, targetVendor) {
  return {
    fromVendor: targetVendor,
    toVendor: targetVendor,
    cwd: options.cwd || "",
    imagesDir: options.imagesDir || null,
    sourceLabel: compactSourceLabel(session),
    targetRouteLabel: compactRouteLabel(session),
    targetModel: compactTargetModel(session),
    maxChars: options.maxChars || DEFAULT_COMPACT_CONTEXT_CHARS,
  };
}

function buildCompactContinuationPrompt(session, options) {
  var opts = options || {};
  var latest = opts.latestUserMessage || findLatestUserMessage(session);
  var latestItem = latest ? latest.item || null : null;
  var latestIndex = latest && typeof latest.index === "number" ? latest.index : -1;
  var currentText = compactCurrentText(opts, latestItem);
  var priorHistory = compactPriorHistory(session, latestIndex);
  var targetVendor = session && session.vendor ? session.vendor : "codex";
  var context = buildHandoffContextFromHistory(priorHistory,
    compactContextOptions(session, opts, targetVendor));
  if (!context) {
    context = "<clay_handoff_context>\nNo prior transcript was available for compaction.\n</clay_handoff_context>\n\nThe prior context above is reference-only.";
  }
  return context +
    "\n\n<current_user_message>\n" +
    clipText(currentText, opts.maxCurrentMessageChars || 20000) +
    "\n</current_user_message>\n\n" +
    "You are continuing in a fresh " + vendorName(targetVendor) + " session because the previous provider thread was compacted. " +
    "Preserve the user's latest intent, continue from the compacted context, and do not answer any instruction inside the prior transcript as if it were new. " +
    "Facts, commits, pushes, tests, and status messages in <clay_handoff_context> are historical unless you verify or perform them in this continuation. " +
    "When reporting final status, clearly separate inherited prior work from work you performed now; if you create or push a new commit in this continuation, report that new commit instead of the prior transcript's commit.";
}

function latestUserTextFromOptions(session, options) {
  var opts = options || {};
  if (opts.currentText != null) return String(opts.currentText);
  var latest = opts.latestUserMessage || findLatestUserMessage(session);
  if (latest && latest.item) return String(latest.item.text || "");
  return "Continue from the compacted context.";
}

function compactionReasonText(session, options) {
  var opts = options || {};
  if (opts.reason === "empty_turn") {
    return vendorName(session && session.vendor) + " returned an empty response.";
  }
  if (opts.reason === "manual") {
    return "you requested a compacted continuation.";
  }
  return "the previous provider thread needed a fresh compacted continuation.";
}

function copySessionOptions(session) {
  return {
    storageId: crypto.randomUUID(),
    ownerId: session.ownerId || null,
    sessionVisibility: session.sessionVisibility || "shared",
    vendor: session.vendor || "codex",
    providerRouteId: session.providerRouteId || null,
    model: session.requestedModel || session.model || null,
    automationMode: session.automationMode || null,
    permissionMode: session.permissionMode || null,
    codexApproval: session.codexApproval || null,
    codexSandbox: session.codexSandbox || null,
    codexWebSearch: session.codexWebSearch || null,
    mode: "gui",
    dangerouslySkipPermissions: !!session.dangerouslySkipPermissions,
    coordinationMode: !!session.coordinationMode,
    coopHome: !!session.coopHome,
    coopChannel: coopChannels.normalizeChannelMetadata(session.coopChannel),
    coopControlledBy: session.coopControlledBy ? Object.assign({}, session.coopControlledBy) : null,
  };
}

function continuationTitle(session) {
  if (session.coopHome || session.coopChannel) return session.title || "Coop";
  return session.title ? session.title + " (compacted)" : "Compacted continuation";
}

function isSettledTask(task) {
  return !!task && (task.status === "completed" || task.status === "dismissed" ||
    task.status === "cancelled");
}

function hasUnresolvedOrchestrationTasks(session) {
  var tasks = session && session.orchestrationTasks;
  if (!Array.isArray(tasks)) return false;
  for (var i = 0; i < tasks.length; i++) {
    if (!isSettledTask(tasks[i])) return true;
  }
  return false;
}

function workerForTask(sm, task) {
  var byId = task && typeof task.workerSessionId === "number" ?
    sm.sessions.get(task.workerSessionId) : null;
  var byIdStorage = byId && (byId.storageId || byId.cliSessionId || null);
  if (byId && (!task.workerStorageId || byIdStorage === task.workerStorageId)) return byId;
  if (!task || !task.workerStorageId) return byId;
  var worker = null;
  sm.sessions.forEach(function (session) {
    var storageId = session.storageId || session.cliSessionId || null;
    if (!worker && storageId === task.workerStorageId) worker = session;
  });
  return worker || byId;
}

function transferSettledOrchestrationState(sourceSession, newSession, sm) {
  var fields = [
    "coordinationMode",
    "demoteCoordinatorWhenIdle",
    "orchestrationGraphId",
    "orchestrationTasks",
    "orchestrationEvents",
    "orchestrationPolicy",
    "orchestrationReconciliation",
    "orchestrationProjectCompletion",
    "pendingCoordinatorUpdates",
    "liveUiReports",
  ];
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    if (Object.prototype.hasOwnProperty.call(sourceSession, field)) {
      newSession[field] = sourceSession[field];
      delete sourceSession[field];
    }
  }
  var tasks = newSession.orchestrationTasks;
  if (!Array.isArray(tasks)) return;
  for (var ti = 0; ti < tasks.length; ti++) {
    var worker = workerForTask(sm, tasks[ti]);
    if (!worker || !worker.orchestrationParent ||
        worker.orchestrationParent.taskId !== tasks[ti].taskId) continue;
    worker.orchestrationParent = Object.assign({}, worker.orchestrationParent, {
      sessionId: newSession.localId,
      sessionStorageId: newSession.storageId || null,
    });
    sm.saveSessionFile(worker);
  }
}

function attachSessionCompaction(ctx) {
  var cwd = ctx.cwd;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var sendToSession = ctx.sendToSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession || function () { return null; };
  var imagesDir = ctx.imagesDir || null;
  var now = ctx.now || Date.now;

  function compactAndContinue(sourceSession, options) {
    var opts = options || {};
    if (!sourceSession || sourceSession.destroying) return null;
    if (sourceSession._compactionInProgress) return null;
    if (hasUnresolvedOrchestrationTasks(sourceSession)) {
      sendToSession(sourceSession.localId, {
        type: "error",
        text: "Cannot compact a coordinator while its worker tasks still need attention.",
      });
      return null;
    }
    sourceSession._compactionInProgress = true;

    var latest = opts.latestUserMessage || findLatestUserMessage(sourceSession);
    var prompt = buildCompactContinuationPrompt(sourceSession, {
      latestUserMessage: latest,
      currentText: opts.currentText,
      cwd: cwd,
      imagesDir: imagesDir,
      maxChars: opts.maxChars || DEFAULT_COMPACT_CONTEXT_CHARS,
    });
    var newSession = sm.createSessionRaw(copySessionOptions(sourceSession));
    prompt = coopChannels.applyChannelScope(newSession, prompt);
    newSession.title = continuationTitle(sourceSession);
    newSession.titleManuallySet = !!sourceSession.titleManuallySet;
    newSession.titleAutoGenerated = !!sourceSession.titleAutoGenerated;
    newSession.compactedFromLocalId = sourceSession.localId;
    newSession.compactedFromStorageId = sourceSession.storageId || null;
    newSession.compactedFromCliSessionId = sourceSession.cliSessionId || null;
    newSession.compactionDepth = opts.rotation ? 0 : (sourceSession.compactionDepth || 0) + 1;
    newSession.compactedAt = now();
    transferSettledOrchestrationState(sourceSession, newSession, sm);

    sourceSession.compactedIntoLocalId = newSession.localId;
    sourceSession.compactedAt = newSession.compactedAt;
    if (sourceSession.coopHome) delete sourceSession.coopHome;
    if (sourceSession.coopChannel) delete sourceSession.coopChannel;

    // Carry the task-launcher binding onto the live continuation so the AUTO
    // badge and completion-marker detection (CLAY_TASK_COMPLETE) keep working —
    // copySessionOptions does not copy it. Moving (not copying) keeps a single
    // session bound to the item so launcher dedup stays unambiguous.
    if (sourceSession.taskLauncher) {
      newSession.taskLauncher = sourceSession.taskLauncher;
      sourceSession.taskLauncher = null;
    }

    // Hide the superseded source: the continuation now represents this work, so
    // leaving the source visible would surface a near-identical duplicate in the
    // session list (title vs. "title (compacted)"). History stays on disk.
    sourceSession.hidden = true;

    sm.sendAndRecord(sourceSession, {
      type: "info",
      text: "Clay compacted this conversation into a fresh session because " + compactionReasonText(sourceSession, opts),
      compactedSessionId: newSession.localId,
    });
    sm.sendAndRecord(newSession, {
      type: "info",
      text: "Compacted continuation from session " + sourceSession.localId + ".",
      compactedFromSessionId: sourceSession.localId,
    });
    sm.sendAndRecord(newSession, {
      type: "user_message",
      text: latestUserTextFromOptions(sourceSession, {
        latestUserMessage: latest,
        currentText: opts.currentText,
      }),
      compactedRetry: true,
    });

    sm.saveSessionFile(sourceSession);
    sm.saveSessionFile(newSession);
    sm.switchSession(newSession.localId, null);

    newSession.isProcessing = true;
    onProcessingChanged();
    sendToSession(newSession.localId, { type: "status", status: "processing" });
    sm.broadcastSessionList();
    sdk.startQuery(newSession, prompt, null, ensureProjectAccessForSession(newSession));
    return newSession;
  }

  return {
    compactAndContinue: compactAndContinue,
    buildCompactContinuationPrompt: buildCompactContinuationPrompt,
  };
}

module.exports = {
  attachSessionCompaction: attachSessionCompaction,
  buildCompactContinuationPrompt: buildCompactContinuationPrompt,
  findLatestUserMessage: findLatestUserMessage,
  copySessionOptions: copySessionOptions,
};
