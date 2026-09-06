// An audio conversation about one server-verified question revision. Answers
// remain local until the owner hears the review and says "submit answers".
function normalized(text) { return String(text || "").toLowerCase().trim().replace(/[.!?]+$/g, "").trim(); }
var ORDINALS = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5,
  six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10 };
function optionIndex(text) {
  var value = normalized(text).replace(/^(?:option|number|choice|the) /, "").replace(/ option$/, "");
  var number = ORDINALS[value] || (/^\d+$/.test(value) ? Number(value) : 0);
  return number - 1;
}
export function resolveSpokenAnswer(question, text) {
  var value = normalized(text);
  var options = question.options || [];
  var exact = options.filter(function (option) { return normalized(option.label) === value; });
  if (exact.length === 1) return [exact[0].label];
  var index = optionIndex(value);
  if (index >= 0 && options[index]) return [options[index].label];
  if (question.multiSelect) {
    var parts = value.split(/\s*(?:,|\band\b)\s*/);
    if (parts.length > 1) {
      var choices = [];
      for (var i = 0; i < parts.length; i++) {
        var match = resolveSpokenAnswer(Object.assign({}, question, { multiSelect: false, allowOther: false }), parts[i]);
        if (!match) return null;
        if (choices.indexOf(match[0]) === -1) choices.push(match[0]);
      }
      return choices;
    }
  }
  // An out-of-range option or ambiguous yes/no is not an "Other" answer.
  if ((/^(?:option|number|choice)\b/.test(value) && index >= 0) || (/^(yes|no|okay|ok|sure)$/.test(value) && options.length)) return null;
  return question.allowOther && value ? [String(text).trim()] : null;
}
export function createVoiceQuestions(options) {
  var opts = options || {};
  var route = null, selected = null, index = 0, answers = Object.create(null), requestId = null;
  var loading = false, submitting = null, blocked = 0, timer = null;
  var serial = 0, reconcileSubmission = false;
  var schedule = opts.setTimeout || setTimeout, unschedule = opts.clearTimeout || clearTimeout;
  function id() { return "voice-question-" + Date.now().toString(36) + "-" + (++serial); }
  function publish() {
    if (opts.onState) opts.onState({ loading: loading, waiting: !!selected, submitting: !!submitting,
      questionIndex: index, questionCount: selected ? selected.questions.length : 0, blockedCount: blocked });
  }
  function say(text) { if (opts.speak) opts.speak(text); }
  function questionPrompt() {
    if (!selected) return "";
    if (index >= selected.questions.length) return review();
    var q = selected.questions[index];
    var text = "Question " + (index + 1) + " of " + selected.questions.length + ". " + q.question + " ";
    text += q.options.map(function (option, i) {
      return "Option " + (i + 1) + ": " + option.label + (option.description ? ". " + option.description : "") + ".";
    }).join(" ");
    return text + (q.multiSelect ? " You can choose several options." : "") +
      (q.allowOther ? " You can also answer in your own words." : " Say the option number.");
  }
  function review() {
    return (selected.confirmation === "submit decision" ? "Your decision for request " + selected.revision.slice(0, 8) + ": " : "Your answers: ") + selected.questions.map(function (q, i) {
      return "Question " + (i + 1) + ": " + (answers[q.id] || []).join(", ") + ".";
    }).join(" ") + " Say " + (selected.confirmation || "submit answers") + ", change answers, or repeat question.";
  }
  function send(payload) {
    if (!route || !opts.send) return false;
    payload.sessionId = route.sessionId;
    return opts.send(payload, route);
  }
  function refresh(reconcile) {
    if (!route) return;
    if (reconcile && submitting) reconcileSubmission = true;
    if (timer) unschedule(timer);
    requestId = id();
    loading = true;
    send({ type: "voice_question_state_request", clientRequestId: requestId });
    timer = schedule(function () {
      timer = null;
      // An old backend or lost connection must not silently turn an answer into
      // a new chat request. The owner can retry the snapshot by voice.
      say("I could not check pending questions. Say retry questions to try again.");
    }, 5000);
    publish();
  }
  function reset() {
    if (timer) unschedule(timer);
    timer = null; route = selected = requestId = submitting = null;
    index = 0; answers = Object.create(null); reconcileSubmission = false; loading = false; blocked = 0;
    publish();
  }
  return {
    start: function (routing) { reset(); route = JSON.parse(JSON.stringify(routing)); refresh(); },
    reset: reset,
    refresh: refresh,
    reconnect: function () { refresh(true); },
    isWaiting: function () { return loading || !!selected || !!submitting || blocked > 0; },
    hasQuestion: function () { return !!selected || blocked > 0; },
    consume: function (text) {
      var command = normalized(text);
      if (!route) return null;
      if (command === "retry questions") { refresh(true); return { handled: true }; }
      if (submitting) { say("Your answers are being submitted."); return { handled: true }; }
      if (loading) { say("I am checking the pending questions. Please repeat that after I am ready."); return { handled: true }; }
      if (!selected) {
        if (blocked) { say("A private or unsupported form needs attention on screen."); return { handled: true }; }
        return null;
      }
      if (command === "repeat question" || command === "repeat questions") { say(questionPrompt()); return { handled: true }; }
      if (command === "change answers" || command === "change answer") { index = 0; answers = Object.create(null); say(questionPrompt()); return { handled: true }; }
      if (index < selected.questions.length) {
        var q = selected.questions[index];
        var answer = resolveSpokenAnswer(q, text);
        if (!answer) { say("I could not match that answer. " + questionPrompt()); return { handled: true }; }
        answers[q.id] = answer;
        index++;
        say(questionPrompt()); publish();
        return { handled: true };
      }
      var confirm = selected.confirmation || "submit answers";
      if (command !== confirm) {
        say("Say " + confirm + " to send them, or change answers to revise them.");
        return { handled: true };
      }
      var submission = id();
      var payload = { type: "voice_question_answer", kind: selected.kind, requestId: selected.requestId,
        revision: selected.revision, answers: answers, clientMessageId: submission };
      if (route.canonicalCoop) {
        payload.coopComposerScope = route.scope;
        if (route.topicRef) payload.coopTopicRef = route.topicRef;
        if (route.projectRef) payload.coopProjectRef = route.projectRef;
      }
      if (!send(payload)) { say("Your answers were not sent. Repeat the submission command after reconnecting."); return { handled: true }; }
      submitting = submission; publish();
      return { handled: true, clientMessageId: submission };
    },
    receive: function (message, replaying) {
      if (!route || !message || replaying || message.sessionId !== undefined && String(message.sessionId) !== String(route.sessionId)) return;
      if (message.type === "voice_question_state" && message.clientRequestId === requestId) {
        if (timer) unschedule(timer);
        timer = null;
        if (!message.available) { say("This conversation is no longer available."); return; }
        loading = false;
        blocked = message.blockedCount || 0;
        var next = (message.requests || [])[0] || null;
        if (submitting && reconcileSubmission) {
          var unconsumed = selected && (message.requests || []).some(function (request) {
            return request.revision === selected.revision;
          });
          var uncertain = submitting;
          submitting = null; reconcileSubmission = false;
          if (unconsumed) {
            if (opts.onRejected) opts.onRejected(uncertain, "Your decision is still waiting. Repeat the submission command to send it.");
            else say("Your decision is still waiting. Repeat the submission command to send it.");
          }
          // An absent request was consumed or closed. Never resend it. The
          // normal turn events still identify any eventual provider reply.
        }
        if (!selected || !next || selected.revision !== next.revision) {
          selected = next; index = 0; answers = Object.create(null);
          if (selected) say(questionPrompt());
          else if (blocked) say("A private or unsupported form needs attention on screen.");
        }
        publish();
        if (opts.onReady) opts.onReady();
      } else if (message.type === "voice_question_answer_result" && message.clientMessageId === submitting) {
        var completed = submitting;
        submitting = null; reconcileSubmission = false;
        if (!message.ok && opts.onRejected) opts.onRejected(completed, message.text);
        selected = null; index = 0; answers = Object.create(null);
        refresh();
      } else if (message.type === "history_done" || message.type === "done" ||
          message.type === "ask_user_answered" || message.type === "elicitation_request" || message.type === "elicitation_resolved" ||
          message.type === "permission_request" || message.type === "permission_request_pending" ||
          message.type === "permission_cancel" || message.type === "permission_resolved" ||
          message.type === "user_dialog_request" || message.type === "user_dialog_resolved" ||
          message.type === "tool_executing" && message.name === "AskUserQuestion") refresh();
    },
  };
}
