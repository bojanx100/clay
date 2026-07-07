// YOKE Kiro Adapter
// -----------------
// Implements the YOKE interface using the Agent Client Protocol (ACP) exposed
// by `kiro-cli acp`. Bidirectional JSON-RPC 2.0 over stdin/stdout enables
// streaming output and interactive tool-permission flows.
//
// ACP turn lifecycle (simpler than Codex app-server):
//   session/new           -> { sessionId, modes, models }
//   session/set_model      -> select model for the session
//   session/prompt (req)   -> resolves with { stopReason } when the turn ends
//     ...meanwhile the agent streams session/update notifications and may send
//        session/request_permission requests for tool approvals.
//   session/cancel (notif) -> interrupt the active turn

var path = require("path");
var fs = require("fs");
var { execFile } = require("child_process");
var { KiroAcpServer, findKiroPath } = require("../kiro-acp-server");

// --- Claude skill discovery ---
// Kiro exposes its own agents/skills, but Clay users share $<skill-name>
// references from ~/.claude/skills. We mirror the Codex adapter so the same
// references resolve regardless of runtime.
function discoverClaudeSkills(cwd) {
  var skills = {};
  var REAL_HOME;
  try { REAL_HOME = require("../../config").REAL_HOME; } catch (e) { REAL_HOME = require("os").homedir(); }
  var dirs = [
    path.join(REAL_HOME, ".claude", "skills"),
    path.join(cwd || "", ".claude", "skills"),
  ];
  for (var d = 0; d < dirs.length; d++) {
    var base = dirs[d];
    if (!base) continue;
    var entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { continue; }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      var skillMd = path.join(base, entry.name, "SKILL.md");
      try {
        fs.accessSync(skillMd, fs.constants.R_OK);
        skills[entry.name] = skillMd;
      } catch (e) {}
    }
  }
  return skills;
}

var _uuidCounter = 0;
function generateUuid() {
  var ts = Date.now().toString(36);
  var cnt = (++_uuidCounter).toString(36);
  var rnd = Math.random().toString(36).substring(2, 8);
  return "kiro-" + ts + "-" + cnt + "-" + rnd;
}

function waitMs(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function waitForProcessExit(proc, timeoutMs) {
  return new Promise(function(resolve) {
    if (!proc) { resolve(true); return; }
    if (proc.exitCode !== null || proc.signalCode !== null) { resolve(true); return; }
    var done = false, timer = null;
    function cleanup() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      proc.removeListener("exit", onDone);
      proc.removeListener("close", onDone);
    }
    function onDone() { cleanup(); resolve(true); }
    proc.once("exit", onDone);
    proc.once("close", onDone);
    timer = setTimeout(function() { cleanup(); resolve(false); }, timeoutMs || 5000);
  });
}

function createShutdownError() {
  var err = new Error("Kiro adapter is shutting down, retry shortly");
  err.code = "KIRO_ADAPTER_SHUTTING_DOWN";
  return err;
}

// Detect Kiro "not logged in" errors from an error object or message string.
function isKiroAuthError(text, errObj) {
  if (errObj && errObj.kiroErrorInfo === "unauthorized") return true;
  return /not logged in|expired token|token has expired|please (?:sign in|log ?in) again|reauthenticate|kiro-cli login|no valid credentials|unauthorized|forbidden|\b401\b/i.test(String(text || ""));
}

// Map an ACP tool kind to a Clay-facing tool name so the UI can pick an icon.
function toolNameForKind(kind, title) {
  switch (kind) {
    case "execute": return "Bash";
    case "read": return "Read";
    case "edit": return "Edit";
    case "delete": return "Edit";
    case "move": return "Edit";
    case "search": return "Grep";
    case "fetch": return "WebFetch";
    case "think": return "Think";
    default: return title || "Tool";
  }
}

function normalizePlanStatus(status) {
  if (status === "in_progress" || status === "inProgress") return "in_progress";
  if (status === "completed") return "completed";
  return "pending";
}

