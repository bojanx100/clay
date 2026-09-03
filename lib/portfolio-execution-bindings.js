// Durable portfolio-to-project execution references.
//
// This store is deliberately smaller than the project task graph. It owns
// only idempotency, binding revisions, stable refs, and tombstone state; the
// target project's session manager remains the execution authority.
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");
var bindingLineage = require("./portfolio-execution-binding-lineage");
var acceptanceEvents = require("./coop-owner-acceptance-events");
var createBindingCompletionApi = require("./portfolio-execution-binding-completion").createBindingCompletionApi;
var restartSupersession = require("./coop-restart-supersession");
var controlRole = require("./coop-control-role");
// The leaf normalizer, NOT orchestration-task-graph. This store owns idempotency
// and tombstones; making it depend on the orchestration graph to validate a
// two-field object dragged coop-work-activity and the entire topic subsystem into
// a low-level persistence layer.
var normalizeTopicRefInput = require("./coop-topic-ref").normalizeTopicRefInput;
var automationAuthorization = require("./project-automation-execution-authorization");

var MAX_TOPIC_ID = 128;
// The identity of the WORK, as opposed to portfolioTaskId which identifies only
// one attempt at it. Callers already carried this (the Lead backlog calls it
// candidateKey); it was simply never persisted, so the store could not tell that
// two differently-named bindings described the same job.
var workIdentity = require("./work-identity");
var normalizeWorkIdentity = workIdentity.normalizeWorkIdentity;

var SCHEMA = "clay.portfolio_execution_bindings";
var SCHEMA_VERSION = 2;
var CONTROL_PLANE_PROVENANCE_SCHEMA = "clay.coop_control_plane_reservation";
var CONTROL_PLANE_PROVENANCE_VERSION = 1;
var MISSING_BINDING_RECOVERY_SCHEMA = "clay.missing_portfolio_binding_recovery";
var MISSING_BINDING_RECOVERY_VERSION = 1;
var DIGEST_RE = /^[a-f0-9]{64}$/;
var MAX_BINDINGS = 2048;
var MODES = { project_coordinator: true, direct_leaf: true };
// A reservation that commits does so inside the same synchronous call, so ten
// minutes is far beyond any legitimate start while still leaving obvious room
// for a slow target project.
var STRANDED_GRACE_MS = 10 * 60 * 1000;
var CURRENT_STATUSES = { pending: true, active: true, unavailable: true, deleted: true };
// Statuses under which an existing binding for the SAME work identity must block
// a new binding filed under a DIFFERENT portfolioTaskId. A retry is legitimate,
// but it belongs on a higher revision of the original id, never on a fresh id --
// a fresh id is invisible to latestCurrent() and is how one issue accumulated
// three independent binding families. `unrouted` and `superseded` never started
// or were explicitly replaced, and `deleted`/`cancelled` are withdrawn, so none
// of them stand in the way of a genuinely new attempt.
var WORK_IDENTITY_BLOCKING_STATUSES = {
  pending: true,
  active: true,
  unavailable: true,
  completed: true,
  failed: true,
  needs_input: true,
};
// `unrouted` is deliberately NOT in CURRENT_STATUSES: a reservation whose task
// never started must not block the next revision. It is also deliberately not
// in statusRequiresRef, because the whole point is that no worker was ever
// created. It records a real attempt for durable evidence rather than deleting
// it, and reserve() re-arms it so the identical revision can retry when
// capacity returns.
var STATUS_VALUES = {
  unrouted: true,
  pending: true,
  active: true,
  unavailable: true,
  deleted: true,
  completed: true,
  failed: true,
  superseded: true,
  cancelled: true,
  needs_input: true,
};

function defaultFile() {
  return path.join(config.CONFIG_DIR, "lead", "portfolio-execution-bindings.json");
}

function emptyState() {
  return { schema: SCHEMA, version: SCHEMA_VERSION, bindings: [] };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanId(value) {
  var id = String(value || "").trim();
  return projectIdentity.isTaskId(id) ? id : "";
}

function validRevision(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizedString(value, fallback) {
  var result = String(value == null ? fallback || "" : value).trim();
  return result;
}

function normalizeOwnerAcceptance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var status = value.status === "accepted" ? "accepted" :
    (value.status === "pending" ? "pending" :
      (value.status === "rejected" ? "rejected" : ""));
  if (!status) return null;
  var record = { status: status };
  // A rejection is a dated owner act, exactly like an acceptance. The old
  // behaviour dropped any status but accepted/pending, which silently
  // downgraded an owner's refusal to "never decided" on the next save.
  if (status === "rejected") {
    if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at <= 0) return null;
    record.at = value.at;
    record.by = normalizedString(value.by).slice(0, 128);
    record.source = normalizedString(value.source, "owner_decision").slice(0, 64);
    record.note = normalizedString(value.note).slice(0, 240);
    return record;
  }
  if (status === "accepted") {
    if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at <= 0) return null;
    record.at = value.at;
    record.by = normalizedString(value.by).slice(0, 128);
    record.source = normalizedString(value.source, "owner_message").slice(0, 64);
    record.phrase = normalizedString(value.phrase).slice(0, 128);
    record.withdrawnAt = value.withdrawnAt == null ? null : Number(value.withdrawnAt);
    if (record.withdrawnAt !== null && !Number.isFinite(record.withdrawnAt)) return null;
  } else {
    record.source = normalizedString(value.source,
      "project_local_instructions").slice(0, 64);
  }
  return record;
}

function normalizeOwnerAcceptanceRepair(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schema !== "clay.owner_acceptance_repair" || value.version !== 1 ||
      typeof value.repairedAt !== "number" || !Number.isFinite(value.repairedAt) ||
      !normalizedString(value.correctionEventId)) return null;
  return {
    schema: "clay.owner_acceptance_repair",
    version: 1,
    repairedAt: value.repairedAt,
    correctionEventId: normalizedString(value.correctionEventId).slice(0, 256),
    previousProjection: normalizedString(value.previousProjection, "done").slice(0, 40),
    reason: normalizedString(value.reason, "owner_acceptance_missing").slice(0, 240),
  };
}

function canonicalPayloadValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? value.trim() : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map(canonicalPayloadValue).sort(function (left, right) {
      return JSON.stringify(left).localeCompare(JSON.stringify(right));
    });
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
  var result = {};
  Object.keys(value).sort().forEach(function (key) {
    if (value[key] !== undefined) result[key] = canonicalPayloadValue(value[key]);
  });
  return result;
}

function normalizeTaskPayload(value) {
  var input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    title: normalizedString(input.title, "Project execution").slice(0, 240),
    objective: normalizedString(input.objective),
    context: normalizedString(input.context),
    acceptanceCriteria: normalizedString(input.acceptanceCriteria),
    ownedPaths: normalizedString(input.ownedPaths),
    dependencies: canonicalPayloadValue(Array.isArray(input.dependencies) ? input.dependencies : []),
    imageRefs: canonicalPayloadValue(Array.isArray(input.imageRefs) ? input.imageRefs : []),
    difficulty: normalizedString(input.difficulty) || null,
    maxAttempts: Number.isSafeInteger(input.maxAttempts) && input.maxAttempts > 0 ? input.maxAttempts : null,
  };
}

function digestTaskPayload(value) {
  return crypto.createHash("sha256").update(JSON.stringify(normalizeTaskPayload(value)), "utf8").digest("hex");
}

function normalizeControlPlaneProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schema !== CONTROL_PLANE_PROVENANCE_SCHEMA ||
      value.version !== CONTROL_PLANE_PROVENANCE_VERSION) return null;
  return { schema: CONTROL_PLANE_PROVENANCE_SCHEMA, version: CONTROL_PLANE_PROVENANCE_VERSION };
}

function currentControlPlaneProvenance() {
  return { schema: CONTROL_PLANE_PROVENANCE_SCHEMA, version: CONTROL_PLANE_PROVENANCE_VERSION };
}

function normalizedRouteValue(value) {
  return typeof value === "string" ? value.trim() || null : null;
}

function hasTaskPayloadFields(value) {
  var fields = ["title", "objective", "context", "acceptanceCriteria", "ownedPaths",
    "dependencies", "imageRefs", "difficulty", "maxAttempts"];
  for (var i = 0; i < fields.length; i++) {
    if (Object.prototype.hasOwnProperty.call(value, fields[i])) return true;
  }
  return false;
}

