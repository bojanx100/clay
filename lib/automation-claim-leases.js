// Restart-safe, expiring, uniquely-held claim leases for project automation.
//
// Legacy launch-state stores record "launched" claims with no expiry, no
// holder, and a non-atomic read-then-write, so a crashed or concurrent pass
// can double-launch the same work. This module is the replacement primitive:
// a claim is unique per (projectId, key), owned by exactly one holder, and
// expires on an absolute timestamp so it survives a daemon restart.
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");

var SCHEMA = "clay.automation_claim_leases";
var SCHEMA_VERSION = 1;
var MAX_LEASES = 4096;
var MAX_FIELD_LENGTH = 256;
var DEFAULT_TTL_MS = 900000;

function defaultFile() {
  return path.join(config.CONFIG_DIR, "lead", "automation-claims.json");
}

function emptyState() {
  return { schema: SCHEMA, version: SCHEMA_VERSION, epoch: 0, leases: [] };
}

// Monotonic commit counter. A lock alone cannot fence a write: a holder that
// stalls, has its lock broken as stale, and then resumes would still publish
// state derived from a read that is now superseded. So every commit carries
// the epoch it was derived from, and a write is only accepted if the epoch on
// disk is still the one we read. That makes the commit a compare-and-swap, and
// the lock a contention optimisation rather than the correctness mechanism.
function readEpoch(fsImpl, file) {
  try {
    var parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    var value = parsed && Number(parsed.epoch);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch (e) {
    return 0;
  }
}

function clone(value) {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

// Claim keys and holders are opaque identifiers; only length and emptiness
// are enforced so callers stay free to namespace them however they like.
function cleanField(value) {
  if (typeof value !== "string") return "";
  var trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH) return "";
  return trimmed;
}

// Callers MUST hand over an explicit typed ProjectRef object ({ projectId }).
// A bare project-id string is deliberately rejected: the cutover invariant is
// that project work is addressed through an explicit typed ProjectRef, and a
// permissive string form is exactly how an untyped identifier slips into a
// path that is supposed to prove which project it is acting for.
function normalizeRef(value) {
  return projectIdentity.normalizeProjectRef(value);
}

// Persisted records store the id as a scalar field, so they are re-typed here
// rather than going through the strict caller-facing normalizer above.
function persistedRef(projectId) {
  return projectIdentity.normalizeProjectRef({ projectId: projectId });
}

function positiveTtl(value) {
  return Number.isInteger(value) && value > 0 && Number.isFinite(value);
}

function validTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Returns { error } on rejection so callers can map straight onto a reason.
function normalizeClaim(input) {
  var value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  var ref = normalizeRef(value.projectRef);
  if (!ref) return { error: "invalid_project_ref" };
  var key = cleanField(value.key);
  var holder = cleanField(value.holder);
  if (!key || !holder) return { error: "invalid_claim" };
  return { error: "", projectId: ref.projectId, key: key, holder: holder, ttlMs: value.ttlMs };
}

function persistedLease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var ref = persistedRef(value.projectId);
  var key = cleanField(value.key);
  var holder = cleanField(value.holder);
  if (!ref || !key || !holder) return null;
  if (!validTimestamp(value.acquiredAt) || !validTimestamp(value.expiresAt)) return null;
  if (!Number.isInteger(value.renewals) || value.renewals < 0) return null;
  return {
    projectId: ref.projectId,
    key: key,
    holder: holder,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
    renewals: value.renewals,
  };
}

// Fail closed: a missing file is an empty store, but anything unreadable or
// unrecognizable poisons every mutation instead of being silently discarded.
function loadState(fsImpl, file) {
  if (!fsImpl.existsSync(file)) return { ok: true, state: emptyState() };
  try {
    var parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.schema !== SCHEMA ||
        Number(parsed.version) !== SCHEMA_VERSION || !Array.isArray(parsed.leases) ||
        parsed.leases.length > MAX_LEASES) {
      return { ok: false, reason: "malformed_state", state: emptyState() };
    }
    var epoch = Number(parsed.epoch);
    if (!Number.isInteger(epoch) || epoch < 0) epoch = 0;
    var leases = [];
    var seen = {};
    for (var i = 0; i < parsed.leases.length; i++) {
      var lease = persistedLease(parsed.leases[i]);
      if (!lease) return { ok: false, reason: "malformed_state", state: emptyState() };
      var identity = identityFor(lease.projectId, lease.key);
      if (seen[identity]) return { ok: false, reason: "malformed_state", state: emptyState() };
      seen[identity] = true;
      leases.push(lease);
    }
    return { ok: true, state: { schema: SCHEMA, version: SCHEMA_VERSION, epoch: epoch, leases: leases } };
  } catch (e) {
    return { ok: false, reason: "malformed_state", state: emptyState() };
  }
}

