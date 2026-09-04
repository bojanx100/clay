// Explicit owner acceptance is a live authority grant. Technical completion,
// replayed transcript text, and restored completion envelopes are evidence of
// implementation only; none of them may synthesize this record.

var DEFAULT_PHRASES = [
  "mark as done",
  "mark it done",
  "mark done",
  "ship it",
  "done",
];

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(",").map(function (item) {
    return item.trim();
  }).filter(function (item) { return !!item; });
}

function normalizeTriggerText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function completionTriggerPhrases(completion) {
  var input = completion || {};
  var configured = splitList(input.closeOnUserMessages || input.triggerPhrases ||
    input.userTriggers);
  return configured.length > 0 ? configured : DEFAULT_PHRASES.slice();
}

function matchesCompletionTrigger(completion, text) {
  var normalized = normalizeTriggerText(text);
  if (!normalized) return false;
  var phrases = completionTriggerPhrases(completion);
  for (var i = 0; i < phrases.length; i++) {
    var phrase = normalizeTriggerText(phrases[i]);
    if (!phrase) continue;
    if (normalized === phrase || normalized === "ok " + phrase ||
        normalized === "please " + phrase || normalized === "go ahead " + phrase ||
        normalized === "go ahead and " + phrase) return true;
  }
  return false;
}

function isAccepted(value) {
  return !!(value && value.status === "accepted" && value.withdrawnAt == null);
}

function attachProjectOwnerAcceptance(ctx) {
  var options = ctx || {};
  var usersModule = options.usersModule;
  var now = options.now || Date.now;

  function approvalFor(session, actorUserId, text) {
    var multiUser = usersModule && typeof usersModule.isMultiUser === "function" &&
      usersModule.isMultiUser();
    var by = "";
    if (!multiUser) by = session && session.ownerId || "local-owner";
    else if (actorUserId && session && session.ownerId === actorUserId) by = actorUserId;
    if (!by) return null;
    return {
      granted: true,
      status: "accepted",
      at: now(),
      by: String(by).slice(0, 128),
      source: "owner_message",
      phrase: normalizeTriggerText(text).slice(0, 128),
      withdrawnAt: null,
    };
  }

  return { approvalFor: approvalFor };
}

module.exports = {
  DEFAULT_PHRASES: DEFAULT_PHRASES,
  attachProjectOwnerAcceptance: attachProjectOwnerAcceptance,
  completionTriggerPhrases: completionTriggerPhrases,
  isAccepted: isAccepted,
  matchesCompletionTrigger: matchesCompletionTrigger,
  normalizeTriggerText: normalizeTriggerText,
};
