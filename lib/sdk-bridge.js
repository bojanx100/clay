var usersModule = require("./users");
var { getCodexConfig } = require("./codex-defaults");
var { withClaudeFallbackModels } = require("./claude-defaults");
var { claudePermissionForAutomation, automationForClaudePermission } = require("./automation-modes");
var { listProviderRoutes } = require("./provider-routes");
var { attachSkillDiscovery } = require("./sdk-skill-discovery");
var { attachBridgePermissions } = require("./sdk-bridge-permissions");

// Opt-in per-event tracing. Logging every streamed event synchronously stalls
// the event loop during heavy command output and delays WebSocket heartbeat
// pongs (root cause of the "random freeze / auto-refresh"). Silent by default;
// set CLAY_DEBUG_EVENTS=1 to re-enable.
var CLAY_DEBUG_EVENTS = process.env.CLAY_DEBUG_EVENTS === "1";
var { createMessageQueue } = require("./sdk-message-queue");
var { attachMessageProcessor } = require("./sdk-message-processor");
var { meaningfulTextTitle } = require("./text-title");
var { recordRecoveryEvent } = require("./recovery-log");
var { attachBridgeAuth } = require("./sdk-bridge-auth");
var { attachBridgeModels } = require("./sdk-bridge-models");
var { extractMcpDescriptors, callMcpToolHandler, mergeMcpServers } = require("./sdk-bridge-mcp");
var { attachAutoTitle } = require("./sdk-bridge-auto-title");
var { attachIdleReaper } = require("./sdk-bridge-idle-reaper");
var { attachBridgeProcesses } = require("./sdk-bridge-processes");
var { attachBridgeDialogs } = require("./sdk-bridge-dialogs");
var { attachBridgeRecovery } = require("./sdk-bridge-recovery");
var { attachBridgeWarmup } = require("./sdk-bridge-warmup");
var { attachBridgeControls } = require("./sdk-bridge-controls");

