var usersModule = require("./users");
var leadMode = require("./lead-mode");
var userPresence = require("./user-presence");
var emailAccounts = require("./email-accounts");
var rateLimitUsageCache = require("./rate-limit-usage-cache");
var yoke = require("./yoke");
var { getCodexConfig } = require("./codex-defaults");
var { automationForSession } = require("./automation-modes");
var {
  buildOrchestrationSessionGroups,
  orchestrationStateForClient,
  orchestrationTasksForClient,
} = require("./orchestration-task-state");
var connectionState = require("./project-connection-state");
var coopConversationControl = require("./coop-conversation-control");
var coopChannels = require("./project-coop-channels");

function ensureInitialVendorState(ctx) {
  var sm = ctx.sm;
  if (!sm.installedVendors || sm.installedVendors.length === 0) {
    try {
      var installedMap = yoke.checkInstalled();
      var names = Object.keys(installedMap || {});
      var installed = [];
      for (var i = 0; i < names.length; i++) {
        if (installedMap[names[i]]) installed.push(names[i]);
      }
      sm.installedVendors = installed;
    } catch (e) {}
  }
  if ((!sm.availableVendors || sm.availableVendors.length === 0) && sm.installedVendors && sm.installedVendors.length > 0) {
    sm.availableVendors = sm.installedVendors.slice();
  }
  sm.providerRoutes = require("./provider-routes").listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []);
}

function warmupConnection(ctx, warmedUp, ws) {
  if (warmedUp.value) return;
  warmedUp.value = true;
  if (typeof ctx.warmup !== "function") return;
  try {
    ctx.warmup(ws && ws._clayUser && ws._clayUser.linuxUser ? ws._clayUser.linuxUser : undefined);
  } catch (e) {
    console.error("[project-connection] warmup failed for " + ctx.slug + ":", e && e.message ? e.message : e);
  }
}

function prepareConnection(ctx, ws, wsUser, warmedUp) {
  ensureInitialVendorState(ctx);
  ws._clayUser = wsUser || null;
  ctx.clients.add(ws);
  ctx.broadcastClientCount();
  warmupConnection(ctx, warmedUp, ws);
}

function resumeRestartedLoop(ctx) {
  var loopState = ctx._loop.loopState;
  if (!loopState._needsResume) return;
  delete loopState._needsResume;
  setTimeout(function () { ctx._loop.resumeLoop(); }, 500);
}

function buildConnectionSnapshot(ctx, ws, wsUser) {
  var sm = ctx.sm;
  var userId = ws._clayUser ? ws._clayUser.id : null;
  var filteredProjects = ctx.getProjectList(userId);
  var title = ctx.getTitle();
  var project = ctx.getProject();
  var ownerLocked = !!(ctx.osUsers && ctx.osUsers.length > 0 && /^\/home\/[^/]+\//.test(ctx.cwd));
  var allSessions = connectionState.visibleSessions(Array.from(sm.sessions.values()), {
    usersModule: usersModule,
    multiUser: usersModule.isMultiUser(),
    user: wsUser,
  });
  var presenceKey = wsUser ? wsUser.id : "_default";
  var storedPresence = userPresence.getPresence(ctx.slug, presenceKey);
  var restoredState = connectionState.findRestoredActiveSession({
    requestedSessionId: ws._clayRequestedSessionId,
    requestedSessionExact: !!ws._clayRequestedSessionExact,
    canonicalCoopHome: ctx.slug === "lead",
    storedPresence: storedPresence,
    allSessions: allSessions,
    sessions: sm.sessions,
    usersModule: usersModule,
    multiUser: usersModule.isMultiUser(),
    user: wsUser,
  });
  var orchestrationGroups = buildOrchestrationSessionGroups(allSessions);
  var modelState = connectionState.selectInitialModelState({
    active: restoredState.active,
    sessionManager: sm,
  });
  return {
    userId: userId,
    filteredProjects: filteredProjects,
    title: title,
    project: project,
    ownerLocked: ownerLocked,
    allSessions: allSessions,
    storedPresence: storedPresence,
    restoredState: restoredState,
    orchestrationGroups: orchestrationGroups,
    modelState: modelState,
    projectOwnerId: ctx.getProjectOwnerId(),
  };
}

function sendInfoState(ctx, ws, snapshot) {
  ctx.sendTo(ws, {
    type: "info",
    cwd: ctx.cwd,
    slug: ctx.slug,
    project: snapshot.title || snapshot.project,
    version: ctx.currentVersion,
    runtimeAssetId: ctx.runtimeAssetId,
    debug: !!ctx.debug,
    dangerouslySkipPermissions: ctx.dangerouslySkipPermissions,
    fullAutoMode: ctx.fullAutoMode || false,
    osUsers: ctx.osUsers,
    lanHost: ctx.lanHost,
    projectCount: snapshot.filteredProjects.length,
    projects: snapshot.filteredProjects,
    projectOwnerId: snapshot.projectOwnerId,
    ownerLocked: snapshot.ownerLocked,
  });
  if (ctx.sm.slashCommands) ctx.sendTo(ws, { type: "slash_commands", commands: ctx.sm.slashCommands });
}

function sendModelState(ctx, ws, snapshot) {
  var sm = ctx.sm;
  var active = snapshot.restoredState.active;
  var modelState = snapshot.modelState;
  ctx.sendTo(ws, {
    type: "model_info",
    model: modelState.model,
    models: modelState.models,
    vendor: modelState.vendor,
    providerRouteId: (active && active.providerRouteId) || null,
    requestedModel: (active && (active.requestedModel || active.model)) || null,
    verifiedModel: (active && active.verifiedModel) || null,
    modelVerificationSource: (active && active.modelVerificationSource) || null,
    availableVendors: sm.availableVendors || [],
    installedVendors: sm.installedVendors || [],
    providerRoutes: sm.providerRoutes || require("./provider-routes").listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []),
  });
}

