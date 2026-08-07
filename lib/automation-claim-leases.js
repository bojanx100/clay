// automation-claim-leases.js - The fenced state machine that decides who may
// launch a piece of automated work.
//
// Durability lives in automation-claim-store.js; this file owns MEANING.
//
// Why a state machine rather than a lease with a TTL. A TTL answers "is this
// claim still fresh?", but the question that actually matters is "did anyone
// already start this work?" — and between deciding to launch and having a
// running session there is a window in which the honest answer is "maybe".
// A TTL resolves that window by guessing, and guessing wrong means two agents
// working the same issue. So the window gets its own durable state:
//
//   CLAIMED   -> we intend to launch; expires, because nothing has happened yet
//   LAUNCHING -> a launch is in flight; does NOT expire, because a session may
//                already exist. Fenced by holder liveness and resolved only by
//                evidence (does a session for this item exist?).
//   RUNNING   -> a session provably exists; renewable while it lives
//   TERMINAL  -> the record is gone and the item is available again
//
// Every record carries a monotonic `generation` and a `token` minted with it.
// Each transition must present that token, so a stalled actor holding an old
// token cannot advance a claim that has since been re-issued to someone else;
// its write is rejected rather than silently applied.
//
// ANY non-terminal record blocks a second launch. That is the whole invariant.

var crypto = require("crypto");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");
var createClaimStore = require("./automation-claim-store").createClaimStore;

var SCHEMA = "clay.automation_claim_leases";
var SCHEMA_VERSION = 2;
var MAX_LEASES = 4096;
var MAX_FIELD_LENGTH = 256;
var DEFAULT_TTL_MS = 900000;
var COMMIT_ATTEMPTS = 8;

var CLAIMED = "CLAIMED";
var LAUNCHING = "LAUNCHING";
var RUNNING = "RUNNING";
var STATES = { CLAIMED: true, LAUNCHING: true, RUNNING: true };
// LAUNCHING is deliberately absent: an in-flight launch never expires, because
// a session may already exist and expiry would license a duplicate.
var EXPIRING_STATES = { CLAIMED: true, RUNNING: true };

function defaultFile() {
  return path.join(config.CONFIG_DIR, "lead", "automation-claims.json");
}

function clone(value) {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

function cleanField(value) {
  if (typeof value !== "string") return "";
  var trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH) return "";
  return trimmed;
}

// Callers MUST hand over an explicit typed ProjectRef object ({ projectId }).
// A bare project-id string is a valid id but an untyped reference, and this is
// a path whose whole job is to prove which project it is acting for.
function normalizeRef(value) {
  return projectIdentity.normalizeProjectRef(value);
}

function positiveTtl(value) {
  return Number.isInteger(value) && value > 0;
}

function validTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// JSON-encoded rather than delimiter-joined: any delimiter can be forged
// across the boundary and collapse two distinct claims into one.
function identityFor(projectId, key) {
  return JSON.stringify([String(projectId), String(key)]);
}

function normalizeRequest(input) {
  var value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  var ref = normalizeRef(value.projectRef);
  if (!ref) return { error: "invalid_project_ref" };
  var key = cleanField(value.key);
  var holder = cleanField(value.holder);
  if (!key || !holder) return { error: "invalid_claim" };
  return {
    error: "",
    projectId: ref.projectId,
    key: key,
    holder: holder,
    holderPid: Number.isInteger(value.holderPid) && value.holderPid > 0 ? value.holderPid : 0,
    token: cleanField(value.token),
    actor: cleanField(value.actor) || null,
    policyDigest: cleanField(value.policyDigest) || null,
    intent: value.intent && typeof value.intent === "object" ? clone(value.intent) : null,
    session: cleanField(value.session) || null,
    ttlMs: value.ttlMs,
  };
}

function persistedRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var ref = normalizeRef({ projectId: value.projectId });
  var key = cleanField(value.key);
  var holder = cleanField(value.holder);
  if (!ref || !key || !holder) return null;
  if (!STATES[value.state]) return null;
  if (!Number.isInteger(value.generation) || value.generation < 1) return null;
  if (!cleanField(value.token)) return null;
  if (!validTimestamp(value.acquiredAt) || !validTimestamp(value.updatedAt)) return null;
  if (!Number.isInteger(value.renewals) || value.renewals < 0) return null;
  if (EXPIRING_STATES[value.state] && !validTimestamp(value.expiresAt)) return null;
  var record = {
    projectId: ref.projectId,
    key: key,
    state: value.state,
    generation: value.generation,
    token: cleanField(value.token),
    holder: holder,
    acquiredAt: value.acquiredAt,
    updatedAt: value.updatedAt,
    renewals: value.renewals,
  };
  if (EXPIRING_STATES[value.state]) record.expiresAt = value.expiresAt;
  if (Number.isInteger(value.holderPid) && value.holderPid > 0) record.holderPid = value.holderPid;
  if (cleanField(value.actor)) record.actor = cleanField(value.actor);
  if (cleanField(value.policyDigest)) record.policyDigest = cleanField(value.policyDigest);
  if (cleanField(value.session)) record.session = cleanField(value.session);
  if (value.intent && typeof value.intent === "object") record.intent = clone(value.intent);
  return record;
}

function parsePayload(parsed) {
  if (!parsed || typeof parsed !== "object" || parsed.schema !== SCHEMA) {
    return { ok: false, reason: "malformed_state" };
  }
  var version = Number(parsed.version);
  if (version !== SCHEMA_VERSION && version !== 1) return { ok: false, reason: "malformed_state" };
  if (!Array.isArray(parsed.leases) || parsed.leases.length > MAX_LEASES) {
    return { ok: false, reason: "malformed_state" };
  }
  var result = [];
  var seen = {};
  for (var i = 0; i < parsed.leases.length; i++) {
    var raw = parsed.leases[i];
    // Version 1 predates the state machine: a bare lease was a running claim.
    if (version === 1 && raw && typeof raw === "object" && !raw.state) {
      raw = Object.assign({}, raw, {
        state: RUNNING, generation: 1, token: "legacy-" + String(raw.key),
        updatedAt: raw.acquiredAt,
      });
    }
    var record = persistedRecord(raw);
    if (!record) return { ok: false, reason: "malformed_state" };
    var identity = identityFor(record.projectId, record.key);
    if (seen[identity]) return { ok: false, reason: "malformed_state" };
    seen[identity] = true;
    result.push(record);
  }
  return { ok: true, payload: { leases: result } };
}

function recordIndex(records, projectId, key) {
  for (var i = 0; i < records.length; i++) {
    if (records[i].projectId === projectId && records[i].key === key) return i;
  }
  return -1;
}

function isExpired(record, timestamp) {
  if (!EXPIRING_STATES[record.state]) return false;
  return record.expiresAt <= timestamp;
}

