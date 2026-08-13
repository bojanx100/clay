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
var createBindingCompletionApi = require("./portfolio-execution-binding-completion").createBindingCompletionApi;
// The leaf normalizer, NOT orchestration-task-graph. This store owns idempotency
// and tombstones; making it depend on the orchestration graph to validate a
// two-field object dragged coop-work-activity and the entire topic subsystem into
// a low-level persistence layer.
var normalizeTopicRefInput = require("./coop-topic-ref").normalizeTopicRefInput;

var MAX_TOPIC_ID = 128;

var SCHEMA = "clay.portfolio_execution_bindings";
var SCHEMA_VERSION = 2;
var MAX_BINDINGS = 2048;
var MODES = { project_coordinator: true, direct_leaf: true };
// A reservation that commits does so inside the same synchronous call, so ten
// minutes is far beyond any legitimate start while still leaving obvious room
// for a slow target project.
var STRANDED_GRACE_MS = 10 * 60 * 1000;
var CURRENT_STATUSES = { pending: true, active: true, unavailable: true, deleted: true };
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

function normalizeRequest(value) {
  var input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
  var source = projectIdentity.normalizeSessionRef(input.source);
  if (source) request.source = source;
  var legacyReference = normalizeLegacyReference(input.legacyReference || input.legacyExecution);
  if (legacyReference) request.legacyReference = legacyReference;
  var coopTopicRef = normalizeBindingTopicRef(input.coopTopicRef || input.topicRef);
  if (coopTopicRef) request.coopTopicRef = coopTopicRef;
  return request;
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
    status === "completed" || status === "failed";
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
  if (value.completionOwnerNotification === true) record.completionOwnerNotification = true;
  if (value.completionOwnerDelivered === true) record.completionOwnerDelivered = true;
}

function persistedBinding(value) {
  var request = normalizeRequest(value);
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
  if (projectCoordinator && projectCoordinator.projectId === request.targetProject.projectId) {
    record.projectCoordinator = projectCoordinator;
  }
  copyOptionalStatus(record, value);
  return record;
}

function supportedSchemaVersion(value) {
  return value === 1 || value === SCHEMA_VERSION || value === 3;
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
    var seen = {};
    var current = {};
    for (var i = 0; i < parsed.bindings.length; i++) {
      var binding = persistedBinding(parsed.bindings[i]);
      if (!binding) return { ok: false, reason: "malformed_state", state: emptyState() };
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
      migrated: sourceVersion !== SCHEMA_VERSION,
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

function sameRequest(binding, request) {
  return binding.portfolioTaskId === request.portfolioTaskId &&
    binding.bindingRevision === request.bindingRevision &&
    binding.mode === request.mode &&
    binding.targetProject.projectId === request.targetProject.projectId &&
    binding.idempotencyKey === request.idempotencyKey &&
    JSON.stringify(binding.legacyReference || null) === JSON.stringify(request.legacyReference || null) &&
    // A replay that names a DIFFERENT topic is a different attribution claim,
    // not the same call twice. Silently keeping the first ref would make the
    // second caller believe its lens owns the work; conflict is the honest
    // answer.
    JSON.stringify(binding.coopTopicRef || null) === JSON.stringify(request.coopTopicRef || null) &&
    JSON.stringify(binding.source || null) === JSON.stringify(request.source || null);
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
        var revived = clone(stale);
        stale.status = "pending";
        stale.updatedAt = now();
        stale.attempts = (Number(stale.attempts) || 1) + 1;
        delete stale.statusReason;
        delete stale.unroutedAt;
        delete stale.attentionAt;
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
        projectCoordinator.projectId !== record.targetProject.projectId)) {
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
    if (record.status === "completed" || record.status === "failed") {
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
    record.status = "unrouted";
    record.updatedAt = now();
    record.unroutedAt = record.updatedAt;
    record.statusReason = String(reason || "pre_task_failure").trim().slice(0, 240);
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

  function completionEvidence(record, session, saveSessionFile) {
    var metadata = sessionExecutionBinding(session);
    if (!metadata || metadata.portfolioTaskId !== record.portfolioTaskId ||
        metadata.bindingRevision !== record.bindingRevision ||
        metadata.mode !== record.mode) return null;
    ensureCompletionMarkers(session, metadata, saveSessionFile, record);
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
      // is not verified project completion. complete() deliberately maps both
      // to a failed binding so interrupted work is never reported as done.
      terminalStatus: projectTerminalStatus,
      executionMode: "project_coordinator",
    };
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
      var evidence = completionEvidence(record, session, opts.saveSession);
      if (!evidence) continue;
      var completed = completionApi.complete(record.portfolioTaskId, record.bindingRevision, evidence);
      if (completed && completed.ok) reconciled.push(completed.binding);
    }
    return { ok: true, reconciled: reconciled };
  }

  // Startup sweep, so a daemon restart after a crash between reserve and commit
  // clears its own ghosts without waiting for the next delegation. Opt-out
  // exists only so tests can construct a store without side effects.
  if (!loadError && opts.reconcileOnLoad !== false) {
    reconcileStrandedReservations({ reason: "stranded_reservation_reconciled_on_load" });
  }

  return {
    acknowledgeCompletion: completionApi.acknowledgeCompletion,
    commit: commit,
    complete: completionApi.complete,
    file: file,
    findDirectLeafByWorker: completionApi.findDirectLeafByWorker,
    get: get,
    getLoadError: function () { return loadError || null; },
    list: list,
    listCurrent: listCurrent,
    markAttention: markAttention,
    markAvailable: function (portfolioTaskId, revision) {
      return changeStatus(portfolioTaskId, revision, "active", "available");
    },
    markDeleted: function (portfolioTaskId, revision, reason) {
      return changeStatus(portfolioTaskId, revision, "deleted", reason || "session_deleted");
    },
    markUnavailable: function (portfolioTaskId, revision, reason) {
      return changeStatus(portfolioTaskId, revision, "unavailable", reason || "session_unavailable");
    },
    reconcileStrandedCompletions: reconcileStrandedCompletions,
    reconcileStrandedReservations: reconcileStrandedReservations,
    releaseReservation: releaseReservation,
    reserve: reserve,
    supersede: function (portfolioTaskId, revision, reason) {
      return changeStatus(portfolioTaskId, revision, "superseded", reason || "superseded");
    },
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
  MODES: MODES,
  createBindingStore: createPortfolioExecutionBindings,
  createPortfolioExecutionBindings: createPortfolioExecutionBindings,
  defaultFile: defaultFile,
  activeExecutionForTask: activeExecutionForTask,
  executionSessionForBinding: executionSessionForBinding,
  findExecutionSession: findExecutionSession,
  normalizeRequest: normalizeRequest,
  normalizeBindingTopicRef: normalizeBindingTopicRef,
  normalizeLegacyReference: normalizeLegacyReference,
  projectCompletionForSession: projectCompletionForSession,
  sameSessionRef: sameSessionRef,
  sessionByRef: sessionByRef,
  sessionExecutionBinding: sessionExecutionBinding,
  sourceContinuesBinding: sourceContinuesBinding,
};
