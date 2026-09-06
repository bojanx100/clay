// Voice reads current pending objects, never a historical question card. The
// revision changes when a request is replaced, changed, or recreated on restart.
var crypto = require("crypto");
var identity = require("./project-identity");
var versions = new WeakMap();
var own = Object.prototype.hasOwnProperty;
var decisions = require("./voice-decisions");

function normalizeQuestions(raw, codex) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 8) return null;
  var seen = {};
  var questions = [];
  for (var i = 0; i < raw.length; i++) {
    var q = raw[i];
    if (!q || q.isSecret || typeof q.question !== "string" || !q.question.trim()) return null;
    var id = codex ? q.id : String(i);
    if (typeof id !== "string" || !id || own.call(seen, id)) return null;
    Object.defineProperty(seen, id, { value: true, enumerable: true });
    var options = Array.isArray(q.options) ? q.options.map(function (option) {
      return { label: String(option && option.label || ""), description: String(option && option.description || "") };
    }) : [];
    if (options.some(function (option) { return !option.label; })) return null;
    questions.push({ id: id, question: q.question, options: options, multiSelect: !!q.multiSelect,
      allowOther: !codex || q.isOther === true || options.length === 0 });
  }
  return questions;
}
function entries(session) {
  var result = [], blockedCount = 0;
  function add(kind, requestId, pending, raw, codex, decision) {
    var questions = decision ? decision.questions : normalizeQuestions(raw, codex);
    if (!questions) { blockedCount++; return; }
    if (!versions.has(pending)) versions.set(pending, crypto.randomUUID());
    var revision = crypto.createHash("sha256").update(JSON.stringify([
      identity.sessionStorageId(session), kind, requestId, versions.get(pending), questions, decision && decision.evidence,
    ])).digest("hex");
    result.push({ kind: kind, requestId: requestId, revision: revision, questions: questions,
      confirmation: decision ? decision.confirmation : "submit answers" });
  }
  Object.keys(session.pendingAskUser || {}).forEach(function (id) {
    var pending = session.pendingAskUser[id];
    if (pending) add("ask_user", id, pending, pending.input && pending.input.questions, false);
  });
  Object.keys(session.pendingElicitations || {}).forEach(function (id) {
    var pending = session.pendingElicitations[id];
    if (pending && pending.request && pending.request.questionKind === "codex_user_input") {
      add("codex_user_input", id, pending, pending.request.questions, true);
    } else blockedCount++;
  });
  Object.keys(session.pendingPermissions || {}).forEach(function (id) {
    var pending = session.pendingPermissions[id];
    var decision = decisions.permission(session, pending);
    if (decision) add(decision.kind, id, pending, null, false, decision);
    else blockedCount++;
  });
  blockedCount += Object.keys(session.pendingUserDialogs || {}).length;
  return { requests: result, blockedCount: blockedCount };
}
function validateAnswers(request, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers) ||
      Object.keys(answers).length !== request.questions.length) return false;
  return request.questions.every(function (q) {
    var values = own.call(answers, q.id) && answers[q.id];
    return Array.isArray(values) && values.length > 0 && (q.multiSelect || values.length === 1) &&
      values.every(function (value) {
        return typeof value === "string" && value.trim().length > 0 && value.length <= 10000 &&
          (q.allowOther || q.options.some(function (option) { return option.label === value; }));
      });
  });
}
function attachVoiceQuestions(ctx, respond) {
  return function (ws, message) {
    if (require("./voice-turn-replay").handle(ctx, ws, message)) return true;
    if (message.type !== "voice_question_state_request" && message.type !== "voice_question_answer") return false;
    var session = ctx.getSessionForWs(ws);
    var validSession = session && String(message.sessionId) === String(session.localId);
    var snapshot = validSession ? entries(session) : { requests: [], blockedCount: 0 };
    if (message.type === "voice_question_state_request") {
      ctx.sendTo(ws, Object.assign({ type: "voice_question_state", sessionId: message.sessionId,
        clientRequestId: message.clientRequestId, available: !!validSession }, snapshot));
      return true;
    }
    var selected = snapshot.requests.find(function (request) {
      return request.kind === message.kind && request.requestId === message.requestId && request.revision === message.revision;
    });
    if (!selected || !validateAnswers(selected, message.answers) ||
        typeof message.clientMessageId !== "string" || !message.clientMessageId) {
      ctx.sendTo(ws, { type: "voice_question_answer_result", sessionId: message.sessionId,
        clientMessageId: message.clientMessageId, ok: false,
        text: "This question changed or was already answered. I will check what is waiting now." });
      return true;
    }
    var payload;
    if (selected.kind === "ask_user") {
      var answers = Object.create(null);
      selected.questions.forEach(function (q) { answers[q.id] = message.answers[q.id].join(", "); });
      payload = { type: "ask_user_response", toolId: selected.requestId, answers: answers,
        clientMessageId: message.clientMessageId, ingressType: "voice",
        coopComposerScope: message.coopComposerScope, coopTopicRef: message.coopTopicRef, coopProjectRef: message.coopProjectRef };
    } else if (selected.kind === "permission" || selected.kind === "plan") {
      payload = decisions.response(selected, message.answers);
    } else {
      var content = Object.create(null);
      selected.questions.forEach(function (q) { content[q.id] = message.answers[q.id][0]; });
      payload = { type: "elicitation_response", requestId: selected.requestId, action: "accept", content: content };
    }
    // Validation and consumption are synchronous: no await can let a replaced
    // question fall through to the ordinary stale-card compatibility fallback.
    var nextTurn = selected.kind === "ask_user" && session.pendingAskUser[selected.requestId].mode === "mcp";
    if (!nextTurn && !require("./voice-turn-replay").recordStart(session, message.clientMessageId, ctx)) {
      ctx.sendTo(ws, { type: "voice_question_answer_result", sessionId: session.localId,
        clientMessageId: message.clientMessageId, ok: false, text: "Clay could not save the decision. The request is still waiting." });
      return true;
    }
    respond(ws, payload);
    ctx.sendTo(ws, { type: "voice_question_answer_result", sessionId: session.localId,
      clientMessageId: message.clientMessageId, ok: true });
    return true;
  };
}
module.exports = { attachVoiceQuestions: attachVoiceQuestions };
