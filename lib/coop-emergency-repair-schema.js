// Strict, content-free schema primitives for the emergency repair boundary.
// These records name immutable refs and hashes only; repair instructions and
// provider conversation content never enter the durable repair journal.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");

var DIGEST_RE = /^[a-f0-9]{64}$/;
var IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
var OWNER_DECISION_RE = /^owner-decision-[a-f0-9]{24}$/;
var RECIPE = "owner_decision_delivery_missing_project_orchestrator";
var PLAN_DIGEST = "7e87def29c79b56d6c2fbbf83fe9a97d4e1a4a86584e9d4e0503b50fea905d38";
var PORTFOLIO_TASK_ID = "clay-implement-emergency-repair-policy-v1-20260831";

function error(code, message) {
  var value = new Error(message);
  value.code = code;
  return value;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw error("EMERGENCY_REPAIR_SCHEMA_INVALID", label + " must be a plain object.");
  }
  return value;
}

function exactObject(value, fields, label) {
  var source = plainObject(value, label);
  var allowed = {};
  for (var i = 0; i < fields.length; i++) allowed[fields[i]] = true;
  var keys = Object.keys(source);
  for (var j = 0; j < keys.length; j++) {
    if (!allowed[keys[j]]) {
      throw error("EMERGENCY_REPAIR_SCHEMA_INVALID", label + " has an unknown field.");
    }
  }
  for (var k = 0; k < fields.length; k++) {
    if (!Object.prototype.hasOwnProperty.call(source, fields[k])) {
      throw error("EMERGENCY_REPAIR_SCHEMA_INVALID", label + " is missing " + fields[k] + ".");
    }
  }
  return source;
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    throw error("EMERGENCY_REPAIR_SCHEMA_INVALID", label + " is invalid.");
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    throw error("EMERGENCY_REPAIR_SCHEMA_INVALID", (label || "digest") + " is invalid.");
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(function (item) { return canonicalize(item); }).join(",") + "]";
  }
  var keys = Object.keys(value).sort();
  var entries = [];
  for (var i = 0; i < keys.length; i++) {
    entries.push(JSON.stringify(keys[i]) + ":" + canonicalize(value[keys[i]]));
  }
  return "{" + entries.join(",") + "}";
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableDigest(value) {
  return sha256(canonicalize(value));
}

function equal(left, right) {
  var a = Buffer.from(String(left || ""));
  var b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createHmacAuthenticator(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw error("EMERGENCY_REPAIR_AUTH_INVALID", "Emergency repair requires a non-empty signing secret.");
  }
  function sign(payload) {
    return crypto.createHmac("sha256", secret).update(canonicalize(payload), "utf8").digest("hex");
  }
  return {
    sign: sign,
    verify: function (payload, signature) {
      return typeof signature === "string" && equal(sign(payload), signature);
    },
  };
}

function exactProjectRef(value, label) {
  var source = exactObject(value, ["projectId"], label);
  var ref = projectIdentity.normalizeProjectRef(source);
  if (!ref) throw error("EMERGENCY_REPAIR_SCHEMA_INVALID", label + " is invalid.");
  return ref;
}

function exactSessionRef(value, label) {
  var source = exactObject(value, ["projectId", "sessionStorageId"], label);
  var ref = projectIdentity.normalizeSessionRef(source);
  if (!ref) throw error("EMERGENCY_REPAIR_SCHEMA_INVALID", label + " is invalid.");
  return ref;
}

function exactTaskRef(value, label) {
  var source = exactObject(value,
    ["projectId", "coordinatorSessionStorageId", "taskId"], label);
  var ref = projectIdentity.normalizeTaskRef(source);
  if (!ref) throw error("EMERGENCY_REPAIR_SCHEMA_INVALID", label + " is invalid.");
  return ref;
}

function sameRef(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function normalizeBinding(value) {
  var source = exactObject(value, [
    "targetProject", "taskRef", "sourceSession", "ownerActorId", "ownerIngressId",
    "ownerDecisionRef", "portfolioTaskId", "bindingRevision", "planRevision", "planDigest",
  ], "repair binding");
  var targetProject = exactProjectRef(source.targetProject, "repair binding.targetProject");
  var taskRef = exactTaskRef(source.taskRef, "repair binding.taskRef");
  var sourceSession = exactSessionRef(source.sourceSession, "repair binding.sourceSession");
  if (taskRef.projectId !== targetProject.projectId ||
      sourceSession.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      typeof source.ownerActorId !== "string" || source.ownerActorId.length < 1 ||
      source.ownerActorId.length > 256 ||
      !/^coop:[A-Za-z0-9._-]{1,128}:[0-9]{1,12}$/.test(source.ownerIngressId) ||
      !OWNER_DECISION_RE.test(source.ownerDecisionRef) ||
      source.portfolioTaskId !== PORTFOLIO_TASK_ID ||
      source.bindingRevision !== 1 || source.planRevision !== 1 ||
      source.planDigest !== PLAN_DIGEST) {
    throw error("EMERGENCY_REPAIR_SCHEMA_INVALID", "Repair binding is not the approved v1 scope.");
  }
  return {
    targetProject: targetProject,
    taskRef: taskRef,
    sourceSession: sourceSession,
    ownerActorId: source.ownerActorId,
    ownerIngressId: source.ownerIngressId,
    ownerDecisionRef: source.ownerDecisionRef,
    portfolioTaskId: source.portfolioTaskId,
    bindingRevision: source.bindingRevision,
    planRevision: source.planRevision,
    planDigest: source.planDigest,
  };
}

function bindingMatches(left, right) {
  return !!left && !!right && sameRef(left.targetProject, right.targetProject) &&
    sameRef(left.taskRef, right.taskRef) && sameRef(left.sourceSession, right.sourceSession) &&
    left.ownerActorId === right.ownerActorId && left.ownerIngressId === right.ownerIngressId &&
    left.ownerDecisionRef === right.ownerDecisionRef &&
    left.portfolioTaskId === right.portfolioTaskId &&
    left.bindingRevision === right.bindingRevision && left.planRevision === right.planRevision &&
    left.planDigest === right.planDigest;
}

function repairIdFor(binding) {
  return "repair:" + sha256([
    RECIPE, binding.targetProject.projectId, binding.taskRef.coordinatorSessionStorageId,
    binding.taskRef.taskId, binding.ownerDecisionRef, binding.portfolioTaskId,
    binding.bindingRevision, binding.planDigest,
  ].join("\u0000")).slice(0, 48);
}

module.exports = {
  PLAN_DIGEST: PLAN_DIGEST,
  PORTFOLIO_TASK_ID: PORTFOLIO_TASK_ID,
  RECIPE: RECIPE,
  bindingMatches: bindingMatches,
  canonicalize: canonicalize,
  clone: clone,
  createHmacAuthenticator: createHmacAuthenticator,
  digest: digest,
  equal: equal,
  error: error,
  exactProjectRef: exactProjectRef,
  exactSessionRef: exactSessionRef,
  exactTaskRef: exactTaskRef,
  identifier: identifier,
  normalizeBinding: normalizeBinding,
  repairIdFor: repairIdFor,
  sha256: sha256,
  stableDigest: stableDigest,
};
