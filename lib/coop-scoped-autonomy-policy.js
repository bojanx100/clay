// Persistent, owner-provisioned authority for already-admitted low-risk work.
//
// This is intentionally narrower than a blanket "approve all" switch. A grant
// is tied to one exact target ProjectRef and to the exact owner ingress that
// authorized the policy implementation. It can only release candidates that
// still pass their current project gate and their current eligibility scan.

var crypto = require("crypto");
var fs = require("fs");
var os = require("os");
var path = require("path");
var projectIdentity = require("./project-identity");
var relevance = require("./coop-topic-relevance");

var SCHEMA = "clay.coop_scoped_autonomy_policy";
var VERSION = 1;
var SAFETY_VERSION = 1;
var POLICY_KIND = "admitted_low_risk_backlog";
var MAX_GRANTS = 128;

var HAZARD_FIELDS = [
  "destructive",
  "selfModifying",
  "controlPlane",
  "securitySensitive",
  "crossProject",
  "materialScopeChange",
];

var HAZARD_PATTERNS = {
  destructive: /\b(?:delete|destroy|drop\s+(?:table|database)|purge|wipe|irreversible)\b/i,
  selfModifying: /\b(?:self[-\s]?modif(?:y|ication)|modify\s+(?:coop|lead|own)\b|change\s+(?:coop|lead)\s+(?:policy|authority)|autonomy\s+policy)\b/i,
  controlPlane: /\b(?:control[-\s]?plane|daemon|orchestrator|lead\s+mode|restart\s+(?:the\s+)?(?:daemon|server|clay))\b/i,
  securitySensitive: /\b(?:security|vulnerabilit|auth(?:entication|orization)?|credential|secret|token|cve|xss|csrf|injection)\b/i,
  crossProject: /\b(?:cross[-\s]?project|multi[-\s]?project|across\s+(?:all|multiple)\s+projects)\b/i,
  materialScopeChange: /\b(?:broaden(?:ed|ing)?\s+scope|material(?:ly)?\s+(?:broaden|expand)|expand(?:ed|ing)?\s+scope|all\s+(?:projects|repositories|repos))\b/i,
};

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort());
}

function text(value, limit) {
  var result = typeof value === "string" ? value.trim() : "";
  return result && result.length <= (limit || 240) ? result : "";
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function defaultFile() {
  return path.join(os.homedir(), ".clay", "lead", "scoped-autonomy-policy.json");
}

function stableGrantId(ingressId, projectId, taskId) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([ingressId, projectId, taskId, POLICY_KIND]))
    .digest("hex").slice(0, 32);
}

function normalizeOwnerReference(value) {
  if (!exactKeys(value, ["ingressId", "sessionRef", "requestRef"])) return null;
  var ingressId = text(value.ingressId);
  var sessionRef = projectIdentity.normalizeSessionRef(value.sessionRef);
  var requestRef = projectIdentity.normalizeSessionRef(value.requestRef);
  if (!ingressId || !sessionRef || !requestRef ||
      sessionRef.projectId !== requestRef.projectId ||
      sessionRef.sessionStorageId !== requestRef.sessionStorageId ||
      !Number.isInteger(value.requestRef.eventIndex) || value.requestRef.eventIndex < 0) return null;
  return {
    ingressId: ingressId,
    sessionRef: sessionRef,
    requestRef: {
      projectId: requestRef.projectId,
      sessionStorageId: requestRef.sessionStorageId,
      eventIndex: value.requestRef.eventIndex,
    },
  };
}

function normalizeGrant(value) {
  if (!exactKeys(value, ["grantId", "kind", "projectRef", "authorizationTaskId",
    "owner", "grantedAt"])) return null;
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  var grantId = text(value.grantId);
  var authorizationTaskId = text(value.authorizationTaskId);
  var owner = normalizeOwnerReference(value.owner);
  if (!grantId || value.kind !== POLICY_KIND || !projectRef ||
      !projectIdentity.isTaskId(authorizationTaskId) || !owner ||
      typeof value.grantedAt !== "number" || !Number.isFinite(value.grantedAt) ||
      value.grantedAt <= 0) return null;
  if (grantId !== stableGrantId(owner.ingressId, projectRef.projectId, authorizationTaskId)) return null;
  return {
    grantId: grantId,
    kind: POLICY_KIND,
    projectRef: { projectId: projectRef.projectId },
    authorizationTaskId: authorizationTaskId,
    owner: owner,
    grantedAt: value.grantedAt,
  };
}