// Fetch the model catalog from the CLI (JSON) so the picker mirrors Claude's
// dynamic listing. Internal/deprecated entries are filtered out for a clean UX.
function fetchModelsViaCli(binaryPath, cwd) {
  return new Promise(function(resolve) {
    execFile(binaryPath, ["chat", "--list-models", "--format", "json"], {
      timeout: 20000,
      cwd: cwd || process.cwd(),
      maxBuffer: 4 * 1024 * 1024,
    }, function(err, stdout) {
      if (err || !stdout) { resolve(null); return; }
      try {
        var parsed = JSON.parse(stdout);
        var models = [];
        var list = (parsed && parsed.models) || [];
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          var desc = m.description || "";
          if (/\[Internal\]|\[Deprecated\]/i.test(desc)) continue;
          if (m.model_id) models.push(m.model_id);
        }
        resolve({ models: models, defaultModel: parsed.default_model || "auto" });
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// --- Event flattening ---
// Converts ACP session/update payloads into flat yokeType events, matching the
// format the rest of Clay consumes (same shapes the Codex adapter emits).
function flattenUpdate(update, state) {
  var events = [];
  if (!update) return events;
  var type = update.sessionUpdate;

  // Streaming assistant text
  if (type === "agent_message_chunk") {
    var text = update.content && typeof update.content.text === "string" ? update.content.text : "";
    if (!state.textBlockOpen) {
      state.textBlockOpen = true;
      state.blockCounter++;
      state.textBlockId = "blk_" + state.blockCounter;
      events.push({ yokeType: "text_start", blockId: state.textBlockId });
    }
    if (text) {
      events.push({ yokeType: "text_delta", blockId: state.textBlockId, text: text });
    }
    return events;
  }

  // Streaming reasoning / thinking
  if (type === "agent_thought_chunk") {
    var think = update.content && typeof update.content.text === "string" ? update.content.text : "";
    if (!state.thinkBlockOpen) {
      state.thinkBlockOpen = true;
      state.blockCounter++;
      state.thinkBlockId = "blk_" + state.blockCounter;
      events.push({ yokeType: "thinking_start", blockId: state.thinkBlockId });
    }
    if (think) {
      events.push({ yokeType: "thinking_delta", blockId: state.thinkBlockId, text: think });
    }
    return events;
  }

  // Tool call announced
  if (type === "tool_call") {
    var callId = update.toolCallId;
    var toolName = toolNameForKind(update.kind, update.title);
    // Cache kind/rawInput so the permission handler (whose request payload only
    // carries { toolCallId, title }) can pass a canonical tool name + input to
    // canUseTool. Clay's permission whitelist keys on canonical names.
    if (callId) {
      state.toolMeta[callId] = { kind: update.kind, title: update.title, rawInput: update.rawInput || {} };
    }
    if (callId && !state.toolBlocks[callId]) {
      state.blockCounter++;
      state.toolBlocks[callId] = "blk_" + state.blockCounter;
      var blockId = state.toolBlocks[callId];
      events.push({ yokeType: "tool_start", blockId: blockId, toolId: callId, toolName: toolName });
      events.push({
        yokeType: "tool_executing",
        blockId: blockId,
        toolId: callId,
        toolName: toolName,
        input: update.rawInput || {},
      });
    }
    if (update.status === "completed" || update.status === "failed") {
      events.push({
        yokeType: "tool_result",
        toolId: callId,
        blockId: state.toolBlocks[callId],
        content: extractToolContent(update.content),
        isError: update.status === "failed",
      });
    }
    return events;
  }

  // Tool call progress / completion
  if (type === "tool_call_update") {
    var updId = update.toolCallId;
    if (updId && !state.toolBlocks[updId]) {
      // Result arrived before we saw the tool_call (rare) — synthesize a block.
      state.blockCounter++;
      state.toolBlocks[updId] = "blk_" + state.blockCounter;
      events.push({ yokeType: "tool_start", blockId: state.toolBlocks[updId], toolId: updId, toolName: update.title || "Tool" });
    }
    if (update.status === "completed" || update.status === "failed") {
      events.push({
        yokeType: "tool_result",
        toolId: updId,
        blockId: state.toolBlocks[updId],
        content: extractToolContent(update.content),
        isError: update.status === "failed",
      });
    }
    return events;
  }

  // Plan updates
  if (type === "plan") {
    var entries = Array.isArray(update.entries) ? update.entries : [];
    events.push({
      yokeType: "plan_updated",
      title: "Plan",
      explanation: "",
      plan: entries.map(function(e) {
        return { step: e.content || "", status: normalizePlanStatus(e.status) };
      }),
    });
    return events;
  }

  // Token usage
  if (type === "usage_update") {
    if (typeof update.used === "number") state.lastInputTokens = update.used;
    if (typeof update.size === "number") state.contextWindow = update.size;
    return events;
  }

  // Unknown update: pass through for observability.
  events.push({ yokeType: "runtime_specific", vendor: "kiro", eventType: "session/update:" + type, raw: update });
  return events;
}

// ACP tool content is an array of { type: "content"|"diff", ... }. Flatten it
// into a display string for the tool result bubble.
function extractToolContent(content) {
  if (!Array.isArray(content)) return "";
  var parts = [];
  for (var i = 0; i < content.length; i++) {
    var c = content[i];
    if (!c) continue;
    if (c.type === "content" && c.content && typeof c.content.text === "string") {
      parts.push(c.content.text);
    } else if (c.type === "diff") {
      var header = c.path ? ("--- " + c.path + "\n") : "";
      parts.push(header + (c.newText || ""));
    } else if (typeof c.text === "string") {
      parts.push(c.text);
    }
  }
  return parts.join("\n");
}

// --- QueryHandle ---

function createKiroQueryHandle(acp, queryOpts) {
  var abortController = queryOpts.abortController;
  var systemPrompt = queryOpts.systemPrompt || "";
  var canUseTool = queryOpts.canUseTool || null;
  var onFinished = queryOpts.onFinished || null;

  function isCancelled() {
    return state.aborted || (abortController && abortController.signal && abortController.signal.aborted);
  }

  var state = {
    blockCounter: 0,
    sessionId: queryOpts.resumeSessionId || null,
    model: queryOpts.model || "auto",
    lastInputTokens: null,
    contextWindow: null,
    done: false,
    aborted: false,
    loopStarted: false,
    // per-turn block tracking (reset each turn)
    textBlockOpen: false,
    textBlockId: null,
    thinkBlockOpen: false,
    thinkBlockId: null,
    toolBlocks: {},
    toolMeta: {},
  };

  // Async iterator plumbing
  var eventBuffer = [];
  var eventWaiting = null;
  var iteratorDone = false;
  var finishedNotified = false;

  function notifyFinished() {
    if (finishedNotified) return;
    finishedNotified = true;
    if (typeof onFinished === "function") {
      try { onFinished(); } catch (e) { console.error("[yoke/kiro] onFinished error:", e.message || e); }
    }
  }

  function pushEvent(evt) {
    if (iteratorDone) return;
    if (eventWaiting) {
      var resolve = eventWaiting;
      eventWaiting = null;
      resolve({ value: evt, done: false });
    } else {
      eventBuffer.push(evt);
    }
  }

  function endIterator() {
    iteratorDone = true;
    if (eventWaiting) {
      var resolve = eventWaiting;
      eventWaiting = null;
      resolve({ value: undefined, done: true });
    }
    notifyFinished();
  }

  // Multi-turn message queue
  var messageQueue = [];
  var messageWaiting = null;
  var messageQueueEnded = false;

  function pushMessageToQueue(msg) {
    if (messageQueueEnded) return;
    if (messageWaiting) {
      var resolve = messageWaiting;
      messageWaiting = null;
      resolve(msg);
    } else {
      messageQueue.push(msg);
    }
  }
  function waitForMessage() {
    if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift());
    if (messageQueueEnded) return Promise.resolve(null);
    return new Promise(function(resolve) { messageWaiting = resolve; });
  }

  // --- ACP event handler ---
  function isApproved(decision) {
    if (!decision) return false;
    if (decision === true) return true;
    if (decision.behavior === "allow") return true;
    return false;
  }

  function handleServerEvent(msg) {
    var method = msg.method;
    var params = msg.params || {};

    // Ignore events from other sessions (ACP process is per-adapter, but be safe).
    if (params.sessionId && state.sessionId && params.sessionId !== state.sessionId) return;

    // Tool permission request (server -> client, has an id we must answer)
    if (method === "session/request_permission") {
      var tc = params.toolCall || {};
      var options = params.options || [];
      function pickOption(kinds) {
        for (var i = 0; i < options.length; i++) {
          if (kinds.indexOf(options[i].kind) !== -1) return options[i].optionId;
        }
        return null;
      }
      var allowId = pickOption(["allow_once", "allow_always"]) || (options[0] && options[0].optionId);
      var rejectId = pickOption(["reject_once", "reject_always"]) || (options[options.length - 1] && options[options.length - 1].optionId);

      if (isCancelled()) {
        acp.respond(msg.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      if (canUseTool) {
        // The permission request payload carries only { toolCallId, title }.
        // Recover kind + rawInput from the tool_call notification we cached.
        var meta = (tc.toolCallId && state.toolMeta[tc.toolCallId]) || {};
        var toolName = toolNameForKind(tc.kind || meta.kind, tc.title || meta.title);
        var toolInput = tc.rawInput || meta.rawInput || { title: tc.title || meta.title };
        canUseTool(toolName, toolInput, {}).then(function(decision) {
          acp.respond(msg.id, { outcome: { outcome: "selected", optionId: isApproved(decision) ? allowId : rejectId } });
        }).catch(function(err) {
          console.error("[yoke/kiro] canUseTool error:", err.message);
          acp.respond(msg.id, { outcome: { outcome: "selected", optionId: rejectId } });
        });
      } else {
        acp.respond(msg.id, { outcome: { outcome: "selected", optionId: allowId } });
      }
      return;
    }

    // Session updates (streaming)
    if (method === "session/update") {
      if (isCancelled()) return;
      var yokeEvents = flattenUpdate(params.update, state);
      for (var i = 0; i < yokeEvents.length; i++) pushEvent(yokeEvents[i]);
      return;
    }

    // Synthetic auth error from the transport layer
    if (method === "_kiro/error") {
      if (isKiroAuthError(params.error && params.error.message, params.error)) {
        pushEvent({ yokeType: "auth_required", vendor: "kiro" });
      } else {
        pushEvent({ yokeType: "error", text: (params.error && params.error.message) || "Kiro error" });
      }
      return;
    }

    // _kiro.dev/* notifications (commands, metadata, subagents, mcp status) are
    // informational; ignore them quietly to avoid noise.
  }

  // Close the currently open streaming blocks at turn end.
  function closeOpenBlocks() {
    if (state.thinkBlockOpen) {
      pushEvent({ yokeType: "thinking_stop", blockId: state.thinkBlockId });
      state.thinkBlockOpen = false;
    }
  }

  function resetTurnState() {
    state.textBlockOpen = false;
    state.textBlockId = null;
    state.thinkBlockOpen = false;
    state.thinkBlockId = null;
    state.toolBlocks = {};
    state.toolMeta = {};
  }

  function emitResult() {
    var inputTokens = state.lastInputTokens || 0;
    var hasTokenData = inputTokens > 0;
    var resultModelUsage = {};
    resultModelUsage[state.model] = { contextWindow: state.contextWindow || null };
    pushEvent({
      yokeType: "result",
      uuid: generateUuid(),
      messageType: "assistant",
      cost: null,
      duration: null,
      usage: hasTokenData ? {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      } : null,
      modelUsage: resultModelUsage,
      sessionId: state.sessionId || null,
      lastStreamInputTokens: state.lastInputTokens || null,
    });
  }

  // --- Main query loop ---
  async function runQueryLoop(initialMessage) {
    // Prepend the YOKE-merged system prompt to the first message's text.
    var currentMessage;
    if (!systemPrompt) {
      currentMessage = initialMessage;
    } else if (typeof initialMessage === "string") {
      currentMessage = systemPrompt + "\n\n" + initialMessage;
    } else if (Array.isArray(initialMessage)) {
      var cloned = initialMessage.slice();
      var injected = false;
      for (var i = 0; i < cloned.length; i++) {
        if (cloned[i] && cloned[i].type === "text") {
          cloned[i] = { type: "text", text: systemPrompt + "\n\n" + (cloned[i].text || "") };
          injected = true;
          break;
        }
      }
      if (!injected) cloned.unshift({ type: "text", text: systemPrompt });
      currentMessage = cloned;
    } else {
      currentMessage = initialMessage;
    }

    try {
      acp.eventHandler = handleServerEvent;

      // Create or resume the session.
      if (state.sessionId) {
        await acp.send("session/load", {
          sessionId: state.sessionId,
          cwd: queryOpts.cwd,
          mcpServers: queryOpts.mcpServers || [],
        }, 60000).catch(function(e) {
          // If load fails (unknown session), fall back to a fresh session.
          console.warn("[yoke/kiro] session/load failed, starting fresh:", e.message);
          state.sessionId = null;
        });
      }
      if (!state.sessionId) {
        var newResult = await acp.send("session/new", {
          cwd: queryOpts.cwd,
          mcpServers: queryOpts.mcpServers || [],
        }, 60000);
        state.sessionId = newResult && newResult.sessionId;
      }

      // Select model + mode for the session (best-effort; failures are non-fatal).
      if (queryOpts.model) {
        await acp.send("session/set_model", { sessionId: state.sessionId, modelId: queryOpts.model }, 15000).catch(function() {});
      }
      if (queryOpts.mode) {
        await acp.send("session/set_mode", { sessionId: state.sessionId, modeId: queryOpts.mode }, 15000).catch(function() {});
      }

      while (!isCancelled()) {
        resetTurnState();

        var input = typeof currentMessage === "string"
          ? [{ type: "text", text: currentMessage }]
          : currentMessage;

        // Emit turn_start so the UI records a user turn boundary.
        pushEvent({ yokeType: "turn_start", uuid: generateUuid(), messageType: "user" });

        var promptResult = await acp.send("session/prompt", {
          sessionId: state.sessionId,
          prompt: input,
        }, 30 * 60 * 1000);

        closeOpenBlocks();

        var stopReason = promptResult && promptResult.stopReason;
        if (isCancelled() || stopReason === "cancelled") {
          pushEvent({ yokeType: "interrupted" });
          emitResult();
          break;
        }
        emitResult();

        var nextMsg = await waitForMessage();
        if (nextMsg === null) break;
        currentMessage = nextMsg;
      }
    } catch (e) {
      if (!isCancelled() && e.name !== "AbortError") {
        var loopErrMsg = e.message || String(e);
        console.error("[yoke/kiro] runQueryLoop error:", loopErrMsg);
        pushEvent(isKiroAuthError(loopErrMsg, e.rpcError)
          ? { yokeType: "auth_required", vendor: "kiro" }
          : { yokeType: "error", text: loopErrMsg });
      }
    }

    state.done = true;
    endIterator();
  }

  var handle = {
    [Symbol.asyncIterator]: function() {
      return {
        next: function() {
          if (eventBuffer.length > 0) return Promise.resolve({ value: eventBuffer.shift(), done: false });
          if (iteratorDone) return Promise.resolve({ value: undefined, done: true });
          return new Promise(function(resolve) { eventWaiting = resolve; });
        },
      };
    },

    pushMessage: function(text, images) {
      var input = [];
      if (images && images.length > 0) {
        for (var i = 0; i < images.length; i++) {
          var img = images[i];
          if (img && img.base64 && img.mimeType) {
            input.push({ type: "image", data: img.base64, mimeType: img.mimeType });
          }
        }
      }
      input.push({ type: "text", text: text || "" });
      var payload = input.length === 1 && input[0].type === "text" ? input[0].text : input;

      if (!state.loopStarted) {
        state.loopStarted = true;
        runQueryLoop(payload);
      } else {
        pushMessageToQueue(payload);
      }
    },

    setModel: function(model) {
      state.model = model;
      if (state.sessionId && acp.started) {
        return acp.send("session/set_model", { sessionId: state.sessionId, modelId: model }, 15000).catch(function() {});
      }
      return Promise.resolve();
    },

    setEffort: function() { return Promise.resolve(); },
    setToolPolicy: function() { return Promise.resolve(); },
    stopTask: function() { return Promise.resolve(); },

    getContextUsage: function() {
      return Promise.resolve(state.lastInputTokens != null ? {
        input_tokens: state.lastInputTokens,
        contextWindow: state.contextWindow || null,
      } : null);
    },

    abort: function() {
      console.log("[yoke/kiro] handle.abort() sessionId=" + state.sessionId + " already=" + state.aborted);
      state.aborted = true;
      if (state.sessionId && acp.started) {
        // ACP cancellation is a notification; the in-flight session/prompt will
        // resolve with stopReason "cancelled".
        acp.notify("session/cancel", { sessionId: state.sessionId });
      }
      endIterator();
    },

    close: function() {
      messageQueueEnded = true;
      if (messageWaiting) {
        var resolve = messageWaiting;
        messageWaiting = null;
        resolve(null);
      }
      endIterator();
    },

    endInput: function() {
      messageQueueEnded = true;
      if (messageWaiting) {
        var resolve = messageWaiting;
        messageWaiting = null;
        resolve(null);
      }
    },
  };

  if (abortController && abortController.signal) {
    abortController.signal.addEventListener("abort", function() {
      if (!state.aborted) handle.abort();
    }, { once: true });
  }

  return handle;
}

// --- Adapter factory ---

function createKiroAdapter(opts) {
  var _cwd = (opts && opts.cwd) || process.cwd();
  var _slug = (opts && opts.slug) || "";
  var _defaultInitOpts = Object.assign({}, opts || {});
  var _binaryPath = null;
  try { _binaryPath = findKiroPath(); } catch (e) { _binaryPath = null; }

  var _acp = null;
  var _initPromise = null;
  var _shutdownPromise = null;
  var _shuttingDown = false;
  var _refCount = 0;
  var _lastActiveAt = Date.now();
  var _activeQueries = [];
  var _cachedModels = [];
  var _defaultModel = "auto";

  function updateLastActiveAt() { _lastActiveAt = Date.now(); }
  function registerActiveQuery(entry) { _activeQueries.push(entry); }
  function removeActiveQuery(entry) {
    var next = [];
    for (var i = 0; i < _activeQueries.length; i++) {
      if (_activeQueries[i] !== entry) next.push(_activeQueries[i]);
    }
    _activeQueries = next;
  }
  function decrementRefCount() {
    if (_refCount > 0) _refCount--;
    else { console.error("[yoke/kiro] refCount negative, bug!"); _refCount = 0; }
    updateLastActiveAt();
  }

  function buildReadyResponse(skillNames) {
    return {
      models: _cachedModels,
      defaultModel: _defaultModel,
      skills: skillNames || [],
      slashCommands: skillNames || [],
      fastModeState: null,
      capabilities: {
        thinking: true,
        betas: false,
        rewind: false,
        sessionResume: true,
        promptSuggestions: false,
        elicitation: false,
        fileCheckpointing: false,
        contextCompacting: true,
        toolPolicy: ["ask", "allow-all"],
      },
    };
  }

  function clearRuntimeState() {
    _acp = null;
    _initPromise = null;
    _refCount = 0;
    _activeQueries = [];
    updateLastActiveAt();
  }

  function waitForRefCount(targetCount, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 5000);
    return new Promise(function(resolve) {
      function tick() {
        if (_refCount <= targetCount) { resolve(true); return; }
        if (Date.now() >= deadline) { resolve(false); return; }
        setTimeout(tick, 50);
      }
      tick();
    });
  }

  function stopAcp(deadlineMs) {
    var proc = _acp && _acp.proc ? _acp.proc : null;
    if (!_acp) return Promise.resolve(true);
    try { _acp.stop(); } catch (e) { console.error("[yoke/kiro] ACP stop error:", e.message || e); }
    if (!proc) return Promise.resolve(true);
    var remaining = (typeof deadlineMs === "number") ? Math.max(0, deadlineMs - Date.now()) : 5000;
    return waitForProcessExit(proc, remaining).then(function(exited) {
      if (!exited) { try { proc.kill("SIGKILL"); } catch (e) {} }
      return exited;
    });
  }

  function beginShutdown(force) {
    if (_shutdownPromise) return _shutdownPromise;
    if (_shuttingDown) return null;
    _shuttingDown = true;

    _shutdownPromise = (async function() {
      var deadline = Date.now() + 5000;
      if (_initPromise) {
        try { await Promise.race([_initPromise.catch(function() { return null; }), waitMs(Math.max(0, deadline - Date.now()))]); } catch (e) {}
      }
      if (force && _activeQueries.length > 0) {
        var active = _activeQueries.slice();
        for (var i = 0; i < active.length; i++) {
          try { if (active[i] && active[i].abort) active[i].abort(); } catch (e) {}
        }
        await waitForRefCount(0, Math.max(0, deadline - Date.now()));
      }
      if (_acp) await stopAcp(deadline);
      clearRuntimeState();
      _shuttingDown = false;
      _shutdownPromise = null;
      return true;
    })().catch(function(err) {
      clearRuntimeState();
      _shuttingDown = false;
      _shutdownPromise = null;
      throw err;
    });

    return _shutdownPromise;
  }

  var adapter = {
    vendor: "kiro",

    init: function(initOpts) {
      if (_shuttingDown) return Promise.reject(createShutdownError());
      var effectiveInitOpts = Object.assign({}, _defaultInitOpts, initOpts || {});

      if (_acp && _acp.started && _cachedModels.length > 0) {
        return Promise.resolve(buildReadyResponse([]));
      }
      if (_initPromise) return _initPromise;

      _initPromise = (async function() {
        if (!_binaryPath) {
          try { _binaryPath = findKiroPath(); }
          catch (e) { throw new Error("kiro-cli binary not found: " + e.message); }
        }

        // Fetch the model catalog (dynamic, like Claude). Non-fatal on failure.
        var catalog = await fetchModelsViaCli(_binaryPath, _cwd);
        if (catalog && catalog.models.length > 0) {
          _cachedModels = catalog.models;
          _defaultModel = catalog.defaultModel || "auto";
        }

        // Spawn and initialize the ACP server.
        _acp = new KiroAcpServer(_binaryPath, { cwd: _cwd, env: effectiveInitOpts.env || null });
        await _acp.start();
        await _acp.send("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "clay", version: "1.0.0" },
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        }, 30000);

        if (_shuttingDown) { await stopAcp(Date.now() + 1000); throw createShutdownError(); }

        // If the CLI catalog was unavailable, fall back to a minimal default set.
        if (_cachedModels.length === 0) {
          _cachedModels = ["auto", "claude-sonnet-4.5", "claude-opus-4.5"];
          _defaultModel = "auto";
        }

        // Discover Claude skills so $<skill-name> references resolve.
        var skillNames = Object.keys(discoverClaudeSkills(_cwd));
        console.log("[yoke/kiro] ACP initialized, models: " + _cachedModels.length + ", skills: " + skillNames.length);

        _initPromise = null;
        updateLastActiveAt();
        return buildReadyResponse(skillNames);
      })();

      return _initPromise;
    },

    supportedModels: function() {
      if (_cachedModels.length > 0) return Promise.resolve(_cachedModels.slice());
      if (!_binaryPath) return Promise.resolve([]);
      return fetchModelsViaCli(_binaryPath, _cwd).then(function(catalog) {
        if (catalog && catalog.models.length > 0) {
          _cachedModels = catalog.models;
          _defaultModel = catalog.defaultModel || "auto";
        }
        return _cachedModels.slice();
      });
    },

    createToolServer: function() {
      // Kiro handles tools internally; MCP goes through session/new mcpServers.
      return null;
    },

    createQuery: async function(queryOpts) {
      if (_shuttingDown) throw createShutdownError();
      if (!_acp || !_acp.started) await adapter.init(queryOpts || {});
      if (_shuttingDown) throw createShutdownError();
      if (!_acp || !_acp.started) throw new Error("[yoke/kiro] Adapter not initialized. Call init() first.");

      var model = queryOpts.model || _defaultModel || "auto";
      var ac = queryOpts.abortController || new AbortController();
      var kiroOpts = (queryOpts.adapterOptions && queryOpts.adapterOptions.KIRO) || {};

      var activeEntry = { abort: function() { try { ac.abort(); } catch (e) {} } };

      var handleOpts = {
        model: model,
        mode: kiroOpts.mode || null,
        cwd: queryOpts.cwd || _cwd,
        systemPrompt: queryOpts.systemPrompt || "",
        abortController: ac,
        canUseTool: queryOpts.canUseTool || null,
        resumeSessionId: queryOpts.resumeSessionId || null,
        mcpServers: kiroOpts.mcpServers || [],
      };

      console.log("[yoke/kiro] createQuery: model=" + model + " resume=" + (handleOpts.resumeSessionId || "none"));

      _refCount++;
      registerActiveQuery(activeEntry);

      var handle;
      try {
        handleOpts.onFinished = function() {
          removeActiveQuery(activeEntry);
          decrementRefCount();
        };
        handle = createKiroQueryHandle(_acp, handleOpts);
      } catch (e) {
        removeActiveQuery(activeEntry);
        decrementRefCount();
        throw e;
      }

      activeEntry.handle = handle;
      activeEntry.abort = function() {
        try {
          if (handle && typeof handle.abort === "function") handle.abort();
          else ac.abort();
        } catch (e) {}
      };

      return handle;
    },

    generateTitle: async function(messages, opts) {
      var systemPrompt = "You are a title generator. Output only a short title (3-8 words). No quotes, no punctuation at the end, no explanation.";
      var prompt = "Below is a conversation between a user and an AI assistant. Generate a short, descriptive title (3-8 words) that captures the main topic. Reply with ONLY the title, nothing else.\n\n";
      for (var i = 0; i < messages.length; i++) {
        prompt += "User message " + (i + 1) + ": " + messages[i] + "\n";
      }
      var ac = new AbortController();
      var handle = await adapter.createQuery({
        cwd: (opts && opts.cwd) || _cwd,
        systemPrompt: systemPrompt,
        model: "auto",
        abortController: ac,
        canUseTool: function() { return Promise.resolve({ behavior: "deny", message: "No tools." }); },
      });
      handle.pushMessage(prompt);
      var title = "";
      try {
        for await (var msg of handle) {
          if (msg.yokeType === "text_delta" && msg.text) title += msg.text;
          else if (msg.yokeType === "result") break;
        }
      } finally {
        handle.close();
      }
      return title.replace(/[\r\n]+/g, " ").replace(/^["'\s]+|["'\s.]+$/g, "").trim();
    },

    getSessionInfo: function() { return Promise.resolve(null); },
    listSessions: function() { return Promise.resolve([]); },
    renameSession: function() { return Promise.resolve(); },
    forkSession: function() { return Promise.resolve(null); },

    shutdown: function() { return beginShutdown(true); },

    shutdownIfIdle: function(idleMs) {
      if (_shuttingDown || _shutdownPromise) return Promise.resolve(false);
      if (_initPromise) return Promise.resolve(false);
      if (!_acp) return Promise.resolve(false);
      if (_refCount > 0) return Promise.resolve(false);
      if (Date.now() - _lastActiveAt < (idleMs || 0)) return Promise.resolve(false);
      return beginShutdown(false).then(function() {
        console.log("[yoke/kiro] Reclaimed idle adapter for project " + (_slug || _cwd));
        return true;
      });
    },
  };

  return adapter;
}

module.exports = {
  createKiroAdapter: createKiroAdapter,
};
