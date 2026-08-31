// Attested runtime activation substrate for one emergency repair. It never
// patches a running process. A caller must present a clean source capsule,
// drain/checkpoint evidence, then atomically move a release pointer and prove
// the new pointer before the repair can re-enter ordinary coordination.

var schema = require("./coop-emergency-repair-schema");

function runtimeError(code, message) {
  return schema.error(code, message);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw runtimeError("EMERGENCY_REPAIR_RUNTIME_INVALID", label + " must be a plain object.");
  }
  var allowed = {};
  for (var i = 0; i < fields.length; i++) allowed[fields[i]] = true;
  var keys = Object.keys(value);
  for (var j = 0; j < keys.length; j++) {
    if (!allowed[keys[j]]) throw runtimeError("EMERGENCY_REPAIR_RUNTIME_INVALID", label + " has an unknown field.");
  }
  for (var k = 0; k < fields.length; k++) {
    if (!Object.prototype.hasOwnProperty.call(value, fields[k])) {
      throw runtimeError("EMERGENCY_REPAIR_RUNTIME_INVALID", label + " is missing " + fields[k] + ".");
    }
  }
  return value;
}

function normalizeCapsule(value) {
  var source = exactObject(value, [
    "version", "repairId", "sourceDigest", "releaseDigest", "baseReleaseDigest",
    "snapshotId", "checkpointId", "drainReceipt", "probeDigest", "clean", "attestedAt",
  ], "runtime capsule");
  if (source.version !== 1 || !/^repair:[a-f0-9]{48}$/.test(source.repairId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(source.snapshotId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(source.checkpointId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(source.drainReceipt) ||
      source.clean !== true || !Number.isSafeInteger(source.attestedAt) || source.attestedAt < 0) {
    throw runtimeError("EMERGENCY_REPAIR_RUNTIME_INVALID", "Runtime capsule is not a clean v1 capsule.");
  }
  schema.digest(source.sourceDigest, "runtime capsule.sourceDigest");
  schema.digest(source.releaseDigest, "runtime capsule.releaseDigest");
  schema.digest(source.baseReleaseDigest, "runtime capsule.baseReleaseDigest");
  schema.digest(source.probeDigest, "runtime capsule.probeDigest");
  return {
    version: 1,
    repairId: source.repairId,
    sourceDigest: source.sourceDigest,
    releaseDigest: source.releaseDigest,
    baseReleaseDigest: source.baseReleaseDigest,
    snapshotId: source.snapshotId,
    checkpointId: source.checkpointId,
    drainReceipt: source.drainReceipt,
    probeDigest: source.probeDigest,
    clean: true,
    attestedAt: source.attestedAt,
  };
}

function signCapsule(capsule, authenticator) {
  if (!authenticator || typeof authenticator.sign !== "function") {
    throw runtimeError("EMERGENCY_REPAIR_RUNTIME_AUTH", "Runtime capsule signer is unavailable.");
  }
  var normalized = normalizeCapsule(capsule);
  var payload = { capsule: normalized, capsuleDigest: schema.stableDigest(normalized) };
  return Object.assign({}, payload, { signature: authenticator.sign(payload) });
}

function verifyCapsule(envelope, authenticator) {
  var source = exactObject(envelope, ["capsule", "capsuleDigest", "signature"], "runtime capsule envelope");
  if (!authenticator || typeof authenticator.verify !== "function") {
    throw runtimeError("EMERGENCY_REPAIR_RUNTIME_AUTH", "Runtime capsule verifier is unavailable.");
  }
  var capsule = normalizeCapsule(source.capsule);
  var payload = { capsule: capsule, capsuleDigest: schema.stableDigest(capsule) };
  if (payload.capsuleDigest !== source.capsuleDigest || !authenticator.verify(payload, source.signature)) {
    throw runtimeError("EMERGENCY_REPAIR_RUNTIME_AUTH", "Runtime capsule signature or digest is invalid.");
  }
  return Object.assign({}, payload, { signature: source.signature });
}

function validatePreparation(prepared, capsule) {
  var source = exactObject(prepared,
    ["snapshotId", "checkpointId", "drainReceipt", "currentReleaseDigest", "rollbackDigest"],
    "runtime activation preparation");
  if (source.snapshotId !== capsule.snapshotId || source.checkpointId !== capsule.checkpointId ||
      source.drainReceipt !== capsule.drainReceipt || source.currentReleaseDigest !== capsule.baseReleaseDigest ||
      source.rollbackDigest !== capsule.baseReleaseDigest) {
    throw runtimeError("EMERGENCY_REPAIR_RUNTIME_PREPARE", "Runtime preparation does not match the attested capsule.");
  }
  return source;
}

// Driver contract:
//   prepare(capsule) -> exact snapshot/checkpoint/drain evidence
//   compareAndSwapRelease(expectedDigest, nextDigest) -> true iff pointer moved
//   probe(capsule) -> { ok: true, probeDigest }
//   rollbackRelease(expectedDigest, rollbackDigest) -> true iff restored
// No command, config, secret, or database handle is exposed to this boundary.
function activateRelease(envelope, authenticator, driver) {
  if (!driver || typeof driver.prepare !== "function" ||
      typeof driver.compareAndSwapRelease !== "function" || typeof driver.probe !== "function" ||
      typeof driver.rollbackRelease !== "function") {
    throw runtimeError("EMERGENCY_REPAIR_RUNTIME_UNAVAILABLE", "Runtime activation driver is unavailable.");
  }
  var verified = verifyCapsule(envelope, authenticator);
  var capsule = verified.capsule;
  var prepared = validatePreparation(driver.prepare(capsule), capsule);
  if (driver.compareAndSwapRelease(capsule.baseReleaseDigest, capsule.releaseDigest) !== true) {
    throw runtimeError("EMERGENCY_REPAIR_RUNTIME_POINTER_CONFLICT", "Release pointer changed before emergency activation.");
  }
  var probe;
  try {
    probe = driver.probe(capsule);
  } catch (cause) {
    probe = null;
  }
  if (!probe || probe.ok !== true || probe.probeDigest !== capsule.probeDigest) {
    var restored = driver.rollbackRelease(capsule.releaseDigest, prepared.rollbackDigest) === true;
    if (!restored) {
      throw runtimeError("EMERGENCY_REPAIR_RUNTIME_ROLLBACK_FAILED",
        "Emergency release probe failed and its pointer could not be restored.");
    }
    throw runtimeError("EMERGENCY_REPAIR_RUNTIME_PROBE_FAILED",
      "Emergency release probe failed; the release pointer was rolled back.");
  }
  return {
    activated: true,
    repairId: capsule.repairId,
    releaseDigest: capsule.releaseDigest,
    rollbackDigest: prepared.rollbackDigest,
    capsuleDigest: verified.capsuleDigest,
  };
}

module.exports = {
  activateRelease: activateRelease,
  normalizeCapsule: normalizeCapsule,
  signCapsule: signCapsule,
  verifyCapsule: verifyCapsule,
};
