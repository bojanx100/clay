var fs = require("fs");
var coopChannels = require("./project-coop-channels");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;
var config = require("./config");

function attachSessionPersistence(ctx) {
  var getSessionStorageId = ctx.getSessionStorageId;
  var sessionFilePath = ctx.sessionFilePath;
  var sendEach = ctx.sendEach;

  var SAVE_COALESCE_MS = 150;
  var SAVE_HEAVY_MS = 25;
  var SAVE_HEAVY_BYTES = 512 * 1024;

  // Stamp closedAt exactly once, the moment a session first becomes hidden
  // (closed), regardless of which call site set session.hidden = true. This
  // is the single authoritative "closed" timestamp: it is never overwritten
  // by later scans/saves/retries, so re-hiding an already-hidden session
  // (idempotent retries) or unrelated bulk saves cannot corrupt it.
  function stampClosedAtIfNeeded(session) {
    if (session.hidden && typeof session.closedAt !== "number") {
      session.closedAt = Date.now();
    }
  }

  function usableSession(session, durable) {
    if (session && !session._deleted) return true;
    if (durable) throw new Error("Durable session save requires a live session.");
    return false;
  }

  function storageIdForSave(session, durable) {
    var storageId = getSessionStorageId(session);
    if (storageId) return storageId;
    if (durable) throw new Error("Durable session save requires a storage id.");
    return null;
  }

  function shouldCoalesce(session, durable, now) {
    var heavy = (session._lastSaveDurMs || 0) >= SAVE_HEAVY_MS ||
      (session._lastSaveBytes || 0) >= SAVE_HEAVY_BYTES;
    return !durable && heavy && session._lastSaveAt && now - session._lastSaveAt < SAVE_COALESCE_MS;
  }

  function persistCoordinationMetadata(metaObj, session) {
    if (session.coordinationRole) metaObj.coordinationRole = session.coordinationRole;
    if (session.projectCoordinatorRef) metaObj.projectCoordinatorRef = session.projectCoordinatorRef;
    if (session.coopIncarnation) metaObj.coopIncarnation = session.coopIncarnation;
  }

  function saveSessionFile(session, options) {
    var durable = options && options.durable === true;
    if (!usableSession(session, durable) || !storageIdForSave(session, durable)) return;
    stampClosedAtIfNeeded(session);
    var now = Date.now();
    if (shouldCoalesce(session, durable, now)) {
      if (!session._saveCoalesceTimer) {
        var t = setTimeout(function () {
          session._saveCoalesceTimer = null;
          if (session._deleted) return;
          writeSessionFileNow(session, false);
        }, SAVE_COALESCE_MS);
        if (t.unref) t.unref();
        session._saveCoalesceTimer = t;
      }
      return;
    }
    if (durable && session._saveCoalesceTimer) {
      clearTimeout(session._saveCoalesceTimer);
      session._saveCoalesceTimer = null;
    }
    return writeSessionFileNow(session, durable);
  }

  function writeSessionFileNow(session, throwOnFailure) {
    var storageId = getSessionStorageId(session);
    if (!storageId) {
      if (throwOnFailure) throw new Error("Durable session save requires a storage id.");
      return false;
    }
    session._lastSaveAt = Date.now();
    try {
      var metaObj = {
        type: "meta",
        cliSessionId: session.cliSessionId || null,
        storageId: storageId,
        title: session.title,
        createdAt: session.createdAt,
      };
      // lastActivity/closedAt are authoritative lifecycle timestamps. They
      // must be persisted explicitly rather than reconstructed from the
      // storage file's OS mtime on reload: any unrelated save (orchestrator
      // completion, coop channel update, etc.) rewrites this file and would
      // otherwise stamp an unrelated session with a fabricated "now" time
      // (owner report 2026-08-09: many closed sessions showing the
      // identical corrupted closed date after such a bulk rewrite).
      if (typeof session.lastActivity === "number") metaObj.lastActivity = session.lastActivity;
      if (typeof session.closedAt === "number") metaObj.closedAt = session.closedAt;
      if (session.lastViewedAt) metaObj.lastViewedAt = session.lastViewedAt;
      if (session.ownerId) metaObj.ownerId = session.ownerId;
      if (session.vendor) metaObj.vendor = session.vendor;
      if (session.providerRouteId) metaObj.providerRouteId = session.providerRouteId;
      if (session.model) metaObj.model = session.model;
      if (session.verifiedModel) metaObj.verifiedModel = session.verifiedModel;
      if (session.requestedModel) metaObj.requestedModel = session.requestedModel;
      if (session.modelVerificationSource) metaObj.modelVerificationSource = session.modelVerificationSource;
      if (session.automationMode) metaObj.automationMode = session.automationMode;
      if (session.permissionMode) metaObj.permissionMode = session.permissionMode;
      if (session.codexApproval) metaObj.codexApproval = session.codexApproval;
      if (session.codexSandbox) metaObj.codexSandbox = session.codexSandbox;
      if (session.codexWebSearch) metaObj.codexWebSearch = session.codexWebSearch;
      if (session.handoffContext) metaObj.handoffContext = session.handoffContext;
      if (typeof session.handoffContextTurnsRemaining === "number") metaObj.handoffContextTurnsRemaining = session.handoffContextTurnsRemaining;
      if (session.handoffContextRecovered) metaObj.handoffContextRecovered = true;
      if (session.handoffContextConsumed) metaObj.handoffContextConsumed = true;
      if (session.copilotHandoffNativeReset) metaObj.copilotHandoffNativeReset = true;
      if (session.mode === "tui") metaObj.mode = "tui";
      if (session.dangerouslySkipPermissions) metaObj.dangerouslySkipPermissions = true;
      if (session.sessionVisibility) metaObj.sessionVisibility = session.sessionVisibility;
      if (session.bookmarked) metaObj.bookmarked = true;
      if (session.hidden) metaObj.hidden = true;
      if (typeof session.favoriteOrder === "number") metaObj.favoriteOrder = session.favoriteOrder;
      if (session.titleManuallySet) metaObj.titleManuallySet = true;
      if (session.titleAutoGenerated) metaObj.titleAutoGenerated = true;
      if (session.lastRewindUuid) metaObj.lastRewindUuid = session.lastRewindUuid;
      if (session.interruptedByRestart) metaObj.interruptedByRestart = true;
      if (session._consecutiveAutoResumes) metaObj.consecutiveAutoResumes = session._consecutiveAutoResumes;
      // Persist the rollout-hydration marker. prepareCodexSessionForView only
      // refreshes history from the rollout when this is set (so live-recorded
      // transcripts are never flattened); without persistence, an IMPORTED
      // session loses the marker on daemon restart and then never syncs new
      // rollout messages again.
      if (typeof session._historyMtime === "number" && session._historyMtime > 0) metaObj.historyMtime = session._historyMtime;
      if (session.compactedFromLocalId) metaObj.compactedFromLocalId = session.compactedFromLocalId;
      if (session.compactedFromStorageId) metaObj.compactedFromStorageId = session.compactedFromStorageId;
      if (session.compactedFromCliSessionId) metaObj.compactedFromCliSessionId = session.compactedFromCliSessionId;
      if (session.compactedIntoLocalId) metaObj.compactedIntoLocalId = session.compactedIntoLocalId;
      if (session.compactedAt) metaObj.compactedAt = session.compactedAt;
      if (typeof session.compactionDepth === "number") metaObj.compactionDepth = session.compactionDepth;
      if (session.loop) metaObj.loop = session.loop;
      if (session.taskLauncher) metaObj.taskLauncher = session.taskLauncher;
      if (session.coopHome) metaObj.coopHome = true;
      if (session.coopConversationIngress) {
        metaObj.coopConversationIngress = session.coopConversationIngress;
      }
      if (Array.isArray(session.pendingCoopIngress) && session.pendingCoopIngress.length) {
        metaObj.pendingCoopIngress = session.pendingCoopIngress;
      }
      if (session.coopChannel) {
        metaObj.coopChannel = coopChannels.normalizeChannelMetadata(session.coopChannel);
      }
      if (session.coordinationMode) metaObj.coordinationMode = true;
      persistCoordinationMetadata(metaObj, session);
      if (session.coopControlledBy) {
        var normalizedControlledBy = normalizeControlledBy(session.coopControlledBy);
        if (normalizedControlledBy) metaObj.coopControlledBy = normalizedControlledBy;
      }
      if (session.demoteCoordinatorWhenIdle) metaObj.demoteCoordinatorWhenIdle = true;
      if (session.orchestrationGraphId) metaObj.orchestrationGraphId = session.orchestrationGraphId;
      if (Array.isArray(session.orchestrationTasks)) metaObj.orchestrationTasks = session.orchestrationTasks;
      if (Array.isArray(session.orchestrationEvents)) metaObj.orchestrationEvents = session.orchestrationEvents;
      if (Array.isArray(session.liveUiReports)) metaObj.liveUiReports = session.liveUiReports;
      if (session.orchestrationPolicy) metaObj.orchestrationPolicy = session.orchestrationPolicy;
      if (session.orchestrationReconciliation) {
        metaObj.orchestrationReconciliation = session.orchestrationReconciliation;
      }
      if (session.orchestrationProjectCompletion) {
        metaObj.orchestrationProjectCompletion = session.orchestrationProjectCompletion;
      }
      if (session.orchestrationParent) metaObj.orchestrationParent = session.orchestrationParent;
      if (session.orchestrationAdoption) metaObj.orchestrationAdoption = session.orchestrationAdoption;
      if (Array.isArray(session.pendingCoordinatorUpdates) &&
          session.pendingCoordinatorUpdates.length) {
        metaObj.pendingCoordinatorUpdates = session.pendingCoordinatorUpdates;
      }
      if (Array.isArray(session.pendingCoordinatorMessages) &&
          session.pendingCoordinatorMessages.length) {
        metaObj.pendingCoordinatorMessages = session.pendingCoordinatorMessages;
      }
      if (session.activeWorktree) metaObj.activeWorktree = session.activeWorktree;
      if (session.manualLinkedItems && session.manualLinkedItems.length) metaObj.manualLinkedItems = session.manualLinkedItems;
      if (session.debateState) metaObj.debateState = session.debateState;
      if (session.debateSetupMode) metaObj.debateSetupMode = true;
      var meta = JSON.stringify(metaObj);
      var lines = [meta];
      for (var i = 0; i < session.history.length; i++) {
        lines.push(JSON.stringify(session.history[i]));
      }
      var sfPath = sessionFilePath(storageId);
      var tmpPath = sfPath + ".tmp." + process.pid;
      var _saveT0 = Date.now();
      var _payload = lines.join("\n") + "\n";
      fs.writeFileSync(tmpPath, _payload);
      if (process.platform !== "win32") {
        try { fs.chmodSync(tmpPath, 0o600); } catch (chmodErr) {}
      }
      fs.renameSync(tmpPath, sfPath);
      var _saveMs = Date.now() - _saveT0;
      session._lastSaveDurMs = _saveMs;
      session._lastSaveBytes = _payload.length;
      if (_saveMs >= 200) {
        var _saveLine = "[SAVE-SLOW] " + new Date().toISOString() + " saveSessionFile localId=" + session.localId + " items=" + session.history.length + " bytes=" + _payload.length + " took=" + _saveMs + "ms";
        console.warn(_saveLine);
        config.diagLog(_saveLine);
      }
      return true;
    } catch(e) {
      console.error("[session] Failed to save session file:", e.message);
      if (throwOnFailure) throw e;
      return false;
    }
  }

  function appendToSessionFile(session, obj) {
    var storageId = getSessionStorageId(session);
    if (!storageId) return;
    if (!session._suppressActivityBump) session.lastActivity = Date.now();
    if (sendEach) {
      var _hwm = session.history.length;
      sendEach(function (ws) {
        if (ws.readyState === 1 && ws._clayActiveSession === session.localId) {
          ws._clayDeliveredLen = _hwm;
        }
      });
    }
    try {
      var afPath = sessionFilePath(storageId);
      fs.appendFileSync(afPath, JSON.stringify(obj) + "\n");
      if (process.platform !== "win32") {
        try { fs.chmodSync(afPath, 0o600); } catch (chmodErr) {}
      }
    } catch(e) {
      console.error("[session] Failed to append to session file:", e.message);
    }
  }

  return {
    saveSessionFile: saveSessionFile,
    appendToSessionFile: appendToSessionFile,
  };
}

module.exports = {
  attachSessionPersistence: attachSessionPersistence,
};