function createClaimLeases(options) {
  var opts = options || {};
  var file = opts.file || defaultFile();
  var now = opts.now || Date.now;
  var defaultTtlMs = positiveTtl(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  var store = opts.store || createClaimStore({
    fs: opts.fs, file: file, parsePayload: parsePayload,
  });
  var records = [];
  var epoch = 0;
  var loadError = "";

  function reload() {
    var read = store.read();
    if (!read.ok) {
      loadError = read.reason;
      records = [];
      return false;
    }
    loadError = "";
    epoch = read.epoch;
    records = read.payload ? read.payload.leases : [];
    return true;
  }
  reload();

  function resolveTtl(value) {
    return positiveTtl(value) ? value : defaultTtlMs;
  }

  function save() {
    return store.commit({ schema: SCHEMA, version: SCHEMA_VERSION, leases: records }, epoch);
  }

  // Redo the whole decision against fresh state on a lost commit race —
  // retrying only the write would republish a decision made from stale state.
  function mutate(fn) {
    for (var attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      if (!reload()) return { ok: false, reason: loadError };
      var result = fn();
      if (!result || result.reason !== "claim_store_conflict") return result;
    }
    return { ok: false, reason: "claim_store_busy" };
  }

  function guard(input, fn) {
    if (loadError) return { ok: false, reason: loadError };
    var request = normalizeRequest(input);
    if (request.error) return { ok: false, reason: request.error };
    return mutate(function () { return fn(request); });
  }

  // A plain acquire may take over ONLY an expired record. Liveness-based
  // takeover deliberately does not happen here: a dead holder's claim may
  // still have a live session behind it, so it is resolved by resolveOrphan
  // against actual evidence. Letting acquire reclaim on liveness alone would
  // route around that evidence requirement and re-open duplicate launches.
  //
  // LAUNCHING never qualifies at all: an in-flight launch may already have
  // produced a session, so no timer may release it.
  function reclaimable(existing, timestamp) {
    if (existing.state === LAUNCHING) return false;
    return isExpired(existing, timestamp);
  }

  function newRecord(request, timestamp, generation) {
    var record = {
      projectId: request.projectId,
      key: request.key,
      state: CLAIMED,
      generation: generation,
      token: crypto.randomUUID(),
      holder: request.holder,
      acquiredAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + resolveTtl(request.ttlMs),
      renewals: 0,
    };
    if (request.holderPid) record.holderPid = request.holderPid;
    if (request.actor) record.actor = request.actor;
    if (request.policyDigest) record.policyDigest = request.policyDigest;
    return record;
  }

  function acquire(input) {
    return guard(input, function (request) {
      var timestamp = now();
      var index = recordIndex(records, request.projectId, request.key);
      var existing = index === -1 ? null : records[index];
      if (existing && !reclaimable(existing, timestamp)) {
        // Same holder, still CLAIMED: idempotent, and deliberately not an
        // extension. Any other non-terminal state means work is under way.
        if (existing.holder === request.holder && existing.state === CLAIMED) {
          return { ok: true, created: false, lease: clone(existing) };
        }
        return { ok: false, reason: "held", lease: clone(existing) };
      }
      if (index === -1 && records.length >= MAX_LEASES) {
        return { ok: false, reason: "claim_store_full" };
      }
      var record = newRecord(request, timestamp, existing ? existing.generation + 1 : 1);
      if (index === -1) records.push(record);
      else records[index] = record;
      var written = save();
      if (!written.ok) return written;
      return { ok: true, created: true, lease: clone(record) };
    });
  }

  // Only the exact (holder, token) that owns the record may move it. `expect`
  // names the state the caller believes it is in.
  function transition(input, expect, apply) {
    return guard(input, function (request) {
      var index = recordIndex(records, request.projectId, request.key);
      if (index === -1) return { ok: false, reason: "not_held" };
      var existing = records[index];
      if (existing.holder !== request.holder) return { ok: false, reason: "holder_mismatch" };
      if (!request.token || existing.token !== request.token) {
        return { ok: false, reason: "fencing_token_mismatch" };
      }
      if (existing.state !== expect) return { ok: false, reason: "invalid_state" };
      var timestamp = now();
      if (isExpired(existing, timestamp)) return { ok: false, reason: "lease_expired" };
      var previous = clone(existing);
      var updated = apply(Object.assign({}, existing), request, timestamp);
      if (updated && updated.reason) return updated;
      records[index] = updated;
      var written = save();
      if (!written.ok) { records[index] = previous; return written; }
      return { ok: true, lease: clone(updated) };
    });
  }

  // CLAIMED -> LAUNCHING. The launch intent is persisted HERE, before any
  // session side effect, so a crash mid-launch leaves a durable record that
  // recovery can reason about rather than an invisible half-start.
  function beginLaunch(input) {
    return transition(input, CLAIMED, function (record, request, timestamp) {
      record.state = LAUNCHING;
      record.updatedAt = timestamp;
      record.intent = request.intent || null;
      if (request.policyDigest) record.policyDigest = request.policyDigest;
      if (request.actor) record.actor = request.actor;
      // An in-flight launch must not expire out from under itself.
      delete record.expiresAt;
      return record;
    });
  }

  // LAUNCHING -> RUNNING, once canonical session metadata exists. Only now
  // does the claim become renewable.
  function confirmRunning(input) {
    return transition(input, LAUNCHING, function (record, request, timestamp) {
      record.state = RUNNING;
      record.updatedAt = timestamp;
      record.expiresAt = timestamp + resolveTtl(request.ttlMs);
      if (request.session) record.session = request.session;
      return record;
    });
  }

  function renew(input) {
    return transition(input, RUNNING, function (record, request, timestamp) {
      record.updatedAt = timestamp;
      record.expiresAt = timestamp + resolveTtl(request.ttlMs);
      record.renewals = record.renewals + 1;
      return record;
    });
  }

  // Any state -> TERMINAL. When a token is supplied it must match, so a
  // stalled actor cannot release a claim that has since been re-issued.
  function release(input) {
    return guard(input, function (request) {
      var index = recordIndex(records, request.projectId, request.key);
      if (index === -1) return { ok: false, reason: "not_held" };
      var existing = records[index];
      if (existing.holder !== request.holder) return { ok: false, reason: "holder_mismatch" };
      if (request.token && existing.token !== request.token) {
        return { ok: false, reason: "fencing_token_mismatch" };
      }
      records.splice(index, 1);
      var written = save();
      if (!written.ok) { records.splice(index, 0, existing); return written; }
      return { ok: true };
    });
  }

  // Recovery for a record whose holder may be gone.
  //   live foreign holder     -> untouched
  //   dead + session exists   -> adopted as RUNNING under a NEW generation
  //   dead + no session       -> released; the launch provably never landed
  //   dead + unknown          -> left as ambiguous, never duplicated
  function resolveOrphan(input, evidence) {
    var facts = evidence || {};
    return guard(input, function (request) {
      var timestamp = now();
      var index = recordIndex(records, request.projectId, request.key);
      if (index === -1) return { ok: false, reason: "not_held" };
      var existing = records[index];
      // Death must be PROVEN. With no recorded pid, or no liveness oracle, we
      // cannot prove it — and an unproven holder is presumed alive, because
      // guessing wrong here is exactly a duplicate launch.
      var pid = existing.holderPid;
      var provablyDead = typeof facts.isHolderAlive === "function" &&
        Number.isInteger(pid) && pid > 0 && facts.isHolderAlive(pid) === false;
      var ours = existing.holder === request.holder;
      if (!ours && !provablyDead) {
        return { ok: false, reason: "held", lease: clone(existing) };
      }
      if (facts.sessionExists === true) {
        var adopted = Object.assign({}, existing, {
          state: RUNNING,
          generation: existing.generation + 1,
          token: crypto.randomUUID(),
          holder: request.holder,
          updatedAt: timestamp,
          expiresAt: timestamp + resolveTtl(request.ttlMs),
          renewals: existing.renewals + 1,
        });
        if (request.holderPid) adopted.holderPid = request.holderPid;
        records[index] = adopted;
        var written = save();
        if (!written.ok) { records[index] = existing; return written; }
        return { ok: true, adopted: true, lease: clone(adopted) };
      }
      if (facts.sessionExists === false) {
        records.splice(index, 1);
        var freed = save();
        if (!freed.ok) { records.splice(index, 0, existing); return freed; }
        return { ok: true, released: true };
      }
      // Ambiguous: a launch may or may not have produced a session. Refusing
      // to act is the only answer that cannot duplicate work.
      return { ok: false, reason: "ambiguous_intent", lease: clone(existing) };
    });
  }

  function get(projectRef, key) {
    var ref = normalizeRef(projectRef);
    var cleanKey = cleanField(key);
    if (!ref || !cleanKey) return null;
    if (!reload()) return null;
    var index = recordIndex(records, ref.projectId, cleanKey);
    if (index === -1) return null;
    return isExpired(records[index], now()) ? null : clone(records[index]);
  }

  function list() {
    if (!reload()) return [];
    var timestamp = now();
    var result = [];
    for (var i = 0; i < records.length; i++) {
      if (!isExpired(records[i], timestamp)) result.push(clone(records[i]));
    }
    return result;
  }

  function sweep() {
    if (loadError) return { ok: false, reason: loadError };
    return mutate(function () {
      var timestamp = now();
      var kept = [];
      for (var i = 0; i < records.length; i++) {
        if (!isExpired(records[i], timestamp)) kept.push(records[i]);
      }
      var removed = records.length - kept.length;
      if (!removed) return { ok: true, removed: 0 };
      var previous = records;
      records = kept;
      var written = save();
      if (!written.ok) { records = previous; return written; }
      return { ok: true, removed: removed };
    });
  }

  return {
    acquire: acquire,
    beginLaunch: beginLaunch,
    confirmRunning: confirmRunning,
    file: file,
    get: get,
    getLoadError: function () { return loadError || null; },
    list: list,
    release: release,
    renew: renew,
    resolveOrphan: resolveOrphan,
    sweep: sweep,
  };
}

module.exports = {
  CLAIMED: CLAIMED,
  DEFAULT_TTL_MS: DEFAULT_TTL_MS,
  LAUNCHING: LAUNCHING,
  MAX_LEASES: MAX_LEASES,
  RUNNING: RUNNING,
  SCHEMA: SCHEMA,
  SCHEMA_VERSION: SCHEMA_VERSION,
  createClaimLeases: createClaimLeases,
  defaultFile: defaultFile,
};
