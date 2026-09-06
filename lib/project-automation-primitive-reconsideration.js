// Explicit owner reconsideration for an exact primitive that already launched.
// This receipt cannot authorize a provider launch or change prior acceptance.
var crypto = require("crypto");
var identity = require("./project-identity");
var workIdentity = require("./work-identity");
var launchEvidence = require("./project-primitive-launch-evidence");
var repairEvidence = require("./project-automation-bookkeeping-evidence");
var reconciliation = require("./project-automation-candidate-reconciliation");
var SCHEMA = "clay.automation_primitive_reconsideration";
var REQUEST_SCHEMA = "clay.owner_requested_primitive_reconsideration";
var SETTLED = { completed: true, failed: true, superseded: true, cancelled: true, unrouted: true };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  var result = {};
  Object.keys(value).sort().forEach(function (key) { result[key] = canonical(value[key]); });
  return result;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
}

function normalize(value) {
  if (!exactKeys(value, ["schema", "version", "ownerRequestRefs", "requestedAt",
    "currentQualificationRequired", "primitiveLaunch", "priorBindings"]) ||
    value.schema !== SCHEMA || value.version !== 1 || value.currentQualificationRequired !== true ||
    !Number.isSafeInteger(value.requestedAt) || value.requestedAt <= 0 ||
    !Array.isArray(value.ownerRequestRefs) || !value.ownerRequestRefs.length ||
    value.ownerRequestRefs.length > 32 || value.ownerRequestRefs.some(function (ref) {
      return typeof ref !== "string" || !ref.trim() || ref.length > 256;
    }) || new Set(value.ownerRequestRefs).size !== value.ownerRequestRefs.length) return null;
  var launch = launchEvidence.normalizeProof(value.primitiveLaunch);
  if (!launch || launch.createdAt < value.requestedAt || !Array.isArray(value.priorBindings) ||
      !value.priorBindings.length || value.priorBindings.length > 32) return null;
  var seen = {};
  for (var i = 0; i < value.priorBindings.length; i++) {
    var prior = value.priorBindings[i];
    if (!exactKeys(prior, ["portfolioTaskId", "bindingRevision", "status", "digest"]) ||
        !identity.isTaskId(prior.portfolioTaskId) || !Number.isSafeInteger(prior.bindingRevision) ||
        prior.bindingRevision < 1 || !SETTLED[prior.status] || !/^[a-f0-9]{64}$/.test(prior.digest)) return null;
    var key = prior.portfolioTaskId + ":" + prior.bindingRevision;
    if (seen[key]) return null;
    seen[key] = true;
  }
  return JSON.parse(JSON.stringify(value));
}

function settledEvidence(binding, requestedAt) {
  if (!SETTLED[binding.status]) return false;
  if (binding.status === "completed" || binding.status === "failed") {
    return Number.isSafeInteger(binding.completedAt) && binding.completedAt > 0 &&
      binding.completedAt <= requestedAt && !!binding.resultEventId && !!binding.completionEventId;
  }
  if (binding.ownerAcceptanceRequired === true) {
    return Number.isSafeInteger(binding.implementationCompletedAt) &&
      binding.implementationCompletedAt > 0 && binding.implementationCompletedAt <= requestedAt &&
      Number.isSafeInteger(binding.implementationCompletionRevision) &&
      typeof binding.implementationGraphDigest === "string" && !!binding.implementationGraphDigest;
  }
  return Number.isSafeInteger(binding.updatedAt) && binding.updatedAt <= requestedAt;
}

function matchesBinding(value, binding) {
  var receipt = normalize(value);
  if (!receipt || !binding || !settledEvidence(binding, receipt.requestedAt) ||
      !binding.targetProject || binding.targetProject.projectId !== receipt.primitiveLaunch.sessionRef.projectId ||
      workIdentity.normalizeWorkIdentity(binding.workIdentity || binding.portfolioTaskId) !==
        workIdentity.normalizeWorkIdentity(receipt.primitiveLaunch.itemKey)) return false;
  return receipt.priorBindings.some(function (prior) {
    return prior.portfolioTaskId === binding.portfolioTaskId &&
      prior.bindingRevision === binding.bindingRevision && prior.status === binding.status &&
      prior.digest === digest(binding);
  });
}