function normalizePolicy(value) {
  if (!exactKeys(value, ["schema", "version", "grants"]) ||
      value.schema !== SCHEMA || value.version !== VERSION ||
      !Array.isArray(value.grants) || value.grants.length > MAX_GRANTS) return null;
  var seen = {};
  var grants = [];
  for (var i = 0; i < value.grants.length; i++) {
    var grant = normalizeGrant(value.grants[i]);
    if (!grant || seen[grant.grantId]) return null;
    seen[grant.grantId] = true;
    grants.push(grant);
  }
  grants.sort(function (left, right) { return left.grantId.localeCompare(right.grantId); });
  return { schema: SCHEMA, version: VERSION, grants: grants };
}

function emptyPolicy() {
  return { schema: SCHEMA, version: VERSION, grants: [] };
}

function sourceText(input) {
  var value = input || {};
  var title = text(value.title, 500);
  var body = text(value.body, 5000);
  return (title + "\n" + body).trim();
}

// The safety envelope is created at project-side discovery and included in the
// candidate digest. Admission re-checks every boolean from this exact envelope;
// absent or malformed evidence is never interpreted as low risk.
function assessCandidateSafety(input) {
  var value = input || {};
  var source = sourceText(value);
  var safety = {
    version: SAFETY_VERSION,
    risk: source ? "low" : "unknown",
    destructive: value.destructive === true,
    selfModifying: value.selfModifying === true,
    controlPlane: value.controlPlane === true,
    securitySensitive: value.securitySensitive === true,
    crossProject: value.crossProject === true,
    materialScopeChange: value.materialScopeChange === true,
  };
  for (var i = 0; i < HAZARD_FIELDS.length; i++) {
    var field = HAZARD_FIELDS[i];
    if (HAZARD_PATTERNS[field].test(source)) safety[field] = true;
  }
  for (var j = 0; j < HAZARD_FIELDS.length; j++) {
    if (safety[HAZARD_FIELDS[j]]) safety.risk = "high";
  }
  return safety;
}

function normalizeSafety(value) {
  var keys = ["version", "risk"].concat(HAZARD_FIELDS);
  if (!exactKeys(value, keys) || value.version !== SAFETY_VERSION ||
      (value.risk !== "low" && value.risk !== "high" && value.risk !== "unknown")) return null;
  for (var i = 0; i < HAZARD_FIELDS.length; i++) {
    if (typeof value[HAZARD_FIELDS[i]] !== "boolean") return null;
  }
  return clone(value);
}

function grantForProject(policy, projectRef) {
  var normalized = normalizePolicy(policy);
  var project = projectIdentity.normalizeProjectRef(projectRef);
  if (!normalized || !project) return null;
  for (var i = 0; i < normalized.grants.length; i++) {
    if (normalized.grants[i].projectRef.projectId === project.projectId) {
      return normalized.grants[i];
    }
  }
  return null;
}

// Pure policy decision. `owner_approval` candidates are eligible only when the
// project currently has one exact owner-provisioned grant AND the candidate is
// still a normal pending candidate with all safety evidence present.
function decide(policy, candidate) {
  var value = candidate || {};
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  if (!projectRef || value.admission !== "owner_approval" || value.status !== "pending") {
    return { ok: false, reason: "scoped_policy_candidate_ineligible" };
  }
  if (value.coopTopicRef || value.topicRef) {
    return { ok: false, reason: "scoped_policy_owner_thread_required" };
  }
  if (!text(value.policyDigest) || !text(value.eligibilityPass) ||
      !plainObject(value.eligibility)) {
    return { ok: false, reason: "scoped_policy_current_admission_required" };
  }
  var safety = normalizeSafety(value.safety);
  if (!safety) return { ok: false, reason: "scoped_policy_safety_unavailable" };
  for (var i = 0; i < HAZARD_FIELDS.length; i++) {
    if (safety[HAZARD_FIELDS[i]]) {
      return { ok: false, reason: "scoped_policy_" + HAZARD_FIELDS[i] + "_gated" };
    }
  }
  if (safety.risk !== "low") return { ok: false, reason: "scoped_policy_not_low_risk" };
  var grant = grantForProject(policy, projectRef);
  if (!grant) return { ok: false, reason: "scoped_policy_project_not_granted" };
  return { ok: true, reason: "scoped_policy_low_risk", grant: clone(grant) };
}

