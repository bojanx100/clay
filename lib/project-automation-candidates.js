// project-automation-candidates.js - The durable handoff between a project's
// automation and Coop.
//
// Under the cutover a project controller does not launch; it proposes. But a
// proposal that is only written to the audit log is not a handoff — it is a
// log line. That gap is exactly how an eligible bug (trialview/v2#2517) could
// be re-evaluated every five minutes for hours while Coop never saw it: the
// candidate was computed, audited, and dropped on the floor because nothing
// was wired to receive it.
//
// So candidates live here instead: one durable record per (project, item),
// which Coop reads to admit exactly once through the canonical ProjectRef
// binding.
//
// IDEMPOTENCE IS THE POINT. A scheduled scan re-proposes the same eligible
// item on every tick, forever, until Coop admits it. That is correct — the
// controller is stateless and must not decide when to stop. What must NOT
// happen is a new record, a new notification, or a new activity line each
// time. So `upsert` creates once and thereafter merely refreshes `lastSeenAt`,
// reporting `created: false` so callers can stay quiet. A candidate only looks
// "new" again if its content genuinely changed (different class, admission,
// policy digest or intent), which is a real event worth surfacing.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var projectIdentity = require("./project-identity");

var SCHEMA = "clay.automation_candidates";
var SCHEMA_VERSION = 1;
var MAX_CANDIDATES = 2048;

function defaultFile(cwd) {
  return path.join(cwd, ".clay", "tasks", "automation-candidates.json");
}

