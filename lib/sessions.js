var fs = require("fs");
var path = require("path");
var config = require("./config");
var utils = require("./utils");
var users = require("./users");
var tombstones = require("./tombstones");
var { CODEX_DEFAULTS, getCodexConfig } = require("./codex-defaults");
var { automationForSession, claudePermissionForAutomation } = require("./automation-modes");
var copilotSessions = require("./copilot-sessions");
var sessionPersistence = require("./sessions-persistence");
var sessionHandoff = require("./sessions-handoff");
var sessionBroadcast = require("./sessions-broadcast");
var sessionHistory = require("./sessions-history");
var sessionCliDescriptors = require("./sessions-cli-descriptors");

function createSessionManager(opts) {
  var cwd = opts.cwd;
  var send = opts.send;          // function(obj) - broadcast to all clients
  var sendTo = opts.sendTo || null; // function(ws, obj) - send to specific client
  var sendEach = opts.sendEach || null; // function(fn) - call fn(ws) for each connected client
  var sendAndRecord = null;      // set after init via setSendAndRecord
  var onSessionDone = opts.onSessionDone || function () {};

  // --- Multi-session state ---
  var nextLocalId = 1;
  var sessions = new Map();     // localId -> session object
  var activeSessionId = null;   // currently active local ID
  var slashCommands = null;     // shared across sessions (deprecated, use slashCommandsByVendor)
  var slashCommandsByVendor = {}; // vendor -> array of slash commands
  var skillNames = null;        // Claude-only skills to filter from slash menu
  var singleUserUnread = {};    // sessionLocalId -> unread count (single-user mode)
  var permissionRequestIndex = {}; // requestId -> sessionLocalId (O(1) lookup)
  var capabilitiesByVendor = null; // set by sdk-bridge after adapter init
  var defaultVendor = null;        // set by sdk-bridge
  var defaultAutomationMode = null;
  var codexApproval = CODEX_DEFAULTS.approval;
  var codexSandbox = CODEX_DEFAULTS.sandbox;
  var codexWebSearch = CODEX_DEFAULTS.webSearch;

  // --- Session persistence (centralized in ~/.clay/sessions/{encoded-cwd}/) ---
  var sessionsBase = path.join(config.CONFIG_DIR, "sessions");
  var encodedCwd = utils.resolveEncodedDir(sessionsBase, cwd);
  var sessionsDir = path.join(sessionsBase, encodedCwd);
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Auto-migrate sessions from legacy locations:
  //   v1: {cwd}/.claude-relay/sessions/
  //   v2: ~/.claude-relay/sessions/{encoded-cwd}/  (if config.js rename didn't cover it)
  var legacySessionDirs = [
    path.join(cwd, ".claude-relay", "sessions"),
    path.join(require("./config").REAL_HOME, ".claude-relay", "sessions", encodedCwd),
  ];
  for (var li = 0; li < legacySessionDirs.length; li++) {
    var oldSessionsDir = legacySessionDirs[li];
    try {
      var oldFiles = fs.readdirSync(oldSessionsDir);
      var migrated = 0;
      for (var mi = 0; mi < oldFiles.length; mi++) {
        if (!oldFiles[mi].endsWith(".jsonl")) continue;
        var oldFilePath = path.join(oldSessionsDir, oldFiles[mi]);
        var newFilePath = path.join(sessionsDir, oldFiles[mi]);
        if (fs.existsSync(newFilePath)) continue;
        try {
          fs.renameSync(oldFilePath, newFilePath);
          migrated++;
        } catch (renameErr) {
          try {
            fs.copyFileSync(oldFilePath, newFilePath);
            fs.unlinkSync(oldFilePath);
            migrated++;
          } catch (copyErr) {}
        }
      }
      if (migrated > 0) {
        console.log("[sessions] Migrated " + migrated + " session(s) from " + oldSessionsDir);
      }
      // Clean up old directory if empty
      try {
        if (fs.readdirSync(oldSessionsDir).length === 0) {
          fs.rmdirSync(oldSessionsDir);
          var parentDir = path.dirname(oldSessionsDir);
          if (fs.readdirSync(parentDir).length === 0) fs.rmdirSync(parentDir);
        }
      } catch (e) {}
    } catch (e) {
      // Old directory doesn't exist — that's fine
    }
  }

  function sessionFilePath(cliSessionId) {
    return path.join(sessionsDir, cliSessionId + ".jsonl");
  }

  // CLI session ids come from untrusted WS clients and are interpolated into
  // filesystem paths. Restrict to a safe charset to prevent path traversal.
  function isValidCliSessionId(cliSid) {
    return typeof cliSid === "string" && /^[A-Za-z0-9_-]+$/.test(cliSid);
  }

  function getSessionStorageId(session) {
    return session.storageId || session.cliSessionId || null;
  }

  function isMeaninglessUnknownError(obj) {
    return obj &&
      obj.type === "error" &&
      String(obj.text || "").trim().toLowerCase() === "unknown";
  }

  function queuedUserMessagesForClient(session) {
    rebuildPendingUserMessageQueueFromHistory(session);
    var out = [];
    var queue = session && session.pendingUserMessageQueue;
    if (!Array.isArray(queue)) return out;
    for (var i = 0; i < queue.length; i++) {
      var item = queue[i] || {};
      if (item.hidden) continue;
      out.push({
        queueId: item.queueId || "",
        text: item.displayText || "",
        imageCount: item.imageCount || 0,
        images: item.images || [],
        pastes: item.pastes || [],
        clientMessageId: item.clientMessageId || null,
      });
    }
    return out;
  }

  function rebuildPendingUserMessageQueueFromHistory(session) {
    if (!session || !Array.isArray(session.history)) return;
    var existingById = {};
    var existingQueue = Array.isArray(session.pendingUserMessageQueue) ? session.pendingUserMessageQueue : [];
    for (var qi = 0; qi < existingQueue.length; qi++) {
      var existing = existingQueue[qi];
      if (existing && existing.queueId) existingById[existing.queueId] = existing;
    }
    var nextQueue = [];
    for (var hi = 0; hi < session.history.length; hi++) {
      var item = session.history[hi];
      if (!item || item.type !== "user_message" || !item.queueId || (!item.queuedPending && !item.steerPending)) continue;
      var live = existingById[item.queueId] || {};
      var images = live.images || item.images || null;
      if ((!images || images.length === 0) && item.imageRefs) {
        images = imagesFromRefs(item.imageRefs);
      }
      nextQueue.push({
        queueId: item.queueId,
        text: live.text || item.text || "",
        images: images,
        pastes: live.pastes || item.pastes || null,
        displayText: item.text || "",
        imageCount: item.imageCount || 0,
        clientMessageId: item.clientMessageId || null,
        hidden: !!item.steerPending,
      });
    }
    session.pendingUserMessageQueue = nextQueue;
  }

  function imagesFromRefs(imageRefs) {
    var out = [];
    if (!Array.isArray(imageRefs)) return out;
    var imagesDir = path.join(config.CONFIG_DIR, "images", encodedCwd);
    for (var i = 0; i < imageRefs.length; i++) {
      var ref = imageRefs[i];
      if (!ref || !ref.file) continue;
      try {
        var data = fs.readFileSync(path.join(imagesDir, ref.file)).toString("base64");
        out.push({ mediaType: ref.mediaType || "image/png", data: data });
      } catch (e) {}
    }
    return out;
  }

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

  // Timestamp of the most recent recorded event — i.e. when the session last
  // made progress. Used to recency-gate auto-resume by when work ACTUALLY
  // stalled, not by daemon load time.
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

  // One-time history migration. Older builds recorded auto-continue / auto-
  // resume turns as a literal "continue" user_message (always immediately
  // preceded by a scheduled_message_sent event). Relabel those so old
  // transcripts no longer show a "continue" the user never typed. Idempotent —
  // relabeled entries no longer match — and a user-typed "continue" is left
  // alone because it is never preceded by scheduled_message_sent. Mutates the
  // array in place and returns the number of entries changed.
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
    // Anchor the recency gate to when work ACTUALLY stalled (the last recorded
    // event), not daemon load time. Otherwise a session interrupted days ago
    // looks "just interrupted" on every restart and keeps auto-resuming a stale
    // turn forever. Falls back to now only if no event carries a timestamp.
    var stalledTs = lastHistoryTimestamp(session.history) || Date.now();
    session.restartInterruptedAt = stalledTs;
    // Note/marker timestamps follow the stall point so they stay ordered after
    // the last real event.
    var interruptedTs = stalledTs;
    session.history.push({ type: "thinking_stop", _ts: interruptedTs });
    session.history.push({
      type: "info",
      text: "Session was interrupted by a Clay restart. Clay will continue it when you reopen this session.",
      _ts: interruptedTs + 1,
    });
    session.history.push({ type: "done", code: 1, _ts: interruptedTs + 2 });
  }

  var persistenceApi = sessionPersistence.attachSessionPersistence({
    getSessionStorageId: getSessionStorageId,
    sessionFilePath: sessionFilePath,
    sendEach: sendEach,
  });
  var saveSessionFile = persistenceApi.saveSessionFile;
  var appendToSessionFile = persistenceApi.appendToSessionFile;
  var handoffApi = sessionHandoff.attachSessionHandoff({ cwd: cwd });
  var recoverMissingHandoffContext = handoffApi.recoverMissingHandoffContext;
  var hasVendorResponseSinceLastSwitch = handoffApi.hasVendorResponseSinceLastSwitch;
  var shouldRecoverMissingHandoffContext = handoffApi.shouldRecoverMissingHandoffContext;
  var handoffTurnBudgetForVendor = handoffApi.handoffTurnBudgetForVendor;
  var inferCurrentVendorFromHistory = handoffApi.inferCurrentVendorFromHistory;
  var inferCurrentProviderRouteFromHistory = handoffApi.inferCurrentProviderRouteFromHistory;
  var inferCurrentModelFromHistory = handoffApi.inferCurrentModelFromHistory;
  var inferCliSessionIdAfterLastHandoff = handoffApi.inferCliSessionIdAfterLastHandoff;
  var cliDescriptorApi = sessionCliDescriptors.attachSessionCliDescriptors({
    cwd: cwd,
    isValidCliSessionId: isValidCliSessionId,
  });
  var cliSessionsDir = cliDescriptorApi.cliSessionsDir;
  var readCodexThreadNames = cliDescriptorApi.readCodexThreadNames;
  var listCodexRolloutFiles = cliDescriptorApi.listCodexRolloutFiles;
  var readCodexSessionDescriptor = cliDescriptorApi.readCodexSessionDescriptor;
  var ensureCodexThreadIndex = cliDescriptorApi.ensureCodexThreadIndex;
  var codexThreadIndexed = cliDescriptorApi.codexThreadIndexed;
  var findCodexRolloutByThreadId = cliDescriptorApi.findCodexRolloutByThreadId;
  var readCliSessionDescriptor = cliDescriptorApi.readCliSessionDescriptor;

  function addSessionCurrentIds(set, session) {
    if (!set || !session) return;
    if (session.cliSessionId) set.add(session.cliSessionId);
    if (session.storageId) set.add(session.storageId);
  }

  function addSessionHistoricalProviderIds(set, session) {
    if (!set || !session || !Array.isArray(session.history)) return;
    for (var i = 0; i < session.history.length; i++) {
      var item = session.history[i];
      if (!item || typeof item !== "object") continue;
      if (item.type === "session_id" && item.cliSessionId) {
        set.add(item.cliSessionId);
      }
      if (item.type === "result" && item.sessionId) {
        set.add(item.sessionId);
      }
    }
  }

  function loadSessions() {
    var files;
    try { files = fs.readdirSync(sessionsDir); } catch { return; }

    // Index codex rollouts once up front so the per-session vendor probe below
    // is an O(1) map lookup rather than a full tree walk per Claude session.
    ensureCodexThreadIndex();

    // Clean up stale temp files from interrupted atomic writes
    for (var ti = 0; ti < files.length; ti++) {
      if (files[ti].indexOf(".tmp.") !== -1) {
        try { fs.unlinkSync(path.join(sessionsDir, files[ti])); } catch (e) {}
      }
    }

    var loaded = [];
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith(".jsonl")) continue;
      var content;
      try { content = fs.readFileSync(path.join(sessionsDir, files[i]), "utf8"); } catch { continue; }
      var lines = content.trim().split("\n");
      if (lines.length === 0) continue;

      var meta;
      try { meta = JSON.parse(lines[0]); } catch { continue; }
      if (meta.type !== "meta" || (!meta.cliSessionId && !meta.storageId)) continue;

      var history = [];
      for (var j = 1; j < lines.length; j++) {
        try { history.push(JSON.parse(lines[j])); } catch {}
      }
      var migratedCount = relabelLegacyAutoContinueHistory(history);

      var fileMtime = 0;
      try { fileMtime = fs.statSync(path.join(sessionsDir, files[i])).mtimeMs; } catch {}
      loaded.push({ meta: meta, history: history, mtime: fileMtime, migrated: migratedCount > 0 });
    }

    loaded.sort(function(a, b) { return a.meta.createdAt - b.meta.createdAt; });

    for (var i = 0; i < loaded.length; i++) {
      var m = loaded[i].meta;
      var localId = nextLocalId++;
      // Reconstruct messageUUIDs from history
      var messageUUIDs = [];
      for (var k = 0; k < loaded[i].history.length; k++) {
        if (loaded[i].history[k].type === "message_uuid") {
          messageUUIDs.push({ uuid: loaded[i].history[k].uuid, type: loaded[i].history[k].messageType, historyIndex: k });
        }
      }
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
        lastActivity: loaded[i].mtime || m.createdAt || Date.now(),
        lastViewedAt: m.lastViewedAt || null,
        history: loaded[i].history,
        messageUUIDs: messageUUIDs,
        lastRewindUuid: m.lastRewindUuid || null,
      };
      // The visible "interrupted by restart" note can be sticky across
      // restarts (persisted in meta / re-derived from the leftover note). But
      // auto-continue must fire ONLY when the CURRENT history shows a genuinely
      // open turn — the model was actively mid-generation when the daemon
      // stopped — not merely because the server restarted while this session
      // existed. restartResumeEligible is recomputed fresh on every load and is
      // never persisted, so a stale interruption can't keep re-firing.
      var hasPersistedRestartInterruption = m.interruptedByRestart || hasUncontinuedRestartInterruption(session.history);
      if (hasPersistedRestartInterruption) session.interruptedByRestart = true;
      if (hasInterruptedTurn(session.history)) {
        markRestartInterruptedSession(session);
        session.restartResumeEligible = !hasPersistedRestartInterruption;
        // Ensure the recency stamp exists even when interruptedByRestart was
        // already set above (markRestartInterruptedSession returns early then).
        // Anchor to the last real activity, not load time, so a stale turn does
        // not look freshly interrupted on every restart.
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
      // Heal sessions stuck in perpetual handoff mode: if the new vendor has
      // already answered since the last switch, drop any lingering wrapper so
      // the live conversation is no longer re-framed as a fresh handoff.
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
      // Born-TUI session: PTY is gone after restart, but the cliSessionId
      // is still resumable via `claude --resume <id>`. We mark the mode
      // here so it shows up in the sidebar with the right icon; the
      // switch_session handler respawns the PTY on click.
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
      if (loaded[i].migrated || session.interruptedByRestart || (session.vendor || null) !== (m.vendor || null) || (session.cliSessionId || null) !== (m.cliSessionId || null) || (session.handoffContext && !m.handoffContext)) {
        saveSessionFile(session);
      }
    }
  }

  // Materialize a single .jsonl file that was just moved into this project's
  // sessionsDir (e.g. via "Move session to project"). Returns the new localId
  // on success, or null on failure. Does NOT tombstone, write, or broadcast —
  // the caller handles all of that.
  function adoptSessionFile(storageId) {
    if (!isValidCliSessionId(storageId)) return null;
    var filePath = sessionFilePath(storageId);
    var content;
    try { content = fs.readFileSync(filePath, "utf8"); } catch (e) { return null; }
    var lines = content.trim().split("\n");
    if (lines.length === 0) return null;
    var meta;
    try { meta = JSON.parse(lines[0]); } catch (e) { return null; }
    if (meta.type !== "meta" || (!meta.cliSessionId && !meta.storageId)) return null;

    ensureCodexThreadIndex();

    var history = [];
    for (var j = 1; j < lines.length; j++) {
      try { history.push(JSON.parse(lines[j])); } catch (e) {}
    }
    relabelLegacyAutoContinueHistory(history);

    var fileMtime = 0;
    try { fileMtime = fs.statSync(filePath).mtimeMs; } catch (e) {}

    var m = meta;
    var localId = nextLocalId++;
    var messageUUIDs = [];
    for (var k = 0; k < history.length; k++) {
      if (history[k].type === "message_uuid") {
        messageUUIDs.push({ uuid: history[k].uuid, type: history[k].messageType, historyIndex: k });
      }
    }
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
      messageUUIDs: messageUUIDs,
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
    return localId;
  }

  // Create a Clay session record from a CLI session descriptor and persist it.
  // Returns the new localId. Vendor comes from the descriptor; non-Claude
  // imports land in gui mode because they have no embedded TUI resume path.
  function materializeCliSession(desc) {
    var localId = nextLocalId++;
    var vendor = desc.vendor || "claude";
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: desc.cliSid,
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      isProcessing: false,
      title: desc.title,
      titleManuallySet: !!desc.title,
      titleAutoGenerated: false,
      createdAt: desc.createdAt,
      lastActivity: desc.lastActivity,
      history: [],
      messageUUIDs: [],
      lastRewindUuid: null,
      vendor: vendor,
      providerRouteId: desc.providerRouteId || null,
      model: desc.model || null,
      requestedModel: desc.model || null,
      mode: vendor === "claude" ? "tui" : "gui",
      terminalId: null,
      runtimeMode: null,
      runtimeTerminalId: null,
      sessionVisibility: "shared",
      bookmarked: false,
      favoriteOrder: null,
    };
    sessions.set(localId, session);
    try { saveSessionFile(session); } catch (e) {}
    return localId;
  }

  // A handoff leaves behind a secondary CLI rollout whose first user message is
  // the injected handoff context. Those are continuations of an existing Clay
  // session, not new conversations, so they must not be auto-adopted as fresh
  // sessions (they're still reachable via the Import-session picker). Matches
  // the current marker and the legacy "[Context from previous" wording.
  function isHandoffRolloutDescriptor(desc) {
    if (!desc) return false;
    var head = String(desc.preview || desc.title || "").slice(0, 400);
    if (head.indexOf("<clay_handoff_context>") !== -1) return true;
    if (head.indexOf("[Context from previous") !== -1) return true;
    return false;
  }

  function adoptOrphanedCliSessions() {
    var files;
    try { files = fs.readdirSync(cliSessionsDir()); } catch (e) { return; }

    // Dedup on BOTH cliSessionId and storageId. After a handoff a session's
    // cliSessionId is reassigned while storageId keeps the original rollout id,
    // so keying on cliSessionId alone would re-adopt the original rollout as a
    // brand-new (visible) duplicate. Track which known ids belong to a HIDDEN
    // session so we can flag (instrument) any attempt to resurrect one.
    var knownCliIds = new Set();
    var hiddenKnownIds = new Set();
    sessions.forEach(function (s) {
      addSessionCurrentIds(knownCliIds, s);
      addSessionHistoricalProviderIds(knownCliIds, s);
      if (s.hidden) {
        addSessionCurrentIds(hiddenKnownIds, s);
        addSessionHistoricalProviderIds(hiddenKnownIds, s);
      }
    });

    var adopted = 0;
    var resurrectAttempts = 0;
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith(".jsonl")) continue;
      var cliSid = files[i].slice(0, -".jsonl".length);
      if (knownCliIds.has(cliSid)) {
        // A rollout mapping to an already-hidden session is correctly skipped
        // here (dedup). Count for the summary; per-hit logging would be spammy.
        if (hiddenKnownIds.has(cliSid)) resurrectAttempts++;
        continue;
      }
      if (tombstones.has(cliSid)) continue;

      var desc = readCliSessionDescriptor(cliSid);
      if (!desc) continue;
      if (isHandoffRolloutDescriptor(desc)) continue;
      materializeCliSession(desc);
      knownCliIds.add(cliSid);
      adopted++;
      console.log("[sessions][unhide-watch] adopted orphan CLI rollout " + cliSid + " as VISIBLE: " + JSON.stringify((desc.title || "").slice(0, 50)));
    }

    if (adopted > 0 || resurrectAttempts > 0) {
      console.log("[sessions] Adopted " + adopted + " CLI session(s) for " + cwd + " (resurrect-guard hits: " + resurrectAttempts + ")");
    }
  }

  // List CLI sessions that aren't currently tracked by Clay — i.e. files in
  // ~/.claude/projects/<cwd>/ or ~/.codex/sessions/ matching this cwd whose
  // cliSessionId is either tombstoned or has never been adopted. Used by the
  // Import-session picker.
  function shouldIncludeForImportVendor(item, vendorFilter) {
    if (!vendorFilter) return true;
    var vendor = item && item.vendor ? item.vendor : "claude";
    if (vendor === "github-copilot") return item.copilotFamily === vendorFilter;
    return vendor === vendorFilter;
  }

  function listAdoptableCliSessions(vendorFilter) {
    vendorFilter = vendorFilter === "claude" || vendorFilter === "codex" ? vendorFilter : "";
    var knownCliIds = new Set();
    var hiddenCliIds = new Set();
    var hiddenCliSessions = new Map();
    sessions.forEach(function (s) {
      if (s.hidden) {
        if (s.cliSessionId) {
          hiddenCliIds.add(s.cliSessionId);
          hiddenCliSessions.set(s.cliSessionId, s);
        }
      } else {
        addSessionCurrentIds(knownCliIds, s);
      }
      addSessionHistoricalProviderIds(knownCliIds, s);
    });

    var out = [];

    var claudeFiles;
    try { claudeFiles = fs.readdirSync(cliSessionsDir()); } catch (e) { claudeFiles = []; }
    for (var i = 0; i < claudeFiles.length; i++) {
      if (!claudeFiles[i].endsWith(".jsonl")) continue;
      var cliSid = claudeFiles[i].slice(0, -".jsonl".length);
      if (knownCliIds.has(cliSid)) continue;
      var desc = readCliSessionDescriptor(cliSid);
      if (!desc && hiddenCliSessions.has(cliSid)) {
        var hiddenSession = hiddenCliSessions.get(cliSid);
        desc = {
          title: hiddenSession.title || "Imported CLI session",
          preview: hiddenSession.title || "",
          createdAt: hiddenSession.createdAt || Date.now(),
          lastActivity: hiddenSession.lastActivity || hiddenSession.createdAt || Date.now(),
        };
      }
      if (!desc) continue;
      var claudeItem = {
        cliSessionId: cliSid,
        title: desc.title,
        preview: desc.preview || "",
        createdAt: desc.createdAt,
        lastActivity: desc.lastActivity,
        tombstoned: tombstones.has(cliSid),
        hidden: hiddenCliIds.has(cliSid),
        vendor: "claude",
      };
      if (shouldIncludeForImportVendor(claudeItem, vendorFilter)) out.push(claudeItem);
    }

    var codexNames = readCodexThreadNames();
    var codexFiles = listCodexRolloutFiles();
    for (var ci = 0; ci < codexFiles.length; ci++) {
      var cdesc = readCodexSessionDescriptor(codexFiles[ci]);
      if (!cdesc) continue;
      if (knownCliIds.has(cdesc.cliSid)) continue;
      var displayTitle = codexNames.get(cdesc.cliSid) || cdesc.title;
      var codexItem = {
        cliSessionId: cdesc.cliSid,
        title: displayTitle,
        preview: cdesc.preview || "",
        createdAt: cdesc.createdAt,
        lastActivity: cdesc.lastActivity,
        tombstoned: tombstones.has(cdesc.cliSid),
        hidden: hiddenCliIds.has(cdesc.cliSid),
        vendor: "codex",
        archived: !!cdesc.archived,
      };
      if (shouldIncludeForImportVendor(codexItem, vendorFilter)) out.push(codexItem);
    }

    var copilotDescs = copilotSessions.listCopilotSessionDescriptors(config.REAL_HOME, cwd);
    for (var gi = 0; gi < copilotDescs.length; gi++) {
      var gdesc = copilotDescs[gi];
      if (!gdesc || knownCliIds.has(gdesc.cliSid)) continue;
      var copilotItem = {
        cliSessionId: gdesc.cliSid,
        title: gdesc.title,
        preview: gdesc.preview || "",
        createdAt: gdesc.createdAt,
        lastActivity: gdesc.lastActivity,
        tombstoned: tombstones.has(gdesc.cliSid),
        hidden: hiddenCliIds.has(gdesc.cliSid),
        vendor: "github-copilot",
        copilotFamily: gdesc.copilotFamily || null,
        model: gdesc.model || null,
        providerRouteId: gdesc.providerRouteId || null,
      };
      if (shouldIncludeForImportVendor(copilotItem, vendorFilter)) out.push(copilotItem);
    }

    // Surface hidden Clay sessions for restore. The vendor scans above skip
    // any id already "known" to Clay — which includes hidden sessions, since
    // their provider ids are recorded in the session history. Without this a
    // closed/archived session (e.g. an auto-launched task that closed early)
    // can never be brought back through the import picker. Skip compaction
    // sources: their content lives in the successor session, surfaced instead.
    var listedCliIds = new Set();
    for (var oi = 0; oi < out.length; oi++) {
      if (out[oi] && out[oi].cliSessionId) listedCliIds.add(out[oi].cliSessionId);
    }
    hiddenCliSessions.forEach(function (hs, cliSid) {
      if (!cliSid || listedCliIds.has(cliSid)) return;
      if (hs.compactedIntoLocalId) return;
      var hVendor = hs.vendor || "claude";
      var hFamily = null;
      if (hVendor === "github-copilot") {
        hFamily = hs.copilotFamily || copilotSessions.modelFamily(hs.copilotModel || hs.model) || null;
      }
      var hiddenItem = {
        cliSessionId: cliSid,
        title: hs.title || "Closed session",
        preview: hs.title || "",
        createdAt: hs.createdAt || 0,
        lastActivity: hs.lastActivity || hs.updatedAt || hs.createdAt || 0,
        tombstoned: tombstones.has(cliSid),
        hidden: true,
        vendor: hVendor,
        copilotFamily: hFamily,
        model: hs.model || null,
      };
      if (shouldIncludeForImportVendor(hiddenItem, vendorFilter)) out.push(hiddenItem);
    });

    out.sort(function (a, b) { return (b.lastActivity || 0) - (a.lastActivity || 0); });
    return out;
  }

  // Adopt a single CLI session by id and clear its tombstone. Returns the new
  // session's localId, or null if the file is missing or unusable. Vendor hint
  // is optional — when omitted we probe Claude first, then Codex.
  function importCliSession(cliSid, vendor) {
    if (!cliSid) return null;
    if (!isValidCliSessionId(cliSid)) return null;
    var existing = null;
    sessions.forEach(function (s) {
      if (s.cliSessionId === cliSid) existing = s;
    });
    if (existing) {
      if (existing.hidden) {
        console.warn("[sessions][unhide-watch] un-hiding session localId=" + existing.localId + " cliSid=" + cliSid + " via importCliSession (explicit user import)");
        existing.hidden = false;
        tombstones.remove(cliSid);
        saveSessionFile(existing);
        broadcastSessionList();
      }
      return existing.localId;
    }

    var desc = null;
    if (vendor === "codex") {
      var rollout = findCodexRolloutByThreadId(cliSid);
      if (rollout) desc = readCodexSessionDescriptor(rollout);
    } else if (vendor === "github-copilot") {
      desc = copilotSessions.readCopilotSessionDescriptor(config.REAL_HOME, cliSid, cwd);
    } else if (vendor === "claude") {
      desc = readCliSessionDescriptor(cliSid);
    } else {
      desc = readCliSessionDescriptor(cliSid);
      if (!desc) {
        var rollout2 = findCodexRolloutByThreadId(cliSid);
        if (rollout2) desc = readCodexSessionDescriptor(rollout2);
      }
      if (!desc) desc = copilotSessions.readCopilotSessionDescriptor(config.REAL_HOME, cliSid, cwd);
    }
    if (!desc) return null;
    tombstones.remove(cliSid);
    return materializeCliSession(desc);
  }

  // Load persisted sessions from disk, then adopt any orphan CLI sessions
  loadSessions();
  // Instrumentation: snapshot visible/hidden counts before and after adoption so
  // an unexpected jump in visible sessions (the "un-hide" symptom) is traceable.
  var _preAdoptTotal = sessions.size;
  var _preAdoptHidden = 0;
  sessions.forEach(function (s) { if (s.hidden) _preAdoptHidden++; });
  adoptOrphanedCliSessions();
  var _postAdoptHidden = 0;
  sessions.forEach(function (s) { if (s.hidden) _postAdoptHidden++; });
  console.log("[sessions][unhide-watch] loaded for " + cwd + ": total=" + _preAdoptTotal
    + " hidden=" + _preAdoptHidden + " -> after adopt: total=" + sessions.size
    + " hidden=" + _postAdoptHidden);

  function getActiveSession() {
    return sessions.get(activeSessionId) || null;
  }

  function getVisibleSessions() {
    var multiUser = users.isMultiUser();
    return [...sessions.values()].filter(function (s) {
      if (s.hidden) return false;
      if (!multiUser) {
        return !s.ownerId;
      }
      return true;
    });
  }

  function canWsAccessSession(ws, session) {
    if (!session || session.hidden) return false;
    if (!users.isMultiUser()) return !session.ownerId;
    if (!ws || !ws._clayUser) return true;
    return users.canAccessSession(ws._clayUser.id, session, { visibility: "public" });
  }

  function mostRecentVisibleSessionForWs(ws, excludeLocalId) {
    var best = null;
    sessions.forEach(function (session) {
      if (session.localId === excludeLocalId) return;
      if (!canWsAccessSession(ws, session)) return;
      if (!best || (session.lastActivity || session.createdAt || 0) > (best.lastActivity || best.createdAt || 0)) {
        best = session;
      }
    });
    return best;
  }

  function getEffectiveAutomationMode(session) {
    var fallbackPermissionMode = defaultAutomationMode ? claudePermissionForAutomation(defaultAutomationMode) : "default";
    return automationForSession(session, fallbackPermissionMode, getCodexConfig({
      codexApproval: codexApproval,
      codexSandbox: codexSandbox,
      codexWebSearch: codexWebSearch,
    }, session));
  }

  var broadcastApi = sessionBroadcast.attachSessionBroadcast({
    send: send,
    sendEach: sendEach,
    getVisibleSessions: getVisibleSessions,
    getActiveSessionId: function () { return activeSessionId; },
    getSingleUserUnread: function () { return singleUserUnread; },
    getEffectiveAutomationMode: getEffectiveAutomationMode,
  });
  var broadcastSessionList = broadcastApi.broadcastSessionList;
  var setResolveLoopInfo = broadcastApi.setResolveLoopInfo;

  function createSession(sessionOpts, targetWs) {
    var localId = nextLocalId++;
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: (sessionOpts && sessionOpts.cliSessionId) || null,
      storageId: (sessionOpts && sessionOpts.storageId) || (sessionOpts && sessionOpts.cliSessionId) || null,
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
      isProcessing: false,
      title: "",
      titleAutoGenerated: false,
      turnCount: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastViewedAt: Date.now(),
      history: [],
      messageUUIDs: [],
      ownerId: (sessionOpts && sessionOpts.ownerId) || null,
      sessionVisibility: (sessionOpts && sessionOpts.sessionVisibility) || "shared",
      bookmarked: false,
      favoriteOrder: null,
      vendor: (sessionOpts && sessionOpts.vendor) || null,
      providerRouteId: (sessionOpts && sessionOpts.providerRouteId) || null,
      model: (sessionOpts && sessionOpts.model) || null,
      automationMode: (sessionOpts && sessionOpts.automationMode) || null,
      permissionMode: (sessionOpts && sessionOpts.permissionMode) || null,
      codexApproval: (sessionOpts && sessionOpts.codexApproval) || null,
      codexSandbox: (sessionOpts && sessionOpts.codexSandbox) || null,
      codexWebSearch: (sessionOpts && sessionOpts.codexWebSearch) || null,
      mode: (sessionOpts && sessionOpts.mode === "tui") ? "tui" : "gui",
      terminalId: null,
    };
    sessions.set(localId, session);
    switchSession(localId, targetWs);
    return session;
  }

  // Create a session without switching to it (used for mate/background sessions)
  function createSessionRaw(sessionOpts) {
    var localId = nextLocalId++;
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: (sessionOpts && sessionOpts.cliSessionId) || null,
      storageId: (sessionOpts && sessionOpts.storageId) || (sessionOpts && sessionOpts.cliSessionId) || null,
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
      isProcessing: false,
      title: "",
      titleAutoGenerated: false,
      turnCount: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastViewedAt: null,
      history: [],
      messageUUIDs: [],
      ownerId: (sessionOpts && sessionOpts.ownerId) || null,
      sessionVisibility: (sessionOpts && sessionOpts.sessionVisibility) || "shared",
      bookmarked: false,
      favoriteOrder: null,
      vendor: (sessionOpts && sessionOpts.vendor) || null,
      providerRouteId: (sessionOpts && sessionOpts.providerRouteId) || null,
      model: (sessionOpts && sessionOpts.model) || null,
      automationMode: (sessionOpts && sessionOpts.automationMode) || null,
      permissionMode: (sessionOpts && sessionOpts.permissionMode) || null,
      codexApproval: (sessionOpts && sessionOpts.codexApproval) || null,
      codexSandbox: (sessionOpts && sessionOpts.codexSandbox) || null,
      codexWebSearch: (sessionOpts && sessionOpts.codexWebSearch) || null,
      mode: (sessionOpts && sessionOpts.mode === "tui") ? "tui" : "gui",
      dangerouslySkipPermissions: !!(sessionOpts && sessionOpts.dangerouslySkipPermissions),
      terminalId: null,
    };
    sessions.set(localId, session);
    return session;
  }

  var historyApi = sessionHistory.attachSessionHistory({
    send: send,
    sendTo: sendTo,
    isMeaninglessUnknownError: isMeaninglessUnknownError,
  });
  var HISTORY_PAGE_SIZE = historyApi.HISTORY_PAGE_SIZE;
  var findTurnBoundary = historyApi.findTurnBoundary;
  var replayHistory = historyApi.replayHistory;

  function switchSession(localId, targetWs, transform) {
    var session = sessions.get(localId);
    if (!session) return;

    activeSessionId = localId;
    session.lastViewedAt = Date.now();
    // Persist lastViewedAt lazily AND off the hot path. saveSessionFile rewrites
    // the entire history (O(history) synchronous fs.writeFileSync); doing that
    // inline here blocks the single-threaded event loop right when the client is
    // awaiting its heartbeat pong, so a switch into a large session (common when
    // many sessions are active) delays the pong past the timeout and the client
    // false-reconnects, flashing the "Reconnecting…" overlay. Throttle to one
    // write per 15s per session AND defer it to a later tick: the switch response
    // (session_switched + replay) flushes first, the pong is answered promptly,
    // and the heavy write happens after, out of the critical section. The value
    // is only restore-ordering metadata, so losing it on a crash before the
    // deferred write is harmless.
    if (!session._lastViewedPersistedAt || (session.lastViewedAt - session._lastViewedPersistedAt) > 15000) {
      session._lastViewedPersistedAt = session.lastViewedAt;
      setImmediate(function () { saveSessionFile(session); });
    }
    if (targetWs) {
      targetWs._clayActiveSession = localId;
      // Clear unread for this session (multi-user)
      if (targetWs._clayUnread) targetWs._clayUnread[localId] = 0;
    } else if (sendEach) {
      // No specific target: update all connected clients (server-initiated switch).
      // replayHistory below uses the broadcast `send` (no targetWs), so reset the
      // delivered high-water mark here for every client that now views this session.
      sendEach(function (ws) {
        ws._clayActiveSession = localId;
        ws._clayDeliveredLen = session.history.length;
      });
    }
    // Clear unread for single-user mode
    singleUserUnread[localId] = 0;

    // In multi-user mode with a specific client, only send to that client
    var _send = (targetWs && sendTo) ? function (obj) { sendTo(targetWs, obj); } : send;

    var _capsByVendor = capabilitiesByVendor || {};
    var _sessionVendor = session.vendor || defaultVendor || "claude";
    var _vendorCaps = _capsByVendor[_sessionVendor] || {};
    _send({ type: "session_switched", id: localId, title: session.title || null, cliSessionId: session.cliSessionId || null, loop: session.loop || null, vendor: session.vendor || null, providerRouteId: session.providerRouteId || null, requestedModel: session.requestedModel || session.model || null, verifiedModel: session.verifiedModel || null, modelVerificationSource: session.modelVerificationSource || null, automationMode: getEffectiveAutomationMode(session), permissionMode: session.permissionMode || null, codexApproval: session.codexApproval || null, codexSandbox: session.codexSandbox || null, codexWebSearch: session.codexWebSearch || null, hasHistory: (session.history && session.history.length > 0), capabilities: _vendorCaps, isProcessing: !!session.isProcessing, mode: session.mode || "gui", terminalId: typeof session.terminalId === "number" ? session.terminalId : null, runtimeMode: session.runtimeMode || null, runtimeTerminalId: typeof session.runtimeTerminalId === "number" ? session.runtimeTerminalId : null, tuiSuspended: !!session.tuiSuspended, queueingDisabled: !!session.queueingDisabled, queuedUserMessages: queuedUserMessagesForClient(session) });
    // Send vendor-specific slash commands
    var _vendorCmds = slashCommandsByVendor[_sessionVendor] || slashCommands || [];
    _send({ type: "slash_commands", commands: _vendorCmds, vendor: _sessionVendor });
    broadcastSessionList();
    replayHistory(session, undefined, targetWs, transform);

    if (session.isProcessing) {
      _send({ type: "status", status: "processing" });
    }

    // Re-send any pending permission requests
    var pendingIds = Object.keys(session.pendingPermissions);
    for (var i = 0; i < pendingIds.length; i++) {
      var p = session.pendingPermissions[pendingIds[i]];
      _send({
        type: "permission_request_pending",
        requestId: p.requestId,
        toolName: p.toolName,
        toolInput: p.toolInput,
        toolUseId: p.toolUseId,
        decisionReason: p.decisionReason,
      });
    }

    // Re-send active mention indicator so returning clients restore the mate avatar state
    if (session._mentionInProgress && session._mentionActiveMateId) {
      _send({ type: "mention_processing", mateId: session._mentionActiveMateId, active: true });
    }
  }

  function cleanupMentionSessions(session) {
    if (session._mentionSessions) {
      var mateIds = Object.keys(session._mentionSessions);
      for (var mi = 0; mi < mateIds.length; mi++) {
        try { session._mentionSessions[mateIds[mi]].close(); } catch (e) {}
      }
      session._mentionSessions = {};
    }
  }

  function deleteSession(localId, targetWs) {
    var session = sessions.get(localId);
    if (!session) return;

    // Clean up unread tracking
    delete singleUserUnread[localId];

    cleanupMentionSessions(session);

    if (session.abortController) {
      try { session.abortController.abort(); } catch(e) {}
    }
    // Close SDK query to terminate the underlying claude child process
    if (session.queryInstance && typeof session.queryInstance.close === "function") {
      try { session.queryInstance.close(); } catch(e) {}
    }
    session.queryInstance = null;
    if (session.messageQueue) {
      try { session.messageQueue.end(); } catch(e) {}
    }
    if (session.worker) {
      try { session.worker.kill(); } catch(e) {}
      session.worker = null;
    }

    // Cancel any pending coalesced save so it can't resurrect the file.
    session._deleted = true;
    if (session._saveCoalesceTimer) {
      clearTimeout(session._saveCoalesceTimer);
      session._saveCoalesceTimer = null;
    }

    var storageId = getSessionStorageId(session);
    if (storageId) {
      tombstones.add(storageId);
      if (session.cliSessionId && session.cliSessionId !== storageId) {
        tombstones.add(session.cliSessionId);
      }
      try { fs.unlinkSync(sessionFilePath(storageId)); } catch(e) {}
    }

    sessions.delete(localId);

    if (activeSessionId === localId) {
      var remaining = [...sessions.keys()];
      if (remaining.length > 0) {
        switchSession(remaining[remaining.length - 1], targetWs);
      } else {
        createSession(null, targetWs);
      }
    } else {
      broadcastSessionList();
    }
  }

  function hideSession(localId, targetWs) {
    var session = sessions.get(localId);
    if (!session) return;
    session.hidden = true;
    saveSessionFile(session);

    var targetActive = !!(targetWs && targetWs._clayActiveSession === localId);
    var globalActive = activeSessionId === localId;
    if (targetActive || globalActive) {
      var nextSession = mostRecentVisibleSessionForWs(targetWs, localId);
      if (nextSession) {
        switchSession(nextSession.localId, targetWs);
        return;
      }
      if (targetActive && targetWs) targetWs._clayActiveSession = null;
      if (globalActive) activeSessionId = null;
      if (targetActive && targetWs && sendTo) {
        sendTo(targetWs, { type: "session_closed", id: localId });
      } else if (globalActive) {
        send({ type: "session_closed", id: localId });
      }
    }
    broadcastSessionList();
  }

  function sendSessionClosedToWs(ws, localId) {
    if (!ws || ws.readyState !== 1) return;
    if (sendTo) {
      sendTo(ws, { type: "session_closed", id: localId });
      return;
    }
    try { ws.send(JSON.stringify({ type: "session_closed", id: localId })); } catch (e) {}
  }

  function hideSessionForActiveClients(localId) {
    var session = sessions.get(localId);
    if (!session) return;
    if (!sendEach) {
      hideSession(localId, null);
      return;
    }

    session.hidden = true;
    saveSessionFile(session);

    var activeClients = [];
    sendEach(function (ws) {
      if (ws && ws._clayActiveSession === localId) activeClients.push(ws);
    });

    for (var i = 0; i < activeClients.length; i++) {
      var ws = activeClients[i];
      var nextSession = mostRecentVisibleSessionForWs(ws, localId);
      if (nextSession) {
        switchSession(nextSession.localId, ws);
      } else {
        ws._clayActiveSession = null;
        sendSessionClosedToWs(ws, localId);
      }
    }

    if (activeSessionId === localId) {
      var globalNext = mostRecentVisibleSessionForWs(null, localId);
      if (globalNext) {
        activeSessionId = globalNext.localId;
      } else {
        activeSessionId = null;
      }
    }

    broadcastSessionList();
  }

  function deleteSessionQuiet(localId) {
    var session = sessions.get(localId);
    if (!session) return;
    delete singleUserUnread[localId];
    cleanupMentionSessions(session);
    if (session.abortController) {
      try { session.abortController.abort(); } catch(e) {}
    }
    // Close SDK query to terminate the underlying claude child process
    if (session.queryInstance && typeof session.queryInstance.close === "function") {
      try { session.queryInstance.close(); } catch(e) {}
    }
    session.queryInstance = null;
    if (session.messageQueue) {
      try { session.messageQueue.end(); } catch(e) {}
    }
    if (session.worker) {
      try { session.worker.kill(); } catch(e) {}
      session.worker = null;
    }
    // Cancel any pending coalesced save so it can't resurrect the file.
    session._deleted = true;
    if (session._saveCoalesceTimer) {
      clearTimeout(session._saveCoalesceTimer);
      session._saveCoalesceTimer = null;
    }
    var storageId = getSessionStorageId(session);
    if (storageId) {
      tombstones.add(storageId);
      if (session.cliSessionId && session.cliSessionId !== storageId) {
        tombstones.add(session.cliSessionId);
      }
      try { fs.unlinkSync(sessionFilePath(storageId)); } catch(e) {}
    }
    sessions.delete(localId);
  }

  function deleteSessionsBulk(localIds, targetWs) {
    if (!Array.isArray(localIds) || localIds.length === 0) return;

    var seen = {};
    var ids = [];
    for (var i = 0; i < localIds.length; i++) {
      var id = localIds[i];
      if (typeof id !== "number" || seen[id] || !sessions.has(id)) continue;
      seen[id] = true;
      ids.push(id);
    }
    if (ids.length === 0) return;

    var deletedActive = false;
    for (var j = 0; j < ids.length; j++) {
      if (ids[j] === activeSessionId) deletedActive = true;
      deleteSessionQuiet(ids[j]);
    }

    if (sessions.size === 0) {
      createSession(null, targetWs);
      return;
    }

    if (deletedActive) {
      var remaining = [...sessions.keys()];
      switchSession(remaining[remaining.length - 1], targetWs);
    } else {
      broadcastSessionList();
    }
  }

  function doSendToSession(session, obj) {
    // Send to active clients without recording to history/disk (ephemeral data)
    var msg = obj;
    if (msg && !Object.prototype.hasOwnProperty.call(msg, "sessionId")) {
      msg = Object.assign({}, msg, { sessionId: session.localId });
    }
    if (sendEach) {
      var data = JSON.stringify(msg);
      sendEach(function (ws) {
        if (ws._clayActiveSession === session.localId && ws.readyState === 1) {
          ws.send(data);
        }
      });
    } else if (session.localId === activeSessionId) {
      send(msg);
    }
  }

  function doSendAndRecord(session, obj) {
    if (isMeaninglessUnknownError(obj)) return;
    // Latch that a terminal "done" closed this turn. The sdk-bridge finally
    // block checks this to emit a safety-net "done" if some path ended the turn
    // without one — otherwise the client's running tool/sub-agent blocks would
    // spin forever (no event ever reconciles them).
    if (obj && obj.type === "done") session._turnDoneSent = true;
    // Stamp every recorded message so history replay preserves original times
    if (!obj._ts) obj._ts = Date.now();
    session.history.push(obj);
    appendToSessionFile(session, obj);
    var msg = obj;
    if (msg && !Object.prototype.hasOwnProperty.call(msg, "sessionId")) {
      msg = Object.assign({}, msg, { sessionId: session.localId });
    }
    // Per-session out-of-band subscribers (used by home-chat to mirror
    // Clay session events into a parallel UI without joining the project's
    // ws clients set). Subscribers receive the same obj that goes to ws
    // clients; they are responsible for any transform + dispatch.
    if (session._subscribers && session._subscribers.size > 0) {
      for (var sub of session._subscribers) {
        try { sub(obj); } catch (e) { /* swallow — subscriber is optional */ }
      }
    }
    if (sendEach) {
      // Multi-user: send to clients whose active session matches this one
      var data = JSON.stringify(msg);
      var ioData = null;
      sendEach(function (ws) {
        if (ws._clayActiveSession === session.localId) {
          if (ws.readyState === 1) ws.send(data);
        } else if (session.isProcessing && !session._ioThrottle) {
          if (!ioData) ioData = JSON.stringify({ type: "session_io", id: session.localId });
          if (ws.readyState === 1) ws.send(ioData);
        }
        // Track unread: increment on "done" for clients not viewing this session
        // Only count if session has no owner (my session) or owner matches this client
        if (obj.type === "done" && ws._clayActiveSession !== session.localId) {
          var _isMySession = !session.ownerId || (ws._clayUser && ws._clayUser.id === session.ownerId);
          if (_isMySession) {
            if (!ws._clayUnread) ws._clayUnread = {};
            ws._clayUnread[session.localId] = (ws._clayUnread[session.localId] || 0) + 1;
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "session_unread", id: session.localId, count: ws._clayUnread[session.localId] }));
            }
          }
        }
      });
      if (session.isProcessing && !session._ioThrottle && ioData) {
        session._ioThrottle = true;
        setTimeout(function () { session._ioThrottle = false; }, 80);
      }
    } else if (session.localId === activeSessionId) {
      send(msg);
    } else {
      // Track unread for single-user mode on "done"
      if (obj.type === "done") {
        singleUserUnread[session.localId] = (singleUserUnread[session.localId] || 0) + 1;
        send({ type: "session_unread", id: session.localId, count: singleUserUnread[session.localId] });
      }
      if (session.isProcessing && !session._ioThrottle) {
        session._ioThrottle = true;
        send({ type: "session_io", id: session.localId });
        setTimeout(function () { session._ioThrottle = false; }, 80);
      }
    }
    // Notify server for cross-project unread tracking
    if (obj.type === "done") onSessionDone();
  }

  function resumeSession(cliSessionId, opts, targetWs) {
    // If a session with this cliSessionId already exists, just switch to it
    var existing = null;
    sessions.forEach(function (s) {
      if (s.cliSessionId === cliSessionId) existing = s;
    });
    if (existing) {
      existing.lastActivity = Date.now();
      existing.lastViewedAt = Date.now();
      switchSession(existing.localId, targetWs);
      return existing;
    }

    var cliHistory = (opts && opts.history) || [];
    var title = (opts && opts.title) || "Resumed session";
    var localId = nextLocalId++;
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: cliSessionId,
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
      isProcessing: false,
      title: title,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastViewedAt: Date.now(),
      history: cliHistory,
      messageUUIDs: [],
      bookmarked: false,
      favoriteOrder: null,
    };
    if (opts && opts.vendor) session.vendor = opts.vendor;
    if (opts && opts.ownerId) session.ownerId = opts.ownerId;
    sessions.set(localId, session);
    saveSessionFile(session);
    switchSession(localId, targetWs);
    return session;
  }

  // Bound tombstone growth: drop entries whose underlying CLI session no longer
  // exists (nothing left to re-adopt, so the tombstone is dead weight).
  try {
    ensureCodexThreadIndex();
    tombstones.prune(function (id) {
      if (!isValidCliSessionId(id)) return false;
      try {
        if (fs.existsSync(path.join(cliSessionsDir(), id + ".jsonl"))) return true;
      } catch (e) {}
      return codexThreadIndexed(id);
    });
  } catch (e) {}

  // --- Spawn initial session only if no persisted sessions ---
  if (sessions.size === 0) {
    createSession();
  } else {
    // Activate the most recently viewed session. Background activity writes
    // update lastActivity/mtime, but should not steal focus on restore.
    var allSessions = getVisibleSessions();
    var mostRecent = allSessions[0];
    var hasViewedSession = !!(mostRecent && mostRecent.lastViewedAt);
    for (var i = 1; i < allSessions.length; i++) {
      if (allSessions[i].lastViewedAt) hasViewedSession = true;
    }
    for (var j = 1; j < allSessions.length; j++) {
      var candidate = allSessions[j];
      var candidateScore = hasViewedSession ? (candidate.lastViewedAt || 0) : (candidate.lastActivity || 0);
      var mostRecentScore = hasViewedSession ? (mostRecent.lastViewedAt || 0) : (mostRecent.lastActivity || 0);
      if (candidateScore > mostRecentScore) {
        mostRecent = candidate;
      }
    }
    activeSessionId = mostRecent ? mostRecent.localId : null;
  }

  function searchSessions(query) {
    if (!query) return [];
    var q = query.toLowerCase();
    var results = [];
    sessions.forEach(function (session) {
      var titleMatch = (session.title || "New Session").toLowerCase().indexOf(q) !== -1;
      var contentMatch = false;
      for (var i = 0; i < session.history.length; i++) {
        var entry = session.history[i];
        if ((entry.type === "delta" || entry.type === "user_message" || entry.type === "mention_user" || entry.type === "mention_response" || entry.type === "debate_turn_done" || entry.type === "debate_comment_injected") && entry.text) {
          if (entry.text.toLowerCase().indexOf(q) !== -1) {
            contentMatch = true;
            break;
          }
        }
      }
      if (titleMatch || contentMatch) {
        results.push({
          id: session.localId,
          cliSessionId: session.cliSessionId || null,
          title: session.title || "New Session",
          active: session.localId === activeSessionId,
          isProcessing: session.isProcessing,
          lastActivity: session.lastActivity || session.createdAt || 0,
          matchType: titleMatch && contentMatch ? "both" : titleMatch ? "title" : "content",
        });
      }
    });
    return results;
  }

  function searchSessionContent(localId, query) {
    if (!query) return { hits: [], total: 0 };
    var session = sessions.get(localId);
    if (!session) return { hits: [], total: 0 };
    var q = query.toLowerCase();
    var qLen = query.length;
    var history = session.history;
    var hits = [];

    // Assistant turns can consist of many streaming deltas (especially Codex,
    // where agentMessage/delta fragments arrive in small chunks). We accumulate
    // delta text per turn, scan for ALL occurrences of the query across the
    // accumulated buffer, then map each occurrence back to the historyIndex of
    // the delta that contains its starting offset. This catches multiple
    // matches within a single turn and also matches that straddle delta
    // boundaries.
    var turnBuffer = "";
    var turnSegments = []; // [{ start, end, historyIndex, ts }]

    function pushScalarHits(text, historyIndex, role, ts) {
      if (!text) return;
      var lower = text.toLowerCase();
      var from = 0;
      while (true) {
        var idx = lower.indexOf(q, from);
        if (idx === -1) break;
        var s = Math.max(0, idx - 15);
        var e = Math.min(text.length, idx + qLen + 15);
        var snippet = (s > 0 ? "\u2026" : "") + text.substring(s, e) + (e < text.length ? "\u2026" : "");
        hits.push({ historyIndex: historyIndex, snippet: snippet, role: role, ts: ts });
        from = idx + qLen;
      }
    }

    function flushTurn() {
      if (!turnBuffer || turnSegments.length === 0) {
        turnBuffer = "";
        turnSegments = [];
        return;
      }
      var lowerBuf = turnBuffer.toLowerCase();
      var from = 0;
      var segCursor = 0;
      while (true) {
        var idx = lowerBuf.indexOf(q, from);
        if (idx === -1) break;
        // Advance segCursor to the segment containing idx.
        while (segCursor < turnSegments.length - 1 && turnSegments[segCursor].end <= idx) {
          segCursor++;
        }
        var seg = turnSegments[segCursor];
        var s = Math.max(0, idx - 15);
        var e = Math.min(turnBuffer.length, idx + qLen + 15);
        var snippet = (s > 0 ? "\u2026" : "") + turnBuffer.substring(s, e) + (e < turnBuffer.length ? "\u2026" : "");
        hits.push({ historyIndex: seg.historyIndex, snippet: snippet, role: "assistant", ts: seg.ts });
        from = idx + qLen;
      }
      turnBuffer = "";
      turnSegments = [];
    }

    for (var i = 0; i < history.length; i++) {
      var entry = history[i];
      var t = entry.type;
      if (t === "user_message" || t === "mention_user") {
        flushTurn();
        pushScalarHits(entry.text, i, t === "user_message" ? "user" : "assistant", entry._ts || null);
      } else if (t === "delta" && entry.text) {
        turnSegments.push({
          start: turnBuffer.length,
          end: turnBuffer.length + entry.text.length,
          historyIndex: i,
          ts: entry._ts || null,
        });
        turnBuffer += entry.text;
      } else if ((t === "mention_response" || t === "debate_turn_done" || t === "debate_comment_injected") && entry.text) {
        flushTurn();
        pushScalarHits(entry.text, i, "assistant", entry._ts || null);
      }
    }
    flushTurn();
    return { hits: hits, total: history.length };
  }

  var _migrationFailedIds = {};
  function migrateSessionTitles(adapter, migrateCwd) {
    var candidates = [];
    sessions.forEach(function(s) {
      if (s.cliSessionId && s.title && s.title !== "New Session" && s.title !== "Resumed session"
          && !_migrationFailedIds[s.cliSessionId]) {
        candidates.push({ cliSessionId: s.cliSessionId, title: s.title });
      }
    });
    if (candidates.length === 0) return;
    adapter.listSessions({ dir: migrateCwd }).then(function(sdkSessions) {
      var sdkTitles = {};
      for (var i = 0; i < sdkSessions.length; i++) {
        if (sdkSessions[i].customTitle) {
          sdkTitles[sdkSessions[i].sessionId] = sdkSessions[i].customTitle;
        }
      }
      var toMigrate = candidates.filter(function(item) {
        var relayTitle = (item.title || "").trim();
        var sdkTitle = (sdkTitles[item.cliSessionId] || "").trim();
        return sdkTitle !== relayTitle;
      });
      if (toMigrate.length === 0) return;
      var migrated = 0;
      var failed = 0;
      var chain = Promise.resolve();
      for (var j = 0; j < toMigrate.length; j++) {
        (function(item) {
          chain = chain.then(function() {
            return adapter.renameSession(item.cliSessionId, item.title.trim(), { dir: migrateCwd }).then(function() {
              migrated++;
            }).catch(function(e) {
              failed++;
              _migrationFailedIds[item.cliSessionId] = true;
            });
          });
        })(toMigrate[j]);
      }
      chain.then(function() {
        if (migrated > 0) {
          console.log("[session] Migrated " + migrated + " session title(s) to SDK format");
        }
        if (failed > 0) {
          console.log("[session] Skipped " + failed + " session(s) (CLI session not found for current user)");
        }
      }).catch(function(e) {
        console.error("[session] Migration chain failed:", e.message || e);
      });
    }).catch(function() {});
  }

  return {
    get activeSessionId() { return activeSessionId; },
    get nextLocalId() { return nextLocalId; },
    get slashCommands() { return slashCommands; },
    set slashCommands(v) { slashCommands = v; },
    get slashCommandsByVendor() { return slashCommandsByVendor; },
    setSlashCommandsForVendor: function(vendor, cmds) {
      slashCommandsByVendor[vendor] = cmds || [];
    },
    getSlashCommandsForVendor: function(vendor) {
      return slashCommandsByVendor[vendor] || [];
    },
    get skillNames() { return skillNames; },
    set skillNames(v) { skillNames = v; },
    get capabilitiesByVendor() { return capabilitiesByVendor; },
    set capabilitiesByVendor(v) { capabilitiesByVendor = v; },
    get defaultVendor() { return defaultVendor; },
    set defaultVendor(v) { defaultVendor = v; },
    get defaultAutomationMode() { return defaultAutomationMode; },
    set defaultAutomationMode(v) { defaultAutomationMode = v; },
    get codexApproval() { return codexApproval; },
    set codexApproval(v) { codexApproval = v; },
    get codexSandbox() { return codexSandbox; },
    set codexSandbox(v) { codexSandbox = v; },
    get codexWebSearch() { return codexWebSearch; },
    set codexWebSearch(v) { codexWebSearch = v; },
    sessions: sessions,
    sessionsDir: sessionsDir,
    HISTORY_PAGE_SIZE: HISTORY_PAGE_SIZE,
    getActiveSession: getActiveSession,
    isMeaninglessUnknownError: isMeaninglessUnknownError,
    queuedUserMessagesForClient: queuedUserMessagesForClient,
    createSession: createSession,
    createSessionRaw: createSessionRaw,
    switchSession: switchSession,
    hideSession: hideSession,
    hideSessionForActiveClients: hideSessionForActiveClients,
    deleteSession: deleteSession,
    deleteSessionQuiet: deleteSessionQuiet,
    deleteSessionsBulk: deleteSessionsBulk,
    listAdoptableCliSessions: listAdoptableCliSessions,
    importCliSession: importCliSession,
    resumeSession: resumeSession,
    broadcastSessionList: broadcastSessionList,
    getTotalUnread: function (ws) {
      var unreadMap = ws && ws._clayUnread ? ws._clayUnread : singleUserUnread;
      var total = 0;
      var keys = Object.keys(unreadMap);
      for (var i = 0; i < keys.length; i++) {
        total += unreadMap[keys[i]] || 0;
      }
      return total;
    },
    adoptSessionFile: adoptSessionFile,
    saveSessionFile: saveSessionFile,
    appendToSessionFile: appendToSessionFile,
    sendAndRecord: doSendAndRecord,
    subscribeSession: function (localId, cb) {
      var session = sessions.get(localId);
      if (!session) return null;
      if (!session._subscribers) session._subscribers = new Set();
      session._subscribers.add(cb);
      return function unsubscribe() {
        if (session._subscribers) session._subscribers.delete(cb);
      };
    },
    sendToSession: doSendToSession,
    findTurnBoundary: findTurnBoundary,
    replayHistory: replayHistory,
    searchSessions: searchSessions,
    searchSessionContent: searchSessionContent,
    setResolveLoopInfo: setResolveLoopInfo,
    migrateSessionTitles: migrateSessionTitles,
    setSessionVisibility: function (localId, visibility) {
      var session = sessions.get(localId);
      if (!session) return { error: "Session not found" };
      session.sessionVisibility = visibility;
      saveSessionFile(session);
      broadcastSessionList();
      return { ok: true };
    },
    setSessionBookmarked: function (localId, bookmarked) {
      var session = sessions.get(localId);
      if (!session) return { error: "Session not found" };
      session.bookmarked = !!bookmarked;
      if (session.bookmarked) {
        var maxOrder = -1;
        sessions.forEach(function (s) {
          if (s.bookmarked && typeof s.favoriteOrder === "number" && s.favoriteOrder > maxOrder) {
            maxOrder = s.favoriteOrder;
          }
        });
        session.favoriteOrder = maxOrder + 1;
      } else {
        session.favoriteOrder = null;
      }
      saveSessionFile(session);
      broadcastSessionList();
      return { ok: true };
    },
    reorderBookmarkedSessions: function (sourceId, targetId, insertBefore) {
      var source = sessions.get(sourceId);
      var target = sessions.get(targetId);
      if (!source || !target) return { error: "Session not found" };
      if (!source.bookmarked || !target.bookmarked) return { error: "Only favorites can be reordered" };

      var favorites = [];
      sessions.forEach(function (s) {
        if (s.bookmarked) favorites.push(s);
      });
      favorites.sort(function (a, b) {
        var ao = typeof a.favoriteOrder === "number" ? a.favoriteOrder : Number.MAX_SAFE_INTEGER;
        var bo = typeof b.favoriteOrder === "number" ? b.favoriteOrder : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return (b.lastActivity || 0) - (a.lastActivity || 0);
      });

      var reordered = [];
      for (var i = 0; i < favorites.length; i++) {
        if (favorites[i].localId !== sourceId) reordered.push(favorites[i]);
      }

      var targetIdx = -1;
      for (var j = 0; j < reordered.length; j++) {
        if (reordered[j].localId === targetId) {
          targetIdx = j;
          break;
        }
      }
      if (targetIdx === -1) return { error: "Target favorite not found" };
      if (!insertBefore) targetIdx++;
      reordered.splice(targetIdx, 0, source);

      for (var k = 0; k < reordered.length; k++) {
        reordered[k].favoriteOrder = k;
        saveSessionFile(reordered[k]);
      }
      broadcastSessionList();
      return { ok: true };
    },
    setSessionOwner: function (localId, ownerId) {
      var session = sessions.get(localId);
      if (!session) return { error: "Session not found" };
      session.ownerId = ownerId;
      saveSessionFile(session);
      return { ok: true };
    },
    permissionRequestIndex: permissionRequestIndex,
  };
}

module.exports = { createSessionManager };
