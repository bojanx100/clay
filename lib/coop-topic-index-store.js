// Fresh-state transaction boundary for the Coop topic index. Kept separate
// from topic lifecycle rules so the index remains below the module-size limit.

var fs = require("fs");
var ledgerFile = require("./coop-control-ledger-file");

function createTopicIndexStore(options) {
  var opts = options || {};
  var file = opts.file;
  var fsImpl = opts.fs || fs;
  var state = null;
  var loadedIdentity = null;
  var transactionIdentity = null;
  var mutationDepth = 0;

  function sameIdentity(left, right) {
    return !!left && !!right && left.exists === right.exists &&
      left.revision === right.revision && left.digest === right.digest;
  }

  function readState() {
    var next;
    try { next = JSON.parse(fsImpl.readFileSync(file, "utf8")); }
    catch (error) { next = opts.initialState(); }
    if (!opts.validState(next)) next = opts.initialState();
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
    var currentIdentity = ledgerFile.readIdentity(fsImpl, file);
    if (state && sameIdentity(loadedIdentity, currentIdentity)) return state;
    state = readState();
    loadedIdentity = currentIdentity;
    return state;
  }

  function commit(expected) {
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
  };
}

module.exports = { createTopicIndexStore: createTopicIndexStore };
