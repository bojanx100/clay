// EmergencyRepairPolicy v1 is a deliberately tiny break-glass state machine.
// It is not a second scheduler: it handles one authenticated owner-decision
// delivery failure, starts one idempotent visible repair worker, accepts an
// independent verifier's attestation, atomically activates an attested release,
// and re-enters the existing coordinator exactly once.

var manifestModule = require("./coop-emergency-repair-manifest");
var runtimeModule = require("./coop-emergency-repair-runtime");
var schema = require("./coop-emergency-repair-schema");

var FAILURE_CODE = "orchestrator_unavailable";
var ACTIVE = { escrowed: true, leased: true, worker_bootstrapped: true, verified: true, activated: true };
var TERMINAL = { reentered: true, revoked: true, failed: true };
var OWNER_STATES = { blocked: true, failed: true, needs_input: true, waiting_user: true };

function policyError(code, message) {
  return schema.error(code, message);
}

function clone(value) {
  return schema.clone(value);
}

function receiptIdFor(repairId) {
  return "repair-receipt:" + schema.sha256(repairId).slice(0, 48);
}

function fenceFor(repairId, epoch) {
  return schema.sha256(repairId + "\u0000" + epoch);
}

function event(record, kind, now, details) {
  var events = Array.isArray(record.events) ? record.events.slice() : [];
  events.push(Object.assign({ kind: kind, at: now }, details || {}));
  if (events.length > 32) events.splice(0, events.length - 32);
  record.events = events;
}

function releaseLease(record, at) {
  if (!record.lease) return;
  record.lease = Object.assign({}, record.lease, { expiresAt: 0, releasedAt: at });
}

function result(ok, code, extra) {
  return Object.assign({ ok: !!ok, code: code || "" }, extra || {});
}

function cleanNote(value) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 4000);
}

function normalizeAction(value) {
  var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var decision = String(source.decision || "");
  var note = cleanNote(source.note);
  var directiveDigest = String(source.directiveDigest || "");
  if ((decision !== "advance" && decision !== "request_changes") ||
      (decision === "request_changes" && !note) || !/^[a-f0-9]{64}$/.test(directiveDigest)) {
    throw policyError("EMERGENCY_REPAIR_ACTION_INVALID", "Emergency repair action escrow is invalid.");
  }
  var normalized = { decision: decision, note: decision === "request_changes" ? note : "",
    directiveDigest: directiveDigest };
  return Object.assign(normalized, { actionDigest: schema.stableDigest(normalized) });
}

function equalBindingInput(binding, input) {
  try {
    return schema.bindingMatches(binding, schema.normalizeBinding(input));
  } catch (cause) {
    return false;
  }
}

function normalFailure(value) {
  var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (source.code !== FAILURE_CODE || typeof source.observedAt !== "number" ||
      !Number.isSafeInteger(source.observedAt) || source.observedAt < 0 ||
      typeof source.observer !== "string" || source.observer.length < 1 || source.observer.length > 256) {
    throw policyError("EMERGENCY_REPAIR_FAILURE_INVALID", "The supplied failure is not the named repairable bridge failure.");
  }
  return { code: FAILURE_CODE, observedAt: source.observedAt, observer: source.observer };
}

function workerEvidence(value, binding, repairId) {
  var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var ref;
  try { ref = schema.exactSessionRef(source.workerRef, "repair worker ref"); }
  catch (cause) { throw policyError("EMERGENCY_REPAIR_WORKER_INVALID", "Emergency worker did not return an exact SessionRef."); }
  if (source.repairId !== repairId || ref.projectId !== binding.targetProject.projectId ||
      source.visible !== true || source.durable !== true || typeof source.receiptId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(source.receiptId)) {
    throw policyError("EMERGENCY_REPAIR_WORKER_INVALID", "Emergency worker bootstrap evidence is invalid.");
  }
  return { workerRef: ref, visible: true, durable: true, receiptId: source.receiptId };
}

