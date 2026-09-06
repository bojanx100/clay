var fs = require("fs");
var historyStore = require("./sessions-history-store");
var coopChannels = require("./project-coop-channels");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;
var taskGraph = require("./orchestration-task-graph");
var path = require("path");
var historyAnalysis = require("./sessions-loader-history");
var projectIdentity = require("./project-identity");
var { shouldCloseCompletedSession } = require("./project-task-launcher-completion");
var metadataFingerprint = require("./sessions-persistence").metadataFingerprint;
var createStartupCache = require("./sessions-startup-cache").createSessionsStartupCache;

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
  var viewState = ctx.viewState;
  var startupCache = createStartupCache(sessionsDir);

  function shouldArchiveCompletedTaskSession(session) {
    if (!session || session.hidden || !session.taskLauncher) return false;
    if (!session.taskLauncher.workflowCompleted) return false;
    var completion = session.taskLauncher.completion || {};
    return shouldCloseCompletedSession(session, completion);
  }

  function markRestartInterruptedSession(session) {
    if (!session || session.interruptedByRestart) return;
    session.interruptedByRestart = true;
    var stalledTs = historyAnalysis.lastTimestamp(session.history) || Date.now();
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

  function hydrateSession(m, history, fileMtime, summary) {
    var localId = allocateLocalId();
    var resolvedActivity = summary ? {
      value: summary.lastActivity,
      derived: !!summary.lastActivityDerived,
    } : historyAnalysis.resolveLastActivity(m, history, fileMtime);
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
      lastViewedAt: viewState
        ? viewState.get(m.storageId || m.cliSessionId, m.lastViewedAt || null)
        : (m.lastViewedAt || null),
      messageUUIDs: summary ? (summary.messageUUIDs || []) : historyAnalysis.messageUuids(history),
      lastRewindUuid: m.lastRewindUuid || null,
    };
    if (resolvedActivity.derived) session._lastActivityDerived = true;
    if (resolvedActivity.repaired) session._lastActivityRepaired = true;
    historyStore.defineLazyHistory(session, history, reloadHistoryFromDisk);
    Object.defineProperty(session, "_readPersistedHistoryRange", {
      configurable: true,
      enumerable: false,
      value: function (fromIndex, toIndex) {
        return readHistoryRangeFromDisk(session, fromIndex, toIndex);
      },
    });
    // adoptOrphanedCliSessions() needs the provider ids every session has ever
    // used, for every session, immediately after load. Derive them here while the
    // transcript is already in hand so that scan cannot page all of them back in.
    session._historicalProviderIds = summary
      ? (summary.historicalProviderIds || [])
      : historyAnalysis.historicalProviderIds(history);
    // The transcript is authoritative. interruptedByRestart in metadata is a
    // derived marker and can outlive the interrupted turn after an ordinary
    // later user message succeeds. Trusting that stale bit forever prevents
    // the session from entering the startup cache on every subsequent boot.
    var hasPersistedRestartInterruption = !summary &&
      historyAnalysis.hasUncontinuedRestartInterruption(session.history);
    var pendingRestartInterruptedAt = !summary &&
      historyAnalysis.pendingRestartInterruptionTimestamp(session.history);
    if (hasPersistedRestartInterruption) session.interruptedByRestart = true;
    if (summary && summary.interruptedByRestart) session.interruptedByRestart = true;
    if (pendingRestartInterruptedAt) {
      session.restartResumeEligible = true;
      session.restartInterruptedAt = pendingRestartInterruptedAt;
    }
    if (!summary && historyAnalysis.hasInterruptedTurn(session.history)) {
      markRestartInterruptedSession(session);
      session.restartResumeEligible = true;
      if (!session.restartInterruptedAt) {
        session.restartInterruptedAt = historyAnalysis.lastTimestamp(session.history) || Date.now();
      }
    }
    if (m.vendor) session.vendor = m.vendor;
    if (m.providerRouteId) session.providerRouteId = m.providerRouteId;
    if (m.model) session.model = m.model;
    if (m.effort) session.effort = m.effort;
    if (m.verifiedModel) session.verifiedModel = m.verifiedModel;
    if (m.requestedModel) session.requestedModel = m.requestedModel;
    if (m.modelVerificationSource) session.modelVerificationSource = m.modelVerificationSource;
    if (summary && summary.vendor) session.vendor = summary.vendor;
    if (summary && summary.providerRouteId) session.providerRouteId = summary.providerRouteId;
    if (summary && summary.model) session.model = summary.model;
    if (summary && summary.cliSessionId) session.cliSessionId = summary.cliSessionId;
    var inferredVendor = summary ? null : inferCurrentVendorFromHistory(session.history, session.vendor || null);
    if (inferredVendor) session.vendor = inferredVendor;
    var inferredProviderRouteId = summary ? null : inferCurrentProviderRouteFromHistory(session.history, session.providerRouteId || null);
    if (inferredProviderRouteId) session.providerRouteId = inferredProviderRouteId;
    var inferredModel = summary ? null : inferCurrentModelFromHistory(session.history, session.model || null);
    if (inferredModel) session.model = inferredModel;
    var inferredCliSessionId = summary ? null : inferCliSessionIdAfterLastHandoff(session.history);
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
    if (typeof m.historyFormatVersion === "number") session._historyFormatVersion = m.historyFormatVersion;
    if (m.handoffContext) session.handoffContext = m.handoffContext;
    if (m.handoff) session.handoff = m.handoff;
    if (typeof m.handoffContextTurnsRemaining === "number") session.handoffContextTurnsRemaining = m.handoffContextTurnsRemaining;
    if (m.handoffContextRecovered) session.handoffContextRecovered = true;
    if (m.handoffContextConsumed) session.handoffContextConsumed = true;
    if (m.copilotHandoffNativeReset) session.copilotHandoffNativeReset = true;
    if (summary && summary.handoffContextRecovered) session.handoffContextRecovered = true;
    if (summary && summary.handoffContextConsumed) session.handoffContextConsumed = true;
    if (summary && summary.copilotHandoffNativeReset) session.copilotHandoffNativeReset = true;
    if (!summary && session.handoffContext && hasVendorResponseSinceLastSwitch(session.history)) {
      session.handoffContext = null;
      session.handoffContextTurnsRemaining = 0;
      session.handoffContextConsumed = true;
    }
    if (!summary && !session.handoffContext && !session.handoffContextConsumed && shouldRecoverMissingHandoffContext(session) && (!session.handoffContextRecovered || session.handoffContextTurnsRemaining <= 0)) {
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
    if (!summary && typeof rebuildPendingUserMessageQueueFromHistory === "function") {
      rebuildPendingUserMessageQueueFromHistory(session);
    } else if (summary) {
      session.pendingUserMessageQueue = [];
    }
    sessions.set(localId, session);
    return session;
  }

  // Applied to every transcript on the way in, whether it is being read at boot
  // or re-read later by the lazy accessor. Both paths must agree or a released
  // and reloaded session would behave differently from a freshly loaded one.
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
    var migrated = historyAnalysis.normalizeLoadedHistory(history);
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
    historyAnalysis.normalizeLoadedHistory(history);
    return history;
  }

  // Read a recent canonical event range without allocating the whole JSONL.
  // The caller supplies the persisted parsed-event count, so walking backward
  // from EOF makes initial replay proportional to the requested page.
  function readHistoryRangeFromDisk(session, fromIndex, toIndex) {
    var storageId = session && (session.storageId || session.cliSessionId);
    // The count of records actually ON DISK. Deltas are coalesced on write, so
    // the in-memory history length overcounts the file; indexing backward from
    // EOF with it computes a negative start and refuses the read.
    var total = session && (Number.isInteger(session._persistedDiskRecords)
      ? session._persistedDiskRecords
      : session._persistedHistoryLength);
    if (!storageId || !Number.isInteger(total)) return null;
    var from = Math.max(0, Math.min(total, Math.floor(fromIndex)));
    var to = Math.max(from, Math.min(total, Math.floor(toIndex)));
    if (from === to) return [];
    var neededFromEnd = total - from;
    var filePath = sessionFilePath(storageId);
    var fd;
    try { fd = fs.openSync(filePath, "r"); } catch (e) { return null; }
    try {
      var stat = fs.fstatSync(fd);
      var position = stat.size;
      var prefix = "";
      var lines = [];
      var chunkSize = 64 * 1024;
      while (position > 0 && lines.length < neededFromEnd) {
        var size = Math.min(chunkSize, position);
        position -= size;
        var chunk = Buffer.allocUnsafe(size);
        var read = fs.readSync(fd, chunk, 0, size, position);
        var parts = (chunk.toString("utf8", 0, read) + prefix).split("\n");
        prefix = parts.shift();
        if (parts.length && parts[parts.length - 1] === "") parts.pop();
        lines = parts.concat(lines);
      }
      if (position === 0 && prefix) lines.unshift(prefix);
      var start = lines.length - (total - from);
      var end = lines.length - (total - to);
      if (start < 0 || end < start || end > lines.length) return null;
      var history = [];
      for (var i = start; i < end; i++) {
        var item;
        try { item = JSON.parse(lines[i]); } catch (e) { return null; }
        if (!item || item.type === "meta") return null;
        history.push(item);
      }
      historyAnalysis.normalizeLoadedHistory(history);
      return history;
    } finally {
      try { fs.closeSync(fd); } catch (e) {}
    }
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
      if (meta) {
        var stat = null;
        try { stat = fs.statSync(filePath); } catch (e) {}
        ordered.push({ file: filePath, meta: meta, stat: stat, createdAt: meta.createdAt || 0 });
      }
    }
    ordered.sort(function (a, b) { return a.createdAt - b.createdAt; });

    var activityRecovered = 0;
    var activityRepaired = 0;
    for (var li = 0; li < ordered.length; li++) {
      var cachedMeta = ordered[li].meta;
      var cachedStorageId = cachedMeta.storageId || cachedMeta.cliSessionId;
      // Visibility is a presentation choice, not a liveness signal. Any
      // unchanged settled session has the same safe derived-state summary;
      // interrupted, queued and handoff sessions are excluded at capture time.
      var summary = startupCache.lookup(cachedStorageId, ordered[li].stat);
      if (summary) {
        var cachedSession = hydrateSession(cachedMeta, [], ordered[li].stat.mtimeMs, summary);
        cachedSession._persistedHistoryLength = summary.historyLength;
        cachedSession._persistedDiskRecords = summary.historyLength;
        cachedSession._persistedMetaFingerprint = metadataFingerprint(cachedMeta, true);
        historyStore.release(cachedSession);
        continue;
      }
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
      var needsSave = parsed.migrated || session._historyMutatedOnLoad ||
          session._archivedCompletedTaskOnLoad ||
          session._orchestrationProjectCompletionRecovered ||
          activityNeedsSave ||
          (session.interruptedByRestart && !m.interruptedByRestart) ||
          (session.vendor || null) !== (m.vendor || null) ||
          (session.cliSessionId || null) !== (m.cliSessionId || null) ||
          (session.handoffContext && !m.handoffContext);
      if (needsSave) {
        delete session._archivedCompletedTaskOnLoad;
        delete session._orchestrationProjectCompletionRecovered;
        delete session._lastActivityRepaired;
        saveSessionFile(session);
      } else {
        session._persistedHistoryLength = parsed.history.length;
        // Freshly parsed from disk, so in-memory and on-disk agree exactly here.
        session._persistedDiskRecords = parsed.history.length;
        session._persistedMetaFingerprint = metadataFingerprint(m, true);
      }
      // Everything derived from this transcript is now on the session, and any
      // load-time mutation is on disk. Drop it; the accessor re-reads on demand.
      delete session._historyMutatedOnLoad;
      var currentStat = null;
      try { currentStat = fs.statSync(ordered[li].file); } catch (e) {}
      startupCache.capture(session, currentStat,
        session._persistedHistoryLength || parsed.history.length, parsed.meta);
      historyStore.release(session);
    }
    startupCache.flush();
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