function sendConfigState(ctx, ws, snapshot) {
  var sm = ctx.sm;
  var active = snapshot.restoredState.active;
  var mode = (active && active.permissionMode) || sm.currentPermissionMode || "default";
  var codexConfig = getCodexConfig(sm, active);
  var automationMode = automationForSession(active, sm.currentPermissionMode || "default", codexConfig);
  ctx.sendTo(ws, {
    type: "config_state",
    model: snapshot.modelState.model,
    mode: mode,
    automationMode: automationMode,
    effort: sm.currentEffort || "medium",
    betas: sm.currentBetas || [],
    thinking: sm.currentThinking || "adaptive",
    thinkingBudget: sm.currentThinkingBudget || 10000,
  });
  ctx.sendTo(ws, Object.assign({ type: "codex_config", automationMode: automationMode }, codexConfig));
}

function sendContextState(ctx, ws, wsUser, snapshot) {
  var emailUserId = (wsUser && wsUser.id) || "default";
  ctx.sendTo(ws, { type: "email_accounts_list", accounts: emailAccounts.listAccounts(emailUserId), providers: emailAccounts.PROVIDER_PRESETS });
  ctx.sendTo(ws, { type: "notes_list", notes: ctx.nm.list() });
  ctx.sendTo(ws, { type: "loop_registry_updated", records: ctx.getHubSchedules() });
  sendRateLimitState(ctx, ws);
}

function sendRateLimitState(ctx, ws) {
  var entries = rateLimitUsageCache.liveEntries();
  for (var i = 0; i < entries.length; i++) ctx.sendTo(ws, entries[i]);
}

function resolveLeadOwnerId(ctx, leadModeModule) {
  if (ctx.leadOwnerId) return ctx.leadOwnerId;
  if (typeof leadModeModule.resolveOwnerId !== "function") return null;
  return leadModeModule.resolveOwnerId({ usersModule: usersModule });
}

function sendUserPreferenceState(ctx, ws, wsUser) {
  if (usersModule && typeof usersModule.getClaudeOpenMode === "function") {
    var userId = (wsUser && wsUser.id) || "default";
    var value = usersModule.getClaudeOpenMode(userId);
    var defaultMode = typeof usersModule.defaultClaudeOpenMode === "function" ? usersModule.defaultClaudeOpenMode() : "gui";
    ctx.sendTo(ws, { type: "claude_open_mode_changed", claudeOpenMode: value || defaultMode });
  }
  var leadModeModule = ctx.leadMode || leadMode;
  var ownerId = resolveLeadOwnerId(ctx, leadModeModule);
  var leadState = leadModeModule.publicState(leadModeModule.getLeadModeState({ usersModule: usersModule, ownerId: ownerId }));
  leadState.type = "lead_mode_changed";
  leadState.canChange = leadModeModule.isAuthority(wsUser || null, usersModule.isMultiUser(), ownerId);
  ctx.sendTo(ws, leadState);
}

