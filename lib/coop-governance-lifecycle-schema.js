// Pure validation for the append-only Governance Lifecycle ledger.

var projectIdentity = require("./project-identity");
var topicRef = require("./coop-topic-ref");

var HEX = /^[a-f0-9]{16,128}$/i;
var STAGES = { evidence_review: true, council: true };
var LEARNING_SCOPES = { workstream: true, project: true, coop: true, global: true };
var PROVENANCE_KINDS = { stage_run: true, plan_revision: true, owner_decision: true,
  verification: true, adoption: true, external_evidence: true };
var FIXED_ACTORS = {
  workstream: "coop", plan_revision: "coop", implementation_grant: "coop",
  implementation_admitted: "coop", adoption: "coop", learning_retraction: "coop",
  learning_content_purged: "coop", closed: "coop", owner_decision: "owner",
  execution_started: "project_coordinator", verification: "project_coordinator",
};

function text(value, limit) {
  var cleaned = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return limit ? cleaned.slice(0, limit) : cleaned;
}

function isId(value) {
  return /^[a-z0-9][a-z0-9._:-]{2,255}$/i.test(String(value || ""));
}

function normalWorkstream(value) {
  var source = value && typeof value === "object" ? value : {};
  var workstreamId = text(source.workstreamId, 256);
  var project = projectIdentity.normalizeProjectRef(source.targetProject);
  var topic = topicRef.normalizeTopicRefInput(source.topicRef);
  var task = text(source.portfolioTaskId, 512);
  if (!isId(workstreamId) || !project || !topic || !projectIdentity.isTaskId(task)) return null;
  return { workstreamId: workstreamId, targetProject: { projectId: project.projectId },
    topicRef: { topicId: topic.topicId }, portfolioTaskId: task };
}

function sameWorkstream(left, right) {
  return !!(left && right && left.workstreamId === right.workstreamId &&
    left.targetProject.projectId === right.targetProject.projectId &&
    left.topicRef.topicId === right.topicRef.topicId &&
    left.portfolioTaskId === right.portfolioTaskId);
}

function normalStage(value) {
  var source = value && typeof value === "object" ? value : {};
  var stageRunId = text(source.stageRunId, 256);
  var stage = text(source.stage, 64).toLowerCase();
  var evidenceDigest = text(source.evidenceDigest, 256).toLowerCase();
  if (!isId(stageRunId) || !STAGES[stage] || !evidenceDigest) return null;
  return { stageRunId: stageRunId, stage: stage, evidenceDigest: evidenceDigest,
    riskSelected: source.riskSelected === true };
}

function normalPlan(value) {
  var source = value && typeof value === "object" ? value : {};
  var revision = Number(source.planRevision);
  var planDigest = text(source.planDigest, 256).toLowerCase();
  var scopeDigest = text(source.scopeDigest, 256).toLowerCase();
  if (!Number.isSafeInteger(revision) || revision < 1 || !HEX.test(planDigest) || !scopeDigest) return null;
  return { planRevision: revision, planDigest: planDigest, scopeDigest: scopeDigest };
}

function normalDecision(value) {
  var source = value && typeof value === "object" ? value : {};
  var revision = Number(source.planRevision);
  var planDigest = text(source.planDigest, 256).toLowerCase();
  var decision = text(source.decision, 64).toLowerCase();
  var ownerIngressId = text(source.ownerIngressId, 512);
  if (!Number.isSafeInteger(revision) || revision < 1 || !HEX.test(planDigest) ||
      !({ approved: true, rejected: true, withdrawn: true })[decision] || !ownerIngressId) return null;
  return { planRevision: revision, planDigest: planDigest, decision: decision, ownerIngressId: ownerIngressId };
}

