// Widened standing autonomy grant -- OFF unless the owner flips one switch.
//
// The counterpart to coop-scoped-autonomy-policy, which grants autonomy over
// candidates the Lead backlog already ADMITTED, in ONE project, under the
// single kind "admitted_low_risk_backlog". That grant cannot speak for an
// ad-hoc dispatch, because an ad-hoc dispatch was never admitted and so has no
// candidate digest, no eligibility pass and no safety envelope to re-check.
//
// This module is the other shape: a standing scope the owner declares up front
// in scoped-autonomy-policy.json, checked against the dispatch itself.
//
// Three properties are load-bearing and every change here must keep them:
//
//   1. OFF is byte-identical to no module at all. Every rejection path returns
//      null, never a refusal, so the caller's own fail-closed default stays in
//      charge. A missing, unreadable or malformed file is OFF.
//   2. It is a STANDING SCOPE, not a matcher. It never looks at owner wording
//      and never guesses which task was meant, so it cannot weaken the
//      exactly-one-match rule that governs named approvals. It is consulted
//      only where no approval ingress was cited at all -- in that gap nothing
//      has been refused, so there is no refusal to route around.
//   3. The permanently gated actions below are hard-coded. The policy file
//      declares them so an owner can read the boundary in one screen, but the
//      file is never their authority: a file that declares a different list is
//      malformed, which switches the grant OFF. Editing the declaration can
//      only ever remove autonomy, never add it.

var fs = require("fs");
var path = require("path");
var projectIdentity = require("./project-identity");
var readOnlyReview = require("./coop-read-only-review-admission");

var SCHEMA = "clay.scoped_autonomy_grant";
var VERSION = 1;
var MAX_PROJECTS = 64;

// Actions no switch in this file can ever release. Each stays gated because it
// mutates state outside the repository working tree, where a mistake is not
// revertible by the owner alone.
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
    pattern: /\b(?:approval\s+polic|approval\s+gate|autonomy\s+polic|autonomy\s+grant|scoped[-\s]?autonomy|self[-\s]?modif)/i,
  },
];

var CATEGORIES = ["read_only_diagnosis", "approved_revision_bump"];

// Widens coop-read-only-review-admission's REVIEW_FRAMING with the words an
// owner actually uses for this category. That module is not edited: its own
// caller pairs it with an explicit owner turn, so its narrower framing is
// correct there and is accepted here as an alternative, never a requirement.
var DIAGNOSIS_FRAMING =
  /\b(?:audits?|diagnos(?:e|is|tic|tics)|investigat(?:e|ion)|inspect(?:ion)?|reviews?|research|triage|plan(?:s|ning)?|report\s+on|root[-\s]?cause)\b/i;

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function defaultFile() {
  return path.join(__dirname, "..", "scoped-autonomy-policy.json");
}

// Documentation keys are prefixed "_" so the owner-facing file can explain
// itself in place without every comment having to become a schema change.
function meaningfulKeys(value) {
  return Object.keys(value).filter(function (key) { return key.indexOf("_") !== 0; }).sort();
}

function sameStringSet(list, expected) {
  if (!Array.isArray(list) || list.length !== expected.length) return false;
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string" || seen[list[i]]) return false;
    seen[list[i]] = true;
  }
  for (var j = 0; j < expected.length; j++) {
    if (!seen[expected[j]]) return false;
  }
  return true;
}

function forbiddenIds() {
  return FORBIDDEN_ACTIONS.map(function (action) { return action.id; });
}

function normalizeProjects(value) {
  if (!Array.isArray(value) || value.length > MAX_PROJECTS) return null;
  var ids = [];
  var seen = {};
  for (var i = 0; i < value.length; i++) {
    var entry = value[i];
    if (!plainObject(entry)) return null;
    var extra = meaningfulKeys(entry).filter(function (key) {
      return key !== "projectId" && key !== "name";
    });
    if (extra.length) return null;
    var ref = projectIdentity.normalizeProjectRef(entry);
    // Only projectId carries authority. `name` exists so a human reading the
    // file can tell which project a UUID is, and is deliberately not matched.
    if (!ref || seen[ref.projectId]) return null;
    seen[ref.projectId] = true;
    ids.push(ref.projectId);
  }
  return ids;
}

