var fs = require("fs");
var path = require("path");
var sessionHistory = require("./sessions-history");

function attachSessionLoader(ctx) {
  var sessionsDir = ctx.sessionsDir;
  var sessionFilePath = ctx.sessionFilePath;
  var sessions = ctx.sessions;
  var allocateLocalId = ctx.allocateLocalId;
  var saveSessionFile = ctx.saveSessionFile;
  var isValidCliSessionId = ctx.isValidCliSessionId;
  var ensureCodexThreadIndex = ctx.ensureCodexThreadIndex;
  var codexThreadIndexed = ctx.codexThreadIndexed;
  var inferCurrentVendorFromHistory = ctx.inferCurrentVendorFromHistory;
  var inferCurrentProviderRouteFromHistory = ctx.inferCurrentProviderRouteFromHistory;
  var inferCurrentModelFromHistory = ctx.inferCurrentModelFromHistory;
  var inferCliSessionIdAfterLastHandoff = ctx.inferCliSessionIdAfterLastHandoff;
  var hasVendorResponseSinceLastSwitch = ctx.hasVendorResponseSinceLastSwitch;
  var shouldRecoverMissingHandoffContext = ctx.shouldRecoverMissingHandoffContext;
  var recoverMissingHandoffContext = ctx.recoverMissingHandoffContext;
  var handoffTurnBudgetForVendor = ctx.handoffTurnBudgetForVendor;

  function isTurnBoundaryDone(item) {
    return item && item.type === "done";
  }

  function isTurnStartingHistoryItem(item) {
    if (!item || !item.type) return false;
    if (item.type === "user_message" && item.queuedPending) return false;
    if (item.type === "user_message" && !item.queuedDuringProcessing) return true;
    return sessionHistory.isAssistantReplayEvent(item) ||
      item.type === "result" ||
      item.type === "error" ||
      item.type === "context_overflow" ||
      item.type === "process_conflict" ||
      item.type === "auth_required";
  }

  function lastHistoryTimestamp(history) {
    if (!Array.isArray(history)) return 0;
    for (var i = history.length - 1; i >= 0; i--) {
      var it = history[i];
      if (it && typeof it._ts === "number") return it._ts;
    }
    return 0;
  }

  function hasInterruptedTurn(history) {
    if (!Array.isArray(history) || history.length === 0) return false;
    var open = false;
    for (var i = 0; i < history.length; i++) {
      var item = history[i];
      if (isTurnBoundaryDone(item)) {
        open = false;
      } else if (isTurnStartingHistoryItem(item)) {
        open = true;
      }
    }
    return open;
  }

  function hasUncontinuedRestartInterruption(history) {
    if (!Array.isArray(history) || history.length === 0) return false;
    var sawRestartInterruption = false;
    for (var i = history.length - 1; i >= 0; i--) {
      var item = history[i] || {};
      if (item.type === "user_message" || item.type === "scheduled_message_sent" || item.type === "scheduled_message_cancelled" || item.type === "vendor_switched") {
        return false;
      }
      if (item.type === "info" && String(item.text || "").indexOf("Session was interrupted by a Clay restart.") !== -1) {
        sawRestartInterruption = true;
        break;
      }
    }
    return sawRestartInterruption;
  }

  function relabelLegacyAutoContinueHistory(history) {
    if (!Array.isArray(history)) return 0;
    var changed = 0;
    var prevType = null;
    for (var i = 0; i < history.length; i++) {
      var item = history[i];
      if (!item || typeof item !== "object") { prevType = null; continue; }
      if (item.type === "user_message"
          && typeof item.text === "string"
          && item.text.trim().toLowerCase() === "continue"
          && prevType === "scheduled_message_sent") {
        item.text = "↻ Auto-continued";
        changed++;
      }
      prevType = item.type;
    }
    return changed;
  }

  function markRestartInterruptedSession(session) {
    if (!session || session.interruptedByRestart) return;
    session.interruptedByRestart = true;
    var stalledTs = lastHistoryTimestamp(session.history) || Date.now();
    session.restartInterruptedAt = stalledTs;
    var interruptedTs = stalledTs;
    session.history.push({ type: "thinking_stop", _ts: interruptedTs });
    session.history.push({
      type: "info",
      text: "Session was interrupted by a Clay restart. Clay will continue it when you reopen this session.",
      _ts: interruptedTs + 1,
    });
    session.history.push({ type: "done", code: 1, _ts: interruptedTs + 2 });
  }

  function messageUuidsFromHistory(history) {
    var messageUUIDs = [];
    for (var k = 0; k < history.length; k++) {
      if (history[k].type === "message_uuid") {
        messageUUIDs.push({ uuid: history[k].uuid, type: history[k].messageType, historyIndex: k });
      }
    }
    return messageUUIDs;
  }

  function hydrateSession(m, history, fileMtime) {
    var localId = allocateLocalId();
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: m.cliSessionId || null,
      storageId: m.storageId || m.cliSessionId || null,
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      isProcessing: false,
      title: m.title || "",
      createdAt: m.createdAt || Date.now(),
      lastActivity: fileMtime || m.createdAt || Date.now(),
      lastViewedAt: m.lastViewedAt || null,
      history: history,
      messageUUIDs: messageUuidsFromHistory(history),
      lastRewindUuid: m.lastRewindUuid || null,
    };
    var hasPersistedRestartInterruption = m.interruptedByRestart || hasUncontinuedRestartInterruption(session.history);
    if (hasPersistedRestartInterruption) session.interruptedByRestart = true;
    if (hasInterruptedTurn(session.history)) {
      markRestartInterruptedSession(session);
      session.restartResumeEligible = !hasPersistedRestartInterruption;
      if (!session.restartInterruptedAt) {
        session.restartInterruptedAt = lastHistoryTimestamp(session.history) || Date.now();
      }
    }
    if (m.vendor) session.vendor = m.vendor;
    if (m.providerRouteId) session.providerRouteId = m.providerRouteId;
    if (m.model) session.model = m.model;
    if (m.verifiedModel) session.verifiedModel = m.verifiedModel;
    if (m.requestedModel) session.requestedModel = m.requestedModel;
    if (m.modelVerificationSource) session.modelVerificationSource = m.modelVerificationSource;
    var inferredVendor = inferCurrentVendorFromHistory(session.history, session.vendor || null);
    if (inferredVendor) session.vendor = inferredVendor;
    var inferredProviderRouteId = inferCurrentProviderRouteFromHistory(session.history, session.providerRouteId || null);
    if (inferredProviderRouteId) session.providerRouteId = inferredProviderRouteId;
    var inferredModel = inferCurrentModelFromHistory(session.history, session.model || null);
    if (inferredModel) session.model = inferredModel;
    var inferredCliSessionId = inferCliSessionIdAfterLastHandoff(session.history);
    if (inferredCliSessionId) session.cliSessionId = inferredCliSessionId;
    if (m.automationMode) session.automationMode = m.automationMode;
    if (m.permissionMode) session.permissionMode = m.permissionMode;
    if (m.codexApproval) session.codexApproval = m.codexApproval;
    if (m.codexSandbox) session.codexSandbox = m.codexSandbox;
    if (m.codexWebSearch) session.codexWebSearch = m.codexWebSearch;
    if (m.compactedFromLocalId) session.compactedFromLocalId = m.compactedFromLocalId;
    if (m.compactedFromStorageId) session.compactedFromStorageId = m.compactedFromStorageId;
    if (m.compactedFromCliSessionId) session.compactedFromCliSessionId = m.compactedFromCliSessionId;
    if (m.compactedIntoLocalId) session.compactedIntoLocalId = m.compactedIntoLocalId;
    if (m.compactedAt) session.compactedAt = m.compactedAt;
    if (typeof m.compactionDepth === "number") session.compactionDepth = m.compactionDepth;
    if (typeof m.consecutiveAutoResumes === "number") session._consecutiveAutoResumes = m.consecutiveAutoResumes;
    if (m.handoffContext) session.handoffContext = m.handoffContext;
    if (typeof m.handoffContextTurnsRemaining === "number") session.handoffContextTurnsRemaining = m.handoffContextTurnsRemaining;
    if (m.handoffContextRecovered) session.handoffContextRecovered = true;
    if (m.handoffContextConsumed) session.handoffContextConsumed = true;
    if (m.copilotHandoffNativeReset) session.copilotHandoffNativeReset = true;
    if (session.handoffContext && hasVendorResponseSinceLastSwitch(session.history)) {
      session.handoffContext = null;
      session.handoffContextTurnsRemaining = 0;
      session.handoffContextConsumed = true;
    }
    if (!session.handoffContext && !session.handoffContextConsumed && shouldRecoverMissingHandoffContext(session) && (!session.handoffContextRecovered || session.handoffContextTurnsRemaining <= 0)) {
      var recoveredHandoffContext = recoverMissingHandoffContext(session.history);
      if (recoveredHandoffContext) {
        session.handoffContext = recoveredHandoffContext;
        session.handoffContextTurnsRemaining = handoffTurnBudgetForVendor(session.vendor);
        session.handoffContextRecovered = true;
      }
    }
    if ((!session.vendor || session.vendor === "claude") && session.cliSessionId && codexThreadIndexed(session.cliSessionId)) {
      session.vendor = "codex";
    }
    if (m.hidden) session.hidden = true;
    if (m.loop) session.loop = m.loop;
    if (m.taskLauncher) session.taskLauncher = m.taskLauncher;
    if (m.activeWorktree) session.activeWorktree = m.activeWorktree;
    if (Array.isArray(m.manualLinkedItems)) session.manualLinkedItems = m.manualLinkedItems;
    if (m.debateState) session.debateState = m.debateState;
    if (m.debateSetupMode) session.debateSetupMode = true;
    if (m.ownerId) session.ownerId = m.ownerId;
    session.mode = (m.mode === "tui" && session.vendor !== "codex") ? "tui" : "gui";
    session.dangerouslySkipPermissions = !!m.dangerouslySkipPermissions;
    session.terminalId = null;
    session.runtimeMode = null;
    session.runtimeTerminalId = null;
    session.sessionVisibility = m.sessionVisibility || "shared";
    session.bookmarked = !!m.bookmarked;
    session.favoriteOrder = typeof m.favoriteOrder === "number" ? m.favoriteOrder : null;
    session.titleManuallySet = !!m.titleManuallySet;
    session.titleAutoGenerated = !!m.titleAutoGenerated;
    sessions.set(localId, session);
    return session;
  }

  function parseSessionFile(filePath) {
    var content;
    try { content = fs.readFileSync(filePath, "utf8"); } catch (e) { return null; }
    var lines = content.trim().split("\n");
    if (lines.length === 0) return null;
    var meta;
    try { meta = JSON.parse(lines[0]); } catch (e) { return null; }
    if (meta.type !== "meta" || (!meta.cliSessionId && !meta.storageId)) return null;
    var history = [];
    for (var j = 1; j < lines.length; j++) {
      try { history.push(JSON.parse(lines[j])); } catch (e) {}
    }
    var migratedCount = relabelLegacyAutoContinueHistory(history);
    var fileMtime = 0;
    try { fileMtime = fs.statSync(filePath).mtimeMs; } catch (e) {}
    return { meta: meta, history: history, mtime: fileMtime, migrated: migratedCount > 0 };
  }

  function loadSessions() {
    var files;
    try { files = fs.readdirSync(sessionsDir); } catch (e) { return; }
    ensureCodexThreadIndex();

    for (var ti = 0; ti < files.length; ti++) {
      if (files[ti].indexOf(".tmp.") !== -1) {
        try { fs.unlinkSync(path.join(sessionsDir, files[ti])); } catch (e) {}
      }
    }

    var loaded = [];
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith(".jsonl")) continue;
      var parsed = parseSessionFile(path.join(sessionsDir, files[i]));
      if (parsed) loaded.push(parsed);
    }

    loaded.sort(function(a, b) { return a.meta.createdAt - b.meta.createdAt; });

    for (var li = 0; li < loaded.length; li++) {
      var m = loaded[li].meta;
      var session = hydrateSession(m, loaded[li].history, loaded[li].mtime);
      if (loaded[li].migrated || session.interruptedByRestart || (session.vendor || null) !== (m.vendor || null) || (session.cliSessionId || null) !== (m.cliSessionId || null) || (session.handoffContext && !m.handoffContext)) {
        saveSessionFile(session);
      }
    }
  }

  function adoptSessionFile(storageId) {
    if (!isValidCliSessionId(storageId)) return null;
    var parsed = parseSessionFile(sessionFilePath(storageId));
    if (!parsed) return null;
    ensureCodexThreadIndex();
    var session = hydrateSession(parsed.meta, parsed.history, parsed.mtime);
    return session.localId;
  }

  return {
    loadSessions: loadSessions,
    adoptSessionFile: adoptSessionFile,
  };
}

module.exports = {
  attachSessionLoader: attachSessionLoader,
};