// The rename is only durable once the DIRECTORY entry is flushed. Swallowing a
// failure here means reporting a claim as committed that a power loss can undo
// — and a claim that silently un-commits is a duplicate launch. Reported, so
// the caller can fail closed. (Some filesystems legitimately refuse to fsync a
// directory; EINVAL/EPERM/ENOTSUP are treated as "not supported" rather than
// as a durability failure.)
var DIR_FSYNC_TOLERATED = { EINVAL: true, EPERM: true, ENOTSUP: true, EISDIR: true, EACCES: true };

function syncDirectory(fsImpl, directory) {
  var descriptor = null;
  try {
    descriptor = fsImpl.openSync(directory, "r");
    fsImpl.fsyncSync(descriptor);
    return { ok: true };
  } catch (e) {
    if (e && DIR_FSYNC_TOLERATED[e.code]) return { ok: true, unsupported: true };
    return { ok: false, reason: "durability_failed" };
  } finally {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor); } catch (closeError) {}
    }
  }
}

function writeState(fsImpl, file, state) {
  var directory = path.dirname(file);
  var temp = file + ".tmp." + process.pid + "." + crypto.randomUUID();
  var descriptor = null;
  try {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    descriptor = fsImpl.openSync(temp, "w", 0o600);
    fsImpl.writeFileSync(descriptor, JSON.stringify(state, null, 2) + "\n", "utf8");
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = null;
    fsImpl.renameSync(temp, file);
    var synced = syncDirectory(fsImpl, directory);
    if (!synced.ok) return synced;
    return { ok: true };
  } catch (e) {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor); } catch (closeError) {}
    }
    try { fsImpl.unlinkSync(temp); } catch (unlinkError) {}
    return { ok: false, reason: "persistence_failed" };
  }
}

// The (projectId, key) pair, JSON-encoded rather than delimiter-joined. Any
// delimiter can be forged across the boundary — ("a|b","c") and ("a","b|c")
// would collapse to one identity and silently drop a real claim.
function identityFor(projectId, key) {
  return JSON.stringify([String(projectId), String(key)]);
}

// --- Cross-process mutual exclusion ------------------------------------------
//
// This file is shared by every project in the workspace, and a dev and a prod
// daemon can share CLAY_HOME. A cached in-memory snapshot plus a whole-file
// write is therefore NOT a lock: the last writer would silently erase every
// claim another holder had taken. Two things fix that, and both are required.
//
//   1. Re-read the file inside every mutation (see `mutate`). Every operation
//      here is synchronous, so within one process a read-modify-write cannot
//      be interleaved — re-reading alone makes multi-project use correct.
//   2. An O_EXCL lockfile, which extends the same guarantee across processes.
//
// Contention is bounded and rare (per-project ticks minutes apart), so the
// retry budget is deliberately tiny and failure is CLOSED: a caller that
// cannot take the lock is told the store is busy and must not act, rather
// than the daemon's event loop being blocked waiting for it.
var LOCK_SUFFIX = ".lock";
var LOCK_STALE_MS = 30000;
var LOCK_ATTEMPTS = 12;
var LOCK_BACKOFF_MS = 4;

function spinFor(ms) {
  var until = Date.now() + ms;
  while (Date.now() < until) { /* bounded, single-digit milliseconds */ }
}

// Breaking a stale lock is unavoidable (a crashed holder must not wedge
// automation forever) but it is also the dangerous part: the "stalled" holder
// may wake up and finish its write against state a successor has since
// changed. So the lock carries a TOKEN. The breaker writes its own token, and
// every holder re-checks that the token on disk is still its own immediately
// before writing and before unlinking. A holder that lost the lock aborts
// instead of overwriting, and never deletes a successor's lock.
function readLockToken(fsImpl, lockFile) {
  try {
    return String(fsImpl.readFileSync(lockFile, "utf8")).trim();
  } catch (e) {
    return "";
  }
}

function ownsLock(fsImpl, lockFile, token) {
  return !!token && readLockToken(fsImpl, lockFile) === token;
}

