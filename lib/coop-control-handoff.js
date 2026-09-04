// Monotonic Slice 3 handoff controller. Preparation is reversible; cutover
// atomically advances the execution epoch and all later failures roll forward.

var crypto = require("crypto");
var continuity = require("./coop-control-continuity");
var controlStore = require("./coop-control-store");
var continuityVerifierModule = require("./coop-control-continuity-verifier");
var executions = require("./coop-control-executions");
var projectIdentity = require("./project-identity");
var validation = require("./coop-control-store-validation");

var RECOVERY_ENV = "CLAY_COOP_CONTROL_RECOVERY";
var REASONS = Object.freeze(Object.assign(Object.create(null), {
  capacity_exhausted: true, context_exhausted: true, empty_turns: true,
  owner_stuck: true, provider_unhealthy: true, reasoning_corruption: true,
  wedged_thread: true,
}));

function error(code, message) {
  return validation.taggedError(code, message);
}

function isHandoffControlEnabled(options) {
  var opts = options || {};
  if (typeof opts.enabled === "boolean") return opts.enabled;
  var env = opts.env || process.env;
  return !!(env && env[controlStore.CONTROL_STORE_ENV] === "1" &&
    env[executions.EXECUTION_CONTROL_ENV] === "1" && env[RECOVERY_ENV] === "1");
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function identity(prefix, fields) {
  return prefix + ":" + digest(fields.join("\u0000")).slice(0, 48);
}

function publicRef(token) {
  return { executionId: token.executionId, incarnationId: token.incarnationId,
    epoch: token.epoch, role: token.role, authorityId: token.authorityId,
    capabilityDigest: digest(token.capability) };
}

function tokenFor(row, capability) {
  return Object.freeze({ executionId: row.execution_id, incarnationId: row.to_incarnation_id,
    epoch: Number(row.to_epoch), role: row.role || null, authorityId: row.authority_id || null,
    capability: capability });
}

function disabledControl() {
  return {
    enabled: false,
    abort: function () { return false; }, checkpoint: function () { return null; },
    close: function () {}, complete: function () { return false; },
    cutover: function () { return false; }, ensureSuccessor: function () { return false; },
    inspect: function () { return null; }, listRecoverable: function () { return []; },
    prepare: function () { return { enabled: false, bypass: true }; },
    recover: function () { return false; },
  };
}

function exactInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw error("COOP_CONTROL_HANDOFF_INVALID", "Handoff input must be a plain object.");
  }
  var allowed = { class: true, continuity: true, from: true, predecessor: true,
    reason: true, successor: true };
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    if (!allowed[keys[i]]) {
      if (validation.privacyAlias(keys[i])) {
        throw error("COOP_CONTROL_CONTINUITY_OUT_OF_SCOPE", "Handoff cannot contain private fields.");
      }
      throw error("COOP_CONTROL_HANDOFF_INVALID", "Handoff contains an unknown field.");
    }
  }
  var required = ["class", "continuity", "from", "predecessor", "reason"];
  for (var j = 0; j < required.length; j++) {
    if (!Object.prototype.hasOwnProperty.call(value, required[j])) {
      throw error("COOP_CONTROL_HANDOFF_INVALID", "Handoff is missing a required field.");
    }
  }
  return value;
}

function normalizeToken(value) {
  if (!value || typeof value !== "object" || typeof value.capability !== "string" ||
      !validation.IDENTIFIER_RE.test(value.executionId || "") ||
      !validation.IDENTIFIER_RE.test(value.incarnationId || "") ||
      !Number.isSafeInteger(value.epoch) || value.epoch <= 0 ||
      (value.role !== "coordinator" && value.role !== "worker") ||
      !validation.IDENTIFIER_RE.test(value.authorityId || "")) {
    throw error("COOP_CONTROL_HANDOFF_INVALID", "A current predecessor capability is required.");
  }
  return value;
}

function normalizeInput(value) {
  var source = exactInput(value);
  var from = projectIdentity.normalizeSessionRef(source.from);
  var predecessor = normalizeToken(source.predecessor);
  if (!from || (source.class !== "A" && source.class !== "B") ||
      !Object.prototype.hasOwnProperty.call(REASONS, source.reason)) {
    throw error("COOP_CONTROL_HANDOFF_INVALID", "Handoff class, reason, or predecessor SessionRef is invalid.");
  }
  var to = source.class === "A" ? from : projectIdentity.normalizeSessionRef(source.successor);
  if (!to || to.projectId !== from.projectId ||
      source.class === "B" && to.sessionStorageId === from.sessionStorageId) {
    throw error("COOP_CONTROL_HANDOFF_INVALID", "Class B requires one distinct successor in the same project.");
  }
  if (source.class === "A" && source.successor) {
    var explicit = projectIdentity.normalizeSessionRef(source.successor);
    if (!explicit || explicit.projectId !== from.projectId ||
        explicit.sessionStorageId !== from.sessionStorageId) {
      throw error("COOP_CONTROL_HANDOFF_INVALID", "Class A must retain its visible SessionRef.");
    }
  }
  return { handoffClass: source.class, reason: source.reason, predecessor: predecessor,
    from: from, to: to, packet: continuity.normalizeContinuityPacket(source.continuity) };
}