function normalizeRequest(value, options) {
  var input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var opts = options || {};
  var portfolioTaskId = cleanId(input.portfolioTaskId);
  var idempotencyKey = cleanId(input.idempotencyKey);
  var targetProject = projectIdentity.normalizeProjectRef(input.targetProject || {
    projectId: input.targetProjectId,
  });
  var mode = MODES[input.mode] ? input.mode : "";
  if (!portfolioTaskId || !idempotencyKey || !targetProject || !mode ||
      !validRevision(input.bindingRevision)) return null;
  var request = {
    portfolioTaskId: portfolioTaskId,
    mode: mode,
    targetProject: targetProject,
    bindingRevision: input.bindingRevision,
    idempotencyKey: idempotencyKey,
  };
  var classifiedRole = controlRole.forExecution(input);
  if (controlRole.isPeer(classifiedRole)) request.controlRole = classifiedRole;
  if (input.reviewOnly === true) request.reviewOnly = true;
  var source = projectIdentity.normalizeSessionRef(input.source);
  if (source) request.source = source;
  var legacyReference = normalizeLegacyReference(input.legacyReference || input.legacyExecution);
  if (legacyReference) request.legacyReference = legacyReference;
  var coopTopicRef = normalizeBindingTopicRef(input.coopTopicRef || input.topicRef);
  if (coopTopicRef) request.coopTopicRef = coopTopicRef;
  var workKey = normalizeWorkIdentity(input.workIdentity || input.candidateKey || input.itemKey ||
    input.automationAuthorization && input.automationAuthorization.itemKey);
  if (!workKey) workKey = workIdentity.canonicalIssueAlias(input.portfolioTaskId);
  if (workKey) request.workIdentity = workKey;
  var hasAutomationAuthorization = Object.prototype.hasOwnProperty.call(input,
    "automationAuthorization");
  var normalizedAutomationAuthorization = automationAuthorization.normalizeAuthorization(
    input.automationAuthorization);
  if (hasAutomationAuthorization && !normalizedAutomationAuthorization) return null;
  if (normalizedAutomationAuthorization) {
    request.automationAuthorization = normalizedAutomationAuthorization;
  }
  var hasProvenance = Object.prototype.hasOwnProperty.call(input, "controlPlaneProvenance");
  var provenance = normalizeControlPlaneProvenance(input.controlPlaneProvenance);
  var hasDigest = Object.prototype.hasOwnProperty.call(input, "taskPayloadDigest");
  var suppliedDigest = typeof input.taskPayloadDigest === "string" &&
    DIGEST_RE.test(input.taskPayloadDigest) ? input.taskPayloadDigest : "";
  var computedDigest = hasTaskPayloadFields(input) ? digestTaskPayload(input) : "";
  if (hasProvenance && !provenance || hasDigest && !suppliedDigest ||
      suppliedDigest && computedDigest && suppliedDigest !== computedDigest) return null;
  if (opts.persisted === true) {
    if (hasProvenance !== hasDigest || hasProvenance && (!provenance || !suppliedDigest)) return null;
    if (provenance) {
      request.controlPlaneProvenance = provenance;
      request.taskPayloadDigest = suppliedDigest;
      request.provider = normalizedRouteValue(input.provider);
      request.model = normalizedRouteValue(input.model);
    }
  } else {
    request.controlPlaneProvenance = provenance || currentControlPlaneProvenance();
    request.taskPayloadDigest = computedDigest || suppliedDigest || digestTaskPayload(input);
    request.provider = normalizedRouteValue(input.provider);
    request.model = normalizedRouteValue(input.model);
  }
  return request;
}

// Finds an existing binding for the same work in the same target project that
// was filed under a different portfolioTaskId. Same-id retries are handled by
// the revision guards and never reach here.
function verifiedWorkCompletion(candidate) {
  return !!candidate && (candidate.status === "completed" ||
    candidate.ownerAcceptanceRequired === true &&
    typeof candidate.implementationCompletedAt === "number" &&
    Number.isFinite(candidate.implementationCompletedAt));
}

function conflictingWorkIdentity(bindings, request) {
  if (!request.workIdentity) return null;
  for (var i = 0; i < bindings.length; i++) {
    var candidate = bindings[i];
    if (candidate.workIdentity !== request.workIdentity) continue;
    if (candidate.portfolioTaskId === request.portfolioTaskId && !verifiedWorkCompletion(candidate)) continue;
    if (!candidate.targetProject ||
        candidate.targetProject.projectId !== request.targetProject.projectId) continue;
    if (WORK_IDENTITY_BLOCKING_STATUSES[candidate.status] || verifiedWorkCompletion(candidate)) return candidate;
  }
  return null;
}

// OPTIONAL and reference-only. An unusable ref is simply absent: attribution is
// a bonus signal, so a malformed one must never invalidate an otherwise valid
// execution binding and strand real work. Absent stays absent -- nothing here
// ever guesses or backfills a ref for a binding that arrived without one.
function normalizeBindingTopicRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var normalized = normalizeTopicRefInput(value);
  if (!normalized) return null;
  // Bounded by REJECTION, not truncation. Truncating an identifier does not
  // produce a shorter version of the same topic, it produces a different topic
  // id that could even collide with a real one -- absent beats wrong, and it
  // keeps this layer's bound identical to the delivery layer's.
  if (normalized.topicId.length > MAX_TOPIC_ID) return null;
  return normalized;
}

function normalizeLegacyReference(value) {
  var input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var coordinator = firstSessionRef(input, ["coordinator", "coordinatorRef", "legacyCoordinatorRef"]);
  var worker = firstSessionRef(input, ["worker", "workerRef", "legacyWorkerRef", "sessionRef"]);
  var task = projectIdentity.normalizeTaskRef(input.task || input.taskRef);
  if (!leadReference(coordinator) || !leadReference(worker) || !leadReference(task)) return null;
  if (!coordinator && !worker && !task) return null;
  var result = {};
  if (coordinator) result.coordinator = coordinator;
  if (worker) result.worker = worker;
  if (task) result.task = task;
  return result;
}

function firstSessionRef(input, names) {
  for (var i = 0; i < names.length; i++) {
    var ref = projectIdentity.normalizeSessionRef(input[names[i]]);
    if (ref) return ref;
  }
  return null;
}

function leadReference(ref) {
  return !ref || ref.projectId === projectIdentity.LEAD_PROJECT_ID;
}

function refForMode(mode, value) {
  var ref = projectIdentity.normalizeSessionRef(value);
  return ref && MODES[mode] ? ref : null;
}

function validPersistedTimes(value) {
  return typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt);
}

function statusRequiresRef(status) {
  return status === "active" || status === "unavailable" || status === "deleted" ||
    status === "completed" || status === "failed" || status === "needs_input";
}

// Evidence that one typed control-plane migration converted this binding, so a
// replay of the exact same operation can be recognized after a restart instead
// of rewriting bytes. Reference-only: an unusable packet is simply absent.
function normalizeControlPlaneMigration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var idempotencyKey = cleanId(value.idempotencyKey);
  if (!idempotencyKey || typeof value.migratedAt !== "number" ||
      !Number.isFinite(value.migratedAt)) return null;
  var from = projectIdentity.normalizeSessionRef(value.from);
  return {
    idempotencyKey: idempotencyKey,
    migratedAt: value.migratedAt,
    from: from || null,
  };
}

function normalizeMissingBindingRecovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schema !== MISSING_BINDING_RECOVERY_SCHEMA ||
      value.version !== MISSING_BINDING_RECOVERY_VERSION ||
      typeof value.recoveredAt !== "number" || !Number.isFinite(value.recoveredAt)) return null;
  var coordinator = projectIdentity.normalizeSessionRef(value.coordinator);
  var projectCoordinator = projectIdentity.normalizeSessionRef(value.projectCoordinator);
  var rootTaskId = cleanId(value.rootTaskId);
  if (!coordinator || !projectCoordinator || !rootTaskId) return null;
  return {
    schema: MISSING_BINDING_RECOVERY_SCHEMA,
    version: MISSING_BINDING_RECOVERY_VERSION,
    recoveredAt: value.recoveredAt,
    coordinator: coordinator,
    projectCoordinator: projectCoordinator,
    rootTaskId: rootTaskId,
  };
}

function validMissingBindingRecord(record) {
  return !!record && record.mode === "project_coordinator" &&
    record.status === "needs_input" && record.reviewOnly === true && !record.source &&
    !!record.controlPlaneProvenance && !!record.taskPayloadDigest && !!record.coordinator &&
    record.coordinator.projectId === record.targetProject.projectId &&
    !!record.projectCoordinator &&
    record.projectCoordinator.projectId === projectIdentity.LEAD_PROJECT_ID;
}

function recoveryMatchesBinding(packet, record) {
  return !!packet && !!record && sameSessionRef(packet.coordinator, record.coordinator) &&
    sameSessionRef(packet.projectCoordinator, record.projectCoordinator);
}

// Evidence that the runtime reaper terminalized this binding, and WHY. The
// reaper exists because state that reads as in-flight while nothing runs is
// invisible; a reap that left no trace would reproduce exactly that failure.
// So the packet is mandatory at the transition, not decorative: it names the
// observation class, the session it looked at, and what that session's own
// durable log last said. A wrong reap is then auditable after the fact.
var REAP_EVIDENCE_KINDS = {
  // The binding names a session that exists neither in memory nor on disk in a
  // registered project. Nothing can be running under a record that is gone.
  session_absent: true,
  // The session's own durable log ends on the authoritative terminal `done`
  // marker, that marker is older than the quiescence window, and the live
  // runtime is idle. Positive documentary evidence plus a bound, never age alone.
  session_log_quiescent: true,
  // A non-terminal event was written before the currently observing runtime
  // started. The process that owned that turn cannot still be running, while
  // the reaper's runtime-activity vetoes protect a queued restart continuation.
  session_interrupted_before_runtime: true,
  // The session already recorded a terminal execution outcome that never
  // reached the binding.
  session_outcome_recorded: true,
};

function normalizeReapEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var kind = normalizedString(value.kind);
  if (!REAP_EVIDENCE_KINDS[kind]) return null;
  if (typeof value.reapedAt !== "number" || !Number.isFinite(value.reapedAt)) return null;
  if (!CURRENT_STATUSES[value.fromStatus]) return null;
  // Runtime idleness is reset to false on every daemon restart, so a reap may
  // only be recorded when the runtime was actually observed. An unobserved
  // runtime is not an idle runtime.
  if (value.runtimeObserved !== true) return null;
  var record = {
    kind: kind,
    reapedAt: value.reapedAt,
    fromStatus: value.fromStatus,
    runtimeObserved: true,
    sessionFilePresent: value.sessionFilePresent === true,
  };
  var sessionRef = projectIdentity.normalizeSessionRef(value.sessionRef);
  record.sessionRef = sessionRef || null;
  var lastEventType = normalizedString(value.lastEventType).slice(0, 64);
  if (lastEventType) record.lastEventType = lastEventType;
  if (typeof value.lastEventAt === "number" && Number.isFinite(value.lastEventAt)) {
    record.lastEventAt = value.lastEventAt;
  }
  if (kind === "session_interrupted_before_runtime") {
    if (typeof value.runtimeStartedAt !== "number" || !Number.isFinite(value.runtimeStartedAt) ||
        typeof record.lastEventAt !== "number" || record.lastEventAt >= value.runtimeStartedAt) {
      return null;
    }
    record.runtimeStartedAt = value.runtimeStartedAt;
  }
  if (typeof value.quiescentForMs === "number" && Number.isFinite(value.quiescentForMs)) {
    record.quiescentForMs = value.quiescentForMs;
  }
  var detail = normalizedString(value.detail).slice(0, 240);
  if (detail) record.detail = detail;
  return record;
}

function copyOptionalStatus(record, value) {
  if (typeof value.statusReason === "string" && value.statusReason) {
    record.statusReason = value.statusReason.slice(0, 240);
  }
  if (typeof value.supersededAt === "number" && Number.isFinite(value.supersededAt)) {
    record.supersededAt = value.supersededAt;
  }
  if (typeof value.attentionAt === "number" && Number.isFinite(value.attentionAt)) {
    record.attentionAt = value.attentionAt;
  }
  // Durable evidence of a reservation that never produced a task. Without this
  // the reason and timing survive in memory but are dropped on reload, so a
  // restart would silently erase why the delegation failed.
  if (typeof value.unroutedAt === "number" && Number.isFinite(value.unroutedAt)) {
    record.unroutedAt = value.unroutedAt;
  }
  if (typeof value.attempts === "number" && Number.isFinite(value.attempts)) {
    record.attempts = value.attempts;
  }
  if (typeof value.completedAt === "number" && Number.isFinite(value.completedAt)) {
    record.completedAt = value.completedAt;
  }
  if (typeof value.completionEventId === "string" && value.completionEventId) {
    record.completionEventId = value.completionEventId.slice(0, 256);
  }
  if (typeof value.resultEventId === "string" && value.resultEventId) {
    record.resultEventId = value.resultEventId.slice(0, 256);
  }
  if (typeof value.completionOwnerNotification === "boolean") {
    record.completionOwnerNotification = value.completionOwnerNotification;
  }
  if (typeof value.completionOwnerDelivered === "boolean") {
    record.completionOwnerDelivered = value.completionOwnerDelivered;
  }
  if (value.ownerAcceptanceRequired === true) record.ownerAcceptanceRequired = true;
  var ownerAcceptance = normalizeOwnerAcceptance(value.ownerAcceptance);
  if (ownerAcceptance) record.ownerAcceptance = ownerAcceptance;
  // The ordered transition history behind that single current verdict. Bounded
  // and self-validating, so a malformed or oversized list cannot grow the
  // binding file without limit.
  var ownerAcceptanceEvents = acceptanceEvents.normalizeEvents(value.ownerAcceptanceEvents);
  if (ownerAcceptanceEvents.length) record.ownerAcceptanceEvents = ownerAcceptanceEvents;
  // Idempotency for the owner's verdict, so a replayed click cannot append a
  // second transition event for the same decision.
  if (typeof value.ownerAcceptanceDecisionEventId === "string" &&
      value.ownerAcceptanceDecisionEventId) {
    record.ownerAcceptanceDecisionEventId =
      value.ownerAcceptanceDecisionEventId.slice(0, 256);
  }
  if (typeof value.implementationCompletedAt === "number" &&
      Number.isFinite(value.implementationCompletedAt)) {
    record.implementationCompletedAt = value.implementationCompletedAt;
  }
  if (typeof value.implementationCompletionRevision === "number" &&
      Number.isFinite(value.implementationCompletionRevision)) {
    record.implementationCompletionRevision = value.implementationCompletionRevision;
  }
  if (typeof value.implementationGraphDigest === "string" && value.implementationGraphDigest) {
    record.implementationGraphDigest = value.implementationGraphDigest.slice(0, 256);
  }
  var ownerAcceptanceRepair = normalizeOwnerAcceptanceRepair(value.ownerAcceptanceRepair);
  if (ownerAcceptanceRepair) record.ownerAcceptanceRepair = ownerAcceptanceRepair;
  if (typeof value.failureCode === "string" && value.failureCode.trim()) {
    record.failureCode = value.failureCode.trim().slice(0, 128);
  }
  var failureDetails = normalizeFailureDetails(value.failureDetails);
  if (failureDetails) record.failureDetails = failureDetails;
  var restartEvidence = restartSupersession.normalizeRestartSupersessionEvidence(
    value.restartSupersession);
  if (restartEvidence) record.restartSupersession = restartEvidence;
  var controlPlaneMigration = normalizeControlPlaneMigration(value.controlPlaneMigration);
  if (controlPlaneMigration) record.controlPlaneMigration = controlPlaneMigration;
  var missingBindingRecovery = normalizeMissingBindingRecovery(value.missingBindingRecovery);
  if (missingBindingRecovery) record.missingBindingRecovery = missingBindingRecovery;
  // Must round-trip, for the same reason unroutedAt does: reap evidence that
  // survives in memory but is dropped on reload turns an auditable reap back
  // into a silent state mutation after the next restart.
  var reapEvidence = normalizeReapEvidence(value.reapEvidence);
  if (reapEvidence) record.reapEvidence = reapEvidence;
}

function persistedBinding(value) {
  var request = normalizeRequest(value, { persisted: true });
  if (!request || !STATUS_VALUES[value.status] || !validPersistedTimes(value)) return null;
  var refName = request.mode === "project_coordinator" ? "coordinator" : "worker";
  var ref = value[refName] ? refForMode(request.mode, value[refName]) : null;
  if (statusRequiresRef(value.status) && !ref) return null;
  var record = Object.assign({}, request, {
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
  if (request.source) record.source = request.source;
  if (ref) record[refName] = ref;
  var projectCoordinator = projectIdentity.normalizeSessionRef(value.projectCoordinator);
  if (projectCoordinator && (projectCoordinator.projectId === request.targetProject.projectId ||
      projectCoordinator.projectId === projectIdentity.LEAD_PROJECT_ID)) {
    record.projectCoordinator = projectCoordinator;
  }
  copyOptionalStatus(record, value);
  return record;
}

function supportedSchemaVersion(value) {
  return value === 1 || value === SCHEMA_VERSION || value === 3;
}

// A pre-control-plane binding can survive a restart with an active status even
// though it never recorded the coordinator ref required for a committed
// execution. Treat only that exact impossible shape as a durable cancellation;
// every other malformed record still fails closed so a real execution cannot
// be guessed away.
function recoverMissingCoordinatorBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.mode !== "project_coordinator" ||
      (value.status !== "active" && value.status !== "unavailable") ||
      value.coordinator || value.projectCoordinator || value.completedAt !== undefined ||
      value.completionEventId !== undefined || value.resultEventId !== undefined ||
      !validPersistedTimes(value) || !normalizeRequest(value, { persisted: true })) return null;
  var recovered = Object.assign({}, value, {
    status: "cancelled",
    completedAt: value.updatedAt,
    statusReason: "The coordinator session is missing and no execution reference was committed.",
    failureCode: "session_missing_without_execution_ref",
  });
  return persistedBinding(recovered);
}