function normalGrant(value) {
  var source = value && typeof value === "object" ? value : {};
  var grantId = text(source.grantId, 256);
  var planRevision = Number(source.planRevision);
  var planDigest = text(source.planDigest, 256).toLowerCase();
  var task = text(source.portfolioTaskId, 512);
  var bindingRevision = Number(source.bindingRevision);
  var idempotencyKey = text(source.idempotencyKey, 512);
  var project = projectIdentity.normalizeProjectRef(source.targetProject);
  if (!isId(grantId) || !Number.isSafeInteger(planRevision) || planRevision < 1 ||
      !HEX.test(planDigest) || !projectIdentity.isTaskId(task) ||
      !Number.isSafeInteger(bindingRevision) || bindingRevision < 1 || !idempotencyKey || !project) return null;
  return { grantId: grantId, planRevision: planRevision, planDigest: planDigest,
    portfolioTaskId: task, bindingRevision: bindingRevision, idempotencyKey: idempotencyKey,
    targetProject: { projectId: project.projectId } };
}

function normalAdoption(value) {
  var source = value && typeof value === "object" ? value : {};
  var grantId = text(source.grantId, 256);
  var bindingRevision = Number(source.bindingRevision);
  var snapshotDigest = text(source.snapshotDigest, 256);
  var recoveryRef = text(source.recoveryRef, 512);
  var ref = projectIdentity.normalizeSessionRef(source.sessionRef);
  if (!isId(grantId) || !Number.isSafeInteger(bindingRevision) || bindingRevision < 1 || !ref) return null;
  return { grantId: grantId, bindingRevision: bindingRevision, snapshotDigest: snapshotDigest,
    recoveryRef: recoveryRef, sessionRef: ref };
}

function normalExecution(value, needsEvidence) {
  var source = value && typeof value === "object" ? value : {};
  var grantId = text(source.grantId, 256);
  var bindingRevision = Number(source.bindingRevision);
  var evidenceDigest = text(source.evidenceDigest, 256).toLowerCase();
  if (!isId(grantId) || !Number.isSafeInteger(bindingRevision) || bindingRevision < 1 ||
      (needsEvidence && !evidenceDigest)) return null;
  var result = { grantId: grantId, bindingRevision: bindingRevision };
  if (needsEvidence) result.evidenceDigest = evidenceDigest;
  return result;
}

function normalLearning(value) {
  var source = value && typeof value === "object" ? value : {};
  var learningId = text(source.learningId, 256);
  var version = Number(source.version);
  var supersedesVersion = Number(source.supersedesVersion || 0);
  var scope = text(source.scope, 64).toLowerCase();
  var confidence = Number(source.confidence);
  var expiresAt = Number(source.expiresAt);
  var content = String(source.content == null ? "" : source.content).slice(0, 100000);
  var provenance = normalProvenance(source.provenance);
  if (!validLearningIdentity(learningId, version, supersedesVersion, provenance) ||
      !validLearningMetadata(scope, confidence, expiresAt, content)) return null;
  return { learningId: learningId, version: version, supersedesVersion: supersedesVersion,
    scope: scope, confidence: confidence, expiresAt: expiresAt, provenance: provenance,
    content: content, normative: source.normative === true,
    ownerDecisionRef: text(source.ownerDecisionRef, 256) || null };
}

function validLearningIdentity(learningId, version, supersedesVersion, provenance) {
  return isId(learningId) && Number.isSafeInteger(version) && version >= 1 &&
    Number.isSafeInteger(supersedesVersion) && supersedesVersion >= 0 && !!provenance;
}

function validLearningMetadata(scope, confidence, expiresAt, content) {
  return !!LEARNING_SCOPES[scope] && Number.isFinite(confidence) && confidence >= 0 &&
    confidence <= 1 && Number.isFinite(expiresAt) && expiresAt > 0 && !!content;
}

function normalProvenance(value) {
  var source = Array.isArray(value) ? value : [];
  if (!source.length || source.length > 20) return null;
  var result = [];
  for (var i = 0; i < source.length; i++) {
    var entry = source[i] && typeof source[i] === "object" ? source[i] : {};
    var kind = text(entry.kind, 64).toLowerCase();
    var id = text(entry.id, 512);
    if (!PROVENANCE_KINDS[kind] || !isId(id)) return null;
    result.push({ kind: kind, id: id });
  }
  return result;
}

