var _uuidCounter = 0;
var COMMAND_OUTPUT_COALESCE_CHARS = 2048;
var COMMAND_OUTPUT_FALLBACK_CHARS = 256 * 1024;

function attachCodexCommandOutput() {
  function bufferFor(state, itemId) {
    var output = state.commandOutputs[itemId];
    if (output) return output;
    output = {
      pendingChunks: [],
      pendingLength: 0,
      fallbackChunks: [],
      fallbackLength: 0,
      fallbackTruncated: false,
    };
    state.commandOutputs[itemId] = output;
    return output;
  }

  function append(output, delta) {
    output.pendingChunks.push(delta);
    output.pendingLength += delta.length;

    var remaining = COMMAND_OUTPUT_FALLBACK_CHARS - output.fallbackLength;
    if (remaining <= 0) {
      output.fallbackTruncated = true;
      return;
    }
    if (delta.length <= remaining) {
      output.fallbackChunks.push(delta);
      output.fallbackLength += delta.length;
      return;
    }
    output.fallbackChunks.push(delta.substring(0, remaining));
    output.fallbackLength += remaining;
    output.fallbackTruncated = true;
  }

  function takePending(output) {
    var text = output.pendingChunks.join("");
    output.pendingChunks = [];
    output.pendingLength = 0;
    return text;
  }

  function fallback(output) {
    if (!output) return "";
    var text = output.fallbackChunks.join("");
    if (output.fallbackTruncated) {
      text += "\n... (output truncated by Clay after " +
        COMMAND_OUTPUT_FALLBACK_CHARS + " characters)";
    }
    return text;
  }

  return {
    append: append,
    bufferFor: bufferFor,
    coalesceChars: COMMAND_OUTPUT_COALESCE_CHARS,
    fallback: fallback,
    takePending: takePending,
  };
}

function generateUuid() {
  var ts = Date.now().toString(36);
  var cnt = (++_uuidCounter).toString(36);
  var rnd = Math.random().toString(36).substring(2, 8);
  return "codex-" + ts + "-" + cnt + "-" + rnd;
}

function waitMs(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function waitForProcessExit(proc, timeoutMs) {
  return new Promise(function(resolve) {
    if (!proc) {
      resolve(true);
      return;
    }

    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve(true);
      return;
    }

    var done = false;
    var timer = null;

    function cleanup() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      proc.removeListener("exit", onDone);
      proc.removeListener("close", onDone);
    }

    function onDone() {
      cleanup();
      resolve(true);
    }

    proc.once("exit", onDone);
    proc.once("close", onDone);

    timer = setTimeout(function() {
      cleanup();
      resolve(false);
    }, timeoutMs || 5000);
  });
}

function createShutdownError() {
  var err = new Error("Codex adapter is shutting down, retry shortly");
  err.code = "CODEX_ADAPTER_SHUTTING_DOWN";
  return err;
}

function normalizePlanStatus(status) {
  if (status === "inProgress") return "in_progress";
  if (status === "completed") return "completed";
  return "pending";
}

function isCodexAuthError(text, errObj) {
  if (errObj && errObj.codexErrorInfo === "unauthorized") return true;
  return /sign in again|token[_ ]?revoked|invalidated oauth|missing bearer|unauthorized|\b401\b/i.test(String(text || ""));
}

function extractPromptSuggestion(params) {
  if (!params) return "";
  if (typeof params.suggestion === "string") return params.suggestion;
  if (typeof params.promptSuggestion === "string") return params.promptSuggestion;
  if (typeof params.suggestedPrompt === "string") return params.suggestedPrompt;
  if (Array.isArray(params.suggestions) && typeof params.suggestions[0] === "string") return params.suggestions[0];
  if (Array.isArray(params.promptSuggestions) && typeof params.promptSuggestions[0] === "string") return params.promptSuggestions[0];
  if (Array.isArray(params.followUpSuggestions) && typeof params.followUpSuggestions[0] === "string") return params.followUpSuggestions[0];
  return "";
}

function eventThreadId(params) {
  if (!params) return null;
  if (params.threadId) return params.threadId;
  if (params.thread && params.thread.id) return params.thread.id;
  if (params.item && params.item.threadId) return params.item.threadId;
  if (params.item && params.item.thread && params.item.thread.id) return params.item.thread.id;
  if (params.turn && params.turn.threadId) return params.turn.threadId;
  if (params.turn && params.turn.thread && params.turn.thread.id) return params.turn.thread.id;
  return null;
}

function eventTurnId(params) {
  if (!params) return null;
  if (params.turnId) return params.turnId;
  if (params.turn && params.turn.id) return params.turn.id;
  if (params.item && params.item.turnId) return params.item.turnId;
  if (params.item && params.item.turn && params.item.turn.id) return params.item.turn.id;
  return null;
}

