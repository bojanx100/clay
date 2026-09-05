// Permanently gated external actions for Coop's standing autonomy grant.
// The default scanner is intentionally mention-based. Read-only diagnosis may
// opt out of clauses that are solely safety prohibitions, because "do not push"
// is a boundary on the worker, not a request to push.

var FORBIDDEN_ACTIONS = [
  {
    id: "push_to_remote",
    pattern: /\b(?:git\s+push|force[-\s]?push|push(?:ed|ing|es)?\s+(?:it\s+|them\s+|this\s+)?(?:up\b|to\s+(?:the\s+)?(?:remote|origin|upstream)|the\s+(?:branch|commits?))|publish\s+(?:the\s+)?(?:branch|release|tag))/i,
  },
  {
    id: "pull_request_comment_or_merge",
    pattern: /\bgh\s+pr\b|\b(?:pull\s+requests?|prs?)\b[\s\S]{0,48}?\b(?:comment|merge|merging|approve|approving|close|closing|review\s+comment)\b|\b(?:comment\s+on|merge|merging|close)\b[\s\S]{0,48}?\b(?:pull\s+requests?|prs?)\b/i,
  },
  {
    id: "issue_or_board_mutation",
    pattern: /\bgh\s+issue\b|\b(?:close|closing|reopen|comment\s+on|label|assign|triage\s+state\s+of)\b[\s\S]{0,32}?\bissues?\b|\b(?:issue|board|project\s+board|column|card)\s+state\b|\bmove\s+(?:the\s+)?(?:card|issue|item)\b|\bupdate\s+(?:the\s+)?(?:board|project\s+board)\b/i,
  },
  {
    id: "approval_policy_change",
    pattern: /\b(?:approval\s+polic|approval\s+gate|autonomy\s+polic|autonomy\s+grant|scoped[-\s]?autonomy|self[-\s]?(?:modif|repair|fix))/i,
  },
];

function dispatchParts(input) {
  var value = input || {};
  return [value.title, value.objective, value.context, value.acceptanceCriteria,
    value.ownedPaths].map(function (part) {
    return typeof part === "string" ? part : "";
  });
}

function negativeOnlyConstraint(clause) {
  var value = String(clause || "").trim();
  if (!/^(?:do\s+not|don't|must\s+not|never|no(?:\s|$))/i.test(value)) return false;
  if (/\b(?:but|however|instead|except|unless|then|only|afterwards?)\b/i.test(value)) {
    return false;
  }
  var commaParts = value.split(",");
  for (var ci = 1; ci < commaParts.length; ci++) {
    var part = commaParts[ci].trim();
    if (/^(?:and|or)\b/i.test(part)) continue;
    for (var ai = 0; ai < FORBIDDEN_ACTIONS.length; ai++) {
      if (FORBIDDEN_ACTIONS[ai].pattern.test(part)) return false;
    }
  }
  if (/^no(?:\s|$)/i.test(value) &&
      !/\b(?:mutations?|changes?|edits?|writes?|actions?|commands?|updates?|push(?:es)?|merges?|comments?|assignments?|closures?|publishing)\s*$/i.test(value)) {
    return false;
  }
  return true;
}

function omitNegativeOnlyConstraints(value) {
  return String(value || "").split(/(?:[\r\n;]+|[.!?]+(?:\s+|$))/).filter(function (clause) {
    return !negativeOnlyConstraint(clause);
  }).join("\n");
}

function dispatchText(input, options) {
  var parts = dispatchParts(input);
  if (options && options.ignoreNegativeOnlyConstraints === true) {
    parts = parts.map(omitNegativeOnlyConstraints);
  }
  return parts.join("\n");
}

// Returns the id of the first permanently gated action this dispatch mentions.
// Read-only diagnosis may ignore unambiguous negative-only clauses; clauses with
// contrast words stay in the scan and therefore fail closed.
function forbiddenAction(input, options) {
  var value = dispatchText(input, options);
  if (!value.trim()) return "";
  for (var i = 0; i < FORBIDDEN_ACTIONS.length; i++) {
    if (FORBIDDEN_ACTIONS[i].pattern.test(value)) return FORBIDDEN_ACTIONS[i].id;
  }
  return "";
}

function forbiddenIds() {
  return FORBIDDEN_ACTIONS.map(function (action) { return action.id; });
}

module.exports = {
  dispatchText: dispatchText,
  forbiddenAction: forbiddenAction,
  forbiddenIds: forbiddenIds,
  negativeOnlyConstraint: negativeOnlyConstraint,
  omitNegativeOnlyConstraints: omitNegativeOnlyConstraints,
};
