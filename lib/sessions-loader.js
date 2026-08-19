var fs = require("fs");
var historyStore = require("./sessions-history-store");
var coopChannels = require("./project-coop-channels");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;
var taskGraph = require("./orchestration-task-graph");
var path = require("path");
var sessionHistory = require("./sessions-history");
var projectIdentity = require("./project-identity");
var { shouldCloseCompletedSession } = require("./project-task-launcher-completion");

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
  var rebuildPendingUserMessageQueueFromHistory = ctx.rebuildPendingUserMessageQueueFromHistory;

  function isTurnBoundaryDone(item) {
    return item && item.type === "done";
  }

  function isTurnStartingHistoryItem(item) {
    if (!item || !item.type) return false;
    if (item.type === "user_message" && (item.queuedPending || item.coopIngressPending)) return false;
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

  function shouldArchiveCompletedTaskSession(session) {
    if (!session || session.hidden || !session.taskLauncher) return false;
    if (!session.taskLauncher.workflowCompleted) return false;
    var completion = session.taskLauncher.completion || {};
    return shouldCloseCompletedSession(session, completion);
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
    session._historyMutatedOnLoad = true;
  }

  function historicalProviderIds(history) {
    var ids = [];
    var seen = Object.create(null);
    for (var i = 0; i < history.length; i++) {
      var item = history[i];
      if (!item || typeof item !== "object") continue;
      var id = (item.type === "session_id" && item.cliSessionId) ||
        (item.type === "result" && item.sessionId) || null;
      if (id && !seen[id]) { seen[id] = true; ids.push(id); }
    }
    return ids;
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

  function hydrateCoordinationMetadata(session, metadata) {
    if (metadata.coordinationRole === "project_coordinator" ||
        metadata.coordinationRole === "task_coordinator") {
      session.coordinationRole = metadata.coordinationRole;
    }
    var projectCoordinatorRef = projectIdentity.normalizeSessionRef(
      metadata.projectCoordinatorRef);
    if (projectCoordinatorRef) session.projectCoordinatorRef = projectCoordinatorRef;
    if (metadata.coopIncarnation && typeof metadata.coopIncarnation === "object") {
      session.coopIncarnation = metadata.coopIncarnation;
    }
  }

  // The newest _ts in a transcript is the real end of the conversation. Reading
  // it here is free: the history is already in hand (and released again right
  // after), which is the same reason the provider-id scan below lives here.
  // Entries are normally chronological, but rewind and compaction can leave
  // them out of order, so take the maximum rather than the last one.
  function newestHistoryTimestamp(history) {
    if (!Array.isArray(history)) return 0;
    var newest = 0;
    for (var i = 0; i < history.length; i++) {
      var item = history[i];
      if (!item || typeof item !== "object") continue;
      var ts = item._ts;
      if (typeof ts === "number" && Number.isFinite(ts) && ts > newest) newest = ts;
    }
    return newest;
  }

  // Legacy session files predate persisted lastActivity, and the OS mtime is a
  // bad stand-in: one bulk save sweep rewrites every session file at once, so
  // hundreds of unrelated months-old sessions all end up stamped with the same
  // meaningless "just scanned" time and then sort as if they were closed today.
  // Recovering the transcript's own newest timestamp gives a truthful value that
  // is worth persisting; the mtime remains a last resort for transcripts that
  // carry no timestamp at all, and those stay flagged so a save cannot promote
  // the guess to authoritative.
  // An earlier round of this bug (owner report 2026-08-09) was fixed by
  // persisting lastActivity, but that fix ran a bulk save which wrote whatever
  // the mtime fallback had already fabricated -- laundering guesses into values
  // that now look authoritative. Measured across the owner's real store, the gap
  // between a persisted lastActivity and the transcript's own newest _ts is
  // either <= 0 (234 sessions) or under an hour (6, where the final entries
  // simply carried no _ts); the next observed gap is over a day (75 sessions,
  // the worst 60 days out). Nothing legitimate lands between 1h and 6h, so a
  // closed session whose stored timestamp sits hours past its own last recorded
  // activity is holding a laundered mtime, and its transcript is the better
  // source. Restricted to closed sessions: a live one can legitimately be active
  // now with no matching history entry yet.
  var LAUNDERED_ACTIVITY_MARGIN_MS = 6 * 60 * 60 * 1000;

  function resolveLastActivity(m, history, fileMtime) {
    var recovered = newestHistoryTimestamp(history);
    if (typeof m.lastActivity === "number") {
      if (m.hidden && recovered > 0 &&
          m.lastActivity - recovered > LAUNDERED_ACTIVITY_MARGIN_MS) {
        return { value: recovered, derived: false, repaired: true };
      }
      return { value: m.lastActivity, derived: false };
    }
    if (recovered > 0) return { value: recovered, derived: false };
    return { value: fileMtime || m.createdAt || Date.now(), derived: true };
  }

  function hydrateSession(m, history, fileMtime) {
    var localId = allocateLocalId();
    var resolvedActivity = resolveLastActivity(m, history, fileMtime);
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
      // Prefer the persisted, authoritative lastActivity; then the transcript's
      // own newest timestamp; then, only as a last resort, the file's OS mtime.
      lastActivity: resolvedActivity.value,
      closedAt: typeof m.closedAt === "number" ? m.closedAt : null,
      lastViewedAt: m.lastViewedAt || null,
      messageUUIDs: messageUuidsFromHistory(history),
      lastRewindUuid: m.lastRewindUuid || null,
    };
    if (resolvedActivity.derived) session._lastActivityDerived = true;
    if (resolvedActivity.repaired) session._lastActivityRepaired = true;
    historyStore.defineLazyHistory(session, history, reloadHistoryFromDisk);
    // adoptOrphanedCliSessions() needs the provider ids every session has ever
    // used, for every session, immediately after load. Derive them here while the
    // transcript is already in hand so that scan cannot page all of them back in.
    session._historicalProviderIds = historicalProviderIds(history);
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
    if (typeof m.historyMtime === "number") session._historyMtime = m.historyMtime;
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
    if (m.loop) session.loop = m.loop;
    if (m.taskLauncher) session.taskLauncher = m.taskLauncher;
    if (m.coopHome) session.coopHome = true;
    if (m.coopConversationIngress && typeof m.coopConversationIngress === "object") {
      session.coopConversationIngress = m.coopConversationIngress;
    }
    if (Array.isArray(m.pendingCoopIngress)) session.pendingCoopIngress = m.pendingCoopIngress;
    if (m.coopChannel) {
      session.coopChannel = coopChannels.normalizeChannelMetadata(m.coopChannel);
    }
    if (m.coordinationMode) session.coordinationMode = true;
    hydrateCoordinationMetadata(session, m);
    if (m.coopControlledBy) {
      var restoredControlledBy = normalizeControlledBy(m.coopControlledBy);
      if (restoredControlledBy) session.coopControlledBy = restoredControlledBy;
    }
    if (typeof m.coopReleasedToOwnerAt === "number") {
      session.coopReleasedToOwnerAt = m.coopReleasedToOwnerAt;
    }
    if (m.demoteCoordinatorWhenIdle) session.demoteCoordinatorWhenIdle = true;
    if (m.orchestrationGraphId) session.orchestrationGraphId = m.orchestrationGraphId;
    if (Array.isArray(m.orchestrationTasks)) session.orchestrationTasks = m.orchestrationTasks;
    if (Array.isArray(m.orchestrationEvents)) session.orchestrationEvents = m.orchestrationEvents;
    if (Array.isArray(m.liveUiReports)) session.liveUiReports = m.liveUiReports;
    if (m.orchestrationPolicy) session.orchestrationPolicy = m.orchestrationPolicy;
    if (m.orchestrationReconciliation) {
      session.orchestrationReconciliation = m.orchestrationReconciliation;
    }
    if (m.orchestrationProjectCompletion) {
      session.orchestrationProjectCompletion = m.orchestrationProjectCompletion;
    } else if (Array.isArray(m.orchestrationEvents)) {
      var recoveredCompletion = taskGraph.projectCompletionState(session);
      if (recoveredCompletion.completionRevision > 0) {
        session._orchestrationProjectCompletionRecovered = true;
      }
    }
    if (m.orchestrationParent) session.orchestrationParent = m.orchestrationParent;
    if (m.orchestrationAdoption) session.orchestrationAdoption = m.orchestrationAdoption;
    if (Array.isArray(m.pendingCoordinatorUpdates)) {
      session.pendingCoordinatorUpdates = m.pendingCoordinatorUpdates;
    }
    if (Array.isArray(m.pendingCoordinatorMessages)) {
      session.pendingCoordinatorMessages = m.pendingCoordinatorMessages;
    }
    if (m.hidden) session.hidden = true;
    if (shouldArchiveCompletedTaskSession(session)) {
      session.hidden = true;
      session._archivedCompletedTaskOnLoad = true;
    }
    if (m.activeWorktree) session.activeWorktree = m.activeWorktree;
    if (Array.isArray(m.manualLinkedItems)) session.manualLinkedItems = m.manualLinkedItems;
    if (m.debateState) session.debateState = m.debateState;
    if (m.debateSetupMode) session.debateSetupMode = true;
    if (m.ownerId) session.ownerId = m.ownerId;
    session.mode = (m.mode === "tui" && session.vendor !== "codex") ? "tui" : "gui";
    if (m.adopted) session.adopted = true;
    session.dangerouslySkipPermissions = !!m.dangerouslySkipPermissions;
    session.terminalId = null;
    session.runtimeMode = null;
    session.runtimeTerminalId = null;
    session.sessionVisibility = m.sessionVisibility || "shared";
    session.bookmarked = !!m.bookmarked;
    session.favoriteOrder = typeof m.favoriteOrder === "number" ? m.favoriteOrder : null;
    session.titleManuallySet = !!m.titleManuallySet;
    session.titleAutoGenerated = !!m.titleAutoGenerated;
    if (typeof rebuildPendingUserMessageQueueFromHistory === "function") {
      rebuildPendingUserMessageQueueFromHistory(session);
    }
    sessions.set(localId, session);
    return session;
  }

  // Applied to every transcript on the way in, whether it is being read at boot
  // or re-read later by the lazy accessor. Both paths must agree or a released
  // and reloaded session would behave differently from a freshly loaded one.
  function normalizeLoadedHistory(history) {
    for (var hi = 0; hi < history.length; hi++) {
      var item = history[hi];
      if (item && item.synthetic && item.origin && item.origin.kind === "task-notification") {
        item.internalOnly = true;
      }
    }
    return relabelLegacyAutoContinueHistory(history) > 0;
  }

  function parseMetaLine(line) {
    var meta;
    try { meta = JSON.parse(line); } catch (e) { return null; }
    if (!meta || meta.type !== "meta" || (!meta.cliSessionId && !meta.storageId)) return null;
    return meta;
  }

  // Reads only the first line. Boot uses this to order sessions by createdAt
  // without holding every transcript in memory at once to do it.
  function readSessionMeta(filePath) {
    var fd;
    try { fd = fs.openSync(filePath, "r"); } catch (e) { return null; }
    try {
      var chunk = Buffer.allocUnsafe(64 * 1024);
      var text = "";
      while (true) {
        var read = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (read <= 0) break;
        text += chunk.toString("utf8", 0, read);
        var nl = text.indexOf("\n");
        if (nl !== -1) return parseMetaLine(text.slice(0, nl));
        // A meta line is small; anything this long means the file is not one.
        if (text.length > 32 * 1024 * 1024) return null;
      }
      return text ? parseMetaLine(text) : null;
    } finally {
      try { fs.closeSync(fd); } catch (e) {}
    }
  }

  function parseSessionFile(filePath) {
    var content;
    try { content = fs.readFileSync(filePath, "utf8"); } catch (e) { return null; }
    var lines = content.trim().split("\n");
    if (lines.length === 0) return null;
    var meta = parseMetaLine(lines[0]);
    if (!meta) return null;
    var history = [];
    for (var j = 1; j < lines.length; j++) {
      try { history.push(JSON.parse(lines[j])); } catch (e) {}
    }
    var migrated = normalizeLoadedHistory(history);
    var fileMtime = 0;
    try { fileMtime = fs.statSync(filePath).mtimeMs; } catch (e) {}
    return { meta: meta, history: history, mtime: fileMtime, migrated: migrated };
  }

  // The lazy accessor's re-read. Returns null (rather than an empty array) when
  // the file cannot be read, so the store knows not to cache the result.
  function reloadHistoryFromDisk(session) {
    var storageId = session && (session.storageId || session.cliSessionId);
    if (!storageId) return null;
    var content;
    try { content = fs.readFileSync(sessionFilePath(storageId), "utf8"); } catch (e) {
      console.error("[session] Could not re-read history for session " + session.localId +
        " (" + storageId + "): " + e.message);
      return null;
    }
    var lines = content.trim().split("\n");
    var history = [];
    for (var j = 1; j < lines.length; j++) {
      try { history.push(JSON.parse(lines[j])); } catch (e) {}
    }
    normalizeLoadedHistory(history);
    return history;
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

    // Order by createdAt from the meta line alone. Parsing every transcript up
    // front just to sort them is what made startup memory scale with total
    // history volume; only one transcript is resident below.
    var ordered = [];
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith(".jsonl")) continue;
      var filePath = path.join(sessionsDir, files[i]);
      var meta = readSessionMeta(filePath);
      if (meta) ordered.push({ file: filePath, createdAt: meta.createdAt || 0 });
    }
    ordered.sort(function (a, b) { return a.createdAt - b.createdAt; });

    var activityRecovered = 0;
    var activityRepaired = 0;
    for (var li = 0; li < ordered.length; li++) {
      var parsed = parseSessionFile(ordered[li].file);
      if (!parsed) continue;
      var m = parsed.meta;
      var session = hydrateSession(m, parsed.history, parsed.mtime);
      // Recovering a timestamp is only half the repair: without persisting it,
      // every boot re-derives it and the picker keeps showing whatever the last
      // bulk save left behind.
      var activityNeedsSave = session._lastActivityRepaired ||
        (typeof m.lastActivity !== "number" && !session._lastActivityDerived);
      if (session._lastActivityRepaired) activityRepaired++;
      else if (activityNeedsSave) activityRecovered++;
      if (parsed.migrated || session._historyMutatedOnLoad ||
          session._archivedCompletedTaskOnLoad ||
          session._orchestrationProjectCompletionRecovered ||
          activityNeedsSave ||
          (session.interruptedByRestart && !m.interruptedByRestart) ||
          (session.vendor || null) !== (m.vendor || null) ||
          (session.cliSessionId || null) !== (m.cliSessionId || null) ||
          (session.handoffContext && !m.handoffContext)) {
        delete session._archivedCompletedTaskOnLoad;
        delete session._orchestrationProjectCompletionRecovered;
        delete session._lastActivityRepaired;
        saveSessionFile(session);
      }
      // Everything derived from this transcript is now on the session, and any
      // load-time mutation is on disk. Drop it; the accessor re-reads on demand.
      delete session._historyMutatedOnLoad;
      historyStore.release(session);
    }
    // One-time by construction: once persisted, the stored value matches the
    // transcript and neither branch retriggers. A non-zero count on a later boot
    // means something is still fabricating timestamps.
    if (activityRecovered > 0 || activityRepaired > 0) {
      console.log("[sessions][activity-repair] recovered " + activityRecovered +
        " missing and corrected " + activityRepaired +
        " laundered lastActivity timestamp(s) from transcripts for " + sessionsDir);
    }
  }

  function adoptSessionFile(storageId) {
    if (!isValidCliSessionId(storageId)) return null;
    var parsed = parseSessionFile(sessionFilePath(storageId));
    if (!parsed) return null;
    ensureCodexThreadIndex();
    var session = hydrateSession(parsed.meta, parsed.history, parsed.mtime);
    if (session._archivedCompletedTaskOnLoad ||
        session._orchestrationProjectCompletionRecovered) {
      delete session._archivedCompletedTaskOnLoad;
      delete session._orchestrationProjectCompletionRecovered;
      saveSessionFile(session);
    }
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
