function flattenEvent(raw) {
  var base = {};
  if (raw.session_id) base.sessionId = raw.session_id;
  if (raw.uuid) {
    base.uuid = raw.uuid;
    base.messageType = raw.type;
    base.parentToolUseId = raw.parent_tool_use_id || null;
  }

  if (raw.type === "stream_event" && raw.event) {
    var evt = raw.event;

    if (evt.type === "message_start") {
      base.yokeType = "turn_start";
      if (evt.message && evt.message.usage) {
        var u = evt.message.usage;
        base.inputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
      }
      return base;
    }

    if (evt.type === "content_block_start" && evt.content_block) {
      var block = evt.content_block;
      base.blockIndex = evt.index;
      base.blockId = "blk_" + evt.index;
      if (block.type === "tool_use") {
        base.yokeType = "tool_start";
        base.toolId = block.id;
        base.toolName = block.name;
      } else if (block.type === "thinking") {
        base.yokeType = "thinking_start";
      } else if (block.type === "text") {
        base.yokeType = "text_start";
      } else {
        base.yokeType = "block_start";
        base.blockType = block.type;
      }
      return base;
    }

    if (evt.type === "content_block_delta" && evt.delta) {
      base.blockIndex = evt.index;
      base.blockId = "blk_" + evt.index;
      if (evt.delta.type === "text_delta") {
        base.yokeType = "text_delta";
        base.text = evt.delta.text;
      } else if (evt.delta.type === "input_json_delta") {
        base.yokeType = "tool_input_delta";
        base.partialJson = evt.delta.partial_json;
      } else if (evt.delta.type === "thinking_delta") {
        base.yokeType = "thinking_delta";
        base.text = evt.delta.thinking;
      } else {
        base.yokeType = "block_delta";
        base.delta = evt.delta;
      }
      return base;
    }

    if (evt.type === "content_block_stop") {
      base.yokeType = "block_stop";
      base.blockIndex = evt.index;
      base.blockId = "blk_" + evt.index;
      return base;
    }

    if (evt.type === "message_delta" && evt.delta) {
      base.yokeType = "message_delta";
      base.stopReason = evt.delta.stop_reason || null;
      return base;
    }

    if (evt.type === "message_stop") {
      base.yokeType = "turn_stop";
      return base;
    }

    base.yokeType = "stream_event";
    base.event = evt;
    return base;
  }

  if (raw.type === "system") {
    if (raw.subtype === "init") {
      base.yokeType = "init";
      base.model = raw.model;
      base.skills = raw.skills;
      base.slashCommands = raw.slash_commands;
      base.fastModeState = raw.fast_mode_state || null;
      return base;
    }
    if (raw.subtype === "status") {
      base.yokeType = "status";
      base.status = raw.status;
      return base;
    }
    if (raw.subtype === "task_started") {
      base.yokeType = "task_started";
      base.parentToolId = raw.tool_use_id;
      base.taskId = raw.task_id;
      base.description = raw.description || "";
      return base;
    }
    if (raw.subtype === "task_progress") {
      base.yokeType = "task_progress";
      base.parentToolId = raw.tool_use_id;
      base.taskId = raw.task_id;
      base.usage = raw.usage || null;
      base.lastToolName = raw.last_tool_name || null;
      base.description = raw.description || "";
      base.summary = raw.summary || null;
      return base;
    }
    if (raw.subtype === "api_retry") {
      base.yokeType = "api_retry";
      base.message = raw.message || raw.error || raw.text || "";
      base.error = raw.error || "";
      return base;
    }
    if (raw.subtype === "model_refusal_fallback") {
      base.yokeType = "model_refusal";
      base.refusalKind = "fallback";
      base.originalModel = raw.original_model || null;
      base.fallbackModel = raw.fallback_model || null;
      base.direction = raw.direction || null;
      base.category = raw.api_refusal_category || null;
      return base;
    }
    if (raw.subtype === "model_refusal_no_fallback") {
      base.yokeType = "model_refusal";
      base.refusalKind = "no_fallback";
      base.originalModel = raw.original_model || null;
      base.category = raw.api_refusal_category || null;
      base.explanation = raw.api_refusal_explanation || null;
      base.content = raw.content || null;
      return base;
    }
    if (raw.subtype === "commands_changed") {
      base.yokeType = "commands_changed";
      base.commandNames = Array.isArray(raw.commands)
        ? raw.commands.map(function(c) { return (c && typeof c === "object") ? c.name : c; }).filter(Boolean)
        : [];
      return base;
    }
    if (raw.subtype === "worker_shutting_down") {
      base.yokeType = "worker_shutting_down";
      base.reason = raw.reason || "";
      return base;
    }
    if (raw.subtype === "thinking_tokens") {
      base.yokeType = "thinking_tokens";
      base.estimatedTokens = raw.estimated_tokens || 0;
      base.estimatedTokensDelta = raw.estimated_tokens_delta || 0;
      return base;
    }
    if (raw.subtype === "informational") {
      base.yokeType = "informational";
      base.level = raw.level || "info";
      base.content = raw.content || "";
      base.toolUseId = raw.tool_use_id || null;
      base.preventContinuation = !!raw.prevent_continuation;
      return base;
    }
    if (raw.subtype === "permission_denied") {
      base.yokeType = "permission_denied";
      base.toolName = raw.tool_name || "";
      base.toolUseId = raw.tool_use_id || null;
      base.agentId = raw.agent_id || null;
      base.reasonType = raw.decision_reason_type || null;
      base.reason = raw.decision_reason || null;
      base.message = raw.message || "";
      return base;
    }
    base.yokeType = "system";
    base.subtype = raw.subtype;
    base.error = raw.error;
    base.message = raw.message;
    base.text = raw.text;
    base.content = raw.content;
    return base;
  }

  if (raw.type === "result") {
    base.yokeType = "result";
    base.cost = raw.total_cost_usd;
    base.duration = raw.duration_ms;
    base.usage = raw.usage || null;
    base.modelUsage = raw.modelUsage || null;
    base.subtype = raw.subtype;
    base.errors = raw.errors;
    base.terminalReason = raw.terminal_reason;
    base.truncatedReason = raw.subtype === "error_max_turns" ? "the response hit the maximum number of turns" : null;
    base.fastModeState = raw.fast_mode_state || null;
    return base;
  }

  if (raw.type === "assistant" || raw.type === "user") {
    if (raw.parent_tool_use_id) {
      base.yokeType = "subagent_message";
      base.parentToolUseId = raw.parent_tool_use_id;
      base.messageRole = raw.type;
      base.content = raw.message ? raw.message.content : null;
      return base;
    }
    base.yokeType = "message";
    base.messageRole = raw.type;
    base.content = raw.message ? raw.message.content : null;
    return base;
  }

  if (raw.type === "rate_limit_event" && raw.rate_limit_info) {
    base.yokeType = "rate_limit";
    base.rateLimitInfo = raw.rate_limit_info;
    return base;
  }

  if (raw.type === "prompt_suggestion") {
    base.yokeType = "prompt_suggestion";
    base.suggestion = raw.suggestion || "";
    return base;
  }

  if (raw.type === "task_notification") {
    base.yokeType = "task_notification";
    base.parentToolId = raw.parent_tool_use_id;
    base.taskId = raw.task_id;
    base.status = raw.status || "completed";
    base.summary = raw.summary || "";
    base.usage = raw.usage || null;
    return base;
  }

  if (raw.type === "tool_progress") {
    base.yokeType = "tool_progress";
    base.parentToolId = raw.parent_tool_use_id;
    base.text = raw.content || "";
    return base;
  }

  if (raw.type === "_worker_meta") {
    return raw;
  }

  base.yokeType = "unknown";
  base.rawType = raw.type;
  base.raw = raw;
  return base;
}

module.exports = {
  flattenEvent: flattenEvent,
};
