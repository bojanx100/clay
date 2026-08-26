// Owner authorization by answered question.
//
// The gap this closes: an owner approval can be REFERENTIAL. Coop asks "do you
// want 1 and 2?" and the owner answers "do 1 and 2 what you think is best".
// That is a real approval, but nothing in it names a task, so every wording
// parser in this subsystem correctly returns nothing and the dispatch is refused
// as `owner_implementation_decision_required`. Live on 2026-08-22 that cost seven
// dispatch attempts against owner ingress 622, whose durable record is
// `expectsExecution: false, implementationDecision: null, scopes: 0` -- truthful,
// because the only thing that ever bound "1 and 2" to those tasks was Coop's own
// question, and that binding was never consulted.
//
// The rule, and why it cannot manufacture authorization:
//
//   Wording only ever IDENTIFIES; the pending set is the authority. The work
//   must already have been recorded as `waiting_user` with a question BEFORE the
//   owner spoke, and the owner's turn is only checked for assent. So an
//   affirmative turn can authorize nothing that was not already queued and put
//   to the owner. This is the same shape `coop-queue-authorization` and
//   `coop-item-approval` use -- resolve against an independently recorded pending
//   snapshot, then demand exact key equality -- and it is the "second factor"
//   `memory/2026-08-19-thread-ref-required-dispatch-blocker-brief.md` recommends
//   in place of making one regex load-bearing.
//
// Three further properties are deliberate:
//
//   EXACTLY ONE candidate turn. The answer is the FIRST owner turn after the
//   question, never a scan forward for something affirmative. Scanning is how the
//   router's old unscoped hijack adopted an unrelated turn (`:482`, "FIX!"), and
//   a forward scan here would resurrect that failure with better manners.
//
//   ASSENT IS AN ALLOWLIST, not the absence of negation. "absence of a negation"
//   admits reports, questions and musings; the 2026-08-19 corpus measurement is
//   the record of what happens when this subsystem guesses from open wording.
//
//   PERMANENTLY GATED ACTIONS STAY GATED. The question text is authored by Coop,
//   not by the owner, so a bare "yes" must not release an irreversible external
//   action the owner cannot be presumed to have read. Same hard-coded list as
//   the standing autonomy grant, for the same reason.

var autonomyGrant = require("./coop-autonomy-grant");
var approvalStaging = require("./coop-approval-question-staging");

// The first sentence WITH its terminator, so a question mark that ends the
// clause is still visible. Splitting first and testing for "?" afterwards hides
// exactly the case it is meant to catch: "yes? or no?" reduces to "yes".
function firstSentence(text) {
  var value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  var stop = value.search(/[.!?;\n]/);
  return (stop === -1 ? value : value.slice(0, stop + 1)).trim().toLowerCase();
}

// Refusals beat any affirmative token, so "yes but not 2" and "ok, don't push"
// refuse rather than matching on "yes"/"ok".
var REFUSAL = new RegExp("\\b(?:no|nope|not|n't|dont|never|stop|cancel|" +
  "abort|hold|halt|wait|later|pause|skip|drop|instead|neither|none|" +
  "maybe|perhaps|possibly|unsure|unclear|but)\\b");

// Trailing words that do not change what was agreed to. Anything outside this
// set means the turn is doing something other than answering the question.
var BENIGN_TAIL = "(?:\\s+(?:please|now|then|too|also|" +
  "for\\s+me|if\\s+you\\s+(?:can|like|want)|" +
  "(?:and\\s+)?what(?:ever)?\\s+you\\s+think(?:'s|\\s+is)?(?:\\s+best)?|" +
  "as\\s+you\\s+see\\s+fit|your\\s+call))*";

var AFFIRMATIVE = "(?:yes|yep|yeah|yup|ya|ok|okay|k|sure|fine|absolutely|" +
  "agreed|approved|approve|confirm|confirmed|granted|correct)";

var SELECTION = "(?:both|all|all\\s+of\\s+(?:them|it)|all\\s+three|" +
  "the\\s+first(?:\\s+one)?|the\\s+second(?:\\s+one)?|option\\s+[0-9]+|" +
  "[0-9]+(?:\\s*(?:,|and|&|\\+)\\s*[0-9]+)+)";

