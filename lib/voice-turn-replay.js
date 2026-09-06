// Read only the reply bounded by this client's actual dispatch marker. Old
// transcripts without that marker are unknown, never guessed from last text.
function recordStart(session, clientMessageId, ctx) {
  var event = { type: "user_turn_started", clientMessageId: clientMessageId || null };
  if (ctx.sm && typeof ctx.sm.sendAndRecord === "function") return ctx.sm.sendAndRecord(session, event) !== false;
  ctx.sendToSession(session.localId, event);
  return true;
}
function read(session, id) {
  var history = session.history || [], start = -1;
  for (var i = history.length - 1; i >= 0; i--) {
    if (history[i].type === "user_turn_started" && history[i].clientMessageId === id) { start = i; break; }
  }
  if (start === -1) {
    var queued = [session.pendingUserMessageQueue, session.pendingCoopIngress].some(function (queue) {
      return (queue || []).some(function (item) { return item.clientMessageId === id; });
    });
    return { state: queued ? "queued" : "unknown", text: "" };
  }
  var text = "", failed = false;
  for (var j = start + 1; j < history.length; j++) {
    var item = history[j];
    if (item.type === "user_turn_started" || item.type === "coop_internal_turn_started" ||
        item.type === "user_message" && item.internalOnly) return { state: "interrupted", text: text };
    if (item.type === "delta" && typeof item.text === "string") text += item.text;
    if (item.type === "delta_replace" && typeof item.text === "string") text = item.text;
    if (item.type === "error") { failed = true; text = item.text || item.message || "The turn failed."; }
    if (text.length > 128000) return { state: "unavailable", text: "The reply is too large for audio recovery. Open the conversation to read it." };
    if (item.type === "done") return { state: item.code || failed ? "failed" : "completed", text: text };
  }
  return { state: session.isProcessing ? "running" : "interrupted", text: text };
}
function handle(ctx, ws, message) {
  if (message.type !== "voice_turn_state_request") return false;
  var session = ctx.getSessionForWs(ws);
  var result = { state: "unavailable", text: "This conversation is no longer available." };
  if (session && String(session.localId) === String(message.sessionId) &&
      typeof message.clientMessageId === "string" && message.clientMessageId.length > 0 && message.clientMessageId.length < 200) {
    result = require("./sessions-history-store").readTransient(session, function () { return read(session, message.clientMessageId); });
  }
  ctx.sendTo(ws, Object.assign({ type: "voice_turn_state", sessionId: message.sessionId,
    clientMessageId: message.clientMessageId, clientRequestId: message.clientRequestId }, result));
  return true;
}
module.exports = { recordStart: recordStart, read: read, handle: handle };