function takeLock(fsImpl, lockFile, token) {
  for (var attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    var descriptor = null;
    try {
      fsImpl.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
      descriptor = fsImpl.openSync(lockFile, "wx", 0o600);
      fsImpl.writeFileSync(descriptor, token, "utf8");
      fsImpl.closeSync(descriptor);
      // Confirm we still own what we just created: if two processes broke the
      // same stale lock, only one token survives.
      return ownsLock(fsImpl, lockFile, token);
    } catch (e) {
      if (descriptor !== null) {
        try { fsImpl.closeSync(descriptor); } catch (closeError) {}
      }
      if (!e || e.code !== "EEXIST") return false;
      // Break a lock abandoned by a crashed holder, so one crash cannot wedge
      // automation permanently. Only the exact stale token is removed, so a
      // lock that was refreshed in the meantime is never destroyed.
      try {
        var stat = fsImpl.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          var staleToken = readLockToken(fsImpl, lockFile);
          if (staleToken && ownsLock(fsImpl, lockFile, staleToken)) {
            fsImpl.unlinkSync(lockFile);
          }
          continue;
        }
      } catch (staleError) {
        continue;
      }
      spinFor(LOCK_BACKOFF_MS);
    }
  }
  return false;
}

// Only ever remove OUR lock. If the token no longer matches, a breaker has
// taken over and deleting the file would strip the successor's protection.
function dropLock(fsImpl, lockFile, token) {
  try {
    if (ownsLock(fsImpl, lockFile, token)) fsImpl.unlinkSync(lockFile);
  } catch (e) {}
}

// Uniqueness is per (projectId, key): two projects may legitimately run the
// same automation key at the same time.
function leaseIndex(leases, projectId, key) {
  for (var i = 0; i < leases.length; i++) {
    if (leases[i].projectId === projectId && leases[i].key === key) return i;
  }
  return -1;
}

function isExpired(lease, timestamp) {
  return lease.expiresAt <= timestamp;
}

