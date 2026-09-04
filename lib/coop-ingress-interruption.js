// Defers a Coop owner-priority interrupt until the live answer reaches a
// sentence boundary. Watchers are process-local; the queued ingress and the
// interrupt flags remain durable on the session itself.

var watchers = new WeakMap();
var ASSISTANT_OUTPUT = { delta: true, delta_replace: true, plan_content: true };

function outputText(event) {
  if (!event || !ASSISTANT_OUTPUT[event.type]) return "";
  var value = typeof event.text === "string" ? event.text : event.content;
  return typeof value === "string" ? value.trim() : "";
}

function isCheckpoint(event) {
  var value = outputText(event);
  return !!value && /[.!?][\"')\]]*$/.test(value);
}

function latestOutputAtCheckpoint(session, startEventIndex) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = history.length - 1; i >= startEventIndex; i--) {
    if (!history[i] || !ASSISTANT_OUTPUT[history[i].type]) continue;
    return isCheckpoint(history[i]);
  }
  return false;
}

function cancel(session) {
  var unsubscribe = session && watchers.get(session);
  if (!unsubscribe) return false;
  watchers.delete(session);
  unsubscribe();
  return true;
}

function interrupt(session, sm) {
  cancel(session);
  session.coopPriorityInterruptRequested = true;
  session.coopCheckpointInterruptRequested = true;
  session.steerInterruptRequested = true;
  session.taskStopRequested = true;
  if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
  if (session.abortController) session.abortController.abort();
  return true;
}

function request(session, sm) {
  var state = session && session.coopConversationIngress;
  if (!session || !session.isProcessing || !state || !state.activeIngressId ||
      !Number.isInteger(state.activeResponseStartIndex)) return false;
  if (latestOutputAtCheckpoint(session, state.activeResponseStartIndex)) {
    return interrupt(session, sm);
  }
  if (watchers.has(session)) return true;
  if (!sm || typeof sm.subscribeSession !== "function") return false;
  var unsubscribe = sm.subscribeSession(session.localId, function (event) {
    if (!event) return;
    if (event.type === "done") {
      cancel(session);
      return;
    }
    if (isCheckpoint(event)) interrupt(session, sm);
  });
  if (typeof unsubscribe !== "function") return false;
  watchers.set(session, unsubscribe);
  return true;
}

module.exports = {
  cancel: cancel,
  isCheckpoint: isCheckpoint,
  request: request,
};
