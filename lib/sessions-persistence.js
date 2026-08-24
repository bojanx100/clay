var fs = require("fs");
var coopChannels = require("./project-coop-channels");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;
var config = require("./config");
var historyStore = require("./sessions-history-store");

var SAVE_WRITE_CHUNK_CHARS = 128 * 1024;

// Truthy marker: saveSessionFile coalesced the write into a pending timer.
var SAVE_QUEUED = "queued";

function collectSessions(target) {
  var source = (target && target.sessions) || target;
  var list = [];
  if (source && typeof source.forEach === "function") {
    source.forEach(function (session) { list.push(session); });
  }
  return list;
}

// Synchronously complete every coalesced save still sitting in an unref'd timer.
// The daemon must call this from gracefulShutdown: an unref'd timer never fires
// on SIGTERM, so the last turn of a heavy session would be silently dropped.
// Accepts a session manager (anything with a `.sessions` Map) or a Map/array of
// sessions. Timers are always cleared, but deleted sessions are never written
// back (their files must not be resurrected). Returns the number written.
function flushPendingCoalescedSaves(target) {
  var sessions = collectSessions(target);
  var written = 0;
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    if (!session || !session._saveCoalesceTimer) continue;
    clearTimeout(session._saveCoalesceTimer);
    session._saveCoalesceTimer = null;
    var flush = session._saveCoalesceFlush;
    session._saveCoalesceFlush = null;
    if (session._deleted || typeof flush !== "function") continue;
    if (flush()) written++;
  }
  return written;
}

function writeBufferFullySync(fd, buffer) {
  var offset = 0;
  while (offset < buffer.length) {
    var written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (!written) throw new Error("Session file write made no progress.");
    offset += written;
  }
}

// Streaming deltas are recorded one chunk at a time, so a long turn lands
// hundreds of ~50-byte lines that only differ by their timestamp. They are not
// redundant -- they hold the assistant's text -- but a contiguous run of them
// is exactly equivalent to one delta holding the joined text, and the per-line
// JSON framing costs more than the payload. The Coop transcript reached 218k
// items / 42MB this way, which is parsed into the heap on every startup.
//
// Only a run with the exact recorded shape is merged, so a delta that ever
// carries another field is written through untouched rather than silently
// losing it.
function mergeableDelta(entry) {
  if (!entry || entry.type !== "delta" || typeof entry.text !== "string") return false;
  var keys = Object.keys(entry);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] !== "type" && keys[i] !== "text" && keys[i] !== "_ts") return false;
  }
  return true;
}

function startedDeltaRun(entry) {
  var merged = { type: "delta", text: entry.text };
  if (entry._ts !== undefined) merged._ts = entry._ts;
  return merged;
}