function camel(row) {
  if (!row) return null;
  return { handoffId: row.handoff_id, executionId: row.execution_id,
    handoffClass: row.handoff_class, reason: row.reason,
    from: { projectId: row.from_project_id, sessionStorageId: row.from_session_id },
    to: { projectId: row.to_project_id, sessionStorageId: row.to_session_id },
    fromIncarnationId: row.from_incarnation_id, fromEpoch: Number(row.from_epoch),
    toIncarnationId: row.to_incarnation_id, toEpoch: Number(row.to_epoch), state: row.state,
    successorState: row.successor_state, successorReceiptId: row.successor_receipt_id,
    packetDigest: row.packet_digest,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    cutoverAt: row.cutover_at === null ? null : Number(row.cutover_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    failureCode: row.failure_code };
}

function createHandoffControl(options) {
  var opts = options || {};
  if (!isHandoffControlEnabled(opts)) return disabledControl();
  var ownsStore = !opts.store;
  var storeOptions = { dbPath: opts.dbPath, faults: opts.storeFaults, fs: opts.fs, now: opts.now };
  if (Object.prototype.hasOwnProperty.call(opts, "sqliteModule")) storeOptions.sqliteModule = opts.sqliteModule;
  var store = opts.store || controlStore.openControlStore(storeOptions);
  var ownsExecution = !opts.executionControl;
  var executionControl = opts.executionControl || executions.createExecutionControl({
    enabled: true, store: store, faults: opts.executionFaults, now: opts.now,
    randomBytes: opts.randomBytes, randomUUID: opts.randomUUID,
  });
  var randomBytes = typeof opts.randomBytes === "function" ? opts.randomBytes : crypto.randomBytes;
  var randomUUID = typeof opts.randomUUID === "function" ? opts.randomUUID : crypto.randomUUID;
  var continuityVerifier = typeof opts.continuityVerifier === "function" ? opts.continuityVerifier :
    continuityVerifierModule.createContinuityVerifier({ executionControl: executionControl });
  var faults = opts.faults || {};
  var live = Object.create(null);
  var closed = false;

  function assertOpen() {
    if (closed) throw error("COOP_CONTROL_HANDOFF_CLOSED", "Handoff controller is closed.");
  }

  function inspect(handoffId) {
    assertOpen();
    return camel(store.getHandoff(handoffId));
  }

  function prepare(value) {
    assertOpen();
    var spec = normalizeInput(value);
    var handoffId = identity("handoff", [spec.predecessor.executionId, spec.predecessor.epoch,
      spec.from.projectId, spec.from.sessionStorageId, spec.reason]);
    var existing = store.getHandoff(handoffId);
    if (!existing) continuityVerifier(spec.packet, spec.predecessor, spec.from);
    var packetJson = continuity.canonicalPacketJson(spec.packet);
    var packetDigest = digest(packetJson);
    var capability = existing ? null : randomBytes(32).toString("base64url");
    var incarnationId = existing ? existing.to_incarnation_id : "inc:" + randomUUID();
    var capabilityDigest = existing ? existing.successor_capability_digest : digest(capability);
    if (!existing) executionControl.assertCapability(spec.predecessor, "callback");
    var durable = store.prepareHandoff({ handoffId: handoffId,
      checkpointId: identity("checkpoint", [handoffId, packetDigest]),
      executionId: spec.predecessor.executionId, handoffClass: spec.handoffClass,
      reason: spec.reason, predecessor: publicRef(spec.predecessor), from: spec.from, to: spec.to,
      toIncarnationId: incarnationId, successorCapabilityDigest: capabilityDigest,
      packetDigest: packetDigest, packetJson: packetJson });
    if (!existing) {
      live[handoffId] = { predecessor: spec.predecessor, successorCapability: capability };
    }
    if (typeof faults.afterPrepare === "function") faults.afterPrepare(camel(durable));
    return camel(durable);
  }

  function ensureSuccessor(handoffId, create) {
    assertOpen();
    var row = store.getHandoff(handoffId);
    if (!row) throw error("COOP_CONTROL_HANDOFF_NOT_FOUND", "Handoff does not exist.");
    if (row.handoff_class === "A" || row.successor_state === "created") return camel(row);
    if (typeof create !== "function") {
      throw error("COOP_CONTROL_HANDOFF_INVALID", "Class B successor creation requires an idempotent callback.");
    }
    var result = create({ projectId: row.to_project_id, sessionStorageId: row.to_session_id }, handoffId);
    if (!result || typeof result.then === "function" || typeof result !== "object" ||
        Object.getPrototypeOf(result) !== Object.prototype) {
      throw error("COOP_CONTROL_HANDOFF_INVALID", "Successor creation must synchronously return durable evidence.");
    }
    var ref = projectIdentity.normalizeSessionRef(result.sessionRef);
    if (!ref || ref.projectId !== row.to_project_id || ref.sessionStorageId !== row.to_session_id ||
        !validation.IDENTIFIER_RE.test(result.receiptId || "")) {
      throw error("COOP_CONTROL_HANDOFF_INVALID", "Successor evidence must name the exact preallocated SessionRef and receipt.");
    }
    if (typeof faults.afterSuccessorCreate === "function") faults.afterSuccessorCreate(camel(row));
    store.recordSuccessorReceipt(handoffId, ref, result.receiptId);
    return camel(store.markSuccessorCreated(handoffId, result.receiptId));
  }

  function successorToken(row, capability) {
    var execution = executionControl.inspect(row.execution_id);
    if (!execution) throw error("COOP_CONTROL_STORE_LOGICAL_CORRUPTION", "Handoff execution is missing.");
    return tokenFor(Object.assign({}, row, { role: execution.authority.role,
      authority_id: execution.authority.authorityId }), capability);
  }

  function cutover(handoffId) {
    assertOpen();
    var state = live[handoffId];
    var current = store.getHandoff(handoffId);
    if (!current) throw error("COOP_CONTROL_HANDOFF_NOT_FOUND", "Handoff does not exist.");
    if (!state || !state.predecessor || !state.successorCapability) {
      throw error("COOP_CONTROL_HANDOFF_RECOVERY_REQUIRED", "Handoff capability was lost and requires recovery.");
    }
    var row = store.cutoverHandoff(handoffId, publicRef(state.predecessor));
    var token = successorToken(row, state.successorCapability);
    state.token = token;
    if (typeof faults.afterCutover === "function") faults.afterCutover(camel(row), token);
    return { handoff: camel(row), token: token };
  }

  function recover(handoffId) {
    assertOpen();
    var row = store.getHandoff(handoffId);
    if (!row) throw error("COOP_CONTROL_HANDOFF_NOT_FOUND", "Handoff does not exist.");
    if (row.state === "prepared") {
      var predecessorCapability = randomBytes(32).toString("base64url");
      var predecessor = store.rotatePreparedHandoff(handoffId, {
        incarnationId: "inc:" + randomUUID(), capabilityDigest: digest(predecessorCapability),
      });
      var execution = executionControl.inspect(row.execution_id);
      var predecessorToken = Object.freeze({ executionId: row.execution_id,
        incarnationId: predecessor.incarnationId, epoch: predecessor.epoch,
        role: execution.authority.role, authorityId: execution.authority.authorityId,
        capability: predecessorCapability });
      live[handoffId] = { predecessor: null, successorCapability: predecessorCapability,
        token: predecessorToken };
      return { handoff: camel(predecessor.handoff), preCutover: true,
        target: { projectId: row.from_project_id, sessionStorageId: row.from_session_id },
        token: predecessorToken };
    }
    var capability = randomBytes(32).toString("base64url");
    row = store.rollForwardHandoff(handoffId,
      { incarnationId: "inc:" + randomUUID(), capabilityDigest: digest(capability) });
    var token = successorToken(row, capability);
    live[handoffId] = { predecessor: null, successorCapability: capability, token: token };
    if (typeof faults.afterRollForward === "function") faults.afterRollForward(camel(row), token);
    return { handoff: camel(row), token: token };
  }

  function complete(handoffId, token) {
    assertOpen();
    executionControl.assertCapability(token, "callback");
    return camel(store.completeHandoff(handoffId, publicRef(token)));
  }

  function abort(handoffId, reason) {
    assertOpen();
    var code = String(reason || "handoff_aborted");
    if (!validation.IDENTIFIER_RE.test(code)) code = "handoff_aborted";
    var row = store.abortHandoff(handoffId, code);
    delete live[handoffId];
    return camel(row);
  }

  return {
    enabled: true, abort: abort,
    checkpoint: function (id) { assertOpen(); return store.getCheckpoint(id); },
    close: function () { if (closed) return; closed = true; live = Object.create(null);
      if (ownsExecution) executionControl.close(); if (ownsStore) store.close(); },
    complete: complete, cutover: cutover, ensureSuccessor: ensureSuccessor, inspect: inspect,
    listRecoverable: function () { assertOpen(); return store.listHandoffs().filter(function (row) {
      return row.state === "prepared" || row.state === "cutover" || row.state === "replaying";
    }).map(camel); },
    prepare: prepare, recover: recover,
  };
}

module.exports = {
  RECOVERY_ENV: RECOVERY_ENV, REASONS: REASONS,
  attachCoopControlHandoff: createHandoffControl,
  createHandoffControl: createHandoffControl,
  createCoopControlHandoff: createHandoffControl,
  isHandoffControlEnabled: isHandoffControlEnabled,
};