// A BARE selection standing alone as the whole turn must name two or more items.
// A lone digit is a list marker far more often than an answer: real owner turn
// :230 opens "1. I meant restart as start fresh in same provider". "do 2" and
// "option 2" still select one item, because the directive carries the intent.
var BARE_SELECTION = "(?:both|all|all\\s+of\\s+(?:them|it)|all\\s+three|" +
  "the\\s+first(?:\\s+one)?|the\\s+second(?:\\s+one)?|option\\s+[0-9]+|" +
  "[0-9]+(?:\\s*(?:,|and|&|\\+)\\s*[0-9]+)+)";

var DIRECTIVE = "(?:do|go\\s+ahead\\s+with|go\\s+ahead|go|proceed\\s+with|" +
  "proceed|continue|ship|run\\s+it|make\\s+it\\s+so)";

var DELEGATION = "(?:your\\s+call|you\\s+decide|whatever\\s+you\\s+think" +
  "(?:\\s+is\\s+best)?|as\\s+you\\s+see\\s+fit)";

// Anchored to the WHOLE first sentence. This is the load-bearing discriminator:
// an answer to a question is short and complete, while "ok give me handoff",
// "ok who's gonna do it" and "yeah first check was unavailable" are new
// instructions, questions and reports that merely OPEN with an affirmative.
// Measured over the 647 real owner turns in the canonical transcript, prefix
// matching produced 15 false positives -- including "ok you're the worse helper
// ever", which would have authorized whatever happened to be outstanding.
var ASSENT = new RegExp("^(?:" +
  // "yes", "ok", "approved", optionally then a selection or directive.
  AFFIRMATIVE + "(?:\\s+(?:to\\s+)?" + SELECTION + ")?" +
    "(?:\\s+" + DIRECTIVE + "(?:\\s+(?:it|them|" + SELECTION + "))?)?" +
  "|" +
  // "do it", "do both", "do 1 and 2", "go ahead", "proceed".
  DIRECTIVE + "(?:\\s+(?:it|them|ahead|on|[0-9]+|" + SELECTION + "))?" +
  "|" +
  // A bare selection standing alone: "both", "1 and 2", "option 2".
  BARE_SELECTION +
  "|" +
  DELEGATION +
  ")" + BENIGN_TAIL + "[.!]?$");

// TRUE only for an unambiguous affirmative answer to a question already asked.
function explicitOwnerAssent(text) {
  var head = firstSentence(text);
  if (!head) return false;
  if (head.indexOf("?") !== -1) return false;
  if (REFUSAL.test(head)) return false;
  return ASSENT.test(head.replace(/[.!]+$/, ""));
}

function clientRefFor(request) {
  return "portfolio:" + String(request && request.portfolioTaskId || "") +
    ":" + Number(request && request.bindingRevision);
}

// The outstanding question that names EXACTLY this binding. `waiting_user` with
// an unanswered marker is the independently recorded pending state; the
// clientRef is what ties it to a portfolio binding rather than to a name.
function pendingQuestionFor(session, request) {
  var tasks = session && Array.isArray(session.orchestrationTasks) ?
    session.orchestrationTasks : [];
  var wanted = clientRefFor(request);
  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i];
    if (!task || task.status !== "waiting_user") continue;
    if (String(task.clientRef || "") !== wanted) continue;
    if (task.userAnsweredAt) continue;
    if (!String(task.userQuestion || "").trim()) continue;
    var approvalSet = task.approvalSet;
    var scopes = approvalStaging.normalizeScopes(approvalSet && approvalSet.scopes);
    if (!scopes || approvalSet.setId !== approvalStaging.setIdFor(scopes)) continue;
    var requestProject = request && request.targetProject && request.targetProject.projectId;
    var exact = false;
    for (var si = 0; si < scopes.length; si++) {
      if (approvalStaging.clientRefFor(scopes[si]) === wanted &&
          scopes[si].targetProject.projectId === requestProject) exact = true;
    }
    if (!exact) continue;
    var open = approvalStaging.openStage(session, scopes);
    if (!open.ok || open.tasks.length !== scopes.length) continue;
    var stagedAt = Number(approvalSet.stagedAt);
    if (!Number.isFinite(stagedAt) || stagedAt <= 0) continue;
    return { taskId: task.taskId, stagedAt: stagedAt,
      question: String(task.userQuestion), approvalSet: approvalSet };
  }
  return null;
}

