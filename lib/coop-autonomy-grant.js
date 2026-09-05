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
var forbiddenActions = require("./coop-autonomy-forbidden-actions");
var projectIdentity = require("./project-identity");
var readOnlyReview = require("./coop-read-only-review-admission");
var portfolioBindings = require("./portfolio-execution-bindings");

var SCHEMA = "clay.scoped_autonomy_grant";
var VERSION = 1;
var MAX_PROJECTS = 64;
var DIGEST_RE = /^[a-f0-9]{64}$/;

var CATEGORIES = ["read_only_diagnosis", "approved_revision_bump",
  "ordinary_internal_clay_coop_work"];
var CLAY_PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";

// Widens coop-read-only-review-admission's REVIEW_FRAMING with the words an
// owner actually uses for this category. That module is not edited: its own
// caller pairs it with an explicit owner turn, so its narrower framing is
// correct there and is accepted here as an alternative, never a requirement.
var DIAGNOSIS_FRAMING =
  /\b(?:audits?|diagnos(?:e|is|tic|tics)|investigat(?:e|ion)|inspect(?:ion)?|reviews?|research|triage|plan(?:s|ning)?|report\s+on|root[-\s]?cause)\b/i;

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value, limit) {
  var result = typeof value === "string" ? value.trim() : "";
  return result && result.length <= (limit || 240) ? result : "";
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

var forbiddenAction = forbiddenActions.forbiddenAction;
var forbiddenIds = forbiddenActions.forbiddenIds;

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

// A Coop self-repair is not a general revision-bump category. Its owner-facing
// control names one already-admitted project task and one next revision, so a
// switch cannot turn a broad class of self-modification into standing authority.
function normalizeCoopSelfRepair(value) {
  if (!plainObject(value) || String(meaningfulKeys(value).join(",")) !==
      "bindingRevision,enabled,portfolioTaskId,projectRef" ||
      typeof value.enabled !== "boolean") return null;
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  var portfolioTaskId = String(value.portfolioTaskId || "").trim();
  var bindingRevision = Number(value.bindingRevision);
  if (!projectRef || !projectIdentity.isTaskId(portfolioTaskId) ||
      !Number.isInteger(bindingRevision) || bindingRevision < 2) return null;
  return {
    enabled: value.enabled,
    projectRef: { projectId: projectRef.projectId },
    portfolioTaskId: portfolioTaskId,
    bindingRevision: bindingRevision,
  };
}

// Strict, and strict in the safe direction: anything unexpected disables the
// grant rather than being ignored. `enabled` must be a real boolean, so a
// truthy "true" string or 1 cannot switch autonomy on by accident.
function normalizePolicy(value) {
  if (!plainObject(value) || value.schema !== SCHEMA || value.version !== VERSION ||
      typeof value.enabled !== "boolean") return null;
  var keys = String(meaningfulKeys(value).join(","));
  if (keys !== "categories,enabled,permanentlyGated,projects,schema,version" &&
      keys !== "categories,coopSelfRepair,enabled,permanentlyGated,projects,schema,version") {
    return null;
  }
  if (!sameStringSet(value.permanentlyGated, forbiddenIds())) return null;
  var projects = normalizeProjects(value.projects);
  var categories = normalizeCategories(value.categories);
  var coopSelfRepair = Object.prototype.hasOwnProperty.call(value, "coopSelfRepair") ?
    normalizeCoopSelfRepair(value.coopSelfRepair) : null;
  if (!projects || !categories ||
      Object.prototype.hasOwnProperty.call(value, "coopSelfRepair") && !coopSelfRepair) return null;
  return {
    enabled: value.enabled,
    projects: projects,
    categories: categories,
    coopSelfRepair: coopSelfRepair,
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

var dispatchText = forbiddenActions.dispatchText;

function readOnlyDiagnosis(input) {
  if (!fullyReadOnly(input && input.ownedPaths)) return false;
  var framing = [input && input.title, input && input.objective].map(function (value) {
    return typeof value === "string" ? value : "";
  }).join("\n");
  return DIAGNOSIS_FRAMING.test(framing) ||
    readOnlyReview.isReadOnlyPlanningReview(input);
}

// The owner's Clay-On scope deliberately covers Clay and Coop implementation
// work, but not a generic task that merely happens to target the Clay project.
// Requiring a Clay/Coop identity in the real brief or durable task id keeps the
// standing scope project-local and prevents an unrelated payload from borrowing
// the project's switch.
function ordinaryInternalClayCoopWork(input, request, project) {
  if (!project || project.projectId !== CLAY_PROJECT_ID) return false;
  var source = input || {};
  // This standing route is a replacement for missing owner evidence, never a
  // way to reinterpret a dispatch already attached to an owner ingress or
  // Thread. Those routes retain their exact-match and scope checks.
  if (String(source.coopIngressId || "").trim()) return false;
  if (source.coopStandingAutonomy !== true) return false;
  var identity = [source.title, source.objective, source.context,
    source.acceptanceCriteria, source.ownedPaths, request && request.portfolioTaskId]
    .map(function (value) { return typeof value === "string" ? value : ""; })
    .join("\n");
  return /\b(?:clay|coop)\b/i.test(identity);
}

function ordinaryInternalSafetyGate(input) {
  var source = input || {};
  if (source.externalStateChange === true || source.externalOperation === true ||
      source.externalAction === true) {
    return "autonomy_grant_external_state_change_gated";
  }
  if (source.spendRequired === true || source.budgetException === true ||
      /\b(?:spend(?:ing)?\s+required|budget\s+(?:exception|overrun|increase|override)|cost\s+override)\b/i
        .test(dispatchText(source))) {
    return "autonomy_grant_spend_or_budget_exception_gated";
  }
  if (source.leadSelfModification === true || source.selfModifying === true ||
      /\b(?:lead\s+self[-\s]?modif(?:y|ication)|self[-\s]?modif(?:y|ication)\s+(?:the\s+)?lead|modify\s+(?:the\s+)?lead(?:'s)?\s+(?:authority|policy|control)|change\s+(?:the\s+)?lead(?:'s)?\s+(?:authority|policy|control))\b/i
        .test(dispatchText(source))) {
    return "autonomy_grant_lead_self_modification_gated";
  }
  if (source.destructive === true || source.blocked === true ||
      source.scopeExpansion === true || source.scopeExpanded === true ||
      source.materialScopeChange === true) {
    return "autonomy_grant_ordinary_work_safety_gate_required";
  }
  return "";
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

// Proves the re-dispatched BRIEF is the one the owner approved, not merely that
// it reuses an approved task id. The approved scope on the owner record carries
// coordinates only -- no title, objective or owned paths -- so without this the
// coordinates alone would admit arbitrary new work under a previously approved
// id, at any higher revision, indefinitely.
//
// The comparison reads the execution binding already written for the approved
// revision, which persists a sha256 over exactly the payload fields (title,
// objective, context, acceptanceCriteria, ownedPaths, dependencies, imageRefs,
// difficulty, maxAttempts). The incoming side is RECOMPUTED from the dispatch
// brief rather than read from a supplied taskPayloadDigest, for the same reason
// forbiddenAction scans the prose instead of trusting a declared flag: the
// declaration would come from the caller that wants the work admitted.
//
// Fails closed on every missing input -- no binding store, no binding at the
// approved revision (released, reaped or pruned), or a malformed digest on
// either side. A bump can only be admitted on positive proof of sameness.
function sameApprovedBrief(input, request, approvedRevision, deps) {
  var bindings = deps && deps.bindings;
  if (!bindings || typeof bindings.get !== "function") return false;
  var approved;
  try {
    approved = bindings.get(request.portfolioTaskId, approvedRevision);
  } catch (error) {
    return false;
  }
  var approvedDigest = approved && typeof approved.taskPayloadDigest === "string"
    ? approved.taskPayloadDigest : "";
  if (!DIGEST_RE.test(approvedDigest)) return false;
  var incoming = portfolioBindings.taskPayloadDigest(input || {});
  return DIGEST_RE.test(incoming) && incoming === approvedDigest;
}

// A task this owner already approved at a LOWER revision, where ONLY the
// revision changed. Project, Thread and task id must all be identical to the
// scope that actually reached disk, so this can never carry an approval across
// projects, across Threads, or onto different work. The brief itself must also
// be unchanged from the approved revision -- see sameApprovedBrief.
function priorApprovedRevision(ownerRequests, request, input, deps) {
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
      // Coordinates line up. Admit only if the brief is the approved one too.
      // `continue` rather than a hard stop: a different scope on an earlier
      // revision may still hold the matching brief, and each candidate has to
      // clear the same proof on its own.
      if (!sameApprovedBrief(input, request, scopeRevision, deps)) continue;
      return { ingressId: String(entry.ingressId || ""), bindingRevision: scopeRevision };
    }
  }
  return null;
}

function sameCoopSelfRepairTask(control, request) {
  var project = projectIdentity.normalizeProjectRef(request && request.targetProject);
  return !!(control && project && project.projectId === control.projectRef.projectId &&
    String(request && request.portfolioTaskId || "") === control.portfolioTaskId);
}

function sameCoopSelfRepairScope(control, request) {
  return sameCoopSelfRepairTask(control, request) &&
    Number(request && request.bindingRevision) === control.bindingRevision;
}

function hasExactCoopSelfRepairAuthority(input, request, control) {
  var source = input || {};
  var project = projectIdentity.normalizeProjectRef(source.targetProject);
  var requestedProject = projectIdentity.normalizeProjectRef(request && request.targetProject);
  var key = text(source.idempotencyKey, 500);
  var requestedKey = text(request && request.idempotencyKey, 500);
  if (!project || !requestedProject || project.projectId !== requestedProject.projectId ||
      project.projectId !== control.projectRef.projectId ||
      String(source.portfolioTaskId || "") !== control.portfolioTaskId ||
      String(request && request.portfolioTaskId || "") !== control.portfolioTaskId ||
      Number(source.bindingRevision) !== control.bindingRevision ||
      Number(request && request.bindingRevision) !== control.bindingRevision ||
      !key || key !== requestedKey || source.mode !== "project_coordinator" ||
      request.mode !== "project_coordinator" || source.controlRole !== "project_coordinator") {
    return false;
  }
  var topic = String(request && request.coopTopicRef && request.coopTopicRef.topicId || "").trim();
  return !!topic;
}

function selfRepairGate(input) {
  var source = input || {};
  if (source.spendRequired === true || source.budgetException === true ||
      /\b(?:spend(?:ing)?\s+required|budget\s+(?:exception|overrun|increase|override)|cost\s+override)\b/i
        .test(dispatchText(source))) {
    return "autonomy_grant_spend_or_budget_exception_gated";
  }
  if (source.scopeExpansion === true || source.scopeExpanded === true ||
      source.materialScopeChange === true ||
      /\b(?:scope\s+expansion|expand(?:ed|ing)?\s+scope|broaden(?:ed|ing)?\s+scope)\b/i
        .test(dispatchText(source))) {
    return "autonomy_grant_scope_expansion_gated";
  }
  var forbidden = forbiddenAction(source);
  if (forbidden && forbidden !== "approval_policy_change") {
    return "autonomy_grant_" + forbidden + "_gated";
  }
  return "";
}

// The `applies` marker stops the general approved-revision-bump category from
// bypassing a deliberately disabled exact self-repair control.
function coopSelfRepairAdmission(policy, input, request, deps) {
  var control = policy && policy.coopSelfRepair;
  if (!sameCoopSelfRepairTask(control, request)) return { applies: false, decision: null };
  if (!sameCoopSelfRepairScope(control, request)) return { applies: true, decision: null };
  if (!policy.enabled || !control.enabled) return { applies: true, decision: null };
  if (!hasExactCoopSelfRepairAuthority(input, request, control)) {
    return { applies: true, decision: { ok: false,
      reason: "autonomy_grant_self_repair_authority_required" } };
  }
  var gate = selfRepairGate(input);
  if (gate) return { applies: true, decision: { ok: false, reason: gate } };
  var prior = priorApprovedRevision(deps && deps.ownerRequests, request, input, deps);
  if (!prior) return { applies: true, decision: null };
  return {
    applies: true,
    decision: {
      ok: true,
      request: request,
      standingGrant: {
        category: "coop_self_repair",
        projectId: control.projectRef.projectId,
        portfolioTaskId: control.portfolioTaskId,
        bindingRevision: control.bindingRevision,
        approvedIngressId: prior.ingressId,
        approvedRevision: prior.bindingRevision,
      },
    },
  };
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
  var selfRepair = coopSelfRepairAdmission(policy, input, request, options);
  if (selfRepair.applies) return selfRepair.decision;
  var reviewOnly = policy.categories.read_only_diagnosis && readOnlyDiagnosis(input);
  // A read-only brief may name a forbidden action solely to prohibit it. Only
  // that category can ignore negative-only clauses; every other path retains
  // the original mention-based, fail-closed scan.
  var forbidden = forbiddenAction(input, {
    ignoreNegativeOnlyConstraints: reviewOnly,
  });
  if (forbidden) {
    return { ok: false, reason: "autonomy_grant_" + forbidden + "_gated" };
  }
  if (reviewOnly) {
    return {
      ok: true,
      request: request,
      reviewOnly: true,
      standingGrant: { category: "read_only_diagnosis", projectId: project.projectId },
    };
  }
  if (policy.categories.ordinary_internal_clay_coop_work &&
      ordinaryInternalClayCoopWork(input, request, project)) {
    var ordinaryGate = ordinaryInternalSafetyGate(input);
    if (ordinaryGate) return { ok: false, reason: ordinaryGate };
    return {
      ok: true,
      request: request,
      standingGrant: {
        category: "ordinary_internal_clay_coop_work",
        projectId: project.projectId,
      },
    };
  }
  if (policy.categories.approved_revision_bump) {
    var prior = priorApprovedRevision(options.ownerRequests, request, input, options);
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
  coopSelfRepairAdmission: coopSelfRepairAdmission,
  normalizeCoopSelfRepair: normalizeCoopSelfRepair,
  ordinaryInternalClayCoopWork: ordinaryInternalClayCoopWork,
  ordinaryInternalSafetyGate: ordinaryInternalSafetyGate,
  sameApprovedBrief: sameApprovedBrief,
  standingAdmission: standingAdmission,
};
