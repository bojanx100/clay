// Ephemeral browser-side correlation for a direct Coop handoff. The opaque id
// comes from the server; it is intentionally kept out of browser storage and
// applied to exactly one successfully-sent session switch.

var pendingHandoffTraceId = null;

function isHandoffTraceId(value) {
  return typeof value === "string" &&
    /^handoff-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function rememberCoopHandoffIntent(message) {
  var traceId = message && message.handoffTraceId;
  if (!isHandoffTraceId(traceId)) return false;
  pendingHandoffTraceId = traceId;
  return true;
}

export function attachPendingHandoffTrace(action) {
  if (!pendingHandoffTraceId || !action || action.type !== "switch_session" || action.handoffTraceId) return action;
  return Object.assign({}, action, { handoffTraceId: pendingHandoffTraceId });
}

export function clearSentHandoffTrace(action) {
  if (action && action.type === "switch_session" && action.handoffTraceId === pendingHandoffTraceId) {
    pendingHandoffTraceId = null;
  }
}
