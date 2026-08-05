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

var SCHEMA = "clay.portfolio_execution_bindings";
var SCHEMA_VERSION = 1;
var MAX_BINDINGS = 2048;
var MODES = { project_coordinator: true, direct_leaf: true };
var CURRENT_STATUSES = { pending: true, active: true, unavailable: true, deleted: true };
var STATUS_VALUES = {
  pending: true,
  active: true,
  unavailable: true,
  deleted: true,
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
  return {
    portfolioTaskId: portfolioTaskId,
    mode: mode,
    targetProject: targetProject,
    bindingRevision: input.bindingRevision,
    idempotencyKey: idempotencyKey,
  };
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
  return status === "active" || status === "unavailable" || status === "deleted";
}

function copyOptionalStatus(record, value) {
  if (typeof value.statusReason === "string" && value.statusReason) {
    record.statusReason = value.statusReason.slice(0, 240);
  }
  if (typeof value.supersededAt === "number" && Number.isFinite(value.supersededAt)) {
    record.supersededAt = value.supersededAt;
  }
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
  if (ref) record[refName] = ref;
  copyOptionalStatus(record, value);
  return record;
}

function loadState(fsImpl, file) {
  if (!fsImpl.existsSync(file)) return { ok: true, state: emptyState() };
  try {
    var parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || parsed.schema !== SCHEMA || parsed.version !== SCHEMA_VERSION ||
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
    return { ok: true, state: { schema: SCHEMA, version: SCHEMA_VERSION, bindings: bindings } };
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
    binding.idempotencyKey === request.idempotencyKey;
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

  function save() {
    if (loadError) return { ok: false, reason: loadError };
    return writeState(fsImpl, file, state);
  }

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

  function commit(portfolioTaskId, bindingRevision, sessionRef) {
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
    var previous = clone(record);
    record[refName] = ref;
    record.status = "active";
    record.updatedAt = now();
    delete record.statusReason;
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
    var refName = record.mode === "project_coordinator" ? "coordinator" : "worker";
    if (statusRequiresRef(status) && !record[refName]) {
      return { ok: false, reason: "binding_pending" };
    }
    var previous = clone(record);
    record.status = status;
    record.updatedAt = now();
    record.statusReason = String(reason || status).trim().slice(0, 240);
    if (status === "superseded") record.supersededAt = record.updatedAt;
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

  return {
    commit: commit,
    file: file,
    get: get,
    getLoadError: function () { return loadError || null; },
    list: list,
    listCurrent: listCurrent,
    markAvailable: function (portfolioTaskId, revision) {
      return changeStatus(portfolioTaskId, revision, "active", "available");
    },
    markDeleted: function (portfolioTaskId, revision, reason) {
      return changeStatus(portfolioTaskId, revision, "deleted", reason || "session_deleted");
    },
    markUnavailable: function (portfolioTaskId, revision, reason) {
      return changeStatus(portfolioTaskId, revision, "unavailable", reason || "session_unavailable");
    },
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

module.exports = {
  MODES: MODES,
  createBindingStore: createPortfolioExecutionBindings,
  createPortfolioExecutionBindings: createPortfolioExecutionBindings,
  defaultFile: defaultFile,
  activeExecutionForTask: activeExecutionForTask,
  findExecutionSession: findExecutionSession,
  normalizeRequest: normalizeRequest,
  sessionByRef: sessionByRef,
  sessionExecutionBinding: sessionExecutionBinding,
};