function ownerGrantFrom(input) {
  var value = input || {};
  var entry = value.ownerRequest;
  var event = value.ownerEvent;
  var authorizationTaskId = text(value.authorizationTaskId);
  if (!entry || !event || !projectIdentity.isTaskId(authorizationTaskId)) {
    return { ok: false, reason: "scoped_policy_owner_provenance_required" };
  }
  var scope = entry.implementationScope;
  var projectRef = projectIdentity.normalizeProjectRef(scope && scope.projectRef);
  var decision = entry.implementationDecision;
  if (!plainObject(decision) || decision.intent !== "implement" ||
      decision.source !== "explicit_owner_turn" || entry.expectsExecution !== true ||
      !scope || scope.portfolioTaskId !== authorizationTaskId || !projectRef ||
      event.type !== "user_message" || event.coopIngressId !== entry.ingressId ||
      relevance.isInternalHistoryItem(event) || !relevance.hasOwnerProvenance(event)) {
    return { ok: false, reason: "scoped_policy_owner_provenance_required" };
  }
  var owner = normalizeOwnerReference({
    ingressId: entry.ingressId,
    sessionRef: entry.sessionRef,
    requestRef: entry.requestRef,
  });
  var grantedAt = typeof event._ts === "number" && event._ts > 0 ? event._ts : entry.receivedAt;
  if (!owner || typeof grantedAt !== "number" || !Number.isFinite(grantedAt) || grantedAt <= 0) {
    return { ok: false, reason: "scoped_policy_owner_provenance_required" };
  }
  var grant = {
    grantId: stableGrantId(owner.ingressId, projectRef.projectId, authorizationTaskId),
    kind: POLICY_KIND,
    projectRef: { projectId: projectRef.projectId },
    authorizationTaskId: authorizationTaskId,
    owner: owner,
    grantedAt: grantedAt,
  };
  return { ok: true, grant: grant };
}

function createPolicyStore(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || defaultFile();

  function load() {
    var parsed;
    try {
      parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, policy: emptyPolicy() };
      return { ok: false, reason: "scoped_policy_unreadable" };
    }
    var policy = normalizePolicy(parsed);
    return policy ? { ok: true, policy: policy } : { ok: false, reason: "scoped_policy_malformed" };
  }

  function save(policy) {
    var normalized = normalizePolicy(policy);
    if (!normalized) return { ok: false, reason: "scoped_policy_malformed" };
    var temporary = file + ".tmp." + process.pid;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(temporary, JSON.stringify(normalized, null, 2) + "\n");
      fsImpl.renameSync(temporary, file);
      return { ok: true, policy: clone(normalized) };
    } catch (error) {
      try { fsImpl.unlinkSync(temporary); } catch (cleanupError) {}
      return { ok: false, reason: "scoped_policy_persistence_failed" };
    }
  }

  function activate(input) {
    var verified = ownerGrantFrom(input);
    if (!verified.ok) return verified;
    var loaded = load();
    if (!loaded.ok) return loaded;
    var grants = loaded.policy.grants.slice();
    var replaced = false;
    for (var i = 0; i < grants.length; i++) {
      if (grants[i].projectRef.projectId !== verified.grant.projectRef.projectId) continue;
      if (grants[i].grantId === verified.grant.grantId) {
        return { ok: true, reused: true, policy: loaded.policy, grant: clone(grants[i]) };
      }
      grants[i] = verified.grant;
      replaced = true;
      break;
    }
    if (!replaced) grants.push(verified.grant);
    var saved = save({ schema: SCHEMA, version: VERSION, grants: grants });
    if (!saved.ok) return saved;
    return { ok: true, reused: false, policy: saved.policy, grant: clone(verified.grant) };
  }

  function decideCandidate(candidate) {
    var loaded = load();
    if (!loaded.ok) return loaded;
    return decide(loaded.policy, candidate);
  }

  return {
    activate: activate,
    decide: decideCandidate,
    file: file,
    load: load,
    save: save,
  };
}

module.exports = {
  HAZARD_FIELDS: HAZARD_FIELDS,
  POLICY_KIND: POLICY_KIND,
  SAFETY_VERSION: SAFETY_VERSION,
  SCHEMA: SCHEMA,
  VERSION: VERSION,
  assessCandidateSafety: assessCandidateSafety,
  createPolicyStore: createPolicyStore,
  decide: decide,
  defaultFile: defaultFile,
  normalizeGrant: normalizeGrant,
  normalizePolicy: normalizePolicy,
  normalizeSafety: normalizeSafety,
  ownerGrantFrom: ownerGrantFrom,
};