function writeSessionJsonlSync(tmpPath, meta, history) {
  var fd = fs.openSync(tmpPath, "w", 0o600);
  var chunkLines = [];
  var chunkChars = 0;
  var bytesWritten = 0;

  function flushChunk() {
    if (!chunkLines.length) return;
    var buffer = Buffer.from(chunkLines.join(""), "utf8");
    writeBufferFullySync(fd, buffer);
    bytesWritten += buffer.length;
    chunkLines = [];
    chunkChars = 0;
  }

  function appendLine(line) {
    if (chunkChars && chunkChars + line.length > SAVE_WRITE_CHUNK_CHARS) flushChunk();
    chunkLines.push(line);
    chunkChars += line.length;
    if (chunkChars >= SAVE_WRITE_CHUNK_CHARS) flushChunk();
  }

  try {
    appendLine(meta + "\n");
    // Coalescing happens only on the way to disk. session.history keeps its
    // original entries, so live delivery high-water marks and every index held
    // by a connected client stay valid for the lifetime of the session.
    var pendingDelta = null;
    for (var i = 0; i < history.length; i++) {
      var entry = history[i];
      if (mergeableDelta(entry)) {
        if (pendingDelta) pendingDelta.text += entry.text;
        else pendingDelta = startedDeltaRun(entry);
        continue;
      }
      if (pendingDelta) {
        appendLine(JSON.stringify(pendingDelta) + "\n");
        pendingDelta = null;
      }
      appendLine(JSON.stringify(entry) + "\n");
    }
    if (pendingDelta) appendLine(JSON.stringify(pendingDelta) + "\n");
    flushChunk();
  } finally {
    fs.closeSync(fd);
  }
  return bytesWritten;
}

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

  // Return contract (never undefined): truthy means "written or durably
  // queued", false means "this save will not happen".
  //   true         written to disk by this call.
  //   SAVE_QUEUED  coalesced: a timer will write it, and
  //                flushPendingCoalescedSaves() writes it on shutdown.
  //   false        skipped (no live session / no storage id) or the write
  //                failed (see the [SAVE-FAIL] diag marker).
  // Durable saves never queue: they return true or throw.
  function saveSessionFile(session, options) {
    var durable = options && options.durable === true;
    if (!usableSession(session, durable) || !storageIdForSave(session, durable)) return false;
    stampClosedAtIfNeeded(session);
    var now = Date.now();
    if (shouldCoalesce(session, durable, now)) {
      if (!session._saveCoalesceTimer) {
        var t = setTimeout(function () {
          session._saveCoalesceTimer = null;
          session._saveCoalesceFlush = null;
          if (session._deleted) return;
          writeSessionFileNow(session, false);
        }, SAVE_COALESCE_MS);
        if (t.unref) t.unref();
        session._saveCoalesceTimer = t;
        // Carried on the session so flushPendingCoalescedSaves() can complete a
        // pending save from outside this closure (e.g. daemon shutdown).
        session._saveCoalesceFlush = function () {
          return writeSessionFileNow(session, false);
        };
      }
      return SAVE_QUEUED;
    }
    if (durable && session._saveCoalesceTimer) {
      clearTimeout(session._saveCoalesceTimer);
      session._saveCoalesceTimer = null;
      session._saveCoalesceFlush = null;
    }
    return writeSessionFileNow(session, durable);
  }

  function writeSessionFileNow(session, throwOnFailure) {
    var storageId = getSessionStorageId(session);
    if (!storageId) {
      if (throwOnFailure) throw new Error("Durable session save requires a storage id.");
      return false;
    }
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
      // A value the loader had to guess from the OS mtime is not authoritative,
      // so persisting it would launder the guess into permanent truth and lose
      // the real date for good. Leave it absent and let the next load re-derive.
      if (typeof session.lastActivity === "number" && !session._lastActivityDerived) {
        metaObj.lastActivity = session.lastActivity;
      }
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
      if (session.adopted) metaObj.adopted = true;
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
      // Durable evidence that the owner reclaimed a Coop-owned session. Without
      // it a restart leaves no trace of why provenance is absent, and a released
      // session looks indistinguishable from one Coop never touched.
      if (typeof session.coopReleasedToOwnerAt === "number") {
        metaObj.coopReleasedToOwnerAt = session.coopReleasedToOwnerAt;
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
      // saveSessionFile rewrites the whole transcript from memory. If the lazy
      // accessor could not re-read this session's history, memory holds an empty
      // fallback rather than the real transcript -- writing it would destroy the
      // file. Refuse instead.
      if (historyStore.isUnavailable(session)) {
        console.error("[session] Refusing to save session " + session.localId +
          ": its history could not be re-read from disk.");
        config.diagLog("[SAVE-SKIP] " + new Date().toISOString() +
          " saveSessionFile localId=" + session.localId + " reason=history-unavailable");
        return false;
      }
      var sfPath = sessionFilePath(storageId);
      var tmpPath = sfPath + ".tmp." + process.pid;
      var _saveT0 = Date.now();
      var _saveBytes = writeSessionJsonlSync(tmpPath, meta, session.history);
      if (process.platform !== "win32") {
        try { fs.chmodSync(tmpPath, 0o600); } catch (chmodErr) {}
      }
      fs.renameSync(tmpPath, sfPath);
      var _saveMs = Date.now() - _saveT0;
      // Record the end of the rewrite, not its start. A synchronous rewrite of
      // a large transcript can itself exceed SAVE_COALESCE_MS; recording the
      // start made the next state update look old enough to trigger another
      // full rewrite immediately, defeating coalescing during the exact burst
      // that needs backpressure most.
      session._lastSaveAt = Date.now();
      session._lastSaveDurMs = _saveMs;
      session._lastSaveBytes = _saveBytes;
      if (_saveMs >= 200) {
        var _saveLine = "[SAVE-SLOW] " + new Date().toISOString() + " saveSessionFile localId=" + session.localId + " items=" + session.history.length + " bytes=" + _saveBytes + " took=" + _saveMs + "ms";
        console.warn(_saveLine);
        config.diagLog(_saveLine);
      }
      return true;
    } catch(e) {
      console.error("[session] Failed to save session file:", e.message);
      config.diagLog("[SAVE-FAIL] " + new Date().toISOString() + " saveSessionFile localId=" +
        session.localId + " items=" + (session.history ? session.history.length : 0) +
        " bytes=" + (typeof _saveBytes === "number" ? _saveBytes : (session._lastSaveBytes || 0)) +
        " err=" + e.message);
      if (throwOnFailure) throw e;
      return false;
    }
  }

  function appendToSessionFile(session, obj) {
    var storageId = getSessionStorageId(session);
    if (!storageId) return false;
    if (!session._suppressActivityBump) {
      // Real activity supersedes any guessed timestamp, so this value is now
      // authoritative and must be allowed to persist.
      session.lastActivity = Date.now();
      delete session._lastActivityDerived;
    }
    if (sendEach) {
      var _hwm = session.history.length;
      sendEach(function (ws) {
        if (ws.readyState === 1 && ws._clayActiveSession === session.localId) {
          ws._clayDeliveredLen = _hwm;
        }
      });
    }
    var line = JSON.stringify(obj) + "\n";
    try {
      var afPath = sessionFilePath(storageId);
      fs.appendFileSync(afPath, line);
      if (process.platform !== "win32") {
        try { fs.chmodSync(afPath, 0o600); } catch (chmodErr) {}
      }
      return true;
    } catch(e) {
      console.error("[session] Failed to append to session file:", e.message);
      config.diagLog("[SAVE-FAIL] " + new Date().toISOString() + " appendToSessionFile localId=" +
        session.localId + " items=" + (session.history ? session.history.length : 0) +
        " bytes=" + Buffer.byteLength(line) + " err=" + e.message);
      return false;
    }
  }

  return {
    saveSessionFile: saveSessionFile,
    appendToSessionFile: appendToSessionFile,
    flushPendingCoalescedSaves: flushPendingCoalescedSaves,
  };
}

module.exports = {
  attachSessionPersistence: attachSessionPersistence,
  flushPendingCoalescedSaves: flushPendingCoalescedSaves,
  writeSessionJsonlSync: writeSessionJsonlSync,
  SAVE_QUEUED: SAVE_QUEUED,
};
