var fs = require("fs");
var path = require("path");
var config = require("./config");
var utils = require("./utils");
var users = require("./users");
var tombstones = require("./tombstones");
var { CODEX_DEFAULTS, getCodexConfig } = require("./codex-defaults");
var { automationForSession, claudePermissionForAutomation } = require("./automation-modes");
var sessionPersistence = require("./sessions-persistence");
var sessionViewState = require("./sessions-view-state");
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
var sessionDeletion = require("./sessions-deletion");
var sessionLifecycle = require("./sessions-lifecycle");
var sessionQueuedMessages = require("./sessions-queued-messages");
var projectIdentity = require("./project-identity");

var CLAY_SLASH_COMMANDS = ["provider", "switch"];

function withClaySlashCommands(commands) {
  var all = CLAY_SLASH_COMMANDS.concat(Array.isArray(commands) ? commands : []);
  var result = [];
  var seen = {};
  for (var i = 0; i < all.length; i++) {
    var command = all[i];
    if (typeof command !== "string" || !command || seen[command]) continue;
    seen[command] = true;
    result.push(command);
  }
  return result;
}

// Tombstones are global across projects; a keepFn must therefore look for the
// rollout file in EVERY project dir, not just the calling project's.
function pruneGlobalTombstones(isValidCliSessionId, codexThreadIndexed) {
  var roots = [];
  try {
    var projectsRoot = path.join(config.REAL_HOME, ".claude", "projects");
    var entries = fs.readdirSync(projectsRoot);
    for (var i = 0; i < entries.length; i++) {
      roots.push(path.join(projectsRoot, entries[i]));
    }
  } catch (e) {}
  tombstones.prune(function (id) {
    if (!isValidCliSessionId(id)) return false;
    for (var ri = 0; ri < roots.length; ri++) {
      try {
        if (fs.existsSync(path.join(roots[ri], id + ".jsonl"))) return true;
      } catch (e) {}
    }
    return codexThreadIndexed(id);
  });
}

function coopHomeCandidate(session) {
  return !!session && !session.hidden && !session.orchestrationParent &&
    !session.loop && !session.taskLauncher && !session.coopChannel && session.mode !== "tui";
}

function mostRecentSession(sessionList) {
  if (!sessionList.length) return null;
  var useLastViewed = sessionList.some(function (session) { return !!session.lastViewedAt; });
  return sessionList.reduce(function (best, session) {
    if (!best) return session;
    var score = useLastViewed ? (session.lastViewedAt || 0) : (session.lastActivity || session.createdAt || 0);
    var bestScore = useLastViewed ? (best.lastViewedAt || 0) : (best.lastActivity || best.createdAt || 0);
    return score > bestScore ? session : best;
  }, null);
}

function ensureCoopHomeSession(sessions, saveSessionFile, createSession) {
  var all = [...sessions.values()];
  var marked = all.filter(function (session) {
    return session.coopHome && coopHomeCandidate(session);
  });
  var candidates = all.filter(coopHomeCandidate);
  var home = mostRecentSession(marked) || mostRecentSession(candidates);
  if (!home) home = createSession({ coopHome: true });

  sessions.forEach(function (session) {
    var shouldBeHome = session === home;
    if (!!session.coopHome === shouldBeHome) return;
    if (shouldBeHome) session.coopHome = true;
    else delete session.coopHome;
    saveSessionFile(session);
  });
  return home;
}

