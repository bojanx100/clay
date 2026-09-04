// Append-only Governance Lifecycle records.  This is deliberately an opt-in
// authority layer: existing portfolio bindings retain their compatibility path
// until a caller presents an exact ImplementationGrant from this ledger.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");
var schema = require("./coop-governance-lifecycle-schema");

var SCHEMA = "clay.governance_lifecycle";
var VERSION = 1;
var RETRACTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value, limit) {
  var cleaned = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return limit ? cleaned.slice(0, limit) : cleaned;
}

function digest(value) {
  return crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function recordDigest(value) {
  var sealed = Object.assign({}, value);
  delete sealed.recordHash;
  return digest(sealed);
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ":" + canonical(value[key]);
    }).join(",") + "}";
  }
  return JSON.stringify(value);
}

function defaultFile() {
  return path.join(config.CONFIG_DIR, "lead", "governance-lifecycle.jsonl");
}


function emptyState() {
  return { phase: "", workstream: null, stages: {}, latestPlan: null, ownerDecision: null,
    grants: {}, admissions: {}, executions: {}, adoptions: {}, learning: {}, records: {} };
}

function stateError(code) {
  return { ok: false, code: code };
}

function apply(state, record) {
  if (record.type === "workstream") {
    state.workstream = record.workstream; state.phase = "intake";
  } else if (record.type === "stage_run") {
    state.stages[record.stageRun.stage] = record.stageRun;
    state.phase = record.stageRun.stage;
  } else if (record.type === "plan_revision") {
    state.latestPlan = record.planRevision; state.ownerDecision = null; state.phase = "plan_draft";
  } else if (record.type === "owner_decision") {
    state.ownerDecision = record.ownerDecision;
    state.phase = record.ownerDecision.decision === "approved" ? "approved" : "attention";
  } else if (record.type === "implementation_grant") {
    state.grants[record.implementationGrant.grantId] = record.implementationGrant;
    state.phase = "implementation_admitted";
  } else if (record.type === "implementation_admitted") {
    state.admissions[record.implementationAdmission.grantId] = true;
    state.phase = "implementation_admitted";
  } else if (record.type === "execution_started") {
    state.executions[record.execution.grantId] = true; state.phase = "executing";
  } else if (record.type === "verification") {
    state.phase = "verified";
  } else if (record.type === "adoption") {
    state.adoptions[record.adoption.grantId + ":" + record.adoption.bindingRevision] = record.adoption;
  } else if (record.type === "closed") {
    state.phase = "closed";
  } else if (record.type === "learning") {
    state.learning[record.learning.learningId] = Object.assign({}, record.learning, { recordId: record.recordId,
      contentRef: record.learning.contentRef, retractedAt: null, tombstone: false });
  } else if (record.type === "learning_retraction") {
    state.learning[record.learningRetraction.learningId].retractedAt = record.at;
  } else if (record.type === "learning_content_purged") {
    var purged = state.learning[record.learningPurge.learningId];
    purged.tombstone = true;
    delete purged.contentRef;
    delete purged.contentDigest;
  }
  state.records[record.recordId] = record;
}

function parseEvents(file, fsImpl) {
  var raw;
  try { raw = fsImpl.readFileSync(file, "utf8"); }
  catch (err) { return err && err.code === "ENOENT" ? { ok: true, events: [] } : stateError("lifecycle_read_failed"); }
  var lines = raw.split("\n").filter(function (line) { return !!line; });
  var events = [];
  for (var i = 0; i < lines.length; i++) {
    var event;
    try { event = JSON.parse(lines[i]); } catch (err) { return stateError("lifecycle_parse_failed"); }
    var previousHash = i ? events[i - 1].recordHash : null;
    if (!event || event.schema !== SCHEMA || event.version !== VERSION || event.sequence !== i + 1 ||
        event.previousRecordHash !== previousHash || event.recordHash !== recordDigest(event)) {
      return stateError("lifecycle_tampered");
    }
    events.push(event);
  }
  return { ok: true, events: events };
}