function loadState(fsImpl, file) {
  if (!fsImpl.existsSync(file)) return { ok: true, state: emptyState() };
  try {
    var parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    var sourceVersion = parsed && Number(parsed.version);
    if (!parsed || parsed.schema !== SCHEMA || !supportedSchemaVersion(sourceVersion) ||
        !Array.isArray(parsed.bindings) || parsed.bindings.length > MAX_BINDINGS) {
      return { ok: false, reason: "malformed_state", state: emptyState() };
    }
    var bindings = [];
    var recovered = false;
    var seen = {};
    var current = {};
    for (var i = 0; i < parsed.bindings.length; i++) {
      var binding = persistedBinding(parsed.bindings[i]);
      if (!binding) {
        binding = recoverMissingCoordinatorBinding(parsed.bindings[i]);
        if (binding) recovered = true;
      }
      if (!binding) return { ok: false, reason: "malformed_state", state: emptyState() };
      var rawIdentity = normalizeWorkIdentity(parsed.bindings[i].workIdentity ||
        parsed.bindings[i].candidateKey || parsed.bindings[i].itemKey ||
        parsed.bindings[i].automationAuthorization && parsed.bindings[i].automationAuthorization.itemKey) ||
        workIdentity.canonicalIssueAlias(parsed.bindings[i].portfolioTaskId);
      if ((binding.workIdentity || "") !== rawIdentity) recovered = true;
      var key = binding.portfolioTaskId + ":" + binding.bindingRevision;
      if (seen[key] || CURRENT_STATUSES[binding.status] && current[binding.portfolioTaskId]) {
        return { ok: false, reason: "malformed_state", state: emptyState() };
      }
      seen[key] = true;
      if (CURRENT_STATUSES[binding.status]) current[binding.portfolioTaskId] = true;
      bindings.push(binding);
    }
    return {
      ok: true,
      migrated: sourceVersion !== SCHEMA_VERSION || recovered,
      state: { schema: SCHEMA, version: SCHEMA_VERSION, bindings: bindings },
    };
  } catch (e) {
    return { ok: false, reason: "malformed_state", state: emptyState() };
  }
}

function syncDirectory(fsImpl, directory) {
  var descriptor = null;
  try {
    descriptor = fsImpl.openSync(directory, "r");
    fsImpl.fsyncSync(descriptor);
  } catch (e) {
  } finally {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor); } catch (closeError) {}
    }
  }
}

function writeState(fsImpl, file, state) {
  var directory = path.dirname(file);
  var temp = file + ".tmp." + process.pid + "." + crypto.randomUUID();
  var descriptor = null;
  try {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    descriptor = fsImpl.openSync(temp, "w", 0o600);
    fsImpl.writeFileSync(descriptor, JSON.stringify(state, null, 2) + "\n", "utf8");
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = null;
    fsImpl.renameSync(temp, file);
    syncDirectory(fsImpl, directory);
    return { ok: true };
  } catch (e) {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor); } catch (closeError) {}
    }
    try { fsImpl.unlinkSync(temp); } catch (unlinkError) {}
    return { ok: false, reason: "persistence_failed" };
  }
}

function sameLegacyRequest(binding, request) {
  return !!binding && !!request && binding.portfolioTaskId === request.portfolioTaskId &&
    binding.bindingRevision === request.bindingRevision &&
    binding.mode === request.mode &&
    (!binding.targetProject || binding.targetProject.projectId === request.targetProject.projectId) &&
    binding.idempotencyKey === request.idempotencyKey &&
    JSON.stringify(binding.legacyReference || null) === JSON.stringify(request.legacyReference || null) &&
    // A replay that names a DIFFERENT topic is a different attribution claim,
    // not the same call twice. Silently keeping the first ref would make the
    // second caller believe its lens owns the work; conflict is the honest
    // answer.
    JSON.stringify(binding.coopTopicRef || null) === JSON.stringify(request.coopTopicRef || null) &&
    (binding.controlRole || "") === (request.controlRole || "") &&
    (binding.reviewOnly === true) === (request.reviewOnly === true) &&
    ((!binding.automationAuthorization && !request.automationAuthorization) ||
      automationAuthorization.sameIdentity(binding.automationAuthorization,
        request.automationAuthorization)) &&
    JSON.stringify(binding.source || null) === JSON.stringify(request.source || null);
}

function requestEquivalence(binding, request) {
  if (!sameLegacyRequest(binding, request)) return "conflict";
  if (isLegacyReservation(binding)) return "legacy";
  var sameCurrentFields = JSON.stringify(binding.controlPlaneProvenance) ===
      JSON.stringify(request.controlPlaneProvenance) &&
    binding.taskPayloadDigest === request.taskPayloadDigest &&
    (binding.provider || null) === (request.provider || null) &&
    (binding.model || null) === (request.model || null);
  return sameCurrentFields ? "same" : "conflict";
}

function sameRequest(binding, request) {
  return requestEquivalence(binding, request) !== "conflict";
}

function isLegacyReservation(binding) {
  return !normalizeControlPlaneProvenance(binding && binding.controlPlaneProvenance) ||
    !binding || typeof binding.taskPayloadDigest !== "string" ||
    !DIGEST_RE.test(binding.taskPayloadDigest);
}

