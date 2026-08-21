// Typed, reference-only authority for autonomous project-policy execution.
// This is deliberately separate from owner implementation admission: it proves
// the current project candidate and policy, and never invents an owner ingress.

var authority = require("./project-automation-authority");
var candidatesModule = require("./project-automation-candidates");
var identity = require("./project-automation-identity");
var policyModule = require("./project-automation-policy");
var projectIdentity = require("./project-identity");
var scopedAutonomy = require("./coop-scoped-autonomy-policy");

var SCHEMA = "clay.project_automation_execution_authorization";
var VERSION = 1;
var KIND = "project_policy_autonomous";
var SCOPED_KIND = "coop_scoped_low_risk";
var SOURCE_KIND = "project_automation_candidate";
var MAX_TEXT = 240;

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  var actual = Object.keys(value).sort();
  var expected = keys.slice().sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function text(value) {
  var result = typeof value === "string" ? value.trim() : "";
  return result && result.length <= MAX_TEXT ? result : "";
}

function normalizeEligibility(value) {
  if (!exactKeys(value,
    ["assignedToOwner", "recipeAllowsUnassigned", "reason"])) return null;
  if (typeof value.assignedToOwner !== "boolean" ||
      typeof value.recipeAllowsUnassigned !== "boolean") return null;
  var reason = value.reason == null ? null : text(value.reason);
  if (value.reason != null && !reason) return null;
  var normalized = {
    assignedToOwner: value.assignedToOwner,
    recipeAllowsUnassigned: value.recipeAllowsUnassigned,
    reason: reason,
  };
  return normalized;
}

function normalizeAuthorization(value) {
  var commonKeys = ["schema", "version", "kind", "source", "projectRef",
    "candidateKey", "candidateDigest", "itemKey", "itemClass", "policyDigest",
    "eligibilityPass", "eligibility", "threadRef", "scope"];
  var isProjectPolicy = value && value.kind === KIND;
  var isScopedPolicy = value && value.kind === SCOPED_KIND;
  if (!isProjectPolicy && !isScopedPolicy) return null;
  if (isScopedPolicy) commonKeys.push("scopedPolicyGrant");
  if (!exactKeys(value, commonKeys) || value.schema !== SCHEMA || value.version !== VERSION) return null;
  if (!exactKeys(value.source, ["kind", "recipeId"]) ||
      value.source.kind !== SOURCE_KIND) return null;
  if (!exactKeys(value.projectRef, ["projectId"])) return null;
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  var candidateKey = text(value.candidateKey);
  var candidateDigest = text(value.candidateDigest);
  var itemKey = text(value.itemKey);
  var itemClass = text(value.itemClass);
  var policyDigest = text(value.policyDigest);
  var eligibilityPass = text(value.eligibilityPass);
  var recipeId = text(value.source.recipeId);
  var eligibility = normalizeEligibility(value.eligibility);
  var expectedThread = identity.threadRefFor({ projectRef: projectRef, itemKey: itemKey });
  if (!projectRef || !candidateKey || !candidateDigest || !itemKey ||
      !Object.prototype.hasOwnProperty.call(authority.CLASSES, itemClass) ||
      !policyDigest || !eligibilityPass || !recipeId || !eligibility ||
      !exactKeys(value.threadRef, ["threadId"]) || !expectedThread ||
      value.threadRef.threadId !== expectedThread.threadId) return null;
  if (!exactKeys(value.scope,
    ["portfolioTaskId", "bindingRevision", "idempotencyKey", "mode"])) return null;
  var portfolioTaskId = text(value.scope.portfolioTaskId);
  var idempotencyKey = text(value.scope.idempotencyKey);
  if (!portfolioTaskId || !idempotencyKey || !Number.isInteger(value.scope.bindingRevision) ||
      value.scope.bindingRevision < 1 || value.scope.mode !== "project_coordinator") return null;
  var scopedPolicyGrant = null;
  if (isScopedPolicy) {
    scopedPolicyGrant = scopedAutonomy.normalizeGrant(value.scopedPolicyGrant);
    if (!scopedPolicyGrant || scopedPolicyGrant.projectRef.projectId !== projectRef.projectId) return null;
  }
  var normalized = {
    schema: SCHEMA,
    version: VERSION,
    kind: value.kind,
    source: { kind: SOURCE_KIND, recipeId: recipeId },
    projectRef: { projectId: projectRef.projectId },
    candidateKey: candidateKey,
    candidateDigest: candidateDigest,
    itemKey: itemKey,
    itemClass: itemClass,
    policyDigest: policyDigest,
    eligibilityPass: eligibilityPass,
    eligibility: eligibility,
    threadRef: expectedThread,
    scope: {
      portfolioTaskId: portfolioTaskId,
      bindingRevision: value.scope.bindingRevision,
      idempotencyKey: idempotencyKey,
      mode: "project_coordinator",
    },
  };
  if (scopedPolicyGrant) normalized.scopedPolicyGrant = scopedPolicyGrant;
  return normalized;
}

