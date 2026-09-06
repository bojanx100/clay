// Strict, reference-only evidence for an owner-requested reconsideration of
// already completed automated work. The candidate store keeps the full repair
// record; execution carries only the fields the duplicate-work boundary needs.

var projectIdentity = require("./project-identity");

var SCHEMA = "clay.automation_candidate_reconsideration";
var VERSION = 1;
var OWNER_REASON = "owner_requested_bounce_reconsideration";
var MAX_REF_COUNT = 32;
var MAX_TEXT = 256;

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

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function completionProof(value) {
  if (!plainObject(value)) return null;
  var historical = value.kind === "completed_historical_binding";
  var exact = historical ? ["kind", "portfolioTaskId", "bindingRevision", "targetProject",
    "completedAt", "resultEventId", "completionEventId"] :
    ["kind", "portfolioTaskId", "bindingRevision", "targetProject", "completedAt",
      "resultEventId", "completionEventId", "coordinator", "projectCoordinator"];
  if ((value.kind !== "completed_binding" && !historical) || !exactKeys(value, exact)) return null;
  var portfolioTaskId = text(value.portfolioTaskId);
  var targetProject = projectIdentity.normalizeProjectRef(value.targetProject);
  var completedAt = positiveNumber(value.completedAt);
  var resultEventId = text(value.resultEventId);
  var completionEventId = text(value.completionEventId);
  if (!portfolioTaskId || !projectIdentity.isTaskId(portfolioTaskId) ||
      !Number.isSafeInteger(value.bindingRevision) || value.bindingRevision < 1 ||
      !targetProject || !completedAt || !resultEventId || !completionEventId) return null;
  var proof = {
    kind: value.kind,
    portfolioTaskId: portfolioTaskId,
    bindingRevision: value.bindingRevision,
    targetProject: targetProject,
    completedAt: completedAt,
    resultEventId: resultEventId,
    completionEventId: completionEventId,
  };
  if (!historical) {
    var coordinator = projectIdentity.normalizeSessionRef(value.coordinator);
    var projectCoordinator = projectIdentity.normalizeSessionRef(value.projectCoordinator);
    if (!coordinator || !projectCoordinator) return null;
    proof.coordinator = coordinator;
    proof.projectCoordinator = projectCoordinator;
  }
  return proof;
}

function normalize(value) {
  if (!exactKeys(value, ["schema", "version", "reason", "ownerRequestRefs", "requestedAt",
    "currentQualificationRequired", "verifiedNoLiveSession", "completionProof"]) ||
      value.schema !== SCHEMA || value.version !== VERSION || value.reason !== OWNER_REASON ||
      value.currentQualificationRequired !== true || value.verifiedNoLiveSession !== true ||
      !Array.isArray(value.ownerRequestRefs) || !value.ownerRequestRefs.length ||
      value.ownerRequestRefs.length > MAX_REF_COUNT) return null;
  var refs = [];
  var seen = {};
  for (var i = 0; i < value.ownerRequestRefs.length; i++) {
    var ref = text(value.ownerRequestRefs[i]);
    if (!ref || seen[ref]) return null;
    seen[ref] = true;
    refs.push(ref);
  }
  var requestedAt = positiveNumber(value.requestedAt);
  var proof = completionProof(value.completionProof);
  if (!requestedAt || !proof) return null;
  return {
    schema: SCHEMA,
    version: VERSION,
    reason: OWNER_REASON,
    ownerRequestRefs: refs,
    requestedAt: requestedAt,
    currentQualificationRequired: true,
    verifiedNoLiveSession: true,
    completionProof: proof,
  };
}

function fromCandidate(value) {
  if (!plainObject(value)) return null;
  return normalize({
    schema: value.schema,
    version: value.version,
    reason: value.reason,
    ownerRequestRefs: value.ownerRequestRefs,
    requestedAt: value.requestedAt,
    currentQualificationRequired: value.currentQualificationRequired,
    verifiedNoLiveSession: value.verifiedNoLiveSession,
    completionProof: value.completionProof,
  });
}

function sameSessionRef(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId;
}

// This is deliberately exact. A valid owner reconsideration can reopen only
// the completed binding it named; all other completed aliases keep blocking.
function matchesCompletedBinding(value, binding) {
  var receipt = normalize(value);
  var proof = receipt && receipt.completionProof;
  if (!proof || !binding || binding.status !== "completed" ||
      binding.portfolioTaskId !== proof.portfolioTaskId ||
      binding.bindingRevision !== proof.bindingRevision ||
      !binding.targetProject || binding.targetProject.projectId !== proof.targetProject.projectId ||
      binding.completedAt !== proof.completedAt || binding.resultEventId !== proof.resultEventId ||
      binding.completionEventId !== proof.completionEventId) return false;
  if (proof.kind === "completed_binding" &&
      (!sameSessionRef(binding.coordinator, proof.coordinator) ||
      !sameSessionRef(binding.projectCoordinator, proof.projectCoordinator))) return false;
  return true;
}

module.exports = {
  SCHEMA: SCHEMA,
  VERSION: VERSION,
  fromCandidate: fromCandidate,
  matchesCompletedBinding: matchesCompletedBinding,
  normalize: normalize,
};