function createSDKBridge(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var sm = opts.sessionManager;   // session manager instance
  var send = opts.send;           // broadcast to all clients
  var pushModule = opts.pushModule;
  var getNotificationsModule = opts.getNotificationsModule || function () { return null; };
  var adapter = opts.adapter;
  var adapters = opts.adapters || {};
  var mateDisplayName = opts.mateDisplayName || "";
  var isMate = opts.isMate || (slug.indexOf("mate-") === 0);
  var dangerouslySkipPermissions = opts.dangerouslySkipPermissions || false;
  // mcpServers may be either a static object or a getter function. The
  // getter form lets callers gate individual servers at call time (e.g.
  // clay-browser is only exposed while the Chrome extension is connected).
  var _mcpServersSrc = opts.mcpServers || null;
  function getMcpServers() {
    if (typeof _mcpServersSrc === "function") return _mcpServersSrc() || null;
    return _mcpServersSrc;
  }
  var getRemoteMcpServers = opts.getRemoteMcpServers || null;
  var clayPort = opts.clayPort || 2633;
  var clayTls = opts.clayTls || false;
  var clayAuthToken = opts.clayAuthToken || null;
  var onProcessingChanged = opts.onProcessingChanged || function () {};
  var onWorktreeChange = opts.onWorktreeChange || function () {};
  var bridgeAuth = attachBridgeAuth({
    getNotificationsModule: getNotificationsModule,
    slug: slug,
    adapter: adapter,
  });
  var getFreshAuthState = bridgeAuth.getFreshAuthState;
  var isAuthErrorMessage = bridgeAuth.isAuthErrorMessage;
  var getLoginCommand = bridgeAuth.getLoginCommand;
  var getVendorDisplayName = bridgeAuth.getVendorDisplayName;
  var notifyAuthRequired = bridgeAuth.notifyAuthRequired;
  var logAuthDecision = bridgeAuth.logAuthDecision;

  var bridgeRecovery = attachBridgeRecovery({ opts: opts });
  var isTransientStreamError = bridgeRecovery.isTransientStreamError;
  var autoResumeAllowed = bridgeRecovery.autoResumeAllowed;
  var scheduleInterruptResume = bridgeRecovery.scheduleInterruptResume;
  var rateLimitResumeLabel = bridgeRecovery.rateLimitResumeLabel;

  var bridgeModels = attachBridgeModels({
    sm: sm,
    send: send,
    adapter: adapter,
  });
  var getModelsForVendor = bridgeModels.getModelsForVendor;
  var getModelsForSession = bridgeModels.getModelsForSession;
  var copilotRouteIdForModel = bridgeModels.copilotRouteIdForModel;
  var modelEntryValue = bridgeModels.modelEntryValue;
  var modelListContains = bridgeModels.modelListContains;
  var resolveModelInList = bridgeModels.resolveModelInList;
  var sendModelInfoForVendor = bridgeModels.sendModelInfoForVendor;
  var onTurnDone = opts.onTurnDone || null;

  var idleReaper = attachIdleReaper({ sm: sm });
  var startIdleReaper = idleReaper.startIdleReaper;
  var stopIdleReaper = idleReaper.stopIdleReaper;

  // --- Skill discovery (extracted to sdk-skill-discovery.js) ---
  var skills = attachSkillDiscovery({ cwd: cwd });
  var discoverSkillDirs = skills.discoverSkillDirs;
  var mergeSkills = skills.mergeSkills;

  var bridgeWarmup = attachBridgeWarmup({
    adapter: adapter,
    adapters: adapters,
    sm: sm,
    send: send,
    cwd: cwd,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    clayPort: clayPort,
    clayTls: clayTls,
    clayAuthToken: clayAuthToken,
    slug: slug,
    discoverSkillDirs: discoverSkillDirs,
    mergeSkills: mergeSkills,
    getModelsForVendor: getModelsForVendor,
  });
  var warmup = bridgeWarmup.warmup;

  var autoTitle = attachAutoTitle({
    cwd: cwd,
    sm: sm,
    adapter: adapter,
    getAdapterForSession: getAdapterForSession,
  });
  var autoGenerateTitle = autoTitle.autoGenerateTitle;

  // --- Message processing (extracted to sdk-message-processor.js) ---
  var msgProcessor = attachMessageProcessor({
    sm: sm,
    send: send,
    slug: slug,
    cwd: cwd,
    isMate: isMate,
    mateDisplayName: mateDisplayName,
    pushModule: pushModule,
    getNotificationsModule: getNotificationsModule,
    adapter: adapter,
    onProcessingChanged: onProcessingChanged,
    onTurnDone: onTurnDone,
    onWorktreeChange: onWorktreeChange,
    onAutoTitle: function (session) { autoGenerateTitle(session); },
    opts: opts,
    discoverSkillDirs: discoverSkillDirs,
    mergeSkills: mergeSkills,
    // Transient-failure recovery helpers, shared so in-band "API Error:" turns
    // (delivered as an assistant message + normal result, not a thrown error)
    // auto-resume with the same one-shot, budget-capped policy as thrown errors.
    isTransientStreamError: isTransientStreamError,
    autoResumeAllowed: autoResumeAllowed,
    scheduleInterruptResume: scheduleInterruptResume,
  });
  var processSDKMessage = msgProcessor.processSDKMessage;
  var sendAndRecord = msgProcessor.sendAndRecord;
  var sendToSession = msgProcessor.sendToSession;
  var bridgePermissions = attachBridgePermissions({
    sm: sm,
    sendAndRecord: sendAndRecord,
    onProcessingChanged: onProcessingChanged,
    pushModule: pushModule,
    getNotificationsModule: getNotificationsModule,
    getRemoteMcpServers: getRemoteMcpServers,
    slug: slug,
    adapter: adapter,
  });
  var checkToolWhitelist = bridgePermissions.checkToolWhitelist;
  var handleCanUseTool = bridgePermissions.handleCanUseTool;
  var permissionPushTitle = bridgePermissions.permissionPushTitle;
  var permissionPushBody = bridgePermissions.permissionPushBody;

  var bridgeDialogs = attachBridgeDialogs({
    sendAndRecord: sendAndRecord,
    pushModule: pushModule,
    slug: slug,
  });
  var handleElicitation = bridgeDialogs.handleElicitation;
  var handleUserDialog = bridgeDialogs.handleUserDialog;

  var bridgeProcesses = attachBridgeProcesses({ cwd: cwd });
  var ensureLinuxUserProjectDir = bridgeProcesses.ensureLinuxUserProjectDir;
  var findConflictingClaude = bridgeProcesses.findConflictingClaude;
  var isClaudeProcess = bridgeProcesses.isClaudeProcess;

  var bridgeControls = attachBridgeControls({
    sm: sm,
    send: send,
    adapter: adapter,
    modelEntryValue: modelEntryValue,
    sendModelInfoForVendor: sendModelInfoForVendor,
  });
  var setModel = bridgeControls.setModel;
  var setEffort = bridgeControls.setEffort;
  var setPermissionMode = bridgeControls.setPermissionMode;
  var stopTask = bridgeControls.stopTask;
  var reloadSkills = bridgeControls.reloadSkills;
  var setMcpPermissionModeOverride = bridgeControls.setMcpPermissionModeOverride;

  // --- SDK query lifecycle ---

  // Two-tier hang detection. Once events are flowing, allow long quiet gaps so
  // genuinely slow tool calls aren't aborted (10 min). But if NOTHING has
  // arrived yet — not even the first token — a much shorter window catches a
  // dead connection / "thinking forever" stall and lets it auto-resume.
  var STREAM_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
  var STREAM_FIRST_EVENT_TIMEOUT_MS = 45 * 1000;
  // A stall mid-generation (no tool running) is a dead stream — text/thinking
  // deltas should arrive continuously, so a long gap means the connection
  // silently stopped delivering tokens ("stuck mid-sentence"). Recover fast.
  // This window is safe to keep short BECAUSE a live generation is never silent
  // this long with no tool running, so it cannot abort a working session — only
  // a genuinely dead one. (The 10-min tool window above is what protects slow
  // tools like Bash, so we deliberately do NOT shorten that.)
  var STREAM_MIDSTREAM_TIMEOUT_MS = 30 * 1000;

  async function processQueryStream(session) {
    // Capture references at start so we only clean up OUR resources in finally,
    // not resources from a newer query that may have been created after an abort.
    var myQueryInstance = session.queryInstance;
    var myAbortController = session.abortController;
    console.log("[sdk-bridge] processQueryStream: starting for-await loop, vendor=" + (session.vendor || adapter.vendor));

    // Inactivity watchdog: abort if the provider sends nothing for too long.
    var _lastEventAt = Date.now();
    var _turnStartedAt = Date.now();
    var _sawAnyEvent = false;
    var _activeTools = {};
    var _activeToolCount = 0;
    var _watchdogTimer = setInterval(function () {
      if (!session.isProcessing || session.taskStopRequested || session.destroying) {
        clearInterval(_watchdogTimer);
        return;
      }
      // Pick the tolerated quiet window by what we're waiting on:
      //  - a tool is executing  -> allow the long window (tools can be slow)
      //  - generating, no tool  -> short window (a gap means a dead stream)
      //  - nothing arrived yet   -> short window (dead connection on connect)
      var timeoutMs = _activeToolCount > 0
        ? STREAM_INACTIVITY_TIMEOUT_MS
        : (_sawAnyEvent ? STREAM_MIDSTREAM_TIMEOUT_MS : STREAM_FIRST_EVENT_TIMEOUT_MS);
      var since = _sawAnyEvent ? (Date.now() - _lastEventAt) : (Date.now() - _turnStartedAt);
      if (since >= timeoutMs) {
        clearInterval(_watchdogTimer);
        // Record which window tripped so recurrences are diagnosable from logs:
        //  - "first-event"  : nothing ever arrived (dead connection on connect)
        //  - "mid-generation": tokens were flowing then stopped (dead stream)
        //  - "tool-active"  : a tool was running and went quiet too long
        var _wdCase = _activeToolCount > 0 ? "tool-active" : (_sawAnyEvent ? "mid-generation" : "first-event");
        console.warn("[sdk-bridge] Stream watchdog fired for session " + session.localId +
          " — case=" + _wdCase + " silentFor=" + Math.round(since / 1000) + "s timeout=" + Math.round(timeoutMs / 1000) + "s" +
          " sawAnyEvent=" + _sawAnyEvent + " activeTools=" + _activeToolCount + ", aborting to auto-resume.");
        recordRecoveryEvent({
          kind: "watchdog",
          sessionId: session.localId,
          vendor: session.vendor || (adapter && adapter.vendor) || "claude",
          case: _wdCase,
          silentMs: since,
          timeoutMs: timeoutMs,
        });
        // Mark this abort as watchdog-initiated so the catch auto-resumes
        // rather than showing a dead "Interrupted" banner.
        session._watchdogAbort = true;
        session.streamHungAutoRetryQueued = !session.streamHungAutoRetryQueued;
        if (myAbortController && !myAbortController.signal.aborted) {
          try { myAbortController.abort(); } catch (e) {}
        } else if (myQueryInstance && typeof myQueryInstance.close === "function") {
          try { myQueryInstance.close(); } catch (e) {}
        } else if (session.messageQueue && typeof session.messageQueue.end === "function") {
          try { session.messageQueue.end(); } catch (e) {}
        }
      }
    }, 5 * 1000);
    if (_watchdogTimer.unref) _watchdogTimer.unref();

    try {
      for await (var msg of myQueryInstance) {
        _lastEventAt = Date.now();
        _sawAnyEvent = true;
        // Track in-flight tools so the watchdog tolerates long quiet gaps only
        // while a tool is actually executing (a slow Bash/Task), not when the
        // model stalls mid-generation.
        if (msg && (msg.yokeType === "tool_start" || msg.yokeType === "tool_executing")) {
          var _wdTid = msg.toolId || msg.blockId;
          if (_wdTid && !_activeTools[_wdTid]) { _activeTools[_wdTid] = true; _activeToolCount++; }
        } else if (msg && msg.yokeType === "tool_result") {
          var _wdRtid = msg.toolId || msg.blockId;
          if (_wdRtid && _activeTools[_wdRtid]) { delete _activeTools[_wdRtid]; _activeToolCount--; }
        }
        if (CLAY_DEBUG_EVENTS && msg && msg.yokeType !== "text_delta" && msg.yokeType !== "thinking_delta" && msg.yokeType !== "tool_input_delta") {
          console.log("[sdk-bridge] processQueryStream: received event yokeType=" + msg.yokeType);
        }
        // Handle worker meta events (context_usage, model_changed, etc.)
        if (msg && msg.type === "_worker_meta") {
          var metaData = msg.data || {};
          switch (msg.subtype) {
            case "context_usage":
              session.lastContextUsage = metaData.data;
              sendToSession(session, { type: "context_usage", data: metaData.data });
              break;
            case "model_changed":
              sm.currentModel = metaData.model;
              sendModelInfoForVendor(session.vendor || (adapter && adapter.vendor) || "claude", metaData.model, session);
              send({ type: "config_state", model: sm.currentModel, mode: sm.currentPermissionMode || "default", effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
              break;
            case "effort_changed":
              sm.currentEffort = metaData.effort;
              send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode || "default", effort: sm.currentEffort, betas: sm.currentBetas || [] });
              break;
            case "permission_mode_changed":
              sm.currentPermissionMode = metaData.mode;
              session.permissionMode = metaData.mode;
              session.automationMode = automationForClaudePermission(metaData.mode);
              send({ type: "config_state", model: sm.currentModel || "", mode: sm.currentPermissionMode, automationMode: session.automationMode, effort: sm.currentEffort || "medium", betas: sm.currentBetas || [] });
              break;
            case "worker_error":
              send({ type: "error", text: metaData.error });
              break;
          }
          continue;
        }
        // Surface adapter-level errors (e.g. Codex thread/resume failures) directly
        // instead of falling through to the generic "stopped before returning a final
        // response" message.  The codex adapter yields { yokeType: "error", text } when
        // runQueryLoop catches an exception; without this handler the event is silently
        // dropped by processSDKMessage (which has no case for "error") and the user sees
        // no indication of what went wrong.
        if (msg && msg.yokeType === "error") {
          var adapterErrText = msg.text || "Unknown error";
          console.error("[sdk-bridge] Adapter error event for session " + session.localId + ": " + adapterErrText);
          session.isProcessing = false;
          onProcessingChanged();
          send({ type: "status", processing: false });
          sendAndRecord(session, { type: "thinking_stop" });
          sendAndRecord(session, { type: "error", text: adapterErrText });
          sendAndRecord(session, { type: "done", code: 1 });
          continue;
        }
        processSDKMessage(session, msg);
      }
      // (getContextUsage moved to processSDKMessage result handler -- fire-and-forget)
      // The provider stream can end without a final result event. That should
      // never leave the UI in a processing state.
      console.log("[sdk-bridge] processQueryStream ended: isProcessing=" + session.isProcessing + " taskStopRequested=" + session.taskStopRequested);
      if (session.isProcessing) {
        session.isProcessing = false;
        onProcessingChanged();
        send({ type: "status", processing: false });
        sendAndRecord(session, { type: "thinking_stop" });
        if (!session.destroying) {
          var streamEndedMsg;
          if (session.taskStopRequested) {
            streamEndedMsg = (session.vendor === "codex")
              ? "\u25a0 Conversation interrupted - tell the model what to do differently."
              : "Interrupted \u00b7 What should Claude do instead?";
            sendAndRecord(session, { type: "info", text: streamEndedMsg });
            sendAndRecord(session, { type: "done", code: 0 });
          } else {
            // The stream ended before any final result — the turn truncated
            // (e.g. "stuck mid-sentence"). Reaching here with isProcessing still
            // true means NO result event arrived, so this is genuinely abnormal,
            // not a normal short turn. Retry once for ALL sessions (matching the
            // transient-error policy) and resume cleanly instead of dead-ending.
            var canRetryStreamEnd = !session.streamEndedAutoRetryQueued
              && !session._transientRetryUsed
              && !session.rateLimitResetsAt
              && !session.scheduledMessage
              && autoResumeAllowed(session)
              && typeof opts.scheduleMessage === "function";
            if (canRetryStreamEnd) {
              session.streamEndedAutoRetryQueued = true;
              session.streamHungAutoRetryQueued = false;
              session._transientRetryUsed = true;
              sendAndRecord(session, { type: "info", text: "Connection dropped before the response finished. Resuming…" });
              sendAndRecord(session, { type: "done", code: 0 });
              scheduleInterruptResume(session);
            } else {
              streamEndedMsg = getVendorDisplayName(session.vendor || (adapter && adapter.vendor) || "claude") + " stopped before returning a final response.";
              sendAndRecord(session, { type: "error", text: streamEndedMsg });
              sendAndRecord(session, { type: "done", code: 1 });
            }
          }
        }
        sm.broadcastSessionList();
        if ((!session.taskStopRequested || session.steerInterruptRequested) && onTurnDone) {
          try { onTurnDone(session, session._taskWorkflowResponseText || ""); } catch (e) {}
        }
      }
    } catch (err) {
      if (session.isProcessing) {
        session.isProcessing = false;
        onProcessingChanged();
        if (err.name === "AbortError" || (myAbortController && myAbortController.signal.aborted) || session.taskStopRequested) {
          if (session._watchdogAbort && !session.taskStopRequested && !session.destroying
              && !session._transientRetryUsed && autoResumeAllowed(session)
              && typeof opts.scheduleMessage === "function") {
            // Stalled stream caught by the watchdog \u2014 not a user stop. Resume
            // the interrupted work once instead of showing a dead banner.
            console.warn("[sdk-bridge] Watchdog abort for session " + session.localId + "; auto-resuming once.");
            session._watchdogAbort = false;
            session._transientRetryUsed = true;
            sendAndRecord(session, { type: "thinking_stop" });
            sendAndRecord(session, { type: "info", text: "Response stalled. Resuming\u2026", variant: "recovery" });
            sendAndRecord(session, { type: "done", code: 0 });
            scheduleInterruptResume(session);
            sm.broadcastSessionList();
            return;
          }
          session._watchdogAbort = false;
          if (!session.destroying && session.steerInterruptRequested) {
            // Steer: close the current turn quietly. onTurnDone flushes the
            // steered message, which continues the conversation seamlessly \u2014
            // no "Interrupted, what should Claude do instead?" banner.
            sendAndRecord(session, { type: "thinking_stop" });
            sendAndRecord(session, { type: "done", code: 0 });
          } else if (!session.destroying) {
            sendAndRecord(session, { type: "thinking_stop" });
            var interruptMsg2 = (session.vendor === "codex")
              ? "\u25a0 Conversation interrupted - tell the model what to do differently."
              : "Interrupted \u00b7 What should Claude do instead?";
            sendAndRecord(session, { type: "info", text: interruptMsg2 });
            sendAndRecord(session, { type: "done", code: 0 });
          }
        } else if (session.destroying) {
          // Suppress error messages during shutdown
          console.log("[sdk-bridge] Suppressing stream error during shutdown for session " + session.localId);
        } else {
          var errDetail = err.message || String(err);
          if (err.stderr) errDetail += "\nstderr: " + err.stderr;
          if (err.exitCode != null) errDetail += " (exitCode: " + err.exitCode + ")";
          console.error("[sdk-bridge] Query stream error for session " + session.localId + ":", errDetail);
          console.error("[sdk-bridge] Stack:", err.stack || "(no stack)");

          // Check for conflicting Claude processes only on exit code 1
          var isExitCode1 = err.exitCode === 1 || (err.message && err.message.indexOf("exited with code 1") !== -1);
          var conflicts = isExitCode1 ? findConflictingClaude() : [];
          if (conflicts.length > 0) {
            console.error("[sdk-bridge] Found " + conflicts.length + " conflicting Claude process(es):", conflicts.map(function(c) { return "PID " + c.pid; }).join(", "));
            sendAndRecord(session, {
              type: "process_conflict",
              text: "Another Claude Code process is already running in this project.",
              processes: conflicts,
            });
          } else if (isTransientStreamError(errDetail) && !session._transientRetryUsed
              && !session.taskStopRequested && autoResumeAllowed(session)
              && typeof opts.scheduleMessage === "function") {
            // Transient network/stream drop (e.g. socket closed mid-stream).
            // The work didn't logically fail, so retry once automatically for
            // ALL sessions instead of surfacing a hard error. A second
            // consecutive transient drop re-enters this catch with the guard
            // already set and falls through to the normal error path below.
            console.warn("[sdk-bridge] Transient stream error for session " + session.localId + "; auto-retrying once: " + errDetail);
            recordRecoveryEvent({
              kind: "transient",
              sessionId: session.localId,
              vendor: session.vendor || (adapter && adapter.vendor) || "claude",
              error: String(errDetail).slice(0, 300),
            });
            session._transientRetryUsed = true;
            sendAndRecord(session, { type: "thinking_stop" });
            sendAndRecord(session, { type: "info", text: "Connection dropped mid-response. Retrying…", variant: "recovery" });
            sendAndRecord(session, { type: "done", code: 0 });
            scheduleInterruptResume(session);
            sm.broadcastSessionList();
            return;
          } else {
            var errLower = errDetail.toLowerCase();
            var isContextOverflow = errLower.indexOf("prompt is too long") !== -1
              || errLower.indexOf("context_length") !== -1
              || errLower.indexOf("maximum context length") !== -1;
            var isAuthError = isAuthErrorMessage(errDetail);
            if (isContextOverflow) {
              sendAndRecord(session, {
                type: "context_overflow",
                text: "Conversation too long to continue.",
              });
            } else if (isAuthError) {
              var freshAuth = getFreshAuthState();
              logAuthDecision("catch-auth-error", session, errDetail, freshAuth);
              if (freshAuth[session.vendor]) {
                sendAndRecord(session, {
                  type: "error",
                  text: "Authentication looked fine, but " + (session.vendor || "the vendor") + " returned an auth-like error.",
                });
                sendAndRecord(session, { type: "done", code: 1 });
                sm.broadcastSessionList();
                return;
              }
              var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
              var authLinuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
              var canAutoLogin = !usersModule.isMultiUser()
                || !!authLinuxUser
                || (authUser && authUser.role === "admin");
              var authTitle = getVendorDisplayName(session.vendor || (adapter && adapter.vendor) || "claude") + " is not logged in.";
              var authMsg = {
                type: "auth_required",
                text: authTitle,
                vendor: session.vendor || (adapter && adapter.vendor) || "claude",
                loginCommand: getLoginCommand(session.vendor || (adapter && adapter.vendor) || "claude"),
                linuxUser: authLinuxUser,
                canAutoLogin: canAutoLogin,
              };
              sendAndRecord(session, authMsg);
              if (!notifyAuthRequired(
                session,
                authTitle,
                "Open a terminal, then click the URL and follow the instructions.",
                authLinuxUser,
                canAutoLogin,
                getLoginCommand(session.vendor || (adapter && adapter.vendor) || "claude")
              )) {
                // chat message already sent above
              }
            } else {
              sendAndRecord(session, { type: "error", text: "Claude process error: " + err.message });
            }
          }
          sendAndRecord(session, { type: "done", code: 1 });
        }
        sm.broadcastSessionList();
        if (session.steerInterruptRequested && onTurnDone) {
          try { onTurnDone(session, session._taskWorkflowResponseText || ""); } catch (e) {}
        }
      }
    } finally {
      clearInterval(_watchdogTimer);
      // Whether THIS turn still owns the session (no rewind/new query replaced
      // it). Used to gate the safety-net "done" below so we never prematurely
      // close a newer turn's UI.
      var ownsTurn = session.queryInstance === myQueryInstance;
      // Close the SDK query to terminate the underlying claude child process.
      // Without this, the process stays alive indefinitely (single-user mode).
      // Only clean up if the session still references OUR resources.
      // A rewind + new startQuery may have already replaced these with
      // a newer query — clobbering them would kill the new query.
      if (session.queryInstance === myQueryInstance) {
        try {
          if (typeof session.queryInstance.close === "function") {
            session.queryInstance.close();
          }
        } catch (e) {}
        session.queryInstance = null;
      }
      session.messageQueue = null;
      if (session.abortController === myAbortController) session.abortController = null;
      session.taskStopRequested = false;
      session.steerInterruptRequested = false;
      session.pendingPermissions = {};
      // Clear per-turn streaming block state. A clean turn end resets these via
      // the result branch, but an aborted turn (steer/stop while a tool is
      // running) never gets that event — leaving session.blocks /
      // activeTaskToolIds / taskIdMap populated. hasActiveTaskState() would then
      // stay true forever and the queued steered message would never flush, so
      // the chat appears to stop. Gated on ownsTurn so a rewind/new query that
      // already set up fresh block state isn't clobbered.
      if (ownsTurn) {
        session.blocks = {};
        session.activeTaskToolIds = {};
        session.taskIdMap = {};
      }
      // Preserve MCP-mode AskUserQuestion entries across turn boundaries.
      // The MCP path is intentionally stateless: the tool returns immediately
      // ("card posted, end your turn") and the user's answer is expected to
      // arrive as a brand-new user_message on the *next* turn. That means the
      // pending entry MUST survive this finally block. Without it, the
      // ask_user_response handler can't find the toolId and silently drops
      // the answer. canUseTool-mode entries (Claude's native path) still hold
      // an open SDK permission callback that dies with the query, so those
      // are correctly cleared here.
      var keepAskUser = {};
      for (var _tid in session.pendingAskUser) {
        var _pending = session.pendingAskUser[_tid];
        if (_pending && _pending.mode === "mcp") keepAskUser[_tid] = _pending;
      }
      session.pendingAskUser = keepAskUser;
      session.pendingElicitations = {};

      if (session.vendor === "github-copilot" && session.copilotResetAfterCurrentHandoffTurn && !session.copilotHandoffNativeReset) {
        console.warn("[sdk-bridge] Dropping GitHub Copilot native session that received handoff transcript: " + (session.cliSessionId || "unknown"));
        session.cliSessionId = null;
        session.copilotHandoffNativeReset = true;
        session.copilotResetAfterCurrentHandoffTurn = false;
        try { sm.saveSessionFile(session); } catch (e) {}
        if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
      } else if (session.copilotResetAfterCurrentHandoffTurn) {
        session.copilotResetAfterCurrentHandoffTurn = false;
      }

      // Auto-continue on rate limit (scheduler sessions, or user setting)
      // Mark session as done processing so the late rate_limit_event handler
      // can detect the race condition and schedule auto-continue itself.
      session.isProcessing = false;

      // Safety net: if this turn ended without ever emitting a terminal "done"
      // (e.g. the stream threw while isProcessing was already false, or some
      // path returned without closing the turn), emit one now. Without this the
      // client's running tool/sub-agent blocks spin "Running…" forever because
      // nothing ever reconciles them. Gated on ownsTurn so a rewind/new query is
      // never prematurely closed, and skipped during shutdown.
      if (ownsTurn && !session._turnDoneSent && !session.destroying) {
        console.warn("[sdk-bridge] Turn for session " + session.localId + " ended without a terminal event; emitting safety-net done.");
        sendAndRecord(session, { type: "done", code: 0 });
        if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
      }

      var didScheduleAutoContinue = false;
      var acEnabled = session.onQueryComplete || (typeof opts.getAutoContinueSetting === "function" && opts.getAutoContinueSetting(session));
      if (session.rateLimitUseCreditsPending && acEnabled && !session.destroying) {
        session.rateLimitUseCreditsPending = false;
        session.rateLimitAutoContinuePending = true;
        didScheduleAutoContinue = true;
        console.log("[sdk-bridge] Rate limited with usage credits available, continuing immediately for session " + session.localId);
        if (typeof opts.continueWithUsageCredits === "function") {
          opts.continueWithUsageCredits(session, "continue", null, "↻ Continuing with usage credits");
        }
      } else if (session.rateLimitResetsAt && session.rateLimitResetsAt > Date.now()
          && acEnabled && !session.destroying) {
        var acResetsAt = session.rateLimitResetsAt;
        session.rateLimitResetsAt = null;
        session.rateLimitAutoContinuePending = true;
        didScheduleAutoContinue = true;
        console.log("[sdk-bridge] Rate limited, scheduling auto-continue via scheduleMessage for session " + session.localId);
        if (typeof opts.scheduleMessage === "function") {
          opts.scheduleMessage(session, "continue", acResetsAt, null, rateLimitResumeLabel);
        }
      } else if (acEnabled && !session.destroying) {
        // Log why auto-continue was not scheduled (for debugging)
        console.log("[sdk-bridge] Query done, auto-continue enabled but not scheduled: rateLimitResetsAt=" +
          session.rateLimitResetsAt + " (will rely on late rate_limit_event handler)");
      }

      // Ralph Loop: notify completion so loop orchestrator can proceed
      if (session.onQueryComplete && !didScheduleAutoContinue) {
        console.log("[sdk-bridge] Calling onQueryComplete for session " + session.localId + " (title: " + (session.title || "?") + ")");
        try {
          session.onQueryComplete(session);
        } catch (err) {
          console.error("[sdk-bridge] onQueryComplete error:", err.message || err);
        }
      }
    }
  }

  async function getOrCreateRewindQuery(session) {
    if (session.queryInstance) return { query: session.queryInstance, isTemp: false, cleanup: function() {} };

    var handle;
    try {
      handle = await adapter.createQuery({
        cwd: cwd,
        resumeSessionId: session.cliSessionId,
        adapterOptions: {
          CLAUDE: {
            settingSources: ["user", "project", "local"],
            enableFileCheckpointing: true,
          },
        },
      });
    } catch (e) {
      sendAndRecord(session, { type: "error", text: "Failed to load Claude SDK: " + (e.message || e) });
      throw e;
    }

    // Drain messages in background (stream stays alive until close)
    (async function() {
      try { for await (var msg of handle) {} } catch(e) {}
    })();

    return {
      query: handle,
      isTemp: true,
      cleanup: function() { try { handle.close(); } catch(e) {} },
    };
  }

  // --- Unified rewind/fork interface (adapter-agnostic) ---

  async function rewindPreview(session, uuid) {
    var sessionAdapter = getAdapterForSession(session);
    // Adapters with rollbackThread (e.g. Codex) do chat-only rewind, no file diffs
    if (sessionAdapter && typeof sessionAdapter.rollbackThread === "function") {
      return { preview: { filesChanged: [] }, diffs: {}, chatOnly: true };
    }
    // Claude path: use rewindFiles with dryRun
    var result = await getOrCreateRewindQuery(session);
    try {
      var preview = await result.query.rewindFiles(uuid, { dryRun: true });
      var diffs = {};
      var changedFiles = preview.filesChanged || [];
      for (var f = 0; f < changedFiles.length; f++) {
        try {
          diffs[changedFiles[f]] = require("child_process").execFileSync(
            "git", ["diff", "HEAD", "--", changedFiles[f]],
            { cwd: cwd, encoding: "utf8", timeout: 5000 }
          ) || "";
        } catch (e) { diffs[changedFiles[f]] = ""; }
      }
      return { preview: preview, diffs: diffs, chatOnly: false };
    } finally {
      if (result.isTemp) result.cleanup();
    }
  }

  async function rewindExecuteFiles(session, uuid) {
    var sessionAdapter = getAdapterForSession(session);
    // Adapters with rollbackThread skip file restoration
    if (sessionAdapter && typeof sessionAdapter.rollbackThread === "function") return;
    // Claude path: restore files
    var result = await getOrCreateRewindQuery(session);
    try {
      await result.query.rewindFiles(uuid, { dryRun: false });
    } finally {
      if (result.isTemp) result.cleanup();
    }
  }

  async function rollbackConversation(session, numTurns) {
    var sessionAdapter = getAdapterForSession(session);
    if (sessionAdapter && typeof sessionAdapter.rollbackThread === "function") {
      await sessionAdapter.rollbackThread(session.cliSessionId, numTurns);
    }
    // Claude: conversation rollback is handled by rewindFiles + local history trim
  }

  function getAdapterForSession(session) {
    var vendor = session.vendor || sm.defaultVendor || "claude";
    return adapters[vendor] || adapter;
  }

  async function forkSessionUnified(session, uuid) {
    var sessionAdapter = getAdapterForSession(session);
    var result = await sessionAdapter.forkSession(session.cliSessionId, { upToMessageId: uuid, dir: cwd });
    if (!result || !result.sessionId) throw new Error("Fork returned no session id");

    // Adapters with rollbackThread (e.g. Codex) use local history copy
    if (typeof sessionAdapter.rollbackThread === "function") {
      return { sessionId: result.sessionId, useLocalHistory: true };
    }
    // Claude: read history from CLI session files
    return { sessionId: result.sessionId, useLocalHistory: false };
  }

  async function startQuery(session, text, images, linuxUser) {
    function shouldResetCopilotHandoffNativeSession() {
      return !!(session &&
        session.vendor === "github-copilot" &&
        session.handoffContextConsumed &&
        !session.copilotHandoffNativeReset &&
        session.cliSessionId &&
        session.storageId &&
        session.storageId !== session.cliSessionId);
    }

    async function ensureVendorReady(vendor) {
      if (!vendor) return null;
      var vendorAdapter = adapters[vendor] || null;
      if (!vendorAdapter) {
        var yoke = require("./yoke");
        vendorAdapter = await yoke.lazyCreateAdapter(adapters, vendor, {
          cwd: cwd,
          dangerouslySkipPermissions: dangerouslySkipPermissions,
          linuxUser: linuxUser || undefined,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });
      } else if ((!sm.modelsByVendor || !sm.modelsByVendor[vendor]) && typeof vendorAdapter.init === "function") {
        await vendorAdapter.init({
          cwd: cwd,
          dangerouslySkipPermissions: dangerouslySkipPermissions,
          linuxUser: linuxUser || undefined,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });
      }
      if (vendorAdapter) {
        sm.availableVendors = Object.keys(adapters);
        sm.modelsByVendor = sm.modelsByVendor || {};
        if (!sm.modelsByVendor[vendor] && typeof vendorAdapter.supportedModels === "function") {
          var discoveredModels = await vendorAdapter.supportedModels();
          sm.modelsByVendor[vendor] = vendor === "claude" ? withClaudeFallbackModels(discoveredModels) : discoveredModels;
        }
      }
      return vendorAdapter;
    }

    // If vendor is set but adapter not ready, try lazy creation (user may have logged in)
    if (session.vendor && !adapters[session.vendor]) {
      var lazyAdapter = await ensureVendorReady(session.vendor);
      if (lazyAdapter) {
        console.log("[sdk-bridge] Lazy adapter created for " + session.vendor);
      }
    } else if (session.vendor) {
      await ensureVendorReady(session.vendor);
    }
    if (session.vendor && !adapters[session.vendor]) {
      var freshAuth = getFreshAuthState();
      logAuthDecision("pre-auth-required", session, null, freshAuth);
      if (freshAuth[session.vendor]) {
        var recoveredAdapter = await ensureVendorReady(session.vendor);
        if (recoveredAdapter) {
          console.log("[sdk-bridge] Auth recheck recovered adapter for " + session.vendor);
        }
      }
    }
    // If still not available after lazy check, send auth_required
    if (session.vendor && !adapters[session.vendor]) {
      var vendorName = getVendorDisplayName(session.vendor);
      var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
      var authLinuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
      var canAutoLogin = !usersModule.isMultiUser()
        || !!authLinuxUser
        || (authUser && authUser.role === "admin");
      var authState = getFreshAuthState();
      logAuthDecision("emit-auth-required", session, "missing adapter", authState);
      if (authState[session.vendor]) {
        sendAndRecord(session, {
          type: "error",
          text: vendorName + " auth is available, but the adapter could not be initialized.",
        });
        sendAndRecord(session, { type: "done", code: 1 });
        return;
      }
      var authMsg2 = {
        type: "auth_required",
        text: vendorName + " is not logged in.",
        vendor: session.vendor,
        loginCommand: getLoginCommand(session.vendor),
        linuxUser: authLinuxUser,
        canAutoLogin: canAutoLogin,
      };
      sendAndRecord(session, authMsg2);
      if (!notifyAuthRequired(
        session,
        vendorName + " is not logged in.",
        "Open a terminal, then click the URL and follow the instructions.",
        authLinuxUser,
        canAutoLogin,
        getLoginCommand(session.vendor)
      )) {
        // chat message already sent above
      }
      sendAndRecord(session, { type: "done", code: 1 });
      return;
    }
    // Select adapter based on session vendor (fallback to default)
    var sessionAdapter = (session.vendor && adapters[session.vendor]) || adapter;
    console.log("[sdk-bridge] startQuery: vendor=" + sessionAdapter.vendor + " session=" + session.localId + " text=" + (text || "").substring(0, 50));
    // Remember linuxUser for auto-continue after rate limit
    session.lastLinuxUser = linuxUser || null;

    var t0 = session._queryStartTs || Date.now();

    // Wait for previous worker to fully exit before spawning a new one.
    // Without this, the new worker may try to resume the SDK session file
    // while the old worker is still flushing it to disk, causing
    // "no conversation found" and losing all prior context.
    // Harmless if null (no previous worker).
    if (session._workerExitPromise) {
      var exitWait = session._workerExitPromise;
      session._workerExitPromise = null;
      await Promise.race([
        exitWait,
        new Promise(function(resolve) { setTimeout(resolve, 3000); }),
      ]);
    }

    // Ensure Linux user project directory exists (runs in parallel with worker boot)
    if (linuxUser) {
      ensureLinuxUserProjectDir(linuxUser, session);
    }

    session.blocks = {};
    session.sentToolResults = {};
    session.activeTaskToolIds = {};
    session.pendingElicitations = {};
    session.streamedText = false;
    session.responsePreview = "";
    // Reset the terminal-event latch for this turn. doSendAndRecord sets it true
    // when a "done" is emitted; the query loop's finally uses it as a safety net.
    session._turnDoneSent = false;

    // For in-process path, create AbortController. For worker path, the adapter
    // handles abort internally and exposes it via handle.abort().
    if (!linuxUser) {
      session.abortController = new AbortController();
    }

    // Build Claude-specific adapter options
    var claudeOpts = {
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      enableFileCheckpointing: true,
      extraArgs: { "replay-user-messages": null },
      promptSuggestions: true,
      agentProgressSummaries: true,
    };

    // Per-loop settings override global defaults when present
    var ls = session.loopSettings || {};

    if (sm.currentBetas && sm.currentBetas.length > 0) {
      claudeOpts.betas = sm.currentBetas;
    }
    var thinkingMode = ls.thinking || sm.currentThinking;
    if (thinkingMode === "disabled") {
      claudeOpts.thinking = { type: "disabled" };
    } else if (thinkingMode === "budget") {
      var budgetTokens = ls.thinkingBudget || sm.currentThinkingBudget;
      if (budgetTokens) claudeOpts.thinking = { type: "enabled", budgetTokens: budgetTokens };
    }

    if (ls.permissionMode) {
      session._loopPermissionMode = ls.permissionMode;
    }

    // Pass through any extra SDK settings from LOOP.json
    if (ls.disableAllHooks !== undefined) {
      claudeOpts.settings = Object.assign({}, claudeOpts.settings || {}, { disableAllHooks: ls.disableAllHooks });
    }

    if (dangerouslySkipPermissions) {
      claudeOpts.allowDangerouslySkipPermissions = true;
      claudeOpts.permissionMode = "bypassPermissions";
    } else {
      var sessionAutomationMode = session.automationMode ? claudePermissionForAutomation(session.automationMode) : null;
      var globalMode = session.permissionMode || sessionAutomationMode || sm.currentPermissionMode || "default";
      var effectiveDefault;
      if (globalMode === "bypassPermissions") effectiveDefault = "bypassPermissions";
      else if (session.acceptEditsAfterStart) effectiveDefault = "acceptEdits";
      else effectiveDefault = globalMode;
      var modeToApply = session._loopPermissionMode || effectiveDefault;
      if (modeToApply && modeToApply !== "default") {
        claudeOpts.permissionMode = modeToApply;
      }
    }
    // Clear one-shot acceptEditsAfterStart regardless of which branch ran above,
    // so the flag does not linger into subsequent turns.
    if (session.acceptEditsAfterStart) delete session.acceptEditsAfterStart;
    if (session.cliSessionId && session.lastRewindUuid) {
      claudeOpts.resumeSessionAt = session.lastRewindUuid;
      delete session.lastRewindUuid;
      sm.saveSessionFile(session);
    }

    // Pass linuxUser to adapter for worker-based queries
    if (linuxUser) {
      claudeOpts.linuxUser = linuxUser;
      claudeOpts.singleTurn = !!session.singleTurn;
      claudeOpts.originalHome = require("./config").REAL_HOME || null;
      claudeOpts.projectPath = session.cwd || null;
      claudeOpts._perfT0 = t0;
      // Pass previous worker state for reuse
      if (session._adapterWorkerState) {
        claudeOpts._workerState = session._adapterWorkerState;
        session._adapterWorkerState = null;
      }
    }

    // Pick a model that belongs to the session's vendor. sm.currentModel is
    // shared project-wide, so a Codex session that last set it to
    // "gpt-5.4-mini" would otherwise leak into a Claude session in the same
    // project (or in another session that switches vendor to claude) and
    // Claude would reject the unknown model. We validate against the
    // session vendor's model list regardless of which vendor happens to be
    // the project's default adapter.
    var selectedProjectModel = sm.currentModel && sm.currentModel !== "default" ? sm.currentModel : null;
    var selectedSessionModel = session.model && session.model !== "default" ? session.model : null;
    var selectedLoopModel = session.loop && ls.model && ls.model !== "default" ? ls.model : null;
    var queryModel = selectedSessionModel || selectedLoopModel || selectedProjectModel || undefined;
    var sessionVendor = session.vendor || (adapter && adapter.vendor) || null;
    if (sessionVendor === "github-copilot") {
      var queryRouteId = copilotRouteIdForModel(queryModel);
      if (queryRouteId && session.providerRouteId !== queryRouteId) {
        session.providerRouteId = queryRouteId;
        try { sm.saveSessionFile(session); } catch (e) {}
        if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
      }
    }
    if (sessionVendor) {
      var vendorModels = getModelsForSession(session, sessionVendor);
      if (vendorModels.length > 0 && queryModel && !modelListContains(vendorModels, queryModel)) {
        var resolved = resolveModelInList(vendorModels, queryModel);
        queryModel = resolved || modelEntryValue(vendorModels[0]);
      } else if (vendorModels.length > 0 && !queryModel && session.providerRouteId) {
        queryModel = modelEntryValue(vendorModels[0]);
      }
    }
    // Guard against anything upstream having set queryModel to an object
    // (e.g. a cached ModelInfo leaked through). Always coerce to string id.
    if (queryModel && typeof queryModel !== "string") {
      queryModel = modelEntryValue(queryModel) || undefined;
    }

    if (sessionVendor === "github-copilot" && queryModel) {
      var finalQueryRouteId = copilotRouteIdForModel(queryModel);
      var queryStateChanged = false;
      if (session.model !== queryModel) {
        session.model = queryModel;
        queryStateChanged = true;
      }
      if (session.requestedModel !== queryModel) {
        session.requestedModel = queryModel;
        queryStateChanged = true;
      }
      if (session.verifiedModel && session.verifiedModel !== queryModel) {
        session.verifiedModel = null;
        session.modelVerificationSource = null;
        queryStateChanged = true;
      }
      if (finalQueryRouteId && session.providerRouteId !== finalQueryRouteId) {
        session.providerRouteId = finalQueryRouteId;
        queryStateChanged = true;
      }
      if (queryStateChanged) {
        try { sm.saveSessionFile(session); } catch (e) {}
        if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
        sendToSession(session, {
          type: "model_info",
          model: queryModel,
          models: getModelsForSession(session, sessionVendor),
          vendor: sessionVendor,
          providerRouteId: session.providerRouteId || null,
          requestedModel: session.requestedModel || queryModel,
          verifiedModel: session.verifiedModel || null,
          modelVerificationSource: session.modelVerificationSource || null,
          availableVendors: sm.availableVendors || [],
          installedVendors: sm.installedVendors || [],
          providerRoutes: sm.providerRoutes || listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []),
        });
      }
    }

    var codexConfig = getCodexConfig(sm, session);
    var mergedMcpServers = mergeMcpServers(getMcpServers(), getRemoteMcpServers) || undefined;

    if (shouldResetCopilotHandoffNativeSession()) {
      console.warn("[sdk-bridge] Resetting GitHub Copilot native session after handoff transcript was consumed: " + session.cliSessionId);
      session.cliSessionId = null;
      session.copilotHandoffNativeReset = true;
      try { sm.saveSessionFile(session); } catch (e) {}
      if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
    }

    // Derive an explicit session title for fresh queries so the SDK records
    // it at session creation and skips its own auto-generation. This also
    // lets us short-circuit autoGenerateTitle below for the common case.
    // Only applied to NEW sessions (no cliSessionId yet) — when resuming,
    // the SDK ignores Options.title in favor of the persisted title.
    var initialTitle = null;
    if (!session.cliSessionId && !session.titleManuallySet && !session.titleAutoGenerated) {
      if (session.title) {
        // Loop / scheduled / mate-seeded sessions arrive with a title already set.
        initialTitle = session.title;
      } else if (typeof text === "string") {
        // Derive a quick title from the user's first message.
        // Skip if too short to be meaningful — fall back to autoGenerateTitle.
        initialTitle = meaningfulTextTitle(text, 60);
      }
    }

    var queryOpts = {
      cwd: cwd,
      model: queryModel,
      effort: ls.effort || sm.currentEffort || undefined,
      title: initialTitle || undefined,
      toolPolicy: (session.permissionMode === "bypassPermissions" || codexConfig.approval === "never") ? "allow-all" : "ask",
      toolServers: mergedMcpServers,
      toolServerDescriptors: extractMcpDescriptors(mergedMcpServers) || undefined,
      resumeSessionId: session.cliSessionId || undefined,
      abortController: linuxUser ? undefined : session.abortController,
      canUseTool: function(toolName, input, toolOpts) {
        return handleCanUseTool(session, toolName, input, toolOpts);
      },
      onElicitation: function(request, elicitOpts) {
        return handleElicitation(session, request, elicitOpts);
      },
      onUserDialog: function(dialogRequest, dialogOpts) {
        return handleUserDialog(session, dialogRequest, dialogOpts);
      },
      callMcpTool: function(serverName, toolName, args) {
        return callMcpToolHandler(mergedMcpServers, serverName, toolName, args);
      },
      adapterOptions: {
        CLAUDE: claudeOpts,
        CODEX: {
          approvalPolicy: codexConfig.approval,
          sandboxMode: codexConfig.sandbox,
          webSearchMode: codexConfig.webSearch,
        },
      },
    };

    var handle;
    console.log("[sdk-bridge] calling adapter.createQuery... vendor=" + sessionAdapter.vendor);
    try {
      handle = await sessionAdapter.createQuery(queryOpts);
      console.log("[sdk-bridge] createQuery returned handle, vendor=" + sessionAdapter.vendor);
      // SDK accepted the explicit title — adopt it locally so the session
      // list reflects it immediately and autoGenerateTitle skips this
      // session (titleAutoGenerated gates re-trigger).
      if (initialTitle && !session.title) {
        session.title = initialTitle;
        session.titleAutoGenerated = true;
        sm.saveSessionFile(session);
        sm.broadcastSessionList();
      } else if (initialTitle && session.title === initialTitle) {
        session.titleAutoGenerated = true;
        sm.saveSessionFile(session);
      }
    } catch (e) {
      console.error("[sdk-bridge] Failed to create query for session " + session.localId + ":", e.message || e);
      console.error("[sdk-bridge] cliSessionId:", session.cliSessionId, "resume:", !!session.cliSessionId);
      console.error("[sdk-bridge] Stack:", e.stack || "(no stack)");
      session.isProcessing = false;
      onProcessingChanged();
      session.queryInstance = null;
      session.messageQueue = null;
      session.abortController = null;
      sendAndRecord(session, { type: "error", text: "Failed to start query: " + (e.message || e) });
      sendAndRecord(session, { type: "done", code: 1 });
      sm.broadcastSessionList();
      return;
    }

    // Store adapter worker state for reuse on next query
    if (handle._adapterState) {
      session._adapterWorkerState = handle._adapterState;
      // Keep session.worker reference for external code (sessions.js, project.js)
      // that needs to kill the worker on session destroy.
      if (handle._adapterState.worker) {
        session.worker = handle._adapterState.worker;
      }
    }

    // For worker path, create an abortController wrapper that delegates to handle.abort()
    if (linuxUser) {
      session.abortController = {
        abort: function() { handle.abort(); },
        signal: { aborted: false, addEventListener: function() {} },
      };
    }

    // Store QueryHandle on session for iteration and control.
    session.queryInstance = handle;

    // Push initial user message through the QueryHandle
    console.log("[sdk-bridge] pushing initial message via handle.pushMessage...");
    handle.pushMessage(text, images);
    console.log("[sdk-bridge] pushMessage done, starting processQueryStream...");

    // For single-turn sessions (Ralph Loop), end the message queue so the SDK
    // query finishes after processing the one message. Without this, the query
    // stream stays open forever waiting for more messages, and onQueryComplete
    // never fires.
    if (session.singleTurn) {
      handle.endInput();
    }

    session.lastActivityAt = Date.now();
    session.streamPromise = processQueryStream(session).catch(function(err) {
    });
  }

  function pushMessage(session, text, images) {
    session.lastActivityAt = Date.now();
    // Route through QueryHandle (works for both in-process and worker paths)
    var _canPush = !!(session.queryInstance && typeof session.queryInstance.pushMessage === "function");
    // Paste-delivery instrumentation: confirm the full agent-facing text reaches
    // the adapter (a missing queryInstance silently drops it). Filter: [clay-paste]
    try {
      console.log("[clay-paste] pushMessage: session=" + session.localId +
        " textLen=" + ((text || "").length) + " delivered=" + _canPush);
    } catch (e) {}
    if (_canPush) {
      session.queryInstance.pushMessage(text, images);
    }
  }

  // --- @Mention: persistent read-only session for a mentioned Mate ---
  // Creates a mention session that can be reused across multiple mentions
  // within a conversation flow (session continuity).
  async function createMentionSession(opts) {
    // opts: { vendor, claudeMd, initialContext, initialMessage, onDelta, onDone, onError, onActivity }
    var abortController = new AbortController();

    // Current response callbacks (swapped on each pushMessage)
    var currentOnDelta = opts.onDelta;
    var currentOnDone = opts.onDone;
    var currentOnError = opts.onError;
    var currentOnActivity = opts.onActivity || null;
    var responseFullText = "";
    var responseStreamedText = false;
    var mentionBlocks = {};
    var alive = true;

    // Use the mate's vendor adapter if specified, otherwise default
    var mentionAdapter = (opts.vendor && adapters[opts.vendor]) || adapter;

    var handle;
    try {
      handle = await mentionAdapter.createQuery({
        cwd: cwd,
        systemPrompt: opts.claudeMd,
        model: opts.model || undefined,
        toolServers: opts.includeMcpServers ? (mergeMcpServers(getMcpServers(), getRemoteMcpServers) || undefined) : undefined,
        abortController: abortController,
        canUseTool: opts.canUseTool || function (toolName, input) {
          var whitelisted = checkToolWhitelist(toolName, input);
          if (whitelisted) {
            return Promise.resolve(whitelisted);
          }
          return Promise.resolve({
            behavior: "deny",
            message: "Read-only access. You cannot make changes via @mention.",
          });
        },
        adapterOptions: {
          CLAUDE: {
            settingSources: ["user"],
            includePartialMessages: true,
          },
        },
      });
    } catch (e) {
      opts.onError("Failed to create mention query: " + (e.message || e));
      return null;
    }
    var query = handle;

    // Push the initial message (context + question, with optional images)
    var initialPrompt = opts.initialContext + "\n\n" + opts.initialMessage;
    handle.pushMessage(initialPrompt, opts.initialImages || null);

    // Background stream processing loop (consumes flattened yokeType events)
    (async function () {
      try {
        for await (var msg of query) {
          // Track content blocks for activity reporting
          if (msg.yokeType === "thinking_start") {
            mentionBlocks[msg.blockId] = { type: "thinking" };
            if (currentOnActivity) currentOnActivity("thinking");
          } else if (msg.yokeType === "tool_start") {
            mentionBlocks[msg.blockId] = { type: "tool_use", name: msg.toolName, inputJson: "" };
            var toolLabel = msg.toolName;
            if (toolLabel === "Read") toolLabel = "Reading file...";
            else if (toolLabel === "Grep") toolLabel = "Searching code...";
            else if (toolLabel === "Glob") toolLabel = "Finding files...";
            if (currentOnActivity) currentOnActivity(toolLabel);
          } else if (msg.yokeType === "text_start") {
            mentionBlocks[msg.blockId] = { type: "text" };

          } else if (msg.yokeType === "text_delta" && typeof msg.text === "string") {
            responseStreamedText = true;
            responseFullText += msg.text;
            if (currentOnActivity) currentOnActivity(null);
            if (currentOnDelta) currentOnDelta(msg.text);
          } else if (msg.yokeType === "tool_input_delta" && mentionBlocks[msg.blockId]) {
            mentionBlocks[msg.blockId].inputJson += msg.partialJson;

          } else if (msg.yokeType === "block_stop") {
            var blk = mentionBlocks[msg.blockId];
            if (blk && blk.type === "tool_use") {
              var toolInput = {};
              try { toolInput = JSON.parse(blk.inputJson); } catch (e) {}
              if (blk.name === "Read" && toolInput.file_path) {
                var fname = toolInput.file_path.split(/[/\\]/).pop();
                if (currentOnActivity) currentOnActivity("Reading " + fname + "...");
              } else if (blk.name === "Grep" && toolInput.pattern) {
                if (currentOnActivity) currentOnActivity("Searching: " + toolInput.pattern.substring(0, 30) + "...");
              } else if (blk.name === "Glob" && toolInput.pattern) {
                if (currentOnActivity) currentOnActivity("Finding: " + toolInput.pattern.substring(0, 30) + "...");
              }
            }
            delete mentionBlocks[msg.blockId];

          } else if (msg.yokeType === "message" && msg.messageRole === "assistant" && !responseStreamedText && msg.content) {
            // Fallback: if text was not streamed via deltas, extract from assistant message
            var content = msg.content;
            if (Array.isArray(content)) {
              for (var ci = 0; ci < content.length; ci++) {
                if (content[ci].type === "text" && content[ci].text) {
                  responseFullText += content[ci].text;
                  if (currentOnDelta) currentOnDelta(content[ci].text);
                }
              }
            }

          } else if (msg.yokeType === "result") {
            // One response complete. Signal done and reset for next message.
            if (currentOnActivity) currentOnActivity(null);
            var doneRef = currentOnDone;
            if (doneRef) {
              doneRef(responseFullText);
            }
            // Only reset if pushMessage was not called during onDone
            // (pushMessage swaps callbacks and resets state itself)
            if (currentOnDone === doneRef) {
              currentOnDelta = null;
              currentOnDone = null;
              currentOnError = null;
              currentOnActivity = null;
              mentionBlocks = {};
              responseFullText = "";
              responseStreamedText = false;
            }
          }
        }
      } catch (err) {
        if (currentOnError) {
          if (err.name === "AbortError" || (abortController && abortController.signal.aborted)) {
            currentOnError("Mention query was cancelled.");
          } else {
            currentOnError(err.message || String(err));
          }
        }
      }
      alive = false;
    })();

    return {
      // Push a follow-up message to the existing mention session
      pushMessage: function (text, callbacks, images) {
        currentOnDelta = callbacks.onDelta;
        currentOnDone = callbacks.onDone;
        currentOnError = callbacks.onError;
        currentOnActivity = callbacks.onActivity || null;
        mentionBlocks = {};
        responseFullText = "";
        responseStreamedText = false;
        handle.pushMessage(text, images || null);
      },
      abort: function () {
        try { abortController.abort(); } catch (e) {}
      },
      close: function () {
        alive = false;
        try { handle.close(); } catch (e) {}
      },
      isAlive: function () { return alive; },
    };
  }

  return {
    createMessageQueue: createMessageQueue,
    processSDKMessage: processSDKMessage,
    checkToolWhitelist: checkToolWhitelist,
    handleCanUseTool: handleCanUseTool,
    handleElicitation: handleElicitation,
    processQueryStream: processQueryStream,
    getOrCreateRewindQuery: getOrCreateRewindQuery,
    rewindPreview: rewindPreview,
    rewindExecuteFiles: rewindExecuteFiles,
    rollbackConversation: rollbackConversation,
    forkSession: forkSessionUnified,
    startQuery: startQuery,
    // Exposed so other auto-resume paths (e.g. restart-resume in project.js)
    // share the SAME consecutive-resume budget instead of each minting their
    // own. Keeps the runaway-resume bound authoritative across all callers.
    autoResumeAllowed: autoResumeAllowed,
    pushMessage: pushMessage,
    setModel: setModel,
    setEffort: setEffort,
    setPermissionMode: setPermissionMode,
    isClaudeProcess: isClaudeProcess,
    permissionPushTitle: permissionPushTitle,
    permissionPushBody: permissionPushBody,
    warmup: warmup,
    stopTask: stopTask,
    reloadSkills: reloadSkills,
    setMcpPermissionModeOverride: setMcpPermissionModeOverride,
    createMentionSession: createMentionSession,
    startIdleReaper: startIdleReaper,
    stopIdleReaper: stopIdleReaper,
  };
}

module.exports = { createSDKBridge, createMessageQueue };