function sendWhatsNewState(ctx, ws, wsUser) {
  try {
    var whatsNew = require("./whats-new");
    var userId = (wsUser && wsUser.id) || null;
    var state = userId ? whatsNew.getStateForUser(userId) : { entries: whatsNew.listEntries(), unseenIds: [] };
    if (state.entries.length > 0) ctx.sendTo(ws, { type: "whats_new_state", entries: state.entries, unseenIds: state.unseenIds });
  } catch (e) {
    if (ctx.debug) console.error("[project] whats_new send failed:", e && e.message);
  }
}

function sendConnectionSubsystemState(ctx, ws) {
  ctx._loop.sendConnectionState(ws);
  if (ctx._mcp) ctx._mcp.sendConnectionState(ws);
  if (ctx._notifications) ctx._notifications.sendConnectionState(ws, ctx.sendTo);
}

function sendSessionList(ctx, ws, snapshot) {
  ctx.sendTo(ws, {
    type: "session_list",
    projectSlug: ctx.slug,
    sessions: connectionState.serializeSessionList(snapshot.allSessions, {
      restoredActive: snapshot.restoredState.active,
      activeSessionId: snapshot.restoredState.exactMiss ? null : ctx.sm.activeSessionId,
      loopRegistry: ctx._loop.loopRegistry,
      orchestrationGroups: snapshot.orchestrationGroups,
    }),
  });
}

function isCoopClient(ctx) {
  return ctx.slug === "lead";
}

function globalProjectionProvider(ctx) {
  return ctx.getGlobalCoopProjection || ctx.opts && ctx.opts.getGlobalCoopProjection;
}

function sessionRefResolver(ctx) {
  return ctx.resolveGlobalSessionRef || ctx.opts && ctx.opts.resolveGlobalSessionRef;
}

function sendGlobalCoopProjection(ctx, ws) {
  var provider = globalProjectionProvider(ctx);
  if (!isCoopClient(ctx) || typeof provider !== "function") return;
  var projection = provider(ws);
  if (projection) ctx.sendTo(ws, projection);
}

function sendInitialState(ctx, ws, wsUser, snapshot) {
  sendInfoState(ctx, ws, snapshot);
  sendModelState(ctx, ws, snapshot);
  sendConfigState(ctx, ws, snapshot);
  sendContextState(ctx, ws, wsUser, snapshot);
  sendUserPreferenceState(ctx, ws, wsUser);
  sendWhatsNewState(ctx, ws, wsUser);
  sendConnectionSubsystemState(ctx, ws);
  sendGlobalCoopProjection(ctx, ws);
  sendSessionList(ctx, ws, snapshot);
}

function claimRestoredSession(ctx, ws, wsUser, active) {
  if (!active.ownerId && wsUser && usersModule.isMultiUser()) {
    active.ownerId = wsUser.id;
    ctx.sm.saveSessionFile(active);
  }
  ws._clayActiveSession = active.localId;
  active.lastViewedAt = Date.now();
  ctx.sm.saveSessionFile(active);
  if (typeof ctx.resolveSessionForView === "function") {
    try { ctx.resolveSessionForView(active, ws); } catch (e) {}
  }
}

function sessionSwitchedIdentity(active) {
  return {
    type: "session_switched",
    id: active.localId,
    title: active.title || null,
    cliSessionId: active.cliSessionId || null,
    loop: active.loop || null,
    vendor: active.vendor || null,
    providerRouteId: active.providerRouteId || null,
    coopHome: !!active.coopHome,
    coopChannel: coopChannels.channelForClient(active.coopChannel),
  };
}

function sessionSwitchedProvider(ctx, active) {
  var sm = ctx.sm;
  var capabilities = (sm.capabilitiesByVendor && sm.capabilitiesByVendor[active.vendor || sm.defaultVendor || "claude"]) || {};
  return {
    requestedModel: active.requestedModel || active.model || null,
    verifiedModel: active.verifiedModel || null,
    modelVerificationSource: active.modelVerificationSource || null,
    automationMode: automationForSession(active, sm.currentPermissionMode || "default", getCodexConfig(sm, active)),
    permissionMode: active.permissionMode || null,
    codexApproval: active.codexApproval || null,
    codexSandbox: active.codexSandbox || null,
    codexWebSearch: active.codexWebSearch || null,
    hasHistory: !!(active.history && active.history.length > 0),
    capabilities: capabilities,
  };
}

