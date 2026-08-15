var crypto = require("crypto");
var { CODEX_DEFAULTS } = require("./codex-defaults");
var { automationForClaudePermission, automationForCodexConfig } = require("./automation-modes");
var { defaultModelForVendor } = require("./model-selection");
var handoffTraces = require("./coop-handoff-traces");
var yoke = require("./yoke");

function handoffTraceOwnerId(ws, usersModule) {
  var userId = ws && ws._clayUser && ws._clayUser.id;
  if (typeof userId === "string" && userId.trim()) return userId.trim();
  if (usersModule && usersModule.isMultiUser && usersModule.isMultiUser()) return null;
  return "_single_user";
}

function stableNavigationTarget(slug, session) {
  var sessionStorageId = session && (session.storageId || session.cliSessionId);
  return handoffTraces.normalizeTarget({ projectSlug: slug, sessionStorageId: sessionStorageId });
}

function handoffNavigationAction(msg) {
  return msg && msg.handoffAction === "clickable_session_ref"
    ? "clickable_session_ref" : "switch_session";
}

function hasHandoffTraceId(msg) {
  return !!(msg && typeof msg.handoffTraceId === "string" && msg.handoffTraceId.trim());
}

function attachProjectSessionsLifecycle(ctx) {
  var slug = ctx.slug;
  var sm = ctx.sm;
  var tm = ctx.tm;
  var sendTo = ctx.sendTo;
  var send = ctx.send;
  var onSetProjectLastVendor = ctx.onSetProjectLastVendor;
  var usersModule = ctx.usersModule;
  var userPresence = ctx.userPresence;
  var getSessionForWs = ctx.getSessionForWs;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var broadcastPresence = ctx.broadcastPresence;
  var loadContextSources = ctx.loadContextSources;
  var saveContextSources = ctx.saveContextSources;
  var getClaudeOpenModeForWs = ctx.getClaudeOpenModeForWs;
  var viewHandlers = ctx.viewHandlers;
  var tuiHandlers = ctx.tuiHandlers;
  var email = ctx.email;
  var coopHandoffTraceStore = ctx.coopHandoffTraceStore || handoffTraces.createStore();

  function canViewSession(ws, session) {
    if (!session || session.hidden) return false;
    if (!usersModule || !usersModule.isMultiUser || !usersModule.isMultiUser()) {
      return !session.ownerId;
    }
    return !!(ws && ws._clayUser && usersModule.canAccessSession(
      ws._clayUser.id, session, { visibility: "public" }));
  }

  function recordHandoffFailure(ws, msg, method) {
    if (!hasHandoffTraceId(msg)) return;
    var ownerId = handoffTraceOwnerId(ws, usersModule);
    if (!ownerId || !coopHandoffTraceStore[method]) return;
    coopHandoffTraceStore[method]({ intentId: msg.handoffTraceId, ownerId: ownerId });
  }

  function recordHandoffNavigation(ws, msg, target) {
    if (!hasHandoffTraceId(msg)) return;
    var ownerId = handoffTraceOwnerId(ws, usersModule);
    if (!ownerId || !target) return;
    coopHandoffTraceStore.recordNavigation({
      intentId: msg.handoffTraceId,
      ownerId: ownerId,
      action: handoffNavigationAction(msg),
      target: target,
    });
  }

  function getServerDefaultCodexConfig() {
    return Object.assign({}, sm.serverDefaultCodexConfig || {
      approval: CODEX_DEFAULTS.approval,
      sandbox: CODEX_DEFAULTS.sandbox,
      webSearch: CODEX_DEFAULTS.webSearch,
    });
  }

  function createSessionForMessage(ws, msg) {
      var sessionOpts = {};
      if (ws._clayUser && usersModule.isMultiUser()) sessionOpts.ownerId = ws._clayUser.id;
      if (msg.sessionVisibility) sessionOpts.sessionVisibility = msg.sessionVisibility;
      if (msg.coordinator === true) sessionOpts.coordinationMode = true;
      var newSessionVendor = msg.vendor || sm.defaultVendor || "claude";
      if (yoke.getVendorInfo(newSessionVendor)) sessionOpts.vendor = newSessionVendor;
      if (!sessionOpts.vendor) sessionOpts.vendor = "claude";
      var newSessionModel = defaultModelForVendor(sm, sessionOpts.vendor);
      if (newSessionModel) sessionOpts.model = newSessionModel;
      if (sessionOpts.vendor === "codex" || sessionOpts.vendor === "github-copilot") {
        var newCodexDefaults = getServerDefaultCodexConfig();
        sessionOpts.codexApproval = newCodexDefaults.approval || CODEX_DEFAULTS.approval;
        sessionOpts.codexSandbox = newCodexDefaults.sandbox || CODEX_DEFAULTS.sandbox;
        sessionOpts.codexWebSearch = newCodexDefaults.webSearch || CODEX_DEFAULTS.webSearch;
        sessionOpts.automationMode = automationForCodexConfig(sessionOpts.codexApproval, sessionOpts.codexSandbox);
        sessionOpts.permissionMode = sessionOpts.automationMode === "full" ? "bypassPermissions" : "default";
      } else {
        sessionOpts.permissionMode = sm.serverDefaultMode || sm._savedDefaultMode || sm.currentPermissionMode || "default";
        sessionOpts.automationMode = automationForClaudePermission(sessionOpts.permissionMode);
        sessionOpts.dangerouslySkipPermissions = sessionOpts.permissionMode === "bypassPermissions";
      }
      sm.currentEffort = sm.serverDefaultEffort || sm.currentEffort || "medium";
      // Vendors without a TUI session mode are always GUI. TUI-capable
      // sessions honor the explicit msg.mode if provided, otherwise
      // fall back to the user's claudeOpenMode preference. This is what
      // makes the sidebar's "Claude" icon button create the right kind of
      // session without the client needing to know the preference.
      var requestedMode;
      if (!yoke.supportsSessionMode(sessionOpts.vendor, "tui")) {
        requestedMode = "gui";
      } else if (msg.mode === "tui" || msg.mode === "gui") {
        requestedMode = msg.mode;
      } else {
        requestedMode = getClaudeOpenModeForWs(ws);
      }
      var newSess;
      if (requestedMode === "tui") {
        // TUI sessions own their cliSessionId up-front so we can launch
        // `claude --session-id <uuid>` and resume the same conversation
        // from external terminals (claude --resume <uuid>) and from the
        // jsonl watcher (~/.claude/projects/<cwd>/<uuid>.jsonl).
        //
        // Construction order matters: createSession() fires session_switched
        // synchronously, so we must populate terminalId on the record before
        // switching. Use createSessionRaw + switchSession to get the right
        // ordering and avoid an extra rebroadcast.
        sessionOpts.mode = "tui";
        sessionOpts.cliSessionId = crypto.randomUUID();
        sessionOpts.vendor = sessionOpts.vendor || "claude";
        // Per-session bypass-permissions: TUI shell command only. The flag is
        // persisted on the session so lazy-resume re-spawns the same way.
        if (msg.dangerouslySkipPermissions) {
          sessionOpts.dangerouslySkipPermissions = true;
          sessionOpts.permissionMode = "bypassPermissions";
          sessionOpts.automationMode = "full";
        }
        newSess = sm.createSessionRaw(sessionOpts);
        if (tm) {
          var tuiSid = newSess.cliSessionId;
          var tuiLocalId = newSess.localId;
          var tuiCmd = "claude --session-id " + tuiSid + tuiHandlers.claudeModelFlagForSession(newSess) + tuiHandlers.claudePermissionFlagForSession(newSess) + "; exit\n";
          var tuiTerm = tm.create(80, 24, getOsUserInfoForWs(ws), ws, {
            initialInput: tuiCmd,
            kind: "tui-session",
            sessionId: newSess.localId,
            title: "claude " + tuiSid.slice(0, 8),
            onExit: function (termSession) {
              var s = sm.sessions.get(tuiLocalId);
              if (!s) return;
              if (termSession && termSession.reclaimed) {
                // Reclaimed (idle sweep or explicit Close), not a real /exit:
                // keep the session (its jsonl transcript stays on disk and
                // lazy-resume can re-spawn claude). Just drop the dead PTY link.
                s.terminalId = null;
                try { sm.saveSessionFile(s); } catch (e) {}
                try { sm.broadcastSessionList(); } catch (e) {}
              } else {
                try { sm.deleteSessionQuiet(tuiLocalId); } catch (e) {}
                try { sm.broadcastSessionList(); } catch (e) {}
              }
            },
            onData: tuiHandlers.makeTuiActivityHook(tuiLocalId),
          });
          if (tuiTerm) {
            newSess.terminalId = tuiTerm.id;
          }
        }
        // Persist immediately so the session reappears in the sidebar
        // after a daemon restart (the SDK path saves on stream events,
        // but TUI sessions never produce any so this is our only chance).
        try { sm.saveSessionFile(newSess); } catch (e) {}
        tuiHandlers.startTitleWatcher(newSess);
        sm.switchSession(newSess.localId, ws);
      } else {
        newSess = sm.createSession(sessionOpts, ws);
      }
      ws._clayActiveSession = newSess.localId;
      // Only an explicit picker choice changes the project default. Internal
      // session creation without msg.vendor must not silently overwrite it.
      if (msg.vendor && sm.lastVendor !== msg.vendor) {
        sm.lastVendor = msg.vendor;
        if (typeof onSetProjectLastVendor === "function") onSetProjectLastVendor(slug, msg.vendor);
        if (typeof send === "function") send({ type: "last_vendor", vendor: msg.vendor });
      }
      // Apply project-level email defaults to new session
      if (typeof email === "object" && email.getEmailDefaults) {
        var emailDefaults = email.getEmailDefaults();
        if (emailDefaults.length > 0) {
          var defaultSources = emailDefaults.map(function (id) { return "email:" + id; });
          saveContextSources(slug, newSess.localId, defaultSources);
          sendTo(ws, { type: "context_sources_state", active: defaultSources });
        }
      }
      var nsPresKey = ws._clayUser ? ws._clayUser.id : "_default";
      userPresence.setPresence(slug, nsPresKey, newSess.localId, null);
      if (usersModule.isMultiUser()) {
        broadcastPresence();
      }
      return newSess;
  }

  function handleLifecycleMessage(ws, msg) {
    if (msg.type === "new_session") {
      createSessionForMessage(ws, msg);
      return true;
    }

    if (msg.type === "switch_session") {
      // Prefer the persistent storageId when provided: localId is a throwaway
      // counter reassigned on every restart, so a stale localId (e.g. from the
      // auto-launch activity history) can resolve to the wrong live session.
      // Resolve storageId -> current localId; ignore if no live session matches
      // (the original was deleted), which makes the click a clean no-op.
      if (msg.storageId) {
        var xsResolved = null;
        sm.sessions.forEach(function (s) {
          if (xsResolved == null && (s.storageId === msg.storageId || s.cliSessionId === msg.storageId)) {
            xsResolved = s.localId;
          }
        });
        msg.id = xsResolved;
      }
      if (!msg.id || !sm.sessions.has(msg.id) || sm.sessions.get(msg.id).hidden) {
        recordHandoffFailure(ws, msg, "recordNoMatch");
        return true;
      }
      if (msg.id && sm.sessions.has(msg.id)) {
        // resolveSessionForView sets runtimeMode / runtimeTerminalId /
        // tuiSuspended (and hydrates the transcript) before sm.switchSession
        // broadcasts session_switched. A live runtime keeps its actual mode
        // for every viewer; only cold sessions follow the clicker's
        // claudeOpenMode pref. Nothing is spawned here. The codex branch
        // hydrates session.history from the rollout file for imported
        // sessions; live codex sessions short-circuit.
        var xmTarget = sm.sessions.get(msg.id);
        var multiUser = usersModule && usersModule.isMultiUser && usersModule.isMultiUser();
        if (!canViewSession(ws, xmTarget)) {
          recordHandoffFailure(ws, msg, "recordRejectedAccess");
          return true;
        }
        if (xmTarget) {
          // Guard identically to the connect/restore path
          // (project-connection.js): if view-prep throws (e.g. a Codex session
          // whose rollout file can't be hydrated), the switch must still
          // proceed so session_switched is broadcast. An unguarded throw here
          // both silently fails the open (the tap does "nothing") and can crash
          // the daemon.
          try {
            viewHandlers.resolveSessionForView(xmTarget, ws);
          } catch (e) {}
        }
        // If the target session's vendor doesn't own the currently cached
        // model, clear sm.currentModel so the UI and next query don't leak
        // the previous session's vendor-specific model into this one.
        var switchTargetSess = sm.sessions.get(msg.id);
        if (switchTargetSess && sm.currentModel) {
          var targetVendor = switchTargetSess.vendor || sm.defaultVendor || null;
          var tvModels = (targetVendor && sm.modelsByVendor && sm.modelsByVendor[targetVendor]) || [];
          var found = false;
          var _curLc = sm.currentModel.toLowerCase();
          for (var tvi = 0; tvi < tvModels.length; tvi++) {
            var tvEntry = tvModels[tvi];
            var tvVal = typeof tvEntry === "string" ? tvEntry : (tvEntry && (tvEntry.value || tvEntry.model || tvEntry.id)) || "";
            if (tvVal === sm.currentModel || (tvVal && (tvVal.toLowerCase().indexOf(_curLc) !== -1 || _curLc.indexOf(tvVal.toLowerCase()) !== -1))) { found = true; break; }
          }
          if (tvModels.length > 0 && !found) {
            sm.currentModel = "";
          }
        }
        // Access was checked before view preparation, so only authorized
        // stable targets can become runtime handoff evidence.
        var topicReplay = ws._clayTopicReplayOptions || null;
        delete ws._clayTopicReplayOptions;
        var replayOptions = topicReplay && topicReplay.sessionLocalId === msg.id
          ? topicReplay.options : null;
        if (multiUser) {
          ws._clayActiveSession = msg.id;
          sm.switchSession(msg.id, ws, hydrateImageRefs, replayOptions);
          broadcastPresence();
        } else {
          ws._clayActiveSession = msg.id;
          sm.switchSession(msg.id, ws, hydrateImageRefs, replayOptions);
        }
        var stableTarget = stableNavigationTarget(slug, xmTarget);
        if (stableTarget) recordHandoffNavigation(ws, msg, stableTarget);
        else recordHandoffFailure(ws, msg, "recordMissingStableTarget");
        // Send per-session context sources
        if (typeof loadContextSources === "function") {
          var switchedSources = loadContextSources(slug, msg.id);
          sendTo(ws, { type: "context_sources_state", active: switchedSources });
        }
        sendTo(ws, { type: "term_list", terminals: tm.list(msg.id) });
        var swPresKey = ws._clayUser ? ws._clayUser.id : "_default";
        userPresence.setPresence(slug, swPresKey, msg.id, null);
      }
      return true;
    }

    if (msg.type === "sync_external_session") {
      var syncTarget = null;
      var requestedSyncTarget = msg.id && sm.sessions.has(msg.id) ? sm.sessions.get(msg.id) : null;
      if (canViewSession(ws, requestedSyncTarget)) syncTarget = requestedSyncTarget;
      if (!syncTarget) {
        var currentSyncTarget = getSessionForWs(ws);
        if (canViewSession(ws, currentSyncTarget)) syncTarget = currentSyncTarget;
      }
      if (!syncTarget) return true;
      if (syncTarget.vendor === "codex") {
        var beforeMtime = syncTarget._historyMtime || 0;
        viewHandlers.resolveSessionForView(syncTarget, ws);
        var afterMtime = syncTarget._historyMtime || 0;
        if (afterMtime && afterMtime !== beforeMtime) {
          sm.switchSession(syncTarget.localId, ws, hydrateImageRefs);
        }
        return true;
      }
      // Non-Codex (Claude etc.): live messages are broadcast fire-and-forget and
      // only replayed on a full reconnect/refresh. A wake/focus/interaction probe
      // that recovers a zombie socket WITHOUT a full reconnect, or a client whose
      // server-side active session drifted from what it's actually viewing (a
      // server-initiated switch reassigns every socket's _clayActiveSession),
      // would otherwise stay behind until a manual refresh. Re-switch (full
      // replay - the same battle-tested path as reconnect) only when this socket
      // is genuinely behind, so a current client never re-renders / flickers:
      //   (a) the server thinks this socket views a different session than the
      //       client reported (msg.id) - it's been missing this session's
      //       broadcasts; or
      //   (b) the live history grew past what this socket was last caught up to.
      var deliveredLen = ws._clayDeliveredLen || 0;
      var mismatched = msg.id && ws._clayActiveSession !== syncTarget.localId;
      var behind = syncTarget.history && syncTarget.history.length > deliveredLen;
      if (mismatched || behind) {
        sm.switchSession(syncTarget.localId, ws, hydrateImageRefs);
      }
      return true;
    }

    return false;
  }

  return {
    createSessionForMessage: createSessionForMessage,
    handleLifecycleMessage: handleLifecycleMessage,
  };
}

module.exports = { attachProjectSessionsLifecycle: attachProjectSessionsLifecycle };