function prepare(existing, evidence, options, now) {
  var opts = options || {};
  var requested = evidence || {};
  var snapshot = requested.sessionSnapshot;
  var ref = identity.normalizeSessionRef(requested.primitiveSessionRef);
  var legacy = existing && existing.status === "legacy_running" &&
    existing.admission === "legacy" && existing.legacyAdoption && ref &&
    existing.legacyAdoption.sessionStorageId === ref.sessionStorageId &&
    existing.intent && existing.intent.sessionStorageId === ref.sessionStorageId;
  if (requested.schema !== REQUEST_SCHEMA || requested.version !== 1 ||
      requested.currentQualificationRequired !== true || !ref || !existing ||
      (existing.status !== "pending" && !legacy) || existing.ownerDecision ||
      !existing.intent || (!legacy && existing.intent.primitiveLaunch !== true) ||
      ref.projectId !== existing.projectRef.projectId || !snapshot ||
      !snapshot.projectRef || snapshot.projectRef.projectId !== ref.projectId ||
      !Array.isArray(snapshot.sessions)) return { ok: false, reason: "primitive_reconsideration_invalid" };
  var matches = snapshot.sessions.filter(function (session) {
    return identity.sessionStorageId(session) === ref.sessionStorageId;
  });
  if (matches.length !== 1 || matches[0].orchestrationPolicy || matches[0].coopControlledBy) {
    return { ok: false, reason: "primitive_reconsideration_session_conflict" };
  }
  var verified = launchEvidence.verifyProof(opts.primitiveLaunchProof, {
    session: matches[0], projectRef: existing.projectRef, itemKey: existing.itemKey, now: now,
  });
  if (!verified.ok) return verified;
  var live = repairEvidence.noLiveSession(existing, { sessionSnapshot: {
    projectRef: snapshot.projectRef, sessions: snapshot.sessions.filter(function (session) {
      return session !== matches[0];
    }),
  } }, opts.projectSlug);
  if (!live.ok) return live;
  var history = reconciliation.verifiedSnapshot(opts.bindingSnapshot);
  if (!history.ok) return history;
  var priors = history.bindings.filter(function (binding) {
    return repairEvidence.matchesWork(binding, existing, opts.projectSlug);
  });
  if (existing.binding && !priors.some(function (binding) {
    return binding.portfolioTaskId === existing.binding.portfolioTaskId &&
      binding.bindingRevision === existing.binding.bindingRevision;
  })) return { ok: false, reason: "primitive_reconsideration_history_missing" };
  if (!priors.length || priors.some(function (binding) {
    return binding.targetProject.projectId !== ref.projectId ||
      !settledEvidence(binding, requested.requestedAt);
  })) return { ok: false, reason: "primitive_reconsideration_history_conflict" };
  var receipt = normalize({ schema: SCHEMA, version: 1,
    ownerRequestRefs: requested.ownerRequestRefs, requestedAt: requested.requestedAt,
    currentQualificationRequired: true, primitiveLaunch: verified.proof,
    priorBindings: priors.map(function (binding) {
      return { portfolioTaskId: binding.portfolioTaskId, bindingRevision: binding.bindingRevision,
        status: binding.status, digest: digest(binding) };
    }),
  });
  if (!receipt || requested.requestedAt > now) return { ok: false, reason: "primitive_reconsideration_invalid" };
  if (digest(existing.reconsideration || null) === digest(receipt)) {
    return { ok: true, changed: false, candidate: existing };
  }
  var updated = Object.assign({}, existing, { reconsideration: receipt,
    eligibilityPass: null, qualificationReceipt: null, lastSeenAt: now });
  if (legacy) {
    // Recover a startup migration only through the same immutable launch and
    // history checks above. Fresh discovery must still supply all authority.
    updated.status = "pending";
    updated.intent = Object.assign({}, existing.intent, { primitiveLaunch: true });
    delete updated.legacyAdoption;
    updated.digest = require("./project-automation-candidate-record").contentDigest(updated);
  }
  delete updated.attention;
  return { ok: true, changed: true, before: existing, candidate: updated };
}

module.exports = { SCHEMA: SCHEMA, REQUEST_SCHEMA: REQUEST_SCHEMA,
  normalize: normalize, prepare: prepare, matchesBinding: matchesBinding };