function normalRetraction(source) {
  return { learningRetraction: {
    learningId: text(source.learningRetraction && source.learningRetraction.learningId, 256),
    reason: text(source.learningRetraction && source.learningRetraction.reason, 1000),
  } };
}

function normalPurge(source) {
  return { learningPurge: {
    learningId: text(source.learningPurge && source.learningPurge.learningId, 256),
  } };
}

var PAYLOAD_NORMALIZERS = {
  stage_run: function (source) { return { stageRun: normalStage(source.stageRun) }; },
  plan_revision: function (source) { return { planRevision: normalPlan(source.planRevision) }; },
  owner_decision: function (source) { return { ownerDecision: normalDecision(source.ownerDecision) }; },
  implementation_grant: function (source) { return { implementationGrant: normalGrant(source.implementationGrant) }; },
  implementation_admitted: function (source) { return { implementationAdmission: normalExecution(source.implementationAdmission, false) }; },
  execution_started: function (source) { return { execution: normalExecution(source.execution, false) }; },
  verification: function (source) { return { execution: normalExecution(source.verification || source.execution, true) }; },
  adoption: function (source) { return { adoption: normalAdoption(source.adoption) }; },
  learning: function (source) { return { learning: normalLearning(source.learning) }; },
  learning_retraction: normalRetraction,
  learning_content_purged: normalPurge,
  workstream: function () { return {}; },
  closed: function () { return {}; },
};

function normalizedPayload(type, source) {
  var normalize = PAYLOAD_NORMALIZERS[type];
  return normalize ? normalize(source) : null;
}

function validPayload(type, payload) {
  if (!payload) return false;
  if (type === "learning_retraction") return isId(payload.learningRetraction.learningId) && !!payload.learningRetraction.reason;
  if (type === "learning_content_purged") return isId(payload.learningPurge.learningId);
  var keys = Object.keys(payload);
  return !keys.length || !!payload[keys[0]];
}

function normalizeRecord(input, sequence, now, contentPath, digest) {
  var source = input && typeof input === "object" ? input : {};
  var type = text(source.type, 64);
  var actor = text(source.actor, 64);
  var workstream = normalWorkstream(source.workstream);
  var recordId = text(source.recordId, 256);
  if (!isId(recordId) || !workstream || !type || !actor) return null;
  var payload = normalizedPayload(type, source);
  if (!validPayload(type, payload)) return null;
  var record = { schema: "clay.governance_lifecycle", version: 1, sequence: sequence, recordId: recordId,
    type: type, actor: actor, at: Number(source.at) || now(), workstream: workstream };
  Object.assign(record, payload);
  if (record.learning) {
    record.learning.contentRef = contentPath(record.learning.learningId);
    record.learning.contentDigest = digest(record.learning.content);
    delete record.learning.content;
  }
  return record;
}

function actorAllowed(type, actor, record) {
  if (type === "stage_run") return record.stageRun.stage === "evidence_review"
    ? actor === "triage" || actor === "evidence_review" : actor === "council";
  if (type === "learning") return !!({ evidence_review: true, triage: true, council: true, coop: true })[actor];
  return actor === FIXED_ACTORS[type];
}

function validStage(state, record) {
  var stage = record.stageRun;
  var councilAfterEvidence = stage.stage === "council" && state.phase === "evidence_review";
  if (state.phase !== "intake" && !councilAfterEvidence) return "invalid_stage_transition";
  if (stage.stage === "council" && !stage.riskSelected) return "council_not_risk_selected";
  if (stage.stage === "council" && !state.stages.evidence_review) return "evidence_review_required";
  return state.stages[stage.stage] ? "stage_already_recorded" : null;
}

function validPlan(state, record) {
  if (!state.stages.evidence_review) return "evidence_review_required";
  if (state.stages.evidence_review.riskSelected && !state.stages.council) return "council_required";
  if (state.latestPlan && record.planRevision.planRevision !== state.latestPlan.planRevision + 1) return "plan_revision_not_next";
  return !state.latestPlan && record.planRevision.planRevision !== 1 ? "plan_revision_not_initial" : null;
}