function createAuthorization(candidate, request, options) {
  var value = candidate || {};
  var scope = request || {};
  var opts = options || {};
  var kind = opts.kind === SCOPED_KIND ? SCOPED_KIND : KIND;
  var authorization = {
    schema: SCHEMA,
    version: VERSION,
    kind: kind,
    source: { kind: SOURCE_KIND, recipeId: value.recipeId },
    projectRef: value.projectRef,
    candidateKey: value.candidateKey,
    candidateDigest: value.digest,
    itemKey: value.itemKey,
    itemClass: value.itemClass,
    policyDigest: value.policyDigest,
    eligibilityPass: value.eligibilityPass,
    eligibility: value.eligibility,
    threadRef: identity.threadRefFor(value),
    scope: {
      portfolioTaskId: scope.portfolioTaskId,
      bindingRevision: scope.bindingRevision,
      idempotencyKey: scope.idempotencyKey,
      mode: scope.mode,
    },
  };
  if (kind === SCOPED_KIND) authorization.scopedPolicyGrant = opts.scopedPolicyGrant;
  return normalizeAuthorization(authorization);
}

function sameScope(value, request) {
  var target = projectIdentity.normalizeProjectRef(request && request.targetProject);
  return !!(target && value.projectRef.projectId === target.projectId &&
    value.scope.portfolioTaskId === request.portfolioTaskId &&
    value.scope.bindingRevision === request.bindingRevision &&
    value.scope.idempotencyKey === request.idempotencyKey &&
    value.scope.mode === request.mode);
}

function stableIdentity(value) {
  var normalized = normalizeAuthorization(value);
  if (!normalized) return null;
  var identityValue = {
    schema: normalized.schema,
    version: normalized.version,
    kind: normalized.kind,
    projectRef: normalized.projectRef,
    candidateKey: normalized.candidateKey,
    itemKey: normalized.itemKey,
    threadRef: normalized.threadRef,
    scope: normalized.scope,
  };
  if (normalized.scopedPolicyGrant) identityValue.scopedPolicyGrant = normalized.scopedPolicyGrant;
  return identityValue;
}

function sameIdentity(left, right) {
  var a = stableIdentity(left);
  var b = stableIdentity(right);
  return !!(a && b && JSON.stringify(a) === JSON.stringify(b));
}

function findCandidate(store, authorization) {
  var queue;
  try { queue = store.pending({ statuses: ["pending", "owner_approved"] }); }
  catch (error) { return { ok: false, reason: "automation_candidate_unavailable" }; }
  if (!queue || queue.ok !== true) {
    return { ok: false, reason: queue && queue.reason || "automation_candidate_unavailable" };
  }
  for (var i = 0; i < queue.candidates.length; i++) {
    var candidate = queue.candidates[i];
    if (candidate && candidate.candidateKey === authorization.candidateKey &&
        candidate.projectRef &&
        candidate.projectRef.projectId === authorization.projectRef.projectId) {
      return { ok: true, candidate: candidate };
    }
  }
  return { ok: false, reason: "automation_candidate_not_current" };
}

