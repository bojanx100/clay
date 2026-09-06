var sessionHistory = require("./sessions-history");

var LAUNDERED_ACTIVITY_MARGIN_MS = 6 * 60 * 60 * 1000;
var RESTART_RESUME_PROMPT = "Resume the work that was interrupted when Clay restarted. " +
  "Continue from where you left off; do not restart from scratch or re-ask for confirmation.";
var RESTART_RESUME_LABEL = "↻ Resuming after restart";
var LEGACY_HANDOFF_CONTEXT_PREFIXES = [
  "[Context from previous claude conversation]",
  "[Context from previous Claude conversation, prepared for Codex handoff]",
  "[Context from this Clay session before the current thread was persisted, " +
    "prepared for the current vendor handoff]",
];

function isTurnStartingHistoryItem(item) {
  if (!item || !item.type) return false;
  if (item.type === "user_message" && (item.queuedPending || item.coopIngressPending ||
      item.coordinatorUpdateBatchId && item.coordinatorUpdateSubmission !== "submitted")) return false;
  if (item.type === "user_message" && !item.queuedDuringProcessing) return true;
  return sessionHistory.isAssistantReplayEvent(item) ||
    item.type === "result" || item.type === "error" ||
    item.type === "context_overflow" || item.type === "process_conflict" ||
    item.type === "auth_required";
}

function lastTimestamp(history) {
  if (!Array.isArray(history)) return 0;
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (item && typeof item._ts === "number") return item._ts;
  }
  return 0;
}

function hasInterruptedTurn(history) {
  if (!Array.isArray(history) || history.length === 0) return false;
  var open = false;
  for (var i = 0; i < history.length; i++) {
    var item = history[i];
    if (item && item.type === "done") open = false;
    else if (isTurnStartingHistoryItem(item)) open = true;
  }
  return open;
}

function hasUncontinuedRestartInterruption(history) {
  if (!Array.isArray(history) || history.length === 0) return false;
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i] || {};
    if (item.type === "user_message" || item.type === "scheduled_message_sent" ||
        item.type === "scheduled_message_cancelled" || item.type === "vendor_switched") {
      return false;
    }
    if (item.type === "info" && String(item.text || "").indexOf(
      "Session was interrupted by a Clay restart.") !== -1) return true;
  }
  return false;
}

function pendingRestartInterruptionTimestamp(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i] || {};
    if (item.type === "user_message" || item.type === "scheduled_message_sent" ||
        item.type === "scheduled_message_cancelled" || item.type === "vendor_switched") {
      return 0;
    }
    if (item.type === "scheduled_message_queued" && item.autoAction &&
        item.text === RESTART_RESUME_LABEL) return 0;
    if (item.type === "info" && String(item.text || "").indexOf(
      "Session was interrupted by a Clay restart.") !== -1) {
      return typeof item._ts === "number" ? item._ts : lastTimestamp(history);
    }
  }
  return 0;
}

function relabelLegacyAutoContinueHistory(history) {
  if (!Array.isArray(history)) return 0;
  var changed = 0;
  var prevType = null;
  for (var i = 0; i < history.length; i++) {
    var item = history[i];
    if (!item || typeof item !== "object") { prevType = null; continue; }
    if (item.type === "user_message" && typeof item.text === "string" &&
        item.text.trim().toLowerCase() === "continue" &&
        prevType === "scheduled_message_sent") {
      item.text = "↻ Auto-continued";
      changed++;
    }
    prevType = item.type;
  }
  return changed;
}

function classifyLegacyInjectedHistory(history) {
  if (!Array.isArray(history)) return 0;
  var changed = 0;
  for (var i = 0; i < history.length; i++) {
    var item = history[i];
    if (!item || item.type !== "user_message" || typeof item.text !== "string") continue;
    var text = item.text.trim();
    var handoffContext = false;
    for (var pi = 0; pi < LEGACY_HANDOFF_CONTEXT_PREFIXES.length; pi++) {
      if (text.indexOf(LEGACY_HANDOFF_CONTEXT_PREFIXES[pi]) === 0) {
        handoffContext = true;
        break;
      }
    }
    if (handoffContext) {
      if (item.internalOnly !== true) { item.internalOnly = true; changed++; }
      if (item.synthetic !== true) { item.synthetic = true; changed++; }
      if (!item.origin) {
        item.origin = { kind: "handoff-context" };
        changed++;
      }
      continue;
    }
    if (text !== RESTART_RESUME_PROMPT && text !== RESTART_RESUME_LABEL) continue;
    if (item.text !== RESTART_RESUME_LABEL) { item.text = RESTART_RESUME_LABEL; changed++; }
    if (item.synthetic !== true) { item.synthetic = true; changed++; }
    if (item.autoAction !== true) { item.autoAction = true; changed++; }
  }
  return changed;
}

function historicalProviderIds(history) {
  var ids = [];
  var seen = Object.create(null);
  for (var i = 0; i < history.length; i++) {
    var item = history[i];
    if (!item || typeof item !== "object") continue;
    var id = (item.type === "session_id" && item.cliSessionId) ||
      (item.type === "result" && item.sessionId) || null;
    if (id && !seen[id]) { seen[id] = true; ids.push(id); }
  }
  return ids;
}

function messageUuids(history) {
  var result = [];
  for (var i = 0; i < history.length; i++) {
    if (history[i].type === "message_uuid") {
      result.push({ uuid: history[i].uuid, type: history[i].messageType, historyIndex: i });
    }
  }
  return result;
}

function newestTimestamp(history) {
  if (!Array.isArray(history)) return 0;
  var newest = 0;
  for (var i = 0; i < history.length; i++) {
    var item = history[i];
    var ts = item && item._ts;
    if (typeof ts === "number" && Number.isFinite(ts) && ts > newest) newest = ts;
  }
  return newest;
}

// Prefer durable metadata, but repair legacy hidden sessions whose file mtime
// was once laundered into lastActivity by a bulk rewrite. Transcript timestamps
// are direct evidence; the OS mtime is only a fallback when neither exists.
function resolveLastActivity(metadata, history, fileMtime) {
  var recovered = newestTimestamp(history);
  if (typeof metadata.lastActivity === "number") {
    if (metadata.hidden && recovered > 0 &&
        metadata.lastActivity - recovered > LAUNDERED_ACTIVITY_MARGIN_MS) {
      return { value: recovered, derived: false, repaired: true };
    }
    if (recovered > metadata.lastActivity) return { value: recovered, derived: false };
    return { value: metadata.lastActivity, derived: false };
  }
  if (recovered > 0) return { value: recovered, derived: false };
  return { value: fileMtime || metadata.createdAt || Date.now(), derived: true };
}

function normalizeLoadedHistory(history) {
  for (var i = 0; i < history.length; i++) {
    var item = history[i];
    if (item && item.synthetic && item.origin && item.origin.kind === "task-notification") {
      item.internalOnly = true;
    }
  }
  return relabelLegacyAutoContinueHistory(history) > 0;
}

module.exports = {
  lastTimestamp: lastTimestamp,
  hasInterruptedTurn: hasInterruptedTurn,
  hasUncontinuedRestartInterruption: hasUncontinuedRestartInterruption,
  pendingRestartInterruptionTimestamp: pendingRestartInterruptionTimestamp,
  historicalProviderIds: historicalProviderIds,
  messageUuids: messageUuids,
  resolveLastActivity: resolveLastActivity,
  classifyLegacyInjectedHistory: classifyLegacyInjectedHistory,
  normalizeLoadedHistory: normalizeLoadedHistory,
};
