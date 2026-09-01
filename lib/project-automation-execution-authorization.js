// Typed, reference-only authority for autonomous project-policy execution.
// This is deliberately separate from owner implementation admission: it proves
// the current project candidate and policy, and never invents an owner ingress.

var authority = require("./project-automation-authority");
var candidatesModule = require("./project-automation-candidates");
var identity = require("./project-automation-identity");
var policyModule = require("./project-automation-policy");
var projectIdentity = require("./project-identity");
var scopedAutonomy = require("./coop-scoped-autonomy-policy");
var autoApproval = require("./coop-auto-approval-policy");
var qualification = require("./project-automation-qualification");

var SCHEMA = "clay.project_automation_execution_authorization";
var VERSION = 2;
var LEGACY_VERSION = 1;
var KIND = "project_policy_autonomous";
var SCOPED_KIND = "coop_scoped_low_risk";
var AUTO_APPROVAL_KIND = "coop_project_auto_approval";
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

function normalizeQualifiedLaunchReport(value, receipt) {
  if (!exactKeys(value, ["schema", "version", "verdict", "receiptDigest", "reasons"]) ||
      value.schema !== "clay.project_automation_qualified_launch" || value.version !== 1 ||
      value.verdict !== "qualified_and_launched" || !receipt ||
      value.receiptDigest !== receipt.digest || !Array.isArray(value.reasons) ||
      JSON.stringify(value.reasons) !== JSON.stringify(receipt.coordinator.reasons)) return null;
  return {
    schema: "clay.project_automation_qualified_launch",
    version: 1,
    verdict: "qualified_and_launched",
    receiptDigest: receipt.digest,
    reasons: receipt.coordinator.reasons.slice(),
  };
}

function qualifiedLaunchReport(receipt) {
  return {
    schema: "clay.project_automation_qualified_launch",
    version: 1,
    verdict: "qualified_and_launched",
    receiptDigest: receipt && receipt.digest,
    reasons: receipt && receipt.coordinator && receipt.coordinator.reasons,
  };
}