// A staged record is not proof that the owner saw a question. Require the exact
// assistant turn after staging; otherwise a record created after an unrelated
// owner "yes" could adopt that post-hoc answer.
function askedQuestionTurn(session, pending) {
  var items = session && Array.isArray(session.history) ? session.history : [];
  var question = String(pending && pending.question || "").trim();
  var stagedAt = Number(pending && pending.stagedAt);
  if (!question || !Number.isFinite(stagedAt)) return null;
  var visible = "";
  var lastAt = null;
  function exactVisibleQuestion() {
    return visible.trim() === question ? { _ts: lastAt } : null;
  }
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var at = Number(item && item._ts);
    if (!item || !Number.isFinite(at) || at <= stagedAt) continue;
    if (item.type === "user_message") return exactVisibleQuestion();
    if (item.type === "done") {
      var completed = exactVisibleQuestion();
      if (completed) return completed;
      visible = "";
      lastAt = null;
      continue;
    }
    if (item.type !== "assistant_message" && item.type !== "delta") continue;
    visible += String(item.text || "");
    lastAt = at;
  }
  return exactVisibleQuestion();
}

// The FIRST owner turn strictly after the question. Never a search for an
// agreeable one.
function answeringTurn(session, askedAt) {
  var items = session && Array.isArray(session.history) ? session.history : [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || item.type !== "user_message" || !item.coopIngressId) continue;
    if (!Number.isFinite(Number(item._ts)) || Number(item._ts) <= askedAt) continue;
    return item;
  }
  return null;
}

// Returns:
//   null               -- nothing to say; the caller's fail-closed default rules.
//   { ok: false, ... } -- this path was reachable and refused, with the reason.
//   { ok: true, ... }  -- the owner answered a question that named this work.
function executionAdmission(input, request, canonicalSession) {
  var pending = pendingQuestionFor(canonicalSession, request);
  if (!pending) return null;
  var asked = askedQuestionTurn(canonicalSession, pending);
  if (!asked) return { ok: false, reason: "owner_question_not_asked" };
  var turn = answeringTurn(canonicalSession, Number(asked._ts));
  if (!turn) return null;
  if (!explicitOwnerAssent(turn.text)) {
    return { ok: false, reason: "owner_question_unanswered" };
  }
  var approvedScopes = approvalStaging.selectedScopes(turn.text,
    pending.approvalSet.scopes);
  var wanted = clientRefFor(request);
  var requestProject = request && request.targetProject && request.targetProject.projectId;
  var selected = false;
  for (var si = 0; si < approvedScopes.length; si++) {
    if (approvalStaging.clientRefFor(approvedScopes[si]) === wanted &&
        approvedScopes[si].targetProject.projectId === requestProject) selected = true;
  }
  if (!selected) return { ok: false, reason: "owner_question_scope_not_approved" };
  // Checked after assent so the reason names the real boundary rather than
  // reporting the dispatch as unauthorized.
  var forbidden = autonomyGrant.forbiddenAction(input);
  if (forbidden) {
    return { ok: false, reason: "owner_question_" + forbidden + "_gated" };
  }
  return {
    ok: true,
    request: request,
    answeredQuestion: {
      taskId: pending.taskId,
      askedAt: Number(asked._ts),
      ingressId: String(turn.coopIngressId),
      approvalSetId: pending.approvalSet.setId,
    },
  };
}

module.exports = {
  explicitOwnerAssent: explicitOwnerAssent,
  pendingQuestionFor: pendingQuestionFor,
  askedQuestionTurn: askedQuestionTurn,
  answeringTurn: answeringTurn,
  executionAdmission: executionAdmission,
};