function clone(value) {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

// What makes two proposals for the same item "the same proposal". Deliberately
// excludes timestamps: a tick that changes nothing must not look like news.
function contentDigest(candidate) {
  return crypto.createHash("sha256").update(JSON.stringify([
    candidate.itemKey || "",
    candidate.itemClass || "",
    candidate.admission || "",
    candidate.policyDigest || "",
    candidate.projectRef ? candidate.projectRef.projectId : "",
    candidate.intent || null,
  ])).digest("hex").slice(0, 32);
}

function normalize(candidate, now) {
  var value = candidate && typeof candidate === "object" ? candidate : null;
  if (!value) return null;
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  var key = String(value.candidateKey || value.itemKey || "").trim();
  if (!projectRef || !key) return null;
  var record = {
    candidateKey: key,
    itemKey: value.itemKey || null,
    itemClass: value.itemClass || null,
    admission: value.admission || "owner_approval",
    projectRef: { projectId: projectRef.projectId },
    policyDigest: value.policyDigest || null,
    recipeId: value.recipeId || null,
    intent: value.intent ? clone(value.intent) : null,
    status: "pending",
    firstSeenAt: now,
    lastSeenAt: now,
    seenCount: 1,
  };
  record.digest = contentDigest(record);
  return record;
}

function createCandidateStore(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || defaultFile(opts.cwd || ".");
  var now = opts.now || Date.now;

  function read() {
    try {
      var parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
      if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.candidates)) {
        return { ok: false, reason: "malformed_state", candidates: [] };
      }
      return { ok: true, candidates: parsed.candidates };
    } catch (e) {
      if (e && e.code === "ENOENT") return { ok: true, candidates: [] };
      return { ok: false, reason: "malformed_state", candidates: [] };
    }
  }

  // Persisted with the usual temp+rename so a torn write cannot be read. A
  // failure is REPORTED, never swallowed: a dropped candidate is the exact
  // defect this module exists to prevent, and the legacy launch-state stores
  // silently ignoring their own write errors is what let the storm run.
  function write(candidates) {
    var temp = file + ".tmp." + process.pid;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(temp, JSON.stringify({
        schema: SCHEMA, version: SCHEMA_VERSION, candidates: candidates,
      }, null, 2) + "\n");
      fsImpl.renameSync(temp, file);
      return { ok: true };
    } catch (e) {
      try { fsImpl.unlinkSync(temp); } catch (unlinkError) {}
      return { ok: false, reason: "persistence_failed", error: e && e.message };
    }
  }

  function indexOf(candidates, projectId, key) {
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].candidateKey === key &&
          candidates[i].projectRef && candidates[i].projectRef.projectId === projectId) return i;
    }
    return -1;
  }

  // upsert -> { ok, created, changed, candidate }
  //   created: this is the first time we have proposed this item
  //   changed: we had proposed it before, but the proposal itself differs
  // Both are "news". Neither set means a quiet refresh — the caller should not
  // log, notify, or otherwise treat it as an event.
  function upsert(candidate) {
    var timestamp = now();
    var record = normalize(candidate, timestamp);
    if (!record) return { ok: false, reason: "invalid_candidate" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var candidates = state.candidates;
    var index = indexOf(candidates, record.projectRef.projectId, record.candidateKey);
    if (index === -1) {
      if (candidates.length >= MAX_CANDIDATES) return { ok: false, reason: "candidate_store_full" };
      candidates.push(record);
      var created = write(candidates);
      if (!created.ok) return created;
      return { ok: true, created: true, changed: true, candidate: clone(record) };
    }
    var existing = candidates[index];
    var changed = existing.digest !== record.digest;
    var merged = Object.assign({}, existing, {
      lastSeenAt: timestamp,
      seenCount: (existing.seenCount || 0) + 1,
    });
    if (changed) {
      merged = Object.assign({}, record, {
        firstSeenAt: existing.firstSeenAt || timestamp,
        seenCount: (existing.seenCount || 0) + 1,
        // A changed proposal for work Coop already admitted stays admitted;
        // re-opening it here would be a second admission.
        status: existing.status === "admitted" || existing.status === "awaiting_owner"
          ? existing.status : "pending",
      });
    }
    candidates[index] = merged;
    var written = write(candidates);
    if (!written.ok) return written;
    return { ok: true, created: false, changed: changed, candidate: clone(merged) };
  }

  // Coop marks a candidate admitted once it holds the canonical binding, so
  // later ticks refresh it quietly instead of re-proposing it as new work.
  function markAdmitted(projectRef, candidateKey, binding) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!ref || !candidateKey) return { ok: false, reason: "invalid_candidate" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    if (index === -1) return { ok: false, reason: "not_found" };
    state.candidates[index] = Object.assign({}, state.candidates[index], {
      status: "admitted",
      admittedAt: now(),
      binding: binding ? clone(binding) : null,
    });
    var written = write(state.candidates);
    return written.ok ? { ok: true, candidate: clone(state.candidates[index]) } : written;
  }

  // pending() -> { ok, candidates } | { ok:false, reason }
  // The fail-closed reader. `list` returns a bare array for convenience, but a
  // corrupt or unreadable store would then be indistinguishable from an empty
  // queue — and interpreting corruption as "nothing to admit" is exactly how
  // work goes missing silently. Admission uses this instead.
  function pending(filter) {
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason, candidates: [] };
    return { ok: true, candidates: list(filter) };
  }

  // Durable attention. A console line disappears; an audit entry is history.
  // An item that cannot be admitted has to stay visibly stuck ON THE RECORD, so
  // the queue itself can be asked "what needs a human?".
  function recordAttention(projectRef, candidateKey, reason, needsOwner) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!ref || !candidateKey) return { ok: false, reason: "invalid_candidate" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    if (index === -1) return { ok: false, reason: "not_found" };
    var existing = state.candidates[index];
    var previous = existing.attention || null;
    state.candidates[index] = Object.assign({}, existing, {
      status: needsOwner ? "awaiting_owner" : existing.status,
      attention: {
        reason: String(reason || "unknown"),
        needsOwner: needsOwner === true,
        firstAt: previous && previous.reason === reason ? previous.firstAt : now(),
        lastAt: now(),
        count: previous && previous.reason === reason ? (previous.count || 0) + 1 : 1,
      },
    });
    var written = write(state.candidates);
    return written.ok ? { ok: true, candidate: clone(state.candidates[index]) } : written;
  }

  function clearAttention(projectRef, candidateKey) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!ref || !candidateKey) return { ok: false, reason: "invalid_candidate" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    if (index === -1) return { ok: false, reason: "not_found" };
    if (!state.candidates[index].attention) return { ok: true };
    var updated = Object.assign({}, state.candidates[index]);
    delete updated.attention;
    state.candidates[index] = updated;
    var written = write(state.candidates);
    return written.ok ? { ok: true } : written;
  }

  // Everything a human or Coop must look at: stuck admissions and work the
  // project's own policy says an owner must decide.
  function attentionItems() {
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason, items: [] };
    var items = [];
    for (var i = 0; i < state.candidates.length; i++) {
      var c = state.candidates[i];
      if (c.attention || c.status === "awaiting_owner") items.push(clone(c));
    }
    return { ok: true, items: items };
  }

  function list(filter) {
    var state = read();
    if (!state.ok) return [];
    var wanted = filter && filter.status;
    var result = [];
    for (var i = 0; i < state.candidates.length; i++) {
      if (wanted && state.candidates[i].status !== wanted) continue;
      result.push(clone(state.candidates[i]));
    }
    return result;
  }

  function get(projectRef, candidateKey) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!ref) return null;
    var state = read();
    if (!state.ok) return null;
    var index = indexOf(state.candidates, ref.projectId, candidateKey);
    return index === -1 ? null : clone(state.candidates[index]);
  }

  return {
    attentionItems: attentionItems,
    clearAttention: clearAttention,
    file: file,
    get: get,
    list: list,
    markAdmitted: markAdmitted,
    pending: pending,
    recordAttention: recordAttention,
    upsert: upsert,
  };
}

module.exports = {
  MAX_CANDIDATES: MAX_CANDIDATES,
  SCHEMA: SCHEMA,
  contentDigest: contentDigest,
  createCandidateStore: createCandidateStore,
  defaultFile: defaultFile,
};
