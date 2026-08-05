export function dispatchDebateMessage(msg, handlers) {
  if (!Object.prototype.hasOwnProperty.call(handlers, msg.type)) return false;
  var handler = handlers[msg.type];
  handler(msg);
  return true;
}

export function routeDebateHistory(msg, replayingHistory, replayHandler, liveHandler) {
  if (replayingHistory) {
    replayHandler(msg);
    return;
  }
  liveHandler(msg);
}

export function routeDebateLive(msg, replayingHistory, liveHandler) {
  if (!replayingHistory) liveHandler(msg);
}