function createClaimLeases(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || defaultFile();
  var now = opts.now || Date.now;
  var defaultTtlMs = positiveTtl(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  var lockFile = file + LOCK_SUFFIX;
  var loaded = loadState(fsImpl, file);
  var state = loaded.state;
  var loadError = loaded.ok ? "" : loaded.reason;

  function resolveTtl(value) {
    return positiveTtl(value) ? value : defaultTtlMs;
  }

  // Refresh the in-memory snapshot from disk. Every read and every mutation
  // does this: a snapshot cached at construction goes stale the moment any
  // other project or daemon writes, and acting on a stale snapshot is how a
  // claim gets granted twice or erased.
  // The epoch this in-memory state was derived from. Any commit must still
  // find that epoch on disk, or another writer has published since our read.
  var readEpoch_ = 0;

  function reload() {
    var current = loadState(fsImpl, file);
    state = current.state;
    readEpoch_ = current.ok ? (state.epoch || 0) : 0;
    loadError = current.ok ? "" : current.reason;
    return !loadError;
  }

  // The lock token held by the mutation currently in flight, or "" outside one.
  var heldLockToken = "";

  function save() {
    if (loadError) return { ok: false, reason: loadError };
    // Two fences, checked immediately before the write rather than after.
    //
    // The lock check is the cheap one: if a breaker took the lock while we
    // were deciding, we are almost certainly superseded.
    if (heldLockToken && !ownsLock(fsImpl, lockFile, heldLockToken)) {
      return { ok: false, reason: "claim_store_busy" };
    }
    // The epoch check is the authoritative one, and it is what makes the
    // commit safe even if the lock mechanism failed entirely: if the on-disk
    // epoch has moved since we read, someone else has published and our state
    // no longer includes their work. Publishing it would erase them, so we
    // abort and let the caller retry against fresh state.
    if (readEpoch(fsImpl, file) !== readEpoch_) {
      return { ok: false, reason: "claim_store_conflict" };
    }
    var committed = Object.assign({}, state, { epoch: readEpoch_ + 1 });
    var written = writeState(fsImpl, file, committed);
    if (!written.ok) return written;
    state.epoch = committed.epoch;
    readEpoch_ = committed.epoch;
    return written;
  }

  // Read-modify-write under the lock, against freshly read state.
  function mutate(fn) {
    var token = crypto.randomUUID();
    if (!takeLock(fsImpl, lockFile, token)) return { ok: false, reason: "claim_store_busy" };
    heldLockToken = token;
    try {
      if (!reload()) return { ok: false, reason: loadError };
      return fn();
    } finally {
      heldLockToken = "";
      dropLock(fsImpl, lockFile, token);
    }
  }

  function acquire(input) {
    if (loadError) return { ok: false, reason: loadError };
    var claim = normalizeClaim(input);
    if (claim.error) return { ok: false, reason: claim.error };
    return mutate(function () { return acquireLocked(claim); });
  }

  function acquireLocked(claim) {
    var timestamp = now();
    var index = leaseIndex(state.leases, claim.projectId, claim.key);
    var existing = index === -1 ? null : state.leases[index];
    if (existing && !isExpired(existing, timestamp)) {
      // Different holder: this is the anti-duplicate-launch guarantee.
      if (existing.holder !== claim.holder) {
        return { ok: false, reason: "held", lease: clone(existing) };
      }
      // Same holder: idempotent, and deliberately not an expiry extension.
      return { ok: true, created: false, lease: clone(existing) };
    }
    var record = {
      projectId: claim.projectId,
      key: claim.key,
      holder: claim.holder,
      acquiredAt: timestamp,
      expiresAt: timestamp + resolveTtl(claim.ttlMs),
      renewals: 0,
    };
    if (index === -1) {
      // Enforced on WRITE as well as on load: exceeding the cap here would
      // persist a file that fails closed on the next read, disabling even
      // sweep — the one thing that could prune it back under the cap.
      if (state.leases.length >= MAX_LEASES) return { ok: false, reason: "claim_store_full" };
      state.leases.push(record);
    } else {
      state.leases[index] = record;
    }
    var written = save();
    if (!written.ok) {
      if (index === -1) state.leases.pop();
      else state.leases[index] = existing;
      return written;
    }
    return { ok: true, created: true, lease: clone(record) };
  }

  function renew(input) {
    if (loadError) return { ok: false, reason: loadError };
    var claim = normalizeClaim(input);
    if (claim.error) return { ok: false, reason: claim.error };
    return mutate(function () { return renewLocked(claim); });
  }

  function renewLocked(claim) {
    var timestamp = now();
    var index = leaseIndex(state.leases, claim.projectId, claim.key);
    if (index === -1) return { ok: false, reason: "not_held" };
    var record = state.leases[index];
    if (record.holder !== claim.holder) return { ok: false, reason: "holder_mismatch" };
    if (isExpired(record, timestamp)) return { ok: false, reason: "lease_expired" };
    var previous = clone(record);
    record.expiresAt = timestamp + resolveTtl(claim.ttlMs);
    record.renewals = record.renewals + 1;
    var written = save();
    if (!written.ok) {
      state.leases[index] = previous;
      return written;
    }
    return { ok: true, lease: clone(record) };
  }

  function release(input) {
    if (loadError) return { ok: false, reason: loadError };
    var claim = normalizeClaim(input);
    if (claim.error) return { ok: false, reason: claim.error };
    return mutate(function () { return releaseLocked(claim); });
  }

  function releaseLocked(claim) {
    var index = leaseIndex(state.leases, claim.projectId, claim.key);
    if (index === -1) return { ok: false, reason: "not_held" };
    var record = state.leases[index];
    // An expired lease is still releasable by its own holder.
    if (record.holder !== claim.holder) return { ok: false, reason: "holder_mismatch" };
    state.leases.splice(index, 1);
    var written = save();
    if (!written.ok) {
      state.leases.splice(index, 0, record);
      return written;
    }
    return { ok: true };
  }

  function get(projectRef, key) {
    var ref = normalizeRef(projectRef);
    var cleanKey = cleanField(key);
    if (!ref || !cleanKey) return null;
    reload();
    if (loadError) return null;
    var index = leaseIndex(state.leases, ref.projectId, cleanKey);
    if (index === -1) return null;
    var record = state.leases[index];
    return isExpired(record, now()) ? null : clone(record);
  }

  function list() {
    reload();
    if (loadError) return [];
    var timestamp = now();
    var result = [];
    for (var i = 0; i < state.leases.length; i++) {
      if (!isExpired(state.leases[i], timestamp)) result.push(clone(state.leases[i]));
    }
    return result;
  }

  function sweep() {
    if (loadError) return { ok: false, reason: loadError };
    return mutate(function () { return sweepLocked(); });
  }

  function sweepLocked() {
    var timestamp = now();
    var previous = state.leases;
    var kept = [];
    for (var i = 0; i < previous.length; i++) {
      if (!isExpired(previous[i], timestamp)) kept.push(previous[i]);
    }
    var removed = previous.length - kept.length;
    if (!removed) return { ok: true, removed: 0 };
    state.leases = kept;
    var written = save();
    if (!written.ok) {
      state.leases = previous;
      return written;
    }
    return { ok: true, removed: removed };
  }

  return {
    acquire: acquire,
    file: file,
    get: get,
    getLoadError: function () { return loadError || null; },
    list: list,
    release: release,
    renew: renew,
    sweep: sweep,
  };
}

module.exports = {
  DEFAULT_TTL_MS: DEFAULT_TTL_MS,
  MAX_LEASES: MAX_LEASES,
  SCHEMA: SCHEMA,
  SCHEMA_VERSION: SCHEMA_VERSION,
  createClaimLeases: createClaimLeases,
  defaultFile: defaultFile,
};
