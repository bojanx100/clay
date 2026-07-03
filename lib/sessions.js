var fs = require("fs");
var path = require("path");
var config = require("./config");
var utils = require("./utils");
var users = require("./users");
var tombstones = require("./tombstones");
var { CODEX_DEFAULTS, getCodexConfig } = require("./codex-defaults");
var { automationForSession, claudePermissionForAutomation } = require("./automation-modes");
var sessionPersistence = require("./sessions-persistence");
var sessionHandoff = require("./sessions-handoff");
var sessionBroadcast = require("./sessions-broadcast");
var sessionHistory = require("./sessions-history");
var sessionCliDescriptors = require("./sessions-cli-descriptors");
var sessionCliImport = require("./sessions-cli-import");
var sessionSearch = require("./sessions-search");
var sessionTitleMigration = require("./sessions-title-migration");
var sessionIo = require("./sessions-io");
var sessionLoader = require("./sessions-loader");
var sessionRecords = require("./sessions-records");

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

  var loaderApi = sessionLoader.attachSessionLoader({
    sessionsDir: sessionsDir,
    sessionFilePath: sessionFilePath,
    sessions: sessions,
    allocateLocalId: function () { return nextLocalId++; },
    saveSessionFile: saveSessionFile,
    isValidCliSessionId: isValidCliSessionId,
    ensureCodexThreadIndex: ensureCodexThreadIndex,
    codexThreadIndexed: codexThreadIndexed,
    inferCurrentVendorFromHistory: inferCurrentVendorFromHistory,
    inferCurrentProviderRouteFromHistory: inferCurrentProviderRouteFromHistory,
    inferCurrentModelFromHistory: inferCurrentModelFromHistory,
    inferCliSessionIdAfterLastHandoff: inferCliSessionIdAfterLastHandoff,
    hasVendorResponseSinceLastSwitch: hasVendorResponseSinceLastSwitch,
    shouldRecoverMissingHandoffContext: shouldRecoverMissingHandoffContext,
    recoverMissingHandoffContext: recoverMissingHandoffContext,
    handoffTurnBudgetForVendor: handoffTurnBudgetForVendor,
  });
  var loadSessions = loaderApi.loadSessions;
  var adoptSessionFile = loaderApi.adoptSessionFile;

  var cliImportApi = sessionCliImport.attachSessionCliImport({
    cwd: cwd,
    sessions: sessions,
    allocateLocalId: function () { return nextLocalId++; },
    saveSessionFile: saveSessionFile,
    broadcastSessionList: function () { broadcastSessionList(); },
    isValidCliSessionId: isValidCliSessionId,
    cliSessionsDir: cliSessionsDir,
    readCliSessionDescriptor: readCliSessionDescriptor,
    readCodexThreadNames: readCodexThreadNames,
    listCodexRolloutFiles: listCodexRolloutFiles,
    readCodexSessionDescriptor: readCodexSessionDescriptor,
    findCodexRolloutByThreadId: findCodexRolloutByThreadId,
  });
  var adoptOrphanedCliSessions = cliImportApi.adoptOrphanedCliSessions;
  var listAdoptableCliSessions = cliImportApi.listAdoptableCliSessions;
  var importCliSession = cliImportApi.importCliSession;

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

  var ioApi = sessionIo.attachSessionIo({
    send: send,
    sendEach: sendEach,
    appendToSessionFile: appendToSessionFile,
    isMeaninglessUnknownError: isMeaninglessUnknownError,
    getActiveSessionId: function () { return activeSessionId; },
    getSingleUserUnread: function () { return singleUserUnread; },
    onSessionDone: onSessionDone,
  });
  var doSendToSession = ioApi.sendToSession;
  var doSendAndRecord = ioApi.sendAndRecord;

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

  var searchApi = sessionSearch.attachSessionSearch({
    sessions: sessions,
    getActiveSessionId: function () { return activeSessionId; },
  });
  var searchSessions = searchApi.searchSessions;
  var searchSessionContent = searchApi.searchSessionContent;

  var titleMigrationApi = sessionTitleMigration.attachSessionTitleMigration({
    sessions: sessions,
  });
  var migrateSessionTitles = titleMigrationApi.migrateSessionTitles;
  var recordsApi = sessionRecords.attachSessionRecords({
    sessions: sessions,
    saveSessionFile: saveSessionFile,
    broadcastSessionList: broadcastSessionList,
  });

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
    setSessionVisibility: recordsApi.setSessionVisibility,
    setSessionBookmarked: recordsApi.setSessionBookmarked,
    reorderBookmarkedSessions: recordsApi.reorderBookmarkedSessions,
    setSessionOwner: recordsApi.setSessionOwner,
    permissionRequestIndex: permissionRequestIndex,
  };
}

module.exports = { createSessionManager };
