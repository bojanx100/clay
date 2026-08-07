// automation-claim-store.js - Durable, serializable state for automation
// claims. Persistence only: it knows nothing about what a claim means.
//
// TWO-PHASE COMMIT. A single-file rename can never be safe, because however
// carefully a writer verifies state first, a successor can commit in the
// window before the rename lands and the rename then overwrites it. Even an
// O_EXCL create of a whole payload is not enough on its own: a writer that
// dies midway leaves a file that readers would treat as current.
//
// So publishing epoch N happens in two steps:
//
//   1. RESERVE + WRITE. Create `<file>.<N>.data` with O_EXCL — exactly one
//      writer can win that create, so the epoch number itself is allocated
//      atomically. Write the complete payload and fsync it. Nothing observes
//      this yet.
//   2. PUBLISH. Create `<file>.<N>.committed` with O_EXCL. Only now is epoch N
//      visible.
//
// Readers take the highest epoch that has a COMMITTED marker and ignore every
// incomplete one, so a crash between the two steps is invisible rather than
// corrupting. A stale writer holding epoch N can never supersede a committed
// N+1, because it only ever writes to paths keyed by its own lost epoch.
//
// Any failure after the reserve rolls the reservation back — the private data
// file is removed and the caller is told the commit failed — so a denied
// acquisition never becomes visible to anyone.

var fs = require("fs");
var path = require("path");

var DATA_SUFFIX = ".data";
var COMMITTED_SUFFIX = ".committed";
var EPOCH_RE = /^(\d+)\.(data|committed)$/;
var EPOCH_KEEP = 2;

// Some filesystems legitimately refuse to fsync a directory. Those codes mean
// "not supported here", not "your data may be lost".
var DIR_FSYNC_TOLERATED = { EINVAL: true, EPERM: true, ENOTSUP: true, EISDIR: true, EACCES: true };

function dataPath(file, epoch) {
  return file + "." + epoch + DATA_SUFFIX;
}

function committedPath(file, epoch) {
  return file + "." + epoch + COMMITTED_SUFFIX;
}

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

// Every epoch present on disk, split by whether it was ever published.
function scanEpochs(fsImpl, file) {
  var directory = path.dirname(file);
  var base = path.basename(file) + ".";
  var names;
  try {
    names = fsImpl.readdirSync(directory);
  } catch (e) {
    return { committed: [], reserved: [] };
  }
  var committed = [];
  var reserved = [];
  for (var i = 0; i < names.length; i++) {
    if (names[i].indexOf(base) !== 0) continue;
    var match = names[i].slice(base.length).match(EPOCH_RE);
    if (!match) continue;
    var epoch = Number(match[1]);
    if (!Number.isInteger(epoch) || epoch < 0) continue;
    if (match[2] === "committed") committed.push(epoch);
    else reserved.push(epoch);
  }
  committed.sort(function (a, b) { return b - a; });
  reserved.sort(function (a, b) { return b - a; });
  return { committed: committed, reserved: reserved };
}

// The highest epoch anyone has RESERVED, committed or not. A new reservation
// must start above this, so a half-written epoch is skipped rather than
// re-used (re-using it would let two writers share one epoch number).
function highestReserved(epochs) {
  var top = -1;
  if (epochs.committed.length) top = Math.max(top, epochs.committed[0]);
  if (epochs.reserved.length) top = Math.max(top, epochs.reserved[0]);
  return top;
}

function pruneEpochs(fsImpl, file, current) {
  var epochs = scanEpochs(fsImpl, file);
  var all = epochs.committed.concat(epochs.reserved);
  for (var i = 0; i < all.length; i++) {
    if (all[i] >= current) continue;
    // Keep a short tail so a concurrent reader mid-read is never left with a
    // vanished file.
    if (epochs.committed.indexOf(all[i]) !== -1 &&
        epochs.committed.indexOf(all[i]) < EPOCH_KEEP) continue;
    try { fsImpl.unlinkSync(committedPath(file, all[i])); } catch (e) {}
    try { fsImpl.unlinkSync(dataPath(file, all[i])); } catch (e) {}
  }
}

