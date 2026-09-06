var permissions = require("../../lib/project-sessions-permissions");
function fixture() {
  var session = { localId: 7, storageId: "voice-question-session", history: [], pendingAskUser: {}, pendingPermissions: {}, pendingElicitations: {} };
  var events = [], starts = [], resolved = [];
  var ctx = { getSessionForWs: function () { return session; },
    getUserMessage: function () { return { handleUserMessage: function (ws, message) { starts.push(message); } }; },
    sm: { sendAndRecord: function (s, message) { s.history.push(message); events.push(message); },
      appendToSessionFile: function () {}, permissionRequestIndex: {} },
    sdk: { startQuery: function (s, text) { starts.push({ text: text }); }, pushMessage: function (s, text) { starts.push({ text: text }); } },
    sendToSession: function (id, message) { events.push(message); },
    sendTo: function (ws, message) { events.push(message); }, onProcessingChanged: function () {}, ensureProjectAccessForSession: function () {} };
  var handler = permissions.attachProjectSessionsPermissions(ctx).handlePermissionsMessage;
  function send(message) { return handler({}, Object.assign({ sessionId: 7 }, message)); }
  return { session: session, ctx: ctx, events: events, starts: starts, resolved: resolved, send: send,
    add: function (id, mode, question) { session.pendingAskUser[id] = { mode: mode || "mcp",
      input: { questions: [{ question: question || "Which approach?", options: [{ label: "Keep it simple" }, { label: "Rebuild" }] }] },
      resolve: function (value) { resolved.push(value); } }; },
    snapshot: function () { send({ type: "voice_question_state_request", clientRequestId: "inspect" }); return events[events.length - 1]; },
    answer: function (request, extra) { send(Object.assign({ type: "voice_question_answer", kind: request.kind,
      requestId: request.requestId, revision: request.revision, answers: { 0: ["Keep it simple"] }, clientMessageId: "answer-1" }, extra || {}));
      return events[events.length - 1]; } };
}

module.exports = fixture;