function normalizeCategories(value) {
  if (!Array.isArray(value)) return null;
  var allowed = {};
  for (var i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string" || CATEGORIES.indexOf(value[i]) === -1 ||
        allowed[value[i]]) return null;
    allowed[value[i]] = true;
  }
  return allowed;
}

// Strict, and strict in the safe direction: anything unexpected disables the
// grant rather than being ignored. `enabled` must be a real boolean, so a
// truthy "true" string or 1 cannot switch autonomy on by accident.
function normalizePolicy(value) {
  if (!plainObject(value) || value.schema !== SCHEMA || value.version !== VERSION ||
      typeof value.enabled !== "boolean") return null;
  if (String(meaningfulKeys(value).join(",")) !==
      "categories,enabled,permanentlyGated,projects,schema,version") return null;
  if (!sameStringSet(value.permanentlyGated, forbiddenIds())) return null;
  var projects = normalizeProjects(value.projects);
  var categories = normalizeCategories(value.categories);
  if (!projects || !categories) return null;
  return {
    enabled: value.enabled,
    projects: projects,
    categories: categories,
  };
}

function loadPolicy(deps) {
  var options = deps || {};
  var file = options.autonomyPolicyFile || defaultFile();
  var raw;
  try {
    raw = (options.fs || fs).readFileSync(file, "utf8");
  } catch (error) {
    return null;
  }
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return null;
  }
  return normalizePolicy(parsed);
}

// Every owned-path segment must be read-only.
// coop-read-only-review-admission.isReadOnlyPlanningReview only proves the
// STRING STARTS WITH "read-only:", so "read-only: a.js; b.js" satisfies it
// while leaving b.js writable. That is safe for its caller, which also demands
// an explicit owner turn. A standing grant has no such turn, so it checks every
// segment instead of trusting the first.
function fullyReadOnly(ownedPaths) {
  var segments = String(ownedPaths || "").split(";");
  var found = 0;
  for (var i = 0; i < segments.length; i++) {
    var segment = segments[i].trim();
    if (!segment) continue;
    if (!/^read-only\s*:/i.test(segment)) return false;
    found++;
  }
  return found > 0;
}

function dispatchText(input) {
  var value = input || {};
  return [value.title, value.objective, value.context, value.acceptanceCriteria,
    value.ownedPaths].map(function (part) {
    return typeof part === "string" ? part : "";
  }).join("\n");
}

// Returns the id of the first permanently gated action this dispatch mentions,
// or "". Scanned over the whole brief rather than a declared flag: the flag
// would be supplied by the same caller that wants the work admitted.
function forbiddenAction(input) {
  var text = dispatchText(input);
  if (!text.trim()) return "";
  for (var i = 0; i < FORBIDDEN_ACTIONS.length; i++) {
    if (FORBIDDEN_ACTIONS[i].pattern.test(text)) return FORBIDDEN_ACTIONS[i].id;
  }
  return "";
}

function readOnlyDiagnosis(input) {
  if (!fullyReadOnly(input && input.ownedPaths)) return false;
  var framing = [input && input.title, input && input.objective].map(function (value) {
    return typeof value === "string" ? value : "";
  }).join("\n");
  return DIAGNOSIS_FRAMING.test(framing) ||
    readOnlyReview.isReadOnlyPlanningReview(input);
}

function ownerRequestList(ownerRequests) {
  try {
    return typeof ownerRequests.list === "function" ? ownerRequests.list() : [];
  } catch (error) {
    return [];
  }
}

function scopesOf(entry) {
  if (Array.isArray(entry.implementationScopes) && entry.implementationScopes.length) {
    return entry.implementationScopes;
  }
  return entry.implementationScope ? [entry.implementationScope] : [];
}

