// Narrow authorization rules for owner-approved read-only evidence workers.
// This path is deliberately separate from implementation intent: a plural
// acknowledgement such as "do them" must never authorize source mutation.

var REVIEW_FRAMING =
  /\b(?:audits?|council|design|plans?|planning|research|reviews?|triage)\b/i;
var TERMINAL_RECONCILIATION_FRAMING =
  /\b(?:terminal[\s-]+reconciliation|reconciliation[\s-]+(?:evidence|fence|proof|status))\b/i;
var PEER_CONTROL_ROLE = /^(?:council|triage)$/i;
var MUTATING_ACTION =
  /\b(?:apply|commit|create|delete|deploy|edit\w*|fix\w*|implement\w*|merge|modify\w*|mutat\w*|push|remove|terminalize|update|write\w*)\b/i;
var NEGATED_MUTATING_ACTION =
  /\b(?:no|never|without|do\s+not|don't)\s+(?:(?:source|state|remote|code|repository|files?)\s+)*(?:apply|commit|create|delete|deploy|edit\w*|fix\w*|implement\w*|merge|modify\w*|mutat\w*|push|remove|terminalize|update|write\w*)\b/gi;
var PLURAL_OWNER_AUTHORIZATION =
  /^(?:(?:yes|ok(?:ay)?)[,\s]+)?(?:please\s+)?(?:do|run|start)\s+(?:them|both|these|those)(?:\s+(?:reviews?|tasks?))?$/i;
var negativeOnlyConstraint = require("./coop-autonomy-forbidden-actions").negativeOnlyConstraint;

function briefing(input) {
  return [input && input.title, input && input.objective,
    input && input.context, input && input.acceptanceCriteria].map(function (value) {
    return String(value || "");
  }).join("\n");
}

function hasReadOnlyOwnershipBoundary(ownedPaths) {
  var paths = String(ownedPaths || "").split(";");
  if (!paths.length) return false;
  for (var i = 0; i < paths.length; i++) {
    if (!/^\s*read-only\s*:/i.test(paths[i])) return false;
  }
  return true;
}

function hasMutatingInstruction(input) {
  var remaining = briefing(input).split(/(?:[\r\n;]+|[.!?]+(?:\s+|$))/).filter(function (clause) {
    if (!negativeOnlyConstraint(clause)) return true;
    // A new imperative after a comma is not covered by the first prohibition.
    return clause.split(",").slice(1).some(function (part) {
      return !/^\s*(?:and|or)\b/i.test(part) && MUTATING_ACTION.test(part);
    });
  }).join("\n");
  return MUTATING_ACTION.test(remaining.replace(NEGATED_MUTATING_ACTION, ""));
}

function namesReadOnlyEvidenceWork(input) {
  var text = briefing(input);
  if (hasMutatingInstruction(input)) return false;
  return REVIEW_FRAMING.test(text) || TERMINAL_RECONCILIATION_FRAMING.test(text) ||
    PEER_CONTROL_ROLE.test(String(input && input.controlRole || ""));
}

function isReadOnlyPlanningReview(input) {
  if (!input || !hasReadOnlyOwnershipBoundary(input.ownedPaths)) return false;
  // ProjectRef admission used to consult REVIEW_FRAMING only. Explicit Triage
  // routing and a non-mutating terminal-reconciliation evidence brief therefore
  // incorrectly entered the implementation gate, where a stale worker epoch
  // could make the refusal appear to be an approval problem. The scope and the
  // action scan remain mandatory, so no implementation or other mutation uses
  // this read-only path.
  return namesReadOnlyEvidenceWork(input);
}

function explicitReadOnlyReviewAuthorization(text) {
  var normalized = String(text || "").trim().replace(/[.!…]+$/, "").trim();
  return PLURAL_OWNER_AUTHORIZATION.test(normalized);
}

module.exports = {
  hasMutatingInstruction: hasMutatingInstruction,
  explicitReadOnlyReviewAuthorization: explicitReadOnlyReviewAuthorization,
  isReadOnlyPlanningReview: isReadOnlyPlanningReview,
};