function shouldRouteServerEvent(state, queryOpts, method, params) {
  var msgThreadId = eventThreadId(params);
  var msgTurnId = eventTurnId(params);
  var expectedThreadId = state && state.threadId || queryOpts && queryOpts.resumeSessionId || null;
  if (expectedThreadId) {
    if (msgThreadId && msgThreadId !== expectedThreadId) return false;
    if (!msgThreadId && method.indexOf("item/") === 0 && (!msgTurnId || !state.turnId || msgTurnId !== state.turnId)) return false;
  } else if (/^(?:thread|turn|item)\//.test(String(method || ""))) {
    return false;
  }
  return true;
}

function positiveNumberValue(obj, names) {
  if (!obj) return 0;
  for (var i = 0; i < names.length; i++) {
    var value = obj[names[i]];
    if (typeof value === "number" && value > 0) return value;
  }
  return 0;
}

function currentContextTokensFromTokenUsage(tu) {
  if (!tu) return 0;

  var explicitCurrent = positiveNumberValue(tu, [
    "contextUsedTokens",
    "context_used_tokens",
    "contextTokens",
    "context_tokens",
    "currentContextTokens",
    "current_context_tokens",
    "usedTokens",
    "used_tokens",
  ]);
  if (explicitCurrent) return explicitCurrent;

  var lastTu = tu.last || tu.lastTokenUsage || tu.last_token_usage || null;
  return positiveNumberValue(lastTu, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
}

function codexLimitBucketFromParams(params) {
  if (!params) return null;
  if (params.rateLimits) return params.rateLimits;
  var byId = params.rateLimitsByLimitId;
  if (!byId) return null;
  if (byId.codex) return byId.codex;
  var ids = Object.keys(byId);
  return ids.length > 0 ? byId[ids[0]] : null;
}

function codexHasCredits(bucket, params) {
  var credits = bucket && bucket.credits;
  if (credits) {
    if (credits.unlimited === true || credits.hasCredits === true) return true;
    var balance = credits.balance;
    if (typeof balance === "number" && balance > 0) return true;
    if (typeof balance === "string" && parseFloat(balance.replace(/,/g, "")) > 0) return true;
  }
  return false;
}

function codexRateLimitType(defaultType, windowInfo) {
  var mins = windowInfo && typeof windowInfo.windowDurationMins === "number"
    ? windowInfo.windowDurationMins
    : null;
  if (mins !== null && mins >= 6 * 24 * 60) return "seven_day";
  if (mins !== null && mins <= 24 * 60) return "five_hour";
  return defaultType;
}

// rateLimitReachedType names WHICH window (e.g. "primary"/"secondary") the
// Codex CLI reports as having actually hit its limit. It must be checked
// against the specific window being evaluated, not treated as a bare truthy
// flag applied to every window that happens to be missing usedPercent — that
// previously made a reached primary (5h) window falsely mark the untouched
// secondary (7d) window (or vice versa) as rejected too.
function codexWindowReachedFlag(reachedType, key) {
  if (!reachedType) return false;
  if (typeof reachedType === "string") return reachedType === key;
  if (typeof reachedType === "object") return !!reachedType[key];
  return false;
}

function flattenCodexRateLimitEvents(params) {
  var bucket = codexLimitBucketFromParams(params);
  if (!bucket) return [];
  var events = [];
  var hasCredits = codexHasCredits(bucket, params);
  var windows = [
    { key: "primary", type: "five_hour" },
    { key: "secondary", type: "seven_day" },
  ];
  for (var wi = 0; wi < windows.length; wi++) {
    var w = bucket[windows[wi].key];
    if (!w) continue;
    var hasUsedPercent = typeof w.usedPercent === "number";
    var usedPercent = hasUsedPercent ? w.usedPercent : 0;
    var reachedLimit = usedPercent >= 100 ||
      (!hasUsedPercent && codexWindowReachedFlag(bucket.rateLimitReachedType, windows[wi].key));
    var status = "allowed";
    if (reachedLimit && hasCredits) status = "allowed_warning";
    else if (reachedLimit) status = "rejected";
    else if (usedPercent >= 80) status = "allowed_warning";
    events.push({
      yokeType: "rate_limit",
      rateLimitInfo: {
        status: status,
        resetsAt: w.resetsAt || null,
        rateLimitType: codexRateLimitType(windows[wi].type, w),
        utilization: usedPercent / 100,
        isUsingOverage: reachedLimit && hasCredits,
      },
    });
  }
  return events;
}

module.exports = {
  attachCodexCommandOutput: attachCodexCommandOutput,
  generateUuid: generateUuid,
  waitMs: waitMs,
  waitForProcessExit: waitForProcessExit,
  createShutdownError: createShutdownError,
  normalizePlanStatus: normalizePlanStatus,
  isCodexAuthError: isCodexAuthError,
  extractPromptSuggestion: extractPromptSuggestion,
  eventThreadId: eventThreadId,
  eventTurnId: eventTurnId,
  shouldRouteServerEvent: shouldRouteServerEvent,
  positiveNumberValue: positiveNumberValue,
  currentContextTokensFromTokenUsage: currentContextTokensFromTokenUsage,
  flattenCodexRateLimitEvents: flattenCodexRateLimitEvents,
};