function createEmergencyRepairPolicy(options) {
  var opts = options || {};
  var binding = schema.normalizeBinding(opts.binding);
  var journal = opts.journal;
  var authenticator = opts.authenticator;
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var leaseMs = Number.isSafeInteger(opts.leaseMs) && opts.leaseMs > 0 && opts.leaseMs <= 300000 ?
    opts.leaseMs : 60000;
  if (!journal || journal.durable !== true || typeof journal.read !== "function" ||
      typeof journal.compareAndSwap !== "function") {
    throw policyError("EMERGENCY_REPAIR_JOURNAL_UNAVAILABLE", "Emergency repair requires a durable compare-and-swap journal.");
  }
  if (!authenticator || typeof authenticator.sign !== "function" ||
      typeof authenticator.verify !== "function") {
    throw policyError("EMERGENCY_REPAIR_AUTH_UNAVAILABLE", "Emergency repair requires an authenticated receipt signer.");
  }
  var signedManifest = manifestModule.verifyManifest(opts.manifest, authenticator);
  if (opts.projectRoot) manifestModule.verifyPaths(signedManifest, opts.projectRoot, authenticator, opts);
  var bootstrapWorker = typeof opts.bootstrapWorker === "function" ? opts.bootstrapWorker : null;
  var independentVerifier = typeof opts.independentVerifier === "function" ? opts.independentVerifier : null;
  var runtimeDriver = opts.runtimeDriver || null;
  var reenterCoordinator = typeof opts.reenterCoordinator === "function" ? opts.reenterCoordinator : null;

  function timestamp() {
    var value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw policyError("EMERGENCY_REPAIR_CLOCK_INVALID", "Emergency repair clock is invalid.");
    }
    return value;
  }

  function read(repairId) {
    var record = journal.read(repairId);
    return record ? clone(record) : null;
  }

  function save(previous, next) {
    var resultValue = journal.compareAndSwap(next.repairId, previous ? previous.revision : null, next);
    if (!resultValue || resultValue.ok !== true) {
      throw policyError("EMERGENCY_REPAIR_CAS_CONFLICT", "Emergency repair journal changed concurrently.");
    }
    return resultValue.record || next;
  }

  function immutableFor(action, failure) {
    return {
      version: 1,
      recipe: schema.RECIPE,
      binding: clone(binding),
      actionEscrow: action,
      failure: { code: failure.code, observer: failure.observer },
      manifestDigest: signedManifest.manifestDigest,
    };
  }

  function receiptFor(repairId, immutable, failure, at) {
    var payload = { version: 1, receiptId: receiptIdFor(repairId), repairId: repairId,
      kind: "owner_decision_delivery_failure", observedAt: failure.observedAt, issuedAt: at,
      immutableDigest: schema.stableDigest(immutable) };
    return Object.assign(payload, { signature: authenticator.sign(payload) });
  }

  function validRecord(record) {
    if (!record || typeof record !== "object" || !/^repair:[a-f0-9]{48}$/.test(record.repairId) ||
        !Number.isSafeInteger(record.revision) || record.revision < 1 || !record.immutable ||
        !record.receipt || !ACTIVE[record.status] && !TERMINAL[record.status]) {
      throw policyError("EMERGENCY_REPAIR_JOURNAL_CORRUPT", "Emergency repair journal record is invalid.");
    }
    var receipt = record.receipt;
    var payload = { version: receipt.version, receiptId: receipt.receiptId, repairId: receipt.repairId,
      kind: receipt.kind, observedAt: receipt.observedAt, issuedAt: receipt.issuedAt,
      immutableDigest: receipt.immutableDigest };
    if (!authenticator.verify(payload, receipt.signature) || receipt.repairId !== record.repairId ||
        receipt.immutableDigest !== schema.stableDigest(record.immutable)) {
      throw policyError("EMERGENCY_REPAIR_RECEIPT_INVALID", "Emergency repair receipt authentication failed.");
    }
    return record;
  }

  function escrowOwnerDecision(input) {
    var source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (!equalBindingInput(binding, source.binding) || source.recipe !== schema.RECIPE ||
        source.actorId !== binding.ownerActorId || source.ownerIngressId !== binding.ownerIngressId ||
        source.ownerDecisionRef !== binding.ownerDecisionRef || !OWNER_STATES[source.taskState]) {
      return result(false, "repair_scope_denied");
    }
    var action;
    var failure;
    try { action = normalizeAction(source.action); failure = normalFailure(source.failure); }
    catch (cause) { return result(false, cause.code || "repair_invalid"); }
    var repairId = schema.repairIdFor(binding);
    var immutable = immutableFor(action, failure);
    var existing = read(repairId);
    if (existing) {
      validRecord(existing);
      if (schema.stableDigest(existing.immutable) !== schema.stableDigest(immutable)) {
        return result(false, "repair_replay_conflict");
      }
      return Object.assign(result(true, "", { repairId: repairId, replay: true, status: existing.status }),
        bootstrapWorker && !existing.worker &&
          (existing.status === "escrowed" || existing.status === "leased") ? bootstrap(repairId) : {});
    }
    var at = timestamp();
    var record = {
      repairId: repairId,
      revision: 1,
      status: "escrowed",
      immutable: immutable,
      receipt: receiptFor(repairId, immutable, failure, at),
      lease: null,
      worker: null,
      verifier: null,
      activation: null,
      reentry: null,
      events: [],
    };
    event(record, "escrowed", at, { failureCode: FAILURE_CODE });
    try { save(null, record); }
    catch (cause) {
      if (cause.code !== "EMERGENCY_REPAIR_CAS_CONFLICT") return result(false, cause.code || "repair_journal_failed");
      return escrowOwnerDecision(source);
    }
    var out = result(true, "", { repairId: repairId, replay: false, status: "escrowed" });
    if (!bootstrapWorker) return out;
    var bootstrapped = bootstrap(repairId);
    return bootstrapped.ok ? Object.assign(out, bootstrapped) : bootstrapped;
  }

  function acquireLease(repairId, holder) {
    if (typeof holder !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(holder)) {
      return result(false, "repair_lease_invalid");
    }
    var record = validRecord(read(repairId));
    if (TERMINAL[record.status]) return result(false, "repair_terminal", { status: record.status });
    var at = timestamp();
    if (record.lease && record.lease.expiresAt > at && record.lease.holder !== holder) {
      return result(false, "repair_lease_held", { status: record.status });
    }
    if (record.lease && record.lease.expiresAt > at && record.lease.holder === holder) {
      return result(true, "", { record: record, lease: clone(record.lease) });
    }
    var next = clone(record);
    var epoch = Number(record.lease && record.lease.epoch || 0) + 1;
    next.revision++;
    // Leasing protects a transition; it is not an execution phase. Replacing
    // `verified` with `worker_bootstrapped` here would make a lease renewal
    // replay a completed stage and defeat the activation fence.
    next.status = record.status === "escrowed" ? "leased" : record.status;
    next.lease = { holder: holder, epoch: epoch, fencingToken: fenceFor(repairId, epoch), expiresAt: at + leaseMs };
    event(next, "lease_acquired", at, { epoch: epoch });
    try { next = save(record, next); }
    catch (cause) { return result(false, "repair_lease_conflict"); }
    return result(true, "", { record: next, lease: clone(next.lease) });
  }

  function leaseRecord(repairId, holder, token) {
    var leased = acquireLease(repairId, holder);
    if (!leased.ok) return leased;
    if (token && leased.lease.fencingToken !== token) return result(false, "repair_fenced");
    return leased;
  }

  function bootstrap(repairId, suppliedHolder) {
    if (!bootstrapWorker) return result(false, "repair_bootstrap_unavailable");
    var holder = suppliedHolder || "emergency-bootstrap";
    var leased = leaseRecord(repairId, holder);
    if (!leased.ok) return leased;
    var record = leased.record;
    if (record.worker) return result(true, "", { repairId: repairId, status: record.status,
      worker: clone(record.worker), replay: true });
    var reply;
    try {
      reply = bootstrapWorker({ repairId: repairId, recipe: schema.RECIPE,
        binding: clone(binding), actionEscrow: clone(record.immutable.actionEscrow),
        manifest: clone(signedManifest), lease: clone(leased.lease) });
      if (reply && typeof reply.then === "function") {
        throw policyError("EMERGENCY_REPAIR_BOOTSTRAP_ASYNC", "Emergency bootstrap must return a durable receipt synchronously.");
      }
      reply = workerEvidence(reply, binding, repairId);
    } catch (cause) {
      return result(false, cause.code || "repair_bootstrap_failed");
    }
    var current = validRecord(read(repairId));
    if (current.worker) return result(true, "", { repairId: repairId, status: current.status,
      worker: clone(current.worker), replay: true });
    if (!current.lease || current.lease.fencingToken !== leased.lease.fencingToken) {
      return result(false, "repair_fenced");
    }
    var next = clone(current);
    next.revision++;
    next.status = "worker_bootstrapped";
    next.worker = reply;
    var completedAt = timestamp();
    releaseLease(next, completedAt);
    event(next, "worker_bootstrapped", completedAt, { receiptId: reply.receiptId });
    try { next = save(current, next); }
    catch (cause) { return result(false, "repair_bootstrap_conflict"); }
    return result(true, "", { repairId: repairId, status: next.status, worker: clone(reply), replay: false });
  }

  function verify(repairId, evidence, holder) {
    if (!independentVerifier) return result(false, "repair_verifier_unavailable");
    var leased = leaseRecord(repairId, holder || "emergency-verifier");
    if (!leased.ok) return leased;
    var record = leased.record;
    if (record.status === "verified" || record.status === "activated" || record.status === "reentered") {
      return result(true, "", { repairId: repairId, status: record.status, replay: true });
    }
    if (record.status !== "worker_bootstrapped") return result(false, "repair_not_ready", { status: record.status });
    var verdict;
    try {
      verdict = independentVerifier({ repairId: repairId, worker: clone(record.worker),
        manifest: clone(signedManifest), evidence: clone(evidence), binding: clone(binding),
        fence: clone(leased.lease) });
      if (!verdict || verdict.passed !== true || typeof verdict.verifierId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(verdict.verifierId) ||
          verdict.verifierId === record.worker.workerRef.sessionStorageId ||
          verdict.manifestDigest !== signedManifest.manifestDigest) {
        throw policyError("EMERGENCY_REPAIR_VERIFIER_INVALID", "Independent verifier evidence is invalid.");
      }
      manifestModule.assertPatchSize(verdict.patchBytes, signedManifest, authenticator);
      var capsule = runtimeModule.verifyCapsule(verdict.capsule, authenticator);
      if (capsule.capsule.repairId !== repairId) {
        throw policyError("EMERGENCY_REPAIR_VERIFIER_INVALID", "Verifier returned a capsule for another repair.");
      }
      verdict = { verifierId: verdict.verifierId, manifestDigest: verdict.manifestDigest,
        patchBytes: verdict.patchBytes, capsule: capsule };
    } catch (cause) { return result(false, cause.code || "repair_verifier_failed"); }
    var current = validRecord(read(repairId));
    if (!current.lease || current.lease.fencingToken !== leased.lease.fencingToken) return result(false, "repair_fenced");
    var next = clone(current);
    next.revision++;
    next.status = "verified";
    next.verifier = verdict;
    var verifiedAt = timestamp();
    releaseLease(next, verifiedAt);
    event(next, "verified", verifiedAt, { verifierId: verdict.verifierId });
    try { next = save(current, next); }
    catch (cause) { return result(false, "repair_verifier_conflict"); }
    return result(true, "", { repairId: repairId, status: next.status, replay: false });
  }

  function activate(repairId, holder) {
    var leased = leaseRecord(repairId, holder || "emergency-activator");
    if (!leased.ok) return leased;
    var record = leased.record;
    if (record.status === "activated" || record.status === "reentered") {
      return result(true, "", { repairId: repairId, status: record.status, replay: true });
    }
    if (record.status !== "verified") return result(false, "repair_not_verified", { status: record.status });
    var activation;
    try { activation = runtimeModule.activateRelease(record.verifier.capsule, authenticator, runtimeDriver); }
    catch (cause) { return result(false, cause.code || "repair_activation_failed"); }
    var current = validRecord(read(repairId));
    if (!current.lease || current.lease.fencingToken !== leased.lease.fencingToken) return result(false, "repair_fenced");
    var next = clone(current);
    next.revision++;
    next.status = "activated";
    next.activation = activation;
    var activatedAt = timestamp();
    releaseLease(next, activatedAt);
    event(next, "activated", activatedAt, { releaseDigest: activation.releaseDigest });
    try { next = save(current, next); }
    catch (cause) { return result(false, "repair_activation_conflict"); }
    return result(true, "", { repairId: repairId, status: next.status, replay: false });
  }

  function reenter(repairId, holder) {
    if (!reenterCoordinator) return result(false, "repair_reentry_unavailable");
    var previous = validRecord(read(repairId));
    if (previous.status === "reentered") {
      return result(true, "", { repairId: repairId, status: previous.status, replay: true });
    }
    var leased = leaseRecord(repairId, holder || "emergency-reentry");
    if (!leased.ok) return leased;
    var record = leased.record;
    if (record.status !== "activated") return result(false, "repair_not_activated", { status: record.status });
    var receipt;
    try {
      receipt = reenterCoordinator({ repairId: repairId, actionEscrow: clone(record.immutable.actionEscrow),
        binding: clone(binding), fence: clone(leased.lease) });
      if (!receipt || typeof receipt.receiptId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(receipt.receiptId) ||
          receipt.actionDigest !== record.immutable.actionEscrow.actionDigest ||
          !schema.bindingMatches(binding, receipt.binding || binding)) {
        throw policyError("EMERGENCY_REPAIR_REENTRY_INVALID", "Normal coordinator re-entry receipt is invalid.");
      }
    } catch (cause) { return result(false, cause.code || "repair_reentry_failed"); }
    var current = validRecord(read(repairId));
    if (!current.lease || current.lease.fencingToken !== leased.lease.fencingToken) return result(false, "repair_fenced");
    var next = clone(current);
    next.revision++;
    next.status = "reentered";
    next.reentry = { receiptId: receipt.receiptId, actionDigest: receipt.actionDigest };
    var reenteredAt = timestamp();
    next.lease = Object.assign({}, next.lease, { revokedAt: reenteredAt, expiresAt: 0 });
    event(next, "reentered", reenteredAt, { receiptId: receipt.receiptId });
    try { next = save(current, next); }
    catch (cause) { return result(false, "repair_reentry_conflict"); }
    return result(true, "", { repairId: repairId, status: next.status, replay: false });
  }

  return {
    acquireLease: acquireLease,
    activate: activate,
    bootstrap: bootstrap,
    binding: function () { return clone(binding); },
    escrowOwnerDecision: escrowOwnerDecision,
    inspect: function (repairId) { var record = read(repairId); return record && validRecord(record) && clone(record); },
    reenter: reenter,
    verify: verify,
  };
}

module.exports = {
  FAILURE_CODE: FAILURE_CODE,
  createEmergencyRepairPolicy: createEmergencyRepairPolicy,
};