function sessionSwitchedRuntime(ctx, active) {
  var sm = ctx.sm;
  return {
    isProcessing: !!active.isProcessing,
    mode: active.mode || "gui",
    terminalId: typeof active.terminalId === "number" ? active.terminalId : null,
    runtimeMode: active.runtimeMode || null,
    runtimeTerminalId: typeof active.runtimeTerminalId === "number" ? active.runtimeTerminalId : null,
    tuiSuspended: !!active.tuiSuspended,
    queueingDisabled: !!active.queueingDisabled,
    queuedUserMessages: sm.queuedUserMessagesForClient ? sm.queuedUserMessagesForClient(active) : [],
    orchestrationTasks: orchestrationTasksForClient(active),
    orchestrationState: orchestrationStateForClient(active),
    coopConversationState: coopConversationControl.clientState(active),
  };
}

function sendSessionSwitched(ctx, ws, active) {
  ctx.sendTo(ws, Object.assign(
    sessionSwitchedIdentity(active),
    sessionSwitchedProvider(ctx, active),
    sessionSwitchedRuntime(ctx, active),
    connectionState.orchestrationSessionFields(active)
  ));
}

function replayRestoredSession(ctx, ws, active) {
  ctx.sendTo(ws, { type: "term_list", terminals: ctx.tm.list(active.localId) });
  ctx.sendTo(ws, { type: "context_sources_state", active: ctx.loadContextSources(ctx.slug, active.localId) });
  ctx.sm.replayHistory(active, undefined, ws, ctx.hydrateImageRefs);
  if (active.isProcessing) ctx.sendTo(ws, { type: "status", status: "processing" });
  if (typeof ctx.autoResumeRestartSession === "function") ctx.autoResumeRestartSession(active);
  sendPendingPermissions(ctx, ws, active);
}

function sendPendingPermissions(ctx, ws, active) {
  var pendingIds = Object.keys(active.pendingPermissions);
  for (var i = 0; i < pendingIds.length; i++) {
    var pending = active.pendingPermissions[pendingIds[i]];
    ctx.sendTo(ws, {
      type: "permission_request_pending",
      requestId: pending.requestId,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
      toolUseId: pending.toolUseId,
      decisionReason: pending.decisionReason,
      mateId: pending.mateId || undefined,
    });
  }
}

function createActiveSession(ctx, ws, wsUser) {
  var options = {};
  if (wsUser && usersModule.isMultiUser()) options.ownerId = wsUser.id;
  return ctx.sm.createSession(options, ws);
}

function restoreOrCreateActiveSession(ctx, ws, wsUser, snapshot) {
  var active = snapshot.restoredState.active;
  var autoCreated = false;
  if (!active && snapshot.restoredState.exactMiss) {
    return {
      active: null,
      autoCreated: false,
      storedPresence: snapshot.restoredState.storedPresence,
    };
  }
  if (!active) {
    active = createActiveSession(ctx, ws, wsUser);
    autoCreated = true;
  }
  if (active && !autoCreated) {
    claimRestoredSession(ctx, ws, wsUser, active);
    sendSessionSwitched(ctx, ws, active);
    replayRestoredSession(ctx, ws, active);
  }
  return {
    active: active,
    autoCreated: autoCreated,
    storedPresence: snapshot.restoredState.storedPresence,
  };
}

function sendAutoCreatedContextSources(ctx, ws, active) {
  var emailModule = ctx._email;
  var saveContextSources = ctx.saveContextSources;
  if (emailModule && emailModule.getEmailDefaults && saveContextSources) {
    var defaults = emailModule.getEmailDefaults();
    if (defaults.length > 0) {
      var sources = defaults.map(function (id) { return "email:" + id; });
      saveContextSources(ctx.slug, active.localId, sources);
      ctx.sendTo(ws, { type: "context_sources_state", active: sources });
      return;
    }
  }
  ctx.sendTo(ws, { type: "context_sources_state", active: [] });
}

function restorePresenceAndDebate(ctx, ws, wsUser, restored, active) {
  var presenceKey = wsUser ? wsUser.id : "_default";
  if (active) {
    userPresence.setPresence(ctx.slug, presenceKey, active.localId, restored.storedPresence ? restored.storedPresence.mateDm : null);
    if (restored.autoCreated) sendAutoCreatedContextSources(ctx, ws, active);
  }
  if (restored.storedPresence && restored.storedPresence.mateDm && !ctx.isMate) {
    ctx.sendTo(ws, { type: "restore_mate_dm", mateId: restored.storedPresence.mateDm });
  }
  ctx.broadcastPresence();
  ctx.restoreDebateState(ws);
  replayPendingDebates(ctx, ws);
}