function createAuthorizationValidator(options) {
  var opts = options || {};
  var candidates = opts.candidates;
  var getLeadMode = opts.getLeadMode || function () { return false; };
  var scopedAutonomyPolicy = opts.scopedAutonomyPolicy || null;
  var loadPolicy = opts.loadPolicy || function (projectRef) {
    return policyModule.loadProjectAutomationPolicy({ cwd: opts.cwd, projectRef: projectRef });
  };
  var now = opts.now || Date.now;

  function validate(input) {
    var request = input && input.request || {};
    var normalized = normalizeAuthorization(input && input.authorization);
    if (!normalized) return { ok: false, reason: "automation_authorization_malformed" };
    var target = projectIdentity.normalizeProjectRef(request.targetProject);
    if (!target || normalized.projectRef.projectId !== target.projectId) {
      return { ok: false, reason: "automation_project_mismatch" };
    }
    if (!sameScope(normalized, request)) {
      return { ok: false, reason: "automation_scope_mismatch" };
    }
    if (getLeadMode() !== true) return { ok: false, reason: "lead_mode_off" };
    if (!candidates || typeof candidates.pending !== "function") {
      return { ok: false, reason: "automation_candidate_unavailable" };
    }
    var found = findCandidate(candidates, normalized);
    if (!found.ok) return found;
    var candidate = found.candidate;
    var expectedAdmission = normalized.kind === SCOPED_KIND ? "owner_approval" : "auto";
    if (candidate.admission !== expectedAdmission || candidate.status !== "pending") {
      return { ok: false, reason: "owner_approval_required" };
    }
    var candidateRef = candidate && exactKeys(candidate.projectRef, ["projectId"]) ?
      projectIdentity.normalizeProjectRef(candidate.projectRef) : null;
    if (!candidateRef || candidateRef.projectId !== target.projectId ||
        candidatesModule.contentDigest(candidate) !== candidate.digest ||
        !plainObject(candidate.intent) || candidate.intent.recipeId !== candidate.recipeId) {
      return { ok: false, reason: "automation_candidate_malformed" };
    }
    if (candidate.policyDigest !== normalized.policyDigest) {
      return { ok: false, reason: "automation_policy_stale" };
    }
    if (candidate.eligibilityPass !== normalized.eligibilityPass) {
      return { ok: false, reason: "automation_eligibility_stale" };
    }
    if (candidate.recipeId !== normalized.source.recipeId) {
      return { ok: false, reason: "automation_source_mismatch" };
    }
    if (candidate.digest !== normalized.candidateDigest ||
        candidate.itemKey !== normalized.itemKey ||
        candidate.itemClass !== normalized.itemClass ||
        JSON.stringify(candidate.eligibility || null) !==
          JSON.stringify(normalized.eligibility)) {
      return { ok: false, reason: "automation_candidate_mismatch" };
    }
    var loaded;
    try { loaded = loadPolicy(normalized.projectRef); }
    catch (error) { loaded = null; }
    if (!loaded || loaded.ok !== true || !loaded.policy) {
      return { ok: false, reason: loaded && loaded.reason || "automation_policy_unavailable" };
    }
    var policyRef = projectIdentity.normalizeProjectRef(loaded.policy.projectRef);
    if (!policyRef || policyRef.projectId !== target.projectId) {
      return { ok: false, reason: "automation_project_mismatch" };
    }
    if (loaded.policy.digest !== normalized.policyDigest) {
      return { ok: false, reason: "automation_policy_stale" };
    }
    if (normalized.kind === SCOPED_KIND) {
      if (!scopedAutonomyPolicy || typeof scopedAutonomyPolicy.decide !== "function") {
        return { ok: false, reason: "scoped_policy_unavailable" };
      }
      var scopedDecision;
      try { scopedDecision = scopedAutonomyPolicy.decide(candidate); }
      catch (error) { scopedDecision = null; }
      if (!scopedDecision || scopedDecision.ok !== true) {
        return { ok: false, reason: scopedDecision && scopedDecision.reason || "scoped_policy_unavailable" };
      }
      var currentGrant = scopedAutonomy.normalizeGrant(scopedDecision.grant);
      if (!currentGrant || !normalized.scopedPolicyGrant ||
          JSON.stringify(currentGrant) !== JSON.stringify(normalized.scopedPolicyGrant)) {
        return { ok: false, reason: "scoped_policy_stale" };
      }
      return { ok: true, authorization: normalized, candidate: candidate, policy: loaded.policy,
        scopedAutonomy: true };
    }
    var timestamp = now();
    var decision = authority.decideAutomation({
      leadMode: true,
      action: "launch",
      policy: loaded.policy,
      projectRef: normalized.projectRef,
      itemClass: normalized.itemClass,
      itemKey: normalized.itemKey,
      assignedToOwner: normalized.eligibility.assignedToOwner,
      recipeAllowsUnassigned: normalized.eligibility.recipeAllowsUnassigned,
      claim: { held: true, holder: "coop", expiresAt: timestamp + 1 },
      holder: "coop",
      now: timestamp,
    });
    if (decision.decision !== authority.EXECUTE || decision.reason !== "policy_autonomous") {
      return { ok: false, reason: "automation_policy_not_autonomous" };
    }
    return { ok: true, authorization: normalized, candidate: candidate, policy: loaded.policy };
  }

  return { validate: validate };
}

module.exports = {
  KIND: KIND,
  SCOPED_KIND: SCOPED_KIND,
  SCHEMA: SCHEMA,
  SOURCE_KIND: SOURCE_KIND,
  VERSION: VERSION,
  createAuthorization: createAuthorization,
  createAuthorizationValidator: createAuthorizationValidator,
  normalizeAuthorization: normalizeAuthorization,
  sameIdentity: sameIdentity,
  stableIdentity: stableIdentity,
};
