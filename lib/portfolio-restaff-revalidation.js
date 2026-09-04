// portfolio-restaff-revalidation.js - Fail-closed live-board revalidation for
// portfolio restaff and re-arm.
//
// Admission-time eligibility proves an issue was ownable WHEN IT WAS ADMITTED.
// It proves nothing about the issue now. A binding admitted days ago can be
// restaffed at r2/r3 long after the issue was delivered, moved to an excluded
// board column, or reassigned to someone else. trialview/v2#2777 is the exact
// case (admitted 2026-08-27 while assigned to the owner, delivered by PR #2796,
// reassigned to another engineer and moved to Dev Complete on 09-01, restaffed
// anyway on 09-03): the restaff path never re-read the board.
//
// project-automation-candidate-completion.completionEligibility closes the
// stale-BINDING gap (is this work already done or in flight?). It deliberately
// says nothing about live board facts, and the auto-launch intake receipt in
// project-automation-qualification.js never runs on the restaff path. This
// module is that missing check, kept pure so the dispatch gate can call it
// without inheriting any fetch behaviour.
//
// Fail closed everywhere. A missing, malformed, or stale observation is NOT
// permission to relaunch -- silence must never be read as eligibility, because
// the failure mode it guards is doing unwanted work on someone else's issue.

var MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000;

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Board columns are owner-facing prose ("🔧 Dev Complete"), so compare on a
// normalized form: emoji/punctuation stripped, collapsed whitespace, lowercased.
function normalizedStatus(value) {
  return text(value).toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loginList(value) {
  if (!Array.isArray(value)) return null;
  var result = [];
  for (var i = 0; i < value.length; i++) {
    var entry = value[i];
    var login = plainObject(entry) ? text(entry.login) : text(entry);
    if (!login) return null;
    result.push(login.toLowerCase());
  }
  return result;
}

function decision(eligible, reason, detail) {
  var result = { ok: true, eligible: eligible === true, reason: reason };
  if (detail !== undefined) result.detail = detail;
  return result;
}

function unresolvable(reason, detail) {
  var result = { ok: false, eligible: false, reason: reason };
  if (detail !== undefined) result.detail = detail;
  return result;
}

// A live read of the issue at restaff time. `observedAt` is required and is
// checked against `now`: a cached observation is exactly the stale premise this
// module exists to reject.
function normalizeObservation(value, now) {
  if (!plainObject(value)) return null;
  var itemKey = text(value.itemKey);
  var assignees = loginList(value.assignees);
  if (!itemKey || !assignees) return null;
  if (!Number.isFinite(value.observedAt) || value.observedAt <= 0) return null;
  if (Number.isFinite(now) && value.observedAt > now) return null;
  var state = text(value.state).toLowerCase();
  if (state && state !== "open" && state !== "closed") return null;
  var boardStatuses = null;
  if (Object.prototype.hasOwnProperty.call(value, "boardStatuses")) {
    if (!Array.isArray(value.boardStatuses)) return null;
    boardStatuses = [];
    for (var bi = 0; bi < value.boardStatuses.length; bi++) {
      var boardStatus = text(value.boardStatuses[bi]);
      if (!boardStatus) return null;
      boardStatuses.push(boardStatus);
    }
  }
  var hasBoardStatus = Object.prototype.hasOwnProperty.call(value, "boardStatus") ||
    Array.isArray(boardStatuses);
  return {
    itemKey: itemKey,
    assignees: assignees,
    // An issue with no board card has no column. That is unknown, not allowed:
    // it cannot be proven outside the excluded set, so it fails closed below.
    boardStatus: Object.prototype.hasOwnProperty.call(value, "boardStatus") &&
      value.boardStatus !== null ? text(value.boardStatus) : null,
    hasBoardStatus: hasBoardStatus,
    boardStatuses: boardStatuses,
    state: state || null,
    observedAt: value.observedAt,
  };
}

function normalizePolicy(value) {
  if (!plainObject(value)) return null;
  var ownerLogin = text(value.ownerLogin).toLowerCase();
  if (!ownerLogin) return null;
  var exclusions = [];
  if (value.boardExclusions !== undefined && value.boardExclusions !== null) {
    if (!Array.isArray(value.boardExclusions)) return null;
    for (var i = 0; i < value.boardExclusions.length; i++) {
      var status = normalizedStatus(value.boardExclusions[i]);
      if (!status) return null;
      exclusions.push(status);
    }
  }
  return {
    ownerLogin: ownerLogin,
    boardExclusions: exclusions,
    recipeAllowsUnassigned: value.recipeAllowsUnassigned === true,
  };
}

// An explicit, source-stamped include is the owner deliberately overriding this
// gate for one exact item. It must name the item and carry provenance, so a
// bare `true` can never widen into a blanket bypass.
function explicitInclude(value, itemKey) {
  if (!plainObject(value)) return false;
  return text(value.itemKey) === itemKey && !!text(value.source);
}

// Decide whether an already-admitted portfolio item may be relaunched NOW.
//
//   { observation, policy, override, now }
//
// Returns { ok, eligible, reason } and never throws. `ok:false` means the
// premise could not be established at all; both that and `eligible:false` must
// block the relaunch, but only `eligible:false` carries a durable disposition.
function restaffEligibility(input) {
  var options = plainObject(input) ? input : {};
  var now = Number.isFinite(options.now) ? options.now : Date.now();
  var policy = normalizePolicy(options.policy);
  if (!policy) return unresolvable("revalidation_policy_unresolvable");
  var observation = normalizeObservation(options.observation, now);
  if (!observation) return unresolvable("live_observation_unresolvable");

  var age = now - observation.observedAt;
  if (age > MAX_OBSERVATION_AGE_MS) {
    return unresolvable("live_observation_stale", { ageMs: age });
  }

  if (explicitInclude(options.override, observation.itemKey)) {
    return decision(true, "explicit_source_stamped_include");
  }

  if (observation.state === "closed") {
    return decision(false, "issue_closed");
  }

  if (!observation.hasBoardStatus) {
    return unresolvable("board_status_unresolvable");
  }
  var statuses = observation.boardStatuses || [observation.boardStatus];
  if (!statuses.length) return unresolvable("board_status_unresolvable");
  for (var si = 0; si < statuses.length; si++) {
    var status = normalizedStatus(statuses[si]);
    if (!status) return unresolvable("board_status_unresolvable");
    for (var i = 0; i < policy.boardExclusions.length; i++) {
      if (policy.boardExclusions[i] === status) {
        return decision(false, "board_status_excluded", { boardStatus: statuses[si] });
      }
    }
  }

  if (!observation.assignees.length) {
    return policy.recipeAllowsUnassigned ?
      decision(true, "revalidated_unassigned_allowed") :
      decision(false, "not_assigned_to_owner", { assignees: [] });
  }
  if (observation.assignees.indexOf(policy.ownerLogin) === -1) {
    return decision(false, "not_assigned_to_owner", { assignees: observation.assignees.slice() });
  }

  return decision(true, "revalidated");
}

// The owner-visible record written when a binding is auto-retired for losing
// its qualification. Reference-only and reason-carrying: it explains WHY work
// the owner previously approved is not running, which is the whole point of
// retiring it silently being unacceptable.
function disqualificationEvent(input) {
  var options = plainObject(input) ? input : {};
  var verdict = plainObject(options.verdict) ? options.verdict : null;
  var itemKey = text(options.itemKey);
  var portfolioTaskId = text(options.portfolioTaskId);
  if (!verdict || !itemKey || !portfolioTaskId) return null;
  if (verdict.eligible === true) return null;
  if (!Number.isInteger(options.bindingRevision) || options.bindingRevision < 1) return null;
  return {
    type: "binding_auto_retired",
    itemKey: itemKey,
    portfolioTaskId: portfolioTaskId,
    bindingRevision: options.bindingRevision,
    reason: text(verdict.reason) || "revalidation_failed",
    resolvable: verdict.ok === true,
    detail: verdict.detail === undefined ? null : verdict.detail,
    at: Number.isFinite(options.now) ? options.now : Date.now(),
  };
}

module.exports = {
  MAX_OBSERVATION_AGE_MS: MAX_OBSERVATION_AGE_MS,
  restaffEligibility: restaffEligibility,
  disqualificationEvent: disqualificationEvent,
  normalizedStatus: normalizedStatus,
};