function validDecision(state, record) {
  if (!state.latestPlan || state.ownerDecision) return "owner_decision_unavailable";
  if (record.ownerDecision.planRevision !== state.latestPlan.planRevision ||
      record.ownerDecision.planDigest !== state.latestPlan.planDigest) return "stale_plan_digest";
  return null;
}

function validGrant(state, record) {
  var grant = record.implementationGrant;
  if (!state.ownerDecision || state.ownerDecision.decision !== "approved") return "owner_approval_required";
  if (grant.planRevision !== state.latestPlan.planRevision || grant.planDigest !== state.latestPlan.planDigest) return "stale_plan_digest";
  if (grant.portfolioTaskId !== state.workstream.portfolioTaskId ||
      grant.targetProject.projectId !== state.workstream.targetProject.projectId) return "grant_workstream_mismatch";
  return state.grants[grant.grantId] ? "grant_exists" : null;
}

function validExecution(state, record) {
  var execution = record.execution || record.implementationAdmission;
  var grant = state.grants[execution.grantId];
  if (!grant) return "grant_not_found";
  if (Number(execution.bindingRevision) !== grant.bindingRevision) return "grant_scope_mismatch";
  if (record.type === "implementation_admitted") return state.admissions[execution.grantId] ? "execution_already_admitted" : null;
  if (record.type === "execution_started") return state.admissions[execution.grantId] ? null : "execution_not_admitted";
  return state.executions[execution.grantId] ? null : "execution_not_started";
}

function validAdoption(state, record) {
  var adoption = record.adoption;
  var grant = state.grants[adoption.grantId];
  if (!grant) return "grant_not_found";
  if (!adoption.snapshotDigest || !adoption.recoveryRef) return "adoption_snapshot_required";
  if (adoption.bindingRevision !== grant.bindingRevision) return "grant_scope_mismatch";
  if (adoption.sessionRef.projectId !== state.workstream.targetProject.projectId) return "adoption_workstream_mismatch";
  return state.adoptions[adoption.grantId + ":" + adoption.bindingRevision] ? "adoption_exists" : null;
}

function validLearning(state, record) {
  var learning = record.learning;
  var previous = state.learning[learning.learningId];
  if (!previous && (learning.version !== 1 || learning.supersedesVersion !== 0)) return "learning_version_invalid";
  if (previous && (learning.version !== previous.version + 1 || learning.supersedesVersion !== previous.version)) {
    return "learning_version_invalid";
  }
  if (!learning.normative) return null;
  var promotion = state.records[learning.ownerDecisionRef];
  if (!promotion || promotion.type !== "owner_decision" || promotion.actor !== "owner" ||
      promotion.ownerDecision.decision !== "approved") return "learning_promotion_required";
  return null;
}

function validRetraction(state, record) {
  return state.learning[record.learningRetraction.learningId] ? null : "learning_not_found";
}

function validPurge(state, record) {
  var learning = state.learning[record.learningPurge.learningId];
  return learning && learning.retractedAt && !learning.tombstone ? null : "learning_not_purgeable";
}

function validClosed(state) {
  return state.phase === "verified" ? null : "verification_required";
}

var VALIDATORS = {
  stage_run: validStage, plan_revision: validPlan, owner_decision: validDecision,
  implementation_grant: validGrant, implementation_admitted: validExecution,
  execution_started: validExecution, verification: validExecution, adoption: validAdoption,
  learning: validLearning, learning_retraction: validRetraction,
  learning_content_purged: validPurge, closed: validClosed,
};

function validRecord(state, record) {
  if (record.type === "workstream") return state.workstream ? "workstream_exists" : null;
  if (!state.workstream || !sameWorkstream(state.workstream, record.workstream)) return "workstream_mismatch";
  var validate = VALIDATORS[record.type];
  return validate ? validate(state, record) : "unknown_record_type";
}

module.exports = { actorAllowed: actorAllowed, isId: isId, normalizeRecord: normalizeRecord,
  normalWorkstream: normalWorkstream, validRecord: validRecord };