function createLifecycle(options) {
  var opts = options || {};
  var file = opts.file || defaultFile();
  var fsImpl = opts.fs || fs;
  var now = opts.now || Date.now;
  var contentDir = opts.contentDir || file + ".learning";

  function read() {
    return parseEvents(file, fsImpl);
  }

  function replay(events) {
    var state = emptyState();
    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      if (!schema.actorAllowed(event.type, event.actor, event)) return stateError(event.type + "_actor_forbidden");
      var problem = schema.validRecord(state, event);
      if (problem) return stateError(problem);
      apply(state, event);
    }
    return { ok: true, state: state };
  }

  function state() {
    var loaded = read();
    if (!loaded.ok) return emptyState();
    var rebuilt = replay(loaded.events);
    return rebuilt.ok ? clone(rebuilt.state) : emptyState();
  }

  function contentPath(id) {
    return path.join(contentDir, digest({ learningId: id }) + ".json");
  }

  function normalized(input, sequence) {
    return schema.normalizeRecord(input, sequence, now, contentPath, digest);
  }

  function writeLine(record) {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    var sealed = Object.assign({}, record);
    sealed.previousRecordHash = arguments[1] || null;
    sealed.recordHash = recordDigest(sealed);
    fsImpl.appendFileSync(file, JSON.stringify(sealed) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  function record(input) {
    var loaded = read();
    if (!loaded.ok) return loaded;
    var stateBefore = replay(loaded.events);
    if (!stateBefore.ok) return stateBefore;
    var event = normalized(input, loaded.events.length + 1);
    if (!event) return stateError("invalid_record");
    for (var i = 0; i < loaded.events.length; i++) {
      if (loaded.events[i].recordId !== event.recordId) continue;
      var prior = Object.assign({}, loaded.events[i]);
      delete prior.sequence; delete prior.at; delete prior.recordHash; delete prior.previousRecordHash;
      var candidate = Object.assign({}, event);
      delete candidate.sequence; delete candidate.at;
      return canonical(prior) === canonical(candidate) ? { ok: true, reused: true, record: clone(loaded.events[i]) } : stateError("idempotency_conflict");
    }
    if (!schema.actorAllowed(event.type, event.actor, event)) return stateError(event.type + "_actor_forbidden");
    var problem = schema.validRecord(stateBefore.state, event);
    if (problem) return stateError(problem);
    if (event.learning) {
      fsImpl.mkdirSync(contentDir, { recursive: true, mode: 0o700 });
      fsImpl.writeFileSync(event.learning.contentRef, JSON.stringify({ content: input.learning.content }) + "\n", { mode: 0o600 });
    }
    try { writeLine(event, loaded.events.length ? loaded.events[loaded.events.length - 1].recordHash : null); }
    catch (err) {
      if (event.learning) try { fsImpl.unlinkSync(event.learning.contentRef); } catch (cleanup) {}
      return stateError("lifecycle_write_failed");
    }
    return { ok: true, reused: false, record: clone(event) };
  }

  function executionAdmission(input) {
    var stateNow = state();
    var source = input || {};
    var grant = stateNow.grants[text(source.grantId, 256)];
    if (!grant) return stateError("grant_not_found");
    if (!stateNow.latestPlan || !stateNow.ownerDecision || stateNow.ownerDecision.decision !== "approved" ||
        grant.planRevision !== stateNow.latestPlan.planRevision || grant.planDigest !== stateNow.latestPlan.planDigest) {
      return stateError("stale_plan_digest");
    }
    var project = projectIdentity.normalizeProjectRef(source.targetProject);
    if (!project || grant.targetProject.projectId !== project.projectId ||
        grant.portfolioTaskId !== text(source.portfolioTaskId, 512) ||
        grant.bindingRevision !== Number(source.bindingRevision) ||
        grant.idempotencyKey !== text(source.idempotencyKey, 512)) return stateError("grant_scope_mismatch");
    return { ok: true, grant: clone(grant) };
  }

  function learning(learningId) {
    var current = state().learning[text(learningId, 256)];
    if (!current) return null;
    var result = clone(current);
    if (!result.tombstone && result.contentRef) {
      try { result.content = JSON.parse(fsImpl.readFileSync(result.contentRef, "utf8")).content; }
      catch (err) { result.content = undefined; }
    }
    return result;
  }

  function purgeRetractedLearning() {
    var current = state();
    var ids = Object.keys(current.learning);
    var purged = 0;
    for (var i = 0; i < ids.length; i++) {
      var entry = current.learning[ids[i]];
      if (!entry.retractedAt || entry.tombstone || Number(now()) - entry.retractedAt < RETRACTION_RETENTION_MS) continue;
      try { fsImpl.unlinkSync(entry.contentRef); }
      catch (err) { if (!err || err.code !== "ENOENT") return stateError("learning_purge_failed"); }
      var outcome = record({ recordId: "learning-purge:" + entry.learningId, type: "learning_content_purged",
        actor: "coop", workstream: current.workstream, learningPurge: { learningId: entry.learningId } });
      if (!outcome.ok) continue;
      purged++;
    }
    return { ok: true, purged: purged };
  }

  return { executionAdmission: executionAdmission, learning: learning, purgeRetractedLearning: purgeRetractedLearning,
    read: read, record: record, replay: replay, state: state };
}

module.exports = { RETRACTION_RETENTION_MS: RETRACTION_RETENTION_MS, SCHEMA: SCHEMA, VERSION: VERSION,
  createLifecycle: createLifecycle, normalWorkstream: schema.normalWorkstream };