function replayPendingDebates(ctx, ws) {
  if (!ctx.pendingDebateProposals) return;
  for (var key in ctx.pendingDebateProposals) {
    var pending = ctx.pendingDebateProposals[key];
    if (pending && pending.briefData) ctx.sendTo(ws, { type: "debate_proposal_pending", briefData: pending.briefData });
  }
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (e) {
    return null;
  }
}

function writeDiagnostic(ctx, line) {
  try {
    if (typeof ctx.diagLog === "function") ctx.diagLog(line);
    else require("./config").diagLog(line);
  } catch (e) {}
}

function sendHandlerError(ctx, ws, msg, err) {
  var line = "[WS-HANDLER-ERROR] " + new Date().toISOString() +
    " type=" + (msg && msg.type) + " " + (err && err.stack || err);
  console.error(line);
  writeDiagnostic(ctx, line);
  try {
    ctx.sendTo(ws, {
      type: "toast",
      level: "error",
      message: "Something went wrong handling that action (" + (msg && msg.type) + "). The server kept running — check the diagnostics log.",
    });
  } catch (e2) {}
}

function sendSessionRefResolution(ctx, ws, result) {
  if (!result.ok) {
    ctx.sendTo(ws, { type: "session_ref_resolved", ok: false, code: result.code });
    return;
  }
  ctx.sendTo(ws, {
    type: "session_ref_resolved",
    ok: true,
    sessionRef: result.ref,
    slug: result.project.slug,
    localId: result.session.localId,
  });
}

function handleGlobalCoopMessage(ctx, ws, msg) {
  if (!msg || msg.type !== "resolve_session_ref") return false;
  var resolve = sessionRefResolver(ctx);
  if (!isCoopClient(ctx) || typeof resolve !== "function") {
    sendSessionRefResolution(ctx, ws, { ok: false, code: "access_denied" });
    return true;
  }
  sendSessionRefResolution(ctx, ws, resolve(msg.sessionRef || msg.ref, ws));
  return true;
}

function handleSocketMessage(ctx, ws, raw, handleMessage) {
  var msg = parseMessage(raw);
  if (!msg) return;
  try {
    if (handleGlobalCoopMessage(ctx, ws, msg)) return;
    handleMessage(ws, msg);
  } catch (err) {
    sendHandlerError(ctx, ws, msg, err);
  }
}

function handleDisconnection(ctx, ws) {
  if (ws._clayActiveSession) {
    var presenceKey = ws._clayUser ? ws._clayUser.id : "_default";
    var existing = userPresence.getPresence(ctx.slug, presenceKey);
    userPresence.setPresence(ctx.slug, presenceKey, ws._clayActiveSession, existing ? existing.mateDm : null);
  }
  ctx.tm.detachAll(ws);
  ctx.clients.delete(ws);
  if (ctx.clients.size === 0) {
    ctx.stopFileWatch();
    ctx.stopAllDirWatches();
  }
  ctx.broadcastClientCount();
  ctx.broadcastPresence();
}

function attachConnectionHandlers(ctx) {
  var warmedUp = { value: false };

  function handleConnection(ws, wsUser, handleMessage, handleDisconnectionCallback) {
    prepareConnection(ctx, ws, wsUser, warmedUp);
    resumeRestartedLoop(ctx);
    var snapshot = buildConnectionSnapshot(ctx, ws, wsUser);
    sendInitialState(ctx, ws, wsUser, snapshot);
    var restored = restoreOrCreateActiveSession(ctx, ws, wsUser, snapshot);
    restorePresenceAndDebate(ctx, ws, wsUser, restored, restored.active);
    ws.on("message", function (raw) { handleSocketMessage(ctx, ws, raw, handleMessage); });
    ws.on("close", function () { handleDisconnectionCallback(ws); });
  }

  function disconnect(ws) {
    handleDisconnection(ctx, ws);
  }

  return { handleConnection: handleConnection, handleDisconnection: disconnect };
}

module.exports = {
  attachConnectionHandlers: attachConnectionHandlers,
  handleDisconnection: handleDisconnection,
};
