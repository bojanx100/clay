// Fresh-state transaction boundary for the Coop topic index. Kept separate
// from topic lifecycle rules so the index remains below the module-size limit.
//
// Fail-closed read rule: only ENOENT means "fresh install". Every other read
// failure, parse failure or schema mismatch poisons the store: read-only
// lenses may serve an empty projection, but no mutation is allowed to commit,
// because committing a fabricated empty index over an existing (merely
// unreadable) file would destroy the whole topic/thread/correction history.

var fs = require("fs");
var ledgerFile = require("./coop-control-ledger-file");
var recoveryLog = require("./recovery-log");

var UNREADABLE_CODE = "persistence_unreadable";

function createTopicIndexStore(options) {
  var opts = options || {};
  var file = opts.file;
  var fsImpl = opts.fs || fs;
  var storeName = opts.storeName || "topic_index";
  var state = null;
  var loadedIdentity = null;
  var transactionIdentity = null;
  var mutationDepth = 0;
  var unreadable = null;

  function sameIdentity(left, right) {
    return !!left && !!right && left.exists === right.exists &&
      left.revision === right.revision && left.digest === right.digest;
  }

  function recordCanary(operation, code, message) {
    var record = typeof opts.recordEvent === "function"
      ? opts.recordEvent : recoveryLog.recordRecoveryEvent;
    try {
      record({ kind: "coop_persistence", store: storeName, op: operation,
        code: code, message: message, file: file });
    } catch (error) {}
  }

  // Marks the store poisoned and returns an empty state for read-only lenses.
  // The canary is the only trace an owner gets, so it fires on every fresh
  // failure; repeated identical failures are collapsed so a hot read path
  // cannot flood the recovery log.
  function poison(operation, code, message) {
    var repeat = !!unreadable && unreadable.code === code;
    unreadable = { code: code, message: message };
    if (!repeat) recordCanary(operation, code, message);
    return opts.initialState();
  }

  function readState() {
    var raw;
    try { raw = fsImpl.readFileSync(file, "utf8"); }
    catch (error) {
      if (error && error.code === "ENOENT") { unreadable = null; return opts.initialState(); }
      return poison("read", error && error.code || "read_failed",
        error && error.message || "Coop topic index read failed.");
    }
    var next;
    try { next = JSON.parse(raw); }
    catch (error) {
      return poison("parse", "invalid_json",
        error && error.message || "Coop topic index is not valid JSON.");
    }
    if (!opts.validState(next)) {
      return poison("validate", "schema_mismatch",
        "Coop topic index failed schema validation; refusing to overwrite it.");
    }
    unreadable = null;
    if (!next.retro || typeof next.retro !== "object") {
      next.retro = { version: 0, completedEventCount: 0 };
    }
    var ids = Object.keys(next.topics);
    for (var i = 0; i < ids.length; i++) {
      var topic = next.topics[ids[i]];
      if (!topic || typeof topic !== "object") { delete next.topics[ids[i]]; continue; }
      if (!Array.isArray(topic.eventRefs)) topic.eventRefs = [];
      if (!Array.isArray(topic.turnRefs)) topic.turnRefs = [];
      if (!Array.isArray(topic.relatedExecutions)) topic.relatedExecutions = [];
      if (!Array.isArray(topic.keywords)) topic.keywords = [];
    }
    return next;
  }

  function load() {
    if (mutationDepth > 0 && state) return state;
    var currentIdentity;
    try { currentIdentity = ledgerFile.readIdentity(fsImpl, file); }
    catch (error) {
      // The file exists but cannot be read (EACCES, EMFILE, EIO). Serve an
      // empty read-only view, stay poisoned, and never claim this is fresh.
      state = poison("read", error && error.code || "read_failed",
        error && error.message || "Coop topic index identity read failed.");
      loadedIdentity = null;
      return state;
    }
    if (state && sameIdentity(loadedIdentity, currentIdentity)) return state;
    state = readState();
    loadedIdentity = currentIdentity;
    return state;
  }

  function unreadableError() {
    var error = new Error("Coop topic index is unreadable; refusing to overwrite it.");
    error.code = UNREADABLE_CODE;
    return error;
  }

  function commit(expected) {
    if (unreadable) {
      recordCanary("commit", unreadable.code, unreadable.message);
      throw unreadableError();
    }
    var result = ledgerFile.commitJson(fsImpl, file, state, expected);
    if (!result.ok) {
      var conflict = new Error("Coop topic index changed before commit.");
      conflict.code = result.code;
      throw conflict;
    }
    transactionIdentity = result.identity;
    loadedIdentity = result.identity;
    return true;
  }

  function save() {
    if (unreadable) throw unreadableError();
    if (mutationDepth > 0) return commit(transactionIdentity);
    return ledgerFile.withLock(file, function () {
      var expected = loadedIdentity || ledgerFile.readIdentity(fsImpl, file);
      return commit(expected);
    }, opts.lockOptions);
  }

  function mutate(fallback, operation) {
    try {
      return ledgerFile.withLock(file, function () {
        var cachedState = state;
        var cachedIdentity = loadedIdentity;
        var freshState = readState();
        // Refuse before the operation runs: a mutation applied to a fabricated
        // empty index would be committed over intact-but-unreadable content.
        if (unreadable) {
          state = freshState;
          loadedIdentity = null;
          recordCanary("mutate_refused", unreadable.code,
            "Refusing to mutate an unreadable Coop topic index.");
          return { ok: false, code: UNREADABLE_CODE, reason: unreadable.code };
        }
        transactionIdentity = ledgerFile.readIdentity(fsImpl, file);
        state = cachedState && sameIdentity(cachedIdentity, transactionIdentity)
          ? cachedState : freshState;
        loadedIdentity = transactionIdentity;
        mutationDepth++;
        try { return operation(); }
        finally { mutationDepth--; transactionIdentity = null; }
      }, opts.lockOptions);
    } catch (error) {
      state = null;
      loadedIdentity = null;
      return typeof fallback === "function" ? fallback(error) : fallback;
    }
  }

  return {
    identity: function () { return ledgerFile.readIdentity(fsImpl, file); },
    load: load,
    mutate: mutate,
    save: save,
    unreadable: function () { return unreadable ? { code: unreadable.code } : null; },
  };
}

module.exports = { createTopicIndexStore: createTopicIndexStore,
  UNREADABLE_CODE: UNREADABLE_CODE };
