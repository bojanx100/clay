// Conflict-safe persistence shared by the canonical Coop JSON ledgers.
//
// Atomic rename prevents partial files, but it does not prevent an old daemon
// instance from renaming a stale whole-file snapshot over a newer mutation.
// Writers therefore take a per-ledger lock, reload inside that lock, and commit
// against the exact revision/digest they loaded.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var DEFAULT_STALE_LOCK_MS = 30000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function digestState(value) {
  var payload = clone(value);
  if (payload && typeof payload === "object") delete payload.ledgerDigest;
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function missingIdentity() {
  return { exists: false, revision: 0, digest: "missing" };
}

function readIdentity(fsImpl, file) {
  var raw;
  try { raw = fsImpl.readFileSync(file, "utf8"); }
  catch (error) {
    if (error && error.code === "ENOENT") return missingIdentity();
    throw error;
  }
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    return {
      exists: true,
      revision: 0,
      digest: "raw:" + crypto.createHash("sha256").update(raw).digest("hex"),
    };
  }
  var revision = Number(parsed && parsed.ledgerRevision);
  return {
    exists: true,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    digest: digestState(parsed),
  };
}

function sameIdentity(left, right) {
  return !!left && !!right && left.exists === right.exists &&
    left.revision === right.revision && left.digest === right.digest;
}

function atomicWriteJson(fsImpl, file, state) {
  var directory = path.dirname(file);
  var temp = file + ".tmp." + process.pid + "." + crypto.randomUUID();
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fsImpl.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    fsImpl.renameSync(temp, file);
    try { fsImpl.chmodSync(file, 0o600); } catch (error) {}
  } catch (error) {
    try {
      if (fs.existsSync(temp) && fs.lstatSync(temp).isFile()) fs.unlinkSync(temp);
    } catch (cleanupError) {}
    throw error;
  }
}

function commitJson(fsImpl, file, state, expected) {
  var current = readIdentity(fsImpl, file);
  if (!sameIdentity(current, expected)) {
    return { ok: false, code: "ledger_conflict", current: current };
  }
  state.ledgerRevision = current.revision + 1;
  state.ledgerDigest = digestState(state);
  atomicWriteJson(fsImpl, file, state);
  return {
    ok: true,
    identity: { exists: true, revision: state.ledgerRevision, digest: digestState(state) },
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!error && error.code === "EPERM"; }
}

function staleLock(lockFs, lockFile, staleMs, now) {
  var stat;
  try { stat = lockFs.lstatSync(lockFile); }
  catch (error) { return false; }
  if (!stat.isFile() || now() - stat.mtimeMs < staleMs) return false;
  var record = null;
  try { record = JSON.parse(lockFs.readFileSync(lockFile, "utf8")); }
  catch (error) {}
  return !record || !processAlive(Number(record.pid));
}

function breakStaleLock(lockFs, lockFile) {
  var aside = lockFile + ".stale." + process.pid + "." + crypto.randomUUID();
  try {
    lockFs.renameSync(lockFile, aside);
    if (lockFs.lstatSync(aside).isFile()) lockFs.unlinkSync(aside);
    return true;
  } catch (error) {
    return false;
  }
}

function acquireLock(file, options) {
  var opts = options || {};
  var lockFs = opts.lockFs || fs;
  var staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_LOCK_MS;
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var lockFile = file + ".lock";
  var token = process.pid + ":" + crypto.randomUUID();
  lockFs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      var descriptor = lockFs.openSync(lockFile, "wx", 0o600);
      lockFs.writeFileSync(descriptor, JSON.stringify({ token: token, pid: process.pid, at: now() }) + "\n");
      return { descriptor: descriptor, file: lockFile, fs: lockFs, token: token };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (staleLock(lockFs, lockFile, staleMs, now)) {
        breakStaleLock(lockFs, lockFile);
        continue;
      }
      // This runs on the daemon's main event loop. Waiting here used
      // Atomics.wait in 10ms slices for up to five seconds, freezing every
      // session while another process held a ledger lock. The caller already
      // has a typed persistence-failure path and can retry; fail fast instead.
      var busy = new Error("Coop ledger lock is busy: " + lockFile);
      busy.code = "COOP_LEDGER_LOCK_BUSY";
      throw busy;
    }
  }
}

function releaseLock(lock) {
  try { lock.fs.closeSync(lock.descriptor); } catch (error) {}
  try {
    var record = JSON.parse(lock.fs.readFileSync(lock.file, "utf8"));
    if (record && record.token === lock.token && lock.fs.lstatSync(lock.file).isFile()) {
      lock.fs.unlinkSync(lock.file);
    }
  } catch (error) {}
}

function withLock(file, operation, options) {
  var lock = acquireLock(file, options);
  try { return operation(); }
  finally { releaseLock(lock); }
}

module.exports = {
  commitJson: commitJson,
  digestState: digestState,
  readIdentity: readIdentity,
  sameIdentity: sameIdentity,
  withLock: withLock,
};
