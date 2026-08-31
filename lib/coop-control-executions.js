// Slice 2 logical execution controller. Durable rows carry only structured
// references and digests; the capability secret remains process-memory only.

var crypto = require("crypto");
var controlStore = require("./coop-control-store");
var projectIdentity = require("./project-identity");
var validation = require("./coop-control-store-validation");

var EXECUTION_CONTROL_ENV = "CLAY_COOP_CONTROL_EXECUTIONS";
var ACTIONS = Object.freeze(Object.assign(Object.create(null), {
  provider_start: 1,
  callback: 2,
  tool: 4,
  progress: 8,
  completion: 16,
}));
var ALL_ACTIONS_MASK = 31;
var MODES = Object.freeze(Object.assign(Object.create(null), {
  project_coordinator: "coordinator", direct_leaf: "worker",
}));

function error(code, message) {
  return validation.taggedError(code, message);
}

function isExecutionControlEnabled(options) {
  var opts = options || {};
  if (typeof opts.enabled === "boolean") return opts.enabled;
  var env = opts.env || process.env;
  return !!(env && env[controlStore.CONTROL_STORE_ENV] === "1" && env[EXECUTION_CONTROL_ENV] === "1");
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw error("COOP_CONTROL_AUTHORITY_INVALID", label + " must be a plain object.");
  }
  var allowed = {};
  for (var i = 0; i < fields.length; i++) allowed[fields[i]] = true;
  var keys = Object.keys(value);
  for (var j = 0; j < keys.length; j++) {
    if (!allowed[keys[j]]) {
      throw error("COOP_CONTROL_AUTHORITY_INVALID", label + " contains an unknown field.");
    }
  }
  for (var k = 0; k < fields.length; k++) {
    if (!Object.prototype.hasOwnProperty.call(value, fields[k])) {
      throw error("COOP_CONTROL_AUTHORITY_INVALID", label + " is missing a required field.");
    }
  }
  return value;
}

