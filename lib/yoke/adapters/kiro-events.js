var runtime = require("./kiro-runtime");
var normalizePlanStatus = runtime.normalizePlanStatus;
var toolNameForKind = runtime.toolNameForKind;

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
    accumulateToolContent(state, callId, update);
    if (update.status === "completed" || update.status === "failed") {
      events.push({
        yokeType: "tool_result",
        toolId: callId,
        blockId: state.toolBlocks[callId],
        content: finalToolContent(state, callId, update),
        isError: update.status === "failed",
      });
    }
    return events;
  }

  // Tool call progress / completion.
  // Kiro splits tool output across events: an interim tool_call_update carries
  // `content` (no status), and a later one has status:"completed" but empty
  // content (the output lives in `rawOutput`). Accumulate content across events
  // and fall back to rawOutput at completion so tool_result is never empty.
  if (type === "tool_call_update") {
    var updId = update.toolCallId;
    if (updId && !state.toolBlocks[updId]) {
      // Result arrived before we saw the tool_call (rare) — synthesize a block.
      state.blockCounter++;
      state.toolBlocks[updId] = "blk_" + state.blockCounter;
      events.push({ yokeType: "tool_start", blockId: state.toolBlocks[updId], toolId: updId, toolName: update.title || "Tool" });
    }
    accumulateToolContent(state, updId, update);
    if (update.status === "completed" || update.status === "failed") {
      events.push({
        yokeType: "tool_result",
        toolId: updId,
        blockId: state.toolBlocks[updId],
        content: finalToolContent(state, updId, update),
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

  // Kiro v3 reports context consumption as a percentage in session_info_update
  // instead of the v2 usage_update token counters.
  if (type === "session_info_update") {
    var kiroMeta = update._meta && update._meta.kiro;
    if (kiroMeta && kiroMeta.kind === "context_usage") {
      var usage = kiroMeta.contextUsage;
      var percentage = usage && usage.usagePercentage;
      if (typeof percentage !== "number") percentage = kiroMeta.usagePercentage;
      if (typeof percentage === "number" && state.contextWindow) {
        state.lastInputTokens = Math.round(state.contextWindow * percentage / 100);
      }
    }
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

// Extract text from a Kiro `rawOutput` object. Command execution reports it as
// { items: [{ Json: { stdout, stderr, exit_status } }] }; other tools may nest
// text differently, so we walk defensively.
function extractRawOutput(rawOutput) {
  if (!rawOutput) return "";
  var items = rawOutput.items;
  if (!Array.isArray(items)) {
    if (typeof rawOutput === "string") return rawOutput;
    if (typeof rawOutput.output === "string") return rawOutput.output;
    if (typeof rawOutput.message === "string") return rawOutput.message;
    return "";
  }
  var parts = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) continue;
    var j = it.Json || it.json || it;
    if (j && typeof j === "object") {
      if (typeof j.stdout === "string" && j.stdout) parts.push(j.stdout);
      if (typeof j.stderr === "string" && j.stderr) parts.push(j.stderr);
      if (!j.stdout && !j.stderr && typeof j.text === "string") parts.push(j.text);
    } else if (typeof it === "string") {
      parts.push(it);
    }
  }
  return parts.join("").replace(/\n+$/, "");
}

// Accumulate content chunks for a tool call across the multiple tool_call_update
// events Kiro emits (interim content, then a completed event with empty content).
function accumulateToolContent(state, callId, update) {
  if (!callId) return;
  var chunk = extractToolContent(update.content);
  if (chunk) {
    state.toolContent[callId] = (state.toolContent[callId] || "") + (state.toolContent[callId] ? "\n" : "") + chunk;
  }
}

// Best available content for a finished tool call: accumulated streamed content,
// else this event's content, else the structured rawOutput.
function finalToolContent(state, callId, update) {
  var acc = callId && state.toolContent[callId];
  if (acc) return acc;
  var direct = extractToolContent(update.content);
  if (direct) return direct;
  return extractRawOutput(update.rawOutput);
}

function createEventState(opts) {
  opts = opts || {};
  return {
    blockCounter: 0,
    sessionId: opts.resumeSessionId || null,
    model: opts.model || "auto",
    engine: opts.engine || KIRO_DEFAULTS.engine,
    lastInputTokens: null,
    contextWindow: opts.contextWindow || null,
    done: false,
    aborted: false,
    loopStarted: false,
    loadingSession: false,
    textBlockOpen: false,
    textBlockId: null,
    thinkBlockOpen: false,
    thinkBlockId: null,
    toolBlocks: {},
    toolMeta: {},
    toolContent: {},
  };
}


module.exports = {
  createEventState: createEventState,
  flattenUpdate: flattenUpdate,
};