function normalizeFailureDetails(value) {
  if (!value || typeof value !== "object") return null;
  try {
    var serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 16384) return null;
    var parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

function reservationFailure(value) {
  if (!value || typeof value !== "object") {
    return { message: String(value || "pre_task_failure").trim().slice(0, 240) };
  }
  var code = normalizedString(value.code || value.reason).slice(0, 128);
  var message = normalizedString(value.message || value.reason || code || "pre_task_failure").slice(0, 240);
  return { code: code, message: message, details: normalizeFailureDetails(value.details) };
}

function bindingIndex(bindings, portfolioTaskId, bindingRevision) {
  for (var i = 0; i < bindings.length; i++) {
    if (bindings[i].portfolioTaskId === portfolioTaskId &&
        bindings[i].bindingRevision === bindingRevision) return i;
  }
  return -1;
}

function latestCurrent(bindings, portfolioTaskId) {
  var latest = null;
  for (var i = 0; i < bindings.length; i++) {
    var candidate = bindings[i];
    if (candidate.portfolioTaskId !== portfolioTaskId || !CURRENT_STATUSES[candidate.status]) continue;
    if (!latest || candidate.bindingRevision > latest.bindingRevision) latest = candidate;
  }
  return latest;
}

function createPortfolioExecutionBindings(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || defaultFile();
  var now = opts.now || Date.now;
  var loaded = loadState(fsImpl, file);
  var state = loaded.state;
  var loadError = loaded.ok ? "" : loaded.reason;

  if (!loadError && loaded.migrated) {
    var migration = writeState(fsImpl, file, state);
    if (!migration.ok) loadError = migration.reason;
  }

  function save() {
    if (loadError) return { ok: false, reason: loadError };
    return writeState(fsImpl, file, state);
  }

  var completionApi = createBindingCompletionApi({ bindingIndex: bindingIndex, cleanId: cleanId,
    clone: clone, currentStatuses: CURRENT_STATUSES, getLoadError: function () { return loadError; },
    normalizeOwnerAcceptance: normalizeOwnerAcceptance,
    now: now, save: save, state: state });

  function get(portfolioTaskId, bindingRevision) {
    var id = cleanId(portfolioTaskId);
    if (!id) return null;
    if (!validRevision(bindingRevision)) return clone(latestCurrent(state.bindings, id));
    var index = bindingIndex(state.bindings, id, bindingRevision);
    return index === -1 ? null : clone(state.bindings[index]);
  }

  function reserve(input) {
    if (loadError) return { ok: false, reason: loadError };
    var request = normalizeRequest(input);
    if (!request) return { ok: false, reason: "invalid_binding" };
    var index = bindingIndex(state.bindings, request.portfolioTaskId, request.bindingRevision);
    if (index !== -1) {
      if (!sameRequest(state.bindings[index], request)) {
        return { ok: false, reason: "idempotency_conflict" };
      }
      // A previous attempt at this exact revision failed before any task
      // existed. Re-arm it rather than handing back a dead record, so the same
      // idempotent binding retries safely once capacity returns.
      //
      // "unavailable" joins "unrouted" here: it is what a lost coordinator
      // claim or a failed claim cleanup leaves behind. Without re-arming, the
      // retry could neither replay (the binding is not healthy) nor start
      // afresh, so recovery could never converge.
      var stale = state.bindings[index];
      if (stale.status === "unrouted" || stale.status === "unavailable") {
        var completedWork = conflictingWorkIdentity(state.bindings, request);
        if (completedWork) {
          return { ok: false, reason: "duplicate_work_identity", binding: clone(completedWork) };
        }
        var revived = clone(stale);
        stale.status = "pending";
        stale.updatedAt = now();
        stale.attempts = (Number(stale.attempts) || 1) + 1;
        delete stale.statusReason;
        delete stale.unroutedAt;
        delete stale.attentionAt;
        delete stale.failureCode;
        delete stale.failureDetails;
        // A re-armed binding has no committed execution. Keeping the previous
        // attempt's ref made commit() reject the retry's new session as an
        // idempotency conflict, so a re-arm could never actually restart.
        delete stale.coordinator;
        delete stale.worker;
        var rearmed = save();
        if (!rearmed.ok) {
          state.bindings[index] = revived;
          return rearmed;
        }
        return { ok: true, created: true, rearmed: true, binding: clone(stale) };
      }
      return { ok: true, created: false, binding: clone(state.bindings[index]) };
    }
    var current = latestCurrent(state.bindings, request.portfolioTaskId);
    if (current && request.bindingRevision <= current.bindingRevision) {
      return { ok: false, reason: "stale_binding_revision" };
    }
    if (current) return { ok: false, reason: "active_binding_exists", binding: clone(current) };
    // Same work, different attempt name. Without this the store only ever
    // compared portfolioTaskId, so re-filing the same job under a fresh id was
    // invisible to every guard above and dispatched a duplicate worker. Refusing
    // here forces the retry onto a new revision of the original binding, which
    // is the path that already carries supersession and attempt accounting.
    var duplicate = conflictingWorkIdentity(state.bindings, request);
    if (duplicate) {
      return { ok: false, reason: "duplicate_work_identity", binding: clone(duplicate) };
    }
    var timestamp = now();
    var record = Object.assign({}, request, {
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    state.bindings.push(record);
    var written = save();
    if (!written.ok) {
      state.bindings.pop();
      return written;
    }
    return { ok: true, created: true, binding: clone(record) };
  }

  function commit(portfolioTaskId, bindingRevision, sessionRef, options) {
    if (loadError) return { ok: false, reason: loadError };
    var index = bindingIndex(state.bindings, cleanId(portfolioTaskId), bindingRevision);
    if (index === -1) return { ok: false, reason: "binding_not_found" };
    var record = state.bindings[index];
    var ref = refForMode(record.mode, sessionRef);
    if (!ref || ref.projectId !== record.targetProject.projectId) {
      return { ok: false, reason: "invalid_session_ref" };
    }
    var refName = record.mode === "project_coordinator" ? "coordinator" : "worker";
    if (record[refName] && JSON.stringify(record[refName]) !== JSON.stringify(ref)) {
      return { ok: false, reason: "idempotency_conflict" };
    }
    var projectCoordinator = projectIdentity.normalizeSessionRef(options && options.projectCoordinatorRef);
    if (projectCoordinator && (record.mode !== "project_coordinator" ||
        projectCoordinator.projectId !== record.targetProject.projectId &&
        projectCoordinator.projectId !== projectIdentity.LEAD_PROJECT_ID)) {
      return { ok: false, reason: "invalid_project_coordinator_ref" };
    }
    var previous = clone(record);
    record[refName] = ref;
    if (projectCoordinator) {
      record.projectCoordinator = projectCoordinator;
    }
    record.status = "active";
    record.updatedAt = now();
    delete record.statusReason;
    delete record.attentionAt;
    var written = save();
    if (!written.ok) state.bindings[index] = previous;
    return written.ok ? { ok: true, binding: clone(record) } : written;
  }

  function changeStatus(portfolioTaskId, bindingRevision, status, reason) {
    if (loadError) return { ok: false, reason: loadError };
    if (!STATUS_VALUES[status] || status === "pending") return { ok: false, reason: "invalid_status" };
    var index = bindingIndex(state.bindings, cleanId(portfolioTaskId), bindingRevision);
    if (index === -1) return { ok: false, reason: "binding_not_found" };
    var record = state.bindings[index];
    if (record.status === "completed" || record.status === "failed" ||
        record.status === "needs_input") {
      return { ok: false, reason: "binding_terminal" };
    }
    var refName = record.mode === "project_coordinator" ? "coordinator" : "worker";
    if (statusRequiresRef(status) && !record[refName]) {
      return { ok: false, reason: "binding_pending" };
    }
    var previous = clone(record);
    record.status = status;
    record.updatedAt = now();
    record.statusReason = String(reason || status).trim().slice(0, 240);
    if (status === "superseded") record.supersededAt = record.updatedAt;
    if (status === "active" && reason === "available") {
      delete record.statusReason;
      delete record.attentionAt;
    }
    var written = save();
    if (!written.ok) state.bindings[index] = previous;
    return written.ok ? { ok: true, binding: clone(record) } : written;
  }

  // Recreates exactly one absent project-coordinator row after a higher layer
  // has independently matched the target session, resident root task, and
  // canonical project claim. This store still validates the narrow durable
  // shape and refuses to infer any field that the evidence did not preserve.
  function restoreMissingProjectCoordinator(value, evidence) {
    if (loadError) return { ok: false, reason: loadError };
    var packet = normalizeMissingBindingRecovery(Object.assign({
      schema: MISSING_BINDING_RECOVERY_SCHEMA,
      version: MISSING_BINDING_RECOVERY_VERSION,
    }, evidence || {}));
    var record = persistedBinding(Object.assign({}, value || {}, {
      missingBindingRecovery: packet,
    }));
    if (!validMissingBindingRecord(record) || !recoveryMatchesBinding(packet, record)) {
      return { ok: false, reason: "invalid_missing_binding_recovery" };
    }
    var index = bindingIndex(state.bindings, record.portfolioTaskId, record.bindingRevision);
    if (index !== -1) {
      if (JSON.stringify(state.bindings[index]) !== JSON.stringify(record)) {
        return { ok: false, reason: "idempotency_conflict" };
      }
      return { ok: true, created: false, binding: clone(state.bindings[index]) };
    }
    for (var i = 0; i < state.bindings.length; i++) {
      if (state.bindings[i].portfolioTaskId === record.portfolioTaskId &&
          state.bindings[i].bindingRevision > record.bindingRevision) {
        return { ok: false, reason: "stale_binding_revision" };
      }
    }
    var duplicate = conflictingWorkIdentity(state.bindings, record);
    if (duplicate) return { ok: false, reason: "duplicate_work_identity", binding: clone(duplicate) };
    if (state.bindings.length >= MAX_BINDINGS) return { ok: false, reason: "binding_limit_reached" };
    state.bindings.push(record);
    var written = save();
    if (!written.ok) {
      state.bindings.pop();
      return written;
    }
    return { ok: true, created: true, binding: clone(record) };
  }

  // needs_input is terminal to generic status mutation. A verified command
  // accepted by the exact project task coordinator is the one safe exception:
  // it resumes that same control-plane execution rather than inventing work.
  function markProjectCoordinatorAvailable(portfolioTaskId, bindingRevision) {
    if (loadError) return { ok: false, reason: loadError };
    var index = bindingIndex(state.bindings, cleanId(portfolioTaskId), bindingRevision);
    if (index === -1) return { ok: false, reason: "binding_not_found" };
    var record = state.bindings[index];
    if (record.mode !== "project_coordinator" || !record.coordinator ||
        !record.projectCoordinator ||
        record.projectCoordinator.projectId !== projectIdentity.LEAD_PROJECT_ID ||
        !record.controlPlaneProvenance) {
      return { ok: false, reason: "invalid_project_coordinator_reactivation" };
    }
    if (record.status === "active") {
      return { ok: true, duplicate: true, binding: clone(record) };
    }
    if (record.status !== "needs_input" && record.status !== "unavailable") {
      return { ok: false, reason: "binding_terminal" };
    }
    var previous = clone(record);
    record.status = "active";
    record.updatedAt = now();
    delete record.statusReason;
    delete record.attentionAt;
    delete record.completedAt;
    delete record.completionEventId;
    delete record.resultEventId;
    delete record.completionOwnerNotification;
    delete record.completionOwnerDelivered;
    delete record.failureCode;
    delete record.failureDetails;
    var written = save();
    if (!written.ok) state.bindings[index] = previous;
    return written.ok ? { ok: true, binding: clone(record) } : written;
  }

  // A restart recovery failure is ordinarily final and visible. This one
  // transition is deliberately narrower than changeStatus: the caller must
  // supply a normalized evidence packet that names this exact failed binding
  // and the later verified successors. It can never turn failure into success.
  function supersedeRestartRecovery(portfolioTaskId, bindingRevision, evidence) {
    if (loadError) return { ok: false, reason: loadError };
    var normalized = restartSupersession.normalizeRestartSupersessionEvidence(evidence);
    if (!normalized) return { ok: false, reason: "restart_supersession_evidence_invalid" };
    var index = bindingIndex(state.bindings, cleanId(portfolioTaskId), bindingRevision);
    if (index === -1) return { ok: false, reason: "binding_not_found" };
    var record = state.bindings[index];
    var failed = normalized.failed;
    if (failed.portfolioTaskId !== record.portfolioTaskId ||
        failed.bindingRevision !== record.bindingRevision ||
        !sameSessionRef(failed.coordinator, record.coordinator) ||
        failed.completedAt !== record.completedAt) {
      return { ok: false, reason: "restart_supersession_binding_mismatch" };
    }
    if (record.status === "superseded" && record.restartSupersession &&
        record.restartSupersession.ruleId === normalized.ruleId) {
      return { ok: true, duplicate: true, binding: clone(record) };
    }
    if (record.status !== "failed") return { ok: false, reason: "binding_not_restart_failed" };
    for (var si = 0; si < normalized.successors.length; si++) {
      var expectedSuccessor = normalized.successors[si];
      var successorIndex = bindingIndex(state.bindings, expectedSuccessor.portfolioTaskId,
        expectedSuccessor.bindingRevision);
      var successor = successorIndex === -1 ? null : state.bindings[successorIndex];
      if (!successor || successor.status !== "completed" ||
          !successor.targetProject || !record.targetProject ||
          successor.targetProject.projectId !== record.targetProject.projectId ||
          !sameSessionRef(successor.coordinator, expectedSuccessor.coordinator) ||
          !sameSessionRef(successor.projectCoordinator, expectedSuccessor.projectCoordinator) ||
          successor.completedAt !== expectedSuccessor.completedAt ||
          successor.completedAt <= record.completedAt) {
        return { ok: false, reason: "restart_supersession_successor_mismatch" };
      }
    }
    var previous = clone(record);
    record.status = "superseded";
    record.updatedAt = now();
    record.supersededAt = record.updatedAt;
    record.statusReason = "restart_recovery_superseded";
    record.restartSupersession = normalized;
    delete record.attentionAt;
    var written = save();
    if (!written.ok) state.bindings[index] = previous;
    return written.ok ? { ok: true, binding: clone(record) } : written;
  }

  // Terminalizes ONE binding revision that reads as in-flight while nothing is
  // running. Deliberately narrower than changeStatus in four ways, because the
  // dangerous error here is reaping live work:
  //
  //  1. It only accepts a from-status in CURRENT_STATUSES -- exactly the set
  //     that renders as in-flight. Terminal history and `unrouted`/`superseded`
  //     are never rewritten; `unrouted` in particular must stay re-armable by
  //     reserve(), so terminalizing it would destroy the retry path.
  //  2. It refuses any binding carrying an owner-facing question. needs_input is
  //     already blocked as terminal, and attentionAt means a human is the thing
  //     being waited on -- reaping either would silently discard the question.
  //  3. It requires a normalized evidence packet naming positive observation of
  //     death. No packet, no reap.
  //  4. It can only reach `failed` or `cancelled`. It can never manufacture
  //     success: a reaped binding is by definition one whose completion was
  //     never verified.
  function reapExecution(portfolioTaskId, bindingRevision, toStatus, evidence) {
    if (loadError) return { ok: false, reason: loadError };
    if (toStatus !== "failed" && toStatus !== "cancelled") {
      return { ok: false, reason: "invalid_reap_status" };
    }
    var index = bindingIndex(state.bindings, cleanId(portfolioTaskId), bindingRevision);
    if (index === -1) return { ok: false, reason: "binding_not_found" };
    var record = state.bindings[index];
    if (record.status === "completed" || record.status === "failed" ||
        record.status === "needs_input") {
      return { ok: false, reason: "binding_terminal" };
    }
    if (!CURRENT_STATUSES[record.status]) return { ok: false, reason: "binding_not_current" };
    if (record.attentionAt) return { ok: false, reason: "binding_awaits_owner" };
    var normalized = normalizeReapEvidence(evidence);
    if (!normalized || normalized.fromStatus !== record.status) {
      return { ok: false, reason: "reap_evidence_invalid" };
    }
    var refName = record.mode === "project_coordinator" ? "coordinator" : "worker";
    if (statusRequiresRef(toStatus) && !record[refName]) {
      return { ok: false, reason: "binding_pending" };
    }
    var previous = clone(record);
    record.status = toStatus;
    record.updatedAt = normalized.reapedAt;
    record.completedAt = normalized.reapedAt;
    record.failureCode = "reaped_" + normalized.kind;
    record.statusReason = ("runtime_reaper:" + normalized.kind).slice(0, 240);
    record.reapEvidence = normalized;
    var written = save();
    if (!written.ok) {
      state.bindings[index] = previous;
      return written;
    }
    return { ok: true, binding: clone(record), previousStatus: previous.status };
  }

  function list() {
    return clone(state.bindings);
  }

  function listCurrent() {
    var ids = {};
    for (var i = 0; i < state.bindings.length; i++) ids[state.bindings[i].portfolioTaskId] = true;
    var result = [];
    var keys = Object.keys(ids);
    for (var j = 0; j < keys.length; j++) {
      var current = latestCurrent(state.bindings, keys[j]);
      if (current) result.push(clone(current));
    }
    return result;
  }

  // A reservation is releasable only while it is still just a reservation:
  // status pending AND no committed worker/coordinator ref. That pair is what
  // proves no task was ever created, so releasing cannot orphan a live worker.
  function releasableIndex(portfolioTaskId, bindingRevision) {
    var index = bindingIndex(state.bindings, cleanId(portfolioTaskId), bindingRevision);
    if (index === -1) return -1;
    var record = state.bindings[index];
    if (record.status !== "pending") return -1;
    var refName = record.mode === "project_coordinator" ? "coordinator" : "worker";
    return record[refName] ? -1 : index;
  }

  function releaseReservation(portfolioTaskId, bindingRevision, reason) {
    if (loadError) return { ok: false, reason: loadError };
    var index = releasableIndex(portfolioTaskId, bindingRevision);
    if (index === -1) return { ok: false, reason: "binding_not_releasable" };
    var record = state.bindings[index];
    var previous = clone(record);
    var failure = reservationFailure(reason);
    record.status = "unrouted";
    record.updatedAt = now();
    record.unroutedAt = record.updatedAt;
    record.statusReason = failure.message;
    if (failure.code) record.failureCode = failure.code;
    else delete record.failureCode;
    if (failure.details) record.failureDetails = failure.details;
    else delete record.failureDetails;
    var written = save();
    if (!written.ok) state.bindings[index] = previous;
    return written.ok ? { ok: true, binding: clone(record) } : written;
  }

  // Sweeps reservations stranded by an earlier crash or by a pre-task failure
  // that predates releaseReservation. Bounded by age: a genuine reservation
  // commits inside the same synchronous call, so anything still ref-less after
  // the grace window provably never started. Without the bound this would race
  // a binding that is legitimately mid-start and cancel it.
  function reconcileStrandedReservations(options) {
    if (loadError) return { ok: false, reason: loadError, released: [] };
    var opts = options || {};
    var graceMs = typeof opts.olderThanMs === "number" ? opts.olderThanMs : STRANDED_GRACE_MS;
    var cutoff = now() - graceMs;
    var released = [];
    for (var i = 0; i < state.bindings.length; i++) {
      var record = state.bindings[i];
      if (record.status !== "pending") continue;
      var refName = record.mode === "project_coordinator" ? "coordinator" : "worker";
      if (record[refName]) continue;
      if (!(record.updatedAt <= cutoff)) continue;
      var outcome = releaseReservation(record.portfolioTaskId, record.bindingRevision,
        opts.reason || "stranded_reservation_reconciled");
      if (outcome.ok) released.push(outcome.binding);
    }
    return { ok: true, released: released };
  }

  function markAttention(portfolioTaskId, bindingRevision, reason) {
    if (loadError) return { ok: false, reason: loadError };
    var index = bindingIndex(state.bindings, cleanId(portfolioTaskId), bindingRevision);
    if (index === -1) return { ok: false, reason: "binding_not_found" };
    var record = state.bindings[index];
    if (!CURRENT_STATUSES[record.status]) return { ok: false, reason: "binding_not_current" };
    var previous = clone(record);
    record.updatedAt = now();
    record.attentionAt = record.updatedAt;
    record.statusReason = String(reason || "migration_attention").trim().slice(0, 240);
    var written = save();
    if (!written.ok) state.bindings[index] = previous;
    return written.ok ? { ok: true, binding: clone(record) } : written;
  }

  function ensureCompletionMarkers(session, metadata, saveSessionFile, record) {
    if (!session || !metadata) return false;
    var changed = false;
    if (metadata.mode === "direct_leaf") {
      if (!metadata.resultEventId) {
        metadata.resultEventId = "direct-leaf-" + crypto.randomUUID();
        changed = true;
      }
      if (!metadata.completionEventId) {
        metadata.completionEventId = "direct-completion-" + metadata.resultEventId;
        changed = true;
      }
      if (!metadata.completionDeliveryEventId) {
        metadata.completionDeliveryEventId = "direct-terminal-v2-" + metadata.resultEventId;
        changed = true;
      }
    } else if (metadata.mode === "project_coordinator") {
      if (!metadata.projectCompletionResultEventId) {
        metadata.projectCompletionResultEventId = "project-coordinator-" + crypto.randomUUID();
        changed = true;
      }
      if (!metadata.projectCompletionDeliveryEventId) {
        metadata.projectCompletionDeliveryEventId = "project-terminal-v1-" +
          metadata.projectCompletionResultEventId;
        changed = true;
      }
    }
    if (changed && typeof saveSessionFile === "function") saveSessionFile(record, session);
    return changed;
  }

  function infrastructureFailureEvidence(record, metadata) {
    if (!metadata || metadata.status !== "failed") return null;
    var code = String(metadata.failureCode || "").trim();
    var normalized = code.toLowerCase();
    if (normalized !== "provider_start_failed" && normalized.indexOf("watchdog:") !== 0 &&
        !/app[- ]server not started/i.test(code)) return null;
    var identity = [record.portfolioTaskId, record.bindingRevision, code,
      metadata.terminalAt || metadata.updatedAt || ""].join("\n");
    return {
      eventId: "infrastructure_failure:" + crypto.createHash("sha256")
        .update(identity, "utf8").digest("hex").slice(0, 48),
      completedAt: metadata.terminalAt || metadata.updatedAt || now(),
      ownerNotification: false,
      terminalStatus: "failed",
      failureCode: code,
      executionMode: record.mode,
    };
  }

  function completionEvidence(record, session, saveSessionFile) {
    var metadata = sessionExecutionBinding(session);
    if (!metadata || metadata.portfolioTaskId !== record.portfolioTaskId ||
        metadata.bindingRevision !== record.bindingRevision ||
        metadata.mode !== record.mode) return null;
    ensureCompletionMarkers(session, metadata, saveSessionFile, record);
    var infrastructureFailure = infrastructureFailureEvidence(record, metadata);
    if (infrastructureFailure) return infrastructureFailure;
    if (record.mode === "direct_leaf") {
      if (metadata.status !== "completed" && metadata.status !== "failed" &&
          metadata.status !== "needs_input") return null;
      if (!metadata.completionDeliveryEventId) return null;
      return {
        eventId: metadata.completionDeliveryEventId,
        completedAt: metadata.completedAt || now(),
        ownerNotification: metadata.completionOwnerNotification === true,
        resultEventId: metadata.resultEventId,
        terminalStatus: metadata.status,
        executionMode: "direct_leaf",
      };
    }
    var completion = projectCompletionForSession(session);
    if (completion && completion.status === "completed") {
      if (!metadata.projectCompletionDeliveryEventId) return null;
      return {
        eventId: metadata.projectCompletionDeliveryEventId,
        completedAt: completion.completedAt || metadata.completedAt || now(),
        ownerNotification: false,
        resultEventId: metadata.projectCompletionResultEventId,
        terminalStatus: "completed",
        executionMode: "project_coordinator",
      };
    }
    var projectTerminalStatus = metadata.status === "completed" ? "completed" :
      (metadata.status === "failed" || metadata.status === "needs_input" ? metadata.status : "");
    if (!projectTerminalStatus || !metadata.projectCompletionDeliveryEventId) return null;
    return {
      eventId: metadata.projectCompletionDeliveryEventId,
      completedAt: metadata.terminalAt || metadata.completedAt || now(),
      ownerNotification: false,
      resultEventId: metadata.projectCompletionResultEventId,
      // Failed/needs-input recovery is terminal for the portfolio slot, but it
      // is not verified project completion. complete() retains needs_input only
      // for an admitted read-only review; every other attention result maps to
      // failed so interrupted implementation is never reported as done.
      terminalStatus: projectTerminalStatus,
      // Carries WHY this ended, so a binding terminalized by a restart/orphan
      // recovery sweep stays distinguishable from one the task actually failed.
      // Losing it made a swept binding byte-identical to a genuine failure.
      failureCode: metadata.failureCode || metadata.reason || "",
      executionMode: "project_coordinator",
    };
  }

  // A read-only review can first reach needs_input and later be superseded by
  // an independently completed duplicate. That terminal session metadata is
  // authoritative, but it is not a completion envelope, so the normal
  // completion reconciler must not turn it into success or failure. The
  // hidden-session and exact-metadata checks make this transition fail closed:
  // a visible owner decision remains needs_input.
  function reviewSupersessionEvidence(record, session) {
    if (!record || record.mode !== "project_coordinator" ||
        record.status !== "needs_input" || record.reviewOnly !== true ||
        !session || session.hidden !== true) return null;
    var metadata = sessionExecutionBinding(session);
    if (!metadata || metadata.portfolioTaskId !== record.portfolioTaskId ||
        metadata.bindingRevision !== record.bindingRevision ||
        metadata.mode !== "project_coordinator" || metadata.status !== "superseded") {
      return null;
    }
    var terminalAt = Number(metadata.terminalAt || metadata.supersededAt || metadata.updatedAt);
    if (!Number.isFinite(terminalAt) || terminalAt <= 0) return null;
    var reason = String(metadata.reason || metadata.statusReason ||
      "execution_superseded").trim().slice(0, 240);
    return { supersededAt: terminalAt, reason: reason || "execution_superseded" };
  }

  function reconcileReviewSupersession(portfolioTaskId, bindingRevision, evidence) {
    if (loadError) return { ok: false, reason: loadError };
    var index = bindingIndex(state.bindings, cleanId(portfolioTaskId), bindingRevision);
    if (index === -1) return { ok: false, reason: "binding_not_found" };
    var record = state.bindings[index];
    if (record.mode !== "project_coordinator" || record.status !== "needs_input" ||
        record.reviewOnly !== true) return { ok: false, reason: "binding_not_review_attention" };
    if (!evidence || typeof evidence.supersededAt !== "number" ||
        !Number.isFinite(evidence.supersededAt) || evidence.supersededAt <= 0) {
      return { ok: false, reason: "supersession_evidence_invalid" };
    }
    var previous = clone(record);
    record.status = "superseded";
    record.updatedAt = now();
    record.supersededAt = evidence.supersededAt;
    record.statusReason = String(evidence.reason || "execution_superseded").trim().slice(0, 240);
    delete record.attentionAt;
    var written = save();
    if (!written.ok) state.bindings[index] = previous;
    return written.ok ? { ok: true, binding: clone(record) } : written;
  }

  function reconcileStrandedCompletions(options) {
    if (loadError) return { ok: false, reason: loadError, reconciled: [] };
    var opts = options || {};
    if (typeof opts.sessionForBinding !== "function") {
      return { ok: false, reason: "session_lookup_required", reconciled: [] };
    }
    var reconciled = [];
    for (var i = 0; i < state.bindings.length; i++) {
      var record = state.bindings[i];
      if (!record || record.status === "completed" || record.status === "failed" ||
          record.status === "superseded" || record.status === "cancelled" ||
          record.status === "unrouted") continue;
      var session = opts.sessionForBinding(clone(record));
      var supersession = reviewSupersessionEvidence(record, session);
      if (supersession) {
        var superseded = reconcileReviewSupersession(record.portfolioTaskId,
          record.bindingRevision, supersession);
        if (superseded && superseded.ok) reconciled.push(superseded.binding);
        continue;
      }
      var evidence = completionEvidence(record, session, opts.saveSession);
      if (!evidence) continue;
      var completed = completionApi.complete(record.portfolioTaskId, record.bindingRevision, evidence);
      if (completed && completed.ok) reconciled.push(completed.binding);
    }
    return { ok: true, reconciled: reconciled };
  }

  function rebindProjectCoordinator(projectRef, fromRef, toRef) {
    if (loadError) return { ok: false, reason: loadError };
    var project = projectIdentity.normalizeProjectRef(projectRef);
    var from = projectIdentity.normalizeSessionRef(fromRef);
    var to = projectIdentity.normalizeSessionRef(toRef);
    if (!project || !from || !to || to.projectId !== projectIdentity.LEAD_PROJECT_ID) {
      return { ok: false, reason: "invalid_project_coordinator_ref" };
    }
    var previous = clone(state.bindings);
    var changed = 0;
    for (var i = 0; i < state.bindings.length; i++) {
      var record = state.bindings[i];
      if (!record || record.mode !== "project_coordinator" ||
          record.targetProject.projectId !== project.projectId ||
          !CURRENT_STATUSES[record.status] || !sameSessionRef(record.projectCoordinator, from)) continue;
      record.projectCoordinator = clone(to);
      record.updatedAt = now();
      changed++;
    }
    if (!changed) return { ok: true, changed: 0 };
    var written = save();
    if (!written.ok) state.bindings = previous;
    return written.ok ? { ok: true, changed: changed } : written;
  }

  // Converts ONE exact non-terminal project-coordinator binding revision to a
  // Coop-resident control-plane binding. Terminal history is immutable here by
  // construction: a completed, failed, superseded, cancelled, or deleted
  // revision is durable evidence of what actually ran and is never rewritten.
  // Retries are byte-stable: the evidence packet records the one idempotency
  // key that performed the conversion, and a replay with that key returns the
  // persisted record without touching disk.
  function adoptControlPlaneCoordinator(portfolioTaskId, bindingRevision, options) {
    if (loadError) return { ok: false, reason: loadError };
    var opts = options || {};
    var to = projectIdentity.normalizeSessionRef(opts.to);
    if (!to || to.projectId !== projectIdentity.LEAD_PROJECT_ID) {
      return { ok: false, reason: "invalid_project_coordinator_ref" };
    }
    var idempotencyKey = cleanId(opts.idempotencyKey);
    if (!idempotencyKey) return { ok: false, reason: "invalid_migration_idempotency_key" };
    var index = bindingIndex(state.bindings, cleanId(portfolioTaskId), bindingRevision);
    if (index === -1) return { ok: false, reason: "binding_not_found" };
    var record = state.bindings[index];
    if (record.mode !== "project_coordinator") return { ok: false, reason: "invalid_binding" };
    if (record.status === "completed" || record.status === "failed" ||
        record.status === "superseded" || record.status === "cancelled" ||
        record.status === "deleted") {
      return { ok: false, reason: "binding_terminal" };
    }
    var existing = record.projectCoordinator || null;
    if (existing && existing.projectId === projectIdentity.LEAD_PROJECT_ID) {
      if (record.controlPlaneMigration &&
          record.controlPlaneMigration.idempotencyKey !== idempotencyKey) {
        return { ok: false, reason: "idempotency_conflict" };
      }
      if (!sameSessionRef(existing, to)) {
        return { ok: false, reason: "project_coordinator_mismatch" };
      }
      return { ok: true, duplicate: true, binding: clone(record) };
    }
    var from = projectIdentity.normalizeSessionRef(opts.from);
    if (existing && (!from || !sameSessionRef(existing, from))) {
      return { ok: false, reason: "prior_binding_mismatch" };
    }
    var previous = clone(record);
    record.projectCoordinator = clone(to);
    record.controlPlaneMigration = {
      idempotencyKey: idempotencyKey,
      migratedAt: now(),
      from: from ? clone(from) : null,
    };
    record.updatedAt = record.controlPlaneMigration.migratedAt;
    var written = save();
    if (!written.ok) {
      state.bindings[index] = previous;
      return written;
    }
    return { ok: true, duplicate: false, binding: clone(record) };
  }

  // Startup sweep, so a daemon restart after a crash between reserve and commit
  // clears its own ghosts without waiting for the next delegation. Opt-out
  // exists only so tests can construct a store without side effects.
  if (!loadError && opts.reconcileOnLoad !== false) {
    reconcileStrandedReservations({ reason: "stranded_reservation_reconciled_on_load" });
  }

  return {
    acknowledgeCompletion: completionApi.acknowledgeCompletion,
    adoptControlPlaneCoordinator: adoptControlPlaneCoordinator,
    commit: commit,
    complete: completionApi.complete,
    file: file,
    findDirectLeafByWorker: completionApi.findDirectLeafByWorker,
    get: get,
    getLoadError: function () { return loadError || null; },
    list: list,
    listCurrent: listCurrent,
    markAttention: markAttention,
    markProjectCoordinatorAvailable: markProjectCoordinatorAvailable,
    recordOwnerVerdict: completionApi.recordOwnerVerdict,
    requireOwnerAcceptance: completionApi.requireOwnerAcceptance,
    markAvailable: function (portfolioTaskId, revision) {
      return changeStatus(portfolioTaskId, revision, "active", "available");
    },
    markDeleted: function (portfolioTaskId, revision, reason) {
      return changeStatus(portfolioTaskId, revision, "deleted", reason || "session_deleted");
    },
    markUnavailable: function (portfolioTaskId, revision, reason) {
      return changeStatus(portfolioTaskId, revision, "unavailable", reason || "session_unavailable");
    },
    reapExecution: reapExecution,
    reconcileStrandedCompletions: reconcileStrandedCompletions,
    reconcileStrandedReservations: reconcileStrandedReservations,
    rebindProjectCoordinator: rebindProjectCoordinator,
    restoreMissingProjectCoordinator: restoreMissingProjectCoordinator,
    releaseReservation: releaseReservation,
    reserve: reserve,
    supersede: function (portfolioTaskId, revision, reason) {
      return changeStatus(portfolioTaskId, revision, "superseded", reason || "superseded");
    },
    supersedeRestartRecovery: supersedeRestartRecovery,
  };
}

// Read-only projection for background observers. Creating the mutable store
// may persist schema recovery and reconcile stranded reservations; a wake
// predicate must never turn an observation into a control-plane mutation.
function readPortfolioExecutionBindings(options) {
  var opts = options || {};
  var loaded = loadState(opts.fs || fs, opts.file || defaultFile());
  return {
    ok: loaded.ok,
    reason: loaded.ok ? null : loaded.reason,
    migrated: !!loaded.migrated,
    bindings: loaded.ok ? clone(loaded.state.bindings) : [],
  };
}

function sessionExecutionBinding(session) {
  var policy = session && session.orchestrationPolicy;
  var binding = policy && policy.portfolioExecution;
  if (!binding || typeof binding !== "object" || !MODES[binding.mode]) return null;
  if (!cleanId(binding.portfolioTaskId) || !cleanId(binding.idempotencyKey) ||
      !validRevision(binding.bindingRevision)) return null;
  return binding;
}

function projectCompletionForSession(session) {
  var binding = sessionExecutionBinding(session);
  var completion = session && session.orchestrationProjectCompletion;
  if (!binding || binding.mode !== "project_coordinator" || !completion ||
      (completion.status !== "pending" && completion.status !== "completed")) return null;
  return {
    portfolioTaskId: binding.portfolioTaskId,
    bindingRevision: binding.bindingRevision,
    status: completion.status,
    completionRevision: completion.completionRevision,
    graphDigest: completion.graphDigest || "",
    summary: completion.summary || "",
    verification: completion.verification || "",
    integrationVerification: completion.integrationVerification || "",
    completedAt: completion.completedAt || null,
    revokedAt: completion.revokedAt || null,
    revocationReason: completion.revocationReason || "",
  };
}

function findExecutionSession(sm, portfolioTaskId, bindingRevision) {
  var found = null;
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
  sm.sessions.forEach(function (session) {
    var metadata = sessionExecutionBinding(session);
    if (!found && metadata && metadata.portfolioTaskId === portfolioTaskId &&
        metadata.bindingRevision === bindingRevision) found = session;
  });
  return found;
}

function executionSessionForBinding(sm, binding) {
  return bindingLineage.executionSessionForBinding(sm, binding, sessionExecutionBinding);
}

function sourceContinuesBinding(sm, binding, sourceRef) {
  return bindingLineage.sourceContinuesBinding(sm, binding, sourceRef, sessionExecutionBinding);
}

function sessionByRef(sm, ref, projectId) {
  var normalized = projectIdentity.normalizeSessionRef(ref);
  if (!normalized || normalized.projectId !== projectId || !sm || !sm.sessions) return null;
  var found = null;
  sm.sessions.forEach(function (session) {
    if (!found && projectIdentity.sessionStorageId(session) === normalized.sessionStorageId) {
      found = session;
    }
  });
  return found;
}

function activeExecutionForTask(sm, portfolioTaskId, terminalStatuses) {
  var found = null;
  var terminal = terminalStatuses || {};
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
  sm.sessions.forEach(function (session) {
    var metadata = sessionExecutionBinding(session);
    if (!found && metadata && metadata.portfolioTaskId === portfolioTaskId &&
        !terminal[metadata.status]) found = session;
  });
  return found;
}

function sameSessionRef(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId;
}

module.exports = {
  CONTROL_PLANE_PROVENANCE_SCHEMA: CONTROL_PLANE_PROVENANCE_SCHEMA,
  CONTROL_PLANE_PROVENANCE_VERSION: CONTROL_PLANE_PROVENANCE_VERSION,
  CURRENT_STATUSES: CURRENT_STATUSES,
  MODES: MODES,
  REAP_EVIDENCE_KINDS: REAP_EVIDENCE_KINDS,
  normalizeReapEvidence: normalizeReapEvidence,
  createBindingStore: createPortfolioExecutionBindings,
  createPortfolioExecutionBindings: createPortfolioExecutionBindings,
  readPortfolioExecutionBindings: readPortfolioExecutionBindings,
  defaultFile: defaultFile,
  activeExecutionForTask: activeExecutionForTask,
  executionSessionForBinding: executionSessionForBinding,
  findExecutionSession: findExecutionSession,
  isLegacyReservation: isLegacyReservation,
  normalizeRequest: normalizeRequest,
  normalizeBindingTopicRef: normalizeBindingTopicRef,
  normalizeLegacyReference: normalizeLegacyReference,
  normalizeTaskPayload: normalizeTaskPayload,
  projectCompletionForSession: projectCompletionForSession,
  requestEquivalence: requestEquivalence,
  sameSessionRef: sameSessionRef,
  sessionByRef: sessionByRef,
  sessionExecutionBinding: sessionExecutionBinding,
  sameRequest: sameRequest,
  sourceContinuesBinding: sourceContinuesBinding,
  taskPayloadDigest: digestTaskPayload,
};
