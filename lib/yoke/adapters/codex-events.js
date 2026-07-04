var codexRoutingUtils = require("./codex-routing-utils");
var generateUuid = codexRoutingUtils.generateUuid;
var normalizePlanStatus = codexRoutingUtils.normalizePlanStatus;
var isCodexAuthError = codexRoutingUtils.isCodexAuthError;
var extractPromptSuggestion = codexRoutingUtils.extractPromptSuggestion;
var eventTurnId = codexRoutingUtils.eventTurnId;
var positiveNumberValue = codexRoutingUtils.positiveNumberValue;
var currentContextTokensFromTokenUsage = codexRoutingUtils.currentContextTokensFromTokenUsage;

var CLAY_DEBUG_EVENTS = process.env.CLAY_DEBUG_EVENTS === "1";

function flattenEvent(notification, state) {
  var events = [];
  var method = notification.method;
  var params = notification.params || {};

  if (method === "thread/started") {
    state.threadId = params.thread ? params.thread.id : (params.threadId || null);
    return events;
  }

  if (method === "turn/started") {
    state.turnStarted = true;
    state.turnId = eventTurnId(params);
    var userUuid = generateUuid();
    events.push({ yokeType: "turn_start", uuid: userUuid, messageType: "user" });
    return events;
  }

  if (method === "turn/completed") {
    var usage = params.usage || null;
    var turnStatus = params.status || (params.turn && params.turn.status) || null;
    state.lastUsage = usage;
    if (turnStatus === "interrupted" || state.aborted) {
      events.push({ yokeType: "interrupted" });
    }
    var inputTokens = state.lastInputTokens || (usage ? (usage.input_tokens || 0) + (usage.cached_input_tokens || 0) : 0);
    var outputTokens = usage ? (usage.output_tokens || 0) : 0;
    var cachedTokens = usage ? (usage.cached_input_tokens || 0) : 0;
    var hasTokenData = inputTokens > 0 || outputTokens > 0;
    var resultModelUsage = {};
    resultModelUsage[state.model] = { contextWindow: state.contextWindowTokens || null };
    var assistantUuid = generateUuid();
    events.push({
      yokeType: "result",
      uuid: assistantUuid,
      messageType: "assistant",
      cost: null,
      duration: null,
      usage: hasTokenData ? {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedTokens,
        cache_creation_input_tokens: 0,
      } : null,
      modelUsage: resultModelUsage,
      sessionId: state.threadId || null,
      lastStreamInputTokens: state.lastInputTokens || null,
      contextWindow: state.contextWindowTokens || null,
      contextUsedTokens: state.lastContextUsedTokens || null,
      truncatedReason: null,
    });
    state.lastInputTokens = null;
    return events;
  }

  if (method === "turn/plan/updated") {
    events.push({
      yokeType: "plan_updated",
      turnId: params.turnId || null,
      explanation: params.explanation || "",
      title: "Plan",
      plan: Array.isArray(params.plan) ? params.plan.map(function(step) {
        return {
          step: step && step.step ? step.step : "",
          status: normalizePlanStatus(step && step.status),
        };
      }) : [],
    });
    return events;
  }

  if (method === "turn/failed") {
    var tfMsg = params.error ? params.error.message : "Turn failed";
    if (isCodexAuthError(tfMsg, params.error)) {
      events.push({ yokeType: "auth_required", vendor: "codex" });
      return events;
    }
    events.push({
      yokeType: "error",
      text: tfMsg,
    });
    return events;
  }

  if (method === "account/rateLimits/updated") {
    var rl = params.rateLimits;
    if (rl) {
      var windows = [
        { key: "primary", type: "five_hour" },
        { key: "secondary", type: "seven_day" },
      ];
      for (var wi = 0; wi < windows.length; wi++) {
        var w = rl[windows[wi].key];
        if (!w) continue;
        var utilization = (w.usedPercent || 0) / 100;
        var status = "allowed";
        if (w.usedPercent >= 100) status = "rejected";
        else if (w.usedPercent >= 80) status = "allowed_warning";
        events.push({
          yokeType: "rate_limit",
          rateLimitInfo: {
            status: status,
            resetsAt: w.resetsAt || null,
            rateLimitType: windows[wi].type,
            utilization: utilization,
            isUsingOverage: false,
          },
        });
      }
    }
    return events;
  }

  if (method === "item/agentMessage/delta") {
    if (!state.agentBlockId) {
      state.blockCounter++;
      state.agentBlockId = "blk_" + state.blockCounter;
      events.push({ yokeType: "text_start", blockId: state.agentBlockId });
    }
    if (params.delta) {
      events.push({
        yokeType: "text_delta",
        blockId: state.agentBlockId,
        text: params.delta,
      });
      state.agentTextLen += params.delta.length;
    }
    return events;
  }

  if (method === "item/plan/delta") {
    var planDeltaItemId = params.itemId || params.id;
    var nextPlanText = (state.planTexts[planDeltaItemId] || "") + (params.delta || "");
    if (planDeltaItemId) state.planTexts[planDeltaItemId] = nextPlanText;
    if (nextPlanText) {
      events.push({
        yokeType: "plan_content",
        content: nextPlanText,
        itemId: planDeltaItemId || null,
      });
    }
    return events;
  }

  if (method === "serverRequest/resolved") {
    return events;
  }

  if (method === "item/started" || method === "item/updated" || method === "item/completed") {
    var item = params.item;
    if (!item) return events;

    var evtPhase = method.split("/")[1];

    if (item.type === "plan") {
      if (typeof item.text === "string") {
        state.planTexts[item.id] = item.text;
        events.push({
          yokeType: "plan_content",
          content: item.text,
          itemId: item.id,
          final: evtPhase === "completed",
        });
      }
      return events;
    }

    if (item.type === "contextCompaction" || item.type === "context_compaction") {
      events.push({
        yokeType: "status",
        status: evtPhase === "completed" ? "processing" : "compacting",
      });
      return events;
    }

    if (item.type === "agentMessage" || item.type === "agent_message") {
      if (!state.agentBlockId) {
        state.blockCounter++;
        state.agentBlockId = "blk_" + state.blockCounter;
        events.push({ yokeType: "text_start", blockId: state.agentBlockId });
      }
      if (typeof item.text === "string" && item.text.length > state.agentTextLen) {
        events.push({
          yokeType: "text_delta",
          blockId: state.agentBlockId,
          text: item.text.substring(state.agentTextLen),
        });
        state.agentTextLen = item.text.length;
      }
      if (evtPhase === "completed") {
        state.agentBlockId = null;
        state.agentTextLen = 0;
      }
      return events;
    }

    if (item.type === "reasoning") {
      if (!state.thinkingBlocks[item.id]) {
        state.blockCounter++;
        state.thinkingBlocks[item.id] = "blk_" + state.blockCounter;
        events.push({ yokeType: "thinking_start", blockId: "blk_" + state.blockCounter });
      }
      var reasoningText = "";
      if (typeof item.text === "string" && item.text.length > 0) {
        reasoningText = item.text;
      } else if (typeof item.summary === "string" && item.summary.length > 0) {
        reasoningText = item.summary;
      } else if (Array.isArray(item.content)) {
        var parts = [];
        for (var rpi = 0; rpi < item.content.length; rpi++) {
          var rp = item.content[rpi];
          if (rp && typeof rp.text === "string") parts.push(rp.text);
        }
        reasoningText = parts.join("\n");
      }
      if (reasoningText) {
        var thinkBlockId = state.thinkingBlocks[item.id];
        var prevThinkLen = state.thinkingLengths[item.id] || 0;
        if (reasoningText.length > prevThinkLen) {
          events.push({
            yokeType: "thinking_delta",
            blockId: thinkBlockId,
            text: reasoningText.substring(prevThinkLen),
          });
          state.thinkingLengths[item.id] = reasoningText.length;
        }
      }
      if (evtPhase === "completed") {
        events.push({ yokeType: "thinking_stop", blockId: state.thinkingBlocks[item.id] });
      }
      return events;
    }

    if (item.type === "commandExecution" || item.type === "command_execution") {
      var commandText = item.command || state.commandInputs[item.id] || "";
      if (commandText) state.commandInputs[item.id] = commandText;
      if (!state.toolBlocks[item.id]) {
        state.blockCounter++;
        state.toolBlocks[item.id] = "blk_" + state.blockCounter;
        var toolBlockId = state.toolBlocks[item.id];
        events.push({
          yokeType: "tool_start",
          blockId: toolBlockId,
          toolId: item.id,
          toolName: "Bash",
        });
        events.push({
          yokeType: "tool_executing",
          blockId: toolBlockId,
          toolId: item.id,
          toolName: "Bash",
          input: { command: commandText },
        });
      }
      if (evtPhase === "completed") {
        var cmdBuf = state.commandOutputs[item.id];
        events.push({
          yokeType: "tool_result",
          toolId: item.id,
          blockId: state.toolBlocks[item.id],
          content: item.aggregated_output || item.output || (cmdBuf && cmdBuf.text) || "",
          isError: item.status === "failed",
        });
        delete state.commandOutputs[item.id];
      }
      return events;
    }

    if (item.type === "fileChange" || item.type === "file_change") {
      var changes = item.changes || [];
      var changeDesc = changes.map(function(c) { return c.kind + " " + c.path; }).join(", ");
      var primaryPath = changes.length === 1 ? (changes[0].path || "") : "";
      if (!state.toolBlocks[item.id]) {
        state.blockCounter++;
        state.toolBlocks[item.id] = "blk_" + state.blockCounter;
        var fcBlockId = state.toolBlocks[item.id];
        events.push({
          yokeType: "tool_start",
          blockId: fcBlockId,
          toolId: item.id,
          toolName: "Edit",
        });
        events.push({
          yokeType: "tool_executing",
          blockId: fcBlockId,
          toolId: item.id,
          toolName: "Edit",
          input: {
            changes: changeDesc,
            file_path: primaryPath || undefined,
          },
        });
      }
      if (evtPhase === "completed") {
        var diffText = changes.map(function(c) {
          return c && c.diff ? c.diff : "";
        }).filter(Boolean).join("\n\n");
        events.push({
          yokeType: "tool_result",
          toolId: item.id,
          blockId: state.toolBlocks[item.id],
          content: diffText || (item.status === "completed" ? "Changes applied" : "Changes failed"),
          isError: item.status === "failed",
        });
      }
      return events;
    }

    if (item.type === "mcpToolCall" || item.type === "mcp_tool_call") {
      console.log("[yoke/codex] MCP event:", method, "tool=" + (item.tool || "?"), "status=" + (item.status || "?"), "error=" + (item.error ? JSON.stringify(item.error) : "none"));
      if (!state.toolBlocks[item.id]) {
        state.blockCounter++;
        state.toolBlocks[item.id] = "blk_" + state.blockCounter;
        var mcpBlockId = state.toolBlocks[item.id];
        events.push({
          yokeType: "tool_start",
          blockId: mcpBlockId,
          toolId: item.id,
          toolName: item.tool || "mcp_tool",
        });
        events.push({
          yokeType: "tool_executing",
          blockId: mcpBlockId,
          toolId: item.id,
          toolName: item.tool || "mcp_tool",
          input: item.arguments || {},
        });
      }
      if (evtPhase === "completed") {
        var resultText = "";
        if (item.result && item.result.content) {
          resultText = item.result.content.map(function(c) { return c.text || ""; }).join("\n");
        }
        if (item.error) resultText = item.error.message;
        events.push({
          yokeType: "tool_result",
          toolId: item.id,
          blockId: state.toolBlocks[item.id],
          content: resultText,
          isError: !!item.error,
        });
      }
      return events;
    }

    if (item.type === "webSearch" || item.type === "web_search") {
      if (!state.toolBlocks[item.id]) {
        state.blockCounter++;
        state.toolBlocks[item.id] = "blk_" + state.blockCounter;
        events.push({
          yokeType: "tool_start",
          blockId: state.toolBlocks[item.id],
          toolId: item.id,
          toolName: "WebSearch",
        });
      }
      return events;
    }

    if (item.type === "error") {
      var ieMsg = item.message || "Unknown error";
      if (isCodexAuthError(ieMsg, item)) {
        events.push({ yokeType: "auth_required", vendor: "codex" });
        return events;
      }
      events.push({
        yokeType: "error",
        text: ieMsg,
      });
      return events;
    }
  }

  if (method === "thread/tokenUsage/updated") {
    var tu = params.tokenUsage;
    if (tu && tu.total) {
      state.lastInputTokens = positiveNumberValue(tu.total, [
        "inputTokens",
        "input_tokens",
        "promptTokens",
        "prompt_tokens",
      ]);
      var usedTokens = currentContextTokensFromTokenUsage(tu);
      var windowTokens = tu.modelContextWindow || tu.model_context_window || tu.contextWindow || 0;
      if (usedTokens) state.lastContextUsedTokens = usedTokens;
      if (windowTokens) state.contextWindowTokens = windowTokens;
    }
    return events;
  }

  if (method === "item/commandExecution/outputDelta") {
    var coItemId = params.itemId || params.id;
    if (!coItemId || typeof params.delta !== "string") return events;
    var coBuf = state.commandOutputs[coItemId];
    if (!coBuf) { coBuf = { text: "", emittedLen: 0 }; state.commandOutputs[coItemId] = coBuf; }
    coBuf.text += params.delta;
    var OUTPUT_COALESCE_BYTES = 2048;
    if (coBuf.text.length - coBuf.emittedLen >= OUTPUT_COALESCE_BYTES) {
      var tail = coBuf.text.substring(coBuf.emittedLen);
      coBuf.emittedLen = coBuf.text.length;
      events.push({
        yokeType: "tool_output",
        toolId: coItemId,
        blockId: state.toolBlocks[coItemId],
        text: tail,
      });
    }
    return events;
  }

  var promptSuggestion = extractPromptSuggestion(params);
  if (promptSuggestion) {
    events.push({
      yokeType: "prompt_suggestion",
      suggestion: promptSuggestion,
    });
    return events;
  }

  if (method === "error" && params && params.error) {
    var cErr = params.error;
    var cErrMsg = cErr.message || "Codex error";
    if (isCodexAuthError(cErrMsg, cErr)) {
      events.push({ yokeType: "auth_required", vendor: "codex" });
      return events;
    }
    events.push({ yokeType: "error", text: cErrMsg });
    return events;
  }

  if (CLAY_DEBUG_EVENTS) console.log("[yoke/codex] UNHANDLED event:", method, JSON.stringify(params).substring(0, 200));
  events.push({
    yokeType: "runtime_specific",
    vendor: "codex",
    eventType: method,
    raw: params,
  });

  return events;
}

module.exports = {
  flattenEvent: flattenEvent,
};
