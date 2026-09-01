var crypto = require("crypto");
var fs = require("fs");
var os = require("os");
var path = require("path");
var projectIdentity = require("./project-identity");
var scopedAutonomy = require("./coop-scoped-autonomy-policy");
var SCHEMA = "clay.coop_auto_approval_policy";
var VERSION = 1;
var MAX_AUDIT = 256;
var MAX_OVERRIDES = 256;
var MAX_RESERVATIONS = 1024;
function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort());
}
function text(value, max) {
  var result = typeof value === "string" ? value.trim() : "";
  return result && result.length <= (max || 240) ? result : "";
}
function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}
function defaultFile() {
  return path.join(process.env.CLAY_HOME || path.join(os.homedir(), ".clay"),
    "lead", "auto-approval-policy.json");
}
function normalizeLimit(value) {
  if (value == null) return null;
  return Number.isInteger(value) && value > 0 && value <= MAX_RESERVATIONS ? value : null;
}
function normalizeExpiry(value) {
  if (value == null) return null;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function normalizeControl(value) {
  if (!exactKeys(value, ["enabled", "expiresAt", "maxAdmissions", "revision", "provenance"])) return null;
  var provenance = value.provenance;
  if (!exactKeys(provenance, ["actorId", "at", "action"]) ||
      !text(provenance.actorId) || !text(provenance.action) ||
      typeof provenance.at !== "number" || !Number.isFinite(provenance.at) || provenance.at <= 0 ||
      typeof value.enabled !== "boolean" || !Number.isInteger(value.revision) || value.revision < 1) return null;
  var expiresAt = normalizeExpiry(value.expiresAt);
  var maxAdmissions = normalizeLimit(value.maxAdmissions);
  if ((value.expiresAt != null && !expiresAt) || (value.maxAdmissions != null && !maxAdmissions)) return null;
  return {
    enabled: value.enabled,
    expiresAt: expiresAt,
    maxAdmissions: maxAdmissions,
    revision: value.revision,
    provenance: { actorId: provenance.actorId, at: provenance.at, action: provenance.action },
  };
}
function normalizeOverride(value) {
  if (!exactKeys(value, ["projectRef", "control"])) return null;
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  var control = normalizeControl(value.control);
  if (!projectRef || !control) return null;
  return { projectRef: { projectId: projectRef.projectId }, control: control };
}
function reservationId(projectId, candidateKey, scope, controlRevision) {
  return crypto.createHash("sha256").update(JSON.stringify([
    projectId, candidateKey, scope, controlRevision, SCHEMA,
  ])).digest("hex").slice(0, 32);
}
function normalizeReservation(value) {
  if (!exactKeys(value, ["reservationId", "projectRef", "candidateKey", "scope", "controlRevision", "createdAt"])) return null;
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  var candidateKey = text(value.candidateKey, 500);
  if (!projectRef || !candidateKey || !text(value.reservationId) ||
      (value.scope !== "all_projects" && value.scope !== "project_override") ||
      !Number.isInteger(value.controlRevision) || value.controlRevision < 1 ||
      typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt <= 0 ||
      value.reservationId !== reservationId(projectRef.projectId, candidateKey, value.scope,
        value.controlRevision)) return null;
  return {
    reservationId: value.reservationId,
    projectRef: { projectId: projectRef.projectId },
    candidateKey: candidateKey,
    scope: value.scope,
    controlRevision: value.controlRevision,
    createdAt: value.createdAt,
  };
}
function normalizeAudit(value) {
  if (!exactKeys(value, ["id", "at", "actorId", "action", "projectRef", "detail"])) return null;
  var projectRef = value.projectRef == null ? null : projectIdentity.normalizeProjectRef(value.projectRef);
  if ((value.projectRef != null && !projectRef) || !text(value.id) || !text(value.actorId) ||
      !text(value.action) || typeof value.at !== "number" || !Number.isFinite(value.at) ||
      value.at <= 0 || !plainObject(value.detail)) return null;
  return {
    id: value.id,
    at: value.at,
    actorId: value.actorId,
    action: value.action,
    projectRef: projectRef ? { projectId: projectRef.projectId } : null,
    detail: clone(value.detail),
  };
}
function emptyPolicy() {
  return {
    schema: SCHEMA,
    version: VERSION,
    defaultControl: {
      enabled: false,
      expiresAt: null,
      maxAdmissions: null,
      revision: 1,
      provenance: { actorId: "system:default", at: 1, action: "default_disabled" },
    },
    overrides: [],
    reservations: [],
    audit: [],
  };
}
function normalizePolicy(value) {
  if (!exactKeys(value, ["schema", "version", "defaultControl", "overrides", "reservations", "audit"]) ||
      value.schema !== SCHEMA || value.version !== VERSION || !Array.isArray(value.overrides) ||
      !Array.isArray(value.reservations) || !Array.isArray(value.audit) ||
      value.overrides.length > MAX_OVERRIDES || value.reservations.length > MAX_RESERVATIONS ||
      value.audit.length > MAX_AUDIT) return null;
  var defaultControl = normalizeControl(value.defaultControl);
  if (!defaultControl) return null;
  var overrides = [];
  var seenProjects = {};
  for (var i = 0; i < value.overrides.length; i++) {
    var override = normalizeOverride(value.overrides[i]);
    if (!override || seenProjects[override.projectRef.projectId]) return null;
    seenProjects[override.projectRef.projectId] = true;
    overrides.push(override);
  }
  var reservations = [];
  var seenReservations = {};
  for (var j = 0; j < value.reservations.length; j++) {
    var reservation = normalizeReservation(value.reservations[j]);
    if (!reservation || seenReservations[reservation.reservationId]) return null;
    seenReservations[reservation.reservationId] = true;
    reservations.push(reservation);
  }
  var audit = [];
  var seenAudit = {};
  for (var k = 0; k < value.audit.length; k++) {
    var entry = normalizeAudit(value.audit[k]);
    if (!entry || seenAudit[entry.id]) return null;
    seenAudit[entry.id] = true;
    audit.push(entry);
  }
  overrides.sort(function (left, right) { return left.projectRef.projectId.localeCompare(right.projectRef.projectId); });
  reservations.sort(function (left, right) { return left.reservationId.localeCompare(right.reservationId); });
  audit.sort(function (left, right) { return left.at - right.at || left.id.localeCompare(right.id); });
  return {
    schema: SCHEMA,
    version: VERSION,
    defaultControl: defaultControl,
    overrides: overrides,
    reservations: reservations,
    audit: audit,
  };
}
function controlFor(policy, projectRef, now) {
  var project = projectIdentity.normalizeProjectRef(projectRef);
  if (!project) return null;
  var source = "all_projects";
  var control = policy.defaultControl;
  for (var i = 0; i < policy.overrides.length; i++) {
    if (policy.overrides[i].projectRef.projectId === project.projectId) {
      control = policy.overrides[i].control;
      source = "project_override";
      break;
    }
  }
  var expired = control.expiresAt != null && now >= control.expiresAt;
  return { projectRef: project, control: control, source: source, expired: expired };
}
function safeCandidate(candidate) {
  var value = candidate || {};
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  if (!projectRef || value.admission !== "owner_approval" || value.status !== "pending" ||
      value.coopTopicRef || value.topicRef || !text(value.candidateKey, 500) ||
      !text(value.policyDigest) || !text(value.eligibilityPass) || !plainObject(value.eligibility)) {
    return { ok: false, reason: "auto_approval_candidate_ineligible" };
  }
  var safety = scopedAutonomy.normalizeSafety(value.safety);
  if (!safety) return { ok: false, reason: "auto_approval_safety_unavailable" };
  for (var i = 0; i < scopedAutonomy.HAZARD_FIELDS.length; i++) {
    var field = scopedAutonomy.HAZARD_FIELDS[i];
    if (safety[field]) return { ok: false, reason: "auto_approval_" + field + "_gated" };
  }
  if (safety.risk !== "low") return { ok: false, reason: "auto_approval_not_low_risk" };
  return { ok: true, projectRef: projectRef, candidateKey: value.candidateKey };
}
function grantFor(policy, candidate, now) {
  var safe = safeCandidate(candidate);
  if (!safe.ok) return safe;
  var resolved = controlFor(policy, safe.projectRef, now);
  if (!resolved || !resolved.control.enabled) return { ok: false, reason: "auto_approval_disabled" };
  if (resolved.expired) return { ok: false, reason: "auto_approval_expired" };
  var id = reservationId(safe.projectRef.projectId, safe.candidateKey, resolved.source,
    resolved.control.revision);
  var found = null;
  var count = 0;
  for (var i = 0; i < policy.reservations.length; i++) {
    var reservation = policy.reservations[i];
    if (reservation.scope === resolved.source && reservation.controlRevision === resolved.control.revision &&
        (resolved.source === "all_projects" || reservation.projectRef.projectId === safe.projectRef.projectId)) count++;
    if (reservation.reservationId === id) found = reservation;
  }
  if (!found && resolved.control.maxAdmissions != null && count >= resolved.control.maxAdmissions) {
    return { ok: false, reason: "auto_approval_limit_reached" };
  }
  var reservation = found || {
    reservationId: id,
    projectRef: { projectId: safe.projectRef.projectId },
    candidateKey: safe.candidateKey,
    scope: resolved.source,
    controlRevision: resolved.control.revision,
    createdAt: now,
  };
  return {
    ok: true,
    reused: !!found,
    reservation: reservation,
    grant: {
      kind: "project_auto_approval",
      projectRef: { projectId: safe.projectRef.projectId },
      scope: resolved.source,
      controlRevision: resolved.control.revision,
      expiresAt: resolved.control.expiresAt,
      maxAdmissions: resolved.control.maxAdmissions,
      reservationId: reservation.reservationId,
      provenance: clone(resolved.control.provenance),
    },
  };
}
function normalizeGrant(value) {
  if (!exactKeys(value, ["kind", "projectRef", "scope", "controlRevision", "expiresAt", "maxAdmissions", "reservationId", "provenance"]) ||
      value.kind !== "project_auto_approval" ||
      (value.scope !== "all_projects" && value.scope !== "project_override")) return null;
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  var expiresAt = normalizeExpiry(value.expiresAt);
  var maxAdmissions = normalizeLimit(value.maxAdmissions);
  if (!projectRef || !Number.isInteger(value.controlRevision) || value.controlRevision < 1 ||
      !text(value.reservationId) || (value.expiresAt != null && !expiresAt) ||
      (value.maxAdmissions != null && !maxAdmissions) ||
      !exactKeys(value.provenance, ["actorId", "at", "action"]) ||
      !text(value.provenance.actorId) || !text(value.provenance.action) ||
      typeof value.provenance.at !== "number" || !Number.isFinite(value.provenance.at) || value.provenance.at <= 0) return null;
  return {
    kind: "project_auto_approval",
    projectRef: { projectId: projectRef.projectId },
    scope: value.scope,
    controlRevision: value.controlRevision,
    expiresAt: expiresAt,
    maxAdmissions: maxAdmissions,
    reservationId: value.reservationId,
    provenance: clone(value.provenance),
  };
}
function createPolicyStore(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || defaultFile();
  var now = opts.now || Date.now;
  function load() {
    var parsed;
    try { parsed = JSON.parse(fsImpl.readFileSync(file, "utf8")); }
    catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, policy: emptyPolicy() };
      return { ok: false, reason: "auto_approval_unreadable" };
    }
    var policy = normalizePolicy(parsed);
    return policy ? { ok: true, policy: policy } : { ok: false, reason: "auto_approval_malformed" };
  }
  function save(policy) {
    var normalized = normalizePolicy(policy);
    if (!normalized) return { ok: false, reason: "auto_approval_malformed" };
    var temporary = file + ".tmp." + process.pid;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fsImpl.writeFileSync(temporary, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
      fsImpl.renameSync(temporary, file);
      return { ok: true, policy: clone(normalized) };
    } catch (error) {
      try { fsImpl.unlinkSync(temporary); } catch (cleanupError) {}
      return { ok: false, reason: "auto_approval_persistence_failed" };
    }
  }

  function audit(policy, actorId, action, projectRef, detail, at) {
    var entry = {
      id: crypto.createHash("sha256").update(JSON.stringify([actorId, action, projectRef, detail, at])).digest("hex").slice(0, 32),
      at: at,
      actorId: actorId,
      action: action,
      projectRef: projectRef ? { projectId: projectRef.projectId } : null,
      detail: detail,
    };
    policy.audit = policy.audit.concat([entry]).slice(-MAX_AUDIT);
    return entry;
  }

  function updateControl(input, global) {
    var value = input || {};
    var actorId = text(value.actorId);
    var at = typeof value.at === "number" && Number.isFinite(value.at) && value.at > 0 ? value.at : now();
    if (!actorId || typeof value.enabled !== "boolean") return { ok: false, reason: "auto_approval_invalid_control" };
    var expiresAt = normalizeExpiry(value.expiresAt);
    var maxAdmissions = normalizeLimit(value.maxAdmissions);
    if ((value.expiresAt != null && !expiresAt) || (value.maxAdmissions != null && !maxAdmissions)) {
      return { ok: false, reason: "auto_approval_invalid_control" };
    }
    var loaded = load();
    if (!loaded.ok) return loaded;
    var policy = loaded.policy;
    var target = global ? null : projectIdentity.normalizeProjectRef(value.projectRef);
    if (!global && !target) return { ok: false, reason: "auto_approval_invalid_project_ref" };
    var prior = global ? policy.defaultControl : null;
    var overrideIndex = -1;
    if (!global) {
      for (var i = 0; i < policy.overrides.length; i++) {
        if (policy.overrides[i].projectRef.projectId === target.projectId) {
          overrideIndex = i;
          prior = policy.overrides[i].control;
          break;
        }
      }
    }
    var control = {
      enabled: value.enabled,
      expiresAt: expiresAt,
      maxAdmissions: maxAdmissions,
      revision: (prior && prior.revision || 0) + 1,
      provenance: { actorId: actorId, at: at, action: global ? "set_all_projects" : "set_project_override" },
    };
    if (global) policy.defaultControl = control;
    else if (overrideIndex >= 0) policy.overrides[overrideIndex] = { projectRef: { projectId: target.projectId }, control: control };
    else policy.overrides.push({ projectRef: { projectId: target.projectId }, control: control });
    var entry = audit(policy, actorId, control.provenance.action, target, {
      enabled: control.enabled, expiresAt: control.expiresAt, maxAdmissions: control.maxAdmissions,
      revision: control.revision,
    }, at);
    var saved = save(policy);
    return saved.ok ? { ok: true, policy: saved.policy, control: control, audit: entry } : saved;
  }

  function clearOverride(input) {
    var value = input || {};
    var target = projectIdentity.normalizeProjectRef(value.projectRef);
    var actorId = text(value.actorId);
    var at = typeof value.at === "number" && Number.isFinite(value.at) && value.at > 0 ? value.at : now();
    if (!target || !actorId) return { ok: false, reason: "auto_approval_invalid_project_ref" };
    var loaded = load();
    if (!loaded.ok) return loaded;
    var policy = loaded.policy;
    var before = policy.overrides.length;
    policy.overrides = policy.overrides.filter(function (override) {
      return override.projectRef.projectId !== target.projectId;
    });
    if (before === policy.overrides.length) return { ok: true, unchanged: true, policy: policy };
    var entry = audit(policy, actorId, "clear_project_override", target, {}, at);
    var saved = save(policy);
    return saved.ok ? { ok: true, policy: saved.policy, audit: entry } : saved;
  }

  function reserveCandidate(candidate) {
    var loaded = load();
    if (!loaded.ok) return loaded;
    var at = now();
    var result = grantFor(loaded.policy, candidate, at);
    if (!result.ok || result.reused) return result;
    loaded.policy.reservations.push(result.reservation);
    audit(loaded.policy, result.grant.provenance.actorId, "reserve_admission",
      result.reservation.projectRef, { reservationId: result.reservation.reservationId }, at);
    var saved = save(loaded.policy);
    return saved.ok ? result : saved;
  }

  function releaseReservation(grant) {
    var normalized = normalizeGrant(grant);
    if (!normalized) return { ok: false, reason: "auto_approval_grant_malformed" };
    var loaded = load();
    if (!loaded.ok) return loaded;
    var policy = loaded.policy;
    var kept = policy.reservations.filter(function (reservation) {
      return reservation.reservationId !== normalized.reservationId;
    });
    if (kept.length === policy.reservations.length) return { ok: true, unchanged: true };
    policy.reservations = kept;
    audit(policy, normalized.provenance.actorId, "release_admission",
      normalized.projectRef, { reservationId: normalized.reservationId }, now());
    return save(policy);
  }

  function validateGrant(candidate, grant) {
    var normalized = normalizeGrant(grant);
    if (!normalized) return { ok: false, reason: "auto_approval_grant_malformed" };
    var loaded = load();
    if (!loaded.ok) return loaded;
    var safe = safeCandidate(candidate);
    if (!safe.ok) return safe;
    if (safe.projectRef.projectId !== normalized.projectRef.projectId) {
      return { ok: false, reason: "auto_approval_project_mismatch" };
    }
    var resolved = controlFor(loaded.policy, safe.projectRef, now());
    if (!resolved || !resolved.control.enabled || resolved.expired ||
        resolved.source !== normalized.scope || resolved.control.revision !== normalized.controlRevision ||
        resolved.control.expiresAt !== normalized.expiresAt ||
        resolved.control.maxAdmissions !== normalized.maxAdmissions ||
        JSON.stringify(resolved.control.provenance) !== JSON.stringify(normalized.provenance)) {
      return { ok: false, reason: "auto_approval_revoked_or_stale" };
    }
    for (var i = 0; i < loaded.policy.reservations.length; i++) {
      var reservation = loaded.policy.reservations[i];
      if (reservation.reservationId === normalized.reservationId &&
          reservation.projectRef.projectId === safe.projectRef.projectId &&
          reservation.candidateKey === safe.candidateKey &&
          reservation.scope === normalized.scope && reservation.controlRevision === normalized.controlRevision) {
        return { ok: true, grant: normalized };
      }
    }
    return { ok: false, reason: "auto_approval_reservation_missing" };
  }

  function stateFor(projectRef, projects) {
    var loaded = load();
    if (!loaded.ok) return loaded;
    var at = now();
    var project = projectIdentity.normalizeProjectRef(projectRef);
    var effective = project ? controlFor(loaded.policy, project, at) : null;
    var list = Array.isArray(projects) ? projects.map(function (item) {
      var ref = projectIdentity.normalizeProjectRef(item && item.projectRef || item);
      if (!ref) return null;
      var resolved = controlFor(loaded.policy, ref, at);
      return {
        projectRef: { projectId: ref.projectId },
        label: text(item && item.label, 160) || null,
        effective: { enabled: resolved.control.enabled && !resolved.expired, source: resolved.source,
          expiresAt: resolved.control.expiresAt, maxAdmissions: resolved.control.maxAdmissions },
        hasOverride: resolved.source === "project_override",
      };
    }).filter(function (item) { return !!item; }) : [];
    return {
      ok: true,
      state: {
        defaultControl: clone(loaded.policy.defaultControl),
        effective: effective ? {
          enabled: effective.control.enabled && !effective.expired,
          source: effective.source,
          expiresAt: effective.control.expiresAt,
          maxAdmissions: effective.control.maxAdmissions,
          expired: effective.expired,
        } : null,
        projectOverride: project ? (loaded.policy.overrides.filter(function (override) {
          return override.projectRef.projectId === project.projectId;
        })[0] || null) : null,
        projects: list,
        audit: loaded.policy.audit.slice(-20),
      },
    };
  }

  function hasExplicitControl(projectRef) {
    var project = projectIdentity.normalizeProjectRef(projectRef);
    var loaded = load();
    if (!project || !loaded.ok) return false;
    if (loaded.policy.defaultControl.provenance.action === "set_all_projects") return true;
    return loaded.policy.overrides.some(function (override) {
      return override.projectRef.projectId === project.projectId;
    });
  }

  return {
    clearOverride: clearOverride,
    defaultFile: file,
    hasExplicitControl: hasExplicitControl,
    load: load,
    releaseReservation: releaseReservation,
    reserveCandidate: reserveCandidate,
    save: save,
    setAllProjects: function (input) { return updateControl(input, true); },
    setProjectOverride: function (input) { return updateControl(input, false); },
    stateFor: stateFor,
    validateGrant: validateGrant,
  };
}

module.exports = {
  MAX_RESERVATIONS: MAX_RESERVATIONS,
  SCHEMA: SCHEMA,
  VERSION: VERSION,
  createPolicyStore: createPolicyStore,
  defaultFile: defaultFile,
  emptyPolicy: emptyPolicy,
  normalizeGrant: normalizeGrant,
  normalizePolicy: normalizePolicy,
  reservationId: reservationId,
};