function normalizeAuthorization(value) {
  var commonKeys = ["schema", "version", "kind", "source", "projectRef",
    "candidateKey", "candidateDigest", "itemKey", "itemClass", "policyDigest",
    "eligibilityPass", "eligibility", "threadRef", "scope"];
  var isProjectPolicy = value && value.kind === KIND;
  var isScopedPolicy = value && value.kind === SCOPED_KIND;
  var isAutoApproval = value && value.kind === AUTO_APPROVAL_KIND;
  if (!isProjectPolicy && !isScopedPolicy && !isAutoApproval) return null;
  var isLegacy = value && value.version === LEGACY_VERSION;
  var isCurrent = value && value.version === VERSION;
  if (!isLegacy && !isCurrent) return null;
  if (isScopedPolicy) commonKeys.push("scopedPolicyGrant");
  if (isAutoApproval) commonKeys.push("autoApprovalGrant");
  if (isCurrent) commonKeys.push("qualificationReceipt", "qualifiedLaunchReport");
  if (!exactKeys(value, commonKeys) || value.schema !== SCHEMA) return null;
  var sourceKeys = isCurrent ? ["kind", "recipeId", "workKind"] : ["kind", "recipeId"];
  if (!exactKeys(value.source, sourceKeys) ||
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
  var workKind = isCurrent ? text(value.source.workKind) : "legacy";
  if (isCurrent && ["issue", "pr_review"].indexOf(workKind) === -1) return null;
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
  var autoApprovalGrant = null;
  if (isAutoApproval) {
    autoApprovalGrant = autoApproval.normalizeGrant(value.autoApprovalGrant);
    if (!autoApprovalGrant || autoApprovalGrant.projectRef.projectId !== projectRef.projectId) return null;
  }
  var qualificationReceipt = null;
  var qualifiedLaunchReport = null;
  if (isCurrent && workKind === "issue") {
    qualificationReceipt = qualification.normalizeReceipt(value.qualificationReceipt);
    qualifiedLaunchReport = normalizeQualifiedLaunchReport(value.qualifiedLaunchReport,
      qualificationReceipt);
    if (!qualificationReceipt || !qualifiedLaunchReport) return null;
  } else if (isCurrent && (value.qualificationReceipt !== null || value.qualifiedLaunchReport !== null)) {
    return null;
  }
  var normalized = {
    schema: SCHEMA,
    version: isLegacy ? LEGACY_VERSION : VERSION,
    kind: value.kind,
    source: isCurrent ? { kind: SOURCE_KIND, recipeId: recipeId, workKind: workKind } :
      { kind: SOURCE_KIND, recipeId: recipeId },
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
  if (autoApprovalGrant) normalized.autoApprovalGrant = autoApprovalGrant;
  if (isCurrent) {
    normalized.qualificationReceipt = qualificationReceipt;
    normalized.qualifiedLaunchReport = qualifiedLaunchReport;
  }
  return normalized;
}

function createAuthorization(candidate, request, options) {
  var value = candidate || {};
  var scope = request || {};
  var opts = options || {};
  var kind = opts.kind === SCOPED_KIND ? SCOPED_KIND :
    (opts.kind === AUTO_APPROVAL_KIND ? AUTO_APPROVAL_KIND : KIND);
  var workKind = value.intent && value.intent.autoKind === "pr-review" ? "pr_review" : "issue";
  var authorization = {
    schema: SCHEMA,
    version: VERSION,
    kind: kind,
    source: { kind: SOURCE_KIND, recipeId: value.recipeId, workKind: workKind },
    projectRef: value.projectRef,
    candidateKey: value.candidateKey,
    candidateDigest: value.digest,
    itemKey: value.itemKey,
    itemClass: value.itemClass,
    policyDigest: value.policyDigest,
    eligibilityPass: value.eligibilityPass,
    eligibility: value.eligibility,
    qualificationReceipt: workKind === "issue" ? value.qualificationReceipt : null,
    qualifiedLaunchReport: workKind === "issue" ?
      qualifiedLaunchReport(value.qualificationReceipt) : null,
    threadRef: identity.threadRefFor(value),
    scope: {
      portfolioTaskId: scope.portfolioTaskId,
      bindingRevision: scope.bindingRevision,
      idempotencyKey: scope.idempotencyKey,
      mode: scope.mode,
    },
  };
  if (kind === SCOPED_KIND) authorization.scopedPolicyGrant = opts.scopedPolicyGrant;
  if (kind === AUTO_APPROVAL_KIND) authorization.autoApprovalGrant = opts.autoApprovalGrant;
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
  if (normalized.version === VERSION) {
    identityValue.source = normalized.source;
    identityValue.qualificationReceipt = qualification.stableReceiptIdentity(
      normalized.qualificationReceipt);
  }
  if (normalized.scopedPolicyGrant) identityValue.scopedPolicyGrant = normalized.scopedPolicyGrant;
  if (normalized.autoApprovalGrant) identityValue.autoApprovalGrant = normalized.autoApprovalGrant;
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
  var autoApprovalPolicy = opts.autoApprovalPolicy || null;
  var loadPolicy = opts.loadPolicy || function (projectRef) {
    return policyModule.loadProjectAutomationPolicy({ cwd: opts.cwd, projectRef: projectRef });
  };
  var now = opts.now || Date.now;

  function validate(input) {
    var request = input && input.request || {};
    var normalized = normalizeAuthorization(input && input.authorization);
    if (!normalized) return { ok: false, reason: "automation_authorization_malformed" };
    if (normalized.version !== VERSION) {
      return { ok: false, reason: "qualification_receipt_required" };
    }
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
    var expectedAdmission = (normalized.kind === SCOPED_KIND || normalized.kind === AUTO_APPROVAL_KIND) ?
      "owner_approval" : "auto";
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
        (candidate.intent && candidate.intent.autoKind === "pr-review" ? "pr_review" : "issue") !==
          normalized.source.workKind ||
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
    if (normalized.source.workKind === "issue") {
      var qualified = qualification.verifyReceipt(normalized.qualificationReceipt, {
        candidate: candidate,
        policy: loaded.policy,
        now: now(),
      });
      if (!qualified.ok) return qualified;
      if (!normalized.qualifiedLaunchReport ||
          normalized.qualifiedLaunchReport.receiptDigest !== qualified.receipt.digest) {
        return { ok: false, reason: "qualified_launch_report_mismatch" };
      }
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
    if (normalized.kind === AUTO_APPROVAL_KIND) {
      if (!autoApprovalPolicy || typeof autoApprovalPolicy.validateGrant !== "function") {
        return { ok: false, reason: "auto_approval_unavailable" };
      }
      var autoApprovalResult;
      try { autoApprovalResult = autoApprovalPolicy.validateGrant(candidate, normalized.autoApprovalGrant); }
      catch (error) { autoApprovalResult = null; }
      if (!autoApprovalResult || autoApprovalResult.ok !== true) {
        return { ok: false, reason: autoApprovalResult && autoApprovalResult.reason || "auto_approval_unavailable" };
      }
      return { ok: true, authorization: normalized, candidate: candidate, policy: loaded.policy,
        autoApproval: true };
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
  AUTO_APPROVAL_KIND: AUTO_APPROVAL_KIND,
  SCHEMA: SCHEMA,
  SOURCE_KIND: SOURCE_KIND,
  VERSION: VERSION,
  LEGACY_VERSION: LEGACY_VERSION,
  createAuthorization: createAuthorization,
  createAuthorizationValidator: createAuthorizationValidator,
  normalizeAuthorization: normalizeAuthorization,
  sameIdentity: sameIdentity,
  stableIdentity: stableIdentity,
};