function normalizeRequest(value) {
  var source = exactObject(value, [
    "portfolioTaskId", "bindingRevision", "idempotencyKey", "mode", "targetProject", "source",
  ], "Execution authority");
  var targetProject = projectIdentity.normalizeProjectRef(source.targetProject);
  var sourceSession = projectIdentity.normalizeSessionRef(source.source);
  if (!projectIdentity.isTaskId(source.portfolioTaskId) ||
      !Number.isSafeInteger(source.bindingRevision) || source.bindingRevision <= 0 ||
      !projectIdentity.isTaskId(source.idempotencyKey) ||
      !Object.prototype.hasOwnProperty.call(MODES, source.mode) ||
      !targetProject || !sourceSession || sourceSession.projectId !== projectIdentity.LEAD_PROJECT_ID) {
    throw error("COOP_CONTROL_AUTHORITY_INVALID", "Execution authority contains invalid references or codes.");
  }
  return {
    portfolioTaskId: source.portfolioTaskId,
    bindingRevision: source.bindingRevision,
    idempotencyKey: source.idempotencyKey,
    mode: source.mode,
    targetProjectId: targetProject.projectId,
    sourceProjectId: sourceSession.projectId,
    sourceSessionId: sourceSession.sessionStorageId,
    role: MODES[source.mode],
    actionMask: ALL_ACTIONS_MASK,
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function identity(prefix, fields) {
  return prefix + ":" + digest(fields.join("\u0000")).slice(0, 48);
}

function executionIdentity(spec) {
  return identity("exec", [spec.portfolioTaskId, spec.bindingRevision, spec.targetProjectId, spec.mode]);
}

function authorityIdentity(spec) {
  return identity("auth", [spec.sourceProjectId, spec.sourceSessionId, spec.portfolioTaskId,
    spec.bindingRevision, spec.targetProjectId, spec.role, spec.actionMask]);
}

function capabilitySecret(randomBytes) {
  return randomBytes(32).toString("base64url");
}

function disabledControl() {
  return {
    enabled: false,
    close: function () {},
    findRecoveryTargets: function () { return []; },
    getStore: function () { return null; },
    inspect: function () { return null; },
    recoverIncomplete: function () { return 0; },
    recoverTarget: function () { return null; },
    recoverTargets: function () { return []; },
    reserveStart: function () { return { enabled: false, bypass: true }; },
  };
}

function publicRef(token) {
  return {
    executionId: token.executionId,
    incarnationId: token.incarnationId,
    epoch: token.epoch,
    role: token.role,
    authorityId: token.authorityId,
    capabilityDigest: digest(token.capability),
  };
}

function camelAuthority(row) {
  if (!row) return null;
  return {
    authorityId: row.authority_id,
    source: { projectId: row.source_project_id, sessionStorageId: row.source_session_id },
    portfolioTaskId: row.portfolio_task_id,
    bindingRevision: Number(row.binding_revision),
    targetProject: { projectId: row.target_project_id },
    role: row.role,
    actionMask: Number(row.action_mask),
    issuedAt: Number(row.issued_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

function camelExecution(row) {
  if (!row) return null;
  return {
    executionId: row.execution_id,
    portfolioTaskId: row.portfolio_task_id,
    bindingRevision: Number(row.binding_revision),
    idempotencyKey: row.idempotency_key,
    targetProject: { projectId: row.target_project_id },
    mode: row.mode,
    authorityId: row.authority_id,
    currentEpoch: Number(row.current_epoch),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  };
}

function camelIncarnation(row) {
  return {
    incarnationId: row.incarnation_id,
    executionId: row.execution_id,
    epoch: Number(row.epoch),
    sessionRef: row.session_project_id === null ? null : {
      projectId: row.session_project_id, sessionStorageId: row.session_storage_id,
    },
    capabilityDigest: row.capability_digest,
    startState: row.start_state,
    failureCode: row.failure_code,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
  };
}

function camelLease(row) {
  return {
    executionId: row.execution_id,
    role: row.role,
    incarnationId: row.incarnation_id,
    epoch: Number(row.epoch),
    authorityId: row.authority_id,
    acquiredAt: Number(row.acquired_at),
    updatedAt: Number(row.updated_at),
  };
}

function createExecutionControl(options) {
  var opts = options || {};
  if (!isExecutionControlEnabled(opts)) return disabledControl();
  var ownsStore = !opts.store;
  var storeOptions = {
    dbPath: opts.dbPath,
    faults: opts.storeFaults,
    fs: opts.fs,
    now: opts.now,
  };
  if (Object.prototype.hasOwnProperty.call(opts, "sqliteModule")) {
    storeOptions.sqliteModule = opts.sqliteModule;
  }
  var store = opts.store || controlStore.openControlStore(storeOptions);
  if (!store || store.enabled !== true || typeof store.reserveExecution !== "function") {
    throw error("COOP_CONTROL_EXECUTION_UNAVAILABLE", "Slice 2 requires an activated Slice 2 ControlStore.");
  }
  var randomBytes = typeof opts.randomBytes === "function" ? opts.randomBytes : crypto.randomBytes;
  var randomUUID = typeof opts.randomUUID === "function" ? opts.randomUUID : crypto.randomUUID;
  var faults = opts.faults || {};
  var live = Object.create(null);
  var recoveryTargets = Object.create(null);
  var closed = false;

  function assertOpen() {
    if (closed) throw error("COOP_CONTROL_EXECUTION_CLOSED", "Execution control is closed.");
  }

  function reserveStart(input) {
    assertOpen();
    var spec = normalizeRequest(input);
    spec.executionId = executionIdentity(spec);
    spec.authorityId = authorityIdentity(spec);
    spec.incarnationId = "inc:" + randomUUID();
    var capability = capabilitySecret(randomBytes);
    spec.capabilityDigest = digest(capability);
    var result = store.reserveExecution(spec);
    if (result.active) {
      var cached = live[spec.executionId];
      if (cached && cached.incarnationId === result.incarnation.incarnation_id &&
          digest(cached.capability) === result.incarnation.capability_digest) return cached;
      throw error("COOP_CONTROL_EXECUTION_ACTIVE", "The logical execution already has an active incarnation.");
    }
    var token = Object.freeze({
      executionId: spec.executionId,
      incarnationId: spec.incarnationId,
      epoch: result.epoch,
      role: spec.role,
      authorityId: spec.authorityId,
      capability: capability,
    });
    live[spec.executionId] = token;
    if (typeof faults.afterReserve === "function") faults.afterReserve(token);
    return token;
  }

  function targetKey(ref) {
    return ref.projectId + "\u0000" + ref.sessionStorageId;
  }

  function normalizeTargets(values) {
    var source = Array.isArray(values) ? values : [];
    var normalized = [];
    var seen = Object.create(null);
    for (var i = 0; i < source.length; i++) {
      var ref = projectIdentity.normalizeSessionRef(source[i]);
      if (!ref) throw error("COOP_CONTROL_EXECUTION_INVALID", "Recovery requires an exact target SessionRef.");
      var key = targetKey(ref);
      if (seen[key]) continue;
      seen[key] = true;
      normalized.push(ref);
    }
    return normalized;
  }

  function findRecoveryTargets(values) {
    var refs = normalizeTargets(values);
    return store.findExecutionRecoveryTargets(refs).map(function (row) {
      return { executionId: row.execution_id,
        sessionRef: { projectId: row.session_project_id, sessionStorageId: row.session_storage_id } };
    });
  }

  function recoverTarget(value) {
    assertOpen();
    var ref = projectIdentity.normalizeSessionRef(value);
    if (!ref) throw error("COOP_CONTROL_EXECUTION_INVALID", "Recovery requires an exact target SessionRef.");
    var key = targetKey(ref);
    var cached = recoveryTargets[key];
    if (cached) {
      try {
        var cachedState = current(cached);
        if (cachedState.incarnation.session_project_id === ref.projectId &&
            cachedState.incarnation.session_storage_id === ref.sessionStorageId) return cached;
      } catch (cause) {}
      delete recoveryTargets[key];
    }
    var capability = capabilitySecret(randomBytes);
    var next = { incarnationId: "inc:" + randomUUID(), capabilityDigest: digest(capability) };
    var rotated = store.rotateExecutionRecoveryTarget(ref, next);
    if (!rotated) return null;
    var token = Object.freeze({ executionId: rotated.execution_id,
      incarnationId: rotated.incarnation_id, epoch: Number(rotated.epoch), role: rotated.role,
      authorityId: rotated.authority_id, capability: capability });
    live[token.executionId] = token;
    recoveryTargets[key] = token;
    return token;
  }

  function recoverTargets(values) {
    var refs = normalizeTargets(values);
    var recovered = [];
    for (var i = 0; i < refs.length; i++) {
      var token = recoverTarget(refs[i]);
      if (token) recovered.push(token);
    }
    return recovered;
  }

  function current(token) {
    assertOpen();
    if (!token || typeof token.capability !== "string") {
      throw error("COOP_CONTROL_FENCE_REJECTED", "Execution capability is missing.");
    }
    return store.assertCurrentExecution(publicRef(token));
  }

  function actionAllowed(currentState, action) {
    if (action === "provider_start") {
      return currentState.incarnation.start_state === "ready" ||
        currentState.incarnation.start_state === "started";
    }
    return currentState.incarnation.start_state === "started";
  }

  function assertCapability(token, action) {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      throw error("COOP_CONTROL_AUTHORITY_DENIED", "The authority does not permit that action.");
    }
    var state = current(token);
    if ((Number(state.authority.action_mask) & ACTIONS[action]) !== ACTIONS[action]) {
      throw error("COOP_CONTROL_AUTHORITY_DENIED", "The authority does not permit that action.");
    }
    if (!actionAllowed(state, action)) {
      throw error("COOP_CONTROL_START_BARRIER_CLOSED", "The execution start barrier is not open for that action.");
    }
    if (action === "provider_start" && typeof faults.beforeProviderStart === "function") {
      faults.beforeProviderStart(token);
    }
    return true;
  }

  function bindStart(token, ref) {
    var normalized = projectIdentity.normalizeSessionRef(ref);
    if (!normalized) throw error("COOP_CONTROL_EXECUTION_INVALID", "A valid SessionRef is required before start.");
    store.bindExecutionStart(publicRef(token), normalized);
    if (typeof faults.afterBind === "function") faults.afterBind(token, normalized);
    return true;
  }

  function openStartBarrier(token) {
    store.openExecutionBarrier(publicRef(token));
    if (typeof faults.afterBarrier === "function") faults.afterBarrier(token);
    return true;
  }

  function markProviderStarted(token) {
    var state = current(token);
    if (state.incarnation.start_state === "started") return true;
    if (state.incarnation.start_state !== "ready") {
      throw error("COOP_CONTROL_START_BARRIER_CLOSED", "The execution start barrier is not open.");
    }
    store.markExecutionStarted(publicRef(token));
    if (typeof faults.afterProviderStarted === "function") faults.afterProviderStarted(token);
    return true;
  }

  function abandon(token, reason, staleR6Receipt) {
    var code = String(reason || "execution_failed");
    if (!validation.IDENTIFIER_RE.test(code)) code = "execution_failed";
    var result = staleR6Receipt ?
      store.reconcileStaleR6Execution(publicRef(token), staleR6Receipt) :
      store.abandonExecution(publicRef(token), code);
    delete live[token.executionId];
    return result;
  }

  function reconcileStaleR6ControlExecution(spec) {
    assertOpen();
    var input = spec || {};
    var receipt = {
      receiptId: input.receiptId,
      requestDigest: input.requestDigest,
      executionId: input.executionId,
      authorityId: input.authorityId,
      incarnationId: input.incarnationId,
      epoch: input.epoch,
      role: input.role,
    };
    var token = live[input.executionId];
    if (!token) {
      return store.reconcileStaleR6Execution(receipt, receipt);
    }
    if (token.executionId !== receipt.executionId || token.authorityId !== receipt.authorityId ||
        token.incarnationId !== receipt.incarnationId || token.epoch !== receipt.epoch ||
        token.role !== receipt.role) {
      throw error("COOP_CONTROL_FENCE_REJECTED",
        "The stale R6 reconciliation does not hold the current in-memory execution capability.");
    }
    return abandon(token, "terminal_binding_reconciled", receipt);
  }

  function complete(token) {
    assertCapability(token, "completion");
    store.completeExecution(publicRef(token));
    delete live[token.executionId];
    return true;
  }

  function recoverIncomplete(excludedExecutionIds) {
    var excluded = Object.create(null);
    var ids = Array.isArray(excludedExecutionIds) ? excludedExecutionIds : [];
    var retained = Object.create(null);
    for (var i = 0; i < ids.length; i++) excluded[ids[i]] = true;
    var executionIds = Object.keys(live);
    for (var executionIndex = 0; executionIndex < executionIds.length; executionIndex++) {
      if (excluded[executionIds[executionIndex]]) {
        retained[executionIds[executionIndex]] = live[executionIds[executionIndex]];
      }
    }
    live = retained;
    var targetIds = Object.keys(recoveryTargets);
    for (var targetIndex = 0; targetIndex < targetIds.length; targetIndex++) {
      if (!excluded[recoveryTargets[targetIds[targetIndex]].executionId]) {
        delete recoveryTargets[targetIds[targetIndex]];
      }
    }
    return store.recoverIncompleteExecutions(ids);
  }

  function inspect(executionId) {
    var value = store.inspectExecution(executionId);
    if (!value) return null;
    var incarnations = value.incarnations.map(camelIncarnation);
    var execution = camelExecution(value.execution);
    return {
      authority: camelAuthority(value.authority),
      execution: execution,
      incarnations: incarnations,
      current: incarnations.filter(function (item) { return item.epoch === execution.currentEpoch; })[0] || null,
      leases: value.leases.map(camelLease),
    };
  }

  function createFence(token) {
    return Object.freeze({
      refs: Object.freeze({
        executionId: token.executionId, incarnationId: token.incarnationId,
        epoch: token.epoch, role: token.role, authorityId: token.authorityId,
      }),
      assert: function (action) { return assertCapability(token, action); },
      isIncarnationCurrent: function () {
        try { current(token); return true; } catch (cause) { return false; }
      },
      isCurrent: function (action) {
        try { return assertCapability(token, action); } catch (cause) { return false; }
      },
      markProviderStarted: function () { return markProviderStarted(token); },
      complete: function () { return complete(token); },
      abandon: function (reason) { return abandon(token, reason); },
    });
  }

  return {
    enabled: true,
    abandon: abandon,
    assertCapability: assertCapability,
    bindStart: bindStart,
    close: function () { closed = true; live = Object.create(null);
      recoveryTargets = Object.create(null); if (ownsStore) store.close(); },
    complete: complete,
    createFence: createFence,
    findRecoveryTargets: findRecoveryTargets,
    getStore: function () { return store; },
    getStaleR6ReconciliationReceipt: function (receiptId) {
      return store.getStaleR6ReconciliationReceipt(receiptId);
    },
    inspect: inspect,
    markProviderStarted: markProviderStarted,
    openStartBarrier: openStartBarrier,
    recoverIncomplete: recoverIncomplete,
    recoverTarget: recoverTarget,
    recoverTargets: recoverTargets,
    reconcileStaleR6ControlExecution: reconcileStaleR6ControlExecution,
    reserveStart: reserveStart,
  };
}

module.exports = {
  ACTIONS: ACTIONS,
  ALL_ACTIONS_MASK: ALL_ACTIONS_MASK,
  EXECUTION_CONTROL_ENV: EXECUTION_CONTROL_ENV,
  createExecutionControl: createExecutionControl,
  isExecutionControlEnabled: isExecutionControlEnabled,
};
