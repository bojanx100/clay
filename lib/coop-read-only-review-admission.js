// Narrow authorization rules for owner-approved planning and review workers.
// This path is deliberately separate from implementation intent: a plural
// acknowledgement such as "do them" must never authorize source mutation.

var REVIEW_FRAMING =
  /\b(?:audits?|council|design|plans?|planning|research|reviews?|triage)\b/i;
var PLURAL_OWNER_AUTHORIZATION =
  /^(?:(?:yes|ok(?:ay)?)[,\s]+)?(?:please\s+)?(?:do|run|start)\s+(?:them|both|these|those)(?:\s+(?:reviews?|tasks?))?$/i;

function isReadOnlyPlanningReview(input) {
  if (!input || !/^\s*read-only\s*:/i.test(String(input.ownedPaths || ""))) return false;
  var framing = [input.title, input.objective].map(function (value) {
    return String(value || "");
  }).join("\n");
  return REVIEW_FRAMING.test(framing);
}

function explicitReadOnlyReviewAuthorization(text) {
  var normalized = String(text || "").trim().replace(/[.!…]+$/, "").trim();
  return PLURAL_OWNER_AUTHORIZATION.test(normalized);
}

module.exports = {
  explicitReadOnlyReviewAuthorization: explicitReadOnlyReviewAuthorization,
  isReadOnlyPlanningReview: isReadOnlyPlanningReview,
};