// A task this owner already approved at a LOWER revision, where ONLY the
// revision changed. Project, Thread and task id must all be identical to the
// scope that actually reached disk, so this can never carry an approval across
// projects, across Threads, or onto different work.
function priorApprovedRevision(ownerRequests, request) {
  if (!ownerRequests || !request) return null;
  var wantedTask = String(request.portfolioTaskId || "");
  var wantedRevision = Number(request.bindingRevision);
  var project = projectIdentity.normalizeProjectRef(request.targetProject);
  var topicId = request.coopTopicRef && String(request.coopTopicRef.topicId || "");
  if (!projectIdentity.isTaskId(wantedTask) || !Number.isInteger(wantedRevision) ||
      wantedRevision < 2 || !project || !topicId) return null;
  var entries = ownerRequestList(ownerRequests);
  for (var i = entries.length - 1; i >= 0; i--) {
    var entry = entries[i];
    if (!plainObject(entry) || entry.expectsExecution !== true ||
        !plainObject(entry.implementationDecision)) continue;
    if (entry.response && entry.response.state === "superseded") continue;
    var scopes = scopesOf(entry);
    for (var j = 0; j < scopes.length; j++) {
      var scope = scopes[j];
      if (!plainObject(scope)) continue;
      var scopeProject = projectIdentity.normalizeProjectRef(scope.projectRef);
      var scopeRevision = Number(scope.bindingRevision);
      if (String(scope.portfolioTaskId || "") !== wantedTask) continue;
      if (!scopeProject || scopeProject.projectId !== project.projectId) continue;
      if (!scope.topicRef || String(scope.topicRef.topicId || "") !== topicId) continue;
      if (!Number.isInteger(scopeRevision) || scopeRevision >= wantedRevision) continue;
      return { ingressId: String(entry.ingressId || ""), bindingRevision: scopeRevision };
    }
  }
  return null;
}

// The one entry point. Returns:
//   null              -- this module has nothing to say; the caller's own
//                        fail-closed default decides. This is the OFF answer
//                        and the answer for every dispatch outside the grant.
//   { ok: false, ... } -- a permanently gated action was named in an otherwise
//                        allowlisted project. Refused explicitly so the reason
//                        names the real boundary.
//   { ok: true, ... }  -- the standing grant covers this dispatch.
function standingAdmission(input, request, deps) {
  var options = deps || {};
  var policy = loadPolicy(options);
  if (!policy || policy.enabled !== true) return null;
  var project = projectIdentity.normalizeProjectRef(request && request.targetProject);
  if (!project || policy.projects.indexOf(project.projectId) === -1) return null;
  // Checked before any category, so a gated action inside an allowlisted
  // project is refused rather than quietly falling through as "not covered".
  var forbidden = forbiddenAction(input);
  if (forbidden) {
    return { ok: false, reason: "autonomy_grant_" + forbidden + "_gated" };
  }
  if (policy.categories.read_only_diagnosis && readOnlyDiagnosis(input)) {
    return {
      ok: true,
      request: request,
      reviewOnly: true,
      standingGrant: { category: "read_only_diagnosis", projectId: project.projectId },
    };
  }
  if (policy.categories.approved_revision_bump) {
    var prior = priorApprovedRevision(options.ownerRequests, request);
    if (prior) {
      return {
        ok: true,
        request: request,
        standingGrant: {
          category: "approved_revision_bump",
          projectId: project.projectId,
          approvedIngressId: prior.ingressId,
          approvedRevision: prior.bindingRevision,
        },
      };
    }
  }
  return null;
}

module.exports = {
  CATEGORIES: CATEGORIES,
  SCHEMA: SCHEMA,
  VERSION: VERSION,
  defaultFile: defaultFile,
  forbiddenAction: forbiddenAction,
  forbiddenIds: forbiddenIds,
  fullyReadOnly: fullyReadOnly,
  loadPolicy: loadPolicy,
  normalizePolicy: normalizePolicy,
  priorApprovedRevision: priorApprovedRevision,
  readOnlyDiagnosis: readOnlyDiagnosis,
  standingAdmission: standingAdmission,
};
