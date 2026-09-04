// ws-ref.js - Shared WebSocket reference
// Infrastructure singleton, not state. Lives outside the store.

var _ws = null;
var _sendFailureHandler = null;

export function getWs() { return _ws; }
export function setWs(v) { _ws = v; }

export function setWsSendFailureHandler(fn) {
  _sendFailureHandler = typeof fn === "function" ? fn : null;
}

// The composer must not call WebSocket.send directly: OPEN is not proof that a
// socket is still usable after sleep or a server restart, and send() can throw
// when the socket transitions to CLOSING between the check and the write.
export function sendWsJson(obj) {
  var ws = _ws;
  if (!ws || ws.readyState !== 1) {
    if (_sendFailureHandler) _sendFailureHandler();
    return false;
  }
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (error) {
    if (_sendFailureHandler) _sendFailureHandler(error);
    return false;
  }
}