// createClaimStore({ fs, file }) -> { read, commit, file }
//   read()          -> { ok, epoch, payload } | { ok:false, reason, epoch }
//   commit(payload, fromEpoch) -> { ok, epoch } | { ok:false, reason }
// `fromEpoch` is the epoch the caller's decision was derived from. A commit is
// only attempted at fromEpoch+1 and beyond; if someone else already published
// there, the caller is told to redo its decision against the new state.
function createClaimStore(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file;
  var parsePayload = opts.parsePayload || function (value) { return { ok: true, payload: value }; };

  function read() {
    var epochs = scanEpochs(fsImpl, file);
    // Only committed epochs are visible; an incomplete one is as if it never
    // happened, which is exactly what makes a crash mid-commit harmless.
    for (var i = 0; i < epochs.committed.length; i++) {
      var epoch = epochs.committed[i];
      var raw;
      try {
        raw = fsImpl.readFileSync(dataPath(file, epoch), "utf8");
      } catch (e) {
        // A committed marker whose data is unreadable is genuine corruption,
        // not an in-flight write.
        return { ok: false, reason: "malformed_state", epoch: epoch };
      }
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { ok: false, reason: "malformed_state", epoch: epoch };
      }
      var validated = parsePayload(parsed, epoch);
      if (!validated.ok) return { ok: false, reason: validated.reason || "malformed_state", epoch: epoch };
      return { ok: true, epoch: epoch, payload: validated.payload };
    }
    // Legacy single-file layout from before the epoch protocol.
    if (fsImpl.existsSync(file)) {
      try {
        var legacy = parsePayload(JSON.parse(fsImpl.readFileSync(file, "utf8")), 0);
        if (!legacy.ok) return { ok: false, reason: legacy.reason || "malformed_state", epoch: 0 };
        return { ok: true, epoch: 0, payload: legacy.payload };
      } catch (e) {
        return { ok: false, reason: "malformed_state", epoch: 0 };
      }
    }
    return { ok: true, epoch: 0, payload: null };
  }

  function commit(payload, fromEpoch) {
    var directory = path.dirname(file);
    try {
      fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (e) {
      return { ok: false, reason: "persistence_failed" };
    }
    var epochs = scanEpochs(fsImpl, file);
    // Someone published while we were deciding: our decision is stale.
    if (epochs.committed.length && epochs.committed[0] > fromEpoch) {
      return { ok: false, reason: "claim_store_conflict" };
    }
    var target = Math.max(fromEpoch, highestReserved(epochs)) + 1;

    // Phase 1 — reserve the epoch and write the payload privately.
    var descriptor = null;
    try {
      descriptor = fsImpl.openSync(dataPath(file, target), "wx", 0o600);
    } catch (e) {
      if (e && e.code === "EEXIST") return { ok: false, reason: "claim_store_conflict" };
      return { ok: false, reason: "persistence_failed" };
    }
    try {
      var body = Object.assign({}, payload, { epoch: target });
      fsImpl.writeFileSync(descriptor, JSON.stringify(body, null, 2) + "\n", "utf8");
      fsImpl.fsyncSync(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = null;
    } catch (e) {
      if (descriptor !== null) {
        try { fsImpl.closeSync(descriptor); } catch (closeError) {}
      }
      // Roll the reservation back so a failed write is never observable.
      try { fsImpl.unlinkSync(dataPath(file, target)); } catch (unlinkError) {}
      return { ok: false, reason: "persistence_failed" };
    }
    var syncedData = syncDirectory(fsImpl, directory);
    if (!syncedData.ok) {
      try { fsImpl.unlinkSync(dataPath(file, target)); } catch (unlinkError) {}
      return syncedData;
    }

    // Phase 2 — publish. Until this exists, nothing can see epoch `target`.
    var marker = null;
    try {
      marker = fsImpl.openSync(committedPath(file, target), "wx", 0o600);
      fsImpl.closeSync(marker);
      marker = null;
    } catch (e) {
      if (marker !== null) {
        try { fsImpl.closeSync(marker); } catch (closeError) {}
      }
      try { fsImpl.unlinkSync(dataPath(file, target)); } catch (unlinkError) {}
      if (e && e.code === "EEXIST") return { ok: false, reason: "claim_store_conflict" };
      return { ok: false, reason: "persistence_failed" };
    }
    var syncedMarker = syncDirectory(fsImpl, directory);
    if (!syncedMarker.ok) {
      // The marker may or may not survive a crash. Remove both halves so the
      // outcome is unambiguous: the commit did not happen.
      try { fsImpl.unlinkSync(committedPath(file, target)); } catch (unlinkError) {}
      try { fsImpl.unlinkSync(dataPath(file, target)); } catch (unlinkError) {}
      return syncedMarker;
    }

    pruneEpochs(fsImpl, file, target);
    return { ok: true, epoch: target };
  }

  return { commit: commit, file: file, read: read };
}

module.exports = {
  committedPath: committedPath,
  createClaimStore: createClaimStore,
  dataPath: dataPath,
  scanEpochs: scanEpochs,
};