function createSessionManager(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var isLead = !!opts.isLead;
  var projectId = projectIdentity.isProjectId(opts.projectId) ? opts.projectId : null;
  var send = opts.send;          // function(obj) - broadcast to all clients
  var sendTo = opts.sendTo || null; // function(ws, obj) - send to specific client
  var sendEach = opts.sendEach || null; // function(fn) - call fn(ws) for each connected client
  var sendAndRecord = null;      // set after init via setSendAndRecord
  var onSessionDone = opts.onSessionDone || function () {};

  // --- Multi-session state ---
  var nextLocalId = 1;
  var sessions = new Map();     // localId -> session object
  var activeSessionId = null;   // currently active local ID
  var slashCommands = withClaySlashCommands([]); // shared across sessions (deprecated, use slashCommandsByVendor)
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

  var viewState = sessionViewState.createSessionViewState(sessionsDir);

  // CLI session ids come from untrusted WS clients and are interpolated into
  // filesystem paths. Restrict to a safe charset to prevent path traversal.
  function isValidCliSessionId(cliSid) {
    return typeof cliSid === "string" && /^[A-Za-z0-9_-]+$/.test(cliSid);
  }

  function getSessionStorageId(session) {
    return session.storageId || session.cliSessionId || null;
  }

  function setProjectId(value) {
    if (!projectIdentity.isProjectId(value)) return false;
    projectId = value;
    return true;
  }

  function getProjectId() {
    return projectId;
  }

  function getSessionRef(session) {
    return projectIdentity.sessionRef({ projectId: projectId }, session);
  }

  function resolveSessionRef(ref) {
    var normalized = projectIdentity.normalizeSessionRef(ref);
    if (!normalized || normalized.projectId !== projectId) return null;
    var resolved = null;
    sessions.forEach(function (session) {
      if (!resolved && getSessionStorageId(session) === normalized.sessionStorageId) {
        resolved = session;
      }
    });
    return resolved;
  }

  function isMeaninglessUnknownError(obj) {
    return obj &&
      obj.type === "error" &&
      String(obj.text || "").trim().toLowerCase() === "unknown";
  }

  var queuedMessagesApi = sessionQueuedMessages.attachSessionQueuedMessages({
    encodedCwd: encodedCwd,
  });
  var rebuildPendingUserMessageQueueFromHistory = queuedMessagesApi.rebuildPendingUserMessageQueueFromHistory;
  var queuedUserMessagesForClient = queuedMessagesApi.queuedUserMessagesForClient;

  var persistenceApi = sessionPersistence.attachSessionPersistence({
    getSessionStorageId: getSessionStorageId,
    sessionFilePath: sessionFilePath,
    sendEach: sendEach,
    viewState: viewState,
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
    rebuildPendingUserMessageQueueFromHistory: rebuildPendingUserMessageQueueFromHistory,
    viewState: viewState,
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
    getSessionStorageId: getSessionStorageId,
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
    return canWsAccessArchivedSession(ws, session);
  }

  // Hidden Coop worker internals stay non-navigable, but their bounded result
  // summaries may still be projected to the same owner who could see the
  // session before archival. This performs only that ACL check; callers must
  // never use it to expose the transcript or resolve the hidden session.
  function canWsAccessArchivedSession(ws, session) {
    if (!session) return false;
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
    sessions: sessions,
    projectSlug: slug,
    send: send,
    sendEach: sendEach,
    getVisibleSessions: getVisibleSessions,
    getActiveSessionId: function () { return activeSessionId; },
    getSingleUserUnread: function () { return singleUserUnread; },
    getEffectiveAutomationMode: getEffectiveAutomationMode,
  });
  var broadcastSessionList = broadcastApi.broadcastSessionList;
  var setResolveLoopInfo = broadcastApi.setResolveLoopInfo;

  var historyApi = sessionHistory.attachSessionHistory({
    send: send,
    sendTo: sendTo,
    sessions: sessions,
    isMeaninglessUnknownError: isMeaninglessUnknownError,
  });
  var HISTORY_PAGE_SIZE = historyApi.HISTORY_PAGE_SIZE;
  var findTurnBoundary = historyApi.findTurnBoundary;
  var replayHistory = historyApi.replayHistory;
  var lifecycleApi = sessionLifecycle.attachSessionLifecycle({
    sessions: sessions,
    allocateLocalId: function () { return nextLocalId++; },
    saveSessionFile: saveSessionFile,
    send: send,
    sendTo: sendTo,
    sendEach: sendEach,
    getActiveSessionId: function () { return activeSessionId; },
    setActiveSessionId: function (value) { activeSessionId = value; },
    getSingleUserUnread: function () { return singleUserUnread; },
    getCapabilitiesByVendor: function () { return capabilitiesByVendor; },
    getDefaultVendor: function () { return defaultVendor; },
    getSlashCommands: function () { return slashCommands; },
    getSlashCommandsForVendor: function (vendor) { return slashCommandsByVendor[vendor] || []; },
    getEffectiveAutomationMode: getEffectiveAutomationMode,
    queuedUserMessagesForClient: queuedUserMessagesForClient,
    broadcastSessionList: broadcastSessionList,
    replayHistory: replayHistory,
  });
  var createSession = lifecycleApi.createSession;
  var createSessionRaw = lifecycleApi.createSessionRaw;
  var switchSession = lifecycleApi.switchSession;
  var resumeSession = lifecycleApi.resumeSession;

  var deletionApi = sessionDeletion.attachSessionDeletion({
    cwd: cwd,
    sessions: sessions,
    send: send,
    sendTo: sendTo,
    sendEach: sendEach,
    getSingleUserUnread: function () { return singleUserUnread; },
    getSessionStorageId: getSessionStorageId,
    sessionFilePath: sessionFilePath,
    saveSessionFile: saveSessionFile,
    getActiveSessionId: function () { return activeSessionId; },
    setActiveSessionId: function (value) { activeSessionId = value; },
    switchSession: switchSession,
    createSession: createSession,
    broadcastSessionList: broadcastSessionList,
    mostRecentVisibleSessionForWs: mostRecentVisibleSessionForWs,
  });
  var deleteSession = deletionApi.deleteSession;
  var hideSession = deletionApi.hideSession;
  var hideSessionForActiveClients = deletionApi.hideSessionForActiveClients;
  var deleteSessionQuiet = deletionApi.deleteSessionQuiet;
  var deleteSessionsBulk = deletionApi.deleteSessionsBulk;

  var ioApi = sessionIo.attachSessionIo({
    send: send,
    sendEach: sendEach,
    appendToSessionFile: appendToSessionFile,
    saveSessionFile: saveSessionFile,
    isMeaninglessUnknownError: isMeaninglessUnknownError,
    getActiveSessionId: function () { return activeSessionId; },
    getSingleUserUnread: function () { return singleUserUnread; },
    onSessionDone: onSessionDone,
  });
  var doSendToSession = ioApi.sendToSession;
  var doSendAndRecord = ioApi.sendAndRecord;

  // Bound tombstone growth: drop entries whose underlying CLI session no longer
  // exists (nothing left to re-adopt, so the tombstone is dead weight).
  // Tombstones are GLOBAL but this code runs once per project: check every
  // project dir under ~/.claude/projects, not just this project's, or the
  // first project to load prunes every other project's tombstones and their
  // deleted sessions resurrect (2026-08-04 incident).
  try {
    ensureCodexThreadIndex();
    pruneGlobalTombstones(isValidCliSessionId, codexThreadIndexed);
  } catch (e) {}

  // --- Spawn initial session only if no persisted sessions ---
  var coopHome = null;
  if (sessions.size === 0) {
    coopHome = createSession(isLead ? { coopHome: true } : null);
  } else {
    if (isLead) {
      coopHome = ensureCoopHomeSession(sessions, saveSessionFile, createSession);
    }
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
    activeSessionId = coopHome ? coopHome.localId : (mostRecent ? mostRecent.localId : null);
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
    set slashCommands(v) { slashCommands = withClaySlashCommands(v); },
    get slashCommandsByVendor() { return slashCommandsByVendor; },
    setSlashCommandsForVendor: function(vendor, cmds) {
      slashCommandsByVendor[vendor] = withClaySlashCommands(cmds);
    },
    getSlashCommandsForVendor: function(vendor) {
      return slashCommandsByVendor[vendor] || withClaySlashCommands([]);
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
    getProjectId: getProjectId,
    setProjectId: setProjectId,
    getSessionRef: getSessionRef,
    resolveSessionRef: resolveSessionRef,
    HISTORY_PAGE_SIZE: HISTORY_PAGE_SIZE,
    getHistoryView: historyApi.getHistoryView,
    getActiveSession: getActiveSession,
    canWsAccessArchivedSession: canWsAccessArchivedSession,
    canWsAccessSession: canWsAccessSession,
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

module.exports = {
  createSessionManager: createSessionManager,
  coopHomeCandidate: coopHomeCandidate,
  ensureCoopHomeSession: ensureCoopHomeSession,
};
